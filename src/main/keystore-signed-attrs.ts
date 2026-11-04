/**
 * What main is willing to sign: the signed attributes of a CMS message, and nothing else.
 *
 * A signature over a digest the page picked would be a blind oracle: the digest of a login
 * challenge or a TLS handshake looks like the digest of a mail. So the page hands over the
 * DER of the SignedAttributes (RFC 5652 section 5.4) and main checks their shape and hashes
 * them itself. What gets signed then always starts with a SET holding a mail's content type,
 * a message digest and a signing time, and a login's digest would need a preimage of that.
 *
 * What it can't do is see the message: the digest inside is still the page's word. That's
 * what the question at each signature is for.
 *
 * No Electron in this file, so plain Node tests reach all of it.
 */

import { createHash } from 'node:crypto';

/** S/MIME's own attributes come to a few hundred bytes. */
export const MAX_SIGNED_ATTRIBUTES = 4096;
/** The attributes are built right before the call, and this runs before any dialog. */
export const SIGNING_TIME_SLACK_MS = 10 * 60_000;

const HASHES: Record<string, { node: string; length: number }> = {
  'SHA-256': { node: 'sha256', length: 32 },
  'SHA-384': { node: 'sha384', length: 48 },
  'SHA-512': { node: 'sha512', length: 64 },
};

const ID_DATA = '2a864886f70d010701';
const CONTENT_TYPE = '2a864886f70d010903';
const MESSAGE_DIGEST = '2a864886f70d010904';
const SIGNING_TIME = '2a864886f70d010905';
/** What else S/MIME clients put in: capabilities, ESS signing certificate v2, and both key preferences. */
const ALSO_ALLOWED = new Set(['2a864886f70d01090f', '2a864886f70d010910022f', '2a864886f70d010910020b', '2b0601040182371004']);

const TAG = { sequence: 0x30, set: 0x31, oid: 0x06, octetString: 0x04, utcTime: 0x17, generalizedTime: 0x18 };

function invalid(): Error {
  return new Error('keystore:invalid');
}

interface Tlv {
  tag: number;
  value: Uint8Array;
  /** The whole element, tag and length too. */
  raw: Uint8Array;
}

/** Definite lengths in their shortest form only, as DER has them. */
function readTlv(data: Uint8Array, at: number): Tlv {
  if (at + 2 > data.length) throw invalid();
  const tag = data[at];
  if ((tag & 0x1f) === 0x1f) throw invalid();
  const first = data[at + 1];
  let start = at + 2;
  let length = first;
  if (first >= 0x80) {
    const count = first & 0x7f;
    if (count === 0 || count > 3 || start + count > data.length || data[start] === 0) throw invalid();
    length = 0;
    for (let index = 0; index < count; index += 1) length = length * 256 + data[start + index];
    if (length < 0x80) throw invalid();
    start += count;
  }
  if (start + length > data.length) throw invalid();
  return { tag, value: data.subarray(start, start + length), raw: data.subarray(at, start + length) };
}

function readAll(data: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  for (let at = 0; at < data.length; at += out[out.length - 1].raw.length) out.push(readTlv(data, at));
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  return Buffer.compare(a, b);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function only(values: Tlv[]): Tlv {
  if (values.length !== 1) throw invalid();
  return values[0];
}

/** UTCTime or GeneralizedTime, seconds and Z, as RFC 5652 has them. Null if it isn't one. */
function readTime({ tag, value }: Tlv): number | null {
  const text = Buffer.from(value).toString('latin1');
  const parts = tag === TAG.utcTime ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text) : tag === TAG.generalizedTime ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text) : null;
  if (!parts) return null;
  const short = Number(parts[1]);
  const year = tag === TAG.utcTime ? (short >= 50 ? 1900 + short : 2000 + short) : short;
  const at = Date.UTC(year, Number(parts[2]) - 1, Number(parts[3]), Number(parts[4]), Number(parts[5]), Number(parts[6]));
  return Number.isNaN(at) ? null : at;
}

/**
 * The digest to sign, or `keystore:invalid` for anything not shaped like the signed
 * attributes of a mail signed now. SHA-1 answers `keystore:unsupported`, as the helper does.
 */
export function signedAttributesDigest(input: unknown, hash: unknown, now: number): Uint8Array {
  if (hash === 'SHA-1') throw new Error('keystore:unsupported');
  const known = typeof hash === 'string' && Object.hasOwn(HASHES, hash) ? HASHES[hash] : null;
  if (!known) throw invalid();
  if (!(input instanceof Uint8Array) || input.length === 0 || input.length > MAX_SIGNED_ATTRIBUTES) throw invalid();

  const outer = readTlv(input, 0);
  if (outer.tag !== TAG.set || outer.raw.length !== input.length) throw invalid();

  const seen = new Set<string>();
  let previous: Uint8Array | null = null;
  for (const attribute of readAll(outer.value)) {
    if (attribute.tag !== TAG.sequence) throw invalid();
    // DER sorts a SET OF: a verifier encoding them again would hash something else.
    if (previous && compareBytes(previous, attribute.raw) >= 0) throw invalid();
    previous = attribute.raw;

    const parts = readAll(attribute.value);
    if (parts.length !== 2 || parts[0].tag !== TAG.oid || parts[1].tag !== TAG.set) throw invalid();
    const oid = hex(parts[0].value);
    if (seen.has(oid)) throw invalid();
    seen.add(oid);
    const values = readAll(parts[1].value);

    if (oid === CONTENT_TYPE) {
      const type = only(values);
      if (type.tag !== TAG.oid || hex(type.value) !== ID_DATA) throw invalid();
    } else if (oid === MESSAGE_DIGEST) {
      const digest = only(values);
      if (digest.tag !== TAG.octetString || digest.value.length !== known.length) throw invalid();
    } else if (oid === SIGNING_TIME) {
      const at = readTime(only(values));
      if (at === null || Math.abs(at - now) > SIGNING_TIME_SLACK_MS) throw invalid();
    } else if (!ALSO_ALLOWED.has(oid)) {
      throw invalid();
    }
  }
  for (const needed of [CONTENT_TYPE, MESSAGE_DIGEST, SIGNING_TIME]) if (!seen.has(needed)) throw invalid();

  return new Uint8Array(createHash(known.node).update(input).digest());
}
