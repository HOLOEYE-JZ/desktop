import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { appPathOfDeepLink, deepLinkFromArgv, parseDeepLink } from '../src/main/deep-link';
import { AltTracker } from '../src/main/features/window-input';
import { escapeMenuLabel, pdfFileName, pickSpellLanguages, safeFileName } from '../src/main/menu-text';
import { accentHex, highContrastColours } from '../src/main/chrome-colours';
import { nextInCycle, sumAnswers } from '../src/main/window-logic';
import { nextZoomLevel } from '../src/main/zoom';
import { APP_ORIGIN, fakeOsIntegration, launchStandalone, prompts, removeProfile, tempProfile, waitForLogin } from './helpers';
import { clickMenuItem, lastMenu, menuCount, menuItem, pageWith, pickNext, recordMenus, type SeenItem } from './native-helpers';

test.describe('the pure parts', () => {
  test('a deep link is parsed down to a message or a folder', () => {
    expect(parseDeepLink('bulwark://message/abc-123?account=a1&owner=o1')).toEqual({ kind: 'message', emailId: 'abc-123', account: 'a1', owner: 'o1' });
    expect(parseDeepLink('bulwark://folder/sent')).toEqual({ kind: 'folder', folder: 'sent' });
  });

  test('anything else from outside is refused', () => {
    for (const bad of [
      'bulwark://message/../../api/admin',
      'bulwark://message/a/b',
      'bulwark://message/',
      'bulwark://settings/x',
      'bulwark://message/a%2Fb',
      'bulwark://folder/%2e%2e',
      'https://example.com/message/a',
      'bulwark://message/a b',
      `bulwark://message/${'x'.repeat(3000)}`,
      42,
    ]) {
      expect(parseDeepLink(bad), String(bad)).toBeNull();
    }
    // A hostile query doesn't come along.
    expect(parseDeepLink('bulwark://message/a?account=../x')).toEqual({ kind: 'message', emailId: 'a', account: undefined, owner: undefined });
  });

  test('a link only ever becomes the app\'s own pop-out or folder address', () => {
    expect(appPathOfDeepLink({ kind: 'message', emailId: 'a1', account: 'x' })).toBe('/popout/message/a1?account=x');
    expect(appPathOfDeepLink({ kind: 'folder', folder: 'sent' })).toBe('/mail/folder/sent');
  });

  test('a second launch finds its link among the arguments', () => {
    expect(deepLinkFromArgv(['bulwark.exe', '--flag', 'bulwark://folder/inbox'])).toEqual({ kind: 'folder', folder: 'inbox' });
    expect(deepLinkFromArgv(['bulwark.exe', '--flag'])).toBeNull();
  });

  test('Alt alone toggles the strip, Alt plus a letter opens that menu, AltGr types', () => {
    const entries = [{ id: 'file', label: 'File', mnemonic: 'f' }, { id: 'edit', label: 'Edit', mnemonic: 'e' }];
    const down = (key: string, extra = {}) => ({ type: 'keyDown' as const, key, alt: false, control: false, meta: false, shift: false, ...extra });
    const up = (key: string, extra = {}) => ({ ...down(key, extra), type: 'keyUp' as const });

    const alone = new AltTracker();
    expect(alone.feed(down('Alt', { alt: true }), entries).type).toBe('none');
    expect(alone.feed(up('Alt'), entries).type).toBe('toggle');

    const letter = new AltTracker();
    letter.feed(down('Alt', { alt: true }), entries);
    expect(letter.feed(down('f', { alt: true }), entries)).toEqual({ type: 'open', id: 'file' });
    expect(letter.feed(up('Alt'), entries).type).toBe('none');

    // AltGr arrives as Ctrl+Alt on Windows: someone typing @ on a German keyboard.
    const altGr = new AltTracker();
    expect(altGr.feed(down('Alt', { alt: true, control: true }), entries).type).toBe('none');
    expect(altGr.feed(down('q', { alt: true, control: true }), entries).type).toBe('none');
    expect(altGr.feed(up('Alt', { control: true }), entries).type).toBe('none');

    // Something else in between: no strip.
    const chord = new AltTracker();
    chord.feed(down('Alt', { alt: true }), entries);
    chord.feed(down('Tab', { alt: true }), entries);
    expect(chord.feed(up('Alt'), entries).type).toBe('none');
  });

  test('Ctrl+` goes round the windows', () => {
    expect(nextInCycle([1, 2, 3], 1, 1)).toBe(2);
    expect(nextInCycle([1, 2, 3], 3, 1)).toBe(1);
    expect(nextInCycle([1, 2, 3], 1, -1)).toBe(3);
    expect(nextInCycle([1], 1, 1)).toBeNull();
    expect(nextInCycle([], undefined, 1)).toBeNull();
    expect(nextInCycle([4, 5], undefined, 1)).toBe(4);
  });

  test('saving answers add up: a failure, or a page out of time, counts as unsaved', () => {
    expect(sumAnswers([{ failed: 1 }, { failed: 0 }, {}])).toEqual({ failed: 1, unsent: 0 });
    expect(sumAnswers([{ timedOut: true }])).toEqual({ failed: 1, unsent: 0 });
    expect(sumAnswers([{ unsent: 2 }, { unsent: 2 }])).toEqual({ failed: 0, unsent: 2 });
  });

  test('zoom stays in range and 0 resets', () => {
    expect(nextZoomLevel(0, 1)).toBe(0.5);
    expect(nextZoomLevel(5, 1)).toBe(5);
    expect(nextZoomLevel(-3, -1)).toBe(-3);
    expect(nextZoomLevel(2, 0)).toBe(0);
  });

  test('names are safe for a menu and a file', () => {
    expect(escapeMenuLabel('R&D')).toBe('R&&D');
    expect(pdfFileName('Re: a/b <c>?')).toBe('Re a b c.pdf');
    expect(pdfFileName('...')).toBe('Bulwark.pdf');
    expect(safeFileName('..\\..\\evil.exe')).toBe('_.._evil.exe');
    expect(safeFileName('')).toBe('attachment');
  });

  test('spellcheck takes the closest dictionary there is', () => {
    expect(pickSpellLanguages(['de', 'en-GB'], ['en-US', 'en-GB', 'de-DE'])).toEqual(['de-DE', 'en-GB']);
    expect(pickSpellLanguages(['xx'], ['en-US'])).toEqual([]);
    expect(pickSpellLanguages(['de', 'de-AT'], ['de-DE'])).toEqual(['de-DE']);
  });

  test('colours: the OS accent and a contrast theme', () => {
    expect(accentHex('0078d4ff')).toBe('#0078d4');
    expect(accentHex('nonsense')).toBeNull();
    expect(highContrastColours('#000000', '#ffff00', false)).toEqual({ background: '#000000', symbol: '#ffff00', dark: true });
    expect(highContrastColours(null, null, true).background).toBe('#000000');
    expect(highContrastColours(null, null, false).symbol).toBe('#000000');
  });
});

