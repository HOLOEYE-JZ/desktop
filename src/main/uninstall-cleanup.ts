/**
 * `Bulwark.exe --uninstall-cleanup`: what the app wrote into the user's Windows at its starts,
 * taken away again, so Default apps, Open with and Send to don't keep pointing at a deleted exe.
 * The MSI runs it as the user who uninstalls, before it removes the files
 * (scripts/msi-project.cjs). The NSIS uninstaller does the same by itself (build/installer.nsh
 * customUnInstall): keep the two alike. No Electron here, so a test can run it on a key and
 * folders of its own.
 */

import { execFile } from 'node:child_process';
import { readdirSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DRIVE_NAME } from './files/drive-places';
import { DRIVES_KEY, registryLetterLabels } from './files/drive-letter-label';
import { SEND_TO_NAME, windowsRegistrationKeys } from './features/os-rules';
import { systemExe } from './system-exe';

export const UNINSTALL_CLEANUP_SWITCH = '--uninstall-cleanup';

/** Only before a bare `--`: after it come links and files, and a file may have any name. */
export function asksForUninstallCleanup(argv: readonly string[]): boolean {
  const end = argv.indexOf('--');
  return argv.slice(1, end === -1 ? argv.length : end).includes(UNINSTALL_CLEANUP_SWITCH);
}

export interface CleanupPlaces {
  /** `HKCU`, or in a test the key that stands in for it. */
  root: string;
  /** The exe being uninstalled. Only what names it, or what only it could have written, goes. */
  exe: string;
  /** The user's SendTo folder, or a test's own. */
  sendTo: string | null;
  /** `%LOCALAPPDATA%`, or a test's own. */
  local: string | null;
}

type Reg = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;

const regExe: Reg = (args) =>
  new Promise((resolve) => {
    execFile(systemExe('reg.exe'), args, { windowsHide: true, timeout: 15_000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? '') }));
  });

const RUN_KEYS = ['Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'];
/** The login item's name for an installed app (os-login.ts). */
const LOGIN_ITEM_NAME = 'Bulwark';

const unquote = (text: string) => text.trim().replace(/^"(.*)"$/, '$1');
const sameFile = (a: string, b: string) => unquote(a).toLowerCase() === unquote(b).toLowerCase();

/** The data of a `reg query` line, or null: `    name    REG_SZ    data`. */
function valueData(line: string): string | null {
  const match = /\sREG_(?:EXPAND_)?SZ(?:\s+(.*))?$/.exec(line);
  return match ? (match[1] ?? '').trim() : null;
}

/** The COM servers Electron registered for this exe's toasts, by their CLSID. */
async function toastServers(reg: Reg, root: string, exe: string): Promise<string[]> {
  const found = await reg(['query', `${root}\\Software\\Classes\\CLSID`, '/s', '/f', exe, '/d']);
  if (!found.ok) return [];
  const ids = new Set<string>();
  let key = '';
  for (const line of found.stdout.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) key = line.trim();
    else if (/\\LocalServer32$/i.test(key)) {
      const data = valueData(line);
      const id = /\\CLSID\\(\{[0-9A-F-]+\})\\LocalServer32$/i.exec(key)?.[1];
      if (data !== null && id && sameFile(data, exe)) ids.add(id);
    }
  }
  return [...ids];
}

/** The drive letters whose name and icon in "This PC" are this install's: the same test as the NSIS uninstaller. */
async function ourDriveLetters(reg: Reg, root: string, exe: string): Promise<string[]> {
  const icon = `${path.win32.join(path.win32.dirname(exe), 'resources', 'os-icons', 'bulwark.ico')},0`;
  const labels = registryLetterLabels(root, null);
  const letters: string[] = [];
  const all = await reg(['query', `${root}\\${DRIVES_KEY}`]);
  for (const line of all.stdout.split(/\r?\n/)) {
    const letter = /\\Drives\\([A-Z])$/i.exec(line.trim())?.[1];
    if (!letter) continue;
    const found = await labels.read(letter);
    if (found.icon !== null && found.icon.toLowerCase() === icon.toLowerCase() && (found.label === null || found.label === '' || found.label === DRIVE_NAME)) letters.push(letter);
  }
  return letters;
}

function removeIfEmpty(folder: string): void {
  try {
    if (readdirSync(folder).length === 0) rmdirSync(folder);
  } catch {
    // Not there, or not ours to take.
  }
}

/**
 * The app's own folders under %LOCALAPPDATA%. Copies of files on their way to a drop go: they
 * were only ever ours. The edit and sync folders only when empty: a copy of an attachment someone
 * still edits, or what the sync knows, stays with the user, as the profile does.
 */
export function removeLocalFolders(local: string): void {
  const own = path.join(local, 'Bulwark');
  rmSync(path.join(own, 'os-files'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  removeIfEmpty(path.join(own, 'edit-files'));
  removeIfEmpty(path.join(own, 'files-sync', 'state'));
  removeIfEmpty(path.join(own, 'files-sync'));
  removeIfEmpty(own);
  rmSync(path.join(local, 'bulwark-desktop-updater'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

export async function uninstallCleanup(places: CleanupPlaces, reg: Reg = regExe): Promise<void> {
  const { root, exe } = places;
  const del = (key: string, name?: string) => reg(name === undefined ? ['delete', `${root}\\${key}`, '/f'] : ['delete', `${root}\\${key}`, '/v', name, '/f']);

  // Default apps, the mail and calendar links, .eml/.ics/.vcf, Open with and "Choose another app".
  const { keys, values } = windowsRegistrationKeys(path.win32.basename(exe));
  await Promise.all(keys.map((key) => del(key)));
  await Promise.all(values.map((value) => del(value.key, value.name)));

  // Electron's toast activator: any CLSID whose server is this exe.
  for (const id of await toastServers(reg, root, exe)) await del(`Software\\Classes\\CLSID\\${id}`);

  // Start at login, when the entry is this exe's.
  const run = await reg(['query', `${root}\\${RUN_KEYS[0]}`, '/v', LOGIN_ITEM_NAME]);
  const command = run.ok ? run.stdout.split(/\r?\n/).map(valueData).find((data) => data !== null) : undefined;
  if (!run.ok || (command && command.toLowerCase().includes(exe.toLowerCase()))) {
    for (const key of RUN_KEYS) await del(key, LOGIN_ITEM_NAME);
  }

  // The Files drive letter's name and icon, where they are this install's.
  const labels = registryLetterLabels(root, null);
  for (const letter of await ourDriveLetters(reg, root, exe)) await labels.remove(letter);

  if (places.sendTo) rmSync(path.join(places.sendTo, `${SEND_TO_NAME}.lnk`), { force: true });
  if (places.local) removeLocalFolders(places.local);
}
