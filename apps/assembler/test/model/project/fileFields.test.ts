/**
 * `.hcasm` byte compatibility of the project-level file fields the modules
 * register (items, reference meshes, the view-state parts, pinned
 * measurements, saved views): a project that uses every section, written in
 * the order the app has always written it, opens and saves back to the same
 * bytes (apart from `modifiedAt`), and the checked-in fixtures keep their
 * features, units and names through Open → Save → Open.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { useItemsStore } from '../../../renderer/src/foundation/commands/items.js';
import { useAssemblerStore } from '../../../renderer/src/foundation/commands/store.js';
import {
  loadProjectFile,
  PROJECT_FORMAT_ID,
  CURRENT_SCHEMA_VERSION,
} from '../../../renderer/src/foundation/document/format.js';
import { encodeMeshPayload } from '../../../renderer/src/foundation/document/meshCodec.js';
import {
  currentProjectText,
  useProjectStore,
} from '../../../renderer/src/interface/shell-ui/project/projectStore.js';
import { useWorkspaceStore } from '../../../renderer/src/interface/shell-ui/workspace.js';
import { useMeasureStore } from '../../../renderer/src/modules/measure/measureStore.js';

// Compiled to `.build/tests/apps/assembler/test/model/project/`; fixtures live in the sources.
const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(here, '..', '..', '..', '..', '..', '..', '..');
const FIXTURES = join(APP_DIR, 'test', 'fixtures');

const MODIFIED_AT = '2026-09-30T12:00:00.000Z';

function withModifiedAt(text: string): string {
  return text.replace(/"modifiedAt": "[^"]*"/, `"modifiedAt": "${MODIFIED_AT}"`);
}

/** A project using every section, in the key order the app writes. */
async function fullProjectText(): Promise<string> {
  // The fixture's features as the current schema stores them (it was written by an older one).
  const phoneStand = loadProjectFile(readFileSync(join(FIXTURES, 'phone-stand.hcasm'), 'utf8'));
  const bodyId = `body:${phoneStand.features.at(-1)!.id}`;
  const data = await encodeMeshPayload({
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  });
  const file = {
    format: PROJECT_FORMAT_ID,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appVersion: '0.1.0-phase1',
    units: 'mm',
    projectName: 'Every section',
    features: phoneStand.features,
    parameters: [{ id: 'p1', name: 'width', unit: 'mm', value: 40 }],
    referenceMeshes: [
      {
        id: 'scan-1',
        name: 'Scan',
        fileName: 'scan.stl',
        data,
        min: [0, 0, 0],
        max: [10, 10, 0],
        transform: { dx: 5, dy: 0, dz: 1 },
        hidden: false,
        color: '#FF8800',
      },
    ],
    viewState: {
      displayMode: 'xray',
      display: { edges: false, hiddenEdges: true, axes: false },
      camera: { preset: 'top' },
      section: {
        enabled: true,
        axis: 'Y',
        offset: 12.5,
        flipped: true,
        plane: { normal: [0, 0, 1], origin: [1, 2, 3], label: 'Face of Stand' },
        sectionOnly: true,
      },
      measurements: [
        {
          refs: [
            { kind: 'body', bodyId },
            { kind: 'point', point: [1, 2, 3], label: 'Point' },
          ],
          showInViewport: false,
        },
      ],
      grid: { visible: false, snap: true, step: 2.5, auto: false },
      panels: { items: false, history: true, parameters: true },
      savedViews: [
        {
          name: 'Detail',
          pose: { target: [1, 2, 3], distance: 120, yaw: 0.5, pitch: 0.3 },
          section: {
            enabled: true,
            axis: 'X',
            offset: 4,
            flipped: false,
            plane: null,
            sectionOnly: false,
          },
        },
      ],
    },
    items: {
      names: { [bodyId]: 'Stand' },
      folders: [{ id: 'folder-1', name: 'Parts', collapsed: true }],
      parent: { [bodyId]: 'folder-1', 'mesh:scan-1': 'folder-1' },
    },
    createdAt: '2026-09-01T08:00:00.000Z',
    modifiedAt: MODIFIED_AT,
  };
  return JSON.stringify(file, null, 2);
}

void test('a project with every file section opens and saves back byte for byte', async () => {
  const text = await fullProjectText();
  const opened = await useProjectStore.getState().openFromResult({ path: null, text });
  assert.equal(opened, true, useProjectStore.getState().loadError ?? '');
  // The sections reached their modules.
  assert.equal(useAssemblerStore.getState().referenceMeshes.length, 1);
  assert.equal(useMeasureStore.getState().pins.length, 1);
  assert.equal(useWorkspaceStore.getState().savedViews.length, 1);
  assert.equal(useItemsStore.getState().folders[0]?.name, 'Parts');
  assert.equal(useAssemblerStore.getState().viewState.displayMode, 'xray');
  assert.equal(useProjectStore.getState().dirty, false);

  const saved = await currentProjectText();
  assert.equal(withModifiedAt(saved), text);
});

void test('a project without the optional sections saves them as before', async () => {
  useProjectStore.getState().newProject('Blank');
  const saved = JSON.parse(await currentProjectText()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(saved), [
    'format',
    'schemaVersion',
    'appVersion',
    'units',
    'projectName',
    'features',
    'parameters',
    'viewState',
    'createdAt',
    'modifiedAt',
  ]);
  assert.deepEqual(Object.keys(saved.viewState as object), [
    'displayMode',
    'display',
    'camera',
    'section',
    'grid',
    'panels',
  ]);
});

void test('the checked-in fixtures keep their features through Open → Save → Open', async () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.hcasm'));
  assert.ok(files.length >= 5);
  for (const name of files) {
    const text = readFileSync(join(FIXTURES, name), 'utf8');
    const original = loadProjectFile(text);
    assert.equal(await useProjectStore.getState().openFromResult({ path: null, text }), true);
    const again = loadProjectFile(await currentProjectText());
    assert.equal(again.projectName, original.projectName, name);
    assert.equal(again.createdAt, original.createdAt, name);
    assert.deepEqual(again.features, original.features, name);
    assert.deepEqual(again.parameters, original.parameters, name);
  }
});
