import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { fakeOsIntegration, prompts, removeProfile, shownPage, waitForLogin } from './helpers';
import {
  FakeGitHub,
  FIXTURES,
  hasMarkOfTheWeb,
  installDir,
  installedExe,
  installedVersion,
  installerRunning,
  installerRunningSoon,
  installFixture,
  killInstalled,
  pendingUpdateFiles,
  removeToastKeys,
  runningFromInstall,
  uninstall,
  uninstallKeys,
  waitUntilGone,
} from './update-helpers';

/**
 * Real installers, a real install under %LOCALAPPDATA%\Programs, and electron-updater's
 * real GitHub provider against a local stand-in. `node scripts/build-update-fixtures.mjs`
 * first. It installs and uninstalls Bulwark on this machine, and refuses to run when
 * Bulwark is here for real.
 */

interface Running {
  app: ElectronApplication;
  page: Page;
  profile: string;
}

const A = '0.9.0';
const B = '0.9.1';
const BETA = '1.0.0-beta.1';

const hasFixtures = [A, B, BETA].every((version) => existsSync(path.join(FIXTURES, version, `Bulwark-Setup-${version}-x64.exe`)));
const roaming = path.join(process.env.APPDATA ?? '', 'Bulwark');
let hadDefaultProfile = false;

