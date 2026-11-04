import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT, ENT_PASSWORD, expectMailShown, fillLogin, launchStandalone, removeProfile, requireAccount, SCREENSHOTS, STALWARTS, tempProfile } from './helpers';
import { clickMenuItem, destroyMessages, jmap, mailboxIdOf, pageWith, seedMessage } from './native-helpers';

/**
 * The app's own buttons and the window's: never on top of each other, and never two
 * crosses side by side. A pop-out closes with the window's own button; a pane in the
 * main window closes with one at the start of its row, away from the window's.
 *   BULWARK_TEST_WEBMAIL=<dir> vw exec --env IT_ENT_PASSWORD=... -- npx playwright test test/window-buttons.spec.ts
 * BULWARK_SCREENSHOTS keeps a picture of each state, with the controls' place outlined.
 */
const SERVER = (STALWARTS.find((s) => s.label === (process.env.BULWARK_TEST_SERVER_LABEL ?? '1.0')) ?? STALWARTS[0]).url;
const TAG = `wb${Date.now().toString(36)}`;
const SHOT_PREFIX = process.env.BULWARK_SHOT_PREFIX ?? 'menus-winctl';

interface Seen {
  /** Clickable things the window's controls lie on. */
  under: string[];
  /** Close buttons of the app in the top row, near the window's own. */
  closeBeside: string[];
  /** In a pop-out: the app's own close and pop-out buttons that show. */
  extraButtons: string[];
  /** Text the controls cover, which can't be read there. */
  textUnder: string[];
  controlsWidth: number;
}

function read(page: Page): Promise<Seen> {
  return page.evaluate(() => {
    const overlay = (navigator as unknown as { windowControlsOverlay: { getTitlebarAreaRect(): { x: number; width: number; height: number } } }).windowControlsOverlay;
    const area = overlay.getTitlebarAreaRect();
    const controlsLeft = area.x + area.width;
    const labelOf = (el: Element) => (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent ?? '').trim();
    const describe = (el: Element) => `${el.tagName.toLowerCase()}[${labelOf(el).slice(0, 40)}]${el.closest('[data-toast-container]') ? ' in a toast' : ''}`;
    const visible = (el: Element) => {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const seen = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !!seen && (el === seen || el.contains(seen));
    };
    const clickable = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"]'));
    const under: string[] = [];
    const closeBeside: string[] = [];
    const extraButtons: string[] = [];
    for (const el of clickable) {
      if (!visible(el)) continue;
      const box = el.getBoundingClientRect();
      const inBand = box.top < area.height;
      if (inBand && box.right > controlsLeft && box.left < innerWidth) under.push(describe(el));
      const label = labelOf(el);
      const isClose = /^close\b/i.test(label) || el.getAttribute('data-testid') === 'composer-close';
      // Within two buttons' width of the window's own: read as the same row of window buttons.
      if (inBand && isClose && box.right > controlsLeft - 100) closeBeside.push(describe(el));
      if (/\/popout\//.test(location.pathname) && inBand && (isClose || /open in (a )?new window|pop out/i.test(label))) extraButtons.push(describe(el));
    }
    const textUnder: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const hit = Array.from(range.getClientRects()).find((r) => r.width > 0 && r.top < area.height && r.right > controlsLeft + 1 && r.left < innerWidth);
      if (!hit) continue;
      const seen = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(hit.left, controlsLeft) + 1), hit.top + hit.height / 2);
      if (seen && node.parentElement && (seen === node.parentElement || node.parentElement.contains(seen) || seen.contains(node.parentElement))) textUnder.push(node.textContent.trim().slice(0, 40));
    }
    return { under, closeBeside, extraButtons, textUnder, controlsWidth: innerWidth - controlsLeft };
  });
}

