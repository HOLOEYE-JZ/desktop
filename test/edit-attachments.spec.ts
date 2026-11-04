import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { EDIT_CHANGED_KEEP_MS, EDIT_CHANGED_MAX_MS, EDIT_UNCHANGED_KEEP_MS, editFileLooksWhole, editFileName, editNeedsMark, isEditTempName } from '../src/shared/edit-rules';
import { fakeOsIntegration, launch, launchStandalone, removeProfile, shownPage, tempProfile, type Launched } from './helpers';

/**
 * Edit on an attachment, from main's side: the bridge called as the page calls it, against
 * the real app. `shell.openPath` is replaced so nothing starts on this desktop, apart from
 * the one test of the real call, whose program is a shell line writing to the file.
 *
 * The page's side (policy, the offers, the composer) is in the webmail's tests and in
 * test/edit-attachments-mail.spec.ts.
 */

interface SessionView { id: string; name: string; account: string; source: string; changed: boolean; version: number; claimed: boolean; held: boolean; savedAs: boolean; lastChance: boolean }
interface ReadResult { ok: boolean; reason?: string; name?: string; data?: number[]; hash?: string }
interface Answer { ok: boolean; id?: string; reason?: string; reopened?: boolean; ticket?: string; open?: string }

const pageOf = (app: ElectronApplication): Page => {
  const page = app.windows().filter((candidate) => !candidate.isClosed()).at(-1);
  if (!page) throw new Error('no window');
  return page;
};

/** A real click, which reaches main as input and no script can make, then what its handler would do. */
async function clicked<T>(app: ElectronApplication, code: string): Promise<T> {
  const page = pageOf(app);
  await page.mouse.click(200, 400);
  return page.evaluate(code) as Promise<T>;
}

/** No click: a script of the page's own, or a plugin's. */
const noClick = <T>(app: ElectronApplication, code: string): Promise<T> => pageOf(app).evaluate(code) as Promise<T>;

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

/** Main's clock only. Timers run as they do: `tick` is what they'd do at that time. */
async function advance(app: ElectronApplication, ms: number): Promise<void> {
  await app.evaluate((_electron, by) => {
    const g = globalThis as unknown as { __realNow?: () => number; __offset?: number };
    g.__realNow ??= Date.now.bind(Date);
    g.__offset = (g.__offset ?? 0) + by;
    const real = g.__realNow;
    Date.now = () => real() + (g.__offset ?? 0);
  }, ms);
}

const tick = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { edit: { tick: () => Promise<void> } } }).__bulwarkOs.edit.tick());

interface OpenInput { key?: string; name?: string; text?: string; account?: string; source?: string; bytes?: number[] }

function openCode({ key = 'k1', name = 'report.txt', text = 'first', account = 'acct-1', source = '{"kind":"mail","emailId":"e1"}', bytes }: OpenInput): string {
  const data = bytes ? `new Uint8Array(${JSON.stringify(bytes)})` : `new TextEncoder().encode(${JSON.stringify(text)})`;
  return `(async () => {
    const edit = window.bulwarkDesktop.edit;
    const begun = await edit.begin(${JSON.stringify(key)});
    if (!begun.ok) return begun;
    if (begun.open) return { ...(await edit.reopen(begun.ticket, begun.open)), reopened: true };
    return edit.open(begun.ticket, { key: ${JSON.stringify(key)}, name: ${JSON.stringify(name)}, type: 'application/octet-stream', account: ${JSON.stringify(account)}, source: ${JSON.stringify(source)}, data: ${data} });
  })()`;
}

const startEdit = (app: ElectronApplication, input: OpenInput = {}) => clicked<Answer>(app, openCode(input));

type EditCall = 'list' | 'settle';
const call = (page: Page, name: EditCall) => page.evaluate((member) => (window as unknown as { bulwarkDesktop: { edit: Record<string, () => Promise<SessionView[]>> } }).bulwarkDesktop.edit[member](), name);
const list = (page: Page) => call(page, 'list');
const editCall = <T>(page: Page, member: string, ...args: unknown[]) => page.evaluate(([name, values]) => (window as unknown as { bulwarkDesktop: { edit: Record<string, (...a: unknown[]) => unknown> } }).bulwarkDesktop.edit[name as string](...(values as unknown[])), [member, args] as const) as Promise<T>;

const readBack = (page: Page, id: string) => page.evaluate(async (session) => {
  const answer = await (window as unknown as { bulwarkDesktop: { edit: { read: (id: string) => Promise<{ ok: boolean; reason?: string; name?: string; data?: Uint8Array; hash?: string }> } } }).bulwarkDesktop.edit.read(session);
  return { ...answer, data: answer.data ? [...answer.data] : undefined };
}, id) as Promise<ReadResult>;

const textOf = (result: ReadResult) => Buffer.from(result.data ?? []).toString();

function fileIn(profile: string, id: string): string {
  const folder = path.join(profile, 'edit-files', id, 'f');
  return path.join(folder, readdirSync(folder).filter((name) => !name.startsWith('~') && !name.startsWith('.'))[0]);
}

const changedSoon = (page: Page, id: string, changed = true) =>
  expect.poll(async () => (await list(page)).find((s) => s.id === id)?.changed, { timeout: 30_000 }).toBe(changed);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Enough of a zip to end like one, which is what Office and ODF files are. */
const wholeZip = (fill = 'x') => Buffer.concat([Buffer.from(`PK\u0003\u0004${fill}`, 'latin1'), Buffer.from('PK\u0005\u0006', 'latin1'), Buffer.alloc(18)]);

