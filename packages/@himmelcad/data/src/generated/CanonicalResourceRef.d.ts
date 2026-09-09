import type { ObjectHash } from "./ObjectHash";
/**
 * Stable immutable resource identity used by resource-to-resource bindings.
 */
export type CanonicalResourceRef = {
    /**
     * Stable project-owned resource identity.
     */
    resourceId: string;
    /**
     * Exact versioned resource schema.
     */
    schemaId: string;
    /**
     * Exact immutable resource revision.
     */
    contentHash: ObjectHash;
};
//# sourceMappingURL=CanonicalResourceRef.d.ts.map