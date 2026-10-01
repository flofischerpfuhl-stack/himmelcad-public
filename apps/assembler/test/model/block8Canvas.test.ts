/**
 * Block 8, HIS-15 / IMP-06: reference images (canvas). Picture headers are
 * read without a DOM, calibration scales about the first point, image steps
 * are ordinary History steps (one undo step per insert/edit/calibration),
 * the pictures round-trip through the `.hcasm` file (only used ones are
 * written) and damaged files are refused.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from 'node:zlib';

import { ApiError } from '../../renderer/src/foundation/commands/api/errors.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { loadProjectFile } from '../../renderer/src/foundation/document/format.js';
import {
  HEADLESS_CAPABILITIES,
  AgentSession,
} from '../../renderer/src/interface/agent-api/session.js';
import { itemsRowKeyFor } from '../../renderer/src/interface/shell-ui/workspaceCommands.js';
import { insertImageFile, useCanvasStore } from '../../renderer/src/modules/canvas/canvasStore.js';
import { toBase64, useImageStore } from '../../renderer/src/modules/canvas/imageStore.js';
import {
  calibrateImage,
  imageCornersUv,
  imageHeight,
  onImage,
  sniffImage,
  type ReferenceImageFeature,
} from '../../renderer/src/modules/canvas/referenceImage.js';
import { findCommand } from '../../renderer/src/foundation/commands/registry.js';
import { nextGridPlane } from '../../renderer/src/modules/display/displayCommands.js';
import {
  viewDisplayFromProject,
  viewDisplayToProject,
} from '../../renderer/src/modules/display/viewDisplay.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';

type Json = Record<string, unknown>;

const store = useAssemblerStore;
const kernel = createNodeKernelAdapter();
store.getState().attachKernel(kernel);
const session = new AgentSession({
  store,
  kernel,
  host: { server: 'headless', capabilities: HEADLESS_CAPABILITIES },
});

async function call<T = Json>(method: string, params: Json = {}): Promise<T> {
  return (await session.handle(method, params)) as T;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const typeAndData = new Uint8Array(4 + data.length);
  typeAndData.set(new TextEncoder().encode(type), 0);
  typeAndData.set(data, 4);
  out.set(typeAndData, 4);
  view.setUint32(8 + data.length, crc32(typeAndData));
  return out;
}

/** A tiny valid PNG header + IEND (enough for the header sniffer; `seed` varies the content id). */
function png(width: number, height: number, seed = 0): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', new TextEncoder().encode(`seed\0${seed}`)),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** JPEG markers: SOI, APP0, SOF0 with the size. */
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x06,
    0x4a,
    0x46,
    0x49,
    0x46,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xd9,
  ]);
}

async function reset(): Promise<void> {
  store.getState().loadDocument([], { projectName: 'Canvas' });
  useImageStore.getState().replaceAll([]);
  await store.getState().whenSettled();
}

function images(): ReferenceImageFeature[] {
  return store
    .getState()
    .features.filter((f): f is ReferenceImageFeature => f.kind === 'referenceImage');
}

void test('canvas: picture headers are read without a DOM', () => {
  assert.deepEqual(sniffImage(png(640, 480)), { mime: 'image/png', width: 640, height: 480 });
  assert.deepEqual(sniffImage(jpeg(300, 200)), { mime: 'image/jpeg', width: 300, height: 200 });
  assert.equal(sniffImage(new TextEncoder().encode('GIF89a not supported')), null);
  assert.equal(sniffImage(png(0, 10)), null);
});

