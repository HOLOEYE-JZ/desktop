/**
 * The Files drive letter's name and icon in "This PC". A `subst` letter shows the disk under
 * it ("Local Disk (D:)") unless the user's classes name it: `DefaultLabel` and `DefaultIcon`
 * under `Applications\Explorer.exe\Drives\<letter>`. Written before the letter comes, removed
 * after it goes, and only ever ours: a label or icon someone else set for that letter stays.
 * No Electron here.
 */

import type { Registry } from '../native-loader';
import { readKey, readString } from '../registry-values';
import { DRIVE_NAME } from './drive-places';

/** Under HKCU, or a test's own key in its place. build/installer.nsh removes it at an uninstall. */
export const DRIVES_KEY = 'Software\\Classes\\Applications\\Explorer.exe\\Drives';

export interface LetterLabel {
  label: string | null;
  icon: string | null;
}

export interface LetterLabelSystem {
  read(letter: string): Promise<LetterLabel>;
  write(letter: string, wanted: { label: string; icon: string }): Promise<boolean>;
  /** Takes both away, and the letter's key when nothing else is in it. */
  remove(letter: string): Promise<void>;
  /** Tells Explorer the drive's name or icon changed. */
  changed(letter: string): void;
}

/**
 * Through the native helper's registry calls. `root` is `HKCU`, or in a test build the key that
 * stands in for it. Without a registry nothing is read or written. `notify` is the helper's call
 * that tells Explorer, where there is one.
 */
export function registryLetterLabels(root: string, registry: Registry | null, notify: ((letter: string) => void) | null): LetterLabelSystem {
  const key = (letter: string, part?: 'DefaultLabel' | 'DefaultIcon') => `${root}\\${DRIVES_KEY}\\${letter}${part ? `\\${part}` : ''}`;
  // The default value, trimmed as reg.exe's answer was. Null: no key, no default value, or not text.
  const value = (letter: string, part: 'DefaultLabel' | 'DefaultIcon') => readString(registry, key(letter, part))?.trim() ?? null;
  return {
    read: async (letter) => ({ label: value(letter, 'DefaultLabel'), icon: value(letter, 'DefaultIcon') }),
    write: async (letter, wanted) => {
      if (!registry) return false;
      const label = registry.setString(key(letter, 'DefaultLabel'), undefined, wanted.label);
      const icon = registry.setString(key(letter, 'DefaultIcon'), undefined, wanted.icon);
      return label && icon;
    },
    remove: async (letter) => {
      if (!registry) return;
      registry.deleteKey(key(letter, 'DefaultLabel'));
      registry.deleteKey(key(letter, 'DefaultIcon'));
      // The letter's own key only if nothing of anyone else's is left in it.
      const rest = readKey(registry, key(letter));
      if (rest && rest.values.length === 0 && rest.subkeys.length === 0) registry.deleteKey(key(letter));
    },
    changed: (letter) => {
      try {
        notify?.(letter);
      } catch {
        // Explorer reads it at the next look anyway.
      }
    },
  };
}

/** The icon's file, as every install of the app names it: os-tasks.ts appIconResource. */
const OUR_ICON = /[\\/]os-icons[\\/]bulwark\.ico,0$/i;

/**
 * Ours: an icon of the app's (this install's, or one before it in another folder) and our
 * name or none. Anything else there is someone else's.
 */
export function isOurLabel(found: LetterLabel, icon: string): boolean {
  if (found.icon === null || (found.icon.toLowerCase() !== icon.toLowerCase() && !OUR_ICON.test(found.icon))) return false;
  return found.label === null || found.label === DRIVE_NAME;
}

const isEmpty = (found: LetterLabel) => found.label === null && found.icon === null;

/**
 * The letter's name and icon, before the letter comes: on a letter with nothing set, or with
 * ours. Answers whether they're ours now.
 */
export async function claimLetterLabel(system: LetterLabelSystem, letter: string, icon: string, warn: (message: string) => void = console.warn): Promise<boolean> {
  const found = await system.read(letter);
  if (found.label === DRIVE_NAME && found.icon === icon) return true;
  if (!isEmpty(found) && !isOurLabel(found, icon)) {
    warn(`The drive letter ${letter}: has a name or icon of someone else's: left as it is`);
    return false;
  }
  if (!(await system.write(letter, { label: DRIVE_NAME, icon }))) {
    warn(`Naming the drive letter ${letter}: failed`);
    return false;
  }
  system.changed(letter);
  return true;
}

/** After the letter went: ours goes too. Someone else's stays. */
export async function releaseLetterLabel(system: LetterLabelSystem, letter: string, icon: string): Promise<void> {
  const found = await system.read(letter);
  if (isEmpty(found) || !isOurLabel(found, icon)) return;
  await system.remove(letter);
  system.changed(letter);
}
