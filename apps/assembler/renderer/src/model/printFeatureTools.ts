/**
 * Interactive tools of the print features (`printFeatures.ts`): Hole,
 * Emboss, Draft, Rib and Thicken, as drafts of the generic feature tool
 * session (`featureTools.ts` delegates these kinds here), so they get the
 * same pill, badges, handles/chips, live preview, Done/Cancel and one-step
 * commit as Revolve or Offset Face. Pure data + functions; no store access.
 */
import { baseFaceKey, faceSignatureOf } from '../foundation/geometry-kernel/naming.js';
import type { Body, EvaluationResult } from '../foundation/geometry-kernel/types.js';
import {
  MIN_FEATURE_SIZE_MM,
  frameForFace,
  frameForPlane,
  framePoint,
  frameUv,
  type ExtrudeOperation,
  type FaceRef,
  type Feature,
  type Vec3,
  type PlaneRef,
  type ProfileRef,
} from '../foundation/document/document.js';
import type { SketchFeature } from '../foundation/sketch-solver/sketchFeature.js';

import { datumRef, planeRefFrame } from '../foundation/geometry-kernel/datums.js';

import {
  HOLE_PRESET_LABEL,
  MAX_DRAFT_ANGLE,
  METRIC_HOLE_SIZES,
  PRINT_FITS,
  fitDiameter,
  holePreset,
  type HoleExtent,
  type HolePlacement,
  type HolePresetKind,
  type HoleType,
  type PrintFeature,
  type PrintFitId,
  type ThickenDirection,
  type ThickenSource,
} from './printFeatures.js';
import type { SelectionItem } from '../foundation/commands/store.js';

// ---- drafts -------------------------------------------------------------------------------

/** How the hole diameter is chosen: an ISO preset, a printing fit, or typed. */
export type HoleSizing = HolePresetKind | `fit:${PrintFitId}` | 'custom';

export interface HoleDraft {
  kind: 'hole';
  face: FaceRef | null;
  placements: HolePlacement[];
  holeType: HoleType;
  extent: HoleExtent;
  diameter: number;
  counterboreDiameter?: number;
  counterboreDepth?: number;
  countersinkDiameter?: number;
  countersinkAngle?: number;
  /** Standard size (`"M3"`) the presets refer to. */
  size: string;
  sizing: HoleSizing;
  /** Cosmetic thread label on/off (label = `size`). */
  cosmeticThread: boolean;
}

export type PrintDraft =
  | HoleDraft
  | { kind: 'emboss'; profile: ProfileRef | null; face: FaceRef | null; depth: number }
  | { kind: 'draft'; faces: FaceRef[]; neutral: PlaneRef; angle: number; flip: boolean }
  | {
      kind: 'rib';
      sketchId: string | null;
      entityIds: string[];
      thickness: number;
      flip: boolean;
      targetBodyId?: string;
    }
  | {
      kind: 'thicken';
      source: ThickenSource | null;
      thickness: number;
      direction: ThickenDirection;
      operation: ExtrudeOperation;
      targetBodyId?: string;
    };

export type PrintDraftKind = PrintDraft['kind'];

export const PRINT_DRAFT_KINDS: readonly PrintDraftKind[] = [
  'hole',
  'emboss',
  'draft',
  'rib',
  'thicken',
];

export function isPrintDraftKind(kind: string): kind is PrintDraftKind {
  return (PRINT_DRAFT_KINDS as readonly string[]).includes(kind);
}

export interface PrintDraftContext {
  selection: readonly SelectionItem[];
  evaluation: EvaluationResult;
  features: readonly Feature[];
}

export type PrintDraftStart = { ok: true; draft: PrintDraft } | { ok: false; reason: string };

export const DEFAULT_HOLE_SIZE = 'M3';
export const DEFAULT_EMBOSS_DEPTH_MM = 1;
export const DEFAULT_DRAFT_ANGLE = 3;
export const DEFAULT_RIB_THICKNESS_MM = 2;
export const DEFAULT_THICKEN_MM = 2;

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

function faceRefOf(evaluation: EvaluationResult, bodyId: string, key: string): FaceRef | null {
  const body = bodyOf(evaluation, bodyId);
  const face = body ? faceOf(body, key) : undefined;
  return face ? { bodyId, key: face.key, signature: faceSignatureOf(face) } : null;
}

function selectedFaces(ctx: PrintDraftContext): FaceRef[] {
  return ctx.selection
    .filter((s): s is Extract<SelectionItem, { kind: 'face' }> => s.kind === 'face')
    .map((s) => faceRefOf(ctx.evaluation, s.bodyId, s.faceKey))
    .filter((f): f is FaceRef => f !== null);
}

/** Sketch feature ids in the selection (profiles, or a sketch's History card). */
function selectedSketchIds(ctx: PrintDraftContext): string[] {
  const out: string[] = [];
  for (const s of ctx.selection) {
    const id = s.kind === 'sketchProfile' || s.kind === 'feature' ? s.featureId : null;
    if (id && !out.includes(id) && sketchFeatureOf(ctx.features, id)) out.push(id);
  }
  return out;
}

function sketchFeatureOf(features: readonly Feature[], id: string): SketchFeature | undefined {
  const f = features.find((x) => x.id === id);
  return f?.kind === 'sketch' ? f : undefined;
}

const isPlanar = (ref: FaceRef) =>
  ref.signature.surface === 'plane' && ref.signature.normal !== null;

