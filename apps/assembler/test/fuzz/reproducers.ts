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
  {
    // Plate with a through hole, then a cylinder cut from a side face: the edited body's
    // incremental validity (closure test: an edge shared by three faces) said invalid, the
    // full BRepCheck after a reopen said valid.
    name: 'determinism-s1-q281',
    finding: 'F4',
    invariant: 'determinism',
    ops: [
      { op: 'sketch', r: [0.6422, 0.8789, 0.5439, 0.1533, 0.6176, 0.8826, 0.6611, 0.4708] },
      { op: 'extrude', r: [0.7958, 0.5556, 0.6148, 0.188, 0.4737, 0.3364, 0.1976, 0.0171] },
      { op: 'sketchOnFace', r: [0.1478, 0.0259, 0.8637, 0.3426, 0.9071, 0.4192, 0.8019, 0.0729] },
      { op: 'hole', r: [0.2274, 0.8989, 0.0614, 0.6924, 0.826, 0.3282, 0.8947, 0.159] },
      { op: 'extrude', r: [0.6349, 0.9919, 0.4834, 0.2315, 0.0539, 0.9114, 0.1419, 0.5449] },
    ],
  },
  {
    // A History reorder (UI) while an agent transaction is open, then transaction.cancel: the
    // user's reorder stays (as it must). Harness bug H1, the product was right.
    name: 'cancelTrace-s2-q330',
    finding: 'H1',
    invariant: 'cancelTrace',
    ops: [
      { op: 'sketch', r: [0.4745, 0.1792, 0.9017, 0.2703, 0.4846, 0.0674, 0.7044, 0.8471] },
      { op: 'extrude', r: [0.0057, 0.6258, 0.1508, 0.0526, 0.5052, 0.5128, 0.7809, 0.1957] },
      { op: 'extrude', r: [0.3242, 0.3662, 0.7636, 0.2468, 0.2698, 0.3017, 0.2499, 0.0553] },
      { op: 'sketchOnFace', r: [0.3045, 0.3076, 0.92, 0.532, 0.4938, 0.177, 0.7113, 0.2237] },
      { op: 'txBegin', r: [0.0633, 0.8304, 0.7545, 0.1459, 0.3487, 0.9034, 0.0107, 0.962] },
      { op: 'reorder', r: [0.3612, 0.5501, 0.9968, 0.5862, 0.2617, 0.9738, 0.8854, 0.2301] },
      { op: 'txCancel', r: [0.1623, 0.9559, 0.8452, 0.6591, 0.6619, 0.4179, 0.4055, 0.3347] },
    ],
  },
  {
    // Circle r 11 extruded 10, the same sketch cut 17.5 into it (the whole body), IGES (brep)
    // export: the cut left an empty "valid" body. Now the cut is refused.
    name: 'exception-s404-q32',
    finding: 'F8',
    invariant: 'exception',
    ops: [
      { op: 'sketch', r: [0.3969, 0.5435, 0.9818, 0.4011, 0.2613, 0.8956, 0.7859, 0.0037] },
      { op: 'extrude', r: [0.0472, 0.8801, 0.6354, 0.4616, 0.5792, 0.9606, 0.8242, 0.1644] },
      { op: 'extrude', r: [0.1717, 0.7906, 0.3854, 0.873, 0.7293, 0.4596, 0.5235, 0.7723] },
      { op: 'exchangeIges', r: [0.7913, 0.7325, 0.7874, 0.1654, 0.2606, 0.909, 0.893, 0.7436] },
    ],
  },
  {
    // Rectangle + text "HC" on XZ, R12 DXF export → import: 7 810 polyline vertices, a
    // 7 812-line sketch and 1.6 GB of kernel heap. Now ~340 vertices.
    name: 'heap-s505-q110',
    finding: 'F9',
    invariant: 'heap',
    ops: [
      { op: 'sketch', r: [0.5746, 0.9324, 0.2714, 0.0611, 0.7673, 0.872, 0.7305, 0.8833] },
      { op: 'text', r: [0.7654, 0.023, 0.6169, 0.5673, 0.499, 0.9208, 0.3493, 0.6079] },
      { op: 'exchangeDxf', r: [0.4384, 0.5616, 0.2968, 0.6479, 0.9497, 0.1587, 0.408, 0.7423] },
    ],
  },
  {
    // Rectangle + text "Ag 1", DXF export → import: the glyph counters become regions (by
    // design, D1); the invariant skips sketches with text.
    name: 'roundTrip-s505-q19',
    finding: 'D1',
    invariant: 'roundTrip',
    ops: [
      { op: 'sketch', r: [0.3247, 0.4249, 0.104, 0.4818, 0.3261, 0.1564, 0.0302, 0.1726] },
      { op: 'text', r: [0.0813, 0.5282, 0.3197, 0.3095, 0.1068, 0.956, 0.8474, 0.6518] },
      { op: 'exchangeDxf', r: [0.1218, 0.9417, 0.8517, 0.583, 0.5924, 0.3088, 0.9365, 0.5198] },
    ],
  },
  {
    // Two boxes touching on the sketch plane, one filleted, IGES (surfaces) export → import:
    // the sewing joined both into one inside-out shell (−267 mm³) reported as valid. Now the
    // body is invalid (negative volume) and the import warns.
    name: 'roundTrip-s505-q133',
    finding: 'F10',
    invariant: 'roundTrip',
    ops: [
      { op: 'sketch', r: [0.4305, 0.1742, 0.337, 0.9835, 0.5848, 0.1534, 0.4229, 0.1542] },
      { op: 'extrude', r: [0.4088, 0.6828, 0.2668, 0.7189, 0.05, 0.6271, 0.4691, 0.5723] },
      { op: 'extrude', r: [0.5457, 0.2149, 0.9265, 0.851, 0.364, 0.3218, 0.3974, 0.9728] },
      { op: 'fillet', r: [0.3699, 0.4482, 0.2408, 0.3454, 0.9179, 0.3242, 0.7243, 0.4959] },
      { op: 'exchangeIges', r: [0.3801, 0.1849, 0.3902, 0.4125, 0.4982, 0.6291, 0.5076, 0.0514] },
    ],
  },
  {
    // Rectangle + text "O-ring" on YZ, revolved 360° about Z, IGES (faces) export → import:
    // the "O"'s torus-like faces lost their boundary (OCCT) and the closed void shells came
    // back as solids of their own (14 600 → 15 571 mm³). Now cavities are inner shells and the
    // empty faces are skipped with a warning (Block 9 integration).
    name: 'roundTrip-s1-q0',
    finding: 'F14',
    invariant: 'roundTrip',
    ops: [
      { op: 'sketch', r: [0.9385, 0.2048, 0.1977, 0.7222, 0.8567, 0.4216, 0.3221, 0.2493] },
      { op: 'text', r: [0.4139, 0.8099, 0.753, 0.8225, 0.3672, 0.6249, 0.4332, 0.0966] },
      { op: 'revolve', r: [0.6749, 0.2893, 0.186, 0.7277, 0.6527, 0.5634, 0.1674, 0.3911] },
      { op: 'exchangeIges', r: [0.2745, 0.4259, 0.4575, 0.0349, 0.3781, 0.1643, 0.8609, 0.4851] },
    ],
  },
];

