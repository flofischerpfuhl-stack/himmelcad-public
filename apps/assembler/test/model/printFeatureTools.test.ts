/**
 * The print-part tools on the store with the real OCCT kernel: Hole
 * (presets, fits, clicked positions, sketch points), Emboss, Draft, Rib,
 * Thicken, the fillet/chamfer/shell/boolean tool variants — start from the
 * selection, live preview never touches the document, Cancel restores
 * exactly, Done is one undo step, the failing fillet edge is highlighted,
 * and every new feature survives Save/Open.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { findCommand } from '../../renderer/src/foundation/commands/registry.js';
import type { ExtrudeFeature, Feature } from '../../renderer/src/foundation/document/document.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import type { EvaluationResult } from '../../renderer/src/foundation/geometry-kernel/types.js';
import {
  acceptPick,
  draftBadges,
  draftHandles,
  type FeatureDraft,
} from '../../renderer/src/model/featureTools.js';
import {
  holePreset,
  METRIC_HOLE_SIZES,
  fitDiameter,
} from '../../renderer/src/model/printFeatures.js';
import { loadProjectFile, saveProjectFile } from '../../renderer/src/foundation/document/format.js';
import {
  useAssemblerStore,
  type ToolSession,
} from '../../renderer/src/foundation/commands/store.js';
import {
  addPolyline,
  sketchFromLegacyProfiles,
  type LegacySketchProfile,
} from '../../renderer/src/foundation/sketch-solver/builders.js';
import { EMPTY_SKETCH } from '../../renderer/src/foundation/sketch-solver/types.js';
import { errorHighlightOf } from '../../renderer/src/platform/viewport/errorHighlight.js';
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

function body(id: string) {
  const b = store.getState().evaluation.bodies.find((x) => x.id === id);
  assert.ok(b, `body ${id}`);
  return b;
}

function selectFace(
  bodyId: string,
  predicate: (f: ReturnType<typeof body>['faces'][number]) => boolean,
) {
  const face = body(bodyId).faces.find(predicate);
  assert.ok(face, 'face found');
  store.getState().select({ kind: 'face', bodyId, faceKey: face.key });
  return face;
}

const top = (z: number) => (f: ReturnType<typeof body>['faces'][number]) =>
  f.normal?.[2] === 1 && Math.abs(f.centroid[2] - z) < 1e-6;

void test('metric hole table: sizes only, fits add their allowance', () => {
  assert.deepEqual(
    METRIC_HOLE_SIZES.map((s) => s.thread),
    ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10'],
  );
  for (const s of METRIC_HOLE_SIZES) {
    assert.ok(s.tapDrill < Number(s.thread.slice(1)), `${s.thread} tap drill below nominal`);
    assert.ok(s.clearanceFine > Number(s.thread.slice(1)), `${s.thread} clearance above nominal`);
    assert.ok(s.clearanceFine < s.clearanceNormal && s.clearanceNormal < s.clearanceCoarse);
    assert.ok(
      s.counterboreDiameter > s.clearanceCoarse && s.countersinkDiameter > s.clearanceCoarse,
    );
  }
  assert.equal(holePreset('M3', 'clearanceNormal', 'simple')?.diameter, 3.4);
  assert.equal(holePreset('M3', 'tapDrill', 'simple')?.diameter, 2.5);
  assert.equal(holePreset('M4', 'clearanceNormal', 'counterbore')?.counterboreDiameter, 8);
  assert.equal(holePreset('M7', 'clearanceNormal', 'simple'), null);
  assert.equal(fitDiameter(3, 'press'), 3);
  assert.equal(fitDiameter(3, 'clearance'), 3.2);
});

void test('hole tool: starts on a face, clicks add and remove holes, presets and fits, Done is one step', async () => {
  await load(box('p', 0, 0, 40, 30, 10));
  const face = selectFace('body:p', top(10));
  const command = findCommand('tools.hole')!;
  assert.equal(command.availability(store.getState()).enabled, true);
  command.run(store.getState());
  let t = tool('feature');
  assert.equal(t.draft.kind, 'hole');
  await store.getState().whenSettled();
  assert.equal(tool('feature').previewError, null);
  assert.deepEqual(store.getState().features.length, 2, 'preview never touches the document');

  // Click two more positions, then click the first again to remove it.
  const click = (x: number, y: number) =>
    store
      .getState()
      .updateFeatureDraft((draft, evaluation) =>
        acceptFacePick(draft, evaluation, face.key, [x, y, 10]),
      );
  click(5, 5);
  click(35, 25);
  t = tool('feature');
  assert.equal(t.draft.kind === 'hole' && t.draft.placements.length, 3);
  click(20.5, 15.2); // the centroid hole
  t = tool('feature');
  assert.equal(t.draft.kind === 'hole' && t.draft.placements.length, 2);

  // Presets: M4 tap drill, then a printed press fit for a 4 mm pin.
  const badges = () => draftBadges(tool('feature').draft);
  const apply = (label: string, value: string) =>
    store.getState().updateFeatureDraft((d, ev) =>
      badges()
        .find((b) => b.ariaLabel === label)!
        .apply(d, value, ev),
    );
  apply('Hole size', 'M4');
  apply('Hole fit', 'tapDrill');
  t = tool('feature');
  assert.equal(t.draft.kind === 'hole' && t.draft.diameter, 3.3);
  apply('Hole fit', 'fit:press');
  t = tool('feature');
  assert.equal(t.draft.kind === 'hole' && t.draft.diameter, 4);
  apply('Hole type', 'counterbore');
  apply('Cosmetic thread', 'on');
  const diameterChip = draftHandles(
    tool('feature').draft,
    store.getState().evaluation,
    store.getState().features,
  ).find((h) => h.id === 'diameter');
  assert.ok(diameterChip, 'diameter chip');
  await store.getState().whenSettled();
  assert.equal(tool('feature').previewError, null);

  const before = store.getState().features.length;
  store.getState().commit();
  await store.getState().whenSettled();
  const features = store.getState().features;
  assert.equal(features.length, before + 1);
  const hole = features.at(-1)!;
  assert.equal(hole.kind, 'hole');
  assert.equal(hole.name, 'Hole 1');
  if (hole.kind === 'hole') {
    assert.equal(hole.thread, 'M4');
    assert.equal(hole.placements.length, 2);
    assert.match(hole.preset ?? '', /press fit/);
  }
  const holeBody = body('body:p');
  const expectedCb = Math.max(8, 4 + 1);
  const removed = 2 * (Math.PI * 2 ** 2 * 10 + Math.PI * ((expectedCb / 2) ** 2 - 2 ** 2) * 4.4);
  assert.ok(Math.abs(holeBody.volume - (12000 - removed)) < 1e-3, `volume ${holeBody.volume}`);

  // One undo step removes the hole feature.
  store.getState().undo();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, before);

  // Round trip through the project format.
  store.getState().redo();
  await store.getState().whenSettled();
  const saved = saveProjectFile({
    appVersion: 'test',
    createdAt: '2026-09-30T00:00:00.000Z',
    projectName: 't',
    features: store.getState().features,
  });
  assert.deepEqual(loadProjectFile(saved).features.at(-1), store.getState().features.at(-1));
});

/** Face pick with a clicked point, as the viewport sends it. */
function acceptFacePick(
  draft: FeatureDraft,
  evaluation: EvaluationResult,
  faceKey: string,
  point: [number, number, number],
): FeatureDraft {
  return acceptPick(draft, { kind: 'face', bodyId: 'body:p', faceKey, point }, evaluation);
}

