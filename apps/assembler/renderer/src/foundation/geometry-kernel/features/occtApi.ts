/**
 * The OCCT (replicad) surface a module's feature evaluators may use
 * (assembler/MODULES.md §3 `kernel.ts`). Only the geometry kernel imports
 * `replicad` (`apps/assembler/modules.json` `externalOnly`); an evaluator in
 * a domain module builds shapes through {@link FeatureKit} and these
 * re-exports:
 *
 * ```ts
 * import * as R from '../../../foundation/geometry-kernel/features/occtApi.js';
 * ```
 *
 * The list is deliberately explicit: a new replicad call a module needs is
 * added here, so the kernel's OCCT surface stays visible in one place. The
 * memory rules of `kit.ts` apply (every OCCT object a feature creates is
 * released with the feature unless it became a body's shape).
 */
import '../occtArena.js';

export {
  assembleWire,
  basicFaceExtrusion,
  cast,
  Compound,
  CompoundSketch,
  draw,
  drawCircle,
  Drawing,
  Edge,
  Face,
  makeBox,
  makeCircle,
  makeCompound,
  makeCylinder,
  makeFace,
  makeHelix,
  makeLine,
  makeOffset,
  makePolygon,
  makeSphere,
  makeThreePointArc,
  makeVertex,
  measureVolume,
  revolution,
  Sketch,
  Solid,
  Vector,
  Wire,
} from 'replicad';
export type { AnyShape, Shape3D } from 'replicad';
