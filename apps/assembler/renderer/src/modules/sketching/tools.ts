/**
 * Sketch-mode drawing tools as a pure reducer: `(sketch, tool, event) →
 * (next tool state, optional edit)`. The session (`session.ts`) feeds
 * clicks/typed values in order, solves every edit and only then adopts the
 * new tool state — a rejected edit (over-constrained, failed) leaves both
 * the sketch and the tool as they were. Previews for the overlay come from
 * {@link toolPreview}. No DOM, no solver: unit tested directly.
 */
import {
  addThreePointArc,
  offsetChain,
  offsetSide,
  SketchBuilder,
  tangentArc,
  trimAt,
  type EditResult,
  type SnapTarget,
} from '../../foundation/sketch-solver/edits.js';
import {
  circleThrough,
  dist,
  entityCurve,
  isFullCircle,
  normalize,
  sampleCurve,
  sub,
  type Curve2,
} from '../../foundation/sketch-solver/geometry.js';
import {
  ADVANCED_TOOL_KINDS,
  advancedInProgress,
  advancedPreview,
  advancedSegmentStart,
  initialAdvancedTool,
  isAdvancedTool,
  reduceAdvanced,
  type AdvancedTool,
  type AdvancedToolKind,
  type AdvancedValueField,
} from './advancedTools.js';
import type { Inference, SketchHit } from './inference.js';
import { measure } from '../../foundation/sketch-solver/measure.js';
import { regularPolygon } from './shapes.js';
import {
  entityMap,
  isCurve,
  nextDimensionName,
  pointPos,
  type SketchData,
  type SketchDimensionKind,
  type Vec2,
} from '../../foundation/sketch-solver/types.js';

/** Smallest size a tool creates (line length, radius, rectangle side), mm. */
export const MIN_SKETCH_SIZE = 0.1;

export type SketchTool =
  | { kind: 'select' }
  | {
      kind: 'line';
      /** Pending first point of a new chain (nothing is created until the first segment). */
      start: SnapTarget | null;
      /** Last point / line of the running chain. */
      lastPointId: string | null;
      lastLineId: string | null;
      /** First point of the chain: clicking it closes the loop and ends the chain. */
      firstPointId: string | null;
    }
  | {
      kind: 'arc';
      /**
       * `endsBulge` (default, Shapr3D Arc): both end points, then the bulge (the arc's height
       * follows the pointer across the chord). `threePoint`: start, a point on the arc, end.
       */
      mode: 'endsBulge' | 'threePoint';
      start: SnapTarget | null;
      end: SnapTarget | null;
      /** `threePoint`: the point on the arc (second click). */
      through: SnapTarget | null;
      /** Tangent continuation of a line end (two clicks instead of three). */
      tangent: { lineId: string; pointId: string } | null;
    }
  | { kind: 'circle'; center: SnapTarget | null }
  | {
      kind: 'rectangle';
      /** Two corners, centre + corner, or three points (base line, then height: a rotated rectangle). */
      mode: 'corner' | 'center' | 'threePoint';
      first: SnapTarget | null;
      /** `threePoint`: the end of the base line (second click). */
      second?: SnapTarget | null;
      /** Typed width/height (locks that side). */
      width: number | null;
      height: number | null;
    }
  | {
      kind: 'polygon';
      sides: number;
      center: SnapTarget | null;
      /** Vertices on the construction circle (`true`) or edges tangent to it. */
      inscribed: boolean;
    }
  | { kind: 'trim' }
  | { kind: 'offset'; curveId: string | null }
  | {
      kind: 'dimension';
      first: string | null;
      mode: 'aligned' | 'horizontal' | 'vertical';
    }
  | AdvancedTool;

export type SketchToolKind = SketchTool['kind'];

export type ToolEvent =
  | { type: 'click'; snap: Inference; hit: SketchHit | null; raw: Vec2 }
  /** A typed value for the tool's chip (length, diameter, width, height, distance, …). */
  | { type: 'value'; field: ValueField; value: number; snap: Inference }
  /** Enter / double click: end the running chain. */
  | { type: 'finish' };

export type ValueField =
  | 'length'
  | 'radius'
  | 'diameter'
  | 'width'
  | 'height'
  | 'distance'
  | AdvancedValueField;

export interface ToolContext {
  /** New curves are construction geometry. */
  construction: boolean;
}

export interface ToolStep {
  tool: SketchTool;
  edit?: EditResult;
  /** Open the value chip of this new dimension (Dimension tool). */
  editDimensionId?: string;
  /** Why the input did nothing (shown in the tool pill). */
  notice?: string;
}

export function initialTool(kind: SketchToolKind, selection: readonly string[] = []): SketchTool {
  if ((ADVANCED_TOOL_KINDS as readonly string[]).includes(kind)) {
    return initialAdvancedTool(kind as AdvancedToolKind, selection);
  }
  switch (kind) {
    case 'select':
      return { kind };
    case 'line':
      return { kind, start: null, lastPointId: null, lastLineId: null, firstPointId: null };
    case 'arc':
      return { kind, mode: 'endsBulge', start: null, end: null, through: null, tangent: null };
    case 'circle':
      return { kind, center: null };
    case 'rectangle':
      return { kind, mode: 'corner', first: null, width: null, height: null };
    case 'polygon':
      return { kind, sides: 6, center: null, inscribed: true };
    case 'trim':
      return { kind };
    case 'offset':
      return { kind, curveId: null };
    case 'dimension':
      return { kind, first: null, mode: 'aligned' };
    default:
      return initialAdvancedTool(kind, selection);
  }
}

