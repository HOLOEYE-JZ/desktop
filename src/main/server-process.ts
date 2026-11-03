/**
 * Starts the embedded server in a utilityProcess and waits until it listens.
 * The process has an allowlisted env and doesn't inherit ours. It dies with the
 * app: Chromium kills its utility processes on exit, and we kill it on will-quit.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import type { HostEvent, InitMessage } from '../server/protocol';

const READY_TIMEOUT_MS = 90_000;

export interface ServerProcessOptions {
  hostScript: string;
  serverDir: string;
  env: Record<string, string>;
  init: InitMessage;
  logDir: string;
  /** Keeps the log of the run before a restart. */
  append?: boolean;
}

export interface ServerProcess {
  process: UtilityProcess;
  /** True once stop() was called: an exit after that is expected. */
  stopped(): boolean;
  ready: Promise<{ systemCertificates: number; caError?: string }>;
  sendTrusted(origins: string[]): void;
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

  const child = utilityProcess.fork(options.hostScript, [], {
    serviceName: 'Bulwark mail service',
    // A real folder, whatever serverDir is: an asar can't be a working directory. host.ts
    // makes process.cwd() answer serverDir.
    cwd: options.logDir,
    env: options.env,
    stdio: 'pipe',
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  const ready = new Promise<{ systemCertificates: number; caError?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ServerStartError('The server did not report ready.')), READY_TIMEOUT_MS);
    child.on('message', (event: HostEvent) => {
      if (event.type === 'ready') {
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

  child.once('spawn', () => child.postMessage(options.init));

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
    ready,
    sendTrusted: (origins) => child.postMessage({ type: 'trusted', origins }),
    sendPolicy: (policy) => child.postMessage({ type: 'policy', policy }),
    stop,
  };
}
