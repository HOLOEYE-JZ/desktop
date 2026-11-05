// "Open with", "Choose another app" and Send to on the real app.
// Registry writes go to a key of this run's own under HKCU\Software\BulwarkTest, the Send to
// shortcut to a folder of its own: nothing here touches the user's Explorer.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { SEND_TO_NAME, WINDOWS_ATTACH_PROGID } from '../src/main/features/os-rules';
import { launch, removeProfile, shownPage, tempProfile, waitForLogin } from './helpers';

const win = process.platform === 'win32';
const BASE = `HKCU\\Software\\BulwarkTest\\open-with-${process.pid}`;
let run = 0;

function reg(...args: string[]): { ok: boolean; out: string } {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, out: result.stdout ?? '' };
}

function command(root: string, sub: string): string | null {
  const answer = reg('query', `${root}\\Software\\Classes\\${sub}\\shell\\open\\command`, '/ve');
  return answer.ok ? (/REG_SZ\s+(.*)/.exec(answer.out)?.[1]?.trim() ?? null) : null;
}

interface Started {
  app: ElectronApplication;
  page: Page;
  exe: string;
  sendTo: string;
  link: string;
  root: string;
  stop: () => Promise<void>;
}

interface Place {
  root: string;
  /** The Send to shortcut's path. */
  link: string;
  /** A scratch folder of the run's own, taken away with it. */
  folder: string;
}

async function start(options: { seed?: (place: Place) => void; openWithOff?: boolean } = {}): Promise<Started> {
  run += 1;
  const root = `${BASE}-${run}`;
  const policyRoot = `HKCU\\Software\\BulwarkTest\\Policies\\open-with-${process.pid}-${run}`;
  const folder = mkdtempSync(path.join(tmpdir(), 'bw-sendto-'));
  const sendTo = path.join(folder, 'SendTo');
  mkdirSync(sendTo);
  const link = path.join(sendTo, `${SEND_TO_NAME}.lnk`);
  options.seed?.({ root, link, folder });
  if (options.openWithOff) reg('add', `${policyRoot}\\Machine`, '/v', 'OpenWithEnabled', '/t', 'REG_DWORD', '/d', '0', '/f');
  const profile = tempProfile('ow');
  const app = await launch(
    profile,
    '--standalone',
    `--bulwark-test-registry-root=${root}`,
    `--bulwark-test-sendto-dir=${sendTo}`,
    `--bulwark-test-policy-root=${policyRoot}`,
  );
  const page = await shownPage(app);
  await waitForLogin(page);
  const exe = await app.evaluate(() => process.execPath);
  return {
    app, page, exe, sendTo, link, root,
    stop: async () => {
      await app.close().catch(() => {});
      reg('delete', root, '/f');
      reg('delete', policyRoot, '/f');
      rmSync(folder, { recursive: true, force: true });
      removeProfile(profile);
    },
  };
}

test.afterAll(() => {
  // The parents this file made, if nothing else is in them.
  for (const parent of ['HKCU\\Software\\BulwarkTest\\Policies', 'HKCU\\Software\\BulwarkTest']) {
    const answer = reg('query', parent);
    if (answer.ok && answer.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length <= 1) reg('delete', parent, '/f');
  }
});