/** A picture of the page with the window's controls outlined where they lie. */
async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.BULWARK_SCREENSHOTS) return;
  await page.evaluate(() => {
    const overlay = (navigator as unknown as { windowControlsOverlay: { getTitlebarAreaRect(): { x: number; width: number; height: number } } }).windowControlsOverlay;
    const area = overlay.getTitlebarAreaRect();
    const box = document.createElement('div');
    box.id = '__controls-outline';
    Object.assign(box.style, {
      position: 'fixed', top: '0', left: `${area.x + area.width}px`, width: `${innerWidth - area.x - area.width}px`, height: `${area.height}px`,
      outline: '2px dashed #e11d48', outlineOffset: '-2px', background: 'rgba(225,29,72,0.08)', zIndex: '2147483647', pointerEvents: 'none',
      font: '11px system-ui', color: '#e11d48', display: 'grid', placeItems: 'center',
    });
    box.textContent = '—   □   ✕';
    document.body.append(box);
  });
  await page.screenshot({ path: path.join(SCREENSHOTS, `${SHOT_PREFIX}-${name}.png`) });
  await page.evaluate(() => document.getElementById('__controls-outline')?.remove());
}

async function expectClear(page: Page, name: string, popout = false): Promise<void> {
  await page.waitForTimeout(800);
  await shot(page, name);
  const seen = await read(page);
  expect(seen.controlsWidth, name).toBeGreaterThan(0);
  expect(seen.under, `${name}: under the window's controls`).toEqual([]);
  expect(seen.textUnder, `${name}: text under the window's controls`).toEqual([]);
  expect(seen.closeBeside, `${name}: a close button right beside the window's`).toEqual([]);
  if (popout) expect(seen.extraButtons, `${name}: a pop-out window closes with its own button`).toEqual([]);
}

test.beforeAll(requireAccount);

