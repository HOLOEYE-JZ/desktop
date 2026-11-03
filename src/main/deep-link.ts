/**
 * bulwark:// links: to a message or a folder, and nothing else. A link can come
 * from any web page or document, so it's parsed down to these two shapes and
 * rebuilt. No path or query from outside reaches a window.
 *
 *   bulwark://message/<id>?account=<login>&owner=<jmap account>
 *   bulwark://folder/<role or id>
 */

export const DEEP_LINK_SCHEME = 'bulwark';

export type DeepLink =
  | { kind: 'message'; emailId: string; account?: string; owner?: string }
  | { kind: 'folder'; folder: string };

/** JMAP ids (RFC 8620 section 1.2) and our login ids: letters, digits, - and _. A folder may be a role. */
const ID = /^[A-Za-z0-9_-]{1,255}$/;

function validId(value: string | null): string | undefined {
  return value && ID.test(value) ? value : undefined;
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
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  let id: string;
  try {
    id = decodeURIComponent(segments[0]);
  } catch {
    return null;
  }
  if (!ID.test(id)) return null;
  const account = validId(url.searchParams.get('account'));
  if (url.hostname === 'message') {
    return { kind: 'message', emailId: id, account, owner: validId(url.searchParams.get('owner')) };
  }
  if (url.hostname === 'folder') return { kind: 'folder', folder: id };
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
export function appPathOfDeepLink(link: DeepLink): string {
  if (link.kind === 'message') {
    return `/popout/message/${encodeURIComponent(link.emailId)}${search({ account: link.account, owner: link.owner })}`;
  }
  return `/mail/folder/${encodeURIComponent(link.folder)}`;
}
