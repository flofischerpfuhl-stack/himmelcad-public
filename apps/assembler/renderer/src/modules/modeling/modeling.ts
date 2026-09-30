/**
 * Pure modelling helpers: Shapr3D-style automatic extrude operation (sketch
 * contact, start depth, point-in-body) and quick measurements. No store
 * access, no DOM — unit tested under `node:test`. Sketch visibility is the
 * document's (`foundation/document/sketchVisibility.ts`), section bounds the
 * command gate's (`foundation/commands/viewBounds.ts`).
 */
import type { Body, EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import {
  frameForFace,
  frameForPlane,
  framePoint,
  MIN_FEATURE_SIZE_MM,
  type ExtrudeOperation,
  type Feature,
  type Vec3,
} from '../../foundation/document/document.js';
import type { SketchFeature } from '../../foundation/sketch-solver/sketchFeature.js';
import { detectRegions, loopPolygon } from '../../foundation/sketch-solver/regions.js';
import type { SelectionItem } from '../../foundation/commands/store.js';

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
  regions?: readonly string[],
): SketchContact | null {
  const sketch = evaluation.sketches.find((s) => s.featureId === sketchFeatureId);
  if (!sketch) return null;
  const profiles = regions
    ? sketch.profiles.filter((p) => regions.includes(p.key))
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
  regionKeys: readonly string[] | undefined,
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
      : sketch.plane.kind === 'construction'
        ? sketch.plane.frame
        : frameForFace(
            sketch.plane.face.signature.normal ?? face.normal,
            sketch.plane.face.signature.centroid,
          );
  // Regions straight from the sketch data (it may not be evaluated yet), like the kernel detects them.
  const all = detectRegions(sketch);
  const regions = regionKeys ? all.filter((r) => regionKeys.includes(r.key)) : all;
  if (regions.length === 0) return null;
  const samples: Vec3[] = [];
  for (const region of regions) {
    samples.push(framePoint(frame, region.sample[0], region.sample[1]));
    const outline = loopPolygon(region.outer);
    const step = Math.max(1, Math.floor(outline.length / 32));
    for (let i = 0; i < outline.length; i += step) {
      samples.push(framePoint(frame, outline[i]![0], outline[i]![1]));
    }
  }
  if (!samples.every((p) => faceContainsPoint(body, faceIndex, p))) return null;
  const into: Vec3 = [
    -frame.normal[0] * contact.sign,
    -frame.normal[1] * contact.sign,
    -frame.normal[2] * contact.sign,
  ];
  const depths = regions.map((region) =>
    depthInsideBody(body, framePoint(frame, region.sample[0], region.sample[1]), into),
  );
  if (depths.some((d) => d === null)) return null;
  const depth = Math.max(...(depths as number[]));
  if (!(depth >= MIN_FEATURE_SIZE_MM)) return null;
  return (-contact.sign * Math.round(depth * 1000)) / 1000;
}

/** Fixed direction of the parity ray (skewed so it rarely runs along mesh edges). */
const PARITY_DIR = normalize3([0.5773, 0.5774, 0.5775]);

/**
 * Triangles of a mesh binned by their projection onto the plane normal to
 * {@link PARITY_DIR}: a ray along that direction can only hit triangles
 * whose projected box contains the projected origin, so a query tests one
 * cell's triangles instead of the whole mesh. Built once per mesh (meshes
 * are immutable) and dropped with it.
 */
interface ParityGrid {
  /** Projection basis (orthonormal to the ray). */
  ex: Vec3;
  ey: Vec3;
  minX: number;
  minY: number;
  cellW: number;
  cellH: number;
  nx: number;
  ny: number;
  /** CSR: triangle ids (index into `indices / 3`) of cell `c` are `ids[start[c]..start[c+1])`. */
  start: Uint32Array;
  ids: Uint32Array;
}

const parityGrids = new WeakMap<Body['mesh'], ParityGrid>();

