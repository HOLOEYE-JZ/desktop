#!/usr/bin/env node
// Copies a webmail build into ./webmail, the tree the app embeds.
//
//   node scripts/fetch-webmail.mjs --path <webmail checkout with .next/standalone>
//   node scripts/fetch-webmail.mjs --tag <webmail tag>     (a release: clone, npm ci, build)
//   node scripts/fetch-webmail.mjs --ref <branch or tag>   (a beta: the same)
//     with --commit <sha> to build what `--resolve` said earlier, however far it has moved
//   node scripts/fetch-webmail.mjs --resolve <tag|ref> <name>  prints the commit, or fails
//   node scripts/fetch-webmail.mjs --native win32-arm64,...  (sharp's binaries for more
//     targets: on top of either of the above, or alone on a tree already here)
//
// Next puts a standalone tree under its tracing root, so a worktree whose
// node_modules is a junction elsewhere gets server.js and node_modules in two
// different folders. This finds server.js, flattens every node_modules the trace
// produced next to it, adds .next/static and public (standalone leaves them out),
// and runs the webmail's own guard over the result. It copies only what the
// trace named, so a developer's data/ can't come along; the guard fails if
// anything like it did.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addNativePlatforms } from './server-natives.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBMAIL_REPO = process.env.BULWARK_WEBMAIL_REPO || 'https://github.com/bulwarkmail/webmail.git';
const TRUST_MARKER = 'bulwark.desktop.trustedJmapOrigins';

