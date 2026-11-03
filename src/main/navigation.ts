/**
 * Where a window may go.
 *
 * The app stays on its origin. Anything else opens in the system browser. The
 * exceptions are the ones the webmail depends on: about:blank and blob: pop-ups
 * for print and previews (print calls document.write on the pop-up), and in
 * instance mode the SSO redirect chain, which has to run in the window so the
 * instance's own cookies come back with it.
 */

import { screen, shell, type BrowserWindow, type BrowserWindowConstructorOptions, type WebContents, type WebPreferences } from 'electron';
import type { Mode } from '../shared/bridge';
import { FORCED_SSO_LIMIT_MS, SsoChain, isJmapProxyPath, isSsoStart, looksLikeProviderLogout, parse, sameOrigin } from './navigation-rules';
import { fitInto } from './window-placement';
import { windowTypeOf, type WindowManager } from './windows';

// What links in mail and contacts use. The OS has the handler, or nothing happens.
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:', 'xmpp:', 'webcal:']);

/** The schemes listed above, for an address the OS can open. Nothing else leaves the app. */
export function openExternally(url: string): boolean {
  const parsed = parse(url);
  if (!parsed || !EXTERNAL_PROTOCOLS.has(parsed.protocol)) return false;
  if (parsed.username || parsed.password) return false;
  void shell.openExternal(parsed.toString()).catch(() => {});
  return true;
}

export interface GuardOptions {
  mode: Mode;
  origin: string;
  windows: () => WindowManager;
  /** The server is forced: a sign-in chain gets a time limit. */
  forced?: () => boolean;
}

/** A pop-up without the bridge: print pages and blob previews. */
function bareWindowOptions(preferences: WebPreferences): BrowserWindowConstructorOptions {
  return {
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: preferences.devTools,
    },
  };
}

function handleWindowOpen(contents: WebContents, options: GuardOptions) {
  contents.setWindowOpenHandler(({ url, frameName }) => {
    const windows = options.windows();
    if (url === 'about:blank' || url === '') {
      return { action: 'allow', overrideBrowserWindowOptions: bareWindowOptions(windows.webPreferences()) };
    }
    const parsed = parse(url);
    if (!parsed) return { action: 'deny' };
    if (parsed.protocol === 'blob:') {
      // blob:https://app... carries the origin in its URL, and URL.origin knows.
      if (parsed.origin !== options.origin) return { action: 'deny' };
      return { action: 'allow', overrideBrowserWindowOptions: bareWindowOptions(windows.webPreferences()) };
    }
    if (sameOrigin(parsed, options.origin)) {
      if (parsed.pathname.startsWith('/api/') || isJmapProxyPath(parsed.pathname)) return { action: 'deny' };
      const type = windowTypeOf(parsed.pathname);
      const key = frameName && frameName !== '_blank' ? frameName : url;
      if (windows.findByKey(key)) {
        windows.open({ type, key, url });
        return { action: 'deny' };
      }
      if (type === 'message' || type === 'composer') {
        // Keeps window.opener and the handle for a page without the bridge. did-create-window
        // below registers it with the manager.
        // Its place comes from us: a page's features string can ask for any size or spot.
        return { action: 'allow', overrideBrowserWindowOptions: { ...windows.windowOptions(type), ...windows.placeFor(type) } };
      }
      windows.open({ type, key, url });
      return { action: 'deny' };
    }
    openExternally(url);
    return { action: 'deny' };
  });

  contents.on('did-create-window', (child, details) => {
    const parsed = parse(details.url);
    const windows = options.windows();
    // A blob's URL.origin is the app's too, but it's no window of the app's: it has none of its styles,
    // so the frame check would take it for an older instance's page and rebuild it.
    if (parsed?.protocol !== 'blob:' && sameOrigin(parsed, options.origin)) {
      const key = details.frameName && details.frameName !== '_blank' ? details.frameName : details.url;
      windows.adopt(child, windowTypeOf(parsed!.pathname), key, details.url);
      return;
    }
    // about:blank and blob: stay outside the manager, under the same guards, and on a screen.
    child.setBounds(fitInto(child.getBounds(), screen.getDisplayMatching(child.getBounds()).workArea));
    guardContents(child.webContents, options);
  });
}

/** Instance mode: inside the redirect chain any https page may show. */
function guardNavigation(contents: WebContents, options: GuardOptions): void {
  const { origin, mode } = options;
  const chain = new SsoChain(() => (options.forced?.() ? FORCED_SSO_LIMIT_MS : null));

  const allowed = (target: URL): boolean => {
    if (target.protocol === 'about:' && target.href === 'about:blank') return true;
    if (sameOrigin(target, origin)) return !isJmapProxyPath(target.pathname);
    if (mode !== 'instance' || target.protocol !== 'https:') return false;
    if (chain.active()) return true;
    if (isSsoStart(target, origin)) {
      chain.start();
      return true;
    }
    return false;
  };

  const guard = (event: Electron.Event, url: string, isMainFrame: boolean) => {
    if (!isMainFrame) return;
    const target = parse(url);
    if (target && allowed(target)) return;
    event.preventDefault();
    if (!target || (sameOrigin(target, origin) && isJmapProxyPath(target.pathname))) return;
    openExternally(url);
    // The webmail set a flag before leaving for the provider's logout page, so
    // its own login redirect would do nothing and the window would stay stuck.
    if (looksLikeProviderLogout(target)) void contents.loadURL(`${origin}/`).catch(() => {});
  };

  contents.on('will-navigate', (event) => guard(event, event.url, event.isMainFrame));
  contents.on('will-redirect', (event) => guard(event, event.url, event.isMainFrame));
  contents.on('did-navigate', (_event, url) => {
    if (sameOrigin(parse(url), origin)) chain.end();
  });
  contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    // -3 is a load we replaced ourselves, which isn't the chain failing.
    if (isMainFrame && code !== -3) chain.end();
  });
}

function guardContents(contents: WebContents, options: GuardOptions): void {
  handleWindowOpen(contents, options);
  guardNavigation(contents, options);
}

export function attachWindowGuards(window: BrowserWindow, options: GuardOptions): void {
  guardContents(window.webContents, options);
}
