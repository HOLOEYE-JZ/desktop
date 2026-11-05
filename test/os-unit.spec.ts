import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { FeatureContext } from '../src/main/features';
import { OsHub } from '../src/main/features/os-hub';
import { encodePng, overlayPng, overlayText, withUnreadDot } from '../src/main/features/os-icons';
import { systemExe } from '../src/main/system-exe';
import {
  buildToastXml,
  cleanSettingsPatch,
  closesToBackground,
  currentOsSettings,
  electronRegistersScheme,
  isAccelerator,
  quickComposeBuiltIn,
  quickComposeShortcut,
  showShortcutBuiltIn,
  isRetryableLoadError,
  launchSkipPaths,
  needsRegistration,
  reloadDelayMs,
  safeDragFileName,
  commandFromUrl,
  requestFromUrl,
  defaultSettings,
  fileReason,
  inQuietHours,
  LOGIN_FLAG,
  parseArgv,
  parseFocusAssist,
  parseToastArguments,
  parseToastUrl,
  safeFileName,
  toastArguments,
  toastUrl,
  windowsRegistration,
  windowsRegistrationKeys,
} from '../src/main/features/os-rules';

function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer } {
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat = png.indexOf('IDAT');
  const length = png.readUInt32BE(idat - 4);
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + length));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) raw.copy(rgba, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  return { width, height, rgba };
}

const ARGV_OPTIONS = { cwd: 'C:\\work', skip: ['C:\\app\\dist\\main.mjs'] };

test.describe('what a command line asks for', () => {
  test('a mailto after the handlers bare -- is a mailto, and switches are not requests', () => {
    const request = parseArgv(['bulwark.exe', '--some-chromium-switch', '--', 'mailto:a@example.org?subject=Hi'], ARGV_OPTIONS);
    expect(request.commands).toEqual([{ type: 'mailto', url: 'mailto:a@example.org?subject=Hi' }]);
    expect(request.files).toEqual([]);
  });

  test('past -- a switch is only a name, not a switch', () => {
    const request = parseArgv(['bulwark.exe', '--', '--inspect=9229'], ARGV_OPTIONS);
    expect(request.commands).toEqual([]);
    expect(request.files).toEqual(['C:\\work\\--inspect=9229']);
  });

  test('a Windows path is a file, not a URL scheme', () => {
    const request = parseArgv(['bulwark.exe', 'C:\\mail\\letter.eml'], ARGV_OPTIONS);
    expect(request.files).toEqual(['C:\\mail\\letter.eml']);
    expect(request.commands).toEqual([]);
  });

  test('a relative path resolves against where the launch came from', () => {
    expect(parseArgv(['bulwark.exe', 'letter.eml'], ARGV_OPTIONS).files).toEqual(['C:\\work\\letter.eml']);
  });

  test('the app\'s own script is skipped', () => {
    expect(parseArgv(['electron.exe', 'C:\\app\\dist\\main.mjs'], ARGV_OPTIONS).files).toEqual([]);
  });

  test('the login flag is noticed', () => {
    expect(parseArgv(['bulwark.exe', LOGIN_FLAG], ARGV_OPTIONS).fromLogin).toBe(true);
    expect(parseArgv(['bulwark.exe'], ARGV_OPTIONS).fromLogin).toBe(false);
  });

  test('COM starting us is a switch, not a file', () => {
    const request = parseArgv(['bulwark.exe', '-Embedding'], ARGV_OPTIONS);
    expect(request.files).toEqual([]);
    expect(request.commands).toEqual([]);
  });

  test('a toast URL is kept apart, unread, for its signature to be checked', () => {
    const request = parseArgv(['bulwark.exe', '--', 'bulwark://toast/archive?c=x&s=y'], ARGV_OPTIONS);
    expect(request.toastUrls).toEqual(['bulwark://toast/archive?c=x&s=y']);
    expect(request.commands).toEqual([]);
    expect(request.files).toEqual([]);
  });

  test('a packaged app has no script on its command line: the first file is a file', () => {
    expect(launchSkipPaths(false, 'C:\\app\\app.asar', 'C:\\mail\\first.eml')).toEqual([]);
    expect(launchSkipPaths(true, 'C:\\dev', 'C:\\dev\\dist\\main.mjs')).toEqual(['C:\\dev', 'C:\\dev\\dist\\main.mjs']);
    expect(parseArgv(['Bulwark.exe', 'C:\\mail\\first.eml'], { cwd: 'C:\\work', skip: launchSkipPaths(false, 'x', 'C:\\mail\\first.eml') }).files).toEqual(['C:\\mail\\first.eml']);
  });

  test('a URL stands alone: nothing next to it attaches a local file, and a second URL is dropped', () => {
    const broken = parseArgv(['bulwark.exe', '--', 'mailto:a@example.org', 'C:\\Users\\me\\secret.txt', 'webcal://x/y'], ARGV_OPTIONS);
    expect(broken.commands).toEqual([{ type: 'mailto', url: 'mailto:a@example.org' }]);
    expect(broken.files).toEqual([]);
    const before = parseArgv(['bulwark.exe', 'C:\\Users\\me\\secret.txt', 'mailto:a@example.org'], ARGV_OPTIONS);
    expect(before.files).toEqual([]);
    const unknown = parseArgv(['bulwark.exe', 'javascript:x', 'C:\\Users\\me\\secret.txt'], ARGV_OPTIONS);
    expect(unknown.files).toEqual([]);
  });

  test('several files together still open', () => {
    expect(parseArgv(['bulwark.exe', 'a.eml', 'b.eml'], ARGV_OPTIONS).files.length).toBe(2);
  });

  test('a Linux file manager\'s file: URL is a file; elsewhere it is nothing', () => {
    const linux = parseArgv(['bulwark', 'file:///home/me/a%20b.eml'], { cwd: '/home/me', skip: [], platform: 'linux' });
    expect(linux.files).toEqual(['/home/me/a b.eml']);
    expect(parseArgv(['bulwark', 'file://evil/share/a.eml'], { cwd: '/home/me', skip: [], platform: 'linux' }).files).toEqual([]);
    expect(parseArgv(['bulwark.exe', 'file:///c:/a.eml'], { ...ARGV_OPTIONS, platform: 'win32' }).files).toEqual([]);
  });

  test('unknown schemes do nothing', () => {
    const request = parseArgv(['bulwark.exe', 'javascript:alert(1)', 'file:///c:/x', 'https://example.org/'], ARGV_OPTIONS);
    expect(request.commands).toEqual([]);
    expect(request.files).toEqual([]);
  });
});

