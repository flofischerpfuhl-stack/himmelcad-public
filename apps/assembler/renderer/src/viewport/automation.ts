/**
 * Dev-only viewport probe for calibration-free screen recordings: the
 * mounted viewport registers functions that project world points to CSS
 * pixels and find a visible, unoccluded pixel of a pickable target in the
 * picking id buffer. Consumed by `devtools/automationHook.ts`
 * (`window.__assembler`); never part of the product contract.
 */
import type { PickTarget } from './picking.js';

export interface ScreenPoint {
  /** CSS pixels, relative to the page's viewport (what `page.mouse` expects). */
  x: number;
  y: number;
}

export interface ViewportProbe {
  project(point: readonly [number, number, number]): ScreenPoint | null;
  /** A visible pixel of the first target matching `predicate`, well inside its visible area. */
  anchor(predicate: (target: PickTarget) => boolean): ScreenPoint | null;
  /** Resolves after the next drawn frame (id buffer and pick table up to date). */
  nextFrame(): Promise<void>;
}

let probe: ViewportProbe | null = null;

export function setViewportProbe(next: ViewportProbe | null): void {
  probe = next;
}

export function getViewportProbe(): ViewportProbe | null {
  return probe;
}

export interface PickBuffer {
  width: number;
  height: number;
  /** RGBA bytes, rows bottom-up (as `readPixels` returns them). */
  pixels: Uint8Array;
}

/**
 * Finds the pixel of `ids` with the largest clearance (distance to the
 * nearest pixel of another id, probed along 8 directions up to `maxRadius`),
 * ties broken towards the centroid of all matching pixels. Returns
 * top-left-origin device pixel coordinates, or `null` if no pixel matches
 * (the target is hidden or occluded).
 */
export function findAnchorPixel(
  buffer: PickBuffer,
  ids: ReadonlySet<number>,
  maxRadius = 16,
): { x: number; y: number } | null {
  const { width, height, pixels } = buffer;
  const idAt = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    const o = (y * width + x) * 4;
    return (
      (pixels[o]! | (pixels[o + 1]! << 8) | (pixels[o + 2]! << 16) | (pixels[o + 3]! << 24)) >>> 0
    );
  };
  let count = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (ids.has(idAt(x, y))) {
        count += 1;
        sx += x;
        sy += y;
      }
    }
  }
  if (count === 0) return null;
  const cx = sx / count;
  const cy = sy / count;
  const stride = Math.max(1, Math.floor(Math.sqrt(count / 20000)));
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const;
  let best: { x: number; y: number; clearance: number; distance: number } | null = null;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      if (!ids.has(idAt(x, y))) continue;
      let clearance = 0;
      for (let r = 1; r <= maxRadius; r += 1) {
        if (!directions.every(([dx, dy]) => ids.has(idAt(x + dx * r, y + dy * r)))) break;
        clearance = r;
      }
      const distance = Math.hypot(x - cx, y - cy);
      if (
        !best ||
        clearance > best.clearance ||
        (clearance === best.clearance && distance < best.distance)
      ) {
        best = { x, y, clearance, distance };
      }
    }
  }
  if (!best) return null;
  return { x: best.x, y: height - 1 - best.y };
}
