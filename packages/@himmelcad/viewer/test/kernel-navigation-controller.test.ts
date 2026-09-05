import assert from 'node:assert/strict';
import test from 'node:test';

import { KernelCameraController } from '../src/kernel/KernelCameraController.js';
import {
  KernelNavigationController,
  nearestCandidateIndex,
  projectPickCandidateForViewMode,
} from '../src/kernel/KernelNavigationController.js';
import { SHARED_3D_TARGET_DEVIATIONS } from '../src/kernel/PlatformGestureArbiter.js';
import type { KernelPickCandidate, KernelWorldPoint } from '../src/kernel/WgpuKernelViewer.js';

void test('nearest cursor hit becomes the active candidate regardless of provider order', () => {
  const candidates = [
    candidate('far-pixel', { x: 1, y: 0, z: 0 }, 3, 0.1),
    candidate('deep', { x: 2, y: 0, z: 0 }, 1, 0.8),
    candidate('nearest', { x: 3, y: 0, z: 0 }, 1, 0.2),
  ];

  assert.equal(nearestCandidateIndex(candidates), 2);
  assert.equal(nearestCandidateIndex([]), -1);
});

void test('2D and 2.5D preserve one winner and differ only in acquired height', () => {
  const source = candidate('survey-point', { x: 500_001, y: 5_400_002, z: 137.25 }, 2, 0.3);

  const twoD = projectPickCandidateForViewMode(source, '2d');
  const twoPointFiveD = projectPickCandidateForViewMode(source, '2.5d');

  assert.strictEqual(twoPointFiveD, source);
  assert.deepEqual(twoD.address, source.address);
  assert.equal(twoD.snapKind, source.snapKind);
  assert.deepEqual(twoD.presentationPosition, source.presentationPosition);
  assert.deepEqual(twoD.worldPosition, { x: 500_001, y: 5_400_002, z: null });
  assert.deepEqual(twoPointFiveD.worldPosition, source.worldPosition);
});

void test('2.5D never invents height for a plan-only unknown-height entity', () => {
  const source = candidate('unplaced-ortho', { x: 7, y: 8, z: 0 }, 0, 0.1);
  const controller = Object.create(
    KernelNavigationController.prototype,
  ) as unknown as NavigationHarness;
  Object.assign(controller, {
    disposed: false,
    enabled: true,
    candidates: [source],
    activeCandidateIndex: 0,
    viewMode: '2.5d',
    viewer: { entityHasKnownSourceHeight: () => false },
  });

  assert.deepEqual(controller.activeCandidate()?.worldPosition, { x: 7, y: 8, z: null });
});

void test('switching between plan acquisition modes never moves the camera', async () => {
  const camera = new KernelCameraController(1_280, 720);
  const published: ReturnType<KernelCameraController['worldCamera']>[] = [];
  const controller = Object.create(
    KernelNavigationController.prototype,
  ) as unknown as NavigationHarness;
  Object.assign(controller, navigationHarnessState(camera, published));

  await controller.setViewMode('2d', 0);
  const planCamera = camera.worldCamera();
  const publishCount = published.length;
  await controller.setViewMode('2.5d', 0);

  assert.deepEqual(camera.worldCamera(), planCamera);
  assert.equal(published.length, publishCount);
  assert.equal(controller.currentViewMode(), '2.5d');
});

void test('view-mode promise settles only after the camera morph endpoint is published', async () => {
  const camera = new KernelCameraController(1_280, 720);
  const published: ReturnType<KernelCameraController['worldCamera']>[] = [];
  const transitionFrames: number[] = [];
  const queued: FrameRequestCallback[] = [];
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    queued.push(callback);
    return queued.length;
  };
  try {
    const controller = Object.create(
      KernelNavigationController.prototype,
    ) as unknown as NavigationHarness;
    Object.assign(controller, {
      ...navigationHarnessState(camera, published),
      viewer: {
        setCameraTransition: (_from: unknown, _to: unknown, progress: number): void => {
          transitionFrames.push(progress);
        },
        setWorldCamera: (value: ReturnType<KernelCameraController['worldCamera']>): void => {
          published.push(value);
        },
      },
    });

    let settled = false;
    const transition = controller.setViewMode('2d', 100).then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(queued.length, 1);
    queued.shift()?.(performance.now() + 200);
    await transition;

    assert.equal(settled, true);
    assert.equal(transitionFrames.at(-1), 1);
    assert.equal(published.at(-1)?.projection.kind, 'orthographic');
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
});

void test('navigation camera adoption publishes the controller-normalized camera once', () => {
  const camera = new KernelCameraController(1_280, 720);
  const published: ReturnType<KernelCameraController['worldCamera']>[] = [];
  const controller = Object.create(
    KernelNavigationController.prototype,
  ) as unknown as NavigationHarness;
  Object.assign(controller, navigationHarnessState(camera, published));
  const source = camera.worldCamera();

  const adopted = controller.adoptWorldCamera({
    ...source,
    eye: { x: 120, y: -50, z: 75 },
    target: { x: 100, y: 0, z: 25 },
    projection: { ...source.projection, aspect: 0.1 },
  });

  assert.equal(adopted.projection.aspect, 16 / 9);
  assert.deepEqual(camera.worldCamera(), adopted);
  assert.deepEqual(published, [adopted]);
});