test.describe('the app menu and windows', () => {
  let profile = '';
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    profile = tempProfile('menu');
    ({ app, page } = await launchStandalone(profile));
    await fakeOsIntegration(app);
    await recordMenus(app);
    await waitForLogin(page);
  });

  test.afterAll(async () => {
    await app.close();
    removeProfile(profile);
  });

  const setState = (state: Record<string, unknown>, on: Page = page) =>
    on.evaluate((value) => (window as unknown as { bulwarkDesktop: { menu: { setState: (s: unknown) => void } } }).bulwarkDesktop.menu.setState(value), state);

  const openPopout = async (id: string) => {
    await page.evaluate(
      (emailId) => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: `/popout/message/${emailId}`, emailId }),
      id,
    );
    return pageWith(app, `/popout/message/${id}`);
  };

  test('has the app\'s menus, in order, and nothing that reloads or opens developer tools', async () => {
    const tree = await app.evaluate(({ Menu }) => {
      type Item = { label: string; role?: string; submenu?: { items: Item[] } };
      const walk = (items: Item[]): { label: string; role?: string; children?: unknown }[] =>
        items.map((item) => ({ label: item.label, role: item.role, children: item.submenu ? walk(item.submenu.items) : undefined }));
      return walk(Menu.getApplicationMenu()!.items as unknown as Item[]);
    });
    expect(tree.map((item) => item.label.replace('&', ''))).toEqual(['File', 'Edit', 'View', 'Message', 'Go', 'Window', 'Help']);
    const roles = JSON.stringify(tree);
    expect(roles).not.toMatch(/reload/i);
    expect(roles).not.toMatch(/toggledevtools/i);
    expect(roles).not.toContain('Develop');
  });

  test('chords are real accelerators', async () => {
    expect(await menuItem(app, 'file.newMessage')).toMatchObject({ accelerator: 'CmdOrCtrl+N' });
    expect((await menuItem(app, 'file.newMessage'))?.registerAccelerator).not.toBe(false);
    expect(await menuItem(app, 'view.zoomIn')).toMatchObject({ accelerator: 'CmdOrCtrl+Plus' });
    expect(await menuItem(app, 'window.cycle')).toMatchObject({ accelerator: 'Ctrl+`' });
  });

  test('single keys only show: the page has them, and knows when someone types', async () => {
    const reply = await menuItem(app, 'message.reply');
    expect(reply).toMatchObject({ accelerator: 'R', registerAccelerator: false });
    await setState({ 'shortcuts.singleKeys': false });
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.accelerator).toBeFalsy();
    // Delete is no character key, so that setting leaves it on.
    expect(await menuItem(app, 'message.delete')).toMatchObject({ accelerator: 'Delete', registerAccelerator: false });
    await setState({});
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.accelerator).toBe('R');
  });

  test('items go on and off with what the page reports', async () => {
    expect((await menuItem(app, 'message.reply'))?.enabled).toBe(false);
    await setState({ 'message.reply': true, 'view.layout.horizontal': { enabled: true, checked: true } });
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.enabled).toBe(true);
    await expect.poll(async () => (await menuItem(app, 'view.layout.horizontal'))?.checked).toBe(true);
    await setState({ 'message.reply': false });
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.enabled).toBe(false);
  });

  test('a page that never reports has no page commands, which is an older instance', async () => {
    expect((await menuItem(app, 'message.delete'))?.enabled).toBe(false);
    expect((await menuItem(app, 'file.newWindow'))?.enabled).toBe(true);
  });

  test('a command reaches the page in the focused window', async () => {
    await page.evaluate(() => {
      const g = window as unknown as { __commands: string[]; bulwarkDesktop: { menu: { onCommand: (l: (id: string) => void) => void } } };
      g.__commands = [];
      g.bulwarkDesktop.menu.onCommand((id) => g.__commands.push(id));
    });
    await setState({ 'message.reply': true });
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.enabled).toBe(true);
    await clickMenuItem(app, 'message.reply');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __commands: string[] }).__commands)).toEqual(['message.reply']);
  });

  test('zoom: the keys\' items step it on every window and it\'s stored', async () => {
    const other = await openPopout('zoom1');
    await clickMenuItem(app, 'view.zoomIn');
    const levels = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getZoomLevel()));
    await expect.poll(levels).toEqual([0.5, 0.5]);
    await clickMenuItem(app, 'view.zoomOut');
    await clickMenuItem(app, 'view.zoomOut');
    await expect.poll(levels).toEqual([-0.5, -0.5]);
    await clickMenuItem(app, 'view.zoomReset');
    await expect.poll(levels).toEqual([0, 0]);
    await clickMenuItem(app, 'view.zoomIn');
    await other.close();
  });

  test('Ctrl+wheel goes the same way as the menu', async () => {
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel());
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.emit('zoom-changed', {}, 'in');
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())).toBe(before + 0.5);
    await clickMenuItem(app, 'view.zoomReset');
  });

  test('no reload on F5 or Ctrl+R, and no developer tools', async () => {
    await page.evaluate(() => {
      (window as unknown as { __stillHere: boolean }).__stillHere = true;
    });
    await page.keyboard.press('F5');
    await page.keyboard.press('Control+R');
    await page.keyboard.press('Control+Shift+R');
    await page.keyboard.press('Control+Shift+I');
    await page.keyboard.press('F12');
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as unknown as { __stillHere?: boolean }).__stillHere)).toBe(true);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened())).toBe(false);
  });

  test('the mouse\'s back button goes through the app\'s history, and only that', async () => {
    const start = page.url();
    await page.evaluate(() => history.pushState(null, '', '/en/login?step=2'));
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].emit('app-command', {}, 'browser-backward');
    });
    await expect.poll(() => page.url()).toBe(start);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].emit('app-command', {}, 'browser-forward');
    });
    await expect.poll(() => page.url()).toContain('step=2');
    await page.goBack();
    // A pop-out has no history: nothing happens, and nothing throws.
    const other = await openPopout('back1');
    const url = other.url();
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.emit('app-command', {}, 'browser-backward');
    });
    await other.waitForTimeout(300);
    expect(other.url()).toBe(url);
    await other.close();
  });

  test('the Window menu lists what\'s open and picks one', async () => {
    const other = await openPopout('list1');
    await other.evaluate(() => {
      document.title = 'A & B';
    });
    const list = () => app.evaluate(({ Menu }) => {
      const windowMenu = Menu.getApplicationMenu()!.items.find((item) => item.label.replace('&', '') === 'Window');
      return windowMenu!.submenu!.items.filter((item) => item.id?.startsWith('window.focus.')).map((item) => item.label);
    });
    await expect.poll(list).toHaveLength(2);
    // A title with & must show as one, not turn the next letter into a mnemonic.
    await expect.poll(async () => (await list()).some((label) => label === 'A && B')).toBe(true);
    const focused = await app.evaluate(({ Menu, BrowserWindow }) => {
      const seen: number[] = [];
      const original = BrowserWindow.prototype.focus;
      BrowserWindow.prototype.focus = function focus(this: Electron.BrowserWindow) {
        seen.push(this.id);
        return original.call(this);
      };
      const windowMenu = Menu.getApplicationMenu()!.items.find((item) => item.label.replace('&', '') === 'Window')!;
      windowMenu.submenu!.items.find((item) => item.label === 'A && B')!.click();
      BrowserWindow.prototype.focus = original;
      return seen;
    });
    expect(focused).toHaveLength(1);
    await other.close();
  });

  test('Next Window focuses another window', async () => {
    const other = await openPopout('cycle1');
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => w.isVisible())), { timeout: 30_000 }).toBe(true);
    const seen = await app.evaluate(({ Menu, BrowserWindow }) => {
      const ids: number[] = [];
      const original = BrowserWindow.prototype.focus;
      BrowserWindow.prototype.focus = function focus(this: Electron.BrowserWindow) {
        ids.push(this.id);
        return original.call(this);
      };
      Menu.getApplicationMenu()!.getMenuItemById('window.cycle')!.click();
      BrowserWindow.prototype.focus = original;
      return ids;
    });
    expect(seen).toHaveLength(1);
    await other.close();
  });

  test('New Window is a second main window, cascaded from the first', async () => {
    await clickMenuItem(app, 'file.newWindow');
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => w.isVisible())), { timeout: 30_000 }).toBe(true);
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getBounds()));
    expect(bounds[0].x).not.toBe(bounds[1].x);
    await app.evaluate(({ BrowserWindow }) => {
      // The newest: the list isn't in the order they opened.
      BrowserWindow.getAllWindows().sort((x, y) => y.id - x.id)[0].close();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  });

  test('Save as PDF writes a real PDF of the page, named after the window', async () => {
    const target = path.join(tmpdir(), `bulwark-test-${Date.now()}.pdf`);
    const asked = await app.evaluate(({ dialog, Menu, BrowserWindow }, file) => {
      const g = globalThis as unknown as { __save: { defaultPath?: string } };
      dialog.showSaveDialog = (async (...args: unknown[]) => {
        g.__save = args[args.length - 1] as { defaultPath?: string };
        return { canceled: false, filePath: file };
      }) as typeof dialog.showSaveDialog;
      BrowserWindow.getAllWindows()[0].setTitle('A/B report');
      Menu.getApplicationMenu()!.getMenuItemById('file.savePdf')!.click();
      return true;
    }, target);
    expect(asked).toBe(true);
    await expect.poll(() => existsSync(target) && readFileSync(target).subarray(0, 5).toString(), { timeout: 30_000 }).toBe('%PDF-');
    expect(await app.evaluate(() => (globalThis as unknown as { __save: { defaultPath?: string } }).__save.defaultPath)).toBe('A B report.pdf');
    rmSync(target, { force: true });
  });

  test('Print and Save as PDF are off under the device policy, and refuse if called anyway', async () => {
    await setState({ 'file.print': false, 'file.savePdf': false });
    await expect.poll(async () => (await menuItem(app, 'file.print'))?.enabled).toBe(false);
    expect((await menuItem(app, 'file.savePdf'))?.enabled).toBe(false);
    const called = await app.evaluate(({ Menu, BrowserWindow, dialog }) => {
      const g = { asked: 0, printed: 0 };
      const { webContents } = BrowserWindow.getAllWindows()[0];
      const print = webContents.print;
      webContents.print = (() => { g.printed += 1; }) as typeof webContents.print;
      const save = dialog.showSaveDialog;
      dialog.showSaveDialog = (async () => { g.asked += 1; return { canceled: true, filePath: '' }; }) as typeof dialog.showSaveDialog;
      const menu = Menu.getApplicationMenu()!;
      // A disabled item's click is what the accelerator can't reach; go round it.
      (menu.getMenuItemById('file.print') as unknown as { enabled: boolean }).enabled = true;
      (menu.getMenuItemById('file.savePdf') as unknown as { enabled: boolean }).enabled = true;
      menu.getMenuItemById('file.print')!.click();
      menu.getMenuItemById('file.savePdf')!.click();
      webContents.print = print;
      dialog.showSaveDialog = save;
      return g;
    });
    expect(called).toEqual({ asked: 0, printed: 0 });
    await setState({});
  });

  test('Print goes to the OS\'s print dialog, with the page\'s colours', async () => {
    await setState({});
    await expect.poll(async () => (await menuItem(app, 'file.print'))?.enabled).toBe(true);
    const options = await app.evaluate(({ Menu, BrowserWindow }) => {
      const { webContents } = BrowserWindow.getAllWindows()[0];
      const print = webContents.print;
      let seen: unknown = null;
      webContents.print = ((value: unknown) => { seen = value; }) as typeof webContents.print;
      Menu.getApplicationMenu()!.getMenuItemById('file.print')!.click();
      webContents.print = print;
      return seen;
    });
    expect(options).toMatchObject({ printBackground: true });
    expect((options as { silent?: boolean }).silent).not.toBe(true);
  });

  test.describe('right-click', () => {
    test('a real right-click in a field gets cut, copy, paste', async () => {
      const count = await menuCount(app);
      await page.fill('#username', 'someone');
      await page.click('#username', { button: 'right' });
      await expect.poll(() => menuCount(app)).toBeGreaterThan(count);
      const labels = (await lastMenu(app))!.map((item: SeenItem) => item.label);
      expect(labels).toEqual(expect.arrayContaining(['Cut', 'Copy', 'Paste', 'Select All']));
    });

    test('nothing on bare chrome, where a native app shows nothing', async () => {
      const count = await menuCount(app);
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await page.mouse.click(4, 300, { button: 'right' });
      await page.waitForTimeout(400);
      expect(await menuCount(app)).toBe(count);
    });

    const contextMenuAt = (params: Record<string, unknown>) => app.evaluate(({ BrowserWindow }, p) => {
      const base = { x: 1, y: 1, linkURL: '', linkText: '', srcURL: '', pageURL: '', frameURL: '', selectionText: '', mediaType: 'none', hasImageContents: false, isEditable: false, misspelledWord: '', dictionarySuggestions: [], editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false, canUndo: false, canRedo: false, canDelete: false, canEditRichly: false } };
      BrowserWindow.getAllWindows()[0].webContents.emit('context-menu', {}, { ...base, ...p });
    }, params);

    test('a misspelled word has suggestions and goes in the dictionary', async () => {
      await pickNext(app, 'Add "teh" to Dictionary');
      await contextMenuAt({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea'], editFlags: { canPaste: true } });
      const labels = (await lastMenu(app))!.map((item) => item.label);
      expect(labels.slice(0, 2)).toEqual(['the', 'tea']);
      expect(labels).toContain('Paste');
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.listWordsInSpellCheckerDictionary())).toContain('teh');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.removeWordFromSpellCheckerDictionary('teh'));
    });

    test('a link: Open goes to the browser, Copy Link to the clipboard', async () => {
      await pickNext(app, 'Copy Link');
      await contextMenuAt({ linkURL: 'https://example.org/a?b=1' });
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('https://example.org/a?b=1');
      await pickNext(app, 'Open Link');
      await contextMenuAt({ linkURL: 'https://example.org/open' });
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.at(-1))).toBe('https://example.org/open');
    });

    test('a mail address copies as an address', async () => {
      await pickNext(app, 'Copy Address');
      await contextMenuAt({ linkURL: 'mailto:someone@example.org?subject=x' });
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('someone@example.org');
    });

    test('a link with a scheme the OS shouldn\'t run stays closed', async () => {
      await pickNext(app, 'Open Link');
      const before = await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.length);
      await contextMenuAt({ linkURL: 'file:///C:/Windows/win.ini' });
      await page.waitForTimeout(150);
      expect(await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.length)).toBe(before);
    });

    test('an image: Save and Copy, unless the organisation turned downloads off', async () => {
      await contextMenuAt({ mediaType: 'image', hasImageContents: true, srcURL: `${APP_ORIGIN}/x.png` });
      expect((await lastMenu(app))!.map((item) => item.label)).toEqual(['Save Image…', 'Copy Image']);
      const count = await menuCount(app);
      await setState({ 'policy.download': false });
      await expect.poll(() => app.evaluate(() => true)).toBe(true);
      await page.waitForTimeout(100);
      await contextMenuAt({ mediaType: 'image', hasImageContents: true, srcURL: `${APP_ORIGIN}/x.png` });
      await page.waitForTimeout(150);
      // Nothing left to offer: no menu at all.
      expect(await menuCount(app)).toBe(count);
      await setState({});
    });
  });

  test.describe('a menu the page built', () => {
    const popup = (items: unknown[], at?: unknown) =>
      page.evaluate(([list, point]) => (window as unknown as { bulwarkDesktop: { menu: { popup: (i: unknown, a: unknown) => Promise<string | null> } } }).bulwarkDesktop.menu.popup(list, point), [items, at] as const);

    test('shows what it was given and answers with what was picked, also from a submenu', async () => {
      await pickNext(app, 'Inbox');
      const picked = await popup([
        { id: 'a', label: 'Reply' },
        { type: 'separator' },
        { label: 'Move to', submenu: [{ id: 'b', label: 'Inbox' }, { id: 'c', label: 'R&D' }] },
        { id: 'd', label: 'Later', enabled: false },
        { id: 'e', label: 'Mine', type: 'checkbox', checked: true },
      ]);
      expect(picked).toBe('b');
      const seen = (await lastMenu(app))!;
      expect(seen.map((item) => item.label || item.type)).toEqual(['Reply', 'separator', 'Move to', 'Later', 'Mine']);
      expect(seen[2].submenu!.map((item) => item.label)).toEqual(['Inbox', 'R&&D']);
      expect(seen[3].enabled).toBe(false);
      expect(seen[4].checked).toBe(true);
    });

    test('a pick counts as a user action for the page, so a file picker in it isn\'t refused', async () => {
      await app.evaluate(({ BrowserWindow }) => {
        const { webContents } = BrowserWindow.getAllWindows()[0];
        const original = webContents.executeJavaScript.bind(webContents);
        (globalThis as unknown as { __gestures: boolean[] }).__gestures = [];
        webContents.executeJavaScript = ((code: string, gesture?: boolean) => {
          (globalThis as unknown as { __gestures: boolean[] }).__gestures.push(!!gesture);
          return original(code, gesture);
        }) as typeof webContents.executeJavaScript;
      });
      await pickNext(app, 'Attach');
      expect(await popup([{ id: 'a', label: 'Attach' }])).toBe('a');
      expect(await app.evaluate(() => (globalThis as unknown as { __gestures: boolean[] }).__gestures)).toEqual([true]);
      // Dismissed, nothing happened that the page should get credit for.
      expect(await popup([{ id: 'a', label: 'Attach' }])).toBeNull();
      expect(await app.evaluate(() => (globalThis as unknown as { __gestures: boolean[] }).__gestures)).toEqual([true]);
    });

    test('dismissed, it answers null', async () => {
      expect(await popup([{ id: 'a', label: 'Reply' }])).toBeNull();
    });

    test('junk is dropped, and an empty menu never shows', async () => {
      const count = await menuCount(app);
      expect(await popup([null, 5, { label: '' }, { type: 'separator' }, { label: 'No id' }, { label: 'Empty', submenu: [] }])).toBeNull();
      expect(await menuCount(app)).toBe(count);
    });

    test('one absurdly long or deep menu can\'t take the app down', async () => {
      let deep: unknown = { id: 'x', label: 'Bottom' };
      for (let i = 0; i < 50; i += 1) deep = { label: 'Level', submenu: [deep] };
      await popup([deep, { id: 'long', label: 'y'.repeat(100_000) }]);
      const seen = (await lastMenu(app))!;
      expect(seen.at(-1)!.label.length).toBeLessThanOrEqual(300);
    });
  });

  test('an attachment copied as a file is what Explorer pastes', async () => {
    test.skip(process.platform !== 'win32', 'reads the clipboard through PowerShell');
    const copied = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { clipboard: { copyFile: (n: string, d: ArrayBuffer) => Promise<boolean> } } }).bulwarkDesktop.clipboard.copyFile('../report: q3?.txt', new TextEncoder().encode('hello').buffer));
    expect(copied).toBe(true);
    const run = spawnSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', '(Get-Clipboard -Format FileDropList).FullName'], { encoding: 'utf8' });
    const file = run.stdout.trim();
    expect(path.basename(file)).toBe('_report_ q3_.txt');
    // In this profile, never next to something else, and it holds the bytes.
    expect(file.toLowerCase().startsWith(path.join(profile, 'clipboard-files').toLowerCase())).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('hello');
    await app.evaluate(({ clipboard }) => clipboard.clear());
  });

  test('refuses anything but bytes', async () => {
    const refused = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { clipboard: { copyFile: (n: string, d: unknown) => Promise<boolean> } } }).bulwarkDesktop.clipboard.copyFile('a.txt', 'not bytes'));
    expect(refused).toBe(false);
  });

  test.describe('native questions', () => {
    const confirm = (options: unknown) =>
      page.evaluate((value) => (window as unknown as { bulwarkDesktop: { dialogs: { confirm: (o: unknown) => Promise<number> } } }).bulwarkDesktop.dialogs.confirm(value), options);

    test('answer with the button, and the last one is the way out', async () => {
      const answer = await confirm({ message: 'Discard this draft?', detail: 'It goes for good.', buttons: ['Discard', 'Cancel'], defaultId: 1, type: 'warning' });
      expect(answer).toBe(0);
      const prompt = (await prompts(app)).at(-1) as unknown as { message: string; buttons: string[]; cancelId: number; defaultId: number; type: string };
      expect(prompt).toMatchObject({ message: 'Discard this draft?', buttons: ['Discard', 'Cancel'], cancelId: 1, defaultId: 1, type: 'warning' });
    });

    test('refuse what isn\'t a question', async () => {
      await expect(confirm({ buttons: [] })).rejects.toThrow();
    });
  });
});

