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
  readMacPreferences,
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
import { decideStart, restartKey, standaloneAllowed } from '../src/main/policy-start';
import { EMPTY_POLICY_LAYERS, POLICY_KEYS, resolvePolicies, type PolicyLayer } from '../src/shared/policy-schema';

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

  test('objectIsForcedForKey decides between forced and recommended', () => {
    const layers = readMacPreferences(prefs({ InstanceUrl: 'https://a.example', AutoUpdate: '0' }), (key) => key === 'InstanceUrl');
    expect(layers.forcedMachine).toEqual({ InstanceUrl: 'https://a.example' });
    expect(layers.recommendedMachine).toEqual({ AutoUpdate: '0' });
  });

  test('an absent key isn\'t read as false or empty', () => {
    const layers = readMacPreferences(prefs({}), () => true);
    expect(layers.forcedMachine).toEqual({});
    expect(resolvePolicies(layers).AllowStandalone.source).toBe('default');
  });

  test('booleans come as "1" and "0" and still resolve', () => {
    const layers = readMacPreferences(prefs({ AllowStandalone: '0' }), () => true);
    expect(resolvePolicies(layers).AllowStandalone).toMatchObject({ value: false, locked: true });
  });

  test('without the native helper, a value counts as forced', () => {
    expect(readMacPreferences(prefs({ PluginsMode: 'off' }), null).forcedMachine).toEqual({ PluginsMode: 'off' });
  });

  test('a list and the Recommended dictionary', () => {
    const layers = readMacPreferences(prefs({ PluginAllowlist: ['a'], Recommended: { UpdateChannel: 'beta', Junk: 1 } }), () => true);
    expect(layers.forcedMachine.PluginAllowlist).toEqual(['a']);
    expect(layers.recommendedMachine).toEqual({ UpdateChannel: 'beta' });
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

  test('a restart is only worth asking for when the outcome changes', () => {
    const a = snapshot({ InstanceUrl: INSTANCE });
    const key = (s: typeof a) => restartKey(decideStart(s, null, {}), s);
    expect(key(snapshot({ InstanceUrl: INSTANCE, UpdateChannel: 'beta' }))).toBe(key(a));
    expect(key(snapshot({ InstanceUrl: 'https://other.example' }))).not.toBe(key(a));
    expect(key(snapshot({ InstanceUrl: INSTANCE, AuthServerAllowlist: '*.example.com' }))).not.toBe(key(a));
  });
});

test('the shell\'s copy of the schema has every key', () => {
  expect(POLICY_KEYS).toHaveLength(18);
});

test.describe('the MSI properties', () => {
  const require = createRequire(import.meta.url);
  const { addPolicies } = require('../scripts/msi-policies.cjs') as { addPolicies: (project: string) => string };
  const project = '<Wix><Product Id="*"><Feature Id="ProductFeature" Absent="disallow">\n<ComponentGroupRef Id="ProductComponents"/></Feature>\n  </Product></Wix>';

  test('writes the forced key with FORCE_INSTANCE=1, and Recommended without', () => {
    const out = addPolicies(project);
    for (const id of ['INSTANCE_URL', 'FORCE_INSTANCE', 'UPDATE_CHANNEL']) expect(out).toContain(`<Property Id="${id}" Secure="yes"/>`);
    expect(out).toMatch(/INSTANCE_URL AND FORCE_INSTANCE = "1"[\s\S]*?Key="SOFTWARE\\Policies\\Bulwark\\Desktop" Name="InstanceUrl"[^>]*Value="\[INSTANCE_URL\]"/);
    expect(out).toMatch(/INSTANCE_URL AND NOT FORCE_INSTANCE = "1"[\s\S]*?Key="SOFTWARE\\Policies\\Bulwark\\Desktop\\Recommended" Name="InstanceUrl"/);
    expect(out).toMatch(/UPDATE_CHANNEL AND FORCE_INSTANCE = "1"[\s\S]*?Key="SOFTWARE\\Policies\\Bulwark\\Desktop" Name="UpdateChannel"/);
    expect(out).toMatch(/UPDATE_CHANNEL AND NOT FORCE_INSTANCE = "1"[\s\S]*?Recommended" Name="UpdateChannel"/);
  });

  test('every component is in the feature, is permanent, and sits in HKLM', () => {
    const out = addPolicies(project);
    const components = [...out.matchAll(/<Component Id="([^"]+)"[^>]*>/g)];
    expect(components).toHaveLength(4);
    for (const [tag, id] of components) {
      expect(tag).toContain('Permanent="yes"');
      expect(out).toContain(`<ComponentRef Id="${id}"/>`);
    }
    expect(out.match(/Root="HKLM"/g)).toHaveLength(4);
  });

  test('refuses a project it does not recognise, rather than shipping without the switches', () => {
    expect(() => addPolicies('<Wix/>')).toThrow('does not look as expected');
  });
});
