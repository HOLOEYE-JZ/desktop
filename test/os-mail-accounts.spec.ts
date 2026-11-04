import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { expectMailShown, fillLogin, launchStandalone, removeOsTraces, removeProfile, signIn, tempProfile, type Launched } from './helpers';

/**
 * New mail with two accounts signed in and the main window in the tray, on a real
 * server: a toast for each account, named by its address, and the tray's unread list
 * following the account in front. Needs a webmail build with lib/desktop's OS code.
 *
 *   IT_DSO_PASSWORD=<test accounts' password> npx playwright test test/os-mail-accounts.spec.ts
 */

const SERVER = process.env.BULWARK_TEST_STALWART ?? 'https://stalwart-1.internal.bulwarkmail.org';
const FIRST = process.env.BULWARK_TEST_FIRST ?? 'dso-ux-desktop@example.org';
const SECOND = process.env.BULWARK_TEST_SECOND ?? 'dso-ux-desktop-b@example.org';
const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
const RUN = Date.now().toString(36);

interface Toast { toastXml: string; title: string; body: string }
type Calls = [string, Record<string, unknown>, string][];
type Bulwark = { __bulwarkOs: { hub: { summary: unknown }; tray: { template: () => { label?: string; icon?: unknown }[] } }; __toasts: Toast[] };

async function jmap(user: string, calls: Calls, using: string[] = []) {
  const auth = `Basic ${Buffer.from(`${user}:${PASSWORD}`).toString('base64')}`;
  const session = await (await fetch(`${SERVER}/jmap/session`, { headers: { Authorization: auth } })).json() as { apiUrl: string; primaryAccounts: Record<string, string> };
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
  const response = await fetch(new URL(session.apiUrl, SERVER).toString(), {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', ...using], methodCalls: calls.map(([name, args, id]) => [name, { accountId, ...args }, id]) }),
  });
  return (await response.json()) as { methodResponses: [string, Record<string, never>, string][] };
}

/** Sent through the server, as a person would: the push and the delivery are real. */
async function deliver(from: string, to: string, subject: string) {
  const boxes = (await jmap(from, [['Mailbox/get', {}, '0']])).methodResponses[0][1].list as unknown as { id: string; role: string | null }[];
  const drafts = boxes.find((box) => box.role === 'drafts')!.id;
  const sent = boxes.find((box) => box.role === 'sent')!.id;
  const identities = (await jmap(from, [['Identity/get', {}, '0']], ['urn:ietf:params:jmap:submission'])).methodResponses[0][1].list as unknown as { id: string; email: string }[];
  const identity = identities.find((candidate) => candidate.email === from) ?? identities[0];
  const answer = await jmap(from, [
    ['Email/set', {
      create: {
        m: {
          mailboxIds: { [drafts]: true },
          keywords: { $draft: true, $seen: true },
          from: [{ name: 'Sam Ortega', email: from }],
          to: [{ email: to }],
          subject,
          bodyValues: { t: { value: 'Body of the test message' } },
          textBody: [{ partId: 't', type: 'text/plain' }],
        },
      },
    }, '0'],
    ['EmailSubmission/set', {
      create: { s: { identityId: identity.id, emailId: '#m' } },
      onSuccessUpdateEmail: { '#s': { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true, 'keywords/$draft': null } },
    }, '1'],
  ], ['urn:ietf:params:jmap:submission']);
  if (!answer.methodResponses[1][1].created) throw new Error(`Not delivered: ${JSON.stringify(answer).slice(0, 400)}`);
}

const CALENDARS = 'urn:ietf:params:jmap:calendars';

async function addEvent(user: string, title: string, start: Date): Promise<string> {
  const calendars = (await jmap(user, [['Calendar/get', {}, '0']], [CALENDARS])).methodResponses[0][1].list as unknown as { id: string }[];
  const answer = await jmap(user, [['CalendarEvent/set', {
    create: {
      e: {
        '@type': 'Event',
        calendarIds: { [calendars[0].id]: true },
        title,
        start: start.toISOString().slice(0, 19),
        timeZone: 'Etc/UTC',
        duration: 'PT1H',
      },
    },
  }, '0']], [CALENDARS]);
  const created = (answer.methodResponses[0][1] as { created?: Record<string, { id: string }> }).created;
  if (!created?.e) throw new Error(`No event: ${JSON.stringify(answer).slice(0, 400)}`);
  return created.e.id;
}

