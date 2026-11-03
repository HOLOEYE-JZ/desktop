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
 * Next's image optimizer caches under .next/cache, in the install folder, which a
 * per-machine install can't write to. Nothing in the webmail uses it (no next/image).
 */
export function isImageOptimizer(url: string | undefined): boolean {
  if (!url) return false;
  let pathname = url.split(/[?#]/)[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Not decodable, compared as it is.
  }
  return pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase() === '/_next/image';
}

/** POST /api/admin/auth, however it's spelled. Reading its status stays open. */
export function isAdminLogin(method: string | undefined, url: string | undefined): boolean {
  if (!url || method === 'GET' || method === 'HEAD') return false;
  let pathname = url.split(/[?#]/)[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Not decodable, compared as it is.
  }
  return pathname.toLowerCase().replace(/\/+/g, '/').replace(/\/$/, '') === '/api/admin/auth';
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
