import type { EntityId } from "./EntityId";
import type { ObjectHash } from "./ObjectHash";
/**
 * Immutable deleted state preventing stable identity reuse.
 */
export type CanonicalEntityTombstone = {
    /**
     * Stable deleted entity identity.
     */
    id: EntityId;
    /**
     * Monotone state revision assigned by deletion.
     */
    revision: number;
    /**
     * Last live entity version removed by the deletion.
     */
    deletedEntityVersionHash: ObjectHash;
    /**
     * Content hash of this tombstone contract.
     */
    versionHash: ObjectHash;
};
//# sourceMappingURL=CanonicalEntityTombstone.d.ts.map