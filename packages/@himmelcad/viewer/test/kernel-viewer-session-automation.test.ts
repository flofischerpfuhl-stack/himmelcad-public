import assert from 'node:assert/strict';
import test from 'node:test';

import { KernelCameraController } from '../src/kernel/KernelCameraController.js';
import type { KernelViewMode } from '../src/kernel/KernelNavigationController.js';
import {
  KernelViewerSession,
  type KernelPresentedFrameOptions,
  type KernelPresentedFrameOutcome,
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
      setViewMode: (): Promise<void> =>
        new Promise<void>((resolve) => {
          releaseTransition = resolve;
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
  assert.deepEqual(committed, ['2d']);
  assert.equal(settled, false);

  releaseTransition();
  await changed;
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

interface SessionHarness {
  readonly camera: KernelCameraController;
  readonly presentedFrameWaiters: Set<unknown>;
  adoptWorldCamera(camera: KernelWorldCamera): KernelWorldCamera;
  setViewMode(mode: KernelViewMode, durationMilliseconds?: number): Promise<void>;
  waitForNextPresentedFrame(
    options?: KernelPresentedFrameOptions,
  ): Promise<KernelPresentedFrameOutcome>;
  captureRgba(request: KernelRgbaCaptureRequest): Promise<KernelRgbaCaptureResult>;
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
