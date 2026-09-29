/**
 * The modelling-feature tools on the store with the real OCCT kernel:
 * commands start from the selection, live preview never touches the
 * document, Cancel restores exactly, Done is one undo step, picks/badges/
 * handles edit the draft, the Move/Rotate gizmo commits rotations and
 * copies, and an extrude of a profile inside a face starts as a Cut.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { findCommand, resolveAdaptive } from '../../renderer/src/model/commands/registry.js';
import { resolveShortcut } from '../../renderer/src/model/commands/shortcuts.js';
import type { ExtrudeFeature, Feature, SketchFeature } from '../../renderer/src/model/document.js';
import {
  acceptPick,
  draftBadges,
  draftHandles,
  type FeatureDraft,
} from '../../renderer/src/model/featureTools.js';
import { loadProjectFile, saveProjectFile } from '../../renderer/src/model/project/format.js';
import { useAssemblerStore, type ToolSession } from '../../renderer/src/model/store.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';

const store = useAssemblerStore;
store.getState().attachKernel(createNodeKernelAdapter());

function sketch(
  id: string,
  plane: SketchFeature['plane'],
  profiles: SketchFeature['profiles'],
): SketchFeature {
  return { id, name: id, suppressed: false, kind: 'sketch', plane, profiles };
}

function box(id: string, x: number, y: number, w: number, d: number, h: number): Feature[] {
  const extrude: ExtrudeFeature = {
    id,
    name: id,
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: `${id}-s` },
    distance: h,
    symmetric: false,
    operation: 'new',
  };
  return [
    sketch(`${id}-s`, { kind: 'plane', plane: 'XY', offset: 0 }, [
      { kind: 'rectangle', x, y, width: w, height: d },
    ]),
    extrude,
  ];
}

async function load(features: Feature[]) {
  store.getState().loadDocument(features);
  await store.getState().whenSettled();
  assert.deepEqual(store.getState().evaluation.errors, {});
}

function tool<K extends ToolSession['kind']>(kind: K): Extract<ToolSession, { kind: K }> {
  const active = store.getState().activeTool;
  assert.equal(active?.kind, kind);
  return active as Extract<ToolSession, { kind: K }>;
}

function draft<K extends FeatureDraft['kind']>(kind: K): Extract<FeatureDraft, { kind: K }> {
  const d = tool('feature').draft;
  assert.equal(d.kind, kind);
  return d as Extract<FeatureDraft, { kind: K }>;
}

function run(id: string) {
  const command = findCommand(id);
  assert.ok(command, id);
  const availability = command.availability(store.getState());
  assert.equal(availability.enabled, true, `${id}: ${availability.reason ?? ''}`);
  command.run(store.getState());
}

void test('revolve tool: V from a profile, auto axis and Cut into a shaft, preview, cancel, commit, undo', async () => {
  await load([
    sketch('s', { kind: 'plane', plane: 'XY', offset: 0 }, [
      { kind: 'circle', cx: 0, cy: 0, radius: 10 },
    ]),
    {
      id: 'shaft',
      name: 'Shaft',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 's' },
      distance: 40,
      symmetric: false,
      operation: 'new',
    },
    sketch('g', { kind: 'plane', plane: 'XZ', offset: 0 }, [
      { kind: 'rectangle', x: 7, y: 18, width: 5, height: 4 },
    ]),
  ]);
  const before = store.getState().features;
  store.getState().select({ kind: 'sketchProfile', featureId: 'g' });
  const command = resolveShortcut(
    {
      key: 'v',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      targetIsTextInput: false,
    },
    store.getState(),
  );
  assert.equal(command?.id, 'tools.revolve');
  command!.run(store.getState());
  const d = draft('revolve');
  assert.deepEqual(
    d.axis,
    { kind: 'world', axis: 'Z' },
    'the in-plane world axis that misses the profile',
  );
  assert.equal(d.angle, 360);
  assert.equal(d.operation, 'cut', 'profile mostly inside the shaft');
  await store.getState().whenSettled();
  const preview = tool('feature').previewEvaluation!;
  assert.ok(
    Math.abs(preview.bodies[0]!.volume - (Math.PI * 100 * 40 - Math.PI * (100 - 49) * 4)) < 1e-3,
  );
  assert.equal(store.getState().features, before, 'preview never touches the document');

  // The angle handle and its chip; a typed 90° re-previews.
  const [handle] = draftHandles(d, store.getState().evaluation);
  assert.equal(handle?.kind, 'angle');
  store.getState().updateFeatureDraft((current) => handle!.apply(current, 90));
  await store.getState().whenSettled();
  assert.equal(draft('revolve').angle, 90);
  store.getState().cancel();
  assert.equal(store.getState().activeTool, null);
  assert.equal(store.getState().features, before);
  assert.equal(store.getState().history.canUndo, false);

  run('tools.revolve');
  store.getState().commit();
  await store.getState().whenSettled();
  const added = store.getState().features.at(-1)!;
  assert.equal(added.kind, 'revolve');
  assert.equal(added.name, 'Revolve 1');
  assert.equal(store.getState().evaluation.errors[added.id], undefined);
  store.getState().undo();
  assert.equal(store.getState().features.length, before.length);
});

void test('revolve tool: picking an edge sets the axis; the axis badge picks a world axis; errors block Done', async () => {
  await load([
    ...box('b', 40, 0, 10, 10, 10),
    sketch('p', { kind: 'plane', plane: 'XZ', offset: 0 }, [
      { kind: 'rectangle', x: 20, y: 0, width: 10, height: 4 },
    ]),
  ]);
  store.getState().select({ kind: 'sketchProfile', featureId: 'p' });
  run('tools.revolve');
  assert.equal(draft('revolve').operation, 'new');
  const body = store.getState().evaluation.bodies[0]!;
  const edge = body.edges.find(
    (e) =>
      e.direction &&
      Math.abs(Math.abs(e.direction[2]) - 1) < 1e-9 &&
      Math.abs(e.midpoint[0] - 40) < 1e-9 &&
      Math.abs(e.midpoint[1]) < 1e-9,
  )!;
  store
    .getState()
    .updateFeatureDraft((d, ev) =>
      acceptPick(d, { kind: 'edge', bodyId: body.id, edgeKey: edge.key }, ev),
    );
  assert.equal(draft('revolve').axis?.kind, 'edge');
  await store.getState().whenSettled();
  const ring = tool('feature').previewEvaluation!.bodies.find((b) =>
    b.id.startsWith('body:__preview'),
  )!;
  assert.ok(Math.abs(ring.volume - Math.PI * (400 - 100) * 4) < 1e-3);

  // The Y axis is perpendicular to this XZ profile: the kernel error shows and blocks Done.
  const axisBadge = draftBadges(draft('revolve')).find((b) => b.ariaLabel === 'Revolve axis')!;
  store.getState().updateFeatureDraft((d, ev) => axisBadge.apply(d, 'Y', ev));
  await store.getState().whenSettled();
  assert.equal(
    tool('feature').previewError,
    'The revolve axis must not be perpendicular to the profile',
  );
  const count = store.getState().features.length;
  store.getState().commit();
  assert.equal(store.getState().activeTool?.kind, 'feature', 'Done is blocked while invalid');
  assert.equal(store.getState().features.length, count);
  store.getState().cancel();
});

void test('pattern, mirror, split, align tools: start from the selection, badges and handles, one undo step each', async () => {
  await load([...box('a', 0, 0, 10, 10, 10), ...box('c', 30, 0, 20, 20, 20)]);
  const a = store.getState().evaluation.bodies[0]!;
  const c = store.getState().evaluation.bodies[1]!;
  const count = store.getState().features.length;

  store.getState().select({ kind: 'body', bodyId: a.id });
  run('transform.pattern');
  assert.equal(draft('pattern').pattern.kind, 'linear');
  assert.equal(draft('pattern').pattern.count, 3);
  const [spacing, countChip] = draftHandles(draft('pattern'), store.getState().evaluation);
  assert.equal(spacing?.id, 'spacing');
  assert.equal(countChip?.kind, 'chip');
  store.getState().updateFeatureDraft((d) => countChip!.apply(d, 4.4));
  assert.equal(draft('pattern').pattern.count, 4, 'count chip rounds');
  store.getState().commit();
  await store.getState().whenSettled();
  assert.equal(store.getState().evaluation.bodies.length, 2 + 3);
  store.getState().undo();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, count);

  store.getState().select({ kind: 'body', bodyId: a.id });
  run('transform.mirror');
  assert.deepEqual(draft('mirror').plane, { kind: 'plane', plane: 'YZ', offset: 10 });
  await store.getState().whenSettled();
  assert.equal(tool('feature').previewEvaluation!.bodies.length, 3);
  const keep = draftBadges(draft('mirror')).find((b) => b.ariaLabel === 'Keep original')!;
  store.getState().updateFeatureDraft((d, ev) => keep.apply(d, 'move', ev));
  await store.getState().whenSettled();
  assert.equal(tool('feature').previewEvaluation!.bodies.length, 2);
  store.getState().cancel();
  assert.equal(store.getState().features.length, count);

  store.getState().select({ kind: 'body', bodyId: c.id });
  run('tools.split');
  assert.deepEqual(draft('split').plane, { kind: 'plane', plane: 'YZ', offset: 40 });
  store.getState().commit();
  await store.getState().whenSettled();
  assert.equal(store.getState().evaluation.bodies.length, 3);
  store.getState().undo();
  await store.getState().whenSettled();

  const top = a.faces.find((f) => f.normal?.[2] === 1)!;
  const side = c.faces.find((f) => f.normal?.[0] === -1)!;
  store.getState().select({ kind: 'face', bodyId: a.id, faceKey: top.key });
  store.getState().select({ kind: 'face', bodyId: c.id, faceKey: side.key }, { additive: true });
  assert.equal(
    resolveAdaptive(store.getState())[0]?.id,
    'transform.align',
    'Align is recommended for faces of two bodies',
  );
  run('transform.align');
  store.getState().commit();
  await store.getState().whenSettled();
  const moved = store.getState().evaluation.bodies.find((b) => b.id === a.id)!;
  assert.ok(Math.abs(moved.max[0] - 30) < 1e-6 && Math.abs(moved.min[0] - 20) < 1e-6);
  assert.equal(store.getState().features.at(-1)!.name, 'Align 1');
});

void test('offset/delete face tools: Del on a hole face heals it; offset face is recommended on curved faces', async () => {
  await load([
    ...box('p', 0, 0, 20, 20, 10),
    sketch('h-s', { kind: 'plane', plane: 'XY', offset: 10 }, [
      { kind: 'circle', cx: 10, cy: 10, radius: 3 },
    ]),
    {
      id: 'h',
      name: 'h',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 'h-s' },
      distance: -10,
      symmetric: false,
      operation: 'cut',
      targetBodyId: 'body:p',
    },
  ]);
  const plate = store.getState().evaluation.bodies[0]!;
  const hole = plate.faces.find((f) => f.surface === 'cylinder')!;
  store.getState().select({ kind: 'face', bodyId: plate.id, faceKey: hole.key });
  assert.equal(resolveAdaptive(store.getState())[0]?.id, 'tools.offsetFace');
  run('tools.offsetFace');
  assert.equal(draft('offsetFace').distance, -1);
  await store.getState().whenSettled();
  assert.ok(
    Math.abs(tool('feature').previewEvaluation!.bodies[0]!.volume - (4000 - Math.PI * 16 * 10)) <
      1e-3,
  );
  store.getState().cancel();

  store.getState().select({ kind: 'face', bodyId: plate.id, faceKey: hole.key });
  findCommand('transform.delete')!.run(store.getState());
  assert.equal(draft('deleteFace').faces.length, 1);
  store.getState().commit();
  await store.getState().whenSettled();
  assert.ok(Math.abs(store.getState().evaluation.bodies[0]!.volume - 4000) < 1e-3);
});

void test('move/rotate gizmo: rotation + translation commits a transform; copy keeps the original; plain move stays a move', async () => {
  await load(box('b', 0, 0, 20, 10, 5));
  const bodyId = store.getState().evaluation.bodies[0]!.id;
  store.getState().beginMove(bodyId);
  assert.deepEqual(tool('move').pivot, [10, 5, 2.5]);
  store.getState().setDelta(5, 0, 0);
  store.getState().commit();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.at(-1)!.kind, 'move');
  store.getState().undo();
  await store.getState().whenSettled();

  store.getState().beginMove(bodyId);
  store.getState().setPivot([0, 0, 0]);
  store.getState().setRotation(0, 0, 90);
  store.getState().setMoveCopy(true);
  store.getState().commit();
  await store.getState().whenSettled();
  const added = store.getState().features.at(-1)!;
  assert.equal(added.kind, 'transform');
  assert.equal(added.name, 'Move/Rotate 1');
  const bodies = store.getState().evaluation.bodies;
  assert.equal(bodies.length, 2);
  const copy = bodies.find((b) => b.id !== bodyId)!;
  assert.ok(
    Math.abs(copy.min[0] + 10) < 1e-6 && Math.abs(copy.max[1] - 20) < 1e-6,
    `${copy.min} ${copy.max}`,
  );
  store.getState().undo();
  await store.getState().whenSettled();
  assert.equal(store.getState().evaluation.bodies.length, 1);
});

void test('extrude: a closed profile inside a body face starts as a through-cut preview', async () => {
  await load(box('p', 0, 0, 40, 30, 10));
  const plate = store.getState().evaluation.bodies[0]!;
  const top = plate.faces.find((f) => f.normal?.[2] === 1)!;
  store.getState().beginSketchCircle({ bodyId: plate.id, faceKey: top.key });
  store.getState().setCircleCenter(20, 15);
  store.getState().setCircleRadius(3);
  store.getState().commit();
  // Immediately (the new sketch is not evaluated yet) — the start still reads the sketch data.
  run('tools.extrude');
  assert.equal(tool('extrude').operation, 'cut');
  assert.ok(Math.abs(tool('extrude').distance + 10) < 1e-3, `depth ${tool('extrude').distance}`);
  assert.equal(tool('extrude').phase, 'preview');
  await store.getState().whenSettled();
  assert.ok(
    Math.abs(tool('extrude').previewEvaluation!.bodies[0]!.volume - (12000 - Math.PI * 9 * 10)) <
      1e-2,
  );
  // Dragging outward still switches to Join automatically.
  store.getState().setDistance(5);
  assert.equal(tool('extrude').operation, 'join');
  store.getState().cancel();
});

void test('project files round-trip the new feature kinds and reject malformed ones', () => {
  const features: Feature[] = [
    ...box('b', 0, 0, 10, 10, 10),
    {
      id: 'r',
      name: 'Revolve 1',
      suppressed: false,
      kind: 'revolve',
      profile: { kind: 'sketch', featureId: 'b-s' },
      axis: { kind: 'world', axis: 'Z', origin: [0, 0, 0] },
      angle: 90,
      operation: 'new',
    },
    {
      id: 't',
      name: 'Move/Rotate 1',
      suppressed: false,
      kind: 'transform',
      bodyId: 'body:b',
      dx: 1,
      dy: 2,
      dz: 3,
      rx: 0,
      ry: 45,
      rz: 0,
      pivot: [0, 0, 0],
      copy: true,
    },
    {
      id: 'pt',
      name: 'Pattern 1',
      suppressed: false,
      kind: 'pattern',
      bodyIds: ['body:b'],
      pattern: { kind: 'circular', axis: { kind: 'world', axis: 'Z' }, count: 4, angle: 360 },
    },
  ];
  const text = saveProjectFile({
    projectName: 'P',
    features,
    appVersion: '0',
    createdAt: new Date(0).toISOString(),
  });
  assert.deepEqual(loadProjectFile(text).features, features);
  const broken = text.replace('"angle": 90', '"angle": "90"');
  assert.throws(() => loadProjectFile(broken), /features\[2\]\.angle: expected a number/);
});
