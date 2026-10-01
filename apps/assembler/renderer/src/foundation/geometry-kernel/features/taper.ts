/**
 * Tapered prisms for Extrude's taper (draft) angle (Shapr3D "Draft angle"
 * of Extrude): the straight prism of a planar profile face, its side faces
 * tilted about the start plane with OCCT's draft (`BRepOffsetAPI_DraftAngle`,
 * the Draft tool's algorithm), so a positive angle narrows the solid away
 * from the start plane (outer walls lean in, hole walls lean out). A span
 * that crosses the start plane (symmetric, two sides) is built as two
 * prisms, each narrowing away from the start, fused.
 *
 * Draft tilts planar, cylindrical and conical sides; a spline side or an
 * angle that makes walls meet before the end fails with a readable
 * message. Faces keep the keys the straight prism was named with (through
 * the draft's history), so references survive a taper change.
 */
import '../occtArena.js';
import * as R from 'replicad';

import type { Vec3 } from '../../document/document.js';
import type { KeyedFace } from '../naming.js';
import type { RawShape } from '../occt.js';
import type { ExtrudeSpan } from './extrudeExtent.js';
import type { FeatureKit, Shape3D } from './kit.js';
import { add, dot, scale } from './rigid.js';

export interface TaperTool {
  shape: Shape3D;
  faces: KeyedFace[];
}

/**
 * The tapered prism of `face` (lying in the profile plane, offset 0) over
 * `span` along `n`, drafted about the plane at `pivot`. `name` names a
 * straight piece's faces (caps and sides, as the untapered extrude does);
 * `piece` is `back` for the part on the other side of the pivot, whose side
 * keys get a `:back` suffix so the two halves stay distinguishable.
 */
export function taperedPrism(
  kit: FeatureKit,
  featureOrder: ReadonlyMap<string, number>,
  featureId: string,
  face: R.Face,
  planePoint: Vec3,
  n: Vec3,
  span: ExtrudeSpan,
  pivot: number,
  angleDegrees: number,
  name: (shape: Shape3D, piece: 'main' | 'back') => KeyedFace[],
): TaperTool {
  const eps = 1e-9;
  const pieces: { from: number; to: number; piece: 'main' | 'back' }[] = [];
  if (span.from < pivot - eps && span.to > pivot + eps) {
    pieces.push({ from: pivot, to: span.to, piece: 'main' });
    pieces.push({ from: pivot, to: span.from, piece: 'back' });
  } else if (span.from >= pivot - eps) {
    pieces.push({ from: span.from, to: span.to, piece: 'main' });
  } else {
    pieces.push({ from: span.to, to: span.from, piece: 'main' });
  }
  const tools = pieces.map((p) => {
    // From the neutral end (`from`) towards the far end (`to`).
    const start = p.from === 0 ? face.clone() : face.clone().translate(scale(n, p.from));
    const vector = new R.Vector(scale(n, p.to - p.from));
    const prism = R.basicFaceExtrusion(start, vector) as Shape3D;
    vector.delete();
    const faces = name(prism, p.piece);
    const pull = scale(n, Math.sign(p.to - p.from));
    const pointOnNeutral = add(planePoint, scale(n, p.from));
    return draftSides(
      kit,
      featureOrder,
      featureId,
      prism,
      faces,
      n,
      pull,
      pointOnNeutral,
      angleDegrees,
    );
  });
  const holder = { id: '', name: '', color: '', createdBy: '', ...tools[0]! };
  for (const next of tools.slice(1)) kit.combine(holder, next, 'join', featureId, featureOrder);
  return { shape: holder.shape, faces: holder.faces };
}

/**
 * Drafts every side face of `prism` (the faces not parallel to the caps)
 * about the plane through `neutralPoint` with normal `n`, pulling along
 * `pull` (from the neutral plane into the prism).
 */
