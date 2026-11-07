import { expect, test } from '@playwright/test';
import { IdleSweep } from '../src/main/files/idle-sweep';

/** A hand-driven timer: `tick()` runs whatever interval is set. */
function fakeTimers() {
  let fn: (() => void) | null = null;
  let sets = 0;
  return {
    setInterval: (f: () => void) => {
      fn = f;
      sets += 1;
      return sets as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      fn = null;
    },
    tick: () => fn?.(),
    get armed() {
      return fn !== null;
    },
    get sets() {
      return sets;
    },
  };
}

test('the sweep runs while there is work left, stops when there is none, and starts again when armed', () => {
  const timers = fakeTimers();
  let left = 2;
  const rounds: number[] = [];
  const sweep = new IdleSweep({ everyMs: 60_000, work: () => (rounds.push(left), --left > 0), ...timers });

  sweep.arm();
  sweep.arm();
  expect(timers.sets).toBe(1);
  timers.tick();
  expect(timers.armed).toBe(true);
  timers.tick();
  // Nothing left: no timer, so an idle app isn't woken for it.
  expect(timers.armed).toBe(false);
  expect(sweep.running).toBe(false);
  expect(rounds).toEqual([2, 1]);

  left = 1;
  sweep.arm();
  expect(timers.armed).toBe(true);
  timers.tick();
  expect(timers.armed).toBe(false);

  sweep.stop();
  sweep.arm();
  expect(timers.armed).toBe(false);
});
