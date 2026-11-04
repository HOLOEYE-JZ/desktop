import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  layersFromJson,
  parseRegOutput,
  layersFromRegistry,
  policyFileProblem,
  managedPlistPaths,
  managedPlistProblem,
  readMacPolicies,
  regCommandLine,
  registryAgrees,
  runRegExe,
  readPolicyFile,
  readRegistry,
  readThroughWatcher,
  regPath,
  REAL_REGISTRY_TARGETS,
  testPolicyRoot,
  testRegistryTargets,
  watchRegistry,
  type CreateWatcher,
  type RunReg,
} from '../src/main/policy-read';
import { FORCED_SSO_LIMIT_MS, SsoChain } from '../src/main/navigation-rules';
import { connectionMustChange, decideStart, restartKey, standaloneAllowed } from '../src/main/policy-start';
import { deniedSwitches, withoutDeniedSwitches } from '../src/main/switch-guard';
import { EMPTY_POLICY_LAYERS, POLICY_CONSUMERS, POLICY_KEYS, resolvePolicies, type PolicyLayer } from '../src/shared/policy-schema';

/** A row per test. Playwright has no test.each. */
function each<const Row>(rows: readonly Row[]) {
  return (title: string, run: (...args: Row extends readonly unknown[] ? [...Row] : [Row]) => void | Promise<void>) => {
    for (const row of rows) {
      const args = (Array.isArray(row) ? row : [row]) as Row extends readonly unknown[] ? [...Row] : [Row];
      test(title.replace('%s', () => String(args[0] || '(empty)')), () => run(...args));
    }
  };
}

const TARGETS = testRegistryTargets('HKCU\\Software\\BulwarkTest\\Policies\\x');
const ROOT_LONG = 'HKEY_CURRENT_USER\\Software\\BulwarkTest\\Policies\\x\\Machine';

const snapshot = (forcedMachine: PolicyLayer = {}, recommendedMachine: PolicyLayer = {}) =>
  resolvePolicies({ ...EMPTY_POLICY_LAYERS, forcedMachine, recommendedMachine });

test.describe('reading reg.exe', () => {
  const output = [
    '',
    ROOT_LONG,
    '    InstanceUrl    REG_SZ    https://mail.example.com',
    '    AllowStandalone    REG_DWORD    0x0',
    '    AutoUpdate    REG_MULTI_SZ    a\\0b',
    '    QuickComposeShortcut    REG_SZ    ',
    '    Name With Spaces    REG_SZ    has    four    spaces',
    '',
    `${ROOT_LONG}\\AllowedJmapServers`,
    '    2    REG_SZ    https://b.example',
    '    10    REG_SZ    https://c.example',
    '    1    REG_SZ    https://a.example',
    '    x    REG_SZ    https://not-numbered.example',
    '',
    `${ROOT_LONG}\\PluginAllowlist`,
    '',
    `${ROOT_LONG}\\Recommended`,
    '    UpdateChannel    REG_SZ    beta',
    '',
    `${ROOT_LONG}\\Recommended\\PluginAllowlist`,
    '    1    REG_SZ    good-plugin',
    '',
    'HKEY_LOCAL_MACHINE\\Software\\Somewhere\\Else',
    '    InstanceUrl    REG_SZ    https://elsewhere.example',
    '',
  ].join('\r\n');

  const layers = () => layersFromRegistry(parseRegOutput(output, TARGETS.machine), new Map());

  test('reads values, types and numbered lists in number order', () => {
    const { forcedMachine } = layers();
    expect(forcedMachine.InstanceUrl).toBe('https://mail.example.com');
    expect(forcedMachine.AllowStandalone).toBe(0);
    expect(forcedMachine.AllowedJmapServers).toEqual(['https://a.example', 'https://b.example', 'https://c.example']);
  });

  test('an empty value is empty, not missing', () => {
    expect(layers().forcedMachine.QuickComposeShortcut).toBe('');
  });

  test('a type no policy uses fails the parser, so a forced one fails closed', () => {
    const { forcedMachine } = layers();
    expect(typeof forcedMachine.AutoUpdate).toBe('object');
    expect(resolvePolicies({ ...EMPTY_POLICY_LAYERS, forcedMachine }).AutoUpdate).toMatchObject({ value: false, invalid: 'not_a_switch' });
  });

  test('an empty list key is what disabling leaves behind: not set, rather than "nothing allowed"', () => {
    expect(layers().forcedMachine.PluginAllowlist).toBeUndefined();
  });

  test('keeps Recommended apart from the forced values', () => {
    const { forcedMachine, recommendedMachine } = layers();
    expect(recommendedMachine.UpdateChannel).toBe('beta');
    expect(forcedMachine.UpdateChannel).toBeUndefined();
    expect(recommendedMachine.PluginAllowlist).toEqual(['good-plugin']);
    expect(recommendedMachine.InstanceUrl).toBeUndefined();
  });

  test('ignores anything outside the key it asked for', () => {
    const elsewhere = 'HKEY_LOCAL_MACHINE\\Software\\Somewhere\\Else\r\n    InstanceUrl    REG_SZ    https://evil.example\r\n';
    expect(layersFromRegistry(parseRegOutput(elsewhere, TARGETS.machine), new Map()).forcedMachine).toEqual({});
  });

  test('machine and user stay separate levels', async () => {
    const run: RunReg = async ([, key]) => ({
      code: 0,
      stdout: `${key.replace('HKCU', 'HKEY_CURRENT_USER')}\r\n    UpdateChannel    REG_SZ    ${key.endsWith('Machine') ? 'beta' : 'stable'}\r\n`,
    });
    const read = await readRegistry(TARGETS, run);
    expect(read.ok && read.layers.forcedMachine.UpdateChannel).toBe('beta');
    expect(read.ok && read.layers.forcedUser.UpdateChannel).toBe('stable');
  });
});

