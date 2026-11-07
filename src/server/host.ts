/**
 * The embedded webmail server. Runs in a utilityProcess, with cwd on the
 * unpacked server directory, and everything it needs arrives from main by
 * message: the TLS key, the launch secret, the session secret, the local admin password and the list of
 * approved servers. So none of them is in an argument or the environment block.
 *
 * It answers only requests that carry the launch secret, which main adds to the
 * app session's requests. Nothing outside that session can have it, so another
 * process or a web page reaching the port gets 403. See decision 13.
 */

import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import path from 'node:path';
import tls from 'node:tls';
import { HeldRequests } from './held-requests';
import { forwardJmap, isJmapRoute } from './jmap-proxy';
import { APP_HOST, LAUNCH_HEADER, MAIN_HEADER, normalizeStack, type HostMessage, type InitMessage, type MainErrorMessage, type PrivacyMessage } from './protocol';
import { isAdminLogin, isImageOptimizer, sanitizeRequest } from './sanitize';

const TRUST_KEY = Symbol.for('bulwark.desktop.trustedJmapOrigins');
const POLICY_KEY = Symbol.for('bulwark.desktop.serverPolicy');

type Holder = Record<symbol, ReadonlySet<string> | undefined>;

/** Read by the webmail (lib/desktop/trusted-servers.ts) and by jmap-proxy.ts. */
function setTrusted(origins: string[]): void {
  (globalThis as unknown as Holder)[TRUST_KEY] = new Set(origins);
}

/** Read by the webmail (lib/desktop/server-secrets.ts). Not process.env: that's the block a child process inherits. */
function setSecrets(secrets: InitMessage['secrets']): void {
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('bulwark.desktop.serverSecrets')] = secrets;
}

/** Read by the webmail: lib/desktop/server-policy.ts. */
function setPolicy(policy: InitMessage['policy']): void {
  (globalThis as unknown as Record<symbol, unknown>)[POLICY_KEY] = policy;
}

function isTrusted(origin: string): boolean {
  return (globalThis as unknown as Holder)[TRUST_KEY]?.has(origin) === true;
}

/** Read by the webmail (lib/desktop/server-privacy.ts). Its own links tell it of a change. */
function setPrivacy(privacy: PrivacyMessage['privacy']): void {
  const holder = globalThis as unknown as Record<symbol, unknown>;
  holder[Symbol.for('bulwark.desktop.privacy')] = privacy;
  (holder[Symbol.for('bulwark.desktop.privacyChanged')] as (() => void) | undefined)?.();
}

/** Waits on globalThis until the webmail's links (lib/desktop/server-links.ts) take it. */
function queueMainError(error: Pick<MainErrorMessage, 'name' | 'message' | 'stack' | 'mechanism'>): void {
  const holder = globalThis as unknown as Record<symbol, unknown>;
  const key = Symbol.for('bulwark.desktop.mainErrors');
  const queue = (holder[key] ??= []) as unknown[];
  if (queue.length < 50) queue.push(error);
  (holder[Symbol.for('bulwark.desktop.mainErrorsReady')] as (() => void) | undefined)?.();
}

function hostError(error: unknown, mechanism: MainErrorMessage['mechanism']): void {
  const e = (error && typeof error === 'object' ? error : { message: String(error) }) as { name?: unknown; message?: unknown; stack?: unknown };
  queueMainError({ name: e.name, message: e.message, stack: typeof e.stack === 'string' ? normalizeStack(e.stack, __dirname) : undefined, mechanism });
}

function send(message: unknown): void {
  process.parentPort.postMessage(message);
}

/**
 * Chromium trusts the OS store and Node doesn't, so a private CA would let the
 * page connect while /api/auth/* fails. The nodeOptions fuse rules out
 * NODE_OPTIONS=--use-system-ca, so this does the same from inside.
 */
