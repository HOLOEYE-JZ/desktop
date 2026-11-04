// The Attach menu's recent files: what each OS's list says, and what of it shows. No Electron.
import { expect, test } from '@playwright/test';
import {
  displayFolder,
  displayName,
  newestCandidates,
  newestShortcuts,
  parseMdfind,
  parseXbel,
  RECENT_FILES_MAX,
  shownCandidates,
  usableShortcutTarget,
  type RecentCheck,
} from '../src/main/features/recent-rules';

test.describe('recent files, by the rules', () => {
  test('newest first, and the same file twice counts once at its newest', () => {
    const list = newestCandidates([
      { path: 'C:\\Docs\\old.docx', usedAt: 1 },
      { path: 'C:\\Docs\\Report.pdf', usedAt: 5 },
      { path: 'c:\\docs\\report.pdf', usedAt: 3 },
      { path: '\\\\server\\share\\plan.xlsx', usedAt: 4 },
    ], 'win32');
    expect(list.map((entry) => entry.path)).toEqual(['C:\\Docs\\Report.pdf', '\\\\server\\share\\plan.xlsx', 'C:\\Docs\\old.docx']);
    // Linux file names differ by case.
    expect(newestCandidates([{ path: '/a/A.txt', usedAt: 2 }, { path: '/a/a.txt', usedAt: 1 }], 'linux')).toHaveLength(2);
    expect(newestCandidates(Array.from({ length: 100 }, (_, i) => ({ path: `/f${i}`, usedAt: i })), 'linux', 60)).toHaveLength(60);
  });

  test('only what the check found to be a file shows, in order: a folder, a gone file and one that never answered drop out alone', () => {
    const candidates = ['a', 'folder', 'gone', 'offline', 'b'].map((name, index) => ({ path: `/x/${name}`, usedAt: 10 - index }));
    const checks = new Map<number, RecentCheck>([[0, 'file'], [1, 'other'], [2, 'missing'], [4, 'file']]);
    expect(shownCandidates(candidates, checks).map((entry) => entry.path)).toEqual(['/x/a', '/x/b']);
  });

  test('at most twenty', () => {
    const candidates = Array.from({ length: 30 }, (_, i) => ({ path: `/x/${i}`, usedAt: 100 - i }));
    const checks = new Map<number, RecentCheck>(candidates.map((_, i) => [i, 'file']));
    const shown = shownCandidates(candidates, checks);
    expect(shown).toHaveLength(RECENT_FILES_MAX);
    expect(shown[0].path).toBe('/x/0');
  });

  test('the folder line: a share stays a share, a home folder is ~', () => {
    expect(displayFolder('\\\\server\\share\\Team\\plan.docx', 'win32', 'C:\\Users\\me')).toBe('\\\\server\\share\\Team');
    expect(displayFolder('C:\\Users\\me\\Documents\\a.pdf', 'win32', 'C:\\Users\\me')).toBe('C:\\Users\\me\\Documents');
    expect(displayFolder('/home/me/Documents/a.pdf', 'linux', '/home/me')).toBe('~/Documents');
    expect(displayFolder('/home/me/a.pdf', 'linux', '/home/me')).toBe('~');
    expect(displayFolder('/home/meyer/a.pdf', 'linux', '/home/me')).toBe('/home/meyer');
    expect(displayName('\\\\server\\share\\Team\\plan.docx', 'win32')).toBe('plan.docx');
  });

  test('a shortcut counts when it points at a drive or a share, not at a shell item or a web address', () => {
    expect(usableShortcutTarget('C:\\Docs\\a.pdf')).toBe('C:\\Docs\\a.pdf');
    expect(usableShortcutTarget('\\\\server\\share\\a.pdf')).toBe('\\\\server\\share\\a.pdf');
    expect(usableShortcutTarget('::{20D04FE0-3AEA-1069-A2D8-08002B30309D}')).toBeNull();
    expect(usableShortcutTarget('\\\\?\\C:\\Docs\\a.pdf')).toBeNull();
    expect(usableShortcutTarget('https://example.com/a.pdf')).toBeNull();
    expect(usableShortcutTarget('')).toBeNull();
    expect(usableShortcutTarget(undefined)).toBeNull();
  });

  test('the Recent folder\'s shortcuts by the time each was written', () => {
    const entries = [
      { file: 'R\\a.lnk', mtimeMs: 1 },
      { file: 'R\\b.LNK', mtimeMs: 3 },
      { file: 'R\\desktop.ini', mtimeMs: 9 },
      { file: 'R\\c.lnk', mtimeMs: 2 },
    ];
    expect(newestShortcuts(entries).map((entry) => entry.file)).toEqual(['R\\b.LNK', 'R\\c.lnk', 'R\\a.lnk']);
    expect(newestShortcuts(entries, 1)).toHaveLength(1);
  });

  test('GTK\'s recently-used.xbel: local files only, at the newest of their times', () => {
    const xbel = `<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0" xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks">
  <bookmark href="file:///home/me/Documents/Q3%20report%20&amp;%20notes.pdf" added="2026-10-01T10:00:00.000000Z" modified="2026-10-02T10:00:00.000000Z" visited="2026-10-03T08:30:00.000000Z">
    <info><metadata owner="http://freedesktop.org"><mime:mime-type type="application/pdf"/></metadata></info>
  </bookmark>
  <bookmark href="sftp://host/home/me/remote.txt" added="2026-10-04T10:00:00Z" modified="2026-10-04T10:00:00Z" visited="2026-10-04T10:00:00Z"/>
  <bookmark href="file://otherhost/share/x.txt" added="2026-10-04T10:00:00Z"/>
  <bookmark href="file:///home/me/plan.ods" added="2026-09-01T00:00:00Z" modified="not a date"/>
</xbel>`;
    expect(parseXbel(xbel)).toEqual([
      { path: '/home/me/Documents/Q3 report & notes.pdf', usedAt: Date.parse('2026-10-03T08:30:00Z') },
      { path: '/home/me/plan.ods', usedAt: Date.parse('2026-09-01T00:00:00Z') },
    ]);
    expect(parseXbel('not xml at all')).toEqual([]);
  });

  test('Spotlight\'s answer: paths with spaces, the zone taken into account, Library left out', () => {
    const out = [
      '/Users/me/Documents/Board minutes 2026.docx   kMDItemLastUsedDate = 2026-10-30 09:12:44 +0000',
      '/Volumes/Team/plan.xlsx   kMDItemLastUsedDate = 2026-10-30 11:00:00 +0200',
      '/Users/me/Library/Mail/V10/x.emlx   kMDItemLastUsedDate = 2026-10-31 09:00:00 +0000',
      '/Users/me/odd.txt   kMDItemLastUsedDate = (null)',
      '',
    ].join('\n');
    expect(parseMdfind(out)).toEqual([
      { path: '/Users/me/Documents/Board minutes 2026.docx', usedAt: Date.parse('2026-10-30T09:12:44Z') },
      { path: '/Volumes/Team/plan.xlsx', usedAt: Date.parse('2026-10-30T09:00:00Z') },
    ]);
  });
});
