import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { AppLockGate } from '../src/main/app-lock-gate';
import { launchStandalone, removeProfile, tempProfile, fakeOsIntegration, prompts } from './helpers';

const proof = (seed: number) => new Uint8Array(32).fill(seed);

test.describe('the gate, in plain Node', () => {
  let dir: string;
  let file: string;
  test.beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bulwark-gate-'));
    file = path.join(dir, 'gate.json');
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('is locked until it knows, and then only if a lock exists', () => {
    const gate = new AppLockGate();
    expect(gate.locked).toBe(true);
    gate.init(file);
    expect(gate.locked).toBe(false);
    expect(gate.enrolled).toBe(false);
  });

  test('a start with a lock set up is locked, and so is a file it can\'t read', () => {
    const first = new AppLockGate();
    first.init(file);
    expect(first.enroll(proof(1))).toBe(true);
    const second = new AppLockGate();
    second.init(file);
    expect(second.locked).toBe(true);
    writeFileSync(file, '{not json');
    const third = new AppLockGate();
    third.init(file);
    expect(third.locked).toBe(true);
  });

  test('nothing but the right proof lifts it', () => {
    const gate = new AppLockGate();
    gate.init(file);
    gate.enroll(proof(1));
    gate.lock();
    for (const wrong of [proof(2), new Uint8Array(31).fill(1), 'unlocked', true, null, undefined, {}]) {
      expect(gate.prove(wrong)).toBe(false);
      expect(gate.locked).toBe(true);
    }
    expect(gate.prove(proof(1))).toBe(true);
    expect(gate.locked).toBe(false);
  });

  test('a page can\'t replace the proof and then prove its own', () => {
    const gate = new AppLockGate();
    gate.init(file);
    gate.enroll(proof(1));
    gate.lock();
    expect(gate.enroll(proof(9))).toBe(false);
    expect(gate.prove(proof(9))).toBe(false);
    expect(gate.locked).toBe(true);
  });

  test('keeps a hash, never the proof', () => {
    const gate = new AppLockGate();
    gate.init(file);
    gate.enroll(proof(7));
    const stored = readFileSync(file, 'utf8');
    expect(stored).toContain(createHash('sha256').update(proof(7)).digest('hex'));
    expect(stored).not.toContain(Buffer.from(proof(7)).toString('hex'));
    expect(stored).not.toContain(Buffer.from(proof(7)).toString('base64'));
  });
});

type LockBridge = {
  status(): Promise<{ locked: boolean; enrolled: boolean; os: string | null; osEnrolled: boolean }>;
  lock(): void;
  enroll(p: Uint8Array): Promise<boolean>;
  prove(p: Uint8Array): Promise<boolean>;
  disable(p: Uint8Array): Promise<boolean>;
  forget(p?: Uint8Array): Promise<boolean>;
  osEnroll(p: Uint8Array, key: Uint8Array): Promise<boolean>;
  osUnlock(): Promise<{ ok: boolean; reason?: string; key?: number[] }>;
};

function call<T>(page: Page, method: keyof LockBridge, ...seeds: number[]): Promise<T> {
  return page.evaluate(async ({ method: name, seeds: list }) => {
    type Member = Record<string, (...args: unknown[]) => Promise<unknown>>;
    const bridge = (window as unknown as { bulwarkDesktop: { appLock: Member } }).bulwarkDesktop.appLock;
    // As the page does at its first render: these two are handed out once.
    const held = window as unknown as { __controls?: Member };
    held.__controls ??= (bridge as unknown as { claim(): Member }).claim();
    const target = name === 'lock' || name === 'osUnlock' ? held.__controls : bridge;
    const out = await target[name](...list.map((seed) => new Uint8Array(32).fill(seed)));
    return out && typeof out === 'object' && 'key' in out
      ? { ...out, key: Array.from((out as { key: Uint8Array }).key) }
      : out;
  }, { method, seeds }) as Promise<T>;
}

