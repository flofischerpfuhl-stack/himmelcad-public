/**
 * The print module's check kinds (assembler/CHECKS.md): printable without
 * errors, minimum wall thickness, fits the build volume. They run the same
 * analysis as the Printability panel and `print.analyze` — in the app in a
 * printability worker of their own (never cancelling the panel's job),
 * headless in-process — with the check's own parameters, never the user's
 * panel settings, so a check means the same for every user and agent.
 */
import {
  BODIES_PARAM,
  bodiesLabel,
  bodiesOf,
  bodiesParamFromSelection,
  errorOutcome,
  formatCheckValue,
  type CheckEnv,
  type CheckKindDefinition,
  type CheckLocation,
} from '../../foundation/commands/checks.js';
import { schemaObject } from '../../foundation/commands/api/contract.js';
import type { Body } from '../../foundation/geometry-kernel/types.js';
import {
  analyzePrintability,
  bodyToPrintInput,
  checkBuildVolume,
  type PrintReport,
} from './analysis.js';
import type { PrintabilityRunner } from './runner.js';
import { BUILD_VOLUME_PRESETS, DEFAULT_PRINT_SETTINGS, type PrintSettings } from './settings.js';

const MODULE = 'print';

let runner: PrintabilityRunner | null = null;

/** Installs the worker-backed runner of print checks (app). Without it they run in-process. */
export function setCheckPrintRunner(next: PrintabilityRunner): void {
  runner?.dispose();
  runner = next;
}

/** Wall samples per body of a `printable` check (validity and watertightness need none). */
const PRINTABLE_SAMPLE_BUDGET = 200;

async function analyze(
  bodies: readonly Body[],
  settings: PrintSettings,
  env: CheckEnv,
  sampleBudget?: number,
): Promise<PrintReport> {
  const inputs = bodies.map(bodyToPrintInput);
  if (!runner) return analyzePrintability(inputs, settings, sampleBudget ? { sampleBudget } : {});
  const job = runner.analyze(inputs, settings, undefined, sampleBudget);
  // A superseded run stops its worker job between checks of the progress.
  const poll = setInterval(() => {
    if (env.cancelled()) job.cancel();
  }, 50);
  try {
    return await job.promise;
  } finally {
    clearInterval(poll);
  }
}

/** Settings of a check's analysis: the defaults, no printer (fit is its own check). */
function checkSettings(patch: Partial<PrintSettings> = {}): PrintSettings {
  return { ...DEFAULT_PRINT_SETTINGS, buildVolume: 'none', checkClearance: false, ...patch };
}

const bodiesDependsOn = (p: Record<string, unknown>) =>
  Array.isArray(p.bodies) ? (p.bodies as string[]) : null;

export const PRINTABLE_CHECK: CheckKindDefinition = {
  kind: 'printable',
  module: MODULE,
  label: 'Printable',
  summary:
    'The bodies (default: all) print without errors: valid B-rep (BRepCheck) and a watertight, manifold mesh. Overhangs, walls and fit are their own checks.',
  paramsSchema: schemaObject({ bodies: BODIES_PARAM }),
  describe: (p, name) => `${bodiesLabel(p, name)} printable without errors`,
  dependsOn: bodiesDependsOn,
  cost: 'worker',
  fields: [],
  fromSelection: bodiesParamFromSelection,
  evaluate: async (params, env) => {
    const bodies = bodiesOf(params, env.evaluation);
    if (bodies.length === 0) return errorOutcome('There are no bodies.');
    const report = await analyze(bodies, checkSettings(), env, PRINTABLE_SAMPLE_BUDGET);
    const errors = report.findings.filter((f) => f.severity === 'error');
    if (errors.length === 0) {
      return {
        status: 'pass',
        message: `${bodies.length} ${bodies.length === 1 ? 'body' : 'bodies'} without errors`,
      };
    }
    const failing = [...new Set(errors.map((f) => f.bodyId))];
    return {
      status: 'fail',
      value: errors.length,
      unit: '',
      message: `${errors[0]!.bodyName}: ${errors[0]!.message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`,
      locations: failing.map((id) => ({ bodyIds: [id] })),
      details: {
        findings: errors.map((f) => ({ kind: f.kind, bodyId: f.bodyId, message: f.message })),
      },
    };
  },
};

