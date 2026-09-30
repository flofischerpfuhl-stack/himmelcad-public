/**
 * The canonical command/query contract of HimmelCAD Assembler,
 * `hcasm.agent-api@1` — one versioned, language-neutral description of
 * every query and command that UI bridges, the headless CLI, the in-app
 * loopback endpoint and the Python SDK share (ADR 0024, ADR 0033 §4).
 *
 * Design rules (see `assembler/AGENT-API.md`):
 *
 * - **Feature params are the stored feature fields.** `feature.create
 *   {kind, params}` takes exactly the fields a `.hcasm` file stores for that
 *   kind (minus `id`/`name`/`kind`/`suppressed`), so `features.list` output
 *   round-trips into `feature.create`/`feature.edit`, and a new feature kind
 *   (revolve, sweep, pattern, …) plugs in by adding one entry to
 *   {@link FEATURE_KIND_SCHEMAS}. Kinds without an entry are still accepted
 *   and validated by the project-format validator (`model/project/format.ts`),
 *   which every persisted kind must extend anyway.
 * - **References are names, not indices.** Faces/edges are addressed by the
 *   kernel's stable naming keys (`{bodyId, key}`); the server fills in the
 *   geometric signature. `{bodyId, select}` expands a CadQuery-style selector
 *   (`">Z"`, `"+Z"`, `"|Z"`, `"%CIRCLE"`, …) on the current evaluation.
 * - **Units are millimetres, Z is up** — the only unit the document has.
 *
 * `api.describe` returns {@link AGENT_API_SCHEMA}; the checked-in copy
 * `apps/assembler/api/agent-api-v1.schema.json` is kept identical by a test.
 */
import { API_ERROR_CODES } from './errors.js';
import type { JsonSchema } from './validate.js';

export const API_ID = 'hcasm.agent-api';
export const API_VERSION = 1;

export type Capability =
  | 'document.read'
  | 'document.write'
  | 'view.write'
  | 'filesystem.read'
  | 'filesystem.write';

export type MethodKind = 'meta' | 'query' | 'command';

export interface MethodSpec {
  kind: MethodKind;
  capability: Capability;
  summary: string;
  params: JsonSchema;
  /** Prose description of the result shape. */
  result: string;
  /** `true` if the command is staged when a transaction is open. */
  transactional?: boolean;
}

const str: JsonSchema = { type: 'string', minLength: 1 };
const num: JsonSchema = { type: 'number' };
const positive: JsonSchema = { type: 'number', exclusiveMinimum: 0 };
const revision: JsonSchema = {
  type: 'integer',
  minimum: 0,
  description:
    'Optimistic concurrency: the command fails with `conflict` unless the document revision still equals this value.',
};

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

const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });

