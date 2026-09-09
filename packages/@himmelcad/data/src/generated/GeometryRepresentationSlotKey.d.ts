import type { EntityId } from "./EntityId";
/**
 * Immutable identity of one canonical representation revision.
 */
export type GeometryRepresentationSlotKey = {
    /**
     * Stable semantic entity identity.
     */
    entityId: EntityId;
    /**
     * Stable project/provider-owned representation slot.
     */
    representationSlot: string;
};
//# sourceMappingURL=GeometryRepresentationSlotKey.d.ts.map