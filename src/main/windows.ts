/**
 * The window manager. All app windows go through here: main, message, composer
 * and settings. One window per message, per-type remembered bounds, cascading,
 * monitor-safe placement, and no white flash (hidden until first paint, with the
 * theme's background).
 *
 * Closing: the last main window hides while a pop-out is open, because a pop-out
 * borrows its session from it. When the last window on screen goes, a hidden main
 * goes too and the app quits, unless `setCloseToBackground` says to stay.
 *
 * Pop-outs open from a warm spare: a hidden window that has the pop-out code
 * loaded, so one comes up at once. See `activateSpare`.
 *
 * Step 6 features listen to the events (`created`, `changed`) and use `list`,
 * `focus` and `broadcast`. They don't create windows themselves.
 */

import { EventEmitter } from 'node:events';
import { BrowserWindow, dialog, screen, type BrowserWindowConstructorOptions, type Session, type WebPreferences } from 'electron';
import { CHANNEL, PRELOAD_ARG, type FlushAnswer, type Mode, type WindowInfo, type WindowType } from '../shared/bridge';
import type { SessionWindow, StateFile } from './state';
import { native } from './native';
import { strings } from './strings';
import type { ChromeColours, ThemeController } from './theme';
import { fitInto, isOnSomeDisplay, placeWindow, type Rect } from './window-placement';
import { nextInCycle, sumAnswers } from './window-logic';

export const TITLE_BAR_HEIGHT = 36;

const DEFAULT_SIZE: Record<WindowType, { width: number; height: number }> = {
  main: { width: 1280, height: 860 },
  message: { width: 960, height: 820 },
  composer: { width: 760, height: 780 },
  settings: { width: 1040, height: 760 },
};

const MIN_SIZE: Record<WindowType, { minWidth: number; minHeight: number }> = {
  main: { minWidth: 640, minHeight: 480 },
  message: { minWidth: 420, minHeight: 360 },
  composer: { minWidth: 480, minHeight: 420 },
  settings: { minWidth: 560, minHeight: 480 },
};

/** Past this, a slow page shows anyway rather than leave the user with nothing. */
const SHOW_FALLBACK_MS = 6000;
/** How long a closing window waits for its page to save. The page's own limit is shorter. */
const FLUSH_TIMEOUT_MS = 4000;
/** After the main window paints, when a spare gets made: nothing at start-up competes with it. */
const SPARE_FIRST_DELAY_MS = 8000;
const SPARE_NEXT_DELAY_MS = 1500;
/** A page that doesn't know about spares (an older instance) never says it's ready. */
const SPARE_READY_LIMIT_MS = 30_000;
/** A spare that didn't answer shows the pop-out by loading it. */
const SPARE_TAKEN_LIMIT_MS = 1500;
/** Windows from last time open only this long after the start: a sign-in later is a new day. */
const RESTORE_LIMIT_MS = 60_000;

/** The window type a same-origin URL belongs in. Locale prefix optional. */
export function windowTypeOf(pathname: string): WindowType {
  const path = pathname.replace(/^\/[a-zA-Z]{2}(?:-[a-zA-Z]{2,4})?(?=\/)/, '');
  if (/^\/popout\/message(\/|$)/.test(path)) return 'message';
  if (/^\/popout\/compose(\/|$)/.test(path)) return 'composer';
  if (/^\/settings(\/|$)/.test(path)) return 'settings';
  return 'main';
}

export interface OpenOptions {
  type: WindowType;
  url: string;
  /** Identity: opening the same key again focuses that window. */
  key?: string;
  size?: { width: number; height: number };
  /** Its own place, for a window coming back from last time. */
  place?: Rect;
  /** Load the page rather than take the spare. */
  noSpare?: boolean;
  /** Come up behind the window in use: one coming back from last time. */
  inactive?: boolean;
}

