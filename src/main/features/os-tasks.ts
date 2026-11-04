/**
 * What the jump list, the thumbnail toolbar and the tray menu show for the app's commands:
 * each its own glyph, the one the webmail draws for it, in the shell's light or dark.
 * No Electron in here, so the checks can run it as it is.
 */

import path from 'node:path';
import type { JumpListCategory, JumpListItem } from 'electron';
import { TASK_ICON_FOLDER, taskIconFile } from '../../../scripts/task-icons.mjs';

export type TaskIcon = 'compose' | 'inbox' | 'calendar' | 'contacts' | 'message';
export type TaskIconVariant = 'light' | 'dark';

/** White glyphs on a dark shell, near-black ones on a light one. */
export function taskIconVariant(darkShell: boolean): TaskIconVariant {
  return darkShell ? 'light' : 'dark';
}

/**
 * Where the .ico files are. Windows reads a jump list's icons itself, so in a package they
 * sit outside the asar, in resources/ (electron-builder.yml). A build from source has them
 * as plain files in dist/.
 */
export function taskIconsDir(packaged: boolean, resourcesPath: string, buildDir: string): string {
  return packaged ? path.join(resourcesPath, TASK_ICON_FOLDER) : buildDir;
}

export function taskIconPath(dir: string, icon: TaskIcon, variant: TaskIconVariant): string {
  return path.join(dir, taskIconFile(icon, variant));
}

export interface JumpListInput {
  text: { trayNewMessage: string; jumpInbox: string; jumpCalendar: string; jumpContacts: string; jumpRecent: string };
  /** Recent messages: their title and their bulwark:// link. */
  recent: { title: string; url: string }[];
  program: string;
  args: (url: string) => string;
  iconsDir: string;
  variant: TaskIconVariant;
  /** Whether Windows can read a file there. Without one the entry takes the app's own icon. */
  iconExists: (file: string) => boolean;
}

export function jumpListCategories(input: JumpListInput): JumpListCategory[] {
  const { text } = input;
  const item = (title: string, url: string, icon: TaskIcon): JumpListItem => {
    const iconPath = taskIconPath(input.iconsDir, icon, input.variant);
    const found = input.iconExists(iconPath);
    return {
      type: 'task',
      title,
      description: title,
      program: input.program,
      args: input.args(url),
      iconPath: found ? iconPath : input.program,
      iconIndex: 0,
    };
  };
  const recent = input.recent.map(({ title, url }) => item(title, url, 'message'));
  return [
    ...(recent.length ? [{ type: 'custom' as const, name: text.jumpRecent, items: recent }] : []),
    {
      type: 'tasks',
      items: [
        item(text.trayNewMessage, 'bulwark://new', 'compose'),
        item(text.jumpInbox, 'bulwark://inbox', 'inbox'),
        item(text.jumpCalendar, 'bulwark://calendar', 'calendar'),
        item(text.jumpContacts, 'bulwark://contacts', 'contacts'),
      ],
    },
  ];
}
