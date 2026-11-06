// File > Open… and Save as… on the real app. The OS's dialogs are replaced with stubs that
// answer with a temporary folder, as the Save as PDF check does: nothing opens on screen.
//
//   npx playwright test test/save-open.spec.ts -g "the shell"
//   BULWARK_TEST_WEBMAIL=<a webmail build with Save as> IT_ENT_PASSWORD=<the test account's password> npx playwright test test/save-open.spec.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT, ENT_PASSWORD, expectMailShown, fakeOsIntegration, launchStandalone, removeProfile, requireAccount, SCREENSHOTS, signIn, STALWARTS, tempProfile, waitForLogin } from './helpers';
import { clickMenuItem, destroyMessages, jmap, menuItem, pageWith, seedMessage } from './native-helpers';

const win = process.platform === 'win32';

/** What the stubbed dialogs were asked, read back in main. */
interface Asked {
  save: { defaultPath?: string; filters?: { extensions: string[] }[] }[];
  open: { defaultPath?: string; filters?: { extensions: string[] }[]; properties?: string[]; title?: string }[];
}

/** The OS's Save and Open dialogs answer with these, in order, and remember what they were asked. */
async function stubDialogs(app: ElectronApplication, answers: { save?: string[]; open?: string[][] }): Promise<void> {
  await app.evaluate(({ dialog }, given) => {
    const g = globalThis as unknown as { __asked: Asked; __answers: { save: string[]; open: string[][] } };
    g.__asked = { save: [], open: [] };
    g.__answers = { save: [...(given.save ?? [])], open: [...(given.open ?? [])] };
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      g.__asked.save.push(args[args.length - 1] as Asked['save'][number]);
      const file = g.__answers.save.shift();
      return file ? { canceled: false, filePath: file } : { canceled: true, filePath: '' };
    }) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      g.__asked.open.push(args[args.length - 1] as Asked['open'][number]);
      const files = g.__answers.open.shift();
      return files ? { canceled: false, filePaths: files } : { canceled: true, filePaths: [] };
    }) as typeof dialog.showOpenDialog;
  }, answers as { save?: string[]; open?: string[][] });
}

function asked(app: ElectronApplication): Promise<Asked> {
  return app.evaluate(() => (globalThis as unknown as { __asked: Asked }).__asked);
}

type Begin = { id: string } | { cancelled: true } | { refused: string };

/** Save as through the bridge, the way the page calls it: after a click, or a script with none. */
async function saveThroughBridge(page: Page, names: string[], files: string[], click = true): Promise<{ begin: Begin; writes: boolean[]; end: { saved: number; failed: number } | null }> {
  if (click) await page.mouse.click(5, 300);
  return page.evaluate(async ({ names: list, files: contents }) => {
    const saveAs = (window as unknown as { bulwarkDesktop: { saveAs: {
      begin: (r: unknown) => Promise<Begin>;
      write: (id: string, i: number, d: Uint8Array) => Promise<boolean>;
      end: (id: string) => Promise<{ saved: number; failed: number }>;
    } } }).bulwarkDesktop.saveAs;
    const begin = await saveAs.begin({ kind: 'message', names: list });
    if (!('id' in begin)) return { begin, writes: [], end: null };
    const writes: boolean[] = [];
    for (const [index, text] of contents.entries()) writes.push(await saveAs.write(begin.id, index, new TextEncoder().encode(text)));
    return { begin, writes, end: await saveAs.end(begin.id) };
  }, { names, files });
}

const setState = (page: Page, state: Record<string, unknown>) =>
  page.evaluate((value) => (window as unknown as { bulwarkDesktop: { menu: { setState: (s: unknown) => void } } }).bulwarkDesktop.menu.setState(value), state);

