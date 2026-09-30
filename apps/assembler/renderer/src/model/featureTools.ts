/**
 * Interactive tools for the modelling features of `features.ts` — Revolve,
 * Sweep, Loft, Mirror, Pattern, Split, Rotate Around Axis, Align, Offset
 * Face, Delete Face —
 * as pure data + functions, so the store keeps a single generic
 * `feature` tool session (`store.ts`) and the viewport/chrome render what
 * this module describes:
 *
 * - a {@link FeatureDraft} (the tool's references and parameters),
 * - {@link createDraft}: the Shapr3D-style start from the current selection
 *   (or the reason the command is unavailable),
 * - {@link acceptPick}: a viewport click while the tool runs (add/remove a
 *   body/face/edge/profile, pick an axis or plane),
 * - {@link draftToFeature}: the feature to preview/commit (`null` while a
 *   required reference is missing),
 * - {@link draftHandles}, {@link draftBadges}, {@link draftMeta}: drag
 *   handles with value chips, pill badges and the prompt.
 *
 * No store access, no DOM; unit tested under `node:test`.
 */
import { edgeSignatureOf, faceSignatureOf, baseEdgeKey, baseFaceKey } from '../kernel/naming.js';
import type { Body, EvaluationResult } from '../kernel/types.js';
import {
  frameForFace,
  frameForPlane,
  MIN_FEATURE_SIZE_MM,
  type EdgeRef,
  type ExtrudeOperation,
  type FaceRef,
  type Feature,
  type Plane,
  type Vec3,
} from './document.js';
import {
  MAX_PATTERN_COUNT,
  worldAxisVector,
  type AxisRef,
  type PathRef,
  type PatternDefinition,
  type PlaneRef,
  type ProfileRef,
  type WorldAxis,
} from './features.js';
import { constructionAxisLine, datumRef, planeRefPlane } from './construction.js';
import {
  acceptConstructionPick,
  constructionDraftBadges,
  constructionDraftGuides,
  constructionDraftHandles,
  constructionDraftMeta,
  constructionDraftToFeature,
  createConstructionDraft,
  isConstructionDraftKind,
  referencedDatumIds,
  type ConstructionDraft,
} from './constructionTools.js';
import { findSketchContact, pointInsideBody } from './modeling.js';
import { PRINT_CLEARANCES } from './printFeatures.js';
import {
  acceptPrintPick,
  createPrintDraft,
  isPrintDraftKind,
  printDraftBadges,
  printDraftGuides,
  printDraftHandles,
  printDraftMeta,
  printDraftModifiedBodyIds,
  printDraftToFeature,
  type PrintDraft,
} from './printFeatureTools.js';
import type { SelectionItem } from './store.js';

// ---- drafts -------------------------------------------------------------------------

interface ProfileOperation {
  operation: ExtrudeOperation;
  /** `true` once the user picked New/Join/Cut explicitly. */
  operationLocked: boolean;
  targetBodyId?: string;
}

export type FeatureDraft =
  | ({
      kind: 'revolve';
      profile: ProfileRef;
      axis: AxisRef | null;
      angle: number;
    } & ProfileOperation)
  | ({
      kind: 'sweep';
      profile: ProfileRef;
      path: PathRef;
    } & ProfileOperation)
  | ({ kind: 'loft'; profiles: ProfileRef[]; ruled: boolean } & ProfileOperation)
  | {
      kind: 'mirror';
      bodyIds: string[];
      plane: PlaneRef;
      keepOriginal: boolean;
      /** Sketches mirrored as a whole (their profiles become a mirrored sketch). */
      sketchIds?: string[];
      /** Planar faces mirrored as profiles. */
      faces?: FaceRef[];
      /** Mirror about this line (a half turn) instead of `plane`. */
      axis?: AxisRef;
      /** What a clicked planar face does: set the mirror plane (default) or join the targets. */
      facePicks?: 'plane' | 'target';
    }
  | { kind: 'pattern'; bodyIds: string[]; pattern: PatternDefinition }
  | { kind: 'split'; bodyId: string; plane: PlaneRef }
  /** Rotate Around Axis: bodies, an axis (edge / sketch line / world), degrees, copy. */
  | { kind: 'rotateAxis'; bodyIds: string[]; axis: AxisRef; angle: number; copy: boolean }
  | {
      kind: 'align';
      bodyId: string;
      face: FaceRef;
      target: FaceRef;
      flip: boolean;
      center: boolean;
      offset: number;
    }
  /** `viaMove`: started from Move/Rotate on a face (Shapr3D moves faces with the gizmo). */
  | { kind: 'offsetFace'; faces: FaceRef[]; distance: number; viaMove?: boolean }
  | { kind: 'deleteFace'; faces: FaceRef[] }
  // Hole, Emboss, Draft, Rib, Thicken (`printFeatureTools.ts`).
  | PrintDraft
  // Construction planes and axes (`constructionTools.ts`).
  | ConstructionDraft;

export type FeatureDraftKind = FeatureDraft['kind'];

function isConstructionDraft(draft: FeatureDraft): draft is ConstructionDraft {
  return isConstructionDraftKind(draft.kind);
}

/** Construction planes/axes a draft references (highlighted while the tool runs). */
export function draftDatumIds(draft: FeatureDraft): string[] {
  return referencedDatumIds(draft);
}

function isPrintDraft(draft: FeatureDraft): draft is PrintDraft {
  return isPrintDraftKind(draft.kind);
}

/** What a draft can be started from. */
export interface DraftContext {
  selection: readonly SelectionItem[];
  evaluation: EvaluationResult;
  features: readonly Feature[];
}

export type DraftStart = { ok: true; draft: FeatureDraft } | { ok: false; reason: string };

export const DEFAULT_REVOLVE_ANGLE = 360;
export const DEFAULT_PATTERN_COUNT = 3;
export const DEFAULT_OFFSET_MM = 1;
export const DEFAULT_SWEEP_LENGTH_MM = 20;
export const DEFAULT_ROTATE_ANGLE = 90;

// ---- reference helpers ------------------------------------------------------------------

function bodyOf(evaluation: EvaluationResult, bodyId: string): Body | undefined {
  return evaluation.bodies.find((b) => b.id === bodyId);
}

function faceOf(body: Body, key: string) {
  return (
    body.faces.find((f) => f.key === key) ??
    body.faces.find((f) => f.aliases.includes(key)) ??
    body.faces.find((f) => baseFaceKey(f.key) === baseFaceKey(key))
  );
}

function edgeOf(body: Body, key: string) {
  return (
    body.edges.find((e) => e.key === key) ??
    body.edges.find((e) => baseEdgeKey(e.key) === baseEdgeKey(key))
  );
}

function faceRefOf(evaluation: EvaluationResult, bodyId: string, key: string): FaceRef | null {
  const body = bodyOf(evaluation, bodyId);
  const face = body ? faceOf(body, key) : undefined;
  return face ? { bodyId, key: face.key, signature: faceSignatureOf(face) } : null;
}

function edgeRefOf(evaluation: EvaluationResult, bodyId: string, key: string): EdgeRef | null {
  const body = bodyOf(evaluation, bodyId);
  const edge = body ? edgeOf(body, key) : undefined;
  return edge ? { bodyId, key: edge.key, signature: edgeSignatureOf(edge) } : null;
}

function isPlanar(ref: FaceRef): boolean {
  return ref.signature.surface === 'plane' && ref.signature.normal !== null;
}

function selected<K extends SelectionItem['kind']>(
  selection: readonly SelectionItem[],
  kind: K,
): Extract<SelectionItem, { kind: K }>[] {
  return selection.filter((s): s is Extract<SelectionItem, { kind: K }> => s.kind === kind);
}

/** Profiles in the selection: sketch profiles and planar faces (in selection order). */
function selectedProfiles(ctx: DraftContext): ProfileRef[] {
  const out: ProfileRef[] = [];
  for (const item of ctx.selection) {
    if (item.kind === 'sketchProfile') out.push(sketchProfileRef(item.featureId, item.regionKey));
    else if (item.kind === 'face') {
      const ref = faceRefOf(ctx.evaluation, item.bodyId, item.faceKey);
      if (ref && isPlanar(ref)) out.push({ kind: 'face', face: ref });
    }
  }
  return out;
}

/** A sketch profile reference: one region by key, or (without a key) every region. */
function sketchProfileRef(featureId: string, regionKey: string | undefined): ProfileRef {
  return {
    kind: 'sketch',
    featureId,
    ...(regionKey !== undefined ? { regions: [regionKey] } : {}),
  };
}

function selectedEdges(ctx: DraftContext): EdgeRef[] {
  return selected(ctx.selection, 'edge')
    .map((e) => edgeRefOf(ctx.evaluation, e.bodyId, e.edgeKey))
    .filter((e): e is EdgeRef => e !== null);
}

