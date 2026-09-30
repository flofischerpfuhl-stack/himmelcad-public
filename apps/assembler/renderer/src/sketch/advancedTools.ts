/**
 * The advanced sketch tools as pure reducers and previews (the same
 * contract as `tools.ts`): Spline (fit / control points), Slot (straight /
 * arc), Ellipse (full / arc), Mirror, Pattern (linear / circular),
 * Fillet/Chamfer corners, Project and Text. Every completed operation is one
 * edit (one session undo step); the session solves it before adopting it.
 * Project and Text finish through the session (they need the evaluated
 * bodies / the font); their reducers only track placement.
 */
import { SketchBuilder, type EditResult, type SnapTarget } from './edits.js';
import { dist, entityCurves, normalize, sampleCurve, sub, type Curve2 } from './geometry.js';
import type { Inference, SketchHit } from './inference.js';
import {
  circularPattern,
  cornerLines,
  linearPattern,
  mirrorGeometry,
  roundCorner,
} from './operations.js';
import {
  buildArcSlot,
  buildEllipse,
  buildSlot,
  buildSpline,
  ellipseMinor,
  ellipseOutline,
  ellipseParam,
} from './shapes.js';
import { entityMap, isCurve, pointPos, type SketchData, type Vec2 } from './types.js';

/** Smallest size a tool creates, mm (same as the basic tools). */
const MIN_SIZE = 0.1;

export type AdvancedTool =
  | { kind: 'spline'; mode: 'fit' | 'control'; points: SnapTarget[] }
  | {
      kind: 'slot';
      mode: 'straight' | 'arc';
      /** Straight: first centre. Arc: the arc's centre. */
      first: SnapTarget | null;
      /** Straight: second centre. Arc: the start centre. */
      second: SnapTarget | null;
      /** Arc: end of the centre arc and its direction. */
      third: { pos: Vec2; ccw: boolean } | null;
      /** Typed centre distance / width (locks it). */
      length: number | null;
      width: number | null;
    }
  | {
      kind: 'ellipse';
      mode: 'full' | 'arc';
      center: SnapTarget | null;
      major: SnapTarget | null;
      minor: number | null;
      /** Arc: start parametric angle. */
      start: number | null;
      majorValue: number | null;
      minorValue: number | null;
    }
  | {
      kind: 'mirror';
      /** Geometry to mirror (picked, or the selection when the tool started). */
      ids: string[];
      step: 'geometry' | 'axis';
    }
  | {
      kind: 'pattern';
      mode: 'linear' | 'circular';
      ids: string[];
      step: 'geometry' | 'place';
      count: number;
      /** Linear: typed spacing (locks it). */
      spacing: number | null;
      /** Circular: total angle, degrees (360 = full turn). */
      angle: number;
    }
  | { kind: 'corner'; mode: 'fillet' | 'chamfer'; pointId: string | null }
  | { kind: 'project' }
  | {
      kind: 'text';
      anchor: SnapTarget | null;
      text: string;
      height: number;
      angle: number;
      /** Existing text entity being edited (its anchor stays). */
      editing: string | null;
    };

export type AdvancedToolKind = AdvancedTool['kind'];

export const ADVANCED_TOOL_KINDS: readonly AdvancedToolKind[] = [
  'spline',
  'slot',
  'ellipse',
  'mirror',
  'pattern',
  'corner',
  'project',
  'text',
];

export function isAdvancedTool(tool: { kind: string }): tool is AdvancedTool {
  return (ADVANCED_TOOL_KINDS as readonly string[]).includes(tool.kind);
}

export type AdvancedValueField = 'count' | 'spacing' | 'angle' | 'major' | 'minor' | 'size';

type Field =
  | AdvancedValueField
  | 'length'
  | 'radius'
  | 'diameter'
  | 'width'
  | 'height'
  | 'distance';

type Event =
  | { type: 'click'; snap: Inference; hit: SketchHit | null; raw: Vec2 }
  | { type: 'value'; field: Field; value: number; snap: Inference }
  | { type: 'finish' };

