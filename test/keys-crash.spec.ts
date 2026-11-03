/**
 * Hard kills of the real app on a new profile, in a loop over the first seconds. Chromium only
 * writes Local State, which holds the key safeStorage encrypts with, ten seconds after a first
 * start. Whatever the moment of the kill, the next start has to come up.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { keyOnDisk, settleKeyBeforeChromium } from '../src/main/key-on-disk';
import { ENT_PASSWORD, expectMailShown, launch, launchStandalone, removeProfile, shownPage, signIn, STALWARTS, tempProfile, waitForLogin } from './helpers';

const ROOT = path.resolve(import.meta.dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const MAIN = path.join(ROOT, 'dist', 'main.mjs');

test.skip(process.platform !== 'win32', 'the key only depends on Local State on Windows');

function start(profile: string, ...args: string[]): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(ELECTRON, [MAIN, `--bulwark-user-data=${profile}`, '--lang=en-US', ...args], { cwd: ROOT, env, stdio: 'ignore' });
}

/** What a power cut does to the app: no quit, no flush, every process gone at once. */
async function hardKill(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  await exited;
}

async function runThenKill(profile: string, afterMs: number, ...args: string[]): Promise<void> {
  const child = start(profile, ...args);
  await new Promise((resolve) => setTimeout(resolve, afterMs));
  await hardKill(child);
}

/** Fails at once on an error page, naming it, rather than after the long wait for a login form. */
async function expectLogin(page: Page): Promise<void> {
  let seen = 'waiting';
  await expect
    .poll(async () => {
      const text = await page.locator('body').innerText().catch(() => '');
      if (/can't read its keys|key file is missing|couldn't save its key|couldn't start/.test(text)) seen = text.split('\n')[0];
      else if (await page.locator('#username').isVisible().catch(() => false)) seen = 'login';
      return seen;
    }, { timeout: 90_000, intervals: [250] })
    .not.toBe('waiting');
  expect(seen).toBe('login');
  await waitForLogin(page);
}

const secretFile = (profile: string) => path.join(profile, 'keys', 'session-secret.bin');
const savedFile = (profile: string) => path.join(profile, 'keys', 'os-crypt-key.saved');

async function expectStartsAndKeepsItsKeys(profile: string): Promise<void> {
  const again = await launchStandalone(profile);
  await expectLogin(again.page);
  const secret = readFileSync(secretFile(profile));
  await again.app.close();
  // And what that start wrote is good for the one after it.
  const last = await launchStandalone(profile);
  await expectLogin(last.page);
  expect(readFileSync(secretFile(profile))).toEqual(secret);
  await last.app.close();
}

test.describe('a hard kill during the first run', () => {
  test.describe.configure({ mode: 'parallel', timeout: 240_000 });

  // Thick around the first file writes, then across Chromium's ten seconds and past them.
  const moments = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1200, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 9500, 10000, 10500, 11000, 12000];
  for (const afterMs of moments) {
    test(`after ${afterMs} ms, the next start comes up`, async () => {
      const profile = tempProfile('kc');
      await runThenKill(profile, afterMs, '--standalone');
      await expectStartsAndKeepsItsKeys(profile);
      removeProfile(profile);
    });
  }

  // The recovery from the last kill can be cut off as well.
  for (const [first, second] of [[300, 300], [600, 400], [1000, 800], [3000, 600], [5000, 1000]]) {
    test(`after ${first} ms and again ${second} ms into the next start, the one after comes up`, async () => {
      const profile = tempProfile('kc2');
      await runThenKill(profile, first, '--standalone');
      await runThenKill(profile, second, '--standalone');
      await expectStartsAndKeepsItsKeys(profile);
      removeProfile(profile);
    });
  }

  for (const afterMs of [200, 500, 2000]) {
    test(`on the welcome page after ${afterMs} ms, the next start asks again`, async () => {
      const profile = tempProfile('kc3');
      await runThenKill(profile, afterMs);
      const app = await launch(profile);
      const page = await shownPage(app);
      await page.locator('#standalone').waitFor();
      await app.close();
      removeProfile(profile);
    });
  }
});

