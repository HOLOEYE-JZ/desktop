import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT, ENT_PASSWORD, expectMailShown, fakeOsIntegration, fillLogin, launchStandalone, prompts, removeProfile, requireAccount, shownPage, STALWARTS, tempProfile, launch } from './helpers';
import { destroyMessages, draftsWithSubject, jmap, menuCount, menuItem, pageWith, recordMenus, seedMessage } from './native-helpers';

/**
 * Multi-window on a real account, with a webmail build of this branch:
 *   BULWARK_TEST_WEBMAIL=<dir> IT_ENT_PASSWORD=<test account password> npx playwright test test/native-windows.spec.ts
 * BULWARK_TEST_SERVER_LABEL picks the Stalwart (1.0 by default).
 */
const STALWART = STALWARTS.find((s) => s.label === (process.env.BULWARK_TEST_SERVER_LABEL ?? '1.0'))!;
const SERVER = STALWART.url;
const TAG = `dw${Date.now().toString(36)}`;
const seeded: string[] = [];

async function seed(subject: string, extra?: Record<string, unknown>): Promise<string> {
  const id = await seedMessage(SERVER, ACCOUNT, ENT_PASSWORD, subject, `Body of ${subject}`, extra);
  seeded.push(id);
  return id;
}

async function signInRemembered(page: Page): Promise<void> {
  await fillLogin(page, SERVER, ACCOUNT, ENT_PASSWORD);
  await page.keyboard.press('Enter');
  await expectMailShown(page);
}

const rowOf = (page: Page, emailId: string) => page.locator(`[data-email-id="${emailId}"]`).first();

async function showRow(page: Page, emailId: string): Promise<void> {
  await expect.poll(async () => {
    if (await rowOf(page, emailId).count()) return true;
    await page.keyboard.press('Shift+G').catch(() => {});
    return false;
  }, { timeout: 60_000, intervals: [1000, 2000, 4000] }).toBe(true);
}

const sendCommand = (app: ElectronApplication, urlPart: string, id: string) => app.evaluate(({ BrowserWindow }, [part, command]) => {
  const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(part))!;
  window.webContents.send('bulwark:menu.command', command);
}, [urlPart, id] as const);

const flagged = async (id: string, keyword: string) => {
  const [[, answer]] = await jmap(SERVER, ACCOUNT, ENT_PASSWORD, [['Email/get', { ids: [id], properties: ['keywords'] }, 'g']]);
  return !!(answer as { list: { keywords: Record<string, boolean> }[] }).list[0]?.keywords?.[keyword];
};

/**
 * The composer's own cross. With the window's controls over the page it's hidden, since
 * theirs is right beside it. A native frame shows it, and it asks the same way.
 */
const clickOwnClose = (composer: Page) => composer.getByTestId('composer-close').evaluate((el) => (el as HTMLElement).click());


test.describe.configure({ mode: 'serial' });
test.beforeAll(requireAccount);
test.afterAll(async () => {
  await destroyMessages(SERVER, ACCOUNT, ENT_PASSWORD, seeded).catch(() => {});
});

