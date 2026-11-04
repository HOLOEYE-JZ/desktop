/**
 * Whether the user just did something, in a way no script can say for them, and used up once.
 * What a page's own `navigator.userActivation` can't give: it stays active for 5 seconds
 * after a click, so one click would let a same-origin plugin frame start twenty things, and
 * it's gone when someone takes longer than that over a native menu.
 *
 * A left mouse button or Enter or Space reaching a window, as Chromium's browser process
 * sees it, and a pick from a native menu, which main itself recorded. Taking it spends it.
 * The keys that choose in a closed list (arrows, Home, End, Page Up and Down) count too: a
 * drive letter picked with them changes the list without Enter (pass-3 files-p3-15).
 */

import type { WebContents } from 'electron';

/** About what Chromium gives a click, and past the longest a click handler should need. */
const GESTURE_LIFE_MS = 5_000;

const gestures = new WeakMap<WebContents, number>();
/** Enter, Space, and the keys that choose in a list. Chromium's names, and the DOM's. */
const GESTURE_KEYS = new Set(['Enter', 'Return', 'Space', ' ', 'Up', 'Down', 'ArrowUp', 'ArrowDown', 'Left', 'Right', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Prior', 'Next']);
const watched = new WeakSet<WebContents>();

export function noteUserGesture(contents: WebContents): void {
  gestures.set(contents, Date.now());
}

export function takeUserGesture(contents: WebContents): boolean {
  const at = gestures.get(contents);
  gestures.delete(contents);
  return at !== undefined && Date.now() - at <= GESTURE_LIFE_MS;
}

export function watchUserGestures(contents: WebContents): void {
  if (watched.has(contents)) return;
  watched.add(contents);
  contents.on('input-event', (_event, input) => {
    const button = (input as unknown as { button?: string }).button;
    const key = (input as unknown as { keyCode?: string }).keyCode;
    const clicked = input.type === 'mouseDown' && button === 'left';
    const pressed = input.type === 'rawKeyDown' && !!key && GESTURE_KEYS.has(key);
    if (clicked || pressed) noteUserGesture(contents);
  });
}
