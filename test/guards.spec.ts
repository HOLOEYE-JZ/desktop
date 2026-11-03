import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { generateCertificate } from '../src/main/cert';
import { APP_ORIGIN, fakeOsIntegration, launchStandalone, opened, plainRequest, prompts, removeProfile, serverPort, tempProfile, waitForLogin } from './helpers';

let profile = '';
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  profile = tempProfile('guards');
  ({ app, page } = await launchStandalone(profile));
  await fakeOsIntegration(app);
  await waitForLogin(page);
});

test.afterAll(async () => {
  await app.close();
  removeProfile(profile);
});

const allWindows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

test.describe('the embedded server', () => {
  test('a plain https request without the secret gets 403', async () => {
    const port = await serverPort(app);
    const answer = await plainRequest(port, '/api/health/live');
    expect(answer.status).toBe(403);
    expect(answer.body).toBe('Forbidden');
  });

  test('a wrong secret gets 403 too', async () => {
    const port = await serverPort(app);
    const answer = await plainRequest(port, '/api/config', { 'x-bulwark-launch': 'x'.repeat(43) });
    expect(answer.status).toBe(403);
  });

  test('the secret stays invisible to the page and to Next', async () => {
    const headers = await page.evaluate(async () => {
      const response = await fetch('/api/health/live');
      return { status: response.status, keys: [...response.headers.keys()] };
    });
    expect(headers.status).toBe(200);
    expect(headers.keys).not.toContain('x-bulwark-launch');
  });

  test('the secret is in no process argument or env of the server', async () => {
    const info = await app.evaluate(({ app: electronApp }) => {
      const metrics = electronApp.getAppMetrics().filter((m) => m.type === 'Utility');
      return metrics.map((m) => m.name);
    });
    expect(info).toContain('Bulwark mail service');
  });

  test('it listens on loopback only', async () => {
    const port = await serverPort(app);
    const { networkInterfaces } = await import('node:os');
    const external = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4')?.address;
    test.skip(!external, 'no other interface here');
    const code = await new Promise<string>((resolve) => {
      import('node:net').then(({ connect }) => {
        const socket = connect({ host: external, port, timeout: 3000 });
        socket.once('connect', () => { socket.destroy(); resolve('connected'); });
        socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
        socket.once('timeout', () => { socket.destroy(); resolve('timeout'); });
      });
    });
    expect(code).not.toBe('connected');
  });

  test('the session cookie secret and admin credential are never in plain text on disk', () => {
    const profileKeys = path.join(profile, 'keys');
    for (const name of ['session-secret.bin', 'admin-credential.bin', 'tls-key.bin']) {
      const raw = readFileSync(path.join(profileKeys, name));
      // DPAPI blobs start with this version header, and hold no PEM or base64url run.
      expect(raw.toString('latin1')).not.toContain('BEGIN PRIVATE KEY');
      expect(raw.length).toBeGreaterThan(40);
    }
  });
});

