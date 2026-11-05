/**
 * Offering Bulwark as the mail app. On Windows that's HKCU only and needs no rights:
 * Capabilities and RegisteredApplications, written at each start of an installed app
 * so they follow an update's path. The choice stays with the user in Settings. macOS
 * and Linux can set the default directly.
 *
 * Also on Windows: "Open with" for documents and pictures, Bulwark under "Choose another
 * app" for any file, and "Bulwark (as attachment)" in Explorer's "Send to". Never the
 * default for those types. The OpenWithEnabled policy takes them away again. macOS and
 * Linux declare the same types in their packages (electron-builder.yml).
 *
 * Values go through reg.exe: Electron has no registry call and this is no reason for a
 * native module. The installer's uninstall step removes the same keys.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import type { OsDefaultAppStatus } from '../../shared/bridge';
import { systemExe } from '../system-exe';
import type { OsHub } from './os-hub';
import { effectivePolicyValue } from '../../shared/policy-schema';
import { policies } from './policies';
import {
  isOurSendToShortcut,
  needsOpenWithRegistration,
  needsRegistration,
  SEND_TO_NAME,
  sendToShortcut,
  sendToShortcutAction,
  WINDOWS_APP_NAME,
  WINDOWS_ATTACH_PROGID,
  WINDOWS_URLS,
  windowsOpenWithKeys,
  windowsOpenWithRegistration,
  windowsRegistration,
  windowsRegistrationKeys,
  type RegistryValue,
} from './os-rules';
import { osRegistrationAllowed } from '../installed';

// Set by build.mjs.
declare const __BULWARK_TEST_BUILD__: boolean;

export const DEFAULT_APP_SETTINGS_URL = `ms-settings:defaultapps?registeredAppUser=${WINDOWS_APP_NAME}`;

/** A test's own key to stand in for HKCU. A real build has no way to move it. */
function testRegistryRoot(): string | undefined {
  if (!__BULWARK_TEST_BUILD__) return undefined;
  return process.argv.find((arg) => arg.startsWith('--bulwark-test-registry-root='))?.split('=')[1];
}

const REGISTRY_ROOT = testRegistryRoot() ?? 'HKCU';

/**
 * Whether anything here may be written at all. An installed app, under HKCU. A development test
 * run only to its stand-in key. A test pack or a folder no installer put there never, not even
 * to a stand-in: a test that gives one sees it stay empty (test/pack-registration.spec.ts).
 */
export function mayRegister(): boolean {
  return osRegistrationAllowed() || (REGISTRY_ROOT !== 'HKCU' && !app.isPackaged);
}

/** The key that stands for HKCU here: HKCU itself, or a test's own. */
export function registryRoot(): string {
  return REGISTRY_ROOT;
}

/** A test's own folder in place of the user's SendTo folder, so no test touches the real menu. */
export function sendToFolder(): string | null {
  if (__BULWARK_TEST_BUILD__) {
    const own = process.argv.find((arg) => arg.startsWith('--bulwark-test-sendto-dir='))?.slice('--bulwark-test-sendto-dir='.length);
    if (own) return own;
    if (REGISTRY_ROOT !== 'HKCU') return null;
  }
  const roaming = process.env.APPDATA;
  return roaming ? path.join(roaming, 'Microsoft', 'Windows', 'SendTo') : null;
}

/** "Open with", "Choose another app" and "Send to": on unless a policy forces them off. */
export function openWithAllowed(): boolean {
  return effectivePolicyValue(policies.snapshot.OpenWithEnabled, undefined) !== false;
}

function reg(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(systemExe('reg.exe'), args, { windowsHide: true, timeout: 10_000 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout) }));
  });
}

async function writeValue(value: RegistryValue): Promise<boolean> {
  const args = ['add', `${REGISTRY_ROOT}\\${value.key}`, '/f'];
  if (value.name === undefined) args.push('/ve');
  else args.push('/v', value.name);
  args.push('/t', 'REG_SZ', '/d', value.data);
  return (await reg(args)).ok;
}

export async function registerOnWindows(exe: string): Promise<boolean> {
  if (!mayRegister()) return false;
  const results = await Promise.all(windowsRegistration(exe).map(writeValue));
  return results.every(Boolean);
}

function sendToLink(): string | null {
  const folder = sendToFolder();
  return folder ? path.join(folder, `${SEND_TO_NAME}.lnk`) : null;
}

/** The shortcut of our name: undefined for none, null for a file that isn't a readable shortcut. */
function readSendTo(link: string): Electron.ShortcutDetails | null | undefined {
  if (!existsSync(link)) return undefined;
  try {
    return shell.readShortcutLink(link);
  } catch {
    return null;
  }
}

