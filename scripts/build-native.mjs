// Builds the native helper (native/) with cargo, into
// native/dist/<platform>-<arch>/bulwark-native.node. Not committed: electron-builder
// picks it up from there (electron-builder.yml, files).
//
//   node scripts/build-native.mjs                     this machine
//   node scripts/build-native.mjs --arch arm64        cross-build, needs that Rust
//                                                     target and its linker libraries
//   node scripts/build-native.mjs --optional          no cargo: say so and carry on,
//                                                     the app runs without the helper

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The environment for cargo. RUSTFLAGS and its relatives replace the flags in
 * native/.cargo/config.toml, the ones that link the C runtime in and keep DLLs to System32.
 */
export function cargoEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^CARGO_(ENCODED_|BUILD_|TARGET_.*_)?RUSTFLAGS$|^RUSTFLAGS$/.test(name)));
}

const TRIPLES = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};

const LIBRARY = { win32: 'bulwark_native.dll', darwin: 'libbulwark_native.dylib', linux: 'libbulwark_native.so' };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const optional = args.includes('--optional');
  const arch = option('--arch') ?? process.arch;
  const key = `${process.platform}-${arch}`;
  const triple = TRIPLES[key];
  if (!triple) {
    console.error(`No Rust target known for ${key}`);
    process.exit(1);
  }

  const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  if (probe.status !== 0) {
    if (optional) {
      console.warn('[build-native] cargo not found: building without the native helper. Hello and the OS keystore will be unavailable.');
      process.exit(0);
    }
    console.error('[build-native] cargo not found. Install Rust from https://rustup.rs');
    process.exit(1);
  }

  // In native/, because cargo reads .cargo/config.toml from where it runs.
  const built = spawnSync('cargo', ['build', '--release', '--locked', '--target', triple], {
    cwd: path.join(ROOT, 'native'),
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: cargoEnv(process.env),
  });
  if (built.status !== 0) process.exit(built.status ?? 1);

  const outDir = path.join(ROOT, 'native', 'dist', key);
  mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'bulwark-native.node');
  copyFileSync(path.join(ROOT, 'native', 'target', triple, 'release', LIBRARY[process.platform]), out);
  console.log(`[build-native] ${path.relative(ROOT, out)}`);
}
