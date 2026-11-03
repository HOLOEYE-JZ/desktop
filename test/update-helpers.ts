import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const FIXTURES = path.join(ROOT, 'release-test');

export interface FakeRelease {
  version: string;
  prerelease?: boolean;
}

/**
 * Enough of GitHub for electron-updater's real GitHubProvider: the releases feed, the
 * latest-release API and the release downloads, serving the real files of a fixture
 * build. So which release a channel picks is its code's decision, not this server's.
 */
export class FakeGitHub {
  requests: string[] = [];
  events: { name: string; at: number }[] = [];
  /** Newest first, as GitHub lists them. */
  releases: FakeRelease[] = [];
  /** Dribbles installers out, so a download stays in progress until this goes false. */
  throttle = false;
  /** A release asset answers with a redirect to another host. */
  redirectDownloads = false;
  redirectedHits = 0;
  /** Installer downloads the client hung up on before the end. */
  abortedDownloads = 0;
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      this.requests.push(url.pathname);
      if (req.headers.host?.startsWith('localhost')) {
        this.redirectedHits += 1;
        res.statusCode = 404;
        res.end('not here');
        return;
      }
      res.setHeader('access-control-allow-origin', '*');
      if (url.pathname.startsWith('/event/')) {
        this.events.push({ name: url.pathname.slice('/event/'.length), at: Date.now() });
        res.end('ok');
        return;
      }
      if (url.pathname.endsWith('/releases.atom')) {
        const entries = this.releases
          .map((r) => `<entry><id>tag:github.com,2008:Repository/1/v${r.version}</id><title>${r.version}</title><link rel="alternate" type="text/html" href="https://github.com/bulwarkmail/desktop/releases/tag/v${r.version}"/><content>notes</content></entry>`)
          .join('');
        res.setHeader('content-type', 'application/atom+xml');
        res.end(`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`);
        return;
      }
      if (url.pathname.endsWith('/releases/latest')) {
        const latest = this.releases.find((r) => !r.prerelease);
        if (!latest) {
          res.statusCode = 404;
          res.end('{}');
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ tag_name: `v${latest.version}` }));
        return;
      }
      const download = /\/releases\/download\/v([^/]+)\/(.+)$/.exec(url.pathname);
      if (download) {
        const file = path.join(FIXTURES, download[1], decodeURIComponent(download[2]));
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        if (this.redirectDownloads && file.endsWith('.exe')) {
          res.statusCode = 302;
          res.setHeader('location', `http://localhost:${(this.server!.address() as AddressInfo).port}${url.pathname}`);
          res.end();
          return;
        }
        res.setHeader('content-length', statSync(file).size);
        const stream = createReadStream(file);
        if (this.throttle && file.endsWith('.exe')) {
          stream.on('data', (chunk) => {
            res.write(chunk);
            if (this.throttle) {
              stream.pause();
              const again = setInterval(() => {
                if (!this.throttle || res.destroyed) {
                  clearInterval(again);
                  stream.resume();
                }
              }, 200);
              // A little at a time, so progress is seen while it's held back.
              setTimeout(() => {
                if (this.throttle && !res.destroyed) {
                  clearInterval(again);
                  stream.resume();
                }
              }, 1000);
            }
          });
          stream.on('end', () => res.end());
          res.on('close', () => {
            if (!res.writableFinished) this.abortedDownloads += 1;
            stream.destroy();
          });
          return;
        }
        stream.pipe(res);
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): void {
    this.server?.closeAllConnections();
    this.server?.close();
  }

  downloads(): string[] {
    return this.requests.filter((request) => request.endsWith('.exe') || request.endsWith('.blockmap'));
  }
}

export const INSTALL_DIR_NAME = 'bulwark-desktop';

export function installDir(): string {
  return path.join(process.env.LOCALAPPDATA!, 'Programs', INSTALL_DIR_NAME);
}

export function installedExe(): string {
  return path.join(installDir(), 'Bulwark.exe');
}

function powershell(command: string): string {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).stdout.trim();
}

