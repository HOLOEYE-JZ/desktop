/**
 * Who gets a client certificate or a Windows sign-in, decided in main. No Electron in this
 * file, so a plain Node test reaches all of it. features/client-certificates.ts plugs it in.
 *
 * What Chromium does, measured on Electron 45 (decisions file, D5):
 * - Left alone, `select-client-certificate` sends the first certificate in the store.
 * - The event names only `host:port`. It doesn't say which request or frame asked, so the
 *   ledger below remembers who has a request open to which host.
 * - An answer, also "none", holds for that host until the network service ends. No session
 *   call clears it. Requests after it send the same certificate with no event, whatever their
 *   frame and credentials mode, so a frame can only be stopped before it connects.
 * - A request that is left unanswered fails when its callback is collected, and leaves no
 *   answer behind. That is what a frame gets: an answer of "none" would stop a real sign-in
 *   at that host later, and mail could name any host.
 * - The integrated sign-in list applies to every frame, and with no list Windows' own zones
 *   decide, which gave `localhost` the user's NTLM without a policy. A 401 can be cancelled
 *   in `onHeadersReceived`, before Chromium answers it.
 */

import { certificateMatchesRule, certificateRuleMatchesUrl, type CertificateFacts, type CertificateRule } from '../shared/policy-schema';

/** A name that can't exist. An empty list would leave the decision to Windows' zones. */
export const NO_INTEGRATED_SIGN_IN = 'bulwark-no-integrated-sign-in.invalid';

/**
 * - `first-party`: a window's own page, or anything asking for the app's own server, which
 *   plugins live on and which already holds the certificate. A credential goes here.
 * - `listed-server`: the app's page asking a mail server the user added, or one a certificate
 *   rule names. A certificate goes here. A Windows sign-in doesn't: no listed use needs one.
 * - `other-page`: a page's own request for some other origin. Nothing goes.
 * - `frame`: a mail frame, a plugin frame, or a frame that's gone. Nothing goes, and no
 *   answer is left behind.
 */
export type Standing = 'first-party' | 'listed-server' | 'other-page' | 'frame';