/** Hole centres a sketch offers: circle and arc centres, and free points (not curve vertices). */
export function sketchHolePoints(sketch: SketchFeature): HolePlacement[] {
  const used = new Set<string>();
  const out: HolePlacement[] = [];
  for (const e of sketch.entities) {
    if (e.kind === 'line') {
      used.add(e.a);
      used.add(e.b);
    } else if (e.kind === 'arc') {
      used.add(e.start);
      used.add(e.end);
    }
  }
  for (const e of sketch.entities) {
    if (e.construction) continue;
    if (e.kind === 'circle') {
      out.push({ kind: 'sketchPoint', featureId: sketch.id, entityId: e.id });
      used.add(e.center);
    }
  }
  for (const e of sketch.entities) {
    if (e.kind === 'point' && !used.has(e.id) && !e.construction) {
      // Point entities that are no curve vertex and no circle centre.
      const isCentre = sketch.entities.some(
        (c) => (c.kind === 'circle' || c.kind === 'arc') && c.center === e.id,
      );
      if (!isCentre) out.push({ kind: 'sketchPoint', featureId: sketch.id, entityId: e.id });
    }
  }
  return out;
}

/** World position of a hole placement (for handles and guides), or null. */
export function placementWorld(
  evaluation: EvaluationResult,
  features: readonly Feature[],
  face: FaceRef,
  placement: HolePlacement,
): Vec3 | null {
  const body = bodyOf(evaluation, face.bodyId);
  const f = body ? faceOf(body, face.key) : undefined;
  const normal = f?.normal ?? face.signature.normal;
  const centroid = f?.centroid ?? face.signature.centroid;
  if (!normal) return null;
  if (placement.kind === 'point') {
    return framePoint(frameForFace(normal, centroid), placement.u, placement.v);
  }
  const sketch = sketchFeatureOf(features, placement.featureId);
  const evaluated = evaluation.sketches.find((s) => s.featureId === placement.featureId);
  if (!sketch || !evaluated) return null;
  const entity = sketch.entities.find((e) => e.id === placement.entityId);
  const pointId =
    entity?.kind === 'circle' || entity?.kind === 'arc' ? entity.center : placement.entityId;
  const point = sketch.entities.find((e) => e.id === pointId);
  if (point?.kind !== 'point') return null;
  const world = framePoint(evaluated.frame, point.x, point.y);
  const d = dot(normal, sub(world, centroid));
  return sub(world, scale(normal, d));
}

// ---- hole sizing --------------------------------------------------------------------------

/** Applies the size/sizing presets to the draft's diameters (custom keeps the typed values). */
export function applyHoleSizing(draft: HoleDraft): HoleDraft {
  if (draft.sizing === 'custom') return draft;
  const size = METRIC_HOLE_SIZES.find((s) => s.thread === draft.size);
  if (!size) return draft;
  const nominal = Number(draft.size.slice(1));
  const preset = holePreset(
    draft.size,
    draft.sizing.startsWith('fit:') ? 'clearanceNormal' : (draft.sizing as HolePresetKind),
    draft.holeType,
  )!;
  const diameter = draft.sizing.startsWith('fit:')
    ? fitDiameter(nominal, draft.sizing.slice(4) as PrintFitId)
    : preset.diameter;
  const next: HoleDraft = { ...draft, diameter };
  delete next.counterboreDiameter;
  delete next.counterboreDepth;
  delete next.countersinkDiameter;
  delete next.countersinkAngle;
  if (draft.holeType === 'counterbore') {
    next.counterboreDiameter = Math.max(preset.counterboreDiameter ?? 0, diameter + 1);
    next.counterboreDepth = preset.counterboreDepth ?? 3;
  }
  if (draft.holeType === 'countersink') {
    next.countersinkDiameter = Math.max(preset.countersinkDiameter ?? 0, diameter + 1);
    next.countersinkAngle = preset.countersinkAngle ?? 90;
  }
  return next;
}

export function holeSizingLabel(draft: Pick<HoleDraft, 'size' | 'sizing'>): string {
  if (draft.sizing === 'custom') return 'custom size';
  if (draft.sizing.startsWith('fit:')) {
    const fit = PRINT_FITS.find((f) => `fit:${f.id}` === draft.sizing);
    return `${draft.size.slice(1)} mm pin, ${fit?.label.toLowerCase() ?? 'fit'} (printed)`;
  }
  return `${draft.size} ${HOLE_PRESET_LABEL[draft.sizing as HolePresetKind]}`;
}

// ---- starting a tool -------------------------------------------------------------------------

