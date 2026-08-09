//! Shared contracts for `HimmelCAD`'s mixed-entity render core.
//!
//! Format providers and GPU backends depend on these contracts. This crate does
//! not depend on Electron, React, Three.js, Potree, 3D Tiles or a particular
//! graphics API.

#![deny(missing_docs, rust_2018_idioms, unsafe_op_in_unsafe_fn)]
#![forbid(unsafe_code)]

use glam::{DMat3, DMat4, DVec3, DVec4};
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
mod hardware_policy;
mod mesh_picking;
mod picking;
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
    GpuFrameTargets, GpuHatchPattern, GpuHatchPatternData, GpuHatchResource,
    GpuHitNeighborhoodReadback, GpuHitPixel, GpuHitReadback, GpuHitSample, GpuIndexedMeshGeometry,
    GpuLineTypePattern, GpuLineTypeResource, GpuMaterial, GpuMeshInstanceInput, GpuMeshVertexInput,
    GpuPickReadback, GpuPickReadbackError, GpuPointVertex, GpuPresentationStyle, GpuPrimitive,
    GpuScreenTextVertex, GpuSharedRenderer, GpuSplatVertex, GpuTextureData, GpuTextureMipChainData,
    GpuTextureResource, GpuTextureTransform, GpuVertex, GPU_POINT_VERTEX_STRIDE_BYTES,
    MAX_CLIP_PLANES, MAX_CLIP_VOLUMES, MAX_GPU_GRADIENT_COLORS, MAX_GPU_HATCH_TEXELS,
    MAX_GPU_LINE_TYPE_ELEMENTS, MAX_HIT_NEIGHBORHOOD_RADIUS, SORTED_ALPHA_MESH_INSTANCE_BLOCK_SIZE,
    SORTED_ALPHA_SPLAT_BLOCK_SIZE, SORTED_ALPHA_UPLOAD_BYTES_PER_FRAME,
};
pub use gpu_frame_timing::GpuFrameTimingDiagnostics;
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
pub use hardware_policy::{
    CalibrationObservation, DeviceCalibration, DeviceCalibrationAccumulator, FrameTelemetrySample,
    FrameTelemetrySnapshot, FrameTelemetryWindow, FrameTimeDistribution, FrameWorkloadBudget,
    HardwareDeploymentProfile, HardwareInventory, HardwarePolicyResolver,
    InteractionStreamingPolicy, QualityAdjustment, ResolvedHardwarePolicy, RuntimeQualityGovernor,
    RuntimeQualityState, TimingSample, TransparencyStrategy,
};
pub use mesh_picking::{
    InstancedTriangleMeshPickRefiner, MeshPickRefiner, TriangleMeshNearbyHit,
    TriangleMeshNearbyQuery, TriangleMeshPickBuildError, TriangleMeshPickInstance,
    TriangleMeshPickQueryLimits, TriangleMeshPickQueryStats, TriangleMeshPickRefiner,
    TriangleMeshPickSource, TriangleMeshRayHit, TriangleMeshRayQuery,
};
pub use picking::{
    reconstruct_coarse_pick_candidates, refine_exact_point_pick, refine_pick_candidates,
    PickCandidate, PickCycle, PickCycleDirection, PickRefinementProvider, PickRefinementRequest,
    PickSample, PickToken, PresentationTransform, PresentationTransformError, SnapKind,
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
    DecodedTextureWrap, DecodedThreeDTilesContent, DecodedTriangleFeatureId, ElevationRasterError,
    ElevationRasterInput, ElevationRasterPickError, ElevationRasterPickPrimitive,
    ElevationRasterPickPrimitiveKind, ElevationRasterPickRefiner, ElevationRasterSample,
    EncodedElevationRasterInput, GaussianSplatDecodeError, GaussianSplatPickError,
    GaussianSplatPickRefiner, GaussianSplatPickSource, GlbDecodeError, GltfDependency,
    GltfDependencyInspection, ImplicitSubdivisionScheme, ImplicitThreeDTilesError,
    ImplicitThreeDTilesHierarchySource, ImplicitTileCoordinates, PackedCivilPointAttributes,
    PotreeAttributeLayout, PotreeAttributeType, PotreeDecodeError, PotreeHierarchySource,
    PotreePointLayout, PotreePointMetadata, PreparedAssetBundle, PreparedHierarchyError,
    PreparedHierarchyManifest, PreparedHierarchySource, PreparedRasterSurfaceGrid,
    PreparedRasterTileContract, RasterAnalysisView, RasterAnalysisViewError, RasterColorEncoding,
    RasterElevationEncoding, RasterGridMapping, RasterNoData, RasterProjectionError,
    RasterSurfaceTopology, ResolvedAssetBundle, ResolvedAssetEntry, ResolvedAssetInput,
    ResolvedAssetKind, SharedAssetBlobCache, ThreeDTilesContentError, ThreeDTilesContentKind,
    ThreeDTilesHierarchySource, ThreeDTilesMetadataCatalog,
    PREPARED_RASTER_SURFACE_TILE_SCHEMA_VERSION, PREPARED_RASTER_TILE_SCHEMA_VERSION,
};
pub use providers::{project_raster_sample, raster_analysis_view};
pub use render_world::{
    ClipOperation, ClipVolume, ClipVolumeId, ColorMode, EntityInteractionState, FillMode,
    HeightGradient, PreparedRenderWorldOverlay, RenderProxy, RenderProxyId, RenderProxyKind,
    RenderStyle, RenderWorld, RenderWorldError, RenderWorldOverlayDiagnostics,
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
    AdmissionCandidate, AdmissionPlan, AdmissionPlanner, RejectedCandidate, RejectionReason,
    TileKey,
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
    StreamingAction, StreamingCoordinator, StreamingFramePlan, StreamingRuntimeLimits,
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

/// Stable identity of one streamable dataset in a render world.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DatasetId(pub String);

/// Provider-local identity of one hierarchy node.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TileId(pub String);

/// Render backend selected for the current surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackendKind {
    /// Browser or native WebGPU feature level.
    WebGpu,
    /// Permanent browser downlevel path through WebGL 2.
    WebGl2,
    /// Native Vulkan backend.
    Vulkan,
    /// Native Metal backend.
    Metal,
    /// Native Direct3D 12 backend.
    Direct3d12,
    /// Native OpenGL or OpenGL ES downlevel backend.
    OpenGl,
}

