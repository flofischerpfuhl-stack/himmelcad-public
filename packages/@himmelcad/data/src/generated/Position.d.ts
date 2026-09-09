/**
 * Coordinate whose height may be unknown without making XY invalid.
 */
export type Position = {
    /**
     * X or easting.
     */
    x: number;
    /**
     * Y or northing.
     */
    y: number;
    /**
     * Known Z or height. `None` never implies zero.
     */
    z: number | null;
};
//# sourceMappingURL=Position.d.ts.map