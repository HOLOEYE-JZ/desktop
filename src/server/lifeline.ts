/** Shared by main (src/main/server-process.ts) and the tests: no Electron here. */

import { tmpdir } from 'node:os';
import path from 'node:path';

/** Where a lifeline socket goes: no file on Linux (abstract) or Windows (a named pipe). */
export function lifelinePath(platform: NodeJS.Platform, random: string, dir = tmpdir()): string {
  if (platform === 'win32') return `\\\\.\\pipe\\bulwark-lifeline-${random}`;
  if (platform === 'linux') return `\0bulwark-lifeline-${random}`;
  return path.join(dir, `bulwark-lifeline-${random}.sock`);
}
