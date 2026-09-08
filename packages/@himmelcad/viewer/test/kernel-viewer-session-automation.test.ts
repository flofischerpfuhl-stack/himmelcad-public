import assert from 'node:assert/strict';
import test from 'node:test';

import { KernelCameraController } from '../src/kernel/KernelCameraController.js';
import { KernelFrameDiagnostics } from '../src/kernel/KernelFrameDiagnostics.js';
import type { KernelViewMode } from '../src/kernel/KernelNavigationController.js';
import {
  KernelViewerSession,
  type KernelPresentedFrameOptions,
  type KernelPresentedFrameOutcome,
  type KernelQualitySnapshot,
} from '../src/kernel/KernelViewerSession.js';
import type { KernelWorldCamera } from '../src/kernel/WgpuKernelViewer.js';
import type {
  KernelRgbaCaptureRequest,
  KernelRgbaCaptureResult,
} from '../src/kernel/WgpuKernelViewer.js';

void test('session camera adoption keeps controller and render/streaming publication identical', () => {
  const camera = new KernelCameraController(1_600, 900);
  const published: KernelWorldCamera[] = [];
  let requestedFrames = 0;
  const session = sessionHarness({
    camera,
    viewerState: {
      setWorldCamera: (value: KernelWorldCamera): void => {
        published.push(value);
      },
    },
    options: {
      requestFrame: (): void => {
        requestedFrames += 1;
      },
    },
  });
  const source = camera.worldCamera();

  const adopted = session.adoptWorldCamera({
    ...source,
    eye: { x: 410, y: -220, z: 95 },
    target: { x: 400, y: -200, z: 75 },
    projection: { ...source.projection, aspect: 10, near: 0.5, far: 50_000 },
  });

  assert.deepEqual(camera.worldCamera(), adopted);
  assert.deepEqual(published, [adopted]);
  assert.equal(adopted.projection.aspect, 16 / 9);
  assert.equal(adopted.projection.near, 0.5);
  assert.equal(adopted.projection.far, 50_000);
  assert.equal(requestedFrames, 1);
});

void test('session camera adoption rolls the controller back when publication fails', () => {
  const camera = new KernelCameraController(1_200, 800);
  camera.frame({ x: -20, y: -10, z: 0 }, { x: 30, y: 40, z: 50 });
  const before = camera.worldCamera();
  const session = sessionHarness({
    camera,
    viewerState: {
      setWorldCamera: (): never => {
        throw new Error('GPU publication failed');
      },
    },
  });

  assert.throws(
    () =>
      session.adoptWorldCamera({
        ...before,
        eye: { x: 100, y: 200, z: 300 },
        target: { x: 110, y: 220, z: 250 },
      }),
    /GPU publication failed/,
  );
  assert.deepEqual(camera.worldCamera(), before);
});

void test('session view-mode promise waits for the navigation transition to settle', async () => {
  let releaseTransition = (): void => {
    assert.fail('transition resolver was not installed');
  };
  const committed: KernelViewMode[] = [];
  const session = sessionHarness({
    viewModeRequestGeneration: 0,
    navigationState: {
      setViewMode: (): Promise<KernelViewMode> =>
        new Promise<KernelViewMode>((resolve) => {
          releaseTransition = () => resolve('2d');
        }),
    },
    scene: {
      prepareViewMode: (): Promise<void> => Promise.resolve(),
      commitViewMode: (mode: KernelViewMode): void => {
        committed.push(mode);
      },
    },
  });

  let settled = false;
  const changed = session.setViewMode('2d', 180).then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(committed, [], 'semantic scene mode must not commit mid-blend');
  assert.equal(settled, false);

  releaseTransition();
  await changed;
  assert.deepEqual(committed, ['2d']);
  assert.equal(settled, true);
});

void test('next-presented-frame waiter requests work, resolves only from a presented outcome and aborts', async () => {
  let requestedFrames = 0;
  const session = sessionHarness({
    presentedFrameWaiters: new Set(),
    options: {
      requestFrame: (): void => {
        requestedFrames += 1;
      },
    },
  });
  const expected: KernelPresentedFrameOutcome = { status: 'presented', reconfigured: false };
  const pending = session.waitForNextPresentedFrame();

  assert.equal(requestedFrames, 1);
  session.resolvePresentedFrameWaiters(expected);
  assert.deepEqual(await pending, expected);

  const abort = new AbortController();
  const aborted = session.waitForNextPresentedFrame({ signal: abort.signal });
  const reason = new Error('automation request cancelled');
  abort.abort(reason);
  await assert.rejects(aborted, reason);
  assert.equal(session.presentedFrameWaiters.size, 0);
});

