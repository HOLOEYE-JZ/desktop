import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { expectMailShown, launchStandalone, removeOsTraces, removeProfile, requireAccount, SCREENSHOTS, signIn, STALWARTS, tempProfile, ENT_PASSWORD, type Launched } from './helpers';
import { pageWith } from './native-helpers';

/**
 * The webmail's side on a real server, real mail arriving at a window hidden in the tray.
 * Needs a webmail build with lib/desktop's OS code in ./webmail.
 *
 *   IT_ENT_PASSWORD=<test account password> npx playwright test test/os-mail.spec.ts
 */

const RECIPIENT = 'ent-dave@example.org';
const SENDER = 'ent-carol@example.org';
const RUN = Date.now().toString(36);

interface Toast { toastXml: string; title: string; body: string }

type Calls = [string, Record<string, unknown>, string][];

async function jmap(server: string, user: string, calls: Calls, using: string[]) {
  const auth = `Basic ${Buffer.from(`${user}:${ENT_PASSWORD}`).toString('base64')}`;
  const session = await (await fetch(`${server}/jmap/session`, { headers: { Authorization: auth } })).json() as { apiUrl: string; primaryAccounts: Record<string, string> };
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
  const apiUrl = new URL(session.apiUrl, server).toString();
  const withAccount = calls.map(([name, args, id]) => [name, { accountId, ...args }, id]);
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', ...using], methodCalls: withAccount }),
  });
  return (await response.json()) as { methodResponses: [string, Record<string, never>, string][] };
}

async function mailboxes(server: string, user: string) {
  const answer = await jmap(server, user, [['Mailbox/get', {}, '0']], []);
  return answer.methodResponses[0][1].list as unknown as { id: string; role: string | null }[];
}

async function deliver(server: string, subject: string, extra: Record<string, unknown> = {}) {
  const boxes = await mailboxes(server, SENDER);
  const drafts = boxes.find((box) => box.role === 'drafts')!.id;
  const sent = boxes.find((box) => box.role === 'sent')!.id;
  const identity = (await jmap(server, SENDER, [['Identity/get', {}, '0']], ['urn:ietf:params:jmap:submission'])).methodResponses[0][1].list as unknown as { id: string }[];
  const answer = await jmap(server, SENDER, [
    ['Email/set', {
      create: {
        m: {
          mailboxIds: { [drafts]: true },
          keywords: { $draft: true, $seen: true },
          from: [{ name: 'Carol Sender', email: SENDER }],
          to: [{ email: RECIPIENT }],
          subject,
          bodyValues: { t: { value: 'Body of the test message' } },
          textBody: [{ partId: 't', type: 'text/plain' }],
          ...extra,
        },
      },
    }, '0'],
    ['EmailSubmission/set', {
      create: { s: { identityId: identity[0].id, emailId: '#m' } },
      onSuccessUpdateEmail: { '#s': { [`mailboxIds/${drafts}`]: null, [`mailboxIds/${sent}`]: true, 'keywords/$draft': null } },
    }, '1'],
  ], ['urn:ietf:params:jmap:submission']);
  if (!answer.methodResponses[1][1].created) throw new Error(`Not delivered: ${JSON.stringify(answer).slice(0, 400)}`);
}

async function inboxMessage(server: string, subject: string) {
  const answer = await jmap(server, RECIPIENT, [
    ['Email/query', { filter: { subject }, limit: 1 }, '0'],
    ['Email/get', { '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['id', 'mailboxIds', 'keywords', 'subject'] }, '1'],
  ], []);
  return (answer.methodResponses[1][1].list as unknown as { id: string; mailboxIds: Record<string, boolean>; keywords: Record<string, boolean> }[])[0];
}

async function record(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow, Notification }) => {
    const g = globalThis as unknown as { __toasts: unknown[]; __drag: unknown[] };
    g.__toasts = [];
    g.__drag = [];
    Notification.prototype.show = function show(this: Electron.Notification) {
      g.__toasts.push({ toastXml: this.toastXml, title: this.title, body: this.body });
    };
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.startDrag = (item) => { g.__drag.push({ ...item, icon: undefined }); };
    (globalThis as unknown as { __bulwarkOs: { toasts: { setFocusAssistForTest: (v: string) => void } } }).__bulwarkOs.toasts.setFocusAssistForTest('off');
    // Nothing here has the focus for real, or would keep it on someone's desktop.
    BrowserWindow.getFocusedWindow = () => null;
  });
}

const toasts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __toasts: Toast[] }).__toasts);

