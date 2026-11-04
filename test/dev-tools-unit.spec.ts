// The developer tools switch: the decisions, with no Electron.
import { expect, test } from '@playwright/test';
import { DEVTOOLS_TEXT, devToolsTextFor } from '../src/main/devtools-strings';
import { KEYSTORE_TEXT } from '../src/main/keystore-strings';
import { devToolsForcedOffBy, devToolsUsable, isDevToolsKey } from '../src/main/features/dev-tools-rules';

test.describe('the developer tools switch', () => {
  const key = (patch: Partial<Parameters<typeof isDevToolsKey>[0]>) => ({ type: 'keyDown' as const, key: 'I', code: 'KeyI', control: false, meta: false, shift: false, alt: false, ...patch });

  test('Ctrl+Shift+I and F12 elsewhere, Cmd+Option+I on a Mac; nothing else', () => {
    expect(isDevToolsKey(key({ control: true, shift: true }), 'win32')).toBe(true);
    expect(isDevToolsKey(key({ key: 'F12', code: 'F12' }), 'win32')).toBe(true);
    expect(isDevToolsKey(key({ meta: true, alt: true, key: 'ˆ' }), 'darwin')).toBe(true);
    expect(isDevToolsKey(key({ shift: true }), 'win32')).toBe(false);
    expect(isDevToolsKey(key({ control: true }), 'win32')).toBe(false);
    expect(isDevToolsKey(key({ control: true, shift: true, alt: true }), 'win32')).toBe(false);
    expect(isDevToolsKey(key({ control: true, shift: true, type: 'keyUp' }), 'win32')).toBe(false);
    expect(isDevToolsKey(key({ control: true, shift: true }), 'darwin')).toBe(false);
  });

  test('the policy\'s 2 forces them off, 0 and 1 leave the choice, and a forced value nobody can read is off', () => {
    expect(devToolsForcedOffBy({ value: 2, locked: true })).toBe(true);
    expect(devToolsForcedOffBy({ value: 0, locked: true })).toBe(false);
    expect(devToolsForcedOffBy({ value: 1, locked: true })).toBe(false);
    expect(devToolsForcedOffBy({ value: null, locked: true })).toBe(true);
    expect(devToolsForcedOffBy({ value: null, locked: false })).toBe(false);
  });

  test('usable only when turned on, not forced off and not locked', () => {
    expect(devToolsUsable({ stored: true, forcedOff: false, locked: false })).toBe(true);
    expect(devToolsUsable({ stored: false, forcedOff: false, locked: false })).toBe(false);
    expect(devToolsUsable({ stored: true, forcedOff: true, locked: false })).toBe(false);
    expect(devToolsUsable({ stored: true, forcedOff: false, locked: true })).toBe(false);
  });

  test('the warning speaks every language the keystore does, and names mail and passwords', () => {
    expect(Object.keys(DEVTOOLS_TEXT).sort()).toEqual(Object.keys(KEYSTORE_TEXT).sort());
    for (const text of Object.values(DEVTOOLS_TEXT)) expect(Object.values(text).every((value) => value.trim().length > 0)).toBe(true);
    expect(DEVTOOLS_TEXT.en.detail).toMatch(/mail/);
    expect(DEVTOOLS_TEXT.en.detail).toMatch(/passwords/);
    expect(devToolsTextFor('de-AT')).toBe(DEVTOOLS_TEXT.de);
    expect(devToolsTextFor('zh-Hant-TW')).toBe(DEVTOOLS_TEXT['zh-TW']);
    expect(devToolsTextFor('xx')).toBe(DEVTOOLS_TEXT.en);
  });
});
