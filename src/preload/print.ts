/**
 * The print preview's page (src/pages/print.html) and nothing else: what to draw, the
 * choices a destination starts with, a render of the pages, and the button pressed. Main
 * checks each against the window it opened (src/main/print-preview.ts).
 */

import { contextBridge, ipcRenderer } from 'electron';
import { CHANNEL } from '../shared/bridge';

contextBridge.exposeInMainWorld('bulwarkPrint', {
  spec: (): Promise<unknown> => ipcRenderer.invoke(CHANNEL.printWindowSpec),
  choicesFor: (destination: unknown, current: unknown): Promise<unknown> => ipcRenderer.invoke(CHANNEL.printWindowChoices, destination, current),
  render: (choices: unknown): Promise<unknown> => ipcRenderer.invoke(CHANNEL.printWindowRender, choices),
  ready: () => ipcRenderer.send(CHANNEL.printWindowReady),
  run: (action: 'print' | 'save' | 'system' | 'cancel', choices?: unknown): Promise<boolean> => ipcRenderer.invoke(CHANNEL.printWindowRun, action, choices),
});
