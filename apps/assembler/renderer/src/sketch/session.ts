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
  type SketchFrame,
  type SketchPlaneRef,
} from '../foundation/document/document.js';
import type { SketchFeature } from '../foundation/sketch-solver/sketchFeature.js';
import {
  makeEdgeRef,
  makeFaceRef,
  nextFeatureName,
  useAssemblerStore,
} from '../foundation/commands/store.js';
import { initialAdvancedTool } from './advancedTools.js';
import { constraintInfo, planConstraint } from './constraintRules.js';
import {
  deleteItems,
  SketchBuilder,
  toggleConstruction,
  type EditResult,
} from '../foundation/sketch-solver/edits.js';
import { isPlainNumber } from '../foundation/document/expressions.js';
import {
  addProjection,
  adoptProjectedEntities,
  edgeSampleFromSegments,
  projectSource,
  type EdgeSample,
} from '../foundation/sketch-solver/projection.js';
import { pointIdsOf } from '../foundation/sketch-solver/moveRegion.js';
import { rememberRegions } from '../foundation/sketch-solver/regionMemory.js';
import { usePreferences } from '../interface/shell-ui/preferences.js';
import { getSketchSolver } from '../foundation/sketch-solver/solverProvider.js';
import type { SolveResult } from '../foundation/sketch-solver/solverTypes.js';
import {
  DEFAULT_SKETCH_FONT,
  loadSketchFont,
  textOutline,
} from '../foundation/sketch-solver/text/fonts.js';
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
  ORIGIN_ID,
  idAllocator,
  sketchDataOf,
  type SketchConstraintKind,
  type SketchData,
  type SketchDimension,
  type SketchProjection,
  type Vec2,
} from '../foundation/sketch-solver/types.js';

export interface SketchProblem {
  message: string;
  /** Constraint/dimension ids to highlight. */
  ids: string[];
  /**
   * A way out the banner offers: a dimension that is already determined can
   * be added as a reference (driven) dimension instead.
   */
  offer?: { kind: 'reference'; label: string; dimensionIds: string[] };
}

/** A body edge or face picked for Project. */
export interface ProjectionPick {
  kind: 'edge' | 'face';
  bodyId: string;
  key: string;
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
  /**
   * Remaining degrees of freedom; `null` until the solver's constraint
   * analysis of the sketch has reported (it runs asynchronously on entry).
   */
  dof: number | null;
  /** Ids of fully determined points/curves (`null` = unknown). */
  determined: string[] | null;
  problem: SketchProblem | null;
  /** Live drag result shown instead of `sketch` while dragging. */
  dragPreview: SketchData | null;
  /** Dimension whose value chip should open (new dimension). */
  editDimensionId: string | null;
  /** `true` while an edit is being solved. */
  solving: boolean;
  /** Why the last tool input did nothing (cleared by the next input or tool change). */
  notice: string | null;
}

/** Tool options set from the palette / text panel. */
export interface SketchToolOptions {
  mode: string;
  sides: number;
  inscribed: boolean;
  count: number;
  angle: number;
  text: string;
  height: number;
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
  /** New sketch on a construction plane step (`constructionPlane`) by feature id. */
  datum?: string;
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
  /**
   * Tool options: rectangle/spline/slot/ellipse/pattern/corner/dimension
   * mode, polygon sides and inscribed/circumscribed, pattern count/angle,
   * text content/height/rotation.
   */
  setToolOption: (patch: Partial<SketchToolOptions>) => void;
  /** Places the text being edited by the Text tool (one undo step). Resolves `true` when added. */
  commitText: () => Promise<boolean>;
  /** Opens the Text tool on an existing text entity. */
  editText: (textId: string) => void;
  /** Projects a body edge/face into the sketch (Project tool). Resolves a reason when not possible. */
  projectItem: (pick: ProjectionPick) => Promise<string | null>;
  /** Applies the offer of the current problem (add the rejected dimension as a reference). */
  acceptOffer: () => Promise<boolean>;
  /** Toggles a dimension between driving and reference (driven). */
  toggleReference: (dimensionId: string) => Promise<boolean>;
  /** Moves a dimension label (layout only; one undo step). */
  moveDimensionLabel: (
    dimensionId: string,
    layout: { offset?: number; along?: number },
  ) => Promise<boolean>;
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
  if (plane.kind === 'construction') return plane.frame;
  const normal = plane.face.signature.normal;
  return normal ? frameForFace(normal, plane.face.signature.centroid) : null;
}