function draftSides(
  kit: FeatureKit,
  featureOrder: ReadonlyMap<string, number>,
  featureId: string,
  prism: Shape3D,
  faces: KeyedFace[],
  n: Vec3,
  pull: Vec3,
  neutralPoint: Vec3,
  angleDegrees: number,
): TaperTool {
  const sides = faces
    .map((f, index) => ({ f, index }))
    .filter(({ f }) => !(f.normal && Math.abs(dot(f.normal, n)) > 1 - 1e-9));
  for (const { f } of sides) {
    if (f.surface !== 'plane' && f.surface !== 'cylinder' && f.surface !== 'cone') {
      kit.fail(
        'Taper works on profiles of lines, arcs and circles (a spline side cannot be tilted)',
      );
    }
  }
  return draftFaces(
    kit,
    featureOrder,
    featureId,
    { shape: prism, faces },
    sides.map(({ index }) => ({
      index,
      pull,
      neutralPoint,
      angle: (angleDegrees * Math.PI) / 180,
    })),
    {
      add: 'Taper failed: a side wall cannot be tilted by this angle',
      build: 'Taper failed: the tilted walls do not meet; try a smaller angle or distance',
      empty: 'Taper failed: the walls meet before the end; use a smaller angle or distance',
      prefix: 'Taper failed',
    },
  );
}

/** One face to tilt with OCCT's draft: about its line on the neutral plane (normal `pull`). */
export interface DraftItem {
  /** Face index in the shape's topology (and keyed face list). */
  index: number;
  /** Pull direction (unit): from the neutral plane into the material side being tilted. */
  pull: Vec3;
  neutralPoint: Vec3;
  /** Radians; positive removes material on the pull side. */
  angle: number;
}

/**
 * Tilts faces of `source` with one `BRepOffsetAPI_DraftAngle` (each about
 * the line where it meets its neutral plane; neighbours are recomputed to
 * meet the tilted faces) and names the result from the draft's history: a
 * tilted face keeps its key. `messages` word the failures.
 */
export function draftFaces(
  kit: FeatureKit,
  featureOrder: ReadonlyMap<string, number>,
  featureId: string,
  source: TaperTool,
  items: readonly DraftItem[],
  messages: { add: string; build: string; empty: string; prefix: string },
): TaperTool {
  const oc = kit.oc;
  const topology = kit.topologyOf(source.shape);
  const builder = new oc.BRepOffsetAPI_DraftAngle(source.shape.wrapped as never);
  const owned: { delete(): void }[] = [];
  let shape: Shape3D;
  try {
    for (const item of items) {
      const dir = new oc.gp_Dir(item.pull[0], item.pull[1], item.pull[2]);
      const origin = new oc.gp_Pnt(
        item.neutralPoint[0],
        item.neutralPoint[1],
        item.neutralPoint[2],
      );
      const pln = new oc.gp_Pln(origin, dir);
      owned.push(pln, origin, dir);
      builder.Add(topology.faces[item.index]!.wrapped as never, dir, item.angle, pln, true);
      if (!builder.AddDone()) kit.fail(messages.add);
    }
    builder.Build();
    if (!builder.IsDone()) kit.fail(messages.build);
    const raw = builder.Shape();
    shape = R.cast(raw) as Shape3D;
    raw.delete();
  } catch (error) {
    builder.delete();
    if (kit.isFailure(error)) throw error;
    kit.fail(`${messages.prefix}: ${kit.describeError(error)}`);
  } finally {
    for (const o of owned) o.delete();
  }
  try {
    if (!(R.measureVolume(shape) > 0)) kit.fail(messages.empty);
    const named = kit.nameResult(
      shape,
      builder as never,
      [{ shape: source.shape, faces: source.faces }],
      featureOrder,
      () => `${featureId}:new`,
    );
    // `Modified` does not report the tilted faces themselves; `ModifiedShape` does.
    const result = kit.topologyOf(shape);
    for (const item of items) {
      const f = source.faces[item.index]!;
      let raw: RawShape | null = null;
      try {
        raw = builder.ModifiedShape(topology.faces[item.index]!.wrapped as never) as RawShape;
        const at = result.faceIndexOf(raw);
        const face = at >= 0 ? named[at] : undefined;
        if (face && face.key !== f.key) named[at] = { ...face, key: f.key, aliases: f.aliases };
      } catch {
        // Unreported: the face keeps its history/surface-identity name.
      } finally {
        raw?.delete();
      }
    }
    return { shape, faces: named };
  } finally {
    builder.delete();
  }
}
