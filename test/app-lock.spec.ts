import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  test('counts PIN guesses across a restart, waits after the free ones, and only the proof clears them', () => {
    const gate = new AppLockGate();
    gate.init(file);
    const now = 1_000_000;
    // Before there's a lock this is someone setting a PIN.
    expect(gate.guess(now)).toBe(0);
    expect(gate.guess(now)).toBe(0);
    gate.enroll(proof(1));
    for (let i = 0; i < 4; i += 1) expect(gate.guess(now)).toBe(0);
    expect(gate.guess(now)).toBe(0);
    const until = gate.guess(now);
    expect(until).toBe(now + 30_000);
    const again = new AppLockGate();
    again.init(file);
    expect(again.guess(now)).toBe(until);
    expect(again.guess(until)).toBe(0);
    expect(again.guess(until)).toBe(until + 60_000);
    // A wrong proof clears nothing.
    expect(again.prove(proof(2))).toBe(false);
    expect(again.guess(until)).toBe(until + 60_000);
    expect(again.prove(proof(1))).toBe(true);
    expect(again.guess(until)).toBe(0);
  });

  test('locked again within a second of an unlock is logged as an error, a lock later on isn\'t', () => {
    const gate = new AppLockGate();
    gate.init(file);
    gate.enroll(proof(1));
    gate.lock();
    const said: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { said.push(args.join(' ')); };
    const realNow = Date.now;
    try {
      let now = 1_000_000;
      Date.now = () => now;
      expect(gate.prove(proof(1))).toBe(true);
      now += 300;
      gate.lock();
      expect(said).toEqual([expect.stringContaining('[app-lock] Locked again 300 ms after an unlock')]);
      said.length = 0;
      expect(gate.prove(proof(1))).toBe(true);
      now += 5_000;
      gate.lock();
      expect(said).toEqual([]);
    } finally {
      console.error = error;
      Date.now = realNow;
    }
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
    // A page with no app in it: the webmail takes the page's two calls in its first render.
    await launched.page.goto(new URL('/api/health', launched.page.url()).href);
    // What the webmail's OS code says as it starts: main counts as locked until then.
    await launched.page.evaluate(() => (window as unknown as { bulwarkDesktop: { os: { setLocked(locked: boolean): void } } }).bulwarkDesktop.os.setLocked(false));
    await body(launched.app, launched.page);
  } finally {
    delete process.env.BULWARK_TEST_OS_VERIFY;
    await launched.app.close().catch(() => undefined);
    removeProfile(profile);
  }
}

type HelloAnswer = { ok: boolean; reason?: string; signature?: number[] };

/** Hello's calls go to the page that claimed them. Seeds become 32-byte proofs and salts. */
function hello(page: Page, method: 'helloEnroll' | 'helloSign' | 'helloRemove', ...seeds: number[]): Promise<HelloAnswer> {
  return page.evaluate(async ({ method: name, seeds: list }) => {
    type Member = Record<string, (...args: unknown[]) => Promise<unknown>>;
    const held = window as unknown as { __controls?: Member };
    held.__controls ??= ((window as unknown as { bulwarkDesktop: { appLock: { claim(): Member } } }).bulwarkDesktop.appLock).claim();
    const out = await held.__controls[name](...list.map((seed) => new Uint8Array(32).fill(seed))) as { signature?: Uint8Array } | undefined;
    return (out && out.signature ? { ...out, signature: Array.from(out.signature) } : out) as never;
  }, { method, seeds }) as Promise<HelloAnswer>;
}

