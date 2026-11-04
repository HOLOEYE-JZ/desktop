/**
 * The Files drive on Windows: one Cloud Files sync root per account the user turned it on for,
 * in Explorer's navigation pane like OneDrive. The page's sync engine decides what's in it
 * (`place`, `update`, `markInSync`) and supplies a file's bytes when someone opens it
 * (drive-fetch.ts). This keeps the sync roots, their folders, the pins and the letter.
 *
 * - Turned on (`enable`): needs a real click the first time. After that the wish is kept, and
 *   the page turns it on again after each sign-in without one. Never before a sign-in: at a
 *   start nothing registers or connects until the page asks.
 * - Turned off (`disable`): the sync root goes, with its folder and everything in it, whatever
 *   the reason. Only `signed-out` keeps the wish, so the next sign-in brings it back.
 * - `FilesDriveEnabled` off: every sync root goes, and none comes back while it's off. The
 *   wishes stay, for when it's on again.
 * - A wipe: every sync root of this provider, their folders, the letter and the wishes.
 * - "Always keep on this device" and "Free up space": the shell sets the pin attribute. A
 *   watcher sees it change, and this fetches the file or drops its content.
 *
 * No Electron here: features/files-drive.ts wires it to IPC, the policies and the wipe, and
 * plain Node tests drive it with the real helper.
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, watch, type BigIntStats, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type {
  FilesDriveLetterState,
  FilesDriveState,
  FilesError,
  FilesExpect,
  FilesFetchRequest,
  FilesLocalEntry,
  FilesPlaceholder,
  FilesPlaceholderState,
  FilesResult,
  FilesRoot,
} from '../../shared/bridge';
import { filesErrorCode, type NativeFilesModule, type NativeSyncRoot } from '../native-loader';
import { FetchRelay, type FetchFailure } from './drive-fetch';
import { settleLetter, type LetterSystem } from './drive-letter';
import {
  accountKey,
  displayNameFor,
  entryFor,
  expectMatches,
  filesErrorOf,
  folderNameFor,
  freeLetters,
  inside,
  letterTarget,
  relativeParts,
  resolveUnder,
  syncRootPrefix,
  wantedLetter,
} from './drive-places';
import type { RegisteredRoot } from './registry';

export type DisableReason = 'user' | 'signed-out' | 'wipe' | 'refused';

export interface StoredDriveAccount {
  label: string;
  /** The folder's name under the drive's base folder. */
  folder: string;
  rootId: string;
  createdAt: number;
  /** Signed out: no sync root now, and the next sign-in brings it back. */
  signedOut?: boolean;
}

export interface StoredDrive {
  accounts?: Record<string, StoredDriveAccount>;
  /** The user's letter, kept while a policy overrides it. */
  letter?: string | null;
}

export interface DrivePolicy {
  /** `FilesDriveEnabled` is off (or unreadable, which counts as off). */
  forcedOff: boolean;
  /** `FilesDriveLetter`: null when not set, `none`, or a letter. */
  letter: string | null;
}

export interface DriveDeps {
  native: NativeFilesModule | null;
  /** Windows 10 1809 or later. */
  supported: boolean;
  provider: string;
  /** The folder the accounts' folders go in. */
  base: string;
  /** Tells profiles apart in the sync roots' ids. */
  profile: string;
  icon: string;
  version: string;
  store: { read(): StoredDrive; write(next: StoredDrive): void };
  policy: () => DrivePolicy;
  page: {
    /** True when the page was asked; else why it can't be. */
    fetch(request: FilesFetchRequest): FetchFailure | true;
    fetchCancelled(fetchId: string): void;
    stateChanged(state: FilesDriveState): void;
  };
  registry: { add(entry: RegisteredRoot): void; remove(id: string): void };
  letters: LetterSystem | null;
  now?: () => number;
  warn?: (message: string) => void;
  /** Pin changes come through a watcher on each root. Off in tests that don't want it. */
  watchPins?: boolean;
  /** How long a fetch waits for the page: drive-fetch.ts has the defaults. */
  fetchFirstAnswerMs?: number;
  fetchIdleMs?: number;
}

interface Live {
  account: string;
  root: FilesRoot;
  dir: string;
  syncRootId: string;
  connection: string;
  watcher: FSWatcher | null;
}

