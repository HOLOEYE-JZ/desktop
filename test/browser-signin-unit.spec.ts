import { connect } from 'node:net';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { expect, test } from '@playwright/test';
import { CALLBACK_PATH, LoopbackSignIn, navigationAllowed, SCHEME_REDIRECT_URI, type SignInText } from '../src/main/browser-sign-in';
import { deepLinkFromArgv, parseDeepLink } from '../src/main/deep-link';
import { LABEL_KEY, labelKeepsPlaceholders } from '../src/main/label-keys';
import { requestFromUrl } from '../src/main/features/os-rules';

/**
 * The real listener, on the real loopback, with attacks by raw HTTP: a browser wouldn't
 * let a test send most of these. No Electron.
 */

const TEXT: SignInText = {
  signInDone: 'DONE',
  signInFailed: 'FAILED',
  signInLinkUsed: 'USED',
  signInDeclined: 'DECLINED',
  signInPageTitle: 'Sign in to {server}',
  signInPageIntro: 'Goes to {server}',
  signInUsername: 'User',
  signInPassword: 'Pass',
  signInCode: 'Code',
  signInSubmit: 'Go',
  signInWrongPassword: 'WRONG',
  signInCodeNeeded: 'NEEDS CODE',
  signInNoAnswer: 'NO ANSWER',
};

const OWNER = 7;

function rig(extra: Partial<ConstructorParameters<typeof LoopbackSignIn>[0]> = {}) {
  const opened: string[] = [];
  const forward: number[] = [];
  const signIn = new LoopbackSignIn({
    open: async (url) => {
      opened.push(url);
    },
    bringForward: (owner) => forward.push(owner),
    text: () => TEXT,
    ...extra,
  });
  return { signIn, opened, forward };
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Sends exactly these headers. */
function raw(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const portOf = (redirectUri: string) => Number(new URL(redirectUri).port);

function portState(port: number): Promise<'open' | 'closed'> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve('open');
    });
    socket.once('error', () => resolve('closed'));
  });
}

