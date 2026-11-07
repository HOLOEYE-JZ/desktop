/**
 * The server process ends with main. Chromium doesn't end a utilityProcess when main is killed
 * or crashes, and this one holds a listening port and the user's data open. So it holds a
 * connection to main's lifeline (src/main/server-process.ts), which the OS closes the moment
 * main goes, killed or not: no timer, so an idle server doesn't wake up for this. Until that
 * connection is made (before the init message names the lifeline, or when it can't be made),
 * it checks main's pid every ten seconds.
 *
 * No Electron here: the tests drive it.
 */

import { connect } from 'node:net';

/** Main names the server's folder on the command line, so Next loads before init. */
export const SERVER_ROOT_SWITCH = '--server-root=';
/** And its own pid, so the process is watched from its start, before init. Not a secret. */
export const PARENT_PID_SWITCH = '--parent-pid=';

export const PARENT_CHECK_MS = 10_000;

export interface ParentWatchDeps {
  alive: (pid: number) => boolean;
  exit: () => void;
  connect: (path: string) => { on(event: 'connect' | 'close' | 'error' | 'data', listener: (...args: unknown[]) => void): unknown; unref(): unknown };
  setInterval: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval: (timer: unknown) => void;
}

const realDeps: ParentWatchDeps = {
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  exit: () => process.exit(0),
  connect: (where) => connect(where),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

export class ParentWatch {
  private pid: number | null = null;
  private poll: { unref?: () => void } | null = null;
  private lifeline: string | null = null;

  constructor(private readonly deps: ParentWatchDeps = realDeps) {}

  /** Watches main's pid until a lifeline takes over. Again with the same pid: nothing new. */
  watchPid(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) return;
    this.pid = pid;
    if (this.poll || this.lifeline) return;
    this.poll = this.deps.setInterval(() => {
      if (this.pid !== null && !this.deps.alive(this.pid)) this.deps.exit();
    }, PARENT_CHECK_MS);
    this.poll.unref?.();
  }

  /** Main's lifeline: once connected, its close ends the process and the pid check stops. */
  useLifeline(where: string): void {
    if (this.lifeline) return;
    this.lifeline = where;
    let connected = false;
    const socket = this.deps.connect(where);
    socket.on('connect', () => {
      connected = true;
      this.stopPoll();
    });
    socket.on('data', () => {});
    socket.on('error', () => {});
    socket.on('close', () => {
      if (connected) {
        this.deps.exit();
        return;
      }
      // Never connected: the pid check goes on, or starts.
      this.lifeline = null;
      if (this.pid !== null) this.watchPid(this.pid);
    });
    // Not what keeps the process alive: the server is.
    socket.unref();
  }

  get polling(): boolean {
    return this.poll !== null;
  }

  private stopPoll(): void {
    if (!this.poll) return;
    this.deps.clearInterval(this.poll);
    this.poll = null;
  }
}

/** A switch's value from argv, or undefined. */
export function switchValue(argv: string[], name: string): string | undefined {
  return argv.find((arg) => arg.startsWith(name))?.slice(name.length);
}
