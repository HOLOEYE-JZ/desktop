import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { APP_ORIGIN, ENT_PASSWORD, expectMailShown, fakeOsIntegration, launch, launchStandalone, prompts, removeProfile, requireAccount, SCREENSHOTS, shownPage, signIn, STALWARTS, tempProfile } from './helpers';
import { makeThunderbirdProfile, mbox, type FixtureProfile } from './fixtures/make-thunderbird-profile';

/**
 * The whole way, on both Stalwarts, as ent-dave: a Thunderbird profile and a PST found on
 * "this computer", confirmed, imported through the real dialog, and read back from the
 * server over JMAP. What each test adds, it takes off the server again.
 */

const DAVE = 'ent-dave@example.org';
const PST = path.join(import.meta.dirname, 'fixtures', 'Outlook.pst');
const PST_MESSAGES = 14;

class Jmap {
  private apiUrl = '';
  private accountId = '';
  constructor(private readonly server: string) {}

  private get auth(): string {
    return `Basic ${Buffer.from(`${DAVE}:${ENT_PASSWORD}`).toString('base64')}`;
  }

  async open(): Promise<void> {
    const res = await fetch(`${this.server}/.well-known/jmap`, { headers: { authorization: this.auth } });
    if (!res.ok) throw new Error(`session ${res.status}`);
    const session = (await res.json()) as { apiUrl: string; primaryAccounts: Record<string, string> };
    this.apiUrl = session.apiUrl;
    this.accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
  }

  async call(using: string[], calls: [string, Record<string, unknown>, string][]): Promise<[string, Record<string, unknown>, string][]> {
    const withAccount = calls.map(([name, args, id]) => [name, { accountId: this.accountId, ...args }, id]);
    const res = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { authorization: this.auth, 'content-type': 'application/json' },
      body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', ...using], methodCalls: withAccount }),
    });
    if (!res.ok) throw new Error(`jmap ${res.status}`);
    return ((await res.json()) as { methodResponses: [string, Record<string, unknown>, string][] }).methodResponses;
  }

  async mailboxes(): Promise<{ id: string; name: string; role: string | null; parentId: string | null }[]> {
    const [[, result]] = await this.call(['urn:ietf:params:jmap:mail'], [['Mailbox/get', { properties: ['name', 'role', 'parentId'] }, 'm']]);
    return (result as { list: { id: string; name: string; role: string | null; parentId: string | null }[] }).list;
  }

  async emails(): Promise<{ id: string; subject: string; mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> }[]> {
    const responses = await this.call(['urn:ietf:params:jmap:mail'], [
      ['Email/query', { limit: 1000 }, 'q'],
      ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'mailboxIds', 'keywords'] }, 'g'],
    ]);
    return (responses[1][1] as { list: { id: string; subject: string; mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> }[] }).list;
  }

  async contacts(): Promise<{ id: string; text: string }[]> {
    const responses = await this.call(['urn:ietf:params:jmap:contacts'], [['ContactCard/get', { ids: null }, 'c']]);
    const list = (responses[0][1] as { list?: { id: string }[] }).list ?? [];
    return list.map((card) => ({ id: card.id, text: JSON.stringify(card) }));
  }

  async destroyEmails(ids: string[]): Promise<void> {
    if (ids.length) await this.call(['urn:ietf:params:jmap:mail'], [['Email/set', { destroy: ids }, 'd']]);
  }

  async destroyMailboxes(ids: string[]): Promise<void> {
    if (ids.length) await this.call(['urn:ietf:params:jmap:mail'], [['Mailbox/set', { destroy: ids, onDestroyRemoveEmails: true }, 'd']]);
  }

  async destroyContacts(ids: string[]): Promise<void> {
    if (ids.length) await this.call(['urn:ietf:params:jmap:contacts'], [['ContactCard/set', { destroy: ids }, 'd']]);
  }
}

/** The user's folders as the app asks for them, pointed at the fixture. No switch in the app does this. */
const pointAt = (app: ElectronApplication, base: string, fixture: FixtureProfile) =>
  app.evaluate(
    ({ app: electronApp }, { appData, documents, local }) => {
      electronApp.setPath('appData', appData);
      electronApp.setPath('documents', documents);
      process.env.LOCALAPPDATA = local;
    },
    { appData: fixture.appData, documents: path.join(base, 'Documents'), local: path.join(base, 'Local') },
  );

