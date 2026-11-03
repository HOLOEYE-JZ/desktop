// electron-builder leaves every node_modules out of extraResources, whatever the
// filter says, so the server's own goes in here. macOS keeps resources elsewhere.
// Then the last look at what ships (package-guard.mjs).

const { cpSync, existsSync } = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  // A test build reads a policy root anyone can write to and takes any switch. It can't
  // ship: only scripts/pack-test.mjs may package one.
  if (existsSync(path.join(context.packager.projectDir, 'dist', 'test-build.json')) && process.env.BULWARK_TEST_PACK !== '1') {
    throw new Error('dist/ is a test build: run `node build.mjs` first');
  }
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');
  const from = path.join(context.packager.projectDir, 'webmail', 'node_modules');
  if (!existsSync(from)) throw new Error('webmail/node_modules is missing: run scripts/fetch-webmail.mjs first');
  const server = path.join(resources, 'server');
  cpSync(from, path.join(server, 'node_modules'), { recursive: true });
  const { guardPackage } = await import('./package-guard.mjs');
  guardPackage(server);
};
