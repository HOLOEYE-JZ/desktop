/**
 * Native questions and files on the clipboard. Save, open and pick-a-folder need
 * nothing here: Chromium's own file pickers already are the OS's.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { app, clipboard, dialog, powerMonitor } from 'electron';
import { addWipeStep } from './local-wipe';
import { CHANNEL, type ConfirmOptions } from '../../shared/bridge';
import { safeFileName } from '../menu-text';
import { systemExe } from '../system-exe';
import type { Feature } from './index';

/** In Electron, but left out of its types as experimental. */
function writeClipboardBuffer(format: string, data: Buffer): void {
  (clipboard as unknown as { writeBuffer: (format: string, data: Buffer) => void }).writeBuffer(format, data);
}

const MAX_TEXT = 2000;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
/** Long enough to go and paste it. An attachment shouldn't sit around in the clear. */
const CLIPBOARD_FILE_MS = 10 * 60_000;

/** Files handed to the clipboard live here until the next start: a paste can come any time. */
function clipboardFolder(): string {
  return path.join(app.getPath('userData'), 'clipboard-files');
}

function emptyClipboardFolder(): void {
  try {
    for (const entry of readdirSync(clipboardFolder())) rmSync(path.join(clipboardFolder(), entry), { recursive: true, force: true });
  } catch {
    // Nothing there yet.
  }
}

/**
 * The OS's file clipboard. Electron has no call for it, and on Windows the format
 * Explorer pastes isn't one a buffer can be written to. PowerShell's Set-Clipboard
 * sets it, with the path in an environment variable so nothing gets quoted wrong.
 */
function putFileOnClipboard(file: string): Promise<boolean> {
  if (process.platform === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>${file.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string></array></plist>`;
    writeClipboardBuffer('NSFilenamesPboardType', Buffer.from(plist));
    return Promise.resolve(true);
  }
  if (process.platform === 'linux') {
    const uri = `file://${file.split('/').map(encodeURIComponent).join('/')}`;
    writeClipboardBuffer('text/uri-list', Buffer.from(`${uri}\r\n`));
    writeClipboardBuffer('x-special/gnome-copied-files', Buffer.from(`copy\n${uri}`));
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const child = spawn(systemExe('powershell.exe'), ['-NoProfile', '-NonInteractive', '-Sta', '-Command', 'Set-Clipboard -LiteralPath $env:BULWARK_CLIPBOARD_FILE'], {
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, BULWARK_CLIPBOARD_FILE: file },
    });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

export const dialogsFeature: Feature = {
  name: 'dialogs',
  modes: ['standalone', 'instance'],
  setup(ctx) {
    // A wipe of what's local covers the copies waiting to be pasted.
    addWipeStep(async () => emptyClipboardFolder());
    emptyClipboardFolder();
    app.on('will-quit', emptyClipboardFolder);
    powerMonitor.on('lock-screen', emptyClipboardFolder);
    ctx.on(CHANNEL.clipboardClearFiles, () => emptyClipboardFolder());

    ctx.handle(CHANNEL.dialogsConfirm, async (_event, window, options) => {
      const { message, detail, buttons, defaultId, type } = (options ?? {}) as Partial<ConfirmOptions>;
      if (typeof message !== 'string' || !Array.isArray(buttons)) throw new Error('Not a question');
      const labels = buttons.filter((b): b is string => typeof b === 'string').slice(0, 4).map((b) => b.slice(0, 80));
      if (labels.length === 0) throw new Error('Not a question');
      const settings: Electron.MessageBoxOptions = {
        type: type === 'info' || type === 'warning' || type === 'question' ? type : 'question',
        title: 'Bulwark',
        message: message.slice(0, MAX_TEXT),
        detail: typeof detail === 'string' ? detail.slice(0, MAX_TEXT) : undefined,
        buttons: labels,
        defaultId: typeof defaultId === 'number' && defaultId >= 0 && defaultId < labels.length ? defaultId : labels.length - 1,
        cancelId: labels.length - 1,
        noLink: true,
      };
      const answer = window ? await dialog.showMessageBox(window, settings) : await dialog.showMessageBox(settings);
      return answer.response;
    });

    ctx.handle(CHANNEL.clipboardCopyFile, async (_event, _window, name, data) => {
      if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return false;
      const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      if (bytes.byteLength > MAX_FILE_BYTES) return false;
      // Its own folder, so two attachments with the same name don't overwrite each other.
      const folder = path.join(clipboardFolder(), randomBytes(8).toString('hex'));
      mkdirSync(folder, { recursive: true });
      const file = path.join(folder, safeFileName(name));
      writeFileSync(file, bytes);
      setTimeout(() => rmSync(folder, { recursive: true, force: true }), CLIPBOARD_FILE_MS).unref?.();
      return putFileOnClipboard(file);
    });
  },
};
