import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from '@playwright/test';
import { launchStandalone, removeProfile, SCREENSHOTS, tempProfile } from './helpers';

/** The tray menu as it really looks. Pops up on the desktop, so only on request: BULWARK_SHOTS=1. */
test('tray menu', async () => {
  test.skip(!process.env.BULWARK_SHOTS || process.platform !== 'win32');
  const profile = tempProfile('shot');
  const { app, page } = await launchStandalone(profile);
  try {
    await page.evaluate(() => {
      const os = (window as unknown as { bulwarkDesktop: { os: { setBadge: (n: number) => void; setSummary: (s: unknown) => void } } }).bulwarkDesktop.os;
      os.setBadge(3);
      os.setSummary({
        unread: [
          { emailId: '1', accountId: 'a', sender: 'Alice Becker', subject: 'Quarterly report, final numbers' },
          { emailId: '2', accountId: 'a', sender: 'Team calendar', subject: 'Standup moved to 09:30' },
          { emailId: '3', accountId: 'a', sender: 'Bob Weber', subject: 'Lunch on Friday?' },
        ],
        recent: [],
        nextEvent: { title: 'Project review', when: '14:30' },
      });
    });
    await page.waitForTimeout(500);
    const shown = app.evaluate(({ Menu, screen }) => {
      const handle = (globalThis as unknown as { __bulwarkOs: { tray: { tray: Electron.Tray; template: () => Electron.MenuItemConstructorOptions[] } } }).__bulwarkOs.tray;
      const { tray } = handle;
      const { bounds } = screen.getPrimaryDisplay();
      setTimeout(() => tray.closeContextMenu(), 6000);
      // Inside the part of the screen the picture takes, wherever the mouse is.
      tray.popUpContextMenu(Menu.buildFromTemplate(handle.template()), { x: bounds.width - 870, y: bounds.height - 620 });
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(import.meta.dirname, 'support', 'screen-corner.ps1'), '-Out', path.join(SCREENSHOTS, 'desktop-tray-menu.png'), '-W', '700', '-H', '500'], { windowsHide: true });
    await shown;
  } finally {
    await app.close().catch(() => {});
    removeProfile(profile);
  }
});
