import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createHttpsServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { generateCertificate } from '../src/main/cert';
import { ACCOUNT, ENT_PASSWORD, expectMailShown, fakeOsIntegration, fillLogin, launch, prompts, removeProfile, requireAccount, SCREENSHOTS, shownPage, signIn, tempProfile, waitForLogin } from './helpers';

/**
 * Policies in the webmail itself: the login page, the settings lock, the plugin list.
 * Needs a desktop build of the webmail branch that has them:
 *
 *   BULWARK_POLICY_SERVER_DIR=<fetch-webmail --out dir> npx playwright test test/policies-webmail.spec.ts
 */
const SERVER_DIR = process.env.BULWARK_POLICY_SERVER_DIR ?? '';
const STALWART = 'https://stalwart-1.internal.bulwarkmail.org';
const BASE = 'HKCU\\Software\\BulwarkTest';
const ROOT = `${BASE}\\Policies\\web${process.pid}`;

test.skip(!SERVER_DIR || process.platform !== 'win32', 'needs BULWARK_POLICY_SERVER_DIR');
test.beforeAll(requireAccount);

let run = 0;
const running: { app: ElectronApplication; profile: string }[] = [];

function reg(...args: string[]): void {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`reg ${args.join(' ')}: ${result.stderr}`);
}

function fresh(): string {
  run += 1;
  return `${ROOT}\\${run}`;
}

const forced = (root: string, sub = '') => `${root}\\Machine${sub ? `\\${sub}` : ''}`;
const setString = (where: string, name: string, value: string) => reg('add', where, '/v', name, '/t', 'REG_SZ', '/d', value, '/f');

async function start(root: string, options: { state?: object; seed?: (profile: string) => void; args?: string[] } = {}): Promise<{ app: ElectronApplication; page: Page; profile: string }> {
  const profile = tempProfile('polweb');
  if (options.state) writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify(options.state));
  options.seed?.(profile);
  const app = await launch(profile, `--bulwark-test-policy-root=${root}`, '--bulwark-test-policy-poll=250', `--bulwark-server-dir=${SERVER_DIR}`, '--ignore-certificate-errors', ...(options.args ?? []));
  const page = await shownPage(app);
  await fakeOsIntegration(app);
  running.push({ app, profile });
  return { app, page, profile };
}

test.afterEach(async () => {
  for (const { app, profile } of running.splice(0)) {
    await app.close().catch(() => {});
    removeProfile(profile);
  }
});

test.afterAll(() => {
  spawnSync('reg.exe', ['delete', BASE, '/f'], { windowsHide: true });
});

test.describe('standalone', () => {
  test('a server off the list is refused on the login page, with the reason, before anything is sent', async () => {
    const root = fresh();
    setString(forced(root, 'AllowedJmapServers'), '1', STALWART);
    const { app, page } = await start(root, { state: { mode: 'standalone' } });
    const leaving: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith('https://other.example.org')) leaving.push(request.url());
    });
    await fillLogin(page, 'https://other.example.org', ACCOUNT, 'not-a-real-password');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('desktop-policy-notice')).toContainText("doesn't allow this server");
    expect(leaving).toEqual([]);
    expect(await prompts(app)).toEqual([]);

    // The route says the same, for a page that skips the form.
    const status = await page.evaluate(async () => (await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverUrl: 'https://other.example.org', username: 'a', password: 'b' }),
    })).status);
    expect(status).toBe(403);

    // A server on the list goes through.
    await signIn(page, STALWART);
    await expectMailShown(page);
  });

  test('plugins off: Settings show the lock, and the server list flags a plugin rather than dropping it', async () => {
    const root = fresh();
    setString(forced(root), 'PluginsMode', 'off');
    const seed = (profile: string) => {
      const dir = path.join(profile, 'webmail', 'admin', 'plugins');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ plugins: [{ id: 'seeded-plugin', name: 'Seeded', version: '1.0.0', author: 'x', description: '', type: 'hook', permissions: [], entrypoint: 'index.js', enabled: true, bundleHash: 'a'.repeat(64) }] }));
    };
    const { page, profile } = await start(root, { state: { mode: 'standalone' }, seed });
    await signIn(page, STALWART);

    const listed = await page.evaluate(async () => (await fetch('/api/plugins')).json());
    expect(listed.plugins).toEqual([expect.objectContaining({ id: 'seeded-plugin', refused: true })]);
    const bundle = await page.evaluate(async () => (await fetch('/api/admin/plugins/seeded-plugin/bundle')).status);
    expect(bundle).toBe(403);
    // Nothing happened to the registry.
    expect(JSON.parse(readFileSync(path.join(profile, 'webmail', 'admin', 'plugins', 'registry.json'), 'utf8')).plugins[0].id).toBe('seeded-plugin');

    await page.goto('/en/settings?tab=addons').catch(() => {});
    const row = page.getByTestId('device-plugins-off');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-org-locked]').first()).toContainText('Set by your organisation');
    await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-policy-locked-setting.png') });

    // Lifted while running: the page goes back without a restart.
    reg('delete', forced(root), '/v', 'PluginsMode', '/f');
    await expect(row).toBeHidden({ timeout: 30_000 });
  });

  test('offline forced off shows the lock on the storage settings', async () => {
    const root = fresh();
    setString(forced(root), 'OfflineEnabled', 'not-a-switch');
    const { page } = await start(root, { state: { mode: 'standalone' } });
    await signIn(page, STALWART);
    await page.goto('/en/settings?tab=data').catch(() => {});
    const locked = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { policy: { get(): { OfflineEnabled: unknown } } } }).bulwarkDesktop.policy.get().OfflineEnabled);
    expect(locked).toMatchObject({ value: false, locked: true, invalid: 'not_a_switch' });
  });
});

