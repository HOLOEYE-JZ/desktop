/**
 * The app session, `persist:bulwark`: trusts the embedded server's certificate by
 * fingerprint, and adds the launch secret to its requests. Every other host goes
 * through normal verification.
 */

import { app, session as electronSession, type Session } from 'electron';
import { APP_HOST, LAUNCH_HEADER } from '../server/protocol';
import { closeDictionaryDownloads } from './spellcheck';

export const APP_PARTITION = 'persist:bulwark';

/** What Chromium's verify proc takes: 0 is accepted, -2 refused, -3 "do your own check". */
const VERIFY_OK = 0;
const VERIFY_FAILED = -2;
const VERIFY_DEFAULT = -3;

const verifyProcs = new WeakMap<Session, Parameters<Session['setCertificateVerifyProc']>[0]>();

/** A new network service doesn't get the pin by itself. Nothing to do where there is none. */
export function setPinAgain(session: Session): void {
  const verify = verifyProcs.get(session);
  if (verify) session.setCertificateVerifyProc(verify);
}

export function setupAppSession(fingerprint: string, launchSecret: string, onPinFailure: () => void): Session {
  const session = electronSession.fromPartition(APP_PARTITION);
  closeDictionaryDownloads(session);
  const verify: Parameters<Session['setCertificateVerifyProc']>[0] = (request, callback) => {
    if (request.hostname !== APP_HOST) {
      callback(VERIFY_DEFAULT);
      return;
    }
    if (request.certificate.fingerprint === fingerprint) {
      callback(VERIFY_OK);
      return;
    }
    onPinFailure();
    callback(VERIFY_FAILED);
  };
  verifyProcs.set(session, verify);
  session.setCertificateVerifyProc(verify);
  // A new network service doesn't get it back by itself, and then nothing from the app's own
  // server is accepted. It comes after a crash, and after features/client-certificates.ts ends one.
  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'Utility' || !details.serviceName?.includes('network')) return;
    session.setCertificateVerifyProc(verify);
    // Set while there is no service yet, it can be lost too. One request caught in between
    // may hang, as the page's fetch timeouts allow for.
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const back = app.getAppMetrics().some((metric) => metric.type === 'Utility' && metric.serviceName?.includes('network'));
      if (!back && tries < 100) return;
      clearInterval(timer);
      session.setCertificateVerifyProc(verify);
    }, 100);
    timer.unref();
  });
  session.webRequest.onBeforeSendHeaders({ urls: [`https://${APP_HOST}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, [LAUNCH_HEADER]: launchSecret } });
  });
  return session;
}

/**
 * Chromium writes cookies every 30 seconds and local storage every few, so a crash in that time
 * loses a sign-in that looked done. A sign-in is a cookie change, and those are few.
 */
export function keepSignInsOnDisk(session: Session): void {
  let timer: NodeJS.Timeout | null = null;
  session.cookies.on('changed', () => {
    timer ??= setTimeout(() => {
      timer = null;
      session.flushStorageData();
      session.cookies.flushStore().catch(() => {});
    }, 200);
  });
}

export function instancePartition(origin: string): string {
  // One session per instance, so instances don't share cookies or storage.
  return `persist:instance-${Buffer.from(origin).toString('base64url')}`;
}
