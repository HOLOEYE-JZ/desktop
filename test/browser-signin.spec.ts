import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import path from 'node:path';
import { chromium, expect, test, type Browser, type ElectronApplication, type Page } from '@playwright/test';
import { generateCertificate } from '../src/main/cert';
import { ACCOUNT, APP_ORIGIN, ENT_PASSWORD, expectMailShown, fakeOsIntegration, fillServer, launch, launchStandalone, opened, prompts, removeProfile, requireAccount, SCREENSHOTS, shownPage, STALWARTS, tempProfile, waitForLogin } from './helpers';

/**
 * "Sign in with your browser" on the real app. A real Chromium plays the system browser:
 * shell.openExternal goes to a list, and the test opens what's on it. Real Stalwarts, with
 * throwaway accounts only.
 *
 * Needs a webmail build of this branch (BULWARK_TEST_WEBMAIL, or ./webmail), and for
 * instance mode a regular server build, one per server:
 *   BULWARK_TEST_INSTANCE_1.0=http://127.0.0.1:3231   JMAP on the 1.0 server
 *   BULWARK_TEST_INSTANCE_0.16=http://127.0.0.1:3232  JMAP on the 0.16 server
 *   BULWARK_TEST_INSTANCE_STRICT=http://127.0.0.1:3233  COOKIE_SAME_SITE=strict
 *   BULWARK_TEST_INSTANCE_SSO=http://127.0.0.1:3234   OAUTH_ENABLED and OAUTH_ONLY
 * BULWARK_TEST_ACCOUNT is the plain account, BULWARK_TEST_TOTP_ACCOUNT one with a second
 * factor, whose secret is in BULWARK_TEST_TOTP_SECRET.
 */

const TOTP_ACCOUNT = process.env.BULWARK_TEST_TOTP_ACCOUNT ?? '';
const TOTP_SECRET = process.env.BULWARK_TEST_TOTP_SECRET ?? '';

let browser: Browser;

test.beforeAll(async () => {
  requireAccount();
  browser = await chromium.launch({ headless: true });
});
test.afterAll(async () => {
  await browser?.close();
});

/** A clean browser profile, the way the user's default browser is someone else's business. */
const systemBrowser = () => browser.newContext({ locale: 'en-US', ignoreHTTPSErrors: true });

/** RFC 6238, for the test account's second factor. */
function totpNow(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const hash = createHmac('sha1', key).update(counter).digest();
  const offset = hash[hash.length - 1] & 0xf;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Waits until a code hasn't long to live no more: the servers refuse one used twice. */
async function freshTotp(secret: string): Promise<string> {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 8000) await new Promise((resolve) => setTimeout(resolve, left + 500));
  return totpNow(secret);
}

async function nextOpened(app: ElectronApplication, count = 1): Promise<string> {
  await expect.poll(() => opened(app).then((list) => list.length), { timeout: 30_000 }).toBeGreaterThanOrEqual(count);
  return (await opened(app))[count - 1];
}

function portState(port: number): Promise<'open' | 'closed'> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve('open');
    });
    socket.once('error', () => resolve('closed'));
  });
}

function rawGet(port: number, pathName: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: pathName, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const isFocused = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isFocused()));

/** Counts what brings a window forward, and minimises the window so that it has to. */
async function watchForward(app: ElectronApplication, minimize = false): Promise<void> {
  await app.evaluate(({ BrowserWindow }, shouldMinimize) => {
    const g = globalThis as unknown as { __forward: number };
    g.__forward = 0;
    const proto = BrowserWindow.prototype as unknown as { moveTop: () => void };
    const original = proto.moveTop;
    proto.moveTop = function moveTop(this: unknown) {
      g.__forward += 1;
      return original.call(this);
    };
    if (shouldMinimize) BrowserWindow.getAllWindows()[0].minimize();
  }, minimize);
}

const forwardCount = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __forward: number }).__forward);

/** Everything main and the page say, to look for what must not be there. */
function watchOutput(app: ElectronApplication, page: Page): () => string {
  let text = '';
  const child = app.process();
  child.stdout?.on('data', (chunk) => (text += chunk.toString()));
  child.stderr?.on('data', (chunk) => (text += chunk.toString()));
  page.on('console', (message) => (text += `${message.text()}\n`));
  page.on('request', (request) => (text += `${request.url()}\n`));
  page.on('framenavigated', (frame) => (text += `${frame.url()}\n`));
  return () => text;
}

const reg = (...args: string[]) => {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`reg ${args.join(' ')}: ${result.stderr}`);
};

