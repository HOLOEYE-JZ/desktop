/**
 * The bridge contract: the shell's copy of lib/desktop/types.ts in the webmail.
 * Add a member in both places together. A breaking change bumps
 * BRIDGE_VERSION; adding a member doesn't.
 */

import type { PolicySnapshot } from './policy-schema';

export const BRIDGE_VERSION = 1;

export type WindowType = 'main' | 'message' | 'composer' | 'settings';

export interface WindowInfo {
  id: number;
  type: WindowType;
  title: string;
  focused: boolean;
  /** False for a main window hidden while pop-outs are open. */
  visible?: boolean;
}

export type Mode = 'standalone' | 'instance';

export type ServerPrepareResult =
  | { ok: true; approved: boolean }
  | { ok: false; reason: 'declined' | 'invalid' | 'policy' };

/** Standalone: a mail server's own OAuth. Instance: the instance's own login page. */
export type BrowserSignInRequest = { kind: 'oauth'; serverUrl: string } | { kind: 'instance' };

export type BrowserSignInBegin =
  | { ok: true; flowId: string; redirectUri: string; state: string }
  | { ok: false; error: string };

export type BrowserSignInResult =
  | { ok: true; code: string; state: string; iss?: string }
  | { ok: false; error: string };

/** The server has no OAuth: a page main serves. See src/main/browser-sign-in.ts. */
export type PasswordSignInStart = { ok: true; host: string } | { ok: false; error: string };

export type PasswordSignInAttempt =
  | { ok: true; username: string; password: string; totp?: string }
  | { ok: false; error: string };

export type PasswordSignInAnswer =
  | { ok: true }
  | { ok: false; error: 'invalid_credentials' | 'totp_required' | 'other' };

/**
 * What `auth.claim()` hands out, once per document, in the page's first render: a
 * same-origin frame can reach the parent's bridge, and main can't tell its calls apart.
 */
export interface BrowserSignInControls {
  begin: (request: BrowserSignInRequest) => Promise<BrowserSignInBegin>;
  complete: (flowId: string, url: string) => Promise<BrowserSignInResult>;
  useScheme: (flowId: string) => Promise<string | null>;
  cancel: (flowId: string) => void;
  beginPassword: (flowId: string) => Promise<PasswordSignInStart>;
  nextPassword: (flowId: string) => Promise<PasswordSignInAttempt>;
  answerPassword: (flowId: string, answer: PasswordSignInAnswer) => void;
  outcome: (flowId: string) => Promise<BrowserSignInResult>;
}

export type PluginInstallResult =
  | { ok: true; id: string; version: string }
  | { ok: false; error: string; code?: string };

export interface ThemeColours {
  dark: boolean;
  background: string;
  foreground?: string;
}

export interface SystemTheme {
  dark: boolean;
  highContrast: boolean;
  /** The OS accent colour as #rrggbb, where the OS has one and tells. */
  accent?: string;
}

export type UpdateChannel = 'stable' | 'beta';

/** `install`: replaces itself. `notify`: an MSI, deb, rpm or unsigned macOS, says a version exists. `none`: a development run. */
export type UpdateAbility = 'install' | 'notify' | 'none';

export interface UpdateState {
  /** The running version. */
  version: string;
  channel: UpdateChannel;
  /** Set by the `UpdateChannel` policy. */
  channelLocked: boolean;
  /** False when the `AutoUpdate` policy turned updates off. */
  allowed: boolean;
  ability: UpdateAbility;
  /** Windows, and not the per-user installer: an MSI, whose updates come the way it did. */
  perMachine: boolean;
  /**
   * `available`: a newer version, for `notify` installs. `older-available`: on stable, with
   * a beta running, and the newest stable is older than it. `off`: the policy.
   */
  status: 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'available' | 'older-available' | 'error' | 'off';
  /** The version the status is about. */
  target?: string;
  percent?: number;
}

export interface PolicyBridge {
  /** What's in force now. Synchronous: a page can read it in its first render. */
  get: () => PolicySnapshot;
  onChange: (listener: (snapshot: PolicySnapshot) => void) => () => void;
}

export type MenuState = Record<string, boolean | { enabled?: boolean; checked?: boolean }>;

export type OsUnlockKind = 'hello' | 'touchid';

