import type { CanonicalResourceRef } from "./CanonicalResourceRef";
/**
 * Explicit style inheritance for one block level.
 */
export type BlockMemberStyle = {
    "kind": "inherit";
} | {
    "kind": "clear";
} | {
    "kind": "resource";
    style: CanonicalResourceRef;
};
//# sourceMappingURL=BlockMemberStyle.d.ts.map