export interface AdvancedStep {
  tool: AdvancedTool;
  edit?: EditResult;
  /** Why the input did nothing (shown in the tool pill until the next input). */
  notice?: string;
}

export function initialAdvancedTool(
  kind: AdvancedToolKind,
  selection: readonly string[] = [],
): AdvancedTool {
  switch (kind) {
    case 'spline':
      return { kind, mode: 'fit', points: [] };
    case 'slot':
      return {
        kind,
        mode: 'straight',
        first: null,
        second: null,
        third: null,
        length: null,
        width: null,
      };
    case 'ellipse':
      return {
        kind,
        mode: 'full',
        center: null,
        major: null,
        minor: null,
        start: null,
        majorValue: null,
        minorValue: null,
      };
    case 'mirror':
      return { kind, ids: [...selection], step: selection.length > 0 ? 'axis' : 'geometry' };
    case 'pattern':
      return {
        kind,
        mode: 'linear',
        ids: [...selection],
        step: selection.length > 0 ? 'place' : 'geometry',
        count: 3,
        spacing: null,
        angle: 360,
      };
    case 'corner':
      return { kind, mode: 'fillet', pointId: null };
    case 'project':
      return { kind };
    case 'text':
      return { kind, anchor: null, text: 'Text', height: 10, angle: 0, editing: null };
  }
}

export function advancedInProgress(tool: AdvancedTool): boolean {
  switch (tool.kind) {
    case 'spline':
      return tool.points.length > 0;
    case 'slot':
      return tool.first !== null;
    case 'ellipse':
      return tool.center !== null;
    case 'mirror':
    case 'pattern':
      return tool.ids.length > 0;
    case 'corner':
      return tool.pointId !== null;
    case 'project':
      return false;
    case 'text':
      return tool.anchor !== null || tool.editing !== null;
  }
}

/** Start of the rubber band for inference (horizontal/vertical guides). */
export function advancedSegmentStart(
  sketch: SketchData,
  tool: AdvancedTool,
): { pos: Vec2; pointId?: string } | undefined {
  if (tool.kind === 'spline' && tool.points.length > 0) {
    const last = tool.points[tool.points.length - 1]!;
    return { pos: last.pos, ...(last.pointId ? { pointId: last.pointId } : {}) };
  }
  if (tool.kind === 'slot' && tool.first && !tool.second) return { pos: tool.first.pos };
  if (tool.kind === 'ellipse' && tool.center && !tool.major) return { pos: tool.center.pos };
  if (tool.kind === 'pattern' && tool.step === 'place' && tool.mode === 'linear') {
    const base = patternBase(sketch, tool.ids);
    return base ? { pos: base } : undefined;
  }
  return undefined;
}

/** First defining point of the pattern selection (the linear pattern's rubber-band origin). */
export function patternBase(sketch: SketchData, ids: readonly string[]): Vec2 | null {
  const map = entityMap(sketch);
  for (const id of ids) {
    const e = map.get(id);
    if (e?.kind === 'point') return [e.x, e.y];
    if (!isCurve(e)) continue;
    const first =
      e.kind === 'line'
        ? e.a
        : e.kind === 'spline'
          ? e.points[0]!
          : e.kind === 'text'
            ? e.anchor
            : e.center;
    const p = pointPos(map, first);
    if (p) return p;
  }
  return null;
}