/** What's needed of `webRequest`'s details. */
export interface RequestFacts {
  url: string;
  resourceType: string;
  webContentsId?: number;
  initiatorOrigin?: string;
  frame?: { parent: unknown; origin: string } | null;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** A WebSocket's origin is its page's http one, for all of this. */
export function targetOrigin(url: string): string | null {
  const parsed = parseUrl(url.replace(/^ws(s?):/i, 'http$1:'));
  return parsed && parsed.origin !== 'null' ? parsed.origin : null;
}

/** As the event spells it: always with a port. */
export function hostPortOf(url: string): string | null {
  const parsed = parseUrl(url.replace(/^ws(s?):/i, 'http$1:'));
  if (!parsed || !parsed.hostname) return null;
  return `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
}

const FETCHES = new Set(['xhr', 'webSocket', 'other']);

/** `inBareWindow`: a blob preview or print pop-up with a document of its own, outside the window manager. */
export function classifyRequest(facts: RequestFacts, ownOrigin: string, isListedServer: (origin: string) => boolean, inBareWindow: () => boolean = () => false): Standing {
  const target = targetOrigin(facts.url);
  if (!target) return 'frame';
  if (target === ownOrigin) return 'first-party';
  if (inBareWindow()) return 'frame';
  // navigation.ts has already said yes to where a window goes.
  if (facts.resourceType === 'mainFrame') return 'first-party';
  if (facts.resourceType === 'subFrame') return 'frame';
  if (!facts.frame) return facts.webContentsId === undefined ? 'other-page' : 'frame';
  if (facts.frame.parent) return 'frame';
  const from = facts.initiatorOrigin ?? facts.frame.origin;
  if (from === target) return 'first-party';
  // What the app itself sends a mail server is a fetch or a WebSocket. An image or a stylesheet
  // on the page's account can be mail: a print pop-up written with `document.write` loads through
  // its opener, so to main it's the main window's top frame asking.
  if (!FETCHES.has(facts.resourceType)) return 'frame';
  return from === ownOrigin && isListedServer(target) ? 'listed-server' : 'other-page';
}

interface OpenRequest {
  hostPort: string;
  standing: Standing;
  claimed: boolean;
}

/** More can't be open in Chromium, and a missed end mustn't grow this for good. */
const MAX_OPEN_REQUESTS = 4096;

/** Who has a request open to which host, in the order they started. */
export class RequestLedger {
  private readonly open = new Map<number, OpenRequest>();

  note(id: number, hostPort: string, standing: Standing): void {
    this.open.delete(id);
    this.open.set(id, { hostPort, standing, claimed: false });
    if (this.open.size > MAX_OPEN_REQUESTS) this.open.delete(this.open.keys().next().value as number);
  }

  finish(id: number): void {
    this.open.delete(id);
  }

  standingOf(id: number): Standing | null {
    return this.open.get(id)?.standing ?? null;
  }

  /**
   * Whose question an event is. Requests ask in the order they started, as far as the event
   * can tell. A second event for a request that was answered (a rejected certificate is tried
   * again) goes to the latest one open. Nobody open: nobody of ours asked.
   */
  claim(hostPort: string): Standing | null {
    let latest: OpenRequest | null = null;
    for (const request of this.open.values()) {
      if (request.hostPort !== hostPort) continue;
      if (!request.claimed) {
        request.claimed = true;
        return request.standing;
      }
      latest = request;
    }
    return latest?.standing ?? null;
  }
}

export interface ChoosableCertificate extends CertificateFacts {
  fingerprint: string;
  subjectName: string;
  issuerName: string;
  validExpiry: number;
}

export interface PickQuestion<C> {
  hostPort: string;
  certificates: C[];
  /** False where only this run's consent is being asked for. */
  rememberable: boolean;
}

export interface PickAnswer<C> {
  certificate: C | null;
  remember: boolean;
}

/** Choices that were remembered, per `host:port`, each under the account it was made in. Backed by the state file. */
export interface RememberedChoices {
  get(hostPort: string): string | undefined;
  set(hostPort: string, fingerprint: string): void;
  clear(): void;
  clearAccount(account: string): void;
}

export interface ChooserOptions<C> {
  rules: () => readonly CertificateRule[];
  choices: RememberedChoices;
  /** The native picker. A failure to ask is a no. It closes when the signal goes. */
  ask: (question: PickQuestion<C>, window: unknown, signal: AbortSignal) => Promise<PickAnswer<C>>;
  /** A mail server the user added: their picker answer or tick is the grant. */
  isUserServer: (hostPort: string) => boolean;
}

export type CertificateDecision<C> = { kind: 'send'; certificate: C } | { kind: 'none' } | { kind: 'leave' };

/** Hosts waiting on a picker. Past this they get no certificate at once. */
export const MAX_WAITING_HOSTS = 16;

export class CertificateChooser<C extends ChoosableCertificate> {
  /** Hosts that may hold a certificate in the network service. Frames stay away from these. */
  private readonly holding = new Set<string>();
  private readonly declined = new Set<string>();
  private readonly open = new Map<string, Promise<PickAnswer<C>>>();
  /** Hosts a wildcard rule named, and the user agreed to, for this run. */
  private readonly consented = new Set<string>();
  private dialogs: Promise<unknown> = Promise.resolve();
  /** Chromium was given an answer it now keeps. */
  private answered = false;
  /** Goes at a sign-out: a question still open then is about someone who has left. */
  private openQuestions = new AbortController();

  constructor(private readonly options: ChooserOptions<C>) {}

  holds(hostPort: string): boolean {
    return this.holding.has(hostPort);
  }

  private show(question: PickQuestion<C>, window: unknown, signal: AbortSignal): Promise<PickAnswer<C>> {
    const none: PickAnswer<C> = { certificate: null, remember: false };
    const shown = this.dialogs.then(() => (signal.aborted ? none : this.options.ask(question, window, signal))).catch(() => none);
    this.dialogs = shown;
    return shown;
  }

  private send(certificate: C): CertificateDecision<C> {
    this.answered = true;
    return { kind: 'send', certificate };
  }

  private refuse(hostPort: string): CertificateDecision<C> {
    this.answered = true;
    this.holding.delete(hostPort);
    return { kind: 'none' };
  }

  async decide(hostPort: string, standing: Standing | null, list: C[], window: unknown): Promise<CertificateDecision<C>> {
    if (standing === 'frame') return { kind: 'leave' };
    if (standing !== 'first-party' && standing !== 'listed-server') {
      // Not a refusal of the host: a later real request shouldn't find one, so nothing is
      // recorded, apart from Chromium's own memory of this "none".
      this.answered = true;
      return { kind: 'none' };
    }
    // From here on a frame's request to this host is stopped, picker or no picker.
    this.holding.add(hostPort);

    const url = `https://${hostPort}`;
    const rules = this.options.rules().filter((rule) => certificateRuleMatchesUrl(rule, url));
    const ruled = list.filter((certificate) => rules.some((rule) => certificateMatchesRule(rule, certificate)));
    // The page's own request, for a host no rule spells out and the user never added: a rule for
    // `[*.]corp.example` shouldn't let script reach every host under it unasked.
    const host = new URL(url).host;
    const needsConsent = standing === 'listed-server' && !this.options.isUserServer(hostPort) && !rules.some((rule) => rule.host === host);
    if (needsConsent && ruled.length === 0 && !this.options.choices.get(hostPort)) return this.refuse(hostPort);
    if (ruled.length === 1 && (!needsConsent || this.consented.has(hostPort))) return this.send(ruled[0]);

    const questions = this.openQuestions;
    const cancelled = new Promise<null>((resolve) => questions.signal.addEventListener('abort', () => resolve(null), { once: true }));

    const stored = this.options.choices.get(hostPort);
    const remembered = stored ? list.find((certificate) => certificate.fingerprint === stored) : undefined;
    if (remembered && (ruled.length === 0 || ruled.includes(remembered))) return this.send(remembered);
    if (this.declined.has(hostPort)) return this.refuse(hostPort);

    let asked = this.open.get(hostPort);
    if (!asked) {
      if (this.open.size >= MAX_WAITING_HOSTS) return this.refuse(hostPort);
      // Several rules can fit and policy can't say which: the user picks among those.
      const certificates = ruled.length > 1 || needsConsent ? ruled : list;
      asked = this.show({ hostPort, certificates, rememberable: !needsConsent }, window, questions.signal).finally(() => {
        if (this.open.get(hostPort) === asked) this.open.delete(hostPort);
      });
      this.open.set(hostPort, asked);
    }
    const answer = await Promise.race([asked, cancelled]);
    // A sign-out came first. No answer goes to Chromium either: it would stay for the next person.
    if (questions.signal.aborted || !answer) return { kind: 'leave' };
    // Requests that waited on the same dialog each hold their own copy of the list.
    const picked = answer.certificate ? list.find((certificate) => certificate.fingerprint === answer.certificate!.fingerprint) : undefined;
    if (!picked) {
      this.declined.add(hostPort);
      return this.refuse(hostPort);
    }
    if (needsConsent) this.consented.add(hostPort);
    else if (answer.remember) this.options.choices.set(hostPort, picked.fingerprint);
    return this.send(picked);
  }

