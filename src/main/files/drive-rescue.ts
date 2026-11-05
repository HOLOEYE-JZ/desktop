/**
 * Nothing written in the drive is lost when the drive's folder goes (pass-3 files-p3-2,
 * files-p3-3). Before main deletes an account's folder (turned off, signed out, the policy,
 * a leftover at a start), every file whose content is here and isn't in Files yet is copied to
 * `Documents\Bulwark – not uploaded\<date>`, with its folders. A wipe doesn't come here: it
 * deletes, that's what it's for.
 *
 * "Not in Files yet" is what the placeholder says, not the page's word: a file made here and
 * never converted (no placeholder), or a placeholder with its content here and not in sync (an
 * edit Windows saw). Files the computer makes for itself (desktop.ini, Office's owner files,
 * main's own temporary files) never count.
 *
 * Pins ("Always keep on this device") go with a sign-out as a list of paths, and come back at
 * the next sign-in when the page places those paths again.
 *
 * No Electron here: plain Node, tested with a fake helper and the real one.
 */

import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { NativePlaceholderInfo } from '../native-loader';
import { systemExe } from '../system-exe';

/** The folder in Documents. The same in every language, as the coordinator decided. */
export const RESCUE_FOLDER = 'Bulwark – not uploaded';
/** At most this many pins are kept over a sign-out; a folder's pin covers what's in it. */
export const MAX_KEPT_PINS = 5000;
const MAX_WALK = 200_000;

const JUNK = [/^desktop\.ini$/i, /^thumbs\.db$/i, /^\.ds_store$/i, /^~\$/, /^~wrl.*\.tmp$/i, /^\.~lock\..*#$/i, /^\.bulwark-sync-/i];

/** Files the computer makes for itself, and main's own temporary files: never uploaded, never rescued. */
export function isJunkName(name: string): boolean {
  return JUNK.some((pattern) => pattern.test(name));
}

export type PlaceholderInfo = (absolute: string) => Pick<NativePlaceholderInfo, 'placeholder' | 'inSync' | 'hydrated' | 'pin' | 'directory'> | null;

interface Entry {
  absolute: string;
  /** `/` between parts, relative to the root. */
  relative: string;
  directory: boolean;
}

/** Everything under `dir`, links left out (a placeholder isn't one for lstat). */
function walk(dir: string): Entry[] {
  const out: Entry[] = [];
  const queue: { absolute: string; relative: string }[] = [{ absolute: dir, relative: '' }];
  while (queue.length > 0 && out.length < MAX_WALK) {
    const folder = queue.shift()!;
    let names: string[];
    try {
      names = readdirSync(folder.absolute);
    } catch {
      continue;
    }
    for (const name of names) {
      const absolute = path.join(folder.absolute, name);
      const relative = folder.relative ? `${folder.relative}/${name}` : name;
      let facts;
      try {
        facts = lstatSync(absolute);
      } catch {
        continue;
      }
      if (facts.isSymbolicLink()) continue;
      const directory = facts.isDirectory();
      out.push({ absolute, relative, directory });
      if (directory) queue.push({ absolute, relative });
    }
  }
  return out;
}

/**
 * Files under the drive's folder whose content is here and not in Files. Ask from a process
 * connected to the sync root: to any other, Windows shows placeholders as plain files.
 */
export function unsyncedFiles(dir: string, info: PlaceholderInfo): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of walk(dir)) {
    if (entry.directory || isJunkName(path.basename(entry.absolute))) continue;
    const state = info(entry.absolute);
    // Unreadable: kept, to be safe.
    if (!state || !state.placeholder || (!state.inSync && state.hydrated)) out.push(entry.relative);
  }
  return out;
}

/** Paths the user pinned themselves, folders and files: what "Always keep on this device" covers comes from these. */
export function pinnedPaths(dir: string, info: PlaceholderInfo): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const pinnedFolders: string[] = [];
  for (const entry of walk(dir)) {
    // Inside a pinned folder its pin covers it already.
    if (pinnedFolders.some((folder) => entry.relative.startsWith(`${folder}/`))) continue;
    if (info(entry.absolute)?.pin !== 'pinned') continue;
    out.push(entry.relative);
    if (entry.directory) pinnedFolders.push(entry.relative);
    if (out.length >= MAX_KEPT_PINS) break;
  }
  return out;
}

function dateFolder(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function freeName(target: string): string {
  if (!existsSync(target)) return target;
  const ext = path.extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let number = 2; ; number++) {
    const next = `${stem} (${number})${ext}`;
    if (!existsSync(next)) return next;
  }
}

export interface Rescued {
  /** Where they are now. */
  folder: string;
  count: number;
  /** Ones that couldn't be copied (open elsewhere, unreadable): still in the drive's folder, which then stays. */
  failed: number;
}

/**
 * Copies the files to `<documents>\Bulwark – not uploaded\<date>\<path in the drive>`. A copy,
 * read whole and written as a plain file: moving a placeholder out of a sync root would carry
 * its reparse point along. Null when there was nothing to copy.
 */
export async function rescueFiles(dir: string, relatives: string[], documents: string, now = new Date()): Promise<Rescued | null> {
  if (relatives.length === 0) return null;
  const folder = path.join(documents, RESCUE_FOLDER, dateFolder(now));
  let count = 0;
  let failed = 0;
  for (const relative of relatives) {
    const source = path.join(dir, ...relative.split('/'));
    try {
      const facts = lstatSync(source);
      if (!facts.isFile()) continue;
      const target = freeName(path.join(folder, ...relative.split('/')));
      mkdirSync(path.dirname(target), { recursive: true });
      await pipeline(createReadStream(source), createWriteStream(target, { flags: 'wx' }));
      try {
        utimesSync(target, facts.atime, facts.mtime);
      } catch {
        // The time is a nicety.
      }
      count += 1;
    } catch {
      failed += 1;
    }
  }
  return count + failed > 0 ? { folder, count, failed } : null;
}

/** "Always keep on this device", as the shell sets it: the pin attribute, through attrib. */
export function setPinAttribute(absolute: string, pin: 'pinned' | 'unpinned' | 'unspecified'): Promise<boolean> {
  const args = pin === 'pinned' ? ['-U', '+P'] : pin === 'unpinned' ? ['-P', '+U'] : ['-P', '-U'];
  return new Promise((resolve) => {
    execFile(systemExe('attrib.exe'), [...args, absolute], { windowsHide: true, timeout: 15_000 }, (error) => resolve(!error));
  });
}
