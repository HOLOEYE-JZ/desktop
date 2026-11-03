import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchStandalone, removeOsTraces, removeProfile, tempProfile, type Launched } from './helpers';

/**
 * What the shell adds for calendar reminders, on the real app at its login page. The
 * webmail's side, with a real calendar: reminders-real.spec.ts.
 */

const win = process.platform === 'win32';

interface Toast { title: string; body: string; toastXml: string }

async function record(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow, Notification }) => {
    const g = globalThis as unknown as { __shown: Toast[] };
    g.__shown = [];
    Notification.prototype.show = function show(this: Electron.Notification) {
      g.__shown.push({ title: this.title, body: this.body, toastXml: this.toastXml });
    };
    BrowserWindow.getFocusedWindow = () => null;
    (globalThis as unknown as { __bulwarkOs: { toasts: { setFocusAssistForTest: (v: string) => void } } }).__bulwarkOs.toasts.setFocusAssistForTest('off');
  });
}

const shown = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __shown: Toast[] }).__shown);

type Os = { os: { notify: (n: unknown) => Promise<unknown>; setLocked: (l: boolean) => void } };

const notify = (page: Page, notification: unknown) =>
  page.evaluate((n) => (window as unknown as { bulwarkDesktop: Os }).bulwarkDesktop.os.notify(n), notification);

const REMINDER = {
  id: 'reminder:one',
  kind: 'reminder',
  title: 'Board meeting',
  body: 'In 10 min',
  context: JSON.stringify({ r: 'j1:uid:a:1' }),
  actions: [
    { id: 'join', label: 'Join' },
    { id: 'open', label: 'Open' },
    { id: 'snooze-5', label: '5 min' },
    { id: 'snooze-10', label: '10 min' },
    { id: 'snooze-15', label: '15 min' },
  ],
};

test.describe('reminder toasts', () => {
  let profile: string;
  let running: Launched;

  test.beforeEach(async () => {
    profile = tempProfile('rem');
    running = await launchStandalone(profile);
    await record(running.app);
  });

  test.afterEach(async () => {
    await running?.app.close().catch(() => {});
    removeProfile(profile);
    removeOsTraces();
  });

  test('carries all five buttons, Open among them', async () => {
    test.skip(!win, 'Only Windows builds its own toast');
    expect(await notify(running.page, REMINDER)).toMatchObject({ shown: true });
    const [toast] = await shown(running.app);
    for (const label of ['Join', 'Open', '5 min', '10 min', '15 min']) expect(toast.toastXml).toContain(`content="${label}"`);
    // A button that goes by protocol, so it works with the app closed.
    expect(toast.toastXml.match(/activationType="protocol"/g)!.length).toBe(1 + 5);
    expect(toast.toastXml).toContain('Board meeting');
  });

  test('a locked app shows no title, no button and no key, and says it is a reminder', async () => {
    await running.page.evaluate(() => (window as unknown as { bulwarkDesktop: Os }).bulwarkDesktop.os.setLocked(true));
    await expect.poll(() => running.app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked)).toBe(true);
    expect(await notify(running.page, REMINDER)).toMatchObject({ shown: true });
    const [toast] = await shown(running.app);
    const all = `${toast.toastXml}${toast.title}${toast.body}`;
    expect(all).not.toContain('Board meeting');
    expect(all).not.toContain('Join');
    expect(all).not.toContain('uid');
    expect(all).toContain('You have a reminder');
    expect(all).not.toContain('new mail');
  });

  test('mail on a locked app still says mail', async () => {
    await running.page.evaluate(() => (window as unknown as { bulwarkDesktop: Os }).bulwarkDesktop.os.setLocked(true));
    await expect.poll(() => running.app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked)).toBe(true);
    await notify(running.page, { id: 'mail:1', title: 'Alice', body: 'Lunch', context: '' });
    const [toast] = await shown(running.app);
    expect(`${toast.toastXml}${toast.body}`).toContain('You have new mail');
  });

  test('pause and quiet hours hold a reminder back and say why, so the page can keep it', async () => {
    await running.page.evaluate(() => (window as unknown as { bulwarkDesktop: { os: { setPaused: (u: number) => void } } }).bulwarkDesktop.os.setPaused(Date.now() + 3_600_000));
    await expect.poll(() => running.app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { pausedUntil: () => number | null } } }).__bulwarkOs.hub.pausedUntil())).not.toBeNull();
    expect(await notify(running.page, REMINDER)).toEqual({ shown: false, reason: 'paused', playSound: false });
    await running.page.evaluate(() => (window as unknown as { bulwarkDesktop: { os: { setPaused: (u: null) => void; setSettings: (s: unknown) => Promise<unknown> } } }).bulwarkDesktop.os.setPaused(null));
    await running.page.evaluate(() => (window as unknown as { bulwarkDesktop: { os: { setSettings: (s: unknown) => Promise<unknown> } } }).bulwarkDesktop.os.setSettings({ quietHoursEnabled: true, quietHoursStart: '00:00', quietHoursEnd: '23:59' }));
    expect(await notify(running.page, { ...REMINDER, id: 'reminder:two' })).toEqual({ shown: false, reason: 'quiet-hours', playSound: false });
    expect(await shown(running.app)).toEqual([]);
  });
});
