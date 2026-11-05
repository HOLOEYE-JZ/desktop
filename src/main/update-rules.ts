/**
 * The updater's decisions, with no Electron in them: which channel applies, whether
 * this copy can install an update by itself, and what a version from the feed means.
 */

import type { UpdateAbility, UpdateChannel } from '../shared/bridge';
import type { PolicySnapshot } from '../shared/policy-schema';

export interface UpdatePolicy {
  /** `AutoUpdate`, forced. False: no network requests for updates at all. There's no user's choice to recommend for. */
  autoUpdate?: boolean;
  /** `UpdateChannel`, forced. The user can't change it. */
  channel?: UpdateChannel;
  /** `UpdateChannel`, recommended. The user's own choice goes first. */
  recommendedChannel?: UpdateChannel;
}

/**
 * What the policy reader says, passing on only values really set. The schema's defaults
 * aren't anyone's decision: `stable` as a forced channel would lock everyone and move
 * betas off beta.
 */
export function updatePolicyFrom(snapshot: Pick<PolicySnapshot, 'AutoUpdate' | 'UpdateChannel'>): UpdatePolicy {
  const { AutoUpdate: auto, UpdateChannel: channel } = snapshot;
  const policy: UpdatePolicy = {};
  if (auto.locked) policy.autoUpdate = auto.value;
  if (channel.locked) policy.channel = channel.value;
  else if (channel.source !== 'default') policy.recommendedChannel = channel.value;
  return policy;
}

function parts(version: string): { main: number[]; pre: string[] } {
  const clean = version.replace(/^v/, '').split('+')[0];
  const dash = clean.indexOf('-');
  const main = (dash === -1 ? clean : clean.slice(0, dash)).split('.').map((part) => Number(part) || 0);
  return { main, pre: dash === -1 ? [] : clean.slice(dash + 1).split('.') };
}

/** Semver order: negative if a is older than b. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const difference = (left.main[i] ?? 0) - (right.main[i] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) return Number(x) - Number(y);
    if (xNumber !== yNumber) return xNumber ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function isPrerelease(version: string): boolean {
  return parts(version).pre.length > 0;
}

/**
 * Forced > the user's choice > recommended. Then a beta is on beta, so it finds the next one,
 * and a stable version stays on what this copy started as.
 */
export function effectiveChannel(policy: UpdatePolicy, userChoice: UpdateChannel | undefined, currentVersion: string, initial?: UpdateChannel): UpdateChannel {
  return policy.channel ?? userChoice ?? policy.recommendedChannel ?? (isPrerelease(currentVersion) ? 'beta' : initial ?? 'stable');
}

/** A repo with nothing for this channel yet answers with these: not a failure, nothing to get. */
export function nothingPublished(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  const text = typeof message === 'string' ? message : '';
  if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS') return true;
  // An empty feed. electron-updater looks for the first entry with a generic XML helper.
  if (code === 'ERR_XML_MISSED_ELEMENT') return text.startsWith('No published versions');
  // Only prereleases: GitHub answers 406 for the latest release, and electron-updater wraps
  // that error in a "cannot parse" one. A 5xx or a lost connection gets here too, and stays an error.
  if (code === 'ERR_UPDATER_INVALID_RELEASE_FEED' || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND') {
    return /production release exists: \w*Error: 40[46]\b/.test(text);
  }
  return false;
}

export type InstallKind = 'dev' | 'nsis' | 'windows-other' | 'mac-signed' | 'mac-unsigned' | 'appimage' | 'deb' | 'rpm' | 'linux-other';

export interface InstallFacts {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** An NSIS install has its uninstaller next to the exe. An MSI or a copied folder doesn't. */
  hasNsisUninstaller: boolean;
  /** `$APPIMAGE`, set by the AppImage runtime. */
  appImage?: string;
  /** resources/package-type, written by electron-builder for deb and rpm. */
  packageType?: string;
  macSigned?: boolean;
}

export function installKind(facts: InstallFacts): InstallKind {
  if (!facts.isPackaged) return 'dev';
  if (facts.platform === 'win32') return facts.hasNsisUninstaller ? 'nsis' : 'windows-other';
  if (facts.platform === 'darwin') return facts.macSigned ? 'mac-signed' : 'mac-unsigned';
  if (facts.appImage) return 'appimage';
  if (facts.packageType === 'deb' || facts.packageType === 'rpm') return facts.packageType;
  return 'linux-other';
}

/**
 * `install`: downloads and replaces itself. `notify`: says a version exists and links
 * to it. An MSI is notify, since electron-updater only knows how to run an NSIS
 * installer, which would put a second copy next to it. Unsigned macOS is notify, since
 * Squirrel.Mac refuses unsigned bundles. deb and rpm need root and come from a package
 * manager or from IT.
 */
export function updateAbility(kind: InstallKind): UpdateAbility {
  if (kind === 'dev') return 'none';
  return kind === 'nsis' || kind === 'appimage' || kind === 'mac-signed' ? 'install' : 'notify';
}

/**
 * Whether an update downloads only the blocks that changed. On Windows: the release workflow
 * publishes a blockmap next to each installer, and the NSIS installer keeps a copy of itself
 * in the updater's cache as the base. Anything that goes wrong on the way falls back to the
 * whole installer, which is checked against latest.yml's sha512 either way. The other
 * platforms publish no blockmaps, so trying would only cost a failed request first.
 */
export function differentialDownloads(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

export type FeedVerdict = 'newer' | 'same' | 'older-offer' | 'ignore';

/**
 * What a version from the feed means for the running one. An older version is only
 * ever an offer, on the stable channel, to someone running a beta. On any other
 * combination it's a pulled release or a feed that hasn't caught up, and not news.
 */
export function judgeFeedVersion(current: string, latest: string, channel: UpdateChannel): FeedVerdict {
  // Stable never takes a prerelease, whatever a feed says. Not even the same one again.
  if (channel === 'stable' && isPrerelease(latest)) return 'ignore';
  const order = compareVersions(latest, current);
  if (order > 0) return 'newer';
  if (order === 0) return 'same';
  return channel === 'stable' && isPrerelease(current) ? 'older-offer' : 'ignore';
}

export interface WantedDownload {
  version: string;
  /** The user agreed to go back to an older version. */
  older: boolean;
}

/**
 * Whether a finished download may be installed. The channel or a policy can move while it
 * comes down, and electron-updater reports it done regardless.
 */
export function acceptDownload(facts: { allowed: boolean; wanted: WantedDownload | null; version: string; current: string; channel: UpdateChannel }): boolean {
  const { allowed, wanted, version, current, channel } = facts;
  if (!allowed || !wanted || wanted.version !== version) return false;
  const verdict = judgeFeedVersion(current, version, channel);
  return verdict === 'newer' || (wanted.older && verdict === 'older-offer');
}

/** The hosts update traffic may reach, on every hop. A test build adds its own feed. */
export function updateUrlAllowed(url: string, testOrigin?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (testOrigin && parsed.origin === testOrigin) return true;
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'github.com' || host.endsWith('.githubusercontent.com');
}

/** The highest stable, rc or beta version a releases feed names. Alpha and anything else stay out. */
export function newestReleaseInFeed(atom: string): string | null {
  let newest: string | null = null;
  for (const match of atom.matchAll(/\/tag\/v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)"/g)) {
    const version = match[1];
    const pre = version.includes('-') ? version.slice(version.indexOf('-') + 1).split('.')[0] : null;
    if (pre !== null && pre !== 'beta' && pre !== 'rc') continue;
    if (newest === null || compareVersions(version, newest) > 0) newest = version;
  }
  return newest;
}
