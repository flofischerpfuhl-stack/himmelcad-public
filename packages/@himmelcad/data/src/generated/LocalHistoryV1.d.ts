import type { LocalHistoryEntryV1 } from "./LocalHistoryEntryV1";
import type { LocalHistoryKindV1 } from "./LocalHistoryKindV1";
import type { ObjectHash } from "./ObjectHash";
export type LocalHistoryV1 = {
    schemaId: string;
    schemaVersion: number;
    projectId: string;
    streamKind: LocalHistoryKindV1;
    localSequence: number;
    cursor: number;
    head: number;
    entries: Array<LocalHistoryEntryV1>;
    checksum: ObjectHash;
};
//# sourceMappingURL=LocalHistoryV1.d.ts.map