import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parseNulList, shallowUnknownUntracked } from './git-changes.mjs';
import { createVerificationPlan } from './planner.mjs';

const root = resolve(import.meta.dirname, '../..');
const ids = (plan) => plan.tasks.map((task) => task.id);

describe('verification planner', () => {
  it('parses names with spaces and rename output without line splitting', () => {
    assert.deepEqual(parseNulList('docs/a file.md\0apps/builder/new.ts\0'), [
      'docs/a file.md',
      'apps/builder/new.ts',
    ]);
  });

  it('keeps docs-only changed checks compiler-free', () => {
    const plan = createVerificationPlan({ root, tier: 'changed', paths: ['docs/example.md'] });
    assert.equal(plan.risk, 'low');
    assert.deepEqual(ids(plan), ['git.diff-check']);
  });

  it('runs English UI once for commit and never for changed', () => {
    const paths = ['apps/photolab/renderer/src/App.tsx'];
    assert.equal(
      ids(createVerificationPlan({ root, tier: 'changed', paths })).includes('photolab.english-ui'),
      false,
    );
    assert.equal(
      ids(createVerificationPlan({ root, tier: 'commit', paths })).filter(
        (id) => id === 'photolab.english-ui',
      ).length,
      1,
    );
  });

  it('escalates viewer work to browser and portable workspace gates on push', () => {
    const plan = createVerificationPlan({
      root,
      tier: 'push',
      paths: ['packages/@himmelcad/viewer/src/index.ts'],
    });
    assert.equal(plan.risk, 'high');
    assert.ok(ids(plan).includes('viewer.browser-kernel'));
    assert.ok(ids(plan).includes('node.lint'));
  });

  it('deduplicates tasks and preserves stable ordering', () => {
    const plan = createVerificationPlan({
      root,
      tier: 'commit',
      paths: [
        'apps/photolab/renderer/src/App.tsx',
        'apps/photolab/renderer/src/FloatingTaskIsland.tsx',
      ],
    });
    assert.equal(new Set(ids(plan)).size, ids(plan).length);
  });

  it('treats raw photolab data as non-source', () => {
    const plan = createVerificationPlan({
      root,
      tier: 'changed',
      paths: ['photolab/capture/images/a.jpg'],
    });
    assert.equal(plan.classifications[0].risk, 'none');
    assert.deepEqual(ids(plan), ['git.diff-check']);
  });

  it('runs the generated automation SDK gate only for its contract inputs', () => {
    for (const path of [
      'schemas/automation/himmelcad-automation-v1.schema.json',
      'scripts/generate-automation-sdk.py',
      'sdk/python/src/himmelcad/client.py',
    ]) {
      const plan = createVerificationPlan({ root, tier: 'changed', paths: [path] });
      assert.equal(plan.risk, 'high');
      assert.equal(ids(plan).filter((id) => id === 'automation.sdk').length, 1);
    }
    const schemaPlan = createVerificationPlan({
      root,
      tier: 'changed',
      paths: ['schemas/automation/fixtures/automation-wire-v1.json'],
    });
    assert.equal(ids(schemaPlan).filter((id) => id === 'automation.wire-rust').length, 1);
    const sdkOnly = createVerificationPlan({
      root,
      tier: 'changed',
      paths: ['sdk/python/src/himmelcad/client.py'],
    });
    assert.equal(ids(sdkOnly).includes('automation.wire-rust'), false);
    const unrelated = createVerificationPlan({
      root,
      tier: 'changed',
      paths: ['apps/builder/renderer/src/App.tsx'],
    });
    assert.equal(ids(unrelated).includes('automation.sdk'), false);
  });

  it('always includes the generated automation SDK gate for release', () => {
    const plan = createVerificationPlan({ root, tier: 'release', paths: [] });
    assert.equal(ids(plan).filter((id) => id === 'automation.sdk').length, 1);
    assert.equal(
      plan.tasks.find((task) => task.id === 'automation.runtime-stage-linux')?.requiredCapability,
      'linux-package',
    );
    assert.equal(
      plan.tasks.find((task) => task.id === 'automation.runtime-stage-windows')?.requiredCapability,
      'windows-package',
    );
    assert.ok(
      ids(plan).indexOf('automation.runtime-stage-linux') <
        ids(plan).indexOf('node.test:@himmelcad/automation-host'),
    );
  });

  it('treats automation schema, SDK and managed runtime roots as known source roots', () => {
    const unknown = shallowUnknownUntracked();
    assert.equal(unknown.includes('schemas/'), false);
    assert.equal(unknown.includes('sdk/'), false);
    assert.equal(unknown.includes('runtime/'), false);
  });

  it('treats the managed automation runtime as a release artifact', () => {
    const plan = createVerificationPlan({
      root,
      tier: 'changed',
      paths: ['runtime/automation-runtime-manifest.json'],
    });
    assert.equal(plan.risk, 'release');
    assert.ok(ids(plan).includes('automation.sdk'));
    assert.ok(ids(plan).includes('automation.runtime-packager'));
    assert.ok(ids(plan).includes('node.test:@himmelcad/automation-host'));
    assert.ok(ids(plan).includes('node.typecheck:@himmelcad/automation-host'));
  });

  it('selects managed-runtime gates for reproducible automation build scripts', () => {
    const plan = createVerificationPlan({
      root,
      tier: 'changed',
      paths: ['scripts/build-automation-linux-opencv.sh'],
    });
    assert.equal(plan.risk, 'release');
    assert.ok(ids(plan).includes('automation.sdk'));
    assert.ok(ids(plan).includes('automation.runtime-packager'));
    assert.ok(ids(plan).includes('node.test:@himmelcad/automation-host'));
  });
});
