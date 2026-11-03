/**
 * The tray can keep the app alive with nothing behind it: a main window whose page never
 * loaded, or whose renderer died. Nobody would notice, and no mail would come. So a failed
 * load is tried again, sooner on wake, and a crashed page is reloaded, up to a limit. Past
 * that the user is told.
 */

import { powerMonitor, type BrowserWindow } from 'electron';
import { strings } from '../strings';
import type { OsHub } from './os-hub';
import { isRetryableLoadError, reloadDelayMs } from './os-rules';

/** Crashes within this window count together. A crash once a week starts afresh. */
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const MAX_CRASH_RELOADS = 3;

export function setupResilience(hub: OsHub, notice: (title: string, body: string) => void): void {
  const { windows } = hub.ctx;

  const watch = (window: BrowserWindow, startUrl: string) => {
    const { webContents } = window;
    let timer: NodeJS.Timeout | null = null;
    let attempts = 0;
    let failedUrl: string | null = null;
    let crashes: number[] = [];

    const stopTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const retry = () => {
      stopTimer();
      if (window.isDestroyed() || !failedUrl) return;
      void window.loadURL(failedUrl).catch(() => {
        // did-fail-load comes as well, and schedules the next one.
      });
    };

    const onWake = () => {
      if (failedUrl) retry();
    };

    webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      // A certificate failure's page says what to do. Trying again would only replace it.
      if (!isRetryableLoadError(code)) {
        failedUrl = null;
        stopTimer();
        return;
      }
      failedUrl = url && url.startsWith(hub.ctx.origin) ? url : startUrl;
      stopTimer();
      timer = setTimeout(retry, reloadDelayMs(attempts));
      timer.unref?.();
      attempts += 1;
    });

    webContents.on('did-finish-load', () => {
      // Chromium's error page finishes loading too, and keeps the address it failed on.
      if (webContents.getURL().startsWith('chrome-error:')) return;
      failedUrl = null;
      attempts = 0;
      stopTimer();
    });

    webContents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit' || window.isDestroyed()) return;
      const now = Date.now();
      crashes = crashes.filter((at) => now - at < CRASH_WINDOW_MS);
      crashes.push(now);
      if (crashes.length > MAX_CRASH_RELOADS) {
        const text = strings();
        notice(text.pageCrashedTitle, text.pageCrashedBody);
        return;
      }
      webContents.reload();
    });

    powerMonitor.on('resume', onWake);
    window.once('closed', () => {
      stopTimer();
      powerMonitor.removeListener('resume', onWake);
    });
  };

  windows.on('created', (managed) => {
    if (managed.type === 'main') watch(managed.window, managed.url);
  });
}
