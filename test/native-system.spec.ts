// What the native helper does in place of Windows' own tools, against Windows itself, from
// plain Node. Nothing here touches what's the user's: the registry only under a test key made
// and deleted here, a drive letter nobody uses, removed again, a temp file and folder, and the
// clipboard of a window station of its own (fixtures/own-window-station.ps1). The tools these
// replaced are used here only to check the result from the outside.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { helperFile, loadHelperModule, type NativeModule, type NativeSystemModule } from '../src/main/native-loader';

test.skip(process.platform !== 'win32', 'Windows only');

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = helperFile({ packaged: false, mainDir: path.join(ROOT, 'dist'), platform: process.platform, arch: process.arch });

const load = (): NativeModule & NativeSystemModule => {
  const loaded = loadHelperModule(FILE);
  if (!loaded?.registryRead) throw new Error(`${FILE} is missing or old: run npm run build:native`);
  return loaded as NativeModule & NativeSystemModule;
};

/** Windows' own tools, by full path: a Git for Windows `whoami` in PATH answers differently. */
const tool = (name: string) => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);
const reg = (...args: string[]) => spawnSync(tool('reg.exe'), args, { encoding: 'utf8', windowsHide: true });

test.describe('the registry', () => {
  const key = `HKCU\\Software\\BulwarkTest\\Native${process.pid}`;
  test.afterEach(() => {
    reg('delete', key, '/f');
  });

  test('writes strings as reg add did, and reads every type as reg query showed it', () => {
    const native = load();
    native.registrySetString(`${key}\\A`, undefined, 'default ü');
    native.registrySetString(`${key}\\A`, 'Named', 'x');
    expect(reg('query', `${key}\\A`, '/v', 'Named').stdout).toMatch(/Named\s+REG_SZ\s+x/);
    reg('add', `${key}\\A\\B`, '/v', 'D', '/t', 'REG_DWORD', '/d', '4294967295', '/f');
    reg('add', `${key}\\A\\B`, '/v', 'Q', '/t', 'REG_QWORD', '/d', '0x20000000000001', '/f');
    reg('add', `${key}\\A\\B`, '/v', 'M', '/t', 'REG_MULTI_SZ', '/d', 'one\\0two', '/f');
    reg('add', `${key}\\A\\B`, '/v', 'E', '/t', 'REG_EXPAND_SZ', '/d', '%TEMP%\\x', '/f');
    reg('add', `${key}\\A\\B`, '/v', 'Bin', '/t', 'REG_BINARY', '/d', '0102', '/f');
    reg('add', `${key}\\A\\B\\C\\D`, '/f');

    const nodes = native.registryRead(key, 2)!;
    expect(nodes.map((node) => node.path)).toEqual(['', 'A', 'A\\B']);
    expect(nodes[0]).toEqual({ path: '', values: [], subkeys: ['A'] });
    expect(nodes[1].values).toEqual([
      { name: '', kind: 'sz', text: 'default ü' },
      { name: 'Named', kind: 'sz', text: 'x' },
    ]);
    expect(nodes[2].subkeys).toEqual(['C']);
    expect(nodes[2].values).toEqual([
      { name: 'D', kind: 'dword', number: 4294967295 },
      { name: 'Q', kind: 'qword', text: '9007199254740993' },
      { name: 'M', kind: 'multi_sz', list: ['one', 'two'] },
      { name: 'E', kind: 'expand_sz', text: '%TEMP%\\x' },
      { name: 'Bin', kind: 'binary' },
    ]);
  });

  test('a key that is not there is null; one that is there and denied throws', () => {
    const native = load();
    expect(native.registryRead(`${key}\\Nope`, 0)).toBeNull();
    expect(() => native.registryRead('HKLM\\SECURITY\\Policy', 0)).toThrow(/^registry:denied/);
    expect(native.registryRead('HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', 0)![0].values.find((value) => value.name === 'CurrentBuild')?.kind).toBe('sz');
  });

  test('deletes a value and a whole key, and says when there was nothing', () => {
    const native = load();
    native.registrySetString(`${key}\\A\\B`, 'v', 'x');
    expect(native.registryDeleteValue(`${key}\\A\\B`, 'v')).toBe(true);
    expect(native.registryDeleteValue(`${key}\\A\\B`, 'v')).toBe(false);
    expect(native.registryDeleteKey(`${key}\\A`)).toBe(true);
    expect(reg('query', `${key}\\A`).status).not.toBe(0);
    expect(native.registryDeleteKey(`${key}\\A`)).toBe(false);
  });

  test('writes nowhere but under HKCU\\Software\\<name>', () => {
    const native = load();
    for (const outside of ['HKLM\\Software\\BulwarkTest', 'HKCU\\Software', 'HKCU', 'HKCU\\Environment\\BulwarkTest', 'HKCR\\BulwarkTest']) {
      expect(() => native.registrySetString(outside, 'x', 'y'), outside).toThrow(/^registry:invalid/);
      expect(() => native.registryDeleteKey(outside), outside).toThrow(/^registry:invalid/);
    }
    expect(() => native.registryRead('HKCU\\Software\\\\x', 0)).toThrow(/^registry:invalid/);
  });
});

