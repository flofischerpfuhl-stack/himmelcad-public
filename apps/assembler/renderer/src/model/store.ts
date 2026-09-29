/**
 * Application-state store for the HimmelCAD Assembler Phase 0 UI shell.
 *
 * This is the single source of truth the viewport, panels, adaptive
 * toolbar, command search and context menu are all built on top of. It
 * owns:
 *
 * - the document (`features`) and its derived {@link EvaluationResult}
 *   (`evaluation`), recomputed on every change;
 * - transactional undo/redo of `features` (one committed tool operation or
 *   one parameter edit = exactly one undo step);
 * - selection/hover, which are pruned to only reference geometry that
 *   still resolves after every re-evaluation;
 * - view-only state (visibility, camera requests, display mode, panels)
 *   that is deliberately **not** part of the undo history;
 * - the explicit tool state machine
 *   (`collectingReferences -> preview -> numericEditing -> committing`,
 *   with `cancel()` valid from any uncommitted state) for the three real
 *   tools implemented in Phase 0: `sketchRectangle`, `extrude`, `move`.
 *
 * Built on zustand (same library/version as `@himmelcad/ui`'s
 * `useLayoutStore`). Usable both as a React hook (`useAssemblerStore()`)
 * and imperatively (`useAssemblerStore.getState()` /
 * `useAssemblerStore.setState()`), which is how `commands/registry.ts`
 * and the test suite drive it without rendering React.
 */
import { create } from 'zustand';

import type {
  Body,
  EdgeId,
  EvaluationResult,
  ExtrudeFeature,
  ExtrudeProfileRef,
  FaceSide,
  Feature,
  MoveFeature,
  Plane,
  SketchRectFeature,
} from './mockDocument.js';
import { createDemoDocument, evaluate, planeForFace } from './mockDocument.js';

/** One selectable/hoverable thing in the viewport or a panel. */
export type SelectionItem =
  | { kind: 'body'; bodyId: string }
  | { kind: 'face'; bodyId: string; side: FaceSide }
  | { kind: 'edge'; bodyId: string; edge: EdgeId }
  | { kind: 'sketchProfile'; featureId: string }
  | { kind: 'feature'; featureId: string };

/** Explicit lifecycle every tool session moves through. `cancel()` is valid from any of these except after commit. */
export type ToolPhase = 'collectingReferences' | 'preview' | 'numericEditing' | 'committing';

interface ToolSessionBase {
  phase: ToolPhase;
}

/** `R` — draws a rectangle on a plane, or on a selected planar body face. */
export interface SketchRectangleTool extends ToolSessionBase {
  kind: 'sketchRectangle';
  plane: Plane;
  offset: number;
  preview: { x: number; y: number; width: number; height: number } | null;
}

/** `E` — extrudes a sketch profile (new body) or a body face (grow/shrink). */
export interface ExtrudeTool extends ToolSessionBase {
  kind: 'extrude';
  profile: ExtrudeProfileRef;
  distance: number;
  operation: 'new' | 'join';
  /**
   * `evaluate(features + provisional feature)`, recomputed on every
   * `setDistance` call, without ever touching `features` itself. The
   * provisional feature carries the reserved id `"__preview_extrude__"`
   * and is never part of the committed document.
   */
  previewEvaluation: EvaluationResult;
}

/** `M` — translates a single body. */
export interface MoveTool extends ToolSessionBase {
  kind: 'move';
  bodyId: string;
  delta: { dx: number; dy: number; dz: number };
}

export type ToolSession = SketchRectangleTool | ExtrudeTool | MoveTool;

/** Reserved feature id used only for the extrude tool's live preview; never committed. */
const PREVIEW_EXTRUDE_FEATURE_ID = '__preview_extrude__';

export type DisplayMode = 'shaded' | 'wireframe' | 'xray';
export type SectionAxis = 'X' | 'Y' | 'Z';
export type CameraPreset = 'iso' | 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | 'fit';

export interface ViewState {
  displayMode: DisplayMode;
  sectionEnabled: boolean;
  sectionAxis: SectionAxis;
  sectionOffset: number;
  measureEnabled: boolean;
  gridVisible: boolean;
  snapToGrid: boolean;
  gridStep: number;
  /**
   * Bumping `nonce` is the signal: the viewport agent should react to any
   * change of `nonce`, even if `preset` repeats (e.g. pressing "Front"
   * twice should re-frame the view both times).
   */
  cameraRequest: { preset: CameraPreset; nonce: number } | null;
}

