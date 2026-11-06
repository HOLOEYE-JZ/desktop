import { EventEmitter } from 'node:events';
import { expect, test } from '@playwright/test';
import type { FeatureContext } from '../src/main/features';
import { OsHub } from '../src/main/features/os-hub';
import { MainStart, showMainStep } from '../src/main/window-logic';

/** What a toast click does to the main window, without one. The e2e side is toast-click.spec.ts. */

test.describe('the main window while the app starts', () => {
  test('started in the tray, then a toast clicked before the window exists: it shows', () => {
    const start = new MainStart();
    start.startHidden();
    start.wantShown();
    expect(start.take()).toBe(false);
  });

  test('the click handed over before the start in the tray was decided: it still shows', () => {
    // os-launch.ts runs launches that came during the boot before it reads its own command line.
    const start = new MainStart();
    start.wantShown();
    start.startHidden();
    expect(start.take()).toBe(false);
  });

  test('a start in the tray alone stays there, and each window spends what was asked', () => {
    const start = new MainStart();
    start.startHidden();
    expect(start.take()).toBe(true);
    expect(start.take()).toBe(false);
    start.wantShown();
    expect(start.take()).toBe(false);
    // The wish was for that window, not for every later one.
    start.startHidden();
    expect(start.take()).toBe(true);
  });

  test('"show me the app" before the boot opened the window is kept, not dropped', () => {
    expect(showMainStep({ booted: false, hasMain: false, hidden: false })).toBe('keep-wish');
    expect(showMainStep({ booted: false, hasMain: false, hidden: true })).toBe('start-hidden');
    expect(showMainStep({ booted: true, hasMain: true, hidden: false })).toBe('focus');
    expect(showMainStep({ booted: true, hasMain: false, hidden: false })).toBe('open');
    expect(showMainStep({ booted: true, hasMain: false, hidden: true })).toBe('open');
    // The page has work and the window is there: it stays where the user left it.
    expect(showMainStep({ booted: true, hasMain: true, hidden: true })).toBe('none');
  });
});

test.describe('a toast action reaching the hub', () => {
  const setup = (withMain: boolean) => {
    const shows: unknown[] = [];
    const sent: unknown[] = [];
    const contents = { id: 1, isDestroyed: () => false, send: (_channel: string, command: unknown) => sent.push(command) };
    const windows = new EventEmitter() as EventEmitter & { mainWindow: () => unknown; broadcast: () => void; startMainHidden: () => void };
    windows.mainWindow = () => (withMain ? { webContents: contents } : undefined);
    windows.broadcast = () => {};
    windows.startMainHidden = () => shows.push('startMainHidden');
    const os = new OsHub({ windows, state: { data: {}, touch() {}, save() {} }, showMain: (options?: unknown) => shows.push(options ?? 'show') } as unknown as FeatureContext);
    return { os, shows, contents, sent };
  };

  test("Archive with no main window yet asks for a hidden one, which a click's wish can still win over", () => {
    // Before, it set the hidden start and then called the plain "show me the app", which
    // while the app starts is the user's wish to see it.
    const { os, shows } = setup(false);
    os.setLockedByMain(false);
    os.toastAction('archive', '{}');
    expect(shows).toEqual([{ hidden: true }]);
  });

  test('while the app starts and no page has said yet, a button leaves a start in the tray alone; a click or a real lock does not', () => {
    const button = setup(false);
    button.os.toastAction('archive', '{}');
    // Neither shown nor hidden: whether the window starts in the tray stays the start's call.
    expect(button.shows).toEqual([]);
    expect(button.sent).toEqual([]);

    const click = setup(false);
    click.os.toastAction('open', '{}');
    expect(click.shows).toEqual(['show']);

    const realLock = setup(false);
    realLock.os.setLockedByMain(true);
    realLock.os.toastAction('archive', '{}');
    expect(realLock.shows).toEqual(['show']);

    // Running, with the page reloading: the window comes up as before.
    const reloading = setup(true);
    reloading.os.toastAction('archive', '{}');
    expect(reloading.shows).toEqual(['show']);
  });

  test('a click asks to see the window, locked or not', () => {
    const unlocked = setup(true);
    unlocked.os.subscribe(unlocked.contents as never);
    unlocked.os.setLockedByPage(false, unlocked.contents as never);
    unlocked.os.toastAction('open', '{"emailId":"e1"}');
    expect(unlocked.shows).toEqual(['show']);
    expect(unlocked.sent).toEqual([{ type: 'notification', action: 'open', context: '{"emailId":"e1"}', reply: undefined }]);

    const locked = setup(true);
    locked.os.toastAction('open', '{}');
    expect(locked.shows).toEqual(['show']);
  });
});
