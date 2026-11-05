// What the MSI's uninstall runs (Bulwark.exe --uninstall-cleanup), on a key of the test's own
// under HKCU\Software\BulwarkTest and folders in temp. Nothing here reads or writes the real
// registration.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { SEND_TO_NAME, windowsOpenWithRegistration, windowsRegistration } from '../src/main/features/os-rules';
import { uninstallCleanup } from '../src/main/uninstall-cleanup';

test.skip(process.platform !== 'win32', 'Windows only');

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'dist', 'main.mjs');
const DRIVES = 'Software\\Classes\\Applications\\Explorer.exe\\Drives';
const RUN = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const TOAST = '{7B1E4F2A-93C6-4D0E-A5B8-2F6C1D9E3A47}';
const OTHER_SERVER = '{0D3C5A11-2B7E-4C9F-8E61-5A4B3C2D1E0F}';

function reg(...args: string[]): { ok: boolean; out: string } {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, out: result.stdout ?? '' };
}

function add(root: string, key: string, name: string | undefined, data: string): void {
  execFileSync('reg.exe', ['add', `${root}\\${key}`, ...(name === undefined ? ['/ve'] : ['/v', name]), '/t', 'REG_SZ', '/d', data, '/f'], { windowsHide: true });
}

const has = (root: string, key: string, name?: string) => reg('query', `${root}\\${key}`, ...(name === undefined ? [] : ['/v', name])).ok;

interface Rig {
  root: string;
  sendTo: string;
  local: string;
  dir: string;
}

function rig(): Rig {
  const dir = mkdtempSync(path.join(tmpdir(), 'bw-uninst-'));
  const sendTo = path.join(dir, 'SendTo');
  const local = path.join(dir, 'Local');
  mkdirSync(sendTo, { recursive: true });
  mkdirSync(local, { recursive: true });
  return { root: `HKCU\\Software\\BulwarkTest\\uninstall-${process.pid}-${Date.now()}`, sendTo, local, dir };
}

