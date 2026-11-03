// Bundles the shell into dist/: main as ESM (top-level await), the preloads and the
// server host as CommonJS (a sandboxed preload can't be ESM, and the host loads Next
// with require). esbuild is what the webmail uses too.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/pages', { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: false, logLevel: 'warning' };

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
  define: { __BULWARK_TEST_BUILD__: String(testBuild), __BULWARK_TEST_PROFILE__: JSON.stringify(bakedProfile) },
  // Takes out what's behind the false above, and the functions only it used.
  minifySyntax: true,
});
await build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.cjs', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/preload/welcome.ts'], outfile: 'dist/welcome-preload.cjs', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/server/host.ts'], outfile: 'dist/server-host.cjs', format: 'cjs' });

// Main loads this as a data: page, so the script goes inside it, allowed by its hash.
// As LF: an HTML parser normalises line ends before the hash is checked, so a CRLF
// checkout's script was refused by its own CSP and the first-run page did nothing.
const script = readFileSync('src/pages/welcome.js', 'utf8').replace(/\r\n/g, '\n');
const hash = createHash('sha256').update(script).digest('base64');
const page = readFileSync('src/pages/welcome.html', 'utf8')
  .replace("script-src 'self'", `script-src 'sha256-${hash}'`)
  .replace('<script src="welcome.js"></script>', () => `<script>${script}</script>`);
writeFileSync('dist/pages/welcome.html', page);
if (testBuild || bakedProfile) writeFileSync('dist/test-build.json', JSON.stringify({ testBuild, bakedProfile }));
