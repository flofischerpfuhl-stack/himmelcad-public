#!/usr/bin/env node
/**
 * Himmel:CAD Builder shovel mark candidates (2026-10-04): low-poly 3D shovels
 * in the family's azure ramp and light (renderer shared with the Assembler
 * bolt), rendered to the family's SVG layout.
 *
 *   node candidates.mjs <out-dir>
 *
 * n3         folding-spade shovel, bold proportions, short lofted socket
 * f1 .. f3   n3 with the grip as one continuous mitred frame in the shaft's thickness
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  face,
  mul,
  onLight,
  render,
  rotX,
  rotZ,
  toSvg,
} from '../../2026-10-02-assembler/generator/lowpoly.mjs';

const view = (elev, yaw, roll = 0) => mul(rotZ(roll), mul(rotX(elev - 90), rotZ(yaw)));

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (v) => scale(v, 1 / Math.hypot(...v));
const mid = (pts) => scale(pts.reduce(add, [0, 0, 0]), 1 / pts.length);

/** Polygon ring of radius `r` around `c`, perpendicular to `axis`. */
function ringAt(c, axis, r, n, phase) {
  const a = unit(axis);
  const helper = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = unit(cross(a, helper));
  const v = cross(a, u);
  return Array.from({ length: n }, (_, k) => {
    const t = phase + (2 * Math.PI * k) / n;
    return add(c, add(scale(u, r * Math.cos(t)), scale(v, r * Math.sin(t))));
  });
}

/** Prism from p0 (radius r0) to p1 (radius r1), optional end caps. */
function tube(p0, p1, r0, r1, { sides = 6, phase = Math.PI / 6, layer = 0, caps = true } = {}) {
  const axis = sub(p1, p0);
  const a = ringAt(p0, axis, r0, sides, phase);
  const b = ringAt(p1, axis, r1, sides, phase);
  const centre = mid([p0, p1]);
  const faces = [];
  for (let k = 0; k < sides; k += 1) {
    const k1 = (k + 1) % sides;
    const quad = [a[k], a[k1], b[k1], b[k]];
    // inside: the closest axis point to the quad's centre
    const q = mid(quad);
    const t =
      ((q[0] - p0[0]) * axis[0] + (q[1] - p0[1]) * axis[1] + (q[2] - p0[2]) * axis[2]) /
      (axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2);
    faces.push(face(quad, { inside: add(p0, scale(axis, t)), layer }));
  }
  if (caps) {
    faces.push(face(a, { inside: centre, layer }));
    faces.push(face(b, { inside: centre, layer }));
  }
  return faces;
}

/**
 * Blade in the x/z plane (z up, front toward -y, the viewer's side). `rows`:
 * [z, halfWidth] from the tip up (halfWidth 0: a point); `cols`: points across
 * each row; `dish`: how far the centre line sits behind the edges (concave
 * front, which gives the facets their spread of tones); `t`: sheet thickness
 * for the rolled top edge (the tread).
 */
function blade(rows, { dish = 0.12, cols = 5, t = 0.035, layer = 0, shade = 0 } = {}) {
  const across = Array.from({ length: cols }, (_, i) => (2 * i) / (cols - 1) - 1);
  const front = rows.map(([z, w]) =>
    w === 0 ? [[0, dish * 0.4, z]] : across.map((u) => [u * w, dish * (1 - u * u), z]),
  );
  const faces = [];
  const inside = [0, dish + 1, rows[Math.floor(rows.length / 2)][0]];
  const tri = (p, q, r) => faces.push(face([p, q, r], { inside, layer, shade }));
  for (let i = 0; i + 1 < front.length; i += 1) {
    const lo = front[i];
    const hi = front[i + 1];
    for (let k = 0; k + 1 < hi.length; k += 1) {
      // diagonals mirror about the centre line: strip k on the right flips strip (cols - 2 - k)
      const left = Math.min(k, cols - 2 - k);
      const flip = ((left + i) % 2 === 0) !== k < (cols - 1) / 2;
      if (lo.length === 1) tri(lo[0], hi[k + 1], hi[k]);
      else if (flip) {
        tri(lo[k], lo[k + 1], hi[k]);
        tri(lo[k + 1], hi[k + 1], hi[k]);
      } else {
        tri(lo[k], hi[k + 1], hi[k]);
        tri(lo[k], lo[k + 1], hi[k + 1]);
      }
    }
  }
  const top = front[front.length - 1];
  const zt = rows[rows.length - 1][0];
  const back = top.map((p) => [p[0], p[1] + t * 3, zt + t]);
  for (let k = 0; k + 1 < top.length; k += 1) {
    faces.push(
      face([top[k], top[k + 1], back[k + 1], back[k]], {
        inside: [0, dish + 1, zt - 1],
        layer: layer + 1,
        shade: shade + 0.1,
      }),
    );
  }
  return faces;
}

