//! Shared contracts for `HimmelCAD`'s mixed-entity render core.
//!
//! Format providers and GPU backends depend on these contracts. This crate does
//! not depend on Electron, React, Three.js, Potree, 3D Tiles or a particular
//! graphics API.

#![deny(missing_docs, rust_2018_idioms, unsafe_op_in_unsafe_fn)]
#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

mod alignment_preview;
mod basis_texture;
mod cad_area;
mod cad_curve;
mod camera;
mod decode_limits;
mod entity_compiler;
mod frame_graph;
mod geometry_representation_provider;
mod gpu;
mod gpu_calibration;
mod gpu_frame;
mod gpu_frame_timing;
mod gpu_resource_identity;
mod gpu_surface;
mod gpu_texture_cache;
mod mesh_picking;
mod overlay;
mod picking;
mod point_quality;
mod precision;
mod providers;
mod render_world;
mod residency;
mod resource_builder;
mod scheduler;
mod section;
mod section_topology;
mod streaming;
mod streaming_decode_artifact;
mod streaming_decode_artifact_wire;
mod text;
mod tile_selector;

#[cfg(test)]
mod test_sync;

pub use alignment_preview::{
    alignment_geometry_version, AlignmentDaylightSample, AlignmentPreviewConfig,
    AlignmentPreviewError, AlignmentPreviewEvaluator, AlignmentPreviewMesh,
    AlignmentPreviewPartition, AlignmentPreviewPartitionUpdate, AlignmentPreviewRevision,
    AlignmentPreviewWorkload, AlignmentRoadBandPartition, AlignmentRoadBandSample,
    AlignmentSlopeSnapshot, AlignmentStationRange, AlignmentTargetSurfacePartition,
    AlignmentTargetSurfaceSnapshot, AlignmentTargetSurfaceUpdate,
};
pub use cad_area::{
    build_cad_area_batches, tessellate_area, AreaFillMode, CadAreaError, GpuAreaBatches,
    TessellatedArea, TessellatedAreaFill,
};
pub use cad_curve::{
    build_cad_curve_batch, build_cad_curve_batch_with_width, refine_tessellated_curve_pick,
    tessellate_curve, CadCurveError, CurveSemanticSnap, CurveTessellationOptions, TessellatedCurve,
    TessellatedCurvePath, TessellatedCurveSegment, UnresolvedHeightDisplay,
};
pub use camera::{
    matched_top_down, CameraFrame, CameraFrameError, CameraTransition, ProjectedWorldPoint,
    WorldRay,
};
pub use entity_compiler::{
    alignment_slope_geometry_version, compile_entity_geometry,
    compile_entity_geometry_with_associations, compile_entity_geometry_with_complete_resolvers,
    required_entity_proxy_slots, resolve_entity_point_world, tessellate_entity_strokes,
    tessellate_entity_strokes_with_associations, tessellate_entity_strokes_with_complete_resolvers,
    tessellate_generated_solid_mesh, CompiledEntityPart, EntityCompilationError,
    EntityCompilationOptions, ResolvedAlignmentSlopeGeometry,
};
pub use frame_graph::{FrameGraph, RenderPassKind};
pub use geometry_representation_provider::{
    EvaluatedMeshRecipe, EvaluatedMeshRepresentation, GeometryRepresentationBinding,
    GeometryRepresentationKey, GeometryRepresentationProvider, GeometryRepresentationProviderError,
    GeometryRepresentationRegistry, GeometryRepresentationRegistryError,
    GeometryRepresentationRegistryStats, PreparedGeometryRepresentationOverlay,
    RegisteredGeometryRepresentation, ResolvedGeometryRepresentation,
    ResolvedGeometryRepresentationAdmission, RetiredGeometryRepresentation,
};
pub use gpu::{adapter_capabilities, enabled_backends, BackendPolicy};
pub use gpu_calibration::{GpuCalibrationProgress, GpuCalibrationSession};
pub use gpu_frame::{
    GpuAlphaMode, GpuCanonicalMaterial, GpuCanonicalTextureBinding, GpuDrawBatch, GpuFrameError,
    GpuFramePrimitiveCounts, GpuFrameTargets, GpuHatchPattern, GpuHatchPatternData,
    GpuHatchResource, GpuHitNeighborhoodReadback, GpuHitPixel, GpuHitReadback, GpuHitSample,
    GpuIndexedMeshGeometry, GpuLineTypePattern, GpuLineTypeResource, GpuMaterial,
    GpuMeshInstanceInput, GpuMeshVertexInput, GpuPickReadback, GpuPickReadbackError,
    GpuPointVertex, GpuPresentationStyle, GpuPrimitive, GpuScreenTextVertex, GpuSharedRenderer,
    GpuSplatVertex, GpuTextureData, GpuTextureMipChainData, GpuTextureResource,
    GpuTextureTransform, GpuVertex, MAX_CLIP_PLANES, MAX_CLIP_VOLUMES, MAX_GPU_GRADIENT_COLORS,
    MAX_GPU_HATCH_TEXELS, MAX_GPU_LINE_TYPE_ELEMENTS, MAX_HIT_NEIGHBORHOOD_RADIUS,
    SORTED_ALPHA_MESH_INSTANCE_BLOCK_SIZE, SORTED_ALPHA_SPLAT_BLOCK_SIZE,
    SORTED_ALPHA_UPLOAD_BYTES_PER_FRAME,
};
pub use gpu_frame_timing::{GpuFrameTimestampSample, GpuFrameTimingDiagnostics};
pub use gpu_resource_identity::{
    GpuAstcBlock, GpuAstcChannel, GpuMaterialResourceIdentity, GpuModelResourceIdentity,
    GpuTextureAddressMode, GpuTextureBorderColor, GpuTextureColorSpace, GpuTextureCompareFunction,
    GpuTextureFilterMode, GpuTextureProfile, GpuTextureResourceIdentity, GpuTextureSamplerIdentity,
    GpuTextureUploadFormat, GpuTextureUploadLayout, GpuUploadedTextureIdentityInput,
};
pub use gpu_surface::{
    GpuCaptureError, GpuRecoveryReason, GpuRgbaReadback, GpuSurfaceError, GpuSurfaceHost,
    SurfaceCaptureRequest, SurfaceFrame, SurfaceFrameOutcome, SurfacePickRequest,
    SurfaceSkipReason, MAX_CAPTURE_DIMENSION, MAX_CAPTURE_PIXELS, MAX_CAPTURE_RGBA_BYTES,
};
pub use gpu_texture_cache::{
    GpuTextureResourceCache, GpuTextureResourceCacheError, GpuTextureResourceCacheStats,
    GpuTextureResourceStage, ImmutableGpuTextureResource,
};
pub use himmelcad_hardware_profile::{
    BackendKind, BackgroundLaneBudgets, CalibrationObservation, DeviceCalibration,
    DeviceCalibrationAccumulator, DeviceCapabilities, DeviceFeature, DeviceKind, FrameBudget,
    FrameTelemetrySample, FrameTelemetrySnapshot, FrameTelemetryWindow, FrameTimeDistribution,
    FrameWorkloadBudget, FrontierBudget, FrontierHardwareClass, GovernorPressure, GovernorTunables,
    HardwareDeploymentProfile, HardwareInventory, HardwarePolicyResolver,
    InteractionStreamingPolicy, LaneWorkBudget, MotionPolicyTunables, QualityAdjustment,
    ResolvedHardwarePolicy, ResourceBudget, ResourceCost, RuntimeQualityGovernor,
    RuntimeQualityReason, RuntimeQualityState, RuntimeQualityTier, TimingSample,
    TransparencyStrategy, GPU_POINT_VERTEX_STRIDE_BYTES,
};
pub use himmelcad_prepared::{
    BoundingVolume, ContentKind, ContentReference, DatasetId, DecodedTriangleFeatureId,
    HierarchyPageReference, HierarchySource, PreparedPointDatasetMetadata,
    PreparedPointMetadataOrigin, PreparedPointNodeMetadata, PreparedPointSampleStatistics,
    PreparedPointScreenSpaceError, RefinementMode, TileDescriptor, TileId, WorldAabb,
    WorldTransform, WorldVec3,
};
pub use mesh_picking::{
    InstancedTriangleMeshPickRefiner, MeshPickRefiner, TriangleMeshNearbyHit,
    TriangleMeshNearbyQuery, TriangleMeshPickBuildError, TriangleMeshPickInstance,
    TriangleMeshPickQueryLimits, TriangleMeshPickQueryStats, TriangleMeshPickRefiner,
    TriangleMeshPickSource, TriangleMeshRayHit, TriangleMeshRayQuery,
};
pub use overlay::{
    build_renderer_overlay_batches, OverlayBuildError, OverlayLabelChip, OverlayLineStrip,
    OverlayScreenQuad, RendererOverlayPayload,
};
pub use picking::{
    reconstruct_coarse_pick_candidates, refine_exact_point_pick, refine_pick_candidates,
    PickCandidate, PickCycle, PickCycleDirection, PickRefinementProvider, PickRefinementRequest,
    PickSample, PickToken, PresentationTransform, PresentationTransformError, SnapKind,
};
pub use point_quality::{
    adaptive_point_diameter, eye_dome_lighting_settings, AdaptivePointTunables,
    EyeDomeLightingSettings, EyeDomeLightingTier, PointQualityError,
};
pub use precision::{
    CameraProjection, FloatingOrigin, FloatingOriginError, OriginShift, TilePlacement, WorldCamera,
};
pub use providers::{
    decode_elevation_raster, decode_encoded_elevation_raster, decode_gaussian_splat_interleaved_v1,
    decode_gaussian_splat_ply, decode_glb, decode_glb_intrinsic,
    decode_gltf_intrinsic_with_resources, decode_gltf_with_resources, decode_three_d_tiles_content,
    decode_three_d_tiles_content_intrinsic, decode_three_d_tiles_content_intrinsic_with_resources,
    decode_three_d_tiles_content_with_resources, inspect_gltf_dependencies,
    potree_point_world_position, refine_decoded_potree_point_pick, refine_potree_point_pick,
    resolve_asset_uri, AssetBundleLimits, AssetContentIdentity, AssetResolverError,
    DecodedAlphaMode, DecodedBatchedModel, DecodedElevationRaster, DecodedFeatureIdBinding,
    DecodedFeatureImage, DecodedFeatureTextureSample, DecodedGaussianSplat, DecodedGaussianSplats,
    DecodedGlb, DecodedImage, DecodedInstancedModel, DecodedLegacyBatchIds,
    DecodedLegacyBatchTableCatalog, DecodedLegacyBatchTableHierarchy,
    DecodedLegacyHierarchyInstance, DecodedLegacyHierarchyRow, DecodedMaterial,
    DecodedMeshFeatureSet, DecodedMeshInstance, DecodedMeshPrimitive, DecodedMeshVertex,
    DecodedPointTile, DecodedPotreePoints, DecodedPrimitivePropertyAttribute,
    DecodedPrimitivePropertyTexture, DecodedPropertyAttributeProperty,
    DecodedPropertyTextureProperty, DecodedPropertyTextureSample, DecodedStructuralMetadata,
    DecodedTextureWrap, DecodedThreeDTilesContent, ElevationRasterError, ElevationRasterInput,
    ElevationRasterPickError, ElevationRasterPickPrimitive, ElevationRasterPickPrimitiveKind,
    ElevationRasterPickRefiner, ElevationRasterSample, EncodedElevationRasterInput,
    GaussianSplatDecodeError, GaussianSplatPickError, GaussianSplatPickRefiner,
    GaussianSplatPickSource, GlbDecodeError, GltfDependency, GltfDependencyInspection,
    ImplicitSubdivisionScheme, ImplicitThreeDTilesError, ImplicitThreeDTilesHierarchySource,
    ImplicitTileCoordinates, PackedCivilPointAttributes, PotreeAttributeLayout,
    PotreeAttributeType, PotreeDecodeError, PotreeHierarchySource, PotreePointLayout,
    PotreePointMetadata, PreparedAssetBundle, PreparedHierarchyError, PreparedHierarchyManifest,
    PreparedHierarchySource, PreparedRasterSurfaceGrid, PreparedRasterTileContract,
    RasterAnalysisView, RasterAnalysisViewError, RasterColorEncoding, RasterElevationEncoding,
    RasterGridMapping, RasterNoData, RasterProjectionError, RasterSurfaceTopology,
    ResolvedAssetBundle, ResolvedAssetEntry, ResolvedAssetInput, ResolvedAssetKind,
    SharedAssetBlobCache, ThreeDTilesContentError, ThreeDTilesContentKind,
    ThreeDTilesHierarchySource, ThreeDTilesMetadataCatalog,
    PREPARED_RASTER_SURFACE_TILE_SCHEMA_VERSION, PREPARED_RASTER_TILE_SCHEMA_VERSION,
};
pub use providers::{project_raster_sample, raster_analysis_view};
pub use render_world::{
    plan_draw_order, ClipOperation, ClipVolume, ClipVolumeId, ColorMode, EntityInteractionState,
    FillMode, HeightGradient, PreparedRenderWorldOverlay, RenderProxy, RenderProxyId,
    RenderProxyKind, RenderStyle, RenderWorld, RenderWorldError, RenderWorldOverlayDiagnostics,
    RenderWorldVisibilityDelta, SectionHatchStyle, StrokeCap, StrokeColor, StrokeJoin, StrokeMode,
    StrokeStyle, StrokeWidth,
};
pub use residency::{
    admission_candidate, admission_candidate_with_residency, estimate_tile_load, idle_wanted_keys,
    EvictedResidency, EvictionPlan, ResidencyError, ResidencyManager, ResidencySnapshot,
    ResidencyStage, ResidencyStageCounts, ResidencyTicket, TileLoadEstimate,
};
pub use resource_builder::{
    build_elevation_raster_batch, build_gaussian_splat_batch, build_gaussian_splat_batches,
    build_glb_batches, build_glb_batches_with_textures, build_instanced_glb_batches,
    build_instanced_glb_batches_with_geometries,
    build_instanced_glb_batches_with_geometries_and_textures,
    build_instanced_glb_geometries_with_queue, build_potree_batch, build_three_d_tiles_batches,
    build_three_d_tiles_batches_with_instanced_geometries,
    build_three_d_tiles_batches_with_resources, glb_texture_source_keys,
    gpu_indexed_geometry_identity, gpu_uploaded_texture_identity, instanced_model_chunks,
    prepare_glb_texture_uploads, prepare_glb_texture_uploads_for_sources,
    required_three_d_tiles_proxy_slots, BuiltThreeDTilesBatch, InstancedModelChunk,
    PreparedGpuTextureResources, PreparedGpuTextureUpload, ResourceBuildError,
};
pub use scheduler::{
    AdmissionCandidate, AdmissionPlan, AdmissionPlanner, FrameLane, LaneWorkUsage,
    RejectedCandidate, RejectionReason, TileKey,
};
pub use section::{
    authoritative_section_product_matches, build_section_region_batch,
    evaluate_authoritative_section_product, evaluate_authoritative_section_product_with_transform,
    section_closed_mesh, section_geometry_object, section_open_mesh,
    validate_authoritative_section_product, AuthoritativeSectionEvaluation,
    AuthoritativeSectionEvaluationError, AuthoritativeSectionPartInput,
    AuthoritativeSectionProduct, AuthoritativeSectionProductError, AuthoritativeSectionSource,
    SectionBatchOptions, SectionContour, SectionError, SectionMaterialRegionBinding,
    SectionMeshInput, SectionPlane, SectionProduct, SectionRegion, SectionSegment,
    SectionTopologyBounds, SectionTopologyPart, AUTHORITATIVE_SECTION_PRODUCT_SCHEMA_VERSION,
};
pub use section_topology::{
    AuthoritativeSectionAccumulator, AuthoritativeSectionTopologyStore, SectionTopologyLoadError,
    SectionTopologyPartitionData, SectionTopologySnapshot, SectionTopologySnapshotKey,
    SectionTopologyStoreError,
};
pub use streaming::{
    FrontierLimitReason, FrontierStatistics, StreamingAction, StreamingCoordinator,
    StreamingFramePlan, StreamingRuntimeLimits,
};
pub use streaming_decode_artifact::{
    decode_artifact, decode_artifact_input_hash, encode_decode_artifact, DecodedStreamingPayload,
    DECODE_ARTIFACT_HEADER_BYTES, DECODE_ARTIFACT_VERSION, MAX_DECODE_ARTIFACT_BYTES,
    MAX_WORKER_INPUT_BYTES,
};
pub use text::{
    build_text_batch, build_text_batch_with_texture, layout_text, validate_glyph_atlas, GlyphAtlas,
    GlyphMetrics, LaidOutGlyph, LaidOutText, TextAlignment, TextBatchOptions, TextError,
    TextLayoutOptions, TextLayoutSpace,
};
pub use tile_selector::{
    transform_bounding_volume, HierarchyPageRequest, SelectedTile, TileResidency, TileSelection,
    TileSelectionError, TileSelectionView, TileSelector,
};

