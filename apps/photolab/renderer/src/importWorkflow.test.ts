import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  legacyWorkflowMigrationPlan,
  // @ts-expect-error Node's strip-types test runner loads the TypeScript source directly.
} from './importWorkflow.ts';

describe('legacy workflow migration', () => {
  it('selects every valid legacy workflow for one-time file migration', () => {
    const common = {
      schemaVersion: 1,
      name: 'Workflow',
      description: '',
      savedAt: '2026-09-02T10:00:00.000Z',
      mode: 'none',
    };
    const plan = legacyWorkflowMigrationPlan(
      JSON.stringify([
        { ...common, id: 'gcp-1', kind: 'gcp' },
        { ...common, id: 'image-1', kind: 'image' },
        { schemaVersion: 2, id: 'future', name: 'Future', kind: 'gcp' },
      ]),
    );
    assert.deepEqual(
      plan.workflows.map((workflow) => workflow.id),
      ['gcp-1', 'image-1'],
    );
  });

  it('treats malformed storage as empty', () => {
    assert.deepEqual(legacyWorkflowMigrationPlan('{'), {
      workflows: [],
    });
  });
});
