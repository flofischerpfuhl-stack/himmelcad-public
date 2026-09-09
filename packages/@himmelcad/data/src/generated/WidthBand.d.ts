import type { StationFunction } from "./StationFunction";
/**
 * One named width band measured laterally from the horizontal alignment.
 */
export type WidthBand = {
    /**
     * Stable band identifier within the alignment.
     */
    id: string;
    /**
     * Signed offset of the inner edge.
     */
    innerOffset: StationFunction;
    /**
     * Signed offset of the outer edge.
     */
    outerOffset: StationFunction;
};
//# sourceMappingURL=WidthBand.d.ts.map