/** D-grip: two arms from the shaft top out to a cross bar. */
function dGrip(
  top,
  { span = 0.2, height = 0.28, r = 0.045, base = 0, bar = 1.25, layer = 0 } = {},
) {
  const l = add(top, [-span, 0, height]);
  const rr = add(top, [span, 0, height]);
  return [
    ...tube(add(top, [-base, 0, 0]), l, r, r, { layer, caps: false }),
    ...tube(add(top, [base, 0, 0]), rr, r, r, { layer, caps: false }),
    ...tube(add(l, [-0.03, 0, 0]), add(rr, [0.03, 0, 0]), r * bar, r * bar, {
      layer: layer + 1,
    }),
  ];
}

/**
 * Triangular grip as one continuous frame with the shaft's cross-section: the
 * shaft's hexagon shows two front facets meeting in a ridge, and so does every
 * bar of the frame. Corners are mitred (outer edge, ridge and inner edge meet
 * in one line), and the shaft runs into the frame's bottom corner without a
 * seam. `top`: centre of the shaft's top ring (vertex toward the viewer);
 * `r`: shaft radius; `span`: half width of the top bar's centre line; `height`:
 * from the shaft top to the top bar's centre line; `cut`: the outer top corners
 * are cut off this far (x half the bar width) along both edges, so the mitre
 * tips do not stretch the grip.
 */
