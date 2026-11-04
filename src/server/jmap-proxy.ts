/**
 * `/__jmap/<id>/...`: same-origin forwarding to a plain http mail server the
 * user approved, since an https page can't reach it (decision 10). The id is
 * the base64url of the server's origin (lib/desktop/jmap-route.ts in the
 * webmail). Anything not in the approved set gets 403, whatever the id says.
 *
 * These answers come from a server the app doesn't control, on the app's own
 * origin. If one could render as a document it would run with the bridge and no
 * CSP, so one mail link would reach every account. So only the page's own fetches
 * get through (Sec-Fetch), and an answer can't render even if it were loaded.
 *
 * Bodies stream both ways: uploads, downloads and the push stream.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PREFIX = '/__jmap/';
const MAX_REDIRECTS = 5;

/** Never sent upstream: the app's own cookies and browser context stay here. */
const DROP_REQUEST = new Set([
  'host', 'cookie', 'origin', 'referer', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te',
  'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for',
]);

/**
 * The only answer headers that come back, besides the type and length below. These answers
 * land on the app's own origin, where a browser obeys what a header says for that whole
 * origin: Clear-Site-Data alone wipes the cookies, the offline store and the outbox, from one
 * answer of an http server, or of anyone on the way to it. So what's not named stays out.
 * The JMAP client reads Retry-After. A caller can compare the other two itself.
 */
const PASS_RESPONSE = new Set(['etag', 'last-modified', 'retry-after']);

/**
 * Always last, so an answer can't overwrite them. No storing: a stored answer is served to a
 * later `<script src>` without coming past the Sec-Fetch check below.
 */
const SAFE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

/** What goes along when a redirect leaves the origin. None of it says who's asking. */
const CROSS_ORIGIN_REQUEST = new Set(['accept', 'accept-language', 'cache-control', 'if-modified-since', 'if-none-match', 'pragma', 'range', 'user-agent']);

export function isJmapRoute(url: string | undefined): boolean {
  return !!url && url.startsWith(PREFIX);
}

export function parseJmapRoute(url: string): { origin: string; rest: string } | null {
  const after = url.slice(PREFIX.length);
  const slash = after.search(/[/?]/);
  const id = slash === -1 ? after : after.slice(0, slash);
  const rest = slash === -1 ? '/' : after.slice(slash);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const decoded = Buffer.from(id, 'base64url').toString('utf8');
  try {
    const parsed = new URL(decoded);
    if (parsed.origin !== decoded || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
    return { origin: parsed.origin, rest: rest.startsWith('/') ? rest : `/${rest}` };
  } catch {
    return null;
  }
}

/** The page's own fetch or XHR. A navigation, frame, image or worker script isn't. */
export function isPageFetch(req: IncomingMessage): boolean {
  return req.headers['sec-fetch-dest'] === 'empty' && req.headers['sec-fetch-site'] === 'same-origin';
}

/** JSON stays what it is, anything else can't render. The JMAP client reads the type from the part it asked for. */
export function safeContentType(type: string | null): string {
  return type && /^application\/([a-z0-9.+-]*\+)?json\b/i.test(type) ? type : 'application/octet-stream';
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...SAFE_HEADERS });
  res.end(message);
}

/** The only hop to a host outside the approved set: the same host, moving up to TLS. */
function isSameHostUpgrade(from: URL, to: URL): boolean {
  return from.protocol === 'http:' && to.protocol === 'https:' && from.hostname === to.hostname;
}

export async function forwardJmap(
  req: IncomingMessage,
  res: ServerResponse,
  isTrusted: (origin: string) => boolean,
): Promise<void> {
  if (!isPageFetch(req)) {
    refuse(res, 403, 'Not available here.');
    return;
  }
  const route = parseJmapRoute(req.url ?? '');
  if (!route || !isTrusted(route.origin)) {
    refuse(res, 403, 'This server has not been approved.');
    return;
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (DROP_REQUEST.has(name) || name.startsWith('sec-') || name.startsWith(':') || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  const abort = new AbortController();
  res.once('close', () => abort.abort());

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  try {
    let target = new URL(route.origin + route.rest);
    let upstream: Response;
    for (let hop = 0; ; hop += 1) {
      upstream = await fetch(target, {
        method,
        headers,
        redirect: 'manual',
        signal: abort.signal,
        ...(hasBody ? { body: Readable.toWeb(req) as unknown as BodyInit, duplex: 'half' } : {}),
      } as RequestInit);
      const location = upstream.status >= 300 && upstream.status < 400 ? upstream.headers.get('location') : null;
      if (!location) break;
      await upstream.body?.cancel();
      // The body has gone upstream and can't be sent twice.
      if (hasBody) {
        refuse(res, 502, 'The mail server redirected a request with a body. Its address in Bulwark may be out of date.');
        return;
      }
      if (hop >= MAX_REDIRECTS) {
        refuse(res, 502, 'The mail server redirected too many times.');
        return;
      }
      const next = new URL(location, target);
      if (!isTrusted(next.origin) && !isSameHostUpgrade(target, next)) {
        refuse(res, 502, 'The mail server redirected to a server that has not been approved.');
        return;
      }
      // Credentials stay with their origin, and a move to https or another port is another one.
      if (next.origin !== target.origin) {
        for (const name of [...headers.keys()]) {
          if (!CROSS_ORIGIN_REQUEST.has(name)) headers.delete(name);
        }
      }
      target = next;
    }

    const out: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (PASS_RESPONSE.has(name)) out[name] = value;
    });
    // fetch has decoded the body by now, so a compressed answer's length is wrong.
    const length = upstream.headers.get('content-length');
    if (length && !upstream.headers.has('content-encoding')) out['content-length'] = length;
    res.writeHead(upstream.status, { ...out, 'content-type': safeContentType(upstream.headers.get('content-type')), ...SAFE_HEADERS });
    res.flushHeaders();
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as never), res);
    else res.end();
  } catch (error) {
    if (abort.signal.aborted) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    refuse(res, 502, `The mail server could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
