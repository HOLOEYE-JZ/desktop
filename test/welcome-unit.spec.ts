import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { firstPageUrl, isNoJmapDomain, parseWelcomeAddress, parseWelcomeEmail } from '../src/shared/welcome-address';

const ROOT = path.resolve(import.meta.dirname, '..');
const STRINGS = JSON.parse(readFileSync(path.join(ROOT, 'src/pages/welcome-strings.json'), 'utf8')) as Record<string, Record<string, string>>;
// The webmail's 30 languages: the first-run page is the first thing anyone sees.
const LANGUAGES = ['ar', 'ca', 'cs', 'da', 'de', 'en', 'es', 'et', 'fa', 'fr', 'he', 'hu', 'it', 'ja', 'ko', 'lv', 'mn', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-TW'];

test.describe('the first-run address field', () => {
  test('takes a bare host and adds https', () => {
    expect(parseWelcomeAddress('mail.example.com', false)).toEqual({ ok: true, value: 'https://mail.example.com/' });
    expect(parseWelcomeAddress('  mail.example.com/webmail  ', false)).toEqual({ ok: true, value: 'https://mail.example.com/webmail/' });
    expect(parseWelcomeAddress('mail.example.com:8443', false)).toEqual({ ok: true, value: 'https://mail.example.com:8443/' });
    expect(parseWelcomeAddress('https://mail.example.com', false)).toEqual({ ok: true, value: 'https://mail.example.com/' });
  });

  test('refuses http unless the policy allows it, and says why', () => {
    expect(parseWelcomeAddress('http://mail.example.com', false)).toEqual({ ok: false, error: 'insecure' });
    expect(parseWelcomeAddress('http://mail.example.com', true)).toEqual({ ok: true, value: 'http://mail.example.com/' });
  });

  test('tells an email address apart, and Gmail, Outlook.com and iCloud from the rest', () => {
    expect(parseWelcomeAddress('sam@example.org', false)).toEqual({ ok: false, error: 'email' });
    for (const typed of ['sam@gmail.com', 'sam@outlook.de', 'sam@hotmail.co.uk', 'sam@icloud.com', 'gmail.com', 'https://mail.google.com', 'outlook.live.com'])
      expect(parseWelcomeAddress(typed, false), typed).toEqual({ ok: false, error: 'no_jmap' });
    expect(isNoJmapDomain('example.org')).toBe(false);
    expect(isNoJmapDomain('notgmail.com')).toBe(false);
  });

  test('anything else is not an address', () => {
    for (const typed of ['', '   ', 'ftp://mail.example.com', 'mail example', 'https://user:pw@mail.example.com', 42])
      expect(parseWelcomeAddress(typed, false), String(typed)).toEqual({ ok: false, error: 'invalid_url' });
  });
});

test.describe('the first-run email field', () => {
  test('takes an email address, and catches Gmail, Outlook.com and iCloud', () => {
    expect(parseWelcomeEmail('sam@example.org')).toEqual({ ok: true, email: 'sam@example.org' });
    expect(parseWelcomeEmail('  sam.lee@mail.example.co.uk ')).toEqual({ ok: true, email: 'sam.lee@mail.example.co.uk' });
    for (const typed of ['sam@gmail.com', 'sam@outlook.de', 'sam@icloud.com']) expect(parseWelcomeEmail(typed), typed).toEqual({ ok: false, error: 'no_jmap' });
  });

  test('anything else asks for an email address', () => {
    for (const typed of ['', 'sam', 'mail.example.com', 'https://mail.example.com', 'sam@example', 'sam@@example.org', 'sam lee@example.org', 'sam@example.org.', 42])
      expect(parseWelcomeEmail(typed), String(typed)).toEqual({ ok: false, error: 'email_invalid' });
  });
});

test.describe('the first window after the first run', () => {
  test('opens the sign-in page with the address typed on the first screen', () => {
    expect(firstPageUrl('https://127.0.0.1:4100', 'sam+news@example.org')).toBe('https://127.0.0.1:4100/login?login_hint=sam%2Bnews%40example.org');
    expect(new URL(firstPageUrl('https://127.0.0.1:4100', 'sam+news@example.org')).searchParams.get('login_hint')).toBe('sam+news@example.org');
  });

  test('without one, opens the app as before', () => {
    expect(firstPageUrl('https://127.0.0.1:4100', null)).toBe('https://127.0.0.1:4100/');
    expect(firstPageUrl('https://127.0.0.1:4100', '')).toBe('https://127.0.0.1:4100/');
  });
});

test.describe('the first-run strings', () => {
  test('every language has every string, and none is left in English', () => {
    expect(Object.keys(STRINGS).sort()).toEqual([...LANGUAGES].sort());
    const keys = Object.keys(STRINGS.en).sort();
    for (const language of LANGUAGES) {
      expect(Object.keys(STRINGS[language]).sort(), language).toEqual(keys);
      for (const key of keys) {
        expect(STRINGS[language][key].trim(), `${language}.${key}`).not.toBe('');
        if (language !== 'en' && !['connect', 'back'].includes(key) && STRINGS[language][key] === STRINGS.en[key]) throw new Error(`${language}.${key} is the English text`);
      }
    }
  });

  test('say what works, in plain words', () => {
    // The first screen asks for an email address, in plain words: no protocol or server names.
    expect(STRINGS.en.intro).toBe('Sign in with your email address.');
    expect(STRINGS.en.orgLink).toBe('My organisation gave me a Bulwark web address');
    for (const language of LANGUAGES)
      for (const key of ['title', 'intro', 'emailLabel', 'continueLabel', 'orgLink']) expect(STRINGS[language][key], `${language}.${key}`).not.toMatch(/JMAP|Stalwart|Fastmail/);
    expect(STRINGS.en.instanceTitle).toBe("Connect to your organisation's Bulwark");
    expect(STRINGS.en.noJmap).toMatch(/Gmail, Outlook\.com and iCloud/);
    expect(STRINGS.en.privacyIntro).toContain('Settings > Privacy');
    for (const language of LANGUAGES) expect(STRINGS[language].telemetryText, language).not.toMatch(/Node/);
  });

  test('the page picks the system language, then its base language, then English', () => {
    const source = readFileSync(path.join(ROOT, 'src/pages/welcome.js'), 'utf8');
    const body = source.slice(source.indexOf('function pickLanguage'), source.indexOf('const language ='));
    const pick = new Function('STRINGS', `${body}; return pickLanguage;`)(STRINGS) as (languages: string[]) => string;
    expect(pick(['fr-FR'])).toBe('fr');
    expect(pick(['de'])).toBe('de');
    expect(pick(['zh-TW'])).toBe('zh-TW');
    expect(pick(['zh-Hant-HK'])).toBe('zh-TW');
    expect(pick(['zh-CN'])).toBe('zh');
    expect(pick(['no'])).toBe('nb');
    expect(pick(['pt-BR'])).toBe('pt');
    expect(pick(['xx', 'it-IT'])).toBe('it');
    expect(pick(['xx'])).toBe('en');
  });
});

test.describe('the built first-run page', () => {
  test('carries its strings inline, allowed by the hash in its policy', () => {
    const built = path.join(ROOT, 'dist/pages/welcome.html');
    test.skip(!existsSync(built), 'needs node build.mjs first');
    const html = readFileSync(built, 'utf8');
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
    expect(script).not.toContain('__WELCOME_STRINGS__');
    expect(script).toContain('Sign in with your email address.');
    const hash = createHash('sha256').update(script).digest('base64');
    expect(html).toContain(`script-src 'sha256-${hash}'`);
  });
});
