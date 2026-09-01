/** Run from apps/photolab: pnpm exec tsx --test renderer/src/batchRecipe.test.ts */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EntityId, ObjectHash } from '@himmelcad/data';

import {
  graphForBatchRecipePreset,
  instantiateBatchRecipe,
  isBatchRecipeTemplateFile,
  migrateLegacyBatchAlignmentSteps,
  resolveBatchPipelineSteps,
} from './batchRecipe.js';
import { factoryAlignmentPresetForProfile } from './alignmentPreset.js';

describe('batch RecipeTemplate', () => {
  it('keeps reusable templates symbolic and rejects concrete-run payloads', () => {
    const graph = graphForBatchRecipePreset('orthomosaicExternalDem');
    const template = {
      formatVersion: 2,
      lifecycle: 'recipeTemplate',
      name: 'External DEM ortho',
      preset: 'orthomosaicExternalDem',
      ...graph,
    };
    assert.equal(isBatchRecipeTemplateFile(template), true);
    assert.equal(isBatchRecipeTemplateFile({ ...template, lifecycle: 'concreteBatchRun' }), false);
    assert.equal(JSON.stringify(template).includes('sourceDemEntityId'), false);
  });

  it('instantiates an external DEM as an exact run binding', () => {
    const steps = instantiateBatchRecipe(
      'orthomosaicExternalDem',
      'project:dem:17' as EntityId,
      'a'.repeat(64) as ObjectHash,
    );
    assert.equal(steps.length, 2);
    assert.deepEqual(steps[0], {
      kind: 'alignment',
      preset: {
        source: 'builtIn',
        presetId: factoryAlignmentPresetForProfile('qualityHybrid').preset.id,
      },
    });
    assert.deepEqual(steps[1], {
      kind: 'product',
      configuration: {
        kind: 'ortho',
        resolutionMetersPerPixel: 0.03,
        blendMode: 'mosaic',
        colorCorrection: true,
        fillHoles: false,
        tileSizePixels: 512,
        sourceDemEntityId: 'project:dem:17',
        sourceDemVersionSha256: 'a'.repeat(64),
      },
    });
  });

  it('ships a fully unattended standard graph', () => {
    const steps = instantiateBatchRecipe('allProducts');
    assert.deepEqual(
      steps.map((step) => (step.kind === 'alignment' ? 'alignment' : step.configuration.kind)),
      ['alignment', 'depth', 'dense', 'dem', 'ortho', 'mesh', 'splat'],
    );
    assert.equal(JSON.stringify(steps).includes('NeedsUserInput'), false);
  });

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
