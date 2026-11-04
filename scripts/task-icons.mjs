// The icons of the Windows jump list's tasks, its recent messages, the thumbnail toolbar and
// the tray menu. Windows reads a jump list's icons itself, long after the app set them, so
// they have to be real files: electron-builder.yml puts them in resources/os-icons, outside
// the asar. scripts/make-task-icons.mjs makes them from assets/glyphs.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { icoSizes } from './ico.mjs';

/** One per glyph in assets/glyphs. */
export const TASK_ICONS = /** @type {const} */ (['compose', 'inbox', 'calendar', 'contacts', 'message']);
/** `light` glyphs go on a dark shell, `dark` ones on a light shell. */
export const TASK_ICON_VARIANTS = /** @type {const} */ (['light', 'dark']);
/** 16 px at 100% to 300% scale. */
export const TASK_ICON_SIZES = [16, 20, 24, 32, 40, 48];
/** The folder in resources/ of a Windows package, and in dist/ of a build. */
export const TASK_ICON_FOLDER = 'os-icons';

/**
 * The app's own icon, for what Windows draws from a file it reads itself: the Files drive in
 * Explorer's navigation pane. Not the exe's: that's electron.exe in a build from source.
 * build.mjs copies it into dist/os-icons, electron-builder.yml into resources/os-icons.
 */
export const APP_ICON_FILE = 'bulwark.ico';
/** Where it comes from: the icon electron-builder gives Bulwark.exe. */
export const APP_ICON_SOURCE = 'build/icon.ico';
/** The task icons' sizes, and 256 for Explorer's large views. */
export const APP_ICON_SIZES = [...TASK_ICON_SIZES, 256];

/**
 * @param {typeof TASK_ICONS[number]} name
 * @param {typeof TASK_ICON_VARIANTS[number]} variant
 */
export function taskIconFile(name, variant) {
  return `task-${name}-${variant}.ico`;
}

/** What's wrong with the icons in a folder, as `<file> (<why>)`. Empty if each is there and has every size. */
export function findTaskIconProblems(dir) {
  const problems = [];
  for (const name of TASK_ICONS) {
    for (const variant of TASK_ICON_VARIANTS) {
      const file = taskIconFile(name, variant);
      const full = path.join(dir, file);
      if (!existsSync(full)) {
        problems.push(`${file} (missing)`);
        continue;
      }
      const sizes = icoSizes(readFileSync(full));
      if (!sizes) {
        problems.push(`${file} (not an icon)`);
        continue;
      }
      const missing = TASK_ICON_SIZES.filter((size) => !sizes.includes(size));
      if (missing.length) problems.push(`${file} (no ${missing.join(', ')} px)`);
    }
  }
  return problems;
}

/** What's wrong with the app icon in a folder, as `<file> (<why>)`. Empty if it's there with every size. */
export function findAppIconProblems(dir) {
  const full = path.join(dir, APP_ICON_FILE);
  if (!existsSync(full)) return [`${APP_ICON_FILE} (missing)`];
  const sizes = icoSizes(readFileSync(full));
  if (!sizes) return [`${APP_ICON_FILE} (not an icon)`];
  const missing = APP_ICON_SIZES.filter((size) => !sizes.includes(size));
  return missing.length ? [`${APP_ICON_FILE} (no ${missing.join(', ')} px)`] : [];
}
