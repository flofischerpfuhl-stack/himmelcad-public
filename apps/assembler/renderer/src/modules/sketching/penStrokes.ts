/**
 * Pen-first sketching (assembler/TOUCH.md): a stroke drawn with the pen (or
 * a drawing finger) becomes ordinary sketch geometry. The stroke recognizer
 * (`platform/input/strokes.ts`) says what was drawn; this file turns that
 * into the drawing tools' own clicks — snapped and inferred exactly as the
 * overlay does for a mouse (`inference.ts`), so the entities, the point
 * connections (coincident, point on curve, concentric) and the automatic
 * horizontal / vertical / perpendicular / parallel / tangent constraints are
 * the ones a user would get by clicking — and runs them through the
 * session's `runTool` contract as one undo step. A scribble (or the pen's
 * eraser end) deletes the curves it crosses.
 *
 * `planInk` is pure (tests); `applyInk` touches the session.
 */
import {
  polylinesTouch,
  recognizeStroke,
  type RecognizedStroke,
} from '../../platform/input/strokes.js';
import type { SketchSnapToggles } from '../../platform/input/snapToggles.js';
import type { ViewportBox, ViewportTap } from '../../platform/viewport/domOverlays.js';
import { sampleCurve, sketchCurves } from '../../foundation/sketch-solver/geometry.js';
import { entityMap, type SketchData, type Vec2 } from '../../foundation/sketch-solver/types.js';
import type { BodySnapTargets } from './bodySnaps.js';
import { hitTest, infer, type Inference } from './inference.js';
import { useSketchStore, type SketchToolOptions, type ToolInput } from './session.js';
import { segmentStart, type SketchToolKind, type ToolEvent } from './tools.js';

/** Tools in which a pen stroke draws a shape (others take pen input like a mouse click). */
export const INK_TOOLS: ReadonlySet<SketchToolKind> = new Set([
  'select',
  'line',
  'arc',
  'circle',
  'rectangle',
]);

/** Which recognised shapes a tool accepts: Select and Line take all (Line = Shapr3D's automatic line/arc). */
const ACCEPTS: Partial<Record<SketchToolKind, readonly RecognizedStroke['kind'][]>> = {
  arc: ['arc'],
  circle: ['circle'],
  rectangle: ['rectangle'],
};

export interface InkContext {
  /** Millimetres per screen pixel where the stroke was drawn. */
  mmPerPx: number;
  /** Grid snapping step (`null` = off), as for clicks. */
  gridStep: number | null;
  snaps: SketchSnapToggles;
  body: BodySnapTargets | null;
  /** The active sketch tool. */
  toolKind: SketchToolKind;
  /** Settings › Touch and pen. */
  penShapes: boolean;
  scribbleErase: boolean;
}

export type InkPlan =
  | {
      kind: 'create';
      /** What was recognised ("Line", "Arc", …). */
      label: string;
      tool: SketchToolKind;
      options?: Partial<SketchToolOptions>;
      inputs: ToolInput[];
    }
  | { kind: 'erase'; ids: string[] }
  | { kind: 'none'; notice: string };

const DEG = Math.PI / 180;

function click(sketch: SketchData, snap: Inference, mmPerPx: number): ToolEvent {
  return { type: 'click', snap, hit: hitTest(sketch, snap.pos, mmPerPx), raw: snap.pos };
}

/** A position used as is (no snapping): arc through-points, circle radius points. */
function exact(pos: Vec2): Inference {
  return { pos, hints: [], guides: [] };
}

/** The single line ending at `pointId`, if exactly one curve ends there and it is a line. */
function lineEndingAt(sketch: SketchData, pointId: string): { id: string; away: Vec2 } | null {
  const curves = sketch.entities.filter(
    (e) =>
      (e.kind === 'line' && (e.a === pointId || e.b === pointId)) ||
      (e.kind === 'arc' && (e.start === pointId || e.end === pointId)),
  );
  const line = curves.length === 1 ? curves[0] : undefined;
  if (line?.kind !== 'line') return null;
  const map = entityMap(sketch);
  const at = map.get(pointId);
  const other = map.get(line.a === pointId ? line.b : line.a);
  if (at?.kind !== 'point' || other?.kind !== 'point') return null;
  // The direction continuing the line past its end.
  const d: Vec2 = [at.x - other.x, at.y - other.y];
  const l = Math.hypot(d[0], d[1]);
  return l > 0 ? { id: line.id, away: [d[0] / l, d[1] / l] } : null;
}