export function createPrintDraft(kind: PrintDraftKind, ctx: PrintDraftContext): PrintDraftStart {
  switch (kind) {
    case 'hole': {
      const faces = selectedFaces(ctx).filter(isPlanar);
      const sketchIds = selectedSketchIds(ctx);
      let face: FaceRef | null = faces[0] ?? null;
      const placements: HolePlacement[] = [];
      for (const id of sketchIds) {
        const sketch = sketchFeatureOf(ctx.features, id)!;
        placements.push(...sketchHolePoints(sketch));
        if (!face && sketch.plane.kind === 'face') face = sketch.plane.face;
      }
      if (!face) {
        return {
          ok: false,
          reason:
            'Select a planar face (then click to place holes), or a sketch with points on a face.',
        };
      }
      if (placements.length === 0) {
        const body = bodyOf(ctx.evaluation, face.bodyId);
        const f = body ? faceOf(body, face.key) : undefined;
        const normal = f?.normal ?? face.signature.normal!;
        const centroid = f?.centroid ?? face.signature.centroid;
        const uv = frameUv(frameForFace(normal, centroid), centroid);
        placements.push({ kind: 'point', u: round(uv.u), v: round(uv.v) });
      }
      const draft: HoleDraft = {
        kind: 'hole',
        face,
        placements,
        holeType: 'simple',
        extent: { kind: 'through' },
        diameter: 3.4,
        size: DEFAULT_HOLE_SIZE,
        sizing: 'clearanceNormal',
        cosmeticThread: false,
      };
      return { ok: true, draft: applyHoleSizing(draft) };
    }
    case 'emboss': {
      const sketchIds = selectedSketchIds(ctx);
      const profileItem = ctx.selection.find(
        (s): s is Extract<SelectionItem, { kind: 'sketchProfile' }> => s.kind === 'sketchProfile',
      );
      const sketchId = profileItem?.featureId ?? sketchIds[0];
      if (!sketchId)
        return { ok: false, reason: 'Select the sketch profiles to emboss, then a face.' };
      const profile: ProfileRef = {
        kind: 'sketch',
        featureId: sketchId,
        ...(profileItem?.regionKey !== undefined ? { regions: [profileItem.regionKey] } : {}),
      };
      const sketch = sketchFeatureOf(ctx.features, sketchId);
      const face =
        selectedFaces(ctx).find(
          (f) => f.signature.surface === 'plane' || f.signature.surface === 'cylinder',
        ) ?? (sketch?.plane.kind === 'face' ? sketch.plane.face : null);
      return { ok: true, draft: { kind: 'emboss', profile, face, depth: DEFAULT_EMBOSS_DEPTH_MM } };
    }
    case 'draft': {
      const faces = selectedFaces(ctx);
      if (faces.length === 0) return { ok: false, reason: 'Select the side faces to draft.' };
      if (faces.some((f) => f.bodyId !== faces[0]!.bodyId)) {
        return { ok: false, reason: 'All faces must belong to one body.' };
      }
      const body = bodyOf(ctx.evaluation, faces[0]!.bodyId);
      const neutral: PlaneRef = { kind: 'plane', plane: 'XY', offset: round(body?.min[2] ?? 0) };
      const sides = faces.filter(
        (f) => !f.signature.normal || Math.abs(f.signature.normal[2]) < 1 - 1e-6,
      );
      if (sides.length === 0) {
        return { ok: false, reason: 'Select side faces (not the top or bottom) to draft.' };
      }
      return {
        ok: true,
        draft: { kind: 'draft', faces: sides, neutral, angle: DEFAULT_DRAFT_ANGLE, flip: false },
      };
    }
    case 'rib': {
      const sketchId = selectedSketchIds(ctx).find(
        (id) => sketchLines(ctx.features, id).length > 0,
      );
      const anyLines = ctx.features.some(
        (f) => f.kind === 'sketch' && sketchLines(ctx.features, f.id).length > 0,
      );
      if (!sketchId && !anyLines)
        return { ok: false, reason: 'Draw the rib line in a sketch first.' };
      if (ctx.evaluation.bodies.length === 0)
        return { ok: false, reason: 'A rib needs a body to attach to.' };
      // The body to join: a selected one, else the most recently created (explicit, so it stays put).
      const picked = ctx.selection.find((s) => s.kind === 'body' || s.kind === 'face');
      const targetBodyId =
        picked && (picked.kind === 'body' || picked.kind === 'face')
          ? picked.bodyId
          : ctx.evaluation.bodies[ctx.evaluation.bodies.length - 1]!.id;
      return {
        ok: true,
        draft: {
          kind: 'rib',
          sketchId: sketchId ?? null,
          entityIds: sketchId ? sketchLines(ctx.features, sketchId) : [],
          thickness: DEFAULT_RIB_THICKNESS_MM,
          flip: false,
          targetBodyId,
        },
      };
    }
    case 'thicken': {
      const faces = selectedFaces(ctx);
      const sketchIds = selectedSketchIds(ctx);
      if (faces.length > 0) {
        if (faces.some((f) => f.bodyId !== faces[0]!.bodyId)) {
          return { ok: false, reason: 'All faces must belong to one body.' };
        }
        return {
          ok: true,
          draft: {
            kind: 'thicken',
            source: { kind: 'faces', faces },
            thickness: DEFAULT_THICKEN_MM,
            direction: 'outside',
            operation: 'new',
          },
        };
      }
      const profileItem = ctx.selection.find(
        (s): s is Extract<SelectionItem, { kind: 'sketchProfile' }> => s.kind === 'sketchProfile',
      );
      const sketchId = profileItem?.featureId ?? sketchIds[0];
      if (!sketchId) return { ok: false, reason: 'Select faces or a sketch profile to thicken.' };
      return {
        ok: true,
        draft: {
          kind: 'thicken',
          source: {
            kind: 'profile',
            profile: {
              kind: 'sketch',
              featureId: sketchId,
              ...(profileItem?.regionKey !== undefined ? { regions: [profileItem.regionKey] } : {}),
            },
          },
          thickness: DEFAULT_THICKEN_MM,
          direction: 'outside',
          operation: 'new',
        },
      };
    }
  }
}

/** Non-construction straight lines of a sketch (rib candidates). */
function sketchLines(features: readonly Feature[], sketchId: string): string[] {
  const sketch = sketchFeatureOf(features, sketchId);
  return sketch
    ? sketch.entities.filter((e) => e.kind === 'line' && !e.construction).map((e) => e.id)
    : [];
}

// ---- picks while the tool runs ----------------------------------------------------------------

export type PrintToolPick =
  | { kind: 'body'; bodyId: string }
  | {
      kind: 'face';
      bodyId: string;
      faceKey: string;
      point?: Vec3;
      ray?: { origin: Vec3; direction: Vec3 };
    }
  | { kind: 'edge'; bodyId: string; edgeKey: string; ray?: { origin: Vec3; direction: Vec3 } }
  | { kind: 'sketchProfile'; featureId: string; regionKey?: string }
  | { kind: 'sketchLine'; featureId: string; entityId: string }
  | { kind: 'datum'; featureId: string };

/** Placement within this distance (mm) of a click is removed instead of adding a new one. */
const REMOVE_RADIUS_MM = 1.5;

