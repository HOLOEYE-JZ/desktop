// The print preview from a message's Print, on the webmail's demo data: no server, no account.
// Needs a webmail build of this branch (BULWARK_TEST_WEBMAIL), with print windows that go to the
// preview. Printers are a fake list (test build) and jobs are recorded, never sent; the save
// dialog writes to a temp folder. BULWARK_SCREENSHOTS keeps the pictures.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { expectMailShown, fakeOsIntegration, launchStandalone, opened, removeProfile, SCREENSHOTS, tempProfile, waitForLogin } from './helpers';

test.skip(!process.env.BULWARK_TEST_WEBMAIL, 'needs a webmail build of this branch in BULWARK_TEST_WEBMAIL');

const FAKE = {
  printers: [
    { name: 'Office Laser', displayName: 'Office Laser', options: {} },
    { name: 'Front Desk Color', displayName: 'Front Desk Color', options: {} },
  ],
  defaultPrinter: 'Office Laser',
  jobs: [] as { kind: string; options: Record<string, unknown> }[],
  renders: [] as string[],
};

let profile = '';
let saveDir = '';
let app: ElectronApplication;
let page: Page;

function previewWindows() {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((w) => {
    if (w.isDestroyed() || !w.webContents?.getURL().startsWith('data:') || !w.isVisible()) return [];
    return [{ id: w.id, parent: w.getParentWindow()?.id ?? null, bounds: w.getContentBounds() }];
  }));
}

function blankWindows() {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL() === 'about:blank').map((w) => ({ visible: w.isVisible() })));
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

async function lastRender(): Promise<{ pages: number; landscape: boolean | null }> {
  const last = await app.evaluate(() => (globalThis as unknown as { __bulwarkFakePrinting: { renders: string[] } }).__bulwarkFakePrinting.renders.at(-1) ?? '');
  const text = Buffer.from(last, 'base64').toString('latin1');
  const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(text);
  return { pages: (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length, landscape: box ? Number(box[3]) - Number(box[1]) > Number(box[4]) - Number(box[2]) : null };
}

/** The window behind and the preview over it, as one picture. */
async function picture(preview: Page, name: string): Promise<void> {
  if (!process.env.BULWARK_SCREENSHOTS) return;
  const [shown] = await previewWindows();
  const parent = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id!)!.getContentBounds(), shown.parent);
  // The PDF viewer draws its pages a moment after the frame loads.
  await preview.waitForTimeout(1500);
  const back = (await page.screenshot()).toString('base64');
  const front = (await preview.screenshot({ omitBackground: true })).toString('base64');
  const png = await page.evaluate(async ({ back: b, front: f, box, origin }) => {
    const load = (data: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = `data:image/png;base64,${data}`;
    });
    const [under, over] = await Promise.all([load(b), load(f)]);
    const scale = under.width / origin.width;
    const canvas = document.createElement('canvas');
    canvas.width = under.width;
    canvas.height = under.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(under, 0, 0);
    context.drawImage(over, (box.x - origin.x) * scale, (box.y - origin.y) * scale, box.width * scale, box.height * scale);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { back, front, box: shown.bounds, origin: parent });
  mkdirSync(SCREENSHOTS, { recursive: true });
  writeFileSync(path.join(SCREENSHOTS, `${name}.png`), Buffer.from(png, 'base64'));
}

/** Opens a demo message and its Print: on the toolbar, or in More actions when the toolbar is full. */
async function printMessage(row: number): Promise<void> {
  await page.locator('[data-row-text]').nth(row).click();
  const more = page.locator('button[aria-label="More actions"]:visible').first();
  await expect(more).toBeVisible({ timeout: 30_000 });
  const direct = page.locator('button[title="Print"]:visible');
  if (await direct.count()) {
    await direct.first().click();
    return;
  }
  await more.click();
  await page.getByRole('menuitem', { name: 'Print' }).first().click();
}

