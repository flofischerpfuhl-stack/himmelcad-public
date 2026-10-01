/**
 * The modelling module's tool sessions and their store slice
 * (assembler/MODULES.md §3 store slices, `registerToolKind`):
 *
 * - `E` Extrude (sketch profile or push/pull of a planar face),
 * - `F` Fillet/Chamfer on edges (picked or by rule),
 * - `H` Shell, Union/Subtract/Intersect,
 * - `M` the Move/Rotate gizmo (bodies and sketch profiles),
 *
 * plus the one-step Fillet/Chamfer, Shell and Boolean actions. The store
 * core runs the lifecycle every tool shares (`collectingReferences ->
 * preview -> numericEditing -> committing`, live kernel preview, Done
 * checked by the kernel for boolean results, Cancel); this file says what
 * each of these tools previews and commits. The generic feature tool
 * (Revolve, Hole, Offset Face, …) is the core's `feature` session with the
 * modules' drafts (`foundation/commands/featureDrafts.ts`).
 */
import {
  edgeRuleBodyId,
  type ChamferMode,
  type EdgeRule,
  type ShellDirection,
} from '../../foundation/document/blendOptions.js';
import {
  frameForPlane,
  MIN_FEATURE_SIZE_MM,
  type BooleanFeature,
  type ChamferFeature,
  type EdgeRef,
  type ExtrudeFeature,
  type ExtrudeObjectRef,
  type ExtrudeOperation,
  type ExtrudeProfileRef,
  type FaceRef,
  type Feature,
  type FilletFeature,
  type MoveFeature,
  type ShellFeature,
  type SketchFrame,
  type Vec3,
} from '../../foundation/document/document.js';
import { featureKindLabel } from '../../foundation/document/featureKinds.js';
import type { EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import type { SketchFeature } from '../../foundation/sketch-solver/sketchFeature.js';
import { regionCentre, translateSketchRegion } from '../../foundation/sketch-solver/moveRegion.js';
import {
  createFeatureId,
  makeEdgeRef,
  makeFaceRef,
  nextFeatureName,
  PREVIEW_FEATURE_ID,
  registerToolKind,
  type AssemblerState,
  type KernelPreviewFields,
  type SelectionItem,
  type StoreSliceCreator,
  type ToolCommit,
  type ToolSessionBase,
} from '../../foundation/commands/store.js';
import type { TransformFeature } from './features.js';
import {
  autoExtrudeOperation,
  extrudeStartDepth,
  findSketchContact,
  type SketchContact,
} from './modeling.js';
import { gizmoTransformFields } from './moveGizmo.js';

// ---- sessions -------------------------------------------------------------------------------

/** `E` — extrudes a sketch profile or pushes/pulls a planar body face. */
export interface ExtrudeTool extends ToolSessionBase, KernelPreviewFields {
  kind: 'extrude';
  profile: ExtrudeProfileRef;
  distance: number;
  operation: ExtrudeOperation;
  targetBodyId?: string;
  /** `true` once the user picked the operation explicitly (disables the automatic choice). */
  operationLocked: boolean;
  /** Body face the sketch lies on (drives the automatic New/Join/Cut choice), else `null`. */
  contact: SketchContact | null;
  /** Extent (Shapr3D "Distance / To Object / Through All"); absent = distance. */
  extent?: 'distance' | 'throughAll' | 'toObject';
  /** The object a "To Object" extrude runs up to (picked while the tool runs). */
  extentTarget?: ExtrudeObjectRef;
  /** One side (default), symmetric, or two sides with `distance2` on the other side. */
  sides?: 'one' | 'symmetric' | 'two';
  distance2?: number;
  /** Start offset from the profile along its normal, mm. */
  startOffset?: number;
  /** Taper (draft) angle of the walls, degrees; positive narrows away from the start. */
  taper?: number;
}

/** The extrude options a tool/History card can change (`setExtrudeOptions`); `undefined` clears one. */
export type ExtrudeToolOptions = {
  [K in 'extent' | 'extentTarget' | 'sides' | 'distance2' | 'startOffset' | 'taper']?:
    | ExtrudeTool[K]
    | undefined;
};

/** `F` — fillets or chamfers the selected edges of one body. */
export interface EdgeBlendTool extends ToolSessionBase, KernelPreviewFields {
  kind: 'edgeBlend';
  blend: 'fillet' | 'chamfer';
  bodyId: string;
  edges: EdgeRef[];
  /** Fillet radius or chamfer distance, mm. */
  size: number;
  /** Variants (`document/blendOptions.ts`): end radius of a variable fillet, chamfer mode and its second value. */
  radius2?: number;
  chamferMode?: ChamferMode;
  distance2?: number;
  angle?: number;
  flip?: boolean;
  /** Edges chosen by rule (all edges of a face, all concave/convex edges). */
  rules?: EdgeRule[];
}

/** `H` — hollows a body, opening the selected faces, walls grow inwards (or outwards). */
export interface ShellTool extends ToolSessionBase, KernelPreviewFields {
  kind: 'shell';
  bodyId: string;
  faces: FaceRef[];
  thickness: number;
  direction?: ShellDirection;
  /** Outward only: gap between the body and the shell's cavity, mm. */
  clearance?: number;
}

/** Union/Subtract/Intersect of the selected bodies; the first selected body is the target. */
export interface BooleanTool extends ToolSessionBase, KernelPreviewFields {
  kind: 'boolean';
  operation: BooleanFeature['operation'];
  targetBodyId: string;
  toolBodyIds: string[];
  /** Keep the tool bodies instead of consuming them. */
  keepTools?: boolean;
  /** Keep the target as it was; the result becomes a new body. */
  keepTarget?: boolean;
}

/**
 * `M` — the Move/Rotate gizmo on a single body: translate along the axis
 * arrows, rotate with the rings (degrees about world X, then Y, then Z,
 * through `pivot`), optionally as a copy. Commits a `move` feature for a
 * plain translation, else a `transform` feature.
 */
export interface MoveTool extends ToolSessionBase {
  kind: 'move';
  /** The moved body (`''` while a sketch profile is moved). */
  bodyId: string;
  delta: { dx: number; dy: number; dz: number };
  /**
   * Degrees about the gizmo axes (`axes`, default world X, Y, Z), applied
   * in that order through `pivot` — for world axes exactly the `transform`
   * feature's rx/ry/rz.
   */
  rotation: { rx: number; ry: number; rz: number };
  /** Rotation centre (world, before the translation). Defaults to the body's box centre. */
  pivot: Vec3;
  /** Creates a copy instead of moving the body. */
  copy: boolean;
  /**
   * Gizmo orientation (unit axes; absent = world X, Y, Z). Set when the
   * centre snaps to geometry with auto-orientation on (Shapr3D, int §4).
   */
  axes?: [Vec3, Vec3, Vec3];
  /** Orient the gizmo to the geometry its centre is dropped on. */
  autoOrient?: boolean;
  /**
   * Moving a sketch profile (Shapr3D Move/Rotate on sketch regions): the
   * profile's curves translate in the sketch plane (`sketch-solver/moveRegion.ts`).
   */
  sketch?: { featureId: string; regionKey?: string; frame: SketchFrame };
  /** Why Done cannot apply the move (shown in the pill), else absent. */
  problem?: string;
}

declare module '../../foundation/commands/store.js' {
  interface ToolSessionMap {
    extrude: ExtrudeTool;
    edgeBlend: EdgeBlendTool;
    shell: ShellTool;
    boolean: BooleanTool;
    move: MoveTool;
  }
}

/** Reserved feature id used only for the extrude tool's live preview; never committed. */
export const PREVIEW_EXTRUDE_FEATURE_ID = '__preview_extrude__';

/** Default fillet radius / chamfer distance and shell thickness when a tool starts, mm. */
export const DEFAULT_BLEND_SIZE_MM = 1;
export const DEFAULT_SHELL_THICKNESS_MM = 1;

const BOOLEAN_LABEL: Record<BooleanFeature['operation'], string> = {
  union: 'Union',
  subtract: 'Subtract',
  intersect: 'Intersect',
};

const NO_PREVIEW: KernelPreviewFields = {
  previewEvaluation: null,
  previewPending: false,
  previewError: null,
};

// ---- provisional features ---------------------------------------------------------------------

function buildProvisionalExtrude(
  tool: {
    profile: ExtrudeProfileRef;
    distance: number;
    operation: ExtrudeOperation;
    targetBodyId?: string;
  } & ExtrudeToolOptions,
): ExtrudeFeature {
  const extent =
    tool.extent === 'throughAll'
      ? { kind: 'throughAll' as const }
      : tool.extent === 'toObject' && tool.extentTarget
        ? { kind: 'toObject' as const, target: tool.extentTarget }
        : null;
  return {
    id: PREVIEW_EXTRUDE_FEATURE_ID,
    name: 'Extrude (preview)',
    suppressed: false,
    kind: 'extrude',
    profile: tool.profile,
    distance: tool.distance,
    symmetric: tool.sides === 'symmetric',
    operation: tool.operation,
    ...(tool.targetBodyId !== undefined ? { targetBodyId: tool.targetBodyId } : {}),
    ...(extent ? { extent } : {}),
    ...(tool.sides === 'two' && tool.distance2 !== undefined && tool.distance2 > 0
      ? { distance2: tool.distance2 }
      : {}),
    ...(tool.startOffset ? { startOffset: tool.startOffset } : {}),
    ...(tool.taper ? { taper: tool.taper } : {}),
  };
}

/** `false` while an extrude has nothing to build yet (zero distance, To Object without a target). */
function extrudeReady(tool: ExtrudeTool): boolean {
  if (tool.extent === 'toObject') return tool.extentTarget !== undefined;
  if (tool.extent === 'throughAll') return true;
  return tool.distance !== 0;
}

function provisionalBlend(tool: EdgeBlendTool): Feature {
  const base = { id: PREVIEW_FEATURE_ID, suppressed: false };
  const rules = tool.rules && tool.rules.length > 0 ? { rules: tool.rules } : {};
  if (tool.blend === 'fillet') {
    return {
      ...base,
      name: 'Fillet (preview)',
      kind: 'fillet',
      edges: tool.edges,
      radius: tool.size,
      ...(tool.radius2 !== undefined ? { radius2: tool.radius2 } : {}),
      ...rules,
    };
  }
  const mode = tool.chamferMode ?? 'equal';
  return {
    ...base,
    name: 'Chamfer (preview)',
    kind: 'chamfer',
    edges: tool.edges,
    distance: tool.size,
    ...(mode !== 'equal' ? { mode } : {}),
    ...(mode === 'twoDistances' ? { distance2: tool.distance2 ?? tool.size * 2 } : {}),
    ...(mode === 'distanceAngle' ? { angle: tool.angle ?? 45 } : {}),
    ...(mode !== 'equal' && tool.flip ? { flip: true } : {}),
    ...rules,
  };
}

function provisionalShell(tool: ShellTool): Feature {
  return {
    id: PREVIEW_FEATURE_ID,
    suppressed: false,
    name: 'Shell (preview)',
    kind: 'shell',
    bodyId: tool.bodyId,
    faces: tool.faces,
    thickness: tool.thickness,
    ...(tool.direction === 'outside' ? { direction: 'outside' as const } : {}),
    ...(tool.direction === 'outside' && tool.clearance ? { clearance: tool.clearance } : {}),
  };
}

function provisionalBoolean(tool: BooleanTool): Feature {
  return {
    id: PREVIEW_FEATURE_ID,
    suppressed: false,
    name: 'Boolean (preview)',
    kind: 'boolean',
    operation: tool.operation,
    targetBodyId: tool.targetBodyId,
    toolBodyIds: tool.toolBodyIds,
    ...(tool.keepTools ? { keepTools: true } : {}),
    ...(tool.keepTarget ? { keepTarget: true } : {}),
  };
}

/**
 * The sketch feature after moving a profile with the gizmo: the move's
 * in-plane part translates the curves; the part along the normal moves a
 * whole sketch on a world plane (its offset); rotations are refused (they
 * would break horizontal/vertical constraints).
 */
export function moveSketchResult(
  features: readonly Feature[],
  tool: MoveTool,
): { ok: true; feature: SketchFeature } | { ok: false; reason: string } {
  const target = tool.sketch;
  if (!target) return { ok: false, reason: 'Not a sketch move.' };
  const feature = features.find(
    (f): f is SketchFeature => f.id === target.featureId && f.kind === 'sketch',
  );
  if (!feature) return { ok: false, reason: 'The sketch no longer exists.' };
  const { rx, ry, rz } = tool.rotation;
  if (rx !== 0 || ry !== 0 || rz !== 0) {
    return {
      ok: false,
      reason:
        'Sketch profiles move, they do not rotate here (it would break horizontal/vertical constraints); rotate the body, or the curves in sketch mode.',
    };
  }
  const { u, v, normal } = target.frame;
  const d: Vec3 = [tool.delta.dx, tool.delta.dy, tool.delta.dz];
  const along = (a: Vec3) => a[0] * d[0] + a[1] * d[1] + a[2] * d[2];
  const du = along(u);
  const dv = along(v);
  const dn = along(normal);
  let plane = feature.plane;
  if (Math.abs(dn) > 1e-9) {
    if (target.regionKey !== undefined || plane.kind !== 'plane') {
      return {
        ok: false,
        reason:
          target.regionKey !== undefined
            ? 'A profile moves within its sketch plane; move the whole sketch (double-click it) to lift it.'
            : 'Only a sketch on a world plane can be lifted off its plane; move it within the plane.',
      };
    }
    const k = frameForPlane(plane.plane, 0).normal;
    plane = {
      ...plane,
      offset: plane.offset + dn * (k[0] * normal[0] + k[1] * normal[1] + k[2] * normal[2]),
    };
  }
  const moved =
    Math.abs(du) > 1e-12 || Math.abs(dv) > 1e-12
      ? translateSketchRegion(feature, target.regionKey, du, dv)
      : ({ ok: true, sketch: feature } as const);
  if (!moved.ok) return moved;
  return { ok: true, feature: { ...feature, ...moved.sketch, plane } };
}

// ---- tool kinds -------------------------------------------------------------------------------

registerToolKind({
  kind: 'extrude',
  module: 'modeling',
  provisional: (tool) => (extrudeReady(tool) ? buildProvisionalExtrude(tool) : null),
  commit: (tool, done) => {
    // "To Object" without its object (or a zero distance) has nothing to commit yet.
    if (!extrudeReady(tool)) return;
    const feature: ExtrudeFeature = {
      ...buildProvisionalExtrude(tool),
      id: createFeatureId('extrude'),
      name: nextFeatureName('Extrude', done.features),
    };
    // The consumed profile is deselected (and so hidden again), like Shapr3D.
    done.commitFeature(feature, []);
  },
});

/** Done of the fillet/chamfer, shell and boolean tools: the provisional feature, named and kept. */
function commitProvisional(provisional: Feature, prefix: string, done: ToolCommit): void {
  const feature = {
    ...provisional,
    id: createFeatureId(provisional.kind),
    name: nextFeatureName(prefix, done.features),
  } as Feature;
  done.commitFeature(feature, [{ kind: 'feature', featureId: feature.id }]);
}

registerToolKind({
  kind: 'edgeBlend',
  module: 'modeling',
  provisional: provisionalBlend,
  commit: (tool, done) =>
    commitProvisional(provisionalBlend(tool), tool.blend === 'fillet' ? 'Fillet' : 'Chamfer', done),
  emptyClickFinishes: true,
});

registerToolKind({
  kind: 'shell',
  module: 'modeling',
  provisional: provisionalShell,
  commit: (tool, done) => commitProvisional(provisionalShell(tool), 'Shell', done),
  emptyClickFinishes: true,
});

registerToolKind({
  kind: 'boolean',
  module: 'modeling',
  provisional: provisionalBoolean,
  commit: (tool, done) =>
    commitProvisional(provisionalBoolean(tool), BOOLEAN_LABEL[tool.operation], done),
  emptyClickFinishes: true,
});

registerToolKind({
  kind: 'move',
  module: 'modeling',
  commit: (tool, done) => {
    const { rotation } = tool;
    if (tool.sketch) {
      const result = moveSketchResult(done.features, tool);
      if (!result.ok) {
        done.update({ ...tool, problem: result.reason });
        return;
      }
      done.commitFeatures(
        done.features.map((f) => (f.id === result.feature.id ? result.feature : f)),
        [{ kind: 'sketchProfile', featureId: result.feature.id }],
      );
      return;
    }
    if (tool.copy || rotation.rx !== 0 || rotation.ry !== 0 || rotation.rz !== 0) {
      const transform: TransformFeature = {
        id: createFeatureId('transform'),
        name: nextFeatureName(featureKindLabel('transform'), done.features),
        suppressed: false,
        kind: 'transform',
        bodyId: tool.bodyId,
        // Rotations about an oriented gizmo become the equivalent world rotations.
        ...gizmoTransformFields(tool),
        copy: tool.copy,
      };
      done.commitFeatures([...done.features, transform]);
      return;
    }
    const feature: MoveFeature = {
      id: createFeatureId('move'),
      name: nextFeatureName('Move', done.features),
      suppressed: false,
      kind: 'move',
      bodyId: tool.bodyId,
      dx: tool.delta.dx,
      dy: tool.delta.dy,
      dz: tool.delta.dz,
    };
    done.commitFeatures([...done.features, feature]);
  },
});

// ---- store slice --------------------------------------------------------------------------------

/** Box centre of a body, or the origin. */
function bodyCentre(evaluation: EvaluationResult, bodyId: string): Vec3 {
  const body = evaluation.bodies.find((b) => b.id === bodyId);
  if (!body) return [0, 0, 0];
  return [
    (body.min[0] + body.max[0]) / 2,
    (body.min[1] + body.max[1]) / 2,
    (body.min[2] + body.max[2]) / 2,
  ];
}

function selectedEdgeRefs(state: AssemblerState): EdgeRef[] {
  return state.selection
    .filter((item): item is Extract<SelectionItem, { kind: 'edge' }> => item.kind === 'edge')
    .map((item) => makeEdgeRef(state.evaluation, item.bodyId, item.edgeKey))
    .filter((ref): ref is EdgeRef => ref !== null);
}

function selectedFaceRefs(state: AssemblerState): FaceRef[] {
  return state.selection
    .filter((item): item is Extract<SelectionItem, { kind: 'face' }> => item.kind === 'face')
    .map((item) => makeFaceRef(state.evaluation, item.bodyId, item.faceKey))
    .filter((ref): ref is FaceRef => ref !== null);
}

function selectedBodyIds(state: AssemblerState): string[] {
  return state.selection
    .filter((item): item is Extract<SelectionItem, { kind: 'body' }> => item.kind === 'body')
    .map((item) => item.bodyId);
}

/** The actions of the modelling tools (merged into `AssemblerState`). */
export interface ModelingToolsSlice {
  beginExtrude: (profile: ExtrudeProfileRef) => void;
  setDistance: (distanceMm: number) => void;
  setExtrudeOperation: (operation: ExtrudeOperation) => void;
  /** Extent, sides, second distance, start offset, To Object target of the running Extrude. */
  setExtrudeOptions: (options: ExtrudeToolOptions) => void;
  beginMove: (bodyId: string) => void;
  setDelta: (dx: number, dy: number, dz: number) => void;
  /** Move/Rotate gizmo rings: degrees about world X, Y, Z through the pivot. */
  setRotation: (rx: number, ry: number, rz: number) => void;
  /** Moves the gizmo centre (rotation pivot). */
  setPivot: (pivot: Vec3) => void;
  /** Copy badge of the Move/Rotate tool. */
  setMoveCopy: (copy: boolean) => void;
  /** Gizmo orientation: unit axes, or `null` for world X/Y/Z. Keeps the move so far. */
  setMoveAxes: (axes: [Vec3, Vec3, Vec3] | null) => void;
  setMoveAutoOrient: (on: boolean) => void;
  /** Move/Rotate on a sketch profile (a region, or the whole sketch without `regionKey`). */
  beginMoveSketch: (featureId: string, regionKey?: string) => boolean;
  /** `F` — starts the fillet/chamfer tool on the selected edges of one body (live preview). */
  beginEdgeBlend: (kind: 'fillet' | 'chamfer') => void;
  setBlendSize: (size: number) => void;
  setBlendKind: (kind: 'fillet' | 'chamfer') => void;
  /** Starts the fillet/chamfer tool on edges chosen by rule (face edges, concave/convex edges). */
  beginEdgeBlendByRule: (kind: 'fillet' | 'chamfer', rules: EdgeRule[]) => void;
  /** Variable radius, chamfer mode and second value of the running fillet/chamfer tool. */
  setBlendOptions: (options: {
    [K in 'radius2' | 'chamferMode' | 'distance2' | 'angle' | 'flip']?:
      | EdgeBlendTool[K]
      | undefined;
  }) => void;
  /** Inward/outward walls of the running shell tool. */
  setShellDirection: (direction: ShellDirection) => void;
  /** Printing clearance of an outward shell (the cavity is the body grown by it); 0 removes it. */
  setShellClearance: (clearance: number) => void;
  /** Adds/removes an open face while the shell tool runs. */
  toggleShellFace: (bodyId: string, faceKey: string) => void;
  /** Keep or consume the tool bodies of the running boolean tool. */
  setBooleanKeepTools: (keep: boolean) => void;
  /** Keep the target unchanged (result as a new body) in the running boolean tool. */
  setBooleanKeepTarget: (keep: boolean) => void;
  /** Swaps the target with the first tool body of the running boolean tool. */
  swapBooleanTarget: () => void;
  /** Adds/removes a tool body while the boolean tool runs. */
  toggleBooleanTool: (bodyId: string) => void;
  /** Adds/removes an edge of the tool's body while the fillet/chamfer tool runs. */
  toggleBlendEdge: (bodyId: string, edgeKey: string) => void;
  /** `H` — starts the shell tool on the selected faces of one body (live preview). */
  beginShell: () => void;
  setShellThickness: (thickness: number) => void;
  /** Starts a Union/Subtract/Intersect preview of the selected bodies (first selected = target). */
  beginBoolean: (operation: BooleanFeature['operation']) => void;
  setBooleanOperation: (operation: BooleanFeature['operation']) => void;
  /** Fillets or chamfers the selected edges (one undo step); selects the new feature. */
  addEdgeBlend: (kind: 'fillet' | 'chamfer', size: number) => void;
  /** Shells the body of the selected faces, opening them (one undo step). */
  addShell: (thickness: number) => void;
  /** Boolean of the selected bodies: the first selected body is the target (one undo step). */
  addBoolean: (operation: BooleanFeature['operation']) => void;
}

declare module '../../foundation/commands/store.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface, @typescript-eslint/no-empty-object-type
  interface AssemblerStateExtensions extends ModelingToolsSlice {}
}

