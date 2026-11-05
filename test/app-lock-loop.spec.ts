import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT, fakeOsIntegration, launch, launchStandalone, removeOsTraces, removeProfile, requireAccount, shownPage, signIn, STALWARTS, tempProfile } from './helpers';

/**
 * The app lock end to end, as a user meets it: a PIN set in settings, "Lock now" from the menu,
 * the idle timeout, the PIN or Windows Hello on the lock screen, with one window and with more,
 * and after a restart. After every unlock the app has to stay open: a lock that came straight
 * back locked people out of the app for good. Needs a webmail build in ./webmail (or
 * BULWARK_TEST_WEBMAIL) and a test account:
 *
 *   IT_ENT_PASSWORD=<password> npx playwright test test/app-lock-loop.spec.ts
 *
 * BULWARK_TEST_WEBMAIL_AFTER: the restart runs that build instead, as an update over a profile
 * an older build locked. With BULWARK_TEST_LOCK_LOOP=1 the first unlock is expected to lock
 * again (a build with the loop), and the rest of the file checks the way back in.
 */

const PIN = 'loop-test-pin-4821';
const server = STALWARTS.find((s) => s.label === (process.env.BULWARK_TEST_SERVER_LABEL ?? '1.0')) ?? STALWARTS[0];
/** Long enough for anything an unlock sets off to come back round and lock again. */
const STAYS_OPEN_MS = 12_000;
const OLD_BUILD_LOOPS = process.env.BULWARK_TEST_LOCK_LOOP === '1';

test.describe.configure({ mode: 'serial' });
test.setTimeout(600_000);

type GateLog = { at: number; locked: boolean }[];
type Target = 'main' | 'other';

/** Every change of main's gate, with the time, and what any page says about the lock. */
async function watch(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, webContents }) => {
    const g = globalThis as unknown as { __gateLog?: GateLog; __lockSays?: string[]; __bulwarkAppLock: { gate: { on(event: string, listener: (locked: boolean) => void): void } } };
    if (g.__gateLog) return;
    g.__gateLog = [];
    g.__lockSays = [];
    g.__bulwarkAppLock.gate.on('locked', (locked) => g.__gateLog!.push({ at: Date.now(), locked }));
    const hook = (contents: Electron.WebContents) => {
      contents.on('console-message', (event) => {
        const { message } = event as unknown as { message: string };
        if (message.includes('[app-lock]')) g.__lockSays!.push(message);
      });
    };
    for (const contents of webContents.getAllWebContents()) hook(contents);
    electronApp.on('web-contents-created', (_event, contents) => hook(contents));
  });
}

function gateLog(app: ElectronApplication): Promise<GateLog> {
  return app.evaluate(() => (globalThis as unknown as { __gateLog: GateLog }).__gateLog);
}

function lockSays(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __lockSays: string[] }).__lockSays);
}

function gateLocked(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { gate: { locked: boolean } } }).__bulwarkAppLock.gate.locked);
}

/**
 * Runs in a window's current page. Locking moves a window to a new renderer process, which
 * Playwright doesn't follow, so pages are reached through main. "main" is the first window that
 * isn't a pop-out, "other" any other shown window.
 */
function inWindow<T>(app: ElectronApplication, which: Target, code: string): Promise<T | null> {
  return app.evaluate(({ BrowserWindow }, { js, pick }) => {
    const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible()).sort((a, b) => a.id - b.id);
    const main = all.find((w) => !/\/popout\//.test(w.webContents.getURL()));
    const target = pick === 'main' ? main : all.find((w) => w !== main);
    return target ? target.webContents.executeJavaScript(js) : null;
  }, { js: code, pick: which }).catch(() => null) as Promise<T | null>;
}

const lockScreenShown = (app: ElectronApplication, which: Target = 'main') =>
  inWindow<boolean>(app, which, `!!document.querySelector('[data-app-lock-overlay]')`).then(Boolean);

const pinFieldShown = (app: ElectronApplication) =>
  inWindow<boolean>(app, 'main', `!!document.querySelector('[data-testid="app-lock-pin"]')`).then(Boolean);

const appShown = (app: ElectronApplication, which: Target = 'main') =>
  inWindow<boolean>(app, which, `!document.querySelector('[data-app-lock-overlay]') && !document.documentElement.hasAttribute('data-app-locked') && document.readyState === 'complete'`).then(Boolean);

function click(app: ElectronApplication, testId: string): Promise<unknown> {
  return inWindow(app, 'main', `(() => { const el = document.querySelector('[data-testid="${testId}"]'); if (!el) return false; el.click(); return true; })()`);
}

