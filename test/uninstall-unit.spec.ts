// What the installers take back at an uninstall: the MSI through the app's own cleanup, the
// NSIS uninstaller by itself. No Electron and no registry here.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { MSI_MARKER_FILE } from '../src/main/features/os-rules';
import { asksForUninstallCleanup } from '../src/main/uninstall-cleanup';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

test.describe('the uninstall cleanup switch', () => {
  test('is read before a bare -- only, where a file of that name could come', () => {
    expect(asksForUninstallCleanup(['Bulwark.exe', '--uninstall-cleanup'])).toBe(true);
    expect(asksForUninstallCleanup(['Bulwark.exe', '--', '--uninstall-cleanup'])).toBe(false);
    expect(asksForUninstallCleanup(['Bulwark.exe', 'mailto:a@example.org'])).toBe(false);
  });
});

test.describe('the MSI project', () => {
  const { buildProject } = require('../scripts/msi-project.cjs') as { buildProject: (project: string) => string };
  const project = [
    '<Wix><Product Id="*">',
    '<Directory Id="TARGETDIR" Name="SourceDir"><Directory Id="ProgramFiles64Folder"><Directory Id="APPLICATIONFOLDER" Name="Bulwark"/></Directory></Directory>',
    '<Feature Id="ProductFeature" Absent="disallow">\n<ComponentGroupRef Id="ProductComponents"/></Feature>',
    '<ComponentGroup Id="ProductComponents" Directory="APPLICATIONFOLDER"><Component><File Name="Bulwark.exe" Source="x" ReadOnly="yes" KeyPath="yes" Id="mainExecutable"/></Component></ComponentGroup>',
    '  </Product></Wix>',
  ].join('\n');

  test('runs the app\'s cleanup as the user at a real uninstall, before the files go, never at an upgrade', () => {
    const out = buildProject(project);
    const action = /<CustomAction Id="BwUninstallCleanup"[^>]*\/>/.exec(out)?.[0] ?? '';
    expect(action).toContain('FileKey="mainExecutable"');
    expect(action).toContain('ExeCommand="--uninstall-cleanup"');
    expect(action).toContain('Execute="deferred"');
    expect(action).toContain('Impersonate="yes"');
    expect(action).toContain('Return="ignore"');
    expect(out).toContain('<Custom Action="BwUninstallCleanup" Before="RemoveFiles"><![CDATA[REMOVE~="ALL" AND NOT UPGRADINGPRODUCTCODE]]></Custom>');
  });

  test('marks the folder as installed, and takes the mark away again', () => {
    const out = buildProject(project);
    expect(out).toContain('<ComponentRef Id="BwInstallMarker"/>');
    // WiX refuses a component without an explicit key path: the folder is it.
    expect(out).toMatch(/<Component Id="BwInstallMarker" [^>]*KeyPath="yes">\s*<CreateFolder\/>/);
    expect(out).toMatch(new RegExp(`<IniFile [^>]*Directory="APPLICATIONFOLDER" Name="${MSI_MARKER_FILE.replace('.', '\\.')}"`));
    expect(out).toContain(`<RemoveFile Id="BwInstallMarkerFile" Name="${MSI_MARKER_FILE}" On="uninstall"/>`);
  });

  test('keeps the policy switches', () => {
    expect(buildProject(project)).toContain('<Property Id="BW_PREV_FORCED_URL">');
  });

  test('electron-builder runs it', () => {
    expect(readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')).toMatch(/^msiProjectCreated: scripts\/msi-project\.cjs\r?$/m);
  });
});

test.describe('the NSIS uninstaller', () => {
  const nsis = readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');

  test('takes the app\'s empty folders under LOCALAPPDATA, and never their contents', () => {
    const removed = [...nsis.matchAll(/^\s*RMDir (\/r )?"\$LOCALAPPDATA\\Bulwark([^"]*)"/gm)].map((match) => `${match[1] ? 'all ' : ''}${match[2] || '\\'}`);
    expect(removed).toEqual(['all \\os-files', '\\edit-files', '\\files-sync\\state', '\\files-sync', '\\']);
  });
});
