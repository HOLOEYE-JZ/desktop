// Reads the file modes back out of the finished packages and fails if another user could change
// a file, or if one is stored setuid. after-pack.cjs fixes and checks the tree, but fpm and the
// others still run after it, so this looks at what actually ships.
//
//   node scripts/verify-package-modes.mjs release
//
// Takes .deb (needs dpkg-deb and tar), .rpm (rpm), .AppImage (unsquashfs) and a macOS .zip.

import { closeSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Writable by the group or by anyone, or setuid or setgid. */
const BAD_BITS = 0o6022;
const LISTING_LIMIT = 1024 * 1024 * 256;

/** What should be there, so an empty or misread listing can't pass. */
const REQUIRED = {
  deb: { suffix: 'opt/Bulwark/chrome-sandbox', mode: 0o755 },
  rpm: { suffix: 'opt/Bulwark/chrome-sandbox', mode: 0o755 },
  appimage: { suffix: '/chrome-sandbox', mode: 0o755 },
  zip: { suffix: '.app/Contents/MacOS/Bulwark', mode: 0o755 },
};

function modeFromLetters(letters) {
  const triple = (r, w, x, special) => (r === 'r' ? 4 : 0) + (w === 'w' ? 2 : 0) + (x === '-' || x === special.toUpperCase() ? 0 : 1);
  let mode = (triple(letters[0], letters[1], letters[2], 's') << 6) | (triple(letters[3], letters[4], letters[5], 's') << 3) | triple(letters[6], letters[7], letters[8], 't');
  if (/[sS]/.test(letters[2])) mode |= 0o4000;
  if (/[sS]/.test(letters[5])) mode |= 0o2000;
  if (/[tT]/.test(letters[8])) mode |= 0o1000;
  return mode;
}

/** `tar -tv` and `unsquashfs -lln` print the same columns. Other lines are their headers. */
export function parseListing(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([-dlhbcps])([-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT])\s.*?\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? (.+)$/.exec(line);
    if (!match) continue;
    const link = match[1] === 'l' || match[1] === 'h';
    entries.push({ path: match[3].split(' -> ')[0], mode: modeFromLetters(match[2]), link });
  }
  return entries;
}

/** Lines of `rpm -qp --qf '[%{FILEMODES:octal} %{FILENAMES}\n]'`. */
export function parseRpmModes(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-7]+) (.+)$/.exec(line);
    if (!match) continue;
    const full = Number.parseInt(match[1], 8);
    entries.push({ path: match[2], mode: full & 0o7777, link: (full & 0o170000) === 0o120000 });
  }
  return entries;
}

/** The modes in a zip's central directory, without a tool: this also runs on a Mac runner. */
export function zipEntries(file) {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const tailSize = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailSize);
    readSync(fd, tail, 0, tailSize, size - tailSize);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) throw new Error(`${file}: not a zip`);
    const count = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff) throw new Error(`${file}: zip64, which this can't read`);
    const directory = Buffer.alloc(length);
    readSync(fd, directory, 0, length, offset);
    const entries = [];
    for (let at = 0, i = 0; i < count; i += 1) {
      if (directory.readUInt32LE(at) !== 0x02014b50) throw new Error(`${file}: broken central directory`);
      const madeOnUnix = directory[at + 5] === 3;
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const unix = directory.readUInt32LE(at + 38) >>> 16;
      const name = directory.toString('utf8', at + 46, at + 46 + nameLength);
      // No Unix mode at all is a tool that changed, not a good file: it fails below.
      entries.push({ path: name, mode: madeOnUnix && unix ? unix & 0o7777 : 0o777, link: madeOnUnix && (unix & 0o170000) === 0o120000 });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/** Where an AppImage's squashfs starts: right after its ELF runtime. */
export function appImageOffset(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    readSync(fd, head, 0, 64, 0);
    if (head.toString('latin1', 0, 4) !== '\x7fELF' || head[4] !== 2 || head[5] !== 1) throw new Error(`${file}: not a 64-bit little-endian ELF`);
    return Number(head.readBigUInt64LE(40)) + head.readUInt16LE(58) * head.readUInt16LE(60);
  } finally {
    closeSync(fd);
  }
}

/** What's wrong with these entries, as lines to print. Links always read 0777, and mean nothing. */
export function findBadEntries(entries, required) {
  const problems = [];
  for (const entry of entries) {
    if (!entry.link && entry.mode & BAD_BITS) problems.push(`${entry.mode.toString(8).padStart(4, '0')} ${entry.path}`);
  }
  if (required) {
    const found = entries.find((entry) => !entry.link && entry.path.endsWith(required.suffix));
    if (!found) problems.push(`missing: ${required.suffix}`);
    else if (found.mode !== required.mode) problems.push(`${found.mode.toString(8).padStart(4, '0')} ${found.path}: should be ${required.mode.toString(8)}`);
  }
  return problems;
}

function run(command, args, input) {
  const done = spawnSync(command, args, { input, encoding: input === undefined ? 'utf8' : 'utf8', maxBuffer: LISTING_LIMIT });
  if (done.error) throw new Error(`${command}: ${done.error.message}`);
  if (done.status !== 0) throw new Error(`${command} exited ${done.status}: ${String(done.stderr).slice(0, 300)}`);
  return done.stdout;
}

function readDeb(file) {
  // dpkg-deb decompresses the data.tar, whichever compression it has, and tar lists it.
  const done = spawnSync('sh', ['-c', 'dpkg-deb --fsys-tarfile "$1" | tar -tv', 'sh', file], { encoding: 'utf8', maxBuffer: LISTING_LIMIT });
  if (done.error) throw new Error(done.error.message);
  if (done.status !== 0) throw new Error(`reading ${file} failed: ${done.stderr.slice(0, 300)}`);
  return parseListing(done.stdout);
}

const READERS = {
  '.deb': { kind: 'deb', read: readDeb },
  '.rpm': { kind: 'rpm', read: (file) => parseRpmModes(run('rpm', ['-qp', '--nosignature', '--qf', '[%{FILEMODES:octal} %{FILENAMES}\n]', file])) },
  '.appimage': { kind: 'appimage', read: (file) => parseListing(run('unsquashfs', ['-lln', '-o', String(appImageOffset(file)), file])) },
  '.zip': { kind: 'zip', read: zipEntries },
};

/** One package's problems. */
export function verifyPackage(file) {
  const reader = READERS[path.extname(file).toLowerCase()];
  if (!reader) throw new Error(`${file}: no reader for this kind of package`);
  return findBadEntries(reader.read(file), REQUIRED[reader.kind]);
}

function main(dir) {
  const files = readdirSync(dir)
    .filter((name) => READERS[path.extname(name).toLowerCase()])
    .map((name) => path.join(dir, name));
  if (files.length === 0) {
    console.error(`No packages in ${dir}`);
    return 1;
  }
  let failed = false;
  for (const file of files) {
    const problems = verifyPackage(file);
    if (problems.length === 0) {
      console.log(`ok ${path.basename(file)}`);
      continue;
    }
    failed = true;
    console.error(`${path.basename(file)}: ${problems.length} bad modes\n  ${problems.slice(0, 60).join('\n  ')}`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv[2] ?? 'release');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
