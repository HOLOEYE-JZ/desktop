/**
 * Finds mail data of other programs on this computer: Thunderbird profiles through
 * profiles.ini, and Outlook data files in their usual folders. It looks in those places
 * only and never walks the disk. Nothing here reads mail, only names, sizes and the
 * first bytes that say what a file is. No Electron here, so tests can load it.
 *
 * Every path it reports went through realpath and lies inside its root, and a symbolic
 * link or junction on the way is skipped, so a link in a profile can't lead anywhere
 * else. See import-files.ts for the same check at the moment of reading.
 */

import { execFile } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync, type Dirent, type Stats } from 'node:fs';
import path from 'node:path';

export type ImportKind = 'mbox' | 'maildir' | 'pst';
export type ImportApp = 'thunderbird' | 'outlook';

export interface ScanEnv {
  platform: NodeJS.Platform;
  home: string;
  /** %APPDATA% on Windows. */
  appData: string;
  /** %LOCALAPPDATA% on Windows. */
  localAppData?: string;
  documents: string;
}

export interface FoundFile {
  /** From realpath. */
  path: string;
  /** The folder this file has to stay inside, also from realpath. */
  root: string;
  app: ImportApp;
  kind: ImportKind;
  /** The profile's name, or "Outlook". */
  group: string;
  /** The Thunderbird account's folder, like "Local Folders". */
  account?: string;
  /** Where the mail goes on the server: `Archives.sbd/2020` is ["Archives", "2020"]. */
  folder: string[];
  /** Unique within the computer and the same on every scan: the checkpoint's key uses it. */
  name: string;
  size: number;
  lastModified: number;
  /** Maildir only. */
  messages?: number;
}

export interface FoundBook {
  path: string;
  root: string;
  group: string;
  name: string;
}

export interface ScanResult {
  files: FoundFile[];
  books: FoundBook[];
  /** Outlook files seen and not offered: an .ost, or a .pst that Outlook holds open. The UI names them. */
  refused: { name: string; reason: 'ost' | 'in-use' }[];
  /** Thunderbird calendars seen, which aren't imported. */
  calendars: number;
  /** Profile folders, for thunderbirdRunning. */
  profiles: string[];
  /** A profile found so far is in use. Not on macOS, where it takes a process: see thunderbirdRunning. */
  running: boolean;
}

/** A profile can hold many folders, but no reason to read without end. */
const MAX_ENTRIES = 50_000;
const MAX_DEPTH = 32;

/** Thunderbird's index next to each folder. Everything else is told apart by its first bytes. */
const NOT_MAIL = /\.msf$/i;
/** More than any folderCache.json: a bigger one isn't worth reading for the names in it. */
const MAX_FOLDER_CACHE_BYTES = 32 * 1024 * 1024;

