// What a page, or a plugin frame reaching the page's bridge, can do with one call and no click.
// Local hostile servers on 127.0.0.1 only. Needs a webmail build of the same age as the shell.
//
// page.evaluate can't stand for "no gesture": Playwright's counts as a user activation. So
// `noGesture` goes through main's executeJavaScript, and first checks none is left over.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { GOOGLE_DICTIONARY_URL, outsideHostsAllowed } from '../src/main/spellcheck';
import { profilePaths } from '../src/main/profile';
import { fakeOsIntegration, launch, launchStandalone, opened, prompts, removeProfile, shownPage, tempProfile, waitForLogin } from './helpers';

const CALLER = 'app.bulwark.localhost';
const idOf = (origin: string) => Buffer.from(origin).toString('base64url');

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

async function noGesture<T>(app: ElectronApplication, script: string, arg?: unknown): Promise<T> {
  return app.evaluate(async ({ BrowserWindow }, call) => {
    const contents = BrowserWindow.getAllWindows().find((window) => window.isVisible())!.webContents;
    const active = () => contents.executeJavaScript('navigator.userActivation.isActive');
    for (let tries = 0; await active(); tries += 1) {
      if (tries > 100) throw new Error('A user activation is still there');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return contents.executeJavaScript(`(async (d, a) => { ${call.script} })(window.bulwarkDesktop, ${JSON.stringify(call.arg ?? null)})`);
  }, { script, arg }) as Promise<T>;
}

/** A real mouse click on a button in the page, with the call in its handler. */
async function withClick<T>(page: Page, script: string, arg?: unknown): Promise<T> {
  await page.evaluate((call) => {
    document.getElementById('gesture-button')?.remove();
    const button = document.createElement('button');
    button.id = 'gesture-button';
    button.textContent = 'go';
    button.style.cssText = 'position:fixed;top:120px;left:120px;z-index:2147483647;width:80px;height:40px';
    document.body.append(button);
    // eslint-disable-next-line no-new-func
    const run = new Function('d', 'a', `return (async () => { ${call.script} })()`);
    button.addEventListener('click', () => {
      (window as unknown as { __go: unknown }).__go = run((window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop, call.arg);
    });
  }, { script, arg });
  await page.locator('#gesture-button').click();
  return page.evaluate(() => (window as unknown as { __go: Promise<T> }).__go) as Promise<T>;
}

const promptCount = async (app: ElectronApplication) => (await prompts(app)).length;
const setAnswer = (app: ElectronApplication, answer: number) => fakeOsIntegration(app, answer);

test('only a clear off for no-third-party mode opens the dictionary host', async () => {
  const says = (body: unknown, ok = true) => () => Promise.resolve({ ok, json: () => Promise.resolve(body) });
  expect(await outsideHostsAllowed(says({ noThirdPartyTraffic: false }))).toBe(true);
  expect(await outsideHostsAllowed(says({ noThirdPartyTraffic: true }))).toBe(false);
  expect(await outsideHostsAllowed(says({}))).toBe(false);
  expect(await outsideHostsAllowed(says(null))).toBe(false);
  expect(await outsideHostsAllowed(says({ noThirdPartyTraffic: false }, false))).toBe(false);
  expect(await outsideHostsAllowed(() => Promise.reject(new Error('down')))).toBe(false);
});

test.describe('one app, one hostile server', () => {
  let profile = '';
  let app: ElectronApplication;
  let page: Page;
  let hostile: { server: Server; origin: string };
  const seen: { url: string }[] = [];

  test.beforeAll(async () => {
    hostile = await listen((req, res) => {
      seen.push({ url: req.url ?? '' });
      if (req.url?.startsWith('/csd')) {
        res.writeHead(200, { 'content-type': 'application/json', 'clear-site-data': '"cookies", "storage"' });
        res.end('{}');
      } else if (req.url?.startsWith('/hdr')) {
        res.writeHead(200, {
          'content-type': 'text/javascript',
          'x-content-type-options': 'off',
          'cross-origin-resource-policy': 'cross-origin',
          'cache-control': 'public, max-age=3600',
          'report-to': '{"group":"g","max_age":1000,"endpoints":[{"url":"https://127.0.0.1:1/r"}]}',
          nel: '{"report_to":"g","max_age":1000}',
        });
        res.end('window.__pwn = (window.__pwn || 0) + 1;');
      } else if (req.url?.startsWith('/authorize')) {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('sign in here');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ url: req.url }));
      }
    });
    profile = tempProfile('hard');
    ({ app, page } = await launchStandalone(profile));
    await fakeOsIntegration(app);
    await waitForLogin(page);
    const prepared = await page.evaluate((origin) => (window as never as { bulwarkDesktop: { servers: { prepare(u: string): Promise<{ ok: boolean; approved: boolean }> } } }).bulwarkDesktop.servers.prepare(origin), hostile.origin);
    expect(prepared).toEqual({ ok: true, approved: true });
  });

  test.afterAll(async () => {
    await app.close().catch(() => {});
    hostile.server.close();
    hostile.server.closeAllConnections();
    removeProfile(profile);
  });

  test('a forwarded Clear-Site-Data wipes nothing of the app', async () => {
    await app.evaluate(async ({ session }) => {
      await session.fromPartition('persist:bulwark').cookies.set({ url: 'https://app.bulwark.localhost/', name: 'probe_http_only', value: '1', httpOnly: true, secure: true, expirationDate: Date.now() / 1000 + 3600 });
    });
    await page.evaluate(async () => {
      document.cookie = 'probeCookie=1; path=/; secure';
      localStorage.setItem('probe', 'kept');
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('probe-db', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('mail');
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
      await caches.open('probe-cache');
    });
    const readAll = async () => ({
      ...(await page.evaluate(async () => ({
        cookie: document.cookie.includes('probeCookie'),
        localStorage: localStorage.getItem('probe'),
        database: (await indexedDB.databases()).some((db) => db.name === 'probe-db'),
        cache: (await caches.keys()).includes('probe-cache'),
      }))),
      jar: await app.evaluate(async ({ session }) => (await session.fromPartition('persist:bulwark').cookies.get({})).some((c) => c.name === 'probe_http_only')),
    });
    const kept = { cookie: true, localStorage: 'kept', database: true, cache: true, jar: true };
    expect(await readAll()).toEqual(kept);
    const status = await page.evaluate((url) => fetch(url).then((r) => r.status), `/__jmap/${idOf(hostile.origin)}/csd`);
    expect(status).toBe(200);
    await page.waitForTimeout(1500);
    expect(await readAll()).toEqual(kept);
  });

  test('an answer fetched once can not run as a script tag afterwards', async () => {
    const path = `/__jmap/${idOf(hostile.origin)}/hdr`;
    const before = seen.length;
    const first = await page.evaluate(async (url) => {
      const response = await fetch(url);
      return Object.fromEntries(response.headers.entries());
    }, path);
    expect(first['cache-control']).toBe('no-store');
    expect(first['x-content-type-options']).toBe('nosniff');
    expect(first['cross-origin-resource-policy']).toBe('same-origin');
    expect(first['content-type']).toBe('application/octet-stream');
    expect(first['report-to']).toBeUndefined();
    expect(first.nel).toBeUndefined();

    const scripted = await page.evaluate(async (url) => {
      const outcome = await new Promise<string>((resolve) => {
        const script = document.createElement('script');
        script.src = url;
        script.onload = () => resolve('load');
        script.onerror = () => resolve('error');
        document.head.append(script);
        setTimeout(() => resolve('timeout'), 4000);
      });
      return { outcome, pwn: (window as never as { __pwn?: number }).__pwn ?? 0 };
    }, path);
    expect(scripted).toEqual({ outcome: 'error', pwn: 0 });
    expect(seen.slice(before).filter((r) => r.url === '/hdr')).toHaveLength(1);
  });

  test('Copy file: the same mark of the web and name rule as a drag', async () => {
    await app.evaluate(() => {
      const g = globalThis as unknown as { __clip: string[] };
      g.__clip = [];
      const getBuiltin = (process as unknown as { getBuiltinModule(name: string): any }).getBuiltinModule;
      const cp = getBuiltin('node:child_process');
      const { EventEmitter } = getBuiltin('node:events');
      const realSpawn = cp.spawn;
      cp.spawn = (cmd: string, args: string[], options: { env?: Record<string, string> }) => {
        if (!String(args).includes('Set-Clipboard')) return realSpawn(cmd, args, options);
        g.__clip.push(options.env?.BULWARK_CLIPBOARD_FILE ?? '');
        const child = new EventEmitter();
        setTimeout(() => child.emit('exit', 0), 10);
        return child;
      };
      getBuiltin('node:module').syncBuiltinESMExports();
    });
    const copy = async (name: string) => {
      const copied = await noGesture(app, 'return d.clipboard.copyFile(a, new Uint8Array([77, 90]).buffer);', name);
      expect(copied).toBe(true);
      return app.evaluate(() => {
        const fs = (process as unknown as { getBuiltinModule(name: string): any }).getBuiltinModule('node:fs');
        const file = (globalThis as unknown as { __clip: string[] }).__clip.at(-1) ?? '';
        let zone = 'absent';
        try {
          zone = fs.readFileSync(`${file}:Zone.Identifier`, 'utf8').replace(/\r?\n/g, ' ').trim();
        } catch {
          // No stream.
        }
        return { name: file.split(/[\\/]/).pop(), exists: fs.existsSync(file), zone };
      });
    };
    const marked = process.platform === 'win32' ? '[ZoneTransfer] ZoneId=3' : 'absent';
    expect(await copy('invoice.exe')).toEqual({ name: 'invoice.exe', exists: true, zone: marked });
    expect(await copy('shortcut.lnk')).toEqual({ name: 'shortcut.lnk.txt', exists: true, zone: marked });
    expect(await copy('..\\..\\evil.url')).toEqual({ name: '_.._evil.url.txt', exists: true, zone: marked });
  });

  test('browser sign-in: no click means a native question naming the host', async () => {
    const authorize = (redirectUri: string, state: string) => `${hostile.origin}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    const host = new URL(hostile.origin).host;

    await setAnswer(app, 1);
    let flow = await noGesture<{ flowId: string; redirectUri: string }>(app, 'return d.auth.beginBrowserSignIn();');
    const refused = noGesture<{ ok: boolean; error?: string }>(app, 'return d.auth.completeBrowserSignIn(a.flowId, a.url);', { flowId: flow.flowId, url: authorize(flow.redirectUri, 'one') });
    // Without the question the browser opens, and the flow would wait there for ten minutes.
    await expect.poll(() => promptCount(app), { timeout: 5000 }).toBe(1);
    expect((await prompts(app))[0].message).toContain(host);
    expect(await refused).toEqual({ ok: false, error: 'cancelled' });
    expect(await opened(app)).toEqual([]);

    await setAnswer(app, 0);
    flow = await noGesture<{ flowId: string; redirectUri: string }>(app, 'return d.auth.beginBrowserSignIn();');
    const allowed = noGesture<{ ok: boolean; code?: string }>(app, 'return d.auth.completeBrowserSignIn(a.flowId, a.url);', { flowId: flow.flowId, url: authorize(flow.redirectUri, 'two') });
    await expect.poll(() => opened(app)).toHaveLength(1);
    expect(await promptCount(app)).toBe(1);
    await fetch(`${flow.redirectUri}?code=THECODE&state=two`);
    expect(await allowed).toEqual({ ok: true, code: 'THECODE', state: 'two' });

    await setAnswer(app, 1);
    flow = await withClick<{ flowId: string; redirectUri: string }>(page, 'return d.auth.beginBrowserSignIn();');
    const clicked = page.evaluate(({ flowId, url }) => (window as never as { bulwarkDesktop: { auth: { completeBrowserSignIn(f: string, u: string): Promise<unknown> } } }).bulwarkDesktop.auth.completeBrowserSignIn(flowId, url), { flowId: flow.flowId, url: authorize(flow.redirectUri, 'three') });
    await expect.poll(() => opened(app)).toHaveLength(1);
    expect(await promptCount(app)).toBe(0);
    await fetch(`${flow.redirectUri}?code=CLICKED&state=three`);
    expect(await clicked).toEqual({ ok: true, code: 'CLICKED', state: 'three' });
    await setAnswer(app, 0);
  });

  test('start at login: turning it on takes a click, turning it off does not', async () => {
    await app.evaluate(({ app: electronApp }) => {
      const g = globalThis as unknown as { __login: unknown[] };
      g.__login = [];
      electronApp.setLoginItemSettings = ((settings: unknown) => {
        g.__login.push(settings);
      }) as typeof electronApp.setLoginItemSettings;
    });
    const loginCalls = () => app.evaluate(() => (globalThis as unknown as { __login: { openAtLogin: boolean }[] }).__login.map((c) => c.openAtLogin));

    const refused = await noGesture<{ settings: { startAtLogin: boolean; closeToTray: boolean } }>(app, 'return d.os.setSettings({ startAtLogin: true, closeToTray: false });');
    expect(refused.settings.startAtLogin).toBe(false);
    // The rest of the same call still counts: only the persistence needed the click.
    expect(refused.settings.closeToTray).toBe(false);
    expect(await loginCalls()).toEqual([]);

    const on = await withClick<{ settings: { startAtLogin: boolean } }>(page, 'return d.os.setSettings({ startAtLogin: true });');
    expect(on.settings.startAtLogin).toBe(true);
    expect(await loginCalls()).toEqual([true]);

    const off = await noGesture<{ settings: { startAtLogin: boolean } }>(app, 'return d.os.setSettings({ startAtLogin: false });');
    expect(off.settings.startAtLogin).toBe(false);
    expect(await loginCalls()).toEqual([true, false]);
  });

  test('a page can pause notifications for a day at most', async () => {
    const until = await noGesture<number>(app, 'd.os.setPaused(Date.now() + 365 * 86400000); await new Promise((r) => setTimeout(r, 200)); return (await d.os.getStatus()).pausedUntil;');
    expect(until).toBeGreaterThan(Date.now());
    expect(until).toBeLessThanOrEqual(Date.now() + 24 * 3600_000);
    const shorter = await noGesture<number>(app, 'const at = Date.now() + 3600000; d.os.setPaused(at); await new Promise((r) => setTimeout(r, 200)); return (await d.os.getStatus()).pausedUntil - at;');
    expect(shorter).toBe(0);
    const none = await noGesture<number | null>(app, 'd.os.setPaused(null); await new Promise((r) => setTimeout(r, 200)); return (await d.os.getStatus()).pausedUntil;');
    expect(none).toBeNull();
  });

  test('dialogs.confirm: titled with its caller, and only a few wait at once', async () => {
    await setAnswer(app, 0);
    expect(await noGesture(app, 'return d.dialogs.confirm({ message: "Bulwark needs your OK", buttons: ["Allow", "Cancel"], defaultId: 0 });')).toBe(0);
    const [question] = (await prompts(app)) as unknown as { title: string }[];
    expect(question.title).toContain(CALLER);
    expect(question.title).not.toBe('Bulwark');

    await app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __waiting: ((answer: { response: number }) => void)[] };
      g.__waiting = [];
      dialog.showMessageBox = (() => new Promise((resolve) => g.__waiting.push(resolve as never))) as never;
    });
    const answers = await noGesture<number[]>(app, `
      const asked = [0, 1, 2, 3, 4, 5, 6, 7].map(() => d.dialogs.confirm({ message: 'Again?', buttons: ['Yes', 'Keep asking', 'No'] }));
      window.__asked = asked;
      return Promise.race([Promise.all(asked.slice(3)), new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2000))]);
    `);
    // What's over the limit is answered with the safe last button, and no box comes up.
    expect(answers).toEqual([2, 2, 2, 2, 2]);
    expect(await app.evaluate(() => (globalThis as unknown as { __waiting: unknown[] }).__waiting.length)).toBe(3);
    await app.evaluate(() => {
      for (const resolve of (globalThis as unknown as { __waiting: ((answer: { response: number }) => void)[] }).__waiting) resolve({ response: 1 });
    });
    expect(await noGesture(app, 'return Promise.all(window.__asked.slice(0, 3));')).toEqual([1, 1, 1]);
    // Answered, so the next one gets through again.
    await setAnswer(app, 0);
    expect(await noGesture(app, 'return d.dialogs.confirm({ message: "Once more", buttons: ["Yes", "No"] });')).toBe(0);
  });

  test('where crash reports go takes a click', async () => {
    const before = await noGesture<{ crashReports: { uploadUrl: string } }>(app, 'return d.privacy.get();');
    const refused = await noGesture<{ ok: boolean; state: { crashReports: { uploadUrl: string } } }>(app, 'return d.privacy.setCrashUploadUrl("https://collector.invalid/x");');
    expect(refused.ok).toBe(false);
    expect(refused.state.crashReports.uploadUrl).toBe(before.crashReports.uploadUrl);
    const saved = await withClick<{ ok: boolean; state: { crashReports: { uploadUrl: string } } }>(page, 'return d.privacy.setCrashUploadUrl("https://collector.invalid/x");');
    expect(saved.ok).toBe(true);
    expect(saved.state.crashReports.uploadUrl).toBe('https://collector.invalid/x');
  });

  test('os.notify: a page can show only so many toasts a minute', async () => {
    await app.evaluate(({ BrowserWindow, Notification }) => {
      const g = globalThis as unknown as { __toasts: number; __bulwarkOs: { toasts: { setFocusAssistForTest(value: string | null): void } } };
      g.__toasts = 0;
      Notification.prototype.show = function show() {
        g.__toasts += 1;
      };
      g.__bulwarkOs.toasts.setFocusAssistForTest('off');
      // "focused" is a toast that's not shown, and it's not what this is about.
      for (const window of BrowserWindow.getAllWindows()) window.hide();
    });
    const answers = await page.evaluate(() => Promise.all(Array.from({ length: 30 }, (_, n) => (window as never as { bulwarkDesktop: { os: { notify(n: unknown): Promise<{ shown: boolean; reason?: string }> } } }).bulwarkDesktop.os.notify({ id: `spam-${n}`, title: 'Bulwark', body: 'Your password expired', context: '' }))));
    const shown = answers.filter((answer) => answer.shown).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(12);
    expect(answers.filter((answer) => !answer.shown).every((answer) => answer.reason === 'failed')).toBe(true);
    expect(await app.evaluate(() => (globalThis as unknown as { __toasts: number }).__toasts)).toBe(shown);
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.show();
    });
  });

  test('spellcheck dictionaries come when the server allows outside hosts', async () => {
    const dictionaryUrls = await app.evaluate(({ session }) => {
      const g = globalThis as unknown as { __dict: string[] };
      g.__dict = [];
      const s = session.fromPartition('persist:bulwark');
      s.setSpellCheckerDictionaryDownloadURL = ((url: string) => {
        g.__dict.push(url);
      }) as typeof s.setSpellCheckerDictionaryDownloadURL;
      return g.__dict;
    });
    expect(dictionaryUrls).toEqual([]);
    await noGesture(app, 'd.spellcheck.allowDownload();');
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __dict: string[] }).__dict)).toEqual([GOOGLE_DICTIONARY_URL]);
  });
});

test.describe('a window.open features string', () => {
  const HOSTILE = 'alwaysOnTop=yes,opacity=0.1,frame=no,kiosk=yes,fullscreen=yes,skipTaskbar=yes,transparent=yes,title=Your password expired';
  const KEYS = ['alwaysOnTop', 'opacity', 'frame', 'kiosk', 'fullscreen', 'skipTaskbar', 'transparent', 'title'] as const;
  type Created = { url: string; options: Record<string, unknown>; alwaysOnTop: boolean; opacity: number; kiosk: boolean; fullScreen: boolean };
  let profile = '';
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    profile = tempProfile('hard-open');
    ({ app, page } = await launchStandalone(profile));
    await waitForLogin(page);
    await app.evaluate(({ BrowserWindow }, keys) => {
      const g = globalThis as unknown as { __created: unknown[] };
      g.__created = [];
      const main = BrowserWindow.getAllWindows().find((window) => window.isVisible())!;
      main.webContents.on('did-create-window', (child, details) => {
        const options = details.options as unknown as Record<string, unknown>;
        g.__created.push({
          url: details.url,
          options: Object.fromEntries(keys.map((key) => [key, options[key]])),
          alwaysOnTop: child.isAlwaysOnTop(),
          opacity: child.getOpacity(),
          kiosk: child.isKiosk(),
          fullScreen: child.isFullScreen(),
        });
        child.close();
      });
    }, [...KEYS]);
  });

  test.afterAll(async () => {
    await app.close().catch(() => {});
    removeProfile(profile);
  });

  const open = async (url: string, name: string, features?: string): Promise<Created> => {
    const before = await app.evaluate(() => (globalThis as unknown as { __created: unknown[] }).__created.length);
    await page.evaluate(({ url: target, name: frame, features: wanted }) => void window.open(target, frame, wanted), { url, name, features });
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __created: unknown[] }).__created.length)).toBe(before + 1);
    return app.evaluate(() => (globalThis as unknown as { __created: unknown[] }).__created.at(-1)) as Promise<Created>;
  };

  test('sets nothing on an about:blank pop-up', async () => {
    const window = await open('about:blank', '_blank', HOSTILE);
    for (const key of KEYS) {
      expect.soft(window.options[key], key).toEqual({ alwaysOnTop: false, opacity: 1, frame: true, kiosk: false, fullscreen: false, skipTaskbar: false, transparent: false, title: 'Bulwark' }[key]);
    }
    expect({ alwaysOnTop: window.alwaysOnTop, opacity: window.opacity, kiosk: window.kiosk, fullScreen: window.fullScreen }).toEqual({ alwaysOnTop: false, opacity: 1, kiosk: false, fullScreen: false });
  });

  test('sets nothing on an adopted composer: it gets what one with no string gets', async () => {
    const plain = await open('/en/popout/compose?probe=1', 'plain-composer');
    const window = await open('/en/popout/compose?probe=2', 'hostile-composer', HOSTILE);
    for (const key of KEYS) expect.soft(window.options[key], key).toEqual(plain.options[key]);
    expect({ alwaysOnTop: window.alwaysOnTop, opacity: window.opacity, kiosk: window.kiosk, fullScreen: window.fullScreen }).toEqual({ alwaysOnTop: false, opacity: 1, kiosk: false, fullScreen: false });
  });

  test('a page still gets its pop-up sized as it asked', async () => {
    const window = await open('about:blank', '_blank', 'width=420,height=300');
    expect(window.options.title).toBe('Bulwark');
  });

  test('a Bluetooth chooser nobody answers is cancelled, not given the first device', async () => {
    const answer = (where: 'main' | 'popup') => app.evaluate(({ BrowserWindow, webContents }, kind) => new Promise((resolve) => {
      const contents = kind === 'main'
        ? BrowserWindow.getAllWindows().find((window) => window.isVisible())!.webContents
        : webContents.getAllWebContents().find((candidate) => candidate.getURL() === 'about:blank' && !candidate.isDestroyed())!;
      let prevented = false;
      contents.emit('select-bluetooth-device', { preventDefault: () => { prevented = true; } }, [{ deviceName: 'First', deviceId: 'first' }], (id: string) => resolve({ prevented, id }));
      setTimeout(() => resolve({ prevented, id: 'nobody answered' }), 1000);
    }), where);
    expect(await answer('main')).toEqual({ prevented: true, id: '' });
    // Every web contents, not only the windows the manager knows.
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((window) => window.isVisible())!;
      main.webContents.removeAllListeners('did-create-window');
    });
    await page.evaluate(() => void window.open('about:blank', '_blank'));
    await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().some((candidate) => candidate.getURL() === 'about:blank'))).toBe(true);
    expect(await answer('popup')).toEqual({ prevented: true, id: '' });
  });
});

test('no-third-party mode: spell.allowDownload changes nothing, whoever calls it', async () => {
  const profile = tempProfile('hard-3p');
  // A first run, since a profile with a config and no secrets counts as damaged.
  const first = await launchStandalone(profile);
  await first.app.close();
  const config = path.join(profilePaths(profile).adminConfig, 'config.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), noThirdPartyTraffic: true }));
  const { app, page } = await launchStandalone(profile);
  try {
    await waitForLogin(page);
    await app.evaluate(({ session }) => {
      const g = globalThis as unknown as { __dict: string[] };
      g.__dict = [];
      const s = session.fromPartition('persist:bulwark');
      s.setSpellCheckerDictionaryDownloadURL = ((url: string) => {
        g.__dict.push(url);
      }) as typeof s.setSpellCheckerDictionaryDownloadURL;
    });
    expect(await page.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.noThirdPartyTraffic))).toBe(true);
    await page.evaluate(() => (window as never as { bulwarkDesktop: { spellcheck: { allowDownload(): void } } }).bulwarkDesktop.spellcheck.allowDownload());
    await page.waitForTimeout(2000);
    expect(await app.evaluate(() => (globalThis as unknown as { __dict: string[] }).__dict)).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    removeProfile(profile);
  }
});

test('the app lock: no click, no silent enrol; a lock with no PIN clears, if the user says so', async () => {
  const profile = tempProfile('hard-lock');
  const gate = (app: ElectronApplication) => app.evaluate(() => {
    const g = (globalThis as unknown as { __bulwarkAppLock: { gate: { locked: boolean; enrolled: boolean } } }).__bulwarkAppLock.gate;
    return { locked: g.locked, enrolled: g.enrolled };
  });
  const start = async (answer: number) => {
    const app = await launch(profile, '--standalone');
    // Before the page: it may ask as it starts, and nobody can click a box in a test.
    await fakeOsIntegration(app, answer);
    const page = await shownPage(app);
    await waitForLogin(page);
    return { app, page };
  };
  const enroll = 'return d.appLock.enroll(new Uint8Array(32).fill(7));';

  let { app, page } = await start(1);
  try {
    expect(await promptCount(app)).toBe(0);
    // A no holds for this run: a plugin can't ask again and again.
    expect(await noGesture(app, enroll)).toBe(false);
    expect(await promptCount(app)).toBe(1);
    expect(await noGesture(app, enroll)).toBe(false);
    expect(await promptCount(app)).toBe(1);
    expect((await gate(app)).enrolled).toBe(false);
    await app.close();

    ({ app, page } = await start(0));
    expect(await noGesture(app, enroll)).toBe(true);
    expect(await promptCount(app)).toBe(1);
    expect((await gate(app)).enrolled).toBe(true);
    await noGesture(app, 'return d.appLock.forget(new Uint8Array(32).fill(7));');
    expect((await gate(app)).enrolled).toBe(false);
    const before = await promptCount(app);
    expect(await withClick(page, enroll)).toBe(true);
    expect(await promptCount(app)).toBe(before);
    await app.close();

    // Main keeps a lock, and this profile has no PIN for it. A no leaves it, for this run.
    ({ app, page } = await start(1));
    await expect.poll(() => promptCount(app)).toBe(1);
    expect((await prompts(app))[0].message).toMatch(/PIN/);
    expect(await gate(app)).toEqual({ locked: true, enrolled: true });
    await page.reload();
    await waitForLogin(page);
    await page.waitForTimeout(1000);
    expect(await promptCount(app)).toBe(1);
    await app.close();

    // A yes clears it, and nothing is left to ask about at the next start.
    ({ app, page } = await start(0));
    await expect.poll(() => promptCount(app)).toBe(1);
    await expect.poll(() => gate(app)).toEqual({ locked: false, enrolled: false });
    await app.close();

    ({ app, page } = await start(0));
    await page.waitForTimeout(1000);
    expect(await promptCount(app)).toBe(0);
    expect(await gate(app)).toEqual({ locked: false, enrolled: false });
  } finally {
    await app.close().catch(() => {});
    removeProfile(profile);
  }
});
