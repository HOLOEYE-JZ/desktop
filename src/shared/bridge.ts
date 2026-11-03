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
}

export type Mode = 'standalone' | 'instance';

export type ServerPrepareResult =
  | { ok: true; approved: boolean }
  | { ok: false; reason: 'declined' | 'invalid' | 'policy' };

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

export interface PolicyBridge {
  /** What's in force now. Synchronous: a page can read it in its first render. */
  get: () => PolicySnapshot;
  onChange: (listener: (snapshot: PolicySnapshot) => void) => () => void;
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
    }
  | { ok: false; reason: 'declined' | 'busy' };

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
  | { ok: false; reason: 'later' | 'stopped' | 'busy' | 'invalid' | 'unknown'; refused?: string[] };

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
  welcomeChoose: 'bulwark:welcome.choose',
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
