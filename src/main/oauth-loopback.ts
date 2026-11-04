/**
 * Sign-in through the system browser. A short-lived listener on
 * http://127.0.0.1:<port> takes one redirect and hands the code back to the
 * renderer that started it, which holds the PKCE verifier. Stalwart accepts this
 * redirect for an anonymous public client (and ignores the port when matching);
 * it refuses `bulwark://`, `http://localhost` and the app's own origin.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { shell } from 'electron';
import type { BrowserSignInResult } from '../shared/bridge';
import { strings } from './strings';

export const CALLBACK_PATH = '/bulwark-desktop/callback';
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

interface Flow {
  server: Server;
  redirectUri: string;
  expectedState: string | null;
  owner: number;
  /** A real click on the page, seen as the flow began. */
  clicked: boolean;
  settle: (result: BrowserSignInResult) => void;
  result: Promise<BrowserSignInResult>;
  timer: NodeJS.Timeout;
}

function page(message: string): string {
  const safe = message.replace(/[<>&]/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bulwark</title><meta name="viewport" content="width=device-width"><style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0}@media(prefers-color-scheme:dark){body{background:#17181b;color:#f4f4f5}}p{max-width:30em;padding:1em;text-align:center}</style></head><body><p>${safe}</p></body></html>`;
}

export class LoopbackSignIn {
  private readonly flows = new Map<string, Flow>();

  /** `askHost` is the native question for a flow that no click started. */
  constructor(private readonly onDone?: () => void, private readonly askHost?: (host: string, owner: number) => Promise<boolean>) {}

  begin(owner: number, clicked = false): Promise<{ flowId: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      const flowId = randomUUID();
      let settle!: (result: BrowserSignInResult) => void;
      const result = new Promise<BrowserSignInResult>((done) => {
        settle = done;
      });
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end();
          return;
        }
        const flow = this.flows.get(flowId);
        const state = url.searchParams.get('state');
        // Not our redirect: the state goes with the authorize URL that we opened.
        if (!flow || !flow.expectedState || state !== flow.expectedState) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page(strings().signInFailed));
          return;
        }
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          .end(page(code ? strings().signInDone : strings().signInFailed));
        this.finish(flowId, code ? { ok: true, code, state } : { ok: false, error: error ?? 'no_code' });
        this.onDone?.();
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
        const timer = setTimeout(() => this.finish(flowId, { ok: false, error: 'timeout' }), FLOW_TIMEOUT_MS);
        timer.unref?.();
        this.flows.set(flowId, { server, redirectUri, expectedState: null, owner, clicked: clicked === true, settle, result, timer });
        resolve({ flowId, redirectUri });
      });
    });
  }

  /** Opens the system browser. Only the renderer that began a flow can drive it. */
  async complete(flowId: unknown, authorizeUrl: unknown, owner: number): Promise<BrowserSignInResult> {
    const flow = typeof flowId === 'string' ? this.flows.get(flowId) : undefined;
    if (!flow || flow.owner !== owner) return { ok: false, error: 'unknown_flow' };
    let target: URL;
    try {
      target = new URL(String(authorizeUrl));
    } catch {
      this.finish(flowId as string, { ok: false, error: 'invalid_url' });
      return { ok: false, error: 'invalid_url' };
    }
    const http = target.protocol === 'http:';
    if ((!http && target.protocol !== 'https:') || target.username || target.password) {
      this.finish(flowId as string, { ok: false, error: 'invalid_url' });
      return { ok: false, error: 'invalid_url' };
    }
    if (target.searchParams.get('redirect_uri') !== flow.redirectUri) {
      this.finish(flowId as string, { ok: false, error: 'invalid_url' });
      return { ok: false, error: 'invalid_url' };
    }
    // A same-origin plugin frame can make these calls too, and the code would go to it. A click
    // says the user meant to sign in. With none, the user has to say so, knowing where to.
    if (!flow.clicked && !(await this.askHost?.(target.host, owner))) {
      this.finish(flowId as string, { ok: false, error: 'cancelled' });
      return { ok: false, error: 'cancelled' };
    }
    if (this.flows.get(flowId as string) !== flow) return flow.result;
    flow.expectedState = target.searchParams.get('state');
    try {
      await shell.openExternal(target.toString());
    } catch {
      this.finish(flowId as string, { ok: false, error: 'no_browser' });
    }
    return flow.result;
  }

  cancel(flowId: unknown, owner: number): void {
    if (typeof flowId !== 'string') return;
    const flow = this.flows.get(flowId);
    if (flow && flow.owner === owner) this.finish(flowId, { ok: false, error: 'cancelled' });
  }

  private finish(flowId: string, result: BrowserSignInResult): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;
    this.flows.delete(flowId);
    clearTimeout(flow.timer);
    flow.server.close();
    flow.server.closeAllConnections();
    flow.settle(result);
  }

  closeAll(): void {
    for (const id of [...this.flows.keys()]) this.finish(id, { ok: false, error: 'cancelled' });
  }
}
