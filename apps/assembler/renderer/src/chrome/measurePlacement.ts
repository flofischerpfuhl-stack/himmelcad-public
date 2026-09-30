/**
 * Where the Measure panel goes (pure, unit tested). Automatic placement
 * keeps it clear of the other islands: the right dock (view cube, Display
 * island and panel toggles, down to ~364 px), the right column of
 * Parameters/History (272 px wide, `Panel.module.css` `.rightStack`), the
 * status strip and the agent-access pill at the bottom. A position the user
 * dragged to is remembered (preferences) and kept inside the window.
 */

/** Island geometry shared with the CSS (px). */
export const MEASURE_PANEL_WIDTH = 288;
const EDGE = 12;
const RIGHT_COLUMN_WIDTH = 272;
/** The right dock's bottom edge (the right column starts at 372 px). */
const RIGHT_DOCK_BOTTOM = 372;
/** Clear of the status strip and the agent-access pill. */
const BOTTOM = 64;
/** Title bar space kept visible when a remembered position is clamped. */
const MIN_VISIBLE = 40;

export interface MeasurePlacement {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  /** CSS `max-height`. */
  maxHeight: string;
}

export function measurePanelPlacement(input: {
  /** Parameters or History is open (the right column is occupied). */
  rightColumnOpen: boolean;
  /** Remembered drag position, or `null` for automatic placement. */
  position: { x: number; y: number } | null;
  window: { width: number; height: number };
}): MeasurePlacement {
  const { position, window } = input;
  if (position) {
    // A remembered position from a larger window: pull it back inside.
    const left = Math.max(0, Math.min(position.x, window.width - MEASURE_PANEL_WIDTH - EDGE));
    const top = Math.max(0, Math.min(position.y, window.height - MIN_VISIBLE));
    return { left, top, maxHeight: `calc(100% - ${top + EDGE}px)` };
  }
  if (input.rightColumnOpen) {
    // Beside the right column, bottom-aligned with it.
    return {
      right: EDGE + RIGHT_COLUMN_WIDTH + EDGE,
      bottom: BOTTOM,
      maxHeight: `calc(100% - ${BOTTOM + 64}px)`,
    };
  }
  // The right column is free: take its place below the right dock.
  return {
    right: EDGE,
    bottom: BOTTOM,
    maxHeight: `calc(100% - ${RIGHT_DOCK_BOTTOM + BOTTOM}px)`,
  };
}
