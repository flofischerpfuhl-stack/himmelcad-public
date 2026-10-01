/**
 * UI state of the canvas module: the running calibration (two points picked
 * on a reference image's plane, then the real distance between them) and
 * the image insertion itself (file pick → picture store → History step).
 */
import { create } from 'zustand';

import { notify } from '../../foundation/commands/notices.js';
import {
  isPlanarFace,
  makeFaceRef,
  nextFeatureName,
  useAssemblerStore,
  type AssemblerState,
  type FeaturePatch,
} from '../../foundation/commands/store.js';
import type { SketchPlaneRef } from '../../foundation/document/document.js';
import { useImageStore } from './imageStore.js';
import {
  calibrateImage,
  clampOpacity,
  DEFAULT_IMAGE_OPACITY,
  defaultImageWidth,
  type ReferenceImageFeature,
} from './referenceImage.js';

export interface Calibration {
  featureId: string;
  /** Picked points in the image plane's (u, v) frame. */
  points: [number, number][];
}

interface CanvasState {
  calibration: Calibration | null;
  /** The opacity while the History-card slider is dragged (committed on release). */
  opacityPreview: { featureId: string; opacity: number } | null;
  setOpacityPreview(preview: { featureId: string; opacity: number } | null): void;
  startCalibration(featureId: string): void;
  addCalibrationPoint(uv: [number, number]): void;
  /** Applies the real distance between the two points (one undo step); a reason when it cannot. */
  applyCalibration(distance: number): string | null;
  cancelCalibration(): void;
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  calibration: null,
  opacityPreview: null,
  setOpacityPreview: (opacityPreview) => set({ opacityPreview }),
  startCalibration: (featureId) => set({ calibration: { featureId, points: [] } }),
  addCalibrationPoint: (uv) => {
    const calibration = get().calibration;
    if (!calibration || calibration.points.length >= 2) return;
    set({ calibration: { ...calibration, points: [...calibration.points, uv] } });
  },
  applyCalibration: (distance) => {
    const calibration = get().calibration;
    if (!calibration || calibration.points.length < 2) return 'Pick two points first.';
    const store = useAssemblerStore.getState();
    const feature = imageFeature(store, calibration.featureId);
    if (!feature) return 'The image step no longer exists.';
    const next = calibrateImage(feature, calibration.points[0]!, calibration.points[1]!, distance);
    if (!next) return 'Pick two different points and a distance above 0.';
    store.editFeatureParams(feature.id, next as FeaturePatch);
    set({ calibration: null });
    return null;
  },
  cancelCalibration: () => set({ calibration: null }),
}));

/** The reference-image step `featureId`, if it is one. */
export function imageFeature(
  state: Pick<AssemblerState, 'features'>,
  featureId: string,
): ReferenceImageFeature | null {
  const feature = state.features.find((f) => f.id === featureId);
  return feature?.kind === 'referenceImage' ? feature : null;
}

/** The selected reference-image step (a History card or Items row), if exactly one is selected. */
export function selectedImage(
  state: Pick<AssemblerState, 'features' | 'selection'>,
): ReferenceImageFeature | null {
  if (state.selection.length !== 1) return null;
  const item = state.selection[0]!;
  return item.kind === 'feature' ? imageFeature(state, item.featureId) : null;
}

/** Where a new picture goes: the selected planar face or construction plane, else XY. */
export function insertionPlane(state: AssemblerState): SketchPlaneRef {
  if (state.selection.length === 1) {
    const item = state.selection[0]!;
    if (item.kind === 'face' && isPlanarFace(state.evaluation, item.bodyId, item.faceKey)) {
      const ref = makeFaceRef(state.evaluation, item.bodyId, item.faceKey);
      if (ref) return { kind: 'face', face: ref };
    }
    if (item.kind === 'datum') {
      const datum = state.evaluation.datums?.find((d) => d.featureId === item.featureId);
      if (datum?.kind === 'plane') {
        return {
          kind: 'construction',
          featureId: datum.featureId,
          frame: datum.frame,
          shown: { center: datum.center, size: datum.size },
        };
      }
    }
  }
  return { kind: 'plane', plane: 'XY', offset: 0 };
}

/** A new reference-image step for a stored picture (not committed). */
export function newImageFeature(
  state: AssemblerState,
  picture: { id: string; width: number; height: number },
  fileName: string,
  options: Partial<
    Pick<ReferenceImageFeature, 'plane' | 'center' | 'width' | 'rotation' | 'opacity'>
  > = {},
): ReferenceImageFeature {
  return {
    id: state.allocateFeatureId('referenceImage'),
    name: nextFeatureName('Image', state.features),
    suppressed: false,
    kind: 'referenceImage',
    imageId: picture.id,
    fileName,
    pixelWidth: picture.width,
    pixelHeight: picture.height,
    plane: options.plane ?? insertionPlane(state),
    center: options.center ?? [0, 0],
    width: options.width ?? defaultImageWidth(picture.width, picture.height),
    rotation: options.rotation ?? 0,
    opacity: clampOpacity(options.opacity ?? DEFAULT_IMAGE_OPACITY),
  };
}

/** Inserts picture file bytes as a reference-image step (one undo step); a reason on failure. */
export async function insertImageFile(name: string, bytes: Uint8Array): Promise<string | null> {
  let picture;
  try {
    picture = await useImageStore.getState().add(bytes);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const state = useAssemblerStore.getState();
  const feature = newImageFeature(state, picture, name);
  state.addFeature(feature, [{ kind: 'feature', featureId: feature.id }]);
  return null;
}

/** Opens the file picker for PNG/JPEG pictures and inserts the chosen one. */
export function pickAndInsertImage(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.png,.jpg,.jpeg,image/png,image/jpeg';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    void file.arrayBuffer().then(async (buffer) => {
      const reason = await insertImageFile(file.name, new Uint8Array(buffer));
      if (reason) notify(reason, 'warning');
    });
  });
  input.addEventListener('cancel', () => input.remove());
  document.body.appendChild(input);
  input.click();
}
