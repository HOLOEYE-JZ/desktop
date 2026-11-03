/**
 * The decisions of the OS integration with nothing of Electron in them, so they
 * can be tested as they are: what a command line asks for, whether it's quiet now,
 * what a toast says, what goes in the registry.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeepLink, type WindowLink } from '../deep-link';
import type { OsCommand, OsSettings } from '../../shared/bridge';

export const DEFAULT_SHOW_SHORTCUT = 'CommandOrControl+Shift+B';
/** Same as HANDOFF_MAX_BYTES in the webmail: it wouldn't take more. */
export const MAX_LAUNCH_FILE_BYTES = 100 * 1024 * 1024;
const MAX_URL_LENGTH = 8192;

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

/** Ctrl+Alt+N, Cmd+Opt+N. */
export const QUICK_COMPOSE_SHORTCUT = 'CommandOrControl+Alt+N';

/**
 * Windows reads AltGr as Ctrl+Alt, and on Polish and Latvian keyboards AltGr+N types a
 * letter (ń, ņ), which a global shortcut would take away from every app. The system's
 * language stands in for the keyboard, since Electron can't ask for the layout. Neither
 * has a letter on M.
 */
export function quickComposeBuiltIn(platform: string, systemLocale: string): string {
  return platform === 'win32' && /^(pl|lv)\b/i.test(systemLocale) ? 'CommandOrControl+Alt+M' : QUICK_COMPOSE_SHORTCUT;
}

/**
 * The shortcut in force, or null for none. A forced policy decides. Otherwise the user's
 * choice, where off counts as a choice, then a recommendation, then what's built in.
 */
export function quickComposeShortcut(policy: { value: string | null; locked: boolean }, choice: string | null | undefined, builtIn: string | null = QUICK_COMPOSE_SHORTCUT): string | null {
  const chosen = policy.locked ? policy.value : choice === undefined ? (policy.value ?? builtIn) : choice;
  return !chosen || chosen.toLowerCase() === 'off' ? null : chosen;
}

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
  if (input.quickComposeShortcut === null) out.quickComposeShortcut = null;
  else if (isAccelerator(input.quickComposeShortcut)) out.quickComposeShortcut = input.quickComposeShortcut;
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

/** A mailto: or webcal: link. bulwark: links have their one parser, src/main/deep-link.ts. */
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
  return null;
}

/**
 * What a URL handed to the app means. Anyone can put a bulwark: link on a page, so
 * these only ever show something: nothing here changes mail.
 */
export function requestFromUrl(raw: string): { commands: OsCommand[]; links: WindowLink[] } {
  const link = parseDeepLink(raw);
  if (!link) {
    const command = commandFromUrl(raw);
    return { commands: command ? [command] : [], links: [] };
  }
  if (link.kind === 'new') return { commands: [{ type: 'new-message' }], links: [] };
  if (link.kind === 'view') return { commands: [{ type: 'navigate', target: link.view }], links: [] };
  return { commands: [], links: [link] };
}

export interface LaunchRequest {
  commands: OsCommand[];
  /** bulwark: links main opens itself. */
  links: WindowLink[];
  /** Files named on the command line, absolute. Whether they exist is checked when read. */
  files: string[];
  /** The login item's flag. */
  fromLogin: boolean;
  /** A toast's button or click, as handed to us. Checked before anything is done with it. */
  toastUrls: string[];
}

const OPENABLE = new Set(['.eml', '.ics', '.vcf']);

export function fileReason(file: string): 'open' | 'attach' {
  return OPENABLE.has(path.extname(file).toLowerCase()) ? 'open' : 'attach';
}

/** Only a development run has its script on the command line. There, argv[1] may be a user's file. */
export function launchSkipPaths(defaultApp: boolean, appPath: string, argv1: string | undefined): string[] {
  return defaultApp ? [appPath, argv1 ?? ''].filter(Boolean) : [];
}

