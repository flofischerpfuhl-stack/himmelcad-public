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
import { API_ERROR_CODES } from '../../foundation/commands/api/errors.js';
import { MESH_RESOLUTION_SCHEMA } from '../../modules/print/api.js';
import { STEP_EXPORT_PARAMS } from '../../modules/interop/interopApi.js';
import { BLEND_OPTION_PARAMS } from '../../modules/modeling/printSchema.js';
import {
  schemaScope,
  type FeatureKindSpec,
  type MethodSpec,
} from '../../foundation/commands/api/contract.js';
import {
  API_DEFS,
  API_FEATURE_KINDS,
  API_METHODS,
  API_ORDER,
  registerApiContribution,
  type ApiMethod,
} from '../../foundation/commands/api/registry.js';
import type { JsonSchema } from '../../foundation/commands/api/validate.js';

export const API_ID = 'hcasm.agent-api';
export const API_VERSION = 1;

export type {
  Capability,
  FeatureKindSpec,
  MethodKind,
  MethodSpec,
} from '../../foundation/commands/api/contract.js';

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

const DEFS_HEAD: Record<string, JsonSchema> = {
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
};

const DEFS_MID: Record<string, JsonSchema> = {
  EdgeInput: { oneOf: [ref('EdgeRef'), ref('Selector')] },
};

// `MeasureTarget` (measure module, `API_ORDER.defs.measure`) sits between these blocks.
const DEFS_SKETCH: Record<string, JsonSchema> = {
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
};

const DEFS_TAIL: Record<string, JsonSchema> = {
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
          spacingMode: {
            enum: ['spacing', 'total'],
            default: 'spacing',
            description: '`total`: `spacing` (and `second.spacing`) is first to last instance.',
          },
          second: obj(
            {
              direction: ref('AxisRef'),
              count: { type: 'integer', minimum: 1, maximum: 200 },
              spacing: num,
            },
            ['direction', 'count', 'spacing'],
            'A second direction: a grid of count × second.count instances (at most 1000).',
          ),
        },
        ['kind', 'direction', 'count', 'spacing'],
      ),
      obj(
        {
          kind: { const: 'circular' },
          axis: ref('AxisRef'),
          count: { type: 'integer', minimum: 2, maximum: 200 },
          angle: { type: 'number', exclusiveMinimum: 0, maximum: 360 },
          angleMode: {
            enum: ['total', 'spacing'],
            default: 'total',
            description: '`spacing`: `angle` is between neighbours instead of the total.',
          },
          uniform: {
            type: 'boolean',
            default: false,
            description: 'Copies keep their orientation (moved along the circle, not turned).',
          },
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
      obj(
        { kind: { const: 'sketchCurve' }, featureId: str, entityId: str },
        ['kind', 'featureId', 'entityId'],
        'One curve of a sketch (sketches.list entity id), selected outside sketch mode.',
      ),
    ],
  },
};

/**
 * Parameter schemas of the feature kinds this build knows. A feature kind
 * added to `model/document.ts` should get an entry here; until it does, the
 * API still accepts it generically (validated by the project format).
 */
const CORE_FEATURE_KIND_SCHEMAS: Record<string, FeatureKindSpec> = {
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
        patterns: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Editable sketch patterns {id, kind: "linear"|"circular", sources, count, count2?, lines?, center?, angle?, created}; created by sketch.pattern, changed with sketch.editPattern.',
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
      'Extrudes sketch profiles (or pushes/pulls a planar face) along the sketch normal; negative distance goes the other way. Extent Distance / Through All / To Object, one side / symmetric / two sides (`distance2`), start offset, taper angle; New/Join/Cut/Intersect.',
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
        taper: {
          type: 'number',
          minimum: -80,
          maximum: 80,
          description:
            'Taper (draft) angle of the side walls in degrees: positive narrows the solid away from the start plane (holes widen), negative widens it; both sides of a symmetric/two-sided extrude narrow away from the start. Distance extent only; sides of lines, arcs and circles.',
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
};

const scope = schemaScope;

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

const METHODS_HEAD: Record<string, MethodSpec> = {
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
};

// `sketches.list` (sketching) and `datums.list` (construction) sit between these blocks.
const METHODS_SELECTION: Record<string, MethodSpec> = {
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
};

// The parameter methods and `measure.*` (their modules) come before these.
const METHODS_FEATURES: Record<string, MethodSpec> = {
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
};

// The `sketch.*` edits (sketching) sit between these blocks.
const METHODS_TAIL: Record<string, MethodSpec> = {
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
  'export.obj': {
    kind: 'command',
    capability: 'document.read',
    summary:
      'Wavefront OBJ of all (or the given) bodies: one object per body named after it, shared vertices with normals, millimetres; no materials (use 3MF or STEP for colours).',
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
};

// `import.step` (interop) sits between these blocks.
const METHODS_PROJECT: Record<string, MethodSpec> = {
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

const spec = (methods: Record<string, MethodSpec>): Record<string, ApiMethod> =>
  Object.fromEntries(Object.entries(methods).map(([name, s]) => [name, { spec: s }]));

// The agent-api module's own part of the contract: the shared reference
// definitions, the core feature kinds and the methods the session implements.
// The domain modules register theirs in between (`API_ORDER`).
registerApiContribution('agent-api', {
  defs: [
    { order: API_ORDER.defs.coreHead, defs: DEFS_HEAD },
    { order: API_ORDER.defs.coreMid, defs: DEFS_MID },
    { order: API_ORDER.defs.coreSketch, defs: DEFS_SKETCH },
    { order: API_ORDER.defs.coreTail, defs: DEFS_TAIL },
  ],
  featureKinds: [{ order: API_ORDER.featureKinds.core, kinds: CORE_FEATURE_KIND_SCHEMAS }],
  methods: [
    { order: API_ORDER.methods.coreHead, methods: spec(METHODS_HEAD) },
    { order: API_ORDER.methods.coreSelection, methods: spec(METHODS_SELECTION) },
    { order: API_ORDER.methods.coreFeatures, methods: spec(METHODS_FEATURES) },
    { order: API_ORDER.methods.coreTail, methods: spec(METHODS_TAIL) },
    { order: API_ORDER.methods.coreProject, methods: spec(METHODS_PROJECT) },
  ],
});

/** Every `$defs` entry of this build (live, composed from the modules' registrations). */
export const DEFS: Record<string, JsonSchema> = API_DEFS;
/**
 * Parameter schemas of the feature kinds this build knows (live). A feature
 * kind's module registers its entry; until it does, the API still accepts
 * the kind generically (validated by the project format).
 */
export const FEATURE_KIND_SCHEMAS: Record<string, FeatureKindSpec> = API_FEATURE_KINDS;
/** Every method of this build (live). */
export const METHODS: Record<string, MethodSpec> = API_METHODS;

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
