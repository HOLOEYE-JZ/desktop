import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchStandalone, removeOsTraces, removeProfile, requireAccount, SCREENSHOTS, signIn, STALWARTS, tempProfile, ENT_PASSWORD, type Launched } from './helpers';

/**
 * Calendar reminders end to end: a real calendar on a real server, the store's own clock,
 * a window hidden in the tray, a quit and a restart. Real time passes, so this is long.
 * Needs a webmail build with the reminders in ./webmail.
 *
 *   vw exec --env IT_ENT_PASSWORD="vault://Stalwart test – ent-* throwaway accounts/password" -- npx playwright test test/reminders-real.spec.ts
 */

const USER = 'ent-dave@example.org';
const ZONE = 'Europe/Berlin';
const RUN = Date.now().toString(36);
const OFFSET_MIN = 5;
const SYNC_MS = 45_000;
const MIN = 60_000;
/** The webmail's AWAY_MS and a margin. */
const AWAY_MS = 6.5 * MIN;
const ROOT = path.resolve(import.meta.dirname, '..');

interface Toast { toastXml: string; title: string; body: string }

async function jmap(server: string, calls: [string, Record<string, unknown>, string][]) {
  const auth = `Basic ${Buffer.from(`${USER}:${ENT_PASSWORD}`).toString('base64')}`;
  const session = await (await fetch(`${server}/jmap/session`, { headers: { Authorization: auth } })).json() as { apiUrl: string; primaryAccounts: Record<string, string> };
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:calendars'];
  const response = await fetch(new URL(session.apiUrl, server).toString(), {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'],
      methodCalls: calls.map(([name, args, id]) => [name, { accountId, ...args }, id]),
    }),
  });
  return (await response.json()) as { methodResponses: [string, Record<string, unknown>, string][] };
}

function wall(ms: number): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(new Date(ms)).replace(' ', 'T');
}

async function record(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow, Notification, shell }) => {
    const g = globalThis as unknown as { __toasts: Toast[]; __opened: string[]; __realShow?: () => void };
    g.__toasts = [];
    g.__opened = [];
    g.__realShow ??= Notification.prototype.show;
    Notification.prototype.show = function show(this: Electron.Notification) {
      g.__toasts.push({ toastXml: this.toastXml, title: this.title, body: this.body });
    };
    shell.openExternal = async (url: string) => {
      g.__opened.push(url);
    };
    (globalThis as unknown as { __bulwarkOs: { toasts: { setFocusAssistForTest: (v: string) => void } } }).__bulwarkOs.toasts.setFocusAssistForTest('off');
    BrowserWindow.getFocusedWindow = () => null;
  });
}

const toasts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __toasts: Toast[] }).__toasts);
const toastsWith = async (app: ElectronApplication, text: string) => (await toasts(app)).filter((toast) => toast.toastXml?.includes(text));
const hide = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
const mainVisible = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());

async function toastFor(app: ElectronApplication, text: string, timeout: number): Promise<Toast> {
  await expect.poll(async () => (await toastsWith(app, text)).length, { timeout, intervals: [1000], message: `no toast with ${text}` }).toBeGreaterThan(0);
  return (await toastsWith(app, text))[0];
}

const unescapeXml = (text: string) => text.replace(/&#(\d+);/g, (_all, code) => String.fromCharCode(Number(code)));

function contextOf(toast: Toast): string {
  const match = /launch="([^"]*)"/.exec(toast.toastXml);
  const context = match && new URL(unescapeXml(match[1])).searchParams.get('c');
  if (!context) throw new Error(`No launch in ${toast.toastXml}`);
  return context;
}

