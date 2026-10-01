/**
 * Reference images in the viewport (desktop UI only): each active,
 * visible `referenceImage` step is a textured quad on its plane (drawn on
 * the body surfaces, depth-tested, blended at its opacity); a picture that
 * is still decoding or missing shows its outline; the selected image gets a
 * selection-coloured frame. Pictures are decoded once into `ImageBitmap`s.
 */
import { useAssemblerStore, type AssemblerState } from '../../foundation/commands/store.js';
import type { FlatBatch } from '../../platform/viewport/gl.js';
import type {
  OverlayBatch,
  OverlayBatches,
  ViewportOverlayProvider,
} from '../../platform/viewport/overlays.js';
import { readViewportColors } from '../../platform/viewport/theme.js';
import { useImageStore, type StoredImage } from './imageStore.js';
import {
  imageCornersWorld,
  imagePlaneFrame,
  type ReferenceImageFeature,
} from './referenceImage.js';
import { useCanvasStore } from './canvasStore.js';

const bitmaps = new Map<string, ImageBitmap | 'loading' | 'failed'>();
const listeners = new Set<() => void>();

function notifyAll(): void {
  for (const listener of listeners) listener();
}

/** The decoded picture, or `null` while it decodes (a redraw follows) or when it is damaged. */
function bitmapOf(image: StoredImage): ImageBitmap | null {
  const known = bitmaps.get(image.id);
  if (known === 'loading' || known === 'failed') return null;
  if (known) return known;
  bitmaps.set(image.id, 'loading');
  void createImageBitmap(new Blob([image.bytes.slice()], { type: image.mime })).then(
    (bitmap) => {
      bitmaps.set(image.id, bitmap);
      notifyAll();
    },
    () => {
      bitmaps.set(image.id, 'failed');
      notifyAll();
    },
  );
  return null;
}

/** Reference-image steps shown now: active (above the rollback bar), not suppressed, not hidden. */
export function shownImages(
  state: Pick<AssemblerState, 'features' | 'rollbackBefore' | 'sketchVisibility'>,
): ReferenceImageFeature[] {
  const marker = state.rollbackBefore
    ? state.features.findIndex((f) => f.id === state.rollbackBefore)
    : -1;
  const active = marker >= 0 ? state.features.slice(0, marker) : state.features;
  return active.filter(
    (f): f is ReferenceImageFeature =>
      f.kind === 'referenceImage' && !f.suppressed && state.sketchVisibility[f.id] !== false,
  );
}

function outline(
  corners: readonly (readonly number[])[],
  color: readonly number[],
  alpha: number,
): FlatBatch {
  const positions: number[] = [];
  const colors: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    positions.push(...corners[i]!, ...corners[(i + 1) % 4]!);
    colors.push(color[0]!, color[1]!, color[2]!, alpha, color[0]!, color[1]!, color[2]!, alpha);
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    mode: 'lines',
    depthTest: true,
  };
}

let colors: ReturnType<typeof readViewportColors> | null = null;

export const IMAGE_OVERLAY: ViewportOverlayProvider = {
  id: 'canvas.images',
  order: 40,
  batches: (): OverlayBatches => {
    const state = useAssemblerStore.getState();
    const images = useImageStore.getState().images;
    const surface: OverlayBatch[] = [];
    colors ??= readViewportColors();
    const canvas = useCanvasStore.getState();
    const calibrating = canvas.calibration?.featureId ?? null;
    const preview = canvas.opacityPreview;
    for (const feature of shownImages(state)) {
      const frame = imagePlaneFrame(feature.plane, state.evaluation);
      if (!frame) continue;
      const corners = imageCornersWorld(feature, frame);
      const stored = images.get(feature.imageId);
      const bitmap = stored ? bitmapOf(stored) : null;
      if (bitmap) {
        surface.push({
          kind: 'image',
          source: bitmap,
          corners: new Float32Array(corners.flat()),
          opacity: preview?.featureId === feature.id ? preview.opacity : feature.opacity,
          depthTest: true,
        });
      }
      const selected =
        calibrating === feature.id ||
        state.selection.some((s) => s.kind === 'feature' && s.featureId === feature.id) ||
        (state.hover?.kind === 'feature' && state.hover.featureId === feature.id);
      // A missing or decoding picture keeps its outline, the selected one gets a frame.
      if (selected) surface.push(outline(corners, colors.selection, 1));
      else if (!bitmap) surface.push(outline(corners, colors.support, 0.8));
    }
    return { surface, last: [] };
  },
  subscribe: (onChange) => {
    listeners.add(onChange);
    const offImages = useImageStore.subscribe(onChange);
    const offCanvas = useCanvasStore.subscribe(onChange);
    return () => {
      listeners.delete(onChange);
      offImages();
      offCanvas();
    };
  },
};
