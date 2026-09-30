/**
 * The 3D-printing part of the agent contract (`hcasm.agent-api@1`):
 * method schemas (merged into `schema.ts` `METHODS`) and the JSON shapes of
 * results. Execution lives in `session.ts`; the geometry in `print/`.
 */
import type { PrintReport } from '../print/analysis.js';
import type { OrientationCandidate } from '../print/orientation.js';
import type { MethodSpec } from './schema.js';
import type { JsonSchema } from '../foundation/commands/api/validate.js';

type Json = Record<string, unknown>;

const str: JsonSchema = { type: 'string', minLength: 1 };
const revision: JsonSchema = {
  type: 'integer',
  minimum: 0,
  description:
    'Optimistic concurrency: the command fails with `conflict` unless the document revision still equals this value.',
};
const scope: JsonSchema = {
  enum: ['auto', 'committed', 'staged'],
  default: 'auto',
  description: "`auto`: the open transaction's staged state if any, else the committed document.",
};
const vec3: JsonSchema = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };

function obj(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** Mesh resolution of STL/3MF exports and `export.meshStats`. */
export const MESH_RESOLUTION_SCHEMA: JsonSchema = {
  enum: ['current', 'coarse', 'standard', 'fine'],
  default: 'current',
  description:
    '`current`: the evaluated display mesh. Presets re-tessellate the exact B-rep: coarse 0.1 mm / 0.5 rad, standard 0.025 mm / 0.25 rad, fine 0.005 mm / 0.1 rad (chordal / angular deflection).',
};

/** Printability settings (every field optional; unset fields use the defaults). */
export const PRINT_SETTINGS_SCHEMA: JsonSchema = {
  ...obj({
    overhangAngleDeg: {
      type: 'number',
      minimum: 0,
      maximum: 89,
      description: 'Faces steeper than this from vertical need support (default 45).',
    },
    minWallMm: { type: 'number', minimum: 0, description: 'Thin-wall threshold (default 0.8).' },
    minHoleMm: { type: 'number', minimum: 0, description: 'Smallest hole diameter (default 2).' },
    minPinMm: { type: 'number', minimum: 0, description: 'Smallest pin diameter (default 1).' },
    material: { enum: ['PLA', 'PETG', 'ABS', 'TPU', 'custom'] },
    density: { type: 'number', exclusiveMinimum: 0, description: 'g/cm³ (material custom).' },
    costPerKg: { type: 'number', minimum: 0 },
    currency: { type: 'string', minLength: 1, description: 'Label only (first 8 characters).' },
    buildVolume: { enum: ['none', 'bambuX1', 'bambuP1', 'prusaMk4', 'ender3', 'custom'] },
    customVolume: { ...vec3, description: 'Build volume X, Y, Z in mm (buildVolume custom).' },
  }),
  description: 'Printability thresholds, material and printer. Build direction is +Z.',
};

export const PRINT_METHODS: Record<string, MethodSpec> = {
  'print.analyze': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Printability of the bodies (build direction +Z): overhang area/faces beyond the angle, sampled wall thickness, small holes/pins, B-rep validity, watertight mesh, volume, mass and cost, build-volume fit, plus a findings list.',
    params: obj({
      bodyIds: { type: 'array', items: str, minItems: 1 },
      settings: { $ref: '#/$defs/PrintSettings' },
      scope,
    }),
    result:
      '{settings, totals: {bodies, volumeMm3, massG, cost}, bodies: [{bodyId, name, brepValid, watertight, boundaryEdges, nonManifoldEdges, volumeMm3, massG, cost, size, overhang: {areaMm2, totalAreaMm2, faces: [{faceKey, areaMm2, maxAngleDeg}]}, thinWall: {samples, thinSamples, minThicknessMm, faces: [{faceKey, areaMm2, minThicknessMm}]}, holes: [{faceKey, kind, diameterMm, flagged}], buildVolume}], findings: [{id, kind, severity, bodyId, faceKeys, message, value}]}',
  },
  'print.orientations': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Ranks orientations of one body for printing: the six principal directions and the largest planar faces facing the plate, by overhang area, then height.',
    params: obj(
      {
        bodyId: str,
        overhangAngleDeg: { type: 'number', minimum: 0, maximum: 89 },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 3 },
        scope,
      },
      ['bodyId'],
    ),
    result:
      '[{rank, label, down, overhangAreaMm2, heightMm, contactAreaMm2, transform: {rx, ry, rz, pivot, dx, dy, dz}}]',
  },
  'print.placeOnPlate': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Lays a planar face flat on the build plate: adds one transform step that rotates the body so the face points −Z and drops it to Z = 0.',
    params: obj({ face: { $ref: '#/$defs/FaceInput' }, name: str, expectedRevision: revision }, [
      'face',
    ]),
    result: '{featureId, bodyId, transform, revision, committed, errors, bodies}',
  },
  'print.orient': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Orients a body for printing: `rank` applies that print.orientations candidate, `down` turns the given outward direction to −Z. One transform step, body dropped to Z = 0.',
    params: {
      ...obj(
        {
          bodyId: str,
          rank: { type: 'integer', minimum: 1 },
          down: vec3,
          overhangAngleDeg: { type: 'number', minimum: 0, maximum: 89 },
          name: str,
          expectedRevision: revision,
        },
        ['bodyId'],
      ),
      oneOf: [{ required: ['rank'] }, { required: ['down'] }],
    },
    result: '{featureId, bodyId, transform, candidate?, revision, committed, errors, bodies}',
  },
  'export.meshStats': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Triangle counts per body at an export resolution, with the expected binary/ASCII STL sizes (the export preview).',
    params: obj({
      bodyIds: { type: 'array', items: str, minItems: 1 },
      resolution: MESH_RESOLUTION_SCHEMA,
      scope,
    }),
    result:
      '{resolution, bodies: [{id, name, triangles}], triangles, stlBinaryBytes, stlAsciiBytes}',
  },
};