function selectedFaceRefs(ctx: DraftContext): FaceRef[] {
  return selected(ctx.selection, 'face')
    .map((f) => faceRefOf(ctx.evaluation, f.bodyId, f.faceKey))
    .filter((f): f is FaceRef => f !== null);
}

// ---- geometry helpers --------------------------------------------------------------------

/** World sample points of a profile reference (outline + centre), empty if unknown. */
export function profileSamples(
  evaluation: EvaluationResult,
  ref: ProfileRef,
): { center: Vec3; normal: Vec3; outline: Vec3[] } | null {
  if (ref.kind === 'face') {
    const body = bodyOf(evaluation, ref.face.bodyId);
    const face = body ? faceOf(body, ref.face.key) : undefined;
    if (!body || !face || !face.normal) return null;
    const outline: Vec3[] = [];
    for (const e of face.edgeIndices) {
      const seg = body.edges[e]?.segments;
      if (!seg) continue;
      for (let i = 0; i < seg.length; i += 3) outline.push([seg[i]!, seg[i + 1]!, seg[i + 2]!]);
    }
    return { center: face.centroid, normal: face.normal, outline };
  }
  const sketch = evaluation.sketches.find((s) => s.featureId === ref.featureId);
  if (!sketch) return null;
  const regions = ref.regions;
  const profiles = regions
    ? sketch.profiles.filter((p) => regions.includes(p.key))
    : sketch.profiles;
  if (profiles.length === 0) return null;
  const center: Vec3 = [0, 0, 0];
  for (const p of profiles)
    for (let i = 0; i < 3; i += 1) center[i]! += p.center[i]! / profiles.length;
  return { center, normal: sketch.frame.normal, outline: profiles.flatMap((p) => p.outline) };
}

/**
 * Shapr3D-style automatic New/Join/Cut for a profile-based solid: a profile
 * lying mostly inside a body cuts it; one touching or overlapping a
 * body (or lying on its face) joins it; a free-standing one makes a new body.
 */
export function autoProfileOperation(
  evaluation: EvaluationResult,
  profiles: readonly ProfileRef[],
): { operation: ExtrudeOperation; targetBodyId?: string } {
  for (const ref of profiles) {
    const samples = profileSamples(evaluation, ref);
    if (!samples) continue;
    // Mostly inside a body (centre, outline and half-way points) -> cut it.
    const points = [
      samples.center,
      ...samples.outline,
      ...samples.outline.map((p) => scale(add(p, samples.center), 0.5)),
    ];
    const inside = evaluation.bodies.find(
      (b) => points.filter((p) => pointInsideBody(b, p)).length * 2 >= points.length,
    );
    if (inside) return { operation: 'cut', targetBodyId: inside.id };
  }
  for (const ref of profiles) {
    if (ref.kind === 'face') return { operation: 'join', targetBodyId: ref.face.bodyId };
    const contact = findSketchContact(evaluation, ref.featureId, ref.regions);
    if (contact) return { operation: 'join', targetBodyId: contact.bodyId };
    const samples = profileSamples(evaluation, ref);
    if (!samples) continue;
    const touched = evaluation.bodies.find((b) =>
      samples.outline.some((p) => {
        const away = normalize(sub(p, samples.center));
        return pointInsideBody(b, add(p, scale(away, 1e-3)));
      }),
    );
    if (touched) return { operation: 'join', targetBodyId: touched.id };
  }
  return { operation: 'new' };
}

/**
 * Straight construction lines of a sketch profile's own sketch that do not
 * cross the profile (a drawn centre line), nearest first.
 */
export function sketchAxisCandidates(evaluation: EvaluationResult, profile: ProfileRef): AxisRef[] {
  if (profile.kind !== 'sketch') return [];
  const sketch = evaluation.sketches.find((s) => s.featureId === profile.featureId);
  const samples = profileSamples(evaluation, profile);
  if (!sketch || !samples) return [];
  const n = samples.normal;
  const out: { axis: AxisRef; distance: number }[] = [];
  for (const curve of sketch.curves) {
    if (curve.kind !== 'line' || !curve.construction) continue;
    const a = curve.points[0];
    const b = curve.points[curve.points.length - 1];
    if (!a || !b || Math.hypot(...sub(b, a)) < MIN_FEATURE_SIZE_MM) continue;
    const side = normalize(cross(n, normalize(sub(b, a))));
    const offsets = samples.outline.map((p) => dot(sub(p, a), side));
    const min = Math.min(...offsets);
    const max = Math.max(...offsets);
    if ((min < -1e-6 && max > 1e-6) || Math.max(Math.abs(min), Math.abs(max)) < 1e-6) continue;
    out.push({
      axis: { kind: 'sketchLine', featureId: profile.featureId, entityId: curve.entityId },
      distance: Math.min(Math.abs(min), Math.abs(max)),
    });
  }
  return out.sort((x, y) => x.distance - y.distance).map((c) => c.axis);
}

/**
 * Default revolve axis: a construction line of the profile's sketch (a
 * drawn centre line), else a world axis lying in the profile's plane that
 * does not cross the profile, nearest first.
 */
export function defaultRevolveAxis(
  evaluation: EvaluationResult,
  profile: ProfileRef,
): AxisRef | null {
  const fromSketch = sketchAxisCandidates(evaluation, profile)[0];
  if (fromSketch) return fromSketch;
  return defaultWorldRevolveAxis(evaluation, profile);
}

/** A world axis lying in the profile's plane that does not cross the profile, nearest first. */
function defaultWorldRevolveAxis(
  evaluation: EvaluationResult,
  profile: ProfileRef,
): AxisRef | null {
  const samples = profileSamples(evaluation, profile);
  if (!samples) return null;
  const n = samples.normal;
  const throughOrigin = Math.abs(dot(samples.center, n)) < 1e-6;
  const candidates: { axis: AxisRef; distance: number }[] = [];
  for (const name of ['X', 'Y', 'Z'] as WorldAxis[]) {
    const dir = worldAxisVector(name);
    if (Math.abs(dot(dir, n)) > 1e-9) continue;
    const side = normalize(cross(n, dir));
    if (throughOrigin) {
      // The world axis itself lies in the sketch plane: usable if it misses the profile.
      const offsets = samples.outline.map((p) => dot(p, side));
      const min = Math.min(...offsets);
      const max = Math.max(...offsets);
      if ((min < -1e-6 && max > 1e-6) || Math.max(Math.abs(min), Math.abs(max)) < 1e-6) continue;
      candidates.push({
        axis: { kind: 'world', axis: name },
        distance: Math.min(Math.abs(min), Math.abs(max)),
      });
    } else {
      // A parallel axis along the profile's nearest side (like revolving about a sketch edge).
      const offsets = samples.outline.map((p) => dot(sub(p, samples.center), side));
      const min = Math.min(...offsets);
      const max = Math.max(...offsets);
      const shift = Math.abs(min) <= Math.abs(max) ? min : max;
      candidates.push({
        axis: { kind: 'world', axis: name, origin: add(samples.center, scale(side, shift)) },
        distance: 1e9 + Math.abs(shift),
      });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0]?.axis ?? null;
}

function unionBounds(bodies: readonly Body[]): { min: Vec3; max: Vec3 } | null {
  if (bodies.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i]!, b.min[i]!);
      max[i] = Math.max(max[i]!, b.max[i]!);
    }
  }
  return { min, max };
}

const AXIS_INDEX: Record<WorldAxis, 0 | 1 | 2> = { X: 0, Y: 1, Z: 2 };
const PLANE_OF_AXIS: Record<WorldAxis, Plane> = { X: 'YZ', Y: 'XZ', Z: 'XY' };
const AXIS_OF_PLANE: Record<Plane, WorldAxis> = { YZ: 'X', XZ: 'Y', XY: 'Z' };

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---- starting a tool -------------------------------------------------------------------

