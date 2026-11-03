/**
 * Who may use the OS keystore, decided in main. The plugin host's checks in the webmail
 * are no boundary: script in a same-origin frame reaches the bridge through `parent`,
 * and main can't tell its calls from the host's (ipc.ts). So every call asks here, by
 * origin, certificate and class of use, and the answer lives in memory.
 *
 * No Electron in this file: the native dialog and the settings come in as functions, so
 * a plain Node test reaches all of it.
 */

import type { NativeCertificate, NativeHelper } from './native-loader';

export type KeyUse = 'sign' | 'unwrap';
export type ConsentAnswer = 'session' | 'once' | 'deny';

/** What the dialog has to say. `first-use` is the one question stored across restarts. */
export type ConsentQuestion =
  | { kind: 'first-use'; origin: string }
  | { kind: 'list'; origin: string }
  | { kind: KeyUse; origin: string; certificate: string; perOperation: boolean; overRate: boolean };

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
  now?: () => number;
}

/** Above this per class and minute, a session grant asks again. */
export const RATE_CAP_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;
/** The OS's own prompt answered with cancel this often in a row: as good as a Deny. */
export const CANCELS_TO_DENY = 2;
/** Calls waiting on dialogs. Past this they fail at once, so no page can queue up forever. */
export const MAX_WAITING = 16;

function denied(): Error {
  return new Error('keystore:cancelled');
}

export class KeystoreConsent {
  private readonly grants = new Set<string>();
  /** Until the app quits: a lock clears grants, not refusals. */
  private readonly refusals = new Set<string>();
  private readonly cancels = new Map<string, number>();
  private readonly uses = new Map<string, number[]>();
  private readonly pending = new Map<string, Promise<ConsentAnswer>>();
  private dialogs: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private readonly now: () => number;

  constructor(private readonly options: ConsentOptions) {
    this.now = options.now ?? Date.now;
  }

  /** One dialog on screen at a time, whoever asks. */
  private show(question: ConsentQuestion, window: unknown): Promise<ConsentAnswer> {
    const shown = this.dialogs.then(() => this.options.ask(question, window)).catch((): ConsentAnswer => 'deny');
    this.dialogs = shown;
    return shown;
  }

  /**
   * The answer for a key, sharing a dialog already up for it. A shared 'once' belongs to
   * whoever opened the dialog, so everyone else goes round again.
   */
  private async decide(key: string, question: ConsentQuestion, window: unknown, granted: () => boolean): Promise<'session' | 'once'> {
    if (this.waiting >= MAX_WAITING) throw new Error('keystore:locked');
    this.waiting += 1;
    try {
      for (;;) {
        if (this.refusals.has(key)) throw denied();
        if (granted()) return 'session';
        const open = this.pending.get(key);
        if (open) {
          if ((await open) === 'deny') throw denied();
          continue;
        }
        const asked = this.show(question, window);
        this.pending.set(key, asked);
        let answer: ConsentAnswer;
        try {
          answer = await asked;
        } finally {
          this.pending.delete(key);
        }
        if (answer === 'deny') {
          this.refusals.add(key);
          throw denied();
        }
        return answer;
      }
    } finally {
      this.waiting -= 1;
    }
  }

  accessState(origin: string): AccessState {
    const { instance } = this.options;
    if (!instance) return 'app';
    if (instance.allowedByPolicy(origin)) return 'policy';
    return instance.isStored(origin) ? 'stored' : 'off';
  }

  /** Instance mode is off until policy or a stored yes. Returns whether this call asked. */
  private async ensureEnabled(origin: string, window: unknown): Promise<boolean> {
    if (this.accessState(origin) !== 'off') return false;
    const key = `enable|${origin}`;
    await this.decide(key, { kind: 'first-use', origin }, window, () => this.accessState(origin) !== 'off');
    if (this.accessState(origin) === 'off') {
      this.options.instance!.store(origin);
      return true;
    }
    return false;
  }

  /** Seeing the list says which certificates someone has, so that takes a grant too. */
  async forList(origin: string, window: unknown): Promise<void> {
    const key = `list|${origin}`;
    // The first-use yes just given covers this session's list: no second dialog in a row.
    if (await this.ensureEnabled(origin, window)) this.grants.add(key);
    const answer = await this.decide(key, { kind: 'list', origin }, window, () => this.grants.has(key));
    if (answer === 'session') this.grants.add(key);
  }

