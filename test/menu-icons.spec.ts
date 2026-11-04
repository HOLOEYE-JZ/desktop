import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchStandalone, removeOsTraces, removeProfile, tempProfile, type Launched } from './helpers';

/**
 * The images in the shell's own menus and the thumbnail toolbar. A menu draws an item's
 * image at its size in DIP: one loaded straight from a 48 px .ico came out a hand tall.
 * Each must be 16 DIP, with the real pixels for 200 % beside it on Windows.
 */

const win = process.platform === 'win32';
/** A key nobody uses, so the quick compose shortcut is held while this runs. */
const KEY = 'CommandOrControl+Alt+Shift+F9';

interface Seen {
  label: string;
  width: number;
  height: number;
  scales: number[];
  /** Pixels across of the representation for 2x, and of the one nearest 1x. */
  px2: number;
  px1: number;
  template: boolean;
  /** How bright the glyph is: 255 white, near 0 black. */
  brightness: number;
  accelerator: string | null;
}

/** What each image in a template measures, read in main. Submenus too. */
const SEE = `(items) => {
  const out = [];
  const brightness = (image) => {
    const bitmap = image.toBitmap({ scaleFactor: 1 });
    let sum = 0;
    let weight = 0;
    for (let at = 0; at < bitmap.length; at += 4) {
      const alpha = bitmap[at + 3];
      if (alpha < 128) continue;
      // Premultiplied BGRA: back to the colour.
      sum += (Math.max(bitmap[at], bitmap[at + 1], bitmap[at + 2]) * 255) / alpha;
      weight += 1;
    }
    return weight ? Math.round(sum / weight) : -1;
  };
  const walk = (list) => {
    for (const item of list) {
      if (item.icon) {
        const { width, height } = item.icon.getSize();
        out.push({
          label: item.label ?? '',
          width,
          height,
          scales: item.icon.getScaleFactors(),
          px2: Math.round(Math.sqrt(item.icon.toBitmap({ scaleFactor: 2 }).length / 4)),
          px1: Math.round(Math.sqrt(item.icon.toBitmap({ scaleFactor: 1 }).length / 4)),
          template: item.icon.isTemplateImage(),
          brightness: brightness(item.icon),
          accelerator: item.accelerator ?? null,
        });
      } else if (item.accelerator) {
        out.push({ label: item.label ?? '', width: 0, height: 0, scales: [], px2: 0, px1: 0, template: false, brightness: -1, accelerator: item.accelerator });
      }
      if (Array.isArray(item.submenu)) walk(item.submenu);
    }
  };
  walk(items);
  return out;
}`;

interface Os {
  hub: { locked: boolean; quickComposeStatus?: { active: boolean }; setSummary: (summary: unknown) => void };
  tray: { template: () => unknown[] } | null;
  taskbar: { applyThumbar: (window: unknown) => boolean; dockTemplate: () => unknown[] };
}

const trayIcons = (app: ElectronApplication): Promise<Seen[]> =>
  app.evaluate((_electron, see) => (0, eval)(see)((globalThis as unknown as { __bulwarkOs: Os }).__bulwarkOs.tray!.template()), SEE);

const dockIcons = (app: ElectronApplication): Promise<Seen[]> =>
  app.evaluate((_electron, see) => (0, eval)(see)((globalThis as unknown as { __bulwarkOs: Os }).__bulwarkOs.taskbar.dockTemplate()), SEE);

/** The thumbnail buttons the app hands Windows, caught on the way. */
const thumbIcons = (app: ElectronApplication): Promise<{ seen: Seen[]; scaleFactor: number }> =>
  app.evaluate(({ BrowserWindow, screen }, see) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('/popout/'))!;
    let caught: Electron.ThumbarButton[] = [];
    const real = window.setThumbarButtons.bind(window);
    window.setThumbarButtons = (buttons) => {
      caught = buttons;
      return real(buttons);
    };
    (globalThis as unknown as { __bulwarkOs: Os }).__bulwarkOs.taskbar.applyThumbar(window);
    window.setThumbarButtons = real;
    return { seen: (0, eval)(see)(caught.map((button) => ({ label: button.tooltip, icon: button.icon }))), scaleFactor: screen.getDisplayMatching(window.getBounds()).scaleFactor };
  }, SEE);

/** Stands in for the Windows mode (taskbar) and the app mode, then says they changed. */
const setTheme = (app: ElectronApplication, theme: { taskbarDark: boolean; appsDark: boolean }) =>
  app.evaluate(({ nativeTheme }, { taskbarDark, appsDark }) => {
    Object.defineProperty(nativeTheme, 'shouldUseDarkColorsForSystemIntegratedUI', { configurable: true, get: () => taskbarDark });
    Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { configurable: true, get: () => appsDark });
    nativeTheme.emit('updated');
  }, theme);

