import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ACCOUNT, APP_ORIGIN, ENT_PASSWORD, expectMailShown, fakeOsIntegration, fillLogin, launch, launchStandalone, opened, prompts, removeProfile, requireAccount, SCREENSHOTS, serverPort, shownPage, signIn, STALWARTS, tempProfile, waitForLogin } from './helpers';

test.beforeAll(requireAccount);

for (const { label, url } of STALWARTS) {
  test.describe(`standalone Basic sign-in on Stalwart ${label}`, () => {
    let profile = '';
    test.beforeAll(() => {
      profile = tempProfile(`login-${label}`);
    });
    test.afterAll(() => removeProfile(profile));

    test('signs in, keeps the session on reload and on a restart', async () => {
      let { app, page } = await launchStandalone(profile);
      await fakeOsIntegration(app);
      await signIn(page, url);

      // A public server: no prompt.
      expect(await prompts(app)).toEqual([]);
      if (label === '1.0') await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-standalone-mail.png') });

      await page.reload();
      await expectMailShown(page);

      const portBefore = await serverPort(app);
      await app.close();

      ({ app, page } = await launchStandalone(profile));
      await expectMailShown(page);
      // A new port and a new launch secret, the same origin and the same session.
      expect(await serverPort(app)).not.toBe(portBefore);
      expect(new URL(page.url()).origin).toBe(APP_ORIGIN);
      const accounts = await page.evaluate(() => localStorage.getItem('account-registry'));
      expect(accounts).toContain(ACCOUNT.split('@')[0]);
      await app.close();
    });
  });

  test.describe(`browser sign-in on Stalwart ${label}`, () => {
    test('a loopback redirect signs in, and refresh works where there is no configured server', async () => {
      const profile = tempProfile(`oauth-${label}`);
      const { app, page } = await launchStandalone(profile);
      await fakeOsIntegration(app);
      await waitForLogin(page);
      await page.fill('#jmap-endpoint', url);
      await page.getByTestId('desktop-browser-sign-in').click();

      await expect.poll(() => opened(app), { timeout: 30_000 }).toHaveLength(1);
      const authorize = new URL((await opened(app))[0]);
      const redirectUri = authorize.searchParams.get('redirect_uri')!;
      expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/bulwark-desktop\/callback$/);
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');

      // What the user does in the browser, by the endpoint the login page itself calls.
      const query = authorize.search.slice(1);
      const answer = await fetch(`${url}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'authCode',
          accountName: ACCOUNT,
          accountSecret: ENT_PASSWORD,
          clientId: authorize.searchParams.get('client_id'),
          redirectUri,
          codeChallenge: authorize.searchParams.get('code_challenge'),
          codeChallengeMethod: 'S256',
          query,
          consent: true,
        }),
      });
      expect(answer.status).toBe(200);
      const body = (await answer.json()) as { client_code?: string; location?: string; type?: string };
      expect(body.type).toBe('authenticated');
      const code = body.client_code ?? new URL(body.location!).searchParams.get('code');
      const state = authorize.searchParams.get('state')!;
      const landed = new URL(redirectUri);
      landed.searchParams.set('code', code!);
      landed.searchParams.set('state', state);
      const callback = await fetch(landed);
      expect(callback.status).toBe(200);

      await expectMailShown(page);
      const registry = JSON.parse((await page.evaluate(() => localStorage.getItem('account-registry'))) ?? '{}');
      expect(JSON.stringify(registry)).toContain('"authMode":"oauth"');

      // The refresh goes to this server through the per-slot record.
      const refreshed = await page.evaluate(() =>
        fetch('/api/auth/token?slot=0&force=true', { method: 'PUT' }).then(async (r) => ({ status: r.status, hasToken: !!(await r.json()).access_token })),
      );
      expect(refreshed).toEqual({ status: 200, hasToken: true });
      const cookies = await app.evaluate(async ({ session }) => (await session.fromPartition('persist:bulwark').cookies.get({})).map((c) => c.name));
      expect(cookies).toContain('jmap_rtu');

      // And the listener is gone.
      const again = await fetch(landed).then((r) => r.status).catch(() => 'closed');
      expect(again).toBe('closed');
      await app.close();
      removeProfile(profile);
    });
  });
}

test.describe('quitting with an open composer', () => {
  const server = STALWARTS[0].url;

  async function jmap(using: string[], calls: unknown[]) {
    const auth = `Basic ${Buffer.from(`${ACCOUNT}:${ENT_PASSWORD}`).toString('base64')}`;
    const session = await (await fetch(`${server}/.well-known/jmap`, { headers: { Authorization: auth } })).json();
    const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
    const answer = await fetch(session.apiUrl, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ using, methodCalls: JSON.parse(JSON.stringify(calls).replaceAll('__ACCOUNT__', accountId)) }),
    });
    return (await answer.json()).methodResponses as [string, Record<string, unknown>, string][];
  }

  test('saves the draft on the way out', async () => {
    const profile = tempProfile('draft');
    const subject = `Quit draft ${Date.now()}`;
    let { app, page } = await launchStandalone(profile);
    await fakeOsIntegration(app);
    await signIn(page, server);
    await page.keyboard.press('c');
    await page.locator('[data-testid="email-composer"]').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('[data-testid="composer-subject"]').fill(subject);
    const typedAt = Date.now();
    await app.close();
    // Quit came straight after typing, before any autosave timer.
    expect(Date.now() - typedAt).toBeLessThan(15_000);

    const using = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
    const query = await jmap(using, [['Email/query', { accountId: '__ACCOUNT__', filter: { subject } }, 'q']]);
    const ids = query[0][1].ids as string[];
    expect(ids.length, 'the draft is on the server').toBeGreaterThan(0);
    await jmap(using, [['Email/set', { accountId: '__ACCOUNT__', destroy: ids }, 'd']]);
    removeProfile(profile);
  });
});

test.describe('a plain http server, through the UI', () => {
  // Stalwart behind a small http relay, as a LAN server would be without TLS.
  let relay: Server;
  let relayUrl = '';
  const target = new URL(STALWARTS[0].url);
  let requests = 0;

  test.beforeAll(async () => {
    relay = createServer((req, res) => {
      requests += 1;
      const upstream = httpsRequest(
        { host: target.hostname, port: 443, path: req.url, method: req.method, headers: { ...req.headers, host: target.hostname } },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
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

  test('declining sends nothing there', async () => {
    const profile = tempProfile('http-no');
    const { app, page } = await launchStandalone(profile);
    await fakeOsIntegration(app, 1);
    await fillLogin(page, relayUrl, ACCOUNT, ENT_PASSWORD);
    const before = requests;
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('desktop-notice')).toBeVisible();
    expect(requests).toBe(before);
    await app.close();
    removeProfile(profile);
  });

  test('allowing signs in through /__jmap, and a reload keeps it', async () => {
    const profile = tempProfile('http-yes');
    const { app, page } = await launchStandalone(profile);
    await fakeOsIntegration(app, 0);
    const jmapRequests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/__jmap/')) jmapRequests.push(r.url());
    });
    const direct: string[] = [];
    page.on('requestfailed', (r) => {
      if (r.url().startsWith(relayUrl)) direct.push(r.url());
    });
    await signIn(page, relayUrl);
    expect((await prompts(app))[0].message).toMatch(/encryption/i);
    expect(jmapRequests.length).toBeGreaterThan(0);
    expect(direct).toEqual([]);
    await page.reload();
    await expectMailShown(page);
    await app.close();
    removeProfile(profile);
  });
});

test.describe('the login budget', () => {
  test('a wrong password on one server does not spend the budget of another', async () => {
    // Local servers only: a wrong password must never reach a real one.
    const fakeServer = async () => {
      const server = createServer((_req, res) => {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    };
    const [first, second] = [await fakeServer(), await fakeServer()];
    const profile = tempProfile('budget');
    const { app, page } = await launchStandalone(profile);
    await fakeOsIntegration(app, 0);
    await waitForLogin(page);
    for (const { url } of [first, second]) {
      await page.evaluate((u) => (window as unknown as { bulwarkDesktop: { servers: { prepare: (u: string) => Promise<unknown> } } }).bulwarkDesktop.servers.prepare(u), url);
    }

    const post = (serverUrl: string) =>
      page.evaluate(
        async (s) => (await fetch('/api/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverUrl: s, username: 'nobody', password: 'wrong' }) })).status,
        serverUrl,
      );

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push(await post(first.url));
    expect(statuses.slice(0, 5)).not.toContain(429);
    expect(statuses.at(-1)).toBe(429);
    expect(await post(second.url)).not.toBe(429);

    await app.close();
    removeProfile(profile);
    for (const { server } of [first, second]) {
      server.close();
      server.closeAllConnections();
    }
  });
});

test.describe('the app\'s lifetime', () => {
  test('a crashed server comes back, and open windows carry on', async () => {
    const profile = tempProfile('crash');
    const { app, page } = await launchStandalone(profile);
    await waitForLogin(page);
    const pid = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'Bulwark mail service')?.pid,
    );
    expect(pid).toBeTruthy();
    process.kill(pid!);
    await expect
      .poll(() => page.evaluate(() => fetch('/api/health/live').then((r) => r.status, () => 0)), { timeout: 60_000 })
      .toBe(200);
    const newPid = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'Bulwark mail service')?.pid,
    );
    expect(newPid).not.toBe(pid);
    await app.close();
    removeProfile(profile);
  });

  test('a replaced certificate gets a page that says so, not a browser error', async () => {
    // What a security program that inspects TLS on loopback causes: the pin fails.
    const profile = tempProfile('mitm');
    const app = await launch(profile, '--standalone', '--bulwark-test-wrong-pin');
    const page = await shownPage(app);
    await expect(page.locator('body')).toContainText(/security program|Sicherheitsprogramm/, { timeout: 30_000 });
    await app.close();
    removeProfile(profile);
  });

  const portState = (port: number) =>
    new Promise<string>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve('open');
      });
      socket.once('error', () => resolve('closed'));
    });

  test('the server dies with the app when it quits', async () => {
    const profile = tempProfile('life');
    const { app, page } = await launchStandalone(profile);
    await waitForLogin(page);
    const port = await serverPort(app);
    expect(await portState(port)).toBe('open');
    await app.close();
    await expect.poll(() => portState(port), { timeout: 20_000 }).toBe('closed');
    removeProfile(profile);
  });

  test('the server dies with the app when main is killed', async () => {
    test.skip(process.platform !== 'win32', 'finds the process through PowerShell');
    const profile = tempProfile('kill');
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const root = path.resolve(import.meta.dirname, '..');
    const main = spawn(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [path.join(root, 'dist', 'main.mjs'), `--bulwark-user-data=${profile}`, '--standalone'], { env, stdio: 'ignore' });
    // The loopback port owned by one of its children.
    const findPort = () => {
      const script = `$kids = (Get-CimInstance Win32_Process -Filter 'ParentProcessId=${main.pid}').ProcessId; (Get-NetTCPConnection -LocalAddress 127.0.0.1 -State Listen -ErrorAction SilentlyContinue | Where-Object { $kids -contains $_.OwningProcess }).LocalPort`;
      const run = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
      return Number(run.stdout.trim().split(/\s+/)[0]) || 0;
    };
    let port = 0;
    await expect.poll(() => (port = findPort()), { timeout: 90_000, intervals: [1500] }).toBeGreaterThan(0);
    expect(await portState(port)).toBe('open');
    main.kill('SIGKILL');
    await expect.poll(() => portState(port), { timeout: 20_000 }).toBe('closed');
    removeProfile(profile);
  });
});