void test('hole tool: from a sketch of points on the face; cancel restores', async () => {
  await load(box('p', 0, 0, 40, 30, 10));
  const face = body('body:p').faces.find(top(10))!;
  const marks = sketch(
    'm',
    {
      kind: 'face',
      face: {
        bodyId: 'body:p',
        key: face.key,
        signature: {
          surface: 'plane',
          normal: [0, 0, 1],
          centroid: face.centroid,
          area: face.area,
          adjacentFaces: 4,
        },
      },
    },
    [
      { kind: 'circle', cx: 8, cy: 8, radius: 1 },
      { kind: 'circle', cx: 32, cy: 22, radius: 1 },
    ],
  );
  await load([...box('p', 0, 0, 40, 30, 10), marks]);
  store.getState().select({ kind: 'feature', featureId: 'm' });
  findCommand('tools.hole')!.run(store.getState());
  const t = tool('feature');
  assert.equal(t.draft.kind === 'hole' && t.draft.placements.length, 2);
  assert.ok(t.draft.kind === 'hole' && t.draft.placements.every((p) => p.kind === 'sketchPoint'));
  const volume = body('body:p').volume;
  store.getState().cancel();
  await store.getState().whenSettled();
  assert.equal(store.getState().activeTool, null);
  assert.equal(body('body:p').volume, volume, 'cancel leaves the model unchanged');
  assert.equal(store.getState().features.length, 3);
});

