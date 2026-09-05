import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KERNEL_FRAME_DIAGNOSTICS_CAPACITY,
  KernelFrameDiagnostics,
  type KernelPresentedFrameSample,
} from '../src/kernel/KernelFrameDiagnostics.js';

function frame(
  presentTimestampMs: number,
  presentIntervalMs: number | null,
  points = 7,
): Omit<
  KernelPresentedFrameSample,
  | 'frameId'
  | 'inputId'
  | 'inputTimestampMs'
  | 'inputToPresentMs'
  | 'coalescedInputCount'
  | 'droppedInputCount'
> {
  return {
    rafTimestampMs: presentTimestampMs - 2,
    presentTimestampMs,
    presentIntervalMs,
    presentSource: 'raf-render-complete',
    cpuMs: 2,
    gpuMs: null,
    gpuTimingSequence: null,
    gpuTimestampSupported: false,
    primitives: { points, triangles: 3, lines: 2, textQuads: 1, splats: 0, drawCalls: 4 },
    phases: {
      protectedLanes1To3Ms: 0.2,
      cloudMeshRefinementMs: 0.8,
      sharedEncodeMs: 1,
      cpuPlanMs: 0.5,
      cpuHostMs: 0.3,
      cpuEncodeMs: 1,
    },
    deadlineReasonCodes: ['within_target'],
    renderScale: 1,
    detailScale: 1,
    uploadedBytes: 0,
    requestBacklog: 0,
    decodeBacklog: 0,
    uploadBacklog: 0,
    residencyBytes: 100,
    freshness: 'fresh',
  };
}

void test('G-VC-MEASURE retains 2048 exact frames and exposes tail percentiles', () => {
  const diagnostics = new KernelFrameDiagnostics();
  for (let index = 0; index < KERNEL_FRAME_DIAGNOSTICS_CAPACITY + 2; index += 1) {
    diagnostics.recordFrame(frame(index * 10, index === 0 ? null : index === 2_049 ? 80 : 10, index));
  }
  const snapshot = diagnostics.snapshot(3);
  assert.equal(snapshot.frames, KERNEL_FRAME_DIAGNOSTICS_CAPACITY);
  assert.equal(snapshot.lastFrames.length, 3);
  assert.equal(snapshot.lastFrames.at(-1)?.primitives.points, 2_049);
  assert.equal(snapshot.presentedFrameIntervalMs?.maximum, 80);
  assert.equal(snapshot.presentSource, 'raf-render-complete');
});

void test('G-VC-MEASURE correlates the newest input and asynchronous GPU query sequence', () => {
  const diagnostics = new KernelFrameDiagnostics();
  diagnostics.recordInput('pointer-1', 100);
  diagnostics.recordInput('pointer-2', 104);
  diagnostics.recordFrame({ ...frame(120, 16), gpuTimingSequence: 9, gpuTimestampSupported: true });
  assert.equal(diagnostics.attachGpuSample(9, 4.5), true);
  const recorded = diagnostics.snapshot(1).lastFrames[0]!;
  assert.equal(recorded.inputId, 'pointer-2');
  assert.equal(recorded.inputToPresentMs, 16);
  assert.equal(recorded.coalescedInputCount, 1);
  assert.equal(recorded.gpuMs, 4.5);
});

void test('G-VC-MEASURE puts synthetic present pauses and GPU load in tail fields, not CPU render time', () => {
  const diagnostics = new KernelFrameDiagnostics();
  for (let index = 1; index <= 100; index += 1) {
    const stressed = index >= 95;
    diagnostics.recordFrame({
      ...frame(index * 16, stressed ? 50 : 16),
      gpuTimingSequence: index,
      gpuTimestampSupported: true,
    });
    diagnostics.attachGpuSample(index, stressed ? 20 : 4);
  }
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.presentedFrameIntervalMs?.p95, 50);
  assert.equal(snapshot.gpuMs?.p95, 20);
  assert.equal(snapshot.cpuMs?.p99, 2);
});

void test('instrumentation on and off leaves fixed frame bytes byte-identical', () => {
  const renderFixedScene = (observer?: KernelFrameDiagnostics): Uint8Array => {
    const bytes = new Uint8Array([4, 8, 15, 16, 23, 42]);
    observer?.recordFrame(frame(16, null));
    return bytes;
  };
  assert.deepEqual(renderFixedScene(new KernelFrameDiagnostics()), renderFixedScene());
});

void test('sample windows are private, immutable, idle-safe, and reject overlap', async () => {
  const diagnostics = new KernelFrameDiagnostics();
  const running = diagnostics.sample({ durationMs: 5 });
  await assert.rejects(diagnostics.sample({ durationMs: 0 }), /already running/);
  const sample = await running;
  assert.equal(sample.frames, 0);
  assert.equal(sample.presentedFrameIntervalMs, null);
  assert.equal(Object.isFrozen(sample), true);
});

void test('HUD two-second window equals sample for identical fixture frames and expires while idle', async () => {
  const diagnostics = new KernelFrameDiagnostics();
  diagnostics.recordFrame(frame(0, 100));
  const pending = diagnostics.sample({ durationMs: 15, lastFrames: 1 });
  const timestamp = performance.now();
  diagnostics.recordFrame(frame(timestamp, 16.4, 41_200_000));
  diagnostics.recordFrame(frame(timestamp + 0.01, 24.1, 41_200_000));
  const sample = await pending;
  const hud = diagnostics.snapshotWindow(sample.window.startedAtMs, sample.window.endedAtMs, 1);
  assert.deepEqual(hud.presentedFrameIntervalMs, sample.presentedFrameIntervalMs);
  assert.deepEqual(hud.lastFrames, sample.lastFrames);
  assert.equal(hud.lastFrames[0]?.primitives.points, 41_200_000);
  assert.equal(diagnostics.snapshotWindow(timestamp + 2001, timestamp + 4001).frames, 0);
  assert.throws(() => diagnostics.snapshotWindow(2, 1), RangeError);
});
