/**
 * Build-plate orientation: "Place on plate" (lay a planar face flat on
 * Z = 0) and "Auto orient" (rank candidate orientations by overhang area,
 * then height). Both produce the parameters of an ordinary `transform`
 * feature (rotate about world X, then Y, then Z through the pivot, then
 * translate — `kernel/features/rigid.ts`), so the result is one editable
 * History step. Pure TypeScript, deterministic.
 */
import {
  opsAffine,
  transformOps,
  type Affine,
} from '../foundation/geometry-kernel/features/rigid.js';
import { overhangAngleDeg, PLATE_EPSILON_MM } from './analysis.js';
import type { Vec3 } from './meshTools.js';

/** Row-major 3×3 rotation. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Rotation by `angle` (rad) about unit `axis` (Rodrigues). */
export function axisAngle(axis: Vec3, angle: number): Mat3 {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = 1 - c;
  return [
    c + x * x * k,
    x * y * k - z * s,
    x * z * k + y * s,
    y * x * k + z * s,
    c + y * y * k,
    y * z * k - x * s,
    z * x * k - y * s,
    z * y * k + x * s,
    c + z * z * k,
  ];
}

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      out.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
    }
  }
  return out as Mat3;
}

export function applyMat3(m: Mat3 | readonly number[], v: Vec3): Vec3 {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
    m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
  ];
}

/** The shortest rotation turning unit vector `n` into −Z. */
export function rotationToDown(n: Vec3): Mat3 {
  const d = normalize(n);
  const down: Vec3 = [0, 0, -1];
  const cos = -d[2];
  if (cos > 1 - 1e-12) return [...IDENTITY3];
  if (cos < -1 + 1e-12) return axisAngle([1, 0, 0], Math.PI); // n = +Z: flip over X
  const axis: Vec3 = [
    d[1] * down[2] - d[2] * down[1],
    d[2] * down[0] - d[0] * down[2],
    d[0] * down[1] - d[1] * down[0],
  ];
  return axisAngle(axis, Math.acos(Math.max(-1, Math.min(1, cos))));
}

/**
 * Extrinsic X-then-Y-then-Z angles (degrees) of a rotation, i.e.
 * `R = Rz(rz) · Ry(ry) · Rx(rx)` — the convention of the transform feature.
 */
export function eulerXYZ(r: Mat3): { rx: number; ry: number; rz: number } {
  const sy = -r[6];
  let rx: number;
  let ry: number;
  let rz: number;
  if (Math.abs(sy) < 1 - 1e-9) {
    ry = Math.asin(sy);
    rx = Math.atan2(r[7], r[8]);
    rz = Math.atan2(r[3], r[0]);
  } else {
    // Gimbal lock (ry = ±90°): only rx ∓ rz is defined; take rx = 0.
    ry = sy > 0 ? Math.PI / 2 : -Math.PI / 2;
    rx = 0;
    rz = Math.atan2(-r[1], r[4]);
  }
  const deg = (a: number) => {
    const d = (a * 180) / Math.PI;
    // Snap float noise (e.g. 89.99999999999999) so History cards show clean values.
    const snapped = Math.round(d * 1e9) / 1e9;
    return Object.is(snapped, -0) ? 0 : snapped;
  };
  return { rx: deg(rx), ry: deg(ry), rz: deg(rz) };
}

/** Parameters of a `transform` feature (without id/name). */
export interface PlacementTransform {
  dx: number;
  dy: number;
  dz: number;
  rx: number;
  ry: number;
  rz: number;
  pivot: Vec3;
}

export interface PlacementInput {
  /** Flat xyz vertex positions of the body mesh. */
  positions: ArrayLike<number>;
  min: Vec3;
  max: Vec3;
}

/** The affine map a transform feature with these parameters applies (same code as the kernel). */
export function placementAffine(t: PlacementTransform): Affine {
  return opsAffine(transformOps(t));
}

/**
 * Transform parameters that rotate the body by `rotation` about its box
 * centre and then drop it onto Z = 0 (lowest mesh vertex; the B-rep
 * minimum of curved faces can lie up to one tessellation deflection lower).
 * X/Y stay where the rotation leaves them.
 */
