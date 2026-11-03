/** Which addresses count as private, for the approval prompt. No Electron here, so tests can load it. */

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

/** The webmail's list (lib/security/url-guard.ts), so whatever it refuses is asked about here. */
const BLOCKED_NAMES = new Set(['localhost']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.arpa', '.localdomain'];

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[0-1])\./, /^192\.168\./, /^192\.0\.0\./, /^198\.(1[8-9])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^22[4-9]\./, /^23\d\./, /^2[4-5]\d\./,
];

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_V4.some((pattern) => pattern.test(address));
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateAddress(mapped[1]);
  // Everything that isn't global unicast: loopback, link-local, unique local,
  // multicast, the mapped and translation prefixes. Fails towards asking.
  return !/^[23][0-9a-f]{3}:/.test(lower) || lower.startsWith('2001:db8') || lower.startsWith('2002:') || lower.startsWith('2001:0:');
}

export async function isPrivateHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (isIP(host)) return isPrivateAddress(host);
  try {
    const addresses = await dns.lookup(host, { all: true });
    return addresses.some(({ address }) => isPrivateAddress(address));
  } catch {
    // Unknown name: the login itself reports that it can't be reached.
    return false;
  }
}

/** Server origin of a URL the user typed, or null if it isn't usable. */
export function serverOrigin(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
