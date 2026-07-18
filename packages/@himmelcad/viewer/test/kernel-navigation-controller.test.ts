import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KernelNavigationController,
  nearestCandidateIndex,
} from '../src/kernel/KernelNavigationController.js';
import { KernelCameraController } from '../src/kernel/KernelCameraController.js';
import type { KernelPickCandidate, KernelWorldPoint } from '../src/kernel/WgpuKernelViewer.js';

void test('nearest cursor hit becomes the active Tab origin regardless of provider order', () => {
  const candidates = [
    candidate('far-pixel', { x: 1, y: 0, z: 0 }, 3, 0.1),
    candidate('deep', { x: 2, y: 0, z: 0 }, 1, 0.8),
    candidate('nearest', { x: 3, y: 0, z: 0 }, 1, 0.2),
  ];

  assert.equal(nearestCandidateIndex(candidates), 2);
  assert.equal(nearestCandidateIndex([]), -1);
});

void test('Tab cycling updates both active hit and the cursor/orbit coordinate', () => {
  const candidates = [
    candidate('first', { x: 1, y: 2, z: 3 }, 0, 0.1),
    candidate('second', { x: 4, y: 5, z: 6 }, 1, 0.2),
  ];
  const cursorEvents: KernelWorldPoint[] = [];
  const activeEvents: Array<{ id: string | null; index: number; count: number }> = [];
  const controller = Object.create(
    KernelNavigationController.prototype,
  ) as unknown as NavigationHarness;
  Object.assign(controller, {
    disposed: false,
    candidates,
    activeCandidateIndex: 0,
    cursorCoordinate: candidates[0]?.worldPosition ?? null,
    callbacks: {
      onCursorCoordinate: (coordinate: KernelWorldPoint): void => {
        cursorEvents.push(coordinate);
      },
      onActivePick: (hit: KernelPickCandidate | null, index: number, count: number): void => {
        activeEvents.push({ id: hit?.address.entityId ?? null, index, count });
      },
    },
  });

  assert.equal(controller.cycleCandidate(1)?.address.entityId, 'second');
  assert.deepEqual(controller.cursorCoordinate, { x: 4, y: 5, z: 6 });
  assert.deepEqual(cursorEvents, [{ x: 4, y: 5, z: 6 }]);
  assert.deepEqual(activeEvents, [{ id: 'second', index: 1, count: 2 }]);

  assert.equal(controller.cycleCandidate(-1)?.address.entityId, 'first');
  assert.deepEqual(controller.cursorCoordinate, { x: 1, y: 2, z: 3 });
});

