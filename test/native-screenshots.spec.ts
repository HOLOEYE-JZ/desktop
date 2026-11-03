import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT, ENT_PASSWORD, expectMailShown, fillLogin, launchStandalone, removeProfile, SCREENSHOTS, STALWARTS, tempProfile } from './helpers';
import { destroyMessages, pageWith, seedMessage } from './native-helpers';

/**
 * Pictures of the real thing, native parts included, taken from the screen. Needs an
 * unlocked desktop, so it only runs when asked:
 *   BULWARK_SHOTS=1 BULWARK_TEST_WEBMAIL=<dir> vw exec --env IT_ENT_PASSWORD=... -- npx playwright test test/native-screenshots.spec.ts
 */
test.skip(!process.env.BULWARK_SHOTS || process.platform !== 'win32', 'run with BULWARK_SHOTS=1, on Windows');

const SERVER = STALWARTS[0].url;

const CAPTURE = String.raw`
param([int]$x, [int]$y, [int]$w, [int]$h, [string]$out)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System.Runtime.InteropServices;
public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@
[Dpi]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap $w, $h
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)
$bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
`;

async function capture(app: ElectronApplication, ids: number[] | null, name: string, grow = { right: 0, bottom: 0 }): Promise<void> {
  const area = await app.evaluate(({ BrowserWindow, screen }, wanted) => {
    const windows = BrowserWindow.getAllWindows().filter((w) => w.isVisible() && (!wanted || wanted.includes(w.id)));
    const boxes = windows.map((w) => w.getBounds());
    const left = Math.min(...boxes.map((b) => b.x));
    const top = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height));
    const scale = screen.getDisplayMatching(boxes[0]).scaleFactor;
    return { x: Math.round(left * scale), y: Math.round(top * scale), w: Math.round((right - left) * scale), h: Math.round((bottom - top) * scale) };
  }, ids);
  const script = path.join(tmpdir(), `bulwark-capture-${process.pid}.ps1`);
  writeFileSync(script, CAPTURE);
  const out = path.join(SCREENSHOTS, `desktop-${name}.png`);
  const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, String(area.x), String(area.y), String(area.w + grow.right), String(area.h + grow.bottom), out], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
}

/** Puts the real pointer there: a native menu opens where the OS has it. */
function moveCursor(x: number, y: number): void {
  const script = path.join(tmpdir(), `bulwark-cursor-${process.pid}.ps1`);
  writeFileSync(script, `Add-Type @'
using System.Runtime.InteropServices;
public static class P { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }
'@
[P]::SetProcessDPIAware() | Out-Null
[P]::SetCursorPos(${x}, ${y}) | Out-Null
`);
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]);
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    const key = 'theme-storage';
    const stored = JSON.parse(localStorage.getItem(key) ?? '{"state":{}}');
    stored.state.theme = value;
    stored.state.themeChosen = true;
    localStorage.setItem(key, JSON.stringify(stored));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  }, theme);
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(theme === 'dark');
  await page.waitForTimeout(600);
}

async function setLayout(page: Page, layout: 'default' | 'mountain-view'): Promise<void> {
  await page.evaluate((value) => {
    const key = 'settings-storage';
    const stored = JSON.parse(localStorage.getItem(key) ?? '{"state":{}}');
    stored.state.interfaceLayout = value;
    localStorage.setItem(key, JSON.stringify(stored));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  }, layout);
  await page.waitForTimeout(800);
}

/** The real pointer and buttons, in screen pixels: what the OS's own hit test sees. */
function realMouse(steps: { x: number; y: number; press?: 'down' | 'up' | 'click' }[]): void {
  const script = path.join(tmpdir(), `bulwark-mouse-${process.pid}.ps1`);
  const lines = steps.map(({ x, y, press }) => {
    const buttons = press === 'down' ? '[M]::mouse_event(2,0,0,0,0)' : press === 'up' ? '[M]::mouse_event(4,0,0,0,0)' : press === 'click' ? '[M]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 60; [M]::mouse_event(4,0,0,0,0)' : '';
    return `[M]::SetCursorPos(${x}, ${y}) | Out-Null; Start-Sleep -Milliseconds 100; ${buttons}; Start-Sleep -Milliseconds 100`;
  });
  writeFileSync(script, `Add-Type @'
using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, uint e);
}
'@
[M]::SetProcessDPIAware() | Out-Null
${lines.join('\n')}
`);
  const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
}

