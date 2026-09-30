import assert from 'node:assert/strict';
import test from 'node:test';

import { withBodyColour, normalizeHexColour } from '../../renderer/src/model/appearance.js';
import {
  COMMANDS,
  type Command,
  type CommandContext,
} from '../../renderer/src/foundation/commands/registry.js';
import {
  shortcutConflicts,
  shortcutSections,
} from '../../renderer/src/foundation/commands/shortcutSheet.js';
import { resolveShortcut } from '../../renderer/src/foundation/commands/shortcuts.js';
import {
  createDemoDocument,
  type Feature,
} from '../../renderer/src/foundation/document/document.js';
import {
  checkMove,
  directDependencies,
  moveFeature,
  relevantFeatureIds,
} from '../../renderer/src/model/historyTools.js';
import {
  EMPTY_ITEMS_META,
  buildItemTree,
  isInsideFolder,
  useItemsStore,
  visibleLeafOrder,
  withDisplayNames,
} from '../../renderer/src/model/items.js';
import {
  DEFAULT_PREFERENCES,
  formatLength,
  fromDisplayUnit,
  parsePreferences,
} from '../../renderer/src/model/preferences.js';
import { loadProjectFile, saveProjectFile } from '../../renderer/src/foundation/document/format.js';
import {
  MAX_SAVED_VIEWS,
  parseSavedViews,
  setCameraPoseProbe,
  useWorkspaceStore,
} from '../../renderer/src/model/workspace.js';
import { EMPTY_EVALUATION } from '../../renderer/src/foundation/geometry-kernel/types.js';

const demo = createDemoDocument();
const index = (name: string, features: readonly Feature[] = demo) =>
  features.findIndex((f) => f.name === name);

void test('history dependencies come from the references (sketch ids, body ids, naming keys)', () => {
  const byName = (name: string) => demo.find((f) => f.name === name)!;
  assert.deepEqual([...directDependencies(byName('Extrude 1'), demo)], ['feature-sketch-1']);
  const fillet = [...directDependencies(byName('Fillet 1'), demo)].sort();
  assert.deepEqual(fillet, ['feature-extrude-1', 'feature-extrude-2']);
  const sketch3 = [...directDependencies(byName('Sketch 3'), demo)];
  assert.deepEqual(sketch3, ['feature-extrude-1']);
});

void test('reorder: a step cannot move above what it uses, nor below what uses it', () => {
  const up = checkMove(demo, index('Extrude 1'), index('Sketch 1'));
  assert.equal(up.ok, false);
  assert.match(up.ok ? '' : up.reason, /"Extrude 1" uses "Sketch 1"/);
  const down = checkMove(demo, index('Sketch 1'), index('Extrude 1'));
  assert.equal(down.ok, false);
  // Sketch 3 (on the plate's top face) may move above the fillet, not above Extrude 1.
  assert.equal(checkMove(demo, index('Sketch 3'), index('Fillet 1')).ok, true);
  assert.equal(checkMove(demo, index('Sketch 3'), index('Extrude 1')).ok, false);
  const moved = moveFeature(demo, index('Sketch 3'), index('Fillet 1'));
  assert.deepEqual(
    moved.map((f) => f.name),
    ['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2', 'Sketch 3', 'Fillet 1', 'Extrude 3'],
  );
});

void test('history filter: steps relevant to a selected sketch profile or body', () => {
  const sketchOnly = relevantFeatureIds(demo, EMPTY_EVALUATION, [
    { kind: 'sketchProfile', featureId: 'feature-sketch-2' },
  ]);
  assert.deepEqual([...sketchOnly], ['feature-sketch-2']);
  const evaluation = {
    ...EMPTY_EVALUATION,
    bodies: [{ id: 'body:feature-extrude-1', createdBy: 'feature-extrude-1' }],
  } as unknown as typeof EMPTY_EVALUATION;
  const body = relevantFeatureIds(demo, evaluation, [
    { kind: 'face', bodyId: 'body:feature-extrude-1', faceKey: 'x' },
  ]);
  // Every demo step builds or changes the one bracket body.
  assert.equal(body.size, demo.length);
  const fillet = relevantFeatureIds(demo, EMPTY_EVALUATION, [
    { kind: 'feature', featureId: 'feature-fillet-3' },
  ]);
  assert.deepEqual([...fillet].sort(), [
    'feature-extrude-1',
    'feature-extrude-2',
    'feature-fillet-3',
    'feature-sketch-1',
    'feature-sketch-2',
  ]);
});

