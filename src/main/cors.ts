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

  add(origin: string): void {
    if (this.origins.has(origin)) return;
    this.origins.add(origin);
    this.install();
  }

  remove(origin: string): void {
    if (this.origins.delete(origin)) this.install();
  }

  /** One pattern Electron refuses must not take the others down, or the app with it. */
  private validPatterns(): string[] {
    const valid: string[] = [];
    for (const origin of [...this.origins]) {
      const pattern = urlPattern(origin);
      try {
        this.session.webRequest.onHeadersReceived({ urls: [pattern] }, null as never);
        valid.push(pattern);
      } catch {
        this.origins.delete(origin);
      }
    }
    return valid;
  }

  private install(): void {
    const urls = this.validPatterns();
    if (urls.length === 0) {
      this.session.webRequest.onHeadersReceived(null);
      return;
    }
    this.session.webRequest.onHeadersReceived({ urls }, (details, callback) => {
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