test.describe('when reg.exe gives no answer', () => {
  test('no key on a working reg.exe is no policy', async () => {
    const run: RunReg = async (args) => (args.includes('/v') ? { code: 0, stdout: 'CurrentBuild' } : { code: 1, stdout: '' });
    const read = await readRegistry(REAL_REGISTRY_TARGETS, run);
    expect(read).toEqual({ ok: true, layers: EMPTY_POLICY_LAYERS });
  });

  test('a blocked reg.exe does not read as no policy', async () => {
    // "Prevent access to registry editing tools": exit code 1, the same as a missing key.
    const run: RunReg = async () => ({ code: 1, stdout: '' });
    expect(await readRegistry(REAL_REGISTRY_TARGETS, run)).toEqual({ ok: false, reason: 'reg_blocked' });
  });

  test('a reg.exe that will not start does not either', async () => {
    const run: RunReg = async () => ({ code: -1, stdout: '' });
    expect(await readRegistry(REAL_REGISTRY_TARGETS, run)).toEqual({ ok: false, reason: 'reg_failed' });
  });

  test('non-ASCII comes through whole, through the real reg.exe', async () => {
    test.skip(process.platform !== 'win32', 'Windows registry');
    const key = `HKCU\\Software\\BulwarkTest\\Policies\\enc${process.pid}`;
    spawnSync('reg.exe', ['add', `${key}\\Machine`, '/v', 'InstanceUrl', '/t', 'REG_SZ', '/d', 'https://m\u00fcller.de', '/f'], { windowsHide: true });
    try {
      const read = await readRegistry(testRegistryTargets(key));
      expect(read.ok && read.layers.forcedMachine.InstanceUrl).toBe('https://m\u00fcller.de');
      if (read.ok) expect(resolvePolicies(read.layers).InstanceUrl.value).toBe('https://xn--mller-kva.de/');
    } finally {
      spawnSync('reg.exe', ['delete', 'HKCU\\Software\\BulwarkTest', '/f'], { windowsHide: true });
    }
  });

  test('reg.exe\'s own exit codes still come through cmd', async () => {
    test.skip(process.platform !== 'win32', 'Windows registry');
    expect((await runRegExe(['query', 'HKCU\\Software\\BulwarkTest\\NotThere'])).code).toBe(1);
    expect((await runRegExe(['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'CurrentBuild'])).code).toBe(0);
  });

  test('nothing unusual gets onto cmd\'s command line', () => {
    expect(() => regCommandLine('C:\\Windows\\System32\\reg.exe', ['query', 'HKCU\\a & calc'])).toThrow('refused');
    expect(() => regCommandLine('C:\\Windows\\System32\\reg.exe', ['query', 'HKCU\\a"b'])).toThrow('refused');
    expect(regCommandLine('C:\\Windows\\System32\\reg.exe', ['query', 'HKLM\\Windows NT'])[3]).toContain('"HKLM\\Windows NT"');
    expect(regCommandLine('C:\\Windows\\System32\\reg.exe', ['query', 'k']).slice(0, 3)).toEqual(['/d', '/s', '/c']);
  });

  test('a planted reg.exe that hides a value disagrees with the watcher', () => {
    const empty = { ...EMPTY_POLICY_LAYERS };
    const watcher = { ...EMPTY_POLICY_LAYERS, forcedMachine: { InstanceUrl: 'https://mail.example.com' } };
    expect(registryAgrees(empty, watcher)).toBe(false);
    expect(registryAgrees({ ...empty, forcedUser: { InstanceUrl: 'https://mail.example.com' } }, watcher)).toBe(true);
    expect(registryAgrees({ ...empty, forcedMachine: { InstanceUrl: 'https://other.example' } }, watcher)).toBe(false);
    // The watcher's narrow strings aren't compared when they aren't plain ASCII.
    expect(registryAgrees({ ...empty, forcedMachine: { InstanceUrl: 'https://m\u00fcller.de' } }, { ...empty, forcedMachine: { InstanceUrl: 'https://m\u00e4ller.de' } })).toBe(true);
  });

  test('its path can\'t be redirected by the environment', () => {
    const planted = { SystemRoot: 'C:\\Users\\me\\fake' };
    expect(regPath((file) => file.startsWith('C:\\Users') || file === 'C:\\Windows\\System32\\reg.exe', planted)).toBe('C:\\Windows\\System32\\reg.exe');
    expect(regPath((file) => file.startsWith('C:\\Users'), planted)).toBeNull();
    // Windows on another drive still works.
    expect(regPath((file) => file.startsWith('D:\\'), { SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\reg.exe');
  });

  test('the watcher takes over, lists included', async () => {
    const seen: string[] = [];
    const create: CreateWatcher = (_name, policies, onChange, options) => {
      const registryPath = options?.registryPath ?? '';
      seen.push(registryPath);
      const answers: Record<string, Record<string, unknown>> = {
        'Software\\Policies\\Bulwark\\Desktop': { InstanceUrl: 'https://mail.example.com' },
        'Software\\Policies\\Bulwark\\Desktop\\AllowedJmapServers': { 1: 'https://a.example', 3: 'https://c.example' },
        'Software\\Policies\\Bulwark\\Desktop\\Recommended': { UpdateChannel: 'beta' },
      };
      expect(Object.keys(policies).length).toBeGreaterThan(0);
      setTimeout(() => onChange(answers[registryPath] ?? {}), 1);
      return { dispose: () => {} };
    };
    const read = await readThroughWatcher(create, 'Software\\Policies\\Bulwark\\Desktop');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.layers.forcedMachine.InstanceUrl).toBe('https://mail.example.com');
    expect(read.layers.forcedMachine.AllowedJmapServers).toEqual(['https://a.example', 'https://c.example']);
    expect(read.layers.recommendedMachine.UpdateChannel).toBe('beta');
  });

  test('a watcher that never answers is a failure, not an empty policy', async () => {
    const create: CreateWatcher = () => ({ dispose: () => {} });
    expect(await readThroughWatcher(create, 'x', 20)).toEqual({ ok: false, reason: 'watcher_failed' });
  });
});

test.describe('the real watcher module', () => {
  test.skip(process.platform !== 'win32', 'Windows registry');
  const KEY = `HKCU\\Software\\BulwarkTest\\Policies\\watcher-${process.pid}`;
  const reg = (...args: string[]) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  const watcher = () => createRequire(import.meta.url)('@vscode/policy-watcher').createWatcher as CreateWatcher;

  test.afterAll(() => {
    reg('delete', 'HKCU\\Software\\BulwarkTest', '/f');
  });

  test('takes a registry path and reads strings, numbers and numbered lists', async () => {
    reg('add', KEY, '/v', 'InstanceUrl', '/t', 'REG_SZ', '/d', 'https://mail.example.com', '/f');
    reg('add', KEY, '/v', 'AutoUpdate', '/t', 'REG_DWORD', '/d', '0', '/f');
    reg('add', `${KEY}\\AllowedJmapServers`, '/v', '1', '/t', 'REG_SZ', '/d', 'https://a.example', '/f');
    const read = await readThroughWatcher(watcher(), KEY.replace('HKCU\\', ''));
    expect(read.ok && read.layers.forcedMachine).toEqual({
      InstanceUrl: 'https://mail.example.com',
      AutoUpdate: 0,
      AllowedJmapServers: ['https://a.example'],
    });
  });

  test('does not signal a change for what it finds at the start', async () => {
    let changes = 0;
    const stop = watchRegistry(watcher(), [KEY.replace('HKCU\\', '')], () => (changes += 1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop();
    expect(changes).toBe(0);
  });
});

test.describe('the Linux policy file', () => {
  const stat = (over: Partial<{ uid: number; mode: number; size: number; file: boolean; link: boolean; dir: boolean }> = {}) => ({
    uid: over.uid ?? 0,
    mode: over.mode ?? 0o100644,
    size: over.size ?? 100,
    isFile: () => over.file ?? true,
    isSymbolicLink: () => over.link ?? false,
    isDirectory: () => over.dir ?? false,
  });
  const dir = (over: Parameters<typeof stat>[0] = {}) => stat({ mode: 0o40755, file: false, dir: true, ...over });

  test('root-owned and 644 is trusted', () => {
    expect(policyFileProblem(stat(), dir())).toBeNull();
    expect(policyFileProblem(stat({ mode: 0o100600 }), dir())).toBeNull();
  });

  each([
    ['owned by a user', stat({ uid: 1000 }), dir(), 'not_root_owned'],
    ['writable by the group', stat({ mode: 0o100664 }), dir(), 'writable_by_others'],
    ['writable by anyone', stat({ mode: 0o100666 }), dir(), 'writable_by_others'],
    ['a link', stat({ link: true, file: false }), dir(), 'not_a_file'],
    ['a directory', stat({ file: false, dir: true }), dir(), 'not_a_file'],
    ['a folder others can write to', stat(), dir({ mode: 0o40777 }), 'dir_unsafe'],
    ['a folder of a user', stat(), dir({ uid: 1000 }), 'dir_unsafe'],
    ['huge', stat({ size: 5 * 1024 * 1024 }), dir(), 'too_large'],
  ] as const)('%s fails closed', (_name, file, folder, problem) => {
    expect(policyFileProblem(file, folder)).toBe(problem);
  });

  const fs = (files: Record<string, ReturnType<typeof stat> | Error>, text = '{}') => ({
    lstat(file: string) {
      const found = files[file];
      if (found instanceof Error) throw found;
      if (!found) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return found;
    },
    read: () => text,
  });
  const FILE = '/etc/bulwark/policies.json';

  test('no file is no policy', () => {
    expect(readPolicyFile(FILE, fs({}))).toEqual({ ok: true, layers: EMPTY_POLICY_LAYERS });
  });

  test('an unsafe file is refused without reading it', () => {
    expect(readPolicyFile(FILE, fs({ [FILE]: stat({ mode: 0o100666 }), '/etc/bulwark': dir() }))).toEqual({ ok: false, reason: 'writable_by_others' });
  });

  test('a file that can\'t be read isn\'t no policy', () => {
    expect(readPolicyFile(FILE, fs({ [FILE]: Object.assign(new Error('no'), { code: 'EACCES' }) }))).toEqual({ ok: false, reason: 'unreadable' });
  });

  test('reads forced values and Recommended, and nothing else', () => {
    const read = readPolicyFile(FILE, fs({ [FILE]: stat(), '/etc/bulwark': dir() }, '{"InstanceUrl":"https://a.example","Other":1,"__proto__":{"AllowStandalone":1},"Recommended":{"UpdateChannel":"beta"}}'));
    expect(read).toEqual({
      ok: true,
      layers: { forcedMachine: { InstanceUrl: 'https://a.example' }, forcedUser: {}, recommendedMachine: { UpdateChannel: 'beta' }, recommendedUser: {} },
    });
  });

  each(['not json', '[]', 'null', '7'])('%s fails closed', (text) => {
    expect(layersFromJson(text)).toEqual({ ok: false, reason: 'not_json' });
  });

  test('the sample the webmail generates reads clean', () => {
    // Keeps the generator and this reader honest about the file's shape.
    const read = layersFromJson('{"PluginsMode":"off","AllowedJmapServers":["https://a.example"],"Recommended":{"UpdateChannel":"stable"}}');
    expect(read.ok).toBe(true);
    if (read.ok) expect(resolvePolicies(read.layers).AllowedJmapServers.value).toEqual(['https://a.example']);
  });
});

test.describe('macOS managed preferences', () => {
  const prefs = (values: Record<string, unknown>) => ({
    // What Electron gives for a key that isn't there.
    getUserDefault: (key: string, type: string) => values[key] ?? (type === 'array' ? [] : type === 'dictionary' ? {} : ''),
  });
  const PATHS = { machine: '/m.plist', user: '/u.plist' };
  const plists = (files: Record<string, Record<string, unknown>> = {}) => (file: string) => ({ ok: true as const, values: files[file] ?? null });
  const read = (values: Record<string, unknown>, isForced: ((key: string) => boolean) | null, files?: Record<string, Record<string, unknown>>) => {
    const result = readMacPolicies(prefs(values), isForced, PATHS, plists(files));
    if (!result.ok) throw new Error(result.reason);
    return result.layers;
  };

  test('`defaults write` alone is never forced: with no helper and no managed file, it can only recommend', () => {
    const layers = read({ AllowStandalone: '1', AllowInsecureInstance: '1', InstanceUrl: 'http://evil.example', PluginsMode: 'allowed', UpdateChannel: 'beta' }, null);
    expect(layers.forcedMachine).toEqual({});
    const snapshot = resolvePolicies(layers);
    // Forced-only keys don't hear it at all.
    expect(snapshot.AllowStandalone).toMatchObject({ source: 'default', locked: false });
    expect(snapshot.AllowInsecureInstance).toMatchObject({ value: false, source: 'default' });
    expect(snapshot.InstanceUrl.locked).toBe(false);
    expect(snapshot.UpdateChannel).toMatchObject({ value: 'beta', locked: false });
  });

  test('a user\'s default can\'t open what the managed file closed', () => {
    const layers = read({ AllowStandalone: '1', InstanceUrl: 'https://mine.example' }, () => false, { '/m.plist': { InstanceUrl: 'https://mail.example.com' } });
    const snapshot = resolvePolicies(layers);
    expect(snapshot.InstanceUrl).toMatchObject({ value: 'https://mail.example.com/', source: 'forced-machine', locked: true });
    expect(snapshot.AllowStandalone).toMatchObject({ source: 'default', locked: false });
  });

  test('the managed files give machine and user levels, and their Recommended', () => {
    const layers = read({}, null, {
      '/m.plist': { UpdateChannel: 'beta', Recommended: { AutoUpdate: false } },
      '/u.plist': { AutoUpdate: true, Junk: 1 },
    });
    expect(layers.forcedMachine).toEqual({ UpdateChannel: 'beta' });
    expect(layers.forcedUser).toEqual({ AutoUpdate: true });
    expect(layers.recommendedMachine).toEqual({ AutoUpdate: false });
  });

  test('objectIsForcedForKey vouches for a value in NSUserDefaults', () => {
    const layers = read({ InstanceUrl: 'https://a.example', AutoUpdate: '0' }, (key) => key === 'InstanceUrl');
    expect(layers.forcedMachine).toEqual({ InstanceUrl: 'https://a.example' });
    expect(layers.recommendedUser).toEqual({ AutoUpdate: '0' });
  });

  test('an absent key isn\'t read as false or empty', () => {
    const layers = read({}, () => true);
    expect(layers.forcedMachine).toEqual({});
    expect(resolvePolicies(layers).AllowStandalone.source).toBe('default');
  });

  test('a managed file that can\'t be trusted or read stops, rather than counting as no policy', () => {
    expect(readMacPolicies(prefs({}), null, PATHS, () => ({ ok: false, reason: 'plist_unsafe' }))).toEqual({ ok: false, reason: 'plist_unsafe' });
  });

  test('only a root-owned file that others can\'t write passes', () => {
    const file = (uid: number, mode: number, link = false) => ({ uid, mode, size: 1, isFile: () => !link, isSymbolicLink: () => link, isDirectory: () => false });
    expect(managedPlistProblem(file(0, 0o100644))).toBeNull();
    expect(managedPlistProblem(file(501, 0o100644))).toBe('plist_unsafe');
    expect(managedPlistProblem(file(0, 0o100666))).toBe('plist_unsafe');
    expect(managedPlistProblem(file(0, 0o120777, true))).toBe('plist_unsafe');
    expect(managedPlistPaths('org.bulwarkmail.desktop', 'me').user).toBe('/Library/Managed Preferences/me/org.bulwarkmail.desktop.plist');
  });
});

test.describe('the test root', () => {
  const ARG = '--bulwark-test-policy-root=HKCU\\Software\\BulwarkTest\\Policies\\abc';

  test('works unpackaged', () => {
    expect(testPolicyRoot([ARG], false)).toBe('HKCU\\Software\\BulwarkTest\\Policies\\abc');
  });

  test('a package never takes it', () => {
    expect(testPolicyRoot([ARG], true)).toBeNull();
  });

  each([
    'HKCU\\Software\\Other',
    'HKLM\\Software\\BulwarkTest\\Policies',
    'HKCU\\Software\\BulwarkTest\\Policies\\..\\..\\Elsewhere',
    'HKCU\\Software\\BulwarkTest\\PoliciesX',
    '',
  ])('it can\'t name anything else: %s', (root) => {
    expect(testPolicyRoot([`--bulwark-test-policy-root=${root}`], false)).toBeNull();
  });

  test('no switch means no test root, whatever the environment says', () => {
    process.env.BULWARK_TEST_POLICY_ROOT = 'HKCU\\Software\\BulwarkTest\\Policies\\env';
    try {
      expect(testPolicyRoot([], false)).toBeNull();
    } finally {
      delete process.env.BULWARK_TEST_POLICY_ROOT;
    }
  });

  test('the production build has no test root at all, and a test build can\'t be packaged', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const build = (...args: string[]) => {
      const run = spawnSync(process.execPath, ['build.mjs', ...args], { cwd: root, encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      return readFileSync(path.join(root, 'dist', 'main.mjs'), 'utf8');
    };
    const production = build();
    const withHooks = build('--test');
    expect(withHooks).toContain('--bulwark-test-policy-poll=');
    expect(withHooks).toContain('BulwarkTest');
    expect(production).not.toContain('--bulwark-test-policy');
    expect(production).not.toContain('BulwarkTest');
    // Nothing in a real build can move the quick compose keys, or hold none.
    expect(withHooks).toContain('--bulwark-test-quick-compose-default=');
    expect(production).not.toContain('--bulwark-test-quick-compose-default=');
    // Dev switches hang on the build, not on the exe's name.
    for (const name of ['bulwark-user-data', 'bulwark-server-dir', 'bulwark-test-wrong-pin']) expect(production).not.toContain(name);
    expect(withHooks).toContain('bulwark-user-data');
    // A switch can't point telemetry or a crash file anywhere in a real build.
    expect(withHooks).toContain('--bulwark-test-${name}=');
    expect(production).not.toContain('--bulwark-test-${name}=');
  });
});

test.describe('what the app opens with', () => {
  const INSTANCE = 'https://mail.example.com/';

  test('nothing set: ask', () => {
    expect(decideStart(snapshot(), null, {})).toMatchObject({ kind: 'welcome', allowStandalone: true, instanceUrl: null, urlLocked: false });
  });

  test('forced goes over any choice, including the development switches', () => {
    const forced = snapshot({ InstanceUrl: INSTANCE });
    for (const choice of [{}, { mode: 'standalone' as const }, { mode: 'instance' as const, instanceUrl: 'https://other.example/' }, { devStandalone: true }, { devInstance: 'https://other.example' }, { askConnection: true }]) {
      expect(decideStart(forced, null, choice)).toEqual({ kind: 'instance', url: INSTANCE, forced: true, canSwitch: false });
    }
  });

  test('the user\'s choice goes over a recommendation, which goes over asking', () => {
    const recommended = snapshot({}, { InstanceUrl: INSTANCE });
    expect(decideStart(recommended, null, {})).toMatchObject({ kind: 'instance', url: INSTANCE, forced: false, canSwitch: true });
    expect(decideStart(recommended, null, { mode: 'standalone' })).toMatchObject({ kind: 'standalone' });
    expect(decideStart(recommended, null, { mode: 'instance', instanceUrl: 'https://mine.example/' })).toMatchObject({ kind: 'instance', url: 'https://mine.example/' });
  });

  test('"Change Connection" shows the choice once, also over a recommendation', () => {
    expect(decideStart(snapshot({}, { InstanceUrl: INSTANCE }), null, { askConnection: true })).toMatchObject({ kind: 'welcome', instanceUrl: INSTANCE, urlLocked: false });
  });

  each([
    ['http://mail.example.com', 'insecure'],
    ['file:///c:/evil', 'scheme'],
    ['not a url', 'invalid_url'],
  ])('a forced %s stops with an error naming the policy, whatever was chosen before', (raw, reason) => {
    const bad = snapshot({ InstanceUrl: raw });
    for (const choice of [{}, { mode: 'standalone' as const }, { mode: 'instance' as const, instanceUrl: 'https://mine.example/' }, { devStandalone: true }]) {
      expect(decideStart(bad, null, choice)).toEqual({ kind: 'policy-error', policy: 'InstanceUrl', reason, raw, canSwitch: false });
    }
  });

  test('http works with AllowInsecureInstance', () => {
    expect(decideStart(snapshot({ InstanceUrl: 'http://bulwark.lan', AllowInsecureInstance: 1 }), null, {})).toMatchObject({ kind: 'instance', url: 'http://bulwark.lan/' });
  });

  test('a problem with the policy source itself also stops', () => {
    expect(decideStart(snapshot(), { policy: '/etc/bulwark/policies.json', reason: 'writable_by_others' }, { mode: 'standalone' })).toMatchObject({ kind: 'policy-error', policy: '/etc/bulwark/policies.json' });
  });

  test('AllowStandalone 0 takes direct connections away, also from who chose them, and keeps their choice stored', () => {
    const off = snapshot({ AllowStandalone: 0 });
    expect(decideStart(off, null, { mode: 'standalone' })).toMatchObject({ kind: 'welcome', allowStandalone: false });
    expect(decideStart(off, null, { devStandalone: true })).toMatchObject({ kind: 'welcome', allowStandalone: false });
    expect(decideStart(off, null, { mode: 'instance', instanceUrl: 'https://mine.example/' })).toMatchObject({ kind: 'instance' });
  });

  test('a forced server with AllowStandalone 1 lets the user pick direct connections', () => {
    const both = snapshot({ InstanceUrl: INSTANCE, AllowStandalone: 1 });
    expect(standaloneAllowed(both)).toBe(true);
    expect(decideStart(both, null, {})).toEqual({ kind: 'instance', url: INSTANCE, forced: true, canSwitch: true });
    expect(decideStart(both, null, { mode: 'standalone' })).toMatchObject({ kind: 'standalone' });
    expect(decideStart(both, null, { askConnection: true })).toMatchObject({ kind: 'welcome', allowStandalone: true, instanceUrl: INSTANCE, urlLocked: true });
  });

  test('AllowedJmapServers also covers a server anyone chose', () => {
    const listed = { AllowedJmapServers: ['https://mail.example.com'] };
    const stored = { mode: 'instance' as const, instanceUrl: 'https://mine.example/' };
    expect(decideStart(snapshot(listed), null, stored)).toMatchObject({ kind: 'welcome' });
    expect(decideStart(snapshot(listed), null, { mode: 'instance', instanceUrl: INSTANCE })).toMatchObject({ kind: 'instance', url: INSTANCE });
    expect(decideStart(snapshot(listed), null, { devInstance: 'https://mine.example' })).toMatchObject({ kind: 'welcome' });
    // A recommendation has to be on it as well.
    expect(decideStart(snapshot(listed, { InstanceUrl: 'https://mine.example' }), null, {})).toMatchObject({ kind: 'welcome', instanceUrl: null });
    // A forced one is the admin's own word.
    expect(decideStart(snapshot({ ...listed, InstanceUrl: 'https://mine.example' }), null, {})).toMatchObject({ kind: 'instance', forced: true });
  });

  test('a recommended AllowStandalone can\'t open what a forced server closed', () => {
    const both = snapshot({ InstanceUrl: INSTANCE }, { AllowStandalone: 1 });
    expect(standaloneAllowed(both)).toBe(false);
    expect(decideStart(both, null, { mode: 'standalone' })).toEqual({ kind: 'instance', url: INSTANCE, forced: true, canSwitch: false });
  });

  test('"Later" only lasts where nothing forced moved', () => {
    const on = (url: string) => ({ kind: 'instance' as const, url, forced: true, canSwitch: false });
    const chosen = { kind: 'instance' as const, url: INSTANCE, forced: false, canSwitch: true };
    const standalone = { kind: 'standalone' as const, canSwitch: true };
    const welcome = { kind: 'welcome' as const, allowStandalone: false, instanceUrl: null, urlLocked: false, canSwitch: false as const };
    const error = { kind: 'policy-error' as const, policy: 'InstanceUrl', reason: 'scheme', canSwitch: false as const };
    expect(connectionMustChange(on('https://a.example/'), on('https://b.example/'))).toBe(true);
    expect(connectionMustChange(chosen, on('https://b.example/'))).toBe(true);
    expect(connectionMustChange(on('https://a.example/'), error)).toBe(true);
    expect(connectionMustChange(standalone, welcome)).toBe(true);
    // Lifted: nothing is wrong with staying.
    expect(connectionMustChange(on('https://a.example/'), chosen)).toBe(false);
    expect(connectionMustChange(on('https://a.example/'), on('https://a.example/'))).toBe(false);
    expect(connectionMustChange(error, error)).toBe(false);
  });

  test('a restart is only worth asking for when the outcome changes', () => {
    const a = snapshot({ InstanceUrl: INSTANCE });
    const key = (s: typeof a) => restartKey(decideStart(s, null, {}), s);
    expect(key(snapshot({ InstanceUrl: INSTANCE, UpdateChannel: 'beta' }))).toBe(key(a));
    expect(key(snapshot({ InstanceUrl: 'https://other.example' }))).not.toBe(key(a));
    expect(key(snapshot({ InstanceUrl: INSTANCE, AuthServerAllowlist: '*.example.com' }))).not.toBe(key(a));
  });
});

test.describe('the switches a production build refuses', () => {
  const EXE = 'Bulwark.exe';

  each([
    '--remote-debugging-port=9347', '--remote-debugging-pipe', '--remote-allow-origins=*', '--inspect=9229', '--inspect-brk', '--user-data-dir=C:\\x',
    '--host-rules=MAP * 1.2.3.4', '--host-resolver-rules=MAP * 1.2.3.4', '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list=a',
    '--proxy-server=1.2.3.4:80', '--proxy-pac-url=http://x', '--proxy-bypass-list=*', '--no-proxy-server', '--no-sandbox', '--disable-gpu-sandbox',
    '--disable-web-security', '--allow-running-insecure-content', '--disable-features=X', '--enable-features=X', '--js-flags=--x', '--load-extension=C:\\x',
    '--disable-site-isolation-trials', '--auth-server-whitelist=*', '--renderer-cmd-prefix=x', '--browser-subprocess-path=x', '--ssl-key-log-file=x', '--log-net-log=x',
    '--unsafely-treat-insecure-origin-as-secure=http://x',
  ])('%s', (arg) => {
    expect(deniedSwitches([EXE, arg], 'linux').length).toBe(1);
    expect(withoutDeniedSwitches([EXE, arg, 'bulwark://x'], 'linux')).toEqual([EXE, 'bulwark://x']);
  });

  test('Windows also takes -name and /name, in any case', () => {
    for (const arg of ['-remote-debugging-port=9', '/remote-debugging-port=9', '--REMOTE-DEBUGGING-PORT=9', '/NO-SANDBOX']) {
      expect(deniedSwitches([EXE, arg], 'win32').length).toBe(1);
    }
    expect(deniedSwitches([EXE, '/remote-debugging-port=9'], 'linux')).toEqual([]);
  });

  test('leaves the rest alone: the exe itself, ordinary switches, a link, and what follows --', () => {
    const argv = [EXE, '--lang=de', '--ozone-platform=wayland', '--port-retry', 'mailto:a@example.org', '--', '--no-sandbox'];
    expect(deniedSwitches(argv, 'linux')).toEqual([]);
    expect(withoutDeniedSwitches(argv, 'linux')).toEqual(argv);
  });

  test('names each once', () => {
    expect(deniedSwitches([EXE, '--no-sandbox', '--no-sandbox=1'], 'linux')).toEqual(['no-sandbox']);
  });
});

test.describe('a sign-in chain', () => {
  test('runs until it ends, with no limit where nothing is forced', () => {
    let now = 0;
    const chain = new SsoChain(() => null, () => now);
    expect(chain.active()).toBe(false);
    chain.start();
    now = FORCED_SSO_LIMIT_MS * 10;
    expect(chain.active()).toBe(true);
    chain.end();
    expect(chain.active()).toBe(false);
  });

  test('has a limit when the server is forced', () => {
    let now = 0;
    const chain = new SsoChain(() => FORCED_SSO_LIMIT_MS, () => now);
    chain.start();
    now = FORCED_SSO_LIMIT_MS;
    expect(chain.active()).toBe(true);
    now += 1;
    expect(chain.active()).toBe(false);
    expect(chain.active()).toBe(false);
  });
});

test.describe('every key has someone acting on it', () => {
  test('the shell\'s named consumers read their key', () => {
    for (const key of POLICY_KEYS) {
      const consumer = POLICY_CONSUMERS[key];
      if ('repo' in consumer && consumer.repo === 'shell') {
        expect(readFileSync(path.resolve(import.meta.dirname, '..', consumer.file), 'utf8'), key).toContain(key);
      }
    }
  });

  test('a key nobody wired yet names who owes it', () => {
    const pending = POLICY_KEYS.filter((key) => 'pendingConsumer' in POLICY_CONSUMERS[key]);
    expect(pending.sort()).toEqual(['AutoSelectCertificateForUrls', 'AutoUpdate', 'UpdateChannel'].sort());
    for (const key of pending) expect((POLICY_CONSUMERS[key] as { pendingConsumer: string }).pendingConsumer).toMatch(/\S{3}/);
  });
});

test.describe('the MSI properties', () => {
  const require = createRequire(import.meta.url);
  const { addPolicies } = require('../scripts/msi-policies.cjs') as { addPolicies: (project: string) => string };
  const project = '<Wix><Product Id="*"><Feature Id="ProductFeature" Absent="disallow">\n<ComponentGroupRef Id="ProductComponents"/></Feature>\n  </Product></Wix>';

  test('writes the forced key with FORCE_INSTANCE=1, and Recommended without, and clears the other', () => {
    const out = addPolicies(project);
    expect(out).toMatch(/INSTANCE_URL AND FORCE_INSTANCE = "1"[\s\S]*?Key="SOFTWARE\\Policies\\Bulwark\\Desktop" Name="InstanceUrl"[^>]*Value="\[INSTANCE_URL\]"[\s\S]*?RemoveRegistryValue Root="HKLM" Key="SOFTWARE\\Policies\\Bulwark\\Desktop\\Recommended" Name="InstanceUrl"/);
    expect(out).toMatch(/INSTANCE_URL AND NOT FORCE_INSTANCE = "1"[\s\S]*?Key="SOFTWARE\\Policies\\Bulwark\\Desktop\\Recommended" Name="InstanceUrl"[\s\S]*?RemoveRegistryValue Root="HKLM" Key="SOFTWARE\\Policies\\Bulwark\\Desktop" Name="InstanceUrl"/);
    expect(out).toMatch(/FORCE_INSTANCE = "1"[\s\S]*?Key="SOFTWARE\\Policies\\Bulwark\\Desktop" Name="UpdateChannel"/);
  });

  test('a standard user\'s repair can\'t set them: not secure properties', () => {
    const out = addPolicies(project);
    for (const id of ['INSTANCE_URL', 'FORCE_INSTANCE', 'UPDATE_CHANNEL']) expect(out).not.toContain(`<Property Id="${id}"`);
    expect(out).not.toContain('Secure="yes"');
  });

  test('a repair or upgrade writes back what was there, and a real uninstall removes it', () => {
    const out = addPolicies(project);
    expect(out).toContain('<Property Id="BW_PREV_FORCED_URL">');
    expect(out).toMatch(/RegistrySearch[^>]*Key="SOFTWARE\\Policies\\Bulwark\\Desktop"[^>]*Name="InstanceUrl"[^>]*Win64="yes"/);
    expect(out).toContain('<SetProperty Id="INSTANCE_URL" Value="[BW_PREV_FORCED_URL]"');
    expect(out).not.toContain('Permanent="yes"');
    for (const [, id] of out.matchAll(/<Component Id="([^"]+)"/g)) expect(out).toContain(`<ComponentRef Id="${id}"/>`);
    expect(out.match(/<RegistryValue Root="HKLM"/g)).toHaveLength(4);
  });

  test('FORCE_INSTANCE without a server stops the install', () => {
    expect(addPolicies(project)).toMatch(/<Condition Message="FORCE_INSTANCE=1 needs INSTANCE_URL[^"]*"><!\[CDATA\[Installed OR NOT FORCE_INSTANCE = "1" OR INSTANCE_URL/);
  });

  test('refuses a project it does not recognise, rather than shipping without the switches', () => {
    expect(() => addPolicies('<Wix/>')).toThrow('does not look as expected');
  });
});
