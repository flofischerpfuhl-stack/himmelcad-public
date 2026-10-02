/**
 * Printability analysis of evaluated bodies (see `assembler/PRINTING.md`):
 *
 * - **Overhangs**: triangles whose outward normal points down more steeply
 *   than the threshold, measured from vertical against the build direction
 *   +Z (0° = vertical wall, 90° = horizontal ceiling). Triangles lying on
 *   the body's lowest level (the build plate) are not overhangs.
 * - **Wall thickness**: area-weighted sample points on the tessellation cast
 *   a ray inwards along the negative surface normal; the distance to the
 *   first surface hit is the local wall thickness (see the limits below).
 * - **Small holes / pins**: cylindrical B-rep faces spanning at least half a
 *   turn, classified as hole (concave) or pin (convex) from the mesh normals.
 * - **Validity**: the kernel's `BRepCheck` verdict, plus watertightness of
 *   the welded mesh (every edge shared by exactly two consistently oriented
 *   triangles).
 * - **Material**: exact B-rep volume × density (solid part, no infill model).
 *
 * Pure TypeScript: runs in the printability worker, headless and in tests.
 */
import type { Body } from '../../foundation/geometry-kernel/types.js';
import {
  buildBvh,
  manifoldStats,
  meshVolume,
  raycast,
  triangleCross,
  type IndexedMesh,
  type Vec3,
} from './meshTools.js';
import { weldMesh } from '../../foundation/geometry-kernel/meshWeld.js';
import { buildVolumeSize, type PrintSettings } from './settings.js';

/** The part of a {@link Body} the analysis needs (structured-clone friendly). */
export interface PrintBodyInput {
  id: string;
  name: string;
  valid: boolean;
  volume: number;
  min: Vec3;
  max: Vec3;
  positions: Float32Array;
  indices: Uint32Array;
  triangleFaces: Uint32Array;
  faces: {
    key: string;
    surface: string;
    area: number;
    triangleStart: number;
    triangleCount: number;
    edgeIndices: number[];
  }[];
  edges: { curve: string; radius?: number | null | undefined; length: number }[];
}

export function bodyToPrintInput(body: Body): PrintBodyInput {
  return {
    id: body.id,
    name: body.name,
    valid: body.valid,
    volume: body.volume,
    min: [...body.min],
    max: [...body.max],
    positions: body.mesh.positions,
    indices: body.mesh.indices,
    triangleFaces: body.mesh.triangleFaces,
    faces: body.faces.map((f) => ({
      key: f.key,
      surface: f.surface,
      area: f.area,
      triangleStart: f.triangleStart,
      triangleCount: f.triangleCount,
      edgeIndices: f.edgeIndices,
    })),
    edges: body.edges.map((e) => ({ curve: e.curve, radius: e.radius ?? null, length: e.length })),
  };
}

export interface FaceMetric {
  faceKey: string;
  /** Affected area on this face, mm². */
  area: number;
  /** Overhang: steepest angle from vertical (deg); wall: thinnest thickness (mm). */
  value: number;
}

export interface CylinderFeature {
  faceKey: string;
  kind: 'hole' | 'pin';
  diameterMm: number;
  /** Below the configured minimum diameter. */
  flagged: boolean;
}

export interface BodyPrintReport {
  bodyId: string;
  name: string;
  triangleCount: number;
  /** Kernel `BRepCheck_Analyzer` verdict. */
  brepValid: boolean;
  watertight: boolean;
  boundaryEdges: number;
  nonManifoldEdges: number;
  inconsistentEdges: number;
  /** Exact B-rep volume, mm³. */
  volumeMm3: number;
  /** Volume enclosed by the tessellation (differs slightly on curved faces), mm³. */
  meshVolumeMm3: number;
  massG: number;
  cost: number;
  min: Vec3;
  max: Vec3;
  size: Vec3;
  overhang: {
    areaMm2: number;
    /** Total surface area of the mesh, mm². */
    totalAreaMm2: number;
    /** Source-mesh triangle indices classified as overhang. */
    triangles: Uint32Array;
    /** Overhang angle (deg from vertical) of each entry of `triangles`. */
    angles: Float32Array;
    faces: FaceMetric[];
  };
  thinWall: {
    samples: number;
    thinSamples: number;
    /** Thinnest measured wall, mm (`null` when nothing was hit). */
    minThicknessMm: number | null;
    /** Source-mesh triangles containing a thin sample. */
    triangles: Uint32Array;
    faces: FaceMetric[];
  };
  cylinders: CylinderFeature[];
  buildVolume: { size: Vec3; fits: boolean; fitsRotated: boolean } | null;
}

