#!/usr/bin/env node
// Packaged test builds for test/updater.spec.ts: real NSIS installers, one per version,
// in release-test/<version>/. They differ from a release in three ways, all here:
//
// - the updater's test switches are compiled in (BULWARK_UPDATER_TEST_BUILD, build.mjs),
//   which is the only way a feed other than GitHub can be set;
// - the node-inspector fuse is on, which Playwright's _electron needs;
// - no compression, for speed.
//
//   node scripts/build-update-fixtures.mjs [version ...]
//
// Leaves dist/ as a normal build afterwards.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const VERSIONS = ['0.9.0', '0.9.1', '1.0.0-beta.1'];

function run(command, args, env = {}) {
  // BULWARK_TEST_PACK: after-pack.cjs refuses a build with test switches without it.
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, BULWARK_TEST_PACK: '1', ...env }, shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

const versions = process.argv.slice(2);
run('node', ['build.mjs'], { BULWARK_UPDATER_TEST_BUILD: '1' });
if (!readFileSync(path.join(ROOT, 'dist', 'main.mjs'), 'utf8').includes('bulwark-test-update-feed')) throw new Error('not a test build');
try {
  for (const version of versions.length ? versions : VERSIONS) {
    run('npx', [
      'electron-builder',
      '--win',
      'nsis',
      '--x64',
      '--publish',
      'never',
      `-c.extraMetadata.version=${version}`,
      `-c.directories.output=release-test/${version}`,
      '-c.electronFuses.enableNodeCliInspectArguments=true',
      '-c.compression=store',
      // The Electron already installed. No download, so no flaky network in the way.
      `-c.electronDist=${path.join(ROOT, 'node_modules', 'electron', 'dist')}`,
    ]);
    if (!existsSync(path.join(ROOT, 'release-test', version, `Bulwark-Setup-${version}-x64.exe`))) throw new Error(`no installer for ${version}`);
  }
} finally {
  run('node', ['build.mjs']);
}
