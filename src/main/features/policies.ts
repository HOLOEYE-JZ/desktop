/**
 * OS policies: reads them (policy-read.ts) before `ready`, resolves them
 * (shared/policy-schema.ts, a copy of the webmail's), keeps them live, and hands them
 * to the rest of the app. Features read `policies.snapshot` and listen for `changed`.
 * The webmail reads them through the bridge's `policy` member.
 *
 * Only `Software\Policies` is read, and on Windows nothing a standard user can write.
 * Nothing the app stores itself ever counts as a policy.
 */

import { addonMayLoad, type AddonPins } from '../addon-pins';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { lstatSync, readFileSync, watch as watchFile, type Stats } from 'node:fs';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { app, ipcMain, systemPreferences, type CommandLine, type Session } from 'electron';
import { CHANNEL } from '../../shared/bridge';
import {
  DEFAULT_POLICY_SNAPSHOT,
  POLICY_BUNDLE_ID,
  POLICY_LINUX_FILE,
  POLICY_MAX_FILE_BYTES,
  POLICY_RECOMMENDED_SUBKEY,
  jmapServerAllowed,
  pagePolicySnapshot,
  pluginAllowedByPolicy,
  policyProblems,
  resolvePolicies,
  serverPolicyOf,
  type PolicySnapshot,
  type ServerPolicy,
} from '../../shared/policy-schema';
import { NO_INTEGRATED_SIGN_IN } from '../client-auth';
import { senderAllowed } from '../ipc';
import type { PluginPolicyCheck } from '../plugins';
import {
  REAL_REGISTRY_TARGETS,
  managedPlistPaths,
  managedPlistProblem,
  policySourceName,
  readMacPolicies,
  readPolicyFile,
  type ReadManagedPlist,
  readRegistry,
  readThroughWatcher,
  testPolicyRoot,
  testRegistryTargets,
  watchMacPreferences,
  watchRegistry,
  type CreateWatcher,
  type PolicyReadResult,
  type RegistryTargets,
} from '../policy-read';
import { standaloneAllowed, type PolicySourceProblem } from '../policy-start';
import { requestGate } from '../request-gate';
import type { StateFile } from '../state';
import { keystorePolicyChanged, setKeystoreOffPolicy } from '../keystore-policy';
import { setKeystoreAllowedOrigins } from './keystore';
import { clearStoreFiles, runLocalWipe } from './local-wipe';
import type { Feature, FeatureContext } from '.';
import { showMessageBox } from '../message-box';

// Set by build.mjs: true only with --test. Dropped from what a package holds, since a
// renamed Bulwark.exe would pass any check on app.isPackaged.
declare const __BULWARK_TEST_BUILD__: boolean;
declare const __BULWARK_ADDON_PINS__: AddonPins;

/** A value written with `reg add` or by an installer fires no event. Group Policy does. */
const POLL_MS = 2 * 60_000;
const MAX_REMEMBERED_WIPES = 32;
const RESTART_ASK_MS = 15 * 60_000;
const RESTART_DEADLINE_MS = 60 * 60_000;

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function loadWatcher(isPackaged: boolean): CreateWatcher | null {
  try {
    // The addon itself: that's all the package's index.js hands on, through `bindings`, and
    // electron-builder doesn't always package that. Without it the app hears nothing from
    // Group Policy, and has no way around a blocked reg.exe.
    const require = createRequire(import.meta.url);
    const file = path.join(path.dirname(require.resolve('@vscode/policy-watcher/package.json')), 'build', 'Release', 'vscode-policy-watcher.node');
    if (!addonMayLoad({ file, name: 'watcher', packaged: isPackaged || !__BULWARK_TEST_BUILD__, platform: process.platform, arch: process.arch, pins: __BULWARK_ADDON_PINS__ })) return null;
    return require(file) as CreateWatcher;
  } catch (error) {
    console.warn('The policy watcher is not available:', error);
    return null;
  }
}

/** Reads a root-owned managed preferences file through /usr/bin/plutil. No file is no policy. */
const readManagedPlistFile: ReadManagedPlist = (file) => {
  let facts: Stats;
  try {
    facts = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, values: null };
    return { ok: false, reason: 'plist_unreadable' };
  }
  const problem = managedPlistProblem(facts);
  if (problem) return { ok: false, reason: problem };
  try {
    const json = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', timeout: 5000, maxBuffer: POLICY_MAX_FILE_BYTES });
    return { ok: true, values: JSON.parse(json) as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'plist_unreadable' };
  }
};

