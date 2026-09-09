import type { AnnotationAnchor } from "./AnnotationAnchor";
import type { Position } from "./Position";
import type { TextGeometry } from "./TextGeometry";
/**
 * Associative label with leader and text placement.
 */
export type LabelGeometry = {
    /**
     * Labeled source location.
     */
    target: AnnotationAnchor;
    /**
     * Label text.
     */
    text: TextGeometry;
    /**
     * Optional leader vertices between target and text.
     */
    leader: Array<Position>;
};
//# sourceMappingURL=LabelGeometry.d.ts.map