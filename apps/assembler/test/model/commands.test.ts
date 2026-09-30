import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMANDS,
  KERNEL_LOADING_REASON,
  MATCH_TIER,
  matchScore,
  resolveAdaptive,
  searchCommands,
} from '../../renderer/src/foundation/commands/registry.js';

import { createDemoDocument } from '../../renderer/src/foundation/commands/demoDocument.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
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

void test('adaptive toolbar: a planar face suggests Offset Face first, then Extrude (Shapr3D face rule)', async () => {
  await freshStoreWithDemoDoc();
  useAssemblerStore.getState().select({ kind: 'face', ...planarFaceKey() });
  const ranked = resolveAdaptive(useAssemblerStore.getState()).map((c) => c.id);
  assert.equal(ranked[0], 'tools.offsetFace');
  assert.equal(ranked[1], 'tools.extrude');
  // Sketch tools are offered for the face (they start a sketch on it) but only New Sketch is recommended.
  assert.ok(ranked.includes('sketch.circle'));
  const recommended = resolveAdaptive(useAssemblerStore.getState())
    .filter((c) => c.availability(useAssemblerStore.getState()).recommended)
    .map((c) => c.id);
  assert.ok(!recommended.includes('sketch.circle'));
  assert.ok(recommended.includes('sketch.new'));
});

void test('adaptive toolbar lists only actions for the selection (no New/Open/view presets in More)', async () => {
  await freshStoreWithDemoDoc();
  const body = useAssemblerStore.getState().evaluation.bodies[0]!;
  useAssemblerStore.getState().select({ kind: 'body', bodyId: body.id });
  const ids = resolveAdaptive(useAssemblerStore.getState()).map((c) => c.id);
  for (const global of [
    'file.new',
    'file.open',
    'file.save',
    'view.front',
    'view.iso',
    'modes.measure',
    'sketch.newXY',
  ]) {
    assert.ok(!ids.includes(global), `${global} is not a selection action`);
  }
  for (const scoped of [
    'transform.moveRotate',
    'transform.delete',
    'view.zoomToSelection',
    'modes.isolate',
    'edit.hide',
  ]) {
    assert.ok(ids.includes(scoped), `${scoped} is a selection action`);
  }
});

