/**
 * Which constraint a sketch selection can receive (Shapr3D shows only the
 * constraints valid for the current selection) and the constraints to add.
 * Pure; used by the sketch commands, the palette and tests.
 */
import {
  curvePointIds,
  entityMap,
  isCurve,
  isRound,
  type SketchConstraint,
  type SketchConstraintKind,
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

export function constraintInfo(kind: SketchConstraintKind): ConstraintInfo {
  return CONSTRAINT_INFO.find((c) => c.kind === kind)!;
}

/** Plans the constraint(s) of `kind` for the selected ids (entities only; constraints/dimensions ignored). */
export function planConstraint(
  sketch: SketchData,
  kind: SketchConstraintKind,
  selection: readonly string[],
): ConstraintPlan {
  const map = entityMap(sketch);
  const selected = selection
    .map((id) => map.get(id))
    .filter((e): e is SketchEntity => e !== undefined);
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
    case 'tangent':
      if (only(2) && curves.length === 2 && rounds.length >= 1) return one(curves.map((c) => c.id));
      return fail('Select a circle or arc and another curve.');
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
    case 'concentric':
      return only(2) && rounds.length === 2
        ? one(rounds.map((r) => r.id))
        : fail('Select two circles or arcs.');
    case 'pointOnObject':
      return only(2) && points.length === 1 && curves.length === 1
        ? one([points[0]!.id, curves[0]!.id])
        : fail('Select a point and a curve.');
  }
}
