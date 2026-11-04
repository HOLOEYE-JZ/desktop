import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchStandalone, removeOsTraces, removeProfile, tempProfile, type Launched } from './helpers';
import { clickMenuItem, menuItem } from './native-helpers';

/**
 * The real app, on its login page, with the page's lock and sign-in played from here.
 * Windows can't be sent a real key press on a test desktop, so the shortcut's handler is
 * called below the OS: the very function the app gave globalShortcut.register. Keys here
 * are ones nobody uses, so a run takes nothing from whoever is at this computer.
 * Run with BULWARK_TEST_WEBMAIL=<a webmail build of this branch>.
 */

const KEY = 'CommandOrControl+Alt+Shift+F9';
const OTHER_KEY = 'CommandOrControl+Alt+Shift+F8';
const DEFAULT_ARG = `--bulwark-test-quick-compose-default=${KEY}`;
const POLICY_BASE = 'HKCU\\Software\\BulwarkTest';
const POLICY_ROOT = `${POLICY_BASE}\\Policies\\quick${process.pid}`;
const ROOT = path.resolve(import.meta.dirname, '..');

interface Status { shortcut: string | null; active: boolean; locked: boolean }
interface Seen { id: number; visible: boolean; focused: boolean; width: number; height: number }

const isHeld = (app: ElectronApplication, key: string) => app.evaluate(({ globalShortcut }, k) => globalShortcut.isRegistered(k), key);
const os = (page: Page, call: string) => page.evaluate(`window.bulwarkDesktop.os.${call}`);
const quickStatus = async (page: Page) => (await os(page, 'getStatus()') as { quickCompose: Status }).quickCompose;

const composers = (app: ElectronApplication): Promise<Seen[]> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((w) => {
    // A window on its way out can throw on any of these, before it says it's destroyed.
    try {
      if (!w.webContents.getURL().includes('/popout/compose')) return [];
      return [{ id: w.id, visible: w.isVisible(), focused: w.isFocused(), width: w.getBounds().width, height: w.getBounds().height }];
    } catch {
      return [];
    }
  }));

const mainWindowVisible = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
  .filter((w) => !w.isDestroyed() && !w.webContents.getURL().includes('/popout/'))
  .some((w) => w.isVisible()));

const hideMain = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.getURL().includes('/popout/')) window.hide();
});

const closeComposers = async (app: ElectronApplication) => {
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && window.webContents.getURL().includes('/popout/compose')) window.close();
  });
  await expect.poll(() => composers(app)).toEqual([]);
};

/** What the shortcut's handler does: the same function. */
const press = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { quickCompose: { open: () => void } } }).__bulwarkOs.quickCompose.open());

const hubLocked = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked);

/** The page has said it's open, and now says what a signed-in main window says. */
async function signedIn(app: ElectronApplication, page: Page): Promise<void> {
  await expect.poll(() => hubLocked(app)).toBe(false);
  await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { sessionReady: () => void } } }).bulwarkDesktop.windows.sessionReady());
}

const signedOut = (page: Page) => page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { sessionEnded: () => void } } }).bulwarkDesktop.windows.sessionEnded());

const clickTrayNew = (app: ElectronApplication) => app.evaluate(() => {
  type Item = { label?: string; click?: () => void };
  const items = (globalThis as unknown as { __bulwarkOs: { tray: { template: () => Item[] } } }).__bulwarkOs.tray.template();
  items.find((item) => item.label === 'New message')?.click?.();
});

/**
 * Windows' default, as the app would hold it. Enter is a key the rest of this file doesn't
 * name, so this is what proves Electron takes it. With Shift, as nobody uses that.
 */
const ENTER_KEY = 'CommandOrControl+Alt+Shift+Enter';

