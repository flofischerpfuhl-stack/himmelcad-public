/**
 * Agent-API contract of the print features (`model/printFeatures.ts`) and
 * of the Fillet/Chamfer/Shell/Boolean variants (`model/blendOptions.ts`),
 * spliced into `schema.ts` (`DEFS`, `FEATURE_KIND_SCHEMAS`). Params are the
 * stored fields, exactly like every other kind.
 */
import type { JsonSchema } from './validate.js';

const str: JsonSchema = { type: 'string', minLength: 1 };
const num: JsonSchema = { type: 'number' };
const positive: JsonSchema = { type: 'number', exclusiveMinimum: 0 };
const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });

function obj(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
  description?: string,
): JsonSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
    ...(description ? { description } : {}),
  };
}

const expression = (field: string): JsonSchema => ({
  type: 'string',
  minLength: 1,
  description: `Formula over document parameters (\`parameters.list\`), e.g. "wall * 2"; resolved into \`${field}\`.`,
});

const operation: JsonSchema = {
  enum: ['new', 'join', 'cut'],
  default: 'new',
  description:
    'New body, or join/cut into `targetBodyId` (default: the most recently changed body).',
};

export const PRINT_DEFS: Record<string, JsonSchema> = {
  EdgeRule: {
    description:
      'Edges picked by rule, re-evaluated on every replay: every edge of a face, or every sharp concave (inside) / convex (outside) edge of a body.',
    oneOf: [
      obj({ kind: { const: 'faceEdges' }, face: ref('FaceInput') }, ['kind', 'face']),
      obj({ kind: { const: 'concave' }, bodyId: str }, ['kind', 'bodyId']),
      obj({ kind: { const: 'convex' }, bodyId: str }, ['kind', 'bodyId']),
    ],
  },
  HolePlacement: {
    oneOf: [
      obj(
        { kind: { const: 'point' }, u: num, v: num },
        ['kind', 'u', 'v'],
        'A point in the face plane frame (for axis-aligned faces the world axes of the parallel construction plane: XY u=X v=Y, XZ u=X v=Z, YZ u=Y v=Z).',
      ),
      obj(
        { kind: { const: 'sketchPoint' }, featureId: str, entityId: str },
        ['kind', 'featureId', 'entityId'],
        'A sketch point entity, or a circle/arc (its centre), projected onto the face.',
      ),
    ],
  },
  HoleExtent: {
    oneOf: [
      obj({ kind: { const: 'blind' }, depth: positive }, ['kind', 'depth']),
      obj({ kind: { const: 'through' } }, ['kind'], 'Through the whole body.'),
    ],
  },
  ThickenSource: {
    oneOf: [
      obj(
        {
          kind: { const: 'faces' },
          faces: { type: 'array', items: ref('FaceInput'), minItems: 1 },
        },
        ['kind', 'faces'],
      ),
      obj({ kind: { const: 'profile' }, profile: ref('ExtrudeProfile') }, ['kind', 'profile']),
    ],
  },
  ShellFaceThickness: obj(
    { face: ref('FaceInput'), thickness: positive },
    ['face', 'thickness'],
    'The wall growing from `face` gets its own thickness.',
  ),
};

/** Extra optional params of the existing kinds. */
export const BLEND_OPTION_PARAMS: Record<
  'fillet' | 'chamfer' | 'shell' | 'boolean',
  Record<string, JsonSchema>
> = {
  fillet: {
    radius2: {
      type: 'number',
      exclusiveMinimum: 0,
      description:
        'Variable radius: `radius` at the start of each edge chain, `radius2` at its end.',
    },
    radius2Expression: expression('radius2'),
    rules: { type: 'array', items: ref('EdgeRule') },
  },
  chamfer: {
    mode: {
      enum: ['equal', 'twoDistances', 'distanceAngle'],
      default: 'equal',
      description:
        '`twoDistances`: `distance` and `distance2`; `distanceAngle`: `distance` and `angle`.',
    },
    distance2: positive,
    distance2Expression: expression('distance2'),
    angle: { type: 'number', exclusiveMinimum: 0, maximum: 90, description: 'Degrees.' },
    flip: {
      type: 'boolean',
      description:
        'Measure `distance` on the other face of each edge (default: the face with the smaller key).',
    },
    rules: { type: 'array', items: ref('EdgeRule') },
  },
  shell: {
    direction: { enum: ['inside', 'outside'], default: 'inside' },
    clearance: {
      type: 'number',
      minimum: 0,
      maximum: 5,
      description:
        'Outward shells only: the cavity is the body grown by this gap (e.g. 0.2 mm for a printed case that fits over the part).',
    },
    faceThickness: { type: 'array', items: ref('ShellFaceThickness') },
  },
  boolean: {
    keepTools: { type: 'boolean', default: false, description: 'Keep the tool bodies.' },
    keepTarget: {
      type: 'boolean',
      default: false,
      description:
        'Keep the target body as it was; the result becomes a new body `body:<featureId>` (Shapr3D "Keep Target").',
    },
  },
};