/** `true` while the tool holds an unfinished segment/shape (first Escape cancels it). */
export function toolInProgress(tool: SketchTool): boolean {
  if (isAdvancedTool(tool)) return advancedInProgress(tool);
  switch (tool.kind) {
    case 'line':
      return tool.start !== null || tool.lastPointId !== null;
    case 'arc':
      return tool.start !== null;
    case 'circle':
    case 'polygon':
      return tool.center !== null;
    case 'rectangle':
      return tool.first !== null;
    case 'offset':
      return tool.curveId !== null;
    case 'dimension':
      return tool.first !== null;
    default:
      return false;
  }
}

/** The start of the segment being drawn (for inference), if any. */
export function segmentStart(
  sketch: SketchData,
  tool: SketchTool,
): { pos: Vec2; pointId?: string; lineId?: string } | undefined {
  const map = entityMap(sketch);
  if (tool.kind === 'line') {
    if (tool.lastPointId) {
      const pos = pointPos(map, tool.lastPointId);
      if (pos)
        return {
          pos,
          pointId: tool.lastPointId,
          ...(tool.lastLineId ? { lineId: tool.lastLineId } : {}),
        };
    }
    if (tool.start)
      return {
        pos: tool.start.pos,
        ...(tool.start.pointId ? { pointId: tool.start.pointId } : {}),
      };
  }
  if (tool.kind === 'rectangle' && tool.first) return { pos: tool.first.pos };
  if (isAdvancedTool(tool)) return advancedSegmentStart(sketch, tool);
  return undefined;
}

function lineEndedAt(sketch: SketchData, pointId: string): string | null {
  const curves = sketch.entities.filter(
    (e) =>
      (e.kind === 'line' && (e.a === pointId || e.b === pointId)) ||
      (e.kind === 'arc' && (e.start === pointId || e.end === pointId)),
  );
  return curves.length === 1 && curves[0]!.kind === 'line' ? curves[0]!.id : null;
}

function usedByCurves(sketch: SketchData, pointId: string): number {
  return sketch.entities.filter(
    (e) =>
      (e.kind === 'line' && (e.a === pointId || e.b === pointId)) ||
      (e.kind === 'arc' && (e.start === pointId || e.end === pointId || e.center === pointId)) ||
      (e.kind === 'circle' && e.center === pointId),
  ).length;
}

function withLength(from: Vec2, toward: Vec2, length: number): Vec2 {
  const d = normalize(sub(toward, from));
  const dir: Vec2 = Math.hypot(d[0], d[1]) > 0 ? d : [1, 0];
  return [from[0] + dir[0] * length, from[1] + dir[1] * length];
}

/** Applies one input event to the active tool. */
export function reduceTool(
  sketch: SketchData,
  tool: SketchTool,
  event: ToolEvent,
  ctx: ToolContext,
): ToolStep {
  if (isAdvancedTool(tool)) return reduceAdvanced(sketch, tool, event, ctx);
  if (event.type === 'finish') {
    if (tool.kind === 'line') return { tool: initialTool('line') };
    return { tool };
  }
  switch (tool.kind) {
    case 'select':
      return { tool };
    case 'line':
      return reduceLine(sketch, tool, event, ctx);
    case 'arc':
      return reduceArc(sketch, tool, event, ctx);
    case 'circle':
      return reduceCircle(sketch, tool, event, ctx);
    case 'rectangle':
      return reduceRectangle(sketch, tool, event, ctx);
    case 'polygon':
      return reducePolygon(sketch, tool, event, ctx);
    case 'trim':
      if (event.type === 'click' && event.hit?.kind === 'curve') {
        const edit = trimAt(sketch, event.hit.id, event.raw);
        return edit ? { tool, edit } : { tool };
      }
      return { tool };
    case 'offset':
      return reduceOffset(sketch, tool, event);
    case 'dimension':
      return reduceDimension(sketch, tool, event);
    default:
      return { tool };
  }
}

// ---- line ------------------------------------------------------------------------------

