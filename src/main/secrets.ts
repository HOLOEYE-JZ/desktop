/**
 * Secrets at rest under userData, encrypted with safeStorage (DPAPI on Windows,
 * Keychain on macOS, the secret service on Linux).
 *
 * The session secret is the one that must never be replaced silently: the
 * webmail's cookies are sealed with it, and a new one signs every account out
 * and wipes its offline data. So when an existing file can't be decrypted, `get`
 * throws, and the app shows an error page rather than generate another.
 *
 * On Linux with no secret service, safeStorage's `basic_text` backend only obfuscates, with a key
 * every copy of Chromium knows. Chromium goes on working that way, and so does this: the app would
 * otherwise not start there. It isn't silent: main logs it, and the page's settings say it, through
 * the `wrap` of the app lock's status.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { durableWrite } from './key-on-disk';

let warnedObfuscated = false;

export class SecretStoreError extends Error {
  constructor(
    message: string,
    readonly code: 'unavailable' | 'undecryptable' | 'missing',
  ) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export class SecretStore {
  constructor(private readonly dir: string) {}

  private file(name: string): string {
    return path.join(this.dir, `${name}.bin`);
  }

  private async assertAvailable(): Promise<void> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new SecretStoreError('The system key store is not available.', 'unavailable');
    }
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text' && !warnedObfuscated) {
      warnedObfuscated = true;
      console.warn('No secret service here: secrets under the profile are only obfuscated.');
    }
  }

  /** Whether one is stored, with nothing decrypted: on macOS reading can ask the user. */
  has(name: string): boolean {
    return existsSync(this.file(name));
  }

  /** Null when there's none yet. Throws when there is one and it can't be read. */
  async get(name: string): Promise<string | null> {
    if (!existsSync(this.file(name))) return null;
    await this.assertAvailable();
    try {
      const { result } = await safeStorage.decryptStringAsync(readFileSync(this.file(name)));
      return result;
    } catch {
      throw new SecretStoreError(`The stored ${name} can't be decrypted.`, 'undecryptable');
    }
  }

  async set(name: string, value: string): Promise<void> {
    await this.assertAvailable();
    durableWrite(this.file(name), await safeStorage.encryptStringAsync(value));
  }

  /**
   * The value, or a new one if there's none. Throws rather than replace one it can't
   * read, and rather than make one on a profile that must already have had it.
   */
  async getOrCreate(name: string, make: () => string, { mustExist = false } = {}): Promise<string> {
    const existing = await this.get(name);
    if (existing !== null) return existing;
    if (mustExist) throw new SecretStoreError(`The stored ${name} is missing.`, 'missing');
    const value = make();
    await this.set(name, value);
    return value;
  }

  /** Whether all that's stored can be read. True with nothing stored. */
  async allReadable(): Promise<boolean> {
    const names = existsSync(this.dir) ? readdirSync(this.dir).filter((file) => file.endsWith('.bin')) : [];
    for (const file of names) {
      try {
        if ((await this.get(file.slice(0, -'.bin'.length))) === null) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * The value, or a new one if there's none or it can't be read. For secrets whose loss costs
   * nothing. `beforeNew` undoes what went with the old one, first, so a crash can't leave the new
   * one with the old one's leftovers.
   */
  async getOrReplace(name: string, make: () => string, beforeNew?: () => void): Promise<{ value: string; created: boolean }> {
    try {
      const existing = await this.get(name);
      if (existing !== null) return { value: existing, created: false };
    } catch (error) {
      if (error instanceof SecretStoreError && error.code === 'unavailable') throw error;
      rmSync(this.file(name), { force: true });
    }
    beforeNew?.();
    const value = make();
    await this.set(name, value);
    return { value, created: true };
  }
}
