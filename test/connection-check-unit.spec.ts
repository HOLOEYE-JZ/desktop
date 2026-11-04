import { expect, test } from '@playwright/test';
import { checkInstance, configUrls, looksLikeBulwarkConfig, type CheckFetch } from '../src/main/instance-check';
import { changeConnectionUrl, LOAD_ERROR_TEXT, loadErrorPage, loadErrorTextFor, noteLoadErrorPage, retryTarget, showsLoadError, showsLoadErrorPage } from '../src/main/load-error';

const LANGUAGES = ['ar', 'ca', 'cs', 'da', 'de', 'en', 'es', 'et', 'fa', 'fr', 'he', 'hu', 'it', 'ja', 'ko', 'lv', 'mn', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-TW'];
const BULWARK_CONFIG = { appName: 'Webmail', jmapServerUrl: 'https://mail.example.org', oauthEnabled: false };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answers by URL; anything else throws as Chromium does for a host that doesn't resolve. */
function server(routes: Record<string, () => Response | Promise<Response>>): CheckFetch & { asked: string[] } {
  const asked: string[] = [];
  const fetcher = (async (url: string): Promise<Response> => {
    asked.push(url);
    const route = routes[url];
    if (!route) throw new Error('net::ERR_NAME_NOT_RESOLVED');
    return route();
  }) as unknown as CheckFetch & { asked: string[] };
  fetcher.asked = asked;
  return fetcher;
}

test.describe('checking an organisation address before the first run takes it', () => {
  test('a Bulwark answers its config without a sign-in, and that is enough', async () => {
    const fetcher = server({ 'https://mail.example.org/api/config': () => json(BULWARK_CONFIG) });
    expect(await checkInstance('https://mail.example.org/', fetcher)).toEqual({ ok: true });
    expect(fetcher.asked).toEqual(['https://mail.example.org/api/config']);
  });

  test('an address that does not resolve or answer is unreachable', async () => {
    expect(await checkInstance('https://mail.example/', server({}))).toEqual({ ok: false, error: 'unreachable' });
    const refused: CheckFetch = async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED');
    };
    expect(await checkInstance('https://mail.example.org/', refused)).toEqual({ ok: false, error: 'unreachable' });
  });

  test('a server that never answers is unreachable after the time limit', async () => {
    const hanging: CheckFetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const started = Date.now();
    expect(await checkInstance('https://mail.example.org/', hanging, 200)).toEqual({ ok: false, error: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(2000);
    // A body that never ends is cut off just the same.
    const slowBody: CheckFetch = async () => ({ ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}) }) as unknown as Response;
    expect(await checkInstance('https://mail.example.org/', slowBody, 200)).toEqual({ ok: false, error: 'unreachable' });
  });

  test('a website that answers something else is not a Bulwark', async () => {
    const html = () => new Response('<!doctype html><title>Example</title>', { status: 200, headers: { 'content-type': 'text/html' } });
    expect(await checkInstance('https://example.com/', server({ 'https://example.com/api/config': html }))).toEqual({ ok: false, error: 'not_bulwark' });
    expect(await checkInstance('https://example.com/', server({ 'https://example.com/api/config': () => new Response('nope', { status: 404 }) }))).toEqual({ ok: false, error: 'not_bulwark' });
    expect(await checkInstance('https://example.com/', server({ 'https://example.com/api/config': () => json({ status: 'ok' }) }))).toEqual({ ok: false, error: 'not_bulwark' });
    expect(await checkInstance('https://example.com/', server({ 'https://example.com/api/config': () => json(BULWARK_CONFIG, 500) }))).toEqual({ ok: false, error: 'not_bulwark' });
  });

  test('a webmail under a path is asked there first, then at the root of its site', async () => {
    expect(configUrls('https://example.org/webmail/')).toEqual(['https://example.org/webmail/api/config', 'https://example.org/api/config']);
    expect(configUrls('https://example.org/')).toEqual(['https://example.org/api/config']);
    const underPath = server({ 'https://example.org/webmail/api/config': () => json(BULWARK_CONFIG) });
    expect(await checkInstance('https://example.org/webmail/', underPath)).toEqual({ ok: true });
    const atRoot = server({ 'https://example.org/webmail/api/config': () => new Response('', { status: 404 }), 'https://example.org/api/config': () => json(BULWARK_CONFIG) });
    expect(await checkInstance('https://example.org/webmail/', atRoot)).toEqual({ ok: true });
    expect(atRoot.asked).toHaveLength(2);
  });

  test('a server behind a sign-in or asking for a client certificate is let through', async () => {
    const gated = server({ 'https://mail.example.org/api/config': () => new Response('', { status: 401, headers: { 'www-authenticate': 'Negotiate' } }) });
    expect(await checkInstance('https://mail.example.org/', gated)).toEqual({ ok: true });
    const wantsCertificate: CheckFetch = async () => {
      throw new Error('net::ERR_BAD_SSL_CLIENT_AUTH_CERT');
    };
    expect(await checkInstance('https://mail.example.org/', wantsCertificate)).toEqual({ ok: true });
    // A plain 401 without a challenge is no sign-in prompt the window could show.
    const bare = server({ 'https://mail.example.org/api/config': () => new Response('', { status: 401 }) });
    expect(await checkInstance('https://mail.example.org/', bare)).toEqual({ ok: false, error: 'not_bulwark' });
  });

  test('a certificate the system does not trust is unreachable, not let through', async () => {
    const badCert: CheckFetch = async () => {
      throw new Error('net::ERR_CERT_AUTHORITY_INVALID');
    };
    expect(await checkInstance('https://mail.example.org/', badCert)).toEqual({ ok: false, error: 'unreachable' });
  });

  test('the config has to name the app and its mail server', () => {
    expect(looksLikeBulwarkConfig(BULWARK_CONFIG)).toBe(true);
    expect(looksLikeBulwarkConfig({ appName: 'x' })).toBe(false);
    expect(looksLikeBulwarkConfig([])).toBe(false);
    expect(looksLikeBulwarkConfig(null)).toBe(false);
    expect(looksLikeBulwarkConfig('appName')).toBe(false);
  });
});

