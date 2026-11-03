/**
 * OS policies: reads them (policy-read.ts) before `ready`, resolves them
 * (shared/policy-schema.ts, a copy of the webmail's), keeps them live, and hands them
 * to the rest of the app. Features read `policies.snapshot` and listen for `changed`.
 * The webmail reads them through the bridge's `policy` member.
 *
 * Only `Software\Policies` is read, and on Windows nothing a standard user can write.
 * Nothing the app stores itself ever counts as a policy.
 */

import { EventEmitter } from 'node:events';
import { lstatSync, readFileSync, watch as watchFile } from 'node:fs';
import { createRequire } from 'node:module';
import { dialog, ipcMain, systemPreferences, type CommandLine, type WebContents } from 'electron';
import { CHANNEL } from '../../shared/bridge';
import {
  DEFAULT_POLICY_SNAPSHOT,
  POLICY_BUNDLE_ID,
  POLICY_LINUX_FILE,
  POLICY_RECOMMENDED_SUBKEY,
  POLICY_REGISTRY_ROOT,
  jmapServerAllowed,
  pluginAllowedByPolicy,
  resolvePolicies,
  serverPolicyOf,
  type PolicySnapshot,
  type ServerPolicy,
} from '../../shared/policy-schema';
import { senderAllowed } from '../ipc';
import type { PluginPolicyCheck } from '../plugins';
import {
  REAL_REGISTRY_TARGETS,
  readMacPreferences,
  readPolicyFile,
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
import type { StateFile } from '../state';
import type { Feature, FeatureContext } from '.';

// Set by build.mjs: true only with --test. Dropped from what a package holds, since a
// renamed Bulwark.exe would pass any check on app.isPackaged.
declare const __BULWARK_TEST_BUILD__: boolean;

/** A value written with `reg add` or by an installer fires no event. Group Policy does. */
const POLL_MS = 2 * 60_000;
const MAX_REMEMBERED_WIPES = 32;

function loadWatcher(): CreateWatcher | null {
  try {
    const require = createRequire(import.meta.url);
    return (require('@vscode/policy-watcher') as { createWatcher: CreateWatcher }).createWatcher;
  } catch (error) {
    console.warn('The policy watcher is not available:', error);
    return null;
  }
}

function registryPathOf(key: string): string {
  return key.replace(/^HK[A-Z_]+\\/i, '');
}

export interface PolicyEvents {
  /** The resolved values changed. */
  changed: [snapshot: PolicySnapshot, previous: PolicySnapshot];
  /**
   * A forced WipeOfflineData value the app hasn't acted on. Delete local mail, then
   * call `markWipeDone`. Fires once per value per run, until someone marks it done.
   */
  'wipe-offline-data': [nonce: string];
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

  /** Reads once. Awaited at the top of main, since the auth switches must be set before `ready`. */
  async start(options: { argv: string[]; isPackaged: boolean }): Promise<void> {
    if (__BULWARK_TEST_BUILD__) {
      const root = testPolicyRoot(options.argv, options.isPackaged);
      if (root) this.targets = testRegistryTargets(root);
      const poll = options.argv.find((arg) => arg.startsWith('--bulwark-test-policy-poll='));
      if (poll) this.pollMs = Number(poll.split('=')[1]) || POLL_MS;
    }
    if (process.platform !== 'linux') this.watcher = loadWatcher();
    await this.refresh(true);
  }

  /** The native helper's objectIsForcedForKey, on macOS. */
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
      return { ok: true, layers: readMacPreferences(systemPreferences, this.forcedCheck) };
    }
    return readPolicyFile(POLICY_LINUX_FILE, { lstat: (file) => lstatSync(file), read: (file) => readFileSync(file, 'utf8') });
  }

  private policyName(): string {
    return process.platform === 'linux' ? POLICY_LINUX_FILE : POLICY_REGISTRY_ROOT;
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
          this.problem = { policy: this.policyName(), reason: read.reason };
          if (changed && !first) this.emit('changed', this.snapshot, previous);
        }
        return;
      }
      const hadProblem = this.problem !== null;
      this.problem = null;
      const next = resolvePolicies(read.layers);
      const same = JSON.stringify(next) === JSON.stringify(previous);
      if (!same) this.snapshot = next;
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

  /** Chromium reads these once, when its network service starts: before `ready`. */
  applySwitches(commandLine: CommandLine): void {
    const servers = this.snapshot.AuthServerAllowlist.value;
    if (servers) commandLine.appendSwitch('auth-server-whitelist', servers);
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
  markWipeDone(nonce: string): void {
    if (!this.state) return;
    const done = this.state.data.policyWipes ?? [];
    if (done.includes(nonce)) return;
    this.state.data.policyWipes = [...done, nonce].slice(-MAX_REMEMBERED_WIPES);
    this.state.save();
  }

  announceWipe(): void {
    const nonce = this.pendingWipe();
    if (!nonce || this.wipeAnnounced.has(nonce)) return;
    this.wipeAnnounced.add(nonce);
    this.emit('wipe-offline-data', nonce);
  }
}

