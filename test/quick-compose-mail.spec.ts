import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT, dialogHost, ENT_PASSWORD, expectMailShown, fakeOsIntegration, fillLogin, launchStandalone, prompts, removeOsTraces, removeProfile, requireAccount, SCREENSHOTS, STALWARTS, tempProfile } from './helpers';
import { destroyMessages, draftsWithSubject, jmap, pageWith } from './native-helpers';

/**
 * Quick compose on a real account, with a webmail build of this branch:
 *   BULWARK_TEST_WEBMAIL=<dir> BULWARK_TEST_ACCOUNT=<a throwaway account of this test's own> IT_ENT_PASSWORD=<its password> npx playwright test test/quick-compose-mail.spec.ts
 * BULWARK_TEST_SERVER_LABEL picks the Stalwart (1.0 by default). Nothing a composer holds may
 * go missing, however its window goes. Teardown deletes only what this run's subjects found.
 */
const STALWART = STALWARTS.find((s) => s.label === (process.env.BULWARK_TEST_SERVER_LABEL ?? '1.0'))!;
const SERVER = STALWART.url;
const TAG = `qc${Date.now().toString(36)}`;
const seeded: string[] = [];

const COMPOSER = '[data-testid="email-composer"]';
const subjectField = (page: Page) => page.locator('[data-testid="composer-subject"]');

const press = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { quickCompose: { open: () => void } } }).__bulwarkOs.quickCompose.open());

const composerWindows = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('/popout/compose')).length);

const mainFocused = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => !w.webContents.getURL().includes('/popout/') && w.isVisible() && w.isFocused()));

async function openQuick(app: ElectronApplication): Promise<Page> {
  await press(app);
  const page = await pageWith(app, '/popout/compose');
  await subjectField(page).waitFor({ state: 'visible', timeout: 60_000 });
  // It moves the caret to the To field a moment after it shows. A fill in that moment lands there.
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('INPUT');
  return page;
}

async function typeInto(page: Page, subject: string, body = `Text of ${subject}`): Promise<void> {
  await subjectField(page).fill(subject);
  await page.locator('[contenteditable="true"], textarea').last().click();
  await page.keyboard.type(body);
}

const closeWindow = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().includes('/popout/compose')) window.close();
});

async function drafts(subject: string): Promise<string[]> {
  // Teardown destroys what this collects: a filter that could match mail of someone else's stays out.
  if (!subject.startsWith(TAG)) throw new Error(`Not a subject of this run: ${subject}`);
  const ids = await draftsWithSubject(SERVER, ACCOUNT, ENT_PASSWORD, subject);
  for (const id of ids) if (!seeded.includes(id)) seeded.push(id);
  return ids;
}

async function sentWith(subject: string): Promise<string[]> {
  const [[, answer]] = await jmap(SERVER, ACCOUNT, ENT_PASSWORD, [['Email/query', { filter: { subject, notKeyword: '$draft' }, limit: 5 }, 'q']]);
  const ids = (answer as { ids: string[] }).ids;
  for (const id of ids) if (!seeded.includes(id)) seeded.push(id);
  return ids;
}

/** How many drafts there are, whatever they're called. Stalwart's `subject: ''` matches nothing. */
async function draftCount(): Promise<number> {
  const [[, boxes]] = await jmap(SERVER, ACCOUNT, ENT_PASSWORD, [['Mailbox/get', { properties: ['role', 'totalEmails'] }, 'm']]);
  return (boxes as { list: { role: string | null; totalEmails: number }[] }).list.find((box) => box.role === 'drafts')?.totalEmails ?? 0;
}

/** Toasts handed to Windows, kept instead of shown. */
const recordToasts = (app: ElectronApplication) => app.evaluate(({ Notification }) => {
  const g = globalThis as unknown as { __toasts: string[]; __bulwarkOs: { toasts: { setFocusAssistForTest: (v: string) => void } } };
  g.__toasts = [];
  Notification.prototype.show = function show(this: Electron.Notification) {
    g.__toasts.push(this.toastXml || `${this.title}|${this.body}`);
    this.emit('show');
  };
  g.__bulwarkOs.toasts.setFocusAssistForTest('off');
});