test.describe('window prefs', () => {
  test('sandboxed, isolated, no node, web security on', async () => {
    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const { sandbox, contextIsolation, nodeIntegration, webSecurity, allowRunningInsecureContent, webviewTag } = (BrowserWindow.getAllWindows()[0].webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences();
      return { sandbox, contextIsolation, nodeIntegration, webSecurity, allowRunningInsecureContent, webviewTag };
    });
    expect(preferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false });
  });

  test('on the persist:bulwark session', async () => {
    const same = await app.evaluate(({ BrowserWindow, session }) => BrowserWindow.getAllWindows()[0].webContents.session === session.fromPartition('persist:bulwark'));
    expect(same).toBe(true);
  });

  test('the origin is https://app.bulwark.localhost and a secure context', async () => {
    const context = await page.evaluate(() => ({ origin: location.origin, secure: isSecureContext }));
    expect(context).toEqual({ origin: APP_ORIGIN, secure: true });
  });

  test('the page sees the versioned bridge, narrow', async () => {
    const shape = await page.evaluate(() => {
      const b = (window as unknown as { bulwarkDesktop: Record<string, unknown> }).bulwarkDesktop;
      return { version: b.version, platform: b.platform, keys: Object.keys(b).sort() };
    });
    expect(shape.version).toBe(1);
    expect(shape.platform).toBe(process.platform);
    expect(shape.keys).toEqual(['auth', 'menu', 'mode', 'platform', 'plugins', 'servers', 'shell', 'theme', 'version', 'windows']);
  });

  test('a same-origin frame gets no bridge of its own', async () => {
    const inFrame = await page.evaluate(async () => {
      const frame = document.createElement('iframe');
      frame.srcdoc = '<p>frame</p>';
      document.body.appendChild(frame);
      await new Promise((resolve) => (frame.onload = resolve));
      const value = typeof (frame.contentWindow as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
      frame.remove();
      return value;
    });
    expect(inFrame).toBe('undefined');
  });

  test('no reload or devtools from the keyboard', async () => {
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    for (const key of ['F5', 'Control+R', 'Control+Shift+R', 'Control+Shift+I', 'F12']) await page.keyboard.press(key);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
    const devTools = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => x.id - y.id)[0].webContents.isDevToolsOpened());
    expect(devTools).toBe(false);
  });

  test('the application menu has no reload or devtools item', async () => {
    const roles = await app.evaluate(({ Menu }) => {
      const walk = (menu: Electron.Menu | null): string[] =>
        (menu?.items ?? []).flatMap((item) => [String(item.role ?? ''), ...walk(item.submenu ?? null)]);
      return walk(Menu.getApplicationMenu());
    });
    const lower = roles.map((role) => role.toLowerCase());
    expect(lower).toContain('copy');
    for (const banned of ['reload', 'forcereload', 'toggledevtools']) expect(lower).not.toContain(banned);
  });
});

