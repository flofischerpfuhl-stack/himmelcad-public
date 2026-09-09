import type { EntityId } from "./EntityId";
import type { ObjectHash } from "./ObjectHash";
import type { Position } from "./Position";
/**
 * Associative anchor on another entity or at a fixed position.
 */
export type AnnotationAnchor = {
    "kind": "position";
    position: Position;
} | {
    "kind": "entity";
    entityId: EntityId;
    expectedVersion: ObjectHash | null;
    primitiveId: number | null;
    parameter: number | null;
};
//# sourceMappingURL=AnnotationAnchor.d.ts.map