function registryPathOf(key: string): string {
  return key.replace(/^HK[A-Z_]+\\/i, '');
}

export interface PolicyEvents {
  /** The resolved values changed. */
  changed: [snapshot: PolicySnapshot, previous: PolicySnapshot];
  /**
   * A forced WipeOfflineData value the app hasn't acted on, as its wipe starts. Fires once
   * per value per run. To delete more, see addWipeStep in local-wipe.ts.
   */
  'wipe-offline-data': [nonce: string];
  /** A wipe ran with windows open: they're blank now. */
}

export class PolicyManager extends EventEmitter<PolicyEvents> {
  snapshot: PolicySnapshot = DEFAULT_POLICY_SNAPSHOT;
  /** The source itself can't be trusted or read. The app stops with an error page. */
  problem: PolicySourceProblem | null = null;

  private targets: RegistryTargets = REAL_REGISTRY_TARGETS;
  private pollMs = POLL_MS;
  private watcher: CreateWatcher | null = null;
  private stops: (() => void)[] = [];
  private refreshing: Promise<void> | null = null;
  private forcedCheck: ((key: string) => boolean) | null = null;
  private state: StateFile | null = null;
  private wipeAnnounced = new Set<string>();
  private settling: Promise<void> = Promise.resolve();

  /** Reads once. Awaited at the top of main, since the auth switches must be set before `ready`. */
  async start(options: { argv: string[]; isPackaged: boolean }): Promise<void> {
    if (__BULWARK_TEST_BUILD__) {
      const root = testPolicyRoot(options.argv, options.isPackaged);
      if (root) this.targets = testRegistryTargets(root);
      const poll = options.argv.find((arg) => arg.startsWith('--bulwark-test-policy-poll='));
      if (poll) this.pollMs = Number(poll.split('=')[1]) || POLL_MS;
    }
    if (process.platform !== 'linux') this.watcher = loadWatcher(options.isPackaged);
    await this.refresh(true);
  }

  /** The native helper's objectIsForcedForKey, on macOS. Set before start(). */
  useForcedCheck(check: (key: string) => boolean): void {
    this.forcedCheck = check;
  }

  private async read(): Promise<PolicyReadResult> {
    if (process.platform === 'win32') {
      const read = await readRegistry(this.targets);
      if (read.ok || !this.watcher) return read;
      console.warn(`Reading policies with reg.exe failed (${read.reason}). Using the watcher's merged values.`);
      return readThroughWatcher(this.watcher, registryPathOf(this.targets.machine));
    }
    if (process.platform === 'darwin') {
      return readMacPolicies(systemPreferences, this.forcedCheck, managedPlistPaths(POLICY_BUNDLE_ID, userInfo().username), readManagedPlistFile);
    }
    return readPolicyFile(POLICY_LINUX_FILE, { lstat: (file) => lstatSync(file), read: (file) => readFileSync(file, 'utf8') });
  }

