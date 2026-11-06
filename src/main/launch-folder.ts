/**
 * Where the app was started from, and leaving it.
 *
 * A launch for a double-clicked file starts with that file's folder as the working directory,
 * and on Windows a bare program or DLL name is looked for there first. A program planted next
 * to a mail attachment must never run, so the process leaves the launch folder before anything
 * else happens. On Windows the app starts none of the system's tools at all: the native helper
 * does that work in process (test/no-system-tools-unit.spec.ts keeps it so).
 */

import { mkdirSync } from 'node:fs';

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
