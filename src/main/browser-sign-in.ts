/**
 * Sign-in through the system browser, the part in main. RFC 8252: a short-lived
 * listener on http://127.0.0.1:<port> takes one redirect and hands the code to the page
 * that started the flow, which holds the PKCE verifier.
 *
 * Both Stalwart lines accept this redirect for a public client and ignore the port when
 * matching. They refuse `http://localhost` and `bulwark://`. That's why the scheme is only
 * a fallback, for a server whose registration refuses loopback and takes the scheme.
 *
 * A server with no OAuth at all gets a small page served from here, so a password manager
 * has an origin to save against: see `beginPassword`.
 *
 * What holds this together:
 * - The listener answers one path, only to a top-level navigation, only under its own
 *   Host. Nothing it sends lets another origin read it. A wrong state changes nothing, so
 *   a page can't end someone's flow by guessing.
 * - `state` comes from here and has to be in what the browser opens. Nothing in the app
 *   starts a flow but the page's own click: the preload hands the calls out once per
 *   document, see src/preload/index.ts.
 * - All of it is memory, and goes with this run of the app.
 *
 * No Electron here, so a plain Node test reaches the real listener.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrowserSignInBegin, BrowserSignInResult, PasswordSignInAnswer, PasswordSignInAttempt, PasswordSignInStart } from '../shared/bridge';

export const CALLBACK_PATH = '/bulwark-desktop/callback';
/** Parsed in deep-link.ts, the one parser for the scheme. */
export const SCHEME_REDIRECT_URI = 'bulwark://sign-in/callback';
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a browser tab waits for the app to try a password. */
const ATTEMPT_TIMEOUT_MS = 60 * 1000;
const MAX_FORM_BYTES = 16 * 1024;
/** Stays clear of the ephemeral range, which outgoing connections borrow from. */
const STABLE_PORT_MIN = 30000;
const STABLE_PORT_RANGE = 10000;
const MAX_REMEMBERED_PORTS = 64;

export interface SignInText {
  signInDone: string;
  /** With `{address}`: the account a password sign-in just signed in. */
  signInDoneAs: string;
  /** The button that brings the app forward (bulwark://inbox). */
  signInOpenApp: string;
  signInFailed: string;
  signInLinkUsed: string;
  signInDeclined: string;
  signInPageTitle: string;
  signInPageIntro: string;
  signInUsername: string;
  signInPassword: string;
  signInCode: string;
  signInSubmit: string;
  signInWrongPassword: string;
  signInCodeNeeded: string;
  signInNoAnswer: string;
}

export interface SignInDeps {
  open: (url: string) => Promise<void>;
  /** Brings the window that started the flow to the front. */
  bringForward: (owner: number) => void;
  text: () => SignInText;
  /** Instance mode: the browser opens this origin and no other. */
  instanceOrigin?: string;
  /** The password page's port per mail server. Kept, so saved passwords keep matching. */
  ports?: Map<string, number>;
  /** Called when `ports` changed. */
  portsChanged?: () => void;
  timeoutMs?: number;
  attemptTimeoutMs?: number;
}

type FlowKind = 'oauth' | 'instance';

interface PendingAttempt {
  response: ServerResponse;
  timer: NodeJS.Timeout;
}

interface PasswordState {
  host: string;
  /** In the first address, good for one page load. */
  token: string;
  tokenUsed: boolean;
  /** In each form shown, good for one post. */
  nonce: string;
  username: string;
  /** Posted, waiting for the page to ask. */
  queued: PasswordSignInAttempt[];
  waiter: ((attempt: PasswordSignInAttempt) => void) | null;
  /** The browser tab's post, held until the app has tried it. */
  inFlight: PendingAttempt | null;
}

