// The shell's own questions as Bulwark windows (src/main/message-box.ts), and the room the
// dialog windows leave for the card's shadow. Runs on a throwaway profile and the sign-in
// page; no account. BULWARK_SCREENSHOTS keeps the pictures.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchStandalone, removeProfile, SCREENSHOTS, tempProfile, waitForLogin } from './helpers';

const DARK = { dark: true, background: '#0a0a0a', foreground: '#fafafa' };
const LIGHT = { dark: false, background: '#ffffff', foreground: '#0f172a' };

/** The dialog windows there are, as main sees them. */
function dialogWindows(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow, screen }) => BrowserWindow.getAllWindows().flatMap((w) => {
    try {
      if (w.isDestroyed() || !w.webContents?.getURL().startsWith('data:') || !w.isVisible()) return [];
      return [{ id: w.id, parent: w.getParentWindow()?.id ?? null, bounds: w.getContentBounds(), workArea: screen.getDisplayMatching(w.getBounds()).workArea }];
    } catch {
      return [];
    }
  }));
}

async function dialogPage(app: ElectronApplication, used: Set<Page>): Promise<Page> {
  await expect.poll(async () => (await dialogWindows(app)).length, { timeout: 20_000 }).toBe(1);
  const fresh = () => app.windows().find((p) => !used.has(p) && !p.isClosed() && p.url().startsWith('data:'));
  await expect.poll(() => Boolean(fresh()), { timeout: 15_000 }).toBe(true);
  const found = fresh()!;
  used.add(found);
  await found.waitForFunction(() => document.querySelector('#title')?.textContent);
  return found;
}

/** The card's distance to each edge of its window, in CSS pixels. */
function margins(dialog: Page) {
  return dialog.evaluate(() => {
    const card = document.getElementById('card')!.getBoundingClientRect();
    return { left: card.left, top: card.top, right: innerWidth - card.right, bottom: innerHeight - card.bottom, reach: parseFloat(document.body.style.padding) };
  });
}

/** The page behind and the dialog window over it, as one picture. */
async function picture(app: ElectronApplication, behind: Page, dialog: Page, name: string) {
  const [shown] = await dialogWindows(app);
  const parent = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id!)!.getContentBounds(), shown.parent);
  await dialog.waitForTimeout(400);
  const back = (await behind.screenshot()).toString('base64');
  const front = (await dialog.screenshot({ omitBackground: true })).toString('base64');
  // Put together in a canvas of the page behind: the dialog window where it stands over it.
  const png = await behind.evaluate(async ({ back: b, front: f, box, origin }) => {
    const load = (data: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = `data:image/png;base64,${data}`;
    });
    const [under, over] = await Promise.all([load(b), load(f)]);
    const scale = under.width / origin.width;
    const canvas = document.createElement('canvas');
    canvas.width = under.width;
    canvas.height = under.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(under, 0, 0);
    context.drawImage(over, (box.x - origin.x) * scale, (box.y - origin.y) * scale, box.width * scale, box.height * scale);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { back, front, box: shown.bounds, origin: parent });
  writeFileSync(path.join(SCREENSHOTS, `${name}.png`), Buffer.from(png, 'base64'));
}

const lockCall = (page: Page, method: string, seed?: number) => page.evaluate(async ({ method: name, seed: s }) => {
  type Member = Record<string, (...args: unknown[]) => Promise<unknown>>;
  const bridge = (window as unknown as { bulwarkDesktop: { appLock: Member } }).bulwarkDesktop.appLock;
  const held = window as unknown as { __controls?: Member; __forget?: Promise<unknown> };
  held.__controls ??= (bridge as unknown as { claim(): Member }).claim();
  if (name === 'forget') {
    held.__forget = bridge.forget();
    return null;
  }
  const target = name === 'lock' ? held.__controls : bridge;
  return target[name](...(s === undefined ? [] : [new Uint8Array(32).fill(s)]));
}, { method, seed });

