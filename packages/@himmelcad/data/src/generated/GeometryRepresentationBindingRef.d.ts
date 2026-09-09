import type { GeometryRepresentationKey } from "./GeometryRepresentationKey";
/**
 * Small stable reference returned after an atomic publication.
 */
export type GeometryRepresentationBindingRef = {
    /**
     * Immutable entity/slot/revision identity; `key.slot` is the compare-and-swap target.
     */
    key: GeometryRepresentationKey;
    /**
     * Monotone slot generation used for compare-and-swap.
     */
    generation: number;
};
//# sourceMappingURL=GeometryRepresentationBindingRef.d.ts.map