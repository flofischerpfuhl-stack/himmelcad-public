import type { DerivedOutputStatusV1 } from "./DerivedOutputStatusV1";
import type { EntityId } from "./EntityId";
import type { ObjectHash } from "./ObjectHash";
export type DerivedOutputV1 = {
    slotId: string;
    role: string;
    outputId: EntityId;
    typeId: string;
    locator: string;
    currentRevision: number;
    currentContentHash: ObjectHash | null;
    status: DerivedOutputStatusV1;
};
//# sourceMappingURL=DerivedOutputV1.d.ts.map