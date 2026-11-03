/**
 * Where step 6 and 7 plug in: tray, jump lists, toasts, context menus, drag-out,
 * policies. Each is a file here that exports a Feature, added to FEATURES. A
 * feature gets the app's parts, registers its own IPC with `ctx.handle` (the
 * sender checks come with it) and listens to the window manager. It adds a member
 * to the bridge in src/preload/index.ts and in the webmail's lib/desktop/types.ts.
 */

import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, Session } from 'electron';
import type { Mode } from '../../shared/bridge';
import type { StateFile } from '../state';
import type { ThemeController } from '../theme';
import type { WindowManager } from '../windows';
import type { ServerRegistry } from '../servers';
import type { LocalAdmin } from '../local-admin';
import { policiesFeature } from './policies';
import { keystoreFeature } from './keystore';
import { privacyFeature } from './privacy';

export interface FeatureContext {
  mode: Mode;
  origin: string;
  session: Session;
  state: StateFile;
  theme: ThemeController;
  windows: WindowManager;
  /** Standalone only. */
  servers?: ServerRegistry;
  localAdmin?: LocalAdmin;
  /** A request-reply channel, callable only from the app's own main frames. */
  handle: (channel: string, handler: (event: IpcMainInvokeEvent, window: BrowserWindow | null, ...args: unknown[]) => unknown) => void;
  /** A one-way channel, same check. */
  on: (channel: string, handler: (event: IpcMainEvent, window: BrowserWindow | null, ...args: unknown[]) => void) => void;
}

export interface Feature {
  name: string;
  modes: readonly Mode[];
  setup: (ctx: FeatureContext) => void;
}

export const FEATURES: Feature[] = [policiesFeature, keystoreFeature, privacyFeature];

export function setupFeatures(ctx: FeatureContext): void {
  for (const feature of FEATURES) {
    if (feature.modes.includes(ctx.mode)) feature.setup(ctx);
  }
}