const MAX_ACCOUNT = 200;
const MAX_LABEL = 320;
const MAX_PLACE = 20_000;
const NATIVE_BATCH = 1000;
const PIN_SETTLE_MS = 300;
const MAX_PIN_WALK = 50_000;

const ok = <T>(value: T): FilesResult<T> => ({ ok: true, value });
const fail = <T = never>(error: FilesError): FilesResult<T> => ({ ok: false, error });

function lstatOrNull(file: string): BigIntStats | null {
  try {
    return lstatSync(file, { bigint: true });
  } catch {
    return null;
  }
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
}

export class DriveController {
  private readonly live = new Map<string, Live>();
  private readonly relay: FetchRelay;
  private queue: Promise<unknown> = Promise.resolve();
  private letterNow: string | null = null;
  private hydrating: Promise<void> = Promise.resolve();
  private readonly hydrateWanted = new Set<string>();
  private readonly pinTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly warn: (message: string) => void;
  private readonly now: () => number;

  constructor(private readonly deps: DriveDeps) {
    this.warn = deps.warn ?? console.warn;
    this.now = deps.now ?? Date.now;
    this.relay = new FetchRelay({
      native: {
        filesDriveTransfer: (...args) => this.native().filesDriveTransfer(...args),
        filesDriveTransferFailed: (...args) => this.native().filesDriveTransferFailed(...args),
      },
      locate: (connection, absolutePath) => this.locate(connection, absolutePath),
      ask: (request) => deps.page.fetch(request),
      cancelled: (fetchId) => deps.page.fetchCancelled(fetchId),
      warn: this.warn,
      ...(deps.fetchFirstAnswerMs ? { firstAnswerMs: deps.fetchFirstAnswerMs } : {}),
      ...(deps.fetchIdleMs ? { idleMs: deps.fetchIdleMs } : {}),
    });
  }

  get available(): boolean {
    return this.deps.supported && this.deps.native !== null;
  }

  // ─── State ───────────────────────────────────────────────────

  state(): FilesDriveState {
    const stored = this.deps.store.read();
    const policy = this.deps.policy();
    return {
      supported: this.available,
      forcedOff: policy.forcedOff,
      wanted: Object.keys(stored.accounts ?? {}),
      letter: this.letterState(),
    };
  }

  private letterState(): FilesDriveLetterState {
    const policy = this.deps.policy();
    const chosen = this.deps.store.read().letter ?? null;
    let available: string[] = [];
    if (this.deps.letters) {
      try {
        available = freeLetters(this.deps.letters.usedMask(), this.letterNow);
      } catch {
        available = [];
      }
    }
    return { letter: this.letterNow, chosen, locked: policy.letter !== null, available };
  }

  private emit(): void {
    try {
      this.deps.page.stateChanged(this.state());
    } catch (error) {
      this.warn(`Telling the page about the drive failed: ${(error as Error).message}`);
    }
  }