/** Starts `kind` from the selection, or explains what is missing (the command's disabled reason). */
export function createDraft(kind: FeatureDraftKind, ctx: DraftContext): DraftStart {
  if (isPrintDraftKind(kind)) return createPrintDraft(kind, ctx);
  if (kind === 'constructionPlane' || kind === 'constructionAxis') {
    return {
      ok: true,
      draft: createConstructionDraft(
        kind,
        kind === 'constructionPlane' ? 'offset' : 'edge',
        ctx.selection,
        ctx.evaluation,
      ),
    };
  }
  switch (kind) {
    case 'revolve': {
      const profiles = selectedProfiles(ctx);
      if (profiles.length !== 1) {
        return {
          ok: false,
          reason: 'Select one sketch profile or planar face (and optionally an axis edge).',
        };
      }
      const profile = profiles[0]!;
      const edges = selectedEdges(ctx);
      const axis: AxisRef | null = edges[0]
        ? { kind: 'edge', edge: edges[0] }
        : defaultRevolveAxis(ctx.evaluation, profile);
      return {
        ok: true,
        draft: {
          kind: 'revolve',
          profile,
          axis,
          angle: DEFAULT_REVOLVE_ANGLE,
          operationLocked: false,
          ...autoProfileOperation(ctx.evaluation, [profile]),
        },
      };
    }
    case 'sweep': {
      const profiles = selectedProfiles(ctx);
      if (profiles.length !== 1) {
        return {
          ok: false,
          reason: 'Select one sketch profile or planar face, then the path edges.',
        };
      }
      const profile = profiles[0]!;
      const edges = selectedEdges(ctx);
      let path: PathRef;
      if (edges.length > 0) path = { kind: 'edges', edges };
      else {
        const samples = profileSamples(ctx.evaluation, profile);
        if (!samples) return { ok: false, reason: 'The profile is not evaluated yet.' };
        path = {
          kind: 'line',
          start: samples.center,
          end: add(samples.center, scale(samples.normal, DEFAULT_SWEEP_LENGTH_MM)),
        };
      }
      return {
        ok: true,
        draft: {
          kind: 'sweep',
          profile,
          path,
          operationLocked: false,
          ...autoProfileOperation(ctx.evaluation, [profile]),
        },
      };
    }
    case 'loft': {
      const profiles = selectedProfiles(ctx);
      if (profiles.length < 2) {
        return { ok: false, reason: 'Select two or more profiles on different planes, in order.' };
      }
      return {
        ok: true,
        draft: {
          kind: 'loft',
          profiles,
          ruled: false,
          operationLocked: false,
          ...autoProfileOperation(ctx.evaluation, profiles),
        },
      };
    }
    case 'mirror': {
      // Shapr3D Mirror: sketches, faces and bodies across a plane, a planar face or an axis/line.
      const bodyIds = selected(ctx.selection, 'body').map((b) => b.bodyId);
      const sketchIds = [
        ...new Set(selected(ctx.selection, 'sketchProfile').map((s) => s.featureId)),
      ];
      const datums = selected(ctx.selection, 'datum')
        .map((d) => datumRef(ctx.evaluation, d.featureId))
        .filter((r): r is NonNullable<typeof r> => r !== null);
      const datumPlane = datums.find((r) => 'frame' in r) as PlaneRef | undefined;
      const datumAxis = datums.find((r) => 'line' in r) as AxisRef | undefined;
      const edges = selectedEdges(ctx).filter((e) => e.signature.curve === 'line');
      const axis: AxisRef | undefined =
        datumAxis ?? (edges[0] ? { kind: 'edge', edge: edges[0] } : undefined);
      const planarFaces = selectedFaceRefs(ctx).filter(isPlanar);
      // With a plane or axis chosen otherwise, selected faces are targets; else the face is the plane.
      const faceTargets = datumPlane || axis ? planarFaces : [];
      if (bodyIds.length === 0 && sketchIds.length === 0 && faceTargets.length === 0) {
        return { ok: false, reason: 'Select the bodies, sketches or faces to mirror.' };
      }
      const face = datumPlane || axis ? undefined : planarFaces[0];
      let plane: PlaneRef;
      if (datumPlane) plane = datumPlane;
      else if (face) plane = { kind: 'face', face };
      else {
        const bounds = unionBounds(ctx.evaluation.bodies.filter((b) => bodyIds.includes(b.id)));
        plane = { kind: 'plane', plane: 'YZ', offset: bounds ? round(bounds.max[0]) : 0 };
      }
      return {
        ok: true,
        draft: {
          kind: 'mirror',
          bodyIds,
          plane,
          keepOriginal: true,
          ...(sketchIds.length > 0 ? { sketchIds } : {}),
          ...(faceTargets.length > 0 ? { faces: faceTargets } : {}),
          ...(axis ? { axis } : {}),
        },
      };
    }
    case 'pattern': {
      const bodyIds = selected(ctx.selection, 'body').map((b) => b.bodyId);
      if (bodyIds.length === 0) return { ok: false, reason: 'Select the bodies to pattern.' };
      const edge = selectedEdges(ctx)[0];
      const bounds = unionBounds(ctx.evaluation.bodies.filter((b) => bodyIds.includes(b.id)));
      if (edge?.signature.curve === 'circle') {
        return {
          ok: true,
          draft: {
            kind: 'pattern',
            bodyIds,
            pattern: { kind: 'circular', axis: { kind: 'edge', edge }, count: 6, angle: 360 },
          },
        };
      }
      const direction: AxisRef = edge ? { kind: 'edge', edge } : { kind: 'world', axis: 'X' };
      const dir = edge?.signature.direction ?? [1, 0, 0];
      const extent = bounds
        ? Math.abs(dot(sub(bounds.max, bounds.min), dir.map(Math.abs) as Vec3))
        : 10;
      return {
        ok: true,
        draft: {
          kind: 'pattern',
          bodyIds,
          pattern: {
            kind: 'linear',
            direction,
            count: DEFAULT_PATTERN_COUNT,
            spacing: round(Math.max(1, extent + 5)),
          },
        },
      };
    }
    case 'split': {
      const bodies = selected(ctx.selection, 'body');
      if (bodies.length !== 1)
        return { ok: false, reason: 'Select one body to split (and optionally a planar face).' };
      const bodyId = bodies[0]!.bodyId;
      const face = selectedFaceRefs(ctx).find(isPlanar);
      if (face)
        return { ok: true, draft: { kind: 'split', bodyId, plane: { kind: 'face', face } } };
      const body = bodyOf(ctx.evaluation, bodyId);
      if (!body) return { ok: false, reason: 'The body is not evaluated yet.' };
      const size = sub(body.max, body.min);
      const largest = (['X', 'Y', 'Z'] as WorldAxis[]).reduce((a, b) =>
        size[AXIS_INDEX[b]] > size[AXIS_INDEX[a]] ? b : a,
      );
      const i = AXIS_INDEX[largest];
      return {
        ok: true,
        draft: {
          kind: 'split',
          bodyId,
          plane: {
            kind: 'plane',
            plane: PLANE_OF_AXIS[largest],
            offset: round((body.min[i]! + body.max[i]!) / 2),
          },
        },
      };
    }
    case 'rotateAxis': {
      // Shapr3D: a line plus a face suggests Rotate Around Axis — the face stands for its body.
      const edges = selectedEdges(ctx);
      const faceBodies = selected(ctx.selection, 'face').map((f) => f.bodyId);
      let bodyIds = selected(ctx.selection, 'body').map((b) => b.bodyId);
      if (bodyIds.length === 0 && edges.length === 1) bodyIds = [...new Set(faceBodies)];
      if (bodyIds.length === 0 || edges.length > 1) {
        return {
          ok: false,
          reason:
            'Select the bodies to rotate (or a face of one) and optionally an edge as the axis.',
        };
      }
      const edge = edges[0];
      let axis: AxisRef;
      if (edge && (edge.signature.curve === 'line' || edge.signature.curve === 'circle')) {
        axis = { kind: 'edge', edge };
      } else if (edge) {
        return { ok: false, reason: 'The axis must be a straight or circular edge.' };
      } else {
        const centre = bodyCentre(ctx.evaluation, bodyIds);
        axis = { kind: 'world', axis: 'Z', ...(centre ? { origin: centre } : {}) };
      }
      return {
        ok: true,
        draft: { kind: 'rotateAxis', bodyIds, axis, angle: DEFAULT_ROTATE_ANGLE, copy: false },
      };
    }
    case 'align': {
      const faces = selectedFaceRefs(ctx);
      if (faces.length !== 2 || ctx.selection.length !== 2) {
        return {
          ok: false,
          reason: 'Select a face on the body to move, then a face on the target body.',
        };
      }
      const [face, target] = faces as [FaceRef, FaceRef];
      if (face.bodyId === target.bodyId)
        return { ok: false, reason: 'The two faces must be on different bodies.' };
      if (!isPlanar(face) || !isPlanar(target))
        return { ok: false, reason: 'Align needs two planar faces.' };
      return {
        ok: true,
        draft: {
          kind: 'align',
          bodyId: face.bodyId,
          face,
          target,
          flip: false,
          center: true,
          offset: 0,
        },
      };
    }
    case 'offsetFace':
    case 'deleteFace': {
      const faces = selectedFaceRefs(ctx);
      if (faces.length === 0 || faces.length !== ctx.selection.length) {
        return { ok: false, reason: 'Select one or more faces of one body.' };
      }
      if (faces.some((f) => f.bodyId !== faces[0]!.bodyId)) {
        return { ok: false, reason: 'All faces must belong to one body.' };
      }
      return kind === 'offsetFace'
        ? { ok: true, draft: { kind, faces, distance: -DEFAULT_OFFSET_MM } }
        : { ok: true, draft: { kind, faces } };
    }
  }
}

// ---- picks while the tool runs -----------------------------------------------------------

