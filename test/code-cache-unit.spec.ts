import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CACHE_FOLDER, compileWrapped, inAsar, MANIFEST, WRAPPER_END, WRAPPER_START, readManifest, sha256, useCodeCache, type CacheManifest } from '../src/server/code-cache';
import { makeCodeCache } from '../scripts/server-archive.mjs';

/** A server root with files, and a cache for the ones named in `cached`, made as the generator makes it. */
const MAKE_CACHE = `
const vm = require('node:vm');
const jobs = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(jobs.map(({ source, filename }) => new vm.Script(source, { filename, lineOffset: -1, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }).createCachedData().toString('base64'))));
`;

function serverWith(files: Record<string, string>, cached: string[], v8 = process.versions.v8): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-code-cache-'));
  mkdirSync(path.join(root, CACHE_FOLDER));
  const manifest: CacheManifest = { v8, files: {} };
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content);
  // Made in another process, as the package's is: within one V8, compiling the same source again
  // comes from V8's own memory and never looks at the cached data.
  const jobs = cached.map((name) => ({ source: WRAPPER_START + files[name] + WRAPPER_END, filename: path.join(root, name) }));
  const made = spawnSync(process.execPath, ['-e', MAKE_CACHE], { input: JSON.stringify(jobs), encoding: 'utf8' });
  if (made.status !== 0) throw new Error(made.stderr);
  const datas = JSON.parse(made.stdout) as string[];
  cached.forEach((name, i) => {
    const data = `${sha256(name).slice(0, 32)}.bin`;
    writeFileSync(path.join(root, CACHE_FOLDER, data), Buffer.from(datas[i], 'base64'));
    manifest.files[name] = { sha256: sha256(files[name]), length: files[name].length, data };
  });
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

test('a cached file V8 refuses (damaged, or made by another build) compiles as before and runs the same', () => {
  const files = { 'damaged.js': 'module.exports = { value: 7 };', 'missing.js': 'module.exports = 8;' };
  const root = serverWith(files, ['damaged.js', 'missing.js']);
  const manifest = JSON.parse(readFileSync(path.join(root, CACHE_FOLDER, MANIFEST), 'utf8')) as CacheManifest;
  // Bytes no V8 accepts, and a cache file that isn't there.
  writeFileSync(path.join(root, CACHE_FOLDER, manifest.files['damaged.js'].data), Buffer.from('not code from any V8 at all'.repeat(40)));
  rmSync(path.join(root, CACHE_FOLDER, manifest.files['missing.js'].data));
  const handle = useCodeCache(root);
  try {
    const compile = (Module.prototype as unknown as { _compile: (content: string, filename: string, format?: string) => unknown })._compile;
    const load = (name: string, content: string) => {
      const mod = new Module(path.join(root, name)) as NodeJS.Module & { filename: string };
      mod.filename = path.join(root, name);
      compile.call(mod, content, mod.filename, 'commonjs');
      return mod.exports;
    };
    expect(load('damaged.js', files['damaged.js'])).toEqual({ value: 7 });
    expect(load('missing.js', files['missing.js'])).toBe(8);
    expect(handle!.stats).toEqual({ used: 0, rejected: 1, compiled: 1 });
  } finally {
    handle?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the source is hashed except inside an asar, where it and its cache are one checked file', () => {
  expect(inAsar('/opt/Bulwark/resources/server.asar')).toBe(true);
  expect(inAsar(String.raw`C:\Program Files\Bulwark\resources\server.asar\node_modules`)).toBe(true);
  expect(inAsar('/home/me/desktop/webmail')).toBe(false);
  expect(inAsar('/home/me/server.asar.unpacked')).toBe(false);
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
