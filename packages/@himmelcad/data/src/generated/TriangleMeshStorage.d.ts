import type { GeometryResource } from "./GeometryResource";
import type { Vector3 } from "./Vector3";
/**
 * Triangle topology stored inline for compact authored geometry or by resource.
 */
export type TriangleMeshStorage = {
    "kind": "inline";
    /**
     * Spatial vertex positions.
     */
    positions: Array<Vector3>;
    /**
     * Triangle-list vertex indices.
     */
    indices: Array<number>;
    /**
     * Optional per-vertex unit normals.
     */
    normals: Array<Vector3> | null;
    /**
     * Optional ordered texture-coordinate sets; set indices are canonical.
     */
    textureCoordinates: Array<Array<[number, number]>> | null;
} | {
    "kind": "resource";
    /**
     * Immutable resource and its declared format.
     */
    resource: GeometryResource;
};
//# sourceMappingURL=TriangleMeshStorage.d.ts.map