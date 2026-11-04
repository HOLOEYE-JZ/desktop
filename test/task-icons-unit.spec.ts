import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { encodeIco, icoSizes } from '../scripts/ico.mjs';
import { findPackagedTaskIconProblems, findResourceProblems } from '../scripts/package-guard.mjs';
import { findTaskIconProblems, TASK_ICON_SIZES, TASK_ICONS } from '../scripts/task-icons.mjs';
import { APP_USER_MODEL_ID, appUserModelId, TEST_APP_USER_MODEL_ID } from '../src/main/features/os-rules';
import { jumpListCategories, taskIconsDir, taskIconVariant, type JumpListInput, type TaskIconVariant } from '../src/main/features/os-tasks';
import { jumpListId } from './jump-list';

/**
 * The icons of the jump list's tasks: committed, made from the glyphs, shipped as real files
 * where the app looks for them, and one per task in the shell's light or dark.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const yaml = require('js-yaml');
const minimatchModule = require('minimatch');
const minimatch: (file: string, pattern: string) => boolean = minimatchModule.minimatch ?? minimatchModule;
const config = yaml.load(readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));
const ASSETS = path.join(ROOT, 'assets', 'os');

const TEXT = { trayNewMessage: 'New message', jumpInbox: 'Inbox', jumpCalendar: 'Calendar', jumpContacts: 'Contacts', jumpRecent: 'Recent conversations' };

function categories(iconsDir: string, variant: TaskIconVariant, iconExists: JumpListInput['iconExists'] = existsSync) {
  return jumpListCategories({
    text: TEXT,
    recent: [{ title: 'Lunch?', url: 'bulwark://message/e1' }],
    program: 'C:\\Program Files\\Bulwark\\Bulwark.exe',
    args: (url) => `-- ${url}`,
    iconsDir,
    variant,
    iconExists,
  });
}

const items = (list: ReturnType<typeof categories>) => list.flatMap((category) => category.items ?? []);

/**
 * resources/ as electron-builder lays out a Windows package: the extraResources of the
 * config's top level and its win section, here only those from this repo's assets.
 */
function packagedResources(): string {
  const resources = mkdtempSync(path.join(tmpdir(), 'bw-task-icons-'));
  for (const entry of [...(config.extraResources ?? []), ...(config.win.extraResources ?? [])]) {
    if (typeof entry !== 'object' || !entry.from.startsWith('assets/')) continue;
    const from = path.join(ROOT, entry.from);
    const to = path.join(resources, entry.to);
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      if ((entry.filter ?? ['**/*']).some((pattern: string) => minimatch(name, pattern))) copyFileSync(path.join(from, name), path.join(to, name));
    }
  }
  return resources;
}