function reduceLine(
  sketch: SketchData,
  tool: Extract<SketchTool, { kind: 'line' }>,
  event: Exclude<ToolEvent, { type: 'finish' }>,
  ctx: ToolContext,
): ToolStep {
  const from = segmentStart(sketch, tool);
  let snap: SnapTarget & Partial<Inference> = event.snap;
  let length: number | null = null;
  if (event.type === 'value') {
    if (event.field !== 'length' || !from || !(event.value >= MIN_SKETCH_SIZE)) return { tool };
    length = event.value;
    const pos = withLength(from.pos, event.snap.pos, length);
    snap = {
      pos,
      ...(event.snap.horizontal ? { horizontal: true } : {}),
      ...(event.snap.vertical ? { vertical: true } : {}),
      ...(event.snap.perpendicularTo ? { perpendicularTo: event.snap.perpendicularTo } : {}),
      ...(event.snap.parallelTo ? { parallelTo: event.snap.parallelTo } : {}),
    };
  }
  if (!from) {
    return { tool: { ...tool, start: snap } };
  }
  if (snap.pointId && snap.pointId === from.pointId) return { tool };
  if (dist(from.pos, snap.pos) < MIN_SKETCH_SIZE) return { tool };

  const b = new SketchBuilder(sketch);
  const a = tool.lastPointId ?? b.pointFor(tool.start!);
  const closesChain =
    !!snap.pointId &&
    (snap.pointId === tool.firstPointId || usedByCurves(sketch, snap.pointId) > 0);
  const end = b.pointFor(snap);
  const line = b.addLine(a, end, ctx.construction);
  if (snap.horizontal) b.constrain('horizontal', [line], true);
  else if (snap.vertical) b.constrain('vertical', [line], true);
  else if (snap.perpendicularTo) b.constrain('perpendicular', [line, snap.perpendicularTo], true);
  else if (snap.parallelTo) b.constrain('parallel', [line, snap.parallelTo], true);
  if (length !== null) {
    const id = b.id('m');
    b.dimensions.push({
      id,
      name: nextDimensionName(b.data),
      kind: 'distance',
      refs: [line],
      value: length,
    });
  }
  const next: SketchTool = closesChain
    ? initialTool('line')
    : {
        kind: 'line',
        start: null,
        lastPointId: end,
        lastLineId: line,
        firstPointId: tool.firstPointId ?? a,
      };
  return { tool: next, edit: b.result() };
}

// ---- arc -------------------------------------------------------------------------------

function reduceArc(
  sketch: SketchData,
  tool: Extract<SketchTool, { kind: 'arc' }>,
  event: Exclude<ToolEvent, { type: 'finish' }>,
  ctx: ToolContext,
): ToolStep {
  if (event.type !== 'click') {
    // A typed bulge height (ends-then-bulge): the arc bulges that far on the pointer's side.
    if (
      event.field === 'height' &&
      tool.mode === 'endsBulge' &&
      tool.start &&
      tool.end &&
      !tool.tangent &&
      event.value >= MIN_SKETCH_SIZE / 10
    ) {
      const through = bulgePoint(tool.start.pos, tool.end.pos, event.snap.pos, event.value);
      if (!through) return { tool };
      const b = new SketchBuilder(sketch);
      const id = addThreePointArc(b, tool.start, through, tool.end);
      if (!id) return { tool };
      if (ctx.construction) {
        b.entities = b.entities.map((e) => (e.id === id ? { ...e, construction: true } : e));
      }
      return { tool: initialTool('arc'), edit: b.result() };
    }
    return { tool };
  }
  const snap = event.snap;
  if (!tool.start) {
    const lineId = snap.pointId ? lineEndedAt(sketch, snap.pointId) : null;
    return {
      tool: {
        ...tool,
        start: snap,
        tangent:
          tool.mode === 'endsBulge' && lineId && snap.pointId
            ? { lineId, pointId: snap.pointId }
            : null,
      },
    };
  }
  if (tool.tangent) {
    const map = entityMap(sketch);
    const line = map.get(tool.tangent.lineId);
    const s = pointPos(map, tool.tangent.pointId);
    if (line?.kind !== 'line' || !s) return { tool: initialTool('arc') };
    const other = pointPos(map, line.a === tool.tangent.pointId ? line.b : line.a)!;
    const arc = tangentArc(s, sub(s, other), snap.pos);
    if (!arc || dist(s, snap.pos) < MIN_SKETCH_SIZE) return { tool };
    const b = new SketchBuilder(sketch);
    const e = b.pointFor(snap);
    const c = b.addPoint(arc.center);
    const id = arc.ccw
      ? b.addArc(c, tool.tangent.pointId, e, ctx.construction)
      : b.addArc(c, e, tool.tangent.pointId, ctx.construction);
    b.constrain('tangent', [tool.tangent.lineId, id], true);
    return { tool: initialTool('arc'), edit: b.result() };
  }
  if (tool.mode === 'threePoint') {
    // Start, a point on the arc, end.
    if (!tool.through) {
      if (dist(tool.start.pos, snap.pos) < MIN_SKETCH_SIZE) return { tool };
      return { tool: { ...tool, through: snap } };
    }
    if (dist(tool.start.pos, snap.pos) < MIN_SKETCH_SIZE) return { tool };
    const b = new SketchBuilder(sketch);
    const id = addThreePointArc(b, tool.start, tool.through.pos, snap);
    if (!id) return { tool };
    if (ctx.construction) {
      b.entities = b.entities.map((e) => (e.id === id ? { ...e, construction: true } : e));
    }
    return { tool: { ...initialTool('arc'), mode: 'threePoint' } as SketchTool, edit: b.result() };
  }
  if (!tool.end) {
    if (dist(tool.start.pos, snap.pos) < MIN_SKETCH_SIZE) return { tool };
    return { tool: { ...tool, end: snap } };
  }
  // Ends then bulge: the pointer sets the arc's height over the chord (a typed height too).
  const through = bulgePoint(tool.start.pos, tool.end.pos, snap.pos, null);
  if (!through) return { tool };
  const b = new SketchBuilder(sketch);
  const id = addThreePointArc(b, tool.start, through, tool.end);
  if (!id) return { tool };
  if (ctx.construction) {
    b.entities = b.entities.map((e) => (e.id === id ? { ...e, construction: true } : e));
  }
  return { tool: initialTool('arc'), edit: b.result() };
}

