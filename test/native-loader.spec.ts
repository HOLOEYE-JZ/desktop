import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { helperFile, keystoreErrorCode, loadHelperModule, serialQueue, wrapHelper, type NativeModule } from '../src/main/native-loader';

/** The wrapper: what the app gets when the helper is absent, broken or slow. */

const quiet = () => undefined;

function fakeModule(overrides: Partial<NativeModule> = {}): NativeModule {
  return {
    helloAvailable: async () => true,
    helloVerify: async () => 'verified',
    keystoreList: async () => [],
    keystoreSign: async () => Buffer.from([1]),
    keystoreDecrypt: async () => Buffer.from([2]),
    keystoreAgree: async () => Buffer.from([3]),
    policyIsForced: () => true,
    ...overrides,
  };
}

test.describe('finding the file', () => {
  test('unpackaged it is under native/dist, per platform and architecture', () => {
    const file = helperFile({ packaged: false, mainDir: path.join('root', 'dist'), platform: 'win32', arch: 'arm64' });
    expect(file).toBe(path.join('root', 'native', 'dist', 'win32-arm64', 'bulwark-native.node'));
  });

  test('packaged it sits beside dist, where electron-builder.yml puts it', () => {
    const file = helperFile({ packaged: true, mainDir: path.join('app.asar', 'dist'), platform: 'win32', arch: 'x64' });
    expect(file).toBe(path.join('app.asar', 'native', 'bulwark-native.node'));
  });
});

