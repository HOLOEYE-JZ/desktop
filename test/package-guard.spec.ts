import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  asarFiles,
  findLocaleProblems,
  findLooseFileProblems,
  findPackagedTaskIconProblems,
  findProblems,
  findResourceProblems,
  guardExtraFiles,
  MAX_SERVER_UNPACKED_FILES,
  MAX_WINDOWS_PACKAGE_FILES,
  scrubPaths,
} from '../scripts/package-guard.mjs';
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

/** Takes away the link, never what it points at. */
function unlinkOrRmdir(link: string): void {
  if (process.platform === 'win32') rmdirSync(link);
  else unlinkSync(link);
}

function makeProject(probe: string | null): Project {
  const dir = mkdtempSync(path.join(tmpdir(), 'bw-guard-'));
  for (const file of ['electron-builder.yml']) copyFileSync(path.join(ROOT, file), path.join(dir, file));
  cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  cpSync(path.join(ROOT, 'build'), path.join(dir, 'build'), { recursive: true });
  // The jump list's icons, which a Windows package takes from here.
  cpSync(path.join(ROOT, 'assets', 'os'), path.join(dir, 'assets', 'os'), { recursive: true });

  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  pkg.main = 'dist/main.cjs';
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

  // A shell that loads a native module out of the asar's unpacked side and says so.
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  if (probe) {
    copyFileSync(probe, path.join(dir, 'dist', 'probe.node'));
    // after-pack.cjs wants the helper in a Windows or macOS package.
    mkdirSync(path.join(dir, 'native', 'dist', 'win32-x64'), { recursive: true });
    copyFileSync(probe, path.join(dir, 'native', 'dist', 'win32-x64', 'bulwark-native.node'));
  }
  writeFileSync(
    path.join(dir, 'dist', 'main.cjs'),
    `const { app } = require('electron'); const fs = require('node:fs'); const out = process.argv.find((a) => a.startsWith('--out=')).slice(6);
     let loaded = 'no probe'; try { if (fs.existsSync(__dirname + '/probe.node')) loaded = typeof require('./probe.node'); } catch (e) { loaded = 'failed: ' + e.message; }
     const server = fs.readFileSync(process.resourcesPath + '/server.asar/server.js', 'utf8');
     fs.writeFileSync(out, JSON.stringify({ loaded, dir: __dirname, server })); app.exit(0);`,
  );

  const web = path.join(dir, 'webmail');
  mkdirSync(path.join(web, '.next', 'server'), { recursive: true });
  mkdirSync(path.join(web, 'node_modules', 'next'), { recursive: true });
  writeFileSync(path.join(web, 'server.js'), '// stand-in');
  writeFileSync(path.join(web, 'package.json'), '{}');
  writeFileSync(path.join(web, '.next', 'required-server-files.json'), JSON.stringify({ config: {} }));
  writeFileSync(path.join(web, 'node_modules', 'next', 'package.json'), '{}');
  mkdirSync(path.join(web, 'public'), { recursive: true });
  writeFileSync(path.join(web, 'public', 'a.txt'), 'x');

  // The junction first out, always, or removing the folder empties the real node_modules.
  const modules = path.join(dir, 'node_modules');
  symlinkSync(path.join(ROOT, 'node_modules'), modules, 'junction');
  return {
    dir,
    remove: () => {
      unlinkOrRmdir(modules);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
}

function pack(project: Project, extraEnv: Record<string, string> = {}): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  // The Electron already installed, to stay off the network, where there is one.
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  const electronDist = existsSync(dist) ? [`-c.electronDist=${dist}`] : [];
  const result = spawnSync(process.execPath, [cli, '--dir', process.platform === 'win32' ? '--win' : '--linux', '--x64', '--projectDir', project.dir, '--publish', 'never', ...electronDist], { encoding: 'utf8', env, cwd: project.dir, timeout: 280_000 });
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
  test.setTimeout(300_000);

  test('a Windows package with no native helper does not ship', () => {
    test.skip(process.platform !== 'win32', 'the helper is optional on Linux');
    const project = makeProject(findProbeModule());
    try {
      rmSync(path.join(project.dir, 'native'), { recursive: true, force: true });
      const { status, output } = pack(project);
      expect(status).not.toBe(0);
      expect(output).toContain('app.asar has no native/bulwark-native.node');
    } finally {
      project.remove();
    }
  });

  test("a Windows package without the jump list's icons does not ship", () => {
    test.skip(process.platform !== 'win32', 'only Windows reads them from a file');
    const project = makeProject(findProbeModule());
    try {
      rmSync(path.join(project.dir, 'assets', 'os', 'task-compose-light.ico'));
      const { status, output } = pack(project);
      expect(status).not.toBe(0);
      expect(output).toContain('resources/os-icons/task-compose-light.ico (missing)');
    } finally {
      project.remove();
    }
  });

  test('a clean tree packs: the control, or the two below would prove nothing', async () => {
    const probe = process.platform === 'win32' ? findProbeModule() : null;
    const project = makeProject(probe);
    try {
      const { status, output } = pack(project);
      expect(status, output).toBe(0);
      if (process.platform !== 'win32') {
        // The rest starts the package, which takes a display and a sandbox: scripts/linux-smoke.sh.
        expect(asarFiles(path.join(project.dir, 'release', 'linux-unpacked', 'resources', 'server.asar'))).toContain('server.js');
        return;
      }
      const unpacked = path.join(project.dir, 'release', 'win-unpacked');
      const exe = path.join(unpacked, 'Bulwark.exe');
      expect(existsSync(exe)).toBe(true);
      const resources = path.join(unpacked, 'resources');
      expect(findResourceProblems(resources)).toEqual([]);
      expect(asarFiles(path.join(resources, 'app.asar'))).toContain('dist/main.cjs');
      // The jump list's icons and the Files drive's, as real files where the app looks for them.
      expect(findPackagedTaskIconProblems(resources, 'win32')).toEqual([]);
      expect(readdirSync(path.join(resources, 'os-icons')).sort()).toEqual([...readdirSync(path.join(ROOT, 'assets', 'os')).filter((name) => name.startsWith('task-')), 'bulwark.ico'].sort());
      expect(readFileSync(path.join(resources, 'os-icons', 'bulwark.ico')).equals(readFileSync(path.join(ROOT, 'build', 'icon.ico')))).toBe(true);

      expect(asarFiles(path.join(resources, 'server.asar'))).toContain('server.js');
      // public/ is served out of the asar: nothing but native modules is a loose file.
      expect(asarFiles(path.join(resources, 'server.asar'))).toContain('public/a.txt');
      expect(existsSync(path.join(resources, 'server.asar.unpacked', 'public'))).toBe(false);
      // Chromium's language packs: the app's languages only, out of the 55 Electron has.
      const config = createRequire(path.join(ROOT, 'package.json'))('js-yaml').load(readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));
      expect(readdirSync(path.join(unpacked, 'locales')).sort()).toEqual(config.electronLanguages.map((language: string) => `${language}.pak`).sort());
      // ASAR integrity is on, the shell runs, and a native module loads from the unpacked side.
      const out = path.join(project.dir, 'ran.json');
      expect(await runApp(exe, out)).toBe(0);
      const ran = JSON.parse(readFileSync(out, 'utf8'));
      expect(existsSync(path.join(resources, 'app.asar.unpacked', 'dist', 'probe.node'))).toBe(true);
      expect(ran.loaded).toBe('object');

      expect(ran.server).toContain('stand-in');

      // The same for the server: integrity covers it too, so a changed file doesn't load.
      const serverAsar = path.join(resources, 'server.asar');
      const clean = readFileSync(serverAsar);
      const changed = Buffer.from(clean);
      changed[changed.indexOf(Buffer.from('stand-in'))] = 'x'.charCodeAt(0);
      writeFileSync(serverAsar, changed);
      const tamperedServer = path.join(project.dir, 'tampered-server.json');
      expect(await runApp(exe, tamperedServer), 'a changed server must not load').not.toBe(0);
      expect(existsSync(tamperedServer)).toBe(false);
      writeFileSync(serverAsar, clean);

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
      for (const file of ['data/x.json', 'local-data/x.txt', '.env', '.env.local', 'REPOS/x/y.txt', '.next/server/plugin-signing.key', '.next/static/Plugin-Signing.KEY', '.next/.env', 'node_modules/next/.env.production', 'node_modules/next/.env.staging', 'node_modules/next/plugin-signing.key']) {
        plant(project, file);
      }
      const { status, output } = pack(project);
      expect(status).not.toBe(0);
      for (const named of ['data/', 'local-data/', '.env', '.env.local', 'REPOS/', '.next/server/plugin-signing.key', '.next/static/Plugin-Signing.KEY', '.next/.env', 'node_modules/next/.env.production', 'node_modules/next/.env.staging', 'node_modules/next/plugin-signing.key']) {
        expect(output, named).toContain(named);
      }
    } finally {
      project.remove();
    }
  });
});

