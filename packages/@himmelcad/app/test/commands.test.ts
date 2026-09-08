import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMAND_REGISTRY,
  QUICK_SURFACE_ENTRY_CAP,
  assertRuntimeCommandRegistry,
  commandsForSurface,
  completeConsoleCommand,
  consoleHelpEntries,
  dispatchRegistryShortcut,
  executeAutomationCommand,
  executeConsoleLine,
  type CommandContext,
  type CommandInvocation,
} from '../src/index.js';

const base = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  hasProject: true,
  productId: 'builder',
  selectedEntityIds: [],
  selectedEntityKinds: [],
  selectionVisibility: 'visible',
  selectionEditable: true,
  selectionExportable: false,
  clipboardAdmissible: false,
  candidates: [],
  ...overrides,
});

void test('G-UIP-CMD every generated row is reachable and runtime shortcuts do not collide', () => {
  assert.doesNotThrow(assertRuntimeCommandRegistry);
  for (const entry of COMMAND_REGISTRY) {
    assert.equal(
      entry.surfaces.ribbon ||
        entry.surfaces.contextMenu ||
        entry.surfaces.quickSurface ||
        entry.surfaces.console,
      true,
      entry.id,
    );
    assert.ok(entry.products.length > 0, `${entry.id} has explicit products`);
  }
});

void test('P-01 exposes one generated row for every Builder project lifecycle act', () => {
  const ids = new Set(COMMAND_REGISTRY.map((entry) => entry.id));
  for (const id of [
    'project.new',
    'project.open',
    'project.recent',
    'project.save',
    'project.save_as',
    'project.close',
  ] as const) {
    assert.equal(ids.has(id), true, id);
  }
});

void test('S-09 view.box automation parity is generated from the single command table', () => {
  const ids = new Set(COMMAND_REGISTRY.map((entry) => entry.id));
  for (const id of [
    'view.box.place',
    'view.box.update',
    'view.box.set_operation',
    'view.box.lock',
    'view.box.unlock',
    'view.box.rename',
    'view.box.activate',
    'view.box.deactivate',
    'view.box.remove',
    'view.box.list',
  ] as const) {
    assert.equal(ids.has(id), true, id);
  }
});

void test('G-MI-COMMAND P11 measurement rows share the generated UI and automation table', () => {
  const rows = new Map(COMMAND_REGISTRY.map((entry) => [entry.id, entry]));
  for (const id of [
    'measure.point',
    'measure.distance',
    'measure.dz',
    'measurement.list',
    'measurement.delete',
  ] as const) {
    const row = rows.get(id);
    assert.ok(row, id);
    assert.equal(row.products.includes('builder'), true, id);
    assert.equal(row.surfaces.automation, true, id);
    assert.match(row.ownerSpec, /owner: measure-inspect/u, id);
  }
});

void test('G17 P11 ground extract, preview and cancel share one typed command table', () => {
  const rows = new Map(COMMAND_REGISTRY.map((entry) => [entry.id, entry]));
  for (const id of [
    'pointcloud.ground.extract',
    'pointcloud.ground.preview',
    'pointcloud.ground.cancel',
  ] as const) {
    const row = rows.get(id);
    assert.ok(row, id);
    assert.deepEqual(row.products, ['builder'], id);
    assert.equal(row.surfaces.console, true, id);
    assert.equal(row.surfaces.automation, true, id);
    assert.match(row.ownerSpec, /Point cloud/u, id);
  }
  const extract = rows.get('pointcloud.ground.extract')!;
  assert.equal(extract.surfaces.ribbon, true);
  assert.equal(extract.surfaces.contextMenu, true);
  assert.equal(extract.allowMultiSelect, false);
  assert.deepEqual(extract.entityKinds, ['PointCloud']);
});

