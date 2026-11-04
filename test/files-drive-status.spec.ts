import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { FilesDriveStatus } from '../src/shared/bridge';
import { DriveController, type StoredDrive } from '../src/main/files/drive-controller';
import { statusClassId } from '../src/main/files/drive-places';
import { helperFile, loadHelperModule, type NativeDriveStatusSeen, type NativeFilesModule } from '../src/main/native-loader';

/**
 * The drive's status in Explorer (Windows 11), against Windows itself from plain Node: the
 * helper serves it, and another process reads it the way Explorer does (the CLSID in the sync
 * root's key, created out of process). Every sync root here is a test one, `Bulwark Test <pid>`,
 * in a temp folder, and goes in `finally`. The CLSID is this run's own (made from the temp
 * profile), and no CLSID key is ever written: the tests check that too.
 */

test.skip(process.platform !== 'win32', 'the Cloud Files API is Windows only');
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = helperFile({ packaged: false, mainDir: path.join(ROOT, 'dist'), platform: process.platform, arch: process.arch });
const PROVIDER = `Bulwark Test ${process.pid}`;
const BASE = path.join(tmpdir(), `bulwark-files-status-${process.pid}`);
const CLSID = statusClassId(BASE);
const ICON = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\imageres.dll,-3`;
const ICON_URL = `file:///${(process.env.SystemRoot ?? 'C:\\Windows').replaceAll('\\', '/')}/System32/SecurityAndMaintenance.png`;
const SYNC_ROOT_MANAGER = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager';

const load = (): NativeFilesModule => {
  const loaded = loadHelperModule(FILE);
  if (!loaded?.filesDriveStatusServe) throw new Error(`${FILE} is missing or has no status calls: run npm run build:native`);
  return loaded as unknown as NativeFilesModule;
};

const status = (over: Partial<FilesDriveStatus> = {}): FilesDriveStatus => ({
  state: 'synced',
  label: 'Up to date',
  detail: 'Last synced 14:05',
  quota: { used: 1_048_816, total: 104_857_600, label: '1 MB of 100 MB used' },
  notice: null,
  ...over,
});

type Read = { ok: true; seen: NativeDriveStatusSeen } | { ok: false; error: string };

/** What Explorer gets, from another process: the class the root's key names, created out of process. */
function readElsewhere(id: string, waitMs = 0): Promise<Read> {
  const code = `require(process.argv[1]).filesDriveStatusRead(process.argv[2], Number(process.argv[3])).then((seen) => process.stdout.write(JSON.stringify(seen)), (error) => process.stdout.write('ERR ' + error.message))`;
  return new Promise((resolve) => {
    execFile(process.execPath, ['-e', code, FILE, id, String(waitMs)], { timeout: 90_000 }, (_error, stdout) => {
      const out = String(stdout);
      resolve(out.startsWith('ERR') ? { ok: false, error: out.slice(4) } : { ok: true, seen: JSON.parse(out) });
    });
  });
}

