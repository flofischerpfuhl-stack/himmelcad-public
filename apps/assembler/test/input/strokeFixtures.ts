/**
 * Synthetic pen strokes for the recognizer tests and the touch/pen
 * end-to-end test: hand-drawn-like samples with a seeded jitter, uneven
 * speed (dense at the start and end, sparse in the middle), a small pen-down
 * hook and overshoot where loops close. They are not recordings of a real
 * device — real-device validation is open (assembler/TOUCH.md).
 */

export interface Pt {
  x: number;
  y: number;
  t: number;
}

/** Deterministic PRNG (mulberry32). */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Samples a parametric path p(u), u in [0, 1], like a hand: slow at the
 * ends, a low-frequency wobble (the hand) plus fine sensor noise, and a
 * small pen-down hook.
 */
export function handDrawn(
  path: (u: number) => [number, number],
  options: {
    samples?: number;
    jitter?: number;
    seed?: number;
    durationMs?: number;
    hook?: boolean;
  } = {},
): Pt[] {
  const n = options.samples ?? 60;
  const wobble = options.jitter ?? 1.2;
  const rand = random(options.seed ?? 7);
  const duration = options.durationMs ?? 600;
  // Two slow sine wobbles per axis with random phase and frequency.
  const waves = Array.from({ length: 4 }, () => ({
    f: 1 + rand() * 3,
    phase: rand() * Math.PI * 2,
  }));
  const out: Pt[] = [];
  if (options.hook !== false) {
    // Pen-down hook: a tiny flick before the stroke proper.
    const [x0, y0] = path(0);
    out.push({ x: x0 + 2.5, y: y0 - 2, t: 0 });
  }
  for (let i = 0; i <= n; i += 1) {
    const s = i / n;
    const u = 0.5 - 0.5 * Math.cos(Math.PI * s); // slow at the ends
    const [x, y] = path(u);
    const wx =
      (Math.sin(2 * Math.PI * waves[0]!.f * u + waves[0]!.phase) +
        Math.sin(2 * Math.PI * waves[1]!.f * u + waves[1]!.phase)) /
      2;
    const wy =
      (Math.sin(2 * Math.PI * waves[2]!.f * u + waves[2]!.phase) +
        Math.sin(2 * Math.PI * waves[3]!.f * u + waves[3]!.phase)) /
      2;
    out.push({
      x: x + wobble * wx + (rand() - 0.5) * 0.7,
      y: y + wobble * wy + (rand() - 0.5) * 0.7,
      t: 8 + s * duration,
    });
  }
  return out;
}
export function lineStroke(x0: number, y0: number, x1: number, y1: number, seed = 1): Pt[] {
  return handDrawn((u) => [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u], { seed });
}

/** Arc around (cx, cy) from angle a0 to a1 (degrees). */
export function arcStroke(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  seed = 2,
): Pt[] {
  return handDrawn(
    (u) => {
      const a = ((a0 + (a1 - a0) * u) * Math.PI) / 180;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    },
    { seed },
  );
}

/** A circle drawn once around with a small overshoot past the start. */
export function circleStroke(cx: number, cy: number, r: number, seed = 3, startDeg = 30): Pt[] {
  return handDrawn(
    (u) => {
      const a = ((startDeg + 375 * u) * Math.PI) / 180;
      // A slightly uneven radius, like a hand.
      const rr = r * (1 + 0.03 * Math.sin(3 * a));
      return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
    },
    { seed, samples: 90, durationMs: 900 },
  );
}

/** A polygon through `corners` (closed when the last equals the first), corners slightly rounded. */
export function polylineStroke(corners: [number, number][], seed = 4, round = 3): Pt[] {
  const segments = corners.length - 1;
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < segments; i += 1) {
    const a = corners[i]!;
    const b = corners[i + 1]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lengths.push(l);
    total += l;
  }
  return handDrawn(
    (u) => {
      let d = u * total;
      for (let i = 0; i < segments; i += 1) {
        const l = lengths[i]!;
        if (d <= l || i === segments - 1) {
          const a = corners[i]!;
          const b = corners[i + 1]!;
          const t = l > 0 ? Math.min(1, d / l) : 0;
          // Cut the corner a little: the pen rounds it.
          const nearEnd = l - d < round && i < segments - 1;
          const p: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          if (nearEnd) {
            // Drift a little toward the next side (a corner rounded by about `round` px).
            const c = corners[i + 2]!;
            const len = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1;
            const k = (round - (l - d)) / 2;
            return [p[0] + ((c[0] - b[0]) / len) * k, p[1] + ((c[1] - b[1]) / len) * k];
          }
          return p;
        }
        d -= l;
      }
      return corners[corners.length - 1]!;
    },
    { seed, samples: 30 * segments, durationMs: 300 * segments },
  );
}

export function rectangleStroke(x0: number, y0: number, x1: number, y1: number, seed = 5): Pt[] {
  return polylineStroke(
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
      [x0, y0 + 0.02 * (y1 - y0)],
    ],
    seed,
  );
}

/** A rectangle rotated by `deg` about its centre. */
export function rotatedRectangleStroke(
  cx: number,
  cy: number,
  w: number,
  h: number,
  deg: number,
  seed = 6,
): Pt[] {
  const r = (deg * Math.PI) / 180;
  const at = (x: number, y: number): [number, number] => [
    cx + x * Math.cos(r) - y * Math.sin(r),
    cy + x * Math.sin(r) + y * Math.cos(r),
  ];
  return polylineStroke(
    [
      at(-w / 2, -h / 2),
      at(w / 2, -h / 2),
      at(w / 2, h / 2),
      at(-w / 2, h / 2),
      at(-w / 2, -h / 2 + 2),
    ],
    seed,
  );
}

/** Back and forth across a spot (scribble-to-erase). */
export function scribbleStroke(cx: number, cy: number, width: number, passes = 6, seed = 8): Pt[] {
  const corners: [number, number][] = [];
  for (let i = 0; i <= passes; i += 1) {
    corners.push([
      cx + (i % 2 === 0 ? -width / 2 : width / 2),
      cy - width / 4 + (i * width) / (2 * passes),
    ]);
  }
  return handDrawn(
    (u) => {
      const f = u * passes;
      const i = Math.min(passes - 1, Math.floor(f));
      const t = f - i;
      const a = corners[i]!;
      const b = corners[i + 1]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    },
    { seed, samples: 25 * passes, durationMs: 120 * passes, jitter: 1.5 },
  );
}
