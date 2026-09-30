/**
 * Fillet/chamfer by rule (spliced into `registry.ts`): every edge of the
 * selected faces, or every concave (inside) / convex (outside) edge of the
 * selected body. The rule is stored in the feature and re-evaluated on
 * every replay, so edges an earlier edit adds or removes follow.
 */
import {
  makeFaceRef,
  type AssemblerState,
  type SelectionItem,
} from '../../foundation/commands/store.js';
import type { EdgeRule } from '../../foundation/document/blendOptions.js';
import type { Command, CommandAvailability } from '../../foundation/commands/registry.js';

function kernelNotReady(ctx: AssemblerState): CommandAvailability | null {
  if (ctx.kernelStatus === 'ready') return null;
  return {
    enabled: false,
    reason:
      ctx.kernelStatus === 'error'
        ? 'The CAD kernel failed to load.'
        : 'The CAD kernel is still loading.',
  };
}

function faceRules(ctx: AssemblerState): EdgeRule[] | null {
  const faces = ctx.selection.filter(
    (s): s is Extract<SelectionItem, { kind: 'face' }> => s.kind === 'face',
  );
  if (faces.length === 0 || faces.length !== ctx.selection.length) return null;
  if (faces.some((f) => f.bodyId !== faces[0]!.bodyId)) return null;
  const rules: EdgeRule[] = [];
  for (const f of faces) {
    const face = makeFaceRef(ctx.evaluation, f.bodyId, f.faceKey);
    if (face) rules.push({ kind: 'faceEdges', face });
  }
  return rules.length > 0 ? rules : null;
}

function oneBody(ctx: AssemblerState): string | null {
  const bodies = ctx.selection.filter((s) => s.kind === 'body');
  return bodies.length === 1 && ctx.selection.length === 1 && bodies[0]!.kind === 'body'
    ? bodies[0]!.bodyId
    : null;
}

export const BLEND_RULE_COMMANDS: readonly Command[] = [
  {
    id: 'tools.filletFaceEdges',
    label: 'Fillet Face Edges',
    group: 'tools',
    keywords: ['round all edges', 'fillet face', 'rule', 'outline'],
    requiresKernel: true,
    availability: (ctx) =>
      kernelNotReady(ctx) ??
      (faceRules(ctx)
        ? { enabled: true, recommended: true, priority: 45 }
        : { enabled: false, reason: 'Select faces of one body; all their edges are rounded.' }),
    run: (ctx) => {
      const rules = faceRules(ctx);
      if (rules) ctx.beginEdgeBlendByRule('fillet', rules);
    },
  },
  {
    id: 'tools.filletConcave',
    label: 'Fillet Inside Edges',
    group: 'tools',
    keywords: ['concave', 'valley', 'inner corners', 'stress relief', 'rule'],
    requiresKernel: true,
    availability: (ctx) =>
      kernelNotReady(ctx) ??
      (oneBody(ctx)
        ? { enabled: true, recommended: true, priority: 42 }
        : { enabled: false, reason: 'Select one body; all its concave edges are rounded.' }),
    run: (ctx) => {
      const bodyId = oneBody(ctx);
      if (bodyId) ctx.beginEdgeBlendByRule('fillet', [{ kind: 'concave', bodyId }]);
    },
  },
  {
    id: 'tools.filletConvex',
    label: 'Fillet Outside Edges',
    group: 'tools',
    keywords: ['convex', 'ridge', 'outer edges', 'round over', 'rule'],
    requiresKernel: true,
    availability: (ctx) =>
      kernelNotReady(ctx) ??
      (oneBody(ctx)
        ? { enabled: true, priority: 41 }
        : { enabled: false, reason: 'Select one body; all its convex edges are rounded.' }),
    run: (ctx) => {
      const bodyId = oneBody(ctx);
      if (bodyId) ctx.beginEdgeBlendByRule('fillet', [{ kind: 'convex', bodyId }]);
    },
  },
];
