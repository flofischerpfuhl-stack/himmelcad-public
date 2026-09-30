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
import type { KernelAdapter } from '../foundation/geometry-kernel/adapter.js';
import type { DistanceTarget, EvaluationResult } from '../foundation/geometry-kernel/types.js';
import type { Feature } from '../foundation/document/document.js';
import {
  measure,
  type DistanceResult,
  type MeasureContext,
  type MeasureRef,
  type Measurement,
  type ValueKind,
} from '../model/measure.js';
import {
  bodyMaterials,
  DEFAULT_DENSITY_MATERIAL,
  materialPreset,
} from '../platform/viewport/displayModes.js';
import { findBody } from '../foundation/commands/api/describe.js';
import { ApiError } from '../foundation/commands/api/errors.js';
import { resolveEdgeInput, resolveFaceInput } from '../foundation/commands/api/references.js';

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
    throw new ApiError(
      'featureFailed',
      `Distance query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The panel's measurement of `refs`, with the kernel's exact distance where the pair needs one. */
async function panelMeasurement(env: MeasureEnv, refs: MeasureRef[]): Promise<Measurement> {
  const activeCount = env.features.length;
  let exact: DistanceResult | 'pending' | null = 'pending';
  const ctx: MeasureContext = {
    bodies: env.evaluation.bodies,
    materials: bodyMaterials(env.features, activeCount),
    distance: () => exact,
  };
  let result = measure(refs, ctx);
  if (result?.pending && refs.length === 2) {
    exact = await kernelDistance(env, refs[0]!, refs[1]!);
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