test.describe('bulwark: links only show things', () => {
  test('what they can name', () => {
    expect(requestFromUrl('bulwark://new')).toEqual({ commands: [{ type: 'new-message' }], links: [] });
    expect(requestFromUrl('bulwark://calendar')).toEqual({ commands: [{ type: 'navigate', target: 'calendar' }], links: [] });
    expect(requestFromUrl('bulwark://message/id-2?owner=acc1')).toEqual({ commands: [], links: [{ kind: 'message', emailId: 'id-2', account: undefined, owner: 'acc1' }] });
    expect(requestFromUrl('bulwark://mailbox/inbox-1')).toEqual({ commands: [], links: [{ kind: 'folder', folder: 'inbox-1' }] });
    expect(requestFromUrl('mailto:a@example.org')).toEqual({ commands: [{ type: 'mailto', url: 'mailto:a@example.org' }], links: [] });
  });

  test('a new message carries the parameters for a plugin of the page, and nothing else', () => {
    expect(requestFromUrl('bulwark://new?x-akte-case=01%2F2026&X-Akte-Court=AG%20Berlin&subject=Hi&x-=no&x-a%20b=no')).toEqual({
      commands: [{ type: 'new-message', params: { 'x-akte-case': '01/2026', 'x-akte-court': 'AG Berlin' } }],
      links: [],
    });
    expect(requestFromUrl('bulwark://new?subject=Hi')).toEqual({ commands: [{ type: 'new-message' }], links: [] });
    expect(requestFromUrl('bulwark://new?x-akte-note=a%0D%0Ab')).toEqual({ commands: [{ type: 'new-message', params: { 'x-akte-note': 'ab' } }], links: [] });
  });

  test('nothing that changes mail, and nothing unknown', () => {
    for (const url of ['bulwark://toast/archive?c=x&s=y', 'bulwark://archive/a/b', 'bulwark://delete/a/b', 'bulwark://new/x', 'bulwark://inbox/x', 'bulwark://calendar/a/b', 'https://example.org/']) {
      expect(requestFromUrl(url), url).toEqual({ commands: [], links: [] });
    }
  });

  test('the bulwark: part is the one parser\'s alone', () => {
    expect(commandFromUrl('bulwark://new')).toBeNull();
    expect(commandFromUrl('bulwark://message/a@b.example/c')).toBeNull();
  });

  test('a huge link is refused', () => {
    expect(commandFromUrl(`mailto:a@example.org?body=${'x'.repeat(9000)}`)).toBeNull();
  });
});