/**
 * The point on an arc from `a` to `b` whose height over the chord follows
 * `cursor` (its signed distance from the chord line), or a given `height`
 * on the cursor's side. `null` for a height too small to make an arc.
 */
export function bulgePoint(a: Vec2, b: Vec2, cursor: Vec2, height: number | null): Vec2 | null {
  const chord = sub(b, a);
  const length = Math.hypot(chord[0], chord[1]);
  if (length < MIN_SKETCH_SIZE) return null;
  const n: Vec2 = [-chord[1] / length, chord[0] / length];
  const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const signed = (cursor[0] - mid[0]) * n[0] + (cursor[1] - mid[1]) * n[1];
  const h = height === null ? signed : (Math.sign(signed) || 1) * Math.abs(height);
  if (Math.abs(h) < MIN_SKETCH_SIZE / 10) return null;
  return [mid[0] + n[0] * h, mid[1] + n[1] * h];
}

// ---- circle ----------------------------------------------------------------------------

function reduceCircle(
  sketch: SketchData,
  tool: Extract<SketchTool, { kind: 'circle' }>,
  event: Exclude<ToolEvent, { type: 'finish' }>,
  ctx: ToolContext,
): ToolStep {
  if (!tool.center) {
    return event.type === 'click' ? { tool: { ...tool, center: event.snap } } : { tool };
  }
  const b = new SketchBuilder(sketch);
  let radius: number;
  let dimension: SketchDimensionKind | null = null;
  if (event.type === 'value') {
    if (event.field !== 'radius' && event.field !== 'diameter') return { tool };
    radius = event.field === 'diameter' ? event.value / 2 : event.value;
    dimension = event.field;
  } else {
    radius = dist(tool.center.pos, event.snap.pos);
  }
  if (!(radius >= MIN_SKETCH_SIZE / 2)) return { tool };
  const center = b.pointFor(tool.center);
  const id = b.addCircle(center, radius, ctx.construction);
  if (event.type === 'click' && event.snap.pointId && event.snap.pointId !== center) {
    b.constrain('pointOnObject', [event.snap.pointId, id], true);
  }
  if (dimension) {
    b.dimensions.push({
      id: b.id('m'),
      name: nextDimensionName(b.data),
      kind: dimension,
      refs: [id],
      value: dimension === 'diameter' ? radius * 2 : radius,
    });
  }
  return { tool: initialTool('circle'), edit: b.result() };
}

// ---- rectangle -------------------------------------------------------------------------