/** The Send to shortcut, pointed at this exe where it's ours (sendToShortcutAction). */
function repairSendTo(exe: string, keysRewritten: boolean): boolean {
  const link = sendToLink();
  if (!link) return true;
  const found = readSendTo(link);
  // A file of that name we can't read isn't known to be ours.
  if (found === null) return true;
  const action = sendToShortcutAction(found ?? null, exe, keysRewritten);
  if (action === 'none') return true;
  mkdirSync(path.dirname(link), { recursive: true });
  return shell.writeShortcutLink(link, action, sendToShortcut(exe));
}

function removeOurSendTo(): void {
  const link = sendToLink();
  if (link && isOurSendToShortcut(readSendTo(link) ?? null)) rmSync(link, { force: true });
}

/** "Open with", "Choose another app" and the Send to shortcut, for this exe. */
export async function registerOpenWithOnWindows(exe: string): Promise<boolean> {
  if (!mayRegister()) return false;
  const results = await Promise.all(windowsOpenWithRegistration(exe).map(writeValue));
  return results.every(Boolean) && repairSendTo(exe, true);
}

/** Only what's ours: our class in each type's list, our own keys, our shortcut. */
export async function unregisterOpenWithOnWindows(exe: string): Promise<void> {
  if (!mayRegister()) return;
  const { keys, values } = windowsOpenWithKeys(path.win32.basename(exe));
  await Promise.all(keys.map((key) => reg(['delete', `${REGISTRY_ROOT}\\${key}`, '/f'])));
  await Promise.all(values.map((value) => reg(['delete', `${REGISTRY_ROOT}\\${value.key}`, '/v', value.name, '/f'])));
  removeOurSendTo();
}

export async function unregisterOnWindows(): Promise<void> {
  if (!mayRegister()) return;
  const { keys, values } = windowsRegistrationKeys(path.win32.basename(process.execPath));
  await Promise.all(keys.map((key) => reg(['delete', `${REGISTRY_ROOT}\\${key}`, '/f'])));
  await Promise.all(values.map((value) => reg(['delete', `${REGISTRY_ROOT}\\${value.key}`, '/v', value.name, '/f'])));
}

async function isChosenOnWindows(scheme: string): Promise<boolean> {
  const { ok, stdout } = await reg(['query', `${REGISTRY_ROOT}\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`, '/v', 'ProgId']);
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
  /** Once what the start (or a policy change) writes is written. For tests. */
  settled: () => Promise<void>;
}

export function setupDefaultApp(hub: OsHub): DefaultAppHandle {
  const win32 = process.platform === 'win32';

  const status = async (): Promise<OsDefaultAppStatus> => {
    if (win32) {
      const [registered, mailto, webcal] = await Promise.all([
        reg(['query', `${REGISTRY_ROOT}\\Software\\RegisteredApplications`, '/v', WINDOWS_APP_NAME]).then((result) => result.ok),
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
    } else if (mayRegister()) {
      app.setAsDefaultProtocolClient('mailto');
      app.setAsDefaultProtocolClient('webcal');
      if (process.platform === 'linux') await linuxMakeDefault();
    }
    return status();
  };

  let applying = Promise.resolve();
  // Follows the path of an update, and comes back after an uninstall and a reinstall to the
  // same path, so this asks the registry rather than remember. A development run writes only
  // to a test's own key, and a test pack nothing (mayRegister).
  if (win32 && mayRegister()) {
    const exe = process.execPath;
    // Its own check, so an update that brings it writes it, and the policy can take it back.
    // `keysRewritten`: the mail keys were missing or named another exe just now.
    const applyOpenWith = async (keysRewritten: boolean) => {
      const query = await reg(['query', `${REGISTRY_ROOT}\\Software\\Classes\\${WINDOWS_ATTACH_PROGID}\\shell\\open\\command`, '/ve']);
      if (!openWithAllowed()) {
        if (query.ok) await unregisterOpenWithOnWindows(exe);
        else removeOurSendTo();
        return;
      }
      // Written when the keys are missing or name another exe: a first start, an update to a new
      // path, another copy's registration (an installer writes these keys before the app starts).
      // Our Send to shortcut is pointed at this exe at every start; one the user deleted while the
      // keys stayed isn't put back.
      if (needsOpenWithRegistration(query, exe)) await registerOpenWithOnWindows(exe);
      else repairSendTo(exe, keysRewritten);
    };
    const first = async () => {
      const query = await reg(['query', `${REGISTRY_ROOT}\\Software\\Classes\\bulwark\\shell\\open\\command`, '/ve']);
      const rewrite = needsRegistration(query, exe);
      if (rewrite) await register();
      await applyOpenWith(rewrite);
    };
    applying = first().catch(() => {});
    policies.on('changed', (now, before) => {
      if (now.OpenWithEnabled.value === before.OpenWithEnabled.value) return;
      const again = () => applyOpenWith(false);
      applying = applying.then(again, again).catch(() => {});
    });
  }
  if (osRegistrationAllowed() && !win32) app.setAsDefaultProtocolClient('bulwark');

  return { status, open, register, unregister: unregisterOnWindows, settled: () => applying };
}
