#!/usr/bin/env node
// Renders the DMG window's background from assets/dmg-background.svg. Run by hand when the
// picture changes; the PNGs are committed, so a build needs neither sharp nor the webmail.
//
//   node scripts/make-dmg-background.mjs --webmail <webmail checkout>
//
//   build/dmg-background.png     540 by 380, the window's size in points
//   build/dmg-background@2x.png  1080 by 760. electron-builder joins the two into one TIFF
//                                on the Mac, so Retina screens get the sharp one.
//
// sharp comes from the webmail checkout, as in make-icons.mjs.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const index = process.argv.indexOf('--webmail');
if (index === -1) throw new Error('--webmail is required');
const sharp = createRequire(path.join(path.resolve(process.argv[index + 1]), 'package.json'))('sharp');

const svg = readFileSync(path.join(ROOT, 'assets', 'dmg-background.svg'));
for (const [scale, name] of [
  [1, 'dmg-background.png'],
  [2, 'dmg-background@2x.png'],
]) {
  const png = await sharp(svg, { density: 72 * scale })
    .resize(540 * scale, 380 * scale)
    .flatten({ background: '#6d758a' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(path.join(ROOT, 'build', name), png);
}
console.log(`[make-dmg-background] wrote ${path.join(ROOT, 'build')}`);
