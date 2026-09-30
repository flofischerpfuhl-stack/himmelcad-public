/**
 * Face-level building blocks of the kernel: faces of one body, the slab
 * between a face and its offset, finding a face on its offset surface, and
 * adopting an exact OCCT face operation's result with history naming.
 *
 * Shell uses {@link offsetBodyFaces} for walls thicker than the shell
 * thickness; the direct-edit module's Offset Face and Delete Face
 * (`modules/direct-edit/faceEdits.ts`) are built on the rest.
 */
import '../occtArena.js';
import * as R from 'replicad';

import type { FaceRef } from '../../document/document.js';
import { assignFaceKeys, baseFaceKey, type FaceGeom, type KeyedFace } from '../naming.js';
import type { HistoryResult } from '../occt.js';
import type { BodyStateLike, FeatureKit, ReplayContextLike, ResolvedFace, Shape3D } from './kit.js';
import { bodyOrFail } from './refs.js';
import { dot, length, scale, sub } from './rigid.js';

/** A tool solid with named faces, ready for `kit.combine`. */
export interface FaceTool {
  shape: Shape3D;
  faces: KeyedFace[];
}

/** Resolves face references that must all lie on one body (each at most once). */
export function facesOfOneBody(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  refs: readonly FaceRef[],
): { body: BodyStateLike; resolved: ResolvedFace[] } {
  if (refs.length === 0) kit.fail('Select at least one face');
  const bodyId = refs[0]!.bodyId;
  if (refs.some((r) => r.bodyId !== bodyId)) kit.fail('All faces must belong to one body');
  const body = bodyOrFail(kit, ctx, bodyId);
  const resolved = refs.map((ref) => kit.resolveFace(body, ref, ctx.warn));
  const indices = new Set(resolved.map((r) => r.index));
  if (indices.size !== resolved.length) kit.fail('A face is listed twice');
  return { body, resolved };
}
/**
 * Replaces `body`'s shape by an exact face operation's result, naming its
 * faces from OCCT's history: moved/extended faces keep their keys, faces
 * nothing explains are `known(index)` or `<feature>:new`.
 */
export function applyExact(
  kit: FeatureKit,
  body: BodyStateLike,
  built: HistoryResult,
  featureId: string,
  ctx: ReplayContextLike,
  known: (index: number) => string | undefined = () => undefined,
): void {
  try {
    body.faces = kit.nameResult(
      built.shape,
      built.history,
      [{ shape: body.shape, faces: body.faces }],
      ctx.featureOrder,
      (index) => known(index) ?? `${featureId}:new`,
    );
    body.shape = built.shape;
  } finally {
    built.history.delete();
  }
  ctx.touch(body.id);
}

/**
 * Offsets faces of `body` (by naming key) by their own distances, one after
 * the other (the offset surface keeps its key, so later keys still
 * resolve). Used by Shell for walls thicker than the shell thickness.
 */
export function offsetBodyFaces(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  body: BodyStateLike,
  faces: readonly { key: string; distance: number }[],
  featureId: string,
): void {
  faces.forEach((entry, i) => {
    const topology = kit.topologyOf(body.shape);
    const index = body.faces.findIndex((f) => f.key === entry.key);
    if (index < 0) kit.fail(`Missing reference: face "${entry.key}" on "${body.name}"`);
    const resolved: ResolvedFace = {
      face: topology.faces[index]!,
      geom: body.faces[index]!,
      topology,
      index,
    };
    const tool = offsetSlab(kit, featureId, i, resolved, entry.distance);
    kit.combine(body, tool, entry.distance > 0 ? 'join' : 'cut', featureId, ctx.featureOrder);
  });
}

/**
 * The material between face `r` and its offset by `d` (along the outward
 * normal), as a positive-volume solid. The offset surface's face inherits
 * the offset face's key; the slab's side walls are `:side:<i>:<n>`.
 */
export function offsetSlab(
  kit: FeatureKit,
  featureId: string,
  i: number,
  r: ResolvedFace,
  d: number,
): FaceTool {
  const oc = kit.oc;
  let shape: Shape3D;
  try {
    // MakeThickSolidBySimple offsets along the face normal; a positive value
    // yields an inside-out solid, so thicken the offset face back instead.
    let base = r.face.wrapped;
    let value = d;
    let offsetShape: R.AnyShape | null = null;
    if (d > 0) {
      offsetShape = R.makeOffset(r.face, d);
      const offsetFace = kit.facesOf(offsetShape as Shape3D)[0];
      if (!offsetFace) kit.fail('Offset Face failed: the offset surface is empty');
      base = offsetFace.wrapped;
      value = -d;
    }
    const maker = new oc.BRepOffsetAPI_MakeThickSolid();
    try {
      maker.MakeThickSolidBySimple(base, value);
      const raw = maker.Shape();
      shape = R.cast(raw) as Shape3D;
      raw.delete();
    } finally {
      maker.delete();
    }
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`Offset Face failed: ${kit.describeError(error)}`);
  }
  if (!(R.measureVolume(shape) > 0))
    kit.fail('Offset Face failed: the offset face turns inside out');
  const geoms = kit.describeShape(shape);
  const offsetIndex = offsetFaceIndex(r.geom, geoms, Math.abs(d));
  let side = 0;
  const keys = assignFaceKeys(geoms, [], new Map(), (index) => {
    if (index === offsetIndex) return baseFaceKey(r.geom.key);
    side += 1;
    return `${featureId}:side:${i}:${side - 1}`;
  });
  return { shape, faces: kit.withKeys(geoms, keys) };
}

/** Index of the slab face that lies on the offset surface of `source`. */
export function offsetFaceIndex(source: FaceGeom, geoms: FaceGeom[], d: number): number {
  const tol = 1e-4;
  const scored = geoms.map((g, index) => {
    const id = g.id;
    const s = source.id;
    let score = Infinity;
    if (s.type === 'plane' && id.type === 'plane') {
      if (Math.abs(Math.abs(dot(s.normal, id.normal)) - 1) < 1e-7) {
        const shift = Math.abs(dot(s.normal, scale(id.normal, id.offset)) - s.offset);
        score = Math.abs(shift - d);
      }
    } else if (s.type === 'cylinder' && id.type === 'cylinder') {
      if (Math.abs(Math.abs(dot(s.axis, id.axis)) - 1) < 1e-7) {
        score = Math.abs(Math.abs(id.radius - s.radius) - d);
      }
    } else if (s.type === 'other' && id.type === 'other' && id.kind === s.kind) {
      score = Math.abs(length(sub(id.centroid, s.centroid)) - d);
    }
    return { index, score };
  });
  const best = scored
    .filter((s) => s.score < Math.max(tol, d * 0.05))
    .sort((a, b) => a.score - b.score)[0];
  return best?.index ?? -1;
}
