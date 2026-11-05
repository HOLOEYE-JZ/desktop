import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { fakeOsIntegration, realRegistrationSnapshot, removeProfile, shownPage, tempProfile } from './helpers';
import { makeThunderbirdProfile } from './fixtures/make-thunderbird-profile';

/**
 * The same way through a package: the worker comes out of app.asar, node:sqlite out of Electron
 * itself, the scheme is registered under the package's fuses, and the PST worker's script
 * comes out of server.asar. `npm run pack:test` first.
 */

const EXE = path.join(import.meta.dirname, '..', 'release', 'win-unpacked', 'Bulwark.exe');
const PST = path.join(import.meta.dirname, 'fixtures', 'Outlook.pst');

type Granted = { url: string; kind: string; folder: string[]; size: number };
type Scan = { ok: boolean; candidates: { handle: string; kind: string; folder: string[] }[]; books: { handle: string; contacts: number }[] };
type Grant = { ok: boolean; files: Granted[]; contacts: string[]; refused: string[] };

test.describe('local import in a packaged app', () => {
  test.skip(!existsSync(EXE), 'run `npm run pack:test` first');
  test.setTimeout(240_000);

  let base: string;
  let copy = '';
  let registration = '';
  let profile: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'bw-imppack-'));
    const fixture = makeThunderbirdProfile(base, 'PACK');
    const outlook = path.join(base, 'Documents', 'Outlook Files');
    mkdirSync(outlook, { recursive: true });
    copyFileSync(PST, path.join(outlook, 'Archive.pst'));
    profile = tempProfile('imppack');
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
    delete env.ELECTRON_RUN_AS_NODE;
    // A package takes no --standalone: the mode comes from its state, as after a first run.
    writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({ mode: 'standalone' }));
    // A test pack writes nothing of itself into the OS (os-rules.ts registersWithOs).
    registration = realRegistrationSnapshot();
    // Playwright needs the inspector fuse, off in a package. A copy has only that one flipped:
    // ASAR integrity and onlyLoadAppFromAsar stay on, so this is still a real package.
    copy = path.join(base, 'pkg');
    cpSync(path.dirname(EXE), copy, { recursive: true });
    const exe = path.join(copy, 'Bulwark.exe');
    await flipFuses(exe, { version: FuseVersion.V1, [FuseV1Options.EnableNodeCliInspectArguments]: true });
    app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${profile}`, '--lang=en-US'], env });
    page = await shownPage(app);
    await fakeOsIntegration(app, 0);
    await app.evaluate(
      ({ app: electronApp }, { appData, documents }) => {
        electronApp.setPath('appData', appData);
        electronApp.setPath('documents', documents);
      },
      { appData: fixture.appData, documents: path.join(base, 'Documents') },
    );
  });

  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    // A reg.exe the start left on its way could still write: give it the time, then look.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (copy) expect(realRegistrationSnapshot(), 'the user\'s Bulwark registration under HKCU').toBe(registration);
    if (profile) removeProfile(profile);
    if (base) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  test('it really is packaged, with the worker in app.asar and the server in server.asar', async () => {
    const facts = await app.evaluate(({ app: electronApp }) => {
      const { existsSync: exists } = process.getBuiltinModule('node:fs');
      const { join } = process.getBuiltinModule('node:path');
      return {
        packaged: electronApp.isPackaged,
        worker: exists(join(process.resourcesPath, 'app.asar', 'dist', 'import-worker.cjs')),
        server: exists(join(process.resourcesPath, 'server.asar')),
      };
    });
    expect(facts).toEqual({ packaged: true, worker: true, server: true });
  });

  let scan: Scan;

  test('the scan runs in the worker, and node:sqlite reads the address book there', async () => {
    scan = await page.evaluate(() => (window as never as { bulwarkDesktop: { localImport: { scan(): Promise<Scan> } } }).bulwarkDesktop.localImport.scan());
    expect(scan.ok).toBe(true);
    expect(scan.candidates.map((c) => `${c.kind}:${c.folder.join('/')}`)).toEqual(expect.arrayContaining(['mbox:Inbox', 'maildir:Maildir-PACK', 'mbox:Entwürfe-PACK/Grün', 'pst:']));
    expect(scan.books[0].contacts).toBe(2);
  });

  test('confirmed files read through the scheme, and the contacts come along', async () => {
    const grant = await page.evaluate(
      (handles) => (window as never as { bulwarkDesktop: { localImport: { grant(h: string[]): Promise<Grant> } } }).bulwarkDesktop.localImport.grant(handles),
      [...scan.candidates.map((c) => c.handle), scan.books[0].handle],
    );
    expect(grant.ok).toBe(true);
    expect(grant.refused).toEqual([]);
    expect(grant.contacts.join()).toContain('ada-PACK@example.org');

    const inbox = grant.files.find((f) => f.folder[0] === 'Inbox')!;
    const range = await page.evaluate(async (url) => {
      const response = await fetch(url, { headers: { Range: 'bytes=0-4' } });
      return { status: response.status, text: await response.text() };
    }, inbox.url);
    expect(range).toEqual({ status: 206, text: 'From ' });

    const maildir = grant.files.find((f) => f.kind === 'maildir')!;
    const first = await page.evaluate(async (url) => (await (await fetch(`${url}/0`)).text()).slice(0, 11), maildir.url);
    expect(first).toBe('Message-ID:');

    const pst = grant.files.find((f) => f.kind === 'pst')!;
    const read = await page.evaluate(
      ({ url, size }) =>
        new Promise<{ total?: number; error?: string }>((resolve) => {
          const worker = new Worker('/pst-worker.js');
          worker.onerror = (event) => resolve({ error: event.message });
          worker.onmessage = (event: MessageEvent) => {
            const data = event.data as { type: string; total?: number; message?: string };
            resolve(data.type === 'opened' ? { total: data.total } : { error: data.message ?? data.type });
            worker.terminate();
          };
          worker.postMessage({ type: 'open', range: { url, size }, skipBefore: 0, skipAlso: [] });
        }),
      { url: pst.url, size: pst.size },
    );
    expect(read.error).toBeUndefined();
    expect(read.total).toBeGreaterThan(0);
  });
});
