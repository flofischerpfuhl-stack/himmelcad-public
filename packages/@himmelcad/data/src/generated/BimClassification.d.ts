/**
 * Semantic BIM classification kept independently from geometry representations.
 */
export type BimClassification = {
    /**
     * Classification system, for example IFC 4.3.
     */
    system: string;
    /**
     * Product/class code such as `IfcPipeSegment`.
     */
    code: string;
    /**
     * Optional predefined type or external classification item.
     */
    predefinedType: string | null;
};
//# sourceMappingURL=BimClassification.d.ts.map