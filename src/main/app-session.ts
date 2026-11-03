/**
 * The app session, `persist:bulwark`: trusts the embedded server's certificate by
 * fingerprint, and adds the launch secret to its requests. Every other host goes
 * through normal verification.
 */

import { session as electronSession, type Session } from 'electron';
import { APP_HOST, LAUNCH_HEADER } from '../server/protocol';

export const APP_PARTITION = 'persist:bulwark';

/** What Chromium's verify proc takes: 0 is accepted, -2 refused, -3 "do your own check". */
const VERIFY_OK = 0;
const VERIFY_FAILED = -2;
const VERIFY_DEFAULT = -3;

export function setupAppSession(fingerprint: string, launchSecret: string, onPinFailure: () => void): Session {
  const session = electronSession.fromPartition(APP_PARTITION);
  session.setCertificateVerifyProc((request, callback) => {
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
  });
  session.webRequest.onBeforeSendHeaders({ urls: [`https://${APP_HOST}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, [LAUNCH_HEADER]: launchSecret } });
  });
  return session;
}

export function instancePartition(origin: string): string {
  // One session per instance, so instances don't share cookies or storage.
  return `persist:instance-${Buffer.from(origin).toString('base64url')}`;
}
