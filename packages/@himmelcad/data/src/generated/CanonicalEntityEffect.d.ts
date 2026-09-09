import type { CanonicalEntity } from "./CanonicalEntity";
import type { CanonicalEntityField } from "./CanonicalEntityField";
import type { EntityId } from "./EntityId";
/**
 * Exact state effect accepted for one stable entity.
 */
export type CanonicalEntityEffect = {
    /**
     * Stable affected identity.
     */
    entityId: EntityId;
    /**
     * Live state before the transaction, or `None` for create/restore.
     */
    before: CanonicalEntity | null;
    /**
     * Live state after the transaction, or `None` for delete.
     */
    after: CanonicalEntity | null;
    /**
     * Semantic fields owned by this effect for conflict-aware compensation.
     */
    touchedFields: Array<CanonicalEntityField>;
};
//# sourceMappingURL=CanonicalEntityEffect.d.ts.map