/** Curves (entity ids) that a stroke polyline crosses or comes within `tolerance` of. */
export function curvesTouched(
  sketch: SketchData,
  stroke: readonly Vec2[],
  tolerance: number,
): string[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of stroke) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const ids = new Set<string>();
  for (const { entityId, curve } of sketchCurves(sketch, { includeConstruction: true })) {
    if (ids.has(entityId)) continue;
    const samples = sampleCurve(curve);
    // Cheap reject: the curve's box misses the stroke's box.
    let cx0 = Infinity;
    let cy0 = Infinity;
    let cx1 = -Infinity;
    let cy1 = -Infinity;
    for (const [x, y] of samples) {
      cx0 = Math.min(cx0, x);
      cy0 = Math.min(cy0, y);
      cx1 = Math.max(cx1, x);
      cy1 = Math.max(cy1, y);
    }
    if (
      cx1 < minX - tolerance ||
      cx0 > maxX + tolerance ||
      cy1 < minY - tolerance ||
      cy0 > maxY + tolerance
    ) {
      continue;
    }
    if (polylinesTouch(stroke, samples, tolerance)) ids.add(entityId);
  }
  return [...ids];
}

const LABEL: Record<Exclude<RecognizedStroke['kind'], 'none' | 'scribble'>, string> = {
  line: 'Line',
  polyline: 'Lines',
  arc: 'Arc',
  circle: 'Circle',
  rectangle: 'Rectangle',
};

/**
 * What a stroke (sketch-plane points, mm) does: create geometry through a
 * tool, erase curves, or nothing (with the reason for the tool pill).
 * `eraser`: the pen's eraser end — erase whatever the stroke touches.
 */
export function planInk(
  sketch: SketchData,
  stroke: readonly Vec2[],
  ctx: InkContext,
  eraser = false,
): InkPlan {
  const px = ctx.mmPerPx;
  if (eraser) {
    const ids = curvesTouched(sketch, stroke, 8 * px);
    return ids.length > 0
      ? { kind: 'erase', ids }
      : { kind: 'none', notice: 'Nothing to erase here.' };
  }
  const shape = recognizeStroke(
    stroke.map(([x, y]) => ({ x, y })),
    { unitPerPx: px },
  );
  if (shape.kind === 'scribble') {
    if (!ctx.scribbleErase) return { kind: 'none', notice: 'Scribble to erase is off (Settings).' };
    const ids = curvesTouched(sketch, shape.points, 3 * px);
    return ids.length > 0
      ? { kind: 'erase', ids }
      : { kind: 'none', notice: 'Scribble over a curve to erase it.' };
  }
  if (shape.kind === 'none') return { kind: 'none', notice: shape.reason };
  if (!ctx.penShapes) return { kind: 'none', notice: 'Pen shapes are off (Settings).' };
  const accepts = ACCEPTS[ctx.toolKind];
  if (accepts && !accepts.includes(shape.kind)) {
    return {
      kind: 'none',
      notice: `That looks like a ${LABEL[shape.kind].toLowerCase()}; the ${ctx.toolKind} tool takes a ${accepts[0]}.`,
    };
  }
  const base = { mmPerPx: px, gridStep: ctx.gridStep, snaps: ctx.snaps, body: ctx.body };
  /** Snapped like a click; with `chain`, relative to the segment the tool is drawing. */
  const snapAt =
    (pos: Vec2, chain: boolean) =>
    (current: SketchData, tool: Parameters<typeof segmentStart>[1]): ToolEvent => {
      const from = chain ? segmentStart(current, tool) : undefined;
      return click(current, infer(current, pos, { ...base, ...(from ? { from } : {}) }), px);
    };

  switch (shape.kind) {
    case 'line': {
      const start = infer(sketch, shape.a, base);
      // A straightened horizontal/vertical stroke stays so after the start snapped.
      const end: Vec2 =
        shape.axis === 'horizontal'
          ? [shape.b[0], start.pos[1]]
          : shape.axis === 'vertical'
            ? [start.pos[0], shape.b[1]]
            : shape.b;
      return {
        kind: 'create',
        label: LABEL.line,
        tool: 'line',
        inputs: [click(sketch, start, px), snapAt(end, true)],
      };
    }
    case 'polyline': {
      const [first, ...rest] = shape.points;
      if (!first) return { kind: 'none', notice: 'Not recognised.' };
      // A closed outline ends on its first point (the chain closes there).
      const ends = shape.closed ? [...rest, first] : rest;
      return {
        kind: 'create',
        label: LABEL.polyline,
        tool: 'line',
        inputs: [
          click(sketch, infer(sketch, first, base), px),
          ...ends.map((p) => snapAt(p, true)),
        ],
      };
    }
    case 'arc': {
      const start = infer(sketch, shape.start, base);
      // Leaving a line's end along it: a tangent arc (the Arc tool's own tangent continuation).
      const line = start.pointId ? lineEndingAt(sketch, start.pointId) : null;
      if (line) {
        const s = shape.start;
        const t = shape.through;
        const out: Vec2 = [t[0] - s[0], t[1] - s[1]];
        // The arc's direction at its start: the chord to the halfway point, turned back by a quarter of the sweep.
        const turn = (-shape.sweep / 4) * DEG;
        const dir: Vec2 = [
          out[0] * Math.cos(turn) - out[1] * Math.sin(turn),
          out[0] * Math.sin(turn) + out[1] * Math.cos(turn),
        ];
        const l = Math.hypot(dir[0], dir[1]);
        const cos = l > 0 ? (dir[0] * line.away[0] + dir[1] * line.away[1]) / l : 0;
        if (cos >= Math.cos(20 * DEG)) {
          return {
            kind: 'create',
            label: 'Tangent arc',
            tool: 'arc',
            options: { mode: 'endsBulge' },
            inputs: [click(sketch, start, px), snapAt(shape.end, false)],
          };
        }
      }
      return {
        kind: 'create',
        label: LABEL.arc,
        tool: 'arc',
        options: { mode: 'threePoint' },
        inputs: [
          click(sketch, start, px),
          (current) => click(current, exact(shape.through), px),
          snapAt(shape.end, false),
        ],
      };
    }
    case 'circle': {
      // A drawn circle's centre is only estimated: snap it from further away (concentric circles).
      const center = infer(sketch, shape.center, {
        ...base,
        mmPerPx: Math.max(px, 0.012 * shape.radius),
      });
      const r = shape.radius;
      const d: Vec2 = [shape.start[0] - shape.center[0], shape.start[1] - shape.center[1]];
      const l = Math.hypot(d[0], d[1]) || 1;
      const rim: Vec2 = [center.pos[0] + (d[0] / l) * r, center.pos[1] + (d[1] / l) * r];
      return {
        kind: 'create',
        label: LABEL.circle,
        tool: 'circle',
        inputs: [click(sketch, center, px), (current) => click(current, exact(rim), px)],
      };
    }
    case 'rectangle': {
      const [c0, c1, c2] = shape.corners;
      if (shape.axisAligned) {
        return {
          kind: 'create',
          label: LABEL.rectangle,
          tool: 'rectangle',
          options: { mode: 'corner' },
          inputs: [click(sketch, infer(sketch, c0, base), px), snapAt(c2, true)],
        };
      }
      // A rotated rectangle: base line, then the height (the tool's three-point mode).
      return {
        kind: 'create',
        label: 'Rotated rectangle',
        tool: 'rectangle',
        options: { mode: 'threePoint' },
        inputs: [
          click(sketch, infer(sketch, c0, base), px),
          snapAt(c1, true),
          (current) => click(current, exact(c2), px),
        ],
      };
    }
  }
}

