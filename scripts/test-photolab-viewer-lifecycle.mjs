/* global process */

import assert from 'node:assert/strict';

import {
  EntityLoadGenerationGuard,
  ProjectRefreshGuard,
  entityLoadToken,
  newlyFailedJobIds,
  requiresFullSceneReset,
} from '../apps/photolab/renderer/src/viewerLifecycle.ts';

const origin = { projectId: 'project-a', renderOffset: [4_000_000, 5_000_000, 700] };
assert.equal(requiresFullSceneReset(null, origin), true);
assert.equal(requiresFullSceneReset(origin, { ...origin }), false);
assert.equal(
  requiresFullSceneReset(origin, {
    projectId: 'project-a',
    renderOffset: [4_000_001, 5_000_000, 700],
  }),
  true,
);
assert.equal(
  requiresFullSceneReset(origin, { projectId: 'project-b', renderOffset: origin.renderOffset }),
  true,
);

const refreshes = new ProjectRefreshGuard();
const firstRefresh = refreshes.begin('project-a');
assert.equal(refreshes.isCurrent(firstRefresh), true);
const secondRefresh = refreshes.begin('project-a');
assert.equal(refreshes.isCurrent(firstRefresh), false);
assert.equal(refreshes.isCurrent(secondRefresh), true);
const otherProjectRefresh = refreshes.begin('project-b');
assert.equal(refreshes.isCurrent(secondRefresh), false);
assert.equal(refreshes.isCurrent(otherProjectRefresh), true);

const layers = new EntityLoadGenerationGuard();
const oldLoad = layers.begin('dem');
const currentLoad = layers.begin('dem');
assert.notEqual(entityLoadToken(oldLoad), entityLoadToken(currentLoad));
assert.equal(layers.isCurrent(oldLoad), false);
assert.equal(layers.isCurrent(currentLoad), true);
layers.invalidate('dem');
assert.equal(layers.isCurrent(currentLoad), false);
const otherEntity = layers.begin('ortho');
assert.equal(layers.isCurrent(otherEntity), true);
layers.reset();
assert.equal(layers.isCurrent(otherEntity), false);

// A visible Potree layer may resolve after workspace switches and a same-project
// snapshot refresh. Neither event is a scene identity change, so the in-flight
// load must remain current and may attach exactly once when it resolves.
const visibleSparseLoad = layers.begin('sparse-visible');
let workspace = 'scene';
workspace = 'images';
assert.equal(workspace, 'images');
assert.equal(requiresFullSceneReset(origin, { ...origin }), false);
refreshes.begin('project-a');
workspace = 'scene';
await Promise.resolve();
assert.equal(workspace, 'scene');
assert.equal(layers.isCurrent(visibleSparseLoad), true);
layers.invalidate('sparse-visible');
assert.equal(layers.isCurrent(visibleSparseLoad), false);

const observedFailures = new Set(['old-failure']);
assert.deepEqual(
  newlyFailedJobIds(
    [
      { id: 'running', state: { kind: 'running' } },
      { id: 'old-failure', state: { kind: 'failed' } },
      { id: 'new-failure', state: { kind: 'failed' } },
    ],
    observedFailures,
  ),
  ['new-failure'],
);

process.stdout.write('PhotoLab viewer lifecycle policy tests passed.\n');
