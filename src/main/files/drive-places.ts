/**
 * Where the Files drive lives on disk, and the small rules around it. No Electron here.
 *
 * Each account's sync root is a folder under `%USERPROFILE%\Bulwark Files`, named by the
 * address, so a second account doesn't move the first. Explorer shows "Bulwark Files" for
 * one account and "Bulwark Files - <address>" for each of several.
 */

import { createHash } from 'node:crypto';
import { lstatSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import type { FilesError, FilesLocalEntry, FilesPlaceholderState } from '../../shared/bridge';

export const DRIVE_PROVIDER = 'Bulwark';
export const DRIVE_FOLDER = 'Bulwark Files';
export const DRIVE_NAME = 'Bulwark Files';

/** The account part of a sync root's id: never the address, and different per profile. */
export function accountKey(profile: string, account: string): string {
  return createHash('sha256').update(`${profile}\0${account}`).digest('hex').slice(0, 24);
}

export function syncRootPrefix(provider: string): string {
  return `${provider}!`;
}

export function displayNameFor(label: string, accounts: number): string {
  return accounts > 1 ? `${DRIVE_NAME} - ${label}` : DRIVE_NAME;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A folder name for an address that Windows can hold, unlike any in `taken` (case aside). */
export function folderNameFor(label: string, taken: readonly string[]): string {
  let name = label.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120);
  if (!name || RESERVED.test(name)) name = `_${name || 'account'}`;
  const lower = new Set(taken.map((entry) => entry.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let number = 2; ; number++) {
    const next = `${name} (${number})`;
    if (!lower.has(next.toLowerCase())) return next;
  }
}

/** Is `inner` the same as or below `outer`? Windows paths, any case. */
export function inside(outer: string, inner: string): boolean {
  const relative = path.win32.relative(outer.toLowerCase(), inner.toLowerCase());
  return relative === '' || (!relative.startsWith('..') && !path.win32.isAbsolute(relative));
}

/** The parts of a path the page sends: relative, `/` between parts, nothing that leaves. */
export function relativeParts(relative: unknown): string[] | null {
  if (typeof relative !== 'string' || !relative || relative.length > 4096) return null;
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\:\u0000]/.test(part))) return null;
  return parts;
}

export type Resolved = { ok: true; absolute: string; parts: string[] } | { ok: false; error: FilesError };

/**
 * A path under a root, as an absolute path. Refused when it leaves the root, or when a folder
 * on the way is a link or a junction: something on the other end isn't the drive's.
 */
export function resolveUnder(rootDir: string, relative: unknown, lstat: (file: string) => { isSymbolicLink(): boolean } | null = lstatOrNull): Resolved {
  const parts = relativeParts(relative);
  if (!parts) return { ok: false, error: 'outside' };
  let at = rootDir;
  for (const part of parts) {
    at = path.win32.join(at, part);
    const facts = lstat(at);
    if (facts?.isSymbolicLink()) return { ok: false, error: 'outside' };
  }
  if (!inside(rootDir, at)) return { ok: false, error: 'outside' };
  return { ok: true, absolute: at, parts };
}

function lstatOrNull(file: string): BigIntStats | null {
  try {
    return lstatSync(file, { bigint: true });
  } catch {
    return null;
  }
}

/** The same as the folders side reads them (files/disk.ts), so `expect` works across both. */
export function fileIdOf(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}`;
}

export function mtimeMsOf(stats: BigIntStats): number {
  return Number(stats.mtimeNs / 1000n) / 1000;
}

export function entryFor(relative: string, stats: BigIntStats, placeholder?: FilesPlaceholderState): FilesLocalEntry {
  const directory = stats.isDirectory();
  return {
    path: relative,
    kind: directory ? 'directory' : 'file',
    size: directory ? 0 : Number(stats.size),
    mtimeMs: mtimeMsOf(stats),
    fileId: fileIdOf(stats),
    ...(placeholder ? { placeholder } : {}),
  };
}

export function expectMatches(stats: BigIntStats, expect: { fileId: string; size: number; mtimeMs: number }): boolean {
  return fileIdOf(stats) === expect.fileId && (stats.isDirectory() ? 0 : Number(stats.size)) === expect.size && mtimeMsOf(stats) === expect.mtimeMs;
}

/** What the helper's error code means to the page. */
export function filesErrorOf(code: string): FilesError {
  switch (code) {
    case 'missing':
    case 'exists':
    case 'busy':
    case 'denied':
    case 'name':
    case 'full':
    case 'changed':
    case 'outside':
    case 'unsupported':
      return code;
    // Edited here since: the save replaced the placeholder with a plain file.
    case 'not-placeholder':
      return 'changed';
    case 'pinned':
      return 'busy';
    default:
      return 'failed';
  }
}

// ─── The drive letter ────────────────────────────────────────

export const LETTERS = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** `subst` with no arguments: `X:\: => C:\folder` per line. */
export function parseSubst(output: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Z]):\\: => (.+)$/i.exec(line.trim());
    if (match) found.set(match[1].toUpperCase(), match[2].trim());
  }
  return found;
}

/** The letters D to Z that nothing uses, from GetLogicalDrives' mask, plus our own. */
export function freeLetters(usedMask: number, ours: string | null): string[] {
  return LETTERS.filter((letter) => letter === ours || (usedMask & (1 << (letter.charCodeAt(0) - 65))) === 0);
}

/**
 * The letter that should be in use: the policy's (`none` for none), else the user's. Only
 * while a drive is there.
 */
export function wantedLetter(policy: string | null, chosen: string | null, anyRoot: boolean): string | null {
  if (!anyRoot) return null;
  if (policy === 'none') return null;
  if (policy && /^[D-Z]$/.test(policy)) return policy;
  return chosen && /^[D-Z]$/.test(chosen) ? chosen : null;
}

/** One account: its folder. Several: the folder that holds them all. */
export function letterTarget(base: string, rootDirs: readonly string[]): string | null {
  if (rootDirs.length === 0) return null;
  return rootDirs.length === 1 ? rootDirs[0] : base;
}