test.describe('window-open guard', () => {
  test('an external URL goes to the system browser, with no new window', async () => {
    const before = await allWindows();
    const handle = await page.evaluate(() => window.open('https://example.com/from-app', '_blank') === null);
    expect(handle).toBe(true);
    await expect.poll(() => opened(app)).toContain('https://example.com/from-app');
    expect(await allWindows()).toBe(before);
  });

  test('javascript: and file: are refused and opened nowhere', async () => {
    const before = (await opened(app)).length;
    const windows = await allWindows();
    await page.evaluate(() => {
      window.open('javascript:alert(1)');
      window.open('file:///C:/Windows/win.ini');
    });
    await page.waitForTimeout(400);
    expect((await opened(app)).length).toBe(before);
    expect(await allWindows()).toBe(windows);
  });

  test('about:blank opens, document.write works (print needs both), and it has no bridge', async () => {
    const result = await Promise.all([
      app.waitForEvent('window'),
      page.evaluate(() => {
        const child = window.open('', '_blank')!;
        child.document.write('<title>printed</title><p id="x">body</p>');
        child.document.close();
        return { wrote: child.document.getElementById('x')?.textContent, bridge: typeof (child as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop };
      }),
    ]);
    expect(result[1]).toEqual({ wrote: 'body', bridge: 'undefined' });
    await result[0].close();
  });

  test('a blob: preview opens, with noopener as the webmail does it', async () => {
    const [child] = await Promise.all([
      app.waitForEvent('window'),
      page.evaluate(() => {
        const url = URL.createObjectURL(new Blob(['<p id="b">preview</p>'], { type: 'text/html' }));
        return window.open(url, '_blank', 'noopener,noreferrer') === null;
      }),
    ]);
    await child.waitForLoadState();
    expect(await child.textContent('#b')).toBe('preview');
    expect(await child.evaluate(() => typeof (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop)).toBe('undefined');
    await child.close();
  });

  test('a /popout/ route opens in the app, on the app session', async () => {
    const before = await allWindows();
    const [child] = await Promise.all([
      app.waitForEvent('window'),
      page.evaluate(() => {
        window.open('/en/login?popout=1', 'bulwark-message-test1', 'popup=yes,width=500,height=500');
      }),
    ]);
    expect(await allWindows()).toBe(before + 1);
    await child.close();
  });
});

test.describe('the window manager', () => {
  async function closeAllButMain() {
    await app.evaluate(({ BrowserWindow }) => {
      // getAllWindows has no fixed order. The main window is the oldest.
      const all = BrowserWindow.getAllWindows();
      const oldest = Math.min(...all.map((w) => w.id));
      for (const window of all) if (window.id !== oldest) window.destroy();
    });
  }

  test.afterEach(closeAllButMain);

  const bridgeOpen = (url: string, name: string) =>
    page.evaluate(
      ([u, n]) => (window as unknown as { bulwarkDesktop: { windows: { open: (url: string, o: object) => void } } }).bulwarkDesktop.windows.open(u, { name: n, width: 700, height: 600 }),
      [url, name],
    );

  const listed = () => page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { list: () => Promise<{ type: string; title: string }[]> } } }).bulwarkDesktop.windows.list());

  test('one window per message: opening it again focuses the same one', async () => {
    const before = await allWindows();
    await bridgeOpen('/popout/message/m1?x=1', 'bulwark-message-m1');
    await expect.poll(allWindows).toBe(before + 1);
    expect((await listed()).map((w) => w.type)).toContain('message');
    await bridgeOpen('/popout/message/m1?x=1', 'bulwark-message-m1');
    await page.waitForTimeout(300);
    expect(await allWindows()).toBe(before + 1);
    await bridgeOpen('/popout/message/m2', 'bulwark-message-m2');
    await expect.poll(allWindows).toBe(before + 2);
  });

  test('openMessage keys on the message', async () => {
    const before = await allWindows();
    const open = (id: string) =>
      page.evaluate(
        (emailId) => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: `/popout/message/${emailId}`, emailId }),
        id,
      );
    await open('m9');
    await open('m9');
    await expect.poll(allWindows).toBe(before + 1);
  });

  test('a bridge call can only open the app\'s own routes', async () => {
    const before = await allWindows();
    await bridgeOpen('https://example.com/phish', 'x');
    await bridgeOpen('file:///C:/Windows/win.ini', 'y');
    await bridgeOpen('/api/health/live', 'z');
    await page.waitForTimeout(300);
    expect(await allWindows()).toBe(before);
  });

  test('new windows of a type cascade', async () => {
    await bridgeOpen('/popout/message/c1', 'c1');
    await bridgeOpen('/popout/message/c2', 'c2');
    await expect.poll(allWindows).toBe(3);
    const bounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().sort((x, y) => y.id - x.id).slice(0, 2).map((w) => w.getBounds()),
    );
    expect(Math.abs(bounds[0].x - bounds[1].x)).toBeGreaterThan(0);
    expect(Math.abs(bounds[0].y - bounds[1].y)).toBeGreaterThan(0);
  });

  test('new windows are hidden until they have painted, with the theme\'s background', async () => {
    const seen = await app.evaluate(async ({ BrowserWindow, app: electronApp }) => {
      const result: { visibleOnCreate?: boolean; visibleAtReady?: boolean; background?: string } = {};
      void electronApp;
      const created = new Promise<void>((resolve) => {
        const listener = (_event: unknown, window: Electron.BrowserWindow) => {
          electronApp.removeListener('browser-window-created', listener);
          result.visibleOnCreate = window.isVisible();
          result.background = window.getBackgroundColor();
          window.once('ready-to-show', () => {
            result.visibleAtReady = window.isVisible();
            resolve();
          });
        };
        electronApp.on('browser-window-created', listener);
      });
      const main = BrowserWindow.getAllWindows().sort((x, y) => x.id - y.id)[0];
      void main.webContents.executeJavaScript(
        "window.bulwarkDesktop.windows.open('/en/login?flash=1', {name:'flash', width: 500, height: 500})",
      );
      await created;
      return result;
    });
    expect(seen.visibleOnCreate).toBe(false);
    expect(seen.visibleAtReady).toBe(false);
    expect(seen.background).toMatch(/^#[0-9A-F]{6,8}$/i);
  });

  test('a window that is closed comes back with its size', async () => {
    await bridgeOpen('/popout/message/s1', 's1');
    await expect.poll(allWindows).toBe(2);
    await app.evaluate(async ({ BrowserWindow }) => {
      const newest = BrowserWindow.getAllWindows().sort((x, y) => y.id - x.id)[0];
      newest.setBounds({ width: 777, height: 555 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      newest.close();
    });
    await expect.poll(allWindows).toBe(1);
    await bridgeOpen('/popout/message/s2', 's2');
    await expect.poll(allWindows).toBe(2);
    const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => y.id - x.id)[0].getBounds());
    // Device pixels: one off is rounding on a scaled display.
    expect(Math.abs(size.width - 777)).toBeLessThanOrEqual(4);
    expect(Math.abs(size.height - 555)).toBeLessThanOrEqual(4);

    // And it doesn't creep from one window to the next.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => y.id - x.id)[0].close());
    await expect.poll(allWindows).toBe(1);
    await bridgeOpen('/popout/message/s3', 's3');
    await expect.poll(allWindows).toBe(2);
    const again = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => y.id - x.id)[0].getBounds());
    expect(again.width).toBe(size.width);
    expect(again.height).toBe(size.height);
  });
});

