import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT, ENT_PASSWORD, expectMailShown, fillLogin, launchStandalone, removeProfile, requireAccount, STALWARTS, tempProfile } from './helpers';
import { clickMenuItem, destroyMessages, pageWith, seedMessage } from './native-helpers';

/**
 * No title bar: the app's columns run to the top, and the window's controls sit in the
 * top row of whatever is at the right. On every page, nothing to click may lie under
 * those controls, and the row has to be what the window is dragged by.
 *   BULWARK_TEST_WEBMAIL=<dir> vw exec --env IT_ENT_PASSWORD=... -- npx playwright test test/native-chrome.spec.ts
 */
const SERVER = (STALWARTS.find((s) => s.label === (process.env.BULWARK_TEST_SERVER_LABEL ?? '1.0')) ?? STALWARTS[0]).url;
const TAG = `dc${Date.now().toString(36)}`;

interface Chrome {
  inset: string;
  rootTop: number;
  rootPadding: string;
  titleStrip: number;
  controls: { left: number; height: number; width: number };
  clashes: string[];
  rightRows: { padding: number; region: string | undefined }[];
  dragButtons: string[];
  railRegion: string | undefined;
}

const region = (el: Element) => {
  const style = getComputedStyle(el) as CSSStyleDeclaration & { appRegion?: string; webkitAppRegion?: string };
  return style.appRegion || style.webkitAppRegion;
};

/** What the page looks like to the window's controls. */
function readChrome(page: Page): Promise<Chrome> {
  return page.evaluate(({ regionSource }) => {
    const regionOf = new Function(`return (${regionSource})`)() as (el: Element) => string | undefined;
    const overlay = (navigator as unknown as { windowControlsOverlay: { visible: boolean; getTitlebarAreaRect(): { x: number; width: number; height: number } } }).windowControlsOverlay;
    const area = overlay.getTitlebarAreaRect();
    const left = area.x + area.width;
    const describe = (el: Element) => `${el.tagName.toLowerCase()}[${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}]`;
    const clashes: string[] = [];
    const clickable = 'a[href], button, input, select, textarea, summary, [contenteditable="true"], [role="button"], [role="tab"], [role="menuitem"], [role="combobox"], [role="searchbox"], [role="switch"]';
    for (const el of Array.from(document.querySelectorAll(clickable))) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const overlapLeft = Math.max(box.left, left);
      const overlapRight = Math.min(box.right, innerWidth);
      const overlapBottom = Math.min(box.bottom, area.height);
      const overlapTop = Math.max(box.top, 0);
      if (overlapRight <= overlapLeft || overlapBottom <= overlapTop) continue;
      // Scrolled away or under something else isn't on screen, and so can't clash.
      const seen = document.elementFromPoint((overlapLeft + overlapRight) / 2, (overlapTop + overlapBottom) / 2);
      if (seen && (el === seen || el.contains(seen))) clashes.push(describe(el));
    }
    const root = document.querySelector('[class*="--app-top-inset"]');
    const rows = Array.from(document.querySelectorAll('[data-window-row-right]'));
    const rail = document.querySelector('[data-window-rail]');
    return {
      inset: getComputedStyle(document.documentElement).getPropertyValue('--titlebar-inset').trim(),
      rootTop: root ? root.getBoundingClientRect().top : 0,
      rootPadding: root ? getComputedStyle(root).paddingTop : '0px',
      titleStrip: document.querySelectorAll('[data-window-title-bar]').length,
      controls: { left, height: area.height, width: innerWidth - left },
      clashes,
      // A skeleton's row has its room from the first frame, and its drag from the band under it.
      rightRows: rows.map((row) => ({ padding: parseFloat(getComputedStyle(row).paddingRight), region: row.hasAttribute('data-window-row') ? regionOf(row) : 'drag' })),
      dragButtons: Array.from(document.querySelectorAll('[data-window-row] button, [data-window-row] input, [data-window-rail] button, [data-window-rail] a[href], [data-window-rail] input'))
        .filter((el) => regionOf(el) !== 'no-drag')
        .map(describe),
      railRegion: rail ? regionOf(rail) : undefined,
    };
  }, { regionSource: region.toString() });
}

