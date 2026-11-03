/**
 * `/__jmap/<id>/...`: same-origin forwarding to a plain http mail server the
 * user approved, since an https page can't reach it (decision 10). The id is
 * the base64url of the server's origin (lib/desktop/jmap-route.ts in the
 * webmail). Anything not in the approved set gets 403, whatever the id says.
 *
 * Bodies stream both ways: uploads, downloads and the push stream.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PREFIX = '/__jmap/';

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
  'strict-transport-security', 'content-security-policy', 'alt-svc',
]);

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

export async function forwardJmap(
  req: IncomingMessage,
  res: ServerResponse,
  isTrusted: (origin: string) => boolean,
): Promise<void> {
  const route = parseJmapRoute(req.url ?? '');
  if (!route || !isTrusted(route.origin)) {
    res.writeHead(403, { 'content-type': 'text/plain', 'x-content-type-options': 'nosniff' });
    res.end('This server has not been approved.');
    return;
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (DROP_REQUEST.has(name) || name.startsWith('sec-') || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  const abort = new AbortController();
  res.once('close', () => abort.abort());

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  try {
    const upstream = await fetch(route.origin + route.rest, {
      method,
      headers,
      redirect: 'follow',
      signal: abort.signal,
      ...(hasBody ? { body: Readable.toWeb(req) as unknown as BodyInit, duplex: 'half' } : {}),
    } as RequestInit);

    const out: Record<string, string> = { 'x-content-type-options': 'nosniff' };
    upstream.headers.forEach((value, name) => {
      if (!DROP_RESPONSE.has(name)) out[name] = value;
    });
    res.writeHead(upstream.status, upstream.statusText || undefined, out);
    res.flushHeaders();
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as never), res);
    else res.end();
  } catch (error) {
    if (abort.signal.aborted) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'text/plain', 'x-content-type-options': 'nosniff' });
    res.end(`The mail server could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
