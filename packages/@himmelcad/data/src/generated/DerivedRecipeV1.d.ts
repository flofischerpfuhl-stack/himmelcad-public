import type { DerivedDetachV1 } from "./DerivedDetachV1";
import type { DerivedLastErrorV1 } from "./DerivedLastErrorV1";
import type { DerivedLastSuccessV1 } from "./DerivedLastSuccessV1";
import type { DerivedOutputV1 } from "./DerivedOutputV1";
import type { DerivedRecipeStateV1 } from "./DerivedRecipeStateV1";
import type { DerivedSourceV1 } from "./DerivedSourceV1";
import type { EntityId } from "./EntityId";
export type DerivedRecipeV1 = {
    schemaId: string;
    schemaVersion: number;
    recipeId: string;
    recipeKind: string;
    generation: number;
    state: DerivedRecipeStateV1;
    outputGroupId: EntityId;
    outputs: Array<DerivedOutputV1>;
    sources: Array<DerivedSourceV1>;
    parameterTypeId: string;
    parameters: unknown;
    algorithmId: string;
    algorithmVersion: string;
    dependencyRecipeIds: Array<string>;
    staleCauses: Array<string>;
    lastSuccess: DerivedLastSuccessV1;
    lastError: DerivedLastErrorV1 | null;
    detach: DerivedDetachV1 | null;
};
//# sourceMappingURL=DerivedRecipeV1.d.ts.map