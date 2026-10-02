/**
 * Interactive-latency harness (`pnpm --filter @himmelcad/assembler
 * bench:interactive`). Replays the Block-5 demo interactions through the
 * app's stores in Node — real planeGCS solver and real OCCT kernel, both
 * in-process — and breaks every step down by stage:
 *
 * (a) Enclosure template → sketch on the lid top → text "HC" → leave the
 *     sketch → Emboss tool (preview) → Engrave −1 mm (preview) → Done;
 * (b) Hole tool on the enclosure floor: click a position, M4, counterbore
 *     (previews) → Done;
 * (c) fillet drag on the demo bracket (successive preview radii);
 * (d) a 60-entity sketch, dragging one point (solver only);
 * (e) the orbit/zoom pivot's CPU part (`orbitPivot.ts` rules on a 64 × 64
 *     depth window around a bore, plus the ray math), once per gesture — the
 *     GPU read of that window is measured in the app (DEV probe `pivotAt`,
 *     assembler/SELECTION-NAVIGATION.md); Block 9 adds rule "nearest" on a
 *     240 × 135 coarse map of the whole view;
 * (f) a parameter slider driving the demo bracket's fillet: each drag step
 *     until its live preview shows, then the release's commit;
 * (g) stored checks: their evaluation, and the fillet drag of (c) with
 *     checks and the background runner on (assembler/CHECKS.md).
 *
 * Stages per step: wall time until the stores settle; `ui` = the synchronous
 * main-thread work a React render of the adaptive toolbar and the command
 * search does for the new state (every command's availability — what froze
 * the browser in the demo); solver time; region detection of the step's
 * sketch; kernel time split into the feature itself, validity, naming
 * (describe + history), tessellation and prefix-cache reuse. The
 * printability re-analysis runs in its own worker, debounced; its cost is
 * listed separately (`print`) and is never on the path of a step.
 *
 * `--json` prints machine-readable rows; `--browser` also replays the
 * scenarios in Chromium against a Vite dev server (`interactiveBrowser.ts`),
 * with the CAD kernel and the solver in their Web Workers
 * (`--only-browser`: that part alone); `--runs n` (default 3).
 */
import { loadOcct, selectedOcctModule, type OpenCascadeModule } from '../../headless/occtModule.js';
import { InProcessKernelAdapter } from '../../renderer/src/foundation/geometry-kernel/adapter.js';
import {
  createEvaluator,
  type KernelEvaluator,
} from '../../renderer/src/foundation/geometry-kernel/evaluator.js';
import type { EvaluationResult } from '../../renderer/src/foundation/geometry-kernel/types.js';
import {
  resolveAdaptive,
  searchCommands,
  findCommand,
} from '../../renderer/src/foundation/commands/registry.js';
import { frameUv } from '../../renderer/src/foundation/document/document.js';
import { createDemoDocument } from '../../renderer/src/foundation/commands/demoDocument.js';

