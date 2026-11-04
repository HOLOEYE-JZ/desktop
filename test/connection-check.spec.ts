import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { LOAD_ERROR_TEXT } from '../src/main/load-error';
import { launch, removeProfile, SCREENSHOTS, shownPage, tempProfile } from './helpers';

const ROOT = path.resolve(import.meta.dirname, '..');
const STRINGS = JSON.parse(readFileSync(path.join(ROOT, 'src/pages/welcome-strings.json'), 'utf8')) as Record<string, Record<string, string>>;
const text = STRINGS.en;
// A Bulwark the other specs use too, and two that aren't one: .example never resolves.
const BULWARK = 'bulwark.internal.bulwarkmail.org';
const NOWHERE = 'mail.example';
const NOT_BULWARK = 'example.com';

test('the first run checks an organisation address before it takes it', async () => {
  const profile = tempProfile('connection-check');
  const app = await launch(profile);
  try {
    const page = await shownPage(app);
    await page.click('#instance');

    await page.fill('#url', NOWHERE);
    await page.click('#connect');
    await expect(page.locator('#error')).toHaveText(text.unreachable, { timeout: 15_000 });
    await expect(page.locator('#url')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#privacy')).toBeHidden();
    await expect(page.locator('#connection')).toBeVisible();
    await expect(page.locator('#standalone')).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOTS, 'after-desk-05-address-unreachable-en.png') });

    await page.fill('#url', NOT_BULWARK);
    await page.click('#connect');
    await expect(page.locator('#error')).toHaveText(text.notBulwark, { timeout: 15_000 });
    await expect(page.locator('#privacy')).toBeHidden();

    await page.fill('#url', BULWARK);
    await page.click('#connect');
    await page.locator('#privacy.open').waitFor({ timeout: 15_000 });
    await expect(page.locator('#error')).toBeEmpty();
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('a server that does not load shows a page with Try again and Change connection', async () => {
  const profile = tempProfile('load-error');
  const app = await launch(profile, `--instance=https://${NOWHERE}/`);
  try {
    const page = await shownPage(app);
    const words = LOAD_ERROR_TEXT.en;
    await expect(page.locator('h1')).toHaveText(words.title, { timeout: 30_000 });
    await expect(page.locator('p')).toContainText(NOWHERE);
    await expect(page.locator('#retry')).toHaveText(words.tryAgain);
    await expect(page.locator('#change')).toHaveText(words.change);
    await page.screenshot({ path: path.join(SCREENSHOTS, 'after-desk-06-server-not-loading-en.png') });

    // Try again loads the server again, which fails again: the page comes back, not an empty window.
    const loads = () => app.evaluate(() => (globalThis as unknown as { __fails: number }).__fails);
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as { __fails: number };
      g.__fails = 0;
      for (const window of BrowserWindow.getAllWindows()) window.webContents.on('did-fail-load', (_e, code, _d, _u, main) => {
        if (main && code !== -3) g.__fails += 1;
      });
    });
    await page.click('#retry');
    await expect.poll(loads, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(page.locator('h1')).toHaveText(words.title, { timeout: 30_000 });
    await expect(page.locator('#change')).toBeVisible();

    // Change connection quits to the first run's question. The relaunch is the test's to skip.
    await app.evaluate(({ app: electronApp }) => {
      electronApp.relaunch = () => {};
    });
    const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await page.click('#change');
    await exited;
    const state = path.join(profile, 'shell-state.json');
    expect(existsSync(state)).toBe(true);
    const saved = JSON.parse(readFileSync(state, 'utf8')) as { askConnection?: boolean; mode?: string };
    expect(saved.askConnection).toBe(true);
    expect(saved.mode).toBeUndefined();
  } finally {
    await app.close().catch(() => {});
    removeProfile(profile);
  }
});