export type ToolPick =
  | { kind: 'body'; bodyId: string }
  /**
   * `point`: where the face was clicked (world), when the viewport knows it;
   * `ray`: the pointer ray (tools that place things on their own plane, e.g. Hole).
   */
  | {
      kind: 'face';
      bodyId: string;
      faceKey: string;
      point?: Vec3;
      ray?: { origin: Vec3; direction: Vec3 };
    }
  /** `ray`: the pointer ray, when the viewport knows it (which end of the edge was clicked). */
  | { kind: 'edge'; bodyId: string; edgeKey: string; ray?: { origin: Vec3; direction: Vec3 } }
  | { kind: 'sketchProfile'; featureId: string; regionKey?: string }
  /** A straight sketch line (construction lines included): an axis or direction. */
  | { kind: 'sketchLine'; featureId: string; entityId: string }
  /** A construction plane or axis. */
  | { kind: 'datum'; featureId: string };

function toggle<T>(
  list: readonly T[],
  item: T,
  same: (a: T, b: T) => boolean,
  keepOne = true,
): T[] {
  const present = list.some((x) => same(x, item));
  if (!present) return [...list, item];
  if (keepOne && list.length === 1) return [...list];
  return list.filter((x) => !same(x, item));
}

const sameProfile = (a: ProfileRef, b: ProfileRef) =>
  a.kind === 'sketch' && b.kind === 'sketch'
    ? a.featureId === b.featureId && (a.regions ?? []).join('\n') === (b.regions ?? []).join('\n')
    : a.kind === 'face' && b.kind === 'face'
      ? a.face.bodyId === b.face.bodyId && a.face.key === b.face.key
      : false;

/** Applies a viewport click to the draft (unchanged draft = the click did not apply). */
export function acceptPick(
  draft: FeatureDraft,
  pick: ToolPick,
  evaluation: EvaluationResult,
  features: readonly Feature[] = [],
): FeatureDraft {
  if (isConstructionDraft(draft)) return acceptConstructionPick(draft, pick, evaluation);
  if (pick.kind === 'datum') return acceptDatumPick(draft, pick.featureId, evaluation);
  if (isPrintDraft(draft)) return acceptPrintPick(draft, pick, evaluation, features);
  const faceRef = pick.kind === 'face' ? faceRefOf(evaluation, pick.bodyId, pick.faceKey) : null;
  const edgeRef = pick.kind === 'edge' ? edgeRefOf(evaluation, pick.bodyId, pick.edgeKey) : null;
  const pickedBody =
    pick.kind === 'body' || pick.kind === 'face' || pick.kind === 'edge' ? pick.bodyId : null;
  const lineAxis: AxisRef | null =
    pick.kind === 'sketchLine'
      ? { kind: 'sketchLine', featureId: pick.featureId, entityId: pick.entityId }
      : null;
  switch (draft.kind) {
    case 'revolve':
      if (edgeRef && (edgeRef.signature.curve === 'line' || edgeRef.signature.curve === 'circle')) {
        return { ...draft, axis: { kind: 'edge', edge: edgeRef } };
      }
      if (lineAxis) return { ...draft, axis: lineAxis };
      if (pick.kind === 'sketchProfile')
        return retarget(
          { ...draft, profile: sketchProfileRef(pick.featureId, pick.regionKey) },
          evaluation,
        );
      if (faceRef && isPlanar(faceRef))
        return retarget({ ...draft, profile: { kind: 'face', face: faceRef } }, evaluation);
      return draft;
    case 'sweep':
      if (edgeRef) {
        const edges = draft.path.kind === 'edges' ? draft.path.edges : [];
        const next = toggle(
          edges,
          edgeRef,
          (a, b) => a.bodyId === b.bodyId && a.key === b.key,
          false,
        );
        if (next.length === 0) return draft;
        return { ...draft, path: { kind: 'edges', edges: next } };
      }
      if (pick.kind === 'sketchProfile') {
        if (draft.profile.kind === 'sketch' && draft.profile.featureId === pick.featureId)
          return draft;
        // A second sketch's region outline is a closed path (e.g. a ring the profile sweeps around).
        const region =
          pick.regionKey ??
          evaluation.sketches.find((s) => s.featureId === pick.featureId)?.profiles[0]?.key;
        if (region === undefined) return draft;
        return { ...draft, path: { kind: 'sketch', featureId: pick.featureId, region } };
      }
      return draft;
    case 'loft': {
      let ref: ProfileRef | null = null;
      if (pick.kind === 'sketchProfile') ref = sketchProfileRef(pick.featureId, pick.regionKey);
      else if (faceRef && isPlanar(faceRef)) ref = { kind: 'face', face: faceRef };
      if (!ref) return draft;
      const profiles = toggle(draft.profiles, ref, sameProfile, false);
      return profiles.length === 0 ? draft : retarget({ ...draft, profiles }, evaluation);
    }
    case 'mirror': {
      const targets = (next: typeof draft) =>
        next.bodyIds.length + (next.sketchIds?.length ?? 0) + (next.faces?.length ?? 0);
      if (pick.kind === 'sketchProfile') {
        const sketchIds = toggle(draft.sketchIds ?? [], pick.featureId, (a, b) => a === b, false);
        const next = { ...draft, sketchIds };
        return targets(next) > 0 ? next : draft;
      }
      if (lineAxis) return { ...draft, axis: lineAxis };
      if (edgeRef && edgeRef.signature.curve === 'line') {
        return { ...draft, axis: { kind: 'edge', edge: edgeRef } };
      }
      if (faceRef && isPlanar(faceRef) && draft.facePicks === 'target') {
        const faces = toggle(
          draft.faces ?? [],
          faceRef,
          (a, b) => a.bodyId === b.bodyId && a.key === b.key,
          false,
        );
        const next = { ...draft, faces };
        return targets(next) > 0 ? next : draft;
      }
      if (faceRef && isPlanar(faceRef) && !draft.bodyIds.includes(faceRef.bodyId)) {
        const { axis: _axis, ...rest } = draft;
        return { ...rest, plane: { kind: 'face', face: faceRef } };
      }
      if (pickedBody) {
        const next = {
          ...draft,
          bodyIds: toggle(draft.bodyIds, pickedBody, (a, b) => a === b, false),
        };
        return targets(next) > 0 ? next : draft;
      }
      return draft;
    }
    case 'pattern':
      if (lineAxis) {
        return draft.pattern.kind === 'linear'
          ? { ...draft, pattern: { ...draft.pattern, direction: lineAxis } }
          : { ...draft, pattern: { ...draft.pattern, axis: lineAxis } };
      }
      if (edgeRef) {
        const axis: AxisRef = { kind: 'edge', edge: edgeRef };
        if (draft.pattern.kind === 'linear' && edgeRef.signature.curve === 'line') {
          return { ...draft, pattern: { ...draft.pattern, direction: axis } };
        }
        if (draft.pattern.kind === 'circular')
          return { ...draft, pattern: { ...draft.pattern, axis } };
        return draft;
      }
      if (pickedBody)
        return { ...draft, bodyIds: toggle(draft.bodyIds, pickedBody, (a, b) => a === b) };
      return draft;
    case 'split':
      if (faceRef && isPlanar(faceRef)) return { ...draft, plane: { kind: 'face', face: faceRef } };
      return draft;
    case 'rotateAxis':
      // An edge or sketch line is the axis; a body (or its face) is added or removed.
      if (edgeRef && (edgeRef.signature.curve === 'line' || edgeRef.signature.curve === 'circle')) {
        return { ...draft, axis: { kind: 'edge', edge: edgeRef } };
      }
      if (lineAxis) return { ...draft, axis: lineAxis };
      if (pickedBody && pick.kind !== 'edge') {
        return { ...draft, bodyIds: toggle(draft.bodyIds, pickedBody, (a, b) => a === b) };
      }
      return draft;
    case 'align':
      if (faceRef && isPlanar(faceRef)) {
        if (faceRef.bodyId === draft.bodyId) return { ...draft, face: faceRef };
        return { ...draft, target: faceRef };
      }
      return draft;
    case 'offsetFace':
    case 'deleteFace':
      if (faceRef && faceRef.bodyId === draft.faces[0]?.bodyId) {
        return { ...draft, faces: toggle(draft.faces, faceRef, (a, b) => a.key === b.key) };
      }
      return draft;
  }
}

/**
 * A construction plane or axis clicked while a tool runs: a plane becomes
 * the mirror/split plane, an axis the revolve/pattern/rotate axis or the
 * mirror line (Shapr3D: construction geometry serves as those references).
 */
function acceptDatumPick(
  draft: FeatureDraft,
  featureId: string,
  evaluation: EvaluationResult,
): FeatureDraft {
  if (isPrintDraft(draft)) {
    return acceptPrintPick(draft, { kind: 'datum', featureId }, evaluation, []);
  }
  const ref = datumRef(evaluation, featureId);
  if (!ref) return draft;
  const plane = 'frame' in ref ? ref : null;
  const axis = 'line' in ref ? ref : null;
  switch (draft.kind) {
    case 'mirror': {
      if (plane) {
        const { axis: _axis, ...rest } = draft;
        return { ...rest, plane };
      }
      return axis ? { ...draft, axis } : draft;
    }
    case 'split':
      return plane ? { ...draft, plane } : draft;
    case 'revolve':
      return axis ? { ...draft, axis } : draft;
    case 'rotateAxis':
      return axis ? { ...draft, axis } : draft;
    case 'pattern':
      if (!axis) return draft;
      return draft.pattern.kind === 'linear'
        ? { ...draft, pattern: { ...draft.pattern, direction: axis } }
        : { ...draft, pattern: { ...draft.pattern, axis } };
    default:
      return draft;
  }
}

