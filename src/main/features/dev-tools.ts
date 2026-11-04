/**
 * Chromium's developer tools, for troubleshooting. Off by default. When the user turns them on in
 * Settings, Ctrl+Shift+I and F12 (Cmd+Option+I on a Mac) open them for the window that has the
 * keys, and the View menu gets "Toggle developer tools".
 *
 * Anyone at the keyboard can then read everything the app holds, so the switch lives here and
 * not in the page: turning it on takes a real click (user-gesture.ts) and a native warning in
 * main's own words (devtools-strings.ts), which no page or plugin can reword. Turning it off
 * needs neither. The app lock turns it off and refuses it while locked. The policy
 * `DeveloperToolsAvailability`, with Chrome's values, forces it off with 2.
 *
 * Windows are made with devtools allowed unless the policy says no, so the switch works at once
 * in windows already open. Nothing in a page can open them: the only ways are the keys and the
 * menu item below, and a devtools window that opens any other way is closed again.
 */

import { BrowserWindow, dialog, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { CHANNEL, type DevToolsState } from '../../shared/bridge';
import { appLockGate } from '../app-lock-gate';
import { devToolsTextFor } from '../devtools-strings';
import { strings, uiLanguageNow } from '../strings';
import { takeUserGesture, watchUserGestures } from '../user-gesture';
import { policies } from './policies';
import { devToolsForcedOffBy, devToolsUsable, isDevToolsKey } from './dev-tools-rules';
import type { Feature, FeatureContext } from '.';

// Set by build.mjs.
declare const __BULWARK_TEST_BUILD__: boolean;

/** The policy as it stands. */
export function devToolsForcedOff(): boolean {
  return devToolsForcedOffBy(policies.snapshot.DeveloperToolsAvailability);
}

/** Development runs with --dev keep their own Develop menu, and nothing here gets in its way. */
function devRun(): boolean {
  return __BULWARK_TEST_BUILD__ && process.argv.includes('--dev');
}

function setup(ctx: FeatureContext): void {
  const stored = () => ctx.state.data.devTools === true;
  const view = (): DevToolsState => {
    const forcedOff = devToolsForcedOff();
    return { on: stored() && !forcedOff, forcedOff, locked: appLockGate.locked };
  };
  const usable = () => devRun() || devToolsUsable({ stored: stored(), forcedOff: devToolsForcedOff(), locked: appLockGate.locked });

  const openWindows = () => BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  const closeAll = () => {
    for (const window of openWindows()) {
      if (window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
    }
  };
  const tell = () => {
    const state = view();
    for (const window of openWindows()) window.webContents.send(CHANNEL.devToolsChanged, state);
    ctx.menu.rebuild();
  };
  const store = (on: boolean) => {
    if (stored() === on) return;
    ctx.state.data.devTools = on;
    ctx.state.save();
  };
  const turnOff = () => {
    store(false);
    if (!devRun()) closeAll();
    tell();
  };

  const toggleFor = (contents: WebContents) => {
    if (!usable()) return;
    if (contents.isDevToolsOpened()) contents.closeDevTools();
    else contents.openDevTools({ mode: 'detach' });
  };

  const watch = (contents: WebContents) => {
    watchUserGestures(contents);
    contents.on('before-input-event', (event, input) => {
      if (!isDevToolsKey(input) || !usable()) return;
      event.preventDefault();
      toggleFor(contents);
    });
    // However they came up, they don't stay where the switch says no.
    contents.on('devtools-opened', () => {
      if (!usable()) contents.closeDevTools();
    });
  };
  ctx.windows.on('created', ({ window }) => watch(window.webContents));

  ctx.menu.extend('view', (): MenuItemConstructorOptions[] => {
    if (!usable() || devRun()) return [];
    return [
      { type: 'separator' },
      {
        id: 'view.toggleDevTools',
        label: strings().menuToggleDevTools,
        // Shown, and handled in before-input-event, which also covers F12 and runs ahead of the page.
        accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
        registerAccelerator: false,
        click: () => {
          const window = BrowserWindow.getFocusedWindow();
          if (window) toggleFor(window.webContents);
        },
      },
    ];
  });

  ctx.handle(CHANNEL.devToolsGet, () => view());
  ctx.handle(CHANNEL.devToolsSet, async (event, window, on) => {
    if (on !== true) {
      turnOff();
      return view();
    }
    // A page can't say yes for the user: no click, a lock, or the policy, and nothing changes.
    if (!takeUserGesture(event.sender) || appLockGate.locked || devToolsForcedOff() || stored()) return view();
    const text = devToolsTextFor(uiLanguageNow());
    const options = {
      type: 'warning' as const,
      buttons: [text.turnOn, text.cancel],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: text.title,
      message: text.title,
      detail: text.detail,
    };
    const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    // The answer counts only if nothing changed while the question was up.
    if (response === 0 && !appLockGate.locked && !devToolsForcedOff()) {
      store(true);
      tell();
    }
    return view();
  });

  appLockGate.on('locked', (locked) => {
    if (locked) turnOff();
    else tell();
  });
  policies.on('changed', () => {
    if (devToolsForcedOff() && !devRun()) closeAll();
    tell();
  });
}

export const devToolsFeature: Feature = {
  name: 'dev-tools',
  modes: ['standalone', 'instance'],
  setup,
};
