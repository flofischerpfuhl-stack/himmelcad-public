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
 * - `kernelTimeout`     no kernel job (fuzzed or reference) runs longer than
 *                       {@link FUZZ_KERNEL_TIMEOUT_MS} without progress (F13): the
 *                       thread kernel stops it and the fuzzer records a finding
 *                       instead of hanging.
 * - `arenaOrder`        no OCCT object arena was closed out of order
 *                       (interleaved kernel users, `kernel/occtArena.ts`).
 * - `roundTrip`         STEP/IGES export → import of valid solids keeps their
 *                       volume; DXF export → import of a sketch keeps its
 *                       regions' total area.
 *
 * Both kernels — the fuzzed one and the cold reference — run in Node worker
 * threads (`headless/threadKernel.ts`, the headless CLI's kernel) with a time
 * budget, so an OCCT call that never returns becomes a `kernelTimeout`
 * finding. The OCCT module is the one `HIMMELCAD_OCCT` selects
 * (`headless/occtModule.ts`).
 */
import { ThreadKernelAdapter } from '../../headless/threadKernel.js';

import { ApiError } from '../../renderer/src/foundation/commands/api/errors.js';
import {
  AgentSession,
  HEADLESS_CAPABILITIES,
} from '../../renderer/src/interface/agent-api/session.js';
import { isKernelTimeout } from '../../renderer/src/foundation/geometry-kernel/timeout.js';
import type { EvaluationResult } from '../../renderer/src/foundation/geometry-kernel/types.js';
import type { Feature } from '../../renderer/src/foundation/document/document.js';
import { checkMove, moveFeature } from '../../renderer/src/interface/shell-ui/historyTools.js';
import { loadProjectFile } from '../../renderer/src/foundation/document/format.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { installNodeFonts } from '../sketch/nodeFont.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';
import { between, pick, type Op } from './ops.js';

type Json = Record<string, unknown>;

/** Hard bound for the kernel's wasm heap (the recycle threshold below keeps it far lower). */
export const HEAP_LIMIT_BYTES = 1536 * 1024 * 1024;
/** Recycle threshold of the fuzzed kernel: low, so long runs go through kernel restarts. */
export const FUZZ_RECYCLE_BYTES = 384 * 1024 * 1024;
/**
 * Time budget of one kernel job without progress (a feature step, an export, a cold
 * evaluation). Far above any fuzzed document's evaluation (well under a second per step);
 * env `ASSEMBLER_FUZZ_KERNEL_TIMEOUT_MS`.
 */
export const FUZZ_KERNEL_TIMEOUT_MS = Number(
  process.env.ASSEMBLER_FUZZ_KERNEL_TIMEOUT_MS ?? 20_000,
);
/** Cold evaluations per reference kernel before a fresh one (instance-state independence). */
const REFERENCE_CHECKS = 150;

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

/** Swallows a refusal of an op's follow-up call (its first call stays committed); rethrows the rest. */
function refusedOnly(error: unknown): void {
  if (error instanceof ApiError && REFUSALS.has(error.code)) return;
  throw error;
}

/** A 4 × 2 px grey PNG for the reference-image op. */
const FUZZ_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAADklEQVR4nGNoQAIMyBwAnBoMATyCc0QAAAAASUVORK5CYII=';

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

/** A kernel thread for the fuzzer: quiet, with the fuzz time budget. */
function fuzzKernel(recycleHeapBytes?: number): ThreadKernelAdapter {
  return new ThreadKernelAdapter({
    quiet: true,
    jobTimeoutMs: FUZZ_KERNEL_TIMEOUT_MS,
    ...(recycleHeapBytes !== undefined ? { recycleHeapBytes } : {}),
  });
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
interface SketchSummary {
  featureId: string;
  frame: { origin: number[]; u: number[]; v: number[]; normal: number[] } | null;
  regions?: { key: string; area?: number }[];
}
interface FaceSummary {
  key: string;
  surface: string;
  normal?: number[] | null;
  centroid?: number[];
}

export class FuzzHarness {
  readonly store = useAssemblerStore;
  readonly kernel: ThreadKernelAdapter;
  readonly session: AgentSession;
  /** The cold reference kernel (a separate OCCT instance), replaced every {@link REFERENCE_CHECKS} checks. */
  private reference: { kernel: ThreadKernelAdapter; checks: number } | null = null;
  /** OCCT arenas the reference kernels closed out of order (retired kernels included). */
  private referenceInterleavings = 0;
  /** Determinism differences explained by OCCT's heap-layout dependence (finding F3), this run. */
  private marginal: string[] = [];
  private asyncErrors: unknown[] = [];
  private paramCounter = 0;
  /** How often the fuzzed kernel was (re)loaded: first load, recycles, restarts. */
  get kernelLoads(): number {
    return this.kernel.loads;
  }

  private constructor() {
    this.kernel = fuzzKernel(FUZZ_RECYCLE_BYTES);
    this.store.getState().attachKernel(this.kernel);
    setSketchSolverFactory(() => ({
      solve: async (request) => (await loadNodeSolver()).solve(request),
    }));
    // Sketch text (sketch.addText) reads the bundled Inter font, as the app and the headless CLI do.
    installNodeFonts();
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
   * Cold evaluation on a separate OCCT instance (the reference kernel thread)
   * with empty caches; `perturbation` shifts that instance's heap layout
   * first (extra OCCT allocations). Runs within the fuzz time budget.
   */
  async coldEvaluate(features: Feature[], perturbation = 0): Promise<EvaluationResult> {
    await this.settle();
    if (!this.reference || this.reference.checks >= REFERENCE_CHECKS) {
      if (this.reference) {
        this.referenceInterleavings += await this.reference.kernel.arenaInterleavings();
        this.reference.kernel.dispose();
      }
      this.reference = { kernel: fuzzKernel(), checks: 0 };
    }
    this.reference.checks += 1;
    const cold = await this.reference.kernel.evaluateFresh(features, { perturbation });
    return cold.result;
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

  private async sketchInfo(featureId: string): Promise<SketchSummary | undefined> {
    return (await this.call<SketchSummary[]>('sketches.list')).find(
      (s) => s.featureId === featureId,
    );
  }

  /** Closed regions (profiles) of a sketch with their keys and areas. */
  private async regionsOf(featureId: string): Promise<{ key: string; area?: number }[]> {
    return (await this.sketchInfo(featureId))?.regions ?? [];
  }

  private async frameOf(featureId: string): Promise<SketchSummary['frame']> {
    return (await this.sketchInfo(featureId))?.frame ?? null;
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
      // Block 8: primitives, Scale, Translate, Move Edge/Face, helical revolve, extrude taper.
      case 'primitive': {
        const shape = pick(['box', 'cylinder', 'sphere', 'cone', 'torus'] as const, r[0])!;
        const body = (r[1] ?? 0) < 0.4 ? await bodyId(r[2]) : null;
        const face = body ? pick(await this.planarFaces(body), r[3]) : undefined;
        const s = between(r[4], 1, 12, 0.5);
        const sizes =
          shape === 'box'
            ? { width: s * 2, depth: between(r[5], 2, 20), height: between(r[6], 1, 15) }
            : shape === 'cylinder'
              ? { radius: s, height: between(r[6], 1, 15) }
              : shape === 'sphere'
                ? { radius: s }
                : shape === 'cone'
                  ? { radius: s, radius2: between(r[5], 0, s * 0.8), height: between(r[6], 1, 15) }
                  : { radius: s + 2, radius2: between(r[5], 0.5, s * 0.8 + 0.5) };
        const operation = face ? pick(['join', 'cut', 'new'] as const, r[7])! : 'new';
        return this.api('feature.create', {
          kind: 'primitive',
          params: {
            shape,
            ...(face
              ? {
                  plane: { kind: 'face', face: { bodyId: body, key: face.key } },
                  center: face.centroid ?? [0, 0, 0],
                  operation,
                  ...(operation !== 'new' ? { targetBodyId: body } : {}),
                  ...(operation === 'cut' ? { flip: true } : {}),
                }
              : { center: [between(r[2], -30, 30), between(r[3], -30, 30), 0] }),
            ...sizes,
          },
        });
      }
      case 'scale': {
        const body = await bodyId(r[0]);
        if (!body) return null;
        const perAxis = (r[1] ?? 0) < 0.3;
        return this.api('feature.create', {
          kind: 'scale',
          params: {
            bodyIds: [body],
            ...(perAxis
              ? {
                  factors: [
                    between(r[2], 0.5, 1.5, 0.05),
                    between(r[3], 0.5, 1.5, 0.05),
                    between(r[4], 0.5, 1.5, 0.05),
                  ],
                }
              : { factor: between(r[2], 0.5, 2, 0.05) }),
            center: [between(r[5], -10, 10), between(r[6], -10, 10), 0],
            copy: (r[7] ?? 0) < 0.3,
          },
        });
      }
      case 'translate': {
        const body = await bodyId(r[0]);
        if (!body) return null;
        return this.api('feature.create', {
          kind: 'translate',
          params: {
            bodyIds: [body],
            from: [between(r[1], -20, 20), between(r[2], -20, 20), 0],
            to: [between(r[3], -20, 20), between(r[4], -20, 20), between(r[5], -5, 5)],
            copy: (r[6] ?? 0) < 0.3,
          },
        });
      }
      case 'moveEdge': {
        const body = await bodyId(r[0]);
        if (!body) return null;
        const lines = (
          await this.call<{ key: string; curve: string }[]>('edges.list', { bodyId: body })
        ).filter((e) => e.curve === 'line');
        const edge = pick(lines, r[1]);
        if (!edge) return null;
        return this.api('feature.create', {
          kind: 'moveEdge',
          params: {
            edge: { bodyId: body, key: edge.key },
            vector: [between(r[2], -4, 4), between(r[3], -4, 4), between(r[4], -4, 4)],
          },
        });
      }
      case 'moveFace': {
        const body = await bodyId(r[0]);
        if (!body) return null;
        const face = pick(await this.planarFaces(body), r[1]);
        if (!face) return null;
        return this.api('feature.create', {
          kind: 'moveFace',
          params: {
            face: { bodyId: body, key: face.key },
            vector: [between(r[2], -4, 4), between(r[3], -4, 4), between(r[4], -4, 4)],
          },
        });
      }
      case 'replaceFace': {
        const body = await bodyId(r[0]);
        const other = await bodyId(r[2]);
        if (!body || !other) return null;
        const face = pick(await this.planarFaces(body), r[1]);
        const targets = (await this.call<FaceSummary[]>('faces.list', { bodyId: other })).filter(
          (f) =>
            (f.surface === 'plane' || f.surface === 'cylinder') &&
            !(other === body && f.key === face?.key),
        );
        const target = pick(targets, r[3]);
        if (!face || !target) return null;
        return this.api('feature.create', {
          kind: 'replaceFace',
          params: {
            faces: [{ bodyId: body, key: face.key }],
            target: { bodyId: other, key: target.key },
          },
        });
      }
      case 'helix': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        const bodies = await this.bodies();
        const operation = bodies.length === 0 ? 'new' : pick(['new', 'join'] as const, r[1])!;
        const target = operation === 'new' ? undefined : pick(bodies, r[2])?.id;
        return this.api('feature.create', {
          kind: 'revolve',
          params: {
            profile: { kind: 'sketch', featureId: sketch.id },
            axis: {
              kind: 'world',
              axis: pick(['X', 'Y', 'Z'] as const, r[3])!,
              origin: [between(r[4], -40, 40), 0, 0],
            },
            angle: 360,
            helix: {
              pitch: between(r[5], 2, 40) * ((r[6] ?? 0) < 0.2 ? -1 : 1),
              turns: between(r[7], 0.5, 2, 0.25),
              ...((r[6] ?? 0) > 0.8 ? { leftHanded: true } : {}),
            },
            operation,
            ...(target ? { targetBodyId: target } : {}),
          },
        });
      }
      case 'taper': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        const sides = pick(['one', 'one', 'symmetric', 'two'] as const, r[1])!;
        return this.api('feature.create', {
          kind: 'extrude',
          params: {
            profile: { kind: 'sketch', featureId: sketch.id },
            distance: between(r[2], 1, 15) * ((r[3] ?? 0) < 0.2 ? -1 : 1),
            symmetric: sides === 'symmetric',
            ...(sides === 'two' ? { distance2: between(r[4], 1, 8) } : {}),
            taper: between(r[5], -15, 15, 0.5) || 3,
            operation: 'new',
          },
        });
      }
      // Block 8 integration: two-direction / uniform patterns, profile split, reference
      // images, sketch patterns in two directions (edited afterwards) and sketch offsets.
      case 'patternGrid': {
        const body = await bodyId(r[0]);
        if (!body) return null;
        const axes = ['X', 'Y', 'Z'] as const;
        const axis = pick(axes, r[2])!;
        return this.api('feature.create', {
          kind: 'pattern',
          params: {
            bodyIds: [body],
            pattern:
              (r[1] ?? 0) < 0.6
                ? {
                    kind: 'linear',
                    direction: { kind: 'world', axis },
                    count: 2 + Math.floor((r[3] ?? 0) * 3),
                    spacing: between(r[4], 5, 40, 2.5),
                    spacingMode: (r[5] ?? 0) < 0.5 ? 'spacing' : 'total',
                    second: {
                      direction: { kind: 'world', axis: axes[(axes.indexOf(axis) + 1) % 3]! },
                      count: 1 + Math.floor((r[6] ?? 0) * 3),
                      spacing: between(r[7], 5, 30, 2.5),
                    },
                  }
                : {
                    kind: 'circular',
                    axis: { kind: 'world', axis },
                    count: 2 + Math.floor((r[3] ?? 0) * 5),
                    angle: between(r[4], 15, 90, 15),
                    angleMode: 'spacing',
                    uniform: (r[5] ?? 0) < 0.5,
                  },
          },
        });
      }
      case 'splitProfile': {
        const body = await bodyId(r[0]);
        const sketch = pick(await sketches(), r[1]);
        if (!body || !sketch) return null;
        return this.api('feature.create', {
          kind: 'split',
          params: {
            bodyId: body,
            profile: { kind: 'sketch', featureId: sketch.id },
            keepOriginal: (r[2] ?? 0) < 0.4,
          },
        });
      }
      case 'image': {
        const plane = pick(planes, r[0])!;
        return {
          label: `image.insert on ${plane} (+ calibrate)`,
          run: async () => {
            const inserted = await this.call<{ featureId: string }>('image.insert', {
              data: FUZZ_PNG,
              fileName: 'fuzz.png',
              plane: { kind: 'plane', plane, offset: between(r[1], -10, 10) },
              center: [between(r[2], -20, 20), between(r[3], -20, 20)],
              width: between(r[4], 5, 80),
              opacity: between(r[5], 0.1, 1, 0.05),
            });
            if ((r[6] ?? 0) < 0.5) {
              // The insert stays committed when the calibration is refused.
              await this.call('image.calibrate', {
                featureId: inserted.featureId,
                a: [0, 0],
                b: [between(r[7], 1, 20), 0],
                distance: between(r[6], 1, 40),
              }).catch(refusedOnly);
            }
          },
          undoable: false,
        };
      }
      case 'sketchPattern': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        const curves = ((sketch.params.entities as { id: string; kind: string }[]) ?? []).filter(
          (e) => e.kind === 'circle' || e.kind === 'line',
        );
        const curve = pick(curves, r[1]);
        if (!curve) return null;
        return {
          label: `sketch.pattern ${sketch.id} ${curve.id} (+ editPattern)`,
          run: async () => {
            const made = await this.call<{ patternId: string }>('sketch.pattern', {
              featureId: sketch.id,
              ids: [curve.id],
              count: 2 + Math.floor((r[2] ?? 0) * 2),
              spacing: between(r[3], 2, 20),
              ...((r[4] ?? 0) < 0.5 ? { count2: 2, spacing2: between(r[5], 2, 20) } : {}),
            });
            if ((r[6] ?? 0) < 0.5) {
              await this.call('sketch.editPattern', {
                featureId: sketch.id,
                patternId: made.patternId,
                count: 2 + Math.floor((r[7] ?? 0) * 3),
              }).catch(refusedOnly);
            }
          },
          undoable: false,
        };
      }
      case 'sketchOffset': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        const curves = ((sketch.params.entities as { id: string; kind: string }[]) ?? []).filter(
          (e) => e.kind !== 'point' && e.kind !== 'text',
        );
        const curve = pick(curves, r[1]);
        if (!curve) return null;
        return this.api('sketch.offset', {
          featureId: sketch.id,
          ids: [curve.id],
          distance: between(r[2], 0.5, 5),
          side: pick(['outside', 'inside'] as const, r[3])!,
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
        else if (feature.kind === 'draft' && typeof p.angle === 'number')
          params = { angle: Math.max(-45, Math.min(45, round(p.angle * scale, 6))) || 1 };
        else if (
          (feature.kind === 'thicken' || feature.kind === 'rib') &&
          typeof p.thickness === 'number'
        )
          params = { thickness: round(p.thickness * scale, 6) };
        else if (feature.kind === 'sweep' || feature.kind === 'loft')
          params = { operation: pick(['new', 'join', 'cut'], r[2]) };
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
      case 'sweep': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        const regions = await this.regionsOf(sketch.id);
        const region = pick(regions, r[1]);
        if (!region) return null;
        const bodies = await this.bodies();
        const operation =
          bodies.length === 0 ? 'new' : pick(['new', 'new', 'join', 'cut'] as const, r[2])!;
        const target = operation === 'new' ? undefined : pick(bodies, r[3])?.id;
        let path: Json;
        const other = pick(
          (await sketches()).filter((s) => s.id !== sketch.id),
          r[4],
        );
        const otherRegion = other ? pick(await this.regionsOf(other.id), r[5]) : undefined;
        if ((r[6] ?? 0) < 0.3 && other && otherRegion) {
          path = { kind: 'sketch', featureId: other.id, region: otherRegion.key };
        } else {
          // A straight path from the sketch origin along its normal, tilted along u at random.
          const frame = await this.frameOf(sketch.id);
          if (!frame) return null;
          const length = between(r[6], 2, 30);
          const tilt = between(r[7], -0.6, 0.6, 0.1);
          path = {
            kind: 'line',
            start: frame.origin,
            end: frame.origin.map((v, i) =>
              round(v + (frame.normal[i]! + tilt * frame.u[i]!) * length, 6),
            ),
          };
        }
        return this.api('feature.create', {
          kind: 'sweep',
          params: {
            profile: { kind: 'sketch', featureId: sketch.id, regions: [region.key] },
            path,
            operation,
            ...(target ? { targetBodyId: target } : {}),
          },
        });
      }
      case 'loft': {
        const all = (await sketches()).filter(
          (s) => (s.params.plane as { kind?: string } | undefined)?.kind !== 'face',
        );
        const a = pick(all, r[0]);
        const b = pick(
          all.filter((s) => s.id !== a?.id),
          r[1],
        );
        if (!a || !b) return null;
        const ra = pick(await this.regionsOf(a.id), r[2]);
        const rb = pick(await this.regionsOf(b.id), r[3]);
        if (!ra || !rb) return null;
        const bodies = await this.bodies();
        const operation =
          bodies.length === 0 ? 'new' : pick(['new', 'new', 'join', 'cut'] as const, r[4])!;
        const target = operation === 'new' ? undefined : pick(bodies, r[5])?.id;
        return this.api('feature.create', {
          kind: 'loft',
          params: {
            profiles: [
              { kind: 'sketch', featureId: a.id, regions: [ra.key] },
              { kind: 'sketch', featureId: b.id, regions: [rb.key] },
            ],
            ruled: (r[6] ?? 0) < 0.4,
            operation,
            ...(target ? { targetBodyId: target } : {}),
          },
        });
      }
      case 'draft': {
        const body = await bodyId(r[0]);
        if (!body) return null;
        const faces = await this.call<FaceSummary[]>('faces.list', { bodyId: body });
        const face = pick(
          faces.filter((f) => f.surface === 'plane' || f.surface === 'cylinder'),
          r[1],
        );
        if (!face) return null;
        const neutralFace = pick(
          faces.filter((f) => f.surface === 'plane' && f.key !== face.key),
          r[2],
        );
        const neutral =
          (r[3] ?? 0) < 0.5 && neutralFace
            ? { kind: 'face', face: { bodyId: body, key: neutralFace.key } }
            : { kind: 'plane', plane: pick(planes, r[4])!, offset: between(r[5], -10, 10) };
        return this.api('feature.create', {
          kind: 'draft',
          params: {
            faces: [{ bodyId: body, key: face.key }],
            neutral,
            angle: between(r[6], -20, 20, 0.5) || 3,
            flip: (r[7] ?? 0) < 0.3,
          },
        });
      }
      case 'openPolyline': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        const x = between(r[1], -20, 15);
        const y = between(r[2], -20, 15);
        const points =
          (r[3] ?? 0) < 0.5
            ? [
                [x, y],
                [x + between(r[4], -15, 15), y + between(r[5], -15, 15)],
              ]
            : [
                [x, y],
                [x + between(r[4], 2, 15), y],
                [x + between(r[4], 2, 15), y + between(r[5], 2, 15)],
              ];
        return this.api('sketch.addPolyline', {
          featureId: sketch.id,
          points,
          closed: false,
          construction: (r[6] ?? 0) < 0.15,
        });
      }
      case 'rib': {
        const sketch = pick(
          (await sketches()).filter((s) =>
            ((s.params.entities as { kind: string }[] | undefined) ?? []).some(
              (e) => e.kind === 'line',
            ),
          ),
          r[0],
        );
        if (!sketch) return null;
        const lines = (sketch.params.entities as { id: string; kind: string }[]).filter(
          (e) => e.kind === 'line',
        );
        const first = pick(lines, r[1])!;
        const second = (r[2] ?? 0) < 0.3 ? pick(lines, r[3]) : undefined;
        const target = await bodyId(r[4]);
        return this.api('feature.create', {
          kind: 'rib',
          params: {
            sketchId: sketch.id,
            entityIds: second && second.id !== first.id ? [first.id, second.id] : [first.id],
            thickness: between(r[5], 0.4, 5, 0.1),
            flip: (r[6] ?? 0) < 0.4,
            ...(target && (r[7] ?? 0) < 0.5 ? { targetBodyId: target } : {}),
          },
        });
      }
      case 'thicken': {
        const bodies = await this.bodies();
        const operation =
          bodies.length === 0 ? 'new' : pick(['new', 'new', 'join', 'cut'] as const, r[0])!;
        const target = operation === 'new' ? undefined : pick(bodies, r[1])?.id;
        let source: Json | null = null;
        if ((r[2] ?? 0) < 0.6) {
          const body = await bodyId(r[3]);
          const face = body
            ? pick(await this.call<FaceSummary[]>('faces.list', { bodyId: body }), r[4])
            : undefined;
          if (body && face) source = { kind: 'faces', faces: [{ bodyId: body, key: face.key }] };
        } else {
          const sketch = pick(await sketches(), r[3]);
          if (sketch)
            source = { kind: 'profile', profile: { kind: 'sketch', featureId: sketch.id } };
        }
        if (!source) return null;
        return this.api('feature.create', {
          kind: 'thicken',
          params: {
            source,
            thickness: between(r[5], 0.3, 5, 0.1),
            direction: pick(['outside', 'inside', 'both'] as const, r[6])!,
            operation,
            ...(target ? { targetBodyId: target } : {}),
          },
        });
      }
      case 'text': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        return this.api('sketch.addText', {
          featureId: sketch.id,
          text: pick(['HC', 'A', '8', 'Ag 1', 'O-ring', '%'], r[1])!,
          position: [between(r[2], -20, 10), between(r[3], -20, 10)],
          height: between(r[4], 1, 12),
          ...((r[5] ?? 0) < 0.3 ? { angle: between(r[6], -90, 90, 15) } : {}),
        });
      }
      case 'constructionPlane': {
        const kind = pick(['offset', 'offset', 'angle', 'midplane', 'threePoints'] as const, r[0])!;
        const body = await bodyId(r[1]);
        const faces = body ? await this.planarFaces(body) : [];
        const face = pick(faces, r[2]);
        const base =
          face && (r[3] ?? 0) < 0.5
            ? { kind: 'face', face: { bodyId: body, key: face.key } }
            : { kind: 'plane', plane: pick(planes, r[4])!, offset: between(r[5], -10, 10) };
        let definition: Json;
        if (kind === 'offset') {
          definition = { kind, base, distance: between(r[6], -25, 25) };
        } else if (kind === 'angle') {
          definition = {
            kind,
            base: { kind: 'plane', plane: pick(planes, r[4])!, offset: 0 },
            axis: { kind: 'world', axis: pick(['X', 'Y', 'Z'] as const, r[6])! },
            angle: between(r[7], -80, 80, 5),
          };
        } else if (kind === 'midplane') {
          const plane = pick(planes, r[4])!;
          definition = {
            kind,
            a: { kind: 'plane', plane, offset: between(r[5], -20, 0) },
            b: { kind: 'plane', plane, offset: between(r[6], 0, 20) },
          };
        } else {
          definition = {
            kind,
            points: [
              { kind: 'point', point: [0, 0, between(r[5], -5, 5)] },
              { kind: 'point', point: [between(r[6], 5, 20), 0, 0] },
              { kind: 'point', point: [0, between(r[7], 5, 20), between(r[4], -5, 5)] },
            ],
          };
        }
        return this.api('feature.create', {
          kind: 'constructionPlane',
          params: { definition, flip: (r[7] ?? 0) < 0.2 },
        });
      }
      case 'sketchOnConstruction': {
        const plane = pick(
          (await this.features()).filter((f) => f.kind === 'constructionPlane'),
          r[0],
        );
        if (!plane) return null;
        return this.api('feature.create', {
          kind: 'sketch',
          params: {
            plane: { kind: 'construction', featureId: plane.id },
            profiles: [shape(r[3], r[4], r[5])],
          },
        });
      }
      case 'extrudeExtent': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        const bodies = await this.bodies();
        const operation =
          bodies.length === 0 ? 'new' : pick(['new', 'join', 'cut', 'cut'] as const, r[1])!;
        const target = operation === 'new' ? undefined : pick(bodies, r[2])?.id;
        const mode = pick(['throughAll', 'toObject', 'twoSides', 'startOffset'] as const, r[3])!;
        const distance = between(r[4], 1, 20) * ((r[5] ?? 0) < 0.35 ? -1 : 1);
        let extra: Json = {};
        if (mode === 'throughAll') extra = { extent: { kind: 'throughAll' } };
        else if (mode === 'toObject') {
          const body = pick(bodies, r[6]);
          if (!body) return null;
          const face = (r[7] ?? 0) < 0.5 ? pick(await this.planarFaces(body.id), r[6]) : undefined;
          extra = {
            extent: {
              kind: 'toObject',
              target: face
                ? { kind: 'face', face: { bodyId: body.id, key: face.key } }
                : { kind: 'body', bodyId: body.id },
            },
          };
        } else if (mode === 'twoSides') extra = { distance2: between(r[6], 0, 12) };
        else extra = { startOffset: between(r[6], -8, 8) };
        return this.api('feature.create', {
          kind: 'extrude',
          params: {
            profile: { kind: 'sketch', featureId: sketch.id },
            distance,
            operation,
            ...(target ? { targetBodyId: target } : {}),
            ...extra,
          },
        });
      }
      case 'exchangeStep':
      case 'exchangeIges': {
        const bodies =
          await this.call<{ id: string; valid: boolean; volume: number }[]>('bodies.list');
        const chosen = (r[0] ?? 0) < 0.5 ? bodies : [pick(bodies, r[1])].filter((b) => b);
        if (chosen.length === 0) return null;
        const format = op.op === 'exchangeStep' ? 'step' : 'iges';
        const exportParams: Json = {
          bodyIds: chosen.map((b) => b!.id),
          ...(format === 'iges' ? { mode: (r[2] ?? 0) < 0.5 ? 'faces' : 'brep' } : {}),
        };
        return {
          label: `export.${format} ${JSON.stringify(exportParams)} → import.${format}`,
          run: async () => {
            const exported = await this.call<{ data: string }>(`export.${format}`, exportParams);
            const imported = await this.call<{ createdBodyIds: string[] }>(`import.${format}`, {
              data: exported.data,
              fileName: `fuzz.${format === 'step' ? 'step' : 'igs'}`,
            });
            await this.settle();
            // Exact B-rep round trip: the imported solids hold the exported volume.
            if (chosen.every((b) => b!.valid)) {
              const after =
                await this.call<{ id: string; volume: number; valid: boolean }[]>('bodies.list');
              const created = after.filter((b) => imported.createdBodyIds.includes(b.id));
              // A body the import flags invalid (with a warning) is reported, not silent: IGES
              // surfaces of touching bodies sew into one shell (F10, documented).
              if (created.some((b) => !b.valid)) return;
              const back = created.reduce((s, b) => s + Math.abs(b.volume), 0);
              const sent = chosen.reduce((s, b) => s + Math.abs(b!.volume), 0);
              if (Math.abs(back - sent) > 1e-3 * Math.max(1, sent)) {
                fail(
                  'roundTrip',
                  `${format.toUpperCase()} export → import changed the volume: ${sent} → ${back} mm³`,
                );
              }
            }
          },
          undoable: !this.session.transactionOpen,
        };
      }
      case 'exchangeDxf': {
        const sketch = pick(await sketches(), r[0]);
        if (!sketch) return null;
        const regions = await this.regionsOf(sketch.id);
        const plane = pick(planes, r[1])!;
        return {
          label: `export.dxf ${sketch.id} → import.dxf ${plane}`,
          run: async () => {
            const exported = await this.call<{ data: string }>('export.dxf', {
              sketchId: sketch.id,
              version: (r[2] ?? 0) < 0.3 ? 'R12' : 'R2000',
              includeConstruction: false,
            });
            const imported = await this.call<{ featureId: string; approximated?: number }>(
              'import.dxf',
              {
                data: exported.data,
                fileName: 'fuzz.dxf',
                plane,
                offset: between(r[3], -10, 10),
              },
            );
            await this.settle();
            // The drawing comes back with the same closed regions (same total area) unless
            // curves had to be approximated, or the sketch has text: DXF carries glyph outlines as
            // plain curves, so a glyph's counter (the hole of "A", "g") becomes a region of its
            // own on import (by design, `assembler/ROBUSTNESS.md` finding D1).
            if ((imported.approximated ?? 0) > 0) return;
            if (
              ((sketch.params.entities as { kind: string }[] | undefined) ?? []).some(
                (e) => e.kind === 'text',
              )
            ) {
              return;
            }
            const back = await this.regionsOf(imported.featureId);
            const area = (list: { area?: number }[]) =>
              list.reduce((s, x) => s + Math.abs(x.area ?? 0), 0);
            if (Math.abs(area(back) - area(regions)) > 1e-3 * Math.max(1, area(regions))) {
              fail(
                'roundTrip',
                `DXF export → import changed the regions of ${sketch.id}: ${regions.length} regions / ${area(regions)} mm² → ${back.length} / ${area(back)} mm²`,
              );
            }
          },
          undoable: !this.session.transactionOpen,
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
    // Module fields (reference-image pictures) survive the round trip too.
    const again = await this.call<{ text: string }>('project.save');
    const images = (text: string) => (JSON.parse(text) as { images?: unknown }).images ?? null;
    const d4 = firstDifference(images(again.text), images(saved.text));
    if (d4) fail('saveReopen', `reopened images differ: ${d4}`);
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

  private async checkDocument(): Promise<void> {
    const { features } = this.store.getState();
    const ids = new Set<string>();
    for (const f of features) {
      if (ids.has(f.id)) fail('uniqueIds', `duplicate feature id ${f.id}`);
      ids.add(f.id);
    }
    // OCCT object arenas must never be closed out of order (interleaved kernel users), in the
    // fuzzed kernel's thread or a reference kernel's.
    const interleavings =
      (await this.kernel.arenaInterleavings()) +
      this.referenceInterleavings +
      ((await this.reference?.kernel.arenaInterleavings()) ?? 0);
    if (interleavings !== 0) {
      fail('arenaOrder', `${interleavings} OCCT arena(s) closed out of order`);
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
    // A cold evaluation (fresh evaluator, empty caches) on the fuzzed kernel's own, long-lived
    // OCCT instance: if it agrees with the incremental result, two cold evaluations of the same
    // document on two instances disagree — the kernel's heap state, not the cache (F6).
    const onMain = evaluationSignature(await this.coldEvaluateOnMain(active));
    if (!firstDifference(incremental, onMain)) {
      this.marginal.push(`instance dependent (cold on the fuzzed instance agrees): ${d}`);
      return;
    }
    // A fresh evaluator that reaches the document the way the session did — the last step
    // evaluated on a checkpoint of the steps before it — gives the incremental result: the
    // same calls in another order make OCCT build different topology (F11: a no-op cut's
    // `SimplifyResult` kept a slit edge once instead of twice). Not a cache bug either.
    if (active.length > 1) {
      const staged = evaluationSignature(await this.coldEvaluateOnMain(active, true));
      if (!firstDifference(incremental, staged)) {
        this.marginal.push(`evaluation-order dependent (prefix, then the last step agrees): ${d}`);
        return;
      }
    }
    fail('determinism', `incremental ≠ cold evaluation: ${d}`);
  }

  /** Cold evaluation with a fresh evaluator on the fuzzed kernel's OCCT instance (store settled). */
  private async coldEvaluateOnMain(features: Feature[], staged = false): Promise<EvaluationResult> {
    await this.settle();
    // `staged`: the steps before the last one first, so the last one starts from a checkpoint.
    return (await this.kernel.evaluateFresh(features, { staged })).result;
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
          } else if (error instanceof ApiError && error.code === 'kernelTimeout') {
            fail('kernelTimeout', `${resolved.label.slice(0, 160)}: ${error.message}`);
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
          // A UI edit (History reorder/rollback) during an agent transaction is the user's own
          // change: cancel must drop the staged writes, not undo the user (the commit would
          // report `conflict`). The baseline moves with it.
          const uiEditInTx = (op.op === 'reorder' || op.op === 'rollback') && txBase !== null;
          if (op.op === 'txBegin' || uiEditInTx) {
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

        await this.checkDocument();
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
        // A kernel job that ran out of time (a fuzzed write: ApiError `kernelTimeout`; a cold
        // evaluation: KernelTimeoutError) is its own finding class (F13), not an exception.
        const timeout = !(error instanceof InvariantError) && isKernelTimeout(error);
        const invariant =
          error instanceof InvariantError
            ? error.invariant
            : timeout
              ? 'kernelTimeout'
              : 'exception';
        const message =
          error instanceof InvariantError || timeout
            ? (error as Error).message
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