test.describe('the app\'s buttons and the window\'s', () => {
  test.skip(process.platform === 'darwin', 'the traffic lights are at the left');

  let profile = '';
  let app: ElectronApplication;
  let page: Page;
  let id = '';

  const setSize = (width: number, height: number) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('/popout/'))!;
    window.setMinimumSize(320, 300);
    window.setContentSize(w, h);
  }, [width, height] as const);

  const setStored = (key: string, patch: Record<string, unknown>) => page.evaluate(([storageKey, values]) => {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{"state":{}}');
    Object.assign(stored.state, values);
    localStorage.setItem(storageKey, JSON.stringify(stored));
  }, [key, patch] as const);

  const openMessage = async () => {
    await page.goto(new URL('/', page.url()).toString());
    await expectMailShown(page);
    const row = page.locator(`[data-email-id="${id}"]`).first();
    await expect(row).toBeAttached({ timeout: 60_000 });
    await row.click();
    await expect(page.locator('body')).toContainText('Window buttons body.', { timeout: 30_000 });
  };

  const openComposer = async () => {
    await page.goto(new URL('/', page.url()).toString());
    await expectMailShown(page);
    await page.keyboard.press('c');
    await page.locator('[data-composer-header], [data-mv-compose-titlebar], [data-mv-compose-inline-bar]').first().waitFor({ timeout: 30_000 });
  };

  test.beforeAll(async () => {
    id = await seedMessage(SERVER, ACCOUNT, ENT_PASSWORD, `${TAG} window buttons`, 'Window buttons body.');
    profile = tempProfile('winbtn');
    ({ app, page } = await launchStandalone(profile));
    await fillLogin(page, SERVER, ACCOUNT, ENT_PASSWORD);
    await page.keyboard.press('Enter');
    await expectMailShown(page);
    await setStored('theme-storage', { theme: 'light', themeChosen: true });
  });

  test.afterAll(async () => {
    await app.close().catch(() => {});
    removeProfile(profile);
    await destroyMessages(SERVER, ACCOUNT, ENT_PASSWORD, [id]).catch(() => {});
  });

  for (const [width, height] of [[1920, 1000], [1366, 768], [1000, 700], [800, 600], [640, 560]] as const) {
    test(`standard at ${width}: a message open`, async () => {
      await setSize(width, height);
      await openMessage();
      await expectClear(page, `standard-reader-${width}`);
    });

    test(`standard at ${width}: a new message in the main window`, async () => {
      await setSize(width, height);
      await openComposer();
      await expectClear(page, `standard-composer-${width}`);
      await page.keyboard.press('Escape');
    });
  }

  test('maximised: a message and a new message', async () => {
    await setSize(1366, 768);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('/popout/'))!.maximize();
    });
    try {
      await openMessage();
      await expectClear(page, 'maximised-reader');
      await openComposer();
      await expectClear(page, 'maximised-composer');
      await page.keyboard.press('Escape');
    } finally {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('/popout/'))!.unmaximize();
      });
    }
  });

  // The steps above load the page after each size, which hides a room worked out against the
  // window's old width. Here the page stays, as it does for a person: one message open, and the
  // window maximised, restored, snapped and resized under it.
  test('one page through maximise, restore, snap and resize: the room for the controls follows', async () => {
    let step = '';
    const main = () => app.evaluate(({ BrowserWindow, screen }, step) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('/popout/'))!;
      const area = screen.getDisplayMatching(window.getBounds()).workArea;
      if (step === 'maximise') window.maximize();
      else if (step === 'restore') window.unmaximize();
      else if (step === 'snap') window.setBounds({ x: area.x, y: area.y, width: Math.floor(area.width / 2), height: area.height });
      else {
        const [w, h] = step.split('x').map(Number);
        window.setMinimumSize(320, 300);
        window.setContentSize(w, h);
      }
    }, step);
    const inset = () => page.evaluate(() => {
      const overlay = (navigator as unknown as { windowControlsOverlay: { getTitlebarAreaRect(): { x: number; width: number } } }).windowControlsOverlay;
      const area = overlay.getTitlebarAreaRect();
      const set = parseFloat(document.documentElement.style.getPropertyValue('--titlebar-right-inset'));
      return { set, real: innerWidth - area.x - area.width };
    });
    await setSize(1366, 768);
    await openMessage();
    const steps = ['maximise', 'restore', 'snap', '640x560', '1920x1000', '800x600'];
    for (step of steps) {
      await main();
      await expect.poll(async () => { const { set, real } = await inset(); return Math.abs(set - real); }, { message: `${step}: the room left for the controls` }).toBeLessThan(1);
      await expectClear(page, `resized-${step}`);
    }
    // Offline at 800 px after all that: the bar is one row, not a column of letters.
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    const bar = page.getByTestId('offline-banner');
    try {
      await expect(bar).toBeVisible({ timeout: 30_000 });
      for (step of ['1366x768', '640x560']) {
        await main();
        await expect.poll(async () => (await bar.boundingBox())?.height ?? 999, { message: `${step}: the offline bar's height` }).toBeLessThan(120);
        await expectClear(page, `resized-offline-${step}`);
      }
    } finally {
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await setSize(1366, 768);
    }
  });

  test('reading pane below and off: the list\'s header', async () => {
    await setSize(1366, 768);
    for (const layout of ['horizontal', 'focus'] as const) {
      await clickMenuItem(app, `view.layout.${layout}`);
      await openMessage();
      await expectClear(page, `standard-reader-${layout}`);
    }
    await clickMenuItem(app, 'view.layout.split');
  });

  for (const steps of [1, 2]) {
    test(`zoomed in ${steps}: a message and a new message`, async () => {
      await setSize(1366, 768);
      for (let n = 0; n < steps; n += 1) await clickMenuItem(app, 'view.zoomIn');
      await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBeGreaterThan(1);
      try {
        await openMessage();
        await expectClear(page, `zoom${steps}-reader`);
        await openComposer();
        await expectClear(page, `zoom${steps}-composer`);
        await page.keyboard.press('Escape');
      } finally {
        await clickMenuItem(app, 'view.zoomReset');
      }
    });
  }

  test('Mountain View: a message and a new message', async () => {
    await setSize(1366, 768);
    await setStored('settings-storage', { interfaceLayout: 'mountain-view' });
    // Its inbox lists unread mail in a section of its own, first: the earlier tests read this one.
    await jmap(SERVER, ACCOUNT, ENT_PASSWORD, [['Email/set', { update: { [id]: { 'keywords/$seen': null } } }, 'u']]);
    try {
      await openMessage();
      await expectClear(page, 'mountain-view-reader');
      await openComposer();
      await expectClear(page, 'mountain-view-composer');
      await page.keyboard.press('Escape');
    } finally {
      await setStored('settings-storage', { interfaceLayout: 'default' });
    }
  });

  test('Pro: a message open', async () => {
    await setSize(1366, 768);
    await setStored('settings-storage', { proInterface: true });
    try {
      await page.goto(new URL('/pro', page.url()).toString());
      await expect(page.locator('[data-pane-strip]').first()).toBeVisible({ timeout: 30_000 });
      await expectClear(page, 'pro');
    } finally {
      await setStored('settings-storage', { proInterface: false });
    }
  });

  test('a message window and a composer window: the window\'s close only', async () => {
    await setSize(1366, 768);
    await page.goto(new URL('/', page.url()).toString());
    await expectMailShown(page);
    await page.evaluate(
      (emailId) => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: `/popout/message/${emailId}`, emailId }),
      id,
    );
    const message = await pageWith(app, '/popout/message/');
    await expect(message.locator('body')).toContainText('Window buttons body.', { timeout: 60_000 });
    await expectClear(message, 'popout-message', true);
    // Moved from elsewhere: a line about it above the toolbar, which then starts lower.
    const archive = await mailboxIdOf(SERVER, ACCOUNT, ENT_PASSWORD, 'archive');
    await jmap(SERVER, ACCOUNT, ENT_PASSWORD, [['Email/set', { update: { [id]: { mailboxIds: { [archive]: true } } } }, 'u']]);
    await message.locator('[data-popout-moved]').waitFor({ timeout: 90_000 });
    await expectClear(message, 'popout-message-moved', true);
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { openComposer: (t: object) => void } } }).bulwarkDesktop.windows.openComposer({ url: '/popout/compose', name: 'winbtn' }));
    const composer = await pageWith(app, '/popout/compose');
    await composer.locator('[data-composer-header]').waitFor({ timeout: 60_000 });
    await expectClear(composer, 'popout-composer', true);
    // Quick compose: the same kind of window, opened from anywhere.
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.webContents.getURL().includes('/popout/compose')) window.destroy();
      }
    });
    await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { quickCompose: { open: () => void } } }).__bulwarkOs.quickCompose.open());
    const quick = await pageWith(app, '/popout/compose');
    await quick.locator('[data-composer-header]').waitFor({ timeout: 60_000 });
    await expectClear(quick, 'quick-compose', true);
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.webContents.getURL().includes('/popout/')) window.destroy();
      }
    });
  });

  // Last: a page that went offline here leaves the local copy thinking so for a while.
  test('800 px with the offline bar and the notices: nothing under the controls, and a way to close each', async () => {
    // The pop-out case moved it to the Archive.
    const inbox = await mailboxIdOf(SERVER, ACCOUNT, ENT_PASSWORD, 'inbox');
    await jmap(SERVER, ACCOUNT, ENT_PASSWORD, [['Email/set', { update: { [id]: { mailboxIds: { [inbox]: true } } } }, 'u']]);
    await setSize(800, 600);
    await page.goto(new URL('/', page.url()).toString());
    await expectMailShown(page);
    // Each page load starts online again: the bar comes back with the event.
    const goOffline = () => page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await goOffline();
    const bar = page.getByTestId('offline-banner');
    await expect(bar).toBeVisible({ timeout: 30_000 });
    try {
      await expectClear(page, 'offline-800');
      // The bar has its own close, and it isn't the one beside the window's.
      await expect(bar.getByTestId('offline-banner-hide')).toBeVisible();
      // A notice either goes by itself (its countdown shows) or shows its close button.
      const stuck = await page.locator('[data-toast-container] .toast-item').evaluateAll((items) => items
        .filter((item) => !item.querySelector('[style*="toast-progress"]') && !item.querySelector('[data-toast-close]')?.classList.contains('opacity-100'))
        .map((item) => item.textContent?.trim().slice(0, 60)));
      expect(stuck, 'a notice that stays with no visible close').toEqual([]);
      await openComposer();
      await goOffline();
      await expect(bar).toBeVisible();
      await expectClear(page, 'offline-800-composer');
      await page.keyboard.press('Escape');
      for (let n = 0; n < 2; n += 1) await clickMenuItem(app, 'view.zoomIn');
      await openMessage();
      await goOffline();
      await expect(bar).toBeVisible();
      await expectClear(page, 'offline-800-zoom2-reader');
      await clickMenuItem(app, 'view.zoomReset');
      await bar.getByTestId('offline-banner-hide').click();
      await expect(bar).toBeHidden();
    } finally {
      await clickMenuItem(app, 'view.zoomReset');
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
    }
  });
});