/** Corner positions (counter-clockwise from bottom-left) of the rectangle a tool would create. */
export function rectangleCorners(
  tool: Extract<SketchTool, { kind: 'rectangle' }>,
  cursor: Vec2,
): [Vec2, Vec2, Vec2, Vec2] | null {
  if (!tool.first) return null;
  const f = tool.first.pos;
  let dx = cursor[0] - f[0];
  let dy = cursor[1] - f[1];
  if (tool.mode === 'center') {
    if (tool.width !== null) dx = (Math.sign(dx) || 1) * (tool.width / 2);
    if (tool.height !== null) dy = (Math.sign(dy) || 1) * (tool.height / 2);
    return [
      [f[0] - Math.abs(dx), f[1] - Math.abs(dy)],
      [f[0] + Math.abs(dx), f[1] - Math.abs(dy)],
      [f[0] + Math.abs(dx), f[1] + Math.abs(dy)],
      [f[0] - Math.abs(dx), f[1] + Math.abs(dy)],
    ];
  }
  if (tool.width !== null) dx = (Math.sign(dx) || 1) * tool.width;
  if (tool.height !== null) dy = (Math.sign(dy) || 1) * tool.height;
  const x0 = Math.min(f[0], f[0] + dx);
  const x1 = Math.max(f[0], f[0] + dx);
  const y0 = Math.min(f[1], f[1] + dy);
  const y1 = Math.max(f[1], f[1] + dy);
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/**
 * Corners of a three-point rectangle: the base from `a` to `b`, the height
 * the pointer's signed distance from the base line (Shapr3D "three points").
 * `height` overrides the distance (typed), on the pointer's side.
 */
export function threePointCorners(
  a: Vec2,
  b: Vec2,
  cursor: Vec2,
  height: number | null = null,
): [Vec2, Vec2, Vec2, Vec2] | null {
  const base = sub(b, a);
  const length = Math.hypot(base[0], base[1]);
  if (length < MIN_SKETCH_SIZE) return null;
  const n: Vec2 = [-base[1] / length, base[0] / length];
  const signed = (cursor[0] - a[0]) * n[0] + (cursor[1] - a[1]) * n[1];
  const h = height === null ? signed : (Math.sign(signed) || 1) * Math.abs(height);
  if (Math.abs(h) < MIN_SKETCH_SIZE) return null;
  return [a, b, [b[0] + n[0] * h, b[1] + n[1] * h], [a[0] + n[0] * h, a[1] + n[1] * h]];
}

function reduceThreePointRectangle(
  sketch: SketchData,
  tool: Extract<SketchTool, { kind: 'rectangle' }>,
  event: Exclude<ToolEvent, { type: 'finish' }>,
  ctx: ToolContext,
): ToolStep {
  if (!tool.first) {
    return event.type === 'click' ? { tool: { ...tool, first: event.snap } } : { tool };
  }
  if (!tool.second) {
    if (event.type === 'value') {
      if (event.field !== 'width' || !(event.value >= MIN_SKETCH_SIZE)) return { tool };
      const pos = withLength(tool.first.pos, event.snap.pos, event.value);
      return { tool: { ...tool, second: { pos }, width: event.value } };
    }
    if (dist(tool.first.pos, event.snap.pos) < MIN_SKETCH_SIZE) return { tool };
    return { tool: { ...tool, second: event.snap } };
  }
  const typed = event.type === 'value' && event.field === 'height' ? event.value : null;
  if (event.type === 'value' && typed === null) return { tool };
  const corners = threePointCorners(tool.first.pos, tool.second.pos, event.snap.pos, typed);
  if (!corners) return { tool };
  const b = new SketchBuilder(sketch);
  const ids = [
    b.pointFor(tool.first),
    b.pointFor(tool.second),
    b.addPoint(corners[2]),
    b.addPoint(corners[3]),
  ];
  const lines = ids.map((id, i) => b.addLine(id, ids[(i + 1) % 4]!, ctx.construction));
  // A rotated rectangle: right angles and parallel sides, no horizontal/vertical.
  b.constrain('perpendicular', [lines[0]!, lines[1]!]);
  b.constrain('parallel', [lines[0]!, lines[2]!]);
  b.constrain('parallel', [lines[1]!, lines[3]!]);
  if (tool.width !== null) {
    b.dimensions.push({
      id: b.id('m'),
      name: nextDimensionName(b.data),
      kind: 'distance',
      refs: [lines[0]!],
      value: tool.width,
    });
  }
  if (typed !== null) {
    b.dimensions.push({
      id: b.id('m'),
      name: nextDimensionName(b.data),
      kind: 'distance',
      refs: [lines[1]!],
      value: typed,
    });
  }
  return {
    tool: { ...initialTool('rectangle'), mode: 'threePoint' } as SketchTool,
    edit: b.result(),
  };
}

function reduceRectangle(
  sketch: SketchData,
  tool: Extract<SketchTool, { kind: 'rectangle' }>,
  event: Exclude<ToolEvent, { type: 'finish' }>,
  ctx: ToolContext,
): ToolStep {
  if (tool.mode === 'threePoint') return reduceThreePointRectangle(sketch, tool, event, ctx);
  if (!tool.first) {
    return event.type === 'click' ? { tool: { ...tool, first: event.snap } } : { tool };
  }
  let next = tool;
  let cursorSnap: SnapTarget = event.snap;
  if (event.type === 'value') {
    if (event.field !== 'width' && event.field !== 'height') return { tool };
    if (!(event.value >= MIN_SKETCH_SIZE)) return { tool };
    next = { ...tool, [event.field]: event.value };
    // Both sides typed: create right away; otherwise wait for the click.
    if (next.width === null || next.height === null) return { tool: next };
    cursorSnap = { pos: event.snap.pos };
  }
  const corners = rectangleCorners(next, cursorSnap.pos);
  if (!corners) return { tool };
  const w = corners[1][0] - corners[0][0];
  const h = corners[3][1] - corners[0][1];
  if (w < MIN_SKETCH_SIZE || h < MIN_SKETCH_SIZE) return { tool };
  const b = new SketchBuilder(sketch);
  const cornerIndex = (p: Vec2) => {
    let best = 0;
    corners.forEach((c, i) => {
      if (dist(c, p) < dist(corners[best]!, p)) best = i;
    });
    return best;
  };
  const pointIds: (string | null)[] = [null, null, null, null];
  if (next.mode === 'corner') {
    pointIds[cornerIndex(next.first!.pos)] = b.pointFor({ ...next.first!, pos: next.first!.pos });
    const other = cornerIndex(cursorSnap.pos);
    if (
      event.type === 'click' &&
      pointIds[other] === null &&
      dist(corners[other]!, cursorSnap.pos) < 1e-9
    ) {
      pointIds[other] = b.pointFor(cursorSnap);
    }
  }
  const ids = corners.map((c, i) => pointIds[i] ?? b.addPoint(c));
  const lines = ids.map((id, i) => b.addLine(id, ids[(i + 1) % 4]!, ctx.construction));
  b.constrain('horizontal', [lines[0]!]);
  b.constrain('vertical', [lines[1]!]);
  b.constrain('horizontal', [lines[2]!]);
  b.constrain('vertical', [lines[3]!]);
  if (next.mode === 'center') {
    const center = b.pointFor(next.first!);
    const diagonal = b.addLine(ids[0]!, ids[2]!, true);
    b.constrain('midpoint', [center, diagonal]);
  }
  if (next.width !== null) {
    b.dimensions.push({
      id: b.id('m'),
      name: nextDimensionName(b.data),
      kind: 'distance',
      refs: [lines[0]!],
      value: w,
    });
  }
  if (next.height !== null) {
    b.dimensions.push({
      id: b.id('m'),
      name: nextDimensionName(b.data),
      kind: 'distance',
      refs: [lines[1]!],
      value: h,
    });
  }
  return { tool: { ...initialTool('rectangle'), mode: tool.mode } as SketchTool, edit: b.result() };
}

// ---- polygon ---------------------------------------------------------------------------

/** Vertex positions of the regular polygon a tool would create. */
export function polygonVertices(center: Vec2, vertex: Vec2, sides: number): Vec2[] {
  const r = dist(center, vertex);
  const a0 = Math.atan2(vertex[1] - center[1], vertex[0] - center[0]);
  return Array.from({ length: sides }, (_, i) => {
    const a = a0 + (i * 2 * Math.PI) / sides;
    return [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)] as Vec2;
  });
}