test.describe('a helper that will not load', () => {
  test('a missing file is an ordinary state: null, and nothing said', () => {
    const warnings: string[] = [];
    expect(loadHelperModule(path.join(tmpdir(), 'no-such-helper-here.node'), (message) => warnings.push(message))).toBeNull();
    expect(warnings).toEqual([]);
  });

  test('a broken file is null too, and it says why', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-native-'));
    const file = path.join(dir, 'broken.node');
    writeFileSync(file, 'this is not a library');
    const warnings: string[] = [];
    try {
      expect(loadHelperModule(file, (message) => warnings.push(message))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("didn't load");
  });

  test('every feature reports unavailable, and none throws', async () => {
    const helper = wrapHelper(null, { warn: quiet });
    expect(await helper.hello.available()).toBe(false);
    expect(await helper.hello.verify('reason', Buffer.alloc(8))).toBe('unavailable');
    expect(helper.keystore.available).toBe(false);
    await expect(helper.keystore.list()).rejects.toThrow(/^keystore:unsupported$/);
    await expect(helper.keystore.sign('a', Buffer.alloc(32), { scheme: 'rsa-pkcs1', hash: 'SHA-256' })).rejects.toThrow(/^keystore:unsupported$/);
    await expect(helper.keystore.decrypt('a', Buffer.alloc(256), { scheme: 'rsa-pkcs1' })).rejects.toThrow(/^keystore:unsupported$/);
    await expect(helper.keystore.agree('a', Buffer.alloc(91))).rejects.toThrow(/^keystore:unsupported$/);
    expect(helper.policy.isForced('Key')).toBe(false);
  });

  test('Hello and policy that throw inside report no, not an exception', async () => {
    const helper = wrapHelper(fakeModule({
      helloAvailable: () => Promise.reject(new Error('boom')),
      helloVerify: () => { throw new Error('hello: timeout out of range'); },
      policyIsForced: () => { throw new Error('policy: bad key'); },
    }), { warn: quiet });
    expect(await helper.hello.available()).toBe(false);
    expect(await helper.hello.verify('reason', Buffer.alloc(8))).toBe('failed');
    expect(helper.policy.isForced('a key')).toBe(false);
  });
});

test.describe('where the keystore is offered', () => {
  for (const [platform, offered] of [['win32', true], ['darwin', true], ['linux', false]] as const) {
    test(`${platform}: ${offered}`, async () => {
      const helper = wrapHelper(fakeModule(), { platform, warn: quiet });
      expect(helper.keystore.available).toBe(offered);
      if (!offered) await expect(helper.keystore.list()).rejects.toThrow(/^keystore:unsupported$/);
    });
  }
});

test.describe('what the wrapper lets through', () => {
  const helper = (module: Partial<NativeModule> = {}, warn: (message: string) => void = quiet) => wrapHelper(fakeModule(module), { platform: 'win32', warn });

  test('wrong types stop here and never reach the binary', async () => {
    let reached = 0;
    const count = async () => {
      reached += 1;
      return Buffer.alloc(1);
    };
    const { keystore } = helper({ keystoreSign: count, keystoreDecrypt: count, keystoreAgree: count });
    const scheme = { scheme: 'rsa-pkcs1', hash: 'SHA-256' };
    const refused: Array<() => Promise<unknown>> = [
      () => keystore.sign(42, Buffer.alloc(32), scheme),
      () => keystore.sign('', Buffer.alloc(32), scheme),
      () => keystore.sign('x'.repeat(65), Buffer.alloc(32), scheme),
      () => keystore.sign('id', 'text', scheme),
      () => keystore.sign('id', [1, 2, 3], scheme),
      () => keystore.sign('id', Buffer.alloc(65), scheme),
      () => keystore.sign('id', Buffer.alloc(32), null),
      () => keystore.sign('id', Buffer.alloc(32), { scheme: 1, hash: 'SHA-256' }),
      () => keystore.decrypt('id', Buffer.alloc(2049), { scheme: 'rsa-pkcs1' }),
      () => keystore.decrypt('id', Buffer.alloc(256), { scheme: 'rsa-oaep', hash: 'SHA-1', label: 'text' }),
      () => keystore.decrypt('id', Buffer.alloc(256), { scheme: 'rsa-oaep', hash: 'SHA-1', label: Buffer.alloc(257) }),
      () => keystore.agree('id', Buffer.alloc(257)),
    ];
    for (const call of refused) await expect(call()).rejects.toThrow(/^keystore:invalid$/);
    expect(reached).toBe(0);
  });

  test('a plain Uint8Array and an ArrayBuffer arrive as a Buffer, as IPC sends them', async () => {
    const seen: unknown[] = [];
    const { keystore } = helper({
      keystoreSign: async (_id, digest) => {
        seen.push(digest);
        return Buffer.alloc(1);
      },
    });
    await keystore.sign('id', new Uint8Array([1, 2]), { scheme: 'ecdsa', hash: 'SHA-256' });
    await keystore.sign('id', new Uint8Array([3, 4]).buffer, { scheme: 'ecdsa', hash: 'SHA-256' });
    expect(seen.every((value) => Buffer.isBuffer(value))).toBe(true);
    expect((seen as Buffer[]).map((value) => [...value])).toEqual([[1, 2], [3, 4]]);
  });

  test('only the fields it knows go on, and the window handle goes with them', async () => {
    let plan: unknown;
    let handle: unknown;
    const { keystore } = helper({
      keystoreDecrypt: async (_id, _data, scheme, hwnd) => {
        plan = scheme;
        handle = hwnd;
        return Buffer.alloc(1);
      },
    });
    const window = Buffer.alloc(8, 1);
    await keystore.decrypt('id', Buffer.alloc(256), { scheme: 'rsa-oaep', hash: 'SHA-1', extra: 'x' }, window);
    expect(plan).toEqual({ scheme: 'rsa-oaep', hash: 'SHA-1', label: undefined });
    expect(handle).toBe(window);
  });

  test('errors come out as the code alone, with the detail in the log', async () => {
    const warnings: string[] = [];
    const failing = helper({ keystoreSign: () => Promise.reject(new Error('keystore:failed 0x80090016')) }, (message) => warnings.push(message));
    await expect(failing.keystore.sign('id', Buffer.alloc(32), { scheme: 'ecdsa', hash: 'SHA-256' })).rejects.toThrow(/^keystore:failed$/);
    expect(warnings.join()).toContain('0x80090016');
    const cancelled = helper({ keystoreSign: () => { throw new Error('keystore:cancelled'); } });
    await expect(cancelled.keystore.sign('id', Buffer.alloc(32), { scheme: 'ecdsa', hash: 'SHA-256' })).rejects.toThrow(/^keystore:cancelled$/);
  });

  test('anything without a known code is keystore:failed', () => {
    expect(keystoreErrorCode(new Error('keystore:locked'))).toBe('keystore:locked');
    expect(keystoreErrorCode(new Error('keystore:invalid digest length'))).toBe('keystore:invalid');
    expect(keystoreErrorCode(new Error('Error: keystore:made-up'))).toBe('keystore:failed');
    expect(keystoreErrorCode(new Error('C:\\path'))).toBe('keystore:failed');
    expect(keystoreErrorCode('text')).toBe('keystore:failed');
  });

  test('a list does not wait behind a PIN dialog', async () => {
    let answerPin: (value: Buffer) => void = quiet;
    const { keystore } = helper({ keystoreSign: () => new Promise((resolve) => { answerPin = resolve; }) });
    const signing = keystore.sign('id', Buffer.alloc(32), { scheme: 'ecdsa', hash: 'SHA-256' });
    await expect(keystore.list()).resolves.toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    answerPin(Buffer.from([9]));
    await expect(signing).resolves.toEqual(Buffer.from([9]));
  });
});

test.describe('one key operation at a time', () => {
  const later = () => {
    let resolve: (value: string) => void = quiet;
    let reject: (error: Error) => void = quiet;
    const promise = new Promise<string>((good, bad) => {
      resolve = good;
      reject = bad;
    });
    return { promise, resolve, reject };
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  test('the second waits for the first, so two PIN dialogs never stack up', async () => {
    const queue = serialQueue(60_000);
    const first = later();
    const started: string[] = [];
    const a = queue(() => {
      started.push('a');
      return first.promise;
    });
    const b = queue(async () => {
      started.push('b');
      return 'b';
    });
    await tick();
    expect(started).toEqual(['a']);
    first.resolve('a');
    await expect(a).resolves.toBe('a');
    await expect(b).resolves.toBe('b');
    expect(started).toEqual(['a', 'b']);
  });

  test('a failure does not stop the queue', async () => {
    const queue = serialQueue(60_000);
    const failed = queue(() => Promise.reject(new Error('keystore:cancelled')));
    const next = queue(async () => 'next');
    await expect(failed).rejects.toThrow('keystore:cancelled');
    await expect(next).resolves.toBe('next');
  });

  test('past the cap it fails and the next one goes, and the wait behind it does not count', async () => {
    const queue = serialQueue(30);
    const stuck = queue(() => new Promise<string>(() => undefined));
    const next = queue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'next';
    });
    await expect(stuck).rejects.toThrow(/keystore:failed/);
    await expect(next).resolves.toBe('next');
  });
});
