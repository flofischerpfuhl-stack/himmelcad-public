/**
 * Minimal fuzzer reproducers (delta-debugged, `cli.ts`), replayed by
 * `regressions.test.ts`. Each broke an invariant before its fix; see the
 * findings table in `assembler/ROBUSTNESS.md`. Add new ones from the
 * reproducer JSON the fuzzer writes (`name`, `invariant`, `ops`).
 */
import type { Op } from './ops.js';

export interface RegressionCase {
  name: string;
  /** Finding id in `assembler/ROBUSTNESS.md`. */
  finding: string;
  /** The invariant it broke before the fix. */
  invariant: string;
  ops: Op[];
}

export const REPRODUCERS: RegressionCase[] = [
  {
    // Cylinder r 3; equal chamfer 4.8 on its circular edges: OCCT returned a self-intersecting solid.
    name: 'silentInvalid-s1-q10',
    finding: 'F1',
    invariant: 'silentInvalid',
    ops: [
      { op: 'sketch', r: [0.1596, 0.5708, 0.932, 0.3971, 0.2267, 0.1731, 0.5309, 0.0181] },
      { op: 'extrudeExpr', r: [0.5192, 0.0527, 0.2857, 0.8254, 0.7869, 0.3286, 0.8907, 0.0135] },
      { op: 'chamfer', r: [0.8723, 0.2481, 0.8578, 0.7973, 0.6338, 0.0638, 0.274, 0.0194] },
    ],
  },
  {
    // Joined L-shaped extrusions, a sketch line deleted, fillet r 3.2 on the top edges.
    name: 'silentInvalid-s1-q7',
    finding: 'F1',
    invariant: 'silentInvalid',
    ops: [
      { op: 'sketch', r: [0.3448, 0.1583, 0.0496, 0.4977, 0.9842, 0.2689, 0.2279, 0.5409] },
      { op: 'sketch', r: [0.7445, 0.1412, 0.3421, 0.333, 0.8943, 0.9034, 0.9277, 0.4081] },
      { op: 'reorder', r: [0.0573, 0.9713, 0.4957, 0.3616, 0.0815, 0.5075, 0.5198, 0.629] },
      { op: 'polyline', r: [0.0495, 0.9423, 0.6232, 0.8068, 0.8236, 0.471, 0.6041, 0.1819] },
      { op: 'sketch', r: [0.599, 0.5025, 0.4182, 0.5489, 0.0965, 0.5882, 0.835, 0.0879] },
      { op: 'extrude', r: [0.4218, 0.2766, 0.4111, 0.8692, 0.609, 0.3921, 0.0672, 0.9442] },
      { op: 'extrude', r: [0.0839, 0.7206, 0.5791, 0.5777, 0.9911, 0.5301, 0.1686, 0.646] },
      {
        op: 'deleteSketchItems',
        r: [0.1022, 0.16, 0.1538, 0.9451, 0.0635, 0.3577, 0.4992, 0.1611],
      },
      { op: 'fillet', r: [0.5509, 0.4649, 0.1427, 0.5129, 0.6688, 0.0672, 0.3971, 0.0261] },
    ],
  },
  {
    // A YZ rectangle at x = 9.5 revolved 340° about a Y axis through x = 23 (parallel to the
    // sketch plane, passing over the profile): the profile swept through itself.
    name: 'silentInvalid-s1-q14',
    finding: 'F2',
    invariant: 'silentInvalid',
    ops: [
      { op: 'sketch', r: [0.8914, 0.982, 0.1856, 0.4477, 0.3516, 0.124, 0.4353, 0.1315] },
      { op: 'revolve', r: [0.4108, 0.019, 0.7476, 0.4719, 0.2844, 0.8853, 0.9736, 0.4627] },
    ],
  },
];
