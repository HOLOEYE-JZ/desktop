/**
 * The dialog window's page (src/pages/dialog.html) and nothing else: what to draw, the
 * card's size once drawn, the answer. Main checks each against the window it opened.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { CHANNEL, type DialogWindowAnswer } from '../shared/bridge';

contextBridge.exposeInMainWorld('bulwarkDialog', {
  spec: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.dialogWindowSpec),
  ready: (size: { width: number; height: number }) => ipcRenderer.send(CHANNEL.dialogWindowReady, size),
  answer: (answer: DialogWindowAnswer) => ipcRenderer.send(CHANNEL.dialogWindowAnswer, answer),
});
