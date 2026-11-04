import { expect, test } from '@playwright/test';
import { createECDH, createHash, generateKeyPairSync } from 'node:crypto';
import { CANCELS_TO_DENY, createKeystoreGate, DENIES_TO_PAUSE, DENY_PAUSE_MS, KeystoreConsent, MAX_WAITING, originInList, RATE_CAP_PER_MINUTE, UNWRAP_GRANT_IDLE_MS, type ConsentAnswer, type ConsentOptions, type ConsentQuestion } from '../src/main/keystore-consent';
import type { NativeCertificate, NativeHelper } from '../src/main/native-loader';

/** The decisions behind the native dialog, with the dialog and the clock as fakes. */

const ORIGIN = 'https://app.bulwark.localhost';
const CERT = { id: 'a'.repeat(64), subject: 'CN=Someone', issuer: 'CN=Some CA', notAfter: 1_900_000_000_000, askEachUse: false };

function harness(answers: ConsentAnswer | ConsentAnswer[] = 'session', options: Partial<ConsentOptions> = {}) {
  const asked: ConsentQuestion[] = [];
  let time = 1_000_000;
  const queue = Array.isArray(answers) ? [...answers] : null;
  const consent = new KeystoreConsent({
    ask: async (question) => {
      asked.push(question);
      return queue ? (queue.shift() ?? 'deny') : (answers as ConsentAnswer);
    },
    instance: null,
    now: () => time,
    ...options,
  });
  return { consent, asked, advance: (ms: number) => { time += ms; } };
}

const refused = /^keystore:cancelled$/;

// DER by hand: these tests are about shapes a real encoder would never make.
function tlv(tag: number, value: Uint8Array): Buffer {
  const length = value.length < 0x80 ? [value.length] : value.length < 0x100 ? [0x81, value.length] : [0x82, value.length >> 8, value.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), value]);
}
const OID = {
  data: Buffer.from('2a864886f70d010701', 'hex'),
  contentType: Buffer.from('2a864886f70d010903', 'hex'),
  messageDigest: Buffer.from('2a864886f70d010904', 'hex'),
  signingTime: Buffer.from('2a864886f70d010905', 'hex'),
  capabilities: Buffer.from('2a864886f70d01090f', 'hex'),
};
function attribute(oid: Uint8Array, values: Uint8Array): Buffer {
  return tlv(0x30, Buffer.concat([tlv(0x06, oid), tlv(0x31, values)]));
}
function set(attributesList: Buffer[], sort = true): Buffer {
  return tlv(0x31, Buffer.concat(sort ? [...attributesList].sort(Buffer.compare) : attributesList));
}
function utcTime(at: number): Buffer {
  const text = new Date(at).toISOString().replace(/[-:T]|\.\d+/g, '').slice(2);
  return tlv(0x17, Buffer.from(text));
}
function attributes(options: { hash?: string; capabilities?: boolean; generalizedTime?: boolean } = {}): Uint8Array {
  const digest = createHash(options.hash ?? 'sha256').update('the message').digest();
  const when = options.generalizedTime
    ? tlv(0x18, Buffer.from(new Date().toISOString().replace(/[-:T]|\.\d+/g, '')))
    : utcTime(Date.now());
  return new Uint8Array(set([
    attribute(OID.contentType, tlv(0x06, OID.data)),
    attribute(OID.messageDigest, tlv(0x04, digest)),
    attribute(OID.signingTime, when),
    ...(options.capabilities ? [attribute(OID.capabilities, tlv(0x30, tlv(0x30, tlv(0x06, Buffer.from('60864801650304012a', 'hex')))))] : []),
  ]));
}
const SCHEME = { scheme: 'rsa-pkcs1', hash: 'SHA-256' };
/** A real P-256 public key, as an SPKI. */
const PEER = (() => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // id-ecPublicKey, prime256v1.
  const algorithm = Buffer.from('301306072a8648ce3d020106082a8648ce3d030107', 'hex');
  return new Uint8Array(tlv(0x30, Buffer.concat([algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), ecdh.getPublicKey()]))])));
})();

test.describe('the list', () => {
  test('asks once for a session, and a lock asks again', async () => {
    const { consent, asked } = harness('session');
    await consent.forList(ORIGIN, null);
    await consent.forList(ORIGIN, null);
    expect(asked.map((question) => question.kind)).toEqual(['list']);
    consent.clearGrants();
    await consent.forList(ORIGIN, null);
    expect(asked).toHaveLength(2);
  });

  test('Allow once asks again next time', async () => {
    const { consent, asked } = harness('once');
    await consent.forList(ORIGIN, null);
    await consent.forList(ORIGIN, null);
    expect(asked).toHaveLength(2);
  });

  test('Deny sticks, through a screen lock too, with no second dialog', async () => {
    const { consent, asked } = harness('deny');
    await expect(consent.forList(ORIGIN, null)).rejects.toThrow(refused);
    await expect(consent.forList(ORIGIN, null)).rejects.toThrow(refused);
    consent.clearGrants();
    await expect(consent.forList(ORIGIN, null)).rejects.toThrow(refused);
    expect(asked).toHaveLength(1);
  });

  test('a dialog that fails to open is a no', async () => {
    const { consent } = harness('session', { ask: () => Promise.reject(new Error('no window')) });
    await expect(consent.forList(ORIGIN, null)).rejects.toThrow(refused);
  });
});