/** Forced policies under the test root, removed afterwards. */
function forcedPolicies(values: Record<string, number | string | string[]>): { arg: string; remove: () => void } {
  const root = `HKCU\\Software\\BulwarkTest\\Policies\\signin-${process.pid}-${Date.now()}`;
  const machine = `${root}\\Machine`;
  reg('add', machine, '/f');
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'number') reg('add', machine, '/v', name, '/t', 'REG_DWORD', '/d', String(value), '/f');
    else if (typeof value === 'string') reg('add', machine, '/v', name, '/t', 'REG_SZ', '/d', value, '/f');
    else value.forEach((item, index) => reg('add', `${machine}\\${name}`, '/v', String(index + 1), '/t', 'REG_SZ', '/d', item, '/f'));
  }
  return {
    arg: `--bulwark-test-policy-root=${root}`,
    remove: () => {
      // Another run's clean-up may have taken the whole tree already.
      spawnSync('reg.exe', ['delete', root, '/f'], { windowsHide: true });
      // Nothing of ours stays, unless another run is using the tree.
      const left = spawnSync('reg.exe', ['query', 'HKCU\\Software\\BulwarkTest\\Policies'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
      if (!/Policies\\/.test(left)) spawnSync('reg.exe', ['delete', 'HKCU\\Software\\BulwarkTest', '/f'], { windowsHide: true });
    },
  };
}

for (const { label, url } of STALWARTS) {
  test.describe(`standalone on Stalwart ${label}`, () => {
    test('the server\'s own page signs the app in, and the app comes forward', async () => {
      const profile = tempProfile(`bs-${label}`);
      const { app, page } = await launchStandalone(profile);
      await fakeOsIntegration(app);
      const output = watchOutput(app, page);
      await waitForLogin(page);
      if (label === '1.0') await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-browser-signin-login.png') });

      await fillServer(page, url);
      await page.getByTestId('desktop-browser-sign-in').click();
      await expect(page.getByTestId('desktop-browser-waiting')).toBeVisible();
      if (label === '1.0') await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-browser-signin-waiting.png') });
      await watchForward(app, true);

      const target = new URL(await nextOpened(app));
      expect(target.origin).toBe(url);
      expect(target.searchParams.get('code_challenge_method')).toBe('S256');
      expect(target.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/bulwark-desktop\/callback$/);
      const listener = Number(new URL(target.searchParams.get('redirect_uri')!).port);

      const context = await systemBrowser();
      const tab = await context.newPage();
      let landedAt = '';
      tab.on('request', (request) => {
        if (request.url().startsWith('http://127.0.0.1')) landedAt = request.url();
      });
      await tab.goto(target.toString());
      // Where a password manager works: a real form with the real attributes, at the server's origin.
      await expect(tab.locator('input[autocomplete="current-password"]')).toBeVisible();
      await expect(tab.locator('input[autocomplete="username"]')).toBeVisible();
      await tab.fill('input[autocomplete="username"]', ACCOUNT);
      await tab.fill('input[autocomplete="current-password"]', ENT_PASSWORD);
      await tab.keyboard.press('Enter');
      await expect(tab.locator('body')).toContainText('close this tab', { timeout: 30_000 });
      if (label === '1.0') await tab.screenshot({ path: path.join(SCREENSHOTS, 'desktop-browser-signin-done.png') });

      await expectMailShown(page);
      expect(await forwardCount(app)).toBe(1);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false);
      expect(await isFocused(app)).toBe(true);
      expect(new URL(page.url()).origin).toBe(APP_ORIGIN);
      const registry = JSON.parse((await page.evaluate(() => localStorage.getItem('account-registry'))) ?? '{}');
      expect(JSON.stringify(registry)).toContain('"authMode":"oauth"');

      // The listener went, a second redirect finds nothing.
      await expect.poll(() => portState(listener)).toBe('closed');
      await expect(rawGet(listener, new URL(landedAt).pathname + new URL(landedAt).search, { host: `127.0.0.1:${listener}` })).rejects.toThrow();

      // The code is spent, whoever else has it, and it never showed anywhere in the app.
      const code = new URL(landedAt).searchParams.get('code')!;
      const state = new URL(landedAt).searchParams.get('state')!;
      expect(code.length).toBeGreaterThan(8);
      const replay = await fetch(`${url}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: target.searchParams.get('client_id')!, redirect_uri: target.searchParams.get('redirect_uri')!, code_verifier: 'x'.repeat(50) }),
      });
      expect(replay.ok).toBe(false);
      expect(output()).not.toContain(code);
      expect(output()).not.toContain(state);
      expect(output()).not.toContain(ENT_PASSWORD);

      // A refresh works: nothing about this sign-in leans on the listener.
      const refreshed = await page.evaluate(() => fetch('/api/auth/token?slot=0&force=true', { method: 'PUT' }).then((r) => r.status));
      expect(refreshed).toBe(200);
      await page.reload();
      await expectMailShown(page);

      await context.close();
      await app.close();
      removeProfile(profile);
    });

    test('with a second factor, on the same page', async () => {
      test.skip(!TOTP_SECRET, 'needs BULWARK_TEST_TOTP_SECRET');
      const profile = tempProfile(`bs-totp-${label}`);
      const { app, page } = await launchStandalone(profile);
      await fakeOsIntegration(app);
      await waitForLogin(page);
      await fillServer(page, url);
      await page.getByTestId('desktop-browser-sign-in').click();
      const context = await systemBrowser();
      const tab = await context.newPage();
      await tab.goto(await nextOpened(app));
      await tab.fill('input[autocomplete="username"]', TOTP_ACCOUNT);
      await tab.fill('input[autocomplete="current-password"]', ENT_PASSWORD);
      await tab.keyboard.press('Enter');
      const otp = tab.locator('input[autocomplete="one-time-code"]');
      await expect(otp).toBeVisible({ timeout: 15_000 });
      await otp.fill(await freshTotp(TOTP_SECRET));
      await tab.keyboard.press('Enter');
      await expect(tab.locator('body')).toContainText('close this tab', { timeout: 30_000 });
      await expectMailShown(page);
      await context.close();
      await app.close();
      removeProfile(profile);
    });
  });
}

test.describe('what can go wrong, on the real app', () => {
  test.describe.configure({ mode: 'serial' });
  const server = STALWARTS[0].url;
  let profile = '';
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    profile = tempProfile('bs-attack');
    ({ app, page } = await launchStandalone(profile, '--bulwark-test-sign-in-timeout=25000'));
    await fakeOsIntegration(app);
    await waitForLogin(page);
  });
  test.afterAll(async () => {
    await app?.close();
    removeProfile(profile);
  });

  async function startFlow(count: number) {
    await fillServer(page, server);
    await page.getByTestId('desktop-browser-sign-in').click();
    const target = new URL(await nextOpened(app, count));
    const redirect = new URL(target.searchParams.get('redirect_uri')!);
    return { target, port: Number(redirect.port), path: redirect.pathname, state: target.searchParams.get('state')! };
  }

  const signedIn = () => page.evaluate(() => JSON.stringify(localStorage.getItem('account-registry') ?? '').includes('authMode'));

  test('another page in the browser gets nothing from the listener, and ends nothing', async () => {
    const flow = await startFlow(1);
    await watchForward(app);
    // Another origin with no rules of its own, and the worst case: it knows the state.
    const site = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Evil</title>');
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    const context = await systemBrowser();
    const evil = await context.newPage();
    await evil.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}/`);
    const seen = await evil.evaluate(async ({ port, path: callback, state }) => {
      const url = `http://127.0.0.1:${port}${callback}?code=attacker&state=${state}`;
      const attempt = async (options: RequestInit) => {
        try {
          const res = await fetch(url, options);
          return `read ${res.status}`;
        } catch {
          return 'blocked';
        }
      };
      const hidden = () => new Promise<void>((resolve) => {
        const frame = document.createElement('iframe');
        frame.src = url;
        frame.onload = () => resolve();
        document.body.appendChild(frame);
      });
      const image = () => new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = img.onerror = () => resolve();
        img.src = url;
      });
      const result = { cors: await attempt({}), noCors: await attempt({ mode: 'no-cors' }) };
      await hidden();
      await image();
      return result;
    }, flow);
    expect(seen.cors).toBe('blocked');
    // None of those were a navigation of the page itself: the flow is still waiting.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await portState(flow.port)).toBe('open');
    await expect(page.getByTestId('desktop-browser-waiting')).toBeVisible();
    expect(await signedIn()).toBe(false);
    expect(await forwardCount(app)).toBe(0);
    await context.close();
    site.close();
    site.closeAllConnections();
  });

  test('a wrong state from a real browser ends nothing', async () => {
    const { port, path: callback } = await startFlowIfNeeded();
    const context = await systemBrowser();
    const tab = await context.newPage();
    const answer = await tab.goto(`http://127.0.0.1:${port}${callback}?code=attacker&state=wrong`);
    expect(answer?.status()).toBe(400);
    expect(await portState(port)).toBe('open');
    await expect(page.getByTestId('desktop-browser-waiting')).toBeVisible();
    expect(await signedIn()).toBe(false);
    await context.close();
  });

  test('a wrong Host gets nothing', async () => {
    const { port, path: callback, state } = await startFlowIfNeeded();
    const answer = await rawGet(port, `${callback}?code=attacker&state=${state}`, { host: 'evil.example' });
    expect(answer.status).toBe(403);
    expect(answer.body).toBe('');
    await expect(page.getByTestId('desktop-browser-waiting')).toBeVisible();
    expect(await signedIn()).toBe(false);
  });

  // The flow started in the first of these. Each case above can also run alone.
  let current: Awaited<ReturnType<typeof startFlow>> | null = null;
  async function startFlowIfNeeded() {
    if (current) return current;
    const list = await opened(app);
    const target = new URL(list.at(-1)!);
    const redirect = new URL(target.searchParams.get('redirect_uri')!);
    current = { target, port: Number(redirect.port), path: redirect.pathname, state: target.searchParams.get('state')! };
    return current;
  }

  test('a sent bulwark: link with a code does nothing, in the middle of a flow too', async () => {
    const { port } = await startFlowIfNeeded();
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit('second-instance', {}, ['bulwark.exe', 'bulwark://sign-in/callback?code=attacker-code&state=attacker-state'], process.cwd());
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await portState(port)).toBe('open');
    await expect(page.getByTestId('desktop-browser-waiting')).toBeVisible();
    expect(await signedIn()).toBe(false);
    expect(await forwardCount(app)).toBe(0);
  });

  test('a flow left alone ends clearly, closes, and can be tried again', async () => {
    const { port } = await startFlowIfNeeded();
    await expect(page.getByTestId('desktop-notice')).toContainText(/too long/i, { timeout: 40_000 });
    await expect.poll(() => portState(port)).toBe('closed');
    await expect(page.getByTestId('desktop-browser-sign-in')).toBeEnabled();
    expect(await signedIn()).toBe(false);
    current = null;

    const before = (await opened(app)).length;
    const flow = await startFlow(before + 1);
    expect(flow.port).not.toBe(port);
    await page.getByTestId('desktop-browser-cancel').click();
    await expect.poll(() => portState(flow.port)).toBe('closed');
    await expect(page.getByTestId('desktop-notice')).toHaveCount(0);
  });

  test('a frame can\'t get the sign-in calls, nor can the page a second time', async () => {
    const claims = await page.evaluate(async () => {
      type B = { bulwarkDesktop: { auth: { claim: () => unknown } } };
      const own = (window as unknown as B).bulwarkDesktop.auth.claim();
      const frame = document.createElement('iframe');
      frame.srcdoc = '<p>frame</p>';
      document.body.appendChild(frame);
      await new Promise((resolve) => (frame.onload = resolve));
      const viaParent = (frame.contentWindow as unknown as { parent: B }).parent.bulwarkDesktop.auth.claim();
      frame.remove();
      return { own, viaParent };
    });
    expect(claims).toEqual({ own: null, viaParent: null });
  });

  test('a call from a subframe or another page is refused in main, for every sign-in channel', async () => {
    const denied = await app.evaluate(async ({ BrowserWindow, ipcMain }, origin) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown, ...args: unknown[]) => unknown> })._invokeHandlers;
      const window = BrowserWindow.getAllWindows()[0];
      const outcome = async (channel: string, senderFrame: unknown) => {
        try {
          await handlers.get(channel)!({ sender: window.webContents, senderFrame }, 'flow');
          return 'allowed';
        } catch (error) {
          return (error as Error).message;
        }
      };
      const all: Record<string, string> = {};
      for (const channel of ['bulwark:auth.begin', 'bulwark:auth.complete', 'bulwark:auth.useScheme', 'bulwark:auth.password.begin', 'bulwark:auth.password.next', 'bulwark:auth.password.outcome']) {
        all[`${channel} subframe`] = await outcome(channel, { url: `${origin}/en/login`, parent: { url: origin } });
        all[`${channel} foreign`] = await outcome(channel, { url: 'https://evil.example/', parent: null });
      }
      return all;
    }, APP_ORIGIN);
    expect(Object.keys(denied)).toHaveLength(12);
    expect(new Set(Object.values(denied))).toEqual(new Set(['Not allowed']));
  });

  test('main refuses to open what isn\'t this flow\'s', async () => {
    const answer = await app.evaluate(async ({ BrowserWindow, ipcMain }, { origin, serverUrl }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown, ...args: unknown[]) => unknown> })._invokeHandlers;
      const window = BrowserWindow.getAllWindows()[0];
      const event = { sender: window.webContents, senderFrame: { url: `${origin}/en/login`, parent: null } };
      const begun = (await handlers.get('bulwark:auth.begin')!(event, { kind: 'oauth', serverUrl })) as { flowId: string; redirectUri: string };
      return handlers.get('bulwark:auth.complete')!(event, begun.flowId, 'https://evil.example/?redirect_uri=x&state=y');
    }, { origin: APP_ORIGIN, serverUrl: server });
    expect(answer).toEqual({ ok: false, error: 'invalid_url' });
  });
});

