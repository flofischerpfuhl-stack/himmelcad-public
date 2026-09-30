/**
 * Shapr3D parity fixes from `assembler/GAP-INVENTORY.md` (2026-09-30):
 * adaptive "More" layout, empty-click finish rule, History card Zoom
 * to/Duplicate, snap toggles, zoom-dependent grid, custom shortcuts,
 * saved views with section state, nearest ortho view.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adaptiveCapacity,
  splitAdaptive,
} from '../../renderer/src/interface/shell-ui/adaptiveLayout.js';
import type { EvaluationResult } from '../../renderer/src/foundation/geometry-kernel/types.js';
import {
  COMMANDS,
  findCommand,
  resolveAdaptive,
} from '../../renderer/src/foundation/commands/registry.js';
import {
  applyShortcutOverrides,
  checkShortcut,
  comboFromKey,
  defaultShortcut,
} from '../../renderer/src/foundation/commands/shortcutOverrides.js';
import { shortcutConflicts } from '../../renderer/src/foundation/commands/shortcutSheet.js';
import { resolveShortcut } from '../../renderer/src/foundation/commands/shortcuts.js';
import { createDemoDocument } from '../../renderer/src/foundation/document/document.js';
import {
  adaptiveGridStep,
  effectiveGridStep,
  formatGridStep,
} from '../../renderer/src/platform/viewport/gridResolution.js';
import {
  duplicateStep,
  featureZoomTargets,
  stepNamePrefix,
} from '../../renderer/src/interface/shell-ui/historyTools.js';
import { parsePreferences } from '../../renderer/src/interface/shell-ui/preferences.js';
import {
  useAssemblerStore,
  type ToolSession,
} from '../../renderer/src/foundation/commands/store.js';
import { emptyClickFinishes } from '../../renderer/src/foundation/commands/toolFinish.js';
import {
  nearestOrthoDirection,
  parseSavedSection,
  parseSavedViews,
  setCameraPoseProbe,
  useWorkspaceStore,
} from '../../renderer/src/interface/shell-ui/workspace.js';
import { infer } from '../../renderer/src/sketch/inference.js';
import { addRectangle } from '../../renderer/src/foundation/sketch-solver/builders.js';
import { EMPTY_SKETCH } from '../../renderer/src/foundation/sketch-solver/types.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';

useAssemblerStore.getState().attachKernel(createNodeKernelAdapter());

const keyEvent = (key: string, mods: Partial<Record<'ctrl' | 'shift' | 'alt', boolean>> = {}) => ({
  key,
  ctrlKey: mods.ctrl ?? false,
  metaKey: false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
  targetIsTextInput: false,
});

void test('adaptive bar: everything visible when it fits, else capacity-1 buttons + More', () => {
  assert.equal(adaptiveCapacity(380, 38), 10);
  assert.equal(adaptiveCapacity(-5, 38), 0);
  assert.deepEqual(splitAdaptive(6, 10), { visible: 6, more: false });
  assert.deepEqual(splitAdaptive(12, 10), { visible: 9, more: true });
  // The recommended command always stays visible.
  assert.deepEqual(splitAdaptive(12, 0), { visible: 1, more: true });
});

void test('empty-space click finishes blend/shell/boolean/feature tools, not Extrude or Move', () => {
  assert.equal(emptyClickFinishes(null), false);
  for (const kind of ['edgeBlend', 'shell', 'boolean', 'feature'] as const) {
    assert.equal(emptyClickFinishes({ kind } as unknown as ToolSession), true, kind);
  }
  for (const kind of ['extrude', 'move'] as const) {
    assert.equal(emptyClickFinishes({ kind } as unknown as ToolSession), false, kind);
  }
});

void test('History "Zoom to": sketch → its sketch, extrude → its body, fillet → the body it changes', async () => {
  useAssemblerStore.getState().loadDocument(createDemoDocument());
  await useAssemblerStore.getState().whenSettled();
  const { features, evaluation } = useAssemblerStore.getState();
  const sketch = features.find((f) => f.kind === 'sketch')!;
  assert.deepEqual(featureZoomTargets(sketch, features, evaluation), [
    { kind: 'sketchProfile', featureId: sketch.id },
  ]);
  const extrude = features.find((f) => f.kind === 'extrude')!;
  const created = evaluation.bodies.filter((b) => b.createdBy === extrude.id).map((b) => b.id);
  assert.ok(created.length > 0);
  assert.deepEqual(
    featureZoomTargets(extrude, features, evaluation).map((i) =>
      i.kind === 'body' ? i.bodyId : '',
    ),
    created,
  );
  const fillet = features.find((f) => f.kind === 'fillet');
  if (fillet) {
    const targets = featureZoomTargets(fillet, features, evaluation);
    assert.ok(targets.length > 0 && targets.every((t) => t.kind === 'body'));
  }
  const empty: EvaluationResult = { ...evaluation, bodies: [] };
  assert.deepEqual(featureZoomTargets(extrude, features, empty), [
    {
      kind: 'sketchProfile',
      featureId: (extrude as { profile: { featureId: string } }).profile.featureId,
    },
  ]);
});

void test('History "Duplicate": a copy right after the step, one undo step, a second body', async () => {
  useAssemblerStore.getState().loadDocument(createDemoDocument());
  await useAssemblerStore.getState().whenSettled();
  const state = useAssemblerStore.getState();
  const bodiesBefore = state.evaluation.bodies.length;
  const extrude = state.features.find((f) => f.kind === 'extrude')!;
  const index = state.features.indexOf(extrude);
  assert.equal(stepNamePrefix('Extrude 12'), 'Extrude');
  assert.equal(stepNamePrefix('Base plate'), 'Base plate');
  const id = state.allocateFeatureId('extrude');
  const next = duplicateStep(state.features, extrude.id, id, 'Extrude 9');
  assert.equal(next.length, state.features.length + 1);
  assert.equal(next[index + 1]!.id, id);
  assert.equal(next[index + 1]!.name, 'Extrude 9');
  assert.notEqual(next[index + 1], extrude);
  assert.ok(state.commitDocumentChange(next, { keepRollback: true }));
  await useAssemblerStore.getState().whenSettled();
  assert.ok(useAssemblerStore.getState().evaluation.bodies.length >= bodiesBefore);
  assert.ok(useAssemblerStore.getState().features.some((f) => f.id === id));
  useAssemblerStore.getState().undo();
  await useAssemblerStore.getState().whenSettled();
  assert.ok(!useAssemblerStore.getState().features.some((f) => f.id === id));
});

void test('snap toggles: points, midpoints, guidelines, curves and auto-constraining switch separately', () => {
  const sketch = addRectangle(EMPTY_SKETCH, [0, 0], [20, 10]).sketch;
  const near = (x: number, y: number) => [x, y] as [number, number];
  // Points: near the (20, 10) corner.
  assert.ok(infer(sketch, near(19.95, 10.05), { mmPerPx: 0.05 }).pointId);
  assert.equal(
    infer(sketch, near(19.95, 10.05), { mmPerPx: 0.05, snaps: { points: false } }).pointId,
    undefined,
  );
  // Midpoints: the bottom edge's middle (10, 0).
  assert.ok(infer(sketch, near(10.1, 0.1), { mmPerPx: 0.05 }).midpointOf);
  assert.equal(
    infer(sketch, near(10.1, 0.1), { mmPerPx: 0.05, snaps: { midpoints: false } }).midpointOf,
    undefined,
  );
  // Guidelines + auto-constraining: a nearly horizontal segment from (40, 0).
  const from = { pos: [40, 0] as [number, number] };
  const on = infer(sketch, near(60, 0.2), { mmPerPx: 0.05, from });
  assert.equal(on.horizontal, true);
  assert.equal(on.pos[1], 0);
  const noConstraint = infer(sketch, near(60, 0.2), {
    mmPerPx: 0.05,
    from,
    snaps: { autoConstrain: false },
  });
  assert.equal(noConstraint.horizontal, undefined, 'no inferred constraint');
  assert.equal(noConstraint.pos[1], 0, 'still guided onto the horizontal');
  assert.ok(noConstraint.hints.includes('horizontal'));
  const free = infer(sketch, near(60, 0.2), { mmPerPx: 0.05, from, snaps: { guidelines: false } });
  assert.equal(free.pos[1], 0.2);
  // Curves: a point on the right edge (x = 20); guidelines off so the corner alignment does not win.
  assert.ok(
    infer(sketch, near(20.05, 2.7), { mmPerPx: 0.05, snaps: { guidelines: false } }).curveId,
  );
  assert.equal(
    infer(sketch, near(20.05, 2.7), { mmPerPx: 0.05, snaps: { guidelines: false, curves: false } })
      .curveId,
    undefined,
  );
});

void test('grid resolution follows the zoom (1-2-5 series, ≥ 14 px) unless locked', () => {
  assert.equal(adaptiveGridStep(0.1), 2);
  assert.equal(adaptiveGridStep(0.01), 0.2);
  assert.equal(adaptiveGridStep(1), 20);
  assert.equal(adaptiveGridStep(Number.NaN), 5);
  assert.equal(effectiveGridStep({ gridAuto: true, gridStep: 5 }, 2), 2);
  assert.equal(effectiveGridStep({ gridAuto: false, gridStep: 5 }, 2), 5);
  assert.equal(effectiveGridStep({ gridAuto: true, gridStep: 5 }, null), 5);
  assert.equal(formatGridStep(0.5), '0.5 mm');
  const store = useAssemblerStore.getState();
  assert.equal(store.viewState.gridAuto, true, 'new sessions follow the zoom');
  // Projects saved before the zoom-dependent grid reopen locked at their step.
  store.applyViewState({ grid: { step: 10 } });
  assert.equal(useAssemblerStore.getState().viewState.gridAuto, false);
  store.applyViewState({ grid: { step: 10, auto: true } });
  assert.equal(useAssemblerStore.getState().viewState.gridAuto, true);
});

void test('custom shortcuts: rebind, refuse clashes and app keys, swap, reset', () => {
  try {
    assert.equal(comboFromKey(keyEvent('e', { shift: true })), 'Shift+E');
    assert.equal(comboFromKey(keyEvent('Delete')), 'Del');
    assert.equal(comboFromKey(keyEvent('Control', { ctrl: true })), null);
    assert.equal(comboFromKey(keyEvent('k', { ctrl: true, alt: true })), 'Ctrl+Alt+K');

    const ctx = useAssemblerStore.getState();
    // Clash with Fillet (F) and app keys are refused with a reason.
    const clash = checkShortcut('tools.extrude', 'F', {});
    assert.equal(clash.ok, false);
    assert.match(clash.ok ? '' : clash.reason, /Fillet/);
    assert.equal(checkShortcut('tools.extrude', 'Escape', {}).ok, false);
    assert.equal(checkShortcut('tools.extrude', 'Ctrl+F', {}).ok, false);
    // A sketch-only key may be shared with a model-only one: P = Project (sketch) / Printability (model).
    assert.equal(
      checkShortcut('sketch.trim', 'P', {}).ok,
      false,
      'Trim (sketch) vs Project (sketch)',
    );

    // Rebind Extrude to Ctrl+Alt+E: the resolver, the command and the cheat sheet follow.
    applyShortcutOverrides({ 'tools.extrude': 'Ctrl+Alt+E' });
    assert.equal(findCommand('tools.extrude')!.shortcut, 'Ctrl+Alt+E');
    assert.equal(
      resolveShortcut(keyEvent('e', { ctrl: true, alt: true }), ctx)?.id,
      'tools.extrude',
    );
    assert.equal(resolveShortcut(keyEvent('e'), ctx), null);
    assert.deepEqual(shortcutConflicts(), []);

    // Swap E and F in one go; a stored clash is ignored (default kept).
    const ignored = applyShortcutOverrides({ 'tools.extrude': 'F', 'tools.filletChamfer': 'E' });
    assert.deepEqual(ignored, []);
    assert.equal(resolveShortcut(keyEvent('f'), ctx)?.id, 'tools.extrude');
    assert.equal(resolveShortcut(keyEvent('e'), ctx)?.id, 'tools.filletChamfer');
    assert.deepEqual(applyShortcutOverrides({ 'tools.extrude': 'F' }), ['tools.extrude']);
    assert.equal(findCommand('tools.extrude')!.shortcut, 'E');

    // '' removes a shortcut.
    applyShortcutOverrides({ 'tools.shell': '' });
    assert.equal(findCommand('tools.shell')!.shortcut, undefined);
    assert.equal(resolveShortcut(keyEvent('h'), ctx), null);
  } finally {
    applyShortcutOverrides({});
  }
  assert.equal(findCommand('tools.shell')!.shortcut, 'H');
  assert.equal(defaultShortcut('tools.extrude'), 'E');
  assert.ok(COMMANDS.every((c) => c.shortcut === defaultShortcut(c.id)));
});

void test('preferences: snap switches, hints, shortcut overrides and selection extension parse safely', () => {
  const parsed = parsePreferences(
    JSON.stringify({
      snaps: { points: false, curves: 'no', bogus: true },
      snapHints: false,
      shortcuts: { 'tools.extrude': 'Shift+E', bad: 3 },
      selectionExtension: true,
    }),
  );
  assert.equal(parsed.snaps.points, false);
  assert.equal(parsed.snaps.curves, true);
  assert.ok(!('bogus' in parsed.snaps));
  assert.equal(parsed.snapHints, false);
  assert.deepEqual(parsed.shortcuts, { 'tools.extrude': 'Shift+E' });
  assert.equal(parsed.selectionExtension, true);
});

void test('saved views keep the section state and restore it with the camera', () => {
  const pose = {
    target: [0, 0, 0] as [number, number, number],
    distance: 100,
    yaw: 0.5,
    pitch: 0.4,
  };
  setCameraPoseProbe(() => pose);
  try {
    const ws = useWorkspaceStore.getState();
    ws.setSavedViews([]);
    const store = useAssemblerStore.getState();
    store.setSectionEnabled(true);
    store.setSectionAxis('X');
    store.setSectionOffset(12);
    store.setViewToggle('sectionOnly', true);
    assert.ok(useWorkspaceStore.getState().saveCurrentView('Cut'));
    const saved = useWorkspaceStore.getState().savedViews[0]!;
    assert.deepEqual(saved.section, {
      enabled: true,
      axis: 'X',
      offset: 12,
      flipped: false,
      plane: null,
      sectionOnly: true,
    });
    store.setSectionEnabled(false);
    store.setViewToggle('sectionOnly', false);
    useWorkspaceStore.getState().restoreView(0);
    const v = useAssemblerStore.getState().viewState;
    assert.equal(v.sectionEnabled, true);
    assert.equal(v.sectionAxis, 'X');
    assert.equal(v.sectionOffset, 12);
    assert.equal(v.sectionOnly, true);
    // Round trip through the project file form; older views without a section stay camera-only.
    const [restored, legacy] = parseSavedViews([
      JSON.parse(JSON.stringify(saved)),
      { name: 'Old', pose },
    ]);
    assert.deepEqual(restored!.section, saved.section);
    assert.equal(legacy!.section, undefined);
    assert.equal(parseSavedSection({ enabled: true, axis: 'Q', offset: 0, flipped: false }), null);
    assert.equal(findCommand('view.saveView')!.label, 'Save view (1/8)');
  } finally {
    setCameraPoseProbe(null);
    useWorkspaceStore.getState().setSavedViews([]);
    useAssemblerStore.getState().setSectionEnabled(false);
    useAssemblerStore.getState().setViewToggle('sectionOnly', false);
  }
});

void test('Rotate Around Axis: an edge plus a face suggests it; rotates about the edge, or copies', async () => {
  useAssemblerStore.getState().loadDocument(createDemoDocument());
  await useAssemblerStore.getState().whenSettled();
  const s = () => useAssemblerStore.getState();
  const body = s().evaluation.bodies[0]!;
  const volume = body.volume;
  const size = [0, 1, 2].map((i) => body.max[i]! - body.min[i]!);
  // A straight edge parallel to X on the body's bounding box (a hinge line).
  const edge = body.edges.find(
    (e) =>
      e.curve === 'line' &&
      Math.abs(Math.abs(e.direction?.[0] ?? 0) - 1) < 1e-9 &&
      Math.abs(e.midpoint[2] - body.min[2]) < 1e-6 &&
      Math.abs(e.midpoint[1] - body.min[1]) < 1e-6,
  )!;
  assert.ok(edge, 'a bottom edge along X');
  const face = body.faces.find((f) => f.surface === 'plane')!;
  s().clearSelection();
  s().select({ kind: 'edge', bodyId: body.id, edgeKey: edge.key });
  s().select({ kind: 'face', bodyId: body.id, faceKey: face.key }, { additive: true });
  assert.equal(
    resolveAdaptive(s())[0]?.id,
    'transform.rotateAxis',
    'line + face → Rotate Around Axis',
  );
  assert.ok(findCommand('transform.rotateAxis')!.availability(s()).enabled);
  findCommand('transform.rotateAxis')!.run(s());
  const tool = s().activeTool;
  assert.equal(tool?.kind, 'feature');
  const draft = tool?.kind === 'feature' ? tool.draft : null;
  assert.equal(draft?.kind, 'rotateAxis');
  assert.equal(draft?.kind === 'rotateAxis' ? draft.axis.kind : '', 'edge');
  assert.ok(emptyClickFinishes(tool));
  s().commit();
  await s().whenSettled();
  const rotated = s().evaluation.bodies.find((b) => b.id === body.id)!;
  assert.equal(s().evaluation.errors[s().features.at(-1)!.id], undefined);
  assert.ok(Math.abs(rotated.volume - volume) < 1e-6 * volume, 'a rigid motion keeps the volume');
  // 90° about an X edge swaps the Y and Z extents.
  assert.ok(Math.abs(rotated.max[1] - rotated.min[1] - size[2]!) < 1e-6);
  assert.ok(Math.abs(rotated.max[2] - rotated.min[2] - size[1]!) < 1e-6);
  assert.equal(s().features.at(-1)!.name, 'Rotate 1');
  // Copy: the original stays, a rotated copy is added.
  const bodiesBefore = s().evaluation.bodies.length;
  s().editFeatureParams(s().features.at(-1)!.id, { copy: true } as never);
  await s().whenSettled();
  assert.equal(s().evaluation.bodies.length, bodiesBefore + 1);
  s().undo();
  s().undo();
  await s().whenSettled();
  assert.ok(!s().features.some((f) => f.kind === 'rotateAxis'));
});

void test('nearest ortho view snaps the view direction to the closest world axis', () => {
  assert.deepEqual(nearestOrthoDirection([0.2, -0.9, 0.3]), [0, -1, 0]);
  assert.deepEqual(nearestOrthoDirection([0.1, 0.2, 0.97]), [0, 0, 1]);
  assert.deepEqual(nearestOrthoDirection([-0.8, 0.5, 0.1]), [-1, 0, 0]);
});
