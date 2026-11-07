import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import asar from '@electron/asar';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { asarHasCodeCache, codeCacheUsed } from '../scripts/perf-code-cache.mjs';

test('the nightly check tells a package with the server code cache from one without', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'perf-cc-'));
  try {
    for (const [name, cache] of [['with', true], ['without', false]] as const) {
      const tree = path.join(dir, name);
      mkdirSync(path.join(tree, '.code-cache'), { recursive: true });
      writeFileSync(path.join(tree, 'server.js'), '1');
      if (cache) writeFileSync(path.join(tree, '.code-cache', 'manifest.json'), '{}');
      else rmSync(path.join(tree, '.code-cache'), { recursive: true });
      await asar.createPackage(tree, path.join(dir, `${name}.asar`));
    }
    expect(asarHasCodeCache(path.join(dir, 'with.asar'))).toBe(true);
    expect(asarHasCodeCache(path.join(dir, 'without.asar'))).toBe(false);
    expect(asarHasCodeCache(path.join(dir, 'missing.asar'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the nightly check reads how much of the code cache the server used', () => {
  expect(codeCacheUsed('info: listening\ninfo: code cache at ready: 473 used, 0 rejected, 2 compiled\n')).toBe(473);
  // Another V8 or a damaged cache: none used, which fails a package that carries one.
  expect(codeCacheUsed('info: code cache at ready: 0 used, 473 rejected, 900 compiled\n')).toBe(0);
  expect(codeCacheUsed('info: listening\n')).toBeNull();
});
