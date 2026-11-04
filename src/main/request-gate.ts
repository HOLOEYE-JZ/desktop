/**
 * The one `onBeforeRequest` and the one `onHeadersReceived` of a session. Electron keeps a
 * single listener per event and session, and a second call silently replaces the first, so
 * every rule that cancels or rewrites goes through here.
 */

import type { HeadersReceivedResponse, OnBeforeRequestListenerDetails, OnHeadersReceivedListenerDetails, Session } from 'electron';

export type RequestRule = (url: string, details: OnBeforeRequestListenerDetails) => boolean;

/** `*://` doesn't take in WebSockets. */
const EVERY_REQUEST = ['*://*/*', 'ws://*/*', 'wss://*/*'];

export class RequestGate {
  private readonly rules = new Set<RequestRule>();
  private readonly endListeners = new Set<(id: number, redirected: boolean) => void>();
  private refusing = false;

  constructor(session: Session) {
    session.webRequest.onBeforeRequest({ urls: EVERY_REQUEST }, (details, callback) => {
      callback({ cancel: this.refusing || this.refuses(details.url, details) });
    });
    const ended = (redirected: boolean) => (details: { id: number }) => {
      for (const listener of this.endListeners) listener(details.id, redirected);
    };
    session.webRequest.onCompleted({ urls: EVERY_REQUEST }, ended(false));
    session.webRequest.onErrorOccurred({ urls: EVERY_REQUEST }, ended(false));
    session.webRequest.onBeforeRedirect({ urls: EVERY_REQUEST }, ended(true));
  }

  add(rule: RequestRule): () => void {
    this.rules.add(rule);
    return () => this.rules.delete(rule);
  }

  /**
   * Every request fails at once until this settles. Holding them isn't possible while the network
   * service is replaced: one let through later still goes to the old one, and never settles.
   */
  refuseUntil(until: Promise<unknown>): void {
    this.refusing = true;
    void until.catch(() => {}).finally(() => {
      this.refusing = false;
    });
  }

  /** A request ended, or left for another address. */
  onEnded(listener: (id: number, redirected: boolean) => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  refuses(url: string, details: OnBeforeRequestListenerDetails): boolean {
    for (const rule of this.rules) if (rule(url, details)) return true;
    return false;
  }
}

const gates = new WeakMap<Session, RequestGate>();

export function requestGate(session: Session): RequestGate {
  let gate = gates.get(session);
  if (!gate) {
    gate = new RequestGate(session);
    gates.set(session, gate);
  }
  return gate;
}

/** What a part makes of a response. Null: not its business. */
export type ResponsePart = (details: OnHeadersReceivedListenerDetails) => HeadersReceivedResponse | null;

/**
 * A part names the addresses it wants to see, so other traffic never passes through main.
 * It also sees what another part asked for, and checks the address itself. A cancel beats
 * everything else, and otherwise the first answer counts.
 */
export class ResponseGate {
  private readonly parts = new Map<string, { urls: readonly string[]; run: ResponsePart }>();

  constructor(private readonly session: Session) {}

  set(name: string, urls: readonly string[], run: ResponsePart): void {
    if (urls.length === 0) this.parts.delete(name);
    else this.parts.set(name, { urls, run });
    this.install();
  }

  /** Whether Electron takes this filter. It throws on one it doesn't, and the listener goes with it. */
  accepts(url: string): boolean {
    try {
      this.session.webRequest.onHeadersReceived({ urls: [url] }, null as never);
      return true;
    } catch {
      return false;
    } finally {
      this.install();
    }
  }

  private install(): void {
    const urls = [...new Set([...this.parts.values()].flatMap((part) => part.urls))];
    if (urls.length === 0) {
      this.session.webRequest.onHeadersReceived(null);
      return;
    }
    this.session.webRequest.onHeadersReceived({ urls }, (details, callback) => {
      let first: HeadersReceivedResponse | null = null;
      for (const part of this.parts.values()) {
        const answer = part.run(details);
        if (answer?.cancel) {
          callback(answer);
          return;
        }
        first ??= answer;
      }
      callback(first ?? {});
    });
  }
}

const responseGates = new WeakMap<Session, ResponseGate>();

export function responseGate(session: Session): ResponseGate {
  let gate = responseGates.get(session);
  if (!gate) {
    gate = new ResponseGate(session);
    responseGates.set(session, gate);
  }
  return gate;
}
