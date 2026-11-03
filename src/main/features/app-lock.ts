/**
 * App lock's shell side: the gate (app-lock-gate.ts), the screen lock, "Lock now" in the
 * menu, window titles, and Windows Hello and Touch ID.
 *
 * Windows Hello answers yes or no, and that can't wrap a key. So the lock key sits in
 * safeStorage, and main reads it only after the yes. That stops someone at the keyboard
 * of an unlocked Windows session who doesn't know the PIN. It doesn't stop a program
 * running as this user, which can ask DPAPI itself without any prompt. The settings page
 * says so. The PIN stays either way, since Hello being available doesn't mean the user
 * knows its PIN. Linux has neither prompt, so it's PIN only there.
 */

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, powerMonitor, systemPreferences } from 'electron';
import { CHANNEL, type AppLockStatus, type OsUnlockAnswer, type OsUnlockKind } from '../../shared/bridge';
import { appLockGate } from '../app-lock-gate';
import { native } from '../native';
import { SecretStore } from '../secrets';
import { strings } from '../strings';
import type { Feature, FeatureContext } from '.';

const OS_KEY_NAME = 'app-lock-key';
const OS_PROMPT_MS = 60_000;

type Verifier = (window: BrowserWindow | null, reason: string) => Promise<'yes' | 'no' | 'unavailable'>;

function osKindNow(): Promise<OsUnlockKind | null> | OsUnlockKind | null {
  // Tests name what the check does, so no real prompt comes up on anyone's desktop.
  if (!app.isPackaged && process.env.BULWARK_TEST_OS_VERIFY) return 'hello';
  if (process.platform === 'win32') return native().hello.available().then((available) => (available ? 'hello' : null));
  if (process.platform === 'darwin') return systemPreferences.canPromptTouchID() ? 'touchid' : null;
  return null;
}

const verifyWithOs: Verifier = async (window, reason) => {
  if (!app.isPackaged && process.env.BULWARK_TEST_OS_VERIFY) {
    return process.env.BULWARK_TEST_OS_VERIFY === 'yes' ? 'yes' : 'no';
  }
  if (process.platform === 'win32') {
    if (!window || window.isDestroyed()) return 'unavailable';
    const result = await native().hello.verify(reason, window.getNativeWindowHandle(), OS_PROMPT_MS);
    return result === 'verified' ? 'yes' : result === 'unavailable' ? 'unavailable' : 'no';
  }
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.promptTouchID(reason);
      return 'yes';
    } catch {
      return 'no';
    }
  }
  return 'unavailable';
};