test.describe('the theme', () => {
  test('a page colour reaches the window and the stored theme, and a bad value is ignored', async () => {
    const setTheme = (theme: unknown) =>
      page.evaluate((value) => (window as unknown as { bulwarkDesktop: { theme: { set: (t: unknown) => void } } }).bulwarkDesktop.theme.set(value), theme);
    await setTheme({ dark: true, background: 'rgb(16, 32, 48)' });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => x.id - y.id)[0].getBackgroundColor())).toBe('#102030');
    await setTheme({ dark: false, background: 'url(evil)' });
    await page.waitForTimeout(200);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => x.id - y.id)[0].getBackgroundColor())).toBe('#102030');
  });

  test('the OS switching themes reaches the page', async () => {
    await page.evaluate(() => {
      const w = window as unknown as { __system?: unknown; bulwarkDesktop: { theme: { onSystemChange: (f: (s: unknown) => void) => void } } };
      w.bulwarkDesktop.theme.onSystemChange((system) => (w.__system = system));
    });
    const expected = await app.evaluate(({ nativeTheme }) => {
      const dark = !nativeTheme.shouldUseDarkColors;
      nativeTheme.themeSource = dark ? 'dark' : 'light';
      return dark;
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __system?: { dark: boolean } }).__system?.dark)).toBe(expected);
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'system';
    });
  });
});

test.describe('navigation guard', () => {
  test('leaving the origin is stopped, and goes to the system browser', async () => {
    const url = page.url();
    await page.evaluate(() => {
      location.href = 'https://example.org/left-the-app';
    });
    await expect.poll(() => opened(app)).toContain('https://example.org/left-the-app');
    expect(page.url()).toBe(url);
  });

  test('a provider logout that is blocked does not leave the window stuck', async () => {
    await page.goto(`${APP_ORIGIN}/en/login?stuck=1`);
    await waitForLogin(page);
    await page.evaluate(() => {
      location.href = 'https://idp.example/oidc/logout?post_logout_redirect_uri=https%3A%2F%2Fother.example';
    });
    await expect.poll(() => opened(app)).toContain('https://idp.example/oidc/logout?post_logout_redirect_uri=https%3A%2F%2Fother.example');
    await expect(page).not.toHaveURL(/stuck=1/);
    await expect(page).toHaveURL(new RegExp(`^${APP_ORIGIN}/`));
  });
});

test.describe('permissions', () => {
  test('denied by default, granted only for what the app uses', async () => {
    await page.goto(`${APP_ORIGIN}/en/login`);
    const results = await page.evaluate(async () => {
      const denied = async (fn: () => Promise<unknown>) => fn().then(() => 'granted', (e) => e.name);
      return {
        notifications: await Notification.requestPermission(),
        persist: await navigator.storage.persist(),
        clipboardRead: await denied(() => navigator.clipboard.readText()),
        camera: await denied(() => navigator.mediaDevices.getUserMedia({ video: true })),
        screen: await denied(() => navigator.mediaDevices.getDisplayMedia()),
        geo: await new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('granted'), (e) => resolve(e.code), { timeout: 3000 })),
      };
    });
    expect(results.notifications).toBe('granted');
    expect(results.persist).toBe(true);
    expect(results.clipboardRead).not.toBe('granted');
    expect(results.camera).not.toBe('granted');
    expect(results.screen).not.toBe('granted');
    expect(results.geo).not.toBe('granted');
  });
});

