/**
 * "Edit" on an attachment: a copy in a private folder, opened in its default program and
 * watched, so a save there can go back into mail. What the page should do with a saved
 * file (update the attachment, attach it to a reply, save a copy) is the page's. Here is
 * what has to hold whatever the page does.
 *
 * Nothing the user saved goes because a program, a window or the app closed. Each session
 * has a record on disk, so a change is noticed and offered again after a restart. A
 * changed file only goes when the user decides, at sign-out, at a wipe, or after 30 days
 * nobody looked at it. An unchanged one stays a day: at start-up nothing says the program
 * holding it has closed, and deleting it would make that program's next save fail.
 *
 * The bridge can reach this from a same-origin plugin frame (see ipc.ts), and a call here
 * starts a program. So every file type that runs something is refused here, not only in
 * the page (shared/edit-rules.ts), and starting a session takes a real click: `begin` reads
 * the user activation from an isolated world, where no page script can change the answer.
 * It answers with a ticket, because the attachment's bytes may take longer to fetch than
 * an activation lasts.
 *
 * Whether the organisation allows this is per account and only the page knows. The page
 * asks before each step and discards the session when the answer turns to no.
 *
 * The lock: no file opens and nothing is read or listed while locked, but a program that
 * already has a file open can't be closed from here, and a file it's editing can't be
 * deleted without losing the edit. So those stay, as plain files only this user can read,
 * and what was saved meanwhile is offered after the unlock.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, readFileSync, rmSync, watch, type FSWatcher } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, shell, type WebContents } from 'electron';
import { CHANNEL, type EditBeginResult, type EditFile, type EditOpenResult, type EditReadResult, type EditSession } from '../../shared/bridge';
import { EDIT_CHANGED_KEEP_MS, EDIT_UNCHANGED_KEEP_MS, editFileName } from '../../shared/edit-rules';
import { systemExe } from '../system-exe';
import { addWipeStep } from './local-wipe';
import type { OsHub } from './os-hub';

const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_SESSIONS = 50;
const MAX_SOURCE_LENGTH = 8192;
const TICKET_LIFE_MS = 10 * 60_000;
const MAX_TICKETS = 16;
/** Long enough for several writes of one save to count as one. */
const DEBOUNCE_MS = 800;
/** A file that's still growing isn't saved yet. */
const STABLE_MS = 400;
/** For what a watcher missed or couldn't see, and a file that was held when it changed. */
const POLL_MS = 15_000;
const RETRY_HELD_MS = 5 * 60_000;
const EXPIRY_CHECK_MS = 60 * 60_000;
/** A program saving replaces the file: gone for a moment isn't gone. */
const MISSING_LIMIT_MS = 60_000;
/** Only this code runs there. */
const ISOLATED_WORLD = 1009;
const FILE_FOLDER = 'f';
const RECORD_FILE = 'session.json';

interface SessionRecord {
  id: string;
  key: string;
  name: string;
  type: string;
  account: string;
  source: string;
  origin: string;
  createdAt: number;
  /** Opened, saved or taken. What the age limits count from. */
  touchedAt: number;
  /** What the page last took or started from. */
  baseHash: string;
  currentHash: string;
  version: number;
  /** Deleting it failed, as a program holds it. The next start tries again and offers nothing. */
  doomed?: boolean;
}

interface LiveSession {
  record: SessionRecord;
  watcher: FSWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
  checking: boolean;
  checkAgain: boolean;
  seenSize: number;
  seenMtime: number;
  missingSince: number | null;
}

/**
 * Local, not the roaming profile a packaged Windows app's userData is in: a copy of a mail
 * attachment shouldn't travel to a file server at logoff. The same choice as os-files.ts.
 */
function editRoot(): string {
  const local = process.env.LOCALAPPDATA;
  if (process.platform === 'win32' && app.isPackaged && local) return path.join(local, 'Bulwark', 'edit-files');
  return path.join(app.getPath('userData'), 'edit-files');
}

const run = promisify(execFile);

/**
 * Only this user, whatever the folder above allows: a profile can be moved somewhere the
 * machine's other users can read. On Windows that takes an explicit list without what's
 * inherited. If the tools are blocked, as AppLocker can do, it holds only where the OS's
 * own defaults for a home folder apply.
 */
