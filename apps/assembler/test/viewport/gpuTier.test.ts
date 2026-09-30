/**
 * GPU tier and render-quality preset of the display module
 * (`modules/display/gpuTier.ts`) and the "user chose the render quality"
 * flag of the preferences that keeps a preset from overriding a choice.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { RenderingStatus } from '@himmelcad/hardware-profile';

import {
  gpuTierOf,
  renderQualityPreset,
  webglViewerFacts,
} from '../../renderer/src/modules/display/gpuTier.js';
import {
  DEFAULT_PREFERENCES,
  parsePreferences,
} from '../../renderer/src/platform/input/preferences.js';

void test('software rasterizers are recognised from the WebGL renderer string', () => {
  for (const renderer of [
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    'llvmpipe (LLVM 17.0.6, 256 bits)',
    'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ]) {
    const facts = webglViewerFacts(renderer);
    assert.equal(facts.backend, 'software', renderer);
    assert.equal(facts.adapter.isFallbackAdapter, true, renderer);
  }
  const vega = webglViewerFacts(
    'ANGLE (AMD, AMD Radeon(TM) Vega 8 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
  );
  assert.equal(vega.backend, 'webgl2');
  assert.equal(vega.adapter.isFallbackAdapter, false);
  assert.deepEqual(webglViewerFacts(null), {
    backend: 'webgl2',
    adapter: { isFallbackAdapter: false },
  });
});

void test('the tier follows the rendering status; only software asks for standard quality', () => {
  const status = (state: RenderingStatus['state']) => ({ state }) as RenderingStatus;
  assert.equal(gpuTierOf(status('software')), 'software');
  assert.equal(gpuTierOf(status('unavailable')), 'software');
  assert.equal(gpuTierOf(status('webgl2Hardware')), 'hardware');
  assert.equal(gpuTierOf(status('webgpuHardware')), 'hardware');
  assert.equal(gpuTierOf(status('initializing')), 'unknown');
  assert.equal(renderQualityPreset('software'), 'standard');
  assert.equal(renderQualityPreset('hardware'), null);
  assert.equal(renderQualityPreset('unknown'), null);
});

void test('a stored render quality counts as chosen only when the user picked it', () => {
  assert.equal(DEFAULT_PREFERENCES.renderQualityChosen, false);
  // A session preset that was persisted along with another setting is not a choice.
  const preset = parsePreferences(
    JSON.stringify({ renderQuality: 'standard', renderQualityChosen: false }),
  );
  assert.equal(preset.renderQuality, 'high');
  assert.equal(preset.renderQualityChosen, false);
  const chosen = parsePreferences(
    JSON.stringify({ renderQuality: 'standard', renderQualityChosen: true }),
  );
  assert.equal(chosen.renderQuality, 'standard');
  assert.equal(chosen.renderQualityChosen, true);
  // Written before the flag existed: a non-default quality was the user's choice.
  const legacy = parsePreferences(JSON.stringify({ renderQuality: 'standard' }));
  assert.equal(legacy.renderQuality, 'standard');
  assert.equal(legacy.renderQualityChosen, true);
});