test.describe('which files', () => {
  for (const name of [
    'virus.exe', 'VIRUS.EXE', 'run.bat', 'run.cmd', 'link.lnk', 'site.url', 'a.scr', 'a.com', 'a.pif', 'a.msi', 'a.ps1', 'a.vbs', 'a.js', 'a.hta', 'a.jar', 'a.reg', 'a.cpl',
    // What ran something on a real machine past the old list of what's dangerous.
    'a.ppkg', 'a.xaml', 'a.wcx', 'a.udl', 'a.xml', 'a.ahk',
    'a.html', 'a.htm', 'a.svg', 'a.docm', 'a.xlsm', 'a.pptm', 'a.xlsb', 'a.dwg', 'a.stl', 'a.iso', 'a.zip',
    'report.pdf.exe', 'report.exe.', 'report.exe ', 'report.exe...  ', 'report.ex\u200be', 'cod\u202egnp.exe',
    'a.app', 'a.command', 'a.desktop', 'a.sh', 'a.pkg', 'a.dmg', 'a.deb', 'a.appimage', 'a.anythingnew',
    'noextension', '.bashrc', '..', '', 'a.', 'CON',
  ]) {
    test(`keeps ${JSON.stringify(name)} out`, () => {
      expect(editFileName(name, 'win32')).toBeNull();
    });
  }

  for (const [name, expected] of [
    ['report.docx', 'report.docx'],
    ['Budget 2026.XLSX', 'Budget 2026.XLSX'],
    ['talk.pptx', 'talk.pptx'],
    ['text.odt', 'text.odt'],
    ['photo.final.jpg', 'photo.final.jpg'],
    ['scan.pdf', 'scan.pdf'],
    ['a.exe.txt', 'a.exe.txt'],
    ['list.csv', 'list.csv'],
    ['plan.dxf', 'plan.dxf'],
    ['..\\..\\evil.txt', '_.._evil.txt'],
    ['a:b.txt', 'a_b.txt'],
    ['con.txt', '_con.txt'],
    // Windows drops these when it reads a name, so they can't be left to hide a type.
    ['report.txt ', 'report.txt'],
    ['report.txt. ', 'report.txt'],
  ]) {
    test(`lets ${JSON.stringify(name)} through`, () => {
      expect(editFileName(name, 'darwin')).toBe(expected);
    });
  }

  for (const name of ['old.doc', 'old.xls', 'old.ppt', 'old.rtf', 'OLD.DOC']) {
    test(`${name} can hold macros: Windows only, and only with the mark`, () => {
      expect(editFileName(name, 'win32')).toBe(name);
      expect(editNeedsMark(name)).toBe(true);
      expect(editFileName(name, 'darwin')).toBeNull();
      expect(editFileName(name, 'linux')).toBeNull();
    });
  }

  test('nothing else asks for the mark', () => {
    expect(editNeedsMark('a.docx')).toBe(false);
  });

  test('a long name keeps its extension and stays short enough for Office', () => {
    const name = editFileName(`${'x'.repeat(400)}.docx`);
    expect(name?.endsWith('.docx')).toBe(true);
    expect(name?.length).toBeLessThanOrEqual(100);
  });

  test('refuses anything else that is not a name', () => {
    expect(editFileName(undefined)).toBeNull();
    expect(editFileName(12)).toBeNull();
  });

  for (const name of ['~$report.docx', '~WRL0001.tmp', '.~lock.report.docx#', 'lu1234.tmp', '.report.txt.swp', 'report.txt~', '#report.txt#', 'report.bak', '.goutputstream-AB12']) {
    test(`${name} is a program's own file`, () => {
      expect(isEditTempName(name)).toBe(true);
    });
  }

  test('what the user saves is not', () => {
    expect(isEditTempName('report.docx')).toBe(false);
    expect(isEditTempName('Report (2).pdf')).toBe(false);
  });

  test('what can be told to be cut off, is', () => {
    const tail = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'));
    expect(editFileLooksWhole('a.txt', 0, tail(''))).toBe(false);
    expect(editFileLooksWhole('a.txt', 3, tail('abc'))).toBe(true);
    expect(editFileLooksWhole('a.docx', 3, tail('PK\u0003\u0004half'))).toBe(false);
    expect(editFileLooksWhole('a.docx', 30, new Uint8Array(wholeZip()))).toBe(true);
    expect(editFileLooksWhole('a.pdf', 9, tail('%PDF-1.7 half'))).toBe(false);
    expect(editFileLooksWhole('a.pdf', 9, tail('%PDF-1.7 %%EOF\n'))).toBe(true);
    expect(editFileLooksWhole('a.png', 9, tail('xxIEND\u00aeB`\u0082'))).toBe(true);
    expect(editFileLooksWhole('a.png', 9, tail('xxIDATxxxx'))).toBe(false);
    expect(editFileLooksWhole('a.jpg', 3, new Uint8Array([1, 0xff, 0xd9]))).toBe(true);
    expect(editFileLooksWhole('a.jpg', 3, new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

/** A program with the file open. `Read` is Word: others may read, nobody may write or delete. `None` shares nothing. */
function holdFile(file: string, share: 'None' | 'Read' = 'None'): { ready: Promise<void>; write: (text: string) => Promise<void>; release: () => void; gone: Promise<void> } {
  const script = [
    `$f = [IO.File]::Open($env:HOLD_FILE, 'Open', 'ReadWrite', '${share}')`,
    `Write-Output 'held'`,
    'while ($true) {',
    '  $line = [Console]::In.ReadLine()',
    `  if (-not $line) { break }`,
    '  $bytes = [Text.Encoding]::UTF8.GetBytes($line)',
    '  $f.SetLength(0); $f.Write($bytes, 0, $bytes.Length); $f.Flush($true)',
    `  Write-Output 'wrote'`,
    '}',
    '$f.Close()',
  ].join('\n');
  const child: ChildProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, HOLD_FILE: file } });
  let output = '';
  const waiters: (() => void)[] = [];
  child.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    while (waiters.length && /(held|wrote)\r?\n/.test(output)) {
      output = output.replace(/(held|wrote)\r?\n/, '');
      waiters.shift()!();
    }
  });
  const next = () => new Promise<void>((resolve) => waiters.push(resolve));
  const ready = next();
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return {
    ready,
    gone,
    write: (text) => {
      const done = next();
      child.stdin!.write(`${text}\n`);
      return done;
    },
    release: () => child.stdin!.end('\n'),
  };
}

test.describe('in the app', () => {
  let profile: string;
  let started: Launched;

  test.beforeEach(async () => {
    profile = tempProfile('edit');
    started = await launchStandalone(profile);
    await fakeOpener(started.app);
    await fakeOsIntegration(started.app);
    await whenOpen(started.app);
  });

  test.afterEach(async () => {
    await started.app.close().catch(() => {});
    removeProfile(profile);
  });

  const prompts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __prompts: { message: string; detail?: string; buttons?: string[] }[] }).__prompts);

  test('a copy in a private folder, marked as from outside, opened with the OS', async () => {
    const { app, page } = started;
    const result = await startEdit(app);
    expect(result.ok).toBe(true);
    const [opened] = await openedFiles(app);
    expect(opened.startsWith(path.join(profile, 'edit-files'))).toBe(true);
    expect(path.basename(opened)).toBe('report.txt');
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
    expect(sessions[0]).toMatchObject({ name: 'report.txt', account: 'acct-1', changed: false, version: 0, claimed: false, held: false });
  });

  test('anything not on the list never gets written or opened, whatever the page says', async () => {
    const { app, page } = started;
    for (const name of ['virus.exe', 'run.bat', 'link.lnk', 'report.exe.', 'noextension', 'a.ppkg', 'a.xaml', 'a.wcx', 'a.udl', 'a.xml', 'a.ahk', 'a.html', 'a.docm', 'a.xlsb']) {
      const result = await startEdit(app, { key: name, name });
      expect(result).toEqual({ ok: false, reason: 'type' });
      expect(await page.evaluate((n) => (window as unknown as { bulwarkDesktop: { edit: { canEdit: (n: string) => boolean } } }).bulwarkDesktop.edit.canEdit(n), name)).toBe(false);
    }
    expect(await openedFiles(app)).toEqual([]);
    expect(existsSync(path.join(profile, 'edit-files')) ? readdirSync(path.join(profile, 'edit-files')) : []).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { bulwarkDesktop: { edit: { canEdit: (n: string) => boolean } } }).bulwarkDesktop.edit.canEdit('report.docx'))).toBe(true);
  });

  test('a .doc opens on Windows with the mark on it', async () => {
    test.skip(process.platform !== 'win32', 'Windows only, by the rule.');
    const { app } = started;
    const result = await startEdit(app, { name: 'old.doc' });
    expect(result.ok).toBe(true);
    const [opened] = await openedFiles(app);
    expect(readFileSync(`${opened}:Zone.Identifier`, 'utf8')).toContain('ZoneId=3');
  });

  test('one click is one ticket: twenty tries from one click give one', async () => {
    const { app } = started;
    const answers = await clicked<Answer[]>(app, `(async () => {
      const edit = window.bulwarkDesktop.edit;
      const out = [];
      for (let i = 0; i < 20; i += 1) out.push(await edit.begin('k' + i));
      return out;
    })()`);
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers[0].ok).toBe(true);
    expect(answers.slice(1).every((answer) => answer.reason === 'gesture')).toBe(true);
  });

  test('a script with no click opens nothing, and can\'t pretend', async () => {
    const { app, page } = started;
    await page.reload();
    await shownPage(app);
    await whenOpen(app);
    const file = "{ key: 'k1', name: 'a.txt', type: '', account: 'a', source: '', data: new Uint8Array(1) }";
    expect(await noClick(app, 'window.bulwarkDesktop.edit.begin("k1")')).toEqual({ ok: false, reason: 'gesture' });
    expect(await noClick(app, `
      Object.defineProperty(navigator, 'userActivation', { value: { isActive: true, hasBeenActive: true } });
      window.bulwarkDesktop.edit.begin('k1')
    `)).toEqual({ ok: false, reason: 'gesture' });
    // What gives a page's own script a user gesture isn't a click either.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())!.webContents.executeJavaScript('window.bulwarkDesktop.edit.begin("k1")', true))).toEqual({ ok: false, reason: 'gesture' });
    expect(await noClick(app, `window.bulwarkDesktop.edit.open('made-up', ${file})`)).toEqual({ ok: false, reason: 'ticket' });
    expect(await openedFiles(app)).toEqual([]);
  });

  test('a click that is too old counts for nothing', async () => {
    const { app } = started;
    await pageOf(app).mouse.click(200, 400);
    await advance(app, 6_000);
    expect(await noClick(app, 'window.bulwarkDesktop.edit.begin("k1")')).toEqual({ ok: false, reason: 'gesture' });
  });

  test('a ticket is good once, for its key, for a short time, and only while it\'s the newest', async () => {
    const { app } = started;
    const file = (key: string) => `{ key: ${JSON.stringify(key)}, name: 'a.txt', type: '', account: 'a', source: '', data: new Uint8Array(1) }`;
    const ticketFor = async (key: string) => (await clicked<Answer>(app, `window.bulwarkDesktop.edit.begin(${JSON.stringify(key)})`)).ticket!;
    const open = (ticket: string, key: string) => noClick<Answer>(app, `window.bulwarkDesktop.edit.open(${JSON.stringify(ticket)}, ${file(key)})`);

    const twice = await ticketFor('a');
    expect((await open(twice, 'a')).ok).toBe(true);
    expect(await open(twice, 'b')).toEqual({ ok: false, reason: 'ticket' });

    const bound = await ticketFor('c');
    expect(await open(bound, 'other')).toEqual({ ok: false, reason: 'ticket' });

    const older = await ticketFor('d');
    const newer = await ticketFor('e');
    expect(await open(older, 'd')).toEqual({ ok: false, reason: 'ticket' });
    expect((await open(newer, 'e')).ok).toBe(true);

    const late = await ticketFor('f');
    await advance(app, 4 * 60_000);
    expect(await open(late, 'f')).toEqual({ ok: false, reason: 'ticket' });
    expect(await openedFiles(app)).toHaveLength(2);
  });

  test('a save is noticed by name, through a replace too, and not for a lock file', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app);
    const file = fileIn(profile, id!);

    // An unrelated file next to it: Office's and LibreOffice's lock files.
    writeFileSync(path.join(path.dirname(file), '~$report.txt'), 'lock');
    writeFileSync(path.join(path.dirname(file), '.~lock.report.txt#'), 'lock');
    writeFileSync(path.join(path.dirname(file), '~WRL0001.tmp'), 'lock');
    await sleep(4000);
    expect(await list(page)).toHaveLength(1);
    expect((await list(page))[0]).toMatchObject({ changed: false, version: 0 });

    writeFileSync(file, 'abc');
    await changedSoon(page, id!);

    const first = await readBack(page, id!);
    expect(first.ok).toBe(true);
    expect(textOf(first)).toBe('abc');

    // Taken: no longer a change.
    await editCall(page, 'taken', id!, first.hash!);
    await changedSoon(page, id!, false);

    // Most programs save by replacing the file.
    const temp = path.join(path.dirname(file), 'report.tmp');
    writeFileSync(temp, 'saved by replace');
    renameSync(temp, file);
    await changedSoon(page, id!);
    expect(textOf(await readBack(page, id!))).toBe('saved by replace');
    expect((await list(page)).find((s) => s.id === id)?.version).toBe(2);
  });

  test('one save in several writes over time is one change, with all of it', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app);
    const file = fileIn(profile, id!);
    // Slower than the watcher's wait, so without a check that the file has stopped growing, each write is a save.
    for (const part of ['one ', 'two ', 'three ', 'four']) {
      appendFileSync(file, part);
      await sleep(1200);
    }
    await changedSoon(page, id!);
    await sleep(4000);
    const [session] = await list(page);
    expect(session.version).toBe(1);
    expect(textOf(await readBack(page, id!))).toBe('firstone two three four');
  });

  test('a save only counts when its bytes differ', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app);
    writeFileSync(fileIn(profile, id!), 'first');
    await sleep(4000);
    expect((await list(page))[0]).toMatchObject({ changed: false, version: 0 });
  });

  test('an empty file and one that can be told to be cut off are not offered, and the whole one is', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app, { name: 'report.docx', bytes: [...wholeZip()] });
    const file = fileIn(profile, id!);

    writeFileSync(file, '');
    await sleep(4000);
    expect((await list(page))[0]).toMatchObject({ changed: false, version: 0 });

    writeFileSync(file, 'PK\u0003\u0004half of a file');
    await sleep(4000);
    expect((await list(page))[0]).toMatchObject({ changed: false, version: 0 });
    expect(await readBack(page, id!)).toMatchObject({ ok: false, reason: 'busy' });

    writeFileSync(file, wholeZip('edited'));
    // The next look, by the watcher or the poll.
    await changedSoon(page, id!);
    expect((await readBack(page, id!)).ok).toBe(true);
  });

  test('a program that keeps the file open against writers, as Word does, still gets its save offered', async () => {
    test.skip(process.platform !== 'win32', 'Only Windows locks a file like this.');
    const { app, page } = started;
    const { id } = await startEdit(app);
    const holder = holdFile(fileIn(profile, id!), 'Read');
    try {
      await holder.ready;
      await holder.write('saved with the file still open');
      await changedSoon(page, id!);
      expect(textOf(await readBack(page, id!))).toContain('saved with the file still open');
    } finally {
      holder.release();
      await holder.gone;
    }
  });

  test('a save is said before it is written down, so a full disk can\'t hide it', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app);
    await page.evaluate(() => {
      const w = window as unknown as { __heard: SessionView[][]; bulwarkDesktop: { edit: { onChange: (l: (s: SessionView[]) => void) => void } } };
      w.__heard = [];
      w.bulwarkDesktop.edit.onChange((sessions) => w.__heard.push(sessions));
    });
    // A record that can't be replaced.
    const record = path.join(profile, 'edit-files', id!, 'session.json');
    rmSync(record);
    mkdirSync(record);
    writeFileSync(fileIn(profile, id!), 'saved');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __heard: SessionView[][] }).__heard.some((sessions) => sessions[0]?.changed)), { timeout: 30_000 }).toBe(true);
    rmSync(record, { recursive: true });
  });

  test('settling sees a save the watcher is still waiting on', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app);
    writeFileSync(fileIn(profile, id!), 'saved a moment ago');
    const sessions = await call(page, 'settle');
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

  test('Save As in the other program is offered as well, under the same list', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app, { name: 'report.doc', source: '{"kind":"mail","emailId":"e1"}' });
    const folder = path.dirname(fileIn(profile, id!));
    writeFileSync(path.join(folder, 'report.docx'), wholeZip('saved as'));
    // None of these is something the user saved, or something that may go.
    writeFileSync(path.join(folder, '~$report.docx'), 'lock');
    writeFileSync(path.join(folder, '~$report.txt'), 'a name the list would take');
    writeFileSync(path.join(folder, '.report.txt'), 'and another');
    writeFileSync(path.join(folder, 'report.exe'), 'MZ');
    writeFileSync(path.join(folder, 'report.xlsm'), wholeZip());
    writeFileSync(path.join(folder, 'report.tmp'), 'working');
    writeFileSync(path.join(folder, 'empty.txt'), '');
    await expect.poll(async () => (await list(page)).map((s) => s.name).sort(), { timeout: 30_000 }).toEqual(['report.doc', 'report.docx']);
    await sleep(4000);
    expect((await list(page)).map((s) => s.name).sort()).toEqual(['report.doc', 'report.docx']);

    const added = (await list(page)).find((s) => s.name === 'report.docx')!;
    expect(added).toMatchObject({ changed: true, savedAs: true, account: 'acct-1', source: '{"kind":"mail","emailId":"e1"}', held: false });
    const back = await readBack(page, added.id);
    expect(back.name).toBe('report.docx');
    expect(back.ok).toBe(true);

    // Taken like any other.
    await editCall(page, 'taken', added.id, back.hash!);
    await changedSoon(page, added.id, false);
    // Further saves to it count.
    writeFileSync(path.join(folder, 'report.docx'), wholeZip('and again'));
    await changedSoon(page, added.id);

    // Each goes on its own, and the folder with the last.
    await editCall(page, 'release', added.id, '{"kind":"file"}');
    await editCall(page, 'taken', added.id, (await readBack(page, added.id)).hash!);
    await editCall(page, 'release', added.id, '{"kind":"file"}');
    await expect.poll(async () => (await list(page)).map((s) => s.name)).toEqual(['report.doc']);
    expect(existsSync(folder)).toBe(true);
    await editCall(page, 'release', id!, '{"kind":"file"}');
    await expect.poll(() => existsSync(path.dirname(folder))).toBe(false);
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
    expect(await noClick(app, `window.bulwarkDesktop.edit.open(${JSON.stringify(ticket.ticket)}, { key: 'k9', name: 'a.txt', type: '', account: 'a', source: '', data: new Uint8Array(1) })`)).toEqual({ ok: false, reason: 'locked' });
    expect(await startEdit(app)).toEqual({ ok: false, reason: 'locked' });
    expect(await list(page)).toEqual([]);
    expect(await readBack(page, id!)).toMatchObject({ ok: false, reason: 'locked' });
    expect(await openedFiles(app)).toHaveLength(1);

    // A program already has it open: that can't be stopped, and the save isn't lost.
    writeFileSync(file, 'saved while locked');
    await sleep(4000);
    expect(await list(page)).toEqual([]);
    const heard = await page.evaluate(() => (window as unknown as { __heard: SessionView[][] }).__heard);
    expect(heard.every((sessions) => sessions.length === 0)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('saved while locked');

    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { os: { setLocked: (l: boolean) => void } } }).bulwarkDesktop.os.setLocked(false));
    await changedSoon(page, id!);
    const after = await page.evaluate(() => (window as unknown as { __heard: SessionView[][] }).__heard.at(-1));
    expect(after?.[0]).toMatchObject({ id, changed: true });
    expect(textOf(await readBack(page, id!))).toBe('saved while locked');
  });

  test('a composer claims one, and losing the window lets it go', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app);
    await editCall(page, 'claim', id!, true);
    await expect.poll(async () => (await list(page))[0].claimed).toBe(true);
    await page.reload();
    await shownPage(app);
    await whenOpen(app);
    await expect.poll(async () => (await list(page))[0]?.claimed).toBe(false);
  });

  test('releasing keeps a save the page has not heard of yet', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app);
    const file = fileIn(profile, id!);
    await editCall(page, 'claim', id!, true);
    writeFileSync(file, 'saved a moment before the send');
    await editCall(page, 'release', id!, '{"kind":"file"}');
    const [session] = await list(page);
    expect(session).toMatchObject({ id, changed: true, claimed: false, source: '{"kind":"file"}' });
    expect(readFileSync(file, 'utf8')).toBe('saved a moment before the send');
  });

  test('releasing takes an unchanged copy', async () => {
    const { app, page } = started;
    const { id } = await startEdit(app);
    await editCall(page, 'release', id!, '{"kind":"file"}');
    expect(await list(page)).toEqual([]);
    expect(existsSync(path.join(profile, 'edit-files', id!))).toBe(false);
  });

  test('a page\'s word to delete edits takes the user\'s yes, natively', async () => {
    const { app, page } = started;
    const one = await startEdit(app, { key: 'a', name: 'edited.txt', account: 'acct-1' });
    const two = await startEdit(app, { key: 'b', name: 'quiet.txt', account: 'acct-1' });
    writeFileSync(fileIn(profile, one.id!), 'my edits');
    await changedSoon(page, one.id!);

    // No: nothing goes, also not what's unchanged beside it.
    await fakeOsIntegration(app, 1);
    expect(await editCall(page, 'clear', 'acct-1')).toEqual({ held: [], refused: true });
    expect(await editCall(page, 'clear', null)).toEqual({ held: [], refused: true });
    expect(await editCall(page, 'discard', one.id!)).toEqual({ held: [], refused: true });
    expect(await list(page)).toHaveLength(2);
    const asked = await prompts(app);
    expect(asked).toHaveLength(3);
    expect(asked[0].detail).toContain('edited.txt');
    expect(asked[0].detail).toContain('recovery files');
    expect(asked[2].message).toContain('edited.txt');

    // An unchanged copy goes without asking.
    await fakeOsIntegration(app, 1);
    expect(await editCall(page, 'discard', two.id!)).toEqual({ held: [] });
    expect(await prompts(app)).toEqual([]);

    // Yes.
    await fakeOsIntegration(app, 0);
    expect(await editCall(page, 'clear', 'acct-1')).toEqual({ held: [] });
    expect(await list(page)).toEqual([]);
  });

  test('a yes before a sign-out covers the clearing after it, once', async () => {
    const { app, page } = started;
    const one = await startEdit(app, { key: 'a', name: 'edited.txt' });
    writeFileSync(fileIn(profile, one.id!), 'my edits');
    await changedSoon(page, one.id!);
    expect(await editCall(page, 'askClear', 'acct-1')).toBe(true);
    expect(await prompts(app)).toHaveLength(1);
    expect(await editCall(page, 'clear', 'acct-1')).toEqual({ held: [] });
    expect(await prompts(app)).toHaveLength(1);

    const two = await startEdit(app, { key: 'b', name: 'other.txt' });
    writeFileSync(fileIn(profile, two.id!), 'more edits');
    await changedSoon(page, two.id!);
    await editCall(page, 'clear', 'acct-1');
    expect(await prompts(app)).toHaveLength(2);
  });

  test('nothing to ask about before a sign-out: no question', async () => {
    const { app, page } = started;
    await startEdit(app, { account: 'other' });
    expect(await editCall(page, 'askClear', 'acct-1')).toBe(true);
    expect(await prompts(app)).toEqual([]);
  });

  test('sign-out takes only what it names', async () => {
    const { app, page } = started;
    const one = await startEdit(app, { key: 'a', account: 'acct-1' });
    const two = await startEdit(app, { key: 'b', account: 'acct-2' });
    const three = await startEdit(app, { key: 'c', account: 'acct-2' });
    const root = path.join(profile, 'edit-files');

    await editCall(page, 'clear', 'acct-1');
    expect((await list(page)).map((s) => s.id).sort()).toEqual([two.id, three.id].sort());
    expect(existsSync(path.join(root, one.id!))).toBe(false);
    expect(existsSync(path.join(root, two.id!))).toBe(true);

    await editCall(page, 'discard', two.id!);
    expect((await list(page)).map((s) => s.id)).toEqual([three.id]);
    expect(existsSync(path.join(root, two.id!))).toBe(false);

    await editCall(page, 'clear', null);
    expect(await list(page)).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  test('a weekend with the file open in a program: a save on Monday is still offered', async () => {
    test.skip(process.platform !== 'win32', 'Only Windows locks a file against deletion.');
    const { app, page } = started;
    const { id } = await startEdit(app);
    const file = fileIn(profile, id!);
    const holder = holdFile(file, 'Read');
    try {
      await holder.ready;
      await advance(app, 3 * 24 * 60 * 60_000);
      await tick(app);
      // Past the day an unchanged copy gets. It can't go, and it isn't forgotten.
      expect(existsSync(file)).toBe(true);
      expect((await list(page))[0]).toMatchObject({ id, held: true, changed: false });

      await holder.write('written on Monday');
      await expect.poll(async () => {
        await tick(app);
        return (await list(page))[0];
      }, { timeout: 30_000 }).toMatchObject({ id, held: false, changed: true });
      expect(textOf(await readBack(page, id!))).toContain('written on Monday');
    } finally {
      holder.release();
      await holder.gone;
    }
  });

  test('a draft sent with the file held: a later save is offered, and with no later save the copy goes', async () => {
    test.skip(process.platform !== 'win32', 'Only Windows locks a file against deletion.');
    const { app, page } = started;
    const { id } = await startEdit(app, { key: 'saved' });
    const { id: quietId } = await startEdit(app, { key: 'quiet', name: 'quiet.txt' });
    const file = fileIn(profile, id!);
    const quietFile = fileIn(profile, quietId!);
    const holder = holdFile(file, 'Read');
    const quietHolder = holdFile(quietFile, 'Read');
    try {
      await holder.ready;
      await quietHolder.ready;
      await editCall(page, 'release', id!, '{"kind":"file"}');
      await editCall(page, 'release', quietId!, '{"kind":"file"}');
      expect((await list(page)).map((s) => [s.name, s.held]).sort()).toEqual([['quiet.txt', true], ['report.txt', true]]);

      await holder.write('saved after the send');
      await expect.poll(async () => (await list(page)).find((s) => s.id === id), { timeout: 30_000 }).toMatchObject({ held: false, changed: true });
    } finally {
      holder.release();
      quietHolder.release();
      await holder.gone;
      await quietHolder.gone;
    }
    // Free now: the quiet one goes by itself, the saved one waits for a decision.
    await tick(app);
    expect(existsSync(quietFile)).toBe(false);
    expect((await list(page)).map((s) => s.id)).toEqual([id]);
    expect(readFileSync(file, 'utf8')).toContain('saved after the send');
  });

  test('held and discarded: gone from the offers, a restart does not bring it back, and it goes once free', async () => {
    test.skip(process.platform !== 'win32', 'Only Windows locks a file against deletion.');
    const { app, page } = started;
    const { id } = await startEdit(app);
    const file = fileIn(profile, id!);
    const holder = holdFile(file);
    try {
      await holder.ready;
      // Held against everything: a read says so rather than losing the file.
      expect(await readBack(page, id!)).toMatchObject({ ok: false, reason: 'busy' });
      expect(await editCall(page, 'discard', id!)).toEqual({ held: ['report.txt'] });
      expect((await list(page))[0]).toMatchObject({ id, held: true, changed: false });
      expect(existsSync(file)).toBe(true);

      await started.app.close();
      started = await launchStandalone(profile);
      await fakeOpener(started.app);
      await whenOpen(started.app);
      await expect.poll(async () => (await list(started.page)).map((s) => s.held)).toEqual([true]);
    } finally {
      holder.release();
      await holder.gone;
    }
    await tick(started.app);
    await expect.poll(async () => list(started.page)).toEqual([]);
    expect(existsSync(path.join(profile, 'edit-files', id!))).toBe(false);
  });

  test('the organisation\'s no: held, nothing it writes is offered, and it goes once free', async () => {
    test.skip(process.platform !== 'win32', 'Only Windows locks a file against deletion.');
    const { app, page } = started;
    const { id } = await startEdit(app);
    const file = fileIn(profile, id!);
    const holder = holdFile(file, 'Read');
    try {
      await holder.ready;
      expect(await editCall(page, 'forceDiscard', id!)).toEqual({ held: ['report.txt'] });
      expect(await prompts(app)).toEqual([]);
      await holder.write('written after the no');
      await sleep(6000);
      await tick(app);
      expect((await list(page))[0]).toMatchObject({ id, held: true, changed: false });
      expect(await readBack(page, id!)).toMatchObject({ ok: false, reason: 'missing' });
    } finally {
      holder.release();
      await holder.gone;
    }
    await tick(app);
    await expect.poll(async () => list(page)).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  test('a wipe asks nobody, and says what it could not delete', async () => {
    test.skip(process.platform !== 'win32', 'Only Windows locks a file against deletion.');
    const { app, page } = started;
    const held = await startEdit(app, { key: 'a', name: 'held.txt' });
    const free = await startEdit(app, { key: 'b', name: 'free.txt' });
    writeFileSync(fileIn(profile, free.id!), 'edited');
    await changedSoon(page, free.id!);
    const holder = holdFile(fileIn(profile, held.id!), 'Read');
    try {
      await holder.ready;
      expect(await editCall(page, 'wipe', 'acct-1')).toEqual({ held: ['held.txt'] });
      expect(await prompts(app)).toEqual([]);
      expect(existsSync(path.join(profile, 'edit-files', free.id!))).toBe(false);
    } finally {
      holder.release();
      await holder.gone;
    }
  });

  test('the question before a sign-out says what a program still has open', async () => {
    test.skip(process.platform !== 'win32', 'Only Windows locks a file like this.');
    const { app, page } = started;
    const { id } = await startEdit(app, { name: 'open.txt' });
    const holder = holdFile(fileIn(profile, id!), 'Read');
    try {
      await holder.ready;
      expect(await editCall(page, 'askClear', 'acct-1')).toBe(true);
      const [question] = await prompts(app);
      expect(question.detail).toContain('open.txt');
      expect(question.detail).toContain('Still open in another program');
      expect(question.detail).toContain('recovery files');
      expect(await editCall(page, 'clear', 'acct-1')).toEqual({ held: ['open.txt'] });
    } finally {
      holder.release();
      await holder.gone;
    }
  });
});

test('a .doc without its mark confirmed does not open, and a plain file still does', async () => {
  test.skip(process.platform !== 'win32', 'Windows only, by the rule.');
  const profile = tempProfile('editz');
  const started = await launchStandalone(profile, '--bulwark-test-no-zone-mark');
  try {
    await fakeOpener(started.app);
    await whenOpen(started.app);
    expect(await startEdit(started.app, { key: 'a', name: 'old.doc' })).toEqual({ ok: false, reason: 'type' });
    expect(await openedFiles(started.app)).toEqual([]);
    expect(readdirSync(path.join(profile, 'edit-files'))).toEqual([]);
    expect((await startEdit(started.app, { key: 'b', name: 'plain.docx', bytes: [...wholeZip()] })).ok).toBe(true);
  } finally {
    await started.app.close().catch(() => {});
    removeProfile(profile);
  }
});

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
    const saved = await startEdit(started.app, { key: 'saved', name: 'saved.txt' });
    const closedThenSaved = await startEdit(started.app, { key: 'later', name: 'later.txt' });
    const quiet = await startEdit(started.app, { key: 'quiet', name: 'quiet.txt' });
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
      expect(textOf(await readBack(started.page, saved.id!))).toBe('my edits');
      expect(textOf(await readBack(started.page, closedThenSaved.id!))).toBe('saved with the app closed');
      // And it's still watched: a save after the restart counts.
      writeFileSync(fileIn(profile, quiet.id!), 'after the restart');
      await changedSoon(started.page, quiet.id!);
      // The program wasn't started again by any of this.
      expect(await openedFiles(started.app)).toEqual([]);
    } finally {
      await started.app.close();
    }
  });

  test('Save As survives a restart too, with the file it came from gone', async () => {
    let started = await start();
    const { id } = await startEdit(started.app);
    const folder = path.dirname(fileIn(profile, id!));
    writeFileSync(path.join(folder, 'saved as.txt'), 'under a new name');
    await expect.poll(async () => (await list(started.page)).length, { timeout: 30_000 }).toBe(2);
    const before = (await list(started.page)).find((s) => s.savedAs)!;
    await started.app.close();
    rmSync(path.join(folder, 'report.txt'));

    started = await start();
    try {
      await expect.poll(async () => (await list(started.page)).find((s) => s.savedAs)?.name, { timeout: 30_000 }).toBe('saved as.txt');
      const session = (await list(started.page)).find((s) => s.savedAs)!;
      // The same session, not one found again: it remembers what was taken.
      expect(session.id).toBe(before.id);
      expect(textOf(await readBack(started.page, session.id))).toBe('under a new name');
    } finally {
      await started.app.close();
    }
  });

  test('at the start: old unchanged copies and leftovers go, changed ones stay', async () => {
    let started = await start();
    const fresh = await startEdit(started.app, { key: 'fresh', name: 'fresh.txt' });
    const stale = await startEdit(started.app, { key: 'stale', name: 'stale.txt' });
    const changed = await startEdit(started.app, { key: 'changed', name: 'changed.txt' });
    const ancient = await startEdit(started.app, { key: 'ancient', name: 'ancient.txt' });
    writeFileSync(fileIn(profile, changed.id!), 'edited');
    writeFileSync(fileIn(profile, ancient.id!), 'edited long ago');
    await changedSoon(started.page, changed.id!);
    await changedSoon(started.page, ancient.id!);
    await started.app.close();

    age(stale.id!, EDIT_UNCHANGED_KEEP_MS + 60_000);
    age(changed.id!, EDIT_UNCHANGED_KEEP_MS + 60_000);
    // Past every limit, for one nobody could ever be shown.
    age(ancient.id!, EDIT_CHANGED_MAX_MS + 60_000);
    // A crash before its record was written.
    const orphan = path.join(profile, 'edit-files', 'orphan', 'f');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(path.join(orphan, 'lost.txt'), 'mail');

    started = await start();
    try {
      await expect.poll(async () => (await list(started.page)).map((s) => s.name).sort()).toEqual(['changed.txt', 'fresh.txt']);
      const root = path.join(profile, 'edit-files');
      expect(readdirSync(root).sort()).toEqual([changed.id!, fresh.id!].sort());
      expect((await list(started.page)).find((s) => s.id === changed.id)).toMatchObject({ changed: true, lastChance: false });
    } finally {
      await started.app.close();
    }
  });

  test('after 30 days a changed copy is offered once more, and only then does it go', async () => {
    let started = await start();
    const { id } = await startEdit(started.app);
    writeFileSync(fileIn(profile, id!), 'edited a while ago');
    await changedSoon(started.page, id!);
    await started.app.close();
    age(id!, EDIT_CHANGED_KEEP_MS + 60_000);

    started = await start();
    try {
      // Nobody has seen this yet: however long it's been, it stays.
      await expect.poll(async () => (await list(started.page))[0], { timeout: 30_000 }).toMatchObject({ id, lastChance: true, changed: true });
      await advance(started.app, 2 * 24 * 60 * 60_000);
      await tick(started.app);
      expect(await list(started.page)).toHaveLength(1);

      await editCall(started.page, 'shown', id!);
      await tick(started.app);
      expect(await list(started.page)).toHaveLength(1);

      await advance(started.app, 2 * 24 * 60 * 60_000);
      await tick(started.app);
      expect(await list(started.page)).toEqual([]);
      expect(existsSync(path.join(profile, 'edit-files', id!))).toBe(false);
    } finally {
      await started.app.close();
    }
  });
});

