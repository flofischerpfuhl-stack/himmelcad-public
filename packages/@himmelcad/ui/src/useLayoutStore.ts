import { create } from 'zustand';

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const LEFT_MIN = 180;
const LEFT_MAX = 640;
const RIGHT_MIN = 220;
const RIGHT_MAX = 640;
const BOTTOM_MIN = 100;
/** Hard ceiling even on large displays — console must not dominate the shell. */
const BOTTOM_MAX_HARD = 420;
/** Share of window height the console may occupy while dragging. */
const BOTTOM_MAX_RATIO = 0.38;
/** Keep this much for the 3D viewport (plus title/ribbon/status chrome). */
const VIEWPORT_MIN = 240;
const SHELL_CHROME = 160;

/** Dynamic max so the console cannot be dragged over most of the window. */
export function bottomPanelHeightMax(): number {
  if (typeof window === 'undefined') return BOTTOM_MAX_HARD;
  const byRatio = Math.floor(window.innerHeight * BOTTOM_MAX_RATIO);
  const byViewport = window.innerHeight - SHELL_CHROME - VIEWPORT_MIN;
  return Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX_HARD, byRatio, byViewport));
}

function clampBottom(v: number): number {
  return clamp(v, BOTTOM_MIN, bottomPanelHeightMax());
}

export interface LayoutState {
  ribbonCollapsed: boolean;
  leftPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  bottomPanelCollapsed: boolean;
  leftPanelWidth: number;
  rightPanelWidth: number;
  bottomPanelHeight: number;
  activeFunctionId: string | null;
  openFunctionIds: readonly string[];

  setRibbonCollapsed: (v: boolean) => void;
  toggleRibbon: () => void;

  setLeftPanelCollapsed: (v: boolean) => void;
  setRightPanelCollapsed: (v: boolean) => void;
  setBottomPanelCollapsed: (v: boolean) => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  toggleBottomPanel: () => void;

  setLeftPanelWidth: (v: number) => void;
  setRightPanelWidth: (v: number) => void;
  setBottomPanelHeight: (v: number) => void;

  /**
   * Functional adjusters — used by the Splitter so concurrent drag events
   * never compose against a stale captured value. The splitter only knows
   * per-event deltas.
   */
  adjustLeftPanelWidth: (delta: number) => void;
  adjustRightPanelWidth: (delta: number) => void;
  adjustBottomPanelHeight: (delta: number) => void;

  activateFunction: (id: string | null) => void;
  closeFunction: (id: string) => void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  ribbonCollapsed: false,
  leftPanelCollapsed: false,
  rightPanelCollapsed: false,
  bottomPanelCollapsed: false,
  leftPanelWidth: 280,
  rightPanelWidth: 320,
  bottomPanelHeight: 220,
  activeFunctionId: null,
  openFunctionIds: [],

  setRibbonCollapsed: (v) => set({ ribbonCollapsed: v }),
  toggleRibbon: () => set((s) => ({ ribbonCollapsed: !s.ribbonCollapsed })),

  setLeftPanelCollapsed: (v) => set({ leftPanelCollapsed: v }),
  setRightPanelCollapsed: (v) => set({ rightPanelCollapsed: v }),
  setBottomPanelCollapsed: (v) => set({ bottomPanelCollapsed: v }),
  toggleLeftPanel: () => set((s) => ({ leftPanelCollapsed: !s.leftPanelCollapsed })),
  toggleRightPanel: () => set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),
  toggleBottomPanel: () => set((s) => ({ bottomPanelCollapsed: !s.bottomPanelCollapsed })),

  setLeftPanelWidth: (v) => set({ leftPanelWidth: clamp(v, LEFT_MIN, LEFT_MAX) }),
  setRightPanelWidth: (v) => set({ rightPanelWidth: clamp(v, RIGHT_MIN, RIGHT_MAX) }),
  setBottomPanelHeight: (v) => set({ bottomPanelHeight: clampBottom(v) }),

  adjustLeftPanelWidth: (delta) =>
    set((s) => ({ leftPanelWidth: clamp(s.leftPanelWidth + delta, LEFT_MIN, LEFT_MAX) })),
  adjustRightPanelWidth: (delta) =>
    set((s) => ({ rightPanelWidth: clamp(s.rightPanelWidth + delta, RIGHT_MIN, RIGHT_MAX) })),
  adjustBottomPanelHeight: (delta) =>
    set((s) => ({ bottomPanelHeight: clampBottom(s.bottomPanelHeight + delta) })),

  activateFunction: (id) =>
    set((state) => {
      if (id === null) return { activeFunctionId: null };
      if (state.activeFunctionId === id) {
        const openFunctionIds = state.openFunctionIds.filter((candidate) => candidate !== id);
        return {
          openFunctionIds,
          activeFunctionId: openFunctionIds.at(-1) ?? null,
        };
      }
      return {
        activeFunctionId: id,
        openFunctionIds: state.openFunctionIds.includes(id)
          ? state.openFunctionIds
          : [...state.openFunctionIds, id],
        rightPanelCollapsed: false,
      };
    }),
  closeFunction: (id) =>
    set((state) => {
      const openFunctionIds = state.openFunctionIds.filter((candidate) => candidate !== id);
      return {
        openFunctionIds,
        activeFunctionId:
          state.activeFunctionId === id ? (openFunctionIds.at(-1) ?? null) : state.activeFunctionId,
      };
    }),
}));

/** Call on window resize so an open console shrinks if the max drops. */
export function clampBottomPanelToViewport(): void {
  const { bottomPanelHeight, setBottomPanelHeight } = useLayoutStore.getState();
  const max = bottomPanelHeightMax();
  if (bottomPanelHeight > max) setBottomPanelHeight(max);
}
