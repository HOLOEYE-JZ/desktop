// Not a spec: loads the collector's real validator for the specs that check against it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface CollectorValidator {
  validate(input: unknown): Record<string, unknown> | null;
  validateErrorBatch(input: unknown, now?: number): { errors: Record<string, unknown>[] } | null;
}

const REPO = process.env.BULWARK_DASHBOARD_DIR ?? 'C:/Users/info/Downloads/jmap-webmail/repos/dashboard';
const REF = process.env.BULWARK_DASHBOARD_REF ?? 'feat/desktop-platform';

export const hasCollector = existsSync(REPO);

/** The validator on the branch this app ships against, read from git: not what's checked out. */
export async function loadCollectorValidator(): Promise<CollectorValidator> {
  const shown = spawnSync('git', ['-C', REPO, 'show', `${REF}:telemetry-collector/src/validate.ts`], { encoding: 'utf8' });
  if (shown.status !== 0) throw new Error(`no validator at ${REF}: ${shown.stderr}`);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'bw-validator-')), 'validate.ts');
  writeFileSync(file, shown.stdout);
  return await import(pathToFileURL(file).href) as CollectorValidator;
}
