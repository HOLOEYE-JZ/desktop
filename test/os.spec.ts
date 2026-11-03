import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
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

function reg(...args: string[]): { ok: boolean; out: string } {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, out: result.stdout ?? '' };
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
    const closed = app.waitForEvent('close');
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
    const closed = app.waitForEvent('close');
    await clickTray(app, 'Quit Bulwark');
    await closed;
    running = null;
  });

  test('the tray: left click toggles, and the menu shows unread and the next event unless locked', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await record(app);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { tray: { tray: Electron.Tray } } }).__bulwarkOs.tray.tray.emit('click'));
    await expect.poll(() => mainVisible(app)).toBe(false);
    await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { tray: { tray: Electron.Tray } } }).__bulwarkOs.tray.tray.emit('click'));
    await expect.poll(() => mainVisible(app)).toBe(true);

    const before = (await trayItems(app)).map((i) => i.label);
    expect(before).toEqual(expect.arrayContaining(['New message', 'Pause notifications', 'Open Bulwark', 'Quit Bulwark']));

    await os(page, `setSummary({ unread: [{ emailId: 'e1', accountId: 'a1', sender: 'Alice & Co', subject: 'Lunch?' }], recent: [{ emailId: 'e1', accountId: 'a1', sender: 'Alice', subject: 'Lunch?' }], nextEvent: { title: 'Standup', when: '09:30' } })`);
    await expect.poll(async () => (await trayItems(app)).map((i) => i.label)).toContain('Alice && Co: Lunch?');
    expect((await trayItems(app)).map((i) => i.label)).toContain('Next: Standup, 09:30');
    expect((await trayItems(app)).find((i) => i.label === 'Unread')?.enabled).toBe(false);

    // Locked: not a word of it in the menu, nor in the jump list that's rebuilt with it.
    await os(page, 'setLocked(true)');
    await expect.poll(async () => JSON.stringify(await trayItems(app))).not.toContain('Lunch');
    expect(JSON.stringify(await trayItems(app))).not.toContain('Standup');
    await os(page, 'setLocked(false)');
    await expect.poll(async () => JSON.stringify(await trayItems(app))).toContain('Lunch');
  });

  test('tray and jump list items reach the page as commands, in order, shown or not', async () => {
    running = await launchStandalone(profile);
    const { app, page } = running;
    await record(app);
    await listen(page);
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
    await record(app);
    const send = (id: string, extra = '') => os(page, `notify({ id: '${id}', title: 'Alice', body: 'Lunch?', context: 'ctx', sound: true, actions: [{ id: 'archive', label: 'Archive' }], reply: { label: 'Reply', placeholder: 'Type' }${extra} })`) as Promise<{ shown: boolean; reason?: string; playSound: boolean }>;
    const setAssist = (value: string | null) => app.evaluate((_e, v) => (globalThis as unknown as { __bulwarkOs: { toasts: { setFocusAssistForTest: (x: unknown) => void } } }).__bulwarkOs.toasts.setFocusAssistForTest(v), value);
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

  test('a real toast: Windows holds it with its buttons, and pressing one reaches the page through the activator', async () => {
    test.skip(!win);
    running = await launchStandalone(profile);
    const { app, page } = running;
    await listen(page);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getFocusedWindow = () => null;
    });
    const context = JSON.stringify({ emailId: 'real-1', accountId: 'a1' });
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
    const readback = () => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Aumid', 'org.bulwarkmail.desktop', '-Tag', 'os-spec-real-toast'], { encoding: 'utf8', windowsHide: true });
    let xml = '';
    await expect.poll(() => {
      xml = readback();
      return xml;
    }, { timeout: 15_000 }).toContain('Bulwark test');
    for (const label of ['Archive', 'Mark read', 'Delete', 'Reply']) expect(xml).toContain(`content="${label}"`);

    const activate = path.join(ROOT, 'test', 'support', 'toast-activate.ps1');
    const fire = (action: string, reply = '') => {
      const args = `bulwark:${encodeURIComponent(action)}:${encodeURIComponent(context)}`;
      return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', activate, '-Clsid', DEV_CLSID, '-Aumid', 'org.bulwarkmail.desktop', '-Arguments', args, '-Reply', reply], { encoding: 'utf8', windowsHide: true });
    };
    expect(fire('archive')).toContain('activated');
    await expect.poll(() => commands(page)).toEqual([{ type: 'notification', action: 'archive', context }]);
    // A button leaves the window where it is.
    expect(await mainVisible(app)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    expect(fire('mark-read')).toContain('activated');
    await expect.poll(async () => (await commands(page)).length).toBe(2);
    expect(await mainVisible(app)).toBe(false);
    // A typed reply and a click bring it up.
    expect(fire('reply', 'On my way')).toContain('activated');
    await expect.poll(async () => (await commands(page)).at(-1)).toEqual({ type: 'notification', action: 'reply', context, reply: 'On my way' });
    await expect.poll(() => mainVisible(app)).toBe(true);

    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Aumid', 'org.bulwarkmail.desktop', '-Tag', 'os-spec-real-toast', '-Clear'], { encoding: 'utf8', windowsHide: true });
  });

  test('badge, progress and thumbnail toolbar on the real window, jump list read back', async () => {
    test.skip(!win);
    running = await launchStandalone(profile);
    const { app, page } = running;
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

    expect(await app.evaluate(({ BrowserWindow }) => (globalThis as unknown as { __bulwarkOs: { taskbar: { applyThumbar: (w: unknown) => boolean } } }).__bulwarkOs.taskbar.applyThumbar(BrowserWindow.getAllWindows()[0]))).toBe(true);

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
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as { __flash: boolean[] };
      g.__flash = [];
      const window = BrowserWindow.getAllWindows()[0];
      window.flashFrame = (flag) => { g.__flash.push(flag); };
      window.isFocused = () => false;
      BrowserWindow.getFocusedWindow = () => null;
      (globalThis as unknown as { __bulwarkOs: { toasts: { setFocusAssistForTest: (x: unknown) => void } } }).__bulwarkOs.toasts.setFocusAssistForTest('off');
    });
    const flashes = () => app.evaluate(() => (globalThis as unknown as { __flash: boolean[] }).__flash);
    await os(page, `notify({ id: 'f1', title: 'T', body: 'B', context: '', attention: true })`);
    expect(await flashes()).toEqual([true]);
    await os(page, 'setSettings({ attentionOnNewMail: false })');
    await os(page, `notify({ id: 'f2', title: 'T', body: 'B', context: '', attention: true })`);
    expect(await flashes()).toEqual([true]);
  });

  test('a mailto and an .eml on a cold start wait for the page; a second launch delivers at once', async () => {
    const eml = path.join(profile, 'hello.eml');
    writeFileSync(eml, 'Subject: Hi\r\n\r\nBody');
    const app = await launch(profile, '--standalone', '--', 'mailto:a@example.org?subject=Hi', eml);
    const page = await shownPage(app);
    running = { app, page };
    await record(app);
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { pendingCount: () => number } } }).__bulwarkOs.hub.pendingCount())).toBe(2);

    await listen(page);
    await expect.poll(async () => (await commands(page)).length).toBe(2);
    const [mailto, file] = await page.evaluate(() => (window as unknown as { __cmds: { type: string; reason?: string; url?: string; files?: { name: string; data: Uint8Array }[] }[] }).__cmds.map((c) => ({ ...c, files: c.files?.map((f) => ({ name: f.name, text: new TextDecoder().decode(f.data) })) })));
    expect(mailto).toEqual({ type: 'mailto', url: 'mailto:a@example.org?subject=Hi' });
    expect(file).toMatchObject({ type: 'files', reason: 'open', failed: [], files: [{ name: 'hello.eml', text: 'Subject: Hi\r\n\r\nBody' }] });

    // A real second launch, on the same profile, as the OS would start it.
    const require = createRequire(import.meta.url);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const second = spawn(require('electron') as unknown as string, [MAIN, `--bulwark-user-data=${profile}`, '--', 'webcal://example.org/cal.ics'], { env, stdio: 'ignore' });
    await expect.poll(async () => (await commands(page)).at(-1), { timeout: 30_000 }).toEqual({ type: 'webcal', url: 'webcal://example.org/cal.ics' });
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
