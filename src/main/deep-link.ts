/**
 * bulwark:// links, the one parser for them. A link can come from any web page or
 * document, so it's parsed down to these shapes and rebuilt. No path or query from
 * outside reaches a window.
 *
 *   bulwark://message/<login>/<id>
 *   bulwark://message/<id>?account=<login>&owner=<jmap account>
 *   bulwark://mailbox/<role or id>
 *   bulwark://folder/<role or id>
 *   bulwark://new
 *   bulwark://inbox, bulwark://calendar, bulwark://contacts
 *   bulwark://sign-in/callback?code=<code>&state=<state>
 *
 * A link isn't signed, so it may only show something. What opens from one carries
 * `via=link`, and the message window then doesn't mark it read or send a read receipt
 * by itself. Anything that would change mail needs the user's click in the window.
 *
 * The sign-in link is the redirect for a server that refuses a loopback one. It shows
 * nothing and opens nothing. It finishes a flow the user started in the app, if its state
 * is that flow's (browser-sign-in.ts), and otherwise it's dropped without a sound.
 */

export const DEEP_LINK_SCHEME = 'bulwark';

export type DeepLink =
  | { kind: 'message'; emailId: string; account?: string; owner?: string }
  | { kind: 'folder'; folder: string }
  | { kind: 'new' }
  | { kind: 'view'; view: 'inbox' | 'calendar' | 'contacts' }
  | { kind: 'sign-in'; code: string; state: string };

/** A link main opens itself. The others are commands to the page: features/os-rules.ts. */
export type WindowLink = Extract<DeepLink, { kind: 'message' | 'folder' }>;

/** JMAP ids, RFC 8620 section 1.2. A folder's role fits too. */
const ID = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * A login id: `<username>@<server host>` (lib/account-utils.ts in the webmail). The
 * username is usually an address itself, so it can hold another @.
 */
const LOGIN = /^[^\s/\\?#%<>"'`&]{1,254}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;

/** RFC 6749 appendix A: printable ASCII. */
const OAUTH_VALUE = /^[\x20-\x7e]{1,1024}$/;

function validId(value: string | null): string | undefined {
  return value && ID.test(value) ? value : undefined;
}

function validLogin(value: string | null): string | undefined {
  return value && LOGIN.test(value) ? value : undefined;
}

export function parseDeepLink(raw: unknown): DeepLink | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (url.hostname === 'message') {
    if (segments.length === 2) {
      const account = validLogin(segments[0]);
      if (!account || !ID.test(segments[1])) return null;
      return { kind: 'message', emailId: segments[1], account, owner: validId(url.searchParams.get('owner')) };
    }
    if (segments.length !== 1 || !ID.test(segments[0])) return null;
    return { kind: 'message', emailId: segments[0], account: validLogin(url.searchParams.get('account')), owner: validId(url.searchParams.get('owner')) };
  }
  if (url.hostname === 'folder' || url.hostname === 'mailbox') {
    if (segments.length !== 1 || !ID.test(segments[0])) return null;
    return { kind: 'folder', folder: segments[0] };
  }
  if (url.hostname === 'sign-in') {
    if (segments.length !== 1 || segments[0] !== 'callback') return null;
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || !OAUTH_VALUE.test(code) || !OAUTH_VALUE.test(state)) return null;
    return { kind: 'sign-in', code, state };
  }
  if (segments.length > 0) return null;
  if (url.hostname === 'new') return { kind: 'new' };
  if (url.hostname === 'inbox' || url.hostname === 'calendar' || url.hostname === 'contacts') return { kind: 'view', view: url.hostname };
  return null;
}

/** The first bulwark:// argument. A second launch on Windows and Linux has the link there. */
export function deepLinkFromArgv(argv: readonly string[]): DeepLink | null {
  for (const arg of argv) {
    if (arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) return parseDeepLink(arg);
  }
  return null;
}

function search(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const text = query.toString();
  return text ? `?${text}` : '';
}

/** The app's own address for a link: lib/popout/open.ts and lib/deep-links.ts in the webmail. */
export function appPathOfDeepLink(link: WindowLink): string {
  if (link.kind === 'message') {
    return `/popout/message/${encodeURIComponent(link.emailId)}${search({ account: link.account, owner: link.owner, via: 'link' })}`;
  }
  return `/mail/folder/${encodeURIComponent(link.folder)}`;
}

/** The window a message link opens in: the one "Open in new window" uses for it (lib/popout/open.ts). */
export function deepLinkWindowKey(emailId: string): string {
  return `bulwark-message-${emailId.replace(/\W/g, '_')}`;
}

/** A web page can fire links in a loop. Past this they're dropped. */
export class LinkRateLimit {
  private times: number[] = [];

  constructor(private readonly max = 5, private readonly perMs = 10_000) {}

  allow(now: number): boolean {
    this.times = this.times.filter((at) => now - at < this.perMs);
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }
}
