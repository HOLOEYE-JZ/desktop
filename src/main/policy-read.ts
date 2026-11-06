/**
 * Reads OS policies into layers of raw values. No Electron here, so tests can load
 * it: `features/policies.ts` resolves the layers and acts on them.
 *
 * Windows reads the registry through the native helper (native-loader.ts), in process: no
 * reg.exe, which endpoint protection blocks or flags, no code page, and no program another
 * folder or %SystemRoot% could stand in for. @vscode/policy-watcher reads a key from HKLM and
 * then HKCU and hands back one merged value: it can't say which hive a value came from, and
 * merging by value would mix two lists entry by entry where the machine's list must win as a
 * whole. It only answers asynchronously too, while the auth switches have to be known before
 * `ready`. So the helper gives the exact layers, and the watcher does what the helper doesn't:
 * it tells us at once when Group Policy applies.
 *
 * A key that's there and can't be read, or no helper (a build without Rust, an older binary),
 * must not read as "no policies", which would unlock everything: `readRegistry` fails then,
 * and the caller falls back to the watcher's merged values. If that's missing as well, the app
 * stops with an error page instead of guessing.
 */

import { type Stats } from 'node:fs';
import path from 'node:path';
import type { NativeRegistryNode, NativeRegistryValue } from './native-loader';
import {
  POLICY_BUNDLE_ID,
  POLICY_KEYS,
  POLICY_LINUX_FILE,
  POLICY_MAX_FILE_BYTES,
  POLICY_MAX_LIST_ITEMS,
  POLICY_RECOMMENDED_SUBKEY,
  POLICY_REGISTRY_ROOT,
  POLICY_SCHEMA,
  type PolicyKey,
  type PolicyLayer,
  type PolicyLayers,
} from '../shared/policy-schema';

export type PolicyReadResult = { ok: true; layers: PolicyLayers } | { ok: false; reason: string };

/** Full key paths, hive first, of what `reg query` reads for each level. */
export interface RegistryTargets {
  machine: string;
  user: string;
}

export const REAL_REGISTRY_TARGETS: RegistryTargets = {
  machine: `HKLM\\${POLICY_REGISTRY_ROOT}`,
  user: `HKCU\\${POLICY_REGISTRY_ROOT}`,
};

/** A test build's stand-in: both levels under HKCU, which needs no elevation. */
export function testRegistryTargets(root: string): RegistryTargets {
  return { machine: `${root}\\Machine`, user: `${root}\\User` };
}

/**
 * The stand-in root for tests. Takes both gates: a test build, which a package never
 * is (build.mjs), and not packaged. The argument has to name the one tree it may
 * read, so even then it can't point at anything else.
 */
export function testPolicyRoot(argv: readonly string[], isPackaged: boolean): string | null {
  if (isPackaged) return null;
  const value = argv.find((arg) => arg.startsWith('--bulwark-test-policy-root='))?.split('=')[1];
  return value && /^HKCU\\Software\\BulwarkTest\\Policies(\\[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(value) ? value : null;
}

/**
 * The helper's registry read: the key and `depth` levels below it, null when it isn't there.
 * Throws when it's there and can't be read. NativeHelper.system.registry.read in the app.
 */
export type ReadRegistryTree = (key: string, depth: number) => NativeRegistryNode[] | null;

/** The Recommended key's lists lie two levels down. */
const POLICY_DEPTH = 2;

type RegValues = Map<string, unknown>;
type RegTree = Map<string, RegValues>;

/**
 * A value as the layers take it: text, or a whole number. Anything else is an object, which
 * fails every parser, so a forced policy of a type no policy uses fails closed: a REG_MULTI_SZ,
 * a QWORD past what a JS number holds, binary. Text with a line break too, as it did when
 * reg.exe printed one and it couldn't be told from the lines after it.
 */
export function policyValue(value: NativeRegistryValue): unknown {
  if (value.kind === 'sz' || value.kind === 'expand_sz') {
    const text = value.text ?? '';
    return /[\r\n]/.test(text) ? { invalid: 'line_break' } : text;
  }
  if (value.kind === 'dword' && typeof value.number === 'number') return value.number;
  if (value.kind === 'qword') {
    const number = Number(value.text);
    return Number.isSafeInteger(number) ? number : { invalid: 'REG_QWORD' };
  }
  return { invalid: `REG_${value.kind.toUpperCase()}` };
}

/** The helper's read as a tree, by lowercased subkey path ('' for the key itself) and lowercased value name. */
export function treeFromNodes(nodes: readonly NativeRegistryNode[]): RegTree {
  const tree: RegTree = new Map();
  for (const node of nodes) {
    const values: RegValues = new Map();
    for (const value of node.values) values.set(value.name.toLowerCase(), policyValue(value));
    tree.set(node.path.toLowerCase(), values);
  }
  return tree;
}

function numbered(values: RegValues): unknown[] {
  return [...values.entries()]
    .filter(([name]) => /^\d{1,6}$/.test(name))
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, value]) => value);
}

