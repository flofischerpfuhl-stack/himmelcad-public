/**
 * Desktop-only GPU probe of the display module (installed by `module.ui.ts`,
 * never loaded by the headless CLI or the tests): reads the WebGL2 adapter,
 * derives the rendering status with `@himmelcad/hardware-profile`, and on a
 * software rasterizer starts the session at `standard` render quality —
 * unless the user chose a quality themselves (then theirs stands). The
 * preset is no choice: on a hardware GPU the next start is back at the
 * default.
 */
import { deriveRenderingStatus, type RenderingStatus } from '@himmelcad/hardware-profile';
import { create } from 'zustand';

import { usePreferences } from '../../platform/input/preferences.js';
import { gpuTierOf, renderQualityPreset, webglViewerFacts, type GpuTier } from './gpuTier.js';

export interface GpuTierState {
  tier: GpuTier;
  status: RenderingStatus | null;
}

/** The probed tier (for a status read-out); `unknown` until probed. */
export const useGpuTier = create<GpuTierState>(() => ({ tier: 'unknown', status: null }));

/** The unmasked renderer string of a throwaway WebGL2 context, or `null`. */
function webglRenderer(): string | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = info
      ? (gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as unknown)
      : (gl.getParameter(gl.RENDERER) as unknown);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof renderer === 'string' ? renderer : null;
  } catch {
    return null;
  }
}

let probed = false;

/** Probes once and applies the tier's quality preset for this session. */
export function probeGpuTier(): void {
  if (probed || typeof document === 'undefined') return;
  probed = true;
  const status = deriveRenderingStatus({
    // The renderer process has no Chromium feature status; the adapter decides the software case.
    chromiumFeatureStatus: null,
    persistedFallback: { mode: 'hardware' },
    viewer: webglViewerFacts(webglRenderer()),
  });
  const tier = gpuTierOf(status);
  useGpuTier.setState({ tier, status });
  const preset = renderQualityPreset(tier);
  if (preset && !usePreferences.getState().renderQualityChosen) {
    // Not the user's choice (`renderQualityChosen` stays false), so a later start on a
    // hardware GPU is back at the default.
    usePreferences.setState({ renderQuality: preset });
  }
}