void test('items tree: folders nest, collapsed folders hide their rows from the order', () => {
  const meta = {
    names: {},
    folders: [
      { id: 'f1', name: 'Parts', collapsed: false },
      { id: 'f2', name: 'Inner', collapsed: true },
    ],
    parent: { 'body:A': 'f1', 'folder:f2': 'f1', 'body:B': 'f2', 'sketch:S': 'gone' },
  };
  const rows = [
    { key: 'body:A', kind: 'body' as const },
    { key: 'body:B', kind: 'body' as const },
    { key: 'sketch:S', kind: 'sketch' as const },
  ];
  const tree = buildItemTree(rows, meta);
  assert.deepEqual(
    tree.map((n) => n.key),
    ['folder:f1', 'sketch:S'],
  );
  const f1 = tree[0]!;
  assert.equal(f1.type, 'folder');
  assert.deepEqual(f1.type === 'folder' ? f1.children.map((c) => c.key) : [], [
    'folder:f2',
    'body:A',
  ]);
  assert.deepEqual(visibleLeafOrder(tree), ['body:A', 'sketch:S']);
  assert.equal(isInsideFolder(meta, 'f2', 'f1'), true);
  assert.equal(isInsideFolder(meta, 'f1', 'f2'), false);
});

void test('items store: folders, moving, cycles refused, delete keeps the contents', () => {
  const items = useItemsStore.getState();
  items.setItemsMeta(EMPTY_ITEMS_META);
  const outer = items.createFolder({ name: 'Outer', keys: ['body:A'] });
  const inner = useItemsStore.getState().createFolder({ name: 'Inner', parentId: outer });
  assert.equal(useItemsStore.getState().parent['folder:' + inner], outer);
  // A folder cannot go into its own descendant.
  assert.equal(useItemsStore.getState().moveToFolder([`folder:${outer}`], inner), false);
  assert.equal(useItemsStore.getState().moveToFolder(['body:A'], inner), true);
  useItemsStore.getState().deleteFolder(inner);
  assert.equal(useItemsStore.getState().parent['body:A'], outer);
  useItemsStore.getState().renameBody('A', '  Lid ');
  assert.equal(useItemsStore.getState().names.A, 'Lid');
  const named = withDisplayNames([{ id: 'A', name: 'Body 1' }], useItemsStore.getState());
  assert.equal(named[0]!.name, 'Lid');
  useItemsStore.getState().renameBody('A', '');
  assert.equal(useItemsStore.getState().names.A, undefined);
  items.setItemsMeta(EMPTY_ITEMS_META);
});

void test('project files carry item names/folders (validated) and stay loadable without them', () => {
  const text = saveProjectFile({
    projectName: 'P',
    features: demo,
    appVersion: 'test',
    createdAt: new Date(0).toISOString(),
    items: {
      names: { 'body:feature-extrude-1': 'Bracket A' },
      folders: [{ id: 'f1', name: 'Printed', collapsed: true }],
      parent: { 'body:body:feature-extrude-1': 'f1' },
    },
    viewState: {
      savedViews: [{ name: 'Front', pose: { target: [0, 0, 0], distance: 100, yaw: 0, pitch: 0 } }],
    },
  });
  const loaded = loadProjectFile(text);
  assert.equal(loaded.items?.names['body:feature-extrude-1'], 'Bracket A');
  assert.equal(loaded.items?.folders[0]?.collapsed, true);
  assert.equal(parseSavedViews(loaded.viewState?.savedViews).length, 1);
  const bad = JSON.parse(text) as Record<string, unknown>;
  bad.items = { folders: [{ id: 'f1', name: 3 }] };
  assert.throws(() => loadProjectFile(JSON.stringify(bad)), /items\.folders\[0\]\.name/);
  delete bad.items;
  assert.equal(loadProjectFile(JSON.stringify(bad)).items, undefined);
});

void test('saved views: up to eight, malformed entries dropped on load', () => {
  const ws = useWorkspaceStore.getState();
  ws.setSavedViews([]);
  assert.equal(ws.saveCurrentView(), false); // no viewport mounted
  setCameraPoseProbe(() => ({ target: [1, 2, 3], distance: 50, yaw: 0.5, pitch: 0.2 }));
  for (let i = 0; i < MAX_SAVED_VIEWS; i += 1)
    assert.equal(useWorkspaceStore.getState().saveCurrentView(), true);
  assert.equal(useWorkspaceStore.getState().saveCurrentView(), false);
  const views = useWorkspaceStore.getState().savedViews;
  assert.equal(views.length, MAX_SAVED_VIEWS);
  assert.equal(views[0]!.name, 'View 1');
  useWorkspaceStore.getState().restoreView(0);
  assert.deepEqual(useWorkspaceStore.getState().cameraCommand?.command, {
    kind: 'pose',
    pose: views[0]!.pose,
  });
  setCameraPoseProbe(null);
  useWorkspaceStore.getState().setSavedViews([]);
  const parsed = parseSavedViews([
    { name: 'ok', pose: { target: [0, 0, 0], distance: 10, yaw: 0, pitch: 0, fov: 0 } },
    { name: 'bad', pose: { target: [0, 0], distance: 10, yaw: 0, pitch: 0 } },
    { name: 'neg', pose: { target: [0, 0, 0], distance: -1, yaw: 0, pitch: 0 } },
    'nonsense',
  ]);
  assert.deepEqual(
    parsed.map((v) => v.name),
    ['ok'],
  );
  assert.equal(parsed[0]!.pose.fov, 0);
});