test.describe('the jump list icons', () => {
  test('every task has its own icon, and the light and dark sets differ', () => {
    for (const variant of ['light', 'dark'] as const) {
      const list = categories(ASSETS, variant);
      const tasks = list.find((category) => category.type === 'tasks')!.items!;
      expect(tasks.map((task) => task.title)).toEqual(['New message', 'Inbox', 'Calendar', 'Contacts']);
      expect(tasks.map((task) => path.basename(task.iconPath!))).toEqual(['compose', 'inbox', 'calendar', 'contacts'].map((name) => `task-${name}-${variant}.ico`));
      const recent = list.find((category) => category.type === 'custom')!.items!;
      expect(path.basename(recent[0].iconPath!)).toBe(`task-message-${variant}.ico`);
      for (const item of items(list)) expect(item.iconIndex).toBe(0);
    }
    // White glyphs on a dark taskbar, near-black on a light one.
    expect(taskIconVariant(true)).toBe('light');
    expect(taskIconVariant(false)).toBe('dark');
  });

  test('an icon Windows could not read leaves the entry with the app\'s own', () => {
    const list = categories(ASSETS, 'light', (file) => !file.includes('inbox'));
    const inbox = items(list).find((item) => item.title === 'Inbox')!;
    expect(inbox.iconPath).toBe('C:\\Program Files\\Bulwark\\Bulwark.exe');
    expect(path.basename(items(list).find((item) => item.title === 'Calendar')!.iconPath!)).toBe('task-calendar-light.ico');
  });

  test('the committed icons are real .ico files with every size from 100% to 300%', () => {
    expect(TASK_ICON_SIZES).toEqual([16, 20, 24, 32, 40, 48]);
    expect(findTaskIconProblems(ASSETS)).toEqual([]);
    for (const name of TASK_ICONS) {
      expect(existsSync(path.join(ROOT, 'assets', 'glyphs', `${name}.svg`)), `${name}.svg, the source`).toBe(true);
      const light = readFileSync(path.join(ASSETS, `task-${name}-light.ico`));
      const dark = readFileSync(path.join(ASSETS, `task-${name}-dark.ico`));
      expect(light.equals(dark)).toBe(false);
    }
  });

  test('in a packaged layout, each icon the jump list names is there, outside the asar', () => {
    const resources = packagedResources();
    try {
      const dir = taskIconsDir(true, resources, path.join(ROOT, 'dist', 'os-icons'));
      expect(dir).toBe(path.join(resources, 'os-icons'));
      for (const variant of ['light', 'dark'] as const) {
        const paths = items(categories(dir, variant)).map((item) => item.iconPath!);
        expect(new Set(paths).size).toBe(5);
        for (const file of paths) {
          expect(file.startsWith(dir), file).toBe(true);
          expect(icoSizes(readFileSync(file))).toEqual(TASK_ICON_SIZES);
        }
      }
      expect(findPackagedTaskIconProblems(resources, 'win32')).toEqual([]);
      expect(findResourceProblems(resources, 'win32')).toEqual([]);
      // Not twice: the copy in the asar would be dead weight.
      expect(config.files).toContain('!dist/os-icons/*.ico');
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });

  test('the guard names a missing icon, one that is no icon, and one short of a size', () => {
    const resources = packagedResources();
    const icons = path.join(resources, 'os-icons');
    try {
      rmSync(path.join(icons, 'task-inbox-dark.ico'));
      writeFileSync(path.join(icons, 'task-calendar-light.ico'), 'not an icon');
      const rgba = (size: number) => Buffer.alloc(size * size * 4, 0xff);
      writeFileSync(path.join(icons, 'task-contacts-dark.ico'), encodeIco([16, 24, 32, 48].map((size) => ({ size, rgba: rgba(size) }))));
      writeFileSync(path.join(icons, 'notes.txt'), 'x');
      expect(findPackagedTaskIconProblems(resources, 'win32')).toEqual([
        'resources/os-icons/task-inbox-dark.ico (missing)',
        'resources/os-icons/task-calendar-light.ico (not an icon)',
        'resources/os-icons/task-contacts-dark.ico (no 20, 40 px)',
      ]);
      expect(findResourceProblems(resources, 'win32')).toEqual(['os-icons/notes.txt']);
      // Only Windows reads them.
      expect(findPackagedTaskIconProblems(resources, 'linux')).toEqual([]);
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });

  test('an .ico is read back as written, and a damaged one is refused', () => {
    const rgba = (size: number) => Buffer.alloc(size * size * 4, 0x80);
    const ico = encodeIco(TASK_ICON_SIZES.map((size) => ({ size, rgba: rgba(size) })));
    expect(icoSizes(ico)).toEqual(TASK_ICON_SIZES);
    expect(icoSizes(ico.subarray(0, ico.length - 10))).toBeNull();
    const wrongType = Buffer.from(ico);
    wrongType.writeUInt16LE(2, 2);
    expect(icoSizes(wrongType)).toBeNull();
    const wrongSize = Buffer.from(ico);
    wrongSize.writeUInt8(17, 6);
    expect(icoSizes(wrongSize)).toBeNull();
    expect(icoSizes(Buffer.alloc(0))).toBeNull();
  });
});

test.describe('the jump list of a test run', () => {
  test('goes under an ID of its own, not the installed app\'s', () => {
    expect(config.appId).toBe(APP_USER_MODEL_ID);
    expect(appUserModelId(false)).toBe(APP_USER_MODEL_ID);
    expect(appUserModelId(true)).toBe(TEST_APP_USER_MODEL_ID);
    expect(TEST_APP_USER_MODEL_ID).not.toBe(APP_USER_MODEL_ID);
    // The names Windows gives their jump list files, as seen on a real machine.
    expect(jumpListId(APP_USER_MODEL_ID)).toBe('57d0450ba8d1b511');
    expect(jumpListId(TEST_APP_USER_MODEL_ID)).toBe('4bc4710855c92b4');
  });
});

test.describe('the Linux launcher actions', () => {
  test('each has an icon from the desktop\'s theme', () => {
    const actions: Record<string, Record<string, string>> = config.linux.desktop.desktopActions;
    expect(Object.fromEntries(Object.entries(actions).map(([name, action]) => [name, action.Icon]))).toEqual({
      NewMessage: 'mail-message-new',
      Inbox: 'mail-folder-inbox',
      Calendar: 'x-office-calendar',
      Contacts: 'x-office-address-book',
    });
  });
});
