/**
 * Builds a small Thunderbird profile the way Thunderbird lays one out: profiles.ini,
 * mbox folders with .msf files next to them and `.sbd` folders for what's under them, a
 * Maildir folder, and an address book. Each message's subject and Message-ID carry a tag,
 * so a test on a shared server finds its own mail and nobody else's.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function message(tag: string, name: string, options: { status?: string; date?: string } = {}): string {
  const date = options.date ?? 'Tue, 05 May 2020 10:00:00 +0000';
  return [
    `Message-ID: <${name}.${tag}@fixture.example.org>`,
    `Date: ${date}`,
    'From: Fixture <fixture@example.org>',
    'To: Dave <ent-dave@example.org>',
    `Subject: ${tag} ${name}`,
    `X-Mozilla-Status: ${options.status ?? '0001'}`,
    'X-Mozilla-Status2: 00000000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Body of ${name}.`,
    'From the start of a line, this stays in the body.',
    '',
  ].join('\r\n');
}

export function mbox(tag: string, names: (string | { name: string; status: string })[]): string {
  return names
    .map((entry) => {
      const name = typeof entry === 'string' ? entry : entry.name;
      const status = typeof entry === 'string' ? undefined : entry.status;
      return `From - Tue May 05 10:00:00 2020\r\n${message(tag, name, { status }).replace(/^From the start/m, '>From the start')}\r\n`;
    })
    .join('');
}

export interface FixtureProfile {
  /** What goes where as `app.setPath('appData')`, with `Thunderbird/profiles.ini` under it. */
  appData: string;
  profileDir: string;
  localFolders: string;
  /** Every message that should arrive, by the folder it should arrive in. */
  expected: Record<string, string[]>;
}

export function makeThunderbirdProfile(base: string, tag: string): FixtureProfile {
  const appData = path.join(base, 'AppData');
  const home = path.join(appData, 'Thunderbird');
  const profileDir = path.join(home, 'Profiles', 'abc123.default');
  const localFolders = path.join(profileDir, 'Mail', 'Local Folders');
  mkdirSync(localFolders, { recursive: true });
  writeFileSync(
    path.join(home, 'profiles.ini'),
    ['[General]', 'StartWithLastProfile=1', 'Version=2', '', '[Profile0]', 'Name=default', 'IsRelative=1', 'Path=Profiles/abc123.default', 'Default=1', '', '[Install123]', 'Default=Profiles/abc123.default', ''].join('\r\n'),
  );
  const writeFolder = (relative: string, content: string) => {
    const file = path.join(localFolders, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    // Thunderbird's index: not mail, and starts with a line that is not an envelope.
    writeFileSync(`${file}.msf`, '// <!-- <mdb:mork:z v="1.4"/> -->\n');
  };
  writeFolder('Inbox', mbox(tag, ['in-1', 'in-2', { name: 'in-deleted', status: '0009' }]));
  writeFolder('Sent', mbox(tag, ['sent-1']));
  writeFolder('Drafts', mbox(tag, ['draft-1']));
  writeFolder(`Fixture-${tag}`, mbox(tag, ['top-1']));
  writeFolder(`Fixture-${tag}.sbd/Year 2020`, mbox(tag, ['deep-1', 'deep-2']));
  // What IMAP folders look like on the disk: modified UTF-7, and what isn't a mailbox next to it.
  const imap = path.join(profileDir, 'ImapMail', 'imap.example.org');
  mkdirSync(path.join(imap, `Entw&APw-rfe-${tag}.sbd`), { recursive: true });
  writeFileSync(path.join(imap, `Entw&APw-rfe-${tag}`), mbox(tag, ['imap-top']));
  writeFileSync(path.join(imap, `Entw&APw-rfe-${tag}.sbd`, 'Gr&APw-n'), mbox(tag, ['imap-deep']));
  writeFileSync(path.join(imap, 'imapfilterlog.html'), '<html></html>');
  // Empty folders stay off the list.
  writeFolder('Trash', '');
  // Files that aren't mail, next to it.
  writeFileSync(path.join(localFolders, 'msgFilterRules.dat'), 'version="9"\n');
  writeFileSync(path.join(localFolders, 'popstate.dat'), '# POP3 State File\n');

  // A Maildir folder of the same account.
  const maildir = path.join(localFolders, `Maildir-${tag}`);
  mkdirSync(path.join(maildir, 'cur'), { recursive: true });
  mkdirSync(path.join(maildir, 'tmp'), { recursive: true });
  writeFileSync(path.join(maildir, 'cur', '1588672800.000001.host'), message(tag, 'maildir-1'));
  writeFileSync(path.join(maildir, 'cur', '1588672801.000002.host'), `From - Tue May 05 10:00:00 2020\r\n${message(tag, 'maildir-2')}`);
  writeFileSync(path.join(maildir, 'cur', '1588672802.000003.host'), message(tag, 'maildir-deleted', { status: '0009' }));

  // What Thunderbird 102 and later write: the whole card in _vCard.
  const db = new DatabaseSync(path.join(profileDir, 'abook.sqlite'));
  db.exec('CREATE TABLE properties (card TEXT, name TEXT, value TEXT)');
  const insert = db.prepare('INSERT INTO properties VALUES (?, ?, ?)');
  insert.run('c1', '_vCard', `BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Ada ${tag}\r\nEMAIL:ada-${tag}@example.org\r\nEND:VCARD\r\n`);
  insert.run('c1', 'DisplayName', `Ada ${tag}`);
  // And what older ones write.
  insert.run('c2', 'DisplayName', `Grace ${tag}`);
  insert.run('c2', 'PrimaryEmail', `grace-${tag}@example.org`);
  db.close();

  mkdirSync(path.join(profileDir, 'calendar-data'), { recursive: true });
  writeFileSync(path.join(profileDir, 'calendar-data', 'local.sqlite'), '');

  return {
    appData,
    profileDir,
    localFolders,
    expected: {
      Inbox: ['in-1', 'in-2'],
      Sent: ['sent-1'],
      Drafts: ['draft-1'],
      [`Entwürfe-${tag}`]: ['imap-top'],
      [`Entwürfe-${tag}/Grün`]: ['imap-deep'],
      [`Fixture-${tag}`]: ['top-1'],
      [`Fixture-${tag}/Year 2020`]: ['deep-1', 'deep-2'],
      [`Maildir-${tag}`]: ['maildir-1', 'maildir-2'],
    },
  };
}