/** Re-runs the automatic operation after the profiles changed (unless locked). */
function retarget<T extends FeatureDraft & ProfileOperation>(
  draft: T,
  evaluation: EvaluationResult,
): T {
  if (draft.operationLocked) return draft;
  const profiles =
    draft.kind === 'loft'
      ? draft.profiles
      : draft.kind === 'revolve' || draft.kind === 'sweep'
        ? [draft.profile]
        : [];
  const auto = autoProfileOperation(evaluation, profiles);
  const next = { ...draft, operation: auto.operation } as T;
  if (auto.targetBodyId !== undefined) next.targetBodyId = auto.targetBodyId;
  else delete next.targetBodyId;
  return next;
}

/** Sets New/Join/Cut explicitly (locks it); Join/Cut keep or find a target. */
export function setDraftOperation(
  draft: FeatureDraft,
  operation: ExtrudeOperation,
  evaluation: EvaluationResult,
): FeatureDraft {
  if (draft.kind !== 'revolve' && draft.kind !== 'sweep' && draft.kind !== 'loft') return draft;
  const next = { ...draft, operation, operationLocked: true };
  if (operation === 'new') delete next.targetBodyId;
  else if (next.targetBodyId === undefined) {
    const last = evaluation.bodies[evaluation.bodies.length - 1];
    if (last) next.targetBodyId = last.id;
  }
  return next;
}

// ---- feature -----------------------------------------------------------------------------

/** The feature a draft stands for, or `null` while it is incomplete. */
export function draftToFeature(
  draft: FeatureDraft,
  base: { id: string; name: string },
): Feature | null {
  if (isConstructionDraft(draft)) return constructionDraftToFeature(draft, base);
  if (isPrintDraft(draft)) return printDraftToFeature(draft, base);
  const common = { id: base.id, name: base.name, suppressed: false };
  const op = (d: ProfileOperation) => ({
    operation: d.operation,
    ...(d.operation !== 'new' && d.targetBodyId !== undefined
      ? { targetBodyId: d.targetBodyId }
      : {}),
  });
  switch (draft.kind) {
    case 'revolve':
      if (!draft.axis) return null;
      return {
        ...common,
        kind: 'revolve',
        profile: draft.profile,
        axis: draft.axis,
        angle: draft.angle,
        ...op(draft),
      };
    case 'sweep':
      return { ...common, kind: 'sweep', profile: draft.profile, path: draft.path, ...op(draft) };
    case 'loft':
      if (draft.profiles.length < 2) return null;
      return {
        ...common,
        kind: 'loft',
        profiles: draft.profiles,
        ruled: draft.ruled,
        ...op(draft),
      };
    case 'mirror':
      if (
        draft.bodyIds.length === 0 &&
        (draft.sketchIds?.length ?? 0) === 0 &&
        (draft.faces?.length ?? 0) === 0
      ) {
        return null;
      }
      return {
        ...common,
        kind: 'mirror',
        bodyIds: draft.bodyIds,
        plane: draft.plane,
        keepOriginal: draft.keepOriginal,
        ...(draft.sketchIds?.length ? { sketchIds: draft.sketchIds } : {}),
        ...(draft.faces?.length ? { faces: draft.faces } : {}),
        ...(draft.axis ? { axis: draft.axis } : {}),
      };
    case 'pattern':
      if (draft.bodyIds.length === 0) return null;
      return { ...common, kind: 'pattern', bodyIds: draft.bodyIds, pattern: draft.pattern };
    case 'split':
      return { ...common, kind: 'split', bodyId: draft.bodyId, plane: draft.plane };
    case 'rotateAxis':
      if (draft.bodyIds.length === 0) return null;
      return {
        ...common,
        kind: 'rotateAxis',
        bodyIds: draft.bodyIds,
        axis: draft.axis,
        angle: draft.angle,
        copy: draft.copy,
      };
    case 'align':
      return {
        ...common,
        kind: 'align',
        bodyId: draft.bodyId,
        face: draft.face,
        target: draft.target,
        flip: draft.flip,
        center: draft.center,
        offset: draft.offset,
      };
    case 'offsetFace':
      if (draft.faces.length === 0 || draft.distance === 0) return null;
      return { ...common, kind: 'offsetFace', faces: draft.faces, distance: draft.distance };
    case 'deleteFace':
      if (draft.faces.length === 0) return null;
      return { ...common, kind: 'deleteFace', faces: draft.faces };
  }
}

// ---- pill: label, prompt, badges ------------------------------------------------------