export const DEFS: Record<string, JsonSchema> = {
  Vec3: { type: 'array', items: num, minItems: 3, maxItems: 3 },
  FaceSignature: obj(
    {
      surface: { enum: ['plane', 'cylinder', 'cone', 'sphere', 'torus', 'other'] },
      normal: { anyOf: [ref('Vec3'), { type: 'null' }] },
      centroid: ref('Vec3'),
      area: num,
      adjacentFaces: num,
    },
    ['surface', 'normal', 'centroid', 'area', 'adjacentFaces'],
  ),
  EdgeSignature: obj(
    {
      curve: { enum: ['line', 'circle', 'ellipse', 'other'] },
      midpoint: ref('Vec3'),
      length: num,
      direction: { anyOf: [ref('Vec3'), { type: 'null' }] },
    },
    ['curve', 'midpoint', 'length', 'direction'],
  ),
  FaceRef: obj(
    { bodyId: str, key: str, signature: ref('FaceSignature') },
    ['bodyId', 'key'],
    'Stable face reference. `signature` is optional on input; the server fills it from the current evaluation.',
  ),
  EdgeRef: obj(
    { bodyId: str, key: str, signature: ref('EdgeSignature') },
    ['bodyId', 'key'],
    'Stable edge reference (`key` is "<faceKeyA>|<faceKeyB>"). `signature` is optional on input.',
  ),
  Selector: obj(
    {
      bodyId: str,
      select: {
        type: 'string',
        minLength: 1,
        description:
          'CadQuery-style selector: "+Z"/"-X" (planar faces facing / lines along), "|Z" (parallel), "#Z" (perpendicular), ">Z"/"<Z" (max/min along axis), "%PLANE", "%CYLINDER", "%LINE", "%CIRCLE"; combine with " and ".',
      },
    },
    ['bodyId', 'select'],
  ),
  FaceInput: { oneOf: [ref('FaceRef'), ref('Selector')] },
  EdgeInput: { oneOf: [ref('EdgeRef'), ref('Selector')] },
  Vec2: { type: 'array', items: num, minItems: 2, maxItems: 2 },
  SketchShape: {
    description:
      'Convenience shape, expanded into entities + constraints + dimensions (fully dimensioned: position from the sketch origin and size), like a rectangle/circle drawn and dimensioned in the app.',
    oneOf: [
      obj(
        {
          kind: { const: 'rectangle' },
          x: num,
          y: num,
          width: num,
          height: num,
        },
        ['kind', 'x', 'y', 'width', 'height'],
        'Axis-aligned rectangle in sketch (u, v) coordinates; (x, y) is a corner. Dimension roles: x, y, width, height.',
      ),
      obj(
        { kind: { const: 'circle' }, cx: num, cy: num, radius: positive },
        ['kind', 'cx', 'cy', 'radius'],
        'Circle. Dimension roles: cx, cy, diameter.',
      ),
    ],
  },
  SketchEntity: {
    description:
      'Sketch geometry in the sketch frame (u, v) mm, always the last solved state. Points are referenced by id; "origin" is the fixed sketch origin (never stored). Construction geometry never bounds a profile (e.g. a revolve axis line).',
    oneOf: [
      obj(
        { id: str, kind: { const: 'point' }, x: num, y: num, construction: { type: 'boolean' } },
        ['id', 'kind', 'x', 'y'],
      ),
      obj({ id: str, kind: { const: 'line' }, a: str, b: str, construction: { type: 'boolean' } }, [
        'id',
        'kind',
        'a',
        'b',
      ]),
      obj(
        {
          id: str,
          kind: { const: 'circle' },
          center: str,
          radius: positive,
          construction: { type: 'boolean' },
        },
        ['id', 'kind', 'center', 'radius'],
      ),
      obj(
        {
          id: str,
          kind: { const: 'arc' },
          center: str,
          start: str,
          end: str,
          construction: { type: 'boolean' },
        },
        ['id', 'kind', 'center', 'start', 'end'],
        'Counter-clockwise from start to end around center.',
      ),
    ],
  },
  SketchConstraintKind: {
    enum: [
      'coincident',
      'horizontal',
      'vertical',
      'parallel',
      'perpendicular',
      'tangent',
      'equal',
      'fixed',
      'midpoint',
      'symmetric',
      'concentric',
      'pointOnObject',
    ],
  },
  SketchDimensionKind: {
    enum: ['distance', 'horizontalDistance', 'verticalDistance', 'radius', 'diameter', 'angle'],
  },
  SketchConstraint: obj(
    {
      id: str,
      kind: ref('SketchConstraintKind'),

      refs: { type: 'array', items: str, minItems: 1 },
    },
    ['id', 'kind', 'refs'],
    'refs: coincident 2 points; horizontal/vertical 1 line or 2 points; parallel/perpendicular 2 lines; tangent 2 curves (one round); equal 2 lines or 2 round; fixed 1 point/curve; midpoint point + line; symmetric 2 points + line/point; concentric 2 round; pointOnObject point + curve.',
  ),
  SketchDimension: obj(
    {
      id: str,
      name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
      kind: ref('SketchDimensionKind'),

      refs: { type: 'array', items: str, minItems: 1 },
      value: { type: 'number', minimum: 0 },
      expression: { type: 'string' },
      offset: num,
    },
    ['id', 'name', 'kind', 'refs', 'value'],
    'Driving dimension (mm, angle in degrees). refs: distance 1 line / 2 points / point + line / 2 parallel lines; horizontal/verticalDistance 1 line or 2 points; radius/diameter 1 circle/arc; angle 2 lines. `expression` (e.g. "d1 / 2 + 3") uses names of other dimensions of the sketch, or of a document parameter (`parameters.list`).',
  ),
  Parameter: obj(
    {
      id: str,
      name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
      unit: { enum: ['mm', 'deg', ''] },
      value: num,
      expression: str,
    },
    ['id', 'name', 'unit', 'value'],
    'Document parameter ("variable"): `value` is always the last resolved value; `expression` (e.g. "wall * 2") is the source formula when the value is computed from other parameters. Usable from sketch dimension expressions and the distance/radius/thickness fields of extrude/fillet/chamfer/shell (`<field>Expression`).',
  ),
  SketchPlane: {
    oneOf: [
      obj({ kind: { const: 'plane' }, plane: { enum: ['XY', 'XZ', 'YZ'] }, offset: num }, [
        'kind',
        'plane',
      ]),
      obj({ kind: { const: 'face' }, face: ref('FaceInput') }, ['kind', 'face']),
    ],
  },
  ExtrudeProfile: {
    oneOf: [
      obj(
        {
          kind: { const: 'sketch' },
          featureId: str,
          regions: { type: 'array', items: str, minItems: 1 },
        },
        ['kind', 'featureId'],
        'Every closed region of the sketch (fused) unless `regions` lists region keys (sketches.list → regions[].key).',
      ),
      obj(
        { kind: { const: 'face' }, face: ref('FaceInput') },
        ['kind', 'face'],
        'Push/pull of a planar body face along its outward normal (Extrude); a planar face as profile (Revolve/Sweep/Loft).',
      ),
    ],
  },
  AxisRef: {
    oneOf: [
      obj(
        { kind: { const: 'world' }, axis: { enum: ['X', 'Y', 'Z'] }, origin: ref('Vec3') },
        ['kind', 'axis'],
        'A world axis direction through `origin` (default the world origin).',
      ),
      obj(
        { kind: { const: 'edge' }, edge: ref('EdgeInput') },
        ['kind', 'edge'],
        'A straight body edge, or the axis of a circular edge.',
      ),
      obj(
        { kind: { const: 'sketchLine' }, featureId: str, entityId: str },
        ['kind', 'featureId', 'entityId'],
        'A sketch line by entity id (construction lines included), e.g. a revolve centre line.',
      ),
    ],
  },
  PathRef: {
    oneOf: [
      obj(
        {
          kind: { const: 'edges' },
          edges: { type: 'array', items: ref('EdgeInput'), minItems: 1 },
        },
        ['kind', 'edges'],
        'A connected chain of body edges.',
      ),
      obj(
        { kind: { const: 'sketch' }, featureId: str, region: str },
        ['kind', 'featureId', 'region'],
        'The closed outer outline of a sketch region.',
      ),
      obj(
        { kind: { const: 'line' }, start: ref('Vec3'), end: ref('Vec3') },
        ['kind', 'start', 'end'],
        'A straight world line.',
      ),
    ],
  },
  PatternDefinition: {
    oneOf: [
      obj(
        {
          kind: { const: 'linear' },
          direction: ref('AxisRef'),
          count: { type: 'integer', minimum: 2, maximum: 200 },
          spacing: num,
        },
        ['kind', 'direction', 'count', 'spacing'],
      ),
      obj(
        {
          kind: { const: 'circular' },
          axis: ref('AxisRef'),
          count: { type: 'integer', minimum: 2, maximum: 200 },
          angle: { type: 'number', exclusiveMinimum: 0, maximum: 360 },
        },
        ['kind', 'axis', 'count', 'angle'],
        '`angle` is the total angle in degrees; 360 spreads the instances evenly.',
      ),
    ],
  },
  SelectionItem: {
    oneOf: [
      obj({ kind: { const: 'body' }, bodyId: str }, ['kind', 'bodyId']),
      obj({ kind: { const: 'face' }, bodyId: str, faceKey: str }, ['kind', 'bodyId', 'faceKey']),
      obj({ kind: { const: 'edge' }, bodyId: str, edgeKey: str }, ['kind', 'bodyId', 'edgeKey']),
      obj(
        { kind: { const: 'sketchProfile' }, featureId: str, regionKey: str },
        ['kind', 'featureId'],
        'One region of a sketch (`regionKey`), or every region.',
      ),
      obj({ kind: { const: 'feature' }, featureId: str }, ['kind', 'featureId']),
    ],
  },
};

