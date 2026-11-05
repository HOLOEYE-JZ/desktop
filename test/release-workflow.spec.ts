import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/** What a run of the release workflow can do, read from its text: running it takes GitHub. */

const ROOT = path.resolve(import.meta.dirname, '..');
const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8').replace(/\r\n/g, '\n');

function step(name: string): string {
  const start = workflow.indexOf(`- name: ${name}\n`);
  if (start === -1) throw new Error(`no step named ${name}`);
  const next = workflow.indexOf('\n      - name: ', start + 1);
  return workflow.slice(start, next === -1 ? undefined : next);
}

test('a release needs the helper checked and its crates audited', () => {
  const checks = workflow.split('\n').filter((line) => line.includes('test/native.spec.ts -g "what the binary"'));
  expect(checks.length, 'Windows, macOS and Linux').toBe(3);
  expect(workflow).toContain('run: cargo audit');
  expect(/needs: \[[^\]]*audit-native[^\]]*\]\n\s+if: needs\.prepare\.outputs\.publish/.test(workflow)).toBe(true);
  expect(workflow).not.toContain('rustup toolchain install stable');
});

test('only a push publishes: a manual run on a tag only builds', () => {
  const lines = step('Read versions').split('\n').filter((line) => line.includes('publish=true'));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).toContain('"$EVENT_NAME" = "push"');
});

// An update on Windows downloads only the blocks that changed: electron-updater needs the new
// installer's blockmap and the old one's, both on the release.
test('Windows publishes a blockmap next to each installer, and the build makes them', () => {
  const upload = workflow.slice(workflow.indexOf('name: release-windows'));
  const paths = upload.slice(0, upload.indexOf('if-no-files-found'));
  expect(paths).toContain('release/*.exe.blockmap');
  // The publish step uploads all of it, and the provenance covers the blockmaps too.
  expect(step('Publish')).toContain('gh release upload "$tag" release/* --clobber');
  expect(step('Attest build provenance')).toContain('release/*.blockmap');
  const config = readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  expect(config).toMatch(/^ {2}differentialPackage: true$/m);
});
