import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { icoSizes } from '../scripts/ico.mjs';

/**
 * How the installers look: the NSIS window, a borderless square painted by the BulwarkSplash
 * plugin (native/nsis-splash, called from build/installer-theme.nsh), its words in every
 * language the installer has, and the DMG's background.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD = path.join(ROOT, 'build');
const PLUGIN = path.join(BUILD, 'x86-unicode', 'BulwarkSplash.dll');
const require = createRequire(path.join(ROOT, 'package.json'));
const yaml = require('js-yaml');
const { lcid } = require('app-builder-lib/out/util/langs');
const config = yaml.load(readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));
const TEMPLATES = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'nsis');

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const theme = () => read(path.join(BUILD, 'installer-theme.nsh'));
const splash = () => read(path.join(ROOT, 'native', 'nsis-splash', 'splash.c'));
const STRINGS = ['bulwarkInstalling', 'bulwarkUpdating', 'bulwarkRemoving', 'bulwarkOpensAfter', 'bulwarkRestartsAfter', 'bulwarkProfileStays', 'bulwarkPercent'];
/** The line under the bar, step by step (installer-theme.nsh). */
const STEP_STRINGS = ['bulwarkStepRemoveOld', 'bulwarkStepUnpack', 'bulwarkStepShortcuts', 'bulwarkStepRegister', 'bulwarkStepStart', 'bulwarkStepUnregister', 'bulwarkStepRemoveFiles'];

/** id -> language id -> text, from build/installer-strings.nsh. */
function strings(): Map<string, Map<number, string>> {
  const result = new Map<string, Map<number, string>>();
  for (const [, id, lang, text] of read(path.join(BUILD, 'installer-strings.nsh')).matchAll(/^LangString (\w+) (\d+) "(.*)"$/gm)) {
    if (!result.has(id)) result.set(id, new Map());
    result.get(id)!.set(Number(lang), text);
  }
  return result;
}

const CACHE = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
const nsisDir = existsSync(CACHE) ? readdirSync(CACHE).find((entry) => entry.startsWith('nsis-') && !entry.startsWith('nsis-resources')) : undefined;
function makensis(): string | null {
  if (!nsisDir) return null;
  const top = path.join(CACHE, nsisDir);
  for (const folder of [top, ...readdirSync(top, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(top, d.name))]) {
    const file = path.join(folder, 'Bin', 'makensis.exe');
    if (existsSync(file)) return file;
  }
  return null;
}
const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const canBuild = process.platform === 'win32' && !!nsisDir && existsSync(vswhere);

/** The plugin, built from this checkout's source. */
function buildPlugin(): void {
  const made = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-nsis-splash.mjs')], { encoding: 'utf8', cwd: ROOT });
  expect(made.status, made.stdout + made.stderr).toBe(0);
  expect(existsSync(PLUGIN)).toBe(true);
}

