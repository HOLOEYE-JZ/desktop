/**
 * The taskbar and the dock: unread badge, flash or bounce, progress, jump list,
 * thumbnail toolbar and dock menu.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, Menu, nativeImage, nativeTheme, screen, type BrowserWindow, type JumpListCategory, type MenuItemConstructorOptions, type ProgressBarOptions } from 'electron';
import type { OsCommand, OsSummary, OsTrayMessage } from '../../shared/bridge';
import { onUiLanguage, strings } from '../strings';
import { menuIcon, thumbIcon } from './menu-icons';
import { overlayPng } from './os-icons';
import type { OsHub } from './os-hub';
import { jumpListCategories, taskIconPath, taskIconVariant, type TaskIcon, type TaskIconVariant } from './os-tasks';

const JUMP_LIST_DELAY_MS = 2000;

export interface TaskbarHandle {
  jumpListResult: () => string | null;
  applyJumpList: () => string | null;
  attention: () => void;
  setProgress: (progress: unknown, mode: unknown) => void;
  applyThumbar: (window: BrowserWindow) => boolean;
  /** Which glyphs the jump list and the thumbnail toolbar have now, for the checks. */
  iconVariant: () => TaskIconVariant;
  /** The dock's menu as macOS gets it, for the checks on any platform. */
  dockTemplate: () => MenuItemConstructorOptions[];
}

/** A jump list entry starts us again; in development the script goes in front. */
function launchArgs(url: string): string {
  return `${process.defaultApp ? `"${app.getAppPath()}" ` : ''}-- ${url}`;
}

/** The same link a web page could make: see src/main/deep-link.ts. */
function messageLink(message: OsTrayMessage): string {
  const query = new URLSearchParams({ owner: message.accountId });
  try {
    const { login } = JSON.parse(message.context ?? '{}') as { login?: unknown };
    if (typeof login === 'string') query.set('account', login);
  } catch {
    // No context, or not this shape: it opens in the account that's active.
  }
  return `bulwark://message/${encodeURIComponent(message.emailId)}?${query}`;
}

/**
 * `iconsDir` has the images Electron loads itself, `taskIconsDir` the .ico files Windows
 * reads for the jump list (os-tasks.ts).
 */
export function setupTaskbar(hub: OsHub, iconsDir: string, taskIconsDir: string): TaskbarHandle {
  const { windows } = hub.ctx;
  const win32 = process.platform === 'win32';
  const open = new Set<BrowserWindow>();
  let jumpResult: string | null = null;
  let jumpTimer: NodeJS.Timeout | null = null;
  let lastJumpKey = '';
  let lastProgress: { value: number; options?: ProgressBarOptions } | null = null;
  // The jump list and the thumbnail toolbar belong to the taskbar: they follow its light or
  // dark (the Windows mode), not the apps'. The tray does the same.
  const variant = () => taskIconVariant(nativeTheme.shouldUseDarkColorsForSystemIntegratedUI);
  let lastVariant = variant();

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

  const applyThumbar = (window: BrowserWindow) => {
    if (!win32 || window.isDestroyed()) return false;
    const text = strings();
    // The jump list's .ico files, at the size for the screen the window is on.
    const { scaleFactor } = screen.getDisplayMatching(window.getBounds());
    const icon = (name: TaskIcon) => thumbIcon(taskIconPath(taskIconsDir, name, variant()), scaleFactor);
    return window.setThumbarButtons([
      { tooltip: text.thumbNewMessage, icon: icon('compose'), click: () => hub.dispatch({ type: 'new-message' }) },
      { tooltip: text.thumbInbox, icon: icon('inbox'), click: () => hub.dispatch({ type: 'navigate', target: 'inbox' }) },
    ]);
  };

  const jumpList = (summary: OsSummary): JumpListCategory[] => {
    const text = strings();
    return jumpListCategories({
      text,
      recent: summary.recent.slice(0, 5).map((message) => ({
        title: message.subject.replace(/\s+/g, ' ').trim().slice(0, 120) || text.jumpNoSubject,
        url: messageLink(message),
      })),
      program: process.execPath,
      args: launchArgs,
      iconsDir: taskIconsDir,
      variant: lastVariant,
      iconExists: existsSync,
    });
  };

  const jumpKey = (summary: OsSummary) => JSON.stringify(summary.recent.map((message) => [message.emailId, message.subject]));

  const applyJumpList = (): string | null => {
    if (!win32) return null;
    const summary = hub.summary;
    lastJumpKey = jumpKey(summary);
    lastVariant = variant();
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
  // Subjects leave the jump list at once when the app locks, signs out or quits.
  hub.on('locked', () => applyJumpList());
  hub.on('cleared', () => applyJumpList());
  applyJumpList();

  const refreshThumbar = () => {
    const main = windows.mainWindow();
    if (main && !main.isDestroyed() && main.isVisible()) applyThumbar(main);
  };
  // Windows keeps the icons it was given: another light or dark needs the list set again.
  nativeTheme.on('updated', () => {
    if (!win32 || variant() === lastVariant) return;
    applyJumpList();
    refreshThumbar();
  });

  const dockTemplate = (): MenuItemConstructorOptions[] => {
    const text = strings();
    const dockCommand = (command: OsCommand) => () => hub.dispatch(command);
    // Template images: the menu tints them.
    const icon = (name: TaskIcon) => menuIcon(path.join(iconsDir, `menu-${name}Template.png`));
    return [
      { label: text.trayNewMessage, icon: icon('compose'), click: dockCommand({ type: 'new-message' }) },
      { label: text.jumpInbox, icon: icon('inbox'), click: dockCommand({ type: 'navigate', target: 'inbox' }) },
      { label: text.jumpCalendar, icon: icon('calendar'), click: dockCommand({ type: 'navigate', target: 'calendar' }) },
      { label: text.jumpContacts, icon: icon('contacts'), click: dockCommand({ type: 'navigate', target: 'contacts' }) },
    ];
  };

  const applyDockMenu = () => {
    if (process.platform !== 'darwin' || !app.dock) return;
    app.dock.setMenu(Menu.buildFromTemplate(dockTemplate()));
  };
  applyDockMenu();

  // Until the page says which language it shows, these are in the OS's.
  onUiLanguage(() => {
    applyJumpList();
    refreshThumbar();
    applyDockMenu();
  });

  return { jumpListResult: () => jumpResult, applyJumpList, attention, setProgress, applyThumbar, iconVariant: () => lastVariant, dockTemplate };
}