/// Broad physical-device class used by policy resolution and diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceKind {
    /// Discrete GPU with dedicated memory.
    DiscreteGpu,
    /// Integrated or unified-memory GPU.
    IntegratedGpu,
    /// Virtualized GPU.
    VirtualGpu,
    /// CPU or software adapter.
    Cpu,
    /// Adapter class was not reported.
    Other,
}

/// Optional adapter feature used to select fast or downlevel pipelines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceFeature {
    /// General compute shaders are available.
    Compute,
    /// Indirect draw and dispatch are available.
    IndirectExecution,
    /// Fragment shaders may write storage resources.
    FragmentWritableStorage,
    /// Adapter satisfies the complete WebGPU downlevel contract.
    WebGpuCompliant,
    /// Blendable half-float MRT attachments support weighted blended OIT.
    WeightedBlendedOit,
    /// GPU timestamp queries are available and reliable.
    TimestampQueries,
    /// BC-family block-compressed textures are available.
    TextureCompressionBc,
    /// ETC2/EAC block-compressed textures are available.
    TextureCompressionEtc2,
    /// ASTC LDR block-compressed textures are available.
    TextureCompressionAstc,
    /// ASTC HDR block-compressed textures are available.
    TextureCompressionAstcHdr,
}

/// Measured and queried capabilities used to resolve a device policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCapabilities {
    /// Human-readable adapter name for diagnostics.
    pub adapter_name: String,
    /// Physical device class.
    pub device_kind: DeviceKind,
    /// Active backend.
    pub backend: BackendKind,
    /// Driver name when the platform exposes it.
    pub driver: String,
    /// Driver version or implementation detail when exposed.
    pub driver_info: String,
    /// Supported optional features.
    pub features: Vec<DeviceFeature>,
    /// Maximum two-dimensional texture edge.
    pub max_texture_dimension_2d: u32,
    /// Maximum storage-buffer binding size in bytes.
    pub max_storage_buffer_binding_size: u64,
    /// Maximum buffer size in bytes.
    pub max_buffer_size: u64,
    /// Maximum supported MSAA sample count selected from tested formats.
    pub max_sample_count: u8,
}

impl DeviceCapabilities {
    /// Returns whether an optional feature is available.
    #[must_use]
    pub fn supports(&self, feature: DeviceFeature) -> bool {
        self.features.contains(&feature)
    }
}

