/**
 * The app as a citizen of the OS: tray, badge, taskbar, notifications, default mail
 * app, files, start at login, sleep and wake. One feature made of the os-*.ts parts,
 * since they share settings and a way to the page (os-hub.ts).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, autoUpdater, BrowserWindow, powerMonitor } from 'electron';
import { CHANNEL, type OsSummary, type OsTrayMessage } from '../../shared/bridge';
import { appLockGate } from '../app-lock-gate';
import { strings } from '../strings';
import type { Feature, FeatureContext } from './index';
import { setupDefaultApp } from './os-default-app';
import { setupEdit } from './os-edit';
import { setupFiles } from './os-files';
import { OsHub } from './os-hub';
import { setupLaunch } from './os-launch';
import { addWipeStep } from './local-wipe';
import { applyLoginItem, readLoginItem, setupLogin } from './os-login';
import { setupPower } from './os-power';
import { setupQuickCompose } from './os-quick-compose';
import { setupResilience } from './os-resilience';
import { setupTaskbar } from './os-taskbar';
import { setupToasts } from './os-toasts';
import { pageSetPause, settingsAllowedWithoutClick } from './os-rules';
import { setupTray } from './os-tray';

// Bundled into dist/main.mjs, so this is dist/.
const ICONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'os-icons');
const MAX_SUMMARY_ROWS = 10;

function cleanMessages(value: unknown, limit: number): OsTrayMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).flatMap((entry) => {
    const m = (entry ?? {}) as Record<string, unknown>;
    if (typeof m.emailId !== 'string' || typeof m.accountId !== 'string' || !m.emailId || !m.accountId) return [];
    return [{
      emailId: m.emailId.slice(0, 512),
      accountId: m.accountId.slice(0, 512),
      sender: typeof m.sender === 'string' ? m.sender.slice(0, 200) : '',
      subject: typeof m.subject === 'string' ? m.subject.slice(0, 300) : '',
      context: typeof m.context === 'string' ? m.context.slice(0, 1024) : undefined,
    }];
  });
}

function cleanSummary(value: unknown): OsSummary {
  const s = (value ?? {}) as Record<string, unknown>;
  const next = (s.nextEvent ?? null) as { title?: unknown; when?: unknown } | null;
  return {
    unread: cleanMessages(s.unread, MAX_SUMMARY_ROWS),
    recent: cleanMessages(s.recent, MAX_SUMMARY_ROWS),
    nextEvent: next && typeof next.title === 'string' && typeof next.when === 'string' ? { title: next.title.slice(0, 200), when: next.when.slice(0, 60) } : null,
    ...(typeof s.account === 'string' && s.account ? { account: s.account.slice(0, 200) } : {}),
  };
}

function setup(ctx: FeatureContext): void {
  const hub = new OsHub(ctx);
  const { windows } = ctx;
  // Before anything that can ask for a new message, which a launch does below.
  const quickCompose = setupQuickCompose(hub);

  // The main window keeps working while hidden: sync, push, reminders, policy, wipes.
  windows.on('created', ({ type, window }) => {
    if (type !== 'main') return;
    // Without this a hidden page reads as hidden and its timers run about once a second
    // (measured on 45). With it, it stays "visible" to itself, and on time.
    window.webContents.setBackgroundThrottling(false);
  });
  powerMonitor.on('shutdown', () => windows.beginQuit());
  autoUpdater.on('before-quit-for-update', () => windows.beginQuit());

  // Window titles carry subjects, and the Window menu and the taskbar show them.
  windows.on('created', ({ window }) => {
    window.webContents.on('page-title-updated', (event) => {
      if (!hub.locked) return;
      event.preventDefault();
      window.setTitle('Bulwark');
    });
  });
  hub.on('locked', (locked) => {
    for (const { id } of windows.list()) {
      const window = BrowserWindow.fromId(id);
      if (!window || window.isDestroyed()) continue;
      window.setTitle(locked ? 'Bulwark' : window.webContents.getTitle() || 'Bulwark');
    }
  });

  const taskbar = setupTaskbar(hub, ICONS);
  const toasts = setupToasts(hub, taskbar.attention);
  const tray = setupTray(hub, ICONS);
  setupResilience(hub, toasts.showNotice);
  // With no tray to come back from, closing to it would be hiding into nothing. The Dock stays.
  windows.setCloseToBackground(() => hub.settings().closeToTray && (!!tray || process.platform === 'darwin'));
  const launch = setupLaunch(hub);
  const defaultApp = setupDefaultApp(hub);
  const files = setupFiles(path.join(ICONS, 'tray-dark-32.png'));
  const edit = setupEdit(hub);
  hub.on('cleared', files.clear);
  hub.on('locked', (locked) => {
    if (locked && hub.lockIsReal) files.clear();
  });
  // Nothing of the account is left on the OS's surfaces once it's gone. No page answers then.
  app.on('will-quit', () => hub.clearSurfaces());
  addWipeStep(async () => hub.clearSurfaces());
  setupLogin(hub);
  const power = setupPower(hub);

  windows.on('hiddenToBackground', () => {
    if (ctx.state.data.osCloseNoticeShown) return;
    ctx.state.data.osCloseNoticeShown = true;
    ctx.state.touch();
    const text = strings();
    toasts.showNotice(text.closedToTrayTitle, text.closedToTrayBody);
  });

  ctx.on(CHANNEL.osSubscribe, (event) => hub.subscribe(event.sender));
  ctx.handle(CHANNEL.osGetStatus, () => hub.status());
  ctx.handle(CHANNEL.osSetSettings, (_event, _window, patch, clicked) => hub.update(settingsAllowedWithoutClick(patch, clicked === true)));
  ctx.on(CHANNEL.osSetPaused, (_event, _window, until) => hub.setPaused(pageSetPause(until, Date.now())));
  ctx.on(CHANNEL.osSetBadge, (_event, _window, count) => {
    hub.setBadge(typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0);
  });
  ctx.on(CHANNEL.osSetSummary, (_event, _window, summary) => hub.setSummary(cleanSummary(summary)));
  ctx.on(CHANNEL.osSetProgress, (_event, _window, progress, mode) => taskbar.setProgress(progress, mode));
  // The app lock's verdict is main's own (app-lock-gate.ts). Set up, it stands over anything a
  // page says from the first moment of a start. With no lock, the page's word decides.
  appLockGate.initForProfile(app.getPath('userData'), ctx.origin);
  if (appLockGate.locked) hub.setLockedByMain(true);
  appLockGate.on('locked', (locked) => hub.setLockedByMain(locked));

  ctx.on(CHANNEL.osSetLocked, (event, _window, locked) => hub.setLockedByPage(locked !== false, event.sender));
  ctx.on(CHANNEL.osClearSurfaces, () => hub.clearSurfaces());
  ctx.handle(CHANNEL.osNotify, (_event, _window, notification) => toasts.notify(notification));
  ctx.handle(CHANNEL.osStartDrag, (event, _window, list) => files.startDrag(event.sender, list));
  ctx.handle(CHANNEL.osCopyFiles, (_event, _window, list) => files.copy(list));
  ctx.handle(CHANNEL.osDefaultAppStatus, () => defaultApp.status());
  ctx.handle(CHANNEL.osDefaultAppOpen, () => defaultApp.open());

  // The checks in test/ read these back. An installed app has none of it.
  if (!app.isPackaged) {
    (globalThis as unknown as { __bulwarkOs: unknown }).__bulwarkOs = {
      hub,
      gate: appLockGate,
      tray,
      taskbar,
      toasts,
      launch,
      defaultApp,
      files,
      edit,
      power,
      quickCompose,
      applyLoginItem,
      readLoginItem,
    };
  }
}

export const osIntegration: Feature = { name: 'os', modes: ['standalone', 'instance'], setup };