async function launch(exe: string, feed: string, ...extra: string[]): Promise<Running> {
  const profile = mkdtempSync(path.join(tmpdir(), 'bw-upd-'));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({ mode: 'standalone' }));
  const app = await electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${profile}`, '--lang=en-US', `--bulwark-test-update-feed=${feed}`, ...extra],
    env,
  });
  await fakeOsIntegration(app);
  const page = await shownPage(app);
  await waitForLogin(page);
  return { app, page, profile };
}

const stateOf = (page: Page) => page.evaluate(() => (window as any).bulwarkDesktop.updates.state());

async function waitForStatus(page: Page, ...statuses: string[]) {
  await expect.poll(async () => (await stateOf(page)).status, { timeout: 120_000, intervals: [250] }).toMatch(new RegExp(`^(${statuses.join('|')})$`));
  return stateOf(page);
}

async function menuItem(app: ElectronApplication, id: string): Promise<boolean> {
  return app.evaluate(({ Menu }, itemId) => Boolean(Menu.getApplicationMenu()?.getMenuItemById(itemId)), id);
}

/** The new files, and the installer gone: it writes the asar long before it's finished. */
async function waitForInstalled(version: string): Promise<void> {
  await expect.poll(installedVersion, { timeout: 300_000, intervals: [1000] }).toBe(version);
  await expect.poll(installerRunning, { timeout: 300_000, intervals: [1000] }).toBe(false);
}

/** The installer started the new version with no arguments, so on the default profile. */
async function clearRelaunchedApp(): Promise<void> {
  await expect.poll(() => runningFromInstall().length, { timeout: 120_000, intervals: [500] }).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // Again each time: a child can outlive the first kill on a busy machine.
  await expect
    .poll(
      () => {
        killInstalled();
        return runningFromInstall().length;
      },
      { timeout: 30_000, intervals: [1000] },
    )
    .toBe(0);
}

test.describe('updates', () => {
  test.describe.configure({ mode: 'serial' });
  // A real install, with a virus scanner reading 450 MB, takes a minute or two by itself.
  test.setTimeout(1_200_000);
  test.skip(process.platform !== 'win32', 'NSIS');
  test.skip(!hasFixtures, 'run node scripts/build-update-fixtures.mjs first');

  const github = new FakeGitHub();
  let feed = '';

  test.beforeAll(async () => {
    if (existsSync(installedExe())) throw new Error('Bulwark is installed on this machine. This test would replace it.');
    hadDefaultProfile = existsSync(roaming);
    if (hadDefaultProfile) throw new Error(`${roaming} exists. This test would start the app on it.`);
    feed = await github.start();
  });

  test.beforeEach(() => {
    github.requests = [];
    github.events = [];
    // A download a failed run left would count as already there.
    rmSync(path.join(process.env.LOCALAPPDATA!, 'bulwark-desktop-updater'), { recursive: true, force: true });
  });

  test.afterEach(async () => {
    uninstall();
    if (existsSync(installedExe())) await waitUntilGone();
    killInstalled();
    removeToastKeys();
    if (!hadDefaultProfile) rmSync(roaming, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
    rmSync(path.join(process.env.LOCALAPPDATA!, 'bulwark-desktop-updater'), { recursive: true, force: true });
  });

  test.afterAll(() => github.stop());

  test('A to B: downloads quietly, saves drafts first, installs, restarts, nothing asked', async () => {
    installFixture(A);
    expect(installedVersion()).toBe(A);
    github.releases = [{ version: B }, { version: A }];
    const { app, page, profile } = await launch(installedExe(), feed);

    const state = await waitForStatus(page, 'ready');
    expect(state.target).toBe(B);
    expect(state.ability).toBe('install');
    expect(github.downloads().some((file) => file.endsWith(`Bulwark-Setup-${B}-x64.exe`))).toBe(true);

    // Quiet: it's in the menu, the notification's been spent, and no dialog came up.
    expect(await menuItem(app, 'update-restart')).toBe(true);
    expect(await menuItem(app, 'update-check')).toBe(false);
    expect(await prompts(app)).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8') || '{}')).toBeTruthy();

    // For the docs on SmartScreen: what the updater fetched has no mark of the web.
    const pending = pendingUpdateFiles().filter((file) => file.endsWith('.exe'));
    expect(pending.length).toBe(1);
    expect(hasMarkOfTheWeb(pending[0])).toBe(false);

    // Still the old version: it waits for the user.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(installedVersion()).toBe(A);

    // A page holding a draft, whose save takes most of the shell's 4 seconds. It says when
    // it's under way and when it's done. An installer started before the quit would be
    // running by then, and in a little while kill the app in the middle of the save.
    const flush: { name: string; installed: string; installer: Promise<boolean> }[] = [];
    await page.exposeFunction('__flushEvent', (name: string) => {
      flush.push({ name, installed: installedVersion(), installer: installerRunningSoon() });
    });
    await page.evaluate(() => {
      const report = (window as any).__flushEvent;
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      (window as any).bulwarkDesktop.lifecycle.onFlushRequest(async () => {
        await wait(300);
        await report('saving');
        await wait(2700);
        await report('saved');
      });
    });
    await page.evaluate(() => (window as any).bulwarkDesktop.updates.restart());

    await waitForInstalled(B);
    await clearRelaunchedApp();
    expect(flush.map((event) => event.name), 'the page finished saving').toEqual(['saving', 'saved']);
    expect(flush[1].installed, 'still the old files when the save ended').toBe(A);
    expect(await flush[0].installer, 'no installer running during the save').toBe(false);
    removeProfile(profile);
  });

  test('a page that chooses to stay calls the restart off, and the update stays ready', async () => {
    installFixture(A);
    github.releases = [{ version: B }, { version: A }];
    const { app, page, profile } = await launch(installedExe(), feed);
    await waitForStatus(page, 'ready');

    // Answers "Stay".
    await fakeOsIntegration(app, 1);
    await page.evaluate(() => {
      (window as any).__stay = (event: BeforeUnloadEvent) => {
        event.preventDefault();
        event.returnValue = '';
      };
      window.addEventListener('beforeunload', (window as any).__stay);
    });
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.evaluate(() => (window as any).bulwarkDesktop.updates.restart());

    await expect.poll(async () => (await prompts(app)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(installedVersion()).toBe(A);
    expect((await stateOf(page)).status).toBe('ready');
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');

    await app.evaluate(({ app: electronApp }) => electronApp.exit(0));
    removeProfile(profile);
  });

  test('stable to beta asks first, then takes the prerelease that stable never sees', async () => {
    installFixture(A);
    // The prerelease is the newest. `/latest` doesn't list it, the feed does.
    github.releases = [{ version: BETA, prerelease: true }, { version: A }];
    const { app, page, profile } = await launch(installedExe(), feed);
    const first = await waitForStatus(page, 'up-to-date');
    expect(first.channel).toBe('stable');
    expect(github.downloads()).toEqual([]);

    // Cancel.
    await fakeOsIntegration(app, 1);
    let after = await page.evaluate(() => (window as any).bulwarkDesktop.updates.setChannel('beta'));
    expect(after.channel).toBe('stable');
    expect((await prompts(app))[0].message).toContain('beta');

    // Yes.
    await fakeOsIntegration(app, 0);
    after = await page.evaluate(() => (window as any).bulwarkDesktop.updates.setChannel('beta'));
    expect(after.channel).toBe('beta');
    const ready = await waitForStatus(page, 'ready');
    expect(ready.target).toBe(BETA);
    expect(github.downloads().some((file) => file.endsWith(`Bulwark-Setup-${BETA}-x64.exe`))).toBe(true);

    await app.evaluate(({ app: electronApp }) => electronApp.exit(0));
    removeProfile(profile);
  });

  test('beta to stable: waits by default, goes back only on a click that says what it means', async () => {
    installFixture(BETA);
    expect(installedVersion()).toBe(BETA);
    github.releases = [{ version: BETA, prerelease: true }, { version: B }];
    const { app, page, profile } = await launch(installedExe(), feed);
    const first = await waitForStatus(page, 'up-to-date');
    expect(first.channel).toBe('beta');

    const offer = await page.evaluate(() => (window as any).bulwarkDesktop.updates.setChannel('stable'));
    expect(offer.status).toBe('older-available');
    expect(offer.target).toBe(B);
    expect(github.downloads()).toEqual([]);
    expect(await prompts(app)).toEqual([]);

    // A restart does nothing yet, and neither does a quit: nothing's been downloaded.
    await page.evaluate(() => (window as any).bulwarkDesktop.updates.restart());
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(installedVersion()).toBe(BETA);

    // Cancel.
    await fakeOsIntegration(app, 1);
    let after = await page.evaluate(() => (window as any).bulwarkDesktop.updates.installOlder());
    expect(after.status).toBe('older-available');
    expect(github.downloads()).toEqual([]);
    const asked = (await prompts(app))[0];
    expect(asked.message).toContain(B);
    expect(asked.detail).toContain(BETA);

    // Yes.
    await fakeOsIntegration(app, 0);
    after = await page.evaluate(() => (window as any).bulwarkDesktop.updates.installOlder());
    expect(['downloading', 'ready']).toContain(after.status);
    await waitForStatus(page, 'ready');
    await page.evaluate(() => (window as any).bulwarkDesktop.updates.restart());
    await waitForInstalled(B);
    await clearRelaunchedApp();
    removeProfile(profile);
  });

  test('a download from the other channel does not install at quit once the user moved away', async () => {
    installFixture(A);
    github.releases = [{ version: BETA, prerelease: true }, { version: A }];
    const { app, page, profile } = await launch(installedExe(), feed);
    await waitForStatus(page, 'up-to-date');
    await page.evaluate(() => (window as any).bulwarkDesktop.updates.setChannel('beta'));
    await waitForStatus(page, 'ready');

    const back = await page.evaluate(() => (window as any).bulwarkDesktop.updates.setChannel('stable'));
    expect(back.channel).toBe('stable');
    expect(back.status).toBe('up-to-date');

    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await expect.poll(() => runningFromInstall().length, { timeout: 30_000, intervals: [500] }).toBe(0);
    for (let i = 0; i < 10; i += 1) {
      expect(installerRunning(), 'no installer started').toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(installedVersion()).toBe(A);
    removeProfile(profile);
  });

  test('a ready update installs at a plain quit too, and the app does not come back', async () => {
    installFixture(A);
    github.releases = [{ version: B }, { version: A }];
    const { app, page, profile } = await launch(installedExe(), feed);
    await waitForStatus(page, 'ready');
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await waitForInstalled(B);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(runningFromInstall()).toEqual([]);
    removeProfile(profile);
  });

  test('AutoUpdate off by policy: not one request, and no way to start one', async () => {
    installFixture(A);
    github.releases = [{ version: B }, { version: A }];
    const { app, page, profile } = await launch(installedExe(), feed, '--bulwark-test-update-policy={"autoUpdate":false}');
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const state = await stateOf(page);
    expect(state.status).toBe('off');
    expect(state.allowed).toBe(false);
    const after = await page.evaluate(() => (window as any).bulwarkDesktop.updates.check());
    expect(after.status).toBe('off');
    expect(github.requests).toEqual([]);
    expect(await menuItem(app, 'update-check')).toBe(false);
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0));
    removeProfile(profile);
  });

  test('UpdateChannel forced by policy: the user cannot change it, and it applies', async () => {
    installFixture(A);
    github.releases = [{ version: BETA, prerelease: true }, { version: A }];
    const { app, page, profile } = await launch(installedExe(), feed, '--bulwark-test-update-policy={"channel":"beta"}');
    const ready = await waitForStatus(page, 'ready');
    expect(ready.channel).toBe('beta');
    expect(ready.channelLocked).toBe(true);
    expect(ready.target).toBe(BETA);
    const after = await page.evaluate(() => (window as any).bulwarkDesktop.updates.setChannel('stable'));
    expect(after.channel).toBe('beta');
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0));
    removeProfile(profile);
  });

  test('a copy with no NSIS uninstaller, as an MSI, only says a version exists', async () => {
    github.releases = [{ version: B }, { version: A }];
    const exe = path.join(FIXTURES, A, 'win-unpacked', 'Bulwark.exe');
    const { app, page, profile } = await launch(exe, feed);
    const state = await waitForStatus(page, 'available');
    expect(state.ability).toBe('notify');
    expect(state.perMachine).toBe(true);
    expect(state.target).toBe(B);
    expect(github.downloads()).toEqual([]);
    expect(await menuItem(app, 'update-download')).toBe(true);
    expect(await menuItem(app, 'update-restart')).toBe(false);
    await page.evaluate(() => (window as any).bulwarkDesktop.updates.restart());
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await page.evaluate(() => document.title)).toBeTruthy();
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0));
    removeProfile(profile);
  });

  test('uninstalling leaves no key and no process, and the mail profile by design', async () => {
    installFixture(A);
    expect(uninstallKeys().length).toBe(1);
    uninstall();
    await waitUntilGone();
    await expect.poll(uninstallKeys, { timeout: 60_000, intervals: [1000] }).toEqual([]);
    expect(runningFromInstall()).toEqual([]);
    // The uninstaller removes its own folder last, with nothing left in it.
    await expect.poll(() => existsSync(installDir()), { timeout: 60_000, intervals: [1000] }).toBe(false);
  });
});
