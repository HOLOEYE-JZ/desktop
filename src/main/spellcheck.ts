/**
 * Spellcheck without a silent call to Google. Chromium fetches Hunspell dictionaries
 * from a Google host for any language the OS has no checker for, and the project
 * promises that no-third-party mode fails closed. So every session starts on an address
 * that goes nowhere, before any language is set. Where the OS has the language
 * (Windows, macOS) its own checker works regardless. For the rest the composer asks
 * once, and only a yes (never in no-third-party mode) sets the real address.
 */

export const DEAD_DICTIONARY_URL = 'https://dictionaries.invalid/';
/** Listed in the webmail's lib/admin/outgoing-hosts-registry.ts. */
export const GOOGLE_DICTIONARY_URL = 'https://redirector.gvt1.com/edgedl/chrome/dict/';

interface SpellSession {
  setSpellCheckerDictionaryDownloadURL(url: string): void;
  on(event: 'spellcheck-dictionary-download-failure', listener: (event: unknown, language: string) => void): unknown;
}

const missing = new Set<string>();
const listeners = new Set<(language: string) => void>();

/** Call as the session is made, before anything can set a language. */
export function closeDictionaryDownloads(session: SpellSession): void {
  session.setSpellCheckerDictionaryDownloadURL(DEAD_DICTIONARY_URL);
  session.on('spellcheck-dictionary-download-failure', (_event, language) => {
    missing.add(language);
    for (const listener of listeners) listener(language);
  });
}

export function missingDictionaries(): string[] {
  return [...missing];
}

export function onDictionaryMissing(listener: (language: string) => void): void {
  listeners.add(listener);
}

export function openDictionaryDownloads(session: Pick<SpellSession, 'setSpellCheckerDictionaryDownloadURL'>): void {
  missing.clear();
  session.setSpellCheckerDictionaryDownloadURL(GOOGLE_DICTIONARY_URL);
}
