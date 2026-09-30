/**
 * Shared set-up of the headless acceptance cases (PLAN §7): the real app
 * store, the real OCCT kernel and planeGCS solver in-process, and one
 * canonical agent session (`hcasm.agent-api@1`, headless capabilities) —
 * the exact path the headless CLI and Python take. Checks are numbers, not
 * pictures: units, dimensions, volumes, B-rep validity, body counts,
 * reference binding and exported print data (3MF validator, STL welded
 * watertightness).
 *
 * Every case records its evidence (`evidence()`), printed as a test
 * diagnostic and written to `$ASSEMBLER_ACCEPTANCE_OUT/<case>.json`
 * (default: the OS temp directory) for `assembler/ACCEPTANCE.md`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiError } from '../../renderer/src/foundation/commands/api/errors.js';
import {
  AgentSession,
  HEADLESS_CAPABILITIES,
} from '../../renderer/src/interface/agent-api/session.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { manifoldStats } from '../../renderer/src/modules/print/meshTools.js';
import { weldMesh } from '../../renderer/src/foundation/geometry-kernel/meshWeld.js';
import { parseStl } from '../../renderer/src/kernel/stlImport.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { validateThreeMf, type ParsedModel } from '../kernel/threeMfValidator.js';
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

/** One agent-API call. */
export async function call<T = Json>(method: string, params: Json = {}): Promise<T> {
  return (await session.handle(method, params)) as T;
}

/** Expects an `ApiError` with `code`; returns it. */
export async function fails(promise: Promise<unknown>, code: ApiError['code']): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError ${code}, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

/** A fresh, empty document (the undo history cleared). */
export async function reset(name = 'Acceptance'): Promise<void> {
  store.getState().cancel();
  if (session.transactionOpen) await call('transaction.cancel');
  await call('project.new', { name });
  await store.getState().whenSettled();
}

export interface BodyInfo {
  id: string;
  name: string;
  color: string;
  valid: boolean;
  volume: number;
  area: number;
  bbox: { min: number[]; max: number[]; size: number[] };
  faceCount: number;
}

export async function bodies(): Promise<BodyInfo[]> {
  return call<BodyInfo[]>('bodies.list');
}

export async function bodyNamed(name: string): Promise<BodyInfo> {
  const found = (await bodies()).find((b) => b.name === name);
  assert.ok(found, `a body named "${name}"`);
  return found;
}

/** `actual` within `relative` (default 1e-6) of `expected`. */
export function near(actual: number, expected: number, relative = 1e-6, what = 'value'): void {
  const tolerance = Math.max(Math.abs(expected) * relative, 1e-9);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} differs from ${expected} by more than ${tolerance}`,
  );
}

export function bboxIs(body: BodyInfo, min: number[], max: number[], tol = 1e-6): void {
  for (let i = 0; i < 3; i += 1) {
    assert.ok(
      Math.abs(body.bbox.min[i]! - min[i]!) < tol && Math.abs(body.bbox.max[i]! - max[i]!) < tol,
      `${body.name} bbox ${JSON.stringify(body.bbox)} ≠ ${JSON.stringify({ min, max })}`,
    );
  }
}

export { roundedRectArea } from './geometry.js';

function fromBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}

/** Exports 3MF through the API, validates it strictly and returns the parsed model. */
export async function export3mf(): Promise<{ model: ParsedModel; bytes: number }> {
  const result = await call<{ data: string; byteLength: number }>('export.3mf');
  const { problems, model } = validateThreeMf(fromBase64(result.data));
  assert.deepEqual(problems, [], '3MF validator problems');
  assert.ok(model);
  assert.equal(model.unit, 'millimeter');
  return { model, bytes: result.byteLength };
}

/** Exports binary STL through the API; checks it welds into a closed, consistently oriented mesh. */
export async function exportStlWatertight(
  bodyIds?: string[],
): Promise<{ triangles: number; boundaryEdges: number }> {
  const result = await call<{ data: string; triangles: number }>('export.stl', {
    ...(bodyIds ? { bodyIds } : {}),
  });
  const parsed = parseStl(fromBase64(result.data));
  assert.equal(parsed.triangleCount, result.triangles);
  const welded = weldMesh({ positions: parsed.positions, indices: parsed.indices });
  const stats = manifoldStats(welded.indices);
  assert.ok(
    stats.watertight,
    `STL not watertight: ${stats.boundaryEdges} open, ${stats.nonManifoldEdges} non-manifold, ${stats.inconsistentEdges} flipped`,
  );
  return { triangles: parsed.triangleCount, boundaryEdges: stats.boundaryEdges };
}

const OUT_DIR = process.env.ASSEMBLER_ACCEPTANCE_OUT ?? join(tmpdir(), 'assembler-acceptance');

/** Records a case's evidence (JSON) for ACCEPTANCE.md and prints it. */
export function evidence(
  t: { diagnostic: (message: string) => void },
  caseId: string,
  data: Json,
): void {
  const text = JSON.stringify(data, (_k, v: unknown) =>
    typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v,
  );
  t.diagnostic(`${caseId}: ${text}`);
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `${caseId}.json`), `${text}\n`, 'utf8');
  } catch {
    // Evidence files are a convenience; the assertions are the result.
  }
}
