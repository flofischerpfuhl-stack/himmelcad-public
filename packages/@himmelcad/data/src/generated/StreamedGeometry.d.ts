import type { GeometryResource } from "./GeometryResource";
/**
 * Prepared streamed geometry dataset.
 */
export type StreamedGeometry = {
    /**
     * Namespaced format and version, for example `potree@2` or `3d-tiles@1.1`.
     */
    formatId: string;
    /**
     * Root metadata/hierarchy resource.
     */
    metadata: GeometryResource;
    /**
     * Optional known element count.
     */
    elementCount: number | null;
};
//# sourceMappingURL=StreamedGeometry.d.ts.map