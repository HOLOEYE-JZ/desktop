import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';

/**
 * Throwaway certificates in the real CurrentUser\My, for the keystore tests. Each has a
 * subject that says what it is and a unique run id. They're removed by the thumbprints
 * recorded here and never by a pattern, and `finish` compares the whole store with what
 * was there before.
 */

function powershell(script: string): string {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
    input: `$ErrorActionPreference = 'Stop'\n${script}`,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (run.status !== 0) throw new Error(`PowerShell: ${run.stderr || run.stdout}`);
  return run.stdout.trim();
}

export function storeThumbprints(): string[] {
  const out = powershell(`Get-ChildItem Cert:\\CurrentUser\\My | ForEach-Object { $_.Thumbprint }`);
  return out ? out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort() : [];
}

export interface CertSpec {
  /** Shows in the subject. */
  name: string;
  /** The rest of the New-SelfSignedCertificate line. */
  args: string;
}

export interface TestCert {
  thumbprint: string;
  subject: string;
}

export class TestCerts {
  readonly runId = randomUUID().slice(0, 8);
  private readonly before = storeThumbprints();
  private readonly made: string[] = [];

  subject(name: string): string {
    return `CN=Bulwark native helper test ${name} ${this.runId}`;
  }

  /** One certificate. An exportable key can't be asked for by accident: callers say. */
  create(spec: CertSpec): TestCert {
    const subject = this.subject(spec.name);
    const line = `New-SelfSignedCertificate -Subject '${subject}' -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddDays(2) ${spec.args}`;
    let thumbprint: string;
    try {
      thumbprint = powershell(`(${line}).Thumbprint`).split(/\r?\n/).pop()!.trim();
    } finally {
      this.adopt();
    }
    return { thumbprint, subject };
  }

  /** Picks up anything of this run, also if a command died after creating it. */
  private adopt(): void {
    const out = powershell(
      `Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -like '*${this.runId}*' } | ForEach-Object { $_.Thumbprint }`,
    );
    for (const thumbprint of out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      if (!this.made.includes(thumbprint)) this.made.push(thumbprint);
    }
  }

  /** Leaf signed by a certificate of this run. */
  signedArgs(signer: TestCert, args: string): string {
    return `-Signer (Get-Item Cert:\\CurrentUser\\My\\${signer.thumbprint}) ${args}`;
  }

  /** Whether Windows itself would hand out this key: the proof nothing here needs it to. */
  canExport(thumbprint: string): boolean {
    const answer = powershell(`
      $file = Join-Path $env:TEMP ('bw-export-' + [Guid]::NewGuid().ToString() + '.pfx')
      $password = ConvertTo-SecureString ([Guid]::NewGuid().ToString()) -AsPlainText -Force
      try {
        Export-PfxCertificate -Cert (Get-Item Cert:\\CurrentUser\\My\\${thumbprint}) -FilePath $file -Password $password -ChainOption EndEntityCertOnly | Out-Null
        Remove-Item $file -Force
        'yes'
      } catch {
        'no'
      }
    `);
    return answer === 'yes';
  }

  /** The public certificate, for what the helper won't list. */
  exportPem(thumbprint: string): string {
    const base64 = powershell(`[Convert]::ToBase64String((Get-Item Cert:\\CurrentUser\\My\\${thumbprint}).RawData)`);
    return ['-----BEGIN CERTIFICATE-----', base64, '-----END CERTIFICATE-----', ''].join('\n');
  }

  /**
   * The same certificate back in the store without its key: removed with its key,
   * then added from its public part. For "has no private key".
   */
  importPublicOnly(thumbprint: string): TestCert {
    const subject = powershell(`(Get-Item Cert:\\CurrentUser\\My\\${thumbprint}).Subject`);
    const base64 = powershell(`[Convert]::ToBase64String((Get-Item Cert:\\CurrentUser\\My\\${thumbprint}).RawData)`);
    this.remove(thumbprint);
    powershell(`
      $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (,[Convert]::FromBase64String('${base64}'))
      $store = New-Object System.Security.Cryptography.X509Certificates.X509Store 'My','CurrentUser'
      $store.Open('ReadWrite')
      $store.Add($cert)
      $store.Close()
    `);
    this.adopt();
    return { thumbprint, subject };
  }

  /** What removing a certificate does to the store, for one test that needs it gone early. */
  remove(thumbprint: string): void {
    powershell(`Remove-Item Cert:\\CurrentUser\\My\\${thumbprint} -DeleteKey`);
    const at = this.made.indexOf(thumbprint);
    if (at !== -1) this.made.splice(at, 1);
  }

  /** Removes this run's certificates, by thumbprint, and checks the store is as it was. */
  finish(): void {
    this.adopt();
    for (const thumbprint of [...this.made]) {
      if (this.before.includes(thumbprint)) throw new Error(`refusing to remove ${thumbprint}: it was there before this run`);
      this.remove(thumbprint);
    }
    expect(storeThumbprints()).toEqual(this.before);
  }
}
