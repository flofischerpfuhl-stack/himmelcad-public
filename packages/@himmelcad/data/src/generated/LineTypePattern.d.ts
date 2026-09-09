import type { LineTypeElement } from "./LineTypeElement";
/**
 * Continuous or explicitly repeating line construction.
 */
export type LineTypePattern = {
    "kind": "continuous";
} | {
    "kind": "repeating";
    elements: Array<LineTypeElement>;
};
//# sourceMappingURL=LineTypePattern.d.ts.map