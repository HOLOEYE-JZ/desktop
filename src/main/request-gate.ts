/**
 * The one `session.webRequest.onBeforeRequest` of a session. Electron keeps a single
 * listener per event and session, and a second call silently replaces the first, so
 * every rule that cancels requests goes through here.
 */

import type { Session } from 'electron';

export type RequestRule = (url: string) => boolean;

export class RequestGate {
  private readonly rules = new Set<RequestRule>();

  constructor(session: Session) {
    session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      callback({ cancel: this.refuses(details.url) });
    });
  }

  add(rule: RequestRule): () => void {
    this.rules.add(rule);
    return () => this.rules.delete(rule);
  }

  refuses(url: string): boolean {
    for (const rule of this.rules) if (rule(url)) return true;
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