export function acceptPrintPick(
  draft: PrintDraft,
  pick: PrintToolPick,
  evaluation: EvaluationResult,
  features: readonly Feature[] = [],
): PrintDraft {
  const faceRef = pick.kind === 'face' ? faceRefOf(evaluation, pick.bodyId, pick.faceKey) : null;
  switch (draft.kind) {
    case 'hole': {
      if (pick.kind === 'sketchProfile') {
        const sketch = sketchFeatureOf(features, pick.featureId);
        if (!sketch) return draft;
        const points = sketchHolePoints(sketch);
        if (points.length === 0) return draft;
        const face = draft.face ?? (sketch.plane.kind === 'face' ? sketch.plane.face : null);
        return { ...draft, face, placements: points };
      }
      if (pick.kind !== 'face') return draft;
      // A click on (or into) one of the holes removes it (keeping one): the pointer ray is
      // intersected with the hole face's plane, whatever it hit (the preview's hole wall, or nothing).
      const current = draft.face ? faceFrameOf(evaluation, draft.face) : null;
      if (draft.face && current && pick.bodyId === draft.face.bodyId) {
        const onPlane = pick.ray ? rayPlane(pick.ray, current.point, current.normal) : pick.point;
        if (onPlane) {
          const near = draft.placements.findIndex((p) => {
            const w = placementWorld(evaluation, features, draft.face!, p);
            const reach = Math.max(REMOVE_RADIUS_MM, holeOuterDiameter(draft) / 2);
            return w !== null && Math.hypot(...sub(w, onPlane)) < reach;
          });
          if (near >= 0) {
            if (draft.placements.length === 1) return draft;
            return { ...draft, placements: draft.placements.filter((_, i) => i !== near) };
          }
        }
      }
      if (!faceRef || !isPlanar(faceRef)) return draft;
      const frame = faceFrameOf(evaluation, faceRef);
      if (!frame) return draft;
      const point =
        (pick.ray ? rayPlane(pick.ray, frame.point, frame.normal) : null) ??
        pick.point ??
        frame.point;
      const uv = frameUv(frameForFace(frame.normal, frame.point), point);
      const placement: HolePlacement = { kind: 'point', u: round(uv.u), v: round(uv.v) };
      if (!draft.face || draft.face.bodyId !== faceRef.bodyId || draft.face.key !== faceRef.key) {
        // Another face: start over there.
        return { ...draft, face: faceRef, placements: [placement] };
      }
      return { ...draft, placements: [...draft.placements, placement] };
    }
    case 'emboss':
      if (pick.kind === 'sketchProfile') {
        return {
          ...draft,
          profile: {
            kind: 'sketch',
            featureId: pick.featureId,
            ...(pick.regionKey !== undefined ? { regions: [pick.regionKey] } : {}),
          },
        };
      }
      if (
        faceRef &&
        (faceRef.signature.surface === 'plane' || faceRef.signature.surface === 'cylinder')
      ) {
        return { ...draft, face: faceRef };
      }
      return draft;
    case 'draft': {
      if (pick.kind === 'datum') {
        // A construction plane becomes the neutral plane.
        const ref = datumRef(evaluation, pick.featureId);
        return ref && 'frame' in ref ? { ...draft, neutral: ref } : draft;
      }
      if (!faceRef) return draft;
      if (draft.faces[0] && faceRef.bodyId !== draft.faces[0].bodyId) return draft;
      const pull = neutralNormal(evaluation, draft.neutral);
      const n = faceRef.signature.normal;
      // A face parallel to the neutral plane becomes the neutral plane.
      if (n && pull && Math.abs(dot(n, pull)) > 1 - 1e-6) {
        return { ...draft, neutral: { kind: 'face', face: faceRef } };
      }
      const present = draft.faces.some((f) => f.key === faceRef.key);
      if (present && draft.faces.length === 1) return draft;
      return {
        ...draft,
        faces: present
          ? draft.faces.filter((f) => f.key !== faceRef.key)
          : [...draft.faces, faceRef],
      };
    }
    case 'rib': {
      if (pick.kind !== 'sketchLine') return draft;
      if (draft.sketchId !== pick.featureId) {
        return { ...draft, sketchId: pick.featureId, entityIds: [pick.entityId] };
      }
      const present = draft.entityIds.includes(pick.entityId);
      if (present && draft.entityIds.length === 1) return draft;
      return {
        ...draft,
        entityIds: present
          ? draft.entityIds.filter((id) => id !== pick.entityId)
          : [...draft.entityIds, pick.entityId],
      };
    }
    case 'thicken': {
      if (pick.kind === 'sketchProfile') {
        return {
          ...draft,
          source: {
            kind: 'profile',
            profile: {
              kind: 'sketch',
              featureId: pick.featureId,
              ...(pick.regionKey !== undefined ? { regions: [pick.regionKey] } : {}),
            },
          },
        };
      }
      if (!faceRef) return draft;
      const faces = draft.source?.kind === 'faces' ? draft.source.faces : [];
      if (faces[0] && faces[0].bodyId !== faceRef.bodyId) return draft;
      const present = faces.some((f) => f.key === faceRef.key);
      if (present && faces.length === 1) return draft;
      const next = present ? faces.filter((f) => f.key !== faceRef.key) : [...faces, faceRef];
      return { ...draft, source: { kind: 'faces', faces: next } };
    }
  }
}

/** Where a ray meets the plane through `point` with `normal`, or null when parallel. */
function rayPlane(ray: { origin: Vec3; direction: Vec3 }, point: Vec3, normal: Vec3): Vec3 | null {
  const denom = dot(normal, ray.direction);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dot(normal, sub(point, ray.origin)) / denom;
  return add(ray.origin, scale(ray.direction, t));
}

