/**
 * Windows only. safeStorage and Chromium's cookie store encrypt with one key, which Chromium
 * makes on a first start and keeps in `os_crypt.encrypted_key` of Local State, wrapped with
 * DPAPI. Local State reaches the disk only ten seconds later, or at a clean quit. A secret
 * written before that is lost in a crash along with the key, so nothing may be written under
 * the key until it's on disk.
 *
 * Chromium can also replace the key later: when DPAPI won't open it, or Local State is damaged,
 * it makes a new one and writes that over the old. So a copy of the wrapped key is kept next to
 * the secrets, written before the first of them, and put back before Chromium reads Local State.
 * The copy is as safe as the original: only DPAPI, for this user on this machine, opens it.
 *
 * macOS keeps the key in the Keychain and Linux in the secret service, which write at once, so
 * none of this runs there. No Electron here, so tests can load it.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** A run of the app that only gets the key onto the disk, by quitting cleanly. */
export const KEY_INIT_SWITCH = '--bulwark-init-key';

export const KEYS_FOLDER = 'keys';
const SAVED_KEY = 'os-crypt-key.saved';
/** The app lock's records. Its store keys are wrapped with safeStorage as well. */
const APP_LOCK_FOLDER = 'app-lock';

/** A file that's complete on disk once this returns, even if the power goes right after. */
export function durableWrite(file: string, data: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

function readLocalState(userData: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path.join(userData, 'Local State'), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The wrapped key as it is on disk: what a crash right now would leave. */
export function keyOnDisk(userData: string): string | null {
  const key = (readLocalState(userData)?.os_crypt as { encrypted_key?: unknown } | undefined)?.encrypted_key;
  return typeof key === 'string' && key ? key : null;
}

export function savedKey(userData: string): string | null {
  try {
    return readFileSync(path.join(userData, KEYS_FOLDER, SAVED_KEY), 'utf8') || null;
  } catch {
    return null;
  }
}

/** Keeps what's on disk now. Call it only with the key's secrets known to be readable. */
export function saveKey(userData: string): void {
  const key = keyOnDisk(userData);
  if (key) durableWrite(path.join(userData, KEYS_FOLDER, SAVED_KEY), key);
}

/** Anything encrypted with the key that a new key would make unreadable. */
export function holdsSecrets(userData: string): boolean {
  const list = (folder: string) => (existsSync(path.join(userData, folder)) ? readdirSync(path.join(userData, folder)) : []);
  return list(KEYS_FOLDER).some((name) => name.endsWith('.bin')) || list(APP_LOCK_FOLDER).length > 0;
}

function putKeyBack(userData: string, key: string): void {
  const state = readLocalState(userData) ?? {};
  // audit_enabled set: without it Chromium wraps the key anew, which reads as another key here.
  const osCrypt = { ...(state.os_crypt as object | undefined), encrypted_key: key, audit_enabled: true };
  durableWrite(path.join(userData, 'Local State'), JSON.stringify({ ...state, os_crypt: osCrypt }));
}

/**
 * Before Chromium reads Local State, which it does once this module has finished loading. Puts
 * back a key that's gone or was replaced, and otherwise gets a first key onto the disk, in a
 * run of its own (about 250 ms) rather than a wait for Chromium's ten seconds. If that run
 * fails, waitForKeyOnDisk still holds everything back.
 *
 * With no secrets, a replaced key stays: cookies are all that's under it, and if the old one
 * can't be opened any more, putting it back would lose them at every start.
 */
export function settleKeyBeforeChromium(userData: string, runKeyInit: () => void): void {
  const onDisk = keyOnDisk(userData);
  const saved = savedKey(userData);
  if (saved && saved !== onDisk && (!onDisk || holdsSecrets(userData))) {
    try {
      putKeyBack(userData, saved);
    } catch (error) {
      // The next start tries again. Until then the secrets can't be read, and the error page says so.
      console.error(error);
    }
    return;
  }
  if (!onDisk) runKeyInit();
}

/** Whether Local State holds the key. False after the wait means the disk isn't taking it. */
export async function waitForKeyOnDisk(userData: string, { timeoutMs = 30_000, intervalMs = 100 } = {}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!keyOnDisk(userData)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}
