#!/usr/bin/env node
/**
 * Himmel:CAD Assembler mark candidates (2026-10-02): low-poly 3D models in
 * the family's azure ramp and light, rendered to the family's SVG layout.
 *
 *   node candidates.mjs <out-dir>
 *
 * a-nut      hex nut, three-quarter view from above, chamfered top, open bore
 * b-bolt     hex-head bolt, diagonal, ring-grooved thread
 * c-nozzle   3D-printer nozzle (hex body, cone) over two printed lines
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { band, cap, face, mul, onLight, render, ring, rotX, rotZ, toSvg } from './lowpoly.mjs';

const view = (elev, yaw, roll = 0) => mul(rotZ(roll), mul(rotX(elev - 90), rotZ(yaw)));

/**
 * Hex nut: outer corners at radius 1, bore polygon (`innerSides`), top either
 * chamfered with crowned flats (`crown`, hexagonal bore only) or flat with a
 * countersunk bore (`sink`); `threads` ridges the bore.
 */
export function nut({
  t = 0.62,
  hole = 0.56,
  chamfer = 0.16,
  crown = true,
  sink = 0,
  innerSides = 6,
  innerPhase = Math.PI / 6,
  boreShade = -0.18,
  threads = 0,
} = {}) {
  const faces = [];
  const bottom = ring(6, 1, 0);
  const corners = ring(6, 1, t - chamfer);
  const inner = ring(innerSides, hole, t - sink, innerPhase);
  const innerLow = ring(innerSides, hole, 0, innerPhase);
  // bore: the far walls show through the hole; `threads` > 0 ridges them (alternating rings)
  if (threads > 0) {
    const zTop = t - sink;
    let prev = innerLow;
    for (let i = 1; i <= threads * 2; i += 1) {
      const z = (zTop * i) / (threads * 2);
      const r = i % 2 === 1 && i < threads * 2 ? hole * 1.1 : hole;
      const next = i === threads * 2 ? inner : ring(innerSides, r, z, innerPhase);
      faces.push(...band(prev, next, { inward: true, layer: 0, shade: boreShade }));
      prev = next;
    }
  } else faces.push(...band(innerLow, inner, { inward: true, layer: 0, shade: boreShade }));
  if (innerSides !== 6 || !crown) {
    // flat sides; the top ring zips the outer hexagon to the bore polygon by angle
    const ang = (p) => (Math.atan2(p[1], p[0]) + 2 * Math.PI + 1e-9) % (2 * Math.PI);
    const below = (pts) => {
      const c = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
      return [c[0] / 3, c[1] / 3, c[2] / 3 - 1];
    };
    for (let k = 0; k < 6; k += 1) {
      const k1 = (k + 1) % 6;
      faces.push(
        face([bottom[k], bottom[k1], corners[k1], corners[k]], { inside: [0, 0, t / 2], layer: 1 }),
      );
    }
    // unwrapped angles: outer corner i at i * 60 deg, bore vertex j counted from the one nearest 0 deg
    const step = (2 * Math.PI) / innerSides;
    const phase0 = ((innerPhase % step) + step) % step;
    const start = inner.reduce(
      (best, p, idx) =>
        Math.abs(ang(p) - phase0) < Math.abs(ang(inner[best]) - phase0) ? idx : best,
      0,
    );
    let i = 0;
    let j = 0;
    while (i < 6 || j < innerSides) {
      const o0 = corners[i % 6];
      const o1 = corners[(i + 1) % 6];
      const n0 = inner[(start + j) % innerSides];
      const n1 = inner[(start + j + 1) % innerSides];
      const ao = i < 6 ? ((i + 1) * Math.PI) / 3 : Infinity;
      const ai = j < innerSides ? phase0 + (j + 1) * step : Infinity;
      if (ao <= ai) {
        faces.push(face([o0, o1, n0], { inside: below([o0, o1, n0]), layer: 2 }));
        i += 1;
      } else {
        faces.push(face([o0, n1, n0], { inside: below([o0, n1, n0]), layer: 2 }));
        j += 1;
      }
    }
    return faces;
  }
  for (let k = 0; k < 6; k += 1) {
    const k1 = (k + 1) % 6;
    const km = (k + 5) % 6;
    const C = corners[k];
    const C1 = corners[k1];
    const B = bottom[k];
    const B1 = bottom[k1];
    const below = (pts) => {
      const c = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]);
      return [c[0] / pts.length, c[1] / pts.length, c[2] / pts.length - 1];
    };
    if (crown) {
      // the flat's middle reaches the top: the chamfer cone cuts arcs into each side
      const M = [((C[0] + C1[0]) / 2) * 1, ((C[1] + C1[1]) / 2) * 1, t];
      const side = [B, B1, C1, M, C];
      faces.push(face(side, { inside: [0, 0, t / 2], layer: 1 }));
      faces.push(face([C, M, inner[k]], { inside: below([C, M, inner[k]]), layer: 2 }));
      faces.push(face([M, C1, inner[k]], { inside: below([M, C1, inner[k]]), layer: 2 }));
    } else {
      faces.push(face([B, B1, C1, C], { inside: [0, 0, t / 2], layer: 1 }));
      faces.push(face([C, C1, inner[k]], { inside: below([C, C1, inner[k]]), layer: 2 }));
    }
    faces.push(
      face([inner[km], C, inner[k]], { inside: below([inner[km], C, inner[k]]), layer: 2 }),
    );
  }
  return faces;
}