function frameGrip(top, r, { span = 0.3, height = 0.5, cut = 0, layer = 0 } = {}) {
  const d = r * Math.cos(Math.PI / 6); // half the bar width = half the shaft's front width
  const yEdge = top[1] - r / 2;
  const yRidge = top[1] - r;
  const yBack = top[1] + r / 2;
  // centre-line triangle in (x, z), bottom corner C0 at the origin for now
  const alpha = Math.atan2(span, height); // arm angle from the vertical (provisional)
  const zLift = d * Math.tan(alpha / 2); // the outer arm edges meet the shaft's sides this far below C0
  const C0 = [0, zLift];
  const zBar = height; // centre line of the top bar (from the shaft top)
  const C1 = [-span, zBar];
  const C2 = [span, zBar];
  // 2D line helpers: a line as [point, direction]
  const offset = ([p, dir], dist) => {
    const n = [dir[1], -dir[0]]; // right-hand normal
    const l = Math.hypot(...n);
    return [[p[0] + (n[0] / l) * dist, p[1] + (n[1] / l) * dist], dir];
  };
  const meet = ([p, a], [q, b]) => {
    const den = a[0] * b[1] - a[1] * b[0];
    const t = ((q[0] - p[0]) * b[1] - (q[1] - p[1]) * b[0]) / den;
    return [p[0] + a[0] * t, p[1] + a[1] * t];
  };
  const dir = (a, b) => [b[0] - a[0], b[1] - a[1]];
  // edges around the triangle counter-clockwise: right arm up, top bar leftward, left arm down
  const right = [C0, dir(C0, C2)];
  const bar = [C2, dir(C2, C1)];
  const left = [C1, dir(C1, C0)];
  // counter-clockwise: the right-hand normal points outward
  const out = (l) => offset(l, d);
  const inn = (l) => offset(l, -d);
  const O1 = meet(out(bar), out(left));
  const O2 = meet(out(right), out(bar));
  const I0 = meet(inn(left), inn(right));
  const I1 = meet(inn(bar), inn(left));
  const I2 = meet(inn(right), inn(bar));
  const PL = meet(out(left), [
    [-d, 0],
    [0, 1],
  ]);
  const PR = meet(out(right), [
    [d, 0],
    [0, 1],
  ]);
  // lift so the outer edges meet the shaft's sides exactly at the shaft top
  const dz = -PL[1];
  const at = ([x, z], y) => [x, y, top[2] + z + dz];
  const F = [0, yRidge, top[2]];
  const p = {
    PL: at(PL, yEdge),
    PR: at(PR, yEdge),
    O1: at(O1, yEdge),
    O2: at(O2, yEdge),
    I0: at(I0, yEdge),
    I1: at(I1, yEdge),
    I2: at(I2, yEdge),
    C0: at(C0, yRidge),
    C1: at(C1, yRidge),
    C2: at(C2, yRidge),
  };
  const behind = [0, yBack + 1, top[2] + height / 2];
  // outer top corners, optionally cut: [a, b] along the arm and along the bar
  const toward = (from, to, len) => {
    const v = sub(to, from);
    return add(from, scale(v, len / Math.hypot(...v)));
  };
  const c = cut * d;
  const L = c ? [toward(p.O1, p.PL, c), toward(p.O1, p.O2, c)] : [p.O1, p.O1];
  const R = c ? [toward(p.O2, p.O1, c), toward(p.O2, p.PR, c)] : [p.O2, p.O2];
  const faces = [];
  const f = (...pts) => faces.push(face(pts, { inside: behind, layer: layer + 1 }));
  // outer halves (outer edge to ridge), mitred at C1 and C2; the cut corners get a facet each
  f(p.PL, L[0], p.C1, p.C0);
  f(L[1], R[0], p.C2, p.C1);
  f(R[1], p.PR, p.C0, p.C2);
  if (c) {
    f(L[0], L[1], p.C1);
    f(R[0], R[1], p.C2);
  }
  // inner halves (ridge to inner edge), mitred at C0/I0, C1/I1, C2/I2
  f(p.C0, p.C1, p.I1, p.I0);
  f(p.C1, p.C2, p.I2, p.I1);
  f(p.C2, p.C0, p.I0, p.I2);
  // the shaft's ridge runs up into the bottom corner
  f(p.PL, p.C0, F);
  f(F, p.C0, p.PR);
  // sides toward the back (seen only where they turn toward the viewer: the top, the hole's lower edges)
  const back = (q) => [q[0], yBack, q[2]];
  const side = (a, b, inside) => faces.push(face([a, b, back(b), back(a)], { inside, layer }));
  // inner sides: the material lies on the far side of each edge from the hole's centre
  const hole = mid([p.I0, p.I1, p.I2]);
  const away = (a, b) => {
    const m = mid([a, b]);
    return [2 * m[0] - hole[0], top[1], 2 * m[2] - hole[2]];
  };
  // outer sides: the material lies toward the frame's centre
  const centre = mid([p.C0, p.C1, p.C2]);
  const outside = () => [centre[0], top[1], centre[2]];
  side(L[1], R[0], outside(L[1], R[0]));
  if (c) {
    side(L[0], L[1], outside(L[0], L[1]));
    side(R[0], R[1], outside(R[0], R[1]));
  }
  side(p.I0, p.I1, away(p.I0, p.I1));
  side(p.I1, p.I2, away(p.I1, p.I2));
  side(p.I2, p.I0, away(p.I2, p.I0));
  side(p.PL, L[0], outside(p.PL, L[0]));
  side(R[1], p.PR, outside(R[1], p.PR));
  return faces;
}

/**
 * Box D-grip as a faceted plate: an octagonal frame (rounded rectangle) of
 * outer size `w` x `h` around a hole `hw` x `hh`, its bottom on the shaft
 * top. The inner ring sits `bevel` toward the viewer so the frame's facets
 * take different tones; `t` is the plate thickness.
 */