test.describe('the shortcut', () => {
  let profile = '';
  let running: Launched | null = null;

  test.beforeEach(() => {
    profile = tempProfile('qc');
  });

  test.afterEach(async () => {
    await running?.app.close().catch(() => {});
    running = null;
    removeProfile(profile);
    removeOsTraces();
  });

  test('a new profile holds the built-in keys, off lets go, and new keys replace the old ones', async () => {
    running = await launchStandalone(profile, DEFAULT_ARG);
    const { app, page } = running;
    expect(await isHeld(app, KEY)).toBe(true);
    expect(await quickStatus(page)).toMatchObject({ shortcut: KEY, active: true, locked: false });

    await os(page, `setSettings({ quickComposeShortcut: '${OTHER_KEY}' })`);
    expect(await isHeld(app, OTHER_KEY)).toBe(true);
    expect(await isHeld(app, KEY)).toBe(false);
    expect(await quickStatus(page)).toMatchObject({ shortcut: OTHER_KEY, active: true, locked: false });

    await os(page, 'setSettings({ quickComposeShortcut: null })');
    expect(await isHeld(app, OTHER_KEY)).toBe(false);
    expect(await isHeld(app, KEY)).toBe(false);
    expect(await quickStatus(page)).toMatchObject({ shortcut: null, active: false, locked: false });
  });

  test('Enter is a key Electron takes, as the Windows default needs', async () => {
    running = await launchStandalone(profile, DEFAULT_ARG);
    const { app, page } = running;
    await os(page, `setSettings({ quickComposeShortcut: '${ENTER_KEY}' })`);
    expect(await isHeld(app, ENTER_KEY)).toBe(true);
    expect(await quickStatus(page)).toMatchObject({ shortcut: ENTER_KEY, active: true });
    expect((await menuItem(app, 'file.quickCompose'))?.accelerator).toBe(ENTER_KEY);
  });

  test('turned off stays off after a restart', async () => {
    running = await launchStandalone(profile, DEFAULT_ARG);
    await os(running.page, 'setSettings({ quickComposeShortcut: null })');
    await running.app.close();
    running = await launchStandalone(profile, DEFAULT_ARG);
    expect(await isHeld(running.app, KEY)).toBe(false);
    expect(await quickStatus(running.page)).toMatchObject({ shortcut: null });
  });

  test('what the page may set is checked', async () => {
    running = await launchStandalone(profile, DEFAULT_ARG);
    const { app, page } = running;
    await os(page, `setSettings({ quickComposeShortcut: 'not a shortcut', showShortcut: 'not a shortcut' })`);
    expect(await quickStatus(page)).toMatchObject({ shortcut: KEY, active: true });
    for (const keys of ['CommandOrControl+C', 'CommandOrControl+V', 'Shift+A', 'Alt+Tab', 'Alt+F4']) {
      await os(page, `setSettings({ quickComposeShortcut: '${keys}', showShortcut: '${keys}' })`);
      expect(await quickStatus(page), keys).toMatchObject({ shortcut: KEY, active: true });
      expect(await isHeld(app, keys), keys).toBe(false);
    }
    expect(await isHeld(app, KEY)).toBe(true);
  });

  test('keys another app holds are said, not swallowed, and picked up once that app has gone', async () => {
    // A real second process holding them, as another app would.
    const require = createRequire(import.meta.url);
    const electronPath = require('electron') as unknown as string;
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const holder: ChildProcess = spawn(electronPath, [path.join(ROOT, 'test', 'support', 'hold-shortcut.cjs'), KEY], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The other app never took the keys')), 60_000);
        holder.stdout?.on('data', (data: Buffer) => {
          if (!data.toString().includes('held')) return;
          clearTimeout(timer);
          resolve();
        });
      });

      running = await launchStandalone(profile, DEFAULT_ARG);
      const { app, page } = running;
      expect(await quickStatus(page)).toMatchObject({ shortcut: KEY, active: false, locked: false });
      expect(await isHeld(app, KEY)).toBe(false);
      // Nothing in the menu promises keys that do nothing.
      expect((await menuItem(app, 'file.quickCompose'))?.accelerator).toBeFalsy();

      // Focus comes back and the keys are still taken: nothing changes, and nothing breaks.
      await app.evaluate(({ app: electronApp }) => electronApp.emit('browser-window-focus'));
      expect(await quickStatus(page)).toMatchObject({ active: false });

      await page.evaluate(() => {
        const w = window as unknown as { __quick: unknown[]; bulwarkDesktop: { os: { onStatusChange: (l: (s: { quickCompose: unknown }) => void) => void } } };
        w.__quick = [];
        w.bulwarkDesktop.os.onStatusChange((status) => w.__quick.push(status.quickCompose));
      });
      holder.kill();
      await new Promise((resolve) => holder.once('exit', resolve));
      // An open settings page hears of it, without a reload.
      await expect.poll(async () => {
        await app.evaluate(({ app: electronApp }) => electronApp.emit('browser-window-focus'));
        return isHeld(app, KEY);
      }, { timeout: 20_000 }).toBe(true);
      expect(await quickStatus(page)).toMatchObject({ shortcut: KEY, active: true, locked: false });
      expect(await page.evaluate(() => (window as unknown as { __quick: unknown[] }).__quick)).toContainEqual({ shortcut: KEY, active: true, locked: false, builtIn: KEY });
      await expect.poll(async () => (await menuItem(app, 'file.quickCompose'))?.accelerator).toBe(KEY);
    } finally {
      holder.kill();
    }
  });

  test('another feature using the same keys is said the same way', async () => {
    running = await launchStandalone(profile);
    const { page } = running;
    await os(page, `setSettings({ showShortcut: '${KEY}' })`);
    await os(page, `setSettings({ quickComposeShortcut: '${KEY}' })`);
    expect(await quickStatus(page)).toMatchObject({ shortcut: KEY, active: false, locked: false });
  });
});

