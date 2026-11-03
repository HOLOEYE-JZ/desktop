import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { fakeOsIntegration, launch, opened, removeProfile, SCREENSHOTS, shownPage, tempProfile } from './helpers';

const INSTANCE = 'https://bulwark.internal.bulwarkmail.org';

let profile = '';
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  profile = tempProfile('instance');
  app = await launch(profile, `--instance=${INSTANCE}`);
  page = await shownPage(app);
  await fakeOsIntegration(app);
  await page.locator('#username, [data-testid], main').first().waitFor({ timeout: 60_000 });
});

test.afterAll(async () => {
  await app.close();
  removeProfile(profile);
});

const bridgeType = (target: Page = page) => target.evaluate(() => typeof (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop);

test('it shows the instance, in a session of its own, with no embedded server', async () => {
  expect(new URL(page.url()).origin).toBe(INSTANCE);
  const info = await app.evaluate(({ BrowserWindow, session, app: electronApp }, instance) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      isAppSession: window.webContents.session === session.fromPartition('persist:bulwark'),
      isDefault: window.webContents.session === session.defaultSession,
      partition: `persist:instance-${Buffer.from(instance).toString('base64url')}`,
      same: window.webContents.session === session.fromPartition(`persist:instance-${Buffer.from(instance).toString('base64url')}`),
      utility: electronApp.getAppMetrics().filter((m) => m.type === 'Utility' && m.name === 'Bulwark mail service').length,
    };
  }, INSTANCE);
  expect(info.isAppSession).toBe(false);
  expect(info.isDefault).toBe(false);
  expect(info.same).toBe(true);
  expect(info.utility).toBe(0);
  await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-instance-login.png') });
});

test('the bridge is there on the instance, but without the standalone parts', async () => {
  expect(await bridgeType()).toBe('object');
  const keys = await page.evaluate(() => Object.keys((window as unknown as { bulwarkDesktop: object }).bulwarkDesktop).sort());
  expect(keys).toEqual(['lifecycle', 'menu', 'mode', 'platform', 'policy', 'shell', 'theme', 'version', 'windows']);
});

test('the same preload on a foreign origin exposes no bridge', async () => {
  const foreign = 'https://stalwart-1.internal.bulwarkmail.org/.well-known/oauth-authorization-server';
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].webContents.loadURL(url), foreign);
  await page.waitForURL(foreign);
  expect(await bridgeType()).toBe('undefined');
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].webContents.loadURL(url), `${INSTANCE}/`);
  await page.waitForURL(new RegExp(`^${INSTANCE}/`));
  expect(await bridgeType()).toBe('object');
});

test('main checks the sender too: a foreign page on the channel gets refused', async () => {
  const denied = await app.evaluate(async ({ BrowserWindow, ipcMain }, channel) => {
    // What the handler does when a frame on another origin calls it.
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown) => unknown> })._invokeHandlers;
    const handler = handlers.get(channel)!;
    const window = BrowserWindow.getAllWindows()[0];
    try {
      await handler({ sender: window.webContents, senderFrame: { url: 'https://evil.example/', parent: null } });
      return 'allowed';
    } catch (error) {
      return (error as Error).message;
    }
  }, 'bulwark:windows.list');
  expect(denied).toBe('Not allowed');
});

test('other links open in the system browser, and the SSO chain stays in the window', async () => {
  await page.evaluate(() => {
    location.href = 'https://example.com/elsewhere';
  });
  await expect.poll(() => opened(app)).toContain('https://example.com/elsewhere');
  expect(new URL(page.url()).origin).toBe(INSTANCE);

  // An authorize request that comes back to the instance isn't "elsewhere".
  const authorize = new URL('https://stalwart-1.internal.bulwarkmail.org/.well-known/jmap');
  authorize.searchParams.set('redirect_uri', `${INSTANCE}/en/auth/callback`);
  await page.evaluate((url) => {
    location.href = url;
  }, authorize.toString());
  await page.waitForURL(/stalwart-1\.internal/);
  expect((await opened(app))).not.toContain(authorize.toString());
  await page.evaluate((url) => {
    location.href = url;
  }, `${INSTANCE}/`);
  await page.waitForURL(new RegExp(`^${INSTANCE}/`));

  // The chain ended with the return: leaving again is stopped.
  await page.evaluate(() => {
    location.href = 'https://example.com/after-chain';
  });
  await expect.poll(() => opened(app)).toContain('https://example.com/after-chain');
  expect(new URL(page.url()).origin).toBe(INSTANCE);
});

test('an instance that predates the title bar row gets a native frame, remembered', async () => {
  const knows = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--titlebar-inset') !== '');
  const remembered = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const { readFileSync } = await import('node:fs');
  await expect.poll(() => JSON.parse(readFileSync(path.join(remembered, 'shell-state.json'), 'utf8')).overlayByOrigin?.[INSTANCE]).toBe(knows);
});
