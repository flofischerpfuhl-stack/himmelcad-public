import type { EntityId } from "./EntityId";
/**
 * One graph node backed by a canonical entity.
 */
export type NetworkNode = {
    /**
     * Stable identity unique within the topology.
     */
    nodeId: string;
    /**
     * Canonical entity represented by the node.
     */
    entityId: EntityId;
};
//# sourceMappingURL=NetworkNode.d.ts.map