  async refresh(first = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const read = await this.read();
      const previous = this.snapshot;
      if (!read.ok) {
        // A later failure on Windows is a busy machine, not a change: what was read stands.
        if (first || process.platform === 'linux') {
          const changed = this.problem?.reason !== read.reason;
          this.problem = { policy: policySourceName(process.platform), reason: read.reason };
          if (changed && !first) this.emit('changed', this.snapshot, previous);
        }
        return;
      }
      const hadProblem = this.problem !== null;
      this.problem = null;
      const next = resolvePolicies(read.layers);
      const same = JSON.stringify(next) === JSON.stringify(previous);
      if (!same) {
        this.snapshot = next;
        for (const { key, reason, raw } of policyProblems(next)) {
          console.warn(`The policy ${key} can't be used as set (${reason}${raw ? `: ${raw}` : ''}). The stricter setting applies.`);
        }
      }
      if (first) return;
      if (!same || hadProblem) this.emit('changed', this.snapshot, previous);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Live from here on. */
  watch(): void {
    if (this.stops.length) return;
    const onChange = () => void this.refresh().catch((error) => console.error(error));
    const poll = setInterval(onChange, this.pollMs);
    poll.unref?.();
    this.stops.push(() => clearInterval(poll));
    if (process.platform === 'win32' && this.watcher) {
      const machine = registryPathOf(this.targets.machine);
      const user = registryPathOf(this.targets.user);
      const paths = machine === user
        ? [machine, `${machine}\\${POLICY_RECOMMENDED_SUBKEY}`]
        : [machine, user, `${machine}\\${POLICY_RECOMMENDED_SUBKEY}`, `${user}\\${POLICY_RECOMMENDED_SUBKEY}`];
      try {
        this.stops.push(watchRegistry(this.watcher, paths, onChange));
      } catch (error) {
        console.warn('The policy watcher did not start:', error);
      }
    } else if (process.platform === 'darwin' && this.watcher) {
      try {
        this.stops.push(watchMacPreferences(this.watcher, POLICY_BUNDLE_ID, onChange));
      } catch (error) {
        console.warn('The policy watcher did not start:', error);
      }
    } else if (process.platform === 'linux') {
      try {
        const directory = watchFile(POLICY_LINUX_FILE.slice(0, POLICY_LINUX_FILE.lastIndexOf('/')), onChange);
        directory.on('error', () => {});
        this.stops.push(() => directory.close());
      } catch {
        // No /etc/bulwark yet: the poll sees it when it comes.
      }
    }
  }

  stop(): void {
    for (const stop of this.stops.splice(0)) stop();
  }

  /**
   * Chromium reads these when its network service starts: before `ready`. With no list at
   * all, Windows' security zones would decide who gets the user's sign-in.
   */
  applySwitches(commandLine: CommandLine): void {
    commandLine.appendSwitch('auth-server-whitelist', this.snapshot.AuthServerAllowlist.value ?? NO_INTEGRATED_SIGN_IN);
    const delegates = this.snapshot.AuthNegotiateDelegateAllowlist.value;
    if (delegates) commandLine.appendSwitch('auth-negotiate-delegate-whitelist', delegates);
  }

  serverPolicy(): ServerPolicy {
    return serverPolicyOf(this.snapshot);
  }

  /** The `isAllowedByPolicy` hook of ServerRegistry. */
  readonly serverAllowed = (origin: string): boolean =>
    standaloneAllowed(this.snapshot) && jmapServerAllowed(this.snapshot.AllowedJmapServers.value, origin);

  /** The `pluginPolicy` hook of the install bridge. */
  readonly pluginPolicy: PluginPolicyCheck = (slug) =>
    pluginAllowedByPolicy(this.snapshot.PluginsMode.value, this.snapshot.PluginAllowlist.value, slug)
      ? { allowed: true }
      : { allowed: false, code: 'blocked_by_policy' };

  attachState(state: StateFile): void {
    this.state = state;
  }

  /** The forced nonce, unless it was acted on before, in this run or any earlier one. */
  pendingWipe(): string | null {
    const nonce = this.snapshot.WipeOfflineData.value;
    if (!nonce || !this.snapshot.WipeOfflineData.locked) return null;
    return this.state?.data.policyWipes?.includes(nonce) ? null : nonce;
  }

  /** Remembered per value, written at once: a crash right after must not delete again. */
  private markWipeDone(nonce: string): void {
    if (!this.state) return;
    const done = this.state.data.policyWipes ?? [];
    if (done.includes(nonce)) return;
    this.state.data.policyWipes = [...done, nonce].slice(-MAX_REMEMBERED_WIPES);
    this.state.save();
  }

  /**
   * What the policies say about data already on the device, for every partition, not only
   * the one in use: a new WipeOfflineData value, and OfflineEnabled forced off. Runs at each
   * boot before any window opens, and on a change. `inUse` is what pages have open: for
   * OfflineEnabled those clear account by account themselves.
   */
  async settleLocalData(inUse: readonly Session[] = []): Promise<void> {
    if (!this.state) return;
    this.settling = this.settling.then(() => this.settleOnce(inUse)).catch((error) => console.error(error));
    return this.settling;
  }

  private async settleOnce(inUse: readonly Session[]): Promise<void> {
    const state = this.state!;
    const userData = app.getPath('userData');
    const nonce = this.pendingWipe();
    if (nonce) {
      if (!this.wipeAnnounced.has(nonce)) {
        this.wipeAnnounced.add(nonce);
        this.emit('wipe-offline-data', nonce);
      }
      const { failed } = await runLocalWipe('policy-nonce', userData, state);
      // Done only if every partition is: otherwise the next start tries again.
      if (failed.length === 0) this.markWipeDone(nonce);
    }
    // Checked each time and not remembered: nothing else fills these while it's forced off,
    // and a note in the user's own profile could say it's done. A value that makes no sense
    // keeps offline off (the webmail reads it that way) but a typo deletes nothing.
    const { OfflineEnabled } = this.snapshot;
    if (OfflineEnabled.locked && OfflineEnabled.value === false && !OfflineEnabled.invalid) {
      await clearStoreFiles(userData, state, inUse);
    }
  }
}

/**
 * Ask again every so often, restart at the deadline: a user can't sit on a forced change
 * for good. A test build can shorten these.
 */
export function addRestartTimers(askAgain: () => void, restart: () => void): () => void {
  let askEvery = RESTART_ASK_MS;
  let deadline = RESTART_DEADLINE_MS;
  if (__BULWARK_TEST_BUILD__) {
    const times = process.argv.find((arg) => arg.startsWith('--bulwark-test-policy-restart='))?.split('=')[1]?.split(',').map(Number);
    if (times?.length === 2) [askEvery, deadline] = times;
  }
  const again = setInterval(askAgain, askEvery);
  const end = setTimeout(restart, deadline);
  return () => {
    clearInterval(again);
    clearTimeout(end);
  };
}

export const policies = new PolicyManager();

/**
 * On an instance only the page's own gate stops a plugin, and an older instance has
 * no such gate. So the shell also refuses what a plugin needs to start. That's a
 * backstop only: with `allowlist` an older instance can still start a bundle it has
 * cached. The instance's admin area is out of reach of this, as it should be.
 */
function blockPluginsOnInstance(ctx: FeatureContext): void {
  requestGate(ctx.session).add((url) => {
    const { value: mode } = policies.snapshot.PluginsMode;
    if (mode === 'allowed') return false;
    const parsed = parseUrl(url);
    if (!parsed) return true;
    if (parsed.origin !== ctx.origin) return false;
    if (mode === 'off' && parsed.pathname.startsWith('/plugin-sandbox')) return true;
    const bundle = /^\/api\/admin\/plugins\/([^/]+)\/bundle$/.exec(parsed.pathname);
    if (!bundle) return false;
    try {
      return !pluginAllowedByPolicy(mode, policies.snapshot.PluginAllowlist.value, decodeURIComponent(bundle[1]));
    } catch {
      // %E0 and the like: a name that can't be decoded is on no list.
      return true;
    }
  });
}

export const policiesFeature: Feature = {
  name: 'policies',
  modes: ['standalone', 'instance'],
  setup(ctx) {
    setKeystoreAllowedOrigins(() => policies.snapshot.KeystoreAllowedOrigins.value);
    setKeystoreOffPolicy(() => !policies.snapshot.KeystoreEnabled.value || policies.snapshot.PluginsMode.value === 'off');
    policies.on('changed', () => keystorePolicyChanged());
    policies.attachState(ctx.state);
    // Sent while the preload runs, so the page never sees a moment without values. A
    // sync message always needs an answer, also for a sender that gets nothing.
    ipcMain.on(CHANNEL.policyGet, (event) => {
      event.returnValue = senderAllowed(event.senderFrame, ctx.origin) ? pagePolicySnapshot(policies.snapshot) : null;
    });
    policies.on('changed', (snapshot) => ctx.windows.broadcast(CHANNEL.policyChanged, pagePolicySnapshot(snapshot)));
    policies.on('changed', () => void policies.settleLocalData([ctx.session]).catch((error) => console.error(error)));
    if (ctx.mode === 'instance') blockPluginsOnInstance(ctx);
    policies.watch();
  },
};

/** Asks once per change. The answer can wait: a window with work in it isn't taken away. */
export async function askToRestart(message: string, detail: string, restart: string, later: string): Promise<boolean> {
  const { response } = await showMessageBox({ type: 'info', title: 'Bulwark', message, detail, buttons: [restart, later], defaultId: 0, cancelId: 1, noLink: true });
  return response === 0;
}
