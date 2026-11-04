#!/usr/bin/env node
// Makes the icons of the jump list's tasks, the thumbnail toolbar and the tray menu from the
// Tabler glyphs in assets/glyphs, the ones the webmail draws for the same things. Run by hand
// when a glyph changes; the results are committed, so a build needs nothing of this.
//
//   node scripts/make-task-icons.mjs --webmail <webmail checkout>
//
// sharp comes from the webmail checkout, so it isn't a dependency of this repo.
//
//   assets/os/task-<name>-light.ico       Windows, white, for a dark taskbar. 16 to 48 px.
//   assets/os/task-<name>-dark.ico        Windows, near black, for a light one.
//   assets/os/menu-<name>Template.png     macOS menus, 16 px and @2x. Black, the menu tints it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeIco } from './ico.mjs';
import { TASK_ICON_SIZES, TASK_ICONS, taskIconFile } from './task-icons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLYPHS = path.join(ROOT, 'assets', 'glyphs');
const OUT = path.join(ROOT, 'assets', 'os');
// The same as the tray's mark (make-os-icons.cjs).
const COLOURS = { light: '#ffffff', dark: '#18181b' };
// Tabler draws 2 on a 24 grid. 1.5 is 1 px at 16 px, as the shell's own icons are, and
// keeps the small sizes from blurring into blobs.
const STROKE = 1.5;
/** The menu icons macOS shows: the commands in the tray and the dock menu. */
const MENU_ICONS = ['compose', 'inbox', 'calendar', 'contacts', 'lock'];

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) throw new Error(`--${name} is required`);
  return process.argv[index + 1];
}

const sharp = createRequire(path.join(path.resolve(option('webmail')), 'package.json'))('sharp');

/** The glyph at a size and in a colour: drawn at that size, not scaled after. */
function svg(name, size, colour) {
  const source = readFileSync(path.join(GLYPHS, `${name}.svg`), 'utf8');
  return Buffer.from(
    source
      .replace(/<!--.*?-->/gs, '')
      .replace(/width="24"/, `width="${size}"`)
      .replace(/height="24"/, `height="${size}"`)
      .replace(/stroke="currentColor"/, `stroke="${colour}"`)
      .replace(/stroke-width="2"/, `stroke-width="${STROKE}"`),
  );
}

async function rgba(name, size, colour) {
  const { data, info } = await sharp(svg(name, size, colour)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== size || info.height !== size) throw new Error(`${name}: drawn at ${info.width}x${info.height}, not ${size}`);
  return data;
}

mkdirSync(OUT, { recursive: true });
for (const name of TASK_ICONS) {
  for (const [variant, colour] of Object.entries(COLOURS)) {
    const images = [];
    for (const size of TASK_ICON_SIZES) images.push({ size, rgba: await rgba(name, size, colour) });
    writeFileSync(path.join(OUT, taskIconFile(name, /** @type {'light' | 'dark'} */ (variant))), encodeIco(images));
  }
}
for (const name of MENU_ICONS) {
  for (const [suffix, size] of [['', 16], ['@2x', 32]]) {
    const png = await sharp(svg(name, size, '#000000')).png({ compressionLevel: 9 }).toBuffer();
    writeFileSync(path.join(OUT, `menu-${name}Template${suffix}.png`), png);
  }
}
console.log(`${TASK_ICONS.length * 2} icons and ${MENU_ICONS.length * 2} menu images in ${OUT}`);
