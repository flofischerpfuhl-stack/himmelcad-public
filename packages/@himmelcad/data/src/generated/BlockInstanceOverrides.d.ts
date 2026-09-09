import type { BlockMemberAttributes } from "./BlockMemberAttributes";
import type { BlockMemberOverride } from "./BlockMemberOverride";
import type { BlockMemberStyle } from "./BlockMemberStyle";
/**
 * Typed overrides carried directly by one canonical block-instance revision.
 */
export type BlockInstanceOverrides = {
    /**
     * Style applied to every expanded member before member-specific overrides.
     */
    style: BlockMemberStyle;
    /**
     * Attributes applied to every expanded member before member-specific overrides.
     */
    attributes: BlockMemberAttributes;
    /**
     * Stable member-specific overrides; duplicate or unknown IDs are invalid.
     */
    members: Array<BlockMemberOverride>;
};
//# sourceMappingURL=BlockInstanceOverrides.d.ts.map