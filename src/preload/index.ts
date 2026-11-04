/**
 * The bridge the webmail sees as window.bulwarkDesktop.
 *
 * Runs in a sandboxed renderer, so only electron's contextBridge and ipcRenderer
 * are here. It exposes nothing unless the page is on the one origin this window
 * was opened for. An external page, about:blank, a blob: preview or a frame gets
 * no bridge. Main checks the sender's origin again on every call, so this check
 * is a courtesy, not the lock.
 *
 * New features add a member here and a handler in src/main/features/.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  BRIDGE_VERSION,
  type AppLockStatus,
  type PinStepAnswer,
  type OsUnlockAnswer,
  CHANNEL,
  PRELOAD_ARG,
  type ConfirmOptions,
  type FlushAnswer,
  type LanguagesUpdate,
  type MenuBarEntry,
  type MenuBarEvent,
  type KeystoreDecryptScheme,
  type KeystoreAccessState,
  type KeystoreCertificate,
  type KeystoreResult,
  type KeystoreSignScheme,
  type LocalImportGrantResult,
  type LocalImportResumeResult,
  type LocalImportScanResult,
  type MenuState,
  type OsCommand,
  type OsDefaultAppStatus,
  type OsFile,
  type OsNotification,
  type OsNotifyResult,
  type OsPowerEvent,
  type OsSettings,
  type OsStatus,
  type OsSummary,
  type NativeMenuItem,
  type PrivacyState,
  type SessionUrls,
  type SystemTheme,
  type ThemeColours,
  type UpdateChannel,
  type UpdateState,
  type WindowInfo,
} from '../shared/bridge';
import { DEFAULT_POLICY_SNAPSHOT, type PolicySnapshot } from '../shared/policy-schema';

let appLockClaimed = false;

function argument(prefix: string): string | null {
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/** Only the code gets through contextBridge, which is all a plugin's frame can see anyway. */
async function keystoreAnswer<T>(call: Promise<KeystoreResult<T>>): Promise<T> {
  const result = await call;
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

const allowedOrigin = argument(PRELOAD_ARG.allowedOrigin);
const mode = argument(PRELOAD_ARG.mode);

// Plain http only when the allowed origin is: an instance a policy allows that way.
if (allowedOrigin && /^https?:$/.test(window.location.protocol) && window.location.origin === allowedOrigin) {
  const platform = process.platform as 'win32' | 'darwin' | 'linux';
  const flushHandlers = new Set<() => Promise<unknown>>();
  ipcRenderer.on(CHANNEL.lifecycleFlush, (_event, id: number) => {
    void Promise.allSettled([...flushHandlers].map((handler) => handler())).then((settled) => {
      const answers: FlushAnswer[] = settled.map((result) => {
        if (result.status === 'rejected') return { failed: 1 };
        const { failed, timedOut, unsent } = (result.value ?? {}) as FlushAnswer;
        return { failed, timedOut, unsent };
      });
      ipcRenderer.send(CHANNEL.lifecycleFlushed, id, answers);
    });
  });
  let policySnapshot: PolicySnapshot = (ipcRenderer.sendSync(CHANNEL.policyGet) as PolicySnapshot | null) ?? DEFAULT_POLICY_SNAPSHOT;
  ipcRenderer.on(CHANNEL.policyChanged, (_event, snapshot: PolicySnapshot) => {
    policySnapshot = snapshot;
  });
  const common = {
    version: BRIDGE_VERSION,
    platform,
    mode,
    certificates: {
      clearChoices: (scope: { account?: string; last?: boolean }): Promise<void> => ipcRenderer.invoke(CHANNEL.certificatesClearChoices, scope),
      setAccount: (account: string | null): Promise<void> => ipcRenderer.invoke(CHANNEL.certificatesSetAccount, account),
      onConnectionsReset: (listener: () => void) => subscribe(CHANNEL.certificatesConnectionsReset, listener),
    },
    windows: {
      open: (url: string, options: { name: string; width: number; height: number }) =>
        ipcRenderer.send(CHANNEL.windowsOpen, url, options),
      openMessage: (target: { url: string; emailId: string }) => ipcRenderer.send(CHANNEL.windowsOpenMessage, target),
      openComposer: (target: { url: string; name?: string }) => ipcRenderer.send(CHANNEL.windowsOpenComposer, target),
      focus: (id?: number) => ipcRenderer.send(CHANNEL.windowsFocus, id),
      list: (): Promise<WindowInfo[]> => ipcRenderer.invoke(CHANNEL.windowsList),
      onChanged: (listener: (windows: WindowInfo[]) => void) => subscribe(CHANNEL.windowsChanged, listener),
      closeSelf: () => ipcRenderer.send(CHANNEL.windowsCloseSelf),
      setRestore: (urls: string[]) => ipcRenderer.send(CHANNEL.windowsSetRestore, urls),
      setRestoreEnabled: (enabled: boolean) => ipcRenderer.send(CHANNEL.windowsSetRestoreEnabled, enabled),
      sessionReady: () => ipcRenderer.send(CHANNEL.windowsSessionReady),
      sessionEnded: () => ipcRenderer.send(CHANNEL.windowsSessionEnded),
      spare: {
        ready: () => ipcRenderer.send(CHANNEL.windowsSpareReady),
        taken: () => ipcRenderer.send(CHANNEL.windowsSpareTaken),
        onActivate: (listener: (url: string) => void) => subscribe(CHANNEL.windowsSpareActivate, listener),
      },
    },
    theme: {
      set: (theme: ThemeColours) => ipcRenderer.send(CHANNEL.themeSet, theme),
      onSystemChange: (listener: (system: SystemTheme) => void) => subscribe(CHANNEL.themeSystem, listener),
      system: (): Promise<SystemTheme> => ipcRenderer.invoke(CHANNEL.themeGetSystem),
    },
    menu: {
      setState: (state: MenuState) => ipcRenderer.send(CHANNEL.menuSetState, state),
      onCommand: (listener: (id: string) => void) => subscribe(CHANNEL.menuCommand, listener),
      popup: (items: NativeMenuItem[], at: { x: number; y: number }): Promise<string | null> =>
        ipcRenderer.invoke(CHANNEL.menuPopup, items, at),
      bar: {
        entries: (): Promise<MenuBarEntry[]> => ipcRenderer.invoke(CHANNEL.menuBarEntries),
        open: (id: string, at: { x: number; y: number }) => ipcRenderer.send(CHANNEL.menuBarOpen, id, at),
        onEvent: (listener: (event: MenuBarEvent) => void) => subscribe(CHANNEL.menuBarEvent, listener),
      },
    },
    appLock: {
      status: (): Promise<AppLockStatus> => ipcRenderer.invoke(CHANNEL.appLockStatus),
      // A same-origin frame reaches this object through `parent`, and main can't tell its calls
      // from the page's (ipc.ts). So these go to whoever asks first, and the page asks in its
      // first render, before any frame exists. This is per document: the preload runs again.
      // Unwrapping is here because a frame could take the OS's layer off the PIN record and
      // guess at it elsewhere, and a PIN step because every guess has to be counted.
      claim: () => {
        if (appLockClaimed) return null;
        appLockClaimed = true;
        return {
          lock: () => ipcRenderer.send(CHANNEL.appLockLock),
          osUnlock: (): Promise<OsUnlockAnswer> => ipcRenderer.invoke(CHANNEL.appLockOsUnlock),
          wrap: (data: Uint8Array): Promise<Uint8Array | null> => ipcRenderer.invoke(CHANNEL.appLockWrap, data),
          unwrap: (data: Uint8Array): Promise<Uint8Array | null> => ipcRenderer.invoke(CHANNEL.appLockUnwrap, data),
          pinStep: (data: Uint8Array): Promise<PinStepAnswer> => ipcRenderer.invoke(CHANNEL.appLockPinStep, data),
          replaceRenderer: () => ipcRenderer.send(CHANNEL.appLockReplaceRenderer),
        };
      },
      enroll: (proof: Uint8Array): Promise<boolean> => ipcRenderer.invoke(CHANNEL.appLockEnroll, proof),
      prove: (proof: Uint8Array): Promise<boolean> => ipcRenderer.invoke(CHANNEL.appLockProve, proof),
      disable: (proof: Uint8Array): Promise<boolean> => ipcRenderer.invoke(CHANNEL.appLockDisable, proof),
      forget: (proof?: Uint8Array): Promise<boolean> => ipcRenderer.invoke(CHANNEL.appLockForget, proof),
      osEnroll: (proof: Uint8Array, lockKey: Uint8Array): Promise<boolean> => ipcRenderer.invoke(CHANNEL.appLockOsEnroll, proof, lockKey),
      osRemove: (): Promise<void> => ipcRenderer.invoke(CHANNEL.appLockOsRemove),
      onLockRequest: (listener: () => void) => subscribe(CHANNEL.appLockRequest, listener),
    },
    httpCache: {
      /** Nobody is signed in any more. Only ever deletes, so anyone may ask. */
      clear: (): Promise<void> => ipcRenderer.invoke(CHANNEL.httpCacheClear),
    },
    shell: {
      openExternal: (url: string) => ipcRenderer.send(CHANNEL.shellOpenExternal, url),
      setLanguages: (languages: LanguagesUpdate) => ipcRenderer.send(CHANNEL.shellSetLanguages, languages),
    },
    spellcheck: {
      /** Languages with neither an OS checker nor a dictionary here. */
      missing: (): Promise<string[]> => ipcRenderer.invoke(CHANNEL.spellListMissing),
      onMissing: (listener: (language: string) => void) => subscribe(CHANNEL.spellMissing, listener),
      /** The user said yes: dictionaries may come from Google. Never with no-third-party mode on. */
      allowDownload: () => ipcRenderer.send(CHANNEL.spellAllowDownload),
    },
    dialogs: {
      /** A native question. Answers with the index of the button chosen. */
      confirm: (options: ConfirmOptions): Promise<number> => ipcRenderer.invoke(CHANNEL.dialogsConfirm, options),
    },
    clipboard: {
      /** Puts a file on the clipboard, for pasting into a folder. False when that didn't work. */
      copyFile: (name: string, data: ArrayBuffer): Promise<boolean> => ipcRenderer.invoke(CHANNEL.clipboardCopyFile, name, data),
      /** Signed out: nothing copied from that account stays on disk. */
      clearFiles: () => ipcRenderer.send(CHANNEL.clipboardClearFiles),
    },
    updates: {
      state: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNEL.updatesState),
      check: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNEL.updatesCheck),
      setChannel: (channel: UpdateChannel): Promise<UpdateState> => ipcRenderer.invoke(CHANNEL.updatesSetChannel, channel),
      installOlder: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNEL.updatesInstallOlder),
      restart: () => ipcRenderer.send(CHANNEL.updatesRestart),
      openDownload: () => ipcRenderer.send(CHANNEL.updatesOpenDownload),
      onChanged: (listener: (state: UpdateState) => void) => subscribe(CHANNEL.updatesChanged, listener),
    },
    localImport: {
      /** Asks the user natively before it looks. See src/main/features/import.ts. */
      scan: (): Promise<LocalImportScanResult> => ipcRenderer.invoke(CHANNEL.localImportScan),
      grant: (handles: string[]): Promise<LocalImportGrantResult> => ipcRenderer.invoke(CHANNEL.localImportGrant, handles),
      resume: (jobId: string): Promise<LocalImportResumeResult> => ipcRenderer.invoke(CHANNEL.localImportResume, jobId),
      release: (jobId: string): Promise<void> => ipcRenderer.invoke(CHANNEL.localImportRelease, jobId),
      releaseAll: (): Promise<void> => ipcRenderer.invoke(CHANNEL.localImportReleaseAll),
    },
    policy: {
      get: () => policySnapshot,
      onChange: (listener: (snapshot: PolicySnapshot) => void) => subscribe(CHANNEL.policyChanged, listener),
    },
    privacy: {
      get: () => ipcRenderer.invoke(CHANNEL.privacyGet),
      setTelemetry: (on: boolean) => ipcRenderer.invoke(CHANNEL.privacySetTelemetry, on),
      setCrashReports: (on: boolean) => ipcRenderer.invoke(CHANNEL.privacySetCrashReports, on),
      setCrashUploadUrl: (url: string) => ipcRenderer.invoke(CHANNEL.privacySetCrashUploadUrl, url),
      listCrashes: () => ipcRenderer.invoke(CHANNEL.privacyListCrashes),
      sendCrash: (id: string) => ipcRenderer.invoke(CHANNEL.privacySendCrash, id),
      deleteCrashes: () => ipcRenderer.invoke(CHANNEL.privacyDeleteCrashes),
      onChange: (listener: (state: PrivacyState) => void) => subscribe(CHANNEL.privacyChanged, listener),
    },
    os: {
      /**
       * What the OS asks for: tray, jump list, toast buttons, opened files. Main holds
       * these until the main window's page subscribes, so a cold start loses nothing.
       */
      onCommand: (listener: (command: OsCommand) => void) => {
        const stop = subscribe(CHANNEL.osCommand, listener);
        ipcRenderer.send(CHANNEL.osSubscribe);
        return stop;
      },
      getStatus: (): Promise<OsStatus> => ipcRenderer.invoke(CHANNEL.osGetStatus),
      setSettings: (patch: Partial<OsSettings>): Promise<OsStatus> => ipcRenderer.invoke(CHANNEL.osSetSettings, patch),
      setPaused: (until: number | null) => ipcRenderer.send(CHANNEL.osSetPaused, until),
      onStatusChange: (listener: (status: OsStatus) => void) => subscribe(CHANNEL.osStatusChanged, listener),
      setBadge: (count: number) => ipcRenderer.send(CHANNEL.osSetBadge, count),
      setSummary: (summary: OsSummary) => ipcRenderer.send(CHANNEL.osSetSummary, summary),
      setProgress: (progress: number | null, mode?: 'normal' | 'indeterminate' | 'paused' | 'error') =>
        ipcRenderer.send(CHANNEL.osSetProgress, progress, mode),
      setLocked: (locked: boolean) => ipcRenderer.send(CHANNEL.osSetLocked, locked),
      clearSurfaces: () => ipcRenderer.send(CHANNEL.osClearSurfaces),
      notify: (notification: OsNotification): Promise<OsNotifyResult> => ipcRenderer.invoke(CHANNEL.osNotify, notification),
      onPower: (listener: (event: OsPowerEvent) => void) => subscribe(CHANNEL.osPower, listener),
      startDrag: (files: OsFile[]): Promise<boolean> => ipcRenderer.invoke(CHANNEL.osStartDrag, files),
      copyFiles: (files: OsFile[]): Promise<boolean> => ipcRenderer.invoke(CHANNEL.osCopyFiles, files),
      defaultAppStatus: (): Promise<OsDefaultAppStatus> => ipcRenderer.invoke(CHANNEL.osDefaultAppStatus),
      openDefaultAppSettings: (): Promise<OsDefaultAppStatus> => ipcRenderer.invoke(CHANNEL.osDefaultAppOpen),
    },
    lifecycle: {
      /**
       * Before a window closes or the app quits, main asks the page to save what it
       * has and waits a few seconds. A window with no handler closes at once.
       */
      onFlushRequest: (handler: () => Promise<unknown>) => {
        flushHandlers.add(handler);
        ipcRenderer.send(CHANNEL.lifecycleRegister, flushHandlers.size > 0);
        return () => {
          flushHandlers.delete(handler);
          ipcRenderer.send(CHANNEL.lifecycleRegister, flushHandlers.size > 0);
        };
      },
    },
  };

  const standalone = mode === 'standalone'
    ? {
        servers: {
          prepare: (serverUrl: string) => ipcRenderer.invoke(CHANNEL.serversPrepare, serverUrl),
          noteSession: (serverUrl: string, urls: SessionUrls) => ipcRenderer.send(CHANNEL.serversNoteSession, serverUrl, urls),
          forget: (serverUrl: string, reason: 'failed' | 'signed-out') => ipcRenderer.send(CHANNEL.serversForget, serverUrl, reason),
        },
        auth: {
          beginBrowserSignIn: () => ipcRenderer.invoke(CHANNEL.authBegin),
          completeBrowserSignIn: (flowId: string, authorizeUrl: string) =>
            ipcRenderer.invoke(CHANNEL.authComplete, flowId, authorizeUrl),
          cancelBrowserSignIn: (flowId: string) => ipcRenderer.send(CHANNEL.authCancel, flowId),
        },
        plugins: {
          install: (slug: string, version?: string) => ipcRenderer.invoke(CHANNEL.pluginsInstall, slug, version),
        },
      }
    : {};

  // Only where the helper loaded and the OS has a keystore. Stays this narrow: see
  // src/main/features/keystore.ts.
  const keystore = argument(PRELOAD_ARG.keystore) === '1'
    ? {
        keystore: {
          list: () => keystoreAnswer<KeystoreCertificate[]>(ipcRenderer.invoke(CHANNEL.keystoreList)),
          sign: (id: string, digest: Uint8Array, scheme: KeystoreSignScheme) =>
            keystoreAnswer<Uint8Array>(ipcRenderer.invoke(CHANNEL.keystoreSign, id, digest, scheme)),
          decrypt: (id: string, data: Uint8Array, scheme: KeystoreDecryptScheme) =>
            keystoreAnswer<Uint8Array>(ipcRenderer.invoke(CHANNEL.keystoreDecrypt, id, data, scheme)),
          agree: (id: string, peerPublicKey: Uint8Array) =>
            keystoreAnswer<Uint8Array>(ipcRenderer.invoke(CHANNEL.keystoreAgree, id, peerPublicKey)),
          accessState: (): Promise<KeystoreAccessState> => ipcRenderer.invoke(CHANNEL.keystoreAccess),
          revokeAccess: (): Promise<void> => ipcRenderer.invoke(CHANNEL.keystoreRevoke),
          clearGrants: (): Promise<void> => ipcRenderer.invoke(CHANNEL.keystoreClearGrants),
        },
      }
    : {};

  contextBridge.exposeInMainWorld('bulwarkDesktop', { ...common, ...standalone, ...keystore });
}
