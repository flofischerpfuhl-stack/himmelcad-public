/**
 * Datum resolution (assembler/MODULES.md §3): what a `{kind: 'construction'}`
 * plane or axis reference (`PlaneRef`, `AxisRef` in `document.ts`) stands
 * for. Any module may read construction planes and axes through these
 * functions — as a mirror/split/neutral plane, a revolve/pattern/rotate
 * axis — without importing the construction module that creates them.
 *
 * The evaluation is read structurally (`DatumSource`, `PlaneSource`), so the
 * document layer stays below the geometry kernel; an `EvaluationResult`
 * satisfies both. Pure data, no store, no kernel.
 */
import {
  frameForFace,
  frameForPlane,
  type AxisRef,
  type PlaneRef,
  type SketchFrame,
  type Vec3,
} from './document.js';

/** An evaluated construction plane or axis (`EvaluatedDatum` of the kernel). */
export interface DatumLike {
  featureId: string;
  kind: 'plane' | 'axis';
  frame: SketchFrame;
  center: Vec3;
  size: number;
}

/** What datum resolution reads from an evaluation. */
export interface DatumSource {
  datums?: readonly DatumLike[];
}

/** An evaluation with bodies, for plane references on body faces. */
export interface PlaneSource extends DatumSource {
  bodies: readonly {
    id: string;
    faces: readonly {
      key: string;
      aliases: readonly string[];
      normal: Vec3 | null;
      centroid: Vec3;
    }[];
  }[];
}

/**
 * The frame a plane reference stands for, from the evaluation when it has
 * the geometry (a construction plane's datum, a face of an evaluated body),
 * else from the reference's own signature. `null` for a non-planar face.
 */
export function planeRefFrame(ref: PlaneRef, evaluation?: PlaneSource): SketchFrame | null {
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
  evaluation?: PlaneSource,
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
  evaluation?: DatumSource,
): { point: Vec3; dir: Vec3 } {
  const datum = evaluation?.datums?.find((d) => d.featureId === ref.featureId);
  return datum?.kind === 'axis' ? { point: datum.frame.origin, dir: datum.frame.normal } : ref.line;
}

/** A reference to the evaluated datum `featureId` (plane or axis), or `null` if not evaluated. */
export function datumRef(evaluation: DatumSource, featureId: string): PlaneRef | AxisRef | null {
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

/** Feature ids of the construction planes/axes a value (a tool draft, a feature) references. */
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
