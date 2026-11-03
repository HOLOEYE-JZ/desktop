import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { shownPage, waitForLogin } from './helpers';
import { FIXTURES } from './update-helpers';

/**
 * A per-machine install sits in Program Files, where a user can't write. So the app must
 * write nothing next to itself, in any way. First a copy is run and compared before and
 * after, then the same copy is run with writing denied. Needs the 0.9.0 fixture
 * (node scripts/build-update-fixtures.mjs 0.9.0): the inspector fuse lets this drive it.
 */

const SOURCE = path.join(FIXTURES, '0.9.0', 'win-unpacked');

function snapshot(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full);
    if (entry.isDirectory()) {
      out[`${relative}/`] = 'dir';
      snapshot(full, base, out);
    } else {
      const stat = statSync(full);
      out[relative] = `${stat.size}:${stat.mtimeMs}`;
    }
  }
  return out;
}

function diff(before: Record<string, string>, after: Record<string, string>): string[] {
  const changes: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) changes.push(`${key}: ${before[key] ?? 'absent'} -> ${after[key] ?? 'absent'}`);
  }
  return changes.sort();
}

/** Every route family that could reach Next's caches, its image optimizer or sharp. */
async function exercise(exe: string, profile: string): Promise<Record<string, number>> {
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({ mode: 'standalone' }));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${profile}`, '--lang=en-US'], env });
  try {
    const page = await shownPage(app);
    await waitForLogin(page);
    const statuses = await page.evaluate(async () => {
      const results: Record<string, number> = {};
      for (const url of [
        '/api/config',
        '/api/health',
        '/api/pwa-icon/192',
        '/api/og-image',
        '/manifest.webmanifest',
        '/_next/image?url=%2Ficon-192x192.png&w=64&q=75',
        '/en/login',
        '/en',
        '/en/settings',
      ]) {
        results[url] = (await fetch(url)).status;
      }
      return results;
    });
    // Next's own server work happens after the answer, too.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return statuses;
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

test.describe('a read-only install', () => {
  test.skip(process.platform !== 'win32' || !existsSync(SOURCE), 'run node scripts/build-update-fixtures.mjs 0.9.0 first');
  test.setTimeout(400_000);

  test('writes nothing next to itself, and works with writing denied', async () => {
    const work = mkdtempSync(path.join(tmpdir(), 'bw-ro-'));
    const copy = path.join(work, 'Bulwark');
    const exe = path.join(copy, 'Bulwark.exe');
    cpSync(SOURCE, copy, { recursive: true });
    const before = snapshot(copy);
    try {
      const first = await exercise(exe, path.join(work, 'p1'));
      expect(first['/en/login'], 'the login page').toBe(200);
      expect(first['/api/pwa-icon/192'], 'sharp').toBe(200);
      // It would cache under .next/cache, so the server host refuses it.
      expect(first['/_next/image?url=%2Ficon-192x192.png&w=64&q=75']).toBe(404);
      expect(diff(before, snapshot(copy))).toEqual([]);

      // Deny writing to this user: new files, changes, attributes and deleting.
      const denied = spawnSync('icacls', [copy, '/deny', `${userInfo().username}:(OI)(CI)(WD,AD,WA,WEA,DC,DE)`, '/T', '/C', '/Q'], { encoding: 'utf8' });
      expect(denied.status, denied.stderr).toBe(0);
      expect(() => writeFileSync(path.join(copy, 'resources', 'server', 'probe.txt'), 'x'), 'the denial works').toThrow();

      const second = await exercise(exe, path.join(work, 'p2'));
      expect(second['/en/login'], 'the login page').toBe(200);
      expect(second['/api/pwa-icon/192'], 'sharp').toBe(200);
      expect(second).toEqual(first);
      const log = path.join(work, 'p2', 'logs', 'server.log');
      const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
      expect(text).not.toMatch(/EACCES|EPERM|EROFS/);
    } finally {
      spawnSync('icacls', [copy, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore' });
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  });
});