  private overRate(origin: string, use: KeyUse): boolean {
    const key = `${origin}|${use}`;
    const since = this.now() - RATE_WINDOW_MS;
    const recent = (this.uses.get(key) ?? []).filter((at) => at > since);
    this.uses.set(key, recent);
    return recent.length >= RATE_CAP_PER_MINUTE;
  }

  async forUse(origin: string, certificate: { id: string; subject: string; askEachUse: boolean }, use: KeyUse, window: unknown): Promise<void> {
    await this.ensureEnabled(origin, window);
    const key = `${use}|${origin}|${certificate.id}`;
    const perOperation = certificate.askEachUse;
    const overRate = () => this.overRate(origin, use);
    const question: ConsentQuestion = { kind: use, origin, certificate: certificate.subject, perOperation, overRate: overRate() };
    const answer = await this.decide(key, question, window, () => this.grants.has(key) && !overRate());
    if (answer === 'session' && !perOperation) {
      // A fresh yes starts the count again, or the next call would ask straight away.
      if (question.overRate) this.uses.delete(`${origin}|${use}`);
      this.grants.add(key);
    }
    const counted = this.uses.get(`${origin}|${use}`) ?? [];
    counted.push(this.now());
    this.uses.set(`${origin}|${use}`, counted);
  }

  /** The OS's PIN prompt said no, or the operation went through. */
  noteOutcome(origin: string, id: string, use: KeyUse, outcome: 'done' | 'cancelled'): void {
    const key = `${use}|${origin}|${id}`;
    if (outcome === 'done') {
      this.cancels.delete(key);
      return;
    }
    const count = (this.cancels.get(key) ?? 0) + 1;
    this.cancels.set(key, count);
    if (count >= CANCELS_TO_DENY) {
      this.refusals.add(key);
      this.grants.delete(key);
    }
  }

  /** Screen lock and revoke. Refusals stay until the app quits, so this can't bring back dialogs. */
  clearGrants(): void {
    this.grants.clear();
  }

  /** Takes back the stored yes and this session's grants. Only ever narrows, so any caller may. */
  revoke(origin: string): void {
    this.options.instance?.forget(origin);
    this.clearGrants();
  }
}

export interface KeystoreGate {
  list(origin: string, window: unknown): Promise<NativeCertificate[]>;
  sign(origin: string, id: unknown, digest: unknown, scheme: unknown, window: unknown, handle: Buffer | null): Promise<Uint8Array>;
  decrypt(origin: string, id: unknown, data: unknown, scheme: unknown, window: unknown, handle: Buffer | null): Promise<Uint8Array>;
  agree(origin: string, id: unknown, peer: unknown, window: unknown, handle: Buffer | null): Promise<Uint8Array>;
}

/** Consent in front of the helper: all key use goes through here, none around it. */
export function createKeystoreGate(helper: NativeHelper['keystore'], consent: KeystoreConsent): KeystoreGate {
  // What the last list said: the dialog names the certificate, and only those are asked about.
  let known = new Map<string, NativeCertificate>();

  const use = async (origin: string, id: unknown, kind: KeyUse, window: unknown, run: () => Promise<Uint8Array>): Promise<Uint8Array> => {
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) throw new Error('keystore:invalid');
    // No question for a call that can't run.
    if (helper.stuck()) throw new Error('keystore:locked');
    const certificate = known.get(id);
    if (!certificate) throw new Error('keystore:not-found');
    await consent.forUse(origin, { id, subject: certificate.subject, askEachUse: certificate.askEachUse }, kind, window);
    try {
      const answer = await run();
      consent.noteOutcome(origin, id, kind, 'done');
      return answer;
    } catch (error) {
      if ((error as Error).message === 'keystore:cancelled') consent.noteOutcome(origin, id, kind, 'cancelled');
      throw error;
    }
  };

  return {
    async list(origin, window) {
      await consent.forList(origin, window);
      const list = await helper.list();
      known = new Map(list.map((certificate) => [certificate.id, certificate]));
      return list;
    },
    sign: (origin, id, digest, scheme, window, handle) => use(origin, id, 'sign', window, () => helper.sign(id, digest, scheme, handle)),
    decrypt: (origin, id, data, scheme, window, handle) => use(origin, id, 'unwrap', window, () => helper.decrypt(id, data, scheme, handle)),
    agree: (origin, id, peer, window, handle) => use(origin, id, 'unwrap', window, () => helper.agree(id, peer, handle)),
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
