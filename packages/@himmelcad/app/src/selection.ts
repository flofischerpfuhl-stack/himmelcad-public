import type { CurveSubentityRefV1, LocalHistoryV1 } from '@himmelcad/data/canonical';
import { LocalStorageLocalHistoryPersistence } from './localHistoryPersistence.js';

export const SELECTION_STATE_SCHEMA_ID = 'hcad.selection-state@1' as const;
export const LOCAL_HISTORY_SCHEMA_ID = 'hcad.local-history@1' as const;
export const MIXED = Symbol('himmelcad.selection.mixed');

export type SelectionMember =
  | { readonly kind: 'entity'; readonly entityId: string }
  | { readonly kind: 'curveSubentity'; readonly ref: CurveSubentityRefV1 };

export type SelectionEntityKind = string;
export type SelectionGranularity = 'whole' | 'segments';

export const DEFAULT_SELECTABLE_KINDS: Readonly<Record<string, boolean>> = Object.freeze({
  points: true,
  lines: true,
  surfaces: true,
  solids: true,
  clouds: false,
});

export interface SelectionCandidate {
  readonly entityId: string;
  readonly name: string;
  readonly kind: SelectionEntityKind;
}

export type CandidateInvalidationReason =
  | 'cameraMove'
  | 'newClick'
  | 'toolCancel'
  | 'permissionChange'
  | 'overlayChange'
  | 'kindFilterChange'
  | 'renderGenerationChange'
  | 'deviceLoss'
  | 'viewportBlur'
  | 'escape';

export interface SelectionCandidateState {
  readonly items: readonly SelectionCandidate[];
  /** Zero-based index into the kernel's stable candidate order. */
  readonly index: number;
  readonly statusText: string;
}

export interface SelectionCandidateMenuContribution {
  readonly label: 'Select under cursor ▸';
  readonly items: readonly SelectionCandidate[];
}

/** UIP-D6 registry is not landed yet; S-06 can consume this contribution without re-picking. */
export function selectionCandidateMenuContribution(
  state: SelectionCandidateState | null,
): SelectionCandidateMenuContribution | null {
  return state ? { label: 'Select under cursor ▸', items: state.items } : null;
}

export interface SelectionSnapshot {
  readonly projectId: string | null;
  readonly members: readonly SelectionMember[];
  readonly selectedEntityIds: ReadonlySet<string>;
  readonly boundingBoxHaloEntityIds: ReadonlySet<string>;
  readonly candidates: SelectionCandidateState | null;
  readonly granularity: SelectionGranularity;
  readonly selectableKinds: Readonly<Record<string, boolean>>;
  readonly segmentReconciliation: readonly SegmentReconciliation[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly revision: number;
}

export interface CurveSegmentIndexEntry {
  /** Renderer primitive slot resolved by the canonical curve adapter. */
  readonly primitiveId: number;
  readonly topologyKind: string;
  readonly stableMemberId: string;
  readonly directedParameterInterval: readonly [number, number];
  readonly loopId?: string | null;
  readonly useId?: string | null;
  readonly semanticHash: string;
  /** Explicit source-edit mapping. Absence never permits nearest-member remap. */
  readonly previousSemanticHashes?: readonly string[];
}

export interface CurveSegmentIndex {
  readonly parentId: string;
  readonly parentRevision: number;
  readonly entries: readonly CurveSegmentIndexEntry[];
}

export type SegmentReconciliation =
  | {
      readonly kind: 'remapped';
      readonly parentId: string;
      readonly stableMemberId: string;
      readonly fromRevision: number;
      readonly toRevision: number;
    }
  | {
      readonly kind: 'pruned';
      readonly parentId: string;
      readonly stableMemberId: string;
      readonly reason: 'Segment no longer exists';
    };

export interface SelectionPersistenceRecordV1 {
  readonly schemaId: typeof SELECTION_STATE_SCHEMA_ID;
  readonly schemaVersion: 1;
  readonly state: readonly SelectionMember[];
  readonly granularity?: SelectionGranularity;
  readonly selectableKinds?: Readonly<Record<string, boolean>>;
  readonly history: LocalHistoryV1;
}

export interface SelectionPersistence {
  load(projectId: string): Promise<unknown | null>;
  store(projectId: string, record: SelectionPersistenceRecordV1): Promise<void>;
}

export interface SelectionStoreOptions {
  readonly persistence?: SelectionPersistence;
  readonly historyDepth?: number;
  readonly onRecovery?: (message: string) => void;
}

interface SelectionStateV1 {
  readonly schemaId: typeof SELECTION_STATE_SCHEMA_ID;
  readonly schemaVersion: 1;
  readonly members: readonly SelectionMember[];
  readonly granularity: SelectionGranularity;
  readonly selectableKinds: Readonly<Record<string, boolean>>;
}

interface MutableHistory {
  schemaId: typeof LOCAL_HISTORY_SCHEMA_ID;
  schemaVersion: 1;
  projectId: string;
  streamKind: 'selection';
  localSequence: number;
  cursor: number;
  head: number;
  entries: Array<{
    sequence: number;
    before: SelectionStateV1;
    after: SelectionStateV1;
    gestureSession: string | null;
    coalescingKey: string | null;
  }>;
  checksum: string;
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const DEFAULT_HISTORY_DEPTH = 256;
const CLOUD_KINDS = new Set([
  'PointCloud',
  'GaussianSplatCloud',
  'hcad.point-cloud@1',
  'hcad.gaussian-splat-cloud@1',
]);

/** Builder's sole selection owner. All mutation paths, including automation, terminate here. */
export class SelectionStore {
  private projectId: string | null = null;
  private members = new Map<string, SelectionMember>();
  private entityIds = new Set<string>();
  private parentCounts = new Map<string, number>();
  private haloIds = new Set<string>();
  private hiddenEntityIds = new Set<string>();
  private liveEntityIds: ReadonlySet<string> | null = null;
  private entityKind: (entityId: string) => SelectionEntityKind | undefined = () => undefined;
  private history: MutableHistory = emptyHistory('unloaded');
  private historyState: SelectionStateV1 = selectionState([]);
  private candidates: SelectionCandidateState | null = null;
  private granularity: SelectionGranularity = 'whole';
  private selectableKinds: Readonly<Record<string, boolean>> = DEFAULT_SELECTABLE_KINDS;
  private segmentReconciliation: readonly SegmentReconciliation[] = [];
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private cachedSnapshot: SelectionSnapshot | null = null;
  private persistTail: Promise<void> = Promise.resolve();
  private readonly persistence: SelectionPersistence | undefined;
  private readonly historyDepth: number;
  private readonly onRecovery: (message: string) => void;