export interface PanelsState {
  items: boolean;
  history: boolean;
}

/**
 * Patch for {@link editFeatureParams}. Not statically tied to the target
 * feature's kind (a `Feature` union only shares `id`/`kind`/`name`/
 * `suppressed` across all members) — callers are responsible for passing
 * a patch shape that matches the feature they are editing. Do not include
 * `id` or `kind` in a patch.
 */
export type FeaturePatch =
  | Partial<Omit<SketchRectFeature, 'id' | 'kind'>>
  | Partial<Omit<ExtrudeFeature, 'id' | 'kind'>>
  | Partial<Omit<MoveFeature, 'id' | 'kind'>>
  | Partial<Omit<Feature, 'id' | 'kind'>>;

export interface AssemblerState {
  projectName: string;
  features: Feature[];
  evaluation: EvaluationResult;

  history: { canUndo: boolean; canRedo: boolean };
  undo: () => void;
  redo: () => void;

  selection: SelectionItem[];
  hover: SelectionItem | null;
  select: (item: SelectionItem, options?: { additive?: boolean }) => void;
  toggle: (item: SelectionItem) => void;
  clearSelection: () => void;
  setHover: (item: SelectionItem | null) => void;

  hiddenBodyIds: string[];
  isolatedBodyIds: string[] | null;
  hideBodies: (bodyIds: string[]) => void;
  showBodies: (bodyIds: string[]) => void;
  showAllBodies: () => void;
  setIsolatedBodyIds: (bodyIds: string[] | null) => void;

  activeTool: ToolSession | null;
  beginSketchRectangle: (origin?: { bodyId: string; side: FaceSide }) => void;
  setPreviewRect: (x: number, y: number, width: number, height: number) => void;
  beginExtrude: (profile: ExtrudeProfileRef) => void;
  setDistance: (distanceMm: number) => void;
  setExtrudeOperation: (operation: 'new' | 'join') => void;
  beginMove: (bodyId: string) => void;
  setDelta: (dx: number, dy: number, dz: number) => void;
  /** Enters the `numericEditing` phase (e.g. a dimension field gained focus). No-op without an active tool. */
  beginNumericEditing: () => void;
  /** Leaves `numericEditing` back to `preview`. No-op unless currently `numericEditing`. */
  endNumericEditing: () => void;
  /** Commits the active tool's provisional feature as exactly one undo step. No-op without an active tool. */
  commit: () => void;
  /** Cancels the active tool. `features` and the undo stack are left exactly as they were. No-op without an active tool. */
  cancel: () => void;

  editFeatureParams: (featureId: string, patch: FeaturePatch) => void;
  setSuppressed: (featureId: string, suppressed: boolean) => void;
  renameFeature: (featureId: string, name: string) => void;
  deleteFeature: (featureId: string) => void;

  viewState: ViewState;
  setDisplayMode: (mode: DisplayMode) => void;
  setSectionEnabled: (enabled: boolean) => void;
  setSectionAxis: (axis: SectionAxis) => void;
  setSectionOffset: (offset: number) => void;
  setMeasureEnabled: (enabled: boolean) => void;
  setGridVisible: (visible: boolean) => void;
  setSnapToGrid: (enabled: boolean) => void;
  setGridStep: (step: number) => void;
  requestCamera: (preset: CameraPreset) => void;

  panels: PanelsState;
  togglePanel: (panel: keyof PanelsState) => void;
  setPanelVisible: (panel: keyof PanelsState, visible: boolean) => void;

  recentCommandIds: string[];
  pushRecentCommand: (commandId: string) => void;

  /**
   * Replaces the whole document (features + project name), resetting
   * undo history, selection, hover, and visibility state. Used for
   * "File > New" (Phase 1) and by tests to get a clean, isolated store
   * without restarting the process (the store is a module-level
   * singleton).
   */
  loadDocument: (features: Feature[], options?: { projectName?: string }) => void;
}

function selectionKeysEqual(a: SelectionItem, b: SelectionItem): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'body':
      return b.kind === 'body' && a.bodyId === b.bodyId;
    case 'face':
      return b.kind === 'face' && a.bodyId === b.bodyId && a.side === b.side;
    case 'edge':
      return b.kind === 'edge' && a.bodyId === b.bodyId && a.edge === b.edge;
    case 'sketchProfile':
      return b.kind === 'sketchProfile' && a.featureId === b.featureId;
    case 'feature':
      return b.kind === 'feature' && a.featureId === b.featureId;
  }
}