export type FindingKind =
  | 'invalidBrep'
  | 'notWatertight'
  | 'buildVolume'
  | 'notOnPlate'
  | 'overhang'
  | 'thinWall'
  | 'smallHole'
  | 'smallPin'
  /** Two bodies share volume (print-in-place parts fuse; intended overlaps can be ignored). */
  | 'overlap'
  /** Two bodies closer than the minimum clearance (or touching). */
  | 'clearance'
  /** Body pairs the clearance pass did not reach (time budget, cancelled). */
  | 'clearanceSkipped';

export type FindingSeverity = 'error' | 'warning' | 'info';

/** Labels of the finding kinds ("Don't show this type", Settings). */
export const FINDING_KIND_LABELS: Record<FindingKind, string> = {
  invalidBrep: 'Invalid B-rep',
  notWatertight: 'Not watertight',
  buildVolume: 'Build volume',
  notOnPlate: 'Not on the plate',
  overhang: 'Overhangs',
  thinWall: 'Thin walls',
  smallHole: 'Small holes',
  smallPin: 'Small pins',
  overlap: 'Bodies overlap',
  clearance: 'Clearance below minimum',
  clearanceSkipped: 'Clearance not checked',
};

export interface PrintFinding {
  /**
   * Stable across rebuilds while the bodies/faces keep their names:
   * `<kind>:<bodyId>[:<faceKey>]`, for body pairs `<kind>:<bodyA>|<bodyB>`
   * (sorted). "Ignore here" stores it in the document.
   */
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  bodyId: string;
  bodyName: string;
  /** Faces to select/highlight when the finding is focused (may be empty: whole body). */
  faceKeys: string[];
  message: string;
  /** Primary number (angle in deg, thickness/diameter/clearance in mm, area in mm², overlap in mm³), if any. */
  value?: number;
  /** The second body of a pair finding (`overlap`, `clearance`). */
  otherBodyId?: string;
  otherBodyName?: string;
  /** Closest points of a clearance finding (drawn while Print mode is on). */
  segment?: [Vec3, Vec3];
  /** Where to look: the centre of an overlap. */
  point?: Vec3;
}

export interface PrintReport {
  settings: PrintSettings;
  bodies: BodyPrintReport[];
  findings: PrintFinding[];
  totals: { bodies: number; volumeMm3: number; massG: number; cost: number };
  /** Analysis time, ms. */
  ms: number;
}

export interface AnalysisOptions {
  /** Called with 0..1 and a label between steps. */
  onProgress?: (fraction: number, label: string) => void;
  /** Maximum wall-thickness samples per body (default 12 000). */
  sampleBudget?: number;
}

/** Tolerance for "lies on the build plate" (lowest level of the body), mm. */
export const PLATE_EPSILON_MM = 0.01;
/** Findings of one kind per body shown at most (the largest first). */
const MAX_FACE_FINDINGS = 40;

const SEVERITY_ORDER: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };

function fmt(value: number, digits = 2): string {
  return Number(value.toFixed(digits)).toString();
}

/** Overhang angle from vertical (deg) of a unit outward normal with z component `nz`; 0 for upward/vertical faces. */
export function overhangAngleDeg(nz: number): number {
  if (nz >= 0) return 0;
  return (Math.asin(Math.min(1, -nz)) * 180) / Math.PI;
}

