import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { EDIT_CHANGED_KEEP_MS, EDIT_UNCHANGED_KEEP_MS, editFileName } from '../src/shared/edit-rules';
import { launch, launchStandalone, removeProfile, shownPage, tempProfile, type Launched } from './helpers';

/**
 * Edit on an attachment, from main's side: the bridge called as the page calls it, against
 * the real app. `shell.openPath` is replaced so nothing starts on this desktop, apart from
 * the one test of the real call, whose program is a shell line writing to the file.
 *
 * The page's side (policy, the offers, the composer) is in the webmail's tests and in
 * test/edit-attachments-mail.spec.ts.
 */

interface SessionView { id: string; name: string; account: string; source: string; changed: boolean; version: number; claimed: boolean }
interface ReadResult { ok: boolean; reason?: string; name?: string; data?: number[]; hash?: string }

/** The page's own word: a click reaches the page as a real activation. */
function clicked<T>(app: ElectronApplication, code: string): Promise<T> {
  return app.evaluate(async ({ BrowserWindow }, source) => {
    const window = BrowserWindow.getAllWindows().find((w) => w.isVisible());
    if (!window) throw new Error('no window');
    return window.webContents.executeJavaScript(source, true);
  }, code) as Promise<T>;
}

/** No click: a script of the page's own, or a plugin's. */
function noClick<T>(app: ElectronApplication, code: string): Promise<T> {
  return app.evaluate(async ({ BrowserWindow }, source) => {
    const window = BrowserWindow.getAllWindows().find((w) => w.isVisible());
    if (!window) throw new Error('no window');
    return window.webContents.executeJavaScript(source, false);
  }, code) as Promise<T>;
}

async function fakeOpener(app: ElectronApplication, answer = ''): Promise<void> {
  await app.evaluate(({ shell }, problem) => {
    const g = globalThis as unknown as { __openedFiles: string[] };
    g.__openedFiles = [];
    shell.openPath = async (file: string) => {
      g.__openedFiles.push(file);
      return problem;
    };
  }, answer);
}

const openedFiles = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { __openedFiles: string[] }).__openedFiles);

/** The test plays the page: main counts as locked until the main window's page says otherwise. */
async function whenOpen(app: ElectronApplication): Promise<void> {
  await expect.poll(async () => {
    await noClick(app, 'window.bulwarkDesktop.os.setLocked(false)').catch(() => {});
    return app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked);
  }, { timeout: 60_000 }).toBe(false);
}

interface OpenInput { key?: string; name?: string; text?: string; account?: string; source?: string }

function openCode({ key = 'k1', name = 'report.docx', text = 'first', account = 'acct-1', source = '{"kind":"mail","emailId":"e1"}' }: OpenInput): string {
  return `(async () => {
    const edit = window.bulwarkDesktop.edit;
    const begun = await edit.begin(${JSON.stringify(key)});
    if (!begun.ok) return begun;
    if (begun.open) return { ...(await edit.reopen(begun.ticket, begun.open)), reopened: true };
    return edit.open(begun.ticket, { key: ${JSON.stringify(key)}, name: ${JSON.stringify(name)}, type: 'application/octet-stream', account: ${JSON.stringify(account)}, source: ${JSON.stringify(source)}, data: new TextEncoder().encode(${JSON.stringify(text)}) });
  })()`;
}

const startEdit = (app: ElectronApplication, input: OpenInput = {}) =>
  clicked<{ ok: boolean; id?: string; reason?: string; reopened?: boolean }>(app, openCode(input));

const list = (page: Page) => page.evaluate(() => (window as unknown as { bulwarkDesktop: { edit: { list: () => Promise<SessionView[]> } } }).bulwarkDesktop.edit.list());

const readBack = (page: Page, id: string) => page.evaluate(async (session) => {
  const answer = await (window as unknown as { bulwarkDesktop: { edit: { read: (id: string) => Promise<{ ok: boolean; reason?: string; name?: string; data?: Uint8Array; hash?: string }> } } }).bulwarkDesktop.edit.read(session);
  return { ...answer, data: answer.data ? [...answer.data] : undefined };
}, id) as Promise<ReadResult>;

