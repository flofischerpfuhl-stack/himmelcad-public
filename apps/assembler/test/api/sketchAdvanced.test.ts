/**
 * The advanced sketch commands of the agent API (`api/sketchAdvancedApi.ts`)
 * on the real solver and kernel: every command builds what the matching
 * sketch tool builds, re-solves, and commits one undo step; text regions
 * extrude; projections follow their source; references only measure.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../../renderer/src/api/errors.js';
import { AgentSession, HEADLESS_CAPABILITIES } from '../../renderer/src/api/session.js';
import type { SketchFeature } from '../../renderer/src/model/document.js';
import { useAssemblerStore } from '../../renderer/src/model/store.js';
import { setSketchSolverFactory } from '../../renderer/src/sketch/solverProvider.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { installNodeFonts } from '../sketch/nodeFont.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';

type Json = Record<string, unknown>;

const store = useAssemblerStore;
const kernel = createNodeKernelAdapter();
store.getState().attachKernel(kernel);
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));
installNodeFonts();
const session = new AgentSession({
  store,
  kernel,
  host: { server: 'headless', capabilities: HEADLESS_CAPABILITIES },
});

async function call<T = Json>(method: string, params: Json = {}): Promise<T> {
  return (await session.handle(method, params)) as T;
}

async function newSketch(plane = 'XY'): Promise<string> {
  store.getState().loadDocument([], { projectName: 'Test' });
  await store.getState().whenSettled();
  const created = await call('feature.create', { kind: 'sketch', params: { plane } });
  return created.featureId as string;
}

function sketchOf(id: string): SketchFeature {
  return store.getState().features.find((f) => f.id === id) as SketchFeature;
}

function close(a: number, b: number, tol: number, what = ''): void {
  assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≈ ${b}`);
}

void test('addSlot / addEllipse / addPolygon / addSpline build solvable, profile-forming geometry', async () => {
  const id = await newSketch();
  const slot = await call<{ regions: { area: number }[]; dof: number }>('sketch.addSlot', {
    featureId: id,
    start: [0, 0],
    end: [30, 0],
    width: 8,
  });
  close(slot.regions[0]!.area, 30 * 8 + Math.PI * 16, 1e-6, 'slot');
  const ellipse = await call<{ entityId: string; regions: { area: number }[] }>(
    'sketch.addEllipse',
    {
      featureId: id,
      center: [0, 40],
      majorRadius: 10,
      minorRadius: 4,
      angle: 30,
    },
  );
  assert.equal(sketchOf(id).entities.find((e) => e.id === ellipse.entityId)?.kind, 'ellipse');
  const polygon = await call<{ lineIds: string[] }>('sketch.addPolygon', {
    featureId: id,
    center: [60, 40],
    radius: 10,
    sides: 6,
    inscribed: false,
  });
  assert.equal(polygon.lineIds.length, 6);
  const spline = await call<{ entityId: string; handleIds: string[] }>('sketch.addSpline', {
    featureId: id,
    points: [
      [0, 80],
      [10, 90],
      [20, 80],
      [10, 70],
    ],
    closed: true,
  });
  assert.equal(spline.handleIds.length, 2);
  const regions = (await call<{ featureId: string; regions: unknown[] }[]>('sketches.list')).find(
    (s) => s.featureId === id,
  )!.regions;
  assert.equal(regions.length, 4, 'slot, ellipse, hexagon, closed spline');
  const areas = (regions as { area: number }[]).map((r) => r.area);
  assert.ok(
    areas.some((a) => Math.abs(a - Math.PI * 40) < 1e-6),
    'ellipse πab',
  );
  assert.ok(
    areas.some((a) => Math.abs(a - 2 * Math.sqrt(3) * 100) < 1e-6),
    'hexagon, apothem 10',
  );
});

void test('addText: glyph regions that extrude; missing characters are reported', async () => {
  const id = await newSketch();
  const text = await call<{ entityId: string; missingCharacters: string[]; regions: unknown[] }>(
    'sketch.addText',
    { featureId: id, text: 'HB', position: [0, 0], height: 10 },
  );
  assert.deepEqual(text.missingCharacters, []);
  assert.equal(text.regions.length, 2);
  await call('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: id }, distance: 2 },
  });
  const body = await call<{ valid: boolean; volume: number }>('body.get', {
    bodyId: store.getState().evaluation.bodies[0]!.id,
  });
  assert.equal(body.valid, true);
  assert.ok(body.volume > 0);
  await assert.rejects(
    call('sketch.addText', {
      featureId: id,
      text: 'x',
      position: [0, 0],
      height: 5,
      font: 'comic',
    }),
    (error) => error instanceof ApiError && error.code === 'invalidParams',
  );
});

void test('mirror, pattern and roundCorner; setReference turns a dimension into a measurement', async () => {
  const id = await newSketch();
  const rect = await call<{ shape: { entityIds: string[]; dimensions: Record<string, string> } }>(
    'sketch.addProfile',
    { featureId: id, profile: { kind: 'rectangle', x: 5, y: 0, width: 10, height: 10 } },
  );
  const axis = await call<{ lineIds: string[] }>('sketch.addPolyline', {
    featureId: id,
    points: [
      [0, -5],
      [0, 20],
    ],
    construction: true,
  });
  const lines = rect.shape.entityIds.filter((e) => e.startsWith('l'));
  const mirrored = await call<{ createdIds: string[]; regions: unknown[] }>('sketch.mirror', {
    featureId: id,
    ids: lines,
    axis: axis.lineIds[0],
  });
  assert.equal(mirrored.regions.length, 2);
  const circle = await call<{ shape: { entityIds: string[] } }>('sketch.addProfile', {
    featureId: id,
    profile: { kind: 'circle', cx: 40, cy: 0, radius: 2 },
  });
  const pattern = await call<{ createdIds: string[]; dof: number }>('sketch.pattern', {
    featureId: id,
    ids: [circle.shape.entityIds[1]],
    count: 4,
    direction: [0, 1],
    spacing: 8,
  });
  assert.equal(sketchOf(id).entities.filter((e) => e.kind === 'circle').length, 4, 'three copies');
  const corner = rect.shape.entityIds[2]!; // (15, 10)
  const rounded = await call<{ createdIds: string[] }>('sketch.roundCorner', {
    featureId: id,
    point: corner,
    size: 3,
  });
  assert.ok(
    rounded.createdIds.some((e) => sketchOf(id).entities.find((x) => x.id === e)?.kind === 'arc'),
  );
  const width = rect.shape.dimensions.width!;
  const ref = await call<{ reference: boolean; dof: number }>('sketch.setReference', {
    featureId: id,
    dimension: width,
  });
  assert.equal(ref.reference, true);
  assert.equal(sketchOf(id).dimensions.find((d) => d.name === width)!.driven, true);
  assert.equal(typeof pattern.dof, 'number');
});

void test('project: a face outline follows the source body', async () => {
  const id = await newSketch();
  await call('sketch.addProfile', {
    featureId: id,
    profile: { kind: 'rectangle', x: 0, y: 0, width: 12, height: 8 },
  });
  const box = await call<{ featureId: string }>('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: id }, distance: 5 },
  });
  const target = await call<{ featureId: string }>('feature.create', {
    kind: 'sketch',
    params: { plane: { kind: 'plane', plane: 'XY', offset: 10 } },
  });
  const bodyId = store.getState().evaluation.bodies[0]!.id;
  const projected = await call<{ entityIds: string[]; projectionId: string }>('sketch.project', {
    featureId: target.featureId,
    face: { bodyId, key: `${box.featureId}:end:0` },
    construction: false,
  });
  assert.equal(projected.entityIds.length, 4);
  const area = () =>
    store.getState().evaluation.sketches.find((s) => s.featureId === target.featureId)!.profiles[0]!
      .area;
  close(area(), 96, 1e-6);
  await call('sketch.setDimension', { featureId: id, dimension: 'd3', value: 20 });
  close(area(), 160, 1e-6, 'follows');
});
