/**
 * Errors in the main process, on their way to lib/error-reporting. With the embedded server
 * they go there and the webmail scrubs them. Without one, main counts them itself and sends
 * names and counts only (buildDesktopErrorBatch). Node only, so a test can load it.
 */

import { createHash } from 'node:crypto';
import { DESKTOP_VERSION_SUFFIX, type DesktopMainError } from '../shared/desktop-telemetry';

/** The same rule the collector has. Anything else is just `Error`. */
const ERROR_NAME = /^[A-Za-z_$][\w$]{0,63}$/;
const MAX_DISTINCT_PER_DAY = 50;

export function mainErrorName(error: unknown): string {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' && ERROR_NAME.test(name) ? name : 'Error';
}

export function fingerprintOfMainError(name: string, stack: string, version: string): string {
  // Lines and columns only: the rest of a stack can hold paths and a message.
  const positions = stack.split('\n').filter((line) => /^\s*at /.test(line)).map((line) => /:(\d+:\d+)\)?\s*$/.exec(line)?.[1] ?? '').slice(0, 5);
  return createHash('sha256').update(JSON.stringify([name, version, positions])).digest('hex').slice(0, 16);
}

/** What main found and hasn't been able to send yet, per UTC day. */
export class MainErrorCounter {
  private day = '';
  private errors = new Map<string, DesktopMainError & { sentCount: number }>();

  constructor(private readonly appVersion: string) {}

  note(error: unknown, now = Date.now()): void {
    this.rollOver(now);
    const stack = String((error as { stack?: unknown } | null | undefined)?.stack ?? '');
    const name = mainErrorName(error);
    const version = `${this.appVersion}${DESKTOP_VERSION_SUFFIX}`;
    const fingerprint = fingerprintOfMainError(name, stack, version);
    const known = this.errors.get(fingerprint);
    if (known) known.count += 1;
    else if (this.errors.size < MAX_DISTINCT_PER_DAY) this.errors.set(fingerprint, { name, fingerprint, version, count: 1, sentCount: 0 });
  }

  /** Errors new or counted again since `markSent`. */
  unsent(now = Date.now()): DesktopMainError[] {
    this.rollOver(now);
    return [...this.errors.values()].filter((error) => error.count !== error.sentCount).map(({ sentCount: _sent, ...error }) => error);
  }

  markSent(sent: readonly DesktopMainError[]): void {
    for (const { fingerprint, count } of sent) {
      const known = this.errors.get(fingerprint);
      if (known) known.sentCount = count;
    }
  }

  clear(): void {
    this.errors.clear();
  }

  private rollOver(now: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day === this.day) return;
    this.day = day;
    this.errors.clear();
  }
}
