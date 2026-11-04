/**
 * What a page may put in a dialog window, checked. No Electron here, so plain tests read it.
 *
 * Text is text: the dialog page sets textContent only, so markup a plugin wrote shows as
 * written. Lengths are capped and control characters go, so nothing can push the buttons
 * out of the window or fake a second line.
 */

import type { DialogWindowAnswer, DialogWindowColour, DialogWindowRequest } from '../shared/bridge';

export const DIALOG_LIMITS = {
  id: 64,
  title: 300,
  message: 2000,
  runs: 40,
  source: 200,
  label: 40,
  buttons: 4,
  menuItems: 4,
  menuLabel: 120,
};

export interface DialogSpec {
  /** The asking page's zoom: the card is drawn at it (CSS zoom), so it matches the page. */
  zoom: number;
  title: string;
  message: { text: string; bold: boolean }[];
  source?: string;
  icon?: 'warning';
  buttons: { label: string; variant: 'primary' | 'secondary' | 'destructive' }[];
  defaultIndex: number;
  menu?: { label: string; items: { id: string; label: string; destructive: boolean }[] };
  theme: DialogLook;
  lang: string;
  dir: 'ltr' | 'rtl';
}

export interface DialogLook {
  dark: boolean;
  colours: Record<DialogWindowColour, string>;
  font: string;
  fontSize: number;
  radius: number;
  radiusSmall: number;
}

/** The app's standard theme (app/globals.css in the webmail), for what a page leaves out. */
const LIGHT: Record<DialogWindowColour, string> = {
  background: '#ffffff',
  foreground: '#0f172a',
  muted: '#f1f5f9',
  mutedForeground: '#59687c',
  border: '#e2e8f0',
  input: '#e2e8f0',
  primary: '#185aea',
  primaryForeground: '#ffffff',
  destructive: '#dc2626',
  destructiveForeground: '#ffffff',
  accent: '#dbeafe',
  accentForeground: '#1e40af',
  ring: '#2563eb',
};

const DARK: Record<DialogWindowColour, string> = {
  background: '#0a0a0a',
  foreground: '#fafafa',
  muted: '#262626',
  mutedForeground: '#adadad',
  border: 'rgba(128, 128, 128, 0.3)',
  input: '#262626',
  primary: '#fafafa',
  primaryForeground: '#171717',
  destructive: '#ef4444',
  destructiveForeground: '#0a0a0a',
  accent: '#1e3a8a',
  accentForeground: '#dbeafe',
  ring: '#d4d4d4',
};

const DEFAULT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const COLOUR = /^(?:#[0-9a-f]{6}(?:[0-9a-f]{2})?|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d{1,4})\s*)?\))$/i;
/** Font names: letters, digits, spaces, quotes, commas, dots and hyphens. No url(), no semicolons. */
const FONT = /^[\p{L}\p{N} ,"'.\-_]{1,300}$/u;
const MENU_ID = /^[A-Za-z0-9._-]{1,40}$/;
const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** One line: control and format characters (bidi overrides too) become spaces. */
export function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Running text keeps its line breaks; other control and format characters go. */
function paragraphText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\p{Cf}\p{Zl}\p{Zp}]|[^\P{Cc}\n\t]/gu, '');
}

