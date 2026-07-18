//! Stream-hierarchy providers for permanent `HimmelCAD` exchange formats.

mod elevation_raster;
mod gaussian_splat;
mod gltf_basisu;
mod gltf_content;
mod gltf_draco;
mod gltf_materialize;
mod gltf_meshopt;
mod gltf_metadata;
mod gltf_resolver;
mod gltf_v1_content;
mod legacy_batch_hierarchy;
mod legacy_batch_table;
mod legacy_tiles_layout;
mod picking_refinement;
mod potree;
mod prepared;
mod raster_projection;
mod shared_asset_cache;
mod tiles3d;
mod tiles3d_content;
mod tiles3d_implicit;

pub use elevation_raster::{
    decode_elevation_raster, decode_encoded_elevation_raster, DecodedElevationRaster,
    ElevationRasterError, ElevationRasterInput, EncodedElevationRasterInput,
    PreparedRasterTileContract, RasterColorEncoding, RasterElevationEncoding, RasterGridMapping,
    RasterNoData, RasterSurfaceTopology, PREPARED_RASTER_TILE_SCHEMA_VERSION,
};
pub use gaussian_splat::{
    decode_gaussian_splat_ply, DecodedGaussianSplat, DecodedGaussianSplats,
    GaussianSplatDecodeError,
};
pub use gltf_content::{
    decode_glb, decode_glb_intrinsic, decode_gltf_intrinsic_with_resources,
    decode_gltf_with_resources, DecodedAlphaMode, DecodedFeatureImage, DecodedGlb, DecodedImage,
    DecodedMaterial, DecodedMeshPrimitive, DecodedMeshVertex, GlbDecodeError,
};
pub use gltf_metadata::{
    DecodedFeatureIdBinding, DecodedFeatureTextureSample, DecodedLegacyBatchIds,
    DecodedMeshFeatureSet, DecodedPrimitivePropertyAttribute, DecodedPrimitivePropertyTexture,
    DecodedPropertyAttributeProperty, DecodedPropertyTextureProperty, DecodedPropertyTextureSample,
    DecodedStructuralMetadata, DecodedTextureWrap, DecodedTriangleFeatureId,
};
pub use gltf_resolver::{
    inspect_gltf_dependencies, resolve_asset_uri, AssetBundleLimits, AssetResolverError,
    GltfDependency, GltfDependencyInspection, ResolvedAssetBundle, ResolvedAssetEntry,
    ResolvedAssetInput, ResolvedAssetKind,
};
pub use legacy_batch_hierarchy::{
    DecodedLegacyBatchTableHierarchy, DecodedLegacyHierarchyInstance, DecodedLegacyHierarchyRow,
};
pub use picking_refinement::{
    potree_point_world_position, refine_decoded_potree_point_pick, refine_potree_point_pick,
    ElevationRasterPickError, ElevationRasterPickPrimitive, ElevationRasterPickPrimitiveKind,
    ElevationRasterPickRefiner, ElevationRasterSample, GaussianSplatPickError,
    GaussianSplatPickRefiner, GaussianSplatPickSource,
};
pub use potree::{
    DecodedPotreePoints, PackedCivilPointAttributes, PotreeAttributeLayout, PotreeAttributeType,
    PotreeDecodeError, PotreeHierarchySource, PotreePointLayout, PotreePointMetadata,
};
pub use prepared::{PreparedHierarchyError, PreparedHierarchySource};
pub use raster_projection::{project_raster_sample, RasterProjectionError};
pub use shared_asset_cache::{AssetContentIdentity, PreparedAssetBundle, SharedAssetBlobCache};
pub use tiles3d::{ThreeDTilesHierarchySource, ThreeDTilesMetadataCatalog};
pub use tiles3d_content::{
    decode_three_d_tiles_content, decode_three_d_tiles_content_intrinsic,
    decode_three_d_tiles_content_intrinsic_with_resources,
    decode_three_d_tiles_content_with_resources, DecodedBatchedModel, DecodedInstancedModel,
    DecodedLegacyBatchTableCatalog, DecodedMeshInstance, DecodedPointTile,
    DecodedThreeDTilesContent, ThreeDTilesContentError, ThreeDTilesContentKind,
};
pub use tiles3d_implicit::{
    ImplicitSubdivisionScheme, ImplicitThreeDTilesError, ImplicitThreeDTilesHierarchySource,
    ImplicitTileCoordinates,
};