/// Three-dimensional f64 vector in project-world coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldVec3 {
    /// X or easting component.
    pub x: f64,
    /// Y or northing component.
    pub y: f64,
    /// Z or height component.
    pub z: f64,
}

/// Axis-aligned f64 bounds in project-world coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldAabb {
    /// Inclusive minimum corner.
    pub min: WorldVec3,
    /// Inclusive maximum corner.
    pub max: WorldVec3,
}

/// Column-major affine transform from content coordinates into project world coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WorldTransform(pub [f64; 16]);

impl WorldTransform {
    /// Identity content-to-world transform.
    pub const IDENTITY: Self = Self([
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ]);

    /// Creates one finite project-world translation.
    #[must_use]
    pub fn from_translation(translation: WorldVec3) -> Option<Self> {
        if !finite_world(translation) {
            return None;
        }
        Some(Self([
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            translation.x,
            translation.y,
            translation.z,
            1.0,
        ]))
    }

    /// Whether this is a finite, invertible affine transform.
    #[must_use]
    pub fn is_invertible_affine(self) -> bool {
        let matrix = DMat4::from_cols_array(&self.0);
        matrix.is_finite()
            && self.0[3].abs() <= f64::EPSILON
            && self.0[7].abs() <= f64::EPSILON
            && self.0[11].abs() <= f64::EPSILON
            && (self.0[15] - 1.0).abs() <= f64::EPSILON
            && matrix.determinant().is_finite()
            && matrix.determinant().abs() > f64::EPSILON
    }

    /// Applies this affine transform to one position.
    #[must_use]
    pub fn transform_point(self, point: WorldVec3) -> Option<WorldVec3> {
        if !self.is_invertible_affine() {
            return None;
        }
        let value = DMat4::from_cols_array(&self.0) * DVec4::new(point.x, point.y, point.z, 1.0);
        (value.is_finite() && value.w.abs() > f64::EPSILON).then(|| WorldVec3 {
            x: value.x / value.w,
            y: value.y / value.w,
            z: value.z / value.w,
        })
    }

    /// Applies only the linear part to one direction or offset.
    #[must_use]
    pub fn transform_vector(self, vector: WorldVec3) -> Option<WorldVec3> {
        if !self.is_invertible_affine() {
            return None;
        }
        let value = DMat3::from_mat4(DMat4::from_cols_array(&self.0))
            * DVec3::new(vector.x, vector.y, vector.z);
        value.is_finite().then_some(WorldVec3 {
            x: value.x,
            y: value.y,
            z: value.z,
        })
    }

    /// Returns `self * inner`, preserving the documented local-to-world order.
    #[must_use]
    pub fn compose(self, inner: Self) -> Option<Self> {
        if !self.is_invertible_affine() || !inner.is_invertible_affine() {
            return None;
        }
        let composed = DMat4::from_cols_array(&self.0) * DMat4::from_cols_array(&inner.0);
        let result = Self(composed.to_cols_array());
        result.is_invertible_affine().then_some(result)
    }

    /// Inverts one affine local-to-world transform.
    #[must_use]
    pub fn inverse(self) -> Option<Self> {
        if !self.is_invertible_affine() {
            return None;
        }
        let result = Self(DMat4::from_cols_array(&self.0).inverse().to_cols_array());
        result.is_invertible_affine().then_some(result)
    }

    /// Conservative maximum length scale, including rotation, shear and non-uniform scale.
    #[must_use]
    pub fn maximum_linear_scale(self) -> Option<f64> {
        if !self.is_invertible_affine() {
            return None;
        }
        let linear = DMat3::from_mat4(DMat4::from_cols_array(&self.0));
        let values = linear.to_cols_array();
        let maximum_column_sum = (0..3)
            .map(|column| (0..3).map(|row| values[column * 3 + row].abs()).sum())
            .fold(0.0_f64, f64::max);
        let maximum_row_sum = (0..3)
            .map(|row| (0..3).map(|column| values[column * 3 + row].abs()).sum())
            .fold(0.0_f64, f64::max);
        let scale = (maximum_column_sum * maximum_row_sum).sqrt();
        (scale.is_finite() && scale > 0.0).then_some(scale)
    }
}

impl Default for WorldTransform {
    fn default() -> Self {
        Self::IDENTITY
    }
}

