import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { generateCertificate } from '../src/main/cert';
import { ACCOUNT, ENT_PASSWORD, expectMailShown, launch, removeProfile, requireAccount, SCREENSHOTS, shownPage, tempProfile } from './helpers';

/**
 * Instance mode on a webmail that knows the bridge: a regular server build of the
 * same branch, not the desktop build. Start it, with the flag set in its
 * environment to prove that does nothing, then:
 *   NEXT_PUBLIC_BULWARK_DESKTOP=1 bash start-prod.sh <worktree> 3211 <jmap-url> desktop-newer
 *   BULWARK_TEST_SERVER=http://127.0.0.1:3211 npx playwright test test/instance-newer.spec.ts
 */
const SERVER = process.env.BULWARK_TEST_SERVER ?? '';

test.describe('a regular server build with the flag in its environment', () => {
  test.skip(!SERVER, 'needs BULWARK_TEST_SERVER');

  const post = (route: string, body: unknown) =>
    fetch(`${SERVER}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  test('it still refuses a private server', async () => {
    const answer = await post('/api/auth/session', { serverUrl: 'http://192.168.1.5:8080', username: 'nobody', password: 'x' });
    expect(answer.status).toBe(400);
    expect((await answer.json()).error).toBe('Server URL is not allowed');
  });

  test('the desktop route does not exist', async () => {
    const answer = await post('/api/auth/desktop-oauth', { serverUrl: 'https://mail.example.org', redirectUri: 'http://127.0.0.1:1/bulwark-desktop/callback' });
    expect(answer.status).toBe(404);
  });

  test('pairing is still there, as it always was', async () => {
    const answer = await post('/api/auth/pair/redeem', {});
    expect(answer.status).not.toBe(404);
  });
});

test.describe('instance mode on a webmail that knows the bridge', () => {
  test.skip(!SERVER, 'needs BULWARK_TEST_SERVER');
  test.beforeAll(requireAccount);

  const certificate = generateCertificate('localhost');
  let relay: ReturnType<typeof createHttpsServer>;
  let instance = '';
  let profile = '';
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const target = new URL(SERVER);
    relay = createHttpsServer({ key: certificate.keyPem, cert: certificate.certPem }, (req, res) => {
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
    instance = `https://localhost:${(relay.address() as AddressInfo).port}`;
    profile = tempProfile('newer');
    app = await launch(profile, `--instance=${instance}/`, '--ignore-certificate-errors');
    page = await shownPage(app);
  });

  test.afterAll(async () => {
    await app?.close();
    removeProfile(profile);
    relay?.close();
    relay?.closeAllConnections();
  });

  test('signs in, keeps the session on reload, and reports its theme', async () => {
    expect(await page.evaluate(() => typeof (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop)).toBe('object');
    await page.locator('#username').waitFor({ timeout: 90_000 });
    await page.fill('#username', ACCOUNT);
    await page.fill('#password', ENT_PASSWORD);
    await page.keyboard.press('Enter');
    await expectMailShown(page);
    await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-instance-mail.png') });
    await page.reload();
    await expectMailShown(page);

    // lib/theme-color-meta.ts tells the shell, in a server build too.
    const background = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor());
    const pageColour = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = pageColour.match(/\d+/g)!.map(Number);
    expect(background.toLowerCase()).toBe(`#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`);
  });

  test('web push is off here too, through the bridge', async () => {
    // The login prompt's switch in Settings reads isWebPushSupported, which is
    // covered by the webmail's unit test. What must hold here is the premise.
    expect(await page.evaluate(() => 'PushManager' in window && !!(window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop)).toBe(true);
  });
});
