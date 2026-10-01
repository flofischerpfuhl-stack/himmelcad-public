/**
 * Datum resolution (assembler/MODULES.md §3 "Datums"): what a plane or axis
 * reference of the document (`PlaneRef`, `AxisRef` in `document.ts`) stands
 * for in an evaluation. Construction planes and axes are evaluated into
 * datums (`EvaluatedDatum`) by the construction module's evaluators; every
 * module that takes a plane or an axis — sketch planes, mirror/split planes,
 * revolve/pattern axes, draft neutral planes — resolves the reference here,
 * so no domain module needs the construction module to read one.
 *
 * Pure functions over an evaluation result; no OCCT.
 */
import {
  frameForFace,
  frameForPlane,
  type AxisRef,
  type PlaneRef,
  type SketchFrame,
  type Vec3,
} from '../document/document.js';
import type { EvaluationResult } from './types.js';

/**
 * The frame a plane reference stands for, from the evaluation when it has
 * the geometry (a construction plane's datum, a face of an evaluated body),
 * else from the reference's own signature. `null` for a non-planar face.
 */
export function planeRefFrame(
  ref: PlaneRef,
  evaluation?: Pick<EvaluationResult, 'bodies' | 'datums'>,
): SketchFrame | null {
  if (ref.kind === 'plane') return frameForPlane(ref.plane, ref.offset);
  if (ref.kind === 'construction') {
    const datum = evaluation?.datums?.find((d) => d.featureId === ref.featureId);
    return datum?.kind === 'plane' ? datum.frame : ref.frame;
  }
  const face = evaluation?.bodies
    .find((b) => b.id === ref.face.bodyId)
    ?.faces.find((f) => f.key === ref.face.key || f.aliases.includes(ref.face.key));
  const normal = face?.normal ?? ref.face.signature.normal;
  if (!normal) return null;
  return frameForFace(normal, face?.centroid ?? ref.face.signature.centroid);
}

/** A point and normal of a plane reference (`planeRefFrame`), with the datum's drawn centre. */
export function planeRefPlane(
  ref: PlaneRef,
  evaluation?: Pick<EvaluationResult, 'bodies' | 'datums'>,
): { point: Vec3; normal: Vec3 } | null {
  if (ref.kind === 'construction') {
    const datum = evaluation?.datums?.find((d) => d.featureId === ref.featureId);
    if (datum?.kind === 'plane') return { point: datum.center, normal: datum.frame.normal };
    return { point: ref.frame.origin, normal: ref.frame.normal };
  }
  if (ref.kind === 'face') {
    const face = evaluation?.bodies
      .find((b) => b.id === ref.face.bodyId)
      ?.faces.find((f) => f.key === ref.face.key || f.aliases.includes(ref.face.key));
    const normal = face?.normal ?? ref.face.signature.normal;
    if (!normal) return null;
    return { point: face?.centroid ?? ref.face.signature.centroid, normal };
  }
  const frame = frameForPlane(ref.plane, ref.offset);
  return { point: frame.origin, normal: frame.normal };
}

/** A construction axis reference's line: the evaluated datum, else its signature. */
export function constructionAxisLine(
  ref: Extract<AxisRef, { kind: 'construction' }>,
  evaluation?: Pick<EvaluationResult, 'datums'>,
): { point: Vec3; dir: Vec3 } {
  const datum = evaluation?.datums?.find((d) => d.featureId === ref.featureId);
  return datum?.kind === 'axis' ? { point: datum.frame.origin, dir: datum.frame.normal } : ref.line;
}

/** A reference to the evaluated datum `featureId` (plane or axis), or `null` if not evaluated. */
export function datumRef(
  evaluation: Pick<EvaluationResult, 'datums'>,
  featureId: string,
): PlaneRef | AxisRef | null {
  const datum = evaluation.datums?.find((d) => d.featureId === featureId);
  if (!datum) return null;
  return datum.kind === 'plane'
    ? {
        kind: 'construction',
        featureId,
        frame: datum.frame,
        shown: { center: datum.center, size: datum.size },
      }
    : {
        kind: 'construction',
        featureId,
        line: { point: datum.frame.origin, dir: datum.frame.normal },
      };
}

/** Feature ids of construction planes/axes a value (a tool draft, a feature) references. */
export function referencedDatumIds(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const r = v as Record<string, unknown>;
      if (r.kind === 'construction' && typeof r.featureId === 'string') out.push(r.featureId);
      for (const child of Object.values(r)) visit(child);
    }
  };
  visit(value);
  return out;
}
