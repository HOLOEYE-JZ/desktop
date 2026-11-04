/**
 * What the first-run page's Bulwark address field accepts. People type
 * `mail.example.com`, not `https://mail.example.com/`, and some type their
 * email address or their mail provider's name instead.
 */

import { parseInstanceUrl } from './policy-schema';

export type WelcomeAddressError = 'invalid_url' | 'insecure' | 'email' | 'no_jmap';

/**
 * Mail services people use most that don't offer JMAP, so neither mode can
 * reach them. A domain listed here matches itself and its subdomains.
 */
const NO_JMAP_DOMAINS = [
  'gmail.com', 'googlemail.com', 'google.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'office.com', 'office365.com',
  'icloud.com', 'me.com', 'mac.com',
];
/** Microsoft's country domains: outlook.de, hotmail.co.uk, live.fr. */
const NO_JMAP_COUNTRY = /^(?:outlook|hotmail|live)\.[a-z]{2,3}(?:\.[a-z]{2})?$/;

/** True for Gmail, Outlook.com and iCloud domains and their hosts (mail.google.com). */
export function isNoJmapDomain(domain: string): boolean {
  const host = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (NO_JMAP_COUNTRY.test(host)) return true;
  return NO_JMAP_DOMAINS.some((listed) => host === listed || host.endsWith(`.${listed}`));
}

/**
 * The typed address as the instance URL main expects, or why not. A bare host
 * gets `https://`. Only https, or http when the policy allows it.
 */
export function parseWelcomeAddress(raw: unknown, allowInsecure: boolean): { ok: true; value: string } | { ok: false; error: WelcomeAddressError } {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_url' };
  const text = raw.trim();
  // An email address: no scheme, one @, a dot after it.
  const email = /^[^\s@/]+@([^\s@/]+\.[^\s@/]+)$/.exec(text);
  if (email) return { ok: false, error: isNoJmapDomain(email[1]) ? 'no_jmap' : 'email' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let host = '';
  try {
    host = new URL(withScheme).hostname;
  } catch {
    // parseInstanceUrl says why.
  }
  if (host && isNoJmapDomain(host)) return { ok: false, error: 'no_jmap' };
  const parsed = parseInstanceUrl(withScheme, allowInsecure);
  if (parsed.ok) return { ok: true, value: parsed.value };
  return { ok: false, error: parsed.reason === 'insecure' ? 'insecure' : 'invalid_url' };
}

/**
 * The pages the first-run window may open in the browser, by name. The page only names
 * one: an address from it is never opened.
 */
const WELCOME_LINKS: Record<string, string> = {
  // What Bulwark works with. No page lists mail services yet; this one says what it needs.
  providers: 'https://bulwarkmail.org/docs/getting-started/introduction',
};

export function welcomeLinkUrl(name: unknown): string | null {
  return typeof name === 'string' && Object.hasOwn(WELCOME_LINKS, name) ? WELCOME_LINKS[name] : null;
}

export type WelcomeEmailError = 'email_invalid' | 'no_jmap';

/**
 * The first screen's email address. It catches Gmail, Outlook.com and iCloud, and
 * something that isn't an email address, before the app is set up for them. The address
 * goes on to the sign-in page (firstPageUrl), so nobody types it twice.
 */
export function parseWelcomeEmail(raw: unknown): { ok: true; email: string } | { ok: false; error: WelcomeEmailError } {
  if (typeof raw !== 'string') return { ok: false, error: 'email_invalid' };
  const text = raw.trim();
  const email = /^[^\s@/]+@([^\s@/]+\.[^\s@/.]+)$/.exec(text);
  if (!email) return { ok: false, error: 'email_invalid' };
  return isNoJmapDomain(email[1]) ? { ok: false, error: 'no_jmap' } : { ok: true, email: text };
}

/**
 * Where the first window of a standalone start goes. With the first screen's address it's
 * the sign-in page with that address filled in (the webmail reads login_hint, puts the
 * caret in the next field and passes it on to a browser sign-in).
 */
export function firstPageUrl(origin: string, email: string | null | undefined): string {
  if (!email) return `${origin}/`;
  return `${origin}/login?login_hint=${encodeURIComponent(email)}`;
}
