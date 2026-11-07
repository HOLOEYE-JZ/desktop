/**
 * The start of a server process as main sees it, without Electron, so the tests can drive it:
 * the init message goes out once the process is up and init and the lifeline are ready, and
 * the start's timeout counts from then. Reading the secrets (a keyring prompt, a first-run
 * wallet wizard) comes before init and takes as long as the user does.
 */

import type { HostEvent, InitMessage } from '../server/protocol';

export class ServerStartError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ServerStartError';
  }
}

/** What of a UtilityProcess the start needs. */
export interface StartingChild {
  on(event: 'message', listener: (event: HostEvent) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  once(event: 'spawn', listener: () => void): unknown;
  postMessage(message: unknown): void;
}

export interface StartWatchOptions {
  init: InitMessage | Promise<InitMessage>;
  /** The lifeline's path, or null without one. */
  lifeline: () => Promise<string | null>;
  timeoutMs: number;
  log: (line: string) => void;
}

export interface StartWatch {
  /** The port takes requests; rejects with `ready` if the start ends before that. Never unhandled. */
  listening: Promise<void>;
  ready: Promise<{ systemCertificates: number; caError?: string }>;
}

export function watchStart(child: StartingChild, options: StartWatchOptions): StartWatch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let listened: () => void = () => {};
  const listeningOnly = new Promise<void>((resolve) => {
    listened = resolve;
  });
  let fail: (error: Error) => void = () => {};
  const ready = new Promise<{ systemCertificates: number; caError?: string }>((resolve, reject) => {
    const end = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };
    fail = (error) => {
      end();
      reject(error);
    };
    child.on('message', (event: HostEvent) => {
      if (event.type === 'listening') {
        listened();
      } else if (event.type === 'ready') {
        listened();
        end();
        resolve({ systemCertificates: event.systemCertificates, caError: event.caError });
      } else if (event.type === 'fatal') {
        options.log(`fatal: ${event.error}\n`);
        fail(new ServerStartError(event.error, event.code));
      } else if (event.type === 'log') {
        options.log(`${event.level}: ${event.message}\n`);
      }
    });
    child.once('exit', (code) => fail(new ServerStartError(`The server exited with code ${code}.`)));
  });

  child.once('spawn', () => {
    void Promise.all([options.init, options.lifeline()])
      .then(([init, line]) => {
        if (settled) return;
        child.postMessage(line ? { ...init, lifeline: line } : init);
        timer = setTimeout(() => fail(new ServerStartError('The server did not report ready.')), options.timeoutMs);
      })
      .catch(() => {});
  });

  // Whatever ends the start before the port listens ends this too. Nobody may be waiting on it
  // when that happens (the error page waits on `ready`), and an unhandled rejection here would
  // be reported as an error of main's.
  const listening = Promise.race([listeningOnly, ready.then(() => undefined)]);
  listening.catch(() => {});
  return { listening, ready };
}
