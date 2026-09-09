import type { Vector3 } from "./Vector3";
/**
 * Right-handed entity-local frame used to embed coordinates on a plane.
 */
export type PlaneFrame = {
    /**
     * Entity-local origin of plane coordinates `(0, 0)`.
     */
    origin: Vector3;
    /**
     * Unit axis receiving the first plane coordinate.
     */
    uAxis: Vector3;
    /**
     * Unit axis receiving the second plane coordinate.
     */
    vAxis: Vector3;
};
//# sourceMappingURL=PlaneFrame.d.ts.map