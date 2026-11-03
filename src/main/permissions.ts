/**
 * Denies every permission except what the app uses, for its own origin's top
 * frame only. Mail frames are sandboxed and opaque, so they have no origin to
 * match. A plugin frame can be same-origin, and is turned away for being a frame.
 * A service worker has no frame and goes by its origin.
 */

import type { Session } from 'electron';

const GRANTED = new Set<string>(['notifications', 'persistent-storage', 'fileSystem', 'clipboard-sanitized-write']);

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function applyPermissionPolicy(session: Session, origin: string): void {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requesting = originOf(details.requestingUrl) ?? originOf(webContents.getURL());
    callback(details.isMainFrame !== false && requesting === origin && GRANTED.has(permission));
  });
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const requesting = originOf(requestingOrigin) ?? originOf(webContents?.getURL());
    const inFrame = !!webContents && details.isMainFrame === false;
    return !inFrame && requesting === origin && GRANTED.has(permission);
  });
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
}
