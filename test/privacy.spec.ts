import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { userInfo } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasCollector, loadCollectorValidator } from './collector';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { generateCertificate } from '../src/main/cert';
import { APP_ORIGIN, ENT_PASSWORD, fakeOsIntegration, launch, prompts, removeProfile, SCREENSHOTS, shownPage, signIn, STALWARTS, tempProfile } from './helpers';

/**
 * Telemetry and crash reports, on the real app, watching a real socket: a local collector
 * and a local stand-in for the instance count what actually arrives. Needs a test build:
 * `node build.mjs --test`. Standalone with a rebuilt webmail: BULWARK_TEST_SERVER_DIR.
 */

const REG_BASE = 'HKCU\\Software\\BulwarkTest';
const REG_ROOT = `${REG_BASE}\\Policies\\privacy${process.pid}`;

interface Hit {
  method: string;
  path: string;
  body: Buffer;
}

let collector: Server;
let collectorUrl = '';
let hits: Hit[] = [];
let redirecting = false;
let refusing = false;
let instance: Server;
let instanceUrl = '';
let instanceHits: Hit[] = [];

const certificate = generateCertificate('localhost');
const running: { app: ElectronApplication; profile: string }[] = [];

test.beforeAll(async () => {
  collector = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', body: Buffer.concat(chunks) });
      if (refusing) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"ok":false}');
        return;
      }
      if (redirecting && req.url === '/v1/heartbeat') {
        res.writeHead(302, { location: `${collectorUrl}/followed` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  collectorUrl = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;

  instance = createHttpsServer({ key: certificate.keyPem, cert: certificate.certPem }, (req, res) => {
    instanceHits.push({ method: req.method ?? '', path: req.url ?? '', body: Buffer.alloc(0) });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Stand-in instance</title><h1>A Bulwark server</h1>');
  });
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  instanceUrl = `https://localhost:${(instance.address() as AddressInfo).port}/`;
});

test.afterAll(async () => {
  await new Promise((resolve) => collector.close(resolve));
  instance.closeAllConnections();
  await new Promise((resolve) => instance.close(resolve));
  // Only this run's own key: another run may be using the one next to it.
  spawnSync('reg.exe', ['delete', REG_ROOT, '/f'], { windowsHide: true });
});

test.beforeEach(() => {
  hits = [];
  instanceHits = [];
  redirecting = false;
  refusing = false;
});

test.afterEach(async () => {
  for (const { app, profile } of running.splice(0)) {
    await app.close().catch(() => {});
    removeProfile(profile);
  }
  spawnSync('reg.exe', ['delete', REG_ROOT, '/f'], { windowsHide: true });
});

const collectorArg = () => `--bulwark-test-telemetry-endpoint=${collectorUrl}/v1/heartbeat`;
const FAST = ['--bulwark-test-ping-delay=200', '--bulwark-test-errors-tick=200', '--bulwark-test-crash-sweep-delay=100'];
const POLICY_ARGS = [`--bulwark-test-policy-root=${REG_ROOT}`, '--bulwark-test-policy-poll=250'];

function forcePolicy(name: string, value: 0 | 1): void {
  const result = spawnSync('reg.exe', ['add', `${REG_ROOT}\\Machine`, '/v', name, '/t', 'REG_DWORD', '/d', String(value), '/f'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
}

function seed(profile: string, privacy: object | undefined): void {
  if (privacy) writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({ privacy }));
}

async function startInstance(options: { privacy?: object; profile?: string; args?: string[]; keep?: boolean } = {}): Promise<{ app: ElectronApplication; page: Page; profile: string }> {
  const profile = options.profile ?? tempProfile('privacy');
  seed(profile, options.privacy);
  const app = await launch(profile, `--instance=${instanceUrl}`, '--ignore-certificate-errors', collectorArg(), ...POLICY_ARGS, ...(options.args ?? FAST));
  const page = await shownPage(app);
  await fakeOsIntegration(app);
  if (!options.keep) running.push({ app, profile });
  return { app, page, profile };
}

interface PrivacyBridge {
  get(): Promise<{ telemetry: { on: boolean; forcedOff: boolean }; crashReports: { on: boolean; forcedOff: boolean; uploadUrl: string } }>;
  setTelemetry(on: boolean): Promise<{ telemetry: { on: boolean; forcedOff: boolean } }>;
  setCrashReports(on: boolean): Promise<{ crashReports: { on: boolean; forcedOff: boolean } }>;
  setCrashUploadUrl(url: string): Promise<{ ok: boolean }>;
  listCrashes(): Promise<{ id: string; createdAt: number; bytes: number }[]>;
  sendCrash(id: string): Promise<{ ok: boolean; reason?: string }>;
  deleteCrashes(): Promise<void>;
}

/** Records which method `call` wants, and makes that call in the page. CSP rules out passing code. */
function bridge<T>(page: Page, call: (privacy: PrivacyBridge, arg: string) => Promise<T>, arg = ''): Promise<T> {
  let method = '';
  let args: unknown[] = [];
  const recorder = new Proxy({}, {
    get: (_target, name) => (...given: unknown[]) => {
      method = String(name);
      args = given;
      return Promise.resolve();
    },
  }) as PrivacyBridge;
  void call(recorder, arg);
  return page.evaluate(
    ([name, given]) => (window as unknown as { bulwarkDesktop: { privacy: Record<string, (...a: unknown[]) => Promise<T>> } }).bulwarkDesktop.privacy[name as string](...(given as unknown[])),
    [method, args] as const,
  );
}

const heartbeats = () => hits.filter((hit) => hit.path === '/v1/heartbeat');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function storedPrivacy(profile: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8')) as { privacy?: Record<string, unknown> }).privacy ?? {};
}

async function realValidator() {
  test.skip(!hasCollector, 'the dashboard repo isn\'t here');
  return loadCollectorValidator();
}

test.describe('nothing before consent', () => {
  test('a fresh profile sends nothing to the collector, and has no id', async () => {
    const { profile } = await startInstance();
    await sleep(3000);
    expect(hits).toEqual([]);
    expect(existsSync(path.join(profile, 'shell-state.json')) ? storedPrivacy(profile).id : undefined).toBeUndefined();
  });

  test('saying no in the dialog sends nothing and stores no yes', async () => {
    const { app, page, profile } = await startInstance();
    await fakeOsIntegration(app, 1);
    const state = await bridge(page, (privacy) => privacy.setTelemetry(true));
    expect(state.telemetry.on).toBe(false);
    expect(await prompts(app)).toHaveLength(1);
    await sleep(1500);
    expect(hits).toEqual([]);
    expect(storedPrivacy(profile).telemetry).not.toBe(true);
  });

  test('a page can\'t say yes alone: the dialog comes first', async () => {
    const { app, page } = await startInstance();
    await bridge(page, (privacy) => privacy.setTelemetry(true));
    const asked = await prompts(app);
    expect(asked).toHaveLength(1);
    expect(asked[0].message).toContain('usage info');
  });
});

test.describe('the shell\'s own heartbeat in instance mode', () => {
  test('goes out once with consent, under its own id, and the real collector takes it', async () => {
    const collectorCode = await realValidator();
    const { page, app, profile } = await startInstance();
    const state = await bridge(page, (privacy) => privacy.setTelemetry(true));
    expect(state.telemetry.on).toBe(true);
    await expect.poll(() => heartbeats().length, { timeout: 15_000 }).toBeGreaterThan(0);
    const body = JSON.parse(heartbeats()[0].body.toString('utf8')) as Record<string, unknown>;
    const clean = collectorCode.validate(body)!;
    expect(clean).not.toBeNull();
    expect(clean.schema).toBe('1');
    expect(clean.build).toBe('desktop.instance.stable');
    expect(body.platform).toBe('desktop');
    expect(clean.platform).toBe('desktop');
    expect(clean.os_family).toBe(process.platform === 'win32' ? 'windows' : process.platform);
    // Any extra key would make schema 2 refuse it.
    expect(collectorCode.validate({ ...body, schema: '2', errors: [] })).not.toBeNull();
    expect(body.instance_id).toBe(storedPrivacy(profile).id);

    // Nothing the instance reports is counted again.
    expect(Object.values(body.features as object)).toEqual([false, false, false, false, false, false]);
    expect(body.counts).toEqual({ accounts: '0', accounts_active_7d: '0', extensions_installed: 0, themes_installed: 0 });
    expect(instanceHits.filter((hit) => hit.method === 'POST')).toEqual([]);
    expect(await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().filter((m) => m.name === 'Bulwark mail service').length)).toBe(0);
  });

  test('stops as soon as consent goes', async () => {
    // At this delay it keeps sending while it's on, so silence below is the switch's doing.
    const { page } = await startInstance({ privacy: { asked: true, telemetry: true }, args: ['--bulwark-test-ping-delay=300'] });
    await expect.poll(() => heartbeats().length, { timeout: 15_000 }).toBeGreaterThan(1);
    await bridge(page, (privacy) => privacy.setTelemetry(false));
    await sleep(500);
    hits = [];
    await sleep(2000);
    expect(hits).toEqual([]);
  });

  test('follows no redirect', async () => {
    redirecting = true;
    await startInstance({ privacy: { asked: true, telemetry: true } });
    await expect.poll(() => heartbeats().length, { timeout: 15_000 }).toBeGreaterThan(0);
    await sleep(1000);
    expect(hits.filter((hit) => hit.path === '/followed')).toEqual([]);
  });

  test('a failed send doesn\'t count as sent', async () => {
    redirecting = true;
    const { profile } = await startInstance({ privacy: { asked: true, telemetry: true } });
    await expect.poll(() => heartbeats().length, { timeout: 15_000 }).toBeGreaterThan(0);
    await sleep(500);
    expect(storedPrivacy(profile).lastPingAt).toBeUndefined();
  });

  test('due after a restart, it goes after the catch-up wait, not an hour', async () => {
    const threeDaysAgo = Date.now() - 3 * 86_400_000;
    await startInstance({ privacy: { asked: true, telemetry: true, lastPingAt: threeDaysAgo }, args: ['--bulwark-test-catch-up=300'] });
    await expect.poll(() => heartbeats().length, { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test('with no test switch it waits at least 30 s, so a start isn\'t readable from it', async () => {
    await startInstance({ privacy: { asked: true, telemetry: true, lastPingAt: Date.now() - 3 * 86_400_000 }, args: [] });
    await sleep(25_000);
    expect(hits).toEqual([]);
  });

  test('sent recently, a restart doesn\'t send again, even with the catch-up at nothing', async () => {
    await startInstance({ privacy: { asked: true, telemetry: true, lastPingAt: Date.now() - 3_600_000 }, args: ['--bulwark-test-catch-up=100'] });
    await sleep(3000);
    expect(hits).toEqual([]);
  });

  test('a collector that refuses it isn\'t asked again until tomorrow', async () => {
    refusing = true;
    const { profile } = await startInstance({ privacy: { asked: true, telemetry: true }, args: ['--bulwark-test-catch-up=100', '--bulwark-test-ping-retry=100'] });
    await expect.poll(() => heartbeats().length, { timeout: 15_000 }).toBeGreaterThan(0);
    await sleep(2000);
    expect(heartbeats()).toHaveLength(1);
    expect(storedPrivacy(profile).lastPingAt).toEqual(expect.any(Number));
  });
});

test.describe('the random ID', () => {
  test('goes when both consents go, and a yes after that makes a new one', async () => {
    const { page, profile } = await startInstance({ privacy: { asked: true, telemetry: true, crashReports: true }, args: ['--bulwark-test-catch-up=100'] });
    await expect.poll(() => storedPrivacy(profile).id, { timeout: 15_000 }).toEqual(expect.any(String));
    const first = storedPrivacy(profile).id;

    await bridge(page, (privacy) => privacy.setTelemetry(false));
    // One consent is left, and with it the ID.
    expect(storedPrivacy(profile).id).toBe(first);

    await bridge(page, (privacy) => privacy.setCrashReports(false));
    expect(storedPrivacy(profile).id).toBeUndefined();
    expect(storedPrivacy(profile).lastPingAt).toBeUndefined();

    hits = [];
    await bridge(page, (privacy) => privacy.setTelemetry(true));
    await expect.poll(() => heartbeats().length, { timeout: 15_000 }).toBeGreaterThan(0);
    const body = JSON.parse(heartbeats()[0].body.toString('utf8')) as { instance_id: string };
    expect(body.instance_id).not.toBe(first);
    expect(body.instance_id).toBe(storedPrivacy(profile).id);
  });

  test('goes at a start with both off, also the server\'s', async () => {
    const profile = tempProfile('privacy');
    const telemetry = path.join(profile, 'webmail', 'telemetry');
    mkdirSync(telemetry, { recursive: true });
    writeFileSync(path.join(telemetry, '.telemetry-id'), 'f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b');
    await startInstance({ profile, privacy: { asked: true, telemetry: false, crashReports: false, id: 'f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b' } });
    await expect.poll(() => storedPrivacy(profile).id).toBeUndefined();
    expect(existsSync(path.join(telemetry, '.telemetry-id'))).toBe(false);
  });

  test('goes in a wipe, with consent still on', async () => {
    test.skip(process.platform !== 'win32', 'the test root is a registry key');
    const profile = tempProfile('privacy');
    const telemetry = path.join(profile, 'webmail', 'telemetry');
    mkdirSync(telemetry, { recursive: true });
    writeFileSync(path.join(telemetry, '.telemetry-id'), 'f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b');
    mkdirSync(path.join(profile, 'crash-reports', 'reports'), { recursive: true });
    const planted = path.join(profile, 'crash-reports', 'reports', 'old.dmp');
    writeFileSync(planted, 'MDMP');
    const result = spawnSync('reg.exe', ['add', `${REG_ROOT}\\Machine`, '/v', 'WipeOfflineData', '/t', 'REG_SZ', '/d', `wipe-${Date.now()}`, '/f'], { encoding: 'utf8', windowsHide: true });
    expect(result.status).toBe(0);
    await startInstance({ profile, privacy: { asked: true, crashReports: true, id: 'f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b' }, args: ['--bulwark-test-errors-tick=60000'] });
    await expect.poll(() => storedPrivacy(profile).id, { timeout: 30_000 }).toBeUndefined();
    expect(existsSync(path.join(telemetry, '.telemetry-id'))).toBe(false);
    expect(existsSync(planted)).toBe(false);
  });
});

test.describe('BULWARK_TELEMETRY=off in the environment', () => {
  test('beats a stored yes in main too, and the bridge says it can\'t be changed', async () => {
    process.env.BULWARK_TELEMETRY = 'off';
    try {
      const { page, app } = await startInstance({ privacy: { asked: true, telemetry: true, crashReports: true }, args: ['--bulwark-test-catch-up=100', '--bulwark-test-errors-tick=200'] });
      await app.evaluate(() => {
        void Promise.reject(new TypeError('x'));
      });
      await sleep(1500);
      expect(hits).toEqual([]);
      const state = await bridge(page, (privacy) => privacy.get());
      expect(state.telemetry).toEqual({ on: false, forcedOff: true });
      expect(state.crashReports).toMatchObject({ on: false, forcedOff: true });
    } finally {
      delete process.env.BULWARK_TELEMETRY;
    }
  });
});

test.describe('a policy forcing it off', () => {
  test.skip(process.platform !== 'win32', 'the test root is a registry key');

  test('beats a stored yes for telemetry: nothing sent, and the bridge says who decided', async () => {
    forcePolicy('TelemetryAllowed', 0);
    const { page, app } = await startInstance({ privacy: { asked: true, telemetry: true } });
    await sleep(2500);
    expect(hits).toEqual([]);
    const state = await bridge(page, (privacy) => privacy.get());
    expect(state.telemetry).toEqual({ on: false, forcedOff: true });
    const after = await bridge(page, (privacy) => privacy.setTelemetry(true));
    expect(after.telemetry.on).toBe(false);
    expect(await prompts(app)).toEqual([]);
  });

  test('stops a running app, live, and lifting it leaves the user\'s yes', async () => {
    const { page } = await startInstance({ privacy: { asked: true, telemetry: true, lastPingAt: Date.now() - 3_600_000 }, args: ['--bulwark-test-ping-delay=1500'] });
    forcePolicy('TelemetryAllowed', 0);
    await expect.poll(async () => (await bridge(page, (privacy) => privacy.get())).telemetry.forcedOff, { timeout: 10_000 }).toBe(true);
    // One already on its way when the policy came may still land.
    await sleep(500);
    hits = [];
    await sleep(2500);
    expect(hits).toEqual([]);
    spawnSync('reg.exe', ['delete', `${REG_ROOT}\\Machine`, '/v', 'TelemetryAllowed', '/f'], { windowsHide: true });
    await expect.poll(async () => (await bridge(page, (privacy) => privacy.get())).telemetry, { timeout: 10_000 }).toEqual({ on: true, forcedOff: false });
  });

  test('beats a stored yes for crash reports: no reporter, no files, no sending', async () => {
    forcePolicy('CrashReportsAllowed', 0);
    const profile = tempProfile('privacy');
    mkdirSync(path.join(profile, 'crash-reports', 'reports'), { recursive: true });
    const planted = path.join(profile, 'crash-reports', 'reports', 'old.dmp');
    writeFileSync(planted, 'MDMP');
    const { page, app } = await startInstance({ profile, privacy: { asked: true, crashReports: true, crashUploadUrl: `${collectorUrl}/upload` } });
    expect(existsSync(planted)).toBe(false);
    expect(await app.evaluate(({ crashReporter }) => crashReporter.getUploadToServer())).toBe(false);
    expect((await bridge(page, (privacy) => privacy.get())).crashReports).toMatchObject({ on: false, forcedOff: true });
    expect(await bridge(page, (privacy, id) => privacy.sendCrash(id), 'old')).toEqual({ ok: false, reason: 'no-consent' });
    expect(hits).toEqual([]);
  });

  test('taking effect live, it removes crash files already there', async () => {
    const profile = tempProfile('privacy');
    mkdirSync(path.join(profile, 'crash-reports', 'reports'), { recursive: true });
    const planted = path.join(profile, 'crash-reports', 'reports', 'old.dmp');
    writeFileSync(planted, 'MDMP');
    await startInstance({ profile, privacy: { asked: true, crashReports: true } });
    expect(existsSync(planted)).toBe(true);
    forcePolicy('CrashReportsAllowed', 0);
    await expect.poll(() => existsSync(planted), { timeout: 10_000 }).toBe(false);
  });
});

test.describe('the first run', () => {
  async function startFresh(profile: string, args: string[] = []): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await launch(profile, '--ignore-certificate-errors', collectorArg(), ...POLICY_ARGS, ...FAST, ...args);
    const page = await shownPage(app);
    running.push({ app, profile });
    return { app, page };
  }

  async function chooseInstance(page: Page): Promise<void> {
    await page.locator('#instance').click();
    await page.locator('#url').fill(instanceUrl);
    await page.locator('#connect').click();
  }

  test('asks with both boxes empty, nothing leaves before Continue, and empty means off', async () => {
    const profile = tempProfile('privacy');
    const { app, page } = await startFresh(profile);
    await chooseInstance(page);
    await page.locator('#privacy.open').waitFor();
    await expect(page.locator('#telemetry')).not.toBeChecked();
    await expect(page.locator('#crash')).not.toBeChecked();
    // It says what goes, in plain words, before anyone agrees.
    await expect(page.locator('#crash-text')).toContainText('a random ID');
    await expect(page.locator('#crash-text')).toContainText('text of your mail');
    for (const words of ['a random ID', 'Node version', 'how long the app has been running', 'how many plugins and themes']) {
      await expect(page.locator('#telemetry-text')).toContainText(words);
    }
    await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-telemetry-first-run.png') });
    await sleep(1000);
    expect(hits).toEqual([]);
    await page.locator('#continue').click();
    await expect.poll(() => app.windows().some((w) => !w.isClosed() && w.url().startsWith(instanceUrl)), { timeout: 30_000 }).toBe(true);
    await sleep(1500);
    expect(hits).toEqual([]);
    const stored = storedPrivacy(profile);
    expect(stored).toMatchObject({ asked: true, telemetry: false, crashReports: false });
  });

  test('a tick is a yes, each on its own', async () => {
    const profile = tempProfile('privacy');
    const { app, page } = await startFresh(profile);
    await chooseInstance(page);
    await page.locator('#privacy.open').waitFor();
    await page.locator('#telemetry').check();
    await page.locator('#continue').click();
    await expect.poll(() => app.windows().some((w) => !w.isClosed() && w.url().startsWith(instanceUrl)), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => heartbeats().length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(storedPrivacy(profile)).toMatchObject({ asked: true, telemetry: true, crashReports: false });
  });

  test('closing the window at the question leaves the first run to do', async () => {
    const profile = tempProfile('privacy');
    const { page } = await startFresh(profile);
    await chooseInstance(page);
    await page.locator('#privacy.open').waitFor();
    const state = existsSync(path.join(profile, 'shell-state.json')) ? JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8')) as { mode?: string } : {};
    expect(state.mode).toBeUndefined();
  });

  test('asks nothing a policy forced off, and nothing at all when both are', async () => {
    test.skip(process.platform !== 'win32', 'the test root is a registry key');
    forcePolicy('TelemetryAllowed', 0);
    const profile = tempProfile('privacy');
    const first = await startFresh(profile);
    await chooseInstance(first.page);
    await first.page.locator('#privacy.open').waitFor();
    expect(await first.page.locator('#telemetry').count()).toBe(0);
    expect(await first.page.locator('#crash').count()).toBe(1);
    await first.app.close();
    running.splice(0);
    removeProfile(profile);

    forcePolicy('CrashReportsAllowed', 0);
    const second = tempProfile('privacy');
    const { app, page } = await startFresh(second);
    await chooseInstance(page);
    await expect.poll(() => app.windows().some((w) => !w.isClosed() && w.url().startsWith(instanceUrl)), { timeout: 30_000 }).toBe(true);
    expect(storedPrivacy(second).telemetry).toBeUndefined();
  });

  test('a later change of connection doesn\'t ask again', async () => {
    const profile = tempProfile('privacy');
    seed(profile, { asked: true, telemetry: false, crashReports: true });
    const { app, page } = await startFresh(profile);
    await chooseInstance(page);
    await expect.poll(() => app.windows().some((w) => !w.isClosed() && w.url().startsWith(instanceUrl)), { timeout: 30_000 }).toBe(true);
    expect(storedPrivacy(profile)).toMatchObject({ telemetry: false, crashReports: true });
  });
});

test.describe('crash files', () => {
  const dumps = (profile: string): string[] => {
    const dir = path.join(profile, 'crash-reports', 'reports');
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.dmp')) : [];
  };

  async function crashMain(app: ElectronApplication): Promise<void> {
    const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await app.evaluate(() => {
      setTimeout(() => process.crash(), 50);
    }).catch(() => {});
    await gone;
  }

  test('with consent, a real crash leaves a dump, kept, and it leaves only by the action', async () => {
    const profile = tempProfile('privacy');
    const url = `${collectorUrl}/upload`;
    const first = await startInstance({ profile, keep: true, privacy: { asked: true, crashReports: true, crashUploadUrl: url } });
    await crashMain(first.app);
    await expect.poll(() => dumps(profile).length, { timeout: 15_000 }).toBeGreaterThan(0);

    const { app, page } = await startInstance({ profile, privacy: undefined });
    await sleep(2000);
    // Nothing went on its own: not at the crash, not at the next start, with a URL set.
    expect(hits).toEqual([]);
    const list = await bridge(page, (privacy) => privacy.listCrashes());
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].bytes).toBeGreaterThan(1000);

    // The user says no in the dialog: still nothing.
    await fakeOsIntegration(app, 1);
    expect(await bridge(page, (privacy, id) => privacy.sendCrash(id), list[0].id)).toEqual({ ok: false, reason: 'cancelled' });
    expect(hits).toEqual([]);
    const asked = await prompts(app);
    expect(asked[0].message).toContain(new URL(url).host);
    expect(asked[0].detail).toContain('text of your mail');

    await fakeOsIntegration(app, 0);
    await app.evaluate(({ utilityProcess }) => {
      const g = globalThis as unknown as { __forks: string[] };
      g.__forks = [];
      const fork = utilityProcess.fork;
      utilityProcess.fork = ((script: string, ...rest: unknown[]) => {
        g.__forks.push(script);
        return (fork as (...a: unknown[]) => unknown).call(utilityProcess, script, ...rest);
      }) as typeof utilityProcess.fork;
    });
    expect(await bridge(page, (privacy, id) => privacy.sendCrash(id), list[0].id)).toEqual({ ok: true });
    const uploads = hits.filter((hit) => hit.path === '/upload');
    expect(uploads).toHaveLength(1);
    // Off the main thread: a big dump mustn't freeze the app.
    expect(await app.evaluate(() => (globalThis as unknown as { __forks: string[] }).__forks)).toEqual([expect.stringContaining('crash-scrub-host')]);
    const body = uploads[0].body;
    expect(body.includes(Buffer.from('name="upload_file_minidump"'))).toBe(true);
    expect(body.includes(Buffer.from('MDMP'))).toBe(true);
    // A real dump holds real paths. None of the user's name gets out, in either encoding.
    const name = userInfo().username;
    expect(body.toString('latin1').toLowerCase()).not.toContain(name.toLowerCase());
    expect(body.includes(Buffer.from(name, 'utf16le'))).toBe(false);
  });

  test('without consent, a crash leaves nothing behind for the next start', async () => {
    const profile = tempProfile('privacy');
    const first = await startInstance({ profile, keep: true });
    expect(await first.app.evaluate(({ crashReporter }) => crashReporter.getUploadedReports().length)).toBe(0);
    await crashMain(first.app);
    await sleep(1500);
    const { page } = await startInstance({ profile });
    expect(dumps(profile)).toEqual([]);
    expect(await bridge(page, (privacy) => privacy.listCrashes())).toEqual([]);
    expect(hits).toEqual([]);
  });

  test('with no address set, the action says so and sends nothing', async () => {
    const profile = tempProfile('privacy');
    mkdirSync(path.join(profile, 'crash-reports', 'reports'), { recursive: true });
    writeFileSync(path.join(profile, 'crash-reports', 'reports', 'abc.dmp'), 'MDMP');
    const { page, app } = await startInstance({ profile, privacy: { asked: true, crashReports: true } });
    expect(await bridge(page, (privacy, id) => privacy.sendCrash(id), 'abc')).toEqual({ ok: false, reason: 'no-url' });
    expect(await prompts(app)).toEqual([]);
    expect(hits).toEqual([]);
  });

  test('what\'s planted in a dump doesn\'t get out: names, servers, mail, whatever the script', async () => {
    const profile = tempProfile('privacy');
    const dir = path.join(profile, 'crash-reports', 'reports');
    mkdirSync(dir, { recursive: true });
    const secrets = [userInfo().username, new URL(instanceUrl).host, 'Слияние с компанией', 'ceo.private@acme-corp.example'];
    const text = `C:\\Users\\IVAN~1\\x ${instanceUrl} "subject":"Слияние с компанией" \\"password\\":\\"hunter2-Пароль\\" ceo.private@acme-corp.example ${userInfo().username}`;
    writeFileSync(path.join(dir, 'planted.dmp'), Buffer.concat([Buffer.from('MDMP\0\0'), Buffer.from(text, 'utf8'), Buffer.from([0, 0]), Buffer.from(text, 'utf16le')]));
    const { page, app } = await startInstance({ profile, privacy: { asked: true, crashReports: true, crashUploadUrl: `${collectorUrl}/upload`, instanceUrl } });
    await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
    expect(await bridge(page, (privacy, id) => privacy.sendCrash(id), 'planted')).toEqual({ ok: true });
    const body = hits.find((hit) => hit.path === '/upload')!.body;
    for (const secret of [...secrets, 'IVAN~1', 'hunter2']) {
      expect(body.includes(Buffer.from(secret, 'utf8')), secret).toBe(false);
      expect(body.includes(Buffer.from(secret, 'utf16le')), secret).toBe(false);
    }
    expect(body.includes(Buffer.from('MDMP'))).toBe(true);
  });

  test('a scrub that can\'t finish sends nothing, rather than the raw file', async () => {
    const profile = tempProfile('privacy');
    mkdirSync(path.join(profile, 'crash-reports', 'reports'), { recursive: true });
    writeFileSync(path.join(profile, 'crash-reports', 'reports', 'abc.dmp'), 'MDMP');
    const { page, app } = await startInstance({ profile, privacy: { asked: true, crashReports: true, crashUploadUrl: `${collectorUrl}/upload` } });
    await app.evaluate(({ utilityProcess }) => {
      utilityProcess.fork = (() => {
        throw new Error('no process today');
      }) as typeof utilityProcess.fork;
    });
    expect(await bridge(page, (privacy, id) => privacy.sendCrash(id), 'abc')).toEqual({ ok: false, reason: 'failed' });
    expect(hits).toEqual([]);
  });

  test('a bad address is refused, and an id can\'t walk out of the folder', async () => {
    const profile = tempProfile('privacy');
    mkdirSync(path.join(profile, 'crash-reports', 'reports'), { recursive: true });
    writeFileSync(path.join(profile, 'crash-reports', 'reports', 'abc.dmp'), 'MDMP');
    writeFileSync(path.join(profile, 'shell-state.dmp'), 'not a crash');
    const { page } = await startInstance({ profile, privacy: { asked: true, crashReports: true, crashUploadUrl: `${collectorUrl}/upload` } });
    expect((await bridge(page, (privacy) => privacy.setCrashUploadUrl('http://example.org/'))).ok).toBe(false);
    expect((await bridge(page, (privacy) => privacy.setCrashUploadUrl('https://u:p@example.org/'))).ok).toBe(false);
    expect((await bridge(page, (privacy) => privacy.get())).crashReports.uploadUrl).toBe(`${collectorUrl}/upload`);
    expect(await bridge(page, (privacy, id) => privacy.sendCrash(id), '../../shell-state')).toEqual({ ok: false, reason: 'not-found' });
    expect(hits).toEqual([]);
  });

  test('the cap holds on a real folder at start', async () => {
    const profile = tempProfile('privacy');
    const dir = path.join(profile, 'crash-reports', 'reports');
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 14; index += 1) {
      const file = path.join(dir, `dump${index}.dmp`);
      writeFileSync(file, 'MDMP');
      const when = new Date(Date.now() - index * 60_000);
      utimesSync(file, when, when);
    }
    const stale = path.join(dir, 'stale.dmp');
    writeFileSync(stale, 'MDMP');
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(stale, old, old);
    const { page } = await startInstance({ profile, privacy: { asked: true, crashReports: true } });
    const list = await bridge(page, (privacy) => privacy.listCrashes());
    expect(list.map((crash) => crash.id)).toEqual(Array.from({ length: 10 }, (_, index) => `dump${index}`));
    expect(existsSync(stale)).toBe(false);
  });

  test('taking consent back deletes the files, and it needs no dialog', async () => {
    const profile = tempProfile('privacy');
    mkdirSync(path.join(profile, 'crash-reports', 'reports'), { recursive: true });
    const planted = path.join(profile, 'crash-reports', 'reports', 'abc.dmp');
    writeFileSync(planted, 'MDMP');
    const { page, app } = await startInstance({ profile, privacy: { asked: true, crashReports: true } });
    const state = await bridge(page, (privacy) => privacy.setCrashReports(false));
    expect(state.crashReports.on).toBe(false);
    expect(existsSync(planted)).toBe(false);
    expect(await prompts(app)).toEqual([]);
  });

  test('saying yes names what a crash file holds, and starts the reporter with no upload', async () => {
    const { page, app } = await startInstance();
    const state = await bridge(page, (privacy) => privacy.setCrashReports(true));
    expect(state.crashReports.on).toBe(true);
    const asked = await prompts(app);
    expect(asked[0].detail).toContain('text of your mail');
    expect(await app.evaluate(({ crashReporter }) => crashReporter.getUploadToServer())).toBe(false);
    // Separate from telemetry: this one is still off, and sends nothing.
    expect((await bridge(page, (privacy) => privacy.get())).telemetry.on).toBe(false);
    await sleep(1500);
    expect(hits).toEqual([]);
  });
});

test.describe('errors in the main process, in instance mode', () => {
  const reject = (app: ElectronApplication) =>
    app.evaluate(() => {
      void Promise.reject(new TypeError('Merger plans for Acme at C:\\Users\\linus\\inbox'));
    });

  test('with consent, names and counts reach the real collector, with telemetry off', async () => {
    const collectorCode = await realValidator();
    const { app } = await startInstance({ privacy: { asked: true, crashReports: true } });
    await reject(app);
    await expect.poll(() => hits.filter((hit) => hit.path === '/v1/errors').length, { timeout: 15_000 }).toBeGreaterThan(0);
    const raw = hits.find((hit) => hit.path === '/v1/errors')!.body.toString('utf8');
    expect(raw).not.toContain('Merger');
    expect(raw).not.toContain('linus');
    const clean = collectorCode.validateErrorBatch(JSON.parse(raw))!;
    expect(clean).not.toBeNull();
    expect(clean.errors[0]).toMatchObject({ name: 'TypeError', count: '1', frames: [] });
    expect(String(clean.errors[0].version)).toMatch(/\+desktop$/);
    expect(heartbeats()).toEqual([]);
  });

  test('a collector that refuses the batch isn\'t asked again every tick', async () => {
    refusing = true;
    const { app } = await startInstance({ privacy: { asked: true, crashReports: true } });
    await reject(app);
    await expect.poll(() => hits.filter((hit) => hit.path === '/v1/errors').length, { timeout: 15_000 }).toBeGreaterThan(0);
    await sleep(1500);
    expect(hits.filter((hit) => hit.path === '/v1/errors')).toHaveLength(1);
  });

  test('without consent, nothing', async () => {
    const { app } = await startInstance({ privacy: { asked: true, telemetry: false, crashReports: false } });
    await reject(app);
    await sleep(1500);
    expect(hits).toEqual([]);
  });

  test('forced off, nothing, over a stored yes', async () => {
    test.skip(process.platform !== 'win32', 'the test root is a registry key');
    forcePolicy('CrashReportsAllowed', 0);
    const { app } = await startInstance({ privacy: { asked: true, crashReports: true } });
    await reject(app);
    await sleep(1500);
    expect(hits).toEqual([]);
  });
});

test.describe('standalone, on a webmail built with this', () => {
  const SERVER_DIR = process.env.BULWARK_TEST_SERVER_DIR ?? '';
  test.skip(!SERVER_DIR, 'set BULWARK_TEST_SERVER_DIR to a build with this change');

  async function startStandalone(options: { privacy?: object; state?: Record<string, unknown> }) {
    const profile = tempProfile('privacy');
    seed(profile, options.privacy);
    const telemetryDir = path.join(profile, 'webmail', 'telemetry');
    mkdirSync(telemetryDir, { recursive: true });
    writeFileSync(path.join(telemetryDir, 'state.json'), JSON.stringify({ consent: 'off', endpoint: 'http://127.0.0.1:1/ignored', consentedAt: null, lastSentAt: null, nextScheduledAt: null, ...options.state }));
    process.env.BULWARK_TELEMETRY_ALLOW_PRIVATE = '1';
    const app = await launch(profile, '--standalone', `--bulwark-server-dir=${SERVER_DIR}`, collectorArg(), ...POLICY_ARGS, ...FAST);
    delete process.env.BULWARK_TELEMETRY_ALLOW_PRIVATE;
    const page = await shownPage(app);
    await fakeOsIntegration(app);
    running.push({ app, profile });
    return { app, page, profile };
  }

  test('without consent nothing leaves, whatever the server\'s own file says', async () => {
    await startStandalone({ state: { consent: 'on', endpoint: `${collectorUrl}/v1/heartbeat`, nextScheduledAt: new Date(Date.now() + 5_000).toISOString() } });
    await sleep(40_000);
    expect(hits).toEqual([]);
  });

  test('with consent one heartbeat goes, from the server and not also from main, and the real collector takes it', async () => {
    const collectorCode = await realValidator();
    test.setTimeout(300_000);
    // A slot just ahead: the catch-up wait is up to 10 minutes, and a unit test has that.
    await startStandalone({ privacy: { asked: true, telemetry: true }, state: { nextScheduledAt: new Date(Date.now() + 90_000).toISOString() } });
    await expect.poll(() => heartbeats().length, { timeout: 180_000, intervals: [1000] }).toBeGreaterThan(0);
    await sleep(3000);
    expect(heartbeats()).toHaveLength(1);
    const body = JSON.parse(heartbeats()[0].body.toString('utf8')) as Record<string, unknown>;
    expect(body).toMatchObject({ schema: '1', platform: 'desktop', build: 'desktop.standalone.stable' });
    expect(collectorCode.validate(body)).not.toBeNull();
    expect(collectorCode.validate({ ...body, schema: '2', errors: [] })).not.toBeNull();
  });

  test('turning it on in a running app starts the heartbeat, and turning it off drops the ID', async () => {
    test.setTimeout(300_000);
    const { page, profile } = await startStandalone({ state: { nextScheduledAt: new Date(Date.now() + 90_000).toISOString() } });
    await sleep(2000);
    expect(hits).toEqual([]);
    const state = await bridge(page, (privacy) => privacy.setTelemetry(true));
    expect(state.telemetry.on).toBe(true);
    await expect.poll(() => heartbeats().length, { timeout: 180_000, intervals: [1000] }).toBe(1);
    const id = path.join(profile, 'webmail', 'telemetry', '.telemetry-id');
    expect(existsSync(id)).toBe(true);
    await bridge(page, (privacy) => privacy.setTelemetry(false));
    expect(existsSync(id)).toBe(false);
  });

  test('an error in main reaches the server\'s counts with its frames, and the batch the real collector takes', async () => {
    test.setTimeout(300_000);
    const collectorCode = await realValidator();
    const { app, profile } = await startStandalone({ privacy: { asked: true, crashReports: true } });
    const name = userInfo().username;
    const bundle = pathToFileURL(path.join(import.meta.dirname, '..', 'dist', 'main.mjs')).href;
    await app.evaluate((_electron, file) => {
      const error = new TypeError('Merger plans for Acme at C:\\Users\\linus\\inbox');
      error.stack = `TypeError: Merger plans for Acme\n    at sendPing (${file}:120:7)\n    at async ${file}:90:3`;
      void Promise.reject(error);
    }, bundle);
    await expect.poll(() => hits.filter((hit) => hit.path === '/v1/errors').length, { timeout: 120_000, intervals: [2000] }).toBeGreaterThan(0);
    const raw = hits.find((hit) => hit.path === '/v1/errors')!.body.toString('utf8');
    expect(raw).not.toContain('Merger');
    expect(raw).not.toContain('linus');
    expect(raw.toLowerCase()).not.toContain(name.toLowerCase());
    const clean = collectorCode.validateErrorBatch(JSON.parse(raw))!;
    expect(clean).not.toBeNull();
    expect(clean.errors[0].name).toBe('TypeError');
    expect(String(clean.errors[0].version)).toMatch(/\+desktop$/);
    expect(heartbeats()).toEqual([]);
    // The counts on this computer keep what the collector can't take yet: the frames.
    const file = path.join(profile, 'webmail', 'telemetry', 'errors.json');
    await expect.poll(() => existsSync(file) && readFileSync(file, 'utf8').includes('/desktop/main.mjs'), { timeout: 90_000, intervals: [2000] }).toBe(true);
    const stored = readFileSync(file, 'utf8');
    expect(stored).toContain('sendPing');
    expect(stored).not.toContain('linus');
    expect(stored.toLowerCase()).not.toContain(name.toLowerCase());
    expect(stored).not.toContain('Merger');
  });

  test('the bridge is there on the real page, in both modes\' shape', async () => {
    const { page } = await startStandalone({});
    await page.locator('#username, main').first().waitFor({ timeout: 90_000 });
    expect(await page.evaluate(() => typeof (window as unknown as { bulwarkDesktop: { privacy?: object } }).bulwarkDesktop.privacy)).toBe('object');
  });

  test('settings shows both switches off, asks before yes, and turning one on changes nothing else', async () => {
    test.skip(!ENT_PASSWORD, 'needs IT_ENT_PASSWORD');
    test.setTimeout(300_000);
    const { app, page, profile } = await startStandalone({});
    await signIn(page, STALWARTS[0].url);
    await page.goto(`${APP_ORIGIN}/settings/general`);
    const telemetry = page.getByTestId('desktop-telemetry-toggle');
    const crash = page.getByTestId('desktop-crash-toggle');
    await telemetry.scrollIntoViewIfNeeded({ timeout: 60_000 });
    await expect(telemetry).toHaveAttribute('aria-checked', 'false');
    await expect(crash).toHaveAttribute('aria-checked', 'false');
    await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-telemetry-settings.png') });

    // No in the dialog: stays off.
    await fakeOsIntegration(app, 1);
    await crash.click();
    await expect.poll(async () => (await prompts(app)).length).toBe(1);
    await expect(crash).toHaveAttribute('aria-checked', 'false');

    await fakeOsIntegration(app, 0);
    await crash.click();
    await expect(crash).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('desktop-crash-url')).toBeVisible();
    await expect(telemetry).toHaveAttribute('aria-checked', 'false');
    await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-telemetry-settings-on.png') });
    expect(storedPrivacy(profile)).toMatchObject({ crashReports: true });
    expect(storedPrivacy(profile).telemetry).toBeUndefined();
    await sleep(2000);
    expect(heartbeats()).toEqual([]);
  });
});