export interface DraftMeta {
  label: string;
  shortcut: string;
  prompt: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function draftMeta(draft: FeatureDraft): DraftMeta {
  if (isConstructionDraft(draft)) return constructionDraftMeta(draft);
  if (isPrintDraft(draft)) return printDraftMeta(draft);
  switch (draft.kind) {
    case 'revolve':
      return {
        label: 'Revolve',
        shortcut: 'V',
        prompt: draft.axis
          ? 'Drag the arc or type an angle. Click an edge or a sketch line to change the axis.'
          : 'Pick the axis: a straight edge, a sketch line, or X/Y/Z.',
      };
    case 'sweep':
      return {
        label: 'Sweep',
        shortcut: 'W',
        prompt:
          draft.path.kind === 'edges'
            ? `Path: ${plural(draft.path.edges.length, 'edge')}. Click edges to add or remove.`
            : draft.path.kind === 'sketch'
              ? 'Path: a sketch outline. Click edges to use a body edge path instead.'
              : 'Straight path: drag the arrow or type a length. Click edges for an edge path.',
      };
    case 'loft':
      return {
        label: 'Loft',
        shortcut: '',
        prompt: `${plural(draft.profiles.length, 'profile')} in order. Click profiles to add or remove.`,
      };
    case 'mirror': {
      const what = [
        draft.bodyIds.length > 0 ? plural(draft.bodyIds.length, 'body', 'bodies') : '',
        draft.sketchIds?.length ? plural(draft.sketchIds.length, 'sketch', 'sketches') : '',
        draft.faces?.length ? plural(draft.faces.length, 'face') : '',
      ]
        .filter(Boolean)
        .join(', ');
      return {
        label: 'Mirror',
        shortcut: '',
        prompt: `${what}. ${
          draft.axis
            ? 'About the axis (a half turn about it); click a planar face or plane to mirror across it instead.'
            : 'Click a planar face, a construction plane or an axis/edge, or pick a plane'
        }; click bodies or sketches to add or remove.`,
      };
    }
    case 'pattern':
      return {
        label: 'Pattern',
        shortcut: '',
        prompt:
          draft.pattern.kind === 'linear'
            ? 'Drag the arrow or type count and spacing. Click an edge for the direction.'
            : 'Drag the arc or type count and angle. Click an edge for the axis.',
      };
    case 'split':
      return {
        label: 'Split Body',
        shortcut: '',
        prompt: 'Drag the plane or type its offset; click a planar face to split along it.',
      };
    case 'rotateAxis':
      return {
        label: 'Rotate Around Axis',
        shortcut: '',
        prompt: `${plural(draft.bodyIds.length, 'body', 'bodies')}. Drag the arc or type an angle; click an edge or sketch line for the axis, bodies to add or remove.`,
      };
    case 'align':
      return {
        label: 'Align',
        shortcut: '',
        prompt:
          'The first body moves onto the target face. Type a gap, or click faces to change them.',
      };
    case 'offsetFace':
      return draft.viaMove
        ? {
            label: 'Move Face',
            shortcut: 'M',
            prompt: `Drag the arrow: a face moves along its normal (neighbours follow as with Offset Face). ${plural(draft.faces.length, 'face')}.`,
          }
        : {
            label: 'Offset Face',
            shortcut: '',
            prompt: `Drag the arrow or type a distance (negative removes material). ${plural(draft.faces.length, 'face')}.`,
          };
    case 'deleteFace':
      return {
        label: 'Delete Face',
        shortcut: '',
        prompt: `Removes ${plural(draft.faces.length, 'face')} and heals the body. Click faces to add or remove.`,
      };
  }
}

export interface DraftBadge {
  ariaLabel: string;
  value: string;
  options: { value: string; label: string }[];
  apply: (draft: FeatureDraft, value: string, evaluation: EvaluationResult) => FeatureDraft;
}

const OPERATION_BADGE: DraftBadge = {
  ariaLabel: 'Operation',
  value: '',
  options: [
    { value: 'new', label: 'New body' },
    { value: 'join', label: 'Join' },
    { value: 'cut', label: 'Cut' },
  ],
  apply: (draft, value, evaluation) =>
    setDraftOperation(draft, value as ExtrudeOperation, evaluation),
};

function planeBadge(plane: PlaneRef, ariaLabel: string): DraftBadge {
  return {
    ariaLabel,
    value: plane.kind === 'plane' ? plane.plane : 'face',
    options: [
      { value: 'YZ', label: 'YZ' },
      { value: 'XZ', label: 'XZ' },
      { value: 'XY', label: 'XY' },
      ...(plane.kind === 'face' ? [{ value: 'face', label: 'Face' }] : []),
      ...(plane.kind === 'construction' ? [{ value: 'face', label: 'Construction plane' }] : []),
    ],
    apply: (draft, value, evaluation) => {
      if (value === 'face' || (draft.kind !== 'mirror' && draft.kind !== 'split')) return draft;
      const ids = draft.kind === 'mirror' ? draft.bodyIds : [draft.bodyId];
      const bounds = unionBounds(evaluation.bodies.filter((b) => ids.includes(b.id)));
      const i = AXIS_INDEX[AXIS_OF_PLANE[value as Plane]];
      const offset = bounds
        ? draft.kind === 'mirror'
          ? bounds.max[i]!
          : (bounds.min[i]! + bounds.max[i]!) / 2
        : 0;
      return { ...draft, plane: { kind: 'plane', plane: value as Plane, offset: round(offset) } };
    },
  };
}

export function draftBadges(draft: FeatureDraft): DraftBadge[] {
  if (isConstructionDraft(draft)) {
    return constructionDraftBadges(draft).map((badge) => ({
      ...badge,
      apply: (d, value, evaluation) =>
        isConstructionDraft(d) ? badge.apply(d, value, evaluation) : d,
    }));
  }
  if (isPrintDraft(draft)) {
    return printDraftBadges(draft).map((badge) => ({
      ...badge,
      apply: (d, value, evaluation) => (isPrintDraft(d) ? badge.apply(d, value, evaluation) : d),
    }));
  }
  switch (draft.kind) {
    case 'revolve':
      return [
        { ...OPERATION_BADGE, value: draft.operation },
        {
          ariaLabel: 'Revolve axis',
          value: draft.axis?.kind === 'world' ? draft.axis.axis : draft.axis ? 'edge' : '',
          options: [
            { value: 'X', label: 'X' },
            { value: 'Y', label: 'Y' },
            { value: 'Z', label: 'Z' },
            ...(draft.axis?.kind === 'edge' ? [{ value: 'edge', label: 'Edge' }] : []),
            ...(draft.axis?.kind === 'sketchLine' ? [{ value: 'edge', label: 'Sketch line' }] : []),
          ],
          apply: (d, value, evaluation) => {
            if (d.kind !== 'revolve' || value === 'edge') return d;
            const auto = defaultWorldRevolveAxis(evaluation, d.profile);
            const origin = auto?.kind === 'world' && auto.axis === value ? auto.origin : undefined;
            return {
              ...d,
              axis: { kind: 'world', axis: value as WorldAxis, ...(origin ? { origin } : {}) },
            };
          },
        },
      ];
    case 'sweep':
      return [{ ...OPERATION_BADGE, value: draft.operation }];
    case 'loft':
      return [
        { ...OPERATION_BADGE, value: draft.operation },
        {
          ariaLabel: 'Loft sides',
          value: draft.ruled ? 'ruled' : 'smooth',
          options: [
            { value: 'smooth', label: 'Smooth' },
            { value: 'ruled', label: 'Straight' },
          ],
          apply: (d, value) => (d.kind === 'loft' ? { ...d, ruled: value === 'ruled' } : d),
        },
      ];
    case 'mirror':
      return [
        draft.axis
          ? {
              ariaLabel: 'Mirror reference',
              value: 'axis',
              options: [
                { value: 'axis', label: 'About the axis' },
                { value: 'plane', label: 'Use a plane' },
              ],
              apply: (d) => {
                if (d.kind !== 'mirror') return d;
                const { axis: _axis, ...rest } = d;
                return rest;
              },
            }
          : planeBadge(draft.plane, 'Mirror plane'),
        {
          ariaLabel: 'Keep original',
          value: draft.keepOriginal ? 'copy' : 'move',
          options: [
            { value: 'copy', label: 'Keep original' },
            { value: 'move', label: 'Mirror in place' },
          ],
          apply: (d, value) => (d.kind === 'mirror' ? { ...d, keepOriginal: value === 'copy' } : d),
        },
        {
          ariaLabel: 'Clicked faces',
          value: draft.facePicks ?? 'plane',
          options: [
            { value: 'plane', label: 'Face = plane' },
            { value: 'target', label: 'Face = target' },
          ],
          apply: (d, value) =>
            d.kind === 'mirror' ? { ...d, facePicks: value === 'target' ? 'target' : 'plane' } : d,
        },
      ];
    case 'pattern':
      return [
        {
          ariaLabel: 'Pattern type',
          value: draft.pattern.kind,
          options: [
            { value: 'linear', label: 'Linear' },
            { value: 'circular', label: 'Circular' },
          ],
          apply: (d, value) => {
            if (d.kind !== 'pattern' || d.pattern.kind === value) return d;
            const count = d.pattern.count;
            return {
              ...d,
              pattern:
                value === 'circular'
                  ? {
                      kind: 'circular',
                      axis: { kind: 'world', axis: 'Z' },
                      count: Math.max(count, 2),
                      angle: 360,
                    }
                  : { kind: 'linear', direction: { kind: 'world', axis: 'X' }, count, spacing: 20 },
            };
          },
        },
        {
          ariaLabel: draft.pattern.kind === 'linear' ? 'Pattern direction' : 'Pattern axis',
          value: (() => {
            const ref =
              draft.pattern.kind === 'linear' ? draft.pattern.direction : draft.pattern.axis;
            return ref.kind === 'world' ? ref.axis : 'edge';
          })(),
          options: [
            { value: 'X', label: 'X' },
            { value: 'Y', label: 'Y' },
            { value: 'Z', label: 'Z' },
          ],
          apply: (d, value) => {
            if (d.kind !== 'pattern') return d;
            const ref: AxisRef = { kind: 'world', axis: value as WorldAxis };
            return {
              ...d,
              pattern:
                d.pattern.kind === 'linear'
                  ? { ...d.pattern, direction: ref }
                  : { ...d.pattern, axis: ref },
            };
          },
        },
      ];
    case 'split':
      return [planeBadge(draft.plane, 'Split plane')];
    case 'rotateAxis':
      return [
        {
          ariaLabel: 'Rotate or copy',
          value: draft.copy ? 'copy' : 'move',
          options: [
            { value: 'move', label: 'Rotate' },
            { value: 'copy', label: 'Copy' },
          ],
          apply: (d, value) => (d.kind === 'rotateAxis' ? { ...d, copy: value === 'copy' } : d),
        },
        {
          ariaLabel: 'Rotation axis',
          value: draft.axis.kind === 'world' ? draft.axis.axis : 'edge',
          options: [
            { value: 'X', label: 'X' },
            { value: 'Y', label: 'Y' },
            { value: 'Z', label: 'Z' },
            ...(draft.axis.kind === 'edge' ? [{ value: 'edge', label: 'Edge' }] : []),
            ...(draft.axis.kind === 'sketchLine' ? [{ value: 'edge', label: 'Sketch line' }] : []),
          ],
          apply: (d, value, evaluation) => {
            if (d.kind !== 'rotateAxis' || value === 'edge') return d;
            // A world axis through the bodies' centre.
            const centre = bodyCentre(evaluation, d.bodyIds);
            return {
              ...d,
              axis: {
                kind: 'world',
                axis: value as WorldAxis,
                ...(centre ? { origin: centre } : {}),
              },
            };
          },
        },
      ];
    case 'align':
      return [
        {
          ariaLabel: 'Face direction',
          value: draft.flip ? 'flush' : 'opposed',
          options: [
            { value: 'opposed', label: 'Face to face' },
            { value: 'flush', label: 'Same direction' },
          ],
          apply: (d, value) => (d.kind === 'align' ? { ...d, flip: value === 'flush' } : d),
        },
        {
          ariaLabel: 'Centre',
          value: draft.center ? 'center' : 'keep',
          options: [
            { value: 'center', label: 'Centred' },
            { value: 'keep', label: 'Keep position' },
          ],
          apply: (d, value) => (d.kind === 'align' ? { ...d, center: value === 'center' } : d),
        },
      ];
    case 'offsetFace':
      // Move Face (Move/Rotate on a face) is a plain drag; no clearance presets there.
      if (draft.viaMove) return [];
      // Printing clearances: remove 0.1-0.4 mm from mating faces (a hole wall grows, a peg shrinks).
      return [
        {
          ariaLabel: 'Clearance',
          value:
            PRINT_CLEARANCES.find((c) => Math.abs(draft.distance + c) < 1e-9)?.toString() ?? '',
          options: PRINT_CLEARANCES.map((c) => ({ value: String(c), label: `−${c}` })),
          apply: (d, value) => (d.kind === 'offsetFace' ? { ...d, distance: -Number(value) } : d),
        },
      ];
    default:
      return [];
  }
}

// ---- handles & chips ----------------------------------------------------------------------

/** Value unit of a handle chip. */
export type HandleUnit = 'mm' | 'deg' | 'count';

interface HandleBase {
  id: string;
  label: string;
  prefix?: string;
  unit: HandleUnit;
  value: number;
  /** Returns the draft with the new value (already validated/clamped). */
  apply: (draft: FeatureDraft, value: number) => FeatureDraft;
}

/** Arrow dragged along `dir`; the value grows by the drag distance. */
export interface LinearHandle extends HandleBase {
  kind: 'linear';
  base: Vec3;
  dir: Vec3;
  /** Drawn arrow length (mm). */
  length: number;
}

/** Arc about `axis` through `center`, from `ref` by `value` degrees; dragged around. */
export interface AngleHandle extends HandleBase {
  kind: 'angle';
  center: Vec3;
  axis: Vec3;
  ref: Vec3;
  radius: number;
}

/** A value chip without a drag handle (e.g. a pattern count). */
export interface ChipHandle extends HandleBase {
  kind: 'chip';
  at: Vec3;
}

export type DraftHandle = LinearHandle | AngleHandle | ChipHandle;

const STEM_MM = 8;

function clampCount(value: number): number {
  return Math.max(2, Math.min(MAX_PATTERN_COUNT, Math.round(value)));
}

function clampAngle(value: number): number {
  if (!Number.isFinite(value)) return 360;
  const v = Math.max(-360, Math.min(360, value));
  return Math.abs(v) < 0.1 ? (v < 0 ? -0.1 : 0.1) : v;
}

function axisLine(
  evaluation: EvaluationResult,
  ref: AxisRef | null,
  features: readonly Feature[],
): { point: Vec3; dir: Vec3 } | null {
  void features;
  if (!ref) return null;
  if (ref.kind === 'world')
    return { point: ref.origin ?? [0, 0, 0], dir: worldAxisVector(ref.axis) };
  if (ref.kind === 'edge') {
    const body = bodyOf(evaluation, ref.edge.bodyId);
    const edge = body ? edgeOf(body, ref.edge.key) : undefined;
    const sig = edge ?? ref.edge.signature;
    if (sig.direction) return { point: sig.midpoint, dir: sig.direction };
    if (edge && edge.curve === 'circle' && edge.radius && body) {
      // Circle axis: normal of the circle's plane through its centre (from three samples).
      const s = edge.segments;
      if (s.length >= 9) {
        const pts: Vec3[] = [
          0,
          Math.floor(s.length / 9) * 3,
          Math.floor((2 * s.length) / 9) * 3,
        ].map((i) => [s[i]!, s[i + 1]!, s[i + 2]!]);
        const n = normalize(cross(sub(pts[1]!, pts[0]!), sub(pts[2]!, pts[0]!)));
        const mid = edge.midpoint;
        const center = circleCenter(pts[0]!, pts[1]!, pts[2]!) ?? mid;
        return { point: center, dir: n };
      }
    }
    return null;
  }
  if (ref.kind === 'construction') return constructionAxisLine(ref, evaluation);
  const sketch = evaluation.sketches.find((s) => s.featureId === ref.featureId);
  const curve = sketch?.curves.find((c) => c.entityId === ref.entityId && c.kind === 'line');
  const a = curve?.points[0];
  const b = curve?.points[curve.points.length - 1];
  return a && b ? { point: a, dir: normalize(sub(b, a)) } : null;
}

function circleCenter(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const nn = dot(n, n);
  if (nn < 1e-12) return null;
  const term = add(scale(cross(n, ab), dot(ac, ac)), scale(cross(ac, n), dot(ab, ab)));
  return add(a, scale(term, 1 / (2 * nn)));
}

function planeOf(
  evaluation: EvaluationResult,
  plane: PlaneRef,
): { point: Vec3; normal: Vec3 } | null {
  if (plane.kind === 'plane') {
    const frame = frameForPlane(plane.plane, plane.offset);
    return { point: frame.origin, normal: frame.normal };
  }
  if (plane.kind === 'construction') return planeRefPlane(plane, evaluation);
  const body = bodyOf(evaluation, plane.face.bodyId);
  const face = body ? faceOf(body, plane.face.key) : undefined;
  const normal = face?.normal ?? plane.face.signature.normal;
  if (!normal) return null;
  return { point: face?.centroid ?? plane.face.signature.centroid, normal };
}

/** A point on a face's surface with its outward normal (first mesh triangle), for handles on curved faces. */
function faceAnchor(
  evaluation: EvaluationResult,
  ref: FaceRef,
): { point: Vec3; normal: Vec3 } | null {
  const body = bodyOf(evaluation, ref.bodyId);
  const face = body ? faceOf(body, ref.key) : undefined;
  if (!body || !face) return null;
  if (face.normal) return { point: face.centroid, normal: face.normal };
  if (face.triangleCount === 0) return null;
  const t = face.triangleStart + Math.floor(face.triangleCount / 2);
  const corners = [0, 1, 2].map((k) => {
    const v = body.mesh.indices[t * 3 + k]! * 3;
    return {
      p: [
        body.mesh.positions[v]!,
        body.mesh.positions[v + 1]!,
        body.mesh.positions[v + 2]!,
      ] as Vec3,
      n: [body.mesh.normals[v]!, body.mesh.normals[v + 1]!, body.mesh.normals[v + 2]!] as Vec3,
    };
  });
  const point = scale(add(add(corners[0]!.p, corners[1]!.p), corners[2]!.p), 1 / 3);
  const normal = normalize(add(add(corners[0]!.n, corners[1]!.n), corners[2]!.n));
  return { point, normal };
}

function bodyCentre(evaluation: EvaluationResult, ids: readonly string[]): Vec3 | null {
  const bounds = unionBounds(evaluation.bodies.filter((b) => ids.includes(b.id)));
  return bounds ? scale(add(bounds.min, bounds.max), 0.5) : null;
}

function perpendicular(axis: Vec3): Vec3 {
  return frameForFace(axis, [0, 0, 0]).u;
}

/** Drag handles and value chips of the draft (evaluated against the committed model). */
export function draftHandles(
  draft: FeatureDraft,
  evaluation: EvaluationResult,
  features: readonly Feature[] = [],
): DraftHandle[] {
  if (isConstructionDraft(draft)) {
    return constructionDraftHandles(draft, evaluation).map((h) => ({
      ...h,
      apply: (d: FeatureDraft, value: number) => (isConstructionDraft(d) ? h.apply(d, value) : d),
    }));
  }
  if (isPrintDraft(draft)) {
    return printDraftHandles(draft, evaluation, features).map((h) => ({
      ...h,
      apply: (d: FeatureDraft, value: number) => (isPrintDraft(d) ? h.apply(d, value) : d),
    }));
  }
  switch (draft.kind) {
    case 'revolve': {
      const line = axisLine(evaluation, draft.axis, features);
      const samples = profileSamples(evaluation, draft.profile);
      if (!line || !samples) return [];
      const k = dot(sub(samples.center, line.point), line.dir);
      const center = add(line.point, scale(line.dir, k));
      const radial = sub(samples.center, center);
      const radius = Math.hypot(...radial);
      if (radius < 1e-6) return [];
      return [
        {
          kind: 'angle',
          id: 'angle',
          label: 'Revolve angle',
          unit: 'deg',
          value: draft.angle,
          center,
          axis: line.dir,
          ref: normalize(radial),
          radius,
          apply: (d, value) => (d.kind === 'revolve' ? { ...d, angle: clampAngle(value) } : d),
        },
      ];
    }
    case 'sweep': {
      if (draft.path.kind !== 'line') return [];
      const { start, end } = draft.path;
      const length = Math.hypot(...sub(end, start));
      const dir = length > 1e-9 ? normalize(sub(end, start)) : ([0, 0, 1] as Vec3);
      return [
        {
          kind: 'linear',
          id: 'length',
          label: 'Path length',
          unit: 'mm',
          value: length,
          base: start,
          dir,
          length: Math.max(length, STEM_MM),
          apply: (d, value) => {
            if (d.kind !== 'sweep' || d.path.kind !== 'line') return d;
            const v = Math.max(MIN_FEATURE_SIZE_MM, value);
            return { ...d, path: { ...d.path, end: add(d.path.start, scale(dir, v)) } };
          },
        },
      ];
    }
    case 'mirror':
    case 'split': {
      const plane = planeOf(evaluation, draft.plane);
      const centre = bodyCentre(
        evaluation,
        draft.kind === 'mirror' ? draft.bodyIds : [draft.bodyId],
      );
      if (!plane || !centre || draft.plane.kind !== 'plane') return [];
      const planeRef = draft.plane;
      const base = sub(centre, scale(plane.normal, dot(sub(centre, plane.point), plane.normal)));
      return [
        {
          kind: 'linear',
          id: 'offset',
          label: `${draft.kind === 'mirror' ? 'Mirror' : 'Split'} plane offset`,
          prefix: `${AXIS_OF_PLANE[planeRef.plane]} =`,
          unit: 'mm',
          value: planeRef.offset,
          base,
          dir: plane.normal,
          length: 12,
          apply: (d, value) =>
            (d.kind === 'mirror' || d.kind === 'split') && d.plane.kind === 'plane'
              ? { ...d, plane: { ...d.plane, offset: value } }
              : d,
        },
      ];
    }
    case 'pattern': {
      const centre = bodyCentre(evaluation, draft.bodyIds);
      if (!centre) return [];
      const p = draft.pattern;
      const count: HandleBase = {
        id: 'count',
        label: 'Pattern count',
        prefix: '×',
        unit: 'count',
        value: p.count,
        apply: (d, value) =>
          d.kind === 'pattern' ? { ...d, pattern: { ...d.pattern, count: clampCount(value) } } : d,
      };
      if (p.kind === 'linear') {
        const line = axisLine(evaluation, p.direction, features);
        if (!line) return [];
        const dir = line.dir;
        const lastCentre = add(centre, scale(dir, p.spacing * (p.count - 1)));
        return [
          {
            kind: 'linear',
            id: 'spacing',
            label: 'Pattern spacing',
            unit: 'mm',
            value: p.spacing,
            base: centre,
            dir,
            length: Math.max(Math.abs(p.spacing), STEM_MM),
            apply: (d, value) =>
              d.kind === 'pattern' && d.pattern.kind === 'linear'
                ? {
                    ...d,
                    pattern: {
                      ...d.pattern,
                      spacing: Math.abs(value) < MIN_FEATURE_SIZE_MM ? MIN_FEATURE_SIZE_MM : value,
                    },
                  }
                : d,
          },
          { ...count, kind: 'chip', at: add(lastCentre, scale(dir, 6)) },
        ];
      }
      const line = axisLine(evaluation, p.axis, features);
      if (!line) return [];
      const k = dot(sub(centre, line.point), line.dir);
      const onAxis = add(line.point, scale(line.dir, k));
      const radial = sub(centre, onAxis);
      const radius = Math.hypot(...radial);
      const ref = radius > 1e-6 ? normalize(radial) : perpendicular(line.dir);
      const r = Math.max(radius, 10);
      return [
        {
          kind: 'angle',
          id: 'angle',
          label: 'Pattern angle',
          unit: 'deg',
          value: p.angle,
          center: onAxis,
          axis: line.dir,
          ref,
          radius: r,
          apply: (d, value) =>
            d.kind === 'pattern' && d.pattern.kind === 'circular'
              ? { ...d, pattern: { ...d.pattern, angle: clampAngle(Math.abs(value)) } }
              : d,
        },
        { ...count, kind: 'chip', at: add(onAxis, scale(ref, r * 1.25)) },
      ];
    }
    case 'rotateAxis': {
      const centre = bodyCentre(evaluation, draft.bodyIds);
      const line = axisLine(evaluation, draft.axis, features);
      if (!centre || !line) return [];
      const k = dot(sub(centre, line.point), line.dir);
      const onAxis = add(line.point, scale(line.dir, k));
      const radial = sub(centre, onAxis);
      const radius = Math.hypot(...radial);
      return [
        {
          kind: 'angle',
          id: 'angle',
          label: 'Rotation angle',
          unit: 'deg',
          value: draft.angle,
          center: onAxis,
          axis: line.dir,
          ref: radius > 1e-6 ? normalize(radial) : perpendicular(line.dir),
          radius: Math.max(radius, 10),
          apply: (d, value) =>
            d.kind === 'rotateAxis'
              ? { ...d, angle: Math.max(-360, Math.min(360, Number.isFinite(value) ? value : 0)) }
              : d,
        },
      ];
    }
    case 'align': {
      const target = planeOf(evaluation, { kind: 'face', face: draft.target });
      if (!target) return [];
      return [
        {
          kind: 'linear',
          id: 'offset',
          label: 'Align gap',
          unit: 'mm',
          value: draft.offset,
          base: target.point,
          dir: target.normal,
          length: STEM_MM + Math.max(0, draft.offset),
          apply: (d, value) => (d.kind === 'align' ? { ...d, offset: value } : d),
        },
      ];
    }
    case 'offsetFace': {
      const first = draft.faces[0];
      const anchor = first ? faceAnchor(evaluation, first) : null;
      if (!anchor) return [];
      return [
        {
          kind: 'linear',
          id: 'distance',
          label: 'Offset distance',
          unit: 'mm',
          value: draft.distance,
          base: anchor.point,
          dir: anchor.normal,
          length: STEM_MM + Math.max(0, draft.distance),
          apply: (d, value) => (d.kind === 'offsetFace' ? { ...d, distance: value } : d),
        },
      ];
    }
    default:
      return [];
  }
}

// ---- guides (axis lines, planes) -----------------------------------------------------------

export interface DraftGuides {
  /** Axis lines (world segments). */
  lines: [Vec3, Vec3][];
  /** Planes as closed quads. */
  planes: [Vec3, Vec3, Vec3, Vec3][];
}

/** Reference geometry the tool shows while it runs: the revolve/pattern axis, the mirror/split plane. */
export function draftGuides(
  draft: FeatureDraft,
  evaluation: EvaluationResult,
  features: readonly Feature[] = [],
): DraftGuides {
  if (isConstructionDraft(draft)) return constructionDraftGuides(draft, evaluation);
  if (isPrintDraft(draft)) return printDraftGuides(draft, evaluation, features);
  const out: DraftGuides = { lines: [], planes: [] };
  const axisSegment = (ref: AxisRef | null, around: Vec3 | null, reach: number) => {
    const line = axisLine(evaluation, ref, []);
    if (!line) return;
    const k = around ? dot(sub(around, line.point), line.dir) : 0;
    const c = add(line.point, scale(line.dir, k));
    out.lines.push([add(c, scale(line.dir, -reach)), add(c, scale(line.dir, reach))]);
  };
  if (draft.kind === 'revolve') {
    const samples = profileSamples(evaluation, draft.profile);
    const reach = samples
      ? Math.max(30, ...samples.outline.map((p) => Math.hypot(...sub(p, samples.center)))) * 1.5
      : 40;
    axisSegment(draft.axis, samples?.center ?? null, reach);
  } else if (draft.kind === 'pattern' && draft.pattern.kind === 'circular') {
    const centre = bodyCentre(evaluation, draft.bodyIds);
    axisSegment(draft.pattern.axis, centre, 40);
  } else if (draft.kind === 'rotateAxis') {
    const centre = bodyCentre(evaluation, draft.bodyIds);
    axisSegment(draft.axis, centre, 40);
  } else if (draft.kind === 'mirror' && draft.axis) {
    const centre = bodyCentre(evaluation, draft.bodyIds);
    axisSegment(draft.axis, centre, 40);
  } else if (draft.kind === 'mirror' || draft.kind === 'split') {
    const plane = planeOf(evaluation, draft.plane);
    const bounds = unionBounds(
      evaluation.bodies.filter((b) =>
        (draft.kind === 'mirror' ? draft.bodyIds : [draft.bodyId]).includes(b.id),
      ),
    );
    if (plane && bounds) {
      const centre = scale(add(bounds.min, bounds.max), 0.5);
      const onPlane = sub(centre, scale(plane.normal, dot(sub(centre, plane.point), plane.normal)));
      const frame = frameForFace(plane.normal, onPlane);
      const half = Math.max(10, Math.hypot(...sub(bounds.max, bounds.min)) * 0.65);
      const corner = (a: number, b: number): Vec3 =>
        add(onPlane, add(scale(frame.u, a * half), scale(frame.v, b * half)));
      out.planes.push([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]);
    }
  }
  return out;
}

/** Bodies the running tool modifies in place (shown with the preview accent). */
export function draftModifiedBodyIds(draft: FeatureDraft): string[] {
  if (isConstructionDraft(draft)) return [];
  if (isPrintDraft(draft)) return printDraftModifiedBodyIds(draft);
  switch (draft.kind) {
    case 'revolve':
    case 'sweep':
    case 'loft':
      return draft.operation !== 'new' && draft.targetBodyId ? [draft.targetBodyId] : [];
    case 'mirror':
      return draft.keepOriginal ? [] : draft.bodyIds;
    case 'rotateAxis':
      return draft.copy ? [] : draft.bodyIds;
    case 'split':
    case 'align':
      return [draft.bodyId];
    case 'offsetFace':
    case 'deleteFace':
      return draft.faces[0] ? [draft.faces[0].bodyId] : [];
    default:
      return [];
  }
}

// ---- vector helpers -------------------------------------------------------------------

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