test.describe('windows, signed in', () => {
  let profile = '';
  let app: ElectronApplication;
  let page: Page;
  let messageId = '';
  let subject = '';

  test.beforeAll(async () => {
    subject = `${TAG} window`;
    messageId = await seed(subject);
    profile = tempProfile('winui');
    ({ app, page } = await launchStandalone(profile));
    await fakeOsIntegration(app);
    await recordMenus(app);
    await signInRemembered(page);
    await showRow(page, messageId);
  });

  test.afterAll(async () => {
    await app.close().catch(() => {});
    removeProfile(profile);
  });

  const windowsOf = (part: string) => app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes(p)).length, part);

  test('double-click opens the message in its own window, with its text', async () => {
    await rowOf(page, messageId).dblclick();
    const message = await pageWith(app, `/popout/message/${encodeURIComponent(messageId)}`);
    await expect(message.locator('body')).toContainText(`Body of ${subject}`, { timeout: 60_000 });
  });

  test('again: the same window, not a second one', async () => {
    await rowOf(page, messageId).dblclick();
    await page.waitForTimeout(700);
    expect(await windowsOf(`/popout/message/${encodeURIComponent(messageId)}`)).toBe(1);
  });

  test('the shell knows its type, and the window list its title', async () => {
    const list = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { list: () => Promise<{ type: string; title: string }[]> } } }).bulwarkDesktop.windows.list());
    expect(list.map((w) => w.type).sort()).toEqual(['main', 'message']);
  });

  test('it has the theme\'s background from its first frame, not white', async () => {
    const colours = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getBackgroundColor().toLowerCase()));
    const pageColour = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = pageColour.match(/\d+/g)!.map(Number);
    const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    expect(colours.every((colour) => colour === hex)).toBe(true);
  });

  test('marking it in the pop-out shows in the main list with no reload', async () => {
    const marker = await page.evaluate(() => {
      (window as unknown as { __noReload: number }).__noReload = 1;
      return 1;
    });
    expect(marker).toBe(1);
    const message = await pageWith(app, `/popout/message/${encodeURIComponent(messageId)}`);
    await expect.poll(async () => (await message.evaluate(() => document.title)).length).toBeGreaterThan(0);
    await sendCommand(app, '/popout/message/', 'message.markUnread');
    await expect.poll(() => flagged(messageId, '$seen'), { timeout: 20_000 }).toBe(false);
    await expect(rowOf(page, messageId)).toHaveAttribute('data-unread', 'true', { timeout: 20_000 });
    await sendCommand(app, '/popout/message/', 'message.markRead');
    await expect(rowOf(page, messageId)).toHaveAttribute('data-unread', 'false', { timeout: 20_000 });
    expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(1);
  });

  test('a message pop-out reports what its Message menu can do', async () => {
    // Only the focused window's state shows: read it from the window's own report.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/message/'))!.focus();
    });
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.enabled, { timeout: 15_000 }).toBe(true);
    expect((await menuItem(app, 'message.move'))?.enabled).toBe(false);
  });

  test('closing it leaves the main window alone', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/message/'))!.close();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
  });

  test('with the setting off, double-click stays in the window', async () => {
    await page.evaluate(() => {
      localStorage.setItem('bulwark-desktop-window-prefs', JSON.stringify({ openOnDoubleClick: false, restoreWindows: true }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'bulwark-desktop-window-prefs' }));
    });
    await page.waitForTimeout(200);
    await rowOf(page, messageId).dblclick();
    await page.waitForTimeout(800);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await page.evaluate(() => {
      localStorage.setItem('bulwark-desktop-window-prefs', JSON.stringify({ openOnDoubleClick: true, restoreWindows: true }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'bulwark-desktop-window-prefs' }));
    });
  });

  /** The rows of the menu on screen, by their words. */
  const menuRows = () => page.locator('[role="menu"] [role="menuitem"] [data-menu-label]').allInnerTexts();
  const pickRow = (label: string) =>
    page.locator('[role="menu"] [role="menuitem"]').filter({ has: page.locator('[data-menu-label]', { hasText: new RegExp(`^${label}$`) }) }).first().click();

  test('right-click on a message: the same menu as in a browser, with no native copy', async () => {
    await page.keyboard.press('Escape');
    const before = await menuCount(app);
    await rowOf(page, messageId).click({ button: 'right' });
    await expect(page.locator('[role="menu"]').first()).toBeVisible({ timeout: 10_000 });
    expect(await menuRows()).toEqual(expect.arrayContaining(['Reply', 'Forward', 'Open in new window', 'Delete', 'Move to', 'More actions']));
    // Icons and the keys as keycaps, as in a browser.
    expect(await page.locator('[role="menu"] [data-testid="ctx-delete"] svg').count()).toBe(1);
    expect(await page.locator('[role="menu"] [data-testid="ctx-delete"] [data-menu-shortcut]').innerText()).toBe('Del');
    expect(await menuCount(app)).toBe(before);
    await page.keyboard.press('Escape');
  });

  test('picking from it does what it says', async () => {
    await rowOf(page, messageId).click({ button: 'right' });
    await pickRow('Mark as unread');
    await expect.poll(() => flagged(messageId, '$seen'), { timeout: 20_000 }).toBe(false);
    await expect(rowOf(page, messageId)).toHaveAttribute('data-unread', 'true', { timeout: 20_000 });
  });

  test('Open in new window from the menu: the same one window', async () => {
    await rowOf(page, messageId).click({ button: 'right' });
    await pickRow('Open in new window');
    await pageWith(app, `/popout/message/${encodeURIComponent(messageId)}`);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/message/'))!.close();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  });

  test('a folder has the same menu as in a browser', async () => {
    const before = await menuCount(app);
    await page.getByRole('navigation').getByText(/^Inbox/).first().click({ button: 'right' });
    await expect(page.locator('[role="menu"]').first()).toBeVisible({ timeout: 10_000 });
    expect((await menuRows()).length).toBeGreaterThan(1);
    expect(await menuCount(app)).toBe(before);
    await page.keyboard.press('Escape');
  });

  test('the Message menu follows the selection, and runs the app\'s own action', async () => {
    await rowOf(page, messageId).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.enabled, { timeout: 20_000 }).toBe(true);
    expect((await menuItem(app, 'message.move'))?.enabled).toBe(true);
    await sendCommand(app, '/', 'message.star');
    await expect.poll(() => flagged(messageId, '$flagged'), { timeout: 20_000 }).toBe(true);
    await sendCommand(app, '/', 'message.star');
    await expect.poll(() => flagged(messageId, '$flagged'), { timeout: 20_000 }).toBe(false);
  });

  test('View, Reading Pane changes the layout the settings have', async () => {
    await sendCommand(app, '/', 'view.layout.horizontal');
    await expect.poll(async () => (await menuItem(app, 'view.layout.horizontal'))?.checked, { timeout: 10_000 }).toBe(true);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('settings-storage') ?? '{}')?.state?.mailLayout)).toBe('horizontal');
    await sendCommand(app, '/', 'view.layout.split');
    await expect.poll(async () => (await menuItem(app, 'view.layout.split'))?.checked, { timeout: 10_000 }).toBe(true);
  });

  test('Go goes: a folder through the mail app, Calendar through the router', async () => {
    await sendCommand(app, '/', 'go.calendar');
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('/calendar');
    await sendCommand(app, '/', 'go.mail');
    await expect.poll(() => page.url(), { timeout: 30_000 }).not.toContain('/calendar');
    await sendCommand(app, '/', 'go.sent');
    await expect.poll(() => page.url(), { timeout: 30_000 }).toMatch(/sent/i);
    await sendCommand(app, '/', 'go.inbox');
    await expect.poll(() => page.url(), { timeout: 30_000 }).not.toMatch(/sent/i);
  });

  test('Settings opens as a page of the main window, with no second window, and its switch reaches the shell', async () => {
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()!.getMenuItemById('file.settings')!.click();
    });
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('/settings');
    const list = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { list: () => Promise<{ type: string }[]> } } }).bulwarkDesktop.windows.list());
    expect(list.map((w) => w.type)).toEqual(['main']);
    await page.goto(new URL('/settings/general', page.url()).toString());
    await page.getByText('Open messages in a new window on double-click').waitFor({ timeout: 60_000 });
    const flip = () => page.evaluate(() => {
      const label = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent === 'Reopen windows at start');
      let box: Element | null = label ?? null;
      const control = '[role="switch"], button[aria-checked], input[type="checkbox"]';
      while (box && !box.querySelector(control)) box = box.parentElement;
      (box!.querySelector(control) as HTMLElement).click();
    });
    const shellHas = () => JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8')).restoreWindows;
    await flip();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('bulwark-desktop-window-prefs') ?? '{}').restoreWindows)).toBe(false);
    await expect.poll(shellHas, { timeout: 10_000 }).toBe(false);
    await flip();
    await expect.poll(shellHas, { timeout: 10_000 }).toBe(true);
    await sendCommand(app, '/', 'go.inbox');
    await expect.poll(() => page.url(), { timeout: 30_000 }).not.toContain('/settings');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  });

  test('a link to a folder goes there, without reloading the window', async () => {
    await page.evaluate(() => {
      (window as unknown as { __noReload: number }).__noReload = 2;
    });
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit('second-instance', {}, ['bulwark.exe', 'bulwark://folder/drafts'], '');
    });
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain('/mail/folder/drafts');
    await expect(page.getByRole('navigation').getByText(/^Drafts/).first()).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(2);
    await sendCommand(app, '/', 'go.inbox');
    await expect.poll(() => page.url(), { timeout: 30_000 }).not.toContain('drafts');
  });

  test('a message opened from a link shows, and stays unread with no receipt', async () => {
    const subject = `${TAG} linked`;
    const id = await seed(subject);
    const login = `${ACCOUNT}@${new URL(SERVER).hostname}`;
    await app.evaluate(({ app: electronApp }, url) => {
      electronApp.emit('second-instance', {}, ['bulwark.exe', url], '');
    }, `bulwark://message/${login}/${id}`);
    const message = await pageWith(app, `/popout/message/${encodeURIComponent(id)}`);
    await expect(message.locator('body')).toContainText(`Body of ${subject}`, { timeout: 60_000 });
    // Longer than the instant the default marks it in.
    await message.waitForTimeout(3000);
    expect(await flagged(id, '$seen')).toBe(false);
    // The same message opened from the app marks it, so this isn't only a slow server.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('via=link'))!.close();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await page.evaluate(
      (emailId) => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: `/popout/message/${encodeURIComponent(emailId)}`, emailId }),
      id,
    );
    await expect.poll(() => flagged(id, '$seen'), { timeout: 30_000 }).toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/message/'))!.close();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  });

  test('Alt shows the menu bar as a row that moves the app down, with the window controls in it, and its lines are the app menu\'s', async () => {
    test.skip(process.platform !== 'win32', 'the drawn bar is for Windows and Linux; macOS has its bar');
    const strip = page.locator('[data-window-menu-bar]');
    await expect(strip).toHaveCount(0);
    // The row the window's controls sit over now: after Alt it starts under the bar.
    const rowTop = () => page.evaluate(() => {
      const row = document.querySelector('[data-test-top-row]') ?? document.querySelector('[data-window-row-right]');
      row?.setAttribute('data-test-top-row', '');
      return Math.round(row!.getBoundingClientRect().top);
    });
    const controlsHeight = () => page.evaluate(() => (navigator as unknown as { windowControlsOverlay: { getTitlebarAreaRect: () => DOMRect } }).windowControlsOverlay.getTitlebarAreaRect().height);
    expect(await rowTop()).toBe(0);
    const tall = await controlsHeight();
    const alt = (type: 'keyDown' | 'keyUp') => app.evaluate(({ BrowserWindow }, t) => {
      BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: t, keyCode: 'Alt' } as never);
    }, type);
    await alt('keyDown');
    await alt('keyUp');
    await expect(strip).toBeVisible({ timeout: 5000 });
    const names = strip.locator('[data-menu-name]');
    await expect(names).toHaveText(['File', 'Edit', 'View', 'Message', 'Go', 'Window', 'Help']);
    await expect(names.first()).toBeFocused();
    if (process.env.BULWARK_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.BULWARK_SCREENSHOTS, 'menus-altbar-after.png') });
    const barHeight = Math.round((await strip.boundingBox())!.height);
    // Pushed down, not covered, and the controls are as tall as the bar.
    await expect.poll(rowTop).toBe(barHeight);
    await expect.poll(controlsHeight).toBe(barHeight);
    // The controls' room is kept on the bar's own row.
    expect(await strip.evaluate((el) => el.hasAttribute('data-window-row-right'))).toBe(true);

    // The arrows open a menu drawn from the app menu, with the keys apart from the names.
    await page.keyboard.press('ArrowDown');
    const file = strip.getByRole('menu', { name: 'File' });
    await expect(file).toBeVisible();
    await expect(file.locator('[data-menu-label]')).toContainText(['New message', 'New window', 'Print…', 'Settings…', 'Close', 'Exit']);
    await expect(file.getByRole('menuitem', { name: /New message/ }).locator('[data-menu-keys]')).toHaveText('Ctrl+N');
    if (process.env.BULWARK_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.BULWARK_SCREENSHOTS, 'menus-altbar-file.png') });
    // Right goes on to Edit, as in any Windows menu bar.
    await page.keyboard.press('ArrowRight');
    await expect(strip.getByRole('menu', { name: 'Edit' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(strip.getByRole('menu')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(strip).toHaveCount(0);
    await expect.poll(rowTop).toBe(0);
    await expect.poll(controlsHeight).toBe(tall);

    // Alt and V opens View, and its line keeps the bar: the shell's own item runs.
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Alt' } as never);
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['alt'] } as never);
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['alt'] } as never);
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Alt' } as never);
    });
    const view = strip.getByRole('menu', { name: 'View' });
    await expect(view).toBeVisible({ timeout: 5000 });
    await view.getByRole('menuitemcheckbox', { name: /Always show the menu bar/ }).click();
    await expect.poll(async () => (await menuItem(app, 'view.menuBar'))?.checked).toBe(true);
    await expect(strip).toBeVisible();
    await expect.poll(rowTop).toBe(barHeight);
    if (process.env.BULWARK_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.BULWARK_SCREENSHOTS, 'menus-altbar-always.png') });
    // Kept across a reload, from the first frame.
    await page.reload();
    await expect(strip).toBeVisible({ timeout: 60_000 });
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-menu-bar'))).toBe(true);
    // And off again, from the native menu this time.
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu()!.getMenuItemById('view.menuBar')!;
      (item.click as (...args: unknown[]) => void)(undefined, BrowserWindow.getAllWindows()[0], BrowserWindow.getAllWindows()[0].webContents);
    });
    await expect(strip).toHaveCount(0, { timeout: 5000 });
    await expect.poll(controlsHeight).toBe(tall);
  });
});

