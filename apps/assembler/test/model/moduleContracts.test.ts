/**
 * The registration contracts phase B added below the domain modules
 * (assembler/MODULES.md §3): draft tools, project templates, datum
 * resolution, sketch usage, handler-only API contributions and the
 * viewport's DOM overlays and modes — each with the registrations the
 * product composition (`test/setup.ts`) makes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apiMethodHandler,
  registerApiContribution,
} from '../../renderer/src/foundation/commands/api/registry.js';
import {
  draftToolFor,
  isRegisteredDraftKind,
  registerDraftTool,
} from '../../renderer/src/foundation/commands/draftTools.js';
import {
  projectTemplate,
  projectTemplates,
  registerProjectTemplates,
} from '../../renderer/src/foundation/commands/projectTemplates.js';
import {
  frameForPlane,
  type Feature,
  type PlaneRef,
} from '../../renderer/src/foundation/document/document.js';
import {
  consumedSketchIds,
  derivedSketchId,
  parseDerivedSketchId,
} from '../../renderer/src/foundation/document/sketchUsage.js';
import {
  constructionAxisLine,
  datumRef,
  planeRefFrame,
  referencedDatumIds,
} from '../../renderer/src/foundation/geometry-kernel/datums.js';
import {
  EMPTY_EVALUATION,
  type EvaluationResult,
} from '../../renderer/src/foundation/geometry-kernel/types.js';
import {
  modeHiddenFeatureIds,
  modeOwnsKeyboard,
  openPickInMode,
  registerViewportDomOverlay,
  registerViewportMode,
  viewportDomOverlays,
} from '../../renderer/src/platform/viewport/domOverlays.js';
import { publishLiveGridStep, useLiveGrid } from '../../renderer/src/platform/viewport/liveGrid.js';
import { createDraft, draftMeta, draftToFeature } from '../../renderer/src/model/featureTools.js';

void test('the construction module registers the Construct tool for its two kinds', () => {
  assert.ok(isRegisteredDraftKind('constructionPlane'));
  assert.ok(isRegisteredDraftKind('constructionAxis'));
  assert.equal(draftToolFor('constructionPlane')?.module, 'construction');
  assert.equal(isRegisteredDraftKind('revolve'), false, 'modelling drafts stay in featureTools');
  // The generic feature tool delegates to it: start, pill, feature.
  const start = createDraft('constructionPlane', {
    selection: [],
    evaluation: EMPTY_EVALUATION,
    features: [],
  });
  assert.ok(start.ok);
  assert.equal(start.draft.kind, 'constructionPlane');
  assert.match(draftMeta(start.draft).label, /^Plane/);
  // Without a base plane the draft is incomplete.
  assert.equal(draftToFeature(start.draft, { id: 'p1', name: 'Plane 1' }), null);
  assert.throws(
    () => registerDraftTool({ ...draftToolFor('constructionAxis')!, module: 'other' }),
    /registered twice \(construction, other\)/,
  );
});

void test('project templates come from the registry in order; ids are unique', () => {
  const ids = projectTemplates().map((t) => t.id);
  assert.deepEqual(ids, ['blank', 'enclosure', 'bracket', 'cableClip']);
  assert.equal(projectTemplate('bracket').name, 'Bracket');
  assert.throws(() => projectTemplate('nope'), /Unknown template "nope"/);
  assert.throws(
    () =>
      registerProjectTemplates('other', [
        { id: 'blank', name: 'Blank 2', description: '', build: async () => undefined },
      ]),
    /registered twice \(templates, other\)/,
  );
});

void test('datum references resolve from the evaluation, else from their own signature', () => {
  const frame = { ...frameForPlane('XY', 5) };
  const evaluation: EvaluationResult = {
    ...EMPTY_EVALUATION,
    datums: [
      { featureId: 'plane-1', kind: 'plane', frame, center: [1, 2, 5], size: 20 },
      {
        featureId: 'axis-1',
        kind: 'axis',
        frame: { ...frameForPlane('YZ', 0), origin: [0, 0, 3] },
        center: [0, 0, 3],
        size: 10,
      },
    ],
  };
  const plane = datumRef(evaluation, 'plane-1');
  assert.deepEqual(plane, {
    kind: 'construction',
    featureId: 'plane-1',
    frame,
    shown: { center: [1, 2, 5], size: 20 },
  });
  const axis = datumRef(evaluation, 'axis-1');
  assert.ok(axis && 'line' in axis);
  assert.deepEqual(constructionAxisLine(axis, evaluation).point, [0, 0, 3]);
  assert.equal(datumRef(evaluation, 'missing'), null);
  // A plane datum no longer evaluated falls back to the frame the reference carries.
  assert.deepEqual(planeRefFrame(plane as PlaneRef, EMPTY_EVALUATION), frame);
  assert.deepEqual(referencedDatumIds({ a: [plane, { b: axis }] }), ['plane-1', 'axis-1']);
});

void test('consumed sketches come from the kind registry; suppressed steps consume nothing', () => {
  const extrude = (id: string, sketch: string, suppressed = false) =>
    ({
      id,
      name: id,
      kind: 'extrude',
      suppressed,
      profile: { kind: 'sketch', featureId: sketch },
      distance: 5,
      operation: 'new',
    }) as unknown as Feature;
  const consumed = consumedSketchIds([extrude('e1', 's1'), extrude('e2', 's2', true)]);
  assert.deepEqual([...consumed], ['s1']);
  assert.equal(derivedSketchId('mirror-3', 1), 'mirror-3:sketch:1');
  assert.deepEqual(parseDerivedSketchId('mirror-3:sketch:1'), { featureId: 'mirror-3', index: 1 });
  assert.equal(parseDerivedSketchId('sketch-1'), null);
});

void test('sketching and construction own their API handlers; a second owner throws', () => {
  for (const method of ['sketches.list', 'datums.list', 'sketch.addProfile', 'sketch.project']) {
    assert.equal(typeof apiMethodHandler(method), 'function', method);
  }
  assert.throws(
    () => registerApiContribution('other', { handlers: { 'datums.list': () => [] } }),
    /API handler of "datums.list" is registered twice \(construction, other\)/,
  );
});

void test('viewport DOM overlays and modes are registries the viewport asks', () => {
  const before = viewportDomOverlays().length;
  registerViewportDomOverlay({ id: 'test-b', order: 20, component: () => null });
  registerViewportDomOverlay({ id: 'test-a', order: 5, component: () => null });
  const ids = viewportDomOverlays().map((o) => o.id);
  assert.equal(ids.length, before + 2);
  assert.ok(ids.indexOf('test-a') < ids.indexOf('test-b'), 'ordered by `order`');
  assert.throws(
    () => registerViewportDomOverlay({ id: 'test-a', order: 1, component: () => null }),
    /registered twice/,
  );
  let open = false;
  registerViewportMode({
    id: 'test-mode',
    hiddenFeatureIds: () => ['sketch-9'],
    ownsKeyboard: () => open,
    openOnDoubleClick: (pick) => pick.kind === 'sketchProfile',
  });
  assert.deepEqual(modeHiddenFeatureIds(), ['sketch-9']);
  assert.equal(modeOwnsKeyboard(), false);
  open = true;
  assert.equal(modeOwnsKeyboard(), true);
  assert.equal(openPickInMode({ kind: 'sketchProfile', featureId: 's1' }), true);
  assert.equal(openPickInMode({ kind: 'body', bodyId: 'b1' }), false);
});

void test('the live grid step is published below the domain modules', () => {
  const seen: (number | null)[] = [];
  const off = useLiveGrid.subscribe((s) => seen.push(s.liveGridStep));
  publishLiveGridStep(5);
  publishLiveGridStep(5);
  publishLiveGridStep(2);
  off();
  assert.deepEqual(seen, [5, 2], 'subscribers hear changes only');
});
