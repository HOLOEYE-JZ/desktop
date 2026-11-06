// File > Save as… and Open…: the rules, with no Electron.
import { expect, test } from '@playwright/test';
import { cleanSaveRequest, MAX_SAVE_FILES, messageFileName, numberedName, OPEN_EXTENSIONS, rememberedFolder, withMessageExtension } from '../src/main/save-open-rules';
import { fileReason } from '../src/main/features/os-rules';

test('a saved message is always an .eml, whatever its subject says', () => {
  expect(messageFileName('Meeting notes.eml')).toBe('Meeting notes.eml');
  expect(messageFileName('Meeting notes')).toBe('Meeting notes.eml');
  expect(messageFileName('invoice.pdf.exe')).toBe('invoice.pdf.exe.eml');
  expect(messageFileName('..\\..\\Startup\\run.bat')).toBe('_.._Startup_run.bat.eml');
  expect(messageFileName('con')).toBe('_con.eml');
  expect(messageFileName('')).toBe('message.eml');
  expect(messageFileName(42)).toBe('message.eml');
  expect(messageFileName('x'.repeat(400)).length).toBeLessThanOrEqual(154);
});

test('a name typed in the Save dialog keeps .eml', () => {
  expect(withMessageExtension('C:\\Mail\\Report.eml')).toBe('C:\\Mail\\Report.eml');
  expect(withMessageExtension('C:\\Mail\\Report.EML')).toBe('C:\\Mail\\Report.EML');
  expect(withMessageExtension('C:\\Mail\\Report')).toBe('C:\\Mail\\Report.eml');
  expect(withMessageExtension('C:\\Mail\\Report.hta')).toBe('C:\\Mail\\Report.hta.eml');
});

test('names in a folder are numbered as Explorer numbers copies', () => {
  expect(numberedName('Hello.eml', 1)).toBe('Hello.eml');
  expect(numberedName('Hello.eml', 2)).toBe('Hello (2).eml');
  expect(numberedName('Hello.eml', 10)).toBe('Hello (10).eml');
});

test('only a message request with names is taken', () => {
  expect(cleanSaveRequest({ kind: 'message', names: ['A', 'b.eml'] })).toEqual({ kind: 'message', names: ['A.eml', 'b.eml'] });
  expect(cleanSaveRequest({ kind: 'message', names: [] })).toBeNull();
  expect(cleanSaveRequest({ kind: 'file', names: ['a'] })).toBeNull();
  expect(cleanSaveRequest({ kind: 'message', names: 'a' })).toBeNull();
  expect(cleanSaveRequest({ kind: 'message', names: Array.from({ length: MAX_SAVE_FILES + 1 }, () => 'a') })).toBeNull();
  expect(cleanSaveRequest(null)).toBeNull();
});

test('a remembered folder is used only if it is an absolute path', () => {
  expect(rememberedFolder(process.platform === 'win32' ? 'C:\\Users\\x\\Documents' : '/home/x')).toBeTruthy();
  expect(rememberedFolder('relative\\path')).toBeUndefined();
  expect(rememberedFolder(5)).toBeUndefined();
});

test('Open… offers exactly what "Open with" opens, and nothing it would attach', () => {
  for (const extension of OPEN_EXTENSIONS) expect(fileReason(`x.${extension}`)).toBe('open');
  expect([...OPEN_EXTENSIONS]).toEqual(['eml', 'ics', 'vcf']);
});
