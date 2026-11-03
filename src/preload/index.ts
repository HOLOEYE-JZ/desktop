/**
 * The bridge the webmail sees as window.bulwarkDesktop.
 *
 * Runs in a sandboxed renderer, so only electron's contextBridge and ipcRenderer
 * are here. It exposes nothing unless the page is on the one origin this window
 * was opened for. An external page, about:blank, a blob: preview or a frame gets
 * no bridge. Main checks the sender's origin again on every call, so this check
 * is a courtesy, not the lock.
 *
 * New features add a member here and a handler in src/main/features/.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  BRIDGE_VERSION,
  CHANNEL,
  PRELOAD_ARG,
  type MenuState,
  type SessionUrls,
  type SystemTheme,
  type ThemeColours,
  type WindowInfo,
} from '../shared/bridge';
import { DEFAULT_POLICY_SNAPSHOT, type PolicySnapshot } from '../shared/policy-schema';

function argument(prefix: string): string | null {
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const allowedOrigin = argument(PRELOAD_ARG.allowedOrigin);
const mode = argument(PRELOAD_ARG.mode);

// Plain http only when the allowed origin is: an instance a policy allows that way.
if (allowedOrigin && /^https?:$/.test(window.location.protocol) && window.location.origin === allowedOrigin) {
  const platform = process.platform as 'win32' | 'darwin' | 'linux';
  const flushHandlers = new Set<() => Promise<unknown>>();
  ipcRenderer.on(CHANNEL.lifecycleFlush, (_event, id: number) => {
    void Promise.allSettled([...flushHandlers].map((handler) => handler())).then(() => ipcRenderer.send(CHANNEL.lifecycleFlushed, id));
  });
  let policySnapshot: PolicySnapshot = (ipcRenderer.sendSync(CHANNEL.policyGet) as PolicySnapshot | null) ?? DEFAULT_POLICY_SNAPSHOT;
  ipcRenderer.on(CHANNEL.policyChanged, (_event, snapshot: PolicySnapshot) => {
    policySnapshot = snapshot;
  });
  const wipeHandlers = new Set<(nonce: string) => Promise<unknown>>();
  ipcRenderer.on(CHANNEL.policyWipeRequest, (_event, nonce: string) => {
    void Promise.allSettled([...wipeHandlers].map((handler) => handler(nonce))).then((results) => {
      ipcRenderer.send(CHANNEL.policyWipeDone, nonce, wipeHandlers.size > 0 && results.every((result) => result.status === 'fulfilled'));
    });
  });
  const common = {
    version: BRIDGE_VERSION,
    platform,
    mode,
    windows: {
      open: (url: string, options: { name: string; width: number; height: number }) =>
        ipcRenderer.send(CHANNEL.windowsOpen, url, options),
      openMessage: (target: { url: string; emailId: string }) => ipcRenderer.send(CHANNEL.windowsOpenMessage, target),
      openComposer: (target: { url: string; name?: string }) => ipcRenderer.send(CHANNEL.windowsOpenComposer, target),
      focus: (id?: number) => ipcRenderer.send(CHANNEL.windowsFocus, id),
      list: (): Promise<WindowInfo[]> => ipcRenderer.invoke(CHANNEL.windowsList),
      onChanged: (listener: (windows: WindowInfo[]) => void) => subscribe(CHANNEL.windowsChanged, listener),
    },
    theme: {
      set: (theme: ThemeColours) => ipcRenderer.send(CHANNEL.themeSet, theme),
      onSystemChange: (listener: (system: SystemTheme) => void) => subscribe(CHANNEL.themeSystem, listener),
    },
    menu: {
      setState: (state: MenuState) => ipcRenderer.send(CHANNEL.menuSetState, state),
    },
    shell: {
      openExternal: (url: string) => ipcRenderer.send(CHANNEL.shellOpenExternal, url),
    },
    policy: {
      get: () => policySnapshot,
      onChange: (listener: (snapshot: PolicySnapshot) => void) => subscribe(CHANNEL.policyChanged, listener),
      onWipeOfflineData: (handler: (nonce: string) => Promise<unknown>) => {
        wipeHandlers.add(handler);
        if (wipeHandlers.size === 1) ipcRenderer.send(CHANNEL.policyWipeListen);
        return () => {
          wipeHandlers.delete(handler);
        };
      },
    },
    lifecycle: {
      /**
       * Before a window closes or the app quits, main asks the page to save what it
       * has and waits a few seconds. A window with no handler closes at once.
       */
      onFlushRequest: (handler: () => Promise<unknown>) => {
        flushHandlers.add(handler);
        ipcRenderer.send(CHANNEL.lifecycleRegister, flushHandlers.size > 0);
        return () => {
          flushHandlers.delete(handler);
          ipcRenderer.send(CHANNEL.lifecycleRegister, flushHandlers.size > 0);
        };
      },
    },
  };

  const standalone = mode === 'standalone'
    ? {
        servers: {
          prepare: (serverUrl: string) => ipcRenderer.invoke(CHANNEL.serversPrepare, serverUrl),
          noteSession: (serverUrl: string, urls: SessionUrls) => ipcRenderer.send(CHANNEL.serversNoteSession, serverUrl, urls),
          forget: (serverUrl: string, reason: 'failed' | 'signed-out') => ipcRenderer.send(CHANNEL.serversForget, serverUrl, reason),
        },
        auth: {
          beginBrowserSignIn: () => ipcRenderer.invoke(CHANNEL.authBegin),
          completeBrowserSignIn: (flowId: string, authorizeUrl: string) =>
            ipcRenderer.invoke(CHANNEL.authComplete, flowId, authorizeUrl),
          cancelBrowserSignIn: (flowId: string) => ipcRenderer.send(CHANNEL.authCancel, flowId),
        },
        plugins: {
          install: (slug: string, version?: string) => ipcRenderer.invoke(CHANNEL.pluginsInstall, slug, version),
        },
      }
    : {};

  contextBridge.exposeInMainWorld('bulwarkDesktop', { ...common, ...standalone });
}