test.describe('on an instance', () => {
  const certificate = generateCertificate('localhost');
  let relay: Server;
  let serverProcess: ChildProcess;
  let instance = '';
  let configDir = '';

  test.beforeAll(async () => {
    // The same build as a plain server: an instance whose admin allows a server of one's own.
    configDir = tempProfile('polweb-instance');
    mkdirSync(path.join(configDir, 'admin'), { recursive: true });
    writeFileSync(path.join(configDir, 'admin', 'config.json'), JSON.stringify({ setupComplete: true, jmapServerUrl: STALWART, allowCustomJmapEndpoint: true }));
    const port = 3200 + (process.pid % 90);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      ADMIN_CONFIG_DIR: path.join(configDir, 'admin'),
      ADMIN_STATE_DIR: path.join(configDir, 'state'),
      SETTINGS_DATA_DIR: path.join(configDir, 'settings'),
      SESSION_SECRET: 'a'.repeat(48),
      BULWARK_UPDATE_CHECK: 'off',
      BULWARK_TELEMETRY: 'off',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    serverProcess = spawn(process.execPath, ['server.js'], { cwd: SERVER_DIR, env, stdio: 'ignore' });
    await expect.poll(async () => fetch(`http://127.0.0.1:${port}/api/config`).then((r) => r.status).catch(() => 0), { timeout: 60_000 }).toBe(200);

    relay = createHttpsServer({ key: certificate.keyPem, cert: certificate.certPem }, (req, res) => {
      const upstream = httpRequest(
        { host: '127.0.0.1', port, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host } },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    instance = `https://localhost:${(relay.address() as AddressInfo).port}/`;
  });

  test.afterAll(async () => {
    relay?.close();
    if (serverProcess?.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(serverProcess.pid)], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 800));
    removeProfile(configDir);
  });

  test('forced: no field for a server of one\'s own, and sign-in goes to the instance\'s server', async () => {
    const root = fresh();
    setString(forced(root), 'InstanceUrl', instance);
    const { page } = await start(root);
    await waitForLogin(page);
    await expect(page.locator('#jmap-endpoint')).toHaveCount(0);
    await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-policy-forced-instance.png') });
    await page.fill('#username', ACCOUNT);
    await page.fill('#password', ENT_PASSWORD);
    await page.keyboard.press('Enter');
    await expectMailShown(page);
  });

  test('recommended: the field stays', async () => {
    const root = fresh();
    setString(forced(root, 'Recommended'), 'InstanceUrl', instance);
    const { page } = await start(root);
    await waitForLogin(page);
    await expect(page.locator('#jmap-endpoint')).toBeVisible();
  });
});
