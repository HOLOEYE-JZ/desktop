/**
 * What the OS features share: the settings, the pause, the lock, the page's summary and
 * the way to the main window's page. Commands wait here until that page listens, so a
 * file double-clicked before the app is up isn't lost.
 */

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { CHANNEL, type OsCommand, type OsSettings, type OsStatus, type OsSummary } from '../../shared/bridge';
import type { FeatureContext } from './index';
import { cleanSettingsPatch, defaultSettings } from './os-rules';

const EMPTY_SUMMARY: OsSummary = { unread: [], recent: [], nextEvent: null };

export class OsHub extends EventEmitter<{
  settings: [OsSettings, Partial<OsSettings>];
  status: [OsStatus];
  summary: [OsSummary];
  badge: [number];
  locked: [boolean];
  /** Sign-out, a wipe or a quit: nothing of this account stays on the OS's surfaces. */
  cleared: [];
}> {
  private readonly defaults = defaultSettings(process.platform, process.env);
  private readonly pending: OsCommand[] = [];
  private receiver: WebContents | null = null;
  /**
   * Fails closed. `unknown` until the main window's page has said, and again after it
   * navigates: no content on any surface, and no toast's button acts. `main` is a lock
   * main decided on (the app lock's call): no page can lift that.
   */
  private lockState: 'unknown' | 'open' | 'page' | 'main' = 'unknown';
  private summaryNow: OsSummary = EMPTY_SUMMARY;
  private badgeNow = 0;
  shortcutActive = false;

  constructor(readonly ctx: FeatureContext) {
    super();
    this.setMaxListeners(20);
    ctx.windows.on('created', (managed) => {
      if (managed.type !== 'main') return;
      const { webContents } = managed.window;
      // A new page listens anew. A route change in the page isn't a navigation here.
      webContents.on('did-navigate', () => {
        if (this.receiver === webContents) this.receiver = null;
        if (this.lockState === 'open') this.setLockState('unknown');
      });
    });
    ctx.windows.on('closed', (managed) => {
      if (managed.type === 'main') this.receiver = null;
    });
  }

  settings(): OsSettings {
    return { ...this.defaults, ...this.ctx.state.data.os };
  }

  status(): OsStatus {
    return { settings: this.settings(), pausedUntil: this.pausedUntil(), shortcutActive: this.shortcutActive };
  }

  update(patch: unknown): OsStatus {
    const clean = cleanSettingsPatch(patch);
    if (Object.keys(clean).length > 0) {
      this.ctx.state.data.os = { ...this.ctx.state.data.os, ...clean };
      this.ctx.state.touch();
      this.emit('settings', this.settings(), clean);
    }
    this.announce();
    return this.status();
  }

  announce(): void {
    const status = this.status();
    this.ctx.windows.broadcast(CHANNEL.osStatusChanged, status);
    this.emit('status', status);
  }

  /** A pause that has run out reads as none. */
  pausedUntil(): number | null {
    const until = this.ctx.state.data.osPausedUntil;
    return typeof until === 'number' && until > Date.now() ? until : null;
  }

  setPaused(until: number | null): void {
    this.ctx.state.data.osPausedUntil = until;
    this.ctx.state.touch();
    this.announce();
  }

  /** Anything but a known open state counts as locked. */
  get locked(): boolean {
    return this.lockState !== 'open';
  }

  /** Really locked, as opposed to not having heard yet: what's already delivered goes. */
  get lockIsReal(): boolean {
    return this.lockState === 'page' || this.lockState === 'main';
  }

  private setLockState(next: 'unknown' | 'open' | 'page' | 'main'): void {
    const before = this.locked;
    this.lockState = next;
    if (this.lockIsReal) this.summaryNow = EMPTY_SUMMARY;
    if (before !== this.locked || this.lockIsReal) this.emit('locked', this.locked);
  }

  /**
   * From the bridge. Any window may lock. Only the main window's page may say it's open,
   * and not if main locked it. A privileged plugin in that page can reach this call too,
   * which is why the app lock's own state is kept with setLockedByMain.
   */
  setLockedByPage(locked: boolean, contents: WebContents): void {
    if (locked) {
      if (this.lockState !== 'main') this.setLockState('page');
      return;
    }
    if (this.lockState === 'main' || this.ctx.windows.mainWindow()?.webContents !== contents) return;
    this.setLockState('open');
  }

  /** For the app lock in main: its verdict stands over anything a page says. */
  setLockedByMain(locked: boolean): void {
    this.setLockState(locked ? 'main' : 'open');
  }

  get summary(): OsSummary {
    return this.locked ? EMPTY_SUMMARY : this.summaryNow;
  }

  /** Sign-out, wipe, quit. */
  clearSurfaces(): void {
    this.summaryNow = EMPTY_SUMMARY;
    this.badgeNow = 0;
    this.emit('summary', this.summary);
    this.emit('badge', 0);
    this.emit('cleared');
  }

  setSummary(summary: OsSummary): void {
    this.summaryNow = summary;
    this.emit('summary', this.summary);
  }

  get badge(): number {
    return this.badgeNow;
  }

  setBadge(count: number): void {
    if (count === this.badgeNow) return;
    this.badgeNow = count;
    this.emit('badge', count);
  }

  /** Signs what a toast's buttons hand back: toastUrl in os-rules.ts. */
  toastSecret(): string {
    const { state } = this.ctx;
    if (!state.data.osToastSecret) {
      state.data.osToastSecret = randomBytes(32).toString('base64url');
      state.save();
    }
    return state.data.osToastSecret;
  }

  /** A button shouldn't throw a window in the user's face; the page opens the message if it can't. */
  toastAction(action: string, context: string, reply?: string): void {
    // An old toast's Delete must not act behind the lock. The lock screen is what opens.
    if (this.locked) {
      this.ctx.showMain();
      return;
    }
    if (action === 'open' || action === 'reply') this.dispatch({ type: 'notification', action, context, reply });
    else this.dispatch({ type: 'notification', action, context }, { show: false });
  }

  /** The main window's page says it listens. Only that page: pop-outs don't act on these. */
  subscribe(contents: WebContents): void {
    const main = this.ctx.windows.mainWindow();
    if (!main || main.webContents !== contents) return;
    this.receiver = contents;
    this.flush();
  }

  private flush(): void {
    const receiver = this.receiver;
    if (!receiver || receiver.isDestroyed()) return;
    for (const command of this.pending.splice(0)) receiver.send(CHANNEL.osCommand, command);
  }

  /** `show` brings the main window up. Without it, there still has to be a page to do the work. */
  dispatch(command: OsCommand, options: { show: boolean } = { show: true }): void {
    this.pending.push(command);
    this.flush();
    const { windows } = this.ctx;
    if (options.show) {
      this.ctx.showMain();
    } else if (!windows.mainWindow()) {
      windows.startMainHidden();
      this.ctx.showMain();
    }
  }
}
