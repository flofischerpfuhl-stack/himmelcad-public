import type { LinearRgba } from "./LinearRgba";
import type { MaterialAlphaMode } from "./MaterialAlphaMode";
import type { ObjectHash } from "./ObjectHash";
import type { TextureResourceBinding } from "./TextureResourceBinding";
/**
 * Immutable physically based material resource.
 */
export type MaterialResource = {
    /**
     * Exact versioned schema identifier.
     */
    schemaId: string;
    /**
     * Stable material identity.
     */
    resourceId: string;
    /**
     * Hash of every serialized field except `contentHash`.
     */
    contentHash: ObjectHash;
    /**
     * Optional user-facing name.
     */
    name: string | null;
    /**
     * Linear base color and opacity.
     */
    baseColor: LinearRgba;
    /**
     * Linear emissive RGB value.
     */
    emissive: [number, number, number];
    /**
     * Metallic factor in the inclusive range zero through one.
     */
    metallic: number;
    /**
     * Roughness factor in the inclusive range zero through one.
     */
    roughness: number;
    /**
     * Alpha interpretation.
     */
    alphaMode: MaterialAlphaMode;
    /**
     * Required for masked materials and absent otherwise.
     */
    alphaCutoff: number | null;
    /**
     * Whether both triangle orientations are rendered.
     */
    doubleSided: boolean;
    /**
     * At most one texture binding for each material channel.
     */
    textureBindings: Array<TextureResourceBinding>;
};
//# sourceMappingURL=MaterialResource.d.ts.map