void test('emboss, thicken, draft and rib tools start from the selection and commit', async () => {
  const plate = box('p', 0, 0, 40, 30, 5);
  const label = sketch('t', { kind: 'plane', plane: 'XY', offset: 5 }, [
    { kind: 'rectangle', x: 5, y: 5, width: 10, height: 4 },
  ]);
  await load([...plate, label]);
  const face = body('body:p').faces.find(top(5))!;
  store.getState().select({ kind: 'sketchProfile', featureId: 't' });
  store
    .getState()
    .select({ kind: 'face', bodyId: 'body:p', faceKey: face.key }, { additive: true });
  const emboss = findCommand('tools.emboss')!;
  assert.equal(emboss.availability(store.getState()).enabled, true);
  emboss.run(store.getState());
  await store.getState().whenSettled();
  assert.equal(tool('feature').previewError, null);
  store.getState().commit();
  await store.getState().whenSettled();
  assert.ok(Math.abs(body('body:p').volume - (6000 + 40)) < 1e-3, 'embossed 1 mm');

  // Thicken the top face into a new plate.
  store.getState().select({ kind: 'face', bodyId: 'body:p', faceKey: face.key });
  findCommand('tools.thicken')!.run(store.getState());
  await store.getState().whenSettled();
  store.getState().commit();
  await store.getState().whenSettled();
  const thick = store
    .getState()
    .evaluation.bodies.find((b) => b.id.startsWith('body:feature-thicken'));
  assert.ok(thick, 'thicken body created');

  // Draft the side faces of a block (default: 3 degrees about its bottom).
  await load(box('b', 0, 0, 20, 10, 10));
  const left = body('body:b').faces.find((f) => f.normal?.[0] === -1)!;
  store.getState().select({ kind: 'face', bodyId: 'body:b', faceKey: left.key });
  findCommand('tools.draft')!.run(store.getState());
  await store.getState().whenSettled();
  assert.equal(tool('feature').previewError, null);
  store.getState().commit();
  await store.getState().whenSettled();
  const t3 = Math.tan((3 * Math.PI) / 180);
  assert.ok(
    Math.abs(body('body:b').volume - (2000 - 0.5 * 10 * 10 * t3 * 10)) < 1e-3,
    'drafted 3°',
  );

  // Rib from a sketch line selected by its History card.
  const bracket: Feature[] = [
    ...box('p', 0, 0, 40, 30, 5),
    sketch('u-s', { kind: 'plane', plane: 'XY', offset: 5 }, [
      { kind: 'rectangle', x: 0, y: 25, width: 40, height: 5 },
    ]),
    {
      id: 'u',
      name: 'u',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 'u-s' },
      distance: 30,
      symmetric: false,
      operation: 'join',
      targetBodyId: 'body:p',
    },
  ];
  const line = addPolyline(EMPTY_SKETCH, [
    [25, 25],
    [5, 5],
  ]);
  const ribSketch: SketchFeature = {
    id: 'r-s',
    name: 'r-s',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'YZ', offset: 20 },
    ...line.sketch,
  };
  await load([...bracket, ribSketch]);
  const plain = body('body:p').volume;
  store.getState().select({ kind: 'feature', featureId: 'r-s' });
  findCommand('tools.rib')!.run(store.getState());
  await store.getState().whenSettled();
  assert.equal(tool('feature').previewError, null);
  store.getState().commit();
  await store.getState().whenSettled();
  assert.ok(Math.abs(body('body:p').volume - (plain + 0.5 * 20 * 20 * 2)) < 1e-3, 'rib 2 mm');
});

