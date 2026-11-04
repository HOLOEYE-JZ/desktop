import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The first-run page on its own, in headless Chromium: built the way build.mjs builds it,
// with main's preload replaced by a stand-in that records what the page asks for.

const ROOT = path.resolve(import.meta.dirname, '..');
const STRINGS = JSON.parse(readFileSync(path.join(ROOT, 'src/pages/welcome-strings.json'), 'utf8')) as Record<string, Record<string, string>>;
const text = STRINGS.en;

function builtPage(): string {
  const strings = JSON.stringify(STRINGS);
  const script = readFileSync(path.join(ROOT, 'src/pages/welcome.js'), 'utf8').replace(/\r\n/g, '\n').replace('__WELCOME_STRINGS__', () => strings);
  const hash = createHash('sha256').update(script).digest('base64');
  return readFileSync(path.join(ROOT, 'src/pages/welcome.html'), 'utf8')
    .replace("script-src 'self'", `script-src 'sha256-${hash}'`)
    .replace('<script src="welcome.js"></script>', () => `<script>${script}</script>`);
}

interface Options {
  /** What main answers to the email step. */
  emailAnswer?: { ok: boolean; error?: string; next?: string };
  dark?: boolean | null;
}

async function open(page: Page, options: Options = {}): Promise<void> {
  await page.addInitScript((opts: Options) => {
    const calls: unknown[] = [];
    (window as unknown as { calls: unknown[] }).calls = calls;
    (window as unknown as { bulwarkWelcome: unknown }).bulwarkWelcome = {
      options: { allowStandalone: true, instanceUrl: null, urlLocked: false, askTelemetry: true, askCrashReports: true, dark: opts.dark ?? null },
      choose: async (choice: unknown) => {
        calls.push(['choose', choice]);
        return opts.emailAnswer ?? { ok: true, next: 'privacy' };
      },
      answerPrivacy: async () => ({ ok: true }),
      openLink: (name: string) => calls.push(['openLink', name]),
      fit: (height: number) => calls.push(['fit', height]),
    };
  }, options);
  await page.goto(`data:text/html;charset=utf-8;base64,${Buffer.from(builtPage()).toString('base64')}`);
  await page.locator('#email').waitFor();
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: unknown[] }).calls);

test.use({ locale: 'en-US' });

test.describe('the first-run page', () => {
  test('Gmail and the like: what works, and a Learn more that names a page, never an address', async ({ page }) => {
    await open(page, { emailAnswer: { ok: false, error: 'no_jmap' } });
    await page.fill('#email', 'sam@gmail.com');
    await page.click('#standalone');
    await expect(page.locator('#email-error-text')).toHaveText(text.noJmap);
    await expect(page.locator('#email-error')).not.toContainText('JMAP');
    await expect(page.locator('#email-error-link')).toHaveText(text.learnMore);
    await page.click('#email-error-link');
    expect(await calls(page)).toContainEqual(['openLink', 'providers']);
    // Not a dead end: the field takes another address, and the line goes.
    await page.fill('#email', 'sam@example.org');
    await expect(page.locator('#email-error')).toBeHidden();
    await expect(page.locator('#email')).not.toHaveAttribute('aria-invalid', 'true');
  });
});
