/**
 * The UI side of import/export (`interop/interopStore.ts`) on the real
 * kernel, without a DOM: dropped files by format, one History step per
 * import, Items folders, the DXF placement step, Mesh to Solid, honest
 * refusals (IGES, unsupported files, open meshes) and failed steps taken back.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installAssemblyFolderSync } from '../../renderer/src/modules/interop/importFolders.js';
import {
  setInteropKernel,
  useInteropStore,
} from '../../renderer/src/modules/interop/interopStore.js';
import { EMPTY_ITEMS_META, useItemsStore } from '../../renderer/src/foundation/commands/items.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { selectedOcctModule } from '../../headless/occtModule.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { interopFixture } from './fixtures.js';

const store = useAssemblerStore;
const kernel = createNodeKernelAdapter();
store.getState().attachKernel(kernel);
setInteropKernel(kernel);
installAssemblyFolderSync(store);

async function reset(): Promise<void> {
  store.getState().loadDocument([], { projectName: 'UI' });
  useItemsStore.getState().setItemsMeta(EMPTY_ITEMS_META);
  useInteropStore.setState({ report: null, dxfPending: null, unitOffer: null, job: null });
  await store.getState().whenSettled();
}

function file(name: string, as = name): { name: string; bytes: Uint8Array } {
  return { name: as, bytes: interopFixture(name) };
}

void test('dropping a STEP assembly adds one step and files the parts into nested folders', async () => {
  await reset();
  await useInteropStore.getState().importFiles([file('robot-assembly.step')]);
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, 1);
  assert.equal(useInteropStore.getState().job, null);
  assert.equal(useInteropStore.getState().report, null);
  const items = useItemsStore.getState();
  assert.deepEqual(
    items.folders.map((f) => f.name),
    ['Robot', 'Arm', 'Arm (2)'],
  );
  assert.equal(store.getState().evaluation.bodies.length, 5);
  assert.equal(store.getState().selection.length, 5, 'the imported parts are selected');
});

void test('a broken STEP file is reported and its step taken back', async () => {
  await reset();
  await useInteropStore
    .getState()
    .importFiles([
      { name: 'broken.step', bytes: new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\n') },
    ]);
  const report = useInteropStore.getState().report;
  assert.equal(report?.tone, 'error');
  assert.match(report?.lines.join(' ') ?? '', /STEP/);
  assert.equal(store.getState().features.length, 0, 'nothing half-imported stays');
});

const himmelcad = selectedOcctModule() === 'himmelcad';

void test('IGES and unknown files are refused with the reason', async () => {
  await reset();
  await useInteropStore.getState().importFiles([{ name: 'part.igs', bytes: new Uint8Array(8) }]);
  await store.getState().whenSettled();
  // Default module: no IGES reader. HimmelCAD OCCT build: the reader runs, finds nothing, and
  // the failed step is taken back.
  assert.match(
    useInteropStore.getState().report?.lines[0] ?? '',
    himmelcad ? /IGES import failed/ : /IGES is not in this build/,
  );
  assert.equal(store.getState().features.length, 0, 'nothing half-imported stays');
  useInteropStore.getState().dismissReport();
  await useInteropStore.getState().importFiles([{ name: 'photo.png', bytes: new Uint8Array(8) }]);
  assert.match(useInteropStore.getState().report?.lines[0] ?? '', /Unsupported file type/);
});

void test('3MF and OBJ become reference meshes in folders; OBJ offers no silent rescale', async () => {
  await reset();
  await useInteropStore.getState().importFiles([file('parts.3mf'), file('bracket-groups.obj')]);
  const meshes = store.getState().referenceMeshes;
  assert.deepEqual(
    meshes.map((m) => [m.name, m.color ?? null]),
    [
      ['Cube', '#FF0000'],
      ['Pair', '#FF0000'],
      ['Wedge', '#33AA55'],
      ['base', null],
      ['pin', '#336699'],
    ],
  );
  const folders = useItemsStore.getState().folders.map((f) => f.name);
  assert.deepEqual(folders, ['parts', 'bracket-groups', 'Bracket']);
  // bracket-groups is 20 mm: millimetre-sized, no unit offer.
  assert.equal(useInteropStore.getState().unitOffer, null);
  assert.equal(store.getState().features.length, 0);
});

void test('a tiny unitless mesh gets the rescale offer; applying it scales all its meshes', async () => {
  await reset();
  const stl =
    'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 0.02 0 0\nvertex 0 0.02 0\nendloop\nendfacet\nendsolid t\n';
  await useInteropStore
    .getState()
    .importFiles([{ name: 'tiny.stl', bytes: new TextEncoder().encode(stl) }]);
  const offer = useInteropStore.getState().unitOffer;
  assert.deepEqual(offer && { hint: offer.hint, scale: offer.scaleToMm }, {
    hint: 'm',
    scale: 1000,
  });
  useInteropStore.getState().resolveUnitOffer(true);
  assert.deepEqual(store.getState().referenceMeshes[0]!.max, [20, 20, 0]);
});

void test('DXF: dropped → placement pending → one sketch step on the chosen plane', async () => {
  await reset();
  await useInteropStore.getState().importFiles([file('plate.dxf')]);
  const pending = useInteropStore.getState().dxfPending;
  assert.ok(pending);
  assert.equal(pending.face, null);
  useInteropStore
    .getState()
    .confirmDxf({ placement: 'plane', plane: 'YZ', offset: 2, connect: true, unitScale: 25.4 });
  await store.getState().whenSettled();
  const sketch = store.getState().features[0]!;
  assert.equal(sketch.kind, 'sketch');
  assert.deepEqual(sketch.kind === 'sketch' ? sketch.plane : null, {
    kind: 'plane',
    plane: 'YZ',
    offset: 2,
  });
  const xs =
    sketch.kind === 'sketch'
      ? sketch.entities.filter((e) => e.kind === 'point').map((p) => (p.kind === 'point' ? p.x : 0))
      : [];
  assert.ok(Math.max(...xs) > 80 * 25.4 - 1, 'the unit override scales the drawing');
});

void test('Mesh to Solid from the UI: step added, mesh hidden; an open mesh is refused and nothing added', async () => {
  await reset();
  await useInteropStore.getState().importFiles([file('l-bracket.stl')]);
  const mesh = store.getState().referenceMeshes[0]!;
  await useInteropStore.getState().convertMeshToSolid(mesh.id);
  assert.equal(store.getState().features[0]?.kind, 'meshSolid');
  assert.equal(store.getState().evaluation.bodies[0]?.faces.length, 8);
  assert.equal(store.getState().referenceMeshes[0]!.hidden, true);

  await reset();
  await useInteropStore.getState().importFiles([file('open-box.stl')]);
  await useInteropStore.getState().convertMeshToSolid(store.getState().referenceMeshes[0]!.id);
  assert.equal(store.getState().features.length, 0);
  assert.match(useInteropStore.getState().report?.lines[0] ?? '', /4 open edges/);
});

void test(
  'HimmelCAD OCCT build: a dropped IGES file becomes one Import step with solid bodies',
  { skip: !himmelcad && 'needs the HimmelCAD OCCT build (HIMMELCAD_OCCT=himmelcad)' },
  async () => {
    await reset();
    await useInteropStore.getState().importFiles([file('robot-assembly.step')]);
    await store.getState().whenSettled();
    const source = store.getState().evaluation.bodies;
    const bytes = await kernel.exportIges(store.getState().features);
    await reset();
    await useInteropStore.getState().importFiles([{ name: 'robot.igs', bytes }]);
    await store.getState().whenSettled();
    assert.equal(useInteropStore.getState().report, null, 'no error or warning report');
    assert.equal(store.getState().features.length, 1);
    const feature = store.getState().features[0]!;
    assert.equal(feature.kind === 'importStep' && feature.format, 'iges');
    const bodies = store.getState().evaluation.bodies;
    assert.equal(bodies.length, source.length);
    assert.ok(bodies.every((b) => b.valid));
    assert.equal(
      store.getState().selection.length,
      source.length,
      'the imported bodies are selected',
    );
  },
);
