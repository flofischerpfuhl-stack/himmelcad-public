import assert from 'node:assert/strict';
import test from 'node:test';

import type { CanonicalEntity } from '@himmelcad/data/canonical';
import type { EntityId } from '@himmelcad/data';

import {
  MeasurementToolController,
  attachedMeasurementAnchor,
  fixedMeasurementAnchor,
  formatMeasurementLength,
  heightDifferenceOnProjectMeasurementPlane,
  measurementLabel,
  measurementValue,
  visibleMeasurementDecimals,
} from '../src/measurement.js';

test('G-MI-UNIT-MATH evaluates horizontal, spatial and signed Δz to 1e-9 m', () => {
  const first = fixedMeasurementAnchor({ x: 1_000_000, y: 2_000_000, z: 100 });
  const second = fixedMeasurementAnchor({ x: 1_000_003, y: 2_000_004, z: 112 });
  assert.ok(
    Math.abs(measurementValue('distance', 'horizontal', [first, second])!.metres! - 5) < 1e-9,
  );
  assert.ok(
    Math.abs(measurementValue('distance', 'spatial', [first, second])!.metres! - 13) < 1e-9,
  );
  assert.ok(
    Math.abs(
      heightDifferenceOnProjectMeasurementPlane(
        { x: 0, y: 0, z: 100 },
        { x: 50, y: -20, z: 100.412 },
      ) - 0.412,
    ) < 1e-9,
  );
  assert.throws(
    () =>
      measurementValue('distance', 'spatial', [
        fixedMeasurementAnchor({ x: 0, y: 0, z: null }),
        fixedMeasurementAnchor({ x: 1, y: 1, z: 1 }),
      ]),
    /known Z/,
  );
});

test('G-MI-UNIT-ANCHOR preserves exact attached identity and typed fixed semantics', () => {
  const wallId = 'wall-1' as EntityId;
  const source: Pick<CanonicalEntity, 'id' | 'revision' | 'versionHash'> = {
    id: wallId,
    revision: 7,
    versionHash: 'ab'.repeat(32),
  };
  const attached = attachedMeasurementAnchor(
    {
      position: { x: 123.456789, y: 45.25, z: 10.125 },
      kind: 'Vertex',
      entity: wallId,
      confidence: 1,
      source: 'cad',
      target: {
        datasetKind: 'cad',
        entityId: wallId,
        layerId: 'layer-a',
        primitive: { kind: 'vertex', vertexIndex: 42 },
        exact: true,
      },
    },
    source,
  );
  assert.deepEqual(attached, {
    binding: 'attached',
    entityId: 'wall-1',
    expectedRevision: 7,
    expectedVersionHash: 'ab'.repeat(32),
    providerId: 'cad',
    representationId: 'layer-a',
    primitiveAddress: 'kind=vertex;vertexIndex=42',
    sourceParameter: null,
    exactSourcePosition: { x: 123.456789, y: 45.25, z: 10.125 },
    offset: { x: 0, y: 0, z: 0 },
  });
  assert.deepEqual(fixedMeasurementAnchor({ x: 1, y: 2, z: 3 }), {
    binding: 'fixed',
    position: { x: 1, y: 2, z: 3 },
  });
  assert.throws(
    () =>
      attachedMeasurementAnchor(
        {
          position: { x: 1, y: 2, z: 3 },
          kind: 'Face',
          entity: wallId,
          confidence: 0.5,
          target: {
            datasetKind: 'mesh',
            entityId: wallId,
            primitive: { kind: 'face', faceIndex: 2 },
            exact: false,
          },
        },
        source,
      ),
    /exact canonical snap/,
  );
});

test('G-MI-COMMAND and G-MI-CONTINUOUS preview without writes then commit exactly once', async () => {
  const commands: unknown[] = [];
  const controller = new MeasurementToolController({
    layerId: 'default-layer',
    nextName: () => 'Distance 1',
    sink: {
      create: async (input) => {
        commands.push(input);
        return input;
      },
    },
  });
  controller.arm('distance', 'spatial');
  await controller.acceptTyped({ x: 0, y: 0, z: 0 });
  for (let frame = 0; frame < 1_000; frame += 1) {
    controller.pointer(fixedMeasurementAnchor({ x: frame / 10, y: 4, z: 12 }));
  }
  assert.equal(controller.snapshot().journalWrites, 0);
  assert.equal(commands.length, 0);
  assert.equal(controller.snapshot().liveValue?.metres, Math.hypot(99.9, 4, 12));
  await controller.acceptPreview();
  assert.equal(commands.length, 1);
  assert.equal(controller.snapshot().journalWrites, 1);
  assert.equal(controller.snapshot().armed, false);
  const command = commands[0] as { measurement: { anchors: unknown[] } };
  assert.equal(command.measurement.anchors.length, 2);
});

test('G-MI-COMMAND coalesces repeated terminal input while its one write is pending', async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let creates = 0;
  const controller = new MeasurementToolController({
    layerId: 'default-layer',
    nextName: () => 'Point 1',
    sink: {
      create: async () => {
        creates += 1;
        await pending;
      },
    },
  });
  controller.arm('point');
  controller.pointer(fixedMeasurementAnchor({ x: 1, y: 2, z: 3 }));
  const first = controller.acceptPreview();
  const duplicate = controller.acceptPreview();
  assert.equal(creates, 1);
  assert.equal(await duplicate, null);
  assert.equal(controller.snapshot().journalWrites, 0);
  release?.();
  await first;
  assert.equal(controller.snapshot().journalWrites, 1);
  assert.equal(controller.snapshot().armed, false);
});

test('distance metric changes preserve accepted and preview anchors', async () => {
  const controller = new MeasurementToolController({
    layerId: 'default-layer',
    nextName: () => 'Distance 1',
    sink: { create: async () => undefined },
  });
  controller.arm('distance', 'spatial');
  await controller.acceptTyped({ x: 0, y: 0, z: 0 });
  controller.pointer(fixedMeasurementAnchor({ x: 3, y: 4, z: 12 }));
  controller.setDistanceMetric('horizontal');
  assert.equal(controller.snapshot().anchors.length, 1);
  assert.equal(controller.snapshot().preview?.binding, 'fixed');
  assert.equal(controller.snapshot().liveValue?.metres, 5);
});

test('G-MI-VISIBLE-PRECISION follows zoom, project units and anchor precision cap', () => {
  const metres = { lengthUnit: 'm' as const, maximumDecimals: 6 };
  assert.equal(visibleMeasurementDecimals(1_000, metres, 2), 2);
  assert.equal(visibleMeasurementDecimals(10, metres, 8), 2);
  assert.equal(formatMeasurementLength(12.34567, metres, 1_000, 3), '12.346 m');
  assert.equal(
    formatMeasurementLength(0.412, { lengthUnit: 'mm', maximumDecimals: 1 }, 1_000, 4, 'Δz '),
    'Δz 412.0 mm',
  );
  assert.equal(
    formatMeasurementLength(0.4123, { lengthUnit: 'mm', maximumDecimals: 3 }, 10_000, 4),
    '412.3 mm',
  );
  assert.equal(
    measurementLabel(
      { kind: 'point', metric: null, metres: null, point: { x: 0.0012, y: 0.002, z: null } },
      { lengthUnit: 'mm', maximumDecimals: 3 },
      10_000,
      4,
    ),
    'X 1.2  Y 2.0  Z —',
  );
  assert.equal(
    measurementLabel(
      { kind: 'point', metric: null, metres: null, point: { x: 1.2345, y: 2, z: null } },
      metres,
      100,
      2,
    ),
    'X 1.23  Y 2.00  Z —',
  );
});
