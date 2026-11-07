// The app behind the print preview stays still: no sidebar folding and unfolding, nothing
// moving, while the preview is open and makes its pages again. Every print source on the
// webmail's demo data, with every frame the main window paints compared to the one before
// the change. Needs a webmail build (BULWARK_TEST_WEBMAIL). Printers are fake, nothing is
// sent. BULWARK_SCREENSHOTS keeps the most changed frame of each source as a picture, named
// with PRINT_STILL_LABEL (before/after).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { expectMailShown, fakeOsIntegration, launchStandalone, removeProfile, SCREENSHOTS, tempProfile, waitForLogin } from './helpers';

test.skip(!process.env.BULWARK_TEST_WEBMAIL, 'needs a webmail build in BULWARK_TEST_WEBMAIL');

const FAKE = {
  printers: [{ name: 'Office Laser', displayName: 'Office Laser', options: {} }],
  defaultPrinter: 'Office Laser',
  jobs: [] as unknown[],
  renders: [] as string[],
};
/** Share of the window's pixels a frame may differ by: a focus ring, not a sidebar. */
const STILL = 0.005;

let profile = '';
let app: ElectronApplication;
let page: Page;

function previewWindows() {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((w) => {
    if (w.isDestroyed() || !w.webContents?.getURL().startsWith('data:') || !w.isVisible()) return [];
    return [w.id];
  }));
}

const used = new Set<Page>();
async function previewPage(): Promise<Page> {
  await expect.poll(async () => (await previewWindows()).length, { timeout: 30_000 }).toBe(1);
  const fresh = () => app.windows().find((p) => !used.has(p) && !p.isClosed() && p.url().startsWith('data:'));
  await expect.poll(() => Boolean(fresh()), { timeout: 15_000 }).toBe(true);
  const found = fresh()!;
  used.add(found);
  await found.waitForFunction(() => document.getElementById('title')?.textContent);
  return found;
}

async function rendered(preview: Page, count: number): Promise<void> {
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkFakePrinting: { renders: string[] } }).__bulwarkFakePrinting.renders.length), { timeout: 30_000 }).toBeGreaterThanOrEqual(count);
  await expect(preview.locator('#status')).toHaveText('', { timeout: 30_000 });
}

/**
 * From now on, every frame the main window paints, against the window as it is now:
 * the largest share of pixels that differ, and that frame.
 */
async function watchFrames(): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith('https://app.bulwark.localhost'))!;
    const base = await main.webContents.capturePage();
    const g = globalThis as unknown as { __frames: { worst: number; count: number; png: string; base: string } };
    const baseBits = base.toBitmap();
    const size = base.getSize();
    g.__frames = { worst: 0, count: 0, png: '', base: base.toPNG().toString('base64') };
    main.webContents.beginFrameSubscription(false, (image) => {
      const frame = image.getSize();
      if (frame.width !== size.width || frame.height !== size.height) return;
      const bits = image.toBitmap();
      let changed = 0;
      for (let i = 0; i < bits.length; i += 4) {
        if (Math.abs(bits[i] - baseBits[i]) > 24 || Math.abs(bits[i + 1] - baseBits[i + 1]) > 24 || Math.abs(bits[i + 2] - baseBits[i + 2]) > 24) changed += 1;
      }
      const share = changed / (bits.length / 4);
      g.__frames.count += 1;
      if (share > g.__frames.worst) {
        g.__frames.worst = share;
        g.__frames.png = image.toPNG().toString('base64');
      }
    });
  });
}

async function stopWatching(name: string): Promise<{ worst: number; count: number }> {
  const result = await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith('https://app.bulwark.localhost'))!;
    main.webContents.endFrameSubscription();
    return (globalThis as unknown as { __frames: { worst: number; count: number; png: string; base: string } }).__frames;
  });
  if (process.env.BULWARK_SCREENSHOTS) {
    mkdirSync(SCREENSHOTS, { recursive: true });
    const label = process.env.PRINT_STILL_LABEL ?? 'run';
    writeFileSync(path.join(SCREENSHOTS, `print-still-${label}-${name}-start.png`), Buffer.from(result.base, 'base64'));
    // The frame that differed most; none differing, the window stayed as it started.
    if (result.png) writeFileSync(path.join(SCREENSHOTS, `print-still-${label}-${name}-worst.png`), Buffer.from(result.png, 'base64'));
  }
  return { worst: result.worst, count: result.count };
}

/**
 * The preview over the window: once its pages are in (or for Ctrl+P, from when it shows),
 * the window is the picture to keep.
 * Then landscape, portrait again (two more renders), and Escape.
 */