const round = (v: number, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits;

/** JSON result of `print.analyze` (typed arrays and per-triangle data left out). */
export function printReportJson(report: PrintReport): Json {
  return {
    settings: report.settings,
    totals: {
      bodies: report.totals.bodies,
      volumeMm3: round(report.totals.volumeMm3),
      massG: round(report.totals.massG),
      cost: round(report.totals.cost, 2),
    },
    bodies: report.bodies.map((b) => ({
      bodyId: b.bodyId,
      name: b.name,
      triangleCount: b.triangleCount,
      brepValid: b.brepValid,
      watertight: b.watertight,
      boundaryEdges: b.boundaryEdges,
      nonManifoldEdges: b.nonManifoldEdges,
      inconsistentEdges: b.inconsistentEdges,
      volumeMm3: round(b.volumeMm3),
      meshVolumeMm3: round(b.meshVolumeMm3),
      massG: round(b.massG),
      cost: round(b.cost, 2),
      min: b.min.map((v) => round(v)),
      max: b.max.map((v) => round(v)),
      size: b.size.map((v) => round(v)),
      overhang: {
        areaMm2: round(b.overhang.areaMm2),
        totalAreaMm2: round(b.overhang.totalAreaMm2),
        faces: b.overhang.faces.map((f) => ({
          faceKey: f.faceKey,
          areaMm2: round(f.area),
          maxAngleDeg: round(f.value, 2),
        })),
      },
      thinWall: {
        samples: b.thinWall.samples,
        thinSamples: b.thinWall.thinSamples,
        minThicknessMm:
          b.thinWall.minThicknessMm === null ? null : round(b.thinWall.minThicknessMm),
        faces: b.thinWall.faces.map((f) => ({
          faceKey: f.faceKey,
          areaMm2: round(f.area),
          minThicknessMm: round(f.value),
        })),
      },
      holes: b.cylinders.map((c) => ({ ...c, diameterMm: round(c.diameterMm) })),
      buildVolume: b.buildVolume,
    })),
    findings: report.findings.map((f) => ({
      ...f,
      ...(f.value !== undefined ? { value: round(f.value) } : {}),
    })),
  };
}

export function candidateJson(c: OrientationCandidate): Json {
  return {
    rank: c.rank,
    label: c.label,
    down: c.down.map((v) => round(v, 6)),
    overhangAreaMm2: round(c.overhangAreaMm2),
    heightMm: round(c.heightMm),
    contactAreaMm2: round(c.contactAreaMm2),
    transform: c.transform,
  };
}