const toastFor = async (app: ElectronApplication, subject: string): Promise<Toast> => {
  let found: Toast | undefined;
  await expect.poll(async () => {
    found = (await toasts(app)).find((toast) => toast.toastXml?.includes(subject));
    return !!found;
  }, { timeout: 90_000, intervals: [500], message: `no toast for ${subject}` }).toBe(true).catch(async (error) => {
    console.log('toasts so far:', (await toasts(app)).map((toast) => /<text>(.*?)<\/text><text>(.*?)<\/text>/.exec(toast.toastXml)?.slice(1).join(' | ')));
    throw error;
  });
  return found!;
};

const unescapeXml = (text: string) => text.replace(/&#(\d+);/g, (_all, code) => String.fromCharCode(Number(code)));

/** What the toast's button hands back, read off the toast itself: the same as Windows would pass. */
function toastContext(toast: Toast): string {
  const match = /launch="([^"]*)"/.exec(toast.toastXml);
  const context = match && new URL(unescapeXml(match[1])).searchParams.get('c');
  if (!context) throw new Error(`No launch in ${toast.toastXml}`);
  return context;
}

const press = (app: ElectronApplication, command: unknown, show: boolean) =>
  app.evaluate((_e, [c, s]) => (globalThis as unknown as { __bulwarkOs: { hub: { dispatch: (c: unknown, o: unknown) => void } } }).__bulwarkOs.hub.dispatch(c, { show: s }), [command, show] as const);

const launchFile = (app: ElectronApplication, profile: string, file: string) =>
  app.evaluate((_e, [f, cwd]) => (globalThis as unknown as { __bulwarkOs: { launch: { handle: (a: string[], c: string) => Promise<number> } } }).__bulwarkOs.launch.handle(['bulwark.exe', '--', f], cwd), [file, profile] as const);

const hide = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
const composer = (page: Page) => page.locator('[data-testid="email-composer"]').first();

