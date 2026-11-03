#!/usr/bin/env node
// Builds @vscode/policy-watcher for each architecture a release packs, since electron-
// builder's npmRebuild is off and node_modules holds one copy. before-pack.cjs puts the
// right one in place for each pack. Node-API, so no Electron headers are needed. A universal
// macOS build then has a different binary per side, and its merge makes one out of them.
//
//   node scripts/build-policy-watcher.mjs --arch x64,arm64
//
// .native-modules/<platform>-<arch>/vscode-policy-watcher.node

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODULE = path.join(ROOT, 'node_modules', '@vscode', 'policy-watcher');

function option(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

if (!existsSync(path.join(MODULE, 'package.json'))) {
  console.error('[build-policy-watcher] @vscode/policy-watcher is not installed.');
  process.exit(process.argv.includes('--optional') ? 0 : 1);
}

for (const arch of (option('arch') ?? process.arch).split(',')) {
  const result = spawnSync('npx', ['node-gyp', 'rebuild', `--arch=${arch}`], { cwd: MODULE, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const out = path.join(ROOT, '.native-modules', `${process.platform}-${arch}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const built = path.join(MODULE, 'build', 'Release');
  for (const file of readdirSync(built).filter((name) => name.endsWith('.node'))) {
    copyFileSync(path.join(built, file), path.join(out, file));
    console.log(`[build-policy-watcher] ${process.platform}-${arch}: ${file}`);
  }
}
