/** Batch pipeline tests. Run: pnpm --filter @himmelcad/photolab test:renderer */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EntityId, ObjectHash } from '@himmelcad/data';

import type { BatchRecipePipelineStep } from './batchRecipe.js';

import {
  BATCH_PIPELINE_FORMAT_VERSION,
  BATCH_PIPELINE_SCHEMA,
  decodeBatchProcessingSetValue,
  deriveBatchPipelineEdges,
  encodeBatchProcessingSetValue,
  loadBatchPipeline,
  migrateLegacyBatchAlignmentSteps,
  resolveBatchPipelineSteps,
  // @ts-expect-error Node's strip-types test runner loads the TypeScript source directly.
} from './batchRecipe.ts';
import {
  factoryAlignmentPresetForProfile,
  // @ts-expect-error Node's strip-types test runner loads the TypeScript source directly.
} from './alignmentPreset.ts';
import {
  defaultProductConfiguration,
  // @ts-expect-error Node's strip-types test runner loads the TypeScript source directly.
} from './productConfiguration.ts';

describe('batch pipeline files', () => {
  it('migrates a legacy recipe template with defaults and an exact DEM binding', () => {
    const migrated = loadBatchPipeline({
      formatVersion: 2,
      lifecycle: 'recipeTemplate',
      name: 'External DEM ortho',
      preset: 'orthomosaicExternalDem',
      nodes: [],
      edges: [],
      externalDemBinding: {
        entityId: 'project:dem:17',
        versionHash: 'a'.repeat(64),
      },
    });
    assert.ok(migrated);
    assert.deepEqual(migrated.notices, ['Migrated from recipe template']);
    assert.deepEqual(migrated.file.steps[0], {
      kind: 'alignment',
      preset: {
        source: 'builtIn',
        presetId: factoryAlignmentPresetForProfile('qualityHybrid').preset.id,
      },
    });
    assert.deepEqual(migrated.file.steps[1], {
      kind: 'product',
      configuration: {
        ...defaultProductConfiguration('ortho'),
        sourceDemEntityId: 'project:dem:17',
        sourceDemVersionSha256: 'a'.repeat(64),
      },
    });
  });

  it('round-trips the current pipeline schema without migration', () => {
    const pipeline = {
      schema: BATCH_PIPELINE_SCHEMA,
      formatVersion: BATCH_PIPELINE_FORMAT_VERSION,
      name: 'Survey products',
      scope: { kind: 'all' as const },
      steps: [
        {
          kind: 'alignment' as const,
          preset: {
            source: 'builtIn' as const,
            presetId: factoryAlignmentPresetForProfile('qualityHybrid').preset.id,
          },
        },
        { kind: 'product' as const, configuration: defaultProductConfiguration('dense') },
      ],
    };
    const loaded = loadBatchPipeline(JSON.parse(JSON.stringify(pipeline)));
    assert.ok(loaded);
    assert.deepEqual(loaded.file, pipeline);
    assert.deepEqual(loaded.notices, []);
  });

  it('keeps format version 1 and WP-C1 alignment-profile migration working', () => {
    const loaded = loadBatchPipeline({
      formatVersion: 1,
      name: 'Legacy pipeline',
      steps: [{ kind: 'alignment', profile: 'maximumRobustness' }],
    });
    assert.ok(loaded);
    assert.equal(loaded.file.formatVersion, 2);
    assert.deepEqual(loaded.migratedProfiles, ['maximumRobustness']);
    assert.deepEqual(loaded.file.steps, [
      {
        kind: 'alignment',
        preset: {
          source: 'builtIn',
          presetId: factoryAlignmentPresetForProfile('maximumRobustness').preset.id,
        },
      },
    ]);
  });

  it('uses processing-set scope encoding in both directions', () => {
    const entityId = 'project:processing-set:7' as EntityId;
    const encoded = encodeBatchProcessingSetValue(entityId);
    assert.equal(encoded, 'processing-set:project:processing-set:7');
    assert.equal(decodeBatchProcessingSetValue(encoded), entityId);
    assert.equal(decodeBatchProcessingSetValue('processing:project:processing-set:7'), null);
  });
});

