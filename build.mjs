// Bundles the shell into dist/: main as ESM (top-level await), the preloads and the
// server host as CommonJS (a sandboxed preload can't be ESM, and the host loads Next
// with require). esbuild is what the webmail uses too.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/pages', { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: false, logLevel: 'warning' };

await build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.mjs', format: 'esm', external: ['electron'] });
await build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.cjs', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/preload/welcome.ts'], outfile: 'dist/welcome-preload.cjs', format: 'cjs', external: ['electron'] });
await build({ ...common, entryPoints: ['src/server/host.ts'], outfile: 'dist/server-host.cjs', format: 'cjs' });

// Main loads this as a data: page, so the script goes inside it, allowed by its hash.
const script = readFileSync('src/pages/welcome.js', 'utf8');
const hash = createHash('sha256').update(script).digest('base64');
const page = readFileSync('src/pages/welcome.html', 'utf8')
  .replace("script-src 'self'", `script-src 'sha256-${hash}'`)
  .replace('<script src="welcome.js"></script>', () => `<script>${script}</script>`);
writeFileSync('dist/pages/welcome.html', page);