function sameSketch(a: SketchData, b: SketchData): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function labelOf(sketch: SketchData, id: string): string {
  const dimension = sketch.dimensions.find((d) => d.id === id);
  if (dimension) return dimension.name;
  const constraint = sketch.constraints.find((c) => c.id === id);
  if (constraint) return constraintInfo(constraint.kind).label;
  if (sketch.projections?.some((p) => p.id === id)) return 'Projected geometry';
  return id;
}

/** New driving dimensions of `next` (not in `previous`). */
function addedDimensions(previous: SketchData, next: SketchData): SketchDimension[] {
  const known = new Set(previous.dimensions.map((d) => d.id));
  return next.dimensions.filter((d) => !known.has(d.id) && !d.driven);
}

/** `sketch` with the given dimensions turned into reference (driven) dimensions. */
function asReference(sketch: SketchData, ids: readonly string[]): SketchData {
  return {
    ...sketch,
    dimensions: sketch.dimensions.map((d) => {
      if (!ids.includes(d.id)) return d;
      const { expression: _expression, ...rest } = d;
      return { ...rest, driven: true };
    }),
  };
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

/** Keeps the options of the previous tool of the same kind (modes, sides, counts). */
function carryOptions(tool: SketchTool, previous: SketchTool): SketchTool {
  if (tool.kind !== previous.kind) return tool;
  switch (tool.kind) {
    case 'rectangle':
    case 'spline':
    case 'slot':
    case 'ellipse':
    case 'corner':
      return { ...tool, mode: (previous as typeof tool).mode } as SketchTool;
    case 'polygon': {
      const p = previous as typeof tool;
      return { ...tool, sides: p.sides, inscribed: p.inscribed };
    }
    case 'pattern': {
      const p = previous as typeof tool;
      return { ...tool, mode: p.mode, count: p.count, angle: p.angle };
    }
    default:
      return tool;
  }
}

/** A tool with one option changed (unchanged object when the option does not apply). */
function applyToolOption(tool: SketchTool, option: Partial<SketchToolOptions>): SketchTool {
  const mode = option.mode;
  switch (tool.kind) {
    case 'rectangle':
      return mode === 'corner' || mode === 'center' || mode === 'threePoint'
        ? { ...tool, mode, first: null, second: null }
        : tool;
    case 'arc':
      return mode === 'endsBulge' || mode === 'threePoint'
        ? { ...tool, mode, start: null, end: null, through: null, tangent: null }
        : tool;
    case 'polygon': {
      let next = tool;
      if (option.sides !== undefined) {
        next = { ...next, sides: Math.max(3, Math.min(64, Math.round(option.sides))) };
      }
      if (option.inscribed !== undefined) next = { ...next, inscribed: option.inscribed };
      return next;
    }
    case 'dimension':
      return mode === 'aligned' || mode === 'horizontal' || mode === 'vertical'
        ? { ...tool, mode }
        : tool;
    case 'spline':
      return mode === 'fit' || mode === 'control' ? { ...tool, mode, points: [] } : tool;
    case 'slot':
      return mode === 'straight' || mode === 'arc'
        ? { ...tool, mode, first: null, second: null, third: null, length: null, width: null }
        : tool;
    case 'ellipse':
      return mode === 'full' || mode === 'arc'
        ? { ...tool, mode, center: null, major: null, minor: null, start: null }
        : tool;
    case 'corner':
      return mode === 'fillet' || mode === 'chamfer' ? { ...tool, mode } : tool;
    case 'pattern': {
      let next = tool;
      if (mode === 'linear' || mode === 'circular') next = { ...next, mode };
      if (option.count !== undefined && option.count >= 2 && option.count <= 200) {
        next = { ...next, count: Math.round(option.count) };
      }
      if (
        option.angle !== undefined &&
        Math.abs(option.angle) > 0 &&
        Math.abs(option.angle) <= 360
      ) {
        next = { ...next, angle: option.angle };
      }
      return next;
    }
    case 'text': {
      let next = tool;
      if (option.text !== undefined) next = { ...next, text: option.text };
      if (option.height !== undefined && option.height > 0)
        next = { ...next, height: option.height };
      if (option.angle !== undefined && Number.isFinite(option.angle))
        next = { ...next, angle: option.angle };
      return next;
    }
    default:
      return tool;
  }
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
  /** The edit behind the current problem's offer (e.g. the dimension as a reference). */
  let pendingOffer: { edit: EditResult; token: number } | null = null;

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
          pendingOffer = null;
          // Steering constraints (the item kept in place) leave the sketch after the solve.
          const transient = new Set(edit.transient ?? []);
          const solved =
            transient.size > 0
              ? {
                  ...result.sketch,
                  constraints: result.sketch.constraints.filter((c) => !transient.has(c.id)),
                }
              : result.sketch;
          set({
            session: {
              ...session,
              notice: null,
              sketch: solved,
              past: [...session.past, session.sketch],
              future: [],
              dof: result.dof,
              determined: result.determined,
              problem: null,
              selection:
                edit.select ??
                session.selection.filter(
                  (id) =>
                    solved.entities.some((e) => e.id === id) ||
                    solved.constraints.some((c) => c.id === id) ||
                    solved.dimensions.some((d) => d.id === id),
                ),
              planeLocked: session.planeLocked || solved.entities.length > 0,
            },
          });
          syncHistory();
          // The degrees of freedom above counted the steering constraints: analyse again.
          if (transient.size > 0) await refreshAnalysis();
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
        // A new dimension that is merely determined already: offer it as a reference dimension.
        const redundantNew = addedDimensions(session.sketch, sketch).filter((d) =>
          result.redundant.includes(d.id),
        );
        if (
          result.status === 'overconstrained' &&
          result.conflicting.length === 0 &&
          redundantNew.length > 0
        ) {
          const ids = redundantNew.map((d) => d.id);
          pendingOffer = { edit: { ...edit, sketch: asReference(sketch, ids), optional }, token };
          const names = redundantNew.map((d) => d.name).join(', ');
          patch({
            problem: {
              ...describeProblem(result, sketch),
              message: `Over-constrained — already determined by other constraints: ${names}. Add it as a reference dimension instead?`,
              offer: { kind: 'reference', label: 'Add as reference', dimensionIds: ids },
            },
          });
          return false;
        }
        pendingOffer = null;
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
    if (session.isNew && session.sketch.entities.length === 0) return;
    const changed = session.isNew || !sameSketch(session.sketch, session.baseline);
    // Fingerprint the regions so references to redrawn profiles re-bind by geometry.
    const sketch = changed ? rememberRegions(session.sketch, session.baseline) : session.sketch;
    if (session.isNew) {
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
    if (changed) {
      main.editFeatureParams(session.featureId, {
        ...sketch,
        // A sketch whose last projection was deleted must drop the stored list too.
        ...(session.baseline.projections && !sketch.projections ? { projections: [] } : {}),
      });
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
      let projectedUpdate: SketchData | null = null;
      if (options.featureId) {
        const feature = main.features.find((f) => f.id === options.featureId);
        if (feature?.kind !== 'sketch') return false;
        featureId = feature.id;
        plane = feature.plane;
        sketch = sketchDataOf(feature);
        isNew = false;
        const evaluated = main.evaluation.sketches.find((s) => s.featureId === featureId);
        frame = evaluated?.frame ?? frameOf(plane);
        // Projected geometry whose source moved: adopt it and re-solve (one session step).
        if (evaluated?.projectedEntities) {
          const adopted = adoptProjectedEntities(sketch, evaluated.projectedEntities);
          if (adopted !== sketch) projectedUpdate = adopted;
        }
      } else if (options.face) {
        const ref = makeFaceRef(main.evaluation, options.face.bodyId, options.face.faceKey);
        if (!ref || ref.signature.surface !== 'plane' || !ref.signature.normal) return false;
        featureId = main.allocateFeatureId('sketch');
        plane = { kind: 'face', face: ref };
        frame = frameOf(plane);
      } else if (options.datum) {
        const datum = main.evaluation.datums?.find((d) => d.featureId === options.datum);
        if (datum?.kind !== 'plane') return false;
        featureId = main.allocateFeatureId('sketch');
        plane = {
          kind: 'construction',
          featureId: datum.featureId,
          frame: datum.frame,
          shown: { center: datum.center, size: datum.size },
        };
        frame = datum.frame;
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
          // Unknown until the analysis below (or the projected-geometry update) reports.
          dof: sketch.entities.length === 0 ? 0 : null,
          determined: null,
          problem: null,
          dragPreview: null,
          editDimensionId: null,
          solving: false,
          notice: null,
        },
        camera: { mode: 'enter', frame, nonce: (get().camera?.nonce ?? 0) + 1 },
      });
      pendingOffer = null;
      main.setHistoryDelegate({
        undo: () => get().undo(),
        redo: () => get().redo(),
        canUndo: () => (get().session?.past.length ?? 0) > 0,
        canRedo: () => (get().session?.future.length ?? 0) > 0,
      });
      if (projectedUpdate) {
        const update = projectedUpdate;
        void enqueue(async () => {
          const ok = await commitEdit({ sketch: update, optional: [] });
          if (!ok) {
            patch({
              notice:
                'Projected geometry moved with its source, but the sketch could not follow it; fix the constraints shown.',
            });
          }
        });
      } else if (sketch.entities.length > 0) {
        // Initial analysis (degrees of freedom, fully constrained geometry) of an existing sketch.
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
      let tool = initialTool(kind, session.selection);
      // Keep the chosen options (modes, sides, counts) when re-selecting the tool.
      tool = carryOptions(tool, previous);
      if (tool.kind === 'text') {
        void loadSketchFont(DEFAULT_SKETCH_FONT).catch(() => undefined);
        const selected = session.sketch.entities.find(
          (e) =>
            e.kind === 'text' && session.selection.length === 1 && session.selection[0] === e.id,
        );
        if (selected?.kind === 'text') {
          tool = {
            ...tool,
            editing: selected.id,
            text: selected.text,
            height: selected.height,
            angle: selected.angle,
          };
        }
      }
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
      patch({ tool, editDimensionId: null, notice: null });
    },

    setToolOption: (option) => {
      const session = get().session;
      if (!session) return;
      const next = applyToolOption(session.tool, option);
      if (next !== session.tool) patch({ tool: next, notice: null });
    },

    commitText: async () => {
      const session = get().session;
      const tool = session?.tool;
      if (!session || tool?.kind !== 'text') return false;
      const content = tool.text.replace(/[\r\n\t]+/g, ' ');
      if (content.trim() === '') {
        patch({ notice: 'Type some text first.' });
        return false;
      }
      if (!(tool.height >= 0.1)) {
        patch({ notice: 'The text height must be at least 0.1 mm.' });
        return false;
      }
      if (!tool.editing && !tool.anchor) {
        patch({ notice: 'Click where the text starts first.' });
        return false;
      }
      let outline: Awaited<ReturnType<typeof textOutline>>;
      try {
        outline = await textOutline(DEFAULT_SKETCH_FONT, content);
      } catch (error) {
        patch({
          notice: `The font could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        });
        return false;
      }
      const ok = await applyEdit((sketch) => {
        if (tool.editing) {
          const existing = sketch.entities.find((e) => e.id === tool.editing);
          if (existing?.kind !== 'text') return null;
          return {
            sketch: {
              ...sketch,
              entities: sketch.entities.map((e) =>
                e.id === tool.editing
                  ? {
                      ...existing,
                      text: content,
                      height: tool.height,
                      angle: tool.angle,
                      font: DEFAULT_SKETCH_FONT,
                      outline: outline.outline,
                    }
                  : e,
              ),
            },
            optional: [],
            select: [existing.id],
          };
        }
        const b = new SketchBuilder(sketch);
        const anchor = b.pointFor(tool.anchor!);
        const id = b.id('t');
        b.entities.push({
          id,
          kind: 'text',
          anchor,
          text: content,
          height: tool.height,
          angle: tool.angle,
          font: DEFAULT_SKETCH_FONT,
          outline: outline.outline,
          ...(get().session?.construction ? { construction: true } : {}),
        });
        return b.result([id]);
      });
      if (ok) {
        patch({
          tool: {
            ...initialAdvancedTool('text'),
            height: tool.height,
            angle: tool.angle,
          } as SketchTool,
          notice:
            outline.missing.length > 0
              ? `Not in the font: ${outline.missing.join(' ')} (drawn as boxes).`
              : null,
        });
      }
      return ok;
    },

    editText: (textId) => {
      const session = get().session;
      const text = session?.sketch.entities.find((e) => e.id === textId);
      if (!session || text?.kind !== 'text') return;
      void loadSketchFont(DEFAULT_SKETCH_FONT).catch(() => undefined);
      patch({
        tool: {
          ...initialAdvancedTool('text'),
          editing: text.id,
          text: text.text,
          height: text.height,
          angle: text.angle,
        } as SketchTool,
        selection: [text.id],
        notice: null,
      });
    },

    projectItem: async (pick) => {
      const session = get().session;
      if (!session) return 'No sketch is being edited.';
      const main = useAssemblerStore.getState();
      const body = main.evaluation.bodies.find((b) => b.id === pick.bodyId);
      if (!body) return 'That body is not available.';
      const samples: EdgeSample[] = [];
      let source: SketchProjection['source'] | null = null;
      if (pick.kind === 'edge') {
        const edge = body.edges.find((e) => e.key === pick.key);
        const ref = makeEdgeRef(main.evaluation, pick.bodyId, pick.key);
        if (!edge || !ref) return 'That edge is not available.';
        samples.push(edgeSampleFromSegments(edge.curve, edge.segments));
        source = { kind: 'edge', ref };
      } else {
        const face = body.faces.find((f) => f.key === pick.key || f.aliases.includes(pick.key));
        const ref = makeFaceRef(main.evaluation, pick.bodyId, pick.key);
        if (!face || !ref) return 'That face is not available.';
        for (const index of face.edgeIndices) {
          const edge = body.edges[index];
          if (edge) samples.push(edgeSampleFromSegments(edge.curve, edge.segments));
        }
        source = { kind: 'face', ref };
      }
      const curves = projectSource(samples, session.frame);
      if (curves.length === 0)
        return 'It projects to a point (it is parallel to the sketch normal).';
      const already = (session.sketch.projections ?? []).some(
        (p) =>
          p.source.kind === source!.kind &&
          p.source.ref.key === source!.ref.key &&
          p.source.ref.bodyId === source!.ref.bodyId,
      );
      if (already) return 'That geometry is already projected into this sketch.';
      const ok = await applyEdit((sketch) => addProjection(sketch, source!, curves, true));
      return ok ? null : 'The projection could not be added.';
    },

    acceptOffer: async () => {
      const offer = pendingOffer;
      if (!offer || offer.token !== token) return false;
      pendingOffer = null;
      patch({ problem: null });
      return applyEdit(() => offer.edit);
    },

    toggleReference: (dimensionId) =>
      applyEdit((sketch) => {
        const dimension = sketch.dimensions.find((d) => d.id === dimensionId);
        if (!dimension) return null;
        if (!dimension.driven) {
          return {
            sketch: asReference(sketch, [dimensionId]),
            optional: [],
            select: [dimensionId],
          };
        }
        const { driven: _driven, ...rest } = dimension;
        return {
          sketch: {
            ...sketch,
            dimensions: sketch.dimensions.map((d) => (d.id === dimensionId ? rest : d)),
          },
          optional: [],
          select: [dimensionId],
        };
      }),

    moveDimensionLabel: (dimensionId, layout) =>
      applyEdit((sketch) => {
        const dimension = sketch.dimensions.find((d) => d.id === dimensionId);
        if (!dimension) return null;
        const next = {
          ...dimension,
          ...(layout.offset !== undefined && Number.isFinite(layout.offset)
            ? { offset: layout.offset }
            : {}),
          ...(layout.along !== undefined && Number.isFinite(layout.along)
            ? { along: Math.min(1.5, Math.max(-0.5, layout.along)) }
            : {}),
        };
        return {
          sketch: {
            ...sketch,
            dimensions: sketch.dimensions.map((d) => (d.id === dimensionId ? next : d)),
          },
          optional: [],
        };
      }),

    setConstruction: (on) => patch({ construction: on }),

    dispatch: (event) =>
      enqueue(async () => {
        const session = get().session;
        if (!session) return;
        const step = reduceTool(session.sketch, session.tool, event, {
          construction: session.construction,
        });
        if (!step.edit) {
          patch({ tool: step.tool, notice: step.notice ?? null });
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
      // Shapr3D Constraint Settings "First/Last Selected": that item stays where it is while the
      // solver satisfies the new constraint (existing constraints win: the pin is optional).
      const keep = usePreferences.getState().constraintKeep;
      const picked = session.selection.filter((id) =>
        session.sketch.entities.some((e) => e.id === id),
      );
      const anchorId =
        kind !== 'fixed' && picked.length >= 2
          ? keep === 'last'
            ? picked[picked.length - 1]
            : picked[0]
          : undefined;
      await applyEdit((sketch) => {
        const alloc = idAllocator(sketch);
        const added = plan.constraints.map((c) => ({ ...c, id: alloc('k') }));
        const anchor = anchorId ? sketch.entities.find((e) => e.id === anchorId) : undefined;
        const pins = (anchor ? pointIdsOf(anchor) : [])
          .filter((id) => id !== ORIGIN_ID)
          .map((id) => ({ id: alloc('k'), kind: 'fixed' as const, refs: [id] }));
        return {
          sketch: { ...sketch, constraints: [...sketch.constraints, ...added, ...pins] },
          // Locking already determined points is dropped instead of rejected.
          optional: [...(kind === 'fixed' ? added.map((c) => c.id) : []), ...pins.map((p) => p.id)],
          transient: pins.map((p) => p.id),
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