/**
 * One level. A list is a subkey with values 1, 2, 3, the way Chrome does it. An empty
 * subkey is what's left when an admin disables the policy, so it counts as not set.
 */
function layerFromTree(tree: RegTree, prefix: string): PolicyLayer {
  const layer: PolicyLayer = {};
  const values = tree.get(prefix.replace(/\\$/, ''));
  for (const key of POLICY_KEYS) {
    if (POLICY_SCHEMA[key].type === 'list') {
      const sub = tree.get(`${prefix}${key.toLowerCase()}`);
      const items = sub ? numbered(sub) : [];
      if (items.length) {
        layer[key] = items;
        continue;
      }
    }
    const raw = values?.get(key.toLowerCase());
    if (raw !== undefined) layer[key] = raw;
  }
  return layer;
}

export function layersFromRegistry(machine: RegTree, user: RegTree): PolicyLayers {
  const recommended = `${POLICY_RECOMMENDED_SUBKEY.toLowerCase()}\\`;
  return {
    forcedMachine: layerFromTree(machine, ''),
    forcedUser: layerFromTree(user, ''),
    recommendedMachine: layerFromTree(machine, recommended),
    recommendedUser: layerFromTree(user, recommended),
  };
}

/**
 * Both levels, through the helper. A key that isn't there is no policy at that level; one
 * that's there and can't be read, or no helper at all, fails: the caller reads through the
 * watcher then, never as "no policies".
 */
export async function readRegistry(targets: RegistryTargets, read: ReadRegistryTree | null): Promise<PolicyReadResult> {
  if (!read) return { ok: false, reason: 'reg_failed' };
  try {
    const machine = read(targets.machine, POLICY_DEPTH);
    const user = read(targets.user, POLICY_DEPTH);
    return { ok: true, layers: layersFromRegistry(machine ? treeFromNodes(machine) : new Map(), user ? treeFromNodes(user) : new Map()) };
  } catch {
    return { ok: false, reason: 'reg_failed' };
  }
}

/** The names a watcher looks at: the single values, or a list's numbers. */
const SCALARS = POLICY_KEYS.filter((key) => POLICY_SCHEMA[key].type !== 'list');
const LISTS = POLICY_KEYS.filter((key) => POLICY_SCHEMA[key].type === 'list');
/** Only for when the helper can't read. Each name is a registry read on each policy refresh. */
const WATCHED_LIST_ITEMS = Math.min(64, POLICY_MAX_LIST_ITEMS);

export interface PolicyWatcherHandle {
  dispose(): void;
}

export type CreateWatcher = (
  productName: string,
  policies: Record<string, { type: readonly string[] }>,
  onChange: (update: Record<string, unknown>) => void,
  options?: { registryPath?: string },
) => PolicyWatcherHandle;

const ANY_VALUE = { type: ['string', 'number'] } as const;

function watchedNames(names: string[]): Record<string, { type: readonly string[] }> {
  return Object.fromEntries(names.map((name) => [name, ANY_VALUE]));
}

/**
 * Tells us when Group Policy applies: it listens for the OS's policy event. A value
 * written directly (`reg add`, an installer) fires nothing, so the caller polls too.
 */
export function watchRegistry(create: CreateWatcher, registryPaths: string[], onChange: () => void): () => void {
  const handles = registryPaths.map((registryPath) => watchOne(create, 'Bulwark', { registryPath }, onChange));
  return () => {
    for (const handle of handles) handle.dispose();
  };
}