test.beforeAll(async () => {
  profile = tempProfile('print-mail');
  saveDir = mkdtempSync(path.join(tmpdir(), 'bw-print-mail-'));
  ({ app, page } = await launchStandalone(profile));
  await waitForLogin(page);
  // The webmail's demo: its own data, no server. The server reads its config file again
  // within a few seconds; the shell's own keys in it stay as they are.
  const configFile = path.join(profile, 'webmail', 'admin', 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), demoMode: true }, null, 2));
  await expect.poll(() => page.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.demoMode)), { timeout: 30_000 }).toBe(true);
  await page.reload();
  await fakeOsIntegration(app);
  await app.evaluate((_electron, fake) => {
    (globalThis as unknown as { __bulwarkFakePrinting: unknown }).__bulwarkFakePrinting = structuredClone(fake);
  }, FAKE);
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith('https://app.bulwark.localhost'));
    main?.setBounds({ x: 40, y: 40, width: 1440, height: 900 });
  });
  await page.getByRole('button', { name: 'Launch Demo' }).click({ timeout: 90_000 });
  await expectMailShown(page);
});

test.afterAll(async () => {
  await app.close().catch(() => {});
  removeProfile(profile);
  rmSync(saveDir, { recursive: true, force: true });
});

test('Print on a demo message opens the preview with its pages; landscape lays them out again; Save as PDF writes the file', async () => {
  await printMessage(1);
  const preview = await previewPage();
  // The message went into a print window nobody sees.
  expect(await blankWindows()).toEqual([{ visible: false }]);
  await expect(preview.locator('#count')).toHaveText(/^\d+ pages?$/, { timeout: 30_000 });
  await expect(preview.locator('#status')).toHaveText('', { timeout: 30_000 });
  const portrait = await lastRender();
  expect(portrait.pages).toBeGreaterThan(0);
  expect(portrait.landscape).toBe(false);
  await picture(preview, 'print-preview-light');

  await preview.locator('#layout').selectOption('landscape');
  await expect.poll(async () => (await lastRender()).landscape, { timeout: 30_000 }).toBe(true);
  await expect(preview.locator('#status')).toHaveText('', { timeout: 30_000 });

  const file = path.join(saveDir, 'message.pdf');
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
  }, file);
  await preview.locator('#destination').selectOption('pdf');
  await expect(preview.locator('#go')).toHaveText('Save');
  await expect(preview.locator('#go')).toBeEnabled({ timeout: 30_000 });
  await preview.locator('#go').click().catch(() => {});
  await expect.poll(() => existsSync(file), { timeout: 30_000 }).toBe(true);
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const text = bytes.toString('latin1');
  const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(text)!;
  expect(Number(box[3]) - Number(box[1])).toBeGreaterThan(Number(box[4]) - Number(box[2]));
  await expect.poll(async () => (await previewWindows()).length).toBe(0);
  // The print window went with the preview, and nothing was sent to a printer.
  await expect.poll(async () => (await blankWindows()).length).toBe(0);
  expect(await app.evaluate(() => (globalThis as unknown as { __bulwarkFakePrinting: { jobs: unknown[] } }).__bulwarkFakePrinting.jobs)).toEqual([]);
  expect(await opened(app)).toEqual([]);
});

test('the preview in the dark theme, with More settings open', async () => {
  test.skip(!process.env.BULWARK_SCREENSHOTS, 'pictures only');
  // The webmail follows the system's dark mode (its theme is "system" by default).
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')), { timeout: 15_000 }).toBe(true);
  await printMessage(1);
  const preview = await previewPage();
  await preview.locator('#destination').selectOption({ label: 'Office Laser' });
  await preview.locator('#more-toggle').click();
  await expect(preview.locator('#status')).toHaveText('', { timeout: 30_000 });
  await picture(preview, 'print-preview-dark');
  await preview.keyboard.press('Escape').catch(() => {});
  await expect.poll(async () => (await previewWindows()).length).toBe(0);
  await page.emulateMedia({ colorScheme: null });
});