function plateGrip(
  top,
  {
    w = 0.8,
    h = 0.55,
    hw = 0.5,
    hh = 0.28,
    c = 0.16,
    hc = 0.1,
    t = 0.14,
    bevel = 0.06,
    layer = 0,
  } = {},
) {
  const oct = (cx, cz, ww, hh2, ch, y) => [
    [cx - ww / 2 + ch, y, cz - hh2 / 2],
    [cx + ww / 2 - ch, y, cz - hh2 / 2],
    [cx + ww / 2, y, cz - hh2 / 2 + ch],
    [cx + ww / 2, y, cz + hh2 / 2 - ch],
    [cx + ww / 2 - ch, y, cz + hh2 / 2],
    [cx - ww / 2 + ch, y, cz + hh2 / 2],
    [cx - ww / 2, y, cz + hh2 / 2 - ch],
    [cx - ww / 2, y, cz - hh2 / 2 + ch],
  ];
  const cz = top[2] + h / 2 - 0.04;
  const y = top[1] - t / 2;
  const outer = oct(0, cz, w, h, c, y);
  const inner = oct(0, cz + 0.03, hw, hh, hc, y - bevel);
  const outerBack = oct(0, cz, w, h, c, y + t);
  const faces = [];
  const behind = [0, y + 1, cz];
  for (let k = 0; k < 8; k += 1) {
    const k1 = (k + 1) % 8;
    faces.push(
      face([outer[k], outer[k1], inner[k1], inner[k]], { inside: behind, layer: layer + 1 }),
    );
    // the outer rim, seen when the face turns toward the viewer
    faces.push(
      face([outer[k], outer[k1], outerBack[k1], outerBack[k]], {
        inside: [0, y + t / 2, cz],
        layer,
      }),
    );
  }
  return faces;
}

/**
 * Socket that joins shaft and blade: lofted from the shaft's hexagon at
 * `zTop` down to a flat tongue lying on the blade's front at `zBottom`
 * (`tongue`: the tongue's half width), so the shaft grows out of the blade
 * instead of floating in front of it. Triangulated (the loft is not planar).
 */
function loftSocket({ y, r, zTop, zBottom, tongue, dish, W, layer = 0 }) {
  const top = ringAt([0, y, zTop], [0, 0, 1], r, 6, Math.PI / 6);
  const surface = (x) => dish * (1 - Math.min(1, (x / W) ** 2));
  const k = tongue / (r * Math.cos(Math.PI / 6));
  const bottom = top.map(([x, yy]) => {
    const dx = x * k;
    const front = yy - y < -1e-9;
    return [dx, surface(dx) + (front ? -0.012 : 0.06), zBottom];
  });
  const faces = [];
  const inside = (pts) => {
    const m = mid(pts);
    return [0, y + r, m[2]];
  };
  // quads 0, 4, 5 lie left of the centre line, 1, 2, 3 are their mirror images:
  // the diagonals flip with the side so the socket stays symmetric
  for (let n = 0; n < 6; n += 1) {
    const n1 = (n + 1) % 6;
    const left = n === 0 || n >= 4;
    const tris = left
      ? [
          [bottom[n], bottom[n1], top[n1]],
          [bottom[n], top[n1], top[n]],
        ]
      : [
          [bottom[n], bottom[n1], top[n]],
          [bottom[n1], top[n1], top[n]],
        ];
    for (const t of tris) faces.push(face(t, { inside: inside(t), layer }));
  }
  return faces;
}

/**
 * A shovel: blade, tapered socket sleeve (reaching `sleeve` down onto the
 * blade), shaft, optional `collars` ([height above the blade, length, radius
 * factor], e.g. the folding spade's locking nut), D-grip.
 */
export function shovel({
  rows,
  dish,
  cols = 5,
  shaft = 1.3,
  r = 0.055,
  socket = 0.3,
  sleeve = 0.12,
  sleeveR = [2.1, 1.15],
  tongue = 0,
  collars = [],
  grip = {},
  bladeShade = 0,
} = {}) {
  const zt = rows[rows.length - 1][0];
  const faces = [];
  faces.push(...blade(rows, { dish, cols, layer: 0, shade: bladeShade }));
  const y = dish * 0.6;
  const s0 = [0, dish * 0.9, zt - sleeve];
  const s1 = [0, y, zt + socket];
  if (tongue) {
    const W = rows[rows.length - 1][1];
    faces.push(
      ...loftSocket({ y, r, zTop: zt + socket, zBottom: zt - sleeve, tongue, dish, W, layer: 2 }),
    );
  } else faces.push(...tube(s0, s1, r * sleeveR[0], r * sleeveR[1], { layer: 2 }));
  const top = [0, y, zt + socket + shaft];
  faces.push(...tube(s1, top, r, r, { layer: 3 }));
  for (const [h, len, f] of collars) {
    faces.push(...tube([0, y, zt + h], [0, y, zt + h + len], r * f, r * f, { layer: 4 }));
  }
  if (grip.frame) faces.push(...frameGrip(top, r, { ...grip, layer: 5 }));
  else if (grip.plate) faces.push(...plateGrip(top, { ...grip, layer: 5 }));
  else faces.push(...dGrip(top, { r: grip.r ?? r * 0.85, ...grip, layer: 5 }));
  return faces;
}

