/**
 * Printability analysis on known geometry (real OCCT kernel): overhang
 * classification of a 45°/60° chamfered block, wall thickness of a shelled
 * box of known thickness, small hole/pin detection, watertightness and the
 * build-volume check.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeBody,
  analyzePrintability,
  bodyToPrintInput,
  checkBuildVolume,
  classifyOverhangs,
  overhangAngleDeg,
} from '../../renderer/src/modules/print/analysis.js';
import { manifoldStats } from '../../renderer/src/modules/print/meshTools.js';
import { weldMesh } from '../../renderer/src/foundation/geometry-kernel/meshWeld.js';
import {
  DEFAULT_PRINT_SETTINGS,
  type PrintSettings,
} from '../../renderer/src/modules/print/settings.js';
import {
  boxFeatures,
  chamferedBlock,
  evaluate,
  extrude,
  pin,
  polygonSketch,
  plateWithHoles,
  plateWithHolesOneRegion,
  shelledBox,
} from './fixtures.js';

const settings = (patch: Partial<PrintSettings> = {}): PrintSettings => ({
  ...DEFAULT_PRINT_SETTINGS,
  ...patch,
});

void test('overhangAngleDeg: 0° for walls and upward faces, 90° for a ceiling', () => {
  assert.equal(overhangAngleDeg(1), 0);
  assert.equal(overhangAngleDeg(0), 0);
  assert.equal(Math.round(overhangAngleDeg(-1)), 90);
  assert.ok(Math.abs(overhangAngleDeg(-Math.sin(Math.PI / 4)) - 45) < 1e-9);
});

void test('chamfered block: the 60° side is an overhang at 45°, the 45° side only below 45°', async () => {
  const result = await evaluate(chamferedBlock());
  const body = result.bodies[0]!;
  const input = bodyToPrintInput(body);
  const leaning = body.faces.filter((f) => f.normal && f.normal[2] < -1e-6 && f.normal[2] > -0.999);
  assert.equal(leaning.length, 2, 'two leaning faces');
  const face60 = leaning.find((f) => Math.abs(overhangAngleDeg(f.normal![2]) - 60) < 0.01)!;
  const face45 = leaning.find((f) => Math.abs(overhangAngleDeg(f.normal![2]) - 45) < 0.01)!;
  assert.ok(face60 && face45, 'faces at 60° and 45° from vertical');

  const at45 = analyzeBody(input, settings({ overhangAngleDeg: 45 }));
  const keys45 = at45.overhang.faces.map((f) => f.faceKey);
  assert.deepEqual(keys45, [face60.key], 'only the 60° face overhangs at a 45° threshold');
  assert.ok(
    Math.abs(at45.overhang.areaMm2 - face60.area) < 1e-3 * face60.area,
    'overhang area = face area',
  );
  assert.ok(Math.abs(at45.overhang.faces[0]!.value - 60) < 0.01, 'reported angle 60°');
  // The bottom face lies on the plate and is never an overhang.
  const bottom = body.faces.find((f) => f.normal && f.normal[2] < -0.999)!;
  assert.ok(!keys45.includes(bottom.key));

  const at44 = analyzeBody(input, settings({ overhangAngleDeg: 44 }));
  assert.deepEqual(
    at44.overhang.faces.map((f) => f.faceKey).sort(),
    [face45.key, face60.key].sort(),
    'both leaning faces overhang at 44°',
  );
  const at65 = analyzeBody(input, settings({ overhangAngleDeg: 65 }));
  assert.equal(at65.overhang.faces.length, 0, 'nothing beyond 65°');
});

void test('a box standing on the plate has no overhang (its bottom lies on the plate)', async () => {
  const result = await evaluate(boxFeatures('b', 10, 10, 10));
  const input = bodyToPrintInput(result.bodies[0]!);
  const onPlate = classifyOverhangs(input, 45, input.triangleFaces);
  assert.equal(onPlate.areaMm2, 0, 'a box on the plate has no overhang');
});

void test('wall thickness of a shelled box matches the shell thickness', async () => {
  const result = await evaluate(await shelledBox(1.5));
  const body = result.bodies[0]!;
  const input = bodyToPrintInput(body);

  const ok = analyzeBody(input, settings({ minWallMm: 0.8 }));
  assert.ok(ok.thinWall.samples > 500, `enough samples (${ok.thinWall.samples})`);
  assert.equal(ok.thinWall.thinSamples, 0, 'no wall is below 0.8 mm');
  assert.ok(
    Math.abs(ok.thinWall.minThicknessMm! - 1.5) < 0.02,
    `thinnest wall ≈ 1.5 mm (got ${ok.thinWall.minThicknessMm})`,
  );

  const thin = analyzeBody(input, settings({ minWallMm: 2 }));
  assert.ok(thin.thinWall.thinSamples > 0.5 * thin.thinWall.samples, 'most samples are below 2 mm');
  // Every side wall and the floor are flagged (inside and outside faces).
  const flagged = new Set(thin.thinWall.faces.map((f) => f.faceKey));
  const walls = body.faces.filter((f) => f.normal && Math.abs(f.normal[2]) < 0.01);
  assert.ok(
    walls.every((w) => flagged.has(w.key)),
    'all vertical wall faces flagged',
  );
  for (const f of thin.thinWall.faces)
    assert.ok(Math.abs(f.value - 1.5) < 0.02, `${f.faceKey}: ${f.value}`);
});

void test('sharp wedge edges are not reported as 0 mm walls; a real thin wall still is', async () => {
  // A 30°/60° wedge prism (profile in XZ, 20 mm along Y): everywhere at least 1 mm
  // away from its edges the wedge is thicker than 0.8 mm.
  const h = 20 * Math.tan((30 * Math.PI) / 180);
  const s = polygonSketch(
    'wedge-s',
    [
      [0, 0],
      [20, 0],
      [0, h],
    ],
    'XZ',
  );
  const wedge = await evaluate([s.feature, extrude('wedge-e', 'wedge-s', [s.regionKey], 20)]);
  const report = analyzeBody(bodyToPrintInput(wedge.bodies[0]!), settings({ minWallMm: 0.8 }));
  assert.ok(report.thinWall.samples > 500, `enough samples (${report.thinWall.samples})`);
  assert.equal(report.thinWall.thinSamples, 0, 'no thin wall along the 30° edge');
  assert.ok(
    report.thinWall.minThicknessMm! > 0.8,
    `thinnest measured wall ${report.thinWall.minThicknessMm} mm is outside the edge band`,
  );

  // A 0.5 mm plate is still a thin wall (its top and bottom share no edge).
  const plate = await evaluate(boxFeatures('thin', 20, 20, 0.5));
  const thin = analyzeBody(bodyToPrintInput(plate.bodies[0]!), settings({ minWallMm: 0.8 }));
  assert.ok(thin.thinWall.thinSamples > 0, 'the 0.5 mm plate is flagged');
  assert.ok(
    Math.abs(thin.thinWall.minThicknessMm! - 0.5) < 0.01,
    `${thin.thinWall.minThicknessMm}`,
  );
});

void test('small holes and pins are flagged by diameter', async () => {
  const plate = await evaluate(plateWithHoles());
  const report = analyzeBody(bodyToPrintInput(plate.bodies[0]!), settings());
  const holes = report.cylinders.filter((c) => c.kind === 'hole');
  assert.deepEqual(
    holes.map((h) => Number(h.diameterMm.toFixed(3))).sort((a, b) => a - b),
    [1.5, 6],
  );
  assert.deepEqual(
    holes.filter((h) => h.flagged).map((h) => Number(h.diameterMm.toFixed(3))),
    [1.5],
    'only the Ø1.5 hole is below 2 mm',
  );
  const pinResult = await evaluate(pin());
  const pinReport = analyzeBody(bodyToPrintInput(pinResult.bodies[0]!), settings());
  assert.equal(pinReport.cylinders.length, 1);
  assert.equal(pinReport.cylinders[0]!.kind, 'pin');
  assert.ok(pinReport.cylinders[0]!.flagged, 'Ø0.8 pin is below 1 mm');
});

void test('a plate extruded from one region with holes is valid, watertight and has two holes (not pins)', async () => {
  const result = await evaluate(plateWithHolesOneRegion());
  const body = result.bodies[0]!;
  const expected = (800 - Math.PI * (0.75 ** 2 + 3 ** 2)) * 5;
  assert.ok(Math.abs(body.volume - expected) < 1e-6 * expected, `volume ${body.volume}`);
  const report = analyzeBody(bodyToPrintInput(body), settings());
  assert.ok(report.brepValid, 'B-rep valid');
  assert.ok(report.watertight, 'watertight');
  assert.ok(Math.abs(report.meshVolumeMm3 - expected) < 0.01 * expected);
  assert.deepEqual(report.cylinders.map((c) => `${c.kind} ${c.diameterMm.toFixed(3)}`).sort(), [
    'hole 1.500',
    'hole 6.000',
  ]);
});

void test('kernel meshes weld into watertight manifolds; a missing triangle is detected', async () => {
  for (const features of [boxFeatures('w', 12, 8, 5), plateWithHoles(), chamferedBlock()]) {
    const result = await evaluate(features);
    const body = result.bodies[0]!;
    const report = analyzeBody(bodyToPrintInput(body), settings());
    assert.ok(report.brepValid);
    assert.ok(report.watertight, `${body.name} watertight`);
    assert.ok(
      Math.abs(report.meshVolumeMm3 - body.volume) < 0.01 * body.volume,
      `${body.name} mesh volume ${report.meshVolumeMm3} ≈ ${body.volume}`,
    );
  }
  const result = await evaluate(boxFeatures('h', 10, 10, 10));
  const mesh = result.bodies[0]!.mesh;
  const welded = weldMesh({ positions: mesh.positions, indices: mesh.indices.slice(3) });
  const stats = manifoldStats(welded.indices);
  assert.equal(stats.watertight, false);
  assert.equal(stats.boundaryEdges, 3, 'the hole left by one triangle has three open edges');
});

void test('build volume: fits, fits only rotated, does not fit (findings and severity)', async () => {
  assert.deepEqual(checkBuildVolume([200, 100, 50], [256, 256, 256]), {
    fits: true,
    fitsRotated: true,
  });
  assert.deepEqual(checkBuildVolume([240, 200, 50], [250, 210, 220]), {
    fits: true,
    fitsRotated: false,
  });
  assert.deepEqual(checkBuildVolume([205, 240, 50], [250, 210, 220]), {
    fits: false,
    fitsRotated: true,
  });
  assert.deepEqual(checkBuildVolume([300, 20, 10], [256, 256, 256]), {
    fits: false,
    fitsRotated: false,
  });

  const long = await evaluate(boxFeatures('long', 300, 20, 10));
  const inputs = long.bodies.map(bodyToPrintInput);
  const x1 = analyzePrintability(inputs, settings({ buildVolume: 'bambuX1' }));
  const finding = x1.findings.find((f) => f.kind === 'buildVolume');
  assert.ok(finding, 'a 300 mm body does not fit 256³');
  assert.equal(finding.severity, 'error');
  assert.match(finding.message, /does not fit/);

  const rotated = await evaluate(boxFeatures('rot', 205, 240, 10));
  const mk4 = analyzePrintability(
    rotated.bodies.map(bodyToPrintInput),
    settings({ buildVolume: 'prusaMk4' }),
  );
  const warning = mk4.findings.find((f) => f.kind === 'buildVolume');
  assert.equal(warning?.severity, 'warning', 'fits the MK4 only rotated 90°');

  const none = analyzePrintability(inputs, settings({ buildVolume: 'none' }));
  assert.equal(none.findings.filter((f) => f.kind === 'buildVolume').length, 0);
  const custom = analyzePrintability(
    inputs,
    settings({ buildVolume: 'custom', customVolume: [400, 400, 400] }),
  );
  assert.equal(custom.findings.filter((f) => f.kind === 'buildVolume').length, 0);
});

void test('material: mass and cost from the exact volume and the density preset', async () => {
  const result = await evaluate(boxFeatures('m', 10, 10, 10));
  const report = analyzePrintability(
    result.bodies.map(bodyToPrintInput),
    settings({ material: 'PETG', density: 1.27, costPerKg: 25 }),
  );
  assert.ok(Math.abs(report.totals.volumeMm3 - 1000) < 1e-6);
  assert.ok(Math.abs(report.totals.massG - 1.27) < 1e-9, '1 cm³ × 1.27 g/cm³');
  assert.ok(Math.abs(report.totals.cost - 1.27 * 0.025) < 1e-9);
});

void test('a shell wall that does not fit the body fails (no unchanged or empty "shell")', async () => {
  // The 30 � 30 � 20 box: 15 mm walls meet in the middle, 16 and 40 mm do not fit at all.
  for (const thickness of [15, 16, 40]) {
    await assert.rejects(
      evaluate(await shelledBox(thickness)),
      /Shell failed: a \d+ mm wall does not fit in this body/,
      `${thickness} mm`,
    );
  }
  const ok = await evaluate(await shelledBox(14));
  assert.ok(ok.bodies[0]!.valid);
});
