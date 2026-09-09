import type { EntityId } from "./EntityId";
/**
 * One connectable port owned by a graph node and backed by an entity.
 */
export type NetworkPort = {
    /**
     * Stable identity unique within the topology.
     */
    portId: string;
    /**
     * Owning node.
     */
    nodeId: string;
    /**
     * Canonical entity represented by the port.
     */
    entityId: EntityId;
};
//# sourceMappingURL=NetworkPort.d.ts.map