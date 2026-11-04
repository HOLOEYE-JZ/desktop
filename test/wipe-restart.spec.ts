import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchStandalone, removeProfile, tempProfile, waitForLogin } from './helpers';

// A wipe leaves windows with no page in them. Nobody is left to answer a close, and nothing
// may wait for an answer. The app starts again on a clean first screen.

const CLOSE_LIMIT_MS = 30_000;

/** A real close. It has to end by itself: no fake dialog stands in for the one that would hang it. */
async function closesWithin(app: ElectronApplication, limit = CLOSE_LIMIT_MS): Promise<boolean> {
  return Promise.race([
    app.close().then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), limit)),
  ]);
}

const exits = (app: ElectronApplication) => new Promise<void>((resolve) => app.process().once('exit', () => resolve()));

function wipeFromTest(app: ElectronApplication): Promise<unknown> {
  return app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { wipe(): Promise<unknown> } }).__bulwarkAppLock.wipe());
}

/** Everything of the restart for real but the new process, which nothing here could reach. */
function noteRelaunch(app: ElectronApplication, marker: string): Promise<void> {
  return app.evaluate(({ app: electronApp }, file) => {
    electronApp.relaunch = (() => {
      process.getBuiltinModule('node:fs').writeFileSync(file, 'relaunched');
    }) as typeof electronApp.relaunch;
  }, marker);
}

test.describe('a window with nobody left in it', () => {
  test.setTimeout(120_000);
  let profile = '';
  let app: ElectronApplication;
  let page: Page;
  // Asked of the app after it has closed, this throws.
  let running: ChildProcess;

  const launchIt = async () => {
    ({ app, page } = await launchStandalone(profile));
    running = app.process();
    await waitForLogin(page);
  };

  test.beforeEach(async () => {
    profile = tempProfile('wipe');
    await launchIt();
  });

  test.afterEach(async () => {
    if (running.exitCode === null) await closesWithin(app, 10_000);
    if (running.exitCode === null) running.kill();
    removeProfile(profile);
  });

  const onFlush = () => page.evaluate(() => {
    (window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (h: () => Promise<unknown>) => void } } }).bulwarkDesktop.lifecycle.onFlushRequest(async () => ({}));
  });

  test('a quit finishes when the page that said it saves has gone to a blank one', async () => {
    await onFlush();
    await app.evaluate(async ({ BrowserWindow }) => { await BrowserWindow.getAllWindows()[0].webContents.loadURL('about:blank'); });
    expect(await closesWithin(app)).toBe(true);
  });

  test('closing such a window asks nobody and goes', async () => {
    await onFlush();
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      await window.webContents.loadURL('about:blank');
      window.close();
    });
    // Gone, or in the tray by the user's setting. Nothing asks, so a modal would stop this read.
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length), { timeout: CLOSE_LIMIT_MS }).toBe(0);
  });

  test('a page that dies with a save pending doesn\'t hold up a quit', async () => {
    await page.evaluate(() => {
      (window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (h: () => Promise<unknown>) => void } } }).bulwarkDesktop.lifecycle.onFlushRequest(() => new Promise(() => {}));
    });
    // Asked and not answering, and then there's nobody to answer.
    const gone = exits(app);
    await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      electronApp.quit();
      setTimeout(() => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(), 300);
    });
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, CLOSE_LIMIT_MS))]);
    expect(running.exitCode, 'the quit went through').not.toBeNull();
  });

  test('a page asking "leave this site?" stops neither a wipe nor its restart', async () => {
    const marker = path.join(profile, 'relaunched');
    await noteRelaunch(app, marker);
    await page.locator('body').click();
    await page.evaluate(() => {
      window.addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = ''; });
    });
    const gone = exits(app);
    await wipeFromTest(app).catch(() => undefined);
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, CLOSE_LIMIT_MS))]);
    expect(running.exitCode, 'the app ended by itself').not.toBeNull();
    expect(existsSync(marker)).toBe(true);
  });

  test('a wipe ends in a real restart by itself, with no question, and the next start is clean', async () => {
    const marker = path.join(profile, 'relaunched');
    await noteRelaunch(app, marker);
    await page.evaluate(() => { localStorage.setItem('wipe-marker', 'x'); });
    await onFlush();
    const gone = exits(app);
    await wipeFromTest(app).catch(() => undefined);
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, CLOSE_LIMIT_MS))]);
    expect(running.exitCode, 'the app ended by itself').not.toBeNull();
    expect(existsSync(marker), 'and asked for a new start').toBe(true);

    await launchIt();
    expect(await page.evaluate(() => localStorage.getItem('wipe-marker'))).toBeNull();
  });
});
