/**
 * Text for native menus and file names, and what a page sent for a menu made safe.
 * No Electron at run time, so the tests can reach it.
 */

import type { MenuItemConstructorOptions } from 'electron';
import type { NativeMenuItem } from '../shared/bridge';

const MAX_ITEMS = 2000;
const MAX_DEPTH = 5;
const MAX_LABEL = 300;

/**
 * A letter for Alt on each of the menu bar's names. Each takes the first letter in it
 * no earlier one has. A name that already marks one keeps it.
 */
export function assignMnemonics(labels: string[]): string[] {
  const used = new Set<string>();
  for (const label of labels) {
    const at = label.indexOf('&');
    if (at >= 0 && label[at + 1]) used.add(label[at + 1].toLowerCase());
  }
  return labels.map((label) => {
    if (label.includes('&')) return label;
    const chars = [...label];
    const at = chars.findIndex((c) => /\p{L}|\p{N}/u.test(c) && !used.has(c.toLowerCase()));
    if (at < 0) return label;
    used.add(chars[at].toLowerCase());
    return `${chars.slice(0, at).join('')}&${chars.slice(at).join('')}`;
  });
}

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

/** Where a bare language is mostly written, when the OS names no region for it. */
const USUAL_REGION: Record<string, string> = {
  ar: 'SA', ca: 'ES', cs: 'CZ', da: 'DK', el: 'GR', en: 'US', et: 'EE', fa: 'IR', he: 'IL', ja: 'JP',
  ko: 'KR', nb: 'NO', pt: 'BR', sl: 'SI', sr: 'RS', sv: 'SE', uk: 'UA', vi: 'VN', zh: 'CN',
};

const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

/**
 * What to check spelling in: the interface language, the composers' languages, and the
 * languages the user set up in the OS (Windows' input languages), each with its region.
 * Windows' own checker knows "en-US" and "de-DE" but not "en": with a bare tag Chromium
 * wants a downloaded dictionary instead. A bare tag takes the region the OS uses for
 * that language, else the usual one.
 */
export function spellLanguagesFor(ui: string, composer: readonly string[], system: readonly string[]): string[] {
  const os = system.filter((tag) => LANGUAGE_TAG.test(tag));
  const withRegion = (tag: string): string => {
    const [base, ...rest] = tag.split('-');
    if (rest.length) return tag;
    const known = os.find((candidate) => candidate.includes('-') && candidate.split('-')[0].toLowerCase() === base.toLowerCase());
    if (known) return known;
    return `${base.toLowerCase()}-${USUAL_REGION[base.toLowerCase()] ?? base.toUpperCase()}`;
  };
  const out: string[] = [];
  for (const tag of [ui, ...composer, ...os]) {
    if (!LANGUAGE_TAG.test(tag)) continue;
    const full = withRegion(tag);
    if (!out.some((seen) => seen.toLowerCase() === full.toLowerCase())) out.push(full);
  }
  return out;
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
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(base)) return `_${base}`;
  return base || 'attachment';
}

/** What a window title makes as a file name. */
export function pdfFileName(title: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = title.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 120);
  return `${clean || 'Bulwark'}.pdf`;
}


const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tiff',
};

/**
 * The name to save an image under, or null if it isn't one. The type decides the
 * extension: a sender calling their file `invoice.exe` gets `invoice.png`.
 */
export function safeImageName(name: unknown, mimeType: unknown): string | null {
  const type = typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase() : '';
  const extension = IMAGE_EXTENSIONS[type];
  if (!extension) return null;
  const base = safeFileName(name).replace(/\.[^.]*$/, '').replace(/[. ]+$/, '');
  return `${base || 'image'}.${extension}`;
}

const OPENABLE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:', 'xmpp:', 'webcal:']);

/** Whether a link gets Open and Copy: something the OS can open, outside the app. */
export function linkOffersOpen(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url);
    return OPENABLE_PROTOCOLS.has(parsed.protocol) && parsed.origin !== origin && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
