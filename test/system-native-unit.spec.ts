// What main asks the native helper for in place of Windows' own tools, with a fake helper: the
// wrappers' answers when it's there, when it fails, and when it's missing (an older binary,
// another platform). No Electron, no registry, no clipboard.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { windowsOpenWithRegistration, windowsRegistration } from '../src/main/features/os-rules';
import { driveLettersFrom, registryFrom, wrapHelper, type NativeModule, type NativeSystemModule } from '../src/main/native-loader';
import { makeFolderPrivate } from '../src/main/private-folder';
import { hasValue, readKey, readString } from '../src/main/registry-values';
import { uninstallCleanup } from '../src/main/uninstall-cleanup';
import { fakeRegistry } from './fake-registry';

const quiet = () => {};

/** A helper with only the calls given, and the base exports every helper has. */
function helper(calls: Partial<NativeSystemModule>): NativeModule {
  return {
    helloAvailable: async () => false,
    helloVerify: async () => 'unavailable',
    keystoreList: async () => [],
    keystoreSign: async () => Buffer.alloc(0),
    keystoreDecrypt: async () => Buffer.alloc(0),
    keystoreAgree: async () => Buffer.alloc(0),
    policyIsForced: () => false,
    ...calls,
  };
}

test.describe('the helper\'s Windows calls, wrapped', () => {
  test('pass through when the helper has them', async () => {
    const seen: unknown[] = [];
    const system = wrapHelper(
      helper({
        notificationQuietState: async () => ({ profile: 1, notificationState: 5 }),
        clipboardWriteFiles: async (paths) => {
          seen.push(['clipboard', paths]);
        },
        folderMakePrivate: async (folder) => {
          seen.push(['private', folder]);
        },
        fileSetPin: async (file, pin) => {
          seen.push(['pin', file, pin]);
        },
      }),
      { platform: 'win32', warn: quiet },
    ).system;
    expect(await system.quietState()).toEqual({ profile: 1, notificationState: 5 });
    expect(await system.clipboardWriteFiles(['C:\\a.eml', 'C:\\b.eml'])).toBe(true);
    expect(await system.makeFolderPrivate('C:\\x')).toBe(true);
    expect(await system.setPin('C:\\x\\f', 'pinned')).toBe(true);
    expect(seen).toEqual([
      ['clipboard', ['C:\\a.eml', 'C:\\b.eml']],
      ['private', 'C:\\x'],
      ['pin', 'C:\\x\\f', 'pinned'],
    ]);
  });

  test("a window to the front: the helper's answer on Windows, false when it throws, is missing or off Windows", () => {
    const handles: Buffer[] = [];
    const handle = Buffer.from([1, 2, 3, 4, 0, 0, 0, 0]);
    const front = (hwnd: Buffer) => {
      handles.push(hwnd);
      return true;
    };
    expect(wrapHelper(helper({ windowToFront: front }), { platform: 'win32', warn: quiet }).system.windowToFront(handle)).toBe(true);
    expect(handles).toEqual([handle]);

    const warned: string[] = [];
    const throwing = () => {
      throw new Error('boom');
    };
    expect(wrapHelper(helper({ windowToFront: throwing }), { platform: 'win32', warn: (message) => warned.push(message) }).system.windowToFront(handle)).toBe(false);
    expect(warned.join('\n')).toContain('boom');

    for (const [native, platform] of [
      [helper({}), 'win32'],
      [null, 'win32'],
      [helper({ windowToFront: front }), 'darwin'],
      [helper({ windowToFront: front }), 'linux'],
    ] as const) {
      expect(wrapHelper(native, { platform, warn: quiet }).system.windowToFront(handle)).toBe(false);
    }
    expect(handles).toHaveLength(1);
  });

  test('answer what the tool\'s failure gave when a call fails', async () => {
    const warned: string[] = [];
    const fail = async () => {
      throw new Error('clipboard:busy');
    };
    const system = wrapHelper(helper({ notificationQuietState: fail, clipboardWriteFiles: fail, folderMakePrivate: fail, fileSetPin: fail }), { platform: 'win32', warn: (message) => warned.push(message) }).system;
    expect(await system.quietState()).toBeNull();
    expect(await system.clipboardWriteFiles(['C:\\a.eml'])).toBe(false);
    expect(await system.makeFolderPrivate('C:\\x')).toBe(false);
    expect(await system.setPin('C:\\x', 'unpinned')).toBe(false);
    expect(warned.join('\n')).toContain('clipboard:busy');
  });

  test('answer the same with an older helper, with none, and off Windows', async () => {
    const all = helper({
      notificationQuietState: async () => ({ profile: 2, notificationState: 5 }),
      clipboardWriteFiles: async () => {},
      folderMakePrivate: async () => {},
      fileSetPin: async () => {},
      registryRead: () => null,
      registrySetString: () => {},
      registryDeleteKey: () => true,
      registryDeleteValue: () => true,
      driveLetterList: () => [],
      driveLetterAdd: async () => {},
      driveLetterRemove: async () => {},
    });
    for (const [native, platform] of [
      [helper({}), 'win32'],
      [null, 'win32'],
      [all, 'darwin'],
      [all, 'linux'],
    ] as const) {
      const system = wrapHelper(native, { platform, warn: quiet }).system;
      expect(system.registry).toBeNull();
      expect(system.driveLetters).toBeNull();
      expect(await system.quietState()).toBeNull();
      expect(await system.clipboardWriteFiles(['C:\\a.eml'])).toBe(false);
      expect(await system.makeFolderPrivate('C:\\x')).toBe(false);
      expect(await system.setPin('C:\\x', 'pinned')).toBe(false);
    }
    expect(wrapHelper(all, { platform: 'win32', warn: quiet }).system.registry).not.toBeNull();
  });

  test('the registry: only a read throws, a write or delete that fails is false', () => {
    const registry = registryFrom(
      helper({
        registryRead: () => {
          throw new Error('registry:denied (0x80070005)');
        },
        registrySetString: () => {
          throw new Error('registry:invalid (only under HKCU\\Software)');
        },
        registryDeleteKey: () => {
          throw new Error('registry:denied');
        },
        registryDeleteValue: () => false,
      }),
      quiet,
    )!;
    expect(() => registry.read('HKLM\\SOFTWARE\\Policies')).toThrow('registry:denied');
    expect(registry.setString('HKLM\\Software\\x', 'a', 'b')).toBe(false);
    expect(registry.deleteKey('HKCU\\Software\\x')).toBe(false);
    expect(registry.deleteValue('HKCU\\Software\\x', 'a')).toBe(false);
    // An older helper with some of the calls has none of them.
    expect(registryFrom(helper({ registryRead: () => null }))).toBeNull();
  });

  test('drive letters: the helper\'s list by letter, adds and removes as true or false', async () => {
    const letters = driveLettersFrom(
      helper({
        driveLetterList: () => [{ letter: 'x', target: 'C:\\Users\\a\\Bulwark Files' }],
        driveLetterAdd: async (letter) => {
          if (letter === 'D') throw new Error('system:exists');
        },
        driveLetterRemove: async () => {},
      }),
      quiet,
    )!;
    expect(letters.list()).toEqual(new Map([['X', 'C:\\Users\\a\\Bulwark Files']]));
    expect(await letters.add('Y', 'C:\\f')).toBe(true);
    expect(await letters.add('D', 'C:\\f')).toBe(false);
    expect(await letters.remove('Y')).toBe(true);
    const broken = driveLettersFrom(
      helper({
        driveLetterList: () => {
          throw new Error('x');
        },
        driveLetterAdd: async () => {},
        driveLetterRemove: async () => {},
      }),
      quiet,
    )!;
    expect(broken.list()).toEqual(new Map());
  });
});