/** This run's event, and any a run that broke off left behind. */
async function removeEvents(user: string): Promise<void> {
  const found = await jmap(user, [['CalendarEvent/query', { filter: { title: 'tray-event-' } }, '0']], [CALENDARS]);
  const ids = (found.methodResponses[0][1] as { ids?: string[] }).ids ?? [];
  if (ids.length === 0) return;
  const answer = await jmap(user, [['CalendarEvent/set', { destroy: ids }, '0']], [CALENDARS]);
  const destroyed = (answer.methodResponses[0][1] as { destroyed?: string[] }).destroyed ?? [];
  if (destroyed.length !== ids.length) console.log('events left behind:', JSON.stringify(answer).slice(0, 300));
}

async function record(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow, Notification, shell }) => {
    const g = globalThis as unknown as { __toasts: unknown[]; __opened: string[] };
    g.__toasts = [];
    g.__opened = [];
    // Nothing reaches the desktop: no toast, no browser.
    Notification.prototype.show = function show(this: Electron.Notification) {
      g.__toasts.push({ toastXml: this.toastXml, title: this.title, body: this.body });
    };
    shell.openExternal = async (url: string) => { g.__opened.push(url); };
    (globalThis as unknown as { __bulwarkOs: { toasts: { setFocusAssistForTest: (v: string) => void } } }).__bulwarkOs.toasts.setFocusAssistForTest('off');
    BrowserWindow.getFocusedWindow = () => null;
  });
}

const toasts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as Bulwark).__toasts);
const trayLabels = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as Bulwark).__bulwarkOs.tray.template().map((item) => item.label ?? ''));
const mainWindow = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => {
  const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'));
  return { visible: main?.isVisible() ?? false };
});
const hide = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'))?.close());
const show = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'))?.show());

/** The toast's two text lines, as Windows shows them. */
const lines = (toast: Toast) => [...toast.toastXml.matchAll(/<text>(.*?)<\/text>/g)].map((match) => match[1]);

async function toastFor(app: ElectronApplication, subject: string): Promise<Toast> {
  let found: Toast | undefined;
  await expect.poll(async () => {
    found = (await toasts(app)).find((toast) => toast.toastXml?.includes(subject));
    return !!found;
  }, { timeout: 90_000, intervals: [500], message: `no toast for ${subject}` }).toBe(true).catch(async (error) => {
    console.log('toasts so far:', (await toasts(app)).map(lines));
    throw error;
  });
  return found!;
}

/** The account is named by its address: both test accounts have the same display name. */
function named(toast: Toast, address: string): void {
  expect(lines(toast).join(' ')).toContain(address);
}

async function expectInTray(app: ElectronApplication, subject: string): Promise<void> {
  await expect.poll(async () => (await trayLabels(app)).some((label) => label.includes(subject)), { timeout: 60_000, intervals: [1000], message: `${subject} not in the tray` }).toBe(true).catch(async (error) => {
    console.log('tray:', await trayLabels(app));
    throw error;
  });
}

