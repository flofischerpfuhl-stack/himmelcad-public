import type { CurveGeometry } from "./CurveGeometry";
import type { DepthSampling } from "./DepthSampling";
import type { GeometryResource } from "./GeometryResource";
import type { OrthoGridMapping } from "./OrthoGridMapping";
import type { TriangleMeshGeometry } from "./TriangleMeshGeometry";
/**
 * 2.5D surface with at most one height for an XY coordinate.
 */
export type ElevationSurfaceGeometry = {
    "kind": "tin";
    /**
     * Surface triangle mesh; vertical/overhanging triangles are invalid here.
     */
    mesh: TriangleMeshGeometry;
    /**
     * Curves that must remain triangle edges.
     */
    breaklines: Array<CurveGeometry>;
} | {
    "kind": "grid";
    /**
     * Height/validity raster bands.
     */
    raster: GeometryResource;
    /**
     * Pixel-to-entity-local mapping.
     */
    mapping: OrthoGridMapping;
    /**
     * Height interpolation and discontinuity semantics.
     */
    sampling: DepthSampling;
};
//# sourceMappingURL=ElevationSurfaceGeometry.d.ts.map