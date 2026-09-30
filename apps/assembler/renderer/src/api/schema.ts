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
import { API_ERROR_CODES } from '../foundation/commands/api/errors.js';
import { MESH_RESOLUTION_SCHEMA, PRINT_METHODS, PRINT_SETTINGS_SCHEMA } from './printApi.js';
import { INTEROP_METHODS, STEP_EXPORT_PARAMS, STEP_IMPORT_STRUCTURE } from './interopApi.js';
import { BLEND_OPTION_PARAMS, PRINT_DEFS, PRINT_FEATURE_KIND_SCHEMAS } from './printSchema.js';
import type { JsonSchema } from '../foundation/commands/api/validate.js';
import { OFFSET_FACE_MODES } from '../model/features.js';

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
  PrintSettings: PRINT_SETTINGS_SCHEMA,
  EdgeInput: { oneOf: [ref('EdgeRef'), ref('Selector')] },
  MeasureTarget: {
    description:
      'What to measure: a body, a face or edge (key or selector matching exactly one), or a world point [x, y, z] (mm).',
    oneOf: [
      obj({ kind: { const: 'body' }, bodyId: str }, ['kind', 'bodyId']),
      obj({ kind: { const: 'face' }, face: ref('FaceInput') }, ['kind', 'face']),
      obj({ kind: { const: 'edge' }, edge: ref('EdgeInput') }, ['kind', 'edge']),
      obj({ kind: { const: 'point' }, point: ref('Vec3') }, ['kind', 'point']),
    ],
  },
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
      obj(
        {
          id: str,
          kind: { const: 'ellipse' },
          center: str,
          major: str,
          minor: str,
          construction: { type: 'boolean' },
        },
        ['id', 'kind', 'center', 'major', 'minor'],
        'Ellipse by its centre and the end points of its major and minor axis (the minor point is kept perpendicular; minor radius ≤ major radius).',
      ),
      obj(
        {
          id: str,
          kind: { const: 'ellipticArc' },
          center: str,
          major: str,
          minor: str,
          start: str,
          end: str,
          construction: { type: 'boolean' },
        },
        ['id', 'kind', 'center', 'major', 'minor', 'start', 'end'],
        'Elliptical arc, counter-clockwise from start to end on the ellipse (centre, major, minor).',
      ),
      obj(
        {
          id: str,
          kind: { const: 'spline' },
          mode: { enum: ['fit', 'control'] },
          points: { type: 'array', items: str, minItems: 2 },
          degree: { type: 'integer', minimum: 1 },
          knots: { type: 'array', items: num },
          handles: {
            type: 'array',
            items: { anyOf: [str, { type: 'null' }] },
            minItems: 2,
            maxItems: 2,
          },
          construction: { type: 'boolean' },
        },
        ['id', 'kind', 'mode', 'points'],
        'Cubic spline: `fit` passes through `points` (C2, chord-length; `handles` = end tangent handles, the first/last Bézier control point); `control` uses `points` as the control polygon of a clamped B-spline (`knots` only after a split). The same point as first and last closes it.',
      ),
      obj(
        {
          id: str,
          kind: { const: 'text' },
          anchor: str,
          text: { type: 'string' },
          height: positive,
          angle: num,
          font: str,
          outline: { type: 'string' },
          construction: { type: 'boolean' },
        },
        ['id', 'kind', 'anchor', 'text', 'height', 'angle', 'font', 'outline'],
        'Text at `anchor` (baseline start): `height` is the cap height (mm), `angle` degrees; `outline` stores the glyph outlines (SVG path data, 1 = cap height) so the document needs no font. Each glyph is a profile (region keys "<textId>.<n>"). Create it with sketch.addText.',
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
      'translate',
      'rotate',
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
      value: num,
    },
    ['id', 'kind', 'refs'],
    'refs: coincident 2 points; horizontal/vertical 1 line or 2 points; parallel/perpendicular 2 lines; tangent 2 curves (one round, or line+ellipse, or a spline and a line/arc/spline sharing an end point); equal 2 lines or 2 round; fixed 1 point/curve; midpoint point + line; symmetric 2 points + line/point; concentric 2 round/elliptic; pointOnObject point + line/circle/arc/ellipse; translate points p, q, a, b (q − p = b − a, linear pattern); rotate points p, q, c with `value` degrees (circular pattern).',
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
      along: num,
      driven: { type: 'boolean' },
    },
    ['id', 'name', 'kind', 'refs', 'value'],
    'Driving dimension (mm, angle in degrees); `driven: true` makes it a reference dimension that only measures (sketch.setReference). `offset`/`along` place the label. refs: distance 1 line / 2 points / point + line / 2 parallel lines; horizontal/verticalDistance 1 line or 2 points; radius/diameter 1 circle/arc; angle 2 lines. `expression` (e.g. "d1 / 2 + 3") uses names of other driving dimensions of the sketch, or of a document parameter (`parameter.list`); editing a parameter re-solves every sketch that uses it.',
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
    'Document parameter ("variable"): `value` is always the last resolved value; `expression` (e.g. "wall * 2") is the source formula when the value is computed from other parameters. Usable from sketch dimension expressions and the numeric fields of extrude (distance), fillet (radius, radius2), chamfer (distance, distance2), shell/rib/thicken (thickness), hole (diameter) and draft (angle) via `<field>Expression`.',
  ),
  SketchPlane: {
    oneOf: [
      obj({ kind: { const: 'plane' }, plane: { enum: ['XY', 'XZ', 'YZ'] }, offset: num }, [
        'kind',
        'plane',
      ]),
      obj({ kind: { const: 'face' }, face: ref('FaceInput') }, ['kind', 'face']),
      obj(
        {
          kind: { const: 'construction' },
          featureId: str,
          frame: ref('Frame'),
          shown: obj({ center: ref('Vec3'), size: num }, ['center', 'size']),
        },
        ['kind', 'featureId'],
        'A construction plane (feature kind `constructionPlane`) by feature id; `frame` (its last evaluated frame) and `shown` (where it was drawn: centre and half size, the ghost of a missing reference) are filled by the server.',
      ),
    ],
  },
  Frame: obj(
    { origin: ref('Vec3'), u: ref('Vec3'), v: ref('Vec3'), normal: ref('Vec3') },
    ['origin', 'u', 'v', 'normal'],
    'Orthonormal frame: sketch (u, v) maps to origin + u·U + v·V; `normal` is the extrude direction.',
  ),
  PointRef: {
    oneOf: [
      obj({ kind: { const: 'point' }, point: ref('Vec3') }, ['kind', 'point'], 'A world point.'),
      obj(
        { kind: { const: 'edgeEnd' }, edge: ref('EdgeInput'), near: ref('Vec3') },
        ['kind', 'edge', 'near'],
        'The end of the edge nearest to `near`.',
      ),
      obj({ kind: { const: 'edgeMid' }, edge: ref('EdgeInput') }, ['kind', 'edge']),
      obj(
        { kind: { const: 'circleCenter' }, edge: ref('EdgeInput') },
        ['kind', 'edge'],
        'The centre of a circular edge.',
      ),
    ],
  },
  ExtrudeExtent: {
    oneOf: [
      obj({ kind: { const: 'distance' } }, ['kind'], '`distance` (default).'),
      obj(
        { kind: { const: 'throughAll' } },
        ['kind'],
        'Through every body in the direction of the sign of `distance` (both ways when symmetric).',
      ),
      obj(
        {
          kind: { const: 'toObject' },
          target: {
            oneOf: [
              obj({ kind: { const: 'face' }, face: ref('FaceInput') }, ['kind', 'face']),
              obj({ kind: { const: 'body' }, bodyId: str }, ['kind', 'bodyId']),
            ],
          },
        },
        ['kind', 'target'],
        'Up to a face (a planar face as its infinite plane; any other face: the first contact with its body) or a body (first contact), in the direction of the sign of `distance`.',
      ),
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
      obj(
        {
          kind: { const: 'construction' },
          featureId: str,
          line: obj({ point: ref('Vec3'), dir: ref('Vec3') }, ['point', 'dir']),
        },
        ['kind', 'featureId'],
        'A construction axis (feature kind `constructionAxis`) by feature id; `line` is filled by the server.',
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
  ...PRINT_DEFS,
};

const operation: JsonSchema = {
  enum: ['new', 'join', 'cut', 'intersect'],
  default: 'new',
  description:
    'New body, or join into / cut from / intersect with `targetBodyId` (default: the most recently changed body).',
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
        projections: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Projected body geometry {id, source: {kind: "edge"|"face", ref}, entities}; created by sketch.project, re-derived from the source on every evaluation.',
        },
        regionMemory: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Region fingerprints {key, sample, area, box} recorded on every write (geometric re-binding of redrawn profiles); maintained by the server.',
        },
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
      'Extrudes sketch profiles (or pushes/pulls a planar face) along the sketch normal; negative distance goes the other way. Extent Distance / Through All / To Object, one side / symmetric / two sides (`distance2`), start offset; New/Join/Cut/Intersect.',
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
        operation: {
          enum: ['new', 'join', 'cut', 'intersect'],
          default: 'new',
          description:
            'A face profile (push/pull) joins outwards and cuts inwards; only `intersect` overrides that.',
        },
        targetBodyId: str,
        resultBodyName: str,
        extent: ref('ExtrudeExtent'),
        distance2: {
          type: 'number',
          minimum: 0,
          description:
            'Two sides: how far the extrude also goes to the other side of the profile (ignored when symmetric).',
        },
        startOffset: {
          type: 'number',
          description: 'The extrude starts this far from the profile along its normal (mm).',
        },
      },
      ['profile'],
    ),
  },
  fillet: {
    label: 'Fillet',
    summary:
      'Rounds edges of one body (exact B-rep fillet): constant radius, or variable from `radius` to `radius2`; edges picked one by one and/or by `rules` (all edges of a face, all concave/convex edges).',
    params: obj(
      {
        edges: { type: 'array', items: ref('EdgeInput') },
        radius: positive,
        radiusExpression: {
          ...str,
          description: 'Formula over document parameters, resolved into `radius`.',
        },
        ...BLEND_OPTION_PARAMS.fillet,
      },
      [],
      '`edges` defaults to [] (then `rules` must pick edges). One of `radius` / `radiusExpression` is required.',
    ),
  },
  chamfer: {
    label: 'Chamfer',
    summary:
      'Bevels edges of one body: equal distance, two distances, or distance and angle; edges picked and/or by `rules`.',
    params: obj(
      {
        edges: { type: 'array', items: ref('EdgeInput') },
        distance: positive,
        distanceExpression: {
          ...str,
          description: 'Formula over document parameters, resolved into `distance`.',
        },
        ...BLEND_OPTION_PARAMS.chamfer,
      },
      [],
      '`edges` defaults to [] (then `rules` must pick edges). One of `distance` / `distanceExpression` is required.',
    ),
  },
  shell: {
    label: 'Shell',
    summary:
      'Hollows a body, opening the given faces; walls grow inwards (or outwards with `direction`), walls listed in `faceThickness` get their own thickness.',
    params: obj(
      {
        bodyId: str,
        faces: { type: 'array', items: ref('FaceInput'), minItems: 1 },
        thickness: positive,
        thicknessExpression: {
          ...str,
          description: 'Formula over document parameters, resolved into `thickness`.',
        },
        ...BLEND_OPTION_PARAMS.shell,
      },
      ['faces'],
      'One of `thickness` / `thicknessExpression` is required.',
    ),
  },
  boolean: {
    label: 'Boolean',
    summary: 'Union/subtract/intersect; the tool bodies are consumed unless `keepTools`.',
    params: obj(
      {
        operation: { enum: ['union', 'subtract', 'intersect'] },
        targetBodyId: str,
        toolBodyIds: { type: 'array', items: str, minItems: 1 },
        ...BLEND_OPTION_PARAMS.boolean,
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
    summary:
      'A STEP file (or, with `format: "iges"`, an IGES file; HimmelCAD OCCT build only) embedded (base64) as one history step producing bodies (`structure: "assembly"`: one per placed part, named, coloured, with folder paths; import.step sets it; import.iges sets `format`).',
    params: obj(
      { data: str, fileName: str, structure: { enum: ['assembly'] }, format: { enum: ['iges'] } },
      ['data', 'fileName'],
    ),
  },
  meshSolid: {
    label: 'Mesh to Solid',
    summary:
      'A closed triangle mesh (embedded, see mesh.toSolid which builds it from a reference mesh) as a B-rep solid; coplanar triangles become planar faces.',
    params: obj(
      {
        data: { ...str, description: 'Base64 welded-mesh payload (interop/meshSolid.ts).' },
        fileName: str,
        triangles: { type: 'integer', minimum: 0 },
      },
      ['data', 'fileName', 'triangles'],
    ),
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
      'Mirrors bodies, sketches and planar faces across a plane (world plane, planar face, construction plane) or, with `axis`, about a line (a half turn); with keepOriginal (default) the mirror images of bodies are new bodies. Mirrored sketches/faces become sketches "<featureId>:sketch:<i>" (sketchIds first, then faces) whose profiles extrude/revolve reference.',
    params: obj(
      {
        bodyIds: { type: 'array', items: str },
        plane: ref('SketchPlane'),
        keepOriginal: { type: 'boolean', default: true },
        sketchIds: { type: 'array', items: str },
        faces: { type: 'array', items: ref('FaceInput') },
        axis: ref('AxisRef'),
      },
      [],
      'At least one of bodyIds / sketchIds / faces must be non-empty. `plane` defaults to the YZ plane (and is ignored with `axis`).',
    ),
  },
  constructionPlane: {
    label: 'Plane',
    summary:
      'Construction plane (no body): offset from a plane/face, at an angle about an axis, through three points, midplane between two parallel planes/faces, or tangent to a cylindrical face. Usable as a sketch plane, mirror/split plane and section plane by `{kind: "construction", featureId}`.',
    params: obj(
      {
        definition: {
          oneOf: [
            obj({ kind: { const: 'offset' }, base: ref('SketchPlane'), distance: num }, [
              'kind',
              'base',
              'distance',
            ]),
            obj(
              {
                kind: { const: 'angle' },
                base: ref('SketchPlane'),
                axis: ref('AxisRef'),
                angle: num,
              },
              ['kind', 'base', 'axis', 'angle'],
              'Through `axis` (parallel to `base`), turned `angle` degrees from `base`.',
            ),
            obj(
              {
                kind: { const: 'threePoints' },
                points: { type: 'array', items: ref('PointRef'), minItems: 3, maxItems: 3 },
              },
              ['kind', 'points'],
            ),
            obj({ kind: { const: 'midplane' }, a: ref('SketchPlane'), b: ref('SketchPlane') }, [
              'kind',
              'a',
              'b',
            ]),
            obj(
              { kind: { const: 'tangent' }, face: ref('FaceInput'), angle: num },
              ['kind', 'face', 'angle'],
              '`angle` degrees around the cylinder axis, from the axis frame u.',
            ),
          ],
        },
        flip: { type: 'boolean', default: false },
      },
      ['definition'],
    ),
  },
  constructionAxis: {
    label: 'Axis',
    summary:
      'Construction axis (no body): along a straight edge (a circular edge: its axis), through two points, the axis of a cylindrical face, or the intersection of two planes. Usable as revolve/pattern/rotate axis and mirror line by `{kind: "construction", featureId}`.',
    params: obj(
      {
        definition: {
          oneOf: [
            obj({ kind: { const: 'edge' }, edge: ref('EdgeInput') }, ['kind', 'edge']),
            obj({ kind: { const: 'twoPoints' }, a: ref('PointRef'), b: ref('PointRef') }, [
              'kind',
              'a',
              'b',
            ]),
            obj({ kind: { const: 'cylinder' }, face: ref('FaceInput') }, ['kind', 'face']),
            obj({ kind: { const: 'planes' }, a: ref('SketchPlane'), b: ref('SketchPlane') }, [
              'kind',
              'a',
              'b',
            ]),
          ],
        },
        flip: { type: 'boolean', default: false },
      },
      ['definition'],
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
  rotateAxis: {
    label: 'Rotate',
    summary:
      'Rotates bodies by `angle` degrees about an axis (a straight or circular edge, a sketch line or a world axis) — "Rotate Around Axis"; `copy` keeps the originals and adds rotated copies.',
    params: obj(
      {
        bodyIds: { type: 'array', items: str, minItems: 1 },
        axis: ref('AxisRef'),
        angle: num,
        copy: { type: 'boolean', default: false },
      },
      ['bodyIds', 'axis', 'angle'],
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
      'Offsets faces of one body along their normals: positive adds material, negative removes it (e.g. enlarges a hole). With one face, `mode` "radius"/"diameter" sets a cylindrical face to that size and "total" sets its distance to the parallel `opposite` face; `distance` is then that target value, re-measured on every evaluation.',
    params: obj(
      {
        faces: { type: 'array', items: ref('FaceInput'), minItems: 1 },
        distance: {
          type: 'number',
          description:
            'mode "offset": signed offset (mm); "radius"/"diameter"/"total": the positive target value (mm).',
        },
        mode: { enum: [...OFFSET_FACE_MODES], default: 'offset' },
        opposite: ref('FaceInput'),
      },
      ['faces', 'distance'],
    ),
  },
  deleteFace: {
    label: 'Delete Face',
    summary: 'Removes faces (holes, fillets, chamfers) of one body and heals it.',
    params: obj({ faces: { type: 'array', items: ref('FaceInput'), minItems: 1 } }, ['faces']),
  },
  ...PRINT_FEATURE_KIND_SCHEMAS,
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
const meshExportParams = (extra: Record<string, JsonSchema>) =>
  obj({
    ...(exportParams.properties as Record<string, JsonSchema>),
    resolution: MESH_RESOLUTION_SCHEMA,
    ...extra,
  });

/** Result of parameter.create / parameter.edit. */
const RESULT_PARAMETER_EDIT =
  '{parameter: Parameter, revision, committed, resolvedSketchIds (sketches re-solved), changedFeatureIds, errors, warnings, bodies}';

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
  'datums.list': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Construction planes and axes (constructionPlane/constructionAxis steps) as evaluated: plane frame / axis point + direction, and the drawn centre and size.',
    params: obj({ scope }),
    result:
      '[{featureId, name, kind: "plane"|"axis", frame: {origin,u,v,normal}, center, size, error}] (axis: origin = a point on it, normal = its direction)',
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
      'Adds a document parameter (one undo step; not inside a transaction). Exactly one of `value`/`expression` is normally given; `expression` is resolved immediately (cycle/unknown-name errors reject with nothing changed).',
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
    result: RESULT_PARAMETER_EDIT,
  },
  'parameter.edit': {
    kind: 'command',
    capability: 'document.write',
    summary:
      "Changes a parameter's name, unit, value and/or expression as ONE undo step (not inside a transaction). A new value re-solves every sketch whose dimensions use the parameter (directly or through other parameters) and re-resolves every feature `*Expression` field; dependent features re-evaluate. All-or-nothing: a sketch the solver cannot satisfy rejects with `sketchConflict` (details.conflicts), a feature that newly fails in the kernel with `featureFailed` — nothing changes. `value` alone replaces a formula; `expression: null` removes it. Renaming rewrites every expression that references it.",
    params: obj(
      {
        parameterId: str,
        name: str,
        unit: { enum: ['mm', 'deg', ''] },
        value: num,
        expression: { anyOf: [str, { type: 'null' }] },
        expectedRevision: revision,
      },
      ['parameterId'],
    ),
    result: RESULT_PARAMETER_EDIT,
  },
  'parameter.delete': {
    kind: 'command',
    capability: 'document.write',
    summary:
      'Removes a parameter. Refused with `conflict` and the list of users when a sketch dimension or feature field still references it by name.',
    params: obj({ parameterId: str, expectedRevision: revision }, ['parameterId']),
    result: '{parameterId, revision, committed, errors, warnings, bodies}',
  },
  'measure.get': {
    kind: 'query',
    capability: 'document.read',
    summary:
      "The Measure panel's measurement of 1..n items (one body: size/volume/mass/area; one edge: length or radius/diameter; one face: area (+ cylinder diameter); two items: exact minimum distance from the kernel, parallel distance or angle; several bodies: combined box/volume/mass). Values carry `unit` (mm, mm², mm³, deg, g); `approx` marks mesh estimates.",
    params: obj(
      { items: { type: 'array', items: ref('MeasureTarget'), minItems: 1, maxItems: 16 }, scope },
      ['items'],
    ),
    result: '{title, subject, values: [{label, kind, value, unit, approx?, secondary?}], note?}',
  },
  'measure.distance': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Exact minimum distance between two bodies/faces/edges/points (kernel BRepExtrema_DistShapeShape) and the closest points.',
    params: obj({ a: ref('MeasureTarget'), b: ref('MeasureTarget'), scope }, ['a', 'b']),
    result: '{distance, pointA, pointB, unit: "mm", exact: true}',
  },
  'measure.angle': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Angle between two planar faces, two straight edges, or a straight edge and a planar face (deg). Parallel items give angle 0, `parallel: true` and their `distance`.',
    params: obj({ a: ref('MeasureTarget'), b: ref('MeasureTarget'), scope }, ['a', 'b']),
    result: '{angle, unit: "deg", parallel, distance?}',
  },
  'measure.area': {
    kind: 'query',
    capability: 'document.read',
    summary: 'Exact B-rep area of faces (selectors may match several; each face counted once).',
    params: obj({ faces: { type: 'array', items: ref('FaceInput'), minItems: 1 }, scope }, [
      'faces',
    ]),
    result: '{area, unit: "mm²", faces: [{bodyId, key, surface, area}]}',
  },
  'measure.volume': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Exact B-rep volume, surface area, bounding box and mass (density of the body material set with its appearance, PLA otherwise; solid) of the given bodies (default: all).',
    params: obj({ bodyIds: { type: 'array', items: str }, scope }),
    result:
      '{volume, mass, units, bodies: [{bodyId, name, volume, surfaceArea, material, densityGPerCm3, mass, bbox}]}',
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
  'sketch.addSpline': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds a spline: `fit` (default) passes through `points` with end tangent handles (constrain tangency with sketch.addConstraint "tangent" to a line/arc/spline sharing its end point); `control` uses `points` as control polygon. `closed` ends on the first point.',
    params: obj(
      {
        featureId: str,
        points: { type: 'array', items: ref('Vec2'), minItems: 2 },
        mode: { enum: ['fit', 'control'], default: 'fit' },
        closed: { type: 'boolean', default: false },
        construction: { type: 'boolean', default: false },
        expectedRevision: revision,
      },
      ['featureId', 'points'],
    ),
    result: '{featureId, entityId, pointIds, handleIds, dof, regions, revision, committed}',
  },
  'sketch.addEllipse': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds an ellipse (or, with `arc: [startDeg, endDeg]` parametric angles, an elliptical arc) at `center` with the major axis along `angle` degrees. `dimension: true` adds the two axis radii as dimensions.',
    params: obj(
      {
        featureId: str,
        center: ref('Vec2'),
        majorRadius: positive,
        minorRadius: positive,
        angle: num,
        arc: ref('Vec2'),
        dimension: { type: 'boolean', default: false },
        construction: { type: 'boolean', default: false },
        expectedRevision: revision,
      },
      ['featureId', 'center', 'majorRadius', 'minorRadius'],
    ),
    result: '{featureId, entityId, entityIds, dof, regions, revision, committed}',
  },
  'sketch.addSlot': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds a slot of `width` between the centres `start` and `end` (dimensioned centre distance and width unless `dimension: false`); with `arcCenter` an arc slot along the circle through `start` (counter-clockwise to the angle of `end`, `clockwise: true` the other way).',
    params: obj(
      {
        featureId: str,
        start: ref('Vec2'),
        end: ref('Vec2'),
        width: positive,
        arcCenter: ref('Vec2'),
        clockwise: { type: 'boolean', default: false },
        dimension: { type: 'boolean', default: true },
        construction: { type: 'boolean', default: false },
        expectedRevision: revision,
      },
      ['featureId', 'start', 'end', 'width'],
    ),
    result: '{featureId, curveIds, entityIds, dof, regions, revision, committed}',
  },
  'sketch.addPolygon': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds a regular polygon on a construction circle of `radius`: inscribed (vertices on the circle, default) or circumscribed (`inscribed: false`, edges tangent to it); `angle` turns the first vertex / edge midpoint.',
    params: obj(
      {
        featureId: str,
        center: ref('Vec2'),
        radius: positive,
        sides: { type: 'integer', minimum: 3, maximum: 64, default: 6 },
        inscribed: { type: 'boolean', default: true },
        angle: num,
        construction: { type: 'boolean', default: false },
        expectedRevision: revision,
      },
      ['featureId', 'center', 'radius'],
    ),
    result: '{featureId, lineIds, centerId, circleId, dof, regions, revision, committed}',
  },
  'sketch.addText': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds text (font Inter, SIL OFL 1.1) with its baseline starting at `position`: `height` is the cap height (mm), `angle` degrees. Every glyph becomes a closed profile (counters stay open) for extrude/emboss.',
    params: obj(
      {
        featureId: str,
        text: str,
        position: ref('Vec2'),
        height: positive,
        angle: num,
        font: { enum: ['inter'], default: 'inter' },
        construction: { type: 'boolean', default: false },
        expectedRevision: revision,
      },
      ['featureId', 'text', 'position', 'height'],
    ),
    result: '{featureId, entityId, anchorId, missingCharacters, dof, regions, revision, committed}',
  },
  'sketch.mirror': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Mirrors curves/points `ids` about the line `axis`; the copies are tied to the originals by symmetric constraints (they follow later edits).',
    params: obj(
      {
        featureId: str,
        ids: { type: 'array', items: str, minItems: 1 },
        axis: str,
        expectedRevision: revision,
      },
      ['featureId', 'ids', 'axis'],
    ),
    result: '{featureId, createdIds, dof, regions, revision, committed}',
  },
  'sketch.pattern': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Repeats curves/points `ids`: linear (`direction`, `spacing` — a spacing dimension drives every copy) or circular (`center`, `angle` total degrees, 360 = full turn); `count` includes the original.',
    params: obj(
      {
        featureId: str,
        ids: { type: 'array', items: str, minItems: 1 },
        mode: { enum: ['linear', 'circular'], default: 'linear' },
        count: { type: 'integer', minimum: 2, maximum: 200 },
        direction: ref('Vec2'),
        spacing: positive,
        center: ref('Vec2'),
        centerPointId: str,
        angle: num,
        expectedRevision: revision,
      },
      ['featureId', 'ids', 'count'],
    ),
    result: '{featureId, createdIds, dof, regions, revision, committed}',
  },
  'sketch.roundCorner': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Fillets (radius `size`) or chamfers (set-back `size`) the corner at point `point` between two lines; the corner point stays as a virtual sharp so dimensions to it survive.',
    params: obj(
      {
        featureId: str,
        point: str,
        size: positive,
        mode: { enum: ['fillet', 'chamfer'], default: 'fillet' },
        expectedRevision: revision,
      },
      ['featureId', 'point', 'size'],
    ),
    result: '{featureId, createdIds, dof, regions, revision, committed}',
  },
  'sketch.project': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Projects a body `edge` or the boundary of a `face` into the sketch along its normal (construction unless `construction: false`). Associative: the projected geometry follows the source on re-evaluation; a lost source keeps it frozen with a warning.',
    params: obj(
      {
        featureId: str,
        edge: ref('EdgeInput'),
        face: ref('FaceInput'),
        construction: { type: 'boolean', default: true },
        expectedRevision: revision,
      },
      ['featureId'],
    ),
    result: '{featureId, projectionId, entityIds, dof, regions, revision, committed}',
  },
  'sketch.setReference': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Makes a dimension (by id or name) a reference (driven) dimension that only measures, or driving again with `reference: false`.',
    params: obj(
      {
        featureId: str,
        dimension: str,
        reference: { type: 'boolean', default: true },
        expectedRevision: revision,
      },
      ['featureId', 'dimension'],
    ),
    result: '{featureId, dimensionId, name, reference, dof, regions, revision, committed}',
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
    summary:
      'STL of all (or the given) bodies in one file: binary (default) or ASCII, at the display mesh or a resolution preset.',
    params: meshExportParams({
      format: { enum: ['binary', 'ascii'], default: 'binary' },
    }),
    result: '{mediaType, byteLength, triangles, data?: base64, path?}',
  },
  'export.3mf': {
    kind: 'command',
    capability: 'document.read',
    summary:
      '3MF package (3MF Core + Materials): one welded, manifold object per body with its name and colour, build items with transforms.',
    params: meshExportParams({}),
    result: '{mediaType, byteLength, triangles, data?: base64, path?}',
  },
  'export.step': {
    kind: 'command',
    capability: 'document.read',
    summary:
      'Exact-B-rep STEP of all (or the given) bodies with names and colours: AP242 (default) or AP214, a chosen length unit, flat parts or the Items folders as sub-assemblies, optionally only visible bodies.',
    params: obj({
      ...(exportParams.properties as Record<string, JsonSchema>),
      ...STEP_EXPORT_PARAMS,
    }),
    result: '{mediaType, byteLength, bodyIds, data?: base64, path?}',
  },
  'export.iges': {
    kind: 'command',
    capability: 'document.read',
    summary:
      'Exact-B-rep IGES of all (or the given) bodies: geometry and length unit only (no names or colours). `faces` (default: trimmed surfaces, read by every IGES system) or `brep` (MSBO solids, IGES 5.3). Needs the HimmelCAD OCCT build (interop.formats reports it); `unsupported` otherwise.',
    params: obj({
      ...(exportParams.properties as Record<string, JsonSchema>),
      unit: { enum: ['mm', 'cm', 'm', 'in'], default: 'mm' },
      mode: { enum: ['faces', 'brep'], default: 'faces' },
      visibleOnly: {
        type: 'boolean',
        default: false,
        description: 'Leave out bodies hidden in the app (Items eye).',
      },
    }),
    result: '{mediaType, byteLength, bodyIds, data?: base64, path?}',
  },
  'import.step': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Imports a STEP file as one "Import" history step: one body per placed part with names, colours and assembly folders (`structure: "single"`: the whole file as one body).',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'Headless only (filesystem.read).' },
        data: { type: 'string', minLength: 1, description: 'Base64 STEP bytes.' },
        fileName: str,
        structure: STEP_IMPORT_STRUCTURE,
        expectedRevision: revision,
      },
      additionalProperties: false,
      anyOf: [{ required: ['path'] }, { required: ['data', 'fileName'] }],
    },
    result:
      '{featureId, createdBodyIds, parts: [{bodyId, name, color, itemPath}], warnings?, revision, committed, errors}',
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
  ...PRINT_METHODS,
  ...INTEROP_METHODS,
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