test.describe('quiet hours', () => {
  const at = (h: number, m: number) => new Date(2026, 10, 3, h, m);
  const night = { quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00' };

  test('across midnight', () => {
    expect(inQuietHours(night, at(23, 0))).toBe(true);
    expect(inQuietHours(night, at(6, 59))).toBe(true);
    expect(inQuietHours(night, at(7, 0))).toBe(false);
    expect(inQuietHours(night, at(21, 59))).toBe(false);
  });

  test('within a day', () => {
    const lunch = { quietHoursEnabled: true, quietHoursStart: '12:00', quietHoursEnd: '13:00' };
    expect(inQuietHours(lunch, at(12, 30))).toBe(true);
    expect(inQuietHours(lunch, at(13, 0))).toBe(false);
  });

  test('off means off, and equal times are no window', () => {
    expect(inQuietHours({ ...night, quietHoursEnabled: false }, at(23, 0))).toBe(false);
    expect(inQuietHours({ ...night, quietHoursEnd: '22:00' }, at(22, 0))).toBe(false);
  });
});

test.describe('quick compose keys', () => {
  const free = { value: null, locked: false };

  test('nobody chose: the built-in ones', () => {
    expect(quickComposeShortcut(free, undefined)).toBe('CommandOrControl+Alt+N');
    expect(quickComposeShortcut(free, undefined, 'CommandOrControl+Alt+M')).toBe('CommandOrControl+Alt+M');
    expect(quickComposeShortcut(free, undefined, null)).toBeNull();
  });

  test('a recommendation goes over those, the user over it, and off counts as a choice', () => {
    const recommended = { value: 'Ctrl+Alt+J', locked: false };
    expect(quickComposeShortcut(recommended, undefined)).toBe('Ctrl+Alt+J');
    expect(quickComposeShortcut(recommended, 'Ctrl+Alt+K')).toBe('Ctrl+Alt+K');
    expect(quickComposeShortcut(recommended, null)).toBeNull();
    expect(quickComposeShortcut({ value: 'off', locked: false }, undefined)).toBeNull();
    expect(quickComposeShortcut({ value: 'off', locked: false }, 'Ctrl+Alt+K')).toBe('Ctrl+Alt+K');
  });

  test('forced goes over everyone, and forced off means off', () => {
    expect(quickComposeShortcut({ value: 'Ctrl+Alt+J', locked: true }, 'Ctrl+Alt+K')).toBe('Ctrl+Alt+J');
    expect(quickComposeShortcut({ value: 'Ctrl+Alt+J', locked: true }, null)).toBe('Ctrl+Alt+J');
    expect(quickComposeShortcut({ value: 'off', locked: true }, 'Ctrl+Alt+K')).toBeNull();
  });

  test('the built-in keys off Windows have no AltGr to fight with', () => {
    expect(quickComposeBuiltIn('darwin')).toBe('CommandOrControl+Alt+N');
    expect(quickComposeBuiltIn('linux')).toBe('CommandOrControl+Alt+N');
  });

  test('the built-in keys get past the rules for what a page may set, so turning it on works', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const keys = quickComposeBuiltIn(platform);
      expect(isAccelerator(keys, platform)).toBe(true);
    }
  });
});

test.describe('what a global shortcut would take from each Windows keyboard', () => {
  // Read from the DLLs of every layout Windows ships: test/support/keyboard-layouts.py.
  const layouts = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'keyboard-layouts.json'), 'utf8')) as Record<string, { name: string; file: string; ctrlAlt: string; ctrlAltShift: string }>;
  const typed = (keys: string) => new Set(keys.split(' ').flatMap((part, index) => (index === 0 ? [...part] : [part])));
  const VIRTUAL_KEY: Record<string, string> = { Enter: 'vk0d' };

  test('the table is real: every layout read, and AltGr+N types on Czech, as it was reported', () => {
    expect(Object.keys(layouts).length).toBeGreaterThan(200);
    expect(typed(layouts['00000405'].ctrlAlt).has('N')).toBe(true);
    expect(typed(layouts['00000407'].ctrlAlt).has('E')).toBe(true);
    expect(typed(layouts['00000415'].ctrlAltShift).has('N')).toBe(true);
  });

  test('no letter or digit is free on all of them, with or without Shift', () => {
    for (const keys of ['ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']) {
      for (const key of keys) {
        const hit = Object.values(layouts).some((layout) => typed(layout.ctrlAlt).has(key));
        const hitWithShift = Object.values(layouts).some((layout) => typed(layout.ctrlAltShift).has(key));
        expect(hit, `Ctrl+Alt+${key}`).toBe(true);
        expect(hitWithShift, `Ctrl+Alt+Shift+${key}`).toBe(true);
      }
    }
  });

  for (const [id, layout] of Object.entries(layouts)) {
    test(`the built-in keys type nothing on ${layout.name} (${id}, ${layout.file})`, () => {
      const parts = quickComposeBuiltIn('win32').split('+');
      const key = parts.at(-1)!;
      const column = parts.includes('Shift') ? layout.ctrlAltShift : layout.ctrlAlt;
      expect(parts.slice(0, -1)).toEqual(expect.arrayContaining(['CommandOrControl', 'Alt']));
      expect(typed(column).has(VIRTUAL_KEY[key] ?? key), `${layout.name} types something with ${parts.join('+')}`).toBe(false);
    });
  }
});

