/**
 * Starts the embedded server in a utilityProcess and waits until it listens.
 * The process has an allowlisted env and doesn't inherit ours. It dies with the
 * app: Chromium kills its utility processes on exit, and we kill it on will-quit.
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import type { HostEvent, InitMessage, MainErrorMessage, PrivacyMessage } from '../server/protocol';
import { lifelinePath } from '../server/lifeline';

const READY_TIMEOUT_MS = 90_000;

let lifelineServer: { server: Server; path: string; sockets: Set<Socket> } | null = null;


/**
 * The servers' lifeline: a local socket main listens on and every server process connects to.
 * Nothing goes over it. When main ends, however it ends, the OS closes main's side, and the
 * server sees its connection close and exits (src/server/host.ts). Resolves to null if it
 * can't listen; the host then checks main's pid on a timer as before.
 */
export function lifeline(): Promise<string | null> {
  if (lifelineServer) return Promise.resolve(lifelineServer.path);
  const where = lifelinePath(process.platform, randomBytes(12).toString('hex'));
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('data', () => {});
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.once('error', () => resolve(null));
    server.listen(where, () => {
      lifelineServer = { server, path: where, sockets };
      app.once('will-quit', () => {
        server.close();
        if (process.platform === 'darwin') rmSync(where, { force: true });
      });
      resolve(where);
    });
  });
}

export interface ServerProcessOptions {
  hostScript: string;
  serverDir: string;
  env: Record<string, string>;
  /** Sent once the process is up; a promise lets it start before the secrets are read. */
  init: InitMessage | Promise<InitMessage>;
  logDir: string;
  /** Keeps the log of the run before a restart. */
  append?: boolean;
}

export interface ServerProcess {
  process: UtilityProcess;
  /** True once stop() was called: an exit after that is expected. */
  stopped(): boolean;
  /** The port takes requests. Page requests wait in the host until `ready`. */
  listening: Promise<void>;
  ready: Promise<{ systemCertificates: number; caError?: string }>;
  sendTrusted(origins: string[]): void;
  sendPrivacy(privacy: PrivacyMessage['privacy']): void;
  sendMainError(error: MainErrorMessage): void;
  sendPolicy(policy: InitMessage['policy']): void;
  stop(): void;
}

export class ServerStartError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ServerStartError';
  }
}

export function startServerProcess(options: ServerProcessOptions): ServerProcess {
  mkdirSync(options.logDir, { recursive: true });
  const log = createWriteStream(path.join(options.logDir, 'server.log'), { flags: options.append ? 'a' : 'w' });

  // The folder only, so the host can load Next before init comes; everything secret goes by message.
  const child = utilityProcess.fork(options.hostScript, [`--server-root=${options.serverDir}`], {
    serviceName: 'Bulwark mail service',
    // A real folder, whatever serverDir is: an asar can't be a working directory. host.ts
    // makes process.cwd() answer serverDir.
    cwd: options.logDir,
    env: options.env,
    stdio: 'pipe',
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  let listened: () => void = () => {};
  const listening = new Promise<void>((resolve) => {
    listened = resolve;
  });
  const ready = new Promise<{ systemCertificates: number; caError?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ServerStartError('The server did not report ready.')), READY_TIMEOUT_MS);
    child.on('message', (event: HostEvent) => {
      if (event.type === 'listening') {
        listened();
      } else if (event.type === 'ready') {
        listened();
        clearTimeout(timer);
        resolve({ systemCertificates: event.systemCertificates, caError: event.caError });
      } else if (event.type === 'fatal') {
        clearTimeout(timer);
        log.write(`fatal: ${event.error}\n`);
        reject(new ServerStartError(event.error, event.code));
      } else if (event.type === 'log') {
        log.write(`${event.level}: ${event.message}\n`);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new ServerStartError(`The server exited with code ${code}.`));
    });
  });

  child.once('spawn', () => void Promise.all([options.init, lifeline()]).then(([init, line]) => child.postMessage(line ? { ...init, lifeline: line } : init)).catch(() => {}));

  let stopped = false;
  const stop = () => {
    stopped = true;
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  };
  app.once('will-quit', stop);

  return {
    process: child,
    stopped: () => stopped,
    // Whatever ends the start before the port listens ends this too.
    listening: Promise.race([listening, ready.then(() => undefined)]),
    ready,
    sendTrusted: (origins) => child.postMessage({ type: 'trusted', origins }),
    sendPrivacy: (privacy) => child.postMessage({ type: 'privacy', privacy }),
    sendMainError: (error) => child.postMessage(error),
    sendPolicy: (policy) => child.postMessage({ type: 'policy', policy }),
    stop,
  };
}
