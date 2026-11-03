import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { buildCrashUpload, listCrashFiles, removeAllCrashFiles, scrubMinidump, sweepCrashFiles, validUploadUrl } from '../src/main/crash-files';
import { MainErrorCounter, fingerprintOfMainError, mainErrorName } from '../src/main/main-errors';
import { normalizeStack } from '../src/server/protocol';
import { buildDesktopErrorBatch } from '../src/shared/desktop-telemetry';

const DASHBOARD = process.env.BULWARK_DASHBOARD_DIR ?? 'C:/Users/info/Downloads/jmap-webmail/repos/dashboard';
const VALIDATE = path.join(DASHBOARD, 'telemetry-collector/src/validate.ts');

function folder(): string {
  return mkdtempSync(path.join(tmpdir(), 'bw-crash-'));
}

/** Age in days, so nothing depends on how long a test takes. */
function plant(dir: string, id: string, bytes: number, daysOld: number, sub = 'reports'): string {
  mkdirSync(path.join(dir, sub), { recursive: true });
  const file = path.join(dir, sub, `${id}.dmp`);
  writeFileSync(file, Buffer.alloc(bytes, 1));
  const when = new Date(Date.now() - daysOld * 86_400_000);
  utimesSync(file, when, when);
  return file;
}

const ids = (dir: string) => listCrashFiles(dir).map((crash) => crash.id);