test.describe('the policy', () => {
  let profile = '';
  let running: Launched | null = null;

  const reg = (...args: string[]) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  const setPolicy = (sub: string, value: string) => reg('add', `${POLICY_ROOT}\\${sub}`, '/v', 'QuickComposeShortcut', '/t', 'REG_SZ', '/d', value, '/f');
  const launchWithPolicy = () => launchStandalone(profile, DEFAULT_ARG, `--bulwark-test-policy-root=${POLICY_ROOT}`, '--bulwark-test-policy-poll=250');

  test.beforeEach(() => {
    profile = tempProfile('qcp');
    reg('delete', POLICY_ROOT, '/f');
  });

  test.afterEach(async () => {
    await running?.app.close().catch(() => {});
    running = null;
    removeProfile(profile);
    reg('delete', POLICY_ROOT, '/f');
    removeOsTraces();
  });

  test.afterAll(() => {
    // Nothing left behind, unless someone else's run is using the root.
    const others = reg('query', `${POLICY_BASE}\\Policies`);
    if (!others.stdout?.includes('\\Policies\\')) reg('delete', POLICY_BASE, '/f');
  });

  test('forced keys replace the user\'s and can\'t be changed from the page', async () => {
    setPolicy('Machine', OTHER_KEY);
    running = await launchWithPolicy();
    const { app, page } = running;
    await expect.poll(() => quickStatus(page), { timeout: 20_000 }).toMatchObject({ shortcut: OTHER_KEY, active: true, locked: true });
    await os(page, `setSettings({ quickComposeShortcut: '${KEY}' })`);
    expect(await quickStatus(page)).toMatchObject({ shortcut: OTHER_KEY, active: true, locked: true });
    expect(await isHeld(app, OTHER_KEY)).toBe(true);
    expect(await isHeld(app, KEY)).toBe(false);
  });

  test('forced off holds nothing, whatever the user chose', async () => {
    setPolicy('Machine', 'off');
    running = await launchWithPolicy();
    const { app, page } = running;
    await expect.poll(() => quickStatus(page), { timeout: 20_000 }).toMatchObject({ shortcut: null, locked: true });
    await os(page, `setSettings({ quickComposeShortcut: '${KEY}' })`);
    expect(await quickStatus(page)).toMatchObject({ shortcut: null, active: false, locked: true });
    expect(await isHeld(app, KEY)).toBe(false);
  });

  test('a recommendation takes the place of the built-in keys, and the user\'s choice goes over it', async () => {
    setPolicy('Machine\\Recommended', OTHER_KEY);
    running = await launchWithPolicy();
    const { app, page } = running;
    await expect.poll(() => quickStatus(page), { timeout: 20_000 }).toMatchObject({ shortcut: OTHER_KEY, active: true, locked: false });
    await os(page, 'setSettings({ quickComposeShortcut: null })');
    expect(await quickStatus(page)).toMatchObject({ shortcut: null, active: false, locked: false });
    expect(await isHeld(app, OTHER_KEY)).toBe(false);
  });

  test('follows a change without a restart, and hands back the user\'s keys when it goes', async () => {
    running = await launchWithPolicy();
    const { app, page } = running;
    expect(await isHeld(app, KEY)).toBe(true);
    setPolicy('Machine', OTHER_KEY);
    await expect.poll(() => isHeld(app, OTHER_KEY), { timeout: 20_000 }).toBe(true);
    expect(await isHeld(app, KEY)).toBe(false);
    await expect.poll(() => quickStatus(page)).toMatchObject({ shortcut: OTHER_KEY, active: true, locked: true });
    reg('delete', POLICY_ROOT, '/f');
    await expect.poll(() => isHeld(app, KEY), { timeout: 20_000 }).toBe(true);
    expect(await isHeld(app, OTHER_KEY)).toBe(false);
    await expect.poll(() => quickStatus(page)).toMatchObject({ shortcut: KEY, active: true, locked: false });
  });
});

