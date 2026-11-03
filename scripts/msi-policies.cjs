// The MSI's managed deployment switches. electron-builder hands this hook the WiX
// project it generated:
//
//   msiexec /i Bulwark.msi /qn ALLUSERS=1 INSTANCE_URL=https://mail.example.com FORCE_INSTANCE=1 UPDATE_CHANNEL=stable
//
// writes HKLM\SOFTWARE\Policies\Bulwark\Desktop, or \Recommended without
// FORCE_INSTANCE=1. The values go through the app's own checks when it reads them, and a
// bad one shows an error page that names the policy.
//
// The components are permanent: a major upgrade removes the old version first, and an
// upgrade run without these properties must not take the machine's policy with it. So
// an uninstall leaves them too. Removing them is the admin's call.

const { readFileSync, writeFileSync } = require('node:fs');

const FORCED = 'SOFTWARE\\Policies\\Bulwark\\Desktop';
const RECOMMENDED = `${FORCED}\\Recommended`;

// Fixed forever: a component's GUID is how Windows Installer knows it.
const VALUES = [
  { id: 'PolicyInstanceForced', guid: '6B4B8C0E-3B0B-4B7E-9D55-0F6E5B1C2A01', property: 'INSTANCE_URL', name: 'InstanceUrl', key: FORCED, forced: true },
  { id: 'PolicyInstanceRecommended', guid: '6B4B8C0E-3B0B-4B7E-9D55-0F6E5B1C2A02', property: 'INSTANCE_URL', name: 'InstanceUrl', key: RECOMMENDED, forced: false },
  { id: 'PolicyChannelForced', guid: '6B4B8C0E-3B0B-4B7E-9D55-0F6E5B1C2A03', property: 'UPDATE_CHANNEL', name: 'UpdateChannel', key: FORCED, forced: true },
  { id: 'PolicyChannelRecommended', guid: '6B4B8C0E-3B0B-4B7E-9D55-0F6E5B1C2A04', property: 'UPDATE_CHANNEL', name: 'UpdateChannel', key: RECOMMENDED, forced: false },
];

function addPolicies(project) {
  if (!project.includes('<Feature Id="ProductFeature"') || !project.includes('</Product>')) {
    throw new Error('msi-policies: the WiX project does not look as expected');
  }
  const properties = ['INSTANCE_URL', 'FORCE_INSTANCE', 'UPDATE_CHANNEL'].map((id) => `    <Property Id="${id}" Secure="yes"/>`);
  const components = VALUES.map(({ id, guid, property, name, key, forced }) => {
    const condition = forced ? `${property} AND FORCE_INSTANCE = "1"` : `${property} AND NOT FORCE_INSTANCE = "1"`;
    return [
      `      <Component Id="${id}" Guid="{${guid}}" Permanent="yes">`,
      `        <Condition><![CDATA[${condition}]]></Condition>`,
      `        <RegistryValue Root="HKLM" Key="${key}" Name="${name}" Type="string" Value="[${property}]" KeyPath="yes"/>`,
      '      </Component>',
    ].join('\n');
  });
  const directory = ['    <DirectoryRef Id="TARGETDIR">', ...components, '    </DirectoryRef>'].join('\n');
  const refs = VALUES.map(({ id }) => `      <ComponentRef Id="${id}"/>`).join('\n');
  return project
    .replace(/(<Feature Id="ProductFeature"[^>]*>)/, `$1\n${refs}`)
    .replace('</Product>', () => `${properties.join('\n')}\n${directory}\n  </Product>`);
}

exports.addPolicies = addPolicies;

exports.default = function msiProjectCreated(projectFile) {
  writeFileSync(projectFile, addPolicies(readFileSync(projectFile, 'utf8')));
};
