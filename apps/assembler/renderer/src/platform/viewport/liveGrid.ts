/**
 * The grid resolution the viewport currently draws (`gridResolution.ts`),
 * published for everything that snaps or reads out at that step — sketch
 * snapping, the grid read-out — without depending on the module that
 * happens to host the viewport's transient UI state. Session-only.
 */
import { create } from 'zustand';

export interface LiveGridState {
  /** The zoom-dependent grid step (mm), `null` before the viewport's first frame. */
  liveGridStep: number | null;
}

export const useLiveGrid = create<LiveGridState>(() => ({ liveGridStep: null }));

/** Called by the viewport per frame; notifies subscribers only on a change. */
export function publishLiveGridStep(step: number): void {
  if (useLiveGrid.getState().liveGridStep !== step) useLiveGrid.setState({ liveGridStep: step });
}
