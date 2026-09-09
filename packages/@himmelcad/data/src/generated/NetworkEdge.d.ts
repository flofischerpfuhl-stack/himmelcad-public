import type { EntityId } from "./EntityId";
/**
 * One utility connection between two ports and its canonical entity.
 */
export type NetworkEdge = {
    /**
     * Stable identity unique within the topology.
     */
    edgeId: string;
    /**
     * Canonical entity represented by the edge.
     */
    entityId: EntityId;
    /**
     * First endpoint port.
     */
    fromPortId: string;
    /**
     * Second endpoint port.
     */
    toPortId: string;
    /**
     * Whether traversal is restricted from `from` to `to`.
     */
    directed: boolean;
};
//# sourceMappingURL=NetworkEdge.d.ts.map