test.describe('Open with and Send to on Windows', () => {
  test.skip(!win, 'Windows only');

  test('a start offers the app for documents, in "Choose another app" and in Send to, never as a default', async () => {
    const started = await start();
    try {
      const wanted = `"${started.exe}" -- "%1"`;
      await expect.poll(() => command(started.root, 'Bulwark.File.attach'), { timeout: 30_000 }).toBe(wanted);
      expect(command(started.root, `Applications\\${path.basename(started.exe)}`)).toBe(wanted);
      expect(reg('query', `${started.root}\\Software\\Classes\\.pdf\\OpenWithProgids`, '/v', 'Bulwark.File.attach').ok).toBe(true);
      // The type's own key holds no value of ours, its default (the program it opens with) included.
      expect(reg('query', `${started.root}\\Software\\Classes\\.pdf`).out).not.toContain('REG_');
      const link = path.join(started.sendTo, `${SEND_TO_NAME}.lnk`);
      await expect.poll(() => existsSync(link)).toBe(true);
      const read = await started.app.evaluate(({ shell }, file) => shell.readShortcutLink(file), link);
      expect(read.target.toLowerCase()).toBe(started.exe.toLowerCase());
      expect(read.args).toBe('--bulwark-send-to --');
    } finally {
      await started.stop();
    }
  });

  test('a policy forcing it off takes all of it away again, and leaves mail links alone', async () => {
    const first = await start();
    const { root, sendTo } = first;
    try {
      await expect.poll(() => command(root, 'Bulwark.File.attach'), { timeout: 30_000 }).not.toBeNull();
    } finally {
      await first.app.close().catch(() => {});
    }
    // The same keys and folder, now with the policy.
    const policyRoot = `HKCU\\Software\\BulwarkTest\\Policies\\open-with-${process.pid}-off`;
    reg('add', `${policyRoot}\\Machine`, '/v', 'OpenWithEnabled', '/t', 'REG_DWORD', '/d', '0', '/f');
    const profile = tempProfile('ow2');
    const app = await launch(profile, '--standalone', `--bulwark-test-registry-root=${root}`, `--bulwark-test-sendto-dir=${sendTo}`, `--bulwark-test-policy-root=${policyRoot}`);
    try {
      await waitForLogin(await shownPage(app));
      await expect.poll(() => command(root, 'Bulwark.File.attach'), { timeout: 30_000 }).toBeNull();
      expect(reg('query', `${root}\\Software\\Classes\\.pdf\\OpenWithProgids`, '/v', 'Bulwark.File.attach').ok).toBe(false);
      expect(existsSync(path.join(sendTo, `${SEND_TO_NAME}.lnk`))).toBe(false);
      expect(command(root, 'Bulwark.Url.mailto')).not.toBeNull();
    } finally {
      await app.close().catch(() => {});
      reg('delete', policyRoot, '/f');
      removeProfile(profile);
      await first.stop();
    }
  });
});

/** The Electron a run starts: what a start finds already registered counts as its own. */
const ELECTRON_EXE = createRequire(import.meta.url)('electron') as string;
const OTHER_EXE = 'C:\\Program Files\\Bulwark Old\\Bulwark.exe';
const NOTEPAD = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe');

