/**
 * Offering Bulwark as the mail app. On Windows that's HKCU only and needs no rights:
 * Capabilities and RegisteredApplications, written at each start of an installed app
 * so they follow an update's path. The choice stays with the user in Settings. macOS
 * and Linux can set the default directly.
 *
 * Values go through reg.exe: Electron has no registry call and this is no reason for a
 * native module. The installer's uninstall step removes the same keys.
 */

import { execFile } from 'node:child_process';
import { app, shell } from 'electron';
import type { OsDefaultAppStatus } from '../../shared/bridge';
import { systemExe } from '../system-exe';
import type { OsHub } from './os-hub';
import { needsRegistration, WINDOWS_APP_NAME, WINDOWS_URLS, windowsRegistration, windowsRegistrationKeys, type RegistryValue } from './os-rules';

export const DEFAULT_APP_SETTINGS_URL = `ms-settings:defaultapps?registeredAppUser=${WINDOWS_APP_NAME}`;

function reg(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(systemExe('reg.exe'), args, { windowsHide: true, timeout: 10_000 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout) }));
  });
}

async function writeValue(value: RegistryValue): Promise<boolean> {
  const args = ['add', `HKCU\\${value.key}`, '/f'];
  if (value.name === undefined) args.push('/ve');
  else args.push('/v', value.name);
  args.push('/t', 'REG_SZ', '/d', value.data);
  return (await reg(args)).ok;
}

export async function registerOnWindows(exe: string): Promise<boolean> {
  const results = await Promise.all(windowsRegistration(exe).map(writeValue));
  return results.every(Boolean);
}

export async function unregisterOnWindows(): Promise<void> {
  const { keys, values } = windowsRegistrationKeys();
  await Promise.all(keys.map((key) => reg(['delete', `HKCU\\${key}`, '/f'])));
  await Promise.all(values.map((value) => reg(['delete', `HKCU\\${value.key}`, '/v', value.name, '/f'])));
}

async function isChosenOnWindows(scheme: string): Promise<boolean> {
  const { ok, stdout } = await reg(['query', `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`, '/v', 'ProgId']);
  return ok && stdout.includes(WINDOWS_URLS[scheme]);
}

const LINUX_TYPES = ['x-scheme-handler/webcals', 'x-scheme-handler/mailto', 'x-scheme-handler/webcal', 'message/rfc822', 'text/calendar', 'text/vcard'];

function linuxMakeDefault(): Promise<void> {
  return new Promise((resolve) => {
    execFile('xdg-mime', ['default', 'bulwark.desktop', ...LINUX_TYPES], { timeout: 10_000 }, () => resolve());
  });
}

export interface DefaultAppHandle {
  status: () => Promise<OsDefaultAppStatus>;
  open: () => Promise<OsDefaultAppStatus>;
  register: () => Promise<boolean>;
  unregister: () => Promise<void>;
}

export function setupDefaultApp(hub: OsHub): DefaultAppHandle {
  const win32 = process.platform === 'win32';

  const status = async (): Promise<OsDefaultAppStatus> => {
    if (win32) {
      const [registered, mailto, webcal] = await Promise.all([
        reg(['query', 'HKCU\\Software\\RegisteredApplications', '/v', WINDOWS_APP_NAME]).then((result) => result.ok),
        isChosenOnWindows('mailto'),
        isChosenOnWindows('webcal'),
      ]);
      return { registered, mailto, webcal };
    }
    return { registered: true, mailto: app.isDefaultProtocolClient('mailto'), webcal: app.isDefaultProtocolClient('webcal') };
  };

  const register = () => registerOnWindows(process.execPath);

  const open = async (): Promise<OsDefaultAppStatus> => {
    if (win32) {
      await register();
      await shell.openExternal(DEFAULT_APP_SETTINGS_URL);
    } else {
      app.setAsDefaultProtocolClient('mailto');
      app.setAsDefaultProtocolClient('webcal');
      if (process.platform === 'linux') await linuxMakeDefault();
    }
    return status();
  };

  // Follows the path of an update, and comes back after an uninstall and a reinstall to the
  // same path, so this asks the registry rather than remember. A development run writes
  // nothing unless asked.
  if (win32 && app.isPackaged) {
    void reg(['query', 'HKCU\\Software\\Classes\\bulwark\\shell\\open\\command', '/ve']).then((query) => {
      if (needsRegistration(query, process.execPath)) void register();
    });
  }
  if (app.isPackaged && !win32) app.setAsDefaultProtocolClient('bulwark');

  return { status, open, register, unregister: unregisterOnWindows };
}
