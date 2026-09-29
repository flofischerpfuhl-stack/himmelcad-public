/**
 * Which constraint a sketch selection can receive (Shapr3D shows only the
 * constraints valid for the current selection) and the constraints to add.
 * Pure; used by the sketch commands, the palette and tests.
 */
import { splineTangentPoint } from './splineTangent.js';
import {
  curveEnds,
  curvePointIds,
  entityMap,
  isCurve,
  isElliptic,
  isRound,
  type SketchConstraint,
  type SketchConstraintKind,
  type SketchCurve,
  type SketchData,
  type SketchEntity,
} from './types.js';

export type ConstraintPlan =
  | { ok: true; constraints: Omit<SketchConstraint, 'id'>[] }
  | { ok: false; reason: string };

export interface ConstraintInfo {
  kind: SketchConstraintKind;
  label: string;
  /** Command shortcut (Shift + letter). */
  shortcut: string;
  /** Short glyph drawn next to constrained geometry. */
  glyph: string;
}

export const CONSTRAINT_INFO: readonly ConstraintInfo[] = [
  { kind: 'coincident', label: 'Coincident', shortcut: 'Shift+C', glyph: '●' },
  { kind: 'horizontal', label: 'Horizontal', shortcut: 'Shift+H', glyph: 'H' },
  { kind: 'vertical', label: 'Vertical', shortcut: 'Shift+V', glyph: 'V' },
  { kind: 'parallel', label: 'Parallel', shortcut: 'Shift+P', glyph: '∥' },
  { kind: 'perpendicular', label: 'Perpendicular', shortcut: 'Shift+L', glyph: '⊥' },
  { kind: 'tangent', label: 'Tangent', shortcut: 'Shift+T', glyph: 'T' },
  { kind: 'equal', label: 'Equal', shortcut: 'Shift+E', glyph: '=' },
  { kind: 'fixed', label: 'Lock', shortcut: 'Shift+F', glyph: '⊠' },
  { kind: 'midpoint', label: 'Midpoint', shortcut: 'Shift+M', glyph: 'M' },
  { kind: 'symmetric', label: 'Symmetric', shortcut: 'Shift+S', glyph: '⋈' },
  { kind: 'concentric', label: 'Concentric', shortcut: 'Shift+O', glyph: '◎' },
  { kind: 'pointOnObject', label: 'Point on curve', shortcut: 'Shift+K', glyph: '⊙' },
];

/** Constraints created by tools only (sketch patterns), not offered in the palette. */
const TOOL_CONSTRAINT_INFO: readonly ConstraintInfo[] = [
  { kind: 'translate', label: 'Linear pattern', shortcut: '', glyph: '⋯' },
  { kind: 'rotate', label: 'Circular pattern', shortcut: '', glyph: '↻' },
];

export function constraintInfo(kind: SketchConstraintKind): ConstraintInfo {
  return (
    CONSTRAINT_INFO.find((c) => c.kind === kind) ??
    TOOL_CONSTRAINT_INFO.find((c) => c.kind === kind) ?? {
      kind,
      label: kind,
      shortcut: '',
      glyph: '?',
    }
  );
}

