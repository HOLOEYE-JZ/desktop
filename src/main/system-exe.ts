/**
 * Programs the shell runs, and where it runs from.
 *
 * A launch for a double-clicked file starts with that file's folder as the working
 * directory, and on Windows a bare name is looked for there first. A `reg.exe` next to a
 * mail attachment must never run. So Windows' tools go by their full path, and the
 * process leaves the launch folder before anything else happens.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

const WINDOWS_TOOLS: Record<string, string[]> = {
  'reg.exe': ['reg.exe'],
  'powershell.exe': ['WindowsPowerShell', 'v1.0', 'powershell.exe'],
  'icacls.exe': ['icacls.exe'],
  'whoami.exe': ['whoami.exe'],
  'subst.exe': ['subst.exe'],
};

export function systemExe(name: keyof typeof WINDOWS_TOOLS, root = process.env.SystemRoot || 'C:\\Windows'): string {
  return path.win32.join(root, 'System32', ...WINDOWS_TOOLS[name]);
}

let launchFolderPath = process.cwd();

/** Remembers where the launch came from, for relative paths on its command line, and leaves. */
export function leaveLaunchFolder(into: string): void {
  launchFolderPath = process.cwd();
  try {
    mkdirSync(into, { recursive: true });
    process.chdir(into);
  } catch (error) {
    console.warn('Could not leave the launch folder:', error);
  }
}

export function launchFolder(): string {
  return launchFolderPath;
}
