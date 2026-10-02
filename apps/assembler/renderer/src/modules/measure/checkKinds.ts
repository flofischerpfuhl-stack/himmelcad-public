/**
 * The measure module's check kinds (assembler/CHECKS.md): distance, angle,
 * length (an item's size), clearance between bodies, volume and mass. They
 * measure exactly like the Measure panel and `measure.*` (same code, the
 * kernel's exact distances), so a check, the panel and an agent agree.
 */
import {
  BODIES_PARAM,
  bodiesLabel,
  bodiesOf,
  bodiesParamFromSelection,
  errorOutcome,
  formatCheckValue,
  formatRange,
  rangeOf,
  rangeOutcome,
  rangeProblem,
  rangeProperties,
  selectedBodyIds,
  type CheckEnv,
  type CheckKindDefinition,
  type CheckLocation,
  type CheckOutcome,
} from '../../foundation/commands/checks.js';
import { schemaObject, schemaRef, schemaString } from '../../foundation/commands/api/contract.js';
import type { SelectionItem } from '../../foundation/commands/store.js';
import { clearanceCandidates, midpoint } from '../../foundation/geometry-kernel/clearancePairs.js';
import type { EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import {
  bodyMaterials,
  DEFAULT_DENSITY_MATERIAL,
  materialPreset,
} from '../../platform/viewport/displayModes.js';
import type { MeasureRef, Measurement } from './measure.js';
import { measureRefOf, panelMeasurement, type MeasureEnv } from './measureApi.js';

type Json = Record<string, unknown>;

const MODULE = 'measure';

function measureEnv(env: CheckEnv): MeasureEnv | null {
  if (!env.kernel) return null;
  return { evaluation: env.evaluation, features: env.features, kernel: env.kernel };
}

/** The body a stored measure target refers to (`MeasureTarget`), if any. */
function targetBody(target: unknown): string | null {
  if (typeof target !== 'object' || target === null) return null;
  const t = target as Json;
  if (t.kind === 'body') return typeof t.bodyId === 'string' ? t.bodyId : null;
  const ref = (t.kind === 'face' ? t.face : t.kind === 'edge' ? t.edge : null) as Json | null;
  return ref && typeof ref.bodyId === 'string' ? ref.bodyId : null;
}

function targetLabel(target: unknown, bodyName: (id: string) => string): string {
  const t = (target ?? {}) as Json;
  const body = targetBody(target);
  const name = body ? bodyName(body) : '';
  if (t.kind === 'body') return name;
  if (t.kind === 'face') return `${name} face`;
  if (t.kind === 'edge') return `${name} edge`;
  if (t.kind === 'point' && Array.isArray(t.point)) {
    return `(${(t.point as number[]).map((v) => Number(v.toFixed(2))).join(', ')})`;
  }
  return '?';
}

/** A measure target (agent-API form) of a selection item, or `null`. */
export function targetOfSelection(item: SelectionItem): Json | null {
  if (item.kind === 'body') return { kind: 'body', bodyId: item.bodyId };
  if (item.kind === 'face')
    return { kind: 'face', face: { bodyId: item.bodyId, key: item.faceKey } };
  if (item.kind === 'edge')
    return { kind: 'edge', edge: { bodyId: item.bodyId, key: item.edgeKey } };
  return null;
}

/** A measure target (agent-API form) of a Measure panel reference, or `null` (reference meshes). */
export function targetOfRef(ref: MeasureRef): Json | null {
  switch (ref.kind) {
    case 'body':
      return { kind: 'body', bodyId: ref.bodyId };
    case 'face':
      return { kind: 'face', face: { bodyId: ref.bodyId, key: ref.faceKey } };
    case 'edge':
      return { kind: 'edge', edge: { bodyId: ref.bodyId, key: ref.edgeKey } };
    case 'point':
      return { kind: 'point', point: [...ref.point] };
    case 'mesh':
      return null;
  }
}

/** Where a measured item is: its body, face or edge. */
function locationOfRef(ref: MeasureRef): CheckLocation | null {
  if (ref.kind === 'body') return { bodyIds: [ref.bodyId] };
  if (ref.kind === 'face') {
    return { bodyIds: [ref.bodyId], faces: [{ bodyId: ref.bodyId, faceKey: ref.faceKey }] };
  }
  if (ref.kind === 'edge') {
    return { bodyIds: [ref.bodyId], edges: [{ bodyId: ref.bodyId, edgeKey: ref.edgeKey }] };
  }
  if (ref.kind === 'point') return { bodyIds: [], point: ref.point };
  return null;
}

function locationsOf(refs: readonly MeasureRef[], m: Measurement): CheckLocation[] {
  const out = refs.map(locationOfRef).filter((l): l is CheckLocation => l !== null);
  const segment = m.graphics.find((g) => g.kind === 'segment');
  if (segment?.kind === 'segment' && out.length > 0) {
    out[0] = { ...out[0]!, segment: [segment.a, segment.b] };
  }
  return out;
}

const pairDependsOn = (params: Json) =>
  [targetBody(params.a), targetBody(params.b)].filter((id): id is string => id !== null);

async function measurePair(
  params: Json,
  env: CheckEnv,
): Promise<{ refs: MeasureRef[]; m: Measurement } | CheckOutcome> {
  const menv = measureEnv(env);
  if (!menv) return errorOutcome('Needs the CAD kernel.');
  const refs = [measureRefOf(params.a, menv, 'a'), measureRefOf(params.b, menv, 'b')];
  return { refs, m: await panelMeasurement(menv, refs) };
}

const TARGET = schemaRef('MeasureTarget');

function twoTargets(selection: readonly SelectionItem[]): Json | string {
  const targets = selection.map(targetOfSelection).filter((t): t is Json => t !== null);
  if (targets.length !== 2) return 'Select two items (bodies, faces or edges).';
  return { a: targets[0], b: targets[1] };
}

export const DISTANCE_CHECK: CheckKindDefinition = {
  kind: 'distance',
  module: MODULE,
  label: 'Distance',
  summary:
    'Distance between two items within a range (mm): the exact minimum distance, or the distance of parallel faces/edges, as Measure shows it.',
  paramsSchema: schemaObject({ a: TARGET, b: TARGET, ...rangeProperties('mm') }, ['a', 'b']),
  problem: rangeProblem,
  describe: (p, name) =>
    `Distance ${targetLabel(p.a, name)} → ${targetLabel(p.b, name)} ${formatRange(rangeOf(p), 'mm')}`,
  dependsOn: pairDependsOn,
  cost: 'kernel',
  fields: [
    { key: 'min', label: 'Min', unit: 'mm', optional: true },
    { key: 'max', label: 'Max', unit: 'mm', optional: true },
  ],
  fromSelection: twoTargets,
  evaluate: async (params, env) => {
    const pair = await measurePair(params, env);
    if ('status' in pair) return pair;
    const value = pair.m.values.find((v) => v.kind === 'length' && !v.secondary);
    if (!value) return errorOutcome(pair.m.note ?? 'Nothing to measure between these.');
    return rangeOutcome(value.value, rangeOf(params), 'mm', locationsOf(pair.refs, pair.m), {
      measured: value.label,
    });
  },
};

export const ANGLE_CHECK: CheckKindDefinition = {
  kind: 'angle',
  module: MODULE,
  label: 'Angle',
  summary:
    'Angle between two planar faces, two straight edges, or an edge and a face within a range (degrees; parallel items are 0°).',
  paramsSchema: schemaObject({ a: TARGET, b: TARGET, ...rangeProperties('deg') }, ['a', 'b']),
  problem: rangeProblem,
  describe: (p, name) =>
    `Angle ${targetLabel(p.a, name)} → ${targetLabel(p.b, name)} ${formatRange(rangeOf(p), 'deg')}`,
  dependsOn: pairDependsOn,
  cost: 'kernel',
  fields: [
    { key: 'min', label: 'Min', unit: 'deg', optional: true },
    { key: 'max', label: 'Max', unit: 'deg', optional: true },
  ],
  fromSelection: twoTargets,
  evaluate: async (params, env) => {
    const pair = await measurePair(params, env);
    if ('status' in pair) return pair;
    const angle = pair.m.values.find((v) => v.kind === 'angle' && !v.secondary);
    const parallel = /^Parallel|parallel to face/.test(pair.m.title);
    if (!angle && !parallel) {
      return errorOutcome('An angle needs planar faces or straight edges.');
    }
    return rangeOutcome(
      angle ? angle.value : 0,
      rangeOf(params),
      'deg',
      locationsOf(pair.refs, pair.m),
    );
  },
};

/** Measure panel labels of each `length` quantity (first match wins). */
const QUANTITY_LABELS: Record<string, { labels: string[]; kind: 'length' | 'area'; text: string }> =
  {
    length: { labels: ['Length', 'Arc length', 'Circumference'], kind: 'length', text: 'Length' },
    diameter: { labels: ['Diameter'], kind: 'length', text: 'Diameter' },
    radius: { labels: ['Radius'], kind: 'length', text: 'Radius' },
    width: { labels: ['Width (X)'], kind: 'length', text: 'Width (X)' },
    depth: { labels: ['Depth (Y)'], kind: 'length', text: 'Depth (Y)' },
    height: { labels: ['Height (Z)'], kind: 'length', text: 'Height (Z)' },
    area: { labels: ['Area', 'Surface area'], kind: 'area', text: 'Area' },
  };

export const LENGTH_CHECK: CheckKindDefinition = {
  kind: 'length',
  module: MODULE,
  label: 'Length',
  summary:
    'A size of one item within a range: edge length, circle/cylinder diameter or radius, body width/depth/height (box), or face/body area (`quantity`; mm or mm²).',
  paramsSchema: schemaObject(
    {
      target: TARGET,
      quantity: {
        enum: Object.keys(QUANTITY_LABELS),
        default: 'length',
        description: 'Which size of the target.',
      },
      ...rangeProperties('mm (mm² for area)'),
    },
    ['target'],
  ),
  problem: rangeProblem,
  describe: (p, name) => {
    const q = QUANTITY_LABELS[String(p.quantity ?? 'length')] ?? QUANTITY_LABELS.length!;
    return `${q.text} of ${targetLabel(p.target, name)} ${formatRange(rangeOf(p), q.kind === 'area' ? 'mm²' : 'mm')}`;
  },
  dependsOn: (p) => [targetBody(p.target)].filter((id): id is string => id !== null),
  cost: 'instant',
  fields: [
    { key: 'min', label: 'Min', unit: 'mm', optional: true },
    { key: 'max', label: 'Max', unit: 'mm', optional: true },
  ],
  fromSelection: (selection) => {
    if (selection.length !== 1) return 'Select one edge, face or body.';
    const item = selection[0]!;
    const target = targetOfSelection(item);
    if (!target) return 'Select one edge, face or body.';
    const quantity = item.kind === 'edge' ? 'length' : item.kind === 'face' ? 'area' : 'height';
    return { target, quantity };
  },
  evaluate: async (params, env) => {
    const quantity = QUANTITY_LABELS[String(params.quantity ?? 'length')]!;
    // A single item never needs the kernel: Measure reads it from the evaluated B-rep data.
    const menv: MeasureEnv = {
      evaluation: env.evaluation,
      features: env.features,
      kernel: env.kernel as MeasureEnv['kernel'],
    };
    const ref = measureRefOf(params.target, menv, 'target');
    const m = await panelMeasurement(menv, [ref]);
    const value = quantity.labels
      .map((label) => m.values.find((v) => v.label === label))
      .find((v) => v !== undefined);
    if (!value) {
      return errorOutcome(`${m.title} has no ${quantity.text.toLowerCase()}.`);
    }
    const unit = quantity.kind === 'area' ? 'mm²' : 'mm';
    return rangeOutcome(value.value, rangeOf(params), unit, locationsOf([ref], m));
  },
};

/** Default kernel time of a clearance check when the run gives none, ms. */
const CLEARANCE_BUDGET_MS = 5000;

export const CLEARANCE_CHECK: CheckKindDefinition = {
  kind: 'clearance',
  module: MODULE,
  label: 'Clearance',
  summary:
    'Minimum clearance between bodies (print-in-place, lid/enclosure fit): fails when two bodies overlap or come closer than `min` mm (`min` 0: only overlaps fail, touching passes). One pair (`a`, `b`), the pairs of `bodies`, or every pair of bodies; pairs whose bounding boxes are farther apart than `min` cannot fail and are not measured.',
  paramsSchema: schemaObject(
    {
      a: schemaString,
      b: schemaString,
      bodies: BODIES_PARAM,
      min: { type: 'number', minimum: 0, description: 'Smallest allowed gap, mm.' },
    },
    ['min'],
  ),
  problem: (p) => {
    if ((p.a === undefined) !== (p.b === undefined)) return 'give both a and b, or neither';
    if (p.a !== undefined && p.a === p.b) return 'a and b must be different bodies';
    if (p.a !== undefined && p.bodies !== undefined) return 'give a and b, or bodies, not both';
    return null;
  },
  describe: (p, name) => {
    const who =
      typeof p.a === 'string' && typeof p.b === 'string'
        ? `${name(p.a)} ↔ ${name(p.b)}`
        : bodiesLabel(p, name);
    return `Clearance ${who} ≥ ${formatCheckValue(Number(p.min), 'mm')}`;
  },
  dependsOn: (p) =>
    typeof p.a === 'string' && typeof p.b === 'string'
      ? [p.a, p.b]
      : Array.isArray(p.bodies)
        ? (p.bodies as string[])
        : null,
  cost: 'kernel',
  fields: [{ key: 'min', label: 'Min. gap', unit: 'mm', min: 0 }],
  fromSelection: (selection) => {
    const ids = selectedBodyIds(selection);
    if (ids.length === 2) return { a: ids[0], b: ids[1] };
    if (ids.length > 2) return { bodies: ids };
    if (ids.length === 0) return {};
    return 'Select two bodies (or several, or none for every pair).';
  },
  evaluate: (params, env) => evaluateClearance(params, env),
};

async function evaluateClearance(params: Json, env: CheckEnv): Promise<CheckOutcome> {
  const min = Number(params.min);
  const kernel = env.kernel;
  if (!kernel?.measureClearance) return errorOutcome('Needs the CAD kernel.');
  let pairs: { a: string; b: string }[];
  if (typeof params.a === 'string' && typeof params.b === 'string') {
    pairs = [{ a: params.a, b: params.b }];
  } else {
    // Bounding boxes farther apart than `min` cannot hold a failing pair.
    pairs = clearanceCandidates(bodiesOf(params, env.evaluation), min + 1e-6).map(({ a, b }) => ({
      a,
      b,
    }));
  }
  if (pairs.length === 0) {
    return {
      status: 'pass',
      value: null,
      unit: 'mm',
      expected: { min },
      message: `No bodies closer than ${formatCheckValue(min, 'mm')}`,
    };
  }
  const result = await kernel.measureClearance(env.features, {
    pairs,
    budgetMs: env.budgetMs > 0 ? env.budgetMs : CLEARANCE_BUDGET_MS,
  });
  const failing = result.pairs.filter(
    (p) => p.relation === 'overlap' || (min > 0 && p.distance < min - 1e-9),
  );
  const closest = result.pairs.reduce<(typeof result.pairs)[number] | null>(
    (best, p) => (best === null || p.distance < best.distance ? p : best),
    null,
  );
  const locations: CheckLocation[] = failing.map((p) =>
    p.relation === 'overlap'
      ? {
          bodyIds: [p.a, p.b],
          point: p.overlapCenter ?? midpoint(p.pointA, p.pointB),
          label:
            p.overlapVolume !== null
              ? `overlap ${formatCheckValue(p.overlapVolume, 'mm³')}`
              : 'overlap',
        }
      : {
          bodyIds: [p.a, p.b],
          segment: [p.pointA, p.pointB],
          label: formatCheckValue(p.distance, 'mm'),
        },
  );
  const details = {
    pairs: result.pairs.map((p) => ({
      a: p.a,
      b: p.b,
      relation: p.relation,
      distance: p.distance,
      overlapVolume: p.overlapVolume,
    })),
    skipped: result.skipped,
  };
  const overlaps = failing.filter((p) => p.relation === 'overlap');
  if (failing.length > 0) {
    const first = failing[0]!;
    const who = `${env.bodyName(first.a)} ↔ ${env.bodyName(first.b)}`;
    const more = failing.length > 1 ? ` (+${failing.length - 1} more)` : '';
    return {
      status: 'fail',
      value: overlaps.length > 0 ? 0 : (closest?.distance ?? null),
      unit: 'mm',
      expected: { min },
      message:
        first.relation === 'overlap'
          ? `${who} overlap${first.overlapVolume ? ` (${formatCheckValue(first.overlapVolume, 'mm³')})` : ''}${more}`
          : `${who}: ${formatCheckValue(first.distance, 'mm')} — needs ≥ ${formatCheckValue(min, 'mm')}${more}`,
      locations,
      details,
    };
  }
  if (result.skipped.length > 0) {
    return errorOutcome(
      `Not finished within the time budget (${result.pairs.length} of ${pairs.length} pairs).`,
    );
  }
  return {
    status: 'pass',
    value: closest?.distance ?? null,
    unit: 'mm',
    expected: { min },
    message: closest
      ? `${formatCheckValue(closest.distance, 'mm')} (≥ ${formatCheckValue(min, 'mm')})`
      : 'No bodies to compare',
    ...(closest
      ? {
          locations: [
            {
              bodyIds: [closest.a, closest.b],
              segment: [closest.pointA, closest.pointB] as [
                typeof closest.pointA,
                typeof closest.pointB,
              ],
              label: formatCheckValue(closest.distance, 'mm'),
            },
          ],
        }
      : {}),
    details,
  };
}

function totals(params: Json, evaluation: EvaluationResult, env: CheckEnv) {
  const bodies = bodiesOf(params, evaluation);
  const materials = bodyMaterials(env.features, env.features.length);
  let volume = 0;
  let mass = 0;
  for (const body of bodies) {
    volume += body.volume;
    const density = materialPreset(materials.get(body.id) ?? DEFAULT_DENSITY_MATERIAL).density;
    mass += (body.volume * density) / 1000;
  }
  return { bodies, volume, mass, materials };
}

const bodiesDependsOn = (p: Json) => (Array.isArray(p.bodies) ? (p.bodies as string[]) : null);

export const VOLUME_CHECK: CheckKindDefinition = {
  kind: 'volume',
  module: MODULE,
  label: 'Volume',
  summary: 'Exact B-rep volume of the bodies (default: all) within a range, mm³.',
  paramsSchema: schemaObject({ bodies: BODIES_PARAM, ...rangeProperties('mm³') }),
  problem: rangeProblem,
  describe: (p, name) => `Volume of ${bodiesLabel(p, name)} ${formatRange(rangeOf(p), 'mm³')}`,
  dependsOn: bodiesDependsOn,
  cost: 'instant',
  fields: [
    { key: 'min', label: 'Min', unit: 'mm³', optional: true },
    { key: 'max', label: 'Max', unit: 'mm³', optional: true },
  ],
  fromSelection: bodiesParamFromSelection,
  evaluate: (params, env) => {
    const { bodies, volume } = totals(params, env.evaluation, env);
    return rangeOutcome(volume, rangeOf(params), 'mm³', [{ bodyIds: bodies.map((b) => b.id) }]);
  },
};

export const MASS_CHECK: CheckKindDefinition = {
  kind: 'mass',
  module: MODULE,
  label: 'Mass',
  summary:
    'Mass of the bodies (default: all) within a range, g: exact volume × the density of the material set with each body’s appearance (PLA otherwise), solid.',
  paramsSchema: schemaObject({ bodies: BODIES_PARAM, ...rangeProperties('g') }),
  problem: rangeProblem,
  describe: (p, name) => `Mass of ${bodiesLabel(p, name)} ${formatRange(rangeOf(p), 'g')}`,
  dependsOn: bodiesDependsOn,
  fingerprint: (_p, env) =>
    JSON.stringify([...bodyMaterials(env.features, env.features.length).entries()]),
  cost: 'instant',
  fields: [
    { key: 'min', label: 'Min', unit: 'g', optional: true },
    { key: 'max', label: 'Max', unit: 'g', optional: true },
  ],
  fromSelection: bodiesParamFromSelection,
  evaluate: (params, env) => {
    const { bodies, mass } = totals(params, env.evaluation, env);
    return rangeOutcome(mass, rangeOf(params), 'g', [{ bodyIds: bodies.map((b) => b.id) }]);
  },
};

export const MEASURE_CHECK_KINDS: readonly CheckKindDefinition[] = [
  DISTANCE_CHECK,
  ANGLE_CHECK,
  LENGTH_CHECK,
  CLEARANCE_CHECK,
  VOLUME_CHECK,
  MASS_CHECK,
];
