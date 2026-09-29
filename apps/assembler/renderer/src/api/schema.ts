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
  SketchProfile: {
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
        'Axis-aligned rectangle in sketch (u, v) coordinates; (x, y) is a corner.',
      ),
      obj({ kind: { const: 'circle' }, cx: num, cy: num, radius: positive }, [
        'kind',
        'cx',
        'cy',
        'radius',
      ]),
    ],
  },
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
          profileIndex: { type: 'integer', minimum: 0 },
        },
        ['kind', 'featureId'],
        'All profiles of the sketch (fused) unless `profileIndex` is given.',
      ),
      obj(
        { kind: { const: 'face' }, face: ref('FaceInput') },
        ['kind', 'face'],
        'Push/pull of a planar body face along its outward normal.',
      ),
    ],
  },
  SelectionItem: {
    oneOf: [
      obj({ kind: { const: 'body' }, bodyId: str }, ['kind', 'bodyId']),
      obj({ kind: { const: 'face' }, bodyId: str, faceKey: str }, ['kind', 'bodyId', 'faceKey']),
      obj({ kind: { const: 'edge' }, bodyId: str, edgeKey: str }, ['kind', 'bodyId', 'edgeKey']),
      obj({ kind: { const: 'sketchProfile' }, featureId: str }, ['kind', 'featureId']),
      obj({ kind: { const: 'feature' }, featureId: str }, ['kind', 'featureId']),
    ],
  },
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
    summary: 'Closed profiles on a construction plane or a planar body face (mm, sketch u/v).',
    params: obj(
      {
        plane: ref('SketchPlane'),
        profiles: { type: 'array', items: ref('SketchProfile'), minItems: 1 },
      },
      ['plane', 'profiles'],
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
        symmetric: { type: 'boolean', default: false },
        operation: { enum: ['new', 'join', 'cut'], default: 'new' },
        targetBodyId: str,
        resultBodyName: str,
      },
      ['profile', 'distance'],
    ),
  },
  fillet: {
    label: 'Fillet',
    summary: 'Rounds edges of one body with a constant radius (exact B-rep fillet).',
    params: obj(
      { edges: { type: 'array', items: ref('EdgeInput'), minItems: 1 }, radius: positive },
      ['edges', 'radius'],
    ),
  },
  chamfer: {
    label: 'Chamfer',
    summary: 'Bevels edges of one body with a constant distance.',
    params: obj(
      { edges: { type: 'array', items: ref('EdgeInput'), minItems: 1 }, distance: positive },
      ['edges', 'distance'],
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
      },
      ['faces', 'thickness'],
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
    summary: 'Sketches with their frame and profiles (parameters and world-space centres).',
    params: obj({ scope }),
    result:
      '[{featureId, name, plane, frame: {origin,u,v,normal}, profiles: [{index, kind, params, center}], consumed}]',
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
    summary: 'Adds a profile to an existing sketch.',
    params: obj({ featureId: str, profile: ref('SketchProfile'), expectedRevision: revision }, [
      'featureId',
      'profile',
    ]),
    result: '{featureId, profileIndex, revision, committed, errors}',
  },
  'sketch.editProfile': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary: 'Replaces profile `index` of a sketch (its dimensions are its parameters).',
    params: obj(
      {
        featureId: str,
        index: { type: 'integer', minimum: 0 },
        profile: ref('SketchProfile'),
        expectedRevision: revision,
      },
      ['featureId', 'index', 'profile'],
    ),
    result: '{featureId, profileIndex, revision, committed, errors}',
  },
  'sketch.removeProfile': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary: 'Removes profile `index` of a sketch (a sketch keeps at least one profile).',
    params: obj(
      { featureId: str, index: { type: 'integer', minimum: 0 }, expectedRevision: revision },
      ['featureId', 'index'],
    ),
    result: '{featureId, revision, committed, errors}',
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
    sketchEntities: 'rectangle and circle profiles; lines/arcs/constraints await the sketch solver',
  },
} as const;
