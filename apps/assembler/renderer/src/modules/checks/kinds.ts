/**
 * The check kinds the checks module owns itself: those about the document
 * as a whole rather than a measurement or the print analysis.
 */
import { schemaObject } from '../../foundation/commands/api/contract.js';
import {
  formatRange,
  rangeOf,
  rangeOutcome,
  rangeProblem,
  type CheckKindDefinition,
} from '../../foundation/commands/checks.js';
import { isReferenceMeshBodyId } from '../../foundation/commands/referenceMesh.js';

export const BODY_COUNT_CHECK: CheckKindDefinition = {
  kind: 'bodyCount',
  module: 'checks',
  label: 'Body count',
  hint: 'Number of bodies within a range.',
  summary:
    'Number of bodies within a range (catches parts that fused or split unexpectedly; reference meshes are not counted).',
  paramsSchema: schemaObject({
    min: { type: 'integer', minimum: 0, description: 'Fewest bodies.' },
    max: { type: 'integer', minimum: 0, description: 'Most bodies.' },
  }),
  problem: rangeProblem,
  describe: (p) => `Body count ${formatRange(rangeOf(p), '')}`,
  dependsOn: () => null,
  cost: 'instant',
  fields: [
    { key: 'min', label: 'Min', unit: '', optional: true, min: 0, integer: true },
    { key: 'max', label: 'Max', unit: '', optional: true, min: 0, integer: true },
  ],
  fromSelection: () => ({}),
  evaluate: (params, env) => {
    const bodies = env.evaluation.bodies.filter((b) => !isReferenceMeshBodyId(b.id));
    return rangeOutcome(bodies.length, rangeOf(params), '', [{ bodyIds: bodies.map((b) => b.id) }]);
  },
};

export const CHECKS_CHECK_KINDS: readonly CheckKindDefinition[] = [BODY_COUNT_CHECK];