/// Provider-supplied spatial bound used before content is resident.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BoundingVolume {
    /// Axis-aligned project-world bounds.
    AxisAlignedBox {
        /// Axis-aligned bounds.
        bounds: WorldAabb,
    },
    /// Oriented box with three half-axis vectors.
    OrientedBox {
        /// Box center in project-world coordinates.
        center: WorldVec3,
        /// Column-major X/Y/Z half-axis vectors.
        half_axes: [WorldVec3; 3],
    },
    /// Bounding sphere.
    Sphere {
        /// Sphere center in project-world coordinates.
        center: WorldVec3,
        /// Sphere radius in project units.
        radius: f64,
    },
    /// 3D Tiles geodetic region in radians and metres.
    GeodeticRegion {
        /// Western longitude in radians.
        west: f64,
        /// Southern latitude in radians.
        south: f64,
        /// Eastern longitude in radians.
        east: f64,
        /// Northern latitude in radians.
        north: f64,
        /// Minimum ellipsoidal height in metres.
        minimum_height: f64,
        /// Maximum ellipsoidal height in metres.
        maximum_height: f64,
    },
}

impl BoundingVolume {
    /// Returns a deterministic f64 world anchor owned by this spatial bound.
    ///
    /// Geodetic regions are converted through the WGS84 ellipsoid and averaged
    /// in ECEF space; they are never treated as Cartesian longitude/latitude or
    /// replaced with a zero origin.
    #[must_use]
    pub fn stable_anchor(&self) -> Option<WorldVec3> {
        let anchor = match self {
            Self::AxisAlignedBox { bounds } => {
                if !finite_world(bounds.min)
                    || !finite_world(bounds.max)
                    || bounds.min.x > bounds.max.x
                    || bounds.min.y > bounds.max.y
                    || bounds.min.z > bounds.max.z
                {
                    return None;
                }
                WorldVec3 {
                    x: bounds.min.x + (bounds.max.x - bounds.min.x) * 0.5,
                    y: bounds.min.y + (bounds.max.y - bounds.min.y) * 0.5,
                    z: bounds.min.z + (bounds.max.z - bounds.min.z) * 0.5,
                }
            }
            Self::OrientedBox { center, half_axes } => {
                if !finite_world(*center) || half_axes.iter().any(|axis| !finite_world(*axis)) {
                    return None;
                }
                *center
            }
            Self::Sphere { center, radius } => {
                if !finite_world(*center) || !radius.is_finite() || *radius < 0.0 {
                    return None;
                }
                *center
            }
            Self::GeodeticRegion {
                west,
                south,
                east,
                north,
                minimum_height,
                maximum_height,
            } => {
                if [
                    *west,
                    *south,
                    *east,
                    *north,
                    *minimum_height,
                    *maximum_height,
                ]
                .iter()
                .any(|value| !value.is_finite())
                    || !(-std::f64::consts::PI..=std::f64::consts::PI).contains(west)
                    || !(-std::f64::consts::PI..=std::f64::consts::PI).contains(east)
                    || !(-std::f64::consts::FRAC_PI_2..=std::f64::consts::FRAC_PI_2).contains(south)
                    || !(-std::f64::consts::FRAC_PI_2..=std::f64::consts::FRAC_PI_2).contains(north)
                    || south > north
                    || minimum_height > maximum_height
                {
                    return None;
                }
                let mut sum = glam::DVec3::ZERO;
                for longitude in [*west, *east] {
                    for latitude in [*south, *north] {
                        for height in [*minimum_height, *maximum_height] {
                            sum += geodetic_to_ecef(longitude, latitude, height);
                        }
                    }
                }
                let center = sum / 8.0;
                WorldVec3 {
                    x: center.x,
                    y: center.y,
                    z: center.z,
                }
            }
        };
        finite_world(anchor).then_some(anchor)
    }
}

fn geodetic_to_ecef(longitude: f64, latitude: f64, height: f64) -> glam::DVec3 {
    const SEMI_MAJOR: f64 = 6_378_137.0;
    const ECCENTRICITY_SQUARED: f64 = 6.694_379_990_14e-3;
    let sin_latitude = latitude.sin();
    let cos_latitude = latitude.cos();
    let normal = SEMI_MAJOR / (1.0 - ECCENTRICITY_SQUARED * sin_latitude * sin_latitude).sqrt();
    glam::DVec3::new(
        (normal + height) * cos_latitude * longitude.cos(),
        (normal + height) * cos_latitude * longitude.sin(),
        (normal * (1.0 - ECCENTRICITY_SQUARED) + height) * sin_latitude,
    )
}

