/**
 * Short questions in a window of their own: a frameless, transparent child of the page's
 * window, modal to it, holding a card drawn like the app's in-page dialog. It feels like
 * an app window rather than a box inside the page, and still looks like Bulwark.
 *
 * The window loads only the shell's own data: page (src/pages/dialog.html), with no node,
 * isolated and sandboxed, on a session of its own. It gets its text through
 * src/preload/dialog.ts and draws it with textContent. Its answer goes to the call that
 * asked and nowhere else. One dialog per window at a time; the next waits. A page that
 * navigates away, or a window that closes, cancels its dialogs.
 *
 * macOS: `modal` would make it a sheet sliding out of the title bar, so there the parent
 * is disabled by hand instead.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, ipcMain, screen, session as electronSession, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { CHANNEL, type DialogWindowAnswer } from '../shared/bridge';
import { DIALOG_CARD_WIDTH, DIALOG_SHADOW_MARGIN, dialogBounds, readDialogAnswer, readDialogRequest, type DialogSpec } from './dialog-window-rules';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_PRELOAD = path.join(HERE, 'dialog-preload.cjs');
const DIALOG_PAGE = path.join(HERE, 'pages', 'dialog.html');
const PARTITION = 'bulwark-dialog';
/** Waiting and showing, per page. Past this a loop of questions gets "closed" and no window. */
export const MAX_DIALOGS_PER_PAGE = 3;

interface Entry {
  id: string;
  spec: DialogSpec;
  sender: WebContents;
  parent: BrowserWindow;
  resolve: (answer: DialogWindowAnswer) => void;
  window?: BrowserWindow;
  settled: boolean;
}

let pageUrl: string | null = null;
function dialogPageUrl(): string {
  // A data: page: with the grantFileProtocolExtraPrivileges fuse off, a file: one doesn't run.
  pageUrl ??= `data:text/html;charset=utf-8;base64,${readFileSync(DIALOG_PAGE).toString('base64')}`;
  return pageUrl;
}

function dialogSession(): Electron.Session {
  const session = electronSession.fromPartition(PARTITION);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  // Nothing in the page asks for anything over the network; this makes sure.
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }));
  return session;
}

export class DialogWindows {
  /** By the asking page's webContents id: the showing dialog first, then those waiting. */
  private queues = new Map<number, Entry[]>();
  /** By the dialog window's webContents id. */
  private shown = new Map<number, Entry>();
  private watched = new WeakSet<WebContents>();
  private session: Electron.Session | null = null;

  constructor() {
    ipcMain.handle(CHANNEL.dialogWindowSpec, (event) => this.fromDialog(event)?.spec ?? null);
    ipcMain.on(CHANNEL.dialogWindowReady, (event, size) => this.ready(event, size));
    ipcMain.on(CHANNEL.dialogWindowAnswer, (event, answer) => {
      const entry = this.fromDialog(event);
      if (!entry) return;
      const checked = readDialogAnswer(answer, entry.spec);
      if (checked !== undefined) this.settle(entry, checked);
    });
  }

  /** Only the dialog's own page, its main frame, on the data: page it was given. */
  private fromDialog(event: IpcMainEvent | IpcMainInvokeEvent): Entry | undefined {
    const entry = this.shown.get(event.sender.id);
    const frame = event.senderFrame;
    if (!entry || !frame || frame.parent || !frame.url.startsWith('data:')) return undefined;
    return entry.window?.webContents === event.sender ? entry : undefined;
  }

  /** Asks in a window over `parent`. Resolves with the answer, or null when it went unanswered. */
  ask(sender: WebContents, parent: BrowserWindow | null, request: unknown): Promise<DialogWindowAnswer> {
    const spec = readDialogRequest(request);
    if (!spec) return Promise.reject(new Error('Not a question'));
    if (!parent || parent.isDestroyed() || sender.isDestroyed()) return Promise.resolve(null);
    const queue = this.queues.get(sender.id) ?? [];
    if (queue.length >= MAX_DIALOGS_PER_PAGE) return Promise.resolve(null);
    // A second dialog with the same name would make cancel() ambiguous.
    if (queue.some((entry) => entry.id === spec.id)) return Promise.reject(new Error('Already asking'));
    this.watch(sender, parent);
    return new Promise((resolve) => {
      const { id, ...rest } = spec;
      queue.push({ id, spec: rest, sender, parent, resolve, settled: false });
      this.queues.set(sender.id, queue);
      if (queue.length === 1) this.show(queue[0]);
    });
  }

