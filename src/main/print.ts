/**
 * Print and Save as PDF from the File menu. Both print what the page's print CSS
 * makes of it (app/print.css: the open message, event or contact, without the app
 * around it). The device policy is applied by the page itself: under "No printing"
 * it reports `file.print: false` here, and its CSS prints only a note if anything
 * gets through.
 */

import { writeFile } from 'node:fs/promises';
import { dialog, type BrowserWindow } from 'electron';
import type { MenuState } from '../shared/bridge';
import { pdfFileName } from './menu-text';

function allowed(state: MenuState | undefined, id: 'file.print' | 'file.savePdf'): boolean {
  const entry = state?.[id];
  return (typeof entry === 'boolean' ? entry : entry?.enabled) !== false;
}

export function printWindow(window: BrowserWindow, state: MenuState | undefined): void {
  if (!allowed(state, 'file.print')) return;
  window.webContents.print({ printBackground: true }, () => {
    // Cancelled or failed: the OS's dialog has said so.
  });
}

export async function saveWindowAsPdf(window: BrowserWindow, state: MenuState | undefined): Promise<string | null> {
  if (!allowed(state, 'file.savePdf')) return null;
  const answer = await dialog.showSaveDialog(window, {
    defaultPath: pdfFileName(window.getTitle()),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (answer.canceled || !answer.filePath || window.isDestroyed()) return null;
  const data = await window.webContents.printToPDF({ printBackground: true });
  await writeFile(answer.filePath, data);
  return answer.filePath;
}
