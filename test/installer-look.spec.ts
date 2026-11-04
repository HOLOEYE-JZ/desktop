import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { icoSizes } from '../scripts/ico.mjs';

/**
 * How the installers look: the NSIS window in the app's colours (build/installer-theme.nsh),
 * its words in every language the installer has, and the DMG's background. Running the
 * installer takes a desktop; the README's checklist has that part.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD = path.join(ROOT, 'build');
const require = createRequire(path.join(ROOT, 'package.json'));
const yaml = require('js-yaml');
const { lcid } = require('app-builder-lib/out/util/langs');
const config = yaml.load(readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));
const TEMPLATES = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'nsis');

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const theme = () => read(path.join(BUILD, 'installer-theme.nsh'));
const STRINGS = ['bulwarkInstalling', 'bulwarkUpdating', 'bulwarkRemoving', 'bulwarkOpensAfter', 'bulwarkRestartsAfter'];

/** id -> language id -> text, from build/installer-strings.nsh. */
function strings(): Map<string, Map<number, string>> {
  const result = new Map<string, Map<number, string>>();
  for (const [, id, lang, text] of read(path.join(BUILD, 'installer-strings.nsh')).matchAll(/^LangString (\w+) (\d+) "(.*)"$/gm)) {
    if (!result.has(id)) result.set(id, new Map());
    result.get(id)!.set(Number(lang), text);
  }
  return result;
}

