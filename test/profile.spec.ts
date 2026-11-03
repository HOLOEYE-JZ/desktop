import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { fakeOsIntegration, launch, launchStandalone, opened, removeProfile, SCREENSHOTS, shownPage, tempProfile, waitForLogin } from './helpers';

const ROOT = path.resolve(import.meta.dirname, '..');

test.describe('the first run', () => {
  test('asks which mode, refuses a bad address, and remembers the choice', async () => {
    const profile = tempProfile('welcome');
    let app = await launch(profile);
    let page = await shownPage(app);
    await page.locator('#standalone').waitFor();
    await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-welcome.png') });

    await page.click('#instance');
    await page.fill('#url', 'http://mail.example.org');
    await page.click('#connect');
    await expect(page.locator('#error')).not.toBeEmpty();

    await page.click('#standalone');
    await expect.poll(async () => {
      const urls = await Promise.all(app.windows().filter((p) => !p.isClosed()).map((p) => p.url()));
      return urls.some((url) => url.startsWith('https://app.bulwark.localhost'));
    }, { timeout: 60_000 }).toBe(true);
    await app.close();

    app = await launch(profile);
    page = await shownPage(app);
    await waitForLogin(page);
    expect(new URL(page.url()).origin).toBe('https://app.bulwark.localhost');
    await app.close();
    removeProfile(profile);
  });

  test('a page cannot use the welcome channel', async () => {
    const profile = tempProfile('welcome2');
    const app = await launch(profile);
    await shownPage(app);
    const denied = await app.evaluate(async ({ ipcMain }, channel) => {
      const handler = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown, c: unknown) => unknown> })._invokeHandlers.get(channel)!;
      try {
        await handler({ sender: {}, senderFrame: { url: 'https://evil.example/' } }, { mode: 'standalone' });
        return 'allowed';
      } catch (error) {
        return (error as Error).message;
      }
    }, 'bulwark:welcome.choose');
    expect(denied).toBe('Not allowed');
    await app.close();
    removeProfile(profile);
  });
});

test.describe('the session secret', () => {
  test('one that cannot be decrypted shows an error page and is never replaced', async () => {
    const profile = tempProfile('secret');
    const first = await launchStandalone(profile);
    await waitForLogin(first.page);
    await first.app.close();

    const file = path.join(profile, 'keys', 'session-secret.bin');
    const garbage = Buffer.from('not what safeStorage wrote');
    writeFileSync(file, garbage);

    const app = await launch(profile, '--standalone');
    const page = await shownPage(app);
    await expect(page.locator('body')).toContainText(/can't read its keys|kann seine Schlüssel/);
    // No server, so nothing can have minted a new session secret.
    const utility = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().filter((m) => m.type === 'Utility' && m.name === 'Bulwark mail service').length);
    expect(utility).toBe(0);
    expect(readFileSync(file)).toEqual(garbage);
    await app.close();
    removeProfile(profile);
  });

  test('it survives a restart, so sign-ins do', async () => {
    const profile = tempProfile('secret2');
    const first = await launchStandalone(profile);
    await waitForLogin(first.page);
    const before = readFileSync(path.join(profile, 'keys', 'session-secret.bin'));
    await first.app.close();
    const second = await launchStandalone(profile);
    await waitForLogin(second.page);
    expect(readFileSync(path.join(profile, 'keys', 'session-secret.bin'))).toEqual(before);
    await second.app.close();
    removeProfile(profile);
  });
});

