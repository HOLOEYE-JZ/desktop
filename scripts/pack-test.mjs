#!/usr/bin/env node
// Packages a build for tests. scripts/after-pack.cjs refuses these without this script.
//
//   node scripts/pack-test.mjs             release/win-unpacked etc.: test hooks on, so the
//                                          package takes --user-data-dir and Playwright.
//   node scripts/pack-test.mjs --strict    release-strict/: behaves as production, command
//                                          line refused, except that its profile is compiled
//                                          in, so a run doesn't touch the real one.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const strict = process.argv.includes('--strict');
const shell = process.platform === 'win32';
const env = { ...process.env, BULWARK_TEST_PACK: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
// Per checkout: one lock per profile, and another checkout's run would make this one quit.
const profile = path.join(tmpdir(), `bw-strict-profile-${path.basename(process.cwd())}`);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env, shell });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('node', ['build.mjs', strict ? `--baked-profile=${profile}` : '--test']);
run('node', ['scripts/build-native.mjs', '--optional']);
run('npx', ['electron-builder', '--dir', '--publish', 'never', ...(strict ? ['-c.directories.output=release-strict'] : [])]);
if (strict) {
  mkdirSync('release-strict', { recursive: true });
  writeFileSync(path.join('release-strict', 'profile.txt'), profile);
}
