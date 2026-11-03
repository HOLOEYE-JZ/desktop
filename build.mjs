// Bundles the shell into dist/: main as ESM (top-level await), the preloads and the
// server host as CommonJS (a sandboxed preload can't be ESM, and the host loads Next
// with require). esbuild is what the webmail uses too.

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/pages', { recursive: true });
cpSync('assets/os', 'dist/os-icons', { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: false, logLevel: 'warning' };

// BULWARK_UPDATER_TEST_BUILD=1 keeps the updater's test switches. In any other build the
// constant is false and the code behind it is gone (test/updater-rules.spec.ts checks).
const updaterTest = process.env.BULWARK_UPDATER_TEST_BUILD === '1';
// `--test` lets the app read a stand-in policy root. A package is never built with it:
// scripts/after-pack.cjs fails on one. It has to be the build, not a run-time check,
// since Electron decides app.isPackaged by the name of the exe, and anyone can rename it.
const testBuild = process.argv.includes('--test');
// Behaves as production, with its profile compiled in: a test of what production does
// mustn't touch the real profile, and no switch may move it. See scripts/pack-test.mjs.
const bakedProfile = process.argv.find((arg) => arg.startsWith('--baked-profile='))?.slice('--baked-profile='.length) ?? '';

await build({
  ...common,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main.mjs',
  format: 'esm',
  // A native module, loaded at run time from node_modules.
  external: ['electron', '@vscode/policy-watcher'],
  define: { __BULWARK_TEST_BUILD__: String(testBuild), __BULWARK_TEST_PROFILE__: JSON.stringify(bakedProfile), __BULWARK_UPDATER_TEST__: String(updaterTest) },
  // Takes out what's behind the false above, and the functions only it used.
  minifySyntax: true,
});
// electron-updater in a file of its own, loaded some time after the window is up. Bundled
// so that a package has no node_modules for this, and the first paint doesn't pay for it.
await build({ ...common, entryPoints: ['node_modules/electron-updater/out/main.js'], outfile: 'dist/updater-lib.cjs', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.cjs', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/preload/welcome.ts'], outfile: 'dist/welcome-preload.cjs', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/server/host.ts'], outfile: 'dist/server-host.cjs', format: 'cjs' });
await build({ ...common, entryPoints: ['src/main/import-worker.ts'], outfile: 'dist/import-worker.cjs', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/main/crash-scrub-host.ts'], outfile: 'dist/crash-scrub-host.cjs', format: 'cjs', external: ['electron'] });

// Main loads this as a data: page, so the script goes inside it, allowed by its hash.
// LF: an HTML parser turns CRLF into LF before the hash is checked, so a Windows
// checkout's line endings would get its own script refused.
const script = readFileSync('src/pages/welcome.js', 'utf8').replace(/\r\n/g, '\n');
const hash = createHash('sha256').update(script).digest('base64');
const page = readFileSync('src/pages/welcome.html', 'utf8')
  .replace("script-src 'self'", `script-src 'sha256-${hash}'`)
  .replace('<script src="welcome.js"></script>', () => `<script>${script}</script>`);
writeFileSync('dist/pages/welcome.html', page);
if (testBuild || bakedProfile) writeFileSync('dist/test-build.json', JSON.stringify({ testBuild, bakedProfile }));