void test('fillet tool: variable radius, rules; a failing radius highlights the edge and blocks Done', async () => {
  await load(box('b', 0, 0, 20, 10, 10));
  const edge = body('body:b').edges.find(
    (e) =>
      e.curve === 'line' && Math.abs(e.midpoint[2] - 10) < 1e-6 && Math.abs(e.midpoint[1]) < 1e-6,
  )!;
  store.getState().select({ kind: 'edge', bodyId: 'body:b', edgeKey: edge.key });
  store.getState().beginEdgeBlend('fillet');
  store.getState().setBlendSize(1);
  store.getState().setBlendOptions({ radius2: 3 });
  await store.getState().whenSettled();
  assert.equal(tool('edgeBlend').previewError, null);
  store.getState().setBlendOptions({ radius2: undefined });
  store.getState().setBlendSize(15);
  await store.getState().whenSettled();
  const failing = tool('edgeBlend');
  assert.match(failing.previewError ?? '', /Fillet failed/);
  assert.deepEqual(failing.previewErrorRefs?.edgeKeys, [edge.key]);
  const highlight = errorHighlightOf(store.getState());
  assert.equal(highlight?.segments.length, 1, 'the failing edge is highlighted');
  const count = store.getState().features.length;
  store.getState().commit();
  assert.equal(store.getState().features.length, count, 'Done is blocked by the error');
  store.getState().setBlendSize(1);
  store.getState().setBlendOptions({ radius2: 3 });
  await store.getState().whenSettled();
  store.getState().commit();
  await store.getState().whenSettled();
  const fillet = store.getState().features.at(-1)!;
  assert.equal(fillet.kind === 'fillet' && fillet.radius2, 3);

  // All concave edges of a body, from the command.
  await load([
    ...box('p', 0, 0, 40, 30, 5),
    sketch('u-s', { kind: 'plane', plane: 'XY', offset: 5 }, [
      { kind: 'rectangle', x: 0, y: 25, width: 40, height: 5 },
    ]),
    {
      id: 'u',
      name: 'u',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: 'u-s' },
      distance: 30,
      symmetric: false,
      operation: 'join',
      targetBodyId: 'body:p',
    },
  ]);
  store.getState().select({ kind: 'body', bodyId: 'body:p' });
  findCommand('tools.filletConcave')!.run(store.getState());
  store.getState().setBlendSize(2);
  await store.getState().whenSettled();
  store.getState().commit();
  await store.getState().whenSettled();
  const ruled = store.getState().features.at(-1)!;
  assert.equal(ruled.kind, 'fillet');
  assert.deepEqual(ruled.kind === 'fillet' && ruled.rules, [{ kind: 'concave', bodyId: 'body:p' }]);
  assert.equal(store.getState().evaluation.errors[ruled.id], undefined);
});

void test('shell tool: faces toggle while it runs, outward walls; boolean keeps and swaps', async () => {
  await load(box('b', 0, 0, 20, 10, 10));
  const b = body('body:b');
  const topFace = b.faces.find(top(10))!;
  const front = b.faces.find((f) => f.normal?.[1] === -1)!;
  store.getState().select({ kind: 'face', bodyId: 'body:b', faceKey: topFace.key });
  store.getState().beginShell();
  store.getState().toggleShellFace('body:b', front.key);
  assert.equal(tool('shell').faces.length, 2);
  store.getState().toggleShellFace('body:b', front.key);
  store.getState().toggleShellFace('body:b', topFace.key); // keeps the last open face
  assert.equal(tool('shell').faces.length, 1);
  store.getState().setShellDirection('outside');
  await store.getState().whenSettled();
  store.getState().commit();
  await store.getState().whenSettled();
  assert.ok(Math.abs(body('body:b').volume - (22 * 12 * 11 - 2000)) < 1e-3, 'outward shell');

  await load([...box('a', 0, 0, 20, 20, 10), ...box('t', 5, 5, 4, 4, 10)]);
  store.getState().select({ kind: 'body', bodyId: 'body:a' });
  store.getState().select({ kind: 'body', bodyId: 'body:t' }, { additive: true });
  store.getState().beginBoolean('subtract');
  store.getState().setBooleanKeepTools(true);
  store.getState().swapBooleanTarget();
  assert.equal(tool('boolean').targetBodyId, 'body:t');
  store.getState().swapBooleanTarget();
  await store.getState().whenSettled();
  store.getState().commit();
  await store.getState().whenSettled();
  assert.deepEqual(
    store
      .getState()
      .evaluation.bodies.map((x) => x.id)
      .sort(),
    ['body:a', 'body:t'],
  );
  const last = store.getState().features.at(-1)!;
  assert.equal(last.kind === 'boolean' && last.keepTools, true);
});
