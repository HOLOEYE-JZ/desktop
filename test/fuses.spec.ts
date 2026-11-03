import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { removeProfile, tempProfile } from './helpers';

/**
 * Reads the hardening back from the built binary: `npm run pack:test` first. No
 * dependency: the fuse wire is a sentinel in the executable, then a version byte,
 * a length byte, and one byte per fuse ('0' off, '1' on, 'r' removed).
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const UNPACKED = path.join(ROOT, 'release', 'win-unpacked');
const EXE = path.join(UNPACKED, 'Bulwark.exe');
const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

const FUSES = [
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
] as const;

function readFuses(file: string): Record<string, string> {
  const binary = readFileSync(file);
  const at = binary.indexOf(SENTINEL);
  if (at === -1) throw new Error('no fuse wire in this binary');
  const wire = at + SENTINEL.length;
  const version = binary[wire];
  if (version !== 1) throw new Error(`unknown fuse wire version ${version}`);
  const count = binary[wire + 1];
  const out: Record<string, string> = {};
  for (let i = 0; i < count && i < FUSES.length; i += 1) out[FUSES[i]] = String.fromCharCode(binary[wire + 2 + i]);
  return out;
}

function allFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) allFiles(full, found);
    else found.push(full);
  }
  return found;
}

test.describe('the packaged app', () => {
  test.skip(!existsSync(EXE), 'run `npm run pack:test` first');

  test('fuses read back from the built binary', () => {
    const fuses = readFuses(EXE);
    expect(fuses.runAsNode).toBe('0');
    expect(fuses.enableNodeOptionsEnvironmentVariable).toBe('0');
    expect(fuses.enableNodeCliInspectArguments).toBe('0');
    expect(fuses.enableCookieEncryption).toBe('1');
    expect(fuses.enableEmbeddedAsarIntegrityValidation).toBe('1');
    expect(fuses.onlyLoadAppFromAsar).toBe('1');
    expect(fuses.grantFileProtocolExtraPrivileges).toBe('0');
  });

  test('the unfused Electron binary would fail this, so the check can fail', () => {
    const fuses = readFuses(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'));
    expect(fuses.runAsNode).toBe('1');
  });

  test('ELECTRON_RUN_AS_NODE does not turn it into Node', () => {
    const profile = tempProfile('fuse');
    const script = path.join(profile, 'probe.cjs');
    const marker = path.join(profile, 'ran-as-node');
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes'); process.exit(0);`);
    spawnSync(EXE, [script, `--user-data-dir=${path.join(profile, 'ud')}`], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 8000,
    });
    expect(existsSync(marker)).toBe(false);
    removeProfile(profile);
  });

  test('nothing private is in the package', () => {
    const resources = path.join(UNPACKED, 'resources', 'server');
    const relative = allFiles(resources).map((file) => path.relative(resources, file).split(path.sep).join('/'));
    expect(relative).toContain('server.js');
    expect(relative).toContain('node_modules/next/package.json');
    expect(relative).toContain('.next/required-server-files.json');
    const outside = relative.filter((file) => !file.startsWith('node_modules/') && !file.startsWith('.next/'));
    for (const file of outside) {
      expect(file, file).not.toMatch(/^(data|local-data|repos)\//);
      expect(file, file).not.toMatch(/(^|\/)\.env/);
      expect(file, file).not.toMatch(/plugin-signing\.key$/);
    }
    expect(relative.some((file) => file.startsWith('.next/cache/'))).toBe(false);
    // The build machine's paths are out of what Next recorded.
    const recorded = readFileSync(path.join(resources, '.next', 'required-server-files.json'), 'utf8');
    expect(recorded).not.toContain(path.resolve(ROOT, '..', '..').split(path.sep).slice(0, 3).join('/'));
    expect(recorded).toContain('/bulwark-build');
  });

  test('the first-run page still works with the file protocol\'s extra privileges off', async () => {
    test.skip(process.platform !== 'win32', 'reads the window title through PowerShell');
    const profile = tempProfile('packwelcome');
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(EXE, [`--user-data-dir=${path.join(profile, 'ud')}`, '--lang=en-US'], { env, stdio: 'ignore' });
    try {
      const title = () =>
        spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue).MainWindowTitle`], { encoding: 'utf8' }).stdout.trim();
      // Set by welcome.js, so the script ran.
      await expect.poll(title, { timeout: 40_000, intervals: [1000] }).toMatch(/Welcome to Bulwark|Willkommen bei Bulwark/);
    } finally {
      child.kill();
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      await new Promise((resolve) => setTimeout(resolve, 800));
      removeProfile(profile);
    }
  });

  test('it starts from the package with the fuses on, and the server listens', async () => {
    const profile = tempProfile('pack');
    const userData = path.join(profile, 'ud');
    mkdirSync(userData, { recursive: true });
    writeFileSync(path.join(userData, 'shell-state.json'), JSON.stringify({ mode: 'standalone' }));
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(EXE, [`--user-data-dir=${userData}`], { env, stdio: 'ignore' });
    try {
      const log = path.join(userData, 'logs', 'server.log');
      await expect
        .poll(() => (existsSync(log) ? statSync(log).size : 0), { timeout: 90_000 })
        .toBeGreaterThan(0);
      // The server's admin password was hashed: its start-up chain ran.
      await expect
        .poll(() => existsSync(path.join(userData, 'webmail', 'admin', 'admin.json')), { timeout: 60_000 })
        .toBe(true);
      expect(existsSync(path.join(userData, 'keys', 'session-secret.bin'))).toBe(true);
    } finally {
      child.kill();
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      await new Promise((resolve) => setTimeout(resolve, 800));
      removeProfile(profile);
    }
  });
});
