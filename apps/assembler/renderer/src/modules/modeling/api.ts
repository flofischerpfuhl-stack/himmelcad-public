/**
 * Agent-API contract of the modelling module: the `feature.create`
 * parameter schemas of its kinds (params are the stored fields, like every
 * kind) and the print features' `$defs` (`printSchema.ts`), in the blocks
 * and order of the published `hcasm.agent-api@1` schema.
 */
import {
  schemaNumber,
  schemaObject,
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
import { bodyIdFor, type Vec3 } from '../../foundation/document/document.js';
import { unlinkedCopyFeature } from './unlinkedCopy.js';
import { API_ORDER, type ApiContribution } from '../../foundation/commands/api/registry.js';
import type { JsonSchema } from '../../foundation/commands/api/validate.js';
import {
  MAX_HELIX_TURNS,
  MAX_SCALE_FACTOR,
  MIN_SCALE_FACTOR,
  PRIMITIVE_SHAPES,
} from './features.js';
import { PRINT_DEFS, PRINT_FEATURE_KIND_SCHEMAS } from './printSchema.js';

const operation: JsonSchema = {
  enum: ['new', 'join', 'cut', 'intersect'],
  default: 'new',
  description:
    'New body, or join into / cut from / intersect with `targetBodyId` (default: the most recently changed body).',
};

/** Revolve, Sweep, Loft, Mirror (before the construction kinds). */
const PROFILE_KIND_SCHEMAS: Record<string, FeatureKindSpec> = {
  revolve: {
    label: 'Revolve',
    summary:
      'Revolves a profile about an axis (world axis, body edge or sketch line — e.g. a construction centre line); New/Join/Cut like Extrude. The axis must not cross the profile.',
    params: schemaObject(
      {
        profile: schemaRef('ExtrudeProfile'),
        axis: schemaRef('AxisRef'),
        angle: {
          type: 'number',
          minimum: -360,
          maximum: 360,
          default: 360,
          description:
            'Degrees; 360 is a full revolution, negative turns the other way. Ignored with `helix`.',
        },
        helix: {
          type: 'object',
          properties: {
            pitch: {
              type: 'number',
              description:
                'Rise per turn along the axis (mm); negative climbs against the axis direction. Its magnitude must exceed the profile extent along the axis (turns may not overlap).',
            },
            turns: {
              type: 'number',
              exclusiveMinimum: 0,
              maximum: MAX_HELIX_TURNS,
              description: 'Number of turns (fractions allowed); height = |pitch| × turns.',
            },
            leftHanded: { type: 'boolean', default: false },
          },
          required: ['pitch', 'turns'],
          additionalProperties: false,
          description:
            'Helical revolve (springs, coils, thread ridges): the profile climbs `pitch` per turn while turning about the axis.',
        },
        operation,
        targetBodyId: schemaString,
        resultBodyName: schemaString,
      },
      ['profile', 'axis'],
    ),
  },
  sweep: {
    label: 'Sweep',
    summary:
      'Sweeps a profile (without holes) along a path (edge chain, sketch region outline or straight line); New/Join/Cut.',
    params: schemaObject(
      {
        profile: schemaRef('ExtrudeProfile'),
        path: schemaRef('PathRef'),
        operation,
        targetBodyId: schemaString,
        resultBodyName: schemaString,
      },
      ['profile', 'path'],
    ),
  },
  loft: {
    label: 'Loft',
    summary:
      'Lofts through two or more single profiles on different planes, in order; smooth or ruled; New/Join/Cut.',
    params: schemaObject(
      {
        profiles: { type: 'array', items: schemaRef('ExtrudeProfile'), minItems: 2 },
        ruled: { type: 'boolean', default: false },
        operation,
        targetBodyId: schemaString,
        resultBodyName: schemaString,
      },
      ['profiles'],
    ),
  },
  mirror: {
    label: 'Mirror',
    summary:
      'Mirrors bodies, sketches and planar faces across a plane (world plane, planar face, construction plane) or, with `axis`, about a line (a half turn); with keepOriginal (default) the mirror images of bodies are new bodies. Mirrored sketches/faces become sketches "<featureId>:sketch:<i>" (sketchIds first, then faces) whose profiles extrude/revolve reference.',
    params: schemaObject(
      {
        bodyIds: { type: 'array', items: schemaString },
        plane: schemaRef('SketchPlane'),
        keepOriginal: { type: 'boolean', default: true },
        sketchIds: { type: 'array', items: schemaString },
        faces: { type: 'array', items: schemaRef('FaceInput') },
        axis: schemaRef('AxisRef'),
      },
      [],
      'At least one of bodyIds / sketchIds / faces must be non-empty. `plane` defaults to the YZ plane (and is ignored with `axis`).',
    ),
  },
};

/** Pattern, Split, Move/Rotate, Rotate, Align (after the construction kinds). */
/** An Align reference (`features.ts` `AlignReference`). */
const ALIGN_REFERENCE: JsonSchema = {
  oneOf: [
    schemaObject({ kind: { const: 'face' }, face: schemaRef('FaceInput') }, ['kind', 'face']),
    schemaObject({ kind: { const: 'axis' }, axis: schemaRef('AxisRef') }, ['kind', 'axis']),
    schemaObject({ kind: { const: 'plane' }, plane: schemaRef('SketchPlane') }, ['kind', 'plane']),
  ],
};

const BODY_KIND_SCHEMAS: Record<string, FeatureKindSpec> = {
  pattern: {
    label: 'Pattern',
    summary: 'Copies bodies in a linear or circular pattern (independent copies).',
    params: schemaObject(
      {
        bodyIds: { type: 'array', items: schemaString, minItems: 1 },
        pattern: schemaRef('PatternDefinition'),
      },
      ['bodyIds', 'pattern'],
    ),
  },
  split: {
    label: 'Split',
    summary:
      'Splits a body into two bodies: by a plane (the positive side becomes new) or, with `profile`, by a closed sketch profile/planar face projected through the body (the inside becomes new); `keepOriginal` keeps the body and makes both parts new bodies.',
    params: schemaObject(
      {
        bodyId: schemaString,
        plane: schemaRef('SketchPlane'),
        profile: schemaRef('ExtrudeProfile'),
        keepOriginal: { type: 'boolean', default: false },
      },
      ['bodyId'],
      'Either `plane` or `profile` (which then wins).',
    ),
  },
  transform: {
    label: 'Move/Rotate',
    summary:
      'Rigid transform of a body: rotate rx, ry, rz degrees about world X, then Y, then Z through `pivot`, then translate (dx, dy, dz); `copy` makes a new body.',
    params: schemaObject(
      {
        bodyId: schemaString,
        dx: schemaNumber,
        dy: schemaNumber,
        dz: schemaNumber,
        rx: schemaNumber,
        ry: schemaNumber,
        rz: schemaNumber,
        pivot: schemaRef('Vec3'),
        copy: { type: 'boolean', default: false },
      },
      ['bodyId'],
      'Missing components default to 0, the pivot to the world origin.',
    ),
  },
  rotateAxis: {
    label: 'Rotate',
    summary:
      'Rotates bodies by `angle` degrees about an axis (a straight or circular edge, a sketch line or a world axis) — "Rotate Around Axis"; `copy` keeps the originals and adds rotated copies.',
    params: schemaObject(
      {
        bodyIds: { type: 'array', items: schemaString, minItems: 1 },
        axis: schemaRef('AxisRef'),
        angle: schemaNumber,
        copy: { type: 'boolean', default: false },
      },
      ['bodyIds', 'axis', 'angle'],
    ),
  },
  align: {
    label: 'Align',
    summary:
      'Moves a body so a reference of it lands on a target. Two planar faces (`face` on the moved body, `target` on another): face to face by default, same direction with flip; `offset` leaves a gap; `center` slides the face centres together. Any other pair as `from`/`to` (which win over face/target): a face (planar = plane, cylindrical/conical = axis, spherical = centre), an `axis` (a straight or circular edge, sketch line, construction or world axis) or a `plane`; an axis onto an axis (coaxial; flip turns it end for end; offset slides along the target axis), a centre onto a centre or an axis, an axis through a centre.',
    params: schemaObject(
      {
        bodyId: schemaString,
        face: schemaRef('FaceInput'),
        target: schemaRef('FaceInput'),
        from: ALIGN_REFERENCE,
        to: ALIGN_REFERENCE,
        flip: { type: 'boolean', default: false },
        center: { type: 'boolean', default: true },
        offset: { type: 'number', default: 0 },
      },
      [],
      'Either `face` or `from` (on the moved body), and either `target` or `to`.',
    ),
  },
  scale: {
    label: 'Scale',
    summary:
      'Scales bodies about `center`: uniformly by `factor`, or per world axis with `factors` (non-uniform needs the HimmelCAD OCCT build); `copy` keeps the originals and adds scaled copies (print fit tests).',
    params: schemaObject(
      {
        bodyIds: { type: 'array', items: schemaString, minItems: 1 },
        factor: {
          type: 'number',
          minimum: MIN_SCALE_FACTOR,
          maximum: MAX_SCALE_FACTOR,
          default: 1,
        },
        factorExpression: {
          ...schemaString,
          description: 'Formula over document parameters, resolved into `factor`.',
        },
        factors: {
          ...schemaRef('Vec3'),
          description: 'Per-axis factors along world X, Y, Z (each > 0); overrides `factor`.',
        },
        center: schemaRef('Vec3'),
        copy: { type: 'boolean', default: false },
      },
      ['bodyIds'],
      'The centre defaults to the world origin.',
    ),
  },
  translate: {
    label: 'Translate',
    summary:
      'Moves bodies point to point: by `to − from` (picked start and end points, world); `copy` keeps the originals and adds moved copies.',
    params: schemaObject(
      {
        bodyIds: { type: 'array', items: schemaString, minItems: 1 },
        from: schemaRef('Vec3'),
        to: schemaRef('Vec3'),
        copy: { type: 'boolean', default: false },
      },
      ['bodyIds', 'from', 'to'],
    ),
  },
  primitive: {
    label: 'Primitive',
    summary:
      'Adds a box, cylinder, sphere, cone or torus standing on a plane (world plane, planar face, construction plane), its base centred at `center` (projected onto the plane); New/Join/Cut/Intersect like Extrude. Sizes: box width (plane u) / depth (v) / height; cylinder radius / height; cone radius (base) / radius2 (top, 0 = pointed) / height; sphere radius; torus radius (ring) / radius2 (tube).',
    params: schemaObject(
      {
        shape: { enum: [...PRIMITIVE_SHAPES] },
        plane: schemaRef('SketchPlane'),
        center: schemaRef('Vec3'),
        width: { type: 'number', exclusiveMinimum: 0 },
        depth: { type: 'number', exclusiveMinimum: 0 },
        height: { type: 'number', exclusiveMinimum: 0 },
        radius: { type: 'number', exclusiveMinimum: 0 },
        radius2: { type: 'number', minimum: 0 },
        flip: {
          type: 'boolean',
          default: false,
          description:
            'Grow to the other side of the plane: into a face (a pocket or hole with operation cut).',
        },
        operation,
        targetBodyId: schemaString,
        resultBodyName: schemaString,
      },
      ['shape'],
      'The plane defaults to XY at 0, the centre to the origin; the sizes the shape needs are required.',
    ),
  },
};

// ---- body.copyUnlinked (MOD-16) -------------------------------------------------------------

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

const copyUnlinked = (ctx: ApiContext, p: Json): Promise<Json> =>
  ctx.write('body.copyUnlinked', async (features, evaluation): Promise<WriteOutcome> => {
    const bodyId = String(p.bodyId);
    const body = evaluation.bodies.find((b) => b.id === bodyId);
    if (!body) {
      throw new ApiError('notFound', `No body "${bodyId}"`, {
        hint: 'bodies.list lists the bodies.',
      });
    }
    const value = (key: string) => (typeof p[key] === 'number' ? (p[key] as number) : 0);
    const pivot: Vec3 = isVec3(p.pivot)
      ? p.pivot
      : [
          (body.min[0] + body.max[0]) / 2,
          (body.min[1] + body.max[1]) / 2,
          (body.min[2] + body.max[2]) / 2,
        ];
    const id = ctx.allocateFeatureId('importStep');
    let feature;
    try {
      feature = await unlinkedCopyFeature(
        ctx.kernel,
        features,
        {
          bodyId,
          dx: value('dx'),
          dy: value('dy'),
          dz: value('dz'),
          rx: value('rx'),
          ry: value('ry'),
          rz: value('rz'),
          pivot,
        },
        {
          id,
          name:
            typeof p.name === 'string' ? p.name : ctx.nextFeatureName('Unlinked copy', features),
          bodyName: `${body.name} (copy)`,
        },
      );
    } catch (error) {
      throw new ApiError(
        'featureFailed',
        `The unlinked copy failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const copyId = bodyIdFor(id);
    return {
      features: [...features, feature],
      touched: [id],
      selection: [{ kind: 'body', bodyId: copyId }],
      result: { featureId: id, bodyId: copyId },
    };
  });

const METHODS: Record<string, MethodSpec> = {
  'body.copyUnlinked': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      "An unlinked copy of a body (Shapr3D Move/Rotate copy with Link off): moved by dx/dy/dz and turned rx/ry/rz degrees about world X, Y, Z through `pivot` (default its box centre), kept as its exact geometry in an `importStep` step, so later edits of the original's earlier steps do not change it. Result: the new step and body.",
    params: schemaObject(
      {
        bodyId: schemaString,
        dx: schemaNumber,
        dy: schemaNumber,
        dz: schemaNumber,
        rx: schemaNumber,
        ry: schemaNumber,
        rz: schemaNumber,
        pivot: schemaRef('Vec3'),
        name: schemaString,
        expectedRevision: schemaRevision,
      },
      ['bodyId'],
    ),
    result: '{featureId, bodyId, revision, committed}',
  },
};

export const MODELING_API: ApiContribution = {
  methods: [
    {
      order: API_ORDER.methods.modeling,
      methods: {
        'body.copyUnlinked': { spec: METHODS['body.copyUnlinked']!, handler: copyUnlinked },
      },
    },
  ],
  defs: [{ order: API_ORDER.defs.printFeatures, defs: PRINT_DEFS }],
  featureKinds: [
    { order: API_ORDER.featureKinds.modeling, kinds: PROFILE_KIND_SCHEMAS },
    { order: API_ORDER.featureKinds.modelingTail, kinds: BODY_KIND_SCHEMAS },
    { order: API_ORDER.featureKinds.printFeatures, kinds: PRINT_FEATURE_KIND_SCHEMAS },
  ],
};