/// Address emitted by the shared ID/depth pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickAddress {
    /// Canonical entity identity.
    pub entity_id: String,
    /// Versioned render-proxy identity.
    pub render_proxy_id: String,
    /// Dataset identity for streamed content.
    pub dataset_id: Option<DatasetId>,
    /// Tile identity for streamed content.
    pub tile_id: Option<TileId>,
    /// Provider-local primitive identity.
    pub primitive_id: Option<u64>,
}

/// One world-space clipping plane using `normal dot position + distance >= 0`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipPlane {
    /// Unit-length world-space plane normal.
    pub normal: WorldVec3,
    /// Signed distance term in project units.
    pub distance: f64,
}

#[cfg(test)]
mod tests {
    use super::{BoundingVolume, ResourceBudget, ResourceCost, WorldAabb, WorldVec3};

    #[test]
    fn stable_bounds_anchor_preserves_ecef_millimetres() {
        let bounds = BoundingVolume::AxisAlignedBox {
            bounds: WorldAabb {
                min: WorldVec3 {
                    x: 6_378_137.25,
                    y: 4_812_345.5,
                    z: 512.125,
                },
                max: WorldVec3 {
                    x: 6_378_137.252,
                    y: 4_812_345.504,
                    z: 512.131,
                },
            },
        };
        let anchor = bounds.stable_anchor().expect("stable AABB anchor");

        assert!((anchor.x - 6_378_137.251).abs() < 1.0e-9);
        assert!((anchor.y - 4_812_345.502).abs() < 1.0e-9);
        assert!((anchor.z - 512.128).abs() < 1.0e-12);
    }

