/**
 * The Files drive's letter: what `subst` does, for this user's sign-in session. Windows forgets
 * it at sign-out, so main puts it back at each start. Only a mapping into the drive's own
 * folder counts as ours: anyone else's `subst` is never touched. No Electron here.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { systemExe } from '../system-exe';
import { inside, parseSubst } from './drive-places';

export interface LetterSystem {
  /** Letter to target, for every `subst` mapping of this session. */
  list(): Promise<Map<string, string>>;
  add(letter: string, target: string): Promise<boolean>;
  remove(letter: string): Promise<boolean>;
  /** GetLogicalDrives' mask: A is bit 0. */
  usedMask(): number;
}

function run(file: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000, encoding: 'utf8' }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? '') }));
  });
}

/** Through System32's subst.exe, by its full path. */
export function substLetters(usedMask: () => number): LetterSystem {
  const subst = systemExe('subst.exe');
  return {
    list: async () => parseSubst((await run(subst, [])).stdout),
    add: async (letter, target) => (await run(subst, [`${letter}:`, target])).ok,
    remove: async (letter) => (await run(subst, [`${letter}:`, '/D'])).ok,
    usedMask,
  };
}

const same = (a: string, b: string): boolean => path.win32.normalize(a).replace(/\\+$/, '').toLowerCase() === path.win32.normalize(b).replace(/\\+$/, '').toLowerCase();

/**
 * Makes the mappings into `base` say exactly `letter` to `target` (or none), and answers the
 * letter in use after. A letter something else holds is left alone: then there's none.
 */
export async function settleLetter(system: LetterSystem, base: string, letter: string | null, target: string | null, warn: (message: string) => void = console.warn): Promise<string | null> {
  const mappings = await system.list();
  let current: string | null = null;
  for (const [mapped, to] of mappings) {
    if (!inside(base, to)) continue;
    if (letter && target && mapped === letter && same(to, target)) {
      current = mapped;
      continue;
    }
    if (!(await system.remove(mapped))) warn(`Couldn't remove the drive letter ${mapped}:`);
  }
  if (!letter || !target || current) return current;
  const taken = (system.usedMask() & (1 << (letter.charCodeAt(0) - 65))) !== 0 || mappings.has(letter);
  if (taken && !inside(base, mappings.get(letter) ?? '')) {
    warn(`The drive letter ${letter}: is in use`);
    return null;
  }
  return (await system.add(letter, target)) ? letter : null;
}