async function makeRootPrivate(root: string): Promise<boolean> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(root, 0o700);
    return true;
  }
  try {
    const { stdout } = await run(systemExe('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 15_000 });
    const sid = /S-1-[\d-]+/.exec(stdout)?.[0];
    if (!sid) throw new Error('No SID');
    await run(systemExe('icacls.exe'), [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, timeout: 15_000 });
    return true;
  } catch (error) {
    console.error('Could not set the edit folder private:', error);
    return root.toLowerCase().startsWith(`${app.getPath('home').toLowerCase()}${path.sep}`);
  }
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function readRecord(folder: string): SessionRecord | null {
  try {
    const record = JSON.parse(readFileSync(path.join(folder, RECORD_FILE), 'utf8')) as Partial<SessionRecord>;
    const valid = record.id === path.basename(folder)
      && typeof record.name === 'string' && editFileName(record.name) === record.name
      && typeof record.baseHash === 'string' && typeof record.currentHash === 'string'
      && typeof record.touchedAt === 'number' && typeof record.account === 'string' && typeof record.origin === 'string';
    return valid ? { key: '', type: '', source: '', createdAt: record.touchedAt!, version: 0, ...record } as SessionRecord : null;
  } catch {
    return null;
  }
}

/** Deletes a session's folder, and failing that at least what says what it was. */
function removeFolderNow(folder: string): boolean {
  try {
    rmSync(folder, { recursive: true, force: true });
    return true;
  } catch {
    try {
      rmSync(path.join(folder, RECORD_FILE), { force: true });
    } catch {
      // The next try.
    }
    return false;
  }
}

/** What's on the disk, for a wipe that comes before anything else in the app has started. */
function removeAllFolders(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names.map((name) => path.join(root, name)).filter((folder) => !removeFolderNow(folder));
}

export interface EditHandle {
  root: string;
  sessions: () => SessionRecord[];
}

let running: { clearEverything: () => void } | null = null;

// At load, not in setup: a policy's wipe at the start of a launch comes before any feature.
addWipeStep(async () => {
  if (running) running.clearEverything();
  else removeAllFolders(editRoot());
});

export function setupEdit(hub: OsHub): EditHandle {
  const { windows, origin } = hub.ctx;
  const root = editRoot();
  const sessions = new Map<string, LiveSession>();
  const tickets = new Map<string, { sender: number; expires: number }>();
  const claims = new Map<string, Set<number>>();
  const heldFolders = new Set<string>();
  const watchedForClaims = new WeakSet<WebContents>();
  let rootReady: Promise<boolean> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setInterval> | null = null;
  let lastExpiryCheck = 0;

  const folderOf = (id: string) => path.join(root, id);
  const fileOf = (record: SessionRecord) => path.join(folderOf(record.id), FILE_FOLDER, record.name);

  const view = ({ record }: LiveSession): EditSession => ({
    id: record.id,
    name: record.name,
    type: record.type,
    account: record.account,
    source: record.source,
    changed: record.currentHash !== record.baseHash,
    version: record.version,
    hash: record.currentHash,
    claimed: (claims.get(record.id)?.size ?? 0) > 0,
  });

  const list = (): EditSession[] => (hub.locked ? [] : [...sessions.values()].filter(({ record }) => record.origin === origin).map(view));
  /** A window going away can leave a page that's already gone in the list for a moment. */
  const send = (sessionsNow: EditSession[]) => {
    try {
      windows.broadcast(CHANNEL.editChanged, sessionsNow);
    } catch {
      // Whoever is left hears at the next change, and asks for the list when it starts.
    }
  };
  const announce = () => {
    if (!hub.locked) send(list());
  };

  /** Temp and rename: a crash mid-write must not lose what the session is. */
  const persist = async ({ record }: LiveSession) => {
    const target = path.join(folderOf(record.id), RECORD_FILE);
    const temp = `${target}.${randomBytes(4).toString('hex')}`;
    await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    await rename(temp, target);
  };

  const stopWatching = (session: LiveSession) => {
    session.watcher?.close();
    session.watcher = null;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
  };

  const retryHeld = () => {
    for (const folder of [...heldFolders]) if (removeFolderNow(folder)) heldFolders.delete(folder);
    if (heldFolders.size === 0 && retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  };

  const removeSession = (session: LiveSession) => {
    stopWatching(session);
    sessions.delete(session.record.id);
    claims.delete(session.record.id);
    const folder = folderOf(session.record.id);
    if (removeFolderNow(folder)) return;
    // A program holds it. What it says has already gone or says doomed, so nothing offers this again.
    heldFolders.add(folder);
    retryTimer ??= setInterval(retryHeld, RETRY_HELD_MS);
    retryTimer.unref?.();
  };

  const expire = () => {
    const now = Date.now();
    lastExpiryCheck = now;
    let removed = false;
    for (const session of [...sessions.values()]) {
      const { record } = session;
      if ((claims.get(record.id)?.size ?? 0) > 0) continue;
      const age = now - record.touchedAt;
      const limit = record.currentHash !== record.baseHash ? EDIT_CHANGED_KEEP_MS : EDIT_UNCHANGED_KEEP_MS;
      if (age > limit) {
        removeSession(session);
        removed = true;
      }
    }
    if (removed) announce();
  };

  const check = async (session: LiveSession): Promise<void> => {
    if (session.checking) {
      session.checkAgain = true;
      return;
    }
    session.checking = true;
    const { record } = session;
    const file = fileOf(record);
    try {
      const first = await stat(file).catch(() => null);
      if (!first) {
        session.missingSince ??= Date.now();
        if (Date.now() - session.missingSince > MISSING_LIMIT_MS && sessions.has(record.id)) {
          // The bytes are gone, so there's nothing to offer or keep.
          removeSession(session);
          announce();
        }
        return;
      }
      session.missingSince = null;
      if (first.size === session.seenSize && first.mtimeMs === session.seenMtime) return;
      await new Promise((resolve) => setTimeout(resolve, STABLE_MS));
      const second = await stat(file).catch(() => null);
      if (!second || second.size !== first.size || second.mtimeMs !== first.mtimeMs) {
        session.checkAgain = true;
        return;
      }
      // A program may hold it against reading while it writes. The seen values stay, so the next look reads again.
      const hash = await hashFile(file);
      session.seenSize = second.size;
      session.seenMtime = second.mtimeMs;
      if (hash === record.currentHash || !sessions.has(record.id)) return;
      record.currentHash = hash;
      record.version += 1;
      record.touchedAt = Date.now();
      await persist(session);
      announce();
    } catch {
      // Held or mid-write: the poll comes back to it.
    } finally {
      session.checking = false;
      if (session.checkAgain && sessions.has(record.id)) {
        session.checkAgain = false;
        schedule(session);
      }
    }
  };

  function schedule(session: LiveSession): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      session.timer = null;
      void check(session);
    }, DEBOUNCE_MS);
    session.timer.unref?.();
  }

  const startPoll = () => {
    pollTimer ??= setInterval(() => {
      for (const session of sessions.values()) void check(session);
      if (Date.now() - lastExpiryCheck > EXPIRY_CHECK_MS) expire();
    }, POLL_MS);
    pollTimer.unref?.();
  };

  /**
   * The folder, not the file: a save usually replaces the file, and a watch on the file
   * would stay on the old one. Only the file's own name counts, so Office's `~$` and `~WRL`
   * files, LibreOffice's `.~lock` and an editor's swap files are never read as a save.
   */
  const startWatching = (session: LiveSession) => {
    const folder = path.dirname(fileOf(session.record));
    const wanted = session.record.name.toLowerCase();
    try {
      session.watcher = watch(folder, { persistent: false }, (_event, changed) => {
        if (!changed || changed.toString().toLowerCase() === wanted) schedule(session);
      });
      // The poll carries on without it.
      session.watcher.on('error', () => {
        session.watcher?.close();
        session.watcher = null;
      });
    } catch (error) {
      console.error('Could not watch an edited file:', error);
    }
    startPoll();
  };

  const newLive = (record: SessionRecord): LiveSession => ({
    record,
    watcher: null,
    timer: null,
    checking: false,
    checkAgain: false,
    seenSize: -1,
    seenMtime: -1,
    missingSince: null,
  });

  /** What the last run left: offered again if changed, gone if nobody can want it. */
  const loadSessions = async () => {
    mkdirSync(root, { recursive: true });
    for (const name of readdirSync(root)) {
      const folder = folderOf(name);
      const record = readRecord(folder);
      if (!record || record.doomed) {
        if (!removeFolderNow(folder)) heldFolders.add(folder);
        continue;
      }
      const session = newLive(record);
      sessions.set(record.id, session);
      startWatching(session);
    }
    if (heldFolders.size > 0) {
      retryTimer ??= setInterval(retryHeld, RETRY_HELD_MS);
      retryTimer.unref?.();
    }
    await Promise.all([...sessions.values()].map(check));
    expire();
    announce();
  };

  const takeTicket = (ticket: unknown, sender: WebContents): boolean => {
    if (typeof ticket !== 'string') return false;
    const found = tickets.get(ticket);
    tickets.delete(ticket);
    return !!found && found.sender === sender.id && found.expires > Date.now();
  };

  const sessionForKey = (key: string): LiveSession | undefined => {
    for (const session of sessions.values()) {
      const { record } = session;
      if (record.origin === origin && (record.key === key || `session:${record.id}` === key)) return session;
    }
    return undefined;
  };

  const openInProgram = async (session: LiveSession): Promise<EditOpenResult> => {
    const problem = await shell.openPath(fileOf(session.record)).catch((error: unknown) => String(error));
    if (problem) {
      console.error('Could not open an edited file:', problem);
      return { ok: false, reason: 'no-app' };
    }
    return { ok: true, id: session.record.id };
  };

  const begin = async (sender: WebContents, key: unknown): Promise<EditBeginResult> => {
    if (hub.locked) return { ok: false, reason: 'locked' };
    const active = await sender.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: 'navigator.userActivation.isActive' }]).catch(() => false);
    if (active !== true) return { ok: false, reason: 'gesture' };
    const now = Date.now();
    for (const [id, ticket] of tickets) if (ticket.expires <= now) tickets.delete(id);
    if (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value as string);
    const ticket = randomBytes(16).toString('hex');
    tickets.set(ticket, { sender: sender.id, expires: now + TICKET_LIFE_MS });
    const open = typeof key === 'string' ? sessionForKey(key)?.record.id : undefined;
    return open ? { ok: true, ticket, open } : { ok: true, ticket };
  };

  const open = async (sender: WebContents, ticket: unknown, raw: unknown): Promise<EditOpenResult> => {
    if (hub.locked) return { ok: false, reason: 'locked' };
    if (!takeTicket(ticket, sender)) return { ok: false, reason: 'ticket' };
    const input = (raw ?? {}) as Partial<EditFile>;
    const name = editFileName(input.name);
    if (!name) return { ok: false, reason: 'type' };
    const { data, account, key, source, type } = input;
    if (!(data instanceof Uint8Array) || typeof account !== 'string' || !account || account.length > 512 || typeof key !== 'string' || !key || key.length > 2048) {
      return { ok: false, reason: 'failed' };
    }
    if (data.byteLength > MAX_FILE_BYTES) return { ok: false, reason: 'too-large' };
    if (typeof source !== 'string' || source.length > MAX_SOURCE_LENGTH) return { ok: false, reason: 'failed' };
    // A second click while the first was on its way: the edits of the first are the file.
    const existing = sessionForKey(key);
    if (existing) return openInProgram(existing);
    if (sessions.size >= MAX_SESSIONS) return { ok: false, reason: 'full' };

    rootReady ??= makeRootPrivate(root);
    if (!(await rootReady)) {
      rootReady = null;
      return { ok: false, reason: 'failed' };
    }
    // Short: Office stops at about 218 characters of path.
    const id = randomBytes(8).toString('hex');
    const hash = createHash('sha256').update(data).digest('hex');
    const now = Date.now();
    const record: SessionRecord = {
      id, key, name, account, source, origin,
      type: typeof type === 'string' ? type.slice(0, 200) : '',
      createdAt: now,
      touchedAt: now,
      baseHash: hash,
      currentHash: hash,
      version: 0,
    };
    const session = newLive(record);
    const file = fileOf(record);
    try {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await persist(session);
      await writeFile(file, data, { mode: 0o600 });
      if (process.platform === 'win32') {
        // As a browser's download is marked, so Windows and Office treat it with the same care.
        await writeFile(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n').catch(() => {
          // Not NTFS: there's nowhere to put the mark.
        });
      }
      const written = await stat(file);
      session.seenSize = written.size;
      session.seenMtime = written.mtimeMs;
    } catch (error) {
      console.error('Could not write an edited file:', error);
      removeFolderNow(folderOf(id));
      return { ok: false, reason: 'failed' };
    }
    // Locked while it was being written: nothing opens now.
    if (hub.locked) {
      removeFolderNow(folderOf(id));
      return { ok: false, reason: 'locked' };
    }
    sessions.set(id, session);
    startWatching(session);
    const result = await openInProgram(session);
    if (!result.ok) removeSession(session);
    announce();
    return result;
  };

  const reopen = async (sender: WebContents, ticket: unknown, id: unknown): Promise<EditOpenResult> => {
    if (hub.locked) return { ok: false, reason: 'locked' };
    if (!takeTicket(ticket, sender)) return { ok: false, reason: 'ticket' };
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session || session.record.origin !== origin) return { ok: false, reason: 'failed' };
    session.record.touchedAt = Date.now();
    await persist(session).catch(() => {});
    return openInProgram(session);
  };

  const read = async (id: unknown): Promise<EditReadResult> => {
    if (hub.locked) return { ok: false, reason: 'locked' };
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session || session.record.origin !== origin) return { ok: false, reason: 'missing' };
    const { record } = session;
    const file = fileOf(record);
    try {
      const before = await stat(file);
      if (before.size > MAX_FILE_BYTES) return { ok: false, reason: 'too-large' };
      const data = await readFile(file);
      const after = await stat(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return { ok: false, reason: 'busy' };
      return { ok: true, name: record.name, type: record.type, data, hash: createHash('sha256').update(data).digest('hex') };
    } catch (error) {
      return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'busy' };
    }
  };

  /** A save a moment ago, still in the watcher's wait. Only a changed file costs any time here. */
  const settle = async (): Promise<EditSession[]> => {
    const busy = () => [...sessions.values()].some((session) => session.checking);
    const quiet = async () => {
      for (let tries = 0; busy() && tries < 60; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    };
    await quiet();
    await Promise.all([...sessions.values()].map(check));
    await quiet();
    return list();
  };

  const taken = async (id: unknown, hash: unknown) => {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return;
    // A save after this read stays a change.
    session.record.baseHash = hash;
    session.record.touchedAt = Date.now();
    await persist(session).catch(() => {});
    announce();
  };

  const clear = (account: unknown) => {
    for (const session of [...sessions.values()]) {
      const { record } = session;
      if (record.origin === origin && (account === null || record.account === account)) removeSession(session);
    }
    announce();
  };

  const clearEverything = () => {
    for (const session of [...sessions.values()]) removeSession(session);
    for (const folder of removeAllFolders(root)) heldFolders.add(folder);
    if (heldFolders.size > 0) {
      retryTimer ??= setInterval(retryHeld, RETRY_HELD_MS);
      retryTimer.unref?.();
    }
    announce();
  };
  running = { clearEverything };

  const setClaim = (sender: WebContents, id: unknown, on: unknown) => {
    if (typeof id !== 'string' || !sessions.has(id)) return;
    const holders = claims.get(id) ?? new Set<number>();
    if (on === true) holders.add(sender.id);
    else holders.delete(sender.id);
    if (holders.size > 0) claims.set(id, holders);
    else claims.delete(id);
    if (!watchedForClaims.has(sender)) {
      watchedForClaims.add(sender);
      // A composer that went without saying so, with its window or by a reload.
      const senderId = sender.id;
      const dropAll = () => {
        for (const [claimed, set] of claims) {
          if (set.delete(senderId) && set.size === 0) claims.delete(claimed);
        }
        // Not from inside the event: its window may be half gone.
        setImmediate(announce);
      };
      sender.once('destroyed', dropAll);
      sender.on('did-navigate', dropAll);
    }
    announce();
  };

  // Nothing while it's locked. What changed meanwhile comes with the unlock.
  hub.on('locked', (locked) => send(locked ? [] : list()));

  const { ctx } = hub;
  ctx.handle(CHANNEL.editBegin, (event, _window, key) => begin(event.sender, key));
  ctx.handle(CHANNEL.editOpen, (event, _window, ticket, file) => open(event.sender, ticket, file));
  ctx.handle(CHANNEL.editReopen, (event, _window, ticket, id) => reopen(event.sender, ticket, id));
  ctx.handle(CHANNEL.editList, () => list());
  ctx.handle(CHANNEL.editSettle, () => settle());
  ctx.handle(CHANNEL.editRead, (_event, _window, id) => read(id));
  ctx.handle(CHANNEL.editTaken, (_event, _window, id, hash) => taken(id, hash));
  ctx.handle(CHANNEL.editDiscard, (_event, _window, id) => {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (session && session.record.origin === origin) removeSession(session);
    announce();
  });
  ctx.handle(CHANNEL.editClear, (_event, _window, account) => {
    if (account === null || typeof account === 'string') clear(account);
  });
  ctx.on(CHANNEL.editSetSource, (_event, _window, id, source) => {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session || typeof source !== 'string' || source.length > MAX_SOURCE_LENGTH || session.record.source === source) return;
    session.record.source = source;
    void persist(session).catch(() => {});
    announce();
  });
  ctx.on(CHANNEL.editClaim, (event, _window, id, on) => setClaim(event.sender, id, on));

  app.on('will-quit', () => {
    // Everything stays for the next start. Only what watches it goes.
    for (const session of sessions.values()) stopWatching(session);
    if (pollTimer) clearInterval(pollTimer);
    if (retryTimer) clearInterval(retryTimer);
  });

  void loadSessions().catch((error: unknown) => console.error('Could not read the edited files:', error));

  return {
    root,
    sessions: () => [...sessions.values()].map(({ record }) => record),
  };
}
