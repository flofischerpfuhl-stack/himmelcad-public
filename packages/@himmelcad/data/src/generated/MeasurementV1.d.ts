import type { EntityId } from "./EntityId";
import type { MeasurementAnchorV1 } from "./MeasurementAnchorV1";
import type { MeasurementKindV1 } from "./MeasurementKindV1";
import type { MeasurementMetricV1 } from "./MeasurementMetricV1";
import type { MeasurementResultCacheV1 } from "./MeasurementResultCacheV1";
import type { MeasurementVerificationV1 } from "./MeasurementVerificationV1";
export type MeasurementV1 = {
    schemaId: string;
    schemaVersion: number;
    measurementKind: MeasurementKindV1;
    metric: MeasurementMetricV1 | null;
    anchors: Array<MeasurementAnchorV1>;
    layerId: EntityId;
    visible: boolean;
    creationViewId: string | null;
    provenance: string;
    verification: MeasurementVerificationV1;
    resultCache: MeasurementResultCacheV1 | null;
};
//# sourceMappingURL=MeasurementV1.d.ts.map