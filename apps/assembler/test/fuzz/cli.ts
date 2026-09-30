/**
 * `pnpm --filter @himmelcad/assembler test:fuzz [-- options]` — the
 * model-based fuzzer (`assembler/ROBUSTNESS.md`).
 *
 *   --seed <n>            run seed (default 1; env ASSEMBLER_FUZZ_SEED)
 *   --minutes <m>         time budget (default 3; env ASSEMBLER_FUZZ_MINUTES)
 *   --steps <n>           ops per sequence (default 40)
 *   --sequences <n>       stop after n sequences (default: budget only)
 *   --shrink-minutes <m>  delta-debugging budget per finding (default 5)
 *   --out <dir>           reproducers (default env ASSEMBLER_FUZZ_OUT or <tmp>/assembler-fuzz)
 *   --replay <file>       run one reproducer JSON and report
 *   --verbose             log every step
 *
 * Deterministic: sequence i of seed s is `generateSequence(sequenceSeed(s, i))`.
 * Exit code 1 if an invariant broke; every finding is written as a
 * reproducer JSON (minimal ops + the resolved calls) and printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FuzzHarness, type Failure } from './harness.js';
import { generateSequence, sequenceSeed, type Op } from './ops.js';
import { shrink } from './shrink.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const seed = Number(arg('seed') ?? process.env.ASSEMBLER_FUZZ_SEED ?? 1);
const minutes = Number(arg('minutes') ?? process.env.ASSEMBLER_FUZZ_MINUTES ?? 3);
const steps = Number(arg('steps') ?? 40);
const maxSequences = Number(arg('sequences') ?? Infinity);
const shrinkMinutes = Number(arg('shrink-minutes') ?? 5);
const outDir = arg('out') ?? process.env.ASSEMBLER_FUZZ_OUT ?? join(tmpdir(), 'assembler-fuzz');
const verbose = process.argv.includes('--verbose');
const replay = arg('replay');

export interface Reproducer {
  name: string;
  seed: number;
  sequence: number;
  invariant: string;
  message: string;
  ops: Op[];
  calls?: string[];
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const harness = await FuzzHarness.create();
  if (replay) {
    const repro = JSON.parse(readFileSync(replay, 'utf8')) as Reproducer;
    const result = await harness.run(repro.ops, { log: print });
    print(
      result.failure
        ? `REPRODUCED ${result.failure.invariant}: ${result.failure.message}`
        : 'clean',
    );
    return result.failure ? 1 : 0;
  }
  mkdirSync(outDir, { recursive: true });
  const start = Date.now();
  const deadline = start + minutes * 60_000;
  const findings: Reproducer[] = [];
  const seen = new Set<string>();
  let totalSteps = 0;
  let totalCommitted = 0;
  let totalRefused = 0;
  let maxHeap = 0;
  let totalMarginal = 0;
  let sequence = 0;
  print(`fuzz: seed ${seed}, ${minutes} min, ${steps} ops/sequence, reproducers → ${outDir}`);
  for (; sequence < maxSequences && Date.now() < deadline; sequence += 1) {
    const ops = generateSequence(sequenceSeed(seed, sequence), steps);
    const result = await harness.run(ops, { deadline, ...(verbose ? { log: print } : {}) });
    totalSteps += result.steps;
    totalCommitted += result.committed;
    totalRefused += result.refused;
    maxHeap = Math.max(maxHeap, result.maxHeapBytes);
    totalMarginal += result.marginal.length;
    print(
      `seq ${sequence}: ${result.steps} steps, ${result.committed} committed, ${result.refused} refused, heap ≤ ${Math.round(result.maxHeapBytes / 2 ** 20)} MB, kernel loads ${result.kernelLoads}, ${Math.round((Date.now() - start) / 1000)} s${result.failure ? ` — FAILED ${result.failure.invariant} at step ${result.failure.step}` : ''}`,
    );
    for (const note of result.marginal)
      print(`  MARGINAL (OCCT heap-layout dependent, F3): ${note.slice(0, 300)}`);
    if (!result.failure) continue;
    const failure: Failure = result.failure;
    const key = `${failure.invariant}:${failure.op.op}:${failure.message.replace(/feature-[\w-]+|body:[\w:-]+|\d+(\.\d+)?/g, '#').slice(0, 120)}`;
    const prefix = ops.slice(0, failure.step + 1);
    const reproduces = async (candidate: readonly Op[]) => {
      const again = await harness.run(candidate);
      return again.failure?.invariant === failure.invariant;
    };
    let minimal: Op[] = prefix;
    if (seen.has(key)) {
      print(`  (same finding as before: ${key})`);
    } else if (await reproduces(prefix)) {
      minimal = await shrink(prefix, reproduces, {
        deadline: Date.now() + shrinkMinutes * 60_000,
        log: print,
      });
    } else {
      print('  not reproducible on replay (kept unshrunk)');
    }
    seen.add(key);
    const final = await harness.run(minimal, { log: print });
    const repro: Reproducer = {
      name: `${failure.invariant}-s${seed}-q${sequence}`,
      seed,
      sequence,
      invariant: final.failure?.invariant ?? failure.invariant,
      message: final.failure?.message ?? failure.message,
      ops: minimal,
      calls: final.log.map(
        (l) => `${l.outcome} ${l.call || l.op}${l.detail ? ` — ${l.detail}` : ''}`,
      ),
    };
    findings.push(repro);
    const file = join(outDir, `${repro.name}.json`);
    writeFileSync(file, `${JSON.stringify(repro, null, 2)}\n`, 'utf8');
    print(`  FINDING ${repro.invariant}: ${repro.message.slice(0, 400)}`);
    print(`  minimal sequence (${minimal.length} ops) → ${file}`);
    for (const line of repro.calls ?? []) print(`    ${line.slice(0, 300)}`);
  }
  print(
    `fuzz done: seed ${seed}, ${sequence} sequences, ${totalSteps} steps, ${totalCommitted} committed, ${totalRefused} refused, max heap ${Math.round(maxHeap / 2 ** 20)} MB, kernel loads ${harness.kernelLoads}, ${Math.round((Date.now() - start) / 1000)} s, ${findings.length} finding(s), ${totalMarginal} marginal (OCCT heap-layout, F3)`,
  );
  return findings.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(2);
  },
);
