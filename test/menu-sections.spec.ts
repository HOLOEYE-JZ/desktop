import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { fakeOsIntegration, launchStandalone, removeProfile, requireAccount, signIn, STALWARTS, tempProfile } from './helpers';
import { clickMenuItem, menuItem } from './native-helpers';

/**
 * The menu bar on a real webmail, signed in, read back with Menu.getApplicationMenu() in
 * Mail, Calendar, Contacts and Files: the Message menu only in Mail, Edit > Search for
 * what's on screen, the calendar's views in View, and File > Import for each app.
 * Needs a webmail build of the same branch (BULWARK_TEST_WEBMAIL) and a test account:
 *
 *   BULWARK_TEST_WEBMAIL=<dir> BULWARK_TEST_ACCOUNT=<account> IT_ENT_PASSWORD=<password> npx playwright test test/menu-sections.spec.ts
 *
 * BULWARK_TEST_SERVER picks the server by its label (1.0 by default).
 */

const SERVER = (STALWARTS.find((server) => server.label === process.env.BULWARK_TEST_SERVER) ?? STALWARTS[0]).url;

interface ReadBack {
  top: string[];
  search: { label: string; enabled: boolean } | null;
  importLines: { id: string; label: string; enabled: boolean }[];
  views: { id: string; label: string; type: string; checked: boolean; accelerator: string | null; registered: boolean }[];
  readingPane: boolean | null;
}

/** File menu lines that only some parts of the app have: shown and enabled, or null when absent. */
function fileLines(app: ElectronApplication): Promise<Record<string, { visible: boolean; enabled: boolean } | null>> {
  return app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()!;
    const line = (id: string) => {
      const item = menu.getMenuItemById(id);
      return item ? { visible: item.visible, enabled: item.enabled } : null;
    };
    return { newFolder: line('file.newFolder'), uploadFiles: line('file.uploadFiles'), print: line('file.print'), savePdf: line('file.savePdf') };
  });
}

function readBack(app: ElectronApplication): Promise<ReadBack> {
  return app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()!;
    const search = menu.getMenuItemById('edit.search');
    const views = ['day', 'week', 'month', 'agenda'].map((view) => menu.getMenuItemById(`view.calendar.${view}`)).filter((item) => !!item);
    return {
      top: menu.items.map((item) => item.label.replace('&', '')),
      search: search ? { label: search.label, enabled: search.enabled } : null,
      importLines: menu.getMenuItemById('file.importMenu')?.submenu?.items.map((line) => ({ id: line.id, label: line.label, enabled: line.enabled })) ?? [],
      views: views.map((item) => ({
        id: item!.id,
        label: item!.label,
        type: item!.type,
        checked: item!.checked,
        accelerator: (item as unknown as { accelerator?: string }).accelerator ?? null,
        registered: (item as unknown as { registerAccelerator?: boolean }).registerAccelerator !== false,
      })),
      readingPane: menu.getMenuItemById('view.readingPane')?.visible ?? null,
    };
  });
}