interface Flow {
  id: string;
  owner: number;
  kind: FlowKind;
  state: string;
  /** Where the mail server is, in standalone. */
  serverOrigin: string | null;
  server: Server | null;
  port: number;
  redirectUri: string;
  usesScheme: boolean;
  opened: boolean;
  /** The redirect came. A second one gets nothing. */
  answered: boolean;
  settle: (result: BrowserSignInResult) => void;
  result: Promise<BrowserSignInResult>;
  timer: NodeJS.Timeout;
  password: PasswordState | null;
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** A navigation gets an answer. A fetch, an image, a frame or another host doesn't. */
export function navigationAllowed(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  // DNS rebinding: a name an attacker owns, resolving here, arrives with that name.
  if (req.headers.host !== `127.0.0.1:${port}`) return false;
  if (req.headers.origin !== undefined) return false;
  const mode = req.headers['sec-fetch-mode'];
  const dest = req.headers['sec-fetch-dest'];
  if (mode !== undefined && mode !== 'navigate') return false;
  if (dest !== undefined && dest !== 'document') return false;
  return true;
}

function send(res: ServerResponse, status: number, body: string, nonce: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    // Not no-referrer: with that, a browser sends `Origin: null` on the form's own post,
    // and the check below couldn't tell it from a sandboxed frame's.
    'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-resource-policy': 'same-origin',
    connection: 'close',
  });
  res.end(body);
}

/** A response that has already gone, a closed tab's, never says 'close' again. */
function whenClosed(res: ServerResponse, then: () => void): void {
  if (res.destroyed || res.closed) then();
  else res.once('close', then);
}

function refuse(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' }).end();
}

/** The sign-in card's look: the standard theme's colours, light or dark as the browser is. */
const STYLE = ':root{color-scheme:light dark;--bg:#f1f5f9;--card:#fff;--fg:#0f172a;--muted:#59687c;--border:#e2e8f0;--primary:#2563eb;--field:#f8fafc;--error:#b91c1c}@media(prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111827;--fg:#f1f5f9;--muted:#94a3b8;--border:#1f2937;--primary:#3b82f6;--field:#0f172a;--error:#fca5a5}}body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:var(--bg);color:var(--fg)}main{box-sizing:border-box;width:min(26em,92vw);padding:2em 1.75em;background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:0 10px 30px rgba(15,23,42,.08);text-align:center}.logo{width:48px;height:48px;fill:var(--primary);display:block;margin:0 auto .75em}p{margin:.75em 0}h1{font-size:1.2em;margin:.25em 0 .5em}form{text-align:start}label{display:block;margin:.75em 0 .25em;font-size:.875em;font-weight:500}input{box-sizing:border-box;width:100%;padding:.6em .75em;font:inherit;color:inherit;background:var(--field);border:1px solid var(--border);border-radius:10px}input:focus{outline:2px solid var(--primary);outline-offset:1px}button,.button{display:block;box-sizing:border-box;margin-top:1.25em;width:100%;padding:.65em;font:inherit;font-weight:600;color:#fff;background:var(--primary);border:0;border-radius:10px;cursor:pointer;text-decoration:none;text-align:center}.error{color:var(--error)}';

/** Bulwark's mark, inline: the page's policy lets nothing load. */
const LOGO = '<svg class="logo" viewBox="0 0 1000 1000" role="img" aria-label="Bulwark"><path d="M 373.467 557.247 L 55.226 271.52 L 55.226 385.564 C 55.226 398.153 62.453 415.6 71.355 424.501 L 107.525 460.671 C 116.426 469.573 123.653 487.02 123.653 499.609 L 123.653 682.08 C 123.655 718.462 133.336 750.017 152.047 778.668 L 373.467 557.247 Z M 626.533 557.247 L 944.774 271.52 L 944.774 396.969 C 944.774 403.263 941.16 411.987 936.709 416.437 L 884.411 468.736 C 879.96 473.186 876.347 481.91 876.347 488.204 L 876.347 682.08 C 876.345 718.462 866.664 750.017 847.953 778.668 L 626.533 557.247 Z M 500 638.743 L 500 638.743 C 466.206 638.738 448.855 625.316 424.448 603.033 L 197.809 829.672 C 261.382 884.635 364.213 931.859 500 990 Q 500 990 500 990 C 635.787 931.859 738.618 884.635 802.191 829.672 L 575.552 603.033 C 551.145 625.316 533.794 638.738 500 638.743 Z M 483.028 563.647 L 63.713 187.183 C 59.029 182.978 55.226 174.454 55.226 168.159 L 55.226 122.542 C 55.226 116.247 60.206 109.988 66.339 108.573 L 215.181 74.225 C 221.314 72.809 226.293 76.77 226.293 83.065 L 226.293 176.92 L 352.034 147.895 C 358.167 146.479 363.147 140.219 363.147 133.925 L 363.147 51.483 C 363.147 45.189 368.126 38.93 374.259 37.514 L 488.888 11.061 C 495.021 9.646 504.979 9.646 511.112 11.061 L 625.741 37.514 C 631.874 38.93 636.853 45.189 636.853 51.483 L 636.853 133.925 C 636.853 140.219 641.833 146.479 647.966 147.895 L 773.707 176.92 L 773.707 83.065 C 773.707 76.77 778.686 72.809 784.819 74.225 L 933.661 108.573 C 939.794 109.988 944.774 116.247 944.774 122.542 L 944.774 168.159 C 944.774 174.454 940.971 182.978 936.287 187.183 L 516.972 563.647 C 507.605 572.056 492.395 572.056 483.028 563.647 Z"/></svg>';

