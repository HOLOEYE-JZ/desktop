// "Open with" and Send to: the decisions, with no Electron and no registry.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  isOurSendToShortcut,
  launchFileCommand,
  LaunchFileBatch,
  launchOpensOwnWindow,
  onlyMessageFiles,
  OPEN_WITH_EXTENSIONS,
  parseArgv,
  SEND_TO_FLAG,
  sendToShortcut,
  sendToShortcutAction,
  sendToShortcutCurrent,
  WINDOWS_ATTACH_PROGID,
  windowsOpenWithRegistration,
  windowsRegistrationKeys,
} from '../src/main/features/os-rules';

const EXE = 'C:\\Program Files\\Bulwark\\Bulwark.exe';
const ARGV = { cwd: 'C:\\work', skip: [] as string[], platform: 'win32' as const };

test.describe('files opened with the app', () => {
  test('a document from "Open with" attaches, as Send to does with anything, and neither asks', () => {
    expect(launchFileCommand('attach', false)).toEqual({ reason: 'attach' });
    expect(launchFileCommand('open', false)).toEqual({ reason: 'open' });
    expect(launchFileCommand('open', true)).toEqual({ reason: 'attach' });
    expect(launchFileCommand('attach', true)).toEqual({ reason: 'attach' });
  });

  test('Send to and Open with on a document bring up a compose window, not the main window; an .ics does', () => {
    const none = { links: [], commands: [] };
    expect(launchOpensOwnWindow({ ...none, files: ['C:\\a\\one.pdf', 'C:\\a\\two.png'], sendTo: true })).toBe(true);
    expect(launchOpensOwnWindow({ ...none, files: ['C:\\a\\letter.eml'], sendTo: true })).toBe(true);
    expect(launchOpensOwnWindow({ ...none, files: ['C:\\a\\one.pdf'], sendTo: false })).toBe(true);
    expect(launchOpensOwnWindow({ ...none, files: ['C:\\a\\party.ics'], sendTo: false })).toBe(false);
    expect(launchOpensOwnWindow({ ...none, files: [], sendTo: false })).toBe(false);
  });

  test('a saved message opened with the app gets a message window of its own, where the page opens one', () => {
    const none = { links: [], commands: [] };
    expect(launchOpensOwnWindow({ ...none, files: ['C:\\a\\letter.eml'], sendTo: false }, true)).toBe(true);
    expect(launchOpensOwnWindow({ ...none, files: ['C:\\a\\a.EML', 'C:\\a\\b.eml'], sendTo: false }, true)).toBe(true);
    // An older page shows it in the main window, which has to come up.
    expect(launchOpensOwnWindow({ ...none, files: ['C:\\a\\letter.eml'], sendTo: false })).toBe(false);
    // An .ics beside it goes to the main window's calendar.
    expect(launchOpensOwnWindow({ ...none, files: ['C:\\a\\letter.eml', 'C:\\a\\party.ics'], sendTo: false }, true)).toBe(false);
    expect(onlyMessageFiles({ files: [{ name: 'a.eml' }, { name: 'B.EML' }], failed: [] })).toBe(true);
    expect(onlyMessageFiles({ files: [{ name: 'a.eml' }], failed: ['gone.eml'] })).toBe(false);
    expect(onlyMessageFiles({ files: [{ name: 'a.eml' }, { name: 'party.ics' }], failed: [] })).toBe(false);
    expect(onlyMessageFiles({ files: [], failed: [] })).toBe(false);
  });

  test('Send to\'s marker comes before the terminator, and every file after it counts', () => {
    const request = parseArgv(['Bulwark.exe', SEND_TO_FLAG, '--', 'C:\\a\\one.pdf', 'C:\\a\\two words.png', 'C:\\a\\letter.eml'], ARGV);
    expect(request.sendTo).toBe(true);
    expect(request.files).toEqual(['C:\\a\\one.pdf', 'C:\\a\\two words.png', 'C:\\a\\letter.eml']);
    // A file that only looks like the marker, past the terminator, is a file.
    const hidden = parseArgv(['Bulwark.exe', '--', SEND_TO_FLAG], ARGV);
    expect(hidden.sendTo).toBe(false);
    expect(parseArgv(['Bulwark.exe', '--', 'C:\\a\\one.pdf'], ARGV).sendTo).toBe(false);
  });

  test('the Send to shortcut passes the marker and the terminator, and only an exact one counts as current', () => {
    const wanted = sendToShortcut(EXE);
    expect(wanted).toMatchObject({ target: EXE, args: `${SEND_TO_FLAG} --` });
    expect(sendToShortcutCurrent({ target: EXE.toUpperCase(), args: `${SEND_TO_FLAG} --` }, EXE)).toBe(true);
    expect(sendToShortcutCurrent({ target: EXE, args: '' }, EXE)).toBe(false);
    expect(sendToShortcutCurrent({ target: 'C:\\Old\\Bulwark.exe', args: `${SEND_TO_FLAG} --` }, EXE)).toBe(false);
    expect(sendToShortcutCurrent(null, EXE)).toBe(false);
  });

  test('a start points our Send to shortcut at this exe, leaves another program\'s alone, and brings a missing one back only with the keys', () => {
    const ours = { target: 'C:\\Users\\a\\Temp\\pack\\Bulwark.exe', args: `${SEND_TO_FLAG} --` };
    // The installer's: no description, the same command line.
    expect(sendToShortcutAction(ours, EXE, false)).toBe('replace');
    expect(sendToShortcutAction(ours, EXE, true)).toBe('replace');
    expect(sendToShortcutAction({ target: EXE, args: `${SEND_TO_FLAG} --` }, EXE, true)).toBe('none');
    expect(sendToShortcutAction({ target: EXE, args: '--bulwark-send-to' }, EXE, false)).toBe('replace');
    const foreign = { target: 'C:\\Tools\\Other.exe', args: '/attach' };
    expect(isOurSendToShortcut(foreign)).toBe(false);
    expect(sendToShortcutAction(foreign, EXE, false)).toBe('none');
    expect(sendToShortcutAction(foreign, EXE, true)).toBe('none');
    expect(isOurSendToShortcut({ target: EXE, args: `--other${SEND_TO_FLAG}` })).toBe(false);
    expect(sendToShortcutAction(null, EXE, false)).toBe('none');
    expect(sendToShortcutAction(null, EXE, true)).toBe('create');
  });
});

