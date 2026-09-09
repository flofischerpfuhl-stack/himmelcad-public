import type { Vector3 } from "./Vector3";
/**
 * Pixel-center mapping for an orthographic entity-local grid.
 */
export type OrthoGridMapping = {
    /**
     * Entity-local coordinate of pixel center `(0, 0)`.
     */
    origin: Vector3;
    /**
     * Entity-local step when the pixel column increases.
     */
    columnStep: Vector3;
    /**
     * Entity-local step when the pixel row increases.
     */
    rowStep: Vector3;
};
//# sourceMappingURL=OrthoGridMapping.d.ts.map