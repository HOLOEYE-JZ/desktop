/**
 * Mail as real files: dragged out to Explorer or Finder, or copied to the clipboard.
 * The file must exist before the drag starts, so it goes in a private folder under
 * userData, never the shared temp folder, and leaves again afterwards. Each file is
 * marked as coming from outside, as a browser's download is, so Windows treats a
 * dragged-out attachment with the same care.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, clipboard, nativeImage, type WebContents } from 'electron';
import { safeFileName } from './os-rules';

/** After this a dropped file has long been copied. On macOS and Linux startDrag returns at once. */
const DRAG_FILE_LIFE_MS = 60 * 60 * 1000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_FILES = 200;

interface Incoming {
  name: string;
  data: Uint8Array;
}

function cleanFiles(raw: unknown): Incoming[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FILES) return null;
  let total = 0;
  const seen = new Set<string>();
  const files: Incoming[] = [];
  for (const entry of raw) {
    const input = (entry ?? {}) as { name?: unknown; data?: unknown };
    if (!(input.data instanceof Uint8Array)) return null;
    total += input.data.byteLength;
    if (total > MAX_TOTAL_BYTES) return null;
    const first = safeFileName(input.name);
    let name = first;
    for (let n = 2; seen.has(name.toLowerCase()); n += 1) {
      const ext = path.extname(first);
      name = `${path.basename(first, ext)} (${n})${ext}`;
    }
    seen.add(name.toLowerCase());
    files.push({ name, data: input.data });
  }
  return files;
}

function copyToClipboard(paths: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // A real file list (CF_HDROP), which is what Explorer pastes. Paths by environment, not in the script.
      const script = '$p = $env:BULWARK_COPY_PATHS -split "`n"; Set-Clipboard -LiteralPath $p';
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 15_000, env: { ...process.env, BULWARK_COPY_PATHS: paths.join('\n') } },
        (error) => resolve(!error),
      );
    } else if (process.platform === 'darwin') {
      const script = 'on run argv\nset out to {}\nrepeat with p in argv\nset end of out to (POSIX file (p as text))\nend repeat\nset the clipboard to out\nend run';
      execFile('osascript', ['-e', script, ...paths], { timeout: 15_000 }, (error) => resolve(!error));
    } else {
      const uris = paths.map((p) => `file://${p.split('/').map(encodeURIComponent).join('/')}`);
      // Marked experimental, so it isn't in Electron's types.
      const writer = clipboard as unknown as { writeBuffer?: (format: string, data: Buffer) => void };
      writer.writeBuffer?.('text/uri-list', Buffer.from(`${uris.join('\r\n')}\r\n`));
      writer.writeBuffer?.('x-special/gnome-copied-files', Buffer.from(`copy\n${uris.join('\n')}`));
      resolve(!!writer.writeBuffer);
    }
  });
}

export interface FilesHandle {
  directory: string;
  prepare: (raw: unknown) => Promise<{ folder: string; paths: string[] } | null>;
  startDrag: (contents: WebContents, raw: unknown) => Promise<boolean>;
  copy: (raw: unknown) => Promise<boolean>;
}

export function setupFiles(iconPath: string): FilesHandle {
  const directory = path.join(app.getPath('userData'), 'os-files');
  // Whatever a crash or the last run left. A copied file only needs to last the run.
  rmSync(directory, { recursive: true, force: true });

  const prepare = async (raw: unknown) => {
    const files = cleanFiles(raw);
    if (!files) return null;
    const folder = path.join(directory, randomUUID());
    await mkdir(folder, { recursive: true });
    const paths: string[] = [];
    for (const file of files) {
      const target = path.join(folder, file.name);
      await writeFile(target, file.data, { mode: 0o600 });
      if (process.platform === 'win32') {
        await writeFile(`${target}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n').catch(() => {
          // Not NTFS: there's nowhere to put the mark.
        });
      }
      paths.push(target);
    }
    return { folder, paths };
  };

  const startDrag = async (contents: WebContents, raw: unknown) => {
    const prepared = await prepare(raw);
    if (!prepared) return false;
    const { folder, paths } = prepared;
    contents.startDrag({ file: paths[0], files: paths, icon: nativeImage.createFromPath(iconPath) });
    const cleanup = setTimeout(() => void rm(folder, { recursive: true, force: true }), DRAG_FILE_LIFE_MS);
    cleanup.unref?.();
    return true;
  };

  const copy = async (raw: unknown) => {
    const prepared = await prepare(raw);
    return prepared ? copyToClipboard(prepared.paths) : false;
  };

  app.on('will-quit', () => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory, prepare, startDrag, copy };
}