/** A point in the page, in screen pixels. */
const onScreen = (app: ElectronApplication, x: number, y: number) => app.evaluate(({ BrowserWindow, screen }, [px, py]) => {
  const window = BrowserWindow.getAllWindows()[0];
  const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
  const content = window.getContentBounds();
  return { x: Math.round((content.x + px) * scale), y: Math.round((content.y + py) * scale) };
}, [x, y] as const);

const boundsOf = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows()[0];
  return { ...window.getBounds(), maximized: window.isMaximized() };
});

const pinWindow = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows()[0];
  window.setBounds({ x: 60, y: 40, width: 1240, height: 780 });
  window.setAlwaysOnTop(true, 'screen-saver');
  window.show();
  window.moveTop();
  window.focus();
  return window.id;
});

const dragWorks = async (app: ElectronApplication, x: number, y: number) => {
  const before = await boundsOf(app);
  const from = await onScreen(app, x, y);
  realMouse([
    { ...from },
    { ...from, press: 'down' },
    { x: from.x + 30, y: from.y + 20 },
    { x: from.x + 70, y: from.y + 50 },
    { x: from.x + 70, y: from.y + 50, press: 'up' },
  ]);
  await expect.poll(() => boundsOf(app).then((now) => now.x !== before.x || now.y !== before.y), { timeout: 3000 }).toBe(true);
  await app.evaluate(({ BrowserWindow }, box) => BrowserWindow.getAllWindows()[0].setBounds(box), { x: before.x, y: before.y, width: before.width, height: before.height });
};

/** Keeps a native menu reachable, so the test can close it after the picture. */
async function holdMenus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const original = Menu.prototype.popup;
    Menu.prototype.popup = function popup(this: Electron.Menu, ...args: unknown[]) {
      (globalThis as unknown as { __held: Electron.Menu }).__held = this;
      return (original as (...a: unknown[]) => void).apply(this, args);
    } as never;
  });
}

const closeHeld = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __held?: Electron.Menu }).__held?.closePopup());