function parityGrid(body: Body): ParityGrid {
  const cached = parityGrids.get(body.mesh);
  if (cached) return cached;
  const { positions, indices } = body.mesh;
  const ex = normalize3(cross3(PARITY_DIR, [0, 0, 1]));
  const ey = cross3(PARITY_DIR, ex);
  const triangles = indices.length / 3;
  const px = new Float64Array(positions.length / 3);
  const py = new Float64Array(positions.length / 3);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let v = 0; v < px.length; v += 1) {
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    px[v] = x * ex[0] + y * ex[1] + z * ex[2];
    py[v] = x * ey[0] + y * ey[1] + z * ey[2];
    minX = Math.min(minX, px[v]!);
    maxX = Math.max(maxX, px[v]!);
    minY = Math.min(minY, py[v]!);
    maxY = Math.max(maxY, py[v]!);
  }
  const side = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(triangles / 2))));
  const cellW = Math.max((maxX - minX) / side, 1e-9);
  const cellH = Math.max((maxY - minY) / side, 1e-9);
  // Generous margin: a triangle is binned into every cell its projected box (grown) touches,
  // so the candidate set always contains every triangle the exact ray test could hit.
  const margin = 1e-6 * Math.max(1, maxX - minX, maxY - minY);
  const cellRange = (t: number): [number, number, number, number] => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < 3; k += 1) {
      const v = indices[t * 3 + k]!;
      x0 = Math.min(x0, px[v]!);
      x1 = Math.max(x1, px[v]!);
      y0 = Math.min(y0, py[v]!);
      y1 = Math.max(y1, py[v]!);
    }
    const clamp = (c: number) => Math.max(0, Math.min(side - 1, c));
    return [
      clamp(Math.floor((x0 - margin - minX) / cellW)),
      clamp(Math.floor((x1 + margin - minX) / cellW)),
      clamp(Math.floor((y0 - margin - minY) / cellH)),
      clamp(Math.floor((y1 + margin - minY) / cellH)),
    ];
  };
  const counts = new Uint32Array(side * side + 1);
  for (let t = 0; t < triangles; t += 1) {
    const [cx0, cx1, cy0, cy1] = cellRange(t);
    for (let cy = cy0; cy <= cy1; cy += 1)
      for (let cx = cx0; cx <= cx1; cx += 1) counts[cy * side + cx + 1]! += 1;
  }
  for (let c = 1; c < counts.length; c += 1) counts[c]! += counts[c - 1]!;
  const start = counts;
  const fill = start.slice(0, side * side);
  const ids = new Uint32Array(start[side * side]!);
  for (let t = 0; t < triangles; t += 1) {
    const [cx0, cx1, cy0, cy1] = cellRange(t);
    for (let cy = cy0; cy <= cy1; cy += 1)
      for (let cx = cx0; cx <= cx1; cx += 1) ids[fill[cy * side + cx]!++] = t;
  }
  const grid = { ex, ey, minX, minY, cellW, cellH, nx: side, ny: side, start, ids };
  parityGrids.set(body.mesh, grid);
  return grid;
}

/** `true` if `point` is inside the body's closed mesh (ray parity). */
export function pointInsideBody(body: Body, point: Vec3): boolean {
  if (point.some((v, i) => v < body.min[i]! - 1e-6 || v > body.max[i]! + 1e-6)) return false;
  const grid = parityGrid(body);
  const x = dot(point, grid.ex);
  const y = dot(point, grid.ey);
  const fx = (x - grid.minX) / grid.cellW;
  const fy = (y - grid.minY) / grid.cellH;
  // Clearly outside the projected mesh (by more than a cell's margin): the ray misses everything.
  if (fx < -0.5 || fy < -0.5 || fx > grid.nx + 0.5 || fy > grid.ny + 0.5) return false;
  const cx = Math.max(0, Math.min(grid.nx - 1, Math.floor(fx)));
  const cy = Math.max(0, Math.min(grid.ny - 1, Math.floor(fy)));
  const cell = cy * grid.nx + cx;
  const { positions, indices } = body.mesh;
  let hits = 0;
  for (let k = grid.start[cell]!; k < grid.start[cell + 1]!; k += 1) {
    const d = rayTriangleAt(point, PARITY_DIR, positions, indices, grid.ids[k]!);
    if (d !== null && d > 1e-9) hits += 1;
  }
  return hits % 2 === 1;
}

