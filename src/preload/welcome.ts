/**
 * The first-run page's only way out: it names a mode, main validates it.
 * Separate from the app's bridge, since this page isn't the webmail.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { CHANNEL } from '../shared/bridge';

contextBridge.exposeInMainWorld('bulwarkWelcome', {
  choose: (choice: { mode: 'standalone' } | { mode: 'instance'; url: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(CHANNEL.welcomeChoose, choice),
});
