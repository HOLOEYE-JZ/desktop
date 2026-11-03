/** The parts of the window manager with no windows in them. */

import type { FlushAnswer } from '../shared/bridge';

/** The window after this one, wrapping round. Null with nothing else to go to. */
export function nextInCycle(ids: readonly number[], current: number | undefined, direction: 1 | -1): number | null {
  if (ids.length === 0) return null;
  const at = current === undefined ? -1 : ids.indexOf(current);
  if (at === -1) return ids[0];
  const next = ids[(at + direction + ids.length) % ids.length];
  return next === current ? null : next;
}

export function sumAnswers(answers: FlushAnswer[]): { failed: number; unsent: number } {
  let failed = 0;
  let unsent = 0;
  for (const answer of answers) {
    if (typeof answer?.failed === 'number' && answer.failed > 0) failed += answer.failed;
    else if (answer?.timedOut === true) failed += 1;
    if (typeof answer?.unsent === 'number' && answer.unsent > unsent) unsent = answer.unsent;
  }
  return { failed, unsent };
}

