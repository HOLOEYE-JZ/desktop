/**
 * Where a new window goes. Pure, so it's testable with fake displays: a stored
 * position must be on a monitor that still exists, new windows open on the
 * monitor you're using, cascaded, and nothing lands off-screen.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Display {
  workArea: Rect;
}

export const CASCADE_PX = 32;
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 48;

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/** The monitor holding the window's top strip, which is what you grab it by. A monitor unplugged since has none. */
export function displayHoldingTop(bounds: Rect, displays: Display[]): Display | null {
  const strip = { x: bounds.x, y: bounds.y, width: bounds.width, height: MIN_VISIBLE_HEIGHT };
  return (
    displays.find((display) => {
      const shared = overlap(strip, display.workArea);
      return shared.width >= MIN_VISIBLE_WIDTH && shared.height >= MIN_VISIBLE_HEIGHT;
    }) ?? null
  );
}

export function isOnSomeDisplay(bounds: Rect, displays: Display[]): boolean {
  return displayHoldingTop(bounds, displays) !== null;
}

/** Moved and shrunk just enough to lie inside `area`. */
export function fitInto(bounds: Rect, area: Rect): Rect {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

export function centreIn(size: { width: number; height: number }, area: Rect): Rect {
  return fitInto(
    {
      x: area.x + Math.round((area.width - size.width) / 2),
      y: area.y + Math.round((area.height - size.height) / 2),
      ...size,
    },
    area,
  );
}

/** The window the next one cascades from sits this far in, wrapped when it reaches the edge. */
export function cascadeFrom(previous: Rect, size: { width: number; height: number }, area: Rect): Rect {
  let x = previous.x + CASCADE_PX;
  let y = previous.y + CASCADE_PX;
  if (x + size.width > area.x + area.width) x = area.x + CASCADE_PX;
  if (y + size.height > area.y + area.height) y = area.y + CASCADE_PX;
  return fitInto({ x, y, ...size }, area);
}

export interface PlacementInput {
  size: { width: number; height: number };
  /** What this window type last had, if anything. */
  stored?: Rect;
  /** The newest open window of this type. */
  sameType?: Rect;
  /** The window the user is in. */
  anchor?: Rect;
  displays: Display[];
  /** The monitor holding `anchor`, or the primary one. */
  current: Display;
}

export function placeWindow({ size, stored, sameType, anchor, displays, current }: PlacementInput): Rect {
  const area = current.workArea;
  const wanted = stored ? { width: stored.width, height: stored.height } : size;
  if (sameType) return cascadeFrom(sameType, wanted, area);
  if (anchor) {
    // First of its type: where it last was if that's the monitor in use.
    if (stored && overlap(stored, area).width >= MIN_VISIBLE_WIDTH && overlap(stored, area).height >= MIN_VISIBLE_HEIGHT) {
      return fitInto(stored, area);
    }
    return cascadeFrom(anchor, wanted, area);
  }
  // Nothing open: the stored place if its top strip is on a screen, fitted, since
  // that monitor may have shrunk.
  const holding = stored ? displayHoldingTop(stored, displays) : null;
  if (stored && holding) return fitInto(stored, holding.workArea);
  return centreIn(wanted, area);
}
