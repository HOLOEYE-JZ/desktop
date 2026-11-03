/**
 * Text for native menus and file names, and what a page sent for a menu made safe.
 * No Electron at run time, so the tests can reach it.
 */

import type { MenuItemConstructorOptions } from 'electron';
import type { NativeMenuItem } from '../shared/bridge';

const MAX_ITEMS = 2000;
const MAX_DEPTH = 5;
const MAX_LABEL = 300;

/** Native menus read & as a marker. A folder called "R&D" has to stay that. */
export function escapeMenuLabel(label: string): string {
  return label.replace(/&/g, '&&');
}

/**
 * What a page sent, made safe to show. Anything out of shape is dropped, and a menu
 * with nothing left isn't shown. `onPick` gets the item's id.
 */
export function toMenuTemplate(items: unknown, onPick: (id: string) => void): MenuItemConstructorOptions[] {
  let budget = MAX_ITEMS;
  const walk = (list: unknown, depth: number): MenuItemConstructorOptions[] => {
    if (!Array.isArray(list) || depth > MAX_DEPTH) return [];
    const out: MenuItemConstructorOptions[] = [];
    for (const raw of list as NativeMenuItem[]) {
      if (budget-- <= 0 || !raw || typeof raw !== 'object') continue;
      if (raw.type === 'separator') {
        // None at the start, and none twice.
        if (out.length && out[out.length - 1].type !== 'separator') out.push({ type: 'separator' });
        continue;
      }
      if (typeof raw.label !== 'string' || !raw.label.trim()) continue;
      const label = escapeMenuLabel(raw.label.slice(0, MAX_LABEL));
      const enabled = raw.enabled !== false;
      if (raw.submenu) {
        const submenu = walk(raw.submenu, depth + 1);
        if (submenu.length) out.push({ label, enabled, submenu });
        continue;
      }
      const id = raw.id;
      if (typeof id !== 'string') continue;
      const type = raw.type === 'checkbox' || raw.type === 'radio' ? raw.type : 'normal';
      out.push({ label, enabled, type, ...(type !== 'normal' ? { checked: raw.checked === true } : {}), click: () => onPick(id) });
    }
    if (out[out.length - 1]?.type === 'separator') out.pop();
    return out;
  };
  return walk(items, 0);
}

/** The language Chromium has a dictionary for, closest to what was asked. */
export function pickSpellLanguages(wanted: string[], available: string[]): string[] {
  const out: string[] = [];
  for (const language of wanted) {
    const lower = language.toLowerCase();
    const found = available.find((a) => a.toLowerCase() === lower)
      ?? available.find((a) => a.toLowerCase().split('-')[0] === lower.split('-')[0]);
    if (found && !out.includes(found)) out.push(found);
  }
  return out;
}

export function safeFileName(name: unknown): string {
  // eslint-disable-next-line no-control-regex
  const base = String(name ?? '').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 180);
  return base || 'attachment';
}

/** What a window title makes as a file name. */
export function pdfFileName(title: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = title.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 120);
  return `${clean || 'Bulwark'}.pdf`;
}