fn finite_world(value: WorldVec3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

/// Hierarchy refinement semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefinementMode {
    /// Children add detail while the selected parent remains visible.
    Add,
    /// Fully resident selected children replace their parent.
    Replace,
}

/// Decoded content class. It selects a decoder, not a separate scheduler.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContentKind {
    /// Potree 2.0 point payload.
    PotreePoints,
    /// glTF or GLB mesh payload.
    Gltf,
    /// Legacy or composite 3D Tiles payload requiring container decoding.
    ThreeDTilesContainer,
    /// Raster color or scalar tile.
    Raster,
    /// Gaussian splat payload.
    GaussianSplats,
    /// Directly compiled authored CAD proxy.
    CadProxy,
}

/// Address and expected cost of one tile content payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentReference {
    /// Decoder class.
    pub kind: ContentKind,
    /// Provider-resolvable URI or content-addressed object key.
    pub uri: String,
    /// Byte offset for range-addressed aggregate files.
    pub byte_offset: Option<u64>,
    /// Compressed byte length when known.
    pub byte_length: Option<u64>,
    /// Point, triangle, pixel or splat count when known from hierarchy metadata.
    pub primitive_count: Option<u64>,
    /// Optional immutable content hash.
    pub content_hash: Option<String>,
    /// Versioned decoder-specific parameters retained without scheduler logic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decoder_parameters: Option<serde_json::Value>,
}

/// Lazily loaded hierarchy page referenced by a tile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyPageReference {
    /// Provider-resolvable page or external tileset URI.
    pub uri: String,
    /// Byte offset for pages stored in an aggregate file.
    pub byte_offset: Option<u64>,
    /// Byte length for range requests when known.
    pub byte_length: Option<u64>,
    /// Optional immutable hash of the exact page bytes or requested range.
    #[serde(default)]
    pub content_hash: Option<String>,
    /// Versioned provider metadata attached to the hierarchy content itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decoder_parameters: Option<serde_json::Value>,
}

/// Format-neutral hierarchy node consumed by the global selector.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileDescriptor {
    /// Provider-local tile identity.
    pub id: TileId,
    /// Optional parent identity.
    pub parent: Option<TileId>,
    /// Known children. Providers may populate more children lazily.
    pub children: Vec<TileId>,
    /// Conservative world-space bounds.
    pub bounds: BoundingVolume,
    /// Content-local to project-world transform retained independently from bounds.
    pub content_transform: WorldTransform,
    /// Source geometric error in project units.
    pub geometric_error: f64,
    /// ADD or REPLACE behavior for selected children.
    pub refinement: RefinementMode,
    /// Zero or more contents attached to this node.
    pub contents: Vec<ContentReference>,
    /// Optional child hierarchy page that must be loaded before traversal continues.
    pub child_page: Option<HierarchyPageReference>,
    /// Provider-specific immutable metadata retained for inspection and styling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_metadata: Option<serde_json::Value>,
}

/// Read-only tile hierarchy. Implementations may page descriptors internally.
pub trait HierarchySource {
    /// Provider-specific error.
    type Error;

    /// Dataset identity.
    fn dataset_id(&self) -> &DatasetId;

    /// Root tile identities.
    fn roots(&self) -> &[TileId];

    /// Returns a descriptor, loading hierarchy pages when necessary.
    fn tile(&mut self, id: &TileId) -> Result<Option<TileDescriptor>, Self::Error>;

    /// Returns an immutable shared descriptor for allocation-bounded traversal.
    ///
    /// Providers with large resident hierarchies should override this and store
    /// descriptors behind `Arc`; the default preserves compatibility for small
    /// or procedurally materialized hierarchies.
    fn shared_tile(
        &mut self,
        id: &TileId,
    ) -> Result<Option<std::sync::Arc<TileDescriptor>>, Self::Error> {
        self.tile(id).map(|tile| tile.map(std::sync::Arc::new))
    }
}

/// Resource demand used by every provider and backend.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCost {
    /// Compressed bytes retained on the CPU.
    pub cpu_compressed_bytes: u64,
    /// Decoded bytes retained on the CPU.
    pub cpu_decoded_bytes: u64,
    /// GPU buffer bytes.
    pub gpu_buffer_bytes: u64,
    /// GPU texture bytes including resident mip levels.
    pub gpu_texture_bytes: u64,
    /// Temporary staging bytes required for upload.
    pub staging_bytes: u64,
    /// Rendered or resident point count.
    pub points: u64,
    /// Rendered or resident triangle count.
    pub triangles: u64,
    /// Rendered or resident splat count.
    pub splats: u64,
    /// Draw calls added by the content.
    pub draw_calls: u32,
}

