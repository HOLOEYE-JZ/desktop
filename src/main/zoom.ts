/**
 * Zoom: Ctrl +, -, 0 and Ctrl+wheel, one level for every window, remembered.
 * Chromium keeps zoom per host, so a level set on one window already holds for the
 * others on the origin; setting it on each also covers a new one mid-load.
 */

import type { StateFile } from './state';
import type { WindowManager } from './windows';

const STEP = 0.5;
const MIN_LEVEL = -3;
const MAX_LEVEL = 5;

export function nextZoomLevel(level: number, step: 1 | -1 | 0): number {
  if (step === 0) return 0;
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, level + step * STEP));
}

export class ZoomController {
  private windows: WindowManager | null = null;

  constructor(private readonly state: StateFile) {}

  attach(windows: WindowManager): void {
    this.windows = windows;
    windows.on('created', ({ window }) => {
      // Before the first paint it would be overwritten by the navigation.
      window.webContents.on('dom-ready', () => {
        if (!window.isDestroyed()) window.webContents.setZoomLevel(this.level());
      });
    });
  }

  level(): number {
    const stored = this.state.data.zoomLevel;
    return typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
  }

  step(step: 1 | -1 | 0): void {
    const next = nextZoomLevel(this.level(), step);
    this.state.data.zoomLevel = next;
    this.state.touch();
    for (const { window } of this.windows?.all() ?? []) window.webContents.setZoomLevel(next);
    this.windows?.refreshChrome();
  }
}
