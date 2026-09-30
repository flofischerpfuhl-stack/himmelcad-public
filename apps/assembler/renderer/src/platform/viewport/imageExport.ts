/**
 * "Export image…" helpers: the output size for the chosen preset and the
 * PNG encoding of the offscreen render (`gl.ts#renderImage`). The pixel
 * helpers are pure and unit tested; `encodePng` uses a 2D canvas.
 */
import type { ImageExportPreference } from '../input/preferences.js';

/** Output size in pixels for an export preset and the viewport's CSS size. */
export function imageExportSize(
  pref: Pick<ImageExportPreference, 'size' | 'scale' | 'width' | 'height'>,
  viewport: { width: number; height: number },
): { width: number; height: number } {
  switch (pref.size) {
    case 'view':
      return {
        width: Math.max(1, Math.round(viewport.width * pref.scale)),
        height: Math.max(1, Math.round(viewport.height * pref.scale)),
      };
    case 'custom':
      return { width: pref.width, height: pref.height };
    default: {
      const [w, h] = pref.size.split('x').map(Number);
      return { width: w!, height: h! };
    }
  }
}

/**
 * The renderer blends over a transparent clear colour, which leaves colours
 * multiplied by their alpha; PNG stores straight alpha. Divides in place.
 */
export function unpremultiply(pixels: Uint8Array | Uint8ClampedArray): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3]!;
    if (a === 0 || a === 255) continue;
    const k = 255 / a;
    pixels[i] = Math.min(255, Math.round(pixels[i]! * k));
    pixels[i + 1] = Math.min(255, Math.round(pixels[i + 1]! * k));
    pixels[i + 2] = Math.min(255, Math.round(pixels[i + 2]! * k));
  }
}

/** A readable file name for the image: "<project> 2026-09-30 14-05.png". */
export function imageFileName(projectName: string, now = new Date()): string {
  const safe = projectName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'View';
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}-${pad(now.getMinutes())}`;
  return `${safe} ${stamp}.png`;
}

/** RGBA pixels (top row first, alpha multiplied into the colour) → PNG. */
export async function encodePng(pixels: Uint8Array, width: number, height: number): Promise<Blob> {
  unpremultiply(pixels);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The image could not be encoded.');
  const data = context.createImageData(width, height);
  data.data.set(pixels);
  context.putImageData(data, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The image could not be encoded.');
  return blob;
}
