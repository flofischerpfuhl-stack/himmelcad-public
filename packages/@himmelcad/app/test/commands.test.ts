import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMAND_REGISTRY,
  QUICK_SURFACE_ENTRY_CAP,
  assertRuntimeCommandRegistry,
  commandsForSurface,
  completeConsoleCommand,
  consoleHelpEntries,
  dispatchRegistryShortcut,
  executeAutomationCommand,
  executeConsoleLine,
  type CommandContext,
  type CommandInvocation,
} from '../src/index.js';

const base = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  hasProject: true,
  selectedEntityIds: [],
  selectedEntityKinds: [],
  selectionVisibility: 'visible',
  selectionEditable: true,
  selectionExportable: false,
  clipboardAdmissible: false,
  candidates: [],
  ...overrides,
});

void test('G-UIP-CMD every generated row is reachable and runtime shortcuts do not collide', () => {
  assert.doesNotThrow(assertRuntimeCommandRegistry);
  for (const entry of COMMAND_REGISTRY) {
    assert.equal(
      entry.surfaces.ribbon || entry.surfaces.contextMenu || entry.surfaces.quickSurface,
      true,
      entry.id,
    );
  }
});

void test('context menu content follows selection kind and cloud stays deliberate', () => {
  const ids = (kind: CommandContext['selectedEntityKinds'][number], exportable = false) =>
    commandsForSurface(
      'contextMenu',
      base({
        selectedEntityIds: ['selected'],
        selectedEntityKinds: [kind],
        selectionExportable: exportable,
        candidates: [
          { entityId: 'selected', kind: 'Object', name: 'Selected' },
          { entityId: 'behind', kind: 'Object', name: 'Behind' },
        ],
      }),
    ).map((entry) => entry.id);
  assert.deepEqual(ids('point'), [
    'select.set', 'entity.rename', 'entity.zoom_to', 'entity.hide', 'entity.isolate', 'entity.properties',
  ]);
  assert.deepEqual(ids('polyline', true), [
    'select.set', 'entity.rename', 'entity.zoom_to', 'entity.hide', 'entity.isolate', 'entity.properties', 'entity.export',
  ]);
  assert.deepEqual(ids('mesh', true), ids('polyline', true));
  assert.deepEqual(ids('cloud', true), [
    'select.set', 'entity.zoom_to', 'entity.hide', 'entity.isolate', 'entity.properties',
  ]);
});

void test('UIP-D13 quick surface is capped and selection-sensitive', () => {
  const entries = commandsForSurface(
    'quickSurface',
    base({ selectedEntityIds: ['a'], selectedEntityKinds: ['point'], clipboardAdmissible: true }),
  );
  assert.equal(entries.length, QUICK_SURFACE_ENTRY_CAP);
  assert.ok(entries.some((entry) => entry.id === 'select.clear'));
  assert.ok(entries.some((entry) => entry.id === 'edit.clipboard.paste_in_place'));
});

void test('console help and completion are derived exactly from the table', async () => {
  const result = await executeConsoleLine('help', base(), () => undefined);
  assert.equal(result.kind, 'help');
  if (result.kind === 'help') {
    assert.deepEqual(result.lines.map((line) => line.split(/\s/)[0]), consoleHelpEntries().map((entry) => entry.id));
  }
  assert.deepEqual(completeConsoleCommand('view.preset.'), [
    'view.preset.top', 'view.preset.front', 'view.preset.right', 'view.preset.isometric',
  ]);
});

void test('shortcut dispatcher and three automation commands round-trip through registry entries', async () => {
  const calls: CommandInvocation[] = [];
  const execute = (invocation: CommandInvocation): void => { calls.push(invocation); };
  let prevented = false;
  assert.equal(dispatchRegistryShortcut({
    key: 'f', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    preventDefault: () => { prevented = true; },
  }, base(), execute), true);
  assert.equal(prevented, true);
  await executeAutomationCommand('view.frame', {}, base(), execute);
  await executeAutomationCommand('select.clear', {}, base({ selectedEntityIds: ['a'], selectedEntityKinds: ['point'] }), execute);
  await executeAutomationCommand('view.preset.top', {}, base(), execute);
  assert.deepEqual(calls.map((call) => call.id), ['view.frame', 'view.frame', 'select.clear', 'view.preset.top']);
});
