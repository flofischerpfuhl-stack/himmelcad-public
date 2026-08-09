import assert from 'node:assert/strict';
import test from 'node:test';

import type { CanonicalEntity, JournalMirror } from '@himmelcad/app';

import { projectSnapshotFromJournalMirror } from '../renderer/src/projectProjection.js';

void test('canonical mirror projects exact identities, hierarchy and version hashes into the tree', () => {
  const root = entity('project-root', 'hcad.group@1', null, 'root-version');
  const group = entity('survey', 'hcad.group@1', root.id, 'group-version');
  const cloud = entity('cloud', 'hcad.point-cloud@1', group.id, 'cloud-version');
  const orphan = entity('orphan', 'hcad.bim-object@1', null, 'ifc-version');
  const mirror: JournalMirror = {
    status: 'ready',
    generation: 4,
    appliedThroughSequence: 4,
    entities: { [root.id]: root, [group.id]: group, [cloud.id]: cloud, [orphan.id]: orphan },
    tombstones: {},
  };

  const project = projectSnapshotFromJournalMirror(mirror);

  assert.equal(project.rootEntity, root.id);
  assert.equal(project.name, root.name);
  assert.deepEqual(project.entities[root.id]?.children, [group.id, orphan.id]);
  assert.deepEqual(project.entities[group.id]?.children, [cloud.id]);
  assert.equal(project.entities[cloud.id]?.kind, 'PointCloud');
  assert.equal(project.entities[cloud.id]?.versionHash, cloud.versionHash);
  assert.equal(project.entities[cloud.id]?.bounds, null);
  assert.equal(project.entities[orphan.id]?.parent, root.id);
  assert.equal(project.entities[orphan.id]?.kind, 'IfcElement');
});

void test('canonical projection rejects an empty live document instead of fabricating a root', () => {
  assert.throws(
    () =>
      projectSnapshotFromJournalMirror({
        status: 'ready',
        generation: 0,
        appliedThroughSequence: 0,
        entities: {},
        tombstones: {},
      }),
    /no live root entity/,
  );
});

function entity(
  id: string,
  typeId: string,
  owner: string | null,
  versionHash: string,
): CanonicalEntity {
  return {
    id,
    revision: 1,
    typeId,
    name: id === 'project-root' ? 'Builder project' : id,
    owner,
    layerIds: [],
    placement: null,
    representations: [],
    componentsRef: 'a'.repeat(64),
    attributesRef: 'b'.repeat(64),
    relationsRef: 'c'.repeat(64),
    styleRef: null,
    schemaVersion: 1,
    versionHash,
  };
}
