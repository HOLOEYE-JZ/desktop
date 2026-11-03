/**
 * The window manager. All app windows go through here: main, message, composer
 * and settings. One window per message, per-type remembered bounds, cascading,
 * monitor-safe placement, and no white flash (hidden until first paint, with the
 * theme's background).
 *
 * Step 6 features listen to the events (`created`, `changed`) and use `list`,
 * `focus` and `broadcast`. They don't create windows themselves.
 */

import { EventEmitter } from 'node:events';
import { BrowserWindow, dialog, screen, type BrowserWindowConstructorOptions, type Session, type WebPreferences } from 'electron';
import { CHANNEL, PRELOAD_ARG, type Mode, type WindowInfo, type WindowType } from '../shared/bridge';
import type { StateFile } from './state';
import { strings } from './strings';
import type { ChromeColours, ThemeController } from './theme';
import { placeWindow, type Rect } from './window-placement';

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
}

export interface WindowManagerOptions {
  state: StateFile;
  theme: ThemeController;
  session: Session;
  origin: string;
  mode: Mode;
  preloadPath: string;
  devTools: boolean;
  /** Navigation and window-open guards, applied to every window including pop-ups. */
  attachGuards: (window: BrowserWindow) => void;
}

export class WindowManager extends EventEmitter<{
  created: [ManagedWindow];
  closed: [ManagedWindow];
  changed: [WindowInfo[]];
  /** The user chose to stay on a page, so whatever was closing it is off. */
  stayed: [];
}> {
  private readonly windows = new Map<number, ManagedWindow>();
  private lastFocused: number | null = null;
  private nextFlushId = 1;
  private readonly flushWaits = new Map<number, () => void>();

  constructor(private readonly options: WindowManagerOptions) {
    super();
    options.theme.onChange((colours) => this.applyChrome(colours));
    options.theme.onSystemChange((system) => this.broadcast(CHANNEL.themeSystem, system));
    this.on('changed', (windows) => this.broadcast(CHANNEL.windowsChanged, windows));
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
      additionalArguments: [`${PRELOAD_ARG.allowedOrigin}${origin}`, `${PRELOAD_ARG.mode}${mode}`],
    };
  }

  /**
   * Does the page draw its own title bar row? Only then can the native frame go:
   * without the row nothing can drag the window, and the controls would cover
   * the page. Unknown means yes; `checkOverlay` corrects it and remembers.
   */
  private wantsOverlay(): boolean {
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
    const others = [...this.windows.values()].filter((w) => !w.window.isDestroyed());
    const sameType = others.filter((w) => w.type === type).at(-1)?.window.getNormalBounds();
    const focused = this.focusedManaged()?.window.getNormalBounds();
    const anchor = focused ?? others.at(-1)?.window.getNormalBounds();
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
    const place = this.placeFor(options.type, options.size);
    const window = new BrowserWindow({ ...this.windowOptions(options.type), ...place });
    // The constructor is further off than setBounds on a scaled display.
    window.setBounds(place);
    const managed = this.adopt(window, options.type, key, options.url);
    managed.initialBounds = window.getNormalBounds();
    if (options.type === 'main' && this.options.state.data.windowBounds.main?.maximized) window.maximize();
    void window.loadURL(options.url).catch(() => {
      // A failed load shows Chromium's error page; the guards and ready-to-show still apply.
    });
    return window;
  }

  /** Takes in a window made by window.open as well as our own. */
  adopt(window: BrowserWindow, type: WindowType, key: string | null, url: string): ManagedWindow {
    const managed: ManagedWindow = { window, type, key, url };
    this.windows.set(window.id, managed);
    this.options.attachGuards(window);
    this.showWhenPainted(managed);

    const { webContents } = window;
    webContents.on('did-change-theme-color', (_event, colour) => this.options.theme.setFromPageColour(colour));
    webContents.on('page-title-updated', () => this.emitChanged());
    window.on('focus', () => {
      this.lastFocused = window.id;
      this.emitChanged();
    });
    for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const) {
      window.on(event as 'resize', () => this.rememberBounds(managed));
    }
    window.on('close', (event) => {
      this.rememberBounds(managed);
      if (!managed.flushable || managed.flushed) return;
      event.preventDefault();
      void this.flushWindow(managed).then(() => {
        managed.flushed = true;
        if (!window.isDestroyed()) window.close();
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
      this.emit('stayed');
    });
    window.once('closed', () => {
      this.windows.delete(window.id);
      if (this.lastFocused === window.id) this.lastFocused = null;
      this.emit('closed', managed);
      this.emitChanged();
    });

    this.emit('created', managed);
    this.emitChanged();
    return managed;
  }

  private showWhenPainted(managed: ManagedWindow): void {
    const { window } = managed;
    const fallback = setTimeout(() => {
      if (!window.isDestroyed() && !window.isVisible()) window.show();
    }, SHOW_FALLBACK_MS);
    window.once('closed', () => clearTimeout(fallback));
    window.once('ready-to-show', () => {
      clearTimeout(fallback);
      if (window.isDestroyed()) return;
      void this.checkOverlay(managed).then((replaced) => {
        if (!replaced && !window.isDestroyed() && !window.isVisible()) window.show();
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
    this.open({ type, key: key ?? undefined, url });
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
    for (const { window } of this.windows.values()) {
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

  setFlushable(window: BrowserWindow, flushable: boolean): void {
    const managed = this.windows.get(window.id);
    if (managed) managed.flushable = flushable;
  }

  flushDone(id: number): void {
    this.flushWaits.get(id)?.();
  }

  /** Asks the page to save and waits, within limits: a hung page can't keep a window open. */
  private flushWindow(managed: ManagedWindow): Promise<void> {
    if (!managed.flushable || managed.window.isDestroyed()) return Promise.resolve();
    return new Promise((resolve) => {
      const id = this.nextFlushId++;
      const finish = () => {
        clearTimeout(timer);
        this.flushWaits.delete(id);
        resolve();
      };
      const timer = setTimeout(finish, FLUSH_TIMEOUT_MS);
      this.flushWaits.set(id, finish);
      managed.window.webContents.send(CHANNEL.lifecycleFlush, id);
    });
  }

  /** Before a quit, every window at once. True if any had something to save. */
  async flushAll(): Promise<boolean> {
    const pending = [...this.windows.values()].filter((w) => w.flushable && !w.flushed && !w.window.isDestroyed());
    await Promise.all(pending.map((w) => this.flushWindow(w)));
    for (const w of pending) w.flushed = true;
    return pending.length > 0;
  }

  findByKey(key: string): ManagedWindow | undefined {
    return [...this.windows.values()].find((w) => w.key === key && !w.window.isDestroyed());
  }

  managedFor(window: BrowserWindow): ManagedWindow | undefined {
    return this.windows.get(window.id);
  }

  mainWindow(): BrowserWindow | undefined {
    return [...this.windows.values()].find((w) => w.type === 'main' && !w.window.isDestroyed())?.window;
  }

  private focusedManaged(): ManagedWindow | undefined {
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

  list(): WindowInfo[] {
    const focused = BrowserWindow.getFocusedWindow()?.id;
    return [...this.windows.values()]
      .filter((w) => !w.window.isDestroyed())
      .map(({ window, type }) => ({ id: window.id, type, title: window.getTitle(), focused: window.id === focused }));
  }

  broadcast(channel: string, payload: unknown): void {
    for (const { window } of this.windows.values()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  }

  private emitChanged(): void {
    this.emit('changed', this.list());
  }

  isEmpty(): boolean {
    return this.windows.size === 0;
  }

  originUrl(): string {
    return this.options.origin;
  }
}
