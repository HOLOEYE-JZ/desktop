/**
 * The OS keystore on the bridge. All key use passes KeystoreConsent here, in main,
 * because the webmail's plugin gates are no boundary: a privileged plugin's frame is
 * same-origin, reaches parent.bulwarkDesktop.keystore, and its calls look like the
 * main frame's. The user answers a native dialog that names the origin, the certificate
 * and the operation, and the OS's own prompts stay on after that.
 *
 * On an instance it's off until a policy names the origin or the user says yes once.
 *
 * Answers carry the code as data: an error thrown through ipcMain.handle arrives with
 * Electron's wording around it. "Not allowed" from createChannels isn't caught: that's
 * senderAllowed refusing a frame, before anything here runs.
 */

import { BrowserWindow, dialog, powerMonitor, type IpcMainInvokeEvent } from 'electron';
import { CHANNEL, type KeystoreResult } from '../../shared/bridge';
import { createKeystoreGate, KeystoreConsent, originInList, type ConsentAnswer, type ConsentQuestion, type InstanceAccess } from '../keystore-consent';
import { native } from '../native';
import { keystoreErrorCode } from '../native-loader';
import type { StateFile } from '../state';
import { strings } from '../strings';
import type { Feature } from './index';

/**
 * KeystoreAllowedOrigins from OS policy. feat/policies calls this once its schema has the
 * key (lib/desktop/policy-schema.ts). Until then nothing is allowed by policy.
 */
let allowedByPolicy: () => readonly unknown[] = () => [];

export function setKeystoreAllowedOrigins(read: () => readonly unknown[]): void {
  allowedByPolicy = read;
}

async function answer<T>(run: () => Promise<T>): Promise<KeystoreResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, code: keystoreErrorCode(error) };
  }
}

/** So a card's PIN dialog opens on top of the window that asked. */
function handleOf(window: BrowserWindow | null): Buffer | null {
  return window && !window.isDestroyed() ? window.getNativeWindowHandle() : null;
}

function originOf(event: IpcMainInvokeEvent): string {
  // createChannels has checked it: a main frame on the app's origin.
  return new URL(event.senderFrame!.url).origin;
}

/** The native question. Deny is the default and what closing the dialog means. */
async function askInDialog(question: ConsentQuestion, window: unknown): Promise<ConsentAnswer> {
  const text = strings();
  const host = new URL(question.origin).host;
  let message: string;
  let detail: string;
  let answers: ConsentAnswer[];
  let buttons: string[];
  if (question.kind === 'first-use') {
    message = text.keystoreFirstUseTitle(host);
    detail = text.keystoreFirstUseDetail(host);
    answers = ['session', 'deny'];
    buttons = [text.allow, text.keystoreDeny];
  } else if (question.kind === 'list') {
    message = text.keystoreListTitle(host);
    detail = text.keystoreListDetail;
    answers = ['session', 'once', 'deny'];
    buttons = [text.keystoreAllowSession, text.keystoreAllowOnce, text.keystoreDeny];
  } else {
    message = question.kind === 'sign' ? text.keystoreSignTitle(host) : text.keystoreUnwrapTitle(host);
    detail = [
      text.keystoreCertificate(question.certificate),
      question.kind === 'sign' ? text.keystoreSignDetail : text.keystoreUnwrapDetail,
      ...(question.overRate ? [text.keystoreOverRate] : []),
      ...(question.perOperation ? [text.keystorePerOperation] : []),
    ].join('\n\n');
    answers = question.perOperation ? ['once', 'deny'] : ['session', 'once', 'deny'];
    buttons = question.perOperation ? [text.keystoreAllowOnce, text.keystoreDeny] : [text.keystoreAllowSession, text.keystoreAllowOnce, text.keystoreDeny];
  }
  const deny = answers.indexOf('deny');
  const options = { type: 'question' as const, message, detail, buttons, defaultId: deny, cancelId: deny, noLink: true };
  const parent = window instanceof BrowserWindow && !window.isDestroyed() ? window : null;
  const { response } = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
  return answers[response] ?? 'deny';
}

function instanceAccess(state: StateFile): InstanceAccess {
  const stored = () => state.data.keystoreOrigins ?? [];
  return {
    allowedByPolicy: (origin) => originInList(allowedByPolicy(), origin),
    isStored: (origin) => stored().includes(origin),
    store: (origin) => {
      state.data.keystoreOrigins = [...stored(), origin];
      state.touch();
    },
    forget: (origin) => {
      state.data.keystoreOrigins = stored().filter((entry) => entry !== origin);
      state.touch();
    },
  };
}

export const keystoreFeature: Feature = {
  name: 'keystore',
  modes: ['standalone', 'instance'],
  setup(ctx) {
    const { keystore } = native();
    if (!keystore.available) return;
    const consent = new KeystoreConsent({
      ask: askInDialog,
      instance: ctx.mode === 'instance' ? instanceAccess(ctx.state) : null,
    });
    const gate = createKeystoreGate(keystore, consent);
    powerMonitor.on('lock-screen', () => consent.clearGrants());

    ctx.handle(CHANNEL.keystoreList, (event, window) => answer(() => gate.list(originOf(event), window)));
    ctx.handle(CHANNEL.keystoreSign, (event, window, id, digest, scheme) => answer(() => gate.sign(originOf(event), id, digest, scheme, window, handleOf(window))));
    ctx.handle(CHANNEL.keystoreDecrypt, (event, window, id, data, scheme) => answer(() => gate.decrypt(originOf(event), id, data, scheme, window, handleOf(window))));
    ctx.handle(CHANNEL.keystoreAgree, (event, window, id, peer) => answer(() => gate.agree(originOf(event), id, peer, window, handleOf(window))));
    ctx.handle(CHANNEL.keystoreAccess, (event) => consent.accessState(originOf(event)));
    ctx.handle(CHANNEL.keystoreRevoke, (event) => consent.revoke(originOf(event)));
    // At sign-out and account switch, so the next account gets asked. Only narrows: refusals
    // and an instance's stored yes stay, so any page may call it and none gains by it.
    ctx.handle(CHANNEL.keystoreClearGrants, () => consent.clearGrants());
  },
};
