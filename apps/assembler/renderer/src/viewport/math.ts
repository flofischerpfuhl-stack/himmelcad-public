/**
 * Pure vector/matrix math for the Assembler viewport. No WebGL, no DOM — safe
 * to unit test with `node:test` (see `../../../test/viewport/math.test.ts`).
 *
 * Matrices are column-major `Float32Array(16)`, matching WebGL's convention:
 * `m[col * 4 + row]`. `multiplyMat4(a, b)` returns `a * b` (apply `b` first).
 */

export type Vec3 = readonly [number, number, number];
export type Mat4 = Float32Array;

export function vec3(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function subVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scaleVec3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dotVec3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function lengthVec3(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalizeVec3(a: Vec3): Vec3 {
  const len = lengthVec3(a) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}

export function identityMat4(): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/** `a * b` (apply `b`'s transform first, then `a`'s). */
export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

export function perspectiveMat4(
  fovYRadians: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) * nf,
    -1,
    0,
    0,
    2 * far * near * nf,
    0,
  ]);
}

export function lookAtMat4(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = normalizeVec3(subVec3(eye, target));
  const x = normalizeVec3(crossVec3(up, z));
  const y = crossVec3(z, x);
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dotVec3(x, eye),
    -dotVec3(y, eye),
    -dotVec3(z, eye),
    1,
  ]);
}

/** Returns `null` for a singular matrix instead of a `NaN`-filled result. */
export function invertMat4(m: Mat4): Mat4 | null {
  const inv = new Float32Array(16);
  const a = m;
  inv[0] =
    a[5]! * a[10]! * a[15]! -
    a[5]! * a[11]! * a[14]! -
    a[9]! * a[6]! * a[15]! +
    a[9]! * a[7]! * a[14]! +
    a[13]! * a[6]! * a[11]! -
    a[13]! * a[7]! * a[10]!;
  inv[4] =
    -a[4]! * a[10]! * a[15]! +
    a[4]! * a[11]! * a[14]! +
    a[8]! * a[6]! * a[15]! -
    a[8]! * a[7]! * a[14]! -
    a[12]! * a[6]! * a[11]! +
    a[12]! * a[7]! * a[10]!;
  inv[8] =
    a[4]! * a[9]! * a[15]! -
    a[4]! * a[11]! * a[13]! -
    a[8]! * a[5]! * a[15]! +
    a[8]! * a[7]! * a[13]! +
    a[12]! * a[5]! * a[11]! -
    a[12]! * a[7]! * a[9]!;
  inv[12] =
    -a[4]! * a[9]! * a[14]! +
    a[4]! * a[10]! * a[13]! +
    a[8]! * a[5]! * a[14]! -
    a[8]! * a[6]! * a[13]! -
    a[12]! * a[5]! * a[10]! +
    a[12]! * a[6]! * a[9]!;
  inv[1] =
    -a[1]! * a[10]! * a[15]! +
    a[1]! * a[11]! * a[14]! +
    a[9]! * a[2]! * a[15]! -
    a[9]! * a[3]! * a[14]! -
    a[13]! * a[2]! * a[11]! +
    a[13]! * a[3]! * a[10]!;
  inv[5] =
    a[0]! * a[10]! * a[15]! -
    a[0]! * a[11]! * a[14]! -
    a[8]! * a[2]! * a[15]! +
    a[8]! * a[3]! * a[14]! +
    a[12]! * a[2]! * a[11]! -
    a[12]! * a[3]! * a[10]!;
  inv[9] =
    -a[0]! * a[9]! * a[15]! +
    a[0]! * a[11]! * a[13]! +
    a[8]! * a[1]! * a[15]! -
    a[8]! * a[3]! * a[13]! -
    a[12]! * a[1]! * a[11]! +
    a[12]! * a[3]! * a[9]!;
  inv[13] =
    a[0]! * a[9]! * a[14]! -
    a[0]! * a[10]! * a[13]! -
    a[8]! * a[1]! * a[14]! +
    a[8]! * a[2]! * a[13]! +
    a[12]! * a[1]! * a[10]! -
    a[12]! * a[2]! * a[9]!;
  inv[2] =
    a[1]! * a[6]! * a[15]! -
    a[1]! * a[7]! * a[14]! -
    a[5]! * a[2]! * a[15]! +
    a[5]! * a[3]! * a[14]! +
    a[13]! * a[2]! * a[7]! -
    a[13]! * a[3]! * a[6]!;
  inv[6] =
    -a[0]! * a[6]! * a[15]! +
    a[0]! * a[7]! * a[14]! +
    a[4]! * a[2]! * a[15]! -
    a[4]! * a[3]! * a[14]! -
    a[12]! * a[2]! * a[7]! +
    a[12]! * a[3]! * a[6]!;
  inv[10] =
    a[0]! * a[5]! * a[15]! -
    a[0]! * a[7]! * a[13]! -
    a[4]! * a[1]! * a[15]! +
    a[4]! * a[3]! * a[13]! +
    a[12]! * a[1]! * a[7]! -
    a[12]! * a[3]! * a[5]!;
  inv[14] =
    -a[0]! * a[5]! * a[14]! +
    a[0]! * a[6]! * a[13]! +
    a[4]! * a[1]! * a[14]! -
    a[4]! * a[2]! * a[13]! -
    a[12]! * a[1]! * a[6]! +
    a[12]! * a[2]! * a[5]!;
  inv[3] =
    -a[1]! * a[6]! * a[11]! +
    a[1]! * a[7]! * a[10]! +
    a[5]! * a[2]! * a[11]! -
    a[5]! * a[3]! * a[10]! -
    a[9]! * a[2]! * a[7]! +
    a[9]! * a[3]! * a[6]!;
  inv[7] =
    a[0]! * a[6]! * a[11]! -
    a[0]! * a[7]! * a[10]! -
    a[4]! * a[2]! * a[11]! +
    a[4]! * a[3]! * a[10]! +
    a[8]! * a[2]! * a[7]! -
    a[8]! * a[3]! * a[6]!;
  inv[11] =
    -a[0]! * a[5]! * a[11]! +
    a[0]! * a[7]! * a[9]! +
    a[4]! * a[1]! * a[11]! -
    a[4]! * a[3]! * a[9]! -
    a[8]! * a[1]! * a[7]! +
    a[8]! * a[3]! * a[5]!;
  inv[15] =
    a[0]! * a[5]! * a[10]! -
    a[0]! * a[6]! * a[9]! -
    a[4]! * a[1]! * a[10]! +
    a[4]! * a[2]! * a[9]! +
    a[8]! * a[1]! * a[6]! -
    a[8]! * a[2]! * a[5]!;
  const det = a[0]! * inv[0]! + a[1]! * inv[4]! + a[2]! * inv[8]! + a[3]! * inv[12]!;
  if (Math.abs(det) < 1e-12) return null;
  for (let i = 0; i < 16; i += 1) inv[i] = inv[i]! / det;
  return inv;
}

