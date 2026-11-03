// What ships has to be right by the time this runs. It refuses a build with test switches
// in it, copies the server's unpacked files (electron-builder leaves every node_modules
// out of extraResources, whatever the filter says), and takes the last look at the package.

const { cpSync, existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

exports.default = async function afterPack(context) {
  const { projectDir } = context.packager;
  // A test build reads a policy root anyone can write to and takes any switch, and a test
  // feed would let anyone with a shortcut pick where updates come from. They can't ship:
  // only scripts/pack-test.mjs and build-update-fixtures.mjs may package one.
  const main = path.join(projectDir, 'dist', 'main.mjs');
  if (process.env.BULWARK_TEST_PACK !== '1') {
    if (existsSync(path.join(projectDir, 'dist', 'test-build.json'))) throw new Error('dist/ is a test build: run `node build.mjs` first');
    if (existsSync(main) && readFileSync(main, 'utf8').includes('bulwark-test-update-feed')) {
      throw new Error('dist/ has the updater test switches in it: run `node build.mjs` first');
    }
  }

  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');
  // With `electronDist` (the tests, to stay off the network) Electron's sample app comes along.
  rmSync(path.join(resources, 'default_app.asar'), { force: true });

  const { archiveDir } = await import('./server-archive.mjs');
  const built = archiveDir(projectDir, context.electronPlatformName, ARCH[context.arch] ?? 'x64');
  if (!existsSync(path.join(resources, 'server.asar'))) throw new Error('server.asar did not reach the package');
  cpSync(path.join(built, 'server.asar.unpacked'), path.join(resources, 'server.asar.unpacked'), { recursive: true });

  // The updater needs to know whether this copy can install an update by itself, and
  // on macOS that takes a signature, which is only known here.
  writeFileSync(path.join(resources, 'bulwark-build.json'), `${JSON.stringify({ macSigned: Boolean(process.env.CSC_LINK || process.env.CSC_NAME) })}\n`);

  const { guardResources, guardExtraFiles } = await import('./package-guard.mjs');
  guardResources(resources);
  guardExtraFiles(context.appOutDir);
};