test.describe('single registry values, as reg query read them', () => {
  const registry = fakeRegistry({
    'HKCU\\Software\\Classes\\bulwark\\shell\\open\\command': [{ name: '', kind: 'sz', text: '"C:\\Apps\\Bulwark.exe" -- "%1"' }],
    'HKCU\\Software\\RegisteredApplications': [
      { name: 'Bulwark', kind: 'sz', text: 'Software\\Bulwark\\Capabilities' },
      { name: 'Binary', kind: 'binary' },
      { name: 'Path', kind: 'expand_sz', text: '%LOCALAPPDATA%\\x' },
    ],
    'HKCU\\Software\\Empty': [],
  });

  test('by name without case, the default value as the empty name', () => {
    expect(readString(registry, 'HKCU\\Software\\Classes\\bulwark\\shell\\open\\command')).toBe('"C:\\Apps\\Bulwark.exe" -- "%1"');
    expect(readString(registry, 'HKCU\\Software\\RegisteredApplications', 'bulwark')).toBe('Software\\Bulwark\\Capabilities');
    expect(readString(registry, 'HKCU\\Software\\RegisteredApplications', 'Path')).toBe('%LOCALAPPDATA%\\x');
  });

  test('none for a missing key or value, another type, no registry, or a key that can\'t be read', () => {
    expect(readString(registry, 'HKCU\\Software\\Nope')).toBeNull();
    expect(readString(registry, 'HKCU\\Software\\Empty')).toBeNull();
    expect(readString(registry, 'HKCU\\Software\\RegisteredApplications', 'Binary')).toBeNull();
    expect(readString(null, 'HKCU\\Software\\RegisteredApplications', 'Bulwark')).toBeNull();
    const denied = fakeRegistry({ 'HKCU\\Software\\Secret': [{ name: '', kind: 'sz', text: 'x' }] });
    denied.deny('HKCU\\Software\\Secret');
    expect(readString(denied, 'HKCU\\Software\\Secret')).toBeNull();
  });

  test('a value of any type counts as there, and an empty key is still a key', () => {
    expect(hasValue(registry, 'HKCU\\Software\\RegisteredApplications', 'Binary')).toBe(true);
    expect(hasValue(registry, 'HKCU\\Software\\RegisteredApplications', 'Other')).toBe(false);
    expect(readKey(registry, 'HKCU\\Software\\Empty')).not.toBeNull();
  });
});