test.describe('the environment', () => {
  test('a user\'s environment does not change the embedded server', async () => {
    const profile = tempProfile('env');
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
    delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, {
      DEMO_MODE: 'true',
      REDIS_URL: 'redis://127.0.0.1:1',
      JMAP_SERVER_URL: 'https://evil.example',
      ALLOW_CUSTOM_JMAP_ENDPOINT: 'false',
      HOSTNAME: 'evil.example',
      PORT: '1',
      SESSION_SECRET: 'from-the-environment-from-the-environment',
      PLUGIN_DEV_DIR: 'C:\\nope',
      ADMIN_CONFIG_READONLY: 'true',
    });
    const app = await electron.launch({ args: [path.join(ROOT, 'dist', 'main.mjs'), `--bulwark-user-data=${profile}`, '--standalone', '--lang=en-US'], cwd: ROOT, env });
    const page = await shownPage(app);
    await waitForLogin(page);
    const config = await page.evaluate(() => fetch('/api/config').then((r) => r.json()));
    expect(config.demoMode).toBe(false);
    expect(config.allowCustomJmapEndpoint).toBe(true);
    expect(config.jmapServerUrl || '').toBe('');
    expect(new URL(page.url()).host).toBe('app.bulwark.localhost');
    await app.close();
    removeProfile(profile);
  });

  test('plugin signing key stays in the profile, not the app', async () => {
    const profile = tempProfile('sign');
    const { app, page } = await launchStandalone(profile);
    await waitForLogin(page);
    const key = await page.evaluate(() => fetch('/api/plugin-signing-pubkey').then((r) => r.status));
    expect(key).toBe(200);
    expect(existsSync(path.join(profile, 'webmail', 'admin', 'plugin-signing.key'))).toBe(true);
    expect(existsSync(path.join(ROOT, 'webmail', 'data'))).toBe(false);
    await app.close();
    removeProfile(profile);
  });
});

test.describe('the title bar', () => {
  test('a page with the title bar row keeps the overlay, and its colours follow the theme live', async () => {
    test.skip(process.platform !== 'win32', 'the coloured overlay is Windows only');
    const profile = tempProfile('overlay');
    mkdirSync(profile, { recursive: true });
    const app = await launch(profile, '--standalone');
    // Until the webmail's title bar row is merged, the page's variable is added here.
    await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const g = globalThis as unknown as { __overlays: unknown[] };
      g.__overlays = [];
      const original = BrowserWindow.prototype.setTitleBarOverlay;
      BrowserWindow.prototype.setTitleBarOverlay = function patched(options) {
        g.__overlays.push(options);
        return original.call(this, options);
      };
      electronApp.on('web-contents-created', (_event, contents) => {
        contents.on('dom-ready', () => void contents.insertCSS(':root{--titlebar-inset:env(titlebar-area-height,0px)}'));
      });
    });
    const page = await shownPage(app);
    await waitForLogin(page);
    const overlay = await page.evaluate(() => {
      const wco = (navigator as unknown as { windowControlsOverlay: { visible: boolean; getTitlebarAreaRect(): { height: number; width: number } } }).windowControlsOverlay;
      return { visible: wco.visible, height: wco.getTitlebarAreaRect().height, width: wco.getTitlebarAreaRect().width, inner: innerWidth };
    });
    expect(overlay.visible).toBe(true);
    expect(overlay.height).toBeGreaterThan(0);
    expect(overlay.width).toBeLessThan(overlay.inner);

    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { theme: { set: (t: object) => void } } }).bulwarkDesktop.theme.set({ dark: true, background: '#112233' }));
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __overlays: { color: string }[] }).__overlays.at(-1)?.color)).toBe('#112233');
    const symbol = await app.evaluate(() => (globalThis as unknown as { __overlays: { symbolColor: string }[] }).__overlays.at(-1)?.symbolColor);
    expect(symbol).toBe('#f4f4f5');
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { theme: { set: (t: object) => void } } }).bulwarkDesktop.theme.set({ dark: false, background: 'rgb(255, 255, 255)' }));
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __overlays: { color: string }[] }).__overlays.at(-1)?.color)).toBe('#ffffff');
    expect(await app.evaluate(() => (globalThis as unknown as { __overlays: { symbolColor: string }[] }).__overlays.at(-1)?.symbolColor)).toBe('#18181b');
    await app.close();
    removeProfile(profile);
  });
});

test.describe('links from the login page', () => {
  test('an external link leaves for the browser and the page stays', async () => {
    const profile = tempProfile('link');
    const { app, page } = await launchStandalone(profile);
    await fakeOsIntegration(app);
    await waitForLogin(page);
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.href = 'https://example.net/doc';
      a.target = '_blank';
      a.rel = 'noopener';
      a.id = 'ext-link';
      a.textContent = 'x';
      document.body.appendChild(a);
    });
    const url = page.url();
    await page.click('#ext-link');
    await expect.poll(() => opened(app)).toContain('https://example.net/doc');
    expect(page.url()).toBe(url);
    await app.close();
    removeProfile(profile);
  });
});