test.describe('the calls themselves', () => {
  test('a page gets them once, and a flow only starts from a click', async () => {
    // A stand-in with no webmail on it: nothing has claimed anything.
    const standIn = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Stand-in</title><h1 id="stand-in">x</h1>');
    });
    await new Promise<void>((resolve) => standIn.listen(0, '127.0.0.1', resolve));
    const instance = `http://localhost:${(standIn.address() as AddressInfo).port}`;
    const policy = forcedPolicies({ AllowInsecureInstance: 1 });
    const profile = tempProfile('bs-claim');
    const app = await launch(profile, `--instance=${instance}/`, policy.arg);
    const page = await shownPage(app);
    await fakeOsIntegration(app);
    await page.locator('#stand-in').waitFor();
    const seen = await page.evaluate(async () => {
      type Controls = { begin: (request: unknown) => Promise<{ ok: boolean; error?: string; flowId?: string }>; cancel: (id: string) => void };
      const auth = (window as unknown as { bulwarkDesktop: { auth: { claim: () => Controls | null } } }).bulwarkDesktop.auth;
      const first = auth.claim();
      const second = auth.claim();
      // Longer than a user activation lasts.
      await new Promise((resolve) => setTimeout(resolve, 6000));
      const noGesture = await first!.begin({ kind: 'instance' });
      const button = document.createElement('button');
      button.id = 'go';
      document.body.appendChild(button);
      (window as unknown as { __go: Promise<unknown> }).__go = new Promise((resolve) => {
        button.onclick = () => resolve(first!.begin({ kind: 'instance' }));
      });
      return { gotFirst: !!first, second, noGesture };
    });
    expect(seen).toEqual({ gotFirst: true, second: null, noGesture: { ok: false, error: 'no_gesture' } });
    await page.locator('#go').click();
    const begun = await page.evaluate(() => (window as unknown as { __go: Promise<{ ok: boolean; redirectUri: string; state: string; flowId: string }> }).__go);
    expect(begun.ok).toBe(true);
    expect(begun.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/bulwark-desktop\/callback$/);
    expect(begun.state.length).toBeGreaterThanOrEqual(43);

    // A reload is a new document: what it held goes, and the listener with it.
    const port = Number(new URL(begun.redirectUri).port);
    expect(await portState(port)).toBe('open');
    await page.reload();
    await expect.poll(() => portState(port)).toBe('closed');

    await app.close();
    removeProfile(profile);
    policy.remove();
    standIn.close();
    standIn.closeAllConnections();
  });
});