export interface AppLockStatus {
  locked: boolean;
  enrolled: boolean;
  os: OsUnlockKind | null;
  osEnrolled: boolean;
  /** The OS has a real key store, so `wrap` and `unwrap` work. False: secrets on this machine are only obfuscated. */
  wrap: boolean;
}

/** What a page's wipe asks of main. `account` null: everything on this device. */
export interface LocalWipeRequest {
  reason: 'remote' | 'settings';
  account: string | null;
}

/** A PIN guess through main. Blocked: too many wrong ones. No secret: this profile lost it, or the OS won't open it. */
export type PinStepAnswer = { ok: true; bytes: Uint8Array } | { ok: false; blockedUntil?: number };

export type OsUnlockAnswer =
  | { ok: true; key: Uint8Array }
  | { ok: false; reason: 'unavailable' | 'denied' | 'failed' | 'not-locked' };

/** A native menu built by the page: an HTML menu read back, so the two can't drift. */
export interface NativeMenuItem {
  /** Handed back when this item is chosen. Left out of separators and submenus. */
  id?: string;
  label?: string;
  type?: 'normal' | 'separator' | 'checkbox' | 'radio';
  enabled?: boolean;
  checked?: boolean;
  submenu?: NativeMenuItem[];
}

/** One name in the strip that stands in for a menu bar in a window with no native frame. */
export interface MenuBarEntry {
  id: string;
  label: string;
  /** The letter that opens it with Alt, lower case. */
  mnemonic?: string;
}

export interface MenuBarEvent {
  visible: boolean;
  /** Open this menu right away: Alt plus its letter. */
  open?: string;
}

/** What a page says when asked to save before a window goes. */
export interface FlushAnswer {
  /** Drafts it couldn't save. */
  failed?: number;
  timedOut?: boolean;
  /** Mail waiting to be sent. It goes out at the next start. */
  unsent?: number;
}

export interface ConfirmOptions {
  message: string;
  detail?: string;
  /** Button labels, the safe choice last. */
  buttons: string[];
  /** The button Enter takes. */
  defaultId?: number;
  type?: 'none' | 'info' | 'warning' | 'question';
}

export interface LanguagesUpdate {
  /** The interface language. The shell's menus follow it too. */
  ui: string;
  /** What the composer's text is in, if it says. */
  composer?: string[];
  /** The shell's menu and dialog text in that language, by the keys of `src/main/strings.ts`. */
  labels?: Record<string, string>;
}
export type KeystoreHash = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

export interface KeystoreCertificate {
  /** Opaque: the only ids sign, decrypt and agree accept. */
  id: string;
  /** The leaf, DER. */
  certificate: Uint8Array;
  /** Intermediates, DER, without leaf and root. May be empty. */
  chain: Uint8Array[];
  subject: string;
  issuer: string;
  /** Hex. */
  serial: string;
  /** Milliseconds since 1970. */
  notBefore: number;
  notAfter: number;
  /** keyUsage names. Empty without the extension. */
  usages: string[];
  /** extendedKeyUsage OIDs. Empty without the extension. */
  extendedUsages: string[];
  /** The key's algorithm OID. */
  algorithm: string;
  keyType: 'rsa' | 'ec';
  curve?: 'P-256' | 'P-384' | 'P-521';
  keyBits: number;
  /** A hint for the UI. */
  source: 'software' | 'smartcard' | 'keychain' | 'unknown';
  signSchemes: string[];
  decryptSchemes: string[];
  canAgree: boolean;
  /** The key can also sign the user in somewhere: the user is asked per use. */
  askEachUse: boolean;
}

/** Whether this origin may use the keystore at all. `app` is standalone. */
export type KeystoreAccessState = 'app' | 'policy' | 'stored' | 'off';

export type KeystoreSignScheme =
  | { scheme: 'rsa-pkcs1'; hash: KeystoreHash }
  /** MGF1 on the same hash, salt as long as the hash. */
  | { scheme: 'rsa-pss'; hash: KeystoreHash }
  /** `hash` names the digest's length. */
  | { scheme: 'ecdsa'; hash: KeystoreHash };

