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

test('only a push publishes: a manual run on a tag only builds', () => {
  const lines = step('Read versions').split('\n').filter((line) => line.includes('publish=true'));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).toContain('"$EVENT_NAME" = "push"');
});
