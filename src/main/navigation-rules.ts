/** The URL rules behind navigation.ts. No Electron here, so tests can load them. */

export function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The embedded server's forwarding route, which holds other servers' answers on our origin. */
export function isJmapProxyPath(pathname: string): boolean {
  return pathname === '/__jmap' || pathname.startsWith('/__jmap/');
}

export function sameOrigin(url: URL | null, origin: string): boolean {
  return !!url && url.origin === origin;
}

/** An authorize or end-session request that comes back to this origin. */
export function isSsoStart(url: URL, origin: string): boolean {
  for (const name of ['redirect_uri', 'post_logout_redirect_uri']) {
    const target = url.searchParams.get(name);
    if (target && parse(target)?.origin === origin) return true;
  }
  return false;
}

/** How long a single sign-in may stay away from the origin, when a policy forces it. */
export const FORCED_SSO_LIMIT_MS = 10 * 60_000;

/**
 * While a sign-in redirect chain runs, the window may show any https page. It ends on the
 * way back to the origin, on a failed load, and, with a limit, after a while: a forced
 * server shouldn't become a general browser through an SSO link.
 */
export class SsoChain {
  private startedAt: number | null = null;

  constructor(
    private readonly limitMs: () => number | null,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.startedAt = this.now();
  }

  end(): void {
    this.startedAt = null;
  }

  active(): boolean {
    if (this.startedAt === null) return false;
    const limit = this.limitMs();
    if (limit !== null && this.now() - this.startedAt > limit) {
      this.startedAt = null;
      return false;
    }
    return true;
  }
}

export function looksLikeProviderLogout(url: URL): boolean {
  return (
    url.searchParams.has('post_logout_redirect_uri') ||
    url.searchParams.has('id_token_hint') ||
    /(^|\/)(logout|signout|sign-out|end[-_]?session)(\/|$)/i.test(url.pathname)
  );
}
