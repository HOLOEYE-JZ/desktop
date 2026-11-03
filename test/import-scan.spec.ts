import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { readVCards, countContacts, vCardFromProperties } from '../src/main/import-books';
import { ImportGrants, validateConfirmed, validateContent, type ConfirmedFile } from '../src/main/import-files';
import { dataFileType, parseProfilesIni, profileInUse, scanForMailData, thunderbirdHomes, type ScanEnv } from '../src/main/import-scan';
import { makeThunderbirdProfile } from './fixtures/make-thunderbird-profile';

const PST = path.join(import.meta.dirname, 'fixtures', 'Outlook.pst');
const ORIGIN = 'https://app.bulwark.localhost';

function workspace(): { base: string; env: ScanEnv; done: () => void } {
  const base = mkdtempSync(path.join(tmpdir(), 'bw-scan-'));
  const documents = path.join(base, 'Documents');
  const localAppData = path.join(base, 'Local');
  mkdirSync(documents, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return {
    base,
    env: { platform: 'win32', home: base, appData: path.join(base, 'AppData'), localAppData, documents },
    done: () => rmSync(base, { recursive: true, force: true }),
  };
}

const link = (target: string, at: string) => symlinkSync(target, at, 'junction');

test.describe('finding Thunderbird profiles', () => {
  test('profiles.ini: relative and absolute paths, only profile sections', () => {
    const ini = ['[General]', 'Path=not-a-profile', '[Install1]', 'Default=Profiles/x', '[Profile0]', 'Name=work', 'IsRelative=1', 'Path=Profiles/a.work', '[Profile1]', 'Name=old', 'IsRelative=0', 'Path=D:\\Mail\\old'].join('\r\n');
    const profiles = parseProfilesIni(ini, 'C:\\tb');
    expect(profiles).toEqual([
      { name: 'work', path: path.join('C:\\tb', 'Profiles', 'a.work') },
      { name: 'old', path: 'D:\\Mail\\old' },
    ]);
  });

  test('each OS looks where Thunderbird keeps profiles.ini', () => {
    const base = { home: '/h', appData: 'C:\\A', documents: '/d' };
    expect(thunderbirdHomes({ ...base, platform: 'win32' })).toEqual([path.join('C:\\A', 'Thunderbird')]);
    expect(thunderbirdHomes({ ...base, platform: 'darwin' })).toEqual([path.join('/h', 'Library', 'Thunderbird')]);
    const linux = thunderbirdHomes({ ...base, platform: 'linux' });
    expect(linux).toContain(path.join('/h', '.thunderbird'));
    expect(linux.some((home) => home.includes('org.mozilla.Thunderbird'))).toBe(true);
    expect(linux.some((home) => home.includes('snap'))).toBe(true);
  });

  test('it finds mbox and Maildir folders, maps .sbd to folders, and leaves out what is no mail', () => {
    const { base, env, done } = workspace();
    try {
      makeThunderbirdProfile(base, 'T1');
      const found = scanForMailData(env);
      const folders = found.files.map((file) => `${file.kind}:${file.folder.join('/')}`).sort();
      expect(folders).toEqual(['maildir:Maildir-T1', 'mbox:Fixture-T1', 'mbox:Fixture-T1/Year 2020', 'mbox:Inbox', 'mbox:Sent']);
      expect(found.files.every((file) => file.group === 'default' && file.account === 'Local Folders' && file.app === 'thunderbird')).toBe(true);
      // Stable across scans and different per folder: the checkpoint's key uses it.
      expect(new Set(found.files.map((file) => file.name)).size).toBe(found.files.length);
      expect(found.files.find((file) => file.kind === 'maildir')?.messages).toBe(3);
      expect(found.books.map((book) => book.name)).toEqual(['abook.sqlite']);
      expect(found.calendars).toBe(1);
    } finally {
      done();
    }
  });

  test('ImapMail is read as well', () => {
    const { base, env, done } = workspace();
    try {
      const { profileDir } = makeThunderbirdProfile(base, 'T2');
      const imap = path.join(profileDir, 'ImapMail', 'imap.example.org');
      mkdirSync(path.join(imap, 'INBOX.sbd'), { recursive: true });
      writeFileSync(path.join(imap, 'INBOX.sbd', 'Work'), 'From - Tue May 05 10:00:00 2020\r\nSubject: x\r\n\r\nbody\r\n\r\n');
      const file = scanForMailData(env).files.find((entry) => entry.account === 'imap.example.org');
      expect(file?.folder).toEqual(['INBOX', 'Work']);
    } finally {
      done();
    }
  });

  test('a junction in the profile is not followed', () => {
    const { base, env, done } = workspace();
    try {
      const { localFolders } = makeThunderbirdProfile(base, 'T3');
      const outside = path.join(base, 'Secret');
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'Stolen'), 'From - Tue May 05 10:00:00 2020\r\nSubject: secret\r\n\r\nbody\r\n\r\n');
      link(outside, path.join(localFolders, 'Evil.sbd'));
      const maildirOutside = path.join(base, 'SecretMaildir');
      mkdirSync(path.join(maildirOutside, 'cur'), { recursive: true });
      writeFileSync(path.join(maildirOutside, 'cur', 'one'), 'Subject: secret\r\n\r\nbody');
      link(maildirOutside, path.join(localFolders, 'EvilMaildir'));
      const names = scanForMailData(env).files.map((file) => file.folder.join('/'));
      expect(names.some((name) => name.includes('Evil'))).toBe(false);
      expect(names).toContain('Inbox');
    } finally {
      done();
    }
  });

  test('a Mail folder that is itself a junction out of the profile gives nothing', () => {
    const { base, env, done } = workspace();
    try {
      const { profileDir } = makeThunderbirdProfile(base, 'T4');
      const outside = path.join(base, 'SecretMail');
      mkdirSync(path.join(outside, 'acct'), { recursive: true });
      writeFileSync(path.join(outside, 'acct', 'Stolen'), 'From - Tue May 05 10:00:00 2020\r\nSubject: secret\r\n\r\nbody\r\n\r\n');
      link(outside, path.join(profileDir, 'ImapMail'));
      const found = scanForMailData(env).files.map((file) => file.folder.join('/'));
      expect(found).not.toContain('Stolen');
      expect(found).toContain('Inbox');
    } finally {
      done();
    }
  });

  test('a junction to another folder of the same profile does not list it twice', () => {
    const { base, env, done } = workspace();
    try {
      const { localFolders } = makeThunderbirdProfile(base, 'T6');
      link(path.join(localFolders, 'Fixture-T6.sbd'), path.join(localFolders, 'Again.sbd'));
      const found = scanForMailData(env).files.map((file) => file.folder.join('/'));
      expect(found.some((folder) => folder.startsWith('Again'))).toBe(false);
    } finally {
      done();
    }
  });

  test('profileInUse: parent.lock held with no sharing means running, one left behind does not', async () => {
    test.skip(process.platform !== 'win32', "Windows' lock file");
    const { base, done } = workspace();
    let holder: ChildProcess | null = null;
    try {
      const lock = path.join(base, 'parent.lock');
      expect(profileInUse(base, 'win32')).toBe(false);
      writeFileSync(lock, '');
      expect(profileInUse(base, 'win32')).toBe(false);
      holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${lock}','Open','ReadWrite','None'); Write-Output held; Start-Sleep 30`], { stdio: ['ignore', 'pipe', 'ignore'] });
      await new Promise<void>((resolve) => holder!.stdout!.once('data', () => resolve()));
      expect(profileInUse(base, 'win32')).toBe(true);
    } finally {
      holder?.kill();
      await new Promise((resolve) => setTimeout(resolve, 500));
      done();
    }
  });
});