// The real mouse goes wherever the OS says, so this wants a desktop no other test is using.
test('a real mouse: drag, double-click and clicks through the rows', async () => {
  test.setTimeout(240_000);
  const profile = tempProfile('mouse');
  const { app, page } = await launchStandalone(profile);
  try {
    await page.locator('#username').waitFor({ timeout: 90_000 });
    await pinWindow(app);
    await page.waitForTimeout(800);
    // The login has no row of its own, and still moves.
    await dragWorks(app, 500, 25);
    const field = (await page.locator('#username').boundingBox())!;
    const fieldAt = await onScreen(app, field.x + 40, field.y + field.height / 2);
    realMouse([{ ...fieldAt, press: 'click' }]);
    await expect(page.locator('#username')).toBeFocused();

    await fillLogin(page, SERVER, ACCOUNT, ENT_PASSWORD);
    await page.keyboard.press('Enter');
    await expectMailShown(page);
    await pinWindow(app);
    await page.waitForTimeout(1000);

    // A row's empty part drags: the sidebar's, the list's, the reader's.
    const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await dragWorks(app, viewport.width - 400, 25);
    // The rail's empty middle does too.
    await dragWorks(app, 25, 380);

    // Windows' own hover on the real buttons, and Snap Layouts on maximise.
    const area = await page.evaluate(() => {
      const rect = (navigator as unknown as { windowControlsOverlay: { getTitlebarAreaRect(): { x: number; width: number; height: number } } }).windowControlsOverlay.getTitlebarAreaRect();
      return { left: rect.x + rect.width, height: rect.height };
    });
    const button = (innerWidth: number) => (innerWidth - area.left) / 3;
    const close = await onScreen(app, area.left + button(viewport.width) * 2.5, area.height / 2);
    realMouse([{ ...close }]);
    await page.waitForTimeout(500);
    await capture(app, null, 'chrome-hover-close', { right: 0, bottom: 0 });
    const maximise = await onScreen(app, area.left + button(viewport.width) * 1.5, area.height / 2);
    realMouse([{ ...maximise }]);
    await page.waitForTimeout(1500);
    await capture(app, null, 'chrome-hover-maximise', { right: 0, bottom: 0 });
    realMouse([{ x: maximise.x - 400, y: maximise.y + 400 }]);

    // Double-click maximises, and again restores, as on a title bar.
    const band = await onScreen(app, viewport.width - 400, 25);
    realMouse([{ ...band, press: 'click' }, { ...band, press: 'click' }]);
    await expect.poll(() => boundsOf(app).then((now) => now.maximized), { timeout: 5000 }).toBe(true);
    await page.waitForTimeout(1000);
    const bandMax = await onScreen(app, 800, 25);
    realMouse([{ ...bandMax, press: 'click' }, { ...bandMax, press: 'click' }]);
    await expect.poll(() => boundsOf(app).then((now) => now.maximized), { timeout: 5000 }).toBe(false);
    await page.waitForTimeout(1000);

    // What's in a row stays a thing to click.
    const search = page.locator('[data-window-row] input').first();
    const box = (await search.boundingBox())!;
    const at = await onScreen(app, box.x + box.width / 2, box.y + box.height / 2);
    realMouse([{ ...at, press: 'click' }]);
    await expect(search).toBeFocused();

  } finally {
    await app.close().catch(() => {});
    removeProfile(profile);
  }
});

