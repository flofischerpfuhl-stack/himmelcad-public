/**
 * One repeated analytic hatch line family.
 */
export type HatchPatternLine = {
    /**
     * Line angle in radians.
     */
    angle: number;
    /**
     * Pattern-space point on the base line.
     */
    origin: [number, number];
    /**
     * Translation to the next parallel line.
     */
    offset: [number, number];
    /**
     * Signed dash sequence: positive draw, negative gap and zero dot.
     */
    dashPattern: Array<number>;
};
//# sourceMappingURL=HatchPatternLine.d.ts.map