async function expectClean(page: Page): Promise<Chrome> {
  await page.locator('[data-window-row-right]').first().waitFor({ state: 'attached', timeout: 30_000 });
  // The marks follow the page before it paints, but the page may still be filling in.
  await page.waitForTimeout(800);
  const chrome = await readChrome(page);
  expect(chrome.inset).toBe('0px');
  expect(chrome.rootPadding).toBe('0px');
  expect(chrome.rootTop).toBe(0);
  expect(chrome.titleStrip).toBe(0);
  expect(chrome.controls.width).toBeGreaterThan(0);
  expect(chrome.clashes).toEqual([]);
  expect(chrome.rightRows.length).toBeGreaterThan(0);
  for (const row of chrome.rightRows) {
    expect(row.padding).toBeGreaterThanOrEqual(chrome.controls.width);
    expect(row.region).toBe('drag');
  }
  expect(chrome.dragButtons).toEqual([]);
  return chrome;
}

test.beforeAll(requireAccount);

test.describe('the app under the window controls', () => {
  test.skip(process.platform === 'darwin', 'the traffic lights are at the left');

  let profile = '';
  let app: ElectronApplication;
  let page: Page;
  let id = '';
  let loginClashes: string[] = [];

  const setSize = (width: number, height: number) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('/popout/'))!;
    window.setMinimumSize(320, 300);
    window.setContentSize(w, h);
  }, [width, height] as const);
  const visit = async (path: string) => {
    await page.goto(new URL(path, page.url()).toString());
    await page.waitForLoadState('domcontentloaded');
  };

  test.beforeAll(async () => {
    id = await seedMessage(SERVER, ACCOUNT, ENT_PASSWORD, `${TAG} chrome`, 'A body.');
    profile = tempProfile('chrome');
    ({ app, page } = await launchStandalone(profile));
    // The login has no row at all: nothing of it lies under the controls.
    await page.locator('#username').waitFor({ timeout: 90_000 });
    loginClashes = (await readChrome(page)).clashes;
    await fillLogin(page, SERVER, ACCOUNT, ENT_PASSWORD);
    await page.keyboard.press('Enter');
    await expectMailShown(page);
  });

  test.afterAll(async () => {
    await app.close().catch(() => {});
    removeProfile(profile);
    await destroyMessages(SERVER, ACCOUNT, ENT_PASSWORD, [id]).catch(() => {});
  });

  test('the login: its theme button sits beside the controls', () => {
    expect(loginClashes).toEqual([]);
  });

  for (const [width, height] of [[1240, 780], [1000, 700], [640, 700]] as const) {
    for (const path of ['/calendar', '/contacts', '/files', '/settings', '/']) {
      test(`${path} at ${width}: nothing to click under the controls`, async () => {
        await setSize(width, height);
        await visit(path);
        await expectClean(page);
      });
    }

    test(`a message open at ${width}: the reader's toolbar makes room`, async () => {
      await setSize(width, height);
      await visit('/');
      await expect(page.locator(`[data-email-id="${id}"]`).first()).toBeAttached({ timeout: 60_000 });
      await page.locator(`[data-email-id="${id}"]`).first().click();
      await expect(page.getByRole('main').or(page.locator('body')).first()).toContainText('A body.', { timeout: 30_000 });
      const chrome = await expectClean(page);
      expect(chrome.railRegion === undefined || chrome.railRegion === 'drag').toBe(true);
    });
  }

  test('a contact\'s form and page keep their buttons clear', async () => {
    await setSize(1240, 780);
    await visit('/contacts');
    await page.getByRole('button', { name: 'New contact' }).first().click();
    await page.locator('input').first().waitFor();
    await expectClean(page);
  });

  test('list only: with no reader, the list\'s header takes them', async () => {
    await setSize(1240, 780);
    await visit('/');
    await expectMailShown(page);
    await clickMenuItem(app, 'view.layout.focus');
    await page.waitForTimeout(800);
    await expectClean(page);
    await clickMenuItem(app, 'view.layout.split');
    await page.waitForTimeout(500);
  });

  test('a composer filling a narrow window keeps its buttons clear', async () => {
    await setSize(640, 700);
    await visit('/');
    await expectMailShown(page);
    await page.keyboard.press('c');
    await page.locator('[data-composer-header]').first().waitFor({ timeout: 30_000 });
    await expectClean(page);
    await page.keyboard.press('Escape');
    await setSize(1240, 780);
  });

  test('the skeletons say so before any script: the server\'s page already has the room', async () => {
    for (const path of ['/calendar', '/files', '/settings', '/']) {
      const html = await page.evaluate((url) => fetch(url).then((response) => response.text()), path);
      expect(html, path).toContain('data-window-row-right');
    }
    const settings = await page.evaluate(() => fetch('/settings').then((response) => response.text()));
    expect(settings).toContain('data-window-only');
  });

  test('the admin shell has a row for them, with the page\'s name', async () => {
    await setSize(1240, 780);
    await page.route('**/api/admin/auth', (route) => route.fulfill({ json: { enabled: true, authenticated: true } }));
    await visit('/admin');
    await expect(page.locator('main [data-window-only]')).toBeVisible({ timeout: 30_000 });
    await expectClean(page);
    await page.unroute('**/api/admin/auth');
  });

  test('the settings page\'s row is only there for them', async () => {
    await setSize(1240, 780);
    await visit('/settings');
    await expect(page.locator('[data-window-only]').first()).toBeVisible({ timeout: 30_000 });
    const height = await page.locator('[data-window-only]').first().evaluate((el) => el.getBoundingClientRect().height);
    // Lines up with the sidebar's row.
    expect(height).toBeGreaterThanOrEqual(56);
    expect(await page.evaluate(() => getComputedStyle(document.body, '::before').getPropertyValue('content'))).not.toBe('none');
  });

  test('the Pro shell\'s tab strip holds them', async () => {
    await setSize(1240, 780);
    await page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('settings-storage') ?? '{"state":{}}');
      stored.state.proInterface = true;
      localStorage.setItem('settings-storage', JSON.stringify(stored));
    });
    await visit('/pro');
    await expect(page.locator('[data-pane-strip]').first()).toBeVisible({ timeout: 30_000 });
    const chrome = await expectClean(page);
    const strip = await page.locator('[data-pane-strip]').first().boundingBox();
    expect(strip).toMatchObject({ y: 0, height: chrome.controls.height });
    await page.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('settings-storage') ?? '{"state":{}}');
      stored.state.proInterface = false;
      localStorage.setItem('settings-storage', JSON.stringify(stored));
    });
  });

  test('zoomed in, the controls and the room they get still match', async () => {
    await setSize(1240, 780);
    await visit('/');
    await clickMenuItem(app, 'view.zoomIn');
    await clickMenuItem(app, 'view.zoomIn');
    await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBeGreaterThan(1);
    const chrome = await expectClean(page);
    // The buttons grow with the page, so the row they sit in still lines up.
    expect(Math.abs(chrome.controls.height - 56)).toBeLessThanOrEqual(1);
    await clickMenuItem(app, 'view.zoomReset');
  });

  test('a message window and a composer window keep clear too', async () => {
    await setSize(1240, 780);
    await visit('/');
    // This account is a busy one, so a message of its own.
    const own = await seedMessage(SERVER, ACCOUNT, ENT_PASSWORD, `${TAG} window`, 'A body.');
    await page.evaluate(
      (emailId) => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: `/popout/message/${emailId}`, emailId }),
      own,
    );
    const message = await pageWith(app, '/popout/message/');
    await expect(message.locator('body')).toContainText('A body.', { timeout: 60_000 });
    await expectClean(message);
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { openComposer: (t: object) => void } } }).bulwarkDesktop.windows.openComposer({ url: '/popout/compose', name: 'chrome' }));
    const composer = await pageWith(app, '/popout/compose');
    await composer.locator('[data-composer-header]').waitFor({ timeout: 60_000 });
    await expectClean(composer);
    // The window's own close button is the one: no second cross right beside it.
    await expect(composer.getByTestId('composer-close')).toBeHidden();
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.webContents.getURL().includes('/popout/')) window.destroy();
      }
    });
    await destroyMessages(SERVER, ACCOUNT, ENT_PASSWORD, [own]).catch(() => {});
  });
});
