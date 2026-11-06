/**
 * File > Save as… and File > Open…, the parts with no Electron in them, so the unit
 * specs can load them. features/os-save-open.ts does the dialogs and the writing.
 */

import path from 'node:path';
import type { SaveAsRequest } from '../shared/bridge';
import { safeFileName } from './features/os-rules';

/** What Open… offers: the files "Open with Bulwark" takes from Explorer (os-rules.ts OPENABLE). */
export const OPEN_EXTENSIONS = ['eml', 'ics', 'vcf'] as const;

/** More than anyone selects to save at once; past it the request is refused, not cut short. */
export const MAX_SAVE_FILES = 500;
/** One message. A bigger one than any server takes. */
export const MAX_SAVE_FILE_BYTES = 200 * 1024 * 1024;
/** A save the page started and never finished goes after this. */
export const SAVE_SESSION_MS = 10 * 60_000;

/**
 * A message's file name: the page's name made safe, always ending in .eml. A subject that
 * reads "invoice.pdf.exe" stays text in a file Windows opens as mail.
 */
export function messageFileName(name: unknown): string {
  const clean = safeFileName(name, 'message');
  return clean.toLowerCase().endsWith('.eml') ? clean : `${clean.slice(0, 150)}.eml`;
}

/** The path the user typed in the Save dialog, with .eml added if it lost it. */
export function withMessageExtension(file: string): string {
  return path.extname(file).toLowerCase() === '.eml' ? file : `${file}.eml`;
}

/** "Subject.eml", then "Subject (2).eml", "Subject (3).eml": the `attempt`th name to try. */
export function numberedName(name: string, attempt: number): string {
  if (attempt <= 1) return name;
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${attempt})${ext}`;
}

/** The request as the page sent it, or null when it isn't one. */
export function cleanSaveRequest(raw: unknown): { kind: 'message'; names: string[] } | null {
  const request = (raw ?? {}) as Partial<SaveAsRequest>;
  if (request.kind !== 'message' || !Array.isArray(request.names)) return null;
  if (request.names.length === 0 || request.names.length > MAX_SAVE_FILES) return null;
  return { kind: 'message', names: request.names.map(messageFileName) };
}

/** A folder remembered from last time, if it's still a plain absolute path. */
export function rememberedFolder(value: unknown): string | undefined {
  return typeof value === 'string' && value.length < 1024 && path.isAbsolute(value) ? value : undefined;
}