test.describe('the menus follow the part of the app on screen', () => {
  let profile = '';
  let app: ElectronApplication;
  let page: Page;
  const seen: Record<string, ReadBack> = {};

  test.beforeAll(async () => {
    requireAccount();
    profile = tempProfile('menu-sections');
    ({ app, page } = await launchStandalone(profile));
    // Links never reach the user's browser.
    await fakeOsIntegration(app);
    await signIn(page, SERVER);
  });

  test.afterAll(async () => {
    // What the menus held in each part, for the record.
    console.log(JSON.stringify(seen, null, 2));
    await app?.close().catch(() => {});
    removeProfile(profile);
  });

  const goTo = async (command: string, path: string) => {
    await clickMenuItem(app, command);
    await page.waitForURL((url) => url.pathname.startsWith(path), { timeout: 60_000 });
  };

  const activeField = () => page.evaluate(() => {
    const active = document.activeElement as HTMLInputElement | null;
    return active?.tagName === 'INPUT' ? active.getAttribute('aria-label') ?? active.placeholder : null;
  });

  test('Mail: the Message menu, Search mail, and File > Import with mail, calendar and contacts', async () => {
    await expect.poll(async () => (await readBack(app)).search?.enabled, { timeout: 30_000 }).toBe(true);
    const mail = await readBack(app);
    seen.mail = mail;
    expect(mail.top).toContain('Message');
    expect(mail.search).toEqual({ label: 'Search mail', enabled: true });
    expect(mail.importLines).toEqual([
      { id: 'file.import', label: 'Mail…', enabled: true },
      { id: 'file.importCalendar', label: 'Calendar…', enabled: true },
      { id: 'file.importContacts', label: 'Contacts…', enabled: true },
    ]);
    expect(mail.views).toEqual([]);
    expect(mail.readingPane).toBe(true);
    const lines = await fileLines(app);
    expect(lines.newFolder).toBeNull();
    expect(lines.print).toEqual({ visible: true, enabled: true });
  });

  test('Calendar: no Message menu, Search events, and Day, Week, Month and Agenda ticked by the view', async () => {
    await goTo('go.calendar', '/calendar');
    await expect.poll(async () => (await readBack(app)).search?.label, { timeout: 30_000 }).toBe('Search events');
    const calendar = await readBack(app);
    seen.calendar = calendar;
    expect(calendar.top).not.toContain('Message');
    expect(await menuItem(app, 'message.reply')).toBeNull();
    expect(calendar.search).toEqual({ label: 'Search events', enabled: true });
    expect(calendar.readingPane).toBe(false);
    expect(calendar.views.map(({ label, type }) => ({ label, type }))).toEqual(['Day', 'Week', 'Month', 'Agenda'].map((label) => ({ label, type: 'radio' })));
    if (process.platform !== 'darwin') {
      expect(calendar.views.map(({ accelerator, registered }) => ({ accelerator, registered }))).toEqual(['D', 'W', 'M', 'A'].map((accelerator) => ({ accelerator, registered: false })));
    }
    expect(calendar.views.filter((view) => view.checked)).toHaveLength(1);

    for (const view of ['month', 'day', 'agenda', 'week']) {
      await clickMenuItem(app, `view.calendar.${view}`);
      await expect.poll(async () => (await readBack(app)).views.filter((item) => item.checked).map((item) => item.id)).toEqual([`view.calendar.${view}`]);
    }

    await clickMenuItem(app, 'edit.search');
    await expect.poll(activeField).toBe('Search events');
    await page.keyboard.press('Escape');
  });

  test('Contacts: no Message menu, and Search contacts goes to the contacts search', async () => {
    await goTo('go.contacts', '/contacts');
    await expect.poll(async () => (await readBack(app)).search, { timeout: 30_000 }).toEqual({ label: 'Search contacts', enabled: true });
    const contacts = await readBack(app);
    seen.contacts = contacts;
    expect(contacts.top).not.toContain('Message');
    expect(contacts.views).toEqual([]);
    await clickMenuItem(app, 'edit.search');
    await expect.poll(activeField).toMatch(/^Search contacts/);
    // Still in Contacts: not sent off to mail's search.
    expect(new URL(page.url()).pathname).toMatch(/^\/contacts/);
  });

  test('Files: no Message menu, New folder and Upload files in File, nothing to print, and Search files goes to the files search', async () => {
    await goTo('go.files', '/files');
    await expect.poll(async () => (await readBack(app)).search, { timeout: 30_000 }).toEqual({ label: 'Search files', enabled: true });
    const files = await readBack(app);
    seen.files = files;
    expect(files.top).not.toContain('Message');
    // File has Files' own lines, and nothing to print (pim-p3-18).
    await expect.poll(() => fileLines(app), { timeout: 30_000 }).toEqual({
      newFolder: { visible: true, enabled: true },
      uploadFiles: { visible: true, enabled: true },
      print: { visible: false, enabled: false },
      savePdf: { visible: false, enabled: false },
    });
    await clickMenuItem(app, 'file.newFolder');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await clickMenuItem(app, 'edit.search');
    await expect.poll(activeField).toMatch(/^Search/);
    expect(new URL(page.url()).pathname).toMatch(/^\/files/);
  });

  test('View > Refresh reloads the screen on view, and Go fits it', async () => {
    const calls: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body?.includes('"methodCalls"')) for (const m of body.matchAll(/\["([A-Za-z]+\/[a-z]+)"/g)) calls.push(m[1]);
    });
    const goLines = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('go')!.submenu!.items
      .filter((item) => item.visible && item.type !== 'separator').map((item) => item.id));
    const refreshes = async (screen: string, method: RegExp) => {
      // The menu follows once the screen has said what it is.
      const search = { calendar: 'Search events', contacts: 'Search contacts', files: 'Search files' }[screen];
      await expect.poll(async () => (await menuItem(app, 'edit.search'))?.label, { timeout: 30_000 }).toBe(search);
      await expect.poll(async () => (await menuItem(app, 'view.refresh'))?.enabled, { timeout: 30_000 }).toBe(true);
      expect((await menuItem(app, 'view.refresh'))?.label, screen).toBe('Refresh');
      calls.length = 0;
      await clickMenuItem(app, 'view.refresh');
      await expect.poll(() => calls.some((call) => method.test(call)), { timeout: 30_000, message: screen }).toBe(true);
      const go = await goLines();
      expect(go, screen).not.toContain('go.inbox');
      expect(go, screen).not.toContain('go.nextMessage');
      return go;
    };

    await clickMenuItem(app, 'go.calendar');
    await page.waitForURL((url) => url.pathname.startsWith('/calendar'), { timeout: 60_000 });
    const calendarGo = await refreshes('calendar', /^CalendarEvent\//);
    expect(calendarGo.slice(0, 3)).toEqual(['go.today', 'go.nextPeriod', 'go.previousPeriod']);
    const title = () => page.locator('main h1, h1').first().getAttribute('title');
    const now = await title();
    await clickMenuItem(app, 'go.nextPeriod');
    await expect.poll(title).not.toBe(now);
    await clickMenuItem(app, 'go.today');
    await expect.poll(title).toBe(now);

    await clickMenuItem(app, 'go.contacts');
    await page.waitForURL((url) => url.pathname.startsWith('/contacts'), { timeout: 60_000 });
    await refreshes('contacts', /^(ContactCard|AddressBook)\//);

    await clickMenuItem(app, 'go.files');
    await page.waitForURL((url) => url.pathname.startsWith('/files'), { timeout: 60_000 });
    await refreshes('files', /^FileNode\//);

    await clickMenuItem(app, 'go.mail');
    await page.waitForURL((url) => !/^\/(calendar|contacts|files)/.test(url.pathname), { timeout: 60_000 });
    await expect.poll(async () => (await menuItem(app, 'view.refresh'))?.label, { timeout: 30_000 }).toBe('Check for new mail');
    expect(await goLines()).toContain('go.inbox');
  });

  test('File > Import > Calendar… and Contacts… open that app\'s import from anywhere', async () => {
    await clickMenuItem(app, 'file.importCalendar');
    await page.waitForURL((url) => url.pathname.startsWith('/calendar'), { timeout: 60_000 });
    await expect(page.getByRole('dialog', { name: 'Import calendar' })).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Import calendar' })).toBeHidden();

    await clickMenuItem(app, 'file.importContacts');
    await page.waitForURL((url) => url.pathname.startsWith('/contacts'), { timeout: 60_000 });
    await expect(page.getByRole('dialog', { name: 'Import contacts' })).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Import contacts' })).toBeHidden();
  });
});
