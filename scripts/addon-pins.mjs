// The SHA-256 of each native addon, per target, for build.mjs to compile into main.mjs. ASAR
// integrity covers main.mjs and doesn't cover app.asar.unpacked, where a .node has to live.
//
// Not macOS: the universal merge and codesign both rewrite the binary after this runs, so a pin
// taken here could never match. There, the code signature covers them in a signed build.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const WATCHER = 'vscode-policy-watcher.node';

function hashOf(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** `{ 'win32-x64': { native: <hex>, watcher: <hex> } }`, for whatever has been built. */
export function addonPins(root, { platform = process.platform, arch = process.arch } = {}) {
  const pins = {};
  const add = (key, name, file) => {
    if (key.startsWith('darwin-') || !existsSync(file)) return;
    pins[key] = { ...pins[key], [name]: hashOf(file) };
  };
  const targets = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
  for (const key of targets(path.join(root, 'native', 'dist'))) add(key, 'native', path.join(root, 'native', 'dist', key, 'bulwark-native.node'));
  // A release builds one per architecture, and before-pack.cjs puts the right one in place.
  // Without those, this machine's `npm ci` built the one that ships.
  add(`${platform}-${arch}`, 'watcher', path.join(root, 'node_modules', '@vscode', 'policy-watcher', 'build', 'Release', WATCHER));
  for (const key of targets(path.join(root, '.native-modules'))) add(key, 'watcher', path.join(root, '.native-modules', key, WATCHER));
  return pins;
}