void test('preferences: invalid stored values fall back to the defaults; units convert for display', () => {
  assert.deepEqual(parsePreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(parsePreferences('not json'), DEFAULT_PREFERENCES);
  const parsed = parsePreferences(
    JSON.stringify({ units: 'in', fov: 500, theme: 'light', navigationPreset: 'fusion', extra: 1 }),
  );
  assert.equal(parsed.units, 'in');
  assert.equal(parsed.fov, DEFAULT_PREFERENCES.fov);
  assert.equal(parsed.theme, 'light');
  assert.equal(parsed.navigationPreset, 'fusion');
  assert.equal(formatLength(25.4, 'in'), '1 in');
  assert.equal(formatLength(12.345, 'mm'), '12.35 mm');
  assert.equal(fromDisplayUnit(2, 'in'), 50.8);
});

void test('body colour: a new setAppearance step, updated in place while it is the last step', () => {
  let n = 0;
  const allocate = () => ({ id: `appearance-${++n}`, name: `Appearance ${n}` });
  const first = withBodyColour(demo, demo.length, ['body:feature-extrude-1'], '#FF0000', allocate);
  assert.equal(first.length, demo.length + 1);
  const step = first.at(-1)!;
  assert.equal(step.kind, 'setAppearance');
  const again = withBodyColour(
    first,
    first.length,
    ['body:feature-extrude-1'],
    '#00FF00',
    allocate,
  );
  assert.equal(again.length, first.length);
  const last = again.at(-1)!;
  assert.equal(last.kind === 'setAppearance' ? last.color : null, '#00FF00');
  const two = withBodyColour(demo, demo.length, ['a', 'b'], '#123456', allocate);
  assert.equal(two.length, demo.length + 2);
  assert.equal(normalizeHexColour('abc'), '#AABBCC');
  assert.equal(normalizeHexColour('#12345g'), null);
});

void test('shortcut sheet: generated from the registry, no two commands share a shortcut', () => {
  assert.deepEqual(shortcutConflicts(), []);
  const sections = shortcutSections(true);
  const all = sections.flatMap((s) => s.rows);
  assert.ok(all.some((r) => r.label === 'Select Through' && r.keys === 'Ctrl+Shift+S'));
  assert.ok(all.some((r) => r.label === 'Extrude' && r.keys === 'E'));
  // Single-key hotkeys off: plain letters disappear from the sheet.
  const modified = shortcutSections(false).flatMap((s) => s.rows);
  assert.ok(!modified.some((r) => /^[A-Z]$/.test(r.keys)));
  assert.ok(modified.some((r) => r.keys === 'Ctrl+Z'));
});

void test('shortcuts: P is Project in a sketch and Printability in the model (scoped keys)', () => {
  const key = (k: string) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    targetIsTextInput: false,
  });
  const ctx = { activeTool: null } as unknown as CommandContext;
  assert.equal(resolveShortcut(key('p'), ctx, 'sketch')?.id, 'sketch.project');
  assert.equal(resolveShortcut(key('p'), ctx, 'model')?.id, 'modes.print');
  assert.equal(resolveShortcut(key('p'), ctx)?.id, 'modes.print', 'model is the default scope');
  // Unscoped keys resolve in both contexts.
  assert.equal(resolveShortcut(key('l'), ctx, 'sketch')?.id, 'sketch.line');
  assert.equal(resolveShortcut(key('l'), ctx, 'model')?.id, 'sketch.line');
  // Sketch-only tools do not resolve outside a sketch.
  assert.equal(resolveShortcut(key('t'), ctx, 'model'), null);
  // Every shared key is scoped disjointly.
  const byKey = new Map<string, Command[]>();
  for (const c of COMMANDS) {
    if (c.shortcut) byKey.set(c.shortcut, [...(byKey.get(c.shortcut) ?? []), c]);
  }
  for (const [shortcut, commands] of byKey) {
    if (commands.length < 2) continue;
    const scopes = commands.map((c) => c.shortcutScope);
    assert.ok(!scopes.includes(undefined), `${shortcut}: shared keys are scoped`);
    assert.equal(new Set(scopes).size, scopes.length, `${shortcut}: scopes are disjoint`);
  }
});
