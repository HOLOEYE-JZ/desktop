import { expect, test } from '@playwright/test';
import { CANCELS_TO_DENY, createKeystoreGate, KeystoreConsent, MAX_WAITING, originInList, RATE_CAP_PER_MINUTE, type ConsentAnswer, type ConsentOptions, type ConsentQuestion } from '../src/main/keystore-consent';
import type { NativeCertificate, NativeHelper } from '../src/main/native-loader';

/** The decisions behind the native dialog, with the dialog and the clock as fakes. */

const ORIGIN = 'https://app.bulwark.localhost';
const CERT = { id: 'a'.repeat(64), subject: 'CN=Someone', askEachUse: false };

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
  test('a grant is per origin, per certificate and per class', async () => {
    const { consent, asked } = harness('session');
    await consent.forUse(ORIGIN, CERT, 'sign', null);
    await consent.forUse(ORIGIN, CERT, 'sign', null);
    expect(asked).toHaveLength(1);
    await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    expect(asked, 'another class').toHaveLength(2);
    await consent.forUse(ORIGIN, { ...CERT, id: 'b'.repeat(64) }, 'sign', null);
    expect(asked, 'another certificate').toHaveLength(3);
    await consent.forUse('https://other.example', CERT, 'sign', null);
    expect(asked, 'another origin').toHaveLength(4);
  });

  test('the question names the origin, the certificate and the operation', async () => {
    const { consent, asked } = harness('once');
    await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    expect(asked[0]).toEqual({ kind: 'unwrap', origin: ORIGIN, certificate: 'CN=Someone', perOperation: false, overRate: false });
  });

  test('a Deny for signing leaves unwrapping to its own question', async () => {
    const { consent, asked } = harness(['deny', 'session']);
    await expect(consent.forUse(ORIGIN, CERT, 'sign', null)).rejects.toThrow(refused);
    await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    await expect(consent.forUse(ORIGIN, CERT, 'sign', null)).rejects.toThrow(refused);
    expect(asked).toHaveLength(2);
  });

  test('a certificate that can also sign in asks each time, even after Allow for this session', async () => {
    const { consent, asked } = harness('session');
    const broad = { ...CERT, askEachUse: true };
    await consent.forUse(ORIGIN, broad, 'sign', null);
    await consent.forUse(ORIGIN, broad, 'sign', null);
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

  test('the cap is per class: heavy decrypting does not touch signing', async () => {
    const { consent, asked } = harness('session');
    await consent.forUse(ORIGIN, CERT, 'sign', null);
    for (let use = 0; use < RATE_CAP_PER_MINUTE; use += 1) await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    await consent.forUse(ORIGIN, CERT, 'sign', null);
    expect(asked).toHaveLength(2);
  });

  test('past the cap, Deny stops it for the session', async () => {
    const { consent, asked } = harness(['session', 'deny']);
    for (let use = 0; use < RATE_CAP_PER_MINUTE; use += 1) await consent.forUse(ORIGIN, CERT, 'unwrap', null);
    await expect(consent.forUse(ORIGIN, CERT, 'unwrap', null)).rejects.toThrow(refused);
    await expect(consent.forUse(ORIGIN, CERT, 'unwrap', null)).rejects.toThrow(refused);
    expect(asked).toHaveLength(2);
  });

  test('repeated cancels at the OS prompt stick like a Deny, and a success resets the count', async () => {
    const { consent, asked } = harness('session');
    await consent.forUse(ORIGIN, CERT, 'sign', null);
    consent.noteOutcome(ORIGIN, CERT.id, 'sign', 'cancelled');
    consent.noteOutcome(ORIGIN, CERT.id, 'sign', 'done');
    for (let cancel = 0; cancel < CANCELS_TO_DENY - 1; cancel += 1) consent.noteOutcome(ORIGIN, CERT.id, 'sign', 'cancelled');
    await consent.forUse(ORIGIN, CERT, 'sign', null);
    consent.noteOutcome(ORIGIN, CERT.id, 'sign', 'cancelled');
    await expect(consent.forUse(ORIGIN, CERT, 'sign', null)).rejects.toThrow(refused);
    expect(asked, 'and no dialog about it').toHaveLength(1);
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
    dialog.answers[0]('session');
    await sign;
    await tick();
    expect(dialog.asked).toHaveLength(2);
    dialog.answers[1]('session');
    await unwrap;
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

test.describe('the gate in front of the helper', () => {
  const entry = { id: CERT.id, subject: 'CN=Someone', askEachUse: false } as NativeCertificate;

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
    const { consent } = harness(['session', 'deny', 'deny']);
    const gate = createKeystoreGate(native, consent);
    await gate.list(ORIGIN, null);
    await expect(gate.sign(ORIGIN, CERT.id, new Uint8Array(32), {}, null, null)).rejects.toThrow(refused);
    await expect(gate.decrypt(ORIGIN, CERT.id, new Uint8Array(256), {}, null, null)).rejects.toThrow(refused);
    await expect(gate.agree(ORIGIN, CERT.id, new Uint8Array(91), null, null)).rejects.toThrow(refused);
    expect(native.calls).toEqual([]);
  });

  test('a denied list hands out nothing, and an id without a list asks nobody', async () => {
    const native = helper({ list: () => { throw new Error('reached the store'); } });
    const { consent, asked } = harness('deny');
    const gate = createKeystoreGate(native, consent);
    await expect(gate.list(ORIGIN, null)).rejects.toThrow(refused);
    await expect(gate.sign(ORIGIN, CERT.id, new Uint8Array(32), {}, null, null)).rejects.toThrow(/^keystore:not-found$/);
    expect(asked).toHaveLength(1);
  });

  test('decrypt and agree are one class: unwrap', async () => {
    const native = helper();
    const { consent, asked } = harness('session');
    const gate = createKeystoreGate(native, consent);
    await gate.list(ORIGIN, null);
    await gate.decrypt(ORIGIN, CERT.id, new Uint8Array(256), {}, null, null);
    await gate.agree(ORIGIN, CERT.id, new Uint8Array(91), null, null);
    expect(asked.map((question) => question.kind)).toEqual(['list', 'unwrap']);
    expect(native.calls).toEqual(['decrypt', 'agree']);
  });

  test('while an operation is stuck, calls fail fast and no dialog opens', async () => {
    const native = helper({ stuck: () => true });
    const { consent, asked } = harness('session');
    const gate = createKeystoreGate(native, consent);
    await gate.list(ORIGIN, null);
    const before = asked.length;
    await expect(gate.sign(ORIGIN, CERT.id, new Uint8Array(32), {}, null, null)).rejects.toThrow(/^keystore:locked$/);
    expect(asked).toHaveLength(before);
  });

  test('a bad id is refused with no dialog', async () => {
    const { consent, asked } = harness('session');
    const gate = createKeystoreGate(helper(), consent);
    await expect(gate.sign(ORIGIN, 'nope', new Uint8Array(32), {}, null, null)).rejects.toThrow(/^keystore:invalid$/);
    expect(asked).toEqual([]);
  });

  test('two cancels at the OS prompt end it for the session, without the helper or a dialog', async () => {
    let tries = 0;
    const native = helper({
      sign: () => {
        tries += 1;
        return Promise.reject(new Error('keystore:cancelled'));
      },
    });
    const { consent, asked } = harness('session');
    const gate = createKeystoreGate(native, consent);
    await gate.list(ORIGIN, null);
    for (let attempt = 0; attempt < 4; attempt += 1) await expect(gate.sign(ORIGIN, CERT.id, new Uint8Array(32), {}, null, null)).rejects.toThrow(refused);
    expect(tries).toBe(CANCELS_TO_DENY);
    expect(asked.map((question) => question.kind)).toEqual(['list', 'sign']);
  });
});
