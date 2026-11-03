import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { compareVersions, effectiveChannel, installKind, isPrerelease, judgeFeedVersion, updateAbility } from '../src/main/update-rules';
import { notifyUpdatePolicyChanged, onUpdatePolicyChange, readUpdatePolicy, setUpdatePolicySource } from '../src/main/update-policy';

const ROOT = path.resolve(import.meta.dirname, '..');

test.describe('version order', () => {
  test('follows semver, prereleases before their release', () => {
    const ordered = ['0.9.0', '0.9.1', '0.10.0', '1.0.0-alpha.1', '1.0.0-beta.1', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-rc.1', '1.0.0', '1.0.1'];
    for (let i = 0; i < ordered.length - 1; i += 1) {
      expect(compareVersions(ordered[i], ordered[i + 1]), `${ordered[i]} < ${ordered[i + 1]}`).toBeLessThan(0);
      expect(compareVersions(ordered[i + 1], ordered[i]), `${ordered[i + 1]} > ${ordered[i]}`).toBeGreaterThan(0);
    }
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(isPrerelease('1.0.0-beta.1')).toBe(true);
    expect(isPrerelease('1.0.0')).toBe(false);
  });
});

test.describe('which channel applies', () => {
  test('forced beats the user, the user beats recommended, recommended beats what the build is', () => {
    expect(effectiveChannel({ channel: 'stable' }, 'beta', '1.0.0-beta.1')).toBe('stable');
    expect(effectiveChannel({ recommendedChannel: 'stable' }, 'beta', '1.0.0')).toBe('beta');
    expect(effectiveChannel({ recommendedChannel: 'beta' }, undefined, '1.0.0')).toBe('beta');
    expect(effectiveChannel({}, undefined, '1.0.0')).toBe('stable');
    expect(effectiveChannel({}, undefined, '1.0.0-beta.1')).toBe('beta');
  });
});

test.describe('what a copy can do', () => {
  const facts = { isPackaged: true, hasNsisUninstaller: false };

  test('an NSIS install replaces itself', () => {
    const kind = installKind({ ...facts, platform: 'win32', hasNsisUninstaller: true });
    expect(kind).toBe('nsis');
    expect(updateAbility(kind)).toBe('install');
  });

  test('an MSI never runs the NSIS installer', () => {
    const kind = installKind({ ...facts, platform: 'win32' });
    expect(kind).toBe('windows-other');
    expect(updateAbility(kind)).toBe('notify');
  });

  test('unsigned macOS only says a version exists, signed macOS replaces itself', () => {
    expect(updateAbility(installKind({ ...facts, platform: 'darwin' }))).toBe('notify');
    expect(updateAbility(installKind({ ...facts, platform: 'darwin', macSigned: true }))).toBe('install');
  });

  test('on Linux only an AppImage replaces itself', () => {
    expect(updateAbility(installKind({ ...facts, platform: 'linux', appImage: '/x/Bulwark.AppImage' }))).toBe('install');
    expect(updateAbility(installKind({ ...facts, platform: 'linux', packageType: 'deb' }))).toBe('notify');
    expect(updateAbility(installKind({ ...facts, platform: 'linux', packageType: 'rpm' }))).toBe('notify');
    expect(updateAbility(installKind({ ...facts, platform: 'linux' }))).toBe('notify');
  });

  test('a development run has nothing to update', () => {
    expect(updateAbility(installKind({ ...facts, platform: 'win32', isPackaged: false, hasNsisUninstaller: true }))).toBe('none');
  });
});

test.describe('what a version in the feed means', () => {
  test('newer is an update on any channel', () => {
    expect(judgeFeedVersion('1.0.0', '1.0.1', 'stable')).toBe('newer');
    expect(judgeFeedVersion('1.0.0-beta.1', '1.0.0', 'beta')).toBe('newer');
    expect(judgeFeedVersion('1.0.0-beta.1', '1.0.0', 'stable')).toBe('newer');
  });

  test('older is only ever an offer, to a beta user on stable', () => {
    expect(judgeFeedVersion('1.0.0-beta.1', '0.9.1', 'stable')).toBe('older-offer');
    // A pulled release: stable stays where it is, with no offer to go back.
    expect(judgeFeedVersion('1.0.0', '0.9.1', 'stable')).toBe('ignore');
    expect(judgeFeedVersion('1.0.0-beta.2', '1.0.0-beta.1', 'beta')).toBe('ignore');
  });

  test('the same version is nothing', () => {
    expect(judgeFeedVersion('1.0.0', '1.0.0', 'stable')).toBe('same');
  });
});

test.describe('the policy hook', () => {
  test.afterEach(() => setUpdatePolicySource(() => ({})));

  test('reads the current value and tells listeners', () => {
    let calls = 0;
    const stop = onUpdatePolicyChange(() => {
      calls += 1;
    });
    expect(readUpdatePolicy()).toEqual({});
    setUpdatePolicySource(() => ({ autoUpdate: false }));
    expect(calls).toBe(1);
    expect(readUpdatePolicy().autoUpdate).toBe(false);
    notifyUpdatePolicyChanged();
    expect(calls).toBe(2);
    stop();
    notifyUpdatePolicyChanged();
    expect(calls).toBe(2);
  });
});

test.describe('the normal build', () => {
  test('has no way to set another update feed', () => {
    // Run after a plain `node build.mjs`. This string only exists in a test build.
    const main = readFileSync(path.join(ROOT, 'dist', 'main.mjs'), 'utf8');
    expect(main).toContain('update-downloaded');
    expect(main).not.toContain('bulwark-test-update-feed');
    expect(main).not.toContain('bulwark-test-update-policy');
    expect(main).not.toContain('setFeedURL');
  });
});