  constructor(options: SelectionStoreOptions = {}) {
    this.persistence = options.persistence;
    this.historyDepth = options.historyDepth ?? DEFAULT_HISTORY_DEPTH;
    if (!Number.isSafeInteger(this.historyDepth) || this.historyDepth < 1) {
      throw new RangeError('selection historyDepth must be a positive safe integer');
    }
    this.onRecovery = options.onRecovery ?? (() => undefined);
  }

  getSnapshot = (): SelectionSnapshot => {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    this.cachedSnapshot = Object.freeze({
      projectId: this.projectId,
      members: Object.freeze([...this.members.values()]),
      selectedEntityIds: this.entityIds,
      boundingBoxHaloEntityIds: this.haloIds,
      candidates: this.candidates,
      granularity: this.granularity,
      selectableKinds: this.selectableKinds,
      segmentReconciliation: this.segmentReconciliation,
      canUndo: this.history.cursor > 0,
      canRedo: this.history.cursor < this.history.head,
      revision: this.revision,
    });
    return this.cachedSnapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async openProject(
    projectId: string,
    liveEntityIds: ReadonlySet<string>,
    entityKind: (entityId: string) => SelectionEntityKind | undefined,
    hiddenEntityIds: Iterable<string> = [],
  ): Promise<void> {
    if (!projectId.trim()) throw new TypeError('projectId is required');
    if (this.projectId && this.projectId !== projectId) await this.closeProject();
    this.projectId = projectId;
    this.liveEntityIds = liveEntityIds;
    this.entityKind = entityKind;
    this.hiddenEntityIds = new Set(hiddenEntityIds);
    this.history = emptyHistory(projectId);
    this.granularity = 'whole';
    this.selectableKinds = DEFAULT_SELECTABLE_KINDS;
    this.installMembers([]);
    this.candidates = null;
    this.segmentReconciliation = [];
    let persisted: unknown = null;
    try {
      persisted = await this.persistence?.load(projectId);
      if (persisted !== null && persisted !== undefined) {
        const record = await parsePersistenceRecord(persisted, projectId);
        this.history = record.history as MutableHistory;
        this.granularity = record.granularity ?? 'whole';
        this.selectableKinds = Object.freeze({
          ...DEFAULT_SELECTABLE_KINDS,
          ...(record.selectableKinds ?? {}),
        });
        this.installMembers(filterValidMembers(record.state, liveEntityIds));
      }
    } catch (error) {
      this.history = emptyHistory(projectId);
      this.installMembers(recoverPersistedState(persisted, liveEntityIds));
      this.onRecovery(
        `Selection history for ${projectId} was corrupt and was reset without changing the document: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.changed(false);
  }

  async closeProject(): Promise<void> {
    if (!this.projectId) return;
    this.queuePersist();
    await this.flushPersistence();
    this.projectId = null;
    this.liveEntityIds = null;
    this.entityKind = () => undefined;
    this.hiddenEntityIds = new Set();
    this.history = emptyHistory('unloaded');
    this.granularity = 'whole';
    this.selectableKinds = DEFAULT_SELECTABLE_KINDS;
    this.installMembers([]);
    this.candidates = null;
    this.segmentReconciliation = [];
    this.changed(false);
  }

  async switchProject(
    projectId: string,
    liveEntityIds: ReadonlySet<string>,
    entityKind: (entityId: string) => SelectionEntityKind | undefined,
    hiddenEntityIds: Iterable<string> = [],
  ): Promise<void> {
    await this.closeProject();
    await this.openProject(projectId, liveEntityIds, entityKind, hiddenEntityIds);
  }

  replace(entityIds: Iterable<string>, gestureSession: string | null = null): boolean {
    return this.commit(entityMembers(entityIds), gestureSession);
  }

  replaceMembers(
    members: Iterable<SelectionMember>,
    gestureSession: string | null = null,
  ): boolean {
    return this.commit(members, gestureSession);
  }

  /** Automation requires all-or-nothing validation rather than silently pruning stale ids. */
  replaceExisting(entityIds: Iterable<string>, gestureSession: string | null = null): boolean {
    const ids = [...entityIds];
    for (const id of ids) {
      assertEntityId(id);
      if (this.liveEntityIds && !this.liveEntityIds.has(id)) {
        throw new RangeError(`selection entity does not exist: ${id}`);
      }
    }
    return this.commit(entityMembers(ids), gestureSession);
  }

  /** UIP-D2 modality table plus UIP-D15's click exclusion. */
  pointerSelect(
    entityId: string | null,
    options: { readonly modality: 'mouse' | 'touch'; readonly ctrlKey?: boolean },
  ): boolean {
    this.invalidateCandidates('newClick');
    if (!entityId || !this.clickSelectable(entityId)) return false;
    if (options.ctrlKey) return this.toggle(entityId);
    if (options.modality === 'touch' && this.entityIds.size === 1 && this.entityIds.has(entityId)) {
      return this.clear();
    }
    return this.replace([entityId]);
  }

  toggle(entityId: string, gestureSession: string | null = null): boolean {
    assertEntityId(entityId);
    if (!this.projectId) throw new Error('selection store has no open project');
    if (this.liveEntityIds && !this.liveEntityIds.has(entityId)) {
      throw new RangeError(`selection entity does not exist: ${entityId}`);
    }
    const key = entityKey(entityId);
    const selected = this.members.has(key);
    if (selected) this.members.delete(key);
    else this.members.set(key, { kind: 'entity', entityId });
    const entityIds = new Set(this.entityIds);
    const parentCount = (this.parentCounts.get(entityId) ?? 0) + (selected ? -1 : 1);
    if (parentCount <= 0) {
      this.parentCounts.delete(entityId);
      entityIds.delete(entityId);
    } else {
      this.parentCounts.set(entityId, parentCount);
      entityIds.add(entityId);
    }
    this.entityIds = entityIds;
    if (CLOUD_KINDS.has(this.entityKind(entityId) ?? '')) {
      const haloIds = new Set(this.haloIds);
      if (parentCount <= 0) haloIds.delete(entityId);
      else haloIds.add(entityId);
      this.haloIds = haloIds;
    }
    const after = selectionState(
      [...this.members.values()],
      this.granularity,
      this.selectableKinds,
    );
    this.recordHistory(this.historyState, after, gestureSession, null);
    this.historyState = after;
    this.changed();
    return true;
  }

  clear(gestureSession: string | null = null): boolean {
    this.invalidateCandidates('escape');
    if (this.members.size === 0) return false;
    return this.commitMap(new Map(), gestureSession, null, true);
  }

  /** Journal-apply hook. Prune is recorded, but undo revalidates and never resurrects a deletion. */
  pruneDeleted(entityIds: Iterable<string>): boolean {
    const deleted = new Set(entityIds);
    if (deleted.size === 0) return false;
    if (this.liveEntityIds instanceof Set) {
      for (const id of deleted) this.liveEntityIds.delete(id);
    }
    const next = [...this.members.values()].filter((member) => !deleted.has(parentId(member)));
    return this.commit(next, null, 'journal-delete-prune');
  }

  /** SE-D19 click bridge: primitive slots become canonical stable locators, never index-only ids. */
  selectCurveSegment(index: CurveSegmentIndex, primitiveId: number): boolean {
    if (!Number.isSafeInteger(primitiveId) || primitiveId < 0) {
      throw new RangeError('segment primitiveId must be a non-negative safe integer');
    }
    validateSegmentIndex(index);
    const entry = index.entries.find((candidate) => candidate.primitiveId === primitiveId);
    if (!entry)
      throw new RangeError(`curve primitive ${primitiveId} has no stable segment locator`);
    const ref = segmentRef(index, entry);
    return this.replaceMembers([{ kind: 'curveSubentity', ref }]);
  }

  /**
   * Source-edit hook. Only the same stable member with an explicit old-hash
   * admission may remap; deletion or ambiguity prunes with the typed reason.
   */
  reconcileCurveSubentities(index: CurveSegmentIndex): readonly SegmentReconciliation[] {
    validateSegmentIndex(index);
    const byStableId = new Map(index.entries.map((entry) => [entry.stableMemberId, entry]));
    const disclosures: SegmentReconciliation[] = [];
    const next = [...this.members.values()].flatMap((member): SelectionMember[] => {
      if (member.kind !== 'curveSubentity' || String(member.ref.parentId) !== index.parentId) {
        return [member];
      }
      const entry = byStableId.get(member.ref.stableMemberId);
      if (
        !entry ||
        (entry.semanticHash !== String(member.ref.semanticHash) &&
          !entry.previousSemanticHashes?.includes(String(member.ref.semanticHash)))
      ) {
        disclosures.push({
          kind: 'pruned',
          parentId: index.parentId,
          stableMemberId: member.ref.stableMemberId,
          reason: 'Segment no longer exists',
        });
        return [];
      }
      disclosures.push({
        kind: 'remapped',
        parentId: index.parentId,
        stableMemberId: entry.stableMemberId,
        fromRevision: member.ref.parentRevision,
        toRevision: index.parentRevision,
      });
      return [{ kind: 'curveSubentity', ref: segmentRef(index, entry) }];
    });
    this.segmentReconciliation = Object.freeze(disclosures);
    const membershipChanged = this.commit(next, null, `segment-source-edit:${index.parentId}`);
    if (disclosures.length > 0 && !membershipChanged) this.changed(false);
    return this.segmentReconciliation;
  }

  /** Hide is deliberately a no-op for membership (UIP-D18/G-SE-P4). */
  entitiesHidden(entityIds: Iterable<string>, hidden = true): void {
    for (const id of entityIds) {
      if (hidden) this.hiddenEntityIds.add(id);
      else this.hiddenEntityIds.delete(id);
    }
  }

  setGranularity(value: SelectionGranularity): boolean {
    if (value !== 'whole' && value !== 'segments')
      throw new TypeError('invalid selection granularity');
    if (this.granularity === value) return false;
    const before = this.historyState;
    this.granularity = value;
    const after = selectionState(
      [...this.members.values()],
      this.granularity,
      this.selectableKinds,
    );
    this.recordHistory(before, after, null, 'selection-granularity');
    this.historyState = after;
    this.candidates = null;
    this.changed();
    return true;
  }

  setSelectableKind(kind: string, value: boolean): boolean {
    if (!kind.trim()) throw new TypeError('selectable kind is required');
    if (this.selectableKinds[kind] === value) return false;
    const before = this.historyState;
    this.selectableKinds = Object.freeze({ ...this.selectableKinds, [kind]: value });
    const after = selectionState(
      [...this.members.values()],
      this.granularity,
      this.selectableKinds,
    );
    this.recordHistory(before, after, null, `selection-kind:${kind}`);
    this.historyState = after;
    this.candidates = null;
    this.changed();
    return true;
  }

  isKindSelectable(kind: string): boolean {
    return this.selectableKinds[selectionKindGroup(kind)] ?? true;
  }

  undo(): boolean {
    if (this.history.cursor === 0) return false;
    const entry = this.history.entries[this.history.cursor - 1]!;
    this.history.cursor -= 1;
    this.installState(this.validatedState(entry.before));
    this.changed();
    return true;
  }

  redo(): boolean {
    if (this.history.cursor >= this.history.head) return false;
    const entry = this.history.entries[this.history.cursor]!;
    this.history.cursor += 1;
    this.installState(this.validatedState(entry.after));
    this.changed();
    return true;
  }

  clearHistory(): void {
    this.history.entries = [];
    this.history.cursor = 0;
    this.history.head = 0;
    this.changed();
  }

  setCandidates(items: readonly SelectionCandidate[], index = 0): void {
    if (items.length < 2) {
      this.invalidateCandidates('newClick');
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
      throw new RangeError('candidate index is outside the stable candidate set');
    }
    this.candidates = Object.freeze({
      items: Object.freeze([...items]),
      index,
      statusText: `${index + 1} of ${items.length} under cursor — Up/Down cycles`,
    });
    this.changed(false);
  }

  cycleCandidate(direction: 1 | -1): SelectionCandidate | null {
    const current = this.candidates;
    if (!current) return null;
    const index = (current.index + direction + current.items.length) % current.items.length;
    const candidate = current.items[index]!;
    this.candidates = Object.freeze({
      ...current,
      index,
      statusText: `${index + 1} of ${current.items.length} under cursor — Up/Down cycles`,
    });
    this.replace([candidate.entityId]);
    this.changed(false);
    return candidate;
  }

  invalidateCandidates(_reason: CandidateInvalidationReason): void {
    if (!this.candidates) return;
    this.candidates = null;
    this.changed(false);
  }

  async flushPersistence(): Promise<void> {
    await this.persistTail;
  }

  private clickSelectable(entityId: string): boolean {
    if (this.liveEntityIds && !this.liveEntityIds.has(entityId)) return false;
    if (this.hiddenEntityIds.has(entityId)) return false;
    const kind = this.entityKind(entityId) ?? '';
    return !CLOUD_KINDS.has(kind) && this.isKindSelectable(kind);
  }

  private commit(
    members: Iterable<SelectionMember>,
    gestureSession: string | null,
    coalescingKey: string | null = null,
  ): boolean {
    if (!this.projectId) throw new Error('selection store has no open project');
    const next = normalizeMembers(members, this.liveEntityIds);
    return this.commitMap(next, gestureSession, coalescingKey);
  }

  private commitMap(
    next: Map<string, SelectionMember>,
    gestureSession: string | null,
    coalescingKey: string | null = null,
    knownDifferent = false,
  ): boolean {
    if (!this.projectId) throw new Error('selection store has no open project');
    if (!knownDifferent && sameKeys(this.members, next)) return false;
    const before = this.historyState;
    const after = selectionState([...next.values()], this.granularity, this.selectableKinds);
    this.recordHistory(before, after, gestureSession, coalescingKey);
    this.installMap(next);
    this.historyState = after;
    this.changed();
    return true;
  }

  private recordHistory(
    before: SelectionStateV1,
    after: SelectionStateV1,
    gestureSession: string | null,
    coalescingKey: string | null,
  ): void {
    if (this.history.cursor < this.history.head) this.history.entries.splice(this.history.cursor);
    this.history.entries.push({
      sequence: ++this.history.localSequence,
      before,
      after,
      gestureSession,
      coalescingKey,
    });
    if (this.history.entries.length > this.historyDepth) this.history.entries.shift();
    this.history.head = this.history.entries.length;
    this.history.cursor = this.history.head;
  }

  private validatedState(state: SelectionStateV1): SelectionStateV1 {
    return selectionState(
      filterValidMembers(state.members, this.liveEntityIds),
      state.granularity,
      state.selectableKinds,
    );
  }

  private installMembers(members: Iterable<SelectionMember>): void {
    const normalized = normalizeMembers(members, this.liveEntityIds);
    this.installMap(normalized);
    this.historyState = selectionState(
      [...normalized.values()],
      this.granularity,
      this.selectableKinds,
    );
  }

  private installState(state: SelectionStateV1): void {
    this.granularity = state.granularity;
    this.selectableKinds = Object.freeze({ ...state.selectableKinds });
    this.installMembers(state.members);
  }

  private installMap(members: Map<string, SelectionMember>): void {
    this.members = members;
    const parentCounts = new Map<string, number>();
    for (const member of members.values()) {
      const id = parentId(member);
      parentCounts.set(id, (parentCounts.get(id) ?? 0) + 1);
    }
    this.parentCounts = parentCounts;
    this.entityIds = new Set(parentCounts.keys());
    this.haloIds = new Set();
    for (const entityId of this.entityIds) {
      if (CLOUD_KINDS.has(this.entityKind(entityId) ?? '')) this.haloIds.add(entityId);
    }
  }

  private changed(persist = true): void {
    this.revision += 1;
    this.cachedSnapshot = null;
    if (persist) this.queuePersist();
    for (const listener of this.listeners) listener();
  }

  private queuePersist(): void {
    if (!this.persistence || !this.projectId) return;
    const projectId = this.projectId;
    const state = [...this.members.values()];
    const granularity = this.granularity;
    const selectableKinds = this.selectableKinds;
    const history = cloneHistory(this.history);
    this.persistTail = this.persistTail
      .then(async () => {
        const sealed = await sealHistory(history);
        await this.persistence!.store(projectId, {
          schemaId: SELECTION_STATE_SCHEMA_ID,
          schemaVersion: 1,
          state,
          granularity,
          selectableKinds,
          history: sealed,
        });
      })
      .catch((error: unknown) => {
        this.onRecovery(
          `Selection persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}

export class MemorySelectionPersistence implements SelectionPersistence {
  readonly records = new Map<string, SelectionPersistenceRecordV1>();
  async load(projectId: string): Promise<unknown | null> {
    return this.records.get(projectId) ?? null;
  }
  async store(projectId: string, record: SelectionPersistenceRecordV1): Promise<void> {
    this.records.set(projectId, structuredClone(record));
  }
}

export class LocalStorageSelectionPersistence
  extends LocalStorageLocalHistoryPersistence<SelectionPersistenceRecordV1>
  implements SelectionPersistence
{
  constructor(storage: Pick<Storage, 'getItem' | 'setItem'>, prefix = 'hcad.selection.v1:') {
    super(storage, prefix);
  }
}

export interface SharedPropertySelectionMember<Value = unknown> {
  readonly kind: string;
  readonly fields: Readonly<Record<string, Value>>;
}

export interface SharedPropertySet<Value = unknown> {
  readonly count: number;
  readonly perKind: Readonly<Record<string, number>>;
  readonly fields: Readonly<Record<string, Value | typeof MIXED>>;
}

/** Pure, demand-driven intersection; SelectionStore never computes this during membership edits. */
export function sharedPropertySet<Value = unknown>(
  selection: readonly SharedPropertySelectionMember<Value>[],
): SharedPropertySet<Value> {
  const perKind: Record<string, number> = {};
  for (const member of selection) perKind[member.kind] = (perKind[member.kind] ?? 0) + 1;
  if (selection.length === 0) return { count: 0, perKind, fields: {} };
  const fields: Record<string, Value | typeof MIXED> = {};
  for (const key of Object.keys(selection[0]!.fields)) {
    if (!selection.every((member) => Object.hasOwn(member.fields, key))) continue;
    const first = selection[0]!.fields[key]!;
    fields[key] = selection.every((member) => propertyEqual(member.fields[key], first))
      ? first
      : MIXED;
  }
  return { count: selection.length, perKind, fields };
}

export interface JournaledPropertyBatch<Value = unknown> {
  readonly commandId: string;
  readonly entityIds: readonly string[];
  readonly assignments: readonly { readonly field: string; readonly value: Value }[];
}

export async function assignToAll<Value>(
  selection: readonly { readonly entityId: string }[],
  field: string,
  value: Value,
  journal: (batch: JournaledPropertyBatch<Value>) => Promise<void>,
): Promise<JournaledPropertyBatch<Value>> {
  if (!field.trim()) throw new TypeError('property field is required');
  const batch = Object.freeze({
    commandId: `selection/property/${globalThis.crypto.randomUUID()}`,
    entityIds: Object.freeze([...new Set(selection.map((member) => member.entityId))]),
    assignments: Object.freeze([{ field, value }]),
  });
  if (batch.entityIds.length === 0) throw new Error('property assignment requires a selection');
  await journal(batch);
  return batch;
}

export const SELECTION_COMMAND_TABLE = Object.freeze({
  'select.get': { capability: 'view.read', mutates: false },
  'select.set': { capability: 'view.write', mutates: true },
  'select.toggle': { capability: 'view.write', mutates: true },
  'select.clear': { capability: 'view.write', mutates: true },
  'select.undo': { capability: 'view.write', mutates: true },
  'select.redo': { capability: 'view.write', mutates: true },
  'select.candidates': { capability: 'view.read', mutates: false },
  // S-01 names retained as wrappers; they do not own state or execution.
  'select.list': { capability: 'view.read', mutates: false, aliasFor: 'select.get' },
  'select.add': { capability: 'view.write', mutates: true, aliasFor: 'select.set' },
  'select.remove': { capability: 'view.write', mutates: true, aliasFor: 'select.toggle' },
  'selection.history.get': { capability: 'view.read', mutates: false, aliasFor: 'select.get' },
  'selection.history.undo': { capability: 'view.write', mutates: true, aliasFor: 'select.undo' },
  'selection.history.redo': { capability: 'view.write', mutates: true, aliasFor: 'select.redo' },
  'selection.history.clear': { capability: 'view.write', mutates: true },
  'selection.granularity.get': { capability: 'view.read', mutates: false },
  'selection.granularity.set': { capability: 'view.write', mutates: true },
  'selection.kind_filter.get': { capability: 'view.read', mutates: false },
  'selection.kind_filter.set': { capability: 'view.write', mutates: true },
} as const);

export type SelectionCommandId = keyof typeof SELECTION_COMMAND_TABLE;

export function executeSelectionCommand(
  store: SelectionStore,
  commandId: SelectionCommandId,
  request: unknown,
): { readonly schemaId: 'hcad.selection-command-result@1'; readonly payload: unknown } {
  const payload = operationPayload(request);
  switch (commandId) {
    case 'select.get':
    case 'select.list':
    case 'selection.history.get':
    case 'selection.granularity.get':
    case 'selection.kind_filter.get':
      break;
    case 'select.set':
      store.replaceExisting(requiredIds(payload));
      break;
    case 'select.toggle':
      store.toggle(requiredId(payload));
      break;
    case 'select.add':
      store.replaceExisting([...store.getSnapshot().selectedEntityIds, ...requiredIds(payload)]);
      break;
    case 'select.remove': {
      const removed = new Set(requiredIds(payload));
      store.replace([...store.getSnapshot().selectedEntityIds].filter((id) => !removed.has(id)));
      break;
    }
    case 'select.clear':
      store.clear();
      break;
    case 'select.undo':
    case 'selection.history.undo':
      store.undo();
      break;
    case 'select.redo':
    case 'selection.history.redo':
      store.redo();
      break;
    case 'selection.history.clear':
      store.clearHistory();
      break;
    case 'selection.granularity.set':
      store.setGranularity(requiredGranularity(payload));
      break;
    case 'selection.kind_filter.set': {
      const { kind, selectable } = requiredKindFilter(payload);
      store.setSelectableKind(kind, selectable);
      break;
    }
    case 'select.candidates':
      break;
  }
  const snapshot = store.getSnapshot();
  return {
    schemaId: 'hcad.selection-command-result@1',
    payload:
      commandId === 'select.candidates'
        ? snapshot.candidates
        : commandId === 'selection.granularity.get'
          ? { granularity: snapshot.granularity }
          : commandId === 'selection.kind_filter.get'
            ? { selectableKinds: snapshot.selectableKinds }
            : {
                projectId: snapshot.projectId,
                entityIds: [...snapshot.selectedEntityIds],
                canUndo: snapshot.canUndo,
                canRedo: snapshot.canRedo,
              },
  };
}

function requiredGranularity(payload: unknown): SelectionGranularity {
  if (!isRecord(payload) || (payload.value !== 'whole' && payload.value !== 'segments')) {
    throw new TypeError('selection.granularity.set requires whole or segments');
  }
  return payload.value;
}

function requiredKindFilter(payload: unknown): { kind: string; selectable: boolean } {
  if (
    !isRecord(payload) ||
    typeof payload.kind !== 'string' ||
    !payload.kind.trim() ||
    typeof payload.selectable !== 'boolean'
  ) {
    throw new TypeError('selection.kind_filter.set requires kind and selectable');
  }
  return { kind: payload.kind, selectable: payload.selectable };
}

function operationPayload(request: unknown): unknown {
  if (
    !isRecord(request) ||
    request.schemaId !== 'hcad.selection-command@1' ||
    !('payload' in request)
  ) {
    throw new TypeError('selection commands require the hcad.selection-command@1 envelope');
  }
  return request.payload;
}

function requiredIds(payload: unknown): readonly string[] {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.entityIds) ||
    payload.entityIds.some((id) => typeof id !== 'string' || !id.trim())
  ) {
    throw new TypeError('select.set requires non-empty string entityIds');
  }
  return payload.entityIds;
}

function requiredId(payload: unknown): string {
  if (!isRecord(payload) || typeof payload.entityId !== 'string' || !payload.entityId.trim()) {
    throw new TypeError('select.toggle requires entityId');
  }
  return payload.entityId;
}

function emptyHistory(projectId: string): MutableHistory {
  return {
    schemaId: LOCAL_HISTORY_SCHEMA_ID,
    schemaVersion: 1,
    projectId,
    streamKind: 'selection',
    localSequence: 0,
    cursor: 0,
    head: 0,
    entries: [],
    checksum: EMPTY_SHA256,
  };
}

function selectionState(
  members: readonly SelectionMember[],
  granularity: SelectionGranularity = 'whole',
  selectableKinds: Readonly<Record<string, boolean>> = DEFAULT_SELECTABLE_KINDS,
): SelectionStateV1 {
  return {
    schemaId: SELECTION_STATE_SCHEMA_ID,
    schemaVersion: 1,
    members,
    granularity,
    selectableKinds: Object.freeze({ ...selectableKinds }),
  };
}

function entityMembers(ids: Iterable<string>): SelectionMember[] {
  return [...ids].map((entityId) => ({ kind: 'entity' as const, entityId }));
}

function normalizeMembers(
  members: Iterable<SelectionMember>,
  live: ReadonlySet<string> | null,
): Map<string, SelectionMember> {
  const result = new Map<string, SelectionMember>();
  for (const member of members) {
    validateMember(member);
    if (live && !live.has(parentId(member))) continue;
    result.set(memberKey(member), member);
  }
  return result;
}

function filterValidMembers(
  members: readonly SelectionMember[],
  live: ReadonlySet<string> | null,
): SelectionMember[] {
  return [...normalizeMembers(members, live).values()];
}

function validateMember(member: SelectionMember): void {
  if (!isRecord(member)) throw new TypeError('selection member must be an object');
  if (member.kind === 'entity') return assertEntityId(member.entityId);
  if (member.kind !== 'curveSubentity' || !isRecord(member.ref))
    throw new TypeError('invalid selection member kind');
  const ref = member.ref as CurveSubentityRefV1;
  if (ref.schemaId !== 'hcad.curve-subentity-ref@1' || ref.schemaVersion !== 1)
    throw new TypeError('invalid hcad.curve-subentity-ref@1 member');
  assertEntityId(String(ref.parentId));
  if (
    !Number.isSafeInteger(ref.parentRevision) ||
    ref.parentRevision < 0 ||
    !ref.topologyKind.trim() ||
    !ref.stableMemberId.trim() ||
    ref.directedParameterInterval.length !== 2 ||
    ref.directedParameterInterval.some((value: number) => !Number.isFinite(value)) ||
    (ref.loopId !== null && !ref.loopId.trim()) ||
    (ref.useId !== null && !ref.useId.trim()) ||
    !/^[0-9a-f]{64}$/u.test(String(ref.semanticHash))
  ) {
    throw new TypeError('invalid stable curve-subentity locator');
  }
}

function assertEntityId(entityId: string): void {
  if (typeof entityId !== 'string' || !entityId.trim()) throw new TypeError('entityId is required');
}

function parentId(member: SelectionMember): string {
  return member.kind === 'entity' ? member.entityId : String(member.ref.parentId);
}

function entityKey(entityId: string): string {
  return `e:${entityId}`;
}
function memberKey(member: SelectionMember): string {
  return member.kind === 'entity'
    ? entityKey(member.entityId)
    : `s:${member.ref.parentId}:${member.ref.parentRevision}:${member.ref.topologyKind}:${member.ref.stableMemberId}:${member.ref.directedParameterInterval.join(',')}:${member.ref.loopId ?? ''}:${member.ref.useId ?? ''}:${member.ref.semanticHash}`;
}

function segmentRef(index: CurveSegmentIndex, entry: CurveSegmentIndexEntry): CurveSubentityRefV1 {
  return {
    schemaId: 'hcad.curve-subentity-ref@1',
    schemaVersion: 1,
    parentId: index.parentId,
    parentRevision: index.parentRevision,
    topologyKind: entry.topologyKind,
    stableMemberId: entry.stableMemberId,
    directedParameterInterval: [...entry.directedParameterInterval],
    loopId: entry.loopId ?? null,
    useId: entry.useId ?? null,
    semanticHash: entry.semanticHash,
  } as CurveSubentityRefV1;
}

function validateSegmentIndex(index: CurveSegmentIndex): void {
  assertEntityId(index.parentId);
  if (!Number.isSafeInteger(index.parentRevision) || index.parentRevision < 0) {
    throw new TypeError('curve segment index requires a non-negative parent revision');
  }
  const primitives = new Set<number>();
  const stableIds = new Set<string>();
  for (const entry of index.entries) {
    if (
      !Number.isSafeInteger(entry.primitiveId) ||
      entry.primitiveId < 0 ||
      !entry.topologyKind.trim() ||
      !entry.stableMemberId.trim() ||
      entry.directedParameterInterval.length !== 2 ||
      entry.directedParameterInterval.some((value) => !Number.isFinite(value)) ||
      !/^[0-9a-f]{64}$/u.test(entry.semanticHash) ||
      entry.previousSemanticHashes?.some((hash) => !/^[0-9a-f]{64}$/u.test(hash))
    ) {
      throw new TypeError('invalid curve segment index entry');
    }
    if (primitives.has(entry.primitiveId) || stableIds.has(entry.stableMemberId)) {
      throw new RangeError('curve segment index contains an ambiguous locator');
    }
    primitives.add(entry.primitiveId);
    stableIds.add(entry.stableMemberId);
  }
}

function sameKeys(
  left: ReadonlyMap<string, unknown>,
  right: ReadonlyMap<string, unknown>,
): boolean {
  if (left.size !== right.size) return false;
  for (const key of left.keys()) if (!right.has(key)) return false;
  return true;
}

function cloneHistory(history: MutableHistory): MutableHistory {
  return structuredClone(history);
}

async function sealHistory(history: MutableHistory): Promise<LocalHistoryV1> {
  history.checksum = EMPTY_SHA256;
  history.checksum = await sha256Hex(JSON.stringify(history));
  return history as LocalHistoryV1;
}

async function parsePersistenceRecord(
  input: unknown,
  projectId: string,
): Promise<SelectionPersistenceRecordV1> {
  if (
    !isRecord(input) ||
    input.schemaId !== SELECTION_STATE_SCHEMA_ID ||
    input.schemaVersion !== 1 ||
    !Array.isArray(input.state) ||
    (input.granularity !== undefined &&
      input.granularity !== 'whole' &&
      input.granularity !== 'segments') ||
    (input.selectableKinds !== undefined && !isBooleanRecord(input.selectableKinds)) ||
    !isRecord(input.history)
  ) {
    throw new TypeError('invalid persisted selection envelope');
  }
  const history = input.history as unknown as MutableHistory;
  if (
    history.schemaId !== LOCAL_HISTORY_SCHEMA_ID ||
    history.schemaVersion !== 1 ||
    history.projectId !== projectId ||
    history.streamKind !== 'selection' ||
    !Number.isSafeInteger(history.localSequence) ||
    !Number.isInteger(history.cursor) ||
    !Number.isInteger(history.head) ||
    !Array.isArray(history.entries) ||
    history.cursor < 0 ||
    history.cursor > history.head ||
    history.head > history.entries.length ||
    typeof history.checksum !== 'string'
  ) {
    throw new TypeError('invalid selection local-history header');
  }
  const expected = history.checksum;
  const unsealed = cloneHistory(history);
  unsealed.checksum = EMPTY_SHA256;
  if (expected !== (await sha256Hex(JSON.stringify(unsealed))))
    throw new TypeError('selection local-history checksum mismatch');
  for (const member of input.state as SelectionMember[]) validateMember(member);
  for (const entry of history.entries) {
    if (!isRecord(entry) || !isSelectionState(entry.before) || !isSelectionState(entry.after))
      throw new TypeError('invalid selection local-history entry');
    for (const member of [...entry.before.members, ...entry.after.members]) validateMember(member);
  }
  return input as unknown as SelectionPersistenceRecordV1;
}

function isSelectionState(value: unknown): value is SelectionStateV1 {
  return (
    isRecord(value) &&
    value.schemaId === SELECTION_STATE_SCHEMA_ID &&
    value.schemaVersion === 1 &&
    Array.isArray(value.members) &&
    (value.granularity === undefined ||
      value.granularity === 'whole' ||
      value.granularity === 'segments') &&
    (value.selectableKinds === undefined || isBooleanRecord(value.selectableKinds))
  );
}

function selectionKindGroup(kind: string): string {
  if (kind === 'SinglePoint' || kind === 'GroundControlPoint' || kind === 'PointCloudSegment')
    return 'points';
  if (kind === 'Polyline3D' || kind === 'Axis' || kind === 'AlignmentElement') return 'lines';
  if (
    kind === 'Surface' ||
    kind === 'Mesh' ||
    kind === 'TexturedMesh' ||
    kind === 'DigitalElevationModel'
  )
    return 'surfaces';
  if (kind === 'Solid') return 'solids';
  if (CLOUD_KINDS.has(kind)) return 'clouds';
  return kind;
}

function isBooleanRecord(value: unknown): value is Readonly<Record<string, boolean>> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'boolean');
}

function recoverPersistedState(input: unknown, live: ReadonlySet<string>): SelectionMember[] {
  if (!isRecord(input) || !Array.isArray(input.state)) return [];
  try {
    return filterValidMembers(input.state as SelectionMember[], live);
  } catch {
    return [];
  }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function propertyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => propertyEqual(value, right[index]))
    );
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && propertyEqual(left[key], right[key]))
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
