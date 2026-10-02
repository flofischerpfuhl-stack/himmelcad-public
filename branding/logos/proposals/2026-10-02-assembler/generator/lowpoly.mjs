/**
 * Flat-shaded low-poly renderer in plain Node: a mesh of planar faces ->
 * orthographic projection -> polygons coloured from the Himmel:CAD azure
 * ramp. A port of `../../2026-09-25/round-2/generator/lp3d.py` (same ramp,
 * same light direction, same painter's order by layer then depth), so the
 * Assembler mark is shaded like the hard hat, crystal and aperture.
 */

export const AZ_RAMP = [
  '#003F7A',
  '#0056A8',
  '#0076D8',
  '#0084E8',
  '#1597F2',
  '#3EACF5',
  '#55B8FF',
  '#92D5FF',
  '#BDE8FF',
  '#D8F3FF',
  '#E7F7FF',
  '#F8FDFF',
];

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l ? [v[0] / l, v[1] / l, v[2] / l] : v;
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const LIGHT = norm([-0.55, 0.75, 0.45]);

/** Newell normal of a planar polygon (counter-clockwise seen from outside). */
export function normal(pts) {
  let n = [0, 0, 0];
  for (let i = 0; i < pts.length; i += 1) {
    const c = cross(pts[i], pts[(i + 1) % pts.length]);
    n = [n[0] + c[0], n[1] + c[1], n[2] + c[2]];
  }
  return norm(n);
}

const centroid = (pts) => {
  const s = pts.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]);
  return [s[0] / pts.length, s[1] / pts.length, s[2] / pts.length];
};

/**
 * A face. `inside`: a point the normal must point away from (fixes the
 * winding); `layer`: higher layers paint later; `shade`: added to the light
 * value; `color`: fixed colour (no lighting).
 */
export function face(pts, { inside, layer = 0, shade = 0, color } = {}) {
  let p = pts.map((q) => [...q]);
  if (inside) {
    if (dot(normal(p), sub(centroid(p), inside)) < 0) p = p.reverse();
  }
  return { pts: p, layer, shade, color };
}

const rad = (deg) => (deg * Math.PI) / 180;
export const rotX = (a) => {
  const c = Math.cos(rad(a));
  const s = Math.sin(rad(a));
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ];
};
export const rotY = (a) => {
  const c = Math.cos(rad(a));
  const s = Math.sin(rad(a));
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ];
};
export const rotZ = (a) => {
  const c = Math.cos(rad(a));
  const s = Math.sin(rad(a));
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
};
/** Matrix product a·b (3x3). */
export const mul = (a, b) =>
  a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const apply = (m, p) => [dot(m[0], p), dot(m[1], p), dot(m[2], p)];

/**
 * Projects and shades `faces` with rotation `R` (view: x right, y up, z
 * toward the viewer), culls back faces, paints back to front and fits the
 * result into a `size` square with `margin`. Returns `[{ color, pts }]`.
 */
export function render(
  faces,
  R,
  { ramp = AZ_RAMP, size = 256, margin = 18, lo = 0, hi = 1, cull = true } = {},
) {
  const items = [];
  for (const f of faces) {
    const p = f.pts.map((q) => apply(R, q));
    const n = normal(p);
    if (cull && n[2] <= 1e-6) continue;
    let color = f.color;
    if (!color) {
      const lam = dot(n, LIGHT);
      const v = Math.min(Math.max((lam - lo) / (hi - lo) + f.shade, 0), 0.999);
      color = ramp[Math.floor(v * ramp.length)];
    }
    items.push({ layer: f.layer, depth: p.reduce((s, q) => s + q[2], 0) / p.length, color, p });
  }
  items.sort((a, b) => a.layer - b.layer || a.depth - b.depth);
  const xs = items.flatMap((t) => t.p.map((q) => q[0]));
  const ys = items.flatMap((t) => t.p.map((q) => q[1]));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = (size - 2 * margin) / Math.max(x1 - x0, y1 - y0);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const r1 = (v) => Math.round(v * 10) / 10;
  return items.map((t) => ({
    color: t.color,
    pts: t.p.map((q) => [r1(size / 2 + (q[0] - cx) * s), r1(size / 2 - (q[1] - cy) * s)]),
  }));
}

const inside2d = (pt, poly) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)
      hit = !hit;
  }
  return hit;
};

/**
 * The family's `-on-light` "tone" treatment: very light facets (ramp index
 * >= `from`) that lie on the outline get `shift` steps darker, so the mark
 * holds its silhouette on white. An edge is on the outline when a point just
 * outside its midpoint is covered by no polygon.
 */
export function onLight(polys, { from = 8, shift = 3, ramp = AZ_RAMP } = {}) {
  const covered = (pt) => polys.some((p) => inside2d(pt, p.pts));
  return polys.map((p) => {
    const index = ramp.indexOf(p.color);
    if (index < from) return p;
    const n = p.pts.length;
    const cx = p.pts.reduce((s, q) => s + q[0], 0) / n;
    const cy = p.pts.reduce((s, q) => s + q[1], 0) / n;
    const outline = p.pts.some((a, i) => {
      const b = p.pts[(i + 1) % n];
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      // step 1.5 units from the midpoint, away from the polygon's centre
      let ex = -(b[1] - a[1]);
      let ey = b[0] - a[0];
      if (ex * (mx - cx) + ey * (my - cy) < 0) [ex, ey] = [-ex, -ey];
      const l = Math.hypot(ex, ey) || 1;
      return (
        Math.hypot(b[0] - a[0], b[1] - a[1]) > 4 &&
        !covered([mx + (1.5 * ex) / l, my + (1.5 * ey) / l])
      );
    });
    return outline ? { ...p, color: ramp[Math.max(0, index - shift)] } : p;
  });
}

/** The family's SVG layout (`branding/logos/source/*.svg`). */
export function toSvg(polys, { title, id }) {
  const lines = polys.map(
    (p) =>
      `    <polygon fill="${p.color}" points="${p.pts.map((q) => `${q[0]} ${q[1]}`).join(' ')}"/>`,
  );
  return `<svg
  width="256"
  height="256"
  viewBox="0 0 256 256"
  xmlns="http://www.w3.org/2000/svg"
>
  <title>${title}</title>

  <g
    id="${id}"
    stroke="none"
    fill-rule="evenodd"
  >
${lines.join('\n')}
  </g>
</svg>
`;
}

// ---------------------------------------------------------------------------
// Primitives (z up)

export const ring = (n, r, z, phase = 0) =>
  Array.from({ length: n }, (_, k) => {
    const a = phase + (2 * Math.PI * k) / n;
    return [r * Math.cos(a), r * Math.sin(a), z];
  });

/** Side faces between two rings of equal length (`a` lower, `b` upper), normals away from the axis. */
export function band(a, b, opts = {}) {
  const faces = [];
  for (let k = 0; k < a.length; k += 1) {
    const k1 = (k + 1) % a.length;
    const quad = [a[k], a[k1], b[k1], b[k]];
    const c = centroid(quad);
    const inside = opts.inward ? [c[0] * 2, c[1] * 2, c[2]] : [0, 0, c[2]];
    faces.push(face(quad, { ...opts, inside }));
  }
  return faces;
}

/** A cap polygon (ring) facing up (`up`) or down. */
export function cap(r, up, opts = {}) {
  const c = centroid(r);
  return face(r, { ...opts, inside: [c[0], c[1], c[2] + (up ? -1 : 1)] });
}
