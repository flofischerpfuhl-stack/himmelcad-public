/**
 * How many adaptive-toolbar buttons fit (pure, unit tested). Since Shapr3D
 * 26.20 the adaptive bar adapts to the window height and shows "More" only
 * when not every option fits (research `notes/coverage-audit.md`, "More").
 */

/** Buttons that fit into `availablePx` at `slotPx` per button (gap included). */
export function adaptiveCapacity(availablePx: number, slotPx: number): number {
  if (!Number.isFinite(availablePx) || slotPx <= 0) return 0;
  return Math.max(0, Math.floor(availablePx / slotPx));
}

/**
 * Split of `total` commands into visible buttons and a "More" overflow for a
 * bar that holds `capacity` buttons: everything visible when it fits,
 * otherwise `capacity - 1` buttons plus the More button (at least one real
 * button — the recommended one — stays visible).
 */
export function splitAdaptive(total: number, capacity: number): { visible: number; more: boolean } {
  if (total <= capacity) return { visible: total, more: false };
  return { visible: Math.max(1, capacity - 1), more: true };
}