function fileIn(profile: string, id: string): string {
  const folder = path.join(profile, 'edit-files', id, 'f');
  return path.join(folder, readdirSync(folder).filter((name) => !name.startsWith('~') && !name.startsWith('.'))[0]);
}

const changedSoon = (page: Page, id: string, changed = true) =>
  expect.poll(async () => (await list(page)).find((s) => s.id === id)?.changed, { timeout: 30_000 }).toBe(changed);

test.describe('which files', () => {
  for (const name of [
    'virus.exe', 'VIRUS.EXE', 'run.bat', 'run.cmd', 'link.lnk', 'site.url', 'a.scr', 'a.com', 'a.pif', 'a.msi', 'a.ps1', 'a.vbs', 'a.js', 'a.hta', 'a.jar', 'a.reg', 'a.cpl',
    'report.pdf.exe', 'report.exe.', 'report.exe ', 'report.exe...  ', 'report.ex\u200be', 'cod\u202egnp.exe', 'a.iso', 'a.vhd', 'a.docm', 'a.xlsm', 'a.html', 'a.svg',
    'a.app', 'a.command', 'a.desktop', 'a.sh', 'a.pkg', 'a.dmg', 'a.deb', 'a.appimage',
    'noextension', '.bashrc', '..', '', 'a.', 'CON', 'x.averyveryverylongextensionname',
  ]) {
    test(`keeps ${JSON.stringify(name)} out`, () => {
      expect(editFileName(name)).toBeNull();
    });
  }

  for (const [name, expected] of [
    ['report.docx', 'report.docx'],
    ['Budget 2026.XLSX', 'Budget 2026.XLSX'],
    ['photo.final.jpg', 'photo.final.jpg'],
    ['a.exe.txt', 'a.exe.txt'],
    ['..\\..\\evil.txt', '_.._evil.txt'],
    ['a:b.txt', 'a_b.txt'],
    ['con.txt', '_con.txt'],
    ['plan.dwg', 'plan.dwg'],
  ]) {
    test(`lets ${JSON.stringify(name)} through`, () => {
      expect(editFileName(name)).toBe(expected);
    });
  }

  test('a long name keeps its extension and stays short enough for Office', () => {
    const name = editFileName(`${'x'.repeat(400)}.docx`);
    expect(name?.endsWith('.docx')).toBe(true);
    expect(name?.length).toBeLessThanOrEqual(100);
  });

  test('refuses anything else that is not a name', () => {
    expect(editFileName(undefined)).toBeNull();
    expect(editFileName(12)).toBeNull();
  });
});