/** Unread mail and an event in the tray, with the page's own empty summaries dropped. */
async function fillTray(app: ElectronApplication, page: Page): Promise<void> {
  await page.evaluate('window.bulwarkDesktop.os.setLocked(false)');
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: Os }).__bulwarkOs.hub.locked)).toBe(false);
  await app.evaluate(() => {
    const { hub } = (globalThis as unknown as { __bulwarkOs: Os }).__bulwarkOs;
    const real = hub.setSummary.bind(hub);
    hub.setSummary = (summary) => {
      const { unread, recent, nextEvent } = summary as { unread: unknown[]; recent: unknown[]; nextEvent: unknown };
      if (unread.length || recent.length || nextEvent) real(summary);
    };
    hub.setSummary({
      unread: [
        { emailId: 'e1', accountId: 'a', sender: 'Alice Becker', subject: 'Quarterly report, final numbers' },
        { emailId: 'e2', accountId: 'a', sender: 'Bob Weber', subject: 'Lunch on Friday?' },
      ],
      recent: [],
      nextEvent: { title: 'Project review', when: 'Thu 12:30' },
    });
  });
  await expect.poll(async () => (await trayIcons(app)).map((item) => item.label)).toContain('Next: Project review, Thu 12:30');
}

test.describe('menu images', () => {
  let profile = '';
  let running: Launched | null = null;

  test.beforeEach(() => {
    profile = tempProfile('menuicons');
  });

  test.afterEach(async () => {
    await running?.app.close().catch(() => {});
    running = null;
    removeProfile(profile);
    removeOsTraces();
  });

  test('the tray, the dock and the thumbnail toolbar get 16 DIP images, and the tray shows no shortcut', async () => {
    running = await launchStandalone(profile, `--bulwark-test-quick-compose-default=${KEY}`);
    const { app, page } = running;
    await fillTray(app, page);
    // The shortcut is held, so the old menu would have shown it beside New message.
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: Os }).__bulwarkOs.hub.quickComposeStatus?.active ?? false)).toBe(true);

    const tray = await trayIcons(app);
    expect(tray.filter((item) => item.accelerator), 'no shortcut text in the tray').toEqual([]);
    if (win) expect(tray.map((item) => item.label)).toEqual(['New message', 'Next: Project review, Thu 12:30']);
    for (const item of tray.filter((entry) => entry.width)) {
      expect({ label: item.label, width: item.width, height: item.height }).toEqual({ label: item.label, width: 16, height: 16 });
      if (win) {
        expect(item.scales, item.label).toContain(2);
        expect(item.px2, `${item.label} at 200 %`).toBe(32);
        expect(item.px1, `${item.label} at 100 %`).toBe(16);
      }
    }

    const dock = await dockIcons(app);
    expect(dock).toHaveLength(4);
    for (const item of dock) {
      expect({ label: item.label, width: item.width, height: item.height }).toEqual({ label: item.label, width: 16, height: 16 });
      // Only macOS knows template images.
      if (process.platform === 'darwin') expect(item.template, item.label).toBe(true);
      expect(item.px2, `${item.label} at 200 %`).toBe(32);
    }

    if (win) {
      const { seen, scaleFactor } = await thumbIcons(app);
      expect(seen).toHaveLength(2);
      for (const item of seen) {
        expect({ label: item.label, width: item.width, height: item.height }).toEqual({ label: item.label, width: 16, height: 16 });
        // Windows gets the bitmap nearest 1x: it has the pixels for this screen.
        expect(item.px1, item.label).toBeGreaterThanOrEqual(Math.round(16 * scaleFactor));
      }
    }
  });

  test("the thumbnail toolbar follows the taskbar's light or dark, the tray menu the apps'", async () => {
    test.skip(!win);
    running = await launchStandalone(profile);
    const { app, page } = running;
    await fillTray(app, page);
    const light = (value: number) => value > 200;
    const dark = (value: number) => value >= 0 && value < 80;

    await setTheme(app, { taskbarDark: true, appsDark: false });
    let thumbs = (await thumbIcons(app)).seen;
    let tray = (await trayIcons(app)).filter((item) => item.width);
    expect(thumbs.map((item) => light(item.brightness)), 'white glyphs on a dark taskbar').toEqual([true, true]);
    expect(tray.map((item) => dark(item.brightness)), 'dark glyphs in a light menu').toEqual([true, true]);

    await setTheme(app, { taskbarDark: false, appsDark: true });
    thumbs = (await thumbIcons(app)).seen;
    tray = (await trayIcons(app)).filter((item) => item.width);
    expect(thumbs.map((item) => dark(item.brightness)), 'dark glyphs on a light taskbar').toEqual([true, true]);
    expect(tray.map((item) => light(item.brightness)), 'white glyphs in a dark menu').toEqual([true, true]);
  });
});
