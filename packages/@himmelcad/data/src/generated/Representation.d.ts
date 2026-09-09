import type { ObjectHash } from "./ObjectHash";
import type { RepresentationAuthority } from "./RepresentationAuthority";
import type { RepresentationRole } from "./RepresentationRole";
/**
 * Immutable geometry attached to an entity.
 */
export type Representation = {
    /**
     * Semantic representation role.
     */
    role: RepresentationRole;
    /**
     * Content-addressed geometry object.
     */
    geometryRef: ObjectHash;
    /**
     * Whether the representation is authoritative or derived.
     */
    authority: RepresentationAuthority;
    /**
     * Hash of inputs and parameters used for a derived representation.
     */
    dependencyHash: ObjectHash | null;
};
//# sourceMappingURL=Representation.d.ts.map