/**
 * The shell's own small JSON state under userData. Plain, not secret: mode,
 * approved servers, window sizes, last theme. Written atomically, read once.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Mode, OsSettings, ThemeColours, WindowType } from '../shared/bridge';

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
  /** What the user changed of the OS settings; the rest are defaults (features/os-rules.ts). */
  os?: Partial<OsSettings>;
  /** Pause notifications, from the tray. */
  osPausedUntil?: number | null;
  /** The first close to the tray said so. */
  osCloseNoticeShown?: boolean;
  /** The path the mail app's registry keys point at. */
  osRegisteredExe?: string;
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
