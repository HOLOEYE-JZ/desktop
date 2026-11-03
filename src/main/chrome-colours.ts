/** Colour arithmetic for the window's chrome. No Electron, so the tests can reach it. */

export interface ChromeColours {
  background: string;
  symbol: string;
  dark: boolean;
}

/** `#rgb`, `#rrggbb`, `rgb()` and `rgba()` to `#rrggbb`. Null for anything else. */
export function toHex(colour: unknown): string | null {
  if (typeof colour !== 'string') return null;
  const text = colour.trim().toLowerCase();
  let match = /^#([0-9a-f]{3})$/.exec(text);
  if (match) return `#${[...match[1]].map((c) => c + c).join('')}`;
  match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(text);
  if (match) return `#${match[1]}`;
  match = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+[\d.]+%?)?\s*\)$/.exec(text);
  if (match) {
    const parts = match.slice(1, 4).map(Number);
    if (parts.some((n) => n > 255)) return null;
    return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }
  return null;
}

export function isDarkColour(hex: string): boolean {
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/**
 * In a Windows contrast theme the page's own colours aren't what's on screen:
 * Chromium paints system colours over them. The caption buttons follow those.
 */
export function highContrastColours(window: string | null, text: string | null, dark: boolean): ChromeColours {
  const background = toHex(window) ?? (dark ? '#000000' : '#ffffff');
  return { background, symbol: toHex(text) ?? (isDarkColour(background) ? '#ffffff' : '#000000'), dark: isDarkColour(background) };
}

/** `RRGGBBAA` as Electron gives it, to `#rrggbb`. Null where the OS has none. */
export function accentHex(raw: unknown): string | null {
  return typeof raw === 'string' && /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(raw) ? `#${raw.slice(0, 6).toLowerCase()}` : null;
}