async function typePin(app: ElectronApplication, pin = PIN): Promise<void> {
  await expect.poll(() => pinFieldShown(app), { timeout: 60_000 }).toBe(true).catch(async (error: unknown) => {
    const windows = await app.evaluate(({ BrowserWindow }) => Promise.all(BrowserWindow.getAllWindows().map(async (w) => `${w.id} ${w.isVisible()} ${w.webContents.getURL()} ${await w.webContents.executeJavaScript('document.body.innerText.slice(0, 200)').catch(() => '?')}`)));
    const said = await app.evaluate(() => (globalThis as unknown as { __lockSays: string[] }).__lockSays);
    throw new Error(`no PIN field: ${windows.join(' || ')} :: ${said.slice(-80).join(String.fromCharCode(10))}`, { cause: error });
  });
  await inWindow(app, 'main', `(() => {
    const input = document.querySelector('[data-testid="app-lock-pin"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(pin)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => document.querySelector('[data-testid="app-lock-unlock"]').click(), 50);
    return true;
  })()`);
}

/** Unlocked, and still unlocked a while later in every window: nothing locked it again behind the user's back. */
async function expectStaysOpen(app: ElectronApplication, windows: Target[] = ['main']): Promise<void> {
  for (const which of windows) await expect.poll(() => appShown(app, which), { timeout: 60_000 }).toBe(true);
  const since = Date.now();
  const saidBefore = (await lockSays(app)).length;
  await new Promise((resolve) => setTimeout(resolve, STAYS_OPEN_MS));
  const relocks = (await gateLog(app)).filter((entry) => entry.at >= since && entry.locked);
  expect(relocks, 'main locked again after the unlock').toEqual([]);
  expect(await gateLocked(app)).toBe(false);
  for (const which of windows) expect(await appShown(app, which), `${which} window open`).toBe(true);
  expect((await lockSays(app)).slice(saidBefore), 'no page tried to lock again').toEqual([]);
}

/** The loop of a build that has it: open for a moment, then locked again on its own. */
async function expectLocksAgain(app: ElectronApplication): Promise<void> {
  const since = Date.now();
  await expect.poll(async () => (await gateLog(app)).filter((entry) => entry.at >= since && entry.locked).length, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(() => pinFieldShown(app), { timeout: 60_000 }).toBe(true);
}

async function lockFromMenu(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('file.lockNow');
    if (!item) throw new Error('no Lock now in the menu');
    item.click();
  });
  await expect.poll(() => lockScreenShown(app), { timeout: 60_000 }).toBe(true);
  expect(await gateLocked(app)).toBe(true);
}

async function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible()).length);
}

async function relaunch(): Promise<void> {
  await app.close();
  if (process.env.BULWARK_TEST_WEBMAIL_AFTER) process.env.BULWARK_TEST_WEBMAIL = process.env.BULWARK_TEST_WEBMAIL_AFTER;
  app = await launch(profile, '--standalone');
  await shownPage(app);
  await fakeOsIntegration(app);
  await watch(app);
}

let profile: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  requireAccount();
  // Made-up Hello key credentials: no real prompt comes up anywhere. Off until settings turn it on.
  process.env.BULWARK_TEST_HELLO_KEY = 'yes';
  profile = tempProfile('lock-loop');
  ({ app, page } = await launchStandalone(profile));
  await fakeOsIntegration(app);
  await watch(app);
  await signIn(page, server.url, ACCOUNT);
});

test.afterAll(async () => {
  delete process.env.BULWARK_TEST_HELLO_KEY;
  await app?.close().catch(() => undefined);
  if (profile) removeProfile(profile);
  removeOsTraces();
});

test('a PIN set in settings, "Lock now" from the menu, the PIN: open, and it stays open', async () => {
  await page.goto(`${new URL(page.url()).origin}/settings/general`);
  const toggle = page.getByTestId('app-lock-switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 60_000 });
  await toggle.click();
  await page.getByTestId('app-lock-new-pin').fill(PIN);
  await page.getByTestId('app-lock-repeat-pin').fill(PIN);
  await page.getByTestId('app-lock-dialog-save').click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
  // No reload from here: the key lives in this document, and a new one starts locked.
  await expect.poll(() => appShown(app), { timeout: 60_000 }).toBe(true);

  await lockFromMenu(app);
  await typePin(app);
  if (OLD_BUILD_LOOPS) {
    await expectLocksAgain(app);
    return;
  }
  await expectStaysOpen(app);

  // And round again, the way the user tried it.
  await lockFromMenu(app);
  await typePin(app);
  await expectStaysOpen(app);
});

test('with a second window, then a message window: locked together, one PIN opens both, and they stay open', async () => {
  test.skip(OLD_BUILD_LOOPS, 'the build loops');
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('file.newWindow')?.click());
  await expect.poll(() => windowCount(app), { timeout: 60_000 }).toBe(2);
  await expect.poll(() => appShown(app, 'other'), { timeout: 60_000 }).toBe(true);

  await lockFromMenu(app);
  await expect.poll(() => lockScreenShown(app, 'other'), { timeout: 60_000 }).toBe(true);
  await typePin(app);
  await expectStaysOpen(app, ['main', 'other']);

  // A message window is a pop-out: locked, it sends people to the main window. (An empty
  // composer would close at the lock instead.)
  await app.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id);
    all.at(-1)?.close();
  });
  await expect.poll(() => windowCount(app), { timeout: 30_000 }).toBe(1);
  await inWindow(app, 'main', `void window.open('/en/popout/message/lock-loop-probe', 'bulwark-message-lock-loop-probe'); true`);
  await expect.poll(() => windowCount(app), { timeout: 60_000 }).toBe(2);
  await expect.poll(() => appShown(app, 'other'), { timeout: 60_000 }).toBe(true);
  await lockFromMenu(app);
  await expect.poll(() => lockScreenShown(app, 'other'), { timeout: 60_000 }).toBe(true);
  await typePin(app);
  await expectStaysOpen(app, ['main', 'other']);
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (/\/popout\//.test(w.webContents.getURL())) w.destroy();
  });
});

