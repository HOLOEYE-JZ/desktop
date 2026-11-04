import { EventEmitter } from 'node:events';
import { expect, test } from '@playwright/test';
import type { WebContents } from 'electron';
import { takeUserGesture, watchUserGestures } from '../src/main/user-gesture';

/** What counts as the user doing something, as main sees the input reach a window. */

function contents() {
  const emitter = new EventEmitter();
  watchUserGestures(emitter as unknown as WebContents);
  const input = (value: Record<string, unknown>) => emitter.emit('input-event', {}, value);
  return { input, take: () => takeUserGesture(emitter as unknown as WebContents) };
}

test('a left click, Enter and Space count, once each', () => {
  const page = contents();
  page.input({ type: 'mouseDown', button: 'left' });
  expect(page.take()).toBe(true);
  expect(page.take()).toBe(false);
  page.input({ type: 'rawKeyDown', keyCode: 'Enter' });
  expect(page.take()).toBe(true);
  page.input({ type: 'rawKeyDown', keyCode: 'Space' });
  expect(page.take()).toBe(true);
});

test('the keys that pick in a closed list count too, so a drive letter can be chosen without the mouse (files-p3-15)', () => {
  const page = contents();
  for (const key of ['Down', 'Up', 'Home', 'End', 'PageDown']) {
    page.input({ type: 'rawKeyDown', keyCode: key });
    expect(page.take()).toBe(true);
  }
});

test('typing, a right click and a key let go do not', () => {
  const page = contents();
  page.input({ type: 'rawKeyDown', keyCode: 'A' });
  page.input({ type: 'mouseDown', button: 'right' });
  page.input({ type: 'keyUp', keyCode: 'Enter' });
  expect(page.take()).toBe(false);
});
