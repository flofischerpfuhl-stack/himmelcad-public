/**
 * The 3D-printing part of the agent contract (`hcasm.agent-api@1`): the
 * `PrintSettings` schema, the `print.*` and `export.meshStats` methods with
 * their handlers (on the session services, `ApiContext`), and the JSON
 * shapes of results. Registered by the print module (`module.ts`).
 */
import type {
  ApiContext,
  Json,
  MethodSpec,
  WriteOutcome,
} from '../../foundation/commands/api/contract.js';
import { findBody, paramsOf } from '../../foundation/commands/api/describe.js';
import { ApiError } from '../../foundation/commands/api/errors.js';
import { resolveFaceInput } from '../../foundation/commands/api/references.js';
import {
  API_ORDER,
  type ApiContribution,
  type ApiHandler,
} from '../../foundation/commands/api/registry.js';
import type { JsonSchema } from '../../foundation/commands/api/validate.js';
import { referenceMeshIdOf } from '../../foundation/commands/referenceMesh.js';
import type { Feature } from '../../foundation/document/document.js';
import { stlAsciiForMeshes } from '../../foundation/geometry-kernel/stlExport.js';
import type { EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import {
  analyzePrintability,
  bodyToPrintInput,
  type PrintBodyInput,
  type PrintReport,
} from './analysis.js';
import {
  placementFor,
  rankOrientations,
  rotationToDown,
  type OrientationCandidate,
  type OrientationMesh,
  type PlacementTransform,
} from './orientation.js';
import {
  orientationInput,
  orientFeatureName,
  placeOnPlateFeature,
  placementFeature,
  PlacementError,
} from './placement.js';
import {
  DEFAULT_PRINT_SETTINGS,
  MATERIAL_PRESETS,
  sanitizePrintSettings,
  type PrintSettings,
} from './settings.js';
import { runClearancePass } from './clearance.js';
import { mergeFindings, usePrintStore } from './printStore.js';

/**
 * Host services of the print methods: app only, the print worker and the
 * Printability panel's settings (`automationStore.ts` provides them).
 */
declare module '../../foundation/commands/api/contract.js' {
  interface SessionHostExtensions {
    /**
     * App only: runs printability jobs off the UI thread (the print worker).
     * Without it (headless) they run in-process.
     */
    printability?: {
      analyze(bodies: PrintBodyInput[], settings: PrintSettings): Promise<PrintReport>;
      orient(
        mesh: OrientationMesh,
        thresholdDeg: number,
        faceLabels: string[],
      ): Promise<OrientationCandidate[]>;
    };
    /** App only: the user's print settings (Printability panel), the defaults for agent queries. */
    printSettings?: () => PrintSettings;
  }
}

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
    checkClearance: {
      type: 'boolean',
      description:
        'Measure the clearance between bodies in the kernel: overlaps and gaps below minClearanceMm become findings (default true).',
    },
    minClearanceMm: {
      type: 'number',
      minimum: 0,
      description: 'Smallest gap between bodies, e.g. print-in-place (default 0.3).',
    },
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
      'Printability of the bodies (build direction +Z): overhang area/faces beyond the angle, sampled wall thickness, small holes/pins, B-rep validity, watertight mesh, volume, mass and cost, build-volume fit, clearance between bodies (overlaps and gaps below minClearanceMm, exact from the kernel), plus a findings list. Every finding is returned, also those the user ignored in the app (`ignored: true`) or hid by type.',
    params: obj({
      bodyIds: { type: 'array', items: str, minItems: 1 },
      settings: { $ref: '#/$defs/PrintSettings' },
      scope,
    }),
    result:
      '{settings, totals: {bodies, volumeMm3, massG, cost}, bodies: [{bodyId, name, brepValid, watertight, boundaryEdges, nonManifoldEdges, volumeMm3, massG, cost, size, overhang: {areaMm2, totalAreaMm2, faces: [{faceKey, areaMm2, maxAngleDeg}]}, thinWall: {samples, thinSamples, minThicknessMm, faces: [{faceKey, areaMm2, minThicknessMm}]}, holes: [{faceKey, kind, diameterMm, flagged}], buildVolume}], findings: [{id, kind, severity, bodyId, faceKeys, message, value, otherBodyId?, segment?, point?, ignored?}]}',
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
export function printReportJson(report: PrintReport, ignored?: ReadonlySet<string>): Json {
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
      ...(f.segment ? { segment: f.segment.map((p) => p.map((v) => round(v, 6))) } : {}),
      ...(f.point ? { point: f.point.map((v) => round(v, 6)) } : {}),
      ...(ignored?.has(f.id) ? { ignored: true } : {}),
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

// ---- handlers ------------------------------------------------------------------------

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function printSettings(ctx: ApiContext, input: unknown): PrintSettings {
  const base = ctx.host.printSettings?.() ?? DEFAULT_PRINT_SETTINGS;
  return sanitizePrintSettings({
    ...base,
    ...(isRecord(input) ? input : {}),
    ...(isRecord(input) && typeof input.material === 'string' && input.density === undefined
      ? {
          density: MATERIAL_PRESETS.find((m) => m.id === input.material)?.density,
          costPerKg:
            input.costPerKg ?? MATERIAL_PRESETS.find((m) => m.id === input.material)?.costPerKg,
        }
      : {}),
  });
}

async function rankedOrientations(
  ctx: ApiContext,
  p: Json,
  evaluation: EvaluationResult,
  features: readonly Feature[],
): Promise<OrientationCandidate[]> {
  const bodyId = String(p.bodyId);
  findBody(evaluation, bodyId);
  const threshold =
    typeof p.overhangAngleDeg === 'number'
      ? p.overhangAngleDeg
      : printSettings(ctx, undefined).overhangAngleDeg;
  const input = orientationInput(evaluation, features, bodyId);
  return ctx.host.printability
    ? ctx.host.printability.orient(input.mesh, threshold, input.faceLabels)
    : rankOrientations(input.mesh, threshold, {
        faceLabel: (_key, index) => input.faceLabels[index] ?? `Face ${index + 1} down`,
      });
}

const meshStats: ApiHandler = async (ctx, p) => {
  const evaluation = await ctx.readEvaluation(p);
  const ids = Array.isArray(p.bodyIds) ? (p.bodyIds as string[]) : null;
  for (const id of ids ?? []) findBody(evaluation, id);
  const bodyIds = ids ?? evaluation.bodies.map((b) => b.id);
  if (bodyIds.length === 0) {
    throw new ApiError('invalidParams', 'There are no bodies', {
      hint: 'Create a body first (e.g. a sketch and an extrude).',
    });
  }
  const meshes = await ctx.exportMeshes(p, bodyIds);
  const counts = meshes.map((m) => ({
    id: m.id,
    name: evaluation.bodies.find((b) => b.id === m.id)?.name ?? m.name,
    triangles: m.mesh.indices.length / 3,
  }));
  const triangles = counts.reduce((s, c) => s + c.triangles, 0);
  return {
    resolution: (p.resolution as string | undefined) ?? 'current',
    bodies: counts,
    triangles,
    stlBinaryBytes: 84 + triangles * 50,
    stlAsciiBytes: stlAsciiForMeshes(meshes.map((m) => ({ name: m.name, mesh: m.mesh })))
      .byteLength,
  };
};

const analyze: ApiHandler = async (ctx, p) => {
  const evaluation = await ctx.readEvaluation(p);
  const ids = Array.isArray(p.bodyIds) ? (p.bodyIds as string[]) : null;
  for (const id of ids ?? []) findBody(evaluation, id);
  const bodies = (ids ? evaluation.bodies.filter((b) => ids.includes(b.id)) : evaluation.bodies)
    .filter((b) => referenceMeshIdOf(b.id) === null)
    .map(bodyToPrintInput);
  const settings = printSettings(ctx, p.settings);
  let report = ctx.host.printability
    ? await ctx.host.printability.analyze(bodies, settings)
    : analyzePrintability(bodies, settings);
  if (settings.checkClearance && bodies.length >= 2 && ctx.kernel.measureClearance) {
    await ctx.kernelReady();
    const pass = await runClearancePass(ctx.kernel, ctx.activeFeatures(p), bodies, settings);
    report = { ...report, findings: mergeFindings(report.findings, pass.findings) };
  }
  // Agents get every finding; the ones ignored in the app are marked.
  return printReportJson(report, new Set(usePrintStore.getState().ignored));
};

const orientations: ApiHandler = async (ctx, p) => {
  const evaluation = await ctx.readEvaluation(p);
  const candidates = await rankedOrientations(ctx, p, evaluation, ctx.readFeatures(p));
  const limit = typeof p.limit === 'number' ? p.limit : 3;
  return candidates.slice(0, limit).map(candidateJson);
};

const placeOnPlate: ApiHandler = (ctx, p) =>
  ctx.write('print.placeOnPlate', (features, evaluation): WriteOutcome => {
    const [face] = resolveFaceInput(p.face, evaluation, features, 'face', { single: true });
    if (!face) throw new ApiError('invalidParams', 'face: no face given');
    const id = ctx.allocateFeatureId('transform');
    let feature: ReturnType<typeof placeOnPlateFeature>;
    try {
      feature = placeOnPlateFeature(evaluation, features, face.bodyId, face.key, id);
    } catch (error) {
      if (error instanceof PlacementError) {
        throw new ApiError('invalidParams', error.message, {
          hint: 'Use a planar face ("%PLANE" selector, or faces.list with surface "plane").',
        });
      }
      throw error;
    }
    if (typeof p.name === 'string') feature = { ...feature, name: p.name };
    return {
      features: [...features, feature],
      touched: [id],
      selection: [{ kind: 'body', bodyId: face.bodyId }],
      result: { featureId: id, bodyId: face.bodyId, transform: paramsOf(feature) },
    };
  });

const orient: ApiHandler = (ctx, p) =>
  ctx.write('print.orient', async (features, evaluation): Promise<WriteOutcome> => {
    const bodyId = String(p.bodyId);
    const body = findBody(evaluation, bodyId);
    if (referenceMeshIdOf(bodyId) !== null) {
      throw new ApiError('invalidParams', 'Reference meshes cannot be oriented');
    }
    let transform: PlacementTransform;
    let candidate: OrientationCandidate | null = null;
    if (typeof p.rank === 'number') {
      const candidates = await rankedOrientations(ctx, p, evaluation, features);
      candidate = candidates[p.rank - 1] ?? null;
      if (!candidate) {
        throw new ApiError(
          'invalidParams',
          `rank ${p.rank}: there are ${candidates.length} candidates`,
        );
      }
      transform = candidate.transform;
    } else {
      const down = p.down as [number, number, number];
      if (Math.hypot(down[0], down[1], down[2]) < 1e-9) {
        throw new ApiError('invalidParams', 'down: must not be the zero vector');
      }
      transform = placementFor(
        { positions: body.mesh.positions, min: body.min, max: body.max },
        rotationToDown(down),
      );
    }
    const id = ctx.allocateFeatureId('transform');
    const feature = placementFeature(
      bodyId,
      transform,
      id,
      typeof p.name === 'string' ? p.name : orientFeatureName(features),
    );
    return {
      features: [...features, feature],
      touched: [id],
      selection: [{ kind: 'body', bodyId }],
      result: {
        featureId: id,
        bodyId,
        transform: paramsOf(feature),
        ...(candidate ? { candidate: candidateJson(candidate) } : {}),
      },
    };
  });

const HANDLERS: Record<string, ApiHandler> = {
  'print.analyze': analyze,
  'print.orientations': orientations,
  'print.placeOnPlate': placeOnPlate,
  'print.orient': orient,
  'export.meshStats': meshStats,
};

/** The print module's contribution to the contract (same blocks and order as before). */
export const PRINT_API: ApiContribution = {
  defs: [{ order: API_ORDER.defs.printSettings, defs: { PrintSettings: PRINT_SETTINGS_SCHEMA } }],
  methods: [
    {
      order: API_ORDER.methods.print,
      methods: Object.fromEntries(
        Object.entries(PRINT_METHODS).map(([name, spec]) => [
          name,
          { spec, handler: HANDLERS[name]! },
        ]),
      ),
    },
  ],
};
