import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { generateCertificate } from '../src/main/cert';
import { helperFile } from '../src/main/native-loader';
import { fakeOsIntegration, launch, opened, prompts, removeProfile, SCREENSHOTS, shownPage, tempProfile } from './helpers';

/**
 * Policies against the real registry under the test root, on the real app, with a
 * local server standing in for an instance. Needs a test build: `node build.mjs --test`.
 */
test.skip(process.platform !== 'win32', 'the test root is a registry key');

/** A row per test. Playwright has no test.each. */
function each<const Row>(rows: readonly Row[]) {
  return (title: string, run: (...args: Row extends readonly unknown[] ? [...Row] : [Row]) => void | Promise<void>) => {
    for (const row of rows) {
      const args = (Array.isArray(row) ? row : [row]) as Row extends readonly unknown[] ? [...Row] : [Row];
      test(title.replace('%s', () => String(args[0] || '(empty)')), () => run(...args));
    }
  };
}

const BASE = 'HKCU\\Software\\BulwarkTest';
const ROOT = `${BASE}\\Policies`;
const POLL = '--bulwark-test-policy-poll=250';
let run = 0;

function reg(...args: string[]): void {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`reg ${args.join(' ')}: ${result.stderr}`);
}

const key = (root: string, level: 'Machine' | 'User', sub = '') => `${root}\\${level}${sub ? `\\${sub}` : ''}`;

function setString(where: string, name: string, value: string): void {
  reg('add', where, '/v', name, '/t', 'REG_SZ', '/d', value, '/f');
}

function setNumber(where: string, name: string, value: number): void {
  reg('add', where, '/v', name, '/t', 'REG_DWORD', '/d', String(value), '/f');
}

function freshRoot(): string {
  run += 1;
  return `${ROOT}\\run${process.pid}-${run}`;
}

const rootArg = (root: string) => `--bulwark-test-policy-root=${root}`;

const certificate = generateCertificate('localhost');
let servers: Server[] = [];
let instanceA = '';
let instanceB = '';
let insecure = '';

const page = '<!doctype html><title>Stand-in instance</title><h1 id="stand-in">A Bulwark server</h1>';

async function serve(secure: boolean): Promise<string> {
  const handler: Parameters<typeof createHttpServer>[1] = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page);
  };
  const server = secure ? createHttpsServer({ key: certificate.keyPem, cert: certificate.certPem }, handler) : createHttpServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `${secure ? 'https' : 'http'}://localhost:${(server.address() as AddressInfo).port}/`;
}

test.beforeAll(async () => {
  // Nothing of ours may be there before, and nothing is left after.
  expect(spawnSync('reg.exe', ['query', BASE], { windowsHide: true }).status).toBe(1);
  instanceA = await serve(true);
  instanceB = await serve(true);
  insecure = await serve(false);
});

test.afterAll(async () => {
  for (const server of servers) server.close();
  servers = [];
  spawnSync('reg.exe', ['delete', BASE, '/f'], { windowsHide: true });
  expect(spawnSync('reg.exe', ['query', BASE], { windowsHide: true }).status).toBe(1);
});

interface Started {
  app: ElectronApplication;
  page: Page;
  profile: string;
}

const running: Started[] = [];

async function start(root: string, options: { profile?: string; state?: object; args?: string[] } = {}): Promise<Started> {
  const profile = options.profile ?? tempProfile('policy');
  if (options.state) writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify(options.state));
  const app = await launch(profile, rootArg(root), POLL, '--ignore-certificate-errors', ...(options.args ?? []));
  const shown = await shownPage(app);
  await fakeOsIntegration(app);
  const started = { app, page: shown, profile };
  running.push(started);
  return started;
}

async function stop(started: Started, keepProfile = false): Promise<void> {
  await started.app.close().catch(() => {});
  running.splice(running.indexOf(started), 1);
  if (!keepProfile) removeProfile(started.profile);
}

test.afterEach(async () => {
  for (const started of [...running]) await stop(started);
});

function bridgePolicy(target: Page): Promise<Record<string, { value: unknown; source: string; locked: boolean; invalid?: string }>> {
  return target.evaluate(() => (window as unknown as { bulwarkDesktop: { policy: { get(): never } } }).bulwarkDesktop.policy.get());
}