test.describe('in the app', () => {
  let profile: string;
  let started: Launched;

  test.beforeEach(async () => {
    profile = tempProfile('edit');
    started = await launchStandalone(profile);
    await fakeOpener(started.app);
    await whenOpen(started.app);
  });

  test.afterEach(async () => {
    await started.app.close().catch(() => {});
    removeProfile(profile);
  });

  test('a copy in a private folder, marked as from outside, opened with the OS', async () => {
    const { app, page } = started;
    const result = await startEdit(app);
    expect(result.ok).toBe(true);
    const [opened] = await openedFiles(app);
    expect(opened.startsWith(path.join(profile, 'edit-files'))).toBe(true);
    expect(path.basename(opened)).toBe('report.docx');
    expect(readFileSync(opened, 'utf8')).toBe('first');

    if (process.platform === 'win32') {
      expect(readFileSync(`${opened}:Zone.Identifier`, 'utf8')).toContain('ZoneId=3');
      const acl = execFileSync('icacls.exe', [path.join(profile, 'edit-files')], { encoding: 'utf8', windowsHide: true });
      const lines = acl.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes('(F)') || line.includes('(R') || line.includes('(M)'));
      expect(acl).toContain(process.env.USERNAME ?? '');
      // Only this user and the system, and none of it inherited.
      expect(lines).toHaveLength(2);
      expect(acl).not.toMatch(/\(I\)/);
      const others = /Users|Everyone|Authenticated|Benutzer|Jeder|Administrators|Administratoren/i;
      expect(acl.replace(path.join(profile, 'edit-files'), '')).not.toMatch(others);
      // And the copy inside has the same two, and nobody else.
      const fileAcl = execFileSync('icacls.exe', [opened], { encoding: 'utf8', windowsHide: true });
      expect(fileAcl.replace(opened, '')).not.toMatch(others);
      expect(fileAcl).toContain('(I)');
    }

    const sessions = await list(page);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ name: 'report.docx', account: 'acct-1', changed: false, version: 0, claimed: false });
  });

  test('a file type that runs something never gets written or opened, whatever the page says', async () => {
    const { app, page } = started;
    for (const name of ['virus.exe', 'run.bat', 'link.lnk', 'report.exe.', 'noextension']) {
      const result = await startEdit(app, { key: name, name });
      expect(result).toEqual({ ok: false, reason: 'type' });
      expect(await page.evaluate((n) => (window as unknown as { bulwarkDesktop: { edit: { canEdit: (n: string) => boolean } } }).bulwarkDesktop.edit.canEdit(n), name)).toBe(false);
    }
    expect(await openedFiles(app)).toEqual([]);
    expect(existsSync(path.join(profile, 'edit-files')) ? readdirSync(path.join(profile, 'edit-files')) : []).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { bulwarkDesktop: { edit: { canEdit: (n: string) => boolean } } }).bulwarkDesktop.edit.canEdit('report.docx'))).toBe(true);
  });

  test('starting one takes a real click, and a script can\'t pretend', async () => {
    const { app, page } = started;
    // A page load counts as nothing, and what a click left has run out by now.
    await page.reload();
    await shownPage(app);
    await whenOpen(app);
    const quiet = await noClick<{ ok: boolean; reason?: string }>(app, 'window.bulwarkDesktop.edit.begin("k1")');
    expect(quiet).toEqual({ ok: false, reason: 'gesture' });
    const spoofed = await noClick<{ ok: boolean; reason?: string }>(app, `
      Object.defineProperty(navigator, 'userActivation', { value: { isActive: true, hasBeenActive: true } });
      window.bulwarkDesktop.edit.begin('k1')
    `);
    expect(spoofed).toEqual({ ok: false, reason: 'gesture' });
    // A ticket can't be made up, or used twice.
    const made = await noClick<{ ok: boolean; reason?: string }>(app, `window.bulwarkDesktop.edit.open('made-up', { key: 'k', name: 'a.txt', type: '', account: 'a', source: '', data: new Uint8Array(1) })`);
    expect(made).toEqual({ ok: false, reason: 'ticket' });
    const twice = await clicked<{ first: { ok: boolean }; second: { ok: boolean; reason?: string } }>(app, `(async () => {
      const edit = window.bulwarkDesktop.edit;
      const { ticket } = await edit.begin('k2');
      const file = { key: 'k2', name: 'a.txt', type: '', account: 'a', source: '', data: new Uint8Array(1) };
      const first = await edit.open(ticket, file);
      const second = await edit.open(ticket, { ...file, key: 'k3' });
      return { first, second };
    })()`);
    expect(twice.first.ok).toBe(true);
    expect(twice.second).toEqual({ ok: false, reason: 'ticket' });
    expect(await openedFiles(app)).toHaveLength(1);
  });

  test('a save is noticed once, by name, through a replace too, and not for a lock file', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app);
    const file = fileIn(profile, id!);

    // An unrelated file next to it: Office's and LibreOffice's lock files.
    writeFileSync(path.join(path.dirname(file), '~$report.docx'), 'lock');
    writeFileSync(path.join(path.dirname(file), '.~lock.report.docx#'), 'lock');
    writeFileSync(path.join(path.dirname(file), '~WRL0001.tmp'), 'lock');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect((await list(page))[0]).toMatchObject({ changed: false, version: 0 });

    // One save in several writes is one change.
    writeFileSync(file, 'a');
    writeFileSync(file, 'ab');
    writeFileSync(file, 'abc');
    await changedSoon(page, id!);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect((await list(page))[0].version).toBe(1);

    const first = await readBack(page, id!);
    expect(first.ok).toBe(true);
    expect(Buffer.from(first.data!).toString()).toBe('abc');

    // Taken: no longer a change.
    await page.evaluate(([session, hash]) => (window as unknown as { bulwarkDesktop: { edit: { taken: (i: string, h: string) => Promise<void> } } }).bulwarkDesktop.edit.taken(session, hash), [id!, first.hash!]);
    await changedSoon(page, id!, false);

    // Most programs save by replacing the file.
    const temp = path.join(path.dirname(file), 'report.tmp');
    writeFileSync(temp, 'saved by replace');
    renameSync(temp, file);
    await changedSoon(page, id!);
    expect(Buffer.from((await readBack(page, id!)).data!).toString()).toBe('saved by replace');
    expect((await list(page))[0].version).toBe(2);
  });

  test('a save only counts when its bytes differ', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app);
    const file = fileIn(profile, id!);
    writeFileSync(file, 'first');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect((await list(page))[0]).toMatchObject({ changed: false, version: 0 });
  });

  test('settling sees a save the watcher is still waiting on', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app);
    writeFileSync(fileIn(profile, id!), 'saved a moment ago');
    const sessions = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { edit: { settle: () => Promise<SessionView[]> } } }).bulwarkDesktop.edit.settle());
    expect(sessions[0]).toMatchObject({ id, changed: true, version: 1 });
  });

  test('Edit on the same attachment again opens the same file and keeps its edits', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app);
    const file = fileIn(profile, id!);
    writeFileSync(file, 'my edits');
    await changedSoon(page, id!);
    const again = await startEdit(app, { text: 'the old attachment' });
    expect(again).toMatchObject({ ok: true, id, reopened: true });
    expect(readFileSync(file, 'utf8')).toBe('my edits');
    expect(await openedFiles(app)).toEqual([file, file]);
    expect(await list(page)).toHaveLength(1);
  });

  test('no program for it: says so and leaves nothing', async () => {
    const { app, page } = started;
    await fakeOpener(app, 'No application is associated');
    const result = await startEdit(app);
    expect(result).toEqual({ ok: false, reason: 'no-app' });
    expect(await list(page)).toEqual([]);
    expect(readdirSync(path.join(profile, 'edit-files'))).toEqual([]);
  });

  test('locked: nothing opens, nothing is read or listed, and what was saved comes with the unlock', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app);
    const file = fileIn(profile, id!);
    const ticket = await clicked<{ ticket: string }>(app, 'window.bulwarkDesktop.edit.begin("k9")');

    await page.evaluate(() => {
      const w = window as unknown as { __heard: SessionView[][]; bulwarkDesktop: { edit: { onChange: (l: (s: SessionView[]) => void) => void }; os: { setLocked: (l: boolean) => void } } };
      w.__heard = [];
      w.bulwarkDesktop.edit.onChange((sessions) => w.__heard.push(sessions));
      w.bulwarkDesktop.os.setLocked(true);
    });
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked)).toBe(true);

    expect(await startEdit(app, { key: 'k2' })).toEqual({ ok: false, reason: 'locked' });
    expect(await clicked(app, `window.bulwarkDesktop.edit.open(${JSON.stringify(ticket.ticket)}, { key: 'k9', name: 'a.txt', type: '', account: 'a', source: '', data: new Uint8Array(1) })`)).toEqual({ ok: false, reason: 'locked' });
    expect(await startEdit(app)).toEqual({ ok: false, reason: 'locked' });
    expect(await list(page)).toEqual([]);
    expect(await readBack(page, id!)).toMatchObject({ ok: false, reason: 'locked' });
    expect(await openedFiles(app)).toHaveLength(1);

    // A program already has it open: that can't be stopped, and the save isn't lost.
    writeFileSync(file, 'saved while locked');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await list(page)).toEqual([]);
    const heard = await page.evaluate(() => (window as unknown as { __heard: SessionView[][] }).__heard);
    expect(heard.every((sessions) => sessions.length === 0)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('saved while locked');

    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { os: { setLocked: (l: boolean) => void } } }).bulwarkDesktop.os.setLocked(false));
    await changedSoon(page, id!);
    const after = await page.evaluate(() => (window as unknown as { __heard: SessionView[][] }).__heard.at(-1));
    expect(after?.[0]).toMatchObject({ id, changed: true });
    expect(Buffer.from((await readBack(page, id!)).data!).toString()).toBe('saved while locked');
  });

  test('a composer claims one, and losing the window lets it go', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app);
    await page.evaluate((session) => (window as unknown as { bulwarkDesktop: { edit: { claim: (i: string, o: boolean) => void } } }).bulwarkDesktop.edit.claim(session, true), id!);
    await expect.poll(async () => (await list(page))[0].claimed).toBe(true);
    await page.reload();
    await shownPage(app);
    await whenOpen(app);
    await expect.poll(async () => (await list(page))[0]?.claimed).toBe(false);
  });

  test('sign-out and discard take what they name', async () => {
    const { app, page } = started;
    const one = await startEdit(app, { key: 'a', account: 'acct-1' });
    const two = await startEdit(app, { key: 'b', account: 'acct-2' });
    const three = await startEdit(app, { key: 'c', account: 'acct-2' });
    const root = path.join(profile, 'edit-files');
    const clear = (account: string | null) => page.evaluate((a) => (window as unknown as { bulwarkDesktop: { edit: { clear: (a: string | null) => Promise<void> } } }).bulwarkDesktop.edit.clear(a), account);

    await clear('acct-1');
    expect((await list(page)).map((s) => s.id).sort()).toEqual([two.id, three.id].sort());
    expect(existsSync(path.join(root, one.id!))).toBe(false);
    expect(existsSync(path.join(root, two.id!))).toBe(true);

    await page.evaluate((id) => (window as unknown as { bulwarkDesktop: { edit: { discard: (i: string) => Promise<void> } } }).bulwarkDesktop.edit.discard(id), two.id!);
    expect((await list(page)).map((s) => s.id)).toEqual([three.id]);
    expect(existsSync(path.join(root, two.id!))).toBe(false);

    await clear(null);
    expect(await list(page)).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  test('a held file: discarded now, gone from the list, and deleted once free', async () => {
    test.skip(process.platform !== 'win32', 'Only Windows locks a file against deletion.');
    const { app, page } = started;
    const { id } = await startEdit(app);
    const file = fileIn(profile, id!);
    const holder = holdFile(file);
    try {
      await holder.ready;
      // Held against everything: a read says so rather than losing the file.
      expect(await readBack(page, id!)).toMatchObject({ ok: false, reason: 'busy' });
      await page.evaluate((session) => (window as unknown as { bulwarkDesktop: { edit: { discard: (i: string) => Promise<void> } } }).bulwarkDesktop.edit.discard(session), id!);
      expect(await list(page)).toEqual([]);
      expect(existsSync(file)).toBe(true);
    } finally {
      holder.release();
    }
    await holder.gone;
    await started.app.close();
    // A start with the program gone.
    started = { app: await launch(profile, '--standalone'), page };
    started.page = await shownPage(started.app);
    await whenOpen(started.app);
    await expect.poll(() => existsSync(path.join(profile, 'edit-files', id!))).toBe(false);
    expect(await list(started.page)).toEqual([]);
  });

  test('a change while a program holds the file is noticed once it lets go', async () => {
    test.skip(process.platform !== 'win32', 'Only Windows locks a file like this.');
    const { app, page } = started;
    const { id } = await startEdit(app);
    const file = fileIn(profile, id!);
    writeFileSync(file, 'saved, then held');
    const holder = holdFile(file);
    await holder.ready;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    holder.release();
    await holder.gone;
    await expect.poll(async () => (await list(page))[0]?.changed, { timeout: 30_000 }).toBe(true);
  });
});

