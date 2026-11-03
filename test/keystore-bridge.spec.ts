import { createHash, constants, publicEncrypt, randomBytes, verify, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { helperFile, loadHelperModule } from '../src/main/native-loader';
import { APP_ORIGIN, fakeOsIntegration, launchStandalone, prompts, removeProfile, tempProfile } from './helpers';
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
    // These tests are about what passes once allowed: first button, for this session.
    await fakeOsIntegration(launched.app, 0);
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
    expect(shape).toEqual({ keystore: ['accessState', 'agree', 'decrypt', 'list', 'revokeAccess', 'sign'], hello: false, policy: false });
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

  test('main refuses a call whose sender is a subframe or off origin, on every channel', async () => {
    // Preloads don't run in subframes, so no page can send this. It calls the real
    // handler with a real subframe as the sender, which is what senderAllowed sees.
    await launched.page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.name = 'keystore-test-frame';
      document.body.appendChild(frame);
    });
    const answers = await launched.app.evaluate(async ({ ipcMain, BrowserWindow }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible())!;
      const main = window.webContents.mainFrame;
      const sub = main.frames.find((frame) => frame.name === 'keystore-test-frame')!;
      const channels = [...handlers.keys()].filter((name) => name.startsWith('bulwark:keystore'));
      const attempt = async (channel: string, senderFrame: unknown) => {
        try {
          await handlers.get(channel)!({ senderFrame, sender: window.webContents }, 'id', new Uint8Array(32), { scheme: 'ecdsa', hash: 'SHA-256' });
          return 'answered';
        } catch (error) {
          return (error as Error).message;
        }
      };
      const out: Record<string, string[]> = {};
      for (const channel of channels) {
        out[channel] = [await attempt(channel, sub), await attempt(channel, null), await attempt(channel, { parent: null, url: 'https://elsewhere.example/' }), await attempt(channel, main)];
      }
      return out;
    });
    expect(Object.keys(answers).sort()).toEqual(['access', 'agree', 'decrypt', 'list', 'revoke', 'sign'].map((name) => `bulwark:keystore.${name}`));
    for (const [channel, [subframe, none, offOrigin, mainFrame]] of Object.entries(answers)) {
      expect(subframe, channel).toBe('Not allowed');
      expect(none, channel).toBe('Not allowed');
      expect(offOrigin, channel).toBe('Not allowed');
      expect(mainFrame, `${channel}: the same call from the main frame gets through`).toBe('answered');
    }
  });

  test('an untrusted plugin\'s kind of frame gets no bridge and can reach nothing', async () => {
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

test.describe('consent, in main, whoever calls', () => {
  test.skip(process.platform !== 'win32', 'creates certificates in CurrentUser\\My');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  // Button indexes in the native dialog: session, once, deny.
  const SESSION = 0;
  const ONCE = 1;
  const DENY = 2;

  let certs: TestCerts;
  let cert: TestCert;
  let profile: string;
  let launched: Awaited<ReturnType<typeof launchStandalone>>;

  /** The way a privileged plugin can: script in a same-origin frame, through `parent`. */
  const viaParent = (method: string, ...args: unknown[]) =>
    launched.page.evaluate(
      async ({ method, args }) => {
        let frame = document.getElementById('same-origin-test-frame') as HTMLIFrameElement | null;
        if (!frame) {
          frame = document.createElement('iframe');
          frame.id = 'same-origin-test-frame';
          document.body.appendChild(frame);
        }
        const inFrame = frame.contentWindow as unknown as { parent: { bulwarkDesktop: { keystore: Record<string, (...a: unknown[]) => Promise<unknown>> } } };
        const toBytes = (value: unknown) => (Array.isArray(value) ? new Uint8Array(value) : value);
        try {
          const out = await inFrame.parent.bulwarkDesktop.keystore[method](...args.map(toBytes));
          return { ok: true as const, out: out instanceof Uint8Array ? [...out] : (out as Array<{ id: string; subject: string; certificate: Uint8Array }>).map((item) => ({ id: item.id, subject: item.subject, certificate: [...item.certificate] })) };
        } catch (error) {
          return { ok: false as const, message: (error as Error).message };
        }
      },
      { method, args },
    );

  const askedCount = async () => (await prompts(launched.app)).length;

  test.beforeAll(async () => {
    certs = new TestCerts();
    cert = certs.create({ name: 'consent-rsa', args: `-Type Custom -KeyExportPolicy NonExportable -KeyAlgorithm RSA -KeyLength 2048 -KeyUsage DigitalSignature,KeyEncipherment ${MAIL}` });
    profile = tempProfile('consent');
    launched = await launchStandalone(profile);
  });

  test.afterAll(async () => {
    await launched?.app.close().catch(() => undefined);
    if (profile) removeProfile(profile);
    certs?.finish();
  });

  test('list through parent gets the native prompt, and Deny refuses and sticks with no second dialog', async () => {
    await fakeOsIntegration(launched.app, DENY);
    expect(await viaParent('list')).toEqual({ ok: false, message: 'keystore:cancelled' });
    const asked = await prompts(launched.app);
    expect(asked).toHaveLength(1);
    expect(`${asked[0].message} ${asked[0].detail}`).toContain(new URL(APP_ORIGIN).host);
    const shown = asked[0] as unknown as { buttons: string[]; defaultId: number; cancelId: number };
    expect(shown.buttons).toHaveLength(3);
    expect(shown.defaultId, 'Deny is the default').toBe(DENY);
    expect(shown.cancelId, 'closing the dialog is Deny').toBe(DENY);

    expect(await viaParent('list')).toEqual({ ok: false, message: 'keystore:cancelled' });
    expect(await viaParent('list')).toEqual({ ok: false, message: 'keystore:cancelled' });
    expect(await askedCount(), 'no dialog storm').toBe(1);
  });

  test('a stuck Deny lasts until the app quits', async () => {
    await launched.app.close();
    launched = await launchStandalone(profile);
    await fakeOsIntegration(launched.app, SESSION);
    const listed = await viaParent('list');
    expect(listed.ok).toBe(true);
    expect(await askedCount()).toBe(1);
  });

  test('a session grant for the list asks no more, and says nothing about using a key', async () => {
    await viaParent('list');
    expect(await askedCount(), 'the list is granted').toBe(1);

    await fakeOsIntegration(launched.app, DENY);
    const list = await viaParent('list');
    const entry = (list.ok ? (list.out as Array<{ id: string; subject: string }>) : []).find((item) => item.subject === cert.subject)!;
    const digest = [...createHash('sha256').update('bulwark').digest()];
    const scheme = { scheme: 'rsa-pkcs1', hash: 'SHA-256' };
    expect(await viaParent('sign', entry.id, digest, scheme)).toEqual({ ok: false, message: 'keystore:cancelled' });
    const asked = await prompts(launched.app);
    expect(asked).toHaveLength(1);
    expect(`${asked[0].message} ${asked[0].detail}`, 'it names the certificate').toContain('consent-rsa');
    expect(await viaParent('sign', entry.id, digest, scheme)).toEqual({ ok: false, message: 'keystore:cancelled' });
    expect(await askedCount(), 'sign stays denied without asking').toBe(1);
  });

  test('sign and unwrap are separate grants, and Allow once is once', async () => {
    await fakeOsIntegration(launched.app, ONCE);
    const list = await viaParent('list');
    const entry = (list.ok ? (list.out as Array<{ id: string; subject: string; certificate: number[] }>) : []).find((item) => item.subject === cert.subject)!;
    const key = new X509Certificate(Buffer.from(entry.certificate)).publicKey;
    const plain = randomBytes(32);
    const data = [...publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, plain)];
    const scheme = { scheme: 'rsa-oaep', hash: 'SHA-256' };

    const first = await viaParent('decrypt', entry.id, data, scheme);
    expect(first.ok && Buffer.from(first.out as number[]).equals(plain)).toBe(true);
    expect(await askedCount()).toBe(1);
    const second = await viaParent('decrypt', entry.id, data, scheme);
    expect(second.ok).toBe(true);
    expect(await askedCount(), 'once means once').toBe(2);
  });

  test('a session grant holds until the screen locks, and the lock clears it', async () => {
    await fakeOsIntegration(launched.app, SESSION);
    const list = await viaParent('list');
    const entry = (list.ok ? (list.out as Array<{ id: string; subject: string; certificate: number[] }>) : []).find((item) => item.subject === cert.subject)!;
    const key = new X509Certificate(Buffer.from(entry.certificate)).publicKey;
    const data = [...publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, randomBytes(32))];
    const scheme = { scheme: 'rsa-oaep', hash: 'SHA-256' };
    expect((await viaParent('decrypt', entry.id, data, scheme)).ok).toBe(true);
    expect(await askedCount()).toBe(1);
    expect((await viaParent('decrypt', entry.id, data, scheme)).ok).toBe(true);
    expect(await askedCount(), 'granted for the session').toBe(1);

    await launched.app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('lock-screen');
    });
    expect((await viaParent('decrypt', entry.id, data, scheme)).ok).toBe(true);
    expect(await askedCount(), 'the lock took the grant').toBe(2);
    expect((await viaParent('list')).ok).toBe(true);
    expect(await askedCount(), 'the list grant too').toBe(3);
  });
});

test('without the helper no keystore channel exists in main, and with it there are six', async () => {
  test.setTimeout(240_000);
  const handlers = async (...args: string[]) => {
    const profile = tempProfile('channels');
    const launched = await launchStandalone(profile, ...args);
    try {
      return await launched.app.evaluate(({ ipcMain }) => {
        const internal = ipcMain as unknown as { _invokeHandlers: Map<string, unknown> };
        return [...internal._invokeHandlers.keys()].filter((name) => name.startsWith('bulwark:keystore')).length;
      });
    } finally {
      await launched.app.close().catch(() => undefined);
      removeProfile(profile);
    }
  };
  expect(await handlers('--bulwark-test-no-native')).toBe(0);
  // So the zero above can be wrong. Off Windows and macOS there's no keystore to offer.
  if (process.platform === 'win32') expect(await handlers()).toBe(6);
});
