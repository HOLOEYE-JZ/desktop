// The developer tools switch on the real app: off by default, a click and a native warning to
// turn on, the keys and the View menu item then, the app lock and the policy turning them off.
import { spawnSync } from 'node:child_process';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, removeProfile, shownPage, tempProfile, waitForLogin } from './helpers';

let run = 0;

function reg(...args: string[]): void {
  spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
}

async function start(options: { policy?: Record<string, number> } = {}): Promise<{ app: ElectronApplication; page: Page; stop: () => Promise<void> }> {
  run += 1;
  const policyRoot = `HKCU\\Software\\BulwarkTest\\Policies\\dev-tools-${process.pid}-${run}`;
  for (const [name, value] of Object.entries(options.policy ?? {})) reg('add', `${policyRoot}\\Machine`, '/v', name, '/t', 'REG_DWORD', '/d', String(value), '/f');
  const profile = tempProfile('dt');
  const app = await launch(profile, '--standalone', `--bulwark-test-policy-root=${policyRoot}`);
  const page = await shownPage(app);
  await waitForLogin(page);
  return {
    app, page,
    stop: async () => {
      await app.close().catch(() => {});
      reg('delete', policyRoot, '/f');
      removeProfile(profile);
    },
  };
}

test.afterAll(() => {
  // The parents this file made, if nothing else is in them.
  for (const parent of ['HKCU\\Software\\BulwarkTest\\Policies', 'HKCU\\Software\\BulwarkTest']) {
    const answer = spawnSync('reg.exe', ['query', parent], { encoding: 'utf8', windowsHide: true });
    if (answer.status === 0 && (answer.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length <= 1) reg('delete', parent, '/f');
  }
});

test.describe('developer tools', () => {
  const opened = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).some((w) => w.webContents.isDevToolsOpened()));
  const state = (page: Page) => page.evaluate(() => (window as unknown as { bulwarkDesktop: { devTools: { get: () => Promise<unknown> } } }).bulwarkDesktop.devTools.get());
  const setOn = (page: Page) => page.evaluate(() => (window as unknown as { bulwarkDesktop: { devTools: { set: (on: boolean) => Promise<unknown> } } }).bulwarkDesktop.devTools.set(true));
  const menuItem = (app: ElectronApplication) => app.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.getMenuItemById('view.toggleDevTools'));
  /** As the keyboard sends it: Playwright's keys go in past before-input-event, where real ones don't. */
  const press = (app: ElectronApplication, keyCode: string, modifiers: ('control' | 'shift')[] = []) => app.evaluate(async ({ BrowserWindow }, key) => {
    const contents = BrowserWindow.getAllWindows().find((w) => w.isVisible())!.webContents;
    contents.sendInputEvent({ type: 'keyDown', keyCode: key.keyCode, modifiers: key.modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode: key.keyCode, modifiers: key.modifiers });
    await new Promise((resolve) => setTimeout(resolve, 300));
  }, { keyCode, modifiers });

  /** The native warning is recorded and answered: nobody could click it on a test's desktop. */
  async function answerWarning(app: ElectronApplication, response: number): Promise<void> {
    await app.evaluate(({ dialog }, answer) => {
      const g = globalThis as unknown as { __warnings: string[] };
      g.__warnings = [];
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.find((arg) => !!arg && typeof arg === 'object' && 'message' in (arg as object)) as { message: string; detail: string };
        g.__warnings.push(`${options.message}\n${options.detail}`);
        return { response: answer, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    }, response);
  }
  const warnings = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __warnings: string[] }).__warnings);

  test('off at first; on only after a real click and a yes to the warning; the keys then open them', async () => {
    const started = await start();
    const { app, page } = started;
    try {
      expect(await state(page)).toEqual({ on: false, forcedOff: false, locked: false });
      await press(app, 'I', ['control', 'shift']);
      await press(app, 'F12');
      expect(await opened(app)).toBe(false);
      expect(await menuItem(app)).toBe(false);

      await answerWarning(app, 0);
      // A page's own script, or a plugin's: no click, no change, no question.
      expect(await setOn(page)).toMatchObject({ on: false });
      expect(await warnings(app)).toEqual([]);

      // A cancel leaves it off.
      await answerWarning(app, 1);
      await page.mouse.click(200, 400);
      expect(await setOn(page)).toMatchObject({ on: false });
      expect((await warnings(app))[0]).toContain('passwords');

      await answerWarning(app, 0);
      await page.mouse.click(200, 400);
      expect(await setOn(page)).toEqual({ on: true, forcedOff: false, locked: false });
      expect(await menuItem(app)).toBe(true);

      await press(app, 'I', ['control', 'shift']);
      await expect.poll(() => opened(app)).toBe(true);
      // The same keys close them again; F12 opens them as well.
      await press(app, 'I', ['control', 'shift']);
      await expect.poll(() => opened(app)).toBe(false);
      await press(app, 'F12');
      await expect.poll(() => opened(app)).toBe(true);

      // The app lock turns them off and closes them; while locked nothing turns them back on.
      await app.evaluate(({ BrowserWindow, ipcMain }) => {
        const contents = BrowserWindow.getAllWindows().find((w) => w.isVisible())!.webContents;
        ipcMain.emit('bulwark:appLock.lock', { sender: contents, senderFrame: contents.mainFrame });
      });
      await expect.poll(() => opened(app)).toBe(false);
      expect(await state(page)).toEqual({ on: false, forcedOff: false, locked: true });
      await page.mouse.click(200, 400);
      expect(await setOn(page)).toMatchObject({ on: false, locked: true });
    } finally {
      await started.stop();
    }
  });

  test('DeveloperToolsAvailability 2 locks them off, keys and all', async () => {
    const started = await start({ policy: { DeveloperToolsAvailability: 2 } });
    const { app, page } = started;
    try {
      await answerWarning(app, 0);
      expect(await state(page)).toEqual({ on: false, forcedOff: true, locked: false });
      await page.mouse.click(200, 400);
      expect(await setOn(page)).toMatchObject({ on: false, forcedOff: true });
      expect(await warnings(app)).toEqual([]);
      await press(app, 'F12');
      // Not even main can open them in a window made under the policy.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())!.webContents.openDevTools());
      await page.waitForTimeout(1000);
      expect(await opened(app)).toBe(false);
    } finally {
      await started.stop();
    }
  });
});
