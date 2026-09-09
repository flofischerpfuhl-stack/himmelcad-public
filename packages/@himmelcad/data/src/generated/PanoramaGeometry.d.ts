import type { EntityId } from "./EntityId";
import type { RasterImageGeometry } from "./RasterImageGeometry";
/**
 * Panorama image at a scan station, optionally linked to station measurements.
 */
export type PanoramaGeometry = {
    /**
     * Equirectangular or vendor-specific panorama raster.
     */
    image: RasterImageGeometry;
    /**
     * Optional point-cloud entity measured from the same station.
     */
    stationPointCloud: EntityId | null;
};
//# sourceMappingURL=PanoramaGeometry.d.ts.map