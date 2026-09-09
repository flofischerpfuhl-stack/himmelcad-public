import type { CurveLoop } from "./CurveLoop";
/**
 * Area topology whose authored positions retain their exact XY/XYZ dimensionality.
 */
export type AreaGeometry = {
    /**
     * Exterior boundary.
     */
    outer: CurveLoop;
    /**
     * Interior void boundaries.
     */
    holes: Array<CurveLoop>;
};
//# sourceMappingURL=AreaGeometry.d.ts.map