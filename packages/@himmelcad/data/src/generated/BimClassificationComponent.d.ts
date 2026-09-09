import type { BimClassification } from "./BimClassification";
import type { ObjectHash } from "./ObjectHash";
/**
 * Immutable BIM classifications attached as one typed entity component.
 */
export type BimClassificationComponent = {
    /**
     * Exact versioned schema identifier.
     */
    schemaId: string;
    /**
     * Hash of every serialized field except `contentHash`.
     */
    contentHash: ObjectHash;
    /**
     * Ordered unique classifications.
     */
    classifications: Array<BimClassification>;
};
//# sourceMappingURL=BimClassificationComponent.d.ts.map