function selectionItemResolves(
  item: SelectionItem,
  bodyIds: ReadonlySet<string>,
  sketchIds: ReadonlySet<string>,
  featureIds: ReadonlySet<string>,
): boolean {
  switch (item.kind) {
    case 'body':
    case 'face':
    case 'edge':
      return bodyIds.has(item.bodyId);
    case 'sketchProfile':
      return sketchIds.has(item.featureId);
    case 'feature':
      return featureIds.has(item.featureId);
  }
}

let featureIdCounter = 0;

function createFeatureId(kind: string): string {
  featureIdCounter += 1;
  return `feature-${kind}-${featureIdCounter}`;
}

function nextFeatureName(prefix: string, features: readonly Feature[]): string {
  const count = features.filter((f) => f.name.startsWith(`${prefix} `)).length;
  return `${prefix} ${count + 1}`;
}

function buildProvisionalExtrude(
  profile: ExtrudeProfileRef,
  distance: number,
  operation: 'new' | 'join',
): ExtrudeFeature {
  return {
    id: PREVIEW_EXTRUDE_FEATURE_ID,
    name: 'Extrude (preview)',
    suppressed: false,
    kind: 'extrude',
    profile,
    distance,
    operation,
  };
}

export const useAssemblerStore = create<AssemblerState>((set, get) => {
  /**
   * Undo/redo snapshots of `features`. Deliberately kept out of the
   * public state object — the documented contract only exposes
   * `history.canUndo` / `history.canRedo` plus `undo()`/`redo()`.
   */
  let past: Feature[][] = [];
  let future: Feature[][] = [];

  interface Derived {
    features: Feature[];
    evaluation: EvaluationResult;
    selection: SelectionItem[];
    hover: SelectionItem | null;
    hiddenBodyIds: string[];
    isolatedBodyIds: string[] | null;
  }

  function computeDerived(nextFeatures: Feature[], previous: AssemblerState): Derived {
    const evaluation = evaluate(nextFeatures);
    const bodyIds = new Set(evaluation.bodies.map((b) => b.id));
    const sketchIds = new Set(evaluation.sketches.map((s) => s.featureId));
    const featureIds = new Set(nextFeatures.map((f) => f.id));
    const selection = previous.selection.filter((item) =>
      selectionItemResolves(item, bodyIds, sketchIds, featureIds),
    );
    const hover =
      previous.hover && selectionItemResolves(previous.hover, bodyIds, sketchIds, featureIds)
        ? previous.hover
        : null;
    return {
      features: nextFeatures,
      evaluation,
      selection,
      hover,
      hiddenBodyIds: previous.hiddenBodyIds.filter((id) => bodyIds.has(id)),
      isolatedBodyIds: previous.isolatedBodyIds
        ? previous.isolatedBodyIds.filter((id) => bodyIds.has(id))
        : null,
    };
  }

  function commitFeatures(nextFeatures: Feature[], selectionOverride?: SelectionItem[]): void {
    const state = get();
    past = [...past, state.features];
    future = [];
    const derived = computeDerived(nextFeatures, state);
    set({
      ...derived,
      selection: selectionOverride ?? derived.selection,
      history: { canUndo: true, canRedo: false },
      activeTool: null,
    });
  }

  return {
    projectName: 'Untitled Assembler Project',
    features: createDemoDocument(),
    evaluation: evaluate(createDemoDocument()),

    history: { canUndo: false, canRedo: false },
    undo: () => {
      const state = get();
      if (past.length === 0) return;
      const previousFeatures = past[past.length - 1]!;
      past = past.slice(0, -1);
      future = [...future, state.features];
      const derived = computeDerived(previousFeatures, state);
      set({ ...derived, history: { canUndo: past.length > 0, canRedo: future.length > 0 } });
    },
    redo: () => {
      const state = get();
      if (future.length === 0) return;
      const nextFeatures = future[future.length - 1]!;
      future = future.slice(0, -1);
      past = [...past, state.features];
      const derived = computeDerived(nextFeatures, state);
      set({ ...derived, history: { canUndo: past.length > 0, canRedo: future.length > 0 } });
    },

    selection: [],
    hover: null,
    select: (item, options) => {
      const additive = options?.additive ?? false;
      set((s) => {
        if (!additive) return { selection: [item] };
        if (s.selection.some((existing) => selectionKeysEqual(existing, item))) return {};
        return { selection: [...s.selection, item] };
      });
    },
    toggle: (item) =>
      set((s) => {
        const exists = s.selection.some((existing) => selectionKeysEqual(existing, item));
        return {
          selection: exists
            ? s.selection.filter((existing) => !selectionKeysEqual(existing, item))
            : [...s.selection, item],
        };
      }),
    clearSelection: () => set({ selection: [] }),
    setHover: (item) => set({ hover: item }),

    hiddenBodyIds: [],
    isolatedBodyIds: null,
    hideBodies: (bodyIds) =>
      set((s) => ({ hiddenBodyIds: [...new Set([...s.hiddenBodyIds, ...bodyIds])] })),
    showBodies: (bodyIds) =>
      set((s) => ({ hiddenBodyIds: s.hiddenBodyIds.filter((id) => !bodyIds.includes(id)) })),
    showAllBodies: () => set({ hiddenBodyIds: [] }),
    setIsolatedBodyIds: (bodyIds) => set({ isolatedBodyIds: bodyIds }),

    activeTool: null,
    beginSketchRectangle: (origin) => {
      const state = get();
      let plane: Plane = 'XY';
      let offset = 0;
      if (origin) {
        const body = state.evaluation.bodies.find((b) => b.id === origin.bodyId);
        if (body) {
          const derived = planeForFace(body, origin.side);
          plane = derived.plane;
          offset = derived.offset;
        }
      }
      set({
        activeTool: {
          kind: 'sketchRectangle',
          phase: 'collectingReferences',
          plane,
          offset,
          preview: null,
        },
      });
    },
    setPreviewRect: (x, y, width, height) => {
      const tool = get().activeTool;
      if (!tool || tool.kind !== 'sketchRectangle') return;
      set({ activeTool: { ...tool, phase: 'preview', preview: { x, y, width, height } } });
    },
    beginExtrude: (profile) => {
      const state = get();
      const provisional = buildProvisionalExtrude(profile, 0, 'new');
      set({
        activeTool: {
          kind: 'extrude',
          phase: 'collectingReferences',
          profile,
          distance: 0,
          operation: 'new',
          previewEvaluation: evaluate([...state.features, provisional]),
        },
      });
    },
    setDistance: (distanceMm) => {
      const state = get();
      const tool = state.activeTool;
      if (!tool || tool.kind !== 'extrude') return;
      const provisional = buildProvisionalExtrude(tool.profile, distanceMm, tool.operation);
      set({
        activeTool: {
          ...tool,
          phase: 'preview',
          distance: distanceMm,
          previewEvaluation: evaluate([...state.features, provisional]),
        },
      });
    },
    setExtrudeOperation: (operation) => {
      const state = get();
      const tool = state.activeTool;
      if (!tool || tool.kind !== 'extrude') return;
      const provisional = buildProvisionalExtrude(tool.profile, tool.distance, operation);
      set({
        activeTool: {
          ...tool,
          operation,
          previewEvaluation: evaluate([...state.features, provisional]),
        },
      });
    },
    beginMove: (bodyId) => {
      set({
        activeTool: {
          kind: 'move',
          phase: 'collectingReferences',
          bodyId,
          delta: { dx: 0, dy: 0, dz: 0 },
        },
      });
    },
    setDelta: (dx, dy, dz) => {
      const tool = get().activeTool;
      if (!tool || tool.kind !== 'move') return;
      set({ activeTool: { ...tool, phase: 'preview', delta: { dx, dy, dz } } });
    },
    beginNumericEditing: () => {
      const tool = get().activeTool;
      if (!tool) return;
      set({ activeTool: { ...tool, phase: 'numericEditing' } });
    },
    endNumericEditing: () => {
      const tool = get().activeTool;
      if (!tool || tool.phase !== 'numericEditing') return;
      set({ activeTool: { ...tool, phase: 'preview' } });
    },
    commit: () => {
      const state = get();
      const tool = state.activeTool;
      if (!tool) return;

      if (tool.kind === 'sketchRectangle') {
        if (!tool.preview) {
          set({ activeTool: null });
          return;
        }
        const id = createFeatureId('sketchRect');
        const feature: SketchRectFeature = {
          id,
          name: nextFeatureName('Sketch', state.features),
          suppressed: false,
          kind: 'sketchRect',
          plane: tool.plane,
          offset: tool.offset,
          x: tool.preview.x,
          y: tool.preview.y,
          width: tool.preview.width,
          height: tool.preview.height,
        };
        commitFeatures([...state.features, feature], [{ kind: 'sketchProfile', featureId: id }]);
        return;
      }

      if (tool.kind === 'extrude') {
        const id = createFeatureId('extrude');
        const feature: ExtrudeFeature = {
          id,
          name: nextFeatureName('Extrude', state.features),
          suppressed: false,
          kind: 'extrude',
          profile: tool.profile,
          distance: tool.distance,
          operation: tool.operation,
        };
        commitFeatures([...state.features, feature]);
        return;
      }

      if (tool.kind === 'move') {
        const id = createFeatureId('move');
        const feature: MoveFeature = {
          id,
          name: nextFeatureName('Move', state.features),
          suppressed: false,
          kind: 'move',
          bodyId: tool.bodyId,
          dx: tool.delta.dx,
          dy: tool.delta.dy,
          dz: tool.delta.dz,
        };
        commitFeatures([...state.features, feature]);
      }
    },
    cancel: () => set({ activeTool: null }),

    editFeatureParams: (featureId, patch) => {
      const state = get();
      const next = state.features.map((f) =>
        f.id === featureId ? ({ ...f, ...patch } as Feature) : f,
      );
      commitFeatures(next);
    },
    setSuppressed: (featureId, suppressed) => {
      const state = get();
      const next = state.features.map((f) => (f.id === featureId ? { ...f, suppressed } : f));
      commitFeatures(next);
    },
    renameFeature: (featureId, name) => {
      const state = get();
      const next = state.features.map((f) => (f.id === featureId ? { ...f, name } : f));
      commitFeatures(next);
    },
    deleteFeature: (featureId) => {
      const state = get();
      const next = state.features.filter((f) => f.id !== featureId);
      commitFeatures(next);
    },

    viewState: {
      displayMode: 'shaded',
      sectionEnabled: false,
      sectionAxis: 'Z',
      sectionOffset: 0,
      measureEnabled: false,
      gridVisible: true,
      snapToGrid: true,
      gridStep: 5,
      cameraRequest: null,
    },
    setDisplayMode: (mode) => set((s) => ({ viewState: { ...s.viewState, displayMode: mode } })),
    setSectionEnabled: (enabled) =>
      set((s) => ({ viewState: { ...s.viewState, sectionEnabled: enabled } })),
    setSectionAxis: (axis) => set((s) => ({ viewState: { ...s.viewState, sectionAxis: axis } })),
    setSectionOffset: (offset) =>
      set((s) => ({ viewState: { ...s.viewState, sectionOffset: offset } })),
    setMeasureEnabled: (enabled) =>
      set((s) => ({ viewState: { ...s.viewState, measureEnabled: enabled } })),
    setGridVisible: (visible) =>
      set((s) => ({ viewState: { ...s.viewState, gridVisible: visible } })),
    setSnapToGrid: (enabled) =>
      set((s) => ({ viewState: { ...s.viewState, snapToGrid: enabled } })),
    setGridStep: (step) => set((s) => ({ viewState: { ...s.viewState, gridStep: step } })),
    requestCamera: (preset) =>
      set((s) => ({
        viewState: {
          ...s.viewState,
          cameraRequest: { preset, nonce: (s.viewState.cameraRequest?.nonce ?? 0) + 1 },
        },
      })),

    panels: { items: true, history: true },
    togglePanel: (panel) => set((s) => ({ panels: { ...s.panels, [panel]: !s.panels[panel] } })),
    setPanelVisible: (panel, visible) =>
      set((s) => ({ panels: { ...s.panels, [panel]: visible } })),

    recentCommandIds: [],
    pushRecentCommand: (commandId) =>
      set((s) => ({
        recentCommandIds: [commandId, ...s.recentCommandIds.filter((id) => id !== commandId)].slice(
          0,
          8,
        ),
      })),

    loadDocument: (features, options) => {
      past = [];
      future = [];
      const previous = get();
      const derived = computeDerived(features, {
        ...previous,
        selection: [],
        hover: null,
        hiddenBodyIds: [],
        isolatedBodyIds: null,
      });
      set({
        ...derived,
        projectName: options?.projectName ?? previous.projectName,
        history: { canUndo: false, canRedo: false },
        activeTool: null,
        selection: [],
        hover: null,
      });
    },
  };
});

export type { Body, EdgeId, EvaluationResult, ExtrudeProfileRef, FaceSide, Feature, Plane };