test.describe('finding Outlook files', () => {
  test('it looks in the usual folders only, including a translated one, and not further down', () => {
    const { base, env, done } = workspace();
    try {
      const translated = path.join(env.documents, 'Outlook-Dateien');
      const local = path.join(env.localAppData!, 'Microsoft', 'Outlook');
      mkdirSync(translated, { recursive: true });
      mkdirSync(local, { recursive: true });
      copyFileSync(PST, path.join(translated, 'Archiv.pst'));
      copyFileSync(PST, path.join(local, 'Local.pst'));
      // Not a usual place.
      mkdirSync(path.join(base, 'Elsewhere'));
      copyFileSync(PST, path.join(base, 'Elsewhere', 'Other.pst'));
      copyFileSync(PST, path.join(env.documents, 'Loose.pst'));
      mkdirSync(path.join(translated, 'deeper'));
      copyFileSync(PST, path.join(translated, 'deeper', 'Deep.pst'));
      const names = scanForMailData(env).files.map((file) => file.name).sort();
      expect(names).toEqual(['Outlook/Archiv.pst', 'Outlook/Local.pst']);
    } finally {
      done();
    }
  });

  test('an .ost is refused with the reason, and so is an .ost called .pst', () => {
    const { env, done } = workspace();
    try {
      const local = path.join(env.localAppData!, 'Microsoft', 'Outlook');
      mkdirSync(local, { recursive: true });
      copyFileSync(PST, path.join(local, 'me@example.org.ost'));
      const disguised = readFileSync(PST);
      disguised.write('SO', 8, 'latin1');
      writeFileSync(path.join(local, 'renamed.pst'), disguised);
      expect(dataFileType(disguised)).toBe('ost');
      expect(dataFileType(readFileSync(PST))).toBe('pst');
      const found = scanForMailData(env);
      expect(found.files).toEqual([]);
      expect(found.refused.map((entry) => entry.name).sort()).toEqual(['me@example.org.ost', 'renamed.pst']);
      expect(found.refused.every((entry) => entry.reason === 'ost')).toBe(true);
    } finally {
      done();
    }
  });
});