const menuLabels = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.flatMap((item) => item.submenu?.items.map((sub) => sub.label) ?? []));

const hasServer = (app: ElectronApplication) =>
  app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().some((m) => m.type === 'Utility' && m.name === 'Bulwark mail service'));

const windowUrls = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()));

test.describe('precedence, on the real registry', () => {
  test('forced machine > forced user > recommended machine > recommended user > default', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    // Forced machine over forced user.
    setString(key(root, 'Machine'), 'UpdateChannel', 'beta');
    setString(key(root, 'User'), 'UpdateChannel', 'stable');
    // Forced user over recommended machine.
    setNumber(key(root, 'User'), 'AutoUpdate', 0);
    setNumber(key(root, 'Machine', 'Recommended'), 'AutoUpdate', 1);
    // Recommended machine over recommended user.
    setNumber(key(root, 'Machine', 'Recommended'), 'AppLockTimeoutMinutes', 5);
    setNumber(key(root, 'User', 'Recommended'), 'AppLockTimeoutMinutes', 9);
    // Only recommended user.
    setString(key(root, 'User', 'Recommended'), 'QuickComposeShortcut', 'Ctrl+Alt+M');
    // A list: the stronger level's as a whole.
    setString(key(root, 'Machine', 'PluginAllowlist'), '1', 'machine-plugin');
    setString(key(root, 'User', 'PluginAllowlist'), '1', 'user-plugin');
    setString(key(root, 'User', 'PluginAllowlist'), '2', 'second-user-plugin');

    const started = await start(root);
    const policy = await bridgePolicy(started.page);
    expect(policy.UpdateChannel).toMatchObject({ value: 'beta', source: 'forced-machine', locked: true });
    expect(policy.AutoUpdate).toMatchObject({ value: false, source: 'forced-user', locked: true });
    expect(policy.AppLockTimeoutMinutes).toMatchObject({ value: 5, source: 'recommended-machine', locked: false });
    expect(policy.QuickComposeShortcut).toMatchObject({ value: 'Ctrl+Alt+M', source: 'recommended-user', locked: false });
    expect(policy.PluginAllowlist).toMatchObject({ value: ['machine-plugin'], source: 'forced-machine' });
    expect(policy.TelemetryAllowed).toMatchObject({ value: true, source: 'default', locked: false });
  });

  test('the user\'s choice beats a recommended server and loses to a forced one', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine', 'Recommended'), 'InstanceUrl', instanceA);
    const state = { mode: 'instance', instanceUrl: instanceB };
    const profile = tempProfile('policy');

    const chosen = await start(root, { profile, state });
    expect(new URL(chosen.page.url()).origin).toBe(new URL(instanceB).origin);
    expect(await menuLabels(chosen.app)).toContain('Change connection…');
    await stop(chosen, true);

    setString(key(root, 'User'), 'InstanceUrl', instanceA);
    const forced = await start(root, { profile });
    expect(new URL(forced.page.url()).origin).toBe(new URL(instanceA).origin);
    await stop(forced);
  });

  test('a recommended server opens with no choice stored, and the user can still change it', async () => {
    const root = freshRoot();
    setString(key(root, 'User', 'Recommended'), 'InstanceUrl', instanceA);
    const started = await start(root);
    expect(new URL(started.page.url()).origin).toBe(new URL(instanceA).origin);
    expect((await bridgePolicy(started.page)).InstanceUrl).toMatchObject({ locked: false, source: 'recommended-user' });
    expect(await menuLabels(started.app)).toContain('Change connection…');
  });
});

