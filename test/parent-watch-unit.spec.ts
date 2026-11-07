import { EventEmitter } from 'node:events';
import { expect, test } from '@playwright/test';
import { PARENT_CHECK_MS, PARENT_PID_SWITCH, ParentWatch, switchValue, type ParentWatchDeps } from '../src/server/parent-watch';

/** Hand-driven timers, a pid that lives until told otherwise, and a lifeline the test connects. */
function fakes() {
  const state = { alive: true, exited: 0, interval: null as null | (() => void), intervalMs: 0, socket: null as EventEmitter | null };
  const deps: ParentWatchDeps = {
    alive: () => state.alive,
    exit: () => {
      state.exited += 1;
    },
    connect: () => {
      const socket = Object.assign(new EventEmitter(), { unref: () => socket });
      state.socket = socket;
      return socket;
    },
    setInterval: (fn, ms) => {
      state.interval = fn;
      state.intervalMs = ms;
      return {};
    },
    clearInterval: () => {
      state.interval = null;
    },
  };
  return { state, deps };
}

test('a server started before its init message ends when main is gone, with no lifeline yet', () => {
  const { state, deps } = fakes();
  const watch = new ParentWatch(deps);
  // What host.ts does with --parent-pid= as it starts, before init names the lifeline.
  watch.watchPid(Number(switchValue(['node', 'host.js', '--server-root=/x', `${PARENT_PID_SWITCH}4242`], PARENT_PID_SWITCH)));
  expect(state.intervalMs).toBe(PARENT_CHECK_MS);
  state.interval!();
  expect(state.exited).toBe(0);
  // Main crashed during a keyring prompt.
  state.alive = false;
  state.interval!();
  expect(state.exited).toBe(1);
});

test('once the lifeline is connected the pid check stops, and its close ends the process', () => {
  const { state, deps } = fakes();
  const watch = new ParentWatch(deps);
  watch.watchPid(4242);
  watch.watchPid(4242);
  watch.useLifeline('/run/lifeline');
  expect(watch.polling).toBe(true);
  state.socket!.emit('connect');
  expect(watch.polling).toBe(false);
  expect(state.interval).toBeNull();
  state.socket!.emit('close');
  expect(state.exited).toBe(1);
});

test('a lifeline that never connects leaves the pid check running', () => {
  const { state, deps } = fakes();
  const watch = new ParentWatch(deps);
  watch.watchPid(4242);
  watch.useLifeline('/run/lifeline');
  state.socket!.emit('error', new Error('ENOENT'));
  state.socket!.emit('close');
  expect(state.exited).toBe(0);
  expect(watch.polling).toBe(true);
  state.alive = false;
  state.interval!();
  expect(state.exited).toBe(1);
});

test('no usable pid on the command line starts nothing', () => {
  const { state, deps } = fakes();
  const watch = new ParentWatch(deps);
  watch.watchPid(Number(switchValue(['node', 'host.js'], PARENT_PID_SWITCH)));
  expect(state.interval).toBeNull();
});
