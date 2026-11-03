/**
 * The native helper (native/), wrapped. If its .node file is missing or won't load,
 * every feature here says it's unavailable and nothing throws at start-up: a build
 * without Rust, a Linux box and a broken file all run the app, just without Hello and
 * the OS keystore. No Electron in this file, so plain Node tests reach all of it.
 *
 * Node-API is stable across Electron versions, so one build serves any of them.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

export interface NativeCertificate {
  id: string;
  certificate: Uint8Array;
  chain: Uint8Array[];
  subject: string;
  issuer: string;
  serial: string;
  notBefore: number;
  notAfter: number;
  usages: string[];
  extendedUsages: string[];
  algorithm: string;
  keyType: 'rsa' | 'ec';
  curve?: 'P-256' | 'P-384' | 'P-521';
  keyBits: number;
  source: 'software' | 'smartcard' | 'keychain' | 'unknown';
  signSchemes: string[];
  decryptSchemes: string[];
  canAgree: boolean;
}

export type HelloResult = 'verified' | 'cancelled' | 'busy' | 'unavailable' | 'timeout' | 'invalid' | 'failed';

export interface SignScheme {
  scheme: string;
  hash: string;
}

export interface DecryptScheme {
  scheme: string;
  hash?: string;
  label?: Uint8Array;
}

/** Every export of the helper. test/native.spec.ts holds the binary to this list. */
export interface NativeModule {
  helloAvailable(): Promise<boolean>;
  helloVerify(reason: string, hwnd: Buffer, timeoutMs: number): Promise<HelloResult>;
  keystoreList(): Promise<NativeCertificate[]>;
  keystoreSign(id: string, digest: Buffer, scheme: SignScheme, hwnd?: Buffer | null): Promise<Buffer>;
  keystoreDecrypt(id: string, data: Buffer, scheme: { scheme: string; hash?: string; label?: Buffer }, hwnd?: Buffer | null): Promise<Buffer>;
  keystoreAgree(id: string, peerPublicKey: Buffer, hwnd?: Buffer | null): Promise<Buffer>;
  policyIsForced(key: string): boolean;
}

export const KEYSTORE_ERRORS = ['keystore:cancelled', 'keystore:not-found', 'keystore:unsupported', 'keystore:locked', 'keystore:invalid', 'keystore:failed'] as const;
export type KeystoreErrorCode = (typeof KEYSTORE_ERRORS)[number];

/** A stuck card driver mustn't hold mail forever. Longer than anyone types a PIN. */
export const KEYSTORE_CAP_MS = 5 * 60_000;
export const HELLO_TIMEOUT_MS = 2 * 60_000;

const MAX_ID = 64;
const MAX_DIGEST = 64;
// A 16384-bit modulus, the most anything issues.
const MAX_CIPHERTEXT = 2048;
const MAX_LABEL = 256;
const MAX_PEER_KEY = 256;

export function helperFile(options: { packaged: boolean; mainDir: string; platform: string; arch: string }): string {
  const root = path.dirname(options.mainDir);
  // In app.asar, unpacked by electron-builder. Electron's loader follows the link.
  if (options.packaged) return path.join(root, 'native', 'bulwark-native.node');
  return path.join(root, 'native', 'dist', `${options.platform}-${options.arch}`, 'bulwark-native.node');
}