test.describe('a forced InstanceUrl', () => {
  test('starts on it, with no choice of server, and the window stays there', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    const started = await start(root);
    const { app, page: window } = started;

    expect(new URL(window.url()).origin).toBe(new URL(instanceA).origin);
    await expect(window.locator('#stand-in')).toBeVisible();
    expect(await hasServer(app)).toBe(false);
    expect((await bridgePolicy(window)).InstanceUrl).toMatchObject({ value: instanceA, source: 'forced-machine', locked: true });

    // The way to change it is gone.
    expect(await menuLabels(app)).not.toContain('Change connection…');

    // Everything else goes to the browser.
    await window.evaluate(() => {
      location.href = 'https://example.com/elsewhere';
    });
    await expect.poll(() => opened(app)).toContain('https://example.com/elsewhere');
    expect(new URL(window.url()).origin).toBe(new URL(instanceA).origin);
  });

  test('nothing the user stored or passes on the command line gets around it', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    for (const args of [['--standalone'], [`--instance=${instanceB}`]]) {
      const started = await start(root, { args, state: { mode: 'standalone' } });
      expect(new URL(started.page.url()).origin).toBe(new URL(instanceA).origin);
      expect(await hasServer(started.app)).toBe(false);
      await stop(started);
    }
  });

  test('accounts added earlier stay on the disk, hidden, and come back when it\'s lifted', async () => {
    const root = freshRoot();
    const profile = tempProfile('policy');
    const earlier = {
      mode: 'standalone',
      approvedServers: [{ origin: 'https://lan.example', approvedAt: 1 }],
      corsOrigins: ['https://mail.other.example'],
    };
    const accountFile = path.join(profile, 'kept-account-data');
    writeFileSync(accountFile, 'mine');
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);

    const forced = await start(root, { profile, state: earlier });
    expect(await hasServer(forced.app)).toBe(false);
    await stop(forced, true);

    const stored = JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8'));
    expect(stored).toMatchObject(earlier);
    expect(readFileSync(accountFile, 'utf8')).toBe('mine');
    removeProfile(profile);
  });

  test('with AllowStandalone 1 the menu stays, and the user can pick direct connections', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    setNumber(key(root, 'Machine'), 'AllowStandalone', 1);
    const started = await start(root);
    expect(new URL(started.page.url()).origin).toBe(new URL(instanceA).origin);
    expect(await menuLabels(started.app)).toContain('Change connection…');
  });
});

test.describe('an invalid value fails closed', () => {
  const body = async (window: Page) => (await window.locator('body').innerText()).replace(/\s+/g, ' ');

  test('plain http without AllowInsecureInstance: an error page that names the policy, and no way on', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', insecure);
    const started = await start(root, { state: { mode: 'standalone' } });
    const { app, page: window } = started;

    expect(window.url()).toMatch(/^data:/);
    const text = await body(window);
    expect(text).toContain('InstanceUrl');
    expect(text).toContain('AllowInsecureInstance');
    expect(text).toContain(insecure);
    // Stored as standalone, and it still doesn't fall back to it.
    expect(await hasServer(app)).toBe(false);
    expect(await menuLabels(app)).not.toContain('Change connection…');
    expect(await windowUrls(app)).toHaveLength(1);
    await window.screenshot({ path: path.join(SCREENSHOTS, 'desktop-policy-error.png') });

    // The error page can't be navigated out of.
    await window.evaluate(() => {
      location.href = 'https://example.com/';
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(window.url()).toMatch(/^data:/);
  });

  each([
    ['file:///C:/Windows/win.ini'],
    ['javascript:alert(1)'],
    ['not a url at all'],
    ['https://user:secret@mail.example.com/'],
  ])('%s', async (value) => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', value);
    const started = await start(root);
    expect(started.page.url()).toMatch(/^data:/);
    expect(await body(started.page)).toContain('InstanceUrl');
    expect(await hasServer(started.app)).toBe(false);
  });

  test('a value of the wrong type', async () => {
    const root = freshRoot();
    setNumber(key(root, 'Machine'), 'InstanceUrl', 7);
    const started = await start(root);
    expect(started.page.url()).toMatch(/^data:/);
    expect(await body(started.page)).toContain('InstanceUrl');
  });

  test('a forced machine value that\'s wrong doesn\'t fall to a good one at user level', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', 'nonsense');
    setString(key(root, 'User'), 'InstanceUrl', instanceA);
    const started = await start(root);
    expect(started.page.url()).toMatch(/^data:/);
  });

  test('http with AllowInsecureInstance opens, with the bridge', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', insecure);
    setNumber(key(root, 'Machine'), 'AllowInsecureInstance', 1);
    const started = await start(root);
    expect(new URL(started.page.url()).origin).toBe(new URL(insecure).origin);
    expect((await bridgePolicy(started.page)).InstanceUrl.value).toBe(insecure);
  });

  test('a junk PluginsMode reaches the page as off', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    setString(key(root, 'Machine'), 'PluginsMode', 'banana');
    const started = await start(root);
    expect((await bridgePolicy(started.page)).PluginsMode).toMatchObject({ value: 'off', locked: true, invalid: 'unknown_value' });
  });
});

