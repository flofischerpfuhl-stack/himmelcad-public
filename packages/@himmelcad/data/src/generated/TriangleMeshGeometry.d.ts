import type { CanonicalResourceRef } from "./CanonicalResourceRef";
import type { TriangleMeshStorage } from "./TriangleMeshStorage";
/**
 * Arbitrary open or closed triangulated boundary representation.
 */
export type TriangleMeshGeometry = {
    /**
     * Vertex and topology storage.
     */
    storage: TriangleMeshStorage;
    /**
     * Whether validation proved a closed, oriented two-manifold boundary.
     */
    closedManifold: boolean;
    /**
     * Optional material-table slot for every inline triangle, in index order.
     * Resource-backed meshes carry this association in their immutable format.
     */
    triangleMaterialSlots: Array<number> | null;
    /**
     * Optional exact immutable canonical material-table revision.
     */
    materials: CanonicalResourceRef | null;
};
//# sourceMappingURL=TriangleMeshGeometry.d.ts.map