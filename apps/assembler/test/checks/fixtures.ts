/**
 * Shared fixtures of the checks and clearance tests: an agent session on
 * the real (in-process) kernel and an enclosure with a lid — a 40 × 30 ×
 * 20 mm box shelled open at the top (2 mm walls) and a 3 mm lid whose
 * sketch plane height decides the clearance (20: resting on the rim, lower:
 * overlapping it, higher: a gap).
 */
import {
  AgentSession,
  HEADLESS_CAPABILITIES,
} from '../../renderer/src/interface/agent-api/session.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';

export type Json = Record<string, unknown>;

export const store = useAssemblerStore;
export const kernel = createNodeKernelAdapter();
store.getState().attachKernel(kernel);
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));
export const session = new AgentSession({
  store,
  kernel,
  host: { server: 'headless', capabilities: HEADLESS_CAPABILITIES },
});

export async function call<T = Json>(method: string, params: Json = {}): Promise<T> {
  return (await session.handle(method, params)) as T;
}

export async function reset(name = 'Checks'): Promise<void> {
  store.getState().cancel();
  if (session.transactionOpen) await call('transaction.cancel');
  store.getState().loadDocument([], { projectName: name });
  await store.getState().whenSettled();
}

/** Enclosure + lid; returns the body ids and the lid sketch's feature id (its plane offset is the lid height). */
export async function enclosureWithLid(lidZ: number): Promise<{
  base: string;
  lid: string;
  lidSketch: string;
}> {
  const s1 = await call('feature.create', {
    kind: 'sketch',
    params: { plane: 'XY', profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 40, height: 30 }] },
  });
  const e1 = await call('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: s1.featureId }, distance: 20 },
  });
  const base = `body:${String(e1.featureId)}`;
  await call('feature.create', {
    kind: 'shell',
    params: { bodyId: base, faces: [{ bodyId: base, select: '>Z' }], thickness: 2 },
  });
  const s2 = await call('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XY', offset: lidZ },
      profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 40, height: 30 }],
    },
  });
  const e2 = await call('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: s2.featureId }, distance: 3 },
  });
  return { base, lid: `body:${String(e2.featureId)}`, lidSketch: String(s2.featureId) };
}

/** Lifts the lid by `dz` (one Move step); returns the step's feature id. */
export async function liftLid(lid: string, dz: number): Promise<string> {
  const move = await call('feature.create', {
    kind: 'move',
    params: { bodyId: lid, dx: 0, dy: 0, dz },
  });
  return String(move.featureId);
}