test.describe('AllowStandalone 0', () => {
  test('the first-run page offers no direct connection, and main refuses it if asked', async () => {
    const root = freshRoot();
    setNumber(key(root, 'Machine'), 'AllowStandalone', 0);
    const started = await start(root, { state: { mode: 'standalone', approvedServers: [{ origin: 'https://lan.example', approvedAt: 1 }] } });
    const { app, page: window } = started;
    expect(await hasServer(app)).toBe(false);
    await expect(window.locator('#standalone')).toBeHidden();
    await expect(window.locator('#url')).toBeVisible();
    const refused = await window.evaluate(() => (window as unknown as { bulwarkWelcome: { choose(c: object): Promise<unknown> } }).bulwarkWelcome.choose({ mode: 'standalone' }));
    expect(refused).toEqual({ ok: false, error: 'invalid_choice' });
    expect(await hasServer(app)).toBe(false);
  });

  test('the server chosen on the first-run page has to be valid under the policy', async () => {
    const root = freshRoot();
    setNumber(key(root, 'Machine'), 'AllowStandalone', 0);
    const started = await start(root);
    const choose = (url: string) => started.page.evaluate((target) => (window as unknown as { bulwarkWelcome: { choose(c: object): Promise<unknown> } }).bulwarkWelcome.choose({ mode: 'instance', url: target }), url);
    expect(await choose('http://plain.example')).toEqual({ ok: false, error: 'invalid_url' });
  });
});

test.describe('a live change', () => {
  test('tells the page at once and asks to restart, once', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    const started = await start(root);
    const { app, page: window } = started;
    // The relaunch is the one thing not done for real: the rest of the restart is.
    const marker = path.join(started.profile, 'relaunched');
    await app.evaluate(({ app: electronApp }, file) => {
      electronApp.relaunch = (() => {
        process.getBuiltinModule('node:fs').writeFileSync(file, 'yes');
      }) as typeof electronApp.relaunch;
    }, marker);
    const closed = new Promise((resolve) => app.process().once('exit', resolve));
    // Answer "Later" first.
    await fakeOsIntegration(app, 1);
    await window.evaluate(() => {
      const w = window as unknown as { __changes: unknown[]; bulwarkDesktop: { policy: { onChange(l: (s: unknown) => void): void } } };
      w.__changes = [];
      w.bulwarkDesktop.policy.onChange((s) => w.__changes.push(s));
    });

    // Something the page reads: no restart.
    setString(key(root, 'Machine'), 'PluginsMode', 'off');
    await expect.poll(() => bridgePolicy(window).then((p) => p.PluginsMode.value)).toBe('off');
    await expect.poll(() => window.evaluate(() => (window as unknown as { __changes: unknown[] }).__changes.length)).toBeGreaterThan(0);
    expect(await prompts(app)).toHaveLength(0);

    // The server: a question, and it stays where it is until the answer is yes.
    setString(key(root, 'Machine'), 'InstanceUrl', instanceB);
    await expect.poll(() => prompts(app).then((p) => p.length)).toBe(1);
    expect((await prompts(app))[0].message).toContain('changed the settings');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await prompts(app)).toHaveLength(1);
    expect(new URL(window.url()).origin).toBe(new URL(instanceA).origin);
    expect(existsSync(marker)).toBe(false);

    // Back where it started, then away again: asks again, and yes restarts.
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    await expect.poll(() => bridgePolicy(window).then((p) => p.InstanceUrl.value)).toBe(instanceA);
    await fakeOsIntegration(app, 0);
    setString(key(root, 'Machine'), 'InstanceUrl', instanceB);
    await closed;
    expect(readFileSync(marker, 'utf8')).toBe('yes');
  });

  test('a value turning bad also asks, and the next start is the error page', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    const profile = tempProfile('policy');
    const started = await start(root, { profile });
    await fakeOsIntegration(started.app, 1);
    setString(key(root, 'Machine'), 'InstanceUrl', 'nonsense');
    await expect.poll(() => prompts(started.app).then((p) => p.length)).toBe(1);
    await stop(started, true);
    const next = await start(root, { profile });
    expect(next.page.url()).toMatch(/^data:/);
  });

  test('the auth lists are switches before ready, and a refused one sets nothing', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    setString(key(root, 'Machine'), 'AuthServerAllowlist', '*.corp.example, intranet');
    setString(key(root, 'Machine'), 'AuthNegotiateDelegateAllowlist', '*');
    const started = await start(root);
    const switches = await started.app.evaluate(({ app }) => ({
      server: app.commandLine.getSwitchValue('auth-server-whitelist'),
      delegate: app.commandLine.hasSwitch('auth-negotiate-delegate-whitelist'),
    }));
    expect(switches).toEqual({ server: '*.corp.example,intranet', delegate: false });
  });
});