  /** The page took its question back (the in-page state it belonged to went). */
  cancel(sender: WebContents, id: unknown): void {
    const entry = this.queues.get(sender.id)?.find((candidate) => candidate.id === id);
    if (entry) this.settle(entry, null);
  }

  private cancelAll(senderId: number): void {
    for (const entry of [...(this.queues.get(senderId) ?? [])]) this.settle(entry, null);
  }

  private watch(sender: WebContents, parent: BrowserWindow): void {
    if (this.watched.has(sender)) return;
    this.watched.add(sender);
    const id = sender.id;
    // A new document: whatever asked is gone. A route change inside the app isn't one.
    sender.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.cancelAll(id);
    });
    sender.on('render-process-gone', () => this.cancelAll(id));
    sender.once('destroyed', () => this.cancelAll(id));
    parent.once('closed', () => this.cancelAll(id));
  }

  private show(entry: Entry): void {
    const { parent } = entry;
    if (entry.settled) return;
    if (parent.isDestroyed()) {
      this.settle(entry, null);
      return;
    }
    // A window still on its way up: the question comes with it, not on its own before it.
    if (!parent.isVisible()) {
      parent.once('show', () => this.show(entry));
      return;
    }
    this.session ??= dialogSession();
    const zoom = entry.sender.getZoomFactor();
    const workArea = screen.getDisplayMatching(parent.getBounds()).workArea;
    const mac = process.platform === 'darwin';
    const window = new BrowserWindow({
      parent,
      modal: !mac,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      title: entry.spec.title,
      width: Math.ceil((DIALOG_CARD_WIDTH + 2 * DIALOG_SHADOW_MARGIN) * zoom),
      height: Math.min(workArea.height, 900),
      webPreferences: {
        preload: DIALOG_PRELOAD,
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: false,
        zoomFactor: zoom,
      },
    });
    window.setMenu(null);
    entry.window = window;
    const contentsId = window.webContents.id;
    this.shown.set(contentsId, entry);
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-redirect', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Alt+F4, Cmd+W, the OS closing it: no answer.
    window.on('closed', () => {
      this.shown.delete(contentsId);
      this.settle(entry, null);
    });
    if (mac) parent.setEnabled(false);
    void window.loadURL(dialogPageUrl());
  }

  /** The page measured its card: size the window to it, centre it on the parent, show it. */
  private ready(event: IpcMainEvent, size: unknown): void {
    const entry = this.fromDialog(event);
    const window = entry?.window;
    if (!entry || !window || window.isDestroyed() || window.isVisible()) return;
    const card = (size && typeof size === 'object' ? size : {}) as { width?: unknown; height?: unknown };
    const width = typeof card.width === 'number' && card.width > 0 ? Math.min(card.width, 1200) : DIALOG_CARD_WIDTH;
    const height = typeof card.height === 'number' && card.height > 0 ? Math.min(card.height, 2000) : 200;
    const parentBounds = entry.parent.getBounds();
    const workArea = screen.getDisplayMatching(parentBounds).workArea;
    window.setBounds(dialogBounds({ width, height }, parentBounds, workArea, entry.sender.getZoomFactor()));
    window.show();
    window.focus();
  }

  private settle(entry: Entry, answer: DialogWindowAnswer): void {
    if (entry.settled) return;
    entry.settled = true;
    const queue = this.queues.get(entry.sender.id) ?? [];
    const index = queue.indexOf(entry);
    const wasShowing = index === 0;
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(entry.sender.id);
    const { window, parent } = entry;
    if (window) {
      for (const [id, shown] of this.shown) if (shown === entry) this.shown.delete(id);
      if (process.platform === 'darwin' && !parent.isDestroyed()) parent.setEnabled(true);
      if (!window.isDestroyed()) window.destroy();
      // The focus goes back to the page, where it was before.
      if (!parent.isDestroyed() && !entry.sender.isDestroyed()) {
        parent.focus();
        entry.sender.focus();
      }
    }
    entry.resolve(answer);
    if (wasShowing && queue.length > 0) this.show(queue[0]);
  }
}