test.describe('files picked together', () => {
  test('one launch per file still makes one message, and the first file never waits past the cap', async () => {
    let now = 0;
    const delivered: { files: string[]; failed: string[] }[] = [];
    const batch = new LaunchFileBatch<{ files: string[]; failed: string[] }>((value) => delivered.push(value), 50, 120, () => now);
    batch.add({ files: ['a.pdf'], failed: [] });
    now = 30;
    batch.add({ files: ['b.pdf'], failed: ['gone.pdf'] });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(delivered).toEqual([{ files: ['a.pdf', 'b.pdf'], failed: ['gone.pdf'] }]);

    // A slow trickle: the cap ends it.
    now = 0;
    batch.add({ files: ['c.pdf'], failed: [] });
    now = 110;
    batch.add({ files: ['d.pdf'], failed: [] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(delivered[1]).toEqual({ files: ['c.pdf', 'd.pdf'], failed: [] });
  });
});

test.describe('the Windows registration for Open with', () => {
  const values = windowsOpenWithRegistration(EXE);

  test('lists the class for every document and picture type, and never sets anyone\'s default', () => {
    for (const ext of OPEN_WITH_EXTENSIONS) {
      expect(values).toContainEqual({ key: `Software\\Classes\\${ext}\\OpenWithProgids`, name: WINDOWS_ATTACH_PROGID, data: '' });
    }
    // The default of a type's own key is its ProgID: never written.
    expect(values.filter((value) => /^Software\\Classes\\\.[a-z0-9]+$/i.test(value.key) && value.name === undefined)).toEqual([]);
    expect(values.some((value) => /UserChoice|FileExts/i.test(value.key))).toBe(false);
  });

  test('opens with the switch terminator, for the class and for "Choose another app"', () => {
    const commands = values.filter((value) => value.key.endsWith('\\shell\\open\\command')).map((value) => [value.key, value.data]);
    expect(commands).toEqual([
      [`Software\\Classes\\${WINDOWS_ATTACH_PROGID}\\shell\\open\\command`, `"${EXE}" -- "%1"`],
      ['Software\\Classes\\Applications\\Bulwark.exe\\shell\\open\\command', `"${EXE}" -- "%1"`],
    ]);
  });

  test('is taken away with the rest, and the installer knows the same types both ways', () => {
    const { keys, values: named } = windowsRegistrationKeys('Bulwark.exe');
    expect(keys).toContain(`Software\\Classes\\${WINDOWS_ATTACH_PROGID}`);
    expect(keys).toContain('Software\\Classes\\Applications\\Bulwark.exe');
    for (const ext of OPEN_WITH_EXTENSIONS) expect(named).toContainEqual({ key: `Software\\Classes\\${ext}\\OpenWithProgids`, name: WINDOWS_ATTACH_PROGID });

    const nsis = readFileSync(path.resolve(import.meta.dirname, '..', 'build', 'installer.nsh'), 'utf8');
    const written = [...nsis.matchAll(/WriteRegStr HKCU "\$\{BULWARK_CLASSES_KEY\}\\(\.[a-z0-9]+)\\OpenWithProgids" "Bulwark\.File\.attach"/g)].map((match) => match[1]);
    const removed = [...nsis.matchAll(/DeleteRegValue HKCU "Software\\Classes\\(\.[a-z0-9]+)\\OpenWithProgids" "Bulwark\.File\.attach"/g)].map((match) => match[1]);
    expect(written).toEqual([...OPEN_WITH_EXTENSIONS]);
    expect(removed).toEqual([...OPEN_WITH_EXTENSIONS]);
    expect(nsis).toContain('Delete "$APPDATA\\Microsoft\\Windows\\SendTo\\Bulwark (as attachment).lnk"');
  });
});

test.describe('macOS and Linux packages', () => {
  // Read as text: electron-builder.yml is plain enough, and no YAML parser is a dependency of ours.
  const config = readFileSync(path.resolve(import.meta.dirname, '..', 'electron-builder.yml'), 'utf8');

  test('macOS lists the same documents in Open With, as an alternate and never the owner', () => {
    const entry = /- ext: \[([^\]]+)\]\s+name: Document\s+role: Viewer\s+rank: (\w+)/.exec(config);
    expect(entry?.[2]).toBe('Alternate');
    expect(entry?.[1].split(',').map((ext) => ext.trim())).toEqual(OPEN_WITH_EXTENSIONS.map((ext) => ext.slice(1)));
  });

  test('Linux offers them by MIME type, beside the mail types it already had', () => {
    const mime = config.slice(config.indexOf('  mimeTypes:'), config.indexOf('  fileAssociations:', config.indexOf('  mimeTypes:')));
    const types = [...mime.matchAll(/^\s+- (\S+)$/gm)].map((match) => match[1]);
    for (const type of ['application/pdf', 'image/jpeg', 'image/png', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'message/rfc822', 'x-scheme-handler/mailto']) {
      expect(types).toContain(type);
    }
  });
});
