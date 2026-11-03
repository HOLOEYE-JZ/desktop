/**
 * Runs one request in the import worker and always comes back: with the answer, or at the
 * timeout with the process killed and what it had said so far.
 */

import { utilityProcess } from 'electron';
import type { WorkerMessage, WorkerRequest, WorkerScan } from './import-worker';

const SERVICE_NAME = 'Bulwark import reader';
/** All that's on this computer has been read: a network path gets this long, not the whole timeout. */
const NETWORK_GRACE_MS = 15_000;

export type WorkerOutcome =
  | { done: true; message: Exclude<WorkerMessage, { type: 'partial' }> }
  | { done: false; partial: WorkerScan | null };

/** What the worker needs from the environment: not the secrets main's has. */
function workerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function runImportWorker(script: string, request: WorkerRequest, timeoutMs: number): Promise<WorkerOutcome> {
  return new Promise((resolve) => {
    let partial: WorkerScan | null = null;
    let settled = false;
    const child = utilityProcess.fork(script, [], { serviceName: SERVICE_NAME, env: workerEnv(), stdio: 'ignore' });
    const finish = (outcome: WorkerOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(outcome);
    };
    let timer = setTimeout(() => finish({ done: false, partial }), timeoutMs);
    child.on('message', (message: WorkerMessage) => {
      if (message.type !== 'partial') {
        finish({ done: true, message });
        return;
      }
      partial = message.scan;
      if (message.onlyNetworkLeft) {
        clearTimeout(timer);
        timer = setTimeout(() => finish({ done: false, partial }), NETWORK_GRACE_MS);
      }
    });
    child.once('exit', () => finish({ done: false, partial }));
    child.once('spawn', () => child.postMessage(request));
  });
}
