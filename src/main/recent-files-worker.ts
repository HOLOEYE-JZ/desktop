/**
 * The file system calls behind the Attach menu's recent files, in a process of their own.
 * A path on a network share that's offline can take half a minute to fail, and while it
 * does it holds one of the few threads Node does file work on. In main that would stall
 * everything else that touches a file. Here main stops waiting when it wants to and kills
 * the process. See src/main/features/os-recent.ts.
 *
 * Nothing here is logged: the paths are the user's own.
 */

import { readdir, open, stat } from 'node:fs/promises';
import path from 'node:path';

export type RecentWorkerRequest =
  /** The .lnk files in a folder, with the time each was last written. */
  | { id: number; op: 'dir'; dir: string }
  /** Each path's kind, and a file's size, one answer per path as it comes. */
  | { id: number; op: 'check'; paths: string[] }
  /** A file's bytes, if it's a file and no larger than `max`. */
  | { id: number; op: 'read'; path: string; max: number };

export type RecentWorkerMessage =
  | { id: number; type: 'dir'; entries: { file: string; mtimeMs: number }[] | null }
  | { id: number; type: 'checked'; index: number; kind: 'file' | 'other' | 'missing'; size?: number }
  | { id: number; type: 'read'; ok: true; data: Uint8Array }
  | { id: number; type: 'read'; ok: false; reason: 'missing' | 'too-large' | 'failed' };

function send(message: RecentWorkerMessage): void {
  process.parentPort.postMessage(message);
}

async function listDir(id: number, dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    send({ id, type: 'dir', entries: null });
    return;
  }
  const entries = await Promise.all(
    names
      .filter((name) => name.toLowerCase().endsWith('.lnk'))
      .map(async (name) => {
        const file = path.join(dir, name);
        try {
          const info = await stat(file);
          return info.isFile() ? { file, mtimeMs: info.mtimeMs } : null;
        } catch {
          return null;
        }
      }),
  );
  send({ id, type: 'dir', entries: entries.filter((entry): entry is { file: string; mtimeMs: number } => entry !== null) });
}

function check(id: number, paths: string[]): void {
  paths.forEach((file, index) => {
    stat(file).then(
      (info) => send({ id, type: 'checked', index, ...(info.isFile() ? { kind: 'file', size: info.size } : { kind: 'other' }) }),
      () => send({ id, type: 'checked', index, kind: 'missing' }),
    );
  });
}

async function read(id: number, file: string, max: number): Promise<void> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    send({ id, type: 'read', ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'failed' });
    return;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      send({ id, type: 'read', ok: false, reason: 'missing' });
      return;
    }
    if (info.size > max) {
      send({ id, type: 'read', ok: false, reason: 'too-large' });
      return;
    }
    const data = await handle.readFile();
    // It grew while it was read.
    if (data.byteLength > max) send({ id, type: 'read', ok: false, reason: 'too-large' });
    else send({ id, type: 'read', ok: true, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
  } catch {
    send({ id, type: 'read', ok: false, reason: 'failed' });
  } finally {
    await handle.close().catch(() => {});
  }
}

process.parentPort.on('message', (event: { data: RecentWorkerRequest }) => {
  const request = event.data;
  if (request.op === 'dir') void listDir(request.id, request.dir);
  else if (request.op === 'check') check(request.id, request.paths);
  else if (request.op === 'read') void read(request.id, request.path, request.max);
});
