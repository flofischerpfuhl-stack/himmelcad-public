import type { AcquisitionTruthV1 } from "./AcquisitionTruthV1";
import type { EntityId } from "./EntityId";
import type { PointAcquisitionKindV1 } from "./PointAcquisitionKindV1";
import type { Position } from "./Position";
export type PointAcquisitionV1 = {
    schemaId: string;
    schemaVersion: number;
    acquisition: PointAcquisitionKindV1;
    finalCoordinate: Position;
    inputMode: string;
    truth: AcquisitionTruthV1;
    sourceEntityId: EntityId | null;
    sourceRevision: number | null;
    providerId: string | null;
    primitiveAddress: string | null;
    constraint: string | null;
    estimateConfirmed: boolean;
};
//# sourceMappingURL=PointAcquisitionV1.d.ts.map