/** Full homogeneous transform (divides by `w`); used for camera/ray math. */
export function transformPoint4(m: Mat4, p: Vec3): { x: number; y: number; z: number; w: number } {
  const x = m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!;
  const y = m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!;
  const z = m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!;
  const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
  return { x, y, z, w };
}

/** Projects a world point to pixel coordinates; `null` when behind the eye. */
export function projectToScreen(
  m: Mat4,
  p: Vec3,
  width: number,
  height: number,
): [number, number] | null {
  const { x, y, w } = transformPoint4(m, p);
  if (w <= 1e-6) return null;
  return [((x / w + 1) / 2) * width, ((1 - y / w) / 2) * height];
}

/** Unprojects a screen point into a world-space ray (origin + normalized direction). */
export function unprojectRay(
  viewProj: Mat4,
  clientX: number,
  clientY: number,
  width: number,
  height: number,
): { origin: Vec3; direction: Vec3 } | null {
  const inv = invertMat4(viewProj);
  if (!inv) return null;
  const nx = (clientX / width) * 2 - 1;
  const ny = 1 - (clientY / height) * 2;
  const near = transformPoint4(inv, [nx, ny, -1]);
  const far = transformPoint4(inv, [nx, ny, 1]);
  if (Math.abs(near.w) < 1e-9 || Math.abs(far.w) < 1e-9) return null;
  const origin: Vec3 = [near.x / near.w, near.y / near.w, near.z / near.w];
  const farPoint: Vec3 = [far.x / far.w, far.y / far.w, far.z / far.w];
  return { origin, direction: normalizeVec3(subVec3(farPoint, origin)) };
}

/**
 * Intersects a ray with a plane through `planeOrigin` with normal
 * `planeNormal`. Returns `null` when the ray is parallel to the plane or the
 * intersection is behind the ray origin.
 */
export function rayPlaneIntersect(
  rayOrigin: Vec3,
  rayDirection: Vec3,
  planeOrigin: Vec3,
  planeNormal: Vec3,
): Vec3 | null {
  const denom = dotVec3(rayDirection, planeNormal);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dotVec3(subVec3(planeOrigin, rayOrigin), planeNormal) / denom;
  if (t < 0) return null;
  return addVec3(rayOrigin, scaleVec3(rayDirection, t));
}

/** Closest point on an infinite line through `lineOrigin` along unit `lineDirection` to `rayOrigin`+`rayDirection`. */
export function closestPointOnLineToRay(
  lineOrigin: Vec3,
  lineDirection: Vec3,
  rayOrigin: Vec3,
  rayDirection: Vec3,
): number {
  // Standard closest-point-between-two-lines solve, returning the parameter
  // along `lineDirection` (line = lineOrigin + t * lineDirection).
  const d1 = lineDirection;
  const d2 = rayDirection;
  const r = subVec3(lineOrigin, rayOrigin);
  const a = dotVec3(d1, d1);
  const e = dotVec3(d2, d2);
  const f = dotVec3(d2, r);
  const b = dotVec3(d1, d2);
  const c = dotVec3(d1, r);
  const denom = a * e - b * b;
  if (Math.abs(denom) < 1e-9) return 0;
  return (b * f - c * e) / denom;
}
