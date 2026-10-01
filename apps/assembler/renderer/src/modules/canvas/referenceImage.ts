/**
 * Reference images ("canvas", Shapr3D Insert › Image; HIS-15 / IMP-06): a
 * PNG or JPEG laid on a plane to trace or compare with, as a History step
 * of kind `referenceImage`. The step holds only the placement — plane,
 * centre, width (the height follows the picture's aspect ratio), rotation
 * and opacity — and the id of the picture in the project's image store
 * (`imageStore.ts`), so undo/redo, suppression, reordering and the History
 * card work like for any step while the kernel never sees pixel data.
 *
 * Pure: placement math, picture-size sniffing (PNG/JPEG headers, also
 * headless) and calibration (two points + a known distance).
 */
import {
  frameForFace,
  frameForPlane,
  type SketchFrame,
  type SketchPlaneRef,
  type Vec3,
} from '../../foundation/document/document.js';
import type { FeatureBase } from '../../foundation/document/featureKinds.js';
import type { EvaluationResult } from '../../foundation/geometry-kernel/types.js';

export interface ReferenceImageFeature extends FeatureBase {
  kind: 'referenceImage';
  /** The picture in the project's image store (`images` file field). */
  imageId: string;
  /** Imported file name (Items/History tooltip). */
  fileName: string;
  /** Picture size in pixels (its aspect ratio). */
  pixelWidth: number;
  pixelHeight: number;
  /** The plane it lies on: a world plane (with offset), a planar face or a construction plane. */
  plane: SketchPlaneRef;
  /** Centre in the plane's (u, v) frame, mm. */
  center: [number, number];
  /** Width on the plane, mm. */
  width: number;
  /** Turn about the plane normal, degrees counter-clockwise. */
  rotation: number;
  /** 0.05 (faint) .. 1 (opaque). */
  opacity: number;
}

declare module '../../foundation/document/featureKinds.js' {
  interface FeatureKindMap {
    referenceImage: ReferenceImageFeature;
  }
}

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg'] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

/** Largest picture file taken in (it is stored in the project file). */
export const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
/** Longer side of a freshly inserted picture, mm. */
export const DEFAULT_IMAGE_SIZE_MM = 100;
export const DEFAULT_IMAGE_OPACITY = 0.6;
export const MIN_IMAGE_OPACITY = 0.05;

export function clampOpacity(value: number): number {
  return Math.min(1, Math.max(MIN_IMAGE_OPACITY, value));
}

/** Height on the plane, mm (the width scaled by the aspect ratio). */
export function imageHeight(
  feature: Pick<ReferenceImageFeature, 'width' | 'pixelWidth' | 'pixelHeight'>,
): number {
  return (feature.width * feature.pixelHeight) / feature.pixelWidth;
}

/**
 * Picture type and pixel size from the file header (PNG IHDR, JPEG SOFn),
 * or `null` when it is no PNG/JPEG or the header is damaged. Works without
 * a DOM (headless agents insert pictures too).
 */
export function sniffImage(
  bytes: Uint8Array,
): { mime: ImageMime; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: signature, then the IHDR chunk with width and height.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    view.getUint32(12) === 0x49484452
  ) {
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { mime: 'image/png', width, height } : null;
  }
  // JPEG: walk the markers to the first start-of-frame.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      const length = view.getUint16(at + 2);
      const isFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        const height = view.getUint16(at + 5);
        const width = view.getUint16(at + 7);
        return width > 0 && height > 0 ? { mime: 'image/jpeg', width, height } : null;
      }
      if (length < 2) return null;
      at += 2 + length;
    }
  }
  return null;
}

/** The frame of the plane an image lies on, resolved against the current evaluation. */
export function imagePlaneFrame(
  plane: SketchPlaneRef,
  evaluation: Pick<EvaluationResult, 'bodies' | 'datums'>,
): SketchFrame | null {
  if (plane.kind === 'plane') return frameForPlane(plane.plane, plane.offset);
  if (plane.kind === 'construction') {
    const datum = evaluation.datums?.find((d) => d.featureId === plane.featureId);
    return datum?.kind === 'plane' ? datum.frame : plane.frame;
  }
  const body = evaluation.bodies.find((b) => b.id === plane.face.bodyId);
  const face = body?.faces.find(
    (f) => f.key === plane.face.key || f.aliases.includes(plane.face.key),
  );
  if (face?.normal) return frameForFace(face.normal, face.centroid);
  const n = plane.face.signature.normal;
  return n ? frameForFace(n, plane.face.signature.centroid) : null;
}

