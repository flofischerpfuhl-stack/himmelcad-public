import {
  assertValidKernelLocalOrthographicViewFrame,
  type KernelLocalOrthographicViewFrame,
} from './KernelCameraController.js';
import type { KernelClipVolume } from './WgpuKernelViewer.js';

const MINIMUM_SLAB_THICKNESS = 1e-7;

/**
 * Finite visibility depth around a local profile/section plane. Positive
 * `towardCamera` follows the frame normal; positive `awayFromCamera` points in
 * the viewing direction behind the authored plane.
 */
export interface KernelLocalSectionDepth {
  readonly towardCamera: number;
  readonly awayFromCamera: number;
}

export interface KernelLocalSectionClip {
  readonly id: string;
  readonly frame: KernelLocalOrthographicViewFrame;
  readonly depth: KernelLocalSectionDepth;
  readonly enabled?: boolean;
}

/** Complete transient local profile/section view state. */
export interface KernelLocalSectionView {
  readonly frame: KernelLocalOrthographicViewFrame;
  readonly sectionDepth?: KernelLocalSectionDepth | null;
}

/**
 * Builds the two inward half-spaces for a profile/section depth slab.
 *
 * Preview caps intentionally stay disabled: the back boundary is only a view
 * depth limit and must not masquerade as an authored exact section. Exact
 * contours/hatches at `frame.origin` use the existing section-product API.
 */
export function localSectionClipVolume(section: KernelLocalSectionClip): KernelClipVolume {
  if (section.id.trim().length === 0 || section.id !== section.id.trim()) {
    throw new RangeError('local section clip id must be non-empty and trimmed');
  }
  assertValidKernelLocalOrthographicViewFrame(section.frame);
  const { towardCamera, awayFromCamera } = section.depth;
  if (
    !Number.isFinite(towardCamera) ||
    !Number.isFinite(awayFromCamera) ||
    towardCamera < 0 ||
    awayFromCamera < 0 ||
    towardCamera + awayFromCamera < MINIMUM_SLAB_THICKNESS
  ) {
    throw new RangeError('local section depths must be finite, non-negative and non-degenerate');
  }
  const { origin, normal } = section.frame;
  const originAlongNormal = normal.x * origin.x + normal.y * origin.y + normal.z * origin.z;
  return {
    id: section.id,
    planes: [
      {
        // Boundary toward the camera at origin + normal * towardCamera.
        normal: { x: -normal.x, y: -normal.y, z: -normal.z },
        distance: originAlongNormal + towardCamera,
      },
      {
        // Boundary behind the section at origin - normal * awayFromCamera.
        normal,
        distance: -originAlongNormal + awayFromCamera,
      },
    ],
    operation: 'keepInside',
    previewCap: false,
    enabled: section.enabled ?? true,
  };
}