const SHADING = { margin: 14, hi: 1.45, lo: -0.1 };
const VIEW = view(6, 0);

/**
 * Folding-spade blade (after the Bundeswehr Klappspaten): parallel sides,
 * a wide straight-edged point. `L` length, `W` half width, `tip` the point's
 * share of the length; `mid`: an extra row halfway up the sides.
 */
const spadeBlade = ({ L = 1, W = 0.34, tip = 0.36, mid = false } = {}) => [
  [0, 0],
  [tip * L, W],
  ...(mid ? [[((1 + tip) / 2) * L, W]] : []),
  [L, W],
];

/**
 * k3 pushed toward the bold app-icon proportions by `f` (0: k3, 1: blade as
 * long as wide, shaft half the blade width and short, wide grip). Blade half
 * width stays 0.4; the shaft joins the blade through a lofted socket.
 */
function bold(f) {
  const B = 0.8;
  const lerp = (a, b) => a + (b - a) * f;
  const r = lerp(0.075, 0.3) * B;
  return {
    rows: spadeBlade({ W: B / 2, L: lerp(1.25, 0.95) * B, tip: lerp(0.38, 0.42) }),
    cols: 3,
    dish: 0.17,
    r,
    socket: lerp(0.2, 0.16) * B,
    sleeve: lerp(0.42, 0.34) * B,
    tongue: lerp(0.16, 0.36) * B,
    shaft: lerp(0.9, 0.42) * B,
    collars: [[lerp(0.42, 0.3) * B, lerp(0.12, 0.08) * B, lerp(1.55, 1.18)]],
    grip: {
      span: lerp(0.3, 0.42) * B,
      height: lerp(0.62, 0.55) * B,
      r: lerp(0.064, 0.085) * B,
      base: r * 0.55,
    },
  };
}

/** m1 without the locking nut; `sleeve`: how far the socket reaches down onto the blade (x blade width). */
const plain = (sleeve) => ({ ...bold(0.33), collars: [], sleeve: sleeve * 0.8 });

/** n3 with the grip as one continuous frame in the shaft's thickness (`sx`, `sz`: grip width and height factors). */
function frame(sx, sz = sx) {
  const v = plain(0.07);
  return {
    ...v,
    grip: { frame: true, span: v.grip.span * sx, height: v.grip.height * sz },
  };
}

const VARIANTS = {
  f1: { label: 'f1 (round 9)', ...frame(1.25) },
  c1: {
    label: 'f1 with the top corners cut',
    ...frame(1.25),
    grip: { ...frame(1.25).grip, cut: 1.3 },
  },
  c2: { label: 'c1, grip 10 % smaller', ...frame(1.12), grip: { ...frame(1.12).grip, cut: 1.3 } },
  c3: { label: 'c1, grip 20 % smaller', ...frame(1.0), grip: { ...frame(1.0).grip, cut: 1.2 } },
};

export const CHOSEN = 'c2';

export const CANDIDATES = Object.fromEntries(
  Object.entries(VARIANTS).map(([name, { label, ...v }]) => [
    name,
    {
      // c2 was chosen (2026-10-04): it carries the master's title and id
      title:
        name === CHOSEN ? 'Himmel:CAD Builder – Shovel' : `Himmel:CAD Builder – Shovel (${name})`,
      id: name === CHOSEN ? 'Shovel-Low-Poly' : `Shovel-Low-Poly-${name}`,
      label,
      polys: () => render(shovel(v), VIEW, SHADING),
    },
  ]),
);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? '.');
  mkdirSync(out, { recursive: true });
  for (const [name, c] of Object.entries(CANDIDATES)) {
    const polys = c.polys();
    writeFileSync(join(out, `himmelcad-builder-${name}.svg`), toSvg(polys, c));
    writeFileSync(
      join(out, `himmelcad-builder-${name}-on-light.svg`),
      toSvg(onLight(polys), { ...c, title: `${c.title} (on light)` }),
    );
    process.stdout.write(`${name}: ${polys.length} polygons\n`);
  }
}
