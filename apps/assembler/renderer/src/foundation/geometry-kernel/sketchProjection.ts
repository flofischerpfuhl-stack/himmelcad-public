/**
 * Kernel side of sketch projections (`sketch/projection.ts`): samples the
 * exact source edges of a resolved edge/face reference so the evaluator can
 * re-derive projected sketch geometry on every evaluation (associative
 * projection through naming v2 references).
 */
import type * as R from 'replicad';

import type { CurveKind, Vec3 } from '../document/document.js';
import type { EdgeSample } from '../sketch-solver/projection.js';
import { edgePointAt } from './occt.js';

type OpenCascade = ReturnType<typeof R.getOC>;

/** Samples per curved edge (lines need their two ends only). */
const CURVE_SAMPLES = 64;

export function sampleEdge(oc: OpenCascade, edge: R.Edge, curve: CurveKind): EdgeSample {
  const n = curve === 'line' ? 1 : CURVE_SAMPLES;
  const points: Vec3[] = [];
  for (let i = 0; i <= n; i += 1) points.push(edgePointAt(oc, edge, i / n));
  return { curve, points };
}
