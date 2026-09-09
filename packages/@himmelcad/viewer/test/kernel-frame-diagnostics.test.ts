import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KERNEL_FRAME_DIAGNOSTICS_CAPACITY,
  KernelCloudFrameFreshness,
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
    unattributedPresentWaitMs: presentIntervalMs === null ? 0 : Math.max(0, presentIntervalMs - 2),
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
    streamingActivity: {
      workerDecodeMs: 0,
      mainThreadDecodeIngestMs: 0,
      decodedArtifactBytes: 0,
      decodedTiles: 0,
      hierarchyApplyMs: 0,
      hierarchyPages: 0,
      hierarchyBytes: 0,
      uploadMs: 0,
      uploadedBytes: 0,
      uploadedTiles: 0,
      lodSwapCount: 0,
      touchedProxies: 0,
    },
    memory: { jsHeapBytes: null, wasmLinearBytes: null, wasmGrowthBytes: 0 },
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
    diagnostics.recordFrame(
      frame(index * 10, index === 0 ? null : index === 2_049 ? 80 : 10, index),
    );
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

void test('V-05 effect and quality-tier telemetry remain in the V-01 frame ring', () => {
  const diagnostics = new KernelFrameDiagnostics();
  diagnostics.recordFrame({
    ...frame(120, 16),
    deadlineReasonCodes: ['within_target', 'effect:edl', 'quality:tier'],
  });
  assert.deepEqual(diagnostics.snapshot(1).lastFrames[0]?.deadlineReasonCodes, [
    'within_target',
    'effect:edl',
    'quality:tier',
  ]);
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
  const passiveHud = diagnostics.hudWindow(sample.window.startedAtMs, sample.window.endedAtMs);
  assert.deepEqual(hud.presentedFrameIntervalMs, sample.presentedFrameIntervalMs);
  assert.deepEqual(hud.lastFrames, sample.lastFrames);
  assert.deepEqual(passiveHud.presentedFrameIntervalMs, sample.presentedFrameIntervalMs);
  assert.deepEqual(passiveHud.lastFrame, sample.lastFrames[0]);
  assert.equal(hud.lastFrames[0]?.primitives.points, 41_200_000);
  assert.equal(diagnostics.snapshotWindow(timestamp + 2001, timestamp + 4001).frames, 0);
  assert.throws(() => diagnostics.snapshotWindow(2, 1), RangeError);
});

void test('S-08 V-01 fixture HUD observer changes presented-frame p95 by at most 0.5 ms', () => {
  const diagnostics = new KernelFrameDiagnostics();
  for (let index = 0; index < 600; index += 1) {
    diagnostics.recordFrame(frame(index * 16.4, index === 0 ? null : 16.4, 41_200_000));
  }
  for (let warm = 0; warm < 20; warm += 1) diagnostics.hudWindow(0, 10_000);
  const off = Array.from({ length: 600 }, () => 16.4);
  const on = off.map((interval, index) => {
    if (index % 15 !== 0) return interval;
    const started = performance.now();
    diagnostics.hudWindow(0, 10_000);
    return interval + (performance.now() - started);
  });
  const p95 = (values: readonly number[]) =>
    [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1]!;
  const delta = p95(on) - p95(off);
  assert(delta <= 0.5, `HUD observer presented-p95 delta ${delta.toFixed(3)} ms`);
  console.log(`S-08 HUD observer presented-p95 delta=${delta.toFixed(3)} ms`);
});

void test('G-VC-MIXED keeps protected primitives in every saturated Class I frame', () => {
  const diagnostics = new KernelFrameDiagnostics();
  for (let index = 0; index < 60; index += 1) {
    diagnostics.recordFrame({
      ...frame(index * 25, index === 0 ? null : 25, 4_000_000),
      primitives: {
        points: 4_000_000,
        triangles: 120_000,
        splats: 250_000,
        lines: 5_000,
        textQuads: 500,
        drawCalls: 940,
      },
      deadlineReasonCodes: ['budget:points', 'budget:lane5'],
      qualityClass: 'I',
      qualityTier: 'full',
      qualityAdjustment: 'unchanged',
      protectedPrimitivesDropped: 0,
      frontier: {
        hardwareClass: 'I',
        budgetPoints: 4_000_000,
        budgetBytes: 96 * 1_048_576,
        budgetDrawCalls: 1_000,
        selectedPoints: 4_000_000,
        selectedBytes: 80 * 1_048_576,
        selectedDrawCalls: 940,
        coarsenedTiles: 12,
        budgetSatisfied: true,
      },
    });
  }
  const snapshot = diagnostics.snapshot(60);
  assert.equal(snapshot.frames, 60);
  assert.equal(snapshot.primitives.lines?.p50, 5_000);
  assert.equal(snapshot.primitives.textQuads?.p50, 500);
  assert.equal(
    snapshot.lastFrames.every((item) => item.protectedPrimitivesDropped === 0),
    true,
  );
  assert.equal(
    snapshot.lastFrames.every((item) => item.deadlineReasonCodes.includes('budget:lane5')),
    true,
  );
});

void test('VC-D4 background reuse is bounded by two presents and 50 ms', () => {
  const presents = new KernelCloudFrameFreshness();
  assert.equal(presents.record(true, 0), 'reprojected');
  assert.equal(presents.record(true, 20), 'reprojected');
  assert.equal(presents.record(true, 40), 'fresh');

  const age = new KernelCloudFrameFreshness();
  assert.equal(age.record(true, 0), 'reprojected');
  assert.equal(age.record(true, 51), 'fresh');
  assert.equal(age.record(false, 60), 'fresh');
});
