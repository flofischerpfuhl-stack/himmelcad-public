import assert from 'node:assert/strict';
import { stdout } from 'node:process';

import {
  commonControlPointIds,
  compatibleGcpOptimizations,
  completeAlignmentConnections,
} from '../apps/photolab/renderer/src/alignmentMergeDraft.ts';

function optimization(entityId, alignmentId, publicationSequence, converged, residuals) {
  return {
    entityId,
    optimization: {
      publicationSequence,
      sourceAlignmentEntityId: alignmentId,
      artifact: { result: { converged, residuals } },
    },
  };
}

const missionAOld = optimization('gcp-a-old', 'alignment-a', 4, true, [
  { pointId: 'control-1', role: 'controlXYZ' },
]);
const missionANew = optimization('gcp-a-new', 'alignment-a', 9, true, [
  { pointId: 'control-1', role: 'controlXYZ' },
  { pointId: 'control-2', role: 'controlXY' },
  { pointId: 'checkpoint-only', role: 'checkpoint' },
]);
const missionAFailed = optimization('gcp-a-failed', 'alignment-a', 10, false, []);
const missionB = optimization('gcp-b', 'alignment-b', 7, true, [
  { pointId: 'control-2', role: 'controlZ' },
  { pointId: 'control-1', role: 'controlXYZ' },
  { pointId: 'checkpoint-only', role: 'checkpoint' },
]);

assert.deepEqual(
  compatibleGcpOptimizations('alignment-a', [
    missionANew,
    missionB,
    missionAOld,
    missionAFailed,
  ]).map((entry) => entry.entityId),
  ['gcp-a-old', 'gcp-a-new'],
);
assert.deepEqual(commonControlPointIds([missionANew, missionB]), ['control-1', 'control-2']);
assert.deepEqual(
  completeAlignmentConnections(['alignment-a', 'alignment-b'], 'sharedControls', [
    'control-1',
    'control-2',
  ]),
  [
    {
      kind: 'sharedControls',
      alignmentA: 'alignment-a',
      alignmentB: 'alignment-b',
      controlPointIds: ['control-1', 'control-2'],
    },
  ],
);
assert.equal(completeAlignmentConnections(['a', 'b', 'c'], 'overlap', []).length, 3);

stdout.write('PhotoLab alignment-merge draft test passed.\n');