void test('adaptive toolbar: an edge plus a face does not suggest Hole; two faces of one body do not suggest Align', async () => {
  await freshStoreWithDemoDoc();
  const body = useAssemblerStore.getState().evaluation.bodies[0]!;
  const faces = body.faces.filter((f) => f.surface === 'plane');
  useAssemblerStore
    .getState()
    .select({ kind: 'edge', bodyId: body.id, edgeKey: body.edges[0]!.key });
  useAssemblerStore.getState().select({ kind: 'face', ...planarFaceKey() }, { additive: true });
  const hole = resolveAdaptive(useAssemblerStore.getState()).find((c) => c.id === 'tools.hole');
  assert.ok(!hole || !hole.availability(useAssemblerStore.getState()).recommended);
  useAssemblerStore.getState().clearSelection();
  useAssemblerStore.getState().select({ kind: 'face', bodyId: body.id, faceKey: faces[0]!.key });
  useAssemblerStore
    .getState()
    .select({ kind: 'face', bodyId: body.id, faceKey: faces[1]!.key }, { additive: true });
  const align = COMMANDS.find((c) => c.id === 'transform.align')!;
  assert.notEqual(align.availability(useAssemblerStore.getState()).recommended, true);
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

void test('command search: "ext" ranks Extrude first when it is enabled', async () => {
  // With a planar face selected, Extrude is enabled and, per `searchCommands`'
  // documented ordering (enabled commands first, disabled commands always
  // ranked after with their reason), outranks the disabled-by-default file
  // commands ("Export…" is also a plausible "ext" match, but only once
  // there is something to export it, unlike Extrude, needs a selection).
  await freshStoreWithDemoDoc();
  useAssemblerStore.getState().select({ kind: 'face', ...planarFaceKey() });
  const results = searchCommands('ext', useAssemblerStore.getState());
  assert.equal(results[0]?.command.id, 'tools.extrude');
});

void test('command search: a typed name beats scattered letters, with or without a selection', async () => {
  await freshStoreWithDemoDoc();
  const state = useAssemblerStore.getState();
  // Nothing selected: Extrude still starts (tool before selection) and asks for its profile.
  const ext = searchCommands('ext', state);
  assert.equal(ext[0]?.command.id, 'tools.extrude');
  assert.equal(ext[0]?.enabled, true);
  assert.equal(searchCommands('mea', state)[0]?.command.id, 'modes.measure');
  assert.equal(searchCommands('fil', state)[0]?.command.id, 'tools.filletChamfer');
  assert.equal(searchCommands('rot', state)[0]?.command.id, 'transform.rotateAxis');
  assert.equal(searchCommands('mov', state)[0]?.command.id, 'transform.moveRotate');
  assert.equal(searchCommands('sec', state)[0]?.command.id, 'modes.section');
});

void test('command search: abbreviations ("p3" -> Pattern 3D, "nsxy" -> New Sketch on XY, "zts")', async () => {
  await freshStoreWithDemoDoc();
  const state = useAssemblerStore.getState();
  assert.equal(searchCommands('p3', state)[0]?.command.id, 'transform.pattern');
  assert.equal(searchCommands('nsxy', state)[0]?.command.id, 'sketch.newXY');
  assert.equal(searchCommands('zts', state)[0]?.command.id, 'view.zoomToSelection');
});

void test('command search with a selection lists the valid actions; strong name matches stay with their reason', async () => {
  await freshStoreWithDemoDoc();
  const body = useAssemblerStore.getState().evaluation.bodies[0]!;
  useAssemblerStore.getState().select({ kind: 'body', bodyId: body.id });
  const state = useAssemblerStore.getState();
  // Scattered-letter matches of disabled commands (e.g. Subtract needs two bodies) are dropped …
  const loose = searchCommands('sbt', state);
  assert.ok(loose.every((r) => r.enabled));
  // … but typing the name of a disabled tool keeps it, explaining why (Extrude cannot take a body).
  const extrude = searchCommands('extrude', state);
  assert.equal(extrude[0]?.command.id, 'tools.extrude');
  assert.equal(extrude[0]?.enabled, false);
  assert.match(extrude[0]?.reason ?? '', /sketch profile or a body face/);
});

void test('matchScore tiers: exact > prefix > word prefix > abbreviation > subsequence', () => {
  const tier = (q: string, t: string) => Math.floor((matchScore(q, t) ?? -1000) / 1000);
  assert.equal(tier('extrude', 'Extrude'), MATCH_TIER.exact);
  assert.equal(tier('ext', 'Extrude'), MATCH_TIER.prefix);
  assert.equal(tier('rot', 'Move/Rotate'), MATCH_TIER.wordPrefix);
  assert.equal(tier('p3', 'pattern 3d'), MATCH_TIER.abbreviation);
  assert.equal(tier('mv', 'Move/Rotate'), MATCH_TIER.subsequence);
  assert.equal(matchScore('xq', 'Extrude'), null);
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

void test('booleans: one body starts the tool asking for the tools; an unfitting selection explains', async () => {
  await freshStoreWithDemoDoc();
  const union = COMMANDS.find((c) => c.id === 'tools.union')!;
  const body = useAssemblerStore.getState().evaluation.bodies[0]!;
  // Tool before selection (UI-16): one body is the target, the pill asks for the tools.
  useAssemblerStore.getState().select({ kind: 'body', bodyId: body.id });
  assert.equal(union.availability(useAssemblerStore.getState()).enabled, true);
  // A sketch profile fits no step of a boolean: disabled, with the reason.
  const sketch = useAssemblerStore.getState().features.find((f) => f.kind === 'sketch')!;
  useAssemblerStore.getState().select({ kind: 'sketchProfile', featureId: sketch.id });
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
