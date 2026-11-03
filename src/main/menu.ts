/**
 * The app menu. Commands the page has to run go to it by id over the bridge
 * (`menu.onCommand`), where the webmail's own actions run them: nothing here knows
 * how to reply or move a message. What the page reports with `menu.setState` decides
 * what's enabled, per window, applied when that window has the focus.
 *
 * Shortcuts and the webmail's own: single keys (r, f, Delete) belong to the page,
 * which knows when you're typing or a dialog is open. They're shown here without being
 * registered, on Windows and Linux. macOS has no such option, so they're left off there
 * and the keys still work. When the user turned single keys off, none are shown.
 * Chords such as Ctrl+N are real accelerators. A key press reaches the page first,
 * and only one the page didn't take reaches the menu, so the two can't both fire.
 *
 * In a window with an integrated title bar on Windows there's no native bar: the page
 * draws a strip when Alt is pressed, and the strip opens these same menus natively.
 */

import { app, BrowserWindow, Menu, shell, type MenuItem, type MenuItemConstructorOptions } from 'electron';
import { CHANNEL, type MenuBarEntry, type MenuBarEvent, type MenuState, type WindowInfo } from '../shared/bridge';
import { assignMnemonics } from './menu-text';
import { strings } from './strings';
import type { WindowManager } from './windows';

export interface MenuHooks {
  /** Left out while a policy forces the connection. */
  switchMode?: () => void;
  devTools: boolean;
  newWindow: () => void;
  openSettings: () => void;
  zoom: (step: 1 | -1 | 0) => void;
  print: (window: BrowserWindow) => void;
  saveAsPdf: (window: BrowserWindow) => void;
  back: (window: BrowserWindow, direction: 1 | -1) => void;
}

/** Features add their own lines, such as "Restart to update". */
export type MenuSection = 'file' | 'view' | 'help' | 'app';
type Extension = () => MenuItemConstructorOptions[];

/** Commands that go to the main window, wherever the focus is. */
function runsInMain(id: string): boolean {
  return id.startsWith('go.') || id.startsWith('view.layout.') || id === 'view.refresh' || id === 'help.shortcuts';
}

