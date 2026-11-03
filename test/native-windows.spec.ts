import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT, ENT_PASSWORD, expectMailShown, fakeOsIntegration, fillLogin, launchStandalone, prompts, removeProfile, requireAccount, shownPage, STALWARTS, tempProfile, launch } from './helpers';
import { destroyMessages, draftsWithSubject, jmap, lastMenu, menuCount, menuItem, pageWith, pickNext, recordMenus, seedMessage, type SeenItem } from './native-helpers';

/**
 * Multi-window on a real account, with a webmail build of this branch:
 *   BULWARK_TEST_WEBMAIL=<dir> vw exec --env IT_ENT_PASSWORD="vault://Stalwart test – ent-* throwaway accounts/password" -- npx playwright test test/native-windows.spec.ts
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

const labels = (items: SeenItem[] | undefined) => (items ?? []).map((item) => item.label).filter(Boolean);

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

  test('right-click on a message: the HTML menu\'s entries, natively', async () => {
    await page.keyboard.press('Escape');
    const before = await menuCount(app);
    await rowOf(page, messageId).click({ button: 'right' });
    await expect.poll(() => menuCount(app), { timeout: 10_000 }).toBeGreaterThan(before);
    const menu = (await lastMenu(app))!;
    expect(labels(menu)).toEqual(expect.arrayContaining(['Reply', 'Forward', 'Open in new window', 'Delete']));
    const move = menu.find((item) => /^Move to/.test(item.label));
    expect(move?.submenu && labels(move.submenu).length).toBeGreaterThan(0);
    // The HTML copy is off the screen.
    const visible = await page.locator('[role="menu"]').evaluateAll((menus) => menus.filter((m) => getComputedStyle(m as HTMLElement).visibility === 'visible').length);
    expect(visible).toBe(0);
  });

  test('picking from it does what the HTML entry does', async () => {
    const before = await menuCount(app);
    await pickNext(app, 'Mark as unread');
    await rowOf(page, messageId).click({ button: 'right' });
    await expect.poll(() => menuCount(app), { timeout: 10_000 }).toBeGreaterThan(before);
    await expect.poll(() => flagged(messageId, '$seen'), { timeout: 20_000 }).toBe(false);
    await expect(rowOf(page, messageId)).toHaveAttribute('data-unread', 'true', { timeout: 20_000 });
  });

  test('Open in new window from the menu: the same one window', async () => {
    const before = await menuCount(app);
    await pickNext(app, 'Open in new window');
    await rowOf(page, messageId).click({ button: 'right' });
    await expect.poll(() => menuCount(app), { timeout: 10_000 }).toBeGreaterThan(before);
    await pageWith(app, `/popout/message/${encodeURIComponent(messageId)}`);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/message/'))!.close();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  });

  test('a folder has a native menu too', async () => {
    const before = await menuCount(app);
    await page.getByRole('navigation').getByText(/^Inbox/).first().click({ button: 'right' });
    await expect.poll(() => menuCount(app), { timeout: 10_000 }).toBeGreaterThan(before);
    expect(labels(await lastMenu(app)).length).toBeGreaterThan(1);
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

  test('Settings opens in a window of its own, and its switch reaches the shell and the other windows', async () => {
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()!.getMenuItemById('help.settings')!.click();
    });
    const settings = await pageWith(app, '/settings');
    const list = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { list: () => Promise<{ type: string }[]> } } }).bulwarkDesktop.windows.list());
    expect(list.map((w) => w.type).sort()).toEqual(['main', 'settings']);
    await settings.goto(new URL('/settings/general', settings.url()).toString());
    await settings.getByText('Open messages in a new window on double-click').waitFor({ timeout: 60_000 });
    const flip = () => settings.evaluate(() => {
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
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/settings'))!.close();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
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

  test('Alt floats the menu over the app, moves nothing, and a name opens that menu natively', async () => {
    test.skip(process.platform !== 'win32', 'the strip is for Windows; macOS has its bar');
    await expect(page.locator('[data-window-menu-bar]')).toHaveCount(0);
    const layout = () => page.evaluate(() => {
      const box = document.querySelector('[data-window-row-right]')!.getBoundingClientRect();
      return [box.left, box.top, box.width, box.height];
    });
    const before0 = await layout();
    const alt = (type: 'keyDown' | 'keyUp') => app.evaluate(({ BrowserWindow }, t) => {
      BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: t, keyCode: 'Alt' } as never);
    }, type);
    await alt('keyDown');
    await alt('keyUp');
    const strip = page.locator('[data-window-menu-bar]');
    await expect(strip).toBeVisible({ timeout: 5000 });
    await expect(strip.getByRole('menuitem')).toHaveText(['File', 'Edit', 'View', 'Message', 'Go', 'Window', 'Help']);
    expect(await strip.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
    expect(await layout()).toEqual(before0);
    const before = await menuCount(app);
    await strip.getByRole('menuitem', { name: 'File' }).click();
    await expect.poll(() => menuCount(app)).toBeGreaterThan(before);
    expect(labels(await lastMenu(app))).toEqual(expect.arrayContaining(['New message', 'Print…', 'Close']));
    // It goes when its menu does.
    await expect(strip).toBeHidden({ timeout: 5000 });
    // And Escape, without a menu.
    await alt('keyDown');
    await alt('keyUp');
    await expect(strip).toBeVisible({ timeout: 5000 });
    // The keys go to the first name, which takes the focus just after it shows.
    await expect(strip.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(strip).toBeHidden({ timeout: 5000 });
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
    // Everything closes with a spare still loaded: the app still quits.
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