test.describe('the wipe nonce', () => {
  const stateOf = (profile: string) => JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8'));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));

  /** Leaves a marker in a page's IndexedDB, OPFS and localStorage. */
  const plant = (window: Page) =>
    window.evaluate(async () => {
      localStorage.setItem('wipe-marker', 'x');
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle('wipe-marker', { create: true });
      const writable = await file.createWritable();
      await writable.write('x');
      await writable.close();
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('wipe-marker', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('s');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          open.result.close();
          resolve();
        };
      });
    });

  const markers = (window: Page) =>
    window.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const opfs = await root.getFileHandle('wipe-marker').then(() => true, () => false);
      const idb = (await indexedDB.databases()).some((db) => db.name === 'wipe-marker');
      return { local: localStorage.getItem('wipe-marker') === 'x', opfs, idb };
    });
  const ALL = { local: true, opfs: true, idb: true };
  const NONE = { local: false, opfs: false, idb: false };

  test('deletes every partition, not only the open one, once per value, also across restarts', async () => {
    const root = freshRoot();
    const profile = tempProfile('policy');

    // Data on two servers. A is what's forced when the wipe comes.
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    let started = await start(root, { profile });
    await plant(started.page);
    expect(await markers(started.page)).toEqual(ALL);
    await stop(started, true);
    setString(key(root, 'Machine'), 'InstanceUrl', instanceB);
    started = await start(root, { profile });
    await plant(started.page);
    await stop(started, true);

    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    setString(key(root, 'Machine'), 'WipeOfflineData', 'first');
    // A window waiting to come back goes with the rest.
    writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({ ...stateOf(profile), session: [{ type: 'message', key: 'message:secret-id', url: `${instanceA}/popout/message/secret-id` }] }));
    started = await start(root, { profile });
    expect(await markers(started.page)).toEqual(NONE);
    expect(stateOf(profile).policyWipes).toEqual(['first']);
    await settle();
    expect(JSON.stringify(await windowUrls(started.app))).not.toContain('secret-id');
    expect(JSON.stringify(stateOf(profile).session ?? [])).not.toContain('secret-id');
    // Marked done: new data survives another start.
    await plant(started.page);
    await stop(started, true);

    started = await start(root, { profile });
    expect(await markers(started.page)).toEqual(ALL);
    await stop(started, true);

    // The other partition went too, though no page of it was open.
    reg('delete', key(root, 'Machine'), '/v', 'WipeOfflineData', '/f');
    setString(key(root, 'Machine'), 'InstanceUrl', instanceB);
    started = await start(root, { profile });
    expect(await markers(started.page)).toEqual(NONE);
    await stop(started, true);
    removeProfile(profile);
  });

  test('a new value while running wipes with the window open, and brings it back', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    const started = await start(root);
    await plant(started.page);
    // What the native windows keep locally: a copy to paste, and a window to bring back.
    const leftover = path.join(started.profile, 'clipboard-files', 'report.pdf');
    mkdirSync(path.dirname(leftover), { recursive: true });
    writeFileSync(leftover, 'x');
    await started.page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: '/popout/message/secret-id', emailId: 'secret-id' }));
    await expect.poll(() => JSON.stringify(stateOf(started.profile).session ?? [])).toContain('secret-id');
    setString(key(root, 'Machine'), 'WipeOfflineData', 'live');
    await expect.poll(() => (existsSync(path.join(started.profile, 'shell-state.json')) ? stateOf(started.profile).policyWipes : undefined)).toEqual(['live']);
    await expect(started.page.locator('#stand-in')).toBeVisible();
    expect(await markers(started.page)).toEqual(NONE);
    expect(existsSync(leftover)).toBe(false);
    await expect.poll(() => JSON.stringify(stateOf(started.profile).session ?? [])).not.toContain('secret-id');

    // An old value again: remembered per value.
    await plant(started.page);
    setString(key(root, 'Machine'), 'WipeOfflineData', 'next');
    await expect.poll(() => stateOf(started.profile).policyWipes).toEqual(['live', 'next']);
    await expect(started.page.locator('#stand-in')).toBeVisible();
    await plant(started.page);
    setString(key(root, 'Machine'), 'WipeOfflineData', 'live');
    await settle();
    expect(await markers(started.page)).toEqual(ALL);
  });

  test('the bridge has no way to take part: a page can\'t mark it done or put it off', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    const started = await start(root);
    const members = await started.page.evaluate(() => Object.keys((window as unknown as { bulwarkDesktop: { policy: object } }).bulwarkDesktop.policy).sort());
    expect(members).toEqual(['get', 'onChange']);
  });

  test('a recommended value does nothing', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    setString(key(root, 'Machine', 'Recommended'), 'WipeOfflineData', 'no');
    const started = await start(root);
    await plant(started.page);
    await settle();
    expect(await markers(started.page)).toEqual(ALL);
  });

  test('OfflineEnabled forced off clears store files in the partitions no page has open, keeping the rest there', async () => {
    const root = freshRoot();
    const profile = tempProfile('policy');
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    let started = await start(root, { profile });
    await plant(started.page);
    await stop(started, true);

    setString(key(root, 'Machine'), 'InstanceUrl', instanceB);
    setNumber(key(root, 'Machine'), 'OfflineEnabled', 0);
    started = await start(root, { profile });
    expect(stateOf(profile).offlineClearedForPolicy).toBe(true);
    await stop(started, true);

    reg('delete', key(root, 'Machine'), '/v', 'OfflineEnabled', '/f');
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    started = await start(root, { profile });
    expect(await markers(started.page)).toEqual({ local: true, opfs: false, idb: true });
    expect(stateOf(profile).offlineClearedForPolicy).toBeUndefined();
    await stop(started, true);
    removeProfile(profile);
  });
});

