/**
 * Pen stroke recognizer (assembler/TOUCH.md "Pen-first sketching"): a drawn
 * stroke becomes a line, a polyline (connected straight segments, open or
 * closed), an arc, a circle, a rectangle (axis-aligned or rotated) or a
 * scribble (erase what it crosses). Shapr3D's pen documents the automatic
 * Line/Arc gesture; circles, rectangles, polylines and scribble-to-erase are
 * the owner's Block 8 brief.
 *
 * Pure geometry on 2D points in any unit; `unitPerPx` (the size of one
 * screen pixel in that unit, e.g. millimetres per pixel in a sketch) turns
 * the pixel tolerances into stroke units, so recognition behaves the same at
 * every zoom. No DOM, no sketch types: the sketching module maps the result
 * to sketch entities (`modules/sketching/penStrokes.ts`).
 */

export type Vec2 = [number, number];

export interface StrokePoint {
  x: number;
  y: number;
  /** Milliseconds (optional; not used for the shape). */
  t?: number;
  pressure?: number;
}

export interface StrokeOptions {
  /** One screen pixel in stroke units. */
  unitPerPx: number;
  /** Shorter strokes are no shape (a tap), px. */
  minLengthPx: number;
  /** Angle within which a line or rectangle side snaps to horizontal/vertical, degrees. */
  axisSnapDeg: number;
  /** Allowed deviation of a straight segment, relative to its length. */
  straightness: number;
  /** Allowed RMS radius deviation of a circle or arc, relative to the radius. */
  roundness: number;
  /** Receives the recognizer's intermediate decisions (tests, tuning). */
  trace?: (message: string) => void;
}

export const DEFAULT_STROKE_OPTIONS: StrokeOptions = {
  unitPerPx: 1,
  minLengthPx: 12,
  axisSnapDeg: 8,
  straightness: 0.045,
  roundness: 0.075,
};

export type Axis = 'horizontal' | 'vertical';

export type RecognizedStroke =
  | { kind: 'line'; a: Vec2; b: Vec2; axis: Axis | null }
  /** Connected straight segments; `closed`: the last vertex joins the first. */
  | { kind: 'polyline'; points: Vec2[]; closed: boolean }
  /** `through` is the point halfway along the arc; `sweep` in degrees, counter-clockwise positive. */
  | {
      kind: 'arc';
      start: Vec2;
      through: Vec2;
      end: Vec2;
      center: Vec2;
      radius: number;
      sweep: number;
    }
  /** `start`: the point where the stroke began (on the circle). */
  | { kind: 'circle'; center: Vec2; radius: number; start: Vec2 }
  /** Corners counter-clockwise; `angle` of the first side in degrees (0 when axis-aligned). */
  | {
      kind: 'rectangle';
      corners: [Vec2, Vec2, Vec2, Vec2];
      angle: number;
      axisAligned: boolean;
    }
  /** Back-and-forth strokes: erase what it crosses. */
  | { kind: 'scribble'; points: Vec2[] }
  | { kind: 'none'; reason: string };

// ---- small vector helpers ------------------------------------------------------------------------

const sub = (a: Vec2, b: Vec2): [number, number] => [a[0] - b[0], a[1] - b[1]];
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const DEG = 180 / Math.PI;

function pathLength(points: readonly Vec2[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) length += dist(points[i - 1]!, points[i]!);
  return length;
}