/** A program that has the file open and shares nothing, as Word does while it writes. */
function holdFile(file: string): { ready: Promise<void>; release: () => void; gone: Promise<void> } {
  const script = `$f = [IO.File]::Open($env:HOLD_FILE, 'Open', 'ReadWrite', 'None'); Write-Output 'held'; [Console]::In.ReadLine() | Out-Null; $f.Close()`;
  const child: ChildProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, HOLD_FILE: file } });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('exit', (code) => reject(new Error(`holder ended with ${code}`)));
  });
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return { ready, gone, release: () => child.stdin!.end('\n') };
}

test.describe('across a restart', () => {
  let profile: string;

  test.beforeEach(() => {
    profile = tempProfile('editr');
  });

  test.afterEach(() => {
    removeProfile(profile);
  });

  async function start(): Promise<Launched> {
    const started = await launchStandalone(profile);
    await fakeOpener(started.app);
    await whenOpen(started.app);
    return started;
  }

  /** Makes a session look as old as a test needs. Only the record: the file stays as it is. */
  function age(id: string, ms: number): void {
    const file = path.join(profile, 'edit-files', id, 'session.json');
    const record = JSON.parse(readFileSync(file, 'utf8')) as { touchedAt: number };
    record.touchedAt = Date.now() - ms;
    writeFileSync(file, JSON.stringify(record));
  }

  test('what was saved survives quitting, also a save with the app closed, and is offered again', async () => {
    let started = await start();
    const saved = await startEdit(started.app, { key: 'saved', name: 'saved.docx' });
    const closedThenSaved = await startEdit(started.app, { key: 'later', name: 'later.docx' });
    const quiet = await startEdit(started.app, { key: 'quiet', name: 'quiet.docx' });
    writeFileSync(fileIn(profile, saved.id!), 'my edits');
    await changedSoon(started.page, saved.id!);
    await started.app.close();

    // The program outlives the app, and the user saves in it.
    writeFileSync(fileIn(profile, closedThenSaved.id!), 'saved with the app closed');

    started = await start();
    try {
      await expect.poll(async () => (await list(started.page)).length).toBe(3);
      await changedSoon(started.page, saved.id!);
      await changedSoon(started.page, closedThenSaved.id!);
      expect((await list(started.page)).find((s) => s.id === quiet.id)).toMatchObject({ changed: false });
      expect(Buffer.from((await readBack(started.page, saved.id!)).data!).toString()).toBe('my edits');
      expect(Buffer.from((await readBack(started.page, closedThenSaved.id!)).data!).toString()).toBe('saved with the app closed');
      // And it's still watched: a save after the restart counts.
      writeFileSync(fileIn(profile, quiet.id!), 'after the restart');
      await changedSoon(started.page, quiet.id!);
      // The program wasn't started again by any of this.
      expect(await openedFiles(started.app)).toEqual([]);
    } finally {
      await started.app.close();
    }
  });

  test('at the start: old unchanged copies, leftovers and condemned files go, changed ones stay', async () => {
    let started = await start();
    const fresh = await startEdit(started.app, { key: 'fresh', name: 'fresh.docx' });
    const stale = await startEdit(started.app, { key: 'stale', name: 'stale.docx' });
    const changed = await startEdit(started.app, { key: 'changed', name: 'changed.docx' });
    const ancient = await startEdit(started.app, { key: 'ancient', name: 'ancient.docx' });
    const doomed = await startEdit(started.app, { key: 'doomed', name: 'doomed.docx' });
    writeFileSync(fileIn(profile, changed.id!), 'edited');
    writeFileSync(fileIn(profile, ancient.id!), 'edited long ago');
    await changedSoon(started.page, changed.id!);
    await changedSoon(started.page, ancient.id!);
    await started.app.close();

    age(stale.id!, EDIT_UNCHANGED_KEEP_MS + 60_000);
    age(changed.id!, EDIT_UNCHANGED_KEEP_MS + 60_000);
    age(ancient.id!, EDIT_CHANGED_KEEP_MS + 60_000);
    const recordFile = path.join(profile, 'edit-files', doomed.id!, 'session.json');
    writeFileSync(recordFile, JSON.stringify({ ...JSON.parse(readFileSync(recordFile, 'utf8')), doomed: true }));
    // A crash before its record was written.
    const orphan = path.join(profile, 'edit-files', 'orphan', 'f');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(path.join(orphan, 'lost.txt'), 'mail');

    started = await start();
    try {
      await expect.poll(async () => (await list(started.page)).map((s) => s.name).sort()).toEqual(['changed.docx', 'fresh.docx']);
      const root = path.join(profile, 'edit-files');
      expect(readdirSync(root).sort()).toEqual([changed.id!, fresh.id!].sort());
      expect((await list(started.page)).find((s) => s.id === changed.id)?.changed).toBe(true);
    } finally {
      await started.app.close();
    }
  });
});