/** With made-up Hello key credentials (the shell's app-lock-hello-fake.ts): no real prompt. */
async function runHello(mode: 'yes' | 'pss' | 'cancel', body: (app: ElectronApplication, page: Page) => Promise<void>, ...args: string[]): Promise<void> {
  const profile = tempProfile('app-lock-hello');
  process.env.BULWARK_TEST_HELLO_KEY = mode;
  const launched = await launchStandalone(profile, ...args);
  try {
    await launched.page.goto(new URL('/api/health', launched.page.url()).href);
    await launched.page.evaluate(() => (window as unknown as { bulwarkDesktop: { os: { setLocked(locked: boolean): void } } }).bulwarkDesktop.os.setLocked(false));
    await body(launched.app, launched.page);
  } finally {
    delete process.env.BULWARK_TEST_HELLO_KEY;
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
      expect(await item()).toBeNull();
      await call(page, 'enroll', 1);
      await expect.poll(item).toEqual({ enabled: true });
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('file.lockNow')?.click());
      expect(await gateLocked(app)).toBe(true);
      // Locked, File offers Unlock in its place.
      await expect.poll(item).toBeNull();
    });
  });

  test('the tray\'s "Lock now" has the lock icon, as New message has its own', async () => {
    await run('yes', async (app, page) => {
      // Each item's label and a fingerprint of its icon, or null without one.
      const tray = () => app.evaluate(() => {
        const handle = (globalThis as unknown as { __bulwarkOs: { tray: { template: () => { label?: string; icon?: Electron.NativeImage }[] } | null } }).__bulwarkOs.tray;
        return handle?.template().map((item) => ({ label: item.label, icon: item.icon && !item.icon.isEmpty() ? item.icon.toPNG().toString('base64') : null })) ?? null;
      });
      await call(page, 'enroll', 1);
      await expect.poll(async () => (await tray())?.some((item) => item.label === 'Lock now')).toBe(true);
      const items = (await tray())!;
      const compose = items.find((item) => item.label === 'New message')!;
      const lock = items.find((item) => item.label === 'Lock now')!;
      expect(compose.icon).not.toBeNull();
      expect(lock.icon).not.toBeNull();
      // Its own glyph, not another command's.
      expect(lock.icon).not.toBe(compose.icon);
    });
  });

  test('locked, the menus offer About, Unlock, Exit and the Window basics, nothing that shows mail', async () => {
    await run('yes', async (app, page) => {
      const state = () => app.evaluate(({ Menu }) => {
        const out: Record<string, boolean> = {};
        type Item = { id?: string; role?: string; label: string; type: string; enabled: boolean; submenu?: { items: Item[] } };
        const walk = (items: Item[]) => {
          for (const item of items) {
            if (item.submenu) walk(item.submenu.items);
            else if (item.type !== 'separator') out[item.id || item.role || item.label] = item.enabled;
          }
        };
        walk(Menu.getApplicationMenu()!.items as unknown as Item[]);
        return out;
      });
      await call(page, 'enroll', 1);
      await expect.poll(async () => (await state())['file.print']).toBe(true);
      await call(page, 'lock');
      await expect.poll(async () => (await state())['file.unlock']).toBe(true);
      const locked = await state();
      for (const id of ['file.newMessage', 'file.newWindow', 'file.open', 'file.saveAs', 'file.print', 'file.savePdf', 'file.import', 'view.zoomIn', 'view.refresh', 'edit.search', 'go.inbox', 'message.reply', 'help.shortcuts']) {
        expect(locked[id], id).toBe(false);
      }
      if (process.platform !== 'darwin') expect(locked['file.settings']).toBe(false);
      // desktop-p3-16: File > Import stayed a submenu of greyed lines.
      expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('file.importMenu')?.enabled)).toBe(false);
      if (process.platform === 'win32') {
        expect(locked['file.quit']).toBe(true);
        expect(locked['window.minimize']).toBe(true);
        expect(locked.about).toBe(true);
      }
      expect(locked['window.cycle']).toBe(true);
      expect(locked.paste).toBe(true);
      // A report from the page doesn't bring them back while locked.
      await page.evaluate(() => (window as unknown as { bulwarkDesktop: { menu: { setState(s: unknown): void } } }).bulwarkDesktop.menu.setState({ 'message.reply': true, 'file.newMessage': true }));
      await page.waitForTimeout(300);
      expect((await state())['message.reply']).toBe(false);
      expect(await call(page, 'prove', 1)).toBe(true);
      await expect.poll(async () => (await state())['file.print']).toBe(true);
      expect((await state())['file.lockNow']).toBe(true);
      expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('file.importMenu')?.enabled)).toBe(true);
    });
  });

  test('Touch ID: a yes lifts the lock and gives the key, on disk it is not in the clear', async () => {
    await run('yes', async (app, page) => {
      const key = 7;
      await call(page, 'enroll', 1);
      expect(await call(page, 'osEnroll', 1, key)).toBe(true);
      const status = await call<{ os: string; osEnrolled: boolean }>(page, 'status');
      expect(status).toMatchObject({ os: 'touchid', osEnrolled: true });
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

  test('Touch ID: asking while unlocked gets nothing, so a frame can\'t collect the key', async () => {
    await run('yes', async (_app, page) => {
      await call(page, 'enroll', 1);
      await call(page, 'osEnroll', 1, 7);
      const answer = await call<{ ok: boolean; reason: string; key?: unknown }>(page, 'osUnlock');
      expect(answer).toEqual({ ok: false, reason: 'not-locked' });
    });
  });

  test('Touch ID: a no leaves it locked, with no key', async () => {
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

  test('status doesn\'t decrypt to say whether Touch ID is set up', async () => {
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

  test('a frame gets neither wrap, unwrap nor a PIN step: those go to whoever claims first', async () => {
    await run('yes', async (_app, page) => {
      const answer = await page.evaluate(() => {
        const bridge = (window as unknown as { bulwarkDesktop: { appLock: Record<string, unknown> & { claim(): Record<string, unknown> | null } } }).bulwarkDesktop.appLock;
        const first = bridge.claim();
        return {
          onBridge: ['wrap', 'unwrap', 'pinStep', 'replaceRenderer'].filter((name) => name in bridge),
          claimed: ['wrap', 'unwrap', 'pinStep', 'replaceRenderer'].filter((name) => first && name in first),
          second: bridge.claim(),
        };
      });
      expect(answer).toEqual({ onBridge: [], claimed: ['wrap', 'unwrap', 'pinStep', 'replaceRenderer'], second: null });
    });
  });

  test('a PIN step takes a secret from main, the same for the same guess, and main counts it', async () => {
    await run('yes', async (_app, page) => {
      await call(page, 'enroll', 1);
      const steps = await page.evaluate(async () => {
        const bridge = (window as unknown as { bulwarkDesktop: { appLock: { claim(): { pinStep(data: Uint8Array): Promise<{ ok: boolean; bytes?: Uint8Array; blockedUntil?: number }> } } } }).bulwarkDesktop.appLock;
        const held = window as unknown as { __controls?: ReturnType<typeof bridge.claim> };
        held.__controls ??= bridge.claim();
        const controls = held.__controls;
        const out = [];
        for (let i = 0; i < 7; i += 1) {
          const answer = await controls.pinStep(new Uint8Array(32).fill(i < 2 ? 5 : i));
          out.push({ ok: answer.ok, bytes: answer.bytes ? Array.from(answer.bytes).join() : null, blocked: Boolean(answer.blockedUntil) });
        }
        return out;
      });
      expect(steps[0].bytes).toBe(steps[1].bytes);
      expect(steps[0].bytes).not.toBe(Array(32).fill(5).join());
      expect(steps[2].bytes).not.toBe(steps[0].bytes);
      // Four free, a fifth that sets the wait, and then refused.
      expect(steps.map((step) => step.ok)).toEqual([true, true, true, true, true, false, false]);
      expect(steps.at(-1)?.blocked).toBe(true);
      expect(await call(page, 'prove', 1)).toBe(true);
    });
  });

  test('a lock can replace the renderer: a new process, the page back, no crash counted. Not while unlocked', async () => {
    await run('yes', async (app, page) => {
      await call(page, 'enroll', 1);
      const pid = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId());
      const ask = () => page.evaluate(() => {
        const held = window as unknown as { __controls?: { replaceRenderer(): void } };
        held.__controls ??= (window as unknown as { bulwarkDesktop: { appLock: { claim(): { replaceRenderer(): void } } } }).bulwarkDesktop.appLock.claim();
        held.__controls.replaceRenderer();
      });
      const before = await pid();
      await ask();
      await page.waitForTimeout(800);
      expect(await pid()).toBe(before);
      await call(page, 'prove', 1);
      await app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { gate: { lock(): void } } }).__bulwarkAppLock.gate.lock());
      await ask().catch(() => undefined);
      await expect.poll(pid, { timeout: 30_000 }).not.toBe(before);
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isLoading()), { timeout: 30_000 }).toBe(false);
      const shown = await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        return { count: BrowserWindow.getAllWindows().length, crashed: window.webContents.isCrashed(), url: window.webContents.getURL() };
      });
      expect(shown).toMatchObject({ count: 1, crashed: false });
      expect(shown.url).toContain('/api/health');
    });
  });

  test('wrap and unwrap go through safeStorage, and only for this origin\'s own bytes', async () => {
    await run('yes', async (_app, page) => {
      const answer = await page.evaluate(async () => {
        const member = (window as unknown as { bulwarkDesktop: { appLock: {
          status(): Promise<{ wrap?: boolean }>;
          claim(): {
            wrap(data: Uint8Array): Promise<Uint8Array | null>;
            unwrap(data: Uint8Array): Promise<Uint8Array | null>;
          };
        } } }).bulwarkDesktop.appLock;
        const bridge = { ...member.claim(), status: member.status };
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

  test('a page\'s wipe through main: the steps run, the answer comes back, then the restart. A frame can\'t ask', async () => {
    const profile = tempProfile('page-wipe');
    writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({
      corsOrigins: ['https://mail.example.test'],
      approvedServers: [{ origin: 'https://lan.example.test', approvedAt: 1 }],
      signInPorts: { 'https://mail.example.test': 1234 },
    }));
    process.env.BULWARK_TEST_OS_VERIFY = 'yes';
    const launched = await launchStandalone(profile);
    const { app, page } = launched;
    try {
      await page.goto(new URL('/api/health', page.url()).href);
      await call(page, 'enroll', 1);
      await call(page, 'osEnroll', 1, 7);
      expect(existsSync(path.join(profile, 'app-lock'))).toBe(true);
      await app.evaluate(({ app: electronApp }) => { electronApp.relaunch = (() => {}) as typeof electronApp.relaunch; });
      const answers = await page.evaluate(async () => {
        const held = window as unknown as { __controls: { localWipe(request: unknown): Promise<{ failed: string[] }> }; bulwarkDesktop: { appLock: Record<string, unknown> } };
        const bridge = held.bulwarkDesktop.appLock;
        const one = await held.__controls.localWipe({ reason: 'remote', account: 'a@example.test' });
        const stillThere = (localStorage.setItem('kept', 'yes'), localStorage.getItem('kept'));
        return { onBridge: 'localWipe' in bridge, one, stillThere };
      });
      expect(answers).toEqual({ onBridge: false, one: { failed: [] }, stillThere: 'yes' });
      // One account of several leaves the lock and the servers.
      expect(existsSync(path.join(profile, 'app-lock'))).toBe(true);
      const all = await page.evaluate(async () => (window as unknown as { __controls: { localWipe(request: unknown): Promise<{ failed: string[] }> } }).__controls.localWipe({ reason: 'settings', account: null }));
      expect(all).toEqual({ failed: [] });
      expect(existsSync(path.join(profile, 'app-lock'))).toBe(false);
      const saved = readFileSync(path.join(profile, 'shell-state.json'), 'utf8');
      for (const name of ['mail.example.test', 'lan.example.test', 'signInPorts']) expect(saved).not.toContain(name);
      // The page is still there to tell the instance, and then asks to go.
      expect(await page.evaluate(() => localStorage.getItem('kept'))).toBe('yes');
      const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
      await page.evaluate(() => (window as unknown as { __controls: { finishLocalWipe(options: unknown): Promise<void> } }).__controls.finishLocalWipe({ keepLocalStorage: false })).catch(() => undefined);
      await gone;
    } finally {
      delete process.env.BULWARK_TEST_OS_VERIFY;
      await app.close().catch(() => undefined);
      removeProfile(profile);
    }
  });

  test('a local wipe takes the lock\'s folder and the DPAPI key along, and the next start has no lock', async () => {
    const profile = tempProfile('app-lock-wipe');
    process.env.BULWARK_TEST_OS_VERIFY = 'yes';
    let launched = await launchStandalone(profile);
    try {
      const { app, page } = launched;
      await page.goto(new URL('/api/health', page.url()).href);
      await call(page, 'enroll', 1);
      await call(page, 'osEnroll', 1, 7);
      await call(page, 'lock');
      await expect.poll(() => gateLocked(app)).toBe(true);
      expect(existsSync(path.join(profile, 'app-lock'))).toBe(true);
      await app.evaluate(({ app: electronApp }) => { electronApp.relaunch = (() => {}) as typeof electronApp.relaunch; });
      const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
      await app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { wipe(): Promise<unknown> } }).__bulwarkAppLock.wipe()).catch(() => undefined);
      await gone;
      expect(existsSync(path.join(profile, 'app-lock'))).toBe(false);

      launched = await launchStandalone(profile);
      expect(await gateLocked(launched.app)).toBe(false);
      expect((await call<{ enrolled: boolean; osEnrolled: boolean }>(launched.page, 'status'))).toMatchObject({ enrolled: false, osEnrolled: false });
    } finally {
      delete process.env.BULWARK_TEST_OS_VERIFY;
      await launched.app.close().catch(() => undefined);
      removeProfile(profile);
    }
  });

  test('Windows Hello: a key credential\'s signature, the same at setup, after the PIN and at the unlock, and only for the page', async () => {
    await runHello('yes', async (app, page) => {
      expect((await call<{ hello?: unknown; os: unknown }>(page, 'status'))).toMatchObject({ hello: { available: true, allowed: true, enrolled: false } });
      expect(await hello(page, 'helloEnroll', 1, 5), 'no lock yet, no proof to give').toEqual({ ok: false, reason: 'failed' });
      await call(page, 'enroll', 1);
      expect(await hello(page, 'helloEnroll', 2, 5), 'the wrong proof').toEqual({ ok: false, reason: 'failed' });
      const enrolled = await hello(page, 'helloEnroll', 1, 5);
      expect(enrolled.ok).toBe(true);
      expect(enrolled.signature).toHaveLength(256);
      expect((await call<{ hello: unknown }>(page, 'status')).hello).toEqual({ available: true, allowed: true, enrolled: true });
      expect(await app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { helloKeys(): string[] } }).__bulwarkAppLock.helloKeys())).toHaveLength(1);
      // Unlocked, a signature takes the proof: what a frame that got this far couldn't give.
      expect(await hello(page, 'helloSign', 5)).toEqual({ ok: false, reason: 'not-locked' });
      expect(await hello(page, 'helloSign', 5, 2)).toEqual({ ok: false, reason: 'not-locked' });
      expect(await hello(page, 'helloSign', 5, 1)).toEqual(enrolled);
      await call(page, 'lock');
      await expect.poll(() => gateLocked(app)).toBe(true);
      expect(await hello(page, 'helloSign', 5)).toEqual(enrolled);
      // A signature lifts nothing: the page proves the unlock with the key it opened.
      expect(await gateLocked(app)).toBe(true);
      const other = await hello(page, 'helloSign', 6);
      expect(other.ok && other.signature).not.toEqual(enrolled.signature);
      // A frame reaches none of it.
      const seen = await page.evaluate(() => {
        const bridge = (window as unknown as { bulwarkDesktop: { appLock: Record<string, unknown> & { claim(): unknown } } }).bulwarkDesktop.appLock;
        return { onBridge: ['helloEnroll', 'helloSign', 'helloCancel', 'helloRemove'].filter((name) => name in bridge), again: bridge.claim() };
      });
      expect(seen).toEqual({ onBridge: [], again: null });
    });
  });

  test('Windows Hello: a key that doesn\'t sign the same each time is refused, and a cancel leaves nothing', async () => {
    await runHello('pss', async (app, page) => {
      await call(page, 'enroll', 1);
      expect(await hello(page, 'helloEnroll', 1, 5)).toEqual({ ok: false, reason: 'unsupported' });
      await app.evaluate(() => { process.env.BULWARK_TEST_HELLO_KEY = 'cancel'; });
      expect(await hello(page, 'helloEnroll', 1, 5)).toEqual({ ok: false, reason: 'cancelled' });
      expect((await call<{ hello: unknown }>(page, 'status')).hello).toMatchObject({ enrolled: false });
      expect(await app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { helloKeys(): string[] } }).__bulwarkAppLock.helloKeys())).toEqual([]);
    });
  });

  test('Windows Hello: turning it off, the lock off, and forgetting all delete the key credential', async () => {
    await runHello('yes', async (app, page) => {
      const keys = () => app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { helloKeys(): string[] } }).__bulwarkAppLock.helloKeys());
      await call(page, 'enroll', 1);
      await hello(page, 'helloEnroll', 1, 5);
      await hello(page, 'helloRemove');
      expect(await keys()).toEqual([]);
      expect((await call<{ hello: unknown }>(page, 'status')).hello).toMatchObject({ enrolled: false });
      await hello(page, 'helloEnroll', 1, 5);
      expect(await call(page, 'disable', 1)).toBe(true);
      expect(await keys()).toEqual([]);
      await call(page, 'enroll', 1);
      await hello(page, 'helloEnroll', 1, 5);
      expect(await call(page, 'forget', 1)).toBe(true);
      expect(await keys()).toEqual([]);
      expect((await call<{ hello: unknown }>(page, 'status')).hello).toMatchObject({ enrolled: false });
    });
  });

  test('Windows Hello: a local wipe deletes the key credential with the lock', async () => {
    const profile = tempProfile('app-lock-hello-wipe');
    const log = path.join(mkdtempSync(path.join(tmpdir(), 'bw-hello-log-')), 'deleted.txt');
    writeFileSync(log, '');
    process.env.BULWARK_TEST_HELLO_KEY = 'yes';
    process.env.BULWARK_TEST_HELLO_KEY_LOG = log;
    const launched = await launchStandalone(profile);
    try {
      const { app, page } = launched;
      await page.goto(new URL('/api/health', page.url()).href);
      await call(page, 'enroll', 1);
      expect((await hello(page, 'helloEnroll', 1, 5)).ok).toBe(true);
      const [name] = await app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { helloKeys(): string[] } }).__bulwarkAppLock.helloKeys());
      expect(name).toMatch(/^Bulwark app lock [0-9a-f]{24}$/);
      await app.evaluate(({ app: electronApp }) => { electronApp.relaunch = (() => {}) as typeof electronApp.relaunch; });
      const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
      await app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { wipe(): Promise<unknown> } }).__bulwarkAppLock.wipe()).catch(() => undefined);
      await gone;
      expect(readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean)).toEqual([name]);
      expect(existsSync(path.join(profile, 'app-lock'))).toBe(false);
    } finally {
      delete process.env.BULWARK_TEST_HELLO_KEY;
      delete process.env.BULWARK_TEST_HELLO_KEY_LOG;
      await launched.app.close().catch(() => undefined);
      removeProfile(profile);
      rmSync(path.dirname(log), { recursive: true, force: true });
    }
  });

  test('Windows Hello: the AppLockHelloAllowed policy off refuses it and deletes an existing key credential', async () => {
    test.skip(process.platform !== 'win32', 'the test root is a registry key');
    const root = `HKCU\\Software\\BulwarkTest\\Policies\\applock${process.pid}`;
    const reg = (...args: string[]) => {
      const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) throw new Error(`reg ${args.join(' ')}: ${result.stderr}`);
    };
    await runHello('yes', async (app, page) => {
      await call(page, 'enroll', 1);
      expect((await hello(page, 'helloEnroll', 1, 5)).ok).toBe(true);
      reg('add', `${root}\\Machine`, '/v', 'AppLockHelloAllowed', '/t', 'REG_DWORD', '/d', '0', '/f');
      await expect.poll(async () => (await call<{ hello: unknown }>(page, 'status')).hello, { timeout: 15_000 }).toEqual({ available: true, allowed: false, enrolled: false });
      expect(await app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { helloKeys(): string[] } }).__bulwarkAppLock.helloKeys())).toEqual([]);
      expect(await hello(page, 'helloEnroll', 1, 5)).toEqual({ ok: false, reason: 'policy' });
    }, `--bulwark-test-policy-root=${root}`, '--bulwark-test-policy-poll=250').finally(() => {
      spawnSync('reg.exe', ['delete', root, '/f'], { windowsHide: true });
    });
  });

  test('Windows: the yes-or-no Hello is gone, and a key it left under DPAPI is deleted at start', async () => {
    test.skip(process.platform !== 'win32', 'Windows only');
    const profile = tempProfile('app-lock-old-hello');
    const keyFiles = () => {
      try {
        return readdirSync(path.join(profile, 'app-lock')).filter((name) => name.startsWith('app-lock-key-'));
      } catch {
        return [];
      }
    };
    // As the yes-or-no unlock left it: the lock key in safeStorage. The hook makes the check say yes.
    process.env.BULWARK_TEST_OS_VERIFY = 'yes';
    let launched = await launchStandalone(profile);
    try {
      await launched.page.goto(new URL('/api/health', launched.page.url()).href);
      await call(launched.page, 'enroll', 1);
      expect(await call(launched.page, 'osEnroll', 1, 7)).toBe(true);
      expect(keyFiles()).toHaveLength(1);
      await launched.app.close();
      delete process.env.BULWARK_TEST_OS_VERIFY;
      launched = await launchStandalone(profile);
      await launched.page.goto(new URL('/api/health', launched.page.url()).href);
      const status = await call<{ os: string | null; osEnrolled: boolean }>(launched.page, 'status');
      expect(status.os).not.toBe('hello');
      expect(status.osEnrolled).toBe(false);
      expect(keyFiles()).toEqual([]);
    } finally {
      delete process.env.BULWARK_TEST_OS_VERIFY;
      await launched.app.close().catch(() => undefined);
      removeProfile(profile);
    }
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