/** Largest diameter of a hole at the face (counterbore/countersink included). */
function holeOuterDiameter(draft: HoleDraft): number {
  if (draft.holeType === 'counterbore') return draft.counterboreDiameter ?? draft.diameter;
  if (draft.holeType === 'countersink') return draft.countersinkDiameter ?? draft.diameter;
  return draft.diameter;
}

function neutralNormal(evaluation: EvaluationResult, plane: PlaneRef): Vec3 | null {
  if (plane.kind === 'plane') return frameForPlane(plane.plane, plane.offset).normal;
  if (plane.kind === 'construction') return planeRefFrame(plane, evaluation)?.normal ?? null;
  const body = bodyOf(evaluation, plane.face.bodyId);
  return (body ? faceOf(body, plane.face.key)?.normal : null) ?? plane.face.signature.normal;
}

// ---- feature -------------------------------------------------------------------------------

export function printDraftToFeature(
  draft: PrintDraft,
  base: { id: string; name: string },
): PrintFeature | null {
  const common = { id: base.id, name: base.name, suppressed: false };
  switch (draft.kind) {
    case 'hole': {
      if (!draft.face || draft.placements.length === 0) return null;
      const preset = draft.sizing === 'custom' ? undefined : holeSizingLabel(draft);
      return {
        ...common,
        kind: 'hole',
        face: draft.face,
        placements: draft.placements,
        holeType: draft.holeType,
        diameter: draft.diameter,
        extent: draft.extent,
        ...(draft.holeType === 'counterbore'
          ? {
              counterboreDiameter: draft.counterboreDiameter ?? draft.diameter * 1.8,
              counterboreDepth: draft.counterboreDepth ?? draft.diameter,
            }
          : {}),
        ...(draft.holeType === 'countersink'
          ? {
              countersinkDiameter: draft.countersinkDiameter ?? draft.diameter * 1.8,
              countersinkAngle: draft.countersinkAngle ?? 90,
            }
          : {}),
        ...(draft.cosmeticThread ? { thread: draft.size } : {}),
        ...(preset ? { preset } : {}),
      };
    }
    case 'emboss':
      if (!draft.profile || !draft.face) return null;
      return {
        ...common,
        kind: 'emboss',
        profile: draft.profile,
        face: draft.face,
        depth: draft.depth,
      };
    case 'draft':
      if (draft.faces.length === 0) return null;
      return {
        ...common,
        kind: 'draft',
        faces: draft.faces,
        neutral: draft.neutral,
        angle: draft.angle,
        flip: draft.flip,
      };
    case 'rib':
      if (!draft.sketchId || draft.entityIds.length === 0) return null;
      return {
        ...common,
        kind: 'rib',
        sketchId: draft.sketchId,
        entityIds: draft.entityIds,
        thickness: draft.thickness,
        flip: draft.flip,
        ...(draft.targetBodyId !== undefined ? { targetBodyId: draft.targetBodyId } : {}),
      };
    case 'thicken':
      if (!draft.source) return null;
      return {
        ...common,
        kind: 'thicken',
        source: draft.source,
        thickness: draft.thickness,
        direction: draft.direction,
        operation: draft.operation,
        ...(draft.operation !== 'new' && draft.targetBodyId !== undefined
          ? { targetBodyId: draft.targetBodyId }
          : {}),
      };
  }
}

// ---- pill -------------------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function printDraftMeta(draft: PrintDraft): {
  label: string;
  shortcut: string;
  prompt: string;
} {
  switch (draft.kind) {
    case 'hole':
      return {
        label: 'Hole',
        shortcut: '',
        prompt: draft.face
          ? `${plural(draft.placements.length, 'hole')}, ${holeSizingLabel(draft)} Ø${fmt(draft.diameter)}. Click the face to add a hole, click a hole to remove it.`
          : 'Click a planar face to place a hole.',
      };
    case 'emboss':
      return {
        label: draft.depth < 0 ? 'Engrave' : 'Emboss',
        shortcut: '',
        prompt: !draft.face
          ? 'Click the target face (planar, or a cylinder to wrap around).'
          : 'Drag the arrow or type a depth. Click a planar or cylindrical face to change the target.',
      };
    case 'draft':
      return {
        label: 'Draft',
        shortcut: '',
        prompt: `${plural(draft.faces.length, 'face')}. Type an angle; click faces to add or remove, a flat face to set the neutral plane.`,
      };
    case 'rib':
      return {
        label: 'Rib',
        shortcut: '',
        prompt:
          draft.entityIds.length === 0
            ? 'Click the sketch line of the rib.'
            : `${plural(draft.entityIds.length, 'line')}. Type a thickness; click sketch lines to add or remove.`,
      };
    case 'thicken':
      return {
        label: 'Thicken',
        shortcut: '',
        prompt:
          draft.source?.kind === 'faces'
            ? `${plural(draft.source.faces.length, 'face')}. Drag the arrow or type a thickness; click faces to add or remove.`
            : 'Drag the arrow or type a thickness. Click faces to thicken body faces instead.',
      };
  }
}

export interface PrintDraftBadge {
  ariaLabel: string;
  value: string;
  options: { value: string; label: string }[];
  apply: (draft: PrintDraft, value: string, evaluation: EvaluationResult) => PrintDraft;
}

function holeBadge(
  ariaLabel: string,
  value: string,
  options: { value: string; label: string }[],
  update: (d: HoleDraft, value: string) => HoleDraft,
): PrintDraftBadge {
  return {
    ariaLabel,
    value,
    options,
    apply: (d, v) => (d.kind === 'hole' ? update(d, v) : d),
  };
}

