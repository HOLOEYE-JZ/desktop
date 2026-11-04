/**
 * Hard kills of the real app on a new profile, in a loop over the first seconds. Chromium only
 * writes Local State, which holds the key safeStorage encrypts with, ten seconds after a first
 * start. Whatever the moment of the kill, the next start has to come up.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { certificateFitsKey, generateCertificate } from '../src/main/cert';
import { KEY_CHECK_SWITCH, KEY_INIT_SWITCH, keyInitArgs, keyOnDisk, keyOpens, savedKey, settleKeyBeforeChromium } from '../src/main/key-on-disk';
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

/** Windows lets go of a killed process's files a moment later, and a start before that gives up on the lock. */
async function waitForProfileFree(profile: string): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          rmSync(path.join(profile, 'lockfile'), { force: true });
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15_000, intervals: [100] },
    )
    .toBe(true);
}

async function runThenKill(profile: string, afterMs: number, ...args: string[]): Promise<void> {
  const child = start(profile, ...args);
  await new Promise((resolve) => setTimeout(resolve, afterMs));
  await hardKill(child);
  await waitForProfileFree(profile);
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

  for (const afterMs of [1000, 3000, 5000, 7000]) {
    test(`a hard kill after ${afterMs} ms leaves no secret behind, and the next start comes up`, async () => {
      const profile = tempProfile('kc4');
      await runThenKill(profile, afterMs, '--standalone', '--bulwark-test-no-key-init');
      // Well before Chromium's ten seconds: the key is only in memory, and nothing is under it.
      expect(keyOnDisk(profile)).toBeNull();
      expect(existsSync(secretFile(profile))).toBe(false);
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
    await expect(page.locator('body')).toContainText(/free space/);
    await expect(page.locator('body')).toContainText(/permission/);
    await expect(page.locator('body')).toContainText(/antivirus/);
    expect(existsSync(secretFile(profile))).toBe(false);
    await app.close();
    removeProfile(profile);
  });
});

/** As a profile copied to another Windows user, or after a password reset, has it. */
const NO_OPEN = Buffer.from('DPAPInot a blob').toString('base64');