function readHead(file: string, length = 512): Buffer {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(length);
    const read = readSync(fd, head, 0, length, 0);
    return head.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** The envelope line an mbox opens with, maybe after a byte order mark or empty lines. */
export function looksLikeMbox(head: Buffer): boolean {
  let at = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  while (head[at] === 0x0d || head[at] === 0x0a) at += 1;
  return head.subarray(at, at + 5).toString('latin1') === 'From ';
}

export type DataFileType = 'pst' | 'ost' | 'other';

/** wMagicClient in the header: SM is a PST, SO an OST, whatever the file is called. */
export function dataFileType(head: Buffer): DataFileType {
  if (head.subarray(0, 4).toString('latin1') !== '!BDN') return 'other';
  const client = head.subarray(8, 10).toString('latin1');
  if (client === 'SM') return 'pst';
  if (client === 'SO') return 'ost';
  return 'other';
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Where a realpath'd root has a file that really is inside it, or null. */
function resolvedInside(root: string, target: string): string | null {
  try {
    const real = realpathSync(target);
    return isInside(root, real) ? real : null;
  } catch {
    return null;
  }
}

function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export interface MaildirEntry {
  name: string;
  size: number;
}

/**
 * The messages of a Maildir folder in a stable order. Names start with the delivery
 * time, so what arrives later comes last and the checkpoint's position stays right.
 */
export function maildirEntries(dir: string): MaildirEntry[] {
  const out: MaildirEntry[] = [];
  for (const entry of entriesOf(path.join(dir, 'cur'))) {
    if (!entry.isFile()) continue;
    try {
      out.push({ name: entry.name, size: lstatSync(path.join(dir, 'cur', entry.name)).size });
    } catch {
      // Gone since the listing.
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function isMaildir(dir: string): boolean {
  try {
    return lstatSync(path.join(dir, 'cur')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * IMAP folder names on the disk are in modified UTF-7 (RFC 3501): `Entw&APw-rfe` is Entwürfe,
 * `&-` is an ampersand, and the base64 uses a comma for the slash. Left as it is when it isn't
 * valid, since a local folder can have such a name for real.
 */
export function decodeModifiedUtf7(name: string): string {
  try {
    return name.replace(/&([A-Za-z0-9+,]*)-/g, (_all, encoded: string) => {
      if (!encoded) return '&';
      const bytes = Buffer.from(encoded.replace(/,/g, '/'), 'base64');
      if (bytes.length === 0 || bytes.length % 2 !== 0) throw new Error('not UTF-16');
      return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    });
  } catch {
    return name;
  }
}

/** The part of an .msf's path a moved profile keeps: `mail/local folders/inbox.msf`. */
function folderCacheKey(file: string): string | null {
  const match = /[\\/]((?:Mail|ImapMail)[\\/].*\.msf)$/i.exec(file);
  return match ? match[1].replace(/\\/g, '/').toLowerCase() : null;
}

/**
 * Thunderbird hashes a folder name it can't use as a file name. folderCache.json, where a
 * profile has one, gives the real name by the path of the folder's .msf. Without it the
 * hashed name stays. Reading the Mork in the .msf for this isn't cheap enough.
 */
export function readFolderCache(profile: string): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const file = path.join(profile, 'folderCache.json');
    if (statSync(file).size > MAX_FOLDER_CACHE_BYTES) return names;
    const cache = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { folderName?: unknown }>;
    for (const [key, entry] of Object.entries(cache)) {
      const shortKey = folderCacheKey(key);
      if (shortKey && typeof entry?.folderName === 'string' && entry.folderName) names.set(shortKey, entry.folderName);
    }
  } catch {
    // None, or not what it should be: the file names it is.
  }
  return names;
}

interface WalkContext {
  root: string;
  group: string;
  account: string;
  area: string;
  folderNames: Map<string, string>;
  seen: { entries: number };
  out: FoundFile[];
}

/** What a folder is called, from the file `name` in `dir`. */
function folderLabel(dir: string, name: string, ctx: WalkContext): string {
  const key = folderCacheKey(path.join(dir, `${name}.msf`));
  const cached = key ? ctx.folderNames.get(key) : undefined;
  if (cached) return cached;
  return ctx.area === 'ImapMail' ? decodeModifiedUtf7(name) : name;
}

/** One account's folder tree: an mbox file, or a Maildir folder, and `<name>.sbd` for what's under it. */
function walkMailFolder(dir: string, parents: string[], names: string[], ctx: WalkContext, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  for (const entry of entriesOf(dir)) {
    if (ctx.seen.entries++ >= MAX_ENTRIES) return;
    // A symbolic link or a junction leads out of the profile, or at least nowhere we looked at.
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.sbd')) {
        const base = entry.name.slice(0, -'.sbd'.length);
        walkMailFolder(full, [...parents, folderLabel(dir, base, ctx)], [...names, base], ctx, depth + 1);
      } else if (isMaildir(full)) {
        const real = resolvedInside(ctx.root, full);
        if (!real) continue;
        const messages = maildirEntries(real);
        if (messages.length === 0) continue;
        const folder = [...parents, folderLabel(dir, entry.name, ctx)];
        ctx.out.push({
          path: real,
          root: ctx.root,
          app: 'thunderbird',
          kind: 'maildir',
          group: ctx.group,
          account: ctx.account,
          folder,
          // The names on disk: a checkpoint must not depend on how a name was decoded.
          name: [ctx.group, ctx.account, ...names, entry.name].join('/'),
          size: messages.reduce((total, message) => total + message.size, 0),
          lastModified: statSync(path.join(real, 'cur')).mtimeMs,
          messages: messages.length,
        });
      }
      continue;
    }
    if (!entry.isFile() || NOT_MAIL.test(entry.name)) continue;
    const real = resolvedInside(ctx.root, full);
    if (!real) continue;
    try {
      const stat = statSync(real);
      if (stat.size === 0 || !looksLikeMbox(readHead(real))) continue;
      const folder = [...parents, folderLabel(dir, entry.name, ctx)];
      ctx.out.push({
        path: real,
        root: ctx.root,
        app: 'thunderbird',
        kind: 'mbox',
        group: ctx.group,
        account: ctx.account,
        folder,
        name: [ctx.group, ctx.account, ...names, entry.name].join('/'),
        size: stat.size,
        lastModified: stat.mtimeMs,
      });
    } catch {
      // Unreadable: Thunderbird holds it, or it went away. Not on the list.
    }
  }
}

export interface IniProfile {
  name: string;
  path: string;
}

/** profiles.ini: `[ProfileN]` sections with Name, Path and IsRelative. */
export function parseProfilesIni(text: string, iniDir: string): IniProfile[] {
  const out: IniProfile[] = [];
  let current: Record<string, string> | null = null;
  const flush = () => {
    if (current?.path) {
      const relative = current.isrelative !== '0';
      out.push({
        name: current.name || path.basename(current.path),
        path: relative ? path.join(iniDir, ...current.path.split(/[\\/]/)) : current.path,
      });
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      flush();
      current = /^profile\d*$/i.test(section[1]) ? {} : null;
      continue;
    }
    const pair = /^\s*([^=#;\s]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (pair && current) current[pair[1].toLowerCase()] = pair[2];
  }
  flush();
  return out;
}

/** The folders that hold profiles.ini on this OS. Flatpak and snap have their own. */
export function thunderbirdHomes(env: ScanEnv): string[] {
  if (env.platform === 'win32') return [path.join(env.appData, 'Thunderbird')];
  if (env.platform === 'darwin') return [path.join(env.home, 'Library', 'Thunderbird')];
  return [
    path.join(env.home, '.thunderbird'),
    path.join(env.home, '.var', 'app', 'org.mozilla.Thunderbird', '.thunderbird'),
    path.join(env.home, 'snap', 'thunderbird', 'common', '.thunderbird'),
  ];
}

export function outlookFolders(env: ScanEnv): string[] {
  const folders: string[] = [];
  // The name is translated ("Outlook-Dateien", "Fichiers Outlook"), and older ones are "My Outlook Files".
  for (const entry of entriesOf(env.documents)) {
    if (entry.isDirectory() && /outlook/i.test(entry.name)) folders.push(path.join(env.documents, entry.name));
  }
  if (env.localAppData) folders.push(path.join(env.localAppData, 'Microsoft', 'Outlook'));
  return folders;
}

function scanProfile(profile: IniProfile, result: ScanResult): void {
  let root: string;
  try {
    root = realpathSync(profile.path);
  } catch {
    return;
  }
  if (!statSync(root).isDirectory() || result.profiles.includes(root)) return;
  result.profiles.push(root);
  if (profileInUse(root)) result.running = true;
  const folderNames = readFolderCache(root);
  const seen = { entries: 0 };
  for (const area of ['Mail', 'ImapMail']) {
    const areaDir = path.join(root, area);
    for (const account of entriesOf(areaDir)) {
      if (!account.isDirectory() || account.isSymbolicLink()) continue;
      walkMailFolder(path.join(areaDir, account.name), [], [], { root, group: profile.name, account: account.name, area, folderNames, seen, out: result.files });
    }
  }
  for (const entry of entriesOf(root)) {
    if (!entry.isFile() || !/^abook(-\d+)?\.sqlite$/i.test(entry.name)) continue;
    const real = resolvedInside(root, path.join(root, entry.name));
    if (real) result.books.push({ path: real, root, group: profile.name, name: entry.name });
  }
  if (existsSync(path.join(root, 'calendar-data', 'local.sqlite'))) result.calendars += 1;
}

function scanOutlook(env: ScanEnv, result: ScanResult): void {
  for (const folder of outlookFolders(env)) {
    let root: string;
    try {
      root = realpathSync(folder);
    } catch {
      continue;
    }
    for (const entry of entriesOf(root)) {
      if (entry.isSymbolicLink() || !entry.isFile() || !/\.(pst|ost)$/i.test(entry.name)) continue;
      const real = resolvedInside(root, path.join(root, entry.name));
      if (!real || result.files.some((file) => file.path === real)) continue;
      const refuse = (reason: 'ost' | 'in-use') => {
        if (!result.refused.some((known) => known.name === entry.name)) result.refused.push({ name: entry.name, reason });
      };
      const namedOst = /\.ost$/i.test(entry.name);
      let type: DataFileType;
      let stat: Stats;
      try {
        type = dataFileType(readHead(real, 16));
        stat = statSync(real);
      } catch {
        // Outlook holds its files open with no sharing. An .ost it holds is still an .ost.
        refuse(namedOst ? 'ost' : 'in-use');
        continue;
      }
      if (namedOst || type === 'ost') {
        refuse('ost');
        continue;
      }
      if (type !== 'pst') continue;
      result.files.push({
        path: real,
        root,
        app: 'outlook',
        kind: 'pst',
        group: 'Outlook',
        folder: [],
        name: `Outlook/${entry.name}`,
        size: stat.size,
        lastModified: stat.mtimeMs,
      });
    }
  }
}

/** A network path can take minutes to say it isn't there. */
function isNetworkPath(file: string): boolean {
  return /^(\\\\|\/\/)/.test(file);
}

/**
 * `onProgress` hears what's found so far after each profile and after the Outlook files, so a
 * path that never answers only costs what comes after it. Network paths come last for that.
 */
export function scanForMailData(env: ScanEnv, onProgress?: (soFar: ScanResult, onlyNetworkLeft: boolean) => void): ScanResult {
  const result: ScanResult = { files: [], books: [], refused: [], calendars: 0, profiles: [], running: false };
  const profiles: IniProfile[] = [];
  for (const home of thunderbirdHomes(env)) {
    try {
      profiles.push(...parseProfilesIni(readFileSync(path.join(home, 'profiles.ini'), 'utf8'), home));
    } catch {
      // No Thunderbird here.
    }
  }
  const scanOne = (profile: IniProfile) => {
    try {
      scanProfile(profile, result);
    } catch {
      // One unreadable profile doesn't take the others with it.
    }
    onProgress?.(result, false);
  };
  profiles.filter((profile) => !isNetworkPath(profile.path)).forEach(scanOne);
  scanOutlook(env, result);
  const far = profiles.filter((profile) => isNetworkPath(profile.path));
  onProgress?.(result, far.length > 0);
  far.forEach(scanOne);
  return result;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether Thunderbird has this profile open.
 * - Windows: it holds parent.lock with no sharing and removes it on exit.
 * - Linux: `lock` is a dangling symbolic link to `<ip>:+<pid>`.
 * - macOS: .parentlock stays after a clean exit and its lock isn't visible from here, so
 *   thunderbirdProcessRunning asks pgrep instead.
 */
export function profileInUse(profile: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    const lock = path.join(profile, 'parent.lock');
    if (!existsSync(lock)) return false;
    try {
      closeSync(openSync(lock, 'r+'));
      return false;
    } catch {
      return true;
    }
  }
  if (platform === 'linux') {
    try {
      const pid = Number(/\+(\d+)$/.exec(readlinkSync(path.join(profile, 'lock')))?.[1]);
      return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
    } catch {
      return false;
    }
  }
  return false;
}

function thunderbirdProcessRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    // Full path: a launch folder must not choose what runs.
    execFile('/usr/bin/pgrep', ['-x', 'thunderbird'], (error) => resolve(!error));
  });
}

export async function thunderbirdRunning(profiles: string[], platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === 'darwin') return profiles.length > 0 && thunderbirdProcessRunning();
  return profiles.some((profile) => profileInUse(profile, platform));
}