const press = (app: ElectronApplication, action: string, toast: Toast, show: boolean) =>
  app.evaluate((_e, [command, s]) => (globalThis as unknown as { __bulwarkOs: { hub: { dispatch: (c: unknown, o: unknown) => void } } }).__bulwarkOs.hub.dispatch(command, { show: s }), [{ type: 'notification', action, context: contextOf(toast) }, show] as const);

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`) });
}

for (const { label, url } of STALWARTS) {
  test.describe(`Reminders on Stalwart ${label}`, () => {
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(30 * MIN);
    let profile: string;
    let running: Launched;
    const created: string[] = [];

    async function eventFiringAt(title: string, fireAt: number, extra: Record<string, unknown> = {}): Promise<void> {
      const calendars = (await jmap(url, [['Calendar/get', { properties: ['isDefault'] }, '0']])).methodResponses[0][1].list as { id: string; isDefault: boolean }[];
      const calendar = calendars.find((entry) => entry.isDefault) ?? calendars[0];
      const answer = await jmap(url, [['CalendarEvent/set', {
        create: {
          e: {
            '@type': 'Event',
            calendarIds: { [calendar.id]: true },
            timeZone: ZONE,
            title,
            start: wall(fireAt + OFFSET_MIN * MIN),
            duration: 'PT30M',
            useDefaultAlerts: false,
            alerts: { a1: { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: `-PT${OFFSET_MIN}M`, relativeTo: 'start' } } },
            ...extra,
          },
        },
        sendSchedulingMessages: false,
      }, '0']]);
      const id = (answer.methodResponses[0][1].created as Record<string, { id: string }> | undefined)?.e?.id;
      if (!id) throw new Error(`Event not created: ${JSON.stringify(answer)}`);
      created.push(id);
    }

    async function start(first = false): Promise<void> {
      running = await launchStandalone(profile);
      await record(running.app);
      if (first) await signIn(running.page, url, USER);
    }

    test.beforeAll(async () => {
      requireAccount();
      profile = tempProfile('rmd');
      await start(true);
      // Clicked only where the default hasn't turned it on. Its first sync takes a moment.
      const { page } = running;
      await page.goto(new URL('/settings/backup/offline', page.url()).toString());
      const toggle = page.getByTestId('offline-switch');
      await toggle.waitFor({ state: 'visible', timeout: MIN });
      if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
      await expect(page.getByTestId('offline-status')).toContainText('updated', { timeout: 3 * MIN });
      await page.goto(new URL('/', page.url()).toString());
      await page.waitForTimeout(SYNC_MS);
    });

    test.afterAll(async () => {
      await running?.app.close().catch(() => {});
      if (created.length > 0) await jmap(url, [['CalendarEvent/set', { destroy: created, sendSchedulingMessages: false }, '0']]).catch(() => {});
      removeProfile(profile);
      removeOsTraces();
    });

    test('hidden in the tray and offline: a toast with Join and three snoozes, for an event with a link', async () => {
      const { app, page } = running;
      await hide(app);
      const title = `rem-link-${RUN}-${label}`;
      const fireAt = Date.now() + SYNC_MS + 15_000;
      await eventFiringAt(title, fireAt, { virtualLocations: { v: { '@type': 'VirtualLocation', name: 'Meet', uri: 'https://meet.jit.si/rem-test' } } });
      await page.waitForTimeout(SYNC_MS);
      await page.context().setOffline(true);
      const toast = await toastFor(app, title, 90_000);
      await page.context().setOffline(false);
      for (const name of ['Join', 'Open', '5 min', '10 min', '15 min']) expect(toast.toastXml).toContain(`content="${name}"`);
      expect(await mainVisible(app)).toBe(false);

      await press(app, 'join', toast, false);
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual(['https://meet.jit.si/rem-test']);
      expect(await mainVisible(app)).toBe(false);
    });

    test('an event without a link has no Join; a snooze comes back after a restart, with the window hidden until then', async () => {
      const { app, page } = running;
      const title = `rem-snooze-${RUN}-${label}`;
      await eventFiringAt(title, Date.now() + SYNC_MS + 10_000);
      await page.waitForTimeout(0);
      const toast = await toastFor(app, title, 2 * MIN);
      expect(toast.toastXml).not.toContain('content="Join"');
      expect(toast.toastXml).toContain('content="Open"');

      await press(app, 'snooze-5', toast, false);
      await page.waitForTimeout(3000);
      expect(await mainVisible(app)).toBe(false);
      const snoozedAt = Date.now();
      await app.evaluate(({ app: electronApp }) => electronApp.quit());
      await new Promise((resolve) => setTimeout(resolve, 5000));

      await start();
      await record(running.app);
      await running.page.waitForTimeout(Math.max(snoozedAt + 4.5 * MIN - Date.now(), 0));
      expect(await toastsWith(running.app, title)).toEqual([]);
      const back = await toastFor(running.app, title, 2 * MIN);
      expect(back.toastXml).toContain('content="5 min"');
      await running.page.waitForTimeout(30_000);
      expect(await toastsWith(running.app, title)).toHaveLength(1);
    });

    test('Open brings the window up on the event', async () => {
      const { app, page } = running;
      await hide(app);
      const title = `rem-open-${RUN}-${label}`;
      await eventFiringAt(title, Date.now() + SYNC_MS + 10_000);
      const toast = await toastFor(app, title, 2 * MIN);
      await press(app, 'open', toast, true);
      await expect.poll(() => mainVisible(app)).toBe(true);
      await expect(page).toHaveURL(/\/calendar/, { timeout: 30_000 });
      await expect(page.locator('body')).toContainText(title, { timeout: 30_000 });
    });

    test('with the window in front it shows in the app, with the same choices', async () => {
      const { app, page } = running;
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getFocusedWindow = () => BrowserWindow.getAllWindows()[0];
      });
      const title = `rem-front-${RUN}-${label}`;
      await eventFiringAt(title, Date.now() + SYNC_MS, { virtualLocations: { v: { '@type': 'VirtualLocation', name: 'Meet', uri: 'https://meet.jit.si/rem-test' } } });
      const item = page.locator('.toast-item').filter({ hasText: title });
      await expect(item).toBeVisible({ timeout: 2 * MIN });
      await expect(item.getByRole('button', { name: 'Join' })).toBeVisible();
      await expect(item.getByRole('button', { name: 'Snooze 5 min' })).toBeVisible();
      if (label === '1.0') await shot(page, 'desktop-reminders-in-app');
      expect(await toastsWith(app, title)).toEqual([]);
      await item.getByRole('button', { name: 'Snooze 15 min' }).click();
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getFocusedWindow = () => null;
      });
    });

    test('what came due with the app quit is one summary, once, and opens from its toast', async () => {
      const { app, page } = running;
      const one = `rem-away-a-${RUN}-${label}`;
      const two = `rem-away-b-${RUN}-${label}`;
      const fireAt = Date.now() + SYNC_MS + 15_000;
      await eventFiringAt(one, fireAt);
      await eventFiringAt(two, fireAt + 15_000);
      await page.waitForTimeout(SYNC_MS);
      await app.evaluate(({ app: electronApp }) => electronApp.quit());
      await new Promise((resolve) => setTimeout(resolve, AWAY_MS + 30_000));

      await start();
      const summary = await toastFor(running.app, one, 2 * MIN);
      expect(summary.toastXml).toContain(two);
      expect(summary.toastXml).toContain('2 reminders you missed');
      expect(await toastsWith(running.app, two)).toHaveLength(1);

      await running.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
      await press(running.app, 'open', summary, true);
      await expect.poll(() => mainVisible(running.app)).toBe(true);
      const list = running.page.getByTestId('missed-reminders');
      await expect(list).toContainText(one, { timeout: 30_000 });
      await expect(list).toContainText(two);
      if (label === '1.0') await shot(running.page, 'desktop-reminders-missed');
      await running.page.getByRole('button', { name: 'Done' }).click();

      await running.app.evaluate(({ app: electronApp }) => electronApp.quit());
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await start();
      await running.page.waitForTimeout(40_000);
      expect(await toastsWith(running.app, one)).toEqual([]);
    });

    test('a locked app says only that there is a reminder', async () => {
      const { app, page } = running;
      await page.evaluate(() => (window as unknown as { bulwarkDesktop: { os: { setLocked: (l: boolean) => void } } }).bulwarkDesktop.os.setLocked(true));
      await hide(app);
      const title = `rem-locked-${RUN}-${label}`;
      const before = (await toasts(app)).length;
      await eventFiringAt(title, Date.now() + SYNC_MS + 10_000);
      await expect.poll(async () => (await toasts(app)).length, { timeout: 2 * MIN, intervals: [1000] }).toBeGreaterThan(before);
      const toast = (await toasts(app))[before];
      expect(`${toast.toastXml}${toast.title}${toast.body}`).not.toContain(title);
      expect(toast.toastXml).toContain('You have a reminder');
      expect(toast.toastXml).not.toContain('content="');
      await page.evaluate(() => (window as unknown as { bulwarkDesktop: { os: { setLocked: (l: boolean) => void } } }).bulwarkDesktop.os.setLocked(false));
    });

    test('Windows takes the real toast with its five buttons', async () => {
      test.skip(process.platform !== 'win32' || label !== '1.0');
      const { app, page } = running;
      // This one is shown for real.
      await app.evaluate(({ Notification }) => {
        Notification.prototype.show = (globalThis as unknown as { __realShow: () => void }).__realShow;
      });
      const result = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { os: { notify: (n: unknown) => Promise<unknown> } } }).bulwarkDesktop.os.notify({
        id: 'reminders-spec-real',
        group: 'reminders',
        kind: 'reminder',
        title: 'Project review',
        body: 'In 10 min · Personal',
        context: '{}',
        actions: [
          { id: 'join', label: 'Join' },
          { id: 'open', label: 'Open' },
          { id: 'snooze-5', label: '5 min' },
          { id: 'snooze-10', label: '10 min' },
          { id: 'snooze-15', label: '15 min' },
        ],
      }));
      expect(result).toMatchObject({ shown: true });
      const script = path.join(ROOT, 'test', 'support', 'toast-readback.ps1');
      const read = () => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Aumid', 'org.bulwarkmail.desktop', '-Tag', 'reminders-spec-real'], { encoding: 'utf8', windowsHide: true });
      await expect.poll(read, { timeout: 15_000 }).toContain('Project review');
      const xml = read();
      for (const name of ['Join', 'Open', '5 min', '10 min', '15 min']) expect(xml).toContain(`content="${name}"`);
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Aumid', 'org.bulwarkmail.desktop', '-Tag', 'reminders-spec-real', '-Clear'], { encoding: 'utf8', windowsHide: true });
    });
  });
}
