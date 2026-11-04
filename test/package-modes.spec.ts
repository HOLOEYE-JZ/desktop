import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { findLooseModes, guardModes, tightenModes } from '../scripts/package-guard.mjs';
import { findBadEntries, parseListing, parseRpmModes, zipEntries } from '../scripts/verify-package-modes.mjs';

/**
 * A package's files have to belong to root alone: electron-builder's zip extraction sets the
 * modes stored in Electron's zip, past the umask, and they were 0777 and 0666. The tree gets
 * fixed and checked in after-pack, and the finished packages are read back by the release job.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const VERIFY = path.join(ROOT, 'scripts', 'verify-package-modes.mjs');

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'bw-modes-'));
}

/** The smallest zip with these names and Unix modes in its central directory. Enough to read. */
function zipWith(entries: { name: string; mode: number; host?: number }[]): Buffer {
  const central: Buffer[] = [];
  for (const { name, mode, host = 3 } of entries) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header[5] = host;
    header.writeUInt16LE(Buffer.byteLength(name), 28);
    header.writeUInt32LE(mode * 0x10000, 38);
    central.push(header, Buffer.from(name));
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(0, 16);
  return Buffer.concat([directory, end]);
}

test.describe('the tree, in after-pack', () => {
  test('the guard names what others can write to, and nothing else', () => {
    const dir = tempDir();
    try {
      mkdirSync(path.join(dir, 'locales'));
      for (const name of ['bulwark', 'chrome-sandbox', 'a.pak', 'ok', 'locales/en.pak', 'odd']) writeFileSync(path.join(dir, name), '');
      const modes: Record<string, number> = {
        bulwark: 0o777,
        'chrome-sandbox': 0o775,
        'a.pak': 0o666,
        ok: 0o755,
        locales: 0o755,
        'locales/en.pak': 0o644,
        odd: 0o4755,
      };
      // Injected: on Windows every file reads 0666, so this is the same everywhere.
      const stat = ((file: string) => {
        const relative = path.relative(dir, file).split(path.sep).join('/');
        return { mode: 0o100000 | modes[relative], isSymbolicLink: () => false };
      }) as never;
      expect(findLooseModes(dir, { stat, platform: 'linux' })).toEqual(['a.pak (0666)', 'bulwark (0777)', 'chrome-sandbox (0775)', 'odd (4755)']);
      expect(() => guardModes(dir, { stat, platform: 'linux' })).toThrow(/bulwark \(0777\)/);
      modes.bulwark = 0o755;
      modes['chrome-sandbox'] = 0o755;
      modes['a.pak'] = 0o644;
      modes.odd = 0o644;
      expect(() => guardModes(dir, { stat, platform: 'linux' })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Windows has no such modes: every file reads 0666 there, and that is no problem', () => {
    const dir = tempDir();
    try {
      writeFileSync(path.join(dir, 'a'), '');
      const stat = (() => ({ mode: 0o100666, isSymbolicLink: () => false })) as never;
      expect(findLooseModes(dir, { stat, platform: 'win32' })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('takes write away from others, keeps execute, and leaves what a link points at alone', () => {
    test.skip(process.platform === 'win32', 'chmod does not do this on Windows');
    const dir = tempDir();
    const outside = tempDir();
    try {
      mkdirSync(path.join(dir, 'sub'));
      chmodSync(path.join(dir, 'sub'), 0o777);
      writeFileSync(path.join(dir, 'sub', 'bin'), '');
      chmodSync(path.join(dir, 'sub', 'bin'), 0o777);
      writeFileSync(path.join(dir, 'a.pak'), '');
      chmodSync(path.join(dir, 'a.pak'), 0o666);
      writeFileSync(path.join(outside, 'theirs'), '');
      chmodSync(path.join(outside, 'theirs'), 0o666);
      symlinkSync(path.join(outside, 'theirs'), path.join(dir, 'link'));
      expect(findLooseModes(dir).length).toBe(3);

      tightenModes(dir);

      const mode = (file: string) => statSync(file).mode & 0o7777;
      expect(mode(path.join(dir, 'sub'))).toBe(0o755);
      expect(mode(path.join(dir, 'sub', 'bin'))).toBe(0o755);
      expect(mode(path.join(dir, 'a.pak'))).toBe(0o644);
      expect(mode(path.join(outside, 'theirs'))).toBe(0o666);
      expect(findLooseModes(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test.describe('the finished packages', () => {
  const sandbox = { suffix: 'opt/Bulwark/chrome-sandbox', mode: 0o755 };

  test('reads tar and unsquashfs listings', () => {
    const entries = parseListing(
      [
        'Parallel unsquashfs: Using 4 processors',
        'drwxr-xr-x root/root         0 2026-11-04 01:00 ./opt/',
        '-rwxrwxrwx root/root      1234 2026-11-04 01:00 ./opt/Bulwark/my file',
        '-rw-rw-rw- 0/0            1234 2026-11-04 01:00 squashfs-root/a.pak',
        '-rwsr-xr-x root/root       123 2026-11-04 01:00:12 ./opt/Bulwark/chrome-sandbox',
        'lrwxrwxrwx root/root         0 2026-11-04 01:00 ./usr/bin/bulwark -> /opt/Bulwark/bulwark',
      ].join('\n'),
    );
    expect(entries).toEqual([
      { path: './opt/', mode: 0o755, link: false },
      { path: './opt/Bulwark/my file', mode: 0o777, link: false },
      { path: 'squashfs-root/a.pak', mode: 0o666, link: false },
      { path: './opt/Bulwark/chrome-sandbox', mode: 0o4755, link: false },
      { path: './usr/bin/bulwark', mode: 0o777, link: true },
    ]);
    expect(findBadEntries(entries, sandbox)).toEqual([
      '0777 ./opt/Bulwark/my file',
      '0666 squashfs-root/a.pak',
      '4755 ./opt/Bulwark/chrome-sandbox',
      '4755 ./opt/Bulwark/chrome-sandbox: should be 755',
    ]);
  });

  test('reads rpm FILEMODES', () => {
    const entries = parseRpmModes('100777 /opt/Bulwark/bulwark\n100644 /opt/Bulwark/a.pak\n120777 /usr/bin/bulwark\n40755 /opt/Bulwark\n100755 /opt/Bulwark/chrome-sandbox\n');
    expect(findBadEntries(entries, sandbox)).toEqual(['0777 /opt/Bulwark/bulwark']);
  });

  test('an empty listing is no pass: what has to be there is missing', () => {
    expect(findBadEntries([], sandbox)).toEqual(['missing: opt/Bulwark/chrome-sandbox']);
  });

  test('the check fails the job on a bad zip, passes a good one, and fails on no packages', () => {
    const dir = tempDir();
    const run = () => spawnSync(process.execPath, [VERIFY, dir], { encoding: 'utf8' });
    const app = 'Bulwark.app/Contents/MacOS/Bulwark';
    try {
      expect(run().status, 'no packages').toBe(1);

      writeFileSync(path.join(dir, 'a.zip'), zipWith([{ name: app, mode: 0o100755 }, { name: 'Bulwark.app/Contents/Frameworks/x', mode: 0o100777 }]));
      const bad = run();
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('0777 Bulwark.app/Contents/Frameworks/x');

      writeFileSync(
        path.join(dir, 'a.zip'),
        zipWith([
          { name: app, mode: 0o100755 },
          { name: 'Bulwark.app/Contents/Resources/a.pak', mode: 0o100644 },
          { name: 'Bulwark.app/Contents/Frameworks/link', mode: 0o120777 },
        ]),
      );
      const good = run();
      expect(good.stderr).toBe('');
      expect(good.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a zip with no Unix modes counts as bad: nothing there says who can write', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'a.zip');
      writeFileSync(file, zipWith([{ name: 'a', mode: 0, host: 0 }]));
      expect(findBadEntries(zipEntries(file), undefined)).toEqual(['0777 a']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
