#!/usr/bin/env node
// Builds the installer window's NSIS plugin (native/nsis-splash/splash.c) with MSVC, 32-bit
// as NSIS is, into build/x86-unicode/, where electron-builder looks for plugins. Never
// committed: `npm run dist:win` and the release workflow build it first.
//
//   node scripts/build-nsis-splash.mjs
//
// Needs Visual Studio or its Build Tools with the C++ workload (found through vswhere).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'native', 'nsis-splash', 'splash.c');
const OUT = path.join(ROOT, 'build', 'x86-unicode', 'BulwarkSplash.dll');

if (process.platform !== 'win32') {
  console.error('[build-nsis-splash] Windows only.');
  process.exit(1);
}

const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const found = existsSync(vswhere)
  ? spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0]
  : '';
const vcvars = found ? path.join(found, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat') : '';
if (!vcvars || !existsSync(vcvars)) {
  console.error('[build-nsis-splash] No MSVC with the C++ tools found.');
  process.exit(1);
}

mkdirSync(path.dirname(OUT), { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'bw-splash-'));
try {
  // /Brepro: the same source and compiler give the same bytes. Static CRT: nothing to install.
  const cl = [
    'cl /nologo /c /O1 /MT /W4 /WX /GS /guard:cf /Brepro',
    `/Fo"${path.join(work, 'splash.obj')}"`,
    `"${SOURCE}"`,
  ].join(' ');
  const link = [
    'link /nologo /DLL /Brepro /guard:cf /DYNAMICBASE /NXCOMPAT /SAFESEH',
    `/OUT:"${OUT}"`,
    `"${path.join(work, 'splash.obj')}"`,
    'user32.lib gdi32.lib advapi32.lib dwmapi.lib',
  ].join(' ');
  const command = `"${vcvars}" x86 >nul && ${cl} && ${link}`;
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { stdio: 'inherit', windowsVerbatimArguments: true, cwd: work });
  if (result.status !== 0) process.exit(result.status ?? 1);
  // link writes an import library and an export file next to the DLL; NSIS wants only the DLL.
  for (const extra of ['BulwarkSplash.lib', 'BulwarkSplash.exp']) rmSync(path.join(path.dirname(OUT), extra), { force: true });
  console.log(`[build-nsis-splash] ${path.relative(ROOT, OUT)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
