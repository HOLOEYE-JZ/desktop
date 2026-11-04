import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT, ENT_PASSWORD, expectMailShown, fakeOsIntegration, launchStandalone, removeProfile, requireAccount, SCREENSHOTS, signIn, STALWARTS, tempProfile } from './helpers';
import { destroyMessages, jmap, lastMenu, mailboxIdOf, menuCount, pageWith, pickNext, recordMenus, seedMessage } from './native-helpers';

/**
 * Edit on a real message, on a real server, in the webmail build of this branch. Nothing
 * starts on the desktop: `shell.openPath` only records, and the test saves the file itself.
 *
 *   BULWARK_TEST_WEBMAIL=<dir> IT_ENT_PASSWORD=<the test account's password> npx playwright test test/edit-attachments-mail.spec.ts
 */

const SENDER = 'ent-carol@example.org';
const ORIGINAL = 'The attachment as it arrived.';

function withAttachment(name: string) {
  return {
    from: [{ email: SENDER }],
    bodyStructure: {
      type: 'multipart/mixed',
      subParts: [
        { type: 'text/plain', partId: '1' },
        { type: 'text/plain', partId: '2', name, disposition: 'attachment' },
      ],
    },
    bodyValues: { 1: { value: 'See the file.' }, 2: { value: ORIGINAL } },
  };
}

async function fakeOpener(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __openedFiles: string[] };
    g.__openedFiles = [];
    shell.openPath = async (file: string) => {
      g.__openedFiles.push(file);
      return '';
    };
  });
}

const openedFiles = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { __openedFiles: string[] }).__openedFiles);

const menuLabels = async (app: ElectronApplication) => ((await lastMenu(app)) ?? []).flatMap((item) => (item.label ? [item.label] : []));

async function openMessage(page: Page, subject: string): Promise<void> {
  const row = page.getByText(subject).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  await expect(page.locator('[data-testid="attachment"]').first()).toBeVisible({ timeout: 30_000 });
}

async function rightClickAttachment(app: ElectronApplication, page: Page, pick?: string): Promise<void> {
  const before = await menuCount(app);
  if (pick) await pickNext(app, pick);
  await page.locator('[data-testid="attachment"]').first().click({ button: 'right' });
  await expect.poll(() => menuCount(app), { timeout: 10_000 }).toBeGreaterThan(before);
}

/** Someone who takes their time over the menu: the right-click is long past when the pick comes. */
async function pickSlowly(app: ElectronApplication, label: string, afterMs: number): Promise<void> {
  await app.evaluate(({ Menu }, [wanted, wait]) => {
    type Item = { label: string; submenu?: { items: Item[] }; click: () => void };
    const before = Menu.prototype.popup;
    Menu.prototype.popup = function popup(this: { items: Item[] }, options?: { callback?: () => void }) {
      Menu.prototype.popup = before;
      before.call(this as never, {} as never);
      setTimeout(() => {
        this.items.find((item) => item.label === wanted)?.click();
        options?.callback?.();
      }, wait as number);
    } as never;
  }, [label, afterMs] as const);
}

async function sentAttachmentSize(server: string, subject: string): Promise<number | null> {
  const sent = await mailboxIdOf(server, ACCOUNT, ENT_PASSWORD, 'sent');
  const answers = await jmap(server, ACCOUNT, ENT_PASSWORD, [
    ['Email/query', { filter: { inMailbox: sent, subject }, limit: 1 }, 'q'],
    ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['attachments'] }, 'g'],
  ]);
  const list = (answers[1][1] as { list: { attachments: { name: string; size: number }[] }[] }).list;
  return list[0]?.attachments.find((part) => part.name === 'notes.txt')?.size ?? null;
}

async function sentIds(server: string, subject: string): Promise<string[]> {
  const sent = await mailboxIdOf(server, ACCOUNT, ENT_PASSWORD, 'sent');
  const [[, answer]] = await jmap(server, ACCOUNT, ENT_PASSWORD, [['Email/query', { filter: { inMailbox: sent, subject }, limit: 10 }, 'q']]);
  return (answer as { ids: string[] }).ids;
}

