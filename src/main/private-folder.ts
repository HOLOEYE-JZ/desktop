/**
 * A folder only this user can open, whatever the folder above allows: a profile can be moved
 * somewhere the machine's other users can read. On Windows that takes an explicit list without
 * what's inherited, which the native helper writes (NativeHelper.system.makeFolderPrivate):
 * starting whoami and icacls for it is what endpoint protection blocks. No Electron here.
 */

import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface PrivateFolderOptions {
  platform: NodeJS.Platform;
  /** The helper's call. False: it isn't there, or Windows refused. */
  makePrivate: (folder: string) => Promise<boolean>;
  /** The user's home folder. */
  home: string;
  warn?: (message: string) => void;
}

/**
 * Makes the folder and closes it to everyone but this user (and SYSTEM, on Windows). Answers
 * whether it's private now: without the helper's list, only where the OS's own defaults for a
 * home folder apply, as when the tools were blocked.
 */
export async function makeFolderPrivate(root: string, options: PrivateFolderOptions): Promise<boolean> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (options.platform !== 'win32') {
    await chmod(root, 0o700);
    return true;
  }
  if (await options.makePrivate(root)) return true;
  (options.warn ?? console.error)(`Could not set ${root} private`);
  return root.toLowerCase().startsWith(`${options.home.toLowerCase()}${path.win32.sep}`);
}
