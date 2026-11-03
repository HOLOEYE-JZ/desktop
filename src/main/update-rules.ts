/**
 * The updater's decisions, with no Electron in them: which channel applies, whether
 * this copy can install an update by itself, and what a version from the feed means.
 */

import type { UpdateAbility, UpdateChannel } from '../shared/bridge';

export interface UpdatePolicy {
  /** `AutoUpdate`, forced. False: no network requests for updates at all. */
  autoUpdate?: boolean;
  /** `UpdateChannel`, forced. The user can't change it. */
  channel?: UpdateChannel;
  /** `UpdateChannel`, recommended. The user's own choice goes first. */
  recommendedChannel?: UpdateChannel;
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

/** Forced > the user's choice > recommended > what this build is. */
export function effectiveChannel(policy: UpdatePolicy, userChoice: UpdateChannel | undefined, currentVersion: string): UpdateChannel {
  return policy.channel ?? userChoice ?? policy.recommendedChannel ?? (isPrerelease(currentVersion) ? 'beta' : 'stable');
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

export type FeedVerdict = 'newer' | 'same' | 'older-offer' | 'ignore';

/**
 * What a version from the feed means for the running one. An older version is only
 * ever an offer, on the stable channel, to someone running a beta. On any other
 * combination it's a pulled release or a feed that hasn't caught up, and not news.
 */
export function judgeFeedVersion(current: string, latest: string, channel: UpdateChannel): FeedVerdict {
  const order = compareVersions(latest, current);
  if (order > 0) return 'newer';
  if (order === 0) return 'same';
  return channel === 'stable' && isPrerelease(current) ? 'older-offer' : 'ignore';
}
