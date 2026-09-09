import type { SupportDefinitionV1 } from "./SupportDefinitionV1";
import type { SupportRoleKindV1 } from "./SupportRoleKindV1";
export type SupportRoleV1 = {
    schemaId: string;
    schemaVersion: number;
    roleKind: SupportRoleKindV1;
    defines: Array<SupportDefinitionV1>;
    provenance: string;
};
//# sourceMappingURL=SupportRoleV1.d.ts.map