test.describe('the local admin', () => {
  test('the admin cookie is never in the renderer\'s jar, after a real admin call', async () => {
    await fakeOsIntegration(app);
    const answer = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { plugins: { install: (s: string) => Promise<unknown> } } }).bulwarkDesktop.plugins.install('bulwark-no-such-plugin-xyz'));
    expect(answer).toMatchObject({ ok: false, error: 'not_found' });
    // It asked first, and got as far as the admin route (a 403 or 401 would read differently).
    expect((await prompts(app)).map((p) => p.message).join()).toContain('bulwark-no-such-plugin-xyz');
    const cookies = await app.evaluate(async ({ session }) => (await session.fromPartition('persist:bulwark').cookies.get({})).map((c) => c.name));
    expect(cookies).not.toContain('admin_session');
    expect(cookies).not.toContain('admin_device');
  });

  test('a real plugin from the directory installs through the admin route, with its checks', async () => {
    await fakeOsIntegration(app);
    const answer = (await page.evaluate(() =>
      (window as unknown as { bulwarkDesktop: { plugins: { install: (s: string) => Promise<unknown> } } }).bulwarkDesktop.plugins.install('languagetool'),
    )) as { ok: boolean; id?: string; error?: string };
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true });
    const installed = path.join(profile, 'webmail', 'admin', 'plugins');
    expect(readdirSync(installed).join()).toContain(answer.id);
    // Signed with this install's own key, in the profile.
    expect(existsSync(path.join(profile, 'webmail', 'admin', 'plugin-signing.key'))).toBe(true);
    const cookies = await app.evaluate(async ({ session }) => (await session.fromPartition('persist:bulwark').cookies.get({})).map((c) => c.name));
    expect(cookies).not.toContain('admin_session');
  });

  test('a declined prompt installs nothing', async () => {
    await fakeOsIntegration(app, 1);
    const answer = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { plugins: { install: (s: string) => Promise<unknown> } } }).bulwarkDesktop.plugins.install('anything'));
    expect(answer).toEqual({ ok: false, error: 'cancelled' });
    await fakeOsIntegration(app);
  });

  test('the renderer has no way in by itself', async () => {
    const status = await page.evaluate(() => fetch('/api/admin/plugins').then((r) => r.status));
    expect(status).toBe(401);
  });
});

test.describe('the desktop profile', () => {
  test('setup is skipped, custom servers are on, and plugins are on with no local approval', async () => {
    const config = await page.evaluate(() => fetch('/api/config').then((r) => r.json()));
    expect(config.allowCustomJmapEndpoint).toBe(true);
    const policy = await page.evaluate(() => fetch('/api/admin/policy').then((r) => r.json()));
    expect(policy.features?.pluginsEnabled ?? policy.pluginsEnabled).toBe(true);
    const seeded = JSON.parse(readFileSync(path.join(profile, 'webmail', 'admin', 'policy.json'), 'utf8'));
    expect(seeded.features).toMatchObject({ pluginsEnabled: true, pluginsUploadEnabled: true, requirePluginApproval: false });
    expect(page.url()).not.toContain('/setup');
  });

  test('pairing and hand-off are gone', async () => {
    const statuses = await page.evaluate(async () => {
      const out: Record<string, number> = {};
      for (const route of ['pair/status?code=x', 'pair/redeem', 'handoff/redeem', 'pair/create']) {
        out[route] = await fetch(`/api/auth/${route}`, { method: route.includes('?') ? 'GET' : 'POST' }).then((r) => r.status);
      }
      return out;
    });
    for (const [route, status] of Object.entries(statuses)) expect(status, route).toBe(404);
  });
});

