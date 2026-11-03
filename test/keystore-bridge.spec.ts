import { createHash, constants, publicEncrypt, randomBytes, verify, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { helperFile, loadHelperModule } from '../src/main/native-loader';
import { launchStandalone, removeProfile, tempProfile } from './helpers';
import { TestCerts, type TestCert } from './test-certs';

/** The helper in real Electron, through the real preload and IPC, from a real page. */

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIL = "-TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.4')";

type WireCertificate = { id: string; subject: string; certificate: number[]; constructorName: string; keyType: string };

test.describe('window.bulwarkDesktop.keystore', () => {
  test.skip(process.platform !== 'win32', 'creates certificates in CurrentUser\\My');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let certs: TestCerts;
  let rsa: TestCert;
  let ec: TestCert;
  let profile: string;
  let launched: Awaited<ReturnType<typeof launchStandalone>>;

  test.beforeAll(async () => {
    certs = new TestCerts();
    rsa = certs.create({ name: 'bridge-rsa', args: `-Type Custom -KeyExportPolicy NonExportable -KeyAlgorithm RSA -KeyLength 2048 -KeyUsage DigitalSignature,KeyEncipherment ${MAIL}` });
    ec = certs.create({ name: 'bridge-ec', args: `-Type Custom -KeyExportPolicy NonExportable -KeyAlgorithm ECDSA_nistP256 -CurveExport CurveName -KeyUsage DigitalSignature ${MAIL}` });
    profile = tempProfile('keystore');
    launched = await launchStandalone(profile);
  });

  test.afterAll(async () => {
    await launched?.app.close().catch(() => undefined);
    if (profile) removeProfile(profile);
    certs?.finish();
  });

  const listed = async (): Promise<WireCertificate[]> =>
    launched.page.evaluate(async () => {
      const list = await (window as never as { bulwarkDesktop: { keystore: { list(): Promise<Array<{ id: string; subject: string; certificate: Uint8Array; keyType: string }>> } } }).bulwarkDesktop.keystore.list();
      return list.map((entry) => ({
        id: entry.id,
        subject: entry.subject,
        keyType: entry.keyType,
        certificate: [...entry.certificate],
        constructorName: entry.certificate.constructor.name,
      }));
    });

  const call = (method: string, ...args: unknown[]) =>
    launched.page.evaluate(
      async ({ method, args }) => {
        const toBytes = (value: unknown) => (Array.isArray(value) ? new Uint8Array(value) : value);
        const keystore = (window as never as { bulwarkDesktop: { keystore: Record<string, (...a: unknown[]) => Promise<Uint8Array>> } }).bulwarkDesktop.keystore;
        try {
          const out = await keystore[method](...args.map(toBytes));
          return { ok: true as const, bytes: [...out], type: out.constructor.name };
        } catch (error) {
          return { ok: false as const, message: (error as Error).message };
        }
      },
      { method, args },
    );

  test('the member is this narrow, with no Hello or policy beside it', async () => {
    const shape = await launched.page.evaluate(() => {
      const bridge = (window as never as { bulwarkDesktop: Record<string, unknown> }).bulwarkDesktop;
      return { keystore: Object.keys(bridge.keystore as object).sort(), hello: 'hello' in bridge, policy: 'policy' in bridge };
    });
    expect(shape).toEqual({ keystore: ['agree', 'decrypt', 'list', 'sign'], hello: false, policy: false });
  });

  test('it signs in Electron through the bridge, and Node verifies it', async () => {
    const list = await listed();
    const entry = list.find((item) => item.subject === rsa.subject)!;
    expect(entry.constructorName).toBe('Uint8Array');
    const digest = [...createHash('sha256').update('bulwark').digest()];
    const answer = await call('sign', entry.id, digest, { scheme: 'rsa-pkcs1', hash: 'SHA-256' });
    if (!answer.ok) throw new Error(answer.message);
    expect(answer.type).toBe('Uint8Array');
    const key = new X509Certificate(Buffer.from(entry.certificate)).publicKey;
    expect(verify('sha256', Buffer.from('bulwark'), { key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(answer.bytes))).toBe(true);
  });

  test('ECDSA comes through as DER', async () => {
    const entry = (await listed()).find((item) => item.subject === ec.subject)!;
    const digest = [...createHash('sha256').update('bulwark').digest()];
    const answer = await call('sign', entry.id, digest, { scheme: 'ecdsa', hash: 'SHA-256' });
    if (!answer.ok) throw new Error(answer.message);
    const key = new X509Certificate(Buffer.from(entry.certificate)).publicKey;
    expect(verify('sha256', Buffer.from('bulwark'), { key, dsaEncoding: 'der' }, Buffer.from(answer.bytes))).toBe(true);
  });

  test('it decrypts through the bridge, with the OAEP hash the caller names', async () => {
    const entry = (await listed()).find((item) => item.subject === rsa.subject)!;
    const key = new X509Certificate(Buffer.from(entry.certificate)).publicKey;
    const plain = randomBytes(32);
    const data = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, plain);
    const answer = await call('decrypt', entry.id, [...data], { scheme: 'rsa-oaep', hash: 'SHA-1' });
    if (!answer.ok) throw new Error(answer.message);
    expect(Buffer.from(answer.bytes).equals(plain)).toBe(true);
  });

  test('errors reach the page as the bare code', async () => {
    const entry = (await listed()).find((item) => item.subject === rsa.subject)!;
    const scheme = { scheme: 'rsa-pkcs1', hash: 'SHA-256' };
    const digest = [...Buffer.alloc(32)];
    expect(await call('sign', '0'.repeat(64), digest, scheme)).toEqual({ ok: false, message: 'keystore:not-found' });
    expect(await call('sign', 'nope', digest, scheme)).toEqual({ ok: false, message: 'keystore:invalid' });
    expect(await call('sign', entry.id, [1, 2, 3], scheme)).toEqual({ ok: false, message: 'keystore:invalid' });
    expect(await call('sign', entry.id, digest, { scheme: 'ecdsa', hash: 'SHA-256' })).toEqual({ ok: false, message: 'keystore:unsupported' });
    expect(await call('sign', entry.id, 'not bytes', scheme)).toEqual({ ok: false, message: 'keystore:invalid' });
    expect(await call('sign', entry.id, digest, null)).toEqual({ ok: false, message: 'keystore:invalid' });
    expect(await call('decrypt', entry.id, [...Buffer.alloc(4096)], { scheme: 'rsa-pkcs1' })).toEqual({ ok: false, message: 'keystore:invalid' });
    // A real OS error passes as a code too, not as Electron's wrapped sentence.
    const data = publicEncrypt({ key: new X509Certificate(Buffer.from(entry.certificate)).publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, randomBytes(32));
    expect(await call('decrypt', entry.id, [...data], { scheme: 'rsa-oaep', hash: 'SHA-512' })).toEqual({ ok: false, message: 'keystore:failed' });
  });

  test('an untrusted plugin\'s kind of frame gets no bridge and can reach nothing', async () => {
    // The sandbox an untrusted plugin or a mail body runs in: scripts, no same origin.
    await launched.page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.name = 'keystore-test-frame';
      document.body.appendChild(frame);
    });
    await expect.poll(() => launched.page.frames().some((frame) => frame.name() === 'keystore-test-frame')).toBe(true);
    const frame = launched.page.frames().find((candidate) => candidate.name() === 'keystore-test-frame')!;
    const seen = await frame.evaluate(() => {
      let reached = 'blocked';
      try {
        reached = typeof (window.parent as never as { bulwarkDesktop: unknown }).bulwarkDesktop;
      } catch {
        // Cross-origin: the browser says no.
      }
      return { own: typeof (window as never as { bulwarkDesktop?: unknown }).bulwarkDesktop, parent: reached };
    });
    expect(seen).toEqual({ own: 'undefined', parent: 'blocked' });
  });

  test('a real Hello prompt times out, and its dialog goes away with it', async () => {
    // Shows a real prompt on the desktop for a few seconds: only when asked for.
    test.skip(!process.env.BULWARK_TEST_HELLO_PROMPT, 'set BULWARK_TEST_HELLO_PROMPT=1 to show a prompt');
    // The process, not its main window: a dialog left behind has no main window for a
    // moment after its operation ends, which looked like success. The broker exits only
    // once the dialog is really closed.
    const dialogs = () =>
      spawnSync('powershell.exe', ['-NoProfile', '-Command', '@(Get-Process CredentialUIBroker -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' }).stdout.trim();
    test.skip(dialogs() !== '0', 'someone else has a Windows Security dialog open');
    const handle = await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible());
      return window ? [...window.getNativeWindowHandle()] : null;
    });
    const file = helperFile({ packaged: false, mainDir: path.join(ROOT, 'dist'), platform: process.platform, arch: process.arch });
    const native = loadHelperModule(file)!;
    const asked = native.helloVerify('Bulwark test: this closes by itself', Buffer.from(handle!), 4000);
    // While it waits, the dialog is really there.
    await expect.poll(dialogs, { timeout: 3500, intervals: [200] }).toBe('1');
    expect(await asked).toBe('timeout');
    await expect.poll(dialogs, { timeout: 8000, intervals: [300] }).toBe('0');
  });
});