/** Enabled unless a state says otherwise, and available in a page with no state. */
const SHELL_COMMANDS = new Set(['file.newWindow', 'file.print', 'file.savePdf', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset', 'go.back', 'go.forward']);

const SHELL_STATE_COMMANDS = ['file.print', 'file.savePdf'];

/** Letters the keys of `File`, `Edit` … open with Alt. Strings mark them with &. */
function mnemonicOf(label: string): string | undefined {
  const at = label.indexOf('&');
  return at >= 0 ? label[at + 1]?.toLowerCase() : undefined;
}

function withoutMnemonic(label: string): string {
  return label.replace(/&(.)/g, '$1');
}

export class MenuController {
  private readonly stateByWindow = new WeakMap<BrowserWindow, MenuState>();
  private readonly extensions = new Map<MenuSection, Extension[]>();
  private windows: WindowManager | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly hooks: MenuHooks) {}

  /** What the start decided, once it has: nothing is offered before that. */
  allowSwitchingMode(switchMode: (() => void) | undefined): void {
    this.hooks.switchMode = switchMode;
    this.rebuild();
  }

  /** Once a mode has started: the first-run page has a menu without any windows behind it. */
  attach(windows: WindowManager): void {
    this.windows = windows;
    // A page's report is for that page: the next one starts over.
    windows.on('navigated', (window) => {
      this.stateByWindow.delete(window);
      this.applyState();
    });
    windows.on('changed', (list) => {
      // Windows came or went, or a title changed: the Window menu has other lines now.
      // Only the focus moving is a matter of ticks and greyed items.
      const signature = list.map((w) => `${w.id}:${w.title}`).join('\n');
      if (signature !== this.windowSignature) {
        this.windowSignature = signature;
        this.scheduleRebuild();
      } else {
        this.applyState();
      }
    });
    this.rebuild();
  }

  /** The window lines the menu was last built with. */
  private windowSignature = '';

  extend(section: MenuSection, extension: Extension): void {
    this.extensions.set(section, [...(this.extensions.get(section) ?? []), extension]);
    this.scheduleRebuild();
  }

  private extras(section: MenuSection): MenuItemConstructorOptions[] {
    const items = (this.extensions.get(section) ?? []).flatMap((extension) => extension());
    return items.length ? [{ type: 'separator' }, ...items] : [];
  }

  private scheduleRebuild(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.rebuild();
    }, 50);
    this.timer.unref?.();
  }

  /** Greys and ticks, in place, with no new menu. */
  private applyState(): void {
    const menu = Menu.getApplicationMenu();
    if (!menu) return;
    const walk = (items: MenuItem[]) => {
      for (const item of items) {
        if (item.submenu) walk(item.submenu.items);
        const id = item.id;
        if (!id) continue;
        if (id.startsWith('window.focus.')) {
          item.checked = this.windows?.focusedManaged()?.window.id === Number(id.slice('window.focus.'.length));
          continue;
        }
        if (!/^(file|edit|view|message|go|help)\./.test(id) || !this.knownCommands.has(id)) continue;
        const state = this.stateOf(id);
        item.enabled = state.enabled;
        if (item.type === 'checkbox' && state.checked !== undefined) item.checked = state.checked;
        // Setting a radio item at all ticks it, whatever the value: Electron's group does that.
        if (item.type === 'radio' && state.checked) item.checked = true;
      }
    };
    walk(menu.items);
  }

  /** Items whose state comes from the page or the policy. */
  private readonly knownCommands = new Set<string>(SHELL_STATE_COMMANDS);

  /** The language changed: a new menu. */
  refresh(): void {
    this.scheduleRebuild();
  }

  /** The window a command is for: the focused one, or the one last used. */
  private target(id: string): BrowserWindow | undefined {
    const windows = this.windows;
    if (!windows) return undefined;
    const focused = windows.focusedManaged();
    // A second main window's Go menu goes in that window.
    if (runsInMain(id)) return focused?.type === 'main' ? focused.window : windows.mainWindow();
    return focused?.window ?? windows.mainWindow();
  }

  /** Sends a command to the page that can run it. */
  dispatch(id: string): void {
    const window = this.target(id);
    if (!window || window.isDestroyed()) return;
    if (runsInMain(id)) this.windows?.focusWindow(window);
    window.webContents.send(CHANNEL.menuCommand, id);
  }

  private stateOf(id: string): { enabled: boolean; checked?: boolean } {
    const window = this.target(id);
    const state = window ? this.stateByWindow.get(window) : undefined;
    if (SHELL_COMMANDS.has(id)) {
      const entry = state?.[id];
      return { enabled: typeof entry === 'boolean' ? entry : (entry?.enabled ?? true) };
    }
    const entry = state?.[id];
    if (entry === undefined) return { enabled: false };
    if (typeof entry === 'boolean') return { enabled: entry };
    return { enabled: entry.enabled ?? true, checked: entry.checked };
  }

  private singleKeysOff(): boolean {
    const window = this.target('message.reply');
    const state = window ? this.stateByWindow.get(window) : undefined;
    return state?.['shortcuts.singleKeys'] === false;
  }

  /** A shortcut the page handles itself: only ever shown, never registered. */
  private pageKey(accelerator: string, single = true): Pick<MenuItemConstructorOptions, 'accelerator' | 'registerAccelerator'> {
    if (process.platform === 'darwin') return {};
    if (single && this.singleKeysOff()) return {};
    return { accelerator, registerAccelerator: false };
  }

  private command(id: string, label: string, extra: MenuItemConstructorOptions = {}): MenuItemConstructorOptions {
    this.knownCommands.add(id);
    const state = this.stateOf(id);
    return {
      id,
      label,
      enabled: state.enabled,
      ...(extra.type === 'checkbox' || extra.type === 'radio' ? { checked: state.checked ?? false } : {}),
      click: () => this.dispatch(id),
      ...extra,
    };
  }

  private windowEntries(): MenuItemConstructorOptions[] {
    const windows = this.windows;
    if (!windows) return [];
    const text = strings();
    const list = windows.list();
    if (list.length === 0) return [];
    const nameOf = (info: WindowInfo) => info.title || text.windowNames[info.type];
    return [
      { type: 'separator' },
      ...list.map((info): MenuItemConstructorOptions => ({
        id: `window.focus.${info.id}`,
        label: nameOf(info).replace(/&/g, '&&'),
        type: 'checkbox',
        checked: info.focused,
        click: () => windows.focus(info.id),
      })),
    ];
  }

  buildTemplate(): MenuItemConstructorOptions[] {
    const text = strings();
    const { hooks, windows } = this;
    const mac = process.platform === 'darwin';
    // A bare window counts: a preview's Ctrl+P prints the preview, not what's behind it.
    const focused = () => BrowserWindow.getFocusedWindow() ?? windows?.focusedManaged()?.window;
    const onFocused = (run: (window: BrowserWindow) => void) => () => {
      const window = focused();
      if (window) run(window);
    };

    const fileMenu: MenuItemConstructorOptions = {
      id: 'file',
      label: text.menuFile,
      submenu: [
        this.command('file.newMessage', text.menuNewMessage, { accelerator: 'CmdOrCtrl+N' }),
        { id: 'file.newWindow', label: text.menuNewWindow, accelerator: 'CmdOrCtrl+Shift+N', enabled: !!windows, click: hooks.newWindow },
        { type: 'separator' },
        {
          id: 'file.print',
          label: text.menuPrint,
          accelerator: 'CmdOrCtrl+P',
          enabled: !!windows && this.stateOf('file.print').enabled,
          click: onFocused(hooks.print),
        },
        {
          id: 'file.savePdf',
          label: text.menuSavePdf,
          accelerator: 'CmdOrCtrl+Shift+S',
          enabled: !!windows && this.stateOf('file.savePdf').enabled,
          click: onFocused(hooks.saveAsPdf),
        },
        { type: 'separator' },
        // Left out while a policy forces the connection.
        ...(hooks.switchMode ? [{ id: 'file.switchMode', label: text.menuSwitchMode, click: hooks.switchMode } as MenuItemConstructorOptions] : []),
        ...this.extras('file'),
        { type: 'separator' },
        { id: 'file.close', label: text.menuClose, accelerator: 'CmdOrCtrl+W', role: 'close' },
        ...(mac ? [] : [{ id: 'file.quit', label: text.menuQuit, role: 'quit', accelerator: 'Ctrl+Q' } as MenuItemConstructorOptions]),
      ],
    };

    const editMenu: MenuItemConstructorOptions = {
      id: 'edit',
      label: text.menuEdit,
      submenu: [
        { role: 'undo', label: text.menuUndo },
        { role: 'redo', label: text.menuRedo },
        { type: 'separator' },
        { role: 'cut', label: text.menuCut },
        { role: 'copy', label: text.menuCopy },
        { role: 'paste', label: text.menuPaste },
        ...(mac ? [{ role: 'pasteAndMatchStyle' } as MenuItemConstructorOptions] : []),
        { role: 'selectAll', label: text.menuSelectAll },
        { type: 'separator' },
        this.command('edit.search', text.menuSearch, this.pageKey('/')),
      ],
    };

    const viewMenu: MenuItemConstructorOptions = {
      id: 'view',
      label: text.menuView,
      submenu: [
        this.command('view.refresh', text.menuRefresh, { accelerator: 'F5' }),
        { type: 'separator' },
        {
          id: 'view.readingPane',
          label: text.menuReadingPane,
          submenu: [
            this.command('view.layout.split', text.menuPaneRight, { type: 'radio' }),
            this.command('view.layout.horizontal', text.menuPaneBelow, { type: 'radio' }),
            this.command('view.layout.focus', text.menuPaneOff, { type: 'radio' }),
          ],
        },
        { type: 'separator' },
        { id: 'view.zoomIn', label: text.menuZoomIn, accelerator: 'CmdOrCtrl+Plus', click: () => hooks.zoom(1) },
        // The = key without Shift. Hidden, as browsers do it, so only one shows.
        { id: 'view.zoomInAlt', label: text.menuZoomIn, accelerator: 'CmdOrCtrl+=', visible: false, acceleratorWorksWhenHidden: true, click: () => hooks.zoom(1) },
        { id: 'view.zoomOut', label: text.menuZoomOut, accelerator: 'CmdOrCtrl+-', click: () => hooks.zoom(-1) },
        { id: 'view.zoomReset', label: text.menuZoomReset, accelerator: 'CmdOrCtrl+0', click: () => hooks.zoom(0) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: text.menuFullScreen },
        ...this.extras('view'),
      ],
    };

    const messageMenu: MenuItemConstructorOptions = {
      id: 'message',
      label: text.menuMessage,
      submenu: [
        this.command('message.reply', text.menuReply, this.pageKey('R')),
        this.command('message.replyAll', text.menuReplyAll, this.pageKey('Shift+R')),
        this.command('message.forward', text.menuForward, this.pageKey('F')),
        { type: 'separator' },
        this.command('message.markRead', text.menuMarkRead, this.pageKey('Shift+I')),
        this.command('message.markUnread', text.menuMarkUnread, this.pageKey('U')),
        this.command('message.star', text.menuStar, this.pageKey('S')),
        { type: 'separator' },
        this.command('message.move', text.menuMove),
        this.command('message.archive', text.menuArchive, this.pageKey('E')),
        this.command('message.spam', text.menuSpam, this.pageKey('Shift+1')),
        this.command('message.delete', text.menuDelete, this.pageKey('Delete', false)),
        { type: 'separator' },
        this.command('message.openWindow', text.menuOpenInWindow),
      ],
    };

    const goMenu: MenuItemConstructorOptions = {
      id: 'go',
      label: text.menuGo,
      submenu: [
        this.command('go.inbox', text.menuGoInbox),
        this.command('go.sent', text.menuGoSent),
        this.command('go.drafts', text.menuGoDrafts),
        { type: 'separator' },
        this.command('go.nextMessage', text.menuGoNext, this.pageKey('J')),
        this.command('go.previousMessage', text.menuGoPrevious, this.pageKey('K')),
        this.command('go.nextUnread', text.menuGoNextUnread, this.pageKey('N')),
        { type: 'separator' },
        this.command('go.mail', text.menuGoMail),
        this.command('go.calendar', text.menuGoCalendar),
        this.command('go.contacts', text.menuGoContacts),
        this.command('go.files', text.menuGoFiles),
        { type: 'separator' },
        {
          id: 'go.back',
          label: text.menuGoBack,
          accelerator: mac ? 'Cmd+[' : 'Alt+Left',
          click: () => {
            const window = focused();
            if (window) hooks.back(window, -1);
          },
        },
        {
          id: 'go.forward',
          label: text.menuGoForward,
          accelerator: mac ? 'Cmd+]' : 'Alt+Right',
          click: () => {
            const window = focused();
            if (window) hooks.back(window, 1);
          },
        },
      ],
    };

    const windowMenu: MenuItemConstructorOptions = {
      id: 'window',
      label: text.menuWindow,
      submenu: [
        { role: 'minimize', label: text.menuMinimize },
        ...(mac ? [{ role: 'zoom' } as MenuItemConstructorOptions] : []),
        {
          id: 'window.cycle',
          label: text.menuCycle,
          // macOS has its own for this in the system; Ctrl+` is for the rest.
          accelerator: mac ? 'Cmd+`' : 'Ctrl+`',
          click: () => windows?.cycle(1),
        },
        ...(mac ? [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'front' } as MenuItemConstructorOptions] : []),
        ...this.windowEntries(),
      ],
    };

    const helpMenu: MenuItemConstructorOptions = {
      id: 'help',
      label: text.menuHelp,
      ...(mac ? { role: 'help' } : {}),
      submenu: [
        this.command('help.shortcuts', text.menuShortcuts, this.pageKey('Shift+/')),
        { id: 'help.docs', label: text.menuDocs, click: () => void shell.openExternal('https://bulwarkmail.org/docs').catch(() => {}) },
        ...this.extras('help'),
        ...(mac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { id: 'help.settings', label: text.menuSettings, accelerator: 'Ctrl+,', enabled: !!windows, click: hooks.openSettings }, { role: 'about', label: text.menuAbout } as MenuItemConstructorOptions]),
      ],
    };

    const appMenu: MenuItemConstructorOptions = {
      id: 'app',
      label: app.name,
      submenu: [
        { role: 'about', label: text.menuAbout },
        { type: 'separator' },
        { id: 'app.settings', label: text.menuSettings, accelerator: 'Cmd+,', enabled: !!windows, click: hooks.openSettings },
        ...this.extras('app'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    };

    const bar = [fileMenu, editMenu, viewMenu, messageMenu, goMenu, windowMenu, helpMenu];
    assignMnemonics(bar.map((item) => item.label as string)).forEach((label, index) => {
      bar[index].label = label;
    });
    return [
      ...(mac ? [appMenu] : []),
      ...bar,
      ...(hooks.devTools ? [{ label: 'Develop', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] } as MenuItemConstructorOptions] : []),
    ];
  }

  rebuild(): void {
    const template = this.buildTemplate();
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    this.refreshNames(template);
  }

  // ─── The state a page reports ───────────────────────────────

  setCommandState(window: BrowserWindow, state: MenuState): void {
    const keysBefore = this.singleKeysOff();
    this.stateByWindow.set(window, state);
    // Accelerators only change in a new menu.
    if (this.singleKeysOff() !== keysBefore) this.scheduleRebuild();
    else this.applyState();
  }

  /** A bare preview reports nothing, so what the organisation allows comes from the main window. */
  commandState(window: BrowserWindow): MenuState | undefined {
    return this.stateByWindow.get(window) ?? (this.windows?.managedFor(window) ? undefined : (() => {
      const main = this.windows?.mainWindow();
      return main ? this.stateByWindow.get(main) : undefined;
    })());
  }

  // ─── The strip for a window with no native bar ──────────────

  private barItems: { entry: MenuBarEntry; item: MenuItem }[] = [];

  private refreshNames(template: MenuItemConstructorOptions[]): void {
    const menu = Menu.getApplicationMenu();
    this.barItems = (menu?.items ?? []).flatMap((item, index) => {
      const source = template[index];
      const label = typeof source?.label === 'string' ? source.label : item.label;
      if (!item.submenu || !source?.id) return [];
      return [{ entry: { id: source.id, label: withoutMnemonic(label), mnemonic: mnemonicOf(label) }, item }];
    });
  }

  barEntries(): MenuBarEntry[] {
    return this.barItems.map(({ entry }) => entry);
  }

  popupBarMenu(window: BrowserWindow, id: string, x: number, y: number): void {
    const found = this.barItems.find(({ entry }) => entry.id === id);
    if (!found?.item.submenu) return;
    const scale = window.webContents.getZoomFactor();
    found.item.submenu.popup({
      window,
      x: Math.round(x * scale),
      y: Math.round(y * scale),
      // A bar that hides behind Alt goes when its menu does.
      callback: () => {
        if (!window.isDestroyed()) this.showBar(window, { visible: false });
      },
    });
  }

  private readonly barShown = new WeakSet<BrowserWindow>();

  isBarShown(window: BrowserWindow): boolean {
    return this.barShown.has(window);
  }

  showBar(window: BrowserWindow, event: MenuBarEvent): void {
    if (event.visible) this.barShown.add(window);
    else this.barShown.delete(window);
    window.webContents.send(CHANNEL.menuBarEvent, event);
  }
}
