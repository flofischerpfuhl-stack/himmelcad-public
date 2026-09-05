"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createJournalMirror = createJournalMirror;
exports.reduceJournalMirror = reduceJournalMirror;
function createJournalMirror(snapshot) {
    const entities = {};
    const tombstones = {};
    for (const entity of snapshot.entities)
        entities[entity.id] = entity;
    for (const tombstone of snapshot.tombstones)
        tombstones[tombstone.id] = tombstone;
    return {
        status: 'ready',
        generation: snapshot.generation,
        appliedThroughSequence: snapshot.journalHeadSequence,
        entities,
        tombstones,
    };
}
function reduceJournalMirror(state, entry) {
    if (state.status === 'refresh-required')
        return state;
    const expectedSequence = state.appliedThroughSequence + 1;
    if (entry.sequence < expectedSequence)
        return state;
    if (entry.sequence > expectedSequence) {
        return {
            ...state,
            status: 'refresh-required',
            expectedSequence,
            receivedSequence: entry.sequence,
        };
    }
    const entities = { ...state.entities };
    const tombstones = { ...state.tombstones };
    for (const effect of entry.effects) {
        if (effect.after === null)
            delete entities[effect.entityId];
        else {
            entities[effect.entityId] = effect.after;
            // A restore makes the snapshot tombstone obsolete. A delete tombstone's
            // exact hash is deliberately learned only from the next snapshot.
            delete tombstones[effect.entityId];
        }
    }
    return {
        status: 'ready',
        generation: entry.sequence,
        appliedThroughSequence: entry.sequence,
        entities,
        tombstones,
    };
}
//# sourceMappingURL=journalMirror.js.map