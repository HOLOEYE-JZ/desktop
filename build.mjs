// Bundles the shell into dist/: main as ESM (top-level await), the preloads and the
// server host as CommonJS (a sandboxed preload can't be ESM, and the host loads Next
// with require). esbuild is what the webmail uses too.

import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/pages', { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: false, logLevel: 'warning' };

await build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.mjs', format: 'esm', external: ['electron'] });
await build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.cjs', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/preload/welcome.ts'], outfile: 'dist/welcome-preload.cjs', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/server/host.ts'], outfile: 'dist/server-host.cjs', format: 'cjs' });

for (const file of ['welcome.html', 'welcome.js']) copyFileSync(`src/pages/${file}`, `dist/pages/${file}`);
