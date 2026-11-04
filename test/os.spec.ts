import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launch, launchStandalone, removeOsTraces, removeProfile, shownPage, tempProfile, type Launched } from './helpers';

/**
 * The real app, on its login page: the bridge and the OS calls don't need a sign-in or
 * the webmail's side. System state is read back where Windows lets us: registry, login
 * item, jump list. Everything set here is taken away in afterAll.
 */

const win = process.platform === 'win32';
const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'dist', 'main.mjs');
const DEV_CLSID = '{C2D85A16-4E7B-4F39-8A10-6B3E9F72D154}';
const SHOW_SHORTCUT = 'CommandOrControl+Alt+Shift+F11';
/** The app is done in under a second. The process going away can take far longer on a busy machine. */
const CLOSE_WAIT = { timeout: 120_000 };

function reg(...args: string[]): { ok: boolean; out: string } {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, out: result.stdout ?? '' };
}

/** A separate Windows desktop, which test runs may use, has no taskbar. */
function hasTaskbar(): boolean {
  const script = `(Add-Type -PassThru -Name W -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);')::FindWindow('Shell_TrayWnd', $null) -ne [IntPtr]::Zero`;
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim() === 'True';
}

interface Recorded {
  shown: { title: string; body: string; toastXml: string }[];
  opened: string[];
  dragged: { file: string; files?: string[] }[];
  commands?: unknown[];
}

/** Toasts recorded rather than shown: this runs on someone's desktop. */
async function record(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification, shell }) => {
    const g = globalThis as unknown as { __rec: Recorded };
    g.__rec = { shown: [], opened: [], dragged: [] };
    Notification.prototype.show = function show(this: Electron.Notification) {
      g.__rec.shown.push({ title: this.title, body: this.body, toastXml: this.toastXml });
    };
    shell.openExternal = async (url: string) => {
      g.__rec.opened.push(url);
    };
  });
}

const recorded = (app: ElectronApplication): Promise<Recorded> => app.evaluate(() => (globalThis as unknown as { __rec: Recorded }).__rec);

/** The page's end of the bridge, kept where a test can read it. */
async function listen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __cmds: unknown[]; __power: string[]; bulwarkDesktop: { os: { onCommand: (l: (c: unknown) => void) => void; onPower: (l: (e: string) => void) => void } } };
    w.__cmds = [];
    w.__power = [];
    w.bulwarkDesktop.os.onCommand((command) => w.__cmds.push(command));
    w.bulwarkDesktop.os.onPower((event) => w.__power.push(event));
  });
}

const commands = (page: Page) => page.evaluate(() => (window as unknown as { __cmds: { type: string }[] }).__cmds);
const os = (page: Page, call: string) => page.evaluate(`window.bulwarkDesktop.os.${call}`);

/**
 * For a test that plays the page's part. The real page says it's open as it starts, and sends
 * its own summary a while later: on the login page an empty one, over what the test set. So wait
 * for its first word and drop its empty summaries. Anything else still comes over the bridge.
 */
async function takeOverFromPage(app: ElectronApplication): Promise<void> {
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked)).toBe(false);
  await app.evaluate(() => {
    const hub = (globalThis as unknown as { __bulwarkOs: { hub: { setSummary: (s: { unread: unknown[]; recent: unknown[]; nextEvent: unknown }) => void } } }).__bulwarkOs.hub;
    const real = hub.setSummary.bind(hub);
    hub.setSummary = (summary) => {
      if (summary.unread.length || summary.recent.length || summary.nextEvent) real(summary);
    };
  });
}

interface TrayItem { label?: string; type?: string; enabled?: boolean; submenu?: TrayItem[] }

const trayItems = (app: ElectronApplication): Promise<TrayItem[]> =>
  app.evaluate(() => {
    const strip = (items: TrayItem[]): TrayItem[] => items.map(({ label, type, enabled, submenu }) => ({ label, type, enabled, submenu: submenu ? strip(submenu) : undefined }));
    return strip((globalThis as unknown as { __bulwarkOs: { tray: { template: () => TrayItem[] } } }).__bulwarkOs.tray.template());
  });

interface ClickableItem { label?: string; click?: () => void; submenu?: ClickableItem[] }

const clickTray = (app: ElectronApplication, label: string, sub?: string) =>
  app.evaluate((_electron, [wanted, wantedSub]) => {
    const items = (globalThis as unknown as { __bulwarkOs: { tray: { template: () => ClickableItem[] } } }).__bulwarkOs.tray.template();
    const item = items.find((i) => i.label === wanted);
    const target = wantedSub ? item?.submenu?.find((i) => i.label === wantedSub) : item;
    target?.click?.();
  }, [label, sub] as const);

const mainVisible = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()));