test.describe('the minidump cap', () => {
  const limits = { count: 3, bytes: 1000, ageMs: 30 * 86_400_000 };

  test('keeps the newest by count', () => {
    const dir = folder();
    for (const [index, id] of ['a', 'b', 'c', 'd', 'e'].entries()) plant(dir, id, 10, index);
    expect(sweepCrashFiles(dir, limits)).toBe(2);
    expect(ids(dir)).toEqual(['a', 'b', 'c']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('keeps the newest by bytes, and one too big for the cap goes', () => {
    const dir = folder();
    plant(dir, 'new', 600, 0);
    plant(dir, 'middle', 300, 1);
    plant(dir, 'old', 300, 2);
    sweepCrashFiles(dir, limits);
    expect(ids(dir)).toEqual(['new', 'middle']);
    plant(dir, 'huge', 5000, -1);
    sweepCrashFiles(dir, limits);
    expect(ids(dir)).toEqual(['new', 'middle']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('removes what has grown old, whatever the count', () => {
    const dir = folder();
    plant(dir, 'fresh', 10, 1);
    plant(dir, 'stale', 10, 40);
    sweepCrashFiles(dir, limits);
    expect(ids(dir)).toEqual(['fresh']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('finds the folders each OS uses, and takes only dumps', () => {
    const dir = folder();
    plant(dir, 'win', 10, 0, 'reports');
    plant(dir, 'mac', 10, 1, 'completed');
    plant(dir, 'linux', 10, 2, 'pending');
    writeFileSync(path.join(dir, 'reports', 'metadata'), 'x');
    writeFileSync(path.join(dir, 'settings.dat'), 'x');
    expect(ids(dir)).toEqual(['win', 'mac', 'linux']);
    removeAllCrashFiles(dir);
    expect(ids(dir)).toEqual([]);
    // Crashpad's own files stay: it needs them to keep working.
    expect(existsSync(path.join(dir, 'settings.dat'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('takes a dump\'s attachments with it', () => {
    const dir = folder();
    plant(dir, 'gone', 10, 0);
    mkdirSync(path.join(dir, 'attachments', 'gone'), { recursive: true });
    writeFileSync(path.join(dir, 'attachments', 'gone', 'log'), 'x');
    removeAllCrashFiles(dir);
    expect(existsSync(path.join(dir, 'attachments', 'gone'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a folder that isn\'t there is no crash files', () => {
    expect(listCrashFiles(path.join(tmpdir(), 'bw-no-such-folder'))).toEqual([]);
    expect(sweepCrashFiles(path.join(tmpdir(), 'bw-no-such-folder'))).toBe(0);
  });
});

test.describe('scrubbing a minidump', () => {
  const names = { home: 'C:\\Users\\Linus Rath', username: 'linusr', hostname: 'DESKTOP-ABC123' };
  const utf16 = (text: string) => Buffer.from(text, 'utf16le');
  const ascii = (text: string) => Buffer.from(text, 'latin1');
  const has = (bytes: Buffer, text: string) => bytes.includes(ascii(text)) || bytes.includes(utf16(text));

  const SECRETS = [
    'C:\\Users\\Linus Rath\\AppData\\Roaming\\Bulwark\\x.log',
    'C:/Users/Linus Rath/AppData/y.log',
    'linusr',
    'DESKTOP-ABC123',
    'ceo.private@acme-corp.example',
    'Bearer abc.def-123_456',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P',
    'Subject: Merger plans for Acme Q3',
    '"subject":"Merger plans for Acme Q3"',
    '"preview":"We should buy them before the board meets"',
    'Xq7vLm2pR9sT4wZ8yB1nC6kD3fH5jG0aXq7vLm2p',
  ];

  for (const secret of SECRETS) {
    test(`takes out ${secret.slice(0, 30)} as bytes and as UTF-16, at the same length`, () => {
      const before = Buffer.concat([ascii('MDMP\0\0\x01\x02'), ascii(secret), Buffer.from([0, 255, 0]), utf16(secret), Buffer.from([0, 0, 7])]);
      const copy = Buffer.from(before);
      const after = scrubMinidump(before, names);
      expect(after.length).toBe(before.length);
      // The original is left alone: this is a copy for sending.
      expect(before.equals(copy)).toBe(true);
      // A file still begins as a minidump, and its binary parts don't move.
      expect(after.subarray(0, 8).equals(before.subarray(0, 8))).toBe(true);
      expect(after[8 + secret.length + 1]).toBe(255);
      expect(has(after, secret)).toBe(false);
    });
  }

  test('names and addresses go in any case', () => {
    const after = scrubMinidump(ascii('at c:\\users\\linus rath\\x and LINUSR and CEO.Private@Acme-Corp.example'), names);
    const text = after.toString('latin1');
    expect(text.toLowerCase()).not.toContain('linus');
    expect(text.toLowerCase()).not.toContain('acme');
  });

  test('a very short user name doesn\'t blank the file', () => {
    const body = 'a normal word appears here';
    expect(scrubMinidump(ascii(body), { home: '', username: 'a', hostname: '' }).toString('latin1')).toBe(body);
  });

  test('the words around them stay, so the file is still worth reading', () => {
    const after = scrubMinidump(ascii('electron.exe crashed in v8.dll near linusr'), names).toString('latin1');
    expect(after).toContain('electron.exe crashed in v8.dll');
  });
});

test.describe('where a crash file may go', () => {
  const allowed: [string, string][] = [
    ['https://crash.example.org/upload', 'https://crash.example.org/upload'],
    ['  https://crash.example.org/  ', 'https://crash.example.org/'],
    ['http://localhost:9000/x', 'http://localhost:9000/x'],
    ['http://127.0.0.1:9000/x', 'http://127.0.0.1:9000/x'],
  ];
  for (const [input, expected] of allowed) {
    test(`takes ${input.trim()}`, () => expect(validUploadUrl(input)).toBe(expected));
  }
  for (const input of ['http://crash.example.org/', 'http://192.168.1.5/x', 'ftp://crash.example.org/', 'https://user:pw@crash.example.org/', 'file:///C:/x', 'javascript:alert(1)', 'nonsense', '', 5, null, undefined]) {
    test(`refuses ${String(input)}`, () => expect(validUploadUrl(input)).toBeNull());
  }
});

test.describe('the upload', () => {
  test('has the dump and the named facts, and nothing of the file\'s name or place', () => {
    const dump = Buffer.from('MDMP\0binary\xff');
    const upload = buildCrashUpload(dump, { prod: 'Bulwark', ver: '0.3.0', platform: 'win32', build: 'desktop.instance.beta' }, 'edge');
    expect(upload.contentType).toBe('multipart/form-data; boundary=edge');
    const body = upload.body.toString('latin1');
    expect(body).toContain('name="upload_file_minidump"; filename="crash.dmp"');
    expect(body).toContain('name="ver"\r\n\r\n0.3.0');
    expect(body).toContain('name="build"\r\n\r\ndesktop.instance.beta');
    expect(upload.body.includes(dump)).toBe(true);
    expect(body.endsWith('--edge--\r\n')).toBe(true);
  });
});

test.describe('main-process stacks', () => {
  const posix = '/home/linus/.local/share/Bulwark/resources/app.asar/dist';
  const windows = 'C:\\Users\\Linus Rath\\AppData\\Local\\Programs\\Bulwark\\resources\\app.asar\\dist';

  test('an ESM stack on Windows loses the path to the app', () => {
    const stack = `TypeError: x\n    at send (file:///C:/Users/Linus%20Rath/x.js:1:1)\n    at ping (file:///${windows.replace(/\\/g, '/')}/main.mjs:10:5)`;
    const out = normalizeStack(stack, windows);
    expect(out).toContain('at ping (/desktop/main.mjs:10:5)');
    expect(out).not.toContain('AppData');
  });

  test('a plain path, a backslash path and POSIX do too', () => {
    expect(normalizeStack(`    at f (${windows}\\server-host.cjs:3:4)`, windows)).toBe('    at f (/desktop/server-host.cjs:3:4)');
    expect(normalizeStack(`    at f (${posix}/main.mjs:3:4)`, posix)).toBe('    at f (/desktop/main.mjs:3:4)');
    expect(normalizeStack(`    at file://${posix}/main.mjs:3:4`, posix)).toBe('    at /desktop/main.mjs:3:4');
  });

  test('a frame elsewhere isn\'t given the marker', () => {
    const line = '    at f (C:\\Users\\Linus Rath\\elsewhere\\x.js:1:1)';
    expect(normalizeStack(line, windows)).toBe(line);
    expect(normalizeStack('    at f (node:internal/x:1:1)', windows)).toBe('    at f (node:internal/x:1:1)');
  });
});

test.describe('counting main\'s errors, for instance mode', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const error = (name: string, at: string) => {
    const e = new Error('Merger plans for Acme');
    e.name = name;
    e.stack = `${name}: Merger plans for Acme\n    at f (C:\\Users\\linus\\x.js:${at})`;
    return e;
  };

  test('names and positions only, so nothing else can be in a fingerprint', () => {
    const one = fingerprintOfMainError('TypeError', '    at f (C:\\Users\\linus\\x.js:1:2)', '1.0.0');
    const two = fingerprintOfMainError('TypeError', '    at f (D:\\Users\\other\\y.js:1:2)', '1.0.0');
    expect(one).toBe(two);
    expect(one).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintOfMainError('TypeError', '    at f (x.js:3:2)', '1.0.0')).not.toBe(one);
  });

  test('an odd name becomes Error', () => {
    expect(mainErrorName(new TypeError('x'))).toBe('TypeError');
    expect(mainErrorName({ name: 'Merger plans' })).toBe('Error');
    expect(mainErrorName('a string')).toBe('Error');
    expect(mainErrorName(null)).toBe('Error');
  });

  test('sends what\'s new, then only what changed, and a new day starts again', () => {
    const counter = new MainErrorCounter('0.3.0');
    counter.note(error('TypeError', '1:2'), now);
    counter.note(error('TypeError', '1:2'), now);
    const first = counter.unsent(now);
    expect(first).toEqual([expect.objectContaining({ name: 'TypeError', count: 2, version: '0.3.0+desktop' })]);
    counter.markSent(first);
    expect(counter.unsent(now)).toEqual([]);
    counter.note(error('TypeError', '1:2'), now);
    expect(counter.unsent(now)[0].count).toBe(3);
    expect(counter.unsent(now + 86_400_000)).toEqual([]);
  });

  test('the collector\'s real validator takes the batch, with no message or path in it', async () => {
    test.skip(!existsSync(VALIDATE), 'the dashboard repo isn\'t here');
    const { validateErrorBatch } = await import(pathToFileURL(VALIDATE).href) as { validateErrorBatch(input: unknown, now?: number): { errors: unknown[] } | null };
    const counter = new MainErrorCounter('0.3.0');
    const at = Date.now();
    counter.note(error('TypeError', '1:2'), at);
    const batch = buildDesktopErrorBatch('f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b', at, counter.unsent(at));
    expect(validateErrorBatch(batch, at)).not.toBeNull();
    expect(JSON.stringify(batch)).not.toContain('Merger');
    expect(JSON.stringify(batch)).not.toContain('linus');
  });
});

test('the shell\'s copy of the pure module is the webmail\'s, byte for byte', () => {
  const webmail = process.env.BULWARK_WEBMAIL_DIR ?? 'C:/Users/info/worktrees/jmap-webmail-do-telemetry';
  const theirs = path.join(webmail, 'lib/desktop/desktop-telemetry.ts');
  test.skip(!existsSync(theirs), 'no webmail checkout here');
  const clean = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  expect(clean(path.join(import.meta.dirname, '..', 'src/shared/desktop-telemetry.ts'))).toBe(clean(theirs));
});
