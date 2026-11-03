/**
 * The bridge contract: the shell's copy of lib/desktop/types.ts in the webmail.
 * Add a member in both places together. A breaking change bumps
 * BRIDGE_VERSION; adding a member doesn't.
 */

export const BRIDGE_VERSION = 1;

export type WindowType = 'main' | 'message' | 'composer' | 'settings';

export interface WindowInfo {
  id: number;
  type: WindowType;
  title: string;
  focused: boolean;
}

export type Mode = 'standalone' | 'instance';

export type ServerPrepareResult =
  | { ok: true; approved: boolean }
  | { ok: false; reason: 'declined' | 'invalid' };

export type BrowserSignInResult =
  | { ok: true; code: string; state: string }
  | { ok: false; error: string };

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
}

export type MenuState = Record<string, boolean | { enabled?: boolean; checked?: boolean }>;

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

/** How main answers a keystore call. The preload turns a failure into `new Error(code)`. */
export type KeystoreResult<T> = { ok: true; value: T } | { ok: false; code: string };

export interface SessionUrls {
  apiUrl?: string;
  downloadUrl?: string;
  uploadUrl?: string;
  eventSourceUrl?: string;
}

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
}

export interface OsStatus {
  settings: OsSettings;
  pausedUntil: number | null;
  /** The shortcut in settings is really held. Another app can have it. */
  shortcutActive: boolean;
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
}

export type OsPowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';

export interface OsDefaultAppStatus {
  /** Offered to the OS as a mail app. */
  registered: boolean;
  mailto: boolean;
  webcal: boolean;
}

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
  menuSetState: 'bulwark:menu.setState',
  shellOpenExternal: 'bulwark:shell.openExternal',
  serversPrepare: 'bulwark:servers.prepare',
  serversNoteSession: 'bulwark:servers.noteSession',
  serversForget: 'bulwark:servers.forget',
  lifecycleRegister: 'bulwark:lifecycle.register',
  lifecycleFlush: 'bulwark:lifecycle.flush',
  lifecycleFlushed: 'bulwark:lifecycle.flushed',
  authBegin: 'bulwark:auth.begin',
  authComplete: 'bulwark:auth.complete',
  authCancel: 'bulwark:auth.cancel',
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
  welcomeChoose: 'bulwark:welcome.choose',
  keystoreList: 'bulwark:keystore.list',
  keystoreSign: 'bulwark:keystore.sign',
  keystoreDecrypt: 'bulwark:keystore.decrypt',
  keystoreAgree: 'bulwark:keystore.agree',
  keystoreAccess: 'bulwark:keystore.access',
  keystoreRevoke: 'bulwark:keystore.revoke',
} as const;

/** What main passes to the preload through additionalArguments. */
export const PRELOAD_ARG = {
  allowedOrigin: '--bulwark-origin=',
  mode: '--bulwark-mode=',
  keystore: '--bulwark-keystore=',
} as const;