const operation: JsonSchema = {
  enum: ['new', 'join', 'cut'],
  default: 'new',
  description:
    'New body, or join/cut into `targetBodyId` (default: the most recently changed body).',
};

export interface FeatureKindSpec {
  /** History-card name prefix ("Extrude" → "Extrude 2"). */
  label: string;
  summary: string;
  /** Schema of `params` (the stored fields of this kind). */
  params: JsonSchema;
}

/**
 * Parameter schemas of the feature kinds this build knows. A feature kind
 * added to `model/document.ts` should get an entry here; until it does, the
 * API still accepts it generically (validated by the project format).
 */
export const FEATURE_KIND_SCHEMAS: Record<string, FeatureKindSpec> = {
  sketch: {
    label: 'Sketch',
    summary:
      'Constrained 2D sketch on a construction plane or a planar body face (mm, sketch u/v): entities, constraints and driving dimensions, solved by planeGCS on every write. Profiles are the detected closed regions (sketches.list → regions). Input shorthand: `profiles: [SketchShape]` adds fully dimensioned rectangles/circles.',
    params: obj(
      {
        plane: ref('SketchPlane'),
        entities: { type: 'array', items: ref('SketchEntity') },
        constraints: { type: 'array', items: ref('SketchConstraint') },
        dimensions: { type: 'array', items: ref('SketchDimension') },
        profiles: {
          type: 'array',
          items: ref('SketchShape'),
          description: 'Input-only shorthand, expanded into entities/constraints/dimensions.',
        },
      },
      ['plane'],
    ),
  },
  extrude: {
    label: 'Extrude',
    summary:
      'Extrudes sketch profiles (or pushes/pulls a planar face) along the sketch normal; negative distance goes the other way.',
    params: obj(
      {
        profile: ref('ExtrudeProfile'),
        distance: num,
        distanceExpression: {
          ...str,
          description:
            'Formula over document parameters (`parameters.list`), e.g. "wall * 2"; resolved into `distance`. Either this or `distance` is required.',
        },
        symmetric: { type: 'boolean', default: false },
        operation: { enum: ['new', 'join', 'cut'], default: 'new' },
        targetBodyId: str,
        resultBodyName: str,
      },
      ['profile'],
    ),
  },
  fillet: {
    label: 'Fillet',
    summary: 'Rounds edges of one body with a constant radius (exact B-rep fillet).',
    params: obj(
      {
        edges: { type: 'array', items: ref('EdgeInput'), minItems: 1 },
        radius: positive,
        radiusExpression: {
          ...str,
          description: 'Formula over document parameters, resolved into `radius`.',
        },
      },
      ['edges'],
    ),
  },
  chamfer: {
    label: 'Chamfer',
    summary: 'Bevels edges of one body with a constant distance.',
    params: obj(
      {
        edges: { type: 'array', items: ref('EdgeInput'), minItems: 1 },
        distance: positive,
        distanceExpression: {
          ...str,
          description: 'Formula over document parameters, resolved into `distance`.',
        },
      },
      ['edges'],
    ),
  },
  shell: {
    label: 'Shell',
    summary: 'Hollows a body, opening the given faces; walls grow inwards.',
    params: obj(
      {
        bodyId: str,
        faces: { type: 'array', items: ref('FaceInput'), minItems: 1 },
        thickness: positive,
        thicknessExpression: {
          ...str,
          description: 'Formula over document parameters, resolved into `thickness`.',
        },
      },
      ['faces'],
    ),
  },
  boolean: {
    label: 'Boolean',
    summary: 'Union/subtract/intersect; the tool bodies are consumed.',
    params: obj(
      {
        operation: { enum: ['union', 'subtract', 'intersect'] },
        targetBodyId: str,
        toolBodyIds: { type: 'array', items: str, minItems: 1 },
      },
      ['operation', 'targetBodyId', 'toolBodyIds'],
    ),
  },
  move: {
    label: 'Move',
    summary: 'Translates a body by (dx, dy, dz) mm.',
    params: obj(
      { bodyId: str, dx: num, dy: num, dz: num },
      ['bodyId'],
      'Missing components default to 0.',
    ),
  },
  setAppearance: {
    label: 'Appearance',
    summary: 'Sets a body display color (#RRGGBB); written to 3MF/STEP.',
    params: obj({ bodyId: str, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } }, [
      'bodyId',
      'color',
    ]),
  },
  importStep: {
    label: 'Import',
    summary: 'A STEP file embedded (base64) as one history step producing bodies.',
    params: obj({ data: str, fileName: str }, ['data', 'fileName']),
  },
  revolve: {
    label: 'Revolve',
    summary:
      'Revolves a profile about an axis (world axis, body edge or sketch line — e.g. a construction centre line); New/Join/Cut like Extrude. The axis must not cross the profile.',
    params: obj(
      {
        profile: ref('ExtrudeProfile'),
        axis: ref('AxisRef'),
        angle: {
          type: 'number',
          minimum: -360,
          maximum: 360,
          default: 360,
          description: 'Degrees; 360 is a full revolution, negative turns the other way.',
        },
        operation,
        targetBodyId: str,
        resultBodyName: str,
      },
      ['profile', 'axis'],
    ),
  },
  sweep: {
    label: 'Sweep',
    summary:
      'Sweeps a profile (without holes) along a path (edge chain, sketch region outline or straight line); New/Join/Cut.',
    params: obj(
      {
        profile: ref('ExtrudeProfile'),
        path: ref('PathRef'),
        operation,
        targetBodyId: str,
        resultBodyName: str,
      },
      ['profile', 'path'],
    ),
  },
  loft: {
    label: 'Loft',
    summary:
      'Lofts through two or more single profiles on different planes, in order; smooth or ruled; New/Join/Cut.',
    params: obj(
      {
        profiles: { type: 'array', items: ref('ExtrudeProfile'), minItems: 2 },
        ruled: { type: 'boolean', default: false },
        operation,
        targetBodyId: str,
        resultBodyName: str,
      },
      ['profiles'],
    ),
  },
  mirror: {
    label: 'Mirror',
    summary:
      'Mirrors bodies across a plane; with keepOriginal (default) the mirror images are new bodies.',
    params: obj(
      {
        bodyIds: { type: 'array', items: str, minItems: 1 },
        plane: ref('SketchPlane'),
        keepOriginal: { type: 'boolean', default: true },
      },
      ['bodyIds', 'plane'],
    ),
  },
  pattern: {
    label: 'Pattern',
    summary: 'Copies bodies in a linear or circular pattern (independent copies).',
    params: obj(
      { bodyIds: { type: 'array', items: str, minItems: 1 }, pattern: ref('PatternDefinition') },
      ['bodyIds', 'pattern'],
    ),
  },
  split: {
    label: 'Split',
    summary: 'Splits a body by a plane into two bodies (the positive side becomes new).',
    params: obj({ bodyId: str, plane: ref('SketchPlane') }, ['bodyId', 'plane']),
  },
  transform: {
    label: 'Move/Rotate',
    summary:
      'Rigid transform of a body: rotate rx, ry, rz degrees about world X, then Y, then Z through `pivot`, then translate (dx, dy, dz); `copy` makes a new body.',
    params: obj(
      {
        bodyId: str,
        dx: num,
        dy: num,
        dz: num,
        rx: num,
        ry: num,
        rz: num,
        pivot: ref('Vec3'),
        copy: { type: 'boolean', default: false },
      },
      ['bodyId'],
      'Missing components default to 0, the pivot to the world origin.',
    ),
  },
  align: {
    label: 'Align',
    summary:
      'Moves a body so its planar `face` lies on the plane of `target` (a planar face of another body): face to face by default, same direction with flip; `offset` leaves a gap; `center` slides the face centres together.',
    params: obj(
      {
        bodyId: str,
        face: ref('FaceInput'),
        target: ref('FaceInput'),
        flip: { type: 'boolean', default: false },
        center: { type: 'boolean', default: true },
        offset: { type: 'number', default: 0 },
      },
      ['face', 'target'],
    ),
  },
  offsetFace: {
    label: 'Offset Face',
    summary:
      'Offsets faces of one body along their normals: positive adds material, negative removes it (e.g. enlarges a hole).',
    params: obj({ faces: { type: 'array', items: ref('FaceInput'), minItems: 1 }, distance: num }, [
      'faces',
      'distance',
    ]),
  },
  deleteFace: {
    label: 'Delete Face',
    summary: 'Removes faces (holes, fillets, chamfers) of one body and heals it.',
    params: obj({ faces: { type: 'array', items: ref('FaceInput'), minItems: 1 } }, ['faces']),
  },
};

