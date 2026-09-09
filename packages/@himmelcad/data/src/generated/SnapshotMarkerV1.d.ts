import type { EntityId } from "./EntityId";
import type { SnapshotMarkerKindV1 } from "./SnapshotMarkerKindV1";
import type { SnapshotOriginV1 } from "./SnapshotOriginV1";
import type { SnapshotRetentionV1 } from "./SnapshotRetentionV1";
export type SnapshotMarkerV1 = {
    schemaId: string;
    schemaVersion: number;
    markedGeneration: number;
    markerKind: SnapshotMarkerKindV1;
    createdAt: string;
    origin: SnapshotOriginV1;
    restoreOf: EntityId | null;
    retention: SnapshotRetentionV1;
};
//# sourceMappingURL=SnapshotMarkerV1.d.ts.map