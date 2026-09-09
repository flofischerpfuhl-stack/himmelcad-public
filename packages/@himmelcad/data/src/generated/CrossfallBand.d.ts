import type { StationFunction } from "./StationFunction";
/**
 * One crossfall/ramp band between two alignment offsets.
 */
export type CrossfallBand = {
    /**
     * Stable band identifier.
     */
    id: string;
    /**
     * Signed start offset.
     */
    fromOffset: StationFunction;
    /**
     * Signed end offset.
     */
    toOffset: StationFunction;
    /**
     * Rise divided by run along station.
     */
    crossfall: StationFunction;
};
//# sourceMappingURL=CrossfallBand.d.ts.map