function bboxDiagonal(points: readonly Vec2[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

/** `n` points equally spaced along the polyline (first and last kept). */
export function resample(points: readonly Vec2[], n: number): Vec2[] {
  const total = pathLength(points);
  if (points.length === 0) return [];
  if (total === 0 || n < 2) return [points[0]!];
  const step = total / (n - 1);
  const out: Vec2[] = [points[0]!];
  let carried = 0;
  for (let i = 1; i < points.length; i += 1) {
    let a = points[i - 1]!;
    const b = points[i]!;
    let segment = dist(a, b);
    while (carried + segment >= step && out.length < n - 1) {
      const t = (step - carried) / segment;
      const p: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      out.push(p);
      segment -= step - carried;
      a = p;
      carried = 0;
    }
    carried += segment;
  }
  out.push(points[points.length - 1]!);
  return out;
}

// ---- fits ----------------------------------------------------------------------------------------

interface LineFit {
  point: Vec2;
  /** Unit direction. */
  dir: Vec2;
  /** Largest perpendicular distance of a point. */
  maxDeviation: number;
}

/** Total least-squares line through `points`. */
export function fitLine(points: readonly Vec2[]): LineFit {
  let mx = 0;
  let my = 0;
  for (const [x, y] of points) {
    mx += x;
    my += y;
  }
  mx /= points.length;
  my /= points.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dir: Vec2 = [Math.cos(angle), Math.sin(angle)];
  let maxDeviation = 0;
  for (const [x, y] of points) {
    maxDeviation = Math.max(maxDeviation, Math.abs(-(x - mx) * dir[1] + (y - my) * dir[0]));
  }
  return { point: [mx, my], dir, maxDeviation };
}

function projectOnLine(fit: LineFit, p: Vec2): Vec2 {
  const t = (p[0] - fit.point[0]) * fit.dir[0] + (p[1] - fit.point[1]) * fit.dir[1];
  return [fit.point[0] + fit.dir[0] * t, fit.point[1] + fit.dir[1] * t];
}

interface CircleFit {
  center: Vec2;
  radius: number;
  /** RMS of (distance to centre − radius). */
  rms: number;
}

/** Algebraic (Kåsa) least-squares circle, `null` for collinear points. */
export function fitCircle(points: readonly Vec2[]): CircleFit | null {
  const n = points.length;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (const [x, y] of points) {
    mx += x;
    my += y;
  }
  mx /= n;
  my /= n;
  // Centred coordinates: solve [Suu Suv; Suv Svv] [uc vc] = ½ [Suuu+Suvv; Svvv+Svuu].
  let suu = 0;
  let svv = 0;
  let suv = 0;
  let suuu = 0;
  let svvv = 0;
  let suvv = 0;
  let svuu = 0;
  for (const [x, y] of points) {
    const u = x - mx;
    const v = y - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-12 * Math.max(1, suu * svv)) return null;
  const bu = 0.5 * (suuu + suvv);
  const bv = 0.5 * (svvv + svuu);
  const uc = (bu * svv - bv * suv) / det;
  const vc = (suu * bv - suv * bu) / det;
  const radius = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  const center: Vec2 = [uc + mx, vc + my];
  let sq = 0;
  for (const p of points) sq += (dist(p, center) - radius) ** 2;
  return { center, radius, rms: Math.sqrt(sq / n) };
}

// ---- corners -------------------------------------------------------------------------------------

/** Douglas–Peucker: indices of the points that keep the polyline within `epsilon` (ends included). */
export function simplify(points: readonly Vec2[], epsilon: number): number[] {
  const n = points.length;
  if (n <= 2) return n === 2 ? [0, 1] : n === 1 ? [0] : [];
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    let worst = -1;
    let worstDistance = epsilon;
    for (let i = from + 1; i < to; i += 1) {
      const d = pointSegment(points[i]!, points[from]!, points[to]!);
      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([from, worst], [worst, to]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => {
    if (k) out.push(i);
  });
  return out;
}

/**
 * Corner candidates of a resampled stroke: the vertices a Douglas–Peucker
 * simplification keeps (scale-free, robust to rounded corners). A closed
 * loop is split at the point farthest from its start; the start itself is a
 * candidate (it is removed again if it lies on a straight side).
 */
export function findCorners(points: readonly Vec2[], closed: boolean, epsilon: number): number[] {
  const n = points.length;
  if (n < 3) return [];
  if (!closed) return simplify(points, epsilon).slice(1, -1);
  let far = 0;
  let farDistance = -1;
  for (let i = 1; i < n; i += 1) {
    const d = dist(points[i]!, points[0]!);
    if (d > farDistance) {
      farDistance = d;
      far = i;
    }
  }
  const firstHalf = simplify(points.slice(0, far + 1), epsilon);
  const secondHalf = simplify([...points.slice(far), points[0]!], epsilon).map((i) => i + far);
  const all = new Set<number>([...firstHalf, ...secondHalf.filter((i) => i < n)]);
  return [...all].sort((x, y) => x - y);
}

/**
 * A corner is sharp when the stroke turns most of the corner's angle within
 * a short distance `reach` around it; a circle approximated by a polygon
 * turns only a little there (its turning is spread evenly).
 */
function isSharpCorner(
  points: readonly Vec2[],
  index: number,
  closed: boolean,
  cornerTurnDeg: number,
  reach: number,
): boolean {
  const n = points.length;
  const step = (i: number, d: 1 | -1): number | null => {
    const next = i + d;
    if (closed) return (next + n) % n;
    return next < 0 || next >= n ? null : next;
  };
  const walk = (d: 1 | -1): Vec2 | null => {
    let i = index;
    let travelled = 0;
    for (let k = 0; k < n; k += 1) {
      const next = step(i, d);
      if (next === null) return points[i]!;
      travelled += dist(points[i]!, points[next]!);
      i = next;
      if (travelled >= reach) return points[i]!;
    }
    return null;
  };
  const before = walk(-1);
  const after = walk(1);
  if (!before || !after) return false;
  const local = turns([before, points[index]!, after])[0] ?? 0;
  return local >= 0.55 * cornerTurnDeg;
}

/** Index of the stroke point nearest to `p`. */
function nearestIndex(points: readonly Vec2[], p: Vec2): number {
  let best = 0;
  let bestDistance = Infinity;
  points.forEach((q, i) => {
    const d = dist(p, q);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  return best;
}

/**
 * Re-anchors corners at the stroke points nearest to the fitted vertices
 * (a Douglas–Peucker vertex of a long, shallow chord can sit well before the
 * real corner of a thin shape) and splits the runs again there.
 */
function reanchor(
  points: readonly Vec2[],
  corners: number[],
  closed: boolean,
): { corners: number[]; runs: Vec2[][]; vertices: Vec2[] } {
  let runs = cornerSegments(points, corners, closed);
  let vertices = refineVertices(runs, !closed);
  const inner = closed ? vertices : vertices.slice(1, -1);
  const moved = inner.map((v) => nearestIndex(points, v));
  const ordered = closed ? [...moved].sort((x, y) => x - y) : moved;
  const distinct = ordered.every((c, k) => k === 0 || c > ordered[k - 1]!);
  if (
    !distinct ||
    (!closed && (ordered[0]! <= 0 || ordered[ordered.length - 1]! >= points.length - 1))
  ) {
    return { corners, runs, vertices };
  }
  runs = cornerSegments(points, ordered, closed);
  vertices = refineVertices(runs, !closed);
  return { corners: ordered, runs, vertices };
}
/** Turning angles (degrees, 0 = straight on) at the inner vertices of a polyline. */
function turns(vertices: readonly Vec2[]): number[] {
  const out: number[] = [];
  for (let i = 1; i + 1 < vertices.length; i += 1) {
    const a = sub(vertices[i]!, vertices[i - 1]!);
    const b = sub(vertices[i + 1]!, vertices[i]!);
    const la = Math.hypot(a[0], a[1]);
    const lb = Math.hypot(b[0], b[1]);
    if (la === 0 || lb === 0) {
      out.push(0);
      continue;
    }
    const cos = Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (la * lb)));
    out.push(Math.acos(cos) * DEG);
  }
  return out;
}
// ---- recognition ---------------------------------------------------------------------------------

/** Angle of a direction folded into (−90°, 90°]. */
function lineAngle(dir: Vec2): number {
  let a = Math.atan2(dir[1], dir[0]) * DEG;
  while (a > 90) a -= 180;
  while (a <= -90) a += 180;
  return a;
}

function axisOf(dir: Vec2, snapDeg: number): Axis | null {
  const a = lineAngle(dir);
  if (Math.abs(a) <= snapDeg) return 'horizontal';
  if (Math.abs(Math.abs(a) - 90) <= snapDeg) return 'vertical';
  return null;
}

/** A run between corners without its ends (the drawn corner is rounded and found a sample early or late). */
function coreOf(run: readonly Vec2[]): readonly Vec2[] {
  const trim = Math.max(1, Math.floor(run.length / 6));
  return run.length - 2 * trim >= 3 ? run.slice(trim, run.length - trim) : run;
}

function segmentIsStraight(points: readonly Vec2[], tolerance: number): boolean {
  const core = coreOf(points);
  if (core.length < 3) return true;
  return fitLine(core).maxDeviation <= tolerance;
}

/** One pass of a three-point moving average (ends kept): takes the edge off sensor noise. */
function smoothInPlace(points: Vec2[]): void {
  if (points.length < 3) return;
  let previous = points[0]!;
  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i]!;
    const next = points[i + 1]!;
    points[i] = [
      (previous[0] + current[0] + next[0]) / 3,
      (previous[1] + current[1] + next[1]) / 3,
    ];
    previous = current;
  }
}

/** Sharp reversals (turns above 155°, back the way it came) of the simplified stroke: scribbles have many. */
function reversals(points: readonly Vec2[], epsilon: number): number {
  const kept = simplify(points, epsilon).map((i) => points[i]!);
  return turns(kept).filter((turn) => turn > 155).length;
}
const MIN_SAMPLES = 24;
const MAX_SAMPLES = 256;

export function recognizeStroke(
  input: readonly StrokePoint[],
  options: Partial<StrokeOptions> = {},
): RecognizedStroke {
  const o = { ...DEFAULT_STROKE_OPTIONS, ...options };
  const px = o.unitPerPx;
  // Keep samples at least 1.5 px apart: sensor jitter between dense samples would
  // otherwise inflate the length and fake sharp turns.
  const raw: Vec2[] = [];
  for (const p of input) {
    const v: Vec2 = [p.x, p.y];
    if (raw.length === 0 || dist(raw[raw.length - 1]!, v) >= 1.5 * px) raw.push(v);
  }
  const end = input[input.length - 1];
  if (end && raw.length > 0 && dist(raw[raw.length - 1]!, [end.x, end.y]) > 0) {
    raw[raw.length - 1] = [end.x, end.y];
  }
  smoothInPlace(raw);
  if (raw.length < 3) return { kind: 'none', reason: 'Too short to be a shape.' };
  const length = pathLength(raw);
  if (length < o.minLengthPx * px) return { kind: 'none', reason: 'Too short to be a shape.' };
  const diagonal = Math.max(bboxDiagonal(raw), 1e-9);
  // About one sample per 2.5 px (short sides of thin shapes keep enough samples for corners).
  const points = resample(
    raw,
    Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.round(length / (2.5 * px)))),
  );
  const first = points[0]!;
  const last = points[points.length - 1]!;
  // The hand's wobble: deviations below this are noise.
  const jitter = 4 * px;

  // Corner tolerance: scale-free, but never below the hand's wobble.
  const epsilon = Math.max(jitter, 0.035 * diagonal);
  // How close to a vertex the stroke must turn for a sharp corner.
  const reach = Math.max(6 * px, 0.05 * diagonal);
  // Shorter runs between corners are hooks and closing overlaps, not sides.
  const minRun = Math.max(8 * px, 0.03 * length);

  // Scribble: back and forth, much longer than it is wide.
  if (reversals(points, epsilon) >= 3 && length / diagonal >= 2.5) {
    return { kind: 'scribble', points: raw };
  }

  const gap = dist(first, last);
  const closed = length / diagonal >= 1.8 && gap <= Math.max(0.2 * diagonal, 14 * px);
  // Decisions for tests and tuning; the messages are only built when someone listens.
  const trace = (message: () => string): void => o.trace?.(message());
  trace(
    () =>
      `length ${length.toFixed(1)} diagonal ${diagonal.toFixed(1)} gap ${gap.toFixed(1)} samples ${points.length} closed ${closed}`,
  );

  if (closed) {
    // A closed loop of the resampled stroke without the duplicated seam point.
    const loop = points.slice(0, -1);
    const candidates = findCorners(loop, true, epsilon);
    const merged = mergeGentleCorners(loop, candidates, true, minRun);
    trace(() => `closed corners ${candidates.join(',')} → ${merged.join(',')}`);
    if (merged.length >= 3 && merged.length <= 8) {
      const { corners, runs: sides, vertices } = reanchor(loop, merged, true);
      const straight = sides.every((s) =>
        segmentIsStraight(s, Math.max(o.straightness * pathLength(s), jitter)),
      );
      const cornerTurns = turns([vertices[vertices.length - 1]!, ...vertices, vertices[0]!]);
      // The seam (where the pen went down and came back) is messy: its corner is not judged.
      const nearSeam = (c: number) =>
        Math.min(c, loop.length - c) * (length / loop.length) <= reach;
      const sharp = corners.every(
        (c, k) => nearSeam(c) || isSharpCorner(loop, c, true, cornerTurns[k] ?? 0, reach),
      );
      const onStroke = verticesOnStroke(vertices, raw, sides, jitter);
      trace(() => `polygon: straight ${straight}, sharp ${sharp}, vertices on stroke ${onStroke}`);
      if (straight && sharp && onStroke) {
        if (vertices.length === 4) {
          const rect = rectangleFrom(vertices, o.axisSnapDeg);
          if (rect) return rect;
        }
        return { kind: 'polyline', points: vertices, closed: true };
      }
    }
    const circle = fitCircle(loop);
    if (circle && circle.rms <= o.roundness * circle.radius) {
      const coverage = sweepAround(points, circle.center);
      if (Math.abs(coverage) >= 300) {
        const start = onCircle(circle.center, circle.radius, first);
        return { kind: 'circle', center: circle.center, radius: circle.radius, start };
      }
    }
    return { kind: 'none', reason: 'Not recognised: draw a line, arc, circle or rectangle.' };
  }

  // Open strokes: a line, an arc, then connected segments.
  const line = fitLine(points);
  const chord = gap;
  trace(
    () =>
      `line deviation ${line.maxDeviation.toFixed(2)} chord/length ${(chord / length).toFixed(3)}`,
  );
  if (line.maxDeviation <= Math.max(o.straightness * length, jitter) && chord >= 0.8 * length) {
    const axis = axisOf(line.dir, o.axisSnapDeg);
    let a = projectOnLine(line, first);
    let b = projectOnLine(line, last);
    if (axis === 'horizontal') {
      const y = (a[1] + b[1]) / 2;
      a = [a[0], y];
      b = [b[0], y];
    } else if (axis === 'vertical') {
      const x = (a[0] + b[0]) / 2;
      a = [x, a[1]];
      b = [x, b[1]];
    }
    return { kind: 'line', a, b, axis };
  }

  const circle = fitCircle(points);
  if (circle)
    trace(
      () =>
        `arc rms/r ${(circle.rms / circle.radius).toFixed(3)} sweep ${sweepAround(points, circle.center).toFixed(0)} monotonic ${monotonicAround(points, circle.center)}`,
    );
  if (circle && circle.rms <= o.roundness * circle.radius && circle.radius < 50 * diagonal) {
    const sweep = sweepAround(points, circle.center);
    if (Math.abs(sweep) >= 15 && Math.abs(sweep) <= 340 && monotonicAround(points, circle.center)) {
      const start = onCircle(circle.center, circle.radius, first);
      const end = onCircle(circle.center, circle.radius, last);
      const a0 = Math.atan2(start[1] - circle.center[1], start[0] - circle.center[0]);
      const mid = a0 + ((sweep / 2) * Math.PI) / 180;
      const through: Vec2 = [
        circle.center[0] + circle.radius * Math.cos(mid),
        circle.center[1] + circle.radius * Math.sin(mid),
      ];
      return {
        kind: 'arc',
        start,
        through,
        end,
        center: circle.center,
        radius: circle.radius,
        sweep,
      };
    }
  }

  // Corners near the stroke's ends are pen-down hooks and lift-off flicks, not corners.
  const openCandidates = findCorners(points, false, epsilon).filter(
    (i) => i > 2 && i < points.length - 3,
  );
  const merged = mergeGentleCorners(points, openCandidates, false, minRun);
  trace(() => `open corners ${openCandidates.join(',')} → ${merged.join(',')}`);
  if (merged.length >= 1 && merged.length <= 6) {
    const { corners, runs: segments, vertices } = reanchor(points, merged, false);
    const straight = segments.every((s) =>
      segmentIsStraight(s, Math.max(o.straightness * pathLength(s), jitter)),
    );
    const cornerTurns = turns(vertices);
    const sharp = corners.every((c, k) =>
      isSharpCorner(points, c, false, cornerTurns[k] ?? 0, reach),
    );
    const onStroke = verticesOnStroke(vertices.slice(1, -1), raw, segments, jitter);
    trace(() => `polyline: straight ${straight}, sharp ${sharp}, vertices on stroke ${onStroke}`);
    if (straight && sharp && onStroke) return { kind: 'polyline', points: vertices, closed: false };
  }
  return { kind: 'none', reason: 'Not recognised: draw a line, arc, circle or rectangle.' };
}

