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
  /** A drive is connected now: the app should stay in the tray when its window closes. */
  running?: () => boolean;
}

/** A notice from the OS feature's toasts (os-toasts.ts showNotice), for the drive to say where rescued files went. */
export type DriveNotice = (title: string, body: string, onClick?: () => void) => void;

let notice: DriveNotice | null = null;

export function setDriveNotice(next: DriveNotice | null): void {
  notice = next;
}

export function driveNotice(): DriveNotice | null {
  return notice;
}

let hooks: DriveHooks = {};

export function setDriveHooks(next: DriveHooks): void {
  hooks = next;
}

export function driveHooks(): DriveHooks {
  return hooks;
}
