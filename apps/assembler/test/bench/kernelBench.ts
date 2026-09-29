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
import { createRequire } from 'node:module';

import init from 'replicad-opencascadejs';

import { createEvaluator, type KernelEvaluator } from '../../renderer/src/kernel/evaluator.js';
import type { EvaluationResult } from '../../renderer/src/kernel/types.js';
import type { Feature } from '../../renderer/src/model/document.js';
import { BENCH_PARTS, demoBracket, type BenchPart } from './parts.js';

type OpenCascade = Awaited<ReturnType<typeof init>>;

interface Row {
  part: string;
  fullMs: number;
  editSecondMs: number;
  editLastMs: number;
  previewMs: number;
  triangles: number;
  bodies: number;
  errors: number;
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
  let baseline: EvaluationResult | null = null;
  for (let i = 0; i < 3; i += 1) {
    const { ms, result } = await timed(() => evaluateOf(createEvaluator(oc))(part.document()));
    full.push(ms);
    baseline = result;
  }
  const evaluator = createEvaluator(oc);
  const evaluate = evaluateOf(evaluator);
  await evaluate(part.document());
  const editSecond: number[] = [];
  const editLast: number[] = [];
  for (let v = 0; v < repeats; v += 1) {
    editSecond.push((await timed(() => evaluate(part.editSecond(v)))).ms);
  }
  await evaluate(part.document());
  for (let v = 0; v < repeats; v += 1) {
    editLast.push((await timed(() => evaluate(part.editLast(v)))).ms);
  }
  // Preview: the committed document stays, a provisional feature is dragged.
  await evaluate(part.document());
  const preview: number[] = [];
  for (let v = 0; v < repeats + 1; v += 1) {
    const features = [...part.document(), part.preview(v)];
    const { ms, result } = await timed(() => evaluate(features, { quality: 'preview' }));
    const error = result.errors[features[features.length - 1]!.id];
    if (error) throw new Error(`${part.name}: preview failed: ${error}`);
    if (v > 0) preview.push(ms); // the first preview starts the drag
  }
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
): Promise<{ edit: number; heapMb: number; ms: number }[]> {
  const evaluate = evaluateOf(createEvaluator(oc));
  const samples: { edit: number; heapMb: number; ms: number }[] = [];
  let window: number[] = [];
  // No forced GC: the session shows what a real worker sees.
  for (let i = 0; i <= edits; i += 1) {
    const v = i % 37;
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
      samples.push({ edit: i, heapMb: heapMb(oc), ms: median(window) });
      window = [];
    }
  }
  return samples;
}

function fmt(ms: number): string {
  return ms >= 100 ? ms.toFixed(0) : ms.toFixed(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const leakIndex = args.indexOf('--leak');
  const leakEdits = leakIndex >= 0 ? Number(args[leakIndex + 1]) || 500 : 0;
  const repeats = 5;

  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('replicad-opencascadejs/wasm');
  const t0 = performance.now();
  const oc = await init({ locateFile: () => wasmPath });
  const loadMs = performance.now() - t0;
  // JIT warm-up so the first part is not charged for it.
  await evaluateOf(createEvaluator(oc))(demoBracket.document());

  const rows: Row[] = [];
  for (const part of BENCH_PARTS) rows.push(await benchPart(oc, part, repeats));

  if (json) {
    process.stdout.write(`${JSON.stringify({ loadMs, rows, heapMb: heapMb(oc) }, null, 2)}\n`);
  } else {
    const lines = [
      `Kernel bench — Node ${process.version}, wasm load ${fmt(loadMs)} ms, medians of ${repeats} (full: 3)`,
      '',
      '| Part | Full eval (ms) | Edit feature #2 (ms) | Edit last feature (ms) | Preview (ms) | Triangles | Bodies |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...rows.map(
        (r) =>
          `| ${r.part}${r.errors ? ` (${r.errors} errors!)` : ''} | ${fmt(r.fullMs)} | ${fmt(r.editSecondMs)} | ${fmt(r.editLastMs)} | ${fmt(r.previewMs)} | ${r.triangles} | ${r.bodies} |`,
      ),
      '',
      `wasm heap after the table: ${heapMb(oc).toFixed(1)} MB`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  if (leakEdits > 0) {
    const samples = await leakSession(oc, leakEdits);
    const lines = [
      '',
      `Leak session: ${leakEdits} edits of the demo bracket (+ 2 previews each)`,
      '',
      '| Edit | wasm heap (MB) | median edit (ms) |',
      '| ---: | ---: | ---: |',
      ...samples.map((s) => `| ${s.edit} | ${s.heapMb.toFixed(1)} | ${fmt(s.ms)} |`),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}

await main();