export interface ManagedWindow {
  window: BrowserWindow;
  type: WindowType;
  key: string | null;
  url: string;
  /** What the OS made of the place it was given. Until it changes, nothing is stored. */
  initialBounds?: Electron.Rectangle;
  /** The page has something to save before it closes (lib/desktop/types.ts `lifecycle`). */
  flushable?: boolean;
  /** Saved: the next close goes straight through. */
  flushed?: boolean;
  /** What this window's open drafts come back as next time. */
  restoreUrls?: string[];
}

export interface FlushSummary {
  /** A window had something to save. */
  asked: boolean;
  /** Drafts that didn't get saved, counting windows that ran out of time. */
  failed: number;
  /** Mail waiting to go out. */
  unsent: number;
}

export interface WindowManagerOptions {
  state: StateFile;
  theme: ThemeController;
  session: Session;
  origin: string;
  mode: Mode;
  preloadPath: string;
  devTools: boolean;
  /** Keep a warm spare. Off in tests that count windows. */
  spare?: boolean;
  /** Navigation and window-open guards, applied to every window including pop-ups. */
  attachGuards: (window: BrowserWindow) => void;
}

interface Spare {
  window: BrowserWindow;
  ready: boolean;
  limit: NodeJS.Timeout;
}

export class WindowManager extends EventEmitter<{
  created: [ManagedWindow];
  closed: [ManagedWindow];
  changed: [WindowInfo[]];
  /** The user chose to stay on a page, so whatever was closing it is off. */
  stayed: [];
  /** A main window is signed in, with a session to lend. */
  sessionReady: [];
}> {
  private readonly windows = new Map<number, ManagedWindow>();
  private lastFocused: number | null = null;
  private nextFlushId = 1;
  private readonly flushWaits = new Map<number, (answers: FlushAnswer[]) => void>();
  private quitting = false;
  private closeToBackground: () => boolean = () => false;
  private spare: Spare | null = null;
  private spareTimer: NodeJS.Timeout | null = null;
  /** No more tries this run: the page has no spare route. */
  private spareUnsupported = false;
  private savedSession: SessionWindow[];
  private readonly startedAt = Date.now();

  constructor(private readonly options: WindowManagerOptions) {
    super();
    options.theme.onChange((colours) => this.applyChrome(colours));
    options.theme.onSystemChange((system) => this.broadcast(CHANNEL.themeSystem, system));
    this.on('changed', (windows) => {
      this.broadcast(CHANNEL.windowsChanged, windows);
      this.storeSession();
    });
    const { state } = options;
    this.savedSession = state.data.restoreWindows === false ? [] : (state.data.session ?? []);
  }

  /** What every window with the bridge runs on. Also used for window.open pop-ups. */
  webPreferences(): WebPreferences {
    const { session, preloadPath, origin, mode, devTools } = this.options;
    return {
      session,
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
      devTools,
      additionalArguments: [
        `${PRELOAD_ARG.allowedOrigin}${origin}`,
        `${PRELOAD_ARG.mode}${mode}`,
        `${PRELOAD_ARG.keystore}${native().keystore.available ? '1' : '0'}`,
      ],
    };
  }

  /**
   * Does the page draw its own title bar row? Only then can the native frame go:
   * without the row nothing can drag the window, and the controls would cover
   * the page. Unknown means yes; `checkOverlay` corrects it and remembers.
   */
  wantsOverlay(): boolean {
    if (process.platform === 'linux') return false;
    return this.options.state.data.overlayByOrigin[this.options.origin] !== false;
  }

  private chromeOptions(colours: ChromeColours): BrowserWindowConstructorOptions {
    if (!this.wantsOverlay()) return { autoHideMenuBar: true };
    if (process.platform === 'darwin') {
      return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 }, titleBarOverlay: { height: TITLE_BAR_HEIGHT } };
    }
    return {
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: colours.background, symbolColor: colours.symbol, height: TITLE_BAR_HEIGHT },
    };
  }

  /** The options of a new window apart from its place: for us, and for window.open. */
  windowOptions(type: WindowType): BrowserWindowConstructorOptions {
    const colours = this.options.theme.colours();
    return {
      show: false,
      backgroundColor: colours.background,
      title: 'Bulwark',
      ...MIN_SIZE[type],
      ...this.chromeOptions(colours),
      webPreferences: this.webPreferences(),
    };
  }

  /** Remembered, cascaded, on the current monitor. */
  placeFor(type: WindowType, size?: { width: number; height: number }): Rect {
    // Not a main window hidden behind its pop-outs. One still painting does count: a second window opened right after it must not land on top.
    const others = [...this.windows.values()].filter((w) => !w.window.isDestroyed() && (w.type !== 'main' || w.window.isVisible()));
    const sameType = others.filter((w) => w.type === type).at(-1)?.window.getNormalBounds();
    const focused = this.focusedManaged()?.window;
    const anchor = (focused && others.some((w) => w.window === focused) ? focused.getNormalBounds() : undefined) ?? others.at(-1)?.window.getNormalBounds();
    const current = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay();
    return placeWindow({
      size: size ?? DEFAULT_SIZE[type],
      stored: this.options.state.data.windowBounds[type],
      sameType,
      anchor,
      displays: screen.getAllDisplays(),
      current,
    });
  }

  open(options: OpenOptions): BrowserWindow {
    const key = options.key ?? (options.type === 'main' ? 'main' : null);
    if (key !== null) {
      const existing = this.findByKey(key);
      if (existing) {
        this.focusWindow(existing.window);
        return existing.window;
      }
    }
    if (!options.noSpare) {
      const warm = this.activateSpare(options, key);
      if (warm) return warm;
    }
    const place = options.place ?? this.placeFor(options.type, options.size);
    const window = new BrowserWindow({ ...this.windowOptions(options.type), ...place });
    // The constructor is further off than setBounds on a scaled display.
    window.setBounds(place);
    const managed = this.adopt(window, options.type, key, options.url, false, options.inactive);
    managed.initialBounds = window.getNormalBounds();
    if (options.type === 'main' && this.options.state.data.windowBounds.main?.maximized) window.maximize();
    void window.loadURL(options.url).catch(() => {
      // A failed load shows Chromium's error page; the guards and ready-to-show still apply.
    });
    return window;
  }

  /** Takes in a window made by window.open as well as our own. */
  adopt(window: BrowserWindow, type: WindowType, key: string | null, url: string, warm = false, inactive = false): ManagedWindow {
    const managed: ManagedWindow = { window, type, key, url };
    this.windows.set(window.id, managed);
    if (!warm) {
      this.options.attachGuards(window);
      this.showWhenPainted(managed, inactive);
    }

    const { webContents } = window;
    if (!warm) webContents.on('did-change-theme-color', (_event, colour) => this.options.theme.setFromPageColour(colour));
    webContents.on('page-title-updated', () => this.emitChanged());
    window.on('focus', () => {
      this.lastFocused = window.id;
      this.emitChanged();
    });
    window.on('hide', () => this.emitChanged());
    window.on('show', () => this.emitChanged());
    for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const) {
      window.on(event as 'resize', () => {
        this.rememberBounds(managed);
        this.storeSession();
      });
    }
    window.on('close', (event) => {
      this.rememberBounds(managed);
      if (this.shouldHide(managed)) {
        event.preventDefault();
        window.hide();
        return;
      }
      if (!managed.flushable || managed.flushed) return;
      event.preventDefault();
      void this.flushWindow(managed).then((answers) => {
        if (window.isDestroyed()) return;
        const { failed, unsent } = sumAnswers(answers);
        if (!this.confirmLeaving(window, failed, this.isLastOnScreen(managed) ? unsent : 0)) return;
        managed.flushed = true;
        window.close();
      });
    });
    // Unanswered, this cancels the close silently, and a quit with it.
    webContents.on('will-prevent-unload', (event) => {
      const text = strings();
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      const choice = dialog.showMessageBoxSync(window, {
        type: 'question',
        title: 'Bulwark',
        message: text.leaveTitle,
        detail: text.leaveDetail,
        buttons: [text.leave, text.stay],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (choice === 0) {
        event.preventDefault();
        return;
      }
      for (const other of this.windows.values()) other.flushed = false;
      this.quitting = false;
      this.emit('stayed');
    });
    window.once('closed', () => {
      this.windows.delete(window.id);
      if (this.lastFocused === window.id) this.lastFocused = null;
      this.emit('closed', managed);
      this.emitChanged();
      this.afterClosed();
    });

    this.emit('created', managed);
    this.emitChanged();
    return managed;
  }

  /** True if the window may go. A prompt only when something would be lost. */
  private confirmLeaving(window: BrowserWindow, failed: number, unsent: number): boolean {
    if (failed === 0 && unsent === 0) return true;
    const text = strings();
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: 'Bulwark',
      message: failed > 0 ? text.unsavedTitle : text.unsentTitle,
      detail: failed > 0 ? text.unsavedDetail : text.unsentDetail(unsent),
      buttons: [failed > 0 ? text.closeAnyway : text.closeNow, text.stay],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 0) return true;
    this.emit('stayed');
    return false;
  }

  /**
   * The last main window with pop-outs open only hides: they borrow its session.
   * The same when the app is to stay in the background (tray, macOS).
   */
  private shouldHide(managed: ManagedWindow): boolean {
    if (this.quitting || managed.type !== 'main') return false;
    const others = [...this.windows.values()].filter((w) => w !== managed && !w.window.isDestroyed());
    if (others.some((w) => w.type === 'main')) return false;
    return others.length > 0 || this.staysInBackground();
  }

  private staysInBackground(): boolean {
    return process.platform === 'darwin' || this.closeToBackground();
  }

  private isLastOnScreen(managed: ManagedWindow): boolean {
    if (this.staysInBackground()) return false;
    return ![...this.windows.values()].some((w) => w !== managed && !w.window.isDestroyed() && this.onScreen(w));
  }

  /** A pop-out still painting counts: only a main window can be hidden on purpose. */
  private onScreen(managed: ManagedWindow): boolean {
    return managed.type !== 'main' || managed.window.isVisible();
  }

  /** A pop-out closed. If only a hidden main is left and nothing keeps the app running, it goes too. */
  private afterClosed(): void {
    if (this.windows.size === 0) {
      this.destroySpare();
      return;
    }
    if (this.quitting || this.staysInBackground()) return;
    const left = [...this.windows.values()].filter((w) => !w.window.isDestroyed());
    if (left.some((w) => this.onScreen(w))) return;
    for (const { window } of left) window.close();
  }

  /**
   * Whether closing the last window leaves the app running. The tray feature calls
   * this with its `closeToTray` setting. macOS stays regardless, as apps do there.
   */
  setCloseToBackground(check: () => boolean): void {
    this.closeToBackground = check;
  }

  /** From here on closing a window closes it. Undone by choosing Stay in a prompt. */
  beginQuit(): void {
    this.quitting = true;
    this.destroySpare();
    this.options.state.save();
  }

  cancelQuit(): void {
    this.quitting = false;
    for (const managed of this.windows.values()) managed.flushed = false;
  }

  private showWhenPainted(managed: ManagedWindow, inactive = false): void {
    const { window } = managed;
    const show = () => {
      if (inactive) window.showInactive();
      else window.show();
    };
    const fallback = setTimeout(() => {
      if (!window.isDestroyed() && !window.isVisible()) show();
    }, SHOW_FALLBACK_MS);
    window.once('closed', () => clearTimeout(fallback));
    window.once('ready-to-show', () => {
      clearTimeout(fallback);
      if (window.isDestroyed()) return;
      void this.checkOverlay(managed).then((replaced) => {
        if (!replaced && !window.isDestroyed() && !window.isVisible()) show();
        if (!replaced && managed.type === 'main') this.scheduleSpare(SPARE_FIRST_DELAY_MS);
      });
    });
  }

  /**
   * An older instance has no --titlebar-inset, so it can't take a frameless
   * window: rebuilt once with a native frame, still hidden, and remembered per
   * origin. The other way round only takes effect on the next window.
   * Returns true if the window was replaced.
   */
  private async checkOverlay(managed: ManagedWindow): Promise<boolean> {
    if (process.platform === 'linux') return false;
    const { window, type, key, url } = managed;
    let knowsInset: unknown;
    try {
      if (new URL(window.webContents.getURL()).origin !== this.options.origin) return false;
      knowsInset = await window.webContents.executeJavaScript(
        "getComputedStyle(document.documentElement).getPropertyValue('--titlebar-inset') !== ''",
        true,
      );
    } catch {
      return false;
    }
    if (window.isDestroyed() || typeof knowsInset !== 'boolean') return false;
    const had = this.wantsOverlay();
    const { state, origin } = this.options;
    state.data.overlayByOrigin[origin] = knowsInset;
    state.touch();
    if (!had || knowsInset) return false;
    // The new one first: with no windows left, the app would quit.
    this.windows.delete(window.id);
    window.removeAllListeners('closed');
    this.open({ type, key: key ?? undefined, url, noSpare: true });
    window.destroy();
    return true;
  }

  private rememberBounds(managed: ManagedWindow): void {
    const { window, type } = managed;
    if (window.isDestroyed() || window.isFullScreen() || window.isMinimized()) return;
    const bounds = window.getNormalBounds();
    // On a scaled display a window comes out a few pixels off what was asked for.
    // Storing that would make a remembered size creep with every launch, so only
    // a change after that counts.
    const start = managed.initialBounds;
    const untouched = start && start.x === bounds.x && start.y === bounds.y && start.width === bounds.width && start.height === bounds.height;
    const maximized = window.isMaximized();
    const stored = this.options.state.data.windowBounds[type];
    if (untouched && stored && !!stored.maximized === maximized) return;
    this.options.state.data.windowBounds[type] = untouched && stored ? { ...stored, maximized } : { ...bounds, maximized };
    this.options.state.touch();
  }

  private applyChrome(colours: ChromeColours): void {
    const all = [...this.windows.values()].map((w) => w.window);
    if (this.spare) all.push(this.spare.window);
    for (const window of all) {
      if (window.isDestroyed()) continue;
      window.setBackgroundColor(colours.background);
      if (process.platform === 'win32' && this.wantsOverlay()) {
        try {
          window.setTitleBarOverlay({ color: colours.background, symbolColor: colours.symbol, height: TITLE_BAR_HEIGHT });
        } catch {
          // A window that was made with a native frame has no overlay to colour.
        }
      }
    }
  }

  // ─── The warm spare ─────────────────────────────────────────

  private scheduleSpare(delay: number): void {
    if (this.options.spare === false || this.spareUnsupported || this.spare || this.spareTimer || this.quitting) return;
    this.spareTimer = setTimeout(() => {
      this.spareTimer = null;
      this.createSpare();
    }, delay);
    this.spareTimer.unref?.();
  }

  private createSpare(): void {
    if (this.spare || this.quitting || this.windows.size === 0) return;
    const window = new BrowserWindow({ ...this.windowOptions('composer'), ...DEFAULT_SIZE.composer });
    this.options.attachGuards(window);
    window.webContents.on('did-change-theme-color', (_event, colour) => this.options.theme.setFromPageColour(colour));
    const limit = setTimeout(() => {
      this.spareUnsupported = true;
      this.destroySpare();
    }, SPARE_READY_LIMIT_MS);
    this.spare = { window, ready: false, limit };
    window.once('closed', () => {
      clearTimeout(limit);
      if (this.spare?.window === window) this.spare = null;
    });
    void window.loadURL(`${this.options.origin}/popout/spare`).catch(() => {});
  }

  /** The spare page has loaded and waits. */
  spareReady(window: BrowserWindow): void {
    if (this.spare?.window !== window) return;
    clearTimeout(this.spare.limit);
    this.spare.ready = true;
  }

  private destroySpare(): void {
    if (this.spareTimer) clearTimeout(this.spareTimer);
    this.spareTimer = null;
    const spare = this.spare;
    this.spare = null;
    if (spare && !spare.window.isDestroyed()) spare.window.destroy();
  }

  /**
   * Makes the spare into the pop-out: its place and size, then the page swaps in
   * the route without a load and the window shows. Only `message` and `composer`,
   * which is all the spare page knows how to become.
   */
  private activateSpare(options: OpenOptions, key: string | null): BrowserWindow | null {
    if (options.type !== 'message' && options.type !== 'composer') return null;
    const spare = this.spare;
    if (!spare?.ready || spare.window.isDestroyed()) return null;
    this.spare = null;
    const { window } = spare;
    const place = options.place ?? this.placeFor(options.type, options.size);
    const { minWidth, minHeight } = MIN_SIZE[options.type];
    window.setMinimumSize(minWidth, minHeight);
    window.setBounds(place);
    const managed = this.adopt(window, options.type, key, options.url, true);
    managed.initialBounds = window.getNormalBounds();
    let taken = false;
    window.webContents.once('ipc-message', (_event, channel) => {
      if (channel === CHANNEL.windowsSpareTaken) taken = true;
    });
    window.webContents.send(CHANNEL.windowsSpareActivate, options.url);
    window.show();
    setTimeout(() => {
      if (!taken && !window.isDestroyed()) void window.loadURL(options.url).catch(() => {});
    }, SPARE_TAKEN_LIMIT_MS).unref?.();
    this.scheduleSpare(SPARE_NEXT_DELAY_MS);
    return window;
  }

  // ─── Saving before a window goes ────────────────────────────

  setFlushable(window: BrowserWindow, flushable: boolean): void {
    const managed = this.windows.get(window.id);
    if (managed) managed.flushable = flushable;
  }

  flushDone(id: number, answers: unknown): void {
    this.flushWaits.get(id)?.(Array.isArray(answers) ? (answers as FlushAnswer[]) : []);
  }

  /** Asks the page to save and waits, within limits: a hung page can't keep a window open. */
  private flushWindow(managed: ManagedWindow): Promise<FlushAnswer[]> {
    if (!managed.flushable || managed.window.isDestroyed()) return Promise.resolve([]);
    return new Promise((resolve) => {
      const id = this.nextFlushId++;
      const finish = (answers: FlushAnswer[]) => {
        clearTimeout(timer);
        this.flushWaits.delete(id);
        resolve(answers);
      };
      const timer = setTimeout(() => finish([{ timedOut: true }]), FLUSH_TIMEOUT_MS);
      this.flushWaits.set(id, finish);
      managed.window.webContents.send(CHANNEL.lifecycleFlush, id);
    });
  }

  /** Before a quit, every window at once. */
  async flushAll(): Promise<FlushSummary> {
    const pending = [...this.windows.values()].filter((w) => w.flushable && !w.flushed && !w.window.isDestroyed());
    const answers = await Promise.all(pending.map((w) => this.flushWindow(w)));
    for (const w of pending) w.flushed = true;
    const { failed, unsent } = sumAnswers(answers.flat());
    return { asked: pending.length > 0, failed, unsent };
  }

  /** The page decided: it has saved, or discarded, and asks to go. No second save. */
  closeSelf(window: BrowserWindow): void {
    const managed = this.windows.get(window.id);
    if (managed) managed.flushed = true;
    window.close();
  }

  // ─── Coming back next time ──────────────────────────────────

  setRestoreUrls(window: BrowserWindow, urls: string[]): void {
    const managed = this.windows.get(window.id);
    if (!managed) return;
    managed.restoreUrls = urls;
    this.storeSession();
  }

  private sessionWindows(): SessionWindow[] {
    const entries: SessionWindow[] = [];
    for (const managed of this.windows.values()) {
      const { window, type, key } = managed;
      if (window.isDestroyed()) continue;
      const bounds = window.getNormalBounds();
      // A composer comes back through its draft, or not at all.
      if (type === 'message' || type === 'settings') {
        let url = managed.url;
        try {
          const current = window.webContents.getURL();
          if (new URL(current).origin === this.options.origin && windowTypeOf(new URL(current).pathname) === type) url = current;
        } catch {
          // Still loading: what it was opened with.
        }
        entries.push({ type, url, key: key ?? undefined, bounds });
      } else if (type === 'main' && key !== 'main') {
        entries.push({ type, url: managed.url, key: key ?? undefined, bounds });
      }
      for (const url of managed.restoreUrls ?? []) {
        entries.push({ type: 'composer', url, key: `restored:${url}`, bounds: type === 'composer' ? bounds : undefined });
      }
    }
    return entries;
  }

  private storeSession(): void {
    // Quitting closes the windows one by one, which would forget them.
    if (this.quitting) return;
    this.options.state.data.session = this.sessionWindows();
    this.options.state.touch();
  }

  setRestoreEnabled(enabled: boolean): void {
    this.options.state.data.restoreWindows = enabled;
    this.options.state.touch();
    if (!enabled) this.savedSession = [];
  }

  /**
   * The main window has a session to lend, so what was open last time can come back.
   * Once, and only near the start.
   */
  restoreSession(): void {
    const saved = this.savedSession;
    this.savedSession = [];
    if (saved.length === 0 || Date.now() - this.startedAt > RESTORE_LIMIT_MS) return;
    for (const entry of saved) {
      if (!this.validSessionEntry(entry)) continue;
      const bounds = entry.bounds && isOnSomeDisplay(entry.bounds, screen.getAllDisplays()) ? fitInto(entry.bounds, screen.getDisplayMatching(entry.bounds).workArea) : undefined;
      this.open({ type: entry.type, url: entry.url, key: entry.key, place: bounds, noSpare: true, inactive: true });
    }
  }

  private validSessionEntry(entry: SessionWindow): boolean {
    try {
      const url = new URL(entry.url);
      return url.protocol === 'https:' && url.origin === this.options.origin && windowTypeOf(url.pathname) === entry.type;
    } catch {
      return false;
    }
  }

  // ─── Finding and focusing ───────────────────────────────────

  findByKey(key: string): ManagedWindow | undefined {
    return [...this.windows.values()].find((w) => w.key === key && !w.window.isDestroyed());
  }

  managedFor(window: BrowserWindow): ManagedWindow | undefined {
    return this.windows.get(window.id);
  }

  all(): ManagedWindow[] {
    return [...this.windows.values()].filter((w) => !w.window.isDestroyed());
  }

  mainWindow(): BrowserWindow | undefined {
    return [...this.windows.values()].find((w) => w.type === 'main' && !w.window.isDestroyed())?.window;
  }

  focusedManaged(): ManagedWindow | undefined {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && this.windows.has(focused.id)) return this.windows.get(focused.id);
    return this.lastFocused !== null ? this.windows.get(this.lastFocused) : undefined;
  }

  focusWindow(window: BrowserWindow): void {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  }

  /** With an id, that window. With none, the main one. */
  focus(id?: number): void {
    const window = typeof id === 'number' ? this.windows.get(id)?.window : this.mainWindow();
    if (window) this.focusWindow(window);
  }

  /** Ctrl+`: the next window on screen, in the order they opened. */
  cycle(direction: 1 | -1 = 1): void {
    const shown = this.all().filter((w) => w.window.isVisible());
    const next = nextInCycle(shown.map((w) => w.window.id), this.focusedManaged()?.window.id, direction);
    if (next !== null) this.focus(next);
  }

  list(): WindowInfo[] {
    const focused = BrowserWindow.getFocusedWindow()?.id;
    return [...this.windows.values()]
      .filter((w) => !w.window.isDestroyed())
      .map(({ window, type }) => ({ id: window.id, type, title: window.getTitle(), focused: window.id === focused, visible: window.isVisible() }));
  }

  broadcast(channel: string, payload: unknown): void {
    for (const { window } of this.windows.values()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
    if (this.spare && !this.spare.window.isDestroyed()) this.spare.window.webContents.send(channel, payload);
  }

  private emitChanged(): void {
    this.emit('changed', this.list());
  }

  isEmpty(): boolean {
    return this.windows.size === 0;
  }

  /** Nothing on screen: another launch or a dock click brings the main window back. */
  noneVisible(): boolean {
    return !this.all().some((w) => w.window.isVisible());
  }

  originUrl(): string {
    return this.options.origin;
  }
}
