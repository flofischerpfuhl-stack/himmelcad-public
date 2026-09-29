import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMANDS,
  resolveAdaptive,
  searchCommands,
} from '../../renderer/src/model/commands/registry.js';
import { createDemoDocument } from '../../renderer/src/model/mockDocument.js';
import { useAssemblerStore } from '../../renderer/src/model/store.js';

function freshStoreWithDemoDoc() {
  useAssemblerStore.getState().loadDocument(createDemoDocument());
  return useAssemblerStore.getState();
}

void test('adaptive toolbar recommends Extrude for a face selection', () => {
  freshStoreWithDemoDoc();
  const body = useAssemblerStore.getState().evaluation.bodies[0]!;
  useAssemblerStore.getState().select({ kind: 'face', bodyId: body.id, side: '+Z' });

  const ranked = resolveAdaptive(useAssemblerStore.getState());
  assert.equal(ranked[0]?.id, 'tools.extrude');
});

void test('adaptive toolbar recommends Extrude for a sketch profile selection', () => {
  const state = freshStoreWithDemoDoc();
  const sketch = state.evaluation.sketches[0]!;
  useAssemblerStore.getState().select({ kind: 'sketchProfile', featureId: sketch.featureId });

  const ranked = resolveAdaptive(useAssemblerStore.getState());
  assert.equal(ranked[0]?.id, 'tools.extrude');
});

void test('adaptive toolbar recommends Move/Rotate for a body selection', () => {
  freshStoreWithDemoDoc();
  const body = useAssemblerStore.getState().evaluation.bodies[0]!;
  useAssemblerStore.getState().select({ kind: 'body', bodyId: body.id });

  const ranked = resolveAdaptive(useAssemblerStore.getState());
  assert.equal(ranked[0]?.id, 'transform.moveRotate');
});

void test('adaptive ordering does not depend on hover', () => {
  freshStoreWithDemoDoc();
  const body = useAssemblerStore.getState().evaluation.bodies[0]!;
  useAssemblerStore.getState().select({ kind: 'body', bodyId: body.id });
  const withoutHover = resolveAdaptive(useAssemblerStore.getState()).map((c) => c.id);

  useAssemblerStore.getState().setHover({ kind: 'face', bodyId: body.id, side: '+X' });
  const withHover = resolveAdaptive(useAssemblerStore.getState()).map((c) => c.id);

  assert.deepEqual(withoutHover, withHover);
});

void test('command search: "ext" ranks Extrude first', () => {
  freshStoreWithDemoDoc();
  const results = searchCommands('ext', useAssemblerStore.getState());
  assert.equal(results[0]?.command.id, 'tools.extrude');
});

void test('command search: "mv" ranks Move/Rotate first', () => {
  freshStoreWithDemoDoc();
  const results = searchCommands('mv', useAssemblerStore.getState());
  assert.equal(results[0]?.command.id, 'transform.moveRotate');
});

void test('kernel-only commands are always disabled with the Phase 1 reason', () => {
  freshStoreWithDemoDoc();
  const ctx = useAssemblerStore.getState();
  const kernelCommands = COMMANDS.filter((c) => c.requiresKernel === true);
  assert.ok(kernelCommands.length > 0);
  for (const command of kernelCommands) {
    const availability = command.availability(ctx);
    assert.equal(availability.enabled, false);
    assert.equal(availability.reason, 'Needs the CAD kernel (Phase 1)');
  }
});

void test('empty search query surfaces recent commands first', () => {
  freshStoreWithDemoDoc();
  useAssemblerStore.getState().pushRecentCommand('tools.extrude');
  const results = searchCommands('', useAssemblerStore.getState());
  assert.equal(results[0]?.command.id, 'tools.extrude');
});
