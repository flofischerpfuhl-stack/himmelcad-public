/**
 * The project thumbnail written into `.hcasm` on Save (`format.ts`
 * `thumbnail`) and shown by the Home screen's recent projects. Rendered by
 * the same offscreen path as File › Export image… (`viewportUi.ts`
 * `renderViewportImage`): the current view, transparent background, without
 * grid and axes. Best effort — no 3D view (tests, headless) or a render
 * failure simply saves without a thumbnail.
 */
import { renderViewportImage } from '../../../model/viewportUi.js';

export const THUMBNAIL_WIDTH = 320;
export const THUMBNAIL_HEIGHT = 200;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** A `data:image/png;base64,…` preview of the current view, or `null`. */
export async function renderProjectThumbnail(hasGeometry: boolean): Promise<string | null> {
  if (!hasGeometry) return null;
  try {
    const image = await renderViewportImage({
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT,
      transparent: true,
      grid: false,
    });
    const bytes = new Uint8Array(await image.png.arrayBuffer());
    return `data:image/png;base64,${toBase64(bytes)}`;
  } catch {
    return null;
  }
}
