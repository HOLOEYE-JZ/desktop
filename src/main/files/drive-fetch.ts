/**
 * The Files drive's fetches: Windows asks main for a file's bytes (someone opened it), main
 * asks the main window's page (`drive.onFetch`), the page streams the blob back
 * (`drive.supply`), and main hands it to Windows in pieces, so Explorer shows progress.
 *
 * Windows takes bytes only from 4 KB aligned offsets, in multiples of 4 KB unless they end
 * the file. The page may supply any sizes: this keeps what doesn't fill a piece until the
 * next supply. A fetch the page never answers, or stops answering, fails after a while, so
 * the program that opened the file gets an error rather than waiting for ever.
 *
 * No Electron here: features/files-drive.ts gives it the helper and the page.
 */

import { randomBytes } from 'node:crypto';
import type { FilesFetchRequest } from '../../shared/bridge';
import type { NativeFetchEvent, NativeFilesModule } from '../native-loader';

export const ALIGN = 4096;
/** A piece for Windows: progress moves at least this often. A multiple of ALIGN. */
export const PIECE = 1024 * 1024;
/** Windows itself gives up on a provider after 60 s without data. */
export const FIRST_ANSWER_MS = 30_000;
export const IDLE_MS = 30_000;

export type FetchFailure = 'offline' | 'denied' | 'timeout' | 'not-running' | 'failed';

export interface FetchRelayOptions {
  native: Pick<NativeFilesModule, 'filesDriveTransfer' | 'filesDriveTransferFailed'>;
  /** The root a connection belongs to, and the path relative to it, or null. */
  locate: (connection: string, absolutePath: string) => { rootId: string; path: string } | null;
  /** Hands the request to the page. False: no page to ask (no main window, or it's locked). */
  ask: (request: FilesFetchRequest) => FetchFailure | true;
  /** Tells the page a fetch is off. */
  cancelled: (fetchId: string) => void;
  firstAnswerMs?: number;
  idleMs?: number;
  warn?: (message: string) => void;
}

interface Fetch {
  id: string;
  rootId: string;
  event: NativeFetchEvent;
  /** The next byte the page should send. */
  next: number;
  /** Where `pending` starts: always aligned. */
  at: number;
  pending: Buffer[];
  pendingBytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Transfers one after another. */
  chain: Promise<boolean>;
  over: boolean;
}

export class FetchRelay {
  private readonly fetches = new Map<string, Fetch>();
  private readonly options: Required<Omit<FetchRelayOptions, 'warn'>> & { warn: (message: string) => void };

  constructor(options: FetchRelayOptions) {
    this.options = { firstAnswerMs: FIRST_ANSWER_MS, idleMs: IDLE_MS, warn: console.warn, ...options };
  }

  /** Fetches under way, for tests and for a root that goes. */
  active(rootId?: string): FilesFetchRequest[] {
    return [...this.fetches.values()].filter((fetch) => !rootId || fetch.rootId === rootId).map((fetch) => this.requestOf(fetch, ''));
  }

  /** What the helper's callback brings. */
  onNative(event: NativeFetchEvent): void {
    if (event.kind === 'cancel') {
      for (const fetch of this.fetches.values()) {
        if (fetch.event.connection === event.connection && fetch.event.transferKey === event.transferKey) this.end(fetch, null, true);
      }
      return;
    }
    const where = this.options.locate(event.connection, event.path);
    if (!where || !event.identity || event.total <= 0) {
      this.failNative(event, 'failed');
      return;
    }
    const start = Math.floor(event.offset / ALIGN) * ALIGN;
    const fetch: Fetch = {
      id: randomBytes(12).toString('hex'),
      rootId: where.rootId,
      event,
      next: start,
      at: start,
      pending: [],
      pendingBytes: 0,
      timer: null,
      chain: Promise.resolve(true),
      over: false,
    };
    this.fetches.set(fetch.id, fetch);
    const asked = this.options.ask(this.requestOf(fetch, where.path));
    if (asked !== true) {
      this.end(fetch, asked, false);
      return;
    }
    this.arm(fetch, this.options.firstAnswerMs);
  }