/**
 * Drops false corners one at a time until every corner is real: first a
 * corner next to a tiny run (a pen-down hook, the overlap where a loop
 * closes), then the corner where the two adjacent runs' fitted directions
 * differ by less than `minTurnDeg` (a bend inside a straight side).
 */
function mergeGentleCorners(
  points: readonly Vec2[],
  corners: number[],
  closed: boolean,
  minRun: number,
  minTurnDeg = 25,
): number[] {
  let current = [...corners];
  for (;;) {
    if (current.length === 0 || (closed && current.length < 3)) return current;
    const runs = cornerSegments(points, current, closed);
    // Oriented directions (the fit's sign follows the run).
    const dirs = runs.map((run) => {
      const fit = fitLine(coreOf(run));
      const along = sub(run[run.length - 1]!, run[0]!);
      const s = fit.dir[0] * along[0] + fit.dir[1] * along[1] >= 0 ? 1 : -1;
      return [fit.dir[0] * s, fit.dir[1] * s] as Vec2;
    });
    const turnAtCorner = (k: number): number => {
      // Corner k sits between run k-1 and run k (closed), or run k and run k+1 (open).
      const before = closed ? dirs[(k - 1 + dirs.length) % dirs.length]! : dirs[k]!;
      const after = closed ? dirs[k]! : dirs[k + 1]!;
      const cos = Math.max(-1, Math.min(1, before[0] * after[0] + before[1] * after[1]));
      return Math.acos(cos) * DEG;
    };
    const tiny = runs.findIndex((run) => pathLength(run) < minRun);
    if (tiny >= 0) {
      // The corners bounding run `tiny`: closed k=tiny and tiny+1; open tiny-1 and tiny.
      const bounds = (closed ? [tiny, (tiny + 1) % current.length] : [tiny - 1, tiny]).filter(
        (k) => k >= 0 && k < current.length,
      );
      const drop = bounds.reduce((best, k) => (turnAtCorner(k) < turnAtCorner(best) ? k : best));
      current = current.filter((_, k) => k !== drop);
      continue;
    }
    let gentlest = -1;
    let smallest = Infinity;
    for (let k = 0; k < current.length; k += 1) {
      const turn = turnAtCorner(k);
      if (turn < smallest) {
        smallest = turn;
        gentlest = k;
      }
    }
    if (smallest >= minTurnDeg) return current;
    current = current.filter((_, k) => k !== gentlest);
  }
}
/**
 * Sharp corners only: every vertex (the intersection of two fitted sides)
 * lies close to the drawn stroke. Tangents of a smooth wave meet far away.
 */
