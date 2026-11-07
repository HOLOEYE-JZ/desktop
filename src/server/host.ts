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
import { useCodeCache } from './code-cache';
import { HeldRequests } from './held-requests';
import { PARENT_PID_SWITCH, ParentWatch, SERVER_ROOT_SWITCH, switchValue } from './parent-watch';
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

// Main's end ends this process (src/server/parent-watch.ts).
const parentWatch = new ParentWatch();


interface LoadedNext {
  serverDir: string;
  config: Record<string, unknown>;
  next: (options: Record<string, unknown>) => { prepare: () => Promise<void>; getRequestHandler: () => (req: IncomingMessage, res: ServerResponse) => unknown };
  codeCache: ReturnType<typeof useCodeCache>;
}

let loaded: LoadedNext | null = null;

/**
 * Next's code, loaded once. Nothing secret is needed for it, so it starts as soon as this
 * process does, while main is still on its way to the init message.
 */
function loadNext(serverDir: string): LoadedNext {
  if (loaded?.serverDir === serverDir) return loaded;
  // Next and the webmail read their files relative to the working directory, and an asar
  // can't be one (chdir goes to the OS). Electron's fs layer serves paths inside it.
  process.cwd = () => serverDir;
  process.env.NODE_ENV = 'production';
  const { config } = JSON.parse(readFileSync(path.join(serverDir, '.next', 'required-server-files.json'), 'utf8'));
  // One user, one window: Next's default of loading every route at start (admin, setup, every
  // API route) costs the first page ~0.4 s of server time and keeps routes nobody opens in
  // memory. Each route loads when it's first asked for instead, from the code cache.
  config.experimental = { ...config.experimental, preloadEntriesOnStart: false };
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
  // Before the first server file loads: Next and the webmail compile from the package's cache.
  const codeCache = useCodeCache(serverDir);
  const next = createRequire(path.join(serverDir, 'server.js'))('next');
  loaded = { serverDir, config, next, codeCache };
  return loaded;
}

async function start(init: InitMessage): Promise<void> {
  parentWatch.watchPid(init.parentPid);
  if (init.lifeline) parentWatch.useLifeline(init.lifeline);
  const { serverDir } = init;
  process.cwd = () => serverDir;
  setSecrets(init.secrets);
  process.env.NODE_ENV = 'production';

  setTrusted(init.trustedOrigins);
  setPrivacy(init.privacy);
  setPolicy(init.policy);

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
  // After the port, before anything can go out: reading the OS store takes tens of ms, and main
  // opens the window on `listening`. Synchronous, so no request is handled before it's done.
  const ca = useSystemCertificates();

  let codeCache: LoadedNext['codeCache'] = null;
  try {
    const { config, next, codeCache: cache } = loadNext(serverDir);
    codeCache = cache;
    const app = next({ dev: false, dir: serverDir, hostname: APP_HOST, port: 443, quiet: true, conf: config });
    await app.prepare();
    pages.open(app.getRequestHandler());
  } catch (error) {
    pages.fail();
    throw error;
  }
  send({ type: 'ready', systemCertificates: ca.added, caError: ca.error });
  const report = (when: string) => {
    if (codeCache) send({ type: 'log', level: 'info', message: `code cache ${when}: ${codeCache.stats.used} used, ${codeCache.stats.rejected} rejected, ${codeCache.stats.compiled} compiled` });
  };
  report('at ready');
  setTimeout(() => report('a minute later'), 60_000).unref();
}

process.on('uncaughtException', (error) => {
  send({ type: 'log', level: 'error', message: String(error?.stack ?? error) });
  hostError(error, 'uncaughtexception');
});
process.on('unhandledRejection', (error) => {
  send({ type: 'log', level: 'error', message: String(error instanceof Error ? error.stack : error) });
  hostError(error, 'unhandledrejection');
});

// Main names the server's folder on the command line, so Next loads before the init message is
// here. A failure here is left for start(), which loads again and reports it as before.
// Watched from the start: main can end (a crash during a keyring prompt) before init comes.
parentWatch.watchPid(Number(switchValue(process.argv, PARENT_PID_SWITCH)));
const early = switchValue(process.argv, SERVER_ROOT_SWITCH);
if (early) {
  try {
    loadNext(early);
  } catch {
    loaded = null;
  }
}

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
