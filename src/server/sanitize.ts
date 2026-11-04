/**
 * What the embedded server does to each request before Next sees it. Nothing
 * sits in front of it, so page script could otherwise set x-forwarded-* and
 * x-middleware-subrequest itself and choose its own rate-limit key or skip
 * proxy.ts.
 */

import type { IncomingMessage } from 'node:http';
import { APP_HOST, LAUNCH_HEADER, MAIN_HEADER } from './protocol';

/** Removes a header from both views Node keeps of a request. */
function dropHeader(req: IncomingMessage, name: string): void {
  delete req.headers[name];
  const raw = req.rawHeaders;
  for (let i = raw.length - 2; i >= 0; i -= 2) {
    if (raw[i].toLowerCase() === name) raw.splice(i, 2);
  }
}

function setHeader(req: IncomingMessage, name: string, value: string): void {
  dropHeader(req, name);
  req.headers[name] = value;
  req.rawHeaders.push(name, value);
}

/**
 * The route a request's target ends up on, lowercased. Next resolves dot segments and takes
 * absolute targets, so comparing the text as it came in misses `/api/admin/./auth`.
 */
function routedPath(url: string): string {
  let pathname = url.split(/[?#]/)[0].replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Not decodable, compared as it is.
  }
  // Slashes first: `//api/x` would read as a host called api.
  pathname = pathname.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  try {
    pathname = new URL(pathname, 'https://app.invalid').pathname;
  } catch {
    // Not a path a URL can hold, compared as it is.
  }
  return pathname.toLowerCase().replace(/\/$/, '');
}

/**
 * Next's image optimizer caches under .next/cache, in the install folder, which a
 * per-machine install can't write to. Nothing in the webmail uses it (no next/image).
 */
export function isImageOptimizer(url: string | undefined): boolean {
  return !!url && routedPath(url) === '/_next/image';
}

/** POST /api/admin/auth, however it's spelled. Reading its status stays open. */
export function isAdminLogin(method: string | undefined, url: string | undefined): boolean {
  if (!url || method === 'GET' || method === 'HEAD') return false;
  return routedPath(url) === '/api/admin/auth';
}

export function sanitizeRequest(req: IncomingMessage): void {
  dropHeader(req, LAUNCH_HEADER);
  dropHeader(req, MAIN_HEADER);
  for (const name of Object.keys(req.headers)) {
    if (name.startsWith('x-middleware-') || name.startsWith('x-forwarded-') || name.startsWith('x-nextjs-')) dropHeader(req, name);
  }
  dropHeader(req, 'x-real-ip');
  dropHeader(req, 'forwarded');
  setHeader(req, 'host', APP_HOST);
  setHeader(req, 'x-forwarded-host', APP_HOST);
  setHeader(req, 'x-forwarded-proto', 'https');
  setHeader(req, 'x-forwarded-for', '127.0.0.1');
}