test.describe('with the fallback, when the separate run gets no key onto the disk', () => {
  test.describe.configure({ mode: 'parallel', timeout: 240_000 });

  for (const afterMs of [1000, 3000, 6000, 9000]) {
    test(`a hard kill after ${afterMs} ms leaves no secret behind, and the next start comes up`, async () => {
      const profile = tempProfile('kc4');
      await runThenKill(profile, afterMs, '--standalone', '--bulwark-test-no-key-init');
      // Nothing under a key that's only in memory.
      if (!keyOnDisk(profile)) expect(existsSync(secretFile(profile))).toBe(false);
      await expectStartsAndKeepsItsKeys(profile);
      removeProfile(profile);
    });
  }

  test('a disk that never takes the key gets its own error page, with nothing written', async () => {
    const profile = tempProfile('kc5');
    // A folder where the file has to go: Chromium can't replace it.
    mkdirSync(path.join(profile, 'Local State'));
    const app = await launch(profile, '--standalone');
    const page = await shownPage(app);
    await expect(page.locator('body')).toContainText("couldn't save its key", { timeout: 60_000 });
    expect(existsSync(secretFile(profile))).toBe(false);
    await app.close();
    removeProfile(profile);
  });
});

/** The wrapped key of another, new profile: a key DPAPI opens, just not the one in use. */
async function anotherKey(): Promise<string> {
  const other = tempProfile('kc6');
  const app = await launch(other);
  await shownPage(app);
  await app.close();
  const key = keyOnDisk(other);
  removeProfile(other);
  if (!key) throw new Error('no key');
  return key;
}

function setKeyInLocalState(profile: string, key: string): void {
  const file = path.join(profile, 'Local State');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...state, os_crypt: { ...state.os_crypt, encrypted_key: key } }));
}

test.describe('Local State after the first run', () => {
  test.describe.configure({ mode: 'parallel', timeout: 240_000 });

  async function setUp(name: string): Promise<{ profile: string; secret: Buffer; saved: string }> {
    const profile = tempProfile(name);
    const first = await launchStandalone(profile);
    await expectLogin(first.page);
    const saved = readFileSync(savedFile(profile), 'utf8');
    expect(saved).toBe(keyOnDisk(profile));
    await first.app.close();
    return { profile, secret: readFileSync(secretFile(profile)), saved };
  }

  const damages: [string, (profile: string) => void | Promise<void>][] = [
    ['gone', (profile) => rmSync(path.join(profile, 'Local State'))],
    ['cut off in the middle', (profile) => writeFileSync(path.join(profile, 'Local State'), '{"os_crypt":{"encr')],
    ['without the key', (profile) => writeFileSync(path.join(profile, 'Local State'), '{}')],
    ['holding a key Chromium made anew', async (profile) => setKeyInLocalState(profile, await anotherKey())],
    // As a key DPAPI can't open: Chromium would write a new one over it.
    ['holding a key DPAPI will not open', (profile) => setKeyInLocalState(profile, Buffer.from('DPAPInot a blob').toString('base64'))],
  ];
  for (const [what, damage] of damages) {
    test(`${what}: the saved key goes back and the secrets stay readable`, async () => {
      const { profile, secret, saved } = await setUp('kc7');
      await damage(profile);
      await expectStartsAndKeepsItsKeys(profile);
      expect(readFileSync(secretFile(profile))).toEqual(secret);
      expect(keyOnDisk(profile)).toBe(saved);
      removeProfile(profile);
    });
  }

  test('secrets no key here opens: the error page, and every file stays as it was, at each start', async () => {
    const { profile, secret } = await setUp('kc8');
    const wrong = await anotherKey();
    setKeyInLocalState(profile, wrong);
    writeFileSync(savedFile(profile), wrong);
    for (let round = 0; round < 2; round += 1) {
      const app = await launch(profile, '--standalone');
      const page = await shownPage(app);
      await expect(page.locator('body')).toContainText("can't read its keys");
      await app.close();
      expect(readFileSync(secretFile(profile))).toEqual(secret);
      expect(readFileSync(savedFile(profile), 'utf8')).toBe(wrong);
    }
    removeProfile(profile);
  });

  test('a profile with no saved key yet gets one, once its secrets read', async () => {
    const { profile, saved } = await setUp('kc13');
    rmSync(savedFile(profile));
    const app = await launchStandalone(profile);
    await expectLogin(app.page);
    expect(readFileSync(savedFile(profile), 'utf8')).toBe(saved);
    await app.app.close();
    removeProfile(profile);
  });

  test('a profile with no saved key and secrets it cannot read saves none', async () => {
    const { profile } = await setUp('kc14');
    rmSync(savedFile(profile));
    setKeyInLocalState(profile, await anotherKey());
    const app = await launch(profile, '--standalone');
    const page = await shownPage(app);
    await expect(page.locator('body')).toContainText("can't read its keys");
    expect(existsSync(savedFile(profile))).toBe(false);
    await app.close();
    removeProfile(profile);
  });

  test('a certificate cut off by a kill is made anew, and the app starts', async () => {
    const { profile } = await setUp('kc9');
    writeFileSync(path.join(profile, 'keys', 'app-cert.pem'), '');
    await expectStartsAndKeepsItsKeys(profile);
    removeProfile(profile);
  });
});

