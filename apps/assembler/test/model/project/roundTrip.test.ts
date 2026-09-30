/**
 * Save → Open round trip of everything a `.hcasm` carries besides the
 * feature list: item names and folders (`items`), saved views and the rest of
 * the view state (section, grid, display mode) in one `viewState` object, and
 * STL reference meshes. Saving goes through the Electron path with a stubbed
 * `window.assembler` (no Electron needed).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { appSessionHost } from '../../../renderer/src/interface/agent-api/automationStore.js';
import { ApiError } from '../../../renderer/src/foundation/commands/api/errors.js';
import { AgentSession } from '../../../renderer/src/interface/agent-api/session.js';

import { createDemoDocument } from '../../../renderer/src/foundation/commands/demoDocument.js';
import {
  bodyRowKey,
  meshRowKey,
  useItemsStore,
} from '../../../renderer/src/interface/shell-ui/items.js';
import { loadProjectFile } from '../../../renderer/src/foundation/document/format.js';
import { useProjectStore } from '../../../renderer/src/interface/shell-ui/project/projectStore.js';
import { useAssemblerStore } from '../../../renderer/src/foundation/commands/store.js';
import { useWorkspaceStore } from '../../../renderer/src/interface/shell-ui/workspace.js';
import { createNodeKernelAdapter } from '../../kernel/nodeKernel.js';

let savedText: string | null = null;
(globalThis as unknown as { window: unknown }).window = {
  assembler: {
    project: {
      save: async (_path: string, text: string) => {
        savedText = text;
      },
      saveDialog: async () => ({ path: 'C:/work/roundtrip.hcasm' }),
      writeRecovery: async () => undefined,
      readRecovery: async () => null,
      clearRecovery: async () => undefined,
    },
  },
};

void test('save and reopen keep item names, folders, saved views, view state and reference meshes', async () => {
  const doc = useAssemblerStore.getState();
  doc.loadDocument(createDemoDocument(), { projectName: 'Round trip' });
  const bodyId = 'body:feature-extrude-1';
  doc.importReferenceMesh({
    id: 'scan-1',
    name: 'Scan',
    fileName: 'scan.stl',
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    min: [0, 0, 0],
    max: [10, 10, 0],
    transform: { dx: 5, dy: 0, dz: 1 },
    hidden: false,
  });
  useItemsStore.getState().renameBody(bodyId, 'Base plate');
  const folderId = useItemsStore
    .getState()
    .createFolder({ name: 'Parts', keys: [bodyRowKey(bodyId), meshRowKey('scan-1')] });
  const pose = {
    target: [1, 2, 3] as [number, number, number],
    distance: 120,
    yaw: 0.5,
    pitch: 0.3,
  };
  useWorkspaceStore.getState().setSavedViews([{ name: 'Detail', pose }]);
  doc.setSectionEnabled(true);
  doc.setSectionAxis('Y');
  doc.setDisplayMode('wireframe');

  useProjectStore.setState({ filePath: 'C:/work/roundtrip.hcasm' });
  await useProjectStore.getState().save();
  assert.ok(savedText, 'the project was written');
  const file = loadProjectFile(savedText);
  // One view-state object: the saved views must not replace section/display state.
  assert.equal(file.viewState?.savedViews?.length, 1);
  assert.equal(file.viewState?.section?.axis, 'Y');
  assert.equal(file.viewState?.displayMode, 'wireframe');
  assert.equal(file.referenceMeshes?.length, 1);
  assert.equal(file.items?.names[bodyId], 'Base plate');

  // Something else in between, then reopen.
  useProjectStore.getState().newProject();
  assert.equal(useAssemblerStore.getState().referenceMeshes.length, 0);
  assert.equal(useWorkspaceStore.getState().savedViews.length, 0);
  useAssemblerStore.getState().setSectionEnabled(false);
  useAssemblerStore.getState().setDisplayMode('shaded');

  await useProjectStore
    .getState()
    .openFromResult({ path: 'C:/work/roundtrip.hcasm', text: savedText });
  const reopened = useAssemblerStore.getState();
  assert.equal(useProjectStore.getState().dirty, false, 'a freshly opened project is clean');
  assert.equal(reopened.projectName, 'Round trip');
  assert.equal(reopened.viewState.sectionEnabled, true);
  assert.equal(reopened.viewState.sectionAxis, 'Y');
  assert.equal(reopened.viewState.displayMode, 'wireframe');
  const mesh = reopened.referenceMeshes[0];
  assert.ok(mesh);
  assert.equal(mesh.name, 'Scan');
  assert.deepEqual(mesh.transform, { dx: 5, dy: 0, dz: 1 });
  assert.deepEqual([...mesh.positions], [0, 0, 0, 10, 0, 0, 0, 10, 0]);
  const items = useItemsStore.getState();
  assert.equal(items.names[bodyId], 'Base plate');
  assert.equal(items.folders.find((f) => f.id === folderId)?.name, 'Parts');
  assert.equal(items.parent[meshRowKey('scan-1')], folderId);
  assert.deepEqual(useWorkspaceStore.getState().savedViews, [{ name: 'Detail', pose }]);
});

void test('undo back to the saved state makes the project clean again', () => {
  useProjectStore.getState().newProject();
  const doc = useAssemblerStore.getState();
  doc.addFeature({
    id: 'a1',
    name: 'Appearance',
    suppressed: false,
    kind: 'setAppearance',
    bodyId: 'body:none',
    color: '#FF0000',
  });
  assert.equal(useProjectStore.getState().dirty, true);
  useAssemblerStore.getState().undo();
  assert.equal(useProjectStore.getState().dirty, false);
  // Item edits keep it dirty even when the features are back.
  useAssemblerStore.getState().redo();
  useItemsStore.getState().createFolder({ name: 'F' });
  useAssemblerStore.getState().undo();
  assert.equal(useProjectStore.getState().dirty, true);
});

void test('agent open/save in the app use the project store (items, meshes, clean state)', async () => {
  const kernel = createNodeKernelAdapter();
  useAssemblerStore.getState().attachKernel(kernel);
  const session = new AgentSession({ store: useAssemblerStore, kernel, host: appSessionHost() });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    session.handle(method, params) as Promise<Record<string, unknown>>;
  useProjectStore.getState().newProject();
  assert.ok(savedText, 'the first test saved a project');
  await call('project.open', { text: savedText });
  assert.equal(useProjectStore.getState().dirty, false, 'an agent open leaves the app clean');
  assert.equal(useAssemblerStore.getState().referenceMeshes.length, 1, 'meshes restored');
  assert.equal(useItemsStore.getState().folders[0]?.name, 'Parts', 'folders restored');
  // An agent save returns the full project, not only the features.
  const saved = (await call('project.save', { name: 'Agent copy' })) as { text: string };
  const file = loadProjectFile(saved.text);
  assert.equal(file.projectName, 'Agent copy');
  assert.equal(file.referenceMeshes?.length, 1);
  assert.equal(file.items?.folders[0]?.name, 'Parts');
  // A second open right away is allowed (nothing unsaved) …
  await call('project.open', { text: savedText });
  // … but not after the user changed something.
  useItemsStore.getState().renameFolder(useItemsStore.getState().folders[0]!.id, 'Changed');
  await assert.rejects(
    call('project.open', { text: savedText }),
    (error: unknown) => error instanceof ApiError && error.code === 'confirmationRequired',
  );
});
