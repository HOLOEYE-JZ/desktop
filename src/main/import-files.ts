/**
 * The one way file bytes reach a page for a local import: `bulwark-import://f/<token>`,
 * a scheme served from main with Range support. No Electron here, so tests can load it.
 *
 * Why a scheme: pst-extractor is synchronous, so its worker needs a real Blob or a
 * synchronous read. A synchronous XHR with a Range header in the worker works against
 * this scheme under the app's CSP, in 3 ms a page, in both modes (decision in the
 * decisions file). An instance's page has no path on the embedded server, a Blob would
 * copy the PST into the browser profile unencrypted, and an IPC call can't be synchronous
 * from a worker.
 *
 * What's checked, and when:
 * - A token only exists for a file main found itself and the user confirmed natively.
 * - The token is unguessable and is the only thing that names a file. The page can't
 *   send a path: there is no field for one.
 * - Before a file is first opened, and again after a handle was closed, its realpath must
 *   be the path that was confirmed, inside its root. Swapping a folder for a link after
 *   confirming gets 403.
 * - Maildir messages are looked up by position in the confirmed folder's own listing.
 *
 * Chromium's protocol handler sees no Origin or Sec-Fetch headers here, so a request
 * can't be told apart by who sent it: the token is the lock. It stays in the page that
 * asked for it, never goes to a mail frame, and dies with the job.
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { open, readFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { dataFileType, isInside, looksLikeMbox, maildirEntries, type ImportKind, type MaildirEntry } from './import-scan';

export const IMPORT_SCHEME = 'bulwark-import';

/** Bigger than any page the readers ask for, smaller than a mistake. */
const MAX_RANGE = 16 * 1024 * 1024;
/** Handles kept open at once: a profile can have hundreds of folders, read one after another. */
const MAX_OPEN = 8;

export interface ConfirmedFile {
  path: string;
  root: string;
  kind: ImportKind;
  name: string;
  folder: string[];
}

export interface GrantedFile {
  url: string;
  name: string;
  kind: ImportKind;
  folder: string[];
  size: number;
  lastModified: number;
  /** Maildir: each message's size, by position. */
  entrySizes?: number[];
}

interface Grant {
  token: string;
  jobId: string;
  file: ConfirmedFile;
  /** The size when confirmed: reads stop there, so what's appended later waits for the next import. */
  size: number;
  entries?: MaildirEntry[];
}

export type ValidationFailure = 'gone' | 'moved' | 'outside' | 'ost' | 'not-mail';

/** Throws nothing: says why a confirmed file can't be read, or null if it can. */
export function validateConfirmed(file: ConfirmedFile): ValidationFailure | null {
  let real: string;
  let root: string;
  try {
    real = realpathSync(file.path);
    root = realpathSync(file.root);
  } catch {
    return 'gone';
  }
  // Both were realpaths when confirmed, so a difference means a link came in between.
  if (real !== file.path || root !== file.root) return 'moved';
  if (!isInside(root, real)) return 'outside';
  if (/\.ost$/i.test(real)) return 'ost';
  try {
    if (file.kind === 'maildir') return lstatSync(path.join(real, 'cur')).isDirectory() ? null : 'not-mail';
    if (!statSync(real).isFile()) return 'not-mail';
  } catch {
    return 'gone';
  }
  return null;
}

