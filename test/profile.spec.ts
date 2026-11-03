import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { fakeOsIntegration, launch, launchStandalone, opened, prompts, removeProfile, SCREENSHOTS, shownPage, tempProfile, waitForLogin } from './helpers';

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

  test('one that is gone from a set-up profile is an error page, not a silent new secret', async () => {
    const profile = tempProfile('secret3');
    const first = await launchStandalone(profile);
    await waitForLogin(first.page);
    await first.app.close();
    const file = path.join(profile, 'keys', 'session-secret.bin');
    rmSync(file);

    const app = await launch(profile, '--standalone');
    const page = await shownPage(app);
    await expect(page.locator('body')).toContainText(/key file is missing|Schlüsseldatei/);
    expect(existsSync(file)).toBe(false);
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
  test('the overlay stays see-through over the app, and its symbols follow the theme live', async () => {
    test.skip(process.platform !== 'win32', 'the coloured overlay is Windows only');
    const profile = tempProfile('overlay');
    mkdirSync(profile, { recursive: true });
    const app = await launch(profile, '--standalone');
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as { __overlays: unknown[] };
      g.__overlays = [];
      const original = BrowserWindow.prototype.setTitleBarOverlay;
      BrowserWindow.prototype.setTitleBarOverlay = function patched(options) {
        g.__overlays.push(options);
        return original.call(this, options);
      };
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
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __overlays: { color: string }[] }).__overlays.at(-1)?.color)).toBe('#00000000');
    const symbol = await app.evaluate(() => (globalThis as unknown as { __overlays: { symbolColor: string }[] }).__overlays.at(-1)?.symbolColor);
    expect(symbol).toBe('#f4f4f5');
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { theme: { set: (t: object) => void } } }).bulwarkDesktop.theme.set({ dark: false, background: 'rgb(255, 255, 255)' }));
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __overlays: { color: string }[] }).__overlays.at(-1)?.color)).toBe('#00000000');
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

