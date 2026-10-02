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
import type { ViewportClickHandler } from '../../platform/viewport/viewportHooks.js';
import { useImageStore, type StoredImage } from './imageStore.js';
import {
  imageCornersWorld,
  imagePlaneFrame,
  onImage,
  planeCoordinates,
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

type Vec3 = readonly [number, number, number];

/**
 * The shown reference image the ray meets first (`t`: distance along the
 * unit ray), or `null`. Later steps lie on top of earlier ones.
 */
export function imageAtRay(
  state: Pick<AssemblerState, 'features' | 'rollbackBefore' | 'sketchVisibility' | 'evaluation'>,
  ray: { origin: Vec3; direction: Vec3 },
): { featureId: string; t: number } | null {
  const d = ray.direction;
  const length = Math.hypot(d[0], d[1], d[2]) || 1;
  const dir: Vec3 = [d[0] / length, d[1] / length, d[2] / length];
  let best: { featureId: string; t: number } | null = null;
  for (const feature of shownImages(state)) {
    const frame = imagePlaneFrame(feature.plane, state.evaluation);
    if (!frame) continue;
    const n = frame.normal;
    const along = dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2];
    if (Math.abs(along) < 1e-9) continue;
    const o = ray.origin;
    const t =
      ((frame.origin[0] - o[0]) * n[0] +
        (frame.origin[1] - o[1]) * n[1] +
        (frame.origin[2] - o[2]) * n[2]) /
      along;
    if (!(t > 0)) continue;
    const hit: [number, number, number] = [o[0] + dir[0] * t, o[1] + dir[1] * t, o[2] + dir[2] * t];
    if (!onImage(feature, planeCoordinates(frame, hit))) continue;
    // Ties (images on one plane): the later step wins, as it is drawn on top.
    if (!best || t <= best.t + 1e-6) best = { featureId: feature.id, t };
  }
  return best;
}

/**
 * Reference images are pickable in the viewport (HIS-15): a click with no
 * tool running selects the image under the pointer unless a body surface
 * lies in front of it; Shift adds it to the selection.
 */
export const IMAGE_CLICK: ViewportClickHandler = {
  id: 'canvas.imagePick',
  // After Measure, Section › Face and Fix… (they own their clicks).
  order: 900,
  click: (click) => {
    const ray = click.ray?.();
    if (!ray) return false;
    const hit = imageAtRay(click.state, ray);
    if (!hit) return false;
    if (click.pick) {
      // A body in front of the picture keeps the click.
      const surface = click.surfacePoint();
      if (surface) {
        const o = ray.origin;
        const toSurface = Math.hypot(surface[0] - o[0], surface[1] - o[1], surface[2] - o[2]);
        if (toSurface < hit.t - 1e-6) return false;
      } else if (click.pick.kind !== 'sketchCurve' && click.pick.kind !== 'sketchProfile') {
        return false;
      }
    }
    click.state.select(
      { kind: 'feature', featureId: hit.featureId },
      { additive: click.additive === true },
    );
    return true;
  },
};
