import type { DepthSemantics } from "./DepthSemantics";
import type { RasterConnectivity } from "./RasterConnectivity";
import type { RasterInterpolation } from "./RasterInterpolation";
/**
 * Display and measurement rules for a raster height/depth band.
 */
export type DepthSampling = {
    /**
     * Sample meaning.
     */
    semantics: DepthSemantics;
    /**
     * Interpolation rule.
     */
    interpolation: RasterInterpolation;
    /**
     * Neighbor connectivity rule.
     */
    connectivity: RasterConnectivity;
};
//# sourceMappingURL=DepthSampling.d.ts.map