test.describe('a build with test switches', () => {
  test.setTimeout(300_000);

  test('does not package, unless a test script says so', () => {
    const project = makeProject(null);
    try {
      writeFileSync(path.join(project.dir, 'dist', 'main.mjs'), "const x = 'bulwark-test-update-feed';");
      const refused = pack(project);
      expect(refused.status).not.toBe(0);
      expect(refused.output).toContain('updater test switches');
      const allowed = pack(project, { BULWARK_TEST_PACK: '1' });
      expect(allowed.status, allowed.output).toBe(0);
    } finally {
      project.remove();
    }
  });
});

test.describe('what sits next to the server', () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), 'bw-res-'));

  test('an asar link or a secret next to the exe is a problem', async () => {
    const resources = dir();
    try {
      const asar = createRequire(path.join(ROOT, 'package.json'))('@electron/asar');
      const tree = path.join(resources, '..', `${path.basename(resources)}-tree`);
      mkdirSync(path.join(tree, 'dist'), { recursive: true });
      writeFileSync(path.join(tree, 'dist', 'main.cjs'), 'x');
      symlinkSync(path.join(tree, 'dist', 'main.cjs'), path.join(tree, 'dist', 'link.cjs'), 'file');
      await asar.createPackage(tree, path.join(resources, 'app.asar'));
      expect(findResourceProblems(resources)).toEqual(['app.asar/dist/link.cjs (link)']);
      rmSync(tree, { recursive: true, force: true });

      const out = path.join(resources, 'out');
      mkdirSync(out);
      writeFileSync(path.join(out, 'fine.txt'), 'x');
      expect(() => guardExtraFiles(out)).not.toThrow();
      writeFileSync(path.join(out, '.ENV.staging'), 'x');
      expect(() => guardExtraFiles(out)).toThrow(/\.ENV\.staging/);
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });

  test('an unknown file in resources/ is a problem', async () => {
    const resources = dir();
    try {
      writeFileSync(path.join(resources, 'bulwark-build.json'), '{}');
      mkdirSync(path.join(resources, 'server.asar.unpacked'));
      expect(findResourceProblems(resources)).toEqual([]);
      // What the other features ship: the policy templates and the native helper.
      mkdirSync(path.join(resources, 'policies'));
      const tree = path.join(resources, '..', `${path.basename(resources)}-native`);
      mkdirSync(path.join(tree, 'native'), { recursive: true });
      writeFileSync(path.join(tree, 'native', 'bulwark-native.node'), 'x');
      await createRequire(path.join(ROOT, 'package.json'))('@electron/asar').createPackage(tree, path.join(resources, 'app.asar'));
      rmSync(tree, { recursive: true, force: true });
      expect(findResourceProblems(resources)).toEqual([]);
      rmSync(path.join(resources, 'app.asar'));
      // Electron's own license files sit in Resources on macOS, and in no other way next to app.asar.
      writeFileSync(path.join(resources, 'LICENSE.electron.txt'), 'x');
      writeFileSync(path.join(resources, 'LICENSES.chromium.html'), 'x');
      expect(findResourceProblems(resources)).toEqual([]);
      writeFileSync(path.join(resources, 'something.txt'), 'x');
      expect(findResourceProblems(resources)).toEqual(['resources/something.txt']);
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });
});