async function discardToast(app: ElectronApplication): Promise<string> {
  let found = '';
  await expect.poll(async () => {
    const toasts = await app.evaluate(() => (globalThis as unknown as { __toasts: string[] }).__toasts);
    found = toasts.find((toast) => toast.includes('discardedDraft')) ?? '';
    return found !== '';
  }, { timeout: 30_000 }).toBe(true);
  return found;
}

/** A button on the toast, as Windows hands it back: its signed action and context. */
async function pressToastButton(app: ElectronApplication, toast: string, action: string): Promise<void> {
  const unescape = (text: string) => text.replace(/&#(\d+);/g, (_all, code) => String.fromCharCode(Number(code))).replace(/&amp;/g, '&');
  const launch = new RegExp(`arguments="([^"]*)"[^>]*content="Undo"|content="Undo"[^>]*arguments="([^"]*)"`).exec(toast);
  const url = launch ? unescape(launch[1] ?? launch[2]) : '';
  const context = url ? new URL(url).searchParams.get('c') : null;
  if (!context) throw new Error(`No Undo button in ${toast}`);
  await app.evaluate((_e, [a, c]) => (globalThis as unknown as { __bulwarkOs: { hub: { toastAction: (a: string, c: string) => void } } }).__bulwarkOs.hub.toastAction(a, c), [action, context] as const);
}

const mainVisible = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => !w.webContents.getURL().includes('/popout/') && w.isVisible()));

async function draftHasAttachment(subject: string): Promise<boolean> {
  const [[, answer]] = await jmap(SERVER, ACCOUNT, ENT_PASSWORD, [['Email/query', { filter: { subject, hasKeyword: '$draft' }, limit: 5 }, 'q']]);
  const ids = (answer as { ids: string[] }).ids;
  if (!ids.length) return false;
  const [[, got]] = await jmap(SERVER, ACCOUNT, ENT_PASSWORD, [['Email/get', { ids, properties: ['attachments'] }, 'g']]);
  return (got as { list: { attachments: { name: string }[] }[] }).list.some((email) => email.attachments.some((part) => part.name === 'figures.txt'));
}

