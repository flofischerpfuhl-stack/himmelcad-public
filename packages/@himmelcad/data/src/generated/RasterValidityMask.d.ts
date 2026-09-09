import type { GeometryResource } from "./GeometryResource";
import type { RasterValidityEncoding } from "./RasterValidityEncoding";
/**
 * Boolean validity attached to a co-registered depth field.
 */
export type RasterValidityMask = {
    /**
     * Immutable mask payload.
     */
    resource: GeometryResource;
    /**
     * Exact binary layout of the payload.
     */
    encoding: RasterValidityEncoding;
};
//# sourceMappingURL=RasterValidityMask.d.ts.map