export type KeystoreDecryptScheme =
  | { scheme: 'rsa-pkcs1' }
  /** MGF1 on the same hash. */
  | { scheme: 'rsa-oaep'; hash: KeystoreHash; label?: Uint8Array };

/** `quiet`: answer from what's already allowed, with keystore:ask-first in place of a dialog. */
export interface KeystoreUseOptions {
  quiet?: boolean;
}

/** How main answers a keystore call. The preload turns a failure into `new Error(code)`. */
export type KeystoreResult<T> = { ok: true; value: T } | { ok: false; code: string };

export interface SessionUrls {
  apiUrl?: string;
  downloadUrl?: string;
  uploadUrl?: string;
  eventSourceUrl?: string;
}

export type LocalImportKind = 'mbox' | 'maildir' | 'pst';

/** Something a scan found. The handle is all the page can ask for it by. */
export interface LocalImportCandidate {
  handle: string;
  app: 'thunderbird' | 'outlook';
  kind: LocalImportKind;
  /** The Thunderbird profile's name, or "Outlook". */
  group: string;
  account?: string;
  /** Where the mail goes: `Archives.sbd/2020` is ["Archives", "2020"]. Empty for a PST, which has its own. */
  folder: string[];
  name: string;
  size: number;
  lastModified: number;
  /** Maildir only. */
  messages?: number;
}

export interface LocalImportBook {
  handle: string;
  group: string;
  name: string;
  contacts: number;
}

export type LocalImportScanResult =
  | {
      ok: true;
      candidates: LocalImportCandidate[];
      books: LocalImportBook[];
      /** Seen and not offered. */
      refused: { name: string; reason: 'ost' | 'in-use' }[];
      /** Thunderbird calendars seen, which aren't read. */
      calendars: number;
      thunderbirdRunning: boolean;
      /** The search took too long and was stopped: this is what it found until then. */
      incomplete?: boolean;
    }
  | { ok: false; reason: 'declined' | 'busy' | 'failed' };

/** A file the user confirmed. `url` takes Range requests; a Maildir's messages are at `url/<position>`. */
export interface LocalImportFile {
  url: string;
  name: string;
  kind: LocalImportKind;
  folder: string[];
  size: number;
  lastModified: number;
  entrySizes?: number[];
}

export type LocalImportGrantResult =
  | {
      ok: true;
      jobId: string;
      files: LocalImportFile[];
      /** Contacts of the confirmed address books, as vCard text. */
      contacts: string[];
      /** Names that couldn't be read after all. */
      refused: string[];
      thunderbirdRunning: boolean;
    }
  | { ok: false; reason: 'declined' | 'busy' | 'invalid'; refused?: string[] };

export type LocalImportResumeResult =
  | Extract<LocalImportGrantResult, { ok: true }>
  /** `in-use`: none can be read right now, which may pass, so the job stays. `invalid`: they're gone, and so is the job. */
  | { ok: false; reason: 'later' | 'stopped' | 'busy' | 'invalid' | 'in-use' | 'unknown'; refused?: string[] };

export interface OsSettings {
  /** Closing the main window leaves the app running in the tray. */
  closeToTray: boolean;
  startAtLogin: boolean;
  /** At login: no window, only the tray. */
  startMinimized: boolean;
  /** Taskbar flash or dock bounce on new mail. */
  attentionOnNewMail: boolean;
  quietHoursEnabled: boolean;
  /** HH:MM, local time. */
  quietHoursStart: string;
  quietHoursEnd: string;
  /** "Show Bulwark", an Electron accelerator. Null: off. */
  showShortcut: string | null;
  /** Quick compose, an Electron accelerator. Null: off. Unset: nobody chose, so the policy's or the built-in one. */
  quickComposeShortcut?: string | null;
}

export interface QuickComposeStatus {
  /** What's in force after policy and the user's choice. Null: off. */
  shortcut: string | null;
  /** Really held. False with a shortcut: another app has it. */
  active: boolean;
  /** Set by the `QuickComposeShortcut` policy. */
  locked: boolean;
  /** What turning it on again gives. */
  builtIn: string | null;
}

export interface OsStatus {
  settings: OsSettings;
  pausedUntil: number | null;
  /** The shortcut in settings is really held. Another app can have it. */
  shortcutActive: boolean;
  quickCompose?: QuickComposeStatus;
}