export const WALL_THICKNESS_CHECK: CheckKindDefinition = {
  kind: 'wallThickness',
  module: MODULE,
  label: 'Minimum wall',
  summary:
    'No wall of the bodies (default: all) thinner than `min` mm, as the Printability analysis samples it (rays along the inward normal from ~12 000 points per body; features between samples can be missed).',
  paramsSchema: schemaObject(
    {
      bodies: BODIES_PARAM,
      min: { type: 'number', exclusiveMinimum: 0, description: 'Thinnest allowed wall, mm.' },
    },
    ['min'],
  ),
  describe: (p, name) =>
    `Walls of ${bodiesLabel(p, name)} ≥ ${formatCheckValue(Number(p.min), 'mm')}`,
  dependsOn: bodiesDependsOn,
  cost: 'worker',
  fields: [{ key: 'min', label: 'Min. wall', unit: 'mm', min: 0 }],
  fromSelection: bodiesParamFromSelection,
  evaluate: async (params, env) => {
    const min = Number(params.min);
    const bodies = bodiesOf(params, env.evaluation);
    if (bodies.length === 0) return errorOutcome('There are no bodies.');
    const report = await analyze(bodies, checkSettings({ minWallMm: min }), env);
    let thinnest: number | null = null;
    const locations: CheckLocation[] = [];
    for (const b of report.bodies) {
      const value = b.thinWall.minThicknessMm;
      if (value !== null && (thinnest === null || value < thinnest)) thinnest = value;
      if (b.thinWall.faces.length > 0) {
        locations.push({
          bodyIds: [b.bodyId],
          faces: b.thinWall.faces.map((f) => ({ bodyId: b.bodyId, faceKey: f.faceKey })),
          label: formatCheckValue(b.thinWall.faces[0]!.value, 'mm'),
        });
      }
    }
    const thin = report.bodies.flatMap((b) => b.thinWall.faces.map((f) => f.value));
    const lowest = thin.length > 0 ? Math.min(...thin) : null;
    if (lowest !== null) {
      return {
        status: 'fail',
        value: lowest,
        unit: 'mm',
        expected: { min },
        message: `Walls down to ${formatCheckValue(lowest, 'mm')} — needs ≥ ${formatCheckValue(min, 'mm')}`,
        locations,
      };
    }
    return {
      status: 'pass',
      value: thinnest,
      unit: 'mm',
      expected: { min },
      message:
        thinnest === null
          ? `No wall measured below ${formatCheckValue(min, 'mm')}`
          : `Thinnest sampled wall ${formatCheckValue(thinnest, 'mm')} (≥ ${formatCheckValue(min, 'mm')})`,
    };
  },
};

const PRINTERS = BUILD_VOLUME_PRESETS.map((p) => p.id);

export const BUILD_VOLUME_CHECK: CheckKindDefinition = {
  kind: 'buildVolume',
  module: MODULE,
  label: 'Fits build volume',
  summary:
    'Every body (default: all) fits a printer’s build volume by its bounding box: a `printer` preset or a custom `size` [x, y, z] mm; `allowRotated` also accepts a body that fits turned 90° about Z.',
  paramsSchema: schemaObject({
    bodies: BODIES_PARAM,
    printer: { enum: PRINTERS, description: 'Build-volume preset.' },
    size: {
      type: 'array',
      items: { type: 'number', exclusiveMinimum: 0 },
      minItems: 3,
      maxItems: 3,
      description: 'Custom build volume X, Y, Z, mm.',
    },
    allowRotated: { type: 'boolean', default: false },
  }),
  problem: (p) =>
    (p.printer === undefined) === (p.size === undefined) ? 'give a printer or a size' : null,
  describe: (p, name) => {
    const target = Array.isArray(p.size)
      ? `${(p.size as number[]).join(' × ')} mm`
      : (BUILD_VOLUME_PRESETS.find((x) => x.id === p.printer)?.label ?? String(p.printer));
    return `${bodiesLabel(p, name)} fit${Array.isArray(p.bodies) && p.bodies.length === 1 ? 's' : ''} ${target}`;
  },
  dependsOn: bodiesDependsOn,
  cost: 'instant',
  fields: [],
  fromSelection: (selection) => ({ ...bodiesParamFromSelection(selection), printer: 'bambuX1' }),
  evaluate: (params, env) => {
    const size = Array.isArray(params.size)
      ? (params.size as [number, number, number])
      : [...BUILD_VOLUME_PRESETS.find((x) => x.id === params.printer)!.size];
    const bodies = bodiesOf(params, env.evaluation);
    if (bodies.length === 0) return errorOutcome('There are no bodies.');
    const failing = bodies.filter((b) => {
      const fit = checkBuildVolume(
        [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]],
        size as [number, number, number],
      );
      return !(fit.fits || (params.allowRotated === true && fit.fitsRotated));
    });
    const volume = `${size.join(' × ')} mm`;
    if (failing.length === 0) {
      return { status: 'pass', message: `${bodies.length === 1 ? 'Fits' : 'All fit'} ${volume}` };
    }
    const first = failing[0]!;
    const dims = [0, 1, 2].map((i) => Number((first.max[i]! - first.min[i]!).toFixed(1)));
    return {
      status: 'fail',
      value: failing.length,
      unit: '',
      message: `${env.bodyName(first.id)} (${dims.join(' × ')} mm) does not fit ${volume}${failing.length > 1 ? ` (+${failing.length - 1} more)` : ''}`,
      locations: failing.map((b) => ({ bodyIds: [b.id] })),
    };
  },
};

export const PRINT_CHECK_KINDS: readonly CheckKindDefinition[] = [
  PRINTABLE_CHECK,
  WALL_THICKNESS_CHECK,
  BUILD_VOLUME_CHECK,
];
