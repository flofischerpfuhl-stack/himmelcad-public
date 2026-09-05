import type { AppDocumentSnapshot, CanonicalEntity, CanonicalEntityTombstone, CanonicalJournalEntry } from './canonicalProtocol.js';
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
export declare function createJournalMirror(snapshot: AppDocumentSnapshot): JournalMirror;
export declare function reduceJournalMirror(state: JournalMirror, entry: CanonicalJournalEntry): JournalMirror;
export {};
//# sourceMappingURL=journalMirror.d.ts.map