test.describe('the shell', () => {
  let profile: string;
  let app: ElectronApplication;
  let page: Page;
  let scratch: string;

  test.beforeAll(async () => {
    profile = tempProfile('saveopen');
    scratch = mkdtempSync(path.join(tmpdir(), 'bw-saveopen-'));
    ({ app, page } = await launchStandalone(profile));
    await fakeOsIntegration(app);
    await waitForLogin(page);
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
    removeProfile(profile);
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  test('File has Open… and Save as… above Print, with Thunderbird\'s keys, and Ctrl+S stays Save draft in a composer', async () => {
    const lines = await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()!.getMenuItemById('file')!.submenu!.items;
      return file.filter((item) => item.visible && item.type !== 'separator').map((item) => item.id);
    });
    const at = (id: string) => lines.indexOf(id);
    expect(at('file.newWindow')).toBeLessThan(at('file.open'));
    expect(at('file.open')).toBe(at('file.saveAs') - 1);
    expect(at('file.saveAs')).toBeLessThan(at('file.print'));
    const open = await menuItem(app, 'file.open');
    expect(open).toMatchObject({ label: 'Open…', accelerator: 'CmdOrCtrl+O', enabled: true });
    // The sign-in page has no message to save.
    expect(await menuItem(app, 'file.saveAs')).toMatchObject({ label: 'Save as…', accelerator: 'CmdOrCtrl+S', enabled: false });

    // A composer: Save draft has the key, and Save as none (two lines can't share it).
    await setState(page, { 'compose.send': true, 'compose.saveDraft': true, 'file.saveAs': false });
    await expect.poll(async () => (await menuItem(app, 'compose.saveDraft'))?.accelerator).toBe('CmdOrCtrl+S');
    expect((await menuItem(app, 'file.saveAs'))?.accelerator ?? null).toBeNull();
    await setState(page, { 'file.saveAs': true });
    await expect.poll(async () => (await menuItem(app, 'file.saveAs'))?.accelerator).toBe('CmdOrCtrl+S');
    expect((await menuItem(app, 'file.saveAs'))?.enabled).toBe(true);
  });

  test('one message: the Save dialog, named after it, then the folder it went to the next time', async () => {
    const chosen = path.join(scratch, 'Picked name');
    await stubDialogs(app, { save: [chosen, path.join(scratch, 'Second.eml')] });
    const first = await saveThroughBridge(page, ['Lunch / plans?'], ['Subject: Lunch\r\n\r\nHi']);
    expect(first.writes).toEqual([true]);
    expect(first.end).toEqual({ saved: 1, failed: 0 });
    // The name typed lost its extension: it's an .eml all the same.
    expect(readFileSync(`${chosen}.eml`, 'utf8')).toBe('Subject: Lunch\r\n\r\nHi');
    if (win) expect(readFileSync(`${chosen}.eml:Zone.Identifier`, 'utf8')).toContain('ZoneId=3');
    let seen = await asked(app);
    expect(path.basename(seen.save[0].defaultPath!)).toBe('Lunch _ plans_.eml');
    expect(seen.save[0].filters?.[0].extensions).toEqual(['eml']);

    await saveThroughBridge(page, ['Second'], ['x']);
    seen = await asked(app);
    expect(seen.save[1].defaultPath).toBe(path.join(scratch, 'Second.eml'));
  });

  test('several: a folder, each its own file, and nothing there overwritten', async () => {
    const folder = path.join(scratch, 'many');
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'Same.eml'), 'already here');
    await stubDialogs(app, { open: [[folder]] });
    const result = await saveThroughBridge(page, ['Same', 'Same', 'Other'], ['one', 'two', 'three']);
    expect(result.end).toEqual({ saved: 3, failed: 0 });
    expect(readdirSync(folder).filter((name) => name.endsWith('.eml')).sort()).toEqual(['Other.eml', 'Same (2).eml', 'Same (3).eml', 'Same.eml']);
    expect(readFileSync(path.join(folder, 'Same.eml'), 'utf8')).toBe('already here');
    expect(readFileSync(path.join(folder, 'Same (2).eml'), 'utf8')).toBe('one');
    expect(readFileSync(path.join(folder, 'Same (3).eml'), 'utf8')).toBe('two');
    const seen = await asked(app);
    expect(seen.open[0].properties).toContain('openDirectory');
    expect(seen.open[0].title).toBe('Choose a folder for the messages');
  });

  test('no dialog for a script with no click, or under "no exporting mail"', async () => {
    await stubDialogs(app, { save: [path.join(scratch, 'never.eml')] });
    expect((await saveThroughBridge(page, ['A'], ['a'], false)).begin).toEqual({ refused: 'gesture' });
    await setState(page, { 'policy.export': false });
    expect((await saveThroughBridge(page, ['A'], ['a'])).begin).toEqual({ refused: 'policy' });
    await setState(page, {});
    // A write for a save that was never begun goes nowhere.
    expect(await page.evaluate(() => (window as unknown as { bulwarkDesktop: { saveAs: { write: (id: string, i: number, d: Uint8Array) => Promise<boolean> } } })
      .bulwarkDesktop.saveAs.write('made-up', 0, new Uint8Array([1])))).toBe(false);
    expect((await asked(app)).save).toEqual([]);
    expect(existsSync(path.join(scratch, 'never.eml'))).toBe(false);
  });

  test('Open… offers saved messages, events and contacts, and sends them where "Open with" does', async () => {
    const eml = path.join(scratch, 'Saved message.eml');
    const ics = path.join(scratch, 'Invite.ics');
    writeFileSync(eml, 'Subject: Saved\r\n\r\nBody');
    writeFileSync(ics, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
    await app.evaluate(() => {
      const os = (globalThis as unknown as { __bulwarkOs: { hub: { dispatch: (command: unknown, options?: unknown) => void } } }).__bulwarkOs;
      const g = globalThis as unknown as { __dispatched: unknown[] };
      g.__dispatched = [];
      const original = os.hub.dispatch.bind(os.hub);
      os.hub.dispatch = (command, options) => {
        g.__dispatched.push(command);
        original(command, options);
      };
    });
    await stubDialogs(app, { open: [[eml, ics], [eml]] });
    await clickMenuItem(app, 'file.open');
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __dispatched: unknown[] }).__dispatched.length)).toBeGreaterThan(0);
    const sent = await app.evaluate(() => (globalThis as unknown as { __dispatched: { type: string; reason: string; files: { name: string; data: Uint8Array }[]; failed: string[] }[] }).__dispatched
      .map((command) => ({ type: command.type, reason: command.reason, failed: command.failed, files: command.files.map((file) => ({ name: file.name, text: Buffer.from(file.data).toString('utf8') })) })));
    expect(sent).toEqual([{ type: 'files', reason: 'open', failed: [], files: [{ name: 'Saved message.eml', text: 'Subject: Saved\r\n\r\nBody' }, { name: 'Invite.ics', text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }] }]);
    let seen = await asked(app);
    expect(seen.open[0].filters?.[0].extensions).toEqual(['eml', 'ics', 'vcf']);
    expect(seen.open[0].properties).toEqual(expect.arrayContaining(['openFile', 'multiSelections']));
    // The next one starts in that folder.
    await clickMenuItem(app, 'file.open');
    await expect.poll(async () => (await asked(app)).open.length).toBe(2);
    seen = await asked(app);
    expect(seen.open[1].defaultPath).toBe(scratch);
  });

  test('nothing while the app is locked', async () => {
    await stubDialogs(app, { save: [path.join(scratch, 'locked.eml')], open: [[scratch]] });
    await setState(page, { 'file.saveAs': true });
    await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { gate: { lock: () => void } } }).__bulwarkOs.gate.lock());
    try {
      expect((await saveThroughBridge(page, ['A'], ['a'])).begin).toEqual({ refused: 'locked' });
      // The menus grey both while a PIN lock is on (app-lock.spec.ts); main says no even so.
      await app.evaluate(({ BrowserWindow }) => {
        const os = (globalThis as unknown as { __bulwarkOs: { saveOpen: { open: (w: unknown) => Promise<void> } } }).__bulwarkOs;
        return os.saveOpen.open(BrowserWindow.getAllWindows()[0]);
      });
      expect(await asked(app)).toEqual({ save: [], open: [] });
    } finally {
      await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { gate: { set: (locked: boolean) => void } } }).__bulwarkOs.gate.set(false));
    }
  });
});