/**
 * Known kernel-marginal cases (finding F3): OCCT's result for this geometry
 * depends on the wasm heap layout, so an incremental and a cold evaluation
 * can disagree. Replayed to keep every other invariant; a determinism
 * difference is accepted only when the harness proves it heap-layout
 * dependent (`harness.ts#checkDeterminism`).
 */
REPRODUCERS.push({
  // A plate with a draft, History rolled back before the draft, IGES export → import: the
  // export contained the draft (1 984 mm³) while the viewport and bodies.list showed 2 400.
  name: 'roundTrip-s707-q24',
  finding: 'F12',
  invariant: 'roundTrip',
  ops: [
    { op: 'sketch', r: [0.9617, 0.9465, 0.5382, 0.8855, 0.1551, 0.3587, 0.8207, 0.6079] },
    { op: 'extrude', r: [0.0343, 0.7927, 0.8172, 0.3659, 0.63, 0.7342, 0.7521, 0.1914] },
    { op: 'draft', r: [0.5164, 0.8459, 0.5888, 0.9112, 0.3273, 0.1381, 0.8925, 0.3756] },
    { op: 'rollback', r: [0.6617, 0.8239, 0.0923, 0.7198, 0.112, 0.1012, 0.2757, 0.4104] },
    { op: 'exchangeIges', r: [0.2895, 0.291, 0.8597, 0.0329, 0.9856, 0.4621, 0.7349, 0.9815] },
  ],
});

