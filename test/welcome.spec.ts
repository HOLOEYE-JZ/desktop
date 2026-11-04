import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { fakeOsIntegration, launch, opened, removeProfile, SCREENSHOTS, shownPage, tempProfile } from './helpers';

const ROOT = path.resolve(import.meta.dirname, '..');
const STRINGS = JSON.parse(readFileSync(path.join(ROOT, 'src/pages/welcome-strings.json'), 'utf8')) as Record<string, Record<string, string>>;

// The system language as Chromium is told it, and the page's language it should pick.
const LANGUAGES: Array<[string, string]> = [['en-US', 'en'], ['de-DE', 'de'], ['fr-FR', 'fr'], ['ar', 'ar']];

test.describe('the first run looks like Bulwark', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`in ${theme}: the window is as tall as its card, nothing scrolls, and the title is Bulwark`, async () => {
      const profile = tempProfile(`welcome-look-${theme}`);
      const app = await launch(profile);
      try {
        const page = await shownPage(app);
        await page.locator('#email').waitFor();
        // Playwright pins pages to light, so the system's scheme is emulated here; the page follows it while open.
        await page.emulateMedia({ colorScheme: theme });
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
        // Within a few pixels: the window's size is in whole device pixels.
        await expect.poll(() => page.evaluate(() => Math.abs(window.innerHeight - (document.getElementById('card')!.getBoundingClientRect().height + 48)))).toBeLessThanOrEqual(4);
        expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toBe('Bulwark');
        await page.screenshot({ path: path.join(SCREENSHOTS, `desktop-p3-welcome-${theme}.png`) });
        await page.click('#instance');
        await expect.poll(() => page.evaluate(() => Math.abs(window.innerHeight - (document.getElementById('card')!.getBoundingClientRect().height + 48)))).toBeLessThanOrEqual(4);
        await page.screenshot({ path: path.join(SCREENSHOTS, `desktop-p3-welcome-org-${theme}.png`) });
      } finally {
        await app.close();
        removeProfile(profile);
      }
    });
  }
});

test.describe('the first run, as people see it', () => {
  for (const [lang, code] of LANGUAGES) {
    test(`in ${lang}: asks for an email address first, explains a wrong address, and the steps have Back`, async () => {
      const text = STRINGS[code];
      const profile = tempProfile(`welcome-${code}`);
      // Last --lang wins over the helper's en-US.
      const app = await launch(profile, `--lang=${lang}`);
      try {
        // Learn more goes to a list here, never to a browser.
        await fakeOsIntegration(app);
        const page = await shownPage(app);
        await page.locator('#email').waitFor();
        await expect(page.locator('html')).toHaveAttribute('lang', code);
        await expect(page.locator('html')).toHaveAttribute('dir', ['ar', 'fa', 'he'].includes(code) ? 'rtl' : 'ltr');
        await expect(page.locator('#intro')).toHaveText(text.intro);
        await expect(page.locator('#email')).toBeFocused();
        await expect(page.locator('#instance')).toHaveText(text.orgLink);
        await expect(page.locator('#url')).toBeHidden();
        await expect(page.locator('body')).not.toContainText(/JMAP|Stalwart|Fastmail/);
        await page.screenshot({ path: path.join(SCREENSHOTS, `after-desk-01-first-run-${code}.png`) });

        // The email field: Gmail and the like get the note, a web address a hint.
        await page.fill('#email', 'sam@gmail.com');
        await page.click('#standalone');
        await expect(page.locator('#email-error-text')).toHaveText(text.noJmap);
        await expect(page.locator('#email')).toHaveAttribute('aria-invalid', 'true');
        await page.click('#email-error-link');
        await expect.poll(() => opened(app)).toEqual(['https://bulwarkmail.org/docs/getting-started/introduction']);
        await page.fill('#email', 'sam');
        await expect(page.locator('#email-error')).toBeHidden();
        await page.click('#standalone');
        await expect(page.locator('#email-error-text')).toHaveText(text.emailInvalid);
        // A web address there: the organisation step is offered, with it filled in, and Back clears the line.
        await page.fill('#email', 'mail.example.com');
        await page.click('#standalone');
        await expect(page.locator('#email-error-text')).toHaveText(text.webAddress);
        await page.click('#email-error-link');
        await expect(page.locator('#url')).toHaveValue('mail.example.com');
        await page.click('#org-back');
        await expect(page.locator('#email-error')).toBeHidden();
        await page.fill('#email', '');

        // The organisation's address is a step of its own, with Back.
        await page.click('#instance');
        await expect(page.locator('#instance-title')).toHaveText(text.instanceTitle);
        await expect(page.locator('#url')).toBeFocused();
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toBe('Bulwark');
        await expect(page.locator('#email')).toBeHidden();
        // No browser bubble: a plain text field, and the app's own words.
        await expect(page.locator('#url')).toHaveAttribute('type', 'text');
        await page.fill('#url', 'sam@gmail.com');
        await page.click('#connect');
        await expect(page.locator('#error-text')).toHaveText(text.noJmap);
        await expect(page.locator('#url')).toHaveAttribute('aria-invalid', 'true');
        await page.screenshot({ path: path.join(SCREENSHOTS, `after-desk-02-address-gmail-${code}.png`) });
        await page.fill('#url', 'sam@example.org');
        await page.click('#connect');
        await expect(page.locator('#error-text')).toHaveText(text.email);
        await page.fill('#url', 'http://mail.example.org');
        await expect(page.locator('#error')).toBeHidden();
        await page.click('#connect');
        await expect(page.locator('#error-text')).toHaveText(text.insecure);
        await page.screenshot({ path: path.join(SCREENSHOTS, `after-desk-03-address-http-${code}.png`) });

        await page.click('#org-back');
        await expect(page.locator('#email')).toBeVisible();
        await expect(page.locator('#url')).toBeHidden();
        await page.fill('#email', 'sam@example.org');
        await page.click('#standalone');
        await page.locator('#privacy.open').waitFor();
        await expect(page.locator('#privacy-intro')).toHaveText(text.privacyIntro);
        await expect(page.locator('#telemetry-text')).not.toContainText('Node');
        await page.screenshot({ path: path.join(SCREENSHOTS, `after-desk-04-privacy-${code}.png`), fullPage: true });
        await page.click('#back');
        await expect(page.locator('#privacy')).toBeHidden();
        await expect(page.locator('#email')).toBeVisible();
        // The headings name the steps; the window stays "Bulwark", as the taskbar shows it.
        await expect(page).toHaveTitle('Bulwark');
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()))).toEqual(['Bulwark']);
        // Choosing again still reaches the second question.
        await page.click('#standalone');
        await page.locator('#privacy.open').waitFor();
      } finally {
        await app.close();
        removeProfile(profile);
      }
    });
  }
});
