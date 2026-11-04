import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ConsentQuestion } from '../src/main/keystore-consent';
import { keystoreDialog } from '../src/main/keystore-dialog';
import { fillKeystoreText, KEYSTORE_TEXT, keystoreTextFor, type KeystoreText } from '../src/main/keystore-strings';
import { LABEL_KEY } from '../src/main/label-keys';

/** What the native question says. The consent decisions are in keystore-consent.spec.ts. */

const LOCALES = ['ar', 'ca', 'cs', 'da', 'de', 'en', 'es', 'et', 'fa', 'fr', 'he', 'hu', 'it', 'ja', 'ko', 'lv', 'mn', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-TW'];
const en = KEYSTORE_TEXT.en;
const INTERNAL = 'https://app.bulwark.localhost';
const INSTANCE = 'https://mail.example.org';

const use = (kind: 'sign' | 'unwrap', extra: Partial<Extract<ConsentQuestion, { kind: 'sign' | 'unwrap' }>> = {}): ConsentQuestion => ({
  kind,
  origin: INSTANCE,
  certificate: 'CN=Alice',
  issuer: 'CN=Some CA',
  notAfter: Date.UTC(2031, 5, 15),
  perOperation: false,
  overRate: false,
  ...extra,
});

test('signing has no button that stops it asking', () => {
  const { buttons, answers } = keystoreDialog(use('sign'), en, false, 'en');
  expect(buttons).toEqual([en.allowOnce, en.deny]);
  expect(answers).toEqual(['once', 'deny']);
});

test('unwrapping offers 15 minutes, not a session, unless the key asks each time', () => {
  const timed = keystoreDialog(use('unwrap'), en, false, 'en');
  expect(timed.buttons).toEqual(['Allow for 15 minutes', 'Allow once', 'Deny']);
  expect(timed.answers).toEqual(['session', 'once', 'deny']);
  const each = keystoreDialog(use('unwrap', { perOperation: true }), en, false, 'en');
  expect(each.buttons).toEqual([en.allowOnce, en.deny]);
  expect(each.detail).toContain(en.perOperation);
});

test('the signing text no longer says it could sign anything, as main checks what it signs', () => {
  expect(en.signDetail).not.toMatch(/anything/);
  expect(keystoreDialog(use('sign'), en, false, 'en').detail).toContain(en.signDetail);
});

test('standalone says this app, an instance names itself', () => {
  for (const question of [{ kind: 'list', origin: INTERNAL }, use('sign', { origin: INTERNAL }), use('unwrap', { origin: INTERNAL })] as ConsentQuestion[]) {
    const { message, detail } = keystoreDialog(question, en, true, 'en');
    expect(message).toContain('this app');
    expect(`${message} ${detail}`).not.toContain('bulwark.localhost');
  }
  expect(keystoreDialog({ kind: 'list', origin: INSTANCE }, en, false, 'en').message).toContain('mail.example.org');
  expect(keystoreDialog(use('sign'), en, false, 'en').message).toContain('mail.example.org');
  expect(keystoreDialog({ kind: 'first-use', origin: INSTANCE }, en, false, 'en').detail).toContain('mail.example.org');
});

test('issuer and expiry tell a renewed certificate from the old one', () => {
  const oldOne = keystoreDialog(use('sign', { notAfter: Date.UTC(2026, 0, 2) }), en, false, 'en').detail;
  const renewed = keystoreDialog(use('sign', { notAfter: Date.UTC(2031, 5, 15) }), en, false, 'en').detail;
  expect(oldOne).toContain('CN=Some CA');
  expect(oldOne).toContain('2026');
  expect(renewed).toContain('2031');
  expect(oldOne).not.toBe(renewed);
});

test('a name cannot fake a line, hide itself or fill the dialog', () => {
  const [bidi, zeroWidth] = [String.fromCharCode(0x202e), String.fromCharCode(0x200b)];
  const certificate = `CN=Alice\n\nIssued by Your Bank\r\t${bidi}gnp.${zeroWidth}x`;
  const { detail } = keystoreDialog(use('sign', { certificate, issuer: `CN=${'y'.repeat(500)}\nz` }), en, false, 'en');
  const [first, second] = detail.split('\n');
  expect(first).toContain('CN=Alice');
  expect(first).toContain('Issued by Your Bank');
  expect(second.startsWith('Issued by CN=y')).toBe(true);
  for (const gone of [bidi, zeroWidth, '\r', '\t']) expect(detail).not.toContain(gone);
  expect(second.length).toBeLessThan(300);
});

test('a date in a language the runtime refuses still shows', () => {
  expect(keystoreDialog(use('sign'), en, false, 'not a language!').detail).toContain('2031');
});

test('every language has every text, with the placeholders English has', () => {
  expect(Object.keys(KEYSTORE_TEXT).sort()).toEqual([...LOCALES].sort());
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const locale of LOCALES) {
    const text = KEYSTORE_TEXT[locale];
    for (const key of Object.keys(en) as (keyof KeystoreText)[]) {
      expect(text[key], `${locale}.${key}`).toBeTruthy();
      expect(placeholders(text[key]), `${locale}.${key}`).toEqual(placeholders(en[key]));
    }
  }
});

test('nothing is left in English outside English', () => {
  for (const locale of LOCALES.filter((name) => name !== 'en')) {
    for (const key of ['allowTimed', 'allowOnce', 'signTitle', 'signDetail', 'unwrapDetail', 'perOperation', 'permission'] as const) {
      expect(KEYSTORE_TEXT[locale][key], `${locale}.${key}`).not.toBe(en[key]);
    }
  }
});

test('the language comes from its tag, and German says Sie', () => {
  expect(keystoreTextFor('de-AT')).toBe(KEYSTORE_TEXT.de);
  expect(keystoreTextFor('zh-Hant-HK')).toBe(KEYSTORE_TEXT['zh-TW']);
  expect(keystoreTextFor('zh-TW')).toBe(KEYSTORE_TEXT['zh-TW']);
  expect(keystoreTextFor('zh-CN')).toBe(KEYSTORE_TEXT.zh);
  expect(keystoreTextFor('xx')).toBe(KEYSTORE_TEXT.en);
  expect(keystoreTextFor('__proto__')).toBe(KEYSTORE_TEXT.en);
  expect(KEYSTORE_TEXT.de.signDetail).toMatch(/Ihrem|Sie/);
  expect(`${KEYSTORE_TEXT.de.signDetail} ${KEYSTORE_TEXT.de.unwrapDetail}`).not.toMatch(/\b(du|dein|dir)\b/i);
});

test('a page cannot reword the question: none of these are labels', () => {
  // Labels only ever replace keys of strings.ts, and it has none of these any more.
  expect(readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'strings.ts'), 'utf8')).not.toMatch(/keystore[A-Z]/);
  expect(LABEL_KEY.test('keystoreSignTitle')).toBe(false);
});

test('filling leaves what it does not know', () => {
  expect(fillKeystoreText('{who} and {other}', { who: 'x' })).toBe('x and {other}');
});