function verticesOnStroke(
  vertices: readonly Vec2[],
  stroke: readonly Vec2[],
  sides: readonly (readonly Vec2[])[],
  jitter: number,
): boolean {
  const shortest = Math.min(...sides.map((s) => pathLength(s)));
  const tolerance = Math.max(0.15 * shortest, 2 * jitter);
  return vertices.every((v) => {
    let best = Infinity;
    for (let i = 1; i < stroke.length; i += 1)
      best = Math.min(best, pointSegment(v, stroke[i - 1]!, stroke[i]!));
    return best <= tolerance;
  });
}

/** The runs of points between corners (closed: around the loop). */
function cornerSegments(points: readonly Vec2[], corners: number[], closed: boolean): Vec2[][] {
  const out: Vec2[][] = [];
  if (closed) {
    for (let k = 0; k < corners.length; k += 1) {
      const from = corners[k]!;
      const to = corners[(k + 1) % corners.length]!;
      const run: Vec2[] = [];
      for (let i = from; ; i = (i + 1) % points.length) {
        run.push(points[i]!);
        if (i === to) break;
      }
      out.push(run);
    }
    return out;
  }
  const marks = [0, ...corners, points.length - 1];
  for (let k = 0; k + 1 < marks.length; k += 1) {
    out.push(points.slice(marks[k]!, marks[k + 1]! + 1));
  }
  return out;
}

