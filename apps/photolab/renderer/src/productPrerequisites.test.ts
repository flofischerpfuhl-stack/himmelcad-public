import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  defaultProductConfiguration,
  validProductConfiguration,
  // @ts-expect-error Node's strip-types test runner loads the TypeScript source directly.
} from './productConfiguration.ts';

import {
  inlineProductStartError,
  evaluateProductPrerequisites,
  type ProductPrerequisiteArtifact,
  type ProductPrerequisiteStatus,
  // @ts-expect-error Node's strip-types test runner loads the TypeScript source directly.
} from './productPrerequisites.ts';

function status(
  artifacts: readonly ProductPrerequisiteArtifact[] = [],
  overrides: Partial<ProductPrerequisiteStatus> = {},
): ProductPrerequisiteStatus {
  return {
    hasPublishedAlignment: true,
    mergedFrameGeoreferenced: true,
    availableArtifacts: new Set(artifacts),
    externalDemBound: false,
    meshSourceKinds: ['dem'],
    ...overrides,
  };
}

describe('product prerequisite evaluation', () => {
  it('blocks every product without a published alignment', () => {
    for (const kind of ['depth', 'dense', 'dem', 'ortho', 'mesh', 'splat'] as const) {
      const decision = evaluateProductPrerequisites(
        kind,
        status([], { hasPublishedAlignment: false }),
      );
      assert.equal(decision.met, false);
      assert.equal(decision.actionFunctionId, 'alignment.run');
    }
  });

  it('requires depth maps or compatible reuse before dense fusion', () => {
    assert.equal(evaluateProductPrerequisites('dense', status()).met, false);
    assert.equal(evaluateProductPrerequisites('dense', status(['depth'])).met, true);
    assert.equal(evaluateProductPrerequisites('dense', status(['depthReuse'])).met, true);
  });

  it('requires dense and DEM lineage for raster products', () => {
    assert.equal(evaluateProductPrerequisites('dem', status(['dense'])).met, true);
    assert.equal(evaluateProductPrerequisites('ortho', status(['dem'])).met, false);
    assert.equal(evaluateProductPrerequisites('ortho', status(['dense', 'dem'])).met, true);
    assert.equal(
      evaluateProductPrerequisites('ortho', status(['dense'], { externalDemBound: true })).met,
      true,
    );
  });

  it('blocks georeferenced products while an overlap-merged frame is unoptimized', () => {
    const unresolved = status(['depth', 'dense', 'dem'], { mergedFrameGeoreferenced: false });
    for (const kind of ['dem', 'ortho'] as const) {
      const decision = evaluateProductPrerequisites(kind, unresolved);
      assert.equal(decision.met, false);
      assert.equal(decision.actionFunctionId, 'alignment.optimize');
      assert.match(decision.reason ?? '', /arbitrary frame/);
    }
    assert.equal(evaluateProductPrerequisites('depth', unresolved).met, true);
    assert.equal(evaluateProductPrerequisites('dense', unresolved).met, true);
  });

  it('requires the selected frozen mesh source', () => {
    const demMissing = evaluateProductPrerequisites('mesh', status(['dense']));
    assert.equal(demMissing.met, false);
    assert.equal(demMissing.reason, 'Needs a published DEM.');
    assert.equal(evaluateProductPrerequisites('mesh', status(['dem'])).met, true);

    const denseMissing = evaluateProductPrerequisites(
      'mesh',
      status(['dem'], { meshSourceKinds: ['dense'] }),
    );
    assert.equal(denseMissing.met, false);
    assert.equal(denseMissing.reason, 'Needs a published dense cloud.');
    assert.equal(
      evaluateProductPrerequisites('mesh', status(['dense'], { meshSourceKinds: ['dense'] })).met,
      true,
    );
  });

  it('allows depth maps and splats from a published alignment', () => {
    assert.equal(evaluateProductPrerequisites('depth', status()).met, true);
    assert.equal(evaluateProductPrerequisites('splat', status()).met, true);
  });
});

describe('mesh product configuration', () => {
  it('defaults to the byte-compatible DEM source and validates both source values', () => {
    const configuration = defaultProductConfiguration('mesh');
    assert.equal(configuration.kind, 'mesh');
    if (configuration.kind !== 'mesh') return;
    assert.equal(configuration.meshSource, 'dem');
    assert.equal(validProductConfiguration(configuration), true);
    assert.equal(validProductConfiguration({ ...configuration, meshSource: 'dense' }), true);
    assert.equal(
      validProductConfiguration({
        ...configuration,
        meshSource: 'unsupported' as 'dem',
      }),
      false,
    );
  });
});

describe('inlineProductStartError', () => {
  it('passes plain strings and null through', () => {
    assert.equal(inlineProductStartError(null), null);
    assert.equal(inlineProductStartError('Start failed'), 'Start failed');
  });

  it('shows the admission sentence for conflicting targets and low disk', () => {
    assert.equal(
      inlineProductStartError({
        code: 'conflictingTarget',
        message:
          'A DEM for this alignment is already running (job dem-1). Wait for it or cancel it.',
      }),
      'A DEM for this alignment is already running (job dem-1). Wait for it or cancel it.',
    );
    assert.equal(
      inlineProductStartError({
        code: 'insufficientDisk',
        message: 'Not enough free space on /: about 3.2 GB needed, 1.1 GB free.',
      }),
      'Not enough free space on /: about 3.2 GB needed, 1.1 GB free.',
    );
  });
});