async function run(verify: 'yes' | 'no', body: (app: ElectronApplication, page: Page) => Promise<void>): Promise<void> {
  const profile = tempProfile('app-lock');
  process.env.BULWARK_TEST_OS_VERIFY = verify;
  const launched = await launchStandalone(profile);
  try {
    await body(launched.app, launched.page);
  } finally {
    delete process.env.BULWARK_TEST_OS_VERIFY;
    await launched.app.close().catch(() => undefined);
    removeProfile(profile);
  }
}

const gateLocked = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { gate: { locked: boolean } } }).__bulwarkAppLock.gate.locked);

test.describe('through the real preload and IPC', () => {
  test.setTimeout(240_000);

  test('the screen locking tells every page, and main is locked before any page answers', async () => {
    await run('yes', async (app, page) => {
      expect(await call(page, 'enroll', 1)).toBe(true);
      await page.evaluate(() => {
        const bridge = (window as unknown as { bulwarkDesktop: { appLock: { onLockRequest(listener: () => void): void } } }).bulwarkDesktop.appLock;
        (window as unknown as { __locks: number }).__locks = 0;
        bridge.onLockRequest(() => { (window as unknown as { __locks: number }).__locks += 1; });
      });
      await app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { lockScreen(): void } }).__bulwarkAppLock.lockScreen());
      expect(await gateLocked(app)).toBe(true);
      await expect.poll(() => page.evaluate(() => (window as unknown as { __locks: number }).__locks)).toBe(1);
    });
  });

  test('without a lock set up the screen locking does nothing', async () => {
    await run('yes', async (app, page) => {
      await app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { lockScreen(): void } }).__bulwarkAppLock.lockScreen());
      expect(await gateLocked(app)).toBe(false);
      expect((await call<{ locked: boolean }>(page, 'status')).locked).toBe(false);
    });
  });

  test('a page\'s word doesn\'t lift it: only the proof does', async () => {
    await run('yes', async (app, page) => {
      await call(page, 'enroll', 1);
      await call(page, 'lock');
      await expect.poll(() => gateLocked(app)).toBe(true);
      expect(await call(page, 'prove', 2)).toBe(false);
      expect(await call(page, 'enroll', 2)).toBe(false);
      expect(await call(page, 'disable', 2)).toBe(false);
      expect(await gateLocked(app)).toBe(true);
      expect(await call(page, 'prove', 1)).toBe(true);
      expect(await gateLocked(app)).toBe(false);
    });
  });

  test('titles stay blank while locked and come back after', async () => {
    await run('yes', async (app, page) => {
      await call(page, 'enroll', 1);
      await page.evaluate(() => { document.title = 'Re: a secret subject'; });
      const title = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
      await expect.poll(title).toContain('secret');
      await call(page, 'lock');
      await expect.poll(title).not.toContain('secret');
      await page.evaluate(() => { document.title = 'Re: a later secret'; });
      await page.waitForTimeout(300);
      expect(await title()).not.toContain('secret');
      await call(page, 'prove', 1);
      await page.evaluate(() => { document.title = 'Back again'; });
      await expect.poll(title).toContain('Back again');
    });
  });

  test('"Lock now" is there only with a lock, and locks', async () => {
    await run('yes', async (app, page) => {
      const item = () => app.evaluate(({ Menu }) => {
        const found = Menu.getApplicationMenu()?.getMenuItemById('file.lockNow');
        return found ? { enabled: found.enabled } : null;
      });
      expect(await item()).toEqual({ enabled: false });
      await call(page, 'enroll', 1);
      await expect.poll(item).toEqual({ enabled: true });
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('file.lockNow')?.click());
      expect(await gateLocked(app)).toBe(true);
      await expect.poll(item).toEqual({ enabled: false });
    });
  });

  test('Hello: a yes lifts the lock and gives the key, on disk it is not in the clear', async () => {
    await run('yes', async (app, page) => {
      const key = 7;
      await call(page, 'enroll', 1);
      expect(await call(page, 'osEnroll', 1, key)).toBe(true);
      const status = await call<{ os: string; osEnrolled: boolean }>(page, 'status');
      expect(status).toMatchObject({ os: 'hello', osEnrolled: true });
      const stored = await app.evaluate(({ app: electronApp }) => {
        const { readdirSync, readFileSync } = process.getBuiltinModule('node:fs');
        const { join } = process.getBuiltinModule('node:path');
        const folder = join(electronApp.getPath('userData'), 'app-lock');
        return readdirSync(folder).filter((name) => name.endsWith('.bin')).map((name) => readFileSync(join(folder, name)).toString('latin1'));
      });
      expect(stored).toHaveLength(1);
      expect(stored[0]).not.toContain(Buffer.alloc(32, key).toString('base64'));
      await call(page, 'lock');
      await expect.poll(() => gateLocked(app)).toBe(true);
      const answer = await call<{ ok: boolean; key: number[] }>(page, 'osUnlock');
      expect(answer.ok).toBe(true);
      expect(answer.key).toEqual(Array(32).fill(key));
      expect(await gateLocked(app)).toBe(false);
    });
  });

  test('Hello: asking while unlocked gets nothing, so a frame can\'t collect the key', async () => {
    await run('yes', async (_app, page) => {
      await call(page, 'enroll', 1);
      await call(page, 'osEnroll', 1, 7);
      const answer = await call<{ ok: boolean; reason: string; key?: unknown }>(page, 'osUnlock');
      expect(answer).toEqual({ ok: false, reason: 'not-locked' });
    });
  });

  test('Hello: a no leaves it locked, with no key', async () => {
    await run('yes', async (app, page) => {
      await call(page, 'enroll', 1);
      await call(page, 'osEnroll', 1, 7);
      process.env.BULWARK_TEST_OS_VERIFY = 'no';
      await app.evaluate(() => { process.env.BULWARK_TEST_OS_VERIFY = 'no'; });
      await call(page, 'lock');
      await expect.poll(() => gateLocked(app)).toBe(true);
      const answer = await call<{ ok: boolean; reason: string; key?: unknown }>(page, 'osUnlock');
      expect(answer).toEqual({ ok: false, reason: 'denied' });
      expect(await gateLocked(app)).toBe(true);
    });
  });

  test('forgetting while locked asks natively, and a no keeps the lock', async () => {
    await run('yes', async (app, page) => {
      await call(page, 'enroll', 1);
      await call(page, 'lock');
      await expect.poll(() => gateLocked(app)).toBe(true);
      await fakeOsIntegration(app, 1);
      expect(await call(page, 'forget')).toBe(false);
      expect((await prompts(app)).length).toBe(1);
      expect(await gateLocked(app)).toBe(true);
      await fakeOsIntegration(app, 0);
      expect(await call(page, 'forget')).toBe(true);
      expect(await gateLocked(app)).toBe(false);
      expect((await call<{ enrolled: boolean }>(page, 'status')).enrolled).toBe(false);
    });
  });

  test('forgetting with the proof, as a sign-out in the tab with the key does, asks nothing', async () => {
    await run('yes', async (app, page) => {
      await call(page, 'enroll', 1);
      await fakeOsIntegration(app, 1);
      expect(await call(page, 'forget', 1)).toBe(true);
      expect((await prompts(app)).length).toBe(0);
      expect((await call<{ enrolled: boolean }>(page, 'status')).enrolled).toBe(false);
    });
  });

  test('no silent forget and enroll while unlocked: without the proof it asks, and a no keeps the lock', async () => {
    await run('yes', async (app, page) => {
      await call(page, 'enroll', 1);
      await fakeOsIntegration(app, 1);
      expect(await call(page, 'forget')).toBe(false);
      expect((await prompts(app)).length).toBe(1);
      expect(await call(page, 'forget', 2), 'the wrong proof is no proof').toBe(false);
      expect(await call(page, 'enroll', 2)).toBe(false);
      expect(await call(page, 'prove', 1)).toBe(true);
    });
  });

  test('a same-origin frame gets neither lock() nor osUnlock(): the page took them, once', async () => {
    await run('yes', async (app, page) => {
      await call(page, 'enroll', 1);
      await call(page, 'osEnroll', 1, 7);
      const seen = await page.evaluate(async () => {
        type Parent = { bulwarkDesktop: { appLock: { lock?: unknown; osUnlock?: unknown; claim(): unknown } } };
        const frame = document.createElement('iframe');
        frame.srcdoc = '<p>frame</p>';
        document.body.appendChild(frame);
        await new Promise((resolve) => (frame.onload = resolve));
        const reached = (frame.contentWindow as unknown as { parent: Parent }).parent.bulwarkDesktop.appLock;
        const out = { lock: typeof reached.lock, osUnlock: typeof reached.osUnlock, claim: reached.claim() };
        frame.remove();
        return out;
      });
      expect(seen).toEqual({ lock: 'undefined', osUnlock: 'undefined', claim: null });
      expect(await gateLocked(app)).toBe(false);
    });
  });

  test('status doesn\'t decrypt to say whether Hello is set up', async () => {
    await run('yes', async (app, page) => {
      await call(page, 'enroll', 1);
      await call(page, 'osEnroll', 1, 7);
      await app.evaluate(({ app: electronApp }) => {
        const { readdirSync, writeFileSync } = process.getBuiltinModule('node:fs');
        const { join } = process.getBuiltinModule('node:path');
        const folder = join(electronApp.getPath('userData'), 'app-lock');
        for (const name of readdirSync(folder).filter((entry: string) => entry.endsWith('.bin'))) writeFileSync(join(folder, name), 'not something it can decrypt');
      });
      expect((await call<{ osEnrolled: boolean }>(page, 'status')).osEnrolled).toBe(true);
    });
  });

  test('wrap and unwrap go through safeStorage, and only for this origin\'s own bytes', async () => {
    await run('yes', async (_app, page) => {
      const answer = await page.evaluate(async () => {
        const bridge = (window as unknown as { bulwarkDesktop: { appLock: {
          status(): Promise<{ wrap?: boolean }>;
          wrap(data: Uint8Array): Promise<Uint8Array | null>;
          unwrap(data: Uint8Array): Promise<Uint8Array | null>;
        } } }).bulwarkDesktop.appLock;
        const data = new Uint8Array(40).fill(9);
        const wrapped = await bridge.wrap(data);
        const back = wrapped ? await bridge.unwrap(wrapped) : null;
        const foreign = await bridge.unwrap(new Uint8Array(32).fill(3));
        return {
          available: (await bridge.status()).wrap,
          changed: wrapped ? Array.from(wrapped).join() !== Array.from(data).join() : false,
          back: back ? Array.from(back) : null,
          foreign,
        };
      });
      expect(answer).toEqual({ available: true, changed: true, back: Array(40).fill(9), foreign: null });
    });
  });

  test('a local wipe takes the lock\'s folder and the DPAPI key along, and main lets go', async () => {
    await run('yes', async (app, page) => {
      await call(page, 'enroll', 1);
      await call(page, 'osEnroll', 1, 7);
      await call(page, 'lock');
      await expect.poll(() => gateLocked(app)).toBe(true);
      await app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { wipe(): Promise<unknown> } }).__bulwarkAppLock.wipe());
      const after = await app.evaluate(({ app: electronApp }) => {
        const { existsSync } = process.getBuiltinModule('node:fs');
        const { join } = process.getBuiltinModule('node:path');
        const gate = (globalThis as unknown as { __bulwarkAppLock: { gate: { locked: boolean; enrolled: boolean } } }).__bulwarkAppLock.gate;
        return { folder: existsSync(join(electronApp.getPath('userData'), 'app-lock')), locked: gate.locked, enrolled: gate.enrolled };
      });
      expect(after).toEqual({ folder: false, locked: false, enrolled: false });
    });
  });

  test('a new start with a lock set up is locked before any page speaks', async () => {
    const profile = tempProfile('app-lock-restart');
    let launched = await launchStandalone(profile);
    try {
      await call(launched.page, 'enroll', 1);
      await launched.app.close();
      launched = await launchStandalone(profile);
      expect(await gateLocked(launched.app)).toBe(true);
      expect(await call(launched.page, 'prove', 1)).toBe(true);
    } finally {
      await launched.app.close().catch(() => undefined);
      removeProfile(profile);
    }
  });
});
