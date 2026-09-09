import type { GeometryResource } from "./GeometryResource";
import type { RasterConfidenceEncoding } from "./RasterConfidenceEncoding";
/**
 * Informational confidence attached to a co-registered depth field.
 * Confidence never changes validity or connectivity implicitly.
 */
export type RasterConfidenceBand = {
    /**
     * Immutable normalized confidence payload.
     */
    resource: GeometryResource;
    /**
     * Exact scalar layout of the payload.
     */
    encoding: RasterConfidenceEncoding;
};
//# sourceMappingURL=RasterConfidenceBand.d.ts.map