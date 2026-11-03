import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * What the release jobs ask electron-builder for, through its own code. A target that names
 * its own architectures builds those whatever the command line says, which is how a Linux
 * job on x64 ends up building arm64 too and dying.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { computeArchToTargetNamesMap } = require('app-builder-lib/out/targets/targetFactory');
const { Arch } = require('builder-util');
const { Platform } = require('app-builder-lib/out/core');
const yaml = require('js-yaml');
const minimatchModule = require('minimatch');
const minimatch: (file: string, pattern: string, options: unknown) => boolean = minimatchModule.minimatch ?? minimatchModule;

const config = yaml.load(readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'));

function targets(platform: unknown, section: unknown, arch: number): Record<string, string[]> {
  const packager = { platformSpecificBuildOptions: section, defaultTarget: ['dir'] };
  const map: Map<number, string[]> = computeArchToTargetNamesMap(new Map([[arch, []]]), packager, platform);
  return Object.fromEntries([...map].map(([key, names]) => [Arch[key], names]));
}

test.describe('the release jobs', () => {
  test('--linux --x64 builds x64 only, all three formats', () => {
    expect(targets(Platform.LINUX, config.linux, Arch.x64)).toEqual({ x64: ['AppImage', 'deb', 'rpm'] });
  });

  test('--linux --arm64 builds arm64 only', () => {
    expect(targets(Platform.LINUX, config.linux, Arch.arm64)).toEqual({ arm64: ['AppImage', 'deb', 'rpm'] });
  });
});

test.describe('macOS universal, up to the merge', () => {
  // @electron/universal only runs on a Mac. What it asks of its two trees can be checked here:
  // no file on only one side, and anything the same on both sides that's a binary covered
  // by x64ArchFiles.
  async function run(hook: string, context: Record<string, unknown>) {
    const module = await import(`file://${path.join(ROOT, 'scripts', hook).replace(/\\/g, '/')}`);
    await module.default.default(context);
  }

  test('x64 and arm64 get the same server, and the rule covers its binaries', async () => {
    const project = mkdtempSync(path.join(tmpdir(), 'bw-mac-'));
    try {
      const web = path.join(project, 'webmail');
      for (const name of ['sharp-darwin-x64', 'sharp-darwin-arm64', 'sharp-libvips-darwin-x64', 'sharp-libvips-darwin-arm64', 'sharp-win32-x64', 'colour']) {
        mkdirSync(path.join(web, 'node_modules', '@img', name), { recursive: true });
        writeFileSync(path.join(web, 'node_modules', '@img', name, 'lib.node'), name);
      }
      mkdirSync(path.join(web, 'node_modules', 'sharp'), { recursive: true });
      writeFileSync(path.join(web, 'node_modules', 'sharp', 'package.json'), '{}');
      mkdirSync(path.join(web, '.next', 'static'), { recursive: true });
      mkdirSync(path.join(web, 'public'), { recursive: true });
      writeFileSync(path.join(web, 'server.js'), '// stand-in');
      writeFileSync(path.join(web, '.next', 'required-server-files.json'), JSON.stringify({ config: {} }));
      writeFileSync(path.join(web, 'package.json'), '{}');
      const sides: Record<string, { sha: string; files: string[] }> = {};
      for (const [arch, code] of [['x64', 1], ['arm64', 3]] as const) {
        const packager = { projectDir: project, appInfo: { productFilename: 'Bulwark' } };
        await run('before-pack.cjs', { packager, electronPlatformName: 'darwin', arch: code });
        const built = path.join(project, '.server-build', `mac-${arch}`);
        const listing: string[] = [];
        const visit = (dir: string, prefix: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) visit(path.join(dir, entry.name), `${prefix}${entry.name}/`);
            else listing.push(`${prefix}${entry.name}`);
          }
        };
        visit(path.join(built, 'server.asar.unpacked'), 'server.asar.unpacked/');
        sides[arch] = { sha: createHash('sha256').update(readFileSync(path.join(built, 'server.asar'))).digest('hex'), files: listing.sort() };
      }
      expect(sides.x64.sha, 'a different server.asar stops the merge').toBe(sides.arm64.sha);
      expect(sides.x64.files).toEqual(sides.arm64.files);
      const binaries = sides.x64.files.filter((file) => file.endsWith('.node'));
      expect(binaries.some((file) => file.includes('sharp-darwin-x64'))).toBe(true);
      expect(binaries.some((file) => file.includes('sharp-darwin-arm64'))).toBe(true);
      expect(binaries.some((file) => file.includes('win32'))).toBe(false);
      for (const file of binaries) {
        expect(minimatch(`Contents/Resources/${file}`, config.mac.x64ArchFiles, { matchBase: true }), file).toBe(true);
      }
    } finally {
      rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  });
});
