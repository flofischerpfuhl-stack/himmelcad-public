import type { ObjectHash } from "./ObjectHash";
/**
 * Content-addressed binary or image resource used by geometry objects.
 */
export type GeometryResource = {
    /**
     * Immutable content hash.
     */
    objectHash: ObjectHash;
    /**
     * Registered media type or namespaced format identifier.
     */
    mediaType: string;
    /**
     * Exact stored byte size when known.
     */
    byteLength: number | null;
};
//# sourceMappingURL=GeometryResource.d.ts.map