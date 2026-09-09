import type { ObjectHash } from "./ObjectHash";
/**
 * Explicit attribute-table inheritance for one block level.
 */
export type BlockMemberAttributes = {
    "kind": "inherit";
} | {
    "kind": "clear";
} | {
    "kind": "replace";
    attributesRef: ObjectHash;
};
//# sourceMappingURL=BlockMemberAttributes.d.ts.map