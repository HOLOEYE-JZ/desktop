/**
 * The OS keystore on the bridge. All key use passes KeystoreConsent here, in main,
 * because the webmail's plugin gates are no boundary: a privileged plugin's frame is
 * same-origin, reaches parent.bulwarkDesktop.keystore, and its calls look like the
 * main frame's. The user answers a native dialog that names the origin, the certificate
 * and the operation, and the OS's own prompts stay on after that. Signing asks each time,
 * and the page gives the CMS signed attributes, which main checks and hashes itself.
 *
 * On an instance it's off until a policy names the origin or the user says yes once.
 *
 * Answers carry the code as data: an error thrown through ipcMain.handle arrives with
 * Electron's wording around it. "Not allowed" from createChannels isn't caught: that's
 * senderAllowed refusing a frame, before anything here runs.
 */

import { BrowserWindow, dialog, powerMonitor, type IpcMainInvokeEvent } from 'electron';
import { CHANNEL, type KeystoreResult } from '../../shared/bridge';
import { appLockGate } from '../app-lock-gate';
import { createKeystoreGate, KeystoreConsent, originInList, type ConsentAnswer, type ConsentQuestion, type InstanceAccess, type UseOptions } from '../keystore-consent';
import { keystoreDialog } from '../keystore-dialog';
import { keystoreOffByPolicy, onKeystorePolicyChanged } from '../keystore-policy';
import { keystoreTextFor } from '../keystore-strings';
import { native } from '../native';
import { keystoreErrorCode } from '../native-loader';
import type { StateFile } from '../state';
import { uiLanguageNow } from '../strings';
import type { Feature } from './index';

/** KeystoreAllowedOrigins from OS policy, read at each use. Set by features/policies.ts. */
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

/** Only `quiet: true` counts: this comes from the page. */
function useOptions(raw: unknown): UseOptions {
  return { quiet: (raw as { quiet?: unknown } | null | undefined)?.quiet === true };
}

/** The native question. Deny is the default and what closing the dialog means. */
async function askInDialog(question: ConsentQuestion, window: unknown, standalone: boolean): Promise<ConsentAnswer> {
  const language = uiLanguageNow();
  const { message, detail, buttons, answers } = keystoreDialog(question, keystoreTextFor(language), standalone, language);
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
    const standalone = ctx.mode !== 'instance';
    const consent = new KeystoreConsent({
      ask: (question, window) => askInDialog(question, window, standalone),
      instance: standalone ? null : instanceAccess(ctx.state),
      // Refused while locked, and the lock takes what was allowed before it.
      locked: () => appLockGate.locked,
      off: keystoreOffByPolicy,
    });
    const gate = createKeystoreGate(keystore, consent);
    powerMonitor.on('lock-screen', () => consent.clearGrants());
    appLockGate.on('locked', (locked) => {
      if (locked) consent.clearGrants();
    });
    onKeystorePolicyChanged(() => {
      if (keystoreOffByPolicy()) consent.clearGrants();
    });

    ctx.handle(CHANNEL.keystoreList, (event, window, options) => answer(() => gate.list(originOf(event), window, useOptions(options))));
    ctx.handle(CHANNEL.keystoreSign, (event, window, id, signedAttributes, scheme) => answer(() => gate.sign(originOf(event), id, signedAttributes, scheme, window, handleOf(window))));
    ctx.handle(CHANNEL.keystoreDecrypt, (event, window, id, data, scheme, options) => answer(() => gate.decrypt(originOf(event), id, data, scheme, window, handleOf(window), useOptions(options))));
    ctx.handle(CHANNEL.keystoreAgree, (event, window, id, peer, options) => answer(() => gate.agree(originOf(event), id, peer, window, handleOf(window), useOptions(options))));
    ctx.handle(CHANNEL.keystoreAccess, (event) => consent.accessState(originOf(event)));
    ctx.handle(CHANNEL.keystoreRevoke, (event) => consent.revoke(originOf(event)));
    // At sign-out and account switch, so the next account gets asked. Only narrows: refusals
    // and an instance's stored yes stay, so any page may call it and none gains by it.
    ctx.handle(CHANNEL.keystoreClearGrants, () => consent.clearGrants());
  },
};
