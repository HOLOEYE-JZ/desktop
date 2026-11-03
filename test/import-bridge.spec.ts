import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { fakeOsIntegration, launchStandalone, prompts, removeProfile, tempProfile } from './helpers';
import { makeThunderbirdProfile, type FixtureProfile } from './fixtures/make-thunderbird-profile';

/** The bridge in real Electron, through the real preload, IPC and scheme, from the real page and its CSP. */

const PST = path.join(import.meta.dirname, 'fixtures', 'Outlook.pst');

type Result = { ok: boolean; reason?: string; [key: string]: unknown };
type Candidate = { handle: string; kind: string; folder: string[]; name: string; size: number };
type Scan = Result & { candidates: Candidate[]; books: { handle: string; contacts: number }[]; refused: { name: string; reason: string }[]; calendars: number; thunderbirdRunning: boolean };
type Granted = { url: string; name: string; kind: string; folder: string[]; size: number; entrySizes?: number[] };
type Grant = Result & { jobId: string; files: Granted[]; contacts: string[]; refused: string[] };

const bridgeCall = <T>(page: Page, method: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    ({ method, args }) => (window as never as { bulwarkDesktop: { localImport: Record<string, (...a: unknown[]) => Promise<unknown>> } }).bulwarkDesktop.localImport[method](...args),
    { method, args },
  ) as Promise<T>;

const readRange = (page: Page, url: string, start: number, end: number) =>
  page.evaluate(
    async ({ url, start, end }) => {
      try {
        const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
        return { status: response.status, text: new TextDecoder('latin1').decode(await response.arrayBuffer()) };
      } catch (error) {
        return { status: 0, text: String(error) };
      }
    },
    { url, start, end },
  );

