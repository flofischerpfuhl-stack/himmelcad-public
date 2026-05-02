import { create } from 'zustand';

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
  setLeftPanelCollapsed: (v: boolean) => void;
  setRightPanelCollapsed: (v: boolean) => void;
  setBottomPanelCollapsed: (v: boolean) => void;
  setLeftPanelWidth: (v: number) => void;
  setRightPanelWidth: (v: number) => void;
  setBottomPanelHeight: (v: number) => void;
  activateFunction: (id: string | null) => void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  ribbonCollapsed: false,
  leftPanelCollapsed: false,
  rightPanelCollapsed: false,
  bottomPanelCollapsed: false,
  leftPanelWidth: 280,
  rightPanelWidth: 320,
  bottomPanelHeight: 200,
  activeFunctionId: null,

  setRibbonCollapsed: (v) => set({ ribbonCollapsed: v }),
  setLeftPanelCollapsed: (v) => set({ leftPanelCollapsed: v }),
  setRightPanelCollapsed: (v) => set({ rightPanelCollapsed: v }),
  setBottomPanelCollapsed: (v) => set({ bottomPanelCollapsed: v }),
  setLeftPanelWidth: (v) => set({ leftPanelWidth: Math.max(160, Math.min(640, v)) }),
  setRightPanelWidth: (v) => set({ rightPanelWidth: Math.max(200, Math.min(640, v)) }),
  setBottomPanelHeight: (v) => set({ bottomPanelHeight: Math.max(80, Math.min(600, v)) }),
  activateFunction: (id) =>
    set((state) => ({
      activeFunctionId: id,
      rightPanelCollapsed: id === null ? state.rightPanelCollapsed : false,
    })),
}));
