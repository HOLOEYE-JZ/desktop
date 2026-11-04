/**
 * One recursive watch per root, with what it reports gathered into batches: a save is
 * several events, and copying a folder in is thousands. The page hears the paths that
 * changed, or `null` to scan everything: too many at once, the watch failed, or it was off
 * for a while (paused, the disk away, an error). No Electron here, so tests can drive it.
 */

import { watch as fsWatch } from 'node:fs';
import { isLockFileName, isTempName } from './paths';

export interface WatchHandle {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type WatchFunction = (dir: string, listener: (event: string, filename: string | Buffer | null) => void) => WatchHandle;

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const realTimers: Timers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

const realWatch: WatchFunction = (dir, listener) => fsWatch(dir, { recursive: true, persistent: false }, listener);

export interface WatcherOptions {
  watch?: WatchFunction;
  timers?: Timers;
  /** Quiet this long and the batch goes. */
  debounceMs?: number;
  /** A batch never waits longer than this, however busy the folder is. */
  maxWaitMs?: number;
  /** More paths than this in one batch: scan everything. */
  maxPaths?: number;
  /** First wait before watching again after a failure; doubles up to `maxRearmMs`. */
  rearmMs?: number;
  maxRearmMs?: number;
}

/** Only main's own temporary files, and a program's lock files on their own, wake nobody. */
export function ignoredChange(relative: string): boolean {
  const parts = relative.split('/');
  const name = parts[parts.length - 1] ?? '';
  return parts.some(isTempName) || isLockFileName(name);
}

export class RootWatcher {
  private handle: WatchHandle | null = null;
  private readonly pending = new Set<string>();
  private overflow = false;
  private firstAt = 0;
  private flushTimer: unknown = null;
  private rearmTimer: unknown = null;
  private rearmWait: number;
  private running = false;
  private readonly watchFn: WatchFunction;
  private readonly timers: Timers;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly maxPaths: number;
  private readonly rearmMs: number;
  private readonly maxRearmMs: number;

  constructor(
    private readonly dir: string,
    private readonly deliver: (paths: string[] | null) => void,
    options: WatcherOptions = {},
  ) {
    this.watchFn = options.watch ?? realWatch;
    this.timers = options.timers ?? realTimers;
    this.debounceMs = options.debounceMs ?? 400;
    this.maxWaitMs = options.maxWaitMs ?? 2000;
    this.maxPaths = options.maxPaths ?? 1000;
    this.rearmMs = options.rearmMs ?? 1000;
    this.maxRearmMs = options.maxRearmMs ?? 60_000;
    this.rearmWait = this.rearmMs;
  }

  /** `missed`: changes may have happened while nobody watched, so the first word is "scan it all". */
  start(missed = false): void {
    if (this.running) return;
    this.running = true;
    this.arm(missed);
  }

  stop(): void {
    this.running = false;
    this.handle?.close();
    this.handle = null;
    if (this.flushTimer !== null) this.timers.clear(this.flushTimer);
    if (this.rearmTimer !== null) this.timers.clear(this.rearmTimer);
    this.flushTimer = null;
    this.rearmTimer = null;
    this.pending.clear();
    this.overflow = false;
  }

  get watching(): boolean {
    return this.handle !== null;
  }

  private arm(missed: boolean): void {
    if (!this.running) return;
    let handle: WatchHandle;
    try {
      handle = this.watchFn(this.dir, (_event, filename) => this.note(filename));
    } catch {
      this.scheduleRearm();
      return;
    }
    this.handle = handle;
    handle.on('error', () => {
      if (this.handle !== handle) return;
      handle.close();
      this.handle = null;
      this.note(null);
      this.flush();
      this.scheduleRearm();
    });
    this.rearmWait = this.rearmMs;
    if (missed) {
      this.note(null);
      this.flush();
    }
  }

  private scheduleRearm(): void {
    if (!this.running || this.rearmTimer !== null) return;
    const wait = this.rearmWait;
    this.rearmWait = Math.min(this.rearmWait * 2, this.maxRearmMs);
    this.rearmTimer = this.timers.set(() => {
      this.rearmTimer = null;
      this.arm(true);
    }, wait);
  }

  private note(filename: string | Buffer | null): void {
    if (!this.running) return;
    if (filename === null || filename === undefined) {
      // The OS dropped what it couldn't hold, or didn't say which file.
      this.overflow = true;
    } else {
      const relative = String(filename).split('\\').join('/');
      if (ignoredChange(relative)) return;
      this.pending.add(relative);
      if (this.pending.size > this.maxPaths) this.overflow = true;
    }
    const now = this.timers.now();
    if (this.flushTimer === null) this.firstAt = now;
    else this.timers.clear(this.flushTimer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstAt + this.maxWaitMs - now));
    this.flushTimer = this.timers.set(() => this.flush(), wait);
  }

  private flush(): void {
    if (this.flushTimer !== null) this.timers.clear(this.flushTimer);
    this.flushTimer = null;
    if (!this.overflow && this.pending.size === 0) return;
    const paths = this.overflow ? null : [...this.pending];
    this.pending.clear();
    this.overflow = false;
    if (this.running) this.deliver(paths);
  }
}
