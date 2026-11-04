import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, removeProfile, SCREENSHOTS, shownPage, tempProfile } from './helpers';

const ROOT = path.resolve(import.meta.dirname, '..');
const STRINGS = JSON.parse(readFileSync(path.join(ROOT, 'src/pages/welcome-strings.json'), 'utf8')) as Record<string, Record<string, string>>;

// The system language as Chromium is told it, and the page's language it should pick.
const LANGUAGES: Array<[string, string]> = [['en-US', 'en'], ['de-DE', 'de'], ['fr-FR', 'fr'], ['ar', 'ar']];

test.describe('the first run, as people see it', () => {
  for (const [lang, code] of LANGUAGES) {
    test(`in ${lang}: says what works, explains a wrong address, and the privacy step has Back`, async () => {
      const text = STRINGS[code];
      const profile = tempProfile(`welcome-${code}`);
      // Last --lang wins over the helper's en-US.
      const app = await launch(profile, `--lang=${lang}`);
      try {
        const page = await shownPage(app);
        await page.locator('#standalone').waitFor();
        await expect(page.locator('html')).toHaveAttribute('lang', code);
        await expect(page.locator('html')).toHaveAttribute('dir', ['ar', 'fa', 'he'].includes(code) ? 'rtl' : 'ltr');
        await expect(page.locator('#standalone-title')).toHaveText(text.standaloneTitle);
        await expect(page.locator('#instance-title')).toHaveText(text.instanceTitle);
        await page.screenshot({ path: path.join(SCREENSHOTS, `after-desk-01-first-run-${code}.png`) });

        await page.click('#instance');
        // No browser bubble: a plain text field, and the app's own words.
        await expect(page.locator('#url')).toHaveAttribute('type', 'text');
        await page.fill('#url', 'sam@gmail.com');
        await page.click('#connect');
        await expect(page.locator('#error')).toHaveText(text.noJmap);
        await expect(page.locator('#url')).toHaveAttribute('aria-invalid', 'true');
        await page.screenshot({ path: path.join(SCREENSHOTS, `after-desk-02-address-gmail-${code}.png`) });
        await page.fill('#url', 'sam@example.org');
        await page.click('#connect');
        await expect(page.locator('#error')).toHaveText(text.email);
        await page.fill('#url', 'http://mail.example.org');
        await expect(page.locator('#error')).toBeEmpty();
        await page.click('#connect');
        await expect(page.locator('#error')).toHaveText(text.insecure);
        await page.screenshot({ path: path.join(SCREENSHOTS, `after-desk-03-address-http-${code}.png`) });

        await page.click('#standalone');
        await page.locator('#privacy.open').waitFor();
        await expect(page.locator('#privacy-intro')).toHaveText(text.privacyIntro);
        await expect(page.locator('#telemetry-text')).not.toContainText('Node');
        await page.screenshot({ path: path.join(SCREENSHOTS, `after-desk-04-privacy-${code}.png`), fullPage: true });
        await page.click('#back');
        await expect(page.locator('#privacy')).toBeHidden();
        await expect(page.locator('#standalone')).toBeVisible();
        await expect(page).toHaveTitle(text.title);
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