test.describe('deciding before Chromium reads Local State', () => {
  const KEY = 'RFBBUElrZXk=';
  const OTHER = 'RFBBUElvdGhlcg==';

  function profileWith({ onDisk, saved, secret }: { onDisk?: string; saved?: string; secret?: boolean }): string {
    const profile = tempProfile('kc10');
    if (onDisk) writeFileSync(path.join(profile, 'Local State'), JSON.stringify({ other: 1, os_crypt: { encrypted_key: onDisk } }));
    mkdirSync(path.join(profile, 'keys'));
    if (saved) writeFileSync(savedFile(profile), saved);
    if (secret) writeFileSync(secretFile(profile), 'x');
    return profile;
  }

  function settle(profile: string): boolean {
    let ran = false;
    settleKeyBeforeChromium(profile, () => {
      ran = true;
    });
    return ran;
  }

  test('a new profile gets its key from the separate run', () => {
    const profile = profileWith({});
    expect(settle(profile)).toBe(true);
    removeProfile(profile);
  });

  test('a key that matches is left alone', () => {
    const profile = profileWith({ onDisk: KEY, saved: KEY, secret: true });
    const before = readFileSync(path.join(profile, 'Local State'));
    expect(settle(profile)).toBe(false);
    expect(readFileSync(path.join(profile, 'Local State'))).toEqual(before);
    removeProfile(profile);
  });

  test('a replaced key goes back over the new one, keeping the rest of Local State', () => {
    const profile = profileWith({ onDisk: OTHER, saved: KEY, secret: true });
    expect(settle(profile)).toBe(false);
    expect(keyOnDisk(profile)).toBe(KEY);
    expect(JSON.parse(readFileSync(path.join(profile, 'Local State'), 'utf8')).other).toBe(1);
    removeProfile(profile);
  });

  test('with only cookies under it, a replaced key stays', () => {
    const profile = profileWith({ onDisk: OTHER, saved: KEY });
    expect(settle(profile)).toBe(false);
    expect(keyOnDisk(profile)).toBe(OTHER);
    removeProfile(profile);
  });

  test('the app lock\'s records count as secrets', () => {
    const profile = profileWith({ onDisk: OTHER, saved: KEY });
    mkdirSync(path.join(profile, 'app-lock'));
    writeFileSync(path.join(profile, 'app-lock', 'gate.json'), '{}');
    expect(settle(profile)).toBe(false);
    expect(keyOnDisk(profile)).toBe(KEY);
    removeProfile(profile);
  });

  test('a lost key goes back even with no secrets', () => {
    const profile = profileWith({ saved: KEY });
    expect(settle(profile)).toBe(false);
    expect(keyOnDisk(profile)).toBe(KEY);
    removeProfile(profile);
  });
});