test.describe('closing and quitting', () => {
  const FLUSH_SETUP = `(() => {
    window.__flushed = 0;
    window.bulwarkDesktop.lifecycle.onFlushRequest(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      window.__flushed += 1;
      // Readable after the window has gone.
      await fetch('/api/health/live');
      localStorage.setItem('flushed-marker', String(window.__flushed));
    });
  })()`;

  test('closing a window waits for the page to save first', async () => {
    const profile = tempProfile('flush');
    const { app, page } = await launchStandalone(profile);
    await waitForLogin(page);
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      void main.webContents.executeJavaScript("window.bulwarkDesktop.windows.open('/en/login?x=1', {name:'second', width: 500, height: 500})");
    });
    await expect.poll(() => app.windows().filter((p) => !p.isClosed()).length).toBe(2);
    const second = app.windows().filter((p) => !p.isClosed()).find((p) => p !== page)!;
    await waitForLogin(second);
    await second.evaluate(FLUSH_SETUP);
    await second.evaluate(() => localStorage.removeItem('flushed-marker'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => y.id - x.id)[0].close());
    await expect.poll(() => app.windows().filter((p) => !p.isClosed()).length).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('flushed-marker'))).toBe('1');
    await app.close();
    removeProfile(profile);
  });

  test('a page that never answers cannot hold the window open', async () => {
    const profile = tempProfile('hang');
    const { app, page } = await launchStandalone(profile);
    await waitForLogin(page);
    // It may hold unsaved text, so the quit asks. Answered: it goes.
    await fakeOsIntegration(app, 0);
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (f: () => Promise<void>) => void } } }).bulwarkDesktop.lifecycle.onFlushRequest(() => new Promise(() => {})));
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(12_000);
    removeProfile(profile);
  });

  test('quitting saves first, and only then quits', async () => {
    const profile = tempProfile('quit');
    const { app, page } = await launchStandalone(profile);
    await waitForLogin(page);
    await page.evaluate(FLUSH_SETUP);
    const log = path.join(profile, 'order.txt');
    await app.evaluate(({ app: electronApp, ipcMain }, file) => {
      const { appendFileSync } = process.getBuiltinModule('node:fs');
      ipcMain.on('bulwark:lifecycle.flushed', () => appendFileSync(file, 'saved\n'));
      electronApp.on('will-quit', () => appendFileSync(file, 'quit\n'));
    }, log);
    await app.close();
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['saved', 'quit']);
    removeProfile(profile);
  });

  test('a window that opens during the quit, and has something to save by the end, does not call the quit off', async () => {
    const profile = tempProfile('quit-late');
    const { app, page } = await launchStandalone(profile);
    await waitForLogin(page);
    // Asked to save, the page opens a window, and takes long enough for that to load and sign up too.
    await page.evaluate(() => {
      const desktop = (window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (f: () => Promise<void>) => void }; windows: { open: (u: string, o: object) => void } } }).bulwarkDesktop;
      desktop.lifecycle.onFlushRequest(async () => {
        desktop.windows.open('/en/login?late=1', { name: 'late', width: 500, height: 500 });
        await new Promise((resolve) => setTimeout(resolve, 3000));
      });
    });
    // Preventing a close during a quit is what calls the quit off.
    const held = path.join(profile, 'held.txt');
    await app.evaluate(({ app: electronApp }, file) => {
      const { appendFileSync } = process.getBuiltinModule('node:fs');
      electronApp.on('browser-window-created', (_event, window) => {
        window.on('close', (event) => setImmediate(() => {
          if (event.defaultPrevented) appendFileSync(file, 'held\n');
        }));
      });
    }, held);
    const closed = app.waitForEvent('close', { timeout: 30_000 });
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await closed;
    expect(existsSync(held)).toBe(false);
    removeProfile(profile);
  });

  test('changing the connection: Stay keeps the mode, Leave forgets it', async () => {
    const profile = tempProfile('switch');
    mkdirSync(profile, { recursive: true });
    const stateFile = path.join(profile, 'shell-state.json');
    writeFileSync(stateFile, JSON.stringify({ mode: 'standalone' }));
    const app = await launch(profile);
    const page = await shownPage(app);
    await waitForLogin(page);
    await fakeOsIntegration(app, 1); // Stay
    await page.click('body', { position: { x: 5, y: 5 } });
    await page.evaluate(() => window.addEventListener('beforeunload', (event) => event.preventDefault()));
    const switchMode = () =>
      app.evaluate(({ Menu, app: electronApp }) => {
        electronApp.relaunch = () => {};
        const find = (menu: Electron.Menu | null): Electron.MenuItem | undefined => {
          for (const item of menu?.items ?? []) {
            if (/Change connection|Verbindung/.test(item.label)) return item;
            const inner = find(item.submenu ?? null);
            if (inner) return inner;
          }
          return undefined;
        };
        (find(Menu.getApplicationMenu())!.click as unknown as () => void)();
      });
    await switchMode();
    await expect.poll(async () => (await prompts(app)).length).toBe(1);
    await page.waitForTimeout(500);
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).mode).toBe('standalone');
    expect(page.isClosed()).toBe(false);

    // Stayed: an ordinary quit later must not forget the mode.
    await fakeOsIntegration(app, 0); // Leave
    await app.close();
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).mode).toBe('standalone');
    removeProfile(profile);
  });

  test('and with Leave the mode is forgotten', async () => {
    const profile = tempProfile('switch2');
    mkdirSync(profile, { recursive: true });
    const stateFile = path.join(profile, 'shell-state.json');
    writeFileSync(stateFile, JSON.stringify({ mode: 'standalone' }));
    const app = await launch(profile);
    const page = await shownPage(app);
    await waitForLogin(page);
    await fakeOsIntegration(app, 0);
    const closed = app.waitForEvent('close');
    await app.evaluate(({ Menu, app: electronApp }) => {
      electronApp.relaunch = () => {};
      const find = (menu: Electron.Menu | null): Electron.MenuItem | undefined => {
        for (const item of menu?.items ?? []) {
          if (/Change connection|Verbindung/.test(item.label)) return item;
          const inner = find(item.submenu ?? null);
          if (inner) return inner;
        }
        return undefined;
      };
      (find(Menu.getApplicationMenu())!.click as unknown as () => void)();
    });
    await closed;
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).mode).toBeUndefined();
    removeProfile(profile);
  });
});

test.describe('another launch', () => {
  test('with only a pop-out left, it opens the main window', async () => {
    const profile = tempProfile('second');
    const { app, page } = await launchStandalone(profile);
    await waitForLogin(page);
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { open: (u: string, o: object) => void } } }).bulwarkDesktop.windows.open('/popout/message/m1', { name: 'm1', width: 600, height: 500 }));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => x.id - y.id)[0].destroy());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const second = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [path.join(ROOT, 'dist', 'main.mjs'), `--bulwark-user-data=${profile}`, '--standalone'], { env, stdio: 'ignore' });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 30_000 }).toBe(2);
    second.kill();
    await app.close();
    removeProfile(profile);
  });
});

test.describe('a popup asking for too much', () => {
  test('stays on a screen', async () => {
    const profile = tempProfile('clamp');
    const { app, page } = await launchStandalone(profile);
    await waitForLogin(page);
    await page.evaluate(() => {
      window.open('/popout/message/huge', 'huge', 'popup=yes,width=20000,height=20000,left=90000,top=90000');
      window.open('about:blank', '_blank', 'popup=yes,width=20000,height=20000,left=90000,top=90000');
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(3);
    const fits = await app.evaluate(({ BrowserWindow, screen }) => {
      return BrowserWindow.getAllWindows().map((w) => {
        const b = w.getBounds();
        const area = screen.getDisplayMatching(b).workArea;
        return b.x >= area.x - 10 && b.y >= area.y - 10 && b.x + b.width <= area.x + area.width + 10 && b.y + b.height <= area.y + area.height + 10;
      });
    });
    expect(fits).toEqual([true, true, true]);
    await app.close();
    removeProfile(profile);
  });
});