const answer = (app: ElectronApplication, response: number) =>
  app.evaluate(({ dialog }, value) => {
    const g = globalThis as unknown as { __prompts: unknown[] };
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.__prompts.push(args[args.length - 1]);
      return { response: value, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, response);

test.describe('window.bulwarkDesktop.localImport', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let base: string;
  let fixture: FixtureProfile;
  let profile: string;
  let app: ElectronApplication;
  let page: Page;
  let outlook: string;

  /** Points the app's idea of this user's folders at the fixture. No switch in the app does this. */
  const pointAtFixture = () =>
    app.evaluate(
      ({ app: electronApp }, { appData, documents, local }) => {
        electronApp.setPath('appData', appData);
        electronApp.setPath('documents', documents);
        process.env.LOCALAPPDATA = local;
      },
      { appData: fixture.appData, documents: path.join(base, 'Documents'), local: path.join(base, 'Local') },
    );

  test.beforeAll(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'bw-imp-'));
    fixture = makeThunderbirdProfile(base, 'BRIDGE');
    outlook = path.join(base, 'Documents', 'Outlook Files');
    mkdirSync(outlook, { recursive: true });
    copyFileSync(PST, path.join(outlook, 'Archive.pst'));
    const local = path.join(base, 'Local', 'Microsoft', 'Outlook');
    mkdirSync(local, { recursive: true });
    writeFileSync(path.join(local, 'me@example.org.ost'), readFileSync(PST));
    profile = tempProfile('import');
    ({ app, page } = await launchStandalone(profile));
    await fakeOsIntegration(app, 0);
    await pointAtFixture();
  });

  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    removeProfile(profile);
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  test('nothing is looked at without a yes in main', async () => {
    await answer(app, 1);
    const before = (await prompts(app)).length;
    const result = await bridgeCall<Result>(page, 'scan');
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(JSON.stringify(result)).not.toContain('Inbox');
    const asked = (await prompts(app)).slice(before);
    expect(asked).toHaveLength(1);
    expect(asked[0].message).toContain('app.bulwark.localhost');
    // The right after a no: no second dialog to nag with.
    expect(await bridgeCall<Result>(page, 'scan')).toEqual({ ok: false, reason: 'declined' });
    expect((await prompts(app)).length).toBe(before + 1);
    await page.waitForTimeout(5200);
  });

  let scan: Scan;

  test('a yes lists what is there as opaque handles, with no path in it', async () => {
    await answer(app, 0);
    scan = await bridgeCall<Scan>(page, 'scan');
    expect(scan.ok).toBe(true);
    const folders = scan.candidates.map((c) => `${c.kind}:${c.folder.join('/')}`).sort();
    expect(folders).toEqual(['maildir:Maildir-BRIDGE', 'mbox:Drafts', 'mbox:Entwürfe-BRIDGE', 'mbox:Entwürfe-BRIDGE/Grün', 'mbox:Fixture-BRIDGE', 'mbox:Fixture-BRIDGE/Year 2020', 'mbox:Inbox', 'mbox:Sent', 'pst:']);
    expect(scan.refused).toEqual([{ name: 'me@example.org.ost', reason: 'ost' }]);
    expect(scan.calendars).toBe(1);
    expect(scan.books[0].contacts).toBe(2);
    expect(scan.thunderbirdRunning).toBe(false);
    const wire = JSON.stringify(scan);
    expect(wire).not.toContain(base.replaceAll('\\', '\\\\'));
    expect(wire).not.toContain('Profiles');
    for (const candidate of scan.candidates) expect(candidate.handle).toMatch(/^[\w-]{22}$/);
  });

  test('a path, a made-up handle or an .ost is refused before any dialog, and reads nothing', async () => {
    const before = (await prompts(app)).length;
    for (const bad of [
      [path.join(fixture.localFolders, 'Inbox')],
      ['C:\\Windows\\win.ini'],
      ['../../../secret'],
      ['AAAAAAAAAAAAAAAAAAAAAA'],
      [scan.candidates[0].handle, path.join(fixture.localFolders, 'Inbox')],
      [{ path: path.join(fixture.localFolders, 'Inbox') }],
      'not-a-list',
      [],
    ]) {
      expect(await bridgeCall<Result>(page, 'grant', bad)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect((await prompts(app)).length).toBe(before);
    // An .ost was never given a handle, so nothing here could ask for it.
    expect(scan.candidates.some((c) => /\.ost$/i.test(c.name))).toBe(false);
  });

  test('no bytes without the second yes', async () => {
    await answer(app, 1);
    const handle = scan.candidates.find((c) => c.folder[0] === 'Inbox')!.handle;
    expect(await bridgeCall<Result>(page, 'grant', [handle])).toEqual({ ok: false, reason: 'declined' });
    await page.waitForTimeout(5200);
    await answer(app, 0);
  });

  let grant: Grant;

  test('a yes names the real paths in the dialog, and opens those files only', async () => {
    const before = (await prompts(app)).length;
    const wanted = scan.candidates.filter((c) => c.kind !== 'pst');
    grant = await bridgeCall<Grant>(page, 'grant', [...wanted.map((c) => c.handle), scan.books[0].handle]);
    expect(grant.ok).toBe(true);
    const asked = (await prompts(app)).slice(before);
    expect(asked).toHaveLength(1);
    expect(asked[0].detail).toContain(path.join(fixture.localFolders, 'Inbox'));
    expect(asked[0].detail).not.toContain('Archive.pst');
    expect(grant.files.map((f) => f.folder.join('/')).sort()).toEqual(wanted.map((c) => c.folder.join('/')).sort());
    expect(grant.contacts).toHaveLength(2);
    expect(grant.contacts.join()).toContain('ada-BRIDGE@example.org');
    expect(JSON.stringify(grant)).not.toContain(base.replaceAll('\\', '\\\\'));
    const stored = await app.evaluate(({ app: electronApp }) => {
      const { readFileSync: read } = process.getBuiltinModule('node:fs');
      const { join } = process.getBuiltinModule('node:path');
      return JSON.parse(read(join(electronApp.getPath('userData'), 'shell-state.json'), 'utf8')).importJobs as { id: string; files: unknown[] }[];
    });
    // Written at once, so a kill right after confirming doesn't lose the job.
    expect(stored.find((job) => job.id === grant.jobId)?.files).toHaveLength(grant.files.length);
  });

  test('the page reads confirmed files by range under the app CSP, and nothing else', async () => {
    const inbox = grant.files.find((f) => f.folder[0] === 'Inbox')!;
    const { status, text } = await readRange(page, inbox.url, 0, 4);
    expect(status).toBe(206);
    expect(text).toBe('From ');
    // No such token, and a real token with something bolted on.
    const made = await readRange(page, `bulwark-import://f/${'A'.repeat(43)}`, 0, 4);
    expect(made.status === 404 || made.status === 0).toBe(true);
    const bolted = await readRange(page, `${inbox.url}/../../..`, 0, 4);
    expect(bolted.text).not.toContain('From ');
    // A Maildir folder's messages by position, and the folder itself has no bytes.
    const maildir = grant.files.find((f) => f.kind === 'maildir')!;
    expect(maildir.entrySizes).toHaveLength(3);
    const entry = await page.evaluate(async (url) => (await (await fetch(`${url}/0`)).text()).slice(0, 11), maildir.url);
    expect(entry).toBe('Message-ID:');
  });

  test('the PST worker reads a confirmed PST through synchronous ranges', async () => {
    const pst = scan.candidates.find((c) => c.kind === 'pst')!;
    const before = (await prompts(app)).length;
    const pstGrant = await bridgeCall<Grant>(page, 'grant', [pst.handle]);
    expect(pstGrant.ok).toBe(true);
    expect((await prompts(app))[before].detail).toContain('Archive.pst');
    const summary = await page.evaluate(
      ({ url, size }) =>
        new Promise<{ opened?: number; subjects: string[]; error?: string }>((resolve) => {
          const out: { opened?: number; subjects: string[]; error?: string } = { subjects: [] };
          const worker = new Worker('/pst-worker.js');
          worker.onerror = (event) => resolve({ ...out, error: event.message });
          worker.onmessage = (event: MessageEvent) => {
            const data = event.data as { type: string; total?: number; item?: { kind: string; label?: string }; message?: string };
            if (data.type === 'opened') {
              out.opened = data.total;
              worker.postMessage({ type: 'pull', count: 1000 });
            } else if (data.type === 'item') {
              if (data.item?.kind === 'message') out.subjects.push(data.item.label ?? '');
            } else if (data.type === 'done') {
              resolve(out);
              worker.terminate();
            } else if (data.type === 'error') {
              resolve({ ...out, error: data.message });
            }
          };
          worker.postMessage({ type: 'open', range: { url, size }, skipBefore: 0, skipAlso: [] });
        }),
      { url: pstGrant.files[0].url, size: pstGrant.files[0].size },
    );
    expect(summary.error).toBeUndefined();
    expect(summary.opened).toBeGreaterThan(0);
    expect(summary.subjects.length).toBeGreaterThan(0);
    await bridgeCall(page, 'release', pstGrant.jobId);
  });

  test('the same worker fails cleanly on a dead token, instead of reading nonsense', async () => {
    const answerOf = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const worker = new Worker('/pst-worker.js');
          worker.onmessage = (event: MessageEvent) => {
            resolve((event.data as { type: string; code?: string }).code ?? (event.data as { type: string }).type);
            worker.terminate();
          };
          worker.postMessage({ type: 'open', range: { url: `bulwark-import://f/${'B'.repeat(43)}`, size: 1000 }, skipBefore: 0, skipAlso: [] });
        }),
    );
    expect(answerOf).toBe('unreadable');
  });

  test('a folder swapped for a junction after confirming is refused, in the real app', async () => {
    const secret = path.join(base, 'Secret');
    mkdirSync(secret);
    writeFileSync(path.join(secret, 'Sent'), 'From - this is not for you');
    // Evict the open handles, so the next read has to check again.
    for (const file of grant.files.filter((f) => f.kind === 'mbox')) await readRange(page, file.url, 0, 1);
    await bridgeCall(page, 'release', grant.jobId);
    await answer(app, 0);
    const fresh = await bridgeCall<Scan>(page, 'scan');
    const again = await bridgeCall<Grant>(page, 'grant', [fresh.candidates.find((c) => c.folder[0] === 'Sent')!.handle]);
    expect(again.ok).toBe(true);
    const moved = `${fixture.localFolders}.moved`;
    renameSync(fixture.localFolders, moved);
    symlinkSync(secret, fixture.localFolders, 'junction');
    try {
      const { status, text } = await readRange(page, again.files[0].url, 0, 20);
      expect(status).toBe(403);
      expect(text).not.toContain('not for you');
      // And a resume after a restart would refuse it as well.
      const resumed = await bridgeCall<Result>(page, 'resume', again.jobId);
      expect(resumed).toMatchObject({ ok: false, reason: 'invalid' });
      // Nothing can come of it any more, so main doesn't keep the paths either.
      expect(await bridgeCall<Result>(page, 'resume', again.jobId)).toEqual({ ok: false, reason: 'unknown' });
    } finally {
      unlinkSync(fixture.localFolders);
      renameSync(moved, fixture.localFolders);
    }
  });

  test('a release takes the tokens and the stored job, and an unknown job comes back unknown', async () => {
    await answer(app, 0);
    const fresh = await bridgeCall<Scan>(page, 'scan');
    const opened = await bridgeCall<Grant>(page, 'grant', [fresh.candidates.find((c) => c.folder[0] === 'Inbox')!.handle]);
    expect((await readRange(page, opened.files[0].url, 0, 4)).status).toBe(206);
    await bridgeCall(page, 'release', opened.jobId);
    expect((await readRange(page, opened.files[0].url, 0, 4)).status).not.toBe(206);
    expect(await bridgeCall<Result>(page, 'resume', opened.jobId)).toEqual({ ok: false, reason: 'unknown' });
  });

  test('a page can not navigate to the scheme', async () => {
    const before = page.url();
    await page.evaluate(() => {
      window.location.href = `bulwark-import://f/${'C'.repeat(43)}`;
    });
    await page.waitForTimeout(1000);
    expect(page.url()).toBe(before);
    const opened = await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
    expect(opened.some((url) => url.startsWith('bulwark-import'))).toBe(false);
  });

  test('a running Thunderbird shows in the scan', async () => {
    test.skip(process.platform !== 'win32', "Windows' lock file");
    await answer(app, 0);
    const lock = path.join(fixture.profileDir, 'parent.lock');
    writeFileSync(lock, '');
    const holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${lock}','Open','ReadWrite','None'); Write-Output held; Start-Sleep 30`], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()));
      expect((await bridgeCall<Scan>(page, 'scan')).thunderbirdRunning).toBe(true);
    } finally {
      holder.kill();
      await page.waitForTimeout(500);
      rmSync(lock, { force: true });
    }
    expect((await bridgeCall<Scan>(page, 'scan')).thunderbirdRunning).toBe(false);
  });
});
