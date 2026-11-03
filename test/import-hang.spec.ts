import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { fakeOsIntegration, launchStandalone, removeProfile, tempProfile } from './helpers';
import { makeThunderbirdProfile, type FixtureProfile } from './fixtures/make-thunderbird-profile';

/**
 * A file on this computer can be anything, so nothing about it may be able to stop main. An
 * address book with `properties` as a view over an endless query used to hang the whole app.
 */

type Result = { ok: boolean; reason?: string; candidates?: { folder: string[]; handle: string }[]; books?: unknown[]; incomplete?: boolean };

const scan = (page: Page) =>
  page.evaluate(() => (window as never as { bulwarkDesktop: { localImport: { scan(): Promise<Result> } } }).bulwarkDesktop.localImport.scan());

/** How long main takes to answer, however long that is, up to a limit. */
async function roundTrip(app: ElectronApplication, limitMs: number): Promise<number> {
  const start = Date.now();
  await Promise.race([app.evaluate(() => 1), new Promise((resolve) => setTimeout(resolve, limitMs))]);
  return Date.now() - start;
}

/** Main answers throughout `work`: the slowest answer while it ran. */
async function slowestWhile<T>(app: ElectronApplication, work: Promise<T>, limitMs = 8000): Promise<{ slowest: number; value: T | undefined; finished: boolean }> {
  let finished = false;
  let value: T | undefined;
  void work.then((answer) => {
    value = answer;
    finished = true;
  });
  let slowest = 0;
  const until = Date.now() + 40_000;
  while (!finished && Date.now() < until) {
    slowest = Math.max(slowest, await roundTrip(app, limitMs));
    if (slowest >= limitMs) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { slowest, value, finished };
}

function hangingBook(file: string): void {
  rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE VIEW properties AS
    WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c)
    SELECT 'card' || x AS card, 'DisplayName' AS name, 'Nobody' AS value FROM c`);
  db.close();
}

test.describe('nothing on the disk can stop main', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let base: string;
  let fixture: FixtureProfile;
  let profile: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'bw-imphang-'));
    fixture = makeThunderbirdProfile(base, 'HANG');
    mkdirSync(path.join(base, 'Documents'), { recursive: true });
    profile = tempProfile('imphang');
  });

  test.afterEach(async () => {
    await app?.close().catch(() => undefined);
  });

  test.afterAll(() => {
    removeProfile(profile);
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  const start = async (...args: string[]) => {
    ({ app, page } = await launchStandalone(profile, ...args));
    await fakeOsIntegration(app, 0);
    await app.evaluate(
      ({ app: electronApp }, { appData, documents }) => {
        electronApp.setPath('appData', appData);
        electronApp.setPath('documents', documents);
      },
      { appData: fixture.appData, documents: path.join(base, 'Documents') },
    );
  };

  test('an address book that is a view over an endless query: refused, and main keeps answering', async () => {
    hangingBook(path.join(fixture.profileDir, 'abook.sqlite'));
    await start();
    const { slowest, value, finished } = await slowestWhile(app, scan(page));
    expect(slowest, 'main answers while the scan runs').toBeLessThan(2000);
    expect(finished, 'the scan comes back').toBe(true);
    expect(value?.ok).toBe(true);
    expect(value?.books, 'the view is no address book').toEqual([]);
    expect(value?.candidates?.some((c) => c.folder[0] === 'Inbox')).toBe(true);
  });

  test('a profile on a network path that does not answer: main keeps answering', async () => {
    const ini = path.join(fixture.appData, 'Thunderbird', 'profiles.ini');
    writeFileSync(ini, ['[Profile0]', 'Name=default', 'IsRelative=1', 'Path=Profiles/abc123.default', '', '[Profile1]', 'Name=far', 'IsRelative=0', 'Path=\\\\10.255.255.1\\share\\tb', ''].join('\r\n'));
    await start();
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;
    const { slowest, value, finished } = await slowestWhile(app, scan(page));
    expect(slowest, 'main answers while the scan runs').toBeLessThan(2000);
    expect(finished).toBe(true);
    expect(value?.candidates?.some((c) => c.folder[0] === 'Inbox'), 'what can be read is still found').toBe(true);
    // Whether the path fails fast or never answers is the network's to say. Both end, inside the grace.
    expect(elapsed(), 'not the whole timeout').toBeLessThan(30_000);
  });

  test('a scan that never ends is stopped, says so, and keeps what it found', async () => {
    test.skip(process.platform !== 'win32', 'runs anywhere, checked here');
    await start('--bulwark-test-import-hang');
    const { slowest, value, finished } = await slowestWhile(app, scan(page));
    expect(slowest, 'main answers while the worker hangs').toBeLessThan(2000);
    expect(finished, 'the timeout ends it').toBe(true);
    expect(value).toMatchObject({ ok: true, incomplete: true });
    expect(value?.candidates?.some((c) => c.folder[0] === 'Inbox'), 'what came before the hang').toBe(true);
    // And no process stays behind spinning.
    await expect
      .poll(() => app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().filter((m) => m.name === 'Bulwark import reader').length), { timeout: 10_000 })
      .toBe(0);
  });
});