test.describe('KeystoreAllowedOrigins', () => {
  const access = (target: Page) =>
    target.evaluate(() => (window as unknown as { bulwarkDesktop: { keystore: { accessState(): Promise<string> } } }).bulwarkDesktop.keystore.accessState());

  test('a listed instance has the store, for as long as it is listed', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    setString(key(root, 'Machine', 'KeystoreAllowedOrigins'), '1', new URL(instanceA).origin);
    const started = await start(root);
    expect(await access(started.page)).toBe('policy');
    reg('delete', key(root, 'Machine', 'KeystoreAllowedOrigins'), '/f');
    await expect.poll(() => access(started.page)).toBe('off');
    await stop(started);
  });

  test('another origin on the list does nothing for this one', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    setString(key(root, 'Machine', 'KeystoreAllowedOrigins'), '1', new URL(instanceB).origin);
    const started = await start(root);
    expect(await access(started.page)).toBe('off');
    await stop(started);
  });
});

test.describe('"Later" on a forced change', () => {
  test('asks again and then restarts by itself, saving first', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    const started = await start(root, { args: ['--bulwark-test-policy-restart=300,6000'] });
    const { app } = started;
    const marker = path.join(started.profile, 'relaunched');
    await app.evaluate(({ app: electronApp }, file) => {
      electronApp.relaunch = (() => {
        process.getBuiltinModule('node:fs').writeFileSync(file, 'yes');
      }) as typeof electronApp.relaunch;
    }, marker);
    const closed = new Promise((resolve) => app.process().once('exit', resolve));
    await fakeOsIntegration(app, 1);
    setString(key(root, 'Machine'), 'InstanceUrl', instanceB);
    await expect.poll(() => prompts(app).then((p) => p.length), { timeout: 5500 }).toBeGreaterThan(1);
    await closed;
    expect(readFileSync(marker, 'utf8')).toBe('yes');
  });

  test('a change back in time calls it off', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    const started = await start(root, { args: ['--bulwark-test-policy-restart=300000,1500'] });
    await fakeOsIntegration(started.app, 1);
    setString(key(root, 'Machine'), 'InstanceUrl', instanceB);
    await expect.poll(() => prompts(started.app).then((p) => p.length)).toBe(1);
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(started.app.process().exitCode).toBeNull();
    expect(started.page.isClosed()).toBe(false);
  });
});