async function closeComposer(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  // Its question comes on top of the composer's own button, and later in the page.
  for (let tries = 0; tries < 4 && await composer(page).isVisible(); tries += 1) {
    const discard = page.getByRole('button', { name: /discard/i }).last();
    if (await discard.isVisible().catch(() => false)) await discard.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  await composer(page).waitFor({ state: 'hidden', timeout: 15_000 });
}

for (const { label, url } of STALWARTS) {
  test.describe(`OS integration with real mail on Stalwart ${label}`, () => {
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(240_000);
    let profile: string;
    let running: Launched;

    test.beforeAll(async () => {
      requireAccount();
      profile = tempProfile('osm');
      running = await launchStandalone(profile);
      await signIn(running.page, url, RECIPIENT);
      await record(running.app);
    });

    test.afterAll(async () => {
      await running?.app.close().catch(() => {});
      removeProfile(profile);
      removeOsTraces();
    });

    test('mail arriving at a window in the tray: a toast with its buttons, the badge and the tray menu', async () => {
      const { app, page } = running;
      await hide(app);
      const subject = `os-arrive-${RUN}-${label}`;
      await deliver(url, subject);
      const toast = await toastFor(app, subject);
      expect(toast.toastXml).toContain('Carol Sender');
      for (const name of ['Archive', 'Mark as read', 'Delete', 'Reply']) expect(toast.toastXml).toMatch(new RegExp(`content="[^"]*${name.split(' ')[0]}`, 'i'));

      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { badge: number } } }).__bulwarkOs.hub.badge), { timeout: 60_000 }).toBeGreaterThan(0);
      await expect.poll(() => app.evaluate(() => JSON.stringify((globalThis as unknown as { __bulwarkOs: { hub: { summary: unknown } } }).__bulwarkOs.hub.summary)), { timeout: 60_000 }).toContain(subject);
      await expect.poll(() => app.evaluate(() => JSON.stringify((globalThis as unknown as { __bulwarkOs: { tray: { template: () => { label?: string }[] } } }).__bulwarkOs.tray.template().map((item) => item.label))), { timeout: 30_000 }).toContain(subject);
      expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    });

    test('Mark read from the toast marks it on the server, with the window staying hidden', async () => {
      const { app } = running;
      const subject = `os-read-${RUN}-${label}`;
      await deliver(url, subject);
      const toast = await toastFor(app, subject);
      await press(app, { type: 'notification', action: 'mark-read', context: toastContext(toast) }, false);
      await expect.poll(async () => (await inboxMessage(url, subject))?.keywords?.$seen ?? false, { timeout: 30_000 }).toBe(true);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
    });

    test('Archive from the toast files it on the server', async () => {
      const { app } = running;
      const subject = `os-archive-${RUN}-${label}`;
      await deliver(url, subject);
      const toast = await toastFor(app, subject);
      const boxes = await mailboxes(url, RECIPIENT);
      const inbox = boxes.find((box) => box.role === 'inbox')!.id;
      await press(app, { type: 'notification', action: 'archive', context: toastContext(toast) }, false);
      await expect.poll(async () => !!(await inboxMessage(url, subject))?.mailboxIds?.[inbox], { timeout: 30_000 }).toBe(false);
    });

    test('Delete from the toast moves it to Trash on the server', async () => {
      const { app } = running;
      const subject = `os-delete-${RUN}-${label}`;
      await deliver(url, subject);
      const toast = await toastFor(app, subject);
      const boxes = await mailboxes(url, RECIPIENT);
      const trash = boxes.find((box) => box.role === 'trash')!.id;
      await press(app, { type: 'notification', action: 'delete', context: toastContext(toast) }, false);
      await expect.poll(async () => !!(await inboxMessage(url, subject))?.mailboxIds?.[trash], { timeout: 30_000 }).toBe(true);
    });

    test('Reply on the toast opens the window and the composer with the typed text', async () => {
      const { app, page } = running;
      const subject = `os-reply-${RUN}-${label}`;
      await deliver(url, subject);
      const toast = await toastFor(app, subject);
      await press(app, { type: 'notification', action: 'reply', context: toastContext(toast), reply: 'On my way' }, true);
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
      await composer(page).waitFor({ state: 'visible', timeout: 30_000 });
      await expect(composer(page)).toContainText('On my way');
      await closeComposer(page);
    });

    test('Do not disturb in the app: nothing shows', async () => {
      const { app, page } = running;
      const before = (await toasts(app)).length;
      await page.evaluate(() => {
        const raw = localStorage.getItem('settings-storage');
        if (!raw) return;
        const parsed = JSON.parse(raw);
        parsed.state.doNotDisturb = true;
        localStorage.setItem('settings-storage', JSON.stringify(parsed));
        window.dispatchEvent(new StorageEvent('storage', { key: 'settings-storage', newValue: JSON.stringify(parsed) }));
      });
      const subject = `os-quiet-${RUN}-${label}`;
      await deliver(url, subject);
      await expect.poll(async () => inboxMessage(url, subject), { timeout: 30_000 }).toBeTruthy();
      await page.waitForTimeout(8000);
      expect((await toasts(app)).slice(before).some((toast) => toast.toastXml?.includes(subject))).toBe(false);
      await page.evaluate(() => {
        const raw = localStorage.getItem('settings-storage');
        if (!raw) return;
        const parsed = JSON.parse(raw);
        parsed.state.doNotDisturb = false;
        localStorage.setItem('settings-storage', JSON.stringify(parsed));
        window.dispatchEvent(new StorageEvent('storage', { key: 'settings-storage', newValue: JSON.stringify(parsed) }));
      });
    });

    test('tray commands and launches: New message, mailto, and each file type opened through the handoff', async () => {
      const { app, page } = running;
      await press(app, { type: 'new-message' }, true);
      const quick = await pageWith(app, '/popout/compose');
      await composer(quick).waitFor({ state: 'visible', timeout: 30_000 });
      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().includes('/popout/compose')) window.close();
      });
      await expect.poll(() => quick.isClosed(), { timeout: 30_000 }).toBe(true);

      // A mail link from another program: a compose window of its own, as Outlook opens,
      // and the main window stays as it was, hidden in the tray here.
      await hide(app);
      await press(app, { type: 'mailto', url: `mailto:someone@example.org?subject=${encodeURIComponent(`mailto ${RUN}`)}` }, true);
      const linked = await pageWith(app, '/popout/compose');
      await expect(linked.locator('[data-testid="composer-subject"]')).toHaveValue(`mailto ${RUN}`, { timeout: 30_000 });
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'))?.isVisible())).toBe(false);
      await expect(composer(page)).toHaveCount(0);
      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().includes('/popout/compose')) window.destroy();
      });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'))?.show());

      const eml = path.join(profile, 'letter.eml');
      writeFileSync(eml, `From: Someone <someone@example.org>\r\nTo: ${RECIPIENT}\r\nSubject: Opened file ${RUN}\r\nDate: Tue, 3 Nov 2026 09:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nFrom a file.\r\n`);
      await launchFile(app, profile, eml);
      await expect(page.getByRole('heading', { name: `Opened file ${RUN}` })).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('heading', { name: `Opened file ${RUN}` })).toHaveCount(0, { timeout: 15_000 });

      // A document opened with the app, as Send to: a compose window with it attached, as a
      // mail link gets, and the main window stays hidden in the tray.
      await hide(app);
      const pdf = path.join(profile, 'dropped.pdf');
      writeFileSync(pdf, '%PDF-1.4 test');
      await launchFile(app, profile, pdf);
      const attached = await pageWith(app, '/popout/compose');
      await expect(composer(attached).getByText('dropped.pdf')).toBeVisible({ timeout: 30_000 });
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'))?.isVisible())).toBe(false);
      await expect(composer(page)).toHaveCount(0);
      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().includes('/popout/compose')) window.destroy();
      });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'))?.show());
    });

    test('a file dropped or pasted on the window attaches', async () => {
      const { page } = running;
      // A drop from outside goes through the overlay: its "new message" zone opens the composer.
      await page.evaluate((n) => {
        const data = new DataTransfer();
        data.items.add(new File(['hello'], n, { type: 'text/plain' }));
        (window as unknown as { __drag: DataTransfer }).__drag = data;
        document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }));
      }, `dropped-${RUN}.txt`);
      const zone = page.locator('[data-testid="file-drop-overlay"] [data-drop-zone="new-message"]');
      await zone.waitFor({ state: 'visible', timeout: 30_000 });
      await zone.evaluate((element) => {
        const data = (window as unknown as { __drag: DataTransfer }).__drag;
        element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      });
      await composer(page).waitFor({ state: 'visible', timeout: 30_000 });
      await expect(composer(page).getByText(`dropped-${RUN}.txt`)).toBeVisible({ timeout: 30_000 });
      // Pasted into the open composer, it goes on that message, not a queue. Pasted outside
      // any text field the overlay's choice asks (decision: one drop target for files).
      await composer(page).locator('[contenteditable="true"]').last().evaluate((element, n) => {
        const data = new DataTransfer();
        data.items.add(new File(['hello'], n, { type: 'text/plain' }));
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      }, `pasted-${RUN}.txt`);
      await expect(composer(page).getByText(`pasted-${RUN}.txt`)).toBeVisible({ timeout: 30_000 });
      await closeComposer(page);
    });

    test('Inbox and Calendar from the jump list go where they say', async () => {
      const { app, page } = running;
      await press(app, { type: 'navigate', target: 'calendar' }, true);
      await page.waitForURL(/\/calendar/, { timeout: 30_000 });
      await press(app, { type: 'navigate', target: 'inbox' }, true);
      await expectMailShown(page);
      await page.waitForURL((address) => !address.pathname.includes('/calendar'), { timeout: 30_000 });
    });

    test('an attachment drags out as a real file with its real bytes', async () => {
      const { app, page } = running;
      const subject = `os-attach-${RUN}-${label}`;
      const boxes = await mailboxes(url, SENDER);
      const auth = `Basic ${Buffer.from(`${SENDER}:${ENT_PASSWORD}`).toString('base64')}`;
      const session = await (await fetch(`${url}/jmap/session`, { headers: { Authorization: auth } })).json() as { uploadUrl: string; primaryAccounts: Record<string, string> };
      const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
      const upload = new URL(session.uploadUrl.replace('{accountId}', accountId), url).toString();
      const uploaded = await (await fetch(upload, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'text/plain' }, body: `attachment ${RUN}` })).json() as { blobId: string };
      expect(boxes.length).toBeGreaterThan(0);
      await deliver(url, subject, { attachments: [{ blobId: uploaded.blobId, type: 'text/plain', name: `file-${RUN}.txt`, disposition: 'attachment' }] });

      await page.locator(`[data-testid="email-list-item"][data-subject="${subject}"]`).first().click({ timeout: 60_000 });
      const tile = page.locator(`[data-testid="attachment"][data-attachment-name="file-${RUN}.txt"]`).first();
      await tile.waitFor({ timeout: 30_000 });
      await tile.hover();
      await page.waitForTimeout(2500); // The hover's fetch.
      await tile.evaluate((element) => element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })));
      let dragged: { files: string[] } | undefined;
      await expect.poll(async () => {
        [dragged] = await app.evaluate(() => (globalThis as unknown as { __drag: { files: string[] }[] }).__drag);
        return !!dragged;
      }, { timeout: 20_000 }).toBe(true);
      const { readFileSync } = await import('node:fs');
      expect(path.basename(dragged!.files[0])).toBe(`file-${RUN}.txt`);
      expect(readFileSync(dragged!.files[0], 'utf8')).toBe(`attachment ${RUN}`);
      await expect(tile.getByRole('button', { name: /copy as file/i })).toBeAttached();
    });

    test('the Desktop app section in settings shows and changes what main holds', async () => {
      const { app, page } = running;
      await page.goto(`${new URL(page.url()).origin}/settings/general`);
      const section = page.locator('#desktop-app').or(page.getByRole('heading', { name: 'Desktop app' })).first();
      await section.waitFor({ timeout: 60_000 });
      await section.scrollIntoViewIfNeeded();
      if (label === '1.0') await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-os-settings.png') });
      const row = page.getByText('Keep running in the tray when closed').locator('xpath=ancestor::*[.//button[@role="switch"]][1]');
      await row.getByRole('switch').click();
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { settings: () => { closeToTray: boolean } } } }).__bulwarkOs.hub.settings().closeToTray)).toBe(false);
      await row.getByRole('switch').click();
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { settings: () => { closeToTray: boolean } } } }).__bulwarkOs.hub.settings().closeToTray)).toBe(true);
    });
  });
}