test.describe('composers', () => {
  let profile = '';
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    profile = tempProfile('compose');
    ({ app, page } = await launchStandalone(profile));
    await fakeOsIntegration(app);
    await recordMenus(app);
    await signInRemembered(page);
  });

  test.afterAll(async () => {
    await app.close().catch(() => {});
    removeProfile(profile);
  });

  const stateFile = () => JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8')) as { session?: { type: string; url: string }[] };

  async function openComposerWindow(): Promise<Page> {
    await page.evaluate(() => {
      (window as unknown as { bulwarkDesktop: { windows: { openComposer: (t: object) => void } } }).bulwarkDesktop.windows.openComposer({ url: '/popout/compose', name: `compose-${Date.now()}` });
    });
    const composer = await pageWith(app, '/popout/compose');
    await composer.getByPlaceholder(/subject/i).or(composer.getByLabel(/subject/i)).first().waitFor({ timeout: 60_000 });
    return composer;
  }

  const typeDraft = async (composer: Page, subject: string) => {
    await composer.getByPlaceholder(/subject/i).or(composer.getByLabel(/subject/i)).first().fill(subject);
    await composer.locator('[contenteditable="true"], textarea').last().click();
    await composer.keyboard.type(`Text of ${subject}`);
  };

  test('File, New Message in a pop-out opens another composer window', async () => {
    const first = await openComposerWindow();
    await sendCommand(app, '/popout/compose', 'file.newMessage');
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('/popout/compose')).length)).toBe(2);
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().includes('/popout/compose')) window.close();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect.poll(() => first.isClosed()).toBe(true);
  });

  test('its own close button asks natively, and Save has saved before the window closes itself', async () => {
    const subject = `${TAG} closed`;
    const composer = await openComposerWindow();
    await typeDraft(composer, subject);
    await fakeOsIntegration(app, 0);
    const count = (await prompts(app)).length;
    await clickOwnClose(composer);
    await expect.poll(async () => (await prompts(app)).length, { timeout: 10_000 }).toBe(count + 1);
    const prompt = (await prompts(app)).at(-1) as unknown as { buttons: string[] };
    expect(prompt.buttons).toEqual(['Save', 'Discard', 'Cancel']);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => draftsWithSubject(SERVER, ACCOUNT, ENT_PASSWORD, subject), { timeout: 20_000 }).toHaveLength(1);
    seeded.push(...await draftsWithSubject(SERVER, ACCOUNT, ENT_PASSWORD, subject));
  });

  test('Discard in the same question leaves nothing on the server', async () => {
    const subject = `${TAG} discarded`;
    const composer = await openComposerWindow();
    await typeDraft(composer, subject);
    await fakeOsIntegration(app, 1);
    await clickOwnClose(composer);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 30_000 }).toBe(1);
    await page.waitForTimeout(1500);
    expect(await draftsWithSubject(SERVER, ACCOUNT, ENT_PASSWORD, subject)).toHaveLength(0);
  });

  test('the X on the window saves too, with no question', async () => {
    const subject = `${TAG} x-button`;
    const composer = await openComposerWindow();
    await typeDraft(composer, subject);
    const count = (await prompts(app)).length;
    await composer.waitForTimeout(100);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/compose'))!.close();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => draftsWithSubject(SERVER, ACCOUNT, ENT_PASSWORD, subject), { timeout: 20_000 }).toHaveLength(1);
    seeded.push(...await draftsWithSubject(SERVER, ACCOUNT, ENT_PASSWORD, subject));
    expect((await prompts(app)).length).toBe(count);
  });

  test('quitting with a composer open saves it, and the next start brings it back with its text, one draft only', async () => {
    const subject = `${TAG} restored`;
    const composer = await openComposerWindow();
    await typeDraft(composer, subject);
    // A message window as well.
    const messageId = await seed(`${TAG} restored message`);
    await page.evaluate(
      (id) => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: `/popout/message/${encodeURIComponent(id)}`, emailId: id }),
      messageId,
    );
    await pageWith(app, `/popout/message/${encodeURIComponent(messageId)}`);
    const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await gone;

    const session = stateFile().session ?? [];
    expect(session.map((entry) => entry.type).sort()).toEqual(['composer', 'message']);
    const drafts = await draftsWithSubject(SERVER, ACCOUNT, ENT_PASSWORD, subject);
    expect(drafts).toHaveLength(1);
    seeded.push(...drafts);

    app = await launch(profile, '--standalone');
    await shownPage(app);
    // Not the last window: the ones coming back may have opened by now.
    page = app.windows().find((w) => !w.url().includes('/popout/'))!;
    await fakeOsIntegration(app);
    await recordMenus(app);
    await expectMailShown(page);
    const restored = await pageWith(app, `draft=${encodeURIComponent(drafts[0])}`, 60_000);
    await expect(restored.getByPlaceholder(/subject/i).or(restored.getByLabel(/subject/i)).first()).toHaveValue(subject, { timeout: 60_000 });
    await expect(restored.locator('body')).toContainText(`Text of ${subject}`, { timeout: 30_000 });
    const message = await pageWith(app, `/popout/message/${encodeURIComponent(messageId)}`, 60_000);
    await expect(message.locator('body')).toContainText(`Body of ${TAG} restored message`, { timeout: 60_000 });
    // The window coming back wrote nothing new.
    expect(await draftsWithSubject(SERVER, ACCOUNT, ENT_PASSWORD, subject)).toHaveLength(1);
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().includes('/popout/')) window.close();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 30_000 }).toBe(1);
  });

  test('an entry naming mail that is no draft opens nothing and touches nothing', async () => {
    const subject = `${TAG} not a draft`;
    const id = await seed(subject);
    const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await gone;
    const file = path.join(profile, 'shell-state.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const login = `${ACCOUNT}@${new URL(SERVER).hostname}`;
    state.session = [{ type: 'composer', url: `https://app.bulwark.localhost/popout/compose?draft=${id}&account=${encodeURIComponent(login)}`, key: 'restored:x' }];
    writeFileSync(file, JSON.stringify(state));

    app = await launch(profile, '--standalone');
    await shownPage(app);
    page = app.windows().find((w) => !w.url().includes('/popout/'))!;
    await fakeOsIntegration(app);
    await recordMenus(app);
    await expectMailShown(page);
    // It may come up for a moment to look. It goes without a composer.
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('/popout/compose')).length), { timeout: 30_000 }).toBe(0);
    await page.waitForTimeout(1500);
    const [[, answer]] = await jmap(SERVER, ACCOUNT, ENT_PASSWORD, [['Email/get', { ids: [id], properties: ['subject'] }, 'g']]);
    expect((answer as { list: { subject: string }[] }).list[0]?.subject).toBe(subject);
  });

  test('with the setting off, nothing comes back', async () => {
    const subject = `${TAG} not-restored`;
    await page.evaluate(() => {
      localStorage.setItem('bulwark-desktop-window-prefs', JSON.stringify({ openOnDoubleClick: true, restoreWindows: false }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'bulwark-desktop-window-prefs' }));
    });
    await page.waitForTimeout(300);
    const composer = await openComposerWindow();
    await typeDraft(composer, subject);
    const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await gone;
    seeded.push(...await draftsWithSubject(SERVER, ACCOUNT, ENT_PASSWORD, subject));

    app = await launch(profile, '--standalone');
    page = await shownPage(app);
    await fakeOsIntegration(app);
    await recordMenus(app);
    await expectMailShown(page);
    await page.waitForTimeout(3000);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  });
});

