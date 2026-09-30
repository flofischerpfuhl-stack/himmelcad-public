/**
 * The per-kind evaluator registry (assembler/MODULES.md §3): the evaluator
 * implements its core kinds itself and asks this registry for every other
 * kind. A module that owns kinds declares them in its `kernel.ts` with
 * {@link defineKernelModule}; the kernel-worker composition
 * (`renderer/src/app/kernel.worker.ts`) and the in-process kernel
 * (headless CLI, tests) load those files, so the worker bundle carries only
 * kernel code.
 */
import type { Feature, FeatureKind, FeatureOf } from '../../document/featureKinds.js';
import type { FeatureKit, ReplayContextLike } from './kit.js';

/** Replays one feature into the replay context; fails through `kit.fail`. */
export type FeatureEvaluator<K extends FeatureKind = FeatureKind> = (
  feature: FeatureOf<K>,
  ctx: ReplayContextLike,
  kit: FeatureKit,
) => void | Promise<void>;

export interface KernelModule {
  /** Module id (`apps/assembler/modules.json`). */
  id: string;
  featureEvaluators: { [K in FeatureKind]?: FeatureEvaluator<K> };
}

const evaluators = new Map<string, { module: string; evaluate: FeatureEvaluator }>();

/** Declares a module's kernel part and registers its evaluators (once per kind). */
export function defineKernelModule(module: KernelModule): KernelModule {
  for (const [kind, evaluate] of Object.entries(module.featureEvaluators)) {
    if (!evaluate) continue;
    const existing = evaluators.get(kind);
    if (existing && existing.evaluate !== evaluate) {
      throw new Error(
        `Feature kind "${kind}" has two evaluators (${existing.module}, ${module.id})`,
      );
    }
    evaluators.set(kind, { module: module.id, evaluate: evaluate as FeatureEvaluator });
  }
  return module;
}

/** The registered evaluator of `kind`, or `undefined`. */
export function featureEvaluator(kind: string): FeatureEvaluator | undefined {
  return evaluators.get(kind)?.evaluate;
}

/** Evaluates a registered kind, or fails the feature for an unknown one. */
export function applyRegisteredFeature(
  feature: Feature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void | Promise<void> {
  const evaluate = evaluators.get(feature.kind)?.evaluate;
  if (!evaluate) kit.fail(`Unknown feature kind "${feature.kind}"`);
  return evaluate(feature, ctx, kit);
}
