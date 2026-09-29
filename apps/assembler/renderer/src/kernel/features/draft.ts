/**
 * Draft: tilts planar, cylindrical or conical faces about their
 * intersection with a neutral plane (`BRepOffsetAPI_DraftAngle`, bound in
 * this opencascade.js build). The pull direction points from the neutral
 * plane into the material: the inward normal of a neutral body face, the
 * normal of a construction plane; `flip` reverses it. A positive angle
 * removes material on the pull side (the part narrows along the pull
 * direction), a negative angle adds it.
 *
 * Faces keep their keys through the builder's `Modified` history; faces
 * OCCT has to rebuild around them (rare) are named `<id>:new`.
 */
import '../occtArena.js';
import * as R from 'replicad';

import type { DraftFeature } from '../../model/printFeatures.js';
import { MAX_DRAFT_ANGLE } from '../../model/printFeatures.js';
import type { RawShape } from '../occt.js';
import type { FeatureKit, ReplayContextLike, Shape3D } from './kit.js';
import { bodyOrFail, resolvePlane } from './refs.js';
import { dot, scale } from './rigid.js';

export function applyDraft(feature: DraftFeature, ctx: ReplayContextLike, kit: FeatureKit): void {
  const angle = feature.angle;
  if (!(Number.isFinite(angle) && Math.abs(angle) >= 0.05 && Math.abs(angle) <= MAX_DRAFT_ANGLE)) {
    kit.fail(`Draft angle must be between 0.05° and ${MAX_DRAFT_ANGLE}° (negative adds material)`);
  }
  if (feature.faces.length === 0) kit.fail('Select at least one face to draft');
  const bodyId = feature.faces[0]!.bodyId;
  if (feature.faces.some((f) => f.bodyId !== bodyId)) kit.fail('All faces must belong to one body');
  const body = bodyOrFail(kit, ctx, bodyId);
  const plane = resolvePlane(kit, ctx, feature.neutral);
  // From the neutral plane into the material.
  let pull = plane.normal;
  if (feature.neutral.kind === 'face') pull = scale(pull, -1);
  if (feature.flip) pull = scale(pull, -1);

  const resolved = feature.faces.map((ref) => kit.resolveFace(body, ref, ctx.warn));
  const indices = new Set(resolved.map((r) => r.index));
  if (indices.size !== resolved.length) kit.fail('A face is listed twice');
  for (const r of resolved) {
    if (r.geom.surface !== 'plane' && r.geom.surface !== 'cylinder' && r.geom.surface !== 'cone') {
      kit.fail('Draft works on planar, cylindrical and conical faces', {
        bodyId: body.id,
        faceKeys: [r.geom.key],
      });
    }
    if (r.geom.normal && Math.abs(dot(r.geom.normal, pull)) > 1 - 1e-6) {
      kit.fail(
        'A face parallel to the neutral plane cannot be drafted; pick the side faces',
        { bodyId: body.id, faceKeys: [r.geom.key] },
      );
    }
  }

  const oc = kit.oc;
  const builder = new oc.BRepOffsetAPI_DraftAngle(body.shape.wrapped as never);
  const dir = new oc.gp_Dir(pull[0], pull[1], pull[2]);
  const origin = new oc.gp_Pnt(plane.point[0], plane.point[1], plane.point[2]);
  const pln = new oc.gp_Pln(origin, dir);
  let shape: Shape3D;
  try {
    for (const r of resolved) {
      builder.Add(r.face.wrapped as never, dir, (angle * Math.PI) / 180, pln, true);
      if (!builder.AddDone()) {
        kit.fail(
          `Draft failed on the highlighted face: OCCT cannot tilt it about the neutral plane (does the plane cross the face's neighbours?)`,
          { bodyId: body.id, faceKeys: [r.geom.key] },
        );
      }
    }
    builder.Build();
    if (!builder.IsDone()) {
      kit.fail('Draft failed: the tilted faces do not meet their neighbours; try a smaller angle', {
        bodyId: body.id,
        faceKeys: resolved.map((r) => r.geom.key),
      });
    }
    const raw = builder.Shape();
    shape = R.cast(raw) as Shape3D;
    raw.delete();
  } catch (error) {
    builder.delete();
    if (kit.isFailure(error)) throw error;
    kit.fail(`Draft failed: ${kit.describeError(error)}`, {
      bodyId: body.id,
      faceKeys: resolved.map((r) => r.geom.key),
    });
  } finally {
    pln.delete();
    origin.delete();
    dir.delete();
  }
  try {
    if (!(R.measureVolume(shape) > 0)) kit.fail('Draft failed: the result is not a closed solid');
    const faces = kit.nameResult(
      shape,
      builder as never,
      [{ shape: body.shape, faces: body.faces }],
      ctx.featureOrder,
      () => `${feature.id}:new`,
    );
    // `Modified` does not report the tilted faces themselves; `ModifiedShape` does.
    const topology = kit.topologyOf(shape);
    for (const r of resolved) {
      let raw: RawShape | null = null;
      try {
        raw = builder.ModifiedShape(r.face.wrapped as never) as RawShape;
        const index = topology.faceIndexOf(raw);
        const face = index >= 0 ? faces[index] : undefined;
        if (face && face.key !== r.geom.key) {
          faces[index] = { ...face, key: r.geom.key, aliases: r.geom.aliases };
        }
      } catch {
        // Unreported: the face keeps its history/surface-identity name.
      } finally {
        raw?.delete();
      }
    }
    body.faces = faces;
    body.shape = shape;
  } finally {
    builder.delete();
  }
  ctx.touch(body.id);
}