export function printDraftBadges(draft: PrintDraft): PrintDraftBadge[] {
  switch (draft.kind) {
    case 'hole':
      return [
        holeBadge(
          'Hole type',
          draft.holeType,
          [
            { value: 'simple', label: 'Simple' },
            { value: 'counterbore', label: 'Counterbore' },
            { value: 'countersink', label: 'Countersink' },
          ],
          (d, v) => applyHoleSizing({ ...d, holeType: v as HoleType }),
        ),
        holeBadge(
          'Hole depth',
          draft.extent.kind,
          [
            { value: 'through', label: 'Through all' },
            { value: 'blind', label: 'Blind' },
          ],
          (d, v) => ({
            ...d,
            extent:
              v === 'through'
                ? { kind: 'through' }
                : { kind: 'blind', depth: Math.max(5, d.diameter * 2) },
          }),
        ),
        holeBadge(
          'Hole size',
          draft.sizing === 'custom' ? 'custom' : draft.size,
          [
            ...METRIC_HOLE_SIZES.map((s) => ({ value: s.thread, label: s.thread })),
            { value: 'custom', label: 'Custom' },
          ],
          (d, v) =>
            v === 'custom'
              ? { ...d, sizing: 'custom' }
              : applyHoleSizing({
                  ...d,
                  size: v,
                  sizing: d.sizing === 'custom' ? 'clearanceNormal' : d.sizing,
                }),
        ),
        holeBadge(
          'Hole fit',
          draft.sizing,
          [
            { value: 'clearanceFine', label: 'Clearance, close (ISO 273)' },
            { value: 'clearanceNormal', label: 'Clearance, normal (ISO 273)' },
            { value: 'clearanceCoarse', label: 'Clearance, loose (ISO 273)' },
            { value: 'tapDrill', label: 'Tap drill' },
            ...PRINT_FITS.map((f) => ({
              value: `fit:${f.id}`,
              label: `Printed ${f.label.toLowerCase()} (+${fmt(f.allowance)})`,
            })),
            { value: 'custom', label: 'Custom' },
          ],
          (d, v) => applyHoleSizing({ ...d, sizing: v as HoleSizing }),
        ),
        holeBadge(
          'Cosmetic thread',
          draft.cosmeticThread ? 'on' : 'off',
          [
            { value: 'off', label: 'No thread' },
            { value: 'on', label: `${draft.size} thread (cosmetic)` },
          ],
          (d, v) => ({ ...d, cosmeticThread: v === 'on' }),
        ),
      ];
    case 'emboss':
      return [
        {
          ariaLabel: 'Emboss or engrave',
          value: draft.depth < 0 ? 'engrave' : 'emboss',
          options: [
            { value: 'emboss', label: 'Emboss' },
            { value: 'engrave', label: 'Engrave' },
          ],
          apply: (d, v) =>
            d.kind === 'emboss'
              ? { ...d, depth: (v === 'engrave' ? -1 : 1) * Math.abs(d.depth) }
              : d,
        },
      ];
    case 'draft':
      return [
        {
          ariaLabel: 'Pull direction',
          value: draft.flip ? 'flip' : 'normal',
          options: [
            { value: 'normal', label: 'Narrower away from neutral' },
            { value: 'flip', label: 'Reversed' },
          ],
          apply: (d, v) => (d.kind === 'draft' ? { ...d, flip: v === 'flip' } : d),
        },
      ];
    case 'rib':
      return [
        {
          ariaLabel: 'Rib side',
          value: draft.flip ? 'flip' : 'body',
          options: [
            { value: 'body', label: 'Towards the body' },
            { value: 'flip', label: 'Other side' },
          ],
          apply: (d, v) => (d.kind === 'rib' ? { ...d, flip: v === 'flip' } : d),
        },
      ];
    case 'thicken':
      return [
        {
          ariaLabel: 'Thicken direction',
          value: draft.direction,
          options: [
            { value: 'outside', label: 'Outside' },
            { value: 'inside', label: 'Inside' },
            { value: 'both', label: 'Both sides' },
          ],
          apply: (d, v) => (d.kind === 'thicken' ? { ...d, direction: v as ThickenDirection } : d),
        },
        {
          ariaLabel: 'Operation',
          value: draft.operation,
          options: [
            { value: 'new', label: 'New body' },
            { value: 'join', label: 'Join' },
            { value: 'cut', label: 'Cut' },
          ],
          apply: (d, v, evaluation) => {
            if (d.kind !== 'thicken') return d;
            const next = { ...d, operation: v as ExtrudeOperation };
            if (v === 'new') delete next.targetBodyId;
            else if (next.targetBodyId === undefined) {
              const own = d.source?.kind === 'faces' ? d.source.faces[0]?.bodyId : undefined;
              const last = evaluation.bodies[evaluation.bodies.length - 1]?.id;
              const target = own ?? last;
              if (target) next.targetBodyId = target;
            }
            return next;
          },
        },
      ];
  }
}

// ---- handles, chips, guides -------------------------------------------------------------------

export type PrintHandle =
  | {
      kind: 'linear';
      id: string;
      label: string;
      prefix?: string;
      unit: 'mm' | 'deg';
      value: number;
      base: Vec3;
      dir: Vec3;
      length: number;
      apply: (draft: PrintDraft, value: number) => PrintDraft;
    }
  | {
      kind: 'chip';
      id: string;
      label: string;
      prefix?: string;
      unit: 'mm' | 'deg' | 'count';
      value: number;
      at: Vec3;
      apply: (draft: PrintDraft, value: number) => PrintDraft;
    };

const STEM_MM = 8;

function positive(value: number, min = MIN_FEATURE_SIZE_MM): number {
  return Number.isFinite(value) ? Math.max(min, Math.abs(value)) : min;
}