/**
 * Vertices from straight runs: consecutive fitted lines are intersected
 * (sharper than the drawn, rounded corner). `open` keeps the stroke's own
 * end points.
 */
function refineVertices(segments: Vec2[][], open = false): Vec2[] {
  // Fit each run without its rounded ends.
  const fits = segments.map((s) => fitLine(coreOf(s)));
  const n = fits.length;
  const vertices: Vec2[] = [];
  if (open) vertices.push(projectOnLine(fits[0]!, segments[0]![0]!));
  for (let k = open ? 0 : -1; k < n - 1; k += 1) {
    const a = fits[(k + n) % n]!;
    const b = fits[k + 1]!;
    vertices.push(intersect(a, b) ?? segments[k + 1]![0]!);
  }
  if (open) {
    const lastSeg = segments[n - 1]!;
    vertices.push(projectOnLine(fits[n - 1]!, lastSeg[lastSeg.length - 1]!));
  }
  return vertices;
}

function intersect(a: LineFit, b: LineFit): Vec2 | null {
  const det = a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0];
  if (Math.abs(det) < 1e-6) return null;
  const d = sub(b.point, a.point);
  const t = (d[0] * b.dir[1] - d[1] * b.dir[0]) / det;
  return [a.point[0] + a.dir[0] * t, a.point[1] + a.dir[1] * t];
}