test.describe('the NSIS window', () => {
  test('is drawn by the include electron-builder takes, through the plugin', () => {
    expect(config.nsis.oneClick).toBe(true);
    const include = read(path.join(ROOT, config.nsis.include));
    expect(include).toContain('!include "${__FILEDIR__}\\installer-theme.nsh"');
    // The uninstaller's window is drawn first thing in the uninstall section.
    expect(include).toMatch(/!macro customUnInstall\n {2}!ifmacrodef bulwarkThemeUninstallerPage\n {4}!insertmacro bulwarkThemeUninstallerPage\n/);
    const text = theme();
    expect(text).toContain('!addplugindir /x86-unicode "${BULWARK_THEME_DIR}\\x86-unicode"');
    expect(text).toContain('BulwarkSplash::Show');
    // See-through from the first frame until painted: no white flash.
    expect(text).toContain('!define MUI_CUSTOMFUNCTION_GUIINIT bulwarkThemeGuiInit');
    expect(text).toContain('!define MUI_CUSTOMFUNCTION_UNGUIINIT un.bulwarkThemeGuiInit');
    // The release builds the plugin before the installers, and git never holds it.
    expect(read(path.join(ROOT, '.github', 'workflows', 'release.yml'))).toMatch(/run: node scripts\/build-nsis-splash\.mjs\n\n\s+- name: Build installers/);
    expect(read(path.join(ROOT, '.gitignore'))).toContain('build/x86-unicode/');
  });

  test('is a borderless 300 by 340 square with rounded corners, dragged by any point', () => {
    const source = splash();
    expect(source).toContain('#define DIP_WIDTH 300');
    expect(source).toContain('#define DIP_HEIGHT 340');
    expect(source).toMatch(/style &= ~\(WS_CAPTION \| WS_SYSMENU/);
    expect(source).toContain('ex |= WS_EX_APPWINDOW;');
    expect(source).toContain('DWMWA_WINDOW_CORNER_PREFERENCE');
    expect(source).toContain('return hit == HTCLIENT ? HTCAPTION : hit;');
    // Painted in one go, nothing erased first: the old window's statics flickered white.
    expect(source).toMatch(/case WM_ERASEBKGND:\n\s+return 1;/);
    expect(source).not.toContain('"STATIC"');
  });

  test('has the app colours, light and dark, and Windows decides which', () => {
    const source = splash();
    expect(theme()).toContain('"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"');
    expect(source).toContain('L"AppsUseLightTheme"');
    // The webmail's background, foreground, muted, accent (primary, info in dark) and border.
    for (const colour of ['0xffffff', '0x0f172a', '0x59687c', '0x185aea', '0xe2e8f0', '0x0a0a0a', '0xfafafa', '0xadadad', '0x60a5fa', '0x262626']) {
      expect(source).toContain(`Hex(${colour})`);
    }
    // High Contrast keeps Windows' colours.
    expect(source).toContain('SPI_GETHIGHCONTRAST');
    expect(source).toContain('GetSysColor(COLOR_HIGHLIGHT)');
  });

  // Controls made from the install section belong to its thread, which paints them only
  // while it waits (ExecWait): on an update, while the old uninstaller ran, they got a white
  // background next to their text. The splash makes none: the plugin paints everything in
  // the window's own WM_PAINT, on the window's thread.
  test('makes no controls from the install section', () => {
    expect(theme()).not.toContain('CreateWindowEx');
    const source = read(path.join(ROOT, 'native', 'nsis-splash', 'splash.c'));
    expect(source).not.toContain('CreateWindow');
    expect(source).toContain('SetWindowLongPtrW(parent, GWLP_WNDPROC, (LONG_PTR)Proc)');
    expect(source).toContain('case WM_PAINT:');
  });

  // NSIS's own bar restarted with each part: the unpacking took it to 100 %, the copy after it
  // started over. The script now tells the window each step and its share of the bar.
  test('has one bar for the whole run: the steps follow on, and only the last reaches 100', () => {
    const text = theme();
    const step = (name: string) => {
      const found = new RegExp(`^!define BULWARK_STEP_${name} "(\\d+) (\\d+) (\\d+)"$`, 'm').exec(text);
      expect(found, name).toBeTruthy();
      return { from: Number(found![1]), to: Number(found![2]), tenths: Number(found![3]) };
    };
    const runs = {
      fresh: ['FRESH_PAYLOAD', 'FRESH_UNPACK', 'FRESH_PLACE', 'FRESH_SHORTCUTS', 'REGISTER', 'START'],
      update: ['UPDATE_OLD', 'UPDATE_UNPACK', 'UPDATE_PLACE', 'UPDATE_SHORTCUTS', 'REGISTER', 'START'],
      uninstall: ['UN_WINDOWS', 'UN_FILES'],
    };
    for (const [run, names] of Object.entries(runs)) {
      const steps = names.map(step);
      expect(steps[0].from, run).toBe(0);
      for (let i = 1; i < steps.length; i += 1) expect(steps[i].from, `${run} ${names[i]}`).toBe(steps[i - 1].to);
      for (const [i, one] of steps.entries()) expect(one.to, `${run} ${names[i]}`).toBeGreaterThan(one.from);
      expect(steps.at(-1)!.to, run).toBe(100);
    }
    expect(step('DONE')).toEqual({ from: 100, to: 100, tenths: 0 });
    // Sent where electron-builder's template does each part.
    const include = read(path.join(ROOT, config.nsis.include));
    expect(include).toMatch(/!macro customInstall\n\s+!ifmacrodef bulwarkThemeRegisterStep\n\s+!insertmacro bulwarkThemeRegisterStep\n[\s\S]*?!insertmacro bulwarkThemeDoneStep\n\s+!endif\n!macroend/);
    expect(include).toMatch(/!insertmacro bulwarkThemeUninstallFilesStep\n\s+!endif\n!macroend\s*$/);
    const extract = read(path.join(BUILD, 'installer-extract.nsh'));
    expect(extract).toContain('Nsis7z::ExtractWithCallback "${FILE}" $R9');
    // The window never goes back, and shows 100 only after the last step.
    const source = splash();
    expect(source).toContain('if (target < g.shown) target = g.shown;');
    expect(source).toContain('if (percent > 99 && !(g.stepped && g.stepFrom >= 100)) percent = 99;');
  });

  test('asks Windows, not PowerShell, whether Bulwark is running', () => {
    const text = theme();
    expect(text).not.toContain('IS_POWERSHELL_AVAILABLE');
    expect(text).not.toContain('_CHECK_APP_RUNNING');
    expect(text.split('!insertmacro bulwarkCheckAppRunning')).toHaveLength(3);
    const speed = read(path.join(BUILD, 'installer-speed.nsh'));
    expect(speed).toContain('BulwarkSplash::Running "$INSTDIR"');
    expect(speed).toContain('BulwarkSplash::Stop "$INSTDIR"');
    expect(speed).not.toContain('nsExec');
  });

  test("keeps NSIS's integrity check and its message", () => {
    // SilentInstall would hide the "verifying installer" box, and the "integrity check failed" message with it.
    for (const file of [path.join(BUILD, 'installer-theme.nsh'), path.join(ROOT, config.nsis.include)]) {
      expect(read(file), file).not.toMatch(/^\s*(SilentInstall|SilentUnInstall|CRCCheck)\b/m);
    }
  });

  test('leaves out the uninstaller question for a person, and stays silent with /S', () => {
    const text = theme();
    // un.onInit's ${LogSet} turns silent on, only without /S, and the app check turns it off again.
    expect(text).toMatch(/!macro customHeader\n\s+!undef LogSet\n\s+!define LogSet "!insertmacro bulwarkLogSet"\n\s+!macroend/);
    expect(text).toMatch(/!macro bulwarkLogSet SETTING\n\s+!insertmacro LogSetMacro \$\{SETTING\}\n\s+!ifdef __UNINSTALL__\n\s+!if "\$\{__FUNCTION__\}" == "onInit"\n[\s\S]*?\$\{GetOptions\} \$R0 "\/S" \$R1\n\s+\$\{If\} \$\{Errors\}\n\s+SetSilent silent\n/);
    const check = text.slice(text.lastIndexOf('!macro customCheckAppRunning'));
    expect(check).toMatch(/^!macro customCheckAppRunning\n[\s\S]*?\$\{GetOptions\} \$R0 "\/S" \$R1\n\s+\$\{If\} \$\{Errors\}\n\s+SetSilent normal\n[\s\S]*?!insertmacro bulwarkCheckAppRunning\n\s+!macroend/);
  });

  test('has a logo for every scale from 100 to 250 %, and 256 above', () => {
    expect(theme()).toContain('"${BULWARK_THEME_DIR}\\installer-logo.ico"');
    const sizes = icoSizes(readFileSync(path.join(BUILD, 'installer-logo.ico')));
    for (const scale of [100, 125, 150, 175, 200, 225, 250]) expect(sizes).toContain((96 * scale) / 100);
    expect(sizes).toContain(256);
  });

  test('says what it does in every language the installer has', () => {
    const table = strings();
    const languages: string[] = config.nsis.installerLanguages;
    const ids = languages.map((language) => lcid[language] as number);
    expect(ids.every((id) => typeof id === 'number')).toBe(true);
    for (const name of [...STRINGS, ...STEP_STRINGS]) {
      const texts = table.get(name);
      expect(texts, name).toBeTruthy();
      // Exactly those: one more would be a language makensis doesn't load, and fails the build.
      expect([...texts!.keys()].sort(), name).toEqual([...ids].sort());
      const english = texts!.get(1033)!;
      for (const [id, value] of texts!) {
        if (name === 'bulwarkPercent') {
          expect(value, `${name} ${id}`).toMatch(/^[^#]{0,2}#[^#]{0,2}$/);
          continue;
        }
        if (english.includes('${PRODUCT_NAME}')) expect(value, `${name} ${id}`).toContain('${PRODUCT_NAME}');
        else expect(value, `${name} ${id}`).not.toContain('${PRODUCT_NAME}');
        if (id !== 1033) expect(value, `${name} ${id} is not translated`).not.toBe(english);
      }
    }
    expect(table.get('bulwarkInstalling')!.get(1033)).toBe('Installing ${PRODUCT_NAME}…');
    expect(table.get('bulwarkUpdating')!.get(1033)).toBe('Updating ${PRODUCT_NAME}…');
    expect(table.get('bulwarkRemoving')!.get(1033)).toBe('Removing ${PRODUCT_NAME}…');
    expect(table.get('bulwarkInstalling')!.get(1031)).toBe('${PRODUCT_NAME} wird installiert…');
    expect(table.get('bulwarkUpdating')!.get(1031)).toBe('${PRODUCT_NAME} wird aktualisiert…');
    expect(table.get('bulwarkRemoving')!.get(1031)).toBe('${PRODUCT_NAME} wird deinstalliert…');
    expect(table.get('bulwarkPercent')!.get(1033)).toBe('#%');
    // The steps in English, and in German as Windows says them.
    expect(STEP_STRINGS.map((name) => table.get(name)!.get(1033))).toEqual([
      'Removing the old version…',
      'Unpacking files…',
      'Setting up shortcuts…',
      'Registering ${PRODUCT_NAME}…',
      'Starting ${PRODUCT_NAME}…',
      'Removing ${PRODUCT_NAME} from Windows…',
      'Removing files…',
    ]);
    expect(STEP_STRINGS.map((name) => table.get(name)!.get(1031))).toEqual([
      'Alte Version wird entfernt…',
      'Dateien werden entpackt…',
      'Verknüpfungen werden erstellt…',
      '${PRODUCT_NAME} wird registriert…',
      '${PRODUCT_NAME} wird gestartet…',
      '${PRODUCT_NAME} wird aus Windows entfernt…',
      'Dateien werden entfernt…',
    ]);
    // Each line is a step's, and the window shows it.
    for (const name of STEP_STRINGS) expect(theme(), name).toContain(`"$(${name})"`);
    expect(table.get('bulwarkPercent')!.get(1031)).toBe('# %');
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
    // installer-extract.nsh replaces extractUsing7za from the app check, which electron-builder
    // inserts after it defines the macro and before it unpacks; the files step goes in its hook
    // right after the unpacking. Ours keeps its retry loop word for word.
    expect(section.indexOf('!include installer.nsh')).toBeLessThan(section.indexOf('!insertmacro CHECK_APP_RUNNING'));
    expect(section.indexOf('!insertmacro CHECK_APP_RUNNING')).toBeLessThan(section.indexOf('!insertmacro installApplicationFiles'));
    expect(read(path.join(TEMPLATES, 'include', 'installer.nsh'))).toContain('!include "extractAppPackage.nsh"');
    const extract = read(path.join(TEMPLATES, 'include', 'extractAppPackage.nsh'));
    const parts = ['!macro extractEmbeddedAppPackage', '!insertmacro decompress', '!insertmacro custom_files_post_decompression', '!macro custom_files_post_decompression', '!insertmacro customFiles_arm64', '!insertmacro customFiles_x64', '!macro extractUsing7za FILE'];
    const where = parts.map((part) => extract.indexOf(part));
    expect(where.every((index) => index > -1), JSON.stringify(where)).toBe(true);
    expect([...where].sort((a, b) => a - b)).toEqual(where);
    const theirs = extract.slice(extract.indexOf('!macro extractUsing7za FILE'));
    const ours = read(path.join(BUILD, 'installer-extract.nsh'));
    expect(theirs.slice(0, theirs.indexOf('  Nsis7z::Extract "${FILE}"'))).toBe('!macro extractUsing7za FILE\n  Push $OUTDIR\n  CreateDirectory "$PLUGINSDIR\\7z-out"\n  ClearErrors\n  SetOutPath "$PLUGINSDIR\\7z-out"\n');
    const loop = (text: string) => text.slice(text.indexOf('  # Retry counter'), text.indexOf('!macroend', text.indexOf('  # Retry counter')));
    expect(loop(ours)).toBe(loop(theirs));
    expect(loop(ours)).toContain('DoneExtract7za:');
    // The uninstaller's question: asked in un.onInit only when not silent, after ${LogSet},
    // which customHeader can redefine (after common.nsh defines it, before uninstaller.nsh).
    const inOrder = (text: string, parts: string[]) => {
      const at = parts.map((part) => text.indexOf(part));
      expect(at.every((index) => index > -1), JSON.stringify(at)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    };
    const unInit = uninstaller.slice(uninstaller.indexOf('Function un.onInit'), uninstaller.indexOf('FunctionEnd', uninstaller.indexOf('Function un.onInit')));
    inOrder(unInit, ['${LogSet} on', '${GetOptions} $R0 "/S" $R1', '${If} ${Silent}\n    call un.checkAppRunning\n  ${else}', 'MessageBox MB_OKCANCEL "$(areYouSureToUninstall)"', '!insertmacro customUnInit']);
    expect(uninstaller.split('$(areYouSureToUninstall)')).toHaveLength(2);
    expect(read(path.join(TEMPLATES, 'common.nsh'))).toContain('!define LogSet "!insertmacro LogSetMacro"');
    inOrder(read(path.join(TEMPLATES, 'installer.nsi')), ['!include "common.nsh"', '!insertmacro customHeader', '!include "uninstaller.nsh"']);
  });
});

// The plugin for real: a small NSIS program with an instfiles page, as electron-builder's,
// hands its window over and reports what the window became. It installs nothing; its window
// shows for about two seconds.
test.describe('the plugin', () => {
  test.skip(!canBuild, "needs Windows, MSVC and electron-builder's NSIS");
  test.setTimeout(180_000);

  test('takes the caption away, makes the square, and shows the progress in percent', () => {
    buildPlugin();
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-splash-'));
    try {
      const report = path.join(dir, 'report.txt');
      const script = path.join(dir, 'probe.nsi');
      writeFileSync(
        script,
        [
          'Unicode true',
          'ManifestDPIAware true',
          `!addplugindir /x86-unicode "${path.dirname(PLUGIN)}"`,
          '!include "MUI2.nsh"',
          `OutFile "${path.join(dir, 'probe.exe')}"`,
          'RequestExecutionLevel user',
          'ShowInstDetails nevershow',
          '!insertmacro MUI_PAGE_INSTFILES',
          '!insertmacro MUI_LANGUAGE "English"',
          'Section',
          '  Push "Software\\BulwarkTest\\NoSuchKey"',
          '  Push "0"',
          '  Push "0"',
          `  Push "${path.join(BUILD, 'installer-logo.ico')}"`,
          '  Push "#%"',
          '  Push "A line"',
          '  Push "A heading"',
          '  BulwarkSplash::Show',
          '  Pop $0',
          '  FindWindow $1 "#32770" "" $HWNDPARENT',
          '  GetDlgItem $1 $1 1004',
          // NSIS moves the bar on after every instruction, by more after a plugin call. Read
          // just before the wait, during which it stands still, then what the window says.
          '  SendMessage $1 0x408 0 0 $R0',
          '  SendMessage $1 0x407 0 0 $R1',
          '  Sleep 1500',
          `  System::Call 'user32::GetPropW(p $HWNDPARENT, w "BulwarkSplashPercent") i .R2'`,
          '  IntOp $R0 $R0 * 100',
          '  IntOp $R0 $R0 / $R1',
          "  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i .r2'",
          "  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20) i .r3'",
          "  System::Call '*(i, i, i, i) p .r9'",
          "  System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r9)'",
          "  System::Call '*$9(i .r4, i .r5, i .r6, i .r7)'",
          '  System::Free $9',
          '  IntOp $6 $6 - $4',
          '  IntOp $7 $7 - $5',
          "  System::Call 'user32::GetDC(p $HWNDPARENT) p .r9'",
          "  System::Call 'gdi32::GetDeviceCaps(p r9, i 90) i .r8'",
          "  System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r9)'",
          `  FileOpen $9 "${report}" w`,
          '  FileWrite $9 "$0 $2 $3 $6 $7 $8 $R2 $R0"',
          '  FileClose $9',
          '  SetAutoClose true',
          'SectionEnd',
        ].join('\n'),
      );
      const made = spawnSync(makensis()!, ['-V2', script], { encoding: 'utf8' });
      expect(made.status, made.stdout + made.stderr).toBe(0);
      const ran = spawnSync(path.join(dir, 'probe.exe'), [], { timeout: 60_000 });
      expect(ran.status).toBe(0);
      const [result, style, ex, width, height, dpi, percent, bar] = readFileSync(report, 'utf8').trim().split(' ');
      expect(result).toBe('ok');
      const WS_CAPTION = 0x00c00000;
      const WS_SYSMENU = 0x00080000;
      expect(Number(style) & WS_CAPTION).toBe(0);
      expect(Number(style) & WS_SYSMENU).toBe(0);
      // In the taskbar, and not see-through.
      expect(Number(ex) & 0x40000).toBe(0x40000);
      expect(Number(ex) & 0x80000).toBe(0);
      expect(Number(width)).toBe(Math.round((300 * Number(dpi)) / 96));
      expect(Number(height)).toBe(Math.round((340 * Number(dpi)) / 96));
      // What the bar says, stored plus one. Read before the wait; a few instructions have
      // moved it on since, never back.
      const shown = Number(percent) - 1;
      expect(Number(bar)).toBeGreaterThan(0);
      expect(shown, `window ${shown}, bar ${bar}`).toBeGreaterThanOrEqual(Number(bar));
      expect(shown - Number(bar), `window ${shown}, bar ${bar}`).toBeLessThanOrEqual(6);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });

  // The installers' "is Bulwark running?" (installer-speed.nsh): a copy of cmd.exe running
  // from a folder stands in for the app.
  test('finds what runs from the install folder, and only there, and ends it', async () => {
    buildPlugin();
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-running-'));
    try {
      const folder = path.join(dir, 'app');
      mkdirSync(folder);
      copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), path.join(folder, 'BulwarkTest.exe'));
      const child = spawn(path.join(folder, 'BulwarkTest.exe'), ['/d', '/c', 'ping -n 120 127.0.0.1 >nul'], { stdio: 'ignore', windowsHide: true });
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const report = path.join(dir, 'report.txt');
      const script = path.join(dir, 'probe.nsi');
      writeFileSync(
        script,
        [
          'Unicode true',
          `!addplugindir /x86-unicode "${path.dirname(PLUGIN)}"`,
          `OutFile "${path.join(dir, 'probe.exe')}"`,
          'RequestExecutionLevel user',
          'SilentInstall silent',
          'Section',
          `  BulwarkSplash::Running "${folder}"`,
          '  Pop $0',
          `  BulwarkSplash::Running "${folder}\\"`,
          '  Pop $1',
          `  BulwarkSplash::Running "${folder}-other"`,
          '  Pop $2',
          `  BulwarkSplash::Running "${dir}"`,
          '  Pop $3',
          `  BulwarkSplash::Stop "${folder}"`,
          '  Pop $4',
          `  BulwarkSplash::Running "${folder}"`,
          '  Pop $5',
          `  FileOpen $9 "${report}" w`,
          '  FileWrite $9 "$0 $1 $2 $3 $4 $5"',
          '  FileClose $9',
          'SectionEnd',
        ].join('\n'),
      );
      const made = spawnSync(makensis()!, ['-V2', script], { encoding: 'utf8' });
      expect(made.status, made.stdout + made.stderr).toBe(0);
      const ran = spawnSync(path.join(dir, 'probe.exe'), [], { timeout: 60_000 });
      expect(ran.status).toBe(0);
      // In the folder, with or without a trailing backslash, and in any folder below the one
      // asked about; never in one whose name only starts the same. Ended, and then gone.
      expect(readFileSync(report, 'utf8').trim()).toBe('1 1 0 1 0 0');
      await exited;
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });
});

// A real update, captured on the window: version 1.0.0 installed quietly, then 1.0.1 run as
// the app runs it (--updated), while test/support/splash-watch.ps1 reads what the window
// shows. With the theme only, no Bulwark registration (installer.nsh writes the real names),
// in a folder under TEMP. 60 MB of files, stored, so the unpacking and the move take long
// enough to be seen.
test.describe('an update, as the window shows it', () => {
  test.skip(!canBuild, "needs Windows, MSVC and electron-builder's NSIS");
  test.setTimeout(600_000);

  test('the percent only goes forward, through the steps, and reaches 100 only at the end', async () => {
    buildPlugin();
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-update-'));
    const installTo = path.join(dir, 'installed');
    const cache = path.join(process.env.LOCALAPPDATA ?? '', 'bulwark-installer-update-updater');
    const builds: Record<string, string> = {};
    try {
      const app = path.join(dir, 'app');
      mkdirSync(path.join(app, 'resources'), { recursive: true });
      writeFileSync(path.join(app, 'BulwarkTest.exe'), 'MZ');
      for (let i = 0; i < 6; i += 1) writeFileSync(path.join(app, 'resources', `part-${i}.bin`), randomBytes(10 * 1024 * 1024));
      const include = path.join(dir, 'theme-only.nsh');
      writeFileSync(
        include,
        [
          '!include "FileFunc.nsh"',
          '!include "LogicLib.nsh"',
          `!include "${path.join(BUILD, 'installer-theme.nsh')}"`,
          '!macro customInstall',
          '  !ifmacrodef bulwarkThemeRegisterStep',
          '    !insertmacro bulwarkThemeRegisterStep',
          '  !endif',
          '  !ifmacrodef bulwarkThemeDoneStep',
          '    !insertmacro bulwarkThemeDoneStep',
          '  !endif',
          '!macroend',
          '!macro customUnInstall',
          '  !insertmacro bulwarkThemeUninstallerPage',
          '  !ifmacrodef bulwarkThemeUninstallFilesStep',
          '    !insertmacro bulwarkThemeUninstallFilesStep',
          '  !endif',
          '!macroend',
        ].join('\n'),
      );
      const electron = JSON.parse(readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
      const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
      for (const version of ['1.0.0', '1.0.1']) {
        const project = path.join(dir, `project-${version}`);
        mkdirSync(project);
        writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'bulwark-installer-update', productName: 'Bulwark Test', version, description: 'Test', author: 'Test' }));
        const out = path.join(project, 'out');
        writeFileSync(
          path.join(project, 'config.json'),
          JSON.stringify({
            appId: 'org.bulwarkmail.desktop.installerupdate',
            productName: 'Bulwark Test',
            electronVersion: electron,
            compression: 'store',
            directories: { output: out, buildResources: BUILD },
            publish: null,
            win: { icon: path.join(BUILD, 'icon.ico'), executableName: 'BulwarkTest', signAndEditExecutable: false, target: [{ target: 'nsis', arch: ['x64'] }] },
            // Never starts the app: NSIS would start it through Explorer, on the visible desktop.
            nsis: { ...config.nsis, include, runAfterFinish: false, createStartMenuShortcut: false, shortcutName: 'Bulwark Test', uninstallDisplayName: 'Bulwark Test Update', artifactName: 'BulwarkTest-Setup-${version}.${ext}' },
          }),
        );
        const made = spawnSync(process.execPath, [cli, '--win', 'nsis', '--x64', '--prepackaged', app, '--projectDir', project, '--config', path.join(project, 'config.json'), '--publish', 'never'], {
          encoding: 'utf8',
          cwd: project,
          env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
          timeout: 240_000,
        });
        expect(made.status, made.stdout + made.stderr).toBe(0);
        builds[version] = path.join(out, `BulwarkTest-Setup-${version}.exe`);
      }

      const installed = spawnSync(builds['1.0.0'], ['/S', `/D=${installTo}`], { timeout: 120_000 });
      expect(installed.status).toBe(0);
      expect(existsSync(path.join(installTo, 'resources', 'part-5.bin'))).toBe(true);

      const lines = path.join(dir, 'splash.txt');
      const stop = path.join(dir, 'stop');
      const watch = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'test', 'support', 'splash-watch.ps1'), '-Name', 'BulwarkTest-Setup', '-Out', lines, '-Stop', stop], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
      const watched = new Promise<void>((resolve) => watch.once('exit', () => resolve()));
      await new Promise<void>((resolve) => watch.stdout!.on('data', (chunk) => String(chunk).includes('ready') && resolve()));
      const updated = spawnSync(builds['1.0.1'], ['--updated'], { timeout: 240_000 });
      writeFileSync(stop, '');
      await watched;
      expect(updated.status).toBe(0);
      expect(existsSync(path.join(installTo, 'resources', 'part-5.bin'))).toBe(true);

      const seen = readFileSync(lines, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split(' '))
        .map(([, percent, from, to]) => ({ percent: Number(percent), from: from === '-' ? -1 : Number(from), to: to === '-' ? -1 : Number(to) }));
      const percents = seen.map((one) => one.percent);
      expect(percents.length, 'the window was seen').toBeGreaterThan(10);
      for (let i = 1; i < percents.length; i += 1) expect(percents[i], `went back: ${percents.slice(Math.max(0, i - 5), i + 1).join(' ')}`).toBeGreaterThanOrEqual(percents[i - 1]);
      // 100 only once the last step said so.
      for (const one of seen) if (one.percent === 100) expect(one.from, 'a 100 before the end').toBe(100);
      // Through the steps of an update, in order: the old version first, then the unpacking.
      const theme = read(path.join(BUILD, 'installer-theme.nsh'));
      const share = (name: string) => new RegExp(`^!define BULWARK_STEP_${name} "(\\d+) (\\d+) \\d+"$`, 'm').exec(theme)!.slice(1, 3).map(Number);
      const steps = [...new Set(seen.filter((one) => one.from >= 0).map((one) => `${one.from}-${one.to}`))];
      const expected = ['UPDATE_OLD', 'UPDATE_UNPACK', 'UPDATE_PLACE', 'UPDATE_SHORTCUTS', 'REGISTER', 'DONE'].map((name) => share(name).join('-'));
      expect(steps.filter((step) => expected.includes(step))).toEqual(expected.filter((step) => steps.includes(step)));
      expect(steps).toContain(expected[0]);
      expect(steps).toContain(expected[1]);
    } finally {
      const uninstaller = existsSync(installTo) ? readdirSync(installTo).find((name) => /^Uninstall .*\.exe$/.test(name)) : undefined;
      if (uninstaller) spawnSync(path.join(installTo, uninstaller), ['/S'], { timeout: 120_000 });
      // The uninstaller removes the folder from a copy of itself, a moment later.
      for (let i = 0; i < 40 && existsSync(installTo); i += 1) await new Promise((resolve) => setTimeout(resolve, 250));
      rmSync(cache, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });
});

// makensis runs with warnings as errors: a language without the window's words, or words for
// a language the installer doesn't load, fails here. Only built, never run.
test.describe('the installer with this config', () => {
  test.skip(!canBuild, "needs Windows, MSVC and electron-builder's NSIS");
  test.setTimeout(240_000);

  test('builds, installer and uninstaller', () => {
    buildPlugin();
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
