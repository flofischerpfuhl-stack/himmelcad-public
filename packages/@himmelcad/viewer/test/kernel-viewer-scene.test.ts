import assert from 'node:assert/strict';
import test from 'node:test';

import { KernelViewerScene } from '../src/kernel/KernelViewerScene.js';
import type { KernelStreamingDriver } from '../src/kernel/KernelStreamingDriver.js';
import type {
  KernelCanonicalRenderAdmission,
  WgpuKernelViewer,
} from '../src/kernel/WgpuKernelViewer.js';
import type { GeometryRepresentationBindingRef } from '../src/kernel/generated/index.js';

test('stable scene handle hides, shows and unloads through current exact bindings', () => {
  const calls: unknown[][] = [];
  const binding: GeometryRepresentationBindingRef = {
    key: {
      slot: { entityId: 'road-scan', representationSlot: 'primary' },
      entityRevision: 1,
      entityVersionHash: '11'.repeat(32),
      geometryRef: '22'.repeat(32),
    },
    generation: 4,
  };
  const viewer = {
    publishCanonicalRepresentations(admissions: readonly KernelCanonicalRenderAdmission[]) {
      calls.push(['load', admissions.length]);
      return { entities: 1, slots: 1, proxies: 1, generation: 1, bindings: [binding] };
    },
    canonicalEntityBindings(entityId: string) {
      calls.push(['bindings', entityId]);
      return [binding];
    },
    setEntityVisibility(entityId: string, visible: boolean) {
      calls.push(['visible', entityId, visible]);
      return 1;
    },
    detachCanonicalEntities(bindings: readonly GeometryRepresentationBindingRef[]) {
      calls.push(['unload', bindings]);
      return {
        entities: 0,
        slots: 0,
        proxies: 0,
        generation: 2,
        tombstones: [],
        retiredDatasetIds: ['road-scan-potree'],
      };
    },
  } as unknown as WgpuKernelViewer;
  const streaming = {
    detachDataset(datasetId: string) {
      calls.push(['detach', datasetId]);
    },
  } as unknown as KernelStreamingDriver;
  let frames = 0;
  const scene = new KernelViewerScene(viewer, streaming, () => (frames += 1));
  const admission = {
    admission: { entity: { id: 'road-scan' } },
    datasetId: 'road-scan-potree',
  } as unknown as KernelCanonicalRenderAdmission;

  const [handle] = scene.loadCanonical([admission]);
  assert.ok(handle);
  assert.equal(handle.datasetId, 'road-scan-potree');
  handle.setVisible(false);
  assert.equal(handle.visible, false);
  handle.setVisible(true);
  assert.equal(handle.visible, true);
  handle.unload();
  assert.equal(handle.loaded, false);
  assert.throws(() => handle.setVisible(true), /already unloaded/);
  assert.equal(frames, 4);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['load', 'visible', 'visible', 'bindings', 'unload', 'detach'],
  );
});

test('device recovery replays only live canonical entities and keeps handles bound to the new host', async () => {
  const oldCalls: unknown[][] = [];
  const newCalls: unknown[][] = [];
  const bindings = (entityId: string): readonly GeometryRepresentationBindingRef[] => [
    {
      key: {
        slot: { entityId, representationSlot: 'primary' },
        entityRevision: 1,
        entityVersionHash: '11'.repeat(32),
        geometryRef: '22'.repeat(32),
      },
      generation: 1,
    },
  ];
  const viewer = (calls: unknown[][]) =>
    ({
      publishCanonicalRepresentations(admissions: readonly KernelCanonicalRenderAdmission[]) {
        calls.push(['load', admissions.map((item) => item.admission.entity.id)]);
        return { entities: admissions.length, slots: admissions.length, proxies: 0, generation: 1 };
      },
      canonicalEntityBindings(entityId: string) {
        return bindings(entityId);
      },
      setEntityVisibility(entityId: string, visible: boolean) {
        calls.push(['visible', entityId, visible]);
        return 1;
      },
      detachCanonicalEntities() {
        calls.push(['unload']);
        return {
          entities: 1,
          slots: 1,
          proxies: 0,
          generation: 2,
          tombstones: [],
          retiredDatasetIds: [],
        };
      },
    }) as unknown as WgpuKernelViewer;
  const oldStreaming = { detachDataset(): void {} } as unknown as KernelStreamingDriver;
  const newStreaming = {} as KernelStreamingDriver;
  const scene = new KernelViewerScene(viewer(oldCalls), oldStreaming);
  const admissions = ['kept', 'retired'].map(
    (entityId) =>
      ({ admission: { entity: { id: entityId } } }) as unknown as KernelCanonicalRenderAdmission,
  );

  const [kept, retired] = scene.loadCanonical(admissions);
  assert.ok(kept);
  assert.ok(retired);
  kept.setVisible(false);
  retired.unload();
  await scene.recover(viewer(newCalls), newStreaming);

  assert.deepEqual(newCalls, [
    ['load', ['kept']],
    ['visible', 'kept', false],
  ]);
  kept.setVisible(true);
  assert.deepEqual(newCalls.at(-1), ['visible', 'kept', true]);
});
