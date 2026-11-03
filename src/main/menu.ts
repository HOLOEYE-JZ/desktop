/**
 * The app menu, deliberately small. It has what macOS needs for the edit shortcuts
 * to work at all, a way to quit, and nothing that reloads the page or opens the
 * developer tools (Electron's default menu has both). Step 6 replaces
 * `buildTemplate` with the full menu; `setCommandState` is already what the
 * webmail's bridge calls.
 */

import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { MenuState } from '../shared/bridge';
import { strings } from './strings';

export interface MenuHooks {
  /** Left out while a policy forces the connection. */
  switchMode?: () => void;
  devTools: boolean;
}

function buildTemplate(hooks: MenuHooks): MenuItemConstructorOptions[] {
  const text = strings();
  const mac = process.platform === 'darwin';
  return [
    ...(mac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: text.menuFile,
      submenu: [
        ...(hooks.switchMode
          ? ([{ label: text.menuSwitchMode, click: hooks.switchMode }, { type: 'separator' }] as MenuItemConstructorOptions[])
          : []),
        { role: 'close' },
        ...(mac ? [] : [{ role: 'quit' } as MenuItemConstructorOptions]),
      ],
    },
    {
      label: text.menuEdit,
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: text.menuWindow, role: 'windowMenu' },
    ...(hooks.devTools ? [{ label: 'Develop', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] } as MenuItemConstructorOptions] : []),
  ];
}

export function installMenu(hooks: MenuHooks): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(hooks)));
}

/** The last state each window reported. Step 6 applies it to the menu on focus. */
const stateByWindow = new WeakMap<BrowserWindow, MenuState>();

export function setCommandState(window: BrowserWindow, state: MenuState): void {
  stateByWindow.set(window, state);
}

export function commandState(window: BrowserWindow): MenuState | undefined {
  return stateByWindow.get(window);
}

