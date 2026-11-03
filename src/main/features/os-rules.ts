/**
 * The decisions of the OS integration with nothing of Electron in them, so they
 * can be tested as they are: what a command line asks for, whether it's quiet now,
 * what a toast says, what goes in the registry.
 */

import path from 'node:path';
import type { OsCommand, OsSettings } from '../../shared/bridge';

export const DEFAULT_SHOW_SHORTCUT = 'CommandOrControl+Shift+B';
/** Same as HANDOFF_MAX_BYTES in the webmail: it wouldn't take more. */
export const MAX_LAUNCH_FILE_BYTES = 100 * 1024 * 1024;
const MAX_URL_LENGTH = 8192;
const MAX_ID_LENGTH = 512;

export function defaultSettings(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): OsSettings {
  // Plain GNOME has no tray at all: closing into nothing would look like a quit that isn't one.
  const desktop = (env.XDG_CURRENT_DESKTOP ?? '').toLowerCase();
  const noTray = platform === 'linux' && desktop.includes('gnome') && !desktop.includes('ubuntu');
  return {
    closeToTray: !noTray,
    startAtLogin: false,
    startMinimized: false,
    attentionOnNewMail: true,
    quietHoursEnabled: false,
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
    showShortcut: null,
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// Modifiers and one key. Electron's register throws on anything it can't parse; this
// keeps a page from storing something that fails on every later start.
const ACCELERATOR = /^(?:(?:CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|AltGr|Shift|Super|Meta)\+)+[A-Za-z0-9]{1,3}$/;

export function isAccelerator(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && ACCELERATOR.test(value);
}

/** What a page may change: known keys of the right type, nothing else. */
export function cleanSettingsPatch(patch: unknown): Partial<OsSettings> {
  const input = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const out: Partial<OsSettings> = {};
  for (const key of ['closeToTray', 'startAtLogin', 'startMinimized', 'attentionOnNewMail', 'quietHoursEnabled'] as const) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  for (const key of ['quietHoursStart', 'quietHoursEnd'] as const) {
    const value = input[key];
    if (typeof value === 'string' && TIME.test(value)) out[key] = value;
  }
  if (input.showShortcut === null) out.showShortcut = null;
  else if (isAccelerator(input.showShortcut)) out.showShortcut = input.showShortcut;
  return out;
}

function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** Start and end in local time. Across midnight works; equal times mean no quiet hours. */
export function inQuietHours(settings: Pick<OsSettings, 'quietHoursEnabled' | 'quietHoursStart' | 'quietHoursEnd'>, now: Date): boolean {
  if (!settings.quietHoursEnabled) return false;
  const start = minutesOf(settings.quietHoursStart);
  const end = minutesOf(settings.quietHoursEnd);
  const current = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export type FocusAssist = 'off' | 'priority' | 'alarms' | 'fullscreen';

/**
 * The state of Windows' Do Not Disturb, from the one-line answer of the check in
 * os-toasts.ts: `<profile> <quns>`. WNF profile 1 is priority only, 2 alarms only.
 * SHQueryUserNotificationState: 2 busy (full screen), 3 Direct3D full screen, 4
 * presentation, 6 quiet time. An answer that can't be read counts as off: Windows
 * still holds the toast itself, and only our own sound depends on this.
 */
export function parseFocusAssist(output: string): FocusAssist {
  const match = /^\s*(-?\d+)\s+(-?\d+)\s*$/.exec(output);
  if (!match) return 'off';
  const profile = Number(match[1]);
  const quns = Number(match[2]);
  if (profile === 2) return 'alarms';
  if (profile === 1) return 'priority';
  if (quns === 2 || quns === 3 || quns === 4 || quns === 6) return 'fullscreen';
  return 'off';
}

const ids = (...values: string[]) => values.every((value) => value.length > 0 && value.length <= MAX_ID_LENGTH);

/**
 * What a URL handed to the app means. Anyone can put a bulwark: link on a page, so
 * these only ever show something: nothing here changes mail.
 */
export function commandFromUrl(raw: string): OsCommand | null {
  if (raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'mailto:') return { type: 'mailto', url: raw };
  if (url.protocol === 'webcal:' || url.protocol === 'webcals:') return { type: 'webcal', url: raw };
  if (url.protocol !== 'bulwark:') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    return null;
  }
  switch (url.hostname) {
    case 'new':
      return { type: 'new-message' };
    case 'inbox':
    case 'calendar':
    case 'contacts':
      return { type: 'navigate', target: url.hostname };
    case 'message':
      return decoded.length === 2 && ids(decoded[0], decoded[1]) ? { type: 'open-message', accountId: decoded[0], emailId: decoded[1] } : null;
    case 'mailbox':
      return decoded.length === 1 && ids(decoded[0]) ? { type: 'open-mailbox', mailboxId: decoded[0] } : null;
    default:
      return null;
  }
}

export interface LaunchRequest {
  commands: OsCommand[];
  /** Files named on the command line, absolute. Whether they exist is checked when read. */
  files: string[];
  /** The login item's flag. */
  fromLogin: boolean;
  /** COM's flag for a server it started: a button on a toast of an app that wasn't running. */
  startedByToast: boolean;
}

const OPENABLE = new Set(['.eml', '.ics', '.vcf']);

export function fileReason(file: string): 'open' | 'attach' {
  return OPENABLE.has(path.extname(file).toLowerCase()) ? 'open' : 'attach';
}

/**
 * What a command line asks for. Chromium's and our own switches, the program and its
 * script are not requests. Past a bare `--` nothing is a switch, which is how the
 * registered handlers pass a URL.
 */
export function parseArgv(argv: readonly string[], options: { cwd: string; skip: readonly string[] }): LaunchRequest {
  const request: LaunchRequest = { commands: [], files: [], fromLogin: false, startedByToast: false };
  const skipped = new Set(options.skip.map((entry) => path.resolve(options.cwd, entry).toLowerCase()));
  let positional = false;
  for (const arg of argv.slice(1)) {
    if (!positional && arg === '--') {
      positional = true;
      continue;
    }
    if (!positional && arg === LOGIN_FLAG) {
      request.fromLogin = true;
      continue;
    }
    if (!positional && arg.toLowerCase() === COM_FLAG) {
      request.startedByToast = true;
      continue;
    }
    if (!positional && arg.startsWith('-')) continue;
    if (!arg) continue;
    if (/^[a-z][a-z0-9+.-]+:/i.test(arg) && !/^[a-z]:[\\/]/i.test(arg)) {
      const command = commandFromUrl(arg);
      if (command) request.commands.push(command);
      continue;
    }
    const resolved = path.resolve(options.cwd, arg);
    if (!skipped.has(resolved.toLowerCase())) request.files.push(resolved);
  }
  return request;
}

export const LOGIN_FLAG = '--bulwark-from-login';
const COM_FLAG = '-embedding';

const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A name that's safe to create on every OS. Never a path. */
export function safeFileName(name: unknown, fallback = 'file'): string {
  const raw = typeof name === 'string' ? name : '';
  // eslint-disable-next-line no-control-regex
  let clean = raw.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').replace(/[‪-‮⁦-⁩]/g, '').trim();
  clean = clean.replace(/[. ]+$/, '').replace(/^\.+/, '');
  if (!clean) clean = fallback;
  if (RESERVED_NAME.test(clean)) clean = `_${clean}`;
  if (clean.length > 150) {
    const ext = path.extname(clean).slice(0, 16);
    clean = clean.slice(0, 150 - ext.length) + ext;
  }
  return clean;
}

function xml(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export const REPLY_INPUT = 'reply';
const TOAST_ARGS_PREFIX = 'bulwark:';

/** What a toast hands back when pressed: survives a restart of the app, so it's all in here. */
export function toastArguments(action: string, context: string): string {
  return `${TOAST_ARGS_PREFIX}${encodeURIComponent(action)}:${encodeURIComponent(context)}`;
}

export function parseToastArguments(args: string): { action: string; context: string } | null {
  if (!args.startsWith(TOAST_ARGS_PREFIX)) return null;
  const rest = args.slice(TOAST_ARGS_PREFIX.length);
  const split = rest.indexOf(':');
  if (split < 1) return null;
  try {
    return { action: decodeURIComponent(rest.slice(0, split)), context: decodeURIComponent(rest.slice(split + 1)) };
  } catch {
    return null;
  }
}

export interface ToastContent {
  title: string;
  body: string;
  silent: boolean;
  context: string;
  actions: { id: string; label: string }[];
  reply?: { label: string; placeholder: string };
}

/**
 * The Windows toast. Electron's own `actions` only know a button's index, which is
 * nothing to go on after a restart; `arguments` here reach Notification.handleActivation
 * as they are, for a toast still in the Action Center too. `foreground` is what Electron's
 * activator is tried with, and handing the app focus stays its choice.
 */
export function buildToastXml(toast: ToastContent): string {
  const reply = toast.reply
    ? `<input id="${REPLY_INPUT}" type="text" placeHolderContent="${xml(toast.reply.placeholder)}"/><action content="${xml(toast.reply.label)}" hint-inputId="${REPLY_INPUT}" activationType="foreground" arguments="${xml(toastArguments('reply', toast.context))}"/>`
    : '';
  const buttons = toast.actions
    .slice(0, toast.reply ? 4 : 5)
    .map((action) => `<action content="${xml(action.label)}" activationType="foreground" arguments="${xml(toastArguments(action.id, toast.context))}"/>`)
    .join('');
  const actions = reply || buttons ? `<actions>${reply}${buttons}</actions>` : '';
  const audio = toast.silent ? '<audio silent="true"/>' : '';
  const body = toast.body ? `<text>${xml(toast.body)}</text>` : '';
  return `<toast launch="${xml(toastArguments('open', toast.context))}" activationType="foreground"><visual><binding template="ToastGeneric"><text>${xml(toast.title)}</text>${body}</binding></visual>${actions}${audio}</toast>`;
}

export const WINDOWS_APP_NAME = 'Bulwark';
export const WINDOWS_CAPABILITIES = 'Software\\Bulwark\\Capabilities';

export interface RegistryValue {
  key: string;
  /** Absent: the key's default value. */
  name?: string;
  data: string;
}

const CLASSES = 'Software\\Classes';

/** A handled URL scheme or file type, in the class it's registered as. */
function progId(id: string, description: string, exe: string, url: boolean): RegistryValue[] {
  const key = `${CLASSES}\\${id}`;
  return [
    { key, data: description },
    ...(url ? [{ key, name: 'URL Protocol', data: '' }] : []),
    { key: `${key}\\DefaultIcon`, data: `${exe},0` },
    { key: `${key}\\shell\\open\\command`, data: `"${exe}" -- "%1"` },
  ];
}

export const WINDOWS_URLS: Record<string, string> = { mailto: 'Bulwark.Url.mailto', webcal: 'Bulwark.Url.webcal' };
export const WINDOWS_FILES: Record<string, string> = { '.eml': 'Bulwark.File.eml', '.ics': 'Bulwark.File.ics', '.vcf': 'Bulwark.File.vcf' };

/**
 * Under HKCU, so no elevation. This only offers Bulwark: which app is the default
 * stays the user's choice in Settings, which reads RegisteredApplications.
 */
export function windowsRegistration(exe: string): RegistryValue[] {
  const caps = WINDOWS_CAPABILITIES;
  return [
    { key: caps, name: 'ApplicationName', data: WINDOWS_APP_NAME },
    { key: caps, name: 'ApplicationDescription', data: 'Mail, calendar and contacts' },
    { key: caps, name: 'ApplicationIcon', data: `${exe},0` },
    ...Object.entries(WINDOWS_URLS).map(([scheme, id]) => ({ key: `${caps}\\UrlAssociations`, name: scheme, data: id })),
    ...Object.entries(WINDOWS_FILES).map(([ext, id]) => ({ key: `${caps}\\FileAssociations`, name: ext, data: id })),
    { key: 'Software\\RegisteredApplications', name: WINDOWS_APP_NAME, data: caps },
    ...progId(WINDOWS_URLS.mailto, 'URL:MailTo Protocol', exe, true),
    ...progId(WINDOWS_URLS.webcal, 'URL:Webcal Protocol', exe, true),
    ...progId('bulwark', 'URL:Bulwark Protocol', exe, true),
    ...progId(WINDOWS_FILES['.eml'], 'E-mail message', exe, false),
    ...progId(WINDOWS_FILES['.ics'], 'Calendar file', exe, false),
    ...progId(WINDOWS_FILES['.vcf'], 'Contact card', exe, false),
    // Lets "Open with" offer Bulwark before anyone sets a default.
    ...Object.entries(WINDOWS_FILES).map(([ext, id]) => ({ key: `${CLASSES}\\${ext}\\OpenWithProgids`, name: id, data: '' })),
  ];
}

/** Keys taken away again, deepest first. The `.eml` keys belong to everyone: only our value goes. */
export function windowsRegistrationKeys(): { keys: string[]; values: { key: string; name: string }[] } {
  return {
    keys: [...Object.values(WINDOWS_URLS), ...Object.values(WINDOWS_FILES), 'bulwark'].map((id) => `${CLASSES}\\${id}`).concat('Software\\Bulwark'),
    values: [
      { key: 'Software\\RegisteredApplications', name: WINDOWS_APP_NAME },
      ...Object.entries(WINDOWS_FILES).map(([ext, id]) => ({ key: `${CLASSES}\\${ext}\\OpenWithProgids`, name: id })),
    ],
  };
}

/** The autostart entry where the OS has no login item API. */
export function linuxAutostartEntry(exec: string): string {
  return `[Desktop Entry]\nType=Application\nName=Bulwark\nExec=${exec} ${LOGIN_FLAG}\nIcon=bulwark\nX-GNOME-Autostart-enabled=true\nHidden=false\nNoDisplay=false\n`;
}
