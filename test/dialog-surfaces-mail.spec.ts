import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { APP_ORIGIN, ENT_PASSWORD, dialogHost, fakeOsIntegration, launchStandalone, removeProfile, requireAccount, signIn, STALWARTS, tempProfile } from './helpers';
import { clickMenuItem, menuItem, pageWith } from './native-helpers';

/**
 * The webmail's dialogs as windows of their own, on a real account: a form (Choose a
 * PIN), a picker with its filter (Move to), Escape, the focus coming back, and a dialog
 * from a message window hanging on that window. Needs a webmail build of this branch
 * (BULWARK_TEST_WEBMAIL) and a throwaway account:
 *
 *   IT_ENT_PASSWORD=<password> BULWARK_TEST_ACCOUNT=<address> npx playwright test test/dialog-surfaces-mail.spec.ts
 */

const SERVER = STALWARTS.find((s) => s.label === (process.env.BULWARK_TEST_SERVER_LABEL ?? '1.0'))!.url;
const ACCOUNT = process.env.BULWARK_TEST_ACCOUNT ?? 'ent-alice@example.org';
const PIN = '482916';

let profile = '';
let app: ElectronApplication;
let page: Page;

/** The dialog windows there are, as main sees them. */
function surfaces() {
  return app.evaluate(({ BrowserWindow }) =>
    // A window going away mid-way is left out.
    BrowserWindow.getAllWindows().flatMap((w) => {
      try {
        if (w.isDestroyed() || w.webContents?.getURL() !== 'about:blank') return [];
        return [{ id: w.id, parent: w.getParentWindow()?.id ?? null, modal: w.isModal(), visible: w.isVisible() }];
      } catch {
        return [];
      }
    }),
  );
}

/** The window id of the page whose URL has `part`. */
function windowIdOf(part: string) {
  return app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents?.getURL().includes(p))?.id ?? null, part);
}

test.beforeAll(async () => {
  requireAccount();
  profile = tempProfile('surfmail');
  ({ app, page } = await launchStandalone(profile));
  await fakeOsIntegration(app);
  await signIn(page, SERVER, ACCOUNT, ENT_PASSWORD);
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  removeProfile(profile);
});

test('Choose a PIN is a window of its own: typing, the check and Save work there; Escape cancels and the focus comes back', async () => {
  test.setTimeout(240_000);
  await page.goto(`${APP_ORIGIN}/settings/general`);
  const toggle = page.getByTestId('app-lock-switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 60_000 });
  await toggle.click();

  const dialog = await dialogHost(app, page, '[data-testid="app-lock-new-pin"]');
  expect(dialog).not.toBe(page);
  const [shown] = await surfaces();
  expect(shown.parent).toBe(await windowIdOf('/settings'));
  expect(shown.visible).toBe(true);
  if (process.platform !== 'darwin') expect(shown.modal).toBe(true);
  await expect(dialog.getByTestId('app-lock-new-pin')).toBeFocused();

  await dialog.getByTestId('app-lock-new-pin').fill(PIN);
  await dialog.getByTestId('app-lock-repeat-pin').fill(PIN.slice(0, -1) + '0');
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByTestId('app-lock-dialog-save')).toBeDisabled();
  await dialog.getByTestId('app-lock-repeat-pin').fill(PIN);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByTestId('app-lock-dialog-save').click();
  await expect.poll(async () => (await surfaces()).length, { timeout: 30_000 }).toBe(0);
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });

  // Turning it off asks for the PIN, in a window too. Escape leaves it on.
  await toggle.click();
  let off = await dialogHost(app, page, 'input[type="password"], input[inputmode="numeric"]');
  expect(off).not.toBe(page);
  await off.keyboard.press('Escape').catch(() => {});
  await expect.poll(async () => (await surfaces()).length, { timeout: 15_000 }).toBe(0);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toBeFocused();

  await toggle.click();
  off = await dialogHost(app, page, 'input[type="password"], input[inputmode="numeric"]');
  await off.locator('input').first().fill(PIN);
  await off.getByTestId('app-lock-dialog-save').click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 30_000 });
});

test('Move to is a window of its own, and its filter works there', async () => {
  test.setTimeout(240_000);
  await page.goto(`${APP_ORIGIN}/`);
  const row = page.locator('[data-email-id]').first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click();
  // The page tells the menu what can be done with the selection a moment later.
  await expect.poll(async () => (await menuItem(app, 'message.move'))?.enabled, { timeout: 30_000 }).toBe(true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents?.getURL().startsWith('https://'))?.focus());
  await clickMenuItem(app, 'message.move');

  const dialog = await dialogHost(app, page, '[data-testid="move-dialog"]');
  expect(dialog).not.toBe(page);
  const items = dialog.locator('[data-testid="move-dialog"] [role="menuitem"]');
  const before = await items.count();
  expect(before).toBeGreaterThan(2);
  await dialog.keyboard.type('Trash');
  await expect.poll(() => items.count()).toBeLessThan(before);
  await expect(items.first()).toContainText(/Trash/);
  await dialog.keyboard.press('Escape').catch(() => {});
  await expect.poll(async () => (await surfaces()).length, { timeout: 15_000 }).toBe(0);
  await expect(page.locator('[data-email-id]').first()).toBeVisible();
});

test('a dialog from a message window hangs on that window', async () => {
  test.setTimeout(240_000);
  await page.goto(`${APP_ORIGIN}/`);
  const row = page.locator('[data-email-id]').first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  const emailId = await row.getAttribute('data-email-id');
  await row.dblclick();
  const message = await pageWith(app, `/popout/message/${encodeURIComponent(emailId!)}`);
  await message.bringToFront();
  const messageWindow = await windowIdOf('/popout/message/');
  // View source, from the message's ⋮ menu.
  await message.getByRole('button', { name: 'More actions' }).first().click({ timeout: 60_000 });
  await message.getByRole('menuitem', { name: /View source/ }).click();
  const dialog = await dialogHost(app, message, '[role="dialog"]');
  expect(dialog).not.toBe(message);
  const [shown] = await surfaces();
  expect(shown.parent).toBe(messageWindow);
  await dialog.keyboard.press('Escape').catch(() => {});
  await expect.poll(async () => (await surfaces()).length, { timeout: 15_000 }).toBe(0);
  await message.close().catch(() => {});
});