export interface OsFile {
  name: string;
  data: Uint8Array;
}

/** What the OS asks the app to do: a tray item, a jump list entry, a toast, a double-clicked file. */
export type OsCommand =
  | { type: 'new-message' }
  | { type: 'navigate'; target: 'inbox' | 'calendar' | 'contacts' }
  | { type: 'open-message'; emailId: string; accountId?: string; context?: string }
  | { type: 'open-mailbox'; mailboxId: string }
  | { type: 'mailto'; url: string }
  | { type: 'webcal'; url: string }
  | { type: 'files'; reason: 'open' | 'attach'; files: OsFile[]; failed: string[] }
  | { type: 'notification'; action: string; context: string; reply?: string };

export interface OsNotification {
  /** Tag of the toast. Showing an id again within a few minutes does nothing. */
  id: string;
  group?: string;
  title: string;
  body: string;
  /** Handed back with the action. Keep it short: Windows keeps it in the toast. */
  context: string;
  actions?: { id: string; label: string }[];
  reply?: { label: string; placeholder: string };
  /** The user wants a sound with this. */
  sound?: boolean;
  /** New mail: flash the taskbar or bounce the dock if that's on. */
  attention?: boolean;
  /** What a locked app says instead: new mail unless this says otherwise. */
  kind?: 'mail' | 'reminder';
}

export interface OsNotifyResult {
  shown: boolean;
  reason?: 'duplicate' | 'paused' | 'quiet-hours' | 'focused' | 'unsupported' | 'invalid' | 'failed';
  /** The page should play the sound the user picked. */
  playSound: boolean;
}

export interface OsTrayMessage {
  emailId: string;
  accountId: string;
  sender: string;
  subject: string;
  context?: string;
}

export interface OsSummary {
  unread: OsTrayMessage[];
  /** Newest conversations, whether read or not, for the jump list. */
  recent: OsTrayMessage[];
  nextEvent: { title: string; when: string } | null;
  /** The account `unread` is from, when more than one is signed in. */
  account?: string;
}

export type OsPowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';

export interface OsDefaultAppStatus {
  /** Offered to the OS as a mail app. */
  registered: boolean;
  mailto: boolean;
  webcal: boolean;
}

export interface PrivacyState {
  telemetry: { on: boolean; forcedOff: boolean };
  crashReports: { on: boolean; forcedOff: boolean; uploadUrl: string };
}

export interface CrashFileInfo {
  id: string;
  createdAt: number;
  bytes: number;
}

export type CrashSendResult =
  | { ok: true }
  | { ok: false; reason: 'no-consent' | 'no-url' | 'not-found' | 'cancelled' | 'failed' };

/** An attachment copied to a private folder and open in its default program. */
export interface EditSession {
  id: string;
  name: string;
  type: string;
  /** The local account it belongs to. */
  account: string;
  /** What the page said it came from. Main only keeps it. */
  source: string;
  /** Saved differently from what the page last took. */
  changed: boolean;
  /** Goes up with each save. */
  version: number;
  /** What the file holds now: a chip holding this version has nothing to update. */
  hash: string;
  /** A composer has it and offers the update itself. */
  claimed: boolean;
  /** Wanted gone, and another program has it open. */
  held: boolean;
  /** Saved under a new name in that program. */
  savedAs: boolean;
  /** Not used for 30 days: this offer is the last. */
  lastChance: boolean;
}

/** What couldn't be deleted because another program has it open, by file name. `refused`: nothing happened. */
export interface EditClearResult {
  held: string[];
  refused?: boolean;
}

export interface EditFile {
  /** One session per key: Edit on the same attachment opens the same file. */
  key: string;
  name: string;
  type: string;
  data: Uint8Array;
  account: string;
  source: string;
}

export type EditBeginResult =
  /** One click, one ticket, for that key. A session for it exists: reopen this one. */
  | { ok: true; ticket: string; open?: string }
  | { ok: false; reason: 'locked' | 'gesture' };

export type EditOpenResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'locked' | 'ticket' | 'type' | 'too-large' | 'full' | 'no-app' | 'failed' };

export type EditReadResult =
  | { ok: true; name: string; type: string; data: Uint8Array; hash: string }
  | { ok: false; reason: 'locked' | 'missing' | 'busy' | 'too-large' };