test.describe('the NSIS window', () => {
  test('is drawn by the include electron-builder takes', () => {
    expect(config.nsis.oneClick).toBe(true);
    const include = read(path.join(ROOT, config.nsis.include));
    expect(include).toContain('!include "${__FILEDIR__}\\installer-theme.nsh"');
    // The uninstaller's window is drawn first thing in the uninstall section.
    expect(include).toMatch(/!macro customUnInstall\n {2}!ifmacrodef bulwarkThemeUninstallerPage\n {4}!insertmacro bulwarkThemeUninstallerPage\n/);
  });

  test('has the app colours, light and dark, and Windows decides which', () => {
    const text = theme();
    expect(text).toContain('ReadRegDWORD $0 HKCU "${BULWARK_THEME_KEY}" "AppsUseLightTheme"');
    expect(text).toContain('"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"');
    // Background and text: the webmail's --color-background and --color-foreground.
    expect(text).toContain('SetCtlColors $R0 0F172A FFFFFF');
    expect(text).toContain('SetCtlColors $R0 FAFAFA 0A0A0A');
    expect(text).toContain('SetCtlColors ${HWND} 59687C FFFFFF');
    expect(text).toContain('SetCtlColors ${HWND} ADADAD 0A0A0A');
    // High Contrast keeps Windows' colours.
    expect(text).toContain("SystemParametersInfoW(i 0x42");
  });

  test('draws the progress bar flat, in the accent colour', () => {
    const text = theme();
    expect(text).toContain(`System::Call 'uxtheme::SetWindowTheme(p $R2, w "", w "")'`);
    // PBM_SETBARCOLOR and PBM_SETBKCOLOR, 0xBBGGRR: #185aea on #e2e8f0, #60a5fa on #262626.
    expect(text).toContain('SendMessage $R2 0x409 0 0xEA5A18');
    expect(text).toContain('SendMessage $R2 0x2001 0 0xF0E8E2');
    expect(text).toContain('SendMessage $R2 0x409 0 0xFAA560');
    expect(text).toContain('SendMessage $R2 0x2001 0 0x262626');
  });

  // Controls made from the install section belong to its thread, which paints them only
  // while it waits (ExecWait): on an update, while the old uninstaller ran, the lines got a
  // white background next to their text. So they're made in .onGUIInit, on the window's thread.
  test('makes its logo and lines on the window thread, not in the install section', () => {
    const text = theme();
    const body = (start: string, end: string) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
    const window = body('Function ${UN}bulwarkThemeWindow', 'FunctionEnd');
    expect(window.length).toBeGreaterThan(0);
    expect(window).not.toContain('CreateWindowEx');
    expect(body('!macro bulwarkThemeStatics', '!macroend').match(/user32::CreateWindowExW\(/g)).toHaveLength(3);
    expect(text.match(/user32::CreateWindowExW\(/g)).toHaveLength(3);
    for (const un of ['', 'un.']) expect(body(`Function ${un}bulwarkThemeGuiInit`, 'FunctionEnd'), `${un}bulwarkThemeGuiInit`).toContain('!insertmacro bulwarkThemeStatics');
    for (const name of ['$bulwarkLogo', '$bulwarkTitle', '$bulwarkLine']) expect(window).toContain(`SetWindowPos(p ${name}`);
  });

  test("keeps NSIS's integrity check and its message", () => {
    // SilentInstall would hide the "verifying installer" box, and the "integrity check failed" message with it.
    for (const file of [path.join(BUILD, 'installer-theme.nsh'), path.join(ROOT, config.nsis.include)]) {
      expect(read(file), file).not.toMatch(/^\s*(SilentInstall|SilentUnInstall|CRCCheck)\b/m);
    }
  });

  test('has a logo for every scale from 100 to 300 %', () => {
    expect(theme()).toContain('"${BULWARK_THEME_DIR}\\installer-logo.ico"');
    const sizes = icoSizes(readFileSync(path.join(BUILD, 'installer-logo.ico')));
    for (const scale of [100, 125, 150, 175, 200, 225, 250, 300]) expect(sizes).toContain((48 * scale) / 100);
  });

  test('says what it does in every language the installer has', () => {
    const table = strings();
    const languages: string[] = config.nsis.installerLanguages;
    const ids = languages.map((language) => lcid[language] as number);
    expect(ids.every((id) => typeof id === 'number')).toBe(true);
    for (const name of STRINGS) {
      const texts = table.get(name);
      expect(texts, name).toBeTruthy();
      // Exactly those: one more would be a language makensis doesn't load, and fails the build.
      expect([...texts!.keys()].sort(), name).toEqual([...ids].sort());
      const english = texts!.get(1033)!;
      for (const [id, value] of texts!) {
        expect(value, `${name} ${id}`).toContain('${PRODUCT_NAME}');
        if (id !== 1033) expect(value, `${name} ${id} is not translated`).not.toBe(english);
      }
    }
    expect(table.get('bulwarkInstalling')!.get(1033)).toBe('Installing ${PRODUCT_NAME}…');
    expect(table.get('bulwarkUpdating')!.get(1033)).toBe('Updating ${PRODUCT_NAME}…');
    expect(table.get('bulwarkRemoving')!.get(1033)).toBe('Removing ${PRODUCT_NAME}…');
    expect(table.get('bulwarkInstalling')!.get(1031)).toBe('${PRODUCT_NAME} wird installiert…');
    expect(table.get('bulwarkUpdating')!.get(1031)).toBe('${PRODUCT_NAME} wird aktualisiert…');
    expect(table.get('bulwarkRemoving')!.get(1031)).toBe('${PRODUCT_NAME} wird deinstalliert…');
    // makensis reads it as UTF-8 only with the mark.
    expect([...readFileSync(path.join(BUILD, 'installer-strings.nsh')).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  test('and the app languages are all there, but Farsi', () => {
    const app = ['ar', 'ca', 'cs', 'da', 'de', 'en', 'es', 'et', 'fa', 'fr', 'he', 'hu', 'it', 'ja', 'ko', 'lv', 'mn', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-TW'];
    const installer = (config.nsis.installerLanguages as string[]).map((language) => (language === 'zh_TW' ? 'zh-TW' : language.slice(0, 2)));
    expect(app.filter((language) => !installer.includes(language))).toEqual(['fa']);
  });

  // The window is drawn at a point in electron-builder's templates: after the banner is up,
  // in place of its "is the app running" check. An update of electron-builder that moves
  // these would leave the window unthemed or, as it starts see-through, unseen.
  test('hooks into electron-builder where it expects to', () => {
    const section = read(path.join(TEMPLATES, 'installSection.nsh'));
    const banner = section.indexOf('SpiderBanner::Show /MODERN');
    expect(banner).toBeGreaterThan(-1);
    expect(section.indexOf('!insertmacro CHECK_APP_RUNNING', banner)).toBeGreaterThan(banner);
    const check = read(path.join(TEMPLATES, 'include', 'allowOnlyOneInstallerInstance.nsh'));
    expect(check).toContain('!ifmacrondef customCheckAppRunning\n  !include "getProcessInfo.nsh"\n  Var pid\n!endif');
    expect(check).toMatch(/!ifmacrodef customCheckAppRunning\n\s+!insertmacro customCheckAppRunning\n\s+!else\n\s+!insertmacro IS_POWERSHELL_AVAILABLE\n\s+!insertmacro _CHECK_APP_RUNNING\n\s+!endif/);
    const uninstaller = read(path.join(TEMPLATES, 'uninstaller.nsh'));
    expect(uninstaller.indexOf('SetSilent silent')).toBeLessThan(uninstaller.indexOf('!insertmacro customUnInit'));
    const unSection = uninstaller.slice(uninstaller.indexOf('Section "un.${UNINSTALL_SECTION_NAME}"'));
    expect(unSection.indexOf('!insertmacro customUnInstall')).toBeLessThan(unSection.indexOf('RMDir /r $INSTDIR'));
    const oneClick = read(path.join(TEMPLATES, 'oneClick.nsh'));
    expect(oneClick).toContain('!insertmacro MUI_PAGE_INSTFILES');
  });
});

const CACHE = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
const hasNsis = existsSync(CACHE) && readdirSync(CACHE).some((entry) => entry.startsWith('nsis-') && !entry.startsWith('nsis-resources'));

// makensis runs with warnings as errors: a language without the window's words, or words for
// a language the installer doesn't load, fails here. Only built, never run.
test.describe('the installer with this config', () => {
  test.skip(process.platform !== 'win32' || !hasNsis, "needs Windows and electron-builder's NSIS");
  test.setTimeout(240_000);

  test('builds, installer and uninstaller', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-look-'));
    try {
      const app = path.join(dir, 'app');
      mkdirSync(app);
      writeFileSync(path.join(app, 'BulwarkTest.exe'), 'MZ');
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'bulwark-installer-look', productName: 'Bulwark Test', version: '0.1.0', description: 'Test', author: 'Test' }));
      const electron = JSON.parse(readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
      const out = path.join(dir, 'out');
      writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({
          appId: 'org.bulwarkmail.desktop.installerlook',
          productName: 'Bulwark Test',
          electronVersion: electron,
          directories: { output: out, buildResources: BUILD },
          publish: null,
          win: { icon: path.join(BUILD, 'icon.ico'), executableName: 'BulwarkTest', signAndEditExecutable: false, target: [{ target: 'nsis', arch: ['x64'] }] },
          nsis: { ...config.nsis, include: path.join(ROOT, config.nsis.include), shortcutName: 'Bulwark Test', uninstallDisplayName: 'Bulwark Test', artifactName: 'BulwarkTest-Setup.${ext}' },
        }),
      );
      const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
      const made = spawnSync(process.execPath, [cli, '--win', 'nsis', '--x64', '--prepackaged', app, '--projectDir', dir, '--config', path.join(dir, 'config.json'), '--publish', 'never'], {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
        timeout: 220_000,
      });
      expect(made.status, made.stdout + made.stderr).toBe(0);
      expect(existsSync(path.join(out, 'BulwarkTest-Setup.exe'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });
});

/** RGB rows of an 8-bit, non-interlaced PNG, as sharp writes them. */
function decodePng(file: string): { width: number; height: number; pixel: (x: number, y: number) => [number, number, number] } {
  const data = readFileSync(file);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect(body[8], 'bit depth').toBe(8);
      expect(body[12], 'interlace').toBe(0);
      channels = { 2: 3, 6: 4 }[body[9]] ?? 0;
      expect(channels, 'colour type').toBeGreaterThan(0);
    }
    if (type === 'IDAT') idat.push(body);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i += 1) {
      const value = raw[y * (stride + 1) + 1 + i];
      const a = i >= channels ? rows[y * stride + i - channels] : 0;
      const b = y > 0 ? rows[(y - 1) * stride + i] : 0;
      const c = i >= channels && y > 0 ? rows[(y - 1) * stride + i - channels] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter];
      rows[y * stride + i] = (value + predictor) & 0xff;
    }
  }
  return { width, height, pixel: (x, y) => [rows[y * stride + x * channels], rows[y * stride + x * channels + 1], rows[y * stride + x * channels + 2]] };
}

function luminance([r, g, b]: [number, number, number]): number {
  const linear = (value: number) => (value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

test.describe('the DMG', () => {
  test('has the background, at 1x and 2x', () => {
    expect(config.dmg.background).toBe('build/dmg-background.png');
    expect(config.dmg.contents, "the arrow is drawn for electron-builder's default places").toBeUndefined();
    const one = decodePng(path.join(ROOT, config.dmg.background));
    expect([one.width, one.height]).toEqual([540, 380]);
    const two = decodePng(path.join(ROOT, 'build', 'dmg-background@2x.png'));
    expect([two.width, two.height]).toEqual([1080, 760]);
    expect(existsSync(path.join(ROOT, 'assets', 'dmg-background.svg'))).toBe(true);
  });

  test('where Finder writes the names, black and white text both read', () => {
    const picture = decodePng(path.join(ROOT, config.dmg.background));
    // Under the 80-point icons at (130, 220) and (410, 220).
    for (const centre of [130, 410]) {
      for (let y = 262; y <= 300; y += 2) {
        for (let x = centre - 60; x <= centre + 60; x += 4) {
          const l = luminance(picture.pixel(x, y));
          expect((l + 0.05) / 0.05, `black at ${x},${y}`).toBeGreaterThanOrEqual(4.5);
          expect(1.05 / (l + 0.05), `white at ${x},${y}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
