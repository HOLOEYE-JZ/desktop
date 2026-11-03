/**
 * The local admin session for the embedded server. Marketplace installs in
 * standalone mode go through the admin API, so its signature and hash checks
 * stay as they are. The session cookie lives here in main and never reaches the
 * renderer's cookie jar: the privileged plugin frame is same-origin and would
 * otherwise have the whole admin API. The credential is generated once and kept
 * with safeStorage. Its only user is this file.
 */

import { Agent, request } from 'node:https';
import { APP_HOST, LAUNCH_HEADER, MAIN_HEADER } from '../server/protocol';

/** Shorter than the 1 h session, so a request doesn't race the expiry. */
const SESSION_LIFETIME_MS = 55 * 60 * 1000;

export interface LocalAdminOptions {
  port: number;
  certPem: string;
  launchSecret: string;
  mainSecret: string;
  password: string;
}

export interface AdminResponse {
  status: number;
  body: unknown;
}

function cookiesFrom(setCookie: string[] | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  for (const line of setCookie ?? []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return jar;
}

export class LocalAdmin {
  private readonly agent: Agent;
  private cookies = new Map<string, string>();
  private expiresAt = 0;
  private signingIn: Promise<void> | null = null;

  constructor(private readonly options: LocalAdminOptions) {
    // The certificate is its own trust anchor here: only this one is accepted.
    this.agent = new Agent({ ca: options.certPem, servername: APP_HOST, keepAlive: false });
  }

  private send(method: string, path: string, payload: unknown): Promise<AdminResponse & { setCookie: string[] }> {
    const { port, launchSecret, mainSecret } = this.options;
    return new Promise((resolve, reject) => {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          agent: this.agent,
          servername: APP_HOST,
          headers: {
            host: APP_HOST,
            [LAUNCH_HEADER]: launchSecret,
            [MAIN_HEADER]: mainSecret,
            ...(cookie ? { cookie } : {}),
            ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              // Leave it as text.
            }
            resolve({ status: res.statusCode ?? 0, body: parsed, setCookie: res.headers['set-cookie'] ?? [] });
          });
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  private async signIn(): Promise<void> {
    this.signingIn ??= (async () => {
      const answer = await this.send('POST', '/api/admin/auth', { password: this.options.password });
      if (answer.status !== 200) throw new Error(`Local admin sign-in failed: ${answer.status}`);
      for (const [name, value] of cookiesFrom(answer.setCookie)) this.cookies.set(name, value);
      this.expiresAt = Date.now() + SESSION_LIFETIME_MS;
    })().finally(() => {
      this.signingIn = null;
    });
    return this.signingIn;
  }

  /** An admin API call. Signs in when needed, and once more on a 401 (the server restarted, say). */
  async call(method: string, path: string, payload?: unknown): Promise<AdminResponse> {
    if (Date.now() >= this.expiresAt) await this.signIn();
    const first = await this.send(method, path, payload);
    if (first.status !== 401) return { status: first.status, body: first.body };
    await this.signIn();
    const second = await this.send(method, path, payload);
    return { status: second.status, body: second.body };
  }
}
