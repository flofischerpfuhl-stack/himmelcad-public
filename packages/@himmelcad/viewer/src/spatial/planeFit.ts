import { Matrix3, Vector3 } from 'three';

/**
 * Local plane fitted to a point neighbourhood, used for "interpolated
 * surface" snap candidates so the cursor stays on a smooth surface even in
 * gaps between point samples.
 */
export interface LocalPlane {
  origin: Vector3;
  normal: Vector3;
  /** Smallest eigenvalue / trace. Lower = flatter neighbourhood. */
  planarity: number;
}

const COV = new Matrix3();
const SHIFTED = new Matrix3();
const TMP_VEC = new Vector3();
const POWER_VEC = new Vector3(0.5, 0.7, 0.3);

/**
 * Weighted PCA plane fit. `weights` typically `1 / max(eps, distSqToQuery)`
 * so closer neighbours dominate. Returns `null` if input is degenerate.
 */
export function fitPlane(points: readonly Vector3[], weights: readonly number[]): LocalPlane | null {
  if (points.length < 3 || points.length !== weights.length) return null;

  let weightSum = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < points.length; i++) {
    const w = weights[i] ?? 0;
    const p = points[i];
    if (!p || w <= 0) continue;
    weightSum += w;
    cx += p.x * w;
    cy += p.y * w;
    cz += p.z * w;
  }
  if (weightSum <= 0) return null;
  const cInv = 1 / weightSum;
  cx *= cInv;
  cy *= cInv;
  cz *= cInv;

  let cxx = 0;
  let cyy = 0;
  let czz = 0;
  let cxy = 0;
  let cxz = 0;
  let cyz = 0;
  for (let i = 0; i < points.length; i++) {
    const w = weights[i] ?? 0;
    const p = points[i];
    if (!p || w <= 0) continue;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dz = p.z - cz;
    cxx += w * dx * dx;
    cyy += w * dy * dy;
    czz += w * dz * dz;
    cxy += w * dx * dy;
    cxz += w * dx * dz;
    cyz += w * dy * dz;
  }

  // Three.js Matrix3 is column-major in `.set(...)` convention but row-major
  // in argument order. We are storing a symmetric covariance, so it doesn't
  // matter — both axes carry the same structure.
  COV.set(cxx, cxy, cxz, cxy, cyy, cyz, cxz, cyz, czz);

  const result = smallestEigenvector(COV);
  if (!result) return null;
  return {
    origin: new Vector3(cx, cy, cz),
    normal: result.vector,
    planarity: result.lambdaRatio,
  };
}

/**
 * Intersect a ray with a plane. Returns the world-space hit, or null if the
 * ray is parallel to the plane or pointing away from it.
 */
export function intersectRayPlane(
  rayOrigin: Vector3,
  rayDir: Vector3,
  plane: LocalPlane,
  out?: Vector3,
): Vector3 | null {
  const denom = rayDir.dot(plane.normal);
  if (Math.abs(denom) < 1e-6) return null;
  TMP_VEC.copy(plane.origin).sub(rayOrigin);
  const t = TMP_VEC.dot(plane.normal) / denom;
  if (t < 0) return null;
  const target = out ?? new Vector3();
  return target.copy(rayDir).multiplyScalar(t).add(rayOrigin);
}

/**
 * Inverse-power iteration on a small ridge-shifted matrix. Converges to the
 * eigenvector of the smallest eigenvalue. Adequate for 3x3 PSD covariances.
 */
function smallestEigenvector(cov: Matrix3): { vector: Vector3; lambdaRatio: number } | null {
  const e = cov.elements;
  const trace = (e[0] ?? 0) + (e[4] ?? 0) + (e[8] ?? 0);
  if (trace <= Number.EPSILON) return null;

  const shift = trace * 1e-3;
  SHIFTED.copy(cov);
  const se = SHIFTED.elements;
  se[0] -= shift;
  se[4] -= shift;
  se[8] -= shift;

  // det(SHIFTED) — bail out if non-invertible.
  if (Math.abs(SHIFTED.determinant()) < 1e-15) {
    return { vector: principalAxisFallback(cov), lambdaRatio: 0 };
  }

  // Three.js Matrix3 has no built-in invert that returns null; use copy + invert.
  const inv = SHIFTED.clone().invert();
  const v = TMP_VEC.copy(POWER_VEC).normalize();
  for (let it = 0; it < 32; it++) {
    v.applyMatrix3(inv);
    const len = v.length();
    if (len < Number.EPSILON) {
      return { vector: principalAxisFallback(cov), lambdaRatio: 0 };
    }
    v.divideScalar(len);
  }

  const cv = v.clone().applyMatrix3(cov);
  const lambda = Math.max(0, cv.dot(v));
  return { vector: v.clone().normalize(), lambdaRatio: lambda / Math.max(trace, Number.EPSILON) };
}

function principalAxisFallback(cov: Matrix3): Vector3 {
  const e = cov.elements;
  const dx = e[0] ?? 0;
  const dy = e[4] ?? 0;
  const dz = e[8] ?? 0;
  if (dx <= dy && dx <= dz) return new Vector3(1, 0, 0);
  if (dy <= dz) return new Vector3(0, 1, 0);
  return new Vector3(0, 0, 1);
}
