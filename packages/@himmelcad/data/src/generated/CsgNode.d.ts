import type { CsgOperation } from "./CsgOperation";
import type { SolidPrimitive } from "./SolidPrimitive";
import type { Transform3d } from "./Transform3d";
/**
 * Recursive constructive solid geometry node.
 */
export type CsgNode = {
    "kind": "primitive";
    primitive: SolidPrimitive;
    placement: Transform3d;
} | {
    "kind": "boolean";
    operation: CsgOperation;
    left: CsgNode;
    right: CsgNode;
};
//# sourceMappingURL=CsgNode.d.ts.map