test('a wipe takes everything, also with a policy at the start of a launch', async () => {
  test.skip(process.platform !== 'win32', 'The policy goes through the registry here.');
  const profile = tempProfile('editw');
  const policyRoot = `HKCU\\Software\\BulwarkTest\\Policies\\edit${process.pid}`;
  const reg = (...args: string[]) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  const policyArgs = [`--bulwark-test-policy-root=${policyRoot}`, '--bulwark-test-policy-poll=250'];
  const setWipe = (value: string) => {
    const result = reg('add', `${policyRoot}\\Machine`, '/v', 'WipeOfflineData', '/t', 'REG_SZ', '/d', value, '/f');
    expect(result.status).toBe(0);
  };
  let app: ElectronApplication | null = null;
  try {
    app = await launch(profile, '--standalone', ...policyArgs);
    let page = await shownPage(app);
    await fakeOpener(app);
    await whenOpen(app);

    // Live, with a changed file: a wipe doesn't ask.
    const live = await startEdit(app, { key: 'live' });
    writeFileSync(fileIn(profile, live.id!), 'edited');
    await changedSoon(page, live.id!);
    setWipe(`live-${Date.now()}`);
    await expect.poll(() => existsSync(path.join(profile, 'edit-files', live.id!)), { timeout: 60_000 }).toBe(false);

    // Page back, a new copy, and the wipe waiting when the app next starts.
    await shownPage(app);
    await whenOpen(app);
    page = await shownPage(app);
    const next = await startEdit(app, { key: 'next' });
    expect(next.ok).toBe(true);
    await app.close();
    app = null;
    setWipe(`boot-${Date.now()}`);
    app = await launch(profile, '--standalone', ...policyArgs);
    await shownPage(app);
    await expect.poll(() => existsSync(path.join(profile, 'edit-files', next.id!)), { timeout: 60_000 }).toBe(false);
  } finally {
    await app?.close().catch(() => {});
    reg('delete', policyRoot, '/f');
    removeProfile(profile);
  }
});

