import type { ProjectSnapshot } from '@himmelcad/data';

import type { BuilderSnapshotSummary } from './project.js';

export type BuilderSnapshotCommandSession = Pick<
  import('./project.js').BuilderCanonicalProjectSession,
  'createSnapshot' | 'listSnapshots' | 'restoreSnapshot'
>;

export type BuilderSnapshotCommandResult =
  | {
      readonly method: 'snapshot.create';
      readonly result: BuilderSnapshotSummary;
      readonly snapshots: readonly BuilderSnapshotSummary[];
    }
  | {
      readonly method: 'snapshot.list';
      readonly result: readonly BuilderSnapshotSummary[];
      readonly snapshots: readonly BuilderSnapshotSummary[];
    }
  | {
      readonly method: 'snapshot.restore';
      readonly result: BuilderSnapshotSummary;
      readonly project: ProjectSnapshot;
      readonly snapshots: readonly BuilderSnapshotSummary[];
    };

/** One shared command path for the Snapshots menu and the automation host. */
export function executeBuilderSnapshotCommand(
  session: BuilderSnapshotCommandSession,
  method: 'snapshot.create',
  payload: Readonly<Record<string, unknown>>,
): Promise<Extract<BuilderSnapshotCommandResult, { readonly method: 'snapshot.create' }>>;
export function executeBuilderSnapshotCommand(
  session: BuilderSnapshotCommandSession,
  method: 'snapshot.list',
  payload: Readonly<Record<string, unknown>>,
): Promise<Extract<BuilderSnapshotCommandResult, { readonly method: 'snapshot.list' }>>;
export function executeBuilderSnapshotCommand(
  session: BuilderSnapshotCommandSession,
  method: 'snapshot.restore',
  payload: Readonly<Record<string, unknown>>,
): Promise<Extract<BuilderSnapshotCommandResult, { readonly method: 'snapshot.restore' }>>;
export function executeBuilderSnapshotCommand(
  session: BuilderSnapshotCommandSession,
  method: 'snapshot.create' | 'snapshot.list' | 'snapshot.restore',
  payload: Readonly<Record<string, unknown>>,
): Promise<BuilderSnapshotCommandResult>;
export async function executeBuilderSnapshotCommand(
  session: BuilderSnapshotCommandSession,
  method: 'snapshot.create' | 'snapshot.list' | 'snapshot.restore',
  payload: Readonly<Record<string, unknown>>,
): Promise<BuilderSnapshotCommandResult> {
  if (method === 'snapshot.list') {
    const snapshots = await session.listSnapshots();
    return { method, result: snapshots, snapshots };
  }
  if (method === 'snapshot.create') {
    if (typeof payload.name !== 'string' || !payload.name.trim()) {
      throw new TypeError('snapshot.create requires payload.name');
    }
    const result = await session.createSnapshot(payload.name);
    return { method, result, snapshots: await session.listSnapshots() };
  }
  if (typeof payload.entityId !== 'string' || !payload.entityId) {
    throw new TypeError('snapshot.restore requires payload.entityId');
  }
  const before = await session.listSnapshots();
  const result = before.find((snapshot) => snapshot.entityId === payload.entityId);
  if (!result) throw new Error(`Snapshot ${payload.entityId} no longer exists.`);
  const project = await session.restoreSnapshot(payload.entityId);
  return { method, result, project, snapshots: await session.listSnapshots() };
}