test('Focus Assist: two numbers, without PowerShell', async () => {
  const state = await load().notificationQuietState();
  expect(Number.isInteger(state.profile) && Number.isInteger(state.notificationState)).toBe(true);
});

test.describe("an installer's signature, without PowerShell", () => {
  let dir = '';
  test.beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bw-native-signature-'));
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** What electron-updater read from PowerShell, for the same file. */
  const powershell = (file: string): { status: number; subject: string | null } => {
    const script = `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; ConvertTo-Json -Compress @{ status = [int]$s.Status; subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null } }`;
    return JSON.parse(execFileSync(tool(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe')), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }));
  };

  test('a signed file: valid, and the signer as Get-AuthenticodeSignature names it', async () => {
    // Node's own exe is signed in the file, as our installers are.
    const answer = await load().codeSignatureCheck(process.execPath);
    const theirs = powershell(process.execPath);
    test.skip(theirs.status !== 0, 'this node.exe is not signed');
    expect(answer).toEqual({ status: 'valid', code: '0x00000000', subject: theirs.subject });
  });

  test('a changed file is invalid, with its signer still named; a file without a signature is unsigned', async () => {
    const native = load();
    const changed = path.join(dir, 'changed.exe');
    const bytes = readFileSync(process.execPath);
    bytes[4096] ^= 0xff;
    writeFileSync(changed, bytes);
    const answer = await native.codeSignatureCheck(changed);
    expect(answer.status).toBe('invalid');
    expect(answer.code).toBe('0x80096010');
    expect(powershell(changed).status).toBe(3);
    const unsigned = path.join(dir, 'unsigned.exe');
    writeFileSync(unsigned, 'MZ');
    expect((await native.codeSignatureCheck(unsigned)).status).toBe('unsigned');
    expect(() => native.codeSignatureCheck('relative.exe')).toThrow(/invalid/);
  });
});

test.describe('on the disk', () => {
  let dir = '';
  test.beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bw-native-system-'));
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('the pin attributes, as attrib sets them', async () => {
    const native = load();
    const file = path.join(dir, 'f.txt');
    writeFileSync(file, 'x');
    const flags = () => execFileSync(tool('attrib.exe'), [file], { encoding: 'utf8', windowsHide: true }).slice(0, 20);
    await native.fileSetPin(file, 'pinned');
    expect(flags()).toMatch(/P/);
    expect(flags()).not.toMatch(/U/);
    await native.fileSetPin(file, 'unpinned');
    expect(flags()).toMatch(/U/);
    expect(flags()).not.toMatch(/P/);
    await native.fileSetPin(file, 'unspecified');
    expect(flags()).not.toMatch(/[PU]/);
    await expect(native.fileSetPin(path.join(dir, 'gone.txt'), 'pinned')).rejects.toThrow(/^system:missing/);
    expect(() => native.fileSetPin(file, 'always' as never)).toThrow(/^system:invalid/);
  });

  test('a private folder: this user and SYSTEM, full control, inherited by what is in it, nothing from above', async () => {
    const native = load();
    const folder = path.join(dir, 'private');
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'inner.txt'), 'x');
    await native.folderMakePrivate(folder);
    const sid = /S-1-5-[\d-]+/.exec(execFileSync(tool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }))![0];
    const saved = path.join(dir, 'acl.txt');
    execFileSync(tool('icacls.exe'), [folder, '/save', saved], { windowsHide: true });
    const sddl = readFileSync(saved, 'utf16le').split(/\r?\n/)[1];
    // Protected (P), and exactly the two entries.
    expect(sddl).toMatch(/^D:PAI?\(/);
    const entries = sddl.match(/\([^)]*\)/g)!;
    expect(entries.sort()).toEqual([`(A;OICI;FA;;;${sid})`, '(A;OICI;FA;;;SY)'].sort());
    execFileSync(tool('icacls.exe'), [path.join(folder, 'inner.txt'), '/save', saved], { windowsHide: true });
    expect(readFileSync(saved, 'utf16le')).toContain(`(A;ID;FA;;;${sid})`);
  });

  test('a drive letter mapped to a folder, listed as subst lists it, and taken away again', async () => {
    const native = load();
    const used = native.filesUsedDriveLetters!();
    const listed = native.driveLetterList().map((mapping) => mapping.letter);
    const letter = 'QRSTUVWXY'.split('').reverse().find((candidate) => !(used & (1 << (candidate.charCodeAt(0) - 65))) && !listed.includes(candidate));
    test.skip(!letter, 'no free letter');
    const subst = () => execFileSync(tool('subst.exe'), [], { encoding: 'utf8', windowsHide: true });
    try {
      await native.driveLetterAdd(letter!, dir);
      expect(native.driveLetterList()).toContainEqual({ letter: letter!, target: dir });
      expect(subst()).toContain(`${letter}:\\: => ${dir}`);
      await expect(native.driveLetterAdd(letter!, dir)).rejects.toThrow(/^system:exists/);
      await expect(native.driveLetterRemove('C')).rejects.toThrow(/^system:invalid/);
      await native.driveLetterRemove(letter!);
      expect(native.driveLetterList().map((mapping) => mapping.letter)).not.toContain(letter);
      expect(subst()).not.toContain(`${letter}:\\:`);
      await expect(native.driveLetterRemove(letter!)).rejects.toThrow(/^system:missing/);
      await expect(native.driveLetterAdd(letter!, path.join(dir, 'gone'))).rejects.toThrow(/^system:missing/);
    } finally {
      if (subst().includes(`${letter}:\\:`)) execFileSync(tool('subst.exe'), [`${letter}:`, '/D'], { windowsHide: true });
    }
  });

  test('files on the clipboard as Explorer copies them, in a window station of its own', () => {
    const native = load();
    expect(() => native.clipboardWriteFiles([])).toThrow(/^clipboard:invalid/);
    expect(() => native.clipboardWriteFiles(['relative.txt'])).toThrow(/invalid/);
    const files = [path.join(dir, 'a.eml'), path.join(dir, 'b ü.eml')];
    for (const file of files) writeFileSync(file, 'x');
    const log = path.join(dir, 'clipboard.log');
    const command = `node "${path.join(ROOT, 'test', 'fixtures', 'clipboard-check.cjs')}" "${FILE}" ${files.map((file) => `"${file}"`).join(' ')}`;
    const run = spawnSync(tool(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe')), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'test', 'fixtures', 'own-window-station.ps1'), '-Log', log, '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    const answer = JSON.parse(readFileSync(log, 'utf8').trim().split(/\r?\n/).pop()!);
    expect(answer.after).toEqual({ files, effect: 1 });
    expect(run.status).toBe(0);
    // The user's clipboard, in the window station this test runs in, didn't change.
    const sequence = /clipboard sequence (\d+) (\d+)/.exec(run.stdout);
    expect(sequence?.[1]).toBe(sequence?.[2]);
  });
});
