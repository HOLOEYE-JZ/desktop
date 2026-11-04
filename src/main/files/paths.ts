/**
 * Paths under a files root, and which folders may become one. No Electron and no disk here,
 * so the rules can be tested on their own.
 *
 * The page names a file by a path relative to its root, `/` between parts. Main builds the
 * absolute path from the root's directory and those parts, and disk.ts then checks with
 * realpath that nothing on the way is a link or a junction.
 */

import path from 'node:path';
import type { FilesError } from '../../shared/bridge';

/** Main's own temporary files start with this, and scans and the watcher never report them. */
export const TEMP_PREFIX = '.bulwark-sync-';

export function isTempName(name: string): boolean {
  return name.startsWith(TEMP_PREFIX);
}

/**
 * Files a program keeps next to a document while it's open: Office's `~$` owner files and
 * `~WRL…tmp` save files, LibreOffice's `.~lock.…#`. The watcher doesn't wake the page for
 * them alone. Scans still list them: what to sync is the page's call.
 */
export function isLockFileName(name: string): boolean {
  return name.startsWith('~$') || /^~WRL\d+\.tmp$/i.test(name) || /^\.~lock\..*#$/.test(name);
}

const WINDOWS_FORBIDDEN = /[<>:"\\|?*\u0000-\u001f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;
const MAX_PART = 255;
const MAX_PARTS = 256;

export type PathCheck = { ok: true; parts: string[] } | { ok: false; error: FilesError };

/**
 * Splits a root-relative path. `''` is the root itself, allowed only where `allowRoot` says.
 * `..`, `.`, an empty part or a leading `/` would leave or blur the root: `outside`. A name the
 * disk can't hold: `name`. Main's own temporary names are refused too, so the page can't
 * reach a write in progress.
 */
export function splitRelative(relative: unknown, platform: NodeJS.Platform, allowRoot = false): PathCheck {
  if (typeof relative !== 'string') return { ok: false, error: 'name' };
  if (relative === '') return allowRoot ? { ok: true, parts: [] } : { ok: false, error: 'outside' };
  if (relative.startsWith('/') || /^[a-zA-Z]:/.test(relative) || relative.includes('\u0000')) return { ok: false, error: 'outside' };
  const parts = relative.split('/');
  if (parts.length > MAX_PARTS) return { ok: false, error: 'name' };
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return { ok: false, error: 'outside' };
    if (part.length > MAX_PART || isTempName(part)) return { ok: false, error: 'name' };
    if (platform === 'win32') {
      // A backslash would be a separator here, and `a\..\..` a way out.
      if (part.includes('\\')) return { ok: false, error: 'outside' };
      if (WINDOWS_FORBIDDEN.test(part) || /[. ]$/.test(part) || WINDOWS_RESERVED.test(part)) return { ok: false, error: 'name' };
    }
  }
  return { ok: true, parts };
}

/** Joins a checked relative path back for answers: `/` between parts, whatever the OS. */
export function joinRelative(parts: readonly string[]): string {
  return parts.join('/');
}

/** A path relative to a root, as the watcher or a scan sees it, in the page's form. */
export function toRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

/** Whether the disk treats names without regard to case: Windows, and macOS as it comes. */
export function caseInsensitive(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** For comparing paths: case folded where the disk ignores it, and one Unicode form on macOS. */
export function comparable(value: string, platform: NodeJS.Platform): string {
  const normal = platform === 'darwin' ? value.normalize('NFC') : value;
  return caseInsensitive(platform) ? normal.toLowerCase() : normal;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return comparable(p.resolve(a), platform) === comparable(p.resolve(b), platform);
}

/** `inner` is `outer` or below it. */
export function within(outer: string, inner: string, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const relative = p.relative(comparable(p.resolve(outer), platform), comparable(p.resolve(inner), platform));
  return relative === '' || (!relative.startsWith('..') && !p.isAbsolute(relative));
}

/** A network share, by its resolved path. A mapped drive letter resolves to its share. */
export function isNetworkPath(resolved: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && (resolved.startsWith('\\\\') || resolved.startsWith('//'));
}

/** Linux statfs `f_type` of network file systems: NFS, SMB, CIFS, SMB2, AFS, Ceph, 9P, Coda, NCP. */
const NETWORK_FS_TYPES = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x5346414f, 0x00c36400, 0x01021997, 0x73757245, 0x564c]);

export function isNetworkFsType(type: number, platform: NodeJS.Platform): boolean {
  return platform === 'linux' && NETWORK_FS_TYPES.has(type >>> 0);
}

export interface OverlapRules {
  platform: NodeJS.Platform;
  home: string;
  /** Folders nothing may be in or contain: the app's data, its install folder, the drive's parent. */
  appFolders: readonly string[];
  /** Folders that may not be picked, nor anything containing them, but what's inside is fine. */
  noContain: readonly string[];
  /** Folders whose whole tree is off limits: the OS's own. */
  system: readonly string[];
  /** Roots there already, both kinds. */
  roots: readonly string[];
}

/**
 * Why a folder (resolved) can't be a root, or null. Every refusal is `overlap` to the page;
 * the reason here is for tests and the log.
 */
export function overlapReason(folder: string, rules: OverlapRules): string | null {
  const { platform } = rules;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const resolved = p.resolve(folder);
  if (isNetworkPath(resolved, platform)) return 'network';
  // A whole volume: `C:\`, `/`, a mount's top.
  if (p.dirname(resolved) === resolved) return 'volume';
  if (within(resolved, rules.home, platform)) return 'home';
  for (const root of rules.roots) if (within(root, resolved, platform) || within(resolved, root, platform)) return 'root';
  for (const own of rules.appFolders) if (own && (within(own, resolved, platform) || within(resolved, own, platform))) return 'app';
  for (const system of rules.system) if (system && within(system, resolved, platform)) return 'system';
  for (const folderOf of rules.noContain) if (folderOf && within(resolved, folderOf, platform)) return 'system';
  return null;
}

/** The OS's own folders for `overlapReason`, from the environment this process has. */
export function systemFolders(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): { system: string[]; noContain: string[] } {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
    const drive = path.win32.parse(systemRoot).root || 'C:\\';
    const system = [systemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.ProgramData, path.win32.join(drive, 'Recovery'), path.win32.join(drive, '$Recycle.Bin'), path.win32.join(drive, 'System Volume Information')];
    // The profiles folder and the app data folders themselves: a root there would take in other people's or programs' files.
    const noContain = [path.win32.dirname(home), env.APPDATA, env.LOCALAPPDATA, path.win32.join(home, 'AppData'), env.PUBLIC];
    return { system: system.filter((value): value is string => !!value), noContain: noContain.filter((value): value is string => !!value) };
  }
  if (platform === 'darwin') {
    return {
      system: ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt', '/cores', '/dev', path.posix.join(home, 'Library')],
      noContain: ['/Users', '/Volumes'],
    };
  }
  return {
    system: ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/var', '/proc', '/sys', '/dev', '/boot', '/run', '/opt', '/snap', '/srv', '/root'],
    noContain: ['/home', '/media', '/mnt', '/tmp'],
  };
}