function fail(message) {
  console.error(`[fetch-webmail] ${message}`);
  process.exit(1);
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed`);
}

/** The folder holding server.js, nearest the top of the tree. */
export function findServerRoot(standalone) {
  const queue = [standalone];
  while (queue.length) {
    const dir = queue.shift();
    if (existsSync(path.join(dir, 'server.js'))) return dir;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.next') queue.push(path.join(dir, entry.name));
    }
  }
  return null;
}

/** Every top-level node_modules in the tree. Not the ones inside other packages. */
export function findNodeModules(standalone) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.next') continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'node_modules') found.push(full);
      else visit(full);
    }
  };
  visit(standalone);
  return found;
}

export function findLinks(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (lstatSync(full).isSymbolicLink()) found.push(full);
    else if (entry.isDirectory()) findLinks(full, found);
  }
  return found;
}

/**
 * The commit a tag, or for `ref` also a branch, names in that repo. Null if it doesn't. A
 * name git could take for a flag, or that's no plain ref, isn't asked about at all.
 */
export function remoteCommit(repo, kind, name) {
  if (!/^[0-9A-Za-z][0-9A-Za-z._/-]*$/.test(name) || name.includes('..')) return null;
  const refs = kind === 'tag' ? [`refs/tags/${name}`] : [`refs/heads/${name}`, `refs/tags/${name}`];
  const listed = spawnSync('git', ['ls-remote', repo, ...refs, ...refs.map((ref) => `${ref}^{}`)], { encoding: 'utf8' });
  if (listed.status !== 0) return null;
  const lines = listed.stdout.split('\n').filter(Boolean).map((line) => line.split('\t'));
  // An annotated tag lists its own object and, with ^{}, the commit.
  const line = lines.find(([, ref]) => ref.endsWith('^{}')) ?? lines[0];
  return line ? line[0] : null;
}

/** Fetches that one commit, checks that's what arrived, builds and copies it. */
async function fromRemote(kind, name, destination, wanted) {
  if (wanted && !/^[0-9a-f]{40}$/.test(wanted)) fail(`${wanted} is not a commit`);
  const commit = wanted ?? remoteCommit(WEBMAIL_REPO, kind, name);
  // A clear message, not git's, for the likely mistake: a tag that isn't out yet.
  if (!commit) {
    fail(
      kind === 'tag'
        ? `the webmail has no tag ${name}. Set config.webmailTag in package.json to the first tag that has build:desktop, or wait for that release.`
        : `the webmail has no branch or tag ${name}.`,
    );
  }
  const work = mkdtempSync(path.join(tmpdir(), 'bulwark-webmail-'));
  run('git', ['-C', work, 'init', '-q']);
  run('git', ['-C', work, 'remote', 'add', 'origin', WEBMAIL_REPO]);
  run('git', ['-C', work, 'fetch', '-q', '--depth', '1', 'origin', commit]);
  run('git', ['-C', work, 'checkout', '-q', 'FETCH_HEAD']);
  const arrived = spawnSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const origin = spawnSync('git', ['-C', work, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.trim();
  if (arrived !== commit || origin !== WEBMAIL_REPO) fail(`${name} from ${WEBMAIL_REPO} should be ${commit}, but the clone is ${arrived} from ${origin}. Try again if it has just moved.`);
  console.log(`[fetch-webmail] ${WEBMAIL_REPO} ${name} at ${commit}`);
  run('npm', ['ci'], { cwd: work });
  // Shows in the app's About card, so a beta can be traced.
  run('npm', ['run', 'build:desktop'], { cwd: work, env: { ...process.env, GIT_COMMIT: commit } });
  await fromPath(work, destination, commit);
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

function isInside(file, dir) {
  const relative = path.relative(dir, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Next compiles NEXT_PUBLIC_* from a checkout's .env files into the client, where they
 * ship. On a developer's machine that's their settings. Names only, never the values.
 */
export function publicEnvKeys(source) {
  const found = [];
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\.env/i.test(entry.name) || /\.(example|sample|template)$/i.test(entry.name)) continue;
    for (const line of readFileSync(path.join(source, entry.name), 'utf8').split(/\r?\n/)) {
      const key = /^\s*(?:export\s+)?(NEXT_PUBLIC_[A-Z0-9_]+)\s*=/.exec(line)?.[1];
      if (key) found.push(`${entry.name}: ${key}`);
    }
  }
  return found;
}

function warnAboutEnvFiles(source) {
  const keys = publicEnvKeys(source);
  if (keys.length > 0) console.warn(`[fetch-webmail] these are compiled into this build, from your own env files. A release builds from a tag, without them:\n  ${keys.join('\n  ')}`);
}

function copyMissing(from, to) {
  // Package by package, first one wins. `--parents`-style nesting stays intact.
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      copyMissing(source, target);
    } else if (!existsSync(target)) {
      cpSync(realpathSync(source), target, { recursive: true, dereference: true });
    }
  }
}

function containsMarker(dir, marker) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (containsMarker(full, marker)) return true;
    } else if (entry.name.endsWith('.js') && readFileSync(full, 'utf8').includes(marker)) {
      return true;
    }
  }
  return false;
}

async function fromPath(source, destination, commit) {
  const standalone = path.join(source, '.next', 'standalone');
  if (!existsSync(standalone)) fail(`${standalone} does not exist. Build it with: npm run build:desktop`);

  const serverRoot = findServerRoot(standalone);
  if (!serverRoot) fail(`no server.js under ${standalone}`);

  // `dereference` below would copy what a link points at, and then the guard sees plain
  // files. So links are looked at here, before anything's copied.
  const serverModules = path.join(serverRoot, 'node_modules');
  const links = [
    ...findLinks(serverRoot).filter((link) => path.resolve(link) !== path.resolve(serverModules) && !isInside(link, serverModules)),
    ...findLinks(path.join(source, 'public')),
  ];
  if (links.length > 0) fail(`links in the build could carry anything along: ${links.slice(0, 5).join(', ')}`);
  warnAboutEnvFiles(source);

  rmSync(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  mkdirSync(destination, { recursive: true });
  // A link at serverRoot/node_modules points at the developer's whole node_modules,
  // on this machine. Only the real folders in the tree are what the trace chose.
  cpSync(serverRoot, destination, { recursive: true, dereference: true, filter: (from) => path.resolve(from) !== path.resolve(serverModules) });
  const moduleDirs = findNodeModules(standalone);
  if (moduleDirs.length === 0) fail(`no node_modules under ${standalone}`);
  for (const modules of moduleDirs) copyMissing(modules, path.join(destination, 'node_modules'));

  // The policy templates IT deploys, generated in the webmail. Shipped in the package.
  const policies = path.join(source, 'desktop-policies');
  if (existsSync(policies)) {
    rmSync(path.join(ROOT, 'policies'), { recursive: true, force: true });
    cpSync(policies, path.join(ROOT, 'policies'), { recursive: true });
  }

  // Not part of standalone.
  cpSync(path.join(source, '.next', 'static'), path.join(destination, '.next', 'static'), { recursive: true });
  cpSync(path.join(source, 'public'), path.join(destination, 'public'), { recursive: true, dereference: true });
  rmSync(path.join(destination, '.next', 'cache'), { recursive: true, force: true });

  if (!existsSync(path.join(destination, 'node_modules', 'next', 'package.json'))) fail('next is missing from the flattened tree');
  const leftLinks = findLinks(destination);
  if (leftLinks.length > 0) fail(`links in the tree would point outside it on another machine: ${leftLinks.slice(0, 5).join(', ')}`);
  // Turbopack's externals are hashed links that don't survive moving (decision 3).
  if (existsSync(path.join(destination, '.next', 'node_modules'))) fail('this is a Turbopack build. Build it with: npm run build:desktop');
  if (!containsMarker(path.join(destination, '.next', 'server'), TRUST_MARKER)) {
    fail('this is not a desktop build: the trust path is missing. Build it with: npm run build:desktop');
  }

  // The webmail's own check. As a desktop build, the trust path is expected.
  const guard = path.join(source, 'scripts', 'standalone-guard.mjs');
  if (!existsSync(guard)) fail(`${guard} does not exist`);
  run(process.execPath, [guard, destination], { env: { ...process.env, NEXT_PUBLIC_BULWARK_DESKTOP: '1' }, shell: false });

  const pkg = JSON.parse(readFileSync(path.join(destination, 'package.json'), 'utf8'));
  writeFileSync(
    path.join(destination, 'desktop-build.json'),
    `${JSON.stringify({ version: pkg.version, source: path.basename(source), ...(commit ? { commit } : {}), buildId: readFileSync(path.join(destination, '.next', 'BUILD_ID'), 'utf8').trim() }, null, 2)}\n`,
  );
  const size = sizeOf(destination);
  console.log(`[fetch-webmail] ${destination}: ${Math.round(size / 1048576)} MB`);
}

function sizeOf(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? sizeOf(full) : statSync(full).size;
  }
  return total;
}

async function main() {
  const resolve = process.argv.indexOf('--resolve');
  if (resolve !== -1) {
    const commit = remoteCommit(WEBMAIL_REPO, process.argv[resolve + 1], process.argv[resolve + 2]);
    if (!commit) fail(`the webmail has no ${process.argv[resolve + 1]} ${process.argv[resolve + 2]}`);
    console.log(commit);
    return;
  }
  const destination = path.resolve(option('out') ?? path.join(ROOT, 'webmail'));
  const source = option('path');
  const tag = option('tag');
  const ref = option('ref');
  const native = option('native');
  if ([source, tag, ref].filter(Boolean).length > 1) fail('one of --path, --tag and --ref');
  if (source) await fromPath(path.resolve(source), destination);
  if (tag) await fromRemote('tag', tag, destination, option('commit'));
  if (ref) await fromRemote('ref', ref, destination, option('commit'));
  if (native) {
    for (const added of addNativePlatforms(destination, native.split(','))) console.log(`[fetch-webmail] added ${added}`);
  }
  if (!source && !tag && !ref && !native) fail('usage: fetch-webmail.mjs --path <webmail checkout> | --tag <tag> | --ref <branch or tag> [--native <targets>] [--out <dir>]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
