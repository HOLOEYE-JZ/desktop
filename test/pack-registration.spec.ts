// A test pack (scripts/pack-test.mjs) writes nothing of itself into the OS. Given the stand-in
// key and Send to folder a development test run would register into, it leaves both empty, so
// this test never needs the user's real HKCU. `npm run pack:test` first.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { realRegistrationSnapshot, removeProfile, tempProfile } from './helpers';

const EXE = path.join(import.meta.dirname, '..', 'release', 'win-unpacked', 'Bulwark.exe');

function reg(...args: string[]): { ok: boolean; out: string } {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, out: result.stdout ?? '' };
}

test.skip(process.platform !== 'win32' || !existsSync(EXE), 'run `npm run pack:test` first, on Windows');

test('a test pack registers nothing at its start, not even into a stand-in key', async () => {
  test.setTimeout(240_000);
  const root = `HKCU\\Software\\BulwarkTest\\pack-${process.pid}-${Date.now()}`;
  const profile = tempProfile('packreg');
  const userData = path.join(profile, 'ud');
  const sendTo = path.join(profile, 'SendTo');
  mkdirSync(userData, { recursive: true });
  mkdirSync(sendTo, { recursive: true });
  writeFileSync(path.join(userData, 'shell-state.json'), JSON.stringify({ mode: 'standalone' }));
  const before = realRegistrationSnapshot();
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--user-data-dir=${userData}`, `--bulwark-test-registry-root=${root}`, `--bulwark-test-sendto-dir=${sendTo}`], { env, stdio: 'ignore' });
  try {
    // The server has started, and the OS integration is set up beside it (bootStandalone).
    const log = path.join(userData, 'logs', 'server.log');
    await expect.poll(() => (existsSync(log) ? statSync(log).size : 0), { timeout: 120_000 }).toBeGreaterThan(0);
    // A reg.exe the start sent off could still be on its way.
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    expect(reg('query', root, '/s').out.trim(), 'the stand-in key').toBe('');
    expect(readdirSync(sendTo), 'the stand-in Send to folder').toEqual([]);
    expect(realRegistrationSnapshot(), 'the user\'s own registration').toBe(before);
  } finally {
    child.kill();
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 800));
    reg('delete', root, '/f');
    const parent = reg('query', 'HKCU\\Software\\BulwarkTest');
    if (parent.ok && parent.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length <= 1) reg('delete', 'HKCU\\Software\\BulwarkTest', '/f');
    removeProfile(profile);
  }
});
