import type { EntityId } from "./EntityId";
import type { ObjectHash } from "./ObjectHash";
/**
 * Exact optimistic reference to one live entity or tombstone revision.
 */
export type EntityVersionRef = {
    /**
     * Stable entity identity.
     */
    id: EntityId;
    /**
     * Exact monotone state revision.
     */
    revision: number;
    /**
     * Exact content hash of the live entity envelope or tombstone.
     */
    versionHash: ObjectHash;
};
//# sourceMappingURL=EntityVersionRef.d.ts.map