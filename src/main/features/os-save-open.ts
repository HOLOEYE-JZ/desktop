/**
 * File > Open… and Save as…, as Thunderbird has them.
 *
 * Open… is the OS's open dialog for .eml, .ics and .vcf, and the files picked go the way a
 * file opened with the app from Explorer goes (os-launch.ts): the page opens a message in a
 * window of its own, an event or a contact where they belong.
 *
 * Save as… is the page's: it knows which messages are on screen and fetches them. It asks
 * here first (`begin`), so the dialog shows at once, on the click: the OS's Save dialog for
 * one message, a folder for several. Then the bytes come one file at a time (`write`). A
 * file in a picked folder never overwrites one that's there: it gets a number. Both dialogs
 * start where the last one ended. Each file is marked as coming from outside, as a
 * download is.
 *
 * The rules a page can't get round: a click or a menu pick of main's own just before, the
 * organisation's "no exporting mail" (the page reports it, as "no downloads" for the context menu's Save image),
 * and the app lock.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app, dialog, type BrowserWindow, type WebContents } from 'electron';
import { CHANNEL, type SaveAsBegin, type SaveAsResult } from '../../shared/bridge';
import { appLockGate } from '../app-lock-gate';
import {
  cleanSaveRequest,
  MAX_SAVE_FILE_BYTES,
  numberedName,
  OPEN_EXTENSIONS,
  rememberedFolder,
  SAVE_SESSION_MS,
  withMessageExtension,
} from '../save-open-rules';
import { strings } from '../strings';
import { takeUserGesture, watchUserGestures } from '../user-gesture';
import type { LaunchHandle } from './os-launch';
import type { OsHub } from './os-hub';
import { writeMarkedFile } from './os-files';

interface SaveSession {
  contents: WebContents;
  names: string[];
  /** One message: the path the user chose. Several: the folder. */
  file?: string;
  folder?: string;
  done: Set<number>;
  saved: number;
  failed: number;
  timer: NodeJS.Timeout;
}

/** Writes into the folder under the first free name. Never over a file that's there. */
async function writeNumbered(folder: string, name: string, data: Uint8Array): Promise<void> {
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    try {
      await writeMarkedFile(path.join(folder, numberedName(name, attempt)), data, { exclusive: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('No free name');
}

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

export interface SaveOpenHandle {
  open: (window: BrowserWindow) => Promise<void>;
}

export function setupSaveOpen(hub: OsHub, launch: LaunchHandle): SaveOpenHandle {
  const { ctx } = hub;
  const sessions = new Map<string, SaveSession>();
  app.on('web-contents-created', (_event, contents) => watchUserGestures(contents));
  ctx.windows.on('created', ({ window }) => watchUserGestures(window.webContents));

  const defaultFolder = () => {
    try {
      return app.getPath('documents');
    } catch {
      return app.getPath('home');
    }
  };

  const remember = (key: 'saveAsFolder' | 'openFolder', folder: string) => {
    if (ctx.state.data[key] === folder) return;
    ctx.state.data[key] = folder;
    ctx.state.touch();
  };

  const finish = (id: string): SaveAsResult => {
    const session = sessions.get(id);
    if (!session) return { saved: 0, failed: 0 };
    clearTimeout(session.timer);
    sessions.delete(id);
    return { saved: session.saved, failed: session.failed + session.names.length - session.done.size };
  };

  const open = async (window: BrowserWindow) => {
    if (appLockGate.locked || window.isDestroyed()) return;
    const text = strings();
    const answer = await dialog.showOpenDialog(window, {
      defaultPath: rememberedFolder(ctx.state.data.openFolder) ?? defaultFolder(),
      filters: [{ name: text.menuOpenFilter, extensions: [...OPEN_EXTENSIONS] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (answer.canceled || answer.filePaths.length === 0) return;
    remember('openFolder', path.dirname(answer.filePaths[0]));
    launch.openFiles(answer.filePaths);
  };
  ctx.menu.allowOpening((window) => void open(window));

  ctx.handle(CHANNEL.saveAsBegin, async (event, window, raw, clicked): Promise<SaveAsBegin> => {
    const request = cleanSaveRequest(raw);
    if (!request || !window) return { refused: 'invalid' };
    // Spent either way: one click, one dialog.
    const gesture = takeUserGesture(event.sender);
    if (appLockGate.locked) return { refused: 'locked' };
    // The page's word for "no exporting mail" on any signed-in account. A page from before it says nothing.
    if (ctx.menu.commandState(window)?.['policy.export'] === false) return { refused: 'policy' };
    if (!gesture || clicked !== true) return { refused: 'gesture' };
    const text = strings();
    const start = rememberedFolder(ctx.state.data.saveAsFolder) ?? defaultFolder();
    let file: string | undefined;
    let folder: string | undefined;
    if (request.names.length === 1) {
      const answer = await dialog.showSaveDialog(window, {
        defaultPath: path.join(start, request.names[0]),
        filters: [{ name: text.menuSaveAsFilter, extensions: ['eml'] }],
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      });
      if (answer.canceled || !answer.filePath) return { cancelled: true };
      file = withMessageExtension(answer.filePath);
      remember('saveAsFolder', path.dirname(file));
    } else {
      const answer = await dialog.showOpenDialog(window, {
        title: text.menuSaveAsFolderTitle,
        buttonLabel: text.menuSaveAsFolderButton,
        defaultPath: start,
        properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
      });
      if (answer.canceled || !answer.filePaths[0]) return { cancelled: true };
      folder = answer.filePaths[0];
      remember('saveAsFolder', folder);
    }
    const id = randomUUID();
    const timer = setTimeout(() => finish(id), SAVE_SESSION_MS);
    timer.unref?.();
    sessions.set(id, { contents: event.sender, names: request.names, file, folder, done: new Set(), saved: 0, failed: 0, timer });
    return { id };
  });

  ctx.handle(CHANNEL.saveAsWrite, async (event, _window, id, index, data): Promise<boolean> => {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    // Only the page that asked, each file once.
    if (!session || session.contents !== event.sender || typeof index !== 'number' || !Number.isInteger(index)) return false;
    if (index < 0 || index >= session.names.length || session.done.has(index)) return false;
    session.done.add(index);
    const bytes = bytesOf(data);
    if (!bytes || bytes.byteLength > MAX_SAVE_FILE_BYTES || appLockGate.locked) {
      session.failed += 1;
      return false;
    }
    try {
      // The user chose this name in the dialog, and said yes to replacing what was there.
      if (session.file) await writeMarkedFile(session.file, bytes);
      else await writeNumbered(session.folder!, session.names[index], bytes);
      session.saved += 1;
      return true;
    } catch (error) {
      console.warn('A message could not be saved:', (error as NodeJS.ErrnoException).code ?? 'error');
      session.failed += 1;
      return false;
    }
  });

  ctx.handle(CHANNEL.saveAsEnd, (event, _window, id): SaveAsResult => {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session || session.contents !== event.sender) return { saved: 0, failed: 0 };
    return finish(id as string);
  });

  return { open };
}
