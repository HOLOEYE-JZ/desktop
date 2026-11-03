/**
 * CORS headers for the account's JMAP servers that don't send them.
 *
 * Only for the origins an account uses, by filter, so other traffic never passes
 * through main and plugin fetches to other hosts stay under normal CORS. The
 * allowed origin is the app's own and not `*`, so an opaque plugin frame doesn't
 * gain access. No Allow-Credentials: the client doesn't send cookies across
 * origins.
 */

import type { Session } from 'electron';

const ALLOW_HEADERS = [
  'Authorization', 'Content-Type', 'Accept', 'Accept-Language', 'X-Requested-With', 'If-None-Match', 'If-Modified-Since',
  'Range', 'Last-Event-ID', 'Cache-Control',
].join(', ');
const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD';

function urlPattern(origin: string): string {
  return `${origin}/*`;
}

export class CorsInjector {
  private readonly origins = new Set<string>();

  constructor(
    private readonly session: Session,
    private readonly appOrigin: string,
  ) {}

  /** Replaces the set. A session has one listener per event, so this is the only place that adds it. */
  set(origins: Iterable<string>): void {
    this.origins.clear();
    for (const origin of origins) this.origins.add(origin);
    this.install();
  }

  add(origin: string): boolean {
    if (this.origins.has(origin)) return false;
    this.origins.add(origin);
    this.install();
    return true;
  }

  private install(): void {
    if (this.origins.size === 0) {
      this.session.webRequest.onHeadersReceived(null);
      return;
    }
    const filter = { urls: [...this.origins].map(urlPattern) };
    this.session.webRequest.onHeadersReceived(filter, (details, callback) => {
      const headers: Record<string, string[]> = {};
      for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
        if (!name.toLowerCase().startsWith('access-control-')) headers[name] = value;
      }
      headers['Access-Control-Allow-Origin'] = [this.appOrigin];
      headers['Access-Control-Allow-Headers'] = [ALLOW_HEADERS];
      headers['Access-Control-Allow-Methods'] = [ALLOW_METHODS];
      headers['Access-Control-Expose-Headers'] = ['*'];
      headers['Access-Control-Max-Age'] = ['600'];
      // A server that answers OPTIONS with 401 or 405 would fail the preflight.
      if (details.method === 'OPTIONS') {
        callback({ responseHeaders: headers, statusLine: 'HTTP/1.1 204 No Content' });
        return;
      }
      callback({ responseHeaders: headers });
    });
  }
}