test.describe('closing', () => {
  let profile = '';
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    profile = tempProfile('close');
    ({ app, page } = await launchStandalone(profile));
    await fakeOsIntegration(app);
    await waitForLogin(page);
  });

  test.afterEach(async () => {
    await app.close().catch(() => {});
    removeProfile(profile);
  });

  const openPopout = async (id: string) => {
    await page.evaluate(
      (emailId) => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: `/popout/message/${emailId}`, emailId }),
      id,
    );
    return pageWith(app, `/popout/message/${id}`);
  };
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const closeFirst = () => app.evaluate(({ BrowserWindow }) => {
    // Not by its page: at this point it may still be on its way to the login page.
    BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'))!.close();
  });
  const onFlush = (on: Page, answer: unknown) => on.evaluate((value) => {
    (window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (h: () => Promise<unknown>) => void } } }).bulwarkDesktop.lifecycle.onFlushRequest(async () => value);
  }, answer);

  test('closing the main window with a pop-out open only hides it, and the pop-out keeps its session source', async () => {
    const other = await openPopout('m1');
    await closeFirst();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/login'))?.isVisible())).toBe(false);
    expect(await windowCount()).toBe(2);
    expect(await other.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { list: () => Promise<{ visible: boolean; type: string }[]> } } }).bulwarkDesktop.windows.list()))
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'main', visible: false })]));
  });

  test('a second launch brings the hidden main window back', async () => {
    await openPopout('m2');
    await closeFirst();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(1);
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit('second-instance', {}, ['bulwark.exe'], '');
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(2);
  });

  test('when the last pop-out goes too, so does the hidden main window, and the app quits', async () => {
    const other = await openPopout('m3');
    await closeFirst();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(1);
    const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    // The window can be gone before the answer comes back.
    await other.evaluate(() => window.close()).catch(() => undefined);
    await gone;
  });

  test('a pop-out closed before its first paint waits for it, and takes nothing down', async () => {
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
      const other = await openPopout(id);
      await onFlush(other, {});
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/'))?.close();
      });
      await expect.poll(windowCount, { timeout: 30_000 }).toBe(1);
    }
  });

  test('a minimized main window stays when the last pop-out closes', async () => {
    await openPopout('m7');
    await app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      windows.find((w) => !w.webContents.getURL().includes('/popout/'))!.minimize();
      windows.find((w) => w.webContents.getURL().includes('/popout/'))!.close();
    });
    await expect.poll(windowCount).toBe(1);
    await page.waitForTimeout(1500);
    expect(await windowCount()).toBe(1);
  });

  test('a window that asks to close itself isn\'t asked to save again', async () => {
    const other = await openPopout('m4');
    await other.evaluate(() => {
      const w = window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (h: () => Promise<unknown>) => void }; windows: { closeSelf: () => void } } };
      w.bulwarkDesktop.lifecycle.onFlushRequest(async () => {
        localStorage.setItem('asked-to-save', 'yes');
        return {};
      });
      w.bulwarkDesktop.windows.closeSelf();
    });
    await expect.poll(windowCount).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('asked-to-save'))).toBeNull();
  });

  test('the X asks the page to save, once', async () => {
    const other = await openPopout('m5');
    await other.evaluate(() => {
      const w = window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (h: () => Promise<unknown>) => void } } };
      w.bulwarkDesktop.lifecycle.onFlushRequest(async () => {
        localStorage.setItem('saves', String(Number(localStorage.getItem('saves') ?? 0) + 1));
        return {};
      });
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/'))!.close();
    });
    await expect.poll(windowCount).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('saves'))).toBe('1');
    expect(await prompts(app)).toEqual([]);
  });

  test('a save that failed asks before the window goes, and Stay keeps it', async () => {
    await fakeOsIntegration(app, 1);
    const other = await openPopout('m6');
    await onFlush(other, { failed: 1 });
    // By its id: with nobody signed in here, the pop-out's page moves on to the login page by itself.
    const id = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/'))!.id);
    const closeIt = () => app.evaluate(({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId)!.close(), id);
    await closeIt();
    await expect.poll(async () => (await prompts(app)).length).toBe(1);
    expect((await prompts(app))[0].message).toBe('A draft could not be saved');
    expect(await windowCount()).toBe(2);
    // And Close anyway does.
    await fakeOsIntegration(app, 0);
    await closeIt();
    await expect.poll(windowCount).toBe(1);
  });

  test('a page that hangs can\'t keep a window open past its limit, and that counts as unsaved', async () => {
    const other = await openPopout('m7');
    await other.evaluate(() => {
      (window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (h: () => Promise<unknown>) => void } } }).bulwarkDesktop.lifecycle.onFlushRequest(() => new Promise(() => {}));
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/'))!.close();
    });
    await expect.poll(async () => (await prompts(app)).length, { timeout: 8000 }).toBe(1);
    await expect.poll(windowCount).toBe(1);
  });

  test('quit: with nothing unsaved there\'s no question', async () => {
    const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await gone;
  });

  test('quit with mail waiting asks natively, and Stay calls it off with everything still there', async () => {
    await fakeOsIntegration(app, 1);
    await onFlush(page, { unsent: 2 });
    const other = await openPopout('q1');
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await expect.poll(async () => (await prompts(app)).length).toBe(1);
    expect((await prompts(app))[0]).toMatchObject({ message: 'Some mail has not been sent yet' });
    expect((await prompts(app))[0].detail).toContain('2 messages');
    await page.waitForTimeout(300);
    expect(await windowCount()).toBe(2);
    expect(other.isClosed()).toBe(false);
    // The second time, Quit.
    await fakeOsIntegration(app, 0);
    const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await gone;
  });

  test('closing the last window with mail waiting asks too', async () => {
    await fakeOsIntegration(app, 1);
    await onFlush(page, { unsent: 1 });
    await closeFirst();
    await expect.poll(async () => (await prompts(app)).length).toBe(1);
    expect((await prompts(app))[0].detail).toContain('One message');
    expect(await windowCount()).toBe(1);
    // The next one, from the test's own clean-up, goes through.
    await fakeOsIntegration(app, 0);
  });
});