test('the desktop app, as it looks', async () => {
  test.setTimeout(900_000);
  const profile = tempProfile('shots');
  const ids: string[] = [];
  for (const [subject, body] of [
    ['Quarterly numbers for review', 'Hi, the numbers are attached to the shared folder. Could you look at them before Thursday?'],
    ['Lunch on Friday?', 'The new place on the corner has opened. Twelve thirty?'],
    ['Your trip to Hildesheim', 'Your booking is confirmed. Check-in opens the day before.'],
  ]) {
    ids.push(await seedMessage(SERVER, ACCOUNT, ENT_PASSWORD, subject, body));
  }
  const { app, page } = await launchStandalone(profile);
  try {
    await fillLogin(page, SERVER, ACCOUNT, ENT_PASSWORD);
    await page.keyboard.press('Enter');
    await expectMailShown(page);
    await expect(page.locator(`[data-email-id="${ids[0]}"]`)).toBeAttached({ timeout: 60_000 });
    await holdMenus(app);
    // Other things run on this desktop, and a picture of them is no use.
    const mainId = await pinWindow(app);
    await page.waitForTimeout(800);

    // No title row anywhere: every page, its own top row under the window's controls.
    const visit = async (url: string) => {
      await page.evaluate((to) => {
        window.location.href = to;
      }, url);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2500);
    };
    const setPro = (on: boolean) => page.evaluate((value) => {
      const stored = JSON.parse(localStorage.getItem('settings-storage') ?? '{"state":{}}');
      stored.state.proInterface = value;
      localStorage.setItem('settings-storage', JSON.stringify(stored));
    }, on);
    // The shell without a real admin session: the page's own data isn't the point here.
    await page.route('**/api/admin/auth', (route) => route.fulfill({ json: { enabled: true, authenticated: true } }));
    const pages = ['calendar', 'contacts', 'files', 'settings', 'admin', 'pro'];
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await capture(app, [mainId], `chrome-mail-empty-${theme}`);
      await page.locator(`[data-email-id="${ids[0]}"]`).click();
      await page.waitForTimeout(1200);
      await capture(app, [mainId], `chrome-mail-message-${theme}`);
      for (const name of pages) {
        if (theme === 'dark' && name !== 'calendar' && name !== 'settings') continue;
        if (name === 'pro') await setPro(true);
        await visit(`/${name}`);
        await capture(app, [mainId], `chrome-${name}-${theme}`);
        if (name === 'pro') await setPro(false);
      }
      await visit('/');
      await page.locator(`[data-email-id="${ids[0]}"]`).waitFor({ timeout: 60_000 });
    }
    await setTheme(page, 'light');

    // Mountain View takes the same chrome.
    await setLayout(page, 'mountain-view');
    await capture(app, [mainId], 'chrome-mountain-view-light');
    await setTheme(page, 'dark');
    await capture(app, [mainId], 'chrome-mountain-view-dark');
    await setTheme(page, 'light');
    await setLayout(page, 'default');
    await page.waitForTimeout(500);

    // The menu: Alt floats it, and a name opens it natively.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].focus();
      const { webContents } = BrowserWindow.getAllWindows()[0];
      webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Alt' } as never);
      webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Alt' } as never);
    });
    const strip = page.locator('[data-window-menu-bar]');
    await strip.waitFor({ timeout: 5000 });
    await strip.getByRole('menuitem', { name: 'Message' }).click();
    await page.waitForTimeout(700);
    await capture(app, [mainId], 'menu-bar');
    await closeHeld(app);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // A right-click on a message.
    const row = (await page.locator(`[data-email-id="${ids[1]}"]`).boundingBox())!;
    const point = await app.evaluate(({ BrowserWindow, screen }, [px, py]) => {
      const window = BrowserWindow.getAllWindows()[0];
      const scale = screen.getDisplayMatching(window.getBounds()).scaleFactor;
      const content = window.getContentBounds();
      return { x: Math.round((content.x + px) * scale), y: Math.round((content.y + py) * scale) };
    }, [row.x + 180, row.y + 30] as const);
    moveCursor(point.x, point.y);
    await page.locator(`[data-email-id="${ids[1]}"]`).click({ button: 'right' });
    await page.waitForTimeout(800);
    await capture(app, [mainId], 'context-menu');
    await closeHeld(app);
    await page.waitForTimeout(300);

    // Pop-outs, in both themes, and two windows side by side.
    await page.locator(`[data-email-id="${ids[2]}"]`).dblclick();
    const message = await pageWith(app, '/popout/message/');
    await expect(message.locator('body')).toContainText('Your booking is confirmed', { timeout: 60_000 });
    const popoutId = await app.evaluate(({ BrowserWindow }) => {
      const [main, popout] = [BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'))!, BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/'))!];
      main.setBounds({ x: 20, y: 40, width: 980, height: 760 });
      popout.setBounds({ x: 1010, y: 40, width: 760, height: 760 });
      main.setAlwaysOnTop(true, 'screen-saver');
      popout.setAlwaysOnTop(true, 'screen-saver');
      main.moveTop();
      popout.moveTop();
      popout.focus();
      return popout.id;
    });
    await page.waitForTimeout(1200);
    await capture(app, [mainId, popoutId], 'two-windows');
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await capture(app, [popoutId], `chrome-popout-message-${theme}`);
    }
    await setTheme(page, 'light');
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.hide(), popoutId);
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { openComposer: (t: object) => void } } }).bulwarkDesktop.windows.openComposer({ url: '/popout/compose', name: 'shots' }));
    const composer = await pageWith(app, '/popout/compose');
    await composer.locator('[data-composer-header]').waitFor({ timeout: 60_000 });
    const composerId = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/compose'))!;
      window.setBounds({ x: 200, y: 60, width: 780, height: 700 });
      window.setAlwaysOnTop(true, 'screen-saver');
      window.moveTop();
      return window.id;
    });
    await page.waitForTimeout(1200);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await capture(app, [composerId], `chrome-popout-composer-${theme}`);
    }
  } finally {
    await app.close().catch(() => {});
    removeProfile(profile);
    await destroyMessages(SERVER, ACCOUNT, ENT_PASSWORD, ids).catch(() => {});
  }
});
