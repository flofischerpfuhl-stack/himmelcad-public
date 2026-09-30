/**
 * Model-based fuzzer harness (`assembler/ROBUSTNESS.md`): runs op sequences
 * (`ops.ts`) against the real in-process stack — the app store, the
 * canonical agent session (`hcasm.agent-api@1`, headless capabilities), the
 * OCCT kernel adapter (with a real reload per restart and a low recycle
 * threshold so the restart policy is exercised) and the planeGCS solver —
 * and checks the invariants after every step.
 *
 * Invariants (ids used in reproducers):
 *
 * - `exception`         no uncaught exception, no unhandled rejection, no
 *                       `internal`/`busy` API error, no non-ApiError throw.
 * - `refusalTrace`      a refused write leaves the document untouched.
 * - `uniqueIds`         feature ids are unique.
 * - `silentInvalid`     every body is valid B-rep, or some feature reports an
 *                       error/warning (never an invalid body silently).
 * - `namedErrors`       every feature error is a readable message on an
 *                       existing feature; a feature whose sketch reference is
 *                       gone reports an error.
 * - `undoRedo`          undo then redo returns the identical document and the
 *                       identical evaluation (volumes, face/edge keys).
 * - `saveReopen`        save → load gives the identical document; save →
 *                       reopen gives the identical evaluation.
 * - `cancelTrace`       a cancelled transaction leaves no trace.
 * - `determinism`       the committed (incremental) evaluation equals a cold
 *                       evaluation on a separate, fresh kernel instance.
 * - `heap`              the wasm heap stays below {@link HEAP_LIMIT_BYTES}
 *                       under the restart policy.
 */
import { createRequire } from 'node:module';

import * as R from 'replicad';
import init from 'replicad-opencascadejs';

import { ApiError } from '../../renderer/src/api/errors.js';
import { AgentSession, HEADLESS_CAPABILITIES } from '../../renderer/src/api/session.js';
import { InProcessKernelAdapter } from '../../renderer/src/kernel/adapter.js';
import { createEvaluator, type KernelEvaluator } from '../../renderer/src/kernel/evaluator.js';
import type { EvaluationResult } from '../../renderer/src/kernel/types.js';
import type { Feature } from '../../renderer/src/model/document.js';
import { checkMove, moveFeature } from '../../renderer/src/model/historyTools.js';
import { loadProjectFile } from '../../renderer/src/model/project/format.js';
import { useAssemblerStore } from '../../renderer/src/model/store.js';
import { setSketchSolverFactory } from '../../renderer/src/sketch/solverProvider.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';
import { between, pick, type Op } from './ops.js';

type Json = Record<string, unknown>;
type OpenCascade = Awaited<ReturnType<typeof init>>;

/** Hard bound for the kernel's wasm heap (the recycle threshold below keeps it far lower). */
export const HEAP_LIMIT_BYTES = 1536 * 1024 * 1024;
/** Recycle threshold of the fuzzed kernel: low, so long runs go through kernel restarts. */
export const FUZZ_RECYCLE_BYTES = 384 * 1024 * 1024;

/** Codes that are legitimate refusals of a random command. */
const REFUSALS = new Set<ApiError['code']>([
  'invalidParams',
  'notFound',
  'referenceNotFound',
  'featureFailed',
  'sketchConflict',
  'transactionState',
  'conflict',
  'unsupported',
]);

export interface Failure {
  step: number;
  op: Op;
  invariant: string;
  message: string;
}

export interface StepLog {
  step: number;
  op: string;
  call: string;
  outcome: 'ok' | 'refused' | 'skipped' | 'failed';
  detail?: string;
}

export interface RunResult {
  failure: Failure | null;
  log: StepLog[];
  steps: number;
  committed: number;
  refused: number;
  maxHeapBytes: number;
  /** Incremental/cold differences explained by OCCT's heap-layout dependence (F3). */
  marginal: string[];
  kernelLoads: number;
}

class InvariantError extends Error {
  constructor(
    readonly invariant: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(invariant: string, message: string): never {
  throw new InvariantError(invariant, message);
}

async function loadOcct(): Promise<OpenCascade> {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('replicad-opencascadejs/wasm');
  const quiet = () => undefined;
  return init({ locateFile: () => wasmPath, print: quiet, printErr: quiet } as Parameters<
    typeof init
  >[0]);
}

function round(v: number, digits: number): number {
  return Number.isFinite(v) ? Number(v.toPrecision(digits)) : v;
}

/** What must be identical between two evaluations of the same document. */
export function evaluationSignature(e: EvaluationResult): Json {
  const sorted = (r: Record<string, string>) =>
    Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)));
  return {
    errors: sorted(e.errors),
    warnings: sorted(e.warnings),
    bodies: e.bodies.map((b) => ({
      id: b.id,
      name: b.name,
      valid: b.valid,
      volume: round(b.volume, 9),
      min: b.min.map((v) => round(v, 6)),
      max: b.max.map((v) => round(v, 6)),
      faces: b.faces.map((f) => f.key).sort(),
      edges: b.edges.map((x) => x.key).sort(),
    })),
  };
}

function firstDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const d = firstDifference(
        (a as Json)[key],
        (b as Json)[key],
        Array.isArray(a) ? `${path}[${key}]` : `${path}.${key}`,
      );
      if (d) return d;
    }
  }
  const show = (v: unknown) => {
    const text = JSON.stringify(v) ?? String(v);
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  };
  return `${path}: ${show(a)} ≠ ${show(b)}`;
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null)) as unknown;
}

interface Resolved {
  label: string;
  run: () => Promise<unknown>;
  /** `true` when a success commits one undo step (outside a transaction). */
  undoable: boolean;
}

interface FeatureSummary {
  id: string;
  name: string;
  kind: string;
  suppressed: boolean;
  params: Json;
}
interface BodySummary {
  id: string;
  valid: boolean;
}
interface FaceSummary {
  key: string;
  surface: string;
  normal?: number[] | null;
}

export class FuzzHarness {
  readonly store = useAssemblerStore;
  readonly kernel: InProcessKernelAdapter;
  readonly session: AgentSession;
  private reference: { oc: OpenCascade; checks: number; ballast: unknown[] } | null = null;
  /** Determinism differences explained by OCCT's heap-layout dependence (finding F3), this run. */
  private marginal: string[] = [];
  /** The fuzzed kernel's OCCT instance (replicad keeps one global instance; see coldEvaluate). */
  private mainOc: OpenCascade | null = null;
  private asyncErrors: unknown[] = [];
  private paramCounter = 0;
  kernelLoads = 0;

  private constructor() {
    this.kernel = new InProcessKernelAdapter(
      async () => {
        this.kernelLoads += 1;
        const oc = await loadOcct();
        this.mainOc = oc;
        return createEvaluator(oc);
      },
      { recycleHeapBytes: FUZZ_RECYCLE_BYTES },
    );
    this.store.getState().attachKernel(this.kernel);
    setSketchSolverFactory(() => ({
      solve: async (request) => (await loadNodeSolver()).solve(request),
    }));
    this.session = new AgentSession({
      store: this.store,
      kernel: this.kernel,
      host: { server: 'headless', capabilities: HEADLESS_CAPABILITIES },
    });
    process.on('unhandledRejection', (reason) => this.asyncErrors.push(reason));
    process.on('uncaughtException', (error) => this.asyncErrors.push(error));
  }

  static async create(): Promise<FuzzHarness> {
    const harness = new FuzzHarness();
    await harness.reset();
    return harness;
  }

  async call<T = Json>(method: string, params: Json = {}): Promise<T> {
    return (await this.session.handle(method, params)) as T;
  }

  private async settle(): Promise<void> {
    await this.store.getState().whenSettled();
  }

  /** A fresh, empty document with an empty undo history. */
  async reset(): Promise<void> {
    if (this.session.transactionOpen) await this.call('transaction.cancel');
    this.store.getState().cancel();
    this.store.getState().setRollback(null);
    await this.call('project.new', { name: 'Fuzz' });
    await this.settle();
    this.paramCounter = 0;
    this.asyncErrors = [];
  }

  /**
   * Cold evaluation on a separate OCCT instance with empty caches. replicad
   * holds ONE global OCCT instance (`setOC`, set by `createEvaluator`), so
   * the reference instance is swapped in for the call and the fuzzed
   * kernel's instance restored afterwards (never concurrently: the store is
   * settled before every check).
   */
  async coldEvaluate(features: Feature[], perturbation = 0): Promise<EvaluationResult> {
    await this.settle();
    // Waits for the fuzzed kernel to be (re)loaded, so its `setOC` cannot land mid-evaluation.
    await this.call('document.get');
    await this.call('bodies.list', { scope: 'committed' });
    if (!this.reference || this.reference.checks >= 150) {
      this.reference = null;
      this.reference = { oc: await loadOcct(), checks: 0, ballast: [] };
    }
    this.reference.checks += 1;
    // A different wasm heap layout for the same document (see checkDeterminism).
    for (let i = 0; i < perturbation * 7; i += 1) {
      this.reference.ballast.push(new this.reference.oc.gp_Pnt(i, perturbation, 0));
    }
    let evaluator: KernelEvaluator | null = null;
    try {
      evaluator = createEvaluator(this.reference.oc);
      return await evaluator.evaluate(features, { quality: 'final' });
    } finally {
      evaluator?.clearCache();
      if (this.mainOc) R.setOC(this.mainOc);
    }
  }

  private activeFeatures(): Feature[] {
    const { features, rollbackBefore } = this.store.getState();
    const marker = rollbackBefore ? features.findIndex((f) => f.id === rollbackBefore) : -1;
    return marker >= 0 ? features.slice(0, marker) : features;
  }

  // ---- op resolution -------------------------------------------------------------------

  private async features(): Promise<FeatureSummary[]> {
    return this.call<FeatureSummary[]>('features.list');
  }

  private async bodies(): Promise<BodySummary[]> {
    return this.call<BodySummary[]>('bodies.list');
  }