/** Hex-head bolt along -z: head (z 0..h) with a low pyramid top, shank with ring grooves and a chamfered tip. */
export function bolt({ h = 0.55, r = 0.5, groove = 0.4, pitch = 0.3, turns = 5, sides = 6 } = {}) {
  const faces = [];
  let layer = 0;
  const phase = Math.PI / 6;
  // shank, from the tip up (painted first)
  const zTip = -(turns * pitch + 0.35);
  const tip = ring(sides, groove * 0.75, zTip, phase);
  let lower = ring(sides, groove, zTip + 0.12, phase);
  faces.push(cap(tip, false, { layer }));
  faces.push(...band(tip, lower, { layer }));
  layer += 1;
  for (let i = 0; i < turns; i += 1) {
    const z0 = zTip + 0.12 + i * pitch;
    const crest = ring(sides, r, z0 + pitch / 2, phase);
    const root = ring(sides, groove, z0 + pitch, phase);
    faces.push(...band(lower, crest, { layer }));
    layer += 1;
    faces.push(...band(crest, root, { layer }));
    layer += 1;
    lower = root;
  }
  faces.push(...band(lower, ring(sides, groove, 0, phase), { layer }));
  layer += 1;
  // head
  const hb = ring(6, 1, 0);
  const ht = ring(6, 0.96, h);
  faces.push(...band(hb, ht, { layer }));
  layer += 1;
  const apex = [0, 0, h + 0.1];
  for (let k = 0; k < 6; k += 1) {
    faces.push(face([ht[k], ht[(k + 1) % 6], apex], { inside: [0, 0, 0], layer }));
  }
  return faces;
}

