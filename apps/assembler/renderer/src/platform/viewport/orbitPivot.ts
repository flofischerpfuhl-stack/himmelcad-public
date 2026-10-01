/**
 * Orbit and zoom pivot from the picking buffer's depth (owner request
 * 2026-10-01, assembler/SELECTION-NAVIGATION.md "Orbit and zoom pivot").
 * Decided once per gesture from a small window of the id pass's depth
 * attachment around the cursor (`gl.ts` `readPickDepthWindow`):
 *
 * 1. **surface** — something is drawn under the cursor: its depth.
 * 2. **near** — the cursor is in a hole or slot, or just beside the part:
 *    the depths drawn within {@link PIVOT_SEARCH_RADIUS_PX}, weighted by
 *    their closeness to the cursor. Put on the cursor ray, the pivot sits
 *    inside a bore at its rim depth instead of on whatever is behind it.
 * 3. **model** — nothing near: the depth of the visible model's centre
 *    (the caller's part, it needs the bounds).
 *
 * The pivot is always a point on the cursor ray, so it stays under the
 * cursor while the camera turns or zooms about it. Pure: no DOM, no GL.
 */

/** Search radius of rule 2, CSS px (the window read is twice that wide). */
export const PIVOT_SEARCH_RADIUS_PX = 32;

/** A window of the depth attachment around the cursor. */
export interface DepthSamples {
  width: number;
  height: number;
  /** Window-space depth (0 near … 1 far) per sample, top row first; `NaN` where nothing is drawn. */
  z: Float32Array;
  /** The cursor inside the window, in samples (pixel centres at +0.5). */
  cx: number;
  cy: number;
  /** CSS pixels per sample (`1 / devicePixelRatio` for a device-pixel window). */
  cssPerSample: number;
}

/** The clip planes the id pass was drawn with (`SceneFrame.depth`). */
export interface DepthProjection {
  near: number;
  far: number;
  orthographic: boolean;
}

export type PivotRule = 'surface' | 'near' | 'model' | 'target' | 'selection';

/** Distance from the eye along the viewing axis of a window-space depth `z`. */
export function linearDepth(z: number, projection: DepthProjection): number {
  const { near: n, far: f } = projection;
  const ndc = z * 2 - 1;
  if (projection.orthographic) return (f + n + ndc * (f - n)) / 2;
  return (2 * f * n) / (f + n - ndc * (f - n));
}

/**
 * Rules 1 and 2 on a depth window: the pivot's view depth, or `null` when
 * nothing is drawn within the search radius (rule 3 is the caller's).
 */
export function pivotDepth(
  samples: DepthSamples,
  projection: DepthProjection,
  searchRadiusPx = PIVOT_SEARCH_RADIUS_PX,
): { depth: number; rule: 'surface' | 'near'; hits: number } | null {
  const { width, height, z } = samples;
  const ix = Math.floor(samples.cx);
  const iy = Math.floor(samples.cy);
  if (ix >= 0 && iy >= 0 && ix < width && iy < height) {
    const under = z[iy * width + ix]!;
    if (!Number.isNaN(under)) {
      return { depth: linearDepth(under, projection), rule: 'surface', hits: 1 };
    }
  }
  const radius = searchRadiusPx / Math.max(1e-6, samples.cssPerSample);
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(samples.cx - radius));
  const x1 = Math.min(width - 1, Math.ceil(samples.cx + radius));
  const y0 = Math.max(0, Math.floor(samples.cy - radius));
  const y1 = Math.min(height - 1, Math.ceil(samples.cy + radius));
  let weight = 0;
  let sum = 0;
  let hits = 0;
  for (let y = y0; y <= y1; y += 1) {
    const dy = y + 0.5 - samples.cy;
    for (let x = x0; x <= x1; x += 1) {
      const value = z[y * width + x]!;
      if (Number.isNaN(value)) continue;
      const dx = x + 0.5 - samples.cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      // Closer hits count more: (1 − d/R)², zero at the radius.
      const falloff = 1 - Math.sqrt(d2) / radius;
      const w = falloff * falloff;
      if (w <= 0) continue;
      weight += w;
      sum += w * linearDepth(value, projection);
      hits += 1;
    }
  }
  if (hits === 0 || weight <= 0) return null;
  return { depth: sum / weight, rule: 'near', hits };
}

/** Bytes of a depth-attachment pixel (`gl.ts`: 24-bit depth in RGB, A = 255 where drawn) → window depth or `NaN`. */
export function unpackDepth(r: number, g: number, b: number, a: number): number {
  if (a === 0) return Number.NaN;
  return (r + g * 256 + b * 65536) / 16777215;
}
