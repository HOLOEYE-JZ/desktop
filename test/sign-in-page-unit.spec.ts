import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { chromium, expect, test, type Browser } from '@playwright/test';
import { CALLBACK_PATH, LoopbackSignIn } from '../src/main/browser-sign-in';
import { formPage, outcomePage, pageCsp, pickLanguage, SIGN_IN_LANGUAGES, type SignInOutcome } from '../src/main/sign-in-page';
import STRINGS from '../src/pages/sign-in-strings.json' with { type: 'json' };

/**
 * The pages the browser lands on during "Sign in with your browser": the webmail's sign-in
 * card in its standard theme, in the browser's language. Rendered by a headless Chromium of
 * the test's own, never the user's browser. No Electron.
 *
 * BULWARK_SCREENSHOTS=<folder> keeps a picture of each page, light and dark.
 */

const OWNER = 3;
const SHOTS = process.env.BULWARK_SCREENSHOTS;
const html = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Answer {
  status: number;
  body: string;
}

function raw(port: number, target: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

async function flow(extra: Partial<ConstructorParameters<typeof LoopbackSignIn>[0]> = {}) {
  const opened: string[] = [];
  const signIn = new LoopbackSignIn({ open: async (url) => void opened.push(url), bringForward: () => {}, ...extra });
  const begun = await signIn.begin(OWNER, 'oauth', 'https://mail.example');
  if (!begun.ok) throw new Error(begun.error);
  const authorize = new URL('https://mail.example/login');
  for (const [key, value] of Object.entries({ redirect_uri: begun.redirectUri, state: begun.state, code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
  void signIn.complete(begun.flowId, authorize.toString(), OWNER);
  await expect.poll(() => opened.length).toBe(1);
  return { signIn, begun, port: Number(new URL(begun.redirectUri).port) };
}

async function passwordFlow(extra: Partial<ConstructorParameters<typeof LoopbackSignIn>[0]> = {}) {
  const opened: string[] = [];
  const signIn = new LoopbackSignIn({ open: async (url) => void opened.push(url), bringForward: () => {}, ports: new Map(), ...extra });
  const begun = await signIn.begin(OWNER, 'oauth', 'http://192.168.1.5:8080');
  if (!begun.ok) throw new Error(begun.error);
  await signIn.beginPassword(begun.flowId, OWNER);
  const url = new URL(opened[0]);
  return { signIn, flowId: begun.flowId, port: Number(url.port), token: url.pathname };
}

const nonceOf = (body: string) => /name="nonce" value="([^"]+)"/.exec(body)?.[1] ?? '';

function post(port: number, token: string, nonce: string, headers: Record<string, string> = {}) {
  return raw(port, token, {
    method: 'POST',
    headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', ...headers },
    body: new URLSearchParams({ nonce, username: 'a@example.org', password: 'pw' }).toString(),
  });
}

test.describe('the look', () => {
  test('the standard theme, light and dark, with the app icon\'s mark in the brand colour', async () => {
    const { begun, port } = await flow();
    const { body } = await raw(port, `${CALLBACK_PATH}?code=c&state=${begun.state}`);
    // The webmail's standard theme (app/globals.css), light...
    for (const variable of ['--background:#ffffff', '--foreground:#0f172a', '--primary:#185aea', '--primary-foreground:#ffffff', '--muted-foreground:#59687c', '--border:#e2e8f0']) {
      expect(body).toContain(variable);
    }
    // ...and dark, by the browser's setting.
    const dark = /@media \(prefers-color-scheme:dark\)\{:root\{([^}]*)\}\}/.exec(body)?.[1] ?? '';
    for (const variable of ['--background:#0a0a0a', '--foreground:#fafafa', '--primary:#fafafa', '--primary-foreground:#171717', '--muted-foreground:#adadad']) {
      expect(dark).toContain(variable);
    }
    expect(body).toContain('<meta name="color-scheme" content="light dark">');
    // Not the old page's own navy and blue.
    for (const old of ['#0b1120', '#111827', '#3b82f6;--field', 'system-ui']) expect(body).not.toContain(old);
    // The app icon's artwork (the favicon), in the brand colour.
    expect(body).toContain('--logo:#db2d54');
    expect(body).toContain('.logo{display:block;width:64px;height:64px;margin:8px auto 20px;fill:var(--logo)}');
    expect(body).toContain('<svg class="logo" viewBox="0 0 1000 1000" role="img" aria-label="Bulwark"><path d="M 483.028 563.647');
    expect(body).toContain('M 765.645 857.641');
    // The sign-in card and the app's primary button.
    expect(body).toContain('<main class="card">');
    expect(body).toContain('<a class="button" href="bulwark://inbox">');
  });

  test('every outcome renders: what happened, what to do, close the tab, the way back', () => {
    const words = STRINGS.en;
    const expected: Record<SignInOutcome, string[]> = {
      done: [words.doneTitle],
      declined: [words.declinedTitle, words.declinedText],
      failed: [words.failedTitle, words.tryAgain, 'role="alert"'],
      used: [words.usedTitle, words.usedText, 'role="alert"'],
      expired: [words.expiredTitle, words.startAgain, 'role="alert"'],
    };
    for (const [outcome, texts] of Object.entries(expected) as [SignInOutcome, string[]][]) {
      const page = outcomePage('en', outcome);
      for (const text of [...texts, words.closeTab, words.openApp]) expect(page, `${outcome}: ${text}`).toContain(text.startsWith('role=') ? text : html(text));
      expect(page, outcome).toContain(`<title>${html(expected[outcome][0])}</title>`);
    }
    expect(outcomePage('en', 'done')).not.toContain('role="alert"');
    expect(outcomePage('en', 'done', 'a@example.org')).toContain(html(words.doneAs.replace('{address}', 'a@example.org')));
  });
});

test.describe('the language', () => {
  test('the browser\'s first language the pages have, then the app\'s, then English', () => {
    expect(SIGN_IN_LANGUAGES).toHaveLength(30);
    expect(pickLanguage('de-DE,de;q=0.9,en;q=0.8')).toBe('de');
    expect(pickLanguage('en-US,en;q=0.9')).toBe('en');
    expect(pickLanguage('xx-YY, fr-CH;q=0.7, de;q=0.8')).toBe('de');
    expect(pickLanguage('en;q=0, nl')).toBe('nl');
    expect(pickLanguage('zh-Hant-TW')).toBe('zh-TW');
    expect(pickLanguage('zh-HK,zh;q=0.9')).toBe('zh-TW');
    expect(pickLanguage('zh-CN')).toBe('zh');
    expect(pickLanguage('nn-NO')).toBe('nb');
    expect(pickLanguage('pt-BR')).toBe('pt');
    expect(pickLanguage(undefined, 'de-AT')).toBe('de');
    expect(pickLanguage('xx', 'de')).toBe('de');
    expect(pickLanguage('*')).toBe('en');
    expect(pickLanguage(undefined)).toBe('en');
  });

  test('every language has every text', () => {
    const keys = Object.keys(STRINGS.en).sort();
    for (const [language, words] of Object.entries(STRINGS)) {
      expect(Object.keys(words).sort(), language).toEqual(keys);
      for (const [key, value] of Object.entries(words)) expect(value.trim(), `${language}.${key}`).not.toBe('');
      if (language !== 'en') expect(words.doneTitle, language).not.toBe(STRINGS.en.doneTitle);
    }
  });

  test('the redirect\'s page speaks the browser\'s language: German, English, Arabic right to left', async () => {
    const de = await flow();
    const german = await raw(de.port, `${CALLBACK_PATH}?code=c&state=${de.begun.state}`, { headers: { 'accept-language': 'de-DE,de;q=0.9,en;q=0.8' } });
    expect(german.body).toContain('<html lang="de" dir="ltr">');
    expect(german.body).toContain('Sie sind angemeldet');
    expect(german.body).toContain('Sie können diesen Tab schließen.');
    expect(german.body).toContain('>Bulwark öffnen</a>');

    const en = await flow({ language: () => 'de-DE' });
    const english = await raw(en.port, `${CALLBACK_PATH}?code=c&state=${en.begun.state}`, { headers: { 'accept-language': 'en-GB,en;q=0.9' } });
    expect(english.body).toContain('<html lang="en" dir="ltr">');
    expect(english.body).toContain('You can close this tab.');
    expect(english.body).toContain('>Open Bulwark</a>');

    // No header: the app's language.
    const app = await flow({ language: () => 'de-DE' });
    expect((await raw(app.port, `${CALLBACK_PATH}?code=c&state=${app.begun.state}`)).body).toContain('Sie sind angemeldet');

    const ar = await flow();
    const arabic = await raw(ar.port, `${CALLBACK_PATH}?code=c&state=${ar.begun.state}`, { headers: { 'accept-language': 'ar-EG' } });
    expect(arabic.body).toContain('<html lang="ar" dir="rtl">');
    expect(arabic.body).toContain(html(STRINGS.ar.closeTab));
  });

  test('the password pages speak it too, the form, its errors and its result', async () => {
    const { signIn, flowId, port, token } = await passwordFlow();
    const german = { 'accept-language': 'de' };
    const form = await raw(port, token, { headers: german });
    expect(form.body).toContain('Bei 192.168.1.5:8080 anmelden');
    expect(form.body).toContain('>Anmelden</button>');
    const next = signIn.nextPassword(flowId, OWNER);
    const wrong = post(port, token, nonceOf(form.body), german);
    await next;
    signIn.answerPassword(flowId, OWNER, { ok: false, error: 'invalid_credentials' });
    const wrongPage = (await wrong).body;
    expect(wrongPage).toContain(STRINGS.de.wrongPassword);
    expect(wrongPage).toContain('role="alert"');
    const again = signIn.nextPassword(flowId, OWNER);
    const done = post(port, token, nonceOf(wrongPage), german);
    await again;
    signIn.answerPassword(flowId, OWNER, { ok: true });
    const donePage = (await done).body;
    expect(donePage).toContain('Sie sind angemeldet');
    expect(donePage).toContain('Angemeldet als a@example.org.');
    expect(donePage).toContain('>Bulwark öffnen</a>');
  });
});

test.describe('the error pages', () => {
  test('not our redirect: it didn\'t work, go back and try again', async () => {
    const { signIn, port } = await flow();
    const answer = await raw(port, `${CALLBACK_PATH}?code=c&state=wrong`);
    expect(answer.status).toBe(400);
    expect(answer.body).toContain(html(STRINGS.en.failedTitle));
    expect(answer.body).toContain(html(STRINGS.en.tryAgain));
    signIn.closeAll();
  });

  test('the server said no: cancelled, nothing handed over', async () => {
    const { begun, port } = await flow();
    const answer = await raw(port, `${CALLBACK_PATH}?error=access_denied&state=${begun.state}`);
    expect(answer.status).toBe(403);
    expect(answer.body).toContain(html(STRINGS.en.declinedTitle));
    expect(answer.body).toContain(html(STRINGS.en.declinedText));
  });

  test('a link opened twice: already used', async () => {
    const { signIn, port, token } = await passwordFlow();
    await raw(port, token);
    const second = await raw(port, token, { headers: { 'accept-language': 'de' } });
    expect(second.status).toBe(410);
    expect(second.body).toContain(STRINGS.de.usedTitle);
    signIn.closeAll();
  });

  test('a tab still waiting when the sign-in runs out of time: expired, start again', async () => {
    const { port, token } = await passwordFlow({ timeoutMs: 800 });
    const form = await raw(port, token);
    const answer = await post(port, token, nonceOf(form.body));
    expect(answer.status).toBe(410);
    expect(answer.body).toContain(html(STRINGS.en.expiredTitle));
    expect(answer.body).toContain(html(STRINGS.en.startAgain));
  });
});

test.describe('in a browser', () => {
  let browser: Browser;
  test.beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  test.afterAll(async () => {
    await browser?.close();
  });

  test('code and state leave the address bar at once, under the page\'s own policy', async () => {
    const { begun, port } = await flow();
    const context = await browser.newContext({ locale: 'en-US' });
    const tab = await context.newPage();
    const refused: string[] = [];
    tab.on('console', (message) => {
      if (message.type() === 'error') refused.push(message.text());
    });
    await tab.goto(`http://127.0.0.1:${port}${CALLBACK_PATH}?code=the-code&state=${begun.state}&iss=https%3A%2F%2Fmail.example`);
    await expect.poll(() => tab.url()).toBe(`http://127.0.0.1:${port}${CALLBACK_PATH}`);
    await expect(tab.locator('h1')).toHaveText(STRINGS.en.doneTitle);
    expect(refused).toEqual([]);
    await context.close();
  });

  test('a declined redirect keeps what it says, and loses the state', async () => {
    const { begun, port } = await flow();
    const context = await browser.newContext({ locale: 'en-US' });
    const tab = await context.newPage();
    await tab.goto(`http://127.0.0.1:${port}${CALLBACK_PATH}?error=access_denied&state=${begun.state}`);
    await expect.poll(() => tab.url()).toBe(`http://127.0.0.1:${port}${CALLBACK_PATH}?error=access_denied`);
    await context.close();
  });

  /** Serves a page as the listener does, headers and all, at a callback-shaped address. */
  async function serve(page: string, withScript: boolean): Promise<{ server: Server; url: string }> {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': pageCsp(withScript) });
      res.end(page);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${CALLBACK_PATH}?code=c&state=s` };
  }

  test('light and dark: the theme\'s colours reach the card and the button', async () => {
    const colours: Record<string, Record<string, string>> = {};
    for (const scheme of ['light', 'dark'] as const) {
      const { server, url } = await serve(outcomePage('en', 'done'), true);
      const context = await browser.newContext({ colorScheme: scheme });
      const tab = await context.newPage();
      await tab.goto(url);
      colours[scheme] = await tab.evaluate(() => {
        const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        return { text: style('h1').color, button: style('.button').backgroundColor, buttonText: style('.button').color, logo: style('.logo').fill };
      });
      await context.close();
      server.close();
    }
    expect(colours.light).toEqual({ text: 'rgb(15, 23, 42)', button: 'rgb(24, 90, 234)', buttonText: 'rgb(255, 255, 255)', logo: 'rgb(219, 45, 84)' });
    expect(colours.dark).toEqual({ text: 'rgb(250, 250, 250)', button: 'rgb(250, 250, 250)', buttonText: 'rgb(23, 23, 23)', logo: 'rgb(219, 45, 84)' });
  });

  test('pictures of each page, light and dark', async () => {
    test.skip(!SHOTS, 'BULWARK_SCREENSHOTS not set');
    const pages: [string, string, boolean][] = [
      ['done', outcomePage('en', 'done'), true],
      ['done-password', outcomePage('en', 'done', 'anna@example.org'), true],
      ['done-de', outcomePage('de', 'done'), true],
      ['declined', outcomePage('en', 'declined'), true],
      ['failed', outcomePage('en', 'failed'), true],
      ['used', outcomePage('en', 'used'), true],
      ['expired', outcomePage('en', 'expired'), true],
      ['done-ar', outcomePage('ar', 'done'), true],
      ['form', formPage('en', { host: 'mail.example.org', nonce: 'n', username: '', problem: null, needsCode: false }), false],
      ['form-wrong', formPage('en', { host: 'mail.example.org', nonce: 'n', username: 'anna@example.org', problem: 'wrongPassword', needsCode: false }), false],
      ['form-code', formPage('en', { host: 'mail.example.org', nonce: 'n', username: 'anna@example.org', problem: 'codeNeeded', needsCode: true }), false],
    ];
    for (const [name, page, withScript] of pages) {
      const { server, url } = await serve(page, withScript);
      for (const scheme of ['light', 'dark'] as const) {
        const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 900, height: 700 } });
        const tab = await context.newPage();
        await tab.goto(url);
        await tab.screenshot({ path: path.join(SHOTS!, `signin-landing-${name}-${scheme}.png`) });
        await context.close();
      }
      server.close();
    }
  });
});
