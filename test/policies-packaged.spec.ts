import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { connect, type AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { generateCertificate } from '../src/main/cert';
import { removeProfile, tempProfile } from './helpers';

/**
 * What a production build refuses, on a package that behaves as one, except that its
 * profile is compiled in, so a run doesn't touch the real one. The control is the same
 * switch on a test build, which takes it.
 *
 *   npm run pack:strict && node build.mjs --test && npx playwright test test/policies-packaged.spec.ts
 */
const ROOT = path.resolve(import.meta.dirname, '..');
const UNPACKED = path.join(ROOT, 'release-strict', 'win-unpacked');
const EXE = path.join(UNPACKED, 'Bulwark.exe');
const PROFILE_FILE = path.join(ROOT, 'release-strict', 'profile.txt');
const POLICY_ROOT = `HKCU\\Software\\BulwarkTest\\Policies\\packaged${process.pid}`;
const electron = createRequire(import.meta.url)('electron') as unknown as string;

test.skip(process.platform !== 'win32' || !existsSync(EXE), 'needs npm run pack:strict');

/** Whatever of this package still runs, under any name: it would hold the profile's lock for the next test. */
function stopPackage(): void {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${UNPACKED}\\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
}

test.afterEach(stopPackage);

const profile = existsSync(PROFILE_FILE) ? readFileSync(PROFILE_FILE, 'utf8').trim() : '';
const HOSTILE_STATE = { mode: 'instance', instanceUrl: 'https://mail.bulwark-test.example/' };

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function killTree(child: ChildProcess): void {
  child.kill();
  if (child.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function prepareProfile(state?: object): void {
  removeProfile(profile);
  mkdirSync(profile, { recursive: true });
  if (state) writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify(state));
}

/** Every process of this name that's this package's, with its command line. Others may be running theirs. */
function commandLines(name: string, folder = UNPACKED): string[] {
  const script = `Get-CimInstance Win32_Process -Filter "Name='${name}'" | Where-Object { $_.CommandLine -like '*${folder}*' } | ForEach-Object { $_.CommandLine }`;
  return spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).stdout.split(/\r?\n/).filter(Boolean);
}

/**
 * The title of this package's visible window. Through the OS's own list: .NET's
 * MainWindowTitle can pick an empty helper window of the process instead.
 */
function windowTitle(baseName: string): string {
  const script = `
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class BulwarkWindows {
  public delegate bool Each(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Each c, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  public static string Title(uint[] ids) {
    string found = "";
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (Array.IndexOf(ids, p) < 0 || !IsWindowVisible(h)) return true;
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString() != "Chrome_WidgetWin_1") return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      if (t.Length > 0) found = t.ToString();
      return found == "";
    }, IntPtr.Zero);
    return found;
  }
}
'@
$ids = [uint32[]]@(Get-Process -Name '${baseName}' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${UNPACKED}*' } | ForEach-Object { $_.Id })
if ($ids.Count -gt 0) { [BulwarkWindows]::Title($ids) }
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { encoding: 'utf8' }).stdout.trim();
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const freePort = () => 20000 + Math.floor(Math.random() * 20000);

/** The strict package. A denied switch makes it restart itself, so this waits for the survivor's window. */
async function runStrict(args: string[], exe = EXE, env: NodeJS.ProcessEnv = {}): Promise<() => Promise<void>> {
  const child = spawn(exe, args, { env: cleanEnv(env), stdio: 'ignore' });
  const baseName = path.basename(exe, '.exe');
  const stop = async () => {
    killTree(child);
    for (const line of spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Name '${baseName}' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${UNPACKED}*' } | ForEach-Object { $_.Id }`], { encoding: 'utf8' }).stdout.split(/\r?\n/).filter(Boolean)) {
      spawnSync('taskkill', ['/F', '/T', '/PID', line], { stdio: 'ignore' });
    }
    await pause(800);
  };
  try {
    await expect.poll(() => windowTitle(baseName), { timeout: 60_000, intervals: [1000] }).toMatch(/\S/);
  } catch (error) {
    // Or it holds the profile and the package's files for everything after it.
    await stop();
    throw error;
  }
  return stop;
}

/** The control: the same switch on a test build. The same code, without the guard. */
async function withControl(args: string[], state: object | undefined, check: (dir: string) => Promise<void>, env: NodeJS.ProcessEnv = {}): Promise<void> {
  const dir = tempProfile('control');
  if (state) writeFileSync(path.join(dir, 'shell-state.json'), JSON.stringify(state));
  const child = spawn(electron, [path.join(ROOT, 'dist', 'main.mjs'), `--bulwark-user-data=${dir}`, ...args], { cwd: ROOT, env: cleanEnv(env), stdio: 'ignore' });
  try {
    await check(dir);
  } finally {
    killTree(child);
    await pause(800);
    removeProfile(dir);
  }
}

