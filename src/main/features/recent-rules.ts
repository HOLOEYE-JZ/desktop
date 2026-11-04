/**
 * The Attach menu's recent files, with nothing of Electron in it: where each OS keeps its
 * list, how to read it, and which of it the menu shows. See os-recent.ts for the rest.
 */

import path from 'node:path';

/** As many as Outlook's Attach menu, and enough. */
export const RECENT_FILES_MAX = 20;
/** Looked at for those 20: the newest shortcuts include folders, gone files and doubles. */
export const RECENT_CANDIDATES_MAX = 60;

export interface RecentCandidate {
  path: string;
  usedAt: number;
}

export type RecentCheck = 'file' | 'other' | 'missing';

/** Newest first; the same file twice (two shortcuts, two bookmarks) counts once, at its newest. */
export function newestCandidates(candidates: readonly RecentCandidate[], platform: string, limit = RECENT_CANDIDATES_MAX): RecentCandidate[] {
  const key = (file: string) => (platform === 'win32' || platform === 'darwin' ? file.toLowerCase() : file);
  const sorted = candidates
    .filter((entry) => entry.path && Number.isFinite(entry.usedAt))
    .sort((a, b) => b.usedAt - a.usedAt);
  const seen = new Set<string>();
  const out: RecentCandidate[] = [];
  for (const entry of sorted) {
    const id = key(entry.path);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * What the menu gets: the ones the check found to be files, in their order, at most 20.
 * One that didn't answer in time is left out like a missing one, and takes nothing else with it.
 */
export function shownCandidates(candidates: readonly RecentCandidate[], checks: ReadonlyMap<number, RecentCheck>, max = RECENT_FILES_MAX): RecentCandidate[] {
  const out: RecentCandidate[] = [];
  candidates.forEach((entry, index) => {
    if (out.length < max && checks.get(index) === 'file') out.push(entry);
  });
  return out;
}

/** The folder line under a name. The home folder is ~ where people know it as that. */
export function displayFolder(file: string, platform: string, home: string): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const folder = paths.dirname(file);
  if (platform !== 'win32' && home && (folder === home || folder.startsWith(`${home}/`))) return `~${folder.slice(home.length)}`;
  return folder;
}

export function displayName(file: string, platform: string): string {
  return (platform === 'win32' ? path.win32 : path.posix).basename(file);
}

/** The shortcuts in Windows' Recent folder, by the time each was last written: newest first. */
export function newestShortcuts(entries: readonly { file: string; mtimeMs: number }[], limit = RECENT_CANDIDATES_MAX): { file: string; mtimeMs: number }[] {
  return entries
    .filter((entry) => entry.file.toLowerCase().endsWith('.lnk') && Number.isFinite(entry.mtimeMs))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

/** A shortcut's target that names a file somewhere: not a shell namespace item, not a web address. */
export function usableShortcutTarget(target: string | undefined | null): string | null {
  if (!target || target.length > 32_767) return null;
  // C:\..., or \\server\share\...
  if (/^[a-zA-Z]:\\/.test(target) || /^\\\\[^\\?.]/.test(target)) return target;
  return null;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return XML_ENTITIES[name] ?? whole;
  });
}

/** A local file:// address as a path. Anything with a host, or no file scheme, is not one. */
function localFilePath(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:' || (url.host && url.host !== 'localhost')) return null;
  try {
    const decoded = decodeURIComponent(url.pathname);
    return decoded.startsWith('/') && !decoded.includes('\0') ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * GTK's ~/.local/share/recently-used.xbel: one <bookmark> per file, with the times it was
 * added, modified and visited. The newest of those is when it was last used.
 */
export function parseXbel(text: string): RecentCandidate[] {
  const out: RecentCandidate[] = [];
  for (const match of text.matchAll(/<bookmark\b([^>]*)>/g)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[1].matchAll(/([a-zA-Z:_-]+)\s*=\s*"([^"]*)"/g)) attributes.set(attribute[1], xmlText(attribute[2]));
    const file = localFilePath(attributes.get('href') ?? '');
    if (!file) continue;
    const times = ['added', 'modified', 'visited']
      .map((name) => Date.parse(attributes.get(name) ?? ''))
      .filter((time) => Number.isFinite(time));
    if (times.length === 0) continue;
    out.push({ path: file, usedAt: Math.max(...times) });
  }
  return out;
}

/** Documents, pictures and the like used in the last 30 days: no folders, no apps. */
export const MDFIND_QUERY = 'kMDItemLastUsedDate >= $time.today(-30) && kMDItemContentTypeTree == "public.content"';
export const MDFIND_ATTRIBUTE = 'kMDItemLastUsedDate';

/**
 * What `mdfind -attr kMDItemLastUsedDate <query>` prints: a path, then the attribute as
 * `kMDItemLastUsedDate = 2026-10-30 09:12:44 +0000`. Paths may hold spaces.
 */
export function parseMdfind(text: string): RecentCandidate[] {
  const marker = ` ${MDFIND_ATTRIBUTE} = `;
  const out: RecentCandidate[] = [];
  for (const line of text.split('\n')) {
    const at = line.lastIndexOf(marker);
    if (at < 0) continue;
    const file = line.slice(0, at).trimEnd();
    const value = line.slice(at + marker.length).trim();
    const parts = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value);
    if (!file.startsWith('/') || !parts) continue;
    // Settings, caches and mail of other apps: never what someone means to attach.
    if (file.includes('/Library/') || file.startsWith('/System/') || file.startsWith('/Applications/')) continue;
    const usedAt = Date.parse(`${parts[1]}T${parts[2]}${parts[3]}${parts[4]}:${parts[5]}`);
    if (Number.isFinite(usedAt)) out.push({ path: file, usedAt });
  }
  return out;
}