function number(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

export function readLook(value: unknown): DialogLook {
  const theme = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const dark = theme.dark === true;
  const colours = { ...(dark ? DARK : LIGHT) };
  const given = (theme.colours && typeof theme.colours === 'object' ? theme.colours : {}) as Record<string, unknown>;
  for (const key of Object.keys(colours) as DialogWindowColour[]) {
    const colour = given[key];
    if (typeof colour === 'string' && COLOUR.test(colour.trim())) colours[key] = colour.trim();
  }
  return {
    dark,
    colours,
    font: typeof theme.font === 'string' && FONT.test(theme.font) ? theme.font : DEFAULT_FONT,
    fontSize: number(theme.fontSize, 10, 24) ?? 16,
    radius: number(theme.radius, 0, 32) ?? 8,
    radiusSmall: number(theme.radiusSmall, 0, 32) ?? 6,
  };
}

/** Null when it isn't a question that can be drawn: no title, no buttons. */
export function readDialogRequest(value: unknown): (DialogSpec & { id: string }) | null {
  if (!value || typeof value !== 'object') return null;
  const request = value as Partial<Record<keyof DialogWindowRequest, unknown>>;
  if (typeof request.id !== 'string' || !request.id || request.id.length > DIALOG_LIMITS.id) return null;
  const title = oneLine(request.title, DIALOG_LIMITS.title);
  if (!title || !Array.isArray(request.buttons)) return null;

  const buttons: DialogSpec['buttons'] = [];
  for (const raw of request.buttons.slice(0, DIALOG_LIMITS.buttons)) {
    const button = (raw && typeof raw === 'object' ? raw : {}) as { label?: unknown; variant?: unknown };
    const label = oneLine(button.label, DIALOG_LIMITS.label);
    if (!label) return null;
    const variant = button.variant === 'secondary' || button.variant === 'destructive' ? button.variant : 'primary';
    buttons.push({ label, variant });
  }
  if (buttons.length === 0) return null;

  const message: DialogSpec['message'] = [];
  let left = DIALOG_LIMITS.message;
  if (Array.isArray(request.message)) {
    for (const raw of request.message.slice(0, DIALOG_LIMITS.runs)) {
      const run = (raw && typeof raw === 'object' ? raw : {}) as { text?: unknown; bold?: unknown };
      if (typeof run.text !== 'string' || left <= 0) continue;
      const text = paragraphText(run.text).slice(0, left);
      left -= text.length;
      if (text) message.push({ text, bold: run.bold === true });
    }
  }

  let menu: DialogSpec['menu'];
  const rawMenu = (request.menu && typeof request.menu === 'object' ? request.menu : null) as { label?: unknown; items?: unknown } | null;
  if (rawMenu && Array.isArray(rawMenu.items)) {
    const items = rawMenu.items.slice(0, DIALOG_LIMITS.menuItems).flatMap((raw) => {
      const item = (raw && typeof raw === 'object' ? raw : {}) as { id?: unknown; label?: unknown; destructive?: unknown };
      const label = oneLine(item.label, DIALOG_LIMITS.menuLabel);
      return typeof item.id === 'string' && MENU_ID.test(item.id) && label ? [{ id: item.id, label, destructive: item.destructive === true }] : [];
    });
    const label = oneLine(rawMenu.label, DIALOG_LIMITS.menuLabel);
    if (items.length > 0 && label) menu = { label, items };
  }

  const source = oneLine(request.source, DIALOG_LIMITS.source) || undefined;
  const defaultIndex = typeof request.defaultIndex === 'number' && Number.isInteger(request.defaultIndex) && request.defaultIndex >= 0 && request.defaultIndex < buttons.length
    ? request.defaultIndex
    : buttons.length - 1;
  return {
    id: request.id,
    zoom: 1,
    title,
    message,
    ...(source ? { source } : {}),
    ...(request.icon === 'warning' ? { icon: 'warning' as const } : {}),
    buttons,
    defaultIndex,
    ...(menu ? { menu } : {}),
    theme: readLook(request.theme),
    lang: typeof request.lang === 'string' && LANG.test(request.lang) ? request.lang : 'en',
    dir: request.dir === 'rtl' ? 'rtl' : 'ltr',
  };
}

/** What the dialog page answered, if it is one of the answers this dialog has. */
export function readDialogAnswer(value: unknown, spec: DialogSpec): DialogWindowAnswer | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const answer = value as { button?: unknown; menu?: unknown };
  if (typeof answer.button === 'number' && Number.isInteger(answer.button) && answer.button >= 0 && answer.button < spec.buttons.length) return { button: answer.button };
  if (typeof answer.menu === 'string' && spec.menu?.items.some((item) => item.id === answer.menu)) return { menu: answer.menu };
  return undefined;
}

/** The window around the card: room for its shadow on each side, in CSS px before the zoom. */
export const DIALOG_SHADOW_MARGIN = 24;
export const DIALOG_CARD_WIDTH = 448;

/** Zoom the card follows, kept to what a page can be zoomed to. */
export function dialogZoom(pageZoom: number): number {
  return Number.isFinite(pageZoom) ? Math.min(5, Math.max(0.25, pageZoom)) : 1;
}

/**
 * The window's bounds for content of this size (the card and its shadow margin, as the
 * page measured them), centred on the parent and kept on the parent's screen.
 */
export function dialogBounds(
  content: { width: number; height: number },
  parent: { x: number; y: number; width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(Math.ceil(content.width), workArea.width);
  const height = Math.min(Math.ceil(content.height), workArea.height);
  const x = Math.round(parent.x + (parent.width - width) / 2);
  const y = Math.round(parent.y + (parent.height - height) / 2);
  return {
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height)),
    width,
    height,
  };
}