impl ResourceCost {
    /// Adds costs without wrapping on overflow.
    #[must_use]
    pub fn saturating_add(self, other: Self) -> Self {
        Self {
            cpu_compressed_bytes: self
                .cpu_compressed_bytes
                .saturating_add(other.cpu_compressed_bytes),
            cpu_decoded_bytes: self
                .cpu_decoded_bytes
                .saturating_add(other.cpu_decoded_bytes),
            gpu_buffer_bytes: self.gpu_buffer_bytes.saturating_add(other.gpu_buffer_bytes),
            gpu_texture_bytes: self
                .gpu_texture_bytes
                .saturating_add(other.gpu_texture_bytes),
            staging_bytes: self.staging_bytes.saturating_add(other.staging_bytes),
            points: self.points.saturating_add(other.points),
            triangles: self.triangles.saturating_add(other.triangles),
            splats: self.splats.saturating_add(other.splats),
            draw_calls: self.draw_calls.saturating_add(other.draw_calls),
        }
    }

    /// Subtracts costs without underflowing individual dimensions.
    #[must_use]
    pub fn saturating_sub(self, other: Self) -> Self {
        Self {
            cpu_compressed_bytes: self
                .cpu_compressed_bytes
                .saturating_sub(other.cpu_compressed_bytes),
            cpu_decoded_bytes: self
                .cpu_decoded_bytes
                .saturating_sub(other.cpu_decoded_bytes),
            gpu_buffer_bytes: self.gpu_buffer_bytes.saturating_sub(other.gpu_buffer_bytes),
            gpu_texture_bytes: self
                .gpu_texture_bytes
                .saturating_sub(other.gpu_texture_bytes),
            staging_bytes: self.staging_bytes.saturating_sub(other.staging_bytes),
            points: self.points.saturating_sub(other.points),
            triangles: self.triangles.saturating_sub(other.triangles),
            splats: self.splats.saturating_sub(other.splats),
            draw_calls: self.draw_calls.saturating_sub(other.draw_calls),
        }
    }
}

/// Device-policy limits shared by all visible content kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceBudget {
    /// Maximum compressed CPU residency.
    pub cpu_compressed_bytes: u64,
    /// Maximum decoded CPU residency.
    pub cpu_decoded_bytes: u64,
    /// Maximum GPU buffer residency.
    pub gpu_buffer_bytes: u64,
    /// Maximum GPU texture residency.
    pub gpu_texture_bytes: u64,
    /// Maximum staging bytes in flight.
    pub staging_bytes: u64,
    /// Maximum resident or selected points.
    pub points: u64,
    /// Maximum resident or selected triangles.
    pub triangles: u64,
    /// Maximum resident or selected splats.
    pub splats: u64,
    /// Maximum draw calls.
    pub draw_calls: u32,
}

impl ResourceBudget {
    /// Returns whether a combined cost fits every resource dimension.
    #[must_use]
    pub fn contains(self, cost: ResourceCost) -> bool {
        cost.cpu_compressed_bytes <= self.cpu_compressed_bytes
            && cost.cpu_decoded_bytes <= self.cpu_decoded_bytes
            && cost.gpu_buffer_bytes <= self.gpu_buffer_bytes
            && cost.gpu_texture_bytes <= self.gpu_texture_bytes
            && cost.staging_bytes <= self.staging_bytes
            && cost.points <= self.points
            && cost.triangles <= self.triangles
            && cost.splats <= self.splats
            && cost.draw_calls <= self.draw_calls
    }
}

/// Time-sensitive limits applied in addition to residency budgets.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameBudget {
    /// Target complete frame time in milliseconds.
    pub target_frame_ms: f32,
    /// CPU time granted to hierarchy traversal and scheduling.
    pub traversal_ms: f32,
    /// CPU decode time allowed to complete per frame.
    pub decode_ms: f32,
    /// Bytes that may be uploaded in one frame without explicit override.
    pub upload_bytes: u64,
    /// Maximum new content requests started in one frame.
    pub new_requests: u16,
}

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
