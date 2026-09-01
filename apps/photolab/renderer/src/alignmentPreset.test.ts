/**
 * Alignment preset validation tests.
 * Run: pnpm exec tsx --test renderer/src/alignmentPreset.test.ts
 * (from apps/photolab)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALIGNMENT_PRESET_KIND,
  buildAlignmentPreset,
  DEFAULT_FACTORY_ALIGNMENT_PRESET,
  defaultOverridesForProfile,
  FACTORY_ALIGNMENT_PRESETS,
  parseAlignmentPreset,
} from './alignmentPreset.js';

describe('alignmentPreset', () => {
  it('ships three ordered built-in presets generated from profile defaults', () => {
    assert.deepEqual(
      FACTORY_ALIGNMENT_PRESETS.map((item) => item.preset.name),
      ['Fast', 'Quality Hybrid', 'Maximum Robustness'],
    );
    for (const item of FACTORY_ALIGNMENT_PRESETS) {
      assert.deepEqual(item.preset.overrides, defaultOverridesForProfile(item.preset.profile));
      assert.equal(parseAlignmentPreset(item.preset).ok, true);
      assert.equal(item.path.startsWith('builtin:'), true);
    }
    assert.equal(DEFAULT_FACTORY_ALIGNMENT_PRESET.preset.profile, 'qualityHybrid');
  });

  it('builds a valid .hcalign payload', () => {
    const preset = buildAlignmentPreset({
      name: 'Sulzberg Fast',
      description: 'drone strip',
      profile: 'fast',
      overrides: {
        maxImageEdge: 2400,
        keypointsPerMegapixel: 5500,
        sequentialOverlap: 20,
        featureBudget: 8192,
      },
    });
    assert.equal(preset.kind, ALIGNMENT_PRESET_KIND);
    assert.equal(preset.formatVersion, 1);
    const parsed = parseAlignmentPreset(preset);
    assert.equal(parsed.ok, true);
  });

  it('rejects wrong kind (e.g. import workflow JSON)', () => {
    const result = parseAlignmentPreset({
      formatVersion: 1,
      kind: 'image',
      name: 'coords',
      profile: 'fast',
      overrides: {},
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.includes('alignmentPreset')));
    }
  });

  it('rejects out-of-range knobs', () => {
    const result = parseAlignmentPreset({
      formatVersion: 1,
      kind: 'alignmentPreset',
      name: 'bad',
      profile: 'fast',
      overrides: { maxImageEdge: 10 },
    });
    assert.equal(result.ok, false);
  });
});
