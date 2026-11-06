/**
 * Files on the Windows clipboard as Explorer copies them, through the native helper. A test build
 * can put its own writer in `globalThis.__bulwarkClipboardWriter`: the clipboard is the whole
 * session's, and a test must never change the one of the person at the computer.
 */

import { native } from './native';

declare const __BULWARK_TEST_BUILD__: boolean;

type Writer = (paths: string[]) => Promise<boolean>;

export function writeFilesToClipboard(paths: string[]): Promise<boolean> {
  if (__BULWARK_TEST_BUILD__) {
    const own = (globalThis as unknown as { __bulwarkClipboardWriter?: Writer }).__bulwarkClipboardWriter;
    if (own) return own(paths);
  }
  return native().system.clipboardWriteFiles(paths);
}
