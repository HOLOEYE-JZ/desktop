// The native helper's exports, from source: no built binary needed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { FILES_NATIVE_EXPORTS } from '../src/main/native-loader';
import { EXPORTS } from './native-exports';

const ROOT = path.resolve(import.meta.dirname, '..');
const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

test('the Rust source exports exactly the agreed list', () => {
  const source = readFileSync(path.join(ROOT, 'native', 'src', 'lib.rs'), 'utf8');
  const named = [...source.matchAll(/#\[napi\]\s*pub fn (\w+)/g)].map((match) => camel(match[1])).sort();
  expect(named).toEqual([...EXPORTS].sort());
});

test('the README names the same exports', () => {
  const readme = readFileSync(path.join(ROOT, 'native', 'README.md'), 'utf8');
  const section = /<!-- exports -->([\s\S]*?)<!-- \/exports -->/.exec(readme)![1];
  const named = [...section.matchAll(/^- `(\w+)\(/gm)].map((match) => match[1]).sort();
  expect(named).toEqual([...EXPORTS].sort());
});

test('every Files export main relies on is in the agreed list', () => {
  for (const name of FILES_NATIVE_EXPORTS) expect(EXPORTS, name).toContain(name);
});
