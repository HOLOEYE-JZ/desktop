import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { addonPins } from '../scripts/addon-pins.mjs';
import { findHelperProblem } from '../scripts/package-guard.mjs';
import { cargoEnv } from '../scripts/build-native.mjs';
import { addonMayLoad, type AddonCheck } from '../src/main/addon-pins';
import { removeProfile, tempProfile } from './helpers';

/** The hashes main.mjs holds for what sits outside ASAR integrity. The last test needs `node scripts/pack-test.mjs`. */

const ROOT = path.resolve(import.meta.dirname, '..');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

test.describe('refusing an addon', () => {
  let dir = '';
  let file = '';
  const check = (over: Partial<AddonCheck> = {}): AddonCheck => ({
    file,
    name: 'native',
    packaged: true,
    platform: 'win32',
    arch: 'x64',
    pins: { 'win32-x64': { native: sha('right') } },
    ...over,
  });

  test.beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bw-pins-'));
    file = path.join(dir, 'a.node');
    writeFileSync(file, 'right');
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('the right file loads, a changed one does not, and says so', () => {
    const said: string[] = [];
    expect(addonMayLoad(check(), (message) => said.push(message))).toBe(true);
    expect(said).toEqual([]);
    writeFileSync(file, 'wrong');
    expect(addonMayLoad(check(), (message) => said.push(message))).toBe(false);
    expect(said[0]).toContain('native');
  });

  test('a file nothing was pinned for does not load: it came after the build', () => {
    const quiet = () => {};
    expect(addonMayLoad(check({ pins: {} }), quiet)).toBe(false);
    expect(addonMayLoad(check({ arch: 'arm64' }), quiet)).toBe(false);
    expect(addonMayLoad(check({ name: 'watcher' }), quiet)).toBe(false);
  });

  test('a missing file is for the loader to report, and development and macOS have no pins', () => {
    expect(addonMayLoad(check({ file: path.join(dir, 'gone.node') }))).toBe(true);
    writeFileSync(file, 'wrong');
    expect(addonMayLoad(check({ packaged: false }))).toBe(true);
    expect(addonMayLoad(check({ platform: 'darwin' }))).toBe(true);
  });
});

test.describe('the pins at build time', () => {
  test('every target built, a release build of the watcher first, and never a Mac', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bw-pins-'));
    const put = (relative: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), text);
    };
    try {
      put('native/dist/win32-x64/bulwark-native.node', 'n-x64');
      put('native/dist/win32-arm64/bulwark-native.node', 'n-arm64');
      put('native/dist/darwin-arm64/bulwark-native.node', 'n-mac');
      put('node_modules/@vscode/policy-watcher/build/Release/vscode-policy-watcher.node', 'installed');
      expect(addonPins(root, { platform: 'win32', arch: 'x64' })).toEqual({
        'win32-x64': { native: sha('n-x64'), watcher: sha('installed') },
        'win32-arm64': { native: sha('n-arm64') },
      });
      put('.native-modules/win32-x64/vscode-policy-watcher.node', 'w-x64');
      put('.native-modules/win32-arm64/vscode-policy-watcher.node', 'w-arm64');
      expect(addonPins(root, { platform: 'win32', arch: 'x64' })).toEqual({
        'win32-x64': { native: sha('n-x64'), watcher: sha('w-x64') },
        'win32-arm64': { native: sha('n-arm64'), watcher: sha('w-arm64') },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test.describe('the build of the helper', () => {
  test('a RUSTFLAGS in the environment cannot drop the flags in native/.cargo/config.toml', () => {
    const env = cargoEnv({ PATH: 'x', RUSTFLAGS: '-C opt-level=0', CARGO_ENCODED_RUSTFLAGS: 'y', CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: 'z', CARGO_BUILD_RUSTFLAGS: 'w' });
    expect(env).toEqual({ PATH: 'x' });
  });

  test('the package has to hold the helper on Windows and macOS', () => {
    expect(findHelperProblem(['native/bulwark-native.node'], 'win32')).toBeNull();
    expect(findHelperProblem(['native/bulwark-native.node'], 'darwin')).toBeNull();
    expect(findHelperProblem(['dist/main.mjs'], 'win32')).toContain('bulwark-native.node');
    expect(findHelperProblem(['dist/main.mjs'], 'darwin')).toContain('bulwark-native.node');
    expect(findHelperProblem(['dist/main.mjs'], 'linux')).toBeNull();
  });
});

test.describe('in a real package', () => {
  const unpacked = path.join(ROOT, 'release', 'win-unpacked');
  const exe = path.join(unpacked, 'Bulwark.exe');
  const addon = path.join(unpacked, 'resources', 'app.asar.unpacked', 'native', 'bulwark-native.node');
  test.skip(process.platform !== 'win32' || !existsSync(exe) || !existsSync(addon), 'needs node scripts/pack-test.mjs, with the helper built');

  /** Windows lets go of a killed process's files a moment later. */
  async function replaceAddon(data: Buffer): Promise<void> {
    await expect
      .poll(
        () => {
          try {
            writeFileSync(addon, data);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBe(true);
  }

  /** What the app said until its server started or `until` shows. A pack's fuses keep Playwright out. */
  async function outputOfARun(until: string): Promise<string> {
    const profile = tempProfile('pins');
    const userData = path.join(profile, 'ud');
    mkdirSync(userData, { recursive: true });
    writeFileSync(path.join(userData, 'shell-state.json'), JSON.stringify({ mode: 'standalone' }));
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(exe, [`--user-data-dir=${userData}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    try {
      const log = path.join(userData, 'logs', 'server.log');
      await expect.poll(() => output.includes(until) || existsSync(log), { timeout: 90_000 }).toBe(true);
      // Features are set up around then.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return output;
    } finally {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      removeProfile(profile);
    }
  }

  test('the helper it was built with loads, and a changed one does not', async () => {
    const original = readFileSync(addon);
    const refused = 'Refusing to load the native addon';
    expect(await outputOfARun(refused), 'the control: its own helper is fine').not.toContain(refused);
    try {
      await replaceAddon(Buffer.concat([original, Buffer.from([0])]));
      expect(await outputOfARun(refused), 'one byte more, and it stays out').toContain(refused);
    } finally {
      await replaceAddon(original);
    }
  });
});
