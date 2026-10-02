/**
 * Kernel performance table (`pnpm --filter @himmelcad/assembler bench:kernel`):
 * full evaluation, edit of feature #2, edit of the last feature and preview
 * latency for the three bench parts (`parts.ts`), on the real OCCT kernel in
 * Node. `--leak [n]` adds the long scripted session (n edits, default 500)
 * with the wasm heap size over time; `--json` prints machine-readable rows.
 *
 * Every timed evaluation uses parameter values no cache has seen (fresh
 * `v`), so cache hits of identical documents never flatter the numbers.
 */

import { loadOcct, selectedOcctModule, type OpenCascadeModule } from '../../headless/occtModule.js';

import {
  createEvaluator,
  type KernelEvaluator,
} from '../../renderer/src/foundation/geometry-kernel/evaluator.js';
import type {
  ClearanceRequest,
  EvaluationResult,
} from '../../renderer/src/foundation/geometry-kernel/types.js';
import { clearanceCandidates } from '../../renderer/src/foundation/geometry-kernel/clearancePairs.js';
import type { Feature } from '../../renderer/src/foundation/document/document.js';
import {
  BENCH_PARTS,
  demoBracket,
  extrude,
  ninePartBench,
  sketch,
  type BenchPart,
} from './parts.js';

type OpenCascade = OpenCascadeModule;

interface Row {
  part: string;
  fullMs: number;
  editSecondMs: number;
  editLastMs: number;
  previewMs: number;
  triangles: number;
  bodies: number;
  errors: number;
  /** Tessellation: full (cold) and for the last-feature edit, ms; preview-quality triangles. */
  fullTessMs: number;
  lastTessMs: number;
  previewTriangles: number;
}

type Evaluate = (
  features: Feature[],
  options?: { quality?: 'preview' | 'final' },
) => Promise<EvaluationResult>;