test.describe('the keys a page may hold for every app', () => {
  const REFUSED = [
    ['Ctrl+V', 'CommandOrControl+V'],
    ['Ctrl+C', 'CommandOrControl+C'],
    ['Ctrl+C, spelt out', 'Ctrl+C'],
    ['Shift+A', 'Shift+A'],
    ['Alt+Tab', 'Alt+Tab'],
    ['Alt+F4', 'Alt+F4'],
    ['Alt+Shift+A, which types on a Mac', 'Alt+Shift+A'],
    ['Ctrl+F4', 'CommandOrControl+F4'],
    ['Ctrl+Alt+Delete', 'CommandOrControl+Alt+Delete'],
    ['Ctrl+Shift+Esc', 'CommandOrControl+Shift+Esc'],
    ['Ctrl+Alt+Tab', 'CommandOrControl+Alt+Tab'],
    ['the Windows key and L', 'Super+L'],
    ['the Windows key with Shift+S', 'Super+Shift+S'],
    ['Meta with Ctrl', 'Meta+Control+D'],
    ['AltGr, which types', 'AltGr+Shift+N'],
    ['the same modifier twice', 'Alt+Alt+N'],
    ['Ctrl+Shift+V, paste in every terminal', 'CommandOrControl+Shift+V'],
    ['one key under two names', 'CommandOrControl+Control+N'],
    ['a key with no modifier', 'F9'],
    ['nonsense', 'rm -rf'],
  ] as const;
  for (const [name, keys] of REFUSED) {
    test(`refuses ${name}, for both shortcuts`, () => {
      expect(cleanSettingsPatch({ quickComposeShortcut: keys })).toEqual({});
      expect(cleanSettingsPatch({ showShortcut: keys })).toEqual({});
    });
  }

  for (const keys of ['CommandOrControl+Alt+Enter', 'CommandOrControl+Alt+F11', 'CommandOrControl+Alt+Shift+F9', 'Ctrl+Alt+J', 'CommandOrControl+Alt+7']) {
    test(`takes ${keys}`, () => {
      expect(cleanSettingsPatch({ quickComposeShortcut: keys })).toEqual({ quickComposeShortcut: keys });
      expect(cleanSettingsPatch({ showShortcut: keys })).toEqual({ showShortcut: keys });
    });
  }

  // The composer's and the menus' own: a global key would take them from Bulwark itself.
  for (const keys of ['CommandOrControl+Shift+B', 'CommandOrControl+Shift+C', 'CommandOrControl+Shift+Enter', 'CommandOrControl+Shift+M', 'CommandOrControl+Shift+N', 'CommandOrControl+Shift+S', 'CommandOrControl+Shift+R', 'CommandOrControl+Shift+F']) {
    test(`refuses ${keys}, a key of the app's own`, () => {
      for (const platform of ['win32', 'darwin', 'linux']) expect(isAccelerator(keys, platform), platform).toBe(false);
      expect(cleanSettingsPatch({ showShortcut: keys })).toEqual({});
    });
  }

  test('"Show Bulwark" by default is no key of the app\'s and passes the rules', () => {
    for (const platform of ['win32', 'darwin', 'linux']) expect(isAccelerator(showShortcutBuiltIn(platform), platform), platform).toBe(true);
    expect(showShortcutBuiltIn('win32')).toBe('CommandOrControl+Alt+F11');
    expect(showShortcutBuiltIn('darwin')).toBe('CommandOrControl+Alt+B');
  });

  test('the old built-in Ctrl+Shift+B, stored by switching it on, becomes the new one; a key someone chose stays', () => {
    expect(currentOsSettings({ showShortcut: 'CommandOrControl+Shift+B' }, 'win32')).toEqual({ showShortcut: 'CommandOrControl+Alt+F11' });
    expect(currentOsSettings({ showShortcut: 'CommandOrControl+Shift+B' }, 'linux')).toEqual({ showShortcut: 'CommandOrControl+Alt+B' });
    expect(currentOsSettings({ showShortcut: 'Ctrl+Alt+J' }, 'win32')).toEqual({ showShortcut: 'Ctrl+Alt+J' });
    expect(currentOsSettings({ showShortcut: null }, 'win32')).toEqual({ showShortcut: null });
  });

  test('a Mac\'s own keys are refused there, and free elsewhere', () => {
    expect(isAccelerator('CommandOrControl+Shift+4', 'darwin')).toBe(false);
    expect(isAccelerator('Command+Control+Q', 'darwin')).toBe(false);
    expect(isAccelerator('CommandOrControl+Alt+M', 'darwin')).toBe(false);
    expect(isAccelerator('CommandOrControl+Shift+4', 'win32')).toBe(true);
    expect(isAccelerator('CommandOrControl+Alt+M', 'win32')).toBe(true);
    expect(isAccelerator('CommandOrControl+Control+N', 'darwin')).toBe(true);
  });

  test('a policy isn\'t held to this: an admin chose it', () => {
    expect(quickComposeShortcut({ value: 'CommandOrControl+V', locked: true }, 'CommandOrControl+Alt+J')).toBe('CommandOrControl+V');
    expect(quickComposeShortcut({ value: 'Alt+F4', locked: false }, undefined)).toBe('Alt+F4');
  });
});

test.describe('closing the last window', () => {
  test('stays in the tray while a Files drive is on, even with closing to the tray off', () => {
    const base = { closeToTray: false, hasTray: true, platform: 'win32', driveOn: false };
    expect(closesToBackground(base)).toBe(false);
    expect(closesToBackground({ ...base, driveOn: true })).toBe(true);
    expect(closesToBackground({ ...base, closeToTray: true })).toBe(true);
    // Nowhere to come back from: it quits, drive or not.
    expect(closesToBackground({ ...base, driveOn: true, hasTray: false })).toBe(false);
    expect(closesToBackground({ ...base, driveOn: true, hasTray: false, platform: 'darwin' })).toBe(true);
  });
});