interface OverhangResult {
  areaMm2: number;
  totalAreaMm2: number;
  triangles: number[];
  angles: number[];
  byFace: Map<number, { area: number; max: number }>;
}

/**
 * Overhang classification of triangles for build direction +Z. `threshold`
 * in degrees from vertical; a triangle is an overhang if its angle exceeds
 * the threshold by more than 0.01° and it is not on the lowest level.
 */
export function classifyOverhangs(
  mesh: IndexedMesh,
  thresholdDeg: number,
  triangleFaces?: Uint32Array,
): OverhangResult {
  const { positions: p, indices } = mesh;
  const n = indices.length / 3;
  let minZ = Infinity;
  for (let i = 2; i < p.length; i += 3) minZ = Math.min(minZ, p[i]!);
  const plateZ = minZ + PLATE_EPSILON_MM;
  const result: OverhangResult = {
    areaMm2: 0,
    totalAreaMm2: 0,
    triangles: [],
    angles: [],
    byFace: new Map(),
  };
  for (let t = 0; t < n; t += 1) {
    const c = triangleCross(mesh, t);
    const len = Math.hypot(c[0], c[1], c[2]);
    if (len === 0) continue;
    const area = len / 2;
    result.totalAreaMm2 += area;
    const angle = overhangAngleDeg(c[2] / len);
    if (angle <= thresholdDeg + 0.01) continue;
    const za = p[indices[t * 3]! * 3 + 2]!;
    const zb = p[indices[t * 3 + 1]! * 3 + 2]!;
    const zc = p[indices[t * 3 + 2]! * 3 + 2]!;
    if (Math.max(za, zb, zc) <= plateZ) continue; // on the build plate
    result.areaMm2 += area;
    result.triangles.push(t);
    result.angles.push(angle);
    if (triangleFaces) {
      const face = triangleFaces[t]!;
      const entry = result.byFace.get(face) ?? { area: 0, max: 0 };
      entry.area += area;
      entry.max = Math.max(entry.max, angle);
      result.byFace.set(face, entry);
    }
  }
  return result;
}

/** R2 low-discrepancy sequence point `i` mapped into a triangle (barycentric u, v). */
function r2Barycentric(i: number): [number, number] {
  const g = 1.324717957244746;
  let u = (0.5 + (i + 1) / g) % 1;
  let v = (0.5 + (i + 1) / (g * g)) % 1;
  if (u + v > 1) {
    u = 1 - u;
    v = 1 - v;
  }
  return [u, v];
}

interface ThicknessResult {
  samples: number;
  thin: number;
  /** Samples ignored as sharp-edge (wedge) artefacts, see {@link measureWallThickness}. */
  wedgeSamples: number;
  minThickness: number | null;
  thinTriangles: Set<number>;
  byFace: Map<number, { area: number; min: number }>;
}

/**
 * Width of the band along a sharp B-rep edge in which a sample whose ray
 * lands on the face across that edge is ignored, as a multiple of the
 * minimum wall (at least {@link WEDGE_BAND_MIN_MM}).
 */
export const WEDGE_BAND_FACTOR = 2;
export const WEDGE_BAND_MIN_MM = 0.5;

/**
 * The mesh segments where two different B-rep faces meet (the model's
 * edges as tessellated), grouped by face pair `lo|hi`. Built on the welded
 * mesh, whose adjacent faces share the node positions of their common edge.
 */
function faceBoundarySegments(
  mesh: IndexedMesh,
  triangleFaces: Uint32Array,
): Map<string, number[]> {
  const welded = weldMesh(mesh);
  const firstFace = new Map<number, number>();
  const vertexCount = welded.positions.length / 3;
  const out = new Map<string, number[]>();
  const p = welded.positions;
  for (let k = 0; k < welded.sourceTriangles.length; k += 1) {
    const face = triangleFaces[welded.sourceTriangles[k]!]!;
    for (let e = 0; e < 3; e += 1) {
      const a = welded.indices[k * 3 + e]!;
      const b = welded.indices[k * 3 + ((e + 1) % 3)]!;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = lo * vertexCount + hi;
      const other = firstFace.get(key);
      if (other === undefined) {
        firstFace.set(key, face);
        continue;
      }
      if (other === face) continue;
      const pair = other < face ? `${other}|${face}` : `${face}|${other}`;
      let list = out.get(pair);
      if (!list) out.set(pair, (list = []));
      list.push(
        p[lo * 3]!,
        p[lo * 3 + 1]!,
        p[lo * 3 + 2]!,
        p[hi * 3]!,
        p[hi * 3 + 1]!,
        p[hi * 3 + 2]!,
      );
    }
  }
  return out;
}