async function headOf(file: string, length: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(length);
    const { bytesRead } = await handle.read(head, 0, length, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The bytes again, since a file can change between the listing and now. */
export async function validateContent(file: ConfirmedFile): Promise<ValidationFailure | null> {
  if (file.kind === 'maildir') return null;
  try {
    const head = await headOf(file.path, 512);
    if (file.kind === 'mbox') return looksLikeMbox(head) ? null : 'not-mail';
    const type = dataFileType(head);
    if (type === 'ost') return 'ost';
    return type === 'pst' ? null : 'not-mail';
  } catch {
    return 'gone';
  }
}

export class ImportGrants {
  private readonly tokens = new Map<string, Grant>();
  private readonly handles = new Map<string, FileHandle>();

  constructor(private readonly origin: string) {}

  /** Call with a file validateConfirmed and validateContent passed. */
  add(jobId: string, file: ConfirmedFile): GrantedFile {
    const token = randomBytes(32).toString('base64url');
    const entries = file.kind === 'maildir' ? maildirEntries(file.path) : undefined;
    const stat = statSync(file.kind === 'maildir' ? path.join(file.path, 'cur') : file.path);
    const size = entries ? entries.reduce((total, entry) => total + entry.size, 0) : stat.size;
    this.tokens.set(token, { token, jobId, file, size, entries });
    return {
      url: `${IMPORT_SCHEME}://f/${token}`,
      name: file.name,
      kind: file.kind,
      folder: file.folder,
      size,
      lastModified: stat.mtimeMs,
      entrySizes: entries?.map((entry) => entry.size),
    };
  }

  /** Every token of a job stops working. */
  async release(jobId: string): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [token, grant] of this.tokens) {
      if (grant.jobId !== jobId) continue;
      this.tokens.delete(token);
      const handle = this.handles.get(token);
      if (handle) {
        this.handles.delete(token);
        closing.push(handle.close().catch(() => undefined));
      }
    }
    await Promise.all(closing);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'access-control-allow-origin': this.origin,
      'access-control-allow-headers': 'range',
      'access-control-expose-headers': 'content-range',
      'cache-control': 'no-store',
      'content-type': 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      ...extra,
    };
  }

  private refuse(status: number): Response {
    return new Response(null, { status, headers: this.headers() });
  }

  private async handleFor(grant: Grant): Promise<FileHandle | null> {
    const known = this.handles.get(grant.token);
    if (known) {
      // Most recently used last, so the oldest closes first.
      this.handles.delete(grant.token);
      this.handles.set(grant.token, known);
      return known;
    }
    if (validateConfirmed(grant.file)) return null;
    const handle = await open(grant.file.path, 'r');
    this.handles.set(grant.token, handle);
    if (this.handles.size > MAX_OPEN) {
      const [oldest, oldestHandle] = this.handles.entries().next().value as [string, FileHandle];
      this.handles.delete(oldest);
      await oldestHandle.close().catch(() => undefined);
    }
    return handle;
  }

  private async serveRange(grant: Grant, range: string | null): Promise<Response> {
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    // Always a range: a whole PST in one answer would be the copy this is meant to avoid.
    if (!match) return this.refuse(416);
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), grant.size - 1);
    if (start > end) return this.refuse(416);
    const length = end - start + 1;
    if (length > MAX_RANGE) return this.refuse(416);
    const handle = await this.handleFor(grant);
    if (!handle) return this.refuse(403);
    // Thunderbird compacted the folder: positions mean nothing any more. Appending is harmless.
    if ((await handle.stat()).size < grant.size) return this.refuse(409);
    const bytes = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(bytes, 0, length, start);
    if (bytesRead !== length) return this.refuse(409);
    return new Response(bytes, {
      status: 206,
      headers: this.headers({ 'content-range': `bytes ${start}-${end}/${grant.size}`, 'content-length': String(length) }),
    });
  }

  private async serveEntry(grant: Grant, index: number): Promise<Response> {
    const entry = grant.entries?.[index];
    if (!entry) return this.refuse(404);
    if (validateConfirmed(grant.file)) return this.refuse(403);
    const target = path.join(grant.file.path, 'cur', entry.name);
    try {
      // A message replaced by a link is not a message.
      if (!lstatSync(target).isFile() || !isInside(grant.file.path, realpathSync(target))) return this.refuse(403);
      return new Response(await readFile(target), { status: 200, headers: this.headers() });
    } catch {
      // Thunderbird deleted it since. The source counts it as a message that's gone.
      return this.refuse(404);
    }
  }

  async serve(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: this.headers() });
    if (request.method !== 'GET') return this.refuse(405);
    const match = new RegExp(`^${IMPORT_SCHEME}://f/([A-Za-z0-9_-]{43})(?:/(\\d{1,9}))?$`).exec(request.url);
    const grant = match ? this.tokens.get(match[1]) : undefined;
    if (!match || !grant) return this.refuse(404);
    try {
      if (match[2] !== undefined) return await this.serveEntry(grant, Number(match[2]));
      if (grant.file.kind === 'maildir') return this.refuse(404);
      return await this.serveRange(grant, request.headers.get('range'));
    } catch {
      return this.refuse(500);
    }
  }
}
