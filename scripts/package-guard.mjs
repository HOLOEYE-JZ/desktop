// The last look at a package before it ships, run by after-pack.cjs. Fails on private
// files and links in the server tree, and on anything unknown next to it or in the
// asar. Removes Next's cache.
// Replaces the build machine's paths, which Next writes into its config and a few
// chunks: they mean nothing on a user's machine and name the developer. Warns if
// the home folder is still in there.

import { chmodSync, closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { APP_ICON_FILE, findAppIconProblems, findTaskIconProblems, TASK_ICON_FOLDER } from './task-icons.mjs';

const FORBIDDEN_DIRS = new Set(['data', 'local-data', 'repos']);
const FORBIDDEN_FILE = /^(\.env.*|plugin-signing\.key)$/i;
// A key is a key wherever it is. An `.env.example` in a package isn't a secret, and
// Next's own routes may be named `data`, but no other `.env` may be anywhere in a build.
const FORBIDDEN_DEEP = /^(\.env(?!\.(example|sample|template)$).*|plugin-signing\.key)$/i;
const TEXT_FILE = /\.(js|cjs|mjs|json|rsc|html|map|txt|css)$/;
const PLACEHOLDER = '/bulwark-build';
/** What node-gyp leaves beside a Windows addon. electron-builder.yml keeps it out. */
const BUILD_LEFTOVER = /\.(iobj|ipdb|lib|exp|tlog|vcxproj)$/i;

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    yield { full: path.join(dir, entry.name), entry };
    if (entry.isDirectory()) yield* walk(path.join(dir, entry.name));
  }
}

/** Private files and links, as paths relative to the tree. */
export function findProblems(tree) {
  const problems = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = toPosix(path.relative(tree, full));
      if (lstatSync(full).isSymbolicLink()) {
        problems.push(`${relative} (link)`);
      } else if (entry.isDirectory()) {
        // Packages may hold anything, and .next/server has routes named after data.
        if (FORBIDDEN_DIRS.has(entry.name.toLowerCase())) problems.push(`${relative}/`);
        else if (entry.name === '.next' || entry.name === 'node_modules') visitLinksOnly(full);
        else visit(full);
      } else if (FORBIDDEN_FILE.test(entry.name)) {
        problems.push(relative);
      }
    }
  };
  const visitLinksOnly = (dir) => {
    for (const { full, entry } of walk(dir)) {
      if (lstatSync(full).isSymbolicLink()) problems.push(`${toPosix(path.relative(tree, full))} (link)`);
      else if (entry.isFile() && FORBIDDEN_DEEP.test(entry.name)) problems.push(toPosix(path.relative(tree, full)));
    }
  };
  visit(tree);
  return problems.sort();
}

/** Every spelling of a path as it lands in compiled code. */
function spellings(root) {
  const forward = root.split('\\').join('/');
  const back = forward.split('/').join('\\');
  const doubled = back.split('\\').join('\\\\');
  // Twice escaped: a JSON string inside a JS string.
  const quadrupled = doubled.split('\\').join('\\\\');
  const plain = [quadrupled, doubled, back, forward];
  // In a URL, as a whole value and as a path.
  const encoded = [encodeURIComponent(back), encodeURIComponent(forward), encodeURI(forward)];
  return [...new Set([...plain, ...encoded])].filter((value) => value.length > 3);
}

function replaceAll(text, from, to) {
  return text.split(from).join(to);
}

/**
 * The tracing root and repo root a build recorded, and anything under the given
 * extra roots. Returns how many files changed.
 */
export function scrubPaths(tree, extraRoots = []) {
  const roots = [...extraRoots];
  try {
    const { config } = JSON.parse(readFileSync(path.join(tree, '.next', 'required-server-files.json'), 'utf8'));
    for (const value of [config?.outputFileTracingRoot, config?.turbopack?.root]) if (typeof value === 'string' && value) roots.push(value);
  } catch {
    // No such file, nothing recorded.
  }
  const needles = [...new Set(roots.flatMap(spellings))].sort((a, b) => b.length - a.length);
  if (needles.length === 0) return 0;
  let changed = 0;
  for (const { full, entry } of walk(tree)) {
    if (!entry.isFile() || !TEXT_FILE.test(entry.name) || toPosix(full).includes('/node_modules/')) continue;
    const before = readFileSync(full, 'latin1');
    if (!needles.some((needle) => before.includes(needle))) continue;
    let after = before;
    for (const needle of needles) after = replaceAll(after, needle, PLACEHOLDER);
    writeFileSync(full, after, 'latin1');
    changed += 1;
  }
  return changed;
}

