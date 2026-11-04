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