function faceFrameOf(
  evaluation: EvaluationResult,
  ref: FaceRef,
): { point: Vec3; normal: Vec3 } | null {
  const body = bodyOf(evaluation, ref.bodyId);
  const face = body ? faceOf(body, ref.key) : undefined;
  if (!face) return null;
  if (face.normal) return { point: face.centroid, normal: face.normal };
  if (!body || face.triangleCount === 0) return null;
  const t = face.triangleStart + Math.floor(face.triangleCount / 2);
  const v = body.mesh.indices[t * 3]! * 3;
  return {
    point: [body.mesh.positions[v]!, body.mesh.positions[v + 1]!, body.mesh.positions[v + 2]!],
    normal: normalize([
      body.mesh.normals[v]!,
      body.mesh.normals[v + 1]!,
      body.mesh.normals[v + 2]!,
    ]),
  };
}

export function printDraftHandles(
  draft: PrintDraft,
  evaluation: EvaluationResult,
  features: readonly Feature[] = [],
): PrintHandle[] {
  switch (draft.kind) {
    case 'hole': {
      if (!draft.face || !draft.placements[0]) return [];
      const at = placementWorld(evaluation, features, draft.face, draft.placements[0]);
      const frame = faceFrameOf(evaluation, draft.face);
      if (!at || !frame) return [];
      const n = frame.normal;
      const inPlane = frameForFace(n, at);
      const side = inPlane.u;
      // Head chips (counterbore/countersink) stack on the other side of the first hole.
      const head = (diameter: number | undefined, row: number): Vec3 =>
        add(
          add(add(at, scale(n, 0.5)), scale(side, -((diameter ?? 0) / 2 + 9))),
          scale(inPlane.v, -6 * row),
        );
      const out: PrintHandle[] = [
        {
          kind: 'chip',
          id: 'diameter',
          label: 'Hole diameter',
          prefix: 'Ø',
          unit: 'mm',
          value: draft.diameter,
          at: add(add(at, scale(n, 0.5)), scale(side, draft.diameter / 2 + 8)),
          apply: (d, v) =>
            d.kind === 'hole' ? { ...d, diameter: positive(v), sizing: 'custom' } : d,
        },
      ];
      if (draft.extent.kind === 'blind') {
        out.push({
          kind: 'linear',
          id: 'depth',
          label: 'Hole depth',
          unit: 'mm',
          value: draft.extent.depth,
          base: at,
          dir: scale(n, -1),
          length: Math.max(draft.extent.depth, STEM_MM),
          apply: (d, v) =>
            d.kind === 'hole' ? { ...d, extent: { kind: 'blind', depth: positive(v) } } : d,
        });
      }
      if (draft.holeType === 'counterbore') {
        out.push({
          kind: 'chip',
          id: 'cboreDiameter',
          label: 'Counterbore diameter',
          prefix: 'CB Ø',
          unit: 'mm',
          value: draft.counterboreDiameter ?? 0,
          at: head(draft.counterboreDiameter, 0),
          apply: (d, v) =>
            d.kind === 'hole' ? { ...d, counterboreDiameter: positive(v), sizing: 'custom' } : d,
        });
        out.push({
          kind: 'chip',
          id: 'cboreDepth',
          label: 'Counterbore depth',
          prefix: 'CB depth',
          unit: 'mm',
          value: draft.counterboreDepth ?? 0,
          at: head(draft.counterboreDiameter, 1),
          apply: (d, v) =>
            d.kind === 'hole' ? { ...d, counterboreDepth: positive(v), sizing: 'custom' } : d,
        });
      }
      if (draft.holeType === 'countersink') {
        out.push({
          kind: 'chip',
          id: 'csinkDiameter',
          label: 'Countersink diameter',
          prefix: 'CS Ø',
          unit: 'mm',
          value: draft.countersinkDiameter ?? 0,
          at: head(draft.countersinkDiameter, 0),
          apply: (d, v) =>
            d.kind === 'hole' ? { ...d, countersinkDiameter: positive(v), sizing: 'custom' } : d,
        });
        out.push({
          kind: 'chip',
          id: 'csinkAngle',
          label: 'Countersink angle',
          prefix: 'CS',
          unit: 'deg',
          value: draft.countersinkAngle ?? 90,
          at: head(draft.countersinkDiameter, 1),
          apply: (d, v) =>
            d.kind === 'hole' ? { ...d, countersinkAngle: Math.min(150, Math.max(30, v)) } : d,
        });
      }
      return out;
    }
    case 'emboss': {
      if (!draft.face) return [];
      const frame = faceFrameOf(evaluation, draft.face);
      const centre = profileCentre(evaluation, draft.profile);
      if (!frame) return [];
      const base = centre ?? frame.point;
      return [
        {
          kind: 'linear',
          id: 'depth',
          label: draft.depth < 0 ? 'Engrave depth' : 'Emboss height',
          unit: 'mm',
          value: draft.depth,
          base,
          dir: frame.normal,
          length: STEM_MM + Math.max(0, draft.depth),
          apply: (d, v) =>
            d.kind === 'emboss'
              ? { ...d, depth: Math.abs(v) < MIN_FEATURE_SIZE_MM / 2 ? (v < 0 ? -0.05 : 0.05) : v }
              : d,
        },
      ];
    }
    case 'draft': {
      const first = draft.faces[0];
      const frame = first ? faceFrameOf(evaluation, first) : null;
      if (!frame) return [];
      return [
        {
          kind: 'chip',
          id: 'angle',
          label: 'Draft angle',
          unit: 'deg',
          value: draft.angle,
          at: add(frame.point, scale(frame.normal, 6)),
          apply: (d, v) =>
            d.kind === 'draft'
              ? {
                  ...d,
                  angle: Math.sign(v || 1) * Math.min(MAX_DRAFT_ANGLE, Math.max(0.1, Math.abs(v))),
                }
              : d,
        },
      ];
    }
    case 'rib': {
      const mid = ribMidpoint(evaluation, draft);
      if (!mid) return [];
      return [
        {
          kind: 'chip',
          id: 'thickness',
          label: 'Rib thickness',
          unit: 'mm',
          value: draft.thickness,
          at: add(mid.point, scale(mid.normal, 4)),
          apply: (d, v) => (d.kind === 'rib' ? { ...d, thickness: positive(v) } : d),
        },
      ];
    }
    case 'thicken': {
      let frame: { point: Vec3; normal: Vec3 } | null = null;
      if (draft.source?.kind === 'faces' && draft.source.faces[0]) {
        frame = faceFrameOf(evaluation, draft.source.faces[0]);
      } else if (draft.source?.kind === 'profile') {
        const centre = profileCentre(evaluation, draft.source.profile);
        const sketch =
          draft.source.profile.kind === 'sketch'
            ? evaluation.sketches.find(
                (s) =>
                  s.featureId ===
                  (draft.source as { profile: { featureId: string } }).profile.featureId,
              )
            : undefined;
        if (centre && sketch) frame = { point: centre, normal: sketch.frame.normal };
      }
      if (!frame) return [];
      const along = draft.direction === 'inside' ? scale(frame.normal, -1) : frame.normal;
      return [
        {
          kind: 'linear',
          id: 'thickness',
          label: 'Thickness',
          unit: 'mm',
          value: draft.thickness,
          base: frame.point,
          dir: along,
          length: STEM_MM + draft.thickness,
          apply: (d, v) =>
            d.kind === 'thicken' ? { ...d, thickness: positive(v, MIN_FEATURE_SIZE_MM / 10) } : d,
        },
      ];
    }
  }
}