/**
 * Möller–Trumbore ray/triangle distance on triangle `t` of an indexed mesh
 * (`null` = no hit), without allocating.
 */
function rayTriangleAt(
  origin: Vec3,
  dir: Vec3,
  positions: Float32Array,
  indices: Uint32Array,
  t: number,
): number | null {
  const ia = indices[t * 3]! * 3;
  const ib = indices[t * 3 + 1]! * 3;
  const ic = indices[t * 3 + 2]! * 3;
  const ax = positions[ia]!;
  const ay = positions[ia + 1]!;
  const az = positions[ia + 2]!;
  const e1x = positions[ib]! - ax;
  const e1y = positions[ib + 1]! - ay;
  const e1z = positions[ib + 2]! - az;
  const e2x = positions[ic]! - ax;
  const e2y = positions[ic + 1]! - ay;
  const e2z = positions[ic + 2]! - az;
  // p = dir × e2
  const pxv = dir[1] * e2z - dir[2] * e2y;
  const pyv = dir[2] * e2x - dir[0] * e2z;
  const pzv = dir[0] * e2y - dir[1] * e2x;
  const det = e1x * pxv + e1y * pyv + e1z * pzv;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const sx = origin[0] - ax;
  const sy = origin[1] - ay;
  const sz = origin[2] - az;
  const u = (sx * pxv + sy * pyv + sz * pzv) * inv;
  if (u < 0 || u > 1) return null;
  // q = s × e1
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
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
  const { positions, indices } = body.mesh;
  for (let t = 0; t < indices.length / 3; t += 1) {
    const d = rayTriangleAt(start, dir, positions, indices, t);
    if (d !== null && d > 1e-6) nearest = Math.min(nearest, d);
  }
  return Number.isFinite(nearest) ? nearest + 1e-4 : null;
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
  /** Display unit of the read-out (documents are always millimetres). */
  unit: 'mm' | 'in' = 'mm',
): string | null {
  const u = unit === 'in' ? 'in' : 'mm';
  const fmt = (mm: number) => fmtLength(mm, unit);
  const fmtVolume = (mm3: number) => fmtVolumeIn(mm3, unit);
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
      return `${body.name}: ${w} × ${d} × ${h} ${u} · ${fmtVolume(body.volume)} ${u}³`;
    }
    if (t.kind === 'edge') {
      const edge = body.edges.find((e) => e.key === t.edgeKey);
      if (!edge) return null;
      if (edge.curve === 'circle' && edge.radius) {
        const full = Math.abs(edge.length - 2 * Math.PI * edge.radius) < 1e-6 * edge.length + 1e-6;
        return full
          ? `Circle: Ø ${fmt(edge.radius * 2)} ${u} · length ${fmt(edge.length)} ${u}`
          : `Arc: R ${fmt(edge.radius)} ${u} · length ${fmt(edge.length)} ${u}`;
      }
      return `Edge length: ${fmt(edge.length)} ${u}`;
    }
    const face = body.faces.find((f) => f.key === t.faceKey);
    if (!face) return null;
    return `Face area: ${fmtArea(face.area, unit)} ${u}²`;
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
    return `Distance: ${fmt(distance)} ${u}`;
  }
  return null;
}

function fmtLength(mm: number, unit: 'mm' | 'in'): string {
  const value = Math.abs(unit === 'in' ? mm / 25.4 : mm);
  const digits = unit === 'in' ? 3 : 2;
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function fmtArea(mm2: number, unit: 'mm' | 'in'): string {
  const value = unit === 'in' ? mm2 / (25.4 * 25.4) : mm2;
  return value.toLocaleString('en-US', { maximumFractionDigits: unit === 'in' ? 4 : 2 });
}

function fmtVolumeIn(mm3: number, unit: 'mm' | 'in'): string {
  const value = unit === 'in' ? mm3 / 25.4 ** 3 : mm3;
  return value.toLocaleString('en-US', { maximumFractionDigits: unit === 'in' ? 4 : 1 });
}

// ---- vector helpers -----------------------------------------------------------

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
