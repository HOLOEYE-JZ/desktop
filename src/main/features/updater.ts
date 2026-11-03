/**
 * Updates through electron-updater, on GitHub Releases of bulwarkmail/desktop.
 * Prereleases are the beta channel.
 *
 * Quiet by design: it checks in the background and downloads by itself. When an update
 * is ready there's a menu item, one notification and the row in settings, and nothing
 * ever blocks work. It installs at the next quit, or when the user picks "Restart to
 * update".
 *
 * Both go through the normal quit, so pages save their drafts first (`before-quit` in
 * index.ts), a page that asks to stay calls the restart off, and only then, at
 * `will-quit`, does the installer start. The other way round NSIS would kill the app in
 * the middle of saving.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { app, BrowserWindow, dialog, Notification, powerMonitor } from 'electron';
import type { AppUpdater, CancellationToken, UpdateInfo } from 'electron-updater';
import { CHANNEL, type UpdateChannel, type UpdateState } from '../../shared/bridge';
import { setUpdateMenu } from '../menu';
import { openExternally } from '../navigation';
import { notifyUpdatePolicyChanged, onUpdatePolicyChange, readUpdatePolicy, setUpdatePolicySource } from '../update-policy';
import {
  acceptDownload,
  effectiveChannel,
  installKind,
  isPrerelease,
  judgeFeedVersion,
  newestReleaseInFeed,
  updateAbility,
  updatePolicyFrom,
  updateUrlAllowed,
  type InstallKind,
  type UpdatePolicy,
  type WantedDownload,
} from '../update-rules';
import { fill, strings } from '../strings';
import type { Feature, FeatureContext } from './index';
import { policies } from './policies';

declare const __BULWARK_UPDATER_TEST__: boolean;

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 4 * 3600_000;
const ABANDON_WAIT_MS = 10_000;
const OWNER = 'bulwarkmail';
const REPO = 'desktop';
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
}

function detectKind(): InstallKind {
  const resources = process.resourcesPath;
  let macSigned = false;
  try {
    macSigned = JSON.parse(readText(path.join(resources, 'bulwark-build.json')) ?? '{}').macSigned === true;
  } catch {
    // An unreadable file is an unsigned build.
  }
  return installKind({
    platform: process.platform,
    isPackaged: app.isPackaged,
    hasNsisUninstaller: existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`)),
    appImage: process.env.APPIMAGE,
    packageType: readText(path.join(resources, 'package-type')),
    macSigned,
  });
}

let hold: (() => void) | null = null;

/** The app is restarting for something else (Change Connection): an update waits for the next quit. */
export function holdUpdateInstall(): void {
  hold?.();
}

class Updater {
  private updater: AppUpdater | null = null;
  private timer: NodeJS.Timeout | null = null;
  private restarting = false;
  private lastCheckAt = 0;
  private readonly kind: InstallKind = detectKind();
  private readonly testFeed: string | undefined = __BULWARK_UPDATER_TEST__ ? argValue('bulwark-test-update-feed') : undefined;

  private status: UpdateState['status'] = 'idle';
  private target: string | undefined;
  private percent: number | undefined;

  private downloadToken: CancellationToken | null = null;
  private activeDownload: Promise<void> | null = null;
  private wanted: WantedDownload | null = null;
  private lastChannel: UpdateChannel | null = null;

  constructor(private readonly ctx: FeatureContext) {}

  private get channel(): UpdateChannel {
    return effectiveChannel(this.policy(), this.ctx.state.data.updateChannel, app.getVersion(), this.ctx.state.data.updateChannelInitial);
  }

  private policy(): UpdatePolicy {
    return readUpdatePolicy();
  }

  /** Off by policy: no timer, no requests. */
  private get allowed(): boolean {
    return this.policy().autoUpdate !== false;
  }