function evaluateOf(evaluator: KernelEvaluator): Evaluate {
  return evaluator.evaluate.bind(evaluator) as Evaluate;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function timed(
  run: () => Promise<EvaluationResult>,
): Promise<{ ms: number; result: EvaluationResult }> {
  const t0 = performance.now();
  const result = await run();
  return { ms: performance.now() - t0, result };
}

function heapMb(oc: OpenCascade): number {
  const memory = (oc as unknown as { wasmMemory?: WebAssembly.Memory }).wasmMemory;
  return memory ? memory.buffer.byteLength / 1048576 : NaN;
}

async function benchPart(oc: OpenCascade, part: BenchPart, repeats: number): Promise<Row> {
  // Full evaluation: a fresh evaluator (empty caches) per repetition.
  const full: number[] = [];
  const fullTess: number[] = [];
  let baseline: EvaluationResult | null = null;
  for (let i = 0; i < 3; i += 1) {
    const { ms, result } = await timed(() => evaluateOf(createEvaluator(oc))(part.document()));
    full.push(ms);
    fullTess.push(result.stats.tessellateMs);
    baseline = result;
  }
  const evaluator = createEvaluator(oc);
  const evaluate = evaluateOf(evaluator);
  await evaluate(part.document());
  const editSecond: number[] = [];
  const editLast: number[] = [];
  const lastTess: number[] = [];
  for (let v = 0; v < repeats; v += 1) {
    editSecond.push((await timed(() => evaluate(part.editSecond(v)))).ms);
  }
  await evaluate(part.document());
  for (let v = 0; v < repeats; v += 1) {
    const { ms, result } = await timed(() => evaluate(part.editLast(v)));
    editLast.push(ms);
    lastTess.push(result.stats.tessellateMs);
  }
  // Preview: the committed document stays, a provisional feature is dragged.
  await evaluate(part.document());
  const preview: number[] = [];
  let previewTriangles = 0;
  for (let v = 0; v < repeats + 1; v += 1) {
    const features = [...part.document(), part.preview(v)];
    const { ms, result } = await timed(() => evaluate(features, { quality: 'preview' }));
    const error = result.errors[features[features.length - 1]!.id];
    if (error) throw new Error(`${part.name}: preview failed: ${error}`);
    if (v > 0) preview.push(ms); // the first preview starts the drag
  }
  // The whole document at preview quality (a fresh evaluator: nothing reused).
  previewTriangles = (
    await evaluateOf(createEvaluator(oc))(part.document(), { quality: 'preview' })
  ).stats.triangles;
  const result = baseline!;
  return {
    part: part.name,
    fullMs: median(full),
    editSecondMs: median(editSecond),
    editLastMs: median(editLast),
    previewMs: median(preview),
    triangles: result.stats.triangles,
    bodies: result.bodies.length,
    errors: Object.keys(result.errors).length,
    fullTessMs: median(fullTess),
    lastTessMs: median(lastTess),
    previewTriangles,
  };
}

/**
 * Long scripted session on the demo bracket: `edits` document edits (each
 * followed by two preview evaluations), cycling through several parameters,
 * with the wasm heap size sampled every 50 edits.
 */
async function leakSession(
  oc: OpenCascade,
  edits: number,
  budgetMb?: number,
): Promise<{ edit: number; heapMb: number; cacheMb: number; ms: number }[]> {
  const evaluator = createEvaluator(
    oc,
    budgetMb === undefined ? {} : ({ cacheBudgetBytes: budgetMb * 1048576 } as never),
  );
  const evaluate = evaluateOf(evaluator);
  const cacheMb = () => {
    const info = (
      evaluator as { cacheInfo?: () => { bytes: number; meshBytes: number } }
    ).cacheInfo?.();
    return info ? (info.bytes + info.meshBytes) / 1048576 : NaN;
  };
  const samples: { edit: number; heapMb: number; cacheMb: number; ms: number }[] = [];
  let window: number[] = [];
  // No forced GC: the session shows what a real worker sees.
  for (let i = 0; i <= edits; i += 1) {
    const v = i; // every document is new: the caches fill up to their budgets and evict
    const features =
      i % 3 === 0
        ? demoBracket.editSecond(v)
        : i % 3 === 1
          ? demoBracket.editLast(v)
          : demoBracket.document();
    const { ms } = await timed(() => evaluate(features));
    window.push(ms);
    for (let p = 0; p < 2; p += 1) {
      await evaluate([...features, demoBracket.preview((i % 11) + p)], { quality: 'preview' });
    }
    if (i % 50 === 0) {
      samples.push({ edit: i, heapMb: heapMb(oc), cacheMb: cacheMb(), ms: median(window) });
      window = [];
    }
  }
  return samples;
}

function fmt(ms: number): string {
  return ms >= 100 ? ms.toFixed(0) : ms.toFixed(1);
}

/**
 * A print plate of `columns × rows` 10 × 10 × 8 mm blocks with 0.25 mm gaps
 * (print-in-place spacing): the clearance pass's typical many-body case.
 */
function blockPlate(columns: number, rows: number): Feature[] {
  const out: Feature[] = [];
  for (let i = 0; i < columns * rows; i += 1) {
    const x = (i % columns) * 10.25;
    const y = Math.floor(i / columns) * 10.25;
    out.push(
      sketch(`cs${i}`, 'XY', 0, { kind: 'rectangle', x, y, width: 10, height: 10 }),
      extrude(`cb${i}`, `cs${i}`, 8),
    );
  }
  return out;
}

interface ClearanceRow {
  label: string;
  pairs: number;
  ms: number;
}

/** Clearance queries (Block 9): one pair, all pairs with/without overlap volumes, a block plate. */
async function benchClearance(oc: OpenCascade, repeats: number): Promise<ClearanceRow[]> {
  const evaluator = createEvaluator(oc);
  const rows: ClearanceRow[] = [];
  const measure = async (label: string, features: Feature[], request: ClearanceRequest) => {
    await evaluator.evaluate(features);
    await evaluator.measureClearance!(features, request); // warm-up
    const times: number[] = [];
    for (let i = 0; i < repeats; i += 1) {
      const t0 = performance.now();
      await evaluator.measureClearance!(features, request);
      times.push(performance.now() - t0);
    }
    rows.push({ label, pairs: request.pairs.length, ms: median(times) });
  };
  const nine = ninePartBench.document();
  const nineBodies = (await evaluator.evaluate(nine)).bodies;
  const allPairs = clearanceCandidates(nineBodies, Infinity).map(({ a, b }) => ({ a, b }));
  await measure('features-branch part: one body pair', nine, { pairs: allPairs.slice(0, 1) });
  await measure('features-branch part: every pair, overlap volumes', nine, { pairs: allPairs });
  await measure('features-branch part: every pair, distance only', nine, {
    pairs: allPairs,
    overlap: false,
  });
  const plate = blockPlate(8, 4);
  const plateBodies = (await evaluator.evaluate(plate)).bodies;
  const near = clearanceCandidates(plateBodies, 0.3).map(({ a, b }) => ({ a, b }));
  await measure('32-block plate (0.25 mm gaps): pairs closer than 0.3 mm', plate, { pairs: near });
  return rows;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const leakIndex = Math.max(args.indexOf('--leak'), args.indexOf('--leak-only'));
  const leakEdits = leakIndex >= 0 ? Number(args[leakIndex + 1]) || 500 : 0;
  const tableToo = !args.includes('--leak-only');
  const budgetIndex = args.indexOf('--budget');
  const budgetMb = budgetIndex >= 0 ? Number(args[budgetIndex + 1]) : undefined;
  const repeats = 5;

  const t0 = performance.now();
  const oc = await loadOcct();
  const loadMs = performance.now() - t0;
  if (tableToo) {
    // JIT warm-up so the first part is not charged for it.
    await evaluateOf(createEvaluator(oc))(demoBracket.document());

    const rows: Row[] = [];
    for (const part of BENCH_PARTS) rows.push(await benchPart(oc, part, repeats));
    const clearance = await benchClearance(oc, repeats);

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ loadMs, rows, clearance, heapMb: heapMb(oc) }, null, 2)}\n`,
      );
    } else {
      const lines = [
        `Kernel bench — Node ${process.version}, OCCT module ${selectedOcctModule()}, wasm load ${fmt(loadMs)} ms, medians of ${repeats} (full: 3)`,
        '',
        '| Part | Full eval (ms) | Edit feature #2 (ms) | Edit last feature (ms) | Preview (ms) | Triangles | Bodies |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...rows.map(
          (r) =>
            `| ${r.part}${r.errors ? ` (${r.errors} errors!)` : ''} | ${fmt(r.fullMs)} | ${fmt(r.editSecondMs)} | ${fmt(r.editLastMs)} | ${fmt(r.previewMs)} | ${r.triangles} | ${r.bodies} |`,
        ),
        '',
        '| Part | Tessellation, full (ms) | Tessellation, last-feature edit (ms) | Triangles, final | Triangles, preview quality |',
        '| --- | ---: | ---: | ---: | ---: |',
        ...rows.map(
          (r) =>
            `| ${r.part} | ${fmt(r.fullTessMs)} | ${fmt(r.lastTessMs)} | ${r.triangles} | ${r.previewTriangles} |`,
        ),
        '',
        '| Clearance (measureClearance, cached document) | Pairs | Median (ms) |',
        '| --- | ---: | ---: |',
        ...clearance.map((c) => `| ${c.label} | ${c.pairs} | ${fmt(c.ms)} |`),
        '',
        `wasm heap after the table: ${heapMb(oc).toFixed(1)} MB`,
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
    }
  }

  if (leakEdits > 0) {
    const samples = await leakSession(oc, leakEdits, budgetMb);
    const lines = [
      '',
      `Leak session: ${leakEdits} edits of the demo bracket (+ 2 previews each), every document new${budgetMb === undefined ? '' : `, checkpoint budget ${budgetMb} MB`}`,
      '',
      '| Edit | wasm heap (MB) | kernel caches (MB, estimated) | median edit (ms) |',
      '| ---: | ---: | ---: | ---: |',
      ...samples.map(
        (s) => `| ${s.edit} | ${s.heapMb.toFixed(1)} | ${s.cacheMb.toFixed(1)} | ${fmt(s.ms)} |`,
      ),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}

await main();
