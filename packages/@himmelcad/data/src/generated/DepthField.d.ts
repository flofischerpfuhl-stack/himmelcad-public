import type { DepthSampling } from "./DepthSampling";
import type { GeometryResource } from "./GeometryResource";
import type { RasterConfidenceBand } from "./RasterConfidenceBand";
import type { RasterValidityMask } from "./RasterValidityMask";
/**
 * Optional depth/elevation payload attached to an image.
 */
export type DepthField = {
    /**
     * Scalar sample resource.
     */
    values: GeometryResource;
    /**
     * Optional validity mask.
     */
    validity: RasterValidityMask | null;
    /**
     * Optional confidence band.
     */
    confidence: RasterConfidenceBand | null;
    /**
     * Display and measurement rules.
     */
    sampling: DepthSampling;
};
//# sourceMappingURL=DepthField.d.ts.map