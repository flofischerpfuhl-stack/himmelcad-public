/**
 * Zoom-dependent grid resolution (pure, unit tested). Shapr3D shows the
 * current grid resolution next to the unit icon; it follows the zoom and
 * can be locked (interaction research §5). Assembler: the viewport draws
 * the grid at {@link adaptiveGridStep} of its current scale while
 * `viewState.gridAuto` is on and publishes it (`viewportUi.liveGridStep`);
 * locking keeps `viewState.gridStep`.
 */

/** The 1-2-5 series of grid steps, mm. */
export const GRID_STEP_SERIES: readonly number[] = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000,
];

/** Smallest on-screen spacing of minor grid lines, CSS px. */
export const MIN_GRID_SPACING_PX = 14;

/** The finest series step whose lines are at least {@link MIN_GRID_SPACING_PX} apart. */
export function adaptiveGridStep(mmPerPx: number): number {
  if (!Number.isFinite(mmPerPx) || mmPerPx <= 0) return 5;
  const minimum = mmPerPx * MIN_GRID_SPACING_PX;
  return GRID_STEP_SERIES.find((step) => step >= minimum) ?? GRID_STEP_SERIES.at(-1)!;
}

/** The grid step in effect: the live zoom-dependent one unless the grid is locked. */
export function effectiveGridStep(
  view: { gridAuto?: boolean; gridStep: number },
  liveStep: number | null,
): number {
  return view.gridAuto !== false && liveStep !== null ? liveStep : view.gridStep;
}

/** "0.5 mm", "10 mm" — the read-out of a grid step. */
export function formatGridStep(step: number): string {
  return `${Number(step.toPrecision(3))} mm`;
}