test.describe('the warm spare', () => {
  let profile = '';
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    profile = tempProfile('spare');
    ({ app, page } = await launchStandalone(profile, '--bulwark-test-spare'));
    await fakeOsIntegration(app);
    await signInRemembered(page);
  });

  test.afterAll(async () => {
    await app.close().catch(() => {});
    removeProfile(profile);
  });

  const spareId = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/spare'))?.id ?? null);

  test('none at the start for someone who hasn\'t used a pop-out', async () => {
    await page.waitForTimeout(9000);
    expect(await spareId()).toBeNull();
  });

  test('the first pop-out brings one, hidden, that has asked for no session', async () => {
    const first = await seed(`${TAG} first`);
    await page.evaluate(
      (id) => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: `/popout/message/${encodeURIComponent(id)}`, emailId: id }),
      first,
    );
    const firstWindow = await pageWith(app, `/popout/message/${encodeURIComponent(first)}`);
    await expect.poll(spareId, { timeout: 40_000 }).not.toBeNull();
    const spare = await pageWith(app, '/popout/spare');
    await expect(spare.locator('[data-popout-spare]')).toBeAttached({ timeout: 30_000 });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/spare'))!.isVisible())).toBe(false);
    // Nothing reached the mail server from it, and the shell doesn't list it as a window.
    const server = new URL(SERVER).host;
    expect(await spare.evaluate((host) => performance.getEntriesByType('resource').filter((entry) => entry.name.includes(host) || entry.name.includes('/__jmap/') || entry.name.includes('/jmap')).length, server)).toBe(0);
    expect(await spare.evaluate(() => document.querySelectorAll('[data-popout-window]').length)).toBe(0);
    const list = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { list: () => Promise<unknown[]> } } }).bulwarkDesktop.windows.list());
    expect(list).toHaveLength(2);
    await firstWindow.close();
  });

  test('a message opens in it, without loading a page, and the right message shows', async () => {
    const subject = `${TAG} spare`;
    const messageId = await seed(subject);
    const before = await spareId();
    const spare = await pageWith(app, '/popout/spare');
    await spare.evaluate(() => {
      (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
    });
    await page.evaluate(
      (id) => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: `/popout/message/${encodeURIComponent(id)}`, emailId: id }),
      messageId,
    );
    const message = await pageWith(app, `/popout/message/${encodeURIComponent(messageId)}`);
    expect(await message.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
    await expect(message.locator('body')).toContainText(`Body of ${subject}`, { timeout: 60_000 });
    const window = await app.evaluate(({ BrowserWindow }, id) => {
      const found = BrowserWindow.fromId(id)!;
      return { url: found.webContents.getURL(), visible: found.isVisible() };
    }, before!);
    expect(window.url).toContain('/popout/message/');
    expect(window.visible).toBe(true);
  });

  test('another spare gets made for the next one', async () => {
    await expect.poll(spareId, { timeout: 30_000 }).not.toBeNull();
  });

  test('a composer opens in one too, and the spare never counts as a window to quit over', async () => {
    await expect.poll(async () => {
      const spare = app.windows().find((w) => w.url().includes('/popout/spare'));
      return spare ? spare.locator('[data-popout-spare]').count() : 0;
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      (window as unknown as { bulwarkDesktop: { windows: { openComposer: (t: object) => void } } }).bulwarkDesktop.windows.openComposer({ url: '/popout/compose', name: 'spare-compose' });
    });
    const composer = await pageWith(app, '/popout/compose');
    await composer.getByPlaceholder(/subject/i).or(composer.getByLabel(/subject/i)).first().waitFor({ timeout: 60_000 });
    // Everything closes with a spare still loaded: the app still quits. With nothing to stay running in, that is.
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { os: { setSettings: (patch: unknown) => Promise<unknown> } } }).bulwarkDesktop.os.setSettings({ closeToTray: false }));
    await expect.poll(spareId, { timeout: 30_000 }).not.toBeNull();
    const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.getURL().includes('/popout/spare')) window.close();
    });
    await gone;
  });
});