/** Files that still name this home folder. Only a warning: CI's has no meaning either. */
export function findHomePaths(tree, home = homedir()) {
  const needles = spellings(home);
  const found = [];
  for (const { full, entry } of walk(tree)) {
    if (!entry.isFile() || !TEXT_FILE.test(entry.name) || toPosix(full).includes('/node_modules/')) continue;
    const text = readFileSync(full, 'latin1');
    if (needles.some((needle) => text.includes(needle))) found.push(toPosix(path.relative(tree, full)));
  }
  return found;
}

/** The paths in an asar, from its header: 16 bytes of pickle, then JSON. */
export function asarFiles(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const length = head.readUInt32LE(12);
    const json = Buffer.alloc(length);
    readSync(fd, json, 0, length, 16);
    const found = [];
    const visit = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        if (child.files) visit(child, `${prefix}${name}/`);
        // A link inside an asar can point anywhere in it, and the loader follows it.
        else found.push(child.link ? `${prefix}${name} (link)` : `${prefix}${name}`);
      }
    };
    visit(JSON.parse(json.toString('utf8')), '');
    return found;
  } finally {
    closeSync(fd);
  }
}

/**
 * The rest of resources/. app.asar holds the shell and nothing else, and only known
 * things sit next to it. This catches a config change that would sweep in the repo.
 */
export function findResourceProblems(resources, platform = process.platform) {
  const problems = [];
  const known = /^(app\.asar|app\.asar\.unpacked|server\.asar|server\.asar\.unpacked|policies|os-icons|app-update\.yml|bulwark-build\.json|package-type|apparmor-profile|LICENSE\.electron\.txt|LICENSES\.chromium\.html)$/;
  for (const name of readdirSync(resources)) {
    if (known.test(name)) continue;
    // What a real macOS package has beside these. Language folders hold at most Electron's own file.
    const lproj = platform === 'darwin' && /^[\w-]+\.lproj$/.test(name);
    if (platform === 'darwin' && name === 'icon.icns') continue;
    if (!lproj) {
      problems.push(`resources/${name}`);
      continue;
    }
    for (const inside of readdirSync(path.join(resources, name))) if (inside !== 'locale.pak') problems.push(`resources/${name}/${inside}`);
  }
  // These hold no webmail state and no secrets, whatever a config change sweeps in.
  for (const name of ['app.asar.unpacked', 'server.asar.unpacked', 'policies']) {
    const tree = path.join(resources, name);
    if (existsSync(tree)) problems.push(...findProblems(tree).map((problem) => `${name}/${problem}`));
  }
  // The jump list's icons and the app's, and nothing else.
  const icons = path.join(resources, TASK_ICON_FOLDER);
  if (existsSync(icons)) {
    for (const { full, entry } of walk(icons)) {
      const known = /^task-[a-z]+-(light|dark)\.ico$/.test(entry.name) || entry.name === APP_ICON_FILE;
      if (!entry.isFile() || !known || path.dirname(full) !== icons) problems.push(`${TASK_ICON_FOLDER}/${toPosix(path.relative(icons, full))}`);
    }
  }
  const unpacked = path.join(resources, 'app.asar.unpacked');
  if (existsSync(unpacked)) {
    for (const { full, entry } of walk(unpacked)) {
      if (BUILD_LEFTOVER.test(entry.name)) problems.push(`app.asar.unpacked/${toPosix(path.relative(unpacked, full))}`);
    }
  }
  const asar = path.join(resources, 'app.asar');
  if (existsSync(asar)) {
    for (const file of asarFiles(asar)) {
      const allowed = file === 'package.json' || file.startsWith('dist/') || file.startsWith('node_modules/') || file === 'native/bulwark-native.node';
      const name = file.split('/').pop();
      if (!allowed || file.endsWith(' (link)') || FORBIDDEN_DEEP.test(name)) problems.push(`app.asar/${file}`);
    }
  }
  const server = path.join(resources, 'server.asar');
  if (existsSync(server)) {
    // Checked before packing too (guardPackage). This is what actually shipped.
    for (const file of asarFiles(server)) {
      if (file.endsWith(' (link)') || FORBIDDEN_DEEP.test(file.split('/').pop())) problems.push(`server.asar/${file}`);
    }
  }
  return problems.sort();
}

