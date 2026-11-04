import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Reads back a jump list as Windows stored it. There's one file per AppUserModelID, named
 * after a CRC-64 of the ID in upper case, UTF-16 (polynomial 0x92C64265D32139A4, reflected,
 * starting from all ones), in hex.
 */

const POLY = 0x92c64265d32139a4n;
const MASK = 0xffffffffffffffffn;
const TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = BigInt(index);
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1n ? (crc >> 1n) ^ POLY : crc >> 1n;
  return crc;
});

export function jumpListId(appUserModelId: string): string {
  let crc = MASK;
  for (const byte of Buffer.from(appUserModelId.toUpperCase(), 'utf16le')) crc = TABLE[Number((crc ^ BigInt(byte)) & 0xffn)] ^ (crc >> 8n);
  // Without leading zeros, as Windows names it.
  return crc.toString(16);
}

export function jumpListFile(appUserModelId: string): string {
  return path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Recent', 'CustomDestinations', `${jumpListId(appUserModelId)}.customDestinations-ms`);
}

/** The text in it: titles, arguments, programs and icon paths, as UTF-16 runs. */
export function jumpListText(appUserModelId: string): string {
  const file = jumpListFile(appUserModelId);
  if (!existsSync(file)) return '';
  const data = readFileSync(file);
  const runs: string[] = [];
  // Shell links don't align their strings: read from both byte offsets.
  for (const start of [0, 1]) {
    let run = '';
    for (let at = start; at + 1 < data.length; at += 2) {
      const code = data.readUInt16LE(at);
      // Latin script only, which is all the checks look for: less noise in a failure.
      if ((code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code < 0x180)) {
        run += String.fromCharCode(code);
      } else {
        if (run.length >= 3) runs.push(run);
        run = '';
      }
    }
    if (run.length >= 3) runs.push(run);
  }
  return runs.join('\n');
}
