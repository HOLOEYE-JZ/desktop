/**
 * Who may use the OS keystore, decided in main. The plugin host's checks in the webmail
 * are no boundary: script in a same-origin frame reaches the bridge through `parent`,
 * and main can't tell its calls from the host's (ipc.ts). So every call asks here, by
 * origin, certificate and class of use, and the answer lives in memory.
 *
 * Signing asks every time, and takes only the CMS signed attributes (keystore-signed-attrs.ts).
 * A yes for unwrapping holds until 15 minutes pass without a use, or the screen or the app
 * locks, or the account changes.
 *
 * No Electron in this file: the native dialog and the settings come in as functions, so
 * a plain Node test reaches all of it.
 */

import { createHash, createPublicKey } from 'node:crypto';
import type { NativeCertificate, NativeHelper } from './native-loader';
import { signedAttributesDigest } from './keystore-signed-attrs';

export type KeyUse = 'sign' | 'unwrap';
export type ConsentAnswer = 'session' | 'once' | 'deny';

/** What the dialog has to say. `first-use` is the one question stored across restarts. */
export type ConsentQuestion =
  | { kind: 'first-use'; origin: string }
  | { kind: 'list'; origin: string }
  | { kind: KeyUse; origin: string; certificate: string; issuer: string; notAfter: number; perOperation: boolean; overRate: boolean };

export interface InstanceAccess {
  /** Policy or a stored yes lets this origin use the keystore at all. */
  allowedByPolicy(origin: string): boolean;
  isStored(origin: string): boolean;
  store(origin: string): void;
  forget(origin: string): void;
}

export type AccessState = 'app' | 'policy' | 'stored' | 'off';

export interface ConsentOptions {
  /** The native dialog. Never rejects: a failure to ask is a no. */
  ask: (question: ConsentQuestion, window: unknown) => Promise<ConsentAnswer>;
  /** Null in standalone: the app's own origin needs no first-use question. */
  instance: InstanceAccess | null;
  /** The in-app lock is on. Calls fail with no dialog until it's lifted. */
  locked?: () => boolean;
  /** Policy turned the keystore off. Read at each use, as a policy can change while running. */
  off?: () => boolean;
  now?: () => number;
}

/** What a call can add. */
export interface UseOptions {
  /** Which message this is about, for a Deny that holds for that message alone. */
  message?: string;
  /** Answer from what's already allowed, with `keystore:ask-first` instead of a dialog. */
  quiet?: boolean;
}

/** Above this per class and minute, an unwrap grant asks again. */
export const RATE_CAP_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;
/** An unwrap grant ends after this long without a use. Each use starts it over. */
export const UNWRAP_GRANT_IDLE_MS = 15 * 60_000;
/** The OS's own prompt answered with cancel this often in a row: as good as a Deny. */
export const CANCELS_TO_DENY = 2;
/** A Deny is for one send or one message, so nothing stops a page asking again but this. */
export const DENIES_TO_PAUSE = 3;
export const DENY_PAUSE_MS = 5 * 60_000;
/** Calls waiting on dialogs. Past this they fail at once, so no page can queue up forever. */
export const MAX_WAITING = 16;
/** Messages remembered as refused. They hold a hash each, and a page can make up more. */
const MAX_MESSAGE_REFUSALS = 1024;

function denied(): Error {
  return new Error('keystore:cancelled');
}

function isHttps(origin: string): boolean {
  return origin.startsWith('https://');
}