/** Printer nozzle: hex body, cone to the orifice, over two printed lines (one finished, one being laid). */
export function nozzle() {
  const faces = [];
  const sides = 6;
  // printed lines: low hexagonal-section bars along x
  const bar = (y, z, x0, x1, w, hgt, layer) => {
    const out = [];
    const sec = [
      [0, -w, z],
      [0, -w * 0.6, z + hgt],
      [0, w * 0.6, z + hgt],
      [0, w, z],
    ].map(([, dy, dz]) => [dy + y, dz]);
    const at = (x) => sec.map(([yy, zz]) => [x, yy, zz]);
    const a = at(x0);
    const b = at(x1);
    const mid = [(x0 + x1) / 2, y, z + hgt / 3];
    for (let k = 0; k < 3; k += 1)
      out.push(face([a[k], b[k], b[k + 1], a[k + 1]], { inside: mid, layer }));
    out.push(face(a, { inside: mid, layer }));
    out.push(face(b, { inside: mid, layer }));
    return out;
  };
  faces.push(...bar(0.0, -1.3, -1.7, 0.95, 0.4, 0.22, 0));
  faces.push(...bar(0.0, -1.08, -1.7, 0.05, 0.36, 0.2, 1));
  const tip = ring(sides, 0.16, -0.95, Math.PI / 6);
  const coneTop = ring(sides, 0.62, -0.25, Math.PI / 6);
  faces.push(cap(tip, false, { layer: 2 }));
  faces.push(...band(tip, coneTop, { layer: 2 }));
  faces.push(...band(coneTop, ring(sides, 0.62, 0, Math.PI / 6), { layer: 3 }));
  const hb = ring(6, 1, 0);
  const ht = ring(6, 1, 0.62);
  faces.push(...band(hb, ht, { layer: 4 }));
  const neck = ring(sides, 0.42, 0.62, Math.PI / 6);
  const neckTop = ring(sides, 0.42, 1.0, Math.PI / 6);
  for (let k = 0; k < 6; k += 1) {
    const k1 = (k + 1) % 6;
    faces.push(face([ht[k], ht[k1], neck[k]], { inside: [0, 0, 0], layer: 5 }));
    faces.push(face([ht[k1], neck[k1], neck[k]], { inside: [0, 0, 0], layer: 5 }));
  }
  faces.push(...band(neck, neckTop, { layer: 6 }));
  faces.push(cap(neckTop, true, { layer: 7 }));
  return faces;
}

const NUT = {
  t: 0.5,
  hole: 0.52,
  chamfer: 0,
  crown: false,
  sink: 0.14,
  innerSides: 12,
  innerPhase: 0.0001,
  threads: 2,
  boreShade: -0.12,
};
const NUT_ELEV = 38;
const NUT_YAW = 20;
const NUT_SHADING = { margin: 14, hi: 1.3, lo: -0.1 };

export const CANDIDATES = {
  'a-nut': {
    title: 'Himmel:CAD Assembler – Hex Nut',
    id: 'Hex-Nut-Low-Poly',
    polys: () => render(nut(NUT), view(NUT_ELEV, NUT_YAW), NUT_SHADING),
  },
  'b-bolt': {
    title: 'Himmel:CAD Assembler – Bolt',
    id: 'Bolt-Low-Poly',
    polys: () => render(bolt(), view(18, 12, 42), { margin: 14, hi: 1.15 }),
  },
  'c-nozzle': {
    title: 'Himmel:CAD Assembler – Nozzle',
    id: 'Nozzle-Low-Poly',
    polys: () => render(nozzle(), view(24, -24), { margin: 14, hi: 1.2 }),
  },
};

/** The nut for 16–32 px: the same view without the bore's thread rings (they blur into noise there). */
/**
 * The bolt for 16–32 px: three thread steps instead of five, deeper grooves and a taller head,
 * so the head and the stepped shank stay apart when a step is one or two pixels.
 */
export const BOLT_SMALL = {
  title: 'Himmel:CAD Assembler – Bolt (small sizes)',
  id: 'Bolt-Low-Poly-Small',
  polys: () =>
    render(bolt({ h: 0.66, r: 0.52, groove: 0.34, pitch: 0.46, turns: 3 }), view(18, 12, 42), {
      margin: 14,
      hi: 1.15,
    }),
};

export const NUT_SMALL = {
  title: 'Himmel:CAD Assembler – Hex Nut (small sizes)',
  id: 'Hex-Nut-Low-Poly-Small',
  polys: () =>
    render(nut({ ...NUT, threads: 0, boreShade: -0.3 }), view(NUT_ELEV, NUT_YAW), NUT_SHADING),
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? '.');
  mkdirSync(out, { recursive: true });
  const write = (name, c, polys) => {
    writeFileSync(join(out, `himmelcad-assembler-${name}.svg`), toSvg(polys, c));
    writeFileSync(
      join(out, `himmelcad-assembler-${name}-on-light.svg`),
      toSvg(onLight(polys), { ...c, title: `${c.title} (on light)` }),
    );
    process.stdout.write(`${name}: ${polys.length} polygons\n`);
  };
  for (const [name, c] of Object.entries(CANDIDATES)) write(name, c, c.polys());
  write('a-nut-small', NUT_SMALL, NUT_SMALL.polys());
  write('b-bolt-small', BOLT_SMALL, BOLT_SMALL.polys());
}
