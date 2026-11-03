/**
 * The first-run page's only way out: it names a mode, main validates it.
 * Separate from the app's bridge, since this page isn't the webmail.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { CHANNEL } from '../shared/bridge';

function options(): { allowStandalone: boolean; instanceUrl: string | null; urlLocked: boolean; askTelemetry?: boolean; askCrashReports?: boolean } {
  const prefix = '--bulwark-welcome=';
  try {
    return JSON.parse(decodeURIComponent(process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? ''));
  } catch {
    return { allowStandalone: true, instanceUrl: null, urlLocked: false };
  }
}

contextBridge.exposeInMainWorld('bulwarkWelcome', {
  options: options(),
  choose: (choice: { mode: 'standalone' } | { mode: 'instance'; url: string }): Promise<{ ok: boolean; error?: string; next?: 'privacy' }> =>
    ipcRenderer.invoke(CHANNEL.welcomeChoose, choice),
  answerPrivacy: (answers: { telemetry: boolean; crashReports: boolean }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(CHANNEL.welcomePrivacy, answers),
});