void test('canvas: calibration scales about the first point; corners follow rotation', () => {
  const feature = { center: [10, 0] as [number, number], width: 100 };
  const next = calibrateImage(feature, [0, 0], [20, 0], 40);
  assert.deepEqual(next, { center: [20, 0], width: 200 });
  assert.equal(calibrateImage(feature, [1, 1], [1, 1], 10), null);
  assert.equal(calibrateImage(feature, [0, 0], [1, 0], 0), null);
  const placed = {
    center: [0, 0] as [number, number],
    width: 40,
    rotation: 90,
    pixelWidth: 200,
    pixelHeight: 100,
  };
  assert.equal(imageHeight(placed), 20);
  const [bl] = imageCornersUv(placed);
  assert.ok(Math.abs(bl![0] - 10) < 1e-9 && Math.abs(bl![1] + 20) < 1e-9, `rotated corner ${bl}`);
  const full = {
    ...placed,
    id: 'x',
    name: 'x',
    suppressed: false,
    kind: 'referenceImage',
  } as never;
  assert.ok(onImage(full, [9, 19]));
  assert.ok(!onImage(full, [19, 9]));
});

void test('canvas: image.insert, feature.edit and image.calibrate are one undo step each', async () => {
  await reset();
  const inserted = await call<Json>('image.insert', {
    data: toBase64(png(400, 200)),
    fileName: 'plan.png',
    plane: { kind: 'plane', plane: 'XZ', offset: 5 },
    center: [10, 20],
  });
  assert.equal(inserted.width, 100);
  assert.equal(inserted.height, 50);
  const [image] = images();
  assert.ok(image);
  assert.equal(image.fileName, 'plan.png');
  assert.equal(image.opacity, 0.6);
  assert.deepEqual(image.plane, { kind: 'plane', plane: 'XZ', offset: 5 });
  assert.ok(useImageStore.getState().images.has(image.imageId));

  await call('feature.edit', { featureId: image.id, params: { opacity: 0.3, rotation: 15 } });
  assert.equal(images()[0]!.opacity, 0.3);
  // World points are projected onto the image plane (XZ: u = X, v = Z).
  const calibrated = await call<Json>('image.calibrate', {
    featureId: image.id,
    a: [10, 5, 20],
    b: [30, 5, 20],
    distance: 60,
  });
  assert.equal(calibrated.width, 300);
  assert.deepEqual(images()[0]!.center, [10, 20]);

  store.getState().undo();
  assert.equal(images()[0]!.width, 100);
  store.getState().undo();
  assert.equal(images()[0]!.opacity, 0.6);
  store.getState().undo();
  assert.equal(images().length, 0);
  store.getState().redo();
  assert.equal(images().length, 1);
  await store.getState().whenSettled();
  // No geometry: the step evaluates without a body.
  assert.equal(store.getState().evaluation.bodies.length, 0);
  assert.equal(store.getState().evaluation.errors[image.id] ?? null, null);
});

void test('canvas: refusals carry readable reasons', async () => {
  await reset();
  await assert.rejects(
    call('image.insert', {
      data: toBase64(new TextEncoder().encode('not a picture')),
      fileName: 'a.gif',
    }),
    (error: unknown) => error instanceof ApiError && /PNG and JPEG/.test(error.message),
  );
  await call('image.insert', { data: toBase64(jpeg(30, 60)), fileName: 'photo.jpg' });
  const [image] = images();
  assert.equal(image!.width, 50); // portrait: the longer side is 100 mm
  await assert.rejects(
    call('image.calibrate', { featureId: image!.id, a: [0, 0], b: [0, 0], distance: 10 }),
    (error: unknown) => error instanceof ApiError && error.code === 'invalidParams',
  );
});

void test('canvas: feature.create takes what the kind schema requires; the defaults fill the rest', async () => {
  await reset();
  // `fileName`, `rotation`, `opacity` and the plane's `offset` are optional in the published
  // schema (with defaults); the stored step has them all, so the file validator accepts it.
  const created = await call<{ featureId: string }>('feature.create', {
    kind: 'referenceImage',
    params: {
      imageId: 'img-1',
      pixelWidth: 40,
      pixelHeight: 20,
      plane: { kind: 'plane', plane: 'XZ' },
      center: [0, 0],
      width: 50,
    },
  });
  const [image] = images();
  assert.equal(image?.id, created.featureId);
  assert.deepEqual(
    [image!.fileName, image!.rotation, image!.opacity, image!.plane],
    ['image', 0, 0.6, { kind: 'plane', plane: 'XZ', offset: 0 }],
  );
});

