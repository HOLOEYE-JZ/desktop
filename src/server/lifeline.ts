/** Shared by main (src/main/server-process.ts) and the tests: no Electron here. */

import { readdir, rm } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREFIX = 'bulwark-lifeline-';
const SUFFIX = '.sock';

/**
 * Where a lifeline socket goes. Windows: a named pipe. Linux: a socket file in the user's
 * runtime folder ($XDG_RUNTIME_DIR, which only they can enter), else an abstract socket,
 * which leaves no file. macOS: a socket file in the temp folder.
 */
export function lifelinePath(platform: NodeJS.Platform, random: string, env: NodeJS.ProcessEnv = process.env, dir = tmpdir()): string {
  if (platform === 'win32') return `\\\\.\\pipe\\${PREFIX}${random}`;
  if (platform === 'linux') return env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, `${PREFIX}${random}${SUFFIX}`) : `\0${PREFIX}${random}`;
  return path.join(dir, `${PREFIX}${random}${SUFFIX}`);
}

/** The lifeline is a file on disk, which main removes when it ends. */
export function isFileSocket(where: string): boolean {
  return !where.startsWith('\0') && !where.startsWith('\\\\');
}

/**
 * Lifeline files in `dir` that nothing listens on any more (main crashed, so it never removed
 * its own): removed. One that answers belongs to a running app and stays.
 */
export async function removeStaleLifelines(dir: string): Promise<string[]> {
  const removed: string[] = [];
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX));
  for (const name of names) {
    const file = path.join(dir, name);
    const alive = await new Promise<boolean>((resolve) => {
      const socket = connect(file);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (alive) continue;
    await rm(file, { force: true }).catch(() => {});
    removed.push(file);
  }
  return removed;
}

/**
 * Which connections to a lifeline are main's servers: one per server process main started.
 * Anyone on the machine can connect to an abstract socket or a pipe, and any more than that
 * are closed at once, so nobody else can use up main's descriptors.
 */
export class LifelineGate {
  private granted = 0;
  private admitted = 0;

  /** A server process is on its way: its connection is expected. */
  grant(): void {
    this.granted += 1;
  }

  admit(): boolean {
    if (this.admitted >= this.granted) return false;
    this.admitted += 1;
    return true;
  }
}

/** Listens on `where` and holds what the gate admits. Null if it can't listen. */
export function serveLifeline(where: string, gate: LifelineGate): Promise<Server | null> {
  const server = createServer((socket) => {
    if (!gate.admit()) {
      socket.destroy();
      return;
    }
    socket.on('data', () => {});
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.once('error', () => resolve(null));
    server.listen(where, () => resolve(server));
  });
}