/** Where "Open Bulwark" goes: the app's own scheme, which brings it forward on the inbox. */
export const OPEN_APP_LINK = 'bulwark://inbox';

function page(title: string, body: string, nonce: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"><style nonce="${nonce}">${STYLE}</style></head><body><main>${LOGO}${body}</main></body></html>`;
}

/** A line of text, and on success the button back to the app (settings-p3-15). */
function sendMessage(res: ServerResponse, status: number, message: string, openApp?: string): void {
  const nonce = randomBytes(16).toString('base64');
  const button = openApp ? `<a class="button" href="${OPEN_APP_LINK}">${escapeHtml(openApp)}</a>` : '';
  send(res, status, page('Bulwark', `<p>${escapeHtml(message)}</p>${button}`, nonce), nonce);
}

function sendForm(res: ServerResponse, status: number, text: SignInText, password: PasswordState, error: string | null, needsCode: boolean): void {
  const nonce = randomBytes(16).toString('base64');
  const title = fill(text.signInPageTitle, { server: password.host });
  const body = [
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(fill(text.signInPageIntro, { server: password.host }))}</p>`,
    error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '',
    '<form method="post" autocomplete="on">',
    `<input type="hidden" name="nonce" value="${escapeHtml(password.nonce)}">`,
    `<label for="username">${escapeHtml(text.signInUsername)}</label>`,
    `<input id="username" name="username" type="text" autocomplete="username" required autofocus value="${escapeHtml(password.username)}">`,
    `<label for="password">${escapeHtml(text.signInPassword)}</label>`,
    '<input id="password" name="password" type="password" autocomplete="current-password" required>',
    needsCode ? `<label for="totp">${escapeHtml(text.signInCode)}</label><input id="totp" name="totp" type="text" inputmode="numeric" maxlength="8" autocomplete="one-time-code" required>` : '',
    `<button type="submit">${escapeHtml(text.signInSubmit)}</button>`,
    '</form>',
  ].join('');
  send(res, status, page(title, body, nonce), nonce);
}

export class LoopbackSignIn {
  private readonly flows = new Map<string, Flow>();

  constructor(private readonly deps: SignInDeps) {}

  /** A window has one flow at a time. A new click replaces what it had waiting. */
  async begin(owner: number, kind: FlowKind, serverOrigin: string | null): Promise<BrowserSignInBegin> {
    this.cancelFor(owner);
    const id = randomToken();
    let settle!: (result: BrowserSignInResult) => void;
    const result = new Promise<BrowserSignInResult>((done) => {
      settle = done;
    });
    const timer = setTimeout(() => this.finish(id, { ok: false, error: 'timeout' }), this.deps.timeoutMs ?? FLOW_TIMEOUT_MS);
    timer.unref?.();
    const flow: Flow = {
      id,
      owner,
      kind,
      state: randomToken(),
      serverOrigin,
      server: null,
      port: 0,
      redirectUri: '',
      usesScheme: false,
      opened: false,
      answered: false,
      settle,
      result,
      timer,
      password: null,
    };
    try {
      const server = createServer((req, res) => this.onCallback(flow, req, res));
      flow.port = await this.listen(server, 0);
      flow.server = server;
    } catch {
      clearTimeout(timer);
      return { ok: false, error: 'no_listener' };
    }
    flow.redirectUri = `http://127.0.0.1:${flow.port}${CALLBACK_PATH}`;
    this.flows.set(id, flow);
    return { ok: true, flowId: id, redirectUri: flow.redirectUri, state: flow.state };
  }

  private listen(server: Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  private onCallback(flow: Flow, req: IncomingMessage, res: ServerResponse): void {
    if (!navigationAllowed(req, flow.port)) return refuse(res, 403);
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${flow.port}`);
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) return refuse(res, 404);
    const text = this.deps.text();
    // Not our redirect, or a second one: nothing moves, nothing is said about why.
    if (flow.answered || !same(url.searchParams.get('state') ?? '', flow.state)) {
      return sendMessage(res, 400, text.signInFailed);
    }
    flow.answered = true;
    const code = url.searchParams.get('code');
    const result: BrowserSignInResult = code
      ? { ok: true, code, state: flow.state, iss: url.searchParams.get('iss') ?? undefined }
      : { ok: false, error: 'denied' };
    // Closed once the browser has its page, not before.
    whenClosed(res, () => this.delivered(flow, result));
    const declined = url.searchParams.get('error') === 'access_denied';
    sendMessage(res, code ? 200 : declined ? 403 : 400, code ? text.signInDone : declined ? text.signInDeclined : text.signInFailed, code ? text.signInOpenApp : undefined);
  }

  private delivered(flow: Flow, result: BrowserSignInResult): void {
    if (!this.flows.has(flow.id)) return;
    this.finish(flow.id, result);
    this.deps.bringForward(flow.owner);
  }

  /**
   * The server's registration refused loopback and took the scheme. The listener goes, and
   * the code now only comes by a `bulwark:` link, which deep-link.ts parses.
   */
  useScheme(flowId: unknown, owner: number): string | null {
    const flow = this.owned(flowId, owner);
    if (!flow || flow.opened || flow.kind !== 'oauth') return null;
    this.closeServer(flow);
    flow.usesScheme = true;
    flow.redirectUri = SCHEME_REDIRECT_URI;
    return flow.redirectUri;
  }

  /** A `bulwark:` link came in. Whoever can send one, it does nothing without this flow's state. */
  deliverLink(code: string, state: string): boolean {
    for (const flow of this.flows.values()) {
      if (!flow.usesScheme || !flow.opened || flow.answered || !same(state, flow.state)) continue;
      flow.answered = true;
      this.delivered(flow, { ok: true, code, state: flow.state });
      return true;
    }
    return false;
  }

  /** Opens the system browser and waits for the redirect. */
  async complete(flowId: unknown, target: unknown, owner: number): Promise<BrowserSignInResult> {
    const flow = this.owned(flowId, owner);
    if (!flow || flow.opened || flow.password) return { ok: false, error: 'unknown_flow' };
    const url = this.checkedTarget(flow, target);
    if (!url) {
      this.finish(flow.id, { ok: false, error: 'invalid_url' });
      return { ok: false, error: 'invalid_url' };
    }
    flow.opened = true;
    try {
      await this.deps.open(url);
    } catch {
      this.finish(flow.id, { ok: false, error: 'no_browser' });
    }
    return flow.result;
  }

  private checkedTarget(flow: Flow, target: unknown): string | null {
    let url: URL;
    try {
      url = new URL(String(target));
    } catch {
      return null;
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    const { searchParams: q } = url;
    if (flow.kind === 'instance') {
      // Saved passwords and the instance's own rules are at its real address.
      if (!this.deps.instanceOrigin || url.origin !== this.deps.instanceOrigin) return null;
      if (q.get('mobile_redirect_uri') !== flow.redirectUri || q.get('mobile_state') !== flow.state || !q.get('mobile_code_challenge')) return null;
      return url.toString();
    }
    // A password typed on plain http only where the server itself is plain http, a LAN
    // server the user allowed in a native prompt.
    if (url.protocol === 'http:' && !flow.serverOrigin?.startsWith('http:')) return null;
    if (q.get('redirect_uri') !== flow.redirectUri || q.get('state') !== flow.state) return null;
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return null;
    return url.toString();
  }

  /**
   * For a server with no OAuth: a form main serves, so that a password manager has an
   * origin to save against. The port stays the same per server, per install, so what was
   * saved for one server isn't offered for another and keeps matching next time. What the
   * form posts goes to the page, down the app's normal login path, and is held nowhere.
   */
  async beginPassword(flowId: unknown, owner: number): Promise<PasswordSignInStart> {
    const flow = this.owned(flowId, owner);
    if (!flow || flow.opened || flow.kind !== 'oauth' || !flow.serverOrigin) return { ok: false, error: 'unknown_flow' };
    this.closeServer(flow);
    const password: PasswordState = {
      host: new URL(flow.serverOrigin).host,
      token: randomToken(),
      tokenUsed: false,
      nonce: randomToken(),
      username: '',
      queued: [],
      waiter: null,
      inFlight: null,
    };
    flow.password = password;
    const server = createServer((req, res) => this.onPasswordRequest(flow, password, req, res));
    try {
      flow.port = await this.listenOnStablePort(server, flow.serverOrigin);
      flow.server = server;
    } catch {
      this.finish(flow.id, { ok: false, error: 'no_listener' });
      return { ok: false, error: 'no_listener' };
    }
    flow.opened = true;
    try {
      await this.deps.open(`http://127.0.0.1:${flow.port}/sign-in/${password.token}`);
    } catch {
      this.finish(flow.id, { ok: false, error: 'no_browser' });
      return { ok: false, error: 'no_browser' };
    }
    return { ok: true, host: password.host };
  }

  private async listenOnStablePort(server: Server, serverOrigin: string): Promise<number> {
    const ports = this.deps.ports;
    const known = ports?.get(serverOrigin);
    if (known) {
      try {
        return await this.listen(server, known);
      } catch {
        // Someone holds it. The user gets a new origin with nothing saved on it, which is
        // only less handy. Whoever holds the old one is never sent anyone.
      }
    }
    for (let tries = 0; tries < 20; tries += 1) {
      const port = STABLE_PORT_MIN + (randomBytes(2).readUInt16BE() % STABLE_PORT_RANGE);
      try {
        const bound = await this.listen(server, port);
        ports?.set(serverOrigin, bound);
        while (ports && ports.size > MAX_REMEMBERED_PORTS) ports.delete(ports.keys().next().value as string);
        this.deps.portsChanged?.();
        return bound;
      } catch {
        // The next one.
      }
    }
    throw new Error('no port');
  }

  private onPasswordRequest(flow: Flow, password: PasswordState, req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0];
    const token = path.startsWith('/sign-in/') ? path.slice('/sign-in/'.length) : '';
    if (req.method === 'GET') {
      if (!navigationAllowed(req, flow.port)) return refuse(res, 403);
      if (!token) return refuse(res, 404);
      if (password.tokenUsed || !same(token, password.token)) return sendMessage(res, 410, this.deps.text().signInLinkUsed);
      password.tokenUsed = true;
      return sendForm(res, 200, this.deps.text(), password, null, false);
    }
    if (req.method === 'POST') return this.onPasswordPost(flow, password, token, req, res);
    refuse(res, 405);
  }

  private onPasswordPost(flow: Flow, password: PasswordState, token: string, req: IncomingMessage, res: ServerResponse): void {
    const site = req.headers['sec-fetch-site'];
    if (
      req.headers.host !== `127.0.0.1:${flow.port}`
      || req.headers.origin !== `http://127.0.0.1:${flow.port}`
      || (site !== undefined && site !== 'same-origin')
      || !password.tokenUsed
      || !same(token, password.token)
      || !String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')
    ) {
      return refuse(res, 403);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const username = form.get('username') ?? '';
      const secret = form.get('password') ?? '';
      if (password.inFlight || !same(form.get('nonce') ?? '', password.nonce) || !username || !secret) return refuse(res, 403);
      // One post per form shown.
      password.nonce = randomToken();
      password.username = username;
      const timer = setTimeout(() => this.answerPassword(flow.id, flow.owner, { ok: false, error: 'other' }), this.deps.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS);
      timer.unref?.();
      password.inFlight = { response: res, timer };
      const totp = form.get('totp')?.trim();
      const attempt: PasswordSignInAttempt = { ok: true, username, password: secret, ...(totp ? { totp } : {}) };
      if (password.waiter) {
        const waiter = password.waiter;
        password.waiter = null;
        waiter(attempt);
      } else {
        password.queued.push(attempt);
      }
    });
  }

  /** Waits for the form's next post. */
  nextPassword(flowId: unknown, owner: number): Promise<PasswordSignInAttempt> {
    const flow = this.owned(flowId, owner);
    const password = flow?.password;
    if (!password) return Promise.resolve({ ok: false, error: 'unknown_flow' });
    const queued = password.queued.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      password.waiter = resolve;
    });
  }

  /** What the app's login said about the last post. The tab shows it. */
  answerPassword(flowId: unknown, owner: number, answer: PasswordSignInAnswer): void {
    const flow = this.owned(flowId, owner);
    const password = flow?.password;
    const pending = password?.inFlight;
    if (!flow || !password || !pending) return;
    clearTimeout(pending.timer);
    password.inFlight = null;
    const text = this.deps.text();
    if (answer.ok) {
      flow.answered = true;
      whenClosed(pending.response, () => this.delivered(flow, { ok: true, code: '', state: flow.state }));
      return sendMessage(pending.response, 200, fill(text.signInDoneAs, { address: password.username }), text.signInOpenApp);
    }
    const message = answer.error === 'invalid_credentials' ? text.signInWrongPassword : answer.error === 'totp_required' ? text.signInCodeNeeded : text.signInNoAnswer;
    sendForm(pending.response, answer.error === 'other' ? 502 : 401, text, password, message, answer.error === 'totp_required');
  }

  /** How the flow ended. */
  outcome(flowId: unknown, owner: number): Promise<BrowserSignInResult> {
    const flow = this.owned(flowId, owner);
    return flow ? flow.result : Promise.resolve({ ok: false, error: 'unknown_flow' });
  }

  cancel(flowId: unknown, owner: number): void {
    const flow = this.owned(flowId, owner);
    if (flow) this.finish(flow.id, { ok: false, error: 'cancelled' });
  }

  /** The window went, or its document did: the verifier went with it. */
  cancelFor(owner: number): void {
    for (const flow of [...this.flows.values()]) {
      if (flow.owner === owner) this.finish(flow.id, { ok: false, error: 'cancelled' });
    }
  }

  closeAll(): void {
    for (const id of [...this.flows.keys()]) this.finish(id, { ok: false, error: 'cancelled' });
  }

  private owned(flowId: unknown, owner: number): Flow | undefined {
    if (typeof flowId !== 'string') return undefined;
    const flow = this.flows.get(flowId);
    return flow?.owner === owner ? flow : undefined;
  }

  private closeServer(flow: Flow): void {
    if (!flow.server) return;
    flow.server.close();
    flow.server.closeAllConnections();
    flow.server = null;
  }

  private finish(flowId: string, result: BrowserSignInResult): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;
    this.flows.delete(flowId);
    clearTimeout(flow.timer);
    const password = flow.password;
    const pending = password?.inFlight;
    if (password) {
      password.inFlight = null;
      password.queued.length = 0;
      password.waiter?.({ ok: false, error: result.ok ? 'done' : result.error });
      password.waiter = null;
    }
    if (pending) {
      // A tab still waiting on a post gets its answer before the listener goes.
      clearTimeout(pending.timer);
      whenClosed(pending.response, () => this.closeServer(flow));
      sendMessage(pending.response, 410, this.deps.text().signInFailed);
    } else {
      this.closeServer(flow);
    }
    flow.settle(result);
  }
}