test.describe('a production build, with no policy set', () => {
  test.beforeEach(() => prepareProfile());
  test.afterAll(() => removeProfile(profile));

  test('--remote-debugging-port opens nothing (control: a test build does)', async () => {
    const controlPort = freePort();
    await withControl([`--remote-debugging-port=${controlPort}`], undefined, async () => {
      await expect.poll(() => portOpen(controlPort), { timeout: 40_000 }).toBe(true);
    });

    const port = freePort();
    const done = await runStrict([`--remote-debugging-port=${port}`]);
    try {
      expect(await portOpen(port)).toBe(false);
      await pause(2000);
      expect(await portOpen(port)).toBe(false);
    } finally {
      await done();
    }
  });

  // Chromium trims each argument first. The guard has to read them the same way.
  for (const [name, pad] of [['a space', (flag: string) => ` ${flag}`], ['a tab', (flag: string) => `\t${flag}`], ['a trailing space', (flag: string) => `${flag} `]] as const) {
    test(`--remote-debugging-port behind ${name} opens nothing (control: a test build does)`, async () => {
      const controlPort = freePort();
      await withControl([pad(`--remote-debugging-port=${controlPort}`)], undefined, async () => {
        await expect.poll(() => portOpen(controlPort), { timeout: 40_000 }).toBe(true);
      });

      const port = freePort();
      const done = await runStrict([pad(`--remote-debugging-port=${port}`)]);
      try {
        await pause(2000);
        expect(await portOpen(port)).toBe(false);
      } finally {
        await done();
      }
    });
  }

  test('padded switches reach no process', async () => {
    const flags = [' --no-sandbox', '\t--js-flags=--expose-gc', ' --disable-web-security', '--enable-features=BulwarkNoSuchFeature ', ' --proxy-server=127.0.0.1:9', ' --ignore-certificate-errors', ` --user-data-dir=${path.join(ROOT, 'bulwarknosuch')}`];
    const done = await runStrict(flags);
    try {
      const lines = commandLines('Bulwark.exe');
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        for (const flag of ['no-sandbox', 'expose-gc', 'disable-web-security', 'bulwarknosuch', 'proxy-server', 'ignore-certificate-errors']) {
          expect(line.toLowerCase(), line).not.toContain(flag);
        }
      }
    } finally {
      await done();
    }
  });

  test('the environment doesn\'t turn the sandbox off or logging on (control: on a test build it does)', async () => {
    const env = { ELECTRON_DISABLE_SANDBOX: '1', ELECTRON_ENABLE_LOGGING: '1' };
    await withControl([], undefined, async (dir) => {
      await expect.poll(() => commandLines('electron.exe', dir).join('\n'), { timeout: 40_000 }).toContain('--no-sandbox');
    }, env);

    const done = await runStrict([], EXE, env);
    try {
      const lines = commandLines('Bulwark.exe');
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        expect(line, line).not.toContain('--no-sandbox');
        expect(line, line).not.toContain('--enable-logging');
      }
    } finally {
      await done();
    }
  });

  test('--user-data-dir moves nothing', async () => {
    const elsewhere = tempProfile('moved');
    const moved = path.join(elsewhere, 'ud');
    const done = await runStrict([`--user-data-dir=${moved}`]);
    try {
      // Chromium makes the folder before any of our code runs. Nothing lands in it after that.
      await expect.poll(() => readdirSync(profile).length, { timeout: 20_000 }).toBeGreaterThan(0);
      await pause(1500);
      for (const name of ['Local State', 'Network', 'Partitions', 'shell-state.json']) expect(existsSync(path.join(moved, name)), name).toBe(false);
    } finally {
      await done();
      removeProfile(elsewhere);
    }
  });

  test('none of them reaches any process, in any spelling', async () => {
    const flags = ['--no-sandbox', '--js-flags=--expose-gc', '--disable-web-security', '--enable-features=BulwarkNoSuchFeature', '/DISABLE-FEATURES=BulwarkNoSuchOther', '-disable-site-isolation-trials', '--load-extension=C:\\nothing', '--allow-running-insecure-content', '--host-rules=MAP bulwarknosuch.example 127.0.0.1', '--ignore-certificate-errors', '--user-data-dir=C:\bulwarknosuch'];
    const done = await runStrict(flags);
    try {
      const lines = commandLines('Bulwark.exe');
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        for (const flag of ['no-sandbox', 'expose-gc', 'disable-web-security', 'bulwarknosuch', 'disable-site-isolation-trials', 'load-extension', 'allow-running-insecure-content', 'host-rules', 'ignore-certificate-errors']) {
          expect(line.toLowerCase(), line).not.toContain(flag);
        }
      }
    } finally {
      await done();
    }
  });

  test('--ignore-certificate-errors doesn\'t accept a bad certificate (control: it does)', async () => {
    const certificate = generateCertificate('localhost');
    let hits = 0;
    const server = createHttpsServer({ key: certificate.keyPem, cert: certificate.certPem }, (_req, res) => {
      hits += 1;
      res.end('<title>accepted</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const state = { mode: 'instance', instanceUrl: `https://localhost:${(server.address() as AddressInfo).port}/` };
    try {
      await withControl(['--ignore-certificate-errors'], state, async () => {
        await expect.poll(() => hits, { timeout: 40_000 }).toBeGreaterThan(0);
      });

      hits = 0;
      prepareProfile(state);
      const done = await runStrict(['--ignore-certificate-errors']);
      try {
        await pause(3000);
        expect(hits).toBe(0);
      } finally {
        await done();
      }
    } finally {
      server.close();
    }
  });

  test('--proxy-server sees nothing (control: it does)', async () => {
    let connects = 0;
    const proxy: Server = createHttpServer((_req, res) => res.end());
    proxy.on('connect', (_req, socket) => {
      connects += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const flag = `--proxy-server=127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
      await withControl([flag], HOSTILE_STATE, async () => {
        await expect.poll(() => connects, { timeout: 40_000 }).toBeGreaterThan(0);
      });

      connects = 0;
      prepareProfile(HOSTILE_STATE);
      const done = await runStrict([flag]);
      try {
        await pause(3000);
        expect(connects).toBe(0);
      } finally {
        await done();
      }
    } finally {
      proxy.close();
    }
  });
});

test.describe('renamed to electron.exe, which turns app.isPackaged off', () => {
  const renamed = path.join(UNPACKED, 'electron.exe');

  test.beforeAll(() => {
    spawnSync('reg.exe', ['add', `${POLICY_ROOT}\\Machine`, '/v', 'InstanceUrl', '/t', 'REG_SZ', '/d', 'nonsense', '/f'], { windowsHide: true });
    renameSync(EXE, renamed);
    prepareProfile();
  });

  test.afterAll(() => {
    if (existsSync(renamed)) renameSync(renamed, EXE);
    spawnSync('reg.exe', ['delete', POLICY_ROOT, '/f'], { windowsHide: true });
    removeProfile(profile);
  });

  test('the test hooks aren\'t even in the bundle', () => {
    const { extractFile } = createRequire(import.meta.url)('@electron/asar') as { extractFile(archive: string, file: string): Buffer };
    const bundle = extractFile(path.join(UNPACKED, 'resources', 'app.asar'), path.join('dist', 'main.mjs')).toString('utf8');
    expect(bundle).toContain('Ignoring these switches');
    for (const hook of ['BULWARK_TEST_OS_VERIFY', '__bulwarkAppLock', '__bulwarkOs', 'BULWARK_TELEMETRY_ALLOW_PRIVATE', '--bulwark-test-', 'bulwark-test-no-native', 'bulwark-user-data', 'bulwark-server-dir', 'BulwarkTest']) {
      expect(bundle, hook).not.toContain(hook);
    }
  });

  test('the dev switches and the test root do nothing', async () => {
    stopPackage();
    prepareProfile();
    const elsewhere = tempProfile('moved');
    const moved = path.join(elsewhere, 'ud');
    const done = await runStrict([`--bulwark-user-data=${moved}`, `--bulwark-server-dir=${elsewhere}`, '--dev', `--bulwark-test-policy-root=${POLICY_ROOT}`, '--lang=en-US'], renamed);
    try {
      expect(existsSync(moved)).toBe(false);
      await expect.poll(() => readdirSync(profile).length, { timeout: 20_000 }).toBeGreaterThan(0);
      // The first-run page, not the error page the test root's bad value would give.
      await expect.poll(() => windowTitle('electron'), { timeout: 20_000, intervals: [1000] }).toMatch(/Welcome to Bulwark|Willkommen bei Bulwark/);
    } finally {
      await done();
      removeProfile(elsewhere);
    }
  });
});

test('the package\'s watcher really loads', async () => {
  prepareProfile();
  const addon = path.join(UNPACKED, 'resources', 'app.asar.unpacked', 'node_modules', '@vscode', 'policy-watcher', 'build', 'Release', 'vscode-policy-watcher.node');
  expect(existsSync(addon)).toBe(true);
  const child = spawn(EXE, ['--lang=en-US'], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => (output += String(chunk)));
  child.stderr.on('data', (chunk) => (output += String(chunk)));
  try {
    await expect.poll(() => windowTitle('Bulwark'), { timeout: 60_000, intervals: [1000] }).toMatch(/\S/);
    expect(output).not.toContain('policy watcher is not available');
  } finally {
    killTree(child);
    await pause(800);
    removeProfile(profile);
  }
});