function reducePolygon(
  sketch: SketchData,
  tool: Extract<SketchTool, { kind: 'polygon' }>,
  event: Exclude<ToolEvent, { type: 'finish' }>,
  ctx: ToolContext,
): ToolStep {
  if (event.type !== 'click') return { tool };
  if (!tool.center) return { tool: { ...tool, center: event.snap } };
  const r = dist(tool.center.pos, event.snap.pos);
  if (r < MIN_SKETCH_SIZE) return { tool };
  const vertices = regularPolygon(tool.center.pos, event.snap.pos, tool.sides, tool.inscribed);
  const b = new SketchBuilder(sketch);
  const center = b.pointFor(tool.center);
  const circle = b.addCircle(center, r, true);
  // Inscribed: the clicked point is a vertex (reuse what it snapped to); circumscribed: an edge midpoint.
  const ids = vertices.map((v, i) =>
    i === 0 && tool.inscribed ? b.pointFor(event.snap) : b.addPoint(v),
  );
  const lines = ids.map((id, i) => b.addLine(id, ids[(i + 1) % ids.length]!, ctx.construction));
  if (tool.inscribed) for (const id of ids) b.constrain('pointOnObject', [id, circle]);
  else for (const line of lines) b.constrain('tangent', [line, circle]);
  for (let i = 1; i < lines.length; i += 1) b.constrain('equal', [lines[0]!, lines[i]!]);
  return {
    tool: { ...tool, center: null },
    edit: b.result(lines),
  };
}

// ---- offset ----------------------------------------------------------------------------

function reduceOffset(
  sketch: SketchData,
  tool: Extract<SketchTool, { kind: 'offset' }>,
  event: Exclude<ToolEvent, { type: 'finish' }>,
): ToolStep {
  if (!tool.curveId) {
    if (event.type === 'click' && event.hit?.kind === 'curve')
      return { tool: { ...tool, curveId: event.hit.id } };
    return { tool };
  }
  const side = offsetSide(sketch, tool.curveId, event.snap.pos);
  const distance =
    event.type === 'value'
      ? event.field === 'distance'
        ? (Math.sign(side) || 1) * event.value
        : 0
      : side;
  const edit = offsetChain(sketch, tool.curveId, distance);
  return edit ? { tool: initialTool('offset'), edit } : { tool };
}

// ---- dimension -------------------------------------------------------------------------

/** Dimension kind and refs for picked entities, or `null` if they cannot be dimensioned together. */
export function planDimension(
  sketch: SketchData,
  picks: readonly string[],
  mode: 'aligned' | 'horizontal' | 'vertical',
): { kind: SketchDimensionKind; refs: string[] } | null {
  const map = entityMap(sketch);
  const [a, b] = picks.map((id) => map.get(id));
  const linear: SketchDimensionKind =
    mode === 'horizontal'
      ? 'horizontalDistance'
      : mode === 'vertical'
        ? 'verticalDistance'
        : 'distance';
  if (picks.length === 1) {
    if (a?.kind === 'line') return { kind: linear, refs: [a.id] };
    if (a?.kind === 'circle') return { kind: 'diameter', refs: [a.id] };
    if (a?.kind === 'arc') return { kind: 'radius', refs: [a.id] };
    return null;
  }
  if (!a || !b) return null;
  if (a.kind === 'point' && b.kind === 'point') return { kind: linear, refs: [a.id, b.id] };
  if (a.kind === 'point' && b.kind === 'line') return { kind: 'distance', refs: [a.id, b.id] };
  if (a.kind === 'line' && b.kind === 'point') return { kind: 'distance', refs: [b.id, a.id] };
  if (a.kind === 'line' && b.kind === 'line') {
    const angle = measure(sketch, 'angle', [a.id, b.id]);
    if (angle === null) return null;
    const parallel = angle < 0.5 || angle > 179.5;
    return parallel
      ? { kind: 'distance', refs: [a.id, b.id] }
      : { kind: 'angle', refs: [a.id, b.id] };
  }
  return null;
}

function reduceDimension(
  sketch: SketchData,
  tool: Extract<SketchTool, { kind: 'dimension' }>,
  event: Exclude<ToolEvent, { type: 'finish' }>,
): ToolStep {
  if (event.type !== 'click') return { tool };
  const hitId = event.hit?.id ?? null;
  if (!tool.first) {
    if (!hitId) return { tool };
    const kind = entityMap(sketch).get(hitId)?.kind;
    // Circles and arcs are dimensioned right away; lines/points wait for a second pick or a placement click.
    if (kind === 'circle' || kind === 'arc')
      return createDimension(sketch, tool, [hitId], event.raw);
    return { tool: { ...tool, first: hitId } };
  }
  const picks = hitId && hitId !== tool.first ? [tool.first, hitId] : [tool.first];
  return createDimension(sketch, tool, picks, event.raw);
}

