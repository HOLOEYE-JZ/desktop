/**
 * What the OS features share: the settings, the pause, the lock, the page's summary and
 * the way to the main window's page. Commands wait here until that page listens, so a
 * file double-clicked before the app is up isn't lost.
 */

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
}> {
  private readonly defaults = defaultSettings(process.platform, process.env);
  private readonly pending: OsCommand[] = [];
  private receiver: WebContents | null = null;
  private lockedNow = false;
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

  get locked(): boolean {
    return this.lockedNow;
  }

  setLocked(locked: boolean): void {
    if (locked === this.lockedNow) return;
    this.lockedNow = locked;
    this.emit('locked', locked);
  }

  get summary(): OsSummary {
    return this.lockedNow ? EMPTY_SUMMARY : this.summaryNow;
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