function setup(ctx: FeatureContext): void {
  const { windows } = ctx;
  const site = createHash('sha256').update(ctx.origin).digest('hex').slice(0, 16);
  const folder = path.join(app.getPath('userData'), 'app-lock');
  const secrets = new SecretStore(folder);
  const osKeyName = `${OS_KEY_NAME}-${site}`;
  appLockGate.init(path.join(folder, `${site}.json`));

  let prompting = false;
  const oneAtATime = async <T>(busy: T, run: () => Promise<T>): Promise<T> => {
    if (prompting) return busy;
    prompting = true;
    try {
      return await run();
    } finally {
      prompting = false;
    }
  };

  const osEnrolled = async (): Promise<boolean> => {
    try {
      return (await secrets.get(osKeyName)) !== null;
    } catch {
      return false;
    }
  };

  // Everything that can show on screen without a page.
  const blankTitles = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.setTitle(app.getName());
    }
  };

  windows.on('created', (managed) => {
    managed.window.webContents.on('page-title-updated', (event) => {
      if (!appLockGate.locked) return;
      event.preventDefault();
      managed.window.setTitle(app.getName());
    });
  });

  ctx.menu.extend('file', () => [{
    id: 'file.lockNow',
    label: strings().menuLockNow,
    enabled: appLockGate.enrolled && !appLockGate.locked,
    click: () => askToLock(),
  }]);

  appLockGate.on('locked', (locked) => {
    if (locked) blankTitles();
    ctx.menu.rebuild();
  });

  appLockGate.on('enrolled', () => ctx.menu.rebuild());

  /** Tells the pages, which save what's open and go to the lock screen. */
  const askToLock = () => {
    if (!appLockGate.enrolled) return;
    appLockGate.lock();
    windows.broadcast(CHANNEL.appLockRequest, null);
  };

  powerMonitor.on('lock-screen', askToLock);
  // Toasts, the jump list and window titles outlive this run, or come up before the next page does.
  app.on('before-quit', () => {
    if (appLockGate.enrolled) appLockGate.lock();
  });

  ctx.handle(CHANNEL.appLockStatus, async (): Promise<AppLockStatus> => ({
    locked: appLockGate.locked,
    enrolled: appLockGate.enrolled,
    os: await osKindNow(),
    osEnrolled: await osEnrolled(),
  }));
  ctx.on(CHANNEL.appLockLock, () => appLockGate.lock());
  ctx.handle(CHANNEL.appLockEnroll, (_event, _window, proof) => appLockGate.enroll(proof));
  ctx.handle(CHANNEL.appLockProve, (_event, _window, proof) => appLockGate.prove(proof));
  ctx.handle(CHANNEL.appLockDisable, async (_event, _window, proof) => {
    if (!appLockGate.disable(proof)) return false;
    rmSync(path.join(folder, `${osKeyName}.bin`), { force: true });
    return true;
  });

  ctx.handle(CHANNEL.appLockForget, async (_event, window) => {
    if (!appLockGate.enrolled) return true;
    // Lifting a lock on a page's word alone would be no lock. While unlocked there's nothing to lift.
    if (appLockGate.locked) {
      const text = strings();
      const options = {
        type: 'warning' as const,
        message: text.appLockForgetTitle,
        detail: text.appLockForgetDetail,
        buttons: [text.appLockForgetConfirm, text.appLockForgetCancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      if (response !== 0) return false;
    }
    appLockGate.forget();
    rmSync(path.join(folder, `${osKeyName}.bin`), { force: true });
    return true;
  });

  ctx.handle(CHANNEL.appLockOsEnroll, (_event, window, proof, key) => oneAtATime(false, async () => {
    if (appLockGate.locked || !appLockGate.matches(proof)) return false;
    if (!(key instanceof Uint8Array) || key.length !== 32) return false;
    // The backend that only obfuscates would make this worse than the PIN and call it safer.
    if (process.platform === 'linux') return false;
    if ((await verifyWithOs(window, strings().appLockOsEnrollReason)) !== 'yes') return false;
    await secrets.set(osKeyName, Buffer.from(key).toString('base64'));
    return true;
  }));
  ctx.handle(CHANNEL.appLockOsRemove, () => {
    // Only ever narrows.
    rmSync(path.join(folder, `${osKeyName}.bin`), { force: true });
  });

  ctx.handle(CHANNEL.appLockOsUnlock, (_event, window) => oneAtATime<OsUnlockAnswer>({ ok: false, reason: 'failed' }, async () => {
    // Asking while unlocked would let any same-origin frame pop prompts and collect the key.
    if (!appLockGate.locked) return { ok: false, reason: 'not-locked' };
    if (!(await osEnrolled())) return { ok: false, reason: 'unavailable' };
    const answer = await verifyWithOs(window, strings().appLockOsUnlockReason);
    if (answer === 'unavailable') return { ok: false, reason: 'unavailable' };
    if (answer !== 'yes') return { ok: false, reason: 'denied' };
    try {
      const stored = await secrets.get(osKeyName);
      if (!stored) return { ok: false, reason: 'unavailable' };
      appLockGate.liftAfterOsCheck();
      return { ok: true, key: new Uint8Array(Buffer.from(stored, 'base64')) };
    } catch {
      return { ok: false, reason: 'failed' };
    }
  }));

  // The checks in test/ read and fire these. An installed app has none of it.
  if (!app.isPackaged) {
    (globalThis as unknown as { __bulwarkAppLock: unknown }).__bulwarkAppLock = { gate: appLockGate, lockScreen: () => powerMonitor.emit('lock-screen') };
  }
}

export const appLockFeature: Feature = { name: 'app-lock', modes: ['standalone', 'instance'], setup };
