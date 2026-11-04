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
 *
 * `wrap` and `unwrap` put safeStorage around the page's PIN record and the store's keys, so
 * a copy of the disk can't be guessed at without this user's OS login. A frame can call
 * them too, and gets what's still under the PIN or the page's own key, for this origin only.
 */

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, powerMonitor, safeStorage, systemPreferences } from 'electron';
import { CHANNEL, type AppLockStatus, type OsUnlockAnswer, type OsUnlockKind } from '../../shared/bridge';
import { appLockGate } from '../app-lock-gate';
import { native } from '../native';
import { SecretStore } from '../secrets';
import { strings } from '../strings';
import { addWipeStep, runLocalWipe } from './local-wipe';
import type { Feature, FeatureContext } from '.';

const OS_KEY_NAME = 'app-lock-key';
const OS_PROMPT_MS = 60_000;
/** A PIN record or a database key. Nothing here wraps anything big. */
const MAX_WRAP_BYTES = 4096;

/** The backend that only obfuscates would make this look safer than it is. */
async function wrapAvailable(): Promise<boolean> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

// Whatever the mode: a wipe can run before or without the feature's setup. The folder holds the
// gate's record and the DPAPI-wrapped lock key of every origin, and the wipe takes all origins.
addWipeStep(async () => {
  rmSync(path.join(app.getPath('userData'), 'app-lock'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  appLockGate.forget();
});

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
  appLockGate.initForProfile(app.getPath('userData'), ctx.origin);

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
    click: () => appLockGate.requestLock(),
  }]);

  appLockGate.on('locked', (locked) => {
    if (locked) blankTitles();
    ctx.menu.rebuild();
  });

  appLockGate.on('enrolled', () => ctx.menu.rebuild());

  // Tells the pages, which save what's open and go to the lock screen.
  appLockGate.on('requested', () => windows.broadcast(CHANNEL.appLockRequest, null));

  powerMonitor.on('lock-screen', () => appLockGate.requestLock());
  // Toasts, the jump list and window titles outlive this run, or come up before the next page does.
  app.on('before-quit', () => {
    if (appLockGate.enrolled) appLockGate.lock();
  });

  ctx.handle(CHANNEL.appLockStatus, async (): Promise<AppLockStatus> => ({
    locked: appLockGate.locked,
    enrolled: appLockGate.enrolled,
    os: await osKindNow(),
    // Whether it's there, not whether it opens: nothing here decrypts before someone said yes.
    osEnrolled: secrets.has(osKeyName),
    wrap: await wrapAvailable(),
  }));
  ctx.on(CHANNEL.appLockLock, () => appLockGate.lock());

  /** The first button is the yes. A no holds for this run, so nothing can keep asking. */
  const askOnce = (message: string, detail: string, yes: string, no: string, window: BrowserWindow | null) => {
    const options = { type: 'question' as const, message, detail, buttons: [yes, no], defaultId: 1, cancelId: 1, noLink: true };
    return (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)).then(({ response }) => response === 0);
  };

  let enrollDeclined = false;
  // A lock survives a restart and only its PIN opens it, so setting one up isn't for just any
  // call: a same-origin plugin frame gets here too. The page's own setup comes from a click, and
  // whatever took longer than a click lasts is the user's to allow.
  ctx.handle(CHANNEL.appLockEnroll, async (_event, window, proof, clicked) => {
    if (clicked !== true) {
      if (enrollDeclined || !(proof instanceof Uint8Array) || proof.length !== 32 || appLockGate.enrolled) return false;
      const text = strings();
      const allowed = await oneAtATime<boolean | null>(null, () => askOnce(text.appLockEnrollTitle, text.appLockEnrollDetail, text.appLockEnrollConfirm, text.appLockForgetCancel, window));
      if (allowed === false) enrollDeclined = true;
      if (!allowed) return false;
    }
    return appLockGate.enroll(proof);
  });

  let orphanAsked = false;
  // Main keeps a lock and the page has no PIN for it (the webmail's clearOrphanedDesktopLock).
  // Nothing can prove that lock, and no page's word can lift it, so the user decides, once a run.
  ctx.handle(CHANNEL.appLockClearOrphan, (_event, window) => oneAtATime(false, async () => {
    if (!appLockGate.enrolled) return true;
    if (orphanAsked) return false;
    orphanAsked = true;
    const text = strings();
    if (!(await askOnce(text.appLockOrphanTitle, text.appLockOrphanDetail, text.appLockOrphanConfirm, text.appLockOrphanCancel, window))) return false;
    appLockGate.forget();
    rmSync(path.join(folder, `${osKeyName}.bin`), { force: true });
    return true;
  }));
  ctx.handle(CHANNEL.appLockProve, (_event, _window, proof) => appLockGate.prove(proof));
  ctx.handle(CHANNEL.appLockDisable, async (_event, _window, proof) => {
    if (!appLockGate.disable(proof)) return false;
    rmSync(path.join(folder, `${osKeyName}.bin`), { force: true });
    return true;
  });

  ctx.handle(CHANNEL.appLockForget, async (_event, window, proof) => {
    if (!appLockGate.enrolled) return true;
    // Lifting a lock on a page's word alone would be no lock, and while unlocked a word followed
    // by `enroll` would replace it. So with no proof of the current lock it's the user's to say.
    if (appLockGate.locked || !appLockGate.matches(proof)) {
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

  ctx.handle(CHANNEL.appLockWrap, async (_event, _window, data) => {
    if (!(data instanceof Uint8Array) || data.length > MAX_WRAP_BYTES || !(await wrapAvailable())) return null;
    const sealed = await safeStorage.encryptStringAsync(`${site}:${Buffer.from(data).toString('base64')}`);
    return new Uint8Array(sealed);
  });
  ctx.handle(CHANNEL.appLockUnwrap, async (_event, _window, data) => {
    if (!(data instanceof Uint8Array) || data.length > MAX_WRAP_BYTES * 2 || !(await wrapAvailable())) return null;
    try {
      const { result } = await safeStorage.decryptStringAsync(Buffer.from(data));
      return result.startsWith(`${site}:`) ? new Uint8Array(Buffer.from(result.slice(site.length + 1), 'base64')) : null;
    } catch {
      return null;
    }
  });

  ctx.handle(CHANNEL.appLockOsUnlock, (_event, window) => oneAtATime<OsUnlockAnswer>({ ok: false, reason: 'failed' }, async () => {
    // Asking while unlocked would pop prompts and collect the key.
    if (!appLockGate.locked) return { ok: false, reason: 'not-locked' };
    if (!secrets.has(osKeyName)) return { ok: false, reason: 'unavailable' };
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
    (globalThis as unknown as { __bulwarkAppLock: unknown }).__bulwarkAppLock = {
      gate: appLockGate,
      lockScreen: () => powerMonitor.emit('lock-screen'),
      wipe: () => runLocalWipe('remote', app.getPath('userData'), ctx.state),
    };
  }
}

export const appLockFeature: Feature = { name: 'app-lock', modes: ['standalone', 'instance'], setup };