test.describe('settings from a page', () => {
  test('only known keys of the right type', () => {
    expect(cleanSettingsPatch({ closeToTray: false, nonsense: true, startAtLogin: 'yes' })).toEqual({ closeToTray: false });
    expect(cleanSettingsPatch({ quietHoursStart: '25:00', quietHoursEnd: '07:30' })).toEqual({ quietHoursEnd: '07:30' });
    expect(cleanSettingsPatch({ showShortcut: 'rm -rf' })).toEqual({});
    expect(cleanSettingsPatch({ showShortcut: 'CommandOrControl+Alt+B' })).toEqual({ showShortcut: 'CommandOrControl+Alt+B' });
    expect(cleanSettingsPatch({ showShortcut: null })).toEqual({ showShortcut: null });
    expect(cleanSettingsPatch({ quickComposeShortcut: 'rm -rf' })).toEqual({});
    expect(cleanSettingsPatch({ quickComposeShortcut: 'CommandOrControl+Alt+M' })).toEqual({ quickComposeShortcut: 'CommandOrControl+Alt+M' });
    expect(cleanSettingsPatch({ quickComposeShortcut: null })).toEqual({ quickComposeShortcut: null });
    expect(cleanSettingsPatch(null)).toEqual({});
  });

  test('plain GNOME has no tray to close into, Ubuntu\'s does', () => {
    expect(defaultSettings('linux', { XDG_CURRENT_DESKTOP: 'GNOME' }).closeToTray).toBe(false);
    expect(defaultSettings('linux', { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }).closeToTray).toBe(true);
    expect(defaultSettings('win32', {}).closeToTray).toBe(true);
  });
});

test.describe('Do Not Disturb', () => {
  test('profile and shell state', () => {
    expect(parseFocusAssist('0 5\r\n')).toBe('off');
    expect(parseFocusAssist('1 5')).toBe('priority');
    expect(parseFocusAssist('2 5')).toBe('alarms');
    expect(parseFocusAssist('0 3')).toBe('fullscreen');
    expect(parseFocusAssist('0 4')).toBe('fullscreen');
    expect(parseFocusAssist('garbage')).toBe('off');
  });
});

test.describe('file names', () => {
  test('never a path', () => {
    expect(safeFileName('..\\..\\windows\\system32\\evil.dll')).toBe('_.._windows_system32_evil.dll'.replace(/^_\.\./, '_..'));
    expect(safeFileName('../../etc/passwd')).not.toContain('/');
    expect(safeFileName('a:b*c?.txt')).toBe('a_b_c_.txt');
  });

  test('files that run something by being opened are made inert', () => {
    for (const name of ['evil.lnk', 'evil.URL', 'evil.scf', 'evil.library-ms']) expect(safeDragFileName(name)).toBe(`${name}.txt`);
    expect(safeDragFileName('report.pdf')).toBe('report.pdf');
  });

  test('every spelling Windows reserves', () => {
    for (const name of ['CONIN$', 'conout$.txt', 'COM\u00b9', 'lpt\u00b2.log', 'con .txt', 'com0']) expect(safeFileName(name).startsWith('_'), name).toBe(true);
    expect(safeFileName('console.txt')).toBe('console.txt');
  });

  test('reserved names and trailing dots', () => {
    expect(safeFileName('con.txt')).toBe('_con.txt');
    expect(safeFileName('report. . ')).toBe('report');
    expect(safeFileName('', 'attachment')).toBe('attachment');
  });

  test('direction overrides that fake an extension go', () => {
    expect(safeFileName('invoice\u202egpj.exe')).toBe('invoicegpj.exe');
  });

  test('length is capped and the extension kept', () => {
    const long = safeFileName(`${'x'.repeat(400)}.eml`);
    expect(long.length).toBeLessThanOrEqual(150);
    expect(long.endsWith('.eml')).toBe(true);
  });

  test('what counts as opening and what as attaching', () => {
    expect(fileReason('a.EML')).toBe('open');
    expect(fileReason('a.ics')).toBe('open');
    expect(fileReason('a.vcf')).toBe('open');
    expect(fileReason('a.pdf')).toBe('attach');
  });
});

const SECRET = 'a key of this install';