  /** One change at a time: two enables of one account mustn't both register. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private native(): NativeFilesModule {
    if (!this.deps.native) throw new Error('files:unsupported');
    return this.deps.native;
  }

  private writeAccounts(change: (accounts: Record<string, StoredDriveAccount>) => void): void {
    const stored = this.deps.store.read();
    const accounts = { ...(stored.accounts ?? {}) };
    change(accounts);
    this.deps.store.write({ ...stored, accounts });
  }

  // ─── Turning it on and off ───────────────────────────────────

  enable(account: unknown, label: unknown, gesture: () => boolean): Promise<FilesResult<FilesRoot>> {
    return this.serial(async () => {
      if (!this.available) return fail('unsupported');
      if (this.deps.policy().forcedOff) return fail('policy');
      if (!validText(account, MAX_ACCOUNT) || !validText(label, MAX_LABEL)) return fail('failed');
      const stored = this.deps.store.read().accounts?.[account];
      // The first time takes a click. After that the wish stands, and a sign-in brings it back.
      if (!stored && !gesture()) return fail('gesture');
      const running = this.live.get(account);
      if (running) return ok(running.root);
      const result = await this.start(account, label, stored);
      if (result.ok) {
        await this.relabel();
        await this.applyLetter();
      }
      this.emit();
      return result;
    });
  }

  private async start(account: string, label: string, stored: StoredDriveAccount | undefined): Promise<FilesResult<FilesRoot>> {
    const native = this.native();
    const { base } = this.deps;
    const others = Object.entries(this.deps.store.read().accounts ?? {})
      .filter(([other]) => other !== account)
      .map(([, entry]) => entry.folder);
    const folder = stored?.folder ?? folderNameFor(label, others);
    const dir = path.win32.join(base, folder);
    let real: string;
    try {
      mkdirSync(dir, { recursive: true });
      // A link here would put the drive somewhere else, and its deletion with it.
      if (lstatSync(base).isSymbolicLink() || lstatSync(dir).isSymbolicLink()) return fail('outside');
      real = realpathSync.native(dir);
      if (!inside(realpathSync.native(base), real)) return fail('outside');
    } catch (error) {
      this.warn(`The drive's folder couldn't be made: ${(error as Error).message}`);
      return fail('failed');
    }
    const key = accountKey(this.deps.profile, account);
    const count = [...this.live.keys()].filter((other) => other !== account).length + 1;
    let syncRootId: string;
    try {
      syncRootId = await native.filesDriveRegister({
        provider: this.deps.provider,
        account: key,
        path: real,
        displayName: displayNameFor(label, count),
        icon: this.deps.icon,
        version: this.deps.version,
      });
    } catch (error) {
      this.warn(`Registering the drive failed: ${(error as Error).message}`);
      return fail(filesErrorOf(filesErrorCode(error)));
    }
    let connection: string;
    try {
      connection = native.filesDriveConnect(real, (event) => this.relay.onNative(event));
    } catch (error) {
      this.warn(`Connecting the drive failed: ${(error as Error).message}`);
      await native.filesDriveUnregister(syncRootId).catch(() => {});
      return fail(filesErrorOf(filesErrorCode(error)));
    }
    const root: FilesRoot = {
      id: stored?.rootId ?? randomBytes(16).toString('hex'),
      kind: 'drive',
      account,
      path: real,
      remoteId: null,
      remoteLabel: label,
      paused: false,
      createdAt: stored?.createdAt ?? this.now(),
    };
    const live: Live = { account, root, dir: real, syncRootId, connection, watcher: null };
    this.live.set(account, live);
    this.deps.registry.add({
      root,
      dir: real,
      placeholderState: (absolute) => this.placeholderState(absolute),
      contentAbsent: (absolute) => this.contentAbsent(absolute),
    });
    this.writeAccounts((accounts) => {
      accounts[account] = { label, folder, rootId: root.id, createdAt: root.createdAt };
    });
    if (this.deps.watchPins !== false) live.watcher = this.watchPins(live);
    return ok(root);
  }

  disable(account: unknown, reason: unknown): Promise<void> {
    return this.serial(async () => {
      if (typeof account !== 'string' || !['user', 'signed-out', 'wipe', 'refused'].includes(reason as string)) return;
      await this.stop(account, true);
      this.writeAccounts((accounts) => {
        const entry = accounts[account];
        if (!entry) return;
        if (reason === 'signed-out') accounts[account] = { ...entry, signedOut: true };
        else delete accounts[account];
      });
      await this.relabel();
      await this.applyLetter();
      this.emit();
    });
  }

  /** Disconnects, deletes the folder and unregisters. The wish is the caller's. */
  private async stop(account: string, removeFolder: boolean): Promise<void> {
    const live = this.live.get(account);
    const stored = this.deps.store.read().accounts?.[account];
    const key = accountKey(this.deps.profile, account);
    let dir: string | null = null;
    if (live) {
      this.live.delete(account);
      live.watcher?.close();
      this.relay.dropRoot(live.root.id);
      this.deps.registry.remove(live.root.id);
      try {
        this.native().filesDriveDisconnect(live.connection);
      } catch (error) {
        this.warn(`Disconnecting the drive failed: ${(error as Error).message}`);
      }
      dir = live.dir;
    } else if (stored) {
      dir = path.win32.join(this.base(), stored.folder);
    }
    // While still registered: Windows lets a placeholder go then without asking anyone.
    if (removeFolder && dir) this.removeFolder(dir);
    for (const root of await this.ourRoots()) {
      if (root.id.endsWith(`!${key}`)) await this.unregister(root);
    }
    if (removeFolder && dir) this.removeFolder(dir);
  }

  /** The base folder as the disk names it: the roots' paths are resolved, so this must be too. */
  private base(): string {
    try {
      return realpathSync.native(this.deps.base);
    } catch {
      return this.deps.base;
    }
  }