function toggle(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** Horizontal/vertical when the direction is within 3° of an axis (like line inference). */
function axisSnap(d: Vec2): { horizontal?: boolean; vertical?: boolean } {
  const a = Math.atan2(d[1], d[0]);
  const off = (t: number) => Math.abs(Math.atan2(Math.sin(a - t), Math.cos(a - t)));
  const tol = (3 * Math.PI) / 180;
  if (Math.min(off(0), off(Math.PI)) < tol) return { horizontal: true };
  if (Math.min(off(Math.PI / 2), off(-Math.PI / 2)) < tol) return { vertical: true };
  return {};
}

export function reduceAdvanced(
  sketch: SketchData,
  tool: AdvancedTool,
  event: Event,
  ctx: { construction: boolean },
): AdvancedStep {
  switch (tool.kind) {
    case 'spline':
      return reduceSpline(sketch, tool, event, ctx);
    case 'slot':
      return reduceSlot(sketch, tool, event, ctx);
    case 'ellipse':
      return reduceEllipse(sketch, tool, event, ctx);
    case 'mirror':
      return reduceMirror(sketch, tool, event);
    case 'pattern':
      return reducePattern(sketch, tool, event);
    case 'corner':
      return reduceCorner(sketch, tool, event);
    case 'project':
      return { tool };
    case 'text':
      if (event.type === 'click' && !tool.anchor && !tool.editing) {
        return { tool: { ...tool, anchor: event.snap } };
      }
      if (event.type === 'value' && event.field === 'height' && event.value >= MIN_SIZE) {
        return { tool: { ...tool, height: event.value } };
      }
      if (event.type === 'value' && event.field === 'angle') {
        return { tool: { ...tool, angle: event.value } };
      }
      return { tool };
  }
}

// ---- spline ----------------------------------------------------------------------------

function splineEdit(
  sketch: SketchData,
  points: readonly SnapTarget[],
  mode: 'fit' | 'control',
  ctx: { construction: boolean },
): EditResult {
  const b = new SketchBuilder(sketch);
  const id = buildSpline(b, points, mode, ctx.construction);
  return b.result([id]);
}

function reduceSpline(
  sketch: SketchData,
  tool: Extract<AdvancedTool, { kind: 'spline' }>,
  event: Event,
  ctx: { construction: boolean },
): AdvancedStep {
  if (event.type === 'value') return { tool };
  const points = tool.points;
  const reset = { ...tool, points: [] };
  const finish = (list: readonly SnapTarget[]): AdvancedStep =>
    list.length < 2
      ? { tool: reset }
      : { tool: reset, edit: splineEdit(sketch, list, tool.mode, ctx) };
  if (event.type === 'finish') return finish(points);
  const snap = event.snap;
  const last = points[points.length - 1];
  // A second click on the last point (double click) ends the spline.
  if (last && dist(last.pos, snap.pos) < MIN_SIZE) return finish(points);
  const first = points[0];
  if (first && points.length >= 2 && dist(first.pos, snap.pos) < MIN_SIZE) {
    // Clicking the first point closes the spline on it: the first point is reused as the last.
    if (!first.pointId) {
      const b = new SketchBuilder(sketch);
      const startId = b.pointFor(first);
      const closed = [
        { ...first, pointId: startId },
        ...points.slice(1),
        { pos: first.pos, pointId: startId },
      ];
      const id = buildSpline(b, closed, tool.mode, ctx.construction);
      return { tool: reset, edit: b.result([id]) };
    }
    return finish([...points, { pos: first.pos, pointId: first.pointId }]);
  }
  return { tool: { ...tool, points: [...points, snap] } };
}

// ---- slot ------------------------------------------------------------------------------

function reduceSlot(
  sketch: SketchData,
  tool: Extract<AdvancedTool, { kind: 'slot' }>,
  event: Event,
  ctx: { construction: boolean },
): AdvancedStep {
  if (event.type === 'finish') return { tool };
  const reset = { ...tool, first: null, second: null, third: null, length: null, width: null };
  if (!tool.first) {
    return event.type === 'click' ? { tool: { ...tool, first: event.snap } } : { tool };
  }
  if (tool.mode === 'straight') {
    if (!tool.second) {
      if (event.type === 'value') {
        if (event.field !== 'length' || !(event.value >= MIN_SIZE)) return { tool };
        const d = normalize(sub(event.snap.pos, tool.first.pos));
        const dir: Vec2 = Math.hypot(d[0], d[1]) > 0 ? d : [1, 0];
        const pos: Vec2 = [
          tool.first.pos[0] + dir[0] * event.value,
          tool.first.pos[1] + dir[1] * event.value,
        ];
        return { tool: { ...tool, second: { pos }, length: event.value } };
      }
      if (dist(tool.first.pos, event.snap.pos) < MIN_SIZE) return { tool };
      return { tool: { ...tool, second: event.snap } };
    }
    const half = slotHalfWidth(tool, event);
    if (half === null) return { tool };
    const b = new SketchBuilder(sketch);
    const ids = buildSlot(b, tool.first, tool.second, half, {
      construction: ctx.construction,
      length: tool.length,
      width: event.type === 'value' ? half * 2 : null,
    });
    return { tool: reset, edit: b.result(ids) };
  }
  // Arc slot: centre, start centre, end of the centre arc, width.
  if (!tool.second) {
    if (event.type !== 'click' || dist(tool.first.pos, event.snap.pos) < MIN_SIZE) return { tool };
    return { tool: { ...tool, second: event.snap } };
  }
  if (!tool.third) {
    if (event.type !== 'click') return { tool };
    const ccw = arcDirection(tool.first.pos, tool.second.pos, event.snap.pos);
    return { tool: { ...tool, third: { pos: event.snap.pos, ccw } } };
  }
  const half = slotHalfWidth(tool, event);
  if (half === null) return { tool };
  const r = dist(tool.first.pos, tool.second.pos);
  if (half >= r - 1e-6) return { tool, notice: 'The slot is wider than its arc radius allows.' };
  const b = new SketchBuilder(sketch);
  const ids = buildArcSlot(b, tool.first, tool.second, tool.third.pos, half, tool.third.ccw, {
    construction: ctx.construction,
    width: event.type === 'value' ? half * 2 : null,
  });
  return { tool: reset, edit: b.result(ids) };
}

/** `true` when the centre arc from `start` towards `end` runs counter-clockwise (the shorter way). */
function arcDirection(center: Vec2, start: Vec2, end: Vec2): boolean {
  const a = sub(start, center);
  const e = sub(end, center);
  return a[0] * e[1] - a[1] * e[0] >= 0;
}

function slotHalfWidth(tool: Extract<AdvancedTool, { kind: 'slot' }>, event: Event): number | null {
  if (event.type === 'value') {
    if (event.field !== 'width' || !(event.value >= MIN_SIZE)) return null;
    return event.value / 2;
  }
  if (event.type !== 'click') return null;
  const half = slotCursorHalfWidth(tool, event.snap.pos);
  return half !== null && half >= MIN_SIZE / 2 ? half : null;
}

/** Half width a cursor position gives: its distance from the slot's centre line / centre arc. */
export function slotCursorHalfWidth(
  tool: Extract<AdvancedTool, { kind: 'slot' }>,
  cursor: Vec2,
): number | null {
  if (!tool.first || !tool.second) return null;
  if (tool.width !== null) return tool.width / 2;
  if (tool.mode === 'straight') {
    const d = normalize(sub(tool.second.pos, tool.first.pos));
    const rel = sub(cursor, tool.first.pos);
    return Math.abs(-d[1] * rel[0] + d[0] * rel[1]);
  }
  return Math.abs(dist(cursor, tool.first.pos) - dist(tool.second.pos, tool.first.pos));
}

// ---- ellipse ---------------------------------------------------------------------------

function reduceEllipse(
  sketch: SketchData,
  tool: Extract<AdvancedTool, { kind: 'ellipse' }>,
  event: Event,
  ctx: { construction: boolean },
): AdvancedStep {
  if (event.type === 'finish') return { tool };
  const reset = {
    ...tool,
    center: null,
    major: null,
    minor: null,
    start: null,
    majorValue: null,
    minorValue: null,
  };
  if (!tool.center) {
    return event.type === 'click' ? { tool: { ...tool, center: event.snap } } : { tool };
  }
  if (!tool.major) {
    if (event.type === 'value') {
      if (event.field !== 'major' || !(event.value >= MIN_SIZE)) return { tool };
      const d = normalize(sub(event.snap.pos, tool.center.pos));
      const dir: Vec2 = Math.hypot(d[0], d[1]) > 0 ? d : [1, 0];
      const pos: Vec2 = [
        tool.center.pos[0] + dir[0] * event.value,
        tool.center.pos[1] + dir[1] * event.value,
      ];
      return { tool: { ...tool, major: { pos }, majorValue: event.value } };
    }
    if (dist(tool.center.pos, event.snap.pos) < MIN_SIZE) return { tool };
    return { tool: { ...tool, major: event.snap } };
  }
  const majorRadius = dist(tool.center.pos, tool.major.pos);
  if (tool.minor === null) {
    let minor: number;
    let minorValue: number | null = null;
    if (event.type === 'value') {
      if (event.field !== 'minor' || !(event.value >= MIN_SIZE)) return { tool };
      minor = event.value;
      minorValue = event.value;
    } else {
      minor = ellipseMinor(tool.center.pos, tool.major.pos, event.snap.pos);
    }
    if (!(minor >= MIN_SIZE / 2)) return { tool };
    if (minor > majorRadius) {
      return {
        tool,
        notice: 'The second axis must not be longer than the first: draw the longer axis first.',
      };
    }
    if (tool.mode === 'arc') return { tool: { ...tool, minor, minorValue } };
    const b = new SketchBuilder(sketch);
    const id = buildEllipse(b, tool.center, tool.major, minor, {
      construction: ctx.construction,
      majorValue: tool.majorValue,
      minorValue,
    });
    return { tool: reset, edit: b.result([id]) };
  }
  if (event.type !== 'click') return { tool };
  const angle = ellipseParam(tool.center.pos, tool.major.pos, tool.minor, event.snap.pos);
  if (tool.start === null) return { tool: { ...tool, start: angle } };
  if (Math.abs(angle - tool.start) < 1e-3) return { tool };
  const b = new SketchBuilder(sketch);
  const id = buildEllipse(b, tool.center, tool.major, tool.minor, {
    construction: ctx.construction,
    arc: [tool.start, angle],
    majorValue: tool.majorValue,
    minorValue: tool.minorValue,
  });
  return { tool: reset, edit: b.result([id]) };
}

// ---- mirror / pattern --------------------------------------------------------------------

function reduceMirror(
  sketch: SketchData,
  tool: Extract<AdvancedTool, { kind: 'mirror' }>,
  event: Event,
): AdvancedStep {
  if (event.type === 'finish') {
    if (tool.step === 'geometry' && tool.ids.length > 0) return { tool: { ...tool, step: 'axis' } };
    return { tool };
  }
  if (event.type !== 'click') return { tool };
  const hit = event.hit;
  if (tool.step === 'geometry') {
    if (!hit) return { tool };
    return { tool: { ...tool, ids: toggle(tool.ids, hit.id) } };
  }
  const axis = hit?.kind === 'curve' ? entityMap(sketch).get(hit.id) : undefined;
  if (axis?.kind !== 'line') return { tool, notice: 'Click a line to mirror about.' };
  const edit = mirrorGeometry(sketch, tool.ids, axis.id);
  if (!edit) return { tool, notice: 'Nothing to mirror: select curves or points first.' };
  return { tool: { kind: 'mirror', ids: [], step: 'geometry' }, edit };
}

function reducePattern(
  sketch: SketchData,
  tool: Extract<AdvancedTool, { kind: 'pattern' }>,
  event: Event,
): AdvancedStep {
  if (event.type === 'finish') {
    if (tool.step === 'geometry' && tool.ids.length > 0)
      return { tool: { ...tool, step: 'place' } };
    return { tool };
  }
  if (event.type === 'value') {
    if (event.field === 'count') {
      const count = Math.round(event.value);
      if (count < 2 || count > 200) return { tool, notice: 'Use 2 to 200 instances.' };
      return { tool: { ...tool, count } };
    }
    if (event.field === 'angle' && tool.mode === 'circular') {
      if (!(Math.abs(event.value) > 0) || Math.abs(event.value) > 360) return { tool };
      return { tool: { ...tool, angle: event.value } };
    }
    if (event.field === 'spacing' && tool.mode === 'linear' && tool.step === 'place') {
      if (!(event.value >= MIN_SIZE)) return { tool };
      return placeLinear(sketch, { ...tool, spacing: event.value }, event.snap.pos);
    }
    return { tool };
  }
  const hit = event.hit;
  if (tool.step === 'geometry') {
    if (!hit) return { tool };
    return { tool: { ...tool, ids: toggle(tool.ids, hit.id) } };
  }
  if (tool.mode === 'linear') return placeLinear(sketch, tool, event.snap.pos);
  const edit = circularPattern(sketch, tool.ids, tool.count, event.snap, tool.angle);
  if (!edit) return { tool, notice: 'Nothing to pattern: select curves or points first.' };
  return { tool: { ...tool, ids: [], step: 'geometry' }, edit };
}

/** Direction and spacing of a linear pattern for a cursor position. */
export function linearPlacement(
  sketch: SketchData,
  tool: Extract<AdvancedTool, { kind: 'pattern' }>,
  cursor: Vec2,
): { direction: Vec2; spacing: number; horizontal?: boolean; vertical?: boolean } | null {
  const base = patternBase(sketch, tool.ids);
  if (!base) return null;
  const d = sub(cursor, base);
  const length = Math.hypot(d[0], d[1]);
  if (length < 1e-9) return null;
  const snap = axisSnap(d);
  const direction: Vec2 = snap.horizontal
    ? [Math.sign(d[0]) || 1, 0]
    : snap.vertical
      ? [0, Math.sign(d[1]) || 1]
      : normalize(d);
  // The cursor marks the last instance: spacing = distance / (count - 1).
  const spacing = tool.spacing ?? length / Math.max(1, tool.count - 1);
  return { direction, spacing, ...snap };
}

function placeLinear(
  sketch: SketchData,
  tool: Extract<AdvancedTool, { kind: 'pattern' }>,
  cursor: Vec2,
): AdvancedStep {
  const placement = linearPlacement(sketch, tool, cursor);
  if (!placement || !(placement.spacing >= MIN_SIZE)) return { tool };
  const edit = linearPattern(sketch, tool.ids, tool.count, placement.direction, placement.spacing, {
    ...(placement.horizontal ? { horizontal: true } : {}),
    ...(placement.vertical ? { vertical: true } : {}),
  });
  if (!edit) return { tool, notice: 'Nothing to pattern: select curves or points first.' };
  return { tool: { ...tool, ids: [], step: 'geometry', spacing: null }, edit };
}

// ---- fillet / chamfer --------------------------------------------------------------------

/** Fillet radius / chamfer set-back a cursor gives: its distance from the corner. */
export function cornerCursorSize(sketch: SketchData, pointId: string, cursor: Vec2): number {
  const p = pointPos(entityMap(sketch), pointId);
  return p ? dist(p, cursor) : 0;
}

function reduceCorner(
  sketch: SketchData,
  tool: Extract<AdvancedTool, { kind: 'corner' }>,
  event: Event,
): AdvancedStep {
  if (event.type === 'finish') return { tool };
  if (!tool.pointId) {
    if (event.type !== 'click') return { tool };
    const pointId = event.hit?.kind === 'point' ? event.hit.id : (event.snap.pointId ?? null);
    if (!pointId) return { tool, notice: 'Click a corner point between two lines.' };
    const lines = cornerLines(sketch, pointId);
    if ('reason' in lines) return { tool, notice: lines.reason };
    return { tool: { ...tool, pointId } };
  }
  const size =
    event.type === 'value'
      ? event.field === 'size'
        ? event.value
        : null
      : cornerCursorSize(sketch, tool.pointId, event.snap.pos);
  if (size === null || !(size >= MIN_SIZE / 2)) return { tool };
  const edit = roundCorner(sketch, tool.pointId, size, tool.mode);
  if ('reason' in edit) return { tool, notice: edit.reason };
  return { tool: { ...tool, pointId: null }, edit };
}

// ---- previews ----------------------------------------------------------------------------

export interface AdvancedPreview {
  curves: Vec2[][];
  points: Vec2[];
  highlight: string[];
  chips: { field: Field; value: number; at: Vec2 }[];
}

/** Polylines of every curve an edit adds (for previews that reuse the real builder). */
export function addedCurves(before: SketchData, edit: EditResult | null | undefined): Vec2[][] {
  if (!edit) return [];
  const known = new Set(before.entities.map((e) => e.id));
  const map = entityMap(edit.sketch);
  const out: Vec2[][] = [];
  for (const e of edit.sketch.entities) {
    if (known.has(e.id) || !isCurve(e)) continue;
    for (const { curve } of entityCurves(map, e)) out.push(sampleCurve(curve));
  }
  return out;
}

const EMPTY: AdvancedPreview = { curves: [], points: [], highlight: [], chips: [] };

export function advancedPreview(
  sketch: SketchData,
  tool: AdvancedTool,
  cursor: Inference,
  hit: SketchHit | null,
  ctx: { construction: boolean },
): AdvancedPreview {
  const c = cursor.pos;
  switch (tool.kind) {
    case 'spline': {
      if (tool.points.length === 0) return { ...EMPTY, points: [c] };
      const list = [...tool.points, cursor];
      const edit = list.length >= 2 ? splineEdit(sketch, list, tool.mode, ctx) : null;
      const curves = addedCurves(sketch, edit);
      if (tool.mode === 'control') curves.push(list.map((p) => p.pos));
      return { ...EMPTY, curves, points: list.map((p) => p.pos) };
    }
    case 'slot': {
      if (!tool.first) return { ...EMPTY, points: [c] };
      if (!tool.second) {
        if (tool.mode === 'straight') {
          return {
            ...EMPTY,
            curves: [[tool.first.pos, c]],
            points: [tool.first.pos, c],
            chips: [
              {
                field: 'length',
                value: dist(tool.first.pos, c),
                at: [(tool.first.pos[0] + c[0]) / 2, (tool.first.pos[1] + c[1]) / 2],
              },
            ],
          };
        }
        const r = dist(tool.first.pos, c);
        const circle: Curve2 = { kind: 'arc', c: tool.first.pos, r, a0: 0, sweep: Math.PI * 2 };
        return { ...EMPTY, curves: [sampleCurve(circle)], points: [tool.first.pos, c] };
      }
      if (tool.mode === 'arc' && !tool.third) {
        const center = tool.first.pos;
        const r = dist(center, tool.second.pos);
        const a0 = Math.atan2(tool.second.pos[1] - center[1], tool.second.pos[0] - center[0]);
        const a1 = Math.atan2(c[1] - center[1], c[0] - center[0]);
        const ccw = arcDirection(center, tool.second.pos, c);
        let sweep = a1 - a0;
        if (ccw) while (sweep <= 0) sweep += Math.PI * 2;
        else while (sweep >= 0) sweep -= Math.PI * 2;
        const arc: Curve2 = { kind: 'arc', c: center, r, a0, sweep };
        return { ...EMPTY, curves: [sampleCurve(arc)], points: [center, tool.second.pos] };
      }
      const half = slotCursorHalfWidth(tool, c) ?? 0;
      if (!(half >= MIN_SIZE / 2)) return { ...EMPTY, points: [c] };
      const b = new SketchBuilder(sketch);
      if (tool.mode === 'straight') {
        buildSlot(b, tool.first, tool.second!, half, { construction: ctx.construction });
      } else if (half < dist(tool.first.pos, tool.second!.pos)) {
        buildArcSlot(b, tool.first, tool.second!, tool.third!.pos, half, tool.third!.ccw, {
          construction: ctx.construction,
        });
      }
      return {
        ...EMPTY,
        curves: addedCurves(sketch, b.result()),
        chips: [{ field: 'width', value: half * 2, at: c }],
      };
    }
    case 'ellipse': {
      if (!tool.center) return { ...EMPTY, points: [c] };
      if (!tool.major) {
        return {
          ...EMPTY,
          curves: [[tool.center.pos, c]],
          points: [tool.center.pos, c],
          chips: [{ field: 'major', value: dist(tool.center.pos, c), at: c }],
        };
      }
      if (tool.minor === null) {
        const minor = Math.min(
          ellipseMinor(tool.center.pos, tool.major.pos, c),
          dist(tool.center.pos, tool.major.pos),
        );
        return {
          ...EMPTY,
          curves: [ellipseOutline(tool.center.pos, tool.major.pos, Math.max(minor, 1e-3))],
          points: [tool.center.pos, tool.major.pos],
          chips: [{ field: 'minor', value: minor, at: c }],
        };
      }
      const angle = ellipseParam(tool.center.pos, tool.major.pos, tool.minor, c);
      const full = ellipseOutline(tool.center.pos, tool.major.pos, tool.minor);
      if (tool.start === null) return { ...EMPTY, curves: [full], points: [tool.center.pos] };
      return {
        ...EMPTY,
        curves: [ellipseOutline(tool.center.pos, tool.major.pos, tool.minor, [tool.start, angle])],
        points: [tool.center.pos],
      };
    }
    case 'mirror': {
      if (tool.step === 'geometry') {
        return { ...EMPTY, highlight: [...tool.ids, ...(hit ? [hit.id] : [])] };
      }
      const axis = hit?.kind === 'curve' ? entityMap(sketch).get(hit.id) : undefined;
      const edit = axis?.kind === 'line' ? mirrorGeometry(sketch, tool.ids, axis.id) : null;
      return {
        ...EMPTY,
        curves: addedCurves(sketch, edit),
        highlight: [...tool.ids, ...(axis?.kind === 'line' ? [axis.id] : [])],
      };
    }
    case 'pattern': {
      if (tool.step === 'geometry') {
        return { ...EMPTY, highlight: [...tool.ids, ...(hit ? [hit.id] : [])] };
      }
      if (tool.mode === 'linear') {
        const placement = linearPlacement(sketch, tool, c);
        const edit = placement
          ? linearPattern(sketch, tool.ids, tool.count, placement.direction, placement.spacing)
          : null;
        return {
          ...EMPTY,
          curves: addedCurves(sketch, edit),
          highlight: tool.ids,
          chips: [
            { field: 'count', value: tool.count, at: c },
            { field: 'spacing', value: placement?.spacing ?? 0, at: [c[0], c[1]] },
          ],
        };
      }
      const edit = circularPattern(sketch, tool.ids, tool.count, cursor, tool.angle);
      return {
        ...EMPTY,
        curves: addedCurves(sketch, edit),
        points: [c],
        highlight: tool.ids,
        chips: [
          { field: 'count', value: tool.count, at: c },
          { field: 'angle', value: tool.angle, at: c },
        ],
      };
    }
    case 'corner': {
      if (!tool.pointId) {
        return { ...EMPTY, highlight: hit?.kind === 'point' ? [hit.id] : [] };
      }
      const size = cornerCursorSize(sketch, tool.pointId, c);
      const edit = roundCorner(sketch, tool.pointId, size, tool.mode);
      return {
        ...EMPTY,
        curves: 'reason' in edit ? [] : addedCurves(sketch, edit),
        highlight: [tool.pointId],
        chips: [{ field: 'size', value: size, at: c }],
      };
    }
    case 'project':
    case 'text':
      return EMPTY;
  }
}