test.describe('a hard kill with an account signed in', () => {
  test.describe.configure({ timeout: 300_000 });
  test.skip(!ENT_PASSWORD, 'needs IT_ENT_PASSWORD, see requireAccount');

  async function signedInThenKilled(name: string, afterMs: number): Promise<string> {
    const profile = tempProfile(name);
    const first = await launchStandalone(profile);
    await signIn(first.page, STALWARTS[0].url, 'ent-dave@example.org', ENT_PASSWORD);
    await new Promise((resolve) => setTimeout(resolve, afterMs));
    await hardKill(first.app.process());
    return profile;
  }

  async function expectStillSignedIn(profile: string): Promise<void> {
    const app = await launch(profile, '--standalone');
    const page = await shownPage(app);
    await expectMailShown(page);
    await app.close();
  }

  for (const afterMs of [500, 3000]) {
    test(`${afterMs} ms after signing in on a new profile, the sign-in stays`, async () => {
      const profile = await signedInThenKilled('kc11', afterMs);
      await expectStillSignedIn(profile);
      removeProfile(profile);
    });
  }

  test('with Local State gone as well, the saved key keeps the sign-in', async () => {
    const profile = await signedInThenKilled('kc12', 3000);
    rmSync(path.join(profile, 'Local State'));
    await expectStillSignedIn(profile);
    removeProfile(profile);
  });
});

test.describe('the order of the writes', () => {
  test.describe.configure({ timeout: 120_000 });

  async function writesOfAStart(profile: string): Promise<string[]> {
    const log = path.join(tempProfile('kc15'), 'order.txt');
    const env: Record<string, string> = { BULWARK_TEST_WRITE_ORDER: log };
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
    const app = await electron.launch({
      args: ['-r', path.join(ROOT, 'test', 'support', 'write-order.cjs'), MAIN, `--bulwark-user-data=${profile}`, '--lang=en-US', '--standalone'],
      cwd: ROOT,
      env,
    });
    await expectLogin(await shownPage(app));
    await app.close();
    return readFileSync(log, 'utf8').trim().split('\n');
  }

  test('a first run has the key on disk and its copy saved before the first secret, and each secret is flushed', async () => {
    const profile = tempProfile('kc16');
    const lines = await writesOfAStart(profile);
    const saved = lines.findIndex((line) => line.startsWith('renameSync os-crypt-key.saved'));
    const secrets = lines.flatMap((line, index) => (/^renameSync .*\.bin /.test(line) ? [index] : []));
    expect(secrets.length).toBe(3);
    expect(saved).toBeGreaterThanOrEqual(0);
    for (const index of [saved, ...secrets]) {
      expect(lines[index], lines.join('\n')).toContain('key=true');
      expect(lines[index - 1], lines.join('\n')).toContain('fsyncSync');
    }
    expect(saved).toBeLessThan(secrets[0]);
    removeProfile(profile);
  });

  test('a replaced admin credential takes the old hash away first', async () => {
    const profile = tempProfile('kc17');
    const first = await launchStandalone(profile);
    await expectLogin(first.page);
    await first.app.close();
    writeFileSync(path.join(profile, 'keys', 'admin-credential.bin'), 'not what safeStorage wrote');
    const lines = await writesOfAStart(profile);
    const removed = lines.findIndex((line) => line.startsWith('rmSync admin.json'));
    const written = lines.findIndex((line) => line.startsWith('renameSync admin-credential.bin'));
    expect(removed, lines.join('\n')).toBeGreaterThanOrEqual(0);
    expect(written).toBeGreaterThan(removed);
    removeProfile(profile);
  });
});