void test('navigation publishes local profile endpoints and the exact captured 3D return', () => {
  const camera = new KernelCameraController(1_280, 720);
  camera.frame({ x: 499_900, y: 5_399_900, z: 80 }, { x: 500_100, y: 5_400_100, z: 120 });
  camera.orbit(0.31, -0.18);
  const captured = camera.worldCamera();
  const published: ReturnType<KernelCameraController['worldCamera']>[] = [];
  const scopedClips: unknown[] = [];
  const controller = Object.create(
    KernelNavigationController.prototype,
  ) as unknown as NavigationHarness;
  Object.assign(controller, {
    disposed: false,
    camera,
    viewer: {
      setWorldCamera: (value: ReturnType<KernelCameraController['worldCamera']>): void => {
        published.push(value);
      },
      setScopedClipVolume: (_scope: string, volume: unknown): void => {
        scopedClips.push(volume);
      },
    },
    callbacks: {},
    transitionGeneration: 0,
    transitionInteracting: false,
    reportedInteracting: false,
    pointerInteracting: false,
    wheelInteracting: false,
    localSectionDepthActive: false,
  });

  assert.throws(
    () =>
      controller.setLocalSectionView({
        frame: {
          origin: { x: 500_000, y: 5_400_000, z: 100 },
          normal: { x: 1, y: 0, z: 0 },
          up: { x: 0, y: 0, z: 1 },
          verticalSpan: 60,
        },
        sectionDepth: { towardCamera: 0, awayFromCamera: 0 },
      }),
    RangeError,
  );
  assert.deepEqual(camera.worldCamera(), captured);
  assert.equal(scopedClips.length, 0);

  controller.setLocalSectionView(
    {
      frame: {
        origin: { x: 500_000, y: 5_400_000, z: 100 },
        normal: { x: Math.SQRT1_2, y: -Math.SQRT1_2, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        verticalSpan: 60,
      },
      sectionDepth: { towardCamera: 2, awayFromCamera: 18 },
    },
    0,
  );
  assert.equal(published.at(-1)?.projection.kind, 'orthographic');
  assert.equal(camera.isOrthographicView(), true);
  assert.equal((scopedClips.at(-1) as { id?: string } | null)?.id, 'kernel-local-section-depth');

  controller.clearLocalOrthographicFrame(0);
  assert.deepEqual(published.at(-1), captured);
  assert.equal(camera.isOrthographicView(), false);
  assert.equal(scopedClips.at(-1), null);

  controller.setLocalSectionView(
    {
      frame: {
        origin: { x: 500_000, y: 5_400_000, z: 100 },
        normal: { x: 1, y: 0, z: 0 },
        up: { x: 0, y: 0, z: 1 },
        verticalSpan: 40,
      },
      sectionDepth: { towardCamera: 1, awayFromCamera: 9 },
    },
    0,
  );
  controller.setPerspectiveViewpoint(
    {
      eye: { x: 500_030, y: 5_399_960, z: 120 },
      target: { x: 500_000, y: 5_400_000, z: 100 },
    },
    0,
  );
  assert.equal(scopedClips.at(-1), null);
  assert.equal(published.at(-1)?.projection.kind, 'perspective');
  assert.deepEqual(published.at(-1)?.target, { x: 500_000, y: 5_400_000, z: 100 });
});

void test('navigation enters and leaves kernel raster analysis without moving panorama station', () => {
  const camera = new KernelCameraController(1_280, 720);
  camera.frame({ x: 90, y: 190, z: 290 }, { x: 110, y: 210, z: 310 });
  const returnCamera = camera.worldCamera();
  const published: ReturnType<KernelCameraController['worldCamera']>[] = [];
  let cleared = 0;
  const controller = Object.create(
    KernelNavigationController.prototype,
  ) as unknown as NavigationHarness;
  Object.assign(controller, {
    disposed: false,
    camera,
    viewer: {
      setRasterAnalysisView: () => ({
        entityId: 'scan',
        versionHash: 'ab'.repeat(32),
        width: 8,
        height: 4,
        kind: 'panorama',
        eye: { x: 100, y: 200, z: 300 },
        target: { x: 100, y: 210, z: 300 },
        up: { x: 0, y: 0, z: 1 },
        verticalFovRadians: Math.PI / 2,
      }),
      clearRasterAnalysisView: (): boolean => {
        cleared += 1;
        return true;
      },
      setWorldCamera: (value: ReturnType<KernelCameraController['worldCamera']>): void => {
        published.push(value);
      },
    },
    callbacks: {},
    transitionGeneration: 0,
    transitionInteracting: false,
    reportedInteracting: false,
    pointerInteracting: false,
    wheelInteracting: false,
    localSectionDepthActive: false,
    rasterAnalysisKind: null,
  });

  const view = controller.setRasterAnalysisView('scan', 0);
  assert.equal(view.kind, 'panorama');
  assert.deepEqual(published.at(-1)?.eye, { x: 100, y: 200, z: 300 });
  camera.orbit(0.5, 0.2);
  assert.deepEqual(camera.worldCamera().eye, { x: 100, y: 200, z: 300 });

  controller.clearRasterAnalysisView(0);
  assert.equal(cleared, 1);
  assert.deepEqual(published.at(-1), returnCamera);
});

interface NavigationHarness {
  disposed: boolean;
  candidates: readonly KernelPickCandidate[];
  activeCandidateIndex: number;
  cursorCoordinate: KernelWorldPoint | null;
  callbacks: Record<string, unknown>;
  cycleCandidate(direction: 1 | -1): KernelPickCandidate | null;
  setLocalOrthographicFrame(
    frame: Parameters<KernelCameraController['setLocalOrthographicFrame']>[0],
    durationMilliseconds?: number,
  ): void;
  setLocalSectionView(
    view: Parameters<KernelNavigationController['setLocalSectionView']>[0],
    durationMilliseconds?: number,
  ): void;
  clearLocalOrthographicFrame(durationMilliseconds?: number): void;
  setPerspectiveViewpoint(
    viewpoint: Parameters<KernelCameraController['setPerspectiveViewpoint']>[0],
    durationMilliseconds?: number,
  ): void;
  setRasterAnalysisView(
    entityId: string,
    durationMilliseconds?: number,
  ): ReturnType<KernelNavigationController['setRasterAnalysisView']>;
  clearRasterAnalysisView(durationMilliseconds?: number): void;
}

function candidate(
  entityId: string,
  worldPosition: KernelWorldPoint,
  pixelDistance: number,
  depth: number,
): KernelPickCandidate {
  return {
    address: {
      entityId,
      renderProxyId: `${entityId}@1`,
      datasetId: null,
      tileId: null,
      primitiveId: 0,
    },
    worldPosition,
    presentationPosition: worldPosition,
    snapKind: 'point',
    pixelDistance,
    depth,
  };
}
