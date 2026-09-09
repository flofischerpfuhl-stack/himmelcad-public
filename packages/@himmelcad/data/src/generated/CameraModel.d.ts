import type { ObjectHash } from "./ObjectHash";
/**
 * Camera intrinsics carried by an oriented raster or panorama.
 */
export type CameraModel = {
    "kind": "pinhole";
    /**
     * Horizontal focal length in pixels.
     */
    focalX: number;
    /**
     * Vertical focal length in pixels.
     */
    focalY: number;
    /**
     * Principal point X in pixels.
     */
    centerX: number;
    /**
     * Principal point Y in pixels.
     */
    centerY: number;
    /**
     * Namespaced distortion model identifier.
     */
    distortionModel: string | null;
    /**
     * Ordered parameters defined by `distortion_model`.
     */
    distortionParameters: Array<number>;
} | {
    "kind": "equirectangular";
} | {
    "kind": "extension";
    /**
     * Namespaced model identifier.
     */
    modelId: string;
    /**
     * Immutable model parameter object.
     */
    parameters: ObjectHash;
};
//# sourceMappingURL=CameraModel.d.ts.map