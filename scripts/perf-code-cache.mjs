// For scripts/perf-check.mjs: whether a packed build carries the server's code cache, and how
// much of it the host used, from its log. A build that carries one and uses none of it starts
// as slowly as one without (another V8, a damaged cache), and the check says so.

import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

const CACHE_FOLDER = '.code-cache';

/** The server.asar next to a packed app's executable (Linux and Windows layout). */
export function serverAsarFor(app) {
  return path.join(path.dirname(app), 'resources', 'server.asar');
}

/** Whether the asar's file list has the code cache's folder at its root. False for no file or no asar. */
export function asarHasCodeCache(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    // Chromium pickles: [4][header pickle size], then the header pickle [payload size][string size][JSON].
    const head = Buffer.alloc(16);
    if (readSync(fd, head, 0, 16, 0) < 16) return false;
    const size = head.readUInt32LE(12);
    const json = Buffer.alloc(size);
    if (readSync(fd, json, 0, size, 16) < size) return false;
    const header = JSON.parse(json.toString('utf8'));
    return Boolean(header?.files?.[CACHE_FOLDER]?.files);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The host's "code cache at ready: N used, ..." line in server.log: N, or null without that line. */
export function codeCacheUsed(log) {
  const lines = [...String(log).matchAll(/code cache at ready: (\d+) used, (\d+) rejected/g)];
  if (lines.length === 0) return null;
  return Number(lines.at(-1)[1]);
}
