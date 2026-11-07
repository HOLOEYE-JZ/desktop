// Packs the webmail server into server.asar for one target, before electron-builder
// copies resources. Loose files make an install slow: the installer writes each one and a
// virus scanner reads each one. Only native binaries stay out, about 10 files, since
// Windows loads a DLL only from a real file. .next/static and public stay in: Next serves
// them with fs.stat and fs.createReadStream, which read straight out of an asar in
// Electron's utility process, without copying anything out.
//
// Before packing, because electron-builder only adds an asar to the ASAR integrity list
// if it exists when it computes that list. So the server is covered by integrity too.
//
//   .server-build/<os>-<arch>/server.asar
//   .server-build/<os>-<arch>/server.asar.unpacked   copied by after-pack.cjs: electron-
//                                                    builder drops node_modules from
//                                                    extraResources whatever the filter says

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { guardPackage } from './package-guard.mjs';
import { trimServer } from './server-natives.mjs';

export const OS_NAMES = { win32: 'win', darwin: 'mac', linux: 'linux' };

/** Must stay real files: the OS loads these. sharp's DLLs sit next to its .node in @img. */
export const UNPACK_FILES = '*.{node,dll,so,dylib}';
export const UNPACK_DIRS = 'node_modules/@img';

export function archiveDir(projectDir, platform, arch) {
  return path.join(projectDir, '.server-build', `${OS_NAMES[platform] ?? platform}-${arch}`);
}

export async function buildServerArchive({ projectDir, platform, arch, source = path.join(projectDir, 'webmail') }) {
  if (!existsSync(path.join(source, 'node_modules'))) throw new Error('webmail/node_modules is missing: run scripts/fetch-webmail.mjs first');
  const out = archiveDir(projectDir, platform, arch);
  rmSync(out, { recursive: true, force: true });
  const tree = path.join(out, 'tree');
  mkdirSync(out, { recursive: true });
  // No `dereference`: a link has to reach the guard as a link, not as what it points at. The
  // folder itself may be a link (a worktree's ./webmail): copied as one, the trim, the guard's
  // rewrites and the code cache would change the folder it points at.
  cpSync(realpathSync(source), tree, { recursive: true, verbatimSymlinks: true });

  const trim = trimServer(tree, platform, arch);
  guardPackage(tree);
  // After the guard: it rewrites build paths in some files, and the cache goes by their bytes.
  const codeCache = makeCodeCache(projectDir, tree, platform, arch);

  const require = createRequire(import.meta.url);
  const asar = require('@electron/asar');
  await asar.createPackageWithOptions(tree, path.join(out, 'server.asar'), { unpack: UNPACK_FILES, unpackDir: UNPACK_DIRS });
  rmSync(tree, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  return { dir: out, trim, codeCache };
}

/**
 * V8's code for the server (src/server/code-cache.ts), made by this build's own Electron
 * running the server once (dist/code-cache-gen.cjs), so its V8 and flags are the ones that
 * will read it. Only where this machine runs the target's binary: a package for another
 * architecture, and macOS (whose two halves of a universal build must be the same bytes),
 * ships without one, and its server compiles as before. A cache that can't be made isn't an
 * error: the package works without it.
 */
export function makeCodeCache(projectDir, tree, platform, arch, { electron, run = spawnSync } = {}) {
  if (platform === 'darwin' || platform !== process.platform || arch !== process.arch) return { made: false, reason: `not made for ${platform}-${arch} on ${process.platform}-${process.arch}` };
  const generator = path.join(projectDir, 'dist', 'code-cache-gen.cjs');
  if (!existsSync(generator)) return { made: false, reason: 'no dist/code-cache-gen.cjs: run build.mjs first' };
  const binary = electron ?? createRequire(import.meta.url)('electron');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const result = run(binary, [generator, tree], { env, encoding: 'utf8', timeout: 180_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/).filter((line) => line.startsWith('[code-cache]')).join(' ');
  if (result.status !== 0) {
    rmSync(path.join(tree, '.code-cache'), { recursive: true, force: true });
    console.warn(`[server-archive] no code cache: ${output || result.error?.message || `exit ${result.status}`}`);
    return { made: false, reason: output || 'the generator failed' };
  }
  console.log(`[server-archive] ${output}`);
  return { made: true, reason: output };
}
