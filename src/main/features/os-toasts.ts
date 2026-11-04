/**
 * Native notifications.
 *
 * Windows, as tried on an unsigned, uninstalled build: Electron's own toast activator
 * needs nothing from us beyond a stable CLSID. It writes a Start Menu shortcut and
 * HKCU\Software\Classes\CLSID\{...}\LocalServer32 itself, and once this process has
 * shown a toast it answers COM: a typed reply reaches Notification.handleActivation.
 * Started by COM for a toast from before, it never answered, so click and buttons go by
 * protocol (buildToastXml). Left to itself the CLSID changes every run, and each run
 * would leave another key behind.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { app, BrowserWindow, Notification } from 'electron';
import type { OsNotification, OsNotifyResult } from '../../shared/bridge';
import { LinkRateLimit } from '../deep-link';
import { strings } from '../strings';
import { systemExe } from '../system-exe';
import type { OsHub } from './os-hub';
import { buildToastXml, inQuietHours, parseFocusAssist, parseToastArguments, REPLY_INPUT, type FocusAssist } from './os-rules';
import { isInstalledBuild } from '../installed';

export const TOAST_CLSID = '{7B1E4F2A-93C6-4D0E-A5B8-2F6C1D9E3A47}';
// A development run points LocalServer32 at electron.exe: not over an installed app's.
export const DEV_TOAST_CLSID = '{C2D85A16-4E7B-4F39-8A10-6B3E9F72D154}';
const REPEAT_MS = 10 * 60 * 1000;
/** Windows has taken a toast long before this. No word by then counts as shown. */
const SHOW_WAIT_MS = 1500;
const FOCUS_ASSIST_TTL_MS = 60 * 1000;
const FOCUS_ASSIST_TIMEOUT_MS = 3000;
/** Windows shows five at most. A typed reply takes one of them: buildToastXml. */
const MAX_ACTIONS = 5;
/**
 * A toast shows under the app's name with whatever text the page gives, so a plugin that reaches
 * the bridge can pretend to be the app. Mail comes in batches and reminders are few: this only
 * stops a flood of them. Callers treat it as a toast that failed, and reminders hold for later.
 */
const TOASTS_PER_MINUTE = 12;

export function setToastActivator(): void {
  app.setToastActivatorCLSID(isInstalledBuild() ? TOAST_CLSID : DEV_TOAST_CLSID);
}

/** Do Not Disturb's profile (WNF) and the shell's notification state. PowerShell because Electron has no call for either. */
const FOCUS_ASSIST_SCRIPT = `
Add-Type -Namespace B -Name F -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtQueryWnfStateData(ref ulong n, IntPtr t, IntPtr s, out uint c, byte[] b, ref uint z); [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s);'
$n = [uint64]"0xD83063EA3BF1C75"; $b = New-Object byte[] 4; [uint32]$z = 4; [uint32]$c = 0; $q = 0
[void][B.F]::NtQueryWnfStateData([ref]$n, [IntPtr]::Zero, [IntPtr]::Zero, [ref]$c, $b, [ref]$z)
[void][B.F]::SHQueryUserNotificationState([ref]$q)
Write-Output ("{0} {1}" -f [BitConverter]::ToInt32($b, 0), $q)
`;

function runFocusAssistCheck(): Promise<FocusAssist> {
  const encoded = Buffer.from(FOCUS_ASSIST_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      systemExe('powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: FOCUS_ASSIST_TIMEOUT_MS },
      (error, stdout) => resolve(error ? 'off' : parseFocusAssist(stdout)),
    );
  });
}

function runLinuxQuietCheck(): Promise<FocusAssist> {
  return new Promise((resolve) => {
    execFile('/usr/bin/gsettings', ['get', 'org.gnome.desktop.notifications', 'show-banners'], { timeout: FOCUS_ASSIST_TIMEOUT_MS }, (error, stdout) => {
      resolve(!error && stdout.trim() === 'false' ? 'alarms' : 'off');
    });
  });
}

