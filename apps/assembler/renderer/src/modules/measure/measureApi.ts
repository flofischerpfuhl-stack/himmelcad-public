/**
 * `measure.*` queries: the Measure panel's measurements for agents and
 * Python, computed by the same code (`model/measure.ts`) from the kernel's
 * exact B-rep data (face areas, edge lengths/radii, body volumes) and the
 * kernel's exact minimum distance (`KernelAdapter.measureDistance`,
 * `BRepExtrema_DistShapeShape`) — never from a screen pick. Targets are
 * `{kind: 'body'|'face'|'edge'|'point'}` with the usual `FaceInput` /
 * `EdgeInput` references (keys or selectors). Read-only: nothing here
 * changes the document or the UI (pins are UI view state).
 */
import type { KernelAdapter } from '../../foundation/geometry-kernel/adapter.js';
import type { DistanceTarget, EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import type { Feature } from '../../foundation/document/document.js';
import {
  measure,
  type DistanceResult,
  type MeasureContext,
  type MeasureRef,
  type Measurement,
  type ValueKind,
} from './measure.js';
import {
  bodyMaterials,
  DEFAULT_DENSITY_MATERIAL,
  materialPreset,
} from '../../platform/viewport/displayModes.js';
import { findBody } from '../../foundation/commands/api/describe.js';
import {
  schemaObject,
  schemaRef,
  schemaScope,
  schemaString,
  type MethodSpec,
} from '../../foundation/commands/api/contract.js';
import {
  API_ORDER,
  type ApiContribution,
  type ApiHandler,
} from '../../foundation/commands/api/registry.js';
import type { JsonSchema } from '../../foundation/commands/api/validate.js';
import { ApiError } from '../../foundation/commands/api/errors.js';
import { isKernelTimeout } from '../../foundation/geometry-kernel/timeout.js';
import { resolveEdgeInput, resolveFaceInput } from '../../foundation/commands/api/references.js';
import { referenceMeshIdOf } from '../../foundation/commands/referenceMesh.js';
import { clearanceCandidates } from '../../foundation/geometry-kernel/clearancePairs.js';
import { exactDistance } from './measureStore.js';

type Json = Record<string, unknown>;

export const MEASURE_UNITS: Record<ValueKind, string> = {
  length: 'mm',
  area: 'mm²',
  volume: 'mm³',
  angle: 'deg',
  mass: 'g',
  count: '',
};

export interface MeasureEnv {
  /** The evaluation the references resolve against (committed or staged). */
  evaluation: EvaluationResult;
  /** The features that evaluation came from (active steps only), for kernel queries. */
  features: readonly Feature[];
  kernel: KernelAdapter;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An API measure target → a Measure panel reference. */
export function measureRefOf(input: unknown, env: MeasureEnv, path: string): MeasureRef {
  if (!isRecord(input)) throw new ApiError('invalidParams', `${path}: expected an object`);
  switch (input.kind) {
    case 'body':
      return { kind: 'body', bodyId: findBody(env.evaluation, String(input.bodyId)).id };
    case 'face': {
      const [face] = resolveFaceInput(input.face, env.evaluation, env.features, `${path}.face`, {
        single: true,
      });
      return { kind: 'face', bodyId: face!.bodyId, faceKey: face!.key };
    }
    case 'edge': {
      const edges = resolveEdgeInput(input.edge, env.evaluation, `${path}.edge`);
      if (edges.length !== 1) {
        throw new ApiError(
          'referenceNotFound',
          `${path}.edge: matched ${edges.length} edges, expected one`,
          {
            hint: 'Narrow the selector or pass an explicit {bodyId, key} from edges.list.',
          },
        );
      }
      return { kind: 'edge', bodyId: edges[0]!.bodyId, edgeKey: edges[0]!.key };
    }
    case 'point': {
      const p = input.point;
      if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => Number.isFinite(v))) {
        throw new ApiError('invalidParams', `${path}.point: expected [x, y, z]`);
      }
      return {
        kind: 'point',
        point: [p[0], p[1], p[2]] as [number, number, number],
        label: 'Point',
      };
    }
    default:
      throw new ApiError(
        'invalidParams',
        `${path}.kind: expected "body", "face", "edge" or "point"`,
      );
  }
}