test('the real shell.openPath runs the program the OS has for the type, and its save comes back', async () => {
  test.skip(process.platform !== 'win32', 'A file association made for the test: Windows only here.');
  const extension = `.bwe${Date.now().toString(36).slice(-6)}`;
  const progId = `BulwarkEditTest${Date.now().toString(36)}`;
  const classes = 'HKCU\\Software\\Classes';
  const reg = (...args: string[]) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  const before = reg('query', `${classes}\\${extension}`);
  expect(before.status).not.toBe(0);
  const profile = tempProfile('edito');
  let app: ElectronApplication | null = null;
  try {
    // Not an editor: a shell line that appends to the file it's given, and ends.
    expect(reg('add', `${classes}\\${extension}`, '/ve', '/d', progId, '/f').status).toBe(0);
    expect(reg('add', `${classes}\\${progId}\\shell\\open\\command`, '/ve', '/d', `"${process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'}" /d /c "echo edited by the program>>"%1""`, '/f').status).toBe(0);

    const started = await launchStandalone(profile);
    app = started.app;
    await whenOpen(app);
    const result = await startEdit(app, { name: `note${extension}`, text: 'first\r\n' });
    expect(result.ok).toBe(true);
    await changedSoon(started.page, result.id!);
    const back = await readBack(started.page, result.id!);
    expect(Buffer.from(back.data!).toString()).toContain('edited by the program');
    await app.close();
    app = null;
  } finally {
    await app?.close().catch(() => {});
    reg('delete', `${classes}\\${extension}`, '/f');
    reg('delete', `${classes}\\${progId}`, '/f');
    removeProfile(profile);
  }
  expect(reg('query', `${classes}\\${extension}`).status).not.toBe(0);
  expect(reg('query', `${classes}\\${progId}`).status).not.toBe(0);
});
