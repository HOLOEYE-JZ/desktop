/**
 * How a file's bytes reach the page's sync engine: `bulwark-files://r/<token>`, served from
 * main, Range included, as the import's scheme does (import-files.ts). No Electron here, so
 * tests can serve it.
 *
 * - A token names one file `openRead` checked, and is the only thing that names it. It's
 *   good for one request within a short time, and goes with its root, a lock, or the page.
 * - At the request the path is checked again (no link on the way, still in its root), and
 *   the open file must still be what `openRead` answered: anything else is 409, and the
 *   page asks again.
 * - A drive file whose content isn't on the disk is never read: that would ask the page for
 *   the bytes it's asking for.
 * - Nothing in the request path touches the disk synchronously.
 */

import { randomBytes } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { FilesLocalEntry } from '../../shared/bridge';
import { fileIdOf, mtimeMsOf } from './disk';

export const FILES_SCHEME = 'bulwark-files';

/** Long enough for the page to start the fetch it asked for. */
const TOKEN_LIFE_MS = 60_000;
const MAX_TOKENS = 64;

interface Grant {
  token: string;
  rootId: string;
  relative: string;
  entry: FilesLocalEntry;
  expires: number;
}

/** The file's absolute path if it's still fine to read, or null. */
export type Recheck = (rootId: string, relative: string) => Promise<string | null>;

export class FilesReadGrants {
  private readonly tokens = new Map<string, Grant>();

  constructor(
    private readonly origin: string,
    private readonly recheck: Recheck,
    private readonly now: () => number = Date.now,
  ) {}

  add(rootId: string, entry: FilesLocalEntry): string {
    this.sweep();
    while (this.tokens.size >= MAX_TOKENS) this.tokens.delete(this.tokens.keys().next().value as string);
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, { token, rootId, relative: entry.path, entry, expires: this.now() + TOKEN_LIFE_MS });
    return `${FILES_SCHEME}://r/${token}`;
  }

  revokeRoot(rootId: string): void {
    for (const [token, grant] of this.tokens) if (grant.rootId === rootId) this.tokens.delete(token);
  }

  revokeAll(): void {
    this.tokens.clear();
  }

  sweep(): void {
    const now = this.now();
    for (const [token, grant] of this.tokens) if (grant.expires <= now) this.tokens.delete(token);
  }

  get size(): number {
    return this.tokens.size;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'access-control-allow-origin': this.origin,
      'access-control-allow-headers': 'range',
      'access-control-expose-headers': 'content-range, content-length',
      'cache-control': 'no-store',
      'content-type': 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      ...extra,
    };
  }

  private refuse(status: number, extra: Record<string, string> = {}): Response {
    return new Response(null, { status, headers: this.headers(extra) });
  }

  async serve(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: this.headers() });
    if (request.method !== 'GET') return this.refuse(405);
    const match = new RegExp(`^${FILES_SCHEME}://r/([A-Za-z0-9_-]{43})$`).exec(request.url);
    const grant = match ? this.tokens.get(match[1]) : undefined;
    if (!match || !grant) return this.refuse(404);
    // Once: a second fetch of the same URL is someone else's.
    this.tokens.delete(grant.token);
    if (grant.expires <= this.now()) return this.refuse(404);
    let handle: FileHandle | null = null;
    try {
      const absolute = await this.recheck(grant.rootId, grant.relative);
      if (!absolute) return this.refuse(403);
      handle = await open(absolute, 'r');
      const stats = await handle.stat({ bigint: true });
      const { entry } = grant;
      if (!stats.isFile() || fileIdOf(stats) !== entry.fileId || Number(stats.size) !== entry.size || mtimeMsOf(stats) !== entry.mtimeMs) {
        return this.refuse(409);
      }
      const size = entry.size;
      const range = request.headers.get('range');
      let start = 0;
      let end = size - 1;
      let status = 200;
      const extra: Record<string, string> = { 'accept-ranges': 'bytes' };
      if (range) {
        const parsed = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
        if (!parsed) return this.refuse(416, { 'content-range': `bytes */${size}` });
        start = Number(parsed[1]);
        end = parsed[2] === '' ? size - 1 : Math.min(Number(parsed[2]), size - 1);
        if (start > end || start >= size) return this.refuse(416, { 'content-range': `bytes */${size}` });
        status = 206;
        extra['content-range'] = `bytes ${start}-${end}/${size}`;
      }
      const length = Math.max(0, end - start + 1);
      extra['content-length'] = String(length);
      if (length === 0) return new Response(null, { status, headers: this.headers(extra) });
      // The stream closes the handle when it ends or is cancelled.
      const stream = handle.createReadStream({ start, end, autoClose: true });
      handle = null;
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers: this.headers(extra) });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return this.refuse(code === 'ENOENT' ? 404 : code === 'EBUSY' || code === 'EPERM' ? 409 : 503);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}