export class KeystoreConsent {
  /** The list, until a lock, a sign-out or quit. */
  private readonly listGrants = new Set<string>();
  /** Unwrapping, with when it was last used. */
  private readonly unwrapGrants = new Map<string, number>();
  /** The list and first use, until the app quits: a lock clears grants, not refusals. */
  private readonly refusals = new Set<string>();
  /** A message's ciphertext said no to, until the app quits. */
  private readonly messageRefusals = new Set<string>();
  private readonly denials = new Map<string, number>();
  private readonly paused = new Map<string, number>();
  private readonly cancels = new Map<string, number>();
  private readonly uses = new Map<string, number[]>();
  private readonly pending = new Map<string, Promise<ConsentAnswer>>();
  private dialogs: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  /** Goes up each time grants clear: an answer from before that counts for nothing. */
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly options: ConsentOptions) {
    this.now = options.now ?? Date.now;
  }

  /** One dialog on screen at a time, whoever asks. A question the wait made moot isn't shown. */
  private show(question: ConsentQuestion, window: unknown, generation: number, granted: () => boolean): Promise<ConsentAnswer> {
    const shown = this.dialogs
      .then((): ConsentAnswer | Promise<ConsentAnswer> => {
        if (generation !== this.generation) return 'deny';
        if (granted()) return 'session';
        return this.options.ask(question, window);
      })
      .catch((): ConsentAnswer => 'deny');
    this.dialogs = shown;
    return shown;
  }

  /**
   * The answer for a key, sharing a dialog already up for it. A shared 'once' belongs to
   * whoever opened the dialog, so everyone else goes round again.
   */
  private async decide(key: string, question: ConsentQuestion, window: unknown, rules: { granted: () => boolean; refused: () => boolean; onDeny: () => void; onSession?: () => void }): Promise<void> {
    const { granted, refused, onDeny, onSession } = rules;
    if (this.waiting >= MAX_WAITING) throw new Error('keystore:locked');
    this.waiting += 1;
    const generation = this.generation;
    try {
      for (;;) {
        if (generation !== this.generation) throw denied();
        if (refused()) throw denied();
        if (granted()) return;
        const open = this.pending.get(key);
        if (open) {
          if ((await open) === 'deny') throw denied();
          continue;
        }
        const asked = this.show(question, window, generation, granted);
        this.pending.set(key, asked);
        let answer: ConsentAnswer;
        try {
          answer = await asked;
        } finally {
          this.pending.delete(key);
        }
        // Grants were cleared meanwhile: signed out, or locked. Not a yes, and not a no either.
        if (generation !== this.generation) throw denied();
        if (answer === 'deny') {
          onDeny();
          throw denied();
        }
        // Here and not with the caller: a question for another message may be next in line.
        if (answer === 'session') onSession?.();
        return;
      }
    } finally {
      this.waiting -= 1;
    }
  }

  /** Whether the keystore is open at all, for any call, with no dialog if not. */
  private checkOpen(origin: string): void {
    if (this.options.off?.()) {
      // Turning it back on shouldn't bring back what was allowed before.
      this.clearGrants();
      throw new Error('keystore:unsupported');
    }
    if (!isHttps(origin)) throw new Error('keystore:unsupported');
    if (this.options.locked?.()) throw new Error('keystore:locked');
  }

  accessState(origin: string): AccessState {
    if (this.options.off?.() || !isHttps(origin)) return 'off';
    const { instance } = this.options;
    if (!instance) return 'app';
    if (instance.allowedByPolicy(origin)) return 'policy';
    return instance.isStored(origin) ? 'stored' : 'off';
  }

  /** Instance mode is off until policy or a stored yes. Returns whether this call asked. */
  private async ensureEnabled(origin: string, window: unknown, quiet: boolean): Promise<boolean> {
    if (this.accessState(origin) !== 'off') return false;
    const key = `enable|${origin}`;
    if (this.refusals.has(key)) throw denied();
    if (quiet) throw new Error('keystore:ask-first');
    await this.decide(key, { kind: 'first-use', origin }, window, {
      granted: () => this.accessState(origin) !== 'off',
      refused: () => this.refusals.has(key),
      onDeny: () => this.refusals.add(key),
    });
    this.checkOpen(origin);
    if (this.accessState(origin) === 'off') {
      this.options.instance!.store(origin);
      return true;
    }
    return false;
  }

  /** Seeing the list says which certificates someone has, so that takes a grant too. */
  async forList(origin: string, window: unknown, options: UseOptions = {}): Promise<void> {
    this.checkOpen(origin);
    const key = `list|${origin}`;
    // The first-use yes just given covers this session's list: no second dialog in a row.
    if (await this.ensureEnabled(origin, window, options.quiet === true)) this.listGrants.add(key);
    if (this.refusals.has(key)) throw denied();
    if (options.quiet && !this.listGrants.has(key)) throw new Error('keystore:ask-first');
    await this.decide(key, { kind: 'list', origin }, window, {
      granted: () => this.listGrants.has(key),
      refused: () => this.refusals.has(key),
      onDeny: () => this.refusals.add(key),
      onSession: () => this.listGrants.add(key),
    });
    this.checkOpen(origin);
  }

  private overRate(origin: string): boolean {
    const key = `${origin}|unwrap`;
    const since = this.now() - RATE_WINDOW_MS;
    const recent = (this.uses.get(key) ?? []).filter((at) => at > since);
    this.uses.set(key, recent);
    return recent.length >= RATE_CAP_PER_MINUTE;
  }

  private unwrapGranted(key: string, origin: string): boolean {
    const last = this.unwrapGrants.get(key);
    if (last === undefined) return false;
    if (this.now() - last > UNWRAP_GRANT_IDLE_MS) {
      this.unwrapGrants.delete(key);
      return false;
    }
    return !this.overRate(origin);
  }

  private refuseMessage(key: string): void {
    this.messageRefusals.add(key);
    if (this.messageRefusals.size > MAX_MESSAGE_REFUSALS) this.messageRefusals.delete(this.messageRefusals.values().next().value as string);
  }

  /** A no for one send or message. Enough in a row and this key stops asking for a while. */
  private noteDenial(key: string): void {
    const count = (this.denials.get(key) ?? 0) + 1;
    if (count >= DENIES_TO_PAUSE) {
      this.denials.delete(key);
      this.paused.set(key, this.now() + DENY_PAUSE_MS);
    } else {
      this.denials.set(key, count);
    }
  }

  private isPaused(key: string): boolean {
    const until = this.paused.get(key);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.paused.delete(key);
    return false;
  }

  async forUse(origin: string, certificate: { id: string; subject: string; issuer: string; notAfter: number; askEachUse: boolean }, use: KeyUse, window: unknown, options: UseOptions = {}): Promise<void> {
    this.checkOpen(origin);
    await this.ensureEnabled(origin, window, options.quiet === true);
    const key = `${use}|${origin}|${certificate.id}`;
    const messageKey = use === 'unwrap' && options.message ? `${key}|${options.message}` : key;
    const perOperation = certificate.askEachUse;
    const refused = () => this.messageRefusals.has(messageKey) || this.isPaused(key);
    // Signing never has a grant: each send asks.
    const granted = () => use === 'unwrap' && !perOperation && this.unwrapGranted(key, origin);
    if (refused()) throw denied();
    if (options.quiet && !granted()) throw new Error('keystore:ask-first');
    const overRate = use === 'unwrap' && this.overRate(origin);
    const question: ConsentQuestion = { kind: use, origin, certificate: certificate.subject, issuer: certificate.issuer, notAfter: certificate.notAfter, perOperation, overRate };
    const uses = `${origin}|unwrap`;
    await this.decide(messageKey, question, window, {
      granted,
      refused,
      onDeny: () => {
        if (use === 'unwrap') this.refuseMessage(messageKey);
        this.noteDenial(key);
      },
      onSession: () => {
        if (use !== 'unwrap' || perOperation) return;
        // A fresh yes starts the count again, or the next call would ask straight away.
        if (overRate) this.uses.delete(uses);
        this.unwrapGrants.set(key, this.now());
      },
    });
    this.checkOpen(origin);
    this.denials.delete(key);
    if (use === 'sign') return;
    // Each use starts the 15 minutes over.
    if (this.unwrapGrants.has(key)) this.unwrapGrants.set(key, this.now());
    const counted = this.uses.get(uses) ?? [];
    counted.push(this.now());
    this.uses.set(uses, counted);
  }

  /** The OS's PIN prompt said no, or the operation went through. */
  noteOutcome(origin: string, id: string, use: KeyUse, outcome: 'done' | 'cancelled', message?: string): void {
    const key = `${use}|${origin}|${id}`;
    if (outcome === 'done') {
      this.cancels.delete(key);
      return;
    }
    const count = (this.cancels.get(key) ?? 0) + 1;
    this.cancels.set(key, count);
    if (count < CANCELS_TO_DENY) return;
    this.cancels.delete(key);
    // So a loop of PIN dialogs has to come past the consent dialog again.
    this.unwrapGrants.delete(key);
    if (use === 'unwrap' && message) this.refuseMessage(`${key}|${message}`);
    this.noteDenial(key);
  }

  /** Lock, sign-out and revoke. Refusals stay until the app quits, so this can't bring back dialogs. */
  clearGrants(): void {
    this.generation += 1;
    this.listGrants.clear();
    this.unwrapGrants.clear();
  }

  /** Takes back the stored yes and this session's grants. Only ever narrows, so any caller may. */
  revoke(origin: string): void {
    this.options.instance?.forget(origin);
    this.clearGrants();
  }
}

