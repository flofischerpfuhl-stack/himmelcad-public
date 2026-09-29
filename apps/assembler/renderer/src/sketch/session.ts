/**
 * Sketch mode (Shapr3D-style): a session edits one sketch feature on its
 * plane. It owns the working copy of the sketch, the active drawing tool,
 * the sketch selection, a session-local undo stack and the solver state.
 *
 * Contracts:
 * - Every edit (tool click, constraint, dimension, delete, drag end) is
 *   solved before it is adopted. Over-constrained, conflicting or failed
 *   edits are rejected: the last valid sketch and tool state stay, the
 *   offending constraints/dimensions are reported in `problem`.
 *   Automatically inferred constraints are dropped instead of rejecting.
 * - Edits are processed strictly in order (a serial queue), so fast clicks
 *   never race the asynchronous solver worker.
 * - Undo/Redo act inside the session (the main store's history delegate);
 *   leaving the session commits the sketch as exactly one document undo
 *   step (a new feature, or one parameter edit of the existing feature).
 * - Escape: cancels the tool (and its unfinished segment) first, then the
 *   sketch selection, then leaves the sketch.
 */
import { create } from 'zustand';

import {
  frameForFace,
  frameForPlane,
  type Plane,
  type SketchFeature,
  type SketchFrame,
  type SketchPlaneRef,
} from '../model/document.js';
import { makeFaceRef, nextFeatureName, useAssemblerStore } from '../model/store.js';
import { CONSTRAINT_INFO, planConstraint } from './constraintRules.js';
import { deleteItems, toggleConstruction, type EditResult } from './edits.js';
import { isPlainNumber } from './expressions.js';
import { getSketchSolver } from './solverProvider.js';
import type { SolveResult } from './solverTypes.js';
import {
  initialTool,
  reduceTool,
  toolInProgress,
  type SketchTool,
  type SketchToolKind,
  type ToolEvent,
} from './tools.js';
import {
  EMPTY_SKETCH,
  idAllocator,
  type SketchConstraintKind,
  type SketchData,
  type Vec2,
} from './types.js';

export interface SketchProblem {
  message: string;
  /** Constraint/dimension ids to highlight. */
  ids: string[];
}

export interface SketchSession {
  /** Feature being edited (allocated up front for a new sketch). */
  featureId: string;
  isNew: boolean;
  plane: SketchPlaneRef;
  frame: SketchFrame;
  /** `false` while a new, empty sketch may still move to the first clicked face. */
  planeLocked: boolean;
  /** Last valid (solved) sketch. */
  sketch: SketchData;
  /** The sketch as the session started (to detect changes). */
  baseline: SketchData;
  past: SketchData[];
  future: SketchData[];
  tool: SketchTool;
  /** New geometry is construction geometry. */
  construction: boolean;
  /** Selected entity/constraint/dimension ids. */
  selection: string[];
  dof: number;
  /** Ids of fully determined points/curves (`null` = unknown). */
  determined: string[] | null;
  problem: SketchProblem | null;
  /** Live drag result shown instead of `sketch` while dragging. */
  dragPreview: SketchData | null;
  /** Dimension whose value chip should open (new dimension). */
  editDimensionId: string | null;
  /** `true` while an edit is being solved. */
  solving: boolean;
}

export interface SketchCameraRequest {
  mode: 'enter' | 'exit';
  frame: SketchFrame;
  nonce: number;
}

export interface BeginSketchOptions {
  /** Edit this existing sketch feature. */
  featureId?: string;
  /** New sketch on a planar body face. */
  face?: { bodyId: string; faceKey: string };
  /** New sketch on a construction plane. */
  plane?: Plane;
  /** Tool to start with (default: select for existing, line for new sketches). */
  tool?: SketchToolKind;
}

