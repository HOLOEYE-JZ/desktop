import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { asarFiles, findResourceProblems } from '../scripts/package-guard.mjs';
import { sharpTargets, trimServer } from '../scripts/server-natives.mjs';

/**
 * The guard in the real flow: electron-builder, this repo's config and after-pack, on a
 * small project with a small server tree. Nothing here touches the real webmail build.
 */

const ROOT = path.resolve(import.meta.dirname, '..');

/** A native module with no DLLs of its own, for the asarUnpack check: the helper's, or one you name. */
function findProbeModule(): string {
  const found = [process.env.BULWARK_TEST_NATIVE_MODULE, path.join(ROOT, 'native', 'dist', 'win32-x64', 'bulwark-native.node')].find((file) => file && existsSync(file));
  if (!found) throw new Error('Run npm run build:native, or set BULWARK_TEST_NATIVE_MODULE to a .node file with no dependencies.');
  return found;
}

interface Project {
  dir: string;
  remove: () => void;
}

function makeProject(probe: string | null): Project {
  const dir = mkdtempSync(path.join(tmpdir(), 'bw-guard-'));
  for (const file of ['electron-builder.yml']) copyFileSync(path.join(ROOT, file), path.join(dir, file));
  cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  cpSync(path.join(ROOT, 'build'), path.join(dir, 'build'), { recursive: true });

  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  pkg.main = 'dist/main.cjs';
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

  // A shell that loads a native module out of the asar's unpacked side and says so.
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  if (probe) copyFileSync(probe, path.join(dir, 'dist', 'probe.node'));
  writeFileSync(
    path.join(dir, 'dist', 'main.cjs'),
    `const { app } = require('electron'); const fs = require('node:fs'); const out = process.argv.find((a) => a.startsWith('--out=')).slice(6);
     let loaded = 'no probe'; try { if (fs.existsSync(__dirname + '/probe.node')) loaded = typeof require('./probe.node'); } catch (e) { loaded = 'failed: ' + e.message; }
     fs.writeFileSync(out, JSON.stringify({ loaded, dir: __dirname })); app.exit(0);`,
  );

  const web = path.join(dir, 'webmail');
  mkdirSync(path.join(web, '.next', 'server'), { recursive: true });
  mkdirSync(path.join(web, 'node_modules', 'next'), { recursive: true });
  writeFileSync(path.join(web, 'server.js'), '// stand-in');
  writeFileSync(path.join(web, 'package.json'), '{}');
  writeFileSync(path.join(web, '.next', 'required-server-files.json'), JSON.stringify({ config: {} }));
  writeFileSync(path.join(web, 'node_modules', 'next', 'package.json'), '{}');

  // The junction first out, always, or removing the folder empties the real node_modules.
  const modules = path.join(dir, 'node_modules');
  const made = spawnSync('powershell.exe', ['-NoProfile', '-Command', `New-Item -ItemType Junction -Path '${modules}' -Target '${path.join(ROOT, 'node_modules')}' | Out-Null`]);
  if (made.status !== 0) throw new Error('could not link node_modules');
  return {
    dir,
    remove: () => {
      rmdirSync(modules);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
}

function pack(project: Project): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  const result = spawnSync(process.execPath, [cli, '--dir', '--win', '--x64', '--projectDir', project.dir, '--publish', 'never', `-c.electronDist=${path.join(ROOT, 'node_modules', 'electron', 'dist')}`], { encoding: 'utf8', env, cwd: project.dir, timeout: 280_000 });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function plant(project: Project, relative: string): void {
  const file = path.join(project.dir, 'webmail', relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'SECRET');
}

async function runApp(exe: string, out: string): Promise<number | null> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    const child = spawn(exe, [`--out=${out}`, `--user-data-dir=${out}.profile`], { env, stdio: 'ignore' });
    const timer = setTimeout(() => {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
      resolve(null);
    }, 25_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test.describe('the package guard in the real flow', () => {
  test.skip(process.platform !== 'win32', 'packs for Windows');
  test.setTimeout(300_000);

  test('a clean tree packs: the control, or the two below would prove nothing', async () => {
    const probe = findProbeModule();
    const project = makeProject(probe);
    try {
      const { status, output } = pack(project);
      expect(status, output).toBe(0);
      const unpacked = path.join(project.dir, 'release', 'win-unpacked');
      const exe = path.join(unpacked, 'Bulwark.exe');
      expect(existsSync(exe)).toBe(true);
      const resources = path.join(unpacked, 'resources');
      expect(findResourceProblems(resources)).toEqual([]);
      expect(asarFiles(path.join(resources, 'app.asar'))).toContain('dist/main.cjs');

      // ASAR integrity is on, the shell runs, and a native module loads from the unpacked side.
      const out = path.join(project.dir, 'ran.json');
      expect(await runApp(exe, out)).toBe(0);
      const ran = JSON.parse(readFileSync(out, 'utf8'));
      expect(existsSync(path.join(resources, 'app.asar.unpacked', 'dist', 'probe.node'))).toBe(true);
      expect(ran.loaded).toBe('object');

      // Change one byte inside the asar: integrity must stop it before our code runs.
      const asarPath = path.join(resources, 'app.asar');
      const bytes = readFileSync(asarPath);
      const marker = bytes.indexOf(Buffer.from('fs.writeFileSync(out'));
      expect(marker).toBeGreaterThan(0);
      bytes[marker] = 'g'.charCodeAt(0);
      writeFileSync(asarPath, bytes);
      const tampered = path.join(project.dir, 'tampered.json');
      const code = await runApp(exe, tampered);
      expect(code, 'a changed asar must not start normally').not.toBe(0);
      expect(existsSync(tampered)).toBe(false);
    } finally {
      project.remove();
    }
  });

  test('fails on a planted data/admin/plugin-signing.key', () => {
    const project = makeProject(null);
    try {
      plant(project, 'data/admin/plugin-signing.key');
      const { status, output } = pack(project);
      expect(status).not.toBe(0);
      expect(output).toContain('Do not ship this package');
      expect(output).toContain('data/');
    } finally {
      project.remove();
    }
  });

  test('fails on data/, local-data/, .env*, repos/, and a key deep inside .next or node_modules', () => {
    const project = makeProject(null);
    try {
      for (const file of ['data/x.json', 'local-data/x.txt', '.env', '.env.local', 'repos/x/y.txt', '.next/server/plugin-signing.key', '.next/.env', 'node_modules/next/.env.production', 'node_modules/next/plugin-signing.key']) {
        plant(project, file);
      }
      const { status, output } = pack(project);
      expect(status).not.toBe(0);
      for (const named of ['data/', 'local-data/', '.env', '.env.local', 'repos/', '.next/server/plugin-signing.key', '.next/.env', 'node_modules/next/.env.production', 'node_modules/next/plugin-signing.key']) {
        expect(output, named).toContain(named);
      }
    } finally {
      project.remove();
    }
  });
});

test.describe('what sits next to the server', () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), 'bw-res-'));

  test('an unknown file in resources/ is a problem', () => {
    const resources = dir();
    try {
      writeFileSync(path.join(resources, 'bulwark-build.json'), '{}');
      mkdirSync(path.join(resources, 'server'));
      expect(findResourceProblems(resources)).toEqual([]);
      writeFileSync(path.join(resources, 'something.txt'), 'x');
      expect(findResourceProblems(resources)).toEqual(['resources/something.txt']);
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });
});