  private get ability(): UpdateState['ability'] {
    if (this.testFeed) return updateAbility(this.kind);
    if (!app.isPackaged || !existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return 'none';
    return updateAbility(this.kind);
  }

  state(): UpdateState {
    return {
      version: app.getVersion(),
      channel: this.channel,
      channelLocked: this.policy().channel !== undefined,
      allowed: this.allowed,
      ability: this.ability,
      perMachine: this.kind === 'windows-other',
      status: this.allowed ? this.status : 'off',
      target: this.target,
      percent: this.percent,
    };
  }

  private publish(): void {
    this.ctx.windows.broadcast(CHANNEL.updatesChanged, this.state());
    this.refreshMenu();
  }

  private setStatus(status: UpdateState['status'], target?: string, percent?: number): void {
    this.status = status;
    this.target = target;
    this.percent = percent;
    this.publish();
  }

  private refreshMenu(): void {
    const text = strings();
    if (!this.allowed || this.ability === 'none') {
      setUpdateMenu([]);
      return;
    }
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (this.status === 'ready' && this.target) {
      items.push({ id: 'update-restart', label: text.menuRestartToUpdate, click: () => this.restart() });
    } else if (this.status === 'available' && this.target) {
      // On a per-machine install the person using it can't do anything about it.
      if (this.kind !== 'windows-other') {
        items.push({ id: 'update-download', label: fill(text.menuUpdateAvailable, { version: this.target }), click: () => this.openDownload() });
      }
    } else {
      items.push({
        id: 'update-check',
        label: text.menuCheckForUpdates,
        enabled: this.status !== 'checking' && this.status !== 'downloading',
        click: () => void this.checkFromMenu(),
      });
    }
    setUpdateMenu(items);
  }

  /** electron-updater only when it's first needed, so it costs a start nothing. */
  private load(): AppUpdater {
    if (this.updater) return this.updater;
    const require = createRequire(import.meta.url);
    const { autoUpdater } = require('./updater-lib.cjs') as { autoUpdater: AppUpdater };
    autoUpdater.logger = null;
    autoUpdater.autoDownload = false;
    // Only true once a right version is on disk: see `onDownloaded`.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    // Its differential path ignores the cancellation token, so a download given up on would
    // run to the end and block the next one. The packages have no blockmaps anyway.
    autoUpdater.disableDifferentialDownload = true;
    // Every hop of every request, redirects included: only GitHub. TLS doesn't help against a
    // release asset that points somewhere else.
    const testOrigin = __BULWARK_UPDATER_TEST__ && this.testFeed ? new URL(this.testFeed).origin : undefined;
    autoUpdater.netSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ cancel: !updateUrlAllowed(details.url, testOrigin) });
    });
    autoUpdater.on('download-progress', (progress: { percent: number }) => {
      if (this.wanted) this.setStatus('downloading', this.wanted.version, Math.round(progress.percent));
    });
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => this.onDownloaded(info));
    autoUpdater.on('error', (error: Error) => this.onError(error));
    this.updater = autoUpdater;
    return autoUpdater;
  }

  private get feedBase(): { host?: string; protocol?: 'http'; base: string } {
    if (__BULWARK_UPDATER_TEST__ && this.testFeed) {
      const feed = new URL(this.testFeed);
      return { host: feed.host, protocol: 'http', base: feed.origin };
    }
    return { base: 'https://github.com' };
  }

  /**
   * Stable asks GitHub's "latest release". Beta reads the feed itself and takes the highest
   * version: electron-updater takes the newest entry, so a stable hotfix published after a
   * beta would hide that beta until the next one.
   */
  private async pointFeed(updater: AppUpdater, channel: UpdateChannel): Promise<void> {
    const { host, protocol, base } = this.feedBase;
    if (channel === 'beta') {
      try {
        const response = await updater.netSession.fetch(`${base}/${OWNER}/${REPO}/releases.atom`, { headers: { accept: 'application/atom+xml' } });
        const newest = response.ok ? newestReleaseInFeed(await response.text()) : null;
        if (newest) {
          updater.setFeedURL({ provider: 'generic', url: `${base}/${OWNER}/${REPO}/releases/download/v${newest}/` });
          return;
        }
      } catch (error) {
        console.warn('[updater]', error instanceof Error ? error.message : error);
      }
    }
    updater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO, ...(host ? { host, protocol } : {}) });
  }

  /** Offline, a release still uploading. Quiet: the next check tries again. What's on disk stays ready. */
  private onError(error: unknown): void {
    console.warn('[updater]', error instanceof Error ? error.message : error);
    if (this.status !== 'ready') this.setStatus('error');
  }

  private onDownloaded(info: UpdateInfo): void {
    const updater = this.load();
    // The channel or a policy may have moved while this came down.
    if (!acceptDownload({ allowed: this.allowed, wanted: this.wanted, version: info.version, current: app.getVersion(), channel: this.channel })) {
      updater.autoInstallOnAppQuit = false;
      return;
    }
    updater.autoInstallOnAppQuit = true;
    this.setStatus('ready', info.version);
    const { state } = this.ctx;
    if (state.data.updateNotified === info.version) return;
    state.data.updateNotified = info.version;
    state.touch();
    if (!Notification.isSupported()) return;
    const text = strings();
    const notification = new Notification({ title: text.updateReadyTitle, body: fill(text.updateReadyBody, { version: info.version }), silent: true });
    notification.on('click', () => this.restart());
    notification.show();
  }

  private download(updater: AppUpdater, version: string, older: boolean): Promise<unknown> {
    const require = createRequire(import.meta.url);
    const { CancellationToken: Token } = require('./updater-lib.cjs') as { CancellationToken: new () => CancellationToken };
    const token = new Token();
    this.downloadToken = token;
    this.wanted = { version, older };
    const run = updater.downloadUpdate(token);
    this.activeDownload = run.then(
      () => {},
      () => {},
    );
    return run
      .catch((error) => {
        // A download given up on isn't a failure: whoever gave it up says what happens next.
        if (this.wanted?.version === version) this.onError(error);
      })
      .finally(() => {
        if (this.downloadToken === token) this.downloadToken = null;
      });
  }

  /** Whatever is coming down or sitting on disk no longer counts. Waits until it has stopped. */
  private async abandonDownload(): Promise<void> {
    this.wanted = null;
    this.downloadToken?.cancel();
    this.downloadToken = null;
    if (this.updater) this.updater.autoInstallOnAppQuit = false;
    // Not forever, whatever the network does: a setting mustn't hang on it.
    await Promise.race([this.activeDownload, new Promise((resolve) => setTimeout(resolve, ABANDON_WAIT_MS))]);
    this.activeDownload = null;
  }

  async check(): Promise<UpdateState> {
    if (!this.allowed || this.ability === 'none' || this.status === 'checking' || this.status === 'downloading') return this.state();
    // One's waiting on disk, and looking again would take "Restart to Update" away for a moment.
    if (this.status === 'ready') return this.state();
    this.lastCheckAt = Date.now();
    const updater = this.load();
    // `update-downloaded` puts this back. A download from another channel doesn't count.
    updater.autoInstallOnAppQuit = false;
    const channel = this.channel;
    this.lastChannel = channel;
    updater.allowPrerelease = channel === 'beta';
    // Lets an older stable release reach `judgeFeedVersion`. Nothing downloads on its own.
    updater.allowDowngrade = true;
    this.setStatus('checking');
    try {
      await this.pointFeed(updater, channel);
      const result = await updater.checkForUpdates();
      const version = result?.updateInfo.version;
      if (!version) {
        this.setStatus('up-to-date');
        return this.state();
      }
      const verdict = judgeFeedVersion(app.getVersion(), version, channel);
      if (verdict === 'older-offer') {
        this.setStatus('older-available', version);
      } else if (verdict !== 'newer') {
        this.setStatus('up-to-date');
      } else if (this.ability === 'install') {
        this.setStatus('downloading', version, 0);
        void this.download(updater, version, false);
      } else {
        this.setStatus('available', version);
        this.notifyAvailable(version);
      }
    } catch (error) {
      this.onError(error);
    }
    return this.state();
  }

  /** One notice per version, and none on an MSI: that's for IT, not for the person using it. */
  private notifyAvailable(version: string): void {
    const { state } = this.ctx;
    if (this.kind === 'windows-other' || state.data.updateNotified === version || !Notification.isSupported()) return;
    state.data.updateNotified = version;
    state.touch();
    const text = strings();
    const notification = new Notification({ title: text.updateAvailableTitle, body: fill(text.menuUpdateAvailable, { version }), silent: true });
    notification.on('click', () => this.openDownload());
    notification.show();
  }

  private async checkFromMenu(): Promise<void> {
    const after = await this.check();
    if (after.status !== 'up-to-date' && after.status !== 'error') return;
    const text = strings();
    const options = {
      type: 'info' as const,
      title: 'Bulwark',
      message: after.status === 'up-to-date' ? text.updateNoneTitle : text.updateFailedTitle,
      detail: after.status === 'up-to-date' ? fill(text.updateNoneDetail, { version: after.version }) : text.updateFailedDetail,
      buttons: [text.ok],
      noLink: true,
    };
    const parent = BrowserWindow.getFocusedWindow();
    if (parent) await dialog.showMessageBox(parent, options);
    else await dialog.showMessageBox(options);
  }

  /** The normal quit. If a page stays, the windows manager says so and this is called off. */
  restart(): void {
    if (this.status !== 'ready' || !this.allowed) return;
    this.restarting = true;
    app.quit();
  }

  openDownload(): void {
    openExternally(this.target ? `${RELEASES_URL}/tag/v${this.target}` : `${RELEASES_URL}/latest`);
  }

  async setChannel(channel: unknown): Promise<UpdateState> {
    if ((channel !== 'stable' && channel !== 'beta') || this.policy().channel !== undefined) return this.state();
    if (channel === this.channel) return this.state();
    const { state } = this.ctx;
    if (channel === 'beta') {
      const text = strings();
      // The page can't do this alone: an instance or a privileged plugin holds the same bridge.
      const parent = BrowserWindow.getFocusedWindow();
      const options = {
        type: 'question' as const,
        title: 'Bulwark',
        message: text.updateBetaTitle,
        detail: text.updateBetaDetail,
        buttons: [text.updateBetaConfirm, text.cancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      if (response !== 0) return this.state();
    }
    state.data.updateChannel = channel;
    state.save();
    // What's coming down or on disk came from the other channel.
    await this.abandonDownload();
    this.setStatus('idle');
    return this.check();
  }

  /** Beta to stable, by the user's own click and with the consequences spelled out. */
  async installOlder(): Promise<UpdateState> {
    if (this.status !== 'older-available' || !this.target || this.ability !== 'install' || !this.allowed) return this.state();
    const text = strings();
    const target = this.target;
    const options = {
      type: 'warning' as const,
      title: 'Bulwark',
      message: fill(text.updateOlderTitle, { version: target }),
      detail: fill(text.updateOlderDetail, { current: app.getVersion(), target }),
      buttons: [text.updateOlderConfirm, text.cancel],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const parent = BrowserWindow.getFocusedWindow();
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    // The answer took a while: is this still what's on offer?
    if (response !== 0 || this.status !== 'older-available' || this.target !== target || !this.allowed) return this.state();
    this.setStatus('downloading', target, 0);
    void this.download(this.load(), target, true);
    return this.state();
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.allowed || this.ability === 'none') return;
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  private async onPolicyChange(): Promise<void> {
    const moved = this.lastChannel !== null && this.lastChannel !== this.channel;
    if (!this.allowed || moved) {
      await this.abandonDownload();
      this.status = 'idle';
      this.target = undefined;
    }
    this.schedule();
    this.publish();
    if (this.allowed && moved) void this.check();
  }

  setup(): void {
    const { ctx } = this;
    ctx.handle(CHANNEL.updatesState, () => this.state());
    ctx.handle(CHANNEL.updatesCheck, () => this.check());
    ctx.handle(CHANNEL.updatesSetChannel, (_event, _window, channel) => this.setChannel(channel));
    ctx.handle(CHANNEL.updatesInstallOlder, () => this.installOlder());
    ctx.on(CHANNEL.updatesRestart, () => this.restart());
    ctx.on(CHANNEL.updatesOpenDownload, () => this.openDownload());

    // What this copy was at its first run decides the channel until someone chooses. Asking
    // the running version each time would drop a beta user off beta at the first stable.
    if (!ctx.state.data.updateChannelInitial) {
      ctx.state.data.updateChannelInitial = isPrerelease(app.getVersion()) ? 'beta' : 'stable';
      ctx.state.touch();
    }

    hold = () => {
      this.restarting = false;
      if (this.updater) this.updater.autoInstallOnAppQuit = false;
    };

    // A page chose to stay: the install waits, and the update stays ready.
    ctx.windows.on('stayed', () => {
      this.restarting = false;
    });
    app.on('will-quit', () => {
      // Not silent: the app is gone and a person is waiting, so the installer's progress shows.
      if (this.restarting && this.allowed && this.status === 'ready') this.load().quitAndInstall(false, true);
    });

    setUpdatePolicySource(() => updatePolicyFrom(policies.snapshot));
    onUpdatePolicyChange(() => void this.onPolicyChange());
    policies.on('changed', notifyUpdatePolicyChanged);
    this.schedule();
    powerMonitor.on('resume', () => {
      if (Date.now() - this.lastCheckAt > 3600_000) void this.check();
    });
    const delay = __BULWARK_UPDATER_TEST__ && this.testFeed ? 500 : FIRST_CHECK_MS;
    setTimeout(() => void this.check(), delay).unref?.();
    this.refreshMenu();
  }
}

export const updaterFeature: Feature = {
  name: 'updater',
  modes: ['standalone', 'instance'],
  setup: (ctx) => new Updater(ctx).setup(),
};