test.describe('the page for a server that does not load', () => {
  test('shows for any failed load of the window, but not a replaced one or a frame', () => {
    expect(showsLoadError(-105, true)).toBe(true);
    expect(showsLoadError(-102, true)).toBe(true);
    expect(showsLoadError(-202, true)).toBe(true);
    expect(showsLoadError(-3, true)).toBe(false);
    expect(showsLoadError(-105, false)).toBe(false);
  });

  test('names the host, has Try again, and Change connection only where the user may change it', () => {
    const change = changeConnectionUrl('https://mail.example', 'n0nce');
    expect(change).toBe('https://mail.example/?bulwark-change-connection=n0nce');
    const page = decodeURIComponent(loadErrorPage('en-US', 'mail.example', 'https://mail.example/en/mail', change));
    expect(page.startsWith('data:text/html')).toBe(true);
    expect(page).toContain(LOAD_ERROR_TEXT.en.title.replaceAll("'", '&#39;'));
    expect(page).toContain('mail.example');
    expect(page).toContain('id="retry"');
    expect(page).toContain('href="https://mail.example/en/mail"');
    expect(page).toContain(`href="${change}"`);
    expect(page).not.toMatch(/<script/i);
    expect(page).toContain("default-src 'none'");
    const locked = decodeURIComponent(loadErrorPage('en-US', 'mail.example', 'https://mail.example/', null));
    expect(locked).toContain('id="retry"');
    expect(locked).not.toContain('id="change"');
    expect(locked).not.toContain('bulwark-change-connection');
    expect(decodeURIComponent(loadErrorPage('en', '<b>x</b>', 'https://x/"><script>', null))).not.toMatch(/<b>x<\/b>|"><script>/);
    expect(decodeURIComponent(loadErrorPage('ar', 'x', 'https://x/', null))).toContain('dir="rtl"');
  });

  test('Try again goes back to the server, never to a sign-in provider', () => {
    expect(retryTarget('https://mail.example/en/mail', 'https://mail.example', 'https://mail.example/')).toBe('https://mail.example/en/mail');
    expect(retryTarget('https://idp.example/authorize', 'https://mail.example', 'https://mail.example/')).toBe('https://mail.example/');
    expect(retryTarget('', 'https://mail.example', 'https://mail.example/')).toBe('https://mail.example/');
  });

  test('the tray keeps trying behind it', () => {
    const contents = {};
    const page = loadErrorPage('en', 'mail.example', 'https://mail.example/', null);
    expect(showsLoadErrorPage(contents, page)).toBe(false);
    noteLoadErrorPage(contents, page);
    expect(showsLoadErrorPage(contents, page)).toBe(true);
    expect(showsLoadErrorPage(contents, 'https://mail.example/')).toBe(false);
    noteLoadErrorPage(contents, null);
    expect(showsLoadErrorPage(contents, page)).toBe(false);
  });

  test('is in all 30 languages, none left in English', () => {
    expect(Object.keys(LOAD_ERROR_TEXT).sort()).toEqual([...LANGUAGES].sort());
    for (const language of LANGUAGES) {
      const text = LOAD_ERROR_TEXT[language];
      expect(text.body, language).toContain('{host}');
      expect(text.change.endsWith('…'), language).toBe(true);
      for (const key of Object.keys(LOAD_ERROR_TEXT.en) as (keyof typeof text)[]) {
        expect(text[key].trim(), `${language}.${key}`).not.toBe('');
        if (language !== 'en') expect(text[key], `${language}.${key}`).not.toBe(LOAD_ERROR_TEXT.en[key]);
      }
    }
    expect(loadErrorTextFor('de-AT')).toBe(LOAD_ERROR_TEXT.de);
    expect(loadErrorTextFor('zh-Hant-HK')).toBe(LOAD_ERROR_TEXT['zh-TW']);
    expect(loadErrorTextFor('nn')).toBe(LOAD_ERROR_TEXT.nb);
    expect(loadErrorTextFor('xx')).toBe(LOAD_ERROR_TEXT.en);
  });
});
