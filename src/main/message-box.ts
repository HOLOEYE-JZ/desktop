/**
 * The shell's questions and notices as Bulwark dialog windows, in place of Electron's
 * dialog.showMessageBox: the same options and the same result, drawn by the shell's own
 * page (dialog-window.ts), so they work before and without the webmail's server and over
 * the lock screen. In the app's language and theme: the theme the page last reported,
 * the OS's light or dark until then.
 *
 * Native only before Electron is ready, when no window can be made (a failed start).
 */

import { app, dialog, nativeTheme, type BrowserWindow, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron';
import { dialogWindows } from './dialog-window';
import { boxResult, planMessageBox, type BoxLook } from './message-box-rules';
import { strings, uiLanguageNow } from './strings';

declare const __BULWARK_TEST_BUILD__: boolean;

/**
 * Test builds only: a test that answers prompts itself (it replaces dialog.showMessageBox,
 * as test/support/answer-prompts.cjs and fakeOsIntegration do) sets this, and gets the
 * call there. Nobody could click a window on a test's hidden desktop.
 */
function testAnswersPrompts(): boolean {
  return __BULWARK_TEST_BUILD__ && (globalThis as { __bulwarkNativePrompts?: boolean }).__bulwarkNativePrompts === true;
}

type Look = () => Omit<BoxLook, 'ok' | 'language'> & { language?: string };

let look: Look = () => ({ dark: nativeTheme.shouldUseDarkColors });

/** Where the look comes from once the theme is known (index.ts). */
export function useMessageBoxLook(source: Look): void {
  look = source;
}

function currentLook(): BoxLook {
  const now = look();
  return { ...now, language: now.language ?? uiLanguageNow(), ok: strings().ok };
}

export function showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
export function showMessageBox(parent: BrowserWindow | null | undefined, options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
export async function showMessageBox(first: BrowserWindow | MessageBoxOptions | null | undefined, second?: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const parent = second ? (first as BrowserWindow | null | undefined) ?? null : null;
  const options = (second ?? first) as MessageBoxOptions;
  // No window can be made yet: the OS's box is all there is.
  if (!app.isReady() || testAnswersPrompts()) return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  const plan = planMessageBox(options, currentLook());
  const answer = await dialogWindows().askShell(parent, plan.request, options.signal);
  return boxResult(plan, answer);
}
