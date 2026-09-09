import type { CanonicalEntity } from "./CanonicalEntity";
import type { CanonicalEntityEdit } from "./CanonicalEntityEdit";
import type { EntityVersionRef } from "./EntityVersionRef";
/**
 * One state transition inside an atomic canonical command transaction.
 */
export type CanonicalEntityMutation = {
    "operation": "create";
    entity: CanonicalEntity;
} | {
    "operation": "update";
    expected: EntityVersionRef;
    edits: Array<CanonicalEntityEdit>;
} | {
    "operation": "delete";
    expected: EntityVersionRef;
} | {
    "operation": "restore";
    expected: EntityVersionRef;
    snapshot: CanonicalEntity;
};
//# sourceMappingURL=CanonicalEntityMutation.d.ts.map