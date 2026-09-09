import type { EntityId } from "./EntityId";
import type { ObjectHash } from "./ObjectHash";
import type { Position } from "./Position";
import type { Vector3 } from "./Vector3";
export type MeasurementAnchorV1 = {
    "binding": "fixed";
    position: Position;
} | {
    "binding": "attached";
    entityId: EntityId;
    expectedRevision: number;
    expectedVersionHash: ObjectHash;
    providerId: string;
    representationId: string;
    primitiveAddress: string;
    sourceParameter: number | null;
    exactSourcePosition: Position;
    offset: Vector3;
};
//# sourceMappingURL=MeasurementAnchorV1.d.ts.map