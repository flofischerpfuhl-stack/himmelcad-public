"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SELECTION_COMMAND_TABLE = exports.LocalStorageSelectionPersistence = exports.MemorySelectionPersistence = exports.SelectionStore = exports.MIXED = exports.LOCAL_HISTORY_SCHEMA_ID = exports.SELECTION_STATE_SCHEMA_ID = void 0;
exports.selectionCandidateMenuContribution = selectionCandidateMenuContribution;
exports.sharedPropertySet = sharedPropertySet;
exports.assignToAll = assignToAll;
exports.executeSelectionCommand = executeSelectionCommand;
exports.SELECTION_STATE_SCHEMA_ID = 'hcad.selection-state@1';
exports.LOCAL_HISTORY_SCHEMA_ID = 'hcad.local-history@1';
exports.MIXED = Symbol('himmelcad.selection.mixed');
/** UIP-D6 registry is not landed yet; S-06 can consume this contribution without re-picking. */
function selectionCandidateMenuContribution(state) {
    return state ? { label: 'Select under cursor ▸', items: state.items } : null;
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
class SelectionStore {
    projectId = null;
    members = new Map();
    entityIds = new Set();
    parentCounts = new Map();
    haloIds = new Set();
    hiddenEntityIds = new Set();
    liveEntityIds = null;
    entityKind = () => undefined;
    history = emptyHistory('unloaded');
    historyState = selectionState([]);
    candidates = null;
    listeners = new Set();
    revision = 0;
    cachedSnapshot = null;
    persistTail = Promise.resolve();
    persistence;
    historyDepth;
    onRecovery;
    constructor(options = {}) {
        this.persistence = options.persistence;
        this.historyDepth = options.historyDepth ?? DEFAULT_HISTORY_DEPTH;
        if (!Number.isSafeInteger(this.historyDepth) || this.historyDepth < 1) {
            throw new RangeError('selection historyDepth must be a positive safe integer');
        }
        this.onRecovery = options.onRecovery ?? (() => undefined);
    }
    getSnapshot = () => {
        if (this.cachedSnapshot)
            return this.cachedSnapshot;
        this.cachedSnapshot = Object.freeze({
            projectId: this.projectId,
            members: Object.freeze([...this.members.values()]),
            selectedEntityIds: this.entityIds,
            boundingBoxHaloEntityIds: this.haloIds,
            candidates: this.candidates,
            canUndo: this.history.cursor > 0,
            canRedo: this.history.cursor < this.history.head,
            revision: this.revision,
        });
        return this.cachedSnapshot;
    };
    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };
    async openProject(projectId, liveEntityIds, entityKind, hiddenEntityIds = []) {
        if (!projectId.trim())
            throw new TypeError('projectId is required');
        if (this.projectId && this.projectId !== projectId)
            await this.closeProject();
        this.projectId = projectId;
        this.liveEntityIds = liveEntityIds;
        this.entityKind = entityKind;
        this.hiddenEntityIds = new Set(hiddenEntityIds);
        this.history = emptyHistory(projectId);
        this.installMembers([]);
        this.candidates = null;
        let persisted = null;
        try {
            persisted = await this.persistence?.load(projectId);
            if (persisted !== null && persisted !== undefined) {
                const record = await parsePersistenceRecord(persisted, projectId);
                this.history = record.history;
                this.installMembers(filterValidMembers(record.state, liveEntityIds));
            }
        }
        catch (error) {
            this.history = emptyHistory(projectId);
            this.installMembers(recoverPersistedState(persisted, liveEntityIds));
            this.onRecovery(`Selection history for ${projectId} was corrupt and was reset without changing the document: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.changed(false);
    }
    async closeProject() {
        if (!this.projectId)
            return;
        this.queuePersist();
        await this.flushPersistence();
        this.projectId = null;
        this.liveEntityIds = null;
        this.entityKind = () => undefined;
        this.hiddenEntityIds = new Set();
        this.history = emptyHistory('unloaded');
        this.installMembers([]);
        this.candidates = null;
        this.changed(false);
    }
    async switchProject(projectId, liveEntityIds, entityKind, hiddenEntityIds = []) {
        await this.closeProject();
        await this.openProject(projectId, liveEntityIds, entityKind, hiddenEntityIds);
    }
    replace(entityIds, gestureSession = null) {
        return this.commit(entityMembers(entityIds), gestureSession);
    }
    replaceMembers(members, gestureSession = null) {
        return this.commit(members, gestureSession);
    }
    /** Automation requires all-or-nothing validation rather than silently pruning stale ids. */
    replaceExisting(entityIds, gestureSession = null) {
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
    pointerSelect(entityId, options) {
        this.invalidateCandidates('newClick');
        if (!entityId || !this.clickSelectable(entityId))
            return false;
        if (options.ctrlKey)
            return this.toggle(entityId);
        if (options.modality === 'touch' && this.entityIds.size === 1 && this.entityIds.has(entityId)) {
            return this.clear();
        }
        return this.replace([entityId]);
    }
    toggle(entityId, gestureSession = null) {
        assertEntityId(entityId);
        if (!this.projectId)
            throw new Error('selection store has no open project');
        if (this.liveEntityIds && !this.liveEntityIds.has(entityId)) {
            throw new RangeError(`selection entity does not exist: ${entityId}`);
        }
        const key = entityKey(entityId);
        const selected = this.members.has(key);
        if (selected)
            this.members.delete(key);
        else
            this.members.set(key, { kind: 'entity', entityId });
        const entityIds = new Set(this.entityIds);
        const parentCount = (this.parentCounts.get(entityId) ?? 0) + (selected ? -1 : 1);
        if (parentCount <= 0) {
            this.parentCounts.delete(entityId);
            entityIds.delete(entityId);
        }
        else {
            this.parentCounts.set(entityId, parentCount);
            entityIds.add(entityId);
        }
        this.entityIds = entityIds;
        if (CLOUD_KINDS.has(this.entityKind(entityId) ?? '')) {
            const haloIds = new Set(this.haloIds);
            if (parentCount <= 0)
                haloIds.delete(entityId);
            else
                haloIds.add(entityId);
            this.haloIds = haloIds;
        }
        const after = selectionState([...this.members.values()]);
        this.recordHistory(this.historyState, after, gestureSession, null);
        this.historyState = after;
        this.changed();
        return true;
    }
    clear(gestureSession = null) {
        this.invalidateCandidates('escape');
        if (this.members.size === 0)
            return false;
        return this.commitMap(new Map(), gestureSession, null, true);
    }
    /** Journal-apply hook. Prune is recorded, but undo revalidates and never resurrects a deletion. */
    pruneDeleted(entityIds) {
        const deleted = new Set(entityIds);
        if (deleted.size === 0)
            return false;
        if (this.liveEntityIds instanceof Set) {
            for (const id of deleted)
                this.liveEntityIds.delete(id);
        }
        const next = [...this.members.values()].filter((member) => !deleted.has(parentId(member)));
        return this.commit(next, null, 'journal-delete-prune');
    }
    /** Hide is deliberately a no-op for membership (UIP-D18/G-SE-P4). */
    entitiesHidden(entityIds, hidden = true) {
        for (const id of entityIds) {
            if (hidden)
                this.hiddenEntityIds.add(id);
            else
                this.hiddenEntityIds.delete(id);
        }
    }
    undo() {
        if (this.history.cursor === 0)
            return false;
        const entry = this.history.entries[this.history.cursor - 1];
        this.history.cursor -= 1;
        this.installMembers(this.validatedState(entry.before).members);
        this.changed();
        return true;
    }
    redo() {
        if (this.history.cursor >= this.history.head)
            return false;
        const entry = this.history.entries[this.history.cursor];
        this.history.cursor += 1;
        this.installMembers(this.validatedState(entry.after).members);
        this.changed();
        return true;
    }
    clearHistory() {
        this.history.entries = [];
        this.history.cursor = 0;
        this.history.head = 0;
        this.changed();
    }
    setCandidates(items, index = 0) {
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
    cycleCandidate(direction) {
        const current = this.candidates;
        if (!current)
            return null;
        const index = (current.index + direction + current.items.length) % current.items.length;
        const candidate = current.items[index];
        this.candidates = Object.freeze({
            ...current,
            index,
            statusText: `${index + 1} of ${current.items.length} under cursor — Up/Down cycles`,
        });
        this.replace([candidate.entityId]);
        this.changed(false);
        return candidate;
    }
    invalidateCandidates(_reason) {
        if (!this.candidates)
            return;
        this.candidates = null;
        this.changed(false);
    }
    async flushPersistence() {
        await this.persistTail;
    }
    clickSelectable(entityId) {
        if (this.liveEntityIds && !this.liveEntityIds.has(entityId))
            return false;
        if (this.hiddenEntityIds.has(entityId))
            return false;
        return !CLOUD_KINDS.has(this.entityKind(entityId) ?? '');
    }
    commit(members, gestureSession, coalescingKey = null) {
        if (!this.projectId)
            throw new Error('selection store has no open project');
        const next = normalizeMembers(members, this.liveEntityIds);
        return this.commitMap(next, gestureSession, coalescingKey);
    }
    commitMap(next, gestureSession, coalescingKey = null, knownDifferent = false) {
        if (!this.projectId)
            throw new Error('selection store has no open project');
        if (!knownDifferent && sameKeys(this.members, next))
            return false;
        const before = this.historyState;
        const after = selectionState([...next.values()]);
        this.recordHistory(before, after, gestureSession, coalescingKey);
        this.installMap(next);
        this.historyState = after;
        this.changed();
        return true;
    }
    recordHistory(before, after, gestureSession, coalescingKey) {
        if (this.history.cursor < this.history.head)
            this.history.entries.splice(this.history.cursor);
        this.history.entries.push({
            sequence: ++this.history.localSequence,
            before,
            after,
            gestureSession,
            coalescingKey,
        });
        if (this.history.entries.length > this.historyDepth)
            this.history.entries.shift();
        this.history.head = this.history.entries.length;
        this.history.cursor = this.history.head;
    }
    validatedState(state) {
        return selectionState(filterValidMembers(state.members, this.liveEntityIds));
    }
    installMembers(members) {
        const normalized = normalizeMembers(members, this.liveEntityIds);
        this.installMap(normalized);
        this.historyState = selectionState([...normalized.values()]);
    }
    installMap(members) {
        this.members = members;
        const parentCounts = new Map();
        for (const member of members.values()) {
            const id = parentId(member);
            parentCounts.set(id, (parentCounts.get(id) ?? 0) + 1);
        }
        this.parentCounts = parentCounts;
        this.entityIds = new Set(parentCounts.keys());
        this.haloIds = new Set();
        for (const entityId of this.entityIds) {
            if (CLOUD_KINDS.has(this.entityKind(entityId) ?? ''))
                this.haloIds.add(entityId);
        }
    }
    changed(persist = true) {
        this.revision += 1;
        this.cachedSnapshot = null;
        if (persist)
            this.queuePersist();
        for (const listener of this.listeners)
            listener();
    }
    queuePersist() {
        if (!this.persistence || !this.projectId)
            return;
        const projectId = this.projectId;
        const state = [...this.members.values()];
        const history = cloneHistory(this.history);
        this.persistTail = this.persistTail
            .then(async () => {
            const sealed = await sealHistory(history);
            await this.persistence.store(projectId, {
                schemaId: exports.SELECTION_STATE_SCHEMA_ID,
                schemaVersion: 1,
                state,
                history: sealed,
            });
        })
            .catch((error) => {
            this.onRecovery(`Selection persistence failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
}
exports.SelectionStore = SelectionStore;
class MemorySelectionPersistence {
    records = new Map();
    async load(projectId) {
        return this.records.get(projectId) ?? null;
    }
    async store(projectId, record) {
        this.records.set(projectId, structuredClone(record));
    }
}
exports.MemorySelectionPersistence = MemorySelectionPersistence;
class LocalStorageSelectionPersistence {
    storage;
    prefix;
    constructor(storage, prefix = 'hcad.selection.v1:') {
        this.storage = storage;
        this.prefix = prefix;
    }
    async load(projectId) {
        const encoded = this.storage.getItem(this.prefix + projectId);
        return encoded === null ? null : JSON.parse(encoded);
    }
    async store(projectId, record) {
        this.storage.setItem(this.prefix + projectId, JSON.stringify(record));
    }
}
exports.LocalStorageSelectionPersistence = LocalStorageSelectionPersistence;
/** Pure, demand-driven intersection; SelectionStore never computes this during membership edits. */
function sharedPropertySet(selection) {
    const perKind = {};
    for (const member of selection)
        perKind[member.kind] = (perKind[member.kind] ?? 0) + 1;
    if (selection.length === 0)
        return { count: 0, perKind, fields: {} };
    const fields = {};
    for (const key of Object.keys(selection[0].fields)) {
        if (!selection.every((member) => Object.hasOwn(member.fields, key)))
            continue;
        const first = selection[0].fields[key];
        fields[key] = selection.every((member) => propertyEqual(member.fields[key], first))
            ? first
            : exports.MIXED;
    }
    return { count: selection.length, perKind, fields };
}
async function assignToAll(selection, field, value, journal) {
    if (!field.trim())
        throw new TypeError('property field is required');
    const batch = Object.freeze({
        commandId: `selection/property/${globalThis.crypto.randomUUID()}`,
        entityIds: Object.freeze([...new Set(selection.map((member) => member.entityId))]),
        assignments: Object.freeze([{ field, value }]),
    });
    if (batch.entityIds.length === 0)
        throw new Error('property assignment requires a selection');
    await journal(batch);
    return batch;
}
exports.SELECTION_COMMAND_TABLE = Object.freeze({
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
});
function executeSelectionCommand(store, commandId, request) {
    const payload = operationPayload(request);
    switch (commandId) {
        case 'select.get':
        case 'select.list':
        case 'selection.history.get':
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
        case 'select.candidates':
            break;
    }
    const snapshot = store.getSnapshot();
    return {
        schemaId: 'hcad.selection-command-result@1',
        payload: commandId === 'select.candidates'
            ? snapshot.candidates
            : {
                projectId: snapshot.projectId,
                entityIds: [...snapshot.selectedEntityIds],
                canUndo: snapshot.canUndo,
                canRedo: snapshot.canRedo,
            },
    };
}
function operationPayload(request) {
    if (!isRecord(request) ||
        request.schemaId !== 'hcad.selection-command@1' ||
        !('payload' in request)) {
        throw new TypeError('selection commands require the hcad.selection-command@1 envelope');
    }
    return request.payload;
}
function requiredIds(payload) {
    if (!isRecord(payload) ||
        !Array.isArray(payload.entityIds) ||
        payload.entityIds.some((id) => typeof id !== 'string' || !id.trim())) {
        throw new TypeError('select.set requires non-empty string entityIds');
    }
    return payload.entityIds;
}
function requiredId(payload) {
    if (!isRecord(payload) || typeof payload.entityId !== 'string' || !payload.entityId.trim()) {
        throw new TypeError('select.toggle requires entityId');
    }
    return payload.entityId;
}
function emptyHistory(projectId) {
    return {
        schemaId: exports.LOCAL_HISTORY_SCHEMA_ID,
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
function selectionState(members) {
    return { schemaId: exports.SELECTION_STATE_SCHEMA_ID, schemaVersion: 1, members };
}
function entityMembers(ids) {
    return [...ids].map((entityId) => ({ kind: 'entity', entityId }));
}
function normalizeMembers(members, live) {
    const result = new Map();
    for (const member of members) {
        validateMember(member);
        if (live && !live.has(parentId(member)))
            continue;
        result.set(memberKey(member), member);
    }
    return result;
}
function filterValidMembers(members, live) {
    return [...normalizeMembers(members, live).values()];
}
function validateMember(member) {
    if (!isRecord(member))
        throw new TypeError('selection member must be an object');
    if (member.kind === 'entity')
        return assertEntityId(member.entityId);
    if (member.kind !== 'curveSubentity' || !isRecord(member.ref))
        throw new TypeError('invalid selection member kind');
    const ref = member.ref;
    if (ref.schemaId !== 'hcad.curve-subentity-ref@1' || ref.schemaVersion !== 1)
        throw new TypeError('invalid hcad.curve-subentity-ref@1 member');
    assertEntityId(String(ref.parentId));
    if (!Number.isSafeInteger(ref.parentRevision) ||
        ref.parentRevision < 0 ||
        !ref.topologyKind.trim() ||
        !ref.stableMemberId.trim() ||
        ref.directedParameterInterval.length !== 2 ||
        ref.directedParameterInterval.some((value) => !Number.isFinite(value)) ||
        (ref.loopId !== null && !ref.loopId.trim()) ||
        (ref.useId !== null && !ref.useId.trim()) ||
        !/^[0-9a-f]{64}$/u.test(String(ref.semanticHash))) {
        throw new TypeError('invalid stable curve-subentity locator');
    }
}
function assertEntityId(entityId) {
    if (typeof entityId !== 'string' || !entityId.trim())
        throw new TypeError('entityId is required');
}
function parentId(member) {
    return member.kind === 'entity' ? member.entityId : String(member.ref.parentId);
}
function entityKey(entityId) {
    return `e:${entityId}`;
}
function memberKey(member) {
    return member.kind === 'entity'
        ? entityKey(member.entityId)
        : `s:${member.ref.parentId}:${member.ref.parentRevision}:${member.ref.topologyKind}:${member.ref.stableMemberId}:${member.ref.directedParameterInterval.join(',')}:${member.ref.loopId ?? ''}:${member.ref.useId ?? ''}:${member.ref.semanticHash}`;
}
function sameKeys(left, right) {
    if (left.size !== right.size)
        return false;
    for (const key of left.keys())
        if (!right.has(key))
            return false;
    return true;
}
function cloneHistory(history) {
    return structuredClone(history);
}
async function sealHistory(history) {
    history.checksum = EMPTY_SHA256;
    history.checksum = await sha256Hex(JSON.stringify(history));
    return history;
}
async function parsePersistenceRecord(input, projectId) {
    if (!isRecord(input) ||
        input.schemaId !== exports.SELECTION_STATE_SCHEMA_ID ||
        input.schemaVersion !== 1 ||
        !Array.isArray(input.state) ||
        !isRecord(input.history)) {
        throw new TypeError('invalid persisted selection envelope');
    }
    const history = input.history;
    if (history.schemaId !== exports.LOCAL_HISTORY_SCHEMA_ID ||
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
        typeof history.checksum !== 'string') {
        throw new TypeError('invalid selection local-history header');
    }
    const expected = history.checksum;
    const unsealed = cloneHistory(history);
    unsealed.checksum = EMPTY_SHA256;
    if (expected !== (await sha256Hex(JSON.stringify(unsealed))))
        throw new TypeError('selection local-history checksum mismatch');
    for (const member of input.state)
        validateMember(member);
    for (const entry of history.entries) {
        if (!isRecord(entry) || !isSelectionState(entry.before) || !isSelectionState(entry.after))
            throw new TypeError('invalid selection local-history entry');
        for (const member of [...entry.before.members, ...entry.after.members])
            validateMember(member);
    }
    return input;
}
function isSelectionState(value) {
    return (isRecord(value) &&
        value.schemaId === exports.SELECTION_STATE_SCHEMA_ID &&
        value.schemaVersion === 1 &&
        Array.isArray(value.members));
}
function recoverPersistedState(input, live) {
    if (!isRecord(input) || !Array.isArray(input.state))
        return [];
    try {
        return filterValidMembers(input.state, live);
    }
    catch {
        return [];
    }
}
async function sha256Hex(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function propertyEqual(left, right) {
    if (Object.is(left, right))
        return true;
    if (typeof left !== typeof right || left === null || right === null)
        return false;
    if (Array.isArray(left) && Array.isArray(right))
        return (left.length === right.length &&
            left.every((value, index) => propertyEqual(value, right[index])));
    if (isRecord(left) && isRecord(right)) {
        const keys = Object.keys(left);
        return (keys.length === Object.keys(right).length &&
            keys.every((key) => Object.hasOwn(right, key) && propertyEqual(left[key], right[key])));
    }
    return false;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=selection.js.map