test.describe('the uninstall cleanup, on a registry of its own', () => {
  const root = 'HKCU\\Software\\BulwarkTest\\u';
  const exe = 'C:\\Program Files\\Bulwark\\Bulwark.exe';
  const icon = 'C:\\Program Files\\Bulwark\\resources\\os-icons\\bulwark.ico,0';
  const drives = `${root}\\Software\\Classes\\Applications\\Explorer.exe\\Drives`;
  const run = `${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`;

  function planted() {
    const registry = fakeRegistry();
    for (const value of [...windowsRegistration(exe), ...windowsOpenWithRegistration(exe)]) registry.setString(`${root}\\${value.key}`, value.name, value.data);
    registry.setString(`${root}\\Software\\Classes\\.pdf\\OpenWithProgids`, 'Other.App', '');
    registry.setString(`${root}\\Software\\Classes\\CLSID\\{7B1E4F2A-93C6-4D0E-A5B8-2F6C1D9E3A47}\\LocalServer32`, undefined, `"${exe}"`);
    registry.setString(`${root}\\Software\\Classes\\CLSID\\{0D3C5A11-2B7E-4C9F-8E61-5A4B3C2D1E0F}\\LocalServer32`, undefined, 'C:\\Other\\Other.exe');
    registry.setString(`${drives}\\Q\\DefaultLabel`, undefined, 'Bulwark Files');
    registry.setString(`${drives}\\Q\\DefaultIcon`, undefined, icon);
    registry.setString(`${drives}\\R\\DefaultLabel`, undefined, 'Backup disk');
    registry.setString(`${drives}\\R\\DefaultIcon`, undefined, 'C:\\Tools\\disk.ico,0');
    return registry;
  }

  test('takes what this exe wrote and leaves the rest', async () => {
    const registry = planted();
    registry.setString(run, 'Bulwark', `"${exe}" --bulwark-from-login`);
    await uninstallCleanup({ root, exe, sendTo: null, local: null }, registry);
    expect(readKey(registry, `${root}\\Software\\Classes\\bulwark`)).toBeNull();
    expect(hasValue(registry, `${root}\\Software\\RegisteredApplications`, 'Bulwark')).toBe(false);
    expect(hasValue(registry, `${root}\\Software\\Classes\\.pdf\\OpenWithProgids`, 'Other.App')).toBe(true);
    expect(hasValue(registry, `${root}\\Software\\Classes\\.pdf\\OpenWithProgids`, 'Bulwark.File.attach')).toBe(false);
    expect(readKey(registry, `${root}\\Software\\Classes\\CLSID\\{7B1E4F2A-93C6-4D0E-A5B8-2F6C1D9E3A47}`)).toBeNull();
    expect(readKey(registry, `${root}\\Software\\Classes\\CLSID\\{0D3C5A11-2B7E-4C9F-8E61-5A4B3C2D1E0F}`)).not.toBeNull();
    expect(hasValue(registry, run, 'Bulwark')).toBe(false);
    expect(readKey(registry, `${drives}\\Q`)).toBeNull();
    expect(readString(registry, `${drives}\\R\\DefaultLabel`)).toBe('Backup disk');
  });

  test('keeps another install\'s login entry', async () => {
    const registry = planted();
    registry.setString(run, 'Bulwark', '"C:\\Users\\someone\\AppData\\Local\\Programs\\bulwark\\Bulwark.exe" --bulwark-from-login');
    await uninstallCleanup({ root, exe, sendTo: null, local: null }, registry);
    expect(hasValue(registry, run, 'Bulwark')).toBe(true);
  });

  test('without a registry the folders still go', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-cleanup-'));
    try {
      mkdirSync(path.join(dir, 'SendTo'));
      writeFileSync(path.join(dir, 'SendTo', 'Bulwark (as attachment).lnk'), '');
      mkdirSync(path.join(dir, 'Local', 'Bulwark', 'os-files'), { recursive: true });
      await uninstallCleanup({ root, exe, sendTo: path.join(dir, 'SendTo'), local: path.join(dir, 'Local') }, null);
      expect(existsSync(path.join(dir, 'SendTo', 'Bulwark (as attachment).lnk'))).toBe(false);
      expect(existsSync(path.join(dir, 'Local', 'Bulwark'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('a private folder', () => {
  let dir = '';
  test.beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bw-private-'));
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('on Windows the helper closes it, and without the helper it counts only inside the home folder', async () => {
    const asked: string[] = [];
    const folder = path.win32.join(dir, 'edit-files');
    expect(
      await makeFolderPrivate(folder, {
        platform: 'win32',
        makePrivate: async (target) => {
          asked.push(target);
          return true;
        },
        home: 'C:\\Users\\nobody',
      }),
    ).toBe(true);
    expect(asked).toEqual([folder]);
    expect(existsSync(folder)).toBe(true);
    const without = { platform: 'win32' as const, makePrivate: async () => false, warn: quiet };
    expect(await makeFolderPrivate(folder, { ...without, home: dir })).toBe(true);
    expect(await makeFolderPrivate(folder, { ...without, home: 'C:\\Users\\nobody' })).toBe(false);
  });

  test('elsewhere it is mode 700, and the helper is never asked', async () => {
    test.skip(process.platform === 'win32', 'POSIX modes');
    const folder = path.join(dir, 'edit-files');
    expect(await makeFolderPrivate(folder, { platform: process.platform, makePrivate: async () => { throw new Error('asked'); }, home: dir })).toBe(true);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });
});
