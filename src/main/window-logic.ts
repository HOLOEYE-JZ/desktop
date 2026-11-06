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

/**
 * Whether the next main window starts hidden: a start in the tray, or a toast's button that
 * needs the page but not the window. Someone asking to see the app before that window exists
 * (a toast clicked while the app is still starting) wins, whichever of the two came first.
 */
export class MainStart {
  private hidden = false;
  private wanted = false;

  startHidden(): void {
    if (!this.wanted) this.hidden = true;
  }

  wantShown(): void {
    this.wanted = true;
    this.hidden = false;
  }

  /** The main window is being made: whether it starts hidden. Both wishes are spent. */
  take(): boolean {
    const hidden = this.hidden;
    this.hidden = false;
    this.wanted = false;
    return hidden;
  }
}

/**
 * What "show me the app" does. `hidden`: the page has work to do, the window stays where it is.
 * Until the boot opens the main window there's nothing to show, so what was asked is kept for it.
 */
export function showMainStep(input: { booted: boolean; hasMain: boolean; hidden: boolean }): 'keep-wish' | 'start-hidden' | 'open' | 'focus' | 'none' {
  if (!input.booted) return input.hidden ? 'start-hidden' : 'keep-wish';
  if (!input.hasMain) return 'open';
  return input.hidden ? 'none' : 'focus';
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

