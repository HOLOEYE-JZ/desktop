import { spawnSync } from 'node:child_process';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, removeProfile, shownPage, tempProfile } from './helpers';

/**
 * AutoUpdate and UpdateChannel from the registry to the updater, through the real policy
 * reader on its stand-in root. A test build, not packaged: the root only works there.
 * What the updater then does with them is in updater.spec.ts, on real installers.
 */

const BASE = 'HKCU\\Software\\BulwarkTest';
const ROOT = `${BASE}\\Policies\\updater-policy`;
const ARGS = [`--bulwark-test-policy-root=${ROOT}`, '--bulwark-test-policy-poll=250', '--standalone'];

function setValue(where: string, name: string, type: 'REG_DWORD' | 'REG_SZ', value: string): void {
  const done = spawnSync('reg.exe', ['add', `${ROOT}\\${where}`, '/v', name, '/t', type, '/d', value, '/f'], { windowsHide: true });
  if (done.status !== 0) throw new Error('could not write the stand-in policy');
}

function removeValue(where: string, name: string): void {
  spawnSync('reg.exe', ['delete', `${ROOT}\\${where}`, '/v', name, '/f'], { windowsHide: true });
}

const stateOf = (page: Page) => page.evaluate(() => (window as any).bulwarkDesktop.updates.state());

test.describe('update policies through the real reader', () => {
  test.skip(process.platform !== 'win32', 'the stand-in root is in the registry');

  let app: ElectronApplication;
  let page: Page;
  let profile: string;

  async function start(): Promise<void> {
    profile = tempProfile('updpol');
    app = await launch(profile, ...ARGS);
    page = await shownPage(app);
  }

  test.afterEach(async () => {
    await app?.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    if (profile) removeProfile(profile);
    spawnSync('reg.exe', ['delete', BASE, '/f'], { windowsHide: true });
  });

  test('nothing set: no policy, and the schema\'s default locks nothing', async () => {
    await start();
    const state = await stateOf(page);
    expect(state.allowed).toBe(true);
    expect(state.channelLocked).toBe(false);
    expect(state.status).not.toBe('off');
  });

  test('AutoUpdate=0 turns updates off, and taking it away turns them on, live', async () => {
    setValue('Machine', 'AutoUpdate', 'REG_DWORD', '0');
    await start();
    const off = await stateOf(page);
    expect(off.allowed).toBe(false);
    expect(off.status).toBe('off');

    removeValue('Machine', 'AutoUpdate');
    await expect.poll(async () => (await stateOf(page)).allowed, { timeout: 15_000 }).toBe(true);

    setValue('User', 'AutoUpdate', 'REG_DWORD', '0');
    await expect.poll(async () => (await stateOf(page)).allowed, { timeout: 15_000 }).toBe(false);
  });

  test('a forced channel applies and locks, and the user cannot change it', async () => {
    setValue('Machine', 'UpdateChannel', 'REG_SZ', 'beta');
    await start();
    const state = await stateOf(page);
    expect(state.channel).toBe('beta');
    expect(state.channelLocked).toBe(true);
    const after = await page.evaluate(() => (window as any).bulwarkDesktop.updates.setChannel('stable'));
    expect(after.channel).toBe('beta');
  });

  test('a recommended channel is a default the user can change', async () => {
    setValue('Machine\\Recommended', 'UpdateChannel', 'REG_SZ', 'beta');
    await start();
    const state = await stateOf(page);
    expect(state.channel).toBe('beta');
    expect(state.channelLocked).toBe(false);
    const after = await page.evaluate(() => (window as any).bulwarkDesktop.updates.setChannel('stable'));
    expect(after.channel).toBe('stable');
  });
});