function createDimension(
  sketch: SketchData,
  tool: Extract<SketchTool, { kind: 'dimension' }>,
  picks: string[],
  placement: Vec2,
): ToolStep {
  const plan = planDimension(sketch, picks, tool.mode);
  const reset: SketchTool = { ...tool, first: null };
  if (!plan) return { tool: reset };
  const value = measure(sketch, plan.kind, plan.refs);
  if (
    value === null ||
    (value <= 0 && plan.kind !== 'horizontalDistance' && plan.kind !== 'verticalDistance')
  ) {
    return { tool: reset };
  }
  const b = new SketchBuilder(sketch);
  const id = b.id('m');
  const offset = labelOffset(sketch, plan.refs, placement);
  b.dimensions.push({
    id,
    name: nextDimensionName(b.data),
    kind: plan.kind,
    refs: plan.refs,
    value,
    ...(offset !== null ? { offset } : {}),
  });
  return { tool: reset, edit: b.result([id]), editDimensionId: id };
}

/** Signed perpendicular offset of the placement click from a line/segment (label layout). */
function labelOffset(sketch: SketchData, refs: readonly string[], placement: Vec2): number | null {
  const map = entityMap(sketch);
  let a: Vec2 | null = null;
  let b: Vec2 | null = null;
  const first = map.get(refs[0] ?? '');
  if (refs.length === 1 && first?.kind === 'line') {
    a = pointPos(map, first.a);
    b = pointPos(map, first.b);
  } else if (refs.length === 2) {
    a = pointPos(map, refs[0]!);
    b = pointPos(map, refs[1]!);
  }
  if (!a || !b || dist(a, b) < 1e-9) return null;
  const d = normalize(sub(b, a));
  return d[0] * (placement[1] - a[1]) - d[1] * (placement[0] - a[0]);
}

// ---- previews --------------------------------------------------------------------------

export interface ToolPreview {
  /** Polylines of the geometry that would be created. */
  curves: Vec2[][];
  /** Points that would be created. */
  points: Vec2[];
  /** Entities highlighted by the tool (trim target, offset source, dimension pick). */
  highlight: string[];
  /** Value chips: field, current value and where to show them. */
  chips: { field: ValueField; value: number; at: Vec2 }[];
}

const EMPTY_PREVIEW: ToolPreview = { curves: [], points: [], highlight: [], chips: [] };

