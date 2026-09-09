import type { EntityId } from "./EntityId";
import type { ObjectHash } from "./ObjectHash";
export type CurveSubentityRefV1 = {
    schemaId: string;
    schemaVersion: number;
    parentId: EntityId;
    parentRevision: number;
    topologyKind: string;
    stableMemberId: string;
    directedParameterInterval: [number, number];
    loopId: string | null;
    useId: string | null;
    semanticHash: ObjectHash;
};
//# sourceMappingURL=CurveSubentityRefV1.d.ts.map