export interface ToastHandle {
  notify: (request: unknown) => Promise<OsNotifyResult>;
  focusAssist: () => Promise<FocusAssist>;
  setFocusAssistForTest: (value: FocusAssist | null) => void;
  /** `onClick`: what a click does; without it, the main window shows. */
  showNotice: (title: string, body: string, onClick?: () => void) => void;
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function cleanRequest(request: unknown): OsNotification | null {
  const input = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
  const id = text(input.id, 512);
  const title = text(input.title, 200);
  if (!id || !title) return null;
  const actions = Array.isArray(input.actions)
    ? input.actions.slice(0, MAX_ACTIONS).flatMap((action) => {
        const a = (action ?? {}) as Record<string, unknown>;
        const actionId = text(a.id, 32);
        const label = text(a.label, 40);
        return actionId && label && actionId !== 'reply' ? [{ id: actionId, label }] : [];
      })
    : [];
  const reply = input.reply as Record<string, unknown> | undefined;
  return {
    id,
    group: text(input.group, 512) || undefined,
    title,
    body: text(input.body, 500),
    context: text(input.context, 1024),
    actions,
    reply: reply && text(reply.label, 40) ? { label: text(reply.label, 40), placeholder: text(reply.placeholder, 100) } : undefined,
    sound: input.sound === true,
    attention: input.attention === true,
    kind: input.kind === 'reminder' ? 'reminder' : undefined,
  };
}

/** Windows wants tags of 64 characters at most. */
function shortId(value: string): string {
  return value.length <= 64 ? value : createHash('sha256').update(value).digest('hex').slice(0, 40);
}

export function setupToasts(hub: OsHub, attention: () => void): ToastHandle {
  const win32 = process.platform === 'win32';
  const seen = new Map<string, number>();
  const toastLimit = new LinkRateLimit(TOASTS_PER_MINUTE, 60_000);
  // A Notification without a reference is collected, and its events go with it.
  const live = new Set<Notification>();
  let focusCache: { value: FocusAssist; at: number } | null = null;
  let focusRunning: Promise<FocusAssist> | null = null;
  let focusOverride: FocusAssist | null = null;
  /** Electron's activator answers once this process has shown a toast: typed text can travel. */
  let activatorAnswers = false;

  const focusAssist = (): Promise<FocusAssist> => {
    if (focusOverride) return Promise.resolve(focusOverride);
    // macOS keeps this to itself, and holds back banner and sound on its own.
    if (process.platform === 'darwin') return Promise.resolve('off');
    if (focusCache && Date.now() - focusCache.at < FOCUS_ASSIST_TTL_MS) return Promise.resolve(focusCache.value);
    focusRunning ??= (win32 ? runFocusAssistCheck() : runLinuxQuietCheck()).then((value) => {
      focusCache = { value, at: Date.now() };
      focusRunning = null;
      return value;
    });
    return focusRunning;
  };

  const onActivation = (action: string, context: string, reply?: string) => hub.toastAction(action, context, reply);

  if (win32) {
    Notification.handleActivation((details) => {
      const parsed = parseToastArguments(details.arguments ?? '');
      if (!parsed) {
        hub.ctx.showMain();
        return;
      }
      onActivation(parsed.action, parsed.context, details.reply ?? details.userInputs?.[REPLY_INPUT]);
    });
  }

  const removeDelivered = () => {
    if (win32 || process.platform === 'darwin') Notification.removeAll();
  };

  hub.on('locked', (locked) => {
    // What's in the Action Center or on the lock screen goes when the app locks.
    if (locked && hub.lockIsReal) removeDelivered();
  });
  // Sign-out, wipe, quit. A reply field left behind by a quit would lose what's typed in it.
  hub.on('cleared', removeDelivered);

  // Windows started us for a reply typed on a toast from before. The text didn't come along.
  if (win32 && process.argv.some((arg) => arg.toLowerCase() === '-embedding')) {
    const text = strings();
    setTimeout(() => showNotice(text.replyLostTitle, text.replyLostBody), 3000).unref?.();
  }

  const present = (request: OsNotification): Promise<boolean> => {
    const toast = hub.locked
      ? {
          title: strings().toastLockedTitle,
          body: request.kind === 'reminder' ? strings().toastLockedReminderBody : strings().toastLockedBody,
          context: '',
          actions: [],
          reply: undefined,
        }
      : { title: request.title, body: request.body, context: request.context, actions: request.actions ?? [], reply: request.reply };
    const id = shortId(request.id);
    const groupId = request.group ? shortId(request.group) : undefined;
    let notification: Notification;
    if (win32) {
      // The page plays the sound the user picked, so the toast never adds Windows' own.
      notification = new Notification({ id, groupId, toastXml: buildToastXml({ ...toast, silent: true }, hub.toastSecret(), activatorAnswers) });
    } else {
      const mac = process.platform === 'darwin';
      notification = new Notification({
        id,
        groupId,
        title: toast.title,
        body: toast.body,
        // macOS has no sound of ours to play past Focus, so there the OS plays its own.
        silent: !(mac && request.sound),
        hasReply: !!toast.reply,
        replyPlaceholder: toast.reply?.placeholder,
        actions: toast.actions.map((action) => ({ type: 'button' as const, text: action.label })),
      });
      notification.on('click', () => onActivation('open', toast.context));
      notification.on('action', (details) => {
        const action = toast.actions[(details as unknown as { actionIndex: number }).actionIndex];
        if (action) onActivation(action.id, toast.context);
      });
      notification.on('reply', (details) => onActivation('reply', toast.context, (details as unknown as { reply: string }).reply));
    }
    live.add(notification);
    const forget = () => live.delete(notification);
    notification.once('close', forget);
    return new Promise((resolve) => {
      const waiting = setTimeout(() => resolve(true), SHOW_WAIT_MS);
      notification.once('show', () => {
        activatorAnswers = true;
        clearTimeout(waiting);
        resolve(true);
      });
      notification.on('failed', (_event, error) => {
        console.warn('Notification failed:', error);
        forget();
        clearTimeout(waiting);
        resolve(false);
      });
      notification.show();
    });
  };

  const notify = async (raw: unknown): Promise<OsNotifyResult> => {
    const request = cleanRequest(raw);
    if (!request) return { shown: false, reason: 'invalid', playSound: false };
    if (!Notification.isSupported()) return { shown: false, reason: 'unsupported', playSound: !!request.sound };
    const now = Date.now();
    for (const [key, at] of seen) if (now - at > REPEAT_MS) seen.delete(key);
    if (seen.has(request.id)) return { shown: false, reason: 'duplicate', playSound: false };
    seen.set(request.id, now);
    if (hub.pausedUntil() !== null) return { shown: false, reason: 'paused', playSound: false };
    if (inQuietHours(hub.settings(), new Date())) return { shown: false, reason: 'quiet-hours', playSound: false };
    const quiet = (await focusAssist()) !== 'off';
    const playSound = !!request.sound && !quiet && process.platform !== 'darwin';
    // In front of the user the app says it itself, which only the main window does:
    // a message in a pop-out must not swallow it, and neither must a window on its way out.
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && focused === hub.ctx.windows.mainWindow() && focused.isVisible()) return { shown: false, reason: 'focused', playSound };
    if (!toastLimit.allow(Date.now())) {
      // Not shown, so the same one may come again.
      seen.delete(request.id);
      return { shown: false, reason: 'failed', playSound: false };
    }
    // In Do Not Disturb Windows keeps it in the Action Center without a banner.
    if (!(await present(request))) return { shown: false, reason: 'failed', playSound };
    if (request.attention && !quiet) attention();
    return { shown: true, playSound };
  };

  function showNotice(title: string, body: string, onClick?: () => void): void {
    const notice = new Notification({ title, body, silent: true });
    live.add(notice);
    notice.once('close', () => live.delete(notice));
    notice.on('click', () => (onClick ? onClick() : hub.ctx.showMain()));
    notice.show();
  }

  return {
    notify,
    focusAssist,
    setFocusAssistForTest: (value) => {
      focusOverride = value;
    },
    showNotice,
  };
}