    #[test]
    fn geodetic_bounds_anchor_is_wgs84_ecef_not_zero() {
        let bounds = BoundingVolume::GeodeticRegion {
            west: 0.0,
            south: 0.0,
            east: 0.0,
            north: 0.0,
            minimum_height: 0.0,
            maximum_height: 0.0,
        };
        let anchor = bounds.stable_anchor().expect("geodetic anchor");

        assert!((anchor.x - 6_378_137.0).abs() < f64::EPSILON);
        assert_eq!(anchor.y, 0.0);
        assert_eq!(anchor.z, 0.0);
    }

    #[test]
    fn geodetic_bounds_anchor_rejects_out_of_range_latitude() {
        let bounds = BoundingVolume::GeodeticRegion {
            west: 0.0,
            south: 0.0,
            east: 0.1,
            north: std::f64::consts::FRAC_PI_2 + 0.01,
            minimum_height: 0.0,
            maximum_height: 1.0,
        };

        assert_eq!(bounds.stable_anchor(), None);
    }

    #[test]
    fn mixed_content_competes_in_one_budget() {
        let points = ResourceCost {
            gpu_buffer_bytes: 400,
            points: 1_000,
            draw_calls: 2,
            ..ResourceCost::default()
        };
        let mesh = ResourceCost {
            gpu_buffer_bytes: 350,
            gpu_texture_bytes: 700,
            triangles: 2_000,
            draw_calls: 3,
            ..ResourceCost::default()
        };
        let combined = points.saturating_add(mesh);
        let budget = ResourceBudget {
            cpu_compressed_bytes: u64::MAX,
            cpu_decoded_bytes: u64::MAX,
            gpu_buffer_bytes: 1_000,
            gpu_texture_bytes: 600,
            staging_bytes: u64::MAX,
            points: 2_000,
            triangles: 3_000,
            splats: 0,
            draw_calls: 10,
        };

        assert!(!budget.contains(combined));
        assert!(budget.contains(points));
    }

    #[test]
    fn cost_addition_saturates() {
        let maximum = ResourceCost {
            gpu_buffer_bytes: u64::MAX,
            ..ResourceCost::default()
        };
        let one = ResourceCost {
            gpu_buffer_bytes: 1,
            ..ResourceCost::default()
        };

        assert_eq!(maximum.saturating_add(one).gpu_buffer_bytes, u64::MAX);
    }
}