export function placementFor(body: PlacementInput, rotation: Mat3): PlacementTransform {
  const pivot: Vec3 = [
    (body.min[0] + body.max[0]) / 2,
    (body.min[1] + body.max[1]) / 2,
    (body.min[2] + body.max[2]) / 2,
  ];
  const angles = eulerXYZ(rotation);
  const rotationOnly: PlacementTransform = { ...angles, pivot, dx: 0, dy: 0, dz: 0 };
  const affine = placementAffine(rotationOnly);
  let minZ = Infinity;
  const p = body.positions;
  for (let i = 0; i < p.length; i += 3) {
    const z =
      affine.m[6]! * p[i]! + affine.m[7]! * p[i + 1]! + affine.m[8]! * p[i + 2]! + affine.t[2];
    if (z < minZ) minZ = z;
  }
  const dz = Number.isFinite(minZ) ? -minZ : 0;
  return { ...rotationOnly, dz: Math.abs(dz) < 1e-12 ? 0 : dz };
}

/** Place on plate: the face with outward normal `normal` ends up facing −Z on Z = 0. */
export function placeOnPlate(body: PlacementInput, normal: Vec3): PlacementTransform {
  return placementFor(body, rotationToDown(normal));
}

// ---- Auto orient ---------------------------------------------------------------------

export interface OrientationMesh extends PlacementInput {
  indices: ArrayLike<number>;
  /** Planar faces (outward normal, area) — the largest ones become candidates. */
  planarFaces?: { normal: Vec3; area: number; key?: string }[];
}

export interface OrientationCandidate {
  /** Short description, e.g. "Face 'Extrude 1 end' down" or "−Z down (as modelled)". */
  label: string;
  /** Outward direction that faces the plate. */
  down: Vec3;
  rotation: Mat3;
  transform: PlacementTransform;
  /** Overhang area beyond the threshold (triangles on the plate excluded), mm². */
  overhangAreaMm2: number;
  /** Height above the plate, mm. */
  heightMm: number;
  /** Area lying on the plate, mm². */
  contactAreaMm2: number;
  /** 1-based rank after sorting. */
  rank: number;
}

const PRINCIPAL: { down: Vec3; label: string }[] = [
  { down: [0, 0, -1], label: '−Z down (as modelled)' },
  { down: [0, 0, 1], label: '+Z down (upside down)' },
  { down: [1, 0, 0], label: '+X down' },
  { down: [-1, 0, 0], label: '−X down' },
  { down: [0, 1, 0], label: '+Y down' },
  { down: [0, -1, 0], label: '−Y down' },
];

/** Overhang area, height and plate contact of the mesh under `rotation`. */
export function orientationMetrics(
  mesh: OrientationMesh,
  rotation: Mat3,
  thresholdDeg: number,
): { overhangAreaMm2: number; heightMm: number; contactAreaMm2: number } {
  const p = mesh.positions;
  const idx = mesh.indices;
  const vertexCount = p.length / 3;
  const z = new Float64Array(vertexCount);
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let v = 0; v < vertexCount; v += 1) {
    const value =
      rotation[6] * p[v * 3]! + rotation[7] * p[v * 3 + 1]! + rotation[8] * p[v * 3 + 2]!;
    z[v] = value;
    if (value < minZ) minZ = value;
    if (value > maxZ) maxZ = value;
  }
  const plate = minZ + PLATE_EPSILON_MM;
  let overhang = 0;
  let contact = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!;
    const b = idx[t + 1]!;
    const c = idx[t + 2]!;
    const ux = p[b * 3]! - p[a * 3]!;
    const uy = p[b * 3 + 1]! - p[a * 3 + 1]!;
    const uz = p[b * 3 + 2]! - p[a * 3 + 2]!;
    const vx = p[c * 3]! - p[a * 3]!;
    const vy = p[c * 3 + 1]! - p[a * 3 + 1]!;
    const vz = p[c * 3 + 2]! - p[a * 3 + 2]!;
    const cross: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const len = Math.hypot(cross[0], cross[1], cross[2]);
    if (len === 0) continue;
    const nz = (rotation[6] * cross[0] + rotation[7] * cross[1] + rotation[8] * cross[2]) / len;
    const area = len / 2;
    const onPlate = Math.max(z[a]!, z[b]!, z[c]!) <= plate;
    if (onPlate) {
      if (nz < -0.999) contact += area;
      continue;
    }
    if (overhangAngleDeg(nz) > thresholdDeg + 0.01) overhang += area;
  }
  return { overhangAreaMm2: overhang, heightMm: maxZ - minZ, contactAreaMm2: contact };
}

