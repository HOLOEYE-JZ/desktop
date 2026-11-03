/**
 * Denies every permission except what the app uses, for its own origin only.
 * Mail frames and plugin frames ask from other origins or from none, so they get
 * nothing, and an external page in a stray window gets nothing.
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
    callback(requesting === origin && GRANTED.has(permission));
  });
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const requesting = originOf(requestingOrigin) ?? originOf(webContents?.getURL());
    return requesting === origin && GRANTED.has(permission);
  });
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
}
