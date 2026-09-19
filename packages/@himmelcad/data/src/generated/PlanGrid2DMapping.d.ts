/**
 * Pixel-center mapping for a plan-only grid with no authored height.
 */
export type PlanGrid2DMapping = {
    /**
     * Project-plan XY coordinate of pixel center `(0, 0)`.
     */
    originXy: [number, number];
    /**
     * Project-plan XY step when the pixel column increases.
     */
    columnStepXy: [number, number];
    /**
     * Project-plan XY step when the pixel row increases.
     */
    rowStepXy: [number, number];
};
//# sourceMappingURL=PlanGrid2DMapping.d.ts.map