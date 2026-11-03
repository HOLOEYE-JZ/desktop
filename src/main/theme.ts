/**
 * The window chrome's colours. They come from the page when the page says so
 * (the bridge, or Chromium's theme-color event, which an older instance fires
 * too), and from the OS until then. Stored, so the next launch's first frame
 * already has the right background.
 */

import { nativeTheme } from 'electron';
import type { SystemTheme, ThemeColours } from '../shared/bridge';
import type { StateFile } from './state';

const DEFAULTS = {
  dark: { background: '#17181b', symbol: '#f4f4f5' },
  light: { background: '#ffffff', symbol: '#18181b' },
};

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

export class ThemeController {
  private listeners = new Set<(colours: ChromeColours) => void>();
  private systemListeners = new Set<(system: SystemTheme) => void>();

  constructor(private readonly state: StateFile) {
    nativeTheme.themeSource = 'system';
    nativeTheme.on('updated', () => {
      const system = this.system();
      for (const listener of this.systemListeners) listener(system);
      // Nothing from a page yet: the chrome follows the OS by itself.
      if (!this.state.data.theme) this.emit();
    });
  }

  system(): SystemTheme {
    return { dark: nativeTheme.shouldUseDarkColors, highContrast: nativeTheme.shouldUseHighContrastColors };
  }

  colours(): ChromeColours {
    const stored = this.state.data.theme;
    if (stored) {
      return {
        background: stored.background,
        symbol: stored.foreground ?? (stored.dark ? DEFAULTS.dark.symbol : DEFAULTS.light.symbol),
        dark: stored.dark,
      };
    }
    const dark = nativeTheme.shouldUseDarkColors;
    return { ...(dark ? DEFAULTS.dark : DEFAULTS.light), dark };
  }

  /** A theme from the bridge. Ignored when it isn't a colour. */
  set(theme: ThemeColours): void {
    const background = toHex(theme?.background);
    if (!background) return;
    const foreground = toHex(theme.foreground) ?? undefined;
    this.store({ dark: typeof theme.dark === 'boolean' ? theme.dark : isDarkColour(background), background, foreground });
  }

  /** The page's <meta name="theme-color">, through Chromium. Older instances send this too. */
  setFromPageColour(colour: unknown): void {
    const background = toHex(colour);
    if (background) this.store({ dark: isDarkColour(background), background });
  }

  private store(next: ThemeColours): void {
    const current = this.state.data.theme;
    if (current && current.background === next.background && current.dark === next.dark && current.foreground === next.foreground) return;
    this.state.data.theme = next;
    this.state.touch();
    this.emit();
  }

  private emit(): void {
    const colours = this.colours();
    for (const listener of this.listeners) listener(colours);
  }

  onChange(listener: (colours: ChromeColours) => void): void {
    this.listeners.add(listener);
  }

  onSystemChange(listener: (system: SystemTheme) => void): void {
    this.systemListeners.add(listener);
  }
}
