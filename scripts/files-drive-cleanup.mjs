// Removes what the Files drive tests may leave on a Windows machine after a crash: sync roots
// whose provider is `Bulwark Test <pid>`, the Explorer entries Windows made for them, drive
// letters `subst` points into a test folder, and the test folders. Touches nothing else: not the
// app's own `Bulwark` sync roots, not OneDrive, not anyone else's `subst`.
//
//   node scripts/files-drive-cleanup.mjs           list and remove
//   node scripts/files-drive-cleanup.mjs --list    list only
//
// Needs the native helper (npm run build:native): Windows only unregisters a sync root through
// its own API, and the registry key it keeps is the system's.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const MANAGER = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager';
const NAMESPACE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Desktop\\NameSpace';
const TEST_PROVIDER = /^Bulwark Test( \d+)?!/;
const TEST_FOLDER = /^bulwark-files-test-\d+$/i;
const listOnly = process.argv.includes('--list');

if (process.platform !== 'win32') {
  console.log('Nothing to do: the Files drive is Windows only.');
  process.exit(0);
}

function reg(args) {
  try {
    return { ok: true, out: execFileSync(path.join(SYSTEM32, 'reg.exe'), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
  } catch {
    return { ok: false, out: '' };
  }
}

/** reg prints full key names (HKEY_LOCAL_MACHINE\...), one per subkey. */
function subkeys(key) {
  const depth = key.split('\\').length + 1;
  return reg(['query', key]).out.split(/\r?\n/).filter((line) => /^HKEY_/.test(line) && line.split('\\').length === depth).map((line) => line.split('\\').pop());
}

function value(key, name) {
  const match = new RegExp(`^\\s+${name}\\s+REG_\\w+\\s+(.*)$`, 'm').exec(reg(['query', key, '/v', name]).out);
  return match ? match[1].trim() : null;
}

function substMappings() {
  const out = execFileSync(path.join(SYSTEM32, 'subst.exe'), { encoding: 'utf8' });
  return [...out.matchAll(/^([A-Z]):\\: => (.+)$/gim)].map((match) => ({ letter: match[1].toUpperCase(), target: match[2].trim() }));
}

function testFolder(target) {
  const relative = path.relative(tmpdir(), target);
  return !relative.startsWith('..') && !path.isAbsolute(relative) && TEST_FOLDER.test(relative.split(path.sep)[0]);
}

function loadHelper() {
  const file = path.join(ROOT, 'native', 'dist', `${process.platform}-${process.arch}`, 'bulwark-native.node');
  try {
    const helper = createRequire(import.meta.url)(file);
    return typeof helper.filesDriveUnregister === 'function' ? helper : null;
  } catch {
    return null;
  }
}

function find() {
  const roots = subkeys(MANAGER)
    .filter((id) => TEST_PROVIDER.test(id))
    .map((id) => ({ id, namespace: value(`${MANAGER}\\${id}`, 'NamespaceCLSID'), path: (reg(['query', `${MANAGER}\\${id}\\UserSyncRoots`]).out.match(/REG_SZ\s+(.*)$/m) ?? [])[1]?.trim() ?? '' }));
  // Explorer's entry for a sync root is named after it.
  const namespaces = subkeys(NAMESPACE).filter((clsid) => /Bulwark Test/.test(reg(['query', `${NAMESPACE}\\${clsid}`, '/ve']).out + reg(['query', `HKCU\\Software\\Classes\\CLSID\\${clsid}`, '/ve']).out));
  const letters = substMappings().filter((mapping) => testFolder(mapping.target));
  const folders = readdirSync(tmpdir()).filter((name) => TEST_FOLDER.test(name)).map((name) => path.join(tmpdir(), name));
  return { roots, namespaces, letters, folders };
}

function print(found, title) {
  console.log(title);
  console.log(`  sync roots: ${found.roots.length ? found.roots.map((root) => `${root.id} (${root.path || 'no folder'})`).join(', ') : 'none'}`);
  console.log(`  Explorer entries: ${found.namespaces.length ? found.namespaces.join(', ') : 'none'}`);
  console.log(`  drive letters: ${found.letters.length ? found.letters.map((mapping) => `${mapping.letter}: => ${mapping.target}`).join(', ') : 'none'}`);
  console.log(`  test folders: ${found.folders.length ? found.folders.join(', ') : 'none'}`);
}

const before = find();
print(before, 'Found:');
if (listOnly) process.exit(0);

for (const mapping of before.letters) execFileSync(path.join(SYSTEM32, 'subst.exe'), [`${mapping.letter}:`, '/D']);
if (before.roots.length) {
  const helper = loadHelper();
  if (!helper) {
    console.error('The native helper is needed to unregister sync roots: npm run build:native');
    process.exit(1);
  }
  for (const root of before.roots) {
    try {
      await helper.filesDriveUnregister(root.id);
    } catch (error) {
      console.error(`Unregistering ${root.id} failed: ${error.message}`);
    }
  }
}
// What Windows should have taken with each sync root, if it didn't.
for (const clsid of new Set([...before.namespaces, ...before.roots.map((root) => root.namespace).filter(Boolean)])) {
  if (subkeys(NAMESPACE).includes(clsid)) reg(['delete', `${NAMESPACE}\\${clsid}`, '/f']);
}
for (const folder of before.folders) if (existsSync(folder)) rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });

const after = find();
print(after, 'Left:');
process.exit(after.roots.length + after.namespaces.length + after.letters.length + after.folders.length === 0 ? 0 : 1);