function useSystemCertificates(): { added: number; error?: string } {
  try {
    const bundled = tls.getCACertificates('default');
    const system = tls.getCACertificates('system');
    tls.setDefaultCACertificates([...new Set([...bundled, ...system])]);
    return { added: system.length };
  } catch (error) {
    return { added: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

function launchSecretMatches(given: string | string[] | undefined, secret: Buffer): boolean {
  if (typeof given !== 'string') return false;
  const value = Buffer.from(given);
  return value.length === secret.length && timingSafeEqual(value, secret);
}

/**
 * Chromium doesn't end a utilityProcess when main is killed or crashes, and this
 * one holds a listening port and the user's data open. So it watches for itself.
 */
function exitWithParent(pid: number): void {
  const timer = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch {
      process.exit(0);
    }
  }, 1000);
  timer.unref();
}

async function start(init: InitMessage): Promise<void> {
  exitWithParent(init.parentPid);
  const { serverDir } = init;
  // Next and the webmail read their files relative to the working directory, and an asar
  // can't be one (chdir goes to the OS). Electron's fs layer serves paths inside it.
  process.cwd = () => serverDir;
  setSecrets(init.secrets);
  process.env.NODE_ENV = 'production';

  const ca = useSystemCertificates();
  setTrusted(init.trustedOrigins);
  setPrivacy(init.privacy);
  setPolicy(init.policy);

  const { config } = JSON.parse(readFileSync(path.join(serverDir, '.next', 'required-server-files.json'), 'utf8'));
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);

  const pages = new HeldRequests();
  const secret = Buffer.from(init.launchSecret);
  const mainSecret = Buffer.from(init.mainSecret);
  const server = createServer({ key: init.tls.key, cert: init.tls.cert }, (req: IncomingMessage, res: ServerResponse) => {
    if (!launchSecretMatches(req.headers[LAUNCH_HEADER], secret)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    // Page script could use up the login budget and lock main out of the admin API.
    if (isAdminLogin(req.method, req.url) && !launchSecretMatches(req.headers[MAIN_HEADER], mainSecret)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    sanitizeRequest(req);
    if (isImageOptimizer(req.url)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    if (isJmapRoute(req.url)) {
      void forwardJmap(req, res, isTrusted);
      return;
    }
    pages.handle(req, res);
  });

  // The same as the generated server.js.
  server.keepAliveTimeout = 65_000;
  const listening = new Promise<boolean>((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      send({ type: 'fatal', code: error.code, error: error.message });
      resolve(false);
    });
    server.listen(init.port, '127.0.0.1', () => resolve(true));
  });
  if (!(await listening)) return;
  send({ type: 'listening' });

  try {
    const requireFromServer = createRequire(path.join(serverDir, 'server.js'));
    const next = requireFromServer('next');
    const app = next({ dev: false, dir: serverDir, hostname: APP_HOST, port: 443, quiet: true, conf: config });
    await app.prepare();
    pages.open(app.getRequestHandler());
  } catch (error) {
    pages.fail();
    throw error;
  }
  send({ type: 'ready', systemCertificates: ca.added, caError: ca.error });
}

process.on('uncaughtException', (error) => {
  send({ type: 'log', level: 'error', message: String(error?.stack ?? error) });
  hostError(error, 'uncaughtexception');
});
process.on('unhandledRejection', (error) => {
  send({ type: 'log', level: 'error', message: String(error instanceof Error ? error.stack : error) });
  hostError(error, 'unhandledrejection');
});

process.parentPort.on('message', (event: { data: HostMessage }) => {
  const message = event.data;
  if (message.type === 'init') {
    start(message).catch((error) => send({ type: 'fatal', error: String(error?.stack ?? error) }));
  } else if (message.type === 'trusted') {
    setTrusted(message.origins);
  } else if (message.type === 'privacy') {
    setPrivacy(message.privacy);
  } else if (message.type === 'main-error') {
    queueMainError(message);
  } else if (message.type === 'policy') {
    setPolicy(message.policy);
  }
});
