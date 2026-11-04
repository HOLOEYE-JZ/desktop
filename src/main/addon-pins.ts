/**
 * Whether a native addon is the one this build was made with, by the SHA-256 that
 * scripts/addon-pins.mjs compiled into main.mjs. ASAR integrity covers main.mjs and doesn't cover
 * app.asar.unpacked, where a .node has to live, so without this anyone who can write to the
 * install folder could run code in the app. No Electron here, so tests can load it.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type AddonPins = Record<string, Partial<Record<'native' | 'watcher', string>>>;

export interface AddonCheck {
  file: string;
  name: 'native' | 'watcher';
  packaged: boolean;
  platform: string;
  arch: string;
  pins: AddonPins;
}

export function addonMayLoad({ file, name, packaged, platform, arch, pins }: AddonCheck, warn: (message: string) => void = console.error): boolean {
  // Macs have none: the merge and codesign rewrite these after the build (scripts/addon-pins.mjs).
  if (!packaged || platform === 'darwin') return true;
  let data: Buffer;
  try {
    data = readFileSync(file);
  } catch {
    // Not there is an ordinary state, and whoever loads it says what that means.
    return true;
  }
  if (createHash('sha256').update(data).digest('hex') === pins[`${platform}-${arch}`]?.[name]) return true;
  warn(`Refusing to load the ${name} addon: it isn't the file this build was made with.`);
  return false;
}
