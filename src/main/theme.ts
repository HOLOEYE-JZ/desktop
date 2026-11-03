/**
 * The window chrome's colours. They come from the page when the page says so
 * (the bridge, or Chromium's theme-color event, which an older instance fires
 * too), and from the OS until then. Stored, so the next launch's first frame
 * already has the right background.
 */

import { nativeTheme, systemPreferences } from 'electron';
import type { SystemTheme, ThemeColours } from '../shared/bridge';
import type { StateFile } from './state';
import { accentHex, highContrastColours, isDarkColour, toHex, type ChromeColours } from './chrome-colours';

export type { ChromeColours } from './chrome-colours';
export { isDarkColour, toHex } from './chrome-colours';

const DEFAULTS = {
  dark: { background: '#17181b', symbol: '#f4f4f5' },
  light: { background: '#ffffff', symbol: '#18181b' },
};

function systemColour(name: 'window' | 'window-text'): string | null {
  // On macOS and Windows only.
  try {
    return (systemPreferences as unknown as { getColor?: (name: string) => string }).getColor?.(name) ?? null;
  } catch {
    return null;
  }
}

function systemAccent(): string | null {
  try {
    return accentHex(systemPreferences.getAccentColor?.());
  } catch {
    return null;
  }
}

export class ThemeController {
  private listeners = new Set<(colours: ChromeColours) => void>();
  private systemListeners = new Set<(system: SystemTheme) => void>();

  constructor(private readonly state: StateFile) {
    nativeTheme.themeSource = 'system';
    nativeTheme.on('updated', () => {
      this.emitSystem();
      // Nothing from a page yet: the chrome follows the OS by itself. A contrast theme wins over a page.
      if (!this.state.data.theme || nativeTheme.shouldUseHighContrastColors) this.emit();
    });
    // Windows only; on macOS `nativeTheme` updated covers it.
    (systemPreferences as unknown as NodeJS.EventEmitter).on?.('accent-color-changed', () => this.emitSystem());
  }

  private emitSystem(): void {
    const system = this.system();
    for (const listener of this.systemListeners) listener(system);
  }

  system(): SystemTheme {
    const accent = systemAccent();
    return { dark: nativeTheme.shouldUseDarkColors, highContrast: nativeTheme.shouldUseHighContrastColors, ...(accent ? { accent } : {}) };
  }

  colours(): ChromeColours {
    if (nativeTheme.shouldUseHighContrastColors) {
      return highContrastColours(systemColour('window'), systemColour('window-text'), nativeTheme.shouldUseDarkColors);
    }
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