/** Null if it's not there or doesn't load. */
export function loadHelperModule(file: string, warn: (message: string) => void = console.warn): NativeModule | null {
  try {
    return createRequire(import.meta.url)(file) as NativeModule;
  } catch (error) {
    // Not there is an ordinary state for a build without Rust. Anything else is news.
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') warn(`The native helper didn't load: ${(error as Error).message}`);
    return null;
  }
}

export function keystoreErrorCode(error: unknown): KeystoreErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  const code = /keystore:[a-z-]+/.exec(message)?.[0];
  return KEYSTORE_ERRORS.find((known) => known === code) ?? 'keystore:failed';
}

/** Throws with only the code in the message: that's all a plugin frame ever gets. */
function rethrow(error: unknown, warn: (message: string) => void): never {
  const code = keystoreErrorCode(error);
  // An HRESULT or OSStatus, for a bug report. Never key material.
  if (code === 'keystore:failed') warn(`A keystore call failed: ${(error as Error)?.message ?? error}`);
  throw new Error(code);
}

function bytes(value: unknown, max: number): Buffer {
  const view = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (!(view instanceof Uint8Array) || view.byteLength > max) throw new Error('keystore:invalid');
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_ID) throw new Error('keystore:invalid');
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) throw new Error('keystore:invalid');
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('keystore:invalid');
  return value as Record<string, unknown>;
}

/**
 * Runs jobs one at a time, so one PIN dialog holds one libuv thread, and two dialogs
 * never stack up. A job that passes the cap rejects and the next one goes; its
 * thread stays with the driver, which can't be interrupted.
 */
export function serialQueue(capMs: number): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(
      () =>
        new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('keystore:failed the operation took too long')), capMs);
          job().then(resolve, reject).finally(() => clearTimeout(timer));
        }),
    );
    tail = run.catch(() => undefined);
    return run;
  };
}

export interface NativeHelper {
  hello: {
    available(): Promise<boolean>;
    /** A yes or no that gates the UI. It doesn't unlock a key. Always has a timeout. */
    verify(reason: string, windowHandle: Buffer, timeoutMs?: number): Promise<HelloResult>;
  };
  keystore: {
    /** Whether this build and system have an OS keystore to offer. */
    readonly available: boolean;
    list(): Promise<NativeCertificate[]>;
    sign(id: unknown, digest: unknown, scheme: unknown, windowHandle?: Buffer | null): Promise<Uint8Array>;
    decrypt(id: unknown, data: unknown, scheme: unknown, windowHandle?: Buffer | null): Promise<Uint8Array>;
    agree(id: unknown, peerPublicKey: unknown, windowHandle?: Buffer | null): Promise<Uint8Array>;
  };
  policy: {
    /** macOS: is this preference forced by a configuration profile? False elsewhere. */
    isForced(key: string): boolean;
  };
}

export function wrapHelper(
  native: NativeModule | null,
  options: { platform?: string; capMs?: number; warn?: (message: string) => void } = {},
): NativeHelper {
  const { platform = process.platform, capMs = KEYSTORE_CAP_MS, warn = console.warn } = options;
  const queue = serialQueue(capMs);
  const keyed = async <T>(run: (module: NativeModule) => Promise<T>): Promise<T> => {
    if (!native || !keystoreOffered) throw new Error('keystore:unsupported');
    try {
      return await run(native);
    } catch (error) {
      rethrow(error, warn);
    }
  };
  // The Linux keystore isn't in scope, and the helper's stubs would only ever say so.
  const keystoreOffered = platform === 'win32' || platform === 'darwin';

  return {
    hello: {
      available: async () => {
        if (!native) return false;
        try {
          return await native.helloAvailable();
        } catch {
          return false;
        }
      },
      verify: async (reason, windowHandle, timeoutMs = HELLO_TIMEOUT_MS) => {
        if (!native) return 'unavailable';
        try {
          return await native.helloVerify(reason, windowHandle, timeoutMs);
        } catch (error) {
          warn(`Hello: ${(error as Error).message}`);
          return 'failed';
        }
      },
    },
    keystore: {
      available: Boolean(native) && keystoreOffered,
      // Never prompts, so it doesn't wait behind a PIN dialog.
      list: () => keyed((module) => module.keystoreList()),
      sign: (id, digest, scheme, windowHandle) =>
        keyed((module) => {
          const name = identifier(id);
          const hash = bytes(digest, MAX_DIGEST);
          const asked = record(scheme);
          const plan = { scheme: text(asked.scheme), hash: text(asked.hash) };
          return queue(() => module.keystoreSign(name, hash, plan, windowHandle));
        }),
      decrypt: (id, data, scheme, windowHandle) =>
        keyed((module) => {
          const name = identifier(id);
          const input = bytes(data, MAX_CIPHERTEXT);
          const asked = record(scheme);
          const plan = {
            scheme: text(asked.scheme),
            hash: asked.hash === undefined ? undefined : text(asked.hash),
            label: asked.label === undefined ? undefined : bytes(asked.label, MAX_LABEL),
          };
          return queue(() => module.keystoreDecrypt(name, input, plan, windowHandle));
        }),
      agree: (id, peerPublicKey, windowHandle) =>
        keyed((module) => {
          const name = identifier(id);
          const peer = bytes(peerPublicKey, MAX_PEER_KEY);
          return queue(() => module.keystoreAgree(name, peer, windowHandle));
        }),
    },
    policy: {
      isForced: (key) => {
        if (!native) return false;
        try {
          return native.policyIsForced(key);
        } catch {
          return false;
        }
      },
    },
  };
}
