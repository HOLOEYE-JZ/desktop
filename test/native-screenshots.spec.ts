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

test('the desktop app, as it looks', async () => {
  test.setTimeout(600_000);
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
    await expect.poll(async () => {
      if (await page.locator(`[data-email-id="${ids[0]}"]`).count()) return true;
      await page.keyboard.press('Shift+G').catch(() => {});
      return false;
    }, { timeout: 60_000, intervals: [1500] }).toBe(true);
    await holdMenus(app);
    const mainId = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setBounds({ x: 60, y: 40, width: 1240, height: 780 });
      // Other things run on this desktop, and a picture of them is no use.
      window.setAlwaysOnTop(true, 'screen-saver');
      window.show();
      window.moveTop();
      window.focus();
      return window.id;
    });
    await page.waitForTimeout(800);

    // The integrated title bar, in both themes.
    await setTheme(page, 'light');
    await page.locator(`[data-email-id="${ids[0]}"]`).click();
    await page.waitForTimeout(1200);
    await capture(app, [mainId], 'titlebar-light');
    await setTheme(page, 'dark');
    await capture(app, [mainId], 'titlebar-dark');

    // Mountain View takes the same title bar.
    await setTheme(page, 'light');
    await setLayout(page, 'mountain-view');
    await capture(app, [mainId], 'titlebar-mountain-view');
    await setLayout(page, 'default');
    await page.waitForTimeout(500);

    // The menu bar: Alt, then File, natively.
    await app.evaluate(({ BrowserWindow }) => {
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

    // Two windows side by side.
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
  } finally {
    await app.close().catch(() => {});
    removeProfile(profile);
    await destroyMessages(SERVER, ACCOUNT, ENT_PASSWORD, ids).catch(() => {});
  }
});
