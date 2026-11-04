/**
 * What the folders feature (features/files-folders.ts) needs from the drive feature
 * (features/files-drive.ts), without either importing the other. The drive sets these when
 * it starts; until then a drive root can't be removed through `removeRoot`, and only the
 * drive roots in the registry count against a new folder.
 */

import type { FilesRoot } from '../../shared/bridge';

export interface DriveHooks {
  /** `removeRoot` on a drive root: as `drive.disable(account, 'user')`. */
  removeRoot?: (root: FilesRoot) => Promise<void>;
  /** Where the drive makes its sync roots, on or not: no folder root may be in it or hold it. */
  parentFolders?: () => string[];
}

let hooks: DriveHooks = {};

export function setDriveHooks(next: DriveHooks): void {
  hooks = next;
}

export function driveHooks(): DriveHooks {
  return hooks;
}
