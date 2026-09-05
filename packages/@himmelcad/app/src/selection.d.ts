import type { CurveSubentityRefV1, LocalHistoryV1 } from '@himmelcad/data/canonical';
export declare const SELECTION_STATE_SCHEMA_ID: "hcad.selection-state@1";
export declare const LOCAL_HISTORY_SCHEMA_ID: "hcad.local-history@1";
export declare const MIXED: unique symbol;
export type SelectionMember = {
    readonly kind: 'entity';
    readonly entityId: string;
} | {
    readonly kind: 'curveSubentity';
    readonly ref: CurveSubentityRefV1;
};
export type SelectionEntityKind = string;
export interface SelectionCandidate {
    readonly entityId: string;
    readonly name: string;
    readonly kind: SelectionEntityKind;
}
export type CandidateInvalidationReason = 'cameraMove' | 'newClick' | 'toolCancel' | 'permissionChange' | 'overlayChange' | 'kindFilterChange' | 'renderGenerationChange' | 'deviceLoss' | 'viewportBlur' | 'escape';
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
export declare function selectionCandidateMenuContribution(state: SelectionCandidateState | null): SelectionCandidateMenuContribution | null;
export interface SelectionSnapshot {
    readonly projectId: string | null;
    readonly members: readonly SelectionMember[];
    readonly selectedEntityIds: ReadonlySet<string>;
    readonly boundingBoxHaloEntityIds: ReadonlySet<string>;
    readonly candidates: SelectionCandidateState | null;
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly revision: number;
}
export interface SelectionPersistenceRecordV1 {
    readonly schemaId: typeof SELECTION_STATE_SCHEMA_ID;
    readonly schemaVersion: 1;
    readonly state: readonly SelectionMember[];
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
/** Builder's sole selection owner. All mutation paths, including automation, terminate here. */
export declare class SelectionStore {
    private projectId;
    private members;
    private entityIds;
    private parentCounts;
    private haloIds;
    private hiddenEntityIds;
    private liveEntityIds;
    private entityKind;
    private history;
    private historyState;
    private candidates;
    private readonly listeners;
    private revision;
    private cachedSnapshot;
    private persistTail;
    private readonly persistence;
    private readonly historyDepth;
    private readonly onRecovery;
    constructor(options?: SelectionStoreOptions);
    getSnapshot: () => SelectionSnapshot;
    subscribe: (listener: () => void) => (() => void);
    openProject(projectId: string, liveEntityIds: ReadonlySet<string>, entityKind: (entityId: string) => SelectionEntityKind | undefined, hiddenEntityIds?: Iterable<string>): Promise<void>;
    closeProject(): Promise<void>;
    switchProject(projectId: string, liveEntityIds: ReadonlySet<string>, entityKind: (entityId: string) => SelectionEntityKind | undefined, hiddenEntityIds?: Iterable<string>): Promise<void>;
    replace(entityIds: Iterable<string>, gestureSession?: string | null): boolean;
    replaceMembers(members: Iterable<SelectionMember>, gestureSession?: string | null): boolean;
    /** Automation requires all-or-nothing validation rather than silently pruning stale ids. */
    replaceExisting(entityIds: Iterable<string>, gestureSession?: string | null): boolean;
    /** UIP-D2 modality table plus UIP-D15's click exclusion. */
    pointerSelect(entityId: string | null, options: {
        readonly modality: 'mouse' | 'touch';
        readonly ctrlKey?: boolean;
    }): boolean;
    toggle(entityId: string, gestureSession?: string | null): boolean;
    clear(gestureSession?: string | null): boolean;
    /** Journal-apply hook. Prune is recorded, but undo revalidates and never resurrects a deletion. */
    pruneDeleted(entityIds: Iterable<string>): boolean;
    /** Hide is deliberately a no-op for membership (UIP-D18/G-SE-P4). */
    entitiesHidden(entityIds: Iterable<string>, hidden?: boolean): void;
    undo(): boolean;
    redo(): boolean;
    clearHistory(): void;
    setCandidates(items: readonly SelectionCandidate[], index?: number): void;
    cycleCandidate(direction: 1 | -1): SelectionCandidate | null;
    invalidateCandidates(_reason: CandidateInvalidationReason): void;
    flushPersistence(): Promise<void>;
    private clickSelectable;
    private commit;
    private commitMap;
    private recordHistory;
    private validatedState;
    private installMembers;
    private installMap;
    private changed;
    private queuePersist;
}
export declare class MemorySelectionPersistence implements SelectionPersistence {
    readonly records: Map<string, SelectionPersistenceRecordV1>;
    load(projectId: string): Promise<unknown | null>;
    store(projectId: string, record: SelectionPersistenceRecordV1): Promise<void>;
}
export declare class LocalStorageSelectionPersistence implements SelectionPersistence {
    private readonly storage;
    private readonly prefix;
    constructor(storage: Pick<Storage, 'getItem' | 'setItem'>, prefix?: string);
    load(projectId: string): Promise<unknown | null>;
    store(projectId: string, record: SelectionPersistenceRecordV1): Promise<void>;
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
export declare function sharedPropertySet<Value = unknown>(selection: readonly SharedPropertySelectionMember<Value>[]): SharedPropertySet<Value>;
export interface JournaledPropertyBatch<Value = unknown> {
    readonly commandId: string;
    readonly entityIds: readonly string[];
    readonly assignments: readonly {
        readonly field: string;
        readonly value: Value;
    }[];
}
export declare function assignToAll<Value>(selection: readonly {
    readonly entityId: string;
}[], field: string, value: Value, journal: (batch: JournaledPropertyBatch<Value>) => Promise<void>): Promise<JournaledPropertyBatch<Value>>;
export declare const SELECTION_COMMAND_TABLE: Readonly<{
    readonly 'select.get': {
        readonly capability: "view.read";
        readonly mutates: false;
    };
    readonly 'select.set': {
        readonly capability: "view.write";
        readonly mutates: true;
    };
    readonly 'select.toggle': {
        readonly capability: "view.write";
        readonly mutates: true;
    };
    readonly 'select.clear': {
        readonly capability: "view.write";
        readonly mutates: true;
    };
    readonly 'select.undo': {
        readonly capability: "view.write";
        readonly mutates: true;
    };
    readonly 'select.redo': {
        readonly capability: "view.write";
        readonly mutates: true;
    };
    readonly 'select.candidates': {
        readonly capability: "view.read";
        readonly mutates: false;
    };
    readonly 'select.list': {
        readonly capability: "view.read";
        readonly mutates: false;
        readonly aliasFor: "select.get";
    };
    readonly 'select.add': {
        readonly capability: "view.write";
        readonly mutates: true;
        readonly aliasFor: "select.set";
    };
    readonly 'select.remove': {
        readonly capability: "view.write";
        readonly mutates: true;
        readonly aliasFor: "select.toggle";
    };
    readonly 'selection.history.get': {
        readonly capability: "view.read";
        readonly mutates: false;
        readonly aliasFor: "select.get";
    };
    readonly 'selection.history.undo': {
        readonly capability: "view.write";
        readonly mutates: true;
        readonly aliasFor: "select.undo";
    };
    readonly 'selection.history.redo': {
        readonly capability: "view.write";
        readonly mutates: true;
        readonly aliasFor: "select.redo";
    };
    readonly 'selection.history.clear': {
        readonly capability: "view.write";
        readonly mutates: true;
    };
}>;
export type SelectionCommandId = keyof typeof SELECTION_COMMAND_TABLE;
export declare function executeSelectionCommand(store: SelectionStore, commandId: SelectionCommandId, request: unknown): {
    readonly schemaId: 'hcad.selection-command-result@1';
    readonly payload: unknown;
};
//# sourceMappingURL=selection.d.ts.map