void test('session capture delegates to renderer readback and requests a mapping poll frame', async () => {
  let requestedFrames = 0;
  const expected: KernelRgbaCaptureResult = {
    width: 2,
    height: 1,
    rgba8: new Uint8Array(8),
    colorSpace: 'srgb',
    alphaMode: 'straight',
    includeUi: false,
    transparentBackground: false,
  };
  const session = sessionHarness({
    viewerState: {
      captureRgba: (): Promise<KernelRgbaCaptureResult> => Promise.resolve(expected),
    },
    options: {
      requestFrame: (): void => {
        requestedFrames += 1;
      },
    },
  });

  assert.equal(await session.captureRgba({ width: 2, height: 1 }), expected);
  assert.equal(requestedFrames, 1);
});

void test('view.quality.get seam reports the exact class, tier, tunables and effective lane caps', () => {
  const lane = { points: 100, bytes: 200, drawCalls: 3, uploadBytes: 40, decodeMs: 0.5 };
  const session = sessionHarness({
    frameDiagnosticsState: new KernelFrameDiagnostics(),
    lastQualityAdjustment: 'reduced',
    qualityState: { renderScale: 0.85, detailScale: 0.75, tier: 'balanced', budgetScale: 0.75 },
    policyState: {
      frame: { targetFrameMs: 20, traversalMs: 2, decodeMs: 3, uploadBytes: 1_000, newRequests: 4 },
      interaction: {
        frame: {
          targetFrameMs: 25,
          traversalMs: 1,
          decodeMs: 1.5,
          uploadBytes: 500,
          newRequests: 2,
        },
      },
      frontier: {
        hardwareClass: 'W',
        points: 8_000_000,
        bytes: 192 * 1_048_576,
        drawCalls: 2_000,
        backgroundLanes: { lane4: lane, lane5: lane, lane6: lane },
        motionBackgroundLanes: {
          lane4: lane,
          lane5: lane,
          lane6: { points: 0, bytes: 0, drawCalls: 0, uploadBytes: 0, decodeMs: 0 },
        },
      },
      governor: {
        enterLowerAfterFrames: 8,
        leaveLowerAfterFrames: 90,
        recoveryRatio: 0.75,
        adjustmentIntervalMs: 250,
      },
      motion: {
        restAfterMs: 250,
        refineWithinMs: 100,
        maximumReprojectedPresents: 2,
        maximumReprojectedMs: 50,
      },
    },
  });

  const quality = session.qualitySnapshot();
  assert.equal(quality.class, 'W');
  assert.equal(quality.tier, 'balanced');
  assert.equal(quality.targets.enterLowerAfterFrames, 8);
  assert.equal(quality.targets.leaveLowerAfterFrames, 90);
  assert.equal(quality.effectiveBudgets.points, 6_000_000);
  assert.equal(quality.effectiveBudgets.backgroundLanes?.lane5.uploadBytes, 30);
  assert.equal(quality.effectiveBudgets.motionBackgroundLanes?.lane6.points, 0);
  assert.deepEqual(quality.currentReasons, ['within_target']);
  assert.equal(quality.lastAdjustment, 'reduced');
  assert.equal(Object.isFrozen(quality), true);
});

interface SessionHarness {
  readonly camera: KernelCameraController;
  readonly presentedFrameWaiters: Set<unknown>;
  adoptWorldCamera(camera: KernelWorldCamera): KernelWorldCamera;
  setViewMode(mode: KernelViewMode, durationMilliseconds?: number): Promise<void>;
  waitForNextPresentedFrame(
    options?: KernelPresentedFrameOptions,
  ): Promise<KernelPresentedFrameOutcome>;
  captureRgba(request: KernelRgbaCaptureRequest): Promise<KernelRgbaCaptureResult>;
  qualitySnapshot(): KernelQualitySnapshot;
  resolvePresentedFrameWaiters(outcome: KernelPresentedFrameOutcome): void;
}

function sessionHarness(state: Record<string, unknown>): SessionHarness {
  const camera =
    state.camera instanceof KernelCameraController
      ? state.camera
      : new KernelCameraController(1_600, 900);
  const session = Object.create(KernelViewerSession.prototype) as unknown as SessionHarness;
  Object.assign(session, {
    disposed: false,
    recoveryReason: null,
    recovery: null,
    navigationState: null,
    viewModeRequestGeneration: 0,
    currentStreamingCamera: null,
    camera,
    scene: {},
    viewerState: {},
    options: {},
    presentedFrameWaiters: new Set(),
    ...state,
  });
  return session;
}