/** IPC channels, all checked against the sender's origin in main (ipc.ts). */
export const CHANNEL = {
  windowsOpen: 'bulwark:windows.open',
  windowsOpenMessage: 'bulwark:windows.openMessage',
  windowsOpenComposer: 'bulwark:windows.openComposer',
  windowsFocus: 'bulwark:windows.focus',
  windowsList: 'bulwark:windows.list',
  windowsChanged: 'bulwark:windows.changed',
  themeSet: 'bulwark:theme.set',
  themeSystem: 'bulwark:theme.system',
  themeGetSystem: 'bulwark:theme.getSystem',
  windowsCloseSelf: 'bulwark:windows.closeSelf',
  windowsSetRestore: 'bulwark:windows.setRestore',
  windowsSetRestoreEnabled: 'bulwark:windows.setRestoreEnabled',
  windowsSessionReady: 'bulwark:windows.sessionReady',
  windowsSessionEnded: 'bulwark:windows.sessionEnded',
  windowsSpareReady: 'bulwark:windows.spareReady',
  windowsSpareActivate: 'bulwark:windows.spareActivate',
  windowsSpareTaken: 'bulwark:windows.spareTaken',
  menuSetState: 'bulwark:menu.setState',
  menuCommand: 'bulwark:menu.command',
  menuPopup: 'bulwark:menu.popup',
  menuBarEntries: 'bulwark:menu.barEntries',
  menuBarOpen: 'bulwark:menu.barOpen',
  menuBarEvent: 'bulwark:menu.barEvent',
  shellOpenExternal: 'bulwark:shell.openExternal',
  shellSetLanguages: 'bulwark:shell.setLanguages',
  dialogsConfirm: 'bulwark:dialogs.confirm',
  clipboardCopyFile: 'bulwark:clipboard.copyFile',
  clipboardClearFiles: 'bulwark:clipboard.clearFiles',
  spellMissing: 'bulwark:spell.missing',
  spellListMissing: 'bulwark:spell.listMissing',
  spellAllowDownload: 'bulwark:spell.allowDownload',
  serversPrepare: 'bulwark:servers.prepare',
  serversNoteSession: 'bulwark:servers.noteSession',
  serversForget: 'bulwark:servers.forget',
  lifecycleRegister: 'bulwark:lifecycle.register',
  lifecycleFlush: 'bulwark:lifecycle.flush',
  lifecycleFlushed: 'bulwark:lifecycle.flushed',
  authBegin: 'bulwark:auth.begin',
  authComplete: 'bulwark:auth.complete',
  authCancel: 'bulwark:auth.cancel',
  authUseScheme: 'bulwark:auth.useScheme',
  authPasswordBegin: 'bulwark:auth.password.begin',
  authPasswordNext: 'bulwark:auth.password.next',
  authPasswordAnswer: 'bulwark:auth.password.answer',
  authPasswordOutcome: 'bulwark:auth.password.outcome',
  pluginsInstall: 'bulwark:plugins.install',
  osSubscribe: 'bulwark:os.subscribe',
  osCommand: 'bulwark:os.command',
  osGetStatus: 'bulwark:os.getStatus',
  osSetSettings: 'bulwark:os.setSettings',
  osSetPaused: 'bulwark:os.setPaused',
  osStatusChanged: 'bulwark:os.statusChanged',
  osSetBadge: 'bulwark:os.setBadge',
  osSetSummary: 'bulwark:os.setSummary',
  osSetProgress: 'bulwark:os.setProgress',
  osSetLocked: 'bulwark:os.setLocked',
  osClearSurfaces: 'bulwark:os.clearSurfaces',
  osNotify: 'bulwark:os.notify',
  osPower: 'bulwark:os.power',
  osStartDrag: 'bulwark:os.startDrag',
  osCopyFiles: 'bulwark:os.copyFiles',
  osDefaultAppStatus: 'bulwark:os.defaultAppStatus',
  osDefaultAppOpen: 'bulwark:os.defaultAppOpen',
  editBegin: 'bulwark:edit.begin',
  editOpen: 'bulwark:edit.open',
  editReopen: 'bulwark:edit.reopen',
  editList: 'bulwark:edit.list',
  editSettle: 'bulwark:edit.settle',
  editRead: 'bulwark:edit.read',
  editTaken: 'bulwark:edit.taken',
  editRelease: 'bulwark:edit.release',
  editDiscard: 'bulwark:edit.discard',
  editForceDiscard: 'bulwark:edit.forceDiscard',
  editAskClear: 'bulwark:edit.askClear',
  editClear: 'bulwark:edit.clear',
  editWipe: 'bulwark:edit.wipe',
  editShown: 'bulwark:edit.shown',
  editSetSource: 'bulwark:edit.setSource',
  editClaim: 'bulwark:edit.claim',
  editChanged: 'bulwark:edit.changed',
  welcomeChoose: 'bulwark:welcome.choose',
  appLockStatus: 'bulwark:appLock.status',
  appLockLock: 'bulwark:appLock.lock',
  appLockEnroll: 'bulwark:appLock.enroll',
  appLockProve: 'bulwark:appLock.prove',
  appLockDisable: 'bulwark:appLock.disable',
  appLockForget: 'bulwark:appLock.forget',
  appLockClearOrphan: 'bulwark:appLock.clearOrphan',
  appLockOsEnroll: 'bulwark:appLock.osEnroll',
  appLockOsRemove: 'bulwark:appLock.osRemove',
  appLockOsUnlock: 'bulwark:appLock.osUnlock',
  appLockWrap: 'bulwark:appLock.wrap',
  appLockPinStep: 'bulwark:appLock.pinStep',
  appLockReplaceRenderer: 'bulwark:appLock.replaceRenderer',
  httpCacheClear: 'bulwark:httpCache.clear',
  localWipeRun: 'bulwark:localWipe.run',
  localWipeFinish: 'bulwark:localWipe.finish',
  appLockUnwrap: 'bulwark:appLock.unwrap',
  appLockRequest: 'bulwark:appLock.request',
  updatesState: 'bulwark:updates.state',
  updatesCheck: 'bulwark:updates.check',
  updatesSetChannel: 'bulwark:updates.setChannel',
  updatesRestart: 'bulwark:updates.restart',
  updatesOpenDownload: 'bulwark:updates.openDownload',
  updatesInstallOlder: 'bulwark:updates.installOlder',
  updatesChanged: 'bulwark:updates.changed',
  policyGet: 'bulwark:policy.get',
  policyChanged: 'bulwark:policy.changed',
  privacyGet: 'bulwark:privacy.get',
  privacySetTelemetry: 'bulwark:privacy.setTelemetry',
  privacySetCrashReports: 'bulwark:privacy.setCrashReports',
  privacySetCrashUploadUrl: 'bulwark:privacy.setCrashUploadUrl',
  privacyListCrashes: 'bulwark:privacy.listCrashes',
  privacySendCrash: 'bulwark:privacy.sendCrash',
  privacyDeleteCrashes: 'bulwark:privacy.deleteCrashes',
  privacyChanged: 'bulwark:privacy.changed',
  welcomePrivacy: 'bulwark:welcome.privacy',
  keystoreList: 'bulwark:keystore.list',
  keystoreSign: 'bulwark:keystore.sign',
  keystoreDecrypt: 'bulwark:keystore.decrypt',
  keystoreAgree: 'bulwark:keystore.agree',
  keystoreAccess: 'bulwark:keystore.access',
  keystoreRevoke: 'bulwark:keystore.revoke',
  keystoreClearGrants: 'bulwark:keystore.clearGrants',
  certificatesClearChoices: 'bulwark:certificates.clearChoices',
  certificatesSetAccount: 'bulwark:certificates.setAccount',
  certificatesConnectionsReset: 'bulwark:certificates.connectionsReset',
  localImportScan: 'bulwark:localImport.scan',
  localImportGrant: 'bulwark:localImport.grant',
  localImportResume: 'bulwark:localImport.resume',
  localImportRelease: 'bulwark:localImport.release',
  localImportReleaseAll: 'bulwark:localImport.releaseAll',
} as const;

/** What main passes to the preload through additionalArguments. */
export const PRELOAD_ARG = {
  allowedOrigin: '--bulwark-origin=',
  mode: '--bulwark-mode=',
  keystore: '--bulwark-keystore=',
} as const;