/** On macOS it watches /Library/Managed Preferences for this bundle id. */
export function watchMacPreferences(create: CreateWatcher, bundleId: string, onChange: () => void): () => void {
  const handle = watchOne(create, bundleId, undefined, onChange);
  return () => handle.dispose();
}

function watchOne(create: CreateWatcher, productName: string, options: { registryPath: string } | undefined, onChange: () => void): PolicyWatcherHandle {
  // The first callback only reports what's there now.
  let first = true;
  return create(productName, watchedNames(SCALARS), () => {
    if (!first) onChange();
    first = false;
  }, options);
}

/**
 * For when the native helper can't read the registry: the watcher's merged values, machine over
 * user. A single value where a list belongs counts as a bad list, as it does through the helper. What
 * the watcher can't do is see a REG_BINARY or REG_EXPAND_SZ value, or tell a one-line
 * REG_MULTI_SZ from a string: it has no way to report those.
 */
export async function readThroughWatcher(create: CreateWatcher, registryRoot: string, timeoutMs = 5000): Promise<PolicyReadResult> {
  const one = (registryPath: string, names: string[]) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      const handle = create(
        'Bulwark',
        watchedNames(names),
        (update) => {
          clearTimeout(timer);
          handle.dispose();
          resolve(update);
        },
        { registryPath },
      );
    });
  const level = async (root: string): Promise<PolicyLayer> => {
    const layer: PolicyLayer = {};
    const values = await one(root, [...POLICY_KEYS]);
    for (const key of POLICY_KEYS) if (values[key] !== undefined) layer[key] = values[key];
    const numbers = Array.from({ length: WATCHED_LIST_ITEMS }, (_, i) => String(i + 1));
    await Promise.all(
      LISTS.map(async (key) => {
        const update = await one(`${root}\\${key}`, numbers);
        const items = numbers.map((name) => update[name]).filter((item) => item !== undefined);
        if (items.length) layer[key as PolicyKey] = items;
      }),
    );
    return layer;
  };
  try {
    const [forcedMachine, recommendedMachine] = await Promise.all([level(registryRoot), level(`${registryRoot}\\${POLICY_RECOMMENDED_SUBKEY}`)]);
    return { ok: true, layers: { forcedMachine, forcedUser: {}, recommendedMachine, recommendedUser: {} } };
  } catch {
    return { ok: false, reason: 'watcher_failed' };
  }
}

/** What an error page calls the place policies come from, on this OS. */
export function policySourceName(platform: NodeJS.Platform): string {
  if (platform === 'linux') return POLICY_LINUX_FILE;
  if (platform === 'darwin') return `/Library/Managed Preferences/${POLICY_BUNDLE_ID}.plist`;
  return POLICY_REGISTRY_ROOT;
}

export type LinuxFileProblem = 'not_a_file' | 'not_root_owned' | 'writable_by_others' | 'dir_unsafe' | 'too_large' | 'unreadable' | 'not_json';

type FileFacts = Pick<Stats, 'uid' | 'mode' | 'size'> & { isFile(): boolean; isSymbolicLink(): boolean; isDirectory(): boolean };

/** A policy file anyone can change is no policy. Root-owned, not writable by group or others, no links. */
export function policyFileProblem(file: FileFacts, dir: FileFacts): LinuxFileProblem | null {
  if (file.isSymbolicLink() || !file.isFile()) return 'not_a_file';
  if (file.uid !== 0) return 'not_root_owned';
  if ((file.mode & 0o022) !== 0) return 'writable_by_others';
  if (dir.isSymbolicLink() || !dir.isDirectory() || dir.uid !== 0 || (dir.mode & 0o022) !== 0) return 'dir_unsafe';
  if (file.size > POLICY_MAX_FILE_BYTES) return 'too_large';
  return null;
}

/** The file's top level is forced; a `Recommended` object inside it holds the defaults. */
export function layersFromJson(text: string): PolicyReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'not_json' };
  const pick = (source: unknown): PolicyLayer => {
    const layer: PolicyLayer = {};
    if (typeof source !== 'object' || source === null || Array.isArray(source)) return layer;
    for (const key of POLICY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source, key)) layer[key] = (source as Record<string, unknown>)[key];
    }
    return layer;
  };
  return {
    ok: true,
    layers: {
      forcedMachine: pick(parsed),
      forcedUser: {},
      recommendedMachine: pick((parsed as Record<string, unknown>)[POLICY_RECOMMENDED_SUBKEY]),
      recommendedUser: {},
    },
  };
}

