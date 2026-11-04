import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { windowsOpenWithRegistration } from '../src/main/features/os-rules';

/**
 * The NSIS switches, from the real include, compiled by the NSIS electron-builder
 * uses, and run. Only the key differs: writing the real one takes an administrator, so
 * the harness writes under HKCU and the user runs the real one (see the report).
 */

const INCLUDE = path.resolve(import.meta.dirname, '..', 'build', 'installer.nsh');
const CACHE = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
const KEY = `Software\\BulwarkTest\\Policies\\nsis${process.pid}`;
/** Where the harness's "Open with" keys go in place of Software\Classes. */
const CLASSES = `Software\\BulwarkTest\\OpenWith\\nsis${process.pid}\\Classes`;

function makensis(): string | null {
  if (!existsSync(CACHE)) return null;
  for (const entry of readdirSync(CACHE)) {
    if (!entry.startsWith('nsis-') || entry.startsWith('nsis-resources')) continue;
    const top = path.join(CACHE, entry);
    for (const folder of [top, ...readdirSync(top, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(top, d.name))]) {
      const file = path.join(folder, 'Bin', 'makensis.exe');
      if (existsSync(file)) return file;
    }
  }
  return null;
}

const compiler = makensis();
const reg = (...args: string[]) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });

function value(sub: string, name: string): string | null {
  const answer = reg('query', `HKCU\\${KEY}${sub}`, '/v', name);
  if (answer.status !== 0) return null;
  return new RegExp(`${name}\\s+REG_SZ\\s+(.*)`).exec(answer.stdout)?.[1]?.trim() ?? null;
}

