// electron-builder leaves every node_modules out of extraResources, whatever the
// filter says, so the server's own goes in here. macOS keeps resources elsewhere.
// Then the trim for this platform and architecture (server-natives.mjs), and the
// last look at what ships (package-guard.mjs).

const { cpSync, existsSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');

// builder-util's Arch enum.
const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

exports.default = async function afterPack(context) {
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');
  const from = path.join(context.packager.projectDir, 'webmail', 'node_modules');
  if (!existsSync(from)) throw new Error('webmail/node_modules is missing: run scripts/fetch-webmail.mjs first');
  // With `electronDist` (the tests, to stay off the network) Electron's sample app comes along.
  rmSync(path.join(resources, 'default_app.asar'), { force: true });
  const server = path.join(resources, 'server');
  cpSync(from, path.join(server, 'node_modules'), { recursive: true });

  const { trimServer } = await import('./server-natives.mjs');
  const trim = trimServer(server, context.electronPlatformName, ARCH[context.arch] ?? 'x64');
  console.log(`[after-pack] trimmed ${Math.round(trim.bytes / 1048576)} MB (${trim.removed.join(', ') || 'nothing'})`);

  // The updater needs to know whether this copy can install an update by itself, and
  // on macOS that takes a signature, which is only known here.
  writeFileSync(path.join(resources, 'bulwark-build.json'), `${JSON.stringify({ macSigned: Boolean(process.env.CSC_LINK || process.env.CSC_NAME) })}\n`);

  const { guardPackage, guardResources } = await import('./package-guard.mjs');
  guardPackage(server);
  guardResources(resources);
};