async function openImportDialog(page: Page): Promise<void> {
  await page.goto(`${APP_ORIGIN}/settings/backup`);
  await page.getByTestId('settings-mail-import').click();
  await expect(page.getByTestId('mail-import-dialog')).toBeVisible();
}

const finished = (page: Page) => expect(page.getByTestId('mail-import-dialog').getByRole('heading', { name: 'Import finished' })).toBeVisible({ timeout: 150_000 });

const folderPath = (id: string, boxes: { id: string; name: string; parentId: string | null }[]): string => {
  const box = boxes.find((entry) => entry.id === id);
  if (!box) return '?';
  return box.parentId ? `${folderPath(box.parentId, boxes)}/${box.name}` : box.name;
};

for (const { label, url } of STALWARTS) {
  test.describe(`local import on Stalwart ${label}`, () => {
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(420_000);
    test.beforeAll(requireAccount);

    const tag = `IMP${Date.now().toString(36)}${label.replace('.', '')}`;
    let base: string;
    let fixture: FixtureProfile;
    let profile: string;
    let app: ElectronApplication;
    let page: Page;
    const jmap = new Jmap(url);
    let knownEmails = new Set<string>();
    let knownBoxes = new Set<string>();
    let knownContacts = new Set<string>();

    const mine = async () => (await jmap.emails()).filter((email) => !knownEmails.has(email.id));

    test.beforeAll(async () => {
      base = mkdtempSync(path.join(tmpdir(), 'bw-e2e-'));
      fixture = makeThunderbirdProfile(base, tag);
      const outlook = path.join(base, 'Documents', 'Outlook Files');
      mkdirSync(outlook, { recursive: true });
      copyFileSync(PST, path.join(outlook, 'Archive.pst'));
      const local = path.join(base, 'Local', 'Microsoft', 'Outlook');
      mkdirSync(local, { recursive: true });
      copyFileSync(PST, path.join(local, 'me@example.org.ost'));
      // Big enough for the screenshot to say something honest. Left unticked below.
      writeFileSync(path.join(fixture.localFolders, 'Old mail'), Buffer.concat([Buffer.from('From - Tue May 05 10:00:00 2020\r\nSubject: padding\r\n\r\n'), Buffer.alloc(300 * 1024 * 1024, 0x20)]));
      await jmap.open();
      knownEmails = new Set((await jmap.emails()).map((email) => email.id));
      knownBoxes = new Set((await jmap.mailboxes()).map((box) => box.id));
      knownContacts = new Set((await jmap.contacts()).map((card) => card.id));
      profile = tempProfile(`imp-${label}`);
      ({ app, page } = await launchStandalone(profile));
      await fakeOsIntegration(app, 0);
      await pointAt(app, base, fixture);
      await signIn(page, url, DAVE);
    });

    test.afterAll(async () => {
      await app?.close().catch(() => undefined);
      removeProfile(profile);
      const emails = await mine();
      await jmap.destroyEmails(emails.map((email) => email.id));
      const boxes = (await jmap.mailboxes()).filter((box) => !knownBoxes.has(box.id));
      // Children first: a folder with subfolders can't go.
      const depth = (id: string): number => {
        const box = boxes.find((entry) => entry.id === id);
        return box?.parentId ? 1 + depth(box.parentId) : 0;
      };
      for (const box of boxes.sort((a, b) => depth(b.id) - depth(a.id))) await jmap.destroyMailboxes([box.id]);
      const contacts = (await jmap.contacts()).filter((card) => !knownContacts.has(card.id));
      await jmap.destroyContacts(contacts.map((card) => card.id));
      rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    });

    test('the profile and the PST are found, confirmed, imported, and on the server in their folders', async () => {
      await openImportDialog(page);
      const before = (await prompts(app)).length;
      await page.getByTestId('local-import-find').click();
      const list = page.getByTestId('local-import-list');
      await expect(list).toBeVisible();
      // Asked once before looking, and nothing confirmed for reading yet.
      expect((await prompts(app)).length).toBe(before + 1);
      await expect(list).toContainText(`Fixture-${tag} / Year 2020`);
      await expect(list).toContainText('Archive.pst');
      await expect(list).not.toContainText('.ost');
      await expect(page.getByTestId('local-import-ost')).toContainText('me@example.org.ost');
      await expect(page.getByTestId('local-import-ost')).toContainText('.pst');
      await expect(page.getByTestId('local-import-calendars')).toBeVisible();
      await expect(page.getByTestId('local-import-estimate')).toContainText('50 MB an hour');
      await expect(page.getByTestId('local-import-estimate')).toContainText(/\d+ hours?/);
      if (label === '1.0') await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-import.png') });

      await list.getByRole('checkbox', { name: /Old mail/ }).uncheck();
      await page.getByTestId('local-import-confirm').click();
      await expect(page.getByTestId('local-import-picked')).toBeVisible();
      const asked = (await prompts(app)).slice(before + 1);
      expect(asked).toHaveLength(1);
      expect(asked[0].detail).toContain(path.join(fixture.localFolders, 'Inbox'));
      expect(asked[0].detail).not.toContain('Old mail');
      if (label === '1.0') await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-import-confirmed.png') });

      await page.getByTestId('mail-import-start').click();
      await finished(page);
      if (label === '1.0') await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-import-done.png') });

      const boxes = await jmap.mailboxes();
      const emails = await mine();
      const where = (name: string) => {
        const found = emails.filter((email) => email.subject === `${tag} ${name}`);
        expect(found, name).toHaveLength(1);
        return folderPath(Object.keys(found[0].mailboxIds)[0], boxes);
      };
      for (const [folder, names] of Object.entries(fixture.expected)) {
        for (const name of names) {
          const expected = folder === 'Inbox' ? boxes.find((box) => box.role === 'inbox')!.name : folder === 'Sent' ? boxes.find((box) => box.role === 'sent')!.name : folder;
          expect(where(name), name).toBe(expected);
        }
      }
      // Deleted in Thunderbird stays out, in mbox and in Maildir.
      expect(emails.some((email) => email.subject.includes('deleted'))).toBe(false);
      // X-Mozilla-Status 0001 is read.
      expect(emails.find((email) => email.subject === `${tag} in-1`)?.keywords.$seen).toBe(true);
      // The PST's own folders, onto the account's own by the role the file gives them.
      const fromPst = emails.filter((email) => !email.subject.startsWith(tag));
      expect(fromPst).toHaveLength(PST_MESSAGES);
      const pstFolders = new Set(fromPst.map((email) => boxes.find((box) => box.id === Object.keys(email.mailboxIds)[0])?.role));
      expect(pstFolders).toEqual(new Set(['inbox', 'sent']));

      // The address book, on the server.
      await expect
        .poll(async () => (await jmap.contacts()).filter((card) => !knownContacts.has(card.id)).map((card) => card.text).join(), { timeout: 30_000 })
        .toContain(`ada-${tag}@example.org`);

      // Done: the shell has forgotten the paths.
      await expect
        .poll(() =>
          app.evaluate(({ app: electronApp }) => {
            const { readFileSync: read } = process.getBuiltinModule('node:fs');
            const { join } = process.getBuiltinModule('node:path');
            return (JSON.parse(read(join(electronApp.getPath('userData'), 'shell-state.json'), 'utf8')).importJobs ?? []).length as number;
          }),
        )
        .toBe(0);
    });

    test('a folder Thunderbird changed starts over, and nothing goes in twice', async () => {
      const inbox = path.join(fixture.localFolders, 'Inbox');
      // Compacted and with new mail: another size and date, so its checkpoint doesn't apply.
      writeFileSync(inbox, mbox(tag, ['in-2', 'in-3']));
      const before = await mine();
      await page.getByRole('button', { name: 'Close' }).first().click().catch(() => undefined);
      await openImportDialog(page);
      await page.getByTestId('local-import-find').click();
      const list = page.getByTestId('local-import-list');
      await expect(list).toBeVisible();
      // Only this folder.
      for (const box of await list.getByTestId('local-import-item').all()) await box.uncheck();
      await list.locator('li', { hasText: /^Inbox/ }).getByTestId('local-import-item').check();
      await list.getByTestId('local-import-book').uncheck();
      await page.getByTestId('local-import-confirm').click();
      await page.getByTestId('mail-import-start').click();
      await finished(page);
      await expect(page.getByTestId('local-import-duplicates')).toContainText('already imported');
      const after = await mine();
      const fresh = after.filter((email) => !before.some((known) => known.id === email.id));
      expect(fresh.map((email) => email.subject)).toEqual([`${tag} in-3`]);
    });

    test('an import killed part way resumes after a restart: every message once, in its folder', async () => {
      // An established profile. Chromium writes cookies, localStorage and Local State (with the key
      // for safeStorage) some seconds late, so a kill in the first moments of a new profile loses
      // the sign-in or the keys. That is not what this test is about: see the report.
      await app.close();
      ({ app, page } = await launchStandalone(profile));
      await fakeOsIntegration(app, 0);
      await pointAt(app, base, fixture);
      await expectMailShown(page);

      const count = 90;
      const folder = `Kill-${tag}`;
      const names = Array.from({ length: count }, (_, i) => `kill-${i}`);
      writeFileSync(path.join(fixture.localFolders, folder), mbox(tag, names));
      await page.getByRole('button', { name: 'Close' }).first().click().catch(() => undefined);
      await openImportDialog(page);
      await page.getByTestId('local-import-find').click();
      const list = page.getByTestId('local-import-list');
      await expect(list).toBeVisible();
      for (const box of await list.getByTestId('local-import-item').all()) await box.uncheck();
      await list.locator('li', { hasText: folder }).getByTestId('local-import-item').check();
      await list.getByTestId('local-import-book').uncheck();
      await page.getByTestId('local-import-confirm').click();
      await page.getByTestId('mail-import-start').click();

      const onServer = async () => (await mine()).filter((email) => email.subject.startsWith(`${tag} kill-`));
      await expect.poll(async () => (await onServer()).length, { timeout: 120_000, intervals: [200] }).toBeGreaterThanOrEqual(15);
      // Not a clean quit: main goes, as in a crash. app.process() is only the cmd.exe that started it.
      process.kill(await app.evaluate(() => process.pid), 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const atKill = (await onServer()).length;
      expect(atKill, 'part way when it died').toBeLessThan(count);
      // Nothing moves until the app is back, or the kill didn't kill it.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect((await onServer()).length).toBe(atKill);
      // Its children hold the single-instance lock for a moment, and a launch that doesn't get it exits at once.
      for (let attempt = 1; ; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          app = await launch(profile, '--standalone');
          break;
        } catch (error) {
          if (attempt >= 10) throw error;
        }
      }
      // Before the page signs in, or the real dialog would open under the test.
      await fakeOsIntegration(app, 0);
      page = await shownPage(app);
      await expect.poll(async () => (await prompts(app)).map((prompt) => prompt.message).join(), { timeout: 90_000 }).toContain('Continue importing');
      const question = (await prompts(app)).find((prompt) => prompt.message.includes('Continue importing'))!;
      expect(question.detail).toContain(folder);

      try {
        await expect
          .poll(async () => (await onServer()).length, { timeout: 180_000, intervals: [1000], message: 'every message arrives after the restart' })
          .toBeGreaterThanOrEqual(count);
      } catch (error) {
        // Says why, when it stalls: the job's own words, and how the window stood.
        const chip = await page.getByTestId('mail-transfer-chip').allTextContents();
        if (chip.length) await page.getByTestId('mail-transfer-chip').click();
        const dialog = await page.getByTestId('mail-import-dialog').allTextContents();
        const stalled = JSON.stringify({ chip, dialog, url: page.url(), prompts: (await prompts(app)).map((prompt) => prompt.message), windows: app.windows().length, atKill, now: new Date().toISOString() });
        await page.screenshot({ path: path.join(SCREENSHOTS, `desktop-import-stalled-${label}.png`) }).catch(() => undefined);
        throw new Error(`stalled: ${stalled}`, { cause: error });
      }
      // Long enough for a duplicate to arrive if it was coming.
      await page.waitForTimeout(4000);
      const emails = await onServer();
      const subjects = emails.map((email) => email.subject);
      expect(new Set(subjects).size, 'no duplicates').toBe(count);
      expect(subjects).toHaveLength(count);
      const boxes = await jmap.mailboxes();
      expect(new Set(emails.map((email) => folderPath(Object.keys(email.mailboxIds)[0], boxes)))).toEqual(new Set([folder]));
      // It ran in the background: the chip, not a dialog in the way.
      await expect(page.getByTestId('mail-import-dialog')).toHaveCount(0);
    });
  });
}