for (const server of STALWARTS) {
  test.describe(`with mail on Stalwart ${server.label}`, () => {
    test.beforeAll(() => requireAccount());

    let profile: string;
    let app: ElectronApplication;
    let page: Page;
    let scratch: string;
    const cleanup: string[] = [];
    const RUN = Date.now().toString(36);
    const subjects = [`Save as one ${RUN}`, `Save as two ${RUN}`];

    test.beforeAll(async () => {
      test.setTimeout(300_000);
      profile = tempProfile('saveopenm');
      scratch = mkdtempSync(path.join(tmpdir(), 'bw-saveopenm-'));
      for (const subject of subjects) cleanup.push(await seedMessage(server.url, ACCOUNT, ENT_PASSWORD, subject, `Body of ${subject}.`));
      ({ app, page } = await launchStandalone(profile));
      await fakeOsIntegration(app);
      await signIn(page, server.url);
      await expectMailShown(page);
    });

    test.afterAll(async () => {
      await app?.close().catch(() => {});
      // What Open… imported, if anything, goes too.
      const [[, found]] = await jmap(server.url, ACCOUNT, ENT_PASSWORD, [['Email/query', { filter: { subject: `Opened ${RUN}` } }, 'q']]).catch(() => [[null, { ids: [] }]]);
      await destroyMessages(server.url, ACCOUNT, ENT_PASSWORD, [...cleanup, ...((found as { ids?: string[] })?.ids ?? [])]).catch(() => {});
      removeProfile(profile);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    });

    const row = (id: string) => page.locator(`[data-email-id="${id}"]`);

    test('File > Save as… saves the open message as an .eml from the server', async () => {
      await expect(row(cleanup[0])).toBeVisible({ timeout: 60_000 });
      await row(cleanup[0]).click();
      await expect(page.locator('body')).toContainText(`Body of ${subjects[0]}`, { timeout: 60_000 });
      await expect.poll(async () => (await menuItem(app, 'file.saveAs'))?.enabled, { timeout: 30_000 }).toBe(true);
      const target = path.join(scratch, 'one.eml');
      await stubDialogs(app, { save: [target] });
      await clickMenuItem(app, 'file.saveAs');
      await expect.poll(() => existsSync(target) && readFileSync(target, 'utf8'), { timeout: 30_000 }).toContain(`Subject: ${subjects[0]}`);
      expect((await asked(app)).save[0].defaultPath).toMatch(/\.eml$/);
    });

    test('with two selected it asks for a folder and saves both', async () => {
      // Ticked, as the list's checkboxes tick them.
      for (const subject of subjects) await page.getByRole('checkbox', { name: new RegExp(`Select .*${subject}`) }).check();
      await expect.poll(async () => (await menuItem(app, 'file.saveAs'))?.enabled, { timeout: 30_000 }).toBe(true);
      const folder = path.join(scratch, 'both');
      mkdirSync(folder);
      await stubDialogs(app, { open: [[folder]] });
      await clickMenuItem(app, 'file.saveAs');
      await expect.poll(() => readdirSync(folder).length, { timeout: 30_000 }).toBe(2);
      const texts = readdirSync(folder).map((name) => readFileSync(path.join(folder, name), 'utf8'));
      for (const subject of subjects) expect(texts.some((text) => text.includes(`Subject: ${subject}`))).toBe(true);
      await page.keyboard.press('Escape');
    });

    test('the message\'s ⋮ menu says Save as… and saves the same way', async () => {
      await row(cleanup[0]).click();
      await expect(page.locator('body')).toContainText(`Body of ${subjects[0]}`, { timeout: 60_000 });
      await page.getByRole('button', { name: 'More actions' }).first().click();
      const item = page.getByRole('menuitem', { name: 'Save as…' });
      await expect(item).toBeVisible();
      mkdirSync(SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-save-as-message-menu.png') });
      const target = path.join(scratch, 'from-menu.eml');
      await stubDialogs(app, { save: [target] });
      await item.click();
      await expect.poll(() => existsSync(target) && readFileSync(target, 'utf8'), { timeout: 30_000 }).toContain(`Subject: ${subjects[0]}`);
    });

    test('in a message window, File > Save as… saves that message', async () => {
      await row(cleanup[1]).dblclick();
      const message = await pageWith(app, `/popout/message/${encodeURIComponent(cleanup[1])}`, 60_000);
      await expect(message.locator('body')).toContainText(`Body of ${subjects[1]}`, { timeout: 60_000 });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/message/'))!.focus());
      await expect.poll(async () => (await menuItem(app, 'file.saveAs'))?.enabled, { timeout: 30_000 }).toBe(true);
      const target = path.join(scratch, 'from-window.eml');
      await stubDialogs(app, { save: [target] });
      await clickMenuItem(app, 'file.saveAs');
      await expect.poll(() => existsSync(target) && readFileSync(target, 'utf8'), { timeout: 30_000 }).toContain(`Subject: ${subjects[1]}`);
      await message.close().catch(() => {});
    });

    test('File > Open… opens a saved message in a window of its own', async () => {
      const file = path.join(scratch, 'opened.eml');
      writeFileSync(file, [
        'From: Someone <someone@example.org>',
        `To: ${ACCOUNT}`,
        `Subject: Opened ${RUN}`,
        'Date: Fri, 06 Nov 2026 10:00:00 +0000',
        'Message-ID: <opened-' + RUN + '@example.org>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        `This came from a file, ${RUN}.`,
        '',
      ].join('\r\n'));
      await stubDialogs(app, { open: [[file]] });
      await clickMenuItem(app, 'file.open');
      const message = await pageWith(app, '/popout/message', 60_000);
      await expect(message.locator('body')).toContainText(`This came from a file, ${RUN}.`, { timeout: 60_000 });
      await expect(message.locator('body')).toContainText(`Opened ${RUN}`);
      await message.close().catch(() => {});
    });

    test('the menu bar\'s File menu, as Alt shows it', async () => {
      if (!win) test.skip();
      await app.evaluate(({ BrowserWindow }) => {
        const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'))!;
        main.focus();
        main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Alt' } as never);
        main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Alt' } as never);
      });
      const strip = page.locator('[data-window-menu-bar]');
      await strip.waitFor({ timeout: 5000 });
      // Its letter is underlined in a span of its own: "F ile" to the accessibility tree.
      await strip.getByRole('menuitem', { name: /^F\s?ile$/ }).click();
      await expect(page.getByText('Open…').first()).toBeVisible({ timeout: 5000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-file-menu-save-open.png') });
      await page.keyboard.press('Escape');
    });
  });
}
