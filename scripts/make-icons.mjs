#!/usr/bin/env node
// Makes the app icons in build/ from the branding repo's SVGs. Run by hand when the
// mark changes; the results are committed, so a build needs neither repo nor sharp.
//
//   node scripts/make-icons.mjs --branding <repos/branding> --webmail <webmail checkout>
//
// sharp comes from the webmail checkout, so it isn't a dependency of this repo.
//
//   build/icon.ico        Windows, 16 to 256. Bitmaps up to 128 for the installer's sake.
//   build/icon.icns       macOS, the white mark on the brand field, on Apple's icon grid.
//   build/icons/NxN.png   Linux hicolor sizes, the colour mark.
//   build/icon.png        What electron-builder wants as the default, 1024.
//   build/installer-logo.ico  The installer window's logo (native/nsis-splash): 96 at 100 %, up to 256
//                         and each step to 300 %, so it's loaded at its size and never scaled.
//
// Windows and Linux use the favicon, drawn for small sizes. Tray variants aren't here.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = '#db2d54';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) throw new Error(`--${name} is required`);
  return process.argv[index + 1];
}

const branding = path.resolve(option('branding'));
const webmail = path.resolve(option('webmail'));
const sharp = createRequire(path.join(webmail, 'package.json'))('sharp');

const favicon = readFileSync(path.join(branding, 'favicon', 'Bulwark Favicon.svg'));
const white = readFileSync(path.join(branding, 'logo', 'Bulwark Logo White.svg'));

const render = (svg, size) => sharp(svg, { density: Math.max(72, Math.ceil((72 * size) / 1000) * 2) }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

/** An ICO entry as a 32-bit bitmap: bottom-up BGRA, then an all-clear AND mask. */
async function bitmapEntry(svg, size) {
  const raw = await sharp(svg, { density: Math.max(72, Math.ceil((72 * size) / 1000) * 2) }).resize(size, size).ensureAlpha().raw().toBuffer();
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const from = (y * size + x) * 4;
      const to = ((size - 1 - y) * size + x) * 4;
      pixels[to] = raw[from + 2];
      pixels[to + 1] = raw[from + 1];
      pixels[to + 2] = raw[from];
      pixels[to + 3] = raw[from + 3];
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([header, pixels, mask]);
}

async function ico(svg, sizes, { png = false } = {}) {
  const entries = [];
  for (const size of sizes) entries.push({ size, data: png || size >= 256 ? await render(svg, size) : await bitmapEntry(svg, size) });
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, data }, index) => {
    const at = 6 + 16 * index;
    head[at] = size >= 256 ? 0 : size;
    head[at + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...entries.map((entry) => entry.data)]);
}

/** The white mark on a rounded square: 824 of 1024 with Apple's corner, the mark at 60%. */
async function macMaster() {
  const field = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="${BRAND}"/></svg>`);
  const mark = await sharp(white, { density: 150 }).resize(500, 500).png().toBuffer();
  return sharp(field).composite([{ input: mark, gravity: 'center' }]).png({ compressionLevel: 9 }).toBuffer();
}

async function icns(master) {
  const types = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512],
  ];
  const chunks = [];
  for (const [type, size] of types) {
    const data = size === 1024 ? master : await sharp(master).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(data.length + 8, 4);
    chunks.push(head, data);
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

const out = path.join(ROOT, 'build');
mkdirSync(path.join(out, 'icons'), { recursive: true });

writeFileSync(path.join(out, 'icon.ico'), await ico(favicon, [16, 20, 24, 32, 40, 48, 64, 128, 256]));
// LoadImage reads PNG entries, which keeps this small. 100 to 250 % in steps of 25, and 256, the
// most an .ico holds, for anything larger.
writeFileSync(path.join(out, 'installer-logo.ico'), await ico(favicon, [96, 120, 144, 168, 192, 216, 240, 256], { png: true }));
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  writeFileSync(path.join(out, 'icons', `${size}x${size}.png`), await render(favicon, size));
}
writeFileSync(path.join(out, 'icon.png'), await render(favicon, 1024));
writeFileSync(path.join(out, 'icon.icns'), await icns(await macMaster()));
console.log(`[make-icons] wrote ${out}`);