test.describe('a PST that Outlook holds open', () => {
  test('is named as in use, not silently left out', async () => {
    test.skip(process.platform !== 'win32', "Windows' share modes");
    const { env, done } = workspace();
    let holder: ChildProcess | null = null;
    try {
      const folder = path.join(env.documents, 'Outlook Files');
      mkdirSync(folder, { recursive: true });
      const file = path.join(folder, 'Open.pst');
      copyFileSync(PST, file);
      expect(scanForMailData(env).files.map((entry) => entry.name)).toEqual(['Outlook/Open.pst']);
      holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${file}','Open','ReadWrite','None'); Write-Output held; Start-Sleep 30`], { stdio: ['ignore', 'pipe', 'ignore'] });
      await new Promise<void>((resolve) => holder!.stdout!.once('data', () => resolve()));
      const found = scanForMailData(env);
      expect(found.files).toEqual([]);
      expect(found.refused).toEqual([{ name: 'Open.pst', reason: 'in-use' }]);
    } finally {
      holder?.kill();
      await new Promise((resolve) => setTimeout(resolve, 500));
      done();
    }
  });
});

test.describe('address books', () => {
  test('a modern and an old card both become vCards', async () => {
    const { base, env, done } = workspace();
    try {
      const { profileDir } = makeThunderbirdProfile(base, 'T5');
      const file = scanForMailData(env).books[0].path;
      expect(file).toBe(path.join(profileDir, 'abook.sqlite'));
      expect(await countContacts(file)).toBe(2);
      const cards = await readVCards(file);
      expect(cards).toHaveLength(2);
      expect(cards.find((card) => card.includes('Ada'))).toContain('EMAIL:ada-T5@example.org');
      expect(cards.find((card) => card.includes('Grace'))).toContain('EMAIL;TYPE=pref:grace-T5@example.org');
    } finally {
      done();
    }
  });

  test('values are escaped, and a card with nothing on it is left out', () => {
    expect(vCardFromProperties(new Map([['DisplayName', 'A, B;C']]))).toContain('FN:A\\, B\\;C');
    expect(vCardFromProperties(new Map([['Custom1', 'x']]))).toBeNull();
  });
});

