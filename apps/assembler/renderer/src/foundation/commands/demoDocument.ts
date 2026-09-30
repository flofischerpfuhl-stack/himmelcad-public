/**
 * The document the application store starts with (and the reference part of
 * many kernel and store tests). Lives beside the store, above the sketch
 * solver whose builders it uses: the document module itself knows no kind
 * but its core kinds.
 */
import {
  bodyIdFor,
  type ExtrudeFeature,
  type Feature,
  type FilletFeature,
} from '../document/document.js';
import { addCircle, addRectangle } from '../sketch-solver/builders.js';
import type { SketchFeature } from '../sketch-solver/sketchFeature.js';
import { EMPTY_SKETCH, type SketchData } from '../sketch-solver/types.js';

/** A fully dimensioned rectangle sketch (corner position from the origin + size). */
function rectangleSketch(x: number, y: number, width: number, height: number): SketchData {
  return addRectangle(EMPTY_SKETCH, [x, y], [x + width, y + height], { position: true, size: true })
    .sketch;
}

/**
 * Printable demo bracket, as real B-rep: an 80 x 50 x 6 mm base plate, an
 * 80 x 8 x 40 mm upright joined onto its back edge (y = 42..50), a 4 mm fillet on the
 * inner edge between plate top and upright front, and a 6 mm through-hole
 * sketched on the plate's top face and cut through the plate.
 *
 * Hand calculation (used by the kernel tests): volume
 * `80*50*6 + 80*8*40 + (4^2 - pi*4^2/4)*80 - pi*3^2*6 = 49 705.04 mm^3`,
 * bounding box `[0, 0, 0]..[80, 50, 46]`.
 *
 * The references below carry naming keys the kernel derives on its own
 * (`geometry-kernel/naming.ts`); their signatures are hand-computed and only
 * serve as a fallback.
 */
export function createDemoDocument(): Feature[] {
  const plateBody = bodyIdFor('feature-extrude-1');
  const sketch1: SketchFeature = {
    id: 'feature-sketch-1',
    name: 'Sketch 1',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    ...rectangleSketch(0, 0, 80, 50),
  };
  const extrude1: ExtrudeFeature = {
    id: 'feature-extrude-1',
    name: 'Extrude 1',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketch1.id },
    distance: 6,
    symmetric: false,
    operation: 'new',
    resultBodyName: 'Bracket',
  };
  const sketch2: SketchFeature = {
    id: 'feature-sketch-2',
    name: 'Sketch 2',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: 6 },
    ...rectangleSketch(0, 42, 80, 8),
  };
  const extrude2: ExtrudeFeature = {
    id: 'feature-extrude-2',
    name: 'Extrude 2',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketch2.id },
    distance: 40,
    symmetric: false,
    operation: 'join',
    targetBodyId: plateBody,
  };
  const fillet1: FilletFeature = {
    id: 'feature-fillet-3',
    name: 'Fillet 1',
    suppressed: false,
    kind: 'fillet',
    radius: 4,
    edges: [
      {
        bodyId: plateBody,
        // Plate top face | upright front face (rectangle segment 0 = -v side, y = 42).
        key: 'feature-extrude-1:end:0|feature-extrude-2:side:0:l1',
        signature: { curve: 'line', midpoint: [40, 42, 6], length: 80, direction: [1, 0, 0] },
      },
    ],
  };
  const sketch3: SketchFeature = {
    id: 'feature-sketch-4',
    name: 'Sketch 3',
    suppressed: false,
    kind: 'sketch',
    plane: {
      kind: 'face',
      face: {
        bodyId: plateBody,
        key: 'feature-extrude-1:end:0',
        signature: {
          surface: 'plane',
          normal: [0, 0, 1],
          centroid: [40, 20, 6],
          area: 3360,
          adjacentFaces: 5,
        },
      },
    },
    ...addCircle(EMPTY_SKETCH, [40, 20], 3, { position: true, size: true }).sketch,
  };
  const extrude3: ExtrudeFeature = {
    id: 'feature-extrude-5',
    name: 'Extrude 3',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketch3.id },
    distance: -8,
    symmetric: false,
    operation: 'cut',
    targetBodyId: plateBody,
  };
  return [sketch1, extrude1, sketch2, extrude2, fillet1, sketch3, extrude3];
}
