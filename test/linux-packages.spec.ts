// What the deb and the rpm ask the package manager for. A depends list in electron-builder.yml
// replaces electron-builder's own, so its defaults have to stay in it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const yaml = require('js-yaml');
const FpmTarget = require('app-builder-lib/out/targets/FpmTarget').default;

const config = yaml.load(readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')) as { deb: { depends?: string[] }; rpm: { depends?: string[] } };
const defaults = (target: string): string[] => FpmTarget.prototype.getDefaultDepends.call(null, target);

test('the deb asks for ALSA by its name on Ubuntu 24.04 and on older systems, and for GBM and DRM', () => {
  const depends = config.deb.depends ?? defaults('deb');
  expect(depends).toContain('libasound2t64 | libasound2');
  expect(depends).toContain('libgbm1');
  expect(depends).toContain('libdrm2');
});

test('the deb keeps what electron-builder asks for by itself', () => {
  expect(config.deb.depends).toEqual(expect.arrayContaining(defaults('deb')));
});

test('the rpm asks for the same by Fedora\'s and openSUSE\'s names, and keeps electron-builder\'s', () => {
  const depends = config.rpm.depends ?? defaults('rpm');
  expect(depends).toContain('(alsa-lib or libasound2)');
  expect(depends).toContain('(mesa-libgbm or libgbm1)');
  expect(depends).toContain('(libdrm or libdrm2)');
  expect(depends).toContain('(libsecret or libsecret-1-0)');
  expect(depends).toEqual(expect.arrayContaining(defaults('rpm')));
});
