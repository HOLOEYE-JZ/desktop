/**
 * Whether this is the real thing, in place of `app.isPackaged`. Electron decides that by
 * the exe's name, so a production build copied to `electron.exe` would count as a
 * development run. Only a test build, which is never shipped, can be one.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { registersWithOs, windowsInstallerOf } from './features/os-rules';

declare const __BULWARK_TEST_BUILD__: boolean;
declare const __BULWARK_TEST_PROFILE__: string;

export function isInstalledBuild(): boolean {
  return app.isPackaged || !__BULWARK_TEST_BUILD__;
}

let registers: boolean | undefined;

/**
 * Whether this copy may put itself into the OS: see registersWithOs. A test pack is packaged, so
 * isInstalledBuild() is true for it, and that alone once let one register itself in the user's HKCU.
 */
export function osRegistrationAllowed(): boolean {
  registers ??= registersWithOs({
    platform: process.platform,
    testBuild: __BULWARK_TEST_BUILD__,
    bakedProfile: Boolean(__BULWARK_TEST_PROFILE__),
    installer: process.platform === 'win32' ? windowsInstallerOf((name) => existsSync(path.join(path.dirname(process.execPath), name)), path.parse(process.execPath).name) : 'none',
  });
  return registers;
}