test.describe('policies', () => {
  const server = STALWARTS[0].url;

  test('a remote wipe takes the list of servers signed in to through the browser', async () => {
    const policy = forcedPolicies({ WipeOfflineData: `wipe-${Date.now()}` });
    const profile = tempProfile('bs-wipe');
    const file = path.join(profile, 'shell-state.json');
    writeFileSync(file, JSON.stringify({ approvedServers: [], corsOrigins: [], windowBounds: {}, overlayByOrigin: {}, signInPorts: { 'https://mail.example.org': 31234 } }));
    const { app, page } = await launchStandalone(profile, policy.arg);
    await waitForLogin(page);
    await expect.poll(() => (JSON.parse(readFileSync(file, 'utf8')) as { signInPorts?: unknown }).signInPorts, { timeout: 30_000 }).toBeUndefined();
    await app.close();
    expect((JSON.parse(readFileSync(file, 'utf8')) as { signInPorts?: unknown }).signInPorts).toBeUndefined();
    removeProfile(profile);
    policy.remove();
  });

  test('BrowserSignIn off: no button, and main refuses the flow', async () => {
    const policy = forcedPolicies({ BrowserSignIn: 0 });
    const profile = tempProfile('bs-off');
    const { app, page } = await launchStandalone(profile, policy.arg);
    await fakeOsIntegration(app);
    await waitForLogin(page);
    await expect(page.getByTestId('desktop-browser-sign-in')).toHaveCount(0);
    await expect(page.locator('#password')).toBeVisible();
    const answer = await app.evaluate(async ({ BrowserWindow, ipcMain }, { origin, serverUrl }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown, ...args: unknown[]) => unknown> })._invokeHandlers;
      const window = BrowserWindow.getAllWindows()[0];
      return handlers.get('bulwark:auth.begin')!({ sender: window.webContents, senderFrame: { url: `${origin}/en/login`, parent: null } }, { kind: 'oauth', serverUrl });
    }, { origin: APP_ORIGIN, serverUrl: server });
    expect(answer).toEqual({ ok: false, error: 'policy' });
    expect(await opened(app)).toEqual([]);
    await app.close();
    removeProfile(profile);
    policy.remove();
  });

  test('a server off the device\'s list: nothing opens, in the page or in main', async () => {
    const policy = forcedPolicies({ AllowedJmapServers: ['https://other.example.org'] });
    const profile = tempProfile('bs-list');
    const { app, page } = await launchStandalone(profile, policy.arg);
    await fakeOsIntegration(app);
    await waitForLogin(page);
    await fillServer(page, server);
    await page.getByTestId('desktop-browser-sign-in').click();
    await expect(page.getByTestId('desktop-policy-notice')).toBeVisible();
    const answer = await app.evaluate(async ({ BrowserWindow, ipcMain }, { origin, serverUrl }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown, ...args: unknown[]) => unknown> })._invokeHandlers;
      const window = BrowserWindow.getAllWindows()[0];
      return handlers.get('bulwark:auth.begin')!({ sender: window.webContents, senderFrame: { url: `${origin}/en/login`, parent: null } }, { kind: 'oauth', serverUrl });
    }, { origin: APP_ORIGIN, serverUrl: server });
    expect(answer).toEqual({ ok: false, error: 'policy' });
    expect(await opened(app)).toEqual([]);
    await app.close();
    removeProfile(profile);
    policy.remove();
  });
});

