/**
 * The decisions of features/dev-tools.ts with nothing of Electron in them, so plain tests can
 * load them.
 */

import type { Input } from 'electron';

/**
 * The policy's 2 locks them off. Chrome's 0 and 1 allow them. A forced value nobody could read
 * comes through as a locked null: that's off too.
 */
export function devToolsForcedOffBy(entry: { value: number | null; locked: boolean }): boolean {
  return entry.locked && entry.value !== 0 && entry.value !== 1;
}

/** Ctrl+Shift+I, F12, and Cmd+Option+I on a Mac. Only a key going down. */
export function isDevToolsKey(input: Pick<Input, 'type' | 'key' | 'code' | 'control' | 'meta' | 'shift' | 'alt'>, platform: string = process.platform): boolean {
  if (input.type !== 'keyDown') return false;
  if (input.key === 'F12' && !input.control && !input.meta && !input.shift && !input.alt) return true;
  const isI = input.code === 'KeyI' || input.key.toLowerCase() === 'i';
  if (!isI) return false;
  if (platform === 'darwin') return input.meta && input.alt && !input.control && !input.shift;
  return input.control && input.shift && !input.alt && !input.meta;
}

/** Whether the keys open them now. */
export function devToolsUsable(state: { stored: boolean; forcedOff: boolean; locked: boolean }): boolean {
  return state.stored && !state.forcedOff && !state.locked;
}