  private removeFolder(dir: string): void {
    const base = this.base();
    if (!inside(base, dir) || path.win32.relative(base.toLowerCase(), dir.toLowerCase()) === '') return;
    const facts = lstatOrNull(dir);
    if (!facts) return;
    try {
      // A link is removed, never what it points to.
      rmSync(dir, { recursive: !facts.isSymbolicLink(), force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      this.warn(`The drive's folder couldn't be removed: ${(error as Error).message}`);
    }
  }

  private async ourRoots(): Promise<NativeSyncRoot[]> {
    if (!this.deps.native) return [];
    try {
      const prefix = syncRootPrefix(this.deps.provider);
      return (await this.deps.native.filesDriveRoots()).filter((root) => root.id.startsWith(prefix));
    } catch (error) {
      this.warn(`Listing the sync roots failed: ${(error as Error).message}`);
      return [];
    }
  }

  private async unregister(root: NativeSyncRoot): Promise<void> {
    try {
      await this.native().filesDriveUnregister(root.id);
    } catch (error) {
      this.warn(`Unregistering a sync root failed: ${(error as Error).message}`);
    }
  }

  /** "Bulwark Files" for one, "Bulwark Files - <address>" for each of several. Registering again renames. */
  private async relabel(): Promise<void> {
    const count = this.live.size;
    for (const live of this.live.values()) {
      try {
        await this.native().filesDriveRegister({
          provider: this.deps.provider,
          account: accountKey(this.deps.profile, live.account),
          path: live.dir,
          displayName: displayNameFor(live.root.remoteLabel, count),
          icon: this.deps.icon,
          version: this.deps.version,
        });
      } catch (error) {
        this.warn(`Renaming the drive failed: ${(error as Error).message}`);
      }
    }
  }

  /**
   * At a start, before any sign-in: sync roots of ours nobody wants any more go (a crash
   * between a sign-out and its cleanup, an account removed elsewhere), and so does all of it
   * when the policy says off. Wanted ones stay registered, unconnected, until the page asks.
   */
  startUp(): Promise<void> {
    return this.serial(async () => {
      if (!this.available) return;
      await this.settleWithPolicy();
      await this.applyLetter();
      this.emit();
    });
  }

  /** `FilesDriveEnabled` or `FilesDriveLetter` changed. */
  policyChanged(): Promise<void> {
    return this.serial(async () => {
      if (!this.available) return;
      await this.settleWithPolicy();
      await this.applyLetter();
      this.emit();
    });
  }

  private async settleWithPolicy(): Promise<void> {
    const forcedOff = this.deps.policy().forcedOff;
    const accounts = this.deps.store.read().accounts ?? {};
    const wanted = new Set(Object.entries(accounts).filter(([, entry]) => !forcedOff && !entry.signedOut).map(([account]) => accountKey(this.deps.profile, account)));
    if (forcedOff) {
      for (const account of [...this.live.keys()]) await this.stop(account, true);
      for (const entry of Object.values(accounts)) this.removeFolder(path.win32.join(this.base(), entry.folder));
    }
    for (const root of await this.ourRoots()) {
      const key = root.id.split('!').at(-1) ?? '';
      if (wanted.has(key)) continue;
      // Ours by id, but only a folder inside the drive's own is ever deleted.
      if (root.path) this.removeFolder(root.path);
      await this.unregister(root);
    }
    // Signed out: its folder went at the sign-out. One left behind by a crash goes now.
    for (const entry of Object.values(accounts)) if (entry.signedOut) this.removeFolder(path.win32.join(this.base(), entry.folder));
  }

  /** The wipe: every sync root of ours, their folders, the letter and every wish. */
  wipe(): Promise<void> {
    return this.serial(async () => {
      for (const account of [...this.live.keys()]) await this.stop(account, true);
      for (const entry of Object.values(this.deps.store.read().accounts ?? {})) this.removeFolder(path.win32.join(this.base(), entry.folder));
      for (const root of await this.ourRoots()) {
        if (root.path) this.removeFolder(root.path);
        await this.unregister(root);
      }
      this.deps.store.write({});
      await this.applyLetter();
      this.emit();
    });
  }

  /** The app quits: connections end, registrations and folders stay for the next start. */
  shutdown(): void {
    for (const live of this.live.values()) {
      live.watcher?.close();
      this.relay.dropRoot(live.root.id);
      try {
        this.native().filesDriveDisconnect(live.connection);
      } catch {
        // Going anyway.
      }
    }
    this.live.clear();
  }

  /** For the folders feature: where no folder pair may go. */
  parentFolders(): string[] {
    return [this.deps.base];
  }

  /** `removeRoot` on a drive root. */
  removeRoot(root: FilesRoot): Promise<void> {
    return this.disable(root.account, 'user');
  }

  // ─── The letter ──────────────────────────────────────────────

  setLetter(letter: unknown, gesture: () => boolean): Promise<FilesResult<FilesDriveLetterState>> {
    return this.serial(async () => {
      if (!this.available || !this.deps.letters) return fail('unsupported');
      if (this.deps.policy().letter !== null) return fail('policy');
      if (letter !== null && (typeof letter !== 'string' || !/^[D-Z]$/.test(letter))) return fail('failed');
      if (letter !== null) {
        if (!gesture()) return fail('gesture');
        if (!this.letterState().available.includes(letter)) return fail('exists');
      }
      const stored = this.deps.store.read();
      this.deps.store.write({ ...stored, letter });
      await this.applyLetter();
      this.emit();
      if (letter !== null && this.letterNow !== letter && this.targets().length > 0) return fail('failed');
      return ok(this.letterState());
    });
  }

  /** The accounts' folders that should be there now. */
  private targets(): string[] {
    if (this.deps.policy().forcedOff) return [];
    const accounts = this.deps.store.read().accounts ?? {};
    return Object.entries(accounts)
      .filter(([, entry]) => !entry.signedOut)
      .map(([account, entry]) => this.live.get(account)?.dir ?? path.win32.join(this.base(), entry.folder))
      .filter((dir) => lstatOrNull(dir)?.isDirectory());
  }

  private async applyLetter(): Promise<void> {
    if (!this.deps.letters) return;
    const targets = this.targets();
    const letter = wantedLetter(this.deps.policy().letter, this.deps.store.read().letter ?? null, targets.length > 0);
    try {
      this.letterNow = await settleLetter(this.deps.letters, this.base(), letter, letterTarget(this.base(), targets), this.warn);
    } catch (error) {
      this.warn(`Setting the drive letter failed: ${(error as Error).message}`);
    }
  }

  // ─── What the page does in it ────────────────────────────────

  private liveByRoot(rootId: unknown): Live | null {
    if (typeof rootId !== 'string') return null;
    for (const live of this.live.values()) if (live.root.id === rootId) return live;
    return null;
  }

  private locate(connection: string, absolutePath: string): { rootId: string; path: string } | null {
    for (const live of this.live.values()) {
      if (live.connection !== connection) continue;
      if (!inside(live.dir, absolutePath)) return null;
      const relative = path.win32.relative(live.dir, absolutePath).split('\\').join('/');
      return relative ? { rootId: live.root.id, path: relative } : null;
    }
    return null;
  }

  async place(rootId: unknown, entries: unknown): Promise<FilesResult<{ path: string; error?: FilesError }[]>> {
    const live = this.liveByRoot(rootId);
    if (!live) return fail('inactive');
    if (!Array.isArray(entries) || entries.length > MAX_PLACE) return fail('failed');
    const answers: { path: string; error?: FilesError }[] = entries.map((entry) => ({ path: typeof (entry as FilesPlaceholder)?.path === 'string' ? (entry as FilesPlaceholder).path : '' }));
    // By parent, in the order the parents first come: parents come before their children.
    const groups = new Map<string, { index: number; name: string; entry: FilesPlaceholder }[]>();
    entries.forEach((raw, index) => {
      const entry = raw as FilesPlaceholder;
      const parts = relativeParts(entry?.path);
      const valid =
        parts &&
        (entry.kind === 'file' || entry.kind === 'directory') &&
        Number.isSafeInteger(entry.size) &&
        entry.size >= 0 &&
        Number.isFinite(entry.mtimeMs) &&
        typeof entry.identity === 'string' &&
        entry.identity.length > 0 &&
        Buffer.byteLength(entry.identity) <= 4096;
      if (!valid) {
        answers[index].error = parts ? 'failed' : 'outside';
        return;
      }
      const parent = parts.slice(0, -1).join('/');
      const group = groups.get(parent) ?? [];
      group.push({ index, name: parts[parts.length - 1], entry });
      groups.set(parent, group);
    });
    for (const [parent, group] of groups) {
      let parentDir = live.dir;
      if (parent) {
        const resolved = resolveUnder(live.dir, parent);
        if (!resolved.ok) {
          for (const item of group) answers[item.index].error = resolved.error;
          continue;
        }
        parentDir = resolved.absolute;
      }
      const facts = lstatOrNull(parentDir);
      if (!facts?.isDirectory()) {
        for (const item of group) answers[item.index].error = 'missing';
        continue;
      }
      for (let at = 0; at < group.length; at += NATIVE_BATCH) {
        const batch = group.slice(at, at + NATIVE_BATCH);
        let codes: string[];
        try {
          codes = this.native().filesDrivePlace(
            parentDir,
            batch.map(({ name, entry }) => ({ name, directory: entry.kind === 'directory', size: entry.kind === 'directory' ? 0 : entry.size, mtimeMs: entry.mtimeMs, identity: entry.identity })),
          );
        } catch (error) {
          const code = filesErrorOf(filesErrorCode(error));
          codes = batch.map(() => code);
        }
        batch.forEach((item, position) => {
          const code = codes[position] ?? 'failed';
          if (code) answers[item.index].error = filesErrorOf(code);
        });
      }
    }
    return ok(answers);
  }

  private resolveFile(live: Live, relative: unknown): { absolute: string; relative: string; stats: BigIntStats } | FilesError {
    const resolved = resolveUnder(live.dir, relative);
    if (!resolved.ok) return resolved.error;
    const stats = lstatOrNull(resolved.absolute);
    if (!stats) return 'missing';
    if (stats.isSymbolicLink()) return 'outside';
    return { absolute: resolved.absolute, relative: resolved.parts.join('/'), stats };
  }

  private entryNow(absolute: string, relative: string): FilesResult<FilesLocalEntry> {
    const stats = lstatOrNull(absolute);
    if (!stats) return fail('missing');
    return ok(entryFor(relative, stats, this.placeholderState(absolute) ?? undefined));
  }

  async update(rootId: unknown, relative: unknown, meta: unknown, expect: unknown): Promise<FilesResult<FilesLocalEntry>> {
    const live = this.liveByRoot(rootId);
    if (!live) return fail('inactive');
    const change = meta as { size: number; mtimeMs: number; identity: string; dehydrate: boolean } | null;
    if (
      !change ||
      !Number.isSafeInteger(change.size) ||
      change.size < 0 ||
      !Number.isFinite(change.mtimeMs) ||
      typeof change.identity !== 'string' ||
      !change.identity ||
      Buffer.byteLength(change.identity) > 4096 ||
      typeof change.dehydrate !== 'boolean'
    ) {
      return fail('failed');
    }
    if (expect !== null && !validExpect(expect)) return fail('failed');
    const found = this.resolveFile(live, relative);
    if (typeof found === 'string') return fail(found);
    if (expect && !expectMatches(found.stats, expect)) return fail('changed');
    let pinned = false;
    try {
      pinned = this.native().filesDriveInfo(found.absolute).pin === 'pinned';
      this.native().filesDriveUpdate(found.absolute, {
        size: change.size,
        mtimeMs: change.mtimeMs,
        identity: change.identity,
        markInSync: true,
        dehydrate: change.dehydrate,
        verifyInSync: true,
      });
    } catch (error) {
      return fail(filesErrorOf(filesErrorCode(error)));
    }
    // A pinned file stays on the device: its new content comes now.
    if (change.dehydrate && pinned) this.queueHydrate(found.absolute);
    return this.entryNow(found.absolute, found.relative);
  }

  async markInSync(rootId: unknown, relative: unknown, identity: unknown, expect: unknown): Promise<FilesResult<FilesLocalEntry>> {
    const live = this.liveByRoot(rootId);
    if (!live) return fail('inactive');
    if (typeof identity !== 'string' || !identity || Buffer.byteLength(identity) > 4096 || !validExpect(expect)) return fail('failed');
    const found = this.resolveFile(live, relative);
    if (typeof found === 'string') return fail(found);
    if (!expectMatches(found.stats, expect)) return fail('changed');
    try {
      this.native().filesDriveConvert(found.absolute, identity);
    } catch (error) {
      return fail(filesErrorOf(filesErrorCode(error)));
    }
    return this.entryNow(found.absolute, found.relative);
  }

  supply(fetchId: unknown, offset: unknown, data: unknown): Promise<boolean> {
    return this.relay.supply(fetchId, offset, data);
  }

  failFetch(fetchId: unknown, error: unknown): void {
    this.relay.fail(fetchId, error);
  }

  activeFetches(): FilesFetchRequest[] {
    return this.relay.active();
  }

  // ─── Placeholder state, for scan and stat ────────────────────

  placeholderState(absolute: string): FilesPlaceholderState | null {
    try {
      const info = this.native().filesDriveInfo(absolute);
      return { identity: info.placeholder ? info.identity ?? null : null, inSync: info.placeholder && info.inSync, hydrated: info.hydrated, pin: info.pin };
    } catch {
      return null;
    }
  }

  /** Reading it would make Windows ask the page for it: main's own reads must not. */
  contentAbsent(absolute: string): boolean {
    try {
      const info = this.native().filesDriveInfo(absolute);
      return info.placeholder && !info.directory && !info.hydrated;
    } catch (error) {
      return filesErrorCode(error) !== 'missing';
    }
  }

  // ─── Pins ────────────────────────────────────────────────────

  private watchPins(live: Live): FSWatcher | null {
    try {
      const watcher = watch(live.dir, { recursive: true }, (_event, name) => {
        if (!name) return;
        const absolute = path.win32.join(live.dir, name.toString());
        const waiting = this.pinTimers.get(absolute);
        if (waiting) clearTimeout(waiting);
        this.pinTimers.set(
          absolute,
          setTimeout(() => {
            this.pinTimers.delete(absolute);
            if (this.live.get(live.account) === live) this.checkPin(absolute, null);
          }, PIN_SETTLE_MS),
        );
      });
      watcher.on('error', (error) => this.warn(`Watching the drive failed: ${error.message}`));
      return watcher;
    } catch (error) {
      this.warn(`Watching the drive failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * "Always keep on this device" pins, "Free up space" unpins: the shell sets the attribute and
   * leaves the rest to the provider. A folder's pin goes to what's in it that has none of its own.
   */
  checkPin(absolute: string, inherited: 'pinned' | 'unpinned' | null, budget = { left: MAX_PIN_WALK }): void {
    if (budget.left-- <= 0) return;
    let info;
    try {
      info = this.native().filesDriveInfo(absolute);
    } catch {
      return;
    }
    const pin = info.pin === 'unspecified' ? inherited : info.pin;
    if (info.directory) {
      if (!pin) return;
      let names: string[] = [];
      try {
        names = readdirSync(absolute);
      } catch {
        return;
      }
      for (const name of names) this.checkPin(path.win32.join(absolute, name), pin, budget);
      return;
    }
    if (!info.placeholder) return;
    if (pin === 'pinned' && !info.hydrated) this.queueHydrate(absolute);
    else if (pin === 'unpinned' && info.onDisk > 0 && info.inSync) {
      try {
        this.native().filesDriveDehydrate(absolute);
      } catch (error) {
        // Open somewhere, or changed here and not uploaded yet: it stays.
        this.warn(`Freeing up a file failed: ${(error as Error).message}`);
      }
    }
  }

  /**
   * One at a time: a hydrate holds a libuv thread until the page has sent every byte, and the
   * transfers need threads of their own.
   */
  private queueHydrate(absolute: string): void {
    if (this.hydrateWanted.has(absolute)) return;
    this.hydrateWanted.add(absolute);
    this.hydrating = this.hydrating.then(async () => {
      this.hydrateWanted.delete(absolute);
      try {
        const info = this.native().filesDriveInfo(absolute);
        if (info.hydrated) return;
        await this.native().filesDriveHydrate(absolute);
      } catch (error) {
        this.warn(`Keeping a file on this device failed: ${(error as Error).message}`);
      }
    });
  }

  /** Waits for the pinned files queued so far. For tests. */
  hydrated(): Promise<void> {
    return this.hydrating;
  }
}

function validExpect(value: unknown): value is FilesExpect {
  const expect = value as FilesExpect;
  return !!expect && typeof expect === 'object' && typeof expect.fileId === 'string' && Number.isFinite(expect.size) && Number.isFinite(expect.mtimeMs);
}