test('a deep link at start and from a second launch opens the right window', async () => {
  const profile = tempProfile('deep');
  const { app, page } = await launchStandalone(profile, 'bulwark://message/abc1?account=a1');
  try {
    await waitForLogin(page);
    // Nobody signed in: a pop-out would have no session to borrow, so the link waits.
    await page.waitForTimeout(500);
    expect(app.windows().some((w) => w.url().includes('abc1'))).toBe(false);
    // One from a second launch waits too.
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit('second-instance', {}, ['bulwark.exe', 'bulwark://message/abc1?account=a1'], '');
    });
    await page.waitForTimeout(500);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { sessionReady: () => void } } }).bulwarkDesktop.windows.sessionReady());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 10_000 }).toBe(2);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()).some((u) => u.includes('abc1') || u.includes('popout') || u.includes('login')))).toBe(true);
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit('second-instance', {}, ['bulwark.exe', 'bulwark://message/abc1?account=a1'], '');
    });
    await page.waitForTimeout(400);
    // The same message: that window, focused, no second one.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
    await page.evaluate(() => {
      const w = window as unknown as { __links: string[]; bulwarkDesktop: { menu: { onCommand: (l: (id: string) => void) => void } } };
      w.__links = [];
      w.bulwarkDesktop.menu.onCommand((id) => w.__links.push(id));
    });
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit('second-instance', {}, ['bulwark.exe', 'bulwark://folder/sent'], '');
    });
    // No load of the main window: the webmail's router goes there.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __links: string[] }).__links)).toEqual(['link.folder:sent']);
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit('second-instance', {}, ['bulwark.exe', 'bulwark://evil/../../x'], '');
    });
    await page.waitForTimeout(300);
    expect(app.windows().some((w) => w.url().includes('evil'))).toBe(false);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('zoom is back at the next start', async () => {
  const profile = tempProfile('zoom');
  let { app, page } = await launchStandalone(profile);
  await waitForLogin(page);
  await clickMenuItem(app, 'view.zoomIn');
  await clickMenuItem(app, 'view.zoomIn');
  await app.close();
  ({ app, page } = await launchStandalone(profile));
  try {
    await waitForLogin(page);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())).toBe(1);
    // A native menu's place depends on it: page coordinates scale by this.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBeCloseTo(1.2, 1);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('the tray\'s hook: a last window closing leaves the app running, hidden', async () => {
  const profile = tempProfile('tray');
  const { app, page } = await launchStandalone(profile, '--bulwark-test-close-to-background');
  try {
    await waitForLogin(page);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false]);
    // Quit still means quit.
    const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await gone;
  } finally {
    await app.close().catch(() => {});
    removeProfile(profile);
  }
});