export interface SketchState {
  session: SketchSession | null;
  camera: SketchCameraRequest | null;
  /** Starts sketch mode; `false` if the target cannot be sketched on. */
  begin: (options?: BeginSketchOptions) => boolean;
  /** Leaves sketch mode, committing the sketch as one undo step. Resolves once committed. */
  finish: () => Promise<void>;
  /** Leaves sketch mode discarding every change of this session. */
  discard: () => void;
  setTool: (kind: SketchToolKind) => void;
  /** Tool options: rectangle mode, polygon sides, dimension mode. */
  setToolOption: (patch: Partial<{ mode: string; sides: number }>) => void;
  setConstruction: (on: boolean) => void;
  /** Feeds a click / typed value / finish into the active tool (serialized). */
  dispatch: (event: ToolEvent) => Promise<void>;
  /** Moves a new, still empty sketch onto a planar body face. */
  rebaseOnFace: (bodyId: string, faceKey: string) => boolean;
  select: (ids: string[], options?: { additive?: boolean }) => void;
  clearSelection: () => void;
  deleteSelection: () => Promise<void>;
  toggleConstructionOfSelection: () => Promise<void>;
  /** Adds constraint(s) of `kind` to the selection; returns the reason when not applicable. */
  applyConstraint: (kind: SketchConstraintKind) => Promise<string | null>;
  /** Sets a dimension from typed text (number or expression). Resolves `true` when accepted. */
  setDimension: (dimensionId: string, text: string) => Promise<boolean>;
  closeDimensionEditor: () => void;
  undo: () => void;
  redo: () => void;
  beginDrag: (pointIds: string[]) => void;
  drag: (targets: Vec2[]) => void;
  endDrag: () => Promise<void>;
  dismissProblem: () => void;
  /** One Escape press; `false` when there is no session. */
  escape: () => boolean;
  /** Resolves when no edit or drag solve is pending. */
  whenIdle: () => Promise<void>;
}

// ---- helpers ---------------------------------------------------------------------------

function frameOf(plane: SketchPlaneRef): SketchFrame | null {
  if (plane.kind === 'plane') return frameForPlane(plane.plane, plane.offset);
  const normal = plane.face.signature.normal;
  return normal ? frameForFace(normal, plane.face.signature.centroid) : null;
}

function sketchDataOf(feature: SketchFeature): SketchData {
  return {
    entities: feature.entities,
    constraints: feature.constraints,
    dimensions: feature.dimensions,
  };
}

function sameSketch(a: SketchData, b: SketchData): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function labelOf(sketch: SketchData, id: string): string {
  const dimension = sketch.dimensions.find((d) => d.id === id);
  if (dimension) return dimension.name;
  const constraint = sketch.constraints.find((c) => c.id === id);
  if (constraint)
    return CONSTRAINT_INFO.find((c) => c.kind === constraint.kind)?.label ?? constraint.kind;
  return id;
}

