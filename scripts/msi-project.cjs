// electron-builder's msiProjectCreated hook: it gets the WiX project electron-builder generated.
//
// - The managed deployment switches: msi-policies.cjs.
// - A mark next to the exe that an installer put it there. Only an installed copy writes itself
//   into the user's Windows (registersWithOs in src/main/features/os-rules.ts); an unpacked
//   folder or a copy doesn't. The NSIS install has its uninstaller there instead.
// - At a real uninstall, the app's own `--uninstall-cleanup` (src/main/uninstall-cleanup.ts),
//   run as the user who uninstalls, before the files go. It takes away what the app wrote under
//   that user's HKCU at its starts: Default apps, the mail links and file types, Open with, Send
//   to, the toast activator, start at login, the Files drive letter's name. The NSIS uninstaller
//   does the same by itself. Not at an upgrade: the new version needs them, and writes them
//   again at its first start anyway. A per-machine MSI only reaches the HKCU of whoever runs the
//   uninstall: see "Uninstalling" in the README for other users' entries.

const { readFileSync, writeFileSync } = require('node:fs');
const { addPolicies } = require('./msi-policies.cjs');

const MSI_MARKER_FILE = 'installed-by-msi.ini';
// Fixed forever: a component's GUID is how Windows Installer knows it.
const MARKER_GUID = '6E348164-BA41-42C2-BDA4-954C9534C5DB';

function addInstallMarker(project) {
  if (!project.includes('<Feature Id="ProductFeature"') || !project.includes('</Product>') || !project.includes('Id="APPLICATIONFOLDER"')) {
    throw new Error('msi-project: the WiX project does not look as expected');
  }
  const component = [
    '    <DirectoryRef Id="APPLICATIONFOLDER">',
    `      <Component Id="BwInstallMarker" Guid="{${MARKER_GUID}}">`,
    '        <CreateFolder/>',
    `        <IniFile Id="BwInstallMarkerIni" Action="addLine" Directory="APPLICATIONFOLDER" Name="${MSI_MARKER_FILE}" Section="Bulwark" Key="InstalledBy" Value="msi"/>`,
    `        <RemoveFile Id="BwInstallMarkerFile" Name="${MSI_MARKER_FILE}" On="uninstall"/>`,
    '      </Component>',
    '    </DirectoryRef>',
  ].join('\n');
  return project
    .replace(/(<Feature Id="ProductFeature"[^>]*>)/, '$1\n      <ComponentRef Id="BwInstallMarker"/>')
    .replace('</Product>', () => `${component}\n  </Product>`);
}

function addUninstallCleanup(project) {
  if (!project.includes('Id="mainExecutable"') || !project.includes('</Product>')) {
    throw new Error('msi-project: the WiX project has no main executable');
  }
  const parts = [
    // Deferred and impersonated: as the user, inside the uninstall, while the exe is still there.
    // Whatever it answers, the uninstall goes on.
    '    <CustomAction Id="BwUninstallCleanup" FileKey="mainExecutable" ExeCommand="--uninstall-cleanup" Execute="deferred" Impersonate="yes" Return="ignore"/>',
    '    <InstallExecuteSequence>',
    '      <Custom Action="BwUninstallCleanup" Before="RemoveFiles"><![CDATA[REMOVE~="ALL" AND NOT UPGRADINGPRODUCTCODE]]></Custom>',
    '    </InstallExecuteSequence>',
  ].join('\n');
  return project.replace('</Product>', () => `${parts}\n  </Product>`);
}

function buildProject(project) {
  return addUninstallCleanup(addInstallMarker(addPolicies(project)));
}

exports.MSI_MARKER_FILE = MSI_MARKER_FILE;
exports.addInstallMarker = addInstallMarker;
exports.addUninstallCleanup = addUninstallCleanup;
exports.buildProject = buildProject;

exports.default = function msiProjectCreated(projectFile) {
  writeFileSync(projectFile, buildProject(readFileSync(projectFile, 'utf8')));
};