function profileCentre(evaluation: EvaluationResult, profile: ProfileRef | null): Vec3 | null {
  if (!profile || profile.kind !== 'sketch') return null;
  const sketch = evaluation.sketches.find((s) => s.featureId === profile.featureId);
  if (!sketch) return null;
  const regions = profile.regions;
  const profiles = regions
    ? sketch.profiles.filter((p) => regions.includes(p.key))
    : sketch.profiles;
  if (profiles.length === 0) return null;
  const c: Vec3 = [0, 0, 0];
  for (const p of profiles) for (let i = 0; i < 3; i += 1) c[i]! += p.center[i]! / profiles.length;
  return c;
}

function ribMidpoint(
  evaluation: EvaluationResult,
  draft: Extract<PrintDraft, { kind: 'rib' }>,
): { point: Vec3; normal: Vec3 } | null {
  const sketch = evaluation.sketches.find((s) => s.featureId === draft.sketchId);
  const curve = sketch?.curves.find((c) => c.entityId === draft.entityIds[0]);
  if (!sketch || !curve || curve.points.length < 2) return null;
  const a = curve.points[0]!;
  const b = curve.points[curve.points.length - 1]!;
  return { point: scale(add(a, b), 0.5), normal: sketch.frame.normal };
}

/** Crosshairs at the hole placements (visible before the kernel preview arrives). */
export function printDraftGuides(
  draft: PrintDraft,
  evaluation: EvaluationResult,
  features: readonly Feature[] = [],
): { lines: [Vec3, Vec3][]; planes: [Vec3, Vec3, Vec3, Vec3][] } {
  const out: { lines: [Vec3, Vec3][]; planes: [Vec3, Vec3, Vec3, Vec3][] } = {
    lines: [],
    planes: [],
  };
  if (draft.kind === 'hole' && draft.face) {
    const frame = faceFrameOf(evaluation, draft.face);
    if (!frame) return out;
    const f = frameForFace(frame.normal, frame.point);
    const r = draft.diameter / 2 + 1.5;
    for (const p of draft.placements) {
      const at = placementWorld(evaluation, features, draft.face, p);
      if (!at) continue;
      out.lines.push([sub(at, scale(f.u, r)), add(at, scale(f.u, r))]);
      out.lines.push([sub(at, scale(f.v, r)), add(at, scale(f.v, r))]);
    }
  }
  if (draft.kind === 'draft' && draft.neutral.kind === 'plane') {
    const ids = draft.faces[0] ? [draft.faces[0].bodyId] : [];
    const bodies = evaluation.bodies.filter((b) => ids.includes(b.id));
    const body = bodies[0];
    if (body) {
      const plane = frameForPlane(draft.neutral.plane, draft.neutral.offset);
      const centre = scale(add(body.min, body.max), 0.5);
      const onPlane = sub(
        centre,
        scale(plane.normal, dot(sub(centre, plane.origin), plane.normal)),
      );
      const half = Math.max(10, Math.hypot(...sub(body.max, body.min)) * 0.65);
      const c = (a: number, b: number): Vec3 =>
        add(onPlane, add(scale(plane.u, a * half), scale(plane.v, b * half)));
      out.planes.push([c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)]);
    }
  }
  return out;
}

export function printDraftModifiedBodyIds(draft: PrintDraft): string[] {
  switch (draft.kind) {
    case 'hole':
    case 'emboss':
      return draft.face ? [draft.face.bodyId] : [];
    case 'draft':
      return draft.faces[0] ? [draft.faces[0].bodyId] : [];
    case 'rib':
      return draft.targetBodyId ? [draft.targetBodyId] : [];
    case 'thicken':
      return draft.operation !== 'new' && draft.targetBodyId ? [draft.targetBodyId] : [];
  }
}

/** Sketch lines are pick targets while Rib runs. */
export function printDraftPicksSketchLines(draft: PrintDraft): boolean {
  return draft.kind === 'rib';
}

// ---- vector helpers ---------------------------------------------------------------------------

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}

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

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
