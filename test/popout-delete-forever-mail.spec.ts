import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT, ENT_PASSWORD, expectMailShown, fakeOsIntegration, launchStandalone, removeProfile, requireAccount, SCREENSHOTS, signIn, STALWARTS, tempProfile } from './helpers';
import { destroyMessages, jmap, mailboxIdOf, pageWith, seedMessage } from './native-helpers';

/**
 * Delete forever in a message window opened from Trash closed the window at once, asked
 * nothing and left the message in Trash; the main window then said "Email deleted". Now it
 * asks in the app's own question window, over the message window, deletes the message on
 * the server, and only then closes.
 *
 *   BULWARK_TEST_WEBMAIL=<dir> IT_ENT_PASSWORD=<the test account's password> npx playwright test test/popout-delete-forever-mail.spec.ts
 */

/** Puts a message straight into Trash. */
async function seedInTrash(server: string, subject: string): Promise<string> {
  const trash = await mailboxIdOf(server, ACCOUNT, ENT_PASSWORD, 'trash');
  return seedMessage(server, ACCOUNT, ENT_PASSWORD, subject, 'Seeded in Trash for the desktop tests.', { mailboxIds: { [trash]: true }, keywords: { $seen: true } });
}

async function stillThere(server: string, id: string): Promise<boolean> {
  const [[, answer]] = await jmap(server, ACCOUNT, ENT_PASSWORD, [['Email/get', { ids: [id], properties: ['id'] }, 'g']]);
  return (answer as { list: unknown[] }).list.length === 1;
}

/** The question windows there are now, as main sees them, with their parents. */
function dialogWindows(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && w.webContents?.getURL().startsWith('data:'))
      .map((w) => ({ visible: w.isVisible(), parent: w.getParentWindow()?.id ?? null, title: w.getTitle() })),
  );
}

function messageWindowId(app: ElectronApplication): Promise<number | null> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents?.getURL().includes('/popout/message'))?.id ?? null,
  );
}

async function openFromTrash(app: ElectronApplication, page: Page, subject: string): Promise<Page> {
  await page.locator('[data-testid="folder-row"][data-folder-role="trash"]').first().click();
  const row = page.getByText(subject).first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.dblclick();
  const window = await pageWith(app, '/popout/message');
  await expect(window.getByText(subject).first()).toBeVisible({ timeout: 60_000 });
  return window;
}

async function questionPage(app: ElectronApplication): Promise<Page> {
  await expect.poll(async () => (await dialogWindows(app)).filter((w) => w.visible).length, { timeout: 15_000 }).toBe(1);
  return pageWith(app, 'data:', 15_000);
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
      profile = tempProfile('popdel');
      const started = await launchStandalone(profile);
      app = started.app;
      page = started.page;
      await fakeOsIntegration(app);
      await signIn(page, server.url);
      await expectMailShown(page);
    });

    test.afterAll(async () => {
      await app?.close().catch(() => {});
      await destroyMessages(server.url, ACCOUNT, ENT_PASSWORD, cleanup).catch(() => {});
      removeProfile(profile);
    });

    test('Cancel keeps the message and the window', async () => {
      const subject = `Pop-out keep ${server.label} ${RUN}`;
      const id = await seedInTrash(server.url, subject);
      cleanup.push(id);
      const window = await openFromTrash(app, page, subject);
      const parent = await messageWindowId(app);
      await window.keyboard.press('Delete');
      const question = await questionPage(app);
      expect((await dialogWindows(app))[0].parent).toBe(parent);
      await expect(question.locator('h2')).toHaveText('Delete this message forever?');
      await question.getByRole('button', { name: 'Cancel' }).click();
      await expect.poll(async () => (await dialogWindows(app)).length).toBe(0);
      expect(await stillThere(server.url, id)).toBe(true);
      expect(window.isClosed()).toBe(false);
      await window.close();
    });

    test('Delete forever asks over the message window, deletes on the server, then closes it', async () => {
      const subject = `Pop-out delete ${server.label} ${RUN}`;
      const id = await seedInTrash(server.url, subject);
      cleanup.push(id);
      const window = await openFromTrash(app, page, subject);
      const parent = await messageWindowId(app);
      await window.getByRole('button', { name: 'Delete forever' }).first().click();
      const question = await questionPage(app);
      expect((await dialogWindows(app))[0].parent).toBe(parent);
      await expect(question.locator('h2')).toHaveText('Delete this message forever?');
      await expect(question.locator('#message')).toHaveText("You can't get it back.");
      if (process.env.BULWARK_SCREENSHOTS) await question.screenshot({ path: `${SCREENSHOTS}/desktop-popout-delete-forever-${server.label}.png`, omitBackground: true });
      await question.getByRole('button', { name: 'Delete forever' }).click();
      await expect.poll(() => stillThere(server.url, id), { timeout: 30_000, intervals: [1000] }).toBe(false);
      await expect.poll(() => window.isClosed(), { timeout: 30_000 }).toBe(true);
      // The main window says what happened: deleted, nothing to undo.
      await expect(page.getByText('Email deleted').first()).toBeVisible({ timeout: 15_000 });
    });
  });
}