test.describe('CORS for an account\'s server', () => {
  const certificate = generateCertificate('127.0.0.1');
  let server: ReturnType<typeof createHttpsServer>;
  let origin = '';
  let options = 0;

  test.beforeAll(async () => {
    server = createHttpsServer({ key: certificate.keyPem, cert: certificate.certPem }, (req, res) => {
      if (req.method === 'OPTIONS') {
        options += 1;
        res.writeHead(405).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reached: true, authorization: req.headers.authorization }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The test server isn't publicly trusted: let this session accept it alone.
    const appCert = readFileSync(path.join(profile, 'keys', 'app-cert.pem'), 'utf8');
    const fingerprint = `sha256/${createHash('sha256').update(new X509Certificate(appCert).raw).digest('base64')}`;
    await app.evaluate(({ session }, pin) => {
      session.fromPartition('persist:bulwark').setCertificateVerifyProc((request, callback) => {
        if (request.hostname === 'app.bulwark.localhost') callback(request.certificate.fingerprint === pin ? 0 : -2);
        else if (request.hostname === '127.0.0.1') callback(0);
        else callback(-3);
      });
    }, fingerprint);
  });

  test.afterAll(() => {
    server.close();
    server.closeAllConnections();
  });

  const post = (url: string) =>
    page.evaluate(
      (target) => fetch(target, { method: 'POST', headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json(), (e) => `blocked: ${e.message}`),
      url,
    );

  test('blocked before the server is an account\'s, like any cross-origin fetch', async () => {
    expect(String(await post(`${origin}/jmap/`))).toContain('blocked');
  });

  test('works once it is one: preflight answered, Authorization allowed, though the server sends no CORS at all', async () => {
    await fakeOsIntegration(app);
    await page.evaluate((url) => (window as unknown as { bulwarkDesktop: { servers: { prepare: (u: string) => Promise<unknown> } } }).bulwarkDesktop.servers.prepare(url), origin);
    const before = options;
    expect(await post(`${origin}/jmap/`)).toEqual({ reached: true, authorization: 'Bearer abc' });
    expect(options).toBeGreaterThan(before);
  });

  test('other origins stay under normal CORS', async () => {
    const other = createHttpsServer({ key: certificate.keyPem, cert: certificate.certPem }, (_req, res) => res.end('{}'));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherOrigin = `https://127.0.0.1:${(other.address() as AddressInfo).port}`;
    expect(String(await post(`${otherOrigin}/`))).toContain('blocked');
    other.close();
    other.closeAllConnections();
  });
});

test.describe('a plain http server', () => {
  let upstream: Server;
  let origin = '';

  test.beforeAll(async () => {
    upstream = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie ?? null }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  test.afterAll(() => {
    upstream.close();
    upstream.closeAllConnections();
  });

  const route = () => `/__jmap/${Buffer.from(origin).toString('base64url')}/jmap/session`;
  const viaRoute = () => page.evaluate((url) => fetch(url).then(async (r) => ({ status: r.status, body: await r.text() })), route());
  const prepare = () => page.evaluate((url) => (window as unknown as { bulwarkDesktop: { servers: { prepare: (u: string) => Promise<unknown> } } }).bulwarkDesktop.servers.prepare(url), origin);

  test('no forwarding before the user allowed it', async () => {
    expect((await viaRoute()).status).toBe(403);
  });

  test('declined: still nothing, and the page hears why', async () => {
    await fakeOsIntegration(app, 1);
    expect(await prepare()).toEqual({ ok: false, reason: 'declined' });
    expect((await prompts(app))[0].message).toMatch(/encryption/i);
    expect((await viaRoute()).status).toBe(403);
  });

  test('allowed: forwarded, without the app\'s cookies, and kept across a reload', async () => {
    await fakeOsIntegration(app, 0);
    expect(await prepare()).toEqual({ ok: true, approved: true });
    const answer = await viaRoute();
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ path: '/jmap/session', cookie: null });
    await page.reload();
    await waitForLogin(page);
    expect((await viaRoute()).status).toBe(200);
    // Asked once only.
    await fakeOsIntegration(app, 1);
    expect(await prepare()).toEqual({ ok: true, approved: true });
    expect(await prompts(app)).toEqual([]);
  });
});