test.describe('Two accounts, main window in the tray', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);
  let profile: string;
  let running: Launched;
  let page: Page;

  test.beforeAll(async () => {
    if (!PASSWORD) throw new Error("Set IT_DSO_PASSWORD to the test accounts' password");
    profile = tempProfile('osa');
    running = await launchStandalone(profile);
    page = running.page;
    await record(running.app);
    await signIn(page, SERVER, FIRST, PASSWORD);
    await page.getByTestId('account-switcher').first().click();
    await page.getByTestId('add-account').first().click();
    await fillLogin(page, SERVER, SECOND, PASSWORD);
    await page.keyboard.press('Enter');
    await expectMailShown(page);
    // The second account is the one in front now.
    await expect.poll(async () => JSON.stringify(await running.app.evaluate(() => (globalThis as unknown as Bulwark).__bulwarkOs.hub.summary)), { timeout: 60_000 }).toContain(SECOND);
    // Every login has its baseline and its push.
    await page.waitForTimeout(8000);
  });

  test.afterAll(async () => {
    await running?.app.close().catch(() => {});
    removeProfile(profile);
    removeOsTraces();
  });

  test('mail to the account not in front gives a toast that names it by address', async () => {
    const { app } = running;
    await hide(app);
    expect((await mainWindow(app)).visible).toBe(false);
    const subject = `behind-${RUN}`;
    await deliver(SECOND, FIRST, subject);
    const toast = await toastFor(app, subject);
    named(toast, FIRST);
  });

  test('mail to the account in front: a toast with its address, and the tray lists it while hidden', async () => {
    const { app } = running;
    expect((await mainWindow(app)).visible).toBe(false);
    const subject = `front-${RUN}`;
    await deliver(FIRST, SECOND, subject);
    const toast = await toastFor(app, subject);
    named(toast, SECOND);
    await expectInTray(app, subject);
    expect((await mainWindow(app)).visible).toBe(false);
  });

  test('the tray follows new mail while hidden on another page too', async () => {
    const { app } = running;
    await show(app);
    // Left there in the app, as a person does: the mail view is gone, its store stays.
    await page.getByRole('link', { name: 'Calendar' }).first().click();
    await page.waitForURL(/\/calendar/, { timeout: 30_000 });
    await page.waitForTimeout(3000);
    await hide(app);
    const subject = `calendar-${RUN}`;
    await deliver(FIRST, SECOND, subject);
    await toastFor(app, subject);
    await expectInTray(app, subject);
    expect((await mainWindow(app)).visible).toBe(false);
  });

  test('and in a window that started on Calendar, where the mail view never loaded', async () => {
    const { app } = running;
    await show(app);
    await page.goto(`${new URL(page.url()).origin}/calendar`);
    await page.waitForURL(/\/calendar/, { timeout: 30_000 });
    await page.waitForTimeout(3000);
    await hide(app);
    const subject = `calendar-start-${RUN}`;
    await deliver(FIRST, SECOND, subject);
    await toastFor(app, subject);
    await expectInTray(app, subject);
  });

  test('the next event in the tray follows a language change at once', async () => {
    const { app } = running;
    // Two hours ahead: inside the tray's 24 hours whenever this runs. Persian writes its
    // digits differently, so even a time without a weekday shows the language.
    const start = Math.ceil(Date.now() / 60_000) * 60_000 + 2 * 3600_000;
    await removeEvents(SECOND);
    await addEvent(SECOND, `tray-event-${RUN}`, new Date(start));
    try {
      await show(app);
      await page.goto(`${new URL(page.url()).origin}/settings/general`);
      const nextEvent = () => app.evaluate(() => ((globalThis as unknown as Bulwark).__bulwarkOs.hub.summary as { nextEvent: { title: string; when: string } | null }).nextEvent);
      // What the line says in a language, as the page writes it (24 hours, the weekday on another day).
      const written = (locale: string) => page.evaluate(([at, lang]) => {
        const sameDay = new Date(at).toDateString() === new Date().toDateString();
        const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false, ...(sameDay ? {} : { weekday: 'short' }) };
        return new Intl.DateTimeFormat(lang, options).format(new Date(at));
      }, [start, locale] as const);
      expect(await written('fa')).not.toBe(await written('en'));
      await expect.poll(async () => (await nextEvent())?.title ?? '', { timeout: 30_000 }).toContain('tray-event-');
      const pick = async (search: string) => {
        // The language is the section's first pick list; the date format below it is a plain select.
        await page.getByRole('main').locator('button[aria-haspopup="listbox"]').first().click();
        await page.locator('input[role="combobox"]').fill(search);
        await page.keyboard.press('Enter');
      };
      // Each time before the summary's next timed read (2 s after a change, 5 minutes otherwise).
      await pick('Persian');
      await expect.poll(async () => (await nextEvent())?.when ?? '', { timeout: 1500, intervals: [100] }).toBe(await written('fa'));
      await pick('English');
      await expect.poll(async () => (await nextEvent())?.when ?? '', { timeout: 1500, intervals: [100] }).toBe(await written('en'));
      const line = (await trayLabels(app)).find((label) => label.includes('tray-event-'));
      expect(line).toBe(`Next: tray-event-${RUN}, ${await written('en')}`);
    } finally {
      await removeEvents(SECOND);
    }
  });

  test('after a restart, with the other login connecting later: mail to either still gives a toast and the tray', async () => {
    await running.app.close();
    running = await launchStandalone(profile);
    page = running.page;
    const { app } = running;
    await record(app);
    await expectMailShown(page);
    await expect.poll(async () => JSON.stringify(await app.evaluate(() => (globalThis as unknown as Bulwark).__bulwarkOs.hub.summary)), { timeout: 60_000 }).toContain(SECOND);
    await page.waitForTimeout(8000);
    await hide(app);
    for (const round of [1, 2]) {
      const subject = `restart-behind-${round}-${RUN}`;
      await deliver(SECOND, FIRST, subject);
      const toast = await toastFor(app, subject);
      named(toast, FIRST);
    }
    const subject = `restart-front-${RUN}`;
    await deliver(FIRST, SECOND, subject);
    await toastFor(app, subject);
    await expectInTray(app, subject);
  });
});
