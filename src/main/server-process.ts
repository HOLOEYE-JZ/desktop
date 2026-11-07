/**
 * Starts the embedded server in a utilityProcess and waits until it listens.
 * The process has an allowlisted env and doesn't inherit ours. It dies with the
 * app: Chromium kills its utility processes on exit, and we kill it on will-quit.
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import type { InitMessage, MainErrorMessage, PrivacyMessage } from '../server/protocol';
import { isFileSocket, LifelineGate, lifelinePath, removeStaleLifelines, serveLifeline } from '../server/lifeline';
import { PARENT_PID_SWITCH, SERVER_ROOT_SWITCH } from '../server/parent-watch';
import { ServerStartError, watchStart } from './server-start-watch';

export { ServerStartError };

/** From the init message on: reading the secrets before it can take as long as the user does. */
const READY_TIMEOUT_MS = 90_000;

/** One connection per server process spawned (src/server/lifeline.ts). */
const lifelineGate = new LifelineGate();
let lifelinePending: Promise<string | null> | null = null;

/**
 * The servers' lifeline: a local socket main listens on and every server process connects to.
 * Nothing goes over it. When main ends, however it ends, the OS closes main's side, and the
 * server sees its connection close and exits (src/server/parent-watch.ts). Resolves to null if
 * it can't listen; the host then checks main's pid on a timer.
 */
export function lifeline(): Promise<string | null> {
  lifelinePending ??= openLifeline();
  return lifelinePending;
}

async function openLifeline(): Promise<string | null> {
  const where = lifelinePath(process.platform, randomBytes(12).toString('hex'));
  // A socket file left by a run that crashed: gone, if nothing answers on it.
  if (isFileSocket(where)) await removeStaleLifelines(path.dirname(where)).catch(() => {});
  const server = await serveLifeline(where, lifelineGate);
  if (!server) return null;
  app.once('will-quit', () => {
    server.close();
    if (isFileSocket(where)) rmSync(where, { force: true });
  });
  return where;
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

export function startServerProcess(options: ServerProcessOptions): ServerProcess {
  mkdirSync(options.logDir, { recursive: true });
  const log = createWriteStream(path.join(options.logDir, 'server.log'), { flags: options.append ? 'a' : 'w' });

  // The folder and main's pid only, so the host can load Next and watch main before init
  // comes; everything secret goes by message.
  const child = utilityProcess.fork(options.hostScript, [`${SERVER_ROOT_SWITCH}${options.serverDir}`, `${PARENT_PID_SWITCH}${process.pid}`], {
    serviceName: 'Bulwark mail service',
    // A real folder, whatever serverDir is: an asar can't be a working directory. host.ts
    // makes process.cwd() answer serverDir.
    cwd: options.logDir,
    env: options.env,
    stdio: 'pipe',
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  lifelineGate.grant();
  const { listening, ready } = watchStart(child, {
    init: options.init,
    lifeline,
    timeoutMs: READY_TIMEOUT_MS,
    log: (line) => log.write(line),
  });

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
    listening,
    ready,
    sendTrusted: (origins) => child.postMessage({ type: 'trusted', origins }),
    sendPrivacy: (privacy) => child.postMessage({ type: 'privacy', privacy }),
    sendMainError: (error) => child.postMessage(error),
    sendPolicy: (policy) => child.postMessage({ type: 'policy', policy }),
    stop,
  };
}
