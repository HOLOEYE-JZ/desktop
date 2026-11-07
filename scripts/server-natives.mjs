// The server tree's native binaries, per platform and architecture.
//
// A webmail build on one machine holds sharp for that machine only, and sharp is what
// makes BIMI logos work, so a package for another architecture needs that one's. So:
//
//   addNativePlatforms: fetches sharp's binaries for more targets into the tree, at
//     the exact version sharp asks for. Used by `fetch-webmail.mjs --native win32-arm64`.
//   trimServer: run by after-pack.cjs. Keeps what the target runs and fails the build
//     if that's missing, so a package can't ship with sharp silently broken.
//
// esbuild goes altogether. The webmail only loads it for PLUGIN_DEV_DIR, which the
// embedded server's allowlisted env never has (src/main/profile.ts). So does caniuse-lite.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * sharp's package suffixes a target needs. macOS holds both, always: a universal build
 * packs x64 and arm64 separately and then merges, and any file unique to one side stops
 * the merge.
 */
export function sharpTargets(platform, arch) {
  if (platform === 'darwin') return ['darwin-x64', 'darwin-arm64'];
  return [`${platform}-${arch}`];
}

function sizeOf(target) {
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(target).reduce((total, name) => total + sizeOf(path.join(target, name)), 0);
}

function remove(target, removed) {
  const bytes = sizeOf(target);
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  removed.add(path.basename(target));
  return bytes;
}

/** Whether a package in @img/ goes: another target's binaries. `@img/colour` is plain JS and stays. */
function isForeign(name, targets) {
  const match = /^sharp-(?:libvips-)?(.+)$/.exec(name);
  return match ? !targets.includes(match[1]) : false;
}

/**
 * Next's files that only `next build` and `next dev` use, about 13 MB that the standalone trace
 * takes along anyway: the Babel and CSS tool chains, the font loaders and their 4 MB of font
 * metrics, the dev overlay and its MCP server, and the page runtimes for Turbopack builds and for
 * React's experimental channel (the webmail builds with webpack and stable React; the server
 * picks a runtime by TURBOPACK and __NEXT_EXPERIMENTAL_REACT, which the app never sets). A
 * started server with every page of the app rendered read none of them.
 */
export const NEXT_BUILD_ONLY = [
  'dist/server/capsize-font-metrics.json',
  'dist/compiled/babel',
  'dist/compiled/babel-packages',
  'dist/compiled/next-devtools',
  'dist/compiled/@next/font',
  'dist/compiled/@next/react-refresh-utils',
  'dist/compiled/@modelcontextprotocol',
  'dist/compiled/postcss-preset-env',
  'dist/compiled/cssnano-simple',
  'dist/compiled/next-server/app-page-turbo.runtime.prod.js',
  'dist/compiled/next-server/app-page-turbo-experimental.runtime.prod.js',
  'dist/compiled/next-server/app-page-experimental.runtime.prod.js',
  'dist/compiled/next-server/pages-turbo.runtime.prod.js',
];

export function trimServer(server, platform, arch) {
  const modules = path.join(server, 'node_modules');
  const targets = sharpTargets(platform, arch);
  const removed = new Set();
  let bytes = 0;

  // caniuse-lite is 600 files that only browserslist and cssnano read at build time.
  for (const dir of ['esbuild', '@esbuild', 'caniuse-lite']) {
    const full = path.join(modules, dir);
    if (existsSync(full)) bytes += remove(full, removed);
  }
  for (const relative of NEXT_BUILD_ONLY) {
    const full = path.join(modules, 'next', ...relative.split('/'));
    if (!existsSync(full)) continue;
    bytes += sizeOf(full);
    rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    removed.add(`next/${relative}`);
  }

  const img = path.join(modules, '@img');
  if (existsSync(path.join(modules, 'sharp'))) {
    const present = existsSync(img) ? readdirSync(img) : [];
    for (const target of targets) {
      if (!present.includes(`sharp-${target}`)) {
        throw new Error(`The server has no sharp for ${target}. Run: node scripts/fetch-webmail.mjs --native ${target}`);
      }
    }
    for (const name of present) {
      if (isForeign(name, targets)) bytes += remove(path.join(img, name), removed);
    }
  }
  return { bytes, removed: [...removed] };
}

/** `npm pack` one exact version and unpack it over the tree, as node_modules/<name>. */
function fetchPackage(name, version, modules) {
  const work = mkdtempSync(path.join(tmpdir(), 'bulwark-native-'));
  try {
    const pack = spawnSync('npm', ['pack', `${name}@${version}`, '--silent'], { cwd: work, encoding: 'utf8', shell: process.platform === 'win32' });
    if (pack.status !== 0) throw new Error(`npm pack ${name}@${version} failed: ${pack.stderr}`);
    const tarball = readdirSync(work).find((file) => file.endsWith('.tgz'));
    if (!tarball) throw new Error(`npm pack ${name}@${version} wrote no file`);
    // Relative: Windows' bsdtar reads C:\ fine, GNU tar under Git Bash takes it for a host.
    const unpack = spawnSync('tar', ['-xzf', tarball], { cwd: work, encoding: 'utf8' });
    if (unpack.status !== 0) throw new Error(`could not unpack ${tarball}: ${unpack.stderr}`);
    const target = path.join(modules, ...name.split('/'));
    rmSync(target, { recursive: true, force: true });
    mkdirSync(path.dirname(target), { recursive: true });
    spawnSync('node', ['-e', 'require("fs").cpSync(process.argv[1], process.argv[2], {recursive:true})', path.join(work, 'package'), target], { stdio: 'inherit' });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Adds sharp's packages for each target to a webmail tree. Returns the names added. */
export function addNativePlatforms(tree, targets) {
  const modules = path.join(tree, 'node_modules');
  const sharp = JSON.parse(readFileSync(path.join(modules, 'sharp', 'package.json'), 'utf8'));
  const optional = sharp.optionalDependencies ?? {};
  const added = [];
  for (const target of targets) {
    const names = Object.keys(optional).filter((name) => name === `@img/sharp-${target}` || name === `@img/sharp-libvips-${target}`);
    if (names.length === 0) throw new Error(`sharp ${sharp.version} has no binaries for ${target}`);
    for (const name of names) {
      fetchPackage(name, optional[name], modules);
      added.push(`${name}@${optional[name]}`);
    }
  }
  return added;
}
