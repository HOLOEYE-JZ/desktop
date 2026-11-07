import { EventEmitter } from 'node:events';
import { expect, test } from '@playwright/test';
import type { InitMessage } from '../src/server/protocol';
import { watchStart, type StartingChild } from '../src/main/server-start-watch';

/** A utility process that spawns at once and says what the test tells it to. */
class FakeChild extends EventEmitter implements StartingChild {
  posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const INIT = { type: 'init', parentPid: 1 } as unknown as InitMessage;

function started(init: Promise<InitMessage> | InitMessage, timeoutMs: number) {
  const child = new FakeChild();
  const watch = watchStart(child, { init, lifeline: async () => '/run/lifeline', timeoutMs, log: () => {} });
  child.emit('spawn');
  return { child, watch };
}

test('the start timeout counts from the init message, not while the secrets are read', async () => {
  let give: (init: InitMessage) => void = () => {};
  // A keyring prompt the user takes longer to answer than the whole start may take.
  const { child, watch } = started(new Promise<InitMessage>((resolve) => (give = resolve)), 100);
  let failed: unknown = null;
  watch.ready.catch((error) => (failed = error));
  await sleep(250);
  expect(failed).toBeNull();
  expect(child.posted).toHaveLength(0);

  give(INIT);
  await sleep(20);
  expect(child.posted).toEqual([{ ...INIT, lifeline: '/run/lifeline' }]);
  child.emit('message', { type: 'ready', systemCertificates: 3 });
  expect(await watch.ready).toEqual({ systemCertificates: 3, caError: undefined });
  expect(failed).toBeNull();
});

test('a server that never reports ready after its init still fails the start', async () => {
  const { watch } = started(INIT, 100);
  const at = Date.now();
  await expect(watch.ready).rejects.toThrow('did not report ready');
  expect(Date.now() - at).toBeGreaterThanOrEqual(90);
});

test('a start that ends before the port listens leaves no unhandled rejection behind', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { child, watch } = started(INIT, 5000);
    // Only `ready` is waited on, as the error page does; nobody waits on `listening`.
    const ready = watch.ready.catch((error: Error) => error.message);
    child.emit('exit', 1);
    expect(await ready).toBe('The server exited with code 1.');
    await sleep(50);
    expect(unhandled).toEqual([]);
    await expect(watch.listening).rejects.toThrow('exited with code 1');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
