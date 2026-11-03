import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { encodePng, overlayPng, overlayText, withUnreadDot } from '../src/main/features/os-icons';
import { systemExe } from '../src/main/system-exe';
import {
  buildToastXml,
  cleanSettingsPatch,
  isRetryableLoadError,
  launchSkipPaths,
  needsRegistration,
  reloadDelayMs,
  safeDragFileName,
  commandFromUrl,
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
    expect(commandFromUrl('bulwark://new')).toEqual({ type: 'new-message' });
    expect(commandFromUrl('bulwark://calendar')).toEqual({ type: 'navigate', target: 'calendar' });
    expect(commandFromUrl('bulwark://message/acc%2F1/id-2')).toEqual({ type: 'open-message', accountId: 'acc/1', emailId: 'id-2' });
    expect(commandFromUrl('bulwark://mailbox/inbox-1')).toEqual({ type: 'open-mailbox', mailboxId: 'inbox-1' });
    expect(commandFromUrl('bulwark://folder/inbox')).toEqual({ type: 'open-mailbox', mailboxId: 'inbox' });
  });

  test('nothing that changes mail, and nothing unknown', () => {
    for (const url of ['bulwark://toast/archive?c=x&s=y', 'bulwark://archive/a/b', 'bulwark://delete/a/b', 'bulwark://notification/archive', 'bulwark://message/only-one', 'bulwark://message/%E0%A4%A/x']) {
      expect(commandFromUrl(url), url).toBeNull();
    }
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

test.describe('settings from a page', () => {
  test('only known keys of the right type', () => {
    expect(cleanSettingsPatch({ closeToTray: false, nonsense: true, startAtLogin: 'yes' })).toEqual({ closeToTray: false });
    expect(cleanSettingsPatch({ quietHoursStart: '25:00', quietHoursEnd: '07:30' })).toEqual({ quietHoursEnd: '07:30' });
    expect(cleanSettingsPatch({ showShortcut: 'rm -rf' })).toEqual({});
    expect(cleanSettingsPatch({ showShortcut: 'CommandOrControl+Shift+B' })).toEqual({ showShortcut: 'CommandOrControl+Shift+B' });
    expect(cleanSettingsPatch({ showShortcut: null })).toEqual({ showShortcut: null });
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

  test('taking it away removes only what is ours', () => {
    const { keys, values: removed } = windowsRegistrationKeys();
    expect(keys).toContain('Software\\Bulwark');
    expect(keys).toContain('Software\\Classes\\Bulwark.Url.mailto');
    expect(keys.some((key) => /\\\.eml$/.test(key))).toBe(false);
    expect(removed).toContainEqual({ key: 'Software\\Classes\\.eml\\OpenWithProgids', name: 'Bulwark.File.eml' });
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
