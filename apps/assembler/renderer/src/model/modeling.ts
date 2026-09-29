/**
 * Pure modelling helpers shared by the store, the command registry, the
 * viewport and the chrome: Shapr3D-style automatic extrude operation,
 * "consumed" sketch visibility, section-plane defaults and quick
 * measurements. No store access, no DOM — unit tested under `node:test`.
 */
import type { Body, EvaluationResult } from '../kernel/types.js';
import {
  frameForFace,
  frameForPlane,
  framePoint,
  MIN_FEATURE_SIZE_MM,
  profileCenterUv,
  profileOutlineUv,
  type ExtrudeOperation,
  type Feature,
  type SketchFeature,
  type Vec3,
} from './document.js';
import { isModelingFeature, sketchIdsUsedBy } from './features.js';
import type { SelectionItem } from './store.js';

// ---- Automatic extrude operation --------------------------------------------------

/**
 * A body face the sketch lies on: `sign` is `+1` when the face's outward
 * normal equals the sketch normal (extruding along +normal leaves the
 * material), `-1` when it is opposite (extruding along +normal enters it).
 */
export interface SketchContact {
  bodyId: string;
  faceKey: string;
  sign: 1 | -1;
}

const PLANE_TOLERANCE_MM = 1e-4;

/**
 * Finds a planar body face the sketch's profile lies on: coplanar with the
 * sketch plane and containing at least one sample of the profile (its
 * centre or an outline point — a circle drawn around an existing hole
 * still counts). `null` for a free-standing sketch.
 */
export function findSketchContact(
  evaluation: EvaluationResult,
  sketchFeatureId: string,
  profileIndex?: number,
): SketchContact | null {
  const sketch = evaluation.sketches.find((s) => s.featureId === sketchFeatureId);
  if (!sketch) return null;
  const profiles =
    profileIndex !== undefined
      ? sketch.profiles.slice(profileIndex, profileIndex + 1)
      : sketch.profiles;
  const samples: Vec3[] = [];
  for (const profile of profiles) {
    samples.push(profile.center);
    const step = Math.max(1, Math.floor(profile.outline.length / 16));
    for (let i = 0; i < profile.outline.length; i += step) samples.push(profile.outline[i]!);
  }
  const n = sketch.frame.normal;
  const planeOffset = dot(n, sketch.frame.origin);
  for (const body of evaluation.bodies) {
    for (const face of body.faces) {
      if (face.surface !== 'plane' || !face.normal) continue;
      const alignment = dot(face.normal, n);
      if (Math.abs(Math.abs(alignment) - 1) > 1e-6) continue;
      if (Math.abs(dot(n, face.centroid) - planeOffset) > PLANE_TOLERANCE_MM) continue;
      if (!samples.some((p) => faceContainsPoint(body, body.faces.indexOf(face), p))) continue;
      return { bodyId: body.id, faceKey: face.key, sign: alignment > 0 ? 1 : -1 };
    }
  }
  return null;
}

/**
 * Shapr3D-style automatic operation: extruding a profile out of a body face
 * joins, into the body cuts, a free-standing profile makes a new body.
 */
export function autoExtrudeOperation(
  contact: SketchContact | null,
  distance: number,
): ExtrudeOperation {
  if (!contact) return 'new';
  if (distance === 0) return contact.sign > 0 ? 'join' : 'cut';
  return distance * contact.sign > 0 ? 'join' : 'cut';
}

/**
 * Start of an extrude whose closed sketch profile lies inside a body face
 * (e.g. a circle drawn on a plate): Shapr3D starts such an extrude as a
 * Cut into the body, so the preview opens as a through-cut (the material's
 * thickness under the profile along the extrude axis) instead of
 * "Join, 0 mm". Returns the signed distance, or `null` when the profile
 * is not fully inside the contact face.
 */
export function extrudeStartDepth(
  evaluation: EvaluationResult,
  features: readonly Feature[],
  sketchFeatureId: string,
  profileIndex: number | undefined,
  contact: SketchContact,
): number | null {
  const sketch = features.find(
    (f): f is SketchFeature => f.id === sketchFeatureId && f.kind === 'sketch',
  );
  const body = evaluation.bodies.find((b) => b.id === contact.bodyId);
  if (!sketch || !body) return null;
  const faceIndex = body.faces.findIndex(
    (f) => f.key === contact.faceKey || f.aliases.includes(contact.faceKey),
  );
  const face = body.faces[faceIndex];
  if (!face?.normal) return null;
  // The sketch frame as the kernel builds it (the sketch may not be evaluated yet).
  const frame =
    sketch.plane.kind === 'plane'
      ? frameForPlane(sketch.plane.plane, sketch.plane.offset)
      : frameForFace(
          sketch.plane.face.signature.normal ?? face.normal,
          sketch.plane.face.signature.centroid,
        );
  const profiles =
    profileIndex !== undefined
      ? sketch.profiles.slice(profileIndex, profileIndex + 1)
      : sketch.profiles;
  if (profiles.length === 0) return null;
  const samples: Vec3[] = [];
  for (const profile of profiles) {
    const [cu, cv] = profileCenterUv(profile);
    samples.push(framePoint(frame, cu, cv));
    for (const [u, v] of profileOutlineUv(profile, 32)) samples.push(framePoint(frame, u, v));
  }
  if (!samples.every((p) => faceContainsPoint(body, faceIndex, p))) return null;
  const into: Vec3 = [
    -frame.normal[0] * contact.sign,
    -frame.normal[1] * contact.sign,
    -frame.normal[2] * contact.sign,
  ];
  const depths = profiles.map((profile) => {
    const [cu, cv] = profileCenterUv(profile);
    return depthInsideBody(body, framePoint(frame, cu, cv), into);
  });
  if (depths.some((d) => d === null)) return null;
  const depth = Math.max(...(depths as number[]));
  if (!(depth >= MIN_FEATURE_SIZE_MM)) return null;
  return (-contact.sign * Math.round(depth * 1000)) / 1000;
}

