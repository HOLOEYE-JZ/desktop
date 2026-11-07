/**
 * Makes the server's code cache (code-cache.ts) at package time, run by server-archive.mjs as
 *   ELECTRON_RUN_AS_NODE=1 <the build's own Electron> dist/code-cache-gen.cjs <server tree>
 * It loads the server as the app does, renders the pages a start shows, and writes V8's code
 * for every server file that ran into <tree>/.code-cache, with a manifest of each file's
 * SHA-256. Throwaway data folders; nothing leaves this machine. Exit code 0 only when a cache
 * was written.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type vm from 'node:vm';
import { profilePaths, seedProfile, serverEnv } from '../main/profile';
import { CACHE_FOLDER, compileWrapped, MANIFEST, relativeKey, sha256, wrappable, type CacheManifest } from './code-cache';

const PAGES = ['/', '/login', '/mail/folder/inbox', '/settings'];

function get(port: number, pathName: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: pathName, headers: { host: 'app.bulwark.localhost', 'x-forwarded-proto': 'https', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(`${res.statusCode ?? 0}${res.headers.location ? ` -> ${res.headers.location}` : ''}`));
    });
    req.on('error', () => resolve('error'));
    req.setTimeout(60_000, () => req.destroy());
    req.end();
  });
}

async function main(): Promise<void> {
  const tree = path.resolve(process.argv[2] ?? '');
  // The data folders and env the app gives its server (src/main/profile.ts), in a throwaway profile.
  const data = mkdtempSync(path.join(tmpdir(), 'bulwark-code-cache-'));
  const profile = profilePaths(data);
  seedProfile(profile);
  const env = serverEnv(profile, process.env, process.platform);
  for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
  Object.assign(process.env, env, { LOG_LEVEL: 'error', BULWARK_TELEMETRY: 'off' });
  process.cwd = () => tree;

  const recorded: Array<{ key: string; content: string; script: vm.Script }> = [];
  const proto = (Module as unknown as { prototype: { _compile: (this: NodeJS.Module, content: string, filename: string, ...rest: unknown[]) => unknown } }).prototype;
  const original = proto._compile;
  proto._compile = function record(this: NodeJS.Module, content: string, filename: string, ...rest: unknown[]) {
    const key = relativeKey(tree, filename);
    if (!key || !wrappable(content, rest)) return original.call(this, content, filename, ...rest);
    const { script, run } = compileWrapped(content, filename);
    recorded.push({ key, content, script });
    return run(this);
  };

  const { config } = JSON.parse(readFileSync(path.join(tree, '.next', 'required-server-files.json'), 'utf8'));
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
  const next = createRequire(path.join(tree, 'server.js'))('next');
  const app = next({ dev: false, dir: tree, hostname: 'app.bulwark.localhost', port: 443, quiet: true, conf: config });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const answers: string[] = [];
  for (const page of PAGES) answers.push(`${page} ${await get(port, page)}`);
  server.close();

  // After the pages ran: V8 then has the functions they called compiled too, and they go in.
  const out = path.join(tree, CACHE_FOLDER);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const manifest: CacheManifest = { v8: process.versions.v8, files: {} };
  let bytes = 0;
  for (const { key, content, script } of recorded) {
    const cached = script.createCachedData();
    const file = `${sha256(key).slice(0, 32)}.bin`;
    writeFileSync(path.join(out, file), cached);
    manifest.files[key] = { sha256: sha256(content), data: file };
    bytes += cached.length;
  }
  writeFileSync(path.join(out, MANIFEST), JSON.stringify(manifest));
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(`[code-cache] ${recorded.length} files, ${Math.round(bytes / 1048576)} MB, V8 ${process.versions.v8}; pages: ${answers.join(', ')}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`[code-cache] not made: ${error?.stack ?? error}`);
  process.exit(1);
});
