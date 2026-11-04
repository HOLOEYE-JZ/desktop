import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The NSIS switches, from the real include, compiled by the NSIS electron-builder
 * uses, and run. Only the key differs: writing the real one takes an administrator, so
 * the harness writes under HKCU and the user runs the real one (see the report).
 */

const INCLUDE = path.resolve(import.meta.dirname, '..', 'build', 'installer.nsh');
const CACHE = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
const KEY = `Software\\BulwarkTest\\Policies\\nsis${process.pid}`;

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

  test.beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bw-nsis-'));
    harness = build('harness', `!define BULWARK_POLICY_HIVE "HKCU"\n!define BULWARK_POLICY_KEY "${KEY}"`);
  });

  test.afterAll(() => {
    reg('delete', `HKCU\\${KEY}`, '/f');
    rmSync(dir, { recursive: true, force: true });
  });

  test.afterEach(() => {
    reg('delete', `HKCU\\${KEY}`, '/f');
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

  test('without the rights to write it says so with an exit code, and the real target is HKLM', () => {
    // `net session` needs an administrator, so it tells whether this run could write.
    test.skip(spawnSync('net', ['session'], { windowsHide: true }).status === 0, 'elevated: this would write the real key');
    const real = build('real', '');
    const run = spawnSync(real, ['/S', '/INSTANCE_URL=https://mail.example.com']);
    expect(run.status).toBe(5);
    expect(reg('query', 'HKLM\\SOFTWARE\\Policies\\Bulwark').status).toBe(1);
  });
});
