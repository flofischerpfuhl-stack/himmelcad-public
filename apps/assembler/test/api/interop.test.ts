/**
 * Import/export through the agent API (real OCCT): STEP assemblies with
 * parts and folders, mesh imports into reference meshes and Items folders,
 * DXF into a sketch (one undo step) and back out, mesh → solid then fillet,
 * STEP export options and `interop.formats` (IGES reported as not in this
 * build).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ApiError } from '../../renderer/src/foundation/commands/api/errors.js';
import { AgentSession, HEADLESS_CAPABILITIES } from '../../renderer/src/api/session.js';
import {
  assemblyFilingPending,
  fileImportedAssemblies,
} from '../../renderer/src/interop/importFolders.js';
import { EMPTY_ITEMS_META, useItemsStore } from '../../renderer/src/model/items.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { parseStepStructure } from '../../renderer/src/foundation/geometry-kernel/step/stepStructure.js';
import { parseDxf } from '../../renderer/src/interop/dxf.js';
import { selectedOcctModule } from '../../headless/occtModule.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';
import { INTEROP_FIXTURES, interopFixture } from '../interop/fixtures.js';

type Json = Record<string, unknown>;

const store = useAssemblerStore;
const kernel = createNodeKernelAdapter();
store.getState().attachKernel(kernel);
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));
const session = new AgentSession({
  store,
  kernel,
  host: {
    server: 'headless',
    capabilities: HEADLESS_CAPABILITIES,
    readFile: async (path) => new Uint8Array(await readFile(path)),
  },
});

async function call<T = Json>(method: string, params: Json = {}): Promise<T> {
  return (await session.handle(method, params)) as T;
}

function b64(name: string): string {
  return Buffer.from(interopFixture(name)).toString('base64');
}

async function reset(): Promise<void> {
  store.getState().loadDocument([], { projectName: 'Interop' });
  useItemsStore.getState().setItemsMeta(EMPTY_ITEMS_META);
  await store.getState().whenSettled();
}

const himmelcad = selectedOcctModule() === 'himmelcad';
const needsHimmelcad = !himmelcad && 'needs the HimmelCAD OCCT build (HIMMELCAD_OCCT=himmelcad)';

void test('interop.formats lists what each format keeps and what the loaded OCCT build supports', async () => {
  await reset();
  const formats = await call<{ import: Json[]; export: Json[]; kernel: Json }>('interop.formats');
  const iges = formats.import.find((f) => f.format === 'iges')!;
  const igesOut = formats.export.find((f) => f.format === 'iges')!;
  const step = formats.import.find((f) => f.format === 'step')!;
  assert.equal(formats.kernel.stepXcafWrite, true);
  if (himmelcad) {
    assert.equal(iges.available, true);
    assert.equal(igesOut.available, true);
    assert.equal(formats.kernel.igesRead, true);
    assert.equal(formats.kernel.igesWrite, true);
    assert.equal(formats.kernel.stepXcafRead, true);
    assert.equal(step.reader, 'xcaf');
  } else {
    assert.equal(iges.available, false);
    assert.match(String(iges.reason), /IGES is not in this build/);
    assert.equal(igesOut.available, false);
    assert.equal(formats.kernel.igesRead, false);
    assert.equal(formats.kernel.stepXcafRead, false);
    assert.equal(step.reader, 'text');
  }
  assert.ok(formats.import.some((f) => f.format === 'dxf' && f.available === true));
});

void test('import.iges / export.iges are refused with "unsupported" on the replicad OCCT build', async (t) => {
  if (himmelcad) {
    t.skip('the HimmelCAD OCCT build supports IGES');
    return;
  }
  await reset();
  await assert.rejects(
    call('import.iges', { data: Buffer.from('x').toString('base64'), fileName: 'a.igs' }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === 'unsupported' &&
      /IGES is not in this build/.test(error.message),
  );
  await call('import.step', { path: `${INTEROP_FIXTURES}/robot-assembly.step` });
  await assert.rejects(
    call('export.iges', {}),
    (error: unknown) => error instanceof ApiError && error.code === 'unsupported',
  );
});

void test(
  'IGES round trip through the agent API: export.iges → import.iges gives the same solids',
  { skip: needsHimmelcad },
  async () => {
    await reset();
    await call('import.step', { path: `${INTEROP_FIXTURES}/robot-assembly.step` });
    const source = store.getState().evaluation.bodies;
    for (const mode of ['faces', 'brep'] as const) {
      const exported = await call<Json>('export.iges', { mode, unit: 'in' });
      assert.equal(exported.mediaType, 'model/iges');
      const text = Buffer.from(String(exported.data), 'base64').toString('latin1');
      assert.match(text, /,1\.,1,4HINCH,/, 'unit flag 1 (inch)');
      await reset();
      const imported = await call<Json>('import.iges', {
        data: exported.data,
        fileName: `robot-${mode}.igs`,
      });
      assert.equal(imported.committed, true);
      const bodies = store.getState().evaluation.bodies;
      assert.equal(bodies.length, source.length, `${mode}: one body per exported solid`);
      assert.equal(
        store.getState().evaluation.warnings[String(imported.featureId)],
        undefined,
        `${mode}: every shell closed into a solid`,
      );
      const volumes = (list: readonly { volume: number }[]) =>
        list.map((b) => b.volume).sort((a, b) => a - b);
      volumes(bodies).forEach((v, i) =>
        assert.ok(
          Math.abs(v - volumes(source)[i]!) < 1e-3 * Math.max(1, volumes(source)[i]!),
          `${mode}: volume ${v} vs ${volumes(source)[i]}`,
        ),
      );
      assert.ok(
        bodies.every((b) => b.valid),
        `${mode}: valid solids`,
      );
      assert.deepEqual((imported.parts as { name: string }[]).map((p) => p.name).slice(0, 2), [
        `robot-${mode} 1`,
        `robot-${mode} 2`,
      ]);
      // One Import step, undoable.
      assert.equal(store.getState().features.length, 1);
      await reset();
      await call('import.step', { path: `${INTEROP_FIXTURES}/robot-assembly.step` });
    }
  },
);

void test('import.step (path): one step, parts with names/colours/folders, filed once into Items', async () => {
  await reset();
  const result = await call<Json>('import.step', {
    path: `${INTEROP_FIXTURES}/robot-assembly.step`,
  });
  assert.equal(result.committed, true);
  assert.equal(store.getState().features.length, 1, 'one Import history step');
  const parts = result.parts as { name: string; color: string; itemPath: string[] }[];
  assert.deepEqual(
    parts.map((p) => `${p.itemPath.join('/')}/${p.name} ${p.color}`),
    [
      'Robot/Base plate #FF0000',
      'Robot/Arm/Link #0000FF',
      'Robot/Arm/Pin #33AA55',
      'Robot/Arm (2)/Link #0000FF',
      'Robot/Arm (2)/Pin #33AA55',
    ],
  );
  // The app files the parts when the evaluation arrives (installAssemblyFolderSync); here directly.
  const featureId = String(result.featureId);
  assert.equal(assemblyFilingPending(featureId), true);
  fileImportedAssemblies(store.getState().evaluation.bodies);
  assert.equal(assemblyFilingPending(featureId), false);
  const items = useItemsStore.getState();
  assert.deepEqual(
    items.folders.map((f) => f.name),
    ['Robot', 'Arm', 'Arm (2)'],
  );
  const robot = items.folders[0]!.id;
  assert.equal(items.parent[`folder:${items.folders[1]!.id}`], robot);
  assert.equal(items.parent[`body:${(result.createdBodyIds as string[])[0]}`], robot);
  // Filed once: moving a part out is not undone by a later evaluation.
  items.moveToFolder([`body:${(result.createdBodyIds as string[])[0]}`], null);
  fileImportedAssemblies(store.getState().evaluation.bodies);
  assert.equal(
    useItemsStore.getState().parent[`body:${(result.createdBodyIds as string[])[0]}`],
    undefined,
  );
  const bodies = await call<Json[]>('bodies.list');
  assert.deepEqual(bodies[1]!.itemPath, ['Robot', 'Arm']);
  // Undo removes the whole import in one step.
  await call('history.undo');
  assert.equal(store.getState().features.length, 0);
});

void test('import.step structure "single" keeps the pre-assembly behaviour (one body)', async () => {
  await reset();
  const result = await call<Json>('import.step', {
    data: b64('robot-assembly.step'),
    fileName: 'robot.step',
    structure: 'single',
  });
  assert.equal((result.createdBodyIds as string[]).length, 1);
});

void test('export.step: folders as sub-assemblies, AP214, inches, visible only', async () => {
  await reset();
  await call('import.step', { data: b64('robot-assembly.step'), fileName: 'robot-assembly.step' });
  fileImportedAssemblies(store.getState().evaluation.bodies);
  store.getState().hideBodies(['body:feature-import-1:4']);
  const out = await call<{ data: string; bodyIds: string[] }>('export.step', {
    structure: 'folders',
    schema: 'AP214',
    unit: 'in',
    visibleOnly: true,
  });
  assert.equal(out.bodyIds.length, 4, 'the hidden Pin is left out');
  const text = Buffer.from(out.data, 'base64').toString('latin1');
  assert.match(text, /AUTOMOTIVE_DESIGN/);
  assert.match(text, /CONVERSION_BASED_UNIT\('INCH'/);
  const structure = parseStepStructure(text);
  assert.equal(structure.roots[0]!.name, 'Interop');
  assert.equal(structure.roots[0]!.children[0]!.node.name, 'Robot');
  assert.deepEqual(
    structure.roots[0]!.children[0]!.node.children.map((c) => c.node.name),
    ['Arm', 'Arm (2)', 'Base plate'],
  );
});

void test('import.mesh: 3MF objects become coloured reference meshes filed in a folder', async () => {
  await reset();
  const result = await call<{ meshes: Json[]; declaredUnit: string; unitScale: number }>(
    'import.mesh',
    {
      data: b64('parts.3mf'),
      fileName: 'parts.3mf',
    },
  );
  assert.equal(result.declaredUnit, 'centimeter');
  assert.deepEqual(
    result.meshes.map((m) => [m.name, m.color, (m.folder as string[]).join('/')]),
    [
      ['Cube', '#FF0000', 'parts'],
      ['Pair', '#FF0000', 'parts'],
      ['Wedge', '#33AA55', 'parts'],
    ],
  );
  assert.equal(store.getState().referenceMeshes.length, 3);
  assert.equal(store.getState().features.length, 0, 'reference meshes are not History steps');
  const folder = useItemsStore.getState().folders[0]!;
  assert.equal(folder.name, 'parts');
  assert.equal(
    useItemsStore.getState().parent[`mesh:${String(result.meshes[0]!.meshId)}`],
    folder.id,
  );
  const bodies = await call<Json[]>('bodies.list');
  assert.equal(bodies.length, 0, 'reference meshes are not bodies');
});

void test('import.mesh: an unitless STL gets a unit hint; bad files fail with invalidParams', async () => {
  await reset();
  const stl =
    'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 0.01 0 0\nvertex 0 0.01 0\nendloop\nendfacet\nendsolid t\n';
  const result = await call<Json>('import.mesh', {
    data: Buffer.from(stl).toString('base64'),
    fileName: 'tiny.stl',
  });
  assert.deepEqual(result.unitHint, { hint: 'm', scaleToMm: 1000 });
  await assert.rejects(
    session.handle('import.mesh', {
      data: Buffer.from('nope').toString('base64'),
      fileName: 'x.obj',
    }),
    (error: unknown) => error instanceof ApiError && error.code === 'invalidParams',
  );
});

void test('import.dxf → one sketch step with profiles; export.dxf round-trips it', async () => {
  await reset();
  const result = await call<Json>('import.dxf', {
    data: b64('plate.dxf'),
    fileName: 'plate.dxf',
    plane: 'XZ',
    offset: 5,
  });
  assert.equal(result.committed, true);
  assert.equal(result.curves, 12);
  assert.equal(result.connected, 7);
  assert.ok((result.regions as number) >= 5);
  assert.deepEqual(result.skipped, { TEXT: 1 });
  // Every closed profile builds (the plate with a round and a D-shaped hole included).
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(store.getState().evaluation.warnings, {});
  assert.deepEqual(result.units, {
    scale: 1,
    source: 'file',
    label: 'millimetres (from the file)',
    fileUnit: 'millimetres',
  });
  const sketch = store.getState().features[0]!;
  assert.equal(sketch.kind, 'sketch');
  assert.deepEqual(sketch.kind === 'sketch' ? sketch.plane : null, {
    kind: 'plane',
    plane: 'XZ',
    offset: 5,
  });
  const out = await call<{ data: string; entities: number }>('export.dxf', {
    sketchId: sketch.id,
    version: 'R12',
  });
  assert.equal(out.entities, 12 + 1);
  const back = parseDxf(Buffer.from(out.data, 'base64').toString('utf8'));
  assert.equal(back.version, 'AC1009');
  assert.equal(back.entities.length, 13);
  await call('history.undo');
  assert.equal(store.getState().features.length, 0, 'the DXF import is one undo step');
});

void test('mesh.toSolid: L-bracket STL → body (mesh hidden) → fillet; export.dxf of its top face', async () => {
  await reset();
  const imported = await call<{ meshes: Json[] }>('import.mesh', {
    path: `${INTEROP_FIXTURES}/l-bracket.stl`,
  });
  const meshId = String(imported.meshes[0]!.meshId);
  const solid = await call<Json>('mesh.toSolid', { meshId });
  assert.equal(solid.committed, true);
  assert.deepEqual(
    { faces: (solid.check as Json).faces, triangles: (solid.check as Json).triangles },
    { faces: 8, triangles: 20 },
  );
  assert.equal(store.getState().referenceMeshes[0]!.hidden, true);
  const body = await call<Json>('body.get', { bodyId: solid.bodyId });
  assert.equal(body.faceCount, 8);
  assert.equal(body.volume, 6000);
  const edges = await call<Json[]>('edges.list', { bodyId: solid.bodyId, select: '|Z' });
  const outer = edges.find((e) => {
    const mid = e.midpoint as number[];
    return Math.abs(mid[0]! - 40) < 1e-6 && Math.abs(mid[1]!) < 1e-6;
  })!;
  const fillet = await call<Json>('feature.create', {
    kind: 'fillet',
    params: { edges: [{ bodyId: solid.bodyId, key: outer.key }], radius: 3 },
  });
  assert.equal(fillet.committed, true);
  const top = await call<Json[]>('faces.list', { bodyId: solid.bodyId, select: '>Z' });
  const dxf = await call<{ data: string; entities: number }>('export.dxf', {
    face: { bodyId: solid.bodyId, key: top[0]!.key },
  });
  const drawing = parseDxf(Buffer.from(dxf.data, 'base64').toString('utf8'));
  assert.equal(drawing.entities.filter((e) => e.kind === 'line').length, 6);
  assert.equal(
    drawing.entities.filter((e) => e.kind === 'arc').length,
    1,
    'the fillet shows as an arc',
  );
});

void test('mesh.toSolid refuses an open mesh with the reason (unsupported), nothing committed', async () => {
  await reset();
  const imported = await call<{ meshes: Json[] }>('import.mesh', {
    data: b64('open-box.stl'),
    fileName: 'open-box.stl',
  });
  await assert.rejects(
    session.handle('mesh.toSolid', { meshId: imported.meshes[0]!.meshId }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === 'unsupported' &&
      /4 open edges/.test(error.message),
  );
  assert.equal(store.getState().features.length, 0);
  assert.equal(store.getState().referenceMeshes[0]!.hidden, false);
});
