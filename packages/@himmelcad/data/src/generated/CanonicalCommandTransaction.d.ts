import type { CanonicalEntityMutation } from "./CanonicalEntityMutation";
/**
 * Atomic user-authored canonical transaction.
 */
export type CanonicalCommandTransaction = {
    /**
     * Stable, globally unique command identity.
     */
    commandId: string;
    /**
     * Entity transitions committed all-or-none in the supplied order.
     */
    mutations: Array<CanonicalEntityMutation>;
};
//# sourceMappingURL=CanonicalCommandTransaction.d.ts.map