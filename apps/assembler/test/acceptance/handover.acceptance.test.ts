/**
 * PLAN §7 hand-over and persistence cases on the headless path: an agent
 * creates, the UI's own edit path changes a dimension and a parameter, the
 * agent reads the new volume (one shared document, revision and undo
 * stack); save → reopen and the crash-recovery payload restore the same
 * geometry. (The same flows in the real Electron app, including killing the
 * kernel worker and the app: `electron.acceptance.test.ts`.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadProjectFile } from '../../renderer/src/foundation/document/format.js';
import { currentProjectText } from '../../renderer/src/interface/shell-ui/project/projectStore.js';
import type { SketchFeature } from '../../renderer/src/foundation/document/document.js';
import { setSketchDimension } from '../../renderer/src/sketch/featureOps.js';
import { projectTemplate } from '../../renderer/src/templates/projectTemplates.js';
import { bodies, call, evidence, near, reset, store, type Json } from './harness.js';

void test('H1 UI/agent hand-over: agent creates, the UI edits a dimension and a parameter, the agent reads the volume', async (t) => {
  await reset('Hand-over');
  // Agent: a 40 × 30 plate, 10 mm, its height driven by a parameter.
  await call('parameter.create', { name: 'thickness', unit: 'mm', value: 10 });
  const sketch = await call<{ featureId: string; shapes: { dimensions: Json }[] }>(
    'feature.create',
    {
      kind: 'sketch',
      params: {
        plane: { kind: 'plane', plane: 'XY', offset: 0 },
        profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 40, height: 30 }],
      },
    },
  );
  const extrude = await call<{ featureId: string }>('feature.create', {
    kind: 'extrude',
    params: {
      profile: { kind: 'sketch', featureId: sketch.featureId },
      distanceExpression: 'thickness',
    },
  });
  const bodyId = `body:${extrude.featureId}`;
  const rev0 = (await call<{ revision: number }>('document.get')).revision;
  near((await call<{ volume: number }>('body.get', { bodyId })).volume, 40 * 30 * 10);

  // UI: the History panel's dimension edit (the same function the card calls).
  const widthName = sketch.shapes[0]!.dimensions.width as string;
  const feature = store.getState().features.find((f) => f.id === sketch.featureId) as SketchFeature;
  const widthId = feature.dimensions.find((d) => d.name === widthName)!.id;
  assert.equal(await setSketchDimension(sketch.featureId, widthId, 60), null);
  await store.getState().whenSettled();
  // UI: the Parameters panel edit.
  const edited = await store.getState().editParameter({ id: 'thickness', value: 12 });
  assert.ok(edited.ok, edited.ok ? '' : edited.message);
  await store.getState().whenSettled();

  // Agent reads the new state.
  const after = await call<{ volume: number; bbox: { size: number[] }; valid: boolean }>(
    'body.get',
    { bodyId },
  );
  near(after.volume, 60 * 30 * 12, 1e-9, 'volume after the UI edits');
  assert.deepEqual(after.bbox.size, [60, 30, 12]);
  const rev1 = (await call<{ revision: number }>('document.get')).revision;
  assert.equal(rev1, rev0 + 2, 'two UI edits = two revisions the agent sees');

  // One undo stack: the agent undoes the UI's parameter edit, the UI undoes the agent's.
  await call('history.undo');
  near((await call<{ volume: number }>('body.get', { bodyId })).volume, 60 * 30 * 10);
  await call('feature.edit', { featureId: extrude.featureId, params: { distance: 5 } });
  store.getState().undo();
  await store.getState().whenSettled();
  near((await call<{ volume: number }>('body.get', { bodyId })).volume, 60 * 30 * 10);
  evidence(t, 'H1-handover', {
    agentCreated: { sketch: sketch.featureId, extrude: extrude.featureId },
    uiEdits: ['width 40 → 60 (History dimension edit)', 'thickness 10 → 12 (Parameters)'],
    agentReadVolume: after.volume,
    revisions: [rev0, rev1],
  });
});

void test('S1 save → reopen and the recovery payload restore the same document', async (t) => {
  await reset('Persistence');
  await projectTemplate('enclosure').build((m, p) => call(m, p ?? {}));
  const original = await bodies();
  const features = store.getState().features;
  const parameters = store.getState().parameters;

  // The agent's project.save text and File > Save's text are the same serializer.
  const saved = await call<{ text: string; byteLength: number }>('project.save', {
    name: 'Enclosure',
  });
  await reset('Other');
  const reopened = await call<{ errors: Json; featureCount: number }>('project.open', {
    text: saved.text,
  });
  assert.deepEqual(reopened.errors, {});
  assert.equal(reopened.featureCount, features.length);
  assert.deepEqual(store.getState().features, JSON.parse(JSON.stringify(features)));
  assert.deepEqual(store.getState().parameters, parameters);
  const again = await bodies();
  assert.deepEqual(
    again.map((b) => [b.name, b.volume, b.valid]),
    original.map((b) => [b.name, b.volume, b.valid]),
  );

  // The crash-recovery copy (autosave) is the File > Save payload of the live document.
  const recovery = loadProjectFile(await currentProjectText());
  assert.equal(recovery.features.length, features.length);
  store.getState().loadDocument(recovery.features, {
    projectName: recovery.projectName,
    parameters: recovery.parameters,
  });
  await store.getState().whenSettled();
  assert.deepEqual(
    (await bodies()).map((b) => [b.name, b.volume]),
    original.map((b) => [b.name, b.volume]),
  );
  evidence(t, 'S1-save-reopen', {
    bytes: saved.byteLength,
    features: features.length,
    parameters: parameters.map((p) => p.name),
    bodies: again.map((b) => ({ name: b.name, volume: b.volume })),
    recoveryFeatures: recovery.features.length,
  });
});