test.describe('without the helper', () => {
  test('the app starts, and the bridge has no keystore', async () => {
    test.setTimeout(240_000);
    const profile = tempProfile('nohelper');
    const launched = await launchStandalone(profile, '--bulwark-test-no-native');
    try {
      const member = await launched.page.evaluate(() => typeof (window as never as { bulwarkDesktop: { keystore?: unknown } }).bulwarkDesktop.keystore);
      expect(member).toBe('undefined');
      const platform = await launched.page.evaluate(() => (window as never as { bulwarkDesktop: { platform: string } }).bulwarkDesktop.platform);
      expect(platform).toBe(process.platform);
    } finally {
      await launched.app.close().catch(() => undefined);
      removeProfile(profile);
    }
  });
});

test('an old webmail asking a helper-less app gets the IPC refused, not a crash', async () => {
  test.setTimeout(240_000);
  const profile = tempProfile('nohelperipc');
  const launched = await launchStandalone(profile, '--bulwark-test-no-native');
  try {
    const handlers = await launched.app.evaluate(({ ipcMain }) => {
      const internal = ipcMain as unknown as { _invokeHandlers: Map<string, unknown> };
      return [...internal._invokeHandlers.keys()].filter((name) => name.startsWith('bulwark:keystore'));
    });
    expect(handlers).toEqual([]);
  } finally {
    await launched.app.close().catch(() => undefined);
    removeProfile(profile);
  }
});