test.describe('toast', () => {
  const toast = {
    title: 'Alice <alice@example.org> & co',
    body: 'Quote " and <b>tag</b>',
    silent: true,
    context: '{"emailId":"e&1"}',
    actions: [{ id: 'archive', label: 'Archive' }, { id: 'mark-read', label: 'Mark read' }, { id: 'delete', label: 'Delete' }],
    reply: { label: 'Reply', placeholder: 'Type a reply' },
  };

  test('nothing from a mail breaks out of the XML', () => {
    const xml = buildToastXml(toast, SECRET, true);
    expect(xml).not.toContain('<b>');
    expect(xml).not.toContain('Alice <alice');
    expect(xml).toContain('&#60;b&#62;');
  });

  test('a cut-off subject with half an emoji stays valid XML', () => {
    const xml = buildToastXml({ ...toast, body: 'Cut \ud83d' }, SECRET, true);
    expect((xml as string & { isWellFormed(): boolean }).isWellFormed()).toBe(true);
  });

  test('where the activator isn\'t known to answer, Reply opens the composer: no field to lose text in', () => {
    const xml = buildToastXml(toast, SECRET, false);
    expect(xml).not.toContain('<input');
    expect(xml).not.toContain('hint-inputId');
    expect(xml).toMatch(/content="Reply" activationType="protocol" arguments="bulwark:\/\/toast\/reply/);
  });

  test('has every button and the reply field, and stays silent', () => {
    const xml = buildToastXml(toast, SECRET, true);
    for (const label of ['Archive', 'Mark read', 'Delete', 'Reply']) expect(xml).toContain(`content="${label}"`);
    expect(xml).toContain('<input id="reply" type="text"');
    expect(xml).toContain('hint-inputId="reply"');
    expect(xml).toContain('<audio silent="true"/>');
  });

  test('buttons and the click work with the app closed; only the reply needs the activator', () => {
    const xml = buildToastXml(toast, SECRET, true);
    expect(xml).toMatch(/<toast launch="bulwark:\/\/toast\/open[^"]*" activationType="protocol">/);
    expect(xml).toMatch(/content="Archive" activationType="protocol" arguments="bulwark:\/\/toast\/archive/);
    expect(xml).toMatch(/content="Reply" hint-inputId="reply" activationType="foreground" arguments="bulwark:reply:/);
  });

  test('a page can link to a toast URL, and it does nothing without this install\'s key', () => {
    const url = toastUrl('archive', toast.context, SECRET);
    expect(parseToastUrl(url, SECRET)).toEqual({ action: 'archive', context: toast.context });
    expect(parseToastUrl(url, 'another install')).toBeNull();
    expect(parseToastUrl(url.replace('/archive?', '/delete?'), SECRET)).toBeNull();
    expect(parseToastUrl(url.replace(/c=[^&]*/, 'c=%7B%7D'), SECRET)).toBeNull();
    expect(parseToastUrl('bulwark://toast/archive?c=x', SECRET)).toBeNull();
    expect(parseToastUrl('bulwark://toast/archive?c=x&s=', SECRET)).toBeNull();
    expect(parseToastUrl('bulwark://new', SECRET)).toBeNull();
  });

  test('what the activator hands back says which button for which message', () => {
    const args = toastArguments('reply', toast.context);
    expect(parseToastArguments(args)).toEqual({ action: 'reply', context: toast.context });
    expect(parseToastArguments('type=click&tag=abc')).toBeNull();
    expect(parseToastArguments('bulwark:')).toBeNull();
  });

  test('a locked toast is only what it was given', () => {
    const xml = buildToastXml({ title: 'Bulwark', body: 'You have new mail', silent: true, context: '', actions: [] }, SECRET, true);
    expect(xml).not.toContain('<actions>');
    expect(xml).not.toContain('<input');
  });
});

test.describe('registry', () => {
  const values = windowsRegistration('C:\\Apps\\Bulwark\\Bulwark.exe');
  const find = (key: string, name?: string) => values.find((v) => v.key === key && v.name === name);

  test('offers the app, and does not touch a default', () => {
    expect(find('Software\\RegisteredApplications', 'Bulwark')?.data).toBe('Software\\Bulwark\\Capabilities');
    expect(find('Software\\Bulwark\\Capabilities\\UrlAssociations', 'mailto')?.data).toBe('Bulwark.Url.mailto');
    expect(find('Software\\Bulwark\\Capabilities\\FileAssociations', '.eml')?.data).toBe('Bulwark.File.eml');
    expect(values.some((v) => /Classes\\(mailto|webcal)($|\\)/.test(v.key))).toBe(false);
    expect(values.some((v) => /UserChoice/.test(v.key))).toBe(false);
  });

  test('handlers pass the URL past a bare --, quoted', () => {
    expect(find('Software\\Classes\\Bulwark.Url.mailto\\shell\\open\\command')?.data).toBe('"C:\\Apps\\Bulwark\\Bulwark.exe" -- "%1"');
  });

  test('webcals: is offered too, and taking it away asks for the key once', () => {
    expect(find('Software\\Bulwark\\Capabilities\\UrlAssociations', 'webcals')?.data).toBe('Bulwark.Url.webcal');
    const { keys } = windowsRegistrationKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('an uninstall and a reinstall to the same path registers again: the registry decides', () => {
    const exe = 'C:\\Apps\\Bulwark.exe';
    expect(needsRegistration({ ok: false, stdout: '' }, exe)).toBe(true);
    expect(needsRegistration({ ok: true, stdout: 'REG_SZ "C:\\Old\\Bulwark.exe" -- "%1"' }, exe)).toBe(true);
    expect(needsRegistration({ ok: true, stdout: 'REG_SZ "c:\\apps\\bulwark.exe" -- "%1"' }, exe)).toBe(false);
  });

  test('only the exact command counts as registered: the right exe without the terminator does not', () => {
    const exe = 'C:\\Apps\\Bulwark.exe';
    const answer = (command: string) => ({ ok: true, stdout: `\r\nHKEY_CURRENT_USER\\Software\\Classes\\bulwark\\shell\\open\\command\r\n    (Standard)    REG_SZ    ${command}\r\n\r\n` });
    expect(needsRegistration(answer(`"${exe}" -- "%1"`), exe)).toBe(false);
    expect(needsRegistration(answer(`"${exe}" "%1"`), exe)).toBe(true);
    expect(needsRegistration(answer(`"${exe}" -- "%1" --extra`), exe)).toBe(true);
    expect(needsRegistration(answer(`"${exe}.old" -- "%1"`), exe)).toBe(true);
    expect(needsRegistration({ ok: true, stdout: '' }, exe)).toBe(true);
  });

  test('on Windows the app registers its scheme itself: Electron\'s call would leave out the terminator', () => {
    expect(electronRegistersScheme('win32', true)).toBe(false);
    expect(electronRegistersScheme('darwin', true)).toBe(true);
    expect(electronRegistersScheme('linux', true)).toBe(true);
    expect(electronRegistersScheme('linux', false)).toBe(false);
  });

  test('taking it away removes only what is ours', () => {
    const { keys, values: removed } = windowsRegistrationKeys();
    expect(keys).toContain('Software\\Bulwark');
    expect(keys).toContain('Software\\Classes\\Bulwark.Url.mailto');
    expect(keys.some((key) => /\\\.eml$/.test(key))).toBe(false);
    expect(removed).toContainEqual({ key: 'Software\\Classes\\.eml\\OpenWithProgids', name: 'Bulwark.File.eml' });
  });
});

test.describe('the lock in main', () => {
  const contents = { id: 1 };
  const hub = () => {
    const windows = new EventEmitter() as EventEmitter & { mainWindow: () => unknown; broadcast: () => void };
    windows.mainWindow = () => ({ webContents: contents });
    windows.broadcast = () => {};
    return new OsHub({ windows, state: { data: {}, touch() {}, save() {} }, showMain() {} } as unknown as FeatureContext);
  };
  const summary = { unread: [{ emailId: 'e', accountId: 'a', sender: 's', subject: 'Secret' }], recent: [], nextEvent: null };

  test('fails closed: locked until the main window has said otherwise', () => {
    const os = hub();
    expect(os.locked).toBe(true);
    os.setSummary(summary);
    expect(os.summary.unread).toEqual([]);
    os.setLockedByPage(false, { id: 2 } as never);
    expect(os.locked).toBe(true);
    os.setLockedByPage(false, contents as never);
    expect(os.locked).toBe(false);
    expect(os.summary.unread.length).toBe(1);
  });

  test('a real lock forgets what was showing; not having heard yet does not', () => {
    const os = hub();
    os.setSummary(summary);
    expect(os.lockIsReal).toBe(false);
    os.setLockedByPage(true, contents as never);
    expect(os.lockIsReal).toBe(true);
    os.setLockedByPage(false, contents as never);
    expect(os.summary.unread).toEqual([]);
  });

  test("main's verdict stands over any page's, and main can lift it", () => {
    const os = hub();
    os.setLockedByMain(true);
    os.setLockedByPage(false, contents as never);
    expect(os.locked).toBe(true);
    os.setLockedByMain(false);
    expect(os.locked).toBe(false);
  });
});

test.describe('a new message with parameters for a plugin', () => {
  const setup = () => {
    const sent: unknown[] = [];
    const contents = { id: 1, isDestroyed: () => false, send: (_channel: string, command: unknown) => sent.push(command) };
    const windows = new EventEmitter() as EventEmitter & { mainWindow: () => unknown; broadcast: () => void; startMainHidden: () => void };
    windows.mainWindow = () => ({ webContents: contents });
    windows.broadcast = () => {};
    windows.startMainHidden = () => {};
    const os = new OsHub({ windows, state: { data: {}, touch() {}, save() {} }, showMain() {} } as unknown as FeatureContext);
    os.subscribe(contents as never);
    os.setLockedByPage(false, contents as never);
    let quick = 0;
    os.quickCompose = () => { quick += 1; };
    return { os, sent, quick: () => quick };
  };

  test('goes to the page, which hands them over; without them it is quick compose', () => {
    const { os, sent, quick } = setup();
    os.dispatch({ type: 'new-message', params: { 'x-akte-case': '01/2026' } });
    expect(quick()).toBe(0);
    expect(sent).toEqual([{ type: 'new-message', params: { 'x-akte-case': '01/2026' } }]);
    os.dispatch({ type: 'new-message' });
    expect(quick()).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

test.describe('a saved message opened from Explorer', () => {
  const eml = { type: 'files' as const, reason: 'open' as const, files: [{ name: 'letter.eml', data: new Uint8Array([1]) }], failed: [] };
  const setup = (options?: unknown) => {
    const sent: unknown[] = [];
    const contents = { id: 1, isDestroyed: () => false, send: (_channel: string, command: unknown) => sent.push(command) };
    const windows = new EventEmitter() as EventEmitter & { mainWindow: () => unknown; broadcast: () => void; startMainHidden: () => void };
    windows.mainWindow = () => ({ webContents: contents });
    windows.broadcast = () => {};
    windows.startMainHidden = () => {};
    let shown = 0;
    const os = new OsHub({ windows, state: { data: {}, touch() {}, save() {} }, showMain() { shown += 1; } } as unknown as FeatureContext);
    os.subscribe(contents as never, options);
    os.setLockedByPage(false, contents as never);
    return { os, sent, shown: () => shown };
  };

  // desktop-p3-5: the main window came out of the tray to show it.
  test('leaves the main window where it is for a page that opens it in a message window', () => {
    const { os, sent, shown } = setup({ messageFileWindows: true });
    expect(os.messageFileWindows).toBe(true);
    os.dispatch(eml);
    expect(sent).toHaveLength(1);
    expect(shown()).toBe(0);
  });

  test('an older page shows it in the main window, so that comes up', () => {
    const { os, shown } = setup();
    expect(os.messageFileWindows).toBe(false);
    os.dispatch(eml);
    expect(shown()).toBe(1);
  });

  test('locked, an .ics beside it, or a file that could not be read: the main window comes up', () => {
    const locked = setup({ messageFileWindows: true });
    locked.os.setLockedByPage(true, {} as never);
    locked.os.dispatch(eml);
    expect(locked.shown()).toBe(1);
    const mixed = setup({ messageFileWindows: true });
    mixed.os.dispatch({ ...eml, files: [...eml.files, { name: 'party.ics', data: new Uint8Array([1]) }] });
    expect(mixed.shown()).toBe(1);
    const failed = setup({ messageFileWindows: true });
    failed.os.dispatch({ ...eml, failed: ['gone.eml'] });
    expect(failed.shown()).toBe(1);
  });

  test('only a strict true counts', () => {
    expect(setup({ messageFileWindows: 'yes' }).os.messageFileWindows).toBe(false);
    expect(setup('messageFileWindows').os.messageFileWindows).toBe(false);
  });
});

test.describe('programs and retries', () => {
  test('no source file runs a Windows tool by its bare name', () => {
    const dir = path.resolve(import.meta.dirname, '..', 'src', 'main');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(10);
    for (const name of files) {
      const source = readFileSync(path.join(dir, name), 'utf8');
      expect(source, name).not.toMatch(/(execFile|spawn|exec|execFileSync|spawnSync)\(\s*['"`](reg|powershell|cmd|where|osascript|gsettings)(\.exe)?['"`]/i);
    }
  });

  test('Windows tools go by full path, never looked for next to a file', () => {
    expect(systemExe('reg.exe', 'C:\\Windows')).toBe('C:\\Windows\\System32\\reg.exe');
    expect(systemExe('powershell.exe', 'C:\\Windows')).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  test('a failed load backs off, up to a minute, and only for network errors', () => {
    expect([0, 1, 2, 3, 4, 9].map(reloadDelayMs)).toEqual([2000, 5000, 15000, 30000, 60000, 60000]);
    expect(isRetryableLoadError(-106)).toBe(true);
    expect(isRetryableLoadError(-3)).toBe(false);
    expect(isRetryableLoadError(-202)).toBe(false);
  });
});

test.describe('images made in code', () => {
  test('the overlay is a circle, transparent in the corners, with white figures', () => {
    const { width, height, rgba } = decodePng(overlayPng(7, 16));
    expect([width, height]).toEqual([16, 16]);
    expect(rgba[3]).toBe(0);
    let white = 0;
    for (let at = 0; at < rgba.length; at += 4) if (rgba[at] === 255 && rgba[at + 1] === 255 && rgba[at + 2] === 255 && rgba[at + 3] === 255) white += 1;
    expect(white).toBeGreaterThan(5);
  });

  test('different counts look different', () => {
    expect(overlayPng(1, 16).equals(overlayPng(2, 16))).toBe(false);
    expect(overlayPng(12, 32).equals(overlayPng(13, 32))).toBe(false);
  });

  test('past 99 it stops counting', () => {
    expect(overlayText(100)).toBe('99+');
    expect(overlayText(99)).toBe('99');
    expect(overlayPng(150, 16).equals(overlayPng(100, 16))).toBe(true);
    expect(overlayPng(100, 16).equals(overlayPng(99, 16))).toBe(false);
  });

  test('the unread dot goes on the bottom right, in colour, and leaves the rest alone', () => {
    const size = 16;
    const bgra = new Uint8Array(size * size * 4).fill(255);
    const { rgba } = decodePng(withUnreadDot(bgra, size, [0xdb, 0x2d, 0x54]));
    const at = (x: number, y: number) => (y * size + x) * 4;
    expect(rgba[at(13, 13)]).toBe(0xdb);
    expect(rgba[at(13, 13) + 1]).toBe(0x2d);
    expect(rgba[at(2, 2)]).toBe(255);
    expect(rgba[at(2, 2) + 1]).toBe(255);
  });

  test('a PNG round trip keeps the pixels', () => {
    const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const decoded = decodePng(encodePng(rgba, 2, 1));
    expect([...decoded.rgba]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