/**
 * What a command line asks for. Chromium's and our own switches, the program and its
 * script are not requests. Past a bare `--` nothing is a switch, which is how the
 * registered handlers pass a URL.
 *
 * A URL stands alone. A handler gets one, so anything next to it came from a link broken
 * up on its spaces, and must not attach a local file. File managers on Linux hand over
 * file: URLs, which are files.
 */
export function parseArgv(
  argv: readonly string[],
  options: { cwd: string; skip: readonly string[]; platform?: NodeJS.Platform },
): LaunchRequest {
  const request: LaunchRequest = { commands: [], links: [], files: [], fromLogin: false, toastUrls: [] };
  const skipped = new Set(options.skip.map((entry) => path.resolve(options.cwd, entry).toLowerCase()));
  const platform = options.platform ?? process.platform;
  let positional = false;
  let urlFound = false;
  const files: string[] = [];
  for (const arg of argv.slice(1)) {
    if (!positional && arg === '--') {
      positional = true;
      continue;
    }
    if (!positional && arg === LOGIN_FLAG) {
      request.fromLogin = true;
      continue;
    }
    if (!positional && arg.startsWith('-')) continue;
    if (!arg) continue;
    if (platform === 'linux' && /^file:\/\//i.test(arg)) {
      try {
        const file = fileURLToPath(arg, { windows: false });
        if (!skipped.has(file.toLowerCase())) files.push(file);
      } catch {
        // A file: URL naming another host: no local file.
      }
      continue;
    }
    if (/^[a-z][a-z0-9+.-]+:/i.test(arg) && !/^[a-z]:[\\/]/i.test(arg)) {
      if (urlFound) continue;
      urlFound = true;
      if (arg.toLowerCase().startsWith(TOAST_URL_PREFIX)) {
        request.toastUrls.push(arg);
        continue;
      }
      const asked = requestFromUrl(arg);
      request.commands.push(...asked.commands);
      request.links.push(...asked.links);
      continue;
    }
    const resolved = path.resolve(options.cwd, arg);
    if (!skipped.has(resolved.toLowerCase())) files.push(resolved);
  }
  if (!urlFound) request.files = files;
  return request;
}

export const LOGIN_FLAG = '--bulwark-from-login';

// Windows reserves these with any extension, and with spaces before it: "con .txt".
const RESERVED_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])\s*(\..*)?$/i;

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

/**
 * A file that runs something by being opened, and that Windows doesn't warn about the way it
 * does for an executable from the internet. Kept readable, not active.
 */
const RISKY_EXTENSIONS = new Set(['.lnk', '.url', '.scf', '.library-ms', '.search-ms', '.searchconnector-ms', '.appref-ms', '.website', '.desktop']);

export function safeDragFileName(name: unknown): string {
  const clean = safeFileName(name);
  return RISKY_EXTENSIONS.has(path.extname(clean).toLowerCase()) ? `${clean}.txt` : clean;
}

function xml(raw: string): string {
  // A lone surrogate from a cut-off subject would make the whole toast invalid XML.
  const text = (raw as string & { toWellFormed(): string }).toWellFormed();
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, (c: string) => `&#${c.charCodeAt(0)};`);
}

export const REPLY_INPUT = 'reply';
const TOAST_ARGS_PREFIX = 'bulwark:';
const TOAST_URL_PREFIX = 'bulwark://toast/';

function toastSignature(action: string, context: string, secret: string): string {
  return createHmac('sha256', secret).update(`${action}\n${context}`).digest('base64url');
}

/**
 * A toast's click or button as a URL Windows opens for us, app running or not. Unlike every
 * other bulwark: link this one does something to mail, and a web page can link to it too,
 * so it's signed with a key of this install that no page ever sees.
 */
export function toastUrl(action: string, context: string, secret: string): string {
  return `${TOAST_URL_PREFIX}${encodeURIComponent(action)}?c=${encodeURIComponent(context)}&s=${toastSignature(action, context, secret)}`;
}

