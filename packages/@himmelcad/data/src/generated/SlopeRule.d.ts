import type { EntityId } from "./EntityId";
/**
 * Rule used to derive a slope from an alignment edge to a target surface.
 */
export type SlopeRule = {
    /**
     * Stable rule identifier.
     */
    id: string;
    /**
     * Source width-band edge.
     */
    sourceBandId: string;
    /**
     * Referenced target elevation/spatial surface.
     */
    targetSurface: EntityId;
    /**
     * Cut slope as vertical/horizontal ratio.
     */
    cutRatio: number;
    /**
     * Fill slope as vertical/horizontal ratio.
     */
    fillRatio: number;
};
//# sourceMappingURL=SlopeRule.d.ts.map