/** The value Explorer reads in a sync root's key, or null. */
function factoryValue(id: string): string | null {
  try {
    const out = execFileSync('reg', ['query', `${SYNC_ROOT_MANAGER}\\${id}`, '/v', 'StorageProviderStatusUISourceFactory'], { encoding: 'latin1', stdio: 'pipe' });
    return /REG_SZ\s+(\S+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Whether the CLSID is registered as a class anywhere. It never should be. */
function classKeys(): string[] {
  const found: string[] = [];
  for (const hive of ['HKCU', 'HKLM']) {
    try {
      execFileSync('reg', ['query', `${hive}\\Software\\Classes\\CLSID\\${CLSID}`], { stdio: 'pipe' });
      found.push(hive);
    } catch {
      // Not there.
    }
  }
  return found;
}

async function ourRoots(native: NativeFilesModule): Promise<string[]> {
  return (await native.filesDriveRoots()).filter((root) => root.id.startsWith(`${PROVIDER}!`)).map((root) => root.id);
}

async function removeEverything(native: NativeFilesModule): Promise<void> {
  native.filesDriveStatusStop?.();
  for (const id of await ourRoots(native)) await native.filesDriveUnregister(id).catch(() => {});
  rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

test.describe('the helper', () => {
  let native: NativeFilesModule;
  let id: string | null = null;
  const root = path.join(BASE, 'helper');
  const clicked: string[] = [];

  test.beforeAll(async () => {
    native = load();
    mkdirSync(root, { recursive: true });
    id = await native.filesDriveRegister({ provider: PROVIDER, account: 'status', path: root, displayName: PROVIDER, icon: ICON, version: '0.1.0' });
  });

  test.afterAll(async () => {
    native.filesDriveStatusStop!();
    if (id) await native.filesDriveUnregister(id).catch(() => {});
    await removeEverything(native);
    expect(await ourRoots(native)).toEqual([]);
    expect(classKeys()).toEqual([]);
  });

  test('Explorer finds the class through the sync root and reads state, words and quota from another process', async () => {
    expect(await readElsewhere(id!)).toEqual({ ok: false, error: expect.stringMatching(/^files:missing/) });
    expect(native.filesDriveStatusServe!(CLSID, ICON_URL, (rootId) => clicked.push(rootId))).toBe(true);
    native.filesDriveStatusAttach!(id!, CLSID);
    expect(factoryValue(id!)).toBe(CLSID);
    native.filesDriveStatusSet!(id!, { state: 'synced', label: 'Up to date', detail: 'Last synced 14:05', quota: { used: 1_048_816, total: 104_857_600, label: '1 MB of 100 MB used' } });

    const read = await readElsewhere(id!);
    expect(read).toEqual({
      ok: true,
      seen: { state: 'synced', label: 'Up to date', detail: 'Last synced 14:05', quotaUsed: 1_048_816, quotaTotal: 104_857_600, quotaLabel: '1 MB of 100 MB used', changed: false },
    });
    // Out of process, with no class in the registry.
    expect(classKeys()).toEqual([]);
  });

  test('a change reaches an Explorer that listens (StatusUIChanged), with the new state and numbers', async () => {
    const reading = readElsewhere(id!, 20_000);
    let round = 0;
    const timer = setInterval(() => {
      round++;
      native.filesDriveStatusSet!(id!, { state: 'syncing', label: 'Syncing', detail: `Syncing: ${round} done, 3 to go`, quota: { used: 99 * 1_048_576, total: 104_857_600, label: '99 MB of 100 MB used' }, notice: 'Your storage in Files is almost full' });
    }, 300);
    try {
      const read = await reading;
      expect(read.ok).toBe(true);
      const seen = (read as { seen: NativeDriveStatusSeen }).seen;
      expect(seen).toMatchObject({ state: 'syncing', label: 'Syncing', quotaUsed: 99 * 1_048_576, quotaTotal: 104_857_600, notice: 'Your storage in Files is almost full', changed: true });
      expect(seen.detail).toMatch(/^Syncing: \d+ done, 3 to go$/);
    } finally {
      clearInterval(timer);
    }
  });

  test('no limit from the server: what is used, without a total; each engine state maps to its own', async () => {
    for (const state of ['paused', 'offline', 'error'] as const) {
      native.filesDriveStatusSet!(id!, { state, label: state, detail: '', quota: { used: 7_341_096, label: '7 MB used' } });
      const read = await readElsewhere(id!);
      expect(read).toEqual({ ok: true, seen: { state, label: state, detail: '', quotaUsed: 7_341_096, quotaLabel: '7 MB used', changed: false } });
    }
    native.filesDriveStatusSet!(id!, { state: 'synced', label: 'Up to date', detail: '' });
    const read = await readElsewhere(id!);
    expect(read.ok && read.seen.quotaUsed).toBeUndefined();
  });

  test('a root it was told nothing about, or forgot, gets nothing', async () => {
    native.filesDriveStatusSet!(id!, undefined);
    expect((await readElsewhere(id!)).ok).toBe(false);
  });

  test('refuses what main never sends', () => {
    expect(() => native.filesDriveStatusSet!(id!, { state: 'idle' as never, label: 'x', detail: '' })).toThrow(/files:invalid/);
    expect(() => native.filesDriveStatusSet!(id!, { state: 'synced', label: '', detail: '' })).toThrow(/files:invalid/);
    expect(() => native.filesDriveStatusSet!(id!, { state: 'synced', label: 'x', detail: 'a\nb' })).toThrow(/files:invalid/);
    expect(() => native.filesDriveStatusSet!(id!, { state: 'synced', label: 'x', detail: '', quota: { used: -1, label: 'x' } })).toThrow(/files:invalid/);
    expect(() => native.filesDriveStatusAttach!(`..\\${id}`, CLSID)).toThrow(/files:invalid/);
    expect(() => native.filesDriveStatusServe!('not-a-clsid', ICON_URL, () => {})).toThrow(/files:invalid/);
    expect(() => native.filesDriveStatusServe!(CLSID, 'C:\\icon.png', () => {})).toThrow(/files:invalid/);
  });

  test('unregistering the sync root takes the class with its key; stopping leaves nothing to answer', async () => {
    native.filesDriveStatusSet!(id!, { state: 'synced', label: 'Up to date', detail: '' });
    expect((await readElsewhere(id!)).ok).toBe(true);
    native.filesDriveStatusStop!();
    expect(await readElsewhere(id!)).toEqual({ ok: false, error: expect.stringMatching(/^files:unsupported/) });
    await native.filesDriveUnregister(id!);
    expect(factoryValue(id!)).toBeNull();
    expect(await readElsewhere(id!)).toEqual({ ok: false, error: expect.stringMatching(/^files:missing/) });
    id = null;
    expect(classKeys()).toEqual([]);
  });
});

// ─── The controller main runs ────────────────────────────────

function controllerWith(native: NativeFilesModule, store: { value: StoredDrive }, options: { forcedOff?: () => boolean; opened?: string[] } = {}) {
  return new DriveController({
    native,
    supported: true,
    provider: PROVIDER,
    base: path.join(BASE, 'drive'),
    profile: BASE,
    icon: ICON,
    version: '0.1.0',
    store: { read: () => store.value, write: (next) => (store.value = next) },
    policy: () => ({ forcedOff: options.forcedOff?.() ?? false, letter: null }),
    page: { fetch: () => 'not-running', fetchCancelled: () => {}, stateChanged: () => {} },
    registry: { add: () => {}, remove: () => {} },
    letters: null,
    warn: () => {},
    watchPins: false,
    status: { icon: async () => ICON_URL, opened: (account) => options.opened?.push(account) },
  });
}

async function driveRootId(native: NativeFilesModule): Promise<string> {
  const ids = await ourRoots(native);
  expect(ids).toHaveLength(1);
  return ids[0];
}

test.describe('the drive controller', () => {
  let native: NativeFilesModule;

  test.beforeAll(() => {
    native = load();
  });

  test.afterAll(async () => {
    await removeEverything(native);
    expect(await ourRoots(native)).toEqual([]);
    expect(classKeys()).toEqual([]);
  });

  test("the page's status shows in Explorer once the drive is on, and follows it", async () => {
    const store = { value: {} as StoredDrive };
    const drive = controllerWith(native, store);
    try {
      // Said before the drive is on: kept, and shown when it is.
      drive.setStatus('acct-1', status());
      expect((await drive.enable('acct-1', 'alice@example.org', () => true)).ok).toBe(true);
      const id = await driveRootId(native);
      expect(factoryValue(id)).toBe(drive.statusClassId);
      expect(await readElsewhere(id)).toMatchObject({ ok: true, seen: { state: 'synced', label: 'Up to date', quotaUsed: 1_048_816, quotaTotal: 104_857_600 } });

      drive.setStatus('acct-1', status({ state: 'offline', label: 'Offline', detail: '2 changes wait for the server', quota: { used: 2_000_000, total: null, label: '2 MB used' } }));
      expect(await readElsewhere(id)).toEqual({ ok: true, seen: { state: 'offline', label: 'Offline', detail: '2 changes wait for the server', quotaUsed: 2_000_000, quotaLabel: '2 MB used', changed: false } });

      // What isn't a status is dropped: the last good one stays.
      drive.setStatus('acct-1', { state: 'synced', label: 'x'.repeat(201), detail: '', quota: null, notice: null });
      drive.setStatus('acct-1', { ...status(), quota: { used: 1.5, total: 10, label: 'x' } });
      expect(await readElsewhere(id)).toMatchObject({ ok: true, seen: { state: 'offline' } });
    } finally {
      await drive.wipe();
    }
  });

  test('turning it off, a sign-out, the policy and a wipe each take the status with the sync root', async () => {
    const store = { value: {} as StoredDrive };
    let forcedOff = false;
    const drive = controllerWith(native, store, { forcedOff: () => forcedOff });
    try {
      const on = async () => {
        drive.setStatus('acct-1', status());
        expect((await drive.enable('acct-1', 'alice@example.org', () => true)).ok).toBe(true);
        const id = await driveRootId(native);
        expect((await readElsewhere(id)).ok).toBe(true);
        return id;
      };
      const gone = async (id: string) => {
        expect(await ourRoots(native)).toEqual([]);
        expect(factoryValue(id)).toBeNull();
        expect((await readElsewhere(id)).ok).toBe(false);
      };

      let id = await on();
      await drive.disable('acct-1', 'user');
      await gone(id);

      id = await on();
      await drive.disable('acct-1', 'signed-out');
      await gone(id);
      // Back at the next sign-in, without a click: the page says its status again.
      expect((await drive.enable('acct-1', 'alice@example.org', () => false)).ok).toBe(true);
      id = await driveRootId(native);
      expect((await readElsewhere(id)).ok).toBe(false);
      drive.setStatus('acct-1', status({ state: 'syncing', label: 'Syncing' }));
      expect(await readElsewhere(id)).toMatchObject({ ok: true, seen: { state: 'syncing' } });

      forcedOff = true;
      await drive.policyChanged();
      await gone(id);

      forcedOff = false;
      id = await on();
      await drive.wipe();
      await gone(id);
      expect(existsSync(path.join(BASE, 'drive', 'alice@example.org'))).toBe(false);
    } finally {
      await drive.wipe();
    }
    expect(classKeys()).toEqual([]);
  });

  test('a Windows without the status, or no icon: no status, and the drive works the same', async () => {
    const store = { value: {} as StoredDrive };
    const withoutStatus = { ...native, filesDriveStatusServe: () => false } as NativeFilesModule;
    const drive = controllerWith(withoutStatus, store);
    try {
      drive.setStatus('acct-1', status());
      expect((await drive.enable('acct-1', 'alice@example.org', () => true)).ok).toBe(true);
      const id = await driveRootId(native);
      expect(factoryValue(id)).toBeNull();
      expect((await readElsewhere(id)).ok).toBe(false);
    } finally {
      await drive.wipe();
    }
    expect(await ourRoots(native)).toEqual([]);
  });
});