/** Rubber-band preview of the active tool at the current (snapped) cursor. */
export function toolPreview(
  sketch: SketchData,
  tool: SketchTool,
  cursor: Inference | null,
  hit: SketchHit | null,
  ctx: ToolContext = { construction: false },
): ToolPreview {
  if (!cursor) return EMPTY_PREVIEW;
  if (isAdvancedTool(tool)) return advancedPreview(sketch, tool, cursor, hit, ctx);
  const c = cursor.pos;
  switch (tool.kind) {
    case 'line': {
      const from = segmentStart(sketch, tool);
      if (!from) return { ...EMPTY_PREVIEW, points: [c] };
      const length = dist(from.pos, c);
      return {
        ...EMPTY_PREVIEW,
        curves: [[from.pos, c]],
        points: [c],
        chips: [
          {
            field: 'length',
            value: length,
            at: [(from.pos[0] + c[0]) / 2, (from.pos[1] + c[1]) / 2],
          },
        ],
      };
    }
    case 'arc': {
      if (!tool.start) return { ...EMPTY_PREVIEW, points: [c] };
      if (tool.tangent) {
        const map = entityMap(sketch);
        const line = map.get(tool.tangent.lineId);
        const s = pointPos(map, tool.tangent.pointId);
        if (line?.kind !== 'line' || !s) return EMPTY_PREVIEW;
        const other = pointPos(map, line.a === tool.tangent.pointId ? line.b : line.a)!;
        const arc = tangentArc(s, sub(s, other), c);
        if (!arc) return { ...EMPTY_PREVIEW, curves: [[s, c]] };
        return {
          ...EMPTY_PREVIEW,
          curves: [sampleCurve(arcCurve(arc.center, arc.ccw ? s : c, arc.ccw ? c : s))],
        };
      }
      // The arc through `start`, `through`, `end` (three points in order along the arc).
      const arcThrough = (start: Vec2, through: Vec2, end: Vec2): Vec2[] | null => {
        const circle = circleThrough(start, through, end);
        if (!circle) return null;
        const ccw =
          (through[0] - start[0]) * (end[1] - through[1]) -
            (through[1] - start[1]) * (end[0] - through[0]) >
          0;
        const [s, e] = ccw ? [start, end] : [end, start];
        return sampleCurve(arcCurve(circle.c, s, e));
      };
      if (tool.mode === 'threePoint') {
        if (!tool.through) {
          return { ...EMPTY_PREVIEW, curves: [[tool.start.pos, c]], points: [tool.start.pos, c] };
        }
        const arc = arcThrough(tool.start.pos, tool.through.pos, c);
        return {
          ...EMPTY_PREVIEW,
          curves: [arc ?? [tool.start.pos, tool.through.pos, c]],
          points: [tool.start.pos, tool.through.pos, c],
        };
      }
      if (!tool.end)
        return { ...EMPTY_PREVIEW, curves: [[tool.start.pos, c]], points: [tool.start.pos, c] };
      const through = bulgePoint(tool.start.pos, tool.end.pos, c, null);
      const arc = through ? arcThrough(tool.start.pos, through, tool.end.pos) : null;
      if (!arc || !through) return { ...EMPTY_PREVIEW, curves: [[tool.start.pos, tool.end.pos]] };
      const mid: Vec2 = [
        (tool.start.pos[0] + tool.end.pos[0]) / 2,
        (tool.start.pos[1] + tool.end.pos[1]) / 2,
      ];
      return {
        ...EMPTY_PREVIEW,
        curves: [arc, [mid, through]],
        points: [tool.start.pos, tool.end.pos, through],
        // The bulge (height over the chord) can be typed.
        chips: [{ field: 'height', value: dist(mid, through), at: through }],
      };
    }
    case 'circle': {
      if (!tool.center) return { ...EMPTY_PREVIEW, points: [c] };
      const r = dist(tool.center.pos, c);
      const curve: Curve2 = { kind: 'arc', c: tool.center.pos, r, a0: 0, sweep: Math.PI * 2 };
      const at: Vec2 = [
        tool.center.pos[0] + r * Math.SQRT1_2,
        tool.center.pos[1] + r * Math.SQRT1_2,
      ];
      return {
        ...EMPTY_PREVIEW,
        curves: [sampleCurve(curve)],
        points: [tool.center.pos],
        chips: [{ field: 'diameter', value: r * 2, at }],
      };
    }
    case 'rectangle': {
      if (tool.mode === 'threePoint') {
        if (!tool.first) return { ...EMPTY_PREVIEW, points: [c] };
        if (!tool.second) {
          const f = tool.first.pos;
          return {
            ...EMPTY_PREVIEW,
            curves: [[f, c]],
            points: [f, c],
            chips: [
              { field: 'width', value: dist(f, c), at: [(f[0] + c[0]) / 2, (f[1] + c[1]) / 2] },
            ],
          };
        }
        const corners3 = threePointCorners(tool.first.pos, tool.second.pos, c);
        if (!corners3) {
          return { ...EMPTY_PREVIEW, curves: [[tool.first.pos, tool.second.pos]], points: [c] };
        }
        return {
          ...EMPTY_PREVIEW,
          curves: [[...corners3, corners3[0]]],
          points: corners3,
          chips: [
            {
              field: 'height',
              value: dist(corners3[1], corners3[2]),
              at: [(corners3[1][0] + corners3[2][0]) / 2, (corners3[1][1] + corners3[2][1]) / 2],
            },
          ],
        };
      }
      const corners = rectangleCorners(tool, c);
      if (!corners) return { ...EMPTY_PREVIEW, points: [c] };
      return {
        ...EMPTY_PREVIEW,
        curves: [[...corners, corners[0]]],
        points: corners,
        chips: [
          {
            field: 'width',
            value: corners[1][0] - corners[0][0],
            at: [(corners[0][0] + corners[1][0]) / 2, corners[0][1]],
          },
          {
            field: 'height',
            value: corners[2][1] - corners[1][1],
            at: [corners[1][0], (corners[1][1] + corners[2][1]) / 2],
          },
        ],
      };
    }
    case 'polygon': {
      if (!tool.center) return { ...EMPTY_PREVIEW, points: [c] };
      const vertices = regularPolygon(tool.center.pos, c, tool.sides, tool.inscribed);
      const r = dist(tool.center.pos, c);
      const circle: Curve2 = { kind: 'arc', c: tool.center.pos, r, a0: 0, sweep: Math.PI * 2 };
      return {
        ...EMPTY_PREVIEW,
        curves: [[...vertices, vertices[0]!], sampleCurve(circle)],
        points: [tool.center.pos, ...vertices],
      };
    }
    case 'trim':
      return { ...EMPTY_PREVIEW, highlight: hit?.kind === 'curve' ? [hit.id] : [] };
    case 'offset': {
      if (!tool.curveId)
        return { ...EMPTY_PREVIEW, highlight: hit?.kind === 'curve' ? [hit.id] : [] };
      const side = offsetSide(sketch, tool.curveId, c);
      const edit = offsetChain(sketch, tool.curveId, side);
      const curves: Vec2[][] = [];
      if (edit) {
        const before = new Set(sketch.entities.map((e) => e.id));
        const map = entityMap(edit.sketch);
        for (const e of edit.sketch.entities) {
          if (before.has(e.id) || !isCurve(e)) continue;
          const curve = entityCurve(map, e);
          if (curve) curves.push(sampleCurve(curve));
        }
      }
      return {
        ...EMPTY_PREVIEW,
        curves,
        highlight: [tool.curveId],
        chips: [{ field: 'distance', value: Math.abs(side), at: c }],
      };
    }
    case 'dimension':
      return {
        ...EMPTY_PREVIEW,
        highlight: [...(tool.first ? [tool.first] : []), ...(hit ? [hit.id] : [])],
      };
    default:
      return EMPTY_PREVIEW;
  }
}

function arcCurve(center: Vec2, start: Vec2, end: Vec2): Curve2 {
  const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const a1 = Math.atan2(end[1] - center[1], end[0] - center[0]);
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const curve: Curve2 = { kind: 'arc', c: center, r: dist(center, start), a0, sweep };
  return isFullCircle(curve) ? { ...curve, sweep: Math.PI * 2 - 1e-9 } : curve;
}