/**
 * Files others can change, or that are setuid or setgid, as `path (mode)`. Windows has no such
 * modes: everything reads 0666 there. Links read 0777 everywhere and mean nothing.
 */
export function findLooseModes(tree, { stat = lstatSync, platform = process.platform } = {}) {
  if (platform === 'win32') return [];
  const found = [];
  for (const { full } of walk(tree)) {
    const info = stat(full);
    if (info.isSymbolicLink()) continue;
    const mode = info.mode & 0o7777;
    if (mode & 0o6022) found.push(`${toPosix(path.relative(tree, full))} (${mode.toString(8).padStart(4, '0')})`);
  }
  return found.sort();
}

/**
 * `chmod -R go-w`. electron-builder's zip extraction applies the modes stored in Electron's zip
 * with chmod, past the umask, and those are 0777 and 0666 (app-builder-lib's electronGet.js).
 */
export function tightenModes(tree) {
  if (process.platform === 'win32') return;
  for (const { full } of walk(tree)) {
    const info = lstatSync(full);
    if (!info.isSymbolicLink() && info.mode & 0o022) chmodSync(full, info.mode & 0o7777 & ~0o022);
  }
}

export function guardModes(tree, options) {
  const found = findLooseModes(tree, options);
  if (found.length > 0) throw new Error(`Do not ship this package, others can change these files:\n  ${found.slice(0, 30).join('\n  ')}`);
}

/** Nothing but Electron's own files goes next to the exe (`extraFiles`, a stray config). */
export function guardExtraFiles(appOutDir) {
  const found = [];
  for (const { full, entry } of walk(appOutDir)) {
    if (entry.isFile() && FORBIDDEN_DEEP.test(entry.name)) found.push(toPosix(path.relative(appOutDir, full)));
  }
  if (found.length > 0) throw new Error(`Do not ship this package:\n  ${found.slice(0, 30).join('\n  ')}`);
}

/** Windows Hello and the keystore there, and on macOS the check for forced preferences. */
export function findHelperProblem(asarListing, platform) {
  if (platform !== 'win32' && platform !== 'darwin') return null;
  return asarListing.includes('native/bulwark-native.node') ? null : 'app.asar has no native/bulwark-native.node';
}

export function guardHelper(resources, platform) {
  const problem = findHelperProblem(asarFiles(path.join(resources, 'app.asar')), platform);
  if (problem) throw new Error(`Do not ship this package:\n  ${problem}`);
}

/**
 * Windows reads the jump list's icons and the Files drive's itself, from resources/os-icons:
 * each has to be there, a real .ico, with every size from 100% to 300% scale.
 */
export function findPackagedTaskIconProblems(resources, platform) {
  if (platform !== 'win32') return [];
  const dir = path.join(resources, TASK_ICON_FOLDER);
  return [...findTaskIconProblems(dir), ...findAppIconProblems(dir)].map((problem) => `resources/${TASK_ICON_FOLDER}/${problem}`);
}

export function guardResources(resources, platform) {
  const problems = [...findResourceProblems(resources, platform), ...findPackagedTaskIconProblems(resources, platform)];
  if (problems.length > 0) throw new Error(`Do not ship this package:\n  ${problems.slice(0, 30).join('\n  ')}`);
}

/** Throws if the tree can't ship. Cleans what it can. */
export function guardPackage(tree, { warn = console.warn } = {}) {
  rmSync(path.join(tree, '.next', 'cache'), { recursive: true, force: true });
  const problems = findProblems(tree);
  if (problems.length > 0) throw new Error(`Do not ship this package:\n  ${problems.slice(0, 30).join('\n  ')}`);
  scrubPaths(tree);
  const home = findHomePaths(tree);
  if (home.length > 0) warn(`[package-guard] ${home.length} files still name ${homedir()}: ${home.slice(0, 5).join(', ')}`);
  return { homePaths: home };
}
