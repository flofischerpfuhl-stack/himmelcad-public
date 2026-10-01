/**
 * GPU tier and display quality preset (assembler/MODULES.md §2 "Hardware
 * profile"): the viewport's WebGL2 adapter described in the shared
 * hardware-profile vocabulary (`ViewerRenderingFacts`, `RenderingStatus`
 * from `@himmelcad/hardware-profile`, as Builder and PhotoLab use it), and
 * the render quality that fits it. Pure: the desktop probe
 * (`gpuProbe.ts`) reads the adapter and derives the status.
 *
 * - `software` (SwiftShader, llvmpipe, WARP …): ambient occlusion and the
 *   contact shadow cost seconds per frame, so the preset is `standard`.
 * - `hardware` / `unknown`: the user's setting stands.
 */
import type { RenderingStatus, ViewerRenderingFacts } from '@himmelcad/hardware-profile';

import type { RenderQuality } from '../../platform/input/preferences.js';

export type GpuTier = 'hardware' | 'software' | 'unknown';

/** Renderer strings of CPU rasterizers (Chromium's SwiftShader, Mesa, Windows WARP). */
const SOFTWARE_RENDERER =
  /swiftshader|llvmpipe|softpipe|lavapipe|software rasterizer|microsoft basic render/i;

/**
 * The viewport's adapter as hardware-profile facts, from the unmasked WebGL
 * renderer string (`WEBGL_debug_renderer_info`); `null` = not exposed.
 */
export function webglViewerFacts(renderer: string | null): ViewerRenderingFacts {
  const software = renderer !== null && SOFTWARE_RENDERER.test(renderer);
  return {
    backend: software ? 'software' : 'webgl2',
    adapter: {
      ...(renderer ? { driver: renderer } : {}),
      isFallbackAdapter: software,
    },
  };
}

/** The tier a derived rendering status stands for. */
export function gpuTierOf(status: RenderingStatus): GpuTier {
  switch (status.state) {
    case 'software':
    case 'unavailable':
      return 'software';
    case 'webgpuHardware':
    case 'webgl2Hardware':
      return 'hardware';
    case 'initializing':
      return 'unknown';
  }
}

/** The render quality a tier calls for, or `null` to keep the user's setting. */
export function renderQualityPreset(tier: GpuTier): RenderQuality | null {
  return tier === 'software' ? 'standard' : null;
}
