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
  reason?: 'duplicate' | 'paused' | 'quiet-hours' | 'focused' | 'unsupported' | 'invalid';
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
  osNotify: 'bulwark:os.notify',
  osPower: 'bulwark:os.power',
  osStartDrag: 'bulwark:os.startDrag',
  osCopyFiles: 'bulwark:os.copyFiles',
  osDefaultAppStatus: 'bulwark:os.defaultAppStatus',
  osDefaultAppOpen: 'bulwark:os.defaultAppOpen',
  welcomeChoose: 'bulwark:welcome.choose',
} as const;

/** What main passes to the preload through additionalArguments. */
export const PRELOAD_ARG = {
  allowedOrigin: '--bulwark-origin=',
  mode: '--bulwark-mode=',
} as const;