async function previewStaysStill(name: string, open: () => Promise<void>, { fromStart = false } = {}): Promise<void> {
  const before = await app.evaluate(() => (globalThis as unknown as { __bulwarkFakePrinting: { renders: string[] } }).__bulwarkFakePrinting.renders.length);
  await open();
  const preview = await previewPage();
  // Ctrl+P clicks nothing in the window, so its frames count from the moment the preview is
  // up, before its first pages. (Not earlier: Playwright pauses each new window it attaches
  // to, a hidden print window too, and Chromium greys the page behind while it does.)
  if (fromStart) await watchFrames();
  await rendered(preview, before + 1);
  // A click opened a menu and closed it: the frames count from the preview's first pages on.
  await page.waitForTimeout(800);
  // A picture of the preview itself, in a run of its own: taking it grey-washes the window behind ("Debugger paused").
  if (process.env.PRINT_STILL_PREVIEW_SHOTS) {
    mkdirSync(SCREENSHOTS, { recursive: true });
    await preview.screenshot({ path: path.join(SCREENSHOTS, `print-still-${process.env.PRINT_STILL_LABEL ?? 'run'}-${name}-preview.png`) });
  }
  if (!fromStart) await watchFrames();
  await preview.locator('#layout').selectOption('landscape');
  await rendered(preview, before + 2);
  await page.waitForTimeout(600);
  await preview.locator('#layout').selectOption('portrait');
  await rendered(preview, before + 3);
  await page.waitForTimeout(600);
  await preview.keyboard.press('Escape').catch(() => {});
  await expect.poll(async () => (await previewWindows()).length).toBe(0);
  await page.waitForTimeout(1000);
  const frames = await stopWatching(name);
  console.log(`${name}: ${frames.count} frames, worst ${(frames.worst * 100).toFixed(2)} % of the window`);
  if (!process.env.PRINT_STILL_PREVIEW_SHOTS) expect(frames.worst, `${name}: the window behind the preview changed`).toBeLessThan(STILL);
}

/** File > Print, as Ctrl+P runs it. */
function menuPrint(): Promise<void> {
  return app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('file.print')?.click());
}

async function openRow(row: number): Promise<void> {
  await page.locator('[data-row-text]').nth(row).click();
  await expect(page.locator('button[aria-label="More actions"]:visible').first()).toBeVisible({ timeout: 30_000 });
  // The pointer off the list, so no hover comes or goes while the frames are compared.
  await page.mouse.move(1200, 860);
  await page.waitForTimeout(800);
}

test.beforeAll(async () => {
  profile = tempProfile('print-still');
  ({ app, page } = await launchStandalone(profile));
  await waitForLogin(page);
  const configFile = path.join(profile, 'webmail', 'admin', 'config.json');
  const { readFileSync } = await import('node:fs');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), demoMode: true }, null, 2));
  await expect.poll(() => page.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.demoMode)), { timeout: 30_000 }).toBe(true);
  await page.reload();
  await fakeOsIntegration(app);
  await app.evaluate((_electron, fake) => {
    (globalThis as unknown as { __bulwarkFakePrinting: unknown }).__bulwarkFakePrinting = structuredClone(fake);
  }, FAKE);
  // A full desktop window: the sheet is narrower, which is what made the sidebar fold.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith('https://app.bulwark.localhost'))?.setBounds({ x: 40, y: 40, width: 1440, height: 900 });
  });
  await page.getByRole('button', { name: 'Launch Demo' }).click({ timeout: 90_000 });
  await expectMailShown(page);
});

test.afterAll(async () => {
  await app.close().catch(() => {});
  removeProfile(profile);
});

test('a message\'s Print', async () => {
  await openRow(2);
  await previewStaysStill('message', async () => {
    await page.locator('button[aria-label="More actions"]:visible').first().click();
    await page.getByRole('menuitem', { name: 'Print' }).first().click();
    await page.mouse.move(1200, 860);
  });
});

test('Print in a conversation message\'s ⋮', async () => {
  await openRow(1);
  // A message's own ⋮ in the conversation: a "More actions" below the reader's toolbar.
  let menu = page.locator('button[aria-label="More actions"]:visible').first();
  for (const candidate of await page.locator('button[aria-label="More actions"]:visible').all()) {
    const box = await candidate.boundingBox();
    if (box && box.y > 150 && box.x > 700) {
      menu = candidate;
      break;
    }
  }
  await previewStaysStill('conversation', async () => {
    await menu.click();
    await page.getByRole('menuitem', { name: 'Print' }).first().click();
    await page.mouse.move(1200, 860);
  });
});

test('Ctrl+P in mail', async () => {
  await openRow(2);
  await previewStaysStill('mail-ctrl-p', menuPrint, { fromStart: true });
});

test('Ctrl+P in the calendar', async () => {
  await page.locator('[data-tour="nav-calendar"]').first().click();
  await page.waitForTimeout(2500);
  await page.mouse.move(1200, 860);
  await previewStaysStill('calendar-ctrl-p', menuPrint, { fromStart: true });
});

test('a contact\'s Print', async () => {
  await page.locator('[data-tour="nav-contacts"]').first().click();
  await page.waitForTimeout(2000);
  await page.locator('[data-contact-id], [role="option"]').first().click().catch(() => {});
  const print = page.locator('button[aria-label="Print"]:visible, button[title="Print"]:visible').first();
  await expect(print).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(1200, 860);
  await page.waitForTimeout(800);
  await previewStaysStill('contact', async () => {
    await print.click();
    await page.mouse.move(1200, 860);
  });
});