/** Plans the constraint(s) of `kind` for the selected ids (entities only; constraints/dimensions ignored). */
export function planConstraint(
  sketch: SketchData,
  kind: SketchConstraintKind,
  selection: readonly string[],
): ConstraintPlan {
  const map = entityMap(sketch);
  const all = selection.map((id) => map.get(id)).filter((e): e is SketchEntity => e !== undefined);
  // Text is positioned by its anchor point; only Lock applies to the text entity itself.
  if (kind !== 'fixed' && all.some((e) => e.kind === 'text')) {
    return { ok: false, reason: 'Constrain the text by its anchor point.' };
  }
  const selected = all;
  const points = selected.filter((e) => e.kind === 'point');
  const lines = selected.filter((e) => e.kind === 'line');
  const rounds = selected.filter((e) => isRound(e));
  const curves = selected.filter((e) => isCurve(e));
  const only = (n: number) => selected.length === n;
  const fail = (reason: string): ConstraintPlan => ({ ok: false, reason });
  const one = (refs: string[]): ConstraintPlan => ({ ok: true, constraints: [{ kind, refs }] });

  switch (kind) {
    case 'coincident':
      return only(2) && points.length === 2
        ? one(points.map((p) => p.id))
        : fail('Select two points.');
    case 'horizontal':
    case 'vertical':
      if (lines.length > 0 && lines.length === selected.length) {
        return { ok: true, constraints: lines.map((l) => ({ kind, refs: [l.id] })) };
      }
      if (only(2) && points.length === 2) return one(points.map((p) => p.id));
      return fail('Select lines or two points.');
    case 'parallel':
    case 'perpendicular':
      return only(2) && lines.length === 2
        ? one(lines.map((l) => l.id))
        : fail('Select two lines.');
    case 'tangent': {
      if (!only(2) || curves.length !== 2) {
        return fail(
          'Select a circle or arc and another curve, or a spline and a curve sharing its end.',
        );
      }
      const [a, b] = curves as [SketchCurve, SketchCurve];
      const basic = new Set(['line', 'circle', 'arc']);
      if (rounds.length >= 1 && basic.has(a.kind) && basic.has(b.kind)) return one([a.id, b.id]);
      if (
        (a.kind === 'ellipse' && b.kind === 'line') ||
        (a.kind === 'line' && b.kind === 'ellipse')
      ) {
        return one([a.id, b.id]);
      }
      const spline = a.kind === 'spline' ? a : b.kind === 'spline' ? b : null;
      if (spline) {
        const other = spline === a ? b : a;
        if (other.kind !== 'line' && other.kind !== 'arc' && other.kind !== 'spline') {
          return fail('A spline can be tangent to a line, arc or spline sharing its end point.');
        }
        const ends: string[] = curveEnds(spline) ?? [];
        const otherEnds: string[] = curveEnds(other) ?? [];
        const shared = ends.find((p) => otherEnds.includes(p));
        if (!shared)
          return fail(
            'The spline and the curve must share an end point (make them coincident first).',
          );
        if (!splineTangentPoint(spline, shared)) {
          return fail('This spline end has no tangent handle.');
        }
        if (other.kind === 'spline' && !splineTangentPoint(other, shared)) {
          return fail('This spline end has no tangent handle.');
        }
        return one([a.id, b.id]);
      }
      return fail(
        'Select a circle or arc and another curve, or a spline and a curve sharing its end.',
      );
    }
    case 'equal':
      if (only(2) && lines.length === 2) return one(lines.map((l) => l.id));
      if (only(2) && rounds.length === 2) return one(rounds.map((r) => r.id));
      return fail('Select two lines, or two circles/arcs.');
    case 'fixed': {
      if (selected.length === 0) return fail('Select geometry to lock.');
      // Lock each point once (shared vertices of several selected curves), circles with their radius.
      const locked = new Set<string>();
      for (const c of sketch.constraints) {
        if (c.kind !== 'fixed') continue;
        const e = map.get(c.refs[0]!);
        if (e?.kind === 'point') locked.add(e.id);
        else if (isCurve(e)) for (const id of curvePointIds(e)) locked.add(id);
      }
      const refs: string[] = [];
      for (const e of selected) {
        if (e.kind === 'circle') {
          if (!locked.has(e.center)) refs.push(e.id);
          locked.add(e.center);
          continue;
        }
        const ids = e.kind === 'point' ? [e.id] : isCurve(e) ? curvePointIds(e) : [];
        for (const id of ids) {
          if (locked.has(id)) continue;
          locked.add(id);
          refs.push(id);
        }
      }
      if (refs.length === 0) return fail('The selection is already locked.');
      return { ok: true, constraints: refs.map((id) => ({ kind, refs: [id] })) };
    }
    case 'midpoint':
      return only(2) && points.length === 1 && lines.length === 1
        ? one([points[0]!.id, lines[0]!.id])
        : fail('Select a point and a line.');
    case 'symmetric':
      if (only(3) && points.length === 2 && lines.length === 1) {
        return one([points[0]!.id, points[1]!.id, lines[0]!.id]);
      }
      if (only(3) && points.length === 3) return one(points.map((p) => p.id));
      return fail('Select two points and a line (or a centre point).');
    case 'concentric': {
      const centred = selected.filter((e) => isRound(e) || isElliptic(e));
      return only(2) && centred.length === 2
        ? one(centred.map((r) => r.id))
        : fail('Select two circles, arcs or ellipses.');
    }
    case 'pointOnObject': {
      const target = curves[0];
      if (!(only(2) && points.length === 1 && curves.length === 1)) {
        return fail('Select a point and a curve.');
      }
      if (target!.kind === 'spline' || target!.kind === 'text') {
        return fail('Points can be placed on lines, circles, arcs and ellipses.');
      }
      return one([points[0]!.id, target!.id]);
    }
    case 'translate':
    case 'rotate':
      return fail('Created by the sketch Pattern tool.');
  }
}