test.describe('the warm spare over time', () => {
  const spareId = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/spare'))?.id ?? null);

  test('someone who used a pop-out this week has one from the start; it goes when unused, and when all windows are hidden', async () => {
    const profile = tempProfile('spare2');
    writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({ mode: 'standalone', lastPopoutAt: Date.now() - 3600_000 }));
    const app = await launch(profile, '--standalone', '--bulwark-test-spare', '--bulwark-test-spare-idle=4000');
    try {
      await shownPage(app);
      await expect.poll(() => spareId(app), { timeout: 40_000 }).not.toBeNull();
      // Half an hour in real life.
      await expect.poll(() => spareId(app), { timeout: 40_000 }).toBeNull();
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });

  test('last used long ago: none', async () => {
    const profile = tempProfile('spare3');
    writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({ mode: 'standalone', lastPopoutAt: Date.now() - 30 * 24 * 3600_000 }));
    const app = await launch(profile, '--standalone', '--bulwark-test-spare');
    try {
      const page = await shownPage(app);
      await page.waitForTimeout(10_000);
      expect(await spareId(app)).toBeNull();
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });

  test('all windows hidden to the tray: it goes', async () => {
    const profile = tempProfile('spare4');
    writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({ mode: 'standalone', lastPopoutAt: Date.now() - 3600_000 }));
    const app = await launch(profile, '--standalone', '--bulwark-test-spare');
    try {
      await shownPage(app);
      await expect.poll(() => spareId(app), { timeout: 40_000 }).not.toBeNull();
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/spare'))!.hide();
      });
      await expect.poll(() => spareId(app), { timeout: 10_000 }).toBeNull();
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });
});
