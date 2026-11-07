import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CACHE_FOLDER, compileWrapped, MANIFEST, readManifest, sha256, useCodeCache, type CacheManifest } from '../src/server/code-cache';
import { makeCodeCache } from '../scripts/server-archive.mjs';

/** A server root with files, and a cache for the ones named in `cached`, made as the generator makes it. */
function serverWith(files: Record<string, string>, cached: string[], v8 = process.versions.v8): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-code-cache-'));
  mkdirSync(path.join(root, CACHE_FOLDER));
  const manifest: CacheManifest = { v8, files: {} };
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content);
  for (const name of cached) {
    const { script } = compileWrapped(files[name], path.join(root, name));
    const data = `${sha256(name).slice(0, 32)}.bin`;
    writeFileSync(path.join(root, CACHE_FOLDER, data), script.createCachedData());
    manifest.files[name] = { sha256: sha256(files[name]), data };
  }
  writeFileSync(path.join(root, CACHE_FOLDER, MANIFEST), JSON.stringify(manifest));
  return root;
}

test('a file compiled through the wrapper keeps its line and column numbers', () => {
  const filename = path.join(tmpdir(), 'bw-wrapped.js');
  const content = "exports.first = () => { throw new Error('one') };\n  exports.second = () => { throw new Error('two') };";
  const mod = { exports: {} as Record<string, () => void> } as unknown as NodeJS.Module;
  compileWrapped(content, filename).run(mod);
  const where = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      return /bw-wrapped\.js:(\d+):(\d+)/.exec(String((error as Error).stack))?.slice(1).join(':');
    }
  };
  expect(where((mod.exports as Record<string, () => void>).first)).toBe('1:31');
  expect(where((mod.exports as Record<string, () => void>).second)).toBe('2:34');
});

test('the server takes cached code only for a file whose bytes are the ones it was made from', () => {
  const files = {
    'same.js': "module.exports = { answer: 42, dir: __dirname, self: require.resolve('./same.js') };",
    'changed.js': 'module.exports = 2;',
    'other.js': 'module.exports = 4;',
  };
  const root = serverWith(files, ['same.js', 'changed.js']);
  const handle = useCodeCache(root);
  try {
    expect(handle).not.toBeNull();
    // Straight through the loader's compile step: the test runner rewrites what require reads.
    const compile = (Module.prototype as unknown as { _compile: (content: string, filename: string, format?: string) => unknown })._compile;
    const load = (name: string, content: string) => {
      const filename = path.join(root, name);
      const mod = new Module(filename) as NodeJS.Module & { filename: string; paths: string[] };
      mod.filename = filename;
      mod.paths = (Module as unknown as { _nodeModulePaths: (dir: string) => string[] })._nodeModulePaths(root);
      compile.call(mod, content, filename, 'commonjs');
      return mod.exports;
    };
    expect(load('same.js', files['same.js'])).toEqual({ answer: 42, dir: root, self: path.join(root, 'same.js') });
    // Changed after the cache was made: same length, other bytes.
    expect(load('changed.js', 'module.exports = 3;')).toBe(3);
    expect(load('other.js', files['other.js'])).toBe(4);
    expect(handle!.stats).toEqual({ used: 1, rejected: 0, compiled: 2 });
  } finally {
    handle?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a cache from another V8, or none, changes nothing', () => {
  const root = serverWith({ 'a.js': 'module.exports = 1;' }, ['a.js'], '0.0.0-other');
  try {
    expect(readManifest(path.join(root, CACHE_FOLDER))).toBeNull();
    expect(useCodeCache(root)).toBeNull();
    expect(useCodeCache(path.join(root, 'nothing-here'))).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the package gets a cache only where this machine runs the target binary, and never for macOS', () => {
  const calls: unknown[] = [];
  const run = ((...args: unknown[]) => {
    calls.push(args);
    return { status: 0, stdout: '[code-cache] 1 files\n', stderr: '' };
  }) as unknown as typeof import('node:child_process').spawnSync;
  const other = process.arch === 'x64' ? 'arm64' : 'x64';
  expect(makeCodeCache('/nowhere', '/tree', process.platform, other, { electron: 'electron', run } as never).made).toBe(false);
  expect(makeCodeCache('/nowhere', '/tree', 'darwin', process.arch, { electron: 'electron', run } as never).made).toBe(false);
  expect(calls).toEqual([]);
});
