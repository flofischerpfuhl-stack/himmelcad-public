/**
 * Long kernel computations in the store: after `LONG_OPERATION_MS` the
 * running job becomes `kernelActivity` (progress + Cancel in the UI);
 * Cancel stops it (hard cancel = kernel restart), restores the last
 * computed state (the change stays available as Redo) or ends a tool
 * preview; kernel notices (crash recovery) reach `kernelNotice`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { QueuedKernelAdapter, type RunContext } from '../../renderer/src/kernel/adapter.js';
import {
  EMPTY_EVALUATION,
  type EvaluationRequest,
  type EvaluationResult,
} from '../../renderer/src/kernel/types.js';
import type { Feature, SketchFeature } from '../../renderer/src/model/document.js';
import { setLongOperationDelay, useAssemblerStore } from '../../renderer/src/model/store.js';
import { addRectangle } from '../../renderer/src/sketch/builders.js';
import { EMPTY_SKETCH } from '../../renderer/src/sketch/types.js';

/** A kernel whose jobs finish only when the test says so; results are tagged with the feature count. */
class ManualKernel extends QueuedKernelAdapter {
  runs: {
    request: EvaluationRequest;
    context: RunContext;
    finish: () => void;
    fail: (e: Error) => void;
  }[] = [];
  aborts = 0;

  constructor() {
    super();
    this.markReady();
  }

  markReady(notice?: string): void {
    this.setStatus({
      status: 'ready',
      message: 'CAD kernel ready',
      progress: null,
      loadMs: 1,
      ...(notice ? { notice } : {}),
    });
  }

  protected run(request: EvaluationRequest, context: RunContext): Promise<EvaluationResult> {
    return new Promise((resolve, reject) => {
      this.runs.push({
        request,
        context,
        finish: () => resolve(tagged(request.features)),
        fail: reject,
      });
    });
  }

  protected override abortRunning(): void {
    this.aborts += 1;
    this.runs.at(-1)?.fail(new Error('cancelled'));
    // A hard cancel restarts the kernel: loading, then ready again.
    this.setStatus({
      status: 'loading',
      message: 'Restarting CAD kernel…',
      progress: null,
      loadMs: null,
    });
    setTimeout(() => this.markReady(), 1);
  }
}

function tagged(features: Feature[]): EvaluationResult {
  return { ...EMPTY_EVALUATION, warnings: { tag: `${features.length} features` } };
}

function sketch(id: string, width: number): SketchFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    ...addRectangle(EMPTY_SKETCH, [0, 0], [width, 10], { position: true, size: true }).sketch,
  };
}

const store = useAssemblerStore;
const kernel = new ManualKernel();
store.getState().attachKernel(kernel);
setLongOperationDelay(20);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function finishRunning(): Promise<void> {
  await sleep(0);
  kernel.runs.at(-1)!.finish();
  await sleep(0);
}

void test('a document evaluation running longer than the delay shows up with progress; Cancel restores', async () => {
  store.getState().loadDocument([sketch('a', 10)]);
  await finishRunning(); // the demo document the store starts with
  await finishRunning();
  const loaded = store.getState().features;
  assert.equal(store.getState().evaluation.warnings.tag, '1 features');

  assert.ok(store.getState().commitDocumentChange([...loaded, sketch('b', 20)]));
  await sleep(0);
  assert.equal(store.getState().kernelActivity, null, 'not shown before the delay');
  kernel.runs.at(-1)!.context.progress({
    phase: 'model',
    done: 0,
    total: 1,
    featureId: 'b',
    featureName: 'Sketch b',
  });
  await sleep(40);
  const activity = store.getState().kernelActivity;
  assert.ok(activity, 'shown after the delay');
  assert.equal(activity.channel, 'document');
  assert.equal(activity.progress?.featureName, 'Sketch b');

  store.getState().cancelKernelWork();
  assert.equal(kernel.aborts, 1, 'hard cancel');
  assert.equal(store.getState().features, loaded, 'the last computed document is back');
  assert.equal(store.getState().history.canRedo, true, 'the cancelled change is available as Redo');
  assert.match(store.getState().kernelNotice ?? '', /Computation cancelled.*Redo/);
  assert.equal(store.getState().evaluation.warnings.tag, '1 features');
  assert.equal(store.getState().kernelActivity, null);
  await sleep(10);
  assert.equal(store.getState().kernelStatus, 'ready', 'the kernel came back');
  assert.equal(store.getState().evaluationPending, false);
  store.getState().dismissKernelNotice();
  assert.equal(store.getState().kernelNotice, null);
});

void test('a short evaluation never shows activity', async () => {
  assert.ok(store.getState().commitDocumentChange([...store.getState().features, sketch('c', 5)]));
  await finishRunning();
  await sleep(40);
  assert.equal(store.getState().kernelActivity, null);
});

void test('cancelling a long tool preview ends the tool', async () => {
  store.getState().beginExtrude({ kind: 'sketch', featureId: 'a' });
  store.getState().setDistance(5);
  await sleep(40);
  const activity = store.getState().kernelActivity;
  assert.equal(activity?.channel, 'preview');
  store.getState().cancelKernelWork();
  assert.equal(store.getState().activeTool, null);
  await sleep(10);
  assert.equal(store.getState().kernelActivity, null);
});

void test('a kernel crash notice reaches the store', async () => {
  kernel.markReady('The CAD kernel stopped unexpectedly (boom) and was restarted.');
  assert.match(store.getState().kernelNotice ?? '', /stopped unexpectedly/);
});

void test('Cancel while the History is rolled back keeps the rolled-back steps and the bar', async () => {
  store.getState().loadDocument([sketch('r1', 10), sketch('r2', 20), sketch('r3', 30)]);
  await finishRunning();
  const loaded = store.getState().features;
  store.getState().setRollback('r2');
  await finishRunning();
  assert.equal(store.getState().evaluation.warnings.tag, '1 features', 'only r1 is evaluated');

  // A long edit above the bar, then Cancel: the full document (all three) comes back.
  const edited = [sketch('r1', 15), loaded[1]!, loaded[2]!];
  assert.ok(store.getState().commitDocumentChange(edited, { keepRollback: true }));
  await sleep(40);
  assert.ok(store.getState().kernelActivity);
  store.getState().cancelKernelWork();
  assert.equal(store.getState().features, loaded, 'no rolled-back step is lost');
  assert.equal(store.getState().rollbackBefore, 'r2');
  assert.equal(store.getState().history.canRedo, true);
  await sleep(10);

  // A long evaluation after moving the bar only (to a position never computed): Cancel moves it back.
  store.getState().setRollback('r3');
  await sleep(40);
  assert.ok(store.getState().kernelActivity);
  store.getState().cancelKernelWork();
  assert.equal(store.getState().features, loaded);
  assert.equal(store.getState().rollbackBefore, 'r2');
  assert.match(store.getState().kernelNotice ?? '', /rollback bar/);
  await sleep(10);
  assert.equal(store.getState().evaluation.warnings.tag, '1 features');
  store.getState().dismissKernelNotice();
});
