import type { BlockMemberAttributes } from "./BlockMemberAttributes";
import type { BlockMemberStyle } from "./BlockMemberStyle";
/**
 * One stable member-specific override authored on a block instance.
 */
export type BlockMemberOverride = {
    /**
     * Definition-owned member identity targeted by this override.
     */
    memberId: string;
    /**
     * Explicit style inheritance at this instance level.
     */
    style: BlockMemberStyle;
    /**
     * Explicit attribute inheritance at this instance level.
     */
    attributes: BlockMemberAttributes;
};
//# sourceMappingURL=BlockMemberOverride.d.ts.map