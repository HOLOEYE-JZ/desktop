import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchStandalone, removeOsTraces, removeProfile, shownPage, tempProfile, type Launched } from './helpers';

/**
 * A click on a toast is a protocol launch on Windows: a second instance with the signed URL
 * off the toast, handed to the running app. Whatever state its window is in, it comes up.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'dist', 'main.mjs');
const SECRET = 'toast-click-key';

function toastUrl(action: string, context: string): string {
  const signature = createHmac('sha256', SECRET).update(`${action}\n${context}`).digest('base64url');
  return `bulwark://toast/${action}?c=${encodeURIComponent(context)}&s=${signature}`;
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** What Windows does on the click: start the app again with the URL. Done when that process has handed it over. */
function clickToast(profile: string, url: string): Promise<void> {
  const require = createRequire(import.meta.url);
  return new Promise((resolve) => {
    spawn(require('electron') as unknown as string, [MAIN, `--bulwark-user-data=${profile}`, '--', url], { env: cleanEnv(), stdio: 'ignore' }).once('exit', () => resolve());
  });
}

/** No toast reaches the screen: closing to the tray says so with one. No link reaches a browser. */
async function quiet(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification, shell }) => {
    Notification.prototype.show = function show() {};
    shell.openExternal = async () => {};
  });
}

const mainState = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    return main ? { visible: main.isVisible(), minimized: main.isMinimized(), focused: main.isFocused() } : null;
  });

async function listen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __cmds: unknown[]; bulwarkDesktop: { os: { onCommand: (l: (c: unknown) => void) => void } } };
    w.__cmds = [];
    w.bulwarkDesktop.os.onCommand((command) => w.__cmds.push(command));
  });
  // Main counts the app as locked until the page says otherwise, and then only the lock screen opens.
  await page.evaluate('window.bulwarkDesktop.os.setLocked(false)');
}

const commands = (page: Page) => page.evaluate(() => (window as unknown as { __cmds: unknown[] }).__cmds);

test.describe('a click on a toast brings the window up', () => {
  test.skip(process.platform !== 'win32', 'protocol activation is how Windows hands over a toast click');
  let profile: string;
  let running: Launched | null = null;

  test.beforeEach(() => {
    profile = tempProfile('toast');
    writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({ mode: 'standalone', osToastSecret: SECRET }));
  });

  test.afterEach(async () => {
    await running?.app.close().catch(() => {});
    running = null;
    removeProfile(profile);
    removeOsTraces();
  });

  for (const state of ['hidden in the tray', 'minimised'] as const) {
    test(`from ${state}, and the page gets the message to open`, async () => {
      running = await launchStandalone(profile);
      const { app, page } = running;
      await quiet(app);
      await listen(page);
      await app.evaluate(({ BrowserWindow }, how) => {
        const main = BrowserWindow.getAllWindows()[0];
        if (how === 'minimised') main.minimize();
        // The window's own close, as its X does: with close to tray on (the default) it hides.
        else main.close();
      }, state);
      await expect.poll(async () => (await mainState(app))?.visible).toBe(false);

      const context = JSON.stringify({ emailId: 'e1', accountId: 'a1' });
      await clickToast(profile, toastUrl('open', context));
      await expect.poll(() => mainState(app)).toEqual({ visible: true, minimized: false, focused: true });
      await expect.poll(() => commands(page)).toEqual([{ type: 'notification', action: 'open', context }]);
    });
  }

  test('while the app is still starting in the tray, and stays up', async () => {
    // Started at login with "start in the tray" on, and a toast from before clicked in the
    // Action Center while the app's server is still coming up: before, nothing showed.
    writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({ mode: 'standalone', osToastSecret: SECRET, os: { startMinimized: true } }));
    const gate = path.join(profile, 'boot-gate');
    const app = await _electron.launch({
      args: ['-r', path.join(ROOT, 'test', 'support', 'hold-boot.cjs'), MAIN, `--bulwark-user-data=${profile}`, '--lang=en-US', '--bulwark-no-spare', '--standalone', '--bulwark-from-login'],
      cwd: ROOT,
      env: { ...cleanEnv(), BULWARK_TEST_BOOT_GATE: gate },
    });
    running = { app, page: null as unknown as Page };
    await quiet(app);
    await expect.poll(() => app.evaluate(({ app: electronApp }) => electronApp.listenerCount('second-instance')), { timeout: 30_000 }).toBeGreaterThan(0);
    await clickToast(profile, toastUrl('open', '{}'));
    writeFileSync(gate, '');
    running = { app, page: await shownPage(app) };
    // Past the show fallback: nothing hides it again.
    await new Promise((resolve) => setTimeout(resolve, 7000));
    expect((await mainState(app))?.visible).toBe(true);
  });

  test("a toast's Archive while the app is starting in the tray leaves it there", async () => {
    // The other side of the above: a button that needs the page, not the window.
    writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({ mode: 'standalone', osToastSecret: SECRET, os: { startMinimized: true } }));
    const gate = path.join(profile, 'boot-gate');
    const app = await _electron.launch({
      args: ['-r', path.join(ROOT, 'test', 'support', 'hold-boot.cjs'), MAIN, `--bulwark-user-data=${profile}`, '--lang=en-US', '--bulwark-no-spare', '--standalone', '--bulwark-from-login'],
      cwd: ROOT,
      env: { ...cleanEnv(), BULWARK_TEST_BOOT_GATE: gate },
    });
    running = { app, page: null as unknown as Page };
    await quiet(app);
    await expect.poll(() => app.evaluate(({ app: electronApp }) => electronApp.listenerCount('second-instance')), { timeout: 30_000 }).toBeGreaterThan(0);
    await clickToast(profile, toastUrl('archive', '{}'));
    writeFileSync(gate, '');
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      return !!main && !main.webContents.isLoading() && main.webContents.getURL().startsWith('https://');
    }), { timeout: 120_000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 7000));
    expect((await mainState(app))?.visible).toBe(false);
  });
});
