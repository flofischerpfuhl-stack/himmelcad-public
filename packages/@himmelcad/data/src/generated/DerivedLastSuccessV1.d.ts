import type { DerivedSuccessOutputV1 } from "./DerivedSuccessOutputV1";
import type { ObjectHash } from "./ObjectHash";
export type DerivedLastSuccessV1 = {
    generation: number;
    sourceFingerprint: ObjectHash;
    outputs: Array<DerivedSuccessOutputV1>;
    completedAt: string;
};
//# sourceMappingURL=DerivedLastSuccessV1.d.ts.map