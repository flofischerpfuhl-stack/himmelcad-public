import type { EntityId } from "./EntityId";
import type { ObjectHash } from "./ObjectHash";
import type { Representation } from "./Representation";
import type { Transform3d } from "./Transform3d";
/**
 * Typed absolute edit of one canonical entity envelope field.
 */
export type CanonicalEntityEdit = {
    "kind": "setName";
    name: string;
} | {
    "kind": "setOwner";
    owner: EntityId | null;
} | {
    "kind": "setLayerIds";
    layerIds: Array<EntityId>;
} | {
    "kind": "setPlacement";
    placement: Transform3d | null;
} | {
    "kind": "setRepresentations";
    representations: Array<Representation>;
} | {
    "kind": "setComponentsRef";
    componentsRef: ObjectHash;
} | {
    "kind": "setAttributesRef";
    attributesRef: ObjectHash;
} | {
    "kind": "setRelationsRef";
    relationsRef: ObjectHash;
} | {
    "kind": "setStyleRef";
    styleRef: ObjectHash | null;
};
//# sourceMappingURL=CanonicalEntityEdit.d.ts.map