/** Four vertices with roughly right angles → a regular rectangle, else `null`. */
function rectangleFrom(vertices: Vec2[], axisSnapDeg: number): RecognizedStroke | null {
  for (let k = 0; k < 4; k += 1) {
    const a = sub(vertices[(k + 1) % 4]!, vertices[k]!);
    const b = sub(vertices[(k + 2) % 4]!, vertices[(k + 1) % 4]!);
    const la = Math.hypot(a[0], a[1]);
    const lb = Math.hypot(b[0], b[1]);
    if (la === 0 || lb === 0) return null;
    const cos = (a[0] * b[0] + a[1] * b[1]) / (la * lb);
    if (Math.abs(cos) > Math.sin((20 * Math.PI) / 180)) return null; // not within 20° of square
  }
  // Mean orientation of the four sides, folded to a quarter turn.
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < 4; k += 1) {
    const d = sub(vertices[(k + 1) % 4]!, vertices[k]!);
    const angle = Math.atan2(d[1], d[0]) * 4; // period 90° → 360°
    const weight = Math.hypot(d[0], d[1]);
    sx += Math.cos(angle) * weight;
    sy += Math.sin(angle) * weight;
  }
  let angle = (Math.atan2(sy, sx) / 4) * DEG; // (−45°, 45°]
  const axisAligned = Math.abs(angle) <= axisSnapDeg;
  if (axisAligned) angle = 0;
  const rad = (angle * Math.PI) / 180;
  const u: Vec2 = [Math.cos(rad), Math.sin(rad)];
  const v: Vec2 = [-Math.sin(rad), Math.cos(rad)];
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  // The rectangle spanned by the mid-sides (averaging the drawn corners' overshoot).
  for (const p of vertices) {
    const pu = p[0] * u[0] + p[1] * u[1];
    const pv = p[0] * v[0] + p[1] * v[1];
    minU = Math.min(minU, pu);
    maxU = Math.max(maxU, pu);
    minV = Math.min(minV, pv);
    maxV = Math.max(maxV, pv);
  }
  const at = (pu: number, pv: number): Vec2 => [pu * u[0] + pv * v[0], pu * u[1] + pv * v[1]];
  const corners: [Vec2, Vec2, Vec2, Vec2] = [
    at(minU, minV),
    at(maxU, minV),
    at(maxU, maxV),
    at(minU, maxV),
  ];
  return { kind: 'rectangle', corners, angle, axisAligned };
}