test.describe('the installer writes the same policies as the MSI', () => {
  test.skip(process.platform !== 'win32' || !compiler, 'needs Windows and electron-builder\'s NSIS');

  let dir = '';

  function build(name: string, defines: string): string {
    const exe = path.join(dir, `${name}.exe`);
    const script = path.join(dir, `${name}.nsi`);
    writeFileSync(
      script,
      [
        'Unicode true',
        // Never the user's own Classes or Send to folder, whatever the test is about.
        `!define BULWARK_CLASSES_KEY "${CLASSES}"`,
        `!define BULWARK_SENDTO_DIR "${sendTo()}"`,
        '!define APP_EXECUTABLE_FILENAME "Bulwark.exe"',
        `InstallDir "${path.join(dir, 'app')}"`,
        // electron-builder's own is in its templates: an update passes --updated.
        '!include "FileFunc.nsh"',
        '!macro _isUpdated _a _b _t _f',
        '  Push $R9',
        '  ${GetParameters} $R9',
        '  ClearErrors',
        '  ${GetOptions} $R9 "--updated" $R9',
        '  Pop $R9',
        '  IfErrors `${_f}` `${_t}`',
        '!macroend',
        '!define isUpdated `"" isUpdated ""`',
        defines,
        `Name "${name}"`,
        `OutFile "${exe}"`,
        'RequestExecutionLevel user',
        'SilentInstall silent',
        `!include "${INCLUDE}"`,
        'Section',
        '  !insertmacro customInstall',
        'SectionEnd',
      ].join('\n'),
    );
    const made = spawnSync(compiler!, ['-V2', script], { encoding: 'utf8', windowsHide: true });
    expect(made.status, made.stdout + made.stderr).toBe(0);
    return exe;
  }

  let harness = '';
  const sendTo = () => path.join(dir, 'SendTo');

  test.beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bw-nsis-'));
    harness = build('harness', `!define BULWARK_POLICY_HIVE "HKCU"\n!define BULWARK_POLICY_KEY "${KEY}"`);
  });

  test.afterAll(() => {
    // Only this run's keys, then their parents if nothing else is in them: other runs use the tree too.
    reg('delete', `HKCU\\${KEY}`, '/f');
    reg('delete', `HKCU\\${CLASSES.replace(/\\Classes$/, '')}`, '/f');
    for (const parent of ['Software\\BulwarkTest\\Policies', 'Software\\BulwarkTest\\OpenWith', 'Software\\BulwarkTest']) {
      const answer = reg('query', `HKCU\\${parent}`);
      const lines = (answer.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (answer.status === 0 && lines.length <= 1) reg('delete', `HKCU\\${parent}`, '/f');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test.afterEach(() => {
    reg('delete', `HKCU\\${KEY}`, '/f');
    reg('delete', `HKCU\\${CLASSES}`, '/f');
    rmSync(sendTo(), { recursive: true, force: true });
  });

  test('with /FORCE_INSTANCE=1 the values are forced', () => {
    const run = spawnSync(harness, ['/INSTANCE_URL=https://mail.example.com/path', '/FORCE_INSTANCE=1', '/UPDATE_CHANNEL=beta']);
    expect(run.status).toBe(0);
    expect(value('', 'InstanceUrl')).toBe('https://mail.example.com/path');
    expect(value('', 'UpdateChannel')).toBe('beta');
    expect(value('\\Recommended', 'InstanceUrl')).toBeNull();
  });

  test('without it they are recommended', () => {
    const run = spawnSync(harness, ['/INSTANCE_URL=https://mail.example.com', '/UPDATE_CHANNEL=stable']);
    expect(run.status).toBe(0);
    expect(value('\\Recommended', 'InstanceUrl')).toBe('https://mail.example.com');
    expect(value('\\Recommended', 'UpdateChannel')).toBe('stable');
    expect(value('', 'InstanceUrl')).toBeNull();
  });

  test('a value with slashes, spaces in quotes, and an option that only looks like one', () => {
    const run = spawnSync(harness, ['/XINSTANCE_URL=https://wrong.example', '/INSTANCE_URL=https://mail.example.com/a/b', '/UPDATE_CHANNEL="be ta"', '/FORCE_INSTANCE=1'], { windowsVerbatimArguments: true });
    expect(run.status).toBe(0);
    expect(value('', 'InstanceUrl')).toBe('https://mail.example.com/a/b');
    expect(value('', 'UpdateChannel')).toBe('be ta');
  });

  test('/FORCE_INSTANCE=0 is not forced', () => {
    spawnSync(harness, ['/INSTANCE_URL=https://mail.example.com', '/FORCE_INSTANCE=0']);
    expect(value('', 'InstanceUrl')).toBeNull();
    expect(value('\\Recommended', 'InstanceUrl')).toBe('https://mail.example.com');
  });

  test('no switches write nothing, so an update leaves the policy as it is', () => {
    expect(spawnSync(harness, []).status).toBe(0);
    expect(reg('query', `HKCU\\${KEY}`).status).toBe(1);
  });

  test('one switch at a time', () => {
    spawnSync(harness, ['/UPDATE_CHANNEL=beta']);
    expect(value('\\Recommended', 'UpdateChannel')).toBe('beta');
    expect(value('\\Recommended', 'InstanceUrl')).toBeNull();
  });

  test('forcing with no server writes nothing and says so', () => {
    const run = spawnSync(harness, ['/S', '/FORCE_INSTANCE=1', '/UPDATE_CHANNEL=beta']);
    expect(run.status).toBe(87);
    expect(reg('query', `HKCU\\${KEY}`).status).toBe(1);
  });

  test('writing one takes the value out of the other', () => {
    spawnSync(harness, ['/INSTANCE_URL=https://a.example', '/UPDATE_CHANNEL=beta']);
    expect(value('\\Recommended', 'InstanceUrl')).toBe('https://a.example');
    spawnSync(harness, ['/INSTANCE_URL=https://b.example', '/FORCE_INSTANCE=1', '/UPDATE_CHANNEL=stable']);
    expect(value('', 'InstanceUrl')).toBe('https://b.example');
    expect(value('\\Recommended', 'InstanceUrl')).toBeNull();
    expect(value('\\Recommended', 'UpdateChannel')).toBeNull();
    spawnSync(harness, ['/INSTANCE_URL=https://c.example']);
    expect(value('', 'InstanceUrl')).toBeNull();
    expect(value('\\Recommended', 'InstanceUrl')).toBe('https://c.example');
  });

  test('quotes inside a value are stripped', () => {
    spawnSync(harness, ['/INSTANCE_URL=https://a.ex"am"ple', '/UPDATE_CHANNEL="be"ta'], { windowsVerbatimArguments: true });
    expect(value('\\Recommended', 'InstanceUrl')).toBe('https://a.example');
  });

  test('it offers the app in Open with, Choose another app and Send to, as the app does at its start', () => {
    mkdirSync(sendTo(), { recursive: true });
    expect(spawnSync(harness, []).status).toBe(0);
    const app = path.join(dir, 'app', 'Bulwark.exe');
    const command = (sub: string) => {
      const answer = reg('query', `HKCU\\${CLASSES}\\${sub}\\shell\\open\\command`, '/ve');
      return /REG_SZ\s+(.*)/.exec(answer.stdout ?? '')?.[1]?.trim() ?? null;
    };
    const wanted = windowsOpenWithRegistration(app);
    expect(command('Bulwark.File.attach')).toBe(`"${app}" -- "%1"`);
    expect(command('Applications\\Bulwark.exe')).toBe(`"${app}" -- "%1"`);
    // The same values the app writes, one by one.
    for (const entry of wanted) {
      const key = `HKCU\\${entry.key.replace(/^Software\\Classes/, CLASSES)}`;
      const answer = entry.name === undefined ? reg('query', key, '/ve') : reg('query', key, '/v', entry.name);
      expect(answer.status, `${key} ${entry.name ?? '(default)'}`).toBe(0);
    }
    expect(existsSync(path.join(sendTo(), 'Bulwark (as attachment).lnk'))).toBe(true);
  });

  test('a forced OpenWithEnabled other than 1 leaves all of it out', () => {
    mkdirSync(sendTo(), { recursive: true });
    reg('add', `HKCU\\${KEY}`, '/v', 'OpenWithEnabled', '/t', 'REG_DWORD', '/d', '0', '/f');
    expect(spawnSync(harness, []).status).toBe(0);
    expect(reg('query', `HKCU\\${CLASSES}`).status).toBe(1);
    expect(existsSync(path.join(sendTo(), 'Bulwark (as attachment).lnk'))).toBe(false);
  });

  test('an update keeps a Send to entry the user deleted deleted', () => {
    mkdirSync(sendTo(), { recursive: true });
    expect(spawnSync(harness, ['--updated']).status).toBe(0);
    expect(reg('query', `HKCU\\${CLASSES}\\Bulwark.File.attach`).status).toBe(0);
    expect(existsSync(path.join(sendTo(), 'Bulwark (as attachment).lnk'))).toBe(false);
  });

  test('without the rights to write it says so with an exit code, and the real target is HKLM', () => {
    // `net session` needs an administrator, so it tells whether this run could write.
    test.skip(spawnSync('net', ['session'], { windowsHide: true }).status === 0, 'elevated: this would write the real key');
    const real = build('real', '');
    const run = spawnSync(real, ['/S', '/INSTANCE_URL=https://mail.example.com']);
    expect(run.status).toBe(5);
    expect(reg('query', 'HKLM\\SOFTWARE\\Policies\\Bulwark').status).toBe(1);
  });
});
