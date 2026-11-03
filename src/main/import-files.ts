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
 * - A 404 is only for what is really gone, since the import moves past it for good. A file
 *   that can't be read right now gets a 503, and the page tries again.
 * - Nothing in the request path touches the disk synchronously: a network path must not be
 *   able to hold main.
 * - Maildir messages are looked up by position in the confirmed folder's own listing.
 *
 * Chromium's protocol handler sees no Origin or Sec-Fetch headers here, so a request
 * can't be told apart by who sent it: the token is the lock. It stays in the page that
 * asked for it, never goes to a mail frame, and dies with the job.
 */

import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, realpath, stat, type FileHandle } from 'node:fs/promises';
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

/** What a read needs to know about a file, found out in the import worker. */
export interface PreparedFile {
  size: number;
  lastModified: number;
  entries?: MaildirEntry[];
}

interface Grant {
  token: string;
  jobId: string;
  file: ConfirmedFile;
  /** The size when confirmed: reads stop there, so what's appended later waits for the next import. */
  size: number;
  entries?: MaildirEntry[];
}

/** `in-use`: it's there and can't be read right now, which may pass. `gone` won't. */
export type ValidationFailure = 'gone' | 'in-use' | 'moved' | 'outside' | 'ost' | 'not-mail';

function failureOf(error: unknown): ValidationFailure {
  return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'in-use';
}

/** Throws nothing: says why a confirmed file can't be read, or null if it can. */
export async function validateConfirmed(file: ConfirmedFile): Promise<ValidationFailure | null> {
  let real: string;
  let root: string;
  try {
    real = await realpath(file.path);
    root = await realpath(file.root);
  } catch (error) {
    return failureOf(error);
  }
  // Both were realpaths when confirmed, so a difference means a link came in between.
  if (real !== file.path || root !== file.root) return 'moved';
  if (!isInside(root, real)) return 'outside';
  if (/\.ost$/i.test(real)) return 'ost';
  try {
    if (file.kind === 'maildir') return (await lstat(path.join(real, 'cur'))).isDirectory() ? null : 'not-mail';
    if (!(await stat(real)).isFile()) return 'not-mail';
  } catch (error) {
    return failureOf(error);
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
  } catch (error) {
    return failureOf(error);
  }
}

/** Runs in the import worker: a Maildir folder can be a million files, on a slow disk. */
export async function prepareFile(file: ConfirmedFile): Promise<{ failure: ValidationFailure } | { prepared: PreparedFile }> {
  const failure = (await validateConfirmed(file)) ?? (await validateContent(file));
  if (failure) return { failure };
  try {
    if (file.kind === 'maildir') {
      const entries = maildirEntries(file.path);
      const stats = await stat(path.join(file.path, 'cur'));
      return { prepared: { size: entries.reduce((total, entry) => total + entry.size, 0), lastModified: stats.mtimeMs, entries } };
    }
    const stats = await stat(file.path);
    return { prepared: { size: stats.size, lastModified: stats.mtimeMs } };
  } catch (error) {
    return { failure: failureOf(error) };
  }
}

export class ImportGrants {
  private readonly tokens = new Map<string, Grant>();
  private readonly handles = new Map<string, FileHandle>();

  constructor(private readonly origin: string) {}

  /** Call with what prepareFile found out about the file. No disk here: main must not wait for one. */
  add(jobId: string, file: ConfirmedFile, prepared: PreparedFile): GrantedFile {
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, { token, jobId, file, size: prepared.size, entries: prepared.entries });
    return {
      url: `${IMPORT_SCHEME}://f/${token}`,
      name: file.name,
      kind: file.kind,
      folder: file.folder,
      size: prepared.size,
      lastModified: prepared.lastModified,
      entrySizes: prepared.entries?.map((entry) => entry.size),
    };
  }

  /** Every token of every job stops working: a wipe. */
  async releaseAll(): Promise<void> {
    await Promise.all([...new Set([...this.tokens.values()].map((grant) => grant.jobId))].map((jobId) => this.release(jobId)));
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
    if (await validateConfirmed(grant.file)) return null;
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
    const failure = await validateConfirmed(grant.file);
    if (failure === 'in-use') return this.refuse(503);
    if (failure) return this.refuse(403);
    const target = path.join(grant.file.path, 'cur', entry.name);
    try {
      // A message replaced by a link is not a message.
      if (!(await lstat(target)).isFile() || !isInside(grant.file.path, await realpath(target))) return this.refuse(403);
      return new Response(await readFile(target), { status: 200, headers: this.headers() });
    } catch (error) {
      // 404 says Thunderbird deleted it, and the import moves past it for good. Only that may
      // say so: a file a virus scanner holds for a moment is still a message to import.
      return this.refuse((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 503);
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
      return this.refuse(503);
    }
  }
}
