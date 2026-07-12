import { create } from 'zustand';

const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

const LEFT_MIN = 180;
const LEFT_MAX = 640;
const RIGHT_MIN = 220;
const RIGHT_MAX = 640;
const BOTTOM_MIN = 100;
const BOTTOM_MAX = 700;

export interface LayoutState {
  ribbonCollapsed: boolean;
  leftPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  bottomPanelCollapsed: boolean;
  leftPanelWidth: number;
  rightPanelWidth: number;
  bottomPanelHeight: number;
  activeFunctionId: string | null;

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
  setBottomPanelHeight: (v) => set({ bottomPanelHeight: clamp(v, BOTTOM_MIN, BOTTOM_MAX) }),

  adjustLeftPanelWidth: (delta) =>
    set((s) => ({ leftPanelWidth: clamp(s.leftPanelWidth + delta, LEFT_MIN, LEFT_MAX) })),
  adjustRightPanelWidth: (delta) =>
    set((s) => ({ rightPanelWidth: clamp(s.rightPanelWidth + delta, RIGHT_MIN, RIGHT_MAX) })),
  adjustBottomPanelHeight: (delta) =>
    set((s) => ({ bottomPanelHeight: clamp(s.bottomPanelHeight + delta, BOTTOM_MIN, BOTTOM_MAX) })),

  activateFunction: (id) =>
    set((state) => ({
      activeFunctionId: id,
      rightPanelCollapsed: id === null ? state.rightPanelCollapsed : false,
    })),
}));
