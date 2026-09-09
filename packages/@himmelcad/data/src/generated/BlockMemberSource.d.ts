import type { EntityVersionRef } from "./EntityVersionRef";
import type { GeometryObject } from "./GeometryObject";
/**
 * Authoritative source of one reusable block member.
 */
export type BlockMemberSource = {
    "kind": "inline";
    /**
     * Complete canonical member geometry.
     */
    geometry: GeometryObject;
} | {
    "kind": "entityReference";
    entity: EntityVersionRef;
};
//# sourceMappingURL=BlockMemberSource.d.ts.map