export interface KeystoreGate {
  list(origin: string, window: unknown, options?: UseOptions): Promise<NativeCertificate[]>;
  /** `signedAttributes` is the DER of a CMS message's signed attributes, not a digest. */
  sign(origin: string, id: unknown, signedAttributes: unknown, scheme: unknown, window: unknown, handle: Buffer | null): Promise<Uint8Array>;
  decrypt(origin: string, id: unknown, data: unknown, scheme: unknown, window: unknown, handle: Buffer | null, options?: UseOptions): Promise<Uint8Array>;
  agree(origin: string, id: unknown, peer: unknown, window: unknown, handle: Buffer | null, options?: UseOptions): Promise<Uint8Array>;
}

/** A name for a message that says nothing about it: what's unique to it, hashed. */
function messageName(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

const NODE_CURVE: Record<string, string> = { 'P-256': 'prime256v1', 'P-384': 'secp384r1', 'P-521': 'secp521r1' };

/**
 * Node has the point checked by OpenSSL before anything else sees it. Off the curve is how
 * an invalid-curve attack reads a key, and it shouldn't take a dialog to find out.
 */
function checkPeerKey(peer: unknown, certificate: NativeCertificate): Uint8Array {
  if (!(peer instanceof Uint8Array)) throw new Error('keystore:invalid');
  let curve: string | undefined;
  try {
    const key = createPublicKey({ key: Buffer.from(peer), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec') throw new Error('not EC');
    curve = key.asymmetricKeyDetails?.namedCurve;
  } catch {
    throw new Error('keystore:invalid');
  }
  // The helper says the same. On an RSA certificate there's no curve, and it answers unsupported.
  if (certificate.curve && curve !== NODE_CURVE[certificate.curve]) throw new Error('keystore:invalid');
  return peer;
}

/** Consent in front of the helper: all key use goes through here, none around it. */
export function createKeystoreGate(helper: NativeHelper['keystore'], consent: KeystoreConsent, now: () => number = Date.now): KeystoreGate {
  // What the last list said: the dialog names the certificate, and only those are asked about.
  let known = new Map<string, NativeCertificate>();

  const certificateOf = (id: unknown): NativeCertificate => {
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) throw new Error('keystore:invalid');
    // No question for a call that can't run.
    if (helper.stuck()) throw new Error('keystore:locked');
    const certificate = known.get(id);
    if (!certificate) throw new Error('keystore:not-found');
    return certificate;
  };

  const use = async (origin: string, certificate: NativeCertificate, kind: KeyUse, window: unknown, options: UseOptions, run: () => Promise<Uint8Array>): Promise<Uint8Array> => {
    const { id, subject, issuer, notAfter, askEachUse } = certificate;
    await consent.forUse(origin, { id, subject, issuer, notAfter, askEachUse }, kind, window, options);
    try {
      const answer = await run();
      consent.noteOutcome(origin, id, kind, 'done', options.message);
      return answer;
    } catch (error) {
      if ((error as Error).message === 'keystore:cancelled') consent.noteOutcome(origin, id, kind, 'cancelled', options.message);
      throw error;
    }
  };

  const message = (data: unknown): string => {
    if (!(data instanceof Uint8Array)) throw new Error('keystore:invalid');
    return messageName(data);
  };

  return {
    async list(origin, window, options = {}) {
      await consent.forList(origin, window, { quiet: options.quiet });
      const list = await helper.list();
      known = new Map(list.map((certificate) => [certificate.id, certificate]));
      return list;
    },
    async sign(origin, id, signedAttributes, scheme, window, handle) {
      const certificate = certificateOf(id);
      const digest = signedAttributesDigest(signedAttributes, (scheme as { hash?: unknown } | null | undefined)?.hash, now());
      return use(origin, certificate, 'sign', window, {}, () => helper.sign(id, digest, scheme, handle));
    },
    async decrypt(origin, id, data, scheme, window, handle, options = {}) {
      const certificate = certificateOf(id);
      return use(origin, certificate, 'unwrap', window, { quiet: options.quiet, message: message(data) }, () => helper.decrypt(id, data, scheme, handle));
    },
    async agree(origin, id, peer, window, handle, options = {}) {
      const certificate = certificateOf(id);
      const key = checkPeerKey(peer, certificate);
      return use(origin, certificate, 'unwrap', window, { quiet: options.quiet, message: message(key) }, () => helper.agree(id, peer, handle));
    },
  };
}

/** A policy's list against a page's origin: exact origins, https only, nothing clever. */
export function originInList(list: readonly unknown[], origin: string): boolean {
  return list.some((entry) => {
    if (typeof entry !== 'string') return false;
    try {
      const parsed = new URL(entry);
      return parsed.protocol === 'https:' && parsed.origin === origin;
    } catch {
      return false;
    }
  });
}