/** User-facing message for a rejected solve. */
export function describeProblem(result: SolveResult, attempted: SketchData): SketchProblem {
  const ids = [...new Set([...result.conflicting, ...result.redundant])];
  if (result.status === 'overconstrained') {
    const counts = new Map<string, number>();
    for (const id of ids) {
      const name = labelOf(attempted, id);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const names = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
    const list = names.length > 0 ? `: ${names.join(', ')}` : '';
    return {
      message:
        result.conflicting.length > 0
          ? `Over-constrained — these constraints conflict${list}. The last valid sketch is kept.`
          : `Over-constrained — already determined by other constraints${list}. The last valid sketch is kept.`,
      ids,
    };
  }
  return {
    message: `${result.message ?? 'The sketch could not be solved'}. The last valid sketch is kept.`,
    ids,
  };
}

// ---- store ------------------------------------------------------------------------------

export const useSketchStore = create<SketchState>((set, get) => {
  /** Serial queue of edits. */
  let queue: Promise<void> = Promise.resolve();
  /** Bumped per session; async results of an older session are dropped. */
  let token = 0;
  let dragState: {
    pointIds: string[];
    targets: Vec2[] | null;
    inFlight: Promise<void> | null;
  } | null = null;

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task, task);
    return queue;
  };

  const patch = (fields: Partial<SketchSession>) => {
    const session = get().session;
    if (session) set({ session: { ...session, ...fields } });
  };

  const syncHistory = () => useAssemblerStore.getState().syncHistory();

  /**
   * Solves and adopts an edit (one session undo step). Inferred (optional)
   * constraints that make the sketch over-constrained are dropped and the
   * edit is retried; any other problem rejects the edit.
   */
  const commitEdit = async (edit: EditResult): Promise<boolean> => {
    const mine = token;
    let sketch = edit.sketch;
    let optional = [...edit.optional];
    patch({ solving: true });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await getSketchSolver().solve({ sketch, analyze: true });
        if (mine !== token) return false;
        const session = get().session;
        if (!session) return false;
        if (result.status === 'ok') {
          set({
            session: {
              ...session,
              sketch: result.sketch,
              past: [...session.past, session.sketch],
              future: [],
              dof: result.dof,
              determined: result.determined,
              problem: null,
              selection:
                edit.select ??
                session.selection.filter(
                  (id) =>
                    result.sketch.entities.some((e) => e.id === id) ||
                    result.sketch.constraints.some((c) => c.id === id) ||
                    result.sketch.dimensions.some((d) => d.id === id),
                ),
              planeLocked: session.planeLocked || result.sketch.entities.length > 0,
            },
          });
          syncHistory();
          return true;
        }
        if (result.status === 'overconstrained' && optional.length > 0) {
          const offenders = new Set([...result.conflicting, ...result.redundant]);
          const drop = optional.filter((id) => offenders.has(id));
          const removed = drop.length > 0 ? drop : optional;
          sketch = {
            ...sketch,
            constraints: sketch.constraints.filter((c) => !removed.includes(c.id)),
          };
          optional = optional.filter((id) => !removed.includes(id));
          continue;
        }
        patch({ problem: describeProblem(result, sketch) });
        return false;
      }
      return false;
    } catch (error) {
      if (mine === token) {
        patch({
          problem: {
            message: `The sketch solver is not available: ${error instanceof Error ? error.message : String(error)}`,
            ids: [],
          },
        });
      }
      return false;
    } finally {
      if (mine === token) patch({ solving: false });
    }
  };

  const applyEdit = (build: (sketch: SketchData) => EditResult | null): Promise<boolean> =>
    new Promise((resolve) => {
      void enqueue(async () => {
        const session = get().session;
        const edit = session ? build(session.sketch) : null;
        resolve(edit ? await commitEdit(edit) : false);
      });
    });

  const close = (mode: 'finish' | 'discard') => {
    const session = get().session;
    if (!session) return;
    token += 1;
    dragState = null;
    const main = useAssemblerStore.getState();
    main.setHistoryDelegate(null);
    set({
      session: null,
      camera: { mode: 'exit', frame: session.frame, nonce: (get().camera?.nonce ?? 0) + 1 },
    });
    if (mode === 'discard') return;
    const sketch = session.sketch;
    if (session.isNew) {
      if (sketch.entities.length === 0) return;
      const feature: SketchFeature = {
        id: session.featureId,
        name: nextFeatureName('Sketch', main.features),
        suppressed: false,
        kind: 'sketch',
        plane: session.plane,
        ...sketch,
      };
      main.addFeature(feature, [{ kind: 'sketchProfile', featureId: feature.id }]);
      return;
    }
    if (!sameSketch(sketch, session.baseline)) {
      main.editFeatureParams(session.featureId, { ...sketch });
    }
  };

  // A document replaced under an open session (File > Open, New) ends it without committing.
  useAssemblerStore.subscribe((state, previous) => {
    const session = get().session;
    if (!session || state.features === previous.features) return;
    if (!session.isNew && !state.features.some((f) => f.id === session.featureId)) close('discard');
  });

  return {
    session: null,
    camera: null,

    begin: (options = {}) => {
      if (get().session) close('finish');
      const main = useAssemblerStore.getState();
      let featureId: string;
      let plane: SketchPlaneRef;
      let sketch: SketchData = EMPTY_SKETCH;
      let isNew = true;
      let planeLocked = true;
      let frame: SketchFrame | null = null;
      if (options.featureId) {
        const feature = main.features.find((f) => f.id === options.featureId);
        if (feature?.kind !== 'sketch') return false;
        featureId = feature.id;
        plane = feature.plane;
        sketch = sketchDataOf(feature);
        isNew = false;
        frame =
          main.evaluation.sketches.find((s) => s.featureId === featureId)?.frame ?? frameOf(plane);
      } else if (options.face) {
        const ref = makeFaceRef(main.evaluation, options.face.bodyId, options.face.faceKey);
        if (!ref || ref.signature.surface !== 'plane' || !ref.signature.normal) return false;
        featureId = main.allocateFeatureId('sketch');
        plane = { kind: 'face', face: ref };
        frame = frameOf(plane);
      } else {
        featureId = main.allocateFeatureId('sketch');
        plane = { kind: 'plane', plane: options.plane ?? 'XY', offset: 0 };
        planeLocked = options.plane !== undefined;
        frame = frameOf(plane);
      }
      if (!frame) return false;
      main.cancel();
      main.clearSelection();
      token += 1;
      set({
        session: {
          featureId,
          isNew,
          plane,
          frame,
          planeLocked,
          sketch,
          baseline: sketch,
          past: [],
          future: [],
          tool: initialTool(options.tool ?? (isNew ? 'line' : 'select')),
          construction: false,
          selection: [],
          dof: 0,
          determined: null,
          problem: null,
          dragPreview: null,
          editDimensionId: null,
          solving: false,
        },
        camera: { mode: 'enter', frame, nonce: (get().camera?.nonce ?? 0) + 1 },
      });
      main.setHistoryDelegate({
        undo: () => get().undo(),
        redo: () => get().redo(),
        canUndo: () => (get().session?.past.length ?? 0) > 0,
        canRedo: () => (get().session?.future.length ?? 0) > 0,
      });
      // Initial analysis (degrees of freedom, fully constrained geometry) of an existing sketch.
      if (!isNew && sketch.entities.length > 0) {
        const mine = token;
        void enqueue(async () => {
          try {
            const result = await getSketchSolver().solve({ sketch, analyze: true });
            if (mine !== token) return;
            if (result.status === 'ok') patch({ dof: result.dof, determined: result.determined });
            else patch({ problem: describeProblem(result, sketch) });
          } catch {
            // Reported on the first edit.
          }
        });
      }
      return true;
    },

    finish: () =>
      new Promise<void>((resolve) => {
        void enqueue(async () => {
          if (dragState?.inFlight) await dragState.inFlight;
          close('finish');
          resolve();
        });
      }),

    discard: () => close('discard'),

    setTool: (kind) => {
      const session = get().session;
      if (!session) return;
      const previous = session.tool;
      let tool = initialTool(kind);
      // Keep the chosen rectangle mode / polygon sides when re-selecting the tool.
      if (tool.kind === 'rectangle' && previous.kind === 'rectangle')
        tool = { ...tool, mode: previous.mode };
      if (tool.kind === 'polygon' && previous.kind === 'polygon')
        tool = { ...tool, sides: previous.sides };
      // Pressing A while drawing lines continues with a tangent arc from the last point.
      if (
        tool.kind === 'arc' &&
        previous.kind === 'line' &&
        previous.lastPointId &&
        previous.lastLineId
      ) {
        const point = session.sketch.entities.find((e) => e.id === previous.lastPointId);
        if (point?.kind === 'point') {
          tool = {
            ...tool,
            start: { pos: [point.x, point.y], pointId: point.id },
            tangent: { lineId: previous.lastLineId, pointId: point.id },
          };
        }
      }
      patch({ tool, editDimensionId: null });
    },

    setToolOption: (option) => {
      const session = get().session;
      if (!session) return;
      const tool = session.tool;
      if (tool.kind === 'rectangle' && (option.mode === 'corner' || option.mode === 'center')) {
        patch({ tool: { ...tool, mode: option.mode, first: null } });
      } else if (tool.kind === 'polygon' && option.sides !== undefined) {
        patch({ tool: { ...tool, sides: Math.max(3, Math.min(64, Math.round(option.sides))) } });
      } else if (
        tool.kind === 'dimension' &&
        (option.mode === 'aligned' || option.mode === 'horizontal' || option.mode === 'vertical')
      ) {
        patch({ tool: { ...tool, mode: option.mode } });
      }
    },

    setConstruction: (on) => patch({ construction: on }),

    dispatch: (event) =>
      enqueue(async () => {
        const session = get().session;
        if (!session) return;
        const step = reduceTool(session.sketch, session.tool, event, {
          construction: session.construction,
        });
        if (!step.edit) {
          patch({ tool: step.tool });
          return;
        }
        const ok = await commitEdit(step.edit);
        if (ok) patch({ tool: step.tool, editDimensionId: step.editDimensionId ?? null });
      }),

    rebaseOnFace: (bodyId, faceKey) => {
      const session = get().session;
      if (!session || session.planeLocked || !session.isNew || session.sketch.entities.length > 0)
        return false;
      const ref = makeFaceRef(useAssemblerStore.getState().evaluation, bodyId, faceKey);
      if (!ref || ref.signature.surface !== 'plane' || !ref.signature.normal) return false;
      const plane: SketchPlaneRef = { kind: 'face', face: ref };
      const frame = frameOf(plane);
      if (!frame) return false;
      patch({ plane, frame, planeLocked: true });
      set({ camera: { mode: 'enter', frame, nonce: (get().camera?.nonce ?? 0) + 1 } });
      return true;
    },

    select: (ids, options) => {
      const session = get().session;
      if (!session) return;
      if (!options?.additive) {
        patch({ selection: ids });
        return;
      }
      const next = [...session.selection];
      for (const id of ids) {
        const index = next.indexOf(id);
        if (index >= 0) next.splice(index, 1);
        else next.push(id);
      }
      patch({ selection: next });
    },

    clearSelection: () => patch({ selection: [] }),

    deleteSelection: async () => {
      const selection = get().session?.selection ?? [];
      if (selection.length === 0) return;
      await applyEdit((sketch) => ({
        sketch: deleteItems(sketch, selection),
        optional: [],
        select: [],
      }));
    },

    toggleConstructionOfSelection: async () => {
      const session = get().session;
      if (!session) return;
      const curves = session.selection.filter((id) =>
        session.sketch.entities.some((e) => e.id === id && e.kind !== 'point'),
      );
      if (curves.length === 0) {
        patch({ construction: !session.construction });
        return;
      }
      await applyEdit((sketch) => ({ sketch: toggleConstruction(sketch, curves), optional: [] }));
    },

    applyConstraint: async (kind) => {
      const session = get().session;
      if (!session) return 'No sketch is being edited.';
      const plan = planConstraint(session.sketch, kind, session.selection);
      if (!plan.ok) return plan.reason;
      await applyEdit((sketch) => {
        const alloc = idAllocator(sketch);
        const added = plan.constraints.map((c) => ({ ...c, id: alloc('k') }));
        return {
          sketch: { ...sketch, constraints: [...sketch.constraints, ...added] },
          // Locking already determined points is dropped instead of rejected.
          optional: kind === 'fixed' ? added.map((c) => c.id) : [],
        };
      });
      return null;
    },

    setDimension: (dimensionId, text) => {
      const trimmed = text.trim();
      return applyEdit((sketch) => {
        const dimension = sketch.dimensions.find((d) => d.id === dimensionId);
        if (!dimension || trimmed === '') return null;
        const plain = isPlainNumber(trimmed);
        const value = plain
          ? Number(trimmed.replace(',', '.').replace(/\s*(mm|°|deg)\s*$/i, ''))
          : dimension.value;
        const { expression: _old, ...rest } = dimension;
        const next = plain ? { ...rest, value } : { ...rest, expression: trimmed };
        return {
          sketch: {
            ...sketch,
            dimensions: sketch.dimensions.map((d) => (d.id === dimensionId ? next : d)),
          },
          optional: [],
        };
      });
    },

    closeDimensionEditor: () => patch({ editDimensionId: null }),

    undo: () => {
      void enqueue(async () => {
        const session = get().session;
        if (!session || session.past.length === 0) return;
        const previous = session.past[session.past.length - 1]!;
        set({
          session: {
            ...session,
            sketch: previous,
            past: session.past.slice(0, -1),
            future: [...session.future, session.sketch],
            tool: initialTool(session.tool.kind),
            selection: [],
            problem: null,
          },
        });
        syncHistory();
        await refreshAnalysis();
      });
    },

    redo: () => {
      void enqueue(async () => {
        const session = get().session;
        if (!session || session.future.length === 0) return;
        const next = session.future[session.future.length - 1]!;
        set({
          session: {
            ...session,
            sketch: next,
            past: [...session.past, session.sketch],
            future: session.future.slice(0, -1),
            tool: initialTool(session.tool.kind),
            selection: [],
            problem: null,
          },
        });
        syncHistory();
        await refreshAnalysis();
      });
    },

    beginDrag: (pointIds) => {
      if (!get().session || pointIds.length === 0) return;
      dragState = { pointIds, targets: null, inFlight: null };
    },

    drag: (targets) => {
      if (!dragState) return;
      dragState.targets = targets;
      if (!dragState.inFlight) dragState.inFlight = runDrag();
    },

    endDrag: async () => {
      const state = dragState;
      if (!state) return;
      if (state.inFlight) await state.inFlight;
      dragState = null;
      const preview = get().session?.dragPreview ?? null;
      patch({ dragPreview: null });
      if (!preview) return;
      await applyEdit(() => ({ sketch: preview, optional: [] }));
    },

    dismissProblem: () => patch({ problem: null }),

    escape: () => {
      const session = get().session;
      if (!session) return false;
      if (session.editDimensionId) {
        patch({ editDimensionId: null });
        return true;
      }
      if (session.tool.kind !== 'select' || toolInProgress(session.tool)) {
        patch({ tool: initialTool('select') });
        return true;
      }
      if (session.problem) {
        patch({ problem: null });
        return true;
      }
      if (session.selection.length > 0) {
        patch({ selection: [] });
        return true;
      }
      void get().finish();
      return true;
    },

    whenIdle: async () => {
      await queue;
      if (dragState?.inFlight) await dragState.inFlight;
      await queue;
    },
  };

  async function refreshAnalysis(): Promise<void> {
    const mine = token;
    const session = get().session;
    if (!session) return;
    try {
      const result = await getSketchSolver().solve({ sketch: session.sketch, analyze: true });
      if (mine === token && result.status === 'ok')
        patch({ dof: result.dof, determined: result.determined });
    } catch {
      // Analysis is informative only.
    }
  }

  /** One drag solve with the newest targets; repeats while newer targets arrived meanwhile. */
  async function runDrag(): Promise<void> {
    const mine = token;
    for (;;) {
      const state = dragState;
      const session = get().session;
      if (!state || !session || mine !== token || !state.targets) break;
      const targets = state.targets;
      state.targets = null;
      try {
        const result = await getSketchSolver().solve({
          sketch: session.sketch,
          drag: state.pointIds.map((pointId, i) => ({ pointId, target: targets[i]! })),
        });
        if (mine !== token) break;
        if (result.status === 'ok') patch({ dragPreview: result.sketch });
      } catch {
        break;
      }
      if (!dragState?.targets) break;
    }
    if (dragState) dragState.inFlight = null;
  }
});

/** `true` while a sketch session is open. */
export function isSketching(): boolean {
  return useSketchStore.getState().session !== null;
}