void test('canvas: pictures round-trip through the project file; unused ones are not written', async () => {
  await reset();
  await call('image.insert', { data: toBase64(png(64, 64, 1)), fileName: 'keep.png' });
  await call('image.insert', { data: toBase64(png(64, 64, 2)), fileName: 'drop.png' });
  const [, drop] = images();
  store.getState().deleteFeature(drop!.id);
  const saved = await call<{ text: string }>('project.save');
  const file = JSON.parse(saved.text) as { images?: { id: string; mime: string; data: string }[] };
  assert.equal(file.images?.length, 1);
  assert.equal(file.images![0]!.id, images()[0]!.imageId);
  assert.equal(file.images![0]!.mime, 'image/png');

  useImageStore.getState().replaceAll([]);
  await call('project.open', { text: saved.text });
  const [opened] = images();
  assert.ok(opened);
  assert.ok(useImageStore.getState().images.has(opened.imageId), 'picture restored');

  // Damaged files are refused with a path.
  const bad = JSON.parse(saved.text) as Json;
  (bad.images as Json[])[0]!.mime = 'image/gif';
  assert.throws(() => loadProjectFile(JSON.stringify(bad)), /images\[0\]\.mime/);
  const badStep = JSON.parse(saved.text) as { features: Json[] };
  badStep.features[0]!.opacity = 3;
  assert.throws(() => loadProjectFile(JSON.stringify(badStep)), /opacity/);
});

void test('canvas: UI insertion, calibration and the Items row', async () => {
  await reset();
  assert.equal(await insertImageFile('ui.png', png(200, 100, 3)), null);
  const [image] = images();
  assert.ok(image);
  assert.deepEqual(store.getState().selection, [{ kind: 'feature', featureId: image.id }]);
  assert.equal(
    itemsRowKeyFor({ kind: 'feature', featureId: image.id }, store.getState().features),
    `image:${image.id}`,
  );
  assert.match(
    (await insertImageFile('x.bmp', new Uint8Array([0x42, 0x4d, 0, 0]))) ?? '',
    /PNG and JPEG/,
  );

  const canvas = useCanvasStore.getState();
  canvas.startCalibration(image.id);
  assert.equal(useCanvasStore.getState().applyCalibration(10), 'Pick two points first.');
  canvas.addCalibrationPoint([0, 0]);
  canvas.addCalibrationPoint([0, 25]);
  assert.equal(useCanvasStore.getState().applyCalibration(50), null);
  assert.equal(useCanvasStore.getState().calibration, null);
  assert.equal(images()[0]!.width, 200);
  store.getState().undo();
  assert.equal(images()[0]!.width, 100);
});

void test('grid plane (VIEW-06): XY → XZ → YZ, saved in the view state only when not XY', () => {
  assert.deepEqual(
    ['XY', 'XZ', 'YZ'].map((p) => nextGridPlane(p as 'XY')),
    ['XZ', 'YZ', 'XY'],
  );
  const state = store.getState();
  assert.equal(state.viewState.gridPlane, 'XY');
  assert.equal('gridPlane' in viewDisplayToProject(state.viewState).display, false);
  const command = findCommand('display.gridPlane')!;
  assert.match(command.label, /Grid Plane: XY \(next: XZ\)/);
  command.run(store.getState());
  assert.equal(store.getState().viewState.gridPlane, 'XZ');
  const saved = viewDisplayToProject(store.getState().viewState);
  assert.equal(saved.display.gridPlane, 'XZ');
  assert.equal(viewDisplayFromProject({ display: { gridPlane: 'YZ' } }).gridPlane, 'YZ');
  assert.equal(
    'gridPlane' in viewDisplayFromProject({ display: { gridPlane: 'AB' as never } }),
    false,
    'unknown planes are ignored',
  );
  store.getState().setGridVisible(false);
  assert.equal(findCommand('display.gridPlane')!.availability(store.getState()).enabled, false);
  store.getState().setGridVisible(true);
  store.getState().setGridPlane('XY');
});