async function launch(name: string) {
  const profile = tempProfile(name);
  const launched = await launchStandalone(profile);
  await waitForLogin(launched.page);
  return { ...launched, profile };
}

test('Forgot your PIN asks in a Bulwark window over the locked app, in its theme, and Cancel keeps the lock', async () => {
  test.setTimeout(240_000);
  process.env.BULWARK_TEST_OS_VERIFY = 'yes';
  const { app, page, profile } = await launch('prompt-lock');
  const used = new Set<Page>();
  try {
    await page.goto(new URL('/api/health', page.url()).href);
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { os: { setLocked(locked: boolean): void } } }).bulwarkDesktop.os.setLocked(false));
    await lockCall(page, 'enroll', 1);
    for (const [theme, colours] of [['light', LIGHT], ['dark', DARK]] as const) {
      await page.evaluate((c) => (window as unknown as { bulwarkDesktop: { theme: { set(t: unknown): void } } }).bulwarkDesktop.theme.set(c), colours);
      await lockCall(page, 'lock');
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { gate: { locked: boolean } } }).__bulwarkAppLock.gate.locked)).toBe(true);
      await lockCall(page, 'forget');
      const dialog = await dialogPage(app, used);
      await expect(dialog.locator('#title')).toHaveText('Remove local data and sign out?');
      await expect(dialog.locator('.badge')).toHaveCount(1);
      // The safe choice first and on Enter, the action at the end, red.
      await expect(dialog.locator('button.button')).toHaveText(['Cancel', 'Remove and sign out']);
      await expect(dialog.locator('button.button.destructive')).toHaveText('Remove and sign out');
      await expect(dialog.locator('button.button').first()).toBeFocused();
      expect(await dialog.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(theme === 'dark');
      const [shown] = await dialogWindows(app);
      expect(shown.parent).not.toBeNull();
      if (process.env.BULWARK_SCREENSHOTS) await picture(app, page, dialog, `shell-prompts-forgot-pin-${theme}`);
      await dialog.locator('button.button', { hasText: 'Cancel' }).click();
      expect(await page.evaluate(() => (window as unknown as { __forget: Promise<unknown> }).__forget)).toBe(false);
      // Still locked: the unlock goes on.
      expect(await app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { gate: { locked: boolean } } }).__bulwarkAppLock.gate.locked)).toBe(true);
      await lockCall(page, 'prove', 1);
    }
  } finally {
    delete process.env.BULWARK_TEST_OS_VERIFY;
    await app.close().catch(() => {});
    removeProfile(profile);
  }
});

test('the developer tools warning is a Bulwark window too, and Cancel leaves them off', async () => {
  test.setTimeout(240_000);
  const { app, page, profile } = await launch('prompt-dev');
  const used = new Set<Page>();
  try {
    for (const [theme, colours] of [['light', LIGHT], ['dark', DARK]] as const) {
      await page.evaluate((c) => (window as unknown as { bulwarkDesktop: { theme: { set(t: unknown): void } } }).bulwarkDesktop.theme.set(c), colours);
      await page.mouse.click(200, 400);
      await page.evaluate(() => {
        (window as unknown as { __dev: Promise<unknown> }).__dev = (window as unknown as { bulwarkDesktop: { devTools: { set(on: boolean): Promise<unknown> } } }).bulwarkDesktop.devTools.set(true);
      });
      const dialog = await dialogPage(app, used);
      await expect(dialog.locator('#title')).toHaveText('Turn on developer tools?');
      await expect(dialog.locator('#message')).toContainText('passwords');
      if (process.env.BULWARK_SCREENSHOTS) await picture(app, page, dialog, `shell-prompts-dev-tools-${theme}`);
      await dialog.locator('button.button', { hasText: 'Cancel' }).click();
      expect(await page.evaluate(() => (window as unknown as { __dev: Promise<{ on: boolean }> }).__dev)).toMatchObject({ on: false });
    }
  } finally {
    await app.close().catch(() => {});
    removeProfile(profile);
  }
});

