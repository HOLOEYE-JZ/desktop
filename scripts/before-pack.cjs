// Trims, guards and packs the server for this target: see server-archive.mjs. And puts this
// architecture's policy watcher in node_modules, if a release built them.

const { cpSync, existsSync, readdirSync } = require('node:fs');
const path = require('node:path');

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

exports.default = async function beforePack(context) {
  const { projectDir } = context.packager;
  const built = path.join(projectDir, '.native-modules', `${context.electronPlatformName}-${ARCH[context.arch] ?? 'x64'}`);
  if (existsSync(built)) {
    const target = path.join(projectDir, 'node_modules', '@vscode', 'policy-watcher', 'build', 'Release');
    for (const file of readdirSync(built)) cpSync(path.join(built, file), path.join(target, file));
  }
  const { buildServerArchive } = await import('./server-archive.mjs');
  const { trim } = await buildServerArchive({
    projectDir: context.packager.projectDir,
    platform: context.electronPlatformName,
    arch: ARCH[context.arch] ?? 'x64',
  });
  console.log(`[before-pack] trimmed ${Math.round(trim.bytes / 1048576)} MB (${trim.removed.join(', ') || 'nothing'})`);
};