test.describe('OS integration', () => {
  let profile: string;
  let running: Launched | null = null;

  test.beforeEach(() => {
    profile = tempProfile('os');
  });

  test.afterEach(async () => {
    await running?.app.close().catch(() => {});
    running = null;
    removeProfile(profile);
    removeOsTraces();
  });

  test('closing goes to the tray, says so once, and the page keeps its timers running', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await record(app);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => mainVisible(app)).toBe(false);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect.poll(async () => (await recorded(app)).shown.length).toBe(1);
    expect((await recorded(app)).shown[0].title).toBe('Bulwark is still running');

    // Playwright's focus emulation keeps any attached page awake, so the page itself can't
    // show this here: read the switch. Measured without a debugger on Electron 45 over 12 s
    // of a 100 ms timer, hidden: default 13 ticks and "hidden", switched off 120 and "visible".
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling())).toBe(false);

    await clickTray(app, 'Open Bulwark');
    await expect.poll(() => mainVisible(app)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => mainVisible(app)).toBe(false);
    await page.waitForTimeout(500);
    expect((await recorded(app)).shown.length).toBe(1);
  });

  test('with close to tray off, closing the window ends the app', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await os(page, 'setSettings({ closeToTray: false })');
    const closed = app.waitForEvent('close', CLOSE_WAIT);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closed;
    running = null;
  });

  test('Quit in the tray ends the app, hidden window and all', async () => {
    running = await launchStandalone(profile);
    const { app } = running;
    await record(app);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => mainVisible(app)).toBe(false);
    const closed = app.waitForEvent('close', CLOSE_WAIT);
    await clickTray(app, 'Quit Bulwark');
    await closed;
    running = null;
  });

  test('the tray: left click toggles, and the menu shows unread and the next event unless locked', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await takeOverFromPage(app);
    await record(app);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { tray: { tray: Electron.Tray } } }).__bulwarkOs.tray.tray.emit('click'));
    await expect.poll(() => mainVisible(app)).toBe(false);
    await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { tray: { tray: Electron.Tray } } }).__bulwarkOs.tray.tray.emit('click'));
    await expect.poll(() => mainVisible(app)).toBe(true);

    const before = (await trayItems(app)).map((i) => i.label);
    expect(before).toEqual(expect.arrayContaining(['New message', 'Pause notifications', 'Open Bulwark', 'Quit Bulwark']));

    await os(page, 'setLocked(false)');
    await os(page, `setSummary({ unread: [{ emailId: 'e1', accountId: 'a1', sender: 'Alice & Co', subject: 'Lunch?' }], recent: [{ emailId: 'e1', accountId: 'a1', sender: 'Alice', subject: 'Lunch?' }], nextEvent: { title: 'Standup', when: '09:30' } })`);
    await expect.poll(async () => (await trayItems(app)).map((i) => i.label)).toContain('Alice && Co: Lunch?');
    expect((await trayItems(app)).map((i) => i.label)).toContain('Next: Standup, 09:30');
    expect((await trayItems(app)).find((i) => i.label === 'Unread')?.enabled).toBe(false);

    // Locked: not a word of it in the menu, nor in the jump list that's rebuilt with it.
    await os(page, 'setLocked(true)');
    await expect.poll(async () => JSON.stringify(await trayItems(app))).not.toContain('Lunch');
    expect(JSON.stringify(await trayItems(app))).not.toContain('Standup');
    // A real lock forgot it too. It only comes back from the page.
    await os(page, 'setLocked(false)');
    await page.waitForTimeout(200);
    expect(JSON.stringify(await trayItems(app))).not.toContain('Lunch');
  });

  test('the app lock: main decides, the tray locks, and no page lifts it, not after a restart either', async () => {
    const own = tempProfile('os-app-lock');
    const proof = (seed: number) => `new Uint8Array(32).fill(${seed})`;
    const gateCall = (app: ElectronApplication, call: string) =>
      app.evaluate((_electron, source) => {
        const gate = (globalThis as unknown as { __bulwarkOs: { gate: unknown } }).__bulwarkOs.gate;
        return new Function('gate', `return gate.${source}`)(gate) as boolean;
      }, call);
    const hubLocked = (app: ElectronApplication) =>
      app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked);
    let launched = await launchStandalone(own);
    try {
      expect((await trayItems(launched.app)).map((i) => i.label)).not.toContain('Lock now');
      await gateCall(launched.app, `enroll(${proof(1)})`);
      await os(launched.page, 'setLocked(false)');
      await os(launched.page, `setSummary({ unread: [{ emailId: 'e1', accountId: 'a1', sender: 'Alice', subject: 'Lunch?' }], recent: [], nextEvent: null })`);
      await expect.poll(async () => JSON.stringify(await trayItems(launched.app))).toContain('Lunch');
      await expect.poll(async () => (await trayItems(launched.app)).map((i) => i.label)).toContain('Lock now');

      await launched.app.evaluate(() => {
        const { tray } = (globalThis as unknown as { __bulwarkOs: { tray: { template(): Array<{ label?: string; click?: () => void }> } } }).__bulwarkOs;
        tray.template().find((item) => item.label === 'Lock now')?.click?.();
      });
      expect(await gateCall(launched.app, 'locked')).toBe(true);
      await expect.poll(async () => JSON.stringify(await trayItems(launched.app))).not.toContain('Lunch');
      expect(await hubLocked(launched.app)).toBe(true);

      await os(launched.page, 'setLocked(false)');
      await launched.page.waitForTimeout(300);
      expect(await hubLocked(launched.app), 'a page\'s word').toBe(true);

      await launched.app.close();
      launched = await launchStandalone(own);
      expect(await hubLocked(launched.app), 'a new start').toBe(true);
      await os(launched.page, 'setLocked(false)');
      await launched.page.waitForTimeout(300);
      expect(await hubLocked(launched.app), 'a page\'s word after a new start').toBe(true);

      expect(await gateCall(launched.app, `prove(${proof(1)})`)).toBe(true);
      expect(await hubLocked(launched.app)).toBe(false);
    } finally {
      await launched.app.close().catch(() => undefined);
      removeProfile(own);
    }
  });

  test('what already waits for the page and names a message goes when it locks', async () => {
    running = await launchStandalone(profile);
    const left = await running.app.evaluate(() => {
      const { hub } = (globalThis as unknown as { __bulwarkOs: { hub: { pending: Array<{ type: string }>; setLockedByMain(locked: boolean): void } } }).__bulwarkOs;
      hub.pending.push({ type: 'notification' }, { type: 'open-message' }, { type: 'new-message' });
      hub.setLockedByMain(true);
      const kept = hub.pending.map((command) => command.type);
      hub.pending.length = 0;
      hub.setLockedByMain(false);
      return kept;
    });
    expect(left).toEqual(['new-message']);
  });

  test('tray and jump list items reach the page as commands, in order, shown or not', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await takeOverFromPage(app);
    await record(app);
    await listen(page);
    await os(page, 'setLocked(false)');
    await os(page, `setSummary({ unread: [{ emailId: 'e1', accountId: 'a1', sender: 'Alice', subject: 'Lunch?', context: 'ctx' }], recent: [], nextEvent: { title: 'Standup', when: '09:30' } })`);
    await expect.poll(async () => (await trayItems(app)).map((i) => i.label)).toContain('Alice: Lunch?');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await clickTray(app, 'New message');
    await expect.poll(() => mainVisible(app)).toBe(true);
    await clickTray(app, 'Alice: Lunch?');
    await clickTray(app, 'Next: Standup, 09:30');
    await expect.poll(() => commands(page)).toEqual([
      { type: 'new-message' },
      { type: 'open-message', emailId: 'e1', accountId: 'a1', context: 'ctx' },
      { type: 'navigate', target: 'calendar' },
    ]);
  });

  test('pausing from the tray stops notifications and survives in settings until it ends', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await record(app);
    await page.evaluate(() => window.blur());
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blur());

    await clickTray(app, 'Pause notifications', 'For 1 hour');
    await expect.poll(async () => (await trayItems(app)).map((i) => i.label)).toContain('Turn notifications back on');
    const status = await os(page, 'getStatus()') as { pausedUntil: number };
    expect(status.pausedUntil).toBeGreaterThan(Date.now() + 3500_000);
    const paused = await os(page, `notify({ id: 'p1', title: 'T', body: 'B', context: '', sound: true })`) as { shown: boolean; reason: string; playSound: boolean };
    expect(paused).toEqual({ shown: false, reason: 'paused', playSound: false });
    expect((await recorded(app)).shown).toEqual([]);

    await clickTray(app, 'Turn notifications back on');
    await expect.poll(async () => (await trayItems(app)).map((i) => i.label)).toContain('Pause notifications');
  });

  test('notifications: duplicates, quiet hours, Do Not Disturb, focus and the lock', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await takeOverFromPage(app);
    await record(app);
    const send = (id: string, extra = '') => os(page, `notify({ id: '${id}', title: 'Alice', body: 'Lunch?', context: 'ctx', sound: true, actions: [{ id: 'archive', label: 'Archive' }], reply: { label: 'Reply', placeholder: 'Type' }${extra} })`) as Promise<{ shown: boolean; reason?: string; playSound: boolean }>;
    const setAssist = (value: string | null) => app.evaluate((_e, v) => (globalThis as unknown as { __bulwarkOs: { toasts: { setFocusAssistForTest: (x: unknown) => void } } }).__bulwarkOs.toasts.setFocusAssistForTest(v), value);
    await os(page, 'setLocked(false)');
    const blur = () => app.evaluate(({ BrowserWindow }) => {
      // In a test nothing else takes the focus away, so ask as the code does.
      BrowserWindow.getFocusedWindow = () => null;
    });

    await setAssist('off');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getFocusedWindow = () => BrowserWindow.getAllWindows()[0];
    });
    // In front of the user: no toast, but the sound they picked.
    expect(await send('focused')).toEqual({ shown: false, reason: 'focused', playSound: true });
    expect((await recorded(app)).shown).toEqual([]);

    await blur();
    expect(await send('m1')).toEqual({ shown: true, playSound: true });
    let shown = (await recorded(app)).shown;
    expect(shown.length).toBe(1);
    if (win) {
      expect(shown[0].toastXml).toContain('Alice');
      expect(shown[0].toastXml).toContain('content="Archive"');
      expect(shown[0].toastXml).toContain('<audio silent="true"/>');
    }

    expect(await send('m1')).toEqual({ shown: false, reason: 'duplicate', playSound: false });

    // Do Not Disturb: Windows holds the banner, the sound is ours to hold.
    await setAssist('alarms');
    expect(await send('dnd')).toEqual({ shown: true, playSound: false });
    await setAssist('off');

    await os(page, `setSettings({ quietHoursEnabled: true, quietHoursStart: '00:00', quietHoursEnd: '23:59' })`);
    expect(await send('quiet')).toEqual({ shown: false, reason: 'quiet-hours', playSound: false });
    await os(page, 'setSettings({ quietHoursEnabled: false })');

    // The lock is checked here as well as in the page.
    await os(page, 'setLocked(true)');
    expect((await send('locked')).shown).toBe(true);
    shown = (await recorded(app)).shown;
    const last = shown[shown.length - 1];
    expect(`${last.toastXml}${last.title}${last.body}`).not.toContain('Alice');
    expect(`${last.toastXml}${last.title}${last.body}`).not.toContain('Lunch');
    expect(last.toastXml).not.toContain('content="Archive"');
    await os(page, 'setLocked(false)');

    expect(await os(page, `notify({ title: 'no id' })`)).toEqual({ shown: false, reason: 'invalid', playSound: false });
  });

  test('Do Not Disturb is read from Windows itself', async () => {
    test.skip(!win);
    running = await launchStandalone(profile);
    const value = await running.app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { toasts: { focusAssist: () => Promise<string> } } }).__bulwarkOs.toasts.focusAssist());
    expect(['off', 'priority', 'alarms', 'fullscreen']).toContain(value);
  });

  test('the lock: counted as locked until the page says, only the main window may lift it, and a page can\'t lift what main decided', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await record(app);
    await listen(page);
    const locked = () => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked);
    const pressDelete = () => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { toastAction: (a: string, c: string) => void } } }).__bulwarkOs.hub.toastAction('delete', 'ctx'));
    // A new page reports as it starts, which is later than its load. Past that, our word is the last one.
    await page.reload();
    await expect.poll(locked).toBe(false);

    await os(page, 'setLocked(true)');
    await expect.poll(locked).toBe(true);
    await listen(page);

    // Behind the lock a toast's button acts on nothing: no command, and the window comes up.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await pressDelete();
    await expect.poll(() => mainVisible(app)).toBe(true);
    expect(await commands(page)).toEqual([]);

    // Another window's word doesn't count.
    await app.evaluate(({ webContents }) => {
      const hub = (globalThis as unknown as { __bulwarkOs: { hub: { setLockedByPage: (l: boolean, c: unknown) => void } } }).__bulwarkOs.hub;
      hub.setLockedByPage(false, { id: -1 } as unknown as typeof webContents);
    });
    expect(await locked()).toBe(true);

    await os(page, 'setLocked(false)');
    await expect.poll(locked).toBe(false);
    await pressDelete();
    await expect.poll(() => commands(page)).toEqual([{ type: 'notification', action: 'delete', context: 'ctx' }]);

    // Main's verdict stands over the page's.
    await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { setLockedByMain: (l: boolean) => void } } }).__bulwarkOs.hub.setLockedByMain(true));
    await os(page, 'setLocked(false)');
    await page.waitForTimeout(200);
    expect(await locked()).toBe(true);

    // Titles carry subjects.
    await page.evaluate(() => { document.title = 'Secret subject'; });
    await page.waitForTimeout(300);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toBe('Bulwark');
    await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { setLockedByMain: (l: boolean) => void } } }).__bulwarkOs.hub.setLockedByMain(false));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toBe('Secret subject');
  });

  test('a page navigating away counts as not having said: nothing is told until the new page says', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    const locked = () => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked);
    await os(page, 'setLocked(false)');
    await expect.poll(locked).toBe(false);
    const stale = await page.evaluate(() => location.href);
    await app.evaluate(({ BrowserWindow }, url) => { void BrowserWindow.getAllWindows()[0].webContents.loadURL(url); }, stale);
    await expect.poll(locked).toBe(true);
  });

  test('sign-out clears what the OS shows; a quit does too', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await takeOverFromPage(app);
    await os(page, 'setLocked(false)');
    await os(page, `setSummary({ unread: [{ emailId: 'e1', accountId: 'a1', sender: 'Alice', subject: 'Lunch?' }], recent: [], nextEvent: null })`);
    await os(page, 'setBadge(4)');
    await expect.poll(async () => JSON.stringify(await trayItems(app))).toContain('Lunch');
    await app.evaluate(({ Notification }) => {
      const g = globalThis as unknown as { __removed: number };
      g.__removed = 0;
      Notification.removeAll = () => { g.__removed += 1; };
    });
    const files = await app.evaluate(async () => (await (globalThis as unknown as { __bulwarkOs: { files: { prepare: (r: unknown) => Promise<{ paths: string[] }> } } }).__bulwarkOs.files.prepare([{ name: 'a.txt', data: new Uint8Array([1]) }])).paths);
    expect(existsSync(files[0])).toBe(true);
    await os(page, 'clearSurfaces()');
    await expect.poll(async () => JSON.stringify(await trayItems(app))).not.toContain('Lunch');
    expect(await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { badge: number } } }).__bulwarkOs.hub.badge)).toBe(0);
    expect(await app.evaluate(() => (globalThis as unknown as { __removed: number }).__removed)).toBeGreaterThan(0);
    expect(existsSync(files[0])).toBe(false);
  });

  test('a wipe clears what the OS shows, and it stays clear when the page comes back', async () => {
    test.skip(!win, 'the test root is a registry key');
    const root = `HKCU\\Software\\BulwarkTest\\Policies\\os${process.pid}`;
    try {
      running = await launchStandalone(profile, `--bulwark-test-policy-root=${root}`, '--bulwark-test-policy-poll=250');
      const { app, page } = running;
      await takeOverFromPage(app);
      await os(page, 'setLocked(false)');
      await os(page, `setSummary({ unread: [{ emailId: 'e1', accountId: 'a1', sender: 'Alice', subject: 'Lunch?' }], recent: [], nextEvent: null })`);
      await expect.poll(async () => JSON.stringify(await trayItems(app))).toContain('Lunch');
      const files = await app.evaluate(async () => (await (globalThis as unknown as { __bulwarkOs: { files: { prepare: (r: unknown) => Promise<{ paths: string[] }> } } }).__bulwarkOs.files.prepare([{ name: 'a.txt', data: new Uint8Array([1]) }])).paths);
      expect(existsSync(files[0])).toBe(true);
      expect(reg('add', `${root}\\Machine`, '/v', 'WipeOfflineData', '/t', 'REG_SZ', '/d', `wipe-${Date.now()}`, '/f').ok).toBe(true);
      await expect.poll(() => existsSync(files[0])).toBe(false);
      // The wiped page goes to a blank one, which alone hides the summary. Past that:
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked)).toBe(false);
      expect(JSON.stringify(await trayItems(app))).not.toContain('Lunch');
    } finally {
      reg('delete', root, '/f');
    }
  });

  test('a file a program holds stops neither the start nor a quit', async () => {
    test.skip(!win);
    const held = path.join(profile, 'os-files', 'old', 'open.txt');
    mkdirSync(path.dirname(held), { recursive: true });
    writeFileSync(held, 'x');
    // A process that keeps the file open, without sharing it for delete.
    const holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${held}', 'Open', 'Read', 'None'); Start-Sleep -Seconds 60`], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      running = await launchStandalone(profile);
      const { app } = running;
      const closed = app.waitForEvent('close', CLOSE_WAIT);
      await app.evaluate(({ app: a }) => a.quit());
      await closed;
      running = null;
    } finally {
      holder.kill();
    }
  });

  test('programs run by their full path, from a launch in a folder with a planted reg.exe', async () => {
    test.skip(!win);
    const planted = path.join(profile, 'launchdir');
    mkdirSync(planted, { recursive: true });
    // Does nothing and says it worked. If it ran, the keys below wouldn't be there.
    copyFileSync('C:\\Windows\\System32\\hostname.exe', path.join(planted, 'reg.exe'));
    copyFileSync('C:\\Windows\\System32\\hostname.exe', path.join(planted, 'powershell.exe'));
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && name.toLowerCase() !== 'nodefaultcurrentdirectoryinexepath' && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
    }
    const app = await _electron.launch({ args: [MAIN, `--bulwark-user-data=${profile}`, '--lang=en-US', '--standalone'], cwd: planted, env });
    running = { app, page: await shownPage(app) };
    const { page } = running;
    await record(app);
    expect(path.resolve(await app.evaluate(() => process.cwd())).toLowerCase()).toBe(path.resolve(profile).toLowerCase());
    try {
      await os(page, 'openDefaultAppSettings()');
      expect(reg('query', 'HKCU\\Software\\Bulwark\\Capabilities', '/v', 'ApplicationName').out).toContain('Bulwark');
    } finally {
      await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { defaultApp: { unregister: () => Promise<void> } } }).__bulwarkOs.defaultApp.unregister());
    }
    // The launch folder still counts for a relative file on the command line.
    const launched = await app.evaluate(() => (globalThis as unknown as { __launchFolder?: string }).__launchFolder ?? null);
    expect(launched === null || path.resolve(launched).toLowerCase() === path.resolve(planted).toLowerCase()).toBe(true);
  });

  test('a crashed main window comes back, and past the limit the user is told', async () => {
    running = await launchStandalone(profile);
    const { app } = running;
    await record(app);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      return !contents.isCrashed() && !contents.isLoading();
    }), { timeout: 60_000 }).toBe(true);
    // Playwright's page died with the renderer, so ask the window.
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('document.readyState').catch(() => null)), { timeout: 60_000 }).toBe('complete');

    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.reload = () => {};
      for (let i = 0; i < 4; i += 1) contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    });
    await expect.poll(async () => (await recorded(app)).shown.map((toast) => toast.title)).toContain('Bulwark stopped working');
  });

  test('a main window that failed to load tries again, and sooner on waking', async () => {
    running = await launchStandalone(profile);
    const { app } = running;
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as { __loads: string[] };
      g.__loads = [];
      const window = BrowserWindow.getAllWindows()[0];
      window.loadURL = (async (url: string) => { g.__loads.push(url); }) as typeof window.loadURL;
      window.webContents.emit('did-fail-load', {}, -106, 'offline', 'https://app.bulwark.localhost/', true);
    });
    const loads = () => app.evaluate(() => (globalThis as unknown as { __loads: string[] }).__loads);
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
    await expect.poll(loads, { timeout: 1500 }).toEqual(['https://app.bulwark.localhost/']);
    // A certificate failure isn't one more try: its page says what to do.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.emit('did-fail-load', {}, -202, 'cert', 'https://app.bulwark.localhost/', true);
    });
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await loads()).length).toBe(1);
  });

  test('a second launch during the boot is not lost', async () => {
    // The boot waits for this file, so the second launch comes with no window and nothing live to take it.
    const gate = path.join(profile, 'boot-gate');
    const require = createRequire(import.meta.url);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
    delete env.ELECTRON_RUN_AS_NODE;
    const hold = path.join(ROOT, 'test', 'support', 'hold-boot.cjs');
    const app = await _electron.launch({
      args: ['-r', hold, MAIN, `--bulwark-user-data=${profile}`, '--lang=en-US', '--standalone'],
      cwd: ROOT,
      env: { ...env, BULWARK_TEST_BOOT_GATE: gate },
    });
    await expect.poll(() => app.evaluate(({ app: electronApp }) => electronApp.listenerCount('second-instance')), { timeout: 30_000 }).toBeGreaterThan(0);
    const second = spawn(require('electron') as unknown as string, [MAIN, `--bulwark-user-data=${profile}`, '--', 'webcal://example.org/early.ics'], { env, stdio: 'ignore' });
    await new Promise((resolve) => second.once('exit', resolve));
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    writeFileSync(gate, '');
    const page = await shownPage(app);
    running = { app, page };
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('bulwark:pending-webcal')).catch(() => null), { timeout: 60_000 }).toContain('example.org/early.ics');
  });

  test('a cold toast action with close to tray off doesn\'t stay hidden', async () => {
    writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({ mode: 'standalone', os: { closeToTray: false }, osToastSecret: 'k' }));
    const { createHmac } = await import('node:crypto');
    const context = '{}';
    const signature = createHmac('sha256', 'k').update(`archive\n${context}`).digest('base64url');
    const app = await launch(profile, '--standalone', '--', `bulwark://toast/archive?c=${encodeURIComponent(context)}&s=${signature}`);
    running = { app, page: await shownPage(app) };
    expect(await mainVisible(app)).toBe(true);
  });

  test('a real toast: Windows holds it with its buttons, and pressing one reaches the page through the activator', async () => {
    test.skip(!win);
    running = await launchStandalone(profile);
    const { app, page } = running;
    await listen(page);
    await os(page, 'setLocked(false)');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getFocusedWindow = () => null;
    });
    const context = JSON.stringify({ emailId: 'real-1', accountId: 'a1' });
    // The first toast of a process has no reply field: the activator isn't known to answer yet.
    await page.evaluate((id) => (window as unknown as { bulwarkDesktop: { os: { notify: (n: unknown) => Promise<unknown> } } }).bulwarkDesktop.os.notify({ id, title: 'Bulwark test first', body: '', context: '{}', reply: { label: 'Reply', placeholder: 'Type' } }), 'os-spec-first-toast');
    const result = await page.evaluate(([ctx]) => (window as unknown as { bulwarkDesktop: { os: { notify: (n: unknown) => Promise<unknown> } } }).bulwarkDesktop.os.notify({
      id: 'os-spec-real-toast',
      group: 'os-spec',
      title: 'Bulwark test',
      body: 'A toast from the test run',
      context: ctx,
      actions: [{ id: 'archive', label: 'Archive' }, { id: 'mark-read', label: 'Mark read' }, { id: 'delete', label: 'Delete' }],
      reply: { label: 'Reply', placeholder: 'Type a reply' },
    }), [context]);
    expect(result).toMatchObject({ shown: true });

    const script = path.join(ROOT, 'test', 'support', 'toast-readback.ps1');
    const readback = (tag = 'os-spec-real-toast') => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Aumid', 'org.bulwarkmail.desktop', '-Tag', tag], { encoding: 'utf8', windowsHide: true });
    let xml = '';
    await expect.poll(() => {
      xml = readback();
      return xml;
    }, { timeout: 15_000 }).toContain('Bulwark test');
    for (const label of ['Archive', 'Mark read', 'Delete', 'Reply']) expect(xml).toContain(`content="${label}"`);

    // Typed text only travels once this process has shown a toast: the first asks in the app, the next one inline.
    const firstToast = readback('os-spec-first-toast');
    expect(firstToast).toContain('Bulwark test first');
    expect(firstToast).toContain('content="Reply"');
    expect(firstToast).not.toContain('<input');
    expect(xml).toContain('<input');

    // A button is a protocol launch: a second instance with the URL off the toast itself.
    const buttons = [...xml.matchAll(/content="([^"]+)" activationType="protocol" arguments="([^"]+)"/g)].map((match) => [match[1], match[2].replace(/&amp;/g, '&')]);
    const url = (label: string) => buttons.find(([name]) => name === label)![1];
    const require = createRequire(import.meta.url);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const launchWith = (target: string) => new Promise<void>((resolve) => {
      spawn(require('electron') as unknown as string, [MAIN, `--bulwark-user-data=${profile}`, '--', target], { env, stdio: 'ignore' }).once('exit', () => resolve());
    });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await launchWith(url('Archive'));
    await expect.poll(() => commands(page), { timeout: 30_000 }).toEqual([{ type: 'notification', action: 'archive', context }]);
    // It leaves the window where it is.
    expect(await mainVisible(app)).toBe(false);

    // Anyone can link to one. Without this install's key it does nothing, and shows the app as any launch does.
    await launchWith(url('Delete').replace(/s=[^&]*$/, 's=forged'));
    await expect.poll(() => mainVisible(app), { timeout: 30_000 }).toBe(true);
    expect((await commands(page)).length).toBe(1);

    // A typed reply goes through the activator, and brings the window up.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    const activate = path.join(ROOT, 'test', 'support', 'toast-activate.ps1');
    const args = `bulwark:reply:${encodeURIComponent(context)}`;
    expect(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', activate, '-Clsid', DEV_CLSID, '-Aumid', 'org.bulwarkmail.desktop', '-Arguments', args, '-Reply', 'On my way'], { encoding: 'utf8', windowsHide: true })).toContain('activated');
    await expect.poll(async () => (await commands(page)).at(-1)).toEqual({ type: 'notification', action: 'reply', context, reply: 'On my way' });
    await expect.poll(() => mainVisible(app)).toBe(true);

    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Aumid', 'org.bulwarkmail.desktop', '-Tag', 'os-spec-real-toast', '-Clear'], { encoding: 'utf8', windowsHide: true });
  });

  test('badge, progress and thumbnail toolbar on the real window, jump list read back', async () => {
    test.skip(!win);
    running = await launchStandalone(profile);
    const { app, page } = running;
    await takeOverFromPage(app);
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as { __overlay: unknown[]; __progress: unknown[] };
      g.__overlay = [];
      g.__progress = [];
      const window = BrowserWindow.getAllWindows()[0];
      const overlay = window.setOverlayIcon.bind(window);
      window.setOverlayIcon = (image, description) => {
        g.__overlay.push(image ? { size: image.getSize(), empty: image.isEmpty(), description } : null);
        overlay(image, description);
      };
      const progress = window.setProgressBar.bind(window);
      window.setProgressBar = (value, options) => {
        g.__progress.push([value, options?.mode ?? null]);
        progress(value, options);
      };
    });

    await os(page, 'setBadge(7)');
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __overlay: unknown[] }).__overlay.length)).toBe(1);
    expect(await app.evaluate(() => (globalThis as unknown as { __overlay: unknown[] }).__overlay[0])).toEqual({ size: { width: 16, height: 16 }, empty: false, description: 'Bulwark: 7 unread' });
    expect(await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { tray: { iconState: () => unknown } } }).__bulwarkOs.tray.iconState())).toMatchObject({ unread: true });
    await os(page, 'setBadge(7)');
    await os(page, 'setBadge(0)');
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __overlay: unknown[] }).__overlay.length)).toBe(2);
    expect(await app.evaluate(() => (globalThis as unknown as { __overlay: unknown[] }).__overlay[1])).toBeNull();
    expect(await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { tray: { iconState: () => unknown } } }).__bulwarkOs.tray.iconState())).toMatchObject({ unread: false });

    await os(page, 'setProgress(0.4)');
    await os(page, `setProgress(0, 'indeterminate')`);
    await os(page, 'setProgress(null)');
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __progress: unknown[] }).__progress)).toEqual([[0.4, null], [2, 'indeterminate'], [-1, null]]);

    expect(await app.evaluate(({ BrowserWindow }) => (globalThis as unknown as { __bulwarkOs: { taskbar: { applyThumbar: (w: unknown) => boolean } } }).__bulwarkOs.taskbar.applyThumbar(BrowserWindow.getAllWindows()[0]))).toBe(hasTaskbar());

    expect(await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { taskbar: { jumpListResult: () => string } } }).__bulwarkOs.taskbar.jumpListResult())).toBe('ok');
    const settings = await app.evaluate(({ app: a }) => a.getJumpListSettings());
    expect(settings.minItems).toBeGreaterThan(0);

    await os(page, `setSummary({ unread: [], recent: [{ emailId: 'e1', accountId: 'a1', sender: 'Alice', subject: 'Lunch? On Friday' }], nextEvent: null })`);
    await page.waitForTimeout(2500);
    expect(await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { taskbar: { jumpListResult: () => string } } }).__bulwarkOs.taskbar.jumpListResult())).toBe('ok');

    await app.evaluate(({ app: a }) => a.setJumpList(null));
  });

  test('flash on new mail when set', async () => {
    test.skip(!win);
    running = await launchStandalone(profile);
    const { app, page } = running;
    await record(app);
    await os(page, 'setLocked(false)');
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as { __flash: boolean[] };
      g.__flash = [];
      const window = BrowserWindow.getAllWindows()[0];
      window.flashFrame = (flag) => { g.__flash.push(flag); };
      window.isFocused = () => false;
      BrowserWindow.getFocusedWindow = () => null;
      (globalThis as unknown as { __bulwarkOs: { toasts: { setFocusAssistForTest: (x: unknown) => void } } }).__bulwarkOs.toasts.setFocusAssistForTest('off');
    });
    const flashes = () => app.evaluate(() => (globalThis as unknown as { __flash: boolean[] }).__flash.filter(Boolean));
    await os(page, `notify({ id: 'f1', title: 'T', body: 'B', context: '', attention: true })`);
    expect(await flashes()).toEqual([true]);
    await os(page, 'setSettings({ attentionOnNewMail: false })');
    await os(page, `notify({ id: 'f2', title: 'T', body: 'B', context: '', attention: true })`);
    expect(await flashes()).toEqual([true]);
  });

  test('a mailto on a cold start waits for the page, and a file next to it is not opened', async () => {
    const other = path.join(profile, 'other.eml');
    writeFileSync(other, 'From: a@example.org\r\nSubject: Should not open\r\n\r\nBody\r\n');
    const app = await launch(profile, '--standalone', '--', 'mailto:a@example.org?subject=Hi', other);
    const page = await shownPage(app);
    running = { app, page };
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('bulwark:pending-mailto')).catch(() => null), { timeout: 60_000 }).toContain('a@example.org');
    await expect(page.getByRole('heading', { name: 'Should not open' })).toHaveCount(0);
  });

  test('an .eml on a cold start waits for the page; a second launch delivers at once', async () => {
    const eml = path.join(profile, 'hello.eml');
    writeFileSync(eml, 'From: Someone <someone@example.org>\r\nTo: me@example.org\r\nSubject: Cold start letter\r\nDate: Tue, 3 Nov 2026 09:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nBody\r\n');
    const app = await launch(profile, '--standalone', '--', eml);
    const page = await shownPage(app);
    running = { app, page };
    await record(app);

    // The page wasn't there when this was asked for. It took it once it was, signed in or not.
    await expect(page.getByRole('heading', { name: 'Cold start letter' })).toBeVisible({ timeout: 60_000 });

    await listen(page);
    // A real second launch, on the same profile, as the OS would start it.
    const require = createRequire(import.meta.url);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const second = spawn(require('electron') as unknown as string, [MAIN, `--bulwark-user-data=${profile}`, '--', 'webcal://example.org/cal.ics'], { env, stdio: 'ignore' });
    // The page takes it and goes to the calendar, which on a login page means a reload.
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('bulwark:pending-webcal')).catch(() => null), { timeout: 30_000 }).toContain('example.org/cal.ics');
    second.kill();
  });

  test('a file that is not there or too big says so instead of vanishing', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await record(app);
    await listen(page);
    await app.evaluate((_e, cwd) => (globalThis as unknown as { __bulwarkOs: { launch: { handle: (a: string[], c: string) => Promise<number> } } }).__bulwarkOs.launch.handle(['bulwark.exe', '--', 'gone.eml'], cwd), profile);
    await expect.poll(() => commands(page)).toEqual([{ type: 'files', reason: 'open', files: [], failed: ['gone.eml'] }]);
  });

  test('start at login: the login item is written, read back and removed', async () => {
    test.skip(!win);
    running = await launchStandalone(profile);
    const { app, page } = running;
    const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    expect(reg('query', RUN, '/v', 'Bulwark Dev').ok).toBe(false);

    await os(page, 'setSettings({ startAtLogin: true })');
    const run = reg('query', RUN, '/v', 'Bulwark Dev');
    expect(run.ok).toBe(true);
    expect(run.out).toContain('--bulwark-from-login');
    expect(await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { readLoginItem: () => { openAtLogin: boolean } } }).__bulwarkOs.readLoginItem().openAtLogin)).toBe(true);

    await os(page, 'setSettings({ startAtLogin: false })');
    expect(reg('query', RUN, '/v', 'Bulwark Dev').ok).toBe(false);
    expect(await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { readLoginItem: () => { openAtLogin: boolean } } }).__bulwarkOs.readLoginItem().openAtLogin)).toBe(false);
  });

  test('started at login with minimise on: no window, and the app is running; without the setting a window', async () => {
    writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({ mode: 'standalone', os: { startMinimized: true } }));
    const app = await launch(profile, '--standalone', '--bulwark-from-login');
    running = { app, page: null as unknown as Page };
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      return !!main && !main.webContents.isLoading() && main.webContents.getURL().startsWith('https://');
    }), { timeout: 120_000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 7000)); // Past the show fallback.
    expect(await mainVisible(app)).toBe(false);
    await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { ctx: { showMain: () => void } } } }).__bulwarkOs.hub.ctx.showMain());
    await expect.poll(() => mainVisible(app)).toBe(true);
    await app.close();
    running = null;

    // Without the flag the same setting doesn't hide anything: an ordinary start shows.
    const again = await launch(profile, '--standalone');
    running = { app: again, page: await shownPage(again) };
    expect(await mainVisible(again)).toBe(true);
  });

  test('default mail app: keys under HKCU read back, the button opens Settings, and they go again', async () => {
    test.skip(!win);
    running = await launchStandalone(profile);
    const { app, page } = running;
    await record(app);
    const before = reg('query', 'HKCU\\Software\\RegisteredApplications', '/v', 'Bulwark').ok;
    expect(before).toBe(false);
    try {
      const status = await os(page, 'openDefaultAppSettings()') as { registered: boolean };
      expect((await recorded(app)).opened).toEqual(['ms-settings:defaultapps?registeredAppUser=Bulwark']);
      expect(status.registered).toBe(true);
      expect(reg('query', 'HKCU\\Software\\RegisteredApplications', '/v', 'Bulwark').out).toContain('Software\\Bulwark\\Capabilities');
      expect(reg('query', 'HKCU\\Software\\Bulwark\\Capabilities\\UrlAssociations', '/v', 'mailto').out).toContain('Bulwark.Url.mailto');
      expect(reg('query', 'HKCU\\Software\\Bulwark\\Capabilities\\FileAssociations', '/v', '.ics').out).toContain('Bulwark.File.ics');
      const command = reg('query', 'HKCU\\Software\\Classes\\Bulwark.Url.mailto\\shell\\open\\command', '/ve').out;
      expect(command).toContain('-- "%1"');
    } finally {
      await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { defaultApp: { unregister: () => Promise<void> } } }).__bulwarkOs.defaultApp.unregister());
    }
    expect(reg('query', 'HKCU\\Software\\RegisteredApplications', '/v', 'Bulwark').ok).toBe(false);
    expect(reg('query', 'HKCU\\Software\\Bulwark').ok).toBe(false);
    expect(reg('query', 'HKCU\\Software\\Classes\\Bulwark.Url.mailto').ok).toBe(false);
    expect((await os(page, 'defaultAppStatus()') as { registered: boolean }).registered).toBe(false);
  });

  test('drag-out: a real file in the private folder, safely named and marked, before the drag starts', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as { __drag: unknown[] };
      g.__drag = [];
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      // A drag needs the mouse held. What it's handed, and that the file is there by then, is what's ours.
      contents.startDrag = (item) => { g.__drag.push({ ...item, icon: undefined }); };
    });
    const ok = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { os: { startDrag: (f: unknown) => Promise<boolean> } } }).bulwarkDesktop.os.startDrag([
      { name: '..\\..\\evil:name?.eml', data: new TextEncoder().encode('Subject: x') },
      { name: 'evil_name_.eml', data: new TextEncoder().encode('second') },
    ]));
    expect(ok).toBe(true);
    const [drag] = await app.evaluate(() => (globalThis as unknown as { __drag: { file: string; files: string[] }[] }).__drag);
    expect(drag.files.length).toBe(2);
    const base = path.join(profile, 'os-files');
    for (const file of drag.files) expect(file.startsWith(base)).toBe(true);
    expect(readFileSync(drag.files[0], 'utf8')).toBe('Subject: x');
    expect(path.basename(drag.files[0])).toBe('_.._evil_name_.eml');
    // Where a roaming profile doesn't carry it: this is a development run, so under its profile.
    expect(readFileSync(drag.files[1], 'utf8')).toBe('second');
    if (win) expect(readFileSync(`${drag.files[0]}:Zone.Identifier`, 'utf8')).toContain('ZoneId=3');

    expect(await os(page, 'startDrag([])')).toBe(false);
    expect(await os(page, `startDrag([{ name: 'x', data: 'not bytes' }])`)).toBe(false);

    // Nothing remains after a quit, nor from a crash at the next start.
    await running.app.close();
    running = null;
    expect(existsSync(base) ? readdirSync(base) : []).toEqual([]);
  });

  test('copy as a file puts a real file on the clipboard', async () => {
    test.skip(!win);
    running = await launchStandalone(profile);
    const { app, page } = running;
    const saved = await app.evaluate(({ clipboard }) => clipboard.readText());
    try {
      const ok = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { os: { copyFiles: (f: unknown) => Promise<boolean> } } }).bulwarkDesktop.os.copyFiles([{ name: 'note.txt', data: new TextEncoder().encode('hello') }]));
      expect(ok).toBe(true);
      const listed = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'], { encoding: 'utf8', windowsHide: true }).trim();
      expect(path.basename(listed)).toBe('note.txt');
      expect(listed.startsWith(path.join(profile, 'os-files'))).toBe(true);
      expect(readFileSync(listed, 'utf8')).toBe('hello');
    } finally {
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved);
    }
  });

  test('sleep, wake, lock and unlock reach the page', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await listen(page);
    for (const event of ['suspend', 'resume', 'lock-screen', 'unlock-screen']) {
      await app.evaluate(({ powerMonitor }, name) => powerMonitor.emit(name as 'resume'), event);
    }
    await expect.poll(() => page.evaluate(() => (window as unknown as { __power: string[] }).__power)).toEqual(['suspend', 'resume', 'lock-screen', 'unlock-screen']);
  });

  test('"Show Bulwark" holds its shortcut only while set', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    const held = () => app.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), SHOW_SHORTCUT);
    expect(await held()).toBe(false);
    const status = await os(page, `setSettings({ showShortcut: '${SHOW_SHORTCUT}' })`) as { shortcutActive: boolean };
    expect(status.shortcutActive).toBe(true);
    expect(await held()).toBe(true);
    await os(page, 'setSettings({ showShortcut: null })');
    expect(await held()).toBe(false);
  });
});