export const MARGINAL_REPRODUCERS: RegressionCase[] = [
  {
    // Disc r 7 x 4, linear pattern, shell 2.6 (open end), emboss on a copy, then a 0.7 mm
    // shell of the shell's inner face: fits or not depending on the heap layout.
    name: 'determinism-s1-q28',
    finding: 'F3',
    invariant: 'determinism',
    ops: [
      { op: 'sketch', r: [0.6584, 0.4288, 0.8248, 0.8017, 0.3218, 0.5288, 0.9572, 0.159] },
      { op: 'extrudeExpr', r: [0.6614, 0.3842, 0.267, 0.1494, 0.3448, 0.0976, 0.7693, 0.9491] },
      { op: 'pattern', r: [0.2836, 0.3403, 0.668, 0.7395, 0.7216, 0.2286, 0.5159, 0.731] },
      { op: 'shell', r: [0.1591, 0.5819, 0.6302, 0.1362, 0.9546, 0.3989, 0.0636, 0.8534] },
      { op: 'emboss', r: [0.2898, 0.6566, 0.2363, 0.466, 0.5365, 0.716, 0.1983, 0.5107] },
      { op: 'polyline', r: [0.0022, 0.4421, 0.7891, 0.5418, 0.8534, 0.453, 0.9612, 0.6915] },
      { op: 'shell', r: [0.1319, 0.8226, 0.1342, 0.2703, 0.2331, 0.7289, 0.665, 0.9798] },
      { op: 'sketch', r: [0.2835, 0.4519, 0.7077, 0.7474, 0.511, 0.152, 0.5781, 0.8829] },
      { op: 'polyline', r: [0.0295, 0.6546, 0.1875, 0.8846, 0.0303, 0.1, 0.0967, 0.4114] },
    ],
  },
  {
    // A circle revolved about the X axis beside its XZ plane (a torus-like ring), suppress +
    // undo, then a cylinder cut through it: after ~430 sequences in one process the cut was a
    // no-op in the incremental evaluation and an invalid, inside-out result (-10 298 mm³, with
    // the safety-net warning) in the cold one; in fresh processes both give the invalid result.
    name: 'determinism-s101-q434',
    finding: 'F6',
    invariant: 'determinism',
    ops: [
      { op: 'sketch', r: [0.204, 0.7819, 0.7669, 0.9375, 0.118, 0.5458, 0.0076, 0.6466] },
      { op: 'sketch', r: [0.3917, 0.6262, 0.9586, 0.6011, 0.2061, 0.5817, 0.805, 0.8276] },
      { op: 'revolve', r: [0.5667, 0.1598, 0.3889, 0.2352, 0.6554, 0.0312, 0.1025, 0.4445] },
      { op: 'suppress', r: [0.7389, 0.5664, 0.3815, 0.8546, 0.9596, 0.4488, 0.5899, 0.8689] },
      { op: 'undo', r: [0.421, 0.3493, 0.7746, 0.5317, 0.9695, 0.3315, 0.5464, 0.5447] },
      { op: 'extrude', r: [0.4082, 0.9931, 0.2881, 0.5022, 0.2382, 0.8309, 0.2567, 0.7621] },
    ],
  },
  {
    // A thicken (tube) cut by a sketch after an earlier sketch edit: evaluated on a checkpoint
    // the (no-op) cut keeps a slit edge twice, evaluated in one replay once — closed vs open
    // (F11). A fresh evaluator in the session's order agrees with the session.
    name: 'determinism-s404-q42',
    finding: 'F11',
    invariant: 'determinism',
    ops: [
      { op: 'addDimension', r: [0.6548, 0.1115, 0.3262, 0.0212, 0.0528, 0.2463, 0.4112, 0.2284] },
      { op: 'sketch', r: [0.6642, 0.7689, 0.9017, 0.7411, 0.4612, 0.998, 0.4081, 0.0043] },
      { op: 'openPolyline', r: [0.3832, 0.4337, 0.884, 0.3002, 0.3112, 0.3967, 0.2582, 0.7647] },
      { op: 'extrudeExtent', r: [0.2255, 0.2574, 0.5374, 0.4276, 0.7834, 0.1375, 0.6282, 0.7874] },
      { op: 'exchangeStep', r: [0.7343, 0.0338, 0.5276, 0.231, 0.6478, 0.872, 0.5645, 0.148] },
      { op: 'text', r: [0.2292, 0.8953, 0.8506, 0.5532, 0.1247, 0.1216, 0.2529, 0.4013] },
      { op: 'hole', r: [0.8371, 0.9071, 0.573, 0.3679, 0.5847, 0.9344, 0.0654, 0.3165] },
      { op: 'suppress', r: [0.8748, 0.6397, 0.8092, 0.878, 0.1835, 0.5101, 0.4529, 0.6824] },
      {
        op: 'setDimensionExpr',
        r: [0.9673, 0.1355, 0.7376, 0.9273, 0.7101, 0.8724, 0.0733, 0.4879],
      },
      { op: 'undo', r: [0.0413, 0.4999, 0.4043, 0.7674, 0.4546, 0.861, 0.5951, 0.4587] },
      { op: 'chamfer', r: [0.4573, 0.3663, 0.9452, 0.9316, 0.5654, 0.0797, 0.674, 0.5149] },
      { op: 'extrude', r: [0.1576, 0.3385, 0.0289, 0.7094, 0.7367, 0.4989, 0.5212, 0.6928] },
      { op: 'featureEdit', r: [0.909, 0.9746, 0.6974, 0.3214, 0.1329, 0.3084, 0.5194, 0.9089] },
      { op: 'setDimension', r: [0.5743, 0.6898, 0.2983, 0.6834, 0.8027, 0.4397, 0.2459, 0.2328] },
      { op: 'extrude', r: [0.3194, 0.5079, 0.1143, 0.4615, 0.3482, 0.0966, 0.3129, 0.2994] },
      { op: 'revolve', r: [0.522, 0.7732, 0.1777, 0.3679, 0.735, 0.036, 0.4932, 0.9946] },
      { op: 'sketchOnFace', r: [0.2014, 0.3428, 0.8348, 0.0849, 0.6445, 0.4738, 0.5575, 0.5381] },
      { op: 'pattern', r: [0.8041, 0.3864, 0.3337, 0.1347, 0.5138, 0.6616, 0.7071, 0.1946] },
      { op: 'reorder', r: [0.8476, 0.915, 0.9326, 0.5545, 0.6624, 0.8838, 0.5095, 0.8226] },
      { op: 'addProfile', r: [0.2483, 0.1434, 0.981, 0.7045, 0.4303, 0.1226, 0.4648, 0.7695] },
      { op: 'reorder', r: [0.5274, 0.1743, 0.0965, 0.9083, 0.8039, 0.0665, 0.6042, 0.216] },
      { op: 'fillet', r: [0.2175, 0.1801, 0.3985, 0.1664, 0.4762, 0.5053, 0.3031, 0.9164] },
      { op: 'rollback', r: [0.568, 0.3143, 0.623, 0.1216, 0.6986, 0.744, 0.4399, 0.6119] },
      { op: 'addProfile', r: [0.6939, 0.6564, 0.862, 0.1652, 0.1155, 0.1671, 0.9801, 0.1715] },
      { op: 'fillet', r: [0.5307, 0.0328, 0.7581, 0.9979, 0.7094, 0.3958, 0.693, 0.2702] },
      { op: 'txCancel', r: [0.8601, 0.6689, 0.0031, 0.2603, 0.8954, 0.2555, 0.897, 0.6606] },
      { op: 'paramDelete', r: [0.3302, 0.1532, 0.4246, 0.5137, 0.6685, 0.131, 0.5826, 0.8697] },
      { op: 'featureEdit', r: [0.4434, 0.2128, 0.9418, 0.4204, 0.906, 0.6188, 0.0922, 0.6815] },
      { op: 'suppress', r: [0.1699, 0.9193, 0.2842, 0.5825, 0.902, 0.1715, 0.4715, 0.2502] },
      {
        op: 'constructionPlane',
        r: [0.9319, 0.6182, 0.3827, 0.9094, 0.8816, 0.4513, 0.7484, 0.2026],
      },
      { op: 'rib', r: [0.8755, 0.2377, 0.7954, 0.5238, 0.4991, 0.228, 0.5119, 0.2462] },
      { op: 'shell', r: [0.2499, 0.1822, 0.9237, 0.0294, 0.0338, 0.5506, 0.4726, 0.3889] },
      { op: 'extrude', r: [0.5994, 0.9154, 0.6834, 0.4725, 0.1572, 0.7353, 0.3465, 0.3331] },
      { op: 'thicken', r: [0.1957, 0.3215, 0.5877, 0.0639, 0.847, 0.107, 0.3587, 0.9383] },
      { op: 'extrude', r: [0.6857, 0.5244, 0.3327, 0.9858, 0.9183, 0.8633, 0.6197, 0.6824] },
      { op: 'setDimension', r: [0.8572, 0.1791, 0.1405, 0.8022, 0.8564, 0.4254, 0.9575, 0.2435] },
      { op: 'extrude', r: [0.1106, 0.7996, 0.9183, 0.6655, 0.9983, 0.3127, 0.7366, 0.3399] },
    ],
  },
];