/** `true` if `point` is inside the body's closed mesh (ray parity). */
export function pointInsideBody(body: Body, point: Vec3): boolean {
  if (point.some((v, i) => v < body.min[i]! - 1e-6 || v > body.max[i]! + 1e-6)) return false;
  const dir = normalize3([0.5773, 0.5774, 0.5775]);
  let hits = 0;
  forEachTriangle(body, (tri) => {
    const d = rayTriangle(point, dir, tri);
    if (d !== null && d > 1e-9) hits += 1;
  });
  return hits % 2 === 1;
}

/**
 * Distance a ray from `point` (on the body's surface) along `dir` travels
 * through material before it leaves the body, or `null` if it never enters.
 */
export function depthInsideBody(body: Body, point: Vec3, dir: Vec3): number | null {
  const start: Vec3 = [
    point[0] + dir[0] * 1e-4,
    point[1] + dir[1] * 1e-4,
    point[2] + dir[2] * 1e-4,
  ];
  let nearest = Infinity;
  forEachTriangle(body, (tri) => {
    const d = rayTriangle(start, dir, tri);
    if (d !== null && d > 1e-6) nearest = Math.min(nearest, d);
  });
  return Number.isFinite(nearest) ? nearest + 1e-4 : null;
}

function forEachTriangle(body: Body, visit: (tri: [Vec3, Vec3, Vec3]) => void): void {
  const { positions, indices } = body.mesh;
  const vertex = (i: number): Vec3 => {
    const v = indices[i]! * 3;
    return [positions[v]!, positions[v + 1]!, positions[v + 2]!];
  };
  for (let t = 0; t < indices.length; t += 3) visit([vertex(t), vertex(t + 1), vertex(t + 2)]);
}