test.describe('using a key', () => {
  test('an unwrap grant is per origin and per certificate, and says nothing about signing', async () => {
    const { consent, asked } = harness('session');
    await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    expect(asked).toHaveLength(1);
    await consent.forUse(ORIGIN, CERT, 'sign', null);
    expect(asked, 'another class').toHaveLength(2);
    await consent.forUse(ORIGIN, { ...CERT, id: 'b'.repeat(64) }, 'unwrap', null);
    expect(asked, 'another certificate').toHaveLength(3);
    await consent.forUse('https://other.example', CERT, 'unwrap', null);
    expect(asked, 'another origin').toHaveLength(4);
  });

  test('signing asks every time: no answer turns into a grant', async () => {
    const { consent, asked } = harness('session');
    for (let send = 0; send < 50; send += 1) await consent.forUse(ORIGIN, CERT, 'sign', null);
    expect(asked, 'one yes is not an oracle').toHaveLength(50);
    expect(asked.every((question) => question.kind === 'sign')).toBe(true);
  });

  test('an unwrap grant ends after 15 minutes without use, and each use starts them over', async () => {
    const { consent, asked, advance } = harness('session');
    await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    for (let turn = 0; turn < 4; turn += 1) {
      advance(UNWRAP_GRANT_IDLE_MS - 1000);
      await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    }
    expect(asked, 'it slides').toHaveLength(1);
    advance(UNWRAP_GRANT_IDLE_MS + 1);
    await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    expect(asked, 'idle for 15 minutes').toHaveLength(2);
    expect(UNWRAP_GRANT_IDLE_MS).toBe(15 * 60_000);
  });

  test('a Deny on an unwrap lasts for that message only', async () => {
    const { consent, asked } = harness(['deny', 'once']);
    await expect(consent.forUse(ORIGIN, CERT, 'unwrap', null, { message: 'stranger' })).rejects.toThrow(refused);
    await expect(consent.forUse(ORIGIN, CERT, 'unwrap', null, { message: 'stranger' })).rejects.toThrow(refused);
    expect(asked, 'the same message: no second dialog').toHaveLength(1);
    await consent.forUse(ORIGIN, CERT, 'unwrap', null, { message: 'a friend' });
    expect(asked, 'the key is still usable').toHaveLength(2);
    consent.clearGrants();
    await expect(consent.forUse(ORIGIN, CERT, 'unwrap', null, { message: 'stranger' })).rejects.toThrow(refused);
    expect(asked, 'and it holds through a lock').toHaveLength(2);
  });

  test('a Deny on a signature is for that send: the next one asks', async () => {
    const { consent, asked } = harness(['deny', 'once']);
    await expect(consent.forUse(ORIGIN, CERT, 'sign', null)).rejects.toThrow(refused);
    await consent.forUse(ORIGIN, CERT, 'sign', null);
    expect(asked).toHaveLength(2);
  });

  test('no after no pauses that key and use, and a yes resets the count', async () => {
    const { consent, asked, advance } = harness('deny');
    const message = (index: number) => ({ message: `mail ${index}` });
    for (let index = 0; index < DENIES_TO_PAUSE; index += 1) await expect(consent.forUse(ORIGIN, CERT, 'unwrap', null, message(index))).rejects.toThrow(refused);
    expect(asked).toHaveLength(DENIES_TO_PAUSE);
    await expect(consent.forUse(ORIGIN, CERT, 'unwrap', null, message(99))).rejects.toThrow(refused);
    expect(asked, 'no dialog storm from new ciphertexts').toHaveLength(DENIES_TO_PAUSE);
    await consent.forUse(ORIGIN, CERT, 'sign', null).catch(() => undefined);
    expect(asked, 'signing is its own question').toHaveLength(DENIES_TO_PAUSE + 1);
    advance(DENY_PAUSE_MS + 1);
    await expect(consent.forUse(ORIGIN, CERT, 'unwrap', null, message(100))).rejects.toThrow(refused);
    expect(asked, 'the pause ends').toHaveLength(DENIES_TO_PAUSE + 2);

    const again = harness(['deny', 'deny', 'once', 'deny', 'deny', 'once']);
    const answers = [];
    for (let index = 0; index < 6; index += 1) answers.push(await again.consent.forUse(ORIGIN, CERT, 'sign', null).then(() => 'yes', () => 'no'));
    expect(answers).toEqual(['no', 'no', 'yes', 'no', 'no', 'yes']);
  });

  test('a quiet call never opens a dialog, and passes on a grant', async () => {
    const { consent, asked } = harness('session');
    await expect(consent.forList(ORIGIN, null, { quiet: true })).rejects.toThrow(/^keystore:ask-first$/);
    await expect(consent.forUse(ORIGIN, CERT, 'unwrap', null, { message: 'm', quiet: true })).rejects.toThrow(/^keystore:ask-first$/);
    expect(asked).toEqual([]);
    await consent.forList(ORIGIN, null);
    await consent.forUse(ORIGIN, CERT, 'unwrap', null, { message: 'm' });
    await consent.forList(ORIGIN, null, { quiet: true });
    await consent.forUse(ORIGIN, CERT, 'unwrap', null, { message: 'n', quiet: true });
    expect(asked, 'on the grants').toHaveLength(2);
  });

  test('a quiet call on an instance that is off stays quiet', async () => {
    const stored: string[] = [];
    const instance = { allowedByPolicy: () => false, isStored: (origin: string) => stored.includes(origin), store: (origin: string) => { stored.push(origin); }, forget: () => {} };
    const { consent, asked } = harness('session', { instance });
    await expect(consent.forUse('https://mail.example.org', CERT, 'unwrap', null, { quiet: true })).rejects.toThrow(/^keystore:ask-first$/);
    await expect(consent.forList('https://mail.example.org', null, { quiet: true })).rejects.toThrow(/^keystore:ask-first$/);
    expect(asked).toEqual([]);
    expect(stored).toEqual([]);
  });

  test('the question names the origin, the certificate and the operation', async () => {
    const { consent, asked } = harness('once');
    await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    expect(asked[0]).toEqual({ kind: 'unwrap', origin: ORIGIN, certificate: 'CN=Someone', issuer: 'CN=Some CA', notAfter: 1_900_000_000_000, perOperation: false, overRate: false });
  });

  test('a Deny for signing leaves unwrapping to its own question', async () => {
    const { consent, asked } = harness(['deny', 'session']);
    await expect(consent.forUse(ORIGIN, CERT, 'sign', null)).rejects.toThrow(refused);
    await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    expect(asked.map((question) => question.kind)).toEqual(['sign', 'unwrap']);
  });

  test('a certificate that can also sign in asks each time, even after Allow for this session', async () => {
    const { consent, asked } = harness('session');
    const broad = { ...CERT, askEachUse: true };
    await consent.forUse(ORIGIN, broad, 'unwrap', null);
    await consent.forUse(ORIGIN, broad, 'unwrap', null);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({ perOperation: true });
  });

  test('past the rate cap a session grant asks again, and a yes starts the count over', async () => {
    const { consent, asked, advance } = harness('session');
    for (let use = 0; use < RATE_CAP_PER_MINUTE; use += 1) await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    expect(asked).toHaveLength(1);
    await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({ overRate: true });
    await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    expect(asked, 'the new yes counts from here').toHaveLength(2);
    advance(61_000);
    for (let use = 0; use < RATE_CAP_PER_MINUTE - 1; use += 1) await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    expect(asked, 'an old minute does not count').toHaveLength(2);
  });

  test('the cap says nothing on a signature: heavy decrypting does not mark it', async () => {
    const { consent, asked } = harness('session');
    for (let use = 0; use < RATE_CAP_PER_MINUTE; use += 1) await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    await consent.forUse(ORIGIN, CERT, 'sign', null);
    expect(asked.at(-1)).toMatchObject({ kind: 'sign', overRate: false });
  });

  test('past the cap, Deny stops it for the session', async () => {
    const { consent, asked } = harness(['session', 'deny']);
    for (let use = 0; use < RATE_CAP_PER_MINUTE; use += 1) await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    await expect(consent.forUse(ORIGIN, CERT, 'unwrap', null)).rejects.toThrow(refused);
    await expect(consent.forUse(ORIGIN, CERT, 'unwrap', null)).rejects.toThrow(refused);
    expect(asked).toHaveLength(2);
  });

  test('repeated cancels at the OS prompt count as a Deny for that message, and a success resets the count', async () => {
    const { consent, asked } = harness('session');
    await consent.forUse(ORIGIN, CERT, 'unwrap', null, { message: 'one' });
    consent.noteOutcome(ORIGIN, CERT.id, 'unwrap', 'cancelled', 'one');
    consent.noteOutcome(ORIGIN, CERT.id, 'unwrap', 'done', 'one');
    for (let cancel = 0; cancel < CANCELS_TO_DENY - 1; cancel += 1) consent.noteOutcome(ORIGIN, CERT.id, 'unwrap', 'cancelled', 'one');
    await consent.forUse(ORIGIN, CERT, 'unwrap', null, { message: 'one' });
    consent.noteOutcome(ORIGIN, CERT.id, 'unwrap', 'cancelled', 'one');
    await expect(consent.forUse(ORIGIN, CERT, 'unwrap', null, { message: 'one' })).rejects.toThrow(refused);
    expect(asked, 'that message: no dialog about it').toHaveLength(1);
    await consent.forUse(ORIGIN, CERT, 'unwrap', null, { message: 'two' });
    expect(asked, 'the grant is gone, so a PIN loop has to come past a dialog').toHaveLength(2);
  });
});