function plantKeyThatWontOpen(profile: string, { saved = true, secret = false } = {}): void {
  writeFileSync(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: NO_OPEN, audit_enabled: true } }));
  mkdirSync(path.join(profile, 'keys'), { recursive: true });
  if (saved) writeFileSync(savedFile(profile), NO_OPEN);
  if (secret) writeFileSync(secretFile(profile), 'x');
}

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

  for (const withSaved of [true, false]) {
    test(`no secrets yet, a key DPAPI will not open, ${withSaved ? 'also the saved one' : 'nothing saved'}: every start comes up`, async () => {
      const profile = tempProfile('kc18');
      plantKeyThatWontOpen(profile, { saved: withSaved });
      await expectStartsAndKeepsItsKeys(profile);
      const key = keyOnDisk(profile);
      expect(key).not.toBe(NO_OPEN);
      expect(savedKey(profile)).toBe(key);
      await expectStartsAndKeepsItsKeys(profile);
      expect(keyOnDisk(profile)).toBe(key);
      removeProfile(profile);
    });
  }

  for (const afterMs of [1000, 3000, 6000]) {
    test(`no secrets yet, a key DPAPI will not open, a hard kill after ${afterMs} ms: the next start comes up`, async () => {
      const profile = tempProfile('kc31');
      plantKeyThatWontOpen(profile);
      await runThenKill(profile, afterMs, '--standalone');
      await expectStartsAndKeepsItsKeys(profile);
      removeProfile(profile);
    });
  }

  test('a saved key DPAPI will not open is not put back over the key in use, and stays for when it opens again', async () => {
    const { profile, secret } = await setUp('kc19');
    const other = await anotherKey();
    setKeyInLocalState(profile, other);
    writeFileSync(savedFile(profile), NO_OPEN);
    const app = await launch(profile, '--standalone');
    const page = await shownPage(app);
    await expect(page.locator('body')).toContainText("can't read its keys");
    await app.close();
    expect(keyOnDisk(profile)).toBe(other);
    expect(readFileSync(savedFile(profile), 'utf8')).toBe(NO_OPEN);
    expect(readFileSync(secretFile(profile))).toEqual(secret);
    expect(existsSync(path.join(profile, 'key-check'))).toBe(false);
    removeProfile(profile);
  });

  test('a saved key that opens goes back whatever replaced it, so secrets return with DPAPI', async () => {
    const { profile, secret, saved } = await setUp('kc20');
    setKeyInLocalState(profile, await anotherKey());
    const app = await launchStandalone(profile);
    await expectLogin(app.page);
    await app.app.close();
    expect(keyOnDisk(profile)).toBe(saved);
    expect(readFileSync(secretFile(profile))).toEqual(secret);
    removeProfile(profile);
  });

  test('a saved copy that cannot be written stops a start that needs secrets', async () => {
    const profile = tempProfile('kc21');
    mkdirSync(path.join(savedFile(profile), 'in-the-way'), { recursive: true });
    const app = await launch(profile, '--standalone');
    const page = await shownPage(app);
    await expect(page.locator('body')).toContainText("couldn't save its key");
    expect(existsSync(secretFile(profile))).toBe(false);
    await app.close();
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

test.describe('a certificate and its key', () => {
  const one = generateCertificate('app.bulwark.localhost');
  const other = generateCertificate('app.bulwark.localhost');

  test('fit when they belong together', () => {
    expect(certificateFitsKey(one.certPem, one.keyPem)).toBe(true);
  });

  test('do not fit from different rounds, or with a damaged half', () => {
    expect(certificateFitsKey(one.certPem, other.keyPem)).toBe(false);
    expect(certificateFitsKey('', one.keyPem)).toBe(false);
    expect(certificateFitsKey(one.certPem, '')).toBe(false);
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

  /** Whether the clean run on the profile was asked for. */
  function settle(profile: string, { opens = true, firstSecretsMayFollow = false } = {}): boolean {
    let ran = false;
    settleKeyBeforeChromium(profile, {
      runKeyInit: () => {
        ran = true;
      },
      keyOpens: () => opens,
      firstSecretsMayFollow,
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

  test('with only cookies under it, a replaced key stays, and gets proved', () => {
    const profile = profileWith({ onDisk: OTHER, saved: KEY });
    expect(settle(profile)).toBe(true);
    expect(keyOnDisk(profile)).toBe(OTHER);
    removeProfile(profile);
  });

  test('a saved key that will not open stays out, with secrets as well', () => {
    const profile = profileWith({ onDisk: OTHER, saved: KEY, secret: true });
    expect(settle(profile, { opens: false })).toBe(false);
    expect(keyOnDisk(profile)).toBe(OTHER);
    removeProfile(profile);
  });

  test('a lost key that will not open is made anew', () => {
    const profile = profileWith({ saved: KEY, secret: true });
    expect(settle(profile, { opens: false })).toBe(true);
    expect(keyOnDisk(profile)).toBeNull();
    removeProfile(profile);
  });

  test('a start that may write first secrets proves the key first, also one that matches', () => {
    const profile = profileWith({ onDisk: KEY, saved: KEY });
    expect(settle(profile, { firstSecretsMayFollow: true })).toBe(true);
    removeProfile(profile);
  });

  test('a start with secrets needs no such run', () => {
    const profile = profileWith({ onDisk: KEY, saved: KEY, secret: true });
    expect(settle(profile, { firstSecretsMayFollow: true })).toBe(false);
    removeProfile(profile);
  });

  test('an ordinary start in instance mode costs no run', () => {
    const profile = profileWith({ onDisk: KEY, saved: KEY });
    expect(settle(profile)).toBe(false);
    removeProfile(profile);
  });

  test('a key the check leaves alone opens, one it replaces does not, and the folder goes', () => {
    const profile = profileWith({});
    const folder = path.join(profile, 'key-check');
    expect(keyOpens(profile, KEY, () => {})).toBe(true);
    expect(existsSync(folder)).toBe(false);
    const replacing = () => writeFileSync(path.join(folder, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: OTHER } }));
    expect(keyOpens(profile, KEY, replacing)).toBe(false);
    expect(existsSync(folder)).toBe(false);
    removeProfile(profile);
  });

  test('the separate run is started with the profile and its own switch, and nothing else', () => {
    const argv = ['app.exe', 'main.mjs', '--bulwark-user-data=C:\\p', '--lang=en-US', '--standalone', '--remote-debugging-port=0'];
    expect(keyInitArgs(argv, false, 'C:\\app\\main.mjs', KEY_INIT_SWITCH, '--bulwark-user-data=')).toEqual(['C:\\app\\main.mjs', '--bulwark-user-data=C:\\p', KEY_INIT_SWITCH]);
    expect(keyInitArgs(argv, false, 'C:\\app\\main.mjs', KEY_CHECK_SWITCH, '--bulwark-user-data=')).toEqual(['C:\\app\\main.mjs', '--bulwark-user-data=C:\\p', KEY_CHECK_SWITCH]);
    // A build without the test code has no such switch to pass on.
    expect(keyInitArgs(argv, false, 'C:\\app\\main.mjs', KEY_INIT_SWITCH)).toEqual(['C:\\app\\main.mjs', KEY_INIT_SWITCH]);
  });

  test('a package names no script: Electron would take it for the app', () => {
    expect(keyInitArgs(['Bulwark.exe'], true, 'C:\\app\\main.mjs', KEY_INIT_SWITCH)).toEqual([KEY_INIT_SWITCH]);
    expect(keyInitArgs(['Bulwark.exe', 'x.eml', '--hidden'], true, 'C:\\app\\main.mjs', KEY_CHECK_SWITCH)).toEqual([KEY_CHECK_SWITCH]);
    // A test package takes this one, and its separate run has to land in the same place.
    expect(keyInitArgs(['Bulwark.exe', '--user-data-dir=C:\\t'], true, 'C:\\app\\main.mjs', KEY_INIT_SWITCH)).toEqual(['--user-data-dir=C:\\t', KEY_INIT_SWITCH]);
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

/**
 * Stock electron.exe has the cookie fuse off, so its cookies are plain text and no key can lose
 * them. These run on a copy with the fuse on, as in a real package.
 */
test.describe('cookies under the key', () => {
  test.describe.configure({ timeout: 300_000 });

  const INSTANCE = 'https://mail.example.org';
  const PARTITION = `persist:instance-${Buffer.from(INSTANCE).toString('base64url')}`;
  const VALUE = 'bw-cookie-marker';
  let fused = '';
  let fusedDir = '';

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    fusedDir = mkdtempSync(path.join(tmpdir(), 'bw-fused-'));
    cpSync(path.dirname(ELECTRON), fusedDir, { recursive: true });
    fused = path.join(fusedDir, 'electron.exe');
    await flipFuses(fused, { version: FuseVersion.V1, [FuseV1Options.EnableCookieEncryption]: true });
  });

  test.afterAll(() => removeProfile(fusedDir));

  function launchFused(profile: string, ...args: string[]): Promise<ElectronApplication> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
    return electron.launch({ executablePath: fused, args: [MAIN, `--bulwark-user-data=${profile}`, '--lang=en-US', ...args], cwd: ROOT, env });
  }

  /** A start in instance mode. What it read of the cookie, and it sets the cookie if told to. */
  async function instanceStart(profile: string, { set = false, prompts = '' } = {}): Promise<{ app: ElectronApplication; cookies: string[] }> {
    const env: Record<string, string> = { BULWARK_TEST_PROMPTS: prompts };
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
    const hook = prompts ? ['-r', path.join(ROOT, 'test', 'support', 'record-prompts.cjs')] : [];
    const app = await electron.launch({ executablePath: fused, args: [...hook, MAIN, `--bulwark-user-data=${profile}`, '--lang=en-US', `--instance=${INSTANCE}`], cwd: ROOT, env });
    await shownPage(app);
    const cookies = await app.evaluate(
      async ({ session }, { partition, url, value, set: setIt }) => {
        const jar = session.fromPartition(partition).cookies;
        const before = (await jar.get({ name: 'sid' })).map((cookie) => cookie.value);
        if (setIt) {
          await jar.set({ url, name: 'sid', value, expirationDate: Math.floor(Date.now() / 1000) + 86400, secure: true });
          await jar.flushStore();
        }
        return before;
      },
      { partition: PARTITION, url: `${INSTANCE}/`, value: VALUE, set },
    );
    return { app, cookies };
  }

  function promptsIn(file: string): string[] {
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
  }

  test('the copy really encrypts them', async () => {
    const profile = tempProfile('kc22');
    const { app } = await instanceStart(profile, { set: true });
    await app.close();
    const jar = readFileSync(path.join(profile, 'Partitions', PARTITION.slice('persist:'.length), 'Network', 'Cookies'));
    expect(jar.includes('sid')).toBe(true);
    expect(jar.includes(VALUE)).toBe(false);
    removeProfile(profile);
  });

  test('with Local State gone, the saved key keeps a cookie readable', async () => {
    const profile = tempProfile('kc23');
    const first = await instanceStart(profile, { set: true });
    await first.app.close();
    rmSync(path.join(profile, 'Local State'));
    const second = await instanceStart(profile);
    expect(second.cookies).toEqual([VALUE]);
    await second.app.close();
    removeProfile(profile);
  });

  // With secrets the old copy stays, for the day DPAPI opens it again. With none it follows.
  const leftovers: [string, boolean, (profile: string) => void][] = [
    ['no secrets', false, () => {}],
    ['a leftover secret', true, (profile) => writeFileSync(secretFile(profile), 'x')],
    ['the app lock\'s folder', true, (profile) => {
      mkdirSync(path.join(profile, 'app-lock'));
      writeFileSync(path.join(profile, 'app-lock', 'gate.json'), '{}');
    }],
  ];
  for (const [what, keepsCopy, leave] of leftovers) {
    test(`a key DPAPI will not open, with ${what}: one new sign-in lasts, and the user is told once`, async () => {
      const profile = tempProfile('kc24');
      const prompts = path.join(tempProfile('kc25'), 'prompts.txt');
      plantKeyThatWontOpen(profile);
      leave(profile);

      // The start that finds out: told while it runs, as soon as Chromium's new key reaches the disk.
      const first = await instanceStart(profile, { set: true, prompts });
      await expect.poll(() => promptsIn(prompts), { timeout: 40_000, intervals: [500] }).toEqual(['Please sign in again']);
      await first.app.close();
      const key = keyOnDisk(profile);
      expect(key).not.toBe(NO_OPEN);

      for (let start = 0; start < 2; start += 1) {
        const next = await instanceStart(profile, { prompts });
        expect(next.cookies).toEqual([VALUE]);
        await next.app.close();
        expect(keyOnDisk(profile)).toBe(key);
      }
      expect(promptsIn(prompts)).toEqual(['Please sign in again']);
      expect(savedKey(profile)).toBe(keepsCopy ? NO_OPEN : key);
      expect(existsSync(path.join(profile, 'key-check'))).toBe(false);
      removeProfile(profile);
      removeProfile(path.dirname(prompts));
    });
  }

  test('quit before Chromium\'s ten seconds, the next start tells, and the saved key follows the new one', async () => {
    const profile = tempProfile('kc26');
    const prompts = path.join(tempProfile('kc27'), 'prompts.txt');
    plantKeyThatWontOpen(profile);
    const first = await instanceStart(profile, { prompts });
    await first.app.close();
    expect(promptsIn(prompts)).toEqual([]);
    const key = keyOnDisk(profile);
    expect(key).not.toBe(NO_OPEN);

    const second = await instanceStart(profile, { prompts });
    expect(promptsIn(prompts)).toEqual(['Please sign in again']);
    expect(savedKey(profile)).toBe(key);
    await second.app.close();
    removeProfile(profile);
    removeProfile(path.dirname(prompts));
  });

  test('an ordinary start in instance mode tells nobody anything', async () => {
    const profile = tempProfile('kc28');
    const prompts = path.join(tempProfile('kc29'), 'prompts.txt');
    const first = await instanceStart(profile, { set: true, prompts });
    await new Promise((resolve) => setTimeout(resolve, 13_000));
    await first.app.close();
    const second = await instanceStart(profile, { prompts });
    expect(second.cookies).toEqual([VALUE]);
    await second.app.close();
    expect(promptsIn(prompts)).toEqual([]);
    removeProfile(profile);
    removeProfile(path.dirname(prompts));
  });

  test('a saved copy that cannot be written costs instance mode no page', async () => {
    const profile = tempProfile('kc30');
    mkdirSync(path.join(savedFile(profile), 'in-the-way'), { recursive: true });
    const { app, cookies } = await instanceStart(profile);
    expect(cookies).toEqual([]);
    const pages = await Promise.all(app.windows().map((page) => page.locator('body').innerText().catch(() => '')));
    expect(pages.join('\n')).not.toContain("couldn't save its key");
    await app.close();
    removeProfile(profile);
  });

  test.describe('with an account signed in', () => {
    test.skip(!ENT_PASSWORD, 'needs IT_ENT_PASSWORD, see requireAccount');

    async function signedInThenKilled(name: string, afterMs: number): Promise<string> {
      const profile = tempProfile(name);
      const first = await launchFused(profile, '--standalone');
      await signIn(await shownPage(first), STALWARTS[0].url, 'ent-dave@example.org', ENT_PASSWORD);
      await new Promise((resolve) => setTimeout(resolve, afterMs));
      await hardKill(first.process());
      await waitForProfileFree(profile);
      return profile;
    }

    async function expectStillSignedIn(profile: string): Promise<void> {
      const app = await launchFused(profile, '--standalone');
      const page = await shownPage(app);
      await expectMailShown(page);
      await app.close();
    }

    for (const afterMs of [500, 3000]) {
      test(`a hard kill ${afterMs} ms after signing in on a new profile keeps the sign-in`, async () => {
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
