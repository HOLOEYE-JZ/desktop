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
  /** False for a main window hidden while pop-outs are open. */
  visible?: boolean;
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
  /** The OS accent colour as #rrggbb, where the OS has one and tells. */
  accent?: string;
}

export type MenuState = Record<string, boolean | { enabled?: boolean; checked?: boolean }>;

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
}

export interface SessionUrls {
  apiUrl?: string;
  downloadUrl?: string;
  uploadUrl?: string;
  eventSourceUrl?: string;
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
  themeGetSystem: 'bulwark:theme.getSystem',
  windowsCloseSelf: 'bulwark:windows.closeSelf',
  windowsSetRestore: 'bulwark:windows.setRestore',
  windowsSetRestoreEnabled: 'bulwark:windows.setRestoreEnabled',
  windowsSessionReady: 'bulwark:windows.sessionReady',
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
} as const;

/** What main passes to the preload through additionalArguments. */
export const PRELOAD_ARG = {
  allowedOrigin: '--bulwark-origin=',
  mode: '--bulwark-mode=',
} as const;