/** Distance from `q` to the nearest of the flat segment list (6 numbers each). */
function distanceToSegments(q: Vec3, segments: readonly number[]): number {
  let best = Infinity;
  for (let i = 0; i < segments.length; i += 6) {
    const ax = segments[i]!;
    const ay = segments[i + 1]!;
    const az = segments[i + 2]!;
    const dx = segments[i + 3]! - ax;
    const dy = segments[i + 4]! - ay;
    const dz = segments[i + 5]! - az;
    const len2 = dx * dx + dy * dy + dz * dz;
    let s = len2 > 0 ? ((q[0] - ax) * dx + (q[1] - ay) * dy + (q[2] - az) * dz) / len2 : 0;
    s = Math.max(0, Math.min(1, s));
    const d = Math.hypot(ax + s * dx - q[0], ay + s * dy - q[1], az + s * dz - q[2]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Sample-based wall thickness: area-weighted points (every B-rep face gets
 * at least one), each casting a ray inwards along its triangle's negative
 * normal; the first hit distance is the local thickness. Samples whose ray
 * leaves the mesh without a hit (open mesh) are ignored.
 *
 * **Sharp edges are not walls.** Near an acute edge (a wedge of opening
 * angle α < 90°) the inward ray of a point at distance `d` from the edge
 * hits the face across the edge after `d · tan α` — "0 mm" right at the
 * edge, although nothing there is a thin wall. With `triangleFaces` given,
 * a sample is therefore ignored (counted in `wedgeSamples`) when its ray
 * lands on a *different B-rep face that shares an edge with the sample's
 * own face* and the sample lies within `max(WEDGE_BAND_FACTOR × minWall,
 * WEDGE_BAND_MIN_MM)` of that shared edge. Opposite sides of a real wall
 * (a shelled box's inside and outside, a plate's top and bottom) never share
 * an edge, so real thin walls are still found. Outside the band a wedge
 * measures at least `band · tan α`, so only wedges sharper than
 * `atan(minWall / band)` (≈ 26.6° with the default factor) are still
 * reported — with their real, non-zero thickness.
 */
export function measureWallThickness(
  mesh: IndexedMesh,
  minWallMm: number,
  options: {
    triangleFaces?: Uint32Array;
    faceTriangles?: { start: number; count: number }[];
    budget?: number;
    onProgress?: (fraction: number) => void;
  } = {},
): ThicknessResult {
  const { positions: p, indices } = mesh;
  const n = indices.length / 3;
  const budget = options.budget ?? 12000;
  const areas = new Float64Array(n);
  let total = 0;
  for (let t = 0; t < n; t += 1) {
    const c = triangleCross(mesh, t);
    areas[t] = Math.hypot(c[0], c[1], c[2]) / 2;
    total += areas[t]!;
  }
  const result: ThicknessResult = {
    samples: 0,
    thin: 0,
    wedgeSamples: 0,
    minThickness: null,
    thinTriangles: new Set(),
    byFace: new Map(),
  };
  if (n === 0 || total === 0) return result;
  const density = Math.min(budget / total, 64);
  const perTriangle = new Uint32Array(n);
  let carry = 0;
  for (let t = 0; t < n; t += 1) {
    carry += areas[t]! * density;
    const k = Math.floor(carry);
    perTriangle[t] = k;
    carry -= k;
  }
  // Every face gets at least one sample (small features would slip through otherwise).
  for (const range of options.faceTriangles ?? []) {
    if (range.count === 0) continue;
    let sampled = false;
    let largest = range.start;
    for (let t = range.start; t < range.start + range.count; t += 1) {
      if (perTriangle[t]! > 0) sampled = true;
      if (areas[t]! > areas[largest]!) largest = t;
    }
    if (!sampled && areas[largest]! > 0) perTriangle[largest] = 1;
  }
  const bvh = buildBvh(mesh);
  let diagonal = 0;
  {
    const b = bvh.bounds;
    diagonal = Math.hypot(b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!);
  }
  const eps = Math.max(1e-5, diagonal * 1e-7);
  const triangleFaces = options.triangleFaces;
  const boundaries = triangleFaces ? faceBoundarySegments(mesh, triangleFaces) : null;
  const wedgeBand = Math.max(WEDGE_BAND_FACTOR * minWallMm, WEDGE_BAND_MIN_MM);
  let sequence = 0;
  const report = Math.max(1, Math.floor(n / 50));
  for (let t = 0; t < n; t += 1) {
    if (options.onProgress && t % report === 0) options.onProgress(t / n);
    const k = perTriangle[t]!;
    if (k === 0) continue;
    const c = triangleCross(mesh, t);
    const len = Math.hypot(c[0], c[1], c[2]);
    if (len === 0) continue;
    const nx = c[0] / len;
    const ny = c[1] / len;
    const nz = c[2] / len;
    const a = indices[t * 3]! * 3;
    const b = indices[t * 3 + 1]! * 3;
    const cc = indices[t * 3 + 2]! * 3;
    for (let s = 0; s < k; s += 1) {
      const [u, v] = k === 1 ? [1 / 3, 1 / 3] : r2Barycentric(sequence++);
      const w = 1 - u - v;
      const origin: Vec3 = [
        w * p[a]! + u * p[b]! + v * p[cc]! - nx * eps,
        w * p[a + 1]! + u * p[b + 1]! + v * p[cc + 1]! - ny * eps,
        w * p[a + 2]! + u * p[b + 2]! + v * p[cc + 2]! - nz * eps,
      ];
      const hit = raycast(bvh, origin, [-nx, -ny, -nz], eps, Infinity, t);
      if (!hit) continue;
      if (boundaries && triangleFaces) {
        const own = triangleFaces[t]!;
        const across = triangleFaces[hit.triangle]!;
        if (own !== across) {
          const shared = boundaries.get(own < across ? `${own}|${across}` : `${across}|${own}`);
          if (shared && distanceToSegments(origin, shared) < wedgeBand) {
            result.wedgeSamples += 1;
            continue;
          }
        }
      }
      const thickness = hit.t + eps;
      result.samples += 1;
      result.minThickness =
        result.minThickness === null ? thickness : Math.min(result.minThickness, thickness);
      if (thickness < minWallMm) {
        result.thin += 1;
        result.thinTriangles.add(t);
        if (options.triangleFaces) {
          const face = options.triangleFaces[t]!;
          const entry = result.byFace.get(face) ?? { area: 0, min: Infinity };
          entry.min = Math.min(entry.min, thickness);
          result.byFace.set(face, entry);
        }
      }
    }
  }
  // Affected area per face = area of its thin triangles.
  for (const t of result.thinTriangles) {
    const face = options.triangleFaces?.[t];
    if (face === undefined) continue;
    const entry = result.byFace.get(face);
    if (entry) entry.area += areas[t]!;
  }
  return result;
}

/**
 * Cylindrical faces spanning at least half a turn: diameter from their
 * circular boundary edges, hole (concave) or pin (convex) from the mesh.
 */
export function detectCylinders(
  body: PrintBodyInput,
  settings: Pick<PrintSettings, 'minHoleMm' | 'minPinMm'>,
): CylinderFeature[] {
  const out: CylinderFeature[] = [];
  const mesh: IndexedMesh = { positions: body.positions, indices: body.indices };
  for (const face of body.faces) {
    if (face.surface !== 'cylinder' || face.triangleCount === 0) continue;
    const circles = face.edgeIndices
      .map((i) => body.edges[i])
      .filter(
        (e): e is PrintBodyInput['edges'][number] & { radius: number } =>
          e !== undefined && e.curve === 'circle' && typeof e.radius === 'number' && e.radius > 0,
      );
    if (circles.length === 0) continue;
    const radius = Math.max(...circles.map((e) => e.radius));
    const longest = Math.max(...circles.filter((e) => e.radius === radius).map((e) => e.length));
    if (longest < Math.PI * radius * 0.98) continue; // less than half a turn: a fillet, not a hole/pin
    // Mesh centroid of the face, then the sign of normal · (point - centroid).
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let areaSum = 0;
    const tris: { centre: Vec3; normal: Vec3; area: number }[] = [];
    for (let t = face.triangleStart; t < face.triangleStart + face.triangleCount; t += 1) {
      const c = triangleCross(mesh, t);
      const len = Math.hypot(c[0], c[1], c[2]);
      if (len === 0) continue;
      const area = len / 2;
      const a = body.indices[t * 3]! * 3;
      const b = body.indices[t * 3 + 1]! * 3;
      const d = body.indices[t * 3 + 2]! * 3;
      const p = body.positions;
      const centre: Vec3 = [
        (p[a]! + p[b]! + p[d]!) / 3,
        (p[a + 1]! + p[b + 1]! + p[d + 1]!) / 3,
        (p[a + 2]! + p[b + 2]! + p[d + 2]!) / 3,
      ];
      tris.push({ centre, normal: [c[0] / len, c[1] / len, c[2] / len], area });
      cx += centre[0] * area;
      cy += centre[1] * area;
      cz += centre[2] * area;
      areaSum += area;
    }
    if (areaSum === 0) continue;
    cx /= areaSum;
    cy /= areaSum;
    cz /= areaSum;
    let sign = 0;
    for (const tri of tris) {
      sign +=
        tri.area *
        (tri.normal[0] * (tri.centre[0] - cx) +
          tri.normal[1] * (tri.centre[1] - cy) +
          tri.normal[2] * (tri.centre[2] - cz));
    }
    const kind = sign < 0 ? 'hole' : 'pin';
    const diameterMm = 2 * radius;
    const limit = kind === 'hole' ? settings.minHoleMm : settings.minPinMm;
    out.push({ faceKey: face.key, kind, diameterMm, flagged: diameterMm < limit - 1e-9 });
  }
  return out;
}

/** Build-volume check of a body size (bounding box, mm). */
export function checkBuildVolume(
  size: Vec3,
  volume: [number, number, number],
): { fits: boolean; fitsRotated: boolean } {
  const tol = 1e-6;
  const fits =
    size[0] <= volume[0] + tol && size[1] <= volume[1] + tol && size[2] <= volume[2] + tol;
  const fitsRotated =
    size[1] <= volume[0] + tol && size[0] <= volume[1] + tol && size[2] <= volume[2] + tol;
  return { fits, fitsRotated };
}

/** Analyses one body. */
export function analyzeBody(
  body: PrintBodyInput,
  settings: PrintSettings,
  options: AnalysisOptions & { progressBase?: number; progressSpan?: number } = {},
): BodyPrintReport {
  const base = options.progressBase ?? 0;
  const span = options.progressSpan ?? 1;
  const progress = (fraction: number, label: string) =>
    options.onProgress?.(base + span * fraction, `${body.name}: ${label}`);
  const mesh: IndexedMesh = { positions: body.positions, indices: body.indices };

  progress(0, 'mesh check');
  const welded = weldMesh(mesh);
  const stats = manifoldStats(welded.indices);
  const meshVolumeMm3 = meshVolume(welded);

  progress(0.1, 'overhangs');
  const overhang = classifyOverhangs(mesh, settings.overhangAngleDeg, body.triangleFaces);

  progress(0.2, 'wall thickness');
  const thickness = measureWallThickness(mesh, settings.minWallMm, {
    triangleFaces: body.triangleFaces,
    faceTriangles: body.faces.map((f) => ({ start: f.triangleStart, count: f.triangleCount })),
    ...(options.sampleBudget !== undefined ? { budget: options.sampleBudget } : {}),
    onProgress: (f) => progress(0.2 + 0.7 * f, 'wall thickness'),
  });

  progress(0.9, 'holes and pins');
  const cylinders = detectCylinders(body, settings);

  const faceKey = (index: number) => body.faces[index]?.key ?? `face#${index}`;
  const size: Vec3 = [
    body.max[0] - body.min[0],
    body.max[1] - body.min[1],
    body.max[2] - body.min[2],
  ];
  const volume = buildVolumeSize(settings);
  const massG = (body.volume / 1000) * settings.density;
  return {
    bodyId: body.id,
    name: body.name,
    triangleCount: body.indices.length / 3,
    brepValid: body.valid,
    watertight: stats.watertight,
    boundaryEdges: stats.boundaryEdges,
    nonManifoldEdges: stats.nonManifoldEdges,
    inconsistentEdges: stats.inconsistentEdges,
    volumeMm3: body.volume,
    meshVolumeMm3,
    massG,
    cost: (massG / 1000) * settings.costPerKg,
    min: [...body.min],
    max: [...body.max],
    size,
    overhang: {
      areaMm2: overhang.areaMm2,
      totalAreaMm2: overhang.totalAreaMm2,
      triangles: Uint32Array.from(overhang.triangles),
      angles: Float32Array.from(overhang.angles),
      faces: [...overhang.byFace.entries()]
        .map(([face, v]) => ({ faceKey: faceKey(face), area: v.area, value: v.max }))
        .sort((a, b) => b.area - a.area || a.faceKey.localeCompare(b.faceKey)),
    },
    thinWall: {
      samples: thickness.samples,
      thinSamples: thickness.thin,
      minThicknessMm: thickness.minThickness,
      triangles: Uint32Array.from([...thickness.thinTriangles].sort((a, b) => a - b)),
      faces: [...thickness.byFace.entries()]
        .map(([face, v]) => ({ faceKey: faceKey(face), area: v.area, value: v.min }))
        .sort((a, b) => a.value - b.value || a.faceKey.localeCompare(b.faceKey)),
    },
    cylinders,
    buildVolume: volume ? { size: volume, ...checkBuildVolume(size, volume) } : null,
  };
}

/** Findings (the panel list) of analysed bodies, most severe first. */
export function findingsOf(
  reports: readonly BodyPrintReport[],
  settings: PrintSettings,
): PrintFinding[] {
  const findings: PrintFinding[] = [];
  for (const r of reports) {
    const base = { bodyId: r.bodyId, bodyName: r.name };
    if (!r.brepValid) {
      findings.push({
        ...base,
        id: `invalidBrep:${r.bodyId}`,
        kind: 'invalidBrep',
        severity: 'error',
        faceKeys: [],
        message: 'Invalid B-rep (kernel check failed): exports may not slice correctly.',
      });
    }
    if (!r.watertight) {
      const parts = [
        r.boundaryEdges ? `${r.boundaryEdges} open edges` : null,
        r.nonManifoldEdges ? `${r.nonManifoldEdges} non-manifold edges` : null,
        r.inconsistentEdges ? `${r.inconsistentEdges} flipped edges` : null,
      ].filter(Boolean);
      findings.push({
        ...base,
        id: `notWatertight:${r.bodyId}`,
        kind: 'notWatertight',
        severity: 'error',
        faceKeys: [],
        message: `Mesh is not watertight (${parts.join(', ')}).`,
      });
    }
    if (r.buildVolume && !r.buildVolume.fits) {
      const [x, y, z] = r.size.map((v) => fmt(v, 1));
      const [vx, vy, vz] = r.buildVolume.size;
      findings.push({
        ...base,
        id: `buildVolume:${r.bodyId}`,
        kind: 'buildVolume',
        severity: r.buildVolume.fitsRotated ? 'warning' : 'error',
        faceKeys: [],
        message: r.buildVolume.fitsRotated
          ? `${x} × ${y} × ${z} mm fits the ${vx} × ${vy} × ${vz} mm build volume only rotated 90° about Z.`
          : `${x} × ${y} × ${z} mm does not fit the ${vx} × ${vy} × ${vz} mm build volume.`,
      });
    }
    if (Math.abs(r.min[2]) > PLATE_EPSILON_MM) {
      findings.push({
        ...base,
        id: `notOnPlate:${r.bodyId}`,
        kind: 'notOnPlate',
        severity: 'info',
        faceKeys: [],
        value: r.min[2],
        message: `Lowest point at Z = ${fmt(r.min[2])} mm, not on the plate (slicers drop it to Z = 0).`,
      });
    }
    for (const face of r.overhang.faces.slice(0, MAX_FACE_FINDINGS)) {
      findings.push({
        ...base,
        id: `overhang:${r.bodyId}:${face.faceKey}`,
        kind: 'overhang',
        severity: 'warning',
        faceKeys: [face.faceKey],
        value: face.value,
        message: `Overhang ${fmt(face.value, 0)}° > ${fmt(settings.overhangAngleDeg, 0)}°, ${fmt(face.area, 1)} mm² needs support.`,
      });
    }
    // A thin wall has two sides (and a shelled part many faces): one finding per body,
    // selecting every face with thin samples.
    if (r.thinWall.faces.length > 0) {
      const thinnest = r.thinWall.faces[0]!.value;
      const count = r.thinWall.faces.length;
      findings.push({
        ...base,
        id: `thinWall:${r.bodyId}`,
        kind: 'thinWall',
        severity: 'warning',
        faceKeys: r.thinWall.faces.map((f) => f.faceKey),
        value: thinnest,
        message: `Walls down to ${fmt(thinnest)} mm < ${fmt(settings.minWallMm)} mm on ${count} ${count === 1 ? 'face' : 'faces'}.`,
      });
    }
    for (const c of r.cylinders.filter((c) => c.flagged)) {
      findings.push({
        ...base,
        id: `${c.kind === 'hole' ? 'smallHole' : 'smallPin'}:${r.bodyId}:${c.faceKey}`,
        kind: c.kind === 'hole' ? 'smallHole' : 'smallPin',
        severity: 'warning',
        faceKeys: [c.faceKey],
        value: c.diameterMm,
        message:
          c.kind === 'hole'
            ? `Hole Ø${fmt(c.diameterMm)} mm < ${fmt(settings.minHoleMm)} mm: may close up when printed.`
            : `Pin Ø${fmt(c.diameterMm)} mm < ${fmt(settings.minPinMm)} mm: fragile when printed.`,
      });
    }
  }
  const bodyOrder = new Map(reports.map((r, i) => [r.bodyId, i]));
  return findings
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] ||
        bodyOrder.get(a.f.bodyId)! - bodyOrder.get(b.f.bodyId)! ||
        a.i - b.i,
    )
    .map(({ f }) => f);
}

/** Full analysis of all given bodies. */
export function analyzePrintability(
  bodies: readonly PrintBodyInput[],
  settings: PrintSettings,
  options: AnalysisOptions = {},
): PrintReport {
  const started = Date.now();
  const reports = bodies.map((body, i) =>
    analyzeBody(body, settings, {
      ...options,
      progressBase: i / Math.max(1, bodies.length),
      progressSpan: 1 / Math.max(1, bodies.length),
    }),
  );
  options.onProgress?.(1, 'Done');
  return {
    settings,
    bodies: reports,
    findings: findingsOf(reports, settings),
    totals: {
      bodies: reports.length,
      volumeMm3: reports.reduce((s, r) => s + r.volumeMm3, 0),
      massG: reports.reduce((s, r) => s + r.massG, 0),
      cost: reports.reduce((s, r) => s + r.cost, 0),
    },
    ms: Date.now() - started,
  };
}
