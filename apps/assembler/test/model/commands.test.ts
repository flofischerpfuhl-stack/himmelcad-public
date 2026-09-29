import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMANDS,
  KERNEL_LOADING_REASON,
  resolveAdaptive,
  searchCommands,
} from '../../renderer/src/model/commands/registry.js';
import { createDemoDocument } from '../../renderer/src/model/document.js';
import { useAssemblerStore } from '../../renderer/src/model/store.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';

// Captured before any kernel is attached: the store starts in 'loading'.
const kernelStatusBeforeAttach = useAssemblerStore.getState().kernelStatus;
const loadingSnapshot = useAssemblerStore.getState();
useAssemblerStore.getState().attachKernel(createNodeKernelAdapter());

async function freshStoreWithDemoDoc() {
  useAssemblerStore.getState().loadDocument(createDemoDocument());
  await useAssemblerStore.getState().whenSettled();
  return useAssemblerStore.getState();
}

function planarFaceKey(): { bodyId: string; faceKey: string } {
  const body = useAssemblerStore.getState().evaluation.bodies[0]!;
  const face = body.faces.find((f) => f.surface === 'plane' && f.normal?.[2] === 1)!;
  return { bodyId: body.id, faceKey: face.key };
}

void test('adaptive toolbar recommends Extrude for a planar face selection', async () => {
  await freshStoreWithDemoDoc();
  useAssemblerStore.getState().select({ kind: 'face', ...planarFaceKey() });
  const ranked = resolveAdaptive(useAssemblerStore.getState());
  assert.equal(ranked[0]?.id, 'tools.extrude');
});

void test('Extrude is disabled for a curved face, with a reason', async () => {
  await freshStoreWithDemoDoc();
  const body = useAssemblerStore.getState().evaluation.bodies[0]!;
  const round = body.faces.find((f) => f.surface === 'cylinder')!;
  useAssemblerStore.getState().select({ kind: 'face', bodyId: body.id, faceKey: round.key });
  const extrude = COMMANDS.find((c) => c.id === 'tools.extrude')!;
  const availability = extrude.availability(useAssemblerStore.getState());
  assert.equal(availability.enabled, false);
  assert.equal(availability.reason, 'Only planar faces can be extruded.');
});

void test('adaptive toolbar recommends Extrude for a sketch profile selection', async () => {
  const state = await freshStoreWithDemoDoc();
  const sketch = state.evaluation.sketches[0]!;
  useAssemblerStore.getState().select({ kind: 'sketchProfile', featureId: sketch.featureId });
  const ranked = resolveAdaptive(useAssemblerStore.getState());
  assert.equal(ranked[0]?.id, 'tools.extrude');
});

void test('adaptive toolbar recommends Move/Rotate for a body selection', async () => {
  await freshStoreWithDemoDoc();
  const body = useAssemblerStore.getState().evaluation.bodies[0]!;
  useAssemblerStore.getState().select({ kind: 'body', bodyId: body.id });
  const ranked = resolveAdaptive(useAssemblerStore.getState());
  assert.equal(ranked[0]?.id, 'transform.moveRotate');
});

void test('adaptive toolbar recommends Fillet for an edge selection', async () => {
  await freshStoreWithDemoDoc();
  const body = useAssemblerStore.getState().evaluation.bodies[0]!;
  useAssemblerStore
    .getState()
    .select({ kind: 'edge', bodyId: body.id, edgeKey: body.edges[0]!.key });
  const ranked = resolveAdaptive(useAssemblerStore.getState());
  assert.equal(ranked[0]?.id, 'tools.filletChamfer');
});

void test('adaptive ordering does not depend on hover', async () => {
  await freshStoreWithDemoDoc();
  const body = useAssemblerStore.getState().evaluation.bodies[0]!;
  useAssemblerStore.getState().select({ kind: 'body', bodyId: body.id });
  const withoutHover = resolveAdaptive(useAssemblerStore.getState()).map((c) => c.id);
  useAssemblerStore.getState().setHover({ kind: 'face', ...planarFaceKey() });
  const withHover = resolveAdaptive(useAssemblerStore.getState()).map((c) => c.id);
  assert.deepEqual(withoutHover, withHover);
});

void test('command search: "ext" ranks Extrude first', async () => {
  await freshStoreWithDemoDoc();
  const results = searchCommands('ext', useAssemblerStore.getState());
  assert.equal(results[0]?.command.id, 'tools.extrude');
});

void test('command search: "mv" ranks Move/Rotate first', async () => {
  await freshStoreWithDemoDoc();
  const results = searchCommands('mv', useAssemblerStore.getState());
  assert.equal(results[0]?.command.id, 'transform.moveRotate');
});

void test('kernel commands are disabled while the kernel loads, with the loading reason', () => {
  assert.equal(kernelStatusBeforeAttach, 'loading');
  const kernelCommands = COMMANDS.filter(
    (c) => c.requiresKernel === true && c.id !== 'tools.revolve',
  );
  assert.ok(kernelCommands.length >= 6);
  for (const command of kernelCommands) {
    const availability = command.availability(loadingSnapshot);
    assert.equal(availability.enabled, false);
    assert.equal(availability.reason, KERNEL_LOADING_REASON);
  }
});

void test('booleans need two selected bodies once the kernel is ready', async () => {
  await freshStoreWithDemoDoc();
  const union = COMMANDS.find((c) => c.id === 'tools.union')!;
  const body = useAssemblerStore.getState().evaluation.bodies[0]!;
  useAssemblerStore.getState().select({ kind: 'body', bodyId: body.id });
  const availability = union.availability(useAssemblerStore.getState());
  assert.equal(availability.enabled, false);
  assert.match(availability.reason ?? '', /two or more bodies/);
});

void test('empty search query surfaces recent commands first', async () => {
  await freshStoreWithDemoDoc();
  useAssemblerStore.getState().pushRecentCommand('tools.extrude');
  const results = searchCommands('', useAssemblerStore.getState());
  assert.equal(results[0]?.command.id, 'tools.extrude');
});