  /** Chromium holds something from this chooser, which only ends with its network service. */
  holdsAnswers(): boolean {
    return this.answered;
  }

  private closeQuestions(): void {
    this.openQuestions.abort();
    this.openQuestions = new AbortController();
    this.open.clear();
    this.dialogs = Promise.resolve();
  }

  /** One account's sign-out, with others still here. What's in Chromium stays: it costs them nothing. */
  forgetAccount(account: string): void {
    this.closeQuestions();
    this.options.choices.clearAccount(account);
  }

  /**
   * The last sign-out, or a wipe. Says whether Chromium still holds answers, which only ends
   * with its network service. Until `networkEmptied`, frames stay kept away.
   */
  forget(): boolean {
    this.closeQuestions();
    this.options.choices.clear();
    this.declined.clear();
    this.consented.clear();
    if (!this.answered) this.holding.clear();
    return this.answered;
  }

  networkEmptied(): void {
    this.answered = false;
    this.holding.clear();
  }
}

function listEntries(list: string | null): string[] {
  return (list ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** The part of a list that may still be used: what's in force and what a policy still says. */
export function narrowedList(inForce: string | null, now: string | null): string | null {
  const wanted = new Set(listEntries(now).map((entry) => entry.toLowerCase()));
  const kept = listEntries(inForce).filter((entry) => wanted.has(entry.toLowerCase()));
  return kept.length > 0 ? kept.join(',') : null;
}

/**
 * Filters for the responses to look at, as wide as the list or wider. Entries come from
 * parseHostList: a host, `*.domain`, maybe with a port, which a filter treats as any port.
 */
export function signInListUrls(list: string | null): string[] {
  return listEntries(list).flatMap((entry) => {
    const host = entry.replace(/:\d+$/, '').toLowerCase();
    // `*://` doesn't take in WebSockets, and their handshake answers a 401 too.
    return [`*://${host}/*`, `ws://${host}/*`, `wss://${host}/*`];
  });
}

/** As wide as Chromium's own reading of the list, or wider. */
export function hostOnSignInList(list: string | null, host: string): boolean {
  const wanted = host.toLowerCase();
  return listEntries(list).some((entry) => {
    const name = entry.replace(/:\d+$/, '').toLowerCase();
    return name.startsWith('*.') ? wanted === name.slice(2) || wanted.endsWith(name.slice(1)) : wanted === name;
  });
}

/** What's needed of Electron's Cookie. */
export interface SessionCookie {
  name: string;
  value: string;
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

/**
 * How to set a cookie back after the network service ended, which takes the ones that live only
 * in its memory. No expiry, so it stays a session cookie. No domain for a host-only one, or it
 * would start covering subdomains and a `__Host-` name would be refused.
 */
export function cookieToSetBack(cookie: SessionCookie): SessionCookie & { url: string } {
  const host = (cookie.domain ?? '').replace(/^\./, '');
  const { hostOnly: _hostOnly, ...rest } = cookie;
  const details: SessionCookie & { url: string } = { ...rest, url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}` };
  if (cookie.hostOnly) delete details.domain;
  return details;
}

/** A 401 that Chromium would answer with the user's Windows sign-in. */
export function asksForWindowsSignIn(statusCode: number, headers: Record<string, string[]> | undefined): boolean {
  if (statusCode !== 401 || !headers) return false;
  for (const [name, values] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'www-authenticate') continue;
    if (values.some((value) => /(^|,)\s*(negotiate|ntlm)\b/i.test(value))) return true;
  }
  return false;
}

/** How many certificates a native dialog can show as rows. */
export const PICKER_PAGE = 6;

export function pickerPages<C>(list: readonly C[], size = PICKER_PAGE): C[][] {
  const pages: C[][] = [];
  for (let at = 0; at < list.length; at += size) pages.push(list.slice(at, at + size));
  return pages;
}

/** Names come from whoever issued the certificate: no line breaks, no direction tricks. */
export function cleanName(name: string): string {
  const clean = name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

/** `:443` says nothing to a person. */
export function displayHost(hostPort: string): string {
  return hostPort.replace(/:443$/, '');
}

/** A row of the picker. Windows shows what follows a line break smaller, below the name. */
export function certificateRow(certificate: ChoosableCertificate, details: (issuer: string, date: string) => string, locale: string, platform: NodeJS.Platform): string {
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(certificate.validExpiry * 1000));
  const name = cleanName(certificate.subjectName) || certificate.fingerprint.slice(0, 24);
  const line = details(cleanName(certificate.issuerName), date);
  return platform === 'win32' ? `${name}\n${line}` : `${name} (${line})`;
}