test.describe('no dialog storm', () => {
  const held = () => {
    const answers: Array<(answer: ConsentAnswer) => void> = [];
    const asked: ConsentQuestion[] = [];
    return {
      asked,
      answers,
      ask: (question: ConsentQuestion) => {
        asked.push(question);
        return new Promise<ConsentAnswer>((resolve) => answers.push(resolve));
      },
    };
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

  test('calls at once share one dialog, and Deny answers them all', async () => {
    const dialog = held();
    const consent = new KeystoreConsent({ ask: dialog.ask, instance: null });
    const calls = [1, 2, 3].map(() => consent.forUse(ORIGIN, CERT, 'sign', null).then(() => 'allowed', () => 'refused'));
    await tick();
    expect(dialog.asked).toHaveLength(1);
    dialog.answers[0]('deny');
    expect(await Promise.all(calls)).toEqual(['refused', 'refused', 'refused']);
    expect(dialog.asked).toHaveLength(1);
  });

  test('a shared Allow once lets one through and asks again for the next', async () => {
    const dialog = held();
    const consent = new KeystoreConsent({ ask: dialog.ask, instance: null });
    const calls = [consent.forUse(ORIGIN, CERT, 'sign', null), consent.forUse(ORIGIN, CERT, 'sign', null)];
    await tick();
    dialog.answers[0]('once');
    await calls[0];
    await tick();
    expect(dialog.asked, 'one click, one use').toHaveLength(2);
    dialog.answers[1]('once');
    await calls[1];
  });

  test('different questions wait in line: one dialog on screen', async () => {
    const dialog = held();
    const consent = new KeystoreConsent({ ask: dialog.ask, instance: null });
    const sign = consent.forUse(ORIGIN, CERT, 'sign', null);
    const unwrap = consent.forUse(ORIGIN, CERT, 'unwrap', null);
    await tick();
    expect(dialog.asked).toHaveLength(1);
    dialog.answers[0]('once');
    await sign;
    await tick();
    expect(dialog.asked).toHaveLength(2);
    dialog.answers[1]('session');
    await unwrap;
  });

  test('a yes for one message answers the question still waiting for another', async () => {
    const dialog = held();
    const consent = new KeystoreConsent({ ask: dialog.ask, instance: null });
    const first = consent.forUse(ORIGIN, CERT, 'unwrap', null, { message: 'one' });
    const second = consent.forUse(ORIGIN, CERT, 'unwrap', null, { message: 'two' });
    await tick();
    dialog.answers[0]('session');
    await Promise.all([first, second]);
    expect(dialog.asked).toHaveLength(1);
  });

  test('past the limit of waiting calls, more fail at once', async () => {
    const dialog = held();
    const consent = new KeystoreConsent({ ask: dialog.ask, instance: null });
    const calls = Array.from({ length: MAX_WAITING }, () => consent.forUse(ORIGIN, CERT, 'sign', null).catch(() => undefined));
    await tick();
    await expect(consent.forUse(ORIGIN, CERT, 'sign', null)).rejects.toThrow(/^keystore:locked$/);
    dialog.answers[0]('deny');
    await Promise.all(calls);
  });
});

test.describe('an instance', () => {
  const INSTANCE = 'https://mail.example.org';
  const access = (stored: string[] = [], policy: string[] = []) => ({
    stored,
    allowedByPolicy: (origin: string) => originInList(policy, origin),
    isStored: (origin: string) => stored.includes(origin),
    store: (origin: string) => { stored.push(origin); },
    forget: (origin: string) => { stored.splice(stored.indexOf(origin), 1); },
  });

  test('is off by default, and a no stores nothing and sticks', async () => {
    const instance = access();
    const { consent, asked } = harness('deny', { instance });
    expect(consent.accessState(INSTANCE)).toBe('off');
    await expect(consent.forList(INSTANCE, null)).rejects.toThrow(refused);
    await expect(consent.forUse(INSTANCE, CERT, 'sign', null)).rejects.toThrow(refused);
    await expect(consent.forList(INSTANCE, null)).rejects.toThrow(refused);
    expect(asked.map((question) => question.kind)).toEqual(['first-use']);
    expect(instance.stored).toEqual([]);
  });

  test('a yes is stored per origin, and asks one question, not two', async () => {
    const instance = access();
    const { consent, asked } = harness('session', { instance });
    await consent.forList(INSTANCE, null);
    expect(asked.map((question) => question.kind)).toEqual(['first-use']);
    expect(instance.stored).toEqual([INSTANCE]);
    expect(consent.accessState(INSTANCE)).toBe('stored');
    expect(consent.accessState('https://other.example')).toBe('off');
  });

  test('the session grants still apply on top of a stored yes', async () => {
    const instance = access([INSTANCE]);
    const { consent, asked } = harness('session', { instance });
    await consent.forList(INSTANCE, null);
    await consent.forUse(INSTANCE, CERT, 'sign', null);
    expect(asked.map((question) => question.kind)).toEqual(['list', 'sign']);
  });

  test('policy turns it on for the origins it names, with the session grants on top', async () => {
    const instance = access([], [INSTANCE]);
    const { consent, asked } = harness('session', { instance });
    expect(consent.accessState(INSTANCE)).toBe('policy');
    expect(consent.accessState('https://other.example')).toBe('off');
    await consent.forList(INSTANCE, null);
    expect(asked.map((question) => question.kind)).toEqual(['list']);
    expect(instance.stored, 'nothing to store').toEqual([]);
  });

  test('revoke takes the stored yes and the grants, and a key use then asks first-use again', async () => {
    const instance = access();
    const { consent, asked } = harness('session', { instance });
    await consent.forList(INSTANCE, null);
    await consent.forUse(INSTANCE, CERT, 'sign', null);
    consent.revoke(INSTANCE);
    expect(instance.stored).toEqual([]);
    expect(consent.accessState(INSTANCE)).toBe('off');
    await consent.forUse(INSTANCE, CERT, 'sign', null);
    expect(asked.map((question) => question.kind)).toEqual(['first-use', 'sign', 'first-use', 'sign']);
  });

  test('revoke keeps a refusal, so no page can use it to ask again', async () => {
    const instance = access();
    const { consent, asked } = harness('deny', { instance });
    await expect(consent.forList(INSTANCE, null)).rejects.toThrow(refused);
    consent.revoke(INSTANCE);
    await expect(consent.forList(INSTANCE, null)).rejects.toThrow(refused);
    expect(asked).toHaveLength(1);
  });

  test('standalone needs no first-use question', async () => {
    const { consent, asked } = harness('session');
    expect(consent.accessState(ORIGIN)).toBe('app');
    await consent.forList(ORIGIN, null);
    expect(asked.map((question) => question.kind)).toEqual(['list']);
  });

  test('a policy list matches exact https origins and nothing else', () => {
    expect(originInList([INSTANCE], INSTANCE)).toBe(true);
    expect(originInList(['https://mail.example.org/path'], INSTANCE)).toBe(true);
    expect(originInList(['http://mail.example.org'], 'http://mail.example.org')).toBe(false);
    expect(originInList(['https://*.example.org'], INSTANCE)).toBe(false);
    expect(originInList(['https://example.org'], INSTANCE)).toBe(false);
    expect(originInList([42, null, 'not a url'], INSTANCE)).toBe(false);
  });
});

test.describe('grants taken back with a dialog on screen', () => {
  const held = () => {
    const answers: Array<(answer: ConsentAnswer) => void> = [];
    const asked: ConsentQuestion[] = [];
    return {
      asked,
      answers,
      ask: (question: ConsentQuestion) => {
        asked.push(question);
        return new Promise<ConsentAnswer>((resolve) => answers.push(resolve));
      },
    };
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

  test('an answer after clearGrants grants nothing, not even that one call', async () => {
    const dialog = held();
    const consent = new KeystoreConsent({ ask: dialog.ask, instance: null });
    for (const answer of ['session', 'once'] as const) {
      const call = consent.forUse(ORIGIN, CERT, 'unwrap', null);
      await tick();
      consent.clearGrants();
      dialog.answers[dialog.answers.length - 1](answer);
      await expect(call, answer).rejects.toThrow(refused);
    }
    const asked = dialog.asked.length;
    const next = consent.forUse(ORIGIN, CERT, 'unwrap', null);
    await tick();
    expect(dialog.asked, 'the next call asks').toHaveLength(asked + 1);
    dialog.answers[dialog.answers.length - 1]('deny');
    await next.catch(() => undefined);
  });

  test('a yes to a first-use question after clearGrants stores nothing', async () => {
    const dialog = held();
    const stored: string[] = [];
    const consent = new KeystoreConsent({
      ask: dialog.ask,
      instance: { allowedByPolicy: () => false, isStored: () => false, store: (origin) => { stored.push(origin); }, forget: () => {} },
    });
    const call = consent.forList('https://mail.example.org', null);
    await tick();
    consent.clearGrants();
    dialog.answers[0]('session');
    await expect(call).rejects.toThrow(refused);
    expect(stored).toEqual([]);
  });

  test('a question still in line when grants clear is never shown', async () => {
    const dialog = held();
    const consent = new KeystoreConsent({ ask: dialog.ask, instance: null });
    const first = consent.forUse(ORIGIN, CERT, 'unwrap', null);
    const second = consent.forUse(ORIGIN, CERT, 'sign', null);
    await tick();
    expect(dialog.asked).toHaveLength(1);
    consent.clearGrants();
    dialog.answers[0]('once');
    await expect(first).rejects.toThrow(refused);
    await expect(second).rejects.toThrow(refused);
    expect(dialog.asked).toHaveLength(1);
  });
});

test.describe('when the keystore is shut', () => {
  const INSTANCE = 'https://mail.example.org';
  const instanceWith = (stored: string[] = []) => ({
    allowedByPolicy: (origin: string) => originInList([INSTANCE], origin),
    isStored: (origin: string) => stored.includes(origin),
    store: (origin: string) => { stored.push(origin); },
    forget: () => {},
  });

  test('never asks about an origin that is not https', async () => {
    const stored = ['http://mail.example.org'];
    const { consent, asked } = harness('session', { instance: instanceWith(stored) });
    await expect(consent.forList('http://mail.example.org', null)).rejects.toThrow(/^keystore:unsupported$/);
    await expect(consent.forList('http://other.example', null)).rejects.toThrow(/^keystore:unsupported$/);
    await expect(consent.forUse('http://other.example', CERT, 'unwrap', null)).rejects.toThrow(/^keystore:unsupported$/);
    await expect(consent.forUse('http://mail.example.org', CERT, 'sign', null)).rejects.toThrow(/^keystore:unsupported$/);
    expect(asked).toEqual([]);
    expect(stored, 'and stores nothing').toEqual(['http://mail.example.org']);
    expect(consent.accessState('http://mail.example.org'), 'an old stored yes counts for nothing').toBe('off');
    expect(consent.accessState('http://other.example')).toBe('off');
  });

  test('while the app is locked calls fail without a dialog, and carry on after', async () => {
    let locked = true;
    const { consent, asked } = harness('session', { locked: () => locked });
    await expect(consent.forList(ORIGIN, null)).rejects.toThrow(/^keystore:locked$/);
    await expect(consent.forUse(ORIGIN, CERT, 'unwrap', null)).rejects.toThrow(/^keystore:locked$/);
    await expect(consent.forUse(ORIGIN, CERT, 'sign', null)).rejects.toThrow(/^keystore:locked$/);
    expect(asked).toEqual([]);
    locked = false;
    await consent.forList(ORIGIN, null);
    expect(asked).toHaveLength(1);
  });

  test('a grant does not pass while locked, and a yes given as the lock came does not either', async () => {
    let locked = false;
    let answer: (value: ConsentAnswer) => void = () => {};
    const consent = new KeystoreConsent({ instance: null, locked: () => locked, ask: () => new Promise((resolve) => { answer = resolve; }) });
    const call = consent.forUse(ORIGIN, CERT, 'unwrap', null);
    await new Promise((resolve) => setTimeout(resolve, 2));
    locked = true;
    answer('session');
    await expect(call).rejects.toThrow(/^keystore:locked$/);
  });

  test('turned off by policy nothing asks and nothing passes, whatever was allowed', async () => {
    let off = false;
    const { consent, asked } = harness('session', { off: () => off, instance: instanceWith([INSTANCE]) });
    await consent.forList(INSTANCE, null);
    await consent.forUse(INSTANCE, CERT, 'unwrap', null);
    const before = asked.length;
    expect(consent.accessState(INSTANCE)).toBe('policy');
    off = true;
    expect(consent.accessState(INSTANCE)).toBe('off');
    await expect(consent.forList(INSTANCE, null)).rejects.toThrow(/^keystore:unsupported$/);
    await expect(consent.forUse(INSTANCE, CERT, 'unwrap', null)).rejects.toThrow(/^keystore:unsupported$/);
    await expect(consent.forUse(INSTANCE, CERT, 'sign', null)).rejects.toThrow(/^keystore:unsupported$/);
    expect(asked).toHaveLength(before);
    off = false;
    await consent.forUse(INSTANCE, CERT, 'unwrap', null);
    expect(asked, 'what was allowed before does not come back with it').toHaveLength(before + 1);
  });
});

test.describe('the gate in front of the helper', () => {
  const entry = { id: CERT.id, subject: 'CN=Someone', issuer: 'CN=Some CA', notAfter: 1_900_000_000_000, askEachUse: false, curve: 'P-256' } as NativeCertificate;

  function helper(overrides: Partial<NativeHelper['keystore']> = {}): NativeHelper['keystore'] & { calls: string[] } {
    const calls: string[] = [];
    return {
      available: true,
      stuck: () => false,
      list: async () => [entry],
      sign: async () => {
        calls.push('sign');
        return new Uint8Array([1]);
      },
      decrypt: async () => {
        calls.push('decrypt');
        return new Uint8Array([2]);
      },
      agree: async () => {
        calls.push('agree');
        return new Uint8Array([3]);
      },
      calls,
      ...overrides,
    };
  }

  test('Deny never reaches the helper, on any of the three key calls', async () => {
    const native = helper();
    const { consent } = harness(['session', 'deny', 'deny', 'deny']);
    const gate = createKeystoreGate(native, consent);
    await gate.list(ORIGIN, null);
    await expect(gate.sign(ORIGIN, CERT.id, attributes(), SCHEME, null, null)).rejects.toThrow(refused);
    await expect(gate.decrypt(ORIGIN, CERT.id, new Uint8Array(256), {}, null, null)).rejects.toThrow(refused);
    await expect(gate.agree(ORIGIN, CERT.id, PEER, null, null)).rejects.toThrow(refused);
    expect(native.calls).toEqual([]);
  });

  test('a denied list hands out nothing, and an id without a list asks nobody', async () => {
    const native = helper({ list: () => { throw new Error('reached the store'); } });
    const { consent, asked } = harness('deny');
    const gate = createKeystoreGate(native, consent);
    await expect(gate.list(ORIGIN, null)).rejects.toThrow(refused);
    await expect(gate.sign(ORIGIN, CERT.id, attributes(), SCHEME, null, null)).rejects.toThrow(/^keystore:not-found$/);
    expect(asked).toHaveLength(1);
  });

  test('decrypt and agree are one class: unwrap', async () => {
    const native = helper();
    const { consent, asked } = harness('session');
    const gate = createKeystoreGate(native, consent);
    await gate.list(ORIGIN, null);
    await gate.decrypt(ORIGIN, CERT.id, new Uint8Array(256), {}, null, null);
    await gate.agree(ORIGIN, CERT.id, PEER, null, null);
    expect(asked.map((question) => question.kind)).toEqual(['list', 'unwrap']);
    expect(native.calls).toEqual(['decrypt', 'agree']);
  });

  test('while an operation is stuck, calls fail fast and no dialog opens', async () => {
    const native = helper({ stuck: () => true });
    const { consent, asked } = harness('session');
    const gate = createKeystoreGate(native, consent);
    await gate.list(ORIGIN, null);
    const before = asked.length;
    await expect(gate.sign(ORIGIN, CERT.id, attributes(), SCHEME, null, null)).rejects.toThrow(/^keystore:locked$/);
    expect(asked).toHaveLength(before);
  });

  test('a bad id is refused with no dialog', async () => {
    const { consent, asked } = harness('session');
    const gate = createKeystoreGate(helper(), consent);
    await expect(gate.sign(ORIGIN, 'nope', attributes(), SCHEME, null, null)).rejects.toThrow(/^keystore:invalid$/);
    expect(asked).toEqual([]);
  });

  test('two cancels at the OS prompt end it for that message, without the helper or a dialog', async () => {
    let tries = 0;
    const native = helper({
      decrypt: () => {
        tries += 1;
        return Promise.reject(new Error('keystore:cancelled'));
      },
    });
    const { consent, asked } = harness('session');
    const gate = createKeystoreGate(native, consent);
    await gate.list(ORIGIN, null);
    const data = new Uint8Array(256).fill(7);
    for (let attempt = 0; attempt < 4; attempt += 1) await expect(gate.decrypt(ORIGIN, CERT.id, data, {}, null, null)).rejects.toThrow(refused);
    expect(tries).toBe(CANCELS_TO_DENY);
    expect(asked.map((question) => question.kind)).toEqual(['list', 'unwrap']);
    await expect(gate.decrypt(ORIGIN, CERT.id, new Uint8Array(256).fill(8), {}, null, null)).rejects.toThrow(refused);
    expect(asked.map((question) => question.kind), 'another message asks').toEqual(['list', 'unwrap', 'unwrap']);
  });

  test('main hashes the signed attributes itself: the helper gets their digest', async () => {
    const seen: Uint8Array[] = [];
    const native = helper({
      sign: async (_id, digest) => {
        seen.push(digest as Uint8Array);
        return new Uint8Array([1]);
      },
    });
    const { consent } = harness('once');
    const gate = createKeystoreGate(native, consent);
    await gate.list(ORIGIN, null);
    const signed = attributes();
    await gate.sign(ORIGIN, CERT.id, signed, SCHEME, null, null);
    expect(Buffer.from(seen[0]).toString('hex')).toBe(createHash('sha256').update(signed).digest('hex'));
    await gate.sign(ORIGIN, CERT.id, attributes({ hash: 'sha384' }), { scheme: 'rsa-pkcs1', hash: 'SHA-384' }, null, null);
    expect(seen[1]).toHaveLength(48);
  });

  test('a raw digest, a login or anything else shaped wrong is refused with no dialog', async () => {
    const native = helper();
    const { consent, asked } = harness('once');
    const gate = createKeystoreGate(native, consent);
    await gate.list(ORIGIN, null);
    const before = asked.length;
    const now = Date.now();
    const contentType = attribute(OID.contentType, tlv(0x06, OID.data));
    const digest = attribute(OID.messageDigest, tlv(0x04, Buffer.alloc(32, 1)));
    const time = attribute(OID.signingTime, utcTime(now));
    const refusedShapes: Array<[string, unknown, unknown?]> = [
      ['a raw SHA-256 digest', new Uint8Array(32).fill(9)],
      ['a TLS-style blob', Buffer.concat([Buffer.alloc(64, 0x20), Buffer.from('TLS 1.3, client CertificateVerify'), Buffer.from([0]), Buffer.alloc(32, 3)])],
      ['not bytes', 'text'],
      ['empty', new Uint8Array(0)],
      ['too long', new Uint8Array(70_000)],
      ['no content type', set([digest, time])],
      ['no message digest', set([contentType, time])],
      ['no signing time', set([contentType, digest])],
      ['another content type', set([attribute(OID.contentType, tlv(0x06, Buffer.from('2a864886f70d010702', 'hex'))), digest, time])],
      ['a digest of another length', set([contentType, attribute(OID.messageDigest, tlv(0x04, Buffer.alloc(20, 1))), time])],
      ['a digest that is no octet string', set([contentType, attribute(OID.messageDigest, tlv(0x0c, Buffer.alloc(32, 0x41))), time])],
      ['two message digests', set([contentType, attribute(OID.messageDigest, Buffer.concat([tlv(0x04, Buffer.alloc(32, 1)), tlv(0x04, Buffer.alloc(32, 2))])), time])],
      ['a signing time a day old', set([contentType, digest, attribute(OID.signingTime, utcTime(now - 86_400_000))])],
      ['a signing time from next year', set([contentType, digest, attribute(OID.signingTime, utcTime(now + 365 * 86_400_000))])],
      ['a signing time that is no time', set([contentType, digest, attribute(OID.signingTime, tlv(0x17, Buffer.from('not a time')))])],
      ['an attribute nobody knows', set([contentType, digest, time, attribute(Buffer.from('2a0304', 'hex'), tlv(0x04, Buffer.alloc(4)))])],
      ['the same attribute twice', set([contentType, digest, digest, time])],
      ['bytes after the set', Buffer.concat([set([contentType, digest, time]), Buffer.from([0])])],
      ['a [0] tag instead of a set', Buffer.concat([Buffer.from([0xa0]), set([contentType, digest, time]).subarray(1)])],
      ['a length in more bytes than it needs', (() => {
        const body = Buffer.concat([contentType, digest, time].sort(Buffer.compare));
        return Buffer.concat([Buffer.from([0x31, 0x82, body.length >> 8, body.length & 0xff]), body]);
      })()],
      ['SHA-1', set([contentType, attribute(OID.messageDigest, tlv(0x04, Buffer.alloc(20, 1))), time]), { scheme: 'rsa-pkcs1', hash: 'SHA-1' }],
      ['no scheme', attributes(), null],
    ];
    for (const [name, bytes, scheme] of refusedShapes) {
      await expect(gate.sign(ORIGIN, CERT.id, bytes, scheme === undefined ? SCHEME : scheme, null, null), name).rejects.toThrow(/^keystore:(invalid|unsupported)$/);
    }
    // Out of DER order: a verifier that encodes them again would hash something else.
    const ordered = [contentType, digest, time].sort(Buffer.compare);
    await expect(gate.sign(ORIGIN, CERT.id, set([ordered[2], ordered[0], ordered[1]], false), SCHEME, null, null), 'unsorted').rejects.toThrow(/^keystore:invalid$/);
    expect(asked, 'no question for a call that can not run').toHaveLength(before);
    expect(native.calls).toEqual([]);
  });

  test('the attributes S/MIME really sends pass, with capabilities and a generalized time', async () => {
    const native = helper();
    const { consent } = harness('once');
    const gate = createKeystoreGate(native, consent);
    await gate.list(ORIGIN, null);
    await gate.sign(ORIGIN, CERT.id, attributes({ capabilities: true }), SCHEME, null, null);
    await gate.sign(ORIGIN, CERT.id, attributes({ generalizedTime: true }), SCHEME, null, null);
    expect(native.calls).toEqual(['sign', 'sign']);
  });

  test('an ECDH peer is checked in main: not on the curve means no dialog', async () => {
    const native = helper();
    const { consent, asked } = harness('session');
    const gate = createKeystoreGate(native, consent);
    await gate.list(ORIGIN, null);
    const before = asked.length;
    const offCurve = Buffer.from(PEER);
    offCurve[offCurve.length - 1] ^= 1;
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'der', type: 'spki' });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' });
    for (const [name, peer] of [['off the curve', offCurve], ['another curve', p384], ['RSA', rsa], ['garbage', new Uint8Array(91)], ['not bytes', 'text']] as const) {
      await expect(gate.agree(ORIGIN, CERT.id, peer, null, null), name).rejects.toThrow(/^keystore:invalid$/);
    }
    expect(asked).toHaveLength(before);
    await gate.agree(ORIGIN, CERT.id, PEER, null, null);
    expect(native.calls).toEqual(['agree']);
  });

  test('a Deny through the gate holds for that ciphertext and no other', async () => {
    const native = helper();
    const { consent, asked } = harness(['session', 'deny', 'once', 'deny', 'once']);
    const gate = createKeystoreGate(native, consent);
    await gate.list(ORIGIN, null);
    const stranger = new Uint8Array(256).fill(1);
    await expect(gate.decrypt(ORIGIN, CERT.id, stranger, {}, null, null)).rejects.toThrow(refused);
    await expect(gate.decrypt(ORIGIN, CERT.id, stranger, {}, null, null)).rejects.toThrow(refused);
    expect(asked).toHaveLength(2);
    await gate.decrypt(ORIGIN, CERT.id, new Uint8Array(256).fill(2), {}, null, null);
    expect(asked).toHaveLength(3);
    await expect(gate.agree(ORIGIN, CERT.id, PEER, null, null)).rejects.toThrow(refused);
    await expect(gate.agree(ORIGIN, CERT.id, PEER, null, null)).rejects.toThrow(refused);
    expect(asked, 'the peer key says which message').toHaveLength(4);
  });

  test('quiet comes through the gate', async () => {
    const native = helper();
    const { consent, asked } = harness('session');
    const gate = createKeystoreGate(native, consent);
    await expect(gate.list(ORIGIN, null, { quiet: true })).rejects.toThrow(/^keystore:ask-first$/);
    expect(asked).toEqual([]);
    await gate.list(ORIGIN, null);
    await expect(gate.decrypt(ORIGIN, CERT.id, new Uint8Array(256), {}, null, null, { quiet: true })).rejects.toThrow(/^keystore:ask-first$/);
    await expect(gate.agree(ORIGIN, CERT.id, PEER, null, null, { quiet: true })).rejects.toThrow(/^keystore:ask-first$/);
    expect(native.calls).toEqual([]);
    expect(asked.map((question) => question.kind)).toEqual(['list']);
    await gate.decrypt(ORIGIN, CERT.id, new Uint8Array(256), {}, null, null);
    await gate.decrypt(ORIGIN, CERT.id, new Uint8Array(256).fill(1), {}, null, null, { quiet: true });
    expect(native.calls).toEqual(['decrypt', 'decrypt']);
  });
});
