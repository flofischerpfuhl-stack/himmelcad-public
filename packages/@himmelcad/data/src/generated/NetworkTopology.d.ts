import type { NetworkCyclePolicy } from "./NetworkCyclePolicy";
import type { NetworkEdge } from "./NetworkEdge";
import type { NetworkNode } from "./NetworkNode";
import type { NetworkPort } from "./NetworkPort";
import type { ObjectHash } from "./ObjectHash";
/**
 * Immutable typed utility-network topology component.
 */
export type NetworkTopology = {
    /**
     * Exact versioned schema identifier.
     */
    schemaId: string;
    /**
     * Stable topology identity.
     */
    topologyId: string;
    /**
     * Hash of every serialized field except `contentHash`.
     */
    contentHash: ObjectHash;
    /**
     * Explicit cycle semantics.
     */
    cyclePolicy: NetworkCyclePolicy;
    /**
     * Graph nodes.
     */
    nodes: Array<NetworkNode>;
    /**
     * Connectable ports.
     */
    ports: Array<NetworkPort>;
    /**
     * Connections.
     */
    edges: Array<NetworkEdge>;
};
//# sourceMappingURL=NetworkTopology.d.ts.map