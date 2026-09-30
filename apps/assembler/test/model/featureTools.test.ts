/**
 * The modelling-feature tools on the store with the real OCCT kernel:
 * commands start from the selection, live preview never touches the
 * document, Cancel restores exactly, Done is one undo step, picks/badges/
 * handles edit the draft, the Move/Rotate gizmo commits rotations and
 * copies, and an extrude of a profile inside a face starts as a Cut.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { findCommand, resolveAdaptive } from '../../renderer/src/foundation/commands/registry.js';
import { resolveShortcut } from '../../renderer/src/foundation/commands/shortcuts.js';
import type { ExtrudeFeature, Feature } from '../../renderer/src/foundation/document/document.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import {
  acceptPick,
  draftBadges,
  draftHandles,
  type FeatureDraft,
} from '../../renderer/src/model/featureTools.js';
import { loadProjectFile, saveProjectFile } from '../../renderer/src/foundation/document/format.js';
import {
  makeFaceRef,
  useAssemblerStore,
  type ToolSession,
} from '../../renderer/src/foundation/commands/store.js';
import {
  addPolyline,
  sketchFromLegacyProfiles,
  type LegacySketchProfile,
} from '../../renderer/src/foundation/sketch-solver/builders.js';
import { EMPTY_SKETCH } from '../../renderer/src/foundation/sketch-solver/types.js';
import { selectedOcctModule } from '../../headless/occtModule.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';

const store = useAssemblerStore;
store.getState().attachKernel(createNodeKernelAdapter());

function sketch(
  id: string,
  plane: SketchFeature['plane'],
  profiles: LegacySketchProfile[],
): SketchFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'sketch',
    plane,
    ...sketchFromLegacyProfiles(profiles).sketch,
  };
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

void test('revolve tool: a construction centre line of the sketch is the default axis; a sketch line pick sets it', async () => {
  const profile = addPolyline(
    EMPTY_SKETCH,
    [
      [5, 0],
      [15, 0],
      [15, 4],
      [9, 4],
      [9, 10],
      [5, 10],
    ],
    { closed: true },
  );
  const centre = addPolyline(
    profile.sketch,
    [
      [0, -2],
      [0, 12],
    ],
    { construction: true },
  );
  const lSketch: SketchFeature = {
    id: 'l',
    name: 'Sketch 1',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XZ', offset: 0 },
    ...centre.sketch,
  };
  await load([lSketch]);
  const regionKey = store.getState().evaluation.sketches[0]!.profiles[0]!.key;
  store.getState().select({ kind: 'sketchProfile', featureId: 'l', regionKey });
  run('tools.revolve');
  assert.deepEqual(draft('revolve').axis, {
    kind: 'sketchLine',
    featureId: 'l',
    entityId: centre.lineIds[0],
  });
  assert.deepEqual(draft('revolve').profile, {
    kind: 'sketch',
    featureId: 'l',
    regions: [regionKey],
  });
  assert.deepEqual(
    draftBadges(draft('revolve'))
      .find((b) => b.ariaLabel === 'Revolve axis')!
      .options.map((o) => o.label),
    ['X', 'Y', 'Z', 'Sketch line'],
  );
  await store.getState().whenSettled();
  const ring = (r0: number, r1: number, h: number) => Math.PI * (r1 * r1 - r0 * r0) * h;
  const preview = tool('feature').previewEvaluation!.bodies[0]!;
  assert.ok(Math.abs(preview.volume - (ring(5, 15, 4) + ring(5, 9, 6))) < 1e-3);

  // Picking a profile line instead: revolving about the L's own inner side (u = 5).
  const inner = profile.lineIds[5]!;
  store
    .getState()
    .updateFeatureDraft((d, ev) =>
      acceptPick(d, { kind: 'sketchLine', featureId: 'l', entityId: inner }, ev),
    );
  assert.deepEqual(draft('revolve').axis, { kind: 'sketchLine', featureId: 'l', entityId: inner });
  await store.getState().whenSettled();
  const about = tool('feature').previewEvaluation!.bodies[0]!;
  assert.ok(Math.abs(about.volume - (ring(0, 10, 4) + ring(0, 4, 6))) < 1e-3);
  store.getState().commit();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.at(-1)!.kind, 'revolve');
  assert.deepEqual(store.getState().evaluation.errors, {});
  store.getState().undo();
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
  // A circle sketched on the top face, committed like a finished sketch session.
  const hole = sketch(
    'hole-s',
    { kind: 'face', face: makeFaceRef(store.getState().evaluation, plate.id, top.key)! },
    [{ kind: 'circle', cx: 20, cy: 15, radius: 3 }],
  );
  store.getState().addFeature(hole, [{ kind: 'sketchProfile', featureId: hole.id }]);
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

// ---- Offset Face modes (DIR-01) and Move Face -------------------------------------------------

function offsetBadge(ariaLabel: string) {
  return draftBadges(draft('offsetFace'), store.getState().evaluation).find(
    (b) => b.ariaLabel === ariaLabel,
  );
}

async function setMode(mode: string) {
  const badge = offsetBadge('Offset mode');
  assert.ok(badge, 'the mode badge is offered');
  store.getState().updateFeatureDraft((d, ev) => badge.apply(d, mode, ev));
  await store.getState().whenSettled();
}

void test('Offset Face modes: Radius/Diameter on a boss and a hole, Total to the opposite face', async () => {
  await load([
    sketch('c-s', { kind: 'plane', plane: 'XY', offset: 0 }, [
      { kind: 'circle', cx: 0, cy: 0, radius: 5 },
    ]),
    {
      id: 'c',
      name: 'c',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 'c-s' },
      distance: 10,
      symmetric: false,
      operation: 'new',
    },
  ]);
  const boss = store.getState().evaluation.bodies[0]!;
  const side = boss.faces.find((f) => f.surface === 'cylinder')!;
  store.getState().select({ kind: 'face', bodyId: boss.id, faceKey: side.key });
  run('tools.offsetFace');
  assert.equal(draft('offsetFace').distance, -1, 'starts as Offset −1');
  assert.deepEqual(
    offsetBadge('Offset mode')!.options.map((o) => o.value),
    ['offset', 'radius', 'diameter'],
  );
  assert.ok(offsetBadge('Clearance'), 'clearances in Offset mode');
  // The geometry is kept when the mode changes: offset −1 on R5 is radius 4, Ø8.
  await setMode('radius');
  assert.equal(draft('offsetFace').distance, 4);
  assert.equal(offsetBadge('Clearance'), undefined, 'no clearance presets for a target size');
  await setMode('diameter');
  assert.equal(draft('offsetFace').distance, 8);
  const [handle] = draftHandles(draft('offsetFace'), store.getState().evaluation);
  assert.ok(handle?.kind === 'linear');
  assert.equal(handle.label, 'Diameter');
  store.getState().updateFeatureDraft((d) => handle.apply(d, 12));
  store.getState().commit();
  await store.getState().whenSettled();
  const added = store.getState().features.at(-1)!;
  assert.ok(added.kind === 'offsetFace');
  assert.equal(added.mode, 'diameter');
  assert.equal(added.distance, 12);
  assert.ok(Math.abs(store.getState().evaluation.bodies[0]!.volume - Math.PI * 36 * 10) < 0.05);

  // A hole: its radius grows into the material, so the arrow points that way.
  await load([
    ...box('a', 0, 0, 20, 20, 10),
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
      targetBodyId: 'body:a',
    },
  ]);
  const plate = store.getState().evaluation.bodies[0]!;
  const wall = plate.faces.find((f) => f.surface === 'cylinder')!;
  store.getState().select({ kind: 'face', bodyId: plate.id, faceKey: wall.key });
  run('tools.offsetFace');
  await setMode('radius');
  assert.equal(draft('offsetFace').distance, 4, 'offset −1 on a hole wall: radius 3 → 4');
  const [arrow] = draftHandles(draft('offsetFace'), store.getState().evaluation);
  assert.ok(arrow?.kind === 'linear');
  const centre = [10, 10];
  const outward = Math.hypot(
    arrow.base[0] + arrow.dir[0] - centre[0]!,
    arrow.base[1] + arrow.dir[1] - centre[1]!,
  );
  assert.ok(
    outward > Math.hypot(arrow.base[0] - centre[0]!, arrow.base[1] - centre[1]!),
    'arrow away from the axis',
  );
  store.getState().cancel();

  // Total: the nearest parallel face behind the top is the bottom; offset −1 → total 9.
  const top = plate.faces.find((f) => f.normal?.[2] === 1)!;
  store.getState().select({ kind: 'face', bodyId: plate.id, faceKey: top.key });
  run('tools.offsetFace');
  assert.ok(offsetBadge('Offset mode')!.options.some((o) => o.value === 'total'));
  await setMode('total');
  const total = draft('offsetFace');
  assert.equal(total.distance, 9);
  assert.equal(
    plate.faces.find((f) => f.key === total.opposite?.key)?.normal?.[2],
    -1,
    'measured to the bottom',
  );
  store.getState().updateFeatureDraft((d) => (d.kind === 'offsetFace' ? { ...d, distance: 6 } : d));
  store.getState().commit();
  await store.getState().whenSettled();
  assert.deepEqual(store.getState().evaluation.errors, {});
  assert.ok(Math.abs(store.getState().evaluation.bodies[0]!.max[2] - 6) < 1e-6);
  // Adding a second face turns a single-face mode back into Offset (same geometry).
  store.getState().undo();
  await store.getState().whenSettled();
  store.getState().select({ kind: 'face', bodyId: plate.id, faceKey: top.key });
  run('tools.offsetFace');
  await setMode('total');
  const other = plate.faces.find((f) => f.normal?.[0] === 1)!;
  store
    .getState()
    .updateFeatureDraft((d, ev) =>
      acceptPick(d, { kind: 'face', bodyId: plate.id, faceKey: other.key }, ev),
    );
  const two = draft('offsetFace');
  assert.equal(two.faces.length, 2);
  assert.equal(two.mode, undefined);
  assert.equal(two.distance, -1);
  store.getState().cancel();
});

void test('Move Face on a part with inclined neighbours: true offset on the HimmelCAD build, slab on replicad', async () => {
  const data = addPolyline(
    EMPTY_SKETCH,
    [
      [0, 0],
      [20, 0],
      [15, 10],
      [5, 10],
    ],
    { closed: true },
  ).sketch;
  await load([
    {
      id: 't-s',
      name: 't-s',
      suppressed: false,
      kind: 'sketch',
      plane: { kind: 'plane', plane: 'XZ', offset: 0 },
      ...data,
    },
    {
      id: 't',
      name: 't',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 't-s' },
      distance: 10,
      symmetric: false,
      operation: 'new',
    },
  ]);
  const prism = store.getState().evaluation.bodies[0]!;
  const top = prism.faces.find((f) => f.normal?.[2] === 1)!;
  store.getState().select({ kind: 'face', bodyId: prism.id, faceKey: top.key });
  run('transform.moveRotate');
  assert.ok(draft('offsetFace').viaMove);
  const [arrow] = draftHandles(draft('offsetFace'), store.getState().evaluation);
  store.getState().updateFeatureDraft((d) => arrow!.apply(d, 2));
  store.getState().commit();
  await store.getState().whenSettled();
  assert.deepEqual(store.getState().evaluation.errors, {});
  const moved = store.getState().evaluation.bodies[0]!;
  if (selectedOcctModule() === 'himmelcad') {
    // (20 + 8) / 2 · 12 · 10: the inclined sides re-extend to the moved top, no step.
    assert.ok(Math.abs(moved.volume - 1680) < 1e-3, `true offset ${moved.volume}`);
    assert.equal(moved.faces.length, 6);
  } else {
    // The slab route of the replicad build: a 10 × 10 × 2 slab on the top, a step at the sides.
    assert.ok(Math.abs(moved.volume - 1700) < 1e-3, `slab ${moved.volume}`);
  }
});