/**
 * Candidate orientations — the six principal directions and the normals of
 * the largest planar faces (up to `maxFaces`, duplicates within 1° merged) —
 * ranked by overhang area (ties within 0.5 % of the surface area), then
 * height, then plate contact (larger first), then candidate order.
 */
export function rankOrientations(
  mesh: OrientationMesh,
  thresholdDeg: number,
  options: {
    maxFaces?: number;
    faceLabel?: (key: string | undefined, index: number) => string;
  } = {},
): OrientationCandidate[] {
  const candidates: { down: Vec3; label: string }[] = [...PRINCIPAL];
  const faces = [...(mesh.planarFaces ?? [])]
    .map((f, i) => ({ ...f, i }))
    .sort((a, b) => b.area - a.area || a.i - b.i)
    .slice(0, options.maxFaces ?? 8);
  for (const face of faces) {
    const down = normalize(face.normal);
    const duplicate = candidates.some(
      (c) =>
        c.down[0] * down[0] + c.down[1] * down[1] + c.down[2] * down[2] > Math.cos(Math.PI / 180),
    );
    if (duplicate) continue;
    candidates.push({
      down,
      label: options.faceLabel ? options.faceLabel(face.key, face.i) : `Face ${face.i + 1} down`,
    });
  }
  let totalArea = 0;
  {
    const p = mesh.positions;
    const idx = mesh.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t]! * 3;
      const b = idx[t + 1]! * 3;
      const c = idx[t + 2]! * 3;
      const ux = p[b]! - p[a]!;
      const uy = p[b + 1]! - p[a + 1]!;
      const uz = p[b + 2]! - p[a + 2]!;
      const vx = p[c]! - p[a]!;
      const vy = p[c + 1]! - p[a + 1]!;
      const vz = p[c + 2]! - p[a + 2]!;
      totalArea += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
  }
  const bucket = Math.max(1e-6, totalArea * 0.005);
  const evaluated = candidates.map((c, order) => {
    const rotation = rotationToDown(c.down);
    const metrics = orientationMetrics(mesh, rotation, thresholdDeg);
    return { ...c, order, rotation, ...metrics };
  });
  evaluated.sort(
    (a, b) =>
      Math.round(a.overhangAreaMm2 / bucket) - Math.round(b.overhangAreaMm2 / bucket) ||
      a.heightMm - b.heightMm ||
      b.contactAreaMm2 - a.contactAreaMm2 ||
      a.order - b.order,
  );
  return evaluated.map((c, i) => ({
    label: c.label,
    down: c.down,
    rotation: c.rotation,
    transform: placementFor(mesh, c.rotation),
    overhangAreaMm2: c.overhangAreaMm2,
    heightMm: c.heightMm,
    contactAreaMm2: c.contactAreaMm2,
    rank: i + 1,
  }));
}

/** Rotates and translates a flat xyz array by a placement (for previews). */
export function transformPositions(
  positions: ArrayLike<number>,
  t: PlacementTransform,
): Float32Array {
  const a = placementAffine(t);
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    out[i] = a.m[0]! * x + a.m[1]! * y + a.m[2]! * z + a.t[0];
    out[i + 1] = a.m[3]! * x + a.m[4]! * y + a.m[5]! * z + a.t[1];
    out[i + 2] = a.m[6]! * x + a.m[7]! * y + a.m[8]! * z + a.t[2];
  }
  return out;
}