test.describe('the server tree per target', () => {
  function tree(names: string[]): string {
    const server = mkdtempSync(path.join(tmpdir(), 'bw-nat-'));
    const modules = path.join(server, 'node_modules');
    mkdirSync(path.join(modules, 'sharp'), { recursive: true });
    mkdirSync(path.join(modules, 'esbuild'), { recursive: true });
    mkdirSync(path.join(modules, '@esbuild', 'win32-x64'), { recursive: true });
    writeFileSync(path.join(modules, '@esbuild', 'win32-x64', 'esbuild.exe'), 'x'.repeat(1000));
    for (const name of names) {
      mkdirSync(path.join(modules, '@img', name), { recursive: true });
      writeFileSync(path.join(modules, '@img', name, 'x.node'), 'x');
    }
    return server;
  }
  const img = (server: string) => readdirSync(path.join(server, 'node_modules', '@img')).sort();

  test('keeps the target, sharp\'s JS and nothing else, and drops esbuild', () => {
    const server = tree(['colour', 'sharp-win32-x64', 'sharp-win32-arm64', 'sharp-wasm32']);
    const result = trimServer(server, 'win32', 'arm64');
    expect(img(server)).toEqual(['colour', 'sharp-win32-arm64']);
    expect(existsSync(path.join(server, 'node_modules', 'esbuild'))).toBe(false);
    expect(existsSync(path.join(server, 'node_modules', '@esbuild'))).toBe(false);
    expect(result.bytes).toBeGreaterThan(1000);
    rmSync(server, { recursive: true, force: true });
  });

  test('a build for an architecture whose sharp is missing fails, instead of shipping broken', () => {
    const server = tree(['colour', 'sharp-win32-x64']);
    expect(() => trimServer(server, 'win32', 'arm64')).toThrow(/no sharp for win32-arm64/);
    rmSync(server, { recursive: true, force: true });
  });

  test('universal macOS keeps both, with their libvips', () => {
    expect(sharpTargets('darwin', 'universal')).toEqual(['darwin-x64', 'darwin-arm64']);
    const server = tree(['colour', 'sharp-darwin-x64', 'sharp-darwin-arm64', 'sharp-libvips-darwin-x64', 'sharp-libvips-darwin-arm64', 'sharp-win32-x64']);
    trimServer(server, 'darwin', 'universal');
    expect(img(server)).toEqual(['colour', 'sharp-darwin-arm64', 'sharp-darwin-x64', 'sharp-libvips-darwin-arm64', 'sharp-libvips-darwin-x64']);
    rmSync(server, { recursive: true, force: true });
  });
});
