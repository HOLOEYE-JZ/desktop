/**
 * Native right-click menus. There are two kinds.
 *
 * What Chromium knows about: text, a link, an image, a misspelled word, here and in a
 * mail body's frame. It reports those with `context-menu`, which fires only when the
 * page didn't take the right-click itself.
 *
 * What the app knows about: a message, a folder, a contact. The webmail reads its
 * own HTML menu back and hands it over through `menu.popup`, so the contents are the
 * ones the browser shows and the two can't drift (lib/desktop/native-menu.ts).
 *
 * Spellcheck languages follow what the webmail says about the interface and composer.
 */

import { clipboard, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron';
import { CHANNEL, type LanguagesUpdate, type MenuBarEntry, type MenuState } from '../../shared/bridge';
import { escapeMenuLabel, pickSpellLanguages, toMenuTemplate } from '../menu-text';
import { openExternally } from '../navigation';
import { setUiLanguage, strings } from '../strings';
import type { Feature } from './index';

const MAX_SUGGESTIONS = 6;

export interface ContextTarget {
  params: ContextMenuParams;
  /** The page reported `policy.download: false`. */
  downloadsOff: boolean;
  /** The page's own spellcheck dictionary can take words. */
  session?: Session;
}

/** The menu for what's under the pointer, or nothing where a native app shows nothing. */
export function contextTemplate(contents: WebContents, target: ContextTarget): MenuItemConstructorOptions[] {
  const text = strings();
  const { params, downloadsOff } = target;
  const { editFlags } = params;
  const sections: MenuItemConstructorOptions[][] = [];

  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    sections.push([
      ...(suggestions.length
        ? suggestions.map((word): MenuItemConstructorOptions => ({ label: escapeMenuLabel(word), click: () => contents.replaceMisspelling(word) }))
        : [{ label: text.contextNoSuggestions, enabled: false }]),
      { type: 'separator' },
      {
        id: 'context.addToDictionary',
        label: escapeMenuLabel(text.contextAddToDictionary(params.misspelledWord)),
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      },
    ]);
  }

  if (params.linkURL) {
    const mail = params.linkURL.toLowerCase().startsWith('mailto:');
    sections.push([
      { id: 'context.openLink', label: text.contextOpenLink, click: () => openExternally(params.linkURL) },
      {
        id: 'context.copyLink',
        label: mail ? text.contextCopyAddress : text.contextCopyLink,
        click: () => clipboard.writeText(mail ? params.linkURL.slice('mailto:'.length).split('?')[0] : params.linkURL),
      },
    ]);
  }

  if (params.mediaType === 'image' && params.hasImageContents) {
    const image: MenuItemConstructorOptions[] = [];
    if (!downloadsOff) {
      image.push(
        { id: 'context.saveImage', label: text.contextSaveImage, click: () => contents.downloadURL(params.srcURL) },
        { id: 'context.copyImage', label: text.contextCopyImage, click: () => contents.copyImageAt(params.x, params.y) },
      );
    }
    if (image.length) sections.push(image);
  }

  if (params.isEditable) {
    sections.push([
      { id: 'context.cut', label: text.contextCut, enabled: editFlags.canCut, click: () => contents.cut() },
      { id: 'context.copy', label: text.contextCopy, enabled: editFlags.canCopy, click: () => contents.copy() },
      { id: 'context.paste', label: text.contextPaste, enabled: editFlags.canPaste, click: () => contents.paste() },
      { id: 'context.selectAll', label: text.contextSelectAll, enabled: editFlags.canSelectAll, click: () => contents.selectAll() },
    ]);
  } else if (params.selectionText.trim()) {
    sections.push([{ id: 'context.copy', label: text.contextCopy, enabled: editFlags.canCopy, click: () => contents.copy() }]);
  }

  return sections.flatMap((section, index) => (index ? [{ type: 'separator' } as MenuItemConstructorOptions, ...section] : section));
}

function policyAllowsDownload(state: MenuState | undefined): boolean {
  return state?.['policy.download'] !== false;
}

export const contextMenuFeature: Feature = {
  name: 'context-menu',
  modes: ['standalone', 'instance'],
  setup(ctx) {
    const { windows, menu, session } = ctx;

    windows.on('created', ({ window }) => {
      window.webContents.on('context-menu', (_event, params) => {
        const template = contextTemplate(window.webContents, {
          params,
          downloadsOff: !policyAllowsDownload(menu.commandState(window)),
        });
        if (template.length === 0) return;
        Menu.buildFromTemplate(template).popup({ window });
      });
    });

    ctx.handle(CHANNEL.menuPopup, (_event, window, items, at) => new Promise<string | null>((resolve) => {
      if (!window) {
        resolve(null);
        return;
      }
      let picked: string | null = null;
      const template = toMenuTemplate(items, (id) => {
        picked = id;
      });
      if (template.length === 0) {
        resolve(null);
        return;
      }
      const point = (at ?? {}) as { x?: unknown; y?: unknown };
      const scale = window.webContents.getZoomFactor();
      const place = typeof point.x === 'number' && typeof point.y === 'number' && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? { x: Math.round(point.x * scale), y: Math.round(point.y * scale) }
        : {};
      // The callback runs as the menu closes, and an item's click just before it on
      // some platforms and just after on others: a tick lets it land. A pick is a user
      // action, but the page can't know: without this, an entry that opens a file
      // picker or copies to the clipboard would be refused for lack of one.
      const finish = () => {
        if (picked === null || window.isDestroyed()) {
          resolve(picked);
          return;
        }
        void window.webContents.executeJavaScript('0', true).catch(() => {}).finally(() => resolve(picked));
      };
      Menu.buildFromTemplate(template).popup({ window, ...place, callback: () => setTimeout(finish, 0) });
    }));

    ctx.handle(CHANNEL.menuBarEntries, (): MenuBarEntry[] => menu.barEntries());
    ctx.on(CHANNEL.menuBarOpen, (_event, window, id, at) => {
      const point = (at ?? {}) as { x?: unknown; y?: unknown };
      if (window && typeof id === 'string' && typeof point.x === 'number' && typeof point.y === 'number') {
        menu.popupBarMenu(window, id, point.x, point.y);
      }
    });

    ctx.on(CHANNEL.shellSetLanguages, (_event, _window, update) => {
      const { ui, composer } = (update ?? {}) as Partial<LanguagesUpdate>;
      if (typeof ui !== 'string') return;
      setUiLanguage(ui);
      menu.rebuild();
      const wanted = [ui, ...(Array.isArray(composer) ? composer.filter((l): l is string => typeof l === 'string') : [])];
      const languages = pickSpellLanguages(wanted, session.availableSpellCheckerLanguages);
      // macOS has no such setting: its own spellchecker detects the language.
      if (languages.length && process.platform !== 'darwin') session.setSpellCheckerLanguages(languages);
    });

  },
};
