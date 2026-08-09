import type {
  AppDocumentSnapshot,
  CanonicalEntity,
  CanonicalEntityTombstone,
  CanonicalJournalEntry,
} from './canonicalProtocol.js';

interface JournalMirrorBase {
  readonly generation: number;
  readonly appliedThroughSequence: number;
  readonly entities: Readonly<Record<string, CanonicalEntity>>;
  readonly tombstones: Readonly<Record<string, CanonicalEntityTombstone>>;
}

export interface ReadyJournalMirror extends JournalMirrorBase {
  readonly status: 'ready';
}

export interface RefreshRequiredJournalMirror extends JournalMirrorBase {
  readonly status: 'refresh-required';
  readonly expectedSequence: number;
  readonly receivedSequence: number;
}

export type JournalMirror = ReadyJournalMirror | RefreshRequiredJournalMirror;

export function createJournalMirror(snapshot: AppDocumentSnapshot): JournalMirror {
  const entities: Record<string, CanonicalEntity> = {};
  const tombstones: Record<string, CanonicalEntityTombstone> = {};
  for (const entity of snapshot.entities) entities[entity.id] = entity;
  for (const tombstone of snapshot.tombstones) tombstones[tombstone.id] = tombstone;
  return {
    status: 'ready',
    generation: snapshot.generation,
    appliedThroughSequence: snapshot.journalHeadSequence,
    entities,
    tombstones,
  };
}

export function reduceJournalMirror(
  state: JournalMirror,
  entry: CanonicalJournalEntry,
): JournalMirror {
  if (state.status === 'refresh-required') return state;
  const expectedSequence = state.appliedThroughSequence + 1;
  if (entry.sequence < expectedSequence) return state;
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
    if (effect.after === null) delete entities[effect.entityId];
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