test.describe('a sign-in chain under a forced server', () => {
  test('ends when a page in it fails to load', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    const started = await start(root);
    const { app, page: window } = started;
    // An authorize request back to the instance, at an address that doesn't answer.
    const dead = new URL('https://localhost:1/authorize');
    dead.searchParams.set('redirect_uri', new URL('/cb', instanceA).toString());
    await window.evaluate((url) => {
      location.href = url;
    }, dead.toString());
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // No way back to the origin in between, which would end the chain anyway.
    await app.evaluate(({ BrowserWindow }) => {
      void BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("location.href = 'https://example.com/after-failed-chain'").catch(() => {});
    });
    await expect.poll(() => opened(app)).toContain('https://example.com/after-failed-chain');
  });
});

test.describe('AllowedJmapServers and a stored server', () => {
  test('a stored instance off the list goes to the choice, and one chosen there is refused', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine', 'AllowedJmapServers'), '1', instanceA);
    const started = await start(root, { state: { mode: 'instance', instanceUrl: instanceB } });
    await expect(started.page.locator('#url')).toBeAttached();
    const choose = (url: string) => started.page.evaluate((target) => (window as unknown as { bulwarkWelcome: { choose(c: object): Promise<unknown> } }).bulwarkWelcome.choose({ mode: 'instance', url: target }), url);
    expect(await choose(instanceB)).toEqual({ ok: false, error: 'policy' });
  });

  test('a recommendation can\'t reach what only a forced value decides', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', insecure);
    setNumber(key(root, 'Machine', 'Recommended'), 'AllowInsecureInstance', 1);
    const started = await start(root);
    expect(started.page.url()).toMatch(/^data:/);
  });

  test('a server off the list stops getting anything from the page, and is back when listed again', async () => {
    const root = freshRoot();
    const hits: string[] = [];
    const counting = createHttpsServer({ key: certificate.keyPem, cert: certificate.certPem }, (req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'access-control-allow-origin': '*' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => counting.listen(0, '127.0.0.1', resolve));
    servers.push(counting);
    const origin = `https://localhost:${(counting.address() as AddressInfo).port}`;
    setString(key(root, 'Machine', 'AllowedJmapServers'), '1', origin);
    const started = await start(root, { state: { mode: 'standalone', corsOrigins: [origin] } });
    const call = (name: string) => started.page.evaluate(async (url) => fetch(url, { mode: 'no-cors' }).then(() => 'reached', () => 'cancelled'), `${origin}/${name}`);

    expect(await call('before')).toBe('reached');
    expect(hits).toContain('/before');

    setString(key(root, 'Machine', 'AllowedJmapServers'), '1', 'https://other.example');
    // Polled, as the change takes a moment to arrive. Once one is cancelled, they all are.
    await expect.poll(() => call('during')).toBe('cancelled');
    expect(await call('still-off')).toBe('cancelled');
    expect(hits).not.toContain('/still-off');

    setString(key(root, 'Machine', 'AllowedJmapServers'), '1', origin);
    await expect.poll(() => call('after')).toBe('reached');
    expect(hits).toContain('/after');
    // Nothing was forgotten.
    expect(JSON.parse(readFileSync(path.join(started.profile, 'shell-state.json'), 'utf8')).corsOrigins).toEqual([origin]);
  });

  test('a bundle name that can\'t be decoded is refused, not a crash', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    setString(key(root, 'Machine'), 'PluginsMode', 'allowlist');
    const started = await start(root);
    const status = (name: string) => started.page.evaluate(async (url) => fetch(url).then((r) => r.status, () => 'cancelled'), new URL(`/api/admin/plugins/${name}/bundle`, instanceA).toString());
    expect(await status('%E0')).toBe('cancelled');
    expect(await status('refused')).toBe('cancelled');
    expect(await started.app.evaluate(() => 'alive')).toBe('alive');
  });
});