export const modelingToolsSlice: StoreSliceCreator<ModelingToolsSlice> = (set, get, core) => {
  const { endPreview, updatePreviewTool } = core.tools;
  /** One undo step appending `feature`, selecting it. */
  const appendFeature = (feature: Feature) =>
    core.commitDocument({
      features: [...get().features, feature],
      selection: [{ kind: 'feature', featureId: feature.id }],
    });
  return {
    beginExtrude: (profile) => {
      const state = get();
      let contact: SketchContact | null = null;
      if (profile.kind === 'sketch') {
        contact = findSketchContact(state.evaluation, profile.featureId, profile.regions);
        if (!contact && !state.evaluation.sketches.some((s) => s.featureId === profile.featureId)) {
          // Not evaluated yet (just drawn): trust the sketch's own face reference.
          const sketch = state.features.find(
            (f): f is SketchFeature => f.id === profile.featureId && f.kind === 'sketch',
          );
          if (sketch?.plane.kind === 'face') {
            contact = { bodyId: sketch.plane.face.bodyId, faceKey: sketch.plane.face.key, sign: 1 };
          }
        }
      } else {
        contact = { bodyId: profile.face.bodyId, faceKey: profile.face.key, sign: 1 };
      }
      const tool: ExtrudeTool = {
        kind: 'extrude',
        phase: 'collectingReferences',
        profile,
        distance: 0,
        operation: autoExtrudeOperation(contact, 0),
        ...(contact ? { targetBodyId: contact.bodyId } : {}),
        operationLocked: false,
        contact,
        ...NO_PREVIEW,
      };
      endPreview();
      // A closed profile inside a body face starts as a through-cut (Shapr3D), previewed at once.
      const cutDepth =
        profile.kind === 'sketch' && contact
          ? extrudeStartDepth(
              state.evaluation,
              state.features,
              profile.featureId,
              profile.regions,
              contact,
            )
          : null;
      if (cutDepth !== null) {
        updatePreviewTool({ ...tool, phase: 'preview', distance: cutDepth, operation: 'cut' });
        return;
      }
      // A zero distance has no geometry to preview; the first drag/entry requests one.
      set({ activeTool: tool });
    },
    setDistance: (distanceMm) => {
      const tool = get().activeTool;
      if (!tool || tool.kind !== 'extrude') return;
      const operation =
        tool.operationLocked || tool.profile.kind === 'face'
          ? tool.profile.kind === 'face' && tool.operation !== 'intersect'
            ? distanceMm < 0
              ? 'cut'
              : 'join'
            : tool.operation
          : autoExtrudeOperation(tool.contact, distanceMm);
      updatePreviewTool({ ...tool, phase: 'preview', distance: distanceMm, operation });
    },
    setExtrudeOptions: (options) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'extrude') return;
      const next: ExtrudeTool = { ...tool, ...options } as ExtrudeTool;
      for (const key of Object.keys(options) as (keyof ExtrudeToolOptions)[]) {
        if (options[key] === undefined) delete next[key];
      }
      if (next.extent !== 'toObject') delete next.extentTarget;
      if (next.sides === 'two' && next.distance2 === undefined) {
        next.distance2 = Math.max(MIN_FEATURE_SIZE_MM, Math.abs(next.distance) || 5);
      }
      // Through All / To Object need a direction: keep the sign, default into the material for a cut.
      if (next.extent && next.extent !== 'distance' && next.distance === 0) {
        next.distance = next.operation === 'cut' && next.contact ? -next.contact.sign : 1;
      }
      updatePreviewTool({ ...next, phase: 'preview' });
    },
    setExtrudeOperation: (operation) => {
      const tool = get().activeTool;
      if (!tool || tool.kind !== 'extrude') return;
      if (tool.profile.kind === 'face') {
        // Push/pull stays automatic except for Intersect.
        const next: ExtrudeTool = {
          ...tool,
          operation: operation === 'intersect' ? 'intersect' : tool.distance < 0 ? 'cut' : 'join',
          operationLocked: operation === 'intersect',
        };
        updatePreviewTool(next);
        return;
      }
      // Join/Cut need a target: the touched body, else the most recently changed one.
      const targetBodyId = tool.contact?.bodyId ?? tool.targetBodyId;
      const next: ExtrudeTool = { ...tool, operation, operationLocked: true };
      if (operation === 'new') delete next.targetBodyId;
      else if (targetBodyId !== undefined) next.targetBodyId = targetBodyId;
      updatePreviewTool(next);
    },

    beginEdgeBlend: (kind) => {
      const edges = selectedEdgeRefs(get());
      if (edges.length === 0) return;
      const bodyId = edges[0]!.bodyId;
      endPreview();
      updatePreviewTool({
        kind: 'edgeBlend',
        phase: 'preview',
        blend: kind,
        bodyId,
        edges: edges.filter((e) => e.bodyId === bodyId),
        size: DEFAULT_BLEND_SIZE_MM,
        ...NO_PREVIEW,
      });
    },
    setBlendSize: (size) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'edgeBlend' || !Number.isFinite(size)) return;
      updatePreviewTool({ ...tool, size });
    },
    setBlendKind: (kind) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'edgeBlend' || tool.blend === kind) return;
      updatePreviewTool({ ...tool, blend: kind });
    },
    toggleBlendEdge: (bodyId, edgeKey) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'edgeBlend' || bodyId !== tool.bodyId) return;
      const present = tool.edges.some((e) => e.key === edgeKey);
      if (present) {
        // Keep at least one edge (or rule).
        if (tool.edges.length === 1 && !(tool.rules && tool.rules.length > 0)) return;
        updatePreviewTool({ ...tool, edges: tool.edges.filter((e) => e.key !== edgeKey) });
        return;
      }
      const ref = makeEdgeRef(get().evaluation, bodyId, edgeKey);
      if (ref) updatePreviewTool({ ...tool, edges: [...tool.edges, ref] });
    },
    beginEdgeBlendByRule: (kind, rules) => {
      if (rules.length === 0) return;
      endPreview();
      updatePreviewTool({
        kind: 'edgeBlend',
        phase: 'preview',
        blend: kind,
        bodyId: edgeRuleBodyId(rules[0]!),
        edges: [],
        rules,
        size: DEFAULT_BLEND_SIZE_MM,
        ...NO_PREVIEW,
      });
    },
    setBlendOptions: (options) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'edgeBlend') return;
      const next = { ...tool, ...options } as EdgeBlendTool;
      for (const key of Object.keys(options) as (keyof typeof options)[]) {
        if (options[key] === undefined) delete next[key];
      }
      updatePreviewTool(next);
    },
    setShellDirection: (direction) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'shell') return;
      const next: ShellTool = { ...tool, direction };
      if (direction === 'inside') {
        delete next.direction;
        delete next.clearance; // a clearance only applies outwards
      }
      updatePreviewTool(next);
    },
    setShellClearance: (clearance) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'shell' || !Number.isFinite(clearance)) return;
      const next: ShellTool = { ...tool, direction: 'outside', clearance };
      if (clearance <= 0) delete next.clearance;
      updatePreviewTool(next);
    },
    toggleShellFace: (bodyId, faceKey) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'shell' || bodyId !== tool.bodyId) return;
      const present = tool.faces.some((f) => f.key === faceKey);
      if (present) {
        if (tool.faces.length === 1) return; // keep at least one open face
        updatePreviewTool({ ...tool, faces: tool.faces.filter((f) => f.key !== faceKey) });
        return;
      }
      const ref = makeFaceRef(get().evaluation, bodyId, faceKey);
      if (ref) updatePreviewTool({ ...tool, faces: [...tool.faces, ref] });
    },
    setBooleanKeepTools: (keep) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'boolean') return;
      const next: BooleanTool = { ...tool, keepTools: keep };
      if (!keep) delete next.keepTools;
      updatePreviewTool(next);
    },
    setBooleanKeepTarget: (keep) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'boolean') return;
      const next: BooleanTool = { ...tool, keepTarget: keep };
      if (!keep) delete next.keepTarget;
      updatePreviewTool(next);
    },
    swapBooleanTarget: () => {
      const tool = get().activeTool;
      if (tool?.kind !== 'boolean' || tool.toolBodyIds.length === 0) return;
      const [first, ...rest] = tool.toolBodyIds;
      updatePreviewTool({
        ...tool,
        targetBodyId: first!,
        toolBodyIds: [tool.targetBodyId, ...rest],
      });
    },
    toggleBooleanTool: (bodyId) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'boolean' || bodyId === tool.targetBodyId) return;
      const present = tool.toolBodyIds.includes(bodyId);
      if (present && tool.toolBodyIds.length === 1) return; // keep at least one tool body
      updatePreviewTool({
        ...tool,
        toolBodyIds: present
          ? tool.toolBodyIds.filter((id) => id !== bodyId)
          : [...tool.toolBodyIds, bodyId],
      });
    },

    beginShell: () => {
      const faces = selectedFaceRefs(get());
      if (faces.length === 0) return;
      const bodyId = faces[0]!.bodyId;
      endPreview();
      updatePreviewTool({
        kind: 'shell',
        phase: 'preview',
        bodyId,
        faces: faces.filter((f) => f.bodyId === bodyId),
        thickness: DEFAULT_SHELL_THICKNESS_MM,
        ...NO_PREVIEW,
      });
    },
    setShellThickness: (thickness) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'shell' || !Number.isFinite(thickness)) return;
      updatePreviewTool({ ...tool, thickness });
    },

    beginBoolean: (operation) => {
      const bodyIds = selectedBodyIds(get());
      if (bodyIds.length < 2) return;
      endPreview();
      updatePreviewTool({
        kind: 'boolean',
        phase: 'preview',
        operation,
        targetBodyId: bodyIds[0]!,
        toolBodyIds: bodyIds.slice(1),
        ...NO_PREVIEW,
      });
    },
    setBooleanOperation: (operation) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'boolean' || tool.operation === operation) return;
      updatePreviewTool({ ...tool, operation });
    },
    beginMove: (bodyId) => {
      endPreview();
      set({
        activeTool: {
          kind: 'move',
          phase: 'collectingReferences',
          bodyId,
          delta: { dx: 0, dy: 0, dz: 0 },
          rotation: { rx: 0, ry: 0, rz: 0 },
          pivot: bodyCentre(get().evaluation, bodyId),
          copy: false,
        },
      });
    },
    setDelta: (dx, dy, dz) => {
      const tool = get().activeTool;
      if (!tool || tool.kind !== 'move') return;
      const { problem: _problem, ...rest } = tool;
      set({ activeTool: { ...rest, phase: 'preview', delta: { dx, dy, dz } } });
    },
    setRotation: (rx, ry, rz) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'move' || ![rx, ry, rz].every(Number.isFinite)) return;
      set({ activeTool: { ...tool, phase: 'preview', rotation: { rx, ry, rz } } });
    },
    setPivot: (pivot) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'move' || !pivot.every(Number.isFinite)) return;
      set({ activeTool: { ...tool, pivot: [...pivot] } });
    },
    setMoveCopy: (copy) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'move' || tool.sketch) return;
      set({ activeTool: { ...tool, copy } });
    },
    setMoveAxes: (axes) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'move' || tool.sketch) return;
      const next: MoveTool = { ...tool };
      if (axes) next.axes = axes;
      else delete next.axes;
      // Rotations so far are kept as the transform they make (re-expressed about the new axes
      // only when none were made yet; otherwise the orientation waits for the next tool).
      if (tool.rotation.rx !== 0 || tool.rotation.ry !== 0 || tool.rotation.rz !== 0) return;
      set({ activeTool: next });
    },
    setMoveAutoOrient: (on) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'move') return;
      set({ activeTool: { ...tool, autoOrient: on } });
    },
    beginMoveSketch: (featureId, regionKey) => {
      const state = get();
      const feature = state.features.find(
        (f): f is SketchFeature => f.id === featureId && f.kind === 'sketch',
      );
      const evaluated = state.evaluation.sketches.find((s) => s.featureId === featureId);
      if (!feature || !evaluated) return false;
      const frame = evaluated.frame;
      const centre = regionCentre(feature, regionKey);
      if (!centre) return false;
      endPreview();
      set({
        activeTool: {
          kind: 'move',
          phase: 'collectingReferences',
          bodyId: '',
          delta: { dx: 0, dy: 0, dz: 0 },
          rotation: { rx: 0, ry: 0, rz: 0 },
          pivot: [
            frame.origin[0] + frame.u[0] * centre[0] + frame.v[0] * centre[1],
            frame.origin[1] + frame.u[1] * centre[0] + frame.v[1] * centre[1],
            frame.origin[2] + frame.u[2] * centre[0] + frame.v[2] * centre[1],
          ],
          copy: false,
          // The gizmo lies in the sketch plane: u, v and the normal.
          axes: [frame.u, frame.v, frame.normal],
          sketch: { featureId, ...(regionKey !== undefined ? { regionKey } : {}), frame },
        },
      });
      return true;
    },

    addEdgeBlend: (kind, size) => {
      const state = get();
      const edges = selectedEdgeRefs(state);
      if (edges.length === 0) return;
      const prefix = kind === 'fillet' ? 'Fillet' : 'Chamfer';
      const base = {
        id: createFeatureId(kind),
        name: nextFeatureName(prefix, state.features),
        suppressed: false,
      };
      const feature: FilletFeature | ChamferFeature =
        kind === 'fillet'
          ? { ...base, kind: 'fillet', edges, radius: size }
          : { ...base, kind: 'chamfer', edges, distance: size };
      appendFeature(feature);
    },
    addShell: (thickness) => {
      const state = get();
      const faces = selectedFaceRefs(state);
      if (faces.length === 0) return;
      const feature: ShellFeature = {
        id: createFeatureId('shell'),
        name: nextFeatureName('Shell', state.features),
        suppressed: false,
        kind: 'shell',
        bodyId: faces[0]!.bodyId,
        faces,
        thickness,
      };
      appendFeature(feature);
    },
    addBoolean: (operation) => {
      const state = get();
      const bodyIds = selectedBodyIds(state);
      if (bodyIds.length < 2) return;
      const feature: BooleanFeature = {
        id: createFeatureId('boolean'),
        name: nextFeatureName(BOOLEAN_LABEL[operation], state.features),
        suppressed: false,
        kind: 'boolean',
        operation,
        targetBodyId: bodyIds[0]!,
        toolBodyIds: bodyIds.slice(1),
      };
      appendFeature(feature);
    },
  };
};