import { acceptPick, draftBadges } from '../../renderer/src/foundation/commands/featureDrafts.js';
import { useProjectStore } from '../../renderer/src/interface/shell-ui/project/projectStore.js';
import { isPreviewTool, useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import {
  analyzePrintability,
  bodyToPrintInput,
} from '../../renderer/src/modules/print/analysis.js';
import { DEFAULT_PRINT_SETTINGS } from '../../renderer/src/modules/print/settings.js';
import { hitTest, infer } from '../../renderer/src/modules/sketching/inference.js';
import { detectRegions } from '../../renderer/src/foundation/sketch-solver/regions.js';
import { useSketchStore } from '../../renderer/src/modules/sketching/session.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { segmentStart } from '../../renderer/src/modules/sketching/tools.js';
import type { SketchData, Vec2 } from '../../renderer/src/foundation/sketch-solver/types.js';
import { installNodeFonts } from '../sketch/nodeFont.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';
import { sixtyEntitySketch } from './parts.js';
import {
  DEFAULT_POSE,
  pointAtViewDepth,
  viewProjectionMatrix,
  type CameraPose,
} from '../../renderer/src/platform/viewport/camera.js';
import { unprojectRay } from '../../renderer/src/platform/viewport/math.js';
import { newStoredCheck } from '../../renderer/src/foundation/commands/checks.js';
import type { StoredCheck } from '../../renderer/src/foundation/document/checks.js';
import {
  runChecksNow,
  setChecksKernel,
  startChecksRunner,
  useCheckResults,
} from '../../renderer/src/modules/checks/index.js';
import {
  nearestPivotDepth,
  pivotDepth,
  type DepthProjection,
} from '../../renderer/src/platform/viewport/orbitPivot.js';

type OpenCascade = OpenCascadeModule;

// ---- instrumentation ------------------------------------------------------------------------

interface KernelEntry {
  ms: number;
  quality: string;
  stats: EvaluationResult['stats'];
}
const kernelLog: KernelEntry[] = [];
const solverLog: number[] = [];

let oc: OpenCascade | null = null;
let kernelLoadMs = 0;

async function loadKernel(): Promise<KernelEvaluator> {
  const t0 = performance.now();
  // The module chosen by HIMMELCAD_OCCT (`headless/occtModule.ts`), like the tests and bench:kernel.
  oc ??= await loadOcct();
  kernelLoadMs = performance.now() - t0;
  const evaluator = createEvaluator(oc);
  return {
    ...evaluator,
    evaluate: async (features, options = {}) => {
      const t = performance.now();
      const result = await evaluator.evaluate(features, { ...options, profile: true });
      kernelLog.push({
        ms: performance.now() - t,
        quality: options.quality ?? 'final',
        stats: result.stats,
      });
      return result;
    },
  };
}

const kernel = new InProcessKernelAdapter(loadKernel);
useAssemblerStore.getState().attachKernel(kernel);
useProjectStore.getState().attachKernelAdapter(kernel);
setSketchSolverFactory(() => ({
  solve: async (request) => {
    const result = await (await loadNodeSolver()).solve(request);
    solverLog.push(result.ms);
    return result;
  },
}));
installNodeFonts();

const store = useAssemblerStore;
const sketch = useSketchStore;

async function settle(): Promise<void> {
  await sketch.getState().whenIdle();
  await store.getState().whenSettled();
}

// ---- rows -----------------------------------------------------------------------------------

export interface StepRow {
  scenario: string;
  step: string;
  wallMs: number;
  /** Synchronous toolbar + command-search availability for the settled state (main thread). */
  uiMs: number;
  solverMs: number;
  regionsMs: number;
  kernelMs: number;
  featureMs: number;
  validityMs: number;
  namingMs: number;
  tessellateMs: number;
  /** Features restored from the prefix cache / evaluated. */
  reused: number;
  evaluated: number;
  /** Printability analysis of the result (worker, debounced; informational). */
  printMs: number | null;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function phase(entries: KernelEntry[], pick: (name: string) => boolean): number {
  return sum(
    entries.map((e) =>
      sum(
        Object.entries(e.stats.phases ?? {})
          .filter(([name]) => pick(name))
          .map(([, v]) => v),
      ),
    ),
  );
}

function uiCost(): number {
  const state = store.getState();
  const t0 = performance.now();
  resolveAdaptive(state);
  searchCommands('', state);
  return performance.now() - t0;
}

function regionCost(data: Pick<SketchData, 'entities'> | null): number {
  if (!data) return 0;
  const t0 = performance.now();
  detectRegions(data);
  return performance.now() - t0;
}

function printCost(evaluation: EvaluationResult | null): number | null {
  if (!evaluation || evaluation.bodies.length === 0) return null;
  const t0 = performance.now();
  analyzePrintability(evaluation.bodies.map(bodyToPrintInput), DEFAULT_PRINT_SETTINGS);
  return performance.now() - t0;
}

/** The evaluation a step produced: the tool preview if one is showing, else the document. */
function shownEvaluation(): EvaluationResult {
  const state = store.getState();
  const tool = state.activeTool;
  return (isPreviewTool(tool) ? tool.previewEvaluation : null) ?? state.evaluation;
}

async function step(
  scenario: string,
  label: string,
  run: () => Promise<void> | void,
  options: { sketchData?: () => Pick<SketchData, 'entities'> | null; print?: boolean } = {},
): Promise<StepRow> {
  kernelLog.length = 0;
  solverLog.length = 0;
  const t0 = performance.now();
  await run();
  await settle();
  const wallMs = performance.now() - t0;
  const k = [...kernelLog];
  const solverMs = sum(solverLog);
  const uiMs = uiCost();
  return {
    scenario,
    step: label,
    wallMs: wallMs + uiMs,
    uiMs,
    solverMs,
    regionsMs: regionCost(options.sketchData?.() ?? null),
    kernelMs: sum(k.map((e) => e.ms)),
    featureMs: phase(k, (n) => n.startsWith('feature:')),
    validityMs: phase(k, (n) => n === 'validity'),
    namingMs: phase(k, (n) => n === 'describe' || n === 'history'),
    tessellateMs: sum(k.map((e) => e.stats.tessellateMs)),
    reused: sum(k.map((e) => e.stats.reusedFeatures ?? 0)),
    evaluated: sum(k.map((e) => e.stats.evaluatedFeatures ?? 0)),
    printMs: options.print ? printCost(shownEvaluation()) : null,
  };
}

// ---- scenarios ------------------------------------------------------------------------------

function topFace(bodyName: string) {
  const body = store.getState().evaluation.bodies.find((b) => b.name === bodyName);
  if (!body) throw new Error(`no body ${bodyName}`);
  const face = body.faces
    .filter((f) => f.normal && f.normal[2] > 0.99)
    .sort((a, b) => b.centroid[2] - a.centroid[2])[0];
  if (!face) throw new Error(`no top face on ${bodyName}`);
  return { body, face };
}

async function loadEnclosure(): Promise<void> {
  if (sketch.getState().session) sketch.getState().discard();
  store.getState().cancel();
  const ok = await useProjectStore.getState().newFromTemplate('enclosure');
  if (!ok) throw new Error('enclosure template failed');
  await settle();
}

/** (a) text "HC" on the lid, engraved 1 mm (a2: a longer label, 11 glyph profiles). */
async function scenarioText(
  depth: number,
  label: { text: string; height: number; shift: number } = { text: 'HC', height: 9, shift: 0 },
): Promise<StepRow[]> {
  const rows: StepRow[] = [];
  const s = label.text === 'HC' ? 'a text + engrave' : `a2 label "${label.text}"`;
  await loadEnclosure();
  const { body: lid, face: top } = topFace('Lid');
  const session = () => sketch.getState().session?.sketch ?? null;
  rows.push(
    await step(s, 'select lid top face', () => {
      store.getState().select({ kind: 'face', bodyId: lid.id, faceKey: top.key });
    }),
  );
  rows.push(
    await step(s, 'Text tool on the face (K)', () => {
      sketch.getState().begin({ face: { bodyId: lid.id, faceKey: top.key }, tool: 'text' });
    }),
  );
  const frame = sketch.getState().session!.frame;
  const { u, v } = frameUv(frame, top.centroid);
  const raw: Vec2 = [u - label.shift, v];
  rows.push(
    await step(s, 'click the text anchor', async () => {
      const current = sketch.getState().session!;
      const from = segmentStart(current.sketch, current.tool);
      const snap = infer(current.sketch, raw, {
        mmPerPx: 0.1,
        ...(from ? { from } : {}),
        gridStep: null,
      });
      await sketch
        .getState()
        .dispatch({ type: 'click', snap, hit: hitTest(current.sketch, raw, 0.1), raw });
    }),
  );
  rows.push(
    await step(
      s,
      `place text "${label.text}" (solved)`,
      async () => {
        sketch.getState().setToolOption({ text: label.text, height: label.height });
        if (!(await sketch.getState().commitText())) throw new Error('text not placed');
      },
      { sketchData: session },
    ),
  );
  const sketchId = sketch.getState().session!.featureId;
  const sketchData = () => {
    const f = store.getState().features.find((x) => x.id === sketchId);
    return f?.kind === 'sketch' ? f : null;
  };
  rows.push(
    await step(
      s,
      'leave the sketch (Esc)',
      async () => {
        for (let i = 0; i < 5 && sketch.getState().session; i += 1) {
          sketch.getState().escape();
          await settle();
        }
      },
      { sketchData },
    ),
  );
  const { face: top2 } = topFace('Lid');
  rows.push(
    await step(s, 'select profile + face', () => {
      const state = store.getState();
      state.select({ kind: 'sketchProfile', featureId: sketchId });
      state.select({ kind: 'face', bodyId: lid.id, faceKey: top2.key }, { additive: true });
    }),
  );
  rows.push(
    await step(
      s,
      'Emboss tool (preview +1 mm)',
      () => {
        findCommand('tools.emboss')!.run(store.getState());
      },
      { print: true },
    ),
  );
  rows.push(
    await step(
      s,
      'Engrave preview (−1 mm)',
      () => {
        store.getState().updateFeatureDraft((d) => (d.kind === 'emboss' ? { ...d, depth } : d));
      },
      { print: true },
    ),
  );
  rows.push(
    await step(
      s,
      'Engrave commit (Done)',
      () => {
        store.getState().commit();
      },
      { print: true },
    ),
  );
  const errors = store.getState().evaluation.errors;
  if (Object.keys(errors).length > 0) throw new Error(`engrave failed: ${JSON.stringify(errors)}`);
  return rows;
}

/** (b) M4 counterbore hole on the enclosure floor. */
async function scenarioHole(x: number): Promise<StepRow[]> {
  const rows: StepRow[] = [];
  const s = 'b hole M4 cbore';
  await loadEnclosure();
  const enclosure = store.getState().evaluation.bodies.find((b) => b.name === 'Enclosure')!;
  const floor = enclosure.faces.find((f) => f.normal && f.normal[2] < -0.99)!;
  rows.push(
    await step(s, 'select floor face', () => {
      store.getState().select({ kind: 'face', bodyId: enclosure.id, faceKey: floor.key });
    }),
  );
  rows.push(
    await step(
      s,
      'Hole tool (preview at the centre)',
      () => {
        findCommand('tools.hole')!.run(store.getState());
      },
      { print: true },
    ),
  );
  rows.push(
    await step(
      s,
      'click a position (preview)',
      () => {
        store
          .getState()
          .updateFeatureDraft((draft, evaluation) =>
            acceptPick(
              draft,
              { kind: 'face', bodyId: enclosure.id, faceKey: floor.key, point: [x, 30, 0] },
              evaluation,
            ),
          );
      },
      { print: true },
    ),
  );
  const badge = (label: string, value: string) =>
    store.getState().updateFeatureDraft((d, ev) =>
      draftBadges(d)
        .find((b) => b.ariaLabel === label)!
        .apply(d, value, ev),
    );
  rows.push(await step(s, 'size M4 (preview)', () => badge('Hole size', 'M4'), { print: true }));
  rows.push(
    await step(s, 'counterbore (preview)', () => badge('Hole type', 'counterbore'), {
      print: true,
    }),
  );
  rows.push(
    await step(
      s,
      'Hole commit (Done)',
      () => {
        store.getState().commit();
      },
      { print: true },
    ),
  );
  const errors = store.getState().evaluation.errors;
  if (Object.keys(errors).length > 0) throw new Error(`hole failed: ${JSON.stringify(errors)}`);
  return rows;
}

/** (c) fillet drag on the demo bracket: `steps` successive preview radii. */
async function scenarioFillet(steps: number): Promise<StepRow[]> {
  const s = 'c fillet drag';
  store.getState().cancel();
  store.getState().loadDocument(createDemoDocument());
  await settle();
  const body = store.getState().evaluation.bodies[0]!;
  // The plate's top front edge (a straight edge at z = 6, y = 0).
  const edge = body.edges.find(
    (e) =>
      e.curve === 'line' && Math.abs(e.midpoint[2] - 6) < 1e-6 && Math.abs(e.midpoint[1]) < 1e-6,
  );
  if (!edge) throw new Error('no plate edge on the demo bracket');
  store.getState().select({ kind: 'edge', bodyId: body.id, edgeKey: edge.key });
  const rows: StepRow[] = [];
  rows.push(
    await step(s, 'Fillet tool (first preview)', () => store.getState().beginEdgeBlend('fillet')),
  );
  for (let i = 0; i < steps; i += 1) {
    const r = 1 + i * 0.137;
    rows.push(await step(s, 'drag step (preview)', () => store.getState().setBlendSize(r)));
  }
  store.getState().cancel();
  await settle();
  return rows;
}

/**
 * (f) Block 9: a parameter slider on the demo bracket — `r` drives the
 * fillet; each drag step plans the value (like an edit) and evaluates it on
 * the kernel's preview channel (incremental, preview tessellation) until the
 * live preview shows it; release commits one undo step.
 */
async function scenarioParameterSlider(steps: number): Promise<StepRow[]> {
  const s = 'f parameter slider';
  store.getState().cancel();
  store.getState().loadDocument(createDemoDocument());
  await settle();
  const created = await store
    .getState()
    .upsertParameter({ name: 'r', unit: 'mm', value: 4, min: 1, max: 12, step: 0.5 });
  if (!created.ok) throw new Error(created.message);
  const fillet = store.getState().features.find((f) => f.kind === 'fillet')!;
  store.getState().editFeatureParams(fillet.id, { radiusExpression: 'r' } as never);
  await settle();
  const sliderIdle = async () => {
    for (let i = 0; i < 2000 && (store.getState().parameterSlider?.pending ?? false); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const rows: StepRow[] = [];
  for (let i = 1; i <= steps; i += 1) {
    const value = 4 + i * 0.5;
    rows.push(
      await step(s, 'drag step (live preview)', async () => {
        store.getState().previewParameterValue(created.id, value);
        await sliderIdle();
        if (!store.getState().documentPreview) throw new Error('no slider preview');
      }),
    );
  }
  rows.push(
    await step(s, 'release (commit, one undo step)', async () => {
      const outcome = await store.getState().endParameterPreview(true);
      if (!outcome?.ok) throw new Error(outcome && !outcome.ok ? outcome.message : 'no commit');
    }),
  );
  return rows;
}

/**
 * (g) stored checks (Block 9): what evaluating them costs (background, off
 * the edit path) and that an edit with checks and the background runner on
 * is as fast as (c) without them — the runner never runs while a tool or a
 * drag is active and starts debounced after the rebuild.
 */
async function scenarioChecks(steps: number): Promise<StepRow[]> {
  const s = 'g checks';
  const rows: StepRow[] = [];
  setChecksKernel(kernel);
  startChecksRunner(kernel);
  // The enclosure template with six checks: one of each cost class and both clearance forms.
  await loadEnclosure();
  const ev = store.getState().evaluation;
  const enclosure = ev.bodies.find((b) => b.name === 'Enclosure')!;
  const lid = ev.bodies.find((b) => b.name === 'Lid')!;
  const top = (id: string) => ({ kind: 'face', face: { bodyId: id, select: '>Z' } });
  const list: StoredCheck[] = [];
  const add = (kind: string, params: Record<string, unknown>) =>
    list.push(newStoredCheck(kind, params, list));
  add('clearance', { a: enclosure.id, b: lid.id, min: 0.2 });
  add('clearance', { min: 0.3 });
  add('distance', { a: top(enclosure.id), b: top(lid.id), min: 20, max: 30 });
  add('volume', { bodies: [enclosure.id], min: 1 });
  add('bodyCount', { min: 2, max: 2 });
  add('length', { target: { kind: 'body', bodyId: lid.id }, quantity: 'height', max: 10 });
  store.getState().commitChecks(list);
  rows.push(await step(s, `evaluate ${list.length} checks (first run)`, () => runChecksNow()));
  rows.push(await step(s, 'evaluate again, nothing changed (reused)', () => runChecksNow()));

  // The demo bracket with four checks and the runner on: the fillet drag of (c), then Done.
  store.getState().cancel();
  store.getState().loadDocument(createDemoDocument());
  await settle();
  const body = store.getState().evaluation.bodies[0]!;
  const demoChecks: StoredCheck[] = [];
  const addDemo = (kind: string, params: Record<string, unknown>) =>
    demoChecks.push(newStoredCheck(kind, params, demoChecks));
  addDemo('volume', { min: 1 });
  addDemo('bodyCount', { min: 1, max: 1 });
  addDemo('length', { target: { kind: 'body', bodyId: body.id }, quantity: 'height', max: 100 });
  addDemo('distance', {
    a: { kind: 'face', face: { bodyId: body.id, select: '>Z' } },
    b: { kind: 'face', face: { bodyId: body.id, select: '<Z' } },
    min: 1,
  });
  store.getState().commitChecks(demoChecks);
  await runChecksNow();
  const edge = body.edges.find(
    (e) =>
      e.curve === 'line' && Math.abs(e.midpoint[2] - 6) < 1e-6 && Math.abs(e.midpoint[1]) < 1e-6,
  );
  if (!edge) throw new Error('no plate edge on the demo bracket');
  store.getState().select({ kind: 'edge', bodyId: body.id, edgeKey: edge.key });
  rows.push(
    await step(s, 'Fillet tool (first preview), runner on', () =>
      store.getState().beginEdgeBlend('fillet'),
    ),
  );
  for (let i = 0; i < steps; i += 1) {
    const r = 1 + i * 0.137;
    rows.push(
      await step(s, 'drag step (preview), runner on', () => store.getState().setBlendSize(r)),
    );
  }
  rows.push(await step(s, 'Fillet commit (Done), runner on', () => store.getState().commit()));
  rows.push(
    await step(s, 'background re-run after the commit (incremental)', () => runChecksNow()),
  );
  const results = Object.values(useCheckResults.getState().results);
  if (results.length !== demoChecks.length || results.some((r) => r.state !== 'pass')) {
    throw new Error(`checks after the fillet: ${JSON.stringify(results.map((r) => r.state))}`);
  }
  store.getState().commitChecks([]);
  return rows;
}

/** (d) a 60-entity sketch (5 rectangles, 10 circles), dragging one rectangle corner. */
async function scenarioSketchDrag(steps: number): Promise<StepRow[]> {
  const s = 'd 60-entity drag';
  store.getState().cancel();
  const { feature, corner } = sixtyEntitySketch();
  store.getState().loadDocument([feature]);
  await settle();
  const rows: StepRow[] = [];
  rows.push(
    await step(s, 'open the sketch (analysis)', () => {
      sketch.getState().begin({ featureId: feature.id });
    }),
  );
  const start = sketch.getState().session!.sketch.entities.find((e) => e.id === corner);
  if (start?.kind !== 'point') throw new Error('corner point');
  sketch.getState().beginDrag([corner]);
  for (let i = 1; i <= steps; i += 1) {
    const target: Vec2 = [start.x + i * 0.31, start.y + i * 0.17];
    rows.push(
      await step(
        s,
        'drag step (solve)',
        () => {
          sketch.getState().drag([target]);
        },
        { sketchData: () => sketch.getState().session?.dragPreview ?? null },
      ),
    );
  }
  rows.push(await step(s, 'drop (commit + analysis)', () => sketch.getState().endDrag()));
  sketch.getState().discard();
  return rows;
}

/**
 * (e) The pivot rules as the viewport runs them at an orbit/wheel start: a
 * 64 × 64 window (device pixels, dpr 1) around a Ø40 px bore in a plate, the
 * cursor in the bore (rule 2 scans the whole window — the worst case), then
 * the cursor ray and the point on it. Perspective and orthographic.
 */
function scenarioPivot(runs: number): StepRow[] {
  const s = 'e orbit pivot';
  const rows: StepRow[] = [];
  const size = 64;
  const make = (projection: DepthProjection) => {
    const z = new Float32Array(size * size);
    const { near: n, far: f } = projection;
    const windowZ = (d: number) =>
      ((projection.orthographic ? (2 * d - f - n) / (f - n) : (f + n - (2 * f * n) / d) / (f - n)) +
        1) /
      2;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
        z[y * size + x] = r < 20 ? Number.NaN : windowZ(100 + (r < 24 ? 8 : 0));
      }
    }
    return z;
  };
  const cases: { label: string; pose: CameraPose; projection: DepthProjection }[] = [
    {
      label: 'pivot rules + ray (64×64 window, perspective)',
      pose: { ...DEFAULT_POSE, fov: 45 },
      projection: { near: 10, far: 1000, orthographic: false },
    },
    {
      label: 'pivot rules + ray (64×64 window, orthographic)',
      pose: { ...DEFAULT_POSE, fov: 0 },
      projection: { near: -500, far: 500, orthographic: true },
    },
  ];
  for (const c of cases) {
    const z = make(c.projection);
    for (let i = 0; i < runs; i += 1) {
      const t0 = performance.now();
      const found = pivotDepth(
        { width: size, height: size, z, cx: size / 2, cy: size / 2, cssPerSample: 1 },
        c.projection,
      );
      const ray = unprojectRay(viewProjectionMatrix(c.pose, 1.6), 640, 400, 1280, 800);
      const point = found && ray ? pointAtViewDepth(c.pose, ray, found.depth) : null;
      const ms = performance.now() - t0;
      if (!point || found?.rule !== 'near') throw new Error('pivot: no point in the bore');
      rows.push(pivotRow(s, c.label, ms));
    }
  }
  // Rule "nearest": a bore wider than the window (the window is empty), so the coarse map of a
  // 1920 × 1080 view (8 px blocks: 240 × 135) is searched for the rim — the CPU part per gesture.
  const projection: DepthProjection = { near: 10, far: 1000, orthographic: false };
  const block = 8;
  const map = {
    width: 240,
    height: 135,
    block,
    offsetY: 1080 - 135 * block,
    z: new Float32Array(240 * 135),
  };
  const windowZ = (d: number) =>
    (projection.far + projection.near - (2 * projection.far * projection.near) / d) /
      (projection.far - projection.near) /
      2 +
    0.5;
  for (let row = 0; row < map.height; row += 1) {
    for (let col = 0; col < map.width; col += 1) {
      const r = Math.hypot(col + 0.5 - 120, row + 0.5 - 67.5);
      map.z[row * map.width + col] = r < 40 ? Number.NaN : r < 90 ? windowZ(100) : Number.NaN;
    }
  }
  const empty = new Float32Array(64 * 64).fill(Number.NaN);
  const pose: CameraPose = { ...DEFAULT_POSE, fov: 45 };
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    const found = pivotDepth(
      { width: 64, height: 64, z: empty, cx: 32, cy: 32, cssPerSample: 1 },
      projection,
    );
    const nearest = found ? null : nearestPivotDepth(map, { x: 960, y: 540 }, projection);
    const ray = unprojectRay(viewProjectionMatrix(pose, 1.6), 640, 400, 1280, 800);
    const point = nearest && ray ? pointAtViewDepth(pose, ray, nearest.depth) : null;
    const ms = performance.now() - t0;
    if (!point || nearest?.rule !== 'nearest') throw new Error('pivot: no rim found');
    rows.push(pivotRow(s, 'nearest rule (empty window + 240×135 coarse map)', ms));
  }
  return rows;
}

function pivotRow(scenario: string, step: string, ms: number): StepRow {
  return {
    scenario,
    step,
    wallMs: ms,
    uiMs: 0,
    solverMs: 0,
    regionsMs: 0,
    kernelMs: 0,
    featureMs: 0,
    validityMs: 0,
    namingMs: 0,
    tessellateMs: 0,
    reused: 0,
    evaluated: 0,
    printMs: null,
  };
}

// ---- report ---------------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length === 0
    ? NaN
    : sorted.length % 2
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function medianRows(runs: StepRow[][]): StepRow[] {
  // Group identical (scenario, step) labels, keep first-seen order.
  const groups = new Map<string, StepRow[]>();
  for (const run of runs) {
    for (const row of run) {
      const key = `${row.scenario}\u0000${row.step}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  }
  return [...groups.values()].map((rows) => {
    const m = (pick: (r: StepRow) => number) => median(rows.map(pick));
    const prints = rows.map((r) => r.printMs).filter((v): v is number => v !== null);
    return {
      scenario: rows[0]!.scenario,
      step: rows.length > 1 ? `${rows[0]!.step} ×${rows.length}` : rows[0]!.step,
      wallMs: m((r) => r.wallMs),
      uiMs: m((r) => r.uiMs),
      solverMs: m((r) => r.solverMs),
      regionsMs: m((r) => r.regionsMs),
      kernelMs: m((r) => r.kernelMs),
      featureMs: m((r) => r.featureMs),
      validityMs: m((r) => r.validityMs),
      namingMs: m((r) => r.namingMs),
      tessellateMs: m((r) => r.tessellateMs),
      reused: m((r) => r.reused),
      evaluated: m((r) => r.evaluated),
      printMs: prints.length > 0 ? median(prints) : null,
    };
  });
}

function fmt(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '–';
  return ms >= 100 ? ms.toFixed(0) : ms.toFixed(1);
}

export function formatRows(rows: StepRow[]): string {
  return [
    '| Scenario | Step | Wall (ms) | UI (ms) | Solver | Regions | Kernel | Feature | Validity | Naming | Tessellation | Prefix reused/evaluated | Print (worker) |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (r) =>
        `| ${r.scenario} | ${r.step} | ${fmt(r.wallMs)} | ${fmt(r.uiMs)} | ${fmt(r.solverMs)} | ${fmt(r.regionsMs)} | ${fmt(r.kernelMs)} | ${fmt(r.featureMs)} | ${fmt(r.validityMs)} | ${fmt(r.namingMs)} | ${fmt(r.tessellateMs)} | ${r.reused}/${r.evaluated} | ${fmt(r.printMs)} |`,
    ),
  ].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const runsIndex = args.indexOf('--runs');
  const runs = runsIndex >= 0 ? Math.max(1, Number(args[runsIndex + 1]) || 3) : 3;
  const onlyBrowser = args.includes('--only-browser');

  let rows: StepRow[] = [];
  if (!onlyBrowser) {
    // Warm-up (kernel load, JIT, font, solver) — not reported.
    await scenarioText(-0.9);
    await scenarioHole(38);

    const textRuns: StepRow[][] = [];
    const labelRuns: StepRow[][] = [];
    const holeRuns: StepRow[][] = [];
    const label = { text: 'HIMMELCAD 26', height: 5, shift: 22 };
    for (let i = 0; i < runs; i += 1) {
      textRuns.push(await scenarioText(-1 - i * 0.01));
      labelRuns.push(await scenarioText(-1 - i * 0.01, label));
      holeRuns.push(await scenarioHole(40 + i * 0.5));
    }
    rows = [
      ...medianRows(textRuns),
      ...medianRows(labelRuns).filter((r) => /place text|Emboss|Engrave/.test(r.step)),
      ...medianRows(holeRuns),
      ...medianRows([await scenarioFillet(10)]),
      ...medianRows([await scenarioSketchDrag(30)]),
      ...medianRows([scenarioPivot(200)]),
      ...medianRows([await scenarioParameterSlider(10)]),
      ...medianRows([await scenarioChecks(10)]),
    ];
  }

  let browser: StepRow[] | null = null;
  if (args.includes('--browser') || onlyBrowser) {
    const { runBrowserBench } = await import('./interactiveBrowser.js');
    browser = await runBrowserBench({ runs });
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ kernelLoadMs, rows, browser }, null, 2)}\n`);
  } else {
    const lines = onlyBrowser
      ? []
      : [
          `Interactive bench — Node ${process.version}, OCCT module ${selectedOcctModule()} (load ${Math.round(kernelLoadMs)} ms), in-process kernel + solver, medians of ${runs} runs (drags: of all steps)`,
          '',
          formatRows(rows),
        ];
    if (browser) {
      lines.push(
        '',
        'Browser (Chromium, Vite dev server, kernel + solver in Web Workers; Wall = first input → frame showing the result; UI = main-thread long tasks; Kernel = worker-reported)',
        '',
        formatRows(browser),
      );
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}

await main();
process.exit(0);
