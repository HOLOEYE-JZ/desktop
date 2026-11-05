/**
 * Test builds only: Hello key credentials made up in memory, so the checks in test/ run the
 * whole app lock without a real prompt and without touching anyone's Hello container. The
 * environment variable says how the next prompt goes, read at each call so a test can change it:
 * `yes`, `cancel`, or `pss` (the key signs with PSS, which a real Hello key doesn't).
 * `BULWARK_TEST_HELLO_KEY_LOG` names a file each delete is written to, for a check that outlives
 * the process, as a wipe does.
 */

import { constants, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { HelloKeyAnswer } from './native-loader';
import type { HelloKeys } from './app-lock-hello';

export function fakeHelloKeys(mode: () => string | undefined): HelloKeys & { names(): string[] } {
  const made = new Map<string, KeyObject>();
  const signWith = (key: KeyObject, data: Uint8Array): Buffer => (mode() === 'pss'
    ? sign('sha256', data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 })
    : sign('sha256', data, { key, padding: constants.RSA_PKCS1_PADDING }));
  return {
    async create(name, data): Promise<HelloKeyAnswer> {
      if (mode() === 'cancel') return { result: 'cancelled' };
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      made.set(name, pair.privateKey);
      return { result: 'ok', publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }), signature: signWith(pair.privateKey, data) };
    },
    async open(name) {
      return made.has(name) ? 'ok' : 'missing';
    },
    async sign(name, data): Promise<HelloKeyAnswer> {
      if (mode() === 'cancel') return { result: 'cancelled' };
      const key = made.get(name);
      if (!key) return { result: 'missing' };
      return { result: 'ok', signature: signWith(key, data) };
    },
    async delete(name) {
      if (process.env.BULWARK_TEST_HELLO_KEY_LOG) appendFileSync(process.env.BULWARK_TEST_HELLO_KEY_LOG, `${name}\n`);
      return made.delete(name) ? 'ok' : 'missing';
    },
    cancel() {},
    names: () => [...made.keys()],
  };
}
