import type { EntityId } from "./EntityId";
import type { ObjectHash } from "./ObjectHash";
export type DerivedLastErrorV1 = {
    code: string;
    phase: string;
    messageKey: string;
    sourceRefs: Array<EntityId>;
    errorListRef: ObjectHash | null;
};
//# sourceMappingURL=DerivedLastErrorV1.d.ts.map