test.describe('what the guard looks for', () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), 'bw-names-'));
  const put = (root: string, relative: string, text = 'x') => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  };

  test('any .env under .next and node_modules, except the three that hold no secrets', () => {
    const tree = dir();
    try {
      for (const name of ['.envrc', '.env-local', '.env_prod', '.env~', '.ENV.staging']) put(tree, `.next/server/${name}`);
      put(tree, 'node_modules/a/.envrc');
      for (const name of ['.env.example', '.env.sample', '.env.template', 'env.js', 'my.env']) put(tree, `node_modules/a/${name}`);
      expect(findProblems(tree)).toEqual(
        ['.next/server/.ENV.staging', '.next/server/.env-local', '.next/server/.env_prod', '.next/server/.env~', '.next/server/.envrc', 'node_modules/a/.envrc'].sort(),
      );
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  test('private folders and files in the unpacked sides and the policies', () => {
    const resources = dir();
    try {
      put(resources, 'server.asar.unpacked/public/a.txt');
      put(resources, 'server.asar.unpacked/.next/static/chunks/data/a.js');
      put(resources, 'app.asar.unpacked/native/bulwark-native.node');
      put(resources, 'policies/bulwark.admx');
      expect(findResourceProblems(resources, 'linux')).toEqual([]);

      put(resources, 'server.asar.unpacked/data/admin.json');
      put(resources, 'app.asar.unpacked/repos/a');
      put(resources, 'policies/local-data/a');
      put(resources, 'policies/.env');
      expect(findResourceProblems(resources, 'linux')).toEqual(
        ['app.asar.unpacked/repos/', 'policies/.env', 'policies/local-data/', 'server.asar.unpacked/data/'].sort(),
      );
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });

  test("a compiler's leftovers in the unpacked side", () => {
    const resources = dir();
    const build = 'app.asar.unpacked/node_modules/@vscode/policy-watcher/build';
    try {
      put(resources, `${build}/Release/vscode-policy-watcher.node`);
      expect(findResourceProblems(resources, 'win32')).toEqual([]);
      for (const name of ['a.iobj', 'a.ipdb', 'a.lib', 'a.exp', 'a.vcxproj', 'a.tlog/CL.command.1.tlog']) put(resources, `${build}/Release/${name}`);
      expect(findResourceProblems(resources, 'win32')).toEqual(
        ['a.exp', 'a.iobj', 'a.ipdb', 'a.lib', 'a.tlog', 'a.tlog/CL.command.1.tlog', 'a.vcxproj'].map((name) => `${build}/Release/${name}`),
      );
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });

  test('macOS names only on macOS, and only the ones Electron puts there', () => {
    const resources = dir();
    try {
      put(resources, 'icon.icns');
      mkdirSync(path.join(resources, 'en.lproj'));
      put(resources, 'de.lproj/locale.pak');
      expect(findResourceProblems(resources, 'darwin')).toEqual([]);
      for (const platform of ['win32', 'linux'] as const) {
        expect(findResourceProblems(resources, platform)).toEqual(['resources/de.lproj', 'resources/en.lproj', 'resources/icon.icns']);
      }

      put(resources, 'a.plist');
      put(resources, 'b.nib');
      put(resources, 'other.icns');
      put(resources, 'de.lproj/secret.txt');
      expect(findResourceProblems(resources, 'darwin')).toEqual(['resources/a.plist', 'resources/b.nib', 'resources/de.lproj/secret.txt', 'resources/other.icns']);
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });

  test('the path scrub takes every way a path lands in a built file', () => {
    const tree = dir();
    const root = 'C:\\Users\\someone\\my project';
    try {
      put(tree, '.next/required-server-files.json', JSON.stringify({ config: { outputFileTracingRoot: root } }));
      const spellings: Record<string, string> = {
        'a.js': root,
        'b.js': root.split('\\').join('/'),
        'c.js': root.split('\\').join('\\\\'),
        'd.js': root.split('\\').join('\\\\\\\\'),
        'e.js': encodeURIComponent(root),
        'f.js': encodeURI(root.split('\\').join('/')),
        'g.js': encodeURIComponent(root.split('\\').join('/')),
        'h.css': `url(${root.split('\\').join('/')}/a.png)`,
      };
      for (const [name, text] of Object.entries(spellings)) put(tree, `.next/${name}`, `before ${text} after`);
      scrubPaths(tree);
      for (const name of Object.keys(spellings)) {
        const after = readFileSync(path.join(tree, '.next', name), 'utf8');
        expect(after, name).toContain('/bulwark-build');
        expect(after, name).not.toContain('someone');
      }
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});

test.describe('loose files', () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), 'bw-loose-'));
  const put = (root: string, relative: string, text = 'x') => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  };

  // A small server tree packed as before-pack packs the real one.
  test('the server archive keeps only native modules out of the asar', async () => {
    const project = dir();
    try {
      const source = path.join(project, 'webmail');
      for (const file of ['server.js', 'package.json', '.next/required-server-files.json', '.next/server/app/page.js', '.next/static/chunks/main.js', '.next/static/media/font.woff2', 'public/sw.js', 'public/sqlite3mc/sqlite3.wasm', 'node_modules/next/dist/server.js']) {
        put(source, file, file.endsWith('.json') ? '{}' : `// ${file}`);
      }
      for (const file of ['node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node', 'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll', 'node_modules/@img/sharp-win32-x64/package.json', 'node_modules/other/addon.node']) put(source, file);
      const { buildServerArchive } = await import('../scripts/server-archive.mjs');
      const { dir: out } = await buildServerArchive({ projectDir: project, platform: 'win32', arch: 'x64', source });
      const packed = asarFiles(path.join(out, 'server.asar'));
      for (const file of ['server.js', '.next/server/app/page.js', '.next/static/chunks/main.js', '.next/static/media/font.woff2', 'public/sw.js', 'public/sqlite3mc/sqlite3.wasm']) expect(packed, file).toContain(file);
      const loose: string[] = [];
      const walk = (folder: string) => {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(folder, entry.name));
          else loose.push(path.relative(path.join(out, 'server.asar.unpacked'), path.join(folder, entry.name)).split(path.sep).join('/'));
        }
      };
      walk(path.join(out, 'server.asar.unpacked'));
      expect(loose.sort()).toEqual(['node_modules/@img/sharp-win32-x64/lib/libvips-42.dll', 'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node', 'node_modules/@img/sharp-win32-x64/package.json', 'node_modules/other/addon.node']);

      // Next serves public/ and .next/static with fs.stat and fs.createReadStream. Electron's
      // asar support answers both from inside the archive, a byte range as well.
      const script = path.join(project, 'stream.cjs');
      writeFileSync(
        script,
        `const fs = require('node:fs'); const file = process.argv[2] + '/server.asar/public/sw.js';
         const size = fs.statSync(file).size; const parts = [];
         fs.createReadStream(file, { start: 3 }).on('data', (c) => parts.push(c)).on('end', () => { process.stdout.write(JSON.stringify({ size, text: Buffer.concat(parts).toString() })); });`,
      );
      const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
      const electronExe = createRequire(path.join(ROOT, 'package.json'))('electron') as unknown as string;
      const ran = spawnSync(electronExe, [script, out], { encoding: 'utf8', env });
      expect(ran.status, ran.stderr).toBe(0);
      expect(JSON.parse(ran.stdout)).toEqual({ size: '// public/sw.js'.length, text: 'public/sw.js' });
    } finally {
      rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });

  test('anything but native modules in server.asar.unpacked, or too many files, does not ship', () => {
    const out = dir();
    try {
      const resources = path.join(out, 'resources');
      put(resources, 'server.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp.node');
      put(resources, 'app.asar');
      expect(findLooseFileProblems(out, resources, 'win32')).toEqual([]);
      put(resources, 'server.asar.unpacked/public/sw.js');
      put(resources, 'server.asar.unpacked/.next/static/chunks/a.js');
      expect(findLooseFileProblems(out, resources, 'linux')).toEqual(['server.asar.unpacked/.next/static/chunks/a.js (belongs in server.asar)', 'server.asar.unpacked/public/sw.js (belongs in server.asar)']);
      rmSync(path.join(resources, 'server.asar.unpacked', 'public'), { recursive: true });
      rmSync(path.join(resources, 'server.asar.unpacked', '.next'), { recursive: true });
      for (let i = 0; i < MAX_SERVER_UNPACKED_FILES; i += 1) put(resources, `server.asar.unpacked/node_modules/a/${i}.dll`);
      expect(findLooseFileProblems(out, resources, 'linux')).toEqual([`server.asar.unpacked holds ${MAX_SERVER_UNPACKED_FILES + 1} files, at most ${MAX_SERVER_UNPACKED_FILES}`]);
      rmSync(path.join(resources, 'server.asar.unpacked', 'node_modules', 'a'), { recursive: true });
      // The whole Windows package, Electron's files with it.
      for (let i = 0; i < MAX_WINDOWS_PACKAGE_FILES - 2; i += 1) put(out, `x/${i}.bin`);
      expect(findLooseFileProblems(out, resources, 'win32')).toEqual([]);
      put(out, 'one-more.bin');
      expect(findLooseFileProblems(out, resources, 'win32')).toEqual([`the package holds ${MAX_WINDOWS_PACKAGE_FILES + 1} files, at most ${MAX_WINDOWS_PACKAGE_FILES}`]);
      expect(findLooseFileProblems(out, resources, 'linux')).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("Chromium's language packs: exactly electronLanguages, and the setting has to be there", () => {
    const out = dir();
    try {
      for (const name of ['de', 'en-US']) put(out, `locales/${name}.pak`);
      expect(findLocaleProblems(out, 'win32', ['de', 'en-US'])).toEqual([]);
      put(out, 'locales/fi.pak');
      expect(findLocaleProblems(out, 'linux', ['de', 'en-US', 'fr'])).toEqual(['locales/fi.pak', 'locales/fr.pak (missing)']);
      expect(findLocaleProblems(out, 'win32', undefined)).toEqual(['electronLanguages is not set, so every Chromium language would ship']);
      expect(findLocaleProblems(out, 'darwin', undefined)).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  // The webmail's 30 languages as Chromium resolves a system language to a pack
  // (l10n_util::CheckAndResolveLocale): es-MX takes es-419, pt-PT and pt-BR are their own, an
  // English outside the US takes en-GB. A pack missing there falls back to en-US, and the app
  // starts in English. Mongolian has no pack. Nothing else: each pack is a file in every install.
  test('electronLanguages is the app languages and what Chromium needs to resolve them', () => {
    const config = createRequire(path.join(ROOT, 'package.json'))('js-yaml').load(readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));
    const app = ['ar', 'ca', 'cs', 'da', 'de', 'en', 'es', 'et', 'fa', 'fr', 'he', 'hu', 'it', 'ja', 'ko', 'lv', 'mn', 'nb', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-TW'];
    const packs: Record<string, string[]> = { en: ['en-US', 'en-GB'], es: ['es', 'es-419'], pt: ['pt-BR', 'pt-PT'], zh: ['zh-CN'], mn: [] };
    const wanted = app.flatMap((language) => packs[language] ?? [language]);
    expect([...config.electronLanguages].sort()).toEqual([...wanted].sort());
    const available = readdirSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'locales')).map((name) => name.replace(/\.pak$/, ''));
    for (const language of wanted) expect(available, language).toContain(language);
    expect(wanted.length).toBeLessThan(available.length);
  });
});

test.describe('fetching the webmail', () => {
  const script = path.join(ROOT, 'scripts', 'fetch-webmail.mjs');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...(args.includes('--tag') ? { BULWARK_WEBMAIL_REPO: repo } : {}) } });
  let repo = '';

  test('a tag that does not exist fails and says which', () => {
    repo = mkdtempSync(path.join(tmpdir(), 'bw-repo-'));
    spawnSync('git', ['init', '-q', '--bare', repo]);
    const result = run('--tag', '9.9.9', '--out', path.join(repo, 'out'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no tag 9.9.9');
    rmSync(repo, { recursive: true, force: true });
  });

  test('a ref must really be in the webmail repo, and look like a ref', async () => {
    const { remoteCommit } = await import('../scripts/fetch-webmail.mjs');
    const remote = mkdtempSync(path.join(tmpdir(), 'bw-remote-'));
    const git = (...args: string[]) => {
      const done = spawnSync('git', ['-C', remote, '-c', 'user.name=t', '-c', 'user.email=t@example.org', ...args], { encoding: 'utf8' });
      expect(done.status, done.stderr).toBe(0);
      return done.stdout.trim();
    };
    try {
      git('init', '-q', '-b', 'main');
      git('commit', '-q', '--allow-empty', '-m', 'one');
      const first = git('rev-parse', 'HEAD');
      git('tag', '1.0.0');
      git('tag', '-a', '1.1.0', '-m', 'annotated');
      git('commit', '-q', '--allow-empty', '-m', 'two');
      const second = git('rev-parse', 'HEAD');

      expect(remoteCommit(remote, 'ref', 'main')).toBe(second);
      expect(remoteCommit(remote, 'ref', '1.0.0')).toBe(first);
      expect(remoteCommit(remote, 'tag', '1.1.0'), 'the commit, not the tag object').toBe(first);
      expect(remoteCommit(remote, 'tag', 'main'), 'a release never builds from a branch').toBeNull();
      expect(remoteCommit(remote, 'ref', 'nope')).toBeNull();
      expect(remoteCommit(remote, 'ref', '--upload-pack=evil'), 'not a flag for git').toBeNull();
      expect(remoteCommit(remote, 'ref', 'a..b')).toBeNull();
    } finally {
      rmSync(remote, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });

  test('a link in the build fails before anything is copied', () => {
    const source = mkdtempSync(path.join(tmpdir(), 'bw-src-'));
    const secret = mkdtempSync(path.join(tmpdir(), 'bw-secret-'));
    const out = path.join(source, 'out');
    try {
      const root = path.join(source, '.next', 'standalone');
      mkdirSync(path.join(root, 'node_modules', 'next'), { recursive: true });
      mkdirSync(path.join(source, 'public'), { recursive: true });
      mkdirSync(path.join(source, '.next', 'static'), { recursive: true });
      writeFileSync(path.join(root, 'server.js'), '//');
      writeFileSync(path.join(secret, 'key'), 'SECRET');
      symlinkSync(secret, path.join(root, 'data'), 'junction');
      const result = run('--path', source, '--out', out);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('links in the build');
      expect(existsSync(path.join(out, 'data', 'key')), 'nothing was copied').toBe(false);
    } finally {
      unlinkOrRmdir(path.join(source, '.next', 'standalone', 'data'));
      rmSync(source, { recursive: true, force: true });
      rmSync(secret, { recursive: true, force: true });
    }
  });

  test('NEXT_PUBLIC values in a checkout\'s env files are named, values left out', async () => {
    const source = mkdtempSync(path.join(tmpdir(), 'bw-env-'));
    try {
      writeFileSync(path.join(source, '.env.local'), 'NEXT_PUBLIC_API=secret-value\nOTHER=1\n');
      writeFileSync(path.join(source, '.env.example'), 'NEXT_PUBLIC_EXAMPLE=x\n');
      const { publicEnvKeys } = await import('../scripts/fetch-webmail.mjs');
      expect(publicEnvKeys(source)).toEqual(['.env.local: NEXT_PUBLIC_API']);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

test.describe('after-pack on a universal macOS build', () => {
  // electron-builder calls it for the x64 tree, the arm64 tree, and last for their merge. No
  // beforePack ran for the merge, so there is no archive to copy from.
  test('the merge has no archive of its own and passes, a single tree needs one', async () => {
    const requireHere = createRequire(path.join(ROOT, 'package.json'));
    const afterPack = requireHere('./scripts/after-pack.cjs').default;
    const project = mkdtempSync(path.join(tmpdir(), 'bw-afterpack-'));
    try {
      const appOutDir = path.join(project, 'release', 'mac-universal');
      const resources = path.join(appOutDir, 'Bulwark.app', 'Contents', 'Resources');
      mkdirSync(resources, { recursive: true });
      const tree = path.join(project, 'server-tree');
      mkdirSync(tree);
      writeFileSync(path.join(tree, 'server.js'), 'x');
      await requireHere('@electron/asar').createPackage(tree, path.join(resources, 'server.asar'));
      const shell = path.join(project, 'shell-tree');
      mkdirSync(path.join(shell, 'native'), { recursive: true });
      writeFileSync(path.join(shell, 'native', 'bulwark-native.node'), 'x');
      await requireHere('@electron/asar').createPackage(shell, path.join(resources, 'app.asar'));
      const context = (arch: number) => ({
        packager: { projectDir: project, appInfo: { productFilename: 'Bulwark' } },
        electronPlatformName: 'darwin',
        appOutDir,
        arch,
      });
      await afterPack(context(4));
      expect(existsSync(path.join(resources, 'bulwark-build.json'))).toBe(true);
      await expect(afterPack(context(3))).rejects.toThrow(/server\.asar\.unpacked/);
    } finally {
      rmSync(project, { recursive: true, force: true });
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
    expect(sharpTargets('darwin', 'x64')).toEqual(['darwin-x64', 'darwin-arm64']);
    const server = tree(['colour', 'sharp-darwin-x64', 'sharp-darwin-arm64', 'sharp-libvips-darwin-x64', 'sharp-libvips-darwin-arm64', 'sharp-win32-x64']);
    trimServer(server, 'darwin', 'universal');
    expect(img(server)).toEqual(['colour', 'sharp-darwin-arm64', 'sharp-darwin-x64', 'sharp-libvips-darwin-arm64', 'sharp-libvips-darwin-x64']);
    rmSync(server, { recursive: true, force: true });
  });
});
