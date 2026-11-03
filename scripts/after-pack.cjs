// electron-builder leaves every node_modules out of extraResources, whatever the
// filter says, so the server's own goes in here. macOS keeps resources elsewhere.

const { cpSync, existsSync } = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');
  const from = path.join(context.packager.projectDir, 'webmail', 'node_modules');
  if (!existsSync(from)) throw new Error('webmail/node_modules is missing: run scripts/fetch-webmail.mjs first');
  cpSync(from, path.join(resources, 'server', 'node_modules'), { recursive: true });
};
