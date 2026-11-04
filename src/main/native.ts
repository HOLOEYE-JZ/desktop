/**
 * The one copy of the native helper, for the main process. `native()` never throws:
 * see native-loader.ts for what absent means. Loaded on first use, so an app that
 * never asks doesn't pay for it.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInstalledBuild } from './installed';
import { helperFile, loadHelperModule, wrapHelper, type NativeHelper } from './native-loader';

const HERE = path.dirname(fileURLToPath(import.meta.url));

declare const __BULWARK_TEST_BUILD__: boolean;

let helper: NativeHelper | null = null;

export function native(): NativeHelper {
  if (helper) return helper;
  // The helper vouches for what a macOS profile forces, so a rename mustn't lose it.
  const disabled = __BULWARK_TEST_BUILD__ && process.argv.includes('--bulwark-test-no-native');
  const file = helperFile({ packaged: isInstalledBuild(), mainDir: HERE, platform: process.platform, arch: process.arch });
  helper = wrapHelper(disabled ? null : loadHelperModule(file));
  return helper;
}