test.describe('plugins and mail servers in standalone mode', () => {
  test('main refuses an install, and a server off the list, before anyone is asked', async () => {
    const root = freshRoot();
    setString(key(root, 'Machine'), 'PluginsMode', 'allowlist');
    setString(key(root, 'Machine', 'PluginAllowlist'), '1', 'allowed-plugin');
    setString(key(root, 'Machine', 'AllowedJmapServers'), '1', 'https://allowed.example');
    const started = await start(root, { state: { mode: 'standalone' } });
    const { app, page: window } = started;
    const bridge = `(window.bulwarkDesktop)`;

    const install = await window.evaluate(`${bridge}.plugins.install('refused-plugin')`);
    expect(install).toEqual({ ok: false, error: 'blocked_by_policy', code: 'blocked_by_policy' });

    const refused = await window.evaluate(`${bridge}.servers.prepare('https://other.example')`);
    expect(refused).toEqual({ ok: false, reason: 'policy' });
    const allowed = await window.evaluate(`${bridge}.servers.prepare('https://allowed.example')`);
    expect(allowed).toEqual({ ok: true, approved: false });
    expect(await prompts(app)).toHaveLength(0);
  });

  test('plugins off also switches the server\'s own switches off, and lifting it brings them back', async () => {
    const root = freshRoot();
    const started = await start(root, { state: { mode: 'standalone' } });
    const policyFile = path.join(started.profile, 'webmail', 'admin', 'policy.json');
    const features = () => JSON.parse(readFileSync(policyFile, 'utf8')).features as { pluginsEnabled: boolean; pluginsUploadEnabled: boolean };
    expect(features()).toMatchObject({ pluginsEnabled: true, pluginsUploadEnabled: true });

    setString(key(root, 'Machine'), 'PluginsMode', 'allowlist');
    await expect.poll(() => features().pluginsUploadEnabled).toBe(false);
    expect(features().pluginsEnabled).toBe(true);

    setString(key(root, 'Machine'), 'PluginsMode', 'off');
    await expect.poll(() => features().pluginsEnabled).toBe(false);
    expect(features().pluginsUploadEnabled).toBe(false);

    reg('delete', key(root, 'Machine'), '/v', 'PluginsMode', '/f');
    await expect.poll(() => features().pluginsEnabled).toBe(true);
  });
});

test.describe('the keystore switched off', () => {
  const helperPath = () => helperFile({ packaged: false, mainDir: path.join(import.meta.dirname, '..', 'dist'), platform: process.platform, arch: process.arch });
  const hasMember = (window: Page) => window.evaluate(() => 'keystore' in (window as unknown as { bulwarkDesktop: object }).bulwarkDesktop);

  for (const [name, force] of [
    ['KeystoreEnabled 0', (root: string) => setNumber(key(root, 'Machine'), 'KeystoreEnabled', 0)],
    ['PluginsMode off', (root: string) => setString(key(root, 'Machine'), 'PluginsMode', 'off')],
  ] as const) {
    test(`${name} leaves it off the bridge`, async () => {
      test.skip(!existsSync(helperPath()), 'needs the native helper');
      const root = freshRoot();
      setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
      force(root);
      const started = await start(root);
      expect(await hasMember(started.page)).toBe(false);
    });
  }

  test('forced off while running, a page that has it gets unsupported, with no dialog', async () => {
    test.skip(!existsSync(helperPath()), 'needs the native helper');
    const root = freshRoot();
    setString(key(root, 'Machine'), 'InstanceUrl', instanceA);
    const started = await start(root);
    await fakeOsIntegration(started.app, 1);
    expect(await hasMember(started.page)).toBe(true);
    setNumber(key(root, 'Machine'), 'KeystoreEnabled', 0);
    await expect.poll(() => bridgePolicy(started.page).then((p) => p.KeystoreEnabled.value)).toBe(false);
    const answer = await started.page.evaluate(() => (window as unknown as { bulwarkDesktop: { keystore: { list(): Promise<unknown> } } }).bulwarkDesktop.keystore.list().then(() => 'listed', (error: Error) => error.message));
    expect(answer).toBe('keystore:unsupported');
    expect(await prompts(started.app)).toEqual([]);
    reg('delete', key(root, 'Machine'), '/v', 'KeystoreEnabled', '/f');
    await expect.poll(() => bridgePolicy(started.page).then((p) => p.KeystoreEnabled.value)).toBe(true);
  });
});