  /**
   * Bytes from the page, in order. Anything before what's still wanted is skipped, so the page
   * may always start from 0. False once Windows no longer wants them, or on a gap.
   */
  supply(fetchId: unknown, offset: unknown, data: unknown): Promise<boolean> {
    const fetch = typeof fetchId === 'string' ? this.fetches.get(fetchId) : undefined;
    if (!fetch || fetch.over) return Promise.resolve(false);
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || !(data instanceof Uint8Array)) {
      this.end(fetch, 'failed', true);
      return Promise.resolve(false);
    }
    const total = fetch.event.total;
    const end = Math.min(offset + data.byteLength, total);
    if (offset > fetch.next) {
      // A gap can't be filled: Windows takes the bytes in order.
      this.end(fetch, 'failed', true);
      return Promise.resolve(false);
    }
    if (end > fetch.next) {
      const slice = Buffer.from(data.buffer, data.byteOffset + (fetch.next - offset), end - fetch.next);
      // A copy: the page's buffer belongs to IPC, and a piece may wait for the next supply.
      fetch.pending.push(Buffer.from(slice));
      fetch.pendingBytes += slice.byteLength;
      fetch.next = end;
    }
    this.arm(fetch, this.options.idleMs);
    const finished = fetch.next >= total;
    while (fetch.pendingBytes >= PIECE || (finished && fetch.pendingBytes > 0)) {
      const take = finished ? Math.min(fetch.pendingBytes, PIECE) : PIECE;
      const piece = this.takePending(fetch, take);
      const at = fetch.at;
      fetch.at += take;
      fetch.chain = fetch.chain.then((good) => (good && !fetch.over ? this.send(fetch, at, piece) : false));
    }
    if (finished) {
      fetch.chain = fetch.chain.then((good) => {
        if (good) this.end(fetch, null, false);
        return good;
      });
    }
    return fetch.chain;
  }

  /** The page can't get it: `offline`, `missing` or `failed`. */
  fail(fetchId: unknown, error: unknown): void {
    const fetch = typeof fetchId === 'string' ? this.fetches.get(fetchId) : undefined;
    if (!fetch || fetch.over) return;
    this.end(fetch, error === 'offline' ? 'offline' : 'failed', false);
  }

  /** A root goes: whatever it was fetching fails now. */
  dropRoot(rootId: string): void {
    for (const fetch of [...this.fetches.values()]) if (fetch.rootId === rootId) this.end(fetch, 'not-running', true);
  }

  private requestOf(fetch: Fetch, path: string): FilesFetchRequest {
    const start = Math.floor(fetch.event.offset / ALIGN) * ALIGN;
    // Full hydration: Windows wants the file whole, from its first byte asked to the end.
    return { fetchId: fetch.id, rootId: fetch.rootId, identity: fetch.event.identity, path, offset: start, length: fetch.event.total - start, total: fetch.event.total };
  }

  private takePending(fetch: Fetch, bytes: number): Buffer {
    const joined = fetch.pending.length === 1 ? fetch.pending[0] : Buffer.concat(fetch.pending);
    const piece = joined.subarray(0, bytes);
    const rest = joined.subarray(bytes);
    fetch.pending = rest.byteLength ? [rest] : [];
    fetch.pendingBytes = rest.byteLength;
    return piece;
  }

  private async send(fetch: Fetch, at: number, piece: Buffer): Promise<boolean> {
    const { connection, transferKey, requestKey } = fetch.event;
    try {
      await this.options.native.filesDriveTransfer(connection, transferKey, requestKey, at, piece);
      return true;
    } catch (error) {
      // Cancelled by Windows, or the file went: nothing more to send.
      this.options.warn(`A Files drive transfer failed: ${(error as Error).message}`);
      this.end(fetch, null, true);
      return false;
    }
  }

  private arm(fetch: Fetch, ms: number): void {
    if (fetch.timer) clearTimeout(fetch.timer);
    fetch.timer = setTimeout(() => this.end(fetch, 'timeout', true), ms);
    fetch.timer.unref?.();
  }

  /** Ends a fetch. `failure`: tell Windows. `tellPage`: tell the page to stop. */
  private end(fetch: Fetch, failure: FetchFailure | null, tellPage: boolean): void {
    if (fetch.over) return;
    fetch.over = true;
    if (fetch.timer) clearTimeout(fetch.timer);
    this.fetches.delete(fetch.id);
    fetch.pending = [];
    if (failure) this.failNative(fetch.event, failure, fetch.at);
    if (tellPage) this.options.cancelled(fetch.id);
  }

  private failNative(event: NativeFetchEvent, reason: FetchFailure, from = event.offset): void {
    const start = Math.floor(from / ALIGN) * ALIGN;
    const length = Math.max(event.offset + event.length, event.total) - start;
    try {
      this.options.native.filesDriveTransferFailed(event.connection, event.transferKey, event.requestKey, start, Math.max(length, 0), reason);
    } catch (error) {
      // Windows cancelled it already, or the connection went.
      this.options.warn(`Ending a Files drive fetch failed: ${(error as Error).message}`);
    }
  }
}
