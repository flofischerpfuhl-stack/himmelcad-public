import type { DerivedSourceV1 } from "./DerivedSourceV1";
import type { MeshSourceRoleKindV1 } from "./MeshSourceRoleKindV1";
import type { ObjectHash } from "./ObjectHash";
import type { Transform3d } from "./Transform3d";
export type MeshSourceRoleV1 = {
    source: DerivedSourceV1;
    placement: Transform3d;
    role: MeshSourceRoleKindV1;
    samplingTolerance: number | null;
    samplingHash: ObjectHash | null;
    boundaryHash: ObjectHash | null;
    exclusionHashes: Array<ObjectHash>;
};
//# sourceMappingURL=MeshSourceRoleV1.d.ts.map