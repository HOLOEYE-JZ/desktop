// The last look at a package before it ships, run by after-pack.cjs. Fails on private
// files and links in the server tree, and on anything unknown next to it or in the
// asar. Removes Next's cache.
// Replaces the build machine's paths, which Next writes into its config and a few
// chunks: they mean nothing on a user's machine and name the developer. Warns if
// the home folder is still in there.

import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const FORBIDDEN_DIRS = new Set(['data', 'local-data', 'repos']);
const FORBIDDEN_FILE = /^(\.env.*|plugin-signing\.key)$/;
// A key is a key wherever it is. An `.env.example` in a package isn't a secret, and
// Next's own routes may be named `data`, but nothing in a build may be called `.env`.
const FORBIDDEN_DEEP = /^(\.env(\.(local|production|development|test)(\.local)?)?|plugin-signing\.key)$/;
const TEXT_FILE = /\.(js|cjs|mjs|json|rsc|html|map|txt)$/;
const PLACEHOLDER = '/bulwark-build';

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
        if (FORBIDDEN_DIRS.has(entry.name)) problems.push(`${relative}/`);
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
  return [...new Set([back.split('\\').join('\\\\'), back, forward])].filter((value) => value.length > 3);
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
        else found.push(`${prefix}${name}`);
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
export function findResourceProblems(resources) {
  const problems = [];
  const known = /^(app\.asar|app\.asar\.unpacked|server|app-update\.yml|bulwark-build\.json|package-type|apparmor-profile|.*\.lproj|.*\.icns|.*\.nib|.*\.plist)$/;
  for (const name of readdirSync(resources)) if (!known.test(name)) problems.push(`resources/${name}`);
  const asar = path.join(resources, 'app.asar');
  if (existsSync(asar)) {
    for (const file of asarFiles(asar)) {
      const allowed = file === 'package.json' || file.startsWith('dist/') || file.startsWith('node_modules/');
      const name = file.split('/').pop();
      if (!allowed || FORBIDDEN_DEEP.test(name)) problems.push(`app.asar/${file}`);
    }
  }
  return problems.sort();
}

export function guardResources(resources) {
  const problems = findResourceProblems(resources);
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