/** Back on the mail page with no composer, whatever the test before left. */
async function clearMain(page: Page): Promise<void> {
  const open = page.locator(COMPOSER);
  if (await open.count()) {
    await page.getByTestId('composer-close').first().evaluate((el) => (el as HTMLElement).click());
    await open.waitFor({ state: 'detached', timeout: 30_000 });
  }
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(requireAccount);
test.afterAll(async () => {
  await destroyMessages(SERVER, ACCOUNT, ENT_PASSWORD, seeded).catch(() => {});
});

test.describe(`quick compose on ${STALWART.label}`, () => {
  let profile = '';
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    profile = tempProfile('qcm');
    // Keys nobody uses: a test run takes nothing from whoever is at this computer.
    ({ app, page } = await launchStandalone(profile, '--bulwark-test-quick-compose-default=CommandOrControl+Alt+Shift+F9'));
    await fakeOsIntegration(app);
    await fillLogin(page, SERVER, ACCOUNT, ENT_PASSWORD);
    await page.keyboard.press('Enter');
    await expectMailShown(page);
  });

  test.afterAll(async () => {
    await app.close().catch(() => {});
    removeProfile(profile);
    removeOsTraces();
  });

  test.afterEach(async () => {
    await closeWindow(app);
    await expect.poll(() => composerWindows(app), { timeout: 30_000 }).toBe(0);
    await clearMain(page);
  });

  test('with the main window in the tray it opens signed in, ready to type', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    const composer = await openQuick(app);
    await expect(composer.locator('[data-popout-window="compose"]')).toHaveAttribute('data-popout-status', 'ready', { timeout: 30_000 });
    // Typing starts at once, in the recipient field.
    await expect.poll(() => composer.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return active?.tagName === 'INPUT' ? 'input' : active?.tagName ?? 'none';
    })).toBe('input');
    await expect.poll(() => composer.title()).toMatch(/new message/i);
    await composer.getByTestId('composer-back-to-main').waitFor({ state: 'visible', timeout: 30_000 });
    await composer.screenshot({ path: `${SCREENSHOTS}\\desktop-quick-compose.png` });
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'));
      main?.show();
    });
  });

  test('closing the window with text leaves it in Drafts, once', async () => {
    const subject = `${TAG} closed`;
    const composer = await openQuick(app);
    await typeInto(composer, subject);
    await closeWindow(app);
    await expect.poll(() => composerWindows(app), { timeout: 30_000 }).toBe(0);
    await expect.poll(() => drafts(subject), { timeout: 30_000 }).toHaveLength(1);
    // Asked nothing: it was saved.
    expect((await prompts(app)).filter((p) => /unsaved|not saved/i.test(p.message))).toEqual([]);
  });

  // desktop-p3-1: the bin right of Send threw text away with no Undo anyone could reach.
  test('the bin, before the first save: a notification with Undo, and Undo brings the text back in quick compose', async () => {
    const subject = `${TAG} binned early`;
    await recordToasts(app);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    const composer = await openQuick(app);
    await typeInto(composer, subject, 'Typed a moment ago');
    await composer.getByTestId('composer-discard').click();
    await expect.poll(() => composerWindows(app), { timeout: 30_000 }).toBe(0);
    const toast = await discardToast(app);
    expect(toast).toContain('Draft discarded');
    expect(toast).toContain(subject);
    expect(toast).toMatch(/content="Undo"/);
    // Nothing saved: no draft to restore from.
    expect(await drafts(subject)).toHaveLength(0);

    await pressToastButton(app, toast, 'undo');
    const restored = await pageWith(app, '/popout/compose');
    await expect(subjectField(restored)).toHaveValue(subject, { timeout: 60_000 });
    await expect(restored.locator(COMPOSER)).toContainText('Typed a moment ago');
    // Quick compose's size, and the main window stays in the tray.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/compose'))!.getBounds().width)).toBeLessThan(740);
    expect(await mainVisible(app)).toBe(false);
    // It saves itself again.
    await expect.poll(() => drafts(subject), { timeout: 60_000 }).toHaveLength(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'))?.show());
  });

  test('the bin, after a save: the draft goes at once, and Undo brings it back with its attachment', async () => {
    const subject = `${TAG} binned saved`;
    await recordToasts(app);
    const composer = await openQuick(app);
    await typeInto(composer, subject, 'Saved before the bin');
    await composer.locator('input[type="file"]').first().setInputFiles({ name: 'figures.txt', mimeType: 'text/plain', buffer: Buffer.from('Q3 figures') });
    await expect(composer.getByTestId('composer-attachments')).toContainText('figures.txt', { timeout: 30_000 });
    await expect.poll(() => drafts(subject), { timeout: 60_000 }).toHaveLength(1);
    await expect.poll(() => draftHasAttachment(subject), { timeout: 60_000 }).toBe(true);
    await composer.getByTestId('composer-discard').click();
    await expect.poll(() => composerWindows(app), { timeout: 30_000 }).toBe(0);
    await expect.poll(() => drafts(subject), { timeout: 30_000 }).toHaveLength(0);

    const toast = await discardToast(app);
    await pressToastButton(app, toast, 'undo');
    const restored = await pageWith(app, '/popout/compose');
    await expect(subjectField(restored)).toHaveValue(subject, { timeout: 60_000 });
    await expect(restored.getByTestId('composer-attachments')).toContainText('figures.txt');
    await expect.poll(() => drafts(subject), { timeout: 60_000 }).toHaveLength(1);
    await expect.poll(() => draftHasAttachment(subject), { timeout: 60_000 }).toBe(true);
  });

  test('closing an empty one leaves nothing behind', async () => {
    const before = await draftCount();
    await openQuick(app);
    await closeWindow(app);
    await expect.poll(() => composerWindows(app), { timeout: 30_000 }).toBe(0);
    await page.waitForTimeout(3000);
    expect(await draftCount()).toBe(before);
  });

  test('pressing again goes back to the text, and doesn\'t start another', async () => {
    const subject = `${TAG} again`;
    const composer = await openQuick(app);
    await typeInto(composer, subject);
    await press(app);
    await composer.waitForTimeout(800);
    expect(await composerWindows(app)).toBe(1);
    await expect(subjectField(composer)).toHaveValue(subject);
  });

  test('sending goes out, the window closes, and no draft stays', async () => {
    const subject = `${TAG} sent`;
    const composer = await openQuick(app);
    // It opens with the caret in the To field.
    await expect.poll(() => composer.evaluate(() => document.activeElement?.tagName)).toBe('INPUT');
    await composer.keyboard.type(ACCOUNT);
    await composer.keyboard.press('Enter');
    await typeInto(composer, subject);
    await composer.locator('[data-testid="composer-send"]:visible').first().click();
    await expect.poll(() => composerWindows(app), { timeout: 60_000 }).toBe(0);
    await expect.poll(() => sentWith(subject), { timeout: 60_000 }).not.toHaveLength(0);
    await expect.poll(() => drafts(subject), { timeout: 30_000 }).toHaveLength(0);
  });

  test('moved to the main window, the text is there, one draft, the window gone and the main window in front', async () => {
    const subject = `${TAG} back`;
    const composer = await openQuick(app);
    await typeInto(composer, subject, 'Body that moves back');
    await composer.getByTestId('composer-back-to-main').click();
    await expect.poll(() => composerWindows(app), { timeout: 30_000 }).toBe(0);
    await expect(subjectField(page)).toHaveValue(subject, { timeout: 30_000 });
    await expect(page.locator(COMPOSER)).toContainText('Body that moves back');
    await expect.poll(() => mainFocused(app)).toBe(true);
    await expect.poll(() => drafts(subject), { timeout: 30_000 }).toHaveLength(1);
  });

  test('moved from a calendar page, the main window goes to mail for it', async () => {
    await page.locator('a[href*="/calendar"], button[aria-label*="Calendar" i]').first().click();
    await expect(page).toHaveURL(/calendar/, { timeout: 30_000 });
    const subject = `${TAG} from calendar`;
    const composer = await openQuick(app);
    await typeInto(composer, subject);
    await composer.getByTestId('composer-back-to-main').click();
    await expect(subjectField(page)).toHaveValue(subject, { timeout: 30_000 });
    await expect.poll(() => composerWindows(app), { timeout: 30_000 }).toBe(0);
    await expect(page).not.toHaveURL(/calendar/);
  });

  test('with a message already open in the main window it stays put, says so, and loses nothing', async () => {
    const mainSubject = `${TAG} in main`;
    await page.keyboard.press('c');
    await subjectField(page).waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(1000);
    await subjectField(page).fill(mainSubject);
    await page.waitForTimeout(500);
    await expect(subjectField(page)).toHaveValue(mainSubject);

    const subject = `${TAG} stays`;
    const composer = await openQuick(app);
    await typeInto(composer, subject);
    await composer.getByTestId('composer-back-to-main').click();
    await expect(composer.getByText('The main window already has a message open', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    expect(await composerWindows(app)).toBe(1);
    await expect(subjectField(composer)).toHaveValue(subject);
    await expect(subjectField(page)).toHaveValue(mainSubject);
    await closeWindow(app);
    await expect.poll(() => drafts(subject), { timeout: 30_000 }).toHaveLength(1);
  });

  test('from the main window out to its own window and back', async () => {
    const subject = `${TAG} round trip`;
    await page.keyboard.press('c');
    await subjectField(page).waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(1000);
    await subjectField(page).fill(subject);
    await page.locator(`${COMPOSER} [contenteditable="true"], ${COMPOSER} textarea`).last().click();
    await page.keyboard.type('Round trip body');

    await page.getByTestId('composer-open-in-window').click();
    const popped = await pageWith(app, '/popout/compose');
    await expect(subjectField(popped)).toHaveValue(subject, { timeout: 60_000 });
    await expect(page.locator(COMPOSER)).toHaveCount(0, { timeout: 30_000 });

    await popped.getByTestId('composer-back-to-main').click();
    await expect.poll(() => composerWindows(app), { timeout: 30_000 }).toBe(0);
    await expect(subjectField(page)).toHaveValue(subject, { timeout: 30_000 });
    await expect(page.locator(COMPOSER)).toContainText('Round trip body');
    await expect.poll(() => drafts(subject), { timeout: 30_000 }).toHaveLength(1);
  });

  test('a main window in the tray still counts, and the move brings it up', async () => {
    const subject = `${TAG} from the tray`;
    const composer = await openQuick(app);
    await typeInto(composer, subject);
    await composer.getByTestId('composer-back-to-main').waitFor({ state: 'visible', timeout: 30_000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'))?.hide());
    // Longer than the window's own look at whether a main window is there.
    await composer.waitForTimeout(1500);
    await composer.getByTestId('composer-back-to-main').click();
    await expect.poll(() => composerWindows(app), { timeout: 30_000 }).toBe(0);
    await expect.poll(() => mainFocused(app)).toBe(true);
    await expect(subjectField(page)).toHaveValue(subject, { timeout: 30_000 });
  });

  test('the settings page shows the keys, takes new ones, and says when another app has them', async () => {
    const taken = 'CommandOrControl+Alt+Shift+F7';
    const origin = new URL(page.url()).origin;
    await page.goto(`${origin}/settings/desktop`);
    const keys = page.getByTestId('quick-compose-keys');
    await keys.waitFor({ state: 'visible', timeout: 60_000 });
    await expect(keys).toHaveText('Ctrl+Alt+Shift+F9');
    await expect(page.getByText('Ctrl+Alt+Shift+F9 opens a small window', { exact: false })).toBeVisible();

    // Held in this app stands in for another app: the shell can't tell them apart either.
    await app.evaluate(({ globalShortcut }, key) => globalShortcut.register(key, () => {}), taken);
    await keys.click();
    await page.getByTestId('quick-compose-recording').waitFor({ state: 'visible' });
    await page.keyboard.press('Control+Alt+Shift+F7');
    await expect(page.getByText('Another app is using Ctrl+Alt+Shift+F7', { exact: false })).toBeVisible({ timeout: 15_000 });
    await keys.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SCREENSHOTS}\\desktop-quick-compose-settings.png` });

    await app.evaluate(({ globalShortcut }, key) => globalShortcut.unregister(key), taken);
    await page.goto(`${origin}/`);
    await expectMailShown(page);
  });

  test('written offline, closing the window keeps it, and it reaches the server when back online', async () => {
    const subject = `${TAG} offline`;
    const composer = await openQuick(app);
    await app.evaluate(({ session }) => session.fromPartition('persist:bulwark').enableNetworkEmulation({ offline: true }));
    try {
      await typeInto(composer, subject);
      await composer.waitForTimeout(500);
      await closeWindow(app);
      // Offline a saved copy can be on the device. Without one the window asks, rather than lose it.
      await expect.poll(async () => (await composerWindows(app)) === 0 || (await prompts(app)).length > 0, { timeout: 30_000 }).toBe(true);
    } finally {
      await app.evaluate(({ session }) => session.fromPartition('persist:bulwark').disableNetworkEmulation());
    }
    await expect.poll(() => composerWindows(app), { timeout: 60_000 }).toBe(0);
    await expect.poll(() => drafts(subject), { timeout: 120_000 }).not.toHaveLength(0);
  });

  test('a renderer crash brings the composer back on its saved draft, not blank, and the next save goes over that draft', async () => {
    const subject = `${TAG} crashed`;
    const body = 'Saved before the crash';
    const composer = await openQuick(app);
    await typeInto(composer, subject, body);
    await expect.poll(() => drafts(subject), { timeout: 30_000 }).toHaveLength(1);
    await expect.poll(() => composer.url()).toContain('draft=');
    expect(composer.url()).toContain('account=');

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/compose'));
      window?.webContents.forcefullyCrashRenderer();
    });
    // Playwright lets go of a page that crashed, so this asks the window that came back.
    const inWindow = (script: string) => app.evaluate(({ BrowserWindow }, code) => {
      const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/compose'));
      return window ? window.webContents.executeJavaScript(code, true).catch(() => null) : null;
    }, script);
    const SUBJECT = "document.querySelector('[data-testid=\"composer-subject\"]')";
    await expect.poll(() => inWindow(`${SUBJECT}?.value ?? ''`), { timeout: 60_000 }).toBe(subject);
    await expect.poll(() => inWindow("document.querySelector('[data-testid=\"email-composer\"]')?.innerText ?? ''"), { timeout: 30_000 }).toContain(body);

    // The next save goes over that draft, not next to it.
    await inWindow(`(() => {
      const field = ${SUBJECT};
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(`${subject} more`)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await closeWindow(app);
    await expect.poll(() => composerWindows(app), { timeout: 30_000 }).toBe(0);
    await expect.poll(() => drafts(`${subject} more`), { timeout: 30_000 }).toHaveLength(1);
    expect(await drafts(subject)).toHaveLength(1);
  });

  // Last: from here on the app has a PIN.
  test('with the real app lock: nothing opens while locked, text in an open one is saved first, and the unlock brings it all back', async () => {
    const pin = 'quick-compose-pin';
    const lockForm = page.getByTestId('app-lock-form');
    const unlock = async () => {
      await page.getByTestId('app-lock-pin').fill(pin);
      await page.getByTestId('app-lock-unlock').click();
      await expect(lockForm).toBeHidden({ timeout: 60_000 });
    };
    const lockNow = async () => {
      await page.getByTestId('app-lock-now').click();
      await expect(lockForm).toBeVisible({ timeout: 30_000 });
    };

    await page.goto(`${new URL(page.url()).origin}/settings/privacy`);
    const toggle = page.getByTestId('app-lock-switch');
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 60_000 });
    await toggle.click();
    // The PIN dialog is a window of its own (dialog-surfaces.ts), or over the page with an older webmail.
    const pinDialog = await dialogHost(app, page, '[data-testid="app-lock-new-pin"]');
    await pinDialog.getByTestId('app-lock-new-pin').fill(pin);
    await pinDialog.getByTestId('app-lock-repeat-pin').fill(pin);
    await pinDialog.getByTestId('app-lock-dialog-save').click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });

    // A press behind the lock shows the lock screen and no composer.
    await lockNow();
    await press(app);
    await page.waitForTimeout(2000);
    expect(await composerWindows(app)).toBe(0);
    await expect(lockForm).toBeVisible();

    // The unlock is what lets it through, signed in.
    await unlock();
    const quick = await pageWith(app, '/popout/compose');
    await subjectField(quick).waitFor({ state: 'visible', timeout: 60_000 });

    // Writing when the lock comes: on the server first, then nothing on screen, then back.
    const subject = `${TAG} behind the lock`;
    await typeInto(quick, subject, 'Written as the lock came');
    await lockNow();
    await expect.poll(() => drafts(subject), { timeout: 60_000 }).toHaveLength(1);
    await expect(quick.locator('body')).not.toContainText(subject, { timeout: 30_000 });
    await expect(quick.locator('body')).not.toContainText('Written as the lock came');
    await expect(subjectField(quick)).toHaveCount(0, { timeout: 30_000 });

    await unlock();
    await expect(subjectField(quick)).toHaveValue(subject, { timeout: 60_000 });
  });
});
