/**
 * Reads OS policies into layers of raw values. No Electron here, so tests can load
 * it: `features/policies.ts` resolves the layers and acts on them.
 *
 * Windows reads with `reg.exe`, in a console set to UTF-8: left alone it writes in the
 * OEM code page and drops what doesn't fit, so https://müller.de would come out as a
 * different address. @vscode/policy-watcher reads a key from HKLM and
 * then HKCU and hands back one merged value: it can't say which hive a value came
 * from, and merging by value would mix two lists entry by entry where the machine's
 * list must win as a whole. It only answers asynchronously too, while the auth
 * switches have to be known before `ready`. So reg.exe gives the exact layers, and
 * the watcher does what reg.exe can't: it tells us at once when Group Policy applies.
 *
 * reg.exe can be blocked ("Prevent access to registry editing tools", AppLocker). A
 * blocked reg.exe must not read as "no policies", which would unlock everything, so
 * `readRegistry` tells the two apart with a key that's always there, and the caller
 * falls back to the watcher's merged values. If that's missing as well, the app stops
 * with an error page instead of guessing.
 */

import { execFile } from 'node:child_process';
import { existsSync, realpathSync, type Stats } from 'node:fs';
import path from 'node:path';
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

const KNOWN_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';
const REG_MAX_BUFFER = 4 * 1024 * 1024;
const REG_TIMEOUT_MS = 10_000;

export interface RegResult {
  /** 0 found, 1 not found or refused. Anything else: it didn't run at all. */
  code: number;
  stdout: string;
}

export type RunReg = (args: string[]) => Promise<RegResult>;

/** The kernel's own link to the Windows folder. No environment variable or user can move it. */
const KERNEL_SYSTEM_ROOT = '\\\\?\\GLOBALROOT\\SystemRoot';

/** Where Windows really is, or null. */
export function realSystemRoot(resolve: (file: string) => string = realpathSync.native): string | null {
  try {
    const root = resolve(KERNEL_SYSTEM_ROOT);
    return /^[A-Za-z]:\\[^"]*$/.test(root) ? root : null;
  } catch {
    return null;
  }
}

/**
 * Where reg.exe is. Not from %SystemRoot%: anyone can start the app with that pointing at
 * their own reg.exe, which would answer "no policies". Not C:\Windows on trust either: with
 * Windows on another drive, anyone may be able to make that folder. Null if Windows won't
 * say, and the caller reads through the watcher instead.
 */
export function regPath(root: string | null = realSystemRoot(), exists: (file: string) => boolean = existsSync): string | null {
  if (!root) return null;
  const file = `${root}\\System32\\reg.exe`;
  return exists(file) ? file : null;
}

/** Only keys we name ourselves go on this command line: nothing a policy value could reach. */
const SAFE_REG_ARG = /^[A-Za-z0-9_\\ ./-]+$/;

export function regCommandLine(file: string, args: readonly string[]): string[] {
  const quoted = args.map((arg) => {
    if (!SAFE_REG_ARG.test(arg)) throw new Error('reg: refused argument');
    return arg.includes(' ') ? `"${arg}"` : arg;
  });
  // /d: no AutoRun commands from the user's own registry. /s: keep the outer quotes' meaning plain.
  return ['/d', '/s', '/c', `"chcp 65001>nul & "${file}" ${quoted.join(' ')}"`];
}

export const runRegExe: RunReg = (args) =>
  new Promise((resolve) => {
    const file = regPath();
    const cmd = file ? path.win32.join(path.win32.dirname(file), 'cmd.exe') : null;
    if (!file || !cmd) {
      resolve({ code: -1, stdout: '' });
      return;
    }
    execFile(cmd, regCommandLine(file, args), { windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8', maxBuffer: REG_MAX_BUFFER, timeout: REG_TIMEOUT_MS }, (error, stdout) => {
      if (!error) {
        resolve({ code: 0, stdout });
        return;
      }
      const code = typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout: '' });
    });
  });

type RegValues = Map<string, unknown>;
type RegTree = Map<string, RegValues>;

const VALUE_LINE = /^ {4}(.*?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/;

function regValue(type: string, data: string | undefined): unknown {
  if (type === 'REG_SZ' || type === 'REG_EXPAND_SZ') return data ?? '';
  if (type === 'REG_DWORD' || type === 'REG_QWORD') {
    const number = Number(data);
    return Number.isSafeInteger(number) ? number : { invalid: type };
  }
  // A type no policy uses. An object fails every parser, so it counts as a bad value.
  return { invalid: type };
}

function hiveLong(key: string): string {
  return key.replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\').replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\');
}

/**
 * `reg query <key> /s` as a tree, by lowercased subkey path. reg.exe prints a value's line
 * breaks as they are, so a value can print what looks like a key. A real key comes after an
 * empty line and lies under the one asked for. Anything else right after a value is more of
 * that value: it counts as a bad one, where cutting it off could leave a different setting.
 */
export function parseRegOutput(output: string, target: string): RegTree {
  const root = hiveLong(target).toLowerCase();
  const tree: RegTree = new Map();
  let current: RegValues | null = null;
  let lastValue: string | null = null;
  let afterEmptyLine = true;
  for (const line of output.split(/\r?\n/)) {
    if (line === '') {
      afterEmptyLine = true;
      lastValue = null;
      continue;
    }
    const key = line.trimEnd().toLowerCase();
    if (afterEmptyLine && line.startsWith('HKEY_') && (key === root || key.startsWith(`${root}\\`))) {
      current = new Map();
      tree.set(key.slice(root.length + 1), current);
      lastValue = null;
    } else {
      const value = VALUE_LINE.exec(line);
      if (value && current) {
        lastValue = value[1].toLowerCase();
        current.set(lastValue, regValue(value[2], value[3]));
      } else if (current && lastValue !== null) {
        current.set(lastValue, { invalid: 'line_break' });
      }
    }
    afterEmptyLine = false;
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

export async function readRegistry(targets: RegistryTargets, run: RunReg = runRegExe): Promise<PolicyReadResult> {
  const [machine, user] = await Promise.all([run(['query', targets.machine, '/s']), run(['query', targets.user, '/s'])]);
  for (const result of [machine, user]) {
    if (result.code !== 0 && result.code !== 1) return { ok: false, reason: 'reg_failed' };
  }
  // Exit code 1 is both "no such key" and "registry tools are blocked". Most machines
  // have no policy at all, so this probe runs often, but it only costs one more process.
  if (machine.code === 1 || user.code === 1) {
    const probe = await run(['query', KNOWN_KEY, '/v', 'CurrentBuild']);
    if (probe.code !== 0) return { ok: false, reason: 'reg_blocked' };
  }
  return {
    ok: true,
    layers: layersFromRegistry(
      machine.code === 0 ? parseRegOutput(machine.stdout, targets.machine) : new Map(),
      user.code === 0 ? parseRegOutput(user.stdout, targets.user) : new Map(),
    ),
  };
}

/** The names a watcher looks at: the single values, or a list's numbers. */
const SCALARS = POLICY_KEYS.filter((key) => POLICY_SCHEMA[key].type !== 'list');
const LISTS = POLICY_KEYS.filter((key) => POLICY_SCHEMA[key].type === 'list');
/** Only for when reg.exe is blocked. Each name is a registry read on each policy refresh. */
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
 * For a machine where reg.exe is blocked: the watcher's merged values, machine over user.
 * A single value where a list belongs counts as a bad list, as it does through reg.exe. What
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
