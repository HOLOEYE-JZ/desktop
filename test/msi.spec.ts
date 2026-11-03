import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * The MSI, as far as it goes without elevation: its tables, and an administrative image,
 * which is the files it would put in Program Files. `npm run dist:win` first. Installing
 * it for real takes an elevated prompt: see the README's manual checklist.
 */

const RELEASE = path.resolve(import.meta.dirname, '..', 'release');
const msi = existsSync(RELEASE) ? readdirSync(RELEASE).find((name) => /^Bulwark-.*-x64\.msi$/.test(name)) : undefined;

function powershell(script: string): string {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  return result.stdout.trim();
}

function table(file: string, query: string): string[] {
  const script = `$i = New-Object -ComObject WindowsInstaller.Installer; $d = $i.GetType().InvokeMember('OpenDatabase','InvokeMethod',$null,$i,@('${file}',0)); $v = $d.GetType().InvokeMember('OpenView','InvokeMethod',$null,$d,@("${query}")); $v.GetType().InvokeMember('Execute','InvokeMethod',$null,$v,$null) | Out-Null; while ($r = $v.GetType().InvokeMember('Fetch','InvokeMethod',$null,$v,$null)) { $r.GetType().InvokeMember('StringData','GetProperty',$null,$r,1) }`;
  return powershell(script).split(/\r?\n/).filter(Boolean);
}

function files(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

test.describe('the MSI', () => {
  test.skip(process.platform !== 'win32' || !msi, 'run npm run dist:win first');
  test.setTimeout(300_000);
  const file = () => path.join(RELEASE, msi!);

  test('is per-machine, with the one upgrade code, and has no custom actions that would elevate', () => {
    const property = (name: string) => table(file(), `SELECT Value FROM Property WHERE Property='${name}'`)[0];
    expect(property('ALLUSERS')).toBe('1');
    expect(property('UpgradeCode')).toBe('{7E4C3B52-6F0A-4D8E-9B31-2C5D8A1F6E47}');
    expect(property('ProductName')).toBe('Bulwark');
    // Nothing runs after an unattended install.
    expect(table(file(), "SELECT Action FROM CustomAction WHERE Action='runAfterFinish'")).toEqual([]);
    // Replaces an older MSI: the action WiX adds for a major upgrade.
    expect(table(file(), 'SELECT Action FROM InstallExecuteSequence').join(' ')).toContain('RemoveExistingProducts');
  });

  test('holds what the unpacked app holds, and nothing that lets it update itself', () => {
    const image = mkdtempSync(path.join(tmpdir(), 'bw-msi-'));
    try {
      const made = spawnSync('msiexec', ['/a', file(), '/qn', `TARGETDIR=${image}`], { timeout: 240_000 });
      expect(made.status).toBe(0);
      const exe = files(image).find((name) => name.endsWith('Bulwark.exe'));
      expect(exe).toBeTruthy();
      const root = path.dirname(path.join(image, exe!));
      const unpacked = path.join(RELEASE, 'win-unpacked');
      expect(files(root).sort()).toEqual(files(unpacked).sort());
      expect(statSync(path.join(root, 'resources', 'app.asar')).size).toBe(statSync(path.join(unpacked, 'resources', 'app.asar')).size);
      // How the updater tells: no NSIS uninstaller means it never runs an installer.
      expect(existsSync(path.join(root, 'Uninstall Bulwark.exe'))).toBe(false);
    } finally {
      rmSync(image, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });

  test('without elevation it stops with an error and leaves nothing', () => {
    const elevated = powershell('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
    test.skip(elevated === 'True', 'this one is about not being elevated');
    const log = path.join(mkdtempSync(path.join(tmpdir(), 'bw-msilog-')), 'msi.log');
    writeFileSync(log, '');
    const result = spawnSync('msiexec', ['/i', file(), '/qn', '/L*v', log], { timeout: 240_000 });
    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Bulwark'))).toBe(false);
  });
});
