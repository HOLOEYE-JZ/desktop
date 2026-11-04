/**
 * Which attachments may be opened in another program from "Edit". Shared by main, which
 * enforces it, and the preload, so the page can hide the menu item without a second list.
 * No node modules: the preload is sandboxed.
 *
 * Edit hands a file from a stranger to whatever the OS runs for its extension, so this says
 * what may go, not what may not. A list of what's dangerous can't be finished: `.ppkg`,
 * `.xaml`, `.wcx`, `.udl`, `.xml` and `.ahk` all got through one and ran something on a
 * test machine. Everything else stays Download only.
 *
 * Office without macros, ODF, pictures, PDF, plain text and CSV, and CAD formats that are
 * only geometry. Not `.dwg`, which can carry VBA, and not `.stl`, which Windows opens as a
 * certificate list. Not web pages or `.svg`, whose default program runs their script.
 */

const ALWAYS = new Set([
  'docx', 'dotx', 'xlsx', 'xltx', 'pptx', 'potx', 'ppsx',
  'odt', 'ott', 'ods', 'ots', 'odp', 'otp', 'odg', 'otg',
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic', 'heif', 'avif',
  'pdf',
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv',
  'dxf', 'stp', 'step', 'igs', 'iges',
]);

/**
 * These can hold macros, and only Windows has something that stops them: Protected View, for a
 * file marked as from the internet. So they go on Windows only, and only once the mark is
 * written and read back. macOS and Linux have no such guard here.
 */
const ONLY_WITH_MARK = new Set(['doc', 'xls', 'ppt', 'rtf']);

export const EDIT_UNCHANGED_KEEP_MS = 24 * 60 * 60_000;
/** A changed copy nobody looked at: past this it's offered one last time. */
export const EDIT_CHANGED_KEEP_MS = 30 * 24 * 60 * 60_000;
/** How long that last offer stands once someone has seen it. */
export const EDIT_LAST_CALL_MS = 24 * 60 * 60_000;
/** For a copy nobody can be shown, as its account never came back. */
export const EDIT_CHANGED_MAX_MS = 90 * 24 * 60 * 60_000;

/** A long path is what Office refuses first: it stops at about 218 characters. */
const MAX_NAME_LENGTH = 100;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function currentPlatform(): string {
  return typeof process !== 'undefined' ? process.platform : '';
}

/**
 * The name the file gets on disk, or null when this file stays out of Edit. Control and
 * direction characters go first, and a trailing dot or space, because Windows drops those
 * when it looks at a name: `invoice.exe.` and `invoice.exe ` both run.
 */
export function editFileName(name: unknown, platform: string = currentPlatform()): string | null {
  if (typeof name !== 'string') return null;
  const base = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠-⁩﻿]/g, '')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = extensionOf(base);
  if (!ALWAYS.has(extension) && !(ONLY_WITH_MARK.has(extension) && platform === 'win32')) return null;
  const stem = base.slice(0, dot).replace(/[\s.]+$/g, '').slice(0, MAX_NAME_LENGTH - extension.length - 1).replace(/[\s.]+$/g, '');
  if (!stem) return null;
  const safeStem = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(stem) ? `_${stem}` : stem;
  return `${safeStem}.${base.slice(dot + 1)}`;
}

/** For the test of the real `shell.openPath`, whose file association can't touch a real type. Test builds only call it. */
export function allowEditExtensionForTest(extension: string): void {
  if (/^[a-z0-9]+$/.test(extension)) ALWAYS.add(extension);
}

/** Whether this file may only open with its mark from the internet confirmed. */
export function editNeedsMark(name: string): boolean {
  return ONLY_WITH_MARK.has(extensionOf(name));
}

/**
 * A program's own working file next to the one it edits: Office's `~$` and `~WRL`,
 * LibreOffice's `.~lock` and `lu*.tmp`, an editor's swap files. Never something the user saved.
 */
export function isEditTempName(name: string): boolean {
  return /^[~.#$]/.test(name) || /[~#]$/.test(name) || /\.(tmp|temp|bak|swp|swo|part|crdownload)$/i.test(name);
}

function bytesEndWith(tail: Uint8Array, wanted: readonly number[], within: number): boolean {
  const from = Math.max(0, tail.length - within);
  for (let at = tail.length - wanted.length; at >= from; at -= 1) {
    if (wanted.every((byte, index) => tail[at + index] === byte)) return true;
  }
  return false;
}

const ZIP_TYPES = new Set(['docx', 'dotx', 'xlsx', 'xltx', 'pptx', 'potx', 'ppsx', 'odt', 'ott', 'ods', 'ots', 'odp', 'otp', 'odg', 'otg']);
/** A zip's end record has room for a comment of 64 KB after it. */
export const EDIT_TAIL_BYTES = 66 * 1024;

/**
 * Whether a file can be told to be cut off, from its last bytes: the end record of a zip, which
 * is what Office and ODF files are, and the markers PDF, PNG and JPEG end on. Anything else
 * counts as whole, unless it's empty: a program that truncates first and writes after shows
 * an empty file on the way, and nobody means to attach nothing.
 */
export function editFileLooksWhole(name: string, size: number, tail: Uint8Array): boolean {
  if (size === 0) return false;
  const extension = extensionOf(name);
  if (ZIP_TYPES.has(extension)) return bytesEndWith(tail, [0x50, 0x4b, 0x05, 0x06], EDIT_TAIL_BYTES);
  if (extension === 'pdf') return bytesEndWith(tail, [0x25, 0x25, 0x45, 0x4f, 0x46], 1024);
  if (extension === 'png') return bytesEndWith(tail, [0x49, 0x45, 0x4e, 0x44], 16);
  if (extension === 'jpg' || extension === 'jpeg') return bytesEndWith(tail, [0xff, 0xd9], 1024);
  return true;
}
