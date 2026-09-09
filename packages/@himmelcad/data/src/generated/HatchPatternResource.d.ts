import type { HatchPatternKind } from "./HatchPatternKind";
import type { ObjectHash } from "./ObjectHash";
/**
 * Immutable hatch-pattern resource independent of area geometry.
 */
export type HatchPatternResource = {
    /**
     * Exact versioned schema identifier.
     */
    schemaId: string;
    /**
     * Stable hatch-pattern identity.
     */
    resourceId: string;
    /**
     * Hash of every serialized field except `contentHash`.
     */
    contentHash: ObjectHash;
    /**
     * Optional user-facing name.
     */
    name: string | null;
    /**
     * Pattern definition.
     */
    pattern: HatchPatternKind;
};
//# sourceMappingURL=HatchPatternResource.d.ts.map