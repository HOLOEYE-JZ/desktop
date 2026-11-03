/**
 * The crash files on this computer: where they are, how many stay, and what's done to one
 * before it leaves. Node only, so a test can load it.
 *
 * A minidump is part of the app's memory at the moment of the crash, so it can hold open
 * mail. The consent text says that. `scrubMinidump` takes out what it can find, in place
 * and at the same length, so the file's structure still holds. It can't promise more.
 */

import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export interface CrashLimits {
  count: number;
  bytes: number;
  ageMs: number;
}

export const CRASH_LIMITS: CrashLimits = { count: 10, bytes: 64 * 1024 * 1024, ageMs: 30 * 24 * 60 * 60_000 };

export interface CrashFile {
  id: string;
  file: string;
  createdAt: number;
  bytes: number;
}

/** Windows keeps reports in `reports`, macOS and Linux move them from `new` on. */
const DUMP_FOLDERS = ['reports', 'completed', 'pending', 'new'];
const ID = /^[\w-]{1,128}$/;

/** Newest first. */
export function listCrashFiles(dir: string): CrashFile[] {
  const found: CrashFile[] = [];
  for (const folder of DUMP_FOLDERS) {
    let names: string[];
    try {
      names = readdirSync(path.join(dir, folder));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.dmp')) continue;
      const id = name.slice(0, -'.dmp'.length);
      if (!ID.test(id)) continue;
      const file = path.join(dir, folder, name);
      try {
        const facts = statSync(file);
        if (facts.isFile()) found.push({ id, file, createdAt: facts.mtimeMs, bytes: facts.size });
      } catch {
        // Gone since the listing.
      }
    }
  }
  return found.sort((a, b) => b.createdAt - a.createdAt);
}

function removeCrash(dir: string, crash: CrashFile): void {
  rmSync(crash.file, { force: true });
  rmSync(path.join(dir, 'attachments', crash.id), { recursive: true, force: true });
}

/** Keeps the newest within the limits and removes the rest. Returns how many went. */
export function sweepCrashFiles(dir: string, limits: CrashLimits = CRASH_LIMITS, now = Date.now()): number {
  let kept = 0;
  let keptBytes = 0;
  let removed = 0;
  for (const crash of listCrashFiles(dir)) {
    const stays = kept < limits.count && keptBytes + crash.bytes <= limits.bytes && now - crash.createdAt <= limits.ageMs;
    if (stays) {
      kept += 1;
      keptBytes += crash.bytes;
      continue;
    }
    try {
      removeCrash(dir, crash);
      removed += 1;
    } catch (error) {
      // Still being written, or held by the crash handler. The next sweep gets it.
      console.warn('A crash file could not be removed:', error);
    }
  }
  return removed;
}

/** Consent taken back, a policy, a wipe: none stay. */
export function removeAllCrashFiles(dir: string): void {
  for (const crash of listCrashFiles(dir)) {
    try {
      removeCrash(dir, crash);
    } catch (error) {
      console.warn('A crash file could not be removed:', error);
    }
  }
}

/** Where crash files may go: https, or http that stays on this computer. No sign-in in the address. */
export function validUploadUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return null;
    if (url.protocol === 'https:') return url.toString();
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return url.protocol === 'http:' && local ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Over bytes as Latin-1, one character a byte, so a replacement can't move anything. */
const blank = (match: string) => match.replace(/[^\0]/g, 'x');

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** A pattern as it looks in UTF-16LE: a zero byte after each character. */
function wide(source: string): string {
  // \\x00, as a digit after \\0 would read as an octal escape.
  return [...source].map((char) => `${escapeForRegex(char)}\\x00`).join('');
}

const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g;
const EMAIL_WIDE = /(?:[\w.+-]\0){1,64}@\0(?:[\w-]\0){1,63}(?:\.\0(?:[\w-]\0){1,63})+/g;
const AUTH = /\b(?:Bearer|Basic|Token)\s[^\s\0,;"']{4,}/gi;
const AUTH_WIDE = new RegExp(`(?:${['Bearer', 'Basic', 'Token'].map(wide).join('|')})\\s\\x00(?:[^\\s\\0,;"']\\x00){4,}`, 'gi');
const LONG_RUN = /[A-Za-z0-9+/_=-]{32,}/g;
const LONG_RUN_WIDE = /(?:[A-Za-z0-9+/_=-]\0){32,}/g;
/** Raw mail, and JMAP's fields as JSON, as far as they sit in memory in one piece. */
const MAIL_HEADER = /\b(?:Subject|From|To|Cc|Bcc|Reply-To|Authorization|Cookie|Set-Cookie):[^\r\n\0]{1,2000}/gi;
const MAIL_HEADER_WIDE = new RegExp(`(?:${['Subject', 'From', 'To', 'Cc', 'Bcc', 'Reply-To', 'Authorization', 'Cookie', 'Set-Cookie'].map(wide).join('|')}):\\x00(?:[^\\r\\n\\0]\\x00){1,2000}`, 'gi');
const MAIL_JSON = /"(?:subject|preview|value|name|email|htmlBody|textBody|bodyValues|password|token|accessToken|refreshToken)"\s*:\s*"(?:[^"\\\0]|\\.){0,8192}"/g;
const MAIL_JSON_WIDE = /"\0(?:s\0u\0b\0j\0e\0c\0t\0|p\0r\0e\0v\0i\0e\0w\0|v\0a\0l\0u\0e\0|e\0m\0a\0i\0l\0)"\0\s?\0?:\0\s?\0?"\0(?:[^"]\0|[^\0]\0){0,8192}"\0/g;

export interface ScrubNames {
  home: string;
  username: string;
  hostname: string;
}

/**
 * Takes the user's name and home folder, the computer's name, addresses, tokens and
 * anything that looks like mail out of a crash file's bytes. Same length, so offsets in
 * the file stay right. Only a copy changes: `bytes` is left as it is.
 */
export function scrubMinidump(bytes: Buffer, names: ScrubNames): Buffer {
  let text = bytes.toString('latin1');
  const needles = [names.home, names.home.replace(/\\/g, '/'), names.home.replace(/\\/g, '\\\\'), names.username, names.hostname];
  for (const needle of needles) {
    // A two-letter name would blank half the file, and tell nobody anything.
    if (!needle || needle.length < 3) continue;
    const pattern = `${escapeForRegex(needle)}|${wide(needle)}`;
    text = text.replace(new RegExp(pattern, 'gi'), blank);
  }
  for (const pattern of [MAIL_HEADER, MAIL_HEADER_WIDE, MAIL_JSON, MAIL_JSON_WIDE, AUTH, AUTH_WIDE, EMAIL, EMAIL_WIDE, LONG_RUN, LONG_RUN_WIDE]) {
    text = text.replace(pattern, blank);
  }
  return Buffer.from(text, 'latin1');
}

export interface CrashUpload {
  contentType: string;
  body: Buffer;
}

/**
 * The form Breakpad's and Sentry's receivers take: the dump as `upload_file_minidump`, and
 * only these facts beside it. No file names, paths or ids of ours.
 */
export function buildCrashUpload(dump: Buffer, facts: { prod: string; ver: string; platform: string; build: string }, boundary: string): CrashUpload {
  const fields = Object.entries(facts)
    .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join('');
  const head = `${fields}--${boundary}\r\nContent-Disposition: form-data; name="upload_file_minidump"; filename="crash.dmp"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([Buffer.from(head, 'latin1'), dump, Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1')]),
  };
}
