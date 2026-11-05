/**
 * Start at login, as a setting. macOS and Windows have Electron's login item; Linux gets
 * the autostart .desktop file every desktop reads.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import type { OsHub } from './os-hub';
import { linuxAutostartEntry, LOGIN_FLAG } from './os-rules';
import { osRegistrationAllowed } from '../installed';

// A development run can't overwrite an installed app's entry, and is easy to find.
export const DEV_LOGIN_ITEM_NAME = 'Bulwark Dev';

function loginItemName(): string {
  return osRegistrationAllowed() ? 'Bulwark' : DEV_LOGIN_ITEM_NAME;
}

function autostartFile(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'autostart', 'bulwark.desktop');
}

function launchArgs(): string[] {
  return process.defaultApp ? [app.getAppPath(), LOGIN_FLAG] : [LOGIN_FLAG];
}

export function applyLoginItem(openAtLogin: boolean): void {
  // A package no installer put there (a test pack, an unpacked folder) never starts at login:
  // the entry would outlive the folder. A development run keeps its own, named apart.
  if (app.isPackaged && !osRegistrationAllowed()) return;
  if (process.platform === 'linux') {
    const file = autostartFile();
    if (!openAtLogin) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    // An AppImage's mount point is gone next boot; APPIMAGE is the file itself.
    writeFileSync(file, linuxAutostartEntry(process.env.APPIMAGE || process.execPath));
    return;
  }
  app.setLoginItemSettings({
    openAtLogin,
    name: loginItemName(),
    ...(process.platform === 'win32' ? { path: process.execPath, args: launchArgs() } : {}),
  });
}

export function readLoginItem(): { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean } {
  const settings = app.getLoginItemSettings(process.platform === 'win32' ? { path: process.execPath, args: launchArgs() } : {});
  // Windows names the entry, and Electron only looks under its own default name.
  const named = process.platform === 'win32' && settings.launchItems.some((item) => item.name === loginItemName() && item.enabled);
  return { openAtLogin: settings.openAtLogin || named, executableWillLaunchAtLogin: settings.executableWillLaunchAtLogin };
}

export function setupLogin(hub: OsHub): void {
  // An uninstall took the entry, or an update moved the path: an installed app puts it back.
  if (osRegistrationAllowed() && hub.settings().startAtLogin) applyLoginItem(true);
  hub.on('settings', (settings, changed) => {
    if ('startAtLogin' in changed) applyLoginItem(settings.startAtLogin);
  });
}