const scope: JsonSchema = {
  enum: ['auto', 'committed', 'staged'],
  default: 'auto',
  description: "`auto`: the open transaction's staged state if any, else the committed document.",
};

const exportParams = obj({
  bodyIds: { type: 'array', items: str, minItems: 1 },
  path: {
    type: 'string',
    minLength: 1,
    description: 'Headless only (capability filesystem.write). Omit to receive base64 bytes.',
  },
});

export const METHODS: Record<string, MethodSpec> = {
  'api.hello': {
    kind: 'meta',
    capability: 'document.read',
    summary: 'Negotiates the protocol version and reports capabilities.',
    params: obj({
      client: { type: 'string' },
      versions: { type: 'array', items: { type: 'integer' } },
    }),
    result: '{api, version, server: "headless"|"app", capabilities[], units: "mm", featureKinds[]}',
  },
  'api.describe': {
    kind: 'meta',
    capability: 'document.read',
    summary: 'Returns this contract (JSON Schema of every method and feature kind).',
    params: obj({}),
    result: 'The hcasm.agent-api@1 schema document.',
  },
  'document.get': {
    kind: 'query',
    capability: 'document.read',
    summary: 'Document info: name, revision, counts, undo/redo state, open transaction.',
    params: obj({}),
    result:
      '{projectName, revision, units, featureCount, bodyCount, canUndo, canRedo, transaction: null|{id,label,commands}, kernel}',
  },
  'features.list': {
    kind: 'query',
    capability: 'document.read',
    summary: 'The feature history in order, with parameters and per-feature errors.',
    params: obj({ scope }),
    result: '[{id, name, kind, suppressed, params, error?, warning?}]',
  },
  'feature.get': {
    kind: 'query',
    capability: 'document.read',
    summary: 'One feature with parameters.',
    params: obj({ featureId: str, scope }, ['featureId']),
    result: '{id, name, kind, suppressed, params, error?, warning?}',
  },
  'bodies.list': {
    kind: 'query',
    capability: 'document.read',
    summary: 'Evaluated bodies with exact bbox, volume, surface area and validity.',
    params: obj({ scope }),
    result:
      '[{id, name, color, createdBy, valid, volume, area, bbox: {min, max, size}, faceCount, edgeCount}]',
  },
  'body.get': {
    kind: 'query',
    capability: 'document.read',
    summary: 'One evaluated body.',
    params: obj({ bodyId: str, scope }, ['bodyId']),
    result: 'Same shape as a bodies.list entry.',
  },
  'faces.list': {
    kind: 'query',
    capability: 'document.read',
    summary: 'Faces of a body with stable keys, readable names and geometric descriptors.',
    params: obj({ bodyId: str, select: { type: 'string' }, scope }, ['bodyId']),
    result:
      '[{bodyId, key, aliases, name, surface, normal, centroid, area, adjacentFaces, edgeKeys}]',
  },
  'edges.list': {
    kind: 'query',
    capability: 'document.read',
    summary: 'Edges of a body with stable keys, readable names and geometric descriptors.',
    params: obj({ bodyId: str, select: { type: 'string' }, scope }, ['bodyId']),
    result: '[{bodyId, key, name, curve, midpoint, length, direction, radius, faceKeys}]',
  },
  'sketches.list': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Sketches with frame, entities, constraints, dimensions and their detected profiles (regions with stable keys, the boundary entity ids and world-space centres).',
    params: obj({ scope }),
    result:
      '[{featureId, name, plane, frame: {origin,u,v,normal}, entities, constraints, dimensions, regions: [{key, area, sample, center, holes, entityIds}], consumed}]',
  },
  'selection.get': {
    kind: 'query',
    capability: 'document.read',
    summary: 'The UI selection (stable keys).',
    params: obj({}),
    result: '[SelectionItem]',
  },
  'selection.set': {
    kind: 'command',
    capability: 'view.write',
    summary: 'Replaces the UI selection (view state, not undoable).',
    params: obj({ items: { type: 'array', items: ref('SelectionItem') } }, ['items']),
    result: '{selection}',
  },
  'parameters.list': {
    kind: 'query',
    capability: 'document.read',
    summary: 'Document parameters ("variables"), in creation order.',
    params: obj({}),
    result: '[Parameter]',
  },
  'parameter.create': {
    kind: 'command',
    capability: 'document.write',
    summary:
      'Adds a document parameter. Exactly one of `value`/`expression` is normally given; `expression` is resolved immediately (cycle/unknown-name errors reject with nothing changed).',
    params: obj(
      {
        name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
        unit: { enum: ['mm', 'deg', ''], default: 'mm' },
        value: num,
        expression: str,
        expectedRevision: revision,
      },
      ['name'],
    ),
    result: '{parameter: Parameter, revision}',
  },
  'parameter.edit': {
    kind: 'command',
    capability: 'document.write',
    summary:
      "Changes a parameter's name, unit, value or expression. Renaming rewrites every sketch dimension and feature `*Expression` field that references it.",
    params: obj(
      {
        parameterId: str,
        name: str,
        unit: { enum: ['mm', 'deg', ''] },
        value: num,
        expression: str,
        expectedRevision: revision,
      },
      ['parameterId'],
    ),
    result: '{parameter: Parameter, revision}',
  },
  'parameter.delete': {
    kind: 'command',
    capability: 'document.write',
    summary:
      'Removes a parameter. Refused with `conflict` and the list of users when a sketch dimension or feature field still references it by name.',
    params: obj({ parameterId: str, expectedRevision: revision }, ['parameterId']),
    result: '{parameterId, revision}',
  },
  'feature.create': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary: 'Appends a feature of `kind` with `params` (one undo step unless in a transaction).',
    params: obj(
      {
        kind: str,
        params: { type: 'object' },
        name: str,
        expectedRevision: revision,
      },
      ['kind', 'params'],
    ),
    result:
      '{featureId, name, kind, createdBodyIds, revision, committed, errors, warnings, bodies}',
  },
  'feature.edit': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary: 'Changes parameters of an existing feature (shallow merge); downstream re-evaluates.',
    params: obj({ featureId: str, params: { type: 'object' }, expectedRevision: revision }, [
      'featureId',
      'params',
    ]),
    result: '{featureId, revision, committed, errors, warnings, bodies}',
  },
  'feature.delete': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary: 'Removes a feature from the history.',
    params: obj({ featureId: str, expectedRevision: revision }, ['featureId']),
    result: '{featureId, revision, committed, errors}',
  },
  'feature.suppress': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary: 'Suppresses or unsuppresses a feature.',
    params: obj({ featureId: str, suppressed: { type: 'boolean' }, expectedRevision: revision }, [
      'featureId',
      'suppressed',
    ]),
    result: '{featureId, revision, committed, errors}',
  },
  'feature.rename': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary: 'Renames a history card.',
    params: obj({ featureId: str, name: str, expectedRevision: revision }, ['featureId', 'name']),
    result: '{featureId, revision, committed}',
  },
  'sketch.addProfile': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds a fully dimensioned rectangle or circle (entities + constraints + dimensions) to a sketch and re-solves it.',
    params: obj({ featureId: str, profile: ref('SketchShape'), expectedRevision: revision }, [
      'featureId',
      'profile',
    ]),
    result:
      '{featureId, shape: {kind, entityIds, dimensions: {role: name}}, dof, regions, revision, committed, errors}',
  },
  'sketch.addPolyline': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds connected lines through `points` (closed: back to the first point). Axis-aligned segments get horizontal/vertical constraints unless autoConstrain is false; construction lines never bound a profile (use one as a revolve axis).',
    params: obj(
      {
        featureId: str,
        points: { type: 'array', items: ref('Vec2'), minItems: 2 },
        closed: { type: 'boolean', default: false },
        construction: { type: 'boolean', default: false },
        autoConstrain: { type: 'boolean', default: true },
        expectedRevision: revision,
      },
      ['featureId', 'points'],
    ),
    result: '{featureId, pointIds, lineIds, dof, regions, revision, committed, errors}',
  },
  'sketch.addArc': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary: 'Adds a counter-clockwise arc from `start` to `end` around `center`.',
    params: obj(
      {
        featureId: str,
        center: ref('Vec2'),
        start: ref('Vec2'),
        end: ref('Vec2'),
        construction: { type: 'boolean', default: false },
        expectedRevision: revision,
      },
      ['featureId', 'center', 'start', 'end'],
    ),
    result: '{featureId, entityIds: [center, start, end, arc], dof, regions, revision, committed}',
  },
  'sketch.addConstraint': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds a geometric constraint (see $defs.SketchConstraint for the refs per kind) and re-solves; a conflicting or redundant constraint fails with sketchConflict.',
    params: obj(
      {
        featureId: str,
        kind: ref('SketchConstraintKind'),
        refs: { type: 'array', items: str, minItems: 1 },
        expectedRevision: revision,
      },
      ['featureId', 'kind', 'refs'],
    ),
    result: '{featureId, constraintId, dof, regions, revision, committed}',
  },
  'sketch.addDimension': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds a driving dimension (value in mm / degrees, or an expression over other dimension names) and re-solves the sketch to it.',
    params: {
      ...obj(
        {
          featureId: str,
          kind: ref('SketchDimensionKind'),
          refs: { type: 'array', items: str, minItems: 1 },
          value: { type: 'number', minimum: 0 },
          expression: str,
          name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
          expectedRevision: revision,
        },
        ['featureId', 'kind', 'refs'],
      ),
      anyOf: [{ required: ['value'] }, { required: ['expression'] }],
    },
    result: '{featureId, dimensionId, name, value, dof, regions, revision, committed}',
  },
  'sketch.setDimension': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Changes a dimension (by id or name, e.g. "d3") to a value or expression; the sketch re-solves and dependent features re-evaluate (the History-panel dimension edit).',
    params: {
      ...obj(
        {
          featureId: str,
          dimension: str,
          value: { type: 'number', minimum: 0 },
          expression: str,
          expectedRevision: revision,
        },
        ['featureId', 'dimension'],
      ),
      anyOf: [{ required: ['value'] }, { required: ['expression'] }],
    },
    result: '{featureId, dimensionId, name, value, dof, regions, revision, committed, errors}',
  },
  'sketch.deleteItems': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Deletes entities, constraints or dimensions by id (curves take their unused points, constraints/dimensions on deleted geometry go with them).',
    params: obj(
      {
        featureId: str,
        ids: { type: 'array', items: str, minItems: 1 },
        expectedRevision: revision,
      },
      ['featureId', 'ids'],
    ),
    result: '{featureId, dof, regions, revision, committed, errors}',
  },
  'transaction.begin': {
    kind: 'command',
    capability: 'document.write',
    summary:
      'Opens a transaction: following write commands are staged, previewed and committed together as one undo step.',
    params: obj({ label: { type: 'string' }, expectedRevision: revision }),
    result: '{transactionId, baseRevision}',
  },
  'transaction.preview': {
    kind: 'command',
    capability: 'document.read',
    summary: 'Evaluates the staged state without committing.',
    params: obj({}),
    result: '{transactionId, commands, errors, warnings, bodies}',
  },
  'transaction.commit': {
    kind: 'command',
    capability: 'document.write',
    summary:
      'Commits the staged state as exactly one undo step; fails with `conflict` if the document changed since begin.',
    params: obj({ allowErrors: { type: 'boolean', default: false } }),
    result: '{transactionId, revision, featureIds, errors, bodies}',
  },
  'transaction.cancel': {
    kind: 'command',
    capability: 'document.read',
    summary: 'Discards the staged state; the document and undo stack are untouched.',
    params: obj({}),
    result: '{transactionId, cancelled: true}',
  },
  'history.undo': {
    kind: 'command',
    capability: 'document.write',
    summary: 'Undoes the last committed step (same stack as the UI).',
    params: obj({ expectedRevision: revision }),
    result: '{revision, canUndo, canRedo}',
  },
  'history.redo': {
    kind: 'command',
    capability: 'document.write',
    summary: 'Redoes the last undone step.',
    params: obj({ expectedRevision: revision }),
    result: '{revision, canUndo, canRedo}',
  },
  'export.stl': {
    kind: 'command',
    capability: 'document.read',
    summary: 'Binary STL of all (or the given) bodies.',
    params: exportParams,
    result: '{mediaType, byteLength, data?: base64, path?}',
  },
  'export.3mf': {
    kind: 'command',
    capability: 'document.read',
    summary: '3MF package (one object per body, named and coloured).',
    params: exportParams,
    result: '{mediaType, byteLength, data?: base64, path?}',
  },
  'export.step': {
    kind: 'command',
    capability: 'document.read',
    summary: 'Exact-B-rep STEP (AP214) of all (or the given) bodies.',
    params: exportParams,
    result: '{mediaType, byteLength, data?: base64, path?}',
  },
  'import.step': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary: 'Imports a STEP file as one "Import" history step.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'Headless only (filesystem.read).' },
        data: { type: 'string', minLength: 1, description: 'Base64 STEP bytes.' },
        fileName: str,
        expectedRevision: revision,
      },
      additionalProperties: false,
      anyOf: [{ required: ['path'] }, { required: ['data', 'fileName'] }],
    },
    result: '{featureId, createdBodyIds, revision, committed, errors}',
  },
  'project.new': {
    kind: 'command',
    capability: 'document.write',
    summary: 'Starts an empty document (clears undo history).',
    params: obj({ name: str }),
    result: '{projectName, revision}',
  },
  'project.open': {
    kind: 'command',
    capability: 'document.write',
    summary: 'Loads a .hcasm project (strictly validated; clears undo history).',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'Headless only (filesystem.read).' },
        text: { type: 'string', minLength: 1, description: '.hcasm JSON text.' },
      },
      additionalProperties: false,
      oneOf: [{ required: ['path'] }, { required: ['text'] }],
    },
    result: '{projectName, featureCount, revision, errors}',
  },
  'project.save': {
    kind: 'command',
    capability: 'document.read',
    summary: 'Serializes the document as .hcasm (to `path` headless, else returned as text).',
    params: obj({
      path: {
        type: 'string',
        minLength: 1,
        description: 'Headless only (filesystem.write). Omit to receive the text.',
      },
      name: str,
    }),
    result: '{text?, path?, byteLength}',
  },
};

/** The full contract document returned by `api.describe` and checked in as JSON. */
export const AGENT_API_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://himmelcad.local/schemas/assembler/agent-api-v1.schema.json',
  title: 'HimmelCAD Assembler agent API',
  api: API_ID,
  version: API_VERSION,
  units: { length: 'mm', angle: 'deg', up: '+Z' },
  transport: {
    framing: 'JSON-RPC 2.0; headless: one JSON object per line on stdio; app: HTTP POST /rpc',
    auth: 'app endpoint: "Authorization: Bearer <session token>", loopback only, off by default',
  },
  errorCodes: [...API_ERROR_CODES],
  capabilities: [
    'document.read',
    'document.write',
    'view.write',
    'filesystem.read',
    'filesystem.write',
  ],
  $defs: DEFS,
  featureKinds: FEATURE_KIND_SCHEMAS,
  methods: METHODS,
  limits: {
    sketchEntities:
      'points, lines, circles and arcs (no splines/ellipses/slots/text); constraints and driving dimensions solved by planeGCS; no reference (driven) dimensions',
  },
} as const;