test('every dialog window leaves the card\'s whole shadow room, at any zoom and by a screen edge', async () => {
  test.setTimeout(240_000);
  const { app, page, profile } = await launch('prompt-shadow');
  const used = new Set<Page>();
  const ask = (theme: string) => page.evaluate((t) => {
    void (window as unknown as { bulwarkDesktop: { dialogs: { show(r: unknown): Promise<unknown> } } }).bulwarkDesktop.dialogs.show({
      id: `shadow-${t}-${Math.random()}`,
      title: 'Delete this message forever?',
      message: [{ text: 'You can\'t undo this.' }],
      icon: 'warning',
      buttons: [{ label: 'Cancel', variant: 'secondary' }, { label: 'Delete forever', variant: 'destructive' }],
      defaultIndex: 0,
      theme: t === 'dark' ? { dark: true, colours: { background: '#0a0a0a', foreground: '#fafafa' } } : { dark: false },
    });
  }, theme);
  const main = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())!.id);
  try {
    for (const zoom of [1, 1.25, 1.5]) {
      await app.evaluate(({ BrowserWindow }, [id, z]) => BrowserWindow.fromId(id)!.webContents.setZoomFactor(z), [main, zoom] as const);
      await ask('light');
      const dialog = await dialogPage(app, used);
      const m = await margins(dialog);
      // The shadow reaches 40 px below the card (20 offset + 25 blur - 5 spread); at least 32 on every side.
      expect(m.reach).toBeGreaterThanOrEqual(40);
      for (const side of ['left', 'top', 'right', 'bottom'] as const) expect(m[side], `${side} at ${zoom}`).toBeGreaterThanOrEqual(Math.max(32, m.reach * zoom * 0.95));
      await dialog.keyboard.press('Escape').catch(() => {});
      await expect.poll(async () => (await dialogWindows(app)).length).toBe(0);
    }
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.webContents.setZoomFactor(1), main);

    // A click beside the card answers nothing, as a click on the page's backdrop does.
    await ask('light');
    let dialog = await dialogPage(app, used);
    await dialog.mouse.click(5, 5);
    await expect.poll(async () => (await dialogWindows(app)).length).toBe(0);

    // By a screen edge: the margin may go, the card stays on the screen.
    const area = await app.evaluate(({ BrowserWindow, screen }, id) => {
      const w = BrowserWindow.fromId(id)!;
      const work = screen.getDisplayMatching(w.getBounds()).workArea;
      w.setBounds({ x: work.x + work.width - 500, y: work.y + work.height - 300, width: 900, height: 700 });
      return work;
    }, main);
    await ask('light');
    dialog = await dialogPage(app, used);
    const [edge] = await dialogWindows(app);
    const m = await margins(dialog);
    expect(edge.bounds.x + m.left).toBeGreaterThanOrEqual(area.x);
    expect(edge.bounds.y + m.top).toBeGreaterThanOrEqual(area.y);
    expect(edge.bounds.x + edge.bounds.width - m.right).toBeLessThanOrEqual(area.x + area.width);
    expect(edge.bounds.y + edge.bounds.height - m.bottom).toBeLessThanOrEqual(area.y + area.height);
    await dialog.keyboard.press('Escape').catch(() => {});
    await expect.poll(async () => (await dialogWindows(app)).length).toBe(0);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.setBounds({ x: 40, y: 40, width: 1100, height: 760 }), main);

    for (const theme of ['light', 'dark']) {
      await ask(theme);
      dialog = await dialogPage(app, used);
      if (process.env.BULWARK_SCREENSHOTS) await picture(app, page, dialog, `dialog-shadow-${theme}`);
      await dialog.keyboard.press('Escape').catch(() => {});
      await expect.poll(async () => (await dialogWindows(app)).length).toBe(0);
    }
  } finally {
    await app.close().catch(() => {});
    removeProfile(profile);
  }
});
