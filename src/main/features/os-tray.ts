/**
 * The tray. Left click shows or hides the main window, the menu has the app's real
 * commands, and the icon follows the taskbar's colour and the unread state.
 *
 * macOS: a template image, the count as the tray's title, the menu on click. Linux:
 * Electron goes through StatusNotifier/AppIndicator, where left click opens the menu.
 */

import path from 'node:path';
import { app, Menu, nativeImage, nativeTheme, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import type { OsSummary } from '../../shared/bridge';
import { strings } from '../strings';
import { withUnreadDot } from './os-icons';
import type { OsHub } from './os-hub';

/** Clicking the tray takes the focus away first. Within this, the window still counts as in front. */
const JUST_BLURRED_MS = 400;
const WINDOWS_REPS: [number, number][] = [[1, 16], [1.25, 20], [1.5, 24], [2, 32], [2.5, 40], [3, 48]];
const LINUX_REPS: [number, number][] = [[1, 22], [2, 44]];
const DOT: readonly [number, number, number] = [0xdb, 0x2d, 0x54];
const LINE_LENGTH = 60;

function line(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  const safe = single.length > LINE_LENGTH ? `${single.slice(0, LINE_LENGTH - 1)}…` : single;
  // A menu label treats & as a mnemonic on Windows and Linux.
  return process.platform === 'darwin' ? safe : safe.replace(/&/g, '&&');
}

export interface TrayHandle {
  tray: Tray;
  /** What the menu shows now, for the checks. */
  template: () => MenuItemConstructorOptions[];
  iconState: () => { variant: string; unread: boolean };
  toggleMain: () => void;
}

export function setupTray(hub: OsHub, iconsDir: string): TrayHandle | null {
  const { windows } = hub.ctx;
  const mac = process.platform === 'darwin';
  let lastBlur = 0;
  let current: MenuItemConstructorOptions[] = [];
  let iconState = { variant: '', unread: false };

  const variant = () => {
    if (mac) return 'template';
    if (process.platform === 'linux') return 'light';
    // The taskbar's own setting, not the apps' light or dark.
    return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'light' : 'dark';
  };

  const makeIcon = (unread: boolean): NativeImage => {
    const which = variant();
    iconState = { variant: which, unread };
    if (mac) {
      const image = nativeImage.createFromPath(path.join(iconsDir, 'trayTemplate.png'));
      image.setTemplateImage(true);
      return image;
    }
    const image = nativeImage.createEmpty();
    for (const [scaleFactor, size] of process.platform === 'linux' ? LINUX_REPS : WINDOWS_REPS) {
      const base = nativeImage.createFromPath(path.join(iconsDir, `tray-${which}-${size}.png`));
      const buffer = unread ? withUnreadDot(base.toBitmap(), size, DOT) : base.toPNG();
      image.addRepresentation({ scaleFactor, width: size, height: size, buffer });
    }
    return image;
  };

  let tray: Tray;
  try {
    tray = new Tray(makeIcon(hub.badge > 0));
  } catch (error) {
    // A desktop with no tray at all. Closing to the tray is off there by default.
    console.warn('No tray:', error);
    return null;
  }

  const showMain = () => hub.ctx.showMain();

  const toggleMain = () => {
    const main = windows.mainWindow();
    if (main && main.isVisible() && !main.isMinimized() && (main.isFocused() || Date.now() - lastBlur < JUST_BLURRED_MS)) {
      main.hide();
      return;
    }
    showMain();
  };

  const pauseItem = (): MenuItemConstructorOptions => {
    const text = strings();
    if (hub.pausedUntil() !== null) return { label: text.trayResume, click: () => hub.setPaused(null) };
    return {
      label: text.trayPause,
      submenu: [
        { label: text.trayPauseHour, click: () => hub.setPaused(Date.now() + 3600_000) },
        {
          label: text.trayPauseTomorrow,
          click: () => {
            const tomorrow = new Date();
            tomorrow.setHours(24 + 8, 0, 0, 0);
            hub.setPaused(tomorrow.getTime());
          },
        },
      ],
    };
  };

  const build = (summary: OsSummary): MenuItemConstructorOptions[] => {
    const text = strings();
    const unread: MenuItemConstructorOptions[] = summary.unread.map((message) => ({
      label: line(`${message.sender}: ${message.subject}`),
      click: () => hub.dispatch({ type: 'open-message', emailId: message.emailId, accountId: message.accountId, context: message.context }),
    }));
    const event: MenuItemConstructorOptions[] = summary.nextEvent
      ? [{ label: line(text.trayNextEvent(summary.nextEvent.title, summary.nextEvent.when)), click: () => hub.dispatch({ type: 'navigate', target: 'calendar' }) }]
      : [];
    return [
      { label: text.trayNewMessage, click: () => hub.dispatch({ type: 'new-message' }) },
      ...(unread.length ? [{ type: 'separator' } as const, { label: text.trayUnread, enabled: false }, ...unread] : []),
      ...(event.length ? [{ type: 'separator' } as const, ...event] : []),
      { type: 'separator' },
      pauseItem(),
      { type: 'separator' },
      { label: text.trayOpen, click: showMain },
      { label: text.trayQuit, click: () => app.quit() },
    ];
  };

  const refreshMenu = () => {
    current = build(hub.summary);
    // On Linux the indicator only picks up a menu set anew.
    tray.setContextMenu(Menu.buildFromTemplate(current));
  };

  const refreshIcon = () => {
    const count = hub.badge;
    tray.setImage(makeIcon(count > 0));
    tray.setToolTip(strings().trayTooltip(count));
    if (mac) tray.setTitle(count > 0 ? String(count) : '');
  };

  tray.setToolTip(strings().trayTooltip(hub.badge));
  refreshMenu();
  if (!mac) tray.on('click', toggleMain);

  hub.on('summary', refreshMenu);
  hub.on('status', refreshMenu);
  hub.on('locked', refreshMenu);
  hub.on('badge', refreshIcon);
  nativeTheme.on('updated', refreshIcon);
  windows.on('created', (managed) => {
    if (managed.type === 'main') managed.window.on('blur', () => { lastBlur = Date.now(); });
  });

  return { tray, template: () => current, iconState: () => iconState, toggleMain };
}
