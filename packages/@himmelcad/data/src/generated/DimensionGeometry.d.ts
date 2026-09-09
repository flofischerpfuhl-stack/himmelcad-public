import type { AnnotationAnchor } from "./AnnotationAnchor";
import type { DimensionKind } from "./DimensionKind";
import type { GeometryResource } from "./GeometryResource";
import type { Position } from "./Position";
/**
 * Associative dimension definition; displayed value is always derived.
 */
export type DimensionGeometry = {
    /**
     * Measurement kind.
     */
    dimensionKind: DimensionKind;
    /**
     * Ordered associative measurement anchors.
     */
    anchors: Array<AnnotationAnchor>;
    /**
     * Dimension-line/text placement anchor.
     */
    placement: Position;
    /**
     * Immutable formatting/style resource.
     */
    style: GeometryResource;
};
//# sourceMappingURL=DimensionGeometry.d.ts.map