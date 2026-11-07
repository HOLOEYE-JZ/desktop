/**
 * A sweep that only runs while it has something to do. `work` does one round and says whether
 * anything is left for the next one; when nothing is, the timer stops, and an idle app doesn't
 * wake up for it. Whatever can leave work behind (a page's files call, a clean that failed)
 * calls `arm()`, which starts it again if it isn't running.
 */
export class IdleSweep {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly options: {
      everyMs: number;
      work: () => boolean;
      setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
      clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
    },
  ) {}

  arm(): void {
    if (this.timer || this.stopped) return;
    const every = this.options.setInterval ?? setInterval;
    this.timer = every(() => {
      if (!this.options.work()) this.pause();
    }, this.options.everyMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** For good, at quit. */
  stop(): void {
    this.stopped = true;
    this.pause();
  }

  private pause(): void {
    if (!this.timer) return;
    (this.options.clearInterval ?? clearInterval)(this.timer);
    this.timer = null;
  }
}
