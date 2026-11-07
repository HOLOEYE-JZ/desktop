/**
 * V8's compiled code for the server's own JavaScript, made when the package was built
 * (scripts/server-code-cache.cjs) and shipped inside server.asar, so ASAR integrity covers it
 * like the code it belongs to. Without it, the server spends most of its first second
 * compiling Next and the webmail's bundles before it can answer the first page.
 *
 * Read only: nothing is written at run time. A file is taken from the cache only when its
 * source is byte for byte what the cache was made from (SHA-256), and V8 checks its own
 * version and flags; anything else compiles as it always did. No cache, no change.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

export const CACHE_FOLDER = '.code-cache';
export const MANIFEST = 'manifest.json';

/** The CommonJS wrapper on a line of its own, so line and column numbers stay those of the file. */
export const WRAPPER_START = '(function (exports, require, module, __filename, __dirname) {\n';
export const WRAPPER_END = '\n})';

export interface CacheManifest {
  /** process.versions.v8 of the binary that made it. */
  v8: string;
  /** By path relative to the server's root, with forward slashes. */
  files: Record<string, { sha256: string; length: number; data: string }>;
}

export interface CodeCacheStats {
  used: number;
  rejected: number;
  /** Server files that compiled without the cache: not in it, or changed. */
  compiled: number;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function inAsar(dir: string): boolean {
  return /\.asar([\\/]|$)/i.test(dir);
}

export function relativeKey(root: string, filename: string): string | null {
  const relative = path.relative(root, filename);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/** What a manifest says, or null for no cache, one made by another V8, or one that doesn't parse. */
export function readManifest(cacheDir: string, v8 = process.versions.v8): CacheManifest | null {
  try {
    const manifest = JSON.parse(readFileSync(path.join(cacheDir, MANIFEST), 'utf8')) as CacheManifest;
    if (manifest?.v8 !== v8 || typeof manifest.files !== 'object' || manifest.files === null) return null;
    return manifest;
  } catch {
    return null;
  }
}

type Compile = (this: NodeJS.Module, content: string, filename: string, ...rest: unknown[]) => unknown;

interface ModuleInternals {
  prototype: { _compile: Compile; require: (id: string) => unknown };
  _resolveFilename: (request: string, parent: NodeJS.Module, isMain: boolean, options?: unknown) => string;
  _resolveLookupPaths: (request: string, parent: NodeJS.Module) => string[] | null;
  _extensions: unknown;
  _cache: unknown;
}

/** The `require` a module gets, as Node makes it. */
function requireFor(mod: NodeJS.Module): NodeJS.Require {
  const internals = Module as unknown as ModuleInternals;
  const req = ((id: string) => mod.require(id)) as NodeJS.Require;
  const resolve = ((request: string, options?: unknown) => internals._resolveFilename(request, mod, false, options)) as NodeJS.RequireResolve;
  resolve.paths = (request: string) => internals._resolveLookupPaths(request, mod);
  req.resolve = resolve;
  req.main = (process as { mainModule?: NodeJS.Module }).mainModule;
  req.extensions = internals._extensions as NodeJS.Require['extensions'];
  req.cache = internals._cache as NodeJS.Require['cache'];
  return req;
}

/** Compiles a server file the way the cache was made, from `cachedData` when there is one. */
export function compileWrapped(content: string, filename: string, cachedData?: Buffer): { script: vm.Script; run: (mod: NodeJS.Module) => unknown } {
  const script = new vm.Script(WRAPPER_START + content + WRAPPER_END, {
    filename,
    lineOffset: -1,
    cachedData,
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  const run = (mod: NodeJS.Module) => {
    const wrapper = script.runInThisContext({ displayErrors: true }) as (...args: unknown[]) => unknown;
    return wrapper.call(mod.exports, mod.exports, requireFor(mod), mod, filename, path.dirname(filename));
  };
  return { script, run };
}

/** Whether a file can go through the wrapper at all: plain CommonJS, no BOM, no #! line. */
export function wrappable(content: unknown, rest: unknown[]): content is string {
  if (typeof content !== 'string') return false;
  const format = rest[0];
  if (format !== undefined && format !== 'commonjs') return false;
  return !content.startsWith('#!') && !content.startsWith('﻿');
}

/**
 * From here on, server files that the cache holds are compiled from it. Returns null when there
 * is no cache this binary can use.
 */
export function useCodeCache(serverDir: string): { stats: CodeCacheStats; stop: () => void } | null {
  const cacheDir = path.join(serverDir, CACHE_FOLDER);
  const manifest = readManifest(cacheDir);
  if (!manifest) return null;
  // Inside an asar the cache and the sources are one file, made together and checked together by
  // ASAR integrity (or root's alone, in /opt), so they can't drift apart; hashing 30 MB of source
  // there would cost the start ~150 ms for nothing. A plain folder (a development server) is checked.
  const verify = !inAsar(serverDir);
  const stats: CodeCacheStats = { used: 0, rejected: 0, compiled: 0 };
  const proto = (Module as unknown as ModuleInternals).prototype;
  const original = proto._compile;
  const compileFromCache = function compileFromCache(this: NodeJS.Module, content: string, filename: string, ...rest: unknown[]) {
    const key = relativeKey(serverDir, filename);
    const entry = key ? manifest.files[key] : undefined;
    if (!entry || !wrappable(content, rest) || content.length !== entry.length || (verify && sha256(content) !== entry.sha256)) {
      if (key) stats.compiled += 1;
      return original.call(this, content, filename, ...rest);
    }
    let data: Buffer;
    try {
      data = readFileSync(path.join(cacheDir, entry.data));
    } catch {
      stats.compiled += 1;
      return original.call(this, content, filename, ...rest);
    }
    const { script, run } = compileWrapped(content, filename, data);
    // V8 says whether it took the data; a refusal compiled from the source already, as before.
    if (script.cachedDataRejected === false) stats.used += 1;
    else stats.rejected += 1;
    return run(this);
  };
  proto._compile = compileFromCache;
  return {
    stats,
    stop: () => {
      if (proto._compile === compileFromCache) proto._compile = original;
    },
  };
}