describe('batch pipeline execution', () => {
  it('maps legacy profile steps to the matching built-in preset', () => {
    const migrated = migrateLegacyBatchAlignmentSteps([
      { kind: 'alignment', profile: 'maximumRobustness' },
    ]);
    assert.deepEqual(migrated.migratedProfiles, ['maximumRobustness']);
    assert.deepEqual(migrated.steps, [
      {
        kind: 'alignment',
        preset: {
          source: 'builtIn',
          presetId: factoryAlignmentPresetForProfile('maximumRobustness').preset.id,
        },
      },
    ]);
  });

  it('derives preview edges from the shared product prerequisite rules', () => {
    const steps = standardSteps();
    assert.deepEqual(deriveBatchPipelineEdges(steps), [
      { from: 0, to: 1, artifact: 'alignment' },
      { from: 0, to: 2, artifact: 'alignment' },
      { from: 1, to: 2, artifact: 'depth' },
      { from: 0, to: 3, artifact: 'alignment' },
      { from: 2, to: 3, artifact: 'dense' },
      { from: 0, to: 4, artifact: 'alignment' },
      { from: 2, to: 4, artifact: 'dense' },
      { from: 3, to: 4, artifact: 'dem' },
      { from: 0, to: 5, artifact: 'alignment' },
      { from: 3, to: 5, artifact: 'dem' },
      { from: 0, to: 6, artifact: 'alignment' },
    ]);

    const externalOrtho = steps.map((step) =>
      step.kind === 'product' && step.configuration.kind === 'ortho'
        ? {
            ...step,
            configuration: {
              ...step.configuration,
              sourceDemEntityId: 'project:dem:17' as EntityId,
              sourceDemVersionSha256: 'a'.repeat(64) as ObjectHash,
            },
          }
        : step,
    );
    assert.equal(
      deriveBatchPipelineEdges(externalOrtho).some(
        (edge) => edge.from === 3 && edge.to === 4 && edge.artifact === 'dem',
      ),
      false,
    );
  });

  it('carries the pinned GCP revision of a product step through resolution', async () => {
    const steps: BatchRecipePipelineStep[] = [
      {
        kind: 'product',
        configuration: defaultProductConfiguration('dem'),
        gcpOptimizationEntityId: 'project:alignment:gcp-7' as EntityId,
      },
      {
        kind: 'product',
        configuration: defaultProductConfiguration('ortho'),
        gcpOptimizationEntityId: null,
      },
    ];
    const resolved = await resolveBatchPipelineSteps(steps, async () => {
      throw new Error('a product step must not load an alignment preset');
    });
    assert.deepEqual(
      resolved.map((step) => (step.kind === 'product' ? step.gcpOptimizationEntityId : undefined)),
      ['project:alignment:gcp-7', null],
    );
  });

  it('freezes the referenced preset and its overrides for execution', async () => {
    const resolved = await resolveBatchPipelineSteps(
      [
        {
          kind: 'alignment',
          preset: { source: 'userFile', path: '/presets/site.hcalign' },
        },
      ],
      async () => ({
        formatVersion: 1,
        kind: 'alignmentPreset',
        id: 'site-quality',
        name: 'Site quality',
        description: '',
        savedAt: '2026-09-01T00:00:00.000Z',
        profile: 'qualityHybrid',
        overrides: { featureBudget: 20_000 },
      }),
    );
    assert.deepEqual(resolved, [
      {
        kind: 'alignment',
        preset: {
          id: 'site-quality',
          name: 'Site quality',
          profile: 'qualityHybrid',
          overrides: { featureBudget: 20_000 },
        },
      },
    ]);
  });
});

function standardSteps(): BatchRecipePipelineStep[] {
  return [
    {
      kind: 'alignment',
      preset: {
        source: 'builtIn',
        presetId: factoryAlignmentPresetForProfile('qualityHybrid').preset.id,
      },
    },
    ...(['depth', 'dense', 'dem', 'ortho', 'mesh', 'splat'] as const).map(
      (operation): BatchRecipePipelineStep => ({
        kind: 'product',
        configuration: defaultProductConfiguration(operation),
      }),
    ),
  ];
}
