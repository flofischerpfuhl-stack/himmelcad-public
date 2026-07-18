//! WASM facade for the shared `HimmelCAD` viewer kernel.
//!
//! Mirrors the sidecar JSON-RPC surface, but transported over `postMessage`
//! between the UI thread and a Web Worker hosting this module. The same Rust
//! core powers both targets.

#![forbid(unsafe_code)]

#[cfg(any(test, target_arch = "wasm32"))]
mod alignment_preview_bridge;

use serde::Deserialize;
#[cfg(target_arch = "wasm32")]
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
use alignment_preview_bridge::{
    partition_proxy_ids, render_proxy_id, AlignmentPreviewSessionStore,
};

#[cfg(target_arch = "wasm32")]
use std::collections::{BTreeMap, BTreeSet};
#[cfg(target_arch = "wasm32")]
use std::mem::size_of;
#[cfg(target_arch = "wasm32")]
use std::sync::Arc;

#[cfg(target_arch = "wasm32")]
use glam::{DMat4, DVec3};

#[cfg(target_arch = "wasm32")]
use himmelcad_core::canonical_document::{
    CanonicalCommandTransaction, CanonicalDocument, CanonicalJournalEntry, EntityVersionRef,
};
#[cfg(target_arch = "wasm32")]
use himmelcad_core::canonical_resource_catalog::{
    CanonicalPresentationResourceCatalog, CanonicalPresentationResourceSet,
};
#[cfg(target_arch = "wasm32")]
use himmelcad_core::canonical_resources::{
    validate_block_definition_set, validate_hatch_pattern_resource, validate_line_type_resource,
    BlockDefinition, BlockMember, BlockMemberAttributes, BlockMemberSource, BlockMemberStyle,
    CanonicalResourceRef, HatchPatternResource, LineTypeElement, LineTypePattern, LineTypeResource,
    MaterialAlphaMode, MaterialResource, MaterialTableResource, MaterialTextureSlot,
    TextureColorSpace, TextureFilter, TextureResource, TextureWrapMode,
    LINE_TYPE_RESOURCE_SCHEMA_ID,
};
#[cfg(target_arch = "wasm32")]
use himmelcad_core::entity_commands::{
    apply_transform_entity, restore_entity_placement, AppliedEntityPlacementCommand,
    EntityCommandJournal, EntityCommandJournalEntry, EntityCommandJournalKind,
    TransformEntityCommand,
};
#[cfg(target_arch = "wasm32")]
use himmelcad_core::entity_model::{
    AnnotationAnchor, CameraModel, CanonicalEntity, CurveGeometry, CurveUse, DepthSemantics,
    DimensionGeometry, DimensionKind, ElevationSurfaceGeometry, GeometryObject, GeometryResource,
    PanoramaGeometry, Position, RasterCellDiagonal, RasterConfidenceEncoding, RasterConnectivity,
    RasterMapping, RepresentationAuthority, RepresentationRole, SolidGeometry, TextGeometry,
    TextSpace, Transform3d, TriangleMeshGeometry, TriangleMeshStorage, Vector3,
};
#[cfg(target_arch = "wasm32")]
use himmelcad_core::entity_validation::{geometry_object_content_hash, validate_geometry_object};
#[cfg(target_arch = "wasm32")]
use himmelcad_core::geometry_representation_registry::{
    CanonicalRepresentationAdmission, GeometryRepresentationBindingRef,
    GeometryRepresentationSlotKey, SectionIndexComponentType, SectionPositionComponentType,
    SectionTopologyPartitionManifest,
};
#[cfg(target_arch = "wasm32")]
use himmelcad_core::{entity::EntityId, hash::ObjectHash};
#[cfg(target_arch = "wasm32")]
use himmelcad_render::{
    authoritative_section_product_matches, build_cad_curve_batch, build_elevation_raster_batch,
    build_gaussian_splat_batches, build_instanced_glb_geometries_with_queue, build_potree_batch,
    build_section_region_batch, build_text_batch_with_texture,
    build_three_d_tiles_batches_with_resources, compile_entity_geometry,
    compile_entity_geometry_with_associations, decode_artifact, glb_texture_source_keys,
    gpu_indexed_geometry_identity, gpu_uploaded_texture_identity, inspect_gltf_dependencies,
    instanced_model_chunks, layout_text, potree_point_world_position,
    prepare_glb_texture_uploads_for_sources, project_raster_sample, raster_analysis_view,
    reconstruct_coarse_pick_candidates, refine_decoded_potree_point_pick, refine_exact_point_pick,
    refine_potree_point_pick, refine_tessellated_curve_pick, required_entity_proxy_slots,
    required_three_d_tiles_proxy_slots, resolve_entity_point_world, section_geometry_object,
    tessellate_entity_strokes, tessellate_entity_strokes_with_associations,
    tessellate_generated_solid_mesh, transform_bounding_volume,
    validate_authoritative_section_product, validate_glyph_atlas, AlignmentPreviewPartition,
    AssetBundleLimits, AuthoritativeSectionAccumulator, AuthoritativeSectionProduct, BackendPolicy,
    BoundingVolume, CameraFrame, ClipOperation, ClipVolume, CurveTessellationOptions, DatasetId,
    DecodedFeatureIdBinding, DecodedFeatureImage, DecodedLegacyBatchIds,
    DecodedLegacyBatchTableCatalog, DecodedMeshFeatureSet, DecodedPrimitivePropertyAttribute,
    DecodedPrimitivePropertyTexture, DecodedStreamingPayload, DecodedStructuralMetadata,
    DecodedThreeDTilesContent, DecodedTriangleFeatureId, DeviceCalibration,
    ElevationRasterPickRefiner, EntityCompilationOptions, EntityInteractionState,
    EvaluatedMeshRecipe, EvaluatedMeshRepresentation, FillMode, FloatingOrigin,
    FrameTelemetrySample, FrameTelemetryWindow, GaussianSplatPickRefiner,
    GeometryRepresentationRegistry, GlyphAtlas, GlyphMetrics, GpuAlphaMode, GpuCalibrationProgress,
    GpuCalibrationSession, GpuCanonicalMaterial, GpuCanonicalTextureBinding, GpuDrawBatch,
    GpuHatchPattern, GpuHatchPatternData, GpuHatchResource, GpuIndexedMeshGeometry,
    GpuLineTypePattern, GpuLineTypeResource, GpuModelResourceIdentity, GpuPresentationStyle,
    GpuRecoveryReason, GpuSurfaceHost, GpuTextureAddressMode, GpuTextureColorSpace, GpuTextureData,
    GpuTextureFilterMode, GpuTextureMipChainData, GpuTextureResource, GpuTextureResourceCache,
    GpuTextureResourceIdentity, GpuTextureResourceStage, GpuTextureSamplerIdentity,
    GpuTextureTransform, HardwareDeploymentProfile, HardwareInventory, HardwarePolicyResolver,
    HierarchySource, ImplicitThreeDTilesHierarchySource, InstancedTriangleMeshPickRefiner,
    MeshPickRefiner, PickCandidate, PickCycle, PickRefinementRequest, PotreeHierarchySource,
    PotreePointLayout, PreparedAssetBundle, PreparedGpuTextureResources, PreparedHierarchySource,
    PreparedRasterTileContract, PresentationTransform, QualityAdjustment, RasterAnalysisView,
    RenderProxy, RenderProxyId, RenderProxyKind, RenderStyle, RenderWorld, ResidencyTicket,
    ResolvedAssetEntry, ResolvedGeometryRepresentationAdmission, ResourceBudget, ResourceCost,
    RuntimeQualityGovernor, RuntimeQualityState, SectionBatchOptions, SectionHatchStyle,
    SectionMaterialRegionBinding, SectionPlane, SectionProduct, SectionRegion, SectionTopologyPart,
    SectionTopologyPartitionData, SectionTopologySnapshotKey, SharedAssetBlobCache, SnapKind,
    StreamingCoordinator, StreamingRuntimeLimits, StrokeMode, SurfaceFrame, SurfaceFrameOutcome,
    SurfacePickRequest, TessellatedCurve, TessellatedCurvePath, TessellatedCurveSegment,
    TextAlignment, TextBatchOptions, TextLayoutOptions, TextLayoutSpace, ThreeDTilesContentKind,
    ThreeDTilesHierarchySource, TileId, TileKey, TileSelection, TileSelectionView, TileSelector,
    TimingSample, TriangleMeshPickInstance, TriangleMeshPickRefiner, TriangleMeshPickSource,
    UnresolvedHeightDisplay, WorldAabb, WorldCamera, WorldTransform, WorldVec3,
    GPU_POINT_VERTEX_STRIDE_BYTES, SORTED_ALPHA_MESH_INSTANCE_BLOCK_SIZE,
};
#[cfg(target_arch = "wasm32")]
use web_sys::HtmlCanvasElement;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Render-independent canonical document authority for browser and Electron
/// hosts. Viewer instances consume its committed snapshots but do not own them.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct WasmCanonicalDocument {
    inner: CanonicalDocument,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl WasmCanonicalDocument {
    /// Creates an empty canonical document.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: CanonicalDocument::default(),
        }
    }

    /// Reconstructs canonical state by validating every persisted journal entry.
    pub fn from_journal_json(journal_json: &str) -> Result<WasmCanonicalDocument, JsValue> {
        let entries: Vec<CanonicalJournalEntry> =
            serde_json::from_str(journal_json).map_err(js_error)?;
        let inner = CanonicalDocument::from_journal(&entries).map_err(js_error)?;
        Ok(Self { inner })
    }

    /// Executes one atomic typed create/update/delete/restore transaction.
    pub fn execute_transaction_json(&mut self, transaction_json: &str) -> Result<String, JsValue> {
        let transaction: CanonicalCommandTransaction =
            serde_json::from_str(transaction_json).map_err(js_error)?;
        let entry = self.inner.execute(transaction).map_err(js_error)?;
        serde_json::to_string(&entry).map_err(js_error)
    }

    /// Appends a conflict-aware compensating transaction for one root command.
    pub fn undo_json(
        &mut self,
        command_id: &str,
        target_command_id: &str,
    ) -> Result<String, JsValue> {
        let prepared = self
            .inner
            .prepare_undo(command_id.to_owned(), target_command_id)
            .map_err(js_error)?;
        let entry = self.inner.commit(prepared).map_err(js_error)?;
        serde_json::to_string(&entry).map_err(js_error)
    }

    /// Appends a conflict-aware forward reapplication of an undone command.
    pub fn redo_json(
        &mut self,
        command_id: &str,
        target_command_id: &str,
    ) -> Result<String, JsValue> {
        let prepared = self
            .inner
            .prepare_redo(command_id.to_owned(), target_command_id)
            .map_err(js_error)?;
        let entry = self.inner.commit(prepared).map_err(js_error)?;
        serde_json::to_string(&entry).map_err(js_error)
    }

    /// Returns one current live canonical entity or JSON null.
    pub fn entity_json(&self, entity_id: &str) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.entity(&EntityId(entity_id.to_owned()))).map_err(js_error)
    }

    /// Returns one current tombstone or JSON null.
    pub fn tombstone_json(&self, entity_id: &str) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.tombstone(&EntityId(entity_id.to_owned())))
            .map_err(js_error)
    }

    /// Returns all live entities in stable identity order.
    pub fn entities_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.entities().collect::<Vec<_>>()).map_err(js_error)
    }

    /// Returns the complete durable forward journal.
    pub fn journal_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(self.inner.journal()).map_err(js_error)
    }

    /// JavaScript-safe monotone document generation.
    #[must_use]
    pub fn generation(&self) -> f64 {
        self.inner.generation() as f64
    }
}

#[cfg(target_arch = "wasm32")]
impl Default for WasmCanonicalDocument {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
pub fn ping() -> String {
    serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }).to_string()
}

#[cfg(any(test, target_arch = "wasm32"))]
fn validate_decoded_potree_cardinality(
    declared_point_count: u64,
    position_count: usize,
    color_count: usize,
    civil_attribute_count: Option<usize>,
) -> Result<(), &'static str> {
    let declared_point_count = usize::try_from(declared_point_count)
        .map_err(|_| "Potree metadata point count exceeds portable addressing")?;
    if position_count != declared_point_count
        || color_count != declared_point_count
        || civil_attribute_count.is_some_and(|count| count != declared_point_count)
    {
        return Err("Potree worker artifact point count disagrees with metadata");
    }
    Ok(())
}

#[cfg(any(test, target_arch = "wasm32"))]
fn validate_decoded_splat_cardinality(
    maximum_splats: usize,
    splat_count: usize,
    source_position_count: usize,
) -> Result<(), &'static str> {
    if splat_count > maximum_splats {
        return Err("Gaussian worker artifact exceeds the declared splat bound");
    }
    if source_position_count != splat_count {
        return Err("Gaussian worker artifact source positions disagree with splats");
    }
    Ok(())
}

#[cfg(any(test, target_arch = "wasm32"))]
fn validate_decoded_raster_cardinality(
    declared_elevation_width: u32,
    declared_elevation_height: u32,
    declared_color_width: u32,
    declared_color_height: u32,
    decoded_width: u32,
    decoded_height: u32,
    decoded_color_width: u32,
    decoded_color_height: u32,
    rgba_count: usize,
    elevation_count: usize,
) -> Result<(), &'static str> {
    if decoded_width != declared_elevation_width
        || decoded_height != declared_elevation_height
        || decoded_color_width != declared_color_width
        || decoded_color_height != declared_color_height
    {
        return Err("Raster worker artifact dimensions disagree with metadata");
    }
    let elevation_count_expected = usize::try_from(declared_elevation_width)
        .ok()
        .and_then(|width| {
            usize::try_from(declared_elevation_height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or("Raster metadata dimensions exceed portable addressing")?;
    let color_count = usize::try_from(declared_color_width)
        .ok()
        .and_then(|width| {
            usize::try_from(declared_color_height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or("Raster color dimensions exceed portable addressing")?;
    let expected_rgba_count = color_count
        .checked_mul(4)
        .ok_or("Raster metadata color band exceeds portable addressing")?;
    if rgba_count != expected_rgba_count || elevation_count != elevation_count_expected {
        return Err("Raster worker artifact bands disagree with metadata");
    }
    Ok(())
}

#[cfg(any(test, target_arch = "wasm32"))]
fn split_streamed_raster_bands(
    packed: &[u8],
    elevation_length: usize,
    validity_length: usize,
    confidence_length: usize,
    triangle_mask_length: usize,
) -> Result<(&[u8], Option<&[u8]>, Option<&[u8]>, Option<&[u8]>), &'static str> {
    let validity_end = elevation_length
        .checked_add(validity_length)
        .ok_or("Raster side-band byte length overflow")?;
    let confidence_end = validity_end
        .checked_add(confidence_length)
        .ok_or("Raster side-band byte length overflow")?;
    let total = confidence_end
        .checked_add(triangle_mask_length)
        .ok_or("Raster side-band byte length overflow")?;
    if total != packed.len() {
        return Err("Raster side-band lengths disagree with transferred payload");
    }
    Ok((
        &packed[..elevation_length],
        (validity_length != 0).then_some(&packed[elevation_length..validity_end]),
        (confidence_length != 0).then_some(&packed[validity_end..confidence_end]),
        (triangle_mask_length != 0).then_some(&packed[confidence_end..]),
    ))
}

/// Browser-owned render surface backed by the same `wgpu` kernel as native apps.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct WasmViewer {
    _instance: wgpu::Instance,
    canvas: HtmlCanvasElement,
    host: GpuSurfaceHost<'static>,
    view_projection: [[f32; 4]; 4],
    floating_origin: WorldVec3,
    clear_color: wgpu::Color,
    render_world: RenderWorld,
    batches: BTreeMap<RenderProxyId, Vec<GpuDrawBatch>>,
    representation_registry: GeometryRepresentationRegistry,
    canonical_admissions: BTreeMap<String, WasmCanonicalRenderAdmission>,
    slot_requests: BTreeMap<String, WasmEntityRenderRequest>,
    slot_bindings: BTreeMap<String, GeometryRepresentationBindingRef>,
    slot_dataset_ids: BTreeMap<String, String>,
    dataset_slot_keys: BTreeMap<String, String>,
    entity_slot_keys: BTreeMap<String, std::collections::BTreeSet<String>>,
    primary_slot_keys: BTreeMap<String, String>,
    entity_requests: BTreeMap<String, WasmEntityRenderRequest>,
    streamed_requests: BTreeMap<String, WasmThreeDTilesRequest>,
    external_asset_cache: SharedAssetBlobCache,
    gpu_model_cache: WasmGpuModelCache,
    gpu_texture_cache: GpuTextureResourceCache<GpuTextureResource>,
    gpu_texture_source_identities: BTreeMap<[u8; 32], GpuTextureResourceIdentity>,
    gpu_texture_decode_count: u64,
    gpu_texture_factory_count: u64,
    worker_artifact_ingest_count: u64,
    main_thread_stream_decode_count: u64,
    mesh_pick_indices: BTreeMap<String, MeshPickRefiner>,
    stream_proxy_transforms: BTreeMap<String, WorldTransform>,
    gltf_feature_catalogs: BTreeMap<String, WasmGltfFeatureCatalog>,
    potree_requests: BTreeMap<String, WasmPotreeRequest>,
    potree_proxy_streams: BTreeMap<String, String>,
    staged_three_d_tiles: BTreeMap<String, WasmStagedThreeDTiles>,
    staged_potree: BTreeMap<String, WasmStagedPotree>,
    splat_requests: BTreeMap<String, WasmGaussianSplatRequest>,
    splat_proxy_streams: BTreeMap<String, String>,
    splat_pick_indices: BTreeMap<String, GaussianSplatPickRefiner>,
    staged_splats: BTreeMap<String, WasmStagedGaussianSplats>,
    raster_requests: BTreeMap<String, WasmRasterRequest>,
    raster_proxy_streams: BTreeMap<String, String>,
    raster_pick_indices: BTreeMap<String, ElevationRasterPickRefiner>,
    staged_rasters: BTreeMap<String, WasmStagedRaster>,
    section_requests: BTreeMap<String, WasmSectionRequest>,
    section_proxy_ids: BTreeMap<String, Vec<RenderProxyId>>,
    entity_dependents: BTreeMap<String, std::collections::BTreeSet<String>>,
    entity_sections: BTreeMap<String, std::collections::BTreeSet<String>>,
    entity_streams: BTreeMap<String, std::collections::BTreeSet<String>>,
    stream_entities: BTreeMap<String, String>,
    slot_streams: BTreeMap<String, std::collections::BTreeSet<String>>,
    stream_slots: BTreeMap<String, String>,
    dataset_streams: BTreeMap<String, std::collections::BTreeSet<String>>,
    stream_datasets: BTreeMap<String, String>,
    clip_volumes: Vec<ClipVolume>,
    camera_frame: Option<CameraFrame>,
    streaming: StreamingCoordinator,
    explicit_tilesets: BTreeMap<String, ThreeDTilesHierarchySource>,
    implicit_tilesets: BTreeMap<String, ImplicitThreeDTilesHierarchySource>,
    potree_datasets: BTreeMap<String, PotreeHierarchySource>,
    prepared_datasets: BTreeMap<String, PreparedHierarchySource>,
    registered_dataset_contracts: BTreeMap<String, WasmRegisteredDatasetContract>,
    entity_styles: BTreeMap<String, (RenderStyle, f64)>,
    entity_interactions: BTreeMap<String, EntityInteractionState>,
    glyph_atlases: BTreeMap<String, WasmGlyphAtlasResource>,
    annotation_styles: BTreeMap<String, WasmAnnotationStyle>,
    block_definitions: BTreeMap<String, BlockDefinition>,
    block_member_styles: BTreeMap<String, (CanonicalResourceRef, RenderStyle)>,
    block_attribute_tables: BTreeSet<String>,
    block_member_entity_versions: BTreeMap<String, (EntityVersionRef, WasmEntityRenderRequest)>,
    image_resources: BTreeMap<String, WasmImageResource>,
    depth_resources: BTreeMap<String, WasmDepthResource>,
    raster_binary_resources: BTreeMap<String, WasmBinaryResource>,
    raster_analysis_view: Option<WasmRasterAnalysisViewState>,
    mesh_resources: BTreeMap<String, TriangleMeshGeometry>,
    material_resources: WasmMaterialResourceRegistry,
    hatch_resources: WasmHatchResourceRegistry,
    line_type_resources: WasmLineTypeResourceRegistry,
    section_products: BTreeMap<String, AuthoritativeSectionProduct>,
    section_evaluations: BTreeMap<String, AuthoritativeSectionAccumulator>,
    move_previews: BTreeMap<String, WasmMovePreview>,
    entity_move_previews: BTreeMap<String, std::collections::BTreeSet<String>>,
    entity_command_journal: EntityCommandJournal,
    entity_undo_stack: Vec<WasmEntityPlacementHistory>,
    entity_redo_stack: Vec<WasmEntityPlacementHistory>,
    clip_preview_batches: Vec<GpuDrawBatch>,
    clip_preview_material_slots: Vec<u32>,
    clip_preview_cost: ResourceCost,
    frame_origin_queue_write_count: u64,
    last_frame_origin_queue_writes: u64,
    last_transaction_diagnostics: WasmTransactionDiagnostics,
    calibration_session: Option<GpuCalibrationSession>,
    runtime_quality: Option<RuntimeQualityGovernor>,
    frame_telemetry: FrameTelemetryWindow,
    alignment_preview_sessions: AlignmentPreviewSessionStore,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamContentKind {
    ThreeDTiles,
    Potree,
    GaussianSplats,
    Raster,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug)]
enum WasmStagedContent {
    ThreeDTiles(WasmStagedThreeDTiles),
    Potree(WasmStagedPotree),
    GaussianSplats(WasmStagedGaussianSplats),
    Raster(WasmStagedRaster),
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmTransactionDiagnostics {
    touched_entities: usize,
    touched_sections: usize,
    touched_proxies: usize,
    foreign_visits: usize,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmRasterDepthMeasurement {
    entity_id: String,
    column: u32,
    row: u32,
    depth: f64,
    confidence: Option<f64>,
    source_position: WorldVec3,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmRasterDepthPick {
    entity_id: String,
    column: u32,
    row: u32,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmRasterDepthMeasurementSet {
    picks: Vec<WasmRasterDepthMeasurement>,
    segment_distances: Vec<f64>,
    total_distance: f64,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmRasterAnalysisViewDescriptor {
    entity_id: String,
    version_hash: Option<String>,
    width: u32,
    height: u32,
    #[serde(flatten)]
    camera: RasterAnalysisView,
}

#[cfg(target_arch = "wasm32")]
struct WasmRasterAnalysisViewState {
    entity_id: String,
    proxy_id: RenderProxyId,
    analysis_batch: GpuDrawBatch,
    cost: ResourceCost,
}

#[cfg(target_arch = "wasm32")]
impl WasmStagedContent {
    fn stream_id(&self) -> &str {
        match self {
            Self::ThreeDTiles(staged) => &staged.request.metadata.stream_id,
            Self::Potree(staged) => &staged.request.metadata.stream_id,
            Self::GaussianSplats(staged) => &staged.request.metadata.stream_id,
            Self::Raster(staged) => &staged.request.metadata.stream_id,
        }
    }
}

#[cfg(target_arch = "wasm32")]
impl WasmViewer {
    fn install_hatch_resource(&mut self, resource: HatchPatternResource) -> Result<(), String> {
        validate_hatch_pattern_resource(&resource).map_err(|error| error.to_string())?;
        let reference = resource.resource_ref();
        let key = canonical_resource_ref_key(&reference)?;
        if self.hatch_resources.gpu.contains_key(&key) {
            return Err("hatch resource revision is already registered".to_owned());
        }
        let pattern = GpuHatchPatternData::from_canonical(&resource.pattern)
            .map_err(|error| error.to_string())?;
        let gpu = self
            .host
            .renderer()
            .create_hatch_resource(
                self.host.device(),
                self.host.queue(),
                &format!("himmelcad-hatch-{}", reference.resource_id),
                pattern,
            )
            .map_err(|error| error.to_string())?;
        self.hatch_resources
            .catalog
            .publish(CanonicalPresentationResourceSet {
                hatch_patterns: vec![resource],
                ..CanonicalPresentationResourceSet::default()
            })
            .map_err(|error| error.to_string())?;
        self.hatch_resources.gpu.insert(key, gpu);
        Ok(())
    }

    fn install_line_type_resource(
        &mut self,
        resource: LineTypeResource,
        phase: f64,
    ) -> Result<(), String> {
        validate_line_type_resource(&resource).map_err(|error| error.to_string())?;
        let pattern = match phase {
            0.0 => GpuLineTypePattern::from_canonical(&resource.pattern),
            _ => match &resource.pattern {
                LineTypePattern::Repeating { elements } => {
                    let mut segments = Vec::with_capacity(elements.len());
                    for element in elements {
                        match element {
                            LineTypeElement::Dash { length } | LineTypeElement::Gap { length } => {
                                segments.push(*length);
                            }
                            LineTypeElement::Dot => {
                                return Err(
                                    "legacy phase cannot be applied to canonical dot elements"
                                        .to_owned(),
                                );
                            }
                        }
                    }
                    GpuLineTypePattern::new(&segments, phase)
                }
                LineTypePattern::Continuous => {
                    GpuLineTypePattern::from_canonical(&resource.pattern)
                }
            },
        }
        .map_err(|error| error.to_string())?;
        self.install_line_type_resource_with_pattern(resource, pattern)
    }

    fn install_line_type_resource_with_pattern(
        &mut self,
        resource: LineTypeResource,
        pattern: GpuLineTypePattern,
    ) -> Result<(), String> {
        validate_line_type_resource(&resource).map_err(|error| error.to_string())?;
        let reference = resource.resource_ref();
        let key = canonical_resource_ref_key(&reference)?;
        if self.line_type_resources.gpu.contains_key(&key) {
            return Err("line-type resource revision is already registered".to_owned());
        }
        let gpu = self
            .host
            .renderer()
            .create_line_type_resource(
                self.host.device(),
                self.host.queue(),
                &format!("himmelcad-line-type-{}", reference.resource_id),
                pattern,
            )
            .map_err(|error| error.to_string())?;
        self.line_type_resources
            .catalog
            .publish(CanonicalPresentationResourceSet {
                line_types: vec![resource],
                ..CanonicalPresentationResourceSet::default()
            })
            .map_err(|error| error.to_string())?;
        self.line_type_resources.gpu.insert(key, gpu);
        Ok(())
    }

    fn reject_cross_provider_staged_stream_id(
        &self,
        stream_id: &str,
        kind: StreamContentKind,
    ) -> Result<(), JsValue> {
        let staged_by_other = (kind != StreamContentKind::ThreeDTiles
            && self.staged_three_d_tiles.contains_key(stream_id))
            || (kind != StreamContentKind::Potree && self.staged_potree.contains_key(stream_id))
            || (kind != StreamContentKind::GaussianSplats
                && self.staged_splats.contains_key(stream_id))
            || (kind != StreamContentKind::Raster && self.staged_rasters.contains_key(stream_id));
        if staged_by_other {
            Err(JsValue::from_str(
                "streamId is already staged by different content",
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmEntityRenderRequest {
    entity_id: String,
    proxy_id: String,
    #[serde(default)]
    version_hash: Option<String>,
    #[serde(default)]
    source_revision: Option<u64>,
    #[serde(default)]
    attributes_ref: Option<ObjectHash>,
    #[serde(default)]
    evaluated_mesh_resource_ref: Option<String>,
    geometry: GeometryObject,
    #[serde(default)]
    style: RenderStyle,
    #[serde(default)]
    placement: Option<Transform3d>,
    /// Presentation plane asserted by an explicitly locked top-down plan view.
    #[serde(default)]
    locked_plan_elevation: Option<f64>,
    #[serde(default = "default_chord_tolerance")]
    chord_tolerance: f64,
    #[serde(default = "default_curve_segments")]
    maximum_curve_segments: u32,
    #[serde(default = "default_line_width")]
    line_width: f32,
    #[serde(default = "default_plane_extent")]
    plane_extent: f64,
    #[serde(default)]
    fill_areas: bool,
    #[serde(default)]
    exaggeration_datum: f64,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmCanonicalRenderAdmission {
    admission: CanonicalRepresentationAdmission,
    #[serde(default)]
    dataset_id: Option<String>,
    #[serde(default)]
    evaluated_mesh: Option<WasmEvaluatedMeshAdmission>,
    #[serde(default)]
    style: RenderStyle,
    /// Presentation plane asserted by an explicitly locked top-down plan view.
    #[serde(default)]
    locked_plan_elevation: Option<f64>,
    #[serde(default = "default_chord_tolerance")]
    chord_tolerance: f64,
    #[serde(default = "default_curve_segments")]
    maximum_curve_segments: u32,
    #[serde(default = "default_line_width")]
    line_width: f32,
    #[serde(default = "default_plane_extent")]
    plane_extent: f64,
    #[serde(default)]
    fill_areas: bool,
    #[serde(default)]
    exaggeration_datum: f64,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmEvaluatedMeshAdmission {
    mesh_resource_ref: ObjectHash,
    provider_id: String,
    provider_version: String,
    #[serde(default)]
    parameters_ref: Option<ObjectHash>,
    #[serde(default)]
    dataset_id: Option<String>,
    parts: Vec<SectionTopologyPart>,
    material_keys: BTreeMap<u32, String>,
    closed_manifold: bool,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmRegisteredDatasetContract {
    format_id: String,
    metadata_hash: ObjectHash,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmPreparedCanonicalSlot {
    storage_key: String,
    request: WasmEntityRenderRequest,
    base_style: RenderStyle,
    dataset_id: Option<String>,
    primary: bool,
    admission: ResolvedGeometryRepresentationAdmission,
}

#[cfg(target_arch = "wasm32")]
macro_rules! resolve_stream_metadata {
    ($viewer:expr, $metadata:expr) => {{
        let (entity_id, proxy_id, style, exaggeration_datum, source_to_project) = $viewer
            .resolve_canonical_stream_binding(
                &$metadata.slot,
                &$metadata.binding,
                &$metadata.dataset_id,
                &$metadata.tile_id,
                &$metadata.stream_id,
            )?;
        $metadata.entity_id = entity_id;
        $metadata.proxy_id = proxy_id;
        $metadata.style = style;
        $metadata.exaggeration_datum = exaggeration_datum;
        $metadata.source_to_project = source_to_project;
    }};
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmThreeDTilesMetadata {
    stream_id: String,
    slot: GeometryRepresentationSlotKey,
    binding: GeometryRepresentationBindingRef,
    #[serde(skip)]
    entity_id: String,
    #[serde(skip)]
    proxy_id: String,
    dataset_id: String,
    tile_id: String,
    #[serde(rename = "contentUri")]
    _content_uri: String,
    #[serde(rename = "contentKind")]
    _content_kind: ThreeDTilesContentKind,
    bounds: BoundingVolume,
    #[serde(default, rename = "contentTransform")]
    _content_transform: Option<WorldTransform>,
    #[serde(skip)]
    style: RenderStyle,
    #[serde(skip)]
    exaggeration_datum: f64,
    #[serde(skip)]
    source_to_project: WorldTransform,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmThreeDTilesRequest {
    metadata: WasmThreeDTilesMetadata,
    bytes: Vec<u8>,
    resources: PreparedAssetBundle,
    leaf_count: usize,
    gpu_texture_bindings: BTreeMap<[u8; 32], GpuTextureResourceIdentity>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmResolvedAssetBundleManifest {
    schema_version: u32,
    entries: Vec<ResolvedAssetEntry>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmAssetInspectionMetadata {
    content_uri: String,
    content_kind: ThreeDTilesContentKind,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmPotreeMetadata {
    stream_id: String,
    slot: GeometryRepresentationSlotKey,
    binding: GeometryRepresentationBindingRef,
    #[serde(skip)]
    entity_id: String,
    #[serde(skip)]
    proxy_id: String,
    dataset_id: String,
    tile_id: String,
    bounds: BoundingVolume,
    point_count: u64,
    #[serde(skip)]
    style: RenderStyle,
    #[serde(skip)]
    exaggeration_datum: f64,
    #[serde(skip)]
    source_to_project: WorldTransform,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmPotreeRequest {
    metadata: WasmPotreeMetadata,
    layout: PotreePointLayout,
    bytes: Vec<u8>,
    decoded: Option<himmelcad_render::DecodedPotreePoints>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmStagedThreeDTiles {
    request: WasmThreeDTilesRequest,
    decoded: DecodedThreeDTilesContent,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Default)]
struct WasmPreparedGpuModels {
    models: BTreeMap<GpuModelResourceIdentity, Vec<GpuIndexedMeshGeometry>>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Default)]
struct WasmPreparedGpuTextures {
    resources: PreparedGpuTextureResources,
    bindings: BTreeMap<[u8; 32], GpuTextureResourceIdentity>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug)]
struct WasmResidentGpuModel {
    geometries: Vec<GpuIndexedMeshGeometry>,
    staged_refs: usize,
    resident_refs: usize,
    resident_bytes: u64,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Default)]
struct WasmGpuModelCache {
    models: BTreeMap<GpuModelResourceIdentity, WasmResidentGpuModel>,
    owners: BTreeMap<String, std::collections::BTreeSet<GpuModelResourceIdentity>>,
    staged_owners: BTreeMap<String, std::collections::BTreeSet<GpuModelResourceIdentity>>,
    resident_bytes: u64,
}

#[cfg(target_arch = "wasm32")]
impl WasmGpuModelCache {
    fn staged_upload_bytes<'a>(&self, owners: impl IntoIterator<Item = &'a str>) -> u64 {
        let identities = owners
            .into_iter()
            .filter_map(|owner| self.staged_owners.get(owner))
            .flatten()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        identities.into_iter().fold(0_u64, |bytes, identity| {
            let additional = self.models.get(&identity).map_or(0, |model| {
                if model.resident_refs == 0 {
                    model.resident_bytes
                } else {
                    0
                }
            });
            bytes.saturating_add(additional)
        })
    }

    fn prepare_staged(
        &mut self,
        owner: &str,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        content: &DecodedThreeDTilesContent,
    ) -> Result<WasmPreparedGpuModels, String> {
        fn visit(
            device: &wgpu::Device,
            queue: &wgpu::Queue,
            content: &DecodedThreeDTilesContent,
            resident: &BTreeMap<GpuModelResourceIdentity, WasmResidentGpuModel>,
            prepared: &mut BTreeMap<GpuModelResourceIdentity, Vec<GpuIndexedMeshGeometry>>,
        ) -> Result<(), String> {
            match content {
                DecodedThreeDTilesContent::InstancedMesh(model) => {
                    let identity = gpu_indexed_geometry_identity(&model.glb);
                    if prepared.contains_key(&identity) {
                        return Ok(());
                    }
                    let geometries = if let Some(cached) = resident.get(&identity) {
                        cached.geometries.clone()
                    } else {
                        build_instanced_glb_geometries_with_queue(
                            device,
                            queue,
                            "himmelcad-shared-i3dm",
                            &model.glb,
                        )
                        .map_err(|error| error.to_string())?
                    };
                    prepared.insert(identity, geometries);
                }
                DecodedThreeDTilesContent::Composite(children) => {
                    for child in children {
                        visit(device, queue, child, resident, prepared)?;
                    }
                }
                DecodedThreeDTilesContent::Mesh(_) | DecodedThreeDTilesContent::Points(_) => {}
            }
            Ok(())
        }

        let mut models = BTreeMap::new();
        visit(device, queue, content, &self.models, &mut models)?;
        self.release_staged(owner);
        let identities = models
            .keys()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        for (identity, geometries) in &models {
            let entry = self.models.entry(*identity).or_insert_with(|| {
                let resident_bytes = geometries
                    .iter()
                    .map(GpuIndexedMeshGeometry::resident_bytes)
                    .sum();
                WasmResidentGpuModel {
                    geometries: geometries.clone(),
                    staged_refs: 0,
                    resident_refs: 0,
                    resident_bytes,
                }
            });
            entry.staged_refs = entry.staged_refs.saturating_add(1);
        }
        if !identities.is_empty() {
            self.staged_owners.insert(owner.to_owned(), identities);
        }
        Ok(WasmPreparedGpuModels { models })
    }

    fn commit_staged(&mut self, owner: &str) {
        let staged = self.staged_owners.remove(owner).unwrap_or_default();
        let previous = self.owners.remove(owner).unwrap_or_default();
        for identity in previous.difference(&staged).copied() {
            self.release_resident_identity(identity);
        }
        for identity in &staged {
            let entry = self
                .models
                .get_mut(identity)
                .expect("staged GPU model exists");
            entry.staged_refs = entry.staged_refs.saturating_sub(1);
            if !previous.contains(identity) {
                if entry.resident_refs == 0 {
                    self.resident_bytes = self.resident_bytes.saturating_add(entry.resident_bytes);
                }
                entry.resident_refs = entry.resident_refs.saturating_add(1);
            }
        }
        if !staged.is_empty() {
            self.owners.insert(owner.to_owned(), staged);
        }
        self.prune_unused();
    }

    fn release_staged(&mut self, owner: &str) -> bool {
        let Some(identities) = self.staged_owners.remove(owner) else {
            return false;
        };
        for identity in identities {
            if let Some(entry) = self.models.get_mut(&identity) {
                entry.staged_refs = entry.staged_refs.saturating_sub(1);
            }
        }
        self.prune_unused();
        true
    }

    fn evict(&mut self, owner: &str) -> bool {
        let Some(identities) = self.owners.remove(owner) else {
            return false;
        };
        for identity in identities {
            self.release_resident_identity(identity);
        }
        self.prune_unused();
        true
    }

    fn release_resident_identity(&mut self, identity: GpuModelResourceIdentity) {
        if let Some(entry) = self.models.get_mut(&identity) {
            entry.resident_refs = entry.resident_refs.saturating_sub(1);
            if entry.resident_refs == 0 {
                self.resident_bytes = self.resident_bytes.saturating_sub(entry.resident_bytes);
            }
        }
    }

    fn prune_unused(&mut self) {
        self.models
            .retain(|_, entry| entry.staged_refs != 0 || entry.resident_refs != 0);
    }
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmGltfFeaturePrimitive {
    source_start: u64,
    triangle_count: u64,
    features: Vec<DecodedMeshFeatureSet>,
    property_attributes: Vec<DecodedPrimitivePropertyAttribute>,
    property_textures: Vec<DecodedPrimitivePropertyTexture>,
    legacy_batch_ids: Option<DecodedLegacyBatchIds>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmGltfFeatureCatalog {
    structural_metadata: Option<DecodedStructuralMetadata>,
    feature_images: BTreeMap<usize, DecodedFeatureImage>,
    primitives: Vec<WasmGltfFeaturePrimitive>,
    legacy: Option<WasmLegacyFeatureCatalog>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
enum WasmLegacyFeatureCatalog {
    B3dm {
        batch_table: Arc<DecodedLegacyBatchTableCatalog>,
    },
    I3dm {
        model_triangle_count: u64,
        instances: Vec<WasmI3dmFeatureBinding>,
        batch_table: Arc<DecodedLegacyBatchTableCatalog>,
    },
    Pnts {
        point_count: u32,
        batch_ids: Option<Vec<u32>>,
        batch_table: Arc<DecodedLegacyBatchTableCatalog>,
    },
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Copy)]
struct WasmI3dmFeatureBinding {
    source_index: u32,
    feature_id: u32,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmStagedPotree {
    request: WasmPotreeRequest,
    decoded: himmelcad_render::DecodedPotreePoints,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmGaussianSplatMetadata {
    stream_id: String,
    slot: GeometryRepresentationSlotKey,
    binding: GeometryRepresentationBindingRef,
    #[serde(skip)]
    entity_id: String,
    #[serde(skip)]
    proxy_id: String,
    dataset_id: String,
    tile_id: String,
    bounds: BoundingVolume,
    maximum_splats: usize,
    #[serde(skip)]
    style: RenderStyle,
    #[serde(skip)]
    exaggeration_datum: f64,
    #[serde(skip)]
    source_to_project: WorldTransform,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmGaussianSplatRequest {
    metadata: WasmGaussianSplatMetadata,
    bytes: Vec<u8>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmStagedGaussianSplats {
    request: WasmGaussianSplatRequest,
    decoded: himmelcad_render::DecodedGaussianSplats,
    pick_index: GaussianSplatPickRefiner,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WasmRasterMetadata {
    stream_id: String,
    slot: GeometryRepresentationSlotKey,
    binding: GeometryRepresentationBindingRef,
    #[serde(skip)]
    entity_id: String,
    #[serde(skip)]
    proxy_id: String,
    dataset_id: String,
    tile_id: String,
    bounds: BoundingVolume,
    contract: PreparedRasterTileContract,
    elevation_payload_byte_length: usize,
    validity_payload_byte_length: usize,
    confidence_payload_byte_length: usize,
    triangle_mask_payload_byte_length: usize,
    #[serde(skip)]
    style: RenderStyle,
    #[serde(skip)]
    exaggeration_datum: f64,
    #[serde(skip)]
    source_to_project: WorldTransform,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmRasterRequest {
    metadata: WasmRasterMetadata,
    color: Vec<u8>,
    elevations: Vec<u8>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmStagedRaster {
    request: WasmRasterRequest,
    decoded: himmelcad_render::DecodedElevationRaster,
    pick_index: ElevationRasterPickRefiner,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmGlyphAtlasMetadata {
    width: u32,
    height: u32,
    line_height: f32,
    glyphs: BTreeMap<char, GlyphMetrics>,
    fallback: Option<char>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmGlyphAtlasResource {
    atlas: GlyphAtlas,
    texture: GpuTextureResource,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmImageResource {
    width: u32,
    height: u32,
    texture: GpuTextureResource,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmDepthResource {
    width: u32,
    height: u32,
    values: Vec<f32>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmBinaryResource {
    bytes: Vec<u8>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmAnnotationStyle {
    glyph_atlas_hash: String,
    #[serde(default = "default_annotation_text_height")]
    text_height: f64,
    #[serde(default)]
    screen_space: bool,
    #[serde(default = "default_annotation_decimals")]
    decimals: u8,
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    suffix: String,
    #[serde(default = "default_line_width")]
    line_width: f32,
}

#[cfg(target_arch = "wasm32")]
#[cfg(target_arch = "wasm32")]
#[derive(Debug)]
struct WasmMovePreview {
    entity_id: String,
    source_bindings: Vec<GeometryRepresentationBindingRef>,
    source_revision: u64,
    source_version_hash: ObjectHash,
    opacity_multiplier: f32,
    style: RenderStyle,
    exaggeration_datum: f64,
    translation: WorldVec3,
    target_render_tiles: BTreeSet<TileKey>,
    batches: Vec<WasmMovePreviewBatch>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmEntityPlacementHistory {
    root_command_id: String,
    entity_id: String,
    before: Option<Transform3d>,
    after: Option<Transform3d>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug)]
struct WasmMovePreviewBatch {
    source_id: RenderProxyId,
    kind: RenderProxyKind,
    tile_key: Option<TileKey>,
    batch: GpuDrawBatch,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct WasmRetainedStreamTranslation {
    stream_id: String,
    storage_key: String,
    translation: WorldVec3,
    source_to_project: WorldTransform,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmSectionRequest {
    section_id: String,
    #[serde(default)]
    entity_ids: Vec<String>,
    #[serde(default)]
    entity_id: Option<String>,
    #[serde(default)]
    product_hash: Option<String>,
    plane: SectionPlane,
    tolerance: f64,
    #[serde(default)]
    style: RenderStyle,
    #[serde(default)]
    hatch: Option<SectionHatchStyle>,
    #[serde(default)]
    material_hatches: BTreeMap<String, SectionHatchStyle>,
    /// Optional derived-product role for one exact clipping-volume cap.
    ///
    /// The authoritative section product remains keyed by canonical entity
    /// version/topology.  This binding only applies the other convex-volume
    /// planes and view-local hatch policy while compiling the immutable result.
    #[serde(default)]
    clip_cap: Option<WasmSectionClipCap>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmSectionClipCap {
    volume_id: String,
    plane_index: usize,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmLineTypePattern {
    segments: Vec<f64>,
    #[serde(default)]
    phase: f64,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Default)]
struct WasmLineTypeResourceRegistry {
    catalog: CanonicalPresentationResourceCatalog,
    gpu: BTreeMap<String, GpuLineTypeResource>,
    legacy: BTreeMap<String, CanonicalResourceRef>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Default)]
struct WasmHatchResourceRegistry {
    catalog: CanonicalPresentationResourceCatalog,
    gpu: BTreeMap<String, GpuHatchResource>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Default)]
struct WasmMaterialResourceRegistry {
    catalog: CanonicalPresentationResourceCatalog,
    gpu_textures: BTreeMap<String, GpuTextureResource>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmStreamingFrameOptions {
    resource_budget: ResourceBudget,
    frame_budget: himmelcad_render::FrameBudget,
    #[serde(default = "default_maximum_sse")]
    maximum_screen_space_error: f64,
    #[serde(default = "default_detail_scale")]
    detail_scale: f64,
    #[serde(default = "default_traversed_nodes")]
    maximum_traversed_nodes: usize,
    #[serde(default)]
    include_render_keys: bool,
}

#[cfg(target_arch = "wasm32")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WasmStreamingFramePlanResponse<'a> {
    render: &'a [TileKey],
    render_count: usize,
    actions: &'a [himmelcad_render::StreamingAction],
    admission: &'a himmelcad_render::AdmissionPlan,
    eviction: &'a himmelcad_render::EvictionPlan,
    claimed_decode_ms: f32,
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WasmHardwarePolicyRequest {
    inventory: HardwareInventory,
    #[serde(default)]
    calibration: Option<DeviceCalibration>,
    #[serde(default)]
    deployment_profile: HardwareDeploymentProfile,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
struct WasmFrameTelemetryObservation {
    cpu_ms: f32,
    interacting: bool,
    uploaded_bytes: u64,
}

#[cfg(target_arch = "wasm32")]
async fn create_wasm_viewer(
    canvas: HtmlCanvasElement,
    width: u32,
    height: u32,
    policy: BackendPolicy,
) -> Result<WasmViewer, JsValue> {
    std::panic::set_hook(Box::new(|panic| {
        web_sys::console::error_1(&JsValue::from_str(&panic.to_string()));
    }));
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = himmelcad_render::enabled_backends(policy);
    if policy == BackendPolicy::GlDownlevel {
        descriptor.backend_options.gl.fence_behavior = wgpu::GlFenceBehavior::AutoFinish;
    }
    let instance = if policy == BackendPolicy::Automatic {
        wgpu::util::new_instance_with_webgpu_detection(descriptor).await
    } else {
        wgpu::Instance::new(descriptor)
    };
    let surface = instance
        .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
        .map_err(js_error)?;
    let host = GpuSurfaceHost::request(
        &instance,
        surface,
        width,
        height,
        wgpu::PowerPreference::HighPerformance,
    )
    .await
    .map_err(js_error)?;
    Ok(WasmViewer {
        _instance: instance,
        canvas,
        host,
        view_projection: identity(),
        floating_origin: WorldVec3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        },
        clear_color: wgpu::Color {
            r: 0.015,
            g: 0.018,
            b: 0.025,
            a: 1.0,
        },
        render_world: RenderWorld::new(),
        batches: BTreeMap::new(),
        representation_registry: GeometryRepresentationRegistry::new(),
        canonical_admissions: BTreeMap::new(),
        slot_requests: BTreeMap::new(),
        slot_bindings: BTreeMap::new(),
        slot_dataset_ids: BTreeMap::new(),
        dataset_slot_keys: BTreeMap::new(),
        entity_slot_keys: BTreeMap::new(),
        primary_slot_keys: BTreeMap::new(),
        entity_requests: BTreeMap::new(),
        streamed_requests: BTreeMap::new(),
        external_asset_cache: SharedAssetBlobCache::new(),
        gpu_model_cache: WasmGpuModelCache::default(),
        gpu_texture_cache: GpuTextureResourceCache::default(),
        gpu_texture_source_identities: BTreeMap::new(),
        gpu_texture_decode_count: 0,
        gpu_texture_factory_count: 0,
        worker_artifact_ingest_count: 0,
        main_thread_stream_decode_count: 0,
        mesh_pick_indices: BTreeMap::new(),
        stream_proxy_transforms: BTreeMap::new(),
        gltf_feature_catalogs: BTreeMap::new(),
        potree_requests: BTreeMap::new(),
        potree_proxy_streams: BTreeMap::new(),
        staged_three_d_tiles: BTreeMap::new(),
        staged_potree: BTreeMap::new(),
        splat_requests: BTreeMap::new(),
        splat_proxy_streams: BTreeMap::new(),
        splat_pick_indices: BTreeMap::new(),
        staged_splats: BTreeMap::new(),
        raster_requests: BTreeMap::new(),
        raster_proxy_streams: BTreeMap::new(),
        raster_pick_indices: BTreeMap::new(),
        staged_rasters: BTreeMap::new(),
        section_requests: BTreeMap::new(),
        section_proxy_ids: BTreeMap::new(),
        entity_dependents: BTreeMap::new(),
        entity_sections: BTreeMap::new(),
        entity_streams: BTreeMap::new(),
        stream_entities: BTreeMap::new(),
        slot_streams: BTreeMap::new(),
        stream_slots: BTreeMap::new(),
        dataset_streams: BTreeMap::new(),
        stream_datasets: BTreeMap::new(),
        clip_volumes: Vec::new(),
        camera_frame: None,
        streaming: StreamingCoordinator::default(),
        explicit_tilesets: BTreeMap::new(),
        implicit_tilesets: BTreeMap::new(),
        potree_datasets: BTreeMap::new(),
        prepared_datasets: BTreeMap::new(),
        registered_dataset_contracts: BTreeMap::new(),
        entity_styles: BTreeMap::new(),
        entity_interactions: BTreeMap::new(),
        glyph_atlases: BTreeMap::new(),
        annotation_styles: BTreeMap::new(),
        block_definitions: BTreeMap::new(),
        block_member_styles: BTreeMap::new(),
        block_attribute_tables: BTreeSet::new(),
        block_member_entity_versions: BTreeMap::new(),
        image_resources: BTreeMap::new(),
        depth_resources: BTreeMap::new(),
        raster_binary_resources: BTreeMap::new(),
        raster_analysis_view: None,
        mesh_resources: BTreeMap::new(),
        material_resources: WasmMaterialResourceRegistry::default(),
        hatch_resources: WasmHatchResourceRegistry::default(),
        line_type_resources: WasmLineTypeResourceRegistry::default(),
        section_products: BTreeMap::new(),
        section_evaluations: BTreeMap::new(),
        move_previews: BTreeMap::new(),
        entity_move_previews: BTreeMap::new(),
        entity_command_journal: EntityCommandJournal::default(),
        entity_undo_stack: Vec::new(),
        entity_redo_stack: Vec::new(),
        clip_preview_batches: Vec::new(),
        clip_preview_material_slots: Vec::new(),
        clip_preview_cost: ResourceCost::default(),
        frame_origin_queue_write_count: 0,
        last_frame_origin_queue_writes: 0,
        last_transaction_diagnostics: WasmTransactionDiagnostics::default(),
        calibration_session: None,
        runtime_quality: None,
        frame_telemetry: FrameTelemetryWindow::new(240),
        alignment_preview_sessions: AlignmentPreviewSessionStore::default(),
    })
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl WasmViewer {
    /// Selects WebGPU with the production WebGL2 fallback and binds a canvas.
    pub async fn create(
        canvas: HtmlCanvasElement,
        width: u32,
        height: u32,
    ) -> Result<WasmViewer, JsValue> {
        create_wasm_viewer(canvas, width, height, BackendPolicy::Automatic).await
    }

    /// Binds a canvas with an explicit backend policy for deterministic hosts
    /// and permanent WebGL2 downlevel deployments.
    pub async fn create_with_backend(
        canvas: HtmlCanvasElement,
        width: u32,
        height: u32,
        backend: &str,
    ) -> Result<WasmViewer, JsValue> {
        let policy = match backend {
            "automatic" => BackendPolicy::Automatic,
            "webgpu" => BackendPolicy::WebGpuOnly,
            "webgl2" => BackendPolicy::GlDownlevel,
            _ => {
                return Err(JsValue::from_str(
                    "backend must be automatic, webgpu or webgl2",
                ));
            }
        };
        create_wasm_viewer(canvas, width, height, policy).await
    }

    /// Resizes physical presentation targets; zero dimensions suspend rendering.
    pub fn resize(&mut self, width: u32, height: u32) {
        self.host.resize(width, height);
    }

    /// Recreates only a lost canvas surface while preserving device residency.
    pub fn recover_surface(&mut self) -> Result<(), JsValue> {
        let surface = self
            ._instance
            .create_surface(wgpu::SurfaceTarget::Canvas(self.canvas.clone()))
            .map_err(js_error)?;
        self.host.replace_surface(surface).map_err(js_error)
    }

    /// Test hook for browser lifecycle gates; production recovery is driven by
    /// wgpu device-lost and out-of-memory callbacks.
    pub fn request_device_recovery_for_test(&self, reason: &str) -> Result<(), JsValue> {
        let reason = match reason {
            "deviceLost" => GpuRecoveryReason::DeviceLost,
            "outOfMemory" => GpuRecoveryReason::OutOfMemory,
            _ => {
                return Err(JsValue::from_str(
                    "test recovery reason must be deviceLost or outOfMemory",
                ));
            }
        };
        self.host.require_device_recovery(reason);
        Ok(())
    }

    /// Builds an immutable, partitioned Civil-alignment preview session.
    pub fn build_alignment_preview_json(
        &mut self,
        preview_id: &str,
        request_json: &str,
    ) -> Result<String, JsValue> {
        let mut candidate = self.alignment_preview_sessions.clone();
        let response = candidate
            .build_json(preview_id, request_json)
            .map_err(|error| JsValue::from_str(&error))?;
        let changed = candidate
            .changed_partitions(preview_id)
            .map_err(|error| JsValue::from_str(&error))?;
        self.replace_alignment_preview_partitions(preview_id, &changed, false)
            .map_err(|error| JsValue::from_str(&error))?;
        self.alignment_preview_sessions = candidate;
        Ok(response)
    }

    /// Atomically replaces only changed partitions of an active alignment preview.
    pub fn update_alignment_preview_json(
        &mut self,
        preview_id: &str,
        request_json: &str,
    ) -> Result<String, JsValue> {
        let mut candidate = self.alignment_preview_sessions.clone();
        let response = candidate
            .update_json(preview_id, request_json)
            .map_err(|error| JsValue::from_str(&error))?;
        let changed = candidate
            .changed_partitions(preview_id)
            .map_err(|error| JsValue::from_str(&error))?;
        self.replace_alignment_preview_partitions(preview_id, &changed, true)
            .map_err(|error| JsValue::from_str(&error))?;
        self.alignment_preview_sessions = candidate;
        Ok(response)
    }

    /// Retires an alignment preview and all of its session state.
    pub fn remove_alignment_preview(&mut self, preview_id: &str) -> Result<bool, JsValue> {
        let proxy_ids = match self.alignment_preview_sessions.all_proxy_ids(preview_id) {
            Ok(ids) => ids,
            Err(_) => return Ok(false),
        };
        let mut candidate = self.alignment_preview_sessions.clone();
        let removed = candidate
            .retire(preview_id)
            .map_err(|error| JsValue::from_str(&error))?;
        self.remove_alignment_preview_batches(&proxy_ids)
            .map_err(|error| JsValue::from_str(&error))?;
        self.alignment_preview_sessions = candidate;
        Ok(removed)
    }

    /// Replaces the column-major camera-relative world-to-clip matrix.
    pub fn set_view_projection(&mut self, values: &[f32]) -> Result<(), JsValue> {
        if values.len() != 16 || values.iter().any(|value| !value.is_finite()) {
            return Err(JsValue::from_str(
                "viewProjection must contain exactly 16 finite values",
            ));
        }
        self.view_projection = [
            values[0..4].try_into().expect("validated matrix row"),
            values[4..8].try_into().expect("validated matrix row"),
            values[8..12].try_into().expect("validated matrix row"),
            values[12..16].try_into().expect("validated matrix row"),
        ];
        // An externally supplied f32 matrix is sufficient for presentation but
        // cannot reconstruct authoritative project coordinates after readback.
        self.camera_frame = None;
        Ok(())
    }

    /// Replaces the authoritative f64 world camera and derives the exact inverse
    /// used for cursor rays and depth reconstruction inside the kernel.
    pub fn set_world_camera_json(&mut self, camera_json: &str) -> Result<(), JsValue> {
        let camera: WorldCamera = serde_json::from_str(camera_json).map_err(js_error)?;
        let frame = CameraFrame::new(camera, self.floating_origin).map_err(js_error)?;
        self.view_projection = frame.gpu_view_projection();
        self.camera_frame = Some(frame);
        Ok(())
    }

    /// Samples the kernel's f64 perspective/orthographic matrix morph used by
    /// the seamless 3D-to-locked-top-down transition.
    pub fn set_camera_transition_json(
        &mut self,
        transition_json: &str,
        progress: f64,
    ) -> Result<(), JsValue> {
        let transition: himmelcad_render::CameraTransition =
            serde_json::from_str(transition_json).map_err(js_error)?;
        let frame = transition
            .sample(progress, self.floating_origin)
            .map_err(js_error)?;
        self.view_projection = frame.gpu_view_projection();
        self.camera_frame = Some(frame);
        Ok(())
    }

    /// Sets the exact f64 project coordinate represented by render-local zero.
    pub fn set_floating_origin(&mut self, x: f64, y: f64, z: f64) -> Result<(), JsValue> {
        if !x.is_finite() || !y.is_finite() || !z.is_finite() {
            return Err(JsValue::from_str("floating origin must be finite"));
        }
        let next = WorldVec3 { x, y, z };
        let next_camera_frame = self
            .camera_frame
            .map(|frame| CameraFrame::new(frame.camera, next))
            .transpose()
            .map_err(js_error)?;
        self.floating_origin = next;
        if let Some(frame) = next_camera_frame {
            self.view_projection = frame.gpu_view_projection();
            self.camera_frame = Some(frame);
        }
        Ok(())
    }

    /// Computes the authoritative canonical-entity envelope hash in Rust.
    pub fn canonical_entity_version_hash_json(&self, entity_json: &str) -> Result<String, JsValue> {
        let entity: CanonicalEntity = serde_json::from_str(entity_json).map_err(js_error)?;
        himmelcad_core::entity_validation::canonical_entity_version_hash(&entity)
            .map(|hash| hash.0)
            .map_err(js_error)
    }

    /// Computes the authoritative canonical geometry content hash in Rust.
    pub fn geometry_object_content_hash_json(
        &self,
        geometry_json: &str,
    ) -> Result<String, JsValue> {
        let geometry: GeometryObject = serde_json::from_str(geometry_json).map_err(js_error)?;
        geometry_object_content_hash(&geometry)
            .map(|hash| hash.0)
            .map_err(js_error)
    }

    /// Computes the immutable reusable-block manifest hash in Rust.
    pub fn block_definition_content_hash_json(
        &self,
        definition_json: &str,
    ) -> Result<String, JsValue> {
        let definition: BlockDefinition =
            serde_json::from_str(definition_json).map_err(js_error)?;
        definition
            .computed_content_hash()
            .map(|hash| hash.0)
            .map_err(js_error)
    }

    /// Computes the canonical hash of a line-type resource excluding its
    /// embedded `contentHash`, so hosts can seal authored revisions in Rust.
    pub fn line_type_resource_content_hash_json(
        &self,
        resource_json: &str,
    ) -> Result<String, JsValue> {
        let resource: LineTypeResource = serde_json::from_str(resource_json).map_err(js_error)?;
        resource
            .computed_content_hash()
            .map(|hash| hash.0)
            .map_err(js_error)
    }

    /// Computes the canonical hash of a hatch-pattern resource excluding its
    /// embedded `contentHash`, so hosts can seal authored revisions in Rust.
    pub fn hatch_pattern_resource_content_hash_json(
        &self,
        resource_json: &str,
    ) -> Result<String, JsValue> {
        let resource: HatchPatternResource =
            serde_json::from_str(resource_json).map_err(js_error)?;
        resource
            .computed_content_hash()
            .map(|hash| hash.0)
            .map_err(js_error)
    }

    /// Computes one canonical texture-resource hash excluding `contentHash`.
    pub fn texture_resource_content_hash_json(
        &self,
        resource_json: &str,
    ) -> Result<String, JsValue> {
        let resource: TextureResource = serde_json::from_str(resource_json).map_err(js_error)?;
        resource
            .computed_content_hash()
            .map(|hash| hash.0)
            .map_err(js_error)
    }

    /// Computes one canonical material-resource hash excluding `contentHash`.
    pub fn material_resource_content_hash_json(
        &self,
        resource_json: &str,
    ) -> Result<String, JsValue> {
        let resource: MaterialResource = serde_json::from_str(resource_json).map_err(js_error)?;
        resource
            .computed_content_hash()
            .map(|hash| hash.0)
            .map_err(js_error)
    }

    /// Computes one canonical ordered material-table hash excluding `contentHash`.
    pub fn material_table_resource_content_hash_json(
        &self,
        resource_json: &str,
    ) -> Result<String, JsValue> {
        let resource: MaterialTableResource =
            serde_json::from_str(resource_json).map_err(js_error)?;
        resource
            .computed_content_hash()
            .map(|hash| hash.0)
            .map_err(js_error)
    }

    /// Computes the canonical immutable topology-partition manifest hash in Rust.
    pub fn section_topology_partition_content_hash_json(
        &self,
        manifest_json: &str,
    ) -> Result<String, JsValue> {
        let manifest: SectionTopologyPartitionManifest =
            serde_json::from_str(manifest_json).map_err(js_error)?;
        manifest.content_hash().map(|hash| hash.0).map_err(js_error)
    }

    /// Computes the canonical immutable section-product hash in Rust.
    pub fn section_product_content_hash_json(&self, product_json: &str) -> Result<String, JsValue> {
        let product: AuthoritativeSectionProduct =
            serde_json::from_str(product_json).map_err(js_error)?;
        validate_authoritative_section_product(&product).map_err(js_error)?;
        serde_json::to_vec(&product)
            .map(|bytes| ObjectHash::of_bytes(&bytes).0)
            .map_err(js_error)
    }

    /// Atomically admits complete canonical entity envelopes and publishes all selected slots.
    ///
    /// Entity identity, revision, geometry hashes and compare-and-swap generations are validated
    /// exclusively by the canonical representation registry. Proxy identity is derived internally
    /// from the stable representation slot and is never supplied by the host.
    #[allow(clippy::too_many_lines)]
    pub fn publish_canonical_representations_json(
        &mut self,
        admissions_json: &str,
    ) -> Result<String, JsValue> {
        let admissions: Vec<WasmCanonicalRenderAdmission> =
            serde_json::from_str(admissions_json).map_err(js_error)?;
        if admissions.is_empty() {
            return Err(JsValue::from_str(
                "canonical render admission transaction must be non-empty",
            ));
        }

        let mut prepared_slots = Vec::with_capacity(admissions.len());
        let mut grouped = BTreeMap::<String, Vec<usize>>::new();
        let mut storage_keys = std::collections::BTreeSet::new();
        let mut transaction_datasets = BTreeMap::<String, String>::new();
        for (index, admission) in admissions.iter().enumerate() {
            let entity_id = admission.admission.entity.id.0.clone();
            let slot = GeometryRepresentationSlotKey {
                entity_id: admission.admission.entity.id.clone(),
                representation_slot: admission.admission.representation_slot.clone(),
            };
            let storage_key = canonical_slot_storage_key(&slot).map_err(js_error)?;
            if !storage_keys.insert(storage_key.clone()) {
                return Err(JsValue::from_str(
                    "canonical transaction contains a duplicate representation slot",
                ));
            }
            let is_streamed = stream_provider_geometry(&admission.admission.resolved_geometry);
            if is_streamed != admission.dataset_id.is_some() {
                return Err(JsValue::from_str(
                    "streamed geometry requires exactly one registered dataset binding; inline geometry forbids one",
                ));
            }
            if let Some(dataset_id) = &admission.dataset_id {
                let contract = self
                    .registered_dataset_contracts
                    .get(dataset_id)
                    .ok_or_else(|| JsValue::from_str("canonical dataset is not registered"))?;
                let (format_id, metadata_hash) = geometry_dataset_contract(
                    &admission.admission.resolved_geometry,
                )
                .ok_or_else(|| {
                    JsValue::from_str(
                        "streamed canonical geometry has no dataset format/hash contract",
                    )
                })?;
                if contract.format_id != format_id || contract.metadata_hash != *metadata_hash {
                    return Err(JsValue::from_str(
                        "registered dataset format or metadata hash does not match canonical geometry",
                    ));
                }
                if let Some(other_slot) = self.dataset_slot_keys.get(dataset_id) {
                    let replacing_same_entity = self
                        .slot_bindings
                        .get(other_slot)
                        .is_some_and(|binding| binding.key.slot.entity_id.0 == entity_id);
                    if other_slot != &storage_key && !replacing_same_entity {
                        return Err(JsValue::from_str(
                            "registered dataset is already bound to another canonical slot",
                        ));
                    }
                }
                if transaction_datasets
                    .insert(dataset_id.clone(), storage_key.clone())
                    .is_some()
                {
                    return Err(JsValue::from_str(
                        "canonical transaction binds one dataset to multiple slots",
                    ));
                }
            }
            grouped.entry(entity_id.clone()).or_default().push(index);
            let evaluated_mesh = self.prepare_evaluated_mesh_admission(admission)?;
            let evaluated_mesh_ref = admission
                .evaluated_mesh
                .as_ref()
                .map(|evaluated| evaluated.mesh_resource_ref.clone());
            let mut request =
                canonical_render_request(admission, evaluated_mesh_ref).map_err(js_error)?;
            let base_style = request.style.clone();
            request.style = base_style.with_interaction(
                self.entity_interactions
                    .get(&entity_id)
                    .copied()
                    .unwrap_or_default(),
            );
            validate_fill_resource(&request.style, &self.image_resources, &self.hatch_resources)
                .map_err(js_error)?;
            prepared_slots.push(WasmPreparedCanonicalSlot {
                storage_key,
                request,
                base_style,
                dataset_id: admission.dataset_id.clone(),
                primary: is_primary_representation(&admission.admission),
                admission: ResolvedGeometryRepresentationAdmission {
                    canonical: admission.admission.clone(),
                    evaluated_mesh,
                },
            });
        }

        for indices in grouped.values() {
            let first = &admissions[indices[0]].admission.entity;
            if indices.iter().any(|index| {
                admissions[*index].admission.entity != *first
                    || admissions[*index].admission.entity.representations.len() != indices.len()
            }) {
                return Err(JsValue::from_str(
                    "every entity transaction must carry one identical complete envelope and all of its representations",
                ));
            }
            if first.representations.iter().any(|representation| {
                indices
                    .iter()
                    .filter(|index| admissions[**index].admission.selected == *representation)
                    .count()
                    != 1
            }) {
                return Err(JsValue::from_str(
                    "canonical entity envelope and admitted representation set differ",
                ));
            }
            if indices
                .iter()
                .filter(|index| prepared_slots[**index].primary)
                .count()
                != 1
            {
                return Err(JsValue::from_str(
                    "canonical entity needs exactly one admitted primary representation",
                ));
            }
        }

        let placement_only_entities = grouped
            .iter()
            .filter_map(|(entity_id, indices)| {
                self.canonical_entity_replacement_is_placement_only(
                    entity_id,
                    indices.iter().map(|index| &admissions[*index]),
                )
                .then(|| entity_id.clone())
            })
            .collect::<BTreeSet<_>>();

        let registry_overlay = self
            .representation_registry
            .prepare_atomic(
                prepared_slots
                    .iter()
                    .map(|slot| slot.admission.clone())
                    .collect(),
            )
            .map_err(js_error)?;

        let changed_entity_ids = grouped.keys().cloned().collect::<Vec<_>>();
        let changed_entity_set = changed_entity_ids
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let dependent_entities = transitive_dependent_entities(
            &self.entity_requests,
            &self.entity_dependents,
            &changed_entity_ids,
        )
        .into_iter()
        .filter(|request| !changed_entity_set.contains(&request.entity_id))
        .collect::<Vec<_>>();
        let next_primary_requests = grouped
            .iter()
            .filter_map(|(entity_id, indices)| {
                indices
                    .iter()
                    .find(|index| prepared_slots[**index].primary)
                    .map(|index| (entity_id.clone(), prepared_slots[*index].request.clone()))
            })
            .collect::<BTreeMap<_, _>>();

        let affected_entity_ids = changed_entity_ids
            .iter()
            .cloned()
            .chain(
                dependent_entities
                    .iter()
                    .map(|request| request.entity_id.clone()),
            )
            .collect::<std::collections::BTreeSet<_>>();
        let impacted_section_ids = affected_entity_ids
            .iter()
            .filter_map(|entity_id| self.entity_sections.get(entity_id))
            .flatten()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let invalidated_section_ids = impacted_section_ids
            .iter()
            .filter(|section_id| {
                self.section_requests
                    .get(*section_id)
                    .is_some_and(|section| section.entity_id.is_some())
            })
            .cloned()
            .collect::<BTreeSet<_>>();
        let impacted_sections = impacted_section_ids
            .iter()
            .filter(|section_id| !invalidated_section_ids.contains(*section_id))
            .filter_map(|section_id| {
                self.section_requests
                    .get(section_id)
                    .cloned()
                    .map(|section| (section_id.clone(), section))
            })
            .collect::<Vec<_>>();

        let mut compile_primary_requests =
            next_primary_requests.values().cloned().collect::<Vec<_>>();
        compile_primary_requests.extend(dependent_entities.iter().cloned());
        let compile_entities = build_entity_compile_scope(
            &self.entity_requests,
            &compile_primary_requests,
            &impacted_sections,
            &self.block_definitions,
        );

        let (retained_streams, retained_bounds_updates, retained_stream_entities) = self
            .prepare_retained_stream_translations(&placement_only_entities, &prepared_slots)
            .map_err(js_error)?;

        let mut removed_proxy_ids = std::collections::BTreeSet::new();
        let mut retired_stream_ids = std::collections::BTreeSet::new();
        for entity_id in grouped.keys() {
            if let Some(old_slots) = self.entity_slot_keys.get(entity_id) {
                for storage_key in old_slots {
                    if !self.slot_dataset_ids.contains_key(storage_key) {
                        if let Some(request) = self.slot_requests.get(storage_key) {
                            removed_proxy_ids.extend(
                                entity_proxy_ids(
                                    request,
                                    &compile_entities,
                                    &self.block_definitions,
                                    &self.block_member_styles,
                                    &self.block_member_entity_versions,
                                )
                                .map_err(js_error)?,
                            );
                        }
                    }
                    if !retained_stream_entities.contains(entity_id) {
                        retired_stream_ids.extend(
                            self.slot_streams
                                .get(storage_key)
                                .into_iter()
                                .flatten()
                                .cloned(),
                        );
                    }
                }
            }
        }
        for stream_id in &retired_stream_ids {
            removed_proxy_ids.extend(stream_render_proxy_ids(self, stream_id));
        }
        for dependent in &dependent_entities {
            removed_proxy_ids.extend(
                entity_proxy_ids(
                    dependent,
                    &compile_entities,
                    &self.block_definitions,
                    &self.block_member_styles,
                    &self.block_member_entity_versions,
                )
                .map_err(js_error)?,
            );
        }
        for section_id in &impacted_section_ids {
            removed_proxy_ids.extend(
                self.section_proxy_ids
                    .get(section_id)
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
        }

        let mut render_overlay = self
            .render_world
            .prepare_overlay_with_bounds_updates(
                removed_proxy_ids.iter().cloned(),
                retained_bounds_updates,
            )
            .map_err(js_error)?;
        let staging_world = render_overlay.staging_world_mut();
        let mut next_batches = BTreeMap::new();
        let mut next_mesh_pick_indices = BTreeMap::new();
        for slot in prepared_slots
            .iter()
            .filter(|slot| slot.dataset_id.is_none())
        {
            compile_inline_entity(
                &self.host,
                staging_world,
                &mut next_batches,
                &slot.request,
                self.floating_origin,
                &self.glyph_atlases,
                &self.annotation_styles,
                &compile_entities,
                &self.block_definitions,
                &self.block_member_styles,
                &self.block_attribute_tables,
                &self.block_member_entity_versions,
                &self.image_resources,
                &self.depth_resources,
                &self.raster_binary_resources,
                &self.mesh_resources,
                &self.material_resources,
                &self.hatch_resources,
                &self.line_type_resources,
            )
            .map_err(js_error)?;
            collect_inline_mesh_pick_indices(
                &slot.request,
                &compile_entities,
                &self.block_definitions,
                &self.block_member_styles,
                &self.block_member_entity_versions,
                &self.mesh_resources,
                &mut next_mesh_pick_indices,
            )
            .map_err(js_error)?;
        }
        for dependent in &dependent_entities {
            compile_inline_entity(
                &self.host,
                staging_world,
                &mut next_batches,
                dependent,
                self.floating_origin,
                &self.glyph_atlases,
                &self.annotation_styles,
                &compile_entities,
                &self.block_definitions,
                &self.block_member_styles,
                &self.block_attribute_tables,
                &self.block_member_entity_versions,
                &self.image_resources,
                &self.depth_resources,
                &self.raster_binary_resources,
                &self.mesh_resources,
                &self.material_resources,
                &self.hatch_resources,
                &self.line_type_resources,
            )
            .map_err(js_error)?;
            collect_inline_mesh_pick_indices(
                dependent,
                &compile_entities,
                &self.block_definitions,
                &self.block_member_styles,
                &self.block_member_entity_versions,
                &self.mesh_resources,
                &mut next_mesh_pick_indices,
            )
            .map_err(js_error)?;
        }
        let mut compiled_section_proxy_ids = BTreeMap::new();
        for (section_id, section) in &impacted_sections {
            let ids = compile_section_request(
                &self.host,
                staging_world,
                &mut next_batches,
                &compile_entities,
                &self.dataset_slot_keys,
                &self.slot_bindings,
                section,
                self.floating_origin,
                &self.block_definitions,
                &self.block_member_styles,
                &self.block_member_entity_versions,
                &self.mesh_resources,
                &self.hatch_resources,
                &self.line_type_resources,
                &self.section_products,
                &self.clip_volumes,
            )
            .map_err(js_error)?;
            compiled_section_proxy_ids.insert(section_id.clone(), ids);
        }
        add_mesh_pick_costs(staging_world, &next_mesh_pick_indices).map_err(js_error)?;

        let registrations = self
            .representation_registry
            .commit_atomic(registry_overlay)
            .map_err(js_error)?;
        let binding_refs = registrations
            .iter()
            .map(|registration| {
                let reference = GeometryRepresentationBindingRef {
                    key: registration.binding.key().clone(),
                    generation: registration.generation,
                };
                canonical_slot_storage_key(&reference.key.slot)
                    .map(|storage_key| (storage_key, reference))
            })
            .collect::<Result<BTreeMap<_, _>, _>>()
            .map_err(js_error)?;
        let render_diagnostics = self
            .render_world
            .commit_overlay(render_overlay)
            .map_err(js_error)?;

        for proxy_id in &removed_proxy_ids {
            self.batches.remove(proxy_id);
            self.mesh_pick_indices.remove(&proxy_id.0);
            self.gltf_feature_catalogs.remove(&proxy_id.0);
        }
        self.batches.extend(next_batches);
        self.mesh_pick_indices.extend(next_mesh_pick_indices);
        self.section_proxy_ids.extend(compiled_section_proxy_ids);
        for section_id in &invalidated_section_ids {
            let removed = self.section_requests.remove(section_id);
            replace_entity_section_index(
                &mut self.entity_sections,
                section_id,
                removed.as_ref(),
                None,
            );
            self.section_proxy_ids.remove(section_id);
        }
        for stream_id in &retired_stream_ids {
            purge_stream_state_after_render_commit(self, stream_id);
        }
        self.sync_external_asset_cache_cost();

        for entity_id in grouped.keys() {
            let previous_primary = self.entity_requests.get(entity_id).cloned();
            if let Some(old_slots) = self.entity_slot_keys.remove(entity_id) {
                for storage_key in old_slots {
                    self.slot_requests.remove(&storage_key);
                    self.slot_bindings.remove(&storage_key);
                    self.canonical_admissions.remove(&storage_key);
                    if let Some(dataset_id) = self.slot_dataset_ids.remove(&storage_key) {
                        self.dataset_slot_keys.remove(&dataset_id);
                    }
                }
            }
            let incoming_keys = prepared_slots
                .iter()
                .filter(|slot| slot.request.entity_id == *entity_id)
                .map(|slot| slot.storage_key.clone())
                .collect::<std::collections::BTreeSet<_>>();
            self.entity_slot_keys
                .insert(entity_id.clone(), incoming_keys);
            let next_primary = next_primary_requests
                .get(entity_id)
                .expect("validated entity has one primary")
                .clone();
            replace_entity_dependency_index(
                &mut self.entity_dependents,
                entity_id,
                previous_primary.as_ref().map(|request| &request.geometry),
                Some(&next_primary.geometry),
                &self.block_definitions,
            );
            self.entity_requests
                .insert(entity_id.clone(), next_primary.clone());
            let base_style = prepared_slots
                .iter()
                .find(|slot| slot.primary && slot.request.entity_id == *entity_id)
                .map(|slot| slot.base_style.clone())
                .expect("validated entity has one primary base style");
            self.entity_styles.insert(
                entity_id.clone(),
                (base_style, next_primary.exaggeration_datum),
            );
            self.primary_slot_keys.remove(entity_id);
        }
        for slot in &prepared_slots {
            self.slot_requests
                .insert(slot.storage_key.clone(), slot.request.clone());
            self.slot_bindings.insert(
                slot.storage_key.clone(),
                binding_refs
                    .get(&slot.storage_key)
                    .expect("registry returned every admitted slot")
                    .clone(),
            );
            if slot.primary {
                self.primary_slot_keys
                    .insert(slot.request.entity_id.clone(), slot.storage_key.clone());
            }
            if let Some(dataset_id) = &slot.dataset_id {
                self.slot_dataset_ids
                    .insert(slot.storage_key.clone(), dataset_id.clone());
                self.dataset_slot_keys
                    .insert(dataset_id.clone(), slot.storage_key.clone());
            }
        }
        for (slot, admission) in prepared_slots.iter().zip(&admissions) {
            self.canonical_admissions
                .insert(slot.storage_key.clone(), admission.clone());
        }
        for retained in &retained_streams {
            self.commit_retained_stream_translation(retained)
                .map_err(js_error)?;
        }
        self.last_transaction_diagnostics = WasmTransactionDiagnostics {
            touched_entities: affected_entity_ids.len(),
            touched_sections: impacted_section_ids.len(),
            touched_proxies: render_diagnostics
                .observed_proxies
                .saturating_add(render_diagnostics.staged_proxies),
            foreign_visits: 0,
        };
        self.rebuild_inline_clip_previews().map_err(js_error)?;
        if self
            .raster_analysis_view
            .as_ref()
            .is_some_and(|analysis| affected_entity_ids.contains(&analysis.entity_id))
        {
            self.raster_analysis_view = None;
            self.sync_external_asset_cache_cost();
        }
        for entity_id in affected_entity_ids {
            self.rebuild_or_discard_move_previews_for_entity(&entity_id);
        }
        Ok(serde_json::json!({
            "bindings": binding_refs.values().collect::<Vec<_>>(),
            "entities": self.entity_requests.len(),
            "slots": self.slot_requests.len(),
            "proxies": self.batches.len(),
            "generation": self.render_world.generation(),
            "invalidatedSectionIds": invalidated_section_ids,
        })
        .to_string())
    }

    /// Inspects immediate external glTF dependencies without performing host I/O.
    pub fn inspect_3d_tiles_dependencies_json(
        &self,
        metadata_json: &str,
        bytes: &[u8],
    ) -> Result<String, JsValue> {
        let metadata: WasmAssetInspectionMetadata =
            serde_json::from_str(metadata_json).map_err(js_error)?;
        if metadata.content_uri.is_empty() {
            return Err(JsValue::from_str("contentUri must be non-empty"));
        }
        let _content_kind = metadata.content_kind;
        let inspection =
            inspect_gltf_dependencies(&metadata.content_uri, bytes, streamed_asset_limits())
                .map_err(js_error)?;
        let dependencies = inspection
            .dependencies()
            .iter()
            .map(|dependency| {
                serde_json::json!({
                    "ownerUri": dependency.owner_uri,
                    "sourceUri": dependency.source_uri,
                    "kind": dependency.kind,
                })
            })
            .collect::<Vec<_>>();
        serde_json::to_string(&dependencies).map_err(js_error)
    }

    /// Kernel-wide shared GPU model residency diagnostics.
    pub fn gpu_model_cache_json(&self) -> String {
        serde_json::json!({
            "allocations": self.gpu_model_cache.models.values()
                .filter(|model| model.resident_refs != 0)
                .count(),
            "owners": self.gpu_model_cache.owners.len(),
            "gpuBufferBytes": self.gpu_model_cache.resident_bytes,
        })
        .to_string()
    }

    /// Global immutable texture-cache residency and owner diagnostics.
    pub fn gpu_texture_cache_json(&self) -> String {
        let stats = self.gpu_texture_cache.stats();
        serde_json::json!({
            "allocations": stats.resident_allocation_count,
            "retainedAllocations": stats.allocation_count,
            "owners": stats.owner_count,
            "stagedOwners": stats.staged_owner_count,
            "gpuTextureBytes": stats.resident_bytes,
            "decodedSources": self.gpu_texture_decode_count,
            "factoryCalls": self.gpu_texture_factory_count,
        })
        .to_string()
    }

    /// Counts provider CPU decode entry points for rebuild-regression diagnostics.
    pub fn stream_decode_diagnostics_json(&self) -> String {
        serde_json::json!({
            "workerArtifactIngests": self.worker_artifact_ingest_count,
            "mainThreadProviderDecodes": self.main_thread_stream_decode_count,
        })
        .to_string()
    }

    /// Read-only resolved presentation diagnostics. Texture allocation keys
    /// remain private; only source/override identity is exposed across WASM.
    pub fn entity_presentation_json(&self, entity_id: &str) -> Result<String, JsValue> {
        if entity_id.is_empty() {
            return Err(JsValue::from_str("entityId must be non-empty"));
        }
        let mut batches = Vec::new();
        for proxy_id in self.render_world.proxy_ids_for_entity(entity_id) {
            let kind = self
                .render_world
                .proxy_kind(&proxy_id)
                .ok_or_else(|| JsValue::from_str("entity proxy kind is unavailable"))?;
            for (batch_index, batch) in self
                .batches
                .get(&proxy_id)
                .into_iter()
                .flatten()
                .enumerate()
            {
                let source_pbr =
                    batch
                        .source_pbr_factors()
                        .map(|(emissive, metallic, roughness)| {
                            serde_json::json!({
                                "emissive": emissive,
                                "metallic": metallic,
                                "roughness": roughness,
                            })
                        });
                batches.push(serde_json::json!({
                    "proxyId": proxy_id.0,
                    "batchIndex": batch_index,
                    "kind": kind,
                    "baseColor": batch.presentation_base_color(),
                    "colorMode": batch.presentation_color_mode(),
                    "fillVisible": batch.presentation_fill_visible(),
                    "hatchEnabled": batch.presentation_hatch_enabled(),
                    "strokeVisible": batch.presentation_stroke_visible(),
                    "strokeWidthOverride": batch.presentation_stroke_width_override(),
                    "lineTypeComponents": batch.presentation_line_type_components(),
                    "declaredTextureCoordinates": batch.has_declared_texture_coordinates(),
                    "sourceMaterialSlot": batch.source_material_slot(),
                    "sourceMaterialColor": batch.source_material_color(),
                    "sourceMaterialDoubleSided": batch.source_material_double_sided(),
                    "sourceMaterialUvRows": batch.source_material_uv_rows(),
                    "sourcePbr": source_pbr,
                    "sourcePbrTextureFlags": batch.source_pbr_texture_flags(),
                    "sourcePbrUvRows": batch.source_pbr_uv_rows(),
                    "usesSourceTexture": batch.source_texture_allocation_key()
                        == batch.active_texture_allocation_key(),
                }));
            }
        }
        serde_json::to_string(&batches).map_err(js_error)
    }

    /// Counts lazy material-uniform writes caused by visible floating-origin rebases.
    pub fn frame_origin_diagnostics_json(&self) -> String {
        serde_json::json!({
            "queueWrites": self.frame_origin_queue_write_count,
            "lastFrameQueueWrites": self.last_frame_origin_queue_writes,
        })
        .to_string()
    }

    /// Bounded-work counters from the last canonical mutation transaction.
    pub fn transaction_diagnostics_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.last_transaction_diagnostics).map_err(js_error)
    }

    /// Returns the authoritative immutable Potree record layout for a worker job.
    pub fn potree_decode_parameters_json(&self, dataset_id: &str) -> Result<String, JsValue> {
        let layout = self
            .potree_datasets
            .get(dataset_id)
            .ok_or_else(|| JsValue::from_str("Potree dataset is not registered"))?
            .point_layout();
        serde_json::to_string(layout).map_err(js_error)
    }

    /// Ingests one CPU-only artifact produced by `decode_streaming_payload`.
    /// GPU allocation is intentionally deferred to the ordinary publish stage.
    #[allow(clippy::too_many_arguments, clippy::too_many_lines)]
    pub fn stage_decoded_streaming_payload(
        &mut self,
        kind: &str,
        metadata_json: &str,
        artifact: &[u8],
        primary: &[u8],
        bundle_manifest_json: &str,
        bundle: &[u8],
        secondary: &[u8],
        decode_parameters_json: &str,
        expected_input_hash: &str,
    ) -> Result<String, JsValue> {
        let expected_input_hash = parse_sha256_hex(expected_input_hash)?;
        let decoded = decode_artifact(artifact, expected_input_hash).map_err(js_error)?;
        self.worker_artifact_ingest_count = self.worker_artifact_ingest_count.saturating_add(1);
        match (kind, decoded) {
            ("gltf" | "threeDTilesContainer", DecodedStreamingPayload::ThreeDTiles(decoded)) => {
                let mut metadata: WasmThreeDTilesMetadata =
                    serde_json::from_str(metadata_json).map_err(js_error)?;
                let resources = prepare_resolved_asset_bundle(
                    &self.external_asset_cache,
                    bundle_manifest_json,
                    bundle,
                )?;
                resolve_stream_metadata!(self, metadata);
                validate_streamed_metadata(
                    &metadata.stream_id,
                    &metadata.entity_id,
                    &metadata.proxy_id,
                    &metadata.dataset_id,
                    &metadata.tile_id,
                    primary,
                    "3D Tiles",
                )?;
                self.reject_cross_provider_staged_stream_id(
                    &metadata.stream_id,
                    StreamContentKind::ThreeDTiles,
                )?;
                let request = WasmThreeDTilesRequest {
                    leaf_count: required_three_d_tiles_proxy_slots(&decoded),
                    metadata,
                    bytes: primary.to_vec(),
                    resources,
                    gpu_texture_bindings: BTreeMap::new(),
                };
                let cost = three_d_tiles_cost(
                    &request,
                    &decoded,
                    true,
                    self.host.renderer().transparency_strategy()
                        == himmelcad_render::TransparencyStrategy::SortedAlpha,
                );
                self.gpu_model_cache
                    .release_staged(&request.metadata.stream_id);
                self.gpu_texture_cache
                    .release_staged(&request.metadata.stream_id);
                bind_stream_entity(
                    self,
                    &request.metadata.stream_id,
                    &request.metadata.entity_id,
                    &request.metadata.dataset_id,
                    &request.metadata.slot,
                );
                self.staged_three_d_tiles.insert(
                    request.metadata.stream_id.clone(),
                    WasmStagedThreeDTiles { request, decoded },
                );
                serde_json::to_string(&cost).map_err(js_error)
            }
            ("potreePoints", DecodedStreamingPayload::Potree(decoded)) => {
                let mut metadata: WasmPotreeMetadata =
                    serde_json::from_str(metadata_json).map_err(js_error)?;
                resolve_stream_metadata!(self, metadata);
                validate_streamed_metadata(
                    &metadata.stream_id,
                    &metadata.entity_id,
                    &metadata.proxy_id,
                    &metadata.dataset_id,
                    &metadata.tile_id,
                    primary,
                    "Potree",
                )?;
                let layout: PotreePointLayout =
                    serde_json::from_str(decode_parameters_json).map_err(js_error)?;
                let authoritative = self
                    .potree_datasets
                    .get(&metadata.dataset_id)
                    .ok_or_else(|| JsValue::from_str("Potree dataset is not registered"))?
                    .point_layout();
                if authoritative != &layout {
                    return Err(JsValue::from_str("Potree worker layout is stale"));
                }
                validate_decoded_potree_cardinality(
                    metadata.point_count,
                    decoded.positions.len(),
                    decoded.colors.len(),
                    decoded.civil_attributes.as_ref().map(Vec::len),
                )
                .map_err(JsValue::from_str)?;
                self.reject_cross_provider_staged_stream_id(
                    &metadata.stream_id,
                    StreamContentKind::Potree,
                )?;
                let request = WasmPotreeRequest {
                    metadata,
                    layout,
                    bytes: primary.to_vec(),
                    decoded: None,
                };
                let cost = potree_cost(&request, true);
                bind_stream_entity(
                    self,
                    &request.metadata.stream_id,
                    &request.metadata.entity_id,
                    &request.metadata.dataset_id,
                    &request.metadata.slot,
                );
                self.staged_potree.insert(
                    request.metadata.stream_id.clone(),
                    WasmStagedPotree { request, decoded },
                );
                serde_json::to_string(&cost).map_err(js_error)
            }
            ("gaussianSplats", DecodedStreamingPayload::GaussianSplats(decoded)) => {
                let mut metadata: WasmGaussianSplatMetadata =
                    serde_json::from_str(metadata_json).map_err(js_error)?;
                resolve_stream_metadata!(self, metadata);
                validate_streamed_metadata(
                    &metadata.stream_id,
                    &metadata.entity_id,
                    &metadata.proxy_id,
                    &metadata.dataset_id,
                    &metadata.tile_id,
                    primary,
                    "Gaussian splat",
                )?;
                validate_decoded_splat_cardinality(
                    metadata.maximum_splats,
                    decoded.splats.len(),
                    decoded.source_positions.len(),
                )
                .map_err(JsValue::from_str)?;
                self.reject_cross_provider_staged_stream_id(
                    &metadata.stream_id,
                    StreamContentKind::GaussianSplats,
                )?;
                let pick_index =
                    GaussianSplatPickRefiner::from_decoded(&decoded).map_err(js_error)?;
                let request = WasmGaussianSplatRequest {
                    metadata,
                    bytes: primary.to_vec(),
                };
                let cost = splat_cost(
                    &request,
                    decoded.splats.len(),
                    pick_index.resident_bytes(),
                    true,
                    false,
                );
                bind_stream_entity(
                    self,
                    &request.metadata.stream_id,
                    &request.metadata.entity_id,
                    &request.metadata.dataset_id,
                    &request.metadata.slot,
                );
                self.staged_splats.insert(
                    request.metadata.stream_id.clone(),
                    WasmStagedGaussianSplats {
                        request,
                        decoded,
                        pick_index,
                    },
                );
                serde_json::to_string(&cost).map_err(js_error)
            }
            ("raster", DecodedStreamingPayload::Raster(decoded)) => {
                let mut metadata: WasmRasterMetadata =
                    serde_json::from_str(metadata_json).map_err(js_error)?;
                resolve_stream_metadata!(self, metadata);
                let (mapping, topology) = metadata
                    .contract
                    .elevation_grid_decode_semantics()
                    .map_err(js_error)?;
                let (color_width, color_height, elevation_width, elevation_height) =
                    metadata.contract.decode_dimensions().map_err(js_error)?;
                validate_streamed_metadata(
                    &metadata.stream_id,
                    &metadata.entity_id,
                    &metadata.proxy_id,
                    &metadata.dataset_id,
                    &metadata.tile_id,
                    primary,
                    "Raster",
                )?;
                validate_decoded_raster_cardinality(
                    elevation_width,
                    elevation_height,
                    color_width,
                    color_height,
                    decoded.width,
                    decoded.height,
                    decoded.color_width,
                    decoded.color_height,
                    decoded.rgba8.len(),
                    decoded.source_elevations.len(),
                )
                .map_err(JsValue::from_str)?;
                self.reject_cross_provider_staged_stream_id(
                    &metadata.stream_id,
                    StreamContentKind::Raster,
                )?;
                let (elevations, validity, confidence, triangle_mask) =
                    split_streamed_raster_bands(
                        secondary,
                        metadata.elevation_payload_byte_length,
                        metadata.validity_payload_byte_length,
                        metadata.confidence_payload_byte_length,
                        metadata.triangle_mask_payload_byte_length,
                    )
                    .map_err(JsValue::from_str)?;
                metadata
                    .contract
                    .validate_payloads(primary, elevations, validity, confidence, triangle_mask)
                    .map_err(js_error)?;
                let pick_index = ElevationRasterPickRefiner::from_decoded(
                    mapping,
                    topology,
                    triangle_mask,
                    &decoded,
                )
                .map_err(js_error)?;
                let request = WasmRasterRequest {
                    metadata,
                    color: primary.to_vec(),
                    elevations: secondary.to_vec(),
                };
                let cost = raster_cost(&request, &decoded, pick_index.resident_bytes(), true);
                bind_stream_entity(
                    self,
                    &request.metadata.stream_id,
                    &request.metadata.entity_id,
                    &request.metadata.dataset_id,
                    &request.metadata.slot,
                );
                self.staged_rasters.insert(
                    request.metadata.stream_id.clone(),
                    WasmStagedRaster {
                        request,
                        decoded,
                        pick_index,
                    },
                );
                serde_json::to_string(&cost).map_err(js_error)
            }
            _ => Err(JsValue::from_str(
                "decode artifact provider does not match its job kind",
            )),
        }
    }

    /// Evicts one streamed content record and every GPU resource derived from it.
    pub fn remove_3d_tiles_content(&mut self, stream_id: &str) -> Result<bool, JsValue> {
        let Some(request) = self.streamed_requests.get(stream_id) else {
            return Ok(false);
        };
        let preview_entity_id = request.metadata.entity_id.clone();
        let ids = streamed_proxy_ids(request);
        let overlay = self
            .render_world
            .prepare_overlay(ids.iter().cloned())
            .map_err(js_error)?;
        self.render_world
            .commit_overlay(overlay)
            .map_err(js_error)?;
        self.streamed_requests.remove(stream_id);
        unbind_stream_entity_if_absent(self, stream_id);
        self.external_asset_cache.evict(stream_id);
        self.gpu_model_cache.evict(stream_id);
        self.gpu_texture_cache.evict(stream_id);
        self.sync_external_asset_cache_cost();
        for id in ids {
            self.batches.remove(&id);
            self.mesh_pick_indices.remove(&id.0);
            self.gltf_feature_catalogs.remove(&id.0);
            self.stream_proxy_transforms.remove(&id.0);
        }
        self.rebuild_or_discard_move_previews_for_entity(&preview_entity_id);
        Ok(true)
    }

    /// Evicts one Potree node and invalidates its pick address.
    pub fn remove_potree_content(&mut self, stream_id: &str) -> Result<bool, JsValue> {
        let Some(request) = self.potree_requests.get(stream_id) else {
            return Ok(false);
        };
        let preview_entity_id = request.metadata.entity_id.clone();
        let id = RenderProxyId(request.metadata.proxy_id.clone());
        let overlay = self
            .render_world
            .prepare_overlay(std::iter::once(id.clone()))
            .map_err(js_error)?;
        self.render_world
            .commit_overlay(overlay)
            .map_err(js_error)?;
        self.potree_requests.remove(stream_id);
        unbind_stream_entity_if_absent(self, stream_id);
        self.potree_proxy_streams.remove(&id.0);
        self.stream_proxy_transforms.remove(&id.0);
        self.batches.remove(&id);
        self.rebuild_or_discard_move_previews_for_entity(&preview_entity_id);
        Ok(true)
    }

    /// Evicts one Gaussian-splat tile and invalidates its pick address.
    pub fn remove_gaussian_splat_content(&mut self, stream_id: &str) -> Result<bool, JsValue> {
        let Some(request) = self.splat_requests.get(stream_id) else {
            return Ok(false);
        };
        let preview_entity_id = request.metadata.entity_id.clone();
        let id = RenderProxyId(request.metadata.proxy_id.clone());
        let overlay = self
            .render_world
            .prepare_overlay(std::iter::once(id.clone()))
            .map_err(js_error)?;
        self.render_world
            .commit_overlay(overlay)
            .map_err(js_error)?;
        self.splat_requests.remove(stream_id);
        unbind_stream_entity_if_absent(self, stream_id);
        self.splat_proxy_streams.remove(&id.0);
        self.stream_proxy_transforms.remove(&id.0);
        self.splat_pick_indices.remove(stream_id);
        self.batches.remove(&id);
        self.rebuild_or_discard_move_previews_for_entity(&preview_entity_id);
        Ok(true)
    }

    /// Evicts one raster tile and its texture.
    pub fn remove_raster_content(&mut self, stream_id: &str) -> Result<bool, JsValue> {
        let Some(request) = self.raster_requests.get(stream_id) else {
            return Ok(false);
        };
        let preview_entity_id = request.metadata.entity_id.clone();
        if self
            .entity_dependents
            .get(&request.metadata.entity_id)
            .is_some_and(|dependents| !dependents.is_empty())
        {
            return Err(JsValue::from_str(
                "raster tile is pinned by resident associative drape geometry",
            ));
        }
        let id = RenderProxyId(request.metadata.proxy_id.clone());
        let overlay = self
            .render_world
            .prepare_overlay(std::iter::once(id.clone()))
            .map_err(js_error)?;
        self.render_world
            .commit_overlay(overlay)
            .map_err(js_error)?;
        self.raster_requests.remove(stream_id);
        unbind_stream_entity_if_absent(self, stream_id);
        self.raster_proxy_streams.remove(&id.0);
        self.stream_proxy_transforms.remove(&id.0);
        self.raster_pick_indices.remove(stream_id);
        self.batches.remove(&id);
        self.rebuild_or_discard_move_previews_for_entity(&preview_entity_id);
        Ok(true)
    }

    /// Publishes every named staging record as one visibility transaction.
    /// GPU resources are prepared against a private world snapshot; if any
    /// preparation fails, all staging records are restored and the resident
    /// scene remains byte-for-byte addressable through its previous proxies.
    pub fn publish_staged_contents_json(
        &mut self,
        stream_ids_json: &str,
    ) -> Result<String, JsValue> {
        let stream_ids: Vec<String> = serde_json::from_str(stream_ids_json).map_err(js_error)?;
        if stream_ids.is_empty() {
            return Err(JsValue::from_str(
                "staged content transaction must be non-empty",
            ));
        }
        if stream_ids.len() > 4_096 {
            return Err(JsValue::from_str(
                "staged content transaction exceeds 4096 records",
            ));
        }
        let unique = stream_ids.iter().collect::<std::collections::BTreeSet<_>>();
        if unique.len() != stream_ids.len() {
            return Err(JsValue::from_str(
                "staged content transaction contains duplicate streamIds",
            ));
        }

        let mut staged = Vec::with_capacity(stream_ids.len());
        for stream_id in &stream_ids {
            match self.take_staged_content(stream_id) {
                Ok(record) => staged.push(record),
                Err(error) => {
                    self.restore_staged_contents(staged);
                    return Err(error);
                }
            }
        }
        match self.publish_staged_contents(staged) {
            Ok((cost, shared_upload_bytes)) => Ok(streaming_publish_json_with_upload(
                self,
                cost,
                cost.gpu_buffer_bytes
                    .saturating_add(cost.gpu_texture_bytes)
                    .saturating_add(shared_upload_bytes),
                &stream_ids,
            )
            .to_string()),
            Err((error, staged)) => {
                self.restore_staged_contents(staged);
                Err(JsValue::from_str(&error))
            }
        }
    }

    /// Releases decoded-but-not-uploaded data after cancellation or eviction.
    pub fn discard_staged_content(&mut self, stream_id: &str) -> bool {
        let discarded_three_d = self.staged_three_d_tiles.remove(stream_id).is_some();
        if discarded_three_d {
            self.gpu_model_cache.release_staged(stream_id);
            self.gpu_texture_cache.release_staged(stream_id);
        }
        let discarded = discarded_three_d
            | self.staged_potree.remove(stream_id).is_some()
            | self.staged_splats.remove(stream_id).is_some()
            | self.staged_rasters.remove(stream_id).is_some();
        unbind_stream_entity_if_absent(self, stream_id);
        discarded
    }

    /// Registers an explicit or implicit 3D Tiles hierarchy without fetching
    /// any content. Subsequent frame plans emit bounded host fetch actions.
    pub fn register_3d_tiles_dataset(
        &mut self,
        dataset_id: &str,
        format_id: &str,
        tileset_uri: &str,
        tileset_json: &[u8],
    ) -> Result<String, JsValue> {
        self.ensure_new_dataset(dataset_id)?;
        if format_id.is_empty() {
            return Err(JsValue::from_str("formatId must be non-empty"));
        }
        let value: serde_json::Value = serde_json::from_slice(tileset_json).map_err(js_error)?;
        let is_implicit = value
            .pointer("/root/implicitTiling")
            .is_some_and(|value| !value.is_null());
        if is_implicit {
            let source = ImplicitThreeDTilesHierarchySource::from_json(
                DatasetId(dataset_id.to_owned()),
                tileset_uri,
                tileset_json,
            )
            .map_err(js_error)?;
            self.implicit_tilesets.insert(dataset_id.to_owned(), source);
            self.registered_dataset_contracts.insert(
                dataset_id.to_owned(),
                WasmRegisteredDatasetContract {
                    format_id: format_id.to_owned(),
                    metadata_hash: ObjectHash::of_bytes(tileset_json),
                },
            );
            Ok("implicit3dTiles".to_owned())
        } else {
            let source = ThreeDTilesHierarchySource::from_json(
                DatasetId(dataset_id.to_owned()),
                tileset_uri,
                tileset_json,
            )
            .map_err(js_error)?;
            self.explicit_tilesets.insert(dataset_id.to_owned(), source);
            self.registered_dataset_contracts.insert(
                dataset_id.to_owned(),
                WasmRegisteredDatasetContract {
                    format_id: format_id.to_owned(),
                    metadata_hash: ObjectHash::of_bytes(tileset_json),
                },
            );
            Ok("explicit3dTiles".to_owned())
        }
    }

    /// Returns tileset-wide explicit 3D Metadata for inspection and styling.
    /// Implicit/prepared datasets currently return JSON `null` because their
    /// binary property-table metadata is resolved through subtree pages.
    pub fn three_d_tiles_metadata_json(&self, dataset_id: &str) -> Result<String, JsValue> {
        serde_json::to_string(
            &self
                .explicit_tilesets
                .get(dataset_id)
                .map(ThreeDTilesHierarchySource::metadata),
        )
        .map_err(js_error)
    }

    /// Resolves glTF feature IDs and linked structural metadata at one exact
    /// mesh hit. Geometry and metadata share the same resident proxy lifetime.
    pub fn gltf_feature_metadata_json(
        &self,
        render_proxy_id: &str,
        source_primitive_id: u32,
        world_x: f64,
        world_y: f64,
        world_z: f64,
    ) -> Result<String, JsValue> {
        let value = pick_metadata_value(
            &self.mesh_pick_indices,
            &self.gltf_feature_catalogs,
            render_proxy_id,
            u64::from(source_primitive_id),
            WorldVec3 {
                x: world_x,
                y: world_y,
                z: world_z,
            },
        )?;
        let value = value
            .pointer("/providers/gltf/metadata")
            .cloned()
            .ok_or_else(|| JsValue::from_str("glTF source triangle has no feature metadata"))?;
        serde_json::to_string(&value).map_err(js_error)
    }

    /// Resolves every resident feature-metadata provider at one exact pick
    /// address. Mesh providers use the authoritative hit barycentric; pnts
    /// addresses the exact source point directly.
    pub fn pick_metadata_json(
        &self,
        render_proxy_id: &str,
        source_primitive_id: u32,
        world_x: f64,
        world_y: f64,
        world_z: f64,
    ) -> Result<String, JsValue> {
        let source_primitive_id = u64::from(source_primitive_id);
        let value = if let Some(stream_id) = self.potree_proxy_streams.get(render_proxy_id) {
            let request = self
                .potree_requests
                .get(stream_id)
                .ok_or_else(|| JsValue::from_str("Potree pick metadata is not resident"))?;
            potree_pick_metadata_value(request, source_primitive_id)?
        } else {
            pick_metadata_value(
                &self.mesh_pick_indices,
                &self.gltf_feature_catalogs,
                render_proxy_id,
                source_primitive_id,
                WorldVec3 {
                    x: world_x,
                    y: world_y,
                    z: world_z,
                },
            )?
        };
        serde_json::to_string(&value).map_err(js_error)
    }

    /// Registers Potree 2 metadata and its first range-loaded hierarchy page.
    pub fn register_potree_dataset(
        &mut self,
        dataset_id: &str,
        format_id: &str,
        metadata_uri: &str,
        metadata_json: &[u8],
        first_hierarchy_chunk: &[u8],
    ) -> Result<(), JsValue> {
        self.ensure_new_dataset(dataset_id)?;
        if format_id.is_empty() {
            return Err(JsValue::from_str("formatId must be non-empty"));
        }
        let source = PotreeHierarchySource::from_bytes(
            DatasetId(dataset_id.to_owned()),
            metadata_uri,
            metadata_json,
            first_hierarchy_chunk,
        )
        .map_err(js_error)?;
        self.potree_datasets.insert(dataset_id.to_owned(), source);
        self.registered_dataset_contracts.insert(
            dataset_id.to_owned(),
            WasmRegisteredDatasetContract {
                format_id: format_id.to_owned(),
                metadata_hash: ObjectHash::of_bytes(metadata_json),
            },
        );
        Ok(())
    }

    /// Registers a validated provider-neutral prepared hierarchy used by
    /// raster pyramids, tiled splats and future immutable content codecs.
    pub fn register_prepared_dataset(
        &mut self,
        dataset_id: &str,
        format_id: &str,
        manifest_uri: &str,
        manifest_json: &[u8],
    ) -> Result<(), JsValue> {
        self.ensure_new_dataset(dataset_id)?;
        if format_id.is_empty() {
            return Err(JsValue::from_str("formatId must be non-empty"));
        }
        let source = PreparedHierarchySource::from_json(
            DatasetId(dataset_id.to_owned()),
            manifest_uri,
            manifest_json,
        )
        .map_err(js_error)?;
        self.prepared_datasets.insert(dataset_id.to_owned(), source);
        self.registered_dataset_contracts.insert(
            dataset_id.to_owned(),
            WasmRegisteredDatasetContract {
                format_id: format_id.to_owned(),
                metadata_hash: ObjectHash::of_bytes(manifest_json),
            },
        );
        Ok(())
    }

    /// Registers one prepared hierarchy and publishes its canonical binding as
    /// one transaction. A rejected canonical compare-and-swap cannot retain an
    /// unbound dataset registration.
    pub fn register_prepared_dataset_and_publish_canonical_json(
        &mut self,
        dataset_id: &str,
        format_id: &str,
        manifest_uri: &str,
        manifest_json: &[u8],
        admissions_json: &str,
    ) -> Result<String, JsValue> {
        self.ensure_new_dataset(dataset_id)?;
        if format_id.is_empty() {
            return Err(JsValue::from_str("formatId must be non-empty"));
        }
        let source = PreparedHierarchySource::from_json(
            DatasetId(dataset_id.to_owned()),
            manifest_uri,
            manifest_json,
        )
        .map_err(js_error)?;
        let contract = WasmRegisteredDatasetContract {
            format_id: format_id.to_owned(),
            metadata_hash: ObjectHash::of_bytes(manifest_json),
        };
        validate_prepared_dataset_transaction(dataset_id, &contract, admissions_json)?;

        self.prepared_datasets.insert(dataset_id.to_owned(), source);
        self.registered_dataset_contracts
            .insert(dataset_id.to_owned(), contract);
        match self.publish_canonical_representations_json(admissions_json) {
            Ok(mutation) => Ok(mutation),
            Err(error) => {
                self.prepared_datasets.remove(dataset_id);
                self.registered_dataset_contracts.remove(dataset_id);
                Err(error)
            }
        }
    }

    /// Registers one immutable regular-alpha glyph atlas by the same object
    /// hash referenced from canonical text entities. The texture is uploaded
    /// once and shared by independently styled annotation batches.
    pub fn register_glyph_atlas(
        &mut self,
        object_hash: &str,
        metadata_json: &str,
        rgba8: &[u8],
    ) -> Result<(), JsValue> {
        if object_hash.is_empty() {
            return Err(JsValue::from_str("objectHash must be non-empty"));
        }
        if self.glyph_atlases.contains_key(object_hash) {
            return Err(JsValue::from_str(
                "glyph atlas objectHash is already registered",
            ));
        }
        let metadata: WasmGlyphAtlasMetadata =
            serde_json::from_str(metadata_json).map_err(js_error)?;
        let atlas = GlyphAtlas {
            width: metadata.width,
            height: metadata.height,
            rgba8: rgba8.to_vec(),
            line_height: metadata.line_height,
            glyphs: metadata.glyphs,
            fallback: metadata.fallback,
        };
        validate_glyph_atlas(&atlas).map_err(js_error)?;
        let texture = self
            .host
            .renderer()
            .create_texture_resource(
                self.host.device(),
                self.host.queue(),
                &format!("glyph-atlas-{object_hash}"),
                GpuTextureData {
                    width: atlas.width,
                    height: atlas.height,
                    rgba8: &atlas.rgba8,
                },
            )
            .map_err(js_error)?;
        self.glyph_atlases.insert(
            object_hash.to_owned(),
            WasmGlyphAtlasResource { atlas, texture },
        );
        Ok(())
    }

    /// Uploads one immutable decoded RGBA8 image resource. Image decoding is a
    /// provider concern; the kernel receives a deterministic pixel payload.
    pub fn register_image_resource(
        &mut self,
        object_hash: &str,
        width: u32,
        height: u32,
        rgba8: &[u8],
    ) -> Result<(), JsValue> {
        if object_hash.is_empty() || width == 0 || height == 0 {
            return Err(JsValue::from_str(
                "image hash and dimensions must be non-empty",
            ));
        }
        let expected = usize::try_from(width)
            .ok()
            .and_then(|width| {
                usize::try_from(height)
                    .ok()
                    .and_then(|height| width.checked_mul(height))
            })
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| JsValue::from_str("image dimensions overflow"))?;
        if rgba8.len() != expected
            || ObjectHash::of_bytes(rgba8).0 != object_hash
            || self.image_resources.contains_key(object_hash)
        {
            return Err(JsValue::from_str(
                "image length/content hash is invalid or resource is already registered",
            ));
        }
        let texture = self
            .host
            .renderer()
            .create_texture_resource(
                self.host.device(),
                self.host.queue(),
                &format!("image-{object_hash}"),
                GpuTextureData {
                    width,
                    height,
                    rgba8,
                },
            )
            .map_err(js_error)?;
        self.image_resources.insert(
            object_hash.to_owned(),
            WasmImageResource {
                width,
                height,
                texture,
            },
        );
        Ok(())
    }

    /// Registers immutable f32 depth/elevation samples addressed by the depth
    /// field's object hash. NaN marks invalid samples without inventing height.
    pub fn register_depth_resource(
        &mut self,
        object_hash: &str,
        width: u32,
        height: u32,
        values: &[f32],
    ) -> Result<(), JsValue> {
        let expected = usize::try_from(width)
            .ok()
            .and_then(|width| {
                usize::try_from(height)
                    .ok()
                    .and_then(|height| width.checked_mul(height))
            })
            .ok_or_else(|| JsValue::from_str("depth dimensions overflow"))?;
        let canonical_bytes = values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>();
        if object_hash.is_empty()
            || width == 0
            || height == 0
            || values.len() != expected
            || ObjectHash::of_bytes(&canonical_bytes).0 != object_hash
            || self.depth_resources.contains_key(object_hash)
        {
            return Err(JsValue::from_str(
                "depth length/content hash is invalid or resource is already registered",
            ));
        }
        self.depth_resources.insert(
            object_hash.to_owned(),
            WasmDepthResource {
                width,
                height,
                values: values.to_vec(),
            },
        );
        Ok(())
    }

    /// Resolves one exact depth pixel into project source coordinates. This
    /// path never uses presentation exaggeration or the GPU depth buffer.
    pub fn measure_raster_depth_sample_json(
        &self,
        entity_id: &str,
        column: u32,
        row: u32,
    ) -> Result<String, JsValue> {
        serde_json::to_string(&self.measure_raster_depth_sample(entity_id, column, row)?)
            .map_err(js_error)
    }

    /// Resolves at least two image picks and every intervening source-space
    /// distance without treating GPU presentation depth as measurement truth.
    pub fn measure_raster_depth_distance_json(&self, picks_json: &str) -> Result<String, JsValue> {
        let picks: Vec<WasmRasterDepthPick> = serde_json::from_str(picks_json).map_err(js_error)?;
        if picks.len() < 2 {
            return Err(JsValue::from_str(
                "raster distance measurement requires at least two image picks",
            ));
        }
        let measurements = picks
            .iter()
            .map(|pick| self.measure_raster_depth_sample(&pick.entity_id, pick.column, pick.row))
            .collect::<Result<Vec<_>, _>>()?;
        let segment_distances = measurements
            .windows(2)
            .map(|pair| world_distance(pair[0].source_position, pair[1].source_position))
            .collect::<Vec<_>>();
        let total_distance = segment_distances.iter().sum();
        serde_json::to_string(&WasmRasterDepthMeasurementSet {
            picks: measurements,
            segment_distances,
            total_distance,
        })
        .map_err(js_error)
    }

    fn measure_raster_depth_sample(
        &self,
        entity_id: &str,
        column: u32,
        row: u32,
    ) -> Result<WasmRasterDepthMeasurement, JsValue> {
        let request = self
            .entity_requests
            .get(entity_id)
            .ok_or_else(|| JsValue::from_str("raster measurement entity is not loaded"))?;
        let raster = match &request.geometry {
            GeometryObject::RasterImage { raster } => raster.as_ref(),
            GeometryObject::Panorama { panorama } => &panorama.image,
            _ => {
                return Err(JsValue::from_str(
                    "raster measurement requires a raster or panorama entity",
                ))
            }
        };
        if column >= raster.width || row >= raster.height {
            return Err(JsValue::from_str(
                "raster measurement pixel is outside the image",
            ));
        }
        let field = raster
            .depth
            .as_ref()
            .ok_or_else(|| JsValue::from_str("raster measurement has no depth field"))?;
        let depth = self
            .depth_resources
            .get(&field.values.object_hash.0)
            .ok_or_else(|| JsValue::from_str("raster depth resource is not registered"))?;
        if depth.width != raster.width || depth.height != raster.height {
            return Err(JsValue::from_str(
                "raster depth dimensions do not match the canonical image",
            ));
        }
        let sample_index = usize::try_from(
            u64::from(row)
                .saturating_mul(u64::from(raster.width))
                .saturating_add(u64::from(column)),
        )
        .map_err(|_| JsValue::from_str("raster sample index exceeds portable addressing"))?;
        let validity = resolve_raster_validity(
            Some(field),
            raster.width,
            raster.height,
            &self.raster_binary_resources,
        )
        .map_err(|error| JsValue::from_str(&error))?;
        if validity.is_some_and(|mask| !raster_validity_sample(mask, sample_index)) {
            return Err(JsValue::from_str("raster depth sample is invalid"));
        }
        let depth_value = f64::from(
            *depth
                .values
                .get(sample_index)
                .ok_or_else(|| JsValue::from_str("raster depth sample is missing"))?,
        );
        let local =
            project_raster_sample(raster, f64::from(column), f64::from(row), Some(depth_value))
                .map_err(js_error)?;
        let placement =
            DMat4::from_cols_array(&request.placement.unwrap_or(Transform3d::IDENTITY).0);
        if !placement.is_finite() || placement.determinant().abs() <= f64::EPSILON {
            return Err(JsValue::from_str(
                "raster entity placement is non-invertible",
            ));
        }
        let source_position = world_vec3(placement.transform_point3(dvec3(local)));
        let confidence = raster_confidence_sample(
            Some(field),
            raster.width,
            raster.height,
            sample_index,
            &self.raster_binary_resources,
        )
        .map_err(|error| JsValue::from_str(&error))?;
        Ok(WasmRasterDepthMeasurement {
            entity_id: entity_id.to_owned(),
            column,
            row,
            depth: depth_value,
            confidence,
            source_position,
        })
    }

    /// Enters a separate panorama or oriented-image analysis view. Only the
    /// selected canonical entity is submitted while the mode is active; the
    /// normal render world and its visibility state remain unchanged.
    pub fn set_raster_analysis_view_json(&mut self, entity_id: &str) -> Result<String, JsValue> {
        let request = self
            .entity_requests
            .get(entity_id)
            .ok_or_else(|| JsValue::from_str("raster analysis entity is not loaded"))?;
        let (raster, panorama) = match &request.geometry {
            GeometryObject::RasterImage { raster } => (raster.as_ref(), false),
            GeometryObject::Panorama { panorama } => (&panorama.image, true),
            _ => {
                return Err(JsValue::from_str(
                    "raster analysis requires a raster or panorama entity",
                ))
            }
        };
        let camera =
            raster_analysis_view(raster, request.placement, request.plane_extent, panorama)
                .map_err(js_error)?;
        let proxy_id = RenderProxyId(request.proxy_id.clone());
        let pick_slot = self
            .render_world
            .pick_slot_for_proxy(&proxy_id)
            .ok_or_else(|| JsValue::from_str("raster render proxy is not resident"))?;
        let (analysis_batch, analysis_cost) = if panorama {
            compile_panorama_analysis_batch(
                &self.host,
                request,
                raster,
                pick_slot,
                self.floating_origin,
                &self.image_resources,
                &self.hatch_resources,
                &self.line_type_resources,
            )
            .map_err(js_error)?
        } else {
            compile_oriented_image_analysis_batch(
                &self.host,
                request,
                raster,
                pick_slot,
                self.floating_origin,
                &self.image_resources,
                &self.depth_resources,
                &self.raster_binary_resources,
                &self.hatch_resources,
                &self.line_type_resources,
            )
            .map_err(js_error)?
        };
        let descriptor = WasmRasterAnalysisViewDescriptor {
            entity_id: entity_id.to_owned(),
            version_hash: request.version_hash.clone(),
            width: raster.width,
            height: raster.height,
            camera,
        };
        self.raster_analysis_view = Some(WasmRasterAnalysisViewState {
            entity_id: entity_id.to_owned(),
            proxy_id,
            analysis_batch,
            cost: analysis_cost,
        });
        self.sync_external_asset_cache_cost();
        serde_json::to_string(&descriptor).map_err(js_error)
    }

    /// Leaves the separate raster analysis view without changing source or
    /// normal-view visibility state.
    pub fn clear_raster_analysis_view(&mut self) -> bool {
        let cleared = self.raster_analysis_view.take().is_some();
        if cleared {
            self.sync_external_asset_cache_cost();
        }
        cleared
    }

    /// Registers an immutable binary raster side-band. Validity bitsets,
    /// confidence samples and per-cell connectivity masks use this path so
    /// their canonical encodings are never expanded into presentation RGBA.
    pub fn register_raster_binary_resource(
        &mut self,
        object_hash: &str,
        bytes: &[u8],
    ) -> Result<(), JsValue> {
        if object_hash.is_empty()
            || bytes.is_empty()
            || ObjectHash::of_bytes(bytes).0 != object_hash
            || self.raster_binary_resources.contains_key(object_hash)
        {
            return Err(JsValue::from_str(
                "raster binary content hash is invalid or resource is already registered",
            ));
        }
        self.raster_binary_resources.insert(
            object_hash.to_owned(),
            WasmBinaryResource {
                bytes: bytes.to_vec(),
            },
        );
        Ok(())
    }

    /// Registers the immutable evaluated triangle representation of a BRep,
    /// Boolean CSG tree, sweep or extension solid. Evaluation remains outside
    /// the renderer; every host consumes the same content-addressed result.
    pub fn register_mesh_resource(
        &mut self,
        object_hash: &str,
        mesh_json: &str,
    ) -> Result<(), JsValue> {
        if object_hash.is_empty() || self.mesh_resources.contains_key(object_hash) {
            return Err(JsValue::from_str(
                "mesh hash is empty or resource is already registered",
            ));
        }
        let mesh: TriangleMeshGeometry = serde_json::from_str(mesh_json).map_err(js_error)?;
        validate_geometry_object(&GeometryObject::Surface3d {
            mesh: Box::new(mesh.clone()),
        })
        .map_err(js_error)?;
        let canonical_hash = geometry_object_content_hash(&GeometryObject::Surface3d {
            mesh: Box::new(mesh.clone()),
        })
        .map_err(js_error)?;
        if canonical_hash.0 != object_hash {
            return Err(JsValue::from_str(
                "mesh resource ID must equal its canonical geometry content hash",
            ));
        }
        self.mesh_resources.insert(object_hash.to_owned(), mesh);
        self.rebuild_inline_clip_previews().map_err(js_error)?;
        Ok(())
    }

    /// Registers one exact immutable canonical hatch-pattern revision.
    pub fn register_canonical_hatch_pattern_resource(
        &mut self,
        resource_json: &str,
    ) -> Result<(), JsValue> {
        let resource: HatchPatternResource =
            serde_json::from_str(resource_json).map_err(js_error)?;
        self.install_hatch_resource(resource).map_err(js_error)?;
        self.rebuild_inline_clip_previews().map_err(js_error)?;
        Ok(())
    }

    /// Validates and uploads one exact canonical decoded RGBA8 texture revision.
    pub fn register_canonical_texture_resource(
        &mut self,
        resource_json: &str,
        width: u32,
        height: u32,
        rgba8: &[u8],
    ) -> Result<(), JsValue> {
        let resource: TextureResource = serde_json::from_str(resource_json).map_err(js_error)?;
        let expected = usize::try_from(width)
            .ok()
            .and_then(|width| {
                usize::try_from(height)
                    .ok()
                    .and_then(|height| width.checked_mul(height))
            })
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| JsValue::from_str("canonical texture dimensions overflow"))?;
        if width == 0
            || height == 0
            || rgba8.len() != expected
            || resource.pixels.object_hash != ObjectHash::of_bytes(rgba8)
            || resource
                .pixels
                .byte_length
                .is_some_and(|length| length != u64::try_from(rgba8.len()).unwrap_or(u64::MAX))
        {
            return Err(JsValue::from_str(
                "canonical decoded texture dimensions, length or checksum are invalid",
            ));
        }
        let key = canonical_resource_ref_key(&resource.resource_ref()).map_err(js_error)?;
        if self.material_resources.gpu_textures.contains_key(&key) {
            return Err(JsValue::from_str(
                "canonical GPU texture revision is already registered",
            ));
        }
        let color_space = match resource.color_space {
            TextureColorSpace::Srgb => GpuTextureColorSpace::Srgb,
            TextureColorSpace::Linear | TextureColorSpace::Data => GpuTextureColorSpace::Linear,
        };
        let address = |mode| match mode {
            TextureWrapMode::ClampToEdge => GpuTextureAddressMode::ClampToEdge,
            TextureWrapMode::Repeat => GpuTextureAddressMode::Repeat,
            TextureWrapMode::MirroredRepeat => GpuTextureAddressMode::MirrorRepeat,
        };
        let filter = |mode| match mode {
            TextureFilter::Nearest => GpuTextureFilterMode::Nearest,
            TextureFilter::Linear => GpuTextureFilterMode::Linear,
        };
        let sampler = GpuTextureSamplerIdentity {
            address_u: address(resource.wrap_u),
            address_v: address(resource.wrap_v),
            address_w: GpuTextureAddressMode::ClampToEdge,
            mag_filter: filter(resource.mag_filter),
            min_filter: filter(resource.min_filter),
            mipmap_filter: filter(resource.min_filter),
            lod_min_clamp_bits: 0.0_f32.to_bits(),
            lod_max_clamp_bits: 32.0_f32.to_bits(),
            compare: None,
            anisotropy_clamp: 1,
            border_color: None,
        };
        let mut catalog = self.material_resources.catalog.clone();
        catalog
            .publish(CanonicalPresentationResourceSet {
                textures: vec![resource.clone()],
                ..CanonicalPresentationResourceSet::default()
            })
            .map_err(js_error)?;
        let identity = gpu_uploaded_texture_identity(
            GpuTextureMipChainData {
                width,
                height,
                mip_level_count: 1,
                format: match color_space {
                    GpuTextureColorSpace::Linear => wgpu::TextureFormat::Rgba8Unorm,
                    GpuTextureColorSpace::Srgb => wgpu::TextureFormat::Rgba8UnormSrgb,
                },
                data: rgba8,
            },
            color_space,
            sampler,
            1,
        )
        .ok_or_else(|| JsValue::from_str("canonical texture has no stable GPU identity"))?;
        let mut factory_calls = 0_u64;
        let gpu = self
            .gpu_texture_cache
            .resolve_or_create(identity, || {
                factory_calls = 1;
                self.host.renderer().create_canonical_texture_resource(
                    self.host.device(),
                    self.host.queue(),
                    &format!("canonical-texture-{}", resource.resource_id),
                    GpuTextureData {
                        width,
                        height,
                        rgba8,
                    },
                    color_space,
                    sampler,
                )
            })
            .map_err(js_error)?;
        let owner = format!("canonical-texture:{key}");
        let stage =
            GpuTextureResourceStage::prepare([(identity, gpu.clone())]).map_err(js_error)?;
        self.gpu_texture_cache
            .stage_owner(owner.clone(), stage)
            .map_err(js_error)?;
        if !self.gpu_texture_cache.commit_staged(&owner) {
            return Err(JsValue::from_str(
                "canonical GPU texture stage disappeared before publication",
            ));
        }
        self.gpu_texture_factory_count =
            self.gpu_texture_factory_count.saturating_add(factory_calls);
        self.material_resources.catalog = catalog;
        self.material_resources.gpu_textures.insert(key, gpu);
        self.sync_external_asset_cache_cost();
        Ok(())
    }

    /// Atomically publishes exact material and ordered material-table revisions
    /// after every referenced canonical texture revision is GPU-resident.
    pub fn register_canonical_material_resource_set(
        &mut self,
        resources_json: &str,
    ) -> Result<(), JsValue> {
        let resources: CanonicalPresentationResourceSet =
            serde_json::from_str(resources_json).map_err(js_error)?;
        if !resources.textures.is_empty()
            || !resources.hatch_patterns.is_empty()
            || !resources.line_types.is_empty()
            || !resources.annotation_styles.is_empty()
        {
            return Err(JsValue::from_str(
                "material publication must contain only materials and material tables",
            ));
        }
        self.material_resources
            .catalog
            .publish(resources)
            .map_err(js_error)
    }

    /// Registers one exact immutable canonical line-type revision.
    pub fn register_canonical_line_type_resource(
        &mut self,
        resource_json: &str,
    ) -> Result<(), JsValue> {
        let resource: LineTypeResource = serde_json::from_str(resource_json).map_err(js_error)?;
        self.install_line_type_resource(resource, 0.0)
            .map_err(js_error)
    }

    /// Compatibility boundary for the former alternating segment API.
    ///
    /// The result is the exact canonical resource reference selected by later
    /// legacy style normalization; the canonical registry itself never resolves
    /// a mutable latest revision by `resourceId`.
    pub fn register_line_type_resource(
        &mut self,
        resource_id: &str,
        pattern_json: &str,
    ) -> Result<String, JsValue> {
        if resource_id.is_empty() || self.line_type_resources.legacy.contains_key(resource_id) {
            return Err(JsValue::from_str(
                "line type resource id is empty or already registered",
            ));
        }
        let pattern: WasmLineTypePattern = serde_json::from_str(pattern_json).map_err(js_error)?;
        let gpu_pattern =
            GpuLineTypePattern::new(&pattern.segments, pattern.phase).map_err(js_error)?;
        let elements = pattern
            .segments
            .iter()
            .copied()
            .enumerate()
            .map(|(index, length)| {
                if index.is_multiple_of(2) {
                    LineTypeElement::Dash { length }
                } else {
                    LineTypeElement::Gap { length }
                }
            })
            .collect();
        let resource = LineTypeResource {
            schema_id: LINE_TYPE_RESOURCE_SCHEMA_ID.to_owned(),
            resource_id: resource_id.to_owned(),
            content_hash: ObjectHash::of_bytes(b"unsealed legacy line type"),
            name: None,
            pattern: LineTypePattern::Repeating { elements },
        }
        .seal()
        .map_err(js_error)?;
        let reference = resource.resource_ref();
        self.install_line_type_resource_with_pattern(resource, gpu_pattern)
            .map_err(js_error)?;
        self.line_type_resources
            .legacy
            .insert(resource_id.to_owned(), reference.clone());
        serde_json::to_string(&reference).map_err(js_error)
    }

    /// Starts one bounded-memory exact section over the current canonical topology manifest.
    pub fn begin_authoritative_section_evaluation(
        &mut self,
        operation_id: &str,
        binding_json: &str,
        plane_json: &str,
        tolerance: f64,
    ) -> Result<String, JsValue> {
        if operation_id.is_empty()
            || operation_id.contains('\0')
            || self.section_evaluations.contains_key(operation_id)
        {
            return Err(JsValue::from_str(
                "section evaluation operation id is invalid or already active",
            ));
        }
        let binding: GeometryRepresentationBindingRef =
            serde_json::from_str(binding_json).map_err(js_error)?;
        let plane: SectionPlane = serde_json::from_str(plane_json).map_err(js_error)?;
        let storage_key = canonical_slot_storage_key(&binding.key.slot).map_err(js_error)?;
        if self.slot_bindings.get(&storage_key) != Some(&binding) {
            return Err(JsValue::from_str(
                "section evaluation binding is stale or not resident",
            ));
        }
        let Some((current_key, current_generation)) = self.representation_registry.current_key(
            &binding.key.slot.entity_id.0,
            &binding.key.slot.representation_slot,
        ) else {
            return Err(JsValue::from_str(
                "section evaluation targets a retired canonical slot",
            ));
        };
        if current_key != &binding.key || current_generation != binding.generation {
            return Err(JsValue::from_str("section evaluation generation is stale"));
        }
        let source_to_project = self
            .slot_requests
            .get(&storage_key)
            .map(|request| WorldTransform(request.placement.unwrap_or(Transform3d::IDENTITY).0))
            .ok_or_else(|| JsValue::from_str("section evaluation placement is missing"))?;
        if !source_to_project.is_invertible_affine() {
            return Err(JsValue::from_str(
                "section evaluation placement must be a finite invertible affine transform",
            ));
        }
        let topology = self
            .representation_registry
            .get(&binding.key)
            .and_then(|registered| registered.resolved().evaluated_mesh())
            .map(|evaluated| evaluated.topology().clone())
            .ok_or_else(|| JsValue::from_str("canonical slot has no evaluated topology"))?;
        let response = serde_json::json!({
            "topologyHash": topology.topology_hash(),
            "closedManifold": topology.closed_manifold(),
            "parts": topology.parts(),
        });
        let evaluation = AuthoritativeSectionAccumulator::new_with_transform(
            topology,
            plane,
            tolerance,
            source_to_project,
        )
        .map_err(js_error)?;
        self.section_evaluations
            .insert(operation_id.to_owned(), evaluation);
        serde_json::to_string(&response).map_err(js_error)
    }

    /// Verifies, decodes and intersects one topology partition, then releases its buffers.
    pub fn push_authoritative_section_partition(
        &mut self,
        operation_id: &str,
        part_id: &str,
        manifest_json: &str,
        position_bytes: &[u8],
        index_bytes: &[u8],
        material_slot_bytes: &[u8],
    ) -> Result<(), JsValue> {
        let evaluation = self
            .section_evaluations
            .get_mut(operation_id)
            .ok_or_else(|| JsValue::from_str("section evaluation operation is not active"))?;
        let expected = evaluation
            .expected_part()
            .ok_or_else(|| JsValue::from_str("section evaluation already has every partition"))?;
        if expected.part_id != part_id {
            return Err(JsValue::from_str(
                "section topology partition is out of manifest order",
            ));
        }
        let manifest: SectionTopologyPartitionManifest =
            serde_json::from_str(manifest_json).map_err(js_error)?;
        let topology_hash = manifest.content_hash().map_err(js_error)?;
        if topology_hash.0 != expected.topology_hash {
            return Err(JsValue::from_str(
                "section topology partition manifest does not match canonical topology",
            ));
        }
        let partition = decode_section_topology_partition(
            &manifest,
            topology_hash.0,
            position_bytes,
            index_bytes,
            material_slot_bytes,
        )?;
        evaluation.push(part_id, partition).map_err(js_error)
    }

    /// Advances without fetching a topology partition only when its source
    /// bounds, transformed by the canonical entity placement, prove that it
    /// cannot intersect the project-world section plane.
    pub fn skip_authoritative_section_partition(
        &mut self,
        operation_id: &str,
        part_id: &str,
    ) -> Result<bool, JsValue> {
        let evaluation = self
            .section_evaluations
            .get_mut(operation_id)
            .ok_or_else(|| JsValue::from_str("section evaluation operation is not active"))?;
        evaluation.skip_if_disjoint(part_id).map_err(js_error)
    }

    /// Finishes and returns one canonical section-product envelope.
    pub fn finish_authoritative_section_evaluation(
        &mut self,
        operation_id: &str,
    ) -> Result<String, JsValue> {
        let evaluation = self
            .section_evaluations
            .remove(operation_id)
            .ok_or_else(|| JsValue::from_str("section evaluation operation is not active"))?;
        let product = evaluation.finish().map_err(js_error)?;
        serde_json::to_string(&product).map_err(js_error)
    }

    /// Cancels one transient section operation and releases all accumulated segments.
    pub fn cancel_authoritative_section_evaluation(&mut self, operation_id: &str) -> bool {
        self.section_evaluations.remove(operation_id).is_some()
    }

    /// Registers one immutable, source-versioned cross-tile section product.
    ///
    /// The product is evaluated from authoritative topology outside the
    /// renderer. Its source partitions do not become renderer residency
    /// dependencies.
    pub fn register_section_product(
        &mut self,
        object_hash: &str,
        product_json: &str,
    ) -> Result<(), JsValue> {
        if object_hash.is_empty() {
            return Err(JsValue::from_str("section product hash is empty"));
        }
        // Immutable content-addressed registration is idempotent. This matters
        // when only a cap's view-local hatch/style changes: the authoritative
        // geometry product remains identical and must not be transferred into a
        // second mutable identity.
        if self.section_products.contains_key(object_hash) {
            return Ok(());
        }
        let product: AuthoritativeSectionProduct =
            serde_json::from_str(product_json).map_err(js_error)?;
        validate_authoritative_section_product(&product).map_err(js_error)?;
        let canonical_hash = serde_json::to_vec(&product)
            .map(|bytes| ObjectHash::of_bytes(&bytes))
            .map_err(js_error)?;
        if canonical_hash.0 != object_hash {
            return Err(JsValue::from_str(
                "section product ID must equal its canonical content hash",
            ));
        }
        self.section_products
            .insert(object_hash.to_owned(), product);
        Ok(())
    }

    /// Registers an immutable dimension formatting resource. Dimensions refer
    /// to this object hash and remain canonical measurements rather than baked
    /// display text.
    pub fn register_annotation_style(
        &mut self,
        object_hash: &str,
        style_json: &str,
    ) -> Result<(), JsValue> {
        if object_hash.is_empty() {
            return Err(JsValue::from_str("objectHash must be non-empty"));
        }
        if self.annotation_styles.contains_key(object_hash) {
            return Err(JsValue::from_str(
                "annotation style objectHash is already registered",
            ));
        }
        let style: WasmAnnotationStyle = serde_json::from_str(style_json).map_err(js_error)?;
        if style.glyph_atlas_hash.is_empty()
            || !style.text_height.is_finite()
            || style.text_height <= 0.0
            || style.decimals > 12
            || !style.line_width.is_finite()
            || style.line_width <= 0.0
        {
            return Err(JsValue::from_str("invalid annotation style"));
        }
        if !self.glyph_atlases.contains_key(&style.glyph_atlas_hash) {
            return Err(JsValue::from_str(
                "annotation style glyph atlas is not registered",
            ));
        }
        self.annotation_styles.insert(object_hash.to_owned(), style);
        Ok(())
    }

    /// Resolves one immutable canonical style resource to the render-core
    /// presentation used by inline block members. The exact resource revision,
    /// rather than a mutable name, is the lookup key.
    pub fn register_block_member_style(
        &mut self,
        resource_ref_json: &str,
        style_json: &str,
    ) -> Result<(), JsValue> {
        let resource: CanonicalResourceRef =
            serde_json::from_str(resource_ref_json).map_err(js_error)?;
        let style: RenderStyle = serde_json::from_str(style_json).map_err(js_error)?;
        let key = canonical_resource_ref_key(&resource).map_err(js_error)?;
        if self.block_member_styles.contains_key(&key) {
            return Err(JsValue::from_str(
                "block-member style resource revision is already registered",
            ));
        }
        validate_fill_resource(&style, &self.image_resources, &self.hatch_resources)
            .map_err(js_error)?;
        validate_stroke_resource(&style, &self.line_type_resources).map_err(js_error)?;
        self.block_member_styles.insert(key, (resource, style));
        Ok(())
    }

    /// Registers one immutable general attribute table used by typed block
    /// inheritance. The viewer retains only its verified content identity.
    pub fn register_block_attribute_table(
        &mut self,
        object_hash: &str,
        bytes: &[u8],
    ) -> Result<(), JsValue> {
        let computed = ObjectHash::of_bytes(bytes);
        if computed.as_str() != object_hash {
            return Err(JsValue::from_str(
                "block attribute table content hash does not match its bytes",
            ));
        }
        if !self.block_attribute_tables.insert(object_hash.to_owned()) {
            return Err(JsValue::from_str(
                "block attribute table revision is already registered",
            ));
        }
        Ok(())
    }

    /// Registers one immutable reusable block definition. Definitions are
    /// installed before their instances so a block never renders partially.
    pub fn register_block_definition(&mut self, definition_json: &str) -> Result<(), JsValue> {
        let definition: BlockDefinition =
            serde_json::from_str(definition_json).map_err(js_error)?;
        let key = block_definition_key(&definition.definition_id, &definition.content_hash.0);
        if self.block_definitions.contains_key(&key) {
            return Err(JsValue::from_str(
                "block definition revision is already registered",
            ));
        }
        let mut definitions = self.block_definitions.values().cloned().collect::<Vec<_>>();
        definitions.push(definition.clone());
        let mut entity_versions = self.block_member_entity_versions.clone();
        for member in &definition.members {
            let BlockMemberSource::EntityReference { entity } = &member.source else {
                continue;
            };
            let version_key = canonical_entity_version_ref_key(entity).map_err(js_error)?;
            if entity_versions.contains_key(&version_key) {
                continue;
            }
            let source = self.entity_requests.get(&entity.id.0).ok_or_else(|| {
                JsValue::from_str("block member entity revision is not resident for capture")
            })?;
            if source.source_revision != Some(entity.revision)
                || source.version_hash.as_deref() != Some(entity.version_hash.0.as_str())
            {
                return Err(JsValue::from_str(
                    "block member entity revision does not match the resident canonical entity",
                ));
            }
            entity_versions.insert(version_key, (entity.clone(), source.clone()));
        }
        let entities = entity_versions
            .values()
            .map(|(entity, _)| entity.clone())
            .collect::<Vec<_>>();
        let resources = self
            .block_member_styles
            .values()
            .map(|(resource, _)| resource.clone())
            .collect::<Vec<_>>();
        let attributes = self
            .block_attribute_tables
            .iter()
            .cloned()
            .map(ObjectHash)
            .collect::<Vec<_>>();
        validate_block_definition_set(&definitions, &entities, &resources, &attributes)
            .map_err(js_error)?;
        let previous_entity_versions =
            std::mem::replace(&mut self.block_member_entity_versions, entity_versions);
        self.block_definitions.insert(key.clone(), definition);
        if let Err(error) = self.rebuild_inline_clip_previews() {
            self.block_definitions.remove(&key);
            self.block_member_entity_versions = previous_entity_versions;
            return Err(js_error(error));
        }
        Ok(())
    }

    /// Selects every registered hierarchy and emits one fair mixed-provider
    /// fetch/decode/upload/eviction plan for the current f64 camera.
    pub fn plan_streaming_frame_json(&mut self, options_json: &str) -> Result<String, JsValue> {
        let options: WasmStreamingFrameOptions =
            serde_json::from_str(options_json).map_err(js_error)?;
        let camera = self
            .camera_frame
            .ok_or_else(|| JsValue::from_str("world camera is required before streaming"))?
            .camera;
        let extent = self.host.extent();
        let view = TileSelectionView {
            camera,
            viewport_width: extent[0],
            viewport_height: extent[1],
            maximum_screen_space_error: options.maximum_screen_space_error,
            detail_scale: options.detail_scale,
            maximum_traversed_nodes: options.maximum_traversed_nodes,
            maximum_unloaded_candidates: StreamingCoordinator::unloaded_candidate_limit(
                options.frame_budget.new_requests,
            ),
        };
        let (selections, preview_selections) =
            self.select_registered_datasets(view).map_err(js_error)?;
        let mut auxiliary = preview_selections
            .values()
            .flat_map(|selections| selections.iter().cloned())
            .collect::<Vec<_>>();
        auxiliary.extend(self.move_preview_fallback_selections(&preview_selections)?);
        self.apply_move_preview_target_tiles(&preview_selections)
            .map_err(js_error)?;
        let plan = self
            .streaming
            .plan_frame_with_auxiliary(
                &selections,
                &auxiliary,
                options.resource_budget,
                options.frame_budget,
            )
            .map_err(js_error)?;
        self.apply_streaming_visibility(&plan.render)
            .map_err(js_error)?;
        let render = if options.include_render_keys {
            plan.render.as_slice()
        } else {
            &[]
        };
        serde_json::to_string(&WasmStreamingFramePlanResponse {
            render,
            render_count: plan.render.len(),
            actions: &plan.actions,
            admission: &plan.admission,
            eviction: &plan.eviction,
            claimed_decode_ms: plan.claimed_decode_ms,
        })
        .map_err(js_error)
    }

    /// Reports authoritative streaming concurrency limits and occupied slots.
    pub fn streaming_runtime_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&serde_json::json!({
            "limits": self.streaming.runtime_limits(),
            "activeDecodes": self.streaming.active_decodes(),
            "inFlightContentRequests": self.streaming.in_flight_content_requests(),
            "trackedEntries": self.streaming.residency().tracked_entries(),
            "residencyStageCounts": self.streaming.residency().stage_counts(),
            "residencyCost": self.streaming.residency().total_cost(),
        }))
        .map_err(js_error)
    }

    /// Completes a content fetch and queues its compressed bytes for decoding.
    pub fn streaming_fetched(
        &mut self,
        ticket_json: &str,
        retained_cost_json: &str,
    ) -> Result<(), JsValue> {
        let (ticket, cost) = parse_streaming_completion(ticket_json, retained_cost_json)?;
        self.streaming.fetched(&ticket, cost).map_err(js_error)
    }

    /// Completes worker decoding and queues actual decoded resources for upload.
    pub fn streaming_decoded(
        &mut self,
        ticket_json: &str,
        retained_cost_json: &str,
    ) -> Result<(), JsValue> {
        let (ticket, cost) = parse_streaming_completion(ticket_json, retained_cost_json)?;
        self.streaming.decoded(&ticket, cost).map_err(js_error)
    }

    /// Publishes an uploaded tile to ADD/REPLACE selection.
    pub fn streaming_uploaded(
        &mut self,
        ticket_json: &str,
        retained_cost_json: &str,
    ) -> Result<(), JsValue> {
        let (ticket, cost) = parse_streaming_completion(ticket_json, retained_cost_json)?;
        self.streaming.uploaded(&ticket, cost).map_err(js_error)
    }

    /// Invalidates sibling tasks after a provider or transport failure.
    pub fn streaming_failed(
        &mut self,
        ticket_json: &str,
        message: &str,
        retained_cost_json: &str,
    ) -> Result<(), JsValue> {
        let (ticket, cost) = parse_streaming_completion(ticket_json, retained_cost_json)?;
        self.streaming
            .failed(&ticket, message, cost)
            .map_err(js_error)
    }

    /// Applies one lazy Potree hierarchy page or self-contained implicit subtree.
    pub fn apply_hierarchy_page(
        &mut self,
        owner_json: &str,
        page_uri: &str,
        bytes: &[u8],
    ) -> Result<(), JsValue> {
        let owner: TileKey = serde_json::from_str(owner_json).map_err(js_error)?;
        let dataset = &owner.dataset_id.0;
        if let Some(source) = self.potree_datasets.get_mut(dataset) {
            source
                .apply_hierarchy_page(&owner.tile_id, bytes)
                .map_err(js_error)?;
        } else if let Some(source) = self.prepared_datasets.get_mut(dataset) {
            source
                .apply_hierarchy_page(&owner.tile_id, page_uri, bytes)
                .map_err(js_error)?;
        } else if let Some(source) = self.implicit_tilesets.get_mut(dataset) {
            source
                .apply_binary_subtree(&owner.tile_id, page_uri, bytes)
                .map_err(js_error)?;
        } else if let Some(source) = self.explicit_tilesets.get_mut(dataset) {
            source
                .apply_external_tileset(&owner.tile_id, page_uri, bytes)
                .map_err(js_error)?;
        } else {
            return Err(JsValue::from_str("hierarchy page dataset is unknown"));
        }
        self.streaming.hierarchy_page_completed(&owner);
        Ok(())
    }

    /// Releases a failed lazy-page claim so a later frame may retry it.
    pub fn hierarchy_page_failed(&mut self, owner_json: &str) -> Result<(), JsValue> {
        let owner: TileKey = serde_json::from_str(owner_json).map_err(js_error)?;
        self.streaming.hierarchy_page_failed(&owner);
        Ok(())
    }

    /// Atomically detaches complete canonical entities from this view.
    ///
    /// The request must include every current representation slot of every touched
    /// entity. Registry CAS validation and render-overlay preparation both finish
    /// before view state is committed. This never deletes document entities.
    #[allow(clippy::too_many_lines)]
    pub fn detach_canonical_entities_json(
        &mut self,
        bindings_json: &str,
    ) -> Result<String, JsValue> {
        let bindings: Vec<GeometryRepresentationBindingRef> =
            serde_json::from_str(bindings_json).map_err(js_error)?;
        let retiring_entities = bindings
            .iter()
            .map(|binding| binding.key.slot.entity_id.0.clone())
            .collect::<std::collections::BTreeSet<_>>();
        if retiring_entities.is_empty() {
            return Err(JsValue::from_str(
                "canonical view-detach transaction must be non-empty",
            ));
        }
        for entity_id in &retiring_entities {
            let entity_bindings = bindings
                .iter()
                .filter(|binding| binding.key.slot.entity_id.0 == *entity_id)
                .collect::<Vec<_>>();
            let supplied = entity_bindings
                .iter()
                .map(|binding| {
                    canonical_slot_storage_key(&binding.key.slot).map(|slot| (slot, *binding))
                })
                .collect::<Result<BTreeMap<_, _>, _>>()
                .map_err(js_error)?;
            let supplied_slots = supplied.keys().cloned().collect();
            if supplied.len() != entity_bindings.len()
                || self.entity_slot_keys.get(entity_id) != Some(&supplied_slots)
                || supplied
                    .iter()
                    .any(|(slot, binding)| self.slot_bindings.get(slot) != Some(*binding))
            {
                return Err(JsValue::from_str(
                    "canonical view-detach bindings do not match every resident entity slot",
                ));
            }
            if self
                .entity_dependents
                .get(entity_id)
                .is_some_and(|dependents| {
                    dependents
                        .iter()
                        .any(|dependent| !retiring_entities.contains(dependent))
                })
            {
                return Err(JsValue::from_str(
                    "entity is referenced by resident associative geometry or annotation outside the retirement transaction",
                ));
            }
        }

        let (registry_overlay, tombstones) = self
            .representation_registry
            .prepare_retire_atomic(bindings)
            .map_err(js_error)?;
        let retiring_slots = retiring_entities
            .iter()
            .filter_map(|entity_id| self.entity_slot_keys.get(entity_id))
            .flatten()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let retiring_streams = retiring_slots
            .iter()
            .filter_map(|slot| self.slot_streams.get(slot))
            .flatten()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let retiring_dataset_ids = retiring_slots
            .iter()
            .filter_map(|slot| self.slot_dataset_ids.get(slot))
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let affected_sections = retiring_entities
            .iter()
            .filter_map(|entity_id| self.entity_sections.get(entity_id))
            .flatten()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let mut removed_proxy_ids = std::collections::BTreeSet::new();
        for slot in &retiring_slots {
            if self.slot_dataset_ids.contains_key(slot) {
                continue;
            }
            if let Some(request) = self.slot_requests.get(slot) {
                removed_proxy_ids.extend(
                    entity_proxy_ids(
                        request,
                        &self.entity_requests,
                        &self.block_definitions,
                        &self.block_member_styles,
                        &self.block_member_entity_versions,
                    )
                    .map_err(js_error)?,
                );
            }
        }
        for stream_id in &retiring_streams {
            removed_proxy_ids.extend(stream_render_proxy_ids(self, stream_id));
        }
        for section_id in &affected_sections {
            removed_proxy_ids.extend(
                self.section_proxy_ids
                    .get(section_id)
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
        }
        let render_overlay = self
            .render_world
            .prepare_overlay(removed_proxy_ids.iter().cloned())
            .map_err(js_error)?;

        self.representation_registry
            .commit_atomic(registry_overlay)
            .map_err(js_error)?;
        let render_diagnostics = self
            .render_world
            .commit_overlay(render_overlay)
            .map_err(js_error)?;

        for stream_id in &retiring_streams {
            purge_stream_state_after_render_commit(self, stream_id);
        }
        for dataset_id in &retiring_dataset_ids {
            let _ = self
                .streaming
                .remove_dataset(&DatasetId(dataset_id.clone()));
            self.explicit_tilesets.remove(dataset_id);
            self.implicit_tilesets.remove(dataset_id);
            self.potree_datasets.remove(dataset_id);
            self.prepared_datasets.remove(dataset_id);
            self.registered_dataset_contracts.remove(dataset_id);
        }
        self.sync_external_asset_cache_cost();
        if self
            .raster_analysis_view
            .as_ref()
            .is_some_and(|analysis| retiring_entities.contains(&analysis.entity_id))
        {
            self.raster_analysis_view = None;
            self.sync_external_asset_cache_cost();
        }
        for entity_id in &retiring_entities {
            let previous = self.entity_requests.get(entity_id).cloned();
            replace_entity_dependency_index(
                &mut self.entity_dependents,
                entity_id,
                previous.as_ref().map(|request| &request.geometry),
                None,
                &self.block_definitions,
            );
            self.entity_requests.remove(entity_id);
            self.entity_styles.remove(entity_id);
            self.entity_interactions.remove(entity_id);
            self.render_world.clear_entity_visibility(entity_id);
            self.primary_slot_keys.remove(entity_id);
            self.discard_move_previews_for_entity(entity_id);
            if let Some(slots) = self.entity_slot_keys.remove(entity_id) {
                for slot in slots {
                    self.slot_requests.remove(&slot);
                    self.slot_bindings.remove(&slot);
                    self.canonical_admissions.remove(&slot);
                    self.slot_streams.remove(&slot);
                    if let Some(dataset_id) = self.slot_dataset_ids.remove(&slot) {
                        self.dataset_slot_keys.remove(&dataset_id);
                    }
                }
            }
        }
        for section_id in &affected_sections {
            let removed = self.section_requests.remove(section_id);
            replace_entity_section_index(
                &mut self.entity_sections,
                section_id,
                removed.as_ref(),
                None,
            );
            self.section_proxy_ids.remove(section_id);
        }
        for proxy_id in &removed_proxy_ids {
            self.batches.remove(proxy_id);
            self.mesh_pick_indices.remove(&proxy_id.0);
            self.gltf_feature_catalogs.remove(&proxy_id.0);
        }
        self.last_transaction_diagnostics = WasmTransactionDiagnostics {
            touched_entities: retiring_entities.len(),
            touched_sections: affected_sections.len(),
            touched_proxies: render_diagnostics
                .observed_proxies
                .saturating_add(render_diagnostics.staged_proxies),
            foreign_visits: 0,
        };
        self.rebuild_inline_clip_previews().map_err(js_error)?;
        Ok(serde_json::json!({
            "tombstones": tombstones,
            "entities": self.entity_requests.len(),
            "slots": self.slot_requests.len(),
            "proxies": self.batches.len(),
            "generation": self.render_world.generation(),
        })
        .to_string())
    }

    /// Compatibility alias for the pre-document-authority API. This performs
    /// view detach only and never creates a canonical document tombstone.
    pub fn retire_canonical_entities_json(
        &mut self,
        bindings_json: &str,
    ) -> Result<String, JsValue> {
        self.detach_canonical_entities_json(bindings_json)
    }

    /// Applies color mode, height ramp, opacity and exaggeration live to every
    /// resident proxy part of one entity without rebuilding geometry buffers.
    pub fn set_entity_style_json(
        &mut self,
        entity_id: &str,
        style_json: &str,
        exaggeration_datum: f64,
    ) -> Result<usize, JsValue> {
        if entity_id.is_empty() {
            return Err(JsValue::from_str("entityId must be non-empty"));
        }
        let style: RenderStyle = serde_json::from_str(style_json).map_err(js_error)?;
        let effective_style = style.with_interaction(
            self.entity_interactions
                .get(entity_id)
                .copied()
                .unwrap_or_default(),
        );
        validate_fill_resource(
            &effective_style,
            &self.image_resources,
            &self.hatch_resources,
        )
        .map_err(js_error)?;
        validate_stroke_resource(&effective_style, &self.line_type_resources).map_err(js_error)?;
        let ids = self.render_world.proxy_ids_for_entity(entity_id);
        if ids.iter().any(|id| {
            self.batches
                .get(id)
                .is_none_or(|batches| batches.iter().any(|batch| !batch.has_material()))
        }) {
            return Err(JsValue::from_str(
                "entity contains a batch without a mutable presentation material",
            ));
        }
        let mut resolved = Vec::with_capacity(ids.len());
        for id in &ids {
            let kind = self
                .render_world
                .proxy_kind(id)
                .ok_or_else(|| JsValue::from_str("entity proxy kind is unavailable"))?;
            let presentations = self
                .batches
                .get(id)
                .expect("validated batch existence")
                .iter()
                .map(|batch| {
                    resolve_batch_presentation(
                        &effective_style,
                        exaggeration_datum,
                        kind,
                        batch,
                        &self.image_resources,
                        &self.hatch_resources,
                        &self.line_type_resources,
                    )
                    .map_err(js_error)
                })
                .collect::<Result<Vec<_>, _>>()?;
            resolved.push(presentations);
        }
        for (id, presentations) in ids.iter().zip(&resolved) {
            for (batch, presentation) in self
                .batches
                .get_mut(id)
                .expect("validated batch existence")
                .iter_mut()
                .zip(presentations)
            {
                apply_batch_presentation(&self.host, batch, presentation).map_err(js_error)?;
            }
        }
        self.render_world
            .set_entity_style(entity_id, &effective_style);
        persist_entity_style(self, entity_id, &effective_style, exaggeration_datum);
        self.entity_styles
            .insert(entity_id.to_owned(), (style, exaggeration_datum));
        if self
            .raster_analysis_view
            .as_ref()
            .is_some_and(|analysis| analysis.entity_id == entity_id)
        {
            let _ = self.set_raster_analysis_view_json(entity_id)?;
        }
        self.last_transaction_diagnostics = WasmTransactionDiagnostics {
            touched_entities: 1,
            touched_sections: 0,
            touched_proxies: ids.len(),
            foreign_visits: 0,
        };
        self.rebuild_inline_clip_previews().map_err(js_error)?;
        self.rebuild_move_previews_for_entity(Some(entity_id), self.floating_origin)?;
        Ok(ids.len())
    }

    /// Applies shared transient selection/hover presentation without changing
    /// canonical geometry, base style, proxy identity or residency.
    pub fn set_entity_interaction_state(
        &mut self,
        entity_id: &str,
        selected: bool,
        hovered: bool,
    ) -> Result<usize, JsValue> {
        if entity_id.is_empty() || !self.entity_slot_keys.contains_key(entity_id) {
            return Err(JsValue::from_str(
                "entityId must name a current canonical entity",
            ));
        }
        let next = EntityInteractionState { selected, hovered };
        let previous = self.entity_interactions.get(entity_id).copied();
        if previous.unwrap_or_default() == next {
            return Ok(0);
        }
        if next == EntityInteractionState::default() {
            self.entity_interactions.remove(entity_id);
        } else {
            self.entity_interactions.insert(entity_id.to_owned(), next);
        }
        let Some((base_style, exaggeration_datum)) = self.entity_styles.get(entity_id).cloned()
        else {
            restore_entity_interaction(&mut self.entity_interactions, entity_id, previous);
            return Err(JsValue::from_str("entity base style is unavailable"));
        };
        let style_json = match serde_json::to_string(&base_style) {
            Ok(style_json) => style_json,
            Err(error) => {
                restore_entity_interaction(&mut self.entity_interactions, entity_id, previous);
                return Err(js_error(error));
            }
        };
        match self.set_entity_style_json(entity_id, &style_json, exaggeration_datum) {
            Ok(updated) => Ok(updated),
            Err(error) => {
                restore_entity_interaction(&mut self.entity_interactions, entity_id, previous);
                Err(error)
            }
        }
    }

    /// Changes one canonical entity's view visibility without changing its
    /// immutable GPU allocations, residency or current streaming selection.
    pub fn set_entity_visibility(
        &mut self,
        entity_id: &str,
        visible: bool,
    ) -> Result<usize, JsValue> {
        if entity_id.is_empty() || !self.entity_slot_keys.contains_key(entity_id) {
            return Err(JsValue::from_str(
                "entityId must name a current canonical entity",
            ));
        }
        if !visible {
            self.discard_move_previews_for_entity(entity_id);
        }
        let changed = self.render_world.set_entity_visibility(entity_id, visible);
        self.last_transaction_diagnostics = WasmTransactionDiagnostics {
            touched_entities: 1,
            touched_sections: 0,
            touched_proxies: changed,
            foreign_visits: 0,
        };
        Ok(changed)
    }

    /// Creates a non-pickable translucent copy sharing the entity's immutable
    /// GPU buffers. Subsequent cursor moves update only one small uniform per batch.
    pub fn begin_move_preview(
        &mut self,
        preview_id: &str,
        entity_id: &str,
        opacity_multiplier: f32,
    ) -> Result<usize, JsValue> {
        if preview_id.is_empty()
            || entity_id.is_empty()
            || !opacity_multiplier.is_finite()
            || !(0.0..=1.0).contains(&opacity_multiplier)
        {
            return Err(JsValue::from_str(
                "previewId, entityId and an opacity multiplier from zero through one are required",
            ));
        }
        let source_bindings = self.current_entity_bindings(entity_id)?;
        let source_entity = self.current_canonical_entity(entity_id)?;
        let source_revision = source_entity.revision;
        let source_version_hash = source_entity.version_hash.clone();
        let (base_style, exaggeration_datum) = self
            .entity_styles
            .get(entity_id)
            .cloned()
            .unwrap_or((RenderStyle::default(), 0.0));
        self.entity_styles.insert(
            entity_id.to_owned(),
            (base_style.clone(), exaggeration_datum),
        );
        let mut style = base_style;
        style.opacity *= opacity_multiplier;
        let translation = WorldVec3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        };
        let target_render_tiles = self
            .render_world
            .proxy_ids_for_entity(entity_id)
            .into_iter()
            .filter(|id| self.render_world.is_visible(id))
            .filter_map(|id| self.render_world.tile_key_for_proxy(&id))
            .collect::<BTreeSet<_>>();
        let batches = build_move_preview_batches(
            &self.host,
            &self.render_world,
            &self.batches,
            entity_id,
            &style,
            exaggeration_datum,
            translation,
            self.floating_origin,
            &target_render_tiles,
            &self.image_resources,
            &self.hatch_resources,
            &self.line_type_resources,
        )
        .map_err(js_error)?;
        if batches.is_empty() {
            return Err(JsValue::from_str(
                "entity has no resident render batches for a move preview",
            ));
        }
        let count = batches.len();
        if let Some(previous) = self.move_previews.get(preview_id) {
            if let Some(previews) = self.entity_move_previews.get_mut(&previous.entity_id) {
                previews.remove(preview_id);
                if previews.is_empty() {
                    self.entity_move_previews.remove(&previous.entity_id);
                }
            }
        }
        self.entity_move_previews
            .entry(entity_id.to_owned())
            .or_default()
            .insert(preview_id.to_owned());
        self.move_previews.insert(
            preview_id.to_owned(),
            WasmMovePreview {
                entity_id: entity_id.to_owned(),
                source_bindings,
                source_revision,
                source_version_hash,
                opacity_multiplier,
                style,
                exaggeration_datum,
                translation,
                target_render_tiles,
                batches,
            },
        );
        Ok(count)
    }

    /// Moves a live ghost by an f64 project-world delta without rebuilding geometry.
    pub fn update_move_preview(
        &mut self,
        preview_id: &str,
        x: f64,
        y: f64,
        z: f64,
    ) -> Result<(), JsValue> {
        let preview = self
            .move_previews
            .get_mut(preview_id)
            .ok_or_else(|| JsValue::from_str("move preview is unknown"))?;
        let translation = WorldVec3 { x, y, z };
        if !finite_translation(translation) {
            return Err(JsValue::from_str("move preview translation must be finite"));
        }
        let previous_translation = preview.translation;
        for preview_batch in &mut preview.batches {
            let current_origin = preview_batch
                .batch
                .batch_origin()
                .ok_or_else(|| JsValue::from_str("move preview batch has no stable origin"))?;
            let source_origin = subtract_world(current_origin, previous_translation);
            let target_origin = add_world(source_origin, translation);
            preview_batch
                .batch
                .set_world_origins(self.host.queue(), target_origin, self.floating_origin)
                .map_err(js_error)?;
            let resolved = resolve_batch_presentation(
                &preview.style,
                preview.exaggeration_datum,
                preview_batch.kind,
                &preview_batch.batch,
                &self.image_resources,
                &self.hatch_resources,
                &self.line_type_resources,
            )
            .map_err(js_error)?;
            apply_batch_presentation(&self.host, &mut preview_batch.batch, &resolved)
                .map_err(js_error)?;
        }
        preview.translation = WorldVec3 { x, y, z };
        Ok(())
    }

    /// Target-only resident tiles selected for one streamed move ghost.
    pub fn move_preview_target_tiles_json(&self, preview_id: &str) -> Result<String, JsValue> {
        let preview = self
            .move_previews
            .get(preview_id)
            .ok_or_else(|| JsValue::from_str("move preview is unknown"))?;
        serde_json::to_string(
            &preview
                .target_render_tiles
                .iter()
                .cloned()
                .collect::<Vec<_>>(),
        )
        .map_err(js_error)
    }

    /// Removes one transient ghost while leaving canonical entity state untouched.
    pub fn remove_move_preview(&mut self, preview_id: &str) -> bool {
        let Some(preview) = self.move_previews.remove(preview_id) else {
            return false;
        };
        if let Some(previews) = self.entity_move_previews.get_mut(&preview.entity_id) {
            previews.remove(preview_id);
            if previews.is_empty() {
                self.entity_move_previews.remove(&preview.entity_id);
            }
        }
        true
    }

    /// Commits one replayable absolute placement command through canonical CAS and render swap.
    pub fn transform_entity_json(
        &mut self,
        command_json: &str,
        expected_bindings_json: &str,
    ) -> Result<String, JsValue> {
        let command: TransformEntityCommand =
            serde_json::from_str(command_json).map_err(js_error)?;
        let expected_bindings: Vec<GeometryRepresentationBindingRef> =
            serde_json::from_str(expected_bindings_json).map_err(js_error)?;
        self.execute_transform_entity_command(command, expected_bindings)
    }

    /// Converts one translation ghost into a canonical command without reloading resident tiles.
    pub fn commit_move_preview_json(
        &mut self,
        preview_id: &str,
        command_id: &str,
    ) -> Result<String, JsValue> {
        let preview = self
            .move_previews
            .get(preview_id)
            .ok_or_else(|| JsValue::from_str("move preview is unknown"))?;
        let entity_id = preview.entity_id.clone();
        let source_bindings = preview.source_bindings.clone();
        let source_revision = preview.source_revision;
        let source_version_hash = preview.source_version_hash.clone();
        let translation = preview.translation;
        let source = self.current_canonical_entity(&entity_id)?;
        let target_placement = if translation
            == (WorldVec3 {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            }) {
            source.placement
        } else {
            let delta = WorldTransform::from_translation(translation)
                .ok_or_else(|| JsValue::from_str("move preview translation is invalid"))?;
            let current = WorldTransform(source.placement.unwrap_or(Transform3d::IDENTITY).0);
            Some(Transform3d(
                delta
                    .compose(current)
                    .ok_or_else(|| JsValue::from_str("move preview target placement is invalid"))?
                    .0,
            ))
        };
        let result = self.execute_transform_entity_command(
            TransformEntityCommand {
                command_id: command_id.to_owned(),
                entity_id: EntityId(entity_id),
                expected_revision: source_revision,
                expected_version_hash: source_version_hash,
                target_placement,
            },
            source_bindings,
        )?;
        self.remove_move_preview(preview_id);
        Ok(result)
    }

    /// Appends a compensating forward revision that restores the latest command's prior placement.
    pub fn undo_entity_command_json(
        &mut self,
        command_id: &str,
        expected_bindings_json: &str,
    ) -> Result<String, JsValue> {
        self.ensure_entity_command_id_available(command_id)?;
        let expected_bindings: Vec<GeometryRepresentationBindingRef> =
            serde_json::from_str(expected_bindings_json).map_err(js_error)?;
        let history = self
            .entity_undo_stack
            .last()
            .cloned()
            .ok_or_else(|| JsValue::from_str("entity command undo stack is empty"))?;
        let current = self.current_canonical_entity(&history.entity_id)?;
        if current.placement != history.after {
            return Err(JsValue::from_str(
                "latest entity command placement no longer matches canonical state",
            ));
        }
        let applied = restore_entity_placement(
            &current,
            command_id,
            current.revision,
            &current.version_hash,
            history.before,
        )
        .map_err(js_error)?;
        let entry = self.next_entity_journal_entry(
            &applied,
            EntityCommandJournalKind::UndoTransformEntity,
            Some(history.root_command_id.clone()),
        )?;
        let publication = self.commit_entity_placement_publication(&applied, &expected_bindings)?;
        self.entity_undo_stack.pop();
        self.entity_redo_stack.push(history);
        self.append_entity_journal_entry(entry.clone());
        append_command_result(publication, &applied.after, &entry)
    }

    /// Reapplies the latest compensated placement as another monotone forward revision.
    pub fn redo_entity_command_json(
        &mut self,
        command_id: &str,
        expected_bindings_json: &str,
    ) -> Result<String, JsValue> {
        self.ensure_entity_command_id_available(command_id)?;
        let expected_bindings: Vec<GeometryRepresentationBindingRef> =
            serde_json::from_str(expected_bindings_json).map_err(js_error)?;
        let history = self
            .entity_redo_stack
            .last()
            .cloned()
            .ok_or_else(|| JsValue::from_str("entity command redo stack is empty"))?;
        let current = self.current_canonical_entity(&history.entity_id)?;
        if current.placement != history.before {
            return Err(JsValue::from_str(
                "latest redo placement no longer matches canonical state",
            ));
        }
        let applied = restore_entity_placement(
            &current,
            command_id,
            current.revision,
            &current.version_hash,
            history.after,
        )
        .map_err(js_error)?;
        let entry = self.next_entity_journal_entry(
            &applied,
            EntityCommandJournalKind::RedoTransformEntity,
            Some(history.root_command_id.clone()),
        )?;
        let publication = self.commit_entity_placement_publication(&applied, &expected_bindings)?;
        self.entity_redo_stack.pop();
        self.entity_undo_stack.push(history);
        self.append_entity_journal_entry(entry.clone());
        append_command_result(publication, &applied.after, &entry)
    }

    /// Serializable append-only journal mirror for project persistence and deterministic replay.
    pub fn entity_command_journal_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&serde_json::json!({
            "entries": self.entity_command_journal.entries(),
            "canUndo": !self.entity_undo_stack.is_empty(),
            "canRedo": !self.entity_redo_stack.is_empty(),
            "nextSequence": self.entity_command_journal.next_sequence(),
        }))
        .map_err(js_error)
    }

    /// Rebuilds one exact f64 section cap set for closed inline meshes.
    pub fn upsert_section_json(&mut self, request_json: &str) -> Result<String, JsValue> {
        let request: WasmSectionRequest = serde_json::from_str(request_json).map_err(js_error)?;
        let unique_local_entities = !request.entity_ids.is_empty()
            && request.entity_ids.iter().all(|id| !id.is_empty())
            && request
                .entity_ids
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == request.entity_ids.len();
        let local =
            unique_local_entities && request.entity_id.is_none() && request.product_hash.is_none();
        let evaluated = request.entity_ids.is_empty()
            && request.entity_id.as_ref().is_some_and(|id| !id.is_empty())
            && request.product_hash.as_ref().is_some_and(|hash| {
                self.section_products.get(hash).is_some_and(|product| {
                    authoritative_section_matches_entity(
                        product,
                        &request,
                        &self.entity_requests,
                        &self.dataset_slot_keys,
                        &self.slot_bindings,
                    )
                })
            });
        if request.section_id.is_empty()
            || !request.tolerance.is_finite()
            || request.tolerance <= 0.0
            || (!local && !evaluated)
        {
            return Err(JsValue::from_str(
                "section needs either unique resident entityIds or an authoritative product matching entity, dataset, version, plane and tolerance",
            ));
        }
        let old_ids = self
            .section_proxy_ids
            .get(&request.section_id)
            .cloned()
            .unwrap_or_default();
        let mut overlay = self
            .render_world
            .prepare_overlay(old_ids.iter().cloned())
            .map_err(js_error)?;
        let next_world = overlay.staging_world_mut();
        let mut next_batches = BTreeMap::new();
        let ids = compile_section_request(
            &self.host,
            next_world,
            &mut next_batches,
            &self.entity_requests,
            &self.dataset_slot_keys,
            &self.slot_bindings,
            &request,
            self.floating_origin,
            &self.block_definitions,
            &self.block_member_styles,
            &self.block_member_entity_versions,
            &self.mesh_resources,
            &self.hatch_resources,
            &self.line_type_resources,
            &self.section_products,
            &self.clip_volumes,
        )
        .map_err(js_error)?;
        let touched_proxy_count = old_ids.len().saturating_add(ids.len());
        for id in old_ids {
            self.batches.remove(&id);
        }
        self.batches.extend(next_batches);
        self.render_world
            .commit_overlay(overlay)
            .map_err(js_error)?;
        self.last_transaction_diagnostics = WasmTransactionDiagnostics {
            touched_entities: request.entity_ids.len() + usize::from(request.entity_id.is_some()),
            touched_sections: 1,
            touched_proxies: touched_proxy_count,
            foreign_visits: 0,
        };
        self.section_proxy_ids
            .insert(request.section_id.clone(), ids.clone());
        replace_entity_section_index(
            &mut self.entity_sections,
            &request.section_id,
            self.section_requests.get(&request.section_id),
            Some(&request),
        );
        self.section_requests
            .insert(request.section_id.clone(), request);
        Ok(serde_json::json!({
            "proxies": self.batches.len(),
            "generation": self.render_world.generation()
        })
        .to_string())
    }

    /// Removes one generated exact section cap set.
    pub fn remove_section(&mut self, section_id: &str) -> Result<bool, JsValue> {
        let Some(ids) = self.section_proxy_ids.get(section_id) else {
            return Ok(false);
        };
        let overlay = self
            .render_world
            .prepare_overlay(ids.iter().cloned())
            .map_err(js_error)?;
        self.render_world
            .commit_overlay(overlay)
            .map_err(js_error)?;
        self.last_transaction_diagnostics = WasmTransactionDiagnostics {
            touched_entities: 0,
            touched_sections: 1,
            touched_proxies: ids.len(),
            foreign_visits: 0,
        };
        let ids = self
            .section_proxy_ids
            .remove(section_id)
            .unwrap_or_default();
        let removed = self.section_requests.remove(section_id);
        replace_entity_section_index(
            &mut self.entity_sections,
            section_id,
            removed.as_ref(),
            None,
        );
        for id in ids {
            self.batches.remove(&id);
        }
        Ok(true)
    }

    /// Monotonic generation used by JavaScript to reject stale async picks.
    pub fn world_generation(&self) -> u64 {
        self.render_world.generation()
    }

    /// Diagnostic instance order of CPU-sorted Gaussian blocks. Weighted OIT
    /// returns an empty list because no order-dependent copies exist.
    pub fn gaussian_splat_order_json(&self, proxy_id: &str) -> Result<String, JsValue> {
        let blocks = self
            .batches
            .get(&RenderProxyId(proxy_id.to_owned()))
            .map(|batches| {
                batches
                    .iter()
                    .filter_map(GpuDrawBatch::sorted_splat_primitive_slots)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        serde_json::to_string(&blocks).map_err(js_error)
    }

    /// Number of transient exact cap batches generated for active clip volumes.
    pub fn clip_preview_batch_count(&self) -> usize {
        self.clip_preview_batches.len()
    }

    /// Material slots represented by transient exact clipping caps.
    pub fn clip_preview_material_slots_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.clip_preview_material_slots).map_err(js_error)
    }

    /// Atomically replaces convex clipping volumes shared by every proxy kind.
    pub fn set_clip_volumes_json(&mut self, volumes_json: &str) -> Result<(), JsValue> {
        let volumes: Vec<ClipVolume> = serde_json::from_str(volumes_json).map_err(js_error)?;
        self.render_world
            .replace_clip_volumes(volumes.clone())
            .map_err(js_error)?;
        self.clip_volumes = self.render_world.clip_volumes().cloned().collect();
        self.rebuild_inline_clip_previews().map_err(js_error)?;
        Ok(())
    }

    /// Sets a linear RGBA clear color.
    pub fn set_clear_color(&mut self, r: f64, g: f64, b: f64, a: f64) -> Result<(), JsValue> {
        if [r, g, b, a]
            .iter()
            .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
        {
            return Err(JsValue::from_str(
                "clear color channels must be finite values from zero through one",
            ));
        }
        self.clear_color = wgpu::Color { r, g, b, a };
        Ok(())
    }

    /// Presents one frame. Geometry registration is performed through the
    /// versioned render-world bridge, not through JavaScript scene objects.
    pub fn render(&mut self) -> Result<String, JsValue> {
        let outcome = self.submit_frame(None).map_err(js_error)?;
        Ok(frame_outcome_json(&outcome).to_string())
    }

    /// Renders and asynchronously maps one bounded cursor neighborhood from the
    /// exact ID/reverse-Z attachments.
    pub async fn render_pick(&mut self, x: u32, y: u32, radius: u32) -> Result<String, JsValue> {
        let camera_frame = self.camera_frame.ok_or_else(|| {
            JsValue::from_str(
                "set_world_camera_json must be called before coordinate-aware picking",
            )
        })?;
        let generation = self.render_world.generation();
        let out_of_memory_scope = self
            .host
            .device()
            .push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal_scope = self
            .host
            .device()
            .push_error_scope(wgpu::ErrorFilter::Internal);
        let validation_scope = self
            .host
            .device()
            .push_error_scope(wgpu::ErrorFilter::Validation);
        let outcome = self
            .submit_frame(Some(SurfacePickRequest {
                pixel: [x, y],
                radius,
            }))
            .map_err(js_error)?;
        let validation = validation_scope.pop();
        let internal = internal_scope.pop();
        let out_of_memory = out_of_memory_scope.pop();
        self.host
            .device()
            .poll(wgpu::PollType::Poll)
            .map_err(js_error)?;
        if let Some(error) = validation.await {
            return Err(JsValue::from_str(&format!(
                "GPU pick validation failed: {error}"
            )));
        }
        if let Some(error) = internal.await {
            return Err(JsValue::from_str(&format!(
                "GPU pick internal failure: {error}"
            )));
        }
        if let Some(error) = out_of_memory.await {
            self.host
                .require_device_recovery(GpuRecoveryReason::OutOfMemory);
            return Err(JsValue::from_str(&format!(
                "GPU pick ran out of memory: {error}"
            )));
        }
        let SurfaceFrameOutcome::Picked {
            hit_readback: readback,
        } = outcome
        else {
            return Err(JsValue::from_str(
                "pick frame was not presented with a readback",
            ));
        };
        let pixels = readback.resolve().await.map_err(js_error)?;
        if generation != self.render_world.generation() {
            return Ok(serde_json::json!({
                "generation": generation,
                "stale": true,
                "candidates": []
            })
            .to_string());
        }
        let candidates = reconstruct_coarse_pick_candidates(
            &self.render_world,
            camera_frame,
            self.host.extent(),
            [x, y],
            &pixels,
        )
        .map_err(js_error)?;
        let candidates = refine_pick_candidates(
            self,
            &camera_frame,
            self.host.extent(),
            [x, y],
            radius,
            &candidates,
        )
        .map_err(js_error)?;
        let mut cycle = PickCycle::new();
        cycle.replace(generation, candidates);
        let candidates = cycle
            .candidates()
            .iter()
            .map(|candidate| public_pick_candidate(self, candidate))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(serde_json::json!({
            "generation": generation,
            "stale": false,
            "candidates": candidates
        })
        .to_string())
    }

    /// Stable capability report used to resolve hardware budgets and diagnostics.
    pub fn capabilities_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(self.host.capabilities()).map_err(js_error)
    }

    /// Resolves actual adapter limits plus host inventory and optional measured
    /// calibration into one uncapped resource/frame policy.
    pub fn hardware_policy_json(&mut self, request_json: &str) -> Result<String, JsValue> {
        let request: WasmHardwarePolicyRequest =
            serde_json::from_str(request_json).map_err(js_error)?;
        let policy = HardwarePolicyResolver::resolve_for_profile(
            self.host.capabilities(),
            request.inventory,
            request.calibration,
            request.deployment_profile,
        );
        self.streaming
            .set_runtime_limits(StreamingRuntimeLimits::new(
                usize::from(policy.decoder_workers),
                usize::from(policy.content_requests),
            ));
        if let Some(governor) = self.runtime_quality.as_mut() {
            governor.update_policy(policy);
        } else {
            self.runtime_quality = Some(RuntimeQualityGovernor::new(policy));
        }
        serde_json::to_string(&policy).map_err(js_error)
    }

    /// Current adaptive presentation state owned by the Rust quality governor.
    pub fn runtime_quality_json(&self) -> Result<String, JsValue> {
        let state = self
            .runtime_quality
            .as_ref()
            .map(RuntimeQualityGovernor::state)
            .ok_or_else(|| {
                JsValue::from_str("hardware_policy_json must initialize runtime quality first")
            })?;
        serde_json::to_string(&state).map_err(js_error)
    }

    /// Observes one completed frame and applies bounded Rust-owned hysteresis.
    ///
    /// The host supplies CPU timing, interaction state and uploaded bytes. GPU
    /// timing comes exclusively from completed `GpuSurfaceHost` timestamp maps;
    /// visible work and complete residency come from authoritative kernel state.
    pub fn observe_frame_telemetry_json(
        &mut self,
        observation_json: &str,
    ) -> Result<String, JsValue> {
        let observation: WasmFrameTelemetryObservation =
            serde_json::from_str(observation_json).map_err(js_error)?;
        if self.runtime_quality.is_none() {
            return Err(JsValue::from_str(
                "hardware_policy_json must initialize runtime quality first",
            ));
        }
        let gpu_ms = if self.host.gpu_frame_timing_diagnostics().supported {
            self.host.take_completed_gpu_frame_ms()
        } else {
            None
        };
        let timing = TimingSample {
            cpu_ms: observation.cpu_ms,
            gpu_ms,
            interacting: observation.interacting,
        };
        let canonical_visible_cost = self.raster_analysis_view.as_ref().map_or_else(
            || self.render_world.visible_cost(),
            |analysis| analysis.cost,
        );
        let move_preview_visible_cost = self.raster_analysis_view.as_ref().map_or_else(
            || {
                self.move_previews.values().fold(
                    ResourceCost::default(),
                    |preview_cost, preview| {
                        let source = if preview.target_render_tiles.is_empty() {
                            self.render_world
                                .visible_cost_for_entity(&preview.entity_id)
                        } else {
                            self.render_world.resident_cost_for_tiles(
                                preview.target_render_tiles.iter().cloned(),
                            )
                        };
                        let source_cost = ResourceCost {
                            points: source.points,
                            triangles: source.triangles,
                            splats: source.splats,
                            draw_calls: source.draw_calls,
                            ..ResourceCost::default()
                        };
                        preview_cost.saturating_add(source_cost)
                    },
                )
            },
            |_| ResourceCost::default(),
        );
        let clip_visible_cost = self.raster_analysis_view.as_ref().map_or_else(
            || ResourceCost {
                triangles: self.clip_preview_cost.triangles,
                draw_calls: self.clip_preview_cost.draw_calls,
                ..ResourceCost::default()
            },
            |_| ResourceCost::default(),
        );
        let visible_cost = canonical_visible_cost
            .saturating_add(move_preview_visible_cost)
            .saturating_add(clip_visible_cost);
        let shared_cost = self.streaming.residency().shared_cost();
        let move_preview_gpu_bytes = self
            .move_previews
            .values()
            .flat_map(|preview| preview.batches.iter())
            .fold(0_u64, |bytes, preview_batch| {
                bytes.saturating_add(preview_batch.batch.styled_fork_exclusive_gpu_bytes())
            });
        let canonical_resident_cost = self.render_world.resident_cost();
        let analysis_gpu_bytes = self.raster_analysis_view.as_ref().map_or(0, |analysis| {
            analysis
                .cost
                .gpu_buffer_bytes
                .saturating_add(analysis.cost.gpu_texture_bytes)
        });
        let resident_gpu_bytes = canonical_resident_cost
            .gpu_buffer_bytes
            .saturating_add(canonical_resident_cost.gpu_texture_bytes)
            .saturating_add(shared_cost.gpu_buffer_bytes)
            .saturating_add(shared_cost.gpu_texture_bytes)
            .saturating_add(self.clip_preview_cost.gpu_buffer_bytes)
            .saturating_add(self.clip_preview_cost.gpu_texture_bytes)
            .saturating_add(move_preview_gpu_bytes)
            .saturating_add(analysis_gpu_bytes);
        if !self.frame_telemetry.observe(FrameTelemetrySample {
            timing,
            uploaded_bytes: observation.uploaded_bytes,
            points: visible_cost.points,
            triangles: visible_cost.triangles,
            splats: visible_cost.splats,
            draw_calls: visible_cost.draw_calls,
            resident_gpu_bytes,
        }) {
            return Err(JsValue::from_str(
                "frame telemetry timings must be finite non-negative values",
            ));
        }
        let governor = self
            .runtime_quality
            .as_mut()
            .expect("runtime quality presence checked before telemetry mutation");
        let adjustment = governor.observe(timing);
        Ok(runtime_quality_observation_json(adjustment, governor.state()).to_string())
    }

    /// Fixed-shape percentile and workload diagnostics for the bounded frame window.
    pub fn frame_telemetry_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.frame_telemetry.snapshot()).map_err(js_error)
    }

    /// Non-blocking whole-frame GPU timestamp diagnostics.
    pub fn gpu_frame_timing_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.host.gpu_frame_timing_diagnostics()).map_err(js_error)
    }

    /// Starts a bounded production-pipeline calibration on the selected device.
    /// The host advances it incrementally between ordinary interaction frames.
    pub fn begin_hardware_calibration(&mut self) -> Result<String, JsValue> {
        let session = self.host.create_calibration_session().map_err(js_error)?;
        let progress = session.progress();
        self.calibration_session = Some(session);
        Ok(calibration_progress_json(progress, false).to_string())
    }

    /// Submits at most one calibration pass and returns non-blocking progress.
    pub fn step_hardware_calibration(&self) -> Result<String, JsValue> {
        let session = self.calibration_session.as_ref().ok_or_else(|| {
            JsValue::from_str("begin_hardware_calibration must be called before stepping")
        })?;
        let submitted = session
            .step(self.host.device(), self.host.queue(), self.host.renderer())
            .map_err(js_error)?;
        Ok(calibration_progress_json(session.progress(), submitted).to_string())
    }

    /// Active presentation extent in physical pixels.
    pub fn width(&self) -> u32 {
        self.host.extent()[0]
    }

    /// Active presentation extent in physical pixels.
    pub fn height(&self) -> u32 {
        self.host.extent()[1]
    }
}

#[cfg(target_arch = "wasm32")]
impl WasmViewer {
    fn current_entity_bindings(
        &self,
        entity_id: &str,
    ) -> Result<Vec<GeometryRepresentationBindingRef>, JsValue> {
        let slots = self
            .entity_slot_keys
            .get(entity_id)
            .ok_or_else(|| JsValue::from_str("canonical entity is not resident"))?;
        if slots.is_empty() {
            return Err(JsValue::from_str("canonical entity has no resident slots"));
        }
        slots
            .iter()
            .map(|storage_key| {
                self.slot_bindings
                    .get(storage_key)
                    .cloned()
                    .ok_or_else(|| JsValue::from_str("canonical entity slot has no binding"))
            })
            .collect()
    }

    fn current_canonical_entity(&self, entity_id: &str) -> Result<CanonicalEntity, JsValue> {
        let slots = self
            .entity_slot_keys
            .get(entity_id)
            .ok_or_else(|| JsValue::from_str("canonical entity is not resident"))?;
        let mut current = None;
        for storage_key in slots {
            let entity = &self
                .canonical_admissions
                .get(storage_key)
                .ok_or_else(|| JsValue::from_str("canonical entity admission is unavailable"))?
                .admission
                .entity;
            if current.as_ref().is_some_and(|existing| existing != entity) {
                return Err(JsValue::from_str(
                    "canonical entity slots contain mixed immutable revisions",
                ));
            }
            current = Some(entity.clone());
        }
        current.ok_or_else(|| JsValue::from_str("canonical entity has no current envelope"))
    }

    fn ensure_entity_command_id_available(&self, command_id: &str) -> Result<(), JsValue> {
        if command_id.trim().is_empty()
            || command_id.contains('\0')
            || self.entity_command_journal.contains(command_id)
        {
            return Err(JsValue::from_str(
                "entity command id is invalid or already journaled",
            ));
        }
        Ok(())
    }

    fn next_entity_journal_entry(
        &self,
        applied: &AppliedEntityPlacementCommand,
        kind: EntityCommandJournalKind,
        related_command_id: Option<String>,
    ) -> Result<EntityCommandJournalEntry, JsValue> {
        self.entity_command_journal
            .prepare(applied, kind, related_command_id)
            .map_err(js_error)
    }

    fn append_entity_journal_entry(&mut self, entry: EntityCommandJournalEntry) {
        self.entity_command_journal
            .append(entry)
            .expect("prepared synchronous journal entry remains appendable");
    }

    fn execute_transform_entity_command(
        &mut self,
        command: TransformEntityCommand,
        expected_bindings: Vec<GeometryRepresentationBindingRef>,
    ) -> Result<String, JsValue> {
        self.ensure_entity_command_id_available(&command.command_id)?;
        let current = self.current_canonical_entity(&command.entity_id.0)?;
        let applied = apply_transform_entity(&current, &command).map_err(js_error)?;
        let entry = self.next_entity_journal_entry(
            &applied,
            EntityCommandJournalKind::TransformEntity,
            None,
        )?;
        let publication = self.commit_entity_placement_publication(&applied, &expected_bindings)?;
        self.entity_undo_stack.push(WasmEntityPlacementHistory {
            root_command_id: applied.command_id.clone(),
            entity_id: applied.entity_id.0.clone(),
            before: applied.before.placement,
            after: applied.after.placement,
        });
        self.entity_redo_stack.clear();
        self.append_entity_journal_entry(entry.clone());
        append_command_result(publication, &applied.after, &entry)
    }

    fn commit_entity_placement_publication(
        &mut self,
        applied: &AppliedEntityPlacementCommand,
        expected_bindings: &[GeometryRepresentationBindingRef],
    ) -> Result<String, JsValue> {
        let current_bindings = self.current_entity_bindings(&applied.entity_id.0)?;
        let binding_map = |values: &[GeometryRepresentationBindingRef]| {
            values
                .iter()
                .map(|binding| {
                    canonical_slot_storage_key(&binding.key.slot).map(|key| (key, binding.clone()))
                })
                .collect::<Result<BTreeMap<_, _>, _>>()
        };
        let current_map = binding_map(&current_bindings).map_err(js_error)?;
        let expected_map = binding_map(expected_bindings).map_err(js_error)?;
        if current_map.len() != current_bindings.len()
            || expected_map.len() != expected_bindings.len()
            || current_map != expected_map
        {
            return Err(JsValue::from_str(
                "entity command bindings do not match every current canonical slot",
            ));
        }
        let bindings = current_map
            .iter()
            .map(|(storage_key, binding)| (storage_key.clone(), binding.generation))
            .collect::<BTreeMap<_, _>>();
        let slots = self
            .entity_slot_keys
            .get(&applied.entity_id.0)
            .cloned()
            .ok_or_else(|| JsValue::from_str("canonical entity slots disappeared"))?;
        let mut admissions = Vec::with_capacity(slots.len());
        for storage_key in slots {
            let mut admission = self
                .canonical_admissions
                .get(&storage_key)
                .cloned()
                .ok_or_else(|| JsValue::from_str("canonical admission is unavailable"))?;
            admission.admission.entity = applied.after.clone();
            admission.admission.expected_generation = bindings.get(&storage_key).copied();
            admissions.push(admission);
        }
        let json = serde_json::to_string(&admissions).map_err(js_error)?;
        self.publish_canonical_representations_json(&json)
    }

    fn canonical_entity_replacement_is_placement_only<'a>(
        &self,
        entity_id: &str,
        incoming: impl Iterator<Item = &'a WasmCanonicalRenderAdmission>,
    ) -> bool {
        let incoming = incoming.collect::<Vec<_>>();
        let Some(current_slots) = self.entity_slot_keys.get(entity_id) else {
            return false;
        };
        if current_slots.len() != incoming.len() {
            return false;
        }
        incoming.iter().all(|next| {
            let slot = GeometryRepresentationSlotKey {
                entity_id: next.admission.entity.id.clone(),
                representation_slot: next.admission.representation_slot.clone(),
            };
            let Ok(storage_key) = canonical_slot_storage_key(&slot) else {
                return false;
            };
            let Some(previous) = self.canonical_admissions.get(&storage_key) else {
                return false;
            };
            let mut normalized = previous.clone();
            normalized.admission.entity.revision = next.admission.entity.revision;
            normalized.admission.entity.version_hash = next.admission.entity.version_hash.clone();
            normalized.admission.entity.placement = next.admission.entity.placement;
            normalized.admission.expected_generation = next.admission.expected_generation;
            normalized == **next
        })
    }

    fn prepare_retained_stream_translations(
        &self,
        placement_only_entities: &BTreeSet<String>,
        prepared_slots: &[WasmPreparedCanonicalSlot],
    ) -> Result<
        (
            Vec<WasmRetainedStreamTranslation>,
            Vec<(RenderProxyId, BoundingVolume)>,
            BTreeSet<String>,
        ),
        String,
    > {
        let next_slots = prepared_slots
            .iter()
            .map(|slot| (slot.storage_key.as_str(), slot))
            .collect::<BTreeMap<_, _>>();
        let mut retained = Vec::new();
        let mut bounds_updates = Vec::new();
        let mut retained_entities = BTreeSet::new();
        for entity_id in placement_only_entities {
            let Some(entity_slots) = self.entity_slot_keys.get(entity_id) else {
                continue;
            };
            let stream_ids = entity_slots
                .iter()
                .filter_map(|storage_key| self.slot_streams.get(storage_key))
                .flatten()
                .cloned()
                .collect::<BTreeSet<_>>();
            if stream_ids.is_empty() {
                continue;
            }
            let mut entity_updates = Vec::new();
            let mut entity_bounds = Vec::new();
            let mut retain_entity = true;
            for stream_id in stream_ids {
                let Some(storage_key) = self.stream_slots.get(&stream_id).cloned() else {
                    retain_entity = false;
                    break;
                };
                let Some(next) = next_slots.get(storage_key.as_str()) else {
                    retain_entity = false;
                    break;
                };
                let source_to_project =
                    WorldTransform(next.request.placement.unwrap_or(Transform3d::IDENTITY).0);
                let Some((old_transform, source_bounds, proxy_ids)) =
                    self.resident_stream_placement_contract(&stream_id)
                else {
                    retain_entity = false;
                    break;
                };
                let Some(translation) = project_translation_delta(old_transform, source_to_project)
                else {
                    retain_entity = false;
                    break;
                };
                let next_bounds = placed_stream_bounds(&source_bounds, source_to_project)?;
                for proxy_id in proxy_ids {
                    let batches = self.batches.get(&proxy_id).ok_or_else(|| {
                        format!("resident stream proxy {} has no batches", proxy_id.0)
                    })?;
                    for batch in batches {
                        let origin = batch.batch_origin().ok_or_else(|| {
                            format!("resident stream proxy {} has no stable origin", proxy_id.0)
                        })?;
                        batch
                            .validate_world_origins(
                                add_world(origin, translation),
                                self.floating_origin,
                            )
                            .map_err(|error| error.to_string())?;
                    }
                    entity_bounds.push((proxy_id, next_bounds.clone()));
                }
                entity_updates.push(WasmRetainedStreamTranslation {
                    stream_id,
                    storage_key,
                    translation,
                    source_to_project,
                });
            }
            if retain_entity {
                retained_entities.insert(entity_id.clone());
                retained.extend(entity_updates);
                bounds_updates.extend(entity_bounds);
            }
        }
        Ok((retained, bounds_updates, retained_entities))
    }

    fn resident_stream_placement_contract(
        &self,
        stream_id: &str,
    ) -> Option<(WorldTransform, BoundingVolume, Vec<RenderProxyId>)> {
        if let Some(request) = self.streamed_requests.get(stream_id) {
            return Some((
                request.metadata.source_to_project,
                request.metadata.bounds.clone(),
                streamed_proxy_ids(request),
            ));
        }
        if let Some(request) = self.potree_requests.get(stream_id) {
            return Some((
                request.metadata.source_to_project,
                request.metadata.bounds.clone(),
                vec![RenderProxyId(request.metadata.proxy_id.clone())],
            ));
        }
        if let Some(request) = self.splat_requests.get(stream_id) {
            return Some((
                request.metadata.source_to_project,
                request.metadata.bounds.clone(),
                vec![RenderProxyId(request.metadata.proxy_id.clone())],
            ));
        }
        self.raster_requests.get(stream_id).map(|request| {
            (
                request.metadata.source_to_project,
                request.metadata.bounds.clone(),
                vec![RenderProxyId(request.metadata.proxy_id.clone())],
            )
        })
    }

    fn commit_retained_stream_translation(
        &mut self,
        retained: &WasmRetainedStreamTranslation,
    ) -> Result<(), String> {
        let binding = self
            .slot_bindings
            .get(&retained.storage_key)
            .cloned()
            .ok_or_else(|| "retained stream canonical binding is missing".to_owned())?;
        let proxy_ids = if let Some(request) = self.streamed_requests.get_mut(&retained.stream_id) {
            request.metadata.binding = binding;
            request.metadata.source_to_project = retained.source_to_project;
            streamed_proxy_ids(request)
        } else if let Some(request) = self.potree_requests.get_mut(&retained.stream_id) {
            request.metadata.binding = binding;
            request.metadata.source_to_project = retained.source_to_project;
            vec![RenderProxyId(request.metadata.proxy_id.clone())]
        } else if let Some(request) = self.splat_requests.get_mut(&retained.stream_id) {
            request.metadata.binding = binding;
            request.metadata.source_to_project = retained.source_to_project;
            vec![RenderProxyId(request.metadata.proxy_id.clone())]
        } else if let Some(request) = self.raster_requests.get_mut(&retained.stream_id) {
            request.metadata.binding = binding;
            request.metadata.source_to_project = retained.source_to_project;
            vec![RenderProxyId(request.metadata.proxy_id.clone())]
        } else {
            return Err("retained stream disappeared after transaction preparation".to_owned());
        };
        for proxy_id in proxy_ids {
            self.stream_proxy_transforms
                .insert(proxy_id.0.clone(), retained.source_to_project);
            for batch in self
                .batches
                .get_mut(&proxy_id)
                .ok_or_else(|| format!("retained stream proxy {} disappeared", proxy_id.0))?
            {
                let origin = batch
                    .batch_origin()
                    .ok_or_else(|| "retained stream batch lost its origin".to_owned())?;
                batch
                    .set_world_origins(
                        self.host.queue(),
                        add_world(origin, retained.translation),
                        self.floating_origin,
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_lines)]
    fn replace_alignment_preview_partitions(
        &mut self,
        preview_id: &str,
        partitions: &[Arc<AlignmentPreviewPartition>],
        replace_existing: bool,
    ) -> Result<(), String> {
        let proxy_ids = partition_proxy_ids(preview_id, partitions);
        let removals = replace_existing
            .then(|| {
                proxy_ids
                    .iter()
                    .cloned()
                    .map(RenderProxyId)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut overlay = self
            .render_world
            .prepare_overlay(removals.iter().cloned())
            .map_err(|error| error.to_string())?;
        let mut staged_batches = BTreeMap::new();
        let mut staged_pick_indices = BTreeMap::new();

        for partition in partitions {
            for part in &partition.road_body {
                let proxy_id = render_proxy_id(preview_id, partition.index, "road-body", &part.id);
                let request = alignment_preview_render_request(
                    preview_id,
                    proxy_id,
                    &partition.identity,
                    part.mesh.clone(),
                );
                compile_inline_entity(
                    &self.host,
                    overlay.staging_world_mut(),
                    &mut staged_batches,
                    &request,
                    self.floating_origin,
                    &self.glyph_atlases,
                    &self.annotation_styles,
                    &self.entity_requests,
                    &self.block_definitions,
                    &self.block_member_styles,
                    &self.block_attribute_tables,
                    &self.block_member_entity_versions,
                    &self.image_resources,
                    &self.depth_resources,
                    &self.raster_binary_resources,
                    &self.mesh_resources,
                    &self.material_resources,
                    &self.hatch_resources,
                    &self.line_type_resources,
                )?;
                collect_inline_mesh_pick_indices(
                    &request,
                    &self.entity_requests,
                    &self.block_definitions,
                    &self.block_member_styles,
                    &self.block_member_entity_versions,
                    &self.mesh_resources,
                    &mut staged_pick_indices,
                )?;
            }
            for part in &partition.slopes {
                let proxy_id = render_proxy_id(preview_id, partition.index, "slope", &part.rule_id);
                let request = alignment_preview_render_request(
                    preview_id,
                    proxy_id,
                    &partition.identity,
                    part.mesh.clone(),
                );
                compile_inline_entity(
                    &self.host,
                    overlay.staging_world_mut(),
                    &mut staged_batches,
                    &request,
                    self.floating_origin,
                    &self.glyph_atlases,
                    &self.annotation_styles,
                    &self.entity_requests,
                    &self.block_definitions,
                    &self.block_member_styles,
                    &self.block_attribute_tables,
                    &self.block_member_entity_versions,
                    &self.image_resources,
                    &self.depth_resources,
                    &self.raster_binary_resources,
                    &self.mesh_resources,
                    &self.material_resources,
                    &self.hatch_resources,
                    &self.line_type_resources,
                )?;
                collect_inline_mesh_pick_indices(
                    &request,
                    &self.entity_requests,
                    &self.block_definitions,
                    &self.block_member_styles,
                    &self.block_member_entity_versions,
                    &self.mesh_resources,
                    &mut staged_pick_indices,
                )?;
            }
        }

        self.render_world
            .commit_overlay(overlay)
            .map_err(|error| error.to_string())?;
        for id in removals {
            self.batches.remove(&id);
            self.mesh_pick_indices.remove(&id.0);
        }
        self.batches.extend(staged_batches);
        self.mesh_pick_indices.extend(staged_pick_indices);
        Ok(())
    }

    fn remove_alignment_preview_batches(&mut self, proxy_ids: &[String]) -> Result<(), String> {
        let removals = proxy_ids
            .iter()
            .cloned()
            .map(RenderProxyId)
            .collect::<Vec<_>>();
        let overlay = self
            .render_world
            .prepare_overlay(removals.iter().cloned())
            .map_err(|error| error.to_string())?;
        self.render_world
            .commit_overlay(overlay)
            .map_err(|error| error.to_string())?;
        for id in removals {
            self.batches.remove(&id);
            self.mesh_pick_indices.remove(&id.0);
        }
        Ok(())
    }

    fn prepare_staged_gpu_textures(
        &mut self,
        owner: &str,
        content: &DecodedThreeDTilesContent,
    ) -> Result<WasmPreparedGpuTextures, String> {
        let mut transaction_resources = BTreeMap::new();
        let mut prepared = WasmPreparedGpuTextures::default();
        let mut stage_resources = Vec::new();
        let mut decoded_sources = 0_u64;
        let mut factory_calls = 0_u64;
        let result = prepare_content_gpu_textures(
            self.host.device(),
            self.host.queue(),
            self.host.renderer(),
            owner,
            content,
            &self.gpu_texture_cache,
            &self.gpu_texture_source_identities,
            &mut transaction_resources,
            &mut prepared,
            &mut stage_resources,
            &mut decoded_sources,
            &mut factory_calls,
        );
        self.gpu_texture_decode_count = self
            .gpu_texture_decode_count
            .saturating_add(decoded_sources);
        self.gpu_texture_factory_count =
            self.gpu_texture_factory_count.saturating_add(factory_calls);
        result?;
        let stage =
            GpuTextureResourceStage::prepare(stage_resources).map_err(|error| error.to_string())?;
        self.gpu_texture_cache
            .stage_owner(owner.to_owned(), stage)
            .map_err(|error| error.to_string())?;
        self.gpu_texture_source_identities.extend(
            prepared
                .bindings
                .iter()
                .map(|(key, identity)| (*key, *identity)),
        );
        Ok(prepared)
    }

    fn sync_external_asset_cache_cost(&mut self) {
        let texture_stats = self.gpu_texture_cache.stats();
        self.streaming.set_shared_resource_cost(ResourceCost {
            cpu_compressed_bytes: self.external_asset_cache.resident_bytes(),
            gpu_buffer_bytes: self.gpu_model_cache.resident_bytes.saturating_add(
                self.raster_analysis_view
                    .as_ref()
                    .map_or(0, |analysis| analysis.cost.gpu_buffer_bytes),
            ),
            gpu_texture_bytes: texture_stats.resident_bytes,
            ..ResourceCost::default()
        });
    }

    fn take_staged_content(&mut self, stream_id: &str) -> Result<WasmStagedContent, JsValue> {
        if let Some(staged) = self.staged_three_d_tiles.remove(stream_id) {
            return Ok(WasmStagedContent::ThreeDTiles(staged));
        }
        if let Some(staged) = self.staged_potree.remove(stream_id) {
            return Ok(WasmStagedContent::Potree(staged));
        }
        if let Some(staged) = self.staged_splats.remove(stream_id) {
            return Ok(WasmStagedContent::GaussianSplats(staged));
        }
        if let Some(staged) = self.staged_rasters.remove(stream_id) {
            return Ok(WasmStagedContent::Raster(staged));
        }
        Err(JsValue::from_str("staging record is unknown"))
    }

    fn restore_staged_contents(&mut self, staged: Vec<WasmStagedContent>) {
        for record in staged {
            match record {
                WasmStagedContent::ThreeDTiles(staged) => {
                    self.staged_three_d_tiles
                        .insert(staged.request.metadata.stream_id.clone(), staged);
                }
                WasmStagedContent::Potree(staged) => {
                    self.staged_potree
                        .insert(staged.request.metadata.stream_id.clone(), staged);
                }
                WasmStagedContent::GaussianSplats(staged) => {
                    self.staged_splats
                        .insert(staged.request.metadata.stream_id.clone(), staged);
                }
                WasmStagedContent::Raster(staged) => {
                    self.staged_rasters
                        .insert(staged.request.metadata.stream_id.clone(), staged);
                }
            }
        }
    }

    #[allow(clippy::too_many_lines)]
    fn publish_staged_contents(
        &mut self,
        staged: Vec<WasmStagedContent>,
    ) -> Result<(ResourceCost, u64), (String, Vec<WasmStagedContent>)> {
        for record in &staged {
            if let Err(error) = self.validate_staged_content_binding(record) {
                return Err((error, staged));
            }
        }
        let affected_preview_entity_ids = staged
            .iter()
            .map(|record| match record {
                WasmStagedContent::ThreeDTiles(staged) => &staged.request.metadata.entity_id,
                WasmStagedContent::Potree(staged) => &staged.request.metadata.entity_id,
                WasmStagedContent::GaussianSplats(staged) => &staged.request.metadata.entity_id,
                WasmStagedContent::Raster(staged) => &staged.request.metadata.entity_id,
            })
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let mut prepared_gpu_models = BTreeMap::new();
        let mut prepared_gpu_textures = BTreeMap::new();
        let mut gpu_prepare_error = None;
        for record in &staged {
            if let WasmStagedContent::ThreeDTiles(three_d) = record {
                let stream_id = &three_d.request.metadata.stream_id;
                match self.gpu_model_cache.prepare_staged(
                    stream_id,
                    self.host.device(),
                    self.host.queue(),
                    &three_d.decoded,
                ) {
                    Ok(models) => {
                        match self.prepare_staged_gpu_textures(stream_id, &three_d.decoded) {
                            Ok(textures) => {
                                prepared_gpu_models.insert(stream_id.clone(), models);
                                prepared_gpu_textures.insert(stream_id.clone(), textures);
                            }
                            Err(error) => {
                                self.gpu_model_cache.release_staged(stream_id);
                                gpu_prepare_error = Some(error);
                                break;
                            }
                        }
                    }
                    Err(error) => {
                        gpu_prepare_error = Some(error);
                        break;
                    }
                }
            }
        }
        if let Some(error) = gpu_prepare_error {
            for stream_id in prepared_gpu_models.keys() {
                self.gpu_model_cache.release_staged(stream_id);
                self.gpu_texture_cache.release_staged(stream_id);
            }
            return Err((error, staged));
        }
        let shared_upload_bytes = self
            .gpu_model_cache
            .staged_upload_bytes(prepared_gpu_models.keys().map(String::as_str))
            .saturating_add(
                self.gpu_texture_cache
                    .staged_resident_bytes(prepared_gpu_textures.keys().map(String::as_str)),
            );
        let prepared = (|| -> Result<_, String> {
            let mut next_batches = BTreeMap::new();
            let mut next_mesh_pick_indices = BTreeMap::new();
            let mut next_feature_catalogs = BTreeMap::new();
            let mut removed_batch_ids = std::collections::BTreeSet::new();
            let mut total_cost = ResourceCost::default();
            let mut affected_raster_entity_ids = std::collections::BTreeSet::new();

            for record in &staged {
                let stream_id = record.stream_id();
                if let Some(request) = self.raster_requests.get(stream_id) {
                    affected_raster_entity_ids.insert(request.metadata.entity_id.clone());
                }
                let mut old_ids = self
                    .streamed_requests
                    .get(stream_id)
                    .map(streamed_proxy_ids)
                    .unwrap_or_default();
                old_ids.extend(
                    self.potree_requests
                        .get(stream_id)
                        .map(|request| RenderProxyId(request.metadata.proxy_id.clone())),
                );
                old_ids.extend(
                    self.splat_requests
                        .get(stream_id)
                        .map(|request| RenderProxyId(request.metadata.proxy_id.clone())),
                );
                old_ids.extend(
                    self.raster_requests
                        .get(stream_id)
                        .map(|request| RenderProxyId(request.metadata.proxy_id.clone())),
                );
                for id in old_ids {
                    removed_batch_ids.insert(id);
                }
            }

            let affected_raster_entity_ids =
                affected_raster_entity_ids.into_iter().collect::<Vec<_>>();
            let dependent_entities = transitive_dependent_entities(
                &self.entity_requests,
                &self.entity_dependents,
                &affected_raster_entity_ids,
            );
            for dependent in &dependent_entities {
                removed_batch_ids.extend(entity_proxy_ids(
                    dependent,
                    &self.entity_requests,
                    &self.block_definitions,
                    &self.block_member_styles,
                    &self.block_member_entity_versions,
                )?);
            }
            let mut overlay = self
                .render_world
                .prepare_overlay(removed_batch_ids.iter().cloned())
                .map_err(|error| error.to_string())?;
            let next_world = overlay.staging_world_mut();

            for record in &staged {
                match record {
                    WasmStagedContent::ThreeDTiles(staged) => {
                        let mut mesh_pick_indices = BTreeMap::new();
                        let mut feature_catalogs = BTreeMap::new();
                        compile_decoded_streamed_content(
                            &self.host,
                            next_world,
                            &mut next_batches,
                            &mut mesh_pick_indices,
                            &mut feature_catalogs,
                            &staged.request,
                            &staged.decoded,
                            prepared_gpu_models
                                .get(&staged.request.metadata.stream_id)
                                .expect("3D Tiles GPU models were prepared"),
                            &prepared_gpu_textures
                                .get(&staged.request.metadata.stream_id)
                                .expect("3D Tiles GPU textures were prepared")
                                .resources,
                            self.floating_origin,
                            &self.image_resources,
                            &self.hatch_resources,
                            &self.line_type_resources,
                        )?;
                        add_mesh_pick_costs(next_world, &mesh_pick_indices)?;
                        add_gltf_feature_costs(next_world, &feature_catalogs)?;
                        let mut cost = three_d_tiles_cost(
                            &staged.request,
                            &staged.decoded,
                            false,
                            self.host.renderer().transparency_strategy()
                                == himmelcad_render::TransparencyStrategy::SortedAlpha,
                        );
                        cost.cpu_decoded_bytes = cost
                            .cpu_decoded_bytes
                            .saturating_add(mesh_pick_resident_bytes(&mesh_pick_indices))
                            .saturating_add(gltf_feature_resident_bytes(&feature_catalogs));
                        total_cost = total_cost.saturating_add(cost);
                        next_mesh_pick_indices.extend(mesh_pick_indices);
                        next_feature_catalogs.extend(feature_catalogs);
                    }
                    WasmStagedContent::Potree(staged) => {
                        compile_decoded_potree_content(
                            &self.host,
                            next_world,
                            &mut next_batches,
                            &staged.request,
                            &staged.decoded,
                            self.floating_origin,
                        )?;
                        total_cost = total_cost.saturating_add(potree_cost(&staged.request, false));
                    }
                    WasmStagedContent::GaussianSplats(staged) => {
                        let pick_bytes = staged.pick_index.resident_bytes();
                        compile_decoded_splat_content(
                            &self.host,
                            next_world,
                            &mut next_batches,
                            &staged.request,
                            &staged.decoded,
                            pick_bytes,
                            self.floating_origin,
                        )?;
                        total_cost = total_cost.saturating_add(splat_cost(
                            &staged.request,
                            staged.decoded.splats.len(),
                            pick_bytes,
                            false,
                            self.host.renderer().transparency_strategy()
                                == himmelcad_render::TransparencyStrategy::SortedAlpha,
                        ));
                    }
                    WasmStagedContent::Raster(staged) => {
                        let pick_bytes = staged.pick_index.resident_bytes();
                        compile_decoded_raster_content(
                            &self.host,
                            next_world,
                            &mut next_batches,
                            &staged.request,
                            &staged.decoded,
                            self.floating_origin,
                            pick_bytes,
                            &self.image_resources,
                            &self.hatch_resources,
                            &self.line_type_resources,
                        )?;

                        total_cost = total_cost.saturating_add(raster_cost(
                            &staged.request,
                            &staged.decoded,
                            pick_bytes,
                            false,
                        ));
                    }
                }
            }

            for dependent in dependent_entities {
                compile_inline_entity(
                    &self.host,
                    next_world,
                    &mut next_batches,
                    &dependent,
                    self.floating_origin,
                    &self.glyph_atlases,
                    &self.annotation_styles,
                    &self.entity_requests,
                    &self.block_definitions,
                    &self.block_member_styles,
                    &self.block_attribute_tables,
                    &self.block_member_entity_versions,
                    &self.image_resources,
                    &self.depth_resources,
                    &self.raster_binary_resources,
                    &self.mesh_resources,
                    &self.material_resources,
                    &self.hatch_resources,
                    &self.line_type_resources,
                )?;
                let mut mesh_pick_indices = BTreeMap::new();
                collect_inline_mesh_pick_indices(
                    &dependent,
                    &self.entity_requests,
                    &self.block_definitions,
                    &self.block_member_styles,
                    &self.block_member_entity_versions,
                    &self.mesh_resources,
                    &mut mesh_pick_indices,
                )?;
                add_mesh_pick_costs(next_world, &mesh_pick_indices)?;
                next_mesh_pick_indices.extend(mesh_pick_indices);
            }
            Ok((
                overlay,
                next_batches,
                next_mesh_pick_indices,
                next_feature_catalogs,
                removed_batch_ids,
                total_cost,
            ))
        })();

        let (
            overlay,
            next_batches,
            next_mesh_pick_indices,
            next_feature_catalogs,
            removed_batch_ids,
            total_cost,
        ) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                for stream_id in prepared_gpu_models.keys() {
                    self.gpu_model_cache.release_staged(stream_id);
                    self.gpu_texture_cache.release_staged(stream_id);
                }
                return Err((error, staged));
            }
        };
        if let Err(error) = self.render_world.commit_overlay(overlay) {
            for stream_id in prepared_gpu_models.keys() {
                self.gpu_model_cache.release_staged(stream_id);
                self.gpu_texture_cache.release_staged(stream_id);
            }
            return Err((error.to_string(), staged));
        }

        for record in &staged {
            self.external_asset_cache.evict(record.stream_id());
            if !matches!(record, WasmStagedContent::ThreeDTiles(_)) {
                self.gpu_model_cache.evict(record.stream_id());
                self.gpu_model_cache.release_staged(record.stream_id());
                self.gpu_texture_cache.evict(record.stream_id());
                self.gpu_texture_cache.release_staged(record.stream_id());
            }
        }
        for record in &staged {
            if let WasmStagedContent::ThreeDTiles(staged) = record {
                self.external_asset_cache.commit(
                    staged.request.metadata.stream_id.clone(),
                    &staged.request.resources,
                );
                self.gpu_model_cache
                    .commit_staged(&staged.request.metadata.stream_id);
                self.gpu_texture_cache
                    .commit_staged(&staged.request.metadata.stream_id);
            }
        }
        self.sync_external_asset_cache_cost();

        for id in &removed_batch_ids {
            self.batches.remove(id);
            self.mesh_pick_indices.remove(&id.0);
            self.gltf_feature_catalogs.remove(&id.0);
            self.stream_proxy_transforms.remove(&id.0);
        }
        self.batches.extend(next_batches);
        self.mesh_pick_indices.extend(next_mesh_pick_indices);
        self.gltf_feature_catalogs.extend(next_feature_catalogs);

        for record in staged {
            let stream_id = record.stream_id().to_owned();
            self.streamed_requests.remove(&stream_id);
            if let Some(old) = self.potree_requests.remove(&stream_id) {
                self.potree_proxy_streams.remove(&old.metadata.proxy_id);
            }
            if let Some(old) = self.splat_requests.remove(&stream_id) {
                self.splat_proxy_streams.remove(&old.metadata.proxy_id);
            }
            self.splat_pick_indices.remove(&stream_id);
            if let Some(old) = self.raster_requests.remove(&stream_id) {
                self.raster_proxy_streams.remove(&old.metadata.proxy_id);
            }
            self.raster_pick_indices.remove(&stream_id);
            match record {
                WasmStagedContent::ThreeDTiles(mut staged) => {
                    staged.request.gpu_texture_bindings = prepared_gpu_textures
                        .get(&staged.request.metadata.stream_id)
                        .expect("committed 3D Tiles GPU textures were prepared")
                        .bindings
                        .clone();
                    let transform = staged.request.metadata.source_to_project;
                    for proxy_id in streamed_proxy_ids(&staged.request) {
                        self.stream_proxy_transforms.insert(proxy_id.0, transform);
                    }
                    self.streamed_requests
                        .insert(staged.request.metadata.stream_id.clone(), staged.request);
                }
                WasmStagedContent::Potree(mut staged) => {
                    let stream_id = staged.request.metadata.stream_id.clone();
                    if staged
                        .request
                        .layout
                        .encoding
                        .eq_ignore_ascii_case("BROTLI")
                    {
                        staged.request.decoded = Some(staged.decoded);
                    }
                    self.potree_requests
                        .insert(stream_id.clone(), staged.request);
                    let proxy_id = self.potree_requests[&stream_id].metadata.proxy_id.clone();
                    let transform = self.potree_requests[&stream_id].metadata.source_to_project;
                    self.stream_proxy_transforms
                        .insert(proxy_id.clone(), transform);
                    self.potree_proxy_streams.insert(proxy_id, stream_id);
                }
                WasmStagedContent::GaussianSplats(staged) => {
                    let stream_id = staged.request.metadata.stream_id.clone();
                    self.splat_requests
                        .insert(stream_id.clone(), staged.request);
                    let proxy_id = self.splat_requests[&stream_id].metadata.proxy_id.clone();
                    let transform = self.splat_requests[&stream_id].metadata.source_to_project;
                    self.stream_proxy_transforms
                        .insert(proxy_id.clone(), transform);
                    self.splat_proxy_streams.insert(proxy_id, stream_id.clone());
                    self.splat_pick_indices.insert(stream_id, staged.pick_index);
                }
                WasmStagedContent::Raster(staged) => {
                    let stream_id = staged.request.metadata.stream_id.clone();
                    self.raster_requests
                        .insert(stream_id.clone(), staged.request);
                    let proxy_id = self.raster_requests[&stream_id].metadata.proxy_id.clone();
                    let transform = self.raster_requests[&stream_id].metadata.source_to_project;
                    self.stream_proxy_transforms
                        .insert(proxy_id.clone(), transform);
                    self.raster_proxy_streams
                        .insert(proxy_id, stream_id.clone());
                    self.raster_pick_indices
                        .insert(stream_id, staged.pick_index);
                }
            }
        }
        for entity_id in affected_preview_entity_ids {
            self.rebuild_or_discard_move_previews_for_entity(&entity_id);
        }
        Ok((total_cost, shared_upload_bytes))
    }

    fn rebuild_move_previews_for_entity(
        &mut self,
        entity_filter: Option<&str>,
        floating_origin: WorldVec3,
    ) -> Result<(), JsValue> {
        let preview_ids = if let Some(entity_id) = entity_filter {
            self.entity_move_previews
                .get(entity_id)
                .into_iter()
                .flatten()
                .cloned()
                .collect::<Vec<_>>()
        } else {
            self.move_previews.keys().cloned().collect::<Vec<_>>()
        };
        for preview_id in preview_ids {
            let preview = self
                .move_previews
                .get(&preview_id)
                .expect("collected move preview exists");
            let entity_id = preview.entity_id.clone();
            let opacity_multiplier = preview.opacity_multiplier;
            let translation = preview.translation;
            let target_render_tiles = preview.target_render_tiles.clone();
            let (mut style, exaggeration_datum) = self
                .entity_styles
                .get(&entity_id)
                .cloned()
                .unwrap_or_else(|| (preview.style.clone(), preview.exaggeration_datum));
            style.opacity *= opacity_multiplier;
            let batches = build_move_preview_batches(
                &self.host,
                &self.render_world,
                &self.batches,
                &entity_id,
                &style,
                exaggeration_datum,
                translation,
                floating_origin,
                &target_render_tiles,
                &self.image_resources,
                &self.hatch_resources,
                &self.line_type_resources,
            )
            .map_err(js_error)?;
            let preview = self
                .move_previews
                .get_mut(&preview_id)
                .expect("collected move preview exists");
            preview.style = style;
            preview.exaggeration_datum = exaggeration_datum;
            preview.batches = batches;
        }
        Ok(())
    }

    fn discard_move_previews_for_entity(&mut self, entity_id: &str) {
        if let Some(preview_ids) = self.entity_move_previews.remove(entity_id) {
            for preview_id in preview_ids {
                self.move_previews.remove(&preview_id);
            }
        }
    }

    fn rebuild_or_discard_move_previews_for_entity(&mut self, entity_id: &str) {
        if self
            .rebuild_move_previews_for_entity(Some(entity_id), self.floating_origin)
            .is_err()
        {
            self.discard_move_previews_for_entity(entity_id);
        }
    }

    fn dataset_registered(&self, dataset_id: &str) -> bool {
        self.explicit_tilesets.contains_key(dataset_id)
            || self.implicit_tilesets.contains_key(dataset_id)
            || self.potree_datasets.contains_key(dataset_id)
            || self.prepared_datasets.contains_key(dataset_id)
    }

    fn resolve_canonical_stream_binding(
        &self,
        slot: &GeometryRepresentationSlotKey,
        binding: &GeometryRepresentationBindingRef,
        dataset_id: &str,
        tile_id: &str,
        stream_id: &str,
    ) -> Result<(String, String, RenderStyle, f64, WorldTransform), JsValue> {
        if &binding.key.slot != slot {
            return Err(JsValue::from_str(
                "stream metadata slot and binding reference differ",
            ));
        }
        let storage_key = canonical_slot_storage_key(slot).map_err(js_error)?;
        if self.slot_bindings.get(&storage_key) != Some(binding) {
            return Err(JsValue::from_str(
                "stream completion binding is stale or not resident",
            ));
        }
        let Some((current_key, current_generation)) = self
            .representation_registry
            .current_key(&slot.entity_id.0, &slot.representation_slot)
        else {
            return Err(JsValue::from_str(
                "stream completion targets a retired canonical slot",
            ));
        };
        if current_key != &binding.key || current_generation != binding.generation {
            return Err(JsValue::from_str("stream completion generation is stale"));
        }
        if self.slot_dataset_ids.get(&storage_key).map(String::as_str) != Some(dataset_id)
            || self.dataset_slot_keys.get(dataset_id) != Some(&storage_key)
        {
            return Err(JsValue::from_str(
                "stream completion dataset is not bound to the canonical slot",
            ));
        }
        let request = self
            .slot_requests
            .get(&storage_key)
            .ok_or_else(|| JsValue::from_str("canonical slot presentation is missing"))?;
        let source_to_project =
            WorldTransform(request.placement.unwrap_or(Transform3d::IDENTITY).0);
        if !source_to_project.is_invertible_affine() {
            return Err(JsValue::from_str(
                "canonical streamed entity placement must be a finite invertible affine transform",
            ));
        }
        let encoded =
            serde_json::to_vec(&(slot, dataset_id, tile_id, stream_id)).map_err(js_error)?;
        Ok((
            slot.entity_id.0.clone(),
            format!(
                "{}-tile-{}",
                request.proxy_id,
                ObjectHash::of_bytes(&encoded).0
            ),
            request.style.clone(),
            request.exaggeration_datum,
            source_to_project,
        ))
    }

    fn validate_staged_content_binding(&self, staged: &WasmStagedContent) -> Result<(), String> {
        let result = match staged {
            WasmStagedContent::ThreeDTiles(staged) => {
                let metadata = &staged.request.metadata;
                self.resolve_canonical_stream_binding(
                    &metadata.slot,
                    &metadata.binding,
                    &metadata.dataset_id,
                    &metadata.tile_id,
                    &metadata.stream_id,
                )
            }
            WasmStagedContent::Potree(staged) => {
                let metadata = &staged.request.metadata;
                self.resolve_canonical_stream_binding(
                    &metadata.slot,
                    &metadata.binding,
                    &metadata.dataset_id,
                    &metadata.tile_id,
                    &metadata.stream_id,
                )
            }
            WasmStagedContent::GaussianSplats(staged) => {
                let metadata = &staged.request.metadata;
                self.resolve_canonical_stream_binding(
                    &metadata.slot,
                    &metadata.binding,
                    &metadata.dataset_id,
                    &metadata.tile_id,
                    &metadata.stream_id,
                )
            }
            WasmStagedContent::Raster(staged) => {
                let metadata = &staged.request.metadata;
                self.resolve_canonical_stream_binding(
                    &metadata.slot,
                    &metadata.binding,
                    &metadata.dataset_id,
                    &metadata.tile_id,
                    &metadata.stream_id,
                )
            }
        };
        result.map(|_| ()).map_err(|error| {
            error
                .as_string()
                .unwrap_or_else(|| "stream completion binding validation failed".to_owned())
        })
    }

    fn prepare_evaluated_mesh_admission(
        &self,
        admission: &WasmCanonicalRenderAdmission,
    ) -> Result<Option<EvaluatedMeshRepresentation>, JsValue> {
        let Some(evaluated) = &admission.evaluated_mesh else {
            return Ok(None);
        };
        if evaluated.dataset_id != admission.dataset_id {
            return Err(JsValue::from_str(
                "evaluated mesh dataset identity must match the canonical dataset binding",
            ));
        }
        if let Some(mesh) = self.mesh_resources.get(&evaluated.mesh_resource_ref.0) {
            if mesh.closed_manifold != evaluated.closed_manifold {
                return Err(JsValue::from_str(
                    "evaluated mesh payload and manifest disagree on closed/open topology",
                ));
            }
        } else {
            let resource_hash = geometry_dataset_contract(&admission.admission.resolved_geometry)
                .filter(|_| stream_provider_geometry(&admission.admission.resolved_geometry))
                .map(|(_, object_hash)| object_hash)
                .ok_or_else(|| {
                    JsValue::from_str("evaluated mesh resource is not registered or streamed")
                })?;
            if resource_hash != &evaluated.mesh_resource_ref {
                return Err(JsValue::from_str(
                    "evaluated mesh resource does not match the streamed geometry manifest",
                ));
            }
        }
        EvaluatedMeshRepresentation::new(
            admission.admission.selected.geometry_ref.clone(),
            evaluated.mesh_resource_ref.clone(),
            EvaluatedMeshRecipe {
                provider_id: evaluated.provider_id.clone(),
                provider_version: evaluated.provider_version.clone(),
                parameters_ref: evaluated.parameters_ref.clone(),
            },
            SectionTopologySnapshotKey {
                entity_id: admission.admission.entity.id.0.clone(),
                dataset_id: evaluated.dataset_id.clone(),
                version_hash: admission.admission.entity.version_hash.0.clone(),
            },
            evaluated.parts.clone(),
            evaluated.material_keys.clone(),
            evaluated.closed_manifold,
        )
        .map(Some)
        .map_err(js_error)
    }

    fn ensure_new_dataset(&self, dataset_id: &str) -> Result<(), JsValue> {
        if dataset_id.is_empty() {
            return Err(JsValue::from_str("datasetId must be non-empty"));
        }
        if self.dataset_registered(dataset_id) {
            return Err(JsValue::from_str("datasetId is already registered"));
        }
        Ok(())
    }

    fn select_registered_datasets(
        &mut self,
        view: TileSelectionView,
    ) -> Result<(Vec<TileSelection>, BTreeMap<String, Vec<TileSelection>>), String> {
        let residency = self.streaming.residency();
        let transforms = self.dataset_render_transforms()?;
        let preview_transforms = self.dataset_move_preview_transforms(&transforms)?;
        let clip_volumes = self
            .render_world
            .active_clip_volumes()
            .cloned()
            .collect::<Vec<_>>();
        let mut selections = Vec::with_capacity(
            self.explicit_tilesets.len()
                + self.implicit_tilesets.len()
                + self.potree_datasets.len()
                + self.prepared_datasets.len(),
        );
        let mut preview_selections = BTreeMap::<String, Vec<TileSelection>>::new();
        // Metadata-only hierarchies can exist without a visible canonical
        // entity. They have no mutable presentation and therefore use identity.
        for source in self.explicit_tilesets.values_mut() {
            let dataset_id = source.dataset_id().clone();
            let (source_to_project, presentation) = transforms
                .get(&dataset_id)
                .copied()
                .unwrap_or((WorldTransform::IDENTITY, PresentationTransform::IDENTITY));
            selections.push(
                TileSelector::select_with_clips_and_transforms(
                    source,
                    view,
                    &clip_volumes,
                    source_to_project,
                    presentation,
                    |key| residency.residency(key),
                )
                .map_err(|error| error.to_string())?,
            );
            for (preview_id, source_to_project) in
                preview_transforms.get(&dataset_id).into_iter().flatten()
            {
                preview_selections
                    .entry(preview_id.clone())
                    .or_default()
                    .push(
                        TileSelector::select_with_clips_and_transforms(
                            source,
                            view,
                            &clip_volumes,
                            *source_to_project,
                            presentation,
                            |key| residency.residency(key),
                        )
                        .map_err(|error| error.to_string())?,
                    );
            }
        }
        for source in self.implicit_tilesets.values_mut() {
            let dataset_id = source.dataset_id().clone();
            let (source_to_project, presentation) = transforms
                .get(&dataset_id)
                .copied()
                .unwrap_or((WorldTransform::IDENTITY, PresentationTransform::IDENTITY));
            selections.push(
                TileSelector::select_with_clips_and_transforms(
                    source,
                    view,
                    &clip_volumes,
                    source_to_project,
                    presentation,
                    |key| residency.residency(key),
                )
                .map_err(|error| error.to_string())?,
            );
            for (preview_id, source_to_project) in
                preview_transforms.get(&dataset_id).into_iter().flatten()
            {
                preview_selections
                    .entry(preview_id.clone())
                    .or_default()
                    .push(
                        TileSelector::select_with_clips_and_transforms(
                            source,
                            view,
                            &clip_volumes,
                            *source_to_project,
                            presentation,
                            |key| residency.residency(key),
                        )
                        .map_err(|error| error.to_string())?,
                    );
            }
        }
        for source in self.potree_datasets.values_mut() {
            let dataset_id = source.dataset_id().clone();
            let (source_to_project, presentation) = transforms
                .get(&dataset_id)
                .copied()
                .unwrap_or((WorldTransform::IDENTITY, PresentationTransform::IDENTITY));
            selections.push(
                TileSelector::select_with_clips_and_transforms(
                    source,
                    view,
                    &clip_volumes,
                    source_to_project,
                    presentation,
                    |key| residency.residency(key),
                )
                .map_err(|error| error.to_string())?,
            );
            for (preview_id, source_to_project) in
                preview_transforms.get(&dataset_id).into_iter().flatten()
            {
                preview_selections
                    .entry(preview_id.clone())
                    .or_default()
                    .push(
                        TileSelector::select_with_clips_and_transforms(
                            source,
                            view,
                            &clip_volumes,
                            *source_to_project,
                            presentation,
                            |key| residency.residency(key),
                        )
                        .map_err(|error| error.to_string())?,
                    );
            }
        }
        for source in self.prepared_datasets.values_mut() {
            let dataset_id = source.dataset_id().clone();
            let (source_to_project, presentation) = transforms
                .get(&dataset_id)
                .copied()
                .unwrap_or((WorldTransform::IDENTITY, PresentationTransform::IDENTITY));
            selections.push(
                TileSelector::select_with_clips_and_transforms(
                    source,
                    view,
                    &clip_volumes,
                    source_to_project,
                    presentation,
                    |key| residency.residency(key),
                )
                .map_err(|error| error.to_string())?,
            );
            for (preview_id, source_to_project) in
                preview_transforms.get(&dataset_id).into_iter().flatten()
            {
                preview_selections
                    .entry(preview_id.clone())
                    .or_default()
                    .push(
                        TileSelector::select_with_clips_and_transforms(
                            source,
                            view,
                            &clip_volumes,
                            *source_to_project,
                            presentation,
                            |key| residency.residency(key),
                        )
                        .map_err(|error| error.to_string())?,
                    );
            }
        }
        Ok((selections, preview_selections))
    }

    fn dataset_render_transforms(
        &self,
    ) -> Result<BTreeMap<DatasetId, (WorldTransform, PresentationTransform)>, String> {
        self.dataset_slot_keys
            .iter()
            .map(|(dataset_id, storage_key)| {
                let request = self.slot_requests.get(storage_key).ok_or_else(|| {
                    format!("dataset {dataset_id} has no canonical slot presentation")
                })?;
                let (style, datum) =
                    self.entity_styles.get(&request.entity_id).ok_or_else(|| {
                        format!("dataset {dataset_id} has no entity presentation style")
                    })?;
                let transform =
                    PresentationTransform::new(f64::from(style.vertical_exaggeration), *datum)
                        .map_err(|error| error.to_string())?;
                let source_to_project =
                    WorldTransform(request.placement.unwrap_or(Transform3d::IDENTITY).0);
                if !source_to_project.is_invertible_affine() {
                    return Err(format!(
                        "dataset {dataset_id} has an invalid canonical entity placement"
                    ));
                }
                Ok((
                    DatasetId(dataset_id.clone()),
                    (source_to_project, transform),
                ))
            })
            .collect()
    }

    fn dataset_move_preview_transforms(
        &self,
        base: &BTreeMap<DatasetId, (WorldTransform, PresentationTransform)>,
    ) -> Result<BTreeMap<DatasetId, Vec<(String, WorldTransform)>>, String> {
        let mut transforms = BTreeMap::<DatasetId, Vec<(String, WorldTransform)>>::new();
        for (dataset_id, storage_key) in &self.dataset_slot_keys {
            let Some(slot) = self.slot_requests.get(storage_key) else {
                return Err(format!("dataset {dataset_id} has no canonical slot"));
            };
            let Some(preview_ids) = self.entity_move_previews.get(&slot.entity_id) else {
                continue;
            };
            let dataset_key = DatasetId(dataset_id.clone());
            let (source_to_project, _) = base
                .get(&dataset_key)
                .copied()
                .ok_or_else(|| format!("dataset {dataset_id} has no render transform"))?;
            for preview_id in preview_ids {
                let preview = self
                    .move_previews
                    .get(preview_id)
                    .ok_or_else(|| format!("move preview {preview_id} is not resident"))?;
                let translation = WorldTransform::from_translation(preview.translation)
                    .ok_or_else(|| format!("move preview {preview_id} has invalid translation"))?;
                let target = translation.compose(source_to_project).ok_or_else(|| {
                    format!("move preview {preview_id} has invalid target placement")
                })?;
                transforms
                    .entry(dataset_key.clone())
                    .or_default()
                    .push((preview_id.clone(), target));
            }
        }
        Ok(transforms)
    }

    fn apply_move_preview_target_tiles(
        &mut self,
        selections: &BTreeMap<String, Vec<TileSelection>>,
    ) -> Result<(), String> {
        let mut changed_entities = BTreeSet::new();
        for (preview_id, preview_selections) in selections {
            let target = preview_selections
                .iter()
                .flat_map(|selection| selection.render.iter().cloned())
                .collect::<BTreeSet<_>>();
            let target_is_loading = target.is_empty()
                && preview_selections
                    .iter()
                    .any(|selection| !selection.wanted.is_empty());
            let preview = self
                .move_previews
                .get_mut(preview_id)
                .ok_or_else(|| format!("selected move preview {preview_id} is not resident"))?;
            if target_is_loading {
                continue;
            }
            if preview.target_render_tiles != target {
                preview.target_render_tiles = target;
                changed_entities.insert(preview.entity_id.clone());
            }
        }
        for entity_id in changed_entities {
            self.rebuild_move_previews_for_entity(Some(&entity_id), self.floating_origin)
                .map_err(|error| {
                    error.as_string().unwrap_or_else(|| {
                        format!("failed to reconcile move preview for {entity_id}")
                    })
                })?;
        }
        Ok(())
    }

    fn move_preview_fallback_selections(
        &self,
        selections: &BTreeMap<String, Vec<TileSelection>>,
    ) -> Result<Vec<TileSelection>, JsValue> {
        selections
            .iter()
            .filter_map(|(preview_id, preview_selections)| {
                let target_is_loading = preview_selections
                    .iter()
                    .all(|selection| selection.render.is_empty())
                    && preview_selections
                        .iter()
                        .any(|selection| !selection.wanted.is_empty());
                if !target_is_loading {
                    return None;
                }
                Some((preview_id, preview_selections))
            })
            .map(|(preview_id, _)| {
                let preview = self.move_previews.get(preview_id).ok_or_else(|| {
                    JsValue::from_str(&format!(
                        "selected move preview {preview_id} is not resident"
                    ))
                })?;
                Ok(TileSelection {
                    wanted: Vec::new(),
                    render: preview.target_render_tiles.iter().cloned().collect(),
                    hierarchy_pages: Vec::new(),
                    traversed_nodes: 0,
                    culled_nodes: 0,
                    work_limit_reached: false,
                })
            })
            .collect()
    }

    fn apply_streaming_visibility(&mut self, render: &[TileKey]) -> Result<(), String> {
        self.render_world
            .replace_streaming_visibility(render.iter().cloned())
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn submit_frame(
        &mut self,
        pick: Option<SurfacePickRequest>,
    ) -> Result<SurfaceFrameOutcome, String> {
        let visible_proxy_ids = self.raster_analysis_view.as_ref().map_or_else(
            || {
                self.render_world
                    .visible_proxy_ids()
                    .cloned()
                    .collect::<Vec<_>>()
            },
            |analysis| vec![analysis.proxy_id.clone()],
        );
        let queue = self.host.queue();
        let mut frame_origin_queue_writes = 0_u64;
        for id in &visible_proxy_ids {
            if let Some(batches) = self.batches.get_mut(id) {
                for batch in batches {
                    if batch
                        .ensure_frame_origin(queue, self.floating_origin)
                        .map_err(|error| error.to_string())?
                    {
                        frame_origin_queue_writes = frame_origin_queue_writes.saturating_add(1);
                    }
                }
            }
        }
        if let Some(batch) = self
            .raster_analysis_view
            .as_mut()
            .map(|analysis| &mut analysis.analysis_batch)
        {
            if batch
                .ensure_frame_origin(queue, self.floating_origin)
                .map_err(|error| error.to_string())?
            {
                frame_origin_queue_writes = frame_origin_queue_writes.saturating_add(1);
            }
        }
        for preview in self.move_previews.values_mut() {
            for preview_batch in &mut preview.batches {
                let visible = preview_batch.tile_key.as_ref().map_or_else(
                    || self.render_world.is_visible(&preview_batch.source_id),
                    |key| preview.target_render_tiles.contains(key),
                );
                if visible
                    && preview_batch
                        .batch
                        .ensure_frame_origin(queue, self.floating_origin)
                        .map_err(|error| error.to_string())?
                {
                    frame_origin_queue_writes = frame_origin_queue_writes.saturating_add(1);
                }
            }
        }
        for batch in &mut self.clip_preview_batches {
            if batch
                .ensure_frame_origin(queue, self.floating_origin)
                .map_err(|error| error.to_string())?
            {
                frame_origin_queue_writes = frame_origin_queue_writes.saturating_add(1);
            }
        }
        self.last_frame_origin_queue_writes = frame_origin_queue_writes;
        self.frame_origin_queue_write_count = self
            .frame_origin_queue_write_count
            .saturating_add(frame_origin_queue_writes);
        let mut batches = if let Some(analysis) = &self.raster_analysis_view {
            vec![&analysis.analysis_batch]
        } else {
            visible_proxy_ids
                .iter()
                .filter_map(|id| self.batches.get(id))
                .flat_map(|batches| batches.iter())
                .collect::<Vec<_>>()
        };
        if self.raster_analysis_view.is_none() {
            batches.extend(self.move_previews.values().flat_map(|preview| {
                preview
                    .batches
                    .iter()
                    .filter(|preview_batch| {
                        preview_batch.tile_key.as_ref().map_or_else(
                            || self.render_world.is_visible(&preview_batch.source_id),
                            |key| preview.target_render_tiles.contains(key),
                        )
                    })
                    .map(|preview_batch| &preview_batch.batch)
            }));
            batches.extend(self.clip_preview_batches.iter());
        }
        let clip_volumes = self.raster_analysis_view.as_ref().map_or_else(
            || self.render_world.active_clip_volumes().collect::<Vec<_>>(),
            |_| Vec::new(),
        );
        self.host
            .render(SurfaceFrame {
                view_projection: self.view_projection,
                floating_origin: self.floating_origin,
                clip_volumes: &clip_volumes,
                batches: &batches,
                clear_color: self.clear_color,
                pick,
            })
            .map_err(|error| error.to_string())
    }

    /// Rebuilds small canonical inline caps only at a state mutation boundary.
    /// Frame submission never evaluates topology or uploads newly derived cap
    /// geometry; streamed caps use the asynchronous authoritative section path.
    fn rebuild_inline_clip_previews(&mut self) -> Result<(), String> {
        let preview = build_clip_preview_batches(
            &self.host,
            &self.render_world,
            &self.entity_requests,
            &self.block_definitions,
            &self.block_member_styles,
            &self.block_member_entity_versions,
            &self.mesh_resources,
            &self.hatch_resources,
            &self.clip_volumes,
            self.floating_origin,
        )?;
        self.clip_preview_batches = preview.batches;
        self.clip_preview_material_slots = preview.material_slots;
        self.clip_preview_cost = preview.cost;
        Ok(())
    }
}

#[cfg(target_arch = "wasm32")]
fn prepare_content_gpu_textures(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &himmelcad_render::GpuSharedRenderer,
    owner: &str,
    content: &DecodedThreeDTilesContent,
    cache: &GpuTextureResourceCache<GpuTextureResource>,
    source_catalog: &BTreeMap<[u8; 32], GpuTextureResourceIdentity>,
    transaction_resources: &mut BTreeMap<GpuTextureResourceIdentity, GpuTextureResource>,
    prepared: &mut WasmPreparedGpuTextures,
    stage_resources: &mut Vec<(GpuTextureResourceIdentity, GpuTextureResource)>,
    decoded_sources: &mut u64,
    factory_calls: &mut u64,
) -> Result<(), String> {
    match content {
        DecodedThreeDTilesContent::Mesh(mesh) => prepare_glb_gpu_textures(
            device,
            queue,
            renderer,
            owner,
            &mesh.glb,
            cache,
            source_catalog,
            transaction_resources,
            prepared,
            stage_resources,
            decoded_sources,
            factory_calls,
        )?,
        DecodedThreeDTilesContent::InstancedMesh(model) => prepare_glb_gpu_textures(
            device,
            queue,
            renderer,
            owner,
            &model.glb,
            cache,
            source_catalog,
            transaction_resources,
            prepared,
            stage_resources,
            decoded_sources,
            factory_calls,
        )?,
        DecodedThreeDTilesContent::Composite(children) => {
            for child in children {
                prepare_content_gpu_textures(
                    device,
                    queue,
                    renderer,
                    owner,
                    child,
                    cache,
                    source_catalog,
                    transaction_resources,
                    prepared,
                    stage_resources,
                    decoded_sources,
                    factory_calls,
                )?;
            }
        }
        DecodedThreeDTilesContent::Points(_) => {}
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments)]
fn prepare_glb_gpu_textures(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &himmelcad_render::GpuSharedRenderer,
    owner: &str,
    glb: &himmelcad_render::DecodedGlb,
    cache: &GpuTextureResourceCache<GpuTextureResource>,
    source_catalog: &BTreeMap<[u8; 32], GpuTextureResourceIdentity>,
    transaction_resources: &mut BTreeMap<GpuTextureResourceIdentity, GpuTextureResource>,
    prepared: &mut WasmPreparedGpuTextures,
    stage_resources: &mut Vec<(GpuTextureResourceIdentity, GpuTextureResource)>,
    decoded_sources: &mut u64,
    factory_calls: &mut u64,
) -> Result<(), String> {
    let mut missing = std::collections::BTreeSet::new();
    for source_key in glb_texture_source_keys(glb) {
        let known_identity = prepared
            .bindings
            .get(&source_key)
            .copied()
            .or_else(|| source_catalog.get(&source_key).copied());
        let known_resource = known_identity.and_then(|identity| {
            transaction_resources
                .get(&identity)
                .cloned()
                .or_else(|| cache.resource(identity))
                .map(|resource| (identity, resource))
        });
        if let Some((identity, resource)) = known_resource {
            transaction_resources.insert(identity, resource.clone());
            prepared.resources.bind_source(source_key, resource.clone());
            prepared.bindings.insert(source_key, identity);
            stage_resources.push((identity, resource));
        } else {
            missing.insert(source_key);
        }
    }
    for upload in prepare_glb_texture_uploads_for_sources(device, glb, &missing)
        .map_err(|error| error.to_string())?
    {
        *decoded_sources = decoded_sources.saturating_add(1);
        let cached = transaction_resources
            .get(&upload.identity)
            .cloned()
            .or_else(|| cache.resource(upload.identity));
        let resource = if let Some(resource) = cached {
            resource
        } else {
            *factory_calls = factory_calls.saturating_add(1);
            renderer
                .create_mip_chain_texture_resource(
                    device,
                    queue,
                    &format!("himmelcad-shared-texture-{owner}"),
                    upload.mip_chain(),
                )
                .map_err(|error| error.to_string())?
        };
        transaction_resources.insert(upload.identity, resource.clone());
        prepared.resources.bind(&upload, resource.clone());
        prepared
            .bindings
            .insert(upload.source_key(), upload.identity);
        stage_resources.push((upload.identity, resource));
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
fn build_clip_preview_batches(
    host: &GpuSurfaceHost<'_>,
    world: &RenderWorld,
    entities: &BTreeMap<String, WasmEntityRenderRequest>,
    block_definitions: &BTreeMap<String, BlockDefinition>,
    block_member_styles: &BTreeMap<String, (CanonicalResourceRef, RenderStyle)>,
    block_member_entity_versions: &BTreeMap<String, (EntityVersionRef, WasmEntityRenderRequest)>,
    mesh_resources: &BTreeMap<String, TriangleMeshGeometry>,
    hatch_resources: &WasmHatchResourceRegistry,
    volumes: &[ClipVolume],
    origin: WorldVec3,
) -> Result<ClipPreviewBuild, String> {
    let active = volumes
        .iter()
        .filter(|volume| volume.enabled && volume.preview_cap)
        .collect::<Vec<_>>();
    if active.is_empty() {
        return Ok(ClipPreviewBuild::default());
    }
    let floating_origin =
        FloatingOrigin::from_selected(1_024.0, origin).map_err(|error| error.to_string())?;
    let mut output = Vec::new();
    let mut cost = ResourceCost::default();
    let mut material_slots = std::collections::BTreeSet::new();
    for entity in entities.values() {
        if world.proxy_ids_for_entity(&entity.entity_id).is_empty() {
            continue;
        }
        let mut sectionable = Vec::new();
        if matches!(&entity.geometry, GeometryObject::Block { .. }) {
            collect_block_member_requests(
                entity,
                entities,
                block_definitions,
                block_member_styles,
                block_member_entity_versions,
                &mut Vec::new(),
                &mut sectionable,
            )?;
        } else {
            sectionable.push(entity.clone());
        }
        for member in sectionable.iter().filter(|member| {
            matches!(
                &member.geometry,
                GeometryObject::Surface3d { .. } | GeometryObject::Solid { .. }
            )
        }) {
            let evaluated_geometry;
            let geometry = if let GeometryObject::Solid { solid } = &member.geometry {
                if solid_requires_evaluated_mesh(solid) {
                    let Ok(mesh) = evaluated_mesh_for_solid(member, solid, mesh_resources) else {
                        continue;
                    };
                    evaluated_geometry = GeometryObject::Surface3d {
                        mesh: Box::new(mesh.clone()),
                    };
                    &evaluated_geometry
                } else {
                    &member.geometry
                }
            } else {
                &member.geometry
            };
            for volume in &active {
                for (plane_index, clip_plane) in volume.planes.iter().enumerate() {
                    let normal_length_squared = clip_plane.normal.x * clip_plane.normal.x
                        + clip_plane.normal.y * clip_plane.normal.y
                        + clip_plane.normal.z * clip_plane.normal.z;
                    let plane = SectionPlane {
                        origin: WorldVec3 {
                            x: -clip_plane.distance * clip_plane.normal.x / normal_length_squared,
                            y: -clip_plane.distance * clip_plane.normal.y / normal_length_squared,
                            z: -clip_plane.distance * clip_plane.normal.z / normal_length_squared,
                        },
                        normal: clip_plane.normal,
                    };
                    let Ok(product) =
                        section_geometry_object(geometry, member.placement, plane, 1.0e-7)
                    else {
                        continue;
                    };
                    let style_hatch = if let FillMode::Hatch {
                        resource,
                        line_width,
                        color,
                        ..
                    } = &member.style.fill
                    {
                        Some(SectionHatchStyle {
                            resource: resource.clone(),
                            line_width: *line_width,
                            color: *color,
                        })
                    } else {
                        None
                    };
                    for (region_index, region) in product.regions.iter().enumerate() {
                        let Some(region) = clip_preview_region(
                            region,
                            volume,
                            plane_index,
                            clip_plane.normal,
                            1.0e-4,
                        ) else {
                            continue;
                        };
                        material_slots.insert(region.material_slot);
                        let mut gpu_style = GpuPresentationStyle::from_render_style(
                            &member.style,
                            origin,
                            plane.origin.z,
                        )
                        .map_err(|error| error.to_string())?;
                        let hatch_style = volume
                            .section_material_hatches
                            .get(&region.material_slot)
                            .or(volume.section_fill.as_ref())
                            .or(style_hatch.as_ref());
                        let mut hatch_resource = None;
                        if let Some(hatch_style) = hatch_style {
                            let key = canonical_resource_ref_key(&hatch_style.resource)?;
                            let hatch = hatch_resources.gpu.get(&key).ok_or_else(|| {
                                format!(
                                    "exact GPU hatch resource revision '{}' is not registered",
                                    hatch_style.resource.resource_id
                                )
                            })?;
                            let (axis_u, axis_v) = section_hatch_axes(plane.normal)?;
                            gpu_style = gpu_style.with_hatch(
                                GpuHatchPattern::new(
                                    plane.origin,
                                    axis_u,
                                    axis_v,
                                    hatch_style.line_width,
                                    hatch_style.color,
                                    origin,
                                )
                                .map_err(|error| error.to_string())?,
                                hatch.pattern(),
                            );
                            hatch_resource = Some(hatch);
                        } else {
                            match &member.style.fill {
                                FillMode::None => {
                                    gpu_style = gpu_style.with_fill_visible(false);
                                }
                                FillMode::Texture { resource_id } => {
                                    return Err(format!(
                                        "clip-cap texture '{resource_id}' needs an explicit section-plane mapping"
                                    ));
                                }
                                FillMode::Color | FillMode::Hatch { .. } => {}
                            }
                        }
                        let label = format!(
                            "clip-cap-{}-{}-{plane_index}-{region_index}",
                            volume.id.0, member.entity_id
                        );
                        let mut batch = build_section_region_batch(
                            host.device(),
                            host.queue(),
                            &label,
                            SectionBatchOptions {
                                proxy_slot: 1,
                                primitive_base: 0,
                                floating_origin,
                                plane_normal: clip_plane.normal,
                                linear_color: [1.0; 4],
                            },
                            &region,
                        )
                        .map_err(|error| error.to_string())?
                        .with_pickable(false);
                        let material = host
                            .renderer()
                            .create_styled_material(
                                host.device(),
                                host.queue(),
                                &format!("{label}-material"),
                                GpuTextureData {
                                    width: 1,
                                    height: 1,
                                    rgba8: &[255; 4],
                                },
                                GpuAlphaMode::Opaque,
                                gpu_style,
                            )
                            .map_err(|error| error.to_string())?;
                        batch = batch.with_material(material);
                        batch
                            .rebind_hatch_resource(host.device(), host.renderer(), hatch_resource)
                            .map_err(|error| error.to_string())?;
                        batch
                            .set_world_origins(host.queue(), origin, origin)
                            .map_err(|error| error.to_string())?;
                        output.push(batch);
                        cost = cost.saturating_add(ResourceCost {
                            gpu_buffer_bytes: usize_to_u64(region.vertices.len())
                                .saturating_mul(32)
                                .saturating_add(
                                    usize_to_u64(region.indices.len()).saturating_mul(4),
                                ),
                            triangles: usize_to_u64(region.indices.len() / 3),
                            draw_calls: 1,
                            ..ResourceCost::default()
                        });
                    }
                }
            }
        }
    }
    Ok(ClipPreviewBuild {
        batches: output,
        material_slots: material_slots.into_iter().collect(),
        cost,
    })
}

#[cfg(target_arch = "wasm32")]
#[derive(Default)]
struct ClipPreviewBuild {
    batches: Vec<GpuDrawBatch>,
    material_slots: Vec<u32>,
    cost: ResourceCost,
}

#[cfg(target_arch = "wasm32")]
fn section_hatch_axes(normal: WorldVec3) -> Result<(WorldVec3, WorldVec3), String> {
    let normal = DVec3::new(normal.x, normal.y, normal.z);
    let length = normal.length();
    if !length.is_finite() || length <= f64::EPSILON {
        return Err("section hatch plane normal is invalid".to_owned());
    }
    let normal = normal / length;
    let reference = if normal.z.abs() < 0.9 {
        DVec3::Z
    } else {
        DVec3::X
    };
    let axis_u = reference.cross(normal).normalize();
    let axis_v = normal.cross(axis_u).normalize();
    Ok((
        WorldVec3 {
            x: axis_u.x,
            y: axis_u.y,
            z: axis_u.z,
        },
        WorldVec3 {
            x: axis_v.x,
            y: axis_v.y,
            z: axis_v.z,
        },
    ))
}

#[cfg(target_arch = "wasm32")]
fn clip_preview_region(
    region: &SectionRegion,
    volume: &ClipVolume,
    cap_plane_index: usize,
    cap_normal: WorldVec3,
    offset: f64,
) -> Option<SectionRegion> {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for triangle in region.indices.chunks_exact(3) {
        let mut polygon = triangle
            .iter()
            .map(|index| region.vertices[*index as usize])
            .collect::<Vec<_>>();
        for (plane_index, plane) in volume.planes.iter().enumerate() {
            if plane_index != cap_plane_index {
                polygon = clip_polygon_to_plane(&polygon, plane, offset * 2.0);
                if polygon.len() < 3 {
                    break;
                }
            }
        }
        if polygon.len() < 3 {
            continue;
        }
        let direction = if volume.operation == ClipOperation::KeepInside {
            1.0
        } else {
            -1.0
        };
        let first = u32::try_from(vertices.len()).ok()?;
        vertices.extend(polygon.iter().map(|point| WorldVec3 {
            x: point.x + cap_normal.x * offset * direction,
            y: point.y + cap_normal.y * offset * direction,
            z: point.z + cap_normal.z * offset * direction,
        }));
        for corner in 1..polygon.len() - 1 {
            indices.extend([
                first,
                first.checked_add(u32::try_from(corner).ok()?)?,
                first.checked_add(u32::try_from(corner + 1).ok()?)?,
            ]);
        }
    }
    (!indices.is_empty()).then(|| SectionRegion {
        material_slot: region.material_slot,
        outer: region.outer.clone(),
        holes: region.holes.clone(),
        vertices,
        indices,
    })
}

#[cfg(target_arch = "wasm32")]
fn clip_polygon_to_plane(
    polygon: &[WorldVec3],
    plane: &himmelcad_render::ClipPlane,
    inside_margin: f64,
) -> Vec<WorldVec3> {
    let mut output = Vec::new();
    let Some(mut previous) = polygon.last().copied() else {
        return output;
    };
    let mut previous_distance = clip_plane_distance(previous, plane) - inside_margin;
    for current in polygon.iter().copied() {
        let current_distance = clip_plane_distance(current, plane) - inside_margin;
        let previous_inside = previous_distance >= 0.0;
        let current_inside = current_distance >= 0.0;
        if previous_inside != current_inside {
            let parameter = previous_distance / (previous_distance - current_distance);
            output.push(WorldVec3 {
                x: previous.x + (current.x - previous.x) * parameter,
                y: previous.y + (current.y - previous.y) * parameter,
                z: previous.z + (current.z - previous.z) * parameter,
            });
        }
        if current_inside {
            output.push(current);
        }
        previous = current;
        previous_distance = current_distance;
    }
    output
}

#[cfg(target_arch = "wasm32")]
fn clip_plane_distance(point: WorldVec3, plane: &himmelcad_render::ClipPlane) -> f64 {
    plane.normal.x * point.x + plane.normal.y * point.y + plane.normal.z * point.z + plane.distance
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments)]
fn build_move_preview_batches(
    host: &GpuSurfaceHost<'_>,
    world: &RenderWorld,
    source_batches: &BTreeMap<RenderProxyId, Vec<GpuDrawBatch>>,
    entity_id: &str,
    style: &RenderStyle,
    exaggeration_datum: f64,
    translation: WorldVec3,
    floating_origin: WorldVec3,
    target_render_tiles: &BTreeSet<TileKey>,
    image_resources: &BTreeMap<String, WasmImageResource>,
    hatch_resources: &WasmHatchResourceRegistry,
    line_type_resources: &WasmLineTypeResourceRegistry,
) -> Result<Vec<WasmMovePreviewBatch>, String> {
    let mut output = Vec::new();
    if !finite_translation(translation) {
        return Err("move preview translation must be finite".to_owned());
    }
    for source_id in world.proxy_ids_for_entity(entity_id) {
        let kind = world
            .proxy_kind(&source_id)
            .ok_or_else(|| "move preview source proxy kind is unavailable".to_owned())?;
        let tile_key = world.tile_key_for_proxy(&source_id);
        if tile_key
            .as_ref()
            .is_some_and(|key| !target_render_tiles.contains(key))
        {
            continue;
        }
        let Some(batches) = source_batches.get(&source_id) else {
            continue;
        };
        for (batch_index, batch) in batches.iter().enumerate() {
            let batch_origin = batch
                .batch_origin()
                .ok_or_else(|| "move preview source batch has no material origin".to_owned())?;
            let target_origin = add_world(batch_origin, translation);
            let gpu_style =
                GpuPresentationStyle::from_render_style(style, target_origin, exaggeration_datum)
                    .map_err(|error| error.to_string())?;
            let mut ghost = batch
                .fork_with_style_and_queue(
                    host.device(),
                    host.queue(),
                    host.renderer(),
                    &format!("move-preview-{entity_id}-{batch_index}"),
                    gpu_style,
                    false,
                )
                .map_err(|error| error.to_string())?;
            ghost
                .set_world_origins(host.queue(), target_origin, floating_origin)
                .map_err(|error| error.to_string())?;
            let resolved = resolve_batch_presentation(
                style,
                exaggeration_datum,
                kind,
                &ghost,
                image_resources,
                hatch_resources,
                line_type_resources,
            )?;
            apply_batch_presentation(host, &mut ghost, &resolved)?;
            output.push(WasmMovePreviewBatch {
                source_id: source_id.clone(),
                kind,
                tile_key: tile_key.clone(),
                batch: ghost,
            });
        }
    }
    Ok(output)
}

#[cfg(target_arch = "wasm32")]
fn finite_translation(value: WorldVec3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

#[cfg(target_arch = "wasm32")]
fn project_translation_delta(previous: WorldTransform, next: WorldTransform) -> Option<WorldVec3> {
    let delta = next.compose(previous.inverse()?)?;
    let expected = WorldTransform::IDENTITY.0;
    for index in 0..12 {
        if (delta.0[index] - expected[index]).abs() > 1.0e-12 {
            return None;
        }
    }
    let translation = WorldVec3 {
        x: delta.0[12],
        y: delta.0[13],
        z: delta.0[14],
    };
    finite_translation(translation).then_some(translation)
}

#[cfg(target_arch = "wasm32")]
fn add_world(left: WorldVec3, right: WorldVec3) -> WorldVec3 {
    WorldVec3 {
        x: left.x + right.x,
        y: left.y + right.y,
        z: left.z + right.z,
    }
}

#[cfg(target_arch = "wasm32")]
fn subtract_world(left: WorldVec3, right: WorldVec3) -> WorldVec3 {
    WorldVec3 {
        x: left.x - right.x,
        y: left.y - right.y,
        z: left.z - right.z,
    }
}

#[cfg(target_arch = "wasm32")]
fn identity() -> [[f32; 4]; 4] {
    [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

#[cfg(target_arch = "wasm32")]
fn append_command_result(
    publication_json: String,
    entity: &CanonicalEntity,
    entry: &EntityCommandJournalEntry,
) -> Result<String, JsValue> {
    let mut value: serde_json::Value = serde_json::from_str(&publication_json).map_err(js_error)?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| JsValue::from_str("canonical publication result is malformed"))?;
    object.insert(
        "entity".to_owned(),
        serde_json::to_value(entity).map_err(js_error)?,
    );
    object.insert(
        "journalEntry".to_owned(),
        serde_json::to_value(entry).map_err(js_error)?,
    );
    serde_json::to_string(&value).map_err(js_error)
}

#[cfg(target_arch = "wasm32")]
fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[cfg(target_arch = "wasm32")]
const MAX_SECTION_PART_VERTICES: usize = 4_000_000;
#[cfg(target_arch = "wasm32")]
const MAX_SECTION_PART_INDICES: usize = 24_000_000;

#[cfg(target_arch = "wasm32")]
fn decode_section_topology_partition(
    manifest: &SectionTopologyPartitionManifest,
    topology_hash: String,
    position_bytes: &[u8],
    index_bytes: &[u8],
    material_slot_bytes: &[u8],
) -> Result<SectionTopologyPartitionData, JsValue> {
    if manifest.schema_version != SectionTopologyPartitionManifest::SCHEMA_VERSION
        || manifest.origin.iter().any(|value| !value.is_finite())
        || manifest.vertex_count == 0
        || manifest.index_count == 0
        || !manifest.index_count.is_multiple_of(3)
    {
        return Err(JsValue::from_str(
            "section topology partition manifest is invalid",
        ));
    }
    let vertex_count = usize::try_from(manifest.vertex_count).map_err(js_error)?;
    let index_count = usize::try_from(manifest.index_count).map_err(js_error)?;
    if vertex_count > MAX_SECTION_PART_VERTICES || index_count > MAX_SECTION_PART_INDICES {
        return Err(JsValue::from_str(
            "section topology partition exceeds the hard decode ceiling",
        ));
    }
    let position_component_bytes = match manifest.position_component_type {
        SectionPositionComponentType::Float32 => 4,
        SectionPositionComponentType::Float64 => 8,
    };
    let expected_position_bytes = vertex_count
        .checked_mul(3)
        .and_then(|count| count.checked_mul(position_component_bytes))
        .ok_or_else(|| JsValue::from_str("section position byte length overflows"))?;
    let index_component_bytes = match manifest.index_component_type {
        SectionIndexComponentType::Uint16 => 2,
        SectionIndexComponentType::Uint32 => 4,
    };
    let expected_index_bytes = index_count
        .checked_mul(index_component_bytes)
        .ok_or_else(|| JsValue::from_str("section index byte length overflows"))?;
    verify_section_partition_resource(
        &manifest.positions,
        position_bytes,
        expected_position_bytes,
    )?;
    verify_section_partition_resource(&manifest.indices, index_bytes, expected_index_bytes)?;

    let mut positions = Vec::with_capacity(vertex_count);
    match manifest.position_component_type {
        SectionPositionComponentType::Float32 => {
            for xyz in position_bytes.chunks_exact(12) {
                positions.push(section_world_position(
                    manifest.origin,
                    [
                        f64::from(f32::from_le_bytes(
                            xyz[0..4].try_into().expect("four bytes"),
                        )),
                        f64::from(f32::from_le_bytes(
                            xyz[4..8].try_into().expect("four bytes"),
                        )),
                        f64::from(f32::from_le_bytes(
                            xyz[8..12].try_into().expect("four bytes"),
                        )),
                    ],
                )?);
            }
        }
        SectionPositionComponentType::Float64 => {
            for xyz in position_bytes.chunks_exact(24) {
                positions.push(section_world_position(
                    manifest.origin,
                    [
                        f64::from_le_bytes(xyz[0..8].try_into().expect("eight bytes")),
                        f64::from_le_bytes(xyz[8..16].try_into().expect("eight bytes")),
                        f64::from_le_bytes(xyz[16..24].try_into().expect("eight bytes")),
                    ],
                )?);
            }
        }
    }
    let indices = match manifest.index_component_type {
        SectionIndexComponentType::Uint16 => index_bytes
            .chunks_exact(2)
            .map(|bytes| u32::from(u16::from_le_bytes(bytes.try_into().expect("two bytes"))))
            .collect(),
        SectionIndexComponentType::Uint32 => index_bytes
            .chunks_exact(4)
            .map(|bytes| u32::from_le_bytes(bytes.try_into().expect("four bytes")))
            .collect(),
    };
    let material_slots = match &manifest.material_slots {
        Some(resource) => {
            let expected = index_count
                .checked_div(3)
                .and_then(|count| count.checked_mul(4))
                .ok_or_else(|| JsValue::from_str("section material byte length overflows"))?;
            verify_section_partition_resource(resource, material_slot_bytes, expected)?;
            Some(
                material_slot_bytes
                    .chunks_exact(4)
                    .map(|bytes| u32::from_le_bytes(bytes.try_into().expect("four bytes")))
                    .collect(),
            )
        }
        None if material_slot_bytes.is_empty() => None,
        None => {
            return Err(JsValue::from_str(
                "section topology supplied undeclared material slots",
            ));
        }
    };
    Ok(SectionTopologyPartitionData {
        topology_hash,
        positions,
        indices,
        material_slots,
    })
}

#[cfg(target_arch = "wasm32")]
fn verify_section_partition_resource(
    resource: &GeometryResource,
    bytes: &[u8],
    expected_length: usize,
) -> Result<(), JsValue> {
    if resource.media_type.trim().is_empty()
        || bytes.len() != expected_length
        || resource.byte_length != u64::try_from(expected_length).ok()
        || ObjectHash::of_bytes(bytes) != resource.object_hash
    {
        return Err(JsValue::from_str(
            "section topology resource length or content hash is invalid",
        ));
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn section_world_position(origin: [f64; 3], local: [f64; 3]) -> Result<WorldVec3, JsValue> {
    let position = WorldVec3 {
        x: origin[0] + local[0],
        y: origin[1] + local[1],
        z: origin[2] + local[2],
    };
    if [position.x, position.y, position.z]
        .iter()
        .any(|value| !value.is_finite())
    {
        return Err(JsValue::from_str("section topology position is not finite"));
    }
    Ok(position)
}

#[cfg(target_arch = "wasm32")]
fn parse_sha256_hex(value: &str) -> Result<[u8; 32], JsValue> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(JsValue::from_str(
            "expected decode input hash must be 64 hexadecimal characters",
        ));
    }
    let mut decoded = [0_u8; 32];
    for (index, output) in decoded.iter_mut().enumerate() {
        let offset = index * 2;
        *output = u8::from_str_radix(&value[offset..offset + 2], 16)
            .map_err(|_| JsValue::from_str("expected decode input hash is invalid"))?;
    }
    Ok(decoded)
}

#[cfg(target_arch = "wasm32")]
fn frame_outcome_json(outcome: &SurfaceFrameOutcome) -> serde_json::Value {
    match outcome {
        SurfaceFrameOutcome::Presented { reconfigured, .. } => {
            serde_json::json!({ "status": "presented", "reconfigured": reconfigured })
        }
        SurfaceFrameOutcome::Picked { .. } => serde_json::json!({ "status": "picked" }),
        SurfaceFrameOutcome::Skipped(reason) => serde_json::json!({
            "status": "skipped",
            "reason": format!("{reason:?}")
        }),
        SurfaceFrameOutcome::RecreateSurface => {
            serde_json::json!({ "status": "recreateSurface" })
        }
        SurfaceFrameOutcome::RecreateDevice { reason } => serde_json::json!({
            "status": "recreateDevice",
            "reason": match reason {
                GpuRecoveryReason::DeviceLost => "deviceLost",
                GpuRecoveryReason::OutOfMemory => "outOfMemory",
            }
        }),
    }
}

#[cfg(target_arch = "wasm32")]
fn runtime_quality_observation_json(
    adjustment: QualityAdjustment,
    state: RuntimeQualityState,
) -> serde_json::Value {
    let adjustment = match adjustment {
        QualityAdjustment::Unchanged => "unchanged",
        QualityAdjustment::Reduced(_) => "reduced",
        QualityAdjustment::Increased(_) => "increased",
    };
    serde_json::json!({
        "adjustment": adjustment,
        "quality": state,
    })
}

#[cfg(target_arch = "wasm32")]
#[derive(Clone)]
struct WasmResolvedBatchPresentation {
    style: GpuPresentationStyle,
    texture: Option<GpuTextureResource>,
    line_type: Option<GpuLineTypeResource>,
    hatch: Option<GpuHatchResource>,
}

#[cfg(target_arch = "wasm32")]
fn fill_capable(kind: RenderProxyKind) -> bool {
    matches!(
        kind,
        RenderProxyKind::Triangles | RenderProxyKind::CadFill | RenderProxyKind::Raster
    )
}

#[cfg(target_arch = "wasm32")]
fn validate_fill_resource(
    style: &RenderStyle,
    image_resources: &BTreeMap<String, WasmImageResource>,
    hatch_resources: &WasmHatchResourceRegistry,
) -> Result<(), String> {
    match &style.fill {
        FillMode::Texture { resource_id } if !image_resources.contains_key(resource_id) => Err(
            format!("fill texture resource '{resource_id}' is not registered"),
        ),
        FillMode::Hatch { resource, .. }
            if hatch_resources.catalog.hatch_pattern(resource).is_none()
                || canonical_resource_ref_key(resource)
                    .ok()
                    .is_none_or(|key| !hatch_resources.gpu.contains_key(&key)) =>
        {
            Err(format!(
                "exact hatch resource revision '{}' is not registered",
                resource.resource_id
            ))
        }
        _ => Ok(()),
    }
}

#[cfg(target_arch = "wasm32")]
fn validate_stroke_resource(
    style: &RenderStyle,
    line_type_resources: &WasmLineTypeResourceRegistry,
) -> Result<(), String> {
    match &style.stroke.mode {
        StrokeMode::LineType { resource }
            if line_type_resources.catalog.line_type(resource).is_none()
                || canonical_resource_ref_key(resource)
                    .ok()
                    .is_none_or(|key| !line_type_resources.gpu.contains_key(&key)) =>
        {
            Err(format!(
                "exact line type resource revision '{}' is not registered",
                resource.resource_id
            ))
        }
        _ => Ok(()),
    }
}

#[cfg(target_arch = "wasm32")]
fn resolve_batch_presentation(
    style: &RenderStyle,
    exaggeration_datum: f64,
    kind: RenderProxyKind,
    batch: &GpuDrawBatch,
    image_resources: &BTreeMap<String, WasmImageResource>,
    hatch_resources: &WasmHatchResourceRegistry,
    line_type_resources: &WasmLineTypeResourceRegistry,
) -> Result<WasmResolvedBatchPresentation, String> {
    let origin = batch
        .batch_origin()
        .ok_or_else(|| "presentation batch has no stable world origin".to_owned())?;
    let mut gpu_style = GpuPresentationStyle::from_render_style(style, origin, exaggeration_datum)
        .map_err(|error| error.to_string())?;
    let mut texture = None;
    let mut line_type = None;
    let mut hatch = None;
    if fill_capable(kind) {
        match &style.fill {
            FillMode::None => gpu_style = gpu_style.with_fill_visible(false),
            FillMode::Color => {}
            FillMode::Texture { resource_id } => {
                if !batch.has_declared_texture_coordinates() {
                    return Err(format!(
                        "fill texture resource '{resource_id}' requires declared texture coordinates"
                    ));
                }
                texture = Some(
                    image_resources
                        .get(resource_id)
                        .ok_or_else(|| {
                            format!("fill texture resource '{resource_id}' is not registered")
                        })?
                        .texture
                        .clone(),
                );
            }
            FillMode::Hatch {
                resource,
                origin: pattern_origin,
                axis_u,
                axis_v,
                line_width,
                color,
            } => {
                let canonical =
                    hatch_resources
                        .catalog
                        .hatch_pattern(resource)
                        .ok_or_else(|| {
                            format!(
                                "exact hatch resource revision '{}' is not registered",
                                resource.resource_id
                            )
                        })?;
                validate_hatch_pattern_resource(canonical).map_err(|error| error.to_string())?;
                let key = canonical_resource_ref_key(resource)?;
                let gpu = hatch_resources.gpu.get(&key).ok_or_else(|| {
                    format!(
                        "exact GPU hatch resource revision '{}' is not registered",
                        resource.resource_id
                    )
                })?;
                gpu_style = gpu_style.with_hatch(
                    GpuHatchPattern::new(
                        *pattern_origin,
                        *axis_u,
                        *axis_v,
                        *line_width,
                        *color,
                        origin,
                    )
                    .map_err(|error| error.to_string())?,
                    gpu.pattern(),
                );
                hatch = Some(gpu.clone());
            }
        }
    }
    if kind == RenderProxyKind::CadStroke {
        if let StrokeMode::LineType { resource } = &style.stroke.mode {
            let canonical = line_type_resources
                .catalog
                .line_type(resource)
                .ok_or_else(|| {
                    format!(
                        "exact line type resource revision '{}' is not registered",
                        resource.resource_id
                    )
                })?;
            validate_line_type_resource(canonical).map_err(|error| error.to_string())?;
            let key = canonical_resource_ref_key(resource)?;
            let gpu = line_type_resources.gpu.get(&key).ok_or_else(|| {
                format!(
                    "exact GPU line type resource revision '{}' is not registered",
                    resource.resource_id
                )
            })?;
            gpu_style = gpu_style.with_line_type(gpu.pattern());
            line_type = Some(gpu.clone());
        }
    }
    Ok(WasmResolvedBatchPresentation {
        style: gpu_style,
        texture,
        line_type,
        hatch,
    })
}

#[cfg(target_arch = "wasm32")]
fn apply_batch_presentation(
    host: &GpuSurfaceHost<'_>,
    batch: &mut GpuDrawBatch,
    resolved: &WasmResolvedBatchPresentation,
) -> Result<(), String> {
    batch
        .rebind_presentation_texture(host.device(), host.renderer(), resolved.texture.as_ref())
        .map_err(|error| error.to_string())?;
    batch
        .rebind_line_type_resource(host.device(), host.renderer(), resolved.line_type.as_ref())
        .map_err(|error| error.to_string())?;
    batch
        .rebind_hatch_resource(host.device(), host.renderer(), resolved.hatch.as_ref())
        .map_err(|error| error.to_string())?;
    batch
        .update_material_style(host.queue(), &resolved.style)
        .map_err(|error| error.to_string())
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
fn compile_inline_entity(
    host: &GpuSurfaceHost<'_>,
    world: &mut RenderWorld,
    batches: &mut BTreeMap<RenderProxyId, Vec<GpuDrawBatch>>,
    request: &WasmEntityRenderRequest,
    origin: WorldVec3,
    glyph_atlases: &BTreeMap<String, WasmGlyphAtlasResource>,
    annotation_styles: &BTreeMap<String, WasmAnnotationStyle>,
    entity_requests: &BTreeMap<String, WasmEntityRenderRequest>,
    block_definitions: &BTreeMap<String, BlockDefinition>,
    block_member_styles: &BTreeMap<String, (CanonicalResourceRef, RenderStyle)>,
    block_attribute_tables: &BTreeSet<String>,
    block_member_entity_versions: &BTreeMap<String, (EntityVersionRef, WasmEntityRenderRequest)>,
    image_resources: &BTreeMap<String, WasmImageResource>,
    depth_resources: &BTreeMap<String, WasmDepthResource>,
    raster_binary_resources: &BTreeMap<String, WasmBinaryResource>,
    mesh_resources: &BTreeMap<String, TriangleMeshGeometry>,
    material_resources: &WasmMaterialResourceRegistry,
    hatch_resources: &WasmHatchResourceRegistry,
    line_type_resources: &WasmLineTypeResourceRegistry,
) -> Result<(), String> {
    if let GeometryObject::Block { instance } = &request.geometry {
        return compile_block_entity(
            host,
            world,
            batches,
            request,
            instance,
            origin,
            glyph_atlases,
            annotation_styles,
            entity_requests,
            block_definitions,
            block_member_styles,
            block_attribute_tables,
            block_member_entity_versions,
            image_resources,
            depth_resources,
            raster_binary_resources,
            mesh_resources,
            material_resources,
            hatch_resources,
            line_type_resources,
            &mut Vec::new(),
        );
    }
    let floating_origin =
        FloatingOrigin::from_selected(1_024.0, origin).map_err(|error| error.to_string())?;
    let options = compilation_options(request, floating_origin);
    validate_associative_area_references(request, entity_requests)?;
    let proxy_ids = entity_proxy_ids(
        request,
        entity_requests,
        block_definitions,
        block_member_styles,
        block_member_entity_versions,
    )?;
    let mut pick_slots = Vec::with_capacity(proxy_ids.len());
    for id in &proxy_ids {
        let slot = world
            .insert_proxy(placeholder_proxy(request, id.clone(), origin))
            .map_err(|error| error.to_string())?;
        pick_slots.push(slot);
    }
    let resolved_resource_geometry = resolve_registered_mesh_geometry(
        &request.geometry,
        request.evaluated_mesh_resource_ref.as_deref(),
        mesh_resources,
    )?;
    let compilation_geometry = resolved_resource_geometry
        .as_ref()
        .unwrap_or(&request.geometry);
    let compiled = compile_entity_geometry_with_associations(
        host.device(),
        host.queue(),
        host.renderer(),
        &request.proxy_id,
        compilation_geometry,
        &pick_slots,
        &options,
        |entity_id, expected_version| {
            associative_curve_in_area_frame(request, entity_requests, entity_id, expected_version)
        },
    );
    let compiled = match &request.geometry {
        GeometryObject::Text { text } => vec![compile_text_entity(
            host,
            request,
            text,
            pick_slots[0],
            floating_origin,
            glyph_atlases,
        )?],
        GeometryObject::Label { label } => compile_label_entity(
            host,
            request,
            label,
            &pick_slots,
            floating_origin,
            glyph_atlases,
        )?,
        GeometryObject::Dimension { dimension } => compile_dimension_entity(
            host,
            request,
            dimension,
            &pick_slots,
            floating_origin,
            glyph_atlases,
            annotation_styles,
            entity_requests,
        )?,
        GeometryObject::Solid { solid } if solid_requires_evaluated_mesh(solid) => {
            vec![compile_evaluated_mesh_entity(
                host,
                request,
                solid,
                pick_slots[0],
                floating_origin,
                mesh_resources,
            )?]
        }
        GeometryObject::Panorama { panorama } => vec![compile_panorama_entity(
            host,
            request,
            panorama,
            pick_slots[0],
            floating_origin,
        )?],
        GeometryObject::RasterImage { raster } => vec![compile_raster_image_entity(
            host,
            request,
            raster,
            pick_slots[0],
            floating_origin,
            image_resources,
            depth_resources,
            raster_binary_resources,
        )?],
        _ => compiled.map_err(|error| error.to_string())?,
    };
    validate_fill_resource(&request.style, image_resources, hatch_resources)?;
    validate_stroke_resource(&request.style, line_type_resources)?;
    for (id, part) in proxy_ids.into_iter().zip(compiled) {
        world
            .set_compiled_metadata(&id, part.kind, part.bounds, part.cost)
            .map_err(|error| error.to_string())?;
        let mut proxy_batches = Vec::with_capacity(1 + part.additional_batches.len());
        proxy_batches.push(part.batch);
        proxy_batches.extend(part.additional_batches);
        for batch in &mut proxy_batches {
            batch
                .set_world_origins(host.queue(), origin, origin)
                .map_err(|error| error.to_string())?;
            apply_canonical_mesh_material(
                host,
                batch,
                part.source_material_table.as_ref(),
                material_resources,
            )?;
            let resolved = resolve_batch_presentation(
                &request.style,
                request.exaggeration_datum,
                part.kind,
                batch,
                image_resources,
                hatch_resources,
                line_type_resources,
            )?;
            apply_batch_presentation(host, batch, &resolved)?;
        }
        batches.insert(id, proxy_batches);
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn apply_canonical_mesh_material(
    host: &GpuSurfaceHost<'_>,
    batch: &mut GpuDrawBatch,
    table_ref: Option<&CanonicalResourceRef>,
    resources: &WasmMaterialResourceRegistry,
) -> Result<(), String> {
    let Some(table_ref) = table_ref else {
        if batch.source_material_slot().is_some() {
            return Err("material-partitioned batch has no canonical material table".to_owned());
        }
        return Ok(());
    };
    let table = resources.catalog.material_table(table_ref).ok_or_else(|| {
        format!(
            "exact material-table revision '{}' is not registered",
            table_ref.resource_id
        )
    })?;
    let slot = usize::try_from(batch.source_material_slot().unwrap_or(0))
        .map_err(|_| "canonical material slot does not fit this host".to_owned())?;
    let material_ref = table.materials.get(slot).ok_or_else(|| {
        format!(
            "canonical material slot {slot} is outside table '{}'",
            table.resource_id
        )
    })?;
    let material = resources.catalog.material(material_ref).ok_or_else(|| {
        format!(
            "exact material revision '{}' is not registered",
            material_ref.resource_id
        )
    })?;
    let resolve_texture = |slot| -> Result<Option<GpuCanonicalTextureBinding<'_>>, String> {
        material
            .texture_bindings
            .iter()
            .find(|binding| binding.slot == slot)
            .map(|binding| {
                if binding.texture_coordinate_set >= batch.declared_texture_coordinate_sets() {
                    return Err(format!(
                        "canonical {:?} texture '{}' requires an unavailable UV set",
                        slot, binding.texture.resource_id
                    ));
                }
                if !batch.has_declared_texture_coordinates() {
                    return Err(format!(
                        "canonical {:?} texture '{}' requires declared mesh UVs",
                        slot, binding.texture.resource_id
                    ));
                }
                resources.catalog.texture(&binding.texture).ok_or_else(|| {
                    format!(
                        "exact texture revision '{}' is not registered",
                        binding.texture.resource_id
                    )
                })?;
                let key = canonical_resource_ref_key(&binding.texture)?;
                let texture = resources.gpu_textures.get(&key).ok_or_else(|| {
                    format!(
                        "exact GPU texture revision '{}' is not registered",
                        binding.texture.resource_id
                    )
                })?;
                let transform =
                    binding
                        .transform
                        .map_or_else(GpuTextureTransform::default, |value| GpuTextureTransform {
                            offset: value.offset,
                            scale: value.scale,
                            rotation: value.rotation,
                        });
                Ok(GpuCanonicalTextureBinding {
                    texture,
                    texture_coordinate_set: binding.texture_coordinate_set,
                    transform,
                })
            })
            .transpose()
    };
    let base_color_texture = resolve_texture(MaterialTextureSlot::BaseColor)?;
    let normal_texture = resolve_texture(MaterialTextureSlot::Normal)?;
    let metallic_roughness_texture = resolve_texture(MaterialTextureSlot::MetallicRoughness)?;
    let emissive_texture = resolve_texture(MaterialTextureSlot::Emissive)?;
    let occlusion_texture = resolve_texture(MaterialTextureSlot::Occlusion)?;
    let alpha_mode = match material.alpha_mode {
        MaterialAlphaMode::Opaque => GpuAlphaMode::Opaque,
        MaterialAlphaMode::Mask => GpuAlphaMode::Mask {
            cutoff: material
                .alpha_cutoff
                .expect("canonical material validation requires a mask cutoff"),
        },
        MaterialAlphaMode::Blend => GpuAlphaMode::Blend,
    };
    batch
        .set_source_material(
            host.device(),
            host.queue(),
            host.renderer(),
            &GpuCanonicalMaterial {
                base_color: [
                    material.base_color.red,
                    material.base_color.green,
                    material.base_color.blue,
                    material.base_color.alpha,
                ],
                emissive: material.emissive,
                metallic: material.metallic,
                roughness: material.roughness,
                alpha_mode,
                double_sided: material.double_sided,
                base_color_texture,
                normal_texture,
                metallic_roughness_texture,
                emissive_texture,
                occlusion_texture,
            },
        )
        .map_err(|error| error.to_string())
}

#[cfg(target_arch = "wasm32")]
fn compile_label_entity(
    host: &GpuSurfaceHost<'_>,
    request: &WasmEntityRenderRequest,
    label: &himmelcad_core::entity_model::LabelGeometry,
    pick_slots: &[u32],
    floating_origin: FloatingOrigin,
    glyph_atlases: &BTreeMap<String, WasmGlyphAtlasResource>,
) -> Result<Vec<himmelcad_render::CompiledEntityPart>, String> {
    let mut parts = vec![compile_text_entity(
        host,
        request,
        &label.text,
        pick_slots[0],
        floating_origin,
        glyph_atlases,
    )?];
    if label.leader.len() >= 2 {
        let geometry = GeometryObject::Curve {
            curve: Box::new(himmelcad_core::entity_model::CurveGeometry::Polyline {
                positions: label.leader.clone(),
                closed: false,
            }),
        };
        let mut leader = compile_entity_geometry(
            host.device(),
            host.queue(),
            host.renderer(),
            &format!("{}-leader", request.proxy_id),
            &geometry,
            &pick_slots[1..2],
            &compilation_options(request, floating_origin),
        )
        .map_err(|error| error.to_string())?;
        parts.append(&mut leader);
    }
    Ok(parts)
}

#[cfg(target_arch = "wasm32")]
fn solid_requires_evaluated_mesh(solid: &SolidGeometry) -> bool {
    !matches!(
        solid,
        SolidGeometry::ClosedMesh { .. }
            | SolidGeometry::Csg {
                root: himmelcad_core::entity_model::CsgNode::Primitive { .. }
            }
            | SolidGeometry::Extrusion { .. }
    )
}

#[cfg(target_arch = "wasm32")]
fn compile_evaluated_mesh_entity(
    host: &GpuSurfaceHost<'_>,
    request: &WasmEntityRenderRequest,
    solid: &SolidGeometry,
    pick_slot: u32,
    floating_origin: FloatingOrigin,
    mesh_resources: &BTreeMap<String, TriangleMeshGeometry>,
) -> Result<himmelcad_render::CompiledEntityPart, String> {
    let mesh = evaluated_mesh_for_solid(request, solid, mesh_resources)?;
    let geometry = GeometryObject::Surface3d {
        mesh: Box::new(mesh.clone()),
    };
    let mut parts = compile_entity_geometry(
        host.device(),
        host.queue(),
        host.renderer(),
        &request.proxy_id,
        &geometry,
        &[pick_slot],
        &compilation_options(request, floating_origin),
    )
    .map_err(|error| error.to_string())?;
    parts
        .pop()
        .ok_or_else(|| "evaluated solid mesh compiler returned no geometry".to_owned())
}

#[cfg(target_arch = "wasm32")]
fn evaluated_mesh_for_solid<'a>(
    request: &WasmEntityRenderRequest,
    solid: &SolidGeometry,
    mesh_resources: &'a BTreeMap<String, TriangleMeshGeometry>,
) -> Result<&'a TriangleMeshGeometry, String> {
    let mesh_hash = request
        .evaluated_mesh_resource_ref
        .as_deref()
        .or(match solid {
            SolidGeometry::Brep { resource } => Some(resource.object_hash.0.as_str()),
            _ => None,
        });
    let mesh_hash = mesh_hash.ok_or_else(|| {
        "solid requires an evaluated mesh resource authorized by its geometry binding".to_owned()
    })?;
    let mesh = mesh_resources
        .get(mesh_hash)
        .ok_or_else(|| "evaluated solid mesh resource is not registered".to_owned())?;
    Ok(mesh)
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments)]
fn compile_block_entity(
    host: &GpuSurfaceHost<'_>,
    world: &mut RenderWorld,
    batches: &mut BTreeMap<RenderProxyId, Vec<GpuDrawBatch>>,
    request: &WasmEntityRenderRequest,
    instance: &himmelcad_core::entity_model::BlockInstanceGeometry,
    origin: WorldVec3,
    glyph_atlases: &BTreeMap<String, WasmGlyphAtlasResource>,
    annotation_styles: &BTreeMap<String, WasmAnnotationStyle>,
    entity_requests: &BTreeMap<String, WasmEntityRenderRequest>,
    block_definitions: &BTreeMap<String, BlockDefinition>,
    block_member_styles: &BTreeMap<String, (CanonicalResourceRef, RenderStyle)>,
    block_attribute_tables: &BTreeSet<String>,
    block_member_entity_versions: &BTreeMap<String, (EntityVersionRef, WasmEntityRenderRequest)>,
    image_resources: &BTreeMap<String, WasmImageResource>,
    depth_resources: &BTreeMap<String, WasmDepthResource>,
    raster_binary_resources: &BTreeMap<String, WasmBinaryResource>,
    mesh_resources: &BTreeMap<String, TriangleMeshGeometry>,
    material_resources: &WasmMaterialResourceRegistry,
    hatch_resources: &WasmHatchResourceRegistry,
    line_type_resources: &WasmLineTypeResourceRegistry,
    stack: &mut Vec<String>,
) -> Result<(), String> {
    validate_block_instance_attribute_refs(instance, block_attribute_tables)?;
    let definition = resolve_block_definition(instance, block_definitions)?;
    let definition_key =
        block_definition_key(&definition.definition_id, &definition.content_hash.0);
    if stack.contains(&definition_key) {
        return Err(format!(
            "cyclic block definition reference: {} -> {}",
            stack.join(" -> "),
            definition_key
        ));
    }
    stack.push(definition_key);
    let result = definition.members.iter().try_for_each(|member| {
        let member_request = block_member_request(
            request,
            instance,
            member,
            block_member_entity_versions,
            block_member_styles,
        )?;
        if let GeometryObject::Block { instance: nested } = &member_request.geometry {
            compile_block_entity(
                host,
                world,
                batches,
                &member_request,
                nested,
                origin,
                glyph_atlases,
                annotation_styles,
                entity_requests,
                block_definitions,
                block_member_styles,
                block_attribute_tables,
                block_member_entity_versions,
                image_resources,
                depth_resources,
                raster_binary_resources,
                mesh_resources,
                material_resources,
                hatch_resources,
                line_type_resources,
                stack,
            )
        } else {
            compile_inline_entity(
                host,
                world,
                batches,
                &member_request,
                origin,
                glyph_atlases,
                annotation_styles,
                entity_requests,
                block_definitions,
                block_member_styles,
                block_attribute_tables,
                block_member_entity_versions,
                image_resources,
                depth_resources,
                raster_binary_resources,
                mesh_resources,
                material_resources,
                hatch_resources,
                line_type_resources,
            )
        }
    });
    stack.pop();
    result
}

#[cfg(target_arch = "wasm32")]
fn resolve_block_definition<'a>(
    instance: &himmelcad_core::entity_model::BlockInstanceGeometry,
    definitions: &'a BTreeMap<String, BlockDefinition>,
) -> Result<&'a BlockDefinition, String> {
    let key = block_definition_key(&instance.definition_id, &instance.definition_hash.0);
    let definition = definitions.get(&key).ok_or_else(|| {
        format!(
            "block definition '{}' is not registered",
            instance.definition_id
        )
    })?;
    if definition.content_hash != instance.definition_hash {
        return Err(format!(
            "block definition '{}' version does not match the instance",
            instance.definition_id
        ));
    }
    if let Some(overrides) = &instance.overrides {
        if overrides.members.iter().any(|override_| {
            !definition
                .members
                .iter()
                .any(|member| member.member_id == override_.member_id)
        }) {
            return Err(format!(
                "block instance override targets an unknown member in definition '{}'",
                instance.definition_id
            ));
        }
    }
    Ok(definition)
}

#[cfg(target_arch = "wasm32")]
fn block_definition_key(definition_id: &str, definition_hash: &str) -> String {
    format!("{}:{definition_id}{definition_hash}", definition_id.len())
}

#[cfg(target_arch = "wasm32")]
fn canonical_resource_ref_key(resource: &CanonicalResourceRef) -> Result<String, String> {
    serde_json::to_string(resource).map_err(|error| error.to_string())
}

#[cfg(target_arch = "wasm32")]
fn canonical_entity_version_ref_key(reference: &EntityVersionRef) -> Result<String, String> {
    serde_json::to_string(reference).map_err(|error| error.to_string())
}

#[cfg(target_arch = "wasm32")]
fn block_member_request(
    request: &WasmEntityRenderRequest,
    instance: &himmelcad_core::entity_model::BlockInstanceGeometry,
    member: &BlockMember,
    block_member_entity_versions: &BTreeMap<String, (EntityVersionRef, WasmEntityRenderRequest)>,
    block_member_styles: &BTreeMap<String, (CanonicalResourceRef, RenderStyle)>,
) -> Result<WasmEntityRenderRequest, String> {
    let (mut source, source_placement) = match &member.source {
        BlockMemberSource::Inline { geometry } => (
            WasmEntityRenderRequest {
                entity_id: request.entity_id.clone(),
                proxy_id: request.proxy_id.clone(),
                version_hash: request.version_hash.clone(),
                source_revision: request.source_revision,
                attributes_ref: None,
                evaluated_mesh_resource_ref: None,
                geometry: geometry.clone(),
                style: RenderStyle::default(),
                placement: None,
                locked_plan_elevation: request.locked_plan_elevation,
                chord_tolerance: request.chord_tolerance,
                maximum_curve_segments: request.maximum_curve_segments,
                line_width: request.line_width,
                plane_extent: request.plane_extent,
                fill_areas: request.fill_areas,
                exaggeration_datum: request.exaggeration_datum,
            },
            Transform3d::IDENTITY,
        ),
        BlockMemberSource::EntityReference { entity } => {
            let key = canonical_entity_version_ref_key(entity)?;
            let (registered_ref, source) =
                block_member_entity_versions.get(&key).ok_or_else(|| {
                    format!(
                        "block member entity '{}' revision is not captured",
                        entity.id.0
                    )
                })?;
            if registered_ref != entity {
                return Err("block member entity capture revision mismatch".to_owned());
            }
            (
                source.clone(),
                source.placement.unwrap_or(Transform3d::IDENTITY),
            )
        }
    };
    apply_block_member_style(&mut source.style, &member.style, block_member_styles)?;
    apply_block_member_attributes(&mut source.attributes_ref, &member.attributes);
    if let Some(overrides) = &instance.overrides {
        apply_block_member_style(&mut source.style, &overrides.style, block_member_styles)?;
        apply_block_member_attributes(&mut source.attributes_ref, &overrides.attributes);
        if let Some(member_override) = overrides
            .members
            .iter()
            .find(|candidate| candidate.member_id == member.member_id)
        {
            apply_block_member_style(
                &mut source.style,
                &member_override.style,
                block_member_styles,
            )?;
            apply_block_member_attributes(&mut source.attributes_ref, &member_override.attributes);
        }
    }
    let parent = DMat4::from_cols_array(&request.placement.unwrap_or(Transform3d::IDENTITY).0);
    let instance = DMat4::from_cols_array(&instance.placement.0);
    let member_placement = DMat4::from_cols_array(&member.placement.0);
    let source_placement = DMat4::from_cols_array(&source_placement.0);
    let placement = parent * instance * member_placement * source_placement;
    if !placement.is_finite() || placement.determinant().abs() <= f64::EPSILON {
        return Err("block member placement is non-invertible".to_owned());
    }
    if request.style != RenderStyle::default() {
        source.style = request.style.clone();
    }
    source.entity_id.clone_from(&request.entity_id);
    source.proxy_id = format!(
        "{}#member{}:{}",
        request.proxy_id,
        member.member_id.len(),
        member.member_id
    );
    source.version_hash.clone_from(&request.version_hash);
    source.source_revision = request.source_revision;
    source.placement = Some(Transform3d(placement.to_cols_array()));
    source.exaggeration_datum = request.exaggeration_datum;
    Ok(source)
}

#[cfg(target_arch = "wasm32")]
fn apply_block_member_style(
    target: &mut RenderStyle,
    assignment: &BlockMemberStyle,
    block_member_styles: &BTreeMap<String, (CanonicalResourceRef, RenderStyle)>,
) -> Result<(), String> {
    match assignment {
        BlockMemberStyle::Inherit => Ok(()),
        BlockMemberStyle::Clear => {
            *target = RenderStyle::default();
            Ok(())
        }
        BlockMemberStyle::Resource { style } => {
            let key = canonical_resource_ref_key(style)?;
            let (registered_ref, registered_style) =
                block_member_styles.get(&key).ok_or_else(|| {
                    format!(
                        "block member style resource '{}' is not registered",
                        style.resource_id
                    )
                })?;
            if registered_ref != style {
                return Err("block member style resource revision mismatch".to_owned());
            }
            target.clone_from(registered_style);
            Ok(())
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn apply_block_member_attributes(
    target: &mut Option<ObjectHash>,
    assignment: &BlockMemberAttributes,
) {
    match assignment {
        BlockMemberAttributes::Inherit => {}
        BlockMemberAttributes::Clear => *target = None,
        BlockMemberAttributes::Replace { attributes_ref } => {
            *target = Some(attributes_ref.clone());
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn validate_block_instance_attribute_refs(
    instance: &himmelcad_core::entity_model::BlockInstanceGeometry,
    registered: &BTreeSet<String>,
) -> Result<(), String> {
    let Some(overrides) = &instance.overrides else {
        return Ok(());
    };
    let assignments = std::iter::once(&overrides.attributes)
        .chain(overrides.members.iter().map(|member| &member.attributes));
    for assignment in assignments {
        if let BlockMemberAttributes::Replace { attributes_ref } = assignment {
            if !registered.contains(attributes_ref.as_str()) {
                return Err(format!(
                    "block attribute table '{}' is not registered",
                    attributes_ref.as_str()
                ));
            }
        }
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments)]
fn compile_dimension_entity(
    host: &GpuSurfaceHost<'_>,
    request: &WasmEntityRenderRequest,
    dimension: &DimensionGeometry,
    pick_slots: &[u32],
    floating_origin: FloatingOrigin,
    glyph_atlases: &BTreeMap<String, WasmGlyphAtlasResource>,
    annotation_styles: &BTreeMap<String, WasmAnnotationStyle>,
    entity_requests: &BTreeMap<String, WasmEntityRenderRequest>,
) -> Result<Vec<himmelcad_render::CompiledEntityPart>, String> {
    let style = annotation_styles
        .get(&dimension.style.object_hash.0)
        .ok_or_else(|| "dimension annotation style is not registered".to_owned())?;
    let anchors = dimension
        .anchors
        .iter()
        .map(|anchor| resolve_annotation_anchor(anchor, request, entity_requests, floating_origin))
        .collect::<Result<Vec<_>, _>>()?;
    let placement = transform_authored_position(dimension.placement, request)?;
    let value = dimension_measurement(dimension.dimension_kind, &anchors)?;
    let formatted = format!("{:.*}", usize::from(style.decimals), value);
    let text = TextGeometry {
        text: format!("{}{}{}", style.prefix, formatted, style.suffix),
        anchor: position_from_world(placement),
        space: if style.screen_space {
            TextSpace::Screen
        } else {
            TextSpace::World
        },
        height: style.text_height,
        font: GeometryResource {
            object_hash: himmelcad_core::hash::ObjectHash(style.glyph_atlas_hash.clone()),
            media_type: "application/vnd.himmelcad.glyph-atlas+rgba8".to_owned(),
            byte_length: None,
        },
    };
    let mut world_request = request.clone();
    world_request.placement = None;
    world_request.line_width = style.line_width;
    let text_part = compile_text_entity(
        host,
        &world_request,
        &text,
        pick_slots[0],
        floating_origin,
        glyph_atlases,
    )?;
    let line_positions = dimension_line_positions(dimension.dimension_kind, &anchors, placement)?;
    let line_geometry = GeometryObject::Curve {
        curve: Box::new(CurveGeometry::Polyline {
            positions: line_positions
                .into_iter()
                .map(position_from_world)
                .collect(),
            closed: false,
        }),
    };
    let mut line_parts = compile_entity_geometry(
        host.device(),
        host.queue(),
        host.renderer(),
        &format!("{}-dimension-lines", request.proxy_id),
        &line_geometry,
        &pick_slots[1..2],
        &compilation_options(&world_request, floating_origin),
    )
    .map_err(|error| error.to_string())?;
    let line_part = line_parts
        .pop()
        .ok_or_else(|| "dimension line compiler returned no geometry".to_owned())?;
    Ok(vec![text_part, line_part])
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments)]
fn compile_panorama_entity(
    host: &GpuSurfaceHost<'_>,
    request: &WasmEntityRenderRequest,
    panorama: &PanoramaGeometry,
    pick_slot: u32,
    floating_origin: FloatingOrigin,
) -> Result<himmelcad_render::CompiledEntityPart, String> {
    let pose = match &panorama.image.mapping {
        RasterMapping::Camera { pose, .. } => *pose,
        _ => return Err("panorama requires a camera raster mapping".to_owned()),
    };
    let station = panorama_station_position(pose)?;
    let geometry = GeometryObject::Point { position: station };
    let mut parts = compile_entity_geometry(
        host.device(),
        host.queue(),
        host.renderer(),
        &request.proxy_id,
        &geometry,
        &[pick_slot],
        &compilation_options(request, floating_origin),
    )
    .map_err(|error| error.to_string())?;
    parts
        .pop()
        .ok_or_else(|| "panorama station compiler returned no marker".to_owned())
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments)]
fn compile_panorama_analysis_batch(
    host: &GpuSurfaceHost<'_>,
    request: &WasmEntityRenderRequest,
    raster: &himmelcad_core::entity_model::RasterImageGeometry,
    pick_slot: u32,
    floating_origin: WorldVec3,
    image_resources: &BTreeMap<String, WasmImageResource>,
    hatch_resources: &WasmHatchResourceRegistry,
    line_type_resources: &WasmLineTypeResourceRegistry,
) -> Result<(GpuDrawBatch, ResourceCost), String> {
    let image = image_resources
        .get(&raster.pixels.object_hash.0)
        .ok_or_else(|| "panorama image resource is not registered".to_owned())?;
    if image.width != raster.width || image.height != raster.height {
        return Err("panorama dimensions do not match its image resource".to_owned());
    }
    let pose = match &raster.mapping {
        RasterMapping::Camera {
            model: CameraModel::Equirectangular,
            pose,
        } => *pose,
        _ => return Err("panorama analysis requires an equirectangular camera".to_owned()),
    };
    let floating_origin = FloatingOrigin::from_selected(1_024.0, floating_origin)
        .map_err(|error| error.to_string())?;
    let mesh = panorama_analysis_mesh(raster, pose, request.plane_extent)?;
    let mut analysis_request = request.clone();
    analysis_request.style.vertical_exaggeration = 1.0;
    analysis_request.exaggeration_datum = 0.0;
    let geometry = GeometryObject::Surface3d {
        mesh: Box::new(mesh),
    };
    let mut parts = compile_entity_geometry(
        host.device(),
        host.queue(),
        host.renderer(),
        &format!("{}-analysis", request.proxy_id),
        &geometry,
        &[pick_slot],
        &compilation_options(&analysis_request, floating_origin),
    )
    .map_err(|error| error.to_string())?;
    let part = parts
        .pop()
        .ok_or_else(|| "panorama analysis compiler returned no mesh".to_owned())?;
    let style = GpuPresentationStyle::from_render_style(
        &analysis_request.style,
        floating_origin.world(),
        analysis_request.exaggeration_datum,
    )
    .map_err(|error| error.to_string())?;
    let alpha_mode = if analysis_request.style.opacity < 1.0 {
        GpuAlphaMode::Blend
    } else {
        GpuAlphaMode::Opaque
    };
    let material = host
        .renderer()
        .create_styled_material_from_texture(
            host.device(),
            host.queue(),
            &format!("{}-panorama-analysis-material", request.proxy_id),
            &image.texture,
            alpha_mode,
            style,
        )
        .map_err(|error| error.to_string())?;
    let cost = ResourceCost {
        gpu_texture_bytes: 0,
        ..part.cost
    };
    let mut batch = part.batch.with_material(material);
    batch
        .set_world_origins(
            host.queue(),
            floating_origin.world(),
            floating_origin.world(),
        )
        .map_err(|error| error.to_string())?;
    let resolved = resolve_batch_presentation(
        &analysis_request.style,
        analysis_request.exaggeration_datum,
        RenderProxyKind::Raster,
        &batch,
        image_resources,
        hatch_resources,
        line_type_resources,
    )?;
    apply_batch_presentation(host, &mut batch, &resolved)?;
    Ok((batch, cost))
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments)]
fn compile_oriented_image_analysis_batch(
    host: &GpuSurfaceHost<'_>,
    request: &WasmEntityRenderRequest,
    raster: &himmelcad_core::entity_model::RasterImageGeometry,
    pick_slot: u32,
    floating_origin: WorldVec3,
    image_resources: &BTreeMap<String, WasmImageResource>,
    depth_resources: &BTreeMap<String, WasmDepthResource>,
    raster_binary_resources: &BTreeMap<String, WasmBinaryResource>,
    hatch_resources: &WasmHatchResourceRegistry,
    line_type_resources: &WasmLineTypeResourceRegistry,
) -> Result<(GpuDrawBatch, ResourceCost), String> {
    let floating_origin = FloatingOrigin::from_selected(1_024.0, floating_origin)
        .map_err(|error| error.to_string())?;
    let mut analysis_request = request.clone();
    analysis_request.style.vertical_exaggeration = 1.0;
    analysis_request.exaggeration_datum = 0.0;
    let part = compile_raster_image_entity(
        host,
        &analysis_request,
        raster,
        pick_slot,
        floating_origin,
        image_resources,
        depth_resources,
        raster_binary_resources,
    )?;
    let cost = ResourceCost {
        gpu_texture_bytes: 0,
        ..part.cost
    };
    let mut batch = part.batch;
    batch
        .set_world_origins(
            host.queue(),
            floating_origin.world(),
            floating_origin.world(),
        )
        .map_err(|error| error.to_string())?;
    let resolved = resolve_batch_presentation(
        &analysis_request.style,
        analysis_request.exaggeration_datum,
        RenderProxyKind::Raster,
        &batch,
        image_resources,
        hatch_resources,
        line_type_resources,
    )?;
    apply_batch_presentation(host, &mut batch, &resolved)?;
    Ok((batch, cost))
}

#[cfg(target_arch = "wasm32")]
fn panorama_analysis_mesh(
    raster: &himmelcad_core::entity_model::RasterImageGeometry,
    pose: Transform3d,
    radius: f64,
) -> Result<TriangleMeshGeometry, String> {
    if !radius.is_finite() || radius <= 0.0 {
        return Err("panorama presentation radius must be finite and positive".to_owned());
    }
    let pose = DMat4::from_cols_array(&pose.0);
    if !pose.is_finite() || pose.determinant().abs() <= f64::EPSILON {
        return Err("panorama camera pose is non-invertible".to_owned());
    }
    let longitude_segments = raster.width.clamp(16, 128);
    let latitude_segments = raster.height.clamp(8, 64);
    let row_width = longitude_segments + 1;
    let mut positions = Vec::with_capacity(
        usize::try_from(u64::from(row_width) * u64::from(latitude_segments + 1))
            .map_err(|_| "panorama analysis mesh is too large")?,
    );
    let mut normals = Vec::with_capacity(positions.capacity());
    let mut texture_coordinates = Vec::with_capacity(positions.capacity());
    for row in 0..=latitude_segments {
        let v = f64::from(row) / f64::from(latitude_segments);
        let latitude = (v - 0.5) * std::f64::consts::PI;
        let planar = latitude.cos();
        for column in 0..=longitude_segments {
            let u = f64::from(column) / f64::from(longitude_segments);
            let longitude = (u - 0.5) * std::f64::consts::TAU;
            let direction = DVec3::new(
                planar * longitude.sin(),
                latitude.sin(),
                planar * longitude.cos(),
            );
            positions.push(vector3(pose.transform_point3(direction * radius)));
            normals.push(vector3(
                pose.transform_vector3(-direction).normalize_or_zero(),
            ));
            texture_coordinates.push([u, v]);
        }
    }
    let mut indices = Vec::new();
    for row in 0..latitude_segments {
        for column in 0..longitude_segments {
            let top_left = row * row_width + column;
            let top_right = top_left + 1;
            let bottom_left = (row + 1) * row_width + column;
            let bottom_right = bottom_left + 1;
            if row > 0 {
                indices.extend([top_left, bottom_right, top_right]);
            }
            if row + 1 < latitude_segments {
                indices.extend([top_left, bottom_left, bottom_right]);
            }
        }
    }
    raster_triangle_mesh(positions, indices, normals, texture_coordinates)
}

#[cfg(target_arch = "wasm32")]
fn panorama_station_position(pose: Transform3d) -> Result<Position, String> {
    let pose = DMat4::from_cols_array(&pose.0);
    if !pose.is_finite() || pose.determinant().abs() <= f64::EPSILON {
        return Err("panorama camera pose is non-invertible".to_owned());
    }
    let station = pose.transform_point3(DVec3::ZERO);
    Ok(Position {
        x: station.x,
        y: station.y,
        z: Some(station.z),
    })
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments)]
fn compile_raster_image_entity(
    host: &GpuSurfaceHost<'_>,
    request: &WasmEntityRenderRequest,
    raster: &himmelcad_core::entity_model::RasterImageGeometry,
    pick_slot: u32,
    floating_origin: FloatingOrigin,
    image_resources: &BTreeMap<String, WasmImageResource>,
    depth_resources: &BTreeMap<String, WasmDepthResource>,
    raster_binary_resources: &BTreeMap<String, WasmBinaryResource>,
) -> Result<himmelcad_render::CompiledEntityPart, String> {
    let image = image_resources
        .get(&raster.pixels.object_hash.0)
        .ok_or_else(|| "raster image resource is not registered".to_owned())?;
    if image.width != raster.width || image.height != raster.height {
        return Err("raster dimensions do not match its image resource".to_owned());
    }
    let depth = raster
        .depth
        .as_ref()
        .map(|field| {
            depth_resources
                .get(&field.values.object_hash.0)
                .ok_or_else(|| "raster depth resource is not registered".to_owned())
        })
        .transpose()?;
    if depth.is_some_and(|depth| depth.width != raster.width || depth.height != raster.height) {
        return Err("raster depth dimensions do not match the image".to_owned());
    }
    let validity = resolve_raster_validity(
        raster.depth.as_ref(),
        raster.width,
        raster.height,
        raster_binary_resources,
    )?;
    validate_raster_confidence(
        raster.depth.as_ref(),
        raster.width,
        raster.height,
        raster_binary_resources,
    )?;
    let wraps_horizontally = matches!(
        &raster.mapping,
        RasterMapping::Camera {
            model: CameraModel::Equirectangular,
            ..
        }
    );
    let connectivity = resolve_raster_connectivity_mask(
        raster.depth.as_ref(),
        raster.width,
        raster.height,
        wraps_horizontally,
        raster_binary_resources,
    )?;
    let mesh = match &raster.mapping {
        RasterMapping::OrthoGrid(mapping) => {
            if raster.depth.as_ref().is_some_and(|field| {
                !matches!(field.sampling.semantics, DepthSemantics::ElevationZ)
            }) {
                return Err("orthographic raster depth must use elevationZ semantics".to_owned());
            }
            raster_ortho_mesh(raster, *mapping, depth, validity, connectivity)?
        }
        RasterMapping::Planar { homography, frame } => {
            if raster.depth.is_some() {
                return Err("planar raster images cannot carry a depth field".to_owned());
            }
            raster_planar_mesh(raster, *homography, *frame)?
        }
        RasterMapping::Camera {
            model:
                CameraModel::Pinhole {
                    focal_x,
                    focal_y,
                    center_x,
                    center_y,
                    distortion_model,
                    ..
                },
            pose,
        } => {
            if distortion_model.is_some() {
                return Err(
                    "distorted camera raster requires a registered projection evaluator".to_owned(),
                );
            }
            raster_pinhole_presentation_mesh(
                raster,
                [*focal_x, *focal_y],
                [*center_x, *center_y],
                *pose,
                request.plane_extent,
            )?
        }
        RasterMapping::Camera {
            model: CameraModel::Equirectangular,
            ..
        } => {
            return Err(
                "equirectangular camera rasters require panorama station presentation".to_owned(),
            );
        }
        RasterMapping::Camera {
            model: CameraModel::Extension { .. },
            ..
        } => {
            return Err(
                "camera extension raster requires a registered projection evaluator".to_owned(),
            );
        }
    };
    let geometry = GeometryObject::Surface3d {
        mesh: Box::new(mesh),
    };
    let mut parts = compile_entity_geometry(
        host.device(),
        host.queue(),
        host.renderer(),
        &request.proxy_id,
        &geometry,
        &[pick_slot],
        &compilation_options(request, floating_origin),
    )
    .map_err(|error| error.to_string())?;
    let part = parts
        .pop()
        .ok_or_else(|| "raster mesh compiler returned no geometry".to_owned())?;
    let style = GpuPresentationStyle::from_render_style(
        &request.style,
        floating_origin.world(),
        request.exaggeration_datum,
    )
    .map_err(|error| error.to_string())?;
    let alpha_mode = if request.style.opacity < 1.0 {
        GpuAlphaMode::Blend
    } else {
        GpuAlphaMode::Opaque
    };
    let material = host
        .renderer()
        .create_styled_material_from_texture(
            host.device(),
            host.queue(),
            &format!("{}-raster-material", request.proxy_id),
            &image.texture,
            alpha_mode,
            style,
        )
        .map_err(|error| error.to_string())?;
    Ok(himmelcad_render::CompiledEntityPart {
        kind: RenderProxyKind::Raster,
        bounds: part.bounds,
        cost: ResourceCost {
            gpu_texture_bytes: u64::from(image.width)
                .saturating_mul(u64::from(image.height))
                .saturating_mul(4),
            ..part.cost
        },
        batch: part.batch.with_material(material),
        additional_batches: Vec::new(),
        source_material_table: None,
    })
}

#[cfg(target_arch = "wasm32")]
fn resolve_raster_validity<'a>(
    depth: Option<&himmelcad_core::entity_model::DepthField>,
    width: u32,
    height: u32,
    resources: &'a BTreeMap<String, WasmBinaryResource>,
) -> Result<Option<&'a [u8]>, String> {
    let Some(validity) = depth.and_then(|field| field.validity.as_ref()) else {
        return Ok(None);
    };
    let samples = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| "raster validity dimensions overflow".to_owned())?;
    let expected = usize::try_from(samples.saturating_add(7) / 8)
        .map_err(|_| "raster validity payload is too large".to_owned())?;
    verify_raster_binary_resource(&validity.resource, expected, resources, "validity").map(Some)
}

#[cfg(target_arch = "wasm32")]
fn validate_raster_confidence(
    depth: Option<&himmelcad_core::entity_model::DepthField>,
    width: u32,
    height: u32,
    resources: &BTreeMap<String, WasmBinaryResource>,
) -> Result<(), String> {
    let Some(confidence) = depth.and_then(|field| field.confidence.as_ref()) else {
        return Ok(());
    };
    let samples = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| "raster confidence dimensions overflow".to_owned())?;
    let stride = match confidence.encoding {
        RasterConfidenceEncoding::Unorm8 => 1,
        RasterConfidenceEncoding::Float32LittleEndian => 4,
    };
    let expected = usize::try_from(samples.saturating_mul(stride))
        .map_err(|_| "raster confidence payload is too large".to_owned())?;
    let bytes =
        verify_raster_binary_resource(&confidence.resource, expected, resources, "confidence")?;
    if matches!(
        confidence.encoding,
        RasterConfidenceEncoding::Float32LittleEndian
    ) && bytes.chunks_exact(4).any(|sample| {
        let value = f32::from_le_bytes(sample.try_into().expect("four bytes"));
        !value.is_finite() || !(0.0..=1.0).contains(&value)
    }) {
        return Err("raster confidence contains a value outside [0, 1]".to_owned());
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn raster_confidence_sample(
    depth: Option<&himmelcad_core::entity_model::DepthField>,
    width: u32,
    height: u32,
    sample_index: usize,
    resources: &BTreeMap<String, WasmBinaryResource>,
) -> Result<Option<f64>, String> {
    validate_raster_confidence(depth, width, height, resources)?;
    let Some(confidence) = depth.and_then(|field| field.confidence.as_ref()) else {
        return Ok(None);
    };
    let bytes = resources
        .get(&confidence.resource.object_hash.0)
        .ok_or_else(|| "raster confidence resource is not registered".to_owned())?;
    match confidence.encoding {
        RasterConfidenceEncoding::Unorm8 => bytes
            .bytes
            .get(sample_index)
            .map(|value| Some(f64::from(*value) / 255.0))
            .ok_or_else(|| "raster confidence sample is missing".to_owned()),
        RasterConfidenceEncoding::Float32LittleEndian => {
            let offset = sample_index
                .checked_mul(4)
                .ok_or_else(|| "raster confidence sample index overflow".to_owned())?;
            let sample = bytes
                .bytes
                .get(offset..offset + 4)
                .ok_or_else(|| "raster confidence sample is missing".to_owned())?;
            Ok(Some(f64::from(f32::from_le_bytes(
                sample.try_into().expect("four bytes"),
            ))))
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn resolve_raster_connectivity_mask<'a>(
    depth: Option<&himmelcad_core::entity_model::DepthField>,
    width: u32,
    height: u32,
    wraps_horizontally: bool,
    resources: &'a BTreeMap<String, WasmBinaryResource>,
) -> Result<Option<&'a [u8]>, String> {
    let Some(RasterConnectivity::Mask { resource, .. }) =
        depth.map(|field| &field.sampling.connectivity)
    else {
        return Ok(None);
    };
    let cell_columns = if wraps_horizontally {
        width
    } else {
        width.saturating_sub(1)
    };
    let cells = u64::from(cell_columns)
        .checked_mul(u64::from(height.saturating_sub(1)))
        .ok_or_else(|| "raster connectivity dimensions overflow".to_owned())?;
    let expected = usize::try_from(cells.saturating_mul(2).saturating_add(7) / 8)
        .map_err(|_| "raster connectivity payload is too large".to_owned())?;
    verify_raster_binary_resource(resource, expected, resources, "connectivity").map(Some)
}

#[cfg(target_arch = "wasm32")]
fn verify_raster_binary_resource<'a>(
    resource: &GeometryResource,
    expected_length: usize,
    resources: &'a BTreeMap<String, WasmBinaryResource>,
    role: &str,
) -> Result<&'a [u8], String> {
    let registered = resources
        .get(&resource.object_hash.0)
        .ok_or_else(|| format!("raster {role} resource is not registered"))?;
    if registered.bytes.len() != expected_length
        || resource.byte_length != u64::try_from(expected_length).ok()
        || ObjectHash::of_bytes(&registered.bytes) != resource.object_hash
    {
        return Err(format!(
            "raster {role} resource length or content hash is invalid"
        ));
    }
    Ok(&registered.bytes)
}

#[cfg(target_arch = "wasm32")]
fn raster_planar_mesh(
    raster: &himmelcad_core::entity_model::RasterImageGeometry,
    homography: [f64; 9],
    frame: himmelcad_core::entity_model::PlaneFrame,
) -> Result<TriangleMeshGeometry, String> {
    let vertex_columns = raster
        .width
        .checked_add(1)
        .ok_or_else(|| "planar raster width exceeds indexed geometry limits".to_owned())?;
    let vertex_rows = raster
        .height
        .checked_add(1)
        .ok_or_else(|| "planar raster height exceeds indexed geometry limits".to_owned())?;
    let count = u64::from(vertex_columns).saturating_mul(u64::from(vertex_rows));
    if count > u64::from(u32::MAX) {
        return Err("planar raster mesh exceeds indexed geometry limits".to_owned());
    }
    let origin = DVec3::new(frame.origin.x, frame.origin.y, frame.origin.z);
    let u_axis = DVec3::new(frame.u_axis.x, frame.u_axis.y, frame.u_axis.z);
    let v_axis = DVec3::new(frame.v_axis.x, frame.v_axis.y, frame.v_axis.z);
    let normal = u_axis.cross(v_axis).normalize_or_zero();
    if !normal.is_finite() || normal.length_squared() <= f64::EPSILON {
        return Err("planar raster frame is degenerate".to_owned());
    }
    let capacity = usize::try_from(count).map_err(|_| "planar raster mesh is too large")?;
    let mut positions = Vec::with_capacity(capacity);
    let mut texture_coordinates = Vec::with_capacity(capacity);
    for row in 0..vertex_rows {
        for column in 0..vertex_columns {
            let pixel_column = f64::from(column) - 0.5;
            let pixel_row = f64::from(row) - 0.5;
            let [u, v] = planar_homography_sample(homography, pixel_column, pixel_row)?;
            positions.push(vector3(origin + u_axis * u + v_axis * v));
            texture_coordinates.push([
                f64::from(column) / f64::from(raster.width),
                f64::from(row) / f64::from(raster.height),
            ]);
        }
    }
    let mut indices = Vec::with_capacity(
        usize::try_from(u64::from(raster.width) * u64::from(raster.height) * 6)
            .map_err(|_| "planar raster topology is too large")?,
    );
    for row in 0..raster.height {
        for column in 0..raster.width {
            let top_left = row * vertex_columns + column;
            let top_right = top_left + 1;
            let bottom_left = (row + 1) * vertex_columns + column;
            let bottom_right = bottom_left + 1;
            indices.extend([
                top_left,
                top_right,
                bottom_right,
                top_left,
                bottom_right,
                bottom_left,
            ]);
        }
    }
    raster_triangle_mesh(
        positions,
        indices,
        vec![vector3(normal); capacity],
        texture_coordinates,
    )
}

#[cfg(target_arch = "wasm32")]
fn planar_homography_sample(
    homography: [f64; 9],
    column: f64,
    row: f64,
) -> Result<[f64; 2], String> {
    // Canonical matrices are column-major: H * (column, row, 1).
    let u_h = homography[0] * column + homography[3] * row + homography[6];
    let v_h = homography[1] * column + homography[4] * row + homography[7];
    let w_h = homography[2] * column + homography[5] * row + homography[8];
    if !u_h.is_finite() || !v_h.is_finite() || !w_h.is_finite() || w_h.abs() <= f64::EPSILON {
        return Err("planar raster homography maps a pixel to infinity".to_owned());
    }
    Ok([u_h / w_h, v_h / w_h])
}

#[cfg(target_arch = "wasm32")]
fn raster_pinhole_presentation_mesh(
    raster: &himmelcad_core::entity_model::RasterImageGeometry,
    focal: [f64; 2],
    principal: [f64; 2],
    pose: Transform3d,
    optical_axis_distance: f64,
) -> Result<TriangleMeshGeometry, String> {
    if !optical_axis_distance.is_finite() || optical_axis_distance <= 0.0 {
        return Err("camera image presentation distance must be finite and positive".to_owned());
    }
    let pose = DMat4::from_cols_array(&pose.0);
    if !pose.is_finite() || pose.determinant().abs() <= f64::EPSILON {
        return Err("camera image pose is non-invertible".to_owned());
    }
    let pixel_edges = [
        (-0.5, -0.5),
        (f64::from(raster.width) - 0.5, -0.5),
        (
            f64::from(raster.width) - 0.5,
            f64::from(raster.height) - 0.5,
        ),
        (-0.5, f64::from(raster.height) - 0.5),
    ];
    let positions = pixel_edges
        .map(|(column, row)| {
            let camera = DVec3::new(
                (column - principal[0]) / focal[0] * optical_axis_distance,
                (row - principal[1]) / focal[1] * optical_axis_distance,
                optical_axis_distance,
            );
            vector3(pose.transform_point3(camera))
        })
        .to_vec();
    if positions.iter().any(|position| {
        !position.x.is_finite() || !position.y.is_finite() || !position.z.is_finite()
    }) {
        return Err("camera image presentation plane is non-finite".to_owned());
    }
    let normal = pose.transform_vector3(-DVec3::Z).normalize_or_zero();
    if !normal.is_finite() || normal.length_squared() <= f64::EPSILON {
        return Err("camera image presentation normal is invalid".to_owned());
    }
    raster_triangle_mesh(
        positions,
        vec![0, 2, 1, 0, 3, 2],
        vec![vector3(normal); 4],
        vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
    )
}

#[cfg(target_arch = "wasm32")]
fn raster_ortho_mesh(
    raster: &himmelcad_core::entity_model::RasterImageGeometry,
    mapping: himmelcad_core::entity_model::OrthoGridMapping,
    depth: Option<&WasmDepthResource>,
    validity: Option<&[u8]>,
    connectivity_mask: Option<&[u8]>,
) -> Result<TriangleMeshGeometry, String> {
    if raster.width < 2 || raster.height < 2 {
        return Err("raster mesh requires at least 2x2 pixels".to_owned());
    }
    let connectivity = raster
        .depth
        .as_ref()
        .map(|field| &field.sampling.connectivity);
    if matches!(connectivity, Some(RasterConnectivity::PixelSteps)) {
        return raster_ortho_pixel_steps(raster, mapping, depth, validity);
    }
    let count = u64::from(raster.width).saturating_mul(u64::from(raster.height));
    if count > u64::from(u32::MAX) {
        return Err("raster mesh exceeds indexed geometry limits".to_owned());
    }
    let mut positions = Vec::with_capacity(usize::try_from(count).unwrap_or(usize::MAX));
    let mut texture_coordinates = Vec::with_capacity(positions.capacity());
    let mut elevations = Vec::with_capacity(positions.capacity());
    for row in 0..raster.height {
        for column in 0..raster.width {
            let elevation = raster_elevation(depth, validity, raster.width, column, row);
            let mut position = ortho_grid_position(mapping, f64::from(column), f64::from(row));
            if let Some(elevation) = elevation {
                position.z = elevation;
            }
            positions.push(vector3(position));
            texture_coordinates.push([
                (f64::from(column) + 0.5) / f64::from(raster.width),
                (f64::from(row) + 0.5) / f64::from(raster.height),
            ]);
            elevations.push(depth.is_none().then_some(position.z).or(elevation));
        }
    }
    let (maximum_jump, diagonal) = match connectivity {
        Some(RasterConnectivity::Continuous {
            maximum_height_jump,
            diagonal,
        }) => (*maximum_height_jump, *diagonal),
        Some(RasterConnectivity::Mask { diagonal, .. }) => (None, *diagonal),
        _ => (None, RasterCellDiagonal::TopLeftToBottomRight),
    };
    let mut indices = Vec::new();
    for row in 0..raster.height - 1 {
        for column in 0..raster.width - 1 {
            let a = row * raster.width + column;
            let b = a + 1;
            let d = (row + 1) * raster.width + column;
            let c = d + 1;
            let triangles = raster_cell_triangles(a, b, c, d, diagonal);
            let cell_index = u64::from(row) * u64::from(raster.width - 1) + u64::from(column);
            for (triangle_index, triangle) in triangles.into_iter().enumerate() {
                if connectivity_mask.is_some_and(|mask| {
                    !raster_connectivity_triangle(mask, cell_index, triangle_index)
                }) {
                    continue;
                }
                let values = triangle.map(|index| elevations[index as usize]);
                let Some(values) = values.into_iter().collect::<Option<Vec<_>>>() else {
                    continue;
                };
                if maximum_jump.is_some_and(|limit| {
                    values.iter().copied().fold(f64::NEG_INFINITY, f64::max)
                        - values.iter().copied().fold(f64::INFINITY, f64::min)
                        > limit
                }) {
                    continue;
                }
                indices.extend(triangle);
            }
        }
    }
    raster_triangle_mesh(
        positions,
        indices,
        vec![
            Vector3 {
                x: 0.0,
                y: 0.0,
                z: 1.0
            };
            usize::try_from(count).unwrap_or(0)
        ],
        texture_coordinates,
    )
}

#[cfg(target_arch = "wasm32")]
fn raster_ortho_pixel_steps(
    raster: &himmelcad_core::entity_model::RasterImageGeometry,
    mapping: himmelcad_core::entity_model::OrthoGridMapping,
    depth: Option<&WasmDepthResource>,
    validity: Option<&[u8]>,
) -> Result<TriangleMeshGeometry, String> {
    let mut positions = Vec::new();
    let mut texture_coordinates = Vec::new();
    let mut indices = Vec::new();
    for row in 0..raster.height {
        for column in 0..raster.width {
            let Some(elevation) = raster_elevation(depth, validity, raster.width, column, row)
            else {
                continue;
            };
            let base = u32::try_from(positions.len())
                .map_err(|_| "raster pixel-step mesh is too large".to_owned())?;
            for (x, y) in [
                (f64::from(column) - 0.5, f64::from(row) - 0.5),
                (f64::from(column) + 0.5, f64::from(row) - 0.5),
                (f64::from(column) + 0.5, f64::from(row) + 0.5),
                (f64::from(column) - 0.5, f64::from(row) + 0.5),
            ] {
                let mut position = ortho_grid_position(mapping, x, y);
                position.z = elevation;
                positions.push(vector3(position));
                texture_coordinates.push([
                    (x + 0.5) / f64::from(raster.width),
                    (y + 0.5) / f64::from(raster.height),
                ]);
            }
            indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
        }
    }
    let normals = vec![
        Vector3 {
            x: 0.0,
            y: 0.0,
            z: 1.0
        };
        positions.len()
    ];
    raster_triangle_mesh(positions, indices, normals, texture_coordinates)
}

#[cfg(target_arch = "wasm32")]
fn raster_elevation(
    depth: Option<&WasmDepthResource>,
    validity: Option<&[u8]>,
    width: u32,
    column: u32,
    row: u32,
) -> Option<f64> {
    let depth = depth?;
    let index = usize::try_from(u64::from(row) * u64::from(width) + u64::from(column)).ok()?;
    if validity.is_some_and(|mask| !raster_validity_sample(mask, index)) {
        return None;
    }
    let elevation = f64::from(*depth.values.get(index)?);
    elevation.is_finite().then_some(elevation)
}

#[cfg(target_arch = "wasm32")]
fn raster_validity_sample(mask: &[u8], sample_index: usize) -> bool {
    mask.get(sample_index / 8)
        .is_some_and(|byte| byte & (1 << (sample_index % 8)) != 0)
}

#[cfg(target_arch = "wasm32")]
fn raster_connectivity_triangle(mask: &[u8], cell_index: u64, triangle_index: usize) -> bool {
    let bit_index = cell_index
        .saturating_mul(2)
        .saturating_add(u64::try_from(triangle_index).unwrap_or(u64::MAX));
    usize::try_from(bit_index / 8)
        .ok()
        .and_then(|byte_index| mask.get(byte_index))
        .is_some_and(|byte| byte & (1 << (bit_index % 8)) != 0)
}

#[cfg(target_arch = "wasm32")]
fn raster_cell_triangles(
    top_left: u32,
    top_right: u32,
    bottom_right: u32,
    bottom_left: u32,
    diagonal: RasterCellDiagonal,
) -> [[u32; 3]; 2] {
    match diagonal {
        RasterCellDiagonal::TopLeftToBottomRight => [
            [top_left, top_right, bottom_right],
            [top_left, bottom_right, bottom_left],
        ],
        RasterCellDiagonal::TopRightToBottomLeft => [
            [top_left, top_right, bottom_left],
            [top_right, bottom_right, bottom_left],
        ],
    }
}

#[cfg(target_arch = "wasm32")]
fn ortho_grid_position(
    mapping: himmelcad_core::entity_model::OrthoGridMapping,
    column: f64,
    row: f64,
) -> DVec3 {
    DVec3::new(mapping.origin.x, mapping.origin.y, mapping.origin.z)
        + DVec3::new(
            mapping.column_step.x,
            mapping.column_step.y,
            mapping.column_step.z,
        ) * column
        + DVec3::new(mapping.row_step.x, mapping.row_step.y, mapping.row_step.z) * row
}

#[cfg(target_arch = "wasm32")]
fn raster_triangle_mesh(
    positions: Vec<Vector3>,
    indices: Vec<u32>,
    normals: Vec<Vector3>,
    texture_coordinates: Vec<[f64; 2]>,
) -> Result<TriangleMeshGeometry, String> {
    if indices.is_empty() {
        return Err("raster contains no connected visible samples".to_owned());
    }
    Ok(TriangleMeshGeometry {
        storage: TriangleMeshStorage::Inline {
            positions,
            indices,
            normals: Some(normals),
            texture_coordinates: Some(vec![texture_coordinates]),
        },
        closed_manifold: false,
        triangle_material_slots: None,
        materials: None,
    })
}

#[cfg(target_arch = "wasm32")]
fn vector3(value: DVec3) -> Vector3 {
    Vector3 {
        x: value.x,
        y: value.y,
        z: value.z,
    }
}

#[cfg(target_arch = "wasm32")]
fn resolve_annotation_anchor(
    anchor: &AnnotationAnchor,
    dimension_request: &WasmEntityRenderRequest,
    entity_requests: &BTreeMap<String, WasmEntityRenderRequest>,
    floating_origin: FloatingOrigin,
) -> Result<WorldVec3, String> {
    match anchor {
        AnnotationAnchor::Position { position } => {
            transform_authored_position(*position, dimension_request)
        }
        AnnotationAnchor::Entity {
            entity_id,
            expected_version,
            primitive_id,
            parameter,
        } => {
            let source = entity_requests.get(&entity_id.0).ok_or_else(|| {
                format!("dimension anchor entity '{}' is not loaded", entity_id.0)
            })?;
            if let Some(expected) = expected_version {
                if source.version_hash.as_deref() != Some(expected.0.as_str()) {
                    return Err(format!(
                        "dimension anchor entity '{}' version does not match",
                        entity_id.0
                    ));
                }
            }
            if let GeometryObject::Point { position } = source.geometry {
                return transform_authored_position(position, source);
            }
            let curves = tessellate_entity_strokes(
                &source.geometry,
                &compilation_options(source, floating_origin),
            )
            .map_err(|error| error.to_string())?;
            let segments = curves
                .iter()
                .flat_map(|curve| curve.segments.iter())
                .filter(|segment| {
                    primitive_id.is_none_or(|id| u64::from(segment.primitive_slot) == id)
                })
                .collect::<Vec<_>>();
            if segments.is_empty() {
                return Err(format!(
                    "dimension anchor entity '{}' has no addressable stroke",
                    entity_id.0
                ));
            }
            point_along_segments(&segments, parameter.unwrap_or(0.0))
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn point_along_segments(
    segments: &[&himmelcad_render::TessellatedCurveSegment],
    parameter: f64,
) -> Result<WorldVec3, String> {
    if !parameter.is_finite() {
        return Err("dimension anchor parameter must be finite".to_owned());
    }
    let lengths = segments
        .iter()
        .map(|segment| (dvec3(segment.end) - dvec3(segment.start)).length())
        .collect::<Vec<_>>();
    let total = lengths.iter().sum::<f64>();
    if total <= f64::EPSILON {
        return Ok(segments[0].start);
    }
    let mut remaining = parameter.clamp(0.0, 1.0) * total;
    for (segment, length) in segments.iter().zip(lengths) {
        if remaining <= length {
            let fraction = if length <= f64::EPSILON {
                0.0
            } else {
                remaining / length
            };
            let start = dvec3(segment.start);
            let end = dvec3(segment.end);
            return Ok(world_vec3(start.lerp(end, fraction)));
        }
        remaining -= length;
    }
    Ok(segments[segments.len() - 1].end)
}

#[cfg(target_arch = "wasm32")]
fn transform_authored_position(
    position: Position,
    request: &WasmEntityRenderRequest,
) -> Result<WorldVec3, String> {
    let z = position
        .z
        .or(request.locked_plan_elevation)
        .ok_or_else(|| "dimension position height is unresolved".to_owned())?;
    let transform = DMat4::from_cols_array(&request.placement.unwrap_or(Transform3d::IDENTITY).0);
    if !transform.is_finite() || transform.determinant().abs() <= f64::EPSILON {
        return Err("dimension placement is non-invertible".to_owned());
    }
    Ok(world_vec3(
        transform.transform_point3(DVec3::new(position.x, position.y, z)),
    ))
}

#[cfg(target_arch = "wasm32")]
fn dimension_measurement(kind: DimensionKind, anchors: &[WorldVec3]) -> Result<f64, String> {
    let point = |index: usize| {
        anchors
            .get(index)
            .copied()
            .map(dvec3)
            .ok_or_else(|| "dimension has too few anchors".to_owned())
    };
    match kind {
        DimensionKind::Linear => Ok((point(1)?.truncate() - point(0)?.truncate()).length()),
        DimensionKind::Aligned => Ok((point(1)? - point(0)?).length()),
        DimensionKind::Angular => {
            let center = point(0)?;
            let first = point(1)? - center;
            let second = point(2)? - center;
            if first.length_squared() <= f64::EPSILON || second.length_squared() <= f64::EPSILON {
                return Err("angular dimension has a zero-length ray".to_owned());
            }
            Ok(first.angle_between(second).to_degrees())
        }
        DimensionKind::Radius => Ok((point(1)? - point(0)?).length()),
        DimensionKind::Diameter => Ok(2.0 * (point(1)? - point(0)?).length()),
        DimensionKind::Ordinate => Ok(point(0)?.z),
    }
}

#[cfg(target_arch = "wasm32")]
fn dimension_line_positions(
    kind: DimensionKind,
    anchors: &[WorldVec3],
    placement: WorldVec3,
) -> Result<Vec<WorldVec3>, String> {
    let anchor = |index: usize| {
        anchors
            .get(index)
            .copied()
            .ok_or_else(|| "dimension has too few anchors".to_owned())
    };
    match kind {
        DimensionKind::Linear | DimensionKind::Aligned => {
            let first = anchor(0)?;
            let second = anchor(1)?;
            let direction = dvec3(second) - dvec3(first);
            if direction.length_squared() <= f64::EPSILON {
                return Err("dimension anchors must be distinct".to_owned());
            }
            let unit = direction.normalize();
            let placement = dvec3(placement);
            let first_line = placement + unit * (dvec3(first) - placement).dot(unit);
            let second_line = placement + unit * (dvec3(second) - placement).dot(unit);
            Ok(vec![
                first,
                world_vec3(first_line),
                world_vec3(second_line),
                second,
            ])
        }
        DimensionKind::Angular => Ok(vec![anchor(1)?, anchor(0)?, anchor(2)?]),
        DimensionKind::Radius | DimensionKind::Diameter => {
            Ok(vec![anchor(0)?, anchor(1)?, placement])
        }
        DimensionKind::Ordinate => Ok(vec![anchor(0)?, placement]),
    }
}

#[cfg(target_arch = "wasm32")]
fn position_from_world(value: WorldVec3) -> Position {
    Position {
        x: value.x,
        y: value.y,
        z: Some(value.z),
    }
}

#[cfg(target_arch = "wasm32")]
fn dvec3(value: WorldVec3) -> DVec3 {
    DVec3::new(value.x, value.y, value.z)
}

#[cfg(target_arch = "wasm32")]
fn world_distance(left: WorldVec3, right: WorldVec3) -> f64 {
    dvec3(left).distance(dvec3(right))
}

#[cfg(target_arch = "wasm32")]
fn associative_curve_in_area_frame(
    area_request: &WasmEntityRenderRequest,
    entity_requests: &BTreeMap<String, WasmEntityRenderRequest>,
    entity_id: &EntityId,
    expected_version: Option<&ObjectHash>,
) -> Option<CurveGeometry> {
    let source = entity_requests.get(&entity_id.0)?;
    if source.placement.unwrap_or(Transform3d::IDENTITY)
        != area_request.placement.unwrap_or(Transform3d::IDENTITY)
        || expected_version
            .is_some_and(|expected| source.version_hash.as_deref() != Some(expected.as_str()))
    {
        return None;
    }
    match &source.geometry {
        GeometryObject::Curve { curve } => Some((**curve).clone()),
        _ => None,
    }
}

#[cfg(target_arch = "wasm32")]
fn validate_associative_area_references(
    request: &WasmEntityRenderRequest,
    entity_requests: &BTreeMap<String, WasmEntityRenderRequest>,
) -> Result<(), String> {
    let GeometryObject::Area { area } = &request.geometry else {
        return Ok(());
    };
    for curve_use in area
        .outer
        .uses
        .iter()
        .chain(area.holes.iter().flat_map(|hole| &hole.uses))
    {
        let CurveUse::Associative {
            entity_id,
            expected_version,
            ..
        } = curve_use
        else {
            continue;
        };
        let source = entity_requests
            .get(&entity_id.0)
            .ok_or_else(|| format!("associative area curve '{}' is not resident", entity_id.0))?;
        if !matches!(source.geometry, GeometryObject::Curve { .. }) {
            return Err(format!(
                "associative area source '{}' is not a curve entity",
                entity_id.0
            ));
        }
        if expected_version
            .as_ref()
            .is_some_and(|expected| source.version_hash.as_deref() != Some(expected.as_str()))
        {
            return Err(format!(
                "associative area source '{}' does not match its expected version",
                entity_id.0
            ));
        }
        if source.placement.unwrap_or(Transform3d::IDENTITY)
            != request.placement.unwrap_or(Transform3d::IDENTITY)
        {
            return Err(format!(
                "associative area source '{}' must use the area's local placement frame",
                entity_id.0
            ));
        }
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn geometry_entity_dependencies(geometry: &GeometryObject) -> std::collections::BTreeSet<String> {
    let mut dependencies = std::collections::BTreeSet::new();
    let mut add_anchor = |anchor: &AnnotationAnchor| {
        if let AnnotationAnchor::Entity { entity_id, .. } = anchor {
            dependencies.insert(entity_id.0.clone());
        }
    };
    match geometry {
        GeometryObject::Dimension { dimension } => {
            for anchor in &dimension.anchors {
                add_anchor(anchor);
            }
        }
        GeometryObject::Label { label } => add_anchor(&label.target),
        GeometryObject::Area { area } => {
            for curve_use in area
                .outer
                .uses
                .iter()
                .chain(area.holes.iter().flat_map(|hole| &hole.uses))
            {
                if let CurveUse::Associative { entity_id, .. } = curve_use {
                    dependencies.insert(entity_id.0.clone());
                }
            }
        }
        _ => {}
    }
    dependencies
}

#[cfg(target_arch = "wasm32")]
fn geometry_entity_dependencies_with_blocks(
    geometry: &GeometryObject,
    block_definitions: &BTreeMap<String, BlockDefinition>,
) -> std::collections::BTreeSet<String> {
    fn visit(
        geometry: &GeometryObject,
        definitions: &BTreeMap<String, BlockDefinition>,
        visited: &mut std::collections::BTreeSet<String>,
        dependencies: &mut std::collections::BTreeSet<String>,
    ) {
        dependencies.extend(geometry_entity_dependencies(geometry));
        let GeometryObject::Block { instance } = geometry else {
            return;
        };
        let key = block_definition_key(&instance.definition_id, &instance.definition_hash.0);
        if !visited.insert(key.clone()) {
            return;
        }
        let Some(definition) = definitions.get(&key) else {
            return;
        };
        for member in &definition.members {
            match &member.source {
                BlockMemberSource::Inline { geometry, .. } => {
                    visit(geometry, definitions, visited, dependencies);
                }
                // Exact entity revisions are captured immutably when the
                // definition is registered; they are not dependencies on the
                // mutable live entity with the same stable ID.
                BlockMemberSource::EntityReference { .. } => {}
            }
        }
        visited.remove(&key);
    }

    let mut dependencies = std::collections::BTreeSet::new();
    visit(
        geometry,
        block_definitions,
        &mut std::collections::BTreeSet::new(),
        &mut dependencies,
    );
    dependencies
}

#[cfg(target_arch = "wasm32")]
fn replace_entity_dependency_index(
    index: &mut BTreeMap<String, std::collections::BTreeSet<String>>,
    entity_id: &str,
    previous: Option<&GeometryObject>,
    next: Option<&GeometryObject>,
    block_definitions: &BTreeMap<String, BlockDefinition>,
) {
    if let Some(previous) = previous {
        for source_id in geometry_entity_dependencies_with_blocks(previous, block_definitions) {
            if let Some(dependents) = index.get_mut(&source_id) {
                dependents.remove(entity_id);
                if dependents.is_empty() {
                    index.remove(&source_id);
                }
            }
        }
    }
    if let Some(next) = next {
        for source_id in geometry_entity_dependencies_with_blocks(next, block_definitions) {
            index
                .entry(source_id)
                .or_default()
                .insert(entity_id.to_owned());
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn section_entity_ids(request: &WasmSectionRequest) -> std::collections::BTreeSet<String> {
    request
        .entity_ids
        .iter()
        .cloned()
        .chain(request.entity_id.iter().cloned())
        .collect()
}

#[cfg(target_arch = "wasm32")]
fn replace_entity_section_index(
    index: &mut BTreeMap<String, std::collections::BTreeSet<String>>,
    section_id: &str,
    previous: Option<&WasmSectionRequest>,
    next: Option<&WasmSectionRequest>,
) {
    if let Some(previous) = previous {
        for entity_id in section_entity_ids(previous) {
            if let Some(sections) = index.get_mut(&entity_id) {
                sections.remove(section_id);
                if sections.is_empty() {
                    index.remove(&entity_id);
                }
            }
        }
    }
    if let Some(next) = next {
        for entity_id in section_entity_ids(next) {
            index
                .entry(entity_id)
                .or_default()
                .insert(section_id.to_owned());
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn transitive_dependent_entities(
    entity_requests: &BTreeMap<String, WasmEntityRenderRequest>,
    entity_dependents: &BTreeMap<String, std::collections::BTreeSet<String>>,
    changed_entity_ids: &[String],
) -> Vec<WasmEntityRenderRequest> {
    let roots = changed_entity_ids
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let mut affected = roots.clone();
    let mut frontier = roots.iter().cloned().collect::<Vec<_>>();
    while let Some(source_id) = frontier.pop() {
        if let Some(dependents) = entity_dependents.get(&source_id) {
            for dependent_id in dependents {
                if affected.insert(dependent_id.clone()) {
                    frontier.push(dependent_id.clone());
                }
            }
        }
    }
    affected
        .difference(&roots)
        .filter_map(|entity_id| entity_requests.get(entity_id).cloned())
        .collect()
}

#[cfg(target_arch = "wasm32")]
fn build_entity_compile_scope(
    current: &BTreeMap<String, WasmEntityRenderRequest>,
    touched: &[WasmEntityRenderRequest],
    sections: &[(String, WasmSectionRequest)],
    block_definitions: &BTreeMap<String, BlockDefinition>,
) -> BTreeMap<String, WasmEntityRenderRequest> {
    let mut scope = touched
        .iter()
        .map(|request| (request.entity_id.clone(), request.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut frontier = sections
        .iter()
        .flat_map(|(_, section)| section_entity_ids(section))
        .chain(touched.iter().flat_map(|request| {
            geometry_entity_dependencies_with_blocks(&request.geometry, block_definitions)
        }))
        .collect::<Vec<_>>();
    while let Some(entity_id) = frontier.pop() {
        if scope.contains_key(&entity_id) {
            continue;
        }
        let Some(request) = current.get(&entity_id).cloned() else {
            continue;
        };
        frontier.extend(geometry_entity_dependencies_with_blocks(
            &request.geometry,
            block_definitions,
        ));
        scope.insert(entity_id, request);
    }
    scope
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments)]
fn compile_text_entity(
    host: &GpuSurfaceHost<'_>,
    request: &WasmEntityRenderRequest,
    text: &himmelcad_core::entity_model::TextGeometry,
    pick_slot: u32,
    floating_origin: FloatingOrigin,
    glyph_atlases: &BTreeMap<String, WasmGlyphAtlasResource>,
) -> Result<himmelcad_render::CompiledEntityPart, String> {
    let atlas = glyph_atlases
        .get(text.font.object_hash.as_str())
        .ok_or_else(|| "text font atlas resource is not registered".to_owned())?;
    let elevation = text
        .anchor
        .z
        .or(request.locked_plan_elevation)
        .ok_or_else(|| "text anchor height is unresolved".to_owned())?;
    let transform = DMat4::from_cols_array(&request.placement.unwrap_or(Transform3d::IDENTITY).0);
    if !transform.is_finite() || transform.determinant().abs() <= f64::EPSILON {
        return Err("text placement is non-invertible".to_owned());
    }
    let anchor = transform.transform_point3(DVec3::new(text.anchor.x, text.anchor.y, elevation));
    let right = transform.transform_vector3(DVec3::X);
    let up = transform.transform_vector3(DVec3::Y);
    let anchor = world_vec3(anchor);
    let space = match text.space {
        TextSpace::World => TextLayoutSpace::World {
            right: world_vec3(right),
            up: world_vec3(up),
        },
        TextSpace::Screen => TextLayoutSpace::Screen,
    };
    let layout = layout_text(
        &atlas.atlas,
        TextLayoutOptions {
            text: &text.text,
            anchor,
            height: text.height,
            line_spacing: 1.0,
            alignment: TextAlignment::Left,
            space,
            color: [1.0; 4],
        },
    )
    .map_err(|error| error.to_string())?;
    let style = GpuPresentationStyle::from_render_style(
        &request.style,
        floating_origin.world(),
        request.exaggeration_datum,
    )
    .map_err(|error| error.to_string())?;
    let batch = build_text_batch_with_texture(
        host.device(),
        host.queue(),
        host.renderer(),
        &request.proxy_id,
        TextBatchOptions {
            proxy_slot: pick_slot,
            floating_origin,
        },
        &atlas.texture,
        &layout,
        style,
    )
    .map_err(|error| error.to_string())?;
    let bounds = text_layout_bounds(&layout, right, up)?;
    let glyphs = u64::try_from(layout.glyphs.len()).unwrap_or(u64::MAX);
    Ok(himmelcad_render::CompiledEntityPart {
        kind: RenderProxyKind::Text,
        bounds,
        cost: ResourceCost {
            gpu_buffer_bytes: glyphs.saturating_mul(match text.space {
                TextSpace::World => 152,
                TextSpace::Screen => 240,
            }),
            triangles: glyphs.saturating_mul(2),
            draw_calls: 1,
            ..ResourceCost::default()
        },
        batch,
        additional_batches: Vec::new(),
        source_material_table: None,
    })
}

#[cfg(target_arch = "wasm32")]
fn text_layout_bounds(
    layout: &himmelcad_render::LaidOutText,
    right: DVec3,
    up: DVec3,
) -> Result<BoundingVolume, String> {
    let anchor = DVec3::new(layout.anchor.x, layout.anchor.y, layout.anchor.z);
    let mut minimum = anchor;
    let mut maximum = anchor;
    if matches!(layout.space, TextLayoutSpace::World { .. }) {
        for glyph in &layout.glyphs {
            for offset in glyph.offsets {
                let point = anchor + right * offset[0] + up * offset[1];
                minimum = minimum.min(point);
                maximum = maximum.max(point);
            }
        }
    }
    if !minimum.is_finite() || !maximum.is_finite() {
        return Err("text bounds are non-finite".to_owned());
    }
    Ok(BoundingVolume::AxisAlignedBox {
        bounds: WorldAabb {
            min: world_vec3(minimum),
            max: world_vec3(maximum),
        },
    })
}

#[cfg(target_arch = "wasm32")]
fn world_vec3(value: DVec3) -> WorldVec3 {
    WorldVec3 {
        x: value.x,
        y: value.y,
        z: value.z,
    }
}

#[cfg(target_arch = "wasm32")]
fn entity_proxy_ids(
    request: &WasmEntityRenderRequest,
    entity_requests: &BTreeMap<String, WasmEntityRenderRequest>,
    block_definitions: &BTreeMap<String, BlockDefinition>,
    block_member_styles: &BTreeMap<String, (CanonicalResourceRef, RenderStyle)>,
    block_member_entity_versions: &BTreeMap<String, (EntityVersionRef, WasmEntityRenderRequest)>,
) -> Result<Vec<RenderProxyId>, String> {
    entity_proxy_ids_inner(
        request,
        entity_requests,
        block_definitions,
        block_member_styles,
        block_member_entity_versions,
        &mut Vec::new(),
    )
}

#[cfg(target_arch = "wasm32")]
fn entity_proxy_ids_inner(
    request: &WasmEntityRenderRequest,
    entity_requests: &BTreeMap<String, WasmEntityRenderRequest>,
    block_definitions: &BTreeMap<String, BlockDefinition>,
    block_member_styles: &BTreeMap<String, (CanonicalResourceRef, RenderStyle)>,
    block_member_entity_versions: &BTreeMap<String, (EntityVersionRef, WasmEntityRenderRequest)>,
    stack: &mut Vec<String>,
) -> Result<Vec<RenderProxyId>, String> {
    if let GeometryObject::Block { instance } = &request.geometry {
        let definition = resolve_block_definition(instance, block_definitions)?;
        let definition_key =
            block_definition_key(&definition.definition_id, &definition.content_hash.0);
        if stack.contains(&definition_key) {
            return Err(format!(
                "cyclic block definition reference: {} -> {}",
                stack.join(" -> "),
                definition_key
            ));
        }
        stack.push(definition_key);
        let result = definition
            .members
            .iter()
            .try_fold(Vec::new(), |mut ids, member| {
                let member_request = block_member_request(
                    request,
                    instance,
                    member,
                    block_member_entity_versions,
                    block_member_styles,
                )?;
                ids.extend(entity_proxy_ids_inner(
                    &member_request,
                    entity_requests,
                    block_definitions,
                    block_member_styles,
                    block_member_entity_versions,
                    stack,
                )?);
                Ok::<_, String>(ids)
            });
        stack.pop();
        return result;
    }
    let part_count = required_entity_proxy_slots(&request.geometry, request.fill_areas)
        .map_err(|error| error.to_string())?;
    Ok((0..part_count)
        .map(|part_index| {
            if part_index == 0 {
                RenderProxyId(request.proxy_id.clone())
            } else {
                RenderProxyId(format!("{}#{part_index}", request.proxy_id))
            }
        })
        .collect())
}

#[cfg(target_arch = "wasm32")]
fn compile_decoded_potree_content(
    host: &GpuSurfaceHost<'_>,
    world: &mut RenderWorld,
    batches: &mut BTreeMap<RenderProxyId, Vec<GpuDrawBatch>>,
    request: &WasmPotreeRequest,
    decoded: &himmelcad_render::DecodedPotreePoints,
    frame_origin: WorldVec3,
) -> Result<(), String> {
    let metadata = &request.metadata;
    let id = RenderProxyId(metadata.proxy_id.clone());
    let bounds = placed_stream_bounds(&metadata.bounds, metadata.source_to_project)?;
    let slot = world
        .insert_proxy(potree_proxy(metadata, id.clone(), bounds.clone()))
        .map_err(|error| error.to_string())?;
    let project_origin = metadata
        .source_to_project
        .transform_point(decoded.world_origin)
        .ok_or_else(|| "Potree entity placement cannot transform its world origin".to_owned())?;
    let style = GpuPresentationStyle::from_render_style(
        &metadata.style,
        project_origin,
        metadata.exaggeration_datum,
    )
    .map_err(|error| error.to_string())?;
    let mut batch = build_potree_batch(
        host.device(),
        host.queue(),
        host.renderer(),
        &metadata.proxy_id,
        slot,
        decoded,
        &style,
    )
    .map_err(|error| error.to_string())?;
    batch
        .set_source_to_project_transform(
            host.queue(),
            decoded.world_origin,
            frame_origin,
            metadata.source_to_project,
        )
        .map_err(|error| error.to_string())?;
    world
        .set_compiled_metadata(
            &id,
            RenderProxyKind::Points,
            bounds,
            potree_cost(request, false),
        )
        .map_err(|error| error.to_string())?;
    batches.insert(id, vec![batch]);
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn compile_decoded_splat_content(
    host: &GpuSurfaceHost<'_>,
    world: &mut RenderWorld,
    batches: &mut BTreeMap<RenderProxyId, Vec<GpuDrawBatch>>,
    request: &WasmGaussianSplatRequest,
    decoded: &himmelcad_render::DecodedGaussianSplats,
    pick_index_bytes: u64,
    frame_origin: WorldVec3,
) -> Result<(), String> {
    let metadata = &request.metadata;
    let id = RenderProxyId(metadata.proxy_id.clone());
    let bounds = placed_stream_bounds(&metadata.bounds, metadata.source_to_project)?;
    let slot = world
        .insert_proxy(splat_proxy(metadata, id.clone(), bounds.clone()))
        .map_err(|error| error.to_string())?;
    let project_origin = metadata
        .source_to_project
        .transform_point(decoded.origin)
        .ok_or_else(|| "splat entity placement cannot transform its world origin".to_owned())?;
    let style = GpuPresentationStyle::from_render_style(
        &metadata.style,
        project_origin,
        metadata.exaggeration_datum,
    )
    .map_err(|error| error.to_string())?;
    let mut compiled_batches = build_gaussian_splat_batches(
        host.device(),
        host.queue(),
        host.renderer(),
        &metadata.proxy_id,
        slot,
        decoded,
        &style,
    )
    .map_err(|error| error.to_string())?;
    for batch in &mut compiled_batches {
        batch
            .set_source_to_project_transform(
                host.queue(),
                decoded.origin,
                frame_origin,
                metadata.source_to_project,
            )
            .map_err(|error| error.to_string())?;
    }
    world
        .set_compiled_metadata(
            &id,
            RenderProxyKind::GaussianSplats,
            bounds,
            splat_cost(
                request,
                decoded.splats.len(),
                pick_index_bytes,
                false,
                host.renderer().transparency_strategy()
                    == himmelcad_render::TransparencyStrategy::SortedAlpha,
            ),
        )
        .map_err(|error| error.to_string())?;
    batches.insert(id, compiled_batches);
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn compile_decoded_raster_content(
    host: &GpuSurfaceHost<'_>,
    world: &mut RenderWorld,
    batches: &mut BTreeMap<RenderProxyId, Vec<GpuDrawBatch>>,
    request: &WasmRasterRequest,
    decoded: &himmelcad_render::DecodedElevationRaster,
    frame_origin: WorldVec3,
    pick_index_bytes: u64,
    image_resources: &BTreeMap<String, WasmImageResource>,
    hatch_resources: &WasmHatchResourceRegistry,
    line_type_resources: &WasmLineTypeResourceRegistry,
) -> Result<(), String> {
    let metadata = &request.metadata;
    let id = RenderProxyId(metadata.proxy_id.clone());
    let bounds = placed_stream_bounds(&metadata.bounds, metadata.source_to_project)?;
    let slot = world
        .insert_proxy(raster_proxy(metadata, id.clone(), bounds.clone()))
        .map_err(|error| error.to_string())?;
    let project_origin = metadata
        .source_to_project
        .transform_point(decoded.world_origin)
        .ok_or_else(|| "raster entity placement cannot transform its world origin".to_owned())?;
    let style = GpuPresentationStyle::from_render_style(
        &metadata.style,
        project_origin,
        metadata.exaggeration_datum,
    )
    .map_err(|error| error.to_string())?;
    let mut batch = build_elevation_raster_batch(
        host.device(),
        host.queue(),
        host.renderer(),
        &metadata.proxy_id,
        slot,
        decoded,
        &style,
    )
    .map_err(|error| error.to_string())?;
    batch
        .set_source_to_project_transform(
            host.queue(),
            decoded.world_origin,
            frame_origin,
            metadata.source_to_project,
        )
        .map_err(|error| error.to_string())?;
    let resolved = resolve_batch_presentation(
        &metadata.style,
        metadata.exaggeration_datum,
        RenderProxyKind::Raster,
        &batch,
        image_resources,
        hatch_resources,
        line_type_resources,
    )?;
    apply_batch_presentation(host, &mut batch, &resolved)?;
    world
        .set_compiled_metadata(
            &id,
            RenderProxyKind::Raster,
            bounds,
            raster_cost(request, decoded, pick_index_bytes, false),
        )
        .map_err(|error| error.to_string())?;
    batches.insert(id, vec![batch]);
    Ok(())
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
fn authoritative_section_matches_entity(
    product: &AuthoritativeSectionProduct,
    request: &WasmSectionRequest,
    entities: &BTreeMap<String, WasmEntityRenderRequest>,
    dataset_slot_keys: &BTreeMap<String, String>,
    slot_bindings: &BTreeMap<String, GeometryRepresentationBindingRef>,
) -> bool {
    let Some(entity_id) = request.entity_id.as_deref() else {
        return false;
    };
    if product.source.entity_id != entity_id
        || product.plane != request.plane
        || product.tolerance != request.tolerance
    {
        return false;
    }
    let Some(entity) = entities.get(entity_id) else {
        return false;
    };
    let Some(version_hash) = entity.version_hash.as_deref() else {
        return false;
    };
    let dataset_id = product.source.dataset_id.as_deref();
    if let Some(dataset_id) = dataset_id {
        let Some(storage_key) = dataset_slot_keys.get(dataset_id) else {
            return false;
        };
        let Some(binding) = slot_bindings.get(storage_key) else {
            return false;
        };
        if binding.key.slot.entity_id.0 != entity_id
            || binding.key.entity_version_hash.0 != version_hash
        {
            return false;
        }
    }
    authoritative_section_product_matches(
        product,
        entity_id,
        dataset_id,
        version_hash,
        request.plane,
        request.tolerance,
    )
}

#[cfg(target_arch = "wasm32")]
fn resolve_section_clip_cap<'a>(
    request: &WasmSectionRequest,
    clip_volumes: &'a [ClipVolume],
) -> Result<Option<(&'a ClipVolume, usize)>, String> {
    let Some(cap) = &request.clip_cap else {
        return Ok(None);
    };
    let volume = clip_volumes
        .iter()
        .find(|volume| volume.id.0 == cap.volume_id)
        .ok_or_else(|| format!("clip-cap volume '{}' is not current", cap.volume_id))?;
    if !volume.enabled || !volume.preview_cap {
        return Err(format!(
            "clip-cap volume '{}' is disabled or does not request preview caps",
            cap.volume_id
        ));
    }
    let clip_plane = volume.planes.get(cap.plane_index).ok_or_else(|| {
        format!(
            "clip-cap plane {} is outside volume '{}'",
            cap.plane_index, cap.volume_id
        )
    })?;
    let expected_origin = WorldVec3 {
        x: -clip_plane.distance * clip_plane.normal.x,
        y: -clip_plane.distance * clip_plane.normal.y,
        z: -clip_plane.distance * clip_plane.normal.z,
    };
    let origin_delta = WorldVec3 {
        x: request.plane.origin.x - expected_origin.x,
        y: request.plane.origin.y - expected_origin.y,
        z: request.plane.origin.z - expected_origin.z,
    };
    let along_normal = origin_delta.x * clip_plane.normal.x
        + origin_delta.y * clip_plane.normal.y
        + origin_delta.z * clip_plane.normal.z;
    let normal_dot = request.plane.normal.x * clip_plane.normal.x
        + request.plane.normal.y * clip_plane.normal.y
        + request.plane.normal.z * clip_plane.normal.z;
    let request_normal_length = (request.plane.normal.x * request.plane.normal.x
        + request.plane.normal.y * request.plane.normal.y
        + request.plane.normal.z * request.plane.normal.z)
        .sqrt();
    let plane_epsilon = request.tolerance.max(1.0e-9);
    if !request_normal_length.is_finite()
        || request_normal_length <= f64::EPSILON
        || (normal_dot / request_normal_length - 1.0).abs() > 1.0e-10
        || along_normal.abs() > plane_epsilon
    {
        return Err(format!(
            "section plane does not match clip-cap volume '{}' plane {}",
            cap.volume_id, cap.plane_index
        ));
    }
    Ok(Some((volume, cap.plane_index)))
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
fn compile_section_request(
    host: &GpuSurfaceHost<'_>,
    world: &mut RenderWorld,
    batches: &mut BTreeMap<RenderProxyId, Vec<GpuDrawBatch>>,
    entities: &BTreeMap<String, WasmEntityRenderRequest>,
    dataset_slot_keys: &BTreeMap<String, String>,
    slot_bindings: &BTreeMap<String, GeometryRepresentationBindingRef>,
    request: &WasmSectionRequest,
    origin: WorldVec3,
    block_definitions: &BTreeMap<String, BlockDefinition>,
    block_member_styles: &BTreeMap<String, (CanonicalResourceRef, RenderStyle)>,
    block_member_entity_versions: &BTreeMap<String, (EntityVersionRef, WasmEntityRenderRequest)>,
    mesh_resources: &BTreeMap<String, TriangleMeshGeometry>,
    hatch_resources: &WasmHatchResourceRegistry,
    line_type_resources: &WasmLineTypeResourceRegistry,
    section_products: &BTreeMap<String, AuthoritativeSectionProduct>,
    clip_volumes: &[ClipVolume],
) -> Result<Vec<RenderProxyId>, String> {
    let floating_origin =
        FloatingOrigin::from_selected(1_024.0, origin).map_err(|error| error.to_string())?;
    validate_stroke_resource(&request.style, line_type_resources)?;
    let mut gpu_style =
        GpuPresentationStyle::from_render_style(&request.style, origin, request.plane.origin.z)
            .map_err(|error| error.to_string())?;
    let line_type = if let StrokeMode::LineType { resource } = &request.style.stroke.mode {
        let key = canonical_resource_ref_key(resource)?;
        let gpu = line_type_resources.gpu.get(&key).ok_or_else(|| {
            format!(
                "exact line type resource revision '{}' is not registered",
                resource.resource_id
            )
        })?;
        gpu_style = gpu_style.with_line_type(gpu.pattern());
        Some(gpu.clone())
    } else {
        None
    };
    let default_hatch = if let Some(hatch) = &request.hatch {
        Some(hatch.clone())
    } else if let FillMode::Hatch {
        resource,
        line_width,
        color,
        ..
    } = &request.style.fill
    {
        Some(SectionHatchStyle {
            resource: resource.clone(),
            line_width: *line_width,
            color: *color,
        })
    } else {
        None
    };
    let alpha_mode = if request.style.opacity < 1.0 {
        GpuAlphaMode::Blend
    } else {
        GpuAlphaMode::Opaque
    };
    let clip_cap = resolve_section_clip_cap(request, clip_volumes)?;

    if request.product_hash.is_some() || request.entity_id.is_some() {
        let entity_id = request
            .entity_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "evaluated section product needs entityId".to_owned())?;
        let product_hash = request
            .product_hash
            .as_deref()
            .filter(|hash| !hash.is_empty())
            .ok_or_else(|| "evaluated section product needs productHash".to_owned())?;
        let evaluated = section_products
            .get(product_hash)
            .ok_or_else(|| format!("section product '{product_hash}' is not registered"))?;
        if !authoritative_section_matches_entity(
            evaluated,
            request,
            entities,
            dataset_slot_keys,
            slot_bindings,
        ) {
            return Err(format!(
                "section product '{product_hash}' does not match the resident entity version, dataset, plane or tolerance"
            ));
        }
        let ids = compile_section_product_regions(
            host,
            world,
            batches,
            request,
            entity_id,
            "evaluated",
            &evaluated.product,
            Some(&evaluated.material_regions),
            floating_origin,
            &gpu_style,
            default_hatch.as_ref(),
            hatch_resources,
            alpha_mode,
            clip_cap,
        )?;
        bind_line_type_to_batches(host, batches, &ids, line_type.as_ref())?;
        return Ok(ids);
    }

    let mut ids = Vec::new();
    for entity_id in &request.entity_ids {
        let entity = entities
            .get(entity_id)
            .ok_or_else(|| format!("section entity is not resident: {entity_id}"))?;
        let mut resolved = Vec::new();
        if matches!(&entity.geometry, GeometryObject::Block { .. }) {
            collect_block_member_requests(
                entity,
                entities,
                block_definitions,
                block_member_styles,
                block_member_entity_versions,
                &mut Vec::new(),
                &mut resolved,
            )?;
        } else {
            resolved.push(entity.clone());
        }
        for (member_index, sectionable) in resolved
            .iter()
            .filter(|member| {
                matches!(
                    &member.geometry,
                    GeometryObject::Surface3d { .. }
                        | GeometryObject::ElevationSurface { .. }
                        | GeometryObject::Solid { .. }
                )
            })
            .enumerate()
        {
            let evaluated_geometry;
            let geometry = if let GeometryObject::Solid { solid } = &sectionable.geometry {
                if solid_requires_evaluated_mesh(solid) {
                    evaluated_geometry = GeometryObject::Surface3d {
                        mesh: Box::new(
                            evaluated_mesh_for_solid(sectionable, solid, mesh_resources)?.clone(),
                        ),
                    };
                    &evaluated_geometry
                } else {
                    &sectionable.geometry
                }
            } else {
                &sectionable.geometry
            };
            let product = section_geometry_object(
                geometry,
                sectionable.placement,
                request.plane,
                request.tolerance,
            )
            .map_err(|error| error.to_string())?;
            ids.extend(compile_section_product_regions(
                host,
                world,
                batches,
                request,
                entity_id,
                &member_index.to_string(),
                &product,
                None,
                floating_origin,
                &gpu_style,
                default_hatch.as_ref(),
                hatch_resources,
                alpha_mode,
                clip_cap,
            )?);
        }
    }
    bind_line_type_to_batches(host, batches, &ids, line_type.as_ref())?;
    Ok(ids)
}

#[cfg(target_arch = "wasm32")]
fn bind_line_type_to_batches(
    host: &GpuSurfaceHost<'_>,
    batches: &mut BTreeMap<RenderProxyId, Vec<GpuDrawBatch>>,
    ids: &[RenderProxyId],
    line_type: Option<&GpuLineTypeResource>,
) -> Result<(), String> {
    for id in ids {
        for batch in batches
            .get_mut(id)
            .ok_or_else(|| "section batch disappeared before line-type binding".to_owned())?
        {
            batch
                .rebind_line_type_resource(host.device(), host.renderer(), line_type)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments)]
fn compile_section_product_regions(
    host: &GpuSurfaceHost<'_>,
    world: &mut RenderWorld,
    batches: &mut BTreeMap<RenderProxyId, Vec<GpuDrawBatch>>,
    request: &WasmSectionRequest,
    entity_id: &str,
    source_key: &str,
    product: &SectionProduct,
    material_regions: Option<&[SectionMaterialRegionBinding]>,
    floating_origin: FloatingOrigin,
    gpu_style: &GpuPresentationStyle,
    default_hatch: Option<&SectionHatchStyle>,
    hatch_resources: &WasmHatchResourceRegistry,
    alpha_mode: GpuAlphaMode,
    clip_cap: Option<(&ClipVolume, usize)>,
) -> Result<Vec<RenderProxyId>, String> {
    let mut ids =
        Vec::with_capacity(product.regions.len() + usize::from(!product.segments.is_empty()));
    if clip_cap.is_none() && !product.segments.is_empty() {
        ids.push(compile_section_product_segments(
            host,
            world,
            batches,
            request,
            entity_id,
            source_key,
            product,
            floating_origin,
            gpu_style,
            alpha_mode,
        )?);
    }
    for (region_index, source_region) in product.regions.iter().enumerate() {
        let clipped_region;
        let region = if let Some((volume, plane_index)) = clip_cap {
            let Some(value) = clip_preview_region(
                source_region,
                volume,
                plane_index,
                request.plane.normal,
                1.0e-4,
            ) else {
                continue;
            };
            clipped_region = value;
            &clipped_region
        } else {
            source_region
        };
        let id = RenderProxyId(format!(
            "section:{}:{entity_id}:{source_key}:{region_index}",
            request.section_id
        ));
        let bounds = section_bounds(&region.vertices)?;
        let slot = world
            .insert_proxy(RenderProxy {
                id: id.clone(),
                entity_id: entity_id.to_owned(),
                kind: RenderProxyKind::CadFill,
                bounds: bounds.clone(),
                dataset_id: None,
                tile_id: None,
                style: request.style.clone(),
                cost: ResourceCost::default(),
                visible: true,
                locked: true,
            })
            .map_err(|error| error.to_string())?;
        let mut batch = build_section_region_batch(
            host.device(),
            host.queue(),
            &id.0,
            SectionBatchOptions {
                proxy_slot: slot,
                primitive_base: 0,
                floating_origin,
                plane_normal: request.plane.normal,
                linear_color: [1.0; 4],
            },
            region,
        )
        .map_err(|error| error.to_string())?;
        let material_key = material_regions
            .and_then(|bindings| bindings.get(region_index))
            .map_or_else(
                || region.material_slot.to_string(),
                |binding| binding.material_key.clone(),
            );
        let volume_hatch = clip_cap
            .and_then(|(volume, _)| {
                volume
                    .section_material_hatches
                    .get(&region.material_slot)
                    .or(volume.section_fill.as_ref())
            })
            .cloned();
        let hatch_style = volume_hatch.or(request
            .material_hatches
            .get(&material_key)
            .cloned()
            .or_else(|| default_hatch.cloned()));
        let resolved_hatch = hatch_style
            .as_ref()
            .map(|style| {
                resolve_section_hatch_resource(
                    style,
                    hatch_resources,
                    request.plane,
                    floating_origin.world(),
                )
            })
            .transpose()?;
        let region_style = if let Some((placement, resource)) = &resolved_hatch {
            gpu_style.with_hatch(*placement, resource.pattern())
        } else {
            match &request.style.fill {
                FillMode::None => gpu_style.with_fill_visible(false),
                FillMode::Texture { resource_id } => {
                    return Err(format!(
                        "section fill texture '{resource_id}' needs an explicit section-plane mapping"
                    ));
                }
                FillMode::Color | FillMode::Hatch { .. } => *gpu_style,
            }
        };
        let material = host
            .renderer()
            .create_styled_material(
                host.device(),
                host.queue(),
                &format!("{}-material", id.0),
                GpuTextureData {
                    width: 1,
                    height: 1,
                    rgba8: &[255; 4],
                },
                alpha_mode,
                region_style,
            )
            .map_err(|error| error.to_string())?;
        batch = batch
            .with_material(material)
            .with_pickable(clip_cap.is_none());
        batch
            .rebind_hatch_resource(
                host.device(),
                host.renderer(),
                resolved_hatch.as_ref().map(|(_, resource)| resource),
            )
            .map_err(|error| error.to_string())?;
        batch
            .set_world_origins(
                host.queue(),
                floating_origin.world(),
                floating_origin.world(),
            )
            .map_err(|error| error.to_string())?;
        let cost = ResourceCost {
            gpu_buffer_bytes: usize_to_u64(region.vertices.len())
                .saturating_mul(32)
                .saturating_add(usize_to_u64(region.indices.len()).saturating_mul(4)),
            triangles: usize_to_u64(region.indices.len() / 3),
            draw_calls: 1,
            ..ResourceCost::default()
        };
        world
            .set_compiled_metadata(&id, RenderProxyKind::CadFill, bounds, cost)
            .map_err(|error| error.to_string())?;
        batches.insert(id.clone(), vec![batch]);
        ids.push(id);
    }
    Ok(ids)
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments)]
fn compile_section_product_segments(
    host: &GpuSurfaceHost<'_>,
    world: &mut RenderWorld,
    batches: &mut BTreeMap<RenderProxyId, Vec<GpuDrawBatch>>,
    request: &WasmSectionRequest,
    entity_id: &str,
    source_key: &str,
    product: &SectionProduct,
    floating_origin: FloatingOrigin,
    gpu_style: &GpuPresentationStyle,
    alpha_mode: GpuAlphaMode,
) -> Result<RenderProxyId, String> {
    let id = RenderProxyId(format!(
        "section:{}:{entity_id}:{source_key}:segments",
        request.section_id
    ));
    let vertices = product
        .segments
        .iter()
        .flat_map(|segment| [segment.start, segment.end])
        .collect::<Vec<_>>();
    let bounds = section_bounds(&vertices)?;
    let slot = world
        .insert_proxy(RenderProxy {
            id: id.clone(),
            entity_id: entity_id.to_owned(),
            kind: RenderProxyKind::CadStroke,
            bounds: bounds.clone(),
            dataset_id: None,
            tile_id: None,
            style: request.style.clone(),
            cost: ResourceCost::default(),
            visible: true,
            locked: true,
        })
        .map_err(|error| error.to_string())?;
    let curve = TessellatedCurve {
        segments: product
            .segments
            .iter()
            .enumerate()
            .map(|(primitive_slot, segment)| {
                Ok(TessellatedCurveSegment {
                    start: segment.start,
                    end: segment.end,
                    primitive_slot: u32::try_from(primitive_slot)
                        .map_err(|_| "section has too many segments".to_owned())?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?,
        semantic_snaps: Vec::new(),
        paths: (0..product.segments.len())
            .map(|index| {
                Ok(TessellatedCurvePath {
                    first_segment: u32::try_from(index)
                        .map_err(|_| "section has too many segments".to_owned())?,
                    segment_count: 1,
                    closed: false,
                })
            })
            .collect::<Result<Vec<_>, String>>()?,
    };
    let mut batch = build_cad_curve_batch(
        host.device(),
        host.queue(),
        &id.0,
        slot,
        floating_origin,
        [1.0; 4],
        &curve,
    )
    .map_err(|error| error.to_string())?;
    let material = host
        .renderer()
        .create_styled_material(
            host.device(),
            host.queue(),
            &format!("{}-material", id.0),
            GpuTextureData {
                width: 1,
                height: 1,
                rgba8: &[255; 4],
            },
            alpha_mode,
            *gpu_style,
        )
        .map_err(|error| error.to_string())?;
    batch = batch.with_material(material);
    batch
        .set_world_origins(
            host.queue(),
            floating_origin.world(),
            floating_origin.world(),
        )
        .map_err(|error| error.to_string())?;
    let cost = ResourceCost {
        gpu_buffer_bytes: usize_to_u64(product.segments.len()).saturating_mul(64),
        draw_calls: 1,
        ..ResourceCost::default()
    };
    world
        .set_compiled_metadata(&id, RenderProxyKind::CadStroke, bounds, cost)
        .map_err(|error| error.to_string())?;
    batches.insert(id.clone(), vec![batch]);
    Ok(id)
}

#[cfg(target_arch = "wasm32")]
fn resolve_section_hatch_resource(
    style: &SectionHatchStyle,
    hatch_resources: &WasmHatchResourceRegistry,
    plane: SectionPlane,
    floating_origin: WorldVec3,
) -> Result<(GpuHatchPattern, GpuHatchResource), String> {
    let key = canonical_resource_ref_key(&style.resource)?;
    let resource = hatch_resources.gpu.get(&key).ok_or_else(|| {
        format!(
            "exact GPU hatch resource revision '{}' is not registered",
            style.resource.resource_id
        )
    })?;
    let (axis_u, axis_v) = section_hatch_axes(plane.normal)?;
    let placement = GpuHatchPattern::new(
        plane.origin,
        axis_u,
        axis_v,
        style.line_width,
        style.color,
        floating_origin,
    )
    .map_err(|error| error.to_string())?;
    Ok((placement, resource.clone()))
}

#[cfg(target_arch = "wasm32")]
fn section_bounds(vertices: &[WorldVec3]) -> Result<BoundingVolume, String> {
    let Some(first) = vertices.first().copied() else {
        return Err("section region has no vertices".to_owned());
    };
    let mut min = first;
    let mut max = first;
    for vertex in &vertices[1..] {
        min.x = min.x.min(vertex.x);
        min.y = min.y.min(vertex.y);
        min.z = min.z.min(vertex.z);
        max.x = max.x.max(vertex.x);
        max.y = max.y.max(vertex.y);
        max.z = max.z.max(vertex.z);
    }
    Ok(BoundingVolume::AxisAlignedBox {
        bounds: WorldAabb { min, max },
    })
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::too_many_arguments)]
fn compile_decoded_streamed_content(
    host: &GpuSurfaceHost<'_>,
    world: &mut RenderWorld,
    batches: &mut BTreeMap<RenderProxyId, Vec<GpuDrawBatch>>,
    mesh_pick_indices: &mut BTreeMap<String, MeshPickRefiner>,
    gltf_feature_catalogs: &mut BTreeMap<String, WasmGltfFeatureCatalog>,
    request: &WasmThreeDTilesRequest,
    decoded: &DecodedThreeDTilesContent,
    gpu_models: &WasmPreparedGpuModels,
    gpu_textures: &PreparedGpuTextureResources,
    frame_origin: WorldVec3,
    image_resources: &BTreeMap<String, WasmImageResource>,
    hatch_resources: &WasmHatchResourceRegistry,
    line_type_resources: &WasmLineTypeResourceRegistry,
) -> Result<(), String> {
    let metadata = &request.metadata;
    let leaf_count = required_three_d_tiles_proxy_slots(decoded);
    if request.leaf_count != leaf_count {
        return Err("stored 3D Tiles content leaf count changed".to_owned());
    }
    let bounds = placed_stream_bounds(&metadata.bounds, metadata.source_to_project)?;
    let mut proxy_ids = Vec::with_capacity(leaf_count);
    let mut pick_slots = Vec::with_capacity(leaf_count);
    for leaf_index in 0..leaf_count {
        let id = if leaf_index == 0 {
            RenderProxyId(metadata.proxy_id.clone())
        } else {
            RenderProxyId(format!("{}#{leaf_index}", metadata.proxy_id))
        };
        let slot = world
            .insert_proxy(streamed_proxy(metadata, id.clone(), bounds.clone()))
            .map_err(|error| error.to_string())?;
        proxy_ids.push(id);
        pick_slots.push(slot);
    }
    let built = build_three_d_tiles_batches_with_resources(
        host.device(),
        host.queue(),
        host.renderer(),
        &metadata.proxy_id,
        &pick_slots,
        decoded,
        &metadata.style,
        metadata.exaggeration_datum,
        &gpu_models.models,
        gpu_textures,
    )
    .map_err(|error| error.to_string())?;
    let mut leaf_metadata = Vec::with_capacity(leaf_count);
    collect_leaf_metadata(
        decoded,
        host.renderer().transparency_strategy()
            == himmelcad_render::TransparencyStrategy::SortedAlpha,
        &mut leaf_metadata,
    );
    collect_three_d_tiles_mesh_pick_indices(
        decoded,
        &proxy_ids,
        mesh_pick_indices,
        gltf_feature_catalogs,
    )?;
    for (leaf_index, id) in proxy_ids.iter().enumerate() {
        let (kind, mut cost) = leaf_metadata[leaf_index];
        // Decoded CPU objects are staging-only and are dropped after upload.
        cost.cpu_decoded_bytes = 0;
        cost.staging_bytes = 0;
        if leaf_index == 0 {
            cost.cpu_compressed_bytes = u64::try_from(request.bytes.len()).unwrap_or(u64::MAX);
        }
        world
            .set_compiled_metadata(id, kind, bounds.clone(), cost)
            .map_err(|error| error.to_string())?;
    }
    for mut built_batch in built {
        built_batch
            .batch
            .set_source_to_project_transform(
                host.queue(),
                built_batch.world_origin,
                frame_origin,
                metadata.source_to_project,
            )
            .map_err(|error| error.to_string())?;
        let resolved = resolve_batch_presentation(
            &metadata.style,
            metadata.exaggeration_datum,
            leaf_metadata[built_batch.leaf_index].0,
            &built_batch.batch,
            image_resources,
            hatch_resources,
            line_type_resources,
        )?;
        apply_batch_presentation(host, &mut built_batch.batch, &resolved)?;
        batches
            .entry(proxy_ids[built_batch.leaf_index].clone())
            .or_default()
            .push(built_batch.batch);
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn streamed_proxy_ids(request: &WasmThreeDTilesRequest) -> Vec<RenderProxyId> {
    (0..request.leaf_count)
        .map(|leaf_index| {
            if leaf_index == 0 {
                RenderProxyId(request.metadata.proxy_id.clone())
            } else {
                RenderProxyId(format!("{}#{leaf_index}", request.metadata.proxy_id))
            }
        })
        .collect()
}

#[cfg(target_arch = "wasm32")]
fn collect_three_d_tiles_mesh_pick_indices(
    content: &DecodedThreeDTilesContent,
    proxy_ids: &[RenderProxyId],
    output: &mut BTreeMap<String, MeshPickRefiner>,
    feature_output: &mut BTreeMap<String, WasmGltfFeatureCatalog>,
) -> Result<(), String> {
    fn visit(
        content: &DecodedThreeDTilesContent,
        proxy_ids: &[RenderProxyId],
        leaf_index: &mut usize,
        output: &mut BTreeMap<String, MeshPickRefiner>,
        feature_output: &mut BTreeMap<String, WasmGltfFeatureCatalog>,
    ) -> Result<(), String> {
        match content {
            DecodedThreeDTilesContent::Mesh(mesh) => {
                let proxy_id = proxy_ids
                    .get(*leaf_index)
                    .ok_or_else(|| "3D Tiles mesh leaf has no pick proxy".to_owned())?;
                *leaf_index += 1;
                let mut primitive_base = 0_u32;
                let mut sources = Vec::with_capacity(mesh.glb.primitives.len());
                let mut feature_primitives = Vec::with_capacity(mesh.glb.primitives.len());
                for primitive in &mesh.glb.primitives {
                    if !primitive.indices.is_empty() {
                        sources.push(TriangleMeshPickSource {
                            positions: &primitive.exact_positions,
                            indices: &primitive.indices,
                            transform: WorldTransform::IDENTITY,
                            leaf_origin: mesh.glb.world_origin,
                            gpu_primitive_base: primitive_base,
                            source_primitive_base: u64::from(primitive_base),
                        });
                    }
                    let triangle_count = u32::try_from(primitive.indices.len() / 3)
                        .map_err(|_| "3D Tiles mesh primitive count exceeds u32".to_owned())?;
                    feature_primitives.push(WasmGltfFeaturePrimitive {
                        source_start: u64::from(primitive_base),
                        triangle_count: u64::from(triangle_count),
                        features: primitive.features.clone(),
                        property_attributes: primitive.property_attributes.clone(),
                        property_textures: primitive.property_textures.clone(),
                        legacy_batch_ids: primitive.legacy_batch_ids.clone(),
                    });
                    primitive_base = primitive_base
                        .checked_add(triangle_count)
                        .ok_or_else(|| "3D Tiles mesh primitive range overflowed".to_owned())?;
                }
                if !sources.is_empty() {
                    let index = TriangleMeshPickRefiner::build(&sources)
                        .map_err(|error| error.to_string())?;
                    if output.insert(proxy_id.0.clone(), index.into()).is_some() {
                        return Err("duplicate mesh pick proxy identity".to_owned());
                    }
                }
                let has_legacy = mesh.batch_length > 0
                    || mesh.batch_table_json.is_some()
                    || feature_primitives
                        .iter()
                        .any(|primitive| primitive.legacy_batch_ids.is_some());
                if has_legacy
                    || mesh.glb.structural_metadata.is_some()
                    || feature_primitives.iter().any(|primitive| {
                        !primitive.features.is_empty()
                            || !primitive.property_attributes.is_empty()
                            || !primitive.property_textures.is_empty()
                    })
                {
                    let catalog = WasmGltfFeatureCatalog {
                        structural_metadata: mesh.glb.structural_metadata.clone(),
                        feature_images: mesh.glb.feature_images.clone(),
                        primitives: feature_primitives,
                        legacy: has_legacy.then(|| WasmLegacyFeatureCatalog::B3dm {
                            batch_table: Arc::new(mesh.legacy_metadata_catalog()),
                        }),
                    };
                    if feature_output.insert(proxy_id.0.clone(), catalog).is_some() {
                        return Err("duplicate glTF feature proxy identity".to_owned());
                    }
                }
            }
            DecodedThreeDTilesContent::InstancedMesh(model) => {
                let model_triangle_count = model
                    .glb
                    .primitives
                    .iter()
                    .map(|primitive| primitive.indices.len() / 3)
                    .sum::<usize>();
                let feature_primitives = gltf_feature_primitives(&model.glb)?;
                let mut primitive_base = 0_u32;
                let mut model_sources = Vec::with_capacity(model.glb.primitives.len());
                for primitive in &model.glb.primitives {
                    if !primitive.indices.is_empty() {
                        model_sources.push(TriangleMeshPickSource {
                            positions: &primitive.exact_positions,
                            indices: &primitive.indices,
                            transform: WorldTransform::IDENTITY,
                            leaf_origin: WorldVec3 {
                                x: 0.0,
                                y: 0.0,
                                z: 0.0,
                            },
                            gpu_primitive_base: primitive_base,
                            source_primitive_base: u64::from(primitive_base),
                        });
                    }
                    primitive_base = primitive_base
                        .checked_add(
                            u32::try_from(primitive.indices.len() / 3)
                                .map_err(|_| "i3dm model primitive count exceeds u32")?,
                        )
                        .ok_or_else(|| "i3dm model primitive range overflowed".to_owned())?;
                }
                let shared_model = if model_sources.is_empty() {
                    None
                } else {
                    Some(Arc::new(
                        TriangleMeshPickRefiner::build(&model_sources)
                            .map_err(|error| error.to_string())?,
                    ))
                };
                let batch_table = Arc::new(model.legacy_metadata_catalog());
                for chunk in instanced_model_chunks(model) {
                    let proxy_id = proxy_ids
                        .get(*leaf_index)
                        .ok_or_else(|| "3D Tiles instance chunk has no pick proxy".to_owned())?;
                    *leaf_index += 1;
                    let mut instances = Vec::with_capacity(chunk.instance_indices.len());
                    let mut feature_bindings = Vec::with_capacity(chunk.instance_indices.len());
                    for (local_instance, source_index) in
                        chunk.instance_indices.iter().copied().enumerate()
                    {
                        let instance = &model.instances[source_index];
                        feature_bindings.push(WasmI3dmFeatureBinding {
                            source_index: instance.source_index,
                            feature_id: instance.feature_id,
                        });
                        let gpu_instance_base = local_instance
                            .checked_mul(model_triangle_count)
                            .ok_or_else(|| "i3dm GPU primitive range overflowed".to_owned())?;
                        let source_instance_base = usize::try_from(instance.source_index)
                            .map_err(|_| "i3dm source instance exceeds usize".to_owned())?
                            .checked_mul(model_triangle_count)
                            .ok_or_else(|| "i3dm source primitive range overflowed".to_owned())?;
                        instances.push(TriangleMeshPickInstance {
                            world_from_model: instance.world_from_model,
                            gpu_primitive_base: u32::try_from(gpu_instance_base)
                                .map_err(|_| "i3dm GPU primitive range exceeds u32")?,
                            source_primitive_base: u64::try_from(source_instance_base)
                                .map_err(|_| "i3dm source primitive range exceeds u64")?,
                        });
                    }
                    feature_bindings.sort_unstable_by_key(|binding| binding.source_index);
                    if let Some(shared_model) = &shared_model {
                        let index = InstancedTriangleMeshPickRefiner::build(
                            Arc::clone(shared_model),
                            &instances,
                        )
                        .map_err(|error| error.to_string())?;
                        if output.insert(proxy_id.0.clone(), index.into()).is_some() {
                            return Err("duplicate instanced mesh pick proxy identity".to_owned());
                        }
                    }
                    let catalog = WasmGltfFeatureCatalog {
                        structural_metadata: model.glb.structural_metadata.clone(),
                        feature_images: model.glb.feature_images.clone(),
                        primitives: feature_primitives.clone(),
                        legacy: Some(WasmLegacyFeatureCatalog::I3dm {
                            model_triangle_count: u64::try_from(model_triangle_count)
                                .map_err(|_| "i3dm model triangle count exceeds u64")?,
                            instances: feature_bindings,
                            batch_table: Arc::clone(&batch_table),
                        }),
                    };
                    if feature_output.insert(proxy_id.0.clone(), catalog).is_some() {
                        return Err("duplicate i3dm feature proxy identity".to_owned());
                    }
                }
            }
            DecodedThreeDTilesContent::Points(points) => {
                let proxy_id = proxy_ids
                    .get(*leaf_index)
                    .ok_or_else(|| "3D Tiles point leaf has no pick proxy".to_owned())?;
                *leaf_index += 1;
                let point_count = u32::try_from(points.points.positions.len())
                    .map_err(|_| "pnts source point count exceeds u32")?;
                let catalog = WasmGltfFeatureCatalog {
                    structural_metadata: None,
                    feature_images: BTreeMap::new(),
                    primitives: Vec::new(),
                    legacy: Some(WasmLegacyFeatureCatalog::Pnts {
                        point_count,
                        batch_ids: points.batch_ids.clone(),
                        batch_table: Arc::new(points.legacy_metadata_catalog()),
                    }),
                };
                if feature_output.insert(proxy_id.0.clone(), catalog).is_some() {
                    return Err("duplicate pnts feature proxy identity".to_owned());
                }
            }
            DecodedThreeDTilesContent::Composite(children) => {
                for child in children {
                    visit(child, proxy_ids, leaf_index, output, feature_output)?;
                }
            }
        }
        Ok(())
    }

    let mut leaf_index = 0;
    visit(content, proxy_ids, &mut leaf_index, output, feature_output)?;
    if leaf_index != proxy_ids.len() {
        return Err("3D Tiles mesh pick leaf count changed".to_owned());
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn gltf_feature_primitives(
    glb: &himmelcad_render::DecodedGlb,
) -> Result<Vec<WasmGltfFeaturePrimitive>, String> {
    let mut primitive_base = 0_u64;
    glb.primitives
        .iter()
        .map(|primitive| {
            let triangle_count = u64::try_from(primitive.indices.len() / 3)
                .map_err(|_| "glTF triangle count exceeds u64".to_owned())?;
            let result = WasmGltfFeaturePrimitive {
                source_start: primitive_base,
                triangle_count,
                features: primitive.features.clone(),
                property_attributes: primitive.property_attributes.clone(),
                property_textures: primitive.property_textures.clone(),
                legacy_batch_ids: primitive.legacy_batch_ids.clone(),
            };
            primitive_base = primitive_base
                .checked_add(triangle_count)
                .ok_or_else(|| "glTF primitive range overflowed".to_owned())?;
            Ok(result)
        })
        .collect()
}

#[cfg(target_arch = "wasm32")]
fn pick_metadata_value(
    mesh_pick_indices: &BTreeMap<String, MeshPickRefiner>,
    catalogs: &BTreeMap<String, WasmGltfFeatureCatalog>,
    render_proxy_id: &str,
    source_primitive_id: u64,
    world_position: WorldVec3,
) -> Result<serde_json::Value, JsValue> {
    let catalog = catalogs
        .get(render_proxy_id)
        .ok_or_else(|| JsValue::from_str("pick metadata is not resident"))?;
    let point_content = matches!(&catalog.legacy, Some(WasmLegacyFeatureCatalog::Pnts { .. }));
    let barycentric = if point_content {
        None
    } else {
        Some(
            mesh_pick_indices
                .get(render_proxy_id)
                .and_then(|index| {
                    index.source_triangle_barycentric(source_primitive_id, world_position)
                })
                .ok_or_else(|| JsValue::from_str("pick metadata mesh hit is not resident"))?,
        )
    };
    pick_metadata_catalog_json(catalog, source_primitive_id, barycentric).map_err(js_error)
}

#[cfg(target_arch = "wasm32")]
fn potree_pick_metadata_value(
    request: &WasmPotreeRequest,
    source_primitive_id: u64,
) -> Result<serde_json::Value, JsValue> {
    let (
        world_position,
        intensity,
        classification,
        return_number,
        number_of_returns,
        point_source_id,
        source_color,
    ) = if request.layout.encoding.eq_ignore_ascii_case("BROTLI") {
        let decoded = request
            .decoded
            .as_ref()
            .ok_or_else(|| JsValue::from_str("resident BROTLI Potree decode is missing"))?;
        let index = usize::try_from(source_primitive_id)
            .ok()
            .filter(|index| *index < decoded.positions.len())
            .ok_or_else(|| JsValue::from_str("Potree source point is not resident"))?;
        let local = decoded.positions[index];
        let packed = decoded
            .civil_attributes
            .as_ref()
            .and_then(|attributes| attributes.get(index))
            .copied()
            .unwrap_or_default();
        let has_source_color = request.layout.attributes.iter().any(|attribute| {
            attribute.name.eq_ignore_ascii_case("rgb")
                || attribute.name.eq_ignore_ascii_case("rgba")
        });
        (
            WorldVec3 {
                x: decoded.world_origin.x + f64::from(local[0]),
                y: decoded.world_origin.y + f64::from(local[1]),
                z: decoded.world_origin.z + f64::from(local[2]),
            },
            packed.intensity(),
            packed.classification(),
            packed.return_number(),
            packed.number_of_returns(),
            packed.point_source_id(),
            has_source_color.then_some(decoded.colors[index]),
        )
    } else {
        let metadata = request
            .layout
            .point_metadata(
                &request.bytes,
                request.metadata.point_count,
                source_primitive_id,
            )
            .map_err(js_error)?;
        let world_position = potree_point_world_position(
            &request.layout,
            &request.bytes,
            request.metadata.point_count,
            source_primitive_id,
        )
        .map_err(js_error)?
        .ok_or_else(|| JsValue::from_str("Potree source point is not resident"))?;
        (
            world_position,
            metadata.intensity,
            metadata.classification,
            metadata.return_number,
            metadata.number_of_returns,
            metadata.point_source_id,
            metadata.source_color,
        )
    };
    Ok(serde_json::json!({
        "sourcePrimitiveId": source_primitive_id,
        "barycentric": null,
        "providers": {
            "gltf": null,
            "legacy": null,
            "potree": {
                "provider": "potree",
                "metadata": {
                    "datasetId": request.metadata.dataset_id,
                    "tileId": request.metadata.tile_id,
                    "pointIndex": source_primitive_id,
                    "worldPosition": world_position,
                    "intensity": intensity,
                    "classification": classification,
                    "returnNumber": return_number,
                    "numberOfReturns": number_of_returns,
                    "pointSourceId": point_source_id,
                    "sourceColor": source_color,
                }
            }
        }
    }))
}

#[cfg(target_arch = "wasm32")]
fn gltf_feature_catalog_json(
    catalog: &WasmGltfFeatureCatalog,
    source_primitive_id: u64,
    barycentric: [f64; 3],
) -> Result<Option<serde_json::Value>, String> {
    let (model_primitive_id, instance_metadata) = if let Some(WasmLegacyFeatureCatalog::I3dm {
        model_triangle_count,
        instances,
        batch_table,
    }) = &catalog.legacy
    {
        if *model_triangle_count == 0 {
            return Ok(None);
        }
        let source_index = source_primitive_id / *model_triangle_count;
        let source_index_u32 = u32::try_from(source_index)
            .map_err(|_| "i3dm instance index exceeds u32".to_owned())?;
        let binding = instances
            .binary_search_by_key(&source_index_u32, |binding| binding.source_index)
            .ok()
            .and_then(|index| instances.get(index))
            .ok_or_else(|| "i3dm source primitive addresses a non-resident instance".to_owned())?;
        let batch_row = batch_table
            .direct_row(binding.feature_id)
            .map_err(|error| error.to_string())?;
        (
            source_primitive_id % *model_triangle_count,
            Some(serde_json::json!({
                "index": source_index,
                "featureId": binding.feature_id,
                "batchLength": batch_table.batch_length(),
                "batchTableRow": batch_row,
            })),
        )
    } else {
        (source_primitive_id, None)
    };
    let Some(primitive) = catalog.primitives.iter().find(|primitive| {
        model_primitive_id >= primitive.source_start
            && model_primitive_id - primitive.source_start < primitive.triangle_count
    }) else {
        return Ok(None);
    };
    let triangle_index = usize::try_from(model_primitive_id - primitive.source_start)
        .map_err(|_| "glTF feature triangle index exceeds address space".to_owned())?;
    let feature_sets = primitive
        .features
        .iter()
        .map(|feature| -> Result<serde_json::Value, String> {
            let binding = match &feature.binding {
                DecodedFeatureIdBinding::Implicit { .. } => {
                    serde_json::json!({ "kind": "implicitVertex" })
                }
                DecodedFeatureIdBinding::Attribute { attribute, .. } => {
                    serde_json::json!({ "kind": "attribute", "attribute": attribute })
                }
                DecodedFeatureIdBinding::Texture { descriptor, .. } => {
                    serde_json::json!({ "kind": "texture", "descriptor": descriptor })
                }
            };
            let resolved_feature =
                resolve_gltf_feature(catalog, feature, triangle_index, barycentric)?;
            let resolved = match resolved_feature {
                Some(DecodedTriangleFeatureId::Feature(id)) => {
                    serde_json::json!({ "kind": "feature", "id": id })
                }
                Some(DecodedTriangleFeatureId::Null) => serde_json::json!({ "kind": "null" }),
                Some(DecodedTriangleFeatureId::Texture) => {
                    serde_json::json!({ "kind": "textureSampleRequired" })
                }
                Some(DecodedTriangleFeatureId::Ambiguous) | None => {
                    serde_json::json!({ "kind": "unresolved" })
                }
            };
            let property_table = feature.property_table.and_then(|index| {
                catalog
                    .structural_metadata
                    .as_ref()?
                    .property_tables
                    .get(index)
                    .cloned()
            });
            let property_row = match (feature.property_table, resolved_feature) {
                (Some(table), Some(DecodedTriangleFeatureId::Feature(id))) => Some(
                    catalog
                        .structural_metadata
                        .as_ref()
                        .ok_or_else(|| "linked glTF structural metadata is missing".to_owned())?
                        .property_table_row(table, id)
                        .map_err(|error| error.to_string())?,
                ),
                _ => None,
            };
            Ok(serde_json::json!({
                "featureCount": feature.feature_count,
                "label": feature.label,
                "nullFeatureId": feature.null_feature_id,
                "propertyTable": feature.property_table,
                "propertyTableDefinition": property_table,
                "propertyRow": property_row,
                "binding": binding,
                "resolved": resolved,
            }))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let structural_metadata = catalog
        .structural_metadata
        .as_ref()
        .map(gltf_structural_metadata_json);
    let property_attributes = primitive
        .property_attributes
        .iter()
        .filter_map(|attribute| attribute.values_at_triangle(triangle_index, barycentric))
        .collect::<Vec<_>>();
    let property_textures = primitive
        .property_textures
        .iter()
        .map(|texture| {
            gltf_property_texture_json(
                texture,
                &catalog.feature_images,
                triangle_index,
                barycentric,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(serde_json::json!({
        "sourcePrimitiveId": source_primitive_id,
        "triangleIndex": triangle_index,
        "barycentric": barycentric,
        "featureSets": feature_sets,
        "propertyAttributes": property_attributes,
        "propertyTextures": property_textures,
        "structuralMetadata": structural_metadata,
        "instance": instance_metadata,
    })))
}

#[cfg(target_arch = "wasm32")]
fn pick_metadata_catalog_json(
    catalog: &WasmGltfFeatureCatalog,
    source_primitive_id: u64,
    barycentric: Option<[f64; 3]>,
) -> Result<serde_json::Value, String> {
    let gltf = barycentric
        .map(|barycentric| gltf_feature_catalog_json(catalog, source_primitive_id, barycentric))
        .transpose()?
        .flatten();
    let legacy = legacy_feature_catalog_json(catalog, source_primitive_id, barycentric)?;
    Ok(serde_json::json!({
        "sourcePrimitiveId": source_primitive_id,
        "barycentric": barycentric,
        "providers": {
            "gltf": gltf.map(|metadata| serde_json::json!({
                "provider": "gltf",
                "metadata": metadata,
            })),
            "legacy": legacy,
            "potree": null,
        },
    }))
}

#[cfg(target_arch = "wasm32")]
fn legacy_feature_catalog_json(
    catalog: &WasmGltfFeatureCatalog,
    source_primitive_id: u64,
    barycentric: Option<[f64; 3]>,
) -> Result<Option<serde_json::Value>, String> {
    if catalog.legacy.is_none() {
        return Ok(None);
    }
    let (provider, source, feature_id, batch_table) =
        resolve_legacy_pick(catalog, source_primitive_id, barycentric)?;
    let (direct_row, resolved_row, hierarchy) = if let Some(feature_id) = feature_id {
        let direct = batch_table
            .direct_row(feature_id)
            .map_err(|error| error.to_string())?;
        let resolved = batch_table
            .resolved_row(feature_id)
            .map_err(|error| error.to_string())?;
        let hierarchy = batch_table
            .hierarchy_row(feature_id)
            .map_err(|error| error.to_string())?
            .map(|row| {
                serde_json::json!({
                    "exactInstance": legacy_hierarchy_instance_json(&row.exact_instance),
                    "ancestors": row
                        .ancestors
                        .iter()
                        .map(legacy_hierarchy_instance_json)
                        .collect::<Vec<_>>(),
                })
            });
        (direct, resolved, hierarchy)
    } else {
        (None, None, None)
    };
    Ok(Some(serde_json::json!({
        "provider": provider,
        "source": source,
        "featureId": feature_id,
        "batchLength": batch_table.batch_length(),
        "directRow": direct_row,
        "resolvedRow": resolved_row,
        "hierarchy": hierarchy,
    })))
}

#[cfg(target_arch = "wasm32")]
fn resolve_legacy_pick(
    catalog: &WasmGltfFeatureCatalog,
    source_primitive_id: u64,
    barycentric: Option<[f64; 3]>,
) -> Result<
    (
        &'static str,
        serde_json::Value,
        Option<u32>,
        &DecodedLegacyBatchTableCatalog,
    ),
    String,
> {
    Ok(
        match catalog
            .legacy
            .as_ref()
            .expect("legacy catalog checked by caller")
        {
            WasmLegacyFeatureCatalog::B3dm { batch_table } => {
                let barycentric = barycentric
                    .ok_or_else(|| "b3dm metadata requires an exact mesh barycentric".to_owned())?;
                let primitive = catalog
                    .primitives
                    .iter()
                    .find(|primitive| {
                        source_primitive_id >= primitive.source_start
                            && source_primitive_id - primitive.source_start
                                < primitive.triangle_count
                    })
                    .ok_or_else(|| "b3dm source triangle is missing".to_owned())?;
                let triangle_index = usize::try_from(source_primitive_id - primitive.source_start)
                    .map_err(|_| "b3dm source triangle exceeds address space".to_owned())?;
                let feature_id = primitive
                    .legacy_batch_ids
                    .as_ref()
                    .and_then(|ids| ids.feature_id_at_triangle(triangle_index, barycentric))
                    .and_then(|feature| match feature {
                        DecodedTriangleFeatureId::Feature(feature_id) => Some(feature_id),
                        DecodedTriangleFeatureId::Null
                        | DecodedTriangleFeatureId::Ambiguous
                        | DecodedTriangleFeatureId::Texture => None,
                    });
                (
                    "b3dm",
                    serde_json::json!({
                        "kind": "triangle",
                        "triangleIndex": source_primitive_id,
                        "primitiveTriangleIndex": triangle_index,
                    }),
                    feature_id,
                    batch_table.as_ref(),
                )
            }
            WasmLegacyFeatureCatalog::I3dm {
                model_triangle_count,
                instances,
                batch_table,
            } => {
                if *model_triangle_count == 0 {
                    return Err("i3dm model has no source triangles".to_owned());
                }
                let source_index = source_primitive_id / *model_triangle_count;
                let source_index_u32 = u32::try_from(source_index)
                    .map_err(|_| "i3dm source instance exceeds u32".to_owned())?;
                let binding = instances
                    .binary_search_by_key(&source_index_u32, |binding| binding.source_index)
                    .ok()
                    .and_then(|index| instances.get(index))
                    .ok_or_else(|| {
                        "i3dm source instance is not resident in this proxy".to_owned()
                    })?;
                (
                    "i3dm",
                    serde_json::json!({
                        "kind": "instance",
                        "instanceIndex": source_index,
                        "modelTriangleIndex": source_primitive_id % *model_triangle_count,
                    }),
                    Some(binding.feature_id),
                    batch_table.as_ref(),
                )
            }
            WasmLegacyFeatureCatalog::Pnts {
                point_count,
                batch_ids,
                batch_table,
            } => {
                let point_index = u32::try_from(source_primitive_id)
                    .map_err(|_| "pnts source point exceeds u32".to_owned())?;
                if point_index >= *point_count {
                    return Err("pnts source point is out of range".to_owned());
                }
                let feature_id = batch_ids
                    .as_ref()
                    .and_then(|ids| ids.get(usize::try_from(point_index).expect("u32 fits usize")))
                    .copied()
                    .or_else(|| (point_index < batch_table.batch_length()).then_some(point_index));
                (
                    "pnts",
                    serde_json::json!({
                        "kind": "point",
                        "pointIndex": point_index,
                    }),
                    feature_id,
                    batch_table.as_ref(),
                )
            }
        },
    )
}

#[cfg(target_arch = "wasm32")]
fn legacy_hierarchy_instance_json(
    instance: &himmelcad_render::DecodedLegacyHierarchyInstance,
) -> serde_json::Value {
    serde_json::json!({
        "instanceId": instance.instance_id,
        "classId": instance.class_id,
        "className": instance.class_name,
        "classInstanceIndex": instance.class_instance_index,
        "parentIds": instance.parent_ids,
    })
}

#[cfg(target_arch = "wasm32")]
fn gltf_structural_metadata_json(metadata: &DecodedStructuralMetadata) -> serde_json::Value {
    serde_json::json!({
        "schema": metadata.schema,
        "schemaUri": metadata.schema_uri,
        "propertyTables": metadata.property_tables,
        "propertyTextures": metadata.property_textures,
        "propertyAttributes": metadata.property_attributes,
    })
}

#[cfg(target_arch = "wasm32")]
fn gltf_property_texture_json(
    texture: &DecodedPrimitivePropertyTexture,
    images: &BTreeMap<usize, DecodedFeatureImage>,
    triangle_index: usize,
    barycentric: [f64; 3],
) -> Result<serde_json::Value, String> {
    let properties = texture
        .samples_at_triangle(triangle_index, barycentric)
        .into_iter()
        .map(|sample| {
            let value = images
                .get(&sample.image_index)
                .ok_or_else(|| "glTF property texture image is not resident".to_owned())?
                .property_value(&sample)
                .map_err(|error| error.to_string())?;
            Ok((
                sample.name.clone(),
                serde_json::json!({
                    "value": value,
                    "imageIndex": sample.image_index,
                    "texCoord": sample.tex_coord,
                    "channels": sample.channels,
                }),
            ))
        })
        .collect::<Result<serde_json::Map<_, _>, String>>()?;
    Ok(serde_json::json!({
        "definitionIndex": texture.definition_index,
        "class": texture.class_name,
        "definition": texture.definition,
        "properties": properties,
    }))
}

#[cfg(target_arch = "wasm32")]
fn resolve_gltf_feature(
    catalog: &WasmGltfFeatureCatalog,
    feature: &DecodedMeshFeatureSet,
    triangle_index: usize,
    barycentric: [f64; 3],
) -> Result<Option<DecodedTriangleFeatureId>, String> {
    let Some(resolved) = feature.feature_id_at_triangle(triangle_index, barycentric) else {
        return Ok(None);
    };
    if resolved != DecodedTriangleFeatureId::Texture {
        return Ok(Some(resolved));
    }
    let sample = feature
        .feature_texture_sample_at_triangle(triangle_index, barycentric)
        .ok_or_else(|| "glTF feature texture coordinate is missing".to_owned())?;
    let feature_id = catalog
        .feature_images
        .get(&sample.image_index)
        .ok_or_else(|| "glTF feature texture image is not resident".to_owned())?
        .feature_id(&sample)
        .ok_or_else(|| "glTF feature texture sample is invalid".to_owned())?;
    let feature_id =
        u32::try_from(feature_id).map_err(|_| "glTF texture feature ID exceeds u32".to_owned())?;
    if Some(feature_id) == feature.null_feature_id {
        return Ok(Some(DecodedTriangleFeatureId::Null));
    }
    if feature_id >= feature.feature_count {
        return Err(format!(
            "glTF texture feature ID {feature_id} exceeds feature count {}",
            feature.feature_count
        ));
    }
    Ok(Some(DecodedTriangleFeatureId::Feature(feature_id)))
}

#[cfg(target_arch = "wasm32")]
fn collect_inline_mesh_pick_indices(
    request: &WasmEntityRenderRequest,
    entity_requests: &BTreeMap<String, WasmEntityRenderRequest>,
    block_definitions: &BTreeMap<String, BlockDefinition>,
    block_member_styles: &BTreeMap<String, (CanonicalResourceRef, RenderStyle)>,
    block_member_entity_versions: &BTreeMap<String, (EntityVersionRef, WasmEntityRenderRequest)>,
    mesh_resources: &BTreeMap<String, TriangleMeshGeometry>,
    output: &mut BTreeMap<String, MeshPickRefiner>,
) -> Result<(), String> {
    if let GeometryObject::Block { .. } = &request.geometry {
        let mut members = Vec::new();
        collect_block_member_requests(
            request,
            entity_requests,
            block_definitions,
            block_member_styles,
            block_member_entity_versions,
            &mut Vec::new(),
            &mut members,
        )?;
        for member in &members {
            collect_inline_mesh_pick_indices(
                member,
                entity_requests,
                block_definitions,
                block_member_styles,
                block_member_entity_versions,
                mesh_resources,
                output,
            )?;
        }
        return Ok(());
    }
    let generated;
    let mut additional_placement = Transform3d::IDENTITY;
    let mesh = match &request.geometry {
        GeometryObject::Surface3d { mesh } => Some(mesh.as_ref()),
        GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
            ElevationSurfaceGeometry::Tin { mesh, .. } => Some(mesh),
            ElevationSurfaceGeometry::Grid { .. } => None,
        },
        GeometryObject::Solid { solid } => match solid.as_ref() {
            SolidGeometry::ClosedMesh { mesh } => Some(mesh),
            solid if solid_requires_evaluated_mesh(solid) => {
                Some(evaluated_mesh_for_solid(request, solid, mesh_resources)?)
            }
            solid => {
                generated = tessellate_generated_solid_mesh(
                    solid,
                    CurveTessellationOptions {
                        chord_tolerance: request.chord_tolerance,
                        maximum_segments: request.maximum_curve_segments,
                        unresolved_height: request
                            .locked_plan_elevation
                            .map_or(UnresolvedHeightDisplay::Reject, |elevation| {
                                UnresolvedHeightDisplay::ViewPlane { elevation }
                            }),
                    },
                )
                .map_err(|error| error.to_string())?;
                if let Some((mesh, placement)) = generated.as_ref() {
                    additional_placement = *placement;
                    Some(mesh)
                } else {
                    None
                }
            }
        },
        GeometryObject::Extension { .. } => Some(
            mesh_resources
                .get(
                    request
                        .evaluated_mesh_resource_ref
                        .as_deref()
                        .ok_or_else(|| {
                            "geometry extension requires an authorized evaluated mesh resource"
                                .to_owned()
                        })?,
                )
                .ok_or_else(|| "geometry extension evaluated mesh is not registered".to_owned())?,
        ),
        _ => None,
    };
    let Some(mesh) = mesh else {
        return Ok(());
    };
    let mesh = resolve_registered_inline_mesh(mesh, mesh_resources)?;
    let TriangleMeshStorage::Inline {
        positions, indices, ..
    } = &mesh.storage
    else {
        return Ok(());
    };
    if indices.is_empty() {
        return Ok(());
    }
    let positions = positions
        .iter()
        .map(|position| WorldVec3 {
            x: position.x,
            y: position.y,
            z: position.z,
        })
        .collect::<Vec<_>>();
    let entity_placement =
        DMat4::from_cols_array(&request.placement.unwrap_or(Transform3d::IDENTITY).0);
    let solid_placement = DMat4::from_cols_array(&additional_placement.0);
    let source = TriangleMeshPickSource {
        positions: &positions,
        indices,
        transform: WorldTransform((entity_placement * solid_placement).to_cols_array()),
        leaf_origin: WorldVec3 {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        },
        gpu_primitive_base: 0,
        source_primitive_base: 0,
    };
    let index = TriangleMeshPickRefiner::build(&[source]).map_err(|error| error.to_string())?;
    if output
        .insert(request.proxy_id.clone(), index.into())
        .is_some()
    {
        return Err("duplicate mesh pick proxy identity".to_owned());
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn resolve_registered_mesh_geometry(
    geometry: &GeometryObject,
    evaluated_mesh_resource_ref: Option<&str>,
    mesh_resources: &BTreeMap<String, TriangleMeshGeometry>,
) -> Result<Option<GeometryObject>, String> {
    match geometry {
        GeometryObject::Surface3d { mesh }
            if matches!(mesh.storage, TriangleMeshStorage::Resource { .. }) =>
        {
            Ok(Some(GeometryObject::Surface3d {
                mesh: Box::new(resolve_registered_inline_mesh(mesh, mesh_resources)?.clone()),
            }))
        }
        GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
            ElevationSurfaceGeometry::Tin { mesh, breaklines }
                if matches!(mesh.storage, TriangleMeshStorage::Resource { .. }) =>
            {
                Ok(Some(GeometryObject::ElevationSurface {
                    surface: Box::new(ElevationSurfaceGeometry::Tin {
                        mesh: resolve_registered_inline_mesh(mesh, mesh_resources)?.clone(),
                        breaklines: breaklines.clone(),
                    }),
                }))
            }
            _ => Ok(None),
        },
        GeometryObject::Solid { solid } => match solid.as_ref() {
            SolidGeometry::ClosedMesh { mesh }
                if matches!(mesh.storage, TriangleMeshStorage::Resource { .. }) =>
            {
                Ok(Some(GeometryObject::Solid {
                    solid: Box::new(SolidGeometry::ClosedMesh {
                        mesh: resolve_registered_inline_mesh(mesh, mesh_resources)?.clone(),
                    }),
                }))
            }
            _ => Ok(None),
        },
        GeometryObject::Extension { .. } => {
            let hash = evaluated_mesh_resource_ref.ok_or_else(|| {
                "geometry extension requires an authorized evaluated mesh resource".to_owned()
            })?;
            let mesh = mesh_resources
                .get(hash)
                .ok_or_else(|| "geometry extension evaluated mesh is not registered".to_owned())?;
            Ok(Some(GeometryObject::Surface3d {
                mesh: Box::new(resolve_registered_inline_mesh(mesh, mesh_resources)?.clone()),
            }))
        }
        _ => Ok(None),
    }
}

#[cfg(target_arch = "wasm32")]
fn resolve_registered_inline_mesh<'a>(
    mut mesh: &'a TriangleMeshGeometry,
    mesh_resources: &'a BTreeMap<String, TriangleMeshGeometry>,
) -> Result<&'a TriangleMeshGeometry, String> {
    let mut visited = std::collections::BTreeSet::new();
    loop {
        let TriangleMeshStorage::Resource { resource } = &mesh.storage else {
            return Ok(mesh);
        };
        if !visited.insert(resource.object_hash.0.clone()) {
            return Err("cyclic registered mesh resource reference".to_owned());
        }
        mesh = mesh_resources
            .get(&resource.object_hash.0)
            .ok_or_else(|| "triangle mesh resource is not registered".to_owned())?;
    }
}

#[cfg(target_arch = "wasm32")]
fn add_mesh_pick_costs(
    world: &mut RenderWorld,
    indices: &BTreeMap<String, MeshPickRefiner>,
) -> Result<(), String> {
    let mut accounted_shared_models = BTreeSet::new();
    for (proxy_id, index) in indices {
        let shared_bytes = index
            .shared_resident_allocation()
            .filter(|(key, _)| accounted_shared_models.insert(*key))
            .map_or(0, |(_, bytes)| bytes);
        world
            .add_compiled_cost(
                &RenderProxyId(proxy_id.clone()),
                ResourceCost {
                    cpu_decoded_bytes: index
                        .exclusive_resident_bytes()
                        .saturating_add(shared_bytes),
                    ..ResourceCost::default()
                },
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn mesh_pick_resident_bytes(indices: &BTreeMap<String, MeshPickRefiner>) -> u64 {
    let mut accounted_shared_models = BTreeSet::new();
    indices.values().fold(0_u64, |bytes, index| {
        let shared_bytes = index
            .shared_resident_allocation()
            .filter(|(key, _)| accounted_shared_models.insert(*key))
            .map_or(0, |(_, bytes)| bytes);
        bytes
            .saturating_add(index.exclusive_resident_bytes())
            .saturating_add(shared_bytes)
    })
}

#[cfg(target_arch = "wasm32")]
fn add_gltf_feature_costs(
    world: &mut RenderWorld,
    catalogs: &BTreeMap<String, WasmGltfFeatureCatalog>,
) -> Result<(), String> {
    let mut accounted_legacy_tables = BTreeSet::new();
    for (proxy_id, catalog) in catalogs {
        let shared_legacy_bytes = legacy_batch_table_allocation(catalog)
            .filter(|(key, _)| accounted_legacy_tables.insert(*key))
            .map_or(0, |(_, bytes)| bytes);
        world
            .add_compiled_cost(
                &RenderProxyId(proxy_id.clone()),
                ResourceCost {
                    cpu_decoded_bytes: gltf_feature_catalog_resident_bytes(catalog)
                        .saturating_add(shared_legacy_bytes),
                    ..ResourceCost::default()
                },
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn gltf_feature_resident_bytes(catalogs: &BTreeMap<String, WasmGltfFeatureCatalog>) -> u64 {
    let mut accounted_legacy_tables = BTreeSet::new();
    catalogs.values().fold(0_u64, |bytes, catalog| {
        let shared_legacy_bytes = legacy_batch_table_allocation(catalog)
            .filter(|(key, _)| accounted_legacy_tables.insert(*key))
            .map_or(0, |(_, bytes)| bytes);
        bytes
            .saturating_add(gltf_feature_catalog_resident_bytes(catalog))
            .saturating_add(shared_legacy_bytes)
    })
}

#[cfg(target_arch = "wasm32")]
fn gltf_feature_catalog_resident_bytes(catalog: &WasmGltfFeatureCatalog) -> u64 {
    let metadata_bytes = catalog
        .structural_metadata
        .as_ref()
        .map_or(0_u64, |metadata| {
            let json_bytes = [&metadata.schema]
                .into_iter()
                .filter_map(|value| value.as_ref())
                .chain(metadata.property_tables.iter())
                .chain(metadata.property_textures.iter())
                .chain(metadata.property_attributes.iter())
                .fold(0_u64, |bytes, value| {
                    bytes.saturating_add(u64::try_from(value.to_string().len()).unwrap_or(u64::MAX))
                });
            metadata
                .property_table_buffer_views
                .values()
                .fold(json_bytes, |bytes, view| {
                    bytes.saturating_add(u64::try_from(view.capacity()).unwrap_or(u64::MAX))
                })
        });
    let feature_image_bytes = catalog.feature_images.values().fold(0_u64, |bytes, image| {
        bytes.saturating_add(u64::try_from(image.rgba8.capacity()).unwrap_or(u64::MAX))
    });
    catalog
        .primitives
        .iter()
        .fold(
            metadata_bytes.saturating_add(feature_image_bytes),
            |bytes, primitive| {
                let feature_bytes = primitive.features.iter().fold(bytes, |bytes, feature| {
                    let vertex_bytes = match &feature.binding {
                        DecodedFeatureIdBinding::Implicit { vertex_ids }
                        | DecodedFeatureIdBinding::Attribute { vertex_ids, .. } => {
                            vertex_ids.capacity().saturating_mul(size_of::<u32>())
                        }
                        DecodedFeatureIdBinding::Texture {
                            descriptor,
                            channels,
                            triangle_tex_coords,
                            ..
                        } => descriptor
                            .to_string()
                            .len()
                            .saturating_add(channels.capacity())
                            .saturating_add(
                                triangle_tex_coords
                                    .capacity()
                                    .saturating_mul(size_of::<[[f32; 2]; 3]>()),
                            ),
                    };
                    let triangle_bytes = feature
                        .triangle_vertex_ids
                        .capacity()
                        .saturating_mul(size_of::<[u32; 3]>())
                        .saturating_add(
                            feature
                                .triangle_ids
                                .capacity()
                                .saturating_mul(size_of::<DecodedTriangleFeatureId>()),
                        );
                    bytes
                        .saturating_add(u64::try_from(vertex_bytes).unwrap_or(u64::MAX))
                        .saturating_add(u64::try_from(triangle_bytes).unwrap_or(u64::MAX))
                });
                feature_bytes
                    .saturating_add(primitive_property_attribute_bytes(primitive))
                    .saturating_add(
                        primitive
                            .legacy_batch_ids
                            .as_ref()
                            .map_or(0, DecodedLegacyBatchIds::resident_bytes),
                    )
            },
        )
        .saturating_add(legacy_feature_catalog_exclusive_bytes(catalog))
}

#[cfg(target_arch = "wasm32")]
fn legacy_feature_catalog_exclusive_bytes(catalog: &WasmGltfFeatureCatalog) -> u64 {
    match &catalog.legacy {
        Some(WasmLegacyFeatureCatalog::I3dm { instances, .. }) => usize_to_u64(
            instances
                .capacity()
                .saturating_mul(size_of::<WasmI3dmFeatureBinding>()),
        ),
        Some(WasmLegacyFeatureCatalog::Pnts { batch_ids, .. }) => {
            batch_ids.as_ref().map_or(0, |ids| {
                usize_to_u64(ids.capacity().saturating_mul(size_of::<u32>()))
            })
        }
        Some(WasmLegacyFeatureCatalog::B3dm { .. }) | None => 0,
    }
}

#[cfg(target_arch = "wasm32")]
fn legacy_batch_table_allocation(catalog: &WasmGltfFeatureCatalog) -> Option<(usize, u64)> {
    let batch_table = match catalog.legacy.as_ref()? {
        WasmLegacyFeatureCatalog::B3dm { batch_table }
        | WasmLegacyFeatureCatalog::I3dm { batch_table, .. }
        | WasmLegacyFeatureCatalog::Pnts { batch_table, .. } => batch_table,
    };
    Some((
        Arc::as_ptr(batch_table) as usize,
        batch_table.resident_bytes(),
    ))
}

#[cfg(target_arch = "wasm32")]
fn primitive_property_attribute_bytes(primitive: &WasmGltfFeaturePrimitive) -> u64 {
    let attribute_bytes = primitive
        .property_attributes
        .iter()
        .fold(0_u64, |bytes, attribute| {
            let definition_bytes = attribute.definition.to_string().len();
            let triangle_bytes = attribute
                .triangle_vertex_indices
                .capacity()
                .saturating_mul(size_of::<[u32; 3]>());
            let property_bytes =
                attribute
                    .properties
                    .values()
                    .fold(0_usize, |property_bytes, property| {
                        property_bytes
                            .saturating_add(property.attribute.capacity())
                            .saturating_add(property.vertex_values.iter().fold(
                                0_usize,
                                |value_bytes, value| {
                                    value_bytes.saturating_add(value.to_string().len())
                                },
                            ))
                    });
            bytes.saturating_add(
                u64::try_from(
                    definition_bytes
                        .saturating_add(triangle_bytes)
                        .saturating_add(property_bytes),
                )
                .unwrap_or(u64::MAX),
            )
        });
    primitive
        .property_textures
        .iter()
        .fold(attribute_bytes, |bytes, texture| {
            let definition = texture.definition.to_string().len();
            let properties = texture
                .properties
                .values()
                .fold(0_usize, |bytes, property| {
                    bytes
                        .saturating_add(property.descriptor.to_string().len())
                        .saturating_add(property.channels.capacity())
                        .saturating_add(
                            property
                                .triangle_tex_coords
                                .capacity()
                                .saturating_mul(size_of::<[[f32; 2]; 3]>()),
                        )
                });
            bytes.saturating_add(
                u64::try_from(definition.saturating_add(properties)).unwrap_or(u64::MAX),
            )
        })
}

#[cfg(target_arch = "wasm32")]
fn collect_leaf_metadata(
    content: &DecodedThreeDTilesContent,
    sorted_alpha: bool,
    output: &mut Vec<(RenderProxyKind, ResourceCost)>,
) {
    match content {
        DecodedThreeDTilesContent::Mesh(mesh) => {
            let vertices = mesh
                .glb
                .primitives
                .iter()
                .map(|primitive| primitive.vertices.len())
                .sum::<usize>();
            let triangles = mesh
                .glb
                .primitives
                .iter()
                .map(|primitive| primitive.indices.len() / 3)
                .sum::<usize>();
            output.push((
                RenderProxyKind::Triangles,
                ResourceCost {
                    cpu_decoded_bytes: usize_to_u64(vertices)
                        .saturating_mul(72)
                        .saturating_add(usize_to_u64(triangles).saturating_mul(12))
                        .saturating_add(mesh.legacy_metadata_resident_bytes())
                        .saturating_add(mesh.glb.primitives.iter().fold(
                            0_u64,
                            |bytes, primitive| {
                                bytes.saturating_add(
                                    primitive
                                        .legacy_batch_ids
                                        .as_ref()
                                        .map_or(0, DecodedLegacyBatchIds::resident_bytes),
                                )
                            },
                        )),
                    gpu_buffer_bytes: usize_to_u64(vertices)
                        .saturating_mul(48)
                        .saturating_add(usize_to_u64(triangles).saturating_mul(12)),
                    // Exact uploaded texture bytes are charged once by the
                    // kernel-wide immutable GPU texture cache.
                    gpu_texture_bytes: 0,
                    triangles: usize_to_u64(triangles),
                    draw_calls: u32::try_from(mesh.glb.primitives.len()).unwrap_or(u32::MAX),
                    ..ResourceCost::default()
                },
            ));
        }
        DecodedThreeDTilesContent::Points(points) => {
            let count = usize_to_u64(points.points.positions.len());
            output.push((
                RenderProxyKind::Points,
                ResourceCost {
                    cpu_decoded_bytes: count
                        .saturating_mul(16)
                        .saturating_add(points.legacy_metadata_resident_bytes())
                        .saturating_add(points.batch_ids.as_ref().map_or(0, |ids| {
                            usize_to_u64(ids.capacity().saturating_mul(size_of::<u32>()))
                        })),
                    gpu_buffer_bytes: count.saturating_mul(GPU_POINT_VERTEX_STRIDE_BYTES),
                    points: count,
                    draw_calls: 1,
                    ..ResourceCost::default()
                },
            ));
        }
        DecodedThreeDTilesContent::InstancedMesh(model) => {
            let vertices = model
                .glb
                .primitives
                .iter()
                .map(|primitive| primitive.vertices.len())
                .sum::<usize>();
            let model_triangles = model
                .glb
                .primitives
                .iter()
                .map(|primitive| primitive.indices.len() / 3)
                .sum::<usize>();
            for (chunk_index, chunk) in instanced_model_chunks(model).into_iter().enumerate() {
                let instance_count = chunk.instance_indices.len();
                output.push((
                    RenderProxyKind::Triangles,
                    ResourceCost {
                        cpu_decoded_bytes: usize_to_u64(vertices)
                            .saturating_mul(72)
                            .saturating_add(usize_to_u64(model_triangles).saturating_mul(12))
                            .saturating_add(usize_to_u64(instance_count).saturating_mul(136))
                            .saturating_add(if chunk_index == 0 {
                                model.legacy_metadata_resident_bytes()
                            } else {
                                0
                            }),
                        // Immutable indexed geometry is charged once by the
                        // kernel-wide GPU model cache. Instances remain tile-local.
                        gpu_buffer_bytes: usize_to_u64(instance_count).saturating_mul(112),
                        // Shared textures are global and must not be repeated
                        // for every i3dm instance chunk/owner proxy.
                        gpu_texture_bytes: 0,
                        triangles: usize_to_u64(model_triangles)
                            .saturating_mul(usize_to_u64(instance_count)),
                        draw_calls: u32::try_from(model.glb.primitives.len())
                            .unwrap_or(u32::MAX)
                            .saturating_mul(if sorted_alpha {
                                u32::try_from(
                                    instance_count.div_ceil(SORTED_ALPHA_MESH_INSTANCE_BLOCK_SIZE),
                                )
                                .unwrap_or(u32::MAX)
                            } else {
                                1
                            }),
                        ..ResourceCost::default()
                    },
                ));
            }
        }
        DecodedThreeDTilesContent::Composite(children) => {
            for child in children {
                collect_leaf_metadata(child, sorted_alpha, output);
            }
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn placed_stream_bounds(
    bounds: &BoundingVolume,
    source_to_project: WorldTransform,
) -> Result<BoundingVolume, String> {
    transform_bounding_volume(bounds, source_to_project)
        .ok_or_else(|| "streamed entity placement cannot transform provider bounds".to_owned())
}

#[cfg(target_arch = "wasm32")]
fn streamed_proxy(
    metadata: &WasmThreeDTilesMetadata,
    id: RenderProxyId,
    bounds: BoundingVolume,
) -> RenderProxy {
    RenderProxy {
        id,
        entity_id: metadata.entity_id.clone(),
        kind: RenderProxyKind::Triangles,
        bounds,
        dataset_id: Some(DatasetId(metadata.dataset_id.clone())),
        tile_id: Some(TileId(metadata.tile_id.clone())),
        style: metadata.style.clone(),
        cost: ResourceCost::default(),
        visible: true,
        locked: false,
    }
}

#[cfg(target_arch = "wasm32")]
fn potree_proxy(
    metadata: &WasmPotreeMetadata,
    id: RenderProxyId,
    bounds: BoundingVolume,
) -> RenderProxy {
    RenderProxy {
        id,
        entity_id: metadata.entity_id.clone(),
        kind: RenderProxyKind::Points,
        bounds,
        dataset_id: Some(DatasetId(metadata.dataset_id.clone())),
        tile_id: Some(TileId(metadata.tile_id.clone())),
        style: metadata.style.clone(),
        cost: ResourceCost::default(),
        visible: true,
        locked: false,
    }
}

#[cfg(target_arch = "wasm32")]
fn splat_proxy(
    metadata: &WasmGaussianSplatMetadata,
    id: RenderProxyId,
    bounds: BoundingVolume,
) -> RenderProxy {
    RenderProxy {
        id,
        entity_id: metadata.entity_id.clone(),
        kind: RenderProxyKind::GaussianSplats,
        bounds,
        dataset_id: Some(DatasetId(metadata.dataset_id.clone())),
        tile_id: Some(TileId(metadata.tile_id.clone())),
        style: metadata.style.clone(),
        cost: ResourceCost::default(),
        visible: true,
        locked: false,
    }
}

#[cfg(target_arch = "wasm32")]
fn raster_proxy(
    metadata: &WasmRasterMetadata,
    id: RenderProxyId,
    bounds: BoundingVolume,
) -> RenderProxy {
    RenderProxy {
        id,
        entity_id: metadata.entity_id.clone(),
        kind: RenderProxyKind::Raster,
        bounds,
        dataset_id: Some(DatasetId(metadata.dataset_id.clone())),
        tile_id: Some(TileId(metadata.tile_id.clone())),
        style: metadata.style.clone(),
        cost: ResourceCost::default(),
        visible: true,
        locked: false,
    }
}

#[cfg(target_arch = "wasm32")]
fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

#[cfg(target_arch = "wasm32")]
fn streamed_asset_limits() -> AssetBundleLimits {
    AssetBundleLimits {
        max_entries: 4_096,
        max_unique_assets: 4_096,
        max_asset_bytes: 256 * 1024 * 1024,
        max_blob_bytes: 512 * 1024 * 1024,
        max_uri_bytes: 16 * 1024,
        max_document_bytes: 1024 * 1024 * 1024,
        max_dependencies: 4_096,
        max_composite_depth: 8,
    }
}

#[cfg(target_arch = "wasm32")]
fn prepare_resolved_asset_bundle(
    cache: &SharedAssetBlobCache,
    manifest_json: &str,
    bytes: &[u8],
) -> Result<PreparedAssetBundle, JsValue> {
    let manifest: WasmResolvedAssetBundleManifest =
        serde_json::from_str(manifest_json).map_err(js_error)?;
    if manifest.schema_version != 1 {
        return Err(JsValue::from_str(
            "resolved asset bundle schemaVersion must be 1",
        ));
    }
    cache
        .prepare_packed(manifest.entries, bytes.to_vec(), streamed_asset_limits())
        .map_err(js_error)
}

#[cfg(target_arch = "wasm32")]
fn validate_streamed_metadata(
    stream_id: &str,
    entity_id: &str,
    proxy_id: &str,
    dataset_id: &str,
    tile_id: &str,
    bytes: &[u8],
    label: &str,
) -> Result<(), JsValue> {
    const MAX_TILE_BYTES: usize = 1_073_741_824;
    if [stream_id, entity_id, proxy_id, dataset_id, tile_id]
        .into_iter()
        .any(str::is_empty)
    {
        return Err(JsValue::from_str(
            "streamId, entityId, proxyId, datasetId and tileId must be non-empty",
        ));
    }
    if bytes.is_empty() || bytes.len() > MAX_TILE_BYTES {
        return Err(JsValue::from_str(&format!(
            "{label} content must contain 1 through 1073741824 bytes"
        )));
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn stream_provider_geometry(geometry: &GeometryObject) -> bool {
    match geometry {
        GeometryObject::PointCloud { .. } | GeometryObject::GaussianSplatCloud { .. } => true,
        GeometryObject::RasterImage { raster } => {
            matches!(raster.mapping, RasterMapping::OrthoGrid(_))
        }
        GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
            ElevationSurfaceGeometry::Grid { .. } => true,
            ElevationSurfaceGeometry::Tin { mesh, .. } => {
                matches!(mesh.storage, TriangleMeshStorage::Resource { .. })
            }
        },
        GeometryObject::Surface3d { mesh } => {
            matches!(mesh.storage, TriangleMeshStorage::Resource { .. })
        }
        GeometryObject::Solid { solid } => match solid.as_ref() {
            SolidGeometry::ClosedMesh { mesh } => {
                matches!(mesh.storage, TriangleMeshStorage::Resource { .. })
            }
            SolidGeometry::Brep { .. } => true,
            _ => false,
        },
        _ => false,
    }
}

#[cfg(target_arch = "wasm32")]
fn geometry_dataset_contract(geometry: &GeometryObject) -> Option<(&str, &ObjectHash)> {
    fn mesh_resource_contract(mesh: &TriangleMeshGeometry) -> Option<(&str, &ObjectHash)> {
        match &mesh.storage {
            TriangleMeshStorage::Resource { resource } => {
                Some((resource.media_type.as_str(), &resource.object_hash))
            }
            TriangleMeshStorage::Inline { .. } => None,
        }
    }
    match geometry {
        GeometryObject::PointCloud { dataset } | GeometryObject::GaussianSplatCloud { dataset } => {
            Some((dataset.format_id.as_str(), &dataset.metadata.object_hash))
        }
        GeometryObject::RasterImage { raster } => Some((
            raster.pixels.media_type.as_str(),
            &raster.pixels.object_hash,
        )),
        GeometryObject::ElevationSurface { surface } => match surface.as_ref() {
            ElevationSurfaceGeometry::Grid { raster, .. } => {
                Some((raster.media_type.as_str(), &raster.object_hash))
            }
            ElevationSurfaceGeometry::Tin { mesh, .. } => mesh_resource_contract(mesh),
        },
        GeometryObject::Surface3d { mesh } => mesh_resource_contract(mesh),
        GeometryObject::Solid { solid } => match solid.as_ref() {
            SolidGeometry::ClosedMesh { mesh } => mesh_resource_contract(mesh),
            SolidGeometry::Brep { resource } => {
                Some((resource.media_type.as_str(), &resource.object_hash))
            }
            _ => None,
        },
        _ => None,
    }
}

#[cfg(target_arch = "wasm32")]
fn validate_prepared_dataset_transaction(
    dataset_id: &str,
    contract: &WasmRegisteredDatasetContract,
    admissions_json: &str,
) -> Result<(), JsValue> {
    let admissions: Vec<WasmCanonicalRenderAdmission> =
        serde_json::from_str(admissions_json).map_err(js_error)?;
    if admissions.is_empty() {
        return Err(JsValue::from_str(
            "canonical render admission transaction must be non-empty",
        ));
    }
    for admission in &admissions {
        if admission.dataset_id.as_deref() != Some(dataset_id) {
            return Err(JsValue::from_str(
                "prepared dataset transaction must bind every admission to its registered dataset",
            ));
        }
        let (format_id, metadata_hash) =
            geometry_dataset_contract(&admission.admission.resolved_geometry).ok_or_else(|| {
                JsValue::from_str("streamed canonical geometry has no dataset format/hash contract")
            })?;
        if contract.format_id != format_id || contract.metadata_hash != *metadata_hash {
            return Err(JsValue::from_str(
                "prepared dataset format or metadata hash does not match canonical geometry",
            ));
        }
        let Some(evaluated) = &admission.evaluated_mesh else {
            continue;
        };
        if evaluated.dataset_id.as_deref() != Some(dataset_id)
            || evaluated.mesh_resource_ref != contract.metadata_hash
        {
            return Err(JsValue::from_str(
                "evaluated mesh does not match the prepared dataset transaction",
            ));
        }
        EvaluatedMeshRepresentation::new(
            admission.admission.selected.geometry_ref.clone(),
            evaluated.mesh_resource_ref.clone(),
            EvaluatedMeshRecipe {
                provider_id: evaluated.provider_id.clone(),
                provider_version: evaluated.provider_version.clone(),
                parameters_ref: evaluated.parameters_ref.clone(),
            },
            SectionTopologySnapshotKey {
                entity_id: admission.admission.entity.id.0.clone(),
                dataset_id: evaluated.dataset_id.clone(),
                version_hash: admission.admission.entity.version_hash.0.clone(),
            },
            evaluated.parts.clone(),
            evaluated.material_keys.clone(),
            evaluated.closed_manifold,
        )
        .map_err(js_error)?;
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn is_primary_representation(admission: &CanonicalRepresentationAdmission) -> bool {
    matches!(
        (admission.selected.role, admission.selected.authority),
        (
            RepresentationRole::Canonical,
            RepresentationAuthority::Authoritative
        ) | (
            RepresentationRole::Alternate,
            RepresentationAuthority::ImportedFallback
        )
    )
}

#[cfg(target_arch = "wasm32")]
fn canonical_slot_storage_key(slot: &GeometryRepresentationSlotKey) -> Result<String, String> {
    serde_json::to_string(slot).map_err(|error| error.to_string())
}

#[cfg(target_arch = "wasm32")]
fn canonical_slot_proxy_id(slot: &GeometryRepresentationSlotKey) -> Result<String, String> {
    let encoded = serde_json::to_vec(slot).map_err(|error| error.to_string())?;
    Ok(format!("slot-{}", ObjectHash::of_bytes(&encoded).0))
}

#[cfg(target_arch = "wasm32")]
fn canonical_render_request(
    request: &WasmCanonicalRenderAdmission,
    evaluated_mesh_ref: Option<ObjectHash>,
) -> Result<WasmEntityRenderRequest, String> {
    let slot = GeometryRepresentationSlotKey {
        entity_id: request.admission.entity.id.clone(),
        representation_slot: request.admission.representation_slot.clone(),
    };
    Ok(WasmEntityRenderRequest {
        entity_id: request.admission.entity.id.0.clone(),
        proxy_id: canonical_slot_proxy_id(&slot)?,
        version_hash: Some(request.admission.entity.version_hash.0.clone()),
        source_revision: Some(request.admission.entity.revision),
        attributes_ref: Some(request.admission.entity.attributes_ref.clone()),
        evaluated_mesh_resource_ref: evaluated_mesh_ref.map(|hash| hash.0),
        geometry: request.admission.resolved_geometry.clone(),
        style: request.style.clone(),
        placement: request.admission.entity.placement,
        locked_plan_elevation: request.locked_plan_elevation,
        chord_tolerance: request.chord_tolerance,
        maximum_curve_segments: request.maximum_curve_segments,
        line_width: request.line_width,
        plane_extent: request.plane_extent,
        fill_areas: request.fill_areas,
        exaggeration_datum: request.exaggeration_datum,
    })
}

#[cfg(target_arch = "wasm32")]
fn three_d_tiles_cost(
    request: &WasmThreeDTilesRequest,
    decoded: &DecodedThreeDTilesContent,
    decoded_stage: bool,
    sorted_alpha: bool,
) -> ResourceCost {
    let mut leaves = Vec::new();
    collect_leaf_metadata(decoded, sorted_alpha, &mut leaves);
    let mut cost = leaves
        .into_iter()
        .fold(ResourceCost::default(), |total, (_, leaf)| {
            total.saturating_add(leaf)
        });
    cost.cpu_compressed_bytes =
        usize_to_u64(request.bytes.len()).saturating_add(if decoded_stage {
            request.resources.unique_compressed_bytes()
        } else {
            0
        });
    if decoded_stage {
        cost.gpu_buffer_bytes = 0;
        cost.gpu_texture_bytes = 0;
        cost.points = 0;
        cost.triangles = 0;
        cost.draw_calls = 0;
    } else {
        cost.cpu_decoded_bytes = 0;
        cost.staging_bytes = 0;
    }
    cost
}

#[cfg(target_arch = "wasm32")]
fn potree_cost(request: &WasmPotreeRequest, decoded_stage: bool) -> ResourceCost {
    let count = request.metadata.point_count;
    let has_civil_attributes = request.layout.attributes.iter().any(|attribute| {
        matches!(
            attribute
                .name
                .chars()
                .filter(|character| !matches!(character, ' ' | '_' | '-'))
                .flat_map(char::to_lowercase)
                .collect::<String>()
                .as_str(),
            "intensity"
                | "classification"
                | "returnnumber"
                | "numberofreturns"
                | "pointsourceid"
                | "sourceid"
        )
    });
    let decoded_bytes_per_point = 16_u64 + u64::from(has_civil_attributes) * 8;
    let retains_decoded = request.layout.encoding.eq_ignore_ascii_case("BROTLI");
    ResourceCost {
        cpu_compressed_bytes: usize_to_u64(request.bytes.len()),
        cpu_decoded_bytes: if decoded_stage || retains_decoded {
            count.saturating_mul(decoded_bytes_per_point)
        } else {
            0
        },
        gpu_buffer_bytes: if decoded_stage {
            0
        } else {
            count.saturating_mul(GPU_POINT_VERTEX_STRIDE_BYTES)
        },
        points: if decoded_stage { 0 } else { count },
        draw_calls: u32::from(!decoded_stage),
        ..ResourceCost::default()
    }
}

#[cfg(target_arch = "wasm32")]
fn splat_cost(
    request: &WasmGaussianSplatRequest,
    splat_count: usize,
    pick_index_bytes: u64,
    decoded_stage: bool,
    sorted_alpha: bool,
) -> ResourceCost {
    let count = usize_to_u64(splat_count);
    ResourceCost {
        cpu_compressed_bytes: usize_to_u64(request.bytes.len()),
        cpu_decoded_bytes: if decoded_stage {
            count.saturating_mul(44).saturating_add(pick_index_bytes)
        } else {
            pick_index_bytes.saturating_add(if sorted_alpha {
                count.saturating_mul(60)
            } else {
                0
            })
        },
        gpu_buffer_bytes: if decoded_stage {
            0
        } else {
            count.saturating_mul(52)
        },
        splats: if decoded_stage { 0 } else { count },
        draw_calls: u32::from(!decoded_stage),
        ..ResourceCost::default()
    }
}

#[cfg(target_arch = "wasm32")]
fn raster_cost(
    request: &WasmRasterRequest,
    decoded: &himmelcad_render::DecodedElevationRaster,
    pick_index_bytes: u64,
    decoded_stage: bool,
) -> ResourceCost {
    let vertices = usize_to_u64(decoded.vertices.len());
    let indices = usize_to_u64(decoded.indices.len());
    let texture_bytes = u64::from(decoded.color_width)
        .saturating_mul(u64::from(decoded.color_height))
        .saturating_mul(4);
    ResourceCost {
        cpu_compressed_bytes: usize_to_u64(request.color.len())
            .saturating_add(usize_to_u64(request.elevations.len())),
        cpu_decoded_bytes: if decoded_stage {
            vertices
                .saturating_mul(48)
                .saturating_add(indices.saturating_mul(4))
                .saturating_add(texture_bytes)
                .saturating_add(pick_index_bytes)
        } else {
            pick_index_bytes
        },
        gpu_buffer_bytes: if decoded_stage {
            0
        } else {
            vertices
                .saturating_mul(48)
                .saturating_add(indices.saturating_mul(4))
        },
        gpu_texture_bytes: if decoded_stage { 0 } else { texture_bytes },
        triangles: if decoded_stage { 0 } else { indices / 3 },
        draw_calls: u32::from(!decoded_stage),
        ..ResourceCost::default()
    }
}

#[cfg(target_arch = "wasm32")]
fn scene_mutation_json(viewer: &WasmViewer) -> serde_json::Value {
    serde_json::json!({
        "entities": viewer.entity_requests.len(),
        "proxies": viewer.batches.len(),
        "generation": viewer.render_world.generation()
    })
}

#[cfg(target_arch = "wasm32")]
fn streaming_publish_json_with_upload(
    viewer: &WasmViewer,
    cost: ResourceCost,
    uploaded_bytes: u64,
    stream_ids: &[String],
) -> serde_json::Value {
    let mutation = scene_mutation_json(viewer);
    let streams = stream_ids
        .iter()
        .map(|stream_id| {
            serde_json::json!({
                "streamId": stream_id,
                "proxyIds": stream_render_proxy_ids(viewer, stream_id)
                    .into_iter()
                    .map(|proxy_id| proxy_id.0)
                    .collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "entities": mutation["entities"],
        "proxies": mutation["proxies"],
        "generation": mutation["generation"],
        "cost": cost,
        "uploadedBytes": uploaded_bytes,
        "streams": streams,
    })
}

#[cfg(target_arch = "wasm32")]
fn stream_render_proxy_ids(viewer: &WasmViewer, stream_id: &str) -> Vec<RenderProxyId> {
    let mut ids = viewer
        .streamed_requests
        .get(stream_id)
        .map(streamed_proxy_ids)
        .unwrap_or_default();
    ids.extend(
        viewer
            .potree_requests
            .get(stream_id)
            .map(|request| RenderProxyId(request.metadata.proxy_id.clone())),
    );
    ids.extend(
        viewer
            .splat_requests
            .get(stream_id)
            .map(|request| RenderProxyId(request.metadata.proxy_id.clone())),
    );
    ids.extend(
        viewer
            .raster_requests
            .get(stream_id)
            .map(|request| RenderProxyId(request.metadata.proxy_id.clone())),
    );
    ids
}

#[cfg(target_arch = "wasm32")]
fn purge_stream_state_after_render_commit(viewer: &mut WasmViewer, stream_id: &str) {
    let proxy_ids = stream_render_proxy_ids(viewer, stream_id);
    viewer.staged_three_d_tiles.remove(stream_id);
    viewer.staged_potree.remove(stream_id);
    viewer.staged_splats.remove(stream_id);
    viewer.staged_rasters.remove(stream_id);
    viewer.streamed_requests.remove(stream_id);
    if let Some(request) = viewer.potree_requests.remove(stream_id) {
        viewer
            .potree_proxy_streams
            .remove(&request.metadata.proxy_id);
    }
    if let Some(request) = viewer.splat_requests.remove(stream_id) {
        viewer
            .splat_proxy_streams
            .remove(&request.metadata.proxy_id);
    }
    if let Some(request) = viewer.raster_requests.remove(stream_id) {
        viewer
            .raster_proxy_streams
            .remove(&request.metadata.proxy_id);
    }
    viewer.splat_pick_indices.remove(stream_id);
    viewer.raster_pick_indices.remove(stream_id);
    viewer.external_asset_cache.evict(stream_id);
    viewer.gpu_model_cache.evict(stream_id);
    viewer.gpu_model_cache.release_staged(stream_id);
    viewer.gpu_texture_cache.evict(stream_id);
    viewer.gpu_texture_cache.release_staged(stream_id);
    for proxy_id in proxy_ids {
        viewer.batches.remove(&proxy_id);
        viewer.mesh_pick_indices.remove(&proxy_id.0);
        viewer.gltf_feature_catalogs.remove(&proxy_id.0);
        viewer.stream_proxy_transforms.remove(&proxy_id.0);
    }
    unbind_stream_entity_if_absent(viewer, stream_id);
}

#[cfg(target_arch = "wasm32")]
fn bind_stream_entity(
    viewer: &mut WasmViewer,
    stream_id: &str,
    entity_id: &str,
    dataset_id: &str,
    slot: &GeometryRepresentationSlotKey,
) {
    if let Some(previous) = viewer
        .stream_entities
        .insert(stream_id.to_owned(), entity_id.to_owned())
    {
        if previous != entity_id {
            if let Some(streams) = viewer.entity_streams.get_mut(&previous) {
                streams.remove(stream_id);
                if streams.is_empty() {
                    viewer.entity_streams.remove(&previous);
                }
            }
        }
    }
    viewer
        .entity_streams
        .entry(entity_id.to_owned())
        .or_default()
        .insert(stream_id.to_owned());
    let slot_key = canonical_slot_storage_key(slot)
        .expect("geometry representation slot keys are JSON serializable");
    if let Some(previous) = viewer
        .stream_slots
        .insert(stream_id.to_owned(), slot_key.clone())
    {
        if previous != slot_key {
            if let Some(streams) = viewer.slot_streams.get_mut(&previous) {
                streams.remove(stream_id);
                if streams.is_empty() {
                    viewer.slot_streams.remove(&previous);
                }
            }
        }
    }
    viewer
        .slot_streams
        .entry(slot_key)
        .or_default()
        .insert(stream_id.to_owned());
    if let Some(previous) = viewer
        .stream_datasets
        .insert(stream_id.to_owned(), dataset_id.to_owned())
    {
        if previous != dataset_id {
            if let Some(streams) = viewer.dataset_streams.get_mut(&previous) {
                streams.remove(stream_id);
                if streams.is_empty() {
                    viewer.dataset_streams.remove(&previous);
                }
            }
        }
    }
    viewer
        .dataset_streams
        .entry(dataset_id.to_owned())
        .or_default()
        .insert(stream_id.to_owned());
}

#[cfg(target_arch = "wasm32")]
fn unbind_stream_entity_if_absent(viewer: &mut WasmViewer, stream_id: &str) {
    let present = viewer.streamed_requests.contains_key(stream_id)
        || viewer.potree_requests.contains_key(stream_id)
        || viewer.splat_requests.contains_key(stream_id)
        || viewer.raster_requests.contains_key(stream_id)
        || viewer.staged_three_d_tiles.contains_key(stream_id)
        || viewer.staged_potree.contains_key(stream_id)
        || viewer.staged_splats.contains_key(stream_id)
        || viewer.staged_rasters.contains_key(stream_id);
    if present {
        return;
    }
    let Some(entity_id) = viewer.stream_entities.remove(stream_id) else {
        return;
    };
    if let Some(streams) = viewer.entity_streams.get_mut(&entity_id) {
        streams.remove(stream_id);
        if streams.is_empty() {
            viewer.entity_streams.remove(&entity_id);
        }
    }
    if let Some(dataset_id) = viewer.stream_datasets.remove(stream_id) {
        if let Some(streams) = viewer.dataset_streams.get_mut(&dataset_id) {
            streams.remove(stream_id);
            if streams.is_empty() {
                viewer.dataset_streams.remove(&dataset_id);
            }
        }
    }
    if let Some(slot_key) = viewer.stream_slots.remove(stream_id) {
        if let Some(streams) = viewer.slot_streams.get_mut(&slot_key) {
            streams.remove(stream_id);
            if streams.is_empty() {
                viewer.slot_streams.remove(&slot_key);
            }
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn persist_entity_style(
    viewer: &mut WasmViewer,
    entity_id: &str,
    style: &RenderStyle,
    exaggeration_datum: f64,
) {
    if let Some(request) = viewer.entity_requests.get_mut(entity_id) {
        request.style = style.clone();
        request.exaggeration_datum = exaggeration_datum;
    }
    let slot_keys = viewer
        .entity_slot_keys
        .get(entity_id)
        .into_iter()
        .flatten()
        .cloned()
        .collect::<Vec<_>>();
    for slot_key in slot_keys {
        if let Some(request) = viewer.slot_requests.get_mut(&slot_key) {
            request.style = style.clone();
            request.exaggeration_datum = exaggeration_datum;
        }
    }
    let stream_ids = viewer
        .entity_streams
        .get(entity_id)
        .into_iter()
        .flatten()
        .cloned()
        .collect::<Vec<_>>();
    for stream_id in stream_ids {
        if let Some(request) = viewer.streamed_requests.get_mut(&stream_id) {
            request.metadata.style = style.clone();
            request.metadata.exaggeration_datum = exaggeration_datum;
        }
        if let Some(request) = viewer.potree_requests.get_mut(&stream_id) {
            request.metadata.style = style.clone();
            request.metadata.exaggeration_datum = exaggeration_datum;
        }
        if let Some(request) = viewer.splat_requests.get_mut(&stream_id) {
            request.metadata.style = style.clone();
            request.metadata.exaggeration_datum = exaggeration_datum;
        }
        if let Some(request) = viewer.raster_requests.get_mut(&stream_id) {
            request.metadata.style = style.clone();
            request.metadata.exaggeration_datum = exaggeration_datum;
        }
        if let Some(staged) = viewer.staged_three_d_tiles.get_mut(&stream_id) {
            staged.request.metadata.style = style.clone();
            staged.request.metadata.exaggeration_datum = exaggeration_datum;
        }
        if let Some(staged) = viewer.staged_potree.get_mut(&stream_id) {
            staged.request.metadata.style = style.clone();
            staged.request.metadata.exaggeration_datum = exaggeration_datum;
        }
        if let Some(staged) = viewer.staged_splats.get_mut(&stream_id) {
            staged.request.metadata.style = style.clone();
            staged.request.metadata.exaggeration_datum = exaggeration_datum;
        }
        if let Some(staged) = viewer.staged_rasters.get_mut(&stream_id) {
            staged.request.metadata.style = style.clone();
            staged.request.metadata.exaggeration_datum = exaggeration_datum;
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn restore_entity_interaction(
    interactions: &mut BTreeMap<String, EntityInteractionState>,
    entity_id: &str,
    previous: Option<EntityInteractionState>,
) {
    if let Some(previous) = previous {
        interactions.insert(entity_id.to_owned(), previous);
    } else {
        interactions.remove(entity_id);
    }
}

#[cfg(target_arch = "wasm32")]
fn compilation_options(
    request: &WasmEntityRenderRequest,
    floating_origin: FloatingOrigin,
) -> EntityCompilationOptions {
    EntityCompilationOptions {
        floating_origin,
        unresolved_height: request
            .locked_plan_elevation
            .map_or(UnresolvedHeightDisplay::Reject, |elevation| {
                UnresolvedHeightDisplay::ViewPlane { elevation }
            }),
        chord_tolerance: request.chord_tolerance,
        maximum_curve_segments: request.maximum_curve_segments,
        line_width: request.line_width,
        plane_extent: request.plane_extent,
        fill_areas: request.fill_areas,
        style: request.style.clone(),
        exaggeration_datum: request.exaggeration_datum,
        placement: request.placement,
    }
}

#[cfg(target_arch = "wasm32")]
fn public_pick_candidate(
    viewer: &WasmViewer,
    candidate: &PickCandidate,
) -> Result<serde_json::Value, JsValue> {
    let presentation = viewer
        .entity_styles
        .get(&candidate.address.entity_id)
        .map_or(Ok(PresentationTransform::IDENTITY), |(style, datum)| {
            PresentationTransform::new(f64::from(style.vertical_exaggeration), *datum)
        })
        .map_err(js_error)?;
    let display_position = presentation.present(candidate.world_position);
    let unresolved_source_height = viewer
        .entity_requests
        .get(&candidate.address.entity_id)
        .is_some_and(|request| {
            request.locked_plan_elevation.is_some()
                && geometry_has_unresolved_height(&request.geometry)
        });
    let source_z = if unresolved_source_height {
        serde_json::Value::Null
    } else {
        serde_json::json!(candidate.world_position.z)
    };
    Ok(serde_json::json!({
        "address": candidate.address,
        "worldPosition": {
            "x": candidate.world_position.x,
            "y": candidate.world_position.y,
            "z": source_z,
        },
        "presentationPosition": display_position,
        "snapKind": candidate.snap_kind,
        "pixelDistance": candidate.pixel_distance,
        "depth": candidate.depth,
    }))
}

#[cfg(target_arch = "wasm32")]
fn geometry_has_unresolved_height(geometry: &GeometryObject) -> bool {
    match geometry {
        GeometryObject::Point { position } => position.z.is_none(),
        GeometryObject::Curve { curve } => curve_has_unresolved_height(curve),
        GeometryObject::Area { area } => area
            .outer
            .uses
            .iter()
            .chain(area.holes.iter().flat_map(|hole| &hole.uses))
            .any(curve_use_has_unresolved_height),
        GeometryObject::Solid { solid } => match solid.as_ref() {
            SolidGeometry::Extrusion { profile, .. } => profile
                .outer
                .uses
                .iter()
                .chain(profile.holes.iter().flat_map(|hole| &hole.uses))
                .any(curve_use_has_unresolved_height),
            SolidGeometry::Sweep { profile, path } => {
                profile
                    .outer
                    .uses
                    .iter()
                    .chain(profile.holes.iter().flat_map(|hole| &hole.uses))
                    .any(curve_use_has_unresolved_height)
                    || curve_has_unresolved_height(path)
            }
            SolidGeometry::ClosedMesh { .. }
            | SolidGeometry::Brep { .. }
            | SolidGeometry::Csg { .. }
            | SolidGeometry::Extension { .. } => false,
        },
        GeometryObject::Alignment { alignment } => {
            curve_has_unresolved_height(&alignment.horizontal)
        }
        GeometryObject::Text { text } => text.anchor.z.is_none(),
        GeometryObject::Label { label } => {
            annotation_anchor_has_unresolved_height(&label.target)
                || label.text.anchor.z.is_none()
                || label.leader.iter().any(|position| position.z.is_none())
        }
        GeometryObject::Dimension { dimension } => {
            dimension.placement.z.is_none()
                || dimension
                    .anchors
                    .iter()
                    .any(annotation_anchor_has_unresolved_height)
        }
        GeometryObject::Plane { .. }
        | GeometryObject::ElevationSurface { .. }
        | GeometryObject::Surface3d { .. }
        | GeometryObject::RasterImage { .. }
        | GeometryObject::PointCloud { .. }
        | GeometryObject::GaussianSplatCloud { .. }
        | GeometryObject::Panorama { .. }
        | GeometryObject::Block { .. }
        | GeometryObject::Extension { .. } => false,
    }
}

#[cfg(target_arch = "wasm32")]
fn curve_use_has_unresolved_height(curve_use: &CurveUse) -> bool {
    match curve_use {
        CurveUse::Inline { curve, .. } => curve_has_unresolved_height(curve),
        CurveUse::Associative { .. } => false,
    }
}

#[cfg(target_arch = "wasm32")]
fn curve_has_unresolved_height(curve: &CurveGeometry) -> bool {
    match curve {
        CurveGeometry::LineSegment { start, end } => start.z.is_none() || end.z.is_none(),
        CurveGeometry::Polyline { positions, .. }
        | CurveGeometry::Spline {
            control_points: positions,
            ..
        } => positions.iter().any(|position| position.z.is_none()),
        CurveGeometry::CircularArc {
            start,
            point_on_arc,
            end,
        } => start.z.is_none() || point_on_arc.z.is_none() || end.z.is_none(),
        CurveGeometry::Circle { center, .. }
        | CurveGeometry::Ellipse { center, .. }
        | CurveGeometry::EllipticArc { center, .. } => center.z.is_none(),
        CurveGeometry::ConicArc {
            start,
            control,
            end,
            ..
        } => start.z.is_none() || control.z.is_none() || end.z.is_none(),
        CurveGeometry::Clothoid { start, .. } => start.z.is_none(),
        CurveGeometry::Composite { segments } => segments.iter().any(curve_has_unresolved_height),
    }
}

#[cfg(target_arch = "wasm32")]
fn annotation_anchor_has_unresolved_height(anchor: &AnnotationAnchor) -> bool {
    matches!(anchor, AnnotationAnchor::Position { position } if position.z.is_none())
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn refine_pick_candidates(
    viewer: &WasmViewer,
    camera: &CameraFrame,
    viewport: [u32; 2],
    cursor_pixel: [u32; 2],
    radius: u32,
    coarse: &[PickCandidate],
) -> Result<Vec<PickCandidate>, String> {
    let cursor = [f64::from(cursor_pixel[0]), f64::from(cursor_pixel[1])];
    let cursor_ray = camera
        .cursor_ray(cursor, viewport)
        .map_err(|error| error.to_string())?;
    let floating_origin = FloatingOrigin::from_selected(1_024.0, camera.floating_origin)
        .map_err(|error| error.to_string())?;
    let mut refined = Vec::new();
    for candidate in coarse {
        let presentation_transform = viewer
            .entity_styles
            .get(&candidate.address.entity_id)
            .map_or(Ok(PresentationTransform::IDENTITY), |(style, datum)| {
                PresentationTransform::new(f64::from(style.vertical_exaggeration), *datum)
            })
            .map_err(|error| error.to_string())?;
        let mut project_coarse = candidate.clone();
        project_coarse.world_position = presentation_transform.source(candidate.world_position);
        let source_to_project = viewer
            .stream_proxy_transforms
            .get(&candidate.address.render_proxy_id)
            .copied()
            .unwrap_or(WorldTransform::IDENTITY);
        let snap_request = PickRefinementRequest {
            coarse: candidate,
            camera,
            cursor_ray,
            source_to_project,
            presentation_transform,
            cursor_pixel: cursor,
            viewport,
            pixel_tolerance: f64::from(radius).max(1.0) + 2.0,
        };
        if let Some(candidates) = refine_streamed_pick(viewer, snap_request)? {
            refined.extend(candidates);
            continue;
        }
        let Some(root_request) = viewer.entity_requests.get(&candidate.address.entity_id) else {
            refined.push(project_coarse.clone());
            continue;
        };
        let resolved_block_member =
            if matches!(&root_request.geometry, GeometryObject::Block { .. }) {
                resolve_block_pick_request(
                    root_request,
                    &candidate.address.render_proxy_id,
                    &viewer.entity_requests,
                    &viewer.block_definitions,
                    &viewer.block_member_styles,
                    &viewer.block_member_entity_versions,
                )?
            } else {
                None
            };
        let request = resolved_block_member.as_ref().unwrap_or(root_request);
        if viewer
            .raster_analysis_view
            .as_ref()
            .is_some_and(|analysis| analysis.entity_id == request.entity_id)
            && matches!(
                &request.geometry,
                GeometryObject::RasterImage { .. } | GeometryObject::Panorama { .. }
            )
        {
            if let Some(measurement) = raster_analysis_pick_measurement(viewer, request, cursor_ray)
            {
                let projected = camera
                    .project_world(measurement.source_position, viewport)
                    .map_err(|error| error.to_string())?;
                let mut exact = candidate.clone();
                exact.world_position = measurement.source_position;
                exact.snap_kind = SnapKind::RasterSample;
                exact.pixel_distance = (projected.pixel[0] - cursor[0])
                    .hypot(projected.pixel[1] - cursor[1])
                    .min(f64::from(f32::MAX)) as f32;
                exact.depth = projected.reverse_z_depth as f32;
                exact.address.primitive_id = Some(
                    u64::from(measurement.row)
                        .saturating_mul(raster_width(request).unwrap_or(0).into())
                        .saturating_add(u64::from(measurement.column)),
                );
                refined.push(exact);
            }
            continue;
        }
        if let GeometryObject::Point { position } = &request.geometry {
            let exact = resolve_entity_point_world(
                *position,
                &compilation_options(request, floating_origin),
            )
            .map_err(|error| error.to_string())?;
            let point_candidates = refine_exact_point_pick(snap_request, exact);
            if point_candidates.is_empty() {
                refined.push(project_coarse);
            } else {
                refined.extend(point_candidates);
            }
            continue;
        }
        if let GeometryObject::Panorama { panorama } = &request.geometry {
            let pose = match &panorama.image.mapping {
                RasterMapping::Camera { pose, .. } => *pose,
                _ => return Err("panorama requires a camera raster mapping".to_owned()),
            };
            let exact = resolve_entity_point_world(
                panorama_station_position(pose)?,
                &compilation_options(request, floating_origin),
            )
            .map_err(|error| error.to_string())?;
            let point_candidates = refine_exact_point_pick(snap_request, exact);
            if point_candidates.is_empty() {
                refined.push(project_coarse);
            } else {
                refined.extend(point_candidates);
            }
            continue;
        }
        let is_primary_stroke = candidate.address.render_proxy_id == request.proxy_id
            && matches!(
                &request.geometry,
                GeometryObject::Curve { .. }
                    | GeometryObject::Alignment { .. }
                    | GeometryObject::Area { .. }
            );
        let is_label_leader = matches!(&request.geometry, GeometryObject::Label { .. })
            && candidate.address.render_proxy_id == format!("{}#1", request.proxy_id);
        if !is_primary_stroke && !is_label_leader {
            refined.push(project_coarse.clone());
            continue;
        }
        validate_associative_area_references(request, &viewer.entity_requests)?;
        let strokes = tessellate_entity_strokes_with_associations(
            &request.geometry,
            &compilation_options(request, floating_origin),
            |entity_id, expected_version| {
                associative_curve_in_area_frame(
                    request,
                    &viewer.entity_requests,
                    entity_id,
                    expected_version,
                )
            },
        )
        .map_err(|error| error.to_string())?;
        if strokes.is_empty() {
            refined.push(project_coarse.clone());
            continue;
        }
        let start = refined.len();
        for stroke in &strokes {
            refined.extend(refine_tessellated_curve_pick(snap_request, stroke));
        }
        if refined.len() == start {
            refined.push(project_coarse);
        }
    }
    Ok(refined)
}

#[cfg(target_arch = "wasm32")]
fn raster_width(request: &WasmEntityRenderRequest) -> Option<u32> {
    match &request.geometry {
        GeometryObject::RasterImage { raster } => Some(raster.width),
        GeometryObject::Panorama { panorama } => Some(panorama.image.width),
        _ => None,
    }
}

#[cfg(target_arch = "wasm32")]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn raster_analysis_pick_measurement(
    viewer: &WasmViewer,
    request: &WasmEntityRenderRequest,
    cursor_ray: himmelcad_render::WorldRay,
) -> Option<WasmRasterDepthMeasurement> {
    let (raster, panorama) = match &request.geometry {
        GeometryObject::RasterImage { raster } => (raster.as_ref(), false),
        GeometryObject::Panorama { panorama } => (&panorama.image, true),
        _ => return None,
    };
    let RasterMapping::Camera { model, pose } = &raster.mapping else {
        return None;
    };
    let placement = DMat4::from_cols_array(&request.placement.unwrap_or(Transform3d::IDENTITY).0);
    let camera_pose = DMat4::from_cols_array(&pose.0);
    let camera_from_world = (placement * camera_pose).inverse();
    if !camera_from_world.is_finite() {
        return None;
    }
    let (column, row) = if panorama {
        if !matches!(model, CameraModel::Equirectangular) {
            return None;
        }
        let direction = camera_from_world
            .transform_vector3(dvec3(cursor_ray.direction))
            .try_normalize()?;
        let longitude = direction.x.atan2(direction.z);
        let latitude = direction.y.clamp(-1.0, 1.0).asin();
        let column = ((((longitude / std::f64::consts::TAU) + 0.5) * f64::from(raster.width))
            .floor() as u64
            % u64::from(raster.width)) as u32;
        let row = ((((latitude / std::f64::consts::PI) + 0.5) * f64::from(raster.height))
            .floor()
            .clamp(0.0, f64::from(raster.height - 1))) as u32;
        (column, row)
    } else {
        let CameraModel::Pinhole {
            focal_x,
            focal_y,
            center_x,
            center_y,
            distortion_model,
            ..
        } = model
        else {
            return None;
        };
        if distortion_model.is_some() {
            return None;
        }
        let origin = camera_from_world.transform_point3(dvec3(cursor_ray.origin));
        let direction = camera_from_world.transform_vector3(dvec3(cursor_ray.direction));
        if !origin.is_finite() || !direction.is_finite() || direction.z.abs() <= 1.0e-12 {
            return None;
        }
        let distance = (request.plane_extent - origin.z) / direction.z;
        if !distance.is_finite() {
            return None;
        }
        let presentation = origin + direction * distance;
        let column = (presentation.x / presentation.z * focal_x + center_x).round();
        let row = (presentation.y / presentation.z * focal_y + center_y).round();
        if column < 0.0
            || row < 0.0
            || column >= f64::from(raster.width)
            || row >= f64::from(raster.height)
        {
            return None;
        }
        (column as u32, row as u32)
    };
    viewer
        .measure_raster_depth_sample(&request.entity_id, column, row)
        .ok()
}

#[cfg(target_arch = "wasm32")]
fn refine_streamed_pick(
    viewer: &WasmViewer,
    request: PickRefinementRequest<'_>,
) -> Result<Option<Vec<PickCandidate>>, String> {
    if let Some(index) = viewer
        .mesh_pick_indices
        .get(&request.coarse.address.render_proxy_id)
    {
        let mut candidates = index.refine(request);
        if candidates.is_empty() {
            candidates.push(project_coarse_candidate(request));
        }
        return Ok(Some(candidates));
    }
    if let Some(points) = viewer
        .potree_proxy_streams
        .get(&request.coarse.address.render_proxy_id)
        .and_then(|stream_id| viewer.potree_requests.get(stream_id))
    {
        if points.layout.encoding.eq_ignore_ascii_case("BROTLI") {
            let decoded = points
                .decoded
                .as_ref()
                .ok_or_else(|| "resident BROTLI Potree decode is missing".to_owned())?;
            return Ok(Some(refine_decoded_potree_point_pick(request, decoded)));
        }
        return refine_potree_point_pick(
            request,
            &points.layout,
            &points.bytes,
            points.metadata.point_count,
        )
        .map(Some)
        .map_err(|error| error.to_string());
    }
    if let Some(index) = viewer
        .splat_proxy_streams
        .get(&request.coarse.address.render_proxy_id)
        .and_then(|stream_id| viewer.splat_pick_indices.get(stream_id))
    {
        let mut candidates = index.refine(request);
        if candidates.is_empty() {
            candidates.push(project_coarse_candidate(request));
        }
        return Ok(Some(candidates));
    }
    if let Some(index) = viewer
        .raster_proxy_streams
        .get(&request.coarse.address.render_proxy_id)
        .and_then(|stream_id| viewer.raster_pick_indices.get(stream_id))
    {
        let mut candidates = index.refine(request);
        if candidates.is_empty() {
            candidates.push(project_coarse_candidate(request));
        }
        return Ok(Some(candidates));
    }
    Ok(None)
}

#[cfg(target_arch = "wasm32")]
fn project_coarse_candidate(request: PickRefinementRequest<'_>) -> PickCandidate {
    let mut coarse = request.coarse.clone();
    coarse.world_position = request
        .presentation_transform
        .source(request.coarse.world_position);
    coarse
}

#[cfg(target_arch = "wasm32")]
fn resolve_block_pick_request(
    request: &WasmEntityRenderRequest,
    render_proxy_id: &str,
    entity_requests: &BTreeMap<String, WasmEntityRenderRequest>,
    definitions: &BTreeMap<String, BlockDefinition>,
    block_member_styles: &BTreeMap<String, (CanonicalResourceRef, RenderStyle)>,
    block_member_entity_versions: &BTreeMap<String, (EntityVersionRef, WasmEntityRenderRequest)>,
) -> Result<Option<WasmEntityRenderRequest>, String> {
    let mut members = Vec::new();
    collect_block_member_requests(
        request,
        entity_requests,
        definitions,
        block_member_styles,
        block_member_entity_versions,
        &mut Vec::new(),
        &mut members,
    )?;
    Ok(members.into_iter().find(|member| {
        render_proxy_id == member.proxy_id
            || render_proxy_id
                .strip_prefix(&member.proxy_id)
                .is_some_and(|suffix| suffix.starts_with('#'))
    }))
}

#[cfg(target_arch = "wasm32")]
fn collect_block_member_requests(
    request: &WasmEntityRenderRequest,
    entity_requests: &BTreeMap<String, WasmEntityRenderRequest>,
    definitions: &BTreeMap<String, BlockDefinition>,
    block_member_styles: &BTreeMap<String, (CanonicalResourceRef, RenderStyle)>,
    block_member_entity_versions: &BTreeMap<String, (EntityVersionRef, WasmEntityRenderRequest)>,
    stack: &mut Vec<String>,
    members: &mut Vec<WasmEntityRenderRequest>,
) -> Result<(), String> {
    let GeometryObject::Block { instance } = &request.geometry else {
        members.push(request.clone());
        return Ok(());
    };
    let definition = resolve_block_definition(instance, definitions)?;
    let definition_key =
        block_definition_key(&definition.definition_id, &definition.content_hash.0);
    if stack.contains(&definition_key) {
        return Err("cyclic block definition in pick resolver".to_owned());
    }
    stack.push(definition_key);
    let result = definition.members.iter().try_for_each(|member| {
        let request = block_member_request(
            request,
            instance,
            member,
            block_member_entity_versions,
            block_member_styles,
        )?;
        collect_block_member_requests(
            &request,
            entity_requests,
            definitions,
            block_member_styles,
            block_member_entity_versions,
            stack,
            members,
        )
    });
    stack.pop();
    result
}

#[cfg(target_arch = "wasm32")]
fn placeholder_proxy(
    request: &WasmEntityRenderRequest,
    id: RenderProxyId,
    origin: WorldVec3,
) -> RenderProxy {
    RenderProxy {
        id,
        entity_id: request.entity_id.clone(),
        kind: RenderProxyKind::Points,
        bounds: BoundingVolume::AxisAlignedBox {
            bounds: WorldAabb {
                min: origin,
                max: origin,
            },
        },
        dataset_id: None,
        tile_id: None,
        style: request.style.clone(),
        cost: ResourceCost::default(),
        visible: true,
        locked: false,
    }
}

#[cfg(target_arch = "wasm32")]
fn alignment_preview_render_request(
    preview_id: &str,
    proxy_id: String,
    partition_identity: &ObjectHash,
    mesh: TriangleMeshGeometry,
) -> WasmEntityRenderRequest {
    WasmEntityRenderRequest {
        entity_id: format!("alignment-preview:{preview_id}"),
        proxy_id,
        version_hash: Some(partition_identity.0.clone()),
        source_revision: None,
        attributes_ref: None,
        evaluated_mesh_resource_ref: None,
        geometry: GeometryObject::Surface3d {
            mesh: Box::new(mesh),
        },
        style: RenderStyle::default(),
        placement: None,
        locked_plan_elevation: None,
        chord_tolerance: default_chord_tolerance(),
        maximum_curve_segments: default_curve_segments(),
        line_width: default_line_width(),
        plane_extent: default_plane_extent(),
        fill_areas: false,
        exaggeration_datum: 0.0,
    }
}

#[cfg(target_arch = "wasm32")]
fn calibration_progress_json(
    progress: GpuCalibrationProgress,
    submitted: bool,
) -> serde_json::Value {
    serde_json::json!({
        "completedSamples": progress.completed_samples,
        "totalSamples": progress.total_samples,
        "inFlight": progress.in_flight,
        "submitted": submitted,
        "calibration": progress.calibration,
    })
}

#[cfg(target_arch = "wasm32")]
fn default_chord_tolerance() -> f64 {
    0.001
}

#[cfg(target_arch = "wasm32")]
fn default_curve_segments() -> u32 {
    65_536
}

#[cfg(target_arch = "wasm32")]
fn default_line_width() -> f32 {
    2.0
}

#[cfg(target_arch = "wasm32")]
fn default_annotation_text_height() -> f64 {
    14.0
}

#[cfg(target_arch = "wasm32")]
fn default_annotation_decimals() -> u8 {
    3
}

#[cfg(target_arch = "wasm32")]
fn default_plane_extent() -> f64 {
    10.0
}

#[cfg(target_arch = "wasm32")]
fn default_maximum_sse() -> f64 {
    16.0
}

#[cfg(target_arch = "wasm32")]
fn default_detail_scale() -> f64 {
    1.0
}

#[cfg(target_arch = "wasm32")]
fn default_traversed_nodes() -> usize {
    100_000
}

#[cfg(target_arch = "wasm32")]
fn parse_streaming_completion(
    ticket_json: &str,
    retained_cost_json: &str,
) -> Result<(ResidencyTicket, ResourceCost), JsValue> {
    Ok((
        serde_json::from_str(ticket_json).map_err(js_error)?,
        serde_json::from_str(retained_cost_json).map_err(js_error)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        split_streamed_raster_bands, validate_decoded_potree_cardinality,
        validate_decoded_raster_cardinality, validate_decoded_splat_cardinality,
        WasmFrameTelemetryObservation,
    };

    #[test]
    fn host_frame_observation_rejects_a_second_gpu_timing_authority() {
        let error = serde_json::from_str::<WasmFrameTelemetryObservation>(
            r#"{"cpuMs":4.0,"gpuMs":8.0,"interacting":false,"uploadedBytes":0}"#,
        )
        .expect_err("host GPU timing must not cross the WASM telemetry boundary");
        assert!(error.to_string().contains("unknown field `gpuMs`"));
        serde_json::from_str::<WasmFrameTelemetryObservation>(
            r#"{"cpuMs":4.0,"interacting":false,"uploadedBytes":0}"#,
        )
        .expect("CPU-only host observation remains valid");
    }

    #[test]
    fn decoded_worker_artifact_cardinality_must_match_bound_metadata() {
        assert!(validate_decoded_potree_cardinality(2, 2, 2, None).is_ok());
        assert!(validate_decoded_potree_cardinality(2, 2, 2, Some(2)).is_ok());
        assert!(validate_decoded_potree_cardinality(2, 1, 2, None).is_err());
        assert!(validate_decoded_potree_cardinality(2, 2, 1, None).is_err());
        assert!(validate_decoded_potree_cardinality(2, 2, 2, Some(1)).is_err());

        assert!(validate_decoded_splat_cardinality(2, 2, 2).is_ok());
        assert!(validate_decoded_splat_cardinality(1, 2, 2).is_err());
        assert!(validate_decoded_splat_cardinality(2, 2, 1).is_err());

        assert!(validate_decoded_raster_cardinality(2, 3, 4, 5, 2, 3, 4, 5, 80, 6).is_ok());
        assert!(validate_decoded_raster_cardinality(2, 3, 4, 5, 3, 2, 4, 5, 80, 6).is_err());
        assert!(validate_decoded_raster_cardinality(2, 3, 4, 5, 2, 3, 5, 4, 80, 6).is_err());
        assert!(validate_decoded_raster_cardinality(2, 3, 4, 5, 2, 3, 4, 5, 79, 6).is_err());
        assert!(validate_decoded_raster_cardinality(2, 3, 4, 5, 2, 3, 4, 5, 80, 5).is_err());
    }

    #[test]
    fn streamed_raster_band_boundaries_are_exact_and_non_overlapping() {
        let packed = [1_u8, 2, 3, 4, 5, 6, 7, 8];
        let (elevation, validity, confidence, triangles) =
            split_streamed_raster_bands(&packed, 3, 1, 2, 2).expect("exact packed bands");
        assert_eq!(elevation, [1, 2, 3]);
        assert_eq!(validity, Some([4].as_slice()));
        assert_eq!(confidence, Some([5, 6].as_slice()));
        assert_eq!(triangles, Some([7, 8].as_slice()));
        assert!(split_streamed_raster_bands(&packed, 3, 1, 2, 1).is_err());
    }
}