  private async planarFaces(bodyId: string): Promise<FaceSummary[]> {
    const faces = await this.call<FaceSummary[]>('faces.list', { bodyId });
    return faces.filter((f) => f.surface === 'plane');
  }

  private api(method: string, params: Json, undoable = true): Resolved {
    return {
      label: `${method} ${JSON.stringify(params)}`,
      run: () => this.call(method, params),
      undoable: undoable && !this.session.transactionOpen,
    };
  }

  private async resolve(op: Op): Promise<Resolved | null> {
    const r = op.r;
    const planes = ['XY', 'XZ', 'YZ'] as const;
    const shape = (a: number | undefined, b: number | undefined, c: number | undefined) =>
      (r[2] ?? 0) < 0.65
        ? {
            kind: 'rectangle',
            x: between(a, -20, 15),
            y: between(b, -20, 15),
            width: between(c, 2, 30),
            height: between(r[6], 2, 30),
          }
        : {
            kind: 'circle',
            cx: between(a, -15, 15),
            cy: between(b, -15, 15),
            radius: between(c, 1, 12),
          };
    const sketches = async () => (await this.features()).filter((f) => f.kind === 'sketch');
    const bodyId = async (x: number | undefined) => pick(await this.bodies(), x)?.id;

    switch (op.op) {
      case 'sketch':
        return this.api('feature.create', {
          kind: 'sketch',
          params: {
            plane: {
              kind: 'plane',
              plane: pick(planes, r[0])!,
              offset: (r[1] ?? 0) < 0.5 ? 0 : between(r[1], -10, 10),
            },
            profiles: [shape(r[3], r[4], r[5])],
          },
        });
      case 'sketchOnFace': {
        const body = await bodyId(r[0]);
        if (!body) return null;
        const face = pick(await this.planarFaces(body), r[1]);
        if (!face) return null;
        return this.api('feature.create', {
          kind: 'sketch',
          params: {
            plane: { kind: 'face', face: { bodyId: body, key: face.key } },
            profiles: [
              (r[2] ?? 0) < 0.6
                ? {
                    kind: 'rectangle',
                    x: between(r[3], -8, 4),
                    y: between(r[4], -8, 4),
                    width: between(r[5], 1, 8),
                    height: between(r[6], 1, 8),
                  }
                : {
                    kind: 'circle',
                    cx: between(r[3], -6, 6),
                    cy: between(r[4], -6, 6),
                    radius: between(r[5], 0.5, 4),
                  },
            ],
          },
        });
      }
      case 'addProfile': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        return this.api('sketch.addProfile', {
          featureId: sketch.id,
          profile: shape(r[3], r[4], r[5]),
        });
      }
      case 'polyline': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        const x = between(r[1], -20, 10);
        const y = between(r[2], -20, 10);
        const w = between(r[3], 4, 25);
        const h = between(r[4], 4, 25);
        const notch = (r[5] ?? 0) < 0.5;
        const points = notch
          ? [
              [x, y],
              [x + w, y],
              [x + w, y + h / 2],
              [x + w / 2, y + h / 2],
              [x + w / 2, y + h],
              [x, y + h],
            ]
          : [
              [x, y],
              [x + w, y],
              [x + w / 2, y + h],
            ];
        return this.api('sketch.addPolyline', {
          featureId: sketch.id,
          points,
          closed: true,
          construction: (r[6] ?? 0) < 0.1,
        });
      }
      case 'setDimension':
      case 'setDimensionExpr': {
        const sketch = pick(
          (await sketches()).filter(
            (s) => ((s.params.dimensions as unknown[] | undefined) ?? []).length > 0,
          ),
          r[0],
        );
        if (!sketch) return null;
        const dim = pick(sketch.params.dimensions as { name: string; value: number }[], r[1])!;
        if (op.op === 'setDimensionExpr') {
          const param = pick(this.store.getState().parameters, r[2]);
          const expression = param
            ? `${param.name} + ${between(r[3], 0, 10)}`
            : `${Math.max(0.5, round(dim.value, 6))} * ${between(r[3], 0.5, 1.5, 0.25)}`;
          return this.api('sketch.setDimension', {
            featureId: sketch.id,
            dimension: dim.name,
            expression,
          });
        }
        const value =
          (r[2] ?? 0) < 0.15
            ? between(r[3], 0, 0.3, 0.05)
            : round(dim.value * between(r[3], 0.4, 1.8, 0.05), 6);
        return this.api('sketch.setDimension', {
          featureId: sketch.id,
          dimension: dim.name,
          value,
        });
      }
      case 'addConstraint':
      case 'addDimension': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        const entities = (sketch.params.entities as { id: string; kind: string }[]) ?? [];
        const lines = entities.filter((e) => e.kind === 'line');
        const circles = entities.filter((e) => e.kind === 'circle' || e.kind === 'arc');
        const points = entities.filter((e) => e.kind === 'point');
        if (op.op === 'addDimension') {
          const line = pick(lines, r[1]);
          const circle = pick(circles, r[1]);
          if ((r[2] ?? 0) < 0.5 && line) {
            return this.api('sketch.addDimension', {
              featureId: sketch.id,
              kind: 'distance',
              refs: [line.id],
              value: between(r[3], 1, 30),
            });
          }
          if (circle) {
            return this.api('sketch.addDimension', {
              featureId: sketch.id,
              kind: 'diameter',
              refs: [circle.id],
              value: between(r[3], 1, 20),
            });
          }
          return null;
        }
        const kinds = [
          'horizontal',
          'vertical',
          'parallel',
          'perpendicular',
          'equal',
          'fixed',
          'coincident',
        ];
        const kind = pick(kinds, r[1])!;
        let refs: string[] | null = null;
        if (kind === 'horizontal' || kind === 'vertical') {
          const l = pick(lines, r[2]);
          if (l) refs = [l.id];
        } else if (kind === 'fixed') {
          const p = pick(points, r[2]);
          if (p) refs = [p.id];
        } else if (kind === 'coincident') {
          const a = pick(points, r[2]);
          const b = pick(points, r[3]);
          if (a && b && a !== b) refs = [a.id, b.id];
        } else {
          const a = pick(lines, r[2]);
          const b = pick(lines, r[3]);
          if (a && b && a !== b) refs = [a.id, b.id];
          if (kind === 'equal' && !refs) {
            const c = pick(circles, r[2]);
            const d = pick(circles, r[3]);
            if (c && d && c !== d) refs = [c.id, d.id];
          }
        }
        if (!refs) return null;
        return this.api('sketch.addConstraint', { featureId: sketch.id, kind, refs });
      }
      case 'deleteSketchItems': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        const items = [
          ...((sketch.params.entities as { id: string; kind: string }[]) ?? []).filter(
            (e) => e.kind !== 'point',
          ),
          ...((sketch.params.constraints as { id: string }[]) ?? []),
          ...((sketch.params.dimensions as { id: string }[]) ?? []),
        ];
        const item = pick(items, r[1]);
        if (!item) return null;
        return this.api('sketch.deleteItems', { featureId: sketch.id, ids: [item.id] });
      }
      case 'extrude':
      case 'extrudeExpr': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        const bodies = await this.bodies();
        const operation =
          bodies.length === 0 ? 'new' : pick(['new', 'new', 'join', 'cut'] as const, r[1])!;
        const target = operation === 'new' ? undefined : pick(bodies, r[2])?.id;
        const sketchInfo = (
          await this.call<{ featureId: string; regions: { key: string }[] }[]>('sketches.list')
        ).find((s) => s.featureId === sketch.id);
        const region = (r[5] ?? 0) < 0.25 ? pick(sketchInfo?.regions ?? [], r[6]) : undefined;
        const distance = between(r[3], 1, 20) * ((r[4] ?? 0) < 0.25 ? -1 : 1);
        const param = pick(this.store.getState().parameters, r[4]);
        return this.api('feature.create', {
          kind: 'extrude',
          params: {
            profile: {
              kind: 'sketch',
              featureId: sketch.id,
              ...(region ? { regions: [region.key] } : {}),
            },
            ...(op.op === 'extrudeExpr' && param
              ? { distanceExpression: `${param.name} * ${between(r[3], 0.5, 2, 0.5)}` }
              : { distance }),
            symmetric: (r[7] ?? 0) < 0.1,
            operation,
            ...(target ? { targetBodyId: target } : {}),
          },
        });
      }
      case 'pushPull': {
        const body = await bodyId(r[0]);
        if (!body) return null;
        const face = pick(await this.planarFaces(body), r[1]);
        if (!face) return null;
        return this.api('feature.create', {
          kind: 'extrude',
          params: {
            profile: { kind: 'face', face: { bodyId: body, key: face.key } },
            distance: between(r[2], -5, 8),
          },
        });
      }
      case 'revolve': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        const bodies = await this.bodies();
        const operation =
          bodies.length === 0 ? 'new' : pick(['new', 'join', 'cut'] as const, r[1])!;
        const target = operation === 'new' ? undefined : pick(bodies, r[2])?.id;
        return this.api('feature.create', {
          kind: 'revolve',
          params: {
            profile: { kind: 'sketch', featureId: sketch.id },
            axis: {
              kind: 'world',
              axis: pick(['X', 'Y', 'Z'] as const, r[3])!,
              ...((r[4] ?? 0) < 0.5 ? { origin: [between(r[5], -30, 30), 0, 0] } : {}),
            },
            angle: (r[6] ?? 0) < 0.5 ? 360 : between(r[6], 30, 350, 10),
            operation,
            ...(target ? { targetBodyId: target } : {}),
          },
        });
      }
      case 'fillet':
      case 'chamfer': {
        const body = await bodyId(r[0]);
        if (!body) return null;
        const selectors = ['|Z', '>Z', '<Z', '|X', '|Y', '>X', '%CIRCLE', '%LINE and >Z'];
        let edges: Json[];
        if ((r[1] ?? 0) < 0.5) {
          edges = [{ bodyId: body, select: pick(selectors, r[2])! }];
        } else {
          const all = await this.call<{ key: string }[]>('edges.list', { bodyId: body });
          const edge = pick(all, r[2]);
          if (!edge) return null;
          edges = [{ bodyId: body, key: edge.key }];
        }
        const size = between(r[3], 0.2, 6, 0.1);
        return this.api('feature.create', {
          kind: op.op,
          params: op.op === 'fillet' ? { edges, radius: size } : { edges, distance: size },
        });
      }
      case 'shell': {
        const body = await bodyId(r[0]);
        if (!body) return null;
        const face = pick(await this.planarFaces(body), r[1]);
        if (!face) return null;
        return this.api('feature.create', {
          kind: 'shell',
          params: {
            bodyId: body,
            faces: [{ bodyId: body, key: face.key }],
            thickness: between(r[2], 0.2, 4, 0.1),
            direction: (r[3] ?? 0) < 0.8 ? 'inside' : 'outside',
          },
        });
      }
      case 'boolean': {
        const bodies = await this.bodies();
        if (bodies.length < 2) return null;
        const target = pick(bodies, r[0])!;
        const tool = pick(
          bodies.filter((b) => b.id !== target.id),
          r[1],
        )!;
        return this.api('feature.create', {
          kind: 'boolean',
          params: {
            operation: pick(['union', 'subtract', 'intersect'] as const, r[2])!,
            targetBodyId: target.id,
            toolBodyIds: [tool.id],
            keepTools: (r[3] ?? 0) < 0.2,
          },
        });
      }
      case 'pattern': {
        const body = await bodyId(r[0]);
        if (!body) return null;
        const axis = pick(['X', 'Y', 'Z'] as const, r[2])!;
        return this.api('feature.create', {
          kind: 'pattern',
          params: {
            bodyIds: [body],
            pattern:
              (r[1] ?? 0) < 0.5
                ? {
                    kind: 'linear',
                    direction: { kind: 'world', axis },
                    count: 2 + Math.floor((r[3] ?? 0) * 3),
                    spacing: between(r[4], -40, 40, 2.5) || 10,
                  }
                : {
                    kind: 'circular',
                    axis: { kind: 'world', axis },
                    count: 2 + Math.floor((r[3] ?? 0) * 5),
                    angle: (r[4] ?? 0) < 0.5 ? 360 : between(r[4], 30, 330, 30),
                  },
          },
        });
      }
      case 'mirror': {
        const body = await bodyId(r[0]);
        if (!body) return null;
        return this.api('feature.create', {
          kind: 'mirror',
          params: {
            bodyIds: [body],
            plane: { kind: 'plane', plane: pick(planes, r[1])!, offset: between(r[2], -20, 20, 5) },
            keepOriginal: (r[3] ?? 0) < 0.7,
          },
        });
      }
      case 'hole': {
        const body = await bodyId(r[0]);
        if (!body) return null;
        const face = pick(await this.planarFaces(body), r[1]);
        if (!face) return null;
        const d = between(r[2], 1, 8, 0.2);
        const counterbore = (r[5] ?? 0) < 0.3;
        return this.api('feature.create', {
          kind: 'hole',
          params: {
            face: { bodyId: body, key: face.key },
            placements: [{ kind: 'point', u: between(r[3], -15, 15), v: between(r[4], -15, 15) }],
            diameter: d,
            ...(counterbore
              ? {
                  holeType: 'counterbore',
                  counterboreDiameter: d * 1.8,
                  counterboreDepth: between(r[6], 0.5, 3),
                }
              : {}),
          },
        });
      }
      case 'emboss': {
        const all = await sketches();
        const onFace = all.filter(
          (s) => (s.params.plane as { kind?: string } | undefined)?.kind === 'face',
        );
        const sketch = pick(onFace.length > 0 && (r[0] ?? 0) < 0.8 ? onFace : all, r[1]);
        if (!sketch) return null;
        const plane = sketch.params.plane as {
          kind: string;
          face?: { bodyId: string; key: string };
        };
        let face: Json | undefined =
          plane.kind === 'face' && plane.face
            ? { bodyId: plane.face.bodyId, key: plane.face.key }
            : undefined;
        if (!face || (r[2] ?? 0) < 0.2) {
          const body = await bodyId(r[3]);
          if (!body) return null;
          const f = pick(await this.call<FaceSummary[]>('faces.list', { bodyId: body }), r[4]);
          if (!f) return null;
          face = { bodyId: body, key: f.key };
        }
        return this.api('feature.create', {
          kind: 'emboss',
          params: {
            profile: { kind: 'sketch', featureId: sketch.id },
            face,
            depth: between(r[5], 0.3, 2, 0.1) * ((r[6] ?? 0) < 0.5 ? -1 : 1),
          },
        });
      }
      case 'transform': {
        const body = await bodyId(r[0]);
        if (!body) return null;
        return this.api('feature.create', {
          kind: 'transform',
          params: {
            bodyId: body,
            dx: between(r[1], -20, 20),
            dy: between(r[2], -20, 20),
            dz: between(r[3], -10, 10),
            rz: (r[4] ?? 0) < 0.5 ? 0 : between(r[4], -90, 90, 15),
            copy: (r[5] ?? 0) < 0.3,
          },
        });
      }
      case 'paramCreate': {
        this.paramCounter += 1;
        const existing = this.store.getState().parameters;
        const other = (r[2] ?? 0) < 0.3 ? pick(existing, r[3]) : undefined;
        return this.api('parameter.create', {
          name: `p${this.paramCounter}`,
          unit: 'mm',
          ...(other
            ? { expression: `${other.name} + ${between(r[1], 0, 5)}` }
            : { value: between(r[1], 1, 20) }),
        });
      }
      case 'paramEdit': {
        const param = pick(this.store.getState().parameters, r[0]);
        if (!param) return null;
        const other = pick(
          this.store.getState().parameters.filter((p) => p.id !== param.id),
          r[2],
        );
        return this.api('parameter.edit', {
          parameterId: param.id,
          ...((r[1] ?? 0) < 0.2 && other
            ? { expression: `${other.name} * 2` }
            : { value: (r[3] ?? 0) < 0.1 ? 0 : between(r[1], 0.5, 25) }),
        });
      }
      case 'paramDelete': {
        const param = pick(this.store.getState().parameters, r[0]);
        if (!param) return null;
        return this.api('parameter.delete', { parameterId: param.id });
      }
      case 'featureEdit': {
        const feature = pick(
          (await this.features()).filter((f) => f.kind !== 'sketch'),
          r[0],
        );
        if (!feature) return null;
        const p = feature.params;
        const scale = between(r[1], 0.3, 2.5, 0.1);
        let params: Json | null = null;
        if (feature.kind === 'extrude' && typeof p.distance === 'number')
          params = { distance: round(p.distance * scale, 6) || 1 };
        else if (feature.kind === 'fillet' && typeof p.radius === 'number')
          params = { radius: round(p.radius * scale, 6) };
        else if (feature.kind === 'chamfer' && typeof p.distance === 'number')
          params = { distance: round(p.distance * scale, 6) };
        else if (feature.kind === 'shell' && typeof p.thickness === 'number')
          params = { thickness: round(p.thickness * scale, 6) };
        else if (feature.kind === 'revolve')
          params = { angle: (r[2] ?? 0) < 0.5 ? 360 : between(r[2], 20, 340, 10) };
        else if (feature.kind === 'hole' && typeof p.diameter === 'number')
          params = { diameter: round(p.diameter * scale, 6) };
        else if (feature.kind === 'emboss' && typeof p.depth === 'number')
          params = { depth: -p.depth };
        else if (feature.kind === 'mirror') params = { keepOriginal: !(p.keepOriginal ?? true) };
        else if (feature.kind === 'transform') params = { dx: between(r[2], -20, 20) };
        else if (feature.kind === 'boolean')
          params = { operation: pick(['union', 'subtract', 'intersect'], r[2]) };
        if (!params) return null;
        return this.api('feature.edit', { featureId: feature.id, params });
      }
      case 'suppress': {
        const feature = pick(await this.features(), r[0]);
        if (!feature) return null;
        return this.api('feature.suppress', {
          featureId: feature.id,
          suppressed: !feature.suppressed,
        });
      }
      case 'deleteFeature': {
        const feature = pick(await this.features(), r[0]);
        if (!feature) return null;
        return this.api('feature.delete', { featureId: feature.id });
      }
      case 'rename': {
        const feature = pick(await this.features(), r[0]);
        if (!feature) return null;
        return this.api('feature.rename', {
          featureId: feature.id,
          name: `${feature.name} ${Math.floor((r[1] ?? 0) * 100)}`,
        });
      }
      case 'rollback': {
        const { features } = this.store.getState();
        const target = (r[0] ?? 0) < 0.3 ? null : (pick(features, r[1])?.id ?? null);
        return {
          label: `ui.setRollback ${JSON.stringify(target)}`,
          run: async () => {
            this.store.getState().setRollback(target);
            await this.settle();
          },
          undoable: false,
        };
      }
      case 'reorder': {
        const { features } = this.store.getState();
        if (features.length < 2) return null;
        const from = Math.floor((r[0] ?? 0) * features.length);
        const to = Math.floor((r[1] ?? 0) * features.length);
        if (from === to) return null;
        return {
          label: `ui.moveFeature ${from} -> ${to}`,
          run: async () => {
            const state = this.store.getState();
            const check = checkMove(state.features, from, to);
            if (!check.ok) throw new ApiError('conflict', check.reason);
            if (
              !state.commitDocumentChange(moveFeature(state.features, from, to), {
                keepRollback: true,
              })
            ) {
              throw new ApiError('busy', 'commitDocumentChange refused');
            }
            await this.settle();
          },
          undoable: true,
        };
      }
      case 'undo':
        return this.api('history.undo', {}, false);
      case 'redo':
        return this.api('history.redo', {}, false);
      case 'txBegin':
        return this.api('transaction.begin', { label: 'fuzz' }, false);
      case 'txPreview':
        return this.api('transaction.preview', {}, false);
      case 'txCommit':
        return this.api('transaction.commit', {}, false);
      case 'txCancel':
        return this.api('transaction.cancel', {}, false);
      case 'saveReopen':
        return {
          label: 'project.save → project.open',
          run: () => this.saveAndReopen(),
          undoable: false,
        };
    }
  }

  // ---- invariants ----------------------------------------------------------------------

  private async saveAndReopen(): Promise<void> {
    const saved = await this.call<{ text: string }>('project.save');
    const before = this.store.getState();
    const features = plain(before.features);
    const parameters = plain(before.parameters);
    const expected = evaluationSignature(await this.coldEvaluate(before.features));
    await this.call('project.open', { text: saved.text });
    await this.settle();
    const after = this.store.getState();
    const d1 = firstDifference(plain(after.features), features);
    if (d1) fail('saveReopen', `reopened features differ: ${d1}`);
    const d2 = firstDifference(plain(after.parameters), parameters);
    if (d2) fail('saveReopen', `reopened parameters differ: ${d2}`);
    const d3 = firstDifference(evaluationSignature(after.evaluation), expected);
    if (d3) fail('saveReopen', `reopened evaluation differs: ${d3}`);
  }

  private checkAsyncErrors(): void {
    if (this.asyncErrors.length === 0) return;
    const error = this.asyncErrors[0];
    this.asyncErrors = [];
    fail(
      'exception',
      `unhandled async error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }

  private checkDocument(): void {
    const { features } = this.store.getState();
    const ids = new Set<string>();
    for (const f of features) {
      if (ids.has(f.id)) fail('uniqueIds', `duplicate feature id ${f.id}`);
      ids.add(f.id);
    }
  }

  private checkEvaluation(evaluation: EvaluationResult, active: Feature[]): void {
    const ids = new Set(active.map((f) => f.id));
    const messages = { ...evaluation.errors, ...evaluation.warnings };
    for (const [id, message] of Object.entries(evaluation.errors)) {
      if (!ids.has(id)) fail('namedErrors', `error on unknown feature ${id}: ${message}`);
      if (
        typeof message !== 'string' ||
        message.trim().length < 3 ||
        /^\s*-?\d+\s*$|undefined|\[object |^null$/i.test(message)
      ) {
        fail('namedErrors', `unreadable error on ${id}: ${JSON.stringify(message)}`);
      }
    }
    // A step reading a sketch that is gone (or later in the history) must say so.
    const seen = new Set<string>();
    for (const f of active) {
      const profile = (f as { profile?: { kind?: string; featureId?: string } }).profile;
      if (
        !f.suppressed &&
        profile?.kind === 'sketch' &&
        profile.featureId &&
        !seen.has(profile.featureId) &&
        !evaluation.errors[f.id]
      ) {
        fail('namedErrors', `${f.id} reads missing sketch ${profile.featureId} without an error`);
      }
      seen.add(f.id);
    }
    for (const body of evaluation.bodies) {
      if (!body.valid && Object.keys(messages).length === 0) {
        fail(
          'silentInvalid',
          `body ${body.id} (${body.name}, created by ${body.createdBy}) is not a valid B-rep and no feature reports an error or warning`,
        );
      }
    }
    const heap = evaluation.stats.heapBytes ?? 0;
    if (heap > HEAP_LIMIT_BYTES) {
      fail('heap', `wasm heap ${Math.round(heap / 2 ** 20)} MB > ${HEAP_LIMIT_BYTES / 2 ** 20} MB`);
    }
  }

  private async checkDeterminism(): Promise<void> {
    const state = this.store.getState();
    const active = this.activeFeatures();
    const incremental = evaluationSignature(state.evaluation);
    const cold = await this.coldEvaluate(active);
    const d = firstDifference(incremental, evaluationSignature(cold));
    if (!d) return;
    // OCCT's result for marginal geometry depends on the wasm heap layout (containers hashed by
    // address; finding F3): the SAME cold evaluation flips with prior allocations. If a cold
    // evaluation in another heap state reproduces the incremental result, the difference is the
    // kernel's, not a cache bug — recorded as marginal, not failed. A cache bug differs always.
    for (let k = 1; k <= 16; k += 1) {
      const again = evaluationSignature(await this.coldEvaluate(active, k));
      if (!firstDifference(incremental, again)) {
        this.marginal.push(`heap-layout dependent (cold run ${k} agrees): ${d}`);
        return;
      }
    }
    fail('determinism', `incremental ≠ cold evaluation: ${d}`);
  }

  private async checkUndoRedo(): Promise<void> {
    const before = this.store.getState();
    const features = plain(before.features);
    const parameters = plain(before.parameters);
    const signature = evaluationSignature(before.evaluation);
    await this.call('history.undo');
    await this.call('history.redo');
    const after = this.store.getState();
    const d1 = firstDifference(plain(after.features), features);
    if (d1) fail('undoRedo', `features after undo+redo differ: ${d1}`);
    const d2 = firstDifference(plain(after.parameters), parameters);
    if (d2) fail('undoRedo', `parameters after undo+redo differ: ${d2}`);
    const d3 = firstDifference(evaluationSignature(after.evaluation), signature);
    if (d3) fail('undoRedo', `evaluation after undo+redo differs: ${d3}`);
  }

  private async checkSaveLoad(): Promise<void> {
    if (this.session.transactionOpen) return;
    const saved = await this.call<{ text: string }>('project.save');
    const state = this.store.getState();
    let loaded;
    try {
      loaded = loadProjectFile(saved.text);
    } catch (error) {
      fail('saveReopen', `saved project does not load: ${String(error)}`);
    }
    const d1 = firstDifference(plain(loaded.features), plain(state.features));
    if (d1) fail('saveReopen', `saved features differ: ${d1}`);
    const d2 = firstDifference(plain(loaded.parameters ?? []), plain(state.parameters));
    if (d2) fail('saveReopen', `saved parameters differ: ${d2}`);
  }

  // ---- running -------------------------------------------------------------------------

  /** Runs one sequence on a fresh document; stops at the first broken invariant. */
  async run(
    ops: readonly Op[],
    options: { log?: (line: string) => void; deadline?: number } = {},
  ): Promise<RunResult> {
    await this.reset();
    this.marginal = [];
    const log: StepLog[] = [];
    let committed = 0;
    let refused = 0;
    let maxHeapBytes = 0;
    let txBase: { features: Feature[]; parameters: unknown; revision: number } | null = null;
    for (let step = 0; step < ops.length; step += 1) {
      if (options.deadline && Date.now() > options.deadline) break;
      const op = ops[step]!;
      const entry: StepLog = { step, op: op.op, call: '', outcome: 'skipped' };
      log.push(entry);
      try {
        const resolved = await this.resolve(op);
        if (!resolved) {
          options.log?.(`#${step} ${op.op}: skipped`);
          continue;
        }
        entry.call = resolved.label;
        const before = this.store.getState();
        const beforeRevision = this.session.documentRevision;
        const wasTx = this.session.transactionOpen;
        let ok = true;
        try {
          await resolved.run();
        } catch (error) {
          if (error instanceof InvariantError) throw error;
          if (error instanceof ApiError && REFUSALS.has(error.code)) {
            ok = false;
            entry.outcome = 'refused';
            entry.detail = `${error.code}: ${error.message}`;
            refused += 1;
          } else if (error instanceof ApiError) {
            fail('exception', `${error.code}: ${error.message}`);
          } else {
            fail(
              'exception',
              `uncaught ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
            );
          }
        }
        await this.settle();
        this.checkAsyncErrors();
        const after = this.store.getState();
        if (!ok && op.op !== 'saveReopen') {
          if (after.features !== before.features || after.parameters !== before.parameters) {
            fail(
              'refusalTrace',
              `refused ${resolved.label} changed the document (${entry.detail})`,
            );
          }
        }
        if (ok) {
          entry.outcome = 'ok';
          if (op.op === 'txBegin') {
            txBase = {
              features: after.features,
              parameters: after.parameters,
              revision: this.session.documentRevision,
            };
          }
          if (op.op === 'txCancel' && txBase) {
            if (
              after.features !== txBase.features ||
              after.parameters !== txBase.parameters ||
              this.session.documentRevision !== txBase.revision
            ) {
              fail('cancelTrace', 'transaction.cancel left the document changed');
            }
          }
          if (!this.session.transactionOpen) txBase = null;
          if (resolved.undoable && !wasTx && after.features !== before.features) committed += 1;
        }
        options.log?.(
          `#${step} ${entry.outcome} ${resolved.label.slice(0, 160)}${entry.detail ? ` — ${entry.detail.slice(0, 160)}` : ''}`,
        );

        this.checkDocument();
        const evaluation = this.store.getState().evaluation;
        this.checkEvaluation(evaluation, this.activeFeatures());
        maxHeapBytes = Math.max(maxHeapBytes, evaluation.stats.heapBytes ?? 0);
        const changed =
          after.features !== before.features ||
          after.parameters !== before.parameters ||
          after.rollbackBefore !== before.rollbackBefore ||
          beforeRevision !== this.session.documentRevision;
        if (changed || op.op === 'saveReopen') await this.checkDeterminism();
        if (ok && resolved.undoable && !wasTx && after.features !== before.features) {
          await this.checkUndoRedo();
        }
        if (changed) await this.checkSaveLoad();
        this.checkAsyncErrors();
      } catch (error) {
        const invariant = error instanceof InvariantError ? error.invariant : 'exception';
        const message =
          error instanceof InvariantError
            ? error.message
            : `harness: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
        entry.outcome = 'failed';
        entry.detail = `${invariant}: ${message}`;
        options.log?.(`#${step} FAILED ${invariant}: ${message}`);
        return {
          failure: { step, op, invariant, message },
          log,
          steps: step + 1,
          committed,
          refused,
          maxHeapBytes,
          kernelLoads: this.kernelLoads,
          marginal: [...this.marginal],
        };
      }
    }
    return {
      failure: null,
      log,
      steps: log.length,
      committed,
      refused,
      maxHeapBytes,
      kernelLoads: this.kernelLoads,
      marginal: [...this.marginal],
    };
  }
}