function rayTriangle(origin: Vec3, dir: Vec3, [a, b, c]: [Vec3, Vec3, Vec3]): number | null {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const p = cross3(dir, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const s = sub(origin, a);
  const u = dot(s, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = cross3(s, e1);
  const v = dot(dir, q) * inv;
  if (v < 0 || u + v > 1) return null;
  return dot(e2, q) * inv;
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** `true` if `point` lies (within tolerance) inside one of the face's mesh triangles. */
export function faceContainsPoint(body: Body, faceIndex: number, point: Vec3): boolean {
  const face = body.faces[faceIndex];
  if (!face) return false;
  const { positions, indices } = body.mesh;
  const vertex = (i: number): Vec3 => {
    const v = indices[i]! * 3;
    return [positions[v]!, positions[v + 1]!, positions[v + 2]!];
  };
  for (let t = face.triangleStart; t < face.triangleStart + face.triangleCount; t += 1) {
    if (pointInTriangle(point, vertex(t * 3), vertex(t * 3 + 1), vertex(t * 3 + 2))) return true;
  }
  return false;
}

function pointInTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
  const v0 = sub(c, a);
  const v1 = sub(b, a);
  const v2 = sub(p, a);
  const d00 = dot(v0, v0);
  const d01 = dot(v0, v1);
  const d02 = dot(v0, v2);
  const d11 = dot(v1, v1);
  const d12 = dot(v1, v2);
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-12) return false;
  const u = (d11 * d02 - d01 * d12) / denom;
  const v = (d00 * d12 - d01 * d02) / denom;
  const eps = 1e-6;
  return u >= -eps && v >= -eps && u + v <= 1 + eps;
}

// ---- Sketch visibility ---------------------------------------------------------

/** Sketches used as the profile of a (non-suppressed) extrude: hidden by default, like Shapr3D. */
export function consumedSketchIds(features: readonly Feature[]): Set<string> {
  const out = new Set<string>();
  for (const f of features) {
    if (f.kind === 'extrude' && !f.suppressed && f.profile.kind === 'sketch') {
      out.add(f.profile.featureId);
    }
    if (!f.suppressed && isModelingFeature(f)) for (const id of sketchIdsUsedBy(f)) out.add(id);
  }
  return out;
}

/** Visibility of a sketch in the viewport: an explicit user choice wins, else hidden once consumed. */
export function isSketchVisible(
  featureId: string,
  consumed: ReadonlySet<string>,
  overrides: Readonly<Record<string, boolean>>,
): boolean {
  const override = overrides[featureId];
  if (override !== undefined) return override;
  return !consumed.has(featureId);
}

// ---- Section view ----------------------------------------------------------------

export type Axis = 'X' | 'Y' | 'Z';
const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { X: 0, Y: 1, Z: 2 };

export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

/** Union bounding box of the visible bodies, or `null` when nothing is visible. */
export function visibleBounds(
  bodies: readonly Body[],
  hiddenBodyIds: readonly string[],
  isolatedBodyIds: readonly string[] | null,
): Bounds3 | null {
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  for (const body of bodies) {
    if (hiddenBodyIds.includes(body.id)) continue;
    if (isolatedBodyIds && !isolatedBodyIds.includes(body.id)) continue;
    min = min
      ? [
          Math.min(min[0], body.min[0]),
          Math.min(min[1], body.min[1]),
          Math.min(min[2], body.min[2]),
        ]
      : [...body.min];
    max = max
      ? [
          Math.max(max[0], body.max[0]),
          Math.max(max[1], body.max[1]),
          Math.max(max[2], body.max[2]),
        ]
      : [...body.max];
  }
  return min && max ? { min, max } : null;
}

/** Default section offset: through the centre of the visible model along `axis` (0 without a model). */
export function defaultSectionOffset(bounds: Bounds3 | null, axis: Axis): number {
  if (!bounds) return 0;
  const i = AXIS_INDEX[axis];
  return (bounds.min[i] + bounds.max[i]) / 2;
}

/** Extent of the model along `axis` (for clamping the section handle), with a margin. */
export function sectionRange(bounds: Bounds3 | null, axis: Axis): [number, number] {
  if (!bounds) return [-100, 100];
  const i = AXIS_INDEX[axis];
  const margin = Math.max(1, (bounds.max[i] - bounds.min[i]) * 0.05);
  return [bounds.min[i] - margin, bounds.max[i] + margin];
}

// ---- Measure -------------------------------------------------------------------

export type MeasureTarget =
  | { kind: 'body'; bodyId: string }
  | { kind: 'face'; bodyId: string; faceKey: string }
  | { kind: 'edge'; bodyId: string; edgeKey: string };

/**
 * One-line quick measurement for the selection, or `null` when nothing
 * measurable is selected: body -> W x D x H and volume; one edge -> length,
 * circular edge -> diameter; one face -> area; two parallel planar faces ->
 * their distance.
 */
export function measureSelection(
  evaluation: EvaluationResult,
  selection: readonly SelectionItem[],
): string | null {
  const targets = selection.filter(
    (s): s is MeasureTarget => s.kind === 'body' || s.kind === 'face' || s.kind === 'edge',
  );
  if (targets.length === 0 || targets.length !== selection.length) return null;
  const bodyOf = (id: string) => evaluation.bodies.find((b) => b.id === id);
  if (targets.length === 1) {
    const t = targets[0]!;
    const body = bodyOf(t.bodyId);
    if (!body) return null;
    if (t.kind === 'body') {
      const [w, d, h] = [0, 1, 2].map((i) => fmt(body.max[i]! - body.min[i]!));
      return `${body.name}: ${w} × ${d} × ${h} mm · ${fmtVolume(body.volume)} mm³`;
    }
    if (t.kind === 'edge') {
      const edge = body.edges.find((e) => e.key === t.edgeKey);
      if (!edge) return null;
      if (edge.curve === 'circle' && edge.radius) {
        const full = Math.abs(edge.length - 2 * Math.PI * edge.radius) < 1e-6 * edge.length + 1e-6;
        return full
          ? `Circle: Ø ${fmt(edge.radius * 2)} mm · length ${fmt(edge.length)} mm`
          : `Arc: R ${fmt(edge.radius)} mm · length ${fmt(edge.length)} mm`;
      }
      return `Edge length: ${fmt(edge.length)} mm`;
    }
    const face = body.faces.find((f) => f.key === t.faceKey);
    if (!face) return null;
    return `Face area: ${fmt(face.area)} mm²`;
  }
  if (targets.length === 2 && targets.every((t) => t.kind === 'face')) {
    const [a, b] = targets.map((t) => {
      const face =
        t.kind === 'face' ? bodyOf(t.bodyId)?.faces.find((f) => f.key === t.faceKey) : undefined;
      return face ?? null;
    });
    if (!a || !b) return null;
    if (a.surface !== 'plane' || b.surface !== 'plane' || !a.normal || !b.normal) {
      return 'Distance: select two planar faces';
    }
    if (Math.abs(Math.abs(dot(a.normal, b.normal)) - 1) > 1e-6) {
      return 'Distance: faces are not parallel';
    }
    const distance = Math.abs(dot(a.normal, sub(b.centroid, a.centroid)));
    return `Distance: ${fmt(distance)} mm`;
  }
  return null;
}

function fmt(value: number): string {
  const rounded = Math.round(Math.abs(value) * 100) / 100;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function fmtVolume(value: number): string {
  return (Math.round(value * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });
}

// ---- vector helpers -----------------------------------------------------------

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
