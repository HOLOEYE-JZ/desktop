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
 * Never passed back. fetch decodes bodies, so the encoding and length would be
 * wrong. WWW-Authenticate would make Chromium prompt for a password on what is
 * now a same-origin response, and Set-Cookie would land in the app's jar.
 */
const DROP_RESPONSE = new Set([
  'set-cookie', 'www-authenticate', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'strict-transport-security', 'content-security-policy', 'content-security-policy-report-only', 'alt-svc', 'refresh', 'link',
  'content-disposition', 'content-type', 'location',
]);

const SAFE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'",
  'cross-origin-resource-policy': 'same-origin',
};

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
      // Credentials stay with their host, as fetch itself would do it.
      if (next.hostname !== target.hostname) headers.delete('authorization');
      target = next;
    }

    const out: Record<string, string> = { ...SAFE_HEADERS, 'content-type': safeContentType(upstream.headers.get('content-type')) };
    upstream.headers.forEach((value, name) => {
      if (!DROP_RESPONSE.has(name) && !name.startsWith('access-control-')) out[name] = value;
    });
    res.writeHead(upstream.status, out);
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
