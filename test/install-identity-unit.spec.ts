// Which copies of the app may write themselves into the OS. No Electron and no registry here.
import { expect, test } from '@playwright/test';
import { appUserModelId, MSI_MARKER_FILE, registersWithOs, TEST_APP_USER_MODEL_ID, windowsInstallerOf } from '../src/main/features/os-rules';

test.describe('who registers with the OS', () => {
  const production = { platform: 'win32' as const, testBuild: false, bakedProfile: false };

  test('an NSIS or MSI install does', () => {
    expect(registersWithOs({ ...production, installer: 'nsis' })).toBe(true);
    expect(registersWithOs({ ...production, installer: 'msi' })).toBe(true);
  });

  test('a production folder no installer put there does not: win-unpacked, a copy', () => {
    expect(registersWithOs({ ...production, installer: 'none' })).toBe(false);
  });

  test('a test pack never does, even installed by a test installer', () => {
    for (const installer of ['nsis', 'msi', 'none'] as const) {
      expect(registersWithOs({ ...production, testBuild: true, installer })).toBe(false);
      expect(registersWithOs({ ...production, bakedProfile: true, installer })).toBe(false);
      expect(registersWithOs({ ...production, platform: 'linux', testBuild: true, installer })).toBe(false);
    }
  });

  test('and a test pack keeps off the installed app\'s jump list and taskbar group', () => {
    expect(appUserModelId(!registersWithOs({ ...production, testBuild: true, installer: 'none' }))).toBe(TEST_APP_USER_MODEL_ID);
    expect(appUserModelId(!registersWithOs({ ...production, installer: 'none' }))).toBe(TEST_APP_USER_MODEL_ID);
  });

  test('macOS and Linux packages register as before', () => {
    expect(registersWithOs({ ...production, platform: 'linux', installer: 'none' })).toBe(true);
    expect(registersWithOs({ ...production, platform: 'darwin', installer: 'none' })).toBe(true);
  });

  test('the installer is told by what it leaves next to the exe', () => {
    expect(windowsInstallerOf((name) => name === 'Uninstall Bulwark.exe', 'Bulwark')).toBe('nsis');
    expect(windowsInstallerOf((name) => name === MSI_MARKER_FILE, 'Bulwark')).toBe('msi');
    expect(windowsInstallerOf(() => false, 'Bulwark')).toBe('none');
  });
});
