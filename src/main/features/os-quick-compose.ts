/**
 * Quick compose: a small composer window from anywhere, with a global shortcut, the tray,
 * the jump list, the dock and the File menu. It's an ordinary pop-out, so saving, sending
 * and coming back after a quit are the composer's own (lib/popout in the webmail).
 *
 * The shortcut comes from the `QuickComposeShortcut` policy and the user's choice
 * (`quickComposeShortcut` in os-rules.ts). Another app can hold it, which only shows when
 * registering fails: the settings page says so, and every time a window of ours gets the
 * focus it's tried again, since that app may have gone.
 *
 * Nothing opens while the app is locked or nobody is signed in: a pop-out would have no
 * session to borrow, and locked it must show nothing. The main window comes up, where
 * the lock screen or the sign-in is, and the composer follows if that's done soon.
 */

import { app, globalShortcut, type MenuItemConstructorOptions } from 'electron';
import type { QuickComposeStatus } from '../../shared/bridge';
import { strings } from '../strings';
import { policies } from './policies';
import type { OsHub } from './os-hub';
import { quickComposeBuiltIn, quickComposeShortcut } from './os-rules';

// Set by build.mjs: true only with --test.
declare const __BULWARK_TEST_BUILD__: boolean;

/** One window: pressing it again goes back to what's being written there. */
const WINDOW_KEY = 'quick-compose';
/** Unlocking or signing in later than this is about something else by now. */
const WAIT_LIMIT_MS = 2 * 60_000;

/**
 * A test run mustn't take the real keys from whoever is at this computer: it holds what
 * it names, or nothing.
 */
function builtInShortcut(): string | null {
  if (__BULWARK_TEST_BUILD__) {
    const named = process.argv.find((arg) => arg.startsWith('--bulwark-test-quick-compose-default='));
    return named ? named.slice(named.indexOf('=') + 1) : null;
  }
  return quickComposeBuiltIn(process.platform, app.getSystemLocale());
}

export interface QuickComposeHandle {
  /** What the shortcut, the tray and the rest call. */
  open: () => void;
  apply: () => void;
  status: () => QuickComposeStatus;
}

export function setupQuickCompose(hub: OsHub): QuickComposeHandle {
  const { ctx } = hub;
  const { windows } = ctx;
  const builtIn = builtInShortcut();
  let held: string | null = null;
  let signedIn = false;
  let waitingSince: number | null = null;

  const ready = () => signedIn && !hub.locked && !!windows.mainWindow();

  const openWindow = () => {
    windows.open({ type: 'composer', url: `${ctx.origin}/popout/compose`, key: WINDOW_KEY, boundsKey: 'quickComposer' });
  };

  const open = () => {
    if (ready()) {
      waitingSince = null;
      openWindow();
      return;
    }
    waitingSince = Date.now();
    ctx.showMain();
  };

  const openIfWaiting = () => {
    if (waitingSince === null || !ready()) return;
    const inTime = Date.now() - waitingSince < WAIT_LIMIT_MS;
    waitingSince = null;
    if (inTime) openWindow();
  };

  const wanted = () => {
    const policy = policies.snapshot.QuickComposeShortcut;
    return quickComposeShortcut(policy, hub.settings().quickComposeShortcut, builtIn);
  };

  const status = (): QuickComposeStatus => {
    const shortcut = wanted();
    return { shortcut, active: !!shortcut && held === shortcut, locked: policies.snapshot.QuickComposeShortcut.locked, builtIn };
  };

  const apply = () => {
    const next = wanted();
    if (held && held !== next) {
      globalShortcut.unregister(held);
      held = null;
    }
    if (!next || held === next) return;
    try {
      // False: someone else holds it. The settings page says so.
      if (globalShortcut.register(next, open)) held = next;
    } catch (error) {
      console.warn('Shortcut refused:', error);
    }
  };

  const applyAndTell = () => {
    apply();
    const next = status();
    if (JSON.stringify(next) === JSON.stringify(hub.quickComposeStatus)) return;
    hub.quickComposeStatus = next;
    hub.announce();
    ctx.menu.rebuild();
  };

  hub.quickCompose = open;

  hub.on('settings', (_settings, changed) => {
    if ('quickComposeShortcut' in changed) applyAndTell();
  });
  policies.on('changed', applyAndTell);
  // The app holding it may have gone, and Windows doesn't say so.
  app.on('browser-window-focus', () => {
    if (wanted() && !held) applyAndTell();
  });

  windows.on('sessionReady', () => {
    signedIn = true;
    openIfWaiting();
  });
  windows.on('sessionEnded', () => {
    signedIn = false;
  });
  windows.on('closed', (managed) => {
    // A new main window says again when it has a session.
    if (managed.type === 'main' && !windows.mainWindow()) signedIn = false;
  });
  hub.on('locked', openIfWaiting);

  ctx.menu.extend('new', (): MenuItemConstructorOptions[] => {
    const shortcut = wanted();
    return [{
      id: 'file.quickCompose',
      label: strings().menuQuickCompose,
      // Shown, not registered: the global one has it already, or someone else does.
      ...(shortcut && held === shortcut ? { accelerator: shortcut, registerAccelerator: false } : {}),
      click: open,
    }];
  });

  applyAndTell();
  return { open, apply, status };
}