export function parseToastUrl(raw: string, secret: string): { action: string; context: string } | null {
  if (raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'bulwark:' || url.hostname !== 'toast') return null;
  let action: string;
  try {
    action = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
  const context = url.searchParams.get('c') ?? '';
  const given = Buffer.from(url.searchParams.get('s') ?? '');
  const wanted = Buffer.from(toastSignature(action, context, secret));
  if (!action || given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  return { action, context };
}

/** A typed reply: only Windows' activator can carry the text. Survives a restart, so it's all in here. */
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
 * nothing to go on after a restart.
 *
 * Click and buttons are protocol activations, because that also works when the app isn't
 * running: Electron's activator only answers once this process has shown a toast, and
 * COM gave up on a cold start here (decisions, OS integration).
 *
 * Typed text only travels through the activator, so the field is only there when that's
 * known to answer: `inlineReply`, after this process has shown a toast. Otherwise Reply is a
 * button that opens the composer, so nothing typed can be lost.
 */
export function buildToastXml(toast: ToastContent, secret: string, inlineReply: boolean): string {
  let reply = '';
  if (toast.reply && inlineReply) {
    reply = `<input id="${REPLY_INPUT}" type="text" placeHolderContent="${xml(toast.reply.placeholder)}"/><action content="${xml(toast.reply.label)}" hint-inputId="${REPLY_INPUT}" activationType="foreground" arguments="${xml(toastArguments('reply', toast.context))}"/>`;
  } else if (toast.reply) {
    reply = `<action content="${xml(toast.reply.label)}" activationType="protocol" arguments="${xml(toastUrl('reply', toast.context, secret))}"/>`;
  }
  const buttons = toast.actions
    .slice(0, toast.reply ? 4 : 5)
    .map((action) => `<action content="${xml(action.label)}" activationType="protocol" arguments="${xml(toastUrl(action.id, toast.context, secret))}"/>`)
    .join('');
  const actions = reply || buttons ? `<actions>${reply}${buttons}</actions>` : '';
  const audio = toast.silent ? '<audio silent="true"/>' : '';
  const body = toast.body ? `<text>${xml(toast.body)}</text>` : '';
  return `<toast launch="${xml(toastUrl('open', toast.context, secret))}" activationType="protocol"><visual><binding template="ToastGeneric"><text>${xml(toast.title)}</text>${body}</binding></visual>${actions}${audio}</toast>`;
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

export const WINDOWS_URLS: Record<string, string> = { mailto: 'Bulwark.Url.mailto', webcal: 'Bulwark.Url.webcal', webcals: 'Bulwark.Url.webcal' };
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

/** An uninstall takes the keys, and a reinstall to the same path must still put them back. */
export function needsRegistration(handlerQuery: { ok: boolean; stdout: string }, exe: string): boolean {
  return !handlerQuery.ok || !handlerQuery.stdout.toLowerCase().includes(`"${exe.toLowerCase()}"`);
}

/** How long a failed main window waits before it tries again. */
export function reloadDelayMs(attempt: number): number {
  return [2000, 5000, 15_000, 30_000, 60_000][Math.min(attempt, 4)];
}

/** Network errors: worth another try. -3 is a navigation that was replaced; -200 and on are certificates. */
export function isRetryableLoadError(code: number): boolean {
  return code !== -3 && code < 0 && code > -200;
}

/** Keys taken away again, deepest first. The `.eml` keys belong to everyone: only our value goes. */
export function windowsRegistrationKeys(): { keys: string[]; values: { key: string; name: string }[] } {
  return {
    keys: [...new Set(Object.values(WINDOWS_URLS)), ...Object.values(WINDOWS_FILES), 'bulwark'].map((id) => `${CLASSES}\\${id}`).concat('Software\\Bulwark'),
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
