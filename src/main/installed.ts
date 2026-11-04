/**
 * Whether this is the real thing, in place of `app.isPackaged`. Electron decides that by
 * the exe's name, so a production build copied to `electron.exe` would count as a
 * development run. Only a test build, which is never shipped, can be one.
 */

import { app } from 'electron';

declare const __BULWARK_TEST_BUILD__: boolean;

export function isInstalledBuild(): boolean {
  return app.isPackaged || !__BULWARK_TEST_BUILD__;
}
