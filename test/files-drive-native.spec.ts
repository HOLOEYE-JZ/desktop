import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { FilesDriveState, FilesFetchRequest, FilesPlaceholder } from '../src/shared/bridge';
import { DriveController, type StoredDrive } from '../src/main/files/drive-controller';
import { FilesDisk } from '../src/main/files/disk';
import { substLetters } from '../src/main/files/drive-letter';
import { claimLetterLabel, DRIVES_KEY, registryLetterLabels, releaseLetterLabel } from '../src/main/files/drive-letter-label';
import { fileIdOf, mtimeMsOf } from '../src/main/files/drive-places';
import type { RegisteredRoot } from '../src/main/files/registry';
import { helperFile, loadHelperModule, type NativeFetchEvent, type NativeFilesModule } from '../src/main/native-loader';

/**
 * The Files drive against Windows itself, from plain Node: the helper's Cloud Files calls, and
 * the controller main runs, with a fake page that serves bytes. Every sync root here is a test
 * one, `Bulwark Test <pid>`, in a temp folder, and goes in `finally`. scripts/files-drive-cleanup.mjs
 * removes any a crash left.
 */

test.skip(process.platform !== 'win32', 'the Cloud Files API is Windows only');
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = helperFile({ packaged: false, mainDir: path.join(ROOT, 'dist'), platform: process.platform, arch: process.arch });
const PROVIDER = `Bulwark Test ${process.pid}`;
const BASE = path.join(tmpdir(), `bulwark-files-test-${process.pid}`);
const ICON = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\imageres.dll,-3`;
/** Stands in for HKCU: the letter's name and icon go here, never in the user's own classes. */
const REGISTRY_ROOT = `HKCU\\Software\\Bulwark Test ${process.pid}`;
const SYNC_ROOT_MANAGER = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager';

const load = (): NativeFilesModule => {
  const loaded = loadHelperModule(FILE);
  if (!loaded?.filesDriveRegister) throw new Error(`${FILE} is missing or has no files calls: run npm run build:native`);
  return loaded as unknown as NativeFilesModule;
};

const content = (seed: string, length: number): Buffer => {
  const out = Buffer.alloc(length);
  let block = createHash('sha256').update(seed).digest();
  for (let at = 0; at < length; at += block.length) {
    block.copy(out, at);
    block = createHash('sha256').update(block).digest();
  }
  return out;
};
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Reads a file the way any program would: another process, so Windows asks the provider. */
function readElsewhere(file: string): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const code = `try { process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex')) } catch (e) { process.stdout.write('ERR ' + e.code); }`;
  return new Promise((resolve) => {
    execFile(process.execPath, ['-e', code, file], { timeout: 90_000 }, (_error, stdout) => {
      const out = String(stdout);
      resolve(out.startsWith('ERR') ? { ok: false, error: out.slice(4) } : { ok: true, sha: out });
    });
  });
}

