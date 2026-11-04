/**
 * Is an organisation's address a Bulwark server? Asked before the first run takes it, so a
 * mistyped one gets a line under the field instead of an empty window.
 *
 * A Bulwark webmail answers /api/config without a sign-in: its sign-in page needs it. That
 * JSON names the app and its mail server, which a random website doesn't. No Electron here:
 * main passes in its session's fetch, so the check goes the way the window would, through the
 * same proxy and certificate checks, and plain Node tests can reach it.
 */

export type InstanceCheck = { ok: true } | { ok: false; error: 'unreachable' | 'not_bulwark' };

export type CheckFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export const INSTANCE_CHECK_TIMEOUT_MS = 5000;
const MAX_BODY = 256 * 1024;

/**
 * Chromium's errors for a server that wants a client certificate, which this check doesn't
 * send. The server is there, and the window asks which certificate to use.
 */
const CLIENT_CERTIFICATE_ERRORS = /ERR_(?:SSL_CLIENT_AUTH_|BAD_SSL_CLIENT_AUTH_CERT)/;

/** What /api/config of every webmail version since its first answers. */
export function looksLikeBulwarkConfig(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const config = body as Record<string, unknown>;
  return typeof config.appName === 'string' && typeof config.jmapServerUrl === 'string';
}

/**
 * Where to ask: next to the address, for a webmail under a path, then at the root of its site.
 * The address comes from parseWelcomeAddress, so it ends in a slash.
 */
export function configUrls(instanceUrl: string): string[] {
  const base = new URL(instanceUrl);
  const nearby = new URL('api/config', base).toString();
  const root = new URL('/api/config', base.origin).toString();
  return nearby === root ? [root] : [nearby, root];
}

type Answer = 'bulwark' | 'other' | 'gated';

async function ask(fetcher: CheckFetch, url: string, signal: AbortSignal): Promise<Answer> {
  const response = await fetcher(url, { signal, headers: { accept: 'application/json' } });
  // A sign-in in front of the whole site (Windows sign-in, a proxy's): nothing to read, but there.
  if ((response.status === 401 && response.headers.has('www-authenticate')) || response.status === 407) return 'gated';
  if (!response.ok) return 'other';
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BODY) return 'other';
  const text = await response.text();
  if (text.length > MAX_BODY) return 'other';
  try {
    return looksLikeBulwarkConfig(JSON.parse(text)) ? 'bulwark' : 'other';
  } catch {
    return 'other';
  }
}

export async function checkInstance(instanceUrl: string, fetcher: CheckFetch, timeoutMs = INSTANCE_CHECK_TIMEOUT_MS): Promise<InstanceCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // fetch ignores an abort once the answer is in, and a stuck body read mustn't hold the page.
  const timedOut = new Promise<'timeout'>((resolve) => controller.signal.addEventListener('abort', () => resolve('timeout'), { once: true }));
  try {
    let answered = false;
    for (const url of configUrls(instanceUrl)) {
      let answer: Answer | 'timeout';
      try {
        answer = await Promise.race([ask(fetcher, url, controller.signal), timedOut]);
      } catch (error) {
        if (CLIENT_CERTIFICATE_ERRORS.test(String((error as Error)?.message ?? error))) return { ok: true };
        // The site doesn't answer at all: no point asking it again at the root.
        if (!answered) return { ok: false, error: 'unreachable' };
        break;
      }
      if (answer === 'timeout') return { ok: false, error: answered ? 'not_bulwark' : 'unreachable' };
      if (answer === 'bulwark' || answer === 'gated') return { ok: true };
      answered = true;
    }
    return { ok: false, error: 'not_bulwark' };
  } finally {
    clearTimeout(timer);
  }
}
