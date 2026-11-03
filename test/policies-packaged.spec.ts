import { spawn, spawnSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { removeProfile, tempProfile } from './helpers';

/**
 * The package, after `npm run pack:dir`: the watcher's addon is in it, and the test root
 * can't be reached, not even by renaming the exe, which is what makes Electron call it
 * unpackaged.
 */
const UNPACKED = path.resolve(import.meta.dirname, '..', 'release', 'win-unpacked');
const EXE = path.join(UNPACKED, 'Bulwark.exe');
const ROOT = 'HKCU\\Software\\BulwarkTest\\Policies\\packaged';

test.describe('the packaged app', () => {
  test.skip(process.platform !== 'win32' || !existsSync(EXE), 'needs npm run pack:dir');

  test.beforeAll(() => {
    spawnSync('reg.exe', ['add', `${ROOT}\\Machine`, '/v', 'InstanceUrl', '/t', 'REG_SZ', '/d', 'nonsense', '/f'], { windowsHide: true });
  });

  test.afterAll(() => {
    spawnSync('reg.exe', ['delete', 'HKCU\\Software\\BulwarkTest', '/f'], { windowsHide: true });
  });

  async function titleWith(exe: string): Promise<string> {
    const profile = tempProfile('packpolicy');
    const env: NodeJS.ProcessEnv = { ...process.env, BULWARK_TEST_POLICY_ROOT: ROOT };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(exe, [`--user-data-dir=${path.join(profile, 'ud')}`, `--bulwark-test-policy-root=${ROOT}`, '--lang=en-US'], { env, stdio: 'ignore' });
    try {
      const title = () =>
        spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue).MainWindowTitle`], { encoding: 'utf8' }).stdout.trim();
      await expect.poll(title, { timeout: 40_000, intervals: [1000] }).toMatch(/\S/);
      // The first-run page sets its title a moment after the window shows.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return title();
    } finally {
      child.kill();
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      await new Promise((resolve) => setTimeout(resolve, 800));
      removeProfile(profile);
    }
  }

  test('ignores the test root and its variable: it shows the first-run page, not the error', async () => {
    expect(await titleWith(EXE)).toMatch(/Welcome to Bulwark|Willkommen bei Bulwark/);
  });

  test('renamed to electron.exe, which turns app.isPackaged off, it still ignores it', async () => {
    const renamed = path.join(UNPACKED, 'electron.exe');
    renameSync(EXE, renamed);
    try {
      expect(await titleWith(renamed)).toMatch(/Welcome to Bulwark|Willkommen bei Bulwark/);
    } finally {
      renameSync(renamed, EXE);
    }
  });

  test('has the watcher\'s addon where a package can load it', () => {
    const addon = path.join(UNPACKED, 'resources', 'app.asar.unpacked', 'node_modules', '@vscode', 'policy-watcher', 'build', 'Release', 'vscode-policy-watcher.node');
    expect(existsSync(addon)).toBe(true);
  });
});