function registryKeys(): string[] {
  try {
    return execFileSync('reg', ['query', SYNC_ROOT_MANAGER], { encoding: 'latin1' }).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/** A registry value's data, as `reg query` prints it; null if there's none. */
function registryValue(key: string, name: string | null): string | null {
  try {
    const out = execFileSync('reg', ['query', key, ...(name ? ['/v', name] : ['/ve'])], { encoding: 'latin1' });
    return /REG_(?:EXPAND_)?SZ\s+(.*)/.exec(out)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function registryKeyExists(key: string): boolean {
  try {
    execFileSync('reg', ['query', key], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A drive letter's name and icon in "This PC", under the test's stand-in for HKCU. */
function letterLabel(letter: string): { label: string | null; icon: string | null } {
  const key = `${REGISTRY_ROOT}\\${DRIVES_KEY}\\${letter}`;
  return { label: registryValue(`${key}\\DefaultLabel`, null), icon: registryValue(`${key}\\DefaultIcon`, null) };
}

function removeRegistryRoot(): void {
  if (registryKeyExists(REGISTRY_ROOT)) execFileSync('reg', ['delete', REGISTRY_ROOT, '/f'], { stdio: 'ignore' });
}

/** The icon Explorer's navigation pane draws for a sync root: its namespace entry's. */
function navigationPaneIcon(syncRootId: string): string | null {
  const clsid = registryValue(`${SYNC_ROOT_MANAGER}\\${syncRootId}`, 'NamespaceCLSID');
  return clsid ? registryValue(`HKCU\\Software\\Classes\\CLSID\\${clsid}\\DefaultIcon`, null) : null;
}

const ours = (keys: string[]) => keys.filter((key) => key.includes(`\\${PROVIDER}!`));

async function ourRoots(native: NativeFilesModule): Promise<string[]> {
  return (await native.filesDriveRoots()).filter((root) => root.id.startsWith(`${PROVIDER}!`)).map((root) => root.id);
}

async function removeEverything(native: NativeFilesModule): Promise<void> {
  for (const id of await ourRoots(native)) await native.filesDriveUnregister(id).catch(() => {});
  rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

test.describe('the helper', () => {
  let native: NativeFilesModule;
  let id: string | null = null;
  let connection: string | null = null;
  const root = path.join(BASE, 'helper');
  const events: NativeFetchEvent[] = [];
  const served = new Map<string, Buffer>();
  /** False: fetches wait, for the cancel test. */
  let answer = true;

  test.beforeAll(async () => {
    native = load();
    mkdirSync(root, { recursive: true });
    id = await native.filesDriveRegister({ provider: PROVIDER, account: 'helper', path: root, displayName: PROVIDER, icon: ICON, version: '0.1.0' });
    connection = native.filesDriveConnect(root, (event) => {
      events.push(event);
      if (event.kind !== 'fetch' || !answer) return;
      void (async () => {
        const data = served.get(event.identity);
        if (!data) {
          native.filesDriveTransferFailed(event.connection, event.transferKey, event.requestKey, event.offset, event.length, 'failed');
          return;
        }
        for (let at = 0; at < data.length; at += 1024 * 1024) {
          await native.filesDriveTransfer(event.connection, event.transferKey, event.requestKey, at, data.subarray(at, Math.min(at + 1024 * 1024, data.length)));
        }
      })();
    });
  });

  test.afterAll(async () => {
    if (connection) native.filesDriveDisconnect(connection);
    if (id) await native.filesDriveUnregister(id);
    await removeEverything(native);
    expect(ours(registryKeys())).toEqual([]);
  });

  test('registers with an id of provider, user and account, and Windows lists it with its folder', async () => {
    expect(id).toMatch(new RegExp(`^${PROVIDER}!S-1-5-[0-9-]+!helper$`));
    const listed = (await native.filesDriveRoots()).find((entry) => entry.id === id);
    expect(listed).toEqual({ id, path: root, displayName: PROVIDER, icon: ICON });
    expect(ours(registryKeys())).toHaveLength(1);
  });

  test('places a tree with nested folders, umlauts and spaces, with nothing fetched', () => {
    const now = Date.UTC(2026, 9, 1, 12, 0, 0);
    expect(native.filesDrivePlace(root, [
      { name: 'Ordner mit Ümlaut', directory: true, size: 0, mtimeMs: now, identity: 'dir-1' },
      { name: 'a b.txt', directory: false, size: 10_000, mtimeMs: now, identity: 'file-1' },
    ])).toEqual(['', '']);
    expect(native.filesDrivePlace(path.join(root, 'Ordner mit Ümlaut'), [
      { name: 'Tiefer Ordner', directory: true, size: 0, mtimeMs: now, identity: 'dir-2' },
      { name: 'Größe.bin', directory: false, size: 3_000_000, mtimeMs: now, identity: 'file-2' },
    ])).toEqual(['', '']);
    expect(native.filesDrivePlace(path.join(root, 'Ordner mit Ümlaut', 'Tiefer Ordner'), [{ name: 'ç ñ.txt', directory: false, size: 5, mtimeMs: now, identity: 'file-3' }])).toEqual(['']);
    // Again: there already, and said so per entry.
    expect(native.filesDrivePlace(root, [{ name: 'a b.txt', directory: false, size: 1, mtimeMs: now, identity: 'x' }])).toEqual(['exists']);

    const file = native.filesDriveInfo(path.join(root, 'Ordner mit Ümlaut', 'Größe.bin'));
    expect(file).toMatchObject({ placeholder: true, directory: false, identity: 'file-2', inSync: true, hydrated: false, partial: false, pin: 'unspecified', size: 3_000_000, onDisk: 0 });
    expect(native.filesDriveInfo(path.join(root, 'Ordner mit Ümlaut'))).toMatchObject({ placeholder: true, directory: true, identity: 'dir-1', inSync: true });
    expect(lstatSync(path.join(root, 'a b.txt')).mtimeMs).toBe(now);
  });

  test('a file opened by another program: FETCH_DATA comes, and the content lands', async () => {
    const data = content('file-2', 3_000_000);
    served.set('file-2', data);
    const target = path.join(root, 'Ordner mit Ümlaut', 'Größe.bin');
    const before = events.length;
    expect(await readElsewhere(target)).toEqual({ ok: true, sha: sha(data) });
    const fetch = events.slice(before).find((event) => event.kind === 'fetch');
    expect(fetch).toMatchObject({ identity: 'file-2', path: target, offset: 0, total: 3_000_000 });
    expect(fetch!.pid).not.toBe(process.pid);
    expect(native.filesDriveInfo(target)).toMatchObject({ hydrated: true, partial: false, onDisk: 3_000_000, inSync: true });
  });

  test('a fetch the provider fails: the program gets an error, not a hang', async () => {
    const result = await readElsewhere(path.join(root, 'Ordner mit Ümlaut', 'Tiefer Ordner', 'ç ñ.txt'));
    expect(result.ok).toBe(false);
  });

  // Full hydration: Windows goes on fetching a file whose program went away, and cancels after
  // 60 s without data. The program itself isn't held: it ends at once.
  test('a fetch with no data: the program can go at once, and Windows cancels the fetch', async () => {
    test.setTimeout(150_000);
    native.filesDrivePlace(root, [{ name: 'gross.bin', directory: false, size: 64 * 1024 * 1024, mtimeMs: Date.now(), identity: 'file-big' }]);
    answer = false;
    const before = events.length;
    const child = spawn(process.execPath, ['-e', 'require("fs").readFileSync(process.argv[1])', path.join(root, 'gross.bin')], { stdio: 'ignore' });
    try {
      await expect.poll(() => events.slice(before).find((event) => event.kind === 'fetch')?.identity, { timeout: 30_000 }).toBe('file-big');
      const fetch = events.slice(before).find((event) => event.kind === 'fetch')!;
      const gone = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await expect(gone).resolves.toBeDefined();
      await expect.poll(() => events.slice(before).some((event) => event.kind === 'cancel' && event.transferKey === fetch.transferKey), { timeout: 90_000 }).toBe(true);
    } finally {
      answer = true;
      child.kill();
    }
  });

  test('pins and unpins as the shell sets them, dehydrates, and refuses to free a pinned file', async () => {
    const target = path.join(root, 'Ordner mit Ümlaut', 'Größe.bin');
    // attrib sets the same attributes "Always keep on this device" and "Free up space" do.
    execFileSync('attrib', ['+U', '-P', target]);
    expect(native.filesDriveInfo(target).pin).toBe('unpinned');
    native.filesDriveDehydrate(target);
    expect(native.filesDriveInfo(target)).toMatchObject({ hydrated: false, onDisk: 0, inSync: true, identity: 'file-2' });

    execFileSync('attrib', ['-U', '+P', target]);
    expect(native.filesDriveInfo(target).pin).toBe('pinned');
    await native.filesDriveHydrate(target);
    expect(native.filesDriveInfo(target)).toMatchObject({ hydrated: true, pin: 'pinned' });
    expect(() => native.filesDriveDehydrate(target)).toThrow(/^files:pinned/);
  });

  test('update: new metadata and identity, dropping the old content, even of a pinned file', () => {
    const target = path.join(root, 'Ordner mit Ümlaut', 'Größe.bin');
    const mtime = Date.UTC(2026, 10, 1);
    native.filesDriveUpdate(target, { size: 5000, mtimeMs: mtime, identity: 'file-2b', markInSync: true, dehydrate: true, verifyInSync: true });
    expect(native.filesDriveInfo(target)).toMatchObject({ identity: 'file-2b', size: 5000, onDisk: 0, hydrated: false, inSync: true, pin: 'pinned' });
    expect(lstatSync(target).mtimeMs).toBe(mtime);
  });

  test('a file made here becomes a placeholder in sync; edited after, an update that verifies refuses', () => {
    const fresh = path.join(root, 'neu hier.txt');
    writeFileSync(fresh, 'made here');
    expect(native.filesDriveInfo(fresh)).toMatchObject({ placeholder: false, inSync: false, hydrated: true });
    native.filesDriveConvert(fresh, 'file-new');
    expect(native.filesDriveInfo(fresh)).toMatchObject({ placeholder: true, identity: 'file-new', inSync: true, hydrated: true });
    writeFileSync(fresh, 'edited again');
    expect(native.filesDriveInfo(fresh).inSync).toBe(false);
    expect(() => native.filesDriveUpdate(fresh, { markInSync: true, dehydrate: true, verifyInSync: true })).toThrow(/^files:(changed|not-placeholder)/);
    // Converting again after the upload marks it in sync with the new identity.
    native.filesDriveConvert(fresh, 'file-new-2');
    expect(native.filesDriveInfo(fresh)).toMatchObject({ identity: 'file-new-2', inSync: true });
  });

  test('registering the same id again renames it', async () => {
    await native.filesDriveRegister({ provider: PROVIDER, account: 'helper', path: root, displayName: `${PROVIDER} renamed`, icon: ICON, version: '0.1.1' });
    expect((await native.filesDriveRoots()).find((entry) => entry.id === id)?.displayName).toBe(`${PROVIDER} renamed`);
    expect(ours(registryKeys())).toHaveLength(1);
  });

  test('refuses what main never sends: relative paths, separators in names, unaligned transfers', () => {
    expect(() => native.filesDriveInfo('relative\\path')).toThrow(/files:invalid/);
    expect(() => native.filesDrivePlace(root, [{ name: 'a\\b', directory: false, size: 1, mtimeMs: 0, identity: 'x' }])).toThrow(/files:invalid/);
    expect(() => native.filesDriveTransfer(connection!, '1', '0', 100, Buffer.alloc(1))).toThrow(/files:invalid/);
    expect(() => native.filesDriveRegister({ provider: 'Bad!Provider', account: 'a', path: root, displayName: 'x', icon: ICON, version: '1' })).toThrow(/files:invalid/);
  });
});

// ─── The controller main runs ────────────────────────────────

interface FakePage {
  requests: FilesFetchRequest[];
  cancelled: string[];
  states: FilesDriveState[];
  serve: Map<string, Buffer>;
  /** False: the page never answers. */
  answering: boolean;
}

function controllerWith(native: NativeFilesModule, page: FakePage, store: { value: StoredDrive }, options: { forcedOff?: () => boolean; letter?: () => string | null; letters?: boolean; timeoutMs?: number; watchPins?: boolean; icon?: string; flush?: (accounts: string[]) => Promise<void> } = {}) {
  const registry = new Map<string, RegisteredRoot>();
  const forgotten: string[] = [];
  const rescued: { folder: string; count: number; reason: string }[] = [];
  let drive: DriveController;
  drive = new DriveController({
    native,
    supported: true,
    provider: PROVIDER,
    base: path.join(BASE, 'drive'),
    profile: BASE,
    icon: options.icon ?? ICON,
    version: '0.1.0',
    store: { read: () => store.value, write: (next) => (store.value = next) },
    policy: () => ({ forcedOff: options.forcedOff?.() ?? false, letter: options.letter?.() ?? null }),
    page: {
      fetch: (request) => {
        page.requests.push(request);
        if (page.answering) {
          void (async () => {
            const data = page.serve.get(request.identity);
            if (!data) return drive.failFetch(request.fetchId, 'missing');
            // From 0, in uneven pieces, as a download comes.
            for (let at = 0; at < data.length; at += 300_000) {
              if (!(await drive.supply(request.fetchId, at, data.subarray(at, Math.min(at + 300_000, data.length))))) return;
            }
          })();
        }
        return true;
      },
      fetchCancelled: (fetchId) => page.cancelled.push(fetchId),
      stateChanged: (state) => page.states.push(state),
      flush: options.flush,
    },
    documents: DOCUMENTS,
    rescued: (result, reason) => rescued.push({ folder: result.folder, count: result.count, reason }),
    registry: { add: (entry) => registry.set(entry.root.id, entry), remove: (rootId) => registry.delete(rootId) },
    forgetState: async (rootId) => {
      forgotten.push(rootId);
    },
    letters: options.letters ? substLetters(() => native.filesUsedDriveLetters()) : null,
    letterLabels: options.letters ? registryLetterLabels(REGISTRY_ROOT, (letter) => native.filesDriveLetterChanged(letter)) : null,
    warn: () => {},
    fetchFirstAnswerMs: options.timeoutMs,
    fetchIdleMs: options.timeoutMs,
    watchPins: options.watchPins,
  });
  return { drive, registry, forgotten, rescued };
}

/** Where a test's "Documents" is: files that weren't uploaded go to `Bulwark – not uploaded` in it. */
const DOCUMENTS = path.join(BASE, 'Documents');

/** Every file under a folder, `/` between parts. */
function filesUnder(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

/** A drive with a placed file the page has in sync, one edited here, and one made here; the server unreachable. */
async function driveWithUnsynced(drive: DriveController, page: FakePage, native: NativeFilesModule) {
  const on = await drive.enable('acct-1', 'alice@example.org', yes);
  if (!on.ok) throw new Error(on.error);
  const root = on.value;
  await drive.place(root.id, [
    { path: 'Notes', kind: 'directory', size: 0, mtimeMs: Date.now(), identity: 'd1' },
    { path: 'Notes/notes.txt', kind: 'file', size: 10, mtimeMs: Date.now(), identity: 'n1' },
    { path: 'Notes/synced.txt', kind: 'file', size: 10, mtimeMs: Date.now(), identity: 's1' },
  ]);
  page.serve.set('n1', Buffer.from('first line'));
  page.serve.set('s1', Buffer.from('in sync ok'));
  const notes = path.join(root.path, 'Notes', 'notes.txt');
  expect(await readElsewhere(path.join(root.path, 'Notes', 'synced.txt'))).toMatchObject({ ok: true });
  expect(await readElsewhere(notes)).toMatchObject({ ok: true });
  // Edited here (as Notepad saves) and made here: neither reached Files.
  writeFileSync(notes, 'first line, and an edit');
  writeFileSync(path.join(root.path, 'Notes', 'unsynced new.txt'), 'made while offline');
  writeFileSync(path.join(root.path, 'desktop.ini'), '[.ShellClassInfo]');
  return root;
}

const newPage = (): FakePage => ({ requests: [], cancelled: [], states: [], serve: new Map(), answering: true });
const yes = () => true;
const no = () => false;

test.describe('the drive controller', () => {
  let native: NativeFilesModule;

  test.beforeAll(() => {
    native = load();
  });

  test.afterAll(async () => {
    await removeEverything(native);
    expect(ours(registryKeys())).toEqual([]);
  });

  test('turning it on takes a click the first time; a sign-out keeps the wish and a sign-in brings it back without one', async () => {
    const page = newPage();
    const store = { value: {} as StoredDrive };
    const { drive, registry, forgotten } = controllerWith(native, page, store);
    try {
      expect(await drive.enable('acct-1', 'alice@example.org', no)).toEqual({ ok: false, error: 'gesture' });
      expect(await ourRoots(native)).toEqual([]);

      const on = await drive.enable('acct-1', 'alice@example.org', yes);
      expect(on.ok).toBe(true);
      const root = on.ok ? on.value : null!;
      expect(root).toMatchObject({ kind: 'drive', account: 'acct-1', remoteLabel: 'alice@example.org', path: path.join(BASE, 'drive', 'alice@example.org') });
      expect(registry.get(root.id)?.dir).toBe(root.path);
      expect(await ourRoots(native)).toHaveLength(1);
      expect((await native.filesDriveRoots()).find((entry) => entry.id.startsWith(`${PROVIDER}!`))?.displayName).toBe('Bulwark Files');
      expect(drive.state()).toMatchObject({ supported: true, forcedOff: false, wanted: ['acct-1'] });

      await drive.disable('acct-1', 'signed-out');
      expect(existsSync(root.path)).toBe(false);
      expect(await ourRoots(native)).toEqual([]);
      expect(registry.size).toBe(0);
      // The folder went, so the page's record of it goes too: an empty folder isn't everything deleted.
      expect(forgotten).toEqual([root.id]);
      expect(drive.state().wanted).toEqual(['acct-1']);

      const back = await drive.enable('acct-1', 'alice@example.org', no);
      expect(back.ok && back.value.id).toBe(root.id);
      expect(await ourRoots(native)).toHaveLength(1);

      await drive.disable('acct-1', 'user');
      expect(existsSync(root.path)).toBe(false);
      expect(await ourRoots(native)).toEqual([]);
      expect(drive.state().wanted).toEqual([]);
      expect(await drive.enable('acct-1', 'alice@example.org', no)).toEqual({ ok: false, error: 'gesture' });
    } finally {
      await drive.wipe();
    }
  });

  test('places, serves an open from another program through the page, and answers stat-like state', async () => {
    const page = newPage();
    const store = { value: {} as StoredDrive };
    const { drive, registry } = controllerWith(native, page, store);
    try {
      const on = await drive.enable('acct-1', 'alice@example.org', yes);
      if (!on.ok) throw new Error(on.error);
      const root = on.value;
      const now = Date.UTC(2026, 9, 2);
      const tree: FilesPlaceholder[] = [
        { path: 'Projekte', kind: 'directory', size: 0, mtimeMs: now, identity: 'd1' },
        { path: 'Projekte/Größe und Weite', kind: 'directory', size: 0, mtimeMs: now, identity: 'd2' },
        { path: 'Projekte/Größe und Weite/Bericht 2026.pdf', kind: 'file', size: 2_500_000, mtimeMs: now, identity: 'f1' },
        { path: 'Notiz.txt', kind: 'file', size: 12, mtimeMs: now, identity: 'f2' },
        { path: '../draußen.txt', kind: 'file', size: 1, mtimeMs: now, identity: 'f3' },
      ];
      const placed = await drive.place(root.id, tree);
      expect(placed).toEqual({ ok: true, value: [{ path: 'Projekte' }, { path: 'Projekte/Größe und Weite' }, { path: 'Projekte/Größe und Weite/Bericht 2026.pdf' }, { path: 'Notiz.txt' }, { path: '../draußen.txt', error: 'outside' }] });
      expect(await drive.place('no-such-root', tree)).toEqual({ ok: false, error: 'inactive' });

      const report = path.join(root.path, 'Projekte', 'Größe und Weite', 'Bericht 2026.pdf');
      const registered = registry.get(root.id)!;
      // The folders feature's disk serves the drive's root too: its scan lists the placeholders,
      // which Windows marks as reparse points like a link, without fetching anything.
      const disk = new FilesDisk({ rootOf: (id) => (id === root.id ? registered : null) });
      const scanned = await disk.scan(registered);
      expect(scanned.ok && scanned.value.map((entry) => [entry.path, entry.placeholder?.identity, entry.placeholder?.hydrated])).toEqual([
        ['Notiz.txt', 'f2', false],
        ['Projekte', 'd1', true],
        ['Projekte/Größe und Weite', 'd2', true],
        ['Projekte/Größe und Weite/Bericht 2026.pdf', 'f1', false],
      ]);
      expect(registered.contentAbsent!(report)).toBe(true);
      expect(registered.placeholderState!(report)).toEqual({ identity: 'f1', inSync: true, hydrated: false, pin: 'unspecified' });

      const data = content('f1', 2_500_000);
      page.serve.set('f1', data);
      expect(await readElsewhere(report)).toEqual({ ok: true, sha: sha(data) });
      expect(page.requests.at(-1)).toMatchObject({ rootId: root.id, identity: 'f1', path: 'Projekte/Größe und Weite/Bericht 2026.pdf', total: 2_500_000 });
      expect(registered.contentAbsent!(report)).toBe(false);
      expect(drive.activeFetches()).toEqual([]);
    } finally {
      await drive.wipe();
    }
  });

  test('a fetch the page never answers fails after the timeout, and the page hears it is off', async () => {
    const page = newPage();
    page.answering = false;
    const store = { value: {} as StoredDrive };
    const { drive } = controllerWith(native, page, store, { timeoutMs: 1500 });
    try {
      const on = await drive.enable('acct-1', 'alice@example.org', yes);
      if (!on.ok) throw new Error(on.error);
      await drive.place(on.value.id, [{ path: 'still.txt', kind: 'file', size: 100, mtimeMs: Date.now(), identity: 'never' }]);
      const started = Date.now();
      const result = await readElsewhere(path.join(on.value.path, 'still.txt'));
      expect(result.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(20_000);
      // Windows may ask again once before it gives the program the error: each one is called off.
      expect(page.requests.length).toBeGreaterThan(0);
      expect([...page.cancelled].sort()).toEqual(page.requests.map((request) => request.fetchId).sort());
    } finally {
      await drive.wipe();
    }
  });

  test('"Always keep on this device" fetches the file, "Free up space" drops it, and an update of a pinned file fetches the new one', async () => {
    const page = newPage();
    const store = { value: {} as StoredDrive };
    const { drive } = controllerWith(native, page, store);
    try {
      const on = await drive.enable('acct-1', 'alice@example.org', yes);
      if (!on.ok) throw new Error(on.error);
      const root = on.value;
      await drive.place(root.id, [
        { path: 'Behalten', kind: 'directory', size: 0, mtimeMs: Date.now(), identity: 'd1' },
        { path: 'Behalten/eins.bin', kind: 'file', size: 200_000, mtimeMs: Date.now(), identity: 'p1' },
      ]);
      page.serve.set('p1', content('p1', 200_000));
      const file = path.join(root.path, 'Behalten', 'eins.bin');
      execFileSync('attrib', ['+P', file]);
      await expect.poll(() => native.filesDriveInfo(file).hydrated, { timeout: 20_000 }).toBe(true);
      expect(page.requests.at(-1)).toMatchObject({ identity: 'p1' });

      execFileSync('attrib', ['-P', '+U', file]);
      await expect.poll(() => native.filesDriveInfo(file).onDisk, { timeout: 20_000 }).toBe(0);

      // Pinned again, then changed on the server: the new content comes by itself.
      execFileSync('attrib', ['-U', '+P', file]);
      await expect.poll(() => native.filesDriveInfo(file).hydrated, { timeout: 20_000 }).toBe(true);
      page.serve.set('p1b', content('p1b', 300_000));
      const stats = lstatSync(file, { bigint: true });
      const updated = await drive.update(root.id, 'Behalten/eins.bin', { size: 300_000, mtimeMs: Date.now(), identity: 'p1b', dehydrate: true }, { fileId: fileIdOf(stats), size: Number(stats.size), mtimeMs: mtimeMsOf(stats) });
      expect(updated.ok).toBe(true);
      await drive.hydrated();
      await expect.poll(() => native.filesDriveInfo(file), { timeout: 20_000 }).toMatchObject({ identity: 'p1b', hydrated: true, pin: 'pinned', size: 300_000 });
    } finally {
      await drive.wipe();
    }
  });

  test('the app sets "Always keep on this device" and "Free up space" as Explorer does (files-p3-8)', async () => {
    const page = newPage();
    const store = { value: {} as StoredDrive };
    const { drive } = controllerWith(native, page, store);
    try {
      const on = await drive.enable('acct-1', 'alice@example.org', yes);
      if (!on.ok) throw new Error(on.error);
      await drive.place(on.value.id, [{ path: 'Plan.bin', kind: 'file', size: 60_000, mtimeMs: Date.now(), identity: 'q1' }]);
      page.serve.set('q1', content('q1', 60_000));
      const file = path.join(on.value.path, 'Plan.bin');
      expect(await drive.setPin(on.value.id, 'Plan.bin', 'pinned')).toEqual({ ok: true, value: null });
      await expect.poll(() => native.filesDriveInfo(file), { timeout: 20_000 }).toMatchObject({ pin: 'pinned', hydrated: true });
      expect(await drive.setPin(on.value.id, 'Plan.bin', 'unpinned')).toEqual({ ok: true, value: null });
      await expect.poll(() => native.filesDriveInfo(file), { timeout: 20_000 }).toMatchObject({ pin: 'unpinned', onDisk: 0 });
      expect(await drive.setPin(on.value.id, '../x', 'pinned')).toMatchObject({ ok: false });
      expect(await drive.setPin('nope', 'Plan.bin', 'pinned')).toEqual({ ok: false, error: 'inactive' });
    } finally {
      await drive.wipe();
    }
  });

  test('an update of a pinned file fetches the new content by itself, watcher or not', async () => {
    const page = newPage();
    const store = { value: {} as StoredDrive };
    const { drive } = controllerWith(native, page, store, { watchPins: false });
    try {
      const on = await drive.enable('acct-1', 'alice@example.org', yes);
      if (!on.ok) throw new Error(on.error);
      await drive.place(on.value.id, [{ path: 'gepinnt.bin', kind: 'file', size: 100_000, mtimeMs: Date.now(), identity: 'q1' }]);
      const file = path.join(on.value.path, 'gepinnt.bin');
      page.serve.set('q1', content('q1', 100_000));
      page.serve.set('q2', content('q2', 150_000));
      execFileSync('attrib', ['+P', file]);
      await native.filesDriveHydrate(file);
      const updated = await drive.update(on.value.id, 'gepinnt.bin', { size: 150_000, mtimeMs: Date.now(), identity: 'q2', dehydrate: true }, null);
      expect(updated.ok).toBe(true);
      await drive.hydrated();
      expect(native.filesDriveInfo(file)).toMatchObject({ identity: 'q2', hydrated: true, pin: 'pinned', size: 150_000 });
      expect(await readElsewhere(file)).toEqual({ ok: true, sha: sha(content('q2', 150_000)) });
    } finally {
      await drive.wipe();
    }
  });

  test('update and markInSync refuse what changed here since the page looked', async () => {
    const page = newPage();
    const store = { value: {} as StoredDrive };
    const { drive } = controllerWith(native, page, store);
    try {
      const on = await drive.enable('acct-1', 'alice@example.org', yes);
      if (!on.ok) throw new Error(on.error);
      const root = on.value;
      const fresh = path.join(root.path, 'neu.txt');
      writeFileSync(fresh, 'made in Explorer');
      const stats = lstatSync(fresh, { bigint: true });
      const expectNow = { fileId: fileIdOf(stats), size: Number(stats.size), mtimeMs: mtimeMsOf(stats) };
      expect(await drive.markInSync(root.id, 'neu.txt', 'n1', { ...expectNow, size: 1 })).toEqual({ ok: false, error: 'changed' });
      const marked = await drive.markInSync(root.id, 'neu.txt', 'n1', expectNow);
      expect(marked).toMatchObject({ ok: true, value: { path: 'neu.txt', kind: 'file', placeholder: { identity: 'n1', inSync: true, hydrated: true } } });

      writeFileSync(fresh, 'edited before the server change arrived');
      expect(await drive.update(root.id, 'neu.txt', { size: 5, mtimeMs: Date.now(), identity: 'n2', dehydrate: true }, null)).toEqual({ ok: false, error: 'changed' });
      expect(await drive.markInSync(root.id, '../x', 'n1', expectNow)).toEqual({ ok: false, error: 'outside' });
    } finally {
      await drive.wipe();
    }
  });

  test("turning it off keeps what wasn't uploaded in Documents, and deletes only the rest", async () => {
    rmSync(DOCUMENTS, { recursive: true, force: true });
    const page = newPage();
    const store = { value: {} as StoredDrive };
    const { drive, rescued } = controllerWith(native, page, store);
    try {
      const root = await driveWithUnsynced(drive, page, native);
      const result = await drive.disable('acct-1', 'user');
      expect(existsSync(root.path)).toBe(false);
      expect(result.rescued).toMatchObject({ count: 2, failed: 0 });
      const folder = result.rescued!.folder;
      expect(path.dirname(folder)).toBe(path.join(DOCUMENTS, 'Bulwark – not uploaded'));
      expect(path.basename(folder)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(filesUnder(folder).sort()).toEqual(['Notes/notes.txt', 'Notes/unsynced new.txt']);
      expect(readFileSync(path.join(folder, 'Notes', 'notes.txt'), 'utf8')).toBe('first line, and an edit');
      // Copies are plain files, not placeholders that would need this provider.
      expect(native.filesDriveInfo(path.join(folder, 'Notes', 'notes.txt')).placeholder).toBe(false);
      expect(rescued).toEqual([{ folder, count: 2, reason: 'user' }]);
    } finally {
      await drive.wipe();
      rmSync(DOCUMENTS, { recursive: true, force: true });
    }
  });

  test('a sign-out nobody chose keeps the folder, its edits and its pins, and the next sign-in connects it again', async () => {
    rmSync(DOCUMENTS, { recursive: true, force: true });
    const page = newPage();
    const store = { value: {} as StoredDrive };
    const { drive, registry, forgotten, rescued } = controllerWith(native, page, store);
    try {
      const root = await driveWithUnsynced(drive, page, native);
      const synced = path.join(root.path, 'Notes', 'synced.txt');
      execFileSync('attrib', ['+P', synced]);
      expect((await drive.disable('acct-1', 'suspended')).rescued).toBeNull();
      expect(readFileSync(path.join(root.path, 'Notes', 'notes.txt'), 'utf8')).toBe('first line, and an edit');
      expect(existsSync(path.join(root.path, 'Notes', 'unsynced new.txt'))).toBe(true);
      expect(native.filesDriveInfo(synced).pin).toBe('pinned');
      // Still in Explorer, not connected: nothing is deleted or forgotten.
      expect(await ourRoots(native)).toHaveLength(1);
      expect(registry.size).toBe(0);
      expect(forgotten).toEqual([]);
      expect(rescued).toEqual([]);
      expect(drive.state().wanted).toEqual(['acct-1']);
      // A start meanwhile leaves it alone.
      await drive.startUp();
      expect(await ourRoots(native)).toHaveLength(1);
      expect(existsSync(path.join(root.path, 'Notes', 'unsynced new.txt'))).toBe(true);

      const back = await drive.enable('acct-1', 'alice@example.org', no);
      expect(back.ok && back.value.id).toBe(root.id);
      expect(registry.size).toBe(1);
      expect(store.value.accounts?.['acct-1']?.suspended).toBeUndefined();
    } finally {
      await drive.wipe();
      rmSync(DOCUMENTS, { recursive: true, force: true });
    }
  });

  test('a sign-out keeps the pins: placed again after the next sign-in, they are pinned and fetched', async () => {
    rmSync(DOCUMENTS, { recursive: true, force: true });
    const page = newPage();
    const store = { value: {} as StoredDrive };
    const { drive } = controllerWith(native, page, store);
    try {
      const on = await drive.enable('acct-1', 'alice@example.org', yes);
      if (!on.ok) throw new Error(on.error);
      const tree: FilesPlaceholder[] = [
        { path: 'Keep', kind: 'directory', size: 0, mtimeMs: Date.now(), identity: 'd1' },
        { path: 'Keep/a.bin', kind: 'file', size: 50_000, mtimeMs: Date.now(), identity: 'k1' },
        { path: 'Loose.bin', kind: 'file', size: 40_000, mtimeMs: Date.now(), identity: 'k2' },
        { path: 'Online.bin', kind: 'file', size: 30_000, mtimeMs: Date.now(), identity: 'k3' },
      ];
      page.serve.set('k1', content('k1', 50_000));
      page.serve.set('k2', content('k2', 40_000));
      page.serve.set('k3', content('k3', 30_000));
      await drive.place(on.value.id, tree);
      execFileSync('attrib', ['+P', path.join(on.value.path, 'Keep')]);
      execFileSync('attrib', ['+P', path.join(on.value.path, 'Loose.bin')]);
      await expect.poll(() => native.filesDriveInfo(path.join(on.value.path, 'Loose.bin')).hydrated, { timeout: 20_000 }).toBe(true);

      await drive.disable('acct-1', 'signed-out');
      expect(existsSync(on.value.path)).toBe(false);
      expect(store.value.accounts?.['acct-1']?.pins?.sort()).toEqual(['Keep', 'Loose.bin']);

      const back = await drive.enable('acct-1', 'alice@example.org', no);
      if (!back.ok) throw new Error(back.error);
      // The page places the tree anew, a folder's file in a later batch.
      await drive.place(back.value.id, tree.filter((entry) => entry.path !== 'Keep/a.bin'));
      await drive.place(back.value.id, tree.filter((entry) => entry.path === 'Keep/a.bin'));
      const info = (relative: string) => native.filesDriveInfo(path.join(back.value.path, ...relative.split('/')));
      await expect.poll(() => info('Loose.bin').hydrated, { timeout: 20_000 }).toBe(true);
      await expect.poll(() => info('Keep/a.bin').hydrated, { timeout: 20_000 }).toBe(true);
      expect(info('Keep').pin).toBe('pinned');
      expect(info('Online.bin')).toMatchObject({ hydrated: false, pin: 'unspecified' });
      // All put back: nothing left to remember.
      expect(store.value.accounts?.['acct-1']?.pins).toBeUndefined();
    } finally {
      await drive.wipe();
      rmSync(DOCUMENTS, { recursive: true, force: true });
    }
  });

  test('the policy turning it off lets the page upload first, then keeps what still waits; a wipe keeps nothing', async () => {
    rmSync(DOCUMENTS, { recursive: true, force: true });
    const page = newPage();
    const store = { value: {} as StoredDrive };
    let forcedOff = false;
    const flushed: string[][] = [];
    const { drive, rescued } = controllerWith(native, page, store, {
      forcedOff: () => forcedOff,
      flush: async (accounts) => {
        flushed.push(accounts);
      },
    });
    try {
      const root = await driveWithUnsynced(drive, page, native);
      forcedOff = true;
      await drive.policyChanged();
      expect(flushed).toEqual([['acct-1']]);
      expect(existsSync(root.path)).toBe(false);
      expect(rescued).toHaveLength(1);
      expect(rescued[0]).toMatchObject({ count: 2, reason: 'policy' });
      expect(filesUnder(rescued[0].folder).sort()).toEqual(['Notes/notes.txt', 'Notes/unsynced new.txt']);

      forcedOff = false;
      rmSync(DOCUMENTS, { recursive: true, force: true });
      rescued.length = 0;
      const again = await driveWithUnsynced(drive, page, native);
      await drive.disable('acct-1', 'wipe');
      expect(existsSync(again.path)).toBe(false);
      expect(rescued).toEqual([]);
      expect(existsSync(DOCUMENTS)).toBe(false);
    } finally {
      await drive.wipe();
      rmSync(DOCUMENTS, { recursive: true, force: true });
    }
  });

  test('two accounts are named by address; the policy turning it off removes both and keeps the wishes', async () => {
    const page = newPage();
    const store = { value: {} as StoredDrive };
    let forcedOff = false;
    const { drive } = controllerWith(native, page, store, { forcedOff: () => forcedOff });
    try {
      expect((await drive.enable('acct-1', 'alice@example.org', yes)).ok).toBe(true);
      expect((await drive.enable('acct-2', 'bob@example.org', yes)).ok).toBe(true);
      const names = (await native.filesDriveRoots()).filter((entry) => entry.id.startsWith(`${PROVIDER}!`)).map((entry) => entry.displayName).sort();
      expect(names).toEqual(['Bulwark Files - alice@example.org', 'Bulwark Files - bob@example.org']);

      forcedOff = true;
      await drive.policyChanged();
      expect(await ourRoots(native)).toEqual([]);
      expect(existsSync(path.join(BASE, 'drive', 'alice@example.org'))).toBe(false);
      expect(existsSync(path.join(BASE, 'drive', 'bob@example.org'))).toBe(false);
      expect(drive.state()).toMatchObject({ forcedOff: true, wanted: ['acct-1', 'acct-2'] });
      expect(await drive.enable('acct-1', 'alice@example.org', yes)).toEqual({ ok: false, error: 'policy' });

      forcedOff = false;
      expect((await drive.enable('acct-1', 'alice@example.org', no)).ok).toBe(true);
      expect((await native.filesDriveRoots()).filter((entry) => entry.id.startsWith(`${PROVIDER}!`)).map((entry) => entry.displayName)).toEqual(['Bulwark Files']);
    } finally {
      await drive.wipe();
    }
  });

  test("a start gives a root registered with another icon this one, in Explorer's pane too, without turning it off", async () => {
    const page = newPage();
    const store = { value: {} as StoredDrive };
    // As an older version left it: the exe's icon.
    const old = `${process.execPath},0`;
    const before = controllerWith(native, page, store, { icon: old }).drive;
    const on = await before.enable('acct-1', 'alice@example.org', yes);
    expect(on.ok).toBe(true);
    const folder = on.ok ? on.value.path : '';
    before.shutdown();
    const [id] = await ourRoots(native);
    expect(navigationPaneIcon(id)).toBe(old);

    const after = controllerWith(native, page, store).drive;
    try {
      await after.startUp();
      expect(await ourRoots(native)).toEqual([id]);
      expect((await native.filesDriveRoots()).find((entry) => entry.id === id)).toEqual({ id, path: folder, displayName: 'Bulwark Files', icon: ICON });
      expect(navigationPaneIcon(id)).toBe(ICON);
      expect(existsSync(folder)).toBe(true);
      expect(store.value.accounts?.['acct-1']).toMatchObject({ label: 'alice@example.org' });
    } finally {
      await after.wipe();
    }
  });

  test('a start removes sync roots of ours nobody wants, and a wipe removes all with the wishes', async () => {
    const page = newPage();
    const store = { value: {} as StoredDrive };
    const first = controllerWith(native, page, store).drive;
    expect((await first.enable('acct-1', 'alice@example.org', yes)).ok).toBe(true);
    expect((await first.enable('acct-2', 'bob@example.org', yes)).ok).toBe(true);
    first.shutdown();
    // The app went away. bob's wish went with an account removed elsewhere.
    delete store.value.accounts!['acct-2'];
    const second = controllerWith(native, page, store).drive;
    await second.startUp();
    expect(await ourRoots(native)).toHaveLength(1);
    expect(existsSync(path.join(BASE, 'drive', 'bob@example.org'))).toBe(false);
    expect(existsSync(path.join(BASE, 'drive', 'alice@example.org'))).toBe(true);

    await second.wipe();
    expect(await ourRoots(native)).toEqual([]);
    expect(existsSync(path.join(BASE, 'drive', 'alice@example.org'))).toBe(false);
    expect(store.value).toEqual({});
  });

  test('the drive letter: set by a click, on the account folder, gone at sign-out, and none when the policy says so', async () => {
    const page = newPage();
    const store = { value: {} as StoredDrive };
    let policyLetter: string | null = null;
    const { drive } = controllerWith(native, page, store, { letters: true, letter: () => policyLetter });
    const subst = () => execFileSync('subst', { encoding: 'latin1' });
    let letter: string | null = null;
    try {
      const on = await drive.enable('acct-1', 'alice@example.org', yes);
      if (!on.ok) throw new Error(on.error);
      const free = drive.state().letter.available;
      letter = free.at(-1) ?? null;
      test.skip(!letter, 'no free drive letter');
      expect(await drive.setLetter(letter, no)).toEqual({ ok: false, error: 'gesture' });
      const set = await drive.setLetter(letter, yes);
      expect(set).toMatchObject({ ok: true, value: { letter, chosen: letter, locked: false } });
      expect(subst()).toContain(`${letter}:\\: => ${on.value.path}`);
      // "This PC" names it and draws the app's icon, not the disk's.
      expect(letterLabel(letter!)).toEqual({ label: 'Bulwark Files', icon: ICON });

      await drive.disable('acct-1', 'signed-out');
      expect(subst()).not.toContain(`${letter}:\\:`);
      expect(letterLabel(letter!)).toEqual({ label: null, icon: null });
      expect((await drive.enable('acct-1', 'alice@example.org', no)).ok).toBe(true);
      expect(subst()).toContain(`${letter}:\\: => ${on.value.path}`);
      expect(letterLabel(letter!)).toEqual({ label: 'Bulwark Files', icon: ICON });

      policyLetter = 'none';
      await drive.policyChanged();
      expect(subst()).not.toContain(`${letter}:\\:`);
      expect(letterLabel(letter!)).toEqual({ label: null, icon: null });
      expect(registryValue(`${REGISTRY_ROOT}\\${DRIVES_KEY}\\${letter}`, null)).toBeNull();
      expect(drive.state().letter).toMatchObject({ letter: null, chosen: letter, locked: true });
      expect(await drive.setLetter(null, yes)).toEqual({ ok: false, error: 'policy' });
    } finally {
      await drive.wipe();
      if (letter && subst().includes(`${letter}:\\:`)) execFileSync('subst', [`${letter}:`, '/D']);
      removeRegistryRoot();
    }
    expect(subst()).not.toContain(path.join(BASE, 'drive'));
  });

  test("the letter's name and icon: written where there's none, taken away again, and someone else's left alone", async () => {
    const labels = registryLetterLabels(REGISTRY_ROOT, null);
    const key = (letter: string, part?: string) => `${REGISTRY_ROOT}\\${DRIVES_KEY}\\${letter}${part ? `\\${part}` : ''}`;
    try {
      expect(await claimLetterLabel(labels, 'Q', ICON, () => {})).toBe(true);
      expect(letterLabel('Q')).toEqual({ label: 'Bulwark Files', icon: ICON });
      await releaseLetterLabel(labels, 'Q', ICON);
      expect(registryValue(key('Q'), null)).toBeNull();
      expect(registryKeyExists(key('Q'))).toBe(false);

      // Someone's own name and icon for R: never replaced, never removed.
      execFileSync('reg', ['add', key('R', 'DefaultLabel'), '/ve', '/d', 'Backup disk', '/f']);
      execFileSync('reg', ['add', key('R', 'DefaultIcon'), '/ve', '/d', 'C:\\Tools\\disk.ico,0', '/f']);
      const warned: string[] = [];
      expect(await claimLetterLabel(labels, 'R', ICON, (message) => warned.push(message))).toBe(false);
      expect(warned).toHaveLength(1);
      await releaseLetterLabel(labels, 'R', ICON);
      expect(letterLabel('R')).toEqual({ label: 'Backup disk', icon: 'C:\\Tools\\disk.ico,0' });

      // Ours, beside something else of someone's: only ours goes.
      execFileSync('reg', ['add', key('S', 'Other'), '/ve', '/d', 'x', '/f']);
      expect(await claimLetterLabel(labels, 'S', ICON, () => {})).toBe(true);
      await releaseLetterLabel(labels, 'S', ICON);
      expect(letterLabel('S')).toEqual({ label: null, icon: null });
      expect(registryValue(key('S', 'Other'), null)).toBe('x');
    } finally {
      removeRegistryRoot();
    }
  });
});
