import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  AUTOMATION_COMMAND_ROW_IDS,
  PHOTOLAB_RPC_TO_COMMAND_ROW,
  RIBBON_COMMAND_TO_COMMAND_ROW,
  RIBBON_VIEW_LOCAL_ALLOWLIST,
  SHARED_COMMAND_ROW_IDS,
} from './automationCommandRows.js';
import { createPhotolabRibbonTabs } from './ribbon.js';

const sourceDirectory = fileURLToPath(new URL('.', import.meta.url));

function rendererPhotolabMethods(): string[] {
  const sourceFiles = readdirSync(sourceDirectory)
    .filter((name) => name === 'App.tsx' || name.endsWith('Panel.tsx'))
    .sort();
  const methods = new Set<string>();
  const methodPattern = /['"](photolab\.[A-Za-z0-9_.]+)['"]/g;
  for (const name of sourceFiles) {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8');
    for (const match of source.matchAll(methodPattern)) methods.add(match[1]!);
  }
  return [...methods].sort();
}

function ribbonActionIds(): string[] {
  const noop = (): void => undefined;
  const tabs = createPhotolabRibbonTabs({
    onNewProject: noop,
    onOpenProject: noop,
    onSaveProject: noop,
    onSaveProjectAs: noop,
    onRecentProjects: noop,
    onImportFiles: noop,
    onImportFolder: noop,
    onImportVideo: noop,
    onImportExternal: noop,
    onImportGcps: noop,
    onActivateFunction: noop,
  });
  return tabs.flatMap((tab) =>
    tab.groups.flatMap((group) => group.actions.map((action) => action.id)),
  );
}

test('G-1 maps every renderer PhotoLab RPC to a command row', () => {
  const rowIds = new Set<string>(AUTOMATION_COMMAND_ROW_IDS);
  const missingMappings = rendererPhotolabMethods().filter(
    (method) => !(method in PHOTOLAB_RPC_TO_COMMAND_ROW),
  );
  assert.deepEqual(
    missingMappings,
    [],
    `Add every new renderer photolab.* call to PHOTOLAB_RPC_TO_COMMAND_ROW: ${missingMappings.join(', ')}`,
  );
  for (const [method, rowId] of Object.entries(PHOTOLAB_RPC_TO_COMMAND_ROW)) {
    assert.ok(rowIds.has(rowId), `${method} maps to unknown command row ${rowId}`);
  }
});

test('G-1 maps or explains every ribbon action', () => {
  const rowIds = new Set<string>([...AUTOMATION_COMMAND_ROW_IDS, ...SHARED_COMMAND_ROW_IDS]);
  const actionIds = ribbonActionIds();
  const uncovered = actionIds.filter(
    (id) => !(id in RIBBON_COMMAND_TO_COMMAND_ROW) && !(id in RIBBON_VIEW_LOCAL_ALLOWLIST),
  );
  assert.deepEqual(
    uncovered,
    [],
    `Map each new ribbon action to a command row or document why it is view-local: ${uncovered.join(', ')}`,
  );
  for (const [actionId, rowId] of Object.entries(RIBBON_COMMAND_TO_COMMAND_ROW)) {
    assert.ok(actionIds.includes(actionId), `stale ribbon command mapping: ${actionId}`);
    assert.ok(rowIds.has(rowId), `${actionId} maps to unknown command row ${rowId}`);
  }
  for (const [actionId, reason] of Object.entries(RIBBON_VIEW_LOCAL_ALLOWLIST)) {
    assert.ok(actionIds.includes(actionId), `stale view-local ribbon allowlist entry: ${actionId}`);
    assert.ok(reason.trim().length > 0, `${actionId} needs a view-local reason`);
  }
});
