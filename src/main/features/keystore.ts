/**
 * The OS keystore on the bridge, for the webmail's plugin host. A privileged plugin's
 * frame is same-origin and can call parent.bulwarkDesktop.keystore itself, and those
 * calls look like the main frame's, so nothing here can tell it from the host. That's
 * why the member is this narrow: list, sign a digest, unwrap a key, agree. The key
 * never leaves the OS, only certificates fit for mail are reachable (the helper), and
 * the OS's own prompts stay on. Hello and the forced-policy check aren't on the bridge.
 *
 * Answers carry the code as data: an error thrown through ipcMain.handle arrives with
 * Electron's wording around it.
 */

import type { BrowserWindow } from 'electron';
import { CHANNEL, type KeystoreResult } from '../../shared/bridge';
import { native } from '../native';
import { keystoreErrorCode } from '../native-loader';
import type { Feature } from './index';

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

export const keystoreFeature: Feature = {
  name: 'keystore',
  modes: ['standalone', 'instance'],
  setup(ctx) {
    const { keystore } = native();
    if (!keystore.available) return;
    ctx.handle(CHANNEL.keystoreList, () => answer(() => keystore.list()));
    ctx.handle(CHANNEL.keystoreSign, (_event, window, id, digest, scheme) => answer(() => keystore.sign(id, digest, scheme, handleOf(window))));
    ctx.handle(CHANNEL.keystoreDecrypt, (_event, window, id, data, scheme) => answer(() => keystore.decrypt(id, data, scheme, handleOf(window))));
    ctx.handle(CHANNEL.keystoreAgree, (_event, window, id, peer) => answer(() => keystore.agree(id, peer, handleOf(window))));
  },
};