void test('explicit candidate cycling updates both active hit and the cursor/orbit coordinate', () => {
  const candidates = [
    candidate('first', { x: 1, y: 2, z: 3 }, 0, 0.1),
    candidate('second', { x: 4, y: 5, z: 6 }, 1, 0.2),
  ];
  const cursorEvents: KernelWorldPoint[] = [];
  const activeEvents: { id: string | null; index: number; count: number }[] = [];
  const controller = Object.create(
    KernelNavigationController.prototype,
  ) as unknown as NavigationHarness;
  Object.assign(controller, {
    disposed: false,
    viewMode: '3d',
    viewer: { entityHasKnownSourceHeight: () => true },
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

void test('camera orbit, pan and wheel remain platform-owned while a tool is armed', () => {
  const camera = new KernelCameraController(1_280, 720);
  const canvas = new NavigationCanvas();
  const published: ReturnType<KernelCameraController['worldCamera']>[] = [];
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  try {
    const controller = new KernelNavigationController(
      canvas as unknown as HTMLCanvasElement,
      {
        setScopedClipVolume() {},
        setRasterAnalysisView: () => {
          throw new Error('not used');
        },
        clearRasterAnalysisView: () => false,
        setWorldCamera: (value) => published.push(value),
        setCameraTransition() {},
        pick: async () => ({ candidates: [], stale: false, generation: 1 }),
      },
      camera,
    );
    controller.gestures.registerGestureClaims('draw.point', [
      { row: 'lmbClick', handle: () => undefined },
      {
        row: 'lmbDrag',
        deviationReason: SHARED_3D_TARGET_DEVIATIONS.lmbDrag,
        admit: () => false,
        handle: () => assert.fail('off-handle drag must remain camera navigation'),
      },
    ]);
    const beforeOrbit = camera.worldCamera();
    canvas.dispatchEvent(pointerInput('pointerdown', 0, 100, 100, 1));
    canvas.dispatchEvent(pointerInput('pointermove', 0, 112, 106, 1));
    canvas.dispatchEvent(pointerInput('pointerup', 0, 112, 106, 1));
    assert.notDeepEqual(camera.worldCamera().eye, beforeOrbit.eye);

    const beforePan = camera.worldCamera();
    canvas.dispatchEvent(pointerInput('pointerdown', 2, 200, 200, 2));
    canvas.dispatchEvent(pointerInput('pointermove', 2, 215, 210, 2));
    canvas.dispatchEvent(pointerInput('pointerup', 2, 215, 210, 2));
    assert.notDeepEqual(camera.worldCamera().target, beforePan.target);

    const beforeWheel = camera.worldCamera();
    canvas.dispatchEvent(wheelInput(120, 300, 300));
    assert.notDeepEqual(camera.worldCamera().eye, beforeWheel.eye);
    assert.ok(published.length >= 4);
    controller.dispose();
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
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
  setViewMode(mode: '3d' | '2d' | '2.5d', durationMilliseconds?: number): Promise<void>;
  currentViewMode(): '3d' | '2d' | '2.5d';
  activeCandidate(): KernelPickCandidate | null;
  adoptWorldCamera(
    camera: ReturnType<KernelCameraController['worldCamera']>,
  ): ReturnType<KernelCameraController['worldCamera']>;
}

function navigationHarnessState(
  camera: KernelCameraController,
  published: ReturnType<KernelCameraController['worldCamera']>[],
): Record<string, unknown> {
  return {
    disposed: false,
    enabled: true,
    camera,
    viewer: {
      setWorldCamera: (value: ReturnType<KernelCameraController['worldCamera']>): void => {
        published.push(value);
      },
    },
    callbacks: {},
    transitionGeneration: 0,
    pendingTransition: null,
    transitionInteracting: false,
    reportedInteracting: false,
    pointerInteracting: false,
    wheelInteracting: false,
    localSectionDepthActive: false,
    viewMode: '3d',
    candidates: [],
    activeCandidateIndex: 0,
    cursorCoordinate: null,
    cursorPresentationPosition: null,
  };
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

class NavigationCanvas extends EventTarget {
  tabIndex = -1;
  private readonly captured = new Set<number>();

  focus(): void {}
  setPointerCapture(pointerId: number): void {
    this.captured.add(pointerId);
  }
  hasPointerCapture(pointerId: number): boolean {
    return this.captured.has(pointerId);
  }
  releasePointerCapture(pointerId: number): void {
    this.captured.delete(pointerId);
  }
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 1_280, height: 720 } as DOMRect;
  }
}

function pointerInput(
  type: string,
  button: number,
  clientX: number,
  clientY: number,
  pointerId: number,
): Event {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, {
    button,
    clientX,
    clientY,
    pointerId,
    pointerType: 'mouse',
    ctrlKey: false,
  });
  return event;
}

function wheelInput(deltaY: number, clientX: number, clientY: number): Event {
  const event = new Event('wheel', { cancelable: true });
  Object.assign(event, { deltaY, clientX, clientY });
  return event;
}
