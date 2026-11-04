/**
 * The first-run window's menu: only what works there. The app's menu (menu.ts) is for a
 * mail window, and its Settings… or New message would do nothing with no page behind them.
 *
 * It's the application menu while the welcome window is up, on every platform: on macOS
 * that's the only kind there is, and elsewhere it's the welcome window's own, since it's
 * the only window then. Put back on focus, in case the app's menu was rebuilt meanwhile,
 * and the app's menu comes back when the window goes.
 */

import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { strings } from './strings';

export function welcomeMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const text = strings();
  const mac = platform === 'darwin';
  const edit: MenuItemConstructorOptions = {
    id: 'welcome.edit',
    label: text.menuEdit,
    submenu: [
      { role: 'undo', label: text.menuUndo },
      { role: 'redo', label: text.menuRedo },
      { type: 'separator' },
      { role: 'cut', label: text.menuCut },
      { role: 'copy', label: text.menuCopy },
      { role: 'paste', label: text.menuPaste },
      { role: 'selectAll', label: text.menuSelectAll },
    ],
  };
  if (mac) {
    return [{ id: 'welcome.app', label: app.name, submenu: [{ role: 'about', label: text.menuAbout }, { type: 'separator' }, { role: 'quit' }] }, edit];
  }
  const win = platform === 'win32';
  return [
    // Windows calls it Exit and leaves it to Alt+F4, as the app's own File menu does.
    { id: 'welcome.file', label: text.menuFile, submenu: [{ role: 'quit', label: win ? text.menuExit : text.menuQuit, ...(win ? {} : { accelerator: 'Ctrl+Q' }) }] },
    edit,
    { id: 'welcome.help', label: text.menuHelp, submenu: [{ role: 'about', label: text.menuAbout }] },
  ];
}

export function useWelcomeMenu(window: BrowserWindow, restore: () => void): void {
  const menu = Menu.buildFromTemplate(welcomeMenuTemplate(process.platform));
  const apply = () => {
    if (!window.isDestroyed() && Menu.getApplicationMenu() !== menu) Menu.setApplicationMenu(menu);
  };
  apply();
  window.on('focus', apply);
  window.once('closed', () => {
    if (Menu.getApplicationMenu() === menu) restore();
  });
}
