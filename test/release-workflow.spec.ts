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