test('a wipe takes everything, also with a policy at the start of a launch, and isn\'t done while a program holds a copy', async () => {
  test.skip(process.platform !== 'win32', 'The policy goes through the registry here.');
  const profile = tempProfile('editw');
  const policyRoot = `HKCU\\Software\\BulwarkTest\\Policies\\edit${process.pid}`;
  const reg = (...args: string[]) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  const policyArgs = [`--bulwark-test-policy-root=${policyRoot}`, '--bulwark-test-policy-poll=250'];
  const setWipe = (value: string) => {
    expect(reg('add', `${policyRoot}\\Machine`, '/v', 'WipeOfflineData', '/t', 'REG_SZ', '/d', value, '/f').status).toBe(0);
  };
  const wipesDone = () => (JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8')) as { policyWipes?: string[] }).policyWipes ?? [];
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
    const boot = `boot-${Date.now()}`;
    setWipe(boot);
    app = await launch(profile, '--standalone', ...policyArgs);
    await shownPage(app);
    await expect.poll(() => existsSync(path.join(profile, 'edit-files', next.id!)), { timeout: 60_000 }).toBe(false);
    await expect.poll(wipesDone, { timeout: 60_000 }).toContain(boot);

    // A copy a program holds: the wipe doesn't count as done, and is done once it's free.
    await whenOpen(app);
    await fakeOpener(app);
    const held = await startEdit(app, { key: 'held' });
    const holder = holdFile(fileIn(profile, held.id!), 'Read');
    const withHold = `held-${Date.now()}`;
    try {
      await holder.ready;
      setWipe(withHold);
      await expect.poll(async () => app!.evaluate(() => (globalThis as unknown as { __bulwarkOs: { edit: { sessions: () => { closing?: string }[] } } }).__bulwarkOs.edit.sessions().map((s) => s.closing)), { timeout: 60_000 }).toEqual(['forced']);
      await sleep(2000);
      expect(wipesDone()).not.toContain(withHold);
    } finally {
      holder.release();
      await holder.gone;
    }
    await app.close();
    app = await launch(profile, '--standalone', ...policyArgs);
    await shownPage(app);
    await expect.poll(wipesDone, { timeout: 60_000 }).toContain(withHold);
    expect(existsSync(path.join(profile, 'edit-files', held.id!))).toBe(false);
  } finally {
    await app?.close().catch(() => {});
    reg('delete', policyRoot, '/f');
    removeProfile(profile);
  }
});

