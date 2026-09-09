import type { AreaGeometry } from "./AreaGeometry";
import type { CsgNode } from "./CsgNode";
import type { CurveGeometry } from "./CurveGeometry";
import type { GeometryResource } from "./GeometryResource";
import type { ObjectHash } from "./ObjectHash";
import type { TriangleMeshGeometry } from "./TriangleMeshGeometry";
import type { Vector3 } from "./Vector3";
/**
 * Valid solid representation. Validation must establish a well-defined volume.
 */
export type SolidGeometry = {
    "kind": "closedMesh";
    mesh: TriangleMeshGeometry;
} | {
    "kind": "brep";
    resource: GeometryResource;
} | {
    "kind": "csg";
    root: CsgNode;
} | {
    "kind": "extrusion";
    profile: AreaGeometry;
    direction: Vector3;
} | {
    "kind": "sweep";
    profile: AreaGeometry;
    path: CurveGeometry;
} | {
    "kind": "extension";
    typeId: string;
    parameters: ObjectHash;
};
//# sourceMappingURL=SolidGeometry.d.ts.map