test.describe('reading confirmed files', () => {
  // A Request can't be made for an unknown scheme everywhere, so this hands over what serve reads.
  const request = (url: string, range?: string) => ({ method: 'GET', url, headers: new Headers(range ? { range } : {}) }) as unknown as Request;

  function confirmed(base: string, name = 'Inbox'): ConfirmedFile {
    const root = path.join(base, 'root');
    mkdirSync(root, { recursive: true });
    const file = path.join(root, name);
    writeFileSync(file, `From - x\r\n${'a'.repeat(1000)}`);
    return { path: file, root, kind: 'mbox', name, folder: [name] };
  }

  test('a token gives ranges of its file and nothing else', async () => {
    const { base, done } = workspace();
    try {
      const grants = new ImportGrants(ORIGIN);
      const file = confirmed(base);
      const granted = grants.add('job', file);
      expect(granted.url).toMatch(/^bulwark-import:\/\/f\/[\w-]{43}$/);
      const answer = await grants.serve(request(granted.url, 'bytes=0-5'));
      expect(answer.status).toBe(206);
      expect(answer.headers.get('content-range')).toBe(`bytes 0-5/${granted.size}`);
      expect(answer.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      expect(Buffer.from(await answer.arrayBuffer()).toString()).toBe('From -');
      // Past the end stops at the end.
      const tail = await grants.serve(request(granted.url, `bytes=${granted.size - 2}-${granted.size + 100}`));
      expect((await tail.arrayBuffer()).byteLength).toBe(2);
      // Always a range: no whole-file copy.
      expect((await grants.serve(request(granted.url))).status).toBe(416);
      expect((await grants.serve(request(granted.url, 'bytes=0-999999999'))).status).toBe(206);
      // A token nobody handed out, a traversal, and anything path-like.
      expect((await grants.serve(request(`bulwark-import://f/${'A'.repeat(43)}`, 'bytes=0-5'))).status).toBe(404);
      expect((await grants.serve(request(`${granted.url}/../../secret`, 'bytes=0-5'))).status).toBe(404);
      expect((await grants.serve(request(`bulwark-import://f/C:/Windows/win.ini`, 'bytes=0-5'))).status).toBe(404);
    } finally {
      done();
    }
  });

  test('after release the token is dead', async () => {
    const { base, done } = workspace();
    try {
      const grants = new ImportGrants(ORIGIN);
      const granted = grants.add('job', confirmed(base));
      expect((await grants.serve(request(granted.url, 'bytes=0-5'))).status).toBe(206);
      await grants.release('job');
      expect((await grants.serve(request(granted.url, 'bytes=0-5'))).status).toBe(404);
    } finally {
      done();
    }
  });

  test('a folder swapped for a junction after confirming is refused at the first read', async () => {
    const { base, done } = workspace();
    try {
      const file = confirmed(base);
      const grants = new ImportGrants(ORIGIN);
      const granted = grants.add('job', file);
      const secret = path.join(base, 'secret');
      mkdirSync(secret);
      writeFileSync(path.join(secret, 'Inbox'), 'From - secret '.repeat(100));
      renameSync(file.root, `${file.root}.moved`);
      link(secret, file.root);
      expect(validateConfirmed(file)).toBe('moved');
      const answer = await grants.serve(request(granted.url, 'bytes=0-5'));
      expect(answer.status).toBe(403);
      unlinkSync(file.root);
    } finally {
      done();
    }
  });

  test('a compacted folder answers 409, and what is appended stays out', async () => {
    const { base, done } = workspace();
    try {
      const file = confirmed(base);
      const grants = new ImportGrants(ORIGIN);
      const granted = grants.add('job', file);
      writeFileSync(file.path, `${readFileSync(file.path, 'latin1')}From - later\r\n`);
      expect((await grants.serve(request(granted.url, `bytes=${granted.size}-${granted.size + 5}`))).status).toBe(416);
      writeFileSync(file.path, 'From - short');
      expect((await grants.serve(request(granted.url, 'bytes=0-5'))).status).toBe(409);
    } finally {
      done();
    }
  });

  test('Maildir messages come by position, and a message replaced by a link is refused', async () => {
    const { base, done } = workspace();
    try {
      const root = path.join(base, 'root');
      const dir = path.join(root, 'Box');
      mkdirSync(path.join(dir, 'cur'), { recursive: true });
      writeFileSync(path.join(dir, 'cur', '1'), 'first');
      writeFileSync(path.join(dir, 'cur', '2'), 'second');
      const grants = new ImportGrants(ORIGIN);
      const granted = grants.add('job', { path: dir, root, kind: 'maildir', name: 'Box', folder: ['Box'] });
      expect(granted.entrySizes).toEqual([5, 6]);
      expect(await (await grants.serve(request(`${granted.url}/0`))).text()).toBe('first');
      expect(await (await grants.serve(request(`${granted.url}/1`))).text()).toBe('second');
      expect((await grants.serve(request(`${granted.url}/2`))).status).toBe(404);
      // The folder itself has no bytes.
      expect((await grants.serve(request(granted.url, 'bytes=0-1'))).status).toBe(404);

      const outside = path.join(base, 'outside');
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'x'), 'secret');
      rmSync(path.join(dir, 'cur', '2'));
      try {
        symlinkSync(path.join(outside, 'x'), path.join(dir, 'cur', '2'), 'file');
      } catch {
        test.skip(true, 'file symlinks need Developer Mode here');
      }
      expect((await grants.serve(request(`${granted.url}/1`))).status).toBe(403);
    } finally {
      done();
    }
  });

  test('validation: a path outside the root, an .ost and a file that stopped being mail are refused', async () => {
    const { base, done } = workspace();
    try {
      const file = confirmed(base);
      const other = path.join(base, 'other');
      mkdirSync(other);
      writeFileSync(path.join(other, 'Inbox'), 'From - x\r\n');
      expect(validateConfirmed({ ...file, path: path.join(other, 'Inbox') })).toBe('outside');
      expect(validateConfirmed({ ...file, path: path.join(file.root, 'gone') })).toBe('gone');
      const ost = path.join(file.root, 'x.ost');
      writeFileSync(ost, 'x');
      expect(validateConfirmed({ ...file, path: ost, kind: 'pst' })).toBe('ost');
      expect(await validateContent(file)).toBeNull();
      writeFileSync(file.path, 'not mail any more');
      expect(await validateContent(file)).toBe('not-mail');
      const disguised = readFileSync(PST).subarray(0, 512);
      disguised.write('SO', 8, 'latin1');
      const pstPath = path.join(file.root, 'a.pst');
      writeFileSync(pstPath, disguised);
      expect(await validateContent({ ...file, path: pstPath, kind: 'pst' })).toBe('ost');
    } finally {
      done();
    }
  });
});