function authorizeUrl(redirectUri: string, state: string, extra: Record<string, string> = {}): string {
  const url = new URL('https://mail.example/login');
  for (const [key, value] of Object.entries({ redirect_uri: redirectUri, state, code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', ...extra })) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function started(extra: Parameters<typeof rig>[0] = {}) {
  const parts = rig(extra);
  const begun = await parts.signIn.begin(OWNER, 'oauth', 'https://mail.example');
  if (!begun.ok) throw new Error(begun.error);
  const result = parts.signIn.complete(begun.flowId, authorizeUrl(begun.redirectUri, begun.state), OWNER);
  await expect.poll(() => parts.opened.length).toBe(1);
  return { ...parts, begun, port: portOf(begun.redirectUri), result };
}

const callback = (state: string, code = 'the-code') => `${CALLBACK_PATH}?code=${code}&state=${state}`;

test.describe('the listener', () => {
  test('takes one redirect, hands the code to the flow, closes and brings the window forward', async () => {
    const { begun, port, result, forward, opened } = await started();
    expect(opened[0]).toContain(encodeURIComponent(begun.redirectUri));
    const answer = await raw(port, callback(begun.state));
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('DONE');
    expect(answer.body).not.toContain('the-code');
    expect(await result).toEqual({ ok: true, code: 'the-code', state: begun.state, iss: undefined });
    expect(forward).toEqual([OWNER]);
    await expect.poll(() => portState(port)).toBe('closed');
  });

  test('binds to loopback only', async () => {
    const { begun, port } = await started();
    expect(begun.redirectUri).toBe(`http://127.0.0.1:${port}${CALLBACK_PATH}`);
    const others = Object.values(networkInterfaces()).flat().filter((net) => net && !net.internal && net.family === 'IPv4').map((net) => net!.address);
    for (const address of others) {
      const reached = await new Promise((resolve) => {
        const socket = connect({ host: address, port });
        socket.setTimeout(1500, () => {
          socket.destroy();
          resolve(false);
        });
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => resolve(false));
      });
      expect(reached, address).toBe(false);
    }
  });

  test('a wrong state gets nothing and changes nothing', async () => {
    const { begun, port, result, forward } = await started();
    for (const state of ['wrong', '', `${begun.state}x`, begun.state.slice(1)]) {
      const answer = await raw(port, callback(state));
      expect(answer.status).toBe(400);
      expect(answer.body).not.toContain('the-code');
    }
    expect(forward).toEqual([]);
    expect(await portState(port)).toBe('open');
    await raw(port, callback(begun.state, 'real'));
    expect(await result).toMatchObject({ ok: true, code: 'real' });
  });

  test('a code can come once: the second redirect finds nothing there', async () => {
    const { begun, port, result } = await started();
    await raw(port, callback(begun.state));
    await result;
    await expect.poll(() => portState(port)).toBe('closed');
    await expect(raw(port, callback(begun.state, 'again'))).rejects.toThrow();
  });

  test('another origin gets nothing: not a fetch, an image, a frame or a preflight, and no CORS header ever', async () => {
    const { begun, port, result } = await started();
    const attacks: { method?: string; headers: Record<string, string> }[] = [
      { headers: { origin: 'https://evil.example' } },
      { headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'cross-site' } },
      { headers: { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image', 'sec-fetch-site': 'cross-site' } },
      { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' } },
      { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } },
      { method: 'POST', headers: { origin: 'https://evil.example' } },
      // A form's post with no Origin to go on, from an old browser or a local tool.
      { method: 'POST', headers: {} },
      { method: 'HEAD', headers: {} },
    ];
    for (const attack of attacks) {
      const answer = await raw(port, callback(begun.state), attack);
      expect(answer.status, JSON.stringify(attack)).toBeGreaterThanOrEqual(400);
      expect(Object.keys(answer.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
    }
    expect(await portState(port)).toBe('open');
    // A real browser's redirect from the server's page does get through.
    const ok = await raw(port, callback(begun.state), { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' } });
    expect(ok.status).toBe(200);
    expect((await result).ok).toBe(true);
  });

  test('a wrong Host header gets nothing: DNS rebinding', async () => {
    const { begun, port } = await started();
    for (const host of ['evil.example', `evil.example:${port}`, `localhost:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`]) {
      const answer = await raw(port, callback(begun.state), { headers: { host } });
      expect(answer.status, host).toBe(403);
      expect(answer.body).toBe('');
    }
    expect(await portState(port)).toBe('open');
  });

  test('answers only the expected path', async () => {
    const { begun, port } = await started();
    for (const path of ['/', '/bulwark-desktop', `${CALLBACK_PATH}/x`, `/x${CALLBACK_PATH}`]) {
      expect((await raw(port, `${path}?code=x&state=${begun.state}`)).status, path).toBe(404);
    }
    expect(await portState(port)).toBe('open');
  });

  test('its page can run nothing, frame nothing, and leaks nothing to the next one', async () => {
    const { begun, port } = await started();
    const { headers } = await raw(port, callback(begun.state));
    const csp = String(headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('script');
    expect(headers['referrer-policy']).toBe('same-origin');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['x-frame-options']).toBe('DENY');
  });

  test('a provider that says no ends the flow, and what it said goes nowhere', async () => {
    const { begun, port, result } = await started();
    const answer = await raw(port, `${CALLBACK_PATH}?error=access_denied&error_description=${encodeURIComponent('<script>x</script>')}&state=${begun.state}`);
    expect(answer.body).not.toContain('script>');
    expect(await result).toEqual({ ok: false, error: 'denied' });
  });

  test('a no from the page tells the app at once and says so in the tab, with the right state only', async () => {
    const { begun, port, result, forward } = await started();
    const forged = await raw(port, `${CALLBACK_PATH}?error=access_denied&state=wrong`);
    expect(forged.status).toBe(400);
    expect(await portState(port)).toBe('open');
    const answer = await raw(port, `${CALLBACK_PATH}?error=access_denied&state=${begun.state}`);
    expect(answer.body).toContain('DECLINED');
    expect(await result).toEqual({ ok: false, error: 'denied' });
    expect(forward).toEqual([OWNER]);
    await expect.poll(() => portState(port)).toBe('closed');
  });

  test('an expired flow fails clearly, closes, and can be started again', async () => {
    const { signIn, opened, begun, port, result } = await started({ timeoutMs: 150 });
    expect(await result).toEqual({ ok: false, error: 'timeout' });
    await expect.poll(() => portState(port)).toBe('closed');
    const second = await signIn.begin(OWNER, 'oauth', 'https://mail.example');
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.state).not.toBe(begun.state);
      void signIn.complete(second.flowId, authorizeUrl(second.redirectUri, second.state), OWNER);
      await expect.poll(() => opened.length).toBe(2);
      signIn.closeAll();
    }
  });

  test('a new click replaces what the window had waiting', async () => {
    const { signIn, result, port } = await started();
    const next = await signIn.begin(OWNER, 'oauth', 'https://mail.example');
    expect(await result).toEqual({ ok: false, error: 'cancelled' });
    await expect.poll(() => portState(port)).toBe('closed');
    signIn.closeAll();
    expect(next.ok).toBe(true);
  });

  test('only the window that began a flow can drive it', async () => {
    const { signIn } = rig();
    const begun = await signIn.begin(OWNER, 'oauth', 'https://mail.example');
    if (!begun.ok) throw new Error(begun.error);
    const url = authorizeUrl(begun.redirectUri, begun.state);
    expect(await signIn.complete(begun.flowId, url, OWNER + 1)).toEqual({ ok: false, error: 'unknown_flow' });
    signIn.cancel(begun.flowId, OWNER + 1);
    expect(await portState(portOf(begun.redirectUri))).toBe('open');
    signIn.cancelFor(OWNER);
    await expect.poll(() => portState(portOf(begun.redirectUri))).toBe('closed');
  });
});

test.describe('what the browser may be sent to', () => {
  const refused = async (make: (redirectUri: string, state: string) => string, extra: Parameters<typeof rig>[0] = {}, kind: 'oauth' | 'instance' = 'oauth', origin: string | null = 'https://mail.example') => {
    const { signIn, opened } = rig(extra);
    const begun = await signIn.begin(OWNER, kind, origin);
    if (!begun.ok) throw new Error(begun.error);
    expect(await signIn.complete(begun.flowId, make(begun.redirectUri, begun.state), OWNER)).toEqual({ ok: false, error: 'invalid_url' });
    expect(opened).toEqual([]);
  };

  test('never a redirect that is not this flow\'s', () => refused((_uri, state) => authorizeUrl('http://127.0.0.1:1/other', state)));
  test('never without this flow\'s state', () => refused((uri) => authorizeUrl(uri, 'chosen-by-the-page')));
  test('never without PKCE', () => refused((uri, state) => authorizeUrl(uri, state, { code_challenge_method: 'plain' })));
  test('never another scheme', () => refused((uri, state) => authorizeUrl(uri, state).replace('https://mail.example/login', 'file:///c:/x')));
  test('never with a password in the address', () => refused((uri, state) => authorizeUrl(uri, state).replace('https://', 'https://u:p@')));
  test('never plain http for a server on https', () => refused((uri, state) => authorizeUrl(uri, state).replace('https://', 'http://')));
  test('plain http for a server the user allowed that way', async () => {
    const { signIn, opened } = rig();
    const begun = await signIn.begin(OWNER, 'oauth', 'http://192.168.1.5:8080');
    if (!begun.ok) throw new Error(begun.error);
    void signIn.complete(begun.flowId, authorizeUrl(begun.redirectUri, begun.state).replace('https://mail.example', 'http://192.168.1.5:8080'), OWNER);
    await expect.poll(() => opened.length).toBe(1);
    signIn.closeAll();
  });

  const instanceUrl = (origin: string, uri: string, state: string) => {
    const url = new URL(`${origin}/en/login`);
    url.searchParams.set('mobile_redirect_uri', uri);
    url.searchParams.set('mobile_state', state);
    url.searchParams.set('mobile_code_challenge', 'c'.repeat(43));
    return url.toString();
  };
  const INSTANCE = { instanceOrigin: 'https://bulwark.example' };

  test('on an instance, its own origin and no other', async () => {
    await refused((uri, state) => instanceUrl('https://evil.example', uri, state), INSTANCE, 'instance', null);
    const { signIn, opened } = rig(INSTANCE);
    const begun = await signIn.begin(OWNER, 'instance', null);
    if (!begun.ok) throw new Error(begun.error);
    void signIn.complete(begun.flowId, instanceUrl('https://bulwark.example', begun.redirectUri, begun.state), OWNER);
    await expect.poll(() => opened.length).toBe(1);
    expect(new URL(opened[0]).origin).toBe('https://bulwark.example');
    signIn.closeAll();
  });

  test('on an instance, not without its challenge', () =>
    refused((uri, state) => instanceUrl('https://bulwark.example', uri, state).replace(/&mobile_code_challenge=[^&]+/, ''), INSTANCE, 'instance', null));
});

test.describe('a sent link', () => {
  test('the parser reads the one shape, and it is no request', () => {
    expect(parseDeepLink('bulwark://sign-in/callback?code=a&state=b')).toEqual({ kind: 'sign-in', code: 'a', state: 'b' });
    expect(deepLinkFromArgv(['app.exe', 'bulwark://sign-in/callback?code=a&state=b'])).toEqual({ kind: 'sign-in', code: 'a', state: 'b' });
    for (const bad of ['bulwark://sign-in/callback?code=a', 'bulwark://sign-in/callback?state=b', 'bulwark://sign-in/other?code=a&state=b', 'bulwark://sign-in?code=a&state=b', 'bulwark://sign-in/callback?code=%00&state=b']) {
      expect(parseDeepLink(bad), bad).toBeNull();
    }
    expect(requestFromUrl('bulwark://sign-in/callback?code=a&state=b')).toEqual({ commands: [], links: [] });
  });

  test('does nothing with no flow, or a flow on loopback, or the wrong state', async () => {
    const { signIn } = rig();
    expect(signIn.deliverLink('attacker-code', 'attacker-state')).toBe(false);

    const { signIn: waiting, begun, result, forward } = await started();
    // The flow is on loopback, so the scheme isn't its way in, even with the right state.
    expect(waiting.deliverLink('attacker-code', begun.state)).toBe(false);
    expect(forward).toEqual([]);
    waiting.closeAll();
    expect(await result).toEqual({ ok: false, error: 'cancelled' });
  });

  test('finishes a flow on the scheme, once, only with its state', async () => {
    const { signIn, opened, forward } = rig();
    const begun = await signIn.begin(OWNER, 'oauth', 'https://mail.example');
    if (!begun.ok) throw new Error(begun.error);
    const port = portOf(begun.redirectUri);
    expect(signIn.useScheme(begun.flowId, OWNER)).toBe(SCHEME_REDIRECT_URI);
    await expect.poll(() => portState(port)).toBe('closed');
    // Not yet opened: nobody can have asked for this.
    expect(signIn.deliverLink('early', begun.state)).toBe(false);
    const result = signIn.complete(begun.flowId, authorizeUrl(SCHEME_REDIRECT_URI, begun.state), OWNER);
    await expect.poll(() => opened.length).toBe(1);
    expect(signIn.deliverLink('attacker-code', 'attacker-state')).toBe(false);
    expect(forward).toEqual([]);
    expect(signIn.deliverLink('real', begun.state)).toBe(true);
    expect(await result).toMatchObject({ ok: true, code: 'real' });
    expect(forward).toEqual([OWNER]);
    expect(signIn.deliverLink('again', begun.state)).toBe(false);
  });
});

test.describe('the password page, for a server with no OAuth', () => {
  const SERVER = 'http://192.168.1.5:8080';

  async function page(extra: Parameters<typeof rig>[0] = {}, server = SERVER) {
    const parts = rig({ ports: new Map(), ...extra });
    const begun = await parts.signIn.begin(OWNER, 'oauth', server);
    if (!begun.ok) throw new Error(begun.error);
    const start = await parts.signIn.beginPassword(begun.flowId, OWNER);
    expect(start).toEqual({ ok: true, host: new URL(server).host });
    const url = new URL(parts.opened[0]);
    return { ...parts, flowId: begun.flowId, url, port: Number(url.port), token: url.pathname };
  }

  const nonceOf = (html: string) => /name="nonce" value="([^"]+)"/.exec(html)?.[1] ?? '';

  function post(port: number, path: string, nonce: string, headers: Record<string, string> = {}, fields: Record<string, string> = { username: 'a@example.org', password: 'pw' }) {
    return raw(port, path, {
      method: 'POST',
      headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', ...headers },
      body: new URLSearchParams({ nonce, ...fields }).toString(),
    });
  }

  test('names the server, with what a password manager looks for, and no script', async () => {
    const { signIn, port, token } = await page();
    const answer = await raw(port, token);
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('Sign in to 192.168.1.5:8080');
    expect(answer.body).toContain('autocomplete="username"');
    expect(answer.body).toContain('autocomplete="current-password"');
    expect(answer.body).toContain('type="password"');
    expect(answer.body).not.toContain('<script');
    expect(String(answer.headers['content-security-policy'])).toContain("form-action 'self'");
    signIn.closeAll();
  });

  test('its one-time address only opens once, and a wrong one opens nothing', async () => {
    const { signIn, port, token } = await page();
    expect((await raw(port, '/sign-in/guess')).status).toBe(410);
    expect((await raw(port, '/')).status).toBe(404);
    expect((await raw(port, token)).status).toBe(200);
    const second = await raw(port, token);
    expect(second.status).toBe(410);
    expect(second.body).toContain('USED');
    expect(second.body).not.toContain('type="password"');
    signIn.closeAll();
  });

  test('gives nothing to another origin or another Host', async () => {
    const { signIn, port, token } = await page();
    for (const headers of [{ origin: 'https://evil.example' }, { host: 'evil.example' }, { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }] as Record<string, string>[]) {
      expect((await raw(port, token, { headers })).status, JSON.stringify(headers)).toBe(403);
    }
    // And those didn't use the address up.
    expect((await raw(port, token)).status).toBe(200);
    signIn.closeAll();
  });

  test('a post from anywhere else goes nowhere', async () => {
    const { signIn, port, token, flowId } = await page();
    const nonce = nonceOf((await raw(port, token)).body);
    const attempts: Promise<unknown>[] = [signIn.nextPassword(flowId, OWNER)];
    let got = false;
    void attempts[0].then(() => {
      got = true;
    });
    const attacks: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
      { host: 'evil.example' },
      { 'content-type': 'text/plain' },
    ];
    for (const headers of attacks) {
      expect((await post(port, token, nonce, headers)).status, JSON.stringify(headers)).toBe(403);
    }
    expect((await post(port, token, 'wrong-nonce')).status).toBe(403);
    expect((await post(port, '/sign-in/other', nonce)).status).toBe(403);
    expect(got).toBe(false);
    signIn.closeAll();
    expect(await attempts[0]).toEqual({ ok: false, error: 'cancelled' });
  });

  test('a post goes to the app, the tab waits, a wrong password is said there and not reflected', async () => {
    const { signIn, port, token, flowId, forward } = await page();
    const nonce = nonceOf((await raw(port, token)).body);
    const next = signIn.nextPassword(flowId, OWNER);
    const tab = post(port, token, nonce, {}, { username: 'a@example.org', password: 'the-secret-password' });
    expect(await next).toEqual({ ok: true, username: 'a@example.org', password: 'the-secret-password' });

    signIn.answerPassword(flowId, OWNER, { ok: false, error: 'invalid_credentials' });
    const wrong = await tab;
    expect(wrong.status).toBe(401);
    expect(wrong.body).toContain('WRONG');
    expect(wrong.body).toContain('value="a@example.org"');
    expect(wrong.body).not.toContain('the-secret-password');
    expect(forward).toEqual([]);

    // The old form's nonce is spent, and a new one works.
    expect((await post(port, token, nonce)).status).toBe(403);
    const second = signIn.nextPassword(flowId, OWNER);
    const retry = post(port, token, nonceOf(wrong.body));
    await second;
    signIn.answerPassword(flowId, OWNER, { ok: true });
    const done = await retry;
    expect(done.status).toBe(200);
    expect(done.body).toContain('DONE');
    expect(done.body).not.toContain('type="password"');
    await expect.poll(() => forward).toEqual([OWNER]);
    await expect.poll(() => portState(port)).toBe('closed');
  });

  test('asks for the code when the server wants one', async () => {
    const { signIn, port, token, flowId } = await page();
    const nonce = nonceOf((await raw(port, token)).body);
    const next = signIn.nextPassword(flowId, OWNER);
    const tab = post(port, token, nonce);
    await next;
    signIn.answerPassword(flowId, OWNER, { ok: false, error: 'totp_required' });
    const answer = await tab;
    expect(answer.body).toContain('NEEDS CODE');
    expect(answer.body).toContain('autocomplete="one-time-code"');
    const again = signIn.nextPassword(flowId, OWNER);
    const retry = post(port, token, nonceOf(answer.body), {}, { username: 'a', password: 'b', totp: ' 123456 ' });
    expect(await again).toEqual({ ok: true, username: 'a', password: 'b', totp: '123456' });
    signIn.answerPassword(flowId, OWNER, { ok: true });
    await retry;
  });

  test('a tab left waiting gets told, and an app that never answers doesn\'t hang it', async () => {
    const { signIn, port, token, flowId } = await page({ attemptTimeoutMs: 100 });
    const nonce = nonceOf((await raw(port, token)).body);
    void signIn.nextPassword(flowId, OWNER);
    const answer = await post(port, token, nonce);
    expect(answer.status).toBe(502);
    expect(answer.body).toContain('NO ANSWER');
    signIn.closeAll();
  });

  /** A post whose tab has gone by the time the app answers. */
  async function abandonedPost(port: number, token: string, nonce: string) {
    const socket = connect({ host: '127.0.0.1', port });
    await new Promise((resolve) => socket.once('connect', resolve));
    const body = new URLSearchParams({ nonce, username: 'a', password: 'b' }).toString();
    socket.write(`POST ${token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    return socket;
  }

  test('a good login with its tab already closed ends at once, not after ten minutes', async () => {
    const { signIn, port, token, flowId, forward } = await page();
    const nonce = nonceOf((await raw(port, token)).body);
    const next = signIn.nextPassword(flowId, OWNER);
    const socket = await abandonedPost(port, token, nonce);
    await next;
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const outcome = signIn.outcome(flowId, OWNER);
    signIn.answerPassword(flowId, OWNER, { ok: true });
    expect(await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve('hung'), 2000))])).toMatchObject({ ok: true });
    expect(forward).toEqual([OWNER]);
    await expect.poll(() => portState(port)).toBe('closed');
  });

  test('cancelling frees the port, with a tab still waiting or one already gone', async () => {
    for (const leaveFirst of [false, true]) {
      const { signIn, port, token, flowId } = await page();
      const nonce = nonceOf((await raw(port, token)).body);
      const next = signIn.nextPassword(flowId, OWNER);
      const socket = await abandonedPost(port, token, nonce);
      await next;
      if (leaveFirst) {
        socket.destroy();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      signIn.cancel(flowId, OWNER);
      await expect.poll(() => portState(port)).toBe('closed');
      socket.destroy();
    }
  });

  test('expiry ends it for the app and the tab', async () => {
    const { signIn, port, token, flowId } = await page({ timeoutMs: 400 });
    expect((await raw(port, token)).status).toBe(200);
    expect(await signIn.nextPassword(flowId, OWNER)).toEqual({ ok: false, error: 'timeout' });
    expect(await signIn.outcome(flowId, OWNER)).toEqual({ ok: false, error: 'unknown_flow' });
    await expect.poll(() => portState(port)).toBe('closed');
  });

  test('keeps a port per server: the same next time, another for another server', async () => {
    const ports = new Map<string, number>();
    let changes = 0;
    const first = await page({ ports, portsChanged: () => (changes += 1) });
    first.signIn.closeAll();
    await expect.poll(() => portState(first.port)).toBe('closed');
    const second = await page({ ports, portsChanged: () => (changes += 1) });
    expect(second.port).toBe(first.port);
    expect(new URL(second.opened[0]).pathname).not.toBe(first.token);
    second.signIn.closeAll();
    const other = await page({ ports }, 'http://192.168.1.6');
    expect(other.port).not.toBe(first.port);
    other.signIn.closeAll();
    expect(changes).toBe(1);
    expect(ports.size).toBe(2);
  });

  test('a port someone holds isn\'t used, and whoever holds it is sent nobody', async () => {
    const { createServer } = await import('node:net');
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const held = (squatter.address() as { port: number }).port;
    const ports = new Map([[SERVER, held]]);
    const { signIn, port, opened } = await page({ ports });
    expect(port).not.toBe(held);
    expect(new URL(opened[0]).port).not.toBe(String(held));
    expect(ports.get(SERVER)).toBe(port);
    signIn.closeAll();
    squatter.close();
  });
});

test('a page\'s translation can\'t take the server\'s name off the password page', () => {
  expect(LABEL_KEY.test('signInPageTitle')).toBe(true);
  expect(labelKeepsPlaceholders('signInPageTitle', 'Bei {server} anmelden')).toBe(true);
  expect(labelKeepsPlaceholders('signInPageTitle', 'Sign in to your bank')).toBe(false);
  expect(labelKeepsPlaceholders('signInPageIntro', 'Your password goes somewhere')).toBe(false);
});

test('the navigation rule, as a table', () => {
  const port = 1234;
  const allowed = (headers: Record<string, string>) => navigationAllowed({ headers: { host: `127.0.0.1:${port}`, ...headers } } as never, port);
  expect(allowed({})).toBe(true);
  expect(allowed({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' })).toBe(true);
  expect(allowed({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' })).toBe(true);
  expect(allowed({ origin: 'null' })).toBe(false);
  expect(allowed({ 'sec-fetch-dest': 'embed' })).toBe(false);
  expect(allowed({ 'sec-fetch-mode': 'cors' })).toBe(false);
  expect(allowed({ host: 'localhost:1234' })).toBe(false);
});
