// Offering Bulwark to Windows, on a registry key of the test's own under HKCU. Nothing here
// touches the real Software\Classes, and each test takes its key away again.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { windowsRegistration } from '../src/main/features/os-rules';
import { launch, removeProfile, shownPage, tempProfile, waitForLogin } from './helpers';

test.skip(process.platform !== 'win32', 'Windows only');

const COMMAND = (id: string) => `Software\\Classes\\${id}\\shell\\open\\command`;

function readCommand(root: string, id: string): string | null {
  const answer = spawnSync('reg.exe', ['query', `${root}\\${COMMAND(id)}`, '/ve'], { encoding: 'utf8', windowsHide: true });
  if (answer.status !== 0) return null;
  return /REG_SZ\s+(.*)/.exec(answer.stdout)?.[1]?.trim() ?? null;
}

function writeCommand(root: string, id: string, command: string): void {
  execFileSync('reg.exe', ['add', `${root}\\${COMMAND(id)}`, '/ve', '/t', 'REG_SZ', '/d', command, '/f'], { windowsHide: true });
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = `HKCU\\Software\\BulwarkTest-${process.pid}-${Date.now()}`;
  try {
    await body(root);
  } finally {
    spawnSync('reg.exe', ['delete', root, '/f'], { windowsHide: true });
  }
}

async function start(root: string) {
  const profile = tempProfile('reg');
  const app = await launch(profile, '--standalone', `--bulwark-test-registry-root=${root}`);
  const page = await shownPage(app);
  await waitForLogin(page);
  const exe = await app.evaluate(() => process.execPath);
  return { exe, stop: async () => {
    await app.close().catch(() => {});
    removeProfile(profile);
  } };
}

const IDS = ['bulwark', 'Bulwark.Url.mailto', 'Bulwark.Url.webcal', 'Bulwark.File.eml', 'Bulwark.File.ics', 'Bulwark.File.vcf'];

test('a clean start registers everything, each with the switch terminator', async () => {
  await withRoot(async (root) => {
    const { exe, stop } = await start(root);
    try {
      const wanted = `"${exe}" -- "%1"`;
      for (const id of IDS) await expect.poll(() => readCommand(root, id), { message: id }).toBe(wanted);
    } finally {
      await stop();
    }
  });
});

test('what Electron itself would write for the scheme counts as not registered', async () => {
  await withRoot(async (root) => {
    const exe = spawnSync('node', ['-p', "require('electron')"], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    // The old start wrote this, and then the check saw the exe and left mailto and .eml out.
    writeCommand(root, 'bulwark', `"${exe}" "%1"`);
    const { exe: running, stop } = await start(root);
    try {
      const wanted = `"${running}" -- "%1"`;
      await expect.poll(() => readCommand(root, 'bulwark')).toBe(wanted);
      await expect.poll(() => readCommand(root, 'Bulwark.Url.mailto')).toBe(wanted);
      await expect.poll(() => readCommand(root, 'Bulwark.File.eml')).toBe(wanted);
    } finally {
      await stop();
    }
  });
});

test('registered as it should be, a start writes nothing', async () => {
  await withRoot(async (root) => {
    const exe = spawnSync('node', ['-p', "require('electron')"], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    writeCommand(root, 'bulwark', `"${exe}" -- "%1"`);
    const { stop } = await start(root);
    try {
      // Long enough for the start's look at the registry and any write after it.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(readCommand(root, 'Bulwark.Url.mailto')).toBeNull();
    } finally {
      await stop();
    }
  });
});

test('a real Electron: a switch hidden in a link stays an argument', async () => {
  const exe = spawnSync('node', ['-p', "require('electron')"], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const folder = mkdtempSync(path.join(tmpdir(), 'bw-switch-'));
  const script = path.join(folder, 'probe.cjs');
  const out = path.join(folder, 'out.json');
  writeFileSync(script, `const { app } = require('electron');
require('node:fs').writeFileSync(process.env.PROBE_OUT, JSON.stringify({ evil: app.commandLine.hasSwitch('evil-switch'), argv: process.argv.slice(2) }));
app.exit(0);
`);
  const run = async (registered: string) => {
    rmSync(out, { force: true });
    const hostile = 'bulwark://new" --evil-switch=1 "';
    // As the shell does: %1 goes in as it is. The script stands in for what a package has inside.
    const line = registered.replace(`"${exe}"`, `"${script}"`).replace('%1', hostile);
    const env: NodeJS.ProcessEnv = { ...process.env, PROBE_OUT: out };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exe, [line], { argv0: `"${exe}"`, windowsVerbatimArguments: true, env, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    return existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) as { evil: boolean; argv: string[] } : null;
  };
  try {
    const registered = windowsRegistration(exe).find((value) => value.key === COMMAND('bulwark'));
    expect(registered?.data).toBe(`"${exe}" -- "%1"`);
    // The app runs, and the switch is a plain argument that nothing reads as one.
    expect(await run(registered!.data)).toEqual({ evil: false, argv: ['--', 'bulwark://new', '--evil-switch=1', ''] });
    // Without the terminator Electron's own check for switches after a URL refuses to start at
    // all: a link like this would just do nothing.
    expect(await run(`"${exe}" "%1"`)).toBeNull();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
