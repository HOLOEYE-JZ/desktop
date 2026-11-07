/** Page requests that came before Next loaded (host.ts). No Electron: unit-tested in plain Node. */

import type { IncomingMessage, ServerResponse } from 'node:http';

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

/**
 * The port listens before Next has loaded, so main can open the window while Next starts: a
 * page request that comes early waits here until Next can answer it. Everything that refuses
 * a request (launch secret, admin login, image optimizer) is checked before it waits.
 */
export class HeldRequests {
  private handler: Handler | null = null;
  private failed = false;
  private held: Array<[IncomingMessage, ServerResponse]> = [];

  handle(req: IncomingMessage, res: ServerResponse): void {
    if (this.handler) void this.handler(req, res);
    else if (this.failed) unavailable(res);
    else this.held.push([req, res]);
  }

  /** Next is there: what waited goes to it, in order. */
  open(handler: Handler): void {
    this.handler = handler;
    const held = this.held;
    this.held = [];
    for (const [req, res] of held) void handler(req, res);
  }

  /** Next didn't load: main shows its error page, and nothing waits for an answer meanwhile. */
  fail(): void {
    this.failed = true;
    const held = this.held;
    this.held = [];
    for (const [, res] of held) unavailable(res);
  }

  get waiting(): number {
    return this.held.length;
  }
}

function unavailable(res: ServerResponse): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(503, { 'content-type': 'text/plain' });
  res.end('Not available');
}