export const PRINT_FEATURE_KIND_SCHEMAS: Record<
  string,
  { label: string; summary: string; params: JsonSchema }
> = {
  hole: {
    label: 'Hole',
    summary:
      'Simple, counterbored or countersunk holes on a planar face, blind or through all, several per feature. Standard sizes are presets of the tool (ISO 273 clearance M2-M10, tap drill, DIN 974-1 counterbores, ISO 15065 countersinks) and are stored as plain diameters; `thread` is a cosmetic label only (no thread geometry).',
    params: obj(
      {
        face: ref('FaceInput'),
        placements: { type: 'array', items: ref('HolePlacement'), minItems: 1, maxItems: 200 },
        holeType: { enum: ['simple', 'counterbore', 'countersink'], default: 'simple' },
        diameter: positive,
        diameterExpression: expression('diameter'),
        extent: ref('HoleExtent'),
        counterboreDiameter: positive,
        counterboreDepth: positive,
        countersinkDiameter: positive,
        countersinkAngle: { type: 'number', minimum: 30, maximum: 150, default: 90 },
        thread: { type: 'string', description: 'Cosmetic thread label, e.g. "M3".' },
        preset: { type: 'string', description: 'Display name of the preset the size came from.' },
      },
      ['face', 'placements'],
      'Default extent: through all. One of `diameter` / `diameterExpression` is required.',
    ),
  },
  emboss: {
    label: 'Emboss',
    summary:
      'Raises (positive depth) or engraves (negative) sketch profiles on a face: projected onto a planar face (sketch parallel to it), or wrapped around a cylinder keeping surface lengths (sketch plane parallel to the axis; wrap centre where the sketch normal through the axis meets the surface).',
    params: obj({ profile: ref('ExtrudeProfile'), face: ref('FaceInput'), depth: num }, [
      'profile',
      'face',
      'depth',
    ]),
  },
  draft: {
    label: 'Draft',
    summary:
      'Tilts planar, cylindrical or conical faces by `angle` degrees about their intersection with the neutral plane (a face: the pull points into the body; a construction plane: along its normal; `flip` reverses). Positive removes material on the pull side.',
    params: obj(
      {
        faces: { type: 'array', items: ref('FaceInput'), minItems: 1 },
        neutral: ref('SketchPlane'),
        angle: { type: 'number', minimum: -45, maximum: 45 },
        angleExpression: expression('angle'),
        flip: { type: 'boolean', default: false },
      },
      ['faces', 'neutral'],
      'One of `angle` / `angleExpression` is required.',
    ),
  },
  rib: {
    label: 'Rib',
    summary:
      'A rib/web/gusset from open sketch lines: thickened symmetrically across the sketch plane and filled from each line until it meets the body (`flip` fills the other side); joined into `targetBodyId` (default: the last changed body).',
    params: obj(
      {
        sketchId: str,
        entityIds: { type: 'array', items: str, minItems: 1 },
        thickness: positive,
        thicknessExpression: expression('thickness'),
        flip: { type: 'boolean', default: false },
        targetBodyId: str,
      },
      ['sketchId', 'entityIds'],
      'One of `thickness` / `thicknessExpression` is required.',
    ),
  },
  thicken: {
    label: 'Thicken',
    summary:
      'Turns body faces (or sketch profiles) into a solid of `thickness`: outside along the normal, inside, or both; New/Join/Cut like Extrude.',
    params: obj(
      {
        source: ref('ThickenSource'),
        thickness: positive,
        thicknessExpression: expression('thickness'),
        direction: { enum: ['outside', 'inside', 'both'], default: 'outside' },
        operation,
        targetBodyId: str,
        resultBodyName: str,
      },
      ['source'],
      'One of `thickness` / `thicknessExpression` is required.',
    ),
  },
};