function setNotice(notice: string | null): void {
  const session = useSketchStore.getState().session;
  if (session && session.notice !== notice) {
    useSketchStore.setState({ session: { ...session, notice } });
  }
}

/** Carries a plan out on the open session. Resolves what happened (for tests and the overlay). */
export async function applyInk(plan: InkPlan): Promise<'created' | 'erased' | 'none'> {
  const store = useSketchStore.getState();
  if (!store.session) return 'none';
  if (plan.kind === 'none') {
    setNotice(plan.notice);
    return 'none';
  }
  if (plan.kind === 'erase') {
    store.select(plan.ids);
    await store.deleteSelection();
    return 'erased';
  }
  const ok = await store.runTool(plan.tool, plan.inputs, plan.options);
  if (!ok) setNotice(`The ${plan.label.toLowerCase()} could not be added.`);
  return ok ? 'created' : 'none';
}

// ---- finger taps and boxes the viewport offers sketch mode -------------------------------------

/** What the open sketch overlay does with a navigating finger's tap or long-press box. */
export interface SketchTouchHandlers {
  tap: (tap: ViewportTap) => boolean;
  box: (box: ViewportBox, additive: boolean) => boolean;
}

let touchHandlers: SketchTouchHandlers | null = null;

/** The sketch overlay installs its handlers while it is mounted. */
export function setSketchTouchHandlers(handlers: SketchTouchHandlers | null): void {
  touchHandlers = handlers;
}

/** Sketch mode's viewport hooks (`module.ui.tsx`): `false` when no sketch is open. */
export function sketchTouchTap(tap: ViewportTap): boolean {
  return useSketchStore.getState().session !== null && (touchHandlers?.tap(tap) ?? false);
}

export function sketchTouchBox(box: ViewportBox, additive: boolean): boolean {
  return useSketchStore.getState().session !== null && (touchHandlers?.box(box, additive) ?? false);
}