/** From package.json in the installed asar: the exe's own version has no room for `-beta.1`. */
export function installedVersion(): string {
  const asar = path.join(installDir(), 'resources', 'app.asar');
  if (!existsSync(asar)) return '';
  try {
    const bytes = readFileSync(asar);
    const headerLength = bytes.readUInt32LE(12);
    const header = JSON.parse(bytes.toString('utf8', 16, 16 + headerLength));
    const entry = header.files['package.json'];
    // The file data starts after the pickle, padded to 4 bytes.
    const base = 8 + bytes.readUInt32LE(4);
    const start = base + Number(entry.offset);
    return JSON.parse(bytes.toString('utf8', start, start + entry.size)).version;
  } catch {
    return '';
  }
}

/** Runs the real installer, silently, the way a user's double-click would end up. */
export function installFixture(version: string): void {
  const installer = path.join(FIXTURES, version, `Bulwark-Setup-${version}-x64.exe`);
  const result = spawnSync(installer, ['/S'], { timeout: 420_000 });
  if (result.status !== 0) throw new Error(`the installer of ${version} exited with ${result.status}`);
}

/** Pids of anything still running from the install folder. */
export function runningFromInstall(): number[] {
  const dir = installDir().replace(/'/g, "''");
  const out = powershell(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${dir}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }`);
  return out.split(/\s+/).filter(Boolean).map(Number);
}

/** An NSIS installer at work: electron-updater's download keeps its name. */
export function installerRunning(): boolean {
  return powershell(`(Get-Process -Name 'Bulwark-Setup*' -ErrorAction SilentlyContinue | Measure-Object).Count`) !== '0';
}

export function killInstalled(): void {
  for (const pid of runningFromInstall()) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
}

export function uninstall(): void {
  killInstalled();
  // A killed process holds its exe open for a moment, and the uninstaller skips what it can't delete.
  powershell('Start-Sleep -Seconds 5');
  const uninstaller = path.join(installDir(), 'Uninstall Bulwark.exe');
  if (existsSync(uninstaller)) spawnSync(uninstaller, ['/S'], { timeout: 120_000 });
}

/** The NSIS uninstaller runs a copy of itself and returns before that's done. */
export async function waitUntilGone(): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (!existsSync(installedExe())) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('the uninstaller left the app behind');
}

export function uninstallKeys(): string[] {
  const out = powershell(`Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like 'Bulwark*' } | ForEach-Object { $_.PSChildName }`);
  return out.split(/\s+/).filter(Boolean);
}

const TOAST_KEYS = `Get-ChildItem 'HKCU:\\Software\\Classes\\CLSID' -ErrorAction SilentlyContinue | Where-Object { (Get-ItemProperty (Join-Path $_.PSPath 'LocalServer32') -ErrorAction SilentlyContinue).'(default)' -like '*Programs\\${INSTALL_DIR_NAME}\\*' }`;

/** The COM keys Electron writes for a toast, naming this install. */
export function toastKeys(): string[] {
  return powershell(`${TOAST_KEYS} | ForEach-Object { $_.PSChildName }`).split(/\s+/).filter(Boolean);
}

/** A test showed a real toast. Nothing of that stays behind on this machine. */
export function removeToastKeys(): void {
  powershell(`${TOAST_KEYS} | Remove-Item -Recurse -Force`);
}

export function plantToastKey(): void {
  const key = 'HKCU\\Software\\Classes\\CLSID\\{00000000-B017-4A2C-9F00-000000000001}\\LocalServer32';
  spawnSync('reg', ['add', key, '/ve', '/d', installedExe(), '/f'], { stdio: 'ignore' });
}

export function pendingUpdateFiles(): string[] {
  const dir = path.join(process.env.LOCALAPPDATA!, `${INSTALL_DIR_NAME}-updater`, 'pending');
  return existsSync(dir) ? readdirSync(dir).map((name) => path.join(dir, name)) : [];
}

export function hasMarkOfTheWeb(file: string): boolean {
  return powershell(`Get-Item -LiteralPath '${file}' -Stream * -ErrorAction SilentlyContinue | Where-Object Stream -eq 'Zone.Identifier' | ForEach-Object { 'yes' }`) === 'yes';
}