function targetOf(ref: MeasureRef): DistanceTarget | null {
  if (ref.kind === 'mesh') return null;
  if (ref.kind === 'point') return { kind: 'point', point: ref.point };
  return ref;
}

/** Exact minimum distance from the kernel. */
async function kernelDistance(
  env: MeasureEnv,
  a: MeasureRef,
  b: MeasureRef,
): Promise<DistanceResult> {
  const ta = targetOf(a);
  const tb = targetOf(b);
  if (!ta || !tb || !env.kernel.measureDistance) {
    throw new ApiError('internal', 'The CAD kernel cannot measure distances here');
  }
  try {
    const result = await env.kernel.measureDistance([...env.features], ta, tb);
    return { ...result, approx: false };
  } catch (error) {
    // A stopped kernel is not a property of the query (the session reports `kernelTimeout`).
    if (isKernelTimeout(error)) throw error;
    throw new ApiError(
      'featureFailed',
      `Distance query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Two bodies' clearance from the kernel (distance, contact or overlap with its volume). */
async function kernelClearance(
  env: MeasureEnv,
  a: MeasureRef,
  b: MeasureRef,
): Promise<DistanceResult> {
  if (!env.kernel.measureClearance) return kernelDistance(env, a, b);
  try {
    return await exactDistance(env.kernel, env.features, a, b);
  } catch (error) {
    if (isKernelTimeout(error)) throw error;
    throw new ApiError(
      'featureFailed',
      `Clearance query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Kernel time an agent's clearance query may use before the remaining pairs are skipped, ms. */
const API_CLEARANCE_BUDGET_MS = 60_000;

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** `measure.clearance`: exact clearance of body pairs (see the method summary). */
async function clearanceQuery(env: MeasureEnv, p: Json): Promise<Json> {
  const bodies = env.evaluation.bodies.filter((b) => referenceMeshIdOf(b.id) === null);
  let pairs: { a: string; b: string }[];
  if (typeof p.a === 'string' || typeof p.b === 'string') {
    if (typeof p.a !== 'string' || typeof p.b !== 'string') {
      throw new ApiError('invalidParams', 'Give both a and b, or bodies');
    }
    const a = findBody(env.evaluation, p.a).id;
    const b = findBody(env.evaluation, p.b).id;
    if (a === b) throw new ApiError('invalidParams', 'a and b must be different bodies');
    pairs = [{ a, b }];
  } else {
    const ids = Array.isArray(p.bodyIds)
      ? (p.bodyIds as string[]).map((id) => findBody(env.evaluation, id).id)
      : bodies.map((b) => b.id);
    const chosen = ids.map((id) => bodies.find((b) => b.id === id)!).filter(Boolean);
    const below = typeof p.below === 'number' ? p.below : Infinity;
    pairs = clearanceCandidates(chosen, below).map(({ a, b }) => ({ a, b }));
  }
  if (pairs.length > MAX_CLEARANCE_PAIRS) {
    throw new ApiError(
      'invalidParams',
      `${pairs.length} body pairs to measure; at most ${MAX_CLEARANCE_PAIRS} per call`,
      { hint: 'Pass bodyIds, or below (only pairs closer than that, by bounding box).' },
    );
  }
  if (!env.kernel.measureClearance) {
    throw new ApiError('internal', 'The CAD kernel cannot measure clearance here');
  }
  let result;
  try {
    result = await env.kernel.measureClearance([...env.features], {
      pairs,
      overlap: p.overlap !== false,
      budgetMs: typeof p.budgetMs === 'number' ? p.budgetMs : API_CLEARANCE_BUDGET_MS,
    });
  } catch (error) {
    if (isKernelTimeout(error)) throw error;
    throw new ApiError(
      'featureFailed',
      `Clearance query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const below = typeof p.below === 'number' ? p.below : Infinity;
  const name = (id: string) => bodies.find((b) => b.id === id)?.name ?? id;
  return {
    unit: 'mm',
    pairs: result.pairs
      .filter((r) => r.relation !== 'clear' || r.distance < below)
      .map((r) => ({
        a: r.a,
        b: r.b,
        aName: name(r.a),
        bName: name(r.b),
        relation: r.relation,
        distance: round6(r.distance),
        pointA: r.pointA.map(round6),
        pointB: r.pointB.map(round6),
        delta: r.pointB.map((v, i) => round6(Math.abs(v - r.pointA[i]!))),
        overlapVolume: r.overlapVolume === null ? null : round6(r.overlapVolume),
        ...(r.overlapCenter ? { overlapCenter: r.overlapCenter.map(round6) } : {}),
      })),
    checkedPairs: result.pairs.length,
    skipped: result.skipped,
  };
}

/** Upper bound of body pairs one `measure.clearance` call measures. */
const MAX_CLEARANCE_PAIRS = 2000;

/** The panel's measurement of `refs`, with the kernel's exact distance where the pair needs one. */
export async function panelMeasurement(env: MeasureEnv, refs: MeasureRef[]): Promise<Measurement> {
  const activeCount = env.features.length;
  let exact: DistanceResult | 'pending' | null = 'pending';
  const ctx: MeasureContext = {
    bodies: env.evaluation.bodies,
    materials: bodyMaterials(env.features, activeCount),
    distance: () => exact,
  };
  let result = measure(refs, ctx);
  if (result?.pending && refs.length === 2) {
    const [a, b] = refs as [MeasureRef, MeasureRef];
    exact =
      a.kind === 'body' && b.kind === 'body'
        ? await kernelClearance(env, a, b)
        : await kernelDistance(env, a, b);
    result = measure(refs, ctx);
  }
  if (!result) throw new ApiError('invalidParams', 'Nothing to measure');
  return result;
}

function describeMeasurement(m: Measurement): Json {
  return {
    title: m.title,
    subject: m.subject,
    values: m.values.map((v) => ({
      label: v.label,
      kind: v.kind,
      value: v.value,
      unit: MEASURE_UNITS[v.kind],
      ...(v.approx ? { approx: true } : {}),
      ...(v.secondary ? { secondary: true } : {}),
    })),
    ...(m.note ? { note: m.note } : {}),
  };
}

export async function runMeasureQuery(method: string, p: Json, env: MeasureEnv): Promise<Json> {
  switch (method) {
    case 'measure.get': {
      const items = Array.isArray(p.items) ? p.items : [];
      const refs = items.map((item, i) => measureRefOf(item, env, `items[${i}]`));
      return describeMeasurement(await panelMeasurement(env, refs));
    }
    case 'measure.distance': {
      const a = measureRefOf(p.a, env, 'a');
      const b = measureRefOf(p.b, env, 'b');
      const result = await kernelDistance(env, a, b);
      return {
        distance: result.distance,
        pointA: result.pointA,
        pointB: result.pointB,
        // X/Y/Z components of the distance (absolute, world axes), as the panel shows them.
        delta: result.pointB.map((v, i) => Math.abs(v - result.pointA[i]!)),
        unit: 'mm',
        exact: true,
      };
    }
    case 'measure.angle': {
      const a = measureRefOf(p.a, env, 'a');
      const b = measureRefOf(p.b, env, 'b');
      const m = await panelMeasurement(env, [a, b]);
      const angle = m.values.find((v) => v.kind === 'angle' && !v.secondary);
      const parallel = /^Parallel|parallel to face/.test(m.title);
      if (!angle && !parallel) {
        throw new ApiError(
          'invalidParams',
          'An angle needs two planar faces, two straight edges, or a straight edge and a planar face',
        );
      }
      const distance = m.values.find((v) => v.kind === 'length' && !v.secondary);
      return {
        angle: angle ? angle.value : 0,
        unit: 'deg',
        parallel,
        ...(parallel && distance ? { distance: distance.value } : {}),
      };
    }
    case 'measure.area': {
      const faces = Array.isArray(p.faces) ? p.faces : [];
      const list = faces.flatMap((input, i) =>
        resolveFaceInput(input, env.evaluation, env.features, `faces[${i}]`, { single: false }),
      );
      const seen = new Set<string>();
      const rows = list
        .filter((f) => !seen.has(`${f.bodyId} ${f.key}`) && seen.add(`${f.bodyId} ${f.key}`))
        .map((f) => {
          const face = findBody(env.evaluation, f.bodyId).faces.find((x) => x.key === f.key)!;
          return { bodyId: f.bodyId, key: f.key, surface: face.surface, area: face.area };
        });
      return { area: rows.reduce((sum, r) => sum + r.area, 0), unit: 'mm²', faces: rows };
    }
    case 'measure.clearance':
      return clearanceQuery(env, p);
    case 'measure.volume': {
      const ids = Array.isArray(p.bodyIds)
        ? p.bodyIds.map((id) => findBody(env.evaluation, String(id)).id)
        : env.evaluation.bodies.map((b) => b.id);
      const materials = bodyMaterials(env.features, env.features.length);
      const rows = ids.map((id) => {
        const body = findBody(env.evaluation, id);
        const material = materials.get(id) ?? DEFAULT_DENSITY_MATERIAL;
        const density = materialPreset(material).density;
        return {
          bodyId: id,
          name: body.name,
          volume: body.volume,
          surfaceArea: body.faces.reduce((sum, f) => sum + f.area, 0),
          material,
          densityGPerCm3: density,
          mass: (body.volume / 1000) * density,
          bbox: { min: body.min, max: body.max },
        };
      });
      return {
        volume: rows.reduce((sum, r) => sum + r.volume, 0),
        mass: rows.reduce((sum, r) => sum + r.mass, 0),
        units: { volume: 'mm³', mass: 'g', surfaceArea: 'mm²' },
        bodies: rows,
      };
    }
    default:
      throw new ApiError('methodNotFound', `Unknown method "${method}"`);
  }
}

/** Runs a `measure.*` query on the session's view of the document (committed or staged). */
const measureQuery: ApiHandler = async (ctx, p, method) =>
  runMeasureQuery(method, p, {
    evaluation: await ctx.readEvaluation(p),
    features: ctx.activeFeatures(p),
    kernel: ctx.kernel,
  });

const MEASURE_DEFS: Record<string, JsonSchema> = {
  MeasureTarget: {
    description:
      'What to measure: a body, a face or edge (key or selector matching exactly one), or a world point [x, y, z] (mm).',
    oneOf: [
      schemaObject({ kind: { const: 'body' }, bodyId: schemaString }, ['kind', 'bodyId']),
      schemaObject({ kind: { const: 'face' }, face: schemaRef('FaceInput') }, ['kind', 'face']),
      schemaObject({ kind: { const: 'edge' }, edge: schemaRef('EdgeInput') }, ['kind', 'edge']),
      schemaObject({ kind: { const: 'point' }, point: schemaRef('Vec3') }, ['kind', 'point']),
    ],
  },
};

const MEASURE_METHODS: Record<string, MethodSpec> = {
  'measure.get': {
    kind: 'query',
    capability: 'document.read',
    summary:
      "The Measure panel's measurement of 1..n items (one body: size/volume/mass/area; one edge: length or radius/diameter; one face: area (+ cylinder diameter); two items: exact minimum distance from the kernel, parallel distance or angle, each distance with its ΔX/ΔY/ΔZ components; several bodies: combined box/volume/mass; several edges/faces/bodies: total length/area/volume/mass). Values carry `unit` (mm, mm², mm³, deg, g); `approx` marks mesh estimates.",
    params: schemaObject(
      {
        items: { type: 'array', items: schemaRef('MeasureTarget'), minItems: 1, maxItems: 16 },
        scope: schemaScope,
      },
      ['items'],
    ),
    result: '{title, subject, values: [{label, kind, value, unit, approx?, secondary?}], note?}',
  },
  'measure.distance': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Exact minimum distance between two bodies/faces/edges/points (kernel BRepExtrema_DistShapeShape), the closest points and the X/Y/Z components of the distance (`delta`, absolute).',
    params: schemaObject(
      { a: schemaRef('MeasureTarget'), b: schemaRef('MeasureTarget'), scope: schemaScope },
      ['a', 'b'],
    ),
    result: '{distance, pointA, pointB, delta: [dx, dy, dz], unit: "mm", exact: true}',
  },
  'measure.angle': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Angle between two planar faces, two straight edges, or a straight edge and a planar face (deg). Parallel items give angle 0, `parallel: true` and their `distance`.',
    params: schemaObject(
      { a: schemaRef('MeasureTarget'), b: schemaRef('MeasureTarget'), scope: schemaScope },
      ['a', 'b'],
    ),
    result: '{angle, unit: "deg", parallel, distance?}',
  },
  'measure.area': {
    kind: 'query',
    capability: 'document.read',
    summary: 'Exact B-rep area of faces (selectors may match several; each face counted once).',
    params: schemaObject(
      {
        faces: { type: 'array', items: schemaRef('FaceInput'), minItems: 1 },
        scope: schemaScope,
      },
      ['faces'],
    ),
    result: '{area, unit: "mm²", faces: [{bodyId, key, surface, area}]}',
  },
  'measure.clearance': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Clearance between bodies (print-in-place, lid/enclosure fit): exact minimum distance (kernel BRepExtrema), closest points, and whether they are `clear`, in `contact` or `overlap` with the shared volume (BRepAlgoAPI_Common) and its centre. One pair (`a`, `b`), every pair of `bodyIds`, or every pair of bodies; `below` keeps only pairs closer than that (bounding boxes farther apart are not measured). Pairs left when `budgetMs` of kernel time is used up come back in `skipped`.',
    params: schemaObject({
      a: schemaString,
      b: schemaString,
      bodyIds: { type: 'array', items: schemaString, minItems: 2 },
      below: { type: 'number', minimum: 0, description: 'Only pairs closer than this, mm.' },
      overlap: {
        type: 'boolean',
        default: true,
        description:
          'Compute overlap volumes of touching pairs (false: faster, contact/overlap only from the distance).',
      },
      budgetMs: { type: 'integer', minimum: 1, default: 60000 },
      scope: schemaScope,
    }),
    result:
      '{unit: "mm", pairs: [{a, b, aName, bName, relation: "clear"|"contact"|"overlap", distance, pointA, pointB, delta, overlapVolume, overlapCenter?}], checkedPairs, skipped: [{a, b}]}',
  },
  'measure.volume': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Exact B-rep volume, surface area, bounding box and mass (density of the body material set with its appearance, PLA otherwise; solid) of the given bodies (default: all).',
    params: schemaObject({ bodyIds: { type: 'array', items: schemaString }, scope: schemaScope }),
    result:
      '{volume, mass, units, bodies: [{bodyId, name, volume, surfaceArea, material, densityGPerCm3, mass, bbox}]}',
  },
};

/**
 * The measure module's agent-API contribution: the `measure.*` queries
 * (block `API_ORDER.methods.measure`, between the parameter methods and the
 * core feature commands, the published order) and their `MeasureTarget`
 * definition (between `EdgeInput` and the sketch definitions).
 */
export const MEASURE_API: ApiContribution = {
  methods: [
    {
      order: API_ORDER.methods.measure,
      methods: Object.fromEntries(
        Object.entries(MEASURE_METHODS).map(([name, spec]) => [
          name,
          { spec, handler: measureQuery },
        ]),
      ),
    },
  ],
  defs: [{ order: API_ORDER.defs.measure, defs: MEASURE_DEFS }],
};
