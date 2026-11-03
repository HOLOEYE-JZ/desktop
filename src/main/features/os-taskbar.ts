/**
 * The taskbar and the dock: unread badge, flash or bounce, progress, jump list,
 * thumbnail toolbar and dock menu.
 */

import path from 'node:path';
import { app, Menu, nativeImage, type BrowserWindow, type JumpListCategory, type ProgressBarOptions } from 'electron';
import type { OsCommand, OsSummary } from '../../shared/bridge';
import { strings } from '../strings';
import { overlayPng } from './os-icons';
import type { OsHub } from './os-hub';

const JUMP_LIST_DELAY_MS = 2000;

export interface TaskbarHandle {
  jumpListResult: () => string | null;
  applyJumpList: () => string | null;
  attention: () => void;
  setProgress: (progress: unknown, mode: unknown) => void;
  applyThumbar: (window: BrowserWindow) => boolean;
}

/** A jump list entry starts us again; in development the script goes in front. */
function launchArgs(url: string): string {
  return `${process.defaultApp ? `"${app.getAppPath()}" ` : ''}-- ${url}`;
}

export function setupTaskbar(hub: OsHub, iconsDir: string): TaskbarHandle {
  const { windows } = hub.ctx;
  const win32 = process.platform === 'win32';
  const open = new Set<BrowserWindow>();
  let jumpResult: string | null = null;
  let jumpTimer: NodeJS.Timeout | null = null;
  let lastJumpKey = '';
  let lastProgress: { value: number; options?: ProgressBarOptions } | null = null;

  const overlayIcon = (count: number) => {
    const image = nativeImage.createEmpty();
    for (const [scaleFactor, size] of [[1, 16], [1.5, 24], [2, 32]] as const) {
      image.addRepresentation({ scaleFactor, width: size, height: size, buffer: overlayPng(count, size) });
    }
    return image;
  };

  const applyBadge = (window: BrowserWindow, count: number) => {
    if (!win32 || window.isDestroyed()) return;
    if (count > 0) window.setOverlayIcon(overlayIcon(count), strings().trayTooltip(count));
    else window.setOverlayIcon(null, '');
  };

  const setBadge = (count: number) => {
    // Unity's count on Linux goes through this as well (desktopName in package.json).
    if (!win32) app.setBadgeCount(count);
    for (const window of open) applyBadge(window, count);
  };

  const attention = () => {
    if (!hub.settings().attentionOnNewMail) return;
    if (process.platform === 'darwin') {
      app.dock?.bounce('informational');
      return;
    }
    const main = windows.mainWindow();
    const window = main?.isVisible() ? main : [...open].find((candidate) => !candidate.isDestroyed() && candidate.isVisible());
    if (!window || window.isDestroyed() || window.isFocused()) return;
    window.flashFrame(true);
    window.once('focus', () => {
      if (!window.isDestroyed()) window.flashFrame(false);
    });
  };

  const setProgress = (progress: unknown, mode: unknown) => {
    const options: ProgressBarOptions | undefined =
      mode === 'normal' || mode === 'indeterminate' || mode === 'paused' || mode === 'error' ? { mode } : undefined;
    // Electron's own convention: a negative value takes the bar away, 2 means "working".
    let value = -1;
    if (typeof progress === 'number' && Number.isFinite(progress)) value = Math.min(1, Math.max(0, progress));
    if (options?.mode === 'indeterminate') value = 2;
    lastProgress = value < 0 ? null : { value, options };
    for (const window of open) {
      if (!window.isDestroyed()) window.setProgressBar(value, options);
    }
  };

  const thumbIcon = (name: string) => {
    const image = nativeImage.createEmpty();
    for (const [scaleFactor, size] of [[1, 16], [1.5, 24], [2, 32]] as const) {
      image.addRepresentation({ scaleFactor, width: size, height: size, buffer: nativeImage.createFromPath(path.join(iconsDir, `thumb-${name}-${size}.png`)).toPNG() });
    }
    return image;
  };

  const applyThumbar = (window: BrowserWindow) => {
    if (!win32 || window.isDestroyed()) return false;
    const text = strings();
    return window.setThumbarButtons([
      { tooltip: text.thumbNewMessage, icon: thumbIcon('compose'), click: () => hub.dispatch({ type: 'new-message' }) },
      { tooltip: text.thumbInbox, icon: thumbIcon('inbox'), click: () => hub.dispatch({ type: 'navigate', target: 'inbox' }) },
    ]);
  };

  const jumpList = (summary: OsSummary): JumpListCategory[] => {
    const text = strings();
    const task = (title: string, url: string) => ({
      type: 'task' as const,
      title,
      description: title,
      program: process.execPath,
      args: launchArgs(url),
      iconPath: process.execPath,
      iconIndex: 0,
    });
    const recent = summary.recent.slice(0, 5).map((message) => {
      const title = message.subject.replace(/\s+/g, ' ').trim().slice(0, 120) || text.jumpNoSubject;
      return task(title, `bulwark://message/${encodeURIComponent(message.accountId)}/${encodeURIComponent(message.emailId)}`);
    });
    return [
      ...(recent.length ? [{ type: 'custom' as const, name: text.jumpRecent, items: recent }] : []),
      {
        type: 'tasks',
        items: [
          task(text.trayNewMessage, 'bulwark://new'),
          task(text.jumpInbox, 'bulwark://inbox'),
          task(text.jumpCalendar, 'bulwark://calendar'),
          task(text.jumpContacts, 'bulwark://contacts'),
        ],
      },
    ];
  };

  const jumpKey = (summary: OsSummary) => JSON.stringify(summary.recent.map((message) => [message.emailId, message.subject]));

  const applyJumpList = (): string | null => {
    if (!win32) return null;
    const summary = hub.summary;
    lastJumpKey = jumpKey(summary);
    jumpResult = app.setJumpList(jumpList(summary));
    return jumpResult;
  };

  const scheduleJumpList = () => {
    if (!win32 || jumpTimer || jumpKey(hub.summary) === lastJumpKey) return;
    jumpTimer = setTimeout(() => {
      jumpTimer = null;
      applyJumpList();
    }, JUMP_LIST_DELAY_MS);
    jumpTimer.unref?.();
  };

  windows.on('created', ({ window, type }) => {
    open.add(window);
    window.once('closed', () => open.delete(window));
    applyBadge(window, hub.badge);
    if (lastProgress) window.setProgressBar(lastProgress.value, lastProgress.options);
    // Windows only takes these from a window with a taskbar button.
    if (type === 'main' && win32) window.on('show', () => applyThumbar(window));
  });

  hub.on('badge', setBadge);
  hub.on('summary', scheduleJumpList);
  // Subjects leave the jump list at once when the app locks.
  hub.on('locked', () => applyJumpList());
  applyJumpList();

  if (process.platform === 'darwin' && app.dock) {
    const text = strings();
    const dockCommand = (command: OsCommand) => () => hub.dispatch(command);
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: text.trayNewMessage, click: dockCommand({ type: 'new-message' }) },
      { label: text.jumpInbox, click: dockCommand({ type: 'navigate', target: 'inbox' }) },
      { label: text.jumpCalendar, click: dockCommand({ type: 'navigate', target: 'calendar' }) },
      { label: text.jumpContacts, click: dockCommand({ type: 'navigate', target: 'contacts' }) },
    ]));
  }

  return { jumpListResult: () => jumpResult, applyJumpList, attention, setProgress, applyThumbar };
}