/** World point of plane coordinates `(u, v)`. */
export function planePoint(frame: SketchFrame, u: number, v: number): Vec3 {
  return [
    frame.origin[0] + frame.u[0] * u + frame.v[0] * v,
    frame.origin[1] + frame.u[1] * u + frame.v[1] * v,
    frame.origin[2] + frame.u[2] * u + frame.v[2] * v,
  ];
}

/** Plane coordinates of a world point (projected onto the plane). */
export function planeCoordinates(frame: SketchFrame, p: Vec3): [number, number] {
  const d: Vec3 = [p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]];
  return [
    d[0] * frame.u[0] + d[1] * frame.u[1] + d[2] * frame.u[2],
    d[0] * frame.v[0] + d[1] * frame.v[1] + d[2] * frame.v[2],
  ];
}

/**
 * The picture's corners in plane coordinates: bottom-left, bottom-right,
 * top-right, top-left (the picture's top edge is towards +v before rotation).
 */
export function imageCornersUv(
  feature: Pick<
    ReferenceImageFeature,
    'center' | 'width' | 'rotation' | 'pixelWidth' | 'pixelHeight'
  >,
): [number, number][] {
  const hw = feature.width / 2;
  const hh = imageHeight(feature) / 2;
  const a = (feature.rotation * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return (
    [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ] as const
  ).map(([x, y]) => [feature.center[0] + x * c - y * s, feature.center[1] + x * s + y * c]);
}

/** World corners (same order as {@link imageCornersUv}) lifted `lift` mm along the plane normal. */
export function imageCornersWorld(
  feature: ReferenceImageFeature,
  frame: SketchFrame,
  lift = 0,
): Vec3[] {
  return imageCornersUv(feature).map(([u, v]) => {
    const p = planePoint(frame, u, v);
    return [
      p[0] + frame.normal[0] * lift,
      p[1] + frame.normal[1] * lift,
      p[2] + frame.normal[2] * lift,
    ];
  });
}

/** Whether plane point `(u, v)` lies on the picture. */
export function onImage(feature: ReferenceImageFeature, uv: [number, number]): boolean {
  const a = (-feature.rotation * Math.PI) / 180;
  const du = uv[0] - feature.center[0];
  const dv = uv[1] - feature.center[1];
  const x = du * Math.cos(a) - dv * Math.sin(a);
  const y = du * Math.sin(a) + dv * Math.cos(a);
  return Math.abs(x) <= feature.width / 2 && Math.abs(y) <= imageHeight(feature) / 2;
}

/**
 * Calibration (Shapr3D canvas calibration): two points picked on the
 * picture are `distance` mm apart in reality. The picture is scaled about
 * the first point; centre and width change, rotation stays. `null` when the
 * points coincide or the distance is not positive.
 */
export function calibrateImage(
  feature: Pick<ReferenceImageFeature, 'center' | 'width'>,
  a: [number, number],
  b: [number, number],
  distance: number,
): { center: [number, number]; width: number } | null {
  const measured = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(measured > 1e-9) || !(distance > 0)) return null;
  const k = distance / measured;
  return {
    center: [a[0] + (feature.center[0] - a[0]) * k, a[1] + (feature.center[1] - a[1]) * k],
    width: feature.width * k,
  };
}

/** The placement of a freshly inserted picture: longer side `DEFAULT_IMAGE_SIZE_MM`, centred. */
export function defaultImageWidth(pixelWidth: number, pixelHeight: number): number {
  return pixelWidth >= pixelHeight
    ? DEFAULT_IMAGE_SIZE_MM
    : (DEFAULT_IMAGE_SIZE_MM * pixelWidth) / pixelHeight;
}
