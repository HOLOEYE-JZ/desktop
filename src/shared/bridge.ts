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

export type MenuState = Record<string, boolean | { enabled?: boolean; checked?: boolean }>;

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
  updatesState: 'bulwark:updates.state',
  updatesCheck: 'bulwark:updates.check',
  updatesSetChannel: 'bulwark:updates.setChannel',
  updatesRestart: 'bulwark:updates.restart',
  updatesOpenDownload: 'bulwark:updates.openDownload',
  updatesInstallOlder: 'bulwark:updates.installOlder',
  updatesChanged: 'bulwark:updates.changed',
} as const;

/** What main passes to the preload through additionalArguments. */
export const PRELOAD_ARG = {
  allowedOrigin: '--bulwark-origin=',
  mode: '--bulwark-mode=',
} as const;