test('locked by the idle timeout: the PIN opens it, and it stays open', async () => {
  test.skip(OLD_BUILD_LOOPS, 'the build loops');
  await inWindow(app, 'main', `(() => { const s = document.querySelector('[data-testid="app-lock-timeout"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, '1'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  expect(await inWindow<string>(app, 'main', `JSON.parse(localStorage.getItem('bulwark-app-lock')).timeoutMinutes`)).toBe(1);
  // A minute with nobody at the keyboard. The check runs every 10 s.
  await expect.poll(() => lockScreenShown(app), { timeout: 120_000, intervals: [5_000] }).toBe(true);
  await typePin(app);
  await expectStaysOpen(app);
  await inWindow(app, 'main', `(() => { const s = document.querySelector('[data-testid="app-lock-timeout"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, '10'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
});

test('Windows Hello (a made-up key): it opens and stays open; cancelled, the PIN does', async () => {
  test.skip(OLD_BUILD_LOOPS, 'the build loops');
  await expect.poll(() => inWindow<boolean>(app, 'main', `!!document.querySelector('[data-testid="app-lock-hello-switch"]')`), { timeout: 60_000 }).toBe(true);
  await click(app, 'app-lock-hello-switch');
  await expect.poll(() => inWindow<boolean>(app, 'main', `!!document.querySelector('[data-testid="app-lock-current-pin"]')`), { timeout: 30_000 }).toBe(true);
  await inWindow(app, 'main', `(() => {
    const input = document.querySelector('[data-testid="app-lock-current-pin"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(PIN)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => document.querySelector('[data-testid="app-lock-dialog-save"]').click(), 50);
    return true;
  })()`);
  await expect.poll(() => inWindow<string | null>(app, 'main', `document.querySelector('[data-testid="app-lock-hello-switch"]')?.getAttribute('aria-checked')`), { timeout: 30_000 }).toBe('true');

  // The lock screen asks Hello itself once the window has the focus.
  await lockFromMenu(app);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
  await expectStaysOpen(app);

  // Hello cancelled: the PIN field, and the PIN opens it for good.
  await app.evaluate(() => { process.env.BULWARK_TEST_HELLO_KEY = 'cancel'; });
  await lockFromMenu(app);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
  await typePin(app);
  await expectStaysOpen(app);
  await app.evaluate(() => { process.env.BULWARK_TEST_HELLO_KEY = 'yes'; });
});

test('after a restart: locked at the start, the PIN opens it, and it stays open', async () => {
  await relaunch();
  await expect.poll(() => lockScreenShown(app), { timeout: 90_000 }).toBe(true);
  // Hello's made-up key went with the last run: the lock screen falls back to the PIN.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
  await typePin(app);
  if (OLD_BUILD_LOOPS && !process.env.BULWARK_TEST_WEBMAIL_AFTER) {
    await expectLocksAgain(app);
    return;
  }
  await expectStaysOpen(app);
});

test('"Forgot your PIN?" is the way out: local data goes, the account signs out, the lock is gone', async () => {
  await lockFromMenu(app).catch(async () => {
    // A build that loops is on its lock screen already.
    await expect.poll(() => lockScreenShown(app), { timeout: 60_000 }).toBe(true);
  });
  await expect.poll(() => click(app, 'app-lock-forgot'), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => inWindow<boolean>(app, 'main', `!!document.querySelector('[data-testid="app-lock-forget"] button')`), { timeout: 30_000 }).toBe(true);
  await inWindow(app, 'main', `document.querySelector('[data-testid="app-lock-forget"] button').click()`);
  await expect.poll(() => gateLocked(app), { timeout: 60_000 }).toBe(false);
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { gate: { enrolled: boolean } } }).__bulwarkAppLock.gate.enrolled), { timeout: 60_000 }).toBe(false);
  await expect.poll(() => inWindow<string>(app, 'main', 'location.pathname'), { timeout: 60_000 }).toMatch(/login/);
  expect(await lockScreenShown(app)).toBe(false);
  // The forgetting page's renderer was replaced at the lock: the sign-in page is reached through main.
  await expect.poll(() => inWindow<boolean>(app, 'main', `!!document.querySelector('#username')`), { timeout: 90_000 }).toBe(true);
});
