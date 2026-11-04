import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spellLanguagesFor } from '../src/main/menu-text';
import { launchStandalone, removeProfile, tempProfile, waitForLogin } from './helpers';
import { lastMenu, menuCount, recordMenus } from './native-helpers';

/** Made up, so no checker anywhere knows it. */
const WORD = 'Qzvbrekt';

test.describe('which languages spelling is checked in', () => {
  test('a bare interface language gets the region the OS uses, and the OS languages come along', () => {
    expect(spellLanguagesFor('en', [], ['de-DE', 'en-US'])).toEqual(['en-US', 'de-DE']);
    expect(spellLanguagesFor('de', [], ['en-GB'])).toEqual(['de-DE', 'en-GB']);
    expect(spellLanguagesFor('en', ['de'], ['en-GB'])).toEqual(['en-GB', 'de-DE']);
  });

  test('a language with its region stays as it is, and nothing comes twice', () => {
    expect(spellLanguagesFor('pt-BR', ['pt-BR', 'en-US'], ['en-US', 'pt-BR'])).toEqual(['pt-BR', 'en-US']);
    expect(spellLanguagesFor('zh-TW', [], [])).toEqual(['zh-TW']);
  });

  test('OS entries that are no language tag are left out', () => {
    expect(spellLanguagesFor('en', [], ['', 'x', 'en-US'])).toEqual(['en-US']);
  });
});

/**
 * Windows' own checker knows "en-US", not "en". With a bare tag Chromium looks for a
 * Hunspell dictionary instead, which it never gets, and nothing is underlined.
 */
test.describe('spelling in the app', () => {
  test.skip(process.platform !== 'win32', 'the Windows checker');
  let profile = '';
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    profile = tempProfile('spelling');
    ({ app, page } = await launchStandalone(profile));
    await waitForLogin(page);
    await recordMenus(app);
  });

  test.afterAll(async () => {
    await app?.close();
    removeProfile(profile);
  });

  test('works out of the box: suggestions and Add to dictionary on a misspelled word', async () => {
    // English for the English interface, and the languages Windows has a checker for.
    const system = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const available = BrowserWindow.getAllWindows()[0].webContents.session.availableSpellCheckerLanguages;
      return electronApp.getPreferredSystemLanguages().filter((tag) => available.includes(tag));
    });
    const languages = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.getSpellCheckerLanguages());
    await expect.poll(languages, { timeout: 30_000 }).toContain('en-US');
    for (const language of system.filter((tag) => tag.includes('-'))) await expect.poll(languages).toContain(language);

    const word = WORD;
    await page.evaluate((text) => {
      const area = document.createElement('textarea');
      area.id = 'spell-probe';
      area.spellcheck = true;
      area.value = `${text} is a tset`;
      Object.assign(area.style, { position: 'fixed', left: '20px', top: '120px', width: '400px', height: '80px', zIndex: '2147483647', fontSize: '20px' });
      document.body.appendChild(area);
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    }, word);
    // The checker runs once the text has been typed into, or looked at for a while.
    await page.keyboard.type(' ');
    await page.waitForTimeout(2500);

    const misspelled = await new Promise<string>((resolve) => {
      void app.evaluate(({ BrowserWindow }) => new Promise<string>((done) => {
        BrowserWindow.getAllWindows()[0].webContents.once('context-menu', (_event, params) => done(params.misspelledWord));
      })).then(resolve);
      void page.mouse.click(40, 140, { button: 'right' });
    });
    expect(misspelled).toBe(word);
    await expect.poll(() => menuCount(app)).toBeGreaterThan(0);
    const labels = (await lastMenu(app))!.map((item) => item.label);
    expect(labels.length).toBeGreaterThan(2);
    expect(labels).toContain(`Add "${word}" to dictionary`);
    expect(labels[0]).not.toBe('Cut');

    // Not clicked here: on Windows it goes into the user's own Windows dictionary, and taking
    // it out again leaves it on Windows' list of words that are always wrong. The click is
    // covered with a stand-in word in native-menu.spec.ts.
  });

  test('no dictionary question on Windows: the page hears of nothing missing', async () => {
    const missing = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { spellcheck: { missing: () => Promise<string[]> } } }).bulwarkDesktop.spellcheck.missing());
    expect(missing).toEqual([]);
  });
});

test('the Windows user dictionaries keep no test word', () => {
  test.skip(process.platform !== 'win32' || !process.env.APPDATA, 'Windows only');
  const root = path.join(process.env.APPDATA!, 'Microsoft', 'Spelling');
  const files = existsSync(root) ? readdirSync(root).flatMap((language) => ['default.dic', 'default.exc'].map((name) => path.join(root, language, name))) : [];
  for (const file of files.filter((f) => existsSync(f))) expect(readFileSync(file, 'utf16le'), file).not.toContain(WORD);
});