/** The organisation's rule, as the page's fetch of the policy gets it. Playwright's own fetch can't resolve the app's name. */
async function forbid(page: Page, key: 'noExport' | 'noDownloads'): Promise<void> {
  const body = await page.evaluate(async () => (await fetch('/api/admin/policy')).json()) as { organisation?: { devices?: Record<string, unknown> } };
  body.organisation = { ...body.organisation, devices: { ...body.organisation?.devices, [key]: true } };
  await page.route('**/api/admin/policy*', (route) => route.fulfill({ json: body }));
}

for (const server of STALWARTS) {
  test.describe(`on Stalwart ${server.label}`, () => {
    test.beforeAll(() => requireAccount());

    let profile: string;
    let app: ElectronApplication;
    let page: Page;
    const cleanup: string[] = [];
    const RUN = Date.now().toString(36);

    test.beforeAll(async () => {
      profile = tempProfile('editm');
      const started = await launchStandalone(profile);
      app = started.app;
      page = started.page;
      await recordMenus(app);
      await fakeOpener(app);
      await fakeOsIntegration(app);
      await signIn(page, server.url);
      await expectMailShown(page);
    });

    test.afterAll(async () => {
      await app?.close().catch(() => {});
      await destroyMessages(server.url, ACCOUNT, ENT_PASSWORD, cleanup).catch(() => {});
      removeProfile(profile);
    });

    const folders = () => readdirSync(path.join(profile, 'edit-files'));

    test('edit, reply with it, update it, send: what goes out is the edit, and the copy goes', async () => {
      const subject = `Edit reply ${server.label} ${RUN}`;
      cleanup.push(await seedMessage(server.url, ACCOUNT, ENT_PASSWORD, subject, 'See the file.', withAttachment('notes.txt')));
      await openMessage(page, subject);

      // Longer than a click's activation lasts: main's own record of the pick is what counts.
      await pickSlowly(app, 'Edit', 6_000);
      await rightClickAttachment(app, page);
      expect(await menuLabels(app)).toEqual(expect.arrayContaining(['Open', 'Save as…', 'Edit']));
      await expect.poll(async () => (await openedFiles(app)).length, { timeout: 30_000 }).toBe(1);
      const file = (await openedFiles(app))[0];
      expect(file.startsWith(path.join(profile, 'edit-files'))).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);

      // The user saves in the other program, and comes back to an offer.
      const firstEdit = 'Edited once.';
      writeFileSync(file, firstEdit);
      const offer = page.locator('[data-testid="edited-file"]');
      await expect(offer).toBeVisible({ timeout: 30_000 });
      await expect(offer).toContainText('notes.txt was changed');
      await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-edit-attachments.png') });

      await offer.getByRole('button', { name: 'Attach to a reply' }).click();
      const composer = page.locator('[data-testid="email-composer"]');
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await expect(composer.getByText('notes.txt').first()).toBeVisible({ timeout: 30_000 });
      // The composer holds it now: the offer moves to its chip.
      await expect(offer).toHaveCount(0, { timeout: 30_000 });

      // Saved again while the reply is being written.
      const secondEdit = 'Edited a second time, and longer.';
      writeFileSync(file, secondEdit);
      const update = composer.locator('[data-testid="composer-edit-update"]');
      await expect(update).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-edit-attachments-update.png') });
      await update.click();
      await expect(update).toHaveCount(0, { timeout: 30_000 });
      await expect(composer.getByText('notes.txt')).toHaveCount(1);

      // Edit from the chip goes back to the same file, with its edits.
      await composer.locator('[data-testid="composer-edit"]:visible').first().click();
      await expect.poll(async () => (await openedFiles(app)).length, { timeout: 30_000 }).toBe(2);
      expect((await openedFiles(app))[1]).toBe(file);
      expect(readFileSync(file, 'utf8')).toBe(secondEdit);

      await composer.locator('[data-testid="composer-send"]:visible').first().click();
      await expect.poll(() => sentAttachmentSize(server.url, subject), { timeout: 90_000, intervals: [2000] }).toBe(secondEdit.length);
      cleanup.push(...await sentIds(server.url, subject));

      // Sent, nothing unsaved: nothing left on disk.
      await expect.poll(() => existsSync(path.dirname(path.dirname(file))), { timeout: 30_000 }).toBe(false);
      await expect(offer).toHaveCount(0);
    });

    test('a save nobody took when the message goes: it asks, sends the older one if told to, and keeps the edits', async () => {
      const subject = `Edit stale ${server.label} ${RUN}`;
      cleanup.push(await seedMessage(server.url, ACCOUNT, ENT_PASSWORD, subject, 'See the file.', withAttachment('notes.txt')));
      await openMessage(page, subject);
      const seen = (await openedFiles(app)).length;
      await rightClickAttachment(app, page, 'Edit');
      await expect.poll(async () => (await openedFiles(app)).length, { timeout: 30_000 }).toBe(seen + 1);
      const file = (await openedFiles(app)).at(-1)!;
      const taken = 'The edit in the message.';
      writeFileSync(file, taken);
      const offer = page.locator('[data-testid="edited-file"]');
      await offer.getByRole('button', { name: 'Attach to a reply' }).click();
      const composer = page.locator('[data-testid="email-composer"]');
      await expect(composer.getByText('notes.txt').first()).toBeVisible({ timeout: 30_000 });
      await expect(offer).toHaveCount(0, { timeout: 30_000 });

      const notTaken = 'Saved after that, and never attached to anything.';
      writeFileSync(file, notTaken);
      await expect(composer.locator('[data-testid="composer-edit-update"]')).toBeVisible({ timeout: 30_000 });
      await composer.locator('[data-testid="composer-send"]:visible').first().click();
      // fakeOsIntegration answers with the first button: Send anyway.
      await expect.poll(() => sentAttachmentSize(server.url, subject), { timeout: 90_000, intervals: [2000] }).toBe(taken.length);
      cleanup.push(...await sentIds(server.url, subject));
      expect(await app.evaluate(() => (globalThis as unknown as { __prompts: { message?: string }[] }).__prompts.map((prompt) => prompt.message ?? JSON.stringify(prompt)))).toContainEqual(expect.stringContaining('edits that aren'));

      // The edits are still there, on offer as a file now.
      await expect(offer).toBeVisible({ timeout: 30_000 });
      await expect(offer.getByRole('button', { name: 'Attach to a new message' })).toBeVisible();
      expect(readFileSync(file, 'utf8')).toBe(notTaken);

      // And discarding them is what ends them.
      await offer.getByRole('button', { name: /Discard edits/ }).click();
      await expect(offer).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(() => existsSync(file)).toBe(false);
    });

    test('a draft closed with a saved file opens again and offers the update on its chip', async () => {
      const subject = `Edit draft ${server.label} ${RUN}`;
      cleanup.push(await seedMessage(server.url, ACCOUNT, ENT_PASSWORD, subject, 'See the file.', withAttachment('notes.txt')));
      await openMessage(page, subject);
      const seen = (await openedFiles(app)).length;
      await rightClickAttachment(app, page, 'Edit');
      await expect.poll(async () => (await openedFiles(app)).length, { timeout: 30_000 }).toBe(seen + 1);
      const file = (await openedFiles(app)).at(-1)!;
      writeFileSync(file, 'First version in the draft.');
      const offer = page.locator('[data-testid="edited-file"]');
      await offer.getByRole('button', { name: 'Attach to a reply' }).click();
      const composer = page.locator('[data-testid="email-composer"]');
      await expect(composer.getByText('notes.txt').first()).toBeVisible({ timeout: 30_000 });
      await expect(offer).toHaveCount(0, { timeout: 30_000 });

      // Closed with Save (the first button).
      await composer.locator('[data-testid="composer-close"]:visible').first().click();
      await expect(composer).toHaveCount(0, { timeout: 30_000 });

      writeFileSync(file, 'A second version, saved with the composer closed.');
      await expect(offer).toBeVisible({ timeout: 30_000 });
      await offer.getByRole('button', { name: 'Open draft' }).click();
      const window = await pageWith(app, '/popout/compose');
      const update = window.locator('[data-testid="composer-edit-update"]');
      await expect(update).toBeVisible({ timeout: 60_000 });
      // That composer holds it now, so the main window has nothing to offer.
      await expect(offer).toHaveCount(0, { timeout: 30_000 });
      await update.click();
      await expect(update).toHaveCount(0, { timeout: 30_000 });
      await expect(window.getByText('notes.txt')).toHaveCount(1);

      // Discarded (the first button): the copy goes with the draft.
      await window.getByRole('button', { name: /^Discard/ }).first().click();
      await expect.poll(() => existsSync(file), { timeout: 30_000 }).toBe(false);
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 30_000 }).toBe(1);
      await expect(offer).toHaveCount(0);
      await expect.poll(async () => {
        const drafts = await mailboxIdOf(server.url, ACCOUNT, ENT_PASSWORD, 'drafts');
        const [[, query]] = await jmap(server.url, ACCOUNT, ENT_PASSWORD, [['Email/query', { filter: { inMailbox: drafts, subject }, limit: 10 }, 'q']]);
        return (query as { ids: string[] }).ids.length;
      }, { timeout: 30_000 }).toBe(0);
    });

    test('a file type that runs something gets no Edit', async () => {
      const subject = `Edit exe ${server.label} ${RUN}`;
      cleanup.push(await seedMessage(server.url, ACCOUNT, ENT_PASSWORD, subject, 'See the file.', withAttachment('setup.bat')));
      await openMessage(page, subject);
      await rightClickAttachment(app, page);
      const labels = await menuLabels(app);
      expect(labels).toEqual(expect.arrayContaining(['Open', 'Save as…']));
      expect(labels).not.toContain('Edit');
    });

    test('the organisation forbidding export or saving: no Edit, and what was open goes', async () => {
      const subject = `Edit policy ${server.label} ${RUN}`;
      cleanup.push(await seedMessage(server.url, ACCOUNT, ENT_PASSWORD, subject, 'See the file.', withAttachment('notes.txt')));
      await openMessage(page, subject);
      const seen = (await openedFiles(app)).length;
      await rightClickAttachment(app, page, 'Edit');
      await expect.poll(async () => (await openedFiles(app)).length, { timeout: 30_000 }).toBe(seen + 1);
      const file = (await openedFiles(app)).at(-1)!;
      writeFileSync(file, 'Edits the organisation then forbids keeping.');
      await expect(page.locator('[data-testid="edited-file"]')).toBeVisible({ timeout: 30_000 });

      await forbid(page, 'noExport');
      try {
        await page.reload();
        await expectMailShown(page);
        await expect.poll(() => existsSync(file), { timeout: 60_000 }).toBe(false);
        await expect(page.locator('[data-testid="edited-file"]')).toHaveCount(0);

        await openMessage(page, subject);
        await rightClickAttachment(app, page);
        expect(await menuLabels(app)).not.toContain('Edit');
      } finally {
        await page.unroute('**/api/admin/policy*');
      }
    });

    test('sign-out takes the copies', async () => {
      const subject = `Edit out ${server.label} ${RUN}`;
      cleanup.push(await seedMessage(server.url, ACCOUNT, ENT_PASSWORD, subject, 'See the file.', withAttachment('notes.txt')));
      await page.reload();
      await expectMailShown(page);
      await openMessage(page, subject);
      const seen = (await openedFiles(app)).length;
      await rightClickAttachment(app, page, 'Edit');
      await expect.poll(async () => (await openedFiles(app)).length, { timeout: 30_000 }).toBe(seen + 1);
      const file = (await openedFiles(app)).at(-1)!;
      writeFileSync(file, 'Edits nobody took.');
      await expect(page.locator('[data-testid="edited-file"]')).toBeVisible({ timeout: 30_000 });

      // From the account menu. fakeOsIntegration says yes to the question.
      await page.locator('[data-testid="account-switcher"]').first().click();
      await page.getByRole('menuitem', { name: /^Sign out/ }).first().click();
      await expect.poll(() => existsSync(file), { timeout: 60_000 }).toBe(false);
      expect(await app.evaluate(() => (globalThis as unknown as { __prompts: { message: string }[] }).__prompts.some((p) => p.message.includes('delete your edits')))).toBe(true);
      expect(folders()).toEqual([]);
    });
  });
}