function writeCommand(root: string, id: string, exe: string): void {
  expect(reg('add', `${root}\\Software\\Classes\\${id}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', `"${exe}" -- "%1"`, '/f').ok).toBe(true);
}

/** The mail keys (bulwark:) and the Open with keys (the attach class), each for `exe`. */
function writeKeys(root: string, mail: string, openWith: string): void {
  writeCommand(root, 'bulwark', mail);
  writeCommand(root, WINDOWS_ATTACH_PROGID, openWith);
}

/** As Windows Script Host writes one, which is how the installer's and another program's come. */
function makeShortcut(link: string, target: string, args: string, description = ''): void {
  const script = '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:BW_LINK); $s.TargetPath = $env:BW_TARGET; $s.Arguments = $env:BW_ARGS; $s.Description = $env:BW_DESC; $s.IconLocation = $env:BW_TARGET + \',0\'; $s.Save()';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, BW_LINK: link, BW_TARGET: target, BW_ARGS: args, BW_DESC: description },
  });
  expect(result.status).toBe(0);
  expect(existsSync(link)).toBe(true);
}

test.describe('the Send to shortcut at a start', () => {
  test.skip(!win, 'Windows only');

  const read = (started: Started) => started.app.evaluate(({ shell }, file) => {
    const found = shell.readShortcutLink(file);
    return { target: found.target.toLowerCase(), args: found.args, icon: (found.icon ?? '').toLowerCase(), description: found.description };
  }, started.link);
  /** What the start writes, written. */
  const settled = (started: Started) => started.app.evaluate(async () => {
    await (globalThis as unknown as { __bulwarkOs: { defaultApp: { settled?: () => Promise<void> } } }).__bulwarkOs.defaultApp.settled?.();
  });
  const wanted = (started: Started) => ({ target: started.exe.toLowerCase(), args: '--bulwark-send-to --', icon: started.exe.toLowerCase(), description: 'Attach to a new message in Bulwark' });

  async function startWith(options: Parameters<typeof start>[0]): Promise<Started> {
    const started = await start(options);
    // Otherwise "the keys are this exe's" below wouldn't be true, and every start would rewrite.
    expect(started.exe.toLowerCase()).toBe(ELECTRON_EXE.toLowerCase());
    return started;
  }

  test('ours pointing at another program is pointed at this exe, though the keys are already this exe\'s', async () => {
    const started = await startWith({
      seed: ({ root, link }) => {
        writeKeys(root, ELECTRON_EXE, ELECTRON_EXE);
        makeShortcut(link, NOTEPAD, '--bulwark-send-to --', 'Attach to a new message in Bulwark');
      },
    });
    try {
      await expect.poll(() => read(started), { timeout: 30_000 }).toEqual(wanted(started));
    } finally {
      await started.stop();
    }
  });

  test('ours whose exe is gone (a deleted test pack\'s) is pointed at this exe', async () => {
    const started = await startWith({
      seed: ({ root, link, folder }) => {
        writeKeys(root, ELECTRON_EXE, ELECTRON_EXE);
        const pack = path.join(folder, 'pack');
        mkdirSync(pack);
        writeFileSync(path.join(pack, 'Bulwark.exe'), '');
        // The installer's own: the marker on the command line, no description.
        makeShortcut(link, path.join(pack, 'Bulwark.exe'), '--bulwark-send-to --');
        rmSync(pack, { recursive: true, force: true });
      },
    });
    try {
      await expect.poll(() => read(started), { timeout: 30_000 }).toEqual(wanted(started));
    } finally {
      await started.stop();
    }
  });

  test('another program\'s shortcut of the same name stays as it is, also when the keys are written again', async () => {
    const started = await startWith({
      seed: ({ root, link }) => {
        writeKeys(root, OTHER_EXE, OTHER_EXE);
        makeShortcut(link, NOTEPAD, '/p', 'Print it');
      },
    });
    try {
      await expect.poll(() => command(started.root, WINDOWS_ATTACH_PROGID), { timeout: 30_000 }).toBe(`"${started.exe}" -- "%1"`);
      await settled(started);
      expect(await read(started)).toEqual({ target: NOTEPAD.toLowerCase(), args: '/p', icon: NOTEPAD.toLowerCase(), description: 'Print it' });
    } finally {
      await started.stop();
    }
  });

  test('another program\'s shortcut of the same name stays when the policy takes Send to away', async () => {
    const started = await startWith({
      seed: ({ link }) => makeShortcut(link, NOTEPAD, '/p', 'Print it'),
      openWithOff: true,
    });
    try {
      await settled(started);
      expect(existsSync(started.link)).toBe(true);
      expect(await read(started)).toMatchObject({ target: NOTEPAD.toLowerCase(), args: '/p' });
    } finally {
      await started.stop();
    }
  });

  test('mail keys of another copy, Open with keys already this exe\'s (an installer\'s): the missing shortcut comes back', async () => {
    const started = await startWith({ seed: ({ root }) => writeKeys(root, OTHER_EXE, ELECTRON_EXE) });
    try {
      await expect.poll(() => command(started.root, 'bulwark'), { timeout: 30_000 }).toBe(`"${started.exe}" -- "%1"`);
      await expect.poll(() => existsSync(started.link), { timeout: 30_000 }).toBe(true);
      expect(await read(started)).toEqual(wanted(started));
    } finally {
      await started.stop();
    }
  });

  test('a shortcut the user deleted while the keys stayed this exe\'s isn\'t put back', async () => {
    const started = await startWith({ seed: ({ root }) => writeKeys(root, ELECTRON_EXE, ELECTRON_EXE) });
    try {
      await settled(started);
      expect(existsSync(started.link)).toBe(false);
    } finally {
      await started.stop();
    }
  });
});

test.describe('files handed to the app', () => {
  let started: Started;
  let folder = '';

  test.beforeAll(async () => {
    started = await start();
    folder = mkdtempSync(path.join(tmpdir(), 'bw-files-'));
    await started.page.evaluate(() => {
      const w = window as unknown as { __cmds: unknown[]; bulwarkDesktop: { os: { onCommand: (l: (c: unknown) => void) => void } } };
      w.__cmds = [];
      w.bulwarkDesktop.os.onCommand((command) => w.__cmds.push(command));
    });
  });

  test.afterAll(async () => {
    await started?.stop();
    rmSync(folder, { recursive: true, force: true });
  });

  const handle = (argv: string[]) => started.app.evaluate((_e, args) => (globalThis as unknown as { __bulwarkOs: { launch: { handle: (a: string[], c: string) => Promise<number> } } }).__bulwarkOs.launch.handle(args, 'C:\\'), argv);
  const taken = () => started.page.evaluate(() => {
    const w = window as unknown as { __cmds: { type: string; reason?: string; ask?: boolean; files?: { name: string }[]; failed?: string[] }[] };
    const list = w.__cmds.map((c) => ({ type: c.type, reason: c.reason, ask: c.ask, names: (c.files ?? []).map((f) => f.name), failed: c.failed }));
    w.__cmds = [];
    return list;
  });

  test('"Open with" on several files, one launch each, puts them all on one message', async () => {
    const pdf = path.join(folder, 'report.pdf');
    const png = path.join(folder, 'chart.png');
    writeFileSync(pdf, '%PDF-1.4');
    writeFileSync(png, 'png');
    await handle(['Bulwark.exe', '--', pdf]);
    await handle(['Bulwark.exe', '--', png]);
    await expect.poll(taken, { timeout: 10_000 }).toEqual([{ type: 'files', reason: 'attach', ask: undefined, names: ['report.pdf', 'chart.png'], failed: [] }]);
  });

  test('Send to puts everything on one message without asking, an .eml too', async () => {
    const pdf = path.join(folder, 'a.pdf');
    const eml = path.join(folder, 'old.eml');
    writeFileSync(pdf, '%PDF-1.4');
    writeFileSync(eml, 'Subject: x\r\n\r\nbody');
    await handle(['Bulwark.exe', '--bulwark-send-to', '--', pdf, eml]);
    await expect.poll(taken, { timeout: 10_000 }).toEqual([{ type: 'files', reason: 'attach', ask: undefined, names: ['a.pdf', 'old.eml'], failed: [] }]);
  });

  test('an 8.3 short name Explorer passes on a long command line comes back as the real name', async () => {
    test.skip(!win, 'Windows only');
    const long = path.join(folder, 'Quarterly report for the board.pdf');
    writeFileSync(long, '%PDF-1.4');
    const short = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:BW_LONG).ShortPath'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, BW_LONG: long } }).stdout.trim();
    test.skip(!short || path.basename(short) === path.basename(long), 'no short names on this volume');
    await handle(['Bulwark.exe', '--bulwark-send-to', '--', short]);
    await expect.poll(taken, { timeout: 10_000 }).toEqual([{ type: 'files', reason: 'attach', ask: undefined, names: ['Quarterly report for the board.pdf'], failed: [] }]);
  });
});