export interface LinuxFs {
  lstat(file: string): FileFacts;
  read(file: string): string;
}

export function readPolicyFile(file: string, fs: LinuxFs): PolicyReadResult {
  let facts: FileFacts;
  try {
    facts = fs.lstat(file);
  } catch (error) {
    // No file is the normal case: no policy.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, layers: { forcedMachine: {}, forcedUser: {}, recommendedMachine: {}, recommendedUser: {} } };
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const problem = policyFileProblem(facts, fs.lstat(path.posix.dirname(file)));
    if (problem) return { ok: false, reason: problem };
    return layersFromJson(fs.read(file));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** What's needed of Electron's systemPreferences. */
export interface MacPreferences {
  getUserDefault(key: string, type: 'string' | 'array' | 'dictionary'): unknown;
}

/** A file only root can change, or nothing we'd trust. Same rule as the Linux file. */
export function managedPlistProblem(file: FileFacts): 'plist_unsafe' | null {
  if (file.isSymbolicLink() || !file.isFile() || file.uid !== 0 || (file.mode & 0o022) !== 0) return 'plist_unsafe';
  return null;
}

/** The profile's values as MDM wrote them: `/Library/Managed Preferences/...`. */
export function managedPlistPaths(bundleId: string, user: string): { machine: string; user: string } {
  return {
    machine: `/Library/Managed Preferences/${bundleId}.plist`,
    user: `/Library/Managed Preferences/${user}/${bundleId}.plist`,
  };
}

export type ReadManagedPlist = (file: string) => { ok: true; values: Record<string, unknown> | null } | { ok: false; reason: string };

function pickKnown(source: unknown): PolicyLayer {
  const layer: PolicyLayer = {};
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return layer;
  for (const key of POLICY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) layer[key] = (source as Record<string, unknown>)[key];
  }
  return layer;
}

/**
 * NSUserDefaults alone can't be trusted: `defaults write` puts anything there, with no
 * way to tell. What counts as forced is what's in the root-owned managed files, plus what
 * the native helper's objectIsForcedForKey vouches for. The rest of NSUserDefaults can
 * only be a recommendation, and forced-only keys ignore those.
 *
 * macOS gives no way to read "absent" from NSUserDefaults: getUserDefault answers '' or
 * [], and asking for 'boolean' answers false. So everything single is read as a string
 * (numbers and booleans become "1" and "0") and '' means unset, which is why a shortcut
 * is turned off there with the word `off`.
 */
export function readMacPolicies(
  prefs: MacPreferences,
  isForced: ((key: string) => boolean) | null,
  paths: { machine: string; user: string },
  readPlist: ReadManagedPlist,
): PolicyReadResult {
  const machine = readPlist(paths.machine);
  if (!machine.ok) return machine;
  const user = readPlist(paths.user);
  if (!user.ok) return user;

  const forcedMachine = pickKnown(machine.values);
  const forcedUser = pickKnown(user.values);
  const recommendedMachine = pickKnown(machine.values?.[POLICY_RECOMMENDED_SUBKEY]);
  const recommendedUser = pickKnown(user.values?.[POLICY_RECOMMENDED_SUBKEY]);

  for (const key of POLICY_KEYS) {
    if (forcedMachine[key] !== undefined || forcedUser[key] !== undefined) continue;
    let raw: unknown;
    if (POLICY_SCHEMA[key].type === 'list') {
      const items = prefs.getUserDefault(key, 'array');
      raw = Array.isArray(items) && items.length ? items : undefined;
    } else {
      const text = prefs.getUserDefault(key, 'string');
      raw = typeof text === 'string' && text !== '' ? text : undefined;
    }
    if (raw === undefined) continue;
    if (isForced?.(key)) forcedMachine[key] = raw;
    else if (recommendedMachine[key] === undefined) recommendedUser[key] = raw;
  }
  return { ok: true, layers: { forcedMachine, forcedUser, recommendedMachine, recommendedUser } };
}