void test('G17 ground automation round-trip preserves typed SMRF parameters', async () => {
  const calls: CommandInvocation[] = [];
  const payload = {
    schemaId: 'hcad.pointcloud.ground-request@1',
    payload: {
      operationId: 'automation-ground-1',
      sourceEntityId: 'cloud-a',
      parameters: { cellSizeM: 1, slope: 0.15, maxWindowM: 18, initialDistanceM: 0.5 },
    },
  };
  await executeAutomationCommand(
    'pointcloud.ground.preview',
    payload,
    base({
      selectedEntityIds: ['cloud-a'],
      selectedEntityKinds: ['cloud'],
      selectedCanonicalEntityKinds: ['PointCloud'],
    }),
    (invocation) => {
      calls.push(invocation);
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.id, 'pointcloud.ground.preview');
  assert.deepEqual(calls[0]?.payload, payload);
});

void test('PC-D5/PC-D6 P11 fence and segmentation rows share UI and automation parity', async () => {
  const rows = new Map(COMMAND_REGISTRY.map((entry) => [entry.id, entry]));
  const ids = [
    'pointcloud.fence.begin',
    'pointcloud.fence.commit',
    'pointcloud.fence.cancel',
    'pointcloud.segment.keep_inside',
    'pointcloud.segment.remove_inside',
  ] as const;
  for (const id of ids) {
    const row = rows.get(id);
    assert.ok(row, id);
    assert.deepEqual(row.products, ['builder'], id);
    assert.equal(row.surfaces.console, true, id);
    assert.equal(row.surfaces.automation, true, id);
    assert.match(row.ownerSpec, /owner: pointcloud/u, id);
  }
  assert.equal(rows.get('pointcloud.fence.begin')!.surfaces.ribbon, true);
  assert.equal(rows.get('pointcloud.fence.begin')!.surfaces.contextMenu, true);
  for (const id of ids.slice(3)) {
    assert.equal(rows.get(id)!.allowMultiSelect, true, id);
    assert.deepEqual(rows.get(id)!.entityKinds, ['PointCloud'], id);
  }

  const calls: CommandInvocation[] = [];
  const request = {
    schemaId: 'hcad.pointcloud.segment-request@1',
    payload: {
      operationId: 'segment-1',
      entityIds: ['cloud-a'],
      polygon: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
    },
  };
  await executeAutomationCommand(
    'pointcloud.segment.keep_inside',
    request,
    base({
      selectedEntityIds: ['cloud-a'],
      selectedEntityKinds: ['cloud'],
      selectedCanonicalEntityKinds: ['PointCloud'],
    }),
    (invocation) => {
      calls.push(invocation);
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.id, 'pointcloud.segment.keep_inside');
  assert.deepEqual(calls[0]?.payload, request);
});

void test('G-B2-PC-MEAN-SAMPLE P11 rows share the generated UI and automation table', () => {
  const rows = new Map(COMMAND_REGISTRY.map((entry) => [entry.id, entry]));
  for (const id of ['pointcloud.sample', 'pointcloud.rasterize'] as const) {
    const row = rows.get(id);
    assert.ok(row, id);
    assert.deepEqual(row.products, ['builder'], id);
    assert.equal(row.surfaces.ribbon, true, id);
    assert.equal(row.surfaces.contextMenu, true, id);
    assert.equal(row.surfaces.console, true, id);
    assert.equal(row.surfaces.automation, true, id);
    assert.equal(row.allowMultiSelect, false, id);
    assert.deepEqual(row.entityKinds, ['PointCloud'], id);
  }
  assert.match(rows.get('pointcloud.sample')!.ownerSpec, /owner: pointcloud/u);
  assert.match(rows.get('pointcloud.rasterize')!.ownerSpec, /owner: mesh-terrain/u);
});

void test('G-B2-MESH-DRAFT-RULES P11 draft, check, fix, and publish share one table', () => {
  const rows = new Map(COMMAND_REGISTRY.map((entry) => [entry.id, entry]));
  for (const id of [
    'mesh.surface.draft.create',
    'mesh.surface.check',
    'mesh.surface.draft.apply_fix',
    'mesh.surface.create',
  ] as const) {
    const row = rows.get(id);
    assert.ok(row, id);
    assert.deepEqual(row.products, ['builder'], id);
    assert.equal(row.surfaces.console, true, id);
    assert.equal(row.surfaces.automation, true, id);
    assert.match(row.ownerSpec, /owner: mesh-terrain/u, id);
  }
  const publish = rows.get('mesh.surface.create')!;
  assert.equal(publish.surfaces.ribbon, true);
  assert.equal(publish.surfaces.contextMenu, true);
  assert.equal(publish.allowMultiSelect, true);
  assert.deepEqual(publish.entityKinds, [
    'PointCloud',
    'SinglePoint',
    'Polyline3D',
    'Surface',
    'DigitalElevationModel',
  ]);
});

void test('G-B2-PC-MEAN-SAMPLE automation preserves typed methods, origin and empty policy', async () => {
  const calls: CommandInvocation[] = [];
  const context = base({
    selectedEntityIds: ['cloud-a'],
    selectedEntityKinds: ['cloud'],
    selectedCanonicalEntityKinds: ['PointCloud'],
  });
  const sample = {
    schemaId: 'hcad.pointcloud.sample-request@1',
    payload: {
      operationId: 'sample-1',
      sourceEntityId: 'cloud-a',
      parameters: {
        method: 'grid',
        spacingM: 0.25,
        percentage: 10,
        originX: 440000,
        originY: 5480000,
      },
    },
  };
  const rasterize = {
    schemaId: 'hcad.pointcloud.rasterize-request@1',
    payload: {
      operationId: 'rasterize-1',
      sourceEntityId: 'cloud-a',
      parameters: {
        cellSizeM: 1,
        aggregation: 'mean',
        emptyCellPolicy: 'no_data',
      },
    },
  };
  await executeAutomationCommand('pointcloud.sample', sample, context, (call) => {
    calls.push(call);
  });
  await executeAutomationCommand('pointcloud.rasterize', rasterize, context, (call) => {
    calls.push(call);
  });
  assert.deepEqual(
    calls.map((call) => [call.id, call.payload]),
    [
      ['pointcloud.sample', sample],
      ['pointcloud.rasterize', rasterize],
    ],
  );
});

void test('context menu content follows selection kind and cloud stays deliberate', () => {
  const ids = (kind: CommandContext['selectedEntityKinds'][number], exportable = false) =>
    commandsForSurface(
      'contextMenu',
      base({
        selectedEntityIds: ['selected'],
        selectedEntityKinds: [kind],
        selectionExportable: exportable,
        candidates: [
          { entityId: 'selected', kind: 'Object', name: 'Selected' },
          { entityId: 'behind', kind: 'Object', name: 'Behind' },
        ],
      }),
    ).map((entry) => entry.id);
  assert.deepEqual(ids('point'), [
    'select.set',
    'entity.rename',
    'entity.zoom_to',
    'entity.hide',
    'entity.isolate',
    'measure.point',
    'measure.distance',
    'measure.dz',
    'entity.properties',
  ]);
  assert.deepEqual(ids('polyline', true), [
    'select.set',
    'entity.rename',
    'entity.zoom_to',
    'entity.hide',
    'entity.isolate',
    'measure.point',
    'measure.distance',
    'measure.dz',
    'entity.properties',
    'entity.export',
  ]);
  assert.deepEqual(ids('mesh', true), ids('polyline', true));
  assert.deepEqual(ids('cloud', true), [
    'select.set',
    'entity.zoom_to',
    'entity.hide',
    'entity.isolate',
    'measure.point',
    'measure.distance',
    'measure.dz',
    'entity.properties',
    'entity.export',
  ]);
});

void test('S-06d product predicates admit PhotoLab product export without Builder-only rows', () => {
  const ids = (
    canonicalKind: string,
    selectionKind: CommandContext['selectedEntityKinds'][number],
  ) =>
    commandsForSurface(
      'contextMenu',
      base({
        productId: 'photolab',
        selectedEntityIds: ['product-1'],
        selectedEntityKinds: [selectionKind],
        selectedCanonicalEntityKinds: [canonicalKind],
        selectionExportable: true,
      }),
    ).map((entry) => entry.id);

  for (const [canonicalKind, selectionKind] of [
    ['PointCloud', 'cloud'],
    ['GaussianSplatCloud', 'cloud'],
    ['DigitalElevationModel', 'other'],
    ['Mesh', 'mesh'],
    ['TexturedMesh', 'mesh'],
  ] as const) {
    assert.equal(ids(canonicalKind, selectionKind).includes('entity.export'), true, canonicalKind);
  }
  assert.equal(ids('CameraImage', 'other').includes('entity.export'), false);
  for (const id of ['view.bookmark.restore', 'entity.isolate', 'pointcloud.display.set'] as const) {
    assert.equal(ids('PointCloud', 'cloud').includes(id), false, id);
  }
});

void test('PhotoLab entity rows are product-, kind-, and cardinality-scoped', () => {
  const ids = (overrides: Partial<CommandContext>) =>
    commandsForSurface('contextMenu', base(overrides)).map((entry) => entry.id);
  const camera = {
    selectedEntityIds: ['image-1'],
    selectedEntityKinds: ['other'] as const,
    selectedCanonicalEntityKinds: ['CameraImage'],
    entityKind: 'CameraImage',
  };
  assert.equal(ids({ ...camera, productId: 'photolab' }).includes('photolab.images.remove'), true);
  assert.equal(ids({ ...camera, productId: 'builder' }).includes('photolab.images.remove'), false);
  assert.equal(
    ids({
      productId: 'photolab',
      selectedEntityIds: ['gcp-1'],
      selectedEntityKinds: ['point'],
      selectedCanonicalEntityKinds: ['GroundControlPoint'],
      entityKind: 'GroundControlPoint',
    }).includes('photolab.gcp.images'),
    true,
  );
  assert.equal(
    ids({
      productId: 'photolab',
      selectedEntityIds: ['gcp-1', 'gcp-2'],
      selectedEntityKinds: ['point', 'point'],
      selectedCanonicalEntityKinds: ['GroundControlPoint', 'GroundControlPoint'],
      entityKind: 'GroundControlPoint',
    }).includes('photolab.gcp.images'),
    false,
  );
  assert.equal(
    ids({
      productId: 'photolab',
      selectedEntityIds: ['image-1', 'surface-1'],
      selectedEntityKinds: ['other', 'mesh'],
      selectedCanonicalEntityKinds: ['CameraImage', 'Mesh'],
      entityKind: 'CameraImage',
    }).includes('photolab.images.remove'),
    false,
  );
});

void test('UIP-D13 quick surface has the exact ordered, capped, selection-sensitive rows', () => {
  const entries = commandsForSurface(
    'quickSurface',
    base({ selectedEntityIds: ['a'], selectedEntityKinds: ['point'], clipboardAdmissible: true }),
  );
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [
      'view.frame',
      'view.preset.top',
      'view.preset.front',
      'view.preset.right',
      'view.preset.isometric',
      'select.clear',
      'edit.clipboard.paste_in_place',
    ],
  );
  assert.equal(entries.length, QUICK_SURFACE_ENTRY_CAP);
  assert.deepEqual(
    commandsForSurface('quickSurface', base()).map((entry) => entry.id),
    [
      'view.frame',
      'view.preset.top',
      'view.preset.front',
      'view.preset.right',
      'view.preset.isometric',
    ],
  );
});

void test('console help and completion are derived exactly from the table', async () => {
  const result = await executeConsoleLine('help', base(), () => undefined);
  assert.equal(result.kind, 'help');
  if (result.kind === 'help') {
    assert.deepEqual(
      result.lines.map((line) => line.split(/\s/)[0]),
      consoleHelpEntries().map((entry) => entry.id),
    );
  }
  assert.deepEqual(completeConsoleCommand('view.preset.'), [
    'view.preset.perspective',
    'view.preset.top',
    'view.preset.front',
    'view.preset.right',
    'view.preset.isometric',
  ]);
});

void test('shortcut dispatcher and three automation commands round-trip through registry entries', async () => {
  const calls: CommandInvocation[] = [];
  const execute = (invocation: CommandInvocation): void => {
    calls.push(invocation);
  };
  let prevented = false;
  assert.equal(
    dispatchRegistryShortcut(
      {
        key: 'f',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault: () => {
          prevented = true;
        },
      },
      base(),
      execute,
    ),
    true,
  );
  assert.equal(prevented, true);
  await executeAutomationCommand('view.frame', {}, base(), execute);
  await executeAutomationCommand(
    'select.clear',
    {},
    base({ selectedEntityIds: ['a'], selectedEntityKinds: ['point'] }),
    execute,
  );
  await executeAutomationCommand('view.preset.top', {}, base(), execute);
  assert.deepEqual(
    calls.map((call) => call.id),
    ['view.frame', 'view.frame', 'select.clear', 'view.preset.top'],
  );
});
