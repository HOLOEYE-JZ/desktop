/**
 * The shell's own small JSON state under userData. Plain, not secret: mode,
 * approved servers, window sizes, last theme. Written atomically, read once.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Mode, ThemeColours, WindowType } from '../shared/bridge';

export interface StoredBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface ApprovedServer {
  origin: string;
  approvedAt: number;
}

/** A window to bring back at the next start. */
export interface SessionWindow {
  type: WindowType;
  url: string;
  key?: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface ShellState {
  mode?: Mode;
  instanceUrl?: string;
  /** Mail servers the user approved: LAN or plain http. */
  approvedServers: ApprovedServer[];
  /** Every server origin an account uses, for the CORS headers. */
  corsOrigins: string[];
  windowBounds: Partial<Record<WindowType, StoredBounds>>;
  theme?: ThemeColours;
  /** Whether a page draws its own title bar row, per origin (windows.ts). */
  overlayByOrigin: Record<string, boolean>;
  /** "Change Connection" was chosen: ask once, also over a recommended server. */
  askConnection?: boolean;
  /** WipeOfflineData values already acted on, so each deletes once, across restarts. */
  policyWipes?: string[];
  /** Every partition this profile has used: a wipe covers them all. */
  partitions?: string[];
  /** OfflineEnabled was forced off and the partitions' store files were cleared for it. */
  offlineClearedForPolicy?: boolean;
  /** Instances the user said may use the OS keystore. Revocable in the webmail's settings. */
  keystoreOrigins?: string[];
  /** What was open at quit. Off by the setting in the webmail. */
  session?: SessionWindow[];
  restoreWindows?: boolean;
  /** Chromium's zoom level: 0 is 100%. */
  zoomLevel?: number;
}

const EMPTY: ShellState = { approvedServers: [], corsOrigins: [], windowBounds: {}, overlayByOrigin: {} };

export class StateFile {
  private timer: NodeJS.Timeout | null = null;
  readonly data: ShellState;

  constructor(private readonly file: string) {
    let loaded: Partial<ShellState> = {};
    try {
      loaded = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // First run, or a damaged file: start clean. None of this is precious.
    }
    this.data = { ...EMPTY, ...loaded };
  }

  /** Saves soon. Window moves fire many times a second. */
  touch(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.save(), 400);
    this.timer.unref?.();
  }

  save(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2));
    renameSync(temp, this.file);
  }
}