test.describe('the window', () => {
  let profile = '';
  let running: Launched | null = null;

  test.beforeEach(() => {
    profile = tempProfile('qcw');
  });

  test.afterEach(async () => {
    await running?.app.close().catch(() => {});
    running = null;
    removeProfile(profile);
    removeOsTraces();
  });

  test('the function given to the OS opens one small composer, and again goes back to it', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await signedIn(app, page);
    // The handler as the OS would call it: taken from the registration itself.
    await app.evaluate(({ globalShortcut }) => {
      const real = globalShortcut.register.bind(globalShortcut);
      globalShortcut.register = ((key: string, handler: () => void) => {
        (globalThis as unknown as { __handler: () => void }).__handler = handler;
        return real(key, handler);
      }) as typeof globalShortcut.register;
    });
    await os(page, `setSettings({ quickComposeShortcut: '${KEY}' })`);
    const fire = () => app.evaluate(() => (globalThis as unknown as { __handler: () => void }).__handler());

    await hideMain(app);
    await fire();
    await expect.poll(async () => (await composers(app)).length).toBe(1);
    await expect.poll(async () => (await composers(app))[0].visible).toBe(true);
    const [first] = await composers(app);
    expect(first.width).toBeLessThan(760);
    expect(first.height).toBeLessThan(780);
    // It doesn't drag the app up behind it.
    expect(await mainWindowVisible(app)).toBe(false);

    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.minimize(), first.id);
    await fire();
    await expect.poll(async () => (await composers(app))[0].visible && await app.evaluate(({ BrowserWindow }, id) => !BrowserWindow.fromId(id)?.isMinimized(), first.id)).toBe(true);
    expect((await composers(app)).map((window) => window.id)).toEqual([first.id]);
  });

  test('the tray, the jump list\'s link and the File menu open the same window', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await signedIn(app, page);
    await page.evaluate(() => {
      const w = window as unknown as { __cmds: unknown[]; bulwarkDesktop: { os: { onCommand: (l: (c: unknown) => void) => void } } };
      w.__cmds = [];
      w.bulwarkDesktop.os.onCommand((command) => w.__cmds.push(command));
    });

    await hideMain(app);
    await clickTrayNew(app);
    await expect.poll(async () => (await composers(app)).length).toBe(1);
    expect(await mainWindowVisible(app)).toBe(false);
    await closeComposers(app);

    // A second launch from the jump list, whose entry is this link.
    await app.evaluate(({ app: electronApp }) => electronApp.emit('second-instance', {}, ['bulwark.exe', 'bulwark://new'], ''));
    await expect.poll(async () => (await composers(app)).length).toBe(1);
    expect(await mainWindowVisible(app)).toBe(false);
    await closeComposers(app);

    await clickMenuItem(app, 'file.quickCompose');
    await expect.poll(async () => (await composers(app)).length).toBe(1);
    await closeComposers(app);

    // None of them went to the main window's page as well.
    expect(await page.evaluate(() => (window as unknown as { __cmds: unknown[] }).__cmds)).toEqual([]);
  });

  test('a web page firing bulwark://new in a loop can\'t keep taking the focus', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await signedIn(app, page);
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as { __focuses: number };
      g.__focuses = 0;
      const real = BrowserWindow.prototype.focus;
      BrowserWindow.prototype.focus = function focus(this: Electron.BrowserWindow) {
        g.__focuses += 1;
        return real.call(this);
      };
    });
    const fire = () => app.evaluate(({ app: electronApp }) => electronApp.emit('second-instance', {}, ['bulwark.exe', 'bulwark://new'], ''));
    for (let index = 0; index < 20; index += 1) await fire();
    await expect.poll(async () => (await composers(app)).length).toBe(1);
    const focuses = () => app.evaluate(() => (globalThis as unknown as { __focuses: number }).__focuses);
    expect(await focuses()).toBeLessThan(6);
    // The shortcut itself isn't held to it: it's the user at the keyboard.
    const before = await focuses();
    await press(app);
    await expect.poll(focuses).toBeGreaterThan(before);
    // And it passes.
    await app.evaluate(() => {
      const real = Date.now;
      Date.now = () => real() + 11_000;
    });
    const later = await focuses();
    await fire();
    await expect.poll(focuses).toBeGreaterThan(later);
  });

  test('nothing opens once the app is quitting', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await signedIn(app, page);
    const quit = () => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { ctx: { windows: { beginQuit: () => void } } } } }).__bulwarkOs.hub.ctx.windows.beginQuit());
    // Waiting behind the lock when the quit comes: it doesn't open after all.
    await os(page, 'setLocked(true)');
    await press(app);
    await quit();
    await os(page, 'setLocked(false)');
    await page.waitForTimeout(800);
    expect(await composers(app)).toEqual([]);
    await press(app);
    await clickTrayNew(app);
    await page.waitForTimeout(800);
    expect(await composers(app)).toEqual([]);
  });

  test('opens on the monitor the pointer is on, and a remembered place on another or off every screen doesn\'t count', async () => {
    running = await launchStandalone(profile);
    const { app } = running;
    const LEFT = { x: 0, y: 0, width: 1920, height: 1040 };
    const RIGHT = { x: 2560, y: 100, width: 1600, height: 900 };
    const placeWith = (stored: object | null, pointerOn: object) => app.evaluate(({ screen }, [area, place]) => {
      type Ctx = { state: { data: { windowBounds: Record<string, unknown> } }; windows: { placeFor: (t: string, s: unknown, k: string) => { x: number; y: number; width: number; height: number } } };
      const { state, windows } = (globalThis as unknown as { __bulwarkOs: { hub: { ctx: Ctx } } }).__bulwarkOs.hub.ctx;
      // Electron's screen is a proxy: a plain assignment reaches the real object.
      screen.getCursorScreenPoint = () => ({ x: (area as { x: number }).x + 5, y: (area as { y: number }).y + 5 });
      screen.getDisplayNearestPoint = (() => ({ workArea: area })) as unknown as typeof screen.getDisplayNearestPoint;
      if (place) state.data.windowBounds.quickComposer = place;
      else delete state.data.windowBounds.quickComposer;
      return windows.placeFor('composer', undefined, 'quickComposer');
    }, [pointerOn, stored] as const);
    const inside = (rect: { x: number; y: number; width: number; height: number }, area: typeof LEFT) =>
      rect.x >= area.x && rect.y >= area.y && rect.x + rect.width <= area.x + area.width && rect.y + rect.height <= area.y + area.height;

    // Nothing remembered: the small size, in the middle of that monitor.
    const fresh = await placeWith(null, RIGHT);
    expect(inside(fresh, RIGHT)).toBe(true);
    expect([fresh.width, fresh.height]).toEqual([680, 560]);
    expect(fresh.x).toBe(RIGHT.x + Math.round((RIGHT.width - 680) / 2));

    // Remembered on this monitor: there.
    const here = { x: 2700, y: 200, width: 700, height: 600 };
    expect(await placeWith(here, RIGHT)).toEqual(here);

    // Remembered on the other one: its size, here.
    const moved = await placeWith({ x: 100, y: 100, width: 700, height: 600 }, RIGHT);
    expect(inside(moved, RIGHT)).toBe(true);
    expect([moved.width, moved.height]).toEqual([700, 600]);

    // Remembered off every screen, on a monitor long gone.
    const lost = await placeWith({ x: -9000, y: -9000, width: 700, height: 600 }, LEFT);
    expect(inside(lost, LEFT)).toBe(true);

    // Remembered larger than this monitor: it fits.
    const large = await placeWith({ x: 100, y: 100, width: 3000, height: 2000 }, RIGHT);
    expect(inside(large, RIGHT)).toBe(true);
  });

  test('the menu shows the keys that work', async () => {
    running = await launchStandalone(profile, DEFAULT_ARG);
    const { app, page } = running;
    expect(await menuItem(app, 'file.quickCompose')).toMatchObject({ label: 'Quick compose', accelerator: KEY, registerAccelerator: false });
    await os(page, 'setSettings({ quickComposeShortcut: null })');
    await expect.poll(async () => (await menuItem(app, 'file.quickCompose'))?.accelerator).toBeFalsy();
    // Still there with the keys off: the menu needs no shortcut.
    expect(await menuItem(app, 'file.quickCompose')).toMatchObject({ label: 'Quick compose' });
  });

  test('locked by the page, nothing opens: the lock screen comes up, and the composer after the unlock', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await signedIn(app, page);
    await os(page, 'setLocked(true)');
    await hideMain(app);
    await press(app);
    await expect.poll(() => mainWindowVisible(app)).toBe(true);
    await page.waitForTimeout(1500);
    expect(await composers(app)).toEqual([]);

    await clickTrayNew(app);
    await page.waitForTimeout(500);
    expect(await composers(app)).toEqual([]);

    await os(page, 'setLocked(false)');
    await expect.poll(async () => (await composers(app)).length).toBe(1);
  });

  test('locked by main, the page saying otherwise opens nothing', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await signedIn(app, page);
    const setByMain = (locked: boolean) => app.evaluate((_e, value) => (globalThis as unknown as { __bulwarkOs: { hub: { setLockedByMain: (l: boolean) => void } } }).__bulwarkOs.hub.setLockedByMain(value), locked);
    await setByMain(true);
    await press(app);
    await os(page, 'setLocked(false)');
    await page.waitForTimeout(1000);
    expect(await composers(app)).toEqual([]);
    await setByMain(false);
    await expect.poll(async () => (await composers(app)).length).toBe(1);
  });

  test('a lock that lifts long after the press opens nothing', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await signedIn(app, page);
    await os(page, 'setLocked(true)');
    await press(app);
    await app.evaluate(() => {
      const real = Date.now;
      Date.now = () => real() + 10 * 60_000;
    });
    await os(page, 'setLocked(false)');
    await page.waitForTimeout(1000);
    expect(await composers(app)).toEqual([]);
    // That wait is over: the next press isn't held up by it.
    await press(app);
    await expect.poll(async () => (await composers(app)).length).toBe(1);
  });

  test('signed out, the sign-in comes up and the composer follows it', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await signedIn(app, page);
    await signedOut(page);
    await hideMain(app);
    await press(app);
    await expect.poll(() => mainWindowVisible(app)).toBe(true);
    await page.waitForTimeout(1000);
    expect(await composers(app)).toEqual([]);
    await signedIn(app, page);
    await expect.poll(async () => (await composers(app)).length).toBe(1);
  });

  test('keeps its own size, apart from other composers', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await signedIn(app, page);
    await press(app);
    await expect.poll(async () => (await composers(app))[0]?.visible).toBe(true);
    const [window] = await composers(app);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.setSize(700, 600), window.id);
    // A scaled display comes out a few pixels off.
    await expect.poll(async () => Math.abs((await composers(app))[0].width - 700)).toBeLessThan(6);
    const [resized] = await composers(app);
    await closeComposers(app);

    await press(app);
    await expect.poll(async () => (await composers(app))[0]?.visible).toBe(true);
    const [again] = await composers(app);
    expect(Math.abs(again.width - resized.width)).toBeLessThan(6);
    expect(Math.abs(again.height - resized.height)).toBeLessThan(6);
    await closeComposers(app);

    // A pop-out from the app is a composer of the usual size.
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { open: (url: string, o: object) => void } } }).bulwarkDesktop.windows.open('/popout/compose', { name: 'other', width: 760, height: 780 }));
    await expect.poll(async () => (await composers(app))[0]?.visible).toBe(true);
    expect((await composers(app))[0].width).toBeGreaterThan(740);
  });
});
