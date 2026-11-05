// The page's own dialogs as windows of their own (src/main/dialog-surfaces.ts): the page
// opens an about:blank window named bulwark-dialog-…, draws its dialog into it and asks
// main to show it. Runs on the sign-in page; no account needed.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchStandalone, removeProfile, tempProfile, waitForLogin } from './helpers';

let profile = '';
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  profile = tempProfile('surf');
  ({ app, page } = await launchStandalone(profile));
  await waitForLogin(page);
});

test.afterAll(async () => {
  await app.close().catch(() => {});
  removeProfile(profile);
});

/** Opens a dialog window from the page (or from a dialog window, `from`) with a card in it. */
async function openSurface(name: string, from?: string): Promise<boolean> {
  return page.evaluate(async ({ name: n, from: f }) => {
    const w = window as unknown as { __surfaces?: Record<string, Window>; bulwarkDesktop: { dialogs: { showWindow(n: string): Promise<boolean> } } };
    w.__surfaces ??= {};
    const opener = f ? w.__surfaces[f] : window;
    const win = opener.open('', n);
    if (!win) return false;
    w.__surfaces[n] = win;
    win.document.body.innerHTML = `<div role="dialog" aria-label="${n}"><input id="field"><button id="ok">OK</button></div>`;
    return w.bulwarkDesktop.dialogs.showWindow(n);
  }, { name, from });
}

function windows() {
  return app.evaluate(({ BrowserWindow }) =>
    // A window going away mid-way is left out.
    BrowserWindow.getAllWindows().flatMap((w) => {
      try {
        if (w.isDestroyed()) return [];
        return [{
          id: w.id,
          url: w.webContents?.getURL() ?? '',
          visible: w.isVisible(),
          modal: w.isModal(),
          enabled: w.isEnabled(),
          parent: w.getParentWindow()?.id ?? null,
          resizable: w.isResizable(),
          bounds: w.getBounds(),
          content: w.getContentBounds(),
        }];
      } catch {
        return [];
      }
    }),
  );
}

const mainId = async () => (await windows()).find((w) => w.url.startsWith('https://app.bulwark.localhost'))!.id;

test('a dialog window is a modal, frameless child the size of the page behind, shown when the page says', async () => {
  const main = await mainId();
  expect(await openSurface('bulwark-dialog-one')).toBe(true);
  const all = await windows();
  const dialog = all.find((w) => w.parent === main)!;
  expect(dialog).toBeTruthy();
  expect(dialog.visible).toBe(true);
  if (process.platform !== 'darwin') expect(dialog.modal).toBe(true);
  expect(dialog.resizable).toBe(false);
  const behind = all.find((w) => w.id === main)!.content;
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(dialog.bounds[key] - behind[key])).toBeLessThanOrEqual(2);
  // The window behind can't be used meanwhile.
  expect(all.find((w) => w.id === main)!.enabled).toBe(false);

  // It stays on about:blank: the page writes into it, nothing loads there.
  await page.evaluate(() => {
    const w = (window as unknown as { __surfaces: Record<string, Window> }).__surfaces['bulwark-dialog-one'];
    w.location.href = `${location.origin}/settings`;
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect((await windows()).find((w) => w.id === dialog.id)!.url).toBe('about:blank');

  // A dialog opened from it hangs on it.
  expect(await openSurface('bulwark-dialog-two', 'bulwark-dialog-one')).toBe(true);
  const nested = (await windows()).find((w) => w.parent === dialog.id);
  expect(nested?.visible).toBe(true);

  await page.evaluate(() => {
    const s = (window as unknown as { __surfaces: Record<string, Window> }).__surfaces;
    s['bulwark-dialog-two'].close();
    s['bulwark-dialog-one'].close();
  });
  await expect.poll(async () => (await windows()).length).toBe(1);
  expect((await windows())[0].enabled).toBe(true);
});

test('only the page that opened it may show it; other names and plain pop-ups get no dialog window', async () => {
  const shows = await page.evaluate(async () => {
    const d = (window as unknown as { bulwarkDesktop: { dialogs: { showWindow(n: unknown): Promise<boolean> } } }).bulwarkDesktop.dialogs;
    return [await d.showWindow('bulwark-dialog-none'), await d.showWindow('not-a-dialog'), await d.showWindow(42)];
  });
  expect(shows).toEqual([false, false, false]);

  const main = await mainId();
  await page.evaluate(() => {
    (window as unknown as { __plain: Window | null }).__plain = window.open('', 'print-me');
  });
  await expect.poll(async () => (await windows()).length).toBe(2);
  const plain = (await windows()).find((w) => w.id !== main)!;
  expect(plain.parent).toBeNull();
  expect(plain.modal).toBe(false);
  await page.evaluate(() => (window as unknown as { __plain: Window }).__plain.close());
  await expect.poll(async () => (await windows()).length).toBe(1);
});

test('closing the window behind closes its dialog window', async () => {
  // A second window of the app's, so the app stays when it goes.
  await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { open(url: string, o: unknown): void } } }).bulwarkDesktop.windows.open('/settings', { name: 'surface-parent' }));
  await expect.poll(() => app.windows().filter((p) => !p.isClosed() && p !== page && p.url().startsWith('https://')).length, { timeout: 30_000 }).toBe(1);
  const second = app.windows().find((p) => !p.isClosed() && p !== page && p.url().startsWith('https://'))!;
  await waitForLogin(second);
  const shown = await second.evaluate(async () => {
    const win = window.open('', 'bulwark-dialog-three');
    win!.document.body.textContent = 'three';
    return (window as unknown as { bulwarkDesktop: { dialogs: { showWindow(n: string): Promise<boolean> } } }).bulwarkDesktop.dialogs.showWindow('bulwark-dialog-three');
  });
  expect(shown).toBe(true);
  const parent = (await windows()).find((w) => w.url === 'about:blank')!.parent!;
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.destroy(), parent);
  await expect.poll(async () => (await windows()).filter((w) => w.url === 'about:blank').length).toBe(0);
});
