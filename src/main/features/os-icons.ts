/**
 * Small images made in code, so no image library is needed and they can't go out of
 * step with the count they show: the taskbar's overlay and the tray's unread dot. The
 * tray's mark itself comes from assets/os (scripts/make-os-icons.cjs).
 */

import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(typed));
  return Buffer.concat([head, typed, tail]);
}

/** RGBA, top row first. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * 4 + 1);
    rows[start] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, start + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const DIGITS_5X7: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
};

const DIGITS_3X5: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '011', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};

/** What the overlay says: past 99 it stops counting. */
export function overlayText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

function fillCircle(rgba: Uint8Array, size: number, colour: readonly [number, number, number]): void {
  const radius = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x + 0.5 - radius, y + 0.5 - radius);
      const coverage = Math.min(1, Math.max(0, radius - distance + 0.5));
      if (coverage <= 0) continue;
      const at = (y * size + x) * 4;
      rgba[at] = colour[0];
      rgba[at + 1] = colour[1];
      rgba[at + 2] = colour[2];
      rgba[at + 3] = Math.round(coverage * 255);
    }
  }
}

/**
 * The badge on the taskbar button: white figures on Bulwark's red. A taskbar button
 * has room for one figure at 16 px, so more use the narrow font; 3 characters only
 * fit on the larger sizes and otherwise come out as "99".
 */
export function overlayPng(count: number, size: number): Buffer {
  const rgba = new Uint8Array(size * size * 4);
  fillCircle(rgba, size, [0xdb, 0x2d, 0x54]);
  let text = overlayText(count);
  const wide = text.length === 1;
  const font = wide ? DIGITS_5X7 : DIGITS_3X5;
  const glyphWidth = wide ? 5 : 3;
  const glyphHeight = wide ? 7 : 5;
  const fits = (length: number, scale: number) => (length * glyphWidth + length - 1) * scale <= size - 2;
  if (text.length === 3 && !fits(3, 1)) text = '99';
  let scale = Math.max(1, Math.floor((size * 0.68) / glyphHeight));
  while (scale > 1 && !fits(text.length, scale)) scale -= 1;
  const textWidth = (text.length * glyphWidth + text.length - 1) * scale;
  const left = Math.floor((size - textWidth) / 2);
  const top = Math.floor((size - glyphHeight * scale) / 2);
  [...text].forEach((character, index) => {
    const rows = font[character];
    for (let row = 0; row < glyphHeight; row += 1) {
      for (let column = 0; column < glyphWidth; column += 1) {
        if (rows[row][column] !== '1') continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = left + (index * (glyphWidth + 1) + column) * scale + dx;
            const y = top + row * scale + dy;
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const at = (y * size + x) * 4;
            rgba[at] = 255;
            rgba[at + 1] = 255;
            rgba[at + 2] = 255;
            rgba[at + 3] = 255;
          }
        }
      }
    }
  });
  return encodePng(rgba, size, size);
}

/**
 * The tray's mark with the unread dot, from nativeImage's BGRA. The corner is cleared
 * first so the dot stands apart. `colour` null keeps it one colour for a macOS template.
 */
export function withUnreadDot(bgra: Uint8Array, size: number, colour: readonly [number, number, number] | null): Buffer {
  const rgba = new Uint8Array(bgra.length);
  for (let at = 0; at < bgra.length; at += 4) {
    rgba[at] = bgra[at + 2];
    rgba[at + 1] = bgra[at + 1];
    rgba[at + 2] = bgra[at];
    rgba[at + 3] = bgra[at + 3];
  }
  const radius = size * 0.28;
  const ring = radius + Math.max(1, size / 16);
  const cx = size - radius;
  const cy = size - radius;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const at = (y * size + x) * 4;
      if (distance <= ring) rgba[at + 3] = 0;
      const coverage = Math.min(1, Math.max(0, radius - distance + 0.5));
      if (coverage > 0) {
        rgba[at] = colour ? colour[0] : 0;
        rgba[at + 1] = colour ? colour[1] : 0;
        rgba[at + 2] = colour ? colour[2] : 0;
        rgba[at + 3] = Math.round(coverage * 255);
      }
    }
  }
  return encodePng(rgba, size, size);
}