test.describe('a server with no OAuth', () => {
  // The real server's JMAP behind an http relay that has no OAuth documents, and never
  // passes on a wrong password: that could get this computer blocked.
  const target = new URL(STALWARTS[0].url);
  const BAD = 'not-the-password';
  let relay: Server;
  let relayUrl = '';

  test.beforeAll(async () => {
    relay = createHttpServer((req, res) => {
      const pathName = req.url ?? '/';
      if (pathName.includes('oauth') || pathName.includes('openid') || pathName.startsWith('/auth/') || pathName.startsWith('/login')) {
        res.writeHead(404).end();
        return;
      }
      const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString() : '';
      if (basic.endsWith(`:${BAD}`)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      const upstream = httpsRequest({ host: target.hostname, port: 443, path: pathName, method: req.method, headers: { ...req.headers, host: target.hostname } }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  });
  test.afterAll(() => {
    relay.close();
    relay.closeAllConnections();
  });

  test('a page from main names the server, a wrong password stays there, a right one signs the app in, and the port stays', async () => {
    const profile = tempProfile('bs-noauth');
    const { app, page } = await launchStandalone(profile);
    await fakeOsIntegration(app, 0);
    const output = watchOutput(app, page);
    await waitForLogin(page);
    await fillServer(page, relayUrl);
    await page.getByTestId('desktop-browser-sign-in').click();
    const address = new URL(await nextOpened(app));
    expect(address.hostname).toBe('127.0.0.1');
    expect(address.pathname).toMatch(/^\/sign-in\/[\w-]{43}$/);
    expect((await prompts(app))[0].message).toMatch(/encryption/i);
    await watchForward(app);

    const context = await systemBrowser();
    const tab = await context.newPage();
    await tab.goto(address.toString());
    await expect(tab.locator('h1')).toContainText(new URL(relayUrl).host);
    await tab.screenshot({ path: path.join(SCREENSHOTS, 'desktop-browser-signin-password-page.png') });
    await tab.fill('#username', ACCOUNT);
    await tab.fill('#password', BAD);
    await tab.keyboard.press('Enter');
    await expect(tab.locator('[role=alert]')).toBeVisible({ timeout: 30_000 });
    expect(await tab.content()).not.toContain(BAD);
    await expect(page.getByTestId('desktop-browser-waiting')).toBeVisible();
    await expect(tab.locator('#username')).toHaveValue(ACCOUNT);

    // The address only opens once: a link to it, or a reload, is a dead end.
    const again = await context.newPage();
    const used = await again.goto(address.toString());
    expect(used?.status()).toBe(410);
    await again.close();

    await tab.fill('#password', ENT_PASSWORD);
    await tab.keyboard.press('Enter');
    await expect(tab.locator('body')).toContainText('close this tab', { timeout: 30_000 });
    await expectMailShown(page);
    expect(await forwardCount(app)).toBe(1);
    await expect.poll(() => portState(Number(address.port))).toBe('closed');
    expect(output()).not.toContain(ENT_PASSWORD);
    expect(output()).not.toContain(BAD);
    expect(output()).not.toContain(address.pathname);
    await context.close();

    // Same origin next time, so what a password manager saved still fits.
    await app.close();
    const state = JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8')) as { signInPorts?: Record<string, number> };
    expect(state.signInPorts?.[relayUrl]).toBe(Number(address.port));
    removeProfile(profile);
  });

  test('declining the server sends nothing, and opens nothing', async () => {
    const profile = tempProfile('bs-decline');
    const { app, page } = await launchStandalone(profile);
    await fakeOsIntegration(app, 1);
    await waitForLogin(page);
    await fillServer(page, relayUrl);
    await page.getByTestId('desktop-browser-sign-in').click();
    await expect(page.getByTestId('desktop-notice')).toBeVisible();
    expect(await opened(app)).toEqual([]);
    await app.close();
    removeProfile(profile);
  });
});

test.describe('a server that refuses a loopback redirect', () => {
  // No such Stalwart exists, so a stand-in that says so at registration, and takes the scheme.
  test('goes by the bulwark: link, and only the right state gets a code through', async () => {
    const codes: string[] = [];
    const server = createHttpServer((req, res) => {
      const pathName = (req.url ?? '/').split('?')[0];
      const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const origin = `http://${req.headers.host}`;
      if (pathName === '/.well-known/oauth-authorization-server') {
        json(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` });
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (pathName === '/register') {
          const redirect = (JSON.parse(body) as { redirect_uris: string[] }).redirect_uris[0];
          if (redirect.startsWith('bulwark:')) json(201, { client_id: 'schemed' });
          else json(400, { error: 'invalid_redirect_uri' });
        } else if (pathName === '/token') {
          codes.push(new URLSearchParams(body).get('code') ?? '');
          json(400, { error: 'invalid_grant' });
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const profile = tempProfile('bs-scheme');
    const { app, page } = await launchStandalone(profile);
    await fakeOsIntegration(app, 0);
    await waitForLogin(page);
    await fillServer(page, url);
    await page.getByTestId('desktop-browser-sign-in').click();
    const target = new URL(await nextOpened(app));
    expect(target.searchParams.get('redirect_uri')).toBe('bulwark://sign-in/callback');
    expect(target.searchParams.get('client_id')).toBe('schemed');

    const link = (code: string, state: string) => app.evaluate(({ app: electronApp }, value) => {
      electronApp.emit('second-instance', {}, ['bulwark.exe', value], process.cwd());
    }, `bulwark://sign-in/callback?code=${code}&state=${encodeURIComponent(state)}`);

    await link('attacker-code', 'attacker-state');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(codes).toEqual([]);
    await expect(page.getByTestId('desktop-browser-waiting')).toBeVisible();

    await link('real-code', target.searchParams.get('state')!);
    await expect.poll(() => codes, { timeout: 30_000 }).toEqual(['real-code']);
    await expect(page.getByTestId('desktop-notice')).toBeVisible();

    // A flow that's over takes no more.
    await link('late-code', target.searchParams.get('state')!);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(codes).toEqual(['real-code']);

    await app.close();
    removeProfile(profile);
    server.close();
    server.closeAllConnections();
  });
});

const INSTANCES = [
  { label: '1.0', server: process.env['BULWARK_TEST_INSTANCE_1.0'] ?? '', jmap: STALWARTS[0].url },
  { label: '0.16', server: process.env['BULWARK_TEST_INSTANCE_0.16'] ?? '', jmap: STALWARTS[1].url },
  { label: 'strict cookies', server: process.env.BULWARK_TEST_INSTANCE_STRICT ?? '', jmap: STALWARTS[0].url },
];

/** An instance over https, as anyone runs one, so its cookies are what they'd be. */
async function httpsRelay(server: string): Promise<{ origin: string; stop: () => void }> {
  const certificate = generateCertificate('localhost');
  const target = new URL(server);
  const relay = createHttpsServer({ key: certificate.keyPem, cert: certificate.certPem }, (req, res) => {
    const upstream = httpRequest(
      { host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host } },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  return {
    origin: `https://localhost:${(relay.address() as AddressInfo).port}`,
    stop: () => {
      relay.close();
      relay.closeAllConnections();
    },
  };
}

for (const { label, server } of INSTANCES) {
  test.describe(`on an instance, ${label}`, () => {
    test.skip(!server, `needs its BULWARK_TEST_INSTANCE variable`);
    let relay: Awaited<ReturnType<typeof httpsRelay>>;

    test.beforeAll(async () => {
      relay = await httpsRelay(server);
    });
    test.afterAll(() => relay?.stop());

    async function start(...args: string[]) {
      const profile = tempProfile('bs-inst');
      const app = await launch(profile, `--instance=${relay.origin}/`, '--ignore-certificate-errors', ...args);
      const page = await shownPage(app);
      await fakeOsIntegration(app);
      await waitForLogin(page);
      return { profile, app, page };
    }

    test('its own login page signs the app in, the browser stays signed out, and the code works once', async () => {
      const { profile, app, page } = await start();
      const output = watchOutput(app, page);
      if (label === '1.0') await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-browser-signin-instance.png') });
      await page.getByTestId('desktop-browser-sign-in').click();
      const opening = new URL(await nextOpened(app));
      // The real origin, so saved passwords match, and no secret in the address.
      expect(opening.origin).toBe(relay.origin);
      expect(opening.pathname).toMatch(/\/[a-zA-Z-]+\/login$/);
      expect(opening.searchParams.get('mobile_code_challenge')).toMatch(/^[\w-]{43}$/);
      const listener = Number(new URL(opening.searchParams.get('mobile_redirect_uri')!).port);

      const context = await systemBrowser();
      const tab = await context.newPage();
      let landedAt = '';
      tab.on('request', (request) => {
        if (request.url().startsWith('http://127.0.0.1')) landedAt = request.url();
      });
      await tab.goto(opening.toString());
      await expect(tab.getByTestId('desktop-handoff-banner')).toBeVisible({ timeout: 60_000 });
      if (label === '1.0') await tab.screenshot({ path: path.join(SCREENSHOTS, 'desktop-browser-signin-instance-browser.png') });
      await tab.fill('#username', ACCOUNT);
      await tab.fill('#password', ENT_PASSWORD);
      await tab.keyboard.press('Enter');
      // Nothing leaves before the user says so.
      const confirm = tab.getByRole('button', { name: 'Sign in to the app' });
      await expect(confirm).toBeVisible({ timeout: 30_000 });
      if (label === '1.0') await tab.screenshot({ path: path.join(SCREENSHOTS, 'desktop-browser-signin-instance-consent.png') });
      expect(await portState(listener)).toBe('open');
      await watchForward(app, true);
      await confirm.click();
      await expect(tab.locator('body')).toContainText('close this tab', { timeout: 30_000 });

      await expectMailShown(page);
      expect(await forwardCount(app)).toBe(1);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false);
      expect(await isFocused(app)).toBe(true);
      await expect.poll(() => portState(listener)).toBe('closed');

      // Tokens rather than the password, and still a password account, under the name typed (#1432).
      const account = await page.evaluate(() => (JSON.parse(localStorage.getItem('account-registry') ?? '{}') as { state?: { accounts?: { id: string; authMode: string; providerSession?: boolean; username: string }[] } }).state?.accounts?.[0]);
      expect(account).toMatchObject({ authMode: 'oauth', providerSession: false, username: ACCOUNT });

      // No session in the browser: not a cookie, and the instance shows it the login page.
      const cookies = await context.cookies(relay.origin);
      expect(cookies.filter((cookie) => /^(jmap|session|bulwark)/i.test(cookie.name)).map((cookie) => cookie.name)).toEqual([]);
      const home = await context.newPage();
      await home.goto(`${relay.origin}/en/login`);
      await home.locator('#username').waitFor({ timeout: 60_000 });
      await home.close();

      // The code is spent.
      const code = new URL(landedAt).searchParams.get('code')!;
      expect(code).toMatch(/^[0-9a-f]{64}$/);
      const replay = await page.evaluate(async (value) => {
        const res = await fetch('/api/auth/desktop-handoff/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: value, code_verifier: 'x'.repeat(50), slot: 3 }) });
        return { status: res.status, body: await res.text() };
      }, code);
      expect(replay.status).toBe(400);
      expect(replay.body).not.toContain(ENT_PASSWORD);

      // Nothing secret went anywhere it stays.
      expect(output()).not.toContain(code);
      expect(output()).not.toContain(ENT_PASSWORD);

      // The app's session stands by itself.
      await page.reload();
      await expectMailShown(page);

      await context.close();
      await app.close();
      removeProfile(profile);
    });

    test('with a second factor: asked for in the browser, and the app gets its own token cookie', async () => {
      test.skip(!TOTP_SECRET, 'needs BULWARK_TEST_TOTP_SECRET');
      const { profile, app, page } = await start();
      await page.getByTestId('desktop-browser-sign-in').click();
      const context = await systemBrowser();
      const tab = await context.newPage();
      await tab.goto(await nextOpened(app));
      await tab.fill('#username', TOTP_ACCOUNT);
      await tab.fill('#password', ENT_PASSWORD);
      await tab.keyboard.press('Enter');
      await expect(tab.locator('#totp')).toBeVisible({ timeout: 30_000 });
      await tab.fill('#totp', await freshTotp(TOTP_SECRET));
      await tab.keyboard.press('Enter');
      await tab.getByRole('button', { name: 'Sign in to the app' }).click({ timeout: 30_000 });
      await expect(tab.locator('body')).toContainText('close this tab', { timeout: 30_000 });
      await expectMailShown(page);
      const registry = JSON.parse((await page.evaluate(() => localStorage.getItem('account-registry'))) ?? '{}');
      expect(JSON.stringify(registry)).toContain('"authMode":"oauth"');
      expect(JSON.stringify(registry)).toContain('"providerSession":false');
      const cookies = await context.cookies(relay.origin);
      expect(cookies.filter((cookie) => cookie.name.startsWith('jmap_')).map((cookie) => cookie.name)).toEqual([]);
      const appCookies = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.cookies.get({}));
      const refresh = appCookies.find((cookie) => cookie.name.startsWith('jmap_rt'));
      expect(refresh?.httpOnly).toBe(true);
      if (label === 'strict cookies') expect(refresh?.sameSite).toBe('strict');
      await page.reload();
      await expectMailShown(page);
      await context.close();
      await app.close();
      removeProfile(profile);
    });

    test('a link someone sends: nothing arrives before the question, "Not now" sends no code, and the app stays as it is', async () => {
      test.skip(label !== '1.0', 'once is enough');
      const { profile, app, page } = await start();
      // What another user on a shared computer runs: a listener of their own and a link to it.
      const arrived: string[] = [];
      const evil = createHttpServer((req, res) => {
        arrived.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Evil</title>');
      });
      await new Promise<void>((resolve) => evil.listen(0, '127.0.0.1', resolve));
      const port = (evil.address() as AddressInfo).port;
      const link = new URL(`${relay.origin}/en/login`);
      link.searchParams.set('mobile_redirect_uri', `http://127.0.0.1:${port}/bulwark-desktop/callback`);
      link.searchParams.set('mobile_state', 'attacker');
      link.searchParams.set('mobile_code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
      const context = await systemBrowser();
      const tab = await context.newPage();
      await tab.goto(link.toString());
      await expect(tab.getByTestId('desktop-handoff-banner')).toContainText("didn't start this", { timeout: 60_000 });
      await tab.fill('#username', ACCOUNT);
      await tab.fill('#password', ENT_PASSWORD);
      await tab.keyboard.press('Enter');
      const dialog = tab.getByRole('dialog').or(tab.getByRole('alertdialog')).first();
      // The question names the port and what to do if this wasn't you. Until it's answered, nothing has gone.
      await expect(dialog).toContainText(String(port), { timeout: 30_000 });
      await expect(dialog).toContainText(/trying to get into your account/);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(arrived).toEqual([]);

      await tab.getByRole('button', { name: 'Not now' }).click();
      await expect.poll(() => arrived.length).toBe(1);
      expect(arrived[0]).toContain('error=access_denied');
      expect(arrived[0]).not.toContain('code=');

      // And with a yes, only a code: never the password, and it's no use without the verifier.
      const again = await context.newPage();
      await again.goto(link.toString());
      await expect(again.getByTestId('desktop-handoff-banner')).toBeVisible({ timeout: 60_000 });
      await again.fill('#username', ACCOUNT);
      await again.fill('#password', ENT_PASSWORD);
      await again.keyboard.press('Enter');
      await again.getByRole('button', { name: 'Sign in to the app' }).click({ timeout: 30_000 });
      await expect.poll(() => arrived.length, { timeout: 30_000 }).toBe(2);
      expect(new URL(arrived[1], 'http://x').searchParams.get('code')).toMatch(/^[0-9a-f]{64}$/);
      expect(arrived[1]).not.toContain(encodeURIComponent(ENT_PASSWORD));

      await expect(page.locator('#username')).toBeVisible();
      expect(await opened(app)).toEqual([]);
      expect(await page.evaluate(() => localStorage.getItem('account-registry') ?? '')).not.toContain('authMode');
      await context.close();
      await app.close();
      removeProfile(profile);
      evil.close();
      evil.closeAllConnections();
    });

    test('"Not now" in the browser ends the flow in the app at once', async () => {
      test.skip(label !== '1.0', 'once is enough');
      const { profile, app, page } = await start();
      await page.getByTestId('desktop-browser-sign-in').click();
      const opening = new URL(await nextOpened(app));
      const listener = Number(new URL(opening.searchParams.get('mobile_redirect_uri')!).port);
      const context = await systemBrowser();
      const tab = await context.newPage();
      await tab.goto(opening.toString());
      await tab.fill('#username', ACCOUNT);
      await tab.fill('#password', ENT_PASSWORD);
      await tab.keyboard.press('Enter');
      await tab.getByRole('button', { name: 'Not now' }).click({ timeout: 30_000 });
      await expect(tab.locator('body')).toContainText('Nothing was handed over', { timeout: 15_000 });
      await expect(page.getByTestId('desktop-notice')).toContainText('said no', { timeout: 15_000 });
      await expect.poll(() => portState(listener)).toBe('closed');
      // No session in the browser from it either.
      expect((await context.cookies(relay.origin)).filter((cookie) => cookie.name.startsWith('jmap_')).map((cookie) => cookie.name)).toEqual([]);
      await context.close();
      await app.close();
      removeProfile(profile);
    });

    test('forced to this instance, it opens this instance, and the list still counts', async () => {
      test.skip(label !== '1.0', 'once is enough');
      const policy = forcedPolicies({ InstanceUrl: `${relay.origin}/`, AllowedJmapServers: ['https://other.example.org'] });
      const profile = tempProfile('bs-forced');
      const app = await launch(profile, '--ignore-certificate-errors', policy.arg);
      const page = await shownPage(app);
      await fakeOsIntegration(app);
      await waitForLogin(page);
      await page.getByTestId('desktop-browser-sign-in').click();
      await expect(page.getByTestId('desktop-policy-notice')).toBeVisible();
      expect(await opened(app)).toEqual([]);
      await app.close();
      removeProfile(profile);
      policy.remove();
    });
  });
}

test.describe('on an OAuth-only instance', () => {
  const server = process.env.BULWARK_TEST_INSTANCE_SSO ?? '';
  test.skip(!server, 'needs BULWARK_TEST_INSTANCE_SSO');
  let relay: Awaited<ReturnType<typeof httpsRelay>>;
  test.beforeAll(async () => {
    relay = await httpsRelay(server);
  });
  test.afterAll(() => relay?.stop());

  test('no form in the app or the browser, the provider\'s page signs the app in, nothing stays in the browser', async () => {
    const profile = tempProfile('bs-sso');
    const app = await launch(profile, `--instance=${relay.origin}/`, '--ignore-certificate-errors');
    const page = await shownPage(app);
    await fakeOsIntegration(app);
    const button = page.getByTestId('desktop-browser-sign-in');
    await button.waitFor({ timeout: 90_000 });
    await expect(page.locator('#password')).toHaveCount(0);
    await button.click();

    const context = await systemBrowser();
    /** Through the provider's page, to the instance's question. */
    async function toTheQuestion(count: number) {
      const tab = await context.newPage();
      await tab.goto(await nextOpened(app, count));
      await expect(tab.getByTestId('desktop-handoff-banner')).toBeVisible({ timeout: 60_000 });
      await expect(tab.locator('#password')).toHaveCount(0);
      await tab.getByRole('button', { name: /single sign-on|sso|sign in/i }).first().click();
      await tab.waitForURL(/\/login\?/, { timeout: 30_000 });
      const username = tab.locator('input[autocomplete="username"]');
      await username.waitFor({ timeout: 30_000 });
      await username.fill(ACCOUNT);
      await tab.fill('input[autocomplete="current-password"]', ENT_PASSWORD);
      await tab.keyboard.press('Enter');
      const dialog = tab.getByRole('dialog').or(tab.getByRole('alertdialog')).first();
      await expect(dialog).toContainText('Sign in to the Bulwark app', { timeout: 60_000 });
      return { tab, dialog };
    }

    // "Not now" lands on no login page, ends the flow in the app at once, and leaves nothing.
    const declined = await toTheQuestion(1);
    // The account, not the server's address.
    await expect(declined.dialog).toContainText(ACCOUNT.split('@')[0]);
    await expect(declined.dialog).not.toContainText(new URL(server).host);
    await declined.tab.getByRole('button', { name: 'Not now' }).click();
    await expect(declined.tab.locator('body')).toContainText('Nothing was handed over', { timeout: 15_000 });
    expect(declined.tab.url()).toContain('error=access_denied');
    expect(declined.tab.url()).not.toContain('code=');
    await expect(page.getByTestId('desktop-notice')).toContainText('said no', { timeout: 15_000 });
    expect((await context.cookies(relay.origin)).filter((cookie) => cookie.name.startsWith('jmap_')).map((cookie) => cookie.name)).toEqual([]);
    await page.getByTestId('desktop-browser-sign-in').click();

    const accepted = await toTheQuestion(2);
    const { tab } = accepted;
    await tab.getByRole('button', { name: 'Sign in to the app' }).click();
    await expect(tab.locator('body')).toContainText('close this tab', { timeout: 30_000 });
    await expectMailShown(page);
    // Through a provider's page: a provider session, as any SSO sign-in.
    expect(await page.evaluate(() => localStorage.getItem('account-registry') ?? '')).toContain('"providerSession":true');
    const cookies = await context.cookies(relay.origin);
    expect(cookies.filter((cookie) => cookie.name.startsWith('jmap_')).map((cookie) => cookie.name)).toEqual([]);
    await page.reload();
    await expectMailShown(page);
    await context.close();
    await app.close();
    removeProfile(profile);
  });
});