function drop(r: Rig): void {
  reg('delete', r.root, '/f');
  const parent = reg('query', 'HKCU\\Software\\BulwarkTest');
  if (parent.ok && parent.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length <= 1) reg('delete', 'HKCU\\Software\\BulwarkTest', '/f');
  rmSync(r.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

/** Everything a start of this exe writes, and someone else's things beside it. */
function plant(r: Rig, exe: string): void {
  for (const value of [...windowsRegistration(exe), ...windowsOpenWithRegistration(exe)]) add(r.root, value.key, value.name, value.data);
  add(r.root, 'Software\\Classes\\.pdf\\OpenWithProgids', 'Other.App', '');
  add(r.root, 'Software\\Classes\\.eml\\OpenWithProgids', 'Thunderbird.Eml', '');
  add(r.root, 'Software\\Classes\\Other.App\\shell\\open\\command', undefined, '"C:\\Other\\other.exe" "%1"');
  add(r.root, `Software\\Classes\\CLSID\\${TOAST}\\LocalServer32`, undefined, `"${exe}"`);
  add(r.root, `Software\\Classes\\CLSID\\${OTHER_SERVER}\\LocalServer32`, undefined, '"C:\\Other\\other.exe"');
  add(r.root, RUN, 'Bulwark', `"${exe}" --bulwark-from-login`);
  add(r.root, APPROVED, 'Bulwark', 'on');
  const icon = `${path.win32.join(path.win32.dirname(exe), 'resources', 'os-icons', 'bulwark.ico')},0`;
  add(r.root, `${DRIVES}\\Q\\DefaultLabel`, undefined, 'Bulwark Files');
  add(r.root, `${DRIVES}\\Q\\DefaultIcon`, undefined, icon);
  // Someone renamed it: theirs now.
  add(r.root, `${DRIVES}\\R\\DefaultLabel`, undefined, 'Backup');
  add(r.root, `${DRIVES}\\R\\DefaultIcon`, undefined, icon);
  // Another install's.
  add(r.root, `${DRIVES}\\S\\DefaultLabel`, undefined, 'Bulwark Files');
  add(r.root, `${DRIVES}\\S\\DefaultIcon`, undefined, 'C:\\Elsewhere\\resources\\os-icons\\bulwark.ico,0');
  writeFileSync(path.join(r.sendTo, `${SEND_TO_NAME}.lnk`), '');
  writeFileSync(path.join(r.sendTo, 'Mail recipient.MAPIMail'), '');
  mkdirSync(path.join(r.local, 'Bulwark', 'os-files', 'drop1'), { recursive: true });
  writeFileSync(path.join(r.local, 'Bulwark', 'os-files', 'drop1', 'a.pdf'), 'x');
  mkdirSync(path.join(r.local, 'Bulwark', 'edit-files'), { recursive: true });
  mkdirSync(path.join(r.local, 'Bulwark', 'files-sync', 'state'), { recursive: true });
  mkdirSync(path.join(r.local, 'bulwark-desktop-updater', 'pending'), { recursive: true });
}

function expectOursGone(r: Rig, exe: string): void {
  for (const key of ['bulwark', 'Bulwark.Url.mailto', 'Bulwark.Url.webcal', 'Bulwark.File.eml', 'Bulwark.File.ics', 'Bulwark.File.vcf', 'Bulwark.File.attach', `Applications\\${path.win32.basename(exe)}`, `CLSID\\${TOAST}`]) {
    expect(has(r.root, `Software\\Classes\\${key}`), key).toBe(false);
  }
  expect(has(r.root, 'Software\\Bulwark'), 'Capabilities').toBe(false);
  expect(has(r.root, 'Software\\RegisteredApplications', 'Bulwark'), 'Default apps').toBe(false);
  expect(has(r.root, 'Software\\Classes\\.eml\\OpenWithProgids', 'Bulwark.File.eml')).toBe(false);
  expect(has(r.root, 'Software\\Classes\\.pdf\\OpenWithProgids', 'Bulwark.File.attach')).toBe(false);
  expect(has(r.root, RUN, 'Bulwark'), 'start at login').toBe(false);
  expect(has(r.root, APPROVED, 'Bulwark')).toBe(false);
  expect(has(r.root, `${DRIVES}\\Q`), 'drive letter name').toBe(false);
  expect(readdirSync(r.sendTo)).toEqual(['Mail recipient.MAPIMail']);
  expect(existsSync(path.join(r.local, 'Bulwark')), 'the app\'s local folders').toBe(false);
  expect(existsSync(path.join(r.local, 'bulwark-desktop-updater'))).toBe(false);
}

function expectTheirsKept(r: Rig): void {
  expect(has(r.root, 'Software\\Classes\\.pdf\\OpenWithProgids', 'Other.App')).toBe(true);
  expect(has(r.root, 'Software\\Classes\\.eml\\OpenWithProgids', 'Thunderbird.Eml')).toBe(true);
  expect(has(r.root, 'Software\\Classes\\Other.App\\shell\\open\\command')).toBe(true);
  expect(has(r.root, `Software\\Classes\\CLSID\\${OTHER_SERVER}\\LocalServer32`)).toBe(true);
  expect(has(r.root, `${DRIVES}\\R\\DefaultLabel`)).toBe(true);
  expect(has(r.root, `${DRIVES}\\S\\DefaultLabel`)).toBe(true);
}

test('takes away everything a start wrote for this exe, and nothing of anyone else\'s', async () => {
  const r = rig();
  const exe = 'C:\\Program Files\\Bulwark\\Bulwark.exe';
  try {
    plant(r, exe);
    expect(has(r.root, 'Software\\Classes\\bulwark\\shell\\open\\command')).toBe(true);
    await uninstallCleanup({ root: r.root, exe, sendTo: r.sendTo, local: r.local });
    expectOursGone(r, exe);
    expectTheirsKept(r);
  } finally {
    drop(r);
  }
});

test('keeps an attachment still being edited, what the folder sync knows, and another exe\'s login entry', async () => {
  const r = rig();
  const exe = 'C:\\Program Files\\Bulwark\\Bulwark.exe';
  try {
    plant(r, exe);
    add(r.root, RUN, 'Bulwark', '"C:\\Users\\someone\\AppData\\Local\\Programs\\bulwark\\Bulwark.exe" --bulwark-from-login');
    writeFileSync(path.join(r.local, 'Bulwark', 'edit-files', 'letter.docx'), 'draft');
    writeFileSync(path.join(r.local, 'Bulwark', 'files-sync', 'roots.json'), '{"roots":[]}');
    await uninstallCleanup({ root: r.root, exe, sendTo: r.sendTo, local: r.local });
    expect(existsSync(path.join(r.local, 'Bulwark', 'edit-files', 'letter.docx'))).toBe(true);
    expect(existsSync(path.join(r.local, 'Bulwark', 'files-sync', 'roots.json'))).toBe(true);
    expect(existsSync(path.join(r.local, 'Bulwark', 'files-sync', 'state'))).toBe(false);
    expect(existsSync(path.join(r.local, 'Bulwark', 'os-files'))).toBe(false);
    expect(has(r.root, RUN, 'Bulwark')).toBe(true);
  } finally {
    drop(r);
  }
});

test('the app does it when started with --uninstall-cleanup, and opens nothing', () => {
  test.skip(!existsSync(MAIN), 'node build.mjs --test first');
  const require = createRequire(path.join(ROOT, 'package.json'));
  const electron = require('electron') as unknown as string;
  const r = rig();
  try {
    plant(r, electron);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const started = Date.now();
    const run = spawnSync(electron, [MAIN, '--uninstall-cleanup', `--bulwark-test-registry-root=${r.root}`, `--bulwark-test-sendto-dir=${r.sendTo}`, `--bulwark-test-local-dir=${r.local}`], { env, timeout: 60_000, windowsHide: true });
    expect(run.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
    expectOursGone(r, electron);
    expectTheirsKept(r);
  } finally {
    drop(r);
  }
});