export const policies = new PolicyManager();

/**
 * Hands a pending wipe to one window that asked to hear about it. The page's handlers
 * run in the preload, which answers when they've finished. A window that goes away
 * first passes it to the next one, or to the next launch.
 */
function setupWipe(ctx: FeatureContext): void {
  const listening = new Set<WebContents>();
  let inFlight: { nonce: string; contents: WebContents } | null = null;

  const dispatch = () => {
    policies.announceWipe();
    const nonce = policies.pendingWipe();
    if (!nonce || inFlight) return;
    const contents = [...listening].find((candidate) => !candidate.isDestroyed());
    if (!contents) return;
    inFlight = { nonce, contents };
    contents.send(CHANNEL.policyWipeRequest, nonce);
  };

  const release = (contents: WebContents) => {
    listening.delete(contents);
    if (inFlight?.contents === contents) inFlight = null;
    dispatch();
  };

  ctx.on(CHANNEL.policyWipeListen, (event) => {
    const contents = event.sender;
    // A reload comes back with a fresh preload: what it was doing is gone.
    if (inFlight?.contents === contents) inFlight = null;
    if (!listening.has(contents)) contents.once('destroyed', () => release(contents));
    listening.add(contents);
    dispatch();
  });
  ctx.on(CHANNEL.policyWipeDone, (event, _window, nonce, ok) => {
    if (inFlight?.contents !== event.sender || inFlight.nonce !== nonce) return;
    inFlight = null;
    if (ok === true) policies.markWipeDone(nonce as string);
    else listening.delete(event.sender);
    dispatch();
  });
  policies.on('changed', dispatch);
  dispatch();
}

/**
 * On an instance only the page's own gate stops a plugin, and an older instance has
 * no such gate. So the shell also refuses what a plugin needs to start. That's a
 * backstop only: with `allowlist` an older instance can still start a bundle it has
 * cached. The instance's admin area is out of reach of this, as it should be.
 */
function blockPluginsOnInstance(ctx: FeatureContext): void {
  const refuse = (url: string): boolean => {
    const { value: mode } = policies.snapshot.PluginsMode;
    if (mode === 'allowed') return false;
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return true;
    }
    if (mode === 'off' && pathname.startsWith('/plugin-sandbox')) return true;
    const bundle = /^\/api\/admin\/plugins\/([^/]+)\/bundle$/.exec(pathname);
    return bundle ? !pluginAllowedByPolicy(mode, policies.snapshot.PluginAllowlist.value, decodeURIComponent(bundle[1])) : false;
  };
  ctx.session.webRequest.onBeforeRequest({ urls: [`${ctx.origin}/plugin-sandbox*`, `${ctx.origin}/api/admin/plugins/*`] }, (details, callback) => {
    callback({ cancel: refuse(details.url) });
  });
}

export const policiesFeature: Feature = {
  name: 'policies',
  modes: ['standalone', 'instance'],
  setup(ctx) {
    policies.attachState(ctx.state);
    // Sent while the preload runs, so the page never sees a moment without values. A
    // sync message always needs an answer, also for a sender that gets nothing.
    ipcMain.on(CHANNEL.policyGet, (event) => {
      event.returnValue = senderAllowed(event.senderFrame, ctx.origin) ? policies.snapshot : null;
    });
    policies.on('changed', (snapshot) => ctx.windows.broadcast(CHANNEL.policyChanged, snapshot));
    setupWipe(ctx);
    if (ctx.mode === 'instance') blockPluginsOnInstance(ctx);
    policies.watch();
  },
};

/** Asks once per change. The answer can wait: a window with work in it isn't taken away. */
export async function askToRestart(message: string, detail: string, restart: string, later: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox({ type: 'info', title: 'Bulwark', message, detail, buttons: [restart, later], defaultId: 0, cancelId: 1, noLink: true });
  return response === 0;
}
