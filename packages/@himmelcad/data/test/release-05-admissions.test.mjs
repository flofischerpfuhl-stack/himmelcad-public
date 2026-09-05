import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repository = new URL('../../../../', import.meta.url);
const schema = JSON.parse(
  await readFile(new URL('schemas/automation/himmelcad-automation-v1.schema.json', repository)),
);

const requiredRows = [
  'measurement.create', 'measurement.list', 'measurement.get',
  'measurement.update_anchor', 'measurement.detach_anchor', 'measurement.rebind_anchor',
  'measurement.rename', 'measurement.set_layer', 'measurement.set_visibility',
  'measurement.remove', 'inspect.point_info', 'view.state.get', 'view.state.set',
  'view.diagnostics.get', 'view.diagnostics.sample',
  'viewing_box.place', 'viewing_box.update', 'viewing_box.set_operation',
  'viewing_box.lock', 'viewing_box.unlock', 'viewing_box.rename',
  'viewing_box.activate', 'viewing_box.deactivate', 'viewing_box.remove',
  'viewing_box.list', 'view.presentation.set', 'view.point_size.set',
  'snapshot.create', 'snapshot.list', 'snapshot.rename', 'snapshot.restore',
  'snapshot.delete', 'derived.recipe.get', 'derived.recipe.list',
  'derived.recipe.status', 'derived.recipe.regenerate', 'derived.recipe.regenerate_batch',
  'derived.recipe.detach', 'derived.recipe.relink', 'mesh.surface.draft.list',
  'mesh.surface.draft.get', 'mesh.surface.draft.create', 'mesh.surface.draft.set',
  'mesh.surface.draft.apply_fix', 'mesh.surface.draft.history', 'mesh.surface.draft.undo',
  'mesh.surface.draft.redo', 'mesh.surface.draft.suspend', 'mesh.surface.draft.resume',
  'mesh.surface.draft.discard', 'mesh.surface.check', 'mesh.surface.create',
  'mesh.surface.edit.add_breakline', 'mesh.surface.edit.remove_breakline',
  'mesh.surface.edit.add_form_line', 'mesh.surface.edit.remove_form_line',
  'mesh.surface.edit.set_source_role', 'mesh.simplify.preview', 'mesh.simplify.check',
  'mesh.simplify.bake', 'draw.point.create', 'draw.curve.create',
  'draw.support_role.get', 'draw.support_role.set', 'draw.support_role.clear',
  'view.support_overlay.get', 'view.support_overlay.set', 'selection.granularity.get',
  'select.get', 'select.list', 'select.set', 'select.add', 'select.remove', 'select.clear',
  'select.toggle', 'select.undo', 'select.redo', 'select.candidates',
  'selection.granularity.set', 'selection.kind_filter.get', 'selection.kind_filter.set',
  'interaction.state.explain', 'interaction.state.preview', 'interaction.state.apply',
  'view.labels.global.get', 'view.labels.global.set', 'view.labels.entity.get',
  'view.labels.entity.set',
  'selection.history.get', 'selection.history.undo', 'selection.history.redo',
  'selection.history.clear', 'display.history.get', 'display.history.undo',
  'display.history.redo', 'display.history.clear', 'camera.history.get',
  'camera.history.undo', 'camera.history.redo', 'camera.history.clear',
];

void test('G-S01-P11 exposes every admitted row in the single generated command table', () => {
  for (const row of requiredRows) assert.ok(schema.methods[row], `missing ${row}`);
  assert.equal(schema.methods['view.state.get'].response, 'ViewStateV2');
  assert.equal(schema.methods['view.state.set'].request, 'ViewStateV2');
  assert.deepEqual(schema.methods['view.diagnostics.sample'], {
    capability: 'view.read',
    request: 'ViewDiagnosticsSampleRequest',
    response: 'ViewDiagnosticsSampleResult',
  });
});

void test('G-S01-DEFERRED keeps deferred producer rows unavailable', () => {
  for (const row of [
    'measurement.report.generate', 'draw.offset.apply', 'draw.trim.apply',
    'draw.divide.apply', 'plan.create', 'journal.actor.create',
  ]) assert.equal(schema.methods[row], undefined, `${row} must remain deferred`);
});
