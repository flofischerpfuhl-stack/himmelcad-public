import assert from 'node:assert/strict';
import test from 'node:test';

import { PlatformGestureArbiter } from '../src/kernel/PlatformGestureArbiter.js';
import { KernelFrameDiagnostics } from '../src/kernel/KernelFrameDiagnostics.js';

interface Pick {
  readonly id: string;
}

void test('G-MI-GESTURE measurement claims LMB and cycles ambiguous exact picks with Up/Down', () => {
  const calls: string[] = [];
  const candidates = [{ id: 'front' }, { id: 'behind' }];
  const arbiter = new PlatformGestureArbiter<Pick>({
    candidateKey: (candidate) => candidate.id,
    isPickable: () => true,
    candidateSetChanged: (items, index) => calls.push(`indicator:${index + 1}/${items.length}`),
    cycleCandidate: (direction) => calls.push(`cycle:${direction}`),
  });
  arbiter.registerGestureClaims('measure.distance', [
    {
      row: 'lmbClick',
      handle: ({ candidate }) => calls.push(`anchor:${candidate?.id ?? 'none'}`),
    },
    { row: 'candidateCycle', handle: ({ direction }) => calls.push(`cycle:${direction}`) },
  ]);
  arbiter.setCandidateSet(candidates, 1);
  arbiter.handleKeyDown(keyEvent('ArrowDown'), candidates[0]!);
  arbiter.handleKeyDown(keyEvent('ArrowUp'), candidates[1]!);
  arbiter.handleClick(pointerEvent(), candidates[0]!);
  assert.deepEqual(calls, ['indicator:1/2', 'cycle:1', 'cycle:-1', 'anchor:front']);
});

void test('G-MI-CONTINUOUS V-01 fixture ring presents every cursor winner by the next frame', () => {
  const ring = new KernelFrameDiagnostics();
  for (let frameId = 1; frameId <= 120; frameId += 1) {
    const inputTimestamp = frameId * 16;
    ring.recordInput(`measurement-cursor-${frameId}`, inputTimestamp);
    ring.recordFrame({
      rafTimestampMs: inputTimestamp,
      presentTimestampMs: inputTimestamp + 16,
      presentIntervalMs: frameId === 1 ? null : 16,
      presentSource: 'raf-render-complete',
      cpuMs: 1,
      unattributedPresentWaitMs: 15,
      gpuMs: null,
      gpuTimingSequence: null,
      gpuTimestampSupported: false,
      primitives: { points: 1_000, triangles: 20, lines: 1, textQuads: 1, splats: 0, drawCalls: 4 },
      phases: {
        protectedLanes1To3Ms: 0.2,
        cloudMeshRefinementMs: 0.2,
        sharedEncodeMs: 0.3,
        cpuPlanMs: 0.2,
        cpuHostMs: 0.1,
        cpuEncodeMs: 0.3,
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
      residencyBytes: 1_024,
      freshness: 'fresh',
    });
  }
  const frames = ring.snapshot(120).lastFrames;
  assert.equal(frames.length, 120);
  assert.equal(
    frames.every((frame) => frame.inputToPresentMs === 16),
    true,
  );
  assert.equal(frames.at(-1)?.inputId, 'measurement-cursor-120');
});

function keyEvent(key: string): KeyboardEvent {
  return {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault() {},
    stopPropagation() {},
  } as KeyboardEvent;
}

function pointerEvent(): PointerEvent {
  return { button: 0, timeStamp: 1_000, pointerType: 'mouse', ctrlKey: false } as PointerEvent;
}
