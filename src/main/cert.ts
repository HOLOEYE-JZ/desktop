/**
 * A self-signed X.509 certificate for the app's own origin, made with Node's
 * crypto alone. Node can make keys and sign, but has no certificate builder, so
 * the DER is written here: a small v3 certificate with subjectAltName and an
 * ECDSA P-256 signature. No dependency, and no openssl on the user's machine.
 *
 * Nothing but this app's session trusts it, through the fingerprint pin in
 * app-session.ts, so it needs no chain, and a long validity costs nothing.
 */

import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';

const VALIDITY_DAYS = 3650;

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const utf8String = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
const boolTrue = () => tlv(0x01, Buffer.from([0xff]));
const octetString = (content: Buffer) => tlv(0x04, content);
const bitString = (content: Buffer) => tlv(0x03, Buffer.from([0]), content);
const contextConstructed = (tag: number, ...parts: Buffer[]) => tlv(0xa0 | tag, ...parts);

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a * 40 + b];
  for (const value of rest) {
    const chunk: number[] = [value & 0x7f];
    for (let v = value >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function serialNumber(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f; // positive
  if (bytes[0] === 0) bytes[0] = 1; // minimal
  return tlv(0x02, bytes);
}

/** GeneralizedTime for 2050 and later, UTCTime before, as RFC 5280 asks. */
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() >= 2050
    ? tlv(0x18, Buffer.from(`${iso}Z`, 'ascii'))
    : tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, 'ascii'));
}

export interface GeneratedCertificate {
  keyPem: string;
  certPem: string;
  /** In the form Electron reports: `sha256/<base64 of the DER's hash>`. */
  fingerprint: string;
}

export function fingerprintOf(certPem: string): string {
  const der = new X509Certificate(certPem).raw;
  return `sha256/${createHash('sha256').update(der).digest('base64')}`;
}

/** False for an empty or damaged file too, and for a key and certificate of different rounds. */
export function certificateFitsKey(certPem: string, keyPem: string): boolean {
  try {
    return new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem));
  } catch {
    return false;
  }
}

export function generateCertificate(hostname: string, now: Date = new Date()): GeneratedCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

  const signatureAlgorithm = sequence(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = sequence(set(sequence(oid('2.5.4.3'), utf8String(hostname))));
  // Starts a day back, so a clock that is a bit off doesn't matter.
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(now.getTime() + VALIDITY_DAYS * 24 * 3600 * 1000);

  const subjectAltName = sequence(
    oid('2.5.29.17'),
    octetString(sequence(tlv(0x82, Buffer.from(hostname, 'ascii')))),
  );
  const keyUsage = sequence(
    oid('2.5.29.15'),
    boolTrue(),
    // digitalSignature and keyCertSign: see basicConstraints below.
    octetString(tlv(0x03, Buffer.from([0x02, 0x84]))),
  );
  const extendedKeyUsage = sequence(
    oid('2.5.29.37'),
    octetString(sequence(oid('1.3.6.1.5.5.7.3.1'))), // serverAuth
  );
  // CA:TRUE on a certificate that signs nothing else. BoringSSL, which Electron's
  // Node uses, only takes a self-signed certificate as its own trust anchor (the
  // pin in local-admin.ts) if it's a CA. Nothing outside this app trusts it.
  const basicConstraints = sequence(oid('2.5.29.19'), boolTrue(), octetString(sequence(tlv(0x01, Buffer.from([0xff])))));

  const tbs = sequence(
    contextConstructed(0, tlv(0x02, Buffer.from([2]))), // v3
    serialNumber(),
    signatureAlgorithm,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    spki,
    contextConstructed(3, sequence(subjectAltName, keyUsage, extendedKeyUsage, basicConstraints)),
  );

  // crypto.sign for EC gives the DER form X.509 wants.
  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(tbs, signatureAlgorithm, bitString(signature));

  const body = der.toString('base64').match(/.{1,64}/g)!.join('\n');
  const certPem = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    certPem,
    fingerprint: fingerprintOf(certPem),
  };
}