test('the real shell.openPath runs the program the OS has for the type, and its save comes back', async () => {
  test.skip(process.platform !== 'win32', 'A file association made for the test: Windows only here.');
  const suffix = `bwe${Date.now().toString(36).slice(-6)}`;
  const extension = `.${suffix}`;
  const progId = `BulwarkEditTest${Date.now().toString(36)}`;
  const classes = 'HKCU\\Software\\Classes';
  const reg = (...args: string[]) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  expect(reg('query', `${classes}\\${extension}`).status).not.toBe(0);
  const profile = tempProfile('edito');
  let app: ElectronApplication | null = null;
  try {
    // Not an editor: a shell line that appends to the file it's given, and ends.
    expect(reg('add', `${classes}\\${extension}`, '/ve', '/d', progId, '/f').status).toBe(0);
    expect(reg('add', `${classes}\\${progId}\\shell\\open\\command`, '/ve', '/d', `"${process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'}" /d /c "echo edited by the program>>"%1""`, '/f').status).toBe(0);

    const started = await launchStandalone(profile, `--bulwark-test-edit-extension=${suffix}`);
    app = started.app;
    await whenOpen(app);
    const result = await startEdit(app, { name: `note${extension}`, text: 'first\r\n' });
    expect(result.ok).toBe(true);
    await changedSoon(started.page, result.id!);
    const back = await readBack(started.page, result.id!);
    expect(textOf(back)).toContain('edited by the program');
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
