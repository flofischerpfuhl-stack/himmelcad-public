import type { Vector3 } from "./Vector3";
/**
 * Parametric primitive used as a CSG leaf.
 */
export type SolidPrimitive = {
    "kind": "box";
    size: Vector3;
} | {
    "kind": "sphere";
    radius: number;
} | {
    "kind": "cylinder";
    radius: number;
    height: number;
} | {
    "kind": "cone";
    bottomRadius: number;
    topRadius: number;
    height: number;
};
//# sourceMappingURL=SolidPrimitive.d.ts.map