/** Signed angle (degrees, counter-clockwise positive) the stroke turns around `center`. */
function sweepAround(points: readonly Vec2[], center: Vec2): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = Math.atan2(points[i - 1]![1] - center[1], points[i - 1]![0] - center[0]);
    const b = Math.atan2(points[i]![1] - center[1], points[i]![0] - center[0]);
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d <= -Math.PI) d += 2 * Math.PI;
    total += d;
  }
  return total * DEG;
}

/** The stroke runs around `center` in one direction (small back-steps from jitter allowed). */
function monotonicAround(points: readonly Vec2[], center: Vec2): boolean {
  const total = sweepAround(points, center);
  const sign = Math.sign(total);
  let back = 0;
  for (let i = 1; i < points.length; i += 1) {
    const step = sweepAround([points[i - 1]!, points[i]!], center);
    if (Math.sign(step) === -sign) back += Math.abs(step);
  }
  return back <= 0.1 * Math.abs(total);
}

function onCircle(center: Vec2, radius: number, p: Vec2): Vec2 {
  const d = dist(p, center);
  if (d === 0) return [center[0] + radius, center[1]];
  return [
    center[0] + ((p[0] - center[0]) / d) * radius,
    center[1] + ((p[1] - center[1]) / d) * radius,
  ];
}

/** Whether a polyline crosses or comes within `tolerance` of another polyline (scribble erase). */
export function polylinesTouch(a: readonly Vec2[], b: readonly Vec2[], tolerance: number): boolean {
  for (let i = 1; i < a.length; i += 1) {
    for (let j = 1; j < b.length; j += 1) {
      if (segmentDistance(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!) <= tolerance) return true;
    }
  }
  return false;
}

function segmentDistance(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): number {
  if (segmentsCross(p1, p2, q1, q2)) return 0;
  return Math.min(
    pointSegment(p1, q1, q2),
    pointSegment(p2, q1, q2),
    pointSegment(q1, p1, p2),
    pointSegment(q2, p1, p2),
  );
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function segmentsCross(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function pointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const len2 = ab[0] * ab[0] + ab[1] * ab[1];
  const t =
    len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len2)) : 0;
  return dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]);
}
