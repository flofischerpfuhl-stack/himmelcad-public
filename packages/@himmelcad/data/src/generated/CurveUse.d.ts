import type { CurveGeometry } from "./CurveGeometry";
import type { EntityId } from "./EntityId";
import type { ObjectHash } from "./ObjectHash";
/**
 * One directed use of a curve in an area boundary.
 */
export type CurveUse = {
    "kind": "inline";
    /**
     * Boundary curve.
     */
    curve: CurveGeometry;
    /**
     * Whether boundary traversal reverses the curve.
     */
    reversed: boolean;
} | {
    "kind": "associative";
    /**
     * Referenced curve entity.
     */
    entityId: EntityId;
    /**
     * Optional input version required by a derived cache.
     */
    expectedVersion: ObjectHash | null;
    /**
     * Whether boundary traversal reverses the source curve.
     */
    reversed: boolean;
};
//# sourceMappingURL=CurveUse.d.ts.map