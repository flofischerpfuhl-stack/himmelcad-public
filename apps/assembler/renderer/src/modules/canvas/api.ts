/**
 * Agent API of the canvas module: `image.insert` (a PNG/JPEG picture as a
 * reference-image step, on a world plane, a planar face or a construction
 * plane; block `API_ORDER.methods.canvas`), `image.calibrate` (two points
 * + their real distance) and the `referenceImage` kind schema for
 * `feature.edit` (block `API_ORDER.featureKinds.canvas`).
 */
import {
  schemaNumber,
  schemaObject,
  schemaPositive,
  schemaRef,
  schemaRevision,
  schemaString,
  type ApiContext,
  type FeatureKindSpec,
  type Json,
  type MethodSpec,
  type WriteOutcome,
} from '../../foundation/commands/api/contract.js';
import { ApiError } from '../../foundation/commands/api/errors.js';
import { resolveFaceInput } from '../../foundation/commands/api/references.js';
import { API_ORDER, type ApiContribution } from '../../foundation/commands/api/registry.js';
import type { SketchPlaneRef } from '../../foundation/document/document.js';
import { useImageStore } from './imageStore.js';
import {
  calibrateImage,
  clampOpacity,
  DEFAULT_IMAGE_OPACITY,
  defaultImageWidth,
  imagePlaneFrame,
  planeCoordinates,
  type ReferenceImageFeature,
} from './referenceImage.js';

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function vec2(v: unknown, path: string): [number, number] {
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    !v.every((x) => typeof x === 'number' && Number.isFinite(x))
  ) {
    throw new ApiError('invalidParams', `${path}: expected [u, v]`);
  }
  return [v[0] as number, v[1] as number];
}

/** The plane of `image.insert`: a world plane, a planar face (key or selector) or a construction plane. */
function planeOf(
  raw: unknown,
  features: Parameters<typeof resolveFaceInput>[2],
  evaluation: Parameters<typeof resolveFaceInput>[1],
): SketchPlaneRef {
  if (raw === undefined) return { kind: 'plane', plane: 'XY', offset: 0 };
  if (!isRecord(raw)) throw new ApiError('invalidParams', 'plane: expected an object');
  if (raw.kind === 'plane') {
    const plane = raw.plane;
    if (plane !== 'XY' && plane !== 'XZ' && plane !== 'YZ') {
      throw new ApiError('invalidParams', 'plane.plane: expected "XY", "XZ" or "YZ"');
    }
    return { kind: 'plane', plane, offset: typeof raw.offset === 'number' ? raw.offset : 0 };
  }
  if (raw.kind === 'face') {
    const [face] = resolveFaceInput(raw.face, evaluation, features, 'plane.face', { single: true });
    if (!face || face.signature.surface !== 'plane') {
      throw new ApiError('invalidParams', 'plane.face: expected a planar face');
    }
    return { kind: 'face', face };
  }
  if (raw.kind === 'construction') {
    const datum = evaluation.datums?.find((d) => d.featureId === raw.featureId);
    if (datum?.kind !== 'plane') {
      throw new ApiError('notFound', `No construction plane "${String(raw.featureId)}"`, {
        hint: 'datums.list lists the construction planes.',
      });
    }
    return {
      kind: 'construction',
      featureId: datum.featureId,
      frame: datum.frame,
      shown: { center: datum.center, size: datum.size },
    };
  }
  throw new ApiError('invalidParams', 'plane.kind: expected "plane", "face" or "construction"');
}

const insert = async (ctx: ApiContext, p: Json): Promise<Json> => {
  const { bytes, fileName } = await ctx.readFile(p, 'image.png');
  let picture;
  try {
    picture = await useImageStore.getState().add(bytes);
  } catch (error) {
    throw new ApiError('invalidParams', error instanceof Error ? error.message : String(error));
  }
  return ctx.write('image.insert', (features, evaluation): WriteOutcome => {
    const id = ctx.allocateFeatureId('referenceImage');
    const width =
      typeof p.width === 'number' && p.width > 0
        ? p.width
        : defaultImageWidth(picture.width, picture.height);
    const feature: ReferenceImageFeature = {
      id,
      name: typeof p.name === 'string' ? p.name : ctx.nextFeatureName('Image', features),
      suppressed: false,
      kind: 'referenceImage',
      imageId: picture.id,
      fileName,
      pixelWidth: picture.width,
      pixelHeight: picture.height,
      plane: planeOf(p.plane, features, evaluation),
      center: p.center === undefined ? [0, 0] : vec2(p.center, 'center'),
      width,
      rotation: typeof p.rotation === 'number' ? p.rotation : 0,
      opacity: clampOpacity(typeof p.opacity === 'number' ? p.opacity : DEFAULT_IMAGE_OPACITY),
    };
    return {
      features: [...features, feature],
      touched: [id],
      selection: [{ kind: 'feature', featureId: id }],
      result: {
        featureId: id,
        imageId: picture.id,
        pixelWidth: picture.width,
        pixelHeight: picture.height,
        width,
        height: (width * picture.height) / picture.width,
      },
    };
  });
};

const calibrate = (ctx: ApiContext, p: Json): Promise<Json> =>
  ctx.write('image.calibrate', (features, evaluation): WriteOutcome => {
    const existing = ctx.findFeature(features, String(p.featureId));
    if (existing.kind !== 'referenceImage') {
      throw new ApiError('invalidParams', `"${existing.name}" is a ${existing.kind}, not an image`);
    }
    const frame = imagePlaneFrame(existing.plane, evaluation);
    if (!frame) throw new ApiError('featureFailed', 'The image plane cannot be resolved');
    // Points as plane (u, v) or as world points (projected onto the plane).
    const point = (v: unknown, path: string): [number, number] => {
      if (Array.isArray(v) && v.length === 3) {
        return planeCoordinates(frame, v as [number, number, number]);
      }
      return vec2(v, path);
    };
    const next = calibrateImage(
      existing,
      point(p.a, 'a'),
      point(p.b, 'b'),
      typeof p.distance === 'number' ? p.distance : 0,
    );
    if (!next)
      throw new ApiError('invalidParams', 'Give two different points and a distance above 0');
    return {
      features: features.map((f) => (f.id === existing.id ? { ...existing, ...next } : f)),
      touched: [existing.id],
      result: { featureId: existing.id, ...next },
    };
  });

const PLANE_INPUT = {
  description:
    'A world plane {kind: "plane", plane: "XY"|"XZ"|"YZ", offset}, a planar face {kind: "face", face: FaceInput} or a construction plane {kind: "construction", featureId}; default XY.',
  type: 'object',
} as const;

const METHODS: Record<string, MethodSpec> = {
  'image.insert': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Inserts a PNG/JPEG picture (`path` headless, or base64 `data` + `fileName`) as a reference image (History step `referenceImage`, Shapr3D canvas) on a plane: centre `center` [u, v] in the plane frame, `width` mm (default: longer side 100 mm; the height follows the aspect ratio), `rotation` degrees, `opacity` 0.05–1 (default 0.6). The picture is stored in the project file.',
    params: schemaObject(
      {
        path: schemaString,
        data: schemaString,
        fileName: schemaString,
        plane: PLANE_INPUT,
        center: schemaRef('Vec2'),
        width: schemaPositive,
        rotation: schemaNumber,
        opacity: { type: 'number', minimum: 0.05, maximum: 1 },
        name: schemaString,
        expectedRevision: schemaRevision,
      },
      [],
    ),
    result: '{featureId, imageId, pixelWidth, pixelHeight, width, height, revision, committed}',
  },
  'image.calibrate': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Scales a reference image so that points `a` and `b` (plane [u, v], or world [x, y, z] projected onto its plane) are `distance` mm apart; it scales about `a`.',
    params: schemaObject(
      {
        featureId: schemaString,
        a: { type: 'array', items: schemaNumber, minItems: 2, maxItems: 3 },
        b: { type: 'array', items: schemaNumber, minItems: 2, maxItems: 3 },
        distance: schemaPositive,
        expectedRevision: schemaRevision,
      },
      ['featureId', 'a', 'b', 'distance'],
    ),
    result: '{featureId, center, width, revision, committed}',
  },
};

const KIND_SCHEMAS: Record<string, FeatureKindSpec> = {
  referenceImage: {
    label: 'Image',
    summary:
      'Reference image (no body): a picture on a plane, created with image.insert. feature.edit changes `center` [u, v], `width` (mm; the height follows), `rotation` (degrees) and `opacity` (0.05–1).',
    params: schemaObject(
      {
        imageId: schemaString,
        fileName: schemaString,
        pixelWidth: schemaPositive,
        pixelHeight: schemaPositive,
        plane: schemaRef('SketchPlane'),
        center: schemaRef('Vec2'),
        width: schemaPositive,
        rotation: schemaNumber,
        opacity: { type: 'number', minimum: 0.05, maximum: 1 },
      },
      ['imageId', 'pixelWidth', 'pixelHeight', 'plane', 'center', 'width'],
    ),
  },
};

export const CANVAS_API: ApiContribution = {
  methods: [
    {
      order: API_ORDER.methods.canvas,
      methods: {
        'image.insert': { spec: METHODS['image.insert']!, handler: insert },
        'image.calibrate': { spec: METHODS['image.calibrate']!, handler: calibrate },
      },
    },
  ],
  featureKinds: [{ order: API_ORDER.featureKinds.canvas, kinds: KIND_SCHEMAS }],
};
