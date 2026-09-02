//! HimmelCAD sidecar: a long-running OS process that speaks JSON-RPC 2.0 over
//! stdio. Electron's main process spawns and supervises this binary.
//!
//! The sidecar holds the authoritative project state (entity store, command
//! journal, spatial indexes). The renderer mirrors snapshots and never mutates
//! state directly.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufReader as StdBufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use himmelcad_core::app_protocol::{
    AppProtocolError, AppProtocolRequest, AppProtocolRequestEnvelope, AppProtocolResponse,
    AppProtocolResponseEnvelope, APP_PROTOCOL_SCHEMA_ID,
};
use himmelcad_core::canonical_document::EntityVersionRef;
use himmelcad_core::canonical_resources::CanonicalResourceRef;
use himmelcad_core::entity::{EntityId, EntityKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab::{
    resolve_alignment_profile, AlignmentQualityProfile, ResolveAlignmentProfileRequest,
    ResolvedAlignmentConfig,
};
use himmelcad_core::photolab_capture::{evaluate_local_scale, LocalScaleConstraint};
use himmelcad_core::photolab_crs::FrozenImportTransformation;
use himmelcad_core::photolab_crs::{CrsDefinition, HeightReference};
use himmelcad_core::photolab_gcp::{
    GcpCoordinate, GcpCsvImportMapping, GcpObservation, GcpObservationState, ImageCoordinate,
};
use himmelcad_core::photolab_gcp_optimization::{
    propagate_gcp_through_tie_points, GcpCameraModel, GcpOptimizationPhase, GcpSimilarityTransform,
    GcpSolverOptions, GcpTiePointMeasurement, GcpTiePointTrack, OptimizedGcpCamera,
};
use himmelcad_core::photolab_images::ProjectedPhotoReference;
use himmelcad_core::photolab_jobs::{
    JobProgress, NewPhotolabJob, PhotolabJobId, PhotolabJobKind, PhotolabStage, PhotolabStageKind,
    ProgressMetrics,
};
use himmelcad_core::photolab_matching::ImageId;
use himmelcad_core::registration::{
    IcpMode, IcpOptions, RegistrationPointPair, RegistrationRecipe, RegistrationTargetSample,
};
use himmelcad_core::transform::{Similarity3D, WorldPoint};
use himmelcad_io::{
    canonical_builtin_import_registry, hcap_import::import_hcap_path_with_progress,
    import_gcp_csv_file, import_las_file_with_progress_and_cancel,
    import_photo_files_with_progress, preview_gcp_csv_file, CanonicalExportPlan,
    CanonicalExportRequest, CanonicalImportProvider, CanonicalImportRequest, CanonicalStagedImport,
    ConverterProgress, IfcCanonicalProvider, ImportProbeRequest, ImportProviderSelection,
    ProviderOperationContext, ProviderProgress, StagedArtifactRoots, IFC2X3_FORMAT_ID,
    IFC4X3_FORMAT_ID, IFC4_FORMAT_ID,
};

use crate::project_runtime::{
    AppendJournalParams, CancelArchiveParams, CancelImageMaskParams, ConfirmCaptureGroupParams,
    CreateAlignmentMergeParams, CreateCaptureGroupParams, CreateProcessingSetParams,
    CreateProjectParams, EditImageMaskParams, FinishJournalParams, MoveEntityParams,
    OpenProjectParams, ProductLineage, ProjectRuntime, PublishedRasterKind,
    RemoveCameraImagesParams, RenameEntityParams, SaveProjectAsParams, SetEntityVisibilityParams,
    UpdateCalibrationGroupIntrinsicsParams,
};
use himmelcad_sidecar::alignment_merge_runtime::{
    build_shared_control_merge, resume_shared_control_merge, resume_solved_merge,
    write_merge_checkpoint, AlignmentMergeCheckpoint, AlignmentMergeCheckpointState,
    SharedControlInput,
};
use himmelcad_sidecar::automation_runtime::{
    AutomationRuntime, BulkReadRequest, BulkReleaseRequest, CasDescribeRequest,
    CommandStatusRequest, CommandValidateRequest, EntityPageRequest,
};
use himmelcad_sidecar::brush_runtime::{
    BrushRunRequest, BrushRuntime, BrushTrainingSettings, DevBrushRuntimeConfig,
};
use himmelcad_sidecar::canonical_app_runtime::CanonicalAppRuntime;
use himmelcad_sidecar::canonical_project_store::{
    CanonicalImportProgress, CanonicalImportProgressPhase,
};
use himmelcad_sidecar::capture_runtime::{
    prepare_still_image, prepare_video_frames, probe_capture_capabilities, CaptureToolConfig,
    PrepareStillImageRequest, PrepareVideoFramesRequest,
};
#[cfg(test)]
use himmelcad_sidecar::colmap_runtime::ColmapCalibrationSeed;
use himmelcad_sidecar::colmap_runtime::{
    AlikedModelVariant, ColmapArtifactKind, ColmapCalibrationGroup, ColmapComputeDevice,
    ColmapIntrinsicsRefinement, ColmapPairSelection, ColmapProductRequest, ColmapResourceKind,
    ColmapRunOutcome, ColmapRunRequest, ColmapRuntime, DedodeV2GPolicy, DevColmapRuntimeConfig,
    LargeMatchingBackend, MappingFeatureStore,
};
use himmelcad_sidecar::dedode_runtime::{
    DedodeComputeDevice, DedodeImagePair, DedodeRunRequest, DedodeRuntime,
    DevDedodeOnnxRuntimeConfig, DevDedodeRuntimeConfig,
};
use himmelcad_sidecar::dense_raster_prep::{
    inspect_raster_wkt, inspect_vector_wkt, prepare_dense_potree, prepare_dense_vector,
    prepare_sparse_potree, DenseRasterPrepError,
};
use himmelcad_sidecar::gcp_local_estimate_runtime::{
    ComputeGcpLocalEstimateParams, ReadGcpLocalEstimateParams,
};
use himmelcad_sidecar::gcp_optimization_runtime::{
    run_gcp_optimization, GcpOptimizationRuntimeError, RunGcpOptimizationParams,
};
use himmelcad_sidecar::gcp_runtime::{
    CancelGcpOperationParams, CommitGcpsParams, CreateGcpOptimizationSnapshotParams,
    EditGcpObservationParams, UpsertGcpObservationParams, UpsertGcpObservationsParams,
};
use himmelcad_sidecar::hardware_runtime::probe_hardware;
use himmelcad_sidecar::image_commit::{CancelImageCommitParams, CommitImagesParams};
use himmelcad_sidecar::image_quality_runtime::{
    analyze_project_images, ImageQualityConfiguration, ImageQualityRuntimeError, ImageQualityScope,
    IMAGE_QUALITY_ALGORITHM_VERSION,
};
use himmelcad_sidecar::import_registration_runtime::ImportRegistrationRuntime;
use himmelcad_sidecar::job_runtime::{
    JobIdParams, JobManager, JobManagerConfig, JobWorkerContext, JobWorkerError, ListJobsParams,
};
use himmelcad_sidecar::mesh_tiler::{build_tiled_dem_mesh, MeshTilerError};
use himmelcad_sidecar::mvs_runtime::{
    DevMvsRuntimeConfig, MvsCapability, MvsComputeDevice, MvsRunRequest, MvsRuntime, MvsSettings,
};
use himmelcad_sidecar::mvs_scene::{
    load_gcp_bundle_tie_points, load_prepared_mvs_scene, prepare_gcp_cameras, prepare_mvs_scene,
    prepare_mvs_scene_with_masks_and_progress, PreparedMvsScene,
};
use himmelcad_sidecar::orthophoto_prep::{
    prepare_camera_orthophotos, CameraBlendMode, OrthophotoPreparation, OrthophotoPreparationError,
};
use himmelcad_sidecar::pointcloud_export::PointCloudExportFormat;
use himmelcad_sidecar::prepared_triangle_mesh::PreparedTriangleMeshOptions;
use himmelcad_sidecar::prepared_triangle_mesh_ply::{
    build_prepared_triangle_mesh_from_colmap_textured_directory,
    build_prepared_triangle_mesh_from_ply,
};
use himmelcad_sidecar::product_export::{export_product, ProductExportError, ProductExportRequest};
use himmelcad_sidecar::raster_runtime::{
    ElevationGeometrySource, ElevationInputTile, ElevationInterpolation, ElevationRasterRequest,
    ElevationSurface, ElevationViewRange, GdalToolchainConfig, MosaicOrder,
    OrthomosaicElevationSupport, OrthomosaicRequest, RasterBounds, RasterBuildCommand, RasterCrs,
    RasterGrid, RasterNoDataValue, RasterPhase, RasterProductRequest, RasterProgress,
    RasterResampling, RasterRuntime,
};
use himmelcad_sidecar::site_calibration_reader::inspect_site_calibration;
use himmelcad_sidecar::splat_tiler::{tile_brush_ply, SplatTilerError};
use himmelcad_sidecar::{
    crs_runtime::{ProjRuntime, ProjToolchainConfig},
    crs_service::{
        CancelCrsOperationParams, CrsService, DiscoverCrsOperationsParams, FreezeCrsOperationParams,
    },
};

mod project_runtime;

const PROGRESS_PREFIX: &str = "__HC_PROGRESS__";
// Smartphone antenna/camera lever-arm and frame/GNSS synchronization errors
// make sub-5 cm priors overconfident until device-specific calibration exists.
const MIN_FIXED_CAMERA_REFERENCE_HORIZONTAL_SIGMA_METERS: f64 = 0.05;
const MIN_FIXED_CAMERA_REFERENCE_HEIGHT_SIGMA_METERS: f64 = 0.10;
const MIN_NON_FIXED_CAMERA_REFERENCE_HORIZONTAL_SIGMA_METERS: f64 = 0.30;
const MIN_NON_FIXED_CAMERA_REFERENCE_HEIGHT_SIGMA_METERS: f64 = 0.60;

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // params is part of the JSON-RPC contract.
struct RpcRequest {
    jsonrpc: String,
    id: serde_json::Value,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct RpcResponse {
    jsonrpc: &'static str,
    id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: i32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenCanonicalProjectParams {
    project_root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppNegotiationParams {
    client_name: String,
    supported_versions: Vec<u32>,
    required_capabilities: Vec<String>,
    optional_capabilities: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageParams {
    #[serde(default)]
    cursor: Option<String>,
    limit: usize,
}

const IO_RPC_SCHEMA_VERSION: u32 = 1;
const IO_PROBE_PREFIX_BYTES: u64 = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IoProbeParams {
    source_path: String,
    #[serde(default)]
    media_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IoImportExecuteParams {
    operation_id: String,
    command_id: String,
    source_path: String,
    selection: ImportProviderSelection,
    options: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationStageParams {
    session_id: String,
    command_id: String,
    source_path: String,
    selection: ImportProviderSelection,
    options: serde_json::Value,
    recipe: RegistrationRecipe,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationSessionParams {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationResourceReadParams {
    session_id: String,
    capability: String,
    resource_id: String,
    offset: u64,
    byte_length: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationSourceSamplesParams {
    session_id: String,
    maximum_samples: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationProjectPointCloudSamplesParams {
    dataset_id: String,
    maximum_samples: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SiteCalibrationInspectParams {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationPointPairsParams {
    session_id: String,
    pairs: Vec<RegistrationPointPair>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationIcpParams {
    session_id: String,
    source: Vec<WorldPoint>,
    target: Vec<RegistrationTargetSample>,
    initial: Similarity3D,
    mode: IcpMode,
    options: IcpOptions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IoExportRequestParams {
    command_id: String,
    provider_id: String,
    provider_version: String,
    target_path: String,
    format_id: String,
    options: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IoExportPlanEnvelope {
    schema_version: u32,
    #[serde(flatten)]
    request: IoExportRequestParams,
    plan: CanonicalExportPlan,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IoExportExecuteParams {
    operation_id: String,
    accepted_plan: IoExportPlanEnvelope,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IoOperationParams {
    operation_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IoOperationStatus {
    schema_version: u32,
    operation_id: String,
    state: IoOperationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<ProviderProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum IoOperationState {
    Running,
    Completed,
    Cancelled,
    Failed,
}

struct IoOperationRecord {
    cancellation: Arc<AtomicBool>,
    status: IoOperationStatus,
}

#[derive(Default)]
struct IoOperations {
    records: Mutex<BTreeMap<String, IoOperationRecord>>,
}

impl IoOperations {
    fn begin(self: &Arc<Self>, operation_id: String) -> anyhow::Result<IoProviderContext> {
        validate_io_identity(&operation_id, "operationId")?;
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut records = self.records.lock().expect("I/O operation mutex poisoned");
        if records.contains_key(&operation_id) {
            anyhow::bail!("I/O operation identity was already used: {operation_id}");
        }
        records.insert(
            operation_id.clone(),
            IoOperationRecord {
                cancellation: cancellation.clone(),
                status: IoOperationStatus {
                    schema_version: IO_RPC_SCHEMA_VERSION,
                    operation_id: operation_id.clone(),
                    state: IoOperationState::Running,
                    progress: None,
                    message: None,
                },
            },
        );
        Ok(IoProviderContext {
            operation_id,
            cancellation,
            operations: Arc::clone(self),
        })
    }

    fn status(&self, operation_id: &str) -> Option<IoOperationStatus> {
        self.records
            .lock()
            .expect("I/O operation mutex poisoned")
            .get(operation_id)
            .map(|record| record.status.clone())
    }

    fn cancel(&self, operation_id: &str) -> bool {
        let records = self.records.lock().expect("I/O operation mutex poisoned");
        let Some(record) = records.get(operation_id) else {
            return false;
        };
        if record.status.state != IoOperationState::Running {
            return false;
        }
        record.cancellation.store(true, Ordering::Release);
        true
    }

    fn progress(&self, operation_id: &str, progress: ProviderProgress) {
        if let Some(record) = self
            .records
            .lock()
            .expect("I/O operation mutex poisoned")
            .get_mut(operation_id)
        {
            record.status.progress = Some(progress);
        }
    }

    fn finish(&self, operation_id: &str, result: &anyhow::Result<serde_json::Value>) {
        if let Some(record) = self
            .records
            .lock()
            .expect("I/O operation mutex poisoned")
            .get_mut(operation_id)
        {
            let cancelled = record.cancellation.load(Ordering::Acquire);
            record.status.state = if result.is_ok() {
                IoOperationState::Completed
            } else if cancelled {
                IoOperationState::Cancelled
            } else {
                IoOperationState::Failed
            };
            record.status.message = result.as_ref().err().map(ToString::to_string);
        }
    }
}

struct IoProviderContext {
    operation_id: String,
    cancellation: Arc<AtomicBool>,
    operations: Arc<IoOperations>,
}

impl ProviderOperationContext for IoProviderContext {
    fn is_cancelled(&self) -> bool {
        self.cancellation.load(Ordering::Acquire)
    }

    fn report_progress(&mut self, progress: ProviderProgress) {
        self.operations.progress(&self.operation_id, progress);
    }
}

#[derive(Debug, Deserialize)]
struct ImportLasParams {
    paths: Vec<String>,
    #[serde(default)]
    cache_dir: Option<String>,
    #[serde(default)]
    progress_key: Option<String>,
    #[serde(default)]
    operation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CancelLasImportParams {
    operation_id: String,
}

#[derive(Debug, Deserialize)]
struct ImportIfcParams {
    path: String,
    #[serde(default)]
    cache_dir: Option<String>,
    #[serde(default = "default_ifc_namespace")]
    import_namespace: String,
}

fn default_ifc_namespace() -> String {
    "builder".to_owned()
}

#[derive(Default)]
struct LoggingProviderContext;

impl ProviderOperationContext for LoggingProviderContext {
    fn is_cancelled(&self) -> bool {
        false
    }

    fn report_progress(&mut self, progress: ProviderProgress) {
        tracing::info!(
            phase = progress.phase,
            completed = progress.completed,
            total = progress.total,
            message = progress.message,
            "canonical import progress"
        );
    }
}

struct RegistrationProviderContext {
    progress_key: String,
    last_fraction: f64,
}

impl RegistrationProviderContext {
    fn new(progress_key: String) -> Self {
        Self {
            progress_key,
            last_fraction: 0.0,
        }
    }
}

impl ProviderOperationContext for RegistrationProviderContext {
    fn is_cancelled(&self) -> bool {
        false
    }

    #[allow(clippy::cast_precision_loss)]
    fn report_progress(&mut self, progress: ProviderProgress) {
        let local_fraction = progress
            .total
            .filter(|total| *total > 0)
            .map_or(self.last_fraction, |total| {
                progress.completed as f64 / total as f64
            })
            .clamp(0.0, 1.0);
        self.last_fraction = self.last_fraction.max(local_fraction);
        emit_progress(
            Some(&self.progress_key),
            0.02 + self.last_fraction * 0.68,
            &format!("Preparing import · {}", progress.message),
        );
        tracing::info!(
            phase = %progress.phase,
            completed = progress.completed,
            total = ?progress.total,
            message = %progress.message,
            "canonical import progress"
        );
    }
}

#[derive(Default)]
struct LasImportOperations {
    active: Mutex<BTreeMap<String, Arc<AtomicBool>>>,
}

impl LasImportOperations {
    fn begin(self: &Arc<Self>, operation_id: String) -> anyhow::Result<ActiveLasImport> {
        anyhow::ensure!(!operation_id.trim().is_empty(), "operation_id is empty");
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut active = self.active.lock().expect("LAS import mutex poisoned");
        match active.entry(operation_id.clone()) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(cancellation.clone());
            }
            std::collections::btree_map::Entry::Occupied(_) => {
                anyhow::bail!("LAS import operation is already active: {operation_id}");
            }
        }
        Ok(ActiveLasImport {
            operation_id,
            cancellation,
            operations: Arc::clone(self),
        })
    }

    fn cancel(&self, operation_id: &str) -> bool {
        let active = self.active.lock().expect("LAS import mutex poisoned");
        let Some(cancellation) = active.get(operation_id) else {
            return false;
        };
        cancellation.store(true, Ordering::Release);
        true
    }
}

struct ActiveLasImport {
    operation_id: String,
    cancellation: Arc<AtomicBool>,
    operations: Arc<LasImportOperations>,
}

impl Drop for ActiveLasImport {
    fn drop(&mut self) {
        self.operations
            .active
            .lock()
            .expect("LAS import mutex poisoned")
            .remove(&self.operation_id);
    }
}

#[derive(Debug, Deserialize)]
struct InspectPhotolabImagesParams {
    paths: Vec<String>,
    #[serde(default)]
    operation_id: Option<String>,
    #[serde(default)]
    progress_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewGcpCsvParams {
    path: String,
    mapping: GcpCsvImportMapping,
    #[serde(default = "default_gcp_preview_rows")]
    maximum_preview_rows: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitGcpCsvParams {
    operation_id: String,
    path: String,
    mapping: GcpCsvImportMapping,
    transformation: FrozenImportTransformation,
    #[serde(default)]
    coordinates_already_in_project_crs: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentJobOverrides {
    #[serde(default)]
    max_image_edge: Option<u32>,
    #[serde(default)]
    keypoints_per_megapixel: Option<u32>,
    #[serde(default)]
    sequential_overlap: Option<u32>,
    #[serde(default)]
    feature_budget: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchAlignmentPreset {
    id: String,
    name: String,
    profile: AlignmentQualityProfile,
    #[serde(default)]
    overrides: AlignmentJobOverrides,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartAlignmentJobParams {
    operation_id: String,
    profile: AlignmentQualityProfile,
    #[serde(default)]
    camera_entity_ids: Vec<String>,
    #[serde(default)]
    processing_set_id: Option<EntityId>,
    #[serde(default)]
    overrides: AlignmentJobOverrides,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartImageQualityJobParams {
    operation_id: String,
    #[serde(default)]
    camera_entity_ids: Vec<String>,
    #[serde(default)]
    processing_set_id: Option<EntityId>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartAlignmentMergeJobParams {
    operation_id: String,
    merge_entity_id: EntityId,
    profile: AlignmentQualityProfile,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
enum ProductRunConfiguration {
    Depth {
        image_downscale: u32,
        filter: String,
        #[serde(default = "default_mvs_maximum_neighbors")]
        maximum_neighbors: u32,
        reuse_compatible_maps: bool,
    },
    Dense {
        #[serde(default = "default_dense_image_downscale")]
        image_downscale: u32,
        #[serde(default = "default_mvs_filter")]
        filter: String,
        #[serde(default = "default_mvs_maximum_neighbors")]
        maximum_neighbors: u32,
        minimum_views: u32,
        retain_confidence: bool,
        calculate_colors: bool,
    },
    Dem {
        surface: String,
        resolution_meters_per_pixel: f64,
        interpolate_nodata: bool,
        tile_size_pixels: u32,
    },
    Ortho {
        resolution_meters_per_pixel: f64,
        blend_mode: String,
        color_correction: bool,
        fill_holes: bool,
        tile_size_pixels: u32,
        #[serde(default)]
        source_dem_entity_id: Option<EntityId>,
        #[serde(default)]
        source_dem_version_sha256: Option<ObjectHash>,
    },
    Mesh {
        target_face_count: u64,
        interpolate_holes: bool,
        build_texture: bool,
        texture_size: u32,
        #[serde(default)]
        source_dem_entity_id: Option<EntityId>,
    },
    Splat {
        initialization: String,
        iterations: u32,
        spherical_harmonics_degree: u8,
        maximum_splats: u64,
        #[serde(default = "default_splat_maximum_resolution")]
        maximum_resolution: u32,
        retain_training_checkpoints: bool,
    },
}

const fn default_dense_image_downscale() -> u32 {
    2
}

fn default_mvs_filter() -> String {
    "moderate".into()
}

const fn default_mvs_maximum_neighbors() -> u32 {
    6
}

const fn default_splat_maximum_resolution() -> u32 {
    1_920
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartProductJobParams {
    operation_id: String,
    configuration: ProductRunConfiguration,
    #[serde(default)]
    processing_set_id: Option<EntityId>,
    #[serde(default)]
    source_alignment_entity_id: Option<EntityId>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartProductExportJobParams {
    operation_id: String,
    entity_id: EntityId,
    destination_path: String,
    #[serde(default)]
    format: Option<PointCloudExportFormat>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
enum BatchPipelineStep {
    Alignment {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preset: Option<BatchAlignmentPreset>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile: Option<AlignmentQualityProfile>,
    },
    Product {
        configuration: ProductRunConfiguration,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartBatchJobParams {
    operation_id: String,
    steps: Vec<BatchPipelineStep>,
    #[serde(default)]
    camera_entity_ids: Vec<String>,
    #[serde(default)]
    processing_set_id: Option<EntityId>,
}

/// Immutable execution evidence created before a batch enters the job queue.
/// Recipe files remain symbolic; only this concrete plan contains project revisions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenBatchExecutionPlan {
    schema_version: u32,
    run_id: String,
    project_id: String,
    recipe_sha256: ObjectHash,
    input_sha256: ObjectHash,
    plan_sha256: ObjectHash,
    node_config_sha256: Vec<ObjectHash>,
    frozen_entities: Vec<FrozenBatchEntity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    processing_set_membership_sha256: Option<ObjectHash>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    external_artifacts: Vec<FrozenBatchExternalArtifact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenBatchEntity {
    entity_id: EntityId,
    /// PhotoLab's immutable entity revision is addressed by this CAS hash.
    entity_revision_sha256: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenBatchExternalArtifact {
    entity_id: EntityId,
    entity_revision_sha256: ObjectHash,
    content_sha256: ObjectHash,
    provider_id: String,
    provider_version: String,
    config_sha256: ObjectHash,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartGcpOptimizationJobParams {
    operation_id: String,
    snapshot_sha256: ObjectHash,
    #[serde(default)]
    processing_set_id: Option<EntityId>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlignedGcpCamerasParams {
    #[serde(default)]
    processing_set_id: Option<EntityId>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertAssistedGcpObservationParams {
    operation_id: String,
    expected_collection_sha256: ObjectHash,
    observation: GcpObservation,
    #[serde(default = "default_tie_point_distance")]
    maximum_seed_distance_pixels: f64,
}

const fn default_tie_point_distance() -> f64 {
    3.0
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignedGcpCameraRecord {
    image_id: u32,
    entity_id: String,
    image_name: String,
    source_object_hash: ObjectHash,
    /// True when COLMAP's model aligner already expressed the camera centre and
    /// rotation in the frozen project Easting/Northing/Height frame.
    center_in_project_world: bool,
    camera: GcpCameraModel,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaterializedCameraMapEntry {
    entity_id: String,
    image_name: PathBuf,
}

struct PreparedMvsProductJob {
    job: NewPhotolabJob,
    runtime: MvsRuntime,
    operation_id: String,
    project_root: PathBuf,
    alignment_dataset: PathBuf,
    scene_root: PathBuf,
    reusable_scene_manifest: Option<(PathBuf, ObjectHash)>,
    colmap_executable: PathBuf,
    coordinate_frame_id: String,
    settings: MvsSettings,
    fuse_dense_point_cloud: bool,
    reuse_compatible_maps: bool,
    project_transform: Option<GcpSimilarityTransform>,
    optimized_cameras: Option<Vec<OptimizedGcpCamera>>,
    camera_entity_ids: Vec<String>,
    image_mask_scope: himmelcad_core::photolab_masks::ImageMaskComputeScope,
    lineage: ProductLineage,
}

struct PreparedRasterProductJob {
    job: NewPhotolabJob,
    operation_id: String,
    configuration: ProductRunConfiguration,
    project_root: PathBuf,
    dense_ply: Option<PathBuf>,
    dem_dataset: Option<(PathBuf, crate::project_runtime::RasterArtifactRecord)>,
    alignment_dataset: Option<PathBuf>,
    colmap_executable: Option<PathBuf>,
    coordinate_frame_id: String,
    project_transform: Option<GcpSimilarityTransform>,
    optimized_cameras: Option<Vec<OptimizedGcpCamera>>,
    input_hash: ObjectHash,
    horizontal_srs: String,
    vertical_label: Option<String>,
    lineage: ProductLineage,
}

struct PreparedMeshJob {
    job: NewPhotolabJob,
    operation_id: String,
    project_root: PathBuf,
    dem_root: PathBuf,
    dem_summary: himmelcad_sidecar::raster_runtime::RasterBuildSummary,
    texture_dataset_root: Option<PathBuf>,
    texture_summary: Option<himmelcad_sidecar::raster_runtime::RasterBuildSummary>,
    textured: bool,
    target_face_count: u64,
    interpolate_holes: bool,
    texture_size: u32,
    lineage: ProductLineage,
}

const fn default_gcp_preview_rows() -> usize {
    100
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,parse_gps=warn,nom_exif=warn")
            }),
        )
        .with_writer(std::io::stderr)
        .init();

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        "himmelcad-sidecar starting"
    );

    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin).lines();
    let projects = Arc::new(ProjectRuntime::default());
    let jobs = Arc::new(JobManager::new_with_history(
        default_job_manager_config(),
        projects.clone(),
    )?);
    let crs = Arc::new(default_crs_service()?);
    let las_imports = Arc::new(LasImportOperations::default());
    let io_operations = Arc::new(IoOperations::default());
    let registrations = Arc::new(ImportRegistrationRuntime::default());
    let automation = Arc::new(AutomationRuntime::new()?);
    let canonical_app = Arc::new(Mutex::new(CanonicalAppRuntime::default()));
    let (response_tx, mut response_rx) = mpsc::channel::<RpcResponse>(256);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(response) = response_rx.recv().await {
            let json = serde_json::to_string(&response)?;
            stdout.write_all(json.as_bytes()).await?;
            stdout.write_all(b"\n").await?;
            stdout.flush().await?;
        }
        Ok::<(), anyhow::Error>(())
    });

    while let Some(line) = reader.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let projects = Arc::clone(&projects);
        let jobs = Arc::clone(&jobs);
        let crs = Arc::clone(&crs);
        let las_imports = Arc::clone(&las_imports);
        let io_operations = Arc::clone(&io_operations);
        let registrations = Arc::clone(&registrations);
        let automation = Arc::clone(&automation);
        let canonical_app = Arc::clone(&canonical_app);
        let response_tx = response_tx.clone();
        let parsed = serde_json::from_str::<RpcRequest>(&line);
        tokio::spawn(async move {
            let response = match parsed {
                Ok(req) => {
                    handle(
                        req,
                        projects,
                        jobs,
                        crs,
                        las_imports,
                        io_operations,
                        registrations,
                        automation,
                        canonical_app,
                    )
                    .await
                }
                Err(err) => RpcResponse {
                    jsonrpc: "2.0",
                    id: serde_json::Value::Null,
                    result: None,
                    error: Some(RpcError {
                        code: -32700,
                        message: format!("parse error: {err}"),
                        data: None,
                    }),
                },
            };
            if response_tx.send(response).await.is_err() {
                tracing::warn!("RPC response writer closed before request completed");
            }
        });
    }
    drop(response_tx);
    writer.await??;

    if let Err(error) = projects.close() {
        tracing::error!(%error, "failed to close project cleanly during sidecar shutdown");
    }
    canonical_app
        .lock()
        .expect("canonical app runtime mutex poisoned")
        .close();

    Ok(())
}

#[allow(clippy::too_many_arguments)] // JSON-RPC routing dependencies are explicit application services.
async fn handle(
    req: RpcRequest,
    projects: Arc<ProjectRuntime>,
    jobs: Arc<JobManager>,
    crs: Arc<CrsService>,
    las_imports: Arc<LasImportOperations>,
    io_operations: Arc<IoOperations>,
    registrations: Arc<ImportRegistrationRuntime>,
    automation: Arc<AutomationRuntime>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
) -> RpcResponse {
    if req.jsonrpc != "2.0" {
        return rpc_err(req.id, -32600, "invalid jsonrpc version");
    }
    if req.method.starts_with("photolab.project.") {
        return handle_project_rpc(req, projects, &jobs).await;
    }
    if req.method.starts_with("photolab.jobs.") {
        return handle_job_rpc(req, &jobs, projects, &crs).await;
    }
    if req.method.starts_with("photolab.crs.") {
        return handle_crs_rpc(req, &crs).await;
    }
    if req.method.starts_with("photolab.images.") {
        return handle_image_rpc(req, projects, &crs).await;
    }
    if req.method.starts_with("photolab.himmelcap.") {
        return handle_himmelcap_rpc(req, Arc::clone(&projects)).await;
    }
    if req.method.starts_with("photolab.capture.") {
        return handle_capture_rpc(req, projects).await;
    }
    if req.method.starts_with("photolab.gcp.") {
        return handle_gcp_rpc(req, projects, &crs).await;
    }
    if req.method.starts_with("photolab.products.") {
        return handle_product_rpc(req, projects).await;
    }
    if req.method.starts_with("registration.") {
        return handle_registration_rpc(req, registrations, canonical_app).await;
    }
    if req.method.starts_with("io.") {
        return handle_io_rpc(req, io_operations, canonical_app).await;
    }
    if req.method.starts_with("automation.") {
        return handle_automation_rpc(req, automation, canonical_app);
    }
    if req.method == "app.negotiate"
        || req.method == "app.protocol"
        || req.method.starts_with("canonical.project.")
        || req.method.starts_with("canonical.residency.")
    {
        return handle_canonical_app_rpc(req, &canonical_app, &automation);
    }

    match req.method.as_str() {
        "ping" => RpcResponse {
            jsonrpc: "2.0",
            id: req.id,
            result: Some(serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") })),
            error: None,
        },
        "import.las" => match serde_json::from_value::<ImportLasParams>(req.params.clone()) {
            Ok(params) => match handle_import_las(params, las_imports, canonical_app).await {
                Ok(value) => RpcResponse {
                    jsonrpc: "2.0",
                    id: req.id,
                    result: Some(value),
                    error: None,
                },
                Err(e) => rpc_err(req.id, -32000, &format!("import.las failed: {e}")),
            },
            Err(e) => rpc_err(req.id, -32602, &format!("invalid params: {e}")),
        },
        "import.las.cancel" => {
            match serde_json::from_value::<CancelLasImportParams>(req.params.clone()) {
                Ok(params) => rpc_result(
                    req.id,
                    Ok::<_, anyhow::Error>(serde_json::json!({
                        "operationId": params.operation_id,
                        "cancellationRequested": las_imports.cancel(&params.operation_id),
                    })),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "import.ifc" => match serde_json::from_value::<ImportIfcParams>(req.params.clone()) {
            Ok(params) => {
                let canonical_app = Arc::clone(&canonical_app);
                rpc_blocking(req.id, move || {
                    let (staged, command_id) = handle_import_ifc(params)?;
                    canonical_app
                        .lock()
                        .expect("canonical app runtime mutex poisoned")
                        .publish_staged_import(&staged, &command_id)?;
                    Ok(staged.package)
                })
                .await
            }
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        "photolab.alignment.resolve" => {
            match serde_json::from_value::<ResolveAlignmentProfileRequest>(req.params.clone()) {
                Ok(params) => match resolve_alignment_profile(&params) {
                    Ok(config) => {
                        tracing::info!(
                            profile = ?config.profile,
                            config_hash = config.config_hash.as_str(),
                            image_count = config.image_count,
                            "photolab alignment profile resolved"
                        );
                        match serde_json::to_value(config) {
                            Ok(value) => RpcResponse {
                                jsonrpc: "2.0",
                                id: req.id,
                                result: Some(value),
                                error: None,
                            },
                            Err(error) => rpc_err(
                                req.id,
                                -32603,
                                &format!("failed to encode resolved alignment profile: {error}"),
                            ),
                        }
                    }
                    Err(error) => rpc_err(req.id, -32602, &error.to_string()),
                },
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.hardware.probe" => {
            rpc_blocking(req.id, || probe_hardware().map_err(anyhow::Error::from)).await
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectHimmelcapParams {
    path: String,
    operation_id: String,
    #[serde(default)]
    progress_key: Option<String>,
}

fn himmelcap_staging_path(operation_id: &str) -> PathBuf {
    let digest = hex::encode(Sha256::digest(operation_id.as_bytes()));
    std::env::temp_dir()
        .join("himmelcad-photolab")
        .join("himmelcap")
        .join(digest)
}

async fn handle_himmelcap_rpc(req: RpcRequest, projects: Arc<ProjectRuntime>) -> RpcResponse {
    match req.method.as_str() {
        "photolab.himmelcap.inspect" => {
            rpc_blocking_with_params::<InspectHimmelcapParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    anyhow::ensure!(
                        !params.operation_id.trim().is_empty(),
                        "operationId must not be empty"
                    );
                    let source = PathBuf::from(params.path);
                    let staging = himmelcap_staging_path(&params.operation_id);
                    let cancellation = projects.begin_image_inspection(&params.operation_id)?;
                    let result = import_hcap_path_with_progress(
                        &source,
                        &staging,
                        || cancellation.is_cancel_requested(),
                        |fraction, message| {
                            emit_progress(params.progress_key.as_deref(), fraction, message)
                        },
                    );
                    projects.finish_image_inspection(&params.operation_id);
                    if result.is_err() && staging.exists() {
                        if let Err(error) = std::fs::remove_dir_all(&staging) {
                            tracing::warn!(
                                %error,
                                path = %staging.display(),
                                "failed to clean rejected HimmelCAD Cap staging directory"
                            );
                        }
                    }
                    result.map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "photolab.himmelcap.cancel" => {
            rpc_blocking_with_params::<CancelImageCommitParams, _, _>(
                req.id,
                req.params,
                move |params| Ok(projects.cancel_image_inspection(params)),
            )
            .await
        }
        "photolab.himmelcap.release" => {
            rpc_blocking_with_params::<CancelImageCommitParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    anyhow::ensure!(
                        !params.operation_id.trim().is_empty(),
                        "operationId must not be empty"
                    );
                    let staging = himmelcap_staging_path(&params.operation_id);
                    let released = if staging.exists() {
                        std::fs::remove_dir_all(&staging).with_context(|| {
                            format!(
                                "failed to release HimmelCAD Cap staging directory {}",
                                staging.display()
                            )
                        })?;
                        true
                    } else {
                        false
                    };
                    Ok(serde_json::json!({
                        "operationId": params.operation_id,
                        "released": released,
                    }))
                },
            )
            .await
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

async fn handle_capture_rpc(req: RpcRequest, projects: Arc<ProjectRuntime>) -> RpcResponse {
    match req.method.as_str() {
        "photolab.capture.capabilities" => {
            rpc_blocking(req.id, move || {
                Ok::<_, anyhow::Error>(probe_capture_capabilities(
                    &CaptureToolConfig::from_environment(),
                ))
            })
            .await
        }
        "photolab.capture.scale.evaluate" => {
            rpc_blocking_with_params::<LocalScaleConstraint, _, _>(
                req.id,
                req.params,
                |constraint| Ok::<_, anyhow::Error>(evaluate_local_scale(&constraint)),
            )
            .await
        }
        "photolab.capture.video.prepare" => {
            let progress_key = req
                .params
                .get("progressKey")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            rpc_blocking_with_params::<PrepareVideoFramesRequest, _, _>(
                req.id,
                req.params,
                move |params| {
                    let operation_id = params.operation_id.clone();
                    let cancellation = projects.begin_image_inspection(&operation_id)?;
                    let capabilities =
                        probe_capture_capabilities(&CaptureToolConfig::from_environment());
                    let result = prepare_video_frames(
                        &params,
                        &capabilities,
                        || cancellation.is_cancel_requested(),
                        |fraction, message| {
                            emit_progress(progress_key.as_deref(), fraction, message);
                        },
                    );
                    projects.finish_image_inspection(&operation_id);
                    result.map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "photolab.capture.image.prepare" => {
            let progress_key = req
                .params
                .get("progressKey")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            rpc_blocking_with_params::<PrepareStillImageRequest, _, _>(
                req.id,
                req.params,
                move |params| {
                    let operation_id = params.operation_id.clone();
                    let cancellation = projects.begin_image_inspection(&operation_id)?;
                    let capabilities =
                        probe_capture_capabilities(&CaptureToolConfig::from_environment());
                    let result = prepare_still_image(
                        &params,
                        &capabilities,
                        || cancellation.is_cancel_requested(),
                        |fraction, message| {
                            emit_progress(progress_key.as_deref(), fraction, message);
                        },
                    );
                    projects.finish_image_inspection(&operation_id);
                    result.map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "photolab.capture.cancel" => {
            rpc_blocking_with_params::<CancelImageCommitParams, _, _>(
                req.id,
                req.params,
                move |params| Ok(projects.cancel_image_inspection(params)),
            )
            .await
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

fn handle_canonical_app_rpc(
    req: RpcRequest,
    runtime: &Mutex<CanonicalAppRuntime>,
    automation: &AutomationRuntime,
) -> RpcResponse {
    if req.method == "app.negotiate" {
        return handle_app_negotiation(req);
    }
    if req.method == "io.formats.page" {
        return handle_io_formats_page(req);
    }
    let mut runtime = runtime
        .lock()
        .expect("canonical app runtime mutex poisoned");
    match req.method.as_str() {
        "canonical.project.open" => {
            match serde_json::from_value::<OpenCanonicalProjectParams>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    runtime
                        .open(params.project_root)
                        .map_err(anyhow::Error::from),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "canonical.project.close" => {
            let closed = runtime.close();
            automation.revoke_all();
            rpc_result(
                req.id,
                Ok::<_, anyhow::Error>(serde_json::json!({ "closed": closed })),
            )
        }
        "canonical.residency.bootstrap" => rpc_result(
            req.id,
            runtime.residency_bootstrap().map_err(anyhow::Error::from),
        ),
        "app.protocol" => match serde_json::from_value::<AppProtocolRequestEnvelope>(req.params) {
            Ok(envelope) => {
                if let AppProtocolRequest::ExecuteCanonicalTransaction(transaction) =
                    &envelope.request
                {
                    if let Some(extension) =
                        envelope.extensions.get("hcad.automation.confirmation@1")
                    {
                        let grant = extension
                            .as_object()
                            .filter(|object| object.len() == 1)
                            .and_then(|object| object.get("grant"))
                            .and_then(serde_json::Value::as_str);
                        let generation = runtime
                            .automation_entities()
                            .map(|(generation, _)| generation);
                        let authorization = match (grant, generation) {
                            (Some(grant), Ok(generation)) => automation
                                .authorize_confirmation_grant(transaction, grant, generation)
                                .map_err(|error| error.to_string()),
                            (None, _) => {
                                Err("confirmationRequired: approval extension is malformed"
                                    .to_owned())
                            }
                            (_, Err(error)) => Err(error.to_string()),
                        };
                        if let Err(message) = authorization {
                            let response = AppProtocolResponseEnvelope {
                                schema_id: APP_PROTOCOL_SCHEMA_ID.to_owned(),
                                request_id: envelope.request_id,
                                response: AppProtocolResponse::Error(AppProtocolError {
                                    code: "confirmationRequired".to_owned(),
                                    message,
                                    details: BTreeMap::new(),
                                }),
                                extensions: envelope.extensions,
                            };
                            return rpc_result(
                                req.id,
                                serde_json::to_value(response).map_err(anyhow::Error::from),
                            );
                        }
                    }
                }
                rpc_result(
                    req.id,
                    serde_json::to_value(runtime.dispatch(envelope)).map_err(anyhow::Error::from),
                )
            }
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        _ => rpc_err(req.id, -32601, "canonical application method not found"),
    }
}

fn handle_app_negotiation(req: RpcRequest) -> RpcResponse {
    let params = match serde_json::from_value::<AppNegotiationParams>(req.params) {
        Ok(params) => params,
        Err(error) => return rpc_err(req.id, -32602, &format!("invalid params: {error}")),
    };
    const CAPABILITIES: &[&str] = &[
        "document.read",
        "document.write",
        "journal.read",
        "io.formats.read",
        "io.probe",
        "io.import.execute",
        "io.export",
        "io.operation",
        "registration.import",
        "residency.read",
        "automation.entities.page",
        "automation.cas.describe",
        "automation.commands.validate",
        "automation.commands.status",
        "automation.commands.cancel",
        "automation.bulk.read",
        "automation.bulk.release",
    ];
    let invalid = params.client_name.trim().is_empty()
        || params.supported_versions.is_empty()
        || params.supported_versions.contains(&0)
        || params
            .required_capabilities
            .iter()
            .chain(params.optional_capabilities.iter())
            .any(|capability| capability.trim().is_empty());
    let required_unique = params
        .required_capabilities
        .iter()
        .collect::<BTreeSet<_>>()
        .len()
        == params.required_capabilities.len();
    let optional_unique = params
        .optional_capabilities
        .iter()
        .collect::<BTreeSet<_>>()
        .len()
        == params.optional_capabilities.len();
    if invalid || !required_unique || !optional_unique {
        return rpc_err(req.id, -32602, "negotiation request is invalid");
    }
    let missing = params
        .required_capabilities
        .iter()
        .filter(|required| !CAPABILITIES.contains(&required.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !params.supported_versions.contains(&1) || !missing.is_empty() {
        return rpc_err(
            req.id,
            -32602,
            &format!(
                "the sidecar cannot satisfy the required app protocol; missing capabilities: {}",
                missing.join(", ")
            ),
        );
    }
    rpc_result(
        req.id,
        Ok::<_, anyhow::Error>(serde_json::json!({
            "selectedVersion": 1,
            "serverName": "himmelcad-sidecar",
            "serverVersion": env!("CARGO_PKG_VERSION"),
            "sessionId": format!("sidecar-{}", std::process::id()),
            "capabilities": CAPABILITIES,
        })),
    )
}

fn handle_automation_rpc(
    req: RpcRequest,
    automation: Arc<AutomationRuntime>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
) -> RpcResponse {
    let id = req.id;
    let result = match req.method.as_str() {
        "automation.entities.page" => serde_json::from_value::<EntityPageRequest>(req.params)
            .map_err(|error| format!("invalidRequest: {error}"))
            .and_then(|params| {
                let app = canonical_app
                    .lock()
                    .map_err(|_| "internal: canonical application runtime poisoned".to_owned())?;
                automation
                    .entities_page(params, &app)
                    .map_err(|error| error.to_string())
            })
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "automation.cas.describe" => serde_json::from_value::<CasDescribeRequest>(req.params)
            .map_err(|error| format!("invalidRequest: {error}"))
            .and_then(|params| {
                let app = canonical_app
                    .lock()
                    .map_err(|_| "internal: canonical application runtime poisoned".to_owned())?;
                automation
                    .describe_cas(params, &app)
                    .map_err(|error| error.to_string())
            })
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "automation.commands.validate" => {
            serde_json::from_value::<CommandValidateRequest>(req.params)
                .map_err(|error| format!("invalidRequest: {error}"))
                .and_then(|params| {
                    let app = canonical_app.lock().map_err(|_| {
                        "internal: canonical application runtime poisoned".to_owned()
                    })?;
                    automation
                        .validate_command(params, &app)
                        .map_err(|error| error.to_string())
                })
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
        }
        "automation.commands.status" => serde_json::from_value::<CommandStatusRequest>(req.params)
            .map_err(|error| format!("invalidRequest: {error}"))
            .and_then(|params| {
                automation
                    .command_status(&params)
                    .map_err(|error| error.to_string())
            })
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "automation.commands.cancel" => serde_json::from_value::<CommandStatusRequest>(req.params)
            .map_err(|error| format!("invalidRequest: {error}"))
            .and_then(|params| {
                automation
                    .cancel_command(&params)
                    .map_err(|error| error.to_string())
            })
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "automation.bulk.read" => serde_json::from_value::<BulkReadRequest>(req.params)
            .map_err(|error| format!("invalidRequest: {error}"))
            .and_then(|params| {
                automation
                    .bulk_read(params)
                    .map_err(|error| error.to_string())
            })
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "automation.bulk.release" => serde_json::from_value::<BulkReleaseRequest>(req.params)
            .map_err(|error| format!("invalidRequest: {error}"))
            .and_then(|params| {
                automation
                    .bulk_release(params)
                    .map_err(|error| error.to_string())
            })
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        _ => Err("automation method not found".to_owned()),
    };
    match result {
        Ok(value) => RpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(value),
            error: None,
        },
        Err(message) => rpc_automation_err(id, &message),
    }
}

fn handle_io_formats_page(req: RpcRequest) -> RpcResponse {
    let params = match serde_json::from_value::<PageParams>(req.params) {
        Ok(params) if (1..=1_000).contains(&params.limit) => params,
        Ok(_) => return rpc_err(req.id, -32602, "page limit must be from 1 through 1000"),
        Err(error) => return rpc_err(req.id, -32602, &format!("invalid params: {error}")),
    };
    let start = match params.cursor.as_deref() {
        None => 0,
        Some(cursor) => match cursor.parse::<usize>() {
            Ok(cursor) => cursor,
            Err(_) => return rpc_err(req.id, -32602, "page cursor is invalid"),
        },
    };
    let registry = match canonical_builtin_import_registry(
        std::env::temp_dir().join("himmelcad-provider-discovery"),
    ) {
        Ok(registry) => registry,
        Err(error) => return rpc_err(req.id, -32603, &error.to_string()),
    };
    let items = registry.descriptors();
    if start > items.len() {
        return rpc_err(
            req.id,
            -32602,
            "page cursor is beyond the provider catalogue",
        );
    }
    let end = start.saturating_add(params.limit).min(items.len());
    // Omit nextCursor when exhausted — JSON null breaks TS clients that only
    // treat `undefined` as end-of-page (`null.length` throws).
    let mut page = serde_json::json!({
        "items": &items[start..end],
    });
    if end < items.len() {
        page["nextCursor"] = serde_json::Value::String(end.to_string());
    }
    rpc_result(req.id, Ok::<_, anyhow::Error>(page))
}

async fn handle_registration_rpc(
    req: RpcRequest,
    registrations: Arc<ImportRegistrationRuntime>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
) -> RpcResponse {
    match req.method.as_str() {
        "registration.import.stage" => {
            rpc_blocking_with_params::<RegistrationStageParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    validate_io_identity(&params.session_id, "sessionId")?;
                    validate_io_identity(&params.command_id, "commandId")?;
                    let progress_key = params.session_id.clone();
                    emit_progress(Some(&progress_key), 0.0, "Starting registered import");
                    let source = PathBuf::from(&params.source_path);
                    anyhow::ensure!(source.is_file(), "registration source is not a file");
                    let scratch_root = create_registration_scratch(&params.session_id)?;
                    let result = (|| {
                        let registry = canonical_builtin_import_registry(scratch_root.clone())?;
                        let mut context = RegistrationProviderContext::new(progress_key.clone());
                        let staged = registry.import(
                            &params.selection,
                            &source,
                            &params.options,
                            &mut context,
                        )?;
                        registrations
                            .begin(
                                params.session_id,
                                params.command_id,
                                params.recipe,
                                staged,
                                scratch_root.clone(),
                            )
                            .map_err(anyhow::Error::from)
                    })();
                    if result.is_err() {
                        let _ = std::fs::remove_dir_all(&scratch_root);
                    } else {
                        emit_progress(
                            Some(&progress_key),
                            0.70,
                            "Prepared import · ready for project commit",
                        );
                    }
                    result
                },
            )
            .await
        }
        "registration.session.state" => {
            rpc_blocking_with_params::<RegistrationSessionParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    registrations
                        .state(&params.session_id)
                        .map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "registration.resources.describe" => {
            rpc_blocking_with_params::<RegistrationSessionParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    registrations
                        .describe_resources(&params.session_id)
                        .map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "registration.resource.read" => {
            rpc_blocking_with_params::<RegistrationResourceReadParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    registrations
                        .read_resource(
                            &params.session_id,
                            &params.capability,
                            &params.resource_id,
                            params.offset,
                            params.byte_length,
                        )
                        .map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "registration.samples.source" => {
            rpc_blocking_with_params::<RegistrationSourceSamplesParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    registrations
                        .source_samples(&params.session_id, params.maximum_samples)
                        .map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "registration.samples.projectPointCloud" => {
            rpc_blocking_with_params::<RegistrationProjectPointCloudSamplesParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    validate_io_identity(&params.dataset_id, "datasetId")?;
                    canonical_app
                        .lock()
                        .expect("canonical app runtime mutex poisoned")
                        .registration_point_cloud_samples(
                            &params.dataset_id,
                            params.maximum_samples,
                        )
                        .map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "registration.preview.pointPairs" => {
            rpc_blocking_with_params::<RegistrationPointPairsParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    registrations
                        .preview_point_pairs(&params.session_id, &params.pairs)
                        .map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "registration.preview.icp" => {
            rpc_blocking_with_params::<RegistrationIcpParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    registrations
                        .preview_icp(
                            &params.session_id,
                            &params.source,
                            &params.target,
                            params.initial,
                            params.mode,
                            params.options,
                            |completed, total, overlap| {
                                emit_progress(
                                    Some(&params.session_id),
                                    completed as f64 / f64::from(total.max(1)),
                                    &format!(
                                        "Registration ICP {completed}/{total} · {:.1}% overlap",
                                        overlap * 100.0
                                    ),
                                );
                            },
                        )
                        .map_err(anyhow::Error::from)
                },
            )
            .await
        }
        "registration.import.commit" => {
            rpc_blocking_with_params::<RegistrationSessionParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    let progress_key = params.session_id.clone();
                    emit_progress(
                        Some(&progress_key),
                        0.70,
                        "Committing import to the project",
                    );
                    let (staged, command_id, _scratch_root) =
                        registrations.take_ready(&params.session_id)?;
                    let mut last_phase = None;
                    let mut last_completed = 0_u64;
                    let result = canonical_app
                        .lock()
                        .expect("canonical app runtime mutex poisoned")
                        .publish_staged_import_with_progress(
                            &staged,
                            &command_id,
                            &mut |progress| {
                                let threshold =
                                    (progress.total_bytes / 1_000).max(16 * 1024 * 1024);
                                let phase_changed = last_phase != Some(progress.phase);
                                let finished = progress.completed_bytes >= progress.total_bytes;
                                if phase_changed
                                    || finished
                                    || progress.completed_bytes.saturating_sub(last_completed)
                                        >= threshold
                                {
                                    last_phase = Some(progress.phase);
                                    last_completed = progress.completed_bytes;
                                    emit_canonical_import_progress(&progress_key, progress);
                                }
                            },
                        )
                        .map_err(anyhow::Error::from);
                    registrations.finish_commit(&params.session_id, result.is_ok());
                    if result.is_ok() {
                        emit_progress(
                            Some(&progress_key),
                            1.0,
                            "Import committed and ready to load",
                        );
                    }
                    result
                },
            )
            .await
        }
        "registration.session.cancel" => {
            match serde_json::from_value::<RegistrationSessionParams>(req.params) {
                Ok(params) => rpc_result(
                    req.id,
                    Ok::<_, anyhow::Error>(serde_json::json!({
                        "schemaVersion": 1,
                        "sessionId": params.session_id,
                        "cancellationRequested": registrations.cancel(&params.session_id),
                    })),
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "registration.siteCalibration.inspect" => {
            rpc_blocking_with_params::<SiteCalibrationInspectParams, _, _>(
                req.id,
                req.params,
                |params| {
                    inspect_site_calibration(Path::new(&params.path)).map_err(anyhow::Error::from)
                },
            )
            .await
        }
        _ => rpc_err(req.id, -32601, "registration method not found"),
    }
}

fn create_registration_scratch(session_id: &str) -> anyhow::Result<PathBuf> {
    validate_io_identity(session_id, "sessionId")?;
    let digest = hex::encode(Sha256::digest(session_id.as_bytes()));
    let parent = std::env::temp_dir().join("himmelcad-registration-sessions");
    std::fs::create_dir_all(&parent)?;
    let root = parent.join(format!("{}-{digest}", std::process::id()));
    std::fs::create_dir(&root).with_context(|| {
        format!(
            "registration scratch already exists or cannot be created: {}",
            root.display()
        )
    })?;
    Ok(root)
}

async fn handle_io_rpc(
    req: RpcRequest,
    operations: Arc<IoOperations>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
) -> RpcResponse {
    match req.method.as_str() {
        "io.formats.page" => handle_io_formats_page(req),
        "io.probe" => {
            rpc_blocking_with_params::<IoProbeParams, _, _>(req.id, req.params, |params| {
                let source = PathBuf::from(params.source_path);
                anyhow::ensure!(source.is_file(), "I/O probe source is not a file");
                let mut prefix = Vec::new();
                std::fs::File::open(&source)?
                    .take(IO_PROBE_PREFIX_BYTES)
                    .read_to_end(&mut prefix)?;
                let registry = canonical_builtin_import_registry(io_probe_registry_root())?;
                registry
                    .select_importer(ImportProbeRequest {
                        path: &source,
                        prefix: &prefix,
                        media_type: params.media_type.as_deref(),
                    })
                    .map_err(anyhow::Error::from)
            })
            .await
        }
        "io.import.execute" => {
            let params = match serde_json::from_value::<IoImportExecuteParams>(req.params) {
                Ok(params) => params,
                Err(error) => {
                    return rpc_err(req.id, -32602, &format!("invalid params: {error}"));
                }
            };
            let operation_id = params.operation_id.clone();
            let result = tokio::task::spawn_blocking(move || {
                run_tracked_io(operations, operation_id, |context| {
                    validate_io_identity(&params.command_id, "commandId")?;
                    let source = PathBuf::from(&params.source_path);
                    anyhow::ensure!(source.is_file(), "I/O import source is not a file");
                    let scratch = IoScratch::create(&context.operation_id)?;
                    let registry = canonical_builtin_import_registry(scratch.root.clone())?;
                    let staged =
                        registry.import(&params.selection, &source, &params.options, context)?;
                    let commit = canonical_app
                        .lock()
                        .expect("canonical app runtime mutex poisoned")
                        .publish_staged_import(&staged, &params.command_id)?;
                    serde_json::to_value(commit).map_err(anyhow::Error::from)
                })
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(std::convert::identity);
            rpc_result(req.id, result)
        }
        "io.export.plan" => {
            rpc_blocking_with_params::<IoExportRequestParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    validate_io_identity(&params.command_id, "commandId")?;
                    let package = canonical_app
                        .lock()
                        .expect("canonical app runtime mutex poisoned")
                        .reconstruct_import_package(&params.command_id)?;
                    let registry = canonical_builtin_import_registry(io_probe_registry_root())?;
                    require_provider_version(
                        &registry,
                        &params.provider_id,
                        &params.provider_version,
                    )?;
                    let plan = registry.plan_export(
                        &params.provider_id,
                        CanonicalExportRequest {
                            target: Path::new(&params.target_path),
                            format_id: &params.format_id,
                            package: &package,
                            options: &params.options,
                        },
                    )?;
                    Ok(IoExportPlanEnvelope {
                        schema_version: IO_RPC_SCHEMA_VERSION,
                        request: params,
                        plan,
                    })
                },
            )
            .await
        }
        "io.export.execute" => {
            let params = match serde_json::from_value::<IoExportExecuteParams>(req.params) {
                Ok(params) => params,
                Err(error) => {
                    return rpc_err(req.id, -32602, &format!("invalid params: {error}"));
                }
            };
            if params.accepted_plan.schema_version != IO_RPC_SCHEMA_VERSION {
                return rpc_err(req.id, -32602, "unsupported I/O export-plan schema version");
            }
            let operation_id = params.operation_id.clone();
            let result = tokio::task::spawn_blocking(move || {
                run_tracked_io(operations, operation_id, |context| {
                    let accepted = params.accepted_plan;
                    validate_io_identity(&accepted.request.command_id, "commandId")?;
                    let scratch = IoScratch::create(&context.operation_id)?;
                    let package = {
                        let runtime = canonical_app
                            .lock()
                            .expect("canonical app runtime mutex poisoned");
                        let package =
                            runtime.reconstruct_import_package(&accepted.request.command_id)?;
                        runtime.materialize_import_artifacts(
                            &accepted.request.command_id,
                            &scratch.root,
                        )?;
                        package
                    };
                    let registry = canonical_builtin_import_registry(scratch.root.clone())?;
                    require_provider_version(
                        &registry,
                        &accepted.request.provider_id,
                        &accepted.request.provider_version,
                    )?;
                    registry.execute_export(
                        &accepted.request.provider_id,
                        CanonicalExportRequest {
                            target: Path::new(&accepted.request.target_path),
                            format_id: &accepted.request.format_id,
                            package: &package,
                            options: &accepted.request.options,
                        },
                        &accepted.plan,
                        context,
                    )?;
                    Ok(serde_json::json!({
                        "schemaVersion": IO_RPC_SCHEMA_VERSION,
                        "operationId": context.operation_id,
                        "outputs": accepted.plan.outputs,
                    }))
                })
            })
            .await
            .map_err(anyhow::Error::from)
            .and_then(std::convert::identity);
            rpc_result(req.id, result)
        }
        "io.operation.status" => match serde_json::from_value::<IoOperationParams>(req.params) {
            Ok(params) => match operations.status(&params.operation_id) {
                Some(status) => rpc_result(req.id, Ok::<_, anyhow::Error>(status)),
                None => rpc_err(req.id, -32000, "I/O operation is unknown"),
            },
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        "io.operation.cancel" => match serde_json::from_value::<IoOperationParams>(req.params) {
            Ok(params) => rpc_result(
                req.id,
                Ok::<_, anyhow::Error>(serde_json::json!({
                    "schemaVersion": IO_RPC_SCHEMA_VERSION,
                    "operationId": params.operation_id,
                    "cancellationRequested": operations.cancel(&params.operation_id),
                })),
            ),
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        other => rpc_err(req.id, -32601, &format!("I/O method not found: {other}")),
    }
}

fn run_tracked_io<F>(
    operations: Arc<IoOperations>,
    operation_id: String,
    operation: F,
) -> anyhow::Result<serde_json::Value>
where
    F: FnOnce(&mut IoProviderContext) -> anyhow::Result<serde_json::Value>,
{
    let mut context = operations.begin(operation_id.clone())?;
    let result = operation(&mut context);
    operations.finish(&operation_id, &result);
    result
}

fn validate_io_identity(value: &str, field: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !value.is_empty()
            && value.len() <= 160
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')),
        "{field} is not a bounded portable identity"
    );
    Ok(())
}

fn io_probe_registry_root() -> PathBuf {
    std::env::temp_dir().join("himmelcad-io-registry")
}

fn require_provider_version(
    registry: &himmelcad_io::FormatProviderRegistry,
    provider_id: &str,
    provider_version: &str,
) -> anyhow::Result<()> {
    let descriptor = registry
        .descriptors()
        .into_iter()
        .find(|descriptor| descriptor.provider_id == provider_id)
        .ok_or_else(|| anyhow::anyhow!("I/O provider is unavailable: {provider_id}"))?;
    anyhow::ensure!(
        descriptor.provider_version == provider_version,
        "I/O provider version changed: selected {provider_version}, available {}",
        descriptor.provider_version
    );
    Ok(())
}

struct IoScratch {
    root: PathBuf,
}

impl IoScratch {
    fn create(operation_id: &str) -> anyhow::Result<Self> {
        validate_io_identity(operation_id, "operationId")?;
        let digest = hex::encode(Sha256::digest(operation_id.as_bytes()));
        let parent = std::env::temp_dir().join("himmelcad-io-operations");
        std::fs::create_dir_all(&parent)?;
        let root = parent.join(format!("{}-{digest}", std::process::id()));
        std::fs::create_dir(&root).with_context(|| {
            format!(
                "I/O scratch root already exists or cannot be created: {}",
                root.display()
            )
        })?;
        Ok(Self { root })
    }
}

impl Drop for IoScratch {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.root) {
            tracing::warn!(path = %self.root.display(), %error, "failed to remove I/O scratch root");
        }
    }
}

async fn handle_product_rpc(req: RpcRequest, projects: Arc<ProjectRuntime>) -> RpcResponse {
    match req.method.as_str() {
        "photolab.products.list" => {
            rpc_blocking(req.id, move || projects.list_product_datasets()).await
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

async fn handle_image_rpc(
    req: RpcRequest,
    projects: Arc<ProjectRuntime>,
    crs: &CrsService,
) -> RpcResponse {
    match req.method.as_str() {
        "photolab.images.list" => rpc_blocking(req.id, move || projects.list_camera_images()).await,
        "photolab.images.quality.list" => {
            rpc_blocking(req.id, move || projects.list_image_quality_analyses()).await
        }
        "photolab.images.inspect" => {
            rpc_blocking_with_params::<InspectPhotolabImagesParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    if params.paths.is_empty() {
                        anyhow::bail!("at least one image or directory path is required");
                    }
                    let paths = params
                        .paths
                        .into_iter()
                        .map(PathBuf::from)
                        .collect::<Vec<_>>();
                    let operation_id = params.operation_id;
                    let cancellation = operation_id
                        .as_deref()
                        .map(|id| projects.begin_image_inspection(id))
                        .transpose()?;
                    let progress_key = params.progress_key;
                    let result = import_photo_files_with_progress(
                        &paths,
                        || {
                            cancellation
                                .as_ref()
                                .is_some_and(|token| token.is_cancel_requested())
                        },
                        |fraction, message| {
                            emit_progress(progress_key.as_deref(), fraction, message)
                        },
                    );
                    if let Some(operation_id) = operation_id.as_deref() {
                        projects.finish_image_inspection(operation_id);
                    }
                    result.context("image inspection cancelled")
                },
            )
            .await
        }
        "photolab.images.inspect.cancel" => {
            rpc_blocking_with_params::<CancelImageCommitParams, _, _>(
                req.id,
                req.params,
                move |params| Ok(projects.cancel_image_inspection(params)),
            )
            .await
        }
        "photolab.images.commit" => {
            let progress_key = req
                .params
                .get("progressKey")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            match serde_json::from_value::<CommitImagesParams>(req.params) {
                Ok(params) => match enrich_projected_references(params, crs).await {
                    Ok(params) => {
                        rpc_blocking(req.id, move || {
                            projects.commit_images_with_progress(params, |fraction, message| {
                                emit_progress(progress_key.as_deref(), fraction, message);
                            })
                        })
                        .await
                    }
                    Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                },
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.images.commit.cancel" => {
            rpc_blocking_with_params::<CancelImageCommitParams, _, _>(
                req.id,
                req.params,
                move |params| Ok(projects.cancel_image_commit(params)),
            )
            .await
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

async fn enrich_projected_references(
    mut params: CommitImagesParams,
    crs: &CrsService,
) -> anyhow::Result<CommitImagesParams> {
    use std::fmt::Write as _;

    if params.local_metric {
        anyhow::ensure!(
            params.transformation.is_none(),
            "localMetric cannot be combined with a CRS transformation"
        );
        for image in &mut params.images {
            image.projected_reference = None;
        }
        return Ok(params);
    }
    let transformation = params
        .transformation
        .clone()
        .context("CRS-backed image import requires a frozen transformation")?;

    let mut input = String::new();
    let mut indices = Vec::new();
    for (index, item) in params.images.iter().enumerate() {
        let Some(gps) = item.photo.metadata.preferred_gps_position() else {
            continue;
        };
        let height = gps.altitude.map_or(0.0, |value| value.meters);
        writeln!(
            input,
            "{:.15} {:.15} {:.6}",
            gps.latitude_degrees, gps.longitude_degrees, height
        )?;
        indices.push(index);
    }
    if indices.is_empty() {
        return Ok(params);
    }
    let operation_id = format!("{}.coordinates", params.operation_id);
    let output = crs
        .transform_text(&operation_id, &transformation, &input)
        .await?;
    let coordinates = parse_transformed_coordinates(
        &output,
        pipeline_ends_with_axis_swap(&transformation.pipeline.proj_pipeline),
    )?;
    if coordinates.len() != indices.len() {
        anyhow::bail!(
            "PROJ returned {} coordinates for {} image references",
            coordinates.len(),
            indices.len()
        );
    }
    for (index, [easting, northing, height]) in indices.into_iter().zip(coordinates) {
        let item = params
            .images
            .get_mut(index)
            .context("transformed image index is outside the commit batch")?;
        let gps = item
            .photo
            .metadata
            .preferred_gps_position()
            .context("transformed image lost its inspected GPS metadata")?;
        let source_height_meters = gps.altitude.map(|value| value.meters);
        item.projected_reference = Some(ProjectedPhotoReference {
            source_latitude_degrees: gps.latitude_degrees,
            source_longitude_degrees: gps.longitude_degrees,
            source_height_meters,
            easting,
            northing,
            transformed_height_meters: source_height_meters.map(|_| height),
            transformation_decision_sha256: transformation.decision_sha256.clone(),
        });
    }
    Ok(params)
}

fn parse_transformed_coordinates(
    output: &str,
    swap_output_axes: bool,
) -> anyhow::Result<Vec<[f64; 3]>> {
    let mut coordinates = Vec::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let values = line
            .split_ascii_whitespace()
            .take(3)
            .map(str::parse::<f64>)
            .collect::<Result<Vec<_>, _>>()?;
        let [easting, northing, height] = values.as_slice() else {
            anyhow::bail!("PROJ output line has fewer than three ordinates: {line}");
        };
        if !easting.is_finite() || !northing.is_finite() || !height.is_finite() {
            anyhow::bail!("PROJ output contains a non-finite coordinate");
        }
        coordinates.push(if swap_output_axes {
            [*northing, *easting, *height]
        } else {
            [*easting, *northing, *height]
        });
    }
    Ok(coordinates)
}

async fn handle_gcp_rpc(
    req: RpcRequest,
    projects: Arc<ProjectRuntime>,
    crs: &CrsService,
) -> RpcResponse {
    match req.method.as_str() {
        "photolab.gcp.preview" => {
            rpc_blocking_with_params::<PreviewGcpCsvParams, _, _>(req.id, req.params, |params| {
                preview_gcp_csv_file(
                    Path::new(&params.path),
                    &params.mapping,
                    params.maximum_preview_rows.clamp(1, 1_000),
                )
                .map_err(anyhow::Error::from)
            })
            .await
        }
        "photolab.gcp.commit" => match serde_json::from_value::<CommitGcpCsvParams>(req.params) {
            Ok(params) => match transform_gcp_import(params, crs).await {
                Ok(params) => rpc_blocking(req.id, move || projects.commit_gcps(params)).await,
                Err(error) => rpc_err(req.id, -32000, &error.to_string()),
            },
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        "photolab.gcp.list" => rpc_blocking(req.id, move || projects.list_gcps()).await,
        "photolab.gcp.observation.upsert" => {
            rpc_blocking_with_params::<UpsertGcpObservationParams, _, _>(
                req.id,
                req.params,
                move |params| projects.upsert_gcp_observation(params),
            )
            .await
        }
        "photolab.gcp.observation.edit" => {
            rpc_blocking_with_params::<EditGcpObservationParams, _, _>(
                req.id,
                req.params,
                move |params| projects.edit_gcp_observation(params),
            )
            .await
        }
        "photolab.gcp.observation.upsertAssisted" => {
            rpc_blocking_with_params::<UpsertAssistedGcpObservationParams, _, _>(
                req.id,
                req.params,
                move |params| upsert_assisted_gcp_observation(&projects, params),
            )
            .await
        }
        "photolab.gcp.localEstimate.compute" => {
            rpc_blocking_with_params::<ComputeGcpLocalEstimateParams, _, _>(
                req.id,
                req.params,
                move |params| projects.compute_gcp_local_estimate(params),
            )
            .await
        }
        "photolab.gcp.localEstimate.read" => {
            rpc_blocking_with_params::<ReadGcpLocalEstimateParams, _, _>(
                req.id,
                req.params,
                move |params| projects.read_gcp_local_estimate(params),
            )
            .await
        }
        "photolab.gcp.optimization.snapshot" => {
            rpc_blocking_with_params::<CreateGcpOptimizationSnapshotParams, _, _>(
                req.id,
                req.params,
                move |params| projects.create_gcp_optimization_snapshot(params),
            )
            .await
        }
        "photolab.gcp.optimization.latest" => {
            rpc_blocking_with_params::<AlignedGcpCamerasParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    latest_gcp_optimization_for_scope(&projects, params.processing_set_id.as_ref())
                },
            )
            .await
        }
        "photolab.gcp.optimization.list" => {
            rpc_blocking(req.id, move || projects.list_gcp_optimizations()).await
        }
        "photolab.gcp.alignedCameras" => {
            rpc_blocking_with_params::<AlignedGcpCamerasParams, _, _>(
                req.id,
                req.params,
                move |params| {
                    load_aligned_gcp_cameras(&projects, params.processing_set_id.as_ref())
                },
            )
            .await
        }
        "photolab.gcp.cancel" => {
            match serde_json::from_value::<CancelGcpOperationParams>(req.params) {
                Ok(params) => {
                    let coordinate_operation_id = format!("{}.coordinates", params.operation_id);
                    let crs_cancelled = crs
                        .cancel(CancelCrsOperationParams {
                            operation_id: coordinate_operation_id,
                        })
                        .await;
                    let project_cancelled = projects.cancel_gcp_operation(params);
                    rpc_result(
                        req.id,
                        Ok::<_, anyhow::Error>(serde_json::json!({
                            "operationId": project_cancelled.operation_id,
                            "cancellationRequested": project_cancelled.cancellation_requested
                                || crs_cancelled.cancellation_requested,
                        })),
                    )
                }
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

fn latest_gcp_optimization_for_scope(
    projects: &ProjectRuntime,
    processing_set_id: Option<&EntityId>,
) -> anyhow::Result<Option<crate::project_runtime::GcpOptimizationPublicationRecord>> {
    if processing_set_id.is_none() {
        return projects.latest_gcp_optimization();
    }
    let alignment = projects.latest_alignment_dataset_for_processing_set(processing_set_id)?;
    projects.latest_gcp_optimization_for_lineage(&ProductLineage {
        source_alignment_entity_id: alignment.source_alignment_entity_id,
        processing_set_id: alignment.processing_set_id,
        gcp_optimization_entity_id: None,
        gcp_optimization_snapshot_sha256: None,
        image_mask_scope_sha256: alignment.image_mask_scope_sha256,
    })
}

fn upsert_assisted_gcp_observation(
    projects: &ProjectRuntime,
    params: UpsertAssistedGcpObservationParams,
) -> anyhow::Result<himmelcad_sidecar::gcp_runtime::UpsertGcpObservationsResult> {
    anyhow::ensure!(
        matches!(params.observation.state, GcpObservationState::Manual { .. }),
        "assisted GCP seed must be a manual observation"
    );
    let Some((collection_hash, collection)) = projects.list_gcps()? else {
        anyhow::bail!("no GCP collection is available");
    };
    anyhow::ensure!(
        collection_hash == params.expected_collection_sha256,
        "GCP collection changed before assisted observation"
    );
    let track = load_nearest_tie_point_track(
        projects,
        &params.observation,
        params.maximum_seed_distance_pixels,
    )?;
    let propagation = propagate_gcp_through_tie_points(
        &params.observation,
        track.as_slice(),
        &collection.observations,
        params.maximum_seed_distance_pixels,
    )?;
    let mut observations = Vec::with_capacity(
        1 + propagation
            .as_ref()
            .map_or(0, |value| value.observations.len()),
    );
    observations.push(params.observation);
    if let Some(propagation) = propagation {
        observations.extend(propagation.observations);
    }
    projects.upsert_gcp_observations(UpsertGcpObservationsParams {
        operation_id: params.operation_id,
        expected_collection_sha256: params.expected_collection_sha256,
        observations,
        preserve_manual: true,
    })
}

fn load_nearest_tie_point_track(
    projects: &ProjectRuntime,
    manual: &GcpObservation,
    maximum_distance_pixels: f64,
) -> anyhow::Result<Option<GcpTiePointTrack>> {
    let context = projects.compute_context()?;
    let alignment = projects.latest_alignment_dataset_root()?;
    let output = context
        .working_path
        .join(".photolab/cache/gcp-tiepoint-model");
    let cancellation = himmelcad_core::photolab_jobs::CancellationToken::new();
    prepare_gcp_cameras(
        &development_colmap_executable()?,
        &alignment,
        &output,
        &cancellation,
    )?;
    let path = output.join("images.txt");
    let GcpObservationState::Manual { coordinate } = manual.state else {
        anyhow::bail!("tie-point seed is not manual");
    };
    let Some(track_id) =
        nearest_track_in_image(&path, manual.image_id, coordinate, maximum_distance_pixels)?
    else {
        return Ok(None);
    };
    let measurements = collect_track_measurements(&path, track_id)?;
    if measurements.len() < 2 {
        return Ok(None);
    }
    Ok(Some(GcpTiePointTrack {
        track_id,
        confidence_per_mille: 900,
        measurements,
    }))
}

fn nearest_track_in_image(
    path: &Path,
    target_image: ImageId,
    target: ImageCoordinate,
    maximum_distance_pixels: f64,
) -> anyhow::Result<Option<u64>> {
    let mut reader = StdBufReader::new(std::fs::File::open(path)?);
    while let Some(header) = next_colmap_data_line(&mut reader)? {
        let image_id = header
            .split_ascii_whitespace()
            .next()
            .context("COLMAP image header has no id")?
            .parse::<u32>()?;
        let observations = read_colmap_observation_line(&mut reader)?;
        if image_id != target_image.0 {
            continue;
        }
        let mut best: Option<(u64, f64)> = None;
        let mut values = observations.split_ascii_whitespace();
        while let (Some(x), Some(y), Some(point)) = (values.next(), values.next(), values.next()) {
            let point_id = point.parse::<i64>()?;
            if point_id < 0 {
                continue;
            }
            let distance =
                (x.parse::<f64>()? - target.x_pixels).hypot(y.parse::<f64>()? - target.y_pixels);
            if distance <= maximum_distance_pixels
                && best.is_none_or(|(best_id, best_distance)| {
                    distance < best_distance
                        || (distance == best_distance
                            && u64::try_from(point_id).is_ok_and(|id| id < best_id))
                })
            {
                best = Some((u64::try_from(point_id)?, distance));
            }
        }
        return Ok(best.map(|(id, _)| id));
    }
    Ok(None)
}

fn collect_track_measurements(
    path: &Path,
    track_id: u64,
) -> anyhow::Result<Vec<GcpTiePointMeasurement>> {
    let mut reader = StdBufReader::new(std::fs::File::open(path)?);
    let mut measurements = Vec::new();
    while let Some(header) = next_colmap_data_line(&mut reader)? {
        let image_id = header
            .split_ascii_whitespace()
            .next()
            .context("COLMAP image header has no id")?
            .parse::<u32>()?;
        let observations = read_colmap_observation_line(&mut reader)?;
        let mut values = observations.split_ascii_whitespace();
        while let (Some(x), Some(y), Some(point)) = (values.next(), values.next(), values.next()) {
            if point.parse::<i64>()? == i64::try_from(track_id)? {
                measurements.push(GcpTiePointMeasurement {
                    image_id: ImageId(image_id),
                    coordinate: ImageCoordinate {
                        x_pixels: x.parse()?,
                        y_pixels: y.parse()?,
                    },
                });
                break;
            }
        }
    }
    Ok(measurements)
}

fn next_colmap_data_line(reader: &mut impl std::io::BufRead) -> anyhow::Result<Option<String>> {
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let trimmed = line.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            return Ok(Some(trimmed.to_owned()));
        }
    }
}

fn read_colmap_observation_line(reader: &mut impl std::io::BufRead) -> anyhow::Result<String> {
    let mut line = String::new();
    anyhow::ensure!(
        reader.read_line(&mut line)? > 0,
        "COLMAP image record has no observation line"
    );
    Ok(line.trim().to_owned())
}

fn load_aligned_gcp_cameras(
    projects: &ProjectRuntime,
    processing_set_id: Option<&EntityId>,
) -> anyhow::Result<Vec<AlignedGcpCameraRecord>> {
    let context = projects.compute_context()?;
    let alignment = projects
        .latest_alignment_dataset_for_processing_set(processing_set_id)?
        .root;
    let aligned_model = alignment.join("sparse-aligned");
    let center_in_project_world = aligned_model.is_dir()
        && ["cameras.bin", "cameras.txt"]
            .iter()
            .any(|name| aligned_model.join(name).is_file())
        && ["images.bin", "images.txt"]
            .iter()
            .any(|name| aligned_model.join(name).is_file());
    let output = context
        .working_path
        .join(".photolab/cache/gcp-camera-catalog");
    let cancellation = himmelcad_core::photolab_jobs::CancellationToken::new();
    let mut prepared = prepare_gcp_cameras(
        &development_colmap_executable()?,
        &alignment,
        &output,
        &cancellation,
    )?;
    let calibration_groups = projects.list_calibration_groups()?;
    attach_camera_reference_priors(
        &mut prepared,
        &context.camera_images,
        &alignment,
        &calibration_groups,
    );
    let persisted_map = std::fs::read(alignment.join("camera-map.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<MaterializedCameraMapEntry>>(&bytes).ok());
    let by_entity = context
        .camera_images
        .iter()
        .map(|record| (record.entity_id.0.as_str(), record))
        .collect::<BTreeMap<_, _>>();
    let mut result = Vec::with_capacity(prepared.len());
    for entry in prepared {
        let mapped_entity = persisted_map
            .as_ref()
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|item| item.image_name == entry.image_name)
            })
            .map(|item| item.entity_id.as_str());
        let fallback_index = entry
            .image_name
            .components()
            .next()
            .and_then(|part| part.as_os_str().to_str())
            .and_then(|part| part.parse::<usize>().ok());
        let project_camera = mapped_entity
            .and_then(|entity| by_entity.get(entity).copied())
            .or_else(|| fallback_index.and_then(|index| context.camera_images.get(index)))
            .context("aligned camera cannot be mapped to an imported image")?;
        result.push(AlignedGcpCameraRecord {
            image_id: entry.camera.image_id.0,
            entity_id: project_camera.entity_id.0.clone(),
            image_name: project_camera.name.clone(),
            source_object_hash: project_camera.metadata.source_object_hash.clone(),
            center_in_project_world,
            camera: entry.camera,
        });
    }
    result.sort_by_key(|entry| entry.image_id);
    Ok(result)
}

async fn transform_gcp_import(
    params: CommitGcpCsvParams,
    crs: &CrsService,
) -> anyhow::Result<CommitGcpsParams> {
    use std::fmt::Write as _;

    let path = PathBuf::from(params.path);
    let mapping = params.mapping;
    let source_import =
        tokio::task::spawn_blocking(move || import_gcp_csv_file(&path, mapping)).await??;
    if params.coordinates_already_in_project_crs {
        return Ok(CommitGcpsParams {
            operation_id: params.operation_id,
            transformed_points: source_import.points.clone(),
            source_import,
            transformation: params.transformation,
            coordinates_already_in_project_crs: true,
        });
    }
    let mut input = String::new();
    // GCP CSV columns are explicitly East/North, while an authoritative EPSG
    // pipeline may start in North/East axis order (for example EPSG:31468).
    // Feed cct in the source CRS axis order frozen into the selected pipeline;
    // the image importer separately uses Latitude/Longitude for EPSG:4326.
    let swap_source_axes =
        pipeline_starts_with_axis_swap(&params.transformation.pipeline.proj_pipeline);
    for point in &source_import.points {
        let (first, second) = if swap_source_axes {
            (point.coordinate.north_meters, point.coordinate.east_meters)
        } else {
            (point.coordinate.east_meters, point.coordinate.north_meters)
        };
        writeln!(
            input,
            "{:.15} {:.15} {:.9}",
            first, second, point.coordinate.height_meters
        )?;
    }
    let output = crs
        .transform_text(
            &format!("{}.coordinates", params.operation_id),
            &params.transformation,
            &input,
        )
        .await?;
    let coordinates = parse_transformed_coordinates(
        &output,
        pipeline_ends_with_axis_swap(&params.transformation.pipeline.proj_pipeline),
    )?;
    if coordinates.len() != source_import.points.len() {
        anyhow::bail!(
            "PROJ returned {} coordinates for {} GCPs",
            coordinates.len(),
            source_import.points.len()
        );
    }
    let transformed_points = source_import
        .points
        .iter()
        .cloned()
        .zip(coordinates)
        .map(|(mut point, [east, north, height])| {
            point.coordinate = GcpCoordinate {
                east_meters: east,
                north_meters: north,
                height_meters: height,
            };
            point
        })
        .collect();
    Ok(CommitGcpsParams {
        operation_id: params.operation_id,
        source_import,
        transformed_points,
        transformation: params.transformation,
        coordinates_already_in_project_crs: false,
    })
}

fn pipeline_starts_with_axis_swap(pipeline: &str) -> bool {
    let mut steps = pipeline.split("+step");
    let _pipeline_header = steps.next();
    steps.next().is_some_and(|first| {
        first
            .split_ascii_whitespace()
            .any(|token| token == "+proj=axisswap")
            && first
                .split_ascii_whitespace()
                .any(|token| token == "+order=2,1")
    })
}

fn pipeline_ends_with_axis_swap(pipeline: &str) -> bool {
    pipeline.rsplit("+step").next().is_some_and(|last| {
        last.split_ascii_whitespace()
            .any(|token| token == "+proj=axisswap")
            && last
                .split_ascii_whitespace()
                .any(|token| token == "+order=2,1")
    })
}

async fn handle_crs_rpc(req: RpcRequest, crs: &CrsService) -> RpcResponse {
    match req.method.as_str() {
        "photolab.crs.discover" => {
            match serde_json::from_value::<DiscoverCrsOperationsParams>(req.params) {
                Ok(params) => rpc_result(req.id, crs.discover(params).await.map_err(Into::into)),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.crs.freeze" => {
            match serde_json::from_value::<FreezeCrsOperationParams>(req.params) {
                Ok(params) => rpc_result(req.id, crs.freeze(params).await.map_err(Into::into)),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.crs.cancel" => {
            match serde_json::from_value::<CancelCrsOperationParams>(req.params) {
                Ok(params) => rpc_result(req.id, Ok::<_, anyhow::Error>(crs.cancel(params).await)),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

async fn handle_project_rpc(
    req: RpcRequest,
    projects: Arc<ProjectRuntime>,
    jobs: &JobManager,
) -> RpcResponse {
    match req.method.as_str() {
        "photolab.project.create" => {
            jobs.cancel_all().await;
            rpc_blocking_with_params::<CreateProjectParams, _, _>(
                req.id,
                req.params,
                move |params| projects.create(params),
            )
            .await
        }
        "photolab.project.open" => {
            jobs.cancel_all().await;
            rpc_blocking_with_params::<OpenProjectParams, _, _>(req.id, req.params, move |params| {
                projects.open(&params)
            })
            .await
        }
        "photolab.project.snapshot" => rpc_blocking(req.id, move || projects.snapshot()).await,
        "photolab.project.journal.start" => {
            rpc_blocking_with_params::<AppendJournalParams, _, _>(
                req.id,
                req.params,
                move |params| projects.append_journal(params),
            )
            .await
        }
        "photolab.project.journal.finish" => {
            rpc_blocking_with_params::<FinishJournalParams, _, _>(
                req.id,
                req.params,
                move |params| projects.finish_journal(params),
            )
            .await
        }
        "photolab.project.entity.rename" => {
            rpc_blocking_with_params::<RenameEntityParams, _, _>(
                req.id,
                req.params,
                move |params| projects.rename_entity(params),
            )
            .await
        }
        "photolab.project.entity.visibility" => {
            rpc_blocking_with_params::<SetEntityVisibilityParams, _, _>(
                req.id,
                req.params,
                move |params| projects.set_entity_visibility(params),
            )
            .await
        }
        "photolab.project.entity.move" => {
            rpc_blocking_with_params::<MoveEntityParams, _, _>(req.id, req.params, move |params| {
                projects.move_entity(params)
            })
            .await
        }
        "photolab.project.images.remove" => {
            rpc_blocking_with_params::<RemoveCameraImagesParams, _, _>(
                req.id,
                req.params,
                move |params| projects.remove_camera_images(params),
            )
            .await
        }
        "photolab.project.imageMask.list" => {
            rpc_blocking(req.id, move || projects.list_image_masks()).await
        }
        "photolab.project.imageMask.edit" => {
            rpc_blocking_with_params::<EditImageMaskParams, _, _>(
                req.id,
                req.params,
                move |params| projects.edit_image_mask(params),
            )
            .await
        }
        "photolab.project.imageMask.cancel" => {
            rpc_blocking_with_params::<CancelImageMaskParams, _, _>(
                req.id,
                req.params,
                move |params| Ok::<_, anyhow::Error>(projects.cancel_image_mask(params)),
            )
            .await
        }
        "photolab.project.processingSet.list" => {
            rpc_blocking(req.id, move || projects.list_processing_sets()).await
        }
        "photolab.project.processingSet.create" => {
            rpc_blocking_with_params::<CreateProcessingSetParams, _, _>(
                req.id,
                req.params,
                move |params| projects.create_processing_set(params),
            )
            .await
        }
        "photolab.project.captureGroup.list" => {
            rpc_blocking(req.id, move || projects.list_capture_groups()).await
        }
        "photolab.project.calibrationGroup.list" => {
            rpc_blocking(req.id, move || projects.list_calibration_groups()).await
        }
        "photolab.project.calibrationGroup.updateIntrinsics" => {
            rpc_blocking_with_params::<UpdateCalibrationGroupIntrinsicsParams, _, _>(
                req.id,
                req.params,
                move |params| projects.update_calibration_group_intrinsics(params),
            )
            .await
        }
        "photolab.project.captureGroup.create" => {
            rpc_blocking_with_params::<CreateCaptureGroupParams, _, _>(
                req.id,
                req.params,
                move |params| projects.create_capture_group(params),
            )
            .await
        }
        "photolab.project.captureGroup.confirm" => {
            rpc_blocking_with_params::<ConfirmCaptureGroupParams, _, _>(
                req.id,
                req.params,
                move |params| projects.confirm_capture_group(params),
            )
            .await
        }
        "photolab.project.alignmentMerge.list" => {
            rpc_blocking(req.id, move || projects.list_alignment_merges()).await
        }
        "photolab.project.alignmentMerge.candidates" => {
            rpc_blocking(req.id, move || projects.list_alignment_merge_candidates()).await
        }
        "photolab.project.alignmentMerge.create" => {
            rpc_blocking_with_params::<CreateAlignmentMergeParams, _, _>(
                req.id,
                req.params,
                move |params| projects.create_alignment_merge(params),
            )
            .await
        }
        "photolab.project.autosave" => rpc_blocking(req.id, move || projects.autosave()).await,
        "photolab.project.save" => rpc_blocking(req.id, move || projects.save()).await,
        "photolab.project.saveAs" => {
            rpc_blocking_with_params::<SaveProjectAsParams, _, _>(
                req.id,
                req.params,
                move |params| projects.save_as(&params),
            )
            .await
        }
        "photolab.project.archive.cancel" => {
            rpc_blocking_with_params::<CancelArchiveParams, _, _>(
                req.id,
                req.params,
                move |params| projects.cancel_archive(params),
            )
            .await
        }
        "photolab.project.images.commit" => {
            rpc_blocking_with_params::<CommitImagesParams, _, _>(
                req.id,
                req.params,
                move |params| projects.commit_images(params),
            )
            .await
        }
        "photolab.project.images.cancel" => {
            rpc_blocking_with_params::<CancelImageCommitParams, _, _>(
                req.id,
                req.params,
                move |params| Ok::<_, anyhow::Error>(projects.cancel_image_commit(params)),
            )
            .await
        }
        "photolab.project.close" => {
            jobs.cancel_all().await;
            rpc_blocking(req.id, move || projects.close()).await
        }
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

async fn handle_job_rpc(
    req: RpcRequest,
    jobs: &JobManager,
    projects: Arc<ProjectRuntime>,
    crs: &CrsService,
) -> RpcResponse {
    match req.method.as_str() {
        "photolab.jobs.startProductExport" => {
            match serde_json::from_value::<StartProductExportJobParams>(req.params) {
                Ok(params) => match prepare_product_export_job(params, &projects, crs).await {
                    Ok((job, request)) => {
                        let result = jobs
                            .start(job, move |context| {
                                let mut progress_error = None;
                                export_product(
                                    &request,
                                    &context.cancellation,
                                    |completed, total| {
                                        if progress_error.is_none() {
                                            progress_error = context
                                                .progress
                                                .report_blocking(JobProgress {
                                                    stage: PhotolabStage {
                                                        kind: PhotolabStageKind::Finalizing,
                                                        index: 0,
                                                        stage_count: 1,
                                                        label: "Export product atomically".into(),
                                                    },
                                                    metrics: ProgressMetrics {
                                                        completed_units: completed,
                                                        total_units: Some(total.max(1)),
                                                        completed_bytes: completed,
                                                        total_bytes: Some(total.max(1)),
                                                    },
                                                })
                                                .err()
                                                .map(|error| error.to_string());
                                        }
                                    },
                                )
                                .map_err(map_product_export_error)?;
                                if let Some(message) = progress_error {
                                    return Err(worker_error("progressSink", &message));
                                }
                                Ok(())
                            })
                            .await
                            .map_err(anyhow::Error::from);
                        rpc_result(req.id, result)
                    }
                    Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                },
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.jobs.startBatch" => {
            match serde_json::from_value::<StartBatchJobParams>(req.params) {
                Ok(params) => match prepare_batch_job(&params, &projects) {
                    Ok((job, frozen_plan)) => {
                        let publisher = Arc::clone(&projects);
                        let result = jobs
                            .start(job, move |context| {
                                run_batch_pipeline(params, frozen_plan, &context, &publisher)
                            })
                            .await
                            .map_err(anyhow::Error::from);
                        rpc_result(req.id, result)
                    }
                    Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                },
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.jobs.startGcpOptimization" => {
            match serde_json::from_value::<StartGcpOptimizationJobParams>(req.params) {
                Ok(params) => match prepare_gcp_optimization_job(params, &projects) {
                    Ok((
                        job,
                        project_root,
                        alignment_dataset,
                        camera_root,
                        colmap,
                        run_params,
                        camera_images,
                        calibration_groups,
                        lineage,
                    )) => {
                        let publisher = Arc::clone(&projects);
                        let result = jobs
                            .start(job, move |context| {
                                let mut prepared_cameras = prepare_gcp_cameras(
                                    &colmap,
                                    &alignment_dataset,
                                    &camera_root,
                                    &context.cancellation,
                                )
                                .map_err(|error| {
                                    if matches!(
                                        error,
                                        himmelcad_sidecar::mvs_scene::MvsSceneError::Cancelled
                                    ) {
                                        himmelcad_sidecar::job_runtime::JobWorkerError::Cancelled
                                    } else {
                                        himmelcad_sidecar::job_runtime::JobWorkerError::Failed {
                                            code: "gcpCameraPreparation".into(),
                                            message: error.to_string(),
                                        }
                                    }
                                })?;
                                attach_camera_reference_priors(
                                    &mut prepared_cameras,
                                    &camera_images,
                                    &alignment_dataset,
                                    &calibration_groups,
                                );
                                let tie_points = load_gcp_bundle_tie_points(
                                    &camera_root,
                                    run_params.options.maximum_tie_points,
                                    &context.cancellation,
                                )
                                .map_err(|error| {
                                    if matches!(
                                        error,
                                        himmelcad_sidecar::mvs_scene::MvsSceneError::Cancelled
                                    ) {
                                        himmelcad_sidecar::job_runtime::JobWorkerError::Cancelled
                                    } else {
                                        himmelcad_sidecar::job_runtime::JobWorkerError::Failed {
                                            code: "gcpTiePointPreparation".into(),
                                            message: error.to_string(),
                                        }
                                    }
                                })?;
                                let mut progress_error = None;
                                let outcome = run_gcp_optimization(
                                    &project_root,
                                    RunGcpOptimizationParams {
                                        cameras: prepared_cameras
                                            .into_iter()
                                            .map(|entry| entry.camera)
                                            .collect(),
                                        tie_points,
                                        ..run_params
                                    },
                                    &context.cancellation,
                                    |progress| {
                                        if progress_error.is_none() {
                                            progress_error = context
                                                .progress
                                                .report_blocking(gcp_job_progress(*progress))
                                                .err()
                                                .map(|error| error.to_string());
                                        }
                                    },
                                )
                                .map_err(map_gcp_optimization_error)?;
                                if let Some(message) = progress_error {
                                    return Err(
                                        himmelcad_sidecar::job_runtime::JobWorkerError::Failed {
                                            code: "progressSink".into(),
                                            message,
                                        },
                                    );
                                }
                                context.check_cancelled()?;
                                publisher
                                    .publish_gcp_optimization(outcome, &lineage)
                                    .map_err(|error| {
                                        himmelcad_sidecar::job_runtime::JobWorkerError::Failed {
                                            code: "projectPublish".into(),
                                            message: error.to_string(),
                                        }
                                    })?;
                                Ok(())
                            })
                            .await
                            .map_err(anyhow::Error::from);
                        rpc_result(req.id, result)
                    }
                    Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                },
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.jobs.startImageQuality" => {
            match serde_json::from_value::<StartImageQualityJobParams>(req.params) {
                Ok(params) => match prepare_image_quality_job(params, &projects) {
                    Ok((job, project_root, cameras, scope, configuration)) => {
                        let publisher = Arc::clone(&projects);
                        let job_id = job.id.0.clone();
                        let result = jobs
                            .start(job, move |context| {
                                let analyses = analyze_project_images(
                                    &project_root,
                                    &job_id,
                                    &cameras,
                                    &scope,
                                    &configuration,
                                    &context,
                                )
                                .map_err(image_quality_worker_error)?;
                                context.check_cancelled()?;
                                publisher
                                    .publish_image_quality_analyses(&job_id, analyses)
                                    .map_err(|error| JobWorkerError::Failed {
                                        code: "projectPublish".into(),
                                        message: error.to_string(),
                                    })?;
                                Ok(())
                            })
                            .await
                            .map_err(anyhow::Error::from);
                        rpc_result(req.id, result)
                    }
                    Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                },
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.jobs.startAlignment" => {
            match serde_json::from_value::<StartAlignmentJobParams>(req.params) {
                Ok(params) => match prepare_alignment_job(params, &projects) {
                    Ok((job, request, runtime, dedode, processing_set_id)) => {
                        let combined_stage_count = job.progress.stage.stage_count;
                        let colmap_stage_base = if dedode.is_some() { 3 } else { 0 };
                        let publisher = Arc::clone(&projects);
                        let result = jobs
                            .start(job, move |context| {
                                let mut outcome = match dedode {
                                    Some((dedode_runtime, dedode_request)) => {
                                        let dedode_context =
                                            context.with_progress_window(0, combined_stage_count);
                                        let dedode_outcome = dedode_runtime
                                            .run(&dedode_request, &dedode_context)
                                            .map_err(himmelcad_sidecar::job_runtime::JobWorkerError::from)?;
                                        context.check_cancelled()?;
                                        let colmap_context = context.with_progress_window(
                                            colmap_stage_base,
                                            combined_stage_count,
                                        );
                                        runtime.run_with_dedode(
                                            &request,
                                            &dedode_outcome,
                                            &colmap_context,
                                        )
                                    }
                                    None => {
                                        let colmap_context = context.with_progress_window(
                                            colmap_stage_base,
                                            combined_stage_count,
                                        );
                                        runtime.run(&request, &colmap_context)
                                    }
                                }
                                .map_err(himmelcad_sidecar::job_runtime::JobWorkerError::from)?;
                                prepare_alignment_sparse_potree(&mut outcome, &context)?;
                                prepare_alignment_mesh(&mut outcome, &context)?;
                                context.check_cancelled()?;
                                publisher
                                    .publish_colmap_outcome_for_processing_set(
                                        outcome,
                                        processing_set_id,
                                    )
                                    .map_err(|error| {
                                        himmelcad_sidecar::job_runtime::JobWorkerError::Failed {
                                            code: "projectPublish".into(),
                                            message: error.to_string(),
                                        }
                                    })?;
                                Ok(())
                            })
                            .await
                            .map_err(anyhow::Error::from);
                        rpc_result(req.id, result)
                    }
                    Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                },
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.jobs.startAlignmentMerge" => {
            match serde_json::from_value::<StartAlignmentMergeJobParams>(req.params) {
                Ok(params) => match prepare_alignment_merge_job(params, &projects) {
                    Ok((
                        job,
                        request,
                        runtime,
                        dedode,
                        merge_entity_id,
                        resumed,
                        resumed_shared,
                        shared_control_only,
                    )) => {
                        let combined_stage_count = job.progress.stage.stage_count;
                        let colmap_stage_base = if dedode.is_some() { 3 } else { 0 };
                        let checkpoint_project_root = request.project_root.clone();
                        let checkpoint_operation_id = request.job_id.clone();
                        let checkpoint_input_hash = job.input_hash.clone();
                        let checkpoint_config_hash = job.config_hash.clone();
                        let publisher = Arc::clone(&projects);
                        let result = jobs
                            .start(job, move |context| {
                                if shared_control_only {
                                    context.progress.report_blocking(JobProgress {
                                        stage: PhotolabStage { kind: PhotolabStageKind::Preparing, index: 0, stage_count: 3, label: "Validate shared controls".into() },
                                        metrics: ProgressMetrics { completed_units: 1, total_units: Some(1), completed_bytes: 0, total_bytes: None },
                                    }).map_err(JobWorkerError::from)?;
                                    let merge = publisher.alignment_merge_compute_context(&merge_entity_id).map_err(|error| worker_error("alignmentMergeInput", &error.to_string()))?;
                                    let scopes = merge.record.input_alignment_entity_ids.iter().map(|alignment_id| {
                                        let cameras = merge.input_camera_scopes.get(&alignment_id.0).cloned().unwrap_or_default().into_iter().collect::<BTreeSet<_>>();
                                        (alignment_id.clone(), cameras)
                                    }).collect::<Vec<_>>();
                                    let shared_inputs = scopes.iter().map(|(alignment_id, cameras)| {
                                        let optimization = merge.optimization_records.get(&alignment_id.0).with_context(|| format!("shared-control merge has no published GCP optimization for {}", alignment_id.0))?;
                                        anyhow::ensure!(optimization.artifact.result.converged, "GCP optimization for {} did not converge", alignment_id.0);
                                        let dataset = merge.input_dataset_roots.get(&alignment_id.0).context("shared-control merge lost an input dataset")?;
                                        Ok(SharedControlInput { alignment_id, dataset_root: dataset, camera_entity_ids: cameras, transform: optimization.artifact.result.transform, optimized_cameras: &optimization.artifact.result.cameras })
                                    }).collect::<anyhow::Result<Vec<_>>>().map_err(|error| worker_error("alignmentMergeInput", &error.to_string()))?;
                                    context.progress.report_blocking(JobProgress {
                                        stage: PhotolabStage { kind: PhotolabStageKind::SparseReconstruction, index: 1, stage_count: 3, label: "Assemble optimized survey blocks".into() },
                                        metrics: ProgressMetrics::empty(),
                                    }).map_err(JobWorkerError::from)?;
                                    let outcome = if let Some(outcome) = resumed_shared {
                                        outcome
                                    } else {
                                        build_shared_control_merge(&checkpoint_project_root, &checkpoint_operation_id, &shared_inputs, &context.cancellation).map_err(|error| {
                                            if matches!(error, himmelcad_sidecar::alignment_merge_runtime::AlignmentMergeRuntimeError::Cancelled) { JobWorkerError::Cancelled } else { worker_error("sharedControlMerge", &error.to_string()) }
                                        })?
                                    };
                                    let scratch_relative_path = outcome.scratch_path.strip_prefix(&checkpoint_project_root).map_err(|_| worker_error("alignmentMergeCheckpoint", "shared-control merge scratch escaped the project"))?.to_path_buf();
                                    write_merge_checkpoint(&checkpoint_project_root, &AlignmentMergeCheckpoint { schema_version: 1, operation_id: checkpoint_operation_id.clone(), merge_entity_id: merge_entity_id.clone(), input_hash: checkpoint_input_hash.clone(), config_hash: checkpoint_config_hash.clone(), state: AlignmentMergeCheckpointState::Solved, scratch_relative_path: Some(scratch_relative_path), summary_sha256: Some(outcome.dataset_sha256.clone()) }).map_err(|error| worker_error("alignmentMergeCheckpoint", &error.to_string()))?;
                                    context.check_cancelled()?;
                                    context.progress.report_blocking(JobProgress {
                                        stage: PhotolabStage { kind: PhotolabStageKind::Finalizing, index: 2, stage_count: 3, label: "Publish common survey frame".into() },
                                        metrics: ProgressMetrics::empty(),
                                    }).map_err(JobWorkerError::from)?;
                                    publisher.publish_shared_control_merge_outcome(&merge_entity_id, outcome, &checkpoint_operation_id).map_err(|error| worker_error("alignmentMergePublish", &error.to_string()))?;
                                    let _ = write_merge_checkpoint(&checkpoint_project_root, &AlignmentMergeCheckpoint { schema_version: 1, operation_id: checkpoint_operation_id, merge_entity_id, input_hash: checkpoint_input_hash, config_hash: checkpoint_config_hash, state: AlignmentMergeCheckpointState::Published, scratch_relative_path: None, summary_sha256: None });
                                    return Ok(());
                                }
                                let solve = resumed.map_or_else(
                                    || match dedode {
                                        Some((dedode_runtime, dedode_request)) => {
                                            let dedode_context = context
                                                .with_progress_window(0, combined_stage_count);
                                            let dedode_outcome = dedode_runtime
                                                .run(&dedode_request, &dedode_context)
                                                .map_err(JobWorkerError::from);
                                            dedode_outcome.and_then(|dedode_outcome| {
                                                context.check_cancelled()?;
                                                runtime
                                                    .run_with_dedode(
                                                        &request,
                                                        &dedode_outcome,
                                                        &context.with_progress_window(
                                                            colmap_stage_base,
                                                            combined_stage_count,
                                                        ),
                                                    )
                                                    .map_err(JobWorkerError::from)
                                            })
                                        }
                                        None => runtime
                                            .run(
                                                &request,
                                                &context.with_progress_window(
                                                    colmap_stage_base,
                                                    combined_stage_count,
                                                ),
                                            )
                                            .map_err(JobWorkerError::from),
                                    },
                                    Ok,
                                );
                                let outcome = match solve {
                                    Ok(outcome) => outcome,
                                    Err(error) => {
                                        if matches!(error, JobWorkerError::Cancelled) {
                                            let _ = write_merge_checkpoint(
                                                &checkpoint_project_root,
                                                &AlignmentMergeCheckpoint {
                                                    schema_version: 1,
                                                    operation_id: checkpoint_operation_id.clone(),
                                                    merge_entity_id: merge_entity_id.clone(),
                                                    input_hash: checkpoint_input_hash.clone(),
                                                    config_hash: checkpoint_config_hash.clone(),
                                                    state: AlignmentMergeCheckpointState::Cancelled,
                                                    scratch_relative_path: None,
                                                    summary_sha256: None,
                                                },
                                            );
                                        }
                                        return Err(error);
                                    }
                                };
                                let scratch_relative_path = outcome
                                    .scratch_path
                                    .strip_prefix(&checkpoint_project_root)
                                    .map_err(|_| {
                                        worker_error(
                                            "alignmentMergeCheckpoint",
                                            "merge scratch path escaped the project",
                                        )
                                    })?
                                    .to_path_buf();
                                write_merge_checkpoint(
                                    &checkpoint_project_root,
                                    &AlignmentMergeCheckpoint {
                                        schema_version: 1,
                                        operation_id: checkpoint_operation_id.clone(),
                                        merge_entity_id: merge_entity_id.clone(),
                                        input_hash: checkpoint_input_hash.clone(),
                                        config_hash: checkpoint_config_hash.clone(),
                                        state: AlignmentMergeCheckpointState::Solved,
                                        scratch_relative_path: Some(scratch_relative_path),
                                        summary_sha256: Some(outcome.summary_sha256.clone()),
                                    },
                                )
                                .map_err(|error| {
                                    worker_error("alignmentMergeCheckpoint", &error.to_string())
                                })?;
                                context.check_cancelled()?;
                                publisher
                                    .publish_alignment_merge_outcome(&merge_entity_id, outcome)
                                    .map_err(|error| {
                                        worker_error("alignmentMergePublish", &error.to_string())
                                    })?;
                                let _ = write_merge_checkpoint(
                                    &checkpoint_project_root,
                                    &AlignmentMergeCheckpoint {
                                        schema_version: 1,
                                        operation_id: checkpoint_operation_id,
                                        merge_entity_id,
                                        input_hash: checkpoint_input_hash,
                                        config_hash: checkpoint_config_hash,
                                        state: AlignmentMergeCheckpointState::Published,
                                        scratch_relative_path: None,
                                        summary_sha256: None,
                                    },
                                );
                                Ok(())
                            })
                            .await
                            .map_err(anyhow::Error::from);
                        rpc_result(req.id, result)
                    }
                    Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                },
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.jobs.startProduct" => {
            match serde_json::from_value::<StartProductJobParams>(req.params) {
                Ok(params)
                    if matches!(params.configuration, ProductRunConfiguration::Splat { .. }) =>
                {
                    match prepare_brush_product_job(params, &projects, None) {
                        Ok((job, request, runtime, lineage)) => {
                            let publisher = Arc::clone(&projects);
                            let result = jobs
                                .start(job, move |context| {
                                    let mut outcome = runtime.run(&request, &context).map_err(
                                        himmelcad_sidecar::job_runtime::JobWorkerError::from,
                                    )?;
                                    let project_transform = publisher
                                        .latest_gcp_optimization_for_lineage(&lineage)
                                        .map_err(|error| {
                                            worker_error("projectRead", &error.to_string())
                                        })?
                                        .map(|record| record.artifact.result.transform);
                                    let prepared = tile_brush_ply(
                                        &outcome.output_path,
                                        &outcome.scratch_path.join("prepared-splats"),
                                        project_transform,
                                        &context.cancellation,
                                    )
                                    .map_err(map_splat_tiler_error)?;
                                    outcome.prepared_splats = Some(prepared);
                                    context.check_cancelled()?;
                                    publisher.publish_brush_outcome(outcome, &lineage).map_err(
                                        |error| {
                                            himmelcad_sidecar::job_runtime::JobWorkerError::Failed {
                                                code: "projectPublish".into(),
                                                message: error.to_string(),
                                            }
                                        },
                                    )?;
                                    Ok(())
                                })
                                .await
                                .map_err(anyhow::Error::from);
                            rpc_result(req.id, result)
                        }
                        Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                    }
                }
                Ok(params)
                    if matches!(
                        params.configuration,
                        ProductRunConfiguration::Depth { .. }
                            | ProductRunConfiguration::Dense { .. }
                    ) =>
                {
                    match prepare_mvs_product_job(params, &projects, None) {
                        Ok(prepared) => {
                            let publisher = Arc::clone(&projects);
                            let result = jobs
                                .start(prepared.job.clone(), move |context| {
                                    let scene = prepare_or_reuse_mvs_scene(&prepared, &context)?;
                                    let resume = if prepared.reuse_compatible_maps {
                                        prepared.runtime.compatible_resume_checkpoint(
                                            &scene.manifest_sha256,
                                            &prepared.settings,
                                        )?
                                    } else {
                                        None
                                    };
                                    let request = MvsRunRequest {
                                        job_id: prepared.operation_id,
                                        scene_manifest_path: scene.manifest_path,
                                        scene_manifest_sha256: scene.manifest_sha256,
                                        device: MvsComputeDevice::Cpu {
                                            threads: portable_mvs_threads(),
                                        },
                                        settings: prepared.settings,
                                        fuse_dense_point_cloud: prepared.fuse_dense_point_cloud,
                                        resume,
                                    };
                                    let mut outcome =
                                        prepared.runtime.run(&request, &context).map_err(
                                            himmelcad_sidecar::job_runtime::JobWorkerError::from,
                                        )?;
                                    if let Some(dense) = outcome.output.dense_point_cloud.as_ref() {
                                        let dense_path =
                                            outcome.output_path.join(&dense.relative_path);
                                        let potree = prepare_dense_potree(
                                            &dense_path,
                                            &outcome.scratch_path.join("potree"),
                                            &potree_converter_executable()?,
                                            &context.cancellation,
                                        )
                                        .map_err(map_dense_prep_error)?;
                                        outcome.potree = Some(potree);
                                    }
                                    context.check_cancelled()?;
                                    publisher
                                        .publish_mvs_outcome(
                                            outcome,
                                            &prepared.camera_entity_ids,
                                            &prepared.image_mask_scope.scope_sha256,
                                            &prepared.lineage,
                                        )
                                        .map_err(|error| {
                                            himmelcad_sidecar::job_runtime::JobWorkerError::Failed {
                                                code: "projectPublish".into(),
                                                message: error.to_string(),
                                            }
                                        })?;
                                    Ok(())
                                })
                                .await
                                .map_err(anyhow::Error::from);
                            rpc_result(req.id, result)
                        }
                        Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                    }
                }
                Ok(params)
                    if matches!(
                        params.configuration,
                        ProductRunConfiguration::Dem { .. } | ProductRunConfiguration::Ortho { .. }
                    ) =>
                {
                    match prepare_raster_product_job(params, &projects, None) {
                        Ok(prepared) => {
                            let publisher = Arc::clone(&projects);
                            let result = jobs
                                .start(prepared.job.clone(), move |context| {
                                    run_raster_product(prepared, &context, &publisher)
                                })
                                .await
                                .map_err(anyhow::Error::from);
                            rpc_result(req.id, result)
                        }
                        Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                    }
                }
                Ok(params)
                    if matches!(params.configuration, ProductRunConfiguration::Mesh { .. }) =>
                {
                    match prepare_mesh_job(params, &projects, None) {
                        Ok(prepared) => {
                            let publisher = Arc::clone(&projects);
                            let result = jobs
                                .start(prepared.job.clone(), move |context| {
                                    run_mesh_job(prepared, &context, &publisher)
                                })
                                .await
                                .map_err(anyhow::Error::from);
                            rpc_result(req.id, result)
                        }
                        Err(error) => rpc_err(req.id, -32000, &error.to_string()),
                    }
                }
                Ok(_) => rpc_err(
                    req.id,
                    -32603,
                    "product configuration did not match a registered runtime",
                ),
                Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
            }
        }
        "photolab.jobs.list" => match serde_json::from_value::<ListJobsParams>(req.params) {
            Ok(params) => rpc_result(req.id, jobs.list(params).await.map_err(anyhow::Error::from)),
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        "photolab.jobs.status" => match serde_json::from_value::<JobIdParams>(req.params) {
            Ok(params) => rpc_result(
                req.id,
                jobs.status(&params.job_id)
                    .await
                    .map_err(anyhow::Error::from),
            ),
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        "photolab.jobs.cancel" => match serde_json::from_value::<JobIdParams>(req.params) {
            Ok(params) => rpc_result(
                req.id,
                jobs.cancel(&params.job_id)
                    .await
                    .map_err(anyhow::Error::from),
            ),
            Err(error) => rpc_err(req.id, -32602, &format!("invalid params: {error}")),
        },
        other => rpc_err(req.id, -32601, &format!("method not found: {other}")),
    }
}

type PreparedGcpOptimizationJob = (
    NewPhotolabJob,
    PathBuf,
    PathBuf,
    PathBuf,
    PathBuf,
    RunGcpOptimizationParams,
    Vec<himmelcad_sidecar::image_commit::ProjectCameraImageRecord>,
    Vec<crate::project_runtime::CameraCalibrationGroupRecord>,
    ProductLineage,
);

fn prepare_batch_job(
    params: &StartBatchJobParams,
    projects: &ProjectRuntime,
) -> anyhow::Result<(NewPhotolabJob, FrozenBatchExecutionPlan)> {
    anyhow::ensure!(
        !params.steps.is_empty() && params.steps.len() <= 32,
        "batch needs 1..=32 steps"
    );
    validate_unattended_batch_recipe(&params.steps)?;
    let context = projects.compute_context()?;
    validate_explicit_batch_artifacts(params, projects, &context)?;
    let processing_set = if let Some(processing_set_id) = params.processing_set_id.as_ref() {
        let processing_set = projects
            .list_processing_sets()?
            .into_iter()
            .find(|set| &set.entity_id == processing_set_id)
            .context("batch processing set does not exist")?;
        let mut requested = params.camera_entity_ids.clone();
        requested.sort();
        requested.dedup();
        let mut frozen = processing_set
            .camera_entity_ids
            .iter()
            .map(|id| id.0.clone())
            .collect::<Vec<_>>();
        frozen.sort();
        anyhow::ensure!(
            requested == frozen,
            "batch camera selection differs from its immutable processing set"
        );
        Some(processing_set)
    } else {
        None
    };
    let batch_camera_entity_ids = if params.camera_entity_ids.is_empty() {
        context
            .camera_images
            .iter()
            .map(|camera| camera.entity_id.0.clone())
            .collect::<Vec<_>>()
    } else {
        params.camera_entity_ids.clone()
    };
    anyhow::ensure!(
        batch_camera_entity_ids.len() >= 2,
        "batch needs at least two frozen camera inputs"
    );
    let recipe_sha256 = batch_steps_hash(&params.steps, &params.camera_entity_ids)?;
    let input_sha256 = batch_input_hash(
        projects,
        &context,
        &params.camera_entity_ids,
        params.processing_set_id.as_ref(),
    )?;
    let frozen_plan = freeze_batch_execution_plan(
        params,
        &context,
        &batch_camera_entity_ids,
        processing_set.as_ref(),
        recipe_sha256,
        input_sha256,
    )?;
    let stage_count = 1_u32.saturating_add(u32::try_from(params.steps.len())?.saturating_mul(32));
    let job = NewPhotolabJob {
        id: PhotolabJobId(params.operation_id.clone()),
        kind: PhotolabJobKind::Batch,
        config_hash: frozen_plan.recipe_sha256.clone(),
        input_hash: frozen_plan.plan_sha256.clone(),
        progress: JobProgress {
            stage: PhotolabStage {
                kind: PhotolabStageKind::Preparing,
                index: 0,
                stage_count,
                label: "Validate batch and recovery state".into(),
            },
            metrics: ProgressMetrics::empty(),
        },
    };
    Ok((job, frozen_plan))
}

fn validate_explicit_batch_artifacts(
    params: &StartBatchJobParams,
    projects: &ProjectRuntime,
    context: &crate::project_runtime::ProjectComputeContext,
) -> anyhow::Result<()> {
    let reference = context.manifest.reference_frame.as_ref();
    for step in &params.steps {
        let BatchPipelineStep::Product {
            configuration:
                ProductRunConfiguration::Ortho {
                    source_dem_entity_id: Some(entity_id),
                    source_dem_version_sha256: Some(expected_version),
                    ..
                },
        } = step
        else {
            continue;
        };
        let (_, record) =
            projects.raster_dataset_by_entity_id(entity_id, PublishedRasterKind::Dem, None)?;
        let reference = reference.context(
            "orthomosaic and external DEM need an explicit projected project reference frame",
        )?;
        let current = context
            .manifest
            .entities
            .get(&entity_id.0)
            .context("selected external DEM entity does not exist")?;
        anyhow::ensure!(
            current.version_hash == *expected_version,
            "selected external DEM revision changed; rebind the recipe slot"
        );
        let expected_horizontal = crs_definition_text(&reference.target.horizontal.crs);
        let expected_vertical = height_reference_text(&reference.target.vertical);
        anyhow::ensure!(
            record.summary.crs.horizontal == expected_horizontal,
            "selected DEM horizontal CRS differs from the project"
        );
        anyhow::ensure!(
            record.summary.crs.vertical == expected_vertical,
            "selected DEM height reference differs from the project"
        );
        let grid = &record.summary.grid;
        anyhow::ensure!(
            grid.gsd.is_finite()
                && grid.gsd > 0.0
                && grid.width_pixels > 0
                && grid.height_pixels > 0
                && grid.bounds.minimum_east.is_finite()
                && grid.bounds.minimum_north.is_finite()
                && grid.bounds.maximum_east.is_finite()
                && grid.bounds.maximum_north.is_finite()
                && grid.bounds.minimum_east < grid.bounds.maximum_east
                && grid.bounds.minimum_north < grid.bounds.maximum_north,
            "selected DEM has invalid coverage or resolution metadata"
        );
    }
    Ok(())
}

fn validate_unattended_batch_recipe(steps: &[BatchPipelineStep]) -> anyhow::Result<()> {
    anyhow::ensure!(
        matches!(steps.first(), Some(BatchPipelineStep::Alignment { .. })),
        "an unattended batch must start with an explicit alignment node"
    );
    anyhow::ensure!(
        steps
            .iter()
            .filter(|step| matches!(step, BatchPipelineStep::Alignment { .. }))
            .count()
            == 1,
        "an unattended batch must contain exactly one alignment node"
    );
    let mut dense_ready = false;
    let mut dem_ready = false;
    let mut mesh_ready = false;
    for step in steps {
        if let BatchPipelineStep::Alignment { preset, profile } = step {
            anyhow::ensure!(
                preset.is_some() ^ profile.is_some(),
                "batch alignment needs exactly one preset snapshot"
            );
            if let Some(preset) = preset {
                anyhow::ensure!(
                    !preset.id.trim().is_empty() && !preset.name.trim().is_empty(),
                    "batch alignment preset identity is incomplete"
                );
            }
        }
        let BatchPipelineStep::Product { configuration } = step else {
            continue;
        };
        match configuration {
            ProductRunConfiguration::Depth { .. } => {}
            ProductRunConfiguration::Dense { .. } => dense_ready = true,
            ProductRunConfiguration::Dem { .. } => {
                anyhow::ensure!(dense_ready, "DEM needs a prior dense-cloud node");
                dem_ready = true;
            }
            ProductRunConfiguration::Ortho {
                source_dem_entity_id,
                source_dem_version_sha256,
                ..
            } => {
                anyhow::ensure!(
                    (source_dem_entity_id.is_some() && source_dem_version_sha256.is_some())
                        || (source_dem_entity_id.is_none()
                            && source_dem_version_sha256.is_none()
                            && dem_ready),
                    "orthomosaic needs an exact external DEM entity/version binding or a prior DEM node"
                );
            }
            ProductRunConfiguration::Mesh { .. } => {
                anyhow::ensure!(dem_ready, "mesh needs a prior DEM node");
                mesh_ready = true;
            }
            ProductRunConfiguration::Splat { .. } => {
                anyhow::ensure!(mesh_ready, "Gaussian splat needs a prior mesh node");
            }
        }
    }
    Ok(())
}

fn freeze_batch_execution_plan(
    params: &StartBatchJobParams,
    context: &crate::project_runtime::ProjectComputeContext,
    camera_entity_ids: &[String],
    processing_set: Option<&crate::project_runtime::ProcessingSetRecord>,
    recipe_sha256: ObjectHash,
    input_sha256: ObjectHash,
) -> anyhow::Result<FrozenBatchExecutionPlan> {
    let node_config_sha256 = params
        .steps
        .iter()
        .map(|step| serde_json::to_vec(step).map(|bytes| ObjectHash::of_bytes(&bytes)))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut entities = BTreeMap::<String, FrozenBatchEntity>::new();
    for id in camera_entity_ids {
        let entity = context
            .manifest
            .entities
            .get(id)
            .with_context(|| format!("batch camera entity does not exist: {id}"))?;
        anyhow::ensure!(
            entity.kind == EntityKind::CameraImage,
            "batch camera input has the wrong entity kind: {id}"
        );
        entities.insert(
            id.clone(),
            FrozenBatchEntity {
                entity_id: entity.id.clone(),
                entity_revision_sha256: entity.version_hash.clone(),
            },
        );
    }
    if let Some(set) = processing_set {
        let entity = context
            .manifest
            .entities
            .get(&set.entity_id.0)
            .context("batch processing-set entity does not exist")?;
        entities.insert(
            entity.id.0.clone(),
            FrozenBatchEntity {
                entity_id: entity.id.clone(),
                entity_revision_sha256: entity.version_hash.clone(),
            },
        );
    }
    let mut external_artifacts = Vec::new();
    for step in &params.steps {
        let BatchPipelineStep::Product {
            configuration:
                configuration @ ProductRunConfiguration::Ortho {
                    source_dem_entity_id: Some(entity_id),
                    ..
                },
        } = step
        else {
            continue;
        };
        let entity = context
            .manifest
            .entities
            .get(&entity_id.0)
            .context("selected external DEM entity does not exist")?;
        anyhow::ensure!(
            entity.kind == EntityKind::DigitalElevationModel,
            "selected external DEM binding has the wrong entity kind"
        );
        let config_sha256 = ObjectHash::of_bytes(&serde_json::to_vec(configuration)?);
        external_artifacts.push(FrozenBatchExternalArtifact {
            entity_id: entity.id.clone(),
            entity_revision_sha256: entity.version_hash.clone(),
            content_sha256: entity.version_hash.clone(),
            provider_id: "hcad.photolab.raster".into(),
            provider_version: "1".into(),
            config_sha256,
        });
        entities.insert(
            entity.id.0.clone(),
            FrozenBatchEntity {
                entity_id: entity.id.clone(),
                entity_revision_sha256: entity.version_hash.clone(),
            },
        );
    }
    external_artifacts.sort_by(|left, right| left.entity_id.0.cmp(&right.entity_id.0));
    let frozen_entities = entities.into_values().collect::<Vec<_>>();
    let processing_set_membership_sha256 = processing_set.map(|set| set.membership_sha256.clone());
    let plan_sha256 = ObjectHash::of_bytes(&serde_json::to_vec(&(
        1_u32,
        &params.operation_id,
        &context.manifest.project_id,
        &recipe_sha256,
        &input_sha256,
        &node_config_sha256,
        &frozen_entities,
        &processing_set_membership_sha256,
        &external_artifacts,
    ))?);
    Ok(FrozenBatchExecutionPlan {
        schema_version: 1,
        run_id: params.operation_id.clone(),
        project_id: context.manifest.project_id.clone(),
        recipe_sha256,
        input_sha256,
        plan_sha256,
        node_config_sha256,
        frozen_entities,
        processing_set_membership_sha256,
        external_artifacts,
    })
}

fn write_frozen_batch_plan(path: &Path, plan: &FrozenBatchExecutionPlan) -> anyhow::Result<()> {
    let bytes = serde_json::to_vec_pretty(plan)?;
    if path.is_file() {
        let existing: FrozenBatchExecutionPlan = serde_json::from_slice(&std::fs::read(path)?)?;
        anyhow::ensure!(
            existing == *plan,
            "the persisted concrete batch run differs from the requested run"
        );
        return Ok(());
    }
    let temporary = path.with_extension("json.pending");
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

fn validate_frozen_batch_entities(
    context: &crate::project_runtime::ProjectComputeContext,
    plan: &FrozenBatchExecutionPlan,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        plan.schema_version == 1 && plan.project_id == context.manifest.project_id,
        "concrete batch run belongs to another project or schema"
    );
    for frozen in &plan.frozen_entities {
        let current = context
            .manifest
            .entities
            .get(&frozen.entity_id.0)
            .with_context(|| format!("frozen batch entity was removed: {}", frozen.entity_id.0))?;
        anyhow::ensure!(
            current.version_hash == frozen.entity_revision_sha256,
            "frozen batch entity changed: {}",
            frozen.entity_id.0
        );
    }
    Ok(())
}

fn run_batch_pipeline(
    params: StartBatchJobParams,
    frozen_plan: FrozenBatchExecutionPlan,
    context: &JobWorkerContext,
    projects: &ProjectRuntime,
) -> Result<(), JobWorkerError> {
    let total = 1_u32.saturating_add(
        u32::try_from(params.steps.len())
            .unwrap_or(u32::MAX)
            .saturating_mul(32),
    );
    let compute_context = projects
        .compute_context()
        .map_err(|error| worker_error("projectRead", &error.to_string()))?;
    validate_frozen_batch_entities(&compute_context, &frozen_plan)
        .map_err(|error| worker_error("batchInputsChanged", &error.to_string()))?;
    let steps_sha256 = batch_steps_hash(&params.steps, &params.camera_entity_ids)
        .map_err(|error| worker_error("batchCheckpoint", &error.to_string()))?;
    let input_sha256 = batch_input_hash(
        projects,
        &compute_context,
        &params.camera_entity_ids,
        params.processing_set_id.as_ref(),
    )
    .map_err(|error| worker_error("batchCheckpoint", &error.to_string()))?;
    if steps_sha256 != frozen_plan.recipe_sha256 || input_sha256 != frozen_plan.input_sha256 {
        return Err(worker_error(
            "batchInputsChanged",
            "the project changed after batch instantiation; create a new concrete run",
        ));
    }
    let checkpoint_root = compute_context
        .working_path
        .join(".photolab/batch")
        .join(&frozen_plan.plan_sha256.0);
    std::fs::create_dir_all(&checkpoint_root)
        .map_err(|error| worker_error("io", &error.to_string()))?;
    write_frozen_batch_plan(&checkpoint_root.join("plan.json"), &frozen_plan)
        .map_err(|error| worker_error("batchPlan", &error.to_string()))?;
    let checkpoint_path = checkpoint_root.join("checkpoint.json");
    let completed = read_batch_checkpoint(
        &checkpoint_path,
        &frozen_plan.plan_sha256,
        &steps_sha256,
        &input_sha256,
    )
    .map_err(|error| worker_error("batchCheckpoint", &error.to_string()))?
    .min(params.steps.len());
    for (index, step) in params.steps.iter().cloned().enumerate().skip(completed) {
        context.check_cancelled()?;
        let base = 1 + u32::try_from(index).unwrap_or(u32::MAX).saturating_mul(32);
        match step.clone() {
            BatchPipelineStep::Alignment { preset, profile } => {
                let (profile, overrides) = match (preset, profile) {
                    (Some(preset), None) => (preset.profile, preset.overrides),
                    (None, Some(profile)) => (profile, AlignmentJobOverrides::default()),
                    _ => {
                        return Err(worker_error(
                            "batchPrepare",
                            "batch alignment needs exactly one preset snapshot",
                        ));
                    }
                };
                let (_, request, runtime, dedode, processing_set_id) = prepare_alignment_job(
                    StartAlignmentJobParams {
                        operation_id: format!("{}-{:02}-alignment", params.operation_id, index),
                        profile,
                        camera_entity_ids: params.camera_entity_ids.clone(),
                        processing_set_id: params.processing_set_id.clone(),
                        overrides,
                    },
                    projects,
                )
                .map_err(|error| worker_error("batchPrepare", &error.to_string()))?;
                let mut outcome = if let Some((dedode_runtime, dedode_request)) = dedode {
                    let dedode_context = context.with_progress_window(base, total);
                    let dedode_outcome = dedode_runtime
                        .run(&dedode_request, &dedode_context)
                        .map_err(JobWorkerError::from)?;
                    let colmap_context = context.with_progress_window(base + 3, total);
                    runtime.run_with_dedode(&request, &dedode_outcome, &colmap_context)
                } else {
                    let colmap_context = context.with_progress_window(base, total);
                    runtime.run(&request, &colmap_context)
                }
                .map_err(JobWorkerError::from)?;
                prepare_alignment_sparse_potree(&mut outcome, context)?;
                prepare_alignment_mesh(&mut outcome, context)?;
                context.check_cancelled()?;
                projects
                    .publish_colmap_outcome_for_processing_set(outcome, processing_set_id)
                    .map_err(|error| worker_error("projectPublish", &error.to_string()))?;
            }
            BatchPipelineStep::Product { mut configuration } => {
                let source_dem_entity_id = match &mut configuration {
                    ProductRunConfiguration::Ortho {
                        source_dem_entity_id,
                        ..
                    }
                    | ProductRunConfiguration::Mesh {
                        source_dem_entity_id,
                        ..
                    } => Some(source_dem_entity_id),
                    _ => None,
                };
                if let Some(source_dem_entity_id) = source_dem_entity_id {
                    if source_dem_entity_id.is_none() {
                        let dem_index = params.steps[..index]
                            .iter()
                            .enumerate()
                            .rev()
                            .find_map(|(candidate_index, candidate)| {
                                matches!(
                                    candidate,
                                    BatchPipelineStep::Product {
                                        configuration: ProductRunConfiguration::Dem { .. }
                                    }
                                )
                                .then_some(candidate_index)
                            })
                            .ok_or_else(|| {
                                worker_error(
                                    "batchNotReady",
                                    "orthomosaic needs an explicit DEM binding or a prior DEM node",
                                )
                            })?;
                        *source_dem_entity_id = Some(EntityId(format!(
                            "{}:raster:{}-{:02}-dem",
                            compute_context.manifest.project_id, params.operation_id, dem_index
                        )));
                    }
                }
                execute_batch_product(
                    &params.operation_id,
                    index,
                    configuration,
                    &params.camera_entity_ids,
                    params.processing_set_id.as_ref(),
                    context,
                    projects,
                    base,
                    total,
                )?;
            }
        }
        projects
            .autosave()
            .map_err(|error| worker_error("autosave", &error.to_string()))?;
        write_batch_checkpoint(
            &checkpoint_path,
            &frozen_plan.plan_sha256,
            &steps_sha256,
            &input_sha256,
            index + 1,
        )
        .map_err(|error| worker_error("batchCheckpoint", &error.to_string()))?;
        context
            .progress
            .report_blocking(JobProgress {
                stage: PhotolabStage {
                    kind: PhotolabStageKind::Finalizing,
                    index: base + 31,
                    stage_count: total,
                    label: format!("Batch-Schritt {} atomar abgeschlossen", index + 1),
                },
                metrics: ProgressMetrics {
                    completed_units: 1,
                    total_units: Some(1),
                    completed_bytes: 0,
                    total_bytes: None,
                },
            })
            .map_err(JobWorkerError::from)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)] // Batch-product execution mirrors the persisted run context.
fn execute_batch_product(
    batch_id: &str,
    index: usize,
    configuration: ProductRunConfiguration,
    camera_entity_ids: &[String],
    processing_set_id: Option<&EntityId>,
    context: &JobWorkerContext,
    projects: &ProjectRuntime,
    base: u32,
    total: u32,
) -> Result<(), JobWorkerError> {
    let operation_id = format!(
        "{}-{:02}-{}",
        batch_id,
        index,
        product_kind_name(&configuration)
    );
    match configuration {
        config @ ProductRunConfiguration::Depth { .. }
        | config @ ProductRunConfiguration::Dense { .. } => {
            let prepared = prepare_mvs_product_job(
                StartProductJobParams {
                    operation_id,
                    configuration: config,
                    processing_set_id: processing_set_id.cloned(),
                    source_alignment_entity_id: None,
                },
                projects,
                Some(camera_entity_ids),
            )
            .map_err(|error| worker_error("batchPrepare", &error.to_string()))?;
            let node = context.with_progress_window(base, total);
            let scene = prepare_or_reuse_mvs_scene(&prepared, &node)?;
            let resume = if prepared.reuse_compatible_maps {
                prepared
                    .runtime
                    .compatible_resume_checkpoint(&scene.manifest_sha256, &prepared.settings)
                    .map_err(JobWorkerError::from)?
            } else {
                None
            };
            let request = MvsRunRequest {
                job_id: prepared.operation_id,
                scene_manifest_path: scene.manifest_path,
                scene_manifest_sha256: scene.manifest_sha256,
                device: MvsComputeDevice::Cpu {
                    threads: portable_mvs_threads(),
                },
                settings: prepared.settings,
                fuse_dense_point_cloud: prepared.fuse_dense_point_cloud,
                resume,
            };
            let mut outcome = prepared
                .runtime
                .run(&request, &node)
                .map_err(JobWorkerError::from)?;
            if let Some(dense) = outcome.output.dense_point_cloud.as_ref() {
                outcome.potree = Some(
                    prepare_dense_potree(
                        &outcome.output_path.join(&dense.relative_path),
                        &outcome.scratch_path.join("potree"),
                        &potree_converter_executable()?,
                        &node.cancellation,
                    )
                    .map_err(map_dense_prep_error)?,
                );
            }
            projects
                .publish_mvs_outcome(
                    outcome,
                    &prepared.camera_entity_ids,
                    &prepared.image_mask_scope.scope_sha256,
                    &prepared.lineage,
                )
                .map_err(|error| worker_error("projectPublish", &error.to_string()))?;
        }
        config @ ProductRunConfiguration::Dem { .. }
        | config @ ProductRunConfiguration::Ortho { .. } => {
            let prepared = prepare_raster_product_job(
                StartProductJobParams {
                    operation_id,
                    configuration: config,
                    processing_set_id: processing_set_id.cloned(),
                    source_alignment_entity_id: None,
                },
                projects,
                Some(camera_entity_ids),
            )
            .map_err(|error| worker_error("batchPrepare", &error.to_string()))?;
            let node = context.with_progress_window(base, total);
            run_raster_product(prepared, &node, projects)?;
        }
        config @ ProductRunConfiguration::Mesh { .. } => {
            let prepared = prepare_mesh_job(
                StartProductJobParams {
                    operation_id,
                    configuration: config,
                    processing_set_id: processing_set_id.cloned(),
                    source_alignment_entity_id: None,
                },
                projects,
                Some(camera_entity_ids),
            )
            .map_err(|error| worker_error("batchPrepare", &error.to_string()))?;
            let node = context.with_progress_window(base, total);
            run_mesh_job(prepared, &node, projects)?;
        }
        config @ ProductRunConfiguration::Splat { .. } => {
            let (_, request, runtime, lineage) = prepare_brush_product_job(
                StartProductJobParams {
                    operation_id,
                    configuration: config,
                    processing_set_id: processing_set_id.cloned(),
                    source_alignment_entity_id: None,
                },
                projects,
                Some(camera_entity_ids),
            )
            .map_err(|error| worker_error("batchPrepare", &error.to_string()))?;
            let node = context.with_progress_window(base, total);
            let mut outcome = runtime.run(&request, &node).map_err(JobWorkerError::from)?;
            let transform = projects
                .latest_gcp_optimization_for_lineage(&lineage)
                .map_err(|error| worker_error("projectRead", &error.to_string()))?
                .map(|record| record.artifact.result.transform);
            outcome.prepared_splats = Some(
                tile_brush_ply(
                    &outcome.output_path,
                    &outcome.scratch_path.join("prepared-splats"),
                    transform,
                    &node.cancellation,
                )
                .map_err(map_splat_tiler_error)?,
            );
            projects
                .publish_brush_outcome(outcome, &lineage)
                .map_err(|error| worker_error("projectPublish", &error.to_string()))?;
        }
    }
    Ok(())
}

fn product_kind_name(configuration: &ProductRunConfiguration) -> &'static str {
    match configuration {
        ProductRunConfiguration::Depth { .. } => "depth",
        ProductRunConfiguration::Dense { .. } => "dense",
        ProductRunConfiguration::Dem { .. } => "dem",
        ProductRunConfiguration::Ortho { .. } => "ortho",
        ProductRunConfiguration::Mesh { .. } => "mesh",
        ProductRunConfiguration::Splat { .. } => "splat",
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchCheckpoint {
    schema_version: u32,
    plan_sha256: ObjectHash,
    steps_sha256: ObjectHash,
    input_sha256: ObjectHash,
    completed_steps: usize,
}

fn batch_steps_hash(
    steps: &[BatchPipelineStep],
    camera_entity_ids: &[String],
) -> anyhow::Result<ObjectHash> {
    Ok(ObjectHash::of_bytes(&serde_json::to_vec(&(
        steps,
        camera_entity_ids,
    ))?))
}

fn batch_input_hash(
    projects: &ProjectRuntime,
    context: &crate::project_runtime::ProjectComputeContext,
    camera_entity_ids: &[String],
    processing_set_id: Option<&EntityId>,
) -> anyhow::Result<ObjectHash> {
    let gcp_hash = projects.list_gcps()?.map(|(hash, _)| hash);
    let selected_camera_entity_ids = if camera_entity_ids.is_empty() {
        context
            .camera_images
            .iter()
            .map(|camera| camera.entity_id.0.clone())
            .collect::<Vec<_>>()
    } else {
        camera_entity_ids.to_vec()
    };
    let image_mask_scope =
        projects.image_mask_compute_scope(&selected_camera_entity_ids, processing_set_id)?;
    Ok(ObjectHash::of_bytes(&serde_json::to_vec(&(
        &context.manifest.project_id,
        &context.camera_images,
        gcp_hash,
        image_mask_scope.scope_sha256,
    ))?))
}

fn read_batch_checkpoint(
    path: &Path,
    plan_sha256: &ObjectHash,
    steps_sha256: &ObjectHash,
    input_sha256: &ObjectHash,
) -> anyhow::Result<usize> {
    if !path.is_file() {
        return Ok(0);
    }
    let value: BatchCheckpoint = serde_json::from_slice(&std::fs::read(path)?)?;
    if value.schema_version != 3
        || value.plan_sha256 != *plan_sha256
        || value.steps_sha256 != *steps_sha256
        || value.input_sha256 != *input_sha256
    {
        return Ok(0);
    }
    Ok(value.completed_steps)
}
fn write_batch_checkpoint(
    path: &Path,
    plan_sha256: &ObjectHash,
    steps_sha256: &ObjectHash,
    input_sha256: &ObjectHash,
    completed_steps: usize,
) -> anyhow::Result<()> {
    let value = BatchCheckpoint {
        schema_version: 3,
        plan_sha256: plan_sha256.clone(),
        steps_sha256: steps_sha256.clone(),
        input_sha256: input_sha256.clone(),
        completed_steps,
    };
    let temporary = path.with_extension("json.pending");
    std::fs::write(&temporary, serde_json::to_vec(&value)?)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

fn prepare_gcp_optimization_job(
    params: StartGcpOptimizationJobParams,
    projects: &ProjectRuntime,
) -> anyhow::Result<PreparedGcpOptimizationJob> {
    let context = projects.compute_context()?;
    let alignment =
        projects.latest_alignment_dataset_for_processing_set(params.processing_set_id.as_ref())?;
    let lineage = ProductLineage {
        source_alignment_entity_id: alignment.source_alignment_entity_id.clone(),
        processing_set_id: alignment.processing_set_id.clone(),
        gcp_optimization_entity_id: None,
        gcp_optimization_snapshot_sha256: None,
        image_mask_scope_sha256: alignment.image_mask_scope_sha256.clone(),
    };
    let alignment_dataset = alignment.root;
    let camera_root = context
        .working_path
        .join(".photolab/gcp-cameras")
        .join(&params.operation_id);
    let run_params = RunGcpOptimizationParams {
        operation_id: params.operation_id.clone(),
        snapshot_sha256: params.snapshot_sha256.clone(),
        cameras: Vec::new(),
        tie_points: Vec::new(),
        options: GcpSolverOptions::default(),
    };
    let input =
        serde_json::to_vec(&(&params.snapshot_sha256, alignment_dataset.to_string_lossy()))?;
    let job = NewPhotolabJob {
        id: PhotolabJobId(params.operation_id),
        kind: PhotolabJobKind::OptimizeAlignment,
        config_hash: ObjectHash::of_bytes(&serde_json::to_vec(&run_params.options)?),
        input_hash: ObjectHash::of_bytes(&input),
        progress: gcp_job_progress(
            himmelcad_core::photolab_gcp_optimization::GcpOptimizationProgress {
                phase: GcpOptimizationPhase::Validate,
                completed_units: 0,
                total_units: 1,
                iteration: None,
                objective: None,
            },
        ),
    };
    Ok((
        job,
        context.working_path,
        alignment_dataset,
        camera_root,
        development_colmap_executable()?,
        run_params,
        context.camera_images,
        projects.list_calibration_groups()?,
        lineage,
    ))
}

fn attach_camera_reference_priors(
    prepared: &mut [himmelcad_sidecar::mvs_scene::PreparedGcpCamera],
    camera_images: &[himmelcad_sidecar::image_commit::ProjectCameraImageRecord],
    alignment_dataset: &Path,
    calibration_groups: &[crate::project_runtime::CameraCalibrationGroupRecord],
) {
    let camera_map = std::fs::read(alignment_dataset.join("camera-map.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<MaterializedCameraMapEntry>>(&bytes).ok())
        .unwrap_or_default();
    let by_entity = camera_images
        .iter()
        .map(|camera| (camera.entity_id.0.as_str(), camera))
        .collect::<BTreeMap<_, _>>();
    for (fallback_index, entry) in prepared.iter_mut().enumerate() {
        let mapped = camera_map
            .iter()
            .find(|candidate| candidate.image_name == entry.image_name)
            .and_then(|candidate| by_entity.get(candidate.entity_id.as_str()).copied())
            .or_else(|| camera_images.get(fallback_index));
        let Some(camera) = mapped else {
            continue;
        };
        if let Some(group) = calibration_groups
            .iter()
            .find(|group| group.camera_entity_ids.contains(&camera.entity_id))
        {
            entry.camera.calibration_group_id = group.entity_id.0.clone();
            entry.camera.intrinsics_policy = group.intrinsics_policy;
        } else {
            entry.camera.calibration_group_id = format!("ungrouped:{}", camera.entity_id.0);
            entry.camera.intrinsics_policy =
                himmelcad_core::photolab_gcp_optimization::GcpIntrinsicsPolicy::Fixed;
        }
        let Some(reference) = camera.metadata.projected_reference.as_ref() else {
            continue;
        };
        let Some(height) = reference.transformed_height_meters else {
            continue;
        };
        let rtk = camera
            .metadata
            .inspected_photo
            .metadata
            .dji_xmp
            .rtk
            .as_ref();
        let rtk_fixed = camera
            .metadata
            .status_tags
            .contains(&himmelcad_core::photolab_products::ImageProductTag::RtkFixed);
        let horizontal_default = if rtk_fixed { 0.03 } else { 5.0 };
        let height_default = if rtk_fixed { 0.06 } else { 10.0 };
        let horizontal_floor = if rtk_fixed {
            MIN_FIXED_CAMERA_REFERENCE_HORIZONTAL_SIGMA_METERS
        } else {
            MIN_NON_FIXED_CAMERA_REFERENCE_HORIZONTAL_SIGMA_METERS
        };
        let height_floor = if rtk_fixed {
            MIN_FIXED_CAMERA_REFERENCE_HEIGHT_SIGMA_METERS
        } else {
            MIN_NON_FIXED_CAMERA_REFERENCE_HEIGHT_SIGMA_METERS
        };
        entry.camera.reference_center_world_meters =
            Some([reference.easting, reference.northing, height]);
        entry.camera.reference_stddev_meters = Some([
            rtk.and_then(|value| value.standard_deviation_longitude_meters)
                .unwrap_or(horizontal_default)
                .max(horizontal_floor),
            rtk.and_then(|value| value.standard_deviation_latitude_meters)
                .unwrap_or(horizontal_default)
                .max(horizontal_floor),
            rtk.and_then(|value| value.standard_deviation_height_meters)
                .unwrap_or(height_default)
                .max(height_floor),
        ]);
    }
}

fn gcp_job_progress(
    progress: himmelcad_core::photolab_gcp_optimization::GcpOptimizationProgress,
) -> JobProgress {
    let (index, kind, label) = match progress.phase {
        GcpOptimizationPhase::Validate => {
            (0, PhotolabStageKind::Preparing, "Validate GCP snapshot")
        }
        GcpOptimizationPhase::Triangulate => {
            (1, PhotolabStageKind::BundleAdjustment, "Triangulate GCPs")
        }
        GcpOptimizationPhase::Optimize => (
            2,
            PhotolabStageKind::BundleAdjustment,
            "Run robust alignment optimization",
        ),
        GcpOptimizationPhase::Residuals => {
            (3, PhotolabStageKind::Finalizing, "Calculate residuals")
        }
        GcpOptimizationPhase::Projections => {
            (4, PhotolabStageKind::Finalizing, "Update GCP projections")
        }
        GcpOptimizationPhase::Complete => {
            (5, PhotolabStageKind::Finalizing, "Publish optimization")
        }
    };
    JobProgress {
        stage: PhotolabStage {
            kind,
            index,
            stage_count: 6,
            label: label.into(),
        },
        metrics: ProgressMetrics {
            completed_units: u64::from(progress.completed_units),
            total_units: Some(u64::from(progress.total_units.max(1))),
            completed_bytes: 0,
            total_bytes: None,
        },
    }
}

fn map_gcp_optimization_error(
    error: GcpOptimizationRuntimeError,
) -> himmelcad_sidecar::job_runtime::JobWorkerError {
    if matches!(error, GcpOptimizationRuntimeError::Cancelled) {
        himmelcad_sidecar::job_runtime::JobWorkerError::Cancelled
    } else {
        himmelcad_sidecar::job_runtime::JobWorkerError::Failed {
            code: "gcpOptimization".into(),
            message: error.to_string(),
        }
    }
}

#[allow(clippy::type_complexity)] // Private orchestration state is consumed immediately by the job runner.
fn prepare_alignment_job(
    params: StartAlignmentJobParams,
    projects: &ProjectRuntime,
) -> anyhow::Result<(
    NewPhotolabJob,
    ColmapRunRequest,
    ColmapRuntime,
    Option<(DedodeRuntime, DedodeRunRequest)>,
    Option<EntityId>,
)> {
    let context = projects.compute_context()?;
    let processing_set_id = params.processing_set_id.clone();
    let requested_camera_ids = if let Some(entity_id) = processing_set_id.as_ref() {
        let processing_set = projects
            .list_processing_sets()?
            .into_iter()
            .find(|record| &record.entity_id == entity_id)
            .with_context(|| format!("unknown processing set {}", entity_id.0))?;
        let frozen = processing_set
            .camera_entity_ids
            .into_iter()
            .map(|id| id.0)
            .collect::<Vec<_>>();
        if !params.camera_entity_ids.is_empty() {
            let mut requested = params.camera_entity_ids.clone();
            requested.sort();
            anyhow::ensure!(
                requested == frozen,
                "alignment camera selection differs from its immutable processing set"
            );
        }
        frozen
    } else {
        params.camera_entity_ids.clone()
    };
    let camera_images = select_alignment_cameras(&context.camera_images, &requested_camera_ids)?;
    let camera_scope_ids = camera_images
        .iter()
        .map(|camera| camera.entity_id.0.clone())
        .collect::<Vec<_>>();
    let image_mask_scope =
        projects.image_mask_compute_scope(&camera_scope_ids, processing_set_id.as_ref())?;
    let image_count = u32::try_from(camera_images.len())
        .context("project image count exceeds supported alignment range")?;
    let resolved = resolve_alignment_profile(&ResolveAlignmentProfileRequest {
        profile: params.profile,
        image_count,
        max_image_edge_override: params.overrides.max_image_edge,
        keypoints_per_megapixel_override: params.overrides.keypoints_per_megapixel,
    })?;
    let feature_worker_threads = colmap_feature_worker_threads(resolved.max_image_edge);
    let feature_budget = params
        .overrides
        .feature_budget
        .map(|budget| budget.clamp(1_024, 64_000))
        .unwrap_or_else(|| alignment_feature_budget(params.profile, &resolved));
    let mut request = ColmapRunRequest {
        job_id: params.operation_id.clone(),
        project_root: context.working_path.clone(),
        camera_images: camera_images.clone(),
        image_mask_scope: Some(image_mask_scope.clone()),
        calibration_groups: Vec::new(),
        device: ColmapComputeDevice::Cpu,
        pair_selection: alignment_pair_selection(
            params.profile,
            params.overrides.sequential_overlap,
        ),
        mapping_store: alignment_primary_store(params.profile),
        aliked_variant: if params.profile == AlignmentQualityProfile::Fast {
            AlikedModelVariant::N16Rot
        } else {
            AlikedModelVariant::N32
        },
        large_matching_backend: match params.profile {
            AlignmentQualityProfile::Fast => LargeMatchingBackend::Disabled,
            AlignmentQualityProfile::QualityHybrid => LargeMatchingBackend::DedodeV2G {
                policy: DedodeV2GPolicy::Gated,
            },
            AlignmentQualityProfile::MaximumRobustness => LargeMatchingBackend::DedodeV2G {
                policy: DedodeV2GPolicy::AllPairs,
            },
        },
        aliked_max_features: feature_budget,
        sift_max_features: feature_budget,
        sift_rescue_only: params.profile == AlignmentQualityProfile::Fast,
        max_image_size: resolved.max_image_edge,
        feature_worker_threads,
        aliked_matching_worker_threads: colmap_aliked_matching_worker_threads(),
        matching_worker_threads: colmap_matching_worker_threads(),
        products: ColmapProductRequest::default(),
        intrinsics_refinement: ColmapIntrinsicsRefinement::Refine,
    };
    request.calibration_groups = projects.calibration_groups_for_camera_scope(
        &camera_images
            .iter()
            .map(|camera| camera.entity_id.0.clone())
            .collect::<Vec<_>>(),
    )?;
    request.intrinsics_refinement =
        alignment_intrinsics_refinement(params.profile, &request.calibration_groups);
    let input_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
        &context.manifest.project_id,
        &camera_images,
        &image_mask_scope.scope_sha256,
    ))?);
    let mut job = NewPhotolabJob {
        id: PhotolabJobId(params.operation_id),
        kind: PhotolabJobKind::AlignPhotos,
        config_hash: ObjectHash::of_bytes(&serde_json::to_vec(&(
            &resolved.config_hash,
            &request.calibration_groups,
        ))?),
        input_hash: input_hash.clone(),
        progress: request.progress_plan().initial_progress(),
    };
    let runtime = development_colmap_runtime(&context.working_path)?;
    let dedode = if params.profile == AlignmentQualityProfile::Fast {
        None
    } else {
        match development_dedode_runtime(&context.working_path) {
            Ok(runtime) => {
                let pairs = dedode_pair_graph(
                    &camera_images,
                    params.profile == AlignmentQualityProfile::MaximumRobustness,
                )?;
                Some((
                    runtime,
                    DedodeRunRequest {
                        job_id: format!("{}-dedode", request.job_id),
                        project_root: context.working_path,
                        camera_images: request.camera_images.clone(),
                        image_mask_scope: request.image_mask_scope.clone(),
                        pairs,
                        device: DedodeComputeDevice::Cpu,
                        max_keypoints: if params.profile
                            == AlignmentQualityProfile::MaximumRobustness
                        {
                            40_000
                        } else {
                            20_000
                        },
                        inference_width: if params.profile
                            == AlignmentQualityProfile::MaximumRobustness
                        {
                            1_176
                        } else {
                            784
                        },
                        inference_height: if params.profile
                            == AlignmentQualityProfile::MaximumRobustness
                        {
                            1_176
                        } else {
                            784
                        },
                        match_threshold: 0.01,
                        match_block_size: 1_024,
                        checkpoint_interval_pairs: 1,
                    },
                ))
            }
            Err(error) => {
                return Err(error.context(format!(
                    "{:?} requires the complete offline DeDoDe-v2-G runtime; quality is never silently reduced",
                    params.profile
                )));
            }
        }
    };
    job.config_hash = ObjectHash::of_bytes(&serde_json::to_vec(&request)?);
    job.progress = request.progress_plan().initial_progress();
    if dedode.is_some() {
        let colmap_stage_count = job.progress.stage.stage_count;
        job.progress = JobProgress {
            stage: PhotolabStage {
                kind: PhotolabStageKind::FeatureExtraction,
                index: 0,
                stage_count: colmap_stage_count.saturating_add(3),
                label: "DeDoDe-v2-G Features".into(),
            },
            metrics: ProgressMetrics::empty(),
        };
    }
    Ok((job, request, runtime, dedode, processing_set_id))
}

fn alignment_intrinsics_refinement(
    _profile: AlignmentQualityProfile,
    groups: &[ColmapCalibrationGroup],
) -> ColmapIntrinsicsRefinement {
    if groups.iter().any(|group| {
        group
            .seed
            .as_ref()
            .is_some_and(|seed| seed.full_brown_calibration.is_some())
    }) {
        // COLMAP exposes BA refinement as a run-wide policy. All profiles freeze
        // a run containing reliable embedded calibration: matching robustness is
        // profile-dependent, while calibrated focal/principal/distortion are not.
        return ColmapIntrinsicsRefinement::FreezeReliableEmbedded;
    }
    ColmapIntrinsicsRefinement::Refine
}

/// Stored-feature budget for ALIKED/SIFT extractors.
///
/// Uses `keypoints_per_megapixel * approx_resized_megapixels` from the resolved
/// profile, clamped per profile so Fast stays interactive. (Previously a fixed
/// constant ignored `keypoints_per_megapixel` entirely — dead knob.)
fn alignment_feature_budget(
    profile: AlignmentQualityProfile,
    resolved: &ResolvedAlignmentConfig,
) -> u32 {
    let edge = u64::from(resolved.max_image_edge.max(1));
    // Assume ~4:3 frame after long-edge resize.
    let approx_mp_x100 = edge.saturating_mul(edge).saturating_mul(3) / 4 / 10_000;
    let from_density =
        approx_mp_x100.saturating_mul(u64::from(resolved.keypoints_per_megapixel.max(1))) / 100;
    let (floor, ceil) = match profile {
        AlignmentQualityProfile::Fast => (2_048, 8_192),
        AlignmentQualityProfile::QualityHybrid => (8_192, 24_000),
        AlignmentQualityProfile::MaximumRobustness => (12_000, 48_000),
    };
    from_density.clamp(floor, ceil) as u32
}

fn alignment_pair_selection(
    profile: AlignmentQualityProfile,
    sequential_overlap_override: Option<u32>,
) -> ColmapPairSelection {
    let clamp_overlap = |default: u32| sequential_overlap_override.unwrap_or(default).clamp(2, 128);
    match profile {
        // 12 was too short for typical drone strip side-lap (neighbours in the next
        // line often sit >12 frames away in capture order). 20 keeps Fast cheap but
        // recovers most cross-strip pairs without exhaustive matching.
        AlignmentQualityProfile::Fast => ColmapPairSelection::Sequential {
            overlap: clamp_overlap(20),
        },
        // Both sparse backends still independently process every edge of the frozen candidate
        // graph. A bounded flight-sequence graph avoids quadratic LightGlue work here; the
        // exhaustive graph remains an explicit Maximum Robustness choice.
        AlignmentQualityProfile::QualityHybrid => ColmapPairSelection::Sequential {
            overlap: clamp_overlap(24),
        },
        AlignmentQualityProfile::MaximumRobustness => ColmapPairSelection::Exhaustive,
    }
}

const fn alignment_primary_store(profile: AlignmentQualityProfile) -> MappingFeatureStore {
    match profile {
        AlignmentQualityProfile::Fast => MappingFeatureStore::Sift,
        AlignmentQualityProfile::QualityHybrid | AlignmentQualityProfile::MaximumRobustness => {
            MappingFeatureStore::Aliked
        }
    }
}

#[allow(clippy::type_complexity)] // Private orchestration state is consumed immediately by the job runner.
fn prepare_alignment_merge_job(
    params: StartAlignmentMergeJobParams,
    projects: &ProjectRuntime,
) -> anyhow::Result<(
    NewPhotolabJob,
    ColmapRunRequest,
    ColmapRuntime,
    Option<(DedodeRuntime, DedodeRunRequest)>,
    EntityId,
    Option<ColmapRunOutcome>,
    Option<himmelcad_sidecar::alignment_merge_runtime::SharedControlMergeOutcome>,
    bool,
)> {
    let merge = projects.alignment_merge_compute_context(&params.merge_entity_id)?;
    let shared_control_only = merge.record.connections.iter().all(|connection| {
        matches!(
            connection,
            crate::project_runtime::AlignmentMergeConnection::SharedControls { .. }
        )
    });
    let camera_entity_ids = merge
        .record
        .camera_entity_ids
        .iter()
        .map(|id| id.0.clone())
        .collect::<Vec<_>>();
    let (mut job, mut request, runtime, dedode, _) = prepare_alignment_job(
        StartAlignmentJobParams {
            operation_id: params.operation_id,
            profile: if shared_control_only {
                AlignmentQualityProfile::Fast
            } else {
                params.profile
            },
            camera_entity_ids,
            processing_set_id: None,
            overrides: AlignmentJobOverrides::default(),
        },
        projects,
    )?;
    // A sequential graph ordered by import time can entirely miss a flight boundary. Merge
    // evidence must therefore be discovered by an exhaustive cross-run candidate graph.
    request.pair_selection = ColmapPairSelection::Exhaustive;
    request.calibration_groups = merge.calibration_groups;
    job.kind = PhotolabJobKind::MergeAlignments;
    if shared_control_only {
        job.progress = JobProgress {
            stage: PhotolabStage {
                kind: PhotolabStageKind::Preparing,
                index: 0,
                stage_count: 3,
                label: "Validate shared controls".into(),
            },
            metrics: ProgressMetrics::empty(),
        };
    }
    job.config_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
        &request,
        &merge.record.lineage_sha256,
    ))?);
    job.input_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
        &merge.record.entity_id,
        &merge.record.lineage_sha256,
        &merge.input_camera_scopes,
    ))?);
    let resumed = if shared_control_only {
        None
    } else {
        resume_solved_merge(
            &request.project_root,
            &request.job_id,
            &params.merge_entity_id,
            &job.input_hash,
            &job.config_hash,
        )?
    };
    let resumed_shared = if shared_control_only {
        resume_shared_control_merge(
            &request.project_root,
            &request.job_id,
            &params.merge_entity_id,
            &job.input_hash,
            &job.config_hash,
        )?
    } else {
        None
    };
    if resumed.is_none() && resumed_shared.is_none() {
        write_merge_checkpoint(
            &request.project_root,
            &AlignmentMergeCheckpoint {
                schema_version: 1,
                operation_id: request.job_id.clone(),
                merge_entity_id: params.merge_entity_id.clone(),
                input_hash: job.input_hash.clone(),
                config_hash: job.config_hash.clone(),
                state: AlignmentMergeCheckpointState::Running,
                scratch_relative_path: None,
                summary_sha256: None,
            },
        )?;
    }
    Ok((
        job,
        request,
        runtime,
        dedode,
        params.merge_entity_id,
        resumed,
        resumed_shared,
        shared_control_only,
    ))
}

fn prepare_image_quality_job(
    params: StartImageQualityJobParams,
    projects: &ProjectRuntime,
) -> anyhow::Result<(
    NewPhotolabJob,
    PathBuf,
    Vec<himmelcad_sidecar::image_commit::ProjectCameraImageRecord>,
    ImageQualityScope,
    ImageQualityConfiguration,
)> {
    anyhow::ensure!(
        !params.operation_id.trim().is_empty(),
        "image-quality operation id is empty"
    );
    let context = projects.compute_context()?;
    anyhow::ensure!(
        !context.camera_images.is_empty(),
        "image-quality analysis needs at least one imported image"
    );
    let (requested_ids, membership_sha256) = if let Some(processing_set_id) =
        &params.processing_set_id
    {
        let record = projects
            .list_processing_sets()?
            .into_iter()
            .find(|record| record.entity_id == *processing_set_id)
            .with_context(|| format!("processing set {} does not exist", processing_set_id.0))?;
        let member_ids = record
            .camera_entity_ids
            .iter()
            .map(|id| id.0.clone())
            .collect::<Vec<_>>();
        if !params.camera_entity_ids.is_empty() {
            let requested = params.camera_entity_ids.iter().collect::<BTreeSet<_>>();
            let members = member_ids.iter().collect::<BTreeSet<_>>();
            anyhow::ensure!(
                requested == members,
                "explicit image scope must exactly match the selected processing set"
            );
        }
        (member_ids, Some(record.membership_sha256))
    } else if params.camera_entity_ids.is_empty() {
        (
            context
                .camera_images
                .iter()
                .map(|camera| camera.entity_id.0.clone())
                .collect(),
            None,
        )
    } else {
        (params.camera_entity_ids, None)
    };
    let requested = requested_ids.iter().collect::<BTreeSet<_>>();
    anyhow::ensure!(
        requested.len() == requested_ids.len(),
        "image-quality camera scope contains duplicate ids"
    );
    let cameras = context
        .camera_images
        .iter()
        .filter(|camera| requested.contains(&camera.entity_id.0))
        .cloned()
        .collect::<Vec<_>>();
    anyhow::ensure!(
        cameras.len() == requested.len(),
        "image-quality camera scope references an unknown image"
    );
    anyhow::ensure!(!cameras.is_empty(), "image-quality camera scope is empty");
    let scope = ImageQualityScope {
        processing_set_id: params.processing_set_id,
        processing_set_membership_sha256: membership_sha256,
    };
    let configuration = ImageQualityConfiguration::default();
    configuration.validate().map_err(anyhow::Error::from)?;
    let config_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
        IMAGE_QUALITY_ALGORITHM_VERSION,
        &configuration,
    ))?);
    let input_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
        &context.manifest.project_id,
        cameras
            .iter()
            .map(|camera| (&camera.entity_id, &camera.metadata.source_object_hash))
            .collect::<Vec<_>>(),
        &scope,
    ))?);
    let total_units = u64::try_from(cameras.len()).unwrap_or(u64::MAX);
    let total_bytes = cameras.iter().fold(0_u64, |sum, camera| {
        sum.saturating_add(camera.metadata.inspected_photo.byte_size)
    });
    let job = NewPhotolabJob {
        id: PhotolabJobId(params.operation_id),
        kind: PhotolabJobKind::AnalyzeImageQuality,
        config_hash,
        input_hash,
        progress: JobProgress {
            stage: PhotolabStage {
                kind: PhotolabStageKind::ImageAnalysis,
                index: 0,
                stage_count: 1,
                label: "Analyze image quality".into(),
            },
            metrics: ProgressMetrics {
                completed_units: 0,
                total_units: Some(total_units),
                completed_bytes: 0,
                total_bytes: Some(total_bytes),
            },
        },
    };
    Ok((job, context.working_path, cameras, scope, configuration))
}

fn image_quality_worker_error(error: ImageQualityRuntimeError) -> JobWorkerError {
    match error {
        ImageQualityRuntimeError::Cancelled => JobWorkerError::Cancelled,
        other => JobWorkerError::Failed {
            code: "imageQuality".into(),
            message: other.to_string(),
        },
    }
}

fn select_alignment_cameras(
    cameras: &[himmelcad_sidecar::image_commit::ProjectCameraImageRecord],
    requested_ids: &[String],
) -> anyhow::Result<Vec<himmelcad_sidecar::image_commit::ProjectCameraImageRecord>> {
    if requested_ids.is_empty() {
        anyhow::ensure!(cameras.len() >= 2, "alignment needs at least two images");
        return Ok(cameras.to_vec());
    }
    let requested = requested_ids.iter().collect::<BTreeSet<_>>();
    anyhow::ensure!(
        requested.len() == requested_ids.len(),
        "alignment camera scope contains duplicate ids"
    );
    let selected = cameras
        .iter()
        .filter(|camera| requested.contains(&camera.entity_id.0))
        .cloned()
        .collect::<Vec<_>>();
    anyhow::ensure!(
        selected.len() == requested.len(),
        "alignment camera scope references an unknown image"
    );
    anyhow::ensure!(
        selected.len() >= 2,
        "alignment needs at least two selected images"
    );
    Ok(selected)
}

fn development_dedode_runtime(project_root: &Path) -> anyhow::Result<DedodeRuntime> {
    let workspace = discover_workspace_root()?;
    let configured_model_root = std::env::var_os("HIMMELCAD_DEDODE_ONNX_ROOT").map(PathBuf::from);
    let development_model_root = workspace.join("vendor/dedode/onnx");
    let development_python = if cfg!(windows) {
        workspace.join(".build/dedode-runtime/win32-x64/python/python.exe")
    } else {
        workspace.join(".build/dedode-runtime/linux-x64/python/bin/python3.12")
    };
    if configured_model_root.is_some()
        || (development_model_root.is_dir() && development_python.is_file())
    {
        let model_root = configured_model_root.unwrap_or(development_model_root);
        let worker_path = std::env::var_os("HIMMELCAD_DEDODE_WORKER")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                workspace.join("apps/photolab/workers/dedode/dedode_onnx_worker.py")
            });
        let python_executable = std::env::var_os("HIMMELCAD_DEDODE_PYTHON")
            .map(PathBuf::from)
            .unwrap_or(development_python);
        return DedodeRuntime::development_onnx_preflight(&DevDedodeOnnxRuntimeConfig {
            python_executable,
            worker_path,
            model_root,
            expected_python_version: std::env::var("HIMMELCAD_DEDODE_PYTHON_VERSION")
                .unwrap_or_else(|_| "3.12.13".into()),
            expected_onnxruntime_version: "1.24.4".into(),
            expected_numpy_version: "2.2.6".into(),
            expected_pillow_version: "11.3.0".into(),
            scratch_root: project_root.join(".photolab/scratch/dedode"),
            allowed_project_roots: vec![project_root.to_path_buf()],
        })
        .map_err(anyhow::Error::from);
    }
    let root = std::env::var_os("HIMMELCAD_DEDODE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace.join("vendor/dedode/dev"));
    let worker_path = std::env::var_os("HIMMELCAD_DEDODE_WORKER")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace.join("apps/photolab/workers/dedode/dedode_worker.py"));
    let python_executable = std::env::var_os("HIMMELCAD_DEDODE_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(windows) {
                root.join(".venv/Scripts/python.exe")
            } else {
                root.join(".venv/bin/python")
            }
        });
    DedodeRuntime::development_preflight(&DevDedodeRuntimeConfig {
        python_executable,
        worker_path,
        dedode_source_root: root.join("DeDoDe-6d156183f4dc84cd704ae779eebc8350995c5b06"),
        detector_v2_weights: root.join("models/dedode_detector_L_v2.pth"),
        descriptor_g_weights: root.join("models/dedode_descriptor_G.pth"),
        dinov2_vitl14_weights: root.join("models/dinov2_vitl14_pretrain.pth"),
        expected_python_version: "3.12.3".into(),
        expected_torch_version: "2.5.1+cpu".into(),
        expected_torchvision_version: "0.20.1+cpu".into(),
        scratch_root: project_root.join(".photolab/scratch/dedode"),
        allowed_project_roots: vec![project_root.to_path_buf()],
    })
    .map_err(anyhow::Error::from)
}

fn dedode_pair_graph(
    images: &[himmelcad_sidecar::image_commit::ProjectCameraImageRecord],
    exhaustive: bool,
) -> anyhow::Result<Vec<DedodeImagePair>> {
    anyhow::ensure!(
        images.len() >= 2,
        "at least two imported images are required"
    );
    let overlap = if exhaustive {
        images.len().saturating_sub(1)
    } else {
        12.min(images.len().saturating_sub(1))
    };
    let mut pairs = Vec::new();
    for left in 0..images.len() {
        let end = left
            .saturating_add(overlap)
            .saturating_add(1)
            .min(images.len());
        for right in left.saturating_add(1)..end {
            pairs.push(DedodeImagePair {
                image_a: images[left].entity_id.0.clone(),
                image_b: images[right].entity_id.0.clone(),
            });
        }
    }
    anyhow::ensure!(!pairs.is_empty(), "no DeDoDe image pairs were generated");
    Ok(pairs)
}

fn prepare_or_reuse_mvs_scene(
    prepared: &PreparedMvsProductJob,
    context: &JobWorkerContext,
) -> Result<PreparedMvsScene, JobWorkerError> {
    if let Some((manifest_path, manifest_sha256)) = &prepared.reusable_scene_manifest {
        context
            .progress
            .report_blocking(MvsRuntime::scene_preparation_progress(
                prepared.fuse_dense_point_cloud,
                1,
                1,
            ))
            .map_err(|error| worker_error("mvsSceneProgress", &error.to_string()))?;
        return load_prepared_mvs_scene(manifest_path, manifest_sha256, &context.cancellation)
            .map_err(|error| worker_error("mvsScenePreparation", &error.to_string()));
    }
    prepare_mvs_scene_with_masks_and_progress(
        &prepared.colmap_executable,
        &prepared.alignment_dataset,
        &prepared.scene_root,
        &prepared.coordinate_frame_id,
        prepared.settings.maximum_image_dimension,
        prepared.project_transform,
        prepared.optimized_cameras.as_deref(),
        &prepared.project_root,
        &prepared.image_mask_scope,
        prepared.camera_entity_ids.len(),
        &context.cancellation,
        |completed, total| {
            context
                .progress
                .report_blocking(MvsRuntime::scene_preparation_progress(
                    prepared.fuse_dense_point_cloud,
                    completed,
                    total,
                ))
                .map(|_| ())
                .map_err(|error| {
                    himmelcad_sidecar::mvs_scene::MvsSceneError::Progress(error.to_string())
                })
        },
    )
    .map_err(|error| {
        if matches!(
            error,
            himmelcad_sidecar::mvs_scene::MvsSceneError::Cancelled
        ) {
            JobWorkerError::Cancelled
        } else {
            worker_error("mvsScenePreparation", &error.to_string())
        }
    })
}

fn prepare_mvs_product_job(
    params: StartProductJobParams,
    projects: &ProjectRuntime,
    required_camera_scope: Option<&[String]>,
) -> anyhow::Result<PreparedMvsProductJob> {
    let context = projects.compute_context()?;
    anyhow::ensure!(
        context.camera_images.len() >= 3,
        "portable multi-view stereo needs at least three imported and aligned images"
    );
    let config_bytes = serde_json::to_vec(&params.configuration)?;
    let mut settings = MvsSettings::default();
    let source_maximum_dimension = context
        .camera_images
        .iter()
        .filter_map(|camera| camera.metadata.inspected_photo.metadata.exif.dimensions)
        .map(|dimensions| dimensions.width_pixels.max(dimensions.height_pixels))
        .max()
        // Missing dimensions are not permission to reduce quality. The image
        // decoder will still refuse to upscale, while this conservative bound
        // preserves the requested downscale semantics.
        .unwrap_or(12_800);
    let (kind, fuse_dense_point_cloud, reuse_compatible_maps) = match params.configuration {
        ProductRunConfiguration::Depth {
            image_downscale,
            filter,
            maximum_neighbors,
            reuse_compatible_maps,
        } => {
            anyhow::ensure!(
                [1, 2, 4, 8].contains(&image_downscale),
                "invalid image downscale"
            );
            settings.maximum_image_dimension =
                source_maximum_dimension.div_ceil(image_downscale).max(256);
            anyhow::ensure!(
                (2..=16).contains(&maximum_neighbors),
                "invalid maximum neighbors"
            );
            settings.matching_views = u8::try_from(maximum_neighbors)?;
            apply_mvs_depth_filter(&mut settings, &filter)?;
            (
                PhotolabJobKind::BuildDepthMaps,
                false,
                reuse_compatible_maps,
            )
        }
        ProductRunConfiguration::Dense {
            image_downscale,
            filter,
            maximum_neighbors,
            minimum_views,
            retain_confidence,
            calculate_colors,
        } => {
            anyhow::ensure!(
                [1, 2, 4, 8].contains(&image_downscale),
                "invalid image downscale"
            );
            anyhow::ensure!((2..=16).contains(&minimum_views), "invalid minimum views");
            anyhow::ensure!(
                (2..=16).contains(&maximum_neighbors) && minimum_views <= maximum_neighbors,
                "invalid maximum neighbors"
            );
            settings.maximum_image_dimension =
                source_maximum_dimension.div_ceil(image_downscale).max(256);
            apply_mvs_depth_filter(&mut settings, &filter)?;
            settings.matching_views = u8::try_from(maximum_neighbors)?;
            settings.minimum_consistent_views = u8::try_from(minimum_views)?;
            settings.retain_confidence_attribute = retain_confidence;
            settings.calculate_colors = calculate_colors;
            (PhotolabJobKind::BuildDensePointCloud, true, true)
        }
        _ => anyhow::bail!("portable MVS preparation needs a depth or dense configuration"),
    };
    let alignment = resolve_product_alignment(
        projects,
        params.processing_set_id.as_ref(),
        params.source_alignment_entity_id.as_ref(),
        required_camera_scope,
    )?;
    anyhow::ensure!(
        alignment.camera_entity_ids.len() >= 3,
        "portable multi-view stereo needs at least three cameras in the selected alignment"
    );
    let alignment_dataset = alignment.root.clone();
    let image_mask_scope = projects.image_mask_compute_scope(
        &alignment.camera_entity_ids,
        alignment.processing_set_id.as_ref(),
    )?;
    anyhow::ensure!(
        alignment.image_mask_scope_sha256 == image_mask_scope.scope_sha256,
        "image masks changed after the selected alignment; rerun alignment before building depth products"
    );
    let scene_parent = context.working_path.join(".photolab").join("mvs-scenes");
    std::fs::create_dir_all(&scene_parent)?;
    let scene_root = scene_parent.join(&params.operation_id);
    let executable = std::env::current_exe()?
        .parent()
        .context("sidecar executable has no parent")?
        .join(if cfg!(windows) {
            "himmelcad-portable-mvs.exe"
        } else {
            "himmelcad-portable-mvs"
        });
    let capabilities = BTreeSet::from([
        MvsCapability::CpuReference,
        MvsCapability::MultiScalePatchMatch,
        MvsCapability::GeometricConsistency,
        MvsCapability::DenseFusion,
        MvsCapability::OfflineOnly,
    ]);
    let published_mvs_root = context.working_path.join("datasets/mvs");
    std::fs::create_dir_all(&published_mvs_root)?;
    let runtime = MvsRuntime::development_preflight(&DevMvsRuntimeConfig {
        executable,
        version: "1.0.0".into(),
        capabilities,
        scratch_root: context.working_path.join(".photolab/scratch/mvs"),
        allowed_scene_roots: vec![scene_parent],
        allowed_resume_roots: vec![published_mvs_root],
    })?;
    let mut lineage = ProductLineage {
        source_alignment_entity_id: alignment.source_alignment_entity_id.clone(),
        processing_set_id: alignment.processing_set_id.clone(),
        gcp_optimization_entity_id: None,
        gcp_optimization_snapshot_sha256: None,
        image_mask_scope_sha256: alignment.image_mask_scope_sha256.clone(),
    };
    let gcp_optimization = pin_latest_product_gcp_optimization(projects, &mut lineage)?;
    let project_transform = gcp_optimization
        .as_ref()
        .map(|record| record.artifact.result.transform);
    let gcp_artifact_sha256 = gcp_optimization
        .as_ref()
        .map(|record| record.artifact_sha256.clone());
    let optimized_cameras = gcp_optimization.map(|record| record.artifact.result.cameras);
    let settings_sha256 = ObjectHash::of_bytes(&serde_json::to_vec(&settings)?);
    let reusable_scene_manifest = if reuse_compatible_maps {
        projects
            .latest_compatible_depth_mvs_dataset_for_lineage(
                &lineage,
                &settings_sha256,
                &image_mask_scope.scope_sha256,
            )?
            .map(|(_, record)| {
                (
                    context
                        .working_path
                        .join(".photolab/mvs-scenes")
                        .join(&record.job_id)
                        .join("scene.json"),
                    record.output.scene_manifest_sha256,
                )
            })
    } else {
        None
    };
    let planned_request = MvsRunRequest {
        job_id: params.operation_id.clone(),
        scene_manifest_path: scene_root.join("scene.json"),
        scene_manifest_sha256: ObjectHash::of_bytes(b"pending-scene"),
        device: MvsComputeDevice::Cpu {
            threads: portable_mvs_threads(),
        },
        settings: settings.clone(),
        fuse_dense_point_cloud,
        resume: None,
    };
    let mut input = alignment_dataset.to_string_lossy().as_bytes().to_vec();
    input.extend_from_slice(&config_bytes);
    input.extend_from_slice(&serde_json::to_vec(&(
        &alignment.source_alignment_entity_id,
        &alignment.processing_set_id,
        &gcp_artifact_sha256,
        &image_mask_scope.scope_sha256,
    ))?);
    let job = NewPhotolabJob {
        id: PhotolabJobId(params.operation_id.clone()),
        kind,
        config_hash: ObjectHash::of_bytes(&config_bytes),
        input_hash: ObjectHash::of_bytes(&input),
        progress: MvsRuntime::initial_progress(&planned_request),
    };
    Ok(PreparedMvsProductJob {
        job,
        runtime,
        operation_id: params.operation_id,
        project_root: context.working_path.clone(),
        alignment_dataset,
        scene_root,
        reusable_scene_manifest,
        colmap_executable: development_colmap_executable()?,
        coordinate_frame_id: context.manifest.project_id,
        settings,
        fuse_dense_point_cloud,
        reuse_compatible_maps,
        project_transform,
        optimized_cameras,
        camera_entity_ids: alignment.camera_entity_ids,
        image_mask_scope,
        lineage,
    })
}

fn apply_mvs_depth_filter(settings: &mut MvsSettings, filter: &str) -> anyhow::Result<()> {
    match filter {
        "mild" => {
            settings.minimum_confidence = 0.2;
            settings.geometric_relative_tolerance = 0.025;
            settings.minimum_consistent_views = 2;
        }
        "moderate" => {}
        "aggressive" => {
            settings.minimum_confidence = 0.5;
            settings.geometric_relative_tolerance = 0.006;
            settings.minimum_consistent_views = 4;
        }
        _ => anyhow::bail!("invalid depth filter"),
    }
    Ok(())
}

fn resolve_product_alignment(
    projects: &ProjectRuntime,
    processing_set_id: Option<&EntityId>,
    source_alignment_entity_id: Option<&EntityId>,
    required_camera_scope: Option<&[String]>,
) -> anyhow::Result<crate::project_runtime::PublishedAlignmentDataset> {
    anyhow::ensure!(
        processing_set_id.is_none() || required_camera_scope.is_none(),
        "a product cannot combine a processing set with a separate batch camera scope"
    );
    anyhow::ensure!(
        source_alignment_entity_id.is_none() || required_camera_scope.is_none(),
        "a batch camera scope cannot override an explicit source alignment"
    );
    if let Some(alignment_id) = source_alignment_entity_id {
        return projects.alignment_dataset_by_entity_id(alignment_id, processing_set_id);
    }
    if let Some(camera_scope) = required_camera_scope {
        let context = projects.compute_context()?;
        let selected = select_alignment_cameras(&context.camera_images, camera_scope)?;
        let exact_scope = selected
            .iter()
            .map(|camera| camera.entity_id.0.clone())
            .collect::<Vec<_>>();
        projects.latest_alignment_dataset_for_camera_scope(&exact_scope)
    } else {
        projects.latest_alignment_dataset_for_processing_set(processing_set_id)
    }
}

fn validated_product_gcp_optimization(
    record: Option<crate::project_runtime::GcpOptimizationPublicationRecord>,
) -> anyhow::Result<Option<crate::project_runtime::GcpOptimizationPublicationRecord>> {
    let Some(record) = record else {
        return Ok(None);
    };
    let result = &record.artifact.result;
    let control = result
        .statistics
        .control
        .as_ref()
        .context("GCP optimization has no control-point accuracy statistics")?;
    let minimum_controls = if matches!(
        result.effective_mode,
        himmelcad_core::photolab_gcp_optimization::GcpTransformMode::Similarity7
    ) {
        3
    } else {
        2
    };
    anyhow::ensure!(
        result.converged,
        "GCP optimization '{}' did not converge and cannot drive downstream products",
        record.operation_id
    );
    anyhow::ensure!(
        control.point_count >= minimum_controls,
        "GCP optimization '{}' has {} controls; {} are required for its transform mode",
        record.operation_id,
        control.point_count,
        minimum_controls
    );
    anyhow::ensure!(
        control.reprojection_rms_pixels.is_finite() && control.reprojection_rms_pixels <= 5.0,
        "GCP optimization '{}' has {:.3} px control reprojection RMS; resolve marker outliers before building downstream products",
        record.operation_id,
        control.reprojection_rms_pixels
    );
    Ok(Some(record))
}

fn pin_latest_product_gcp_optimization(
    projects: &ProjectRuntime,
    lineage: &mut ProductLineage,
) -> anyhow::Result<Option<crate::project_runtime::GcpOptimizationPublicationRecord>> {
    let Some(entry) = projects.latest_gcp_optimization_entry_for_lineage(lineage)? else {
        return Ok(None);
    };
    let entity_id = entry.entity_id;
    let record = validated_product_gcp_optimization(Some(entry.optimization))?
        .context("validated GCP optimization disappeared")?;
    lineage.gcp_optimization_entity_id = Some(entity_id);
    lineage.gcp_optimization_snapshot_sha256 = Some(record.snapshot_sha256.clone());
    Ok(Some(record))
}

fn portable_mvs_threads() -> u16 {
    probe_hardware()
        .map(|hardware| hardware.cpu.physical_cores.clamp(1, 32))
        .unwrap_or(1)
}

fn potree_converter_executable() -> Result<PathBuf, JobWorkerError> {
    let workspace = discover_workspace_root().map_err(worker_failed("potreeToolchain"))?;
    Ok(std::env::var_os("HIMMELCAD_POTREE_CONVERTER")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            workspace
                .join("vendor/potreeconverter")
                .join(platform_directory())
                .join(if cfg!(windows) {
                    "PotreeConverter.exe"
                } else {
                    "PotreeConverter"
                })
        }))
}

fn prepare_alignment_sparse_potree(
    outcome: &mut ColmapRunOutcome,
    context: &JobWorkerContext,
) -> Result<(), JobWorkerError> {
    let source = outcome
        .summary
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == ColmapArtifactKind::SparsePointCloud)
        .ok_or_else(|| worker_error("sparsePointCloud", "alignment has no sparse point source"))?;
    let mut prepared = prepare_sparse_potree(
        &outcome.scratch_path.join(&source.relative_path),
        &outcome.scratch_path.join("sparse-potree"),
        &potree_converter_executable()?,
        &context.cancellation,
    )
    .map_err(map_dense_prep_error)?;
    prepared.relative_metadata_path =
        PathBuf::from("sparse-potree").join(&prepared.relative_metadata_path);
    prepared.export_relative_path = prepared
        .export_relative_path
        .map(|path| PathBuf::from("sparse-potree").join(path));
    outcome.sparse_potree = Some(prepared);
    Ok(())
}

fn prepare_alignment_mesh(
    outcome: &mut ColmapRunOutcome,
    context: &JobWorkerContext,
) -> Result<(), JobWorkerError> {
    if let Some(source) = outcome
        .summary
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == ColmapArtifactKind::Mesh)
    {
        let relative_root = PathBuf::from("prepared-mesh");
        let prepared = build_prepared_triangle_mesh_from_ply(
            &outcome.scratch_path.join(&source.relative_path),
            &outcome.scratch_path.join(&relative_root),
            PreparedTriangleMeshOptions::default(),
            &context.cancellation,
        )
        .map_err(|error| worker_error("meshPreparation", &error.to_string()))?;
        outcome.prepared_mesh = Some(prefix_prepared_mesh_product(prepared, &relative_root));
    }
    if let Some(source) = outcome
        .summary
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == ColmapArtifactKind::TexturedMesh)
    {
        let relative_root = PathBuf::from("prepared-textured-mesh");
        let prepared = build_prepared_triangle_mesh_from_colmap_textured_directory(
            &outcome.scratch_path.join(&source.relative_path),
            &outcome.scratch_path.join(&relative_root),
            PreparedTriangleMeshOptions::default(),
            &context.cancellation,
        )
        .map_err(|error| worker_error("texturedMeshPreparation", &error.to_string()))?;
        outcome.prepared_textured_mesh =
            Some(prefix_prepared_mesh_product(prepared, &relative_root));
    }
    Ok(())
}

fn prefix_prepared_mesh_product(
    mut prepared: himmelcad_sidecar::mesh_tiler::PreparedMeshProduct,
    relative_root: &Path,
) -> himmelcad_sidecar::mesh_tiler::PreparedMeshProduct {
    prepared.manifest_relative_path = relative_root.join(prepared.manifest_relative_path);
    prepared.preparation_descriptor_relative_path = prepared
        .preparation_descriptor_relative_path
        .map(|path| relative_root.join(path));
    prepared.kernel_manifest_relative_path = prepared
        .kernel_manifest_relative_path
        .map(|path| relative_root.join(path));
    if let Some(topology) = prepared.section_topology.as_mut() {
        topology.manifest_relative_path = relative_root.join(&topology.manifest_relative_path);
    }
    prepared
}

async fn prepare_product_export_job(
    params: StartProductExportJobParams,
    projects: &ProjectRuntime,
    crs: &CrsService,
) -> anyhow::Result<(NewPhotolabJob, ProductExportRequest)> {
    let pointcloud_format = projects.pointcloud_export_format(&params.entity_id, params.format)?;
    let crs_wkt = if matches!(
        pointcloud_format,
        Some(PointCloudExportFormat::Las | PointCloudExportFormat::Laz)
    ) {
        if let Some(definition) = projects.frozen_horizontal_crs()? {
            Some(crs.canonical_wkt(&definition).await?)
        } else {
            None
        }
    } else {
        None
    };
    let source = projects.product_export_source_with_format(
        &params.entity_id,
        pointcloud_format,
        crs_wkt,
    )?;
    let metadata = source.source_path.metadata()?;
    let config_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
        &params.entity_id,
        &params.destination_path,
        &params.format,
    ))?);
    let input_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
        &source,
        metadata.len(),
        metadata.is_dir(),
    ))?);
    let request = ProductExportRequest {
        operation_id: params.operation_id.clone(),
        source,
        destination_path: PathBuf::from(params.destination_path),
    };
    Ok((
        NewPhotolabJob {
            id: PhotolabJobId(params.operation_id),
            kind: PhotolabJobKind::ExportProduct,
            config_hash,
            input_hash,
            progress: JobProgress {
                stage: PhotolabStage {
                    kind: PhotolabStageKind::Finalizing,
                    index: 0,
                    stage_count: 1,
                    label: "Export product atomically".into(),
                },
                metrics: ProgressMetrics::empty(),
            },
        },
        request,
    ))
}

fn prepare_raster_product_job(
    params: StartProductJobParams,
    projects: &ProjectRuntime,
    required_camera_scope: Option<&[String]>,
) -> anyhow::Result<PreparedRasterProductJob> {
    let context = projects.compute_context()?;
    let reference = context
        .manifest
        .reference_frame
        .as_ref()
        .context("DEM and orthomosaic need an explicit projected project reference frame")?;
    let horizontal_srs = crs_definition_text(&reference.target.horizontal.crs);
    let vertical_label = height_reference_text(&reference.target.vertical);
    let config_bytes = serde_json::to_vec(&params.configuration)?;
    let alignment = resolve_product_alignment(
        projects,
        params.processing_set_id.as_ref(),
        params.source_alignment_entity_id.as_ref(),
        required_camera_scope,
    )?;
    let mut lineage = ProductLineage {
        source_alignment_entity_id: alignment.source_alignment_entity_id.clone(),
        processing_set_id: alignment.processing_set_id.clone(),
        gcp_optimization_entity_id: None,
        gcp_optimization_snapshot_sha256: None,
        image_mask_scope_sha256: alignment.image_mask_scope_sha256.clone(),
    };
    let gcp_optimization = pin_latest_product_gcp_optimization(projects, &mut lineage)?;
    let (kind, dense_ply, dem_dataset, alignment_dataset, colmap_executable, input_evidence) =
        match params.configuration {
            ProductRunConfiguration::Dem { .. } => {
                let (dense_ply, dense_record) =
                    projects.latest_dense_mvs_dataset_for_lineage(&lineage)?;
                (
                    PhotolabJobKind::BuildDem,
                    Some(dense_ply),
                    None,
                    None,
                    None,
                    dense_record.output_index_sha256,
                )
            }
            ProductRunConfiguration::Ortho {
                ref source_dem_entity_id,
                ..
            } => {
                let (dem_root, dem_record) = if let Some(entity_id) = source_dem_entity_id {
                    projects.raster_dataset_by_entity_id(
                        entity_id,
                        PublishedRasterKind::Dem,
                        None,
                    )?
                } else {
                    projects
                        .latest_raster_dataset_for_lineage(PublishedRasterKind::Dem, &lineage)?
                };
                let dem_evidence = ObjectHash::of_bytes(&serde_json::to_vec(&dem_record)?);
                (
                    PhotolabJobKind::BuildOrthomosaic,
                    None,
                    Some((dem_root, dem_record)),
                    Some(alignment.root.clone()),
                    Some(development_colmap_executable()?),
                    dem_evidence,
                )
            }
            _ => anyhow::bail!("raster preparation needs a DEM or orthomosaic configuration"),
        };
    if let Some((_, dem_record)) = dem_dataset.as_ref() {
        anyhow::ensure!(
            dem_record.summary.crs.horizontal == horizontal_srs,
            "selected DEM horizontal CRS differs from the project"
        );
        anyhow::ensure!(
            dem_record.summary.crs.vertical == vertical_label,
            "selected DEM height reference differs from the project"
        );
    }
    let input_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
        input_evidence,
        &config_bytes,
        &lineage.source_alignment_entity_id,
        &lineage.processing_set_id,
        &lineage.image_mask_scope_sha256,
        gcp_optimization
            .as_ref()
            .map(|record| record.artifact_sha256.clone()),
    ))?);
    let job = NewPhotolabJob {
        id: PhotolabJobId(params.operation_id.clone()),
        kind,
        config_hash: ObjectHash::of_bytes(&config_bytes),
        input_hash: input_hash.clone(),
        progress: JobProgress {
            stage: PhotolabStage {
                kind: PhotolabStageKind::Preparing,
                index: 0,
                stage_count: if matches!(kind, PhotolabJobKind::BuildOrthomosaic) {
                    8
                } else {
                    7
                },
                label: if matches!(kind, PhotolabJobKind::BuildDem) {
                    "Prepare dense point cloud for DEM".into()
                } else {
                    "Prepare cameras and DEM for orthorectification".into()
                },
            },
            metrics: ProgressMetrics::empty(),
        },
    };
    Ok(PreparedRasterProductJob {
        job,
        operation_id: params.operation_id,
        configuration: params.configuration,
        project_root: context.working_path,
        dense_ply,
        dem_dataset,
        alignment_dataset,
        colmap_executable,
        coordinate_frame_id: context.manifest.project_id,
        project_transform: gcp_optimization
            .as_ref()
            .map(|record| record.artifact.result.transform),
        optimized_cameras: gcp_optimization.map(|record| record.artifact.result.cameras),
        input_hash,
        horizontal_srs,
        vertical_label,
        lineage,
    })
}

fn prepare_mesh_job(
    params: StartProductJobParams,
    projects: &ProjectRuntime,
    required_camera_scope: Option<&[String]>,
) -> anyhow::Result<PreparedMeshJob> {
    let ProductRunConfiguration::Mesh {
        target_face_count,
        interpolate_holes,
        build_texture,
        texture_size,
        source_dem_entity_id,
    } = params.configuration
    else {
        anyhow::bail!("mesh configuration required")
    };
    anyhow::ensure!(target_face_count >= 10_000, "invalid target face count");
    anyhow::ensure!(
        matches!(texture_size, 2048 | 4096 | 8192 | 16384),
        "invalid texture detail budget"
    );
    let context = projects.compute_context()?;
    let alignment = resolve_product_alignment(
        projects,
        params.processing_set_id.as_ref(),
        params.source_alignment_entity_id.as_ref(),
        required_camera_scope,
    )?;
    let mut lineage = ProductLineage {
        source_alignment_entity_id: alignment.source_alignment_entity_id,
        processing_set_id: alignment.processing_set_id,
        gcp_optimization_entity_id: None,
        gcp_optimization_snapshot_sha256: None,
        image_mask_scope_sha256: alignment.image_mask_scope_sha256,
    };
    pin_latest_product_gcp_optimization(projects, &mut lineage)?;
    let (dem_root, dem) = if let Some(entity_id) = source_dem_entity_id.as_ref() {
        projects.raster_dataset_by_entity_id(entity_id, PublishedRasterKind::Dem, None)?
    } else {
        projects.latest_raster_dataset_for_lineage(PublishedRasterKind::Dem, &lineage)?
    };
    let dem_evidence = ObjectHash::of_bytes(&serde_json::to_vec(&dem)?);
    let (texture_dataset_root, texture_summary) = if build_texture {
        let (ortho_root, ortho) = projects
            .latest_raster_dataset_for_lineage(PublishedRasterKind::Orthomosaic, &lineage)?;
        (Some(ortho_root), Some(ortho.summary))
    } else {
        (None, None)
    };
    let config_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
        target_face_count,
        interpolate_holes,
        build_texture,
        texture_size,
        &source_dem_entity_id,
    ))?);
    let input_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
        &dem_evidence,
        &texture_dataset_root,
        &lineage.source_alignment_entity_id,
        &lineage.processing_set_id,
        &lineage.image_mask_scope_sha256,
    ))?);
    let job = NewPhotolabJob {
        id: PhotolabJobId(params.operation_id.clone()),
        kind: PhotolabJobKind::BuildMesh,
        config_hash,
        input_hash,
        progress: JobProgress {
            stage: PhotolabStage {
                kind: PhotolabStageKind::Meshing,
                index: 0,
                stage_count: 2,
                label: "Prepare DEM tiles for mesh".into(),
            },
            metrics: ProgressMetrics::empty(),
        },
    };
    Ok(PreparedMeshJob {
        job,
        operation_id: params.operation_id,
        project_root: context.working_path,
        dem_root,
        dem_summary: dem.summary,
        texture_dataset_root,
        texture_summary,
        textured: build_texture,
        target_face_count,
        interpolate_holes,
        texture_size,
        lineage,
    })
}

fn run_mesh_job(
    prepared: PreparedMeshJob,
    context: &JobWorkerContext,
    publisher: &ProjectRuntime,
) -> Result<(), JobWorkerError> {
    let staging = prepared
        .project_root
        .join(".photolab/mesh-staging")
        .join(&prepared.operation_id);
    if let Some(parent) = staging.parent() {
        std::fs::create_dir_all(parent).map_err(|error| worker_error("io", &error.to_string()))?;
    }
    let result = build_tiled_dem_mesh(
        &prepared.dem_root,
        &prepared.dem_summary,
        &staging,
        prepared.texture_dataset_root.as_deref(),
        prepared.texture_summary.as_ref(),
        prepared.target_face_count,
        prepared.interpolate_holes,
        prepared.texture_size,
        &context.cancellation,
    )
    .map_err(map_mesh_tiler_error)?;
    context.check_cancelled()?;
    publisher
        .publish_mesh_product(
            &prepared.operation_id,
            &staging,
            result,
            prepared.textured,
            &prepared.lineage,
        )
        .map_err(|error| worker_error("projectPublish", &error.to_string()))?;
    Ok(())
}

fn run_raster_product(
    prepared: PreparedRasterProductJob,
    context: &JobWorkerContext,
    publisher: &ProjectRuntime,
) -> Result<(), JobWorkerError> {
    let tools = gdal_executables().map_err(worker_failed("gdalToolchain"))?;
    let input_root = prepared
        .project_root
        .join(".photolab/raster-inputs")
        .join(&prepared.operation_id);
    let (gsd, tile_size_pixels) = match &prepared.configuration {
        ProductRunConfiguration::Dem {
            resolution_meters_per_pixel,
            tile_size_pixels,
            ..
        }
        | ProductRunConfiguration::Ortho {
            resolution_meters_per_pixel,
            tile_size_pixels,
            ..
        } => (*resolution_meters_per_pixel, *tile_size_pixels),
        _ => {
            return Err(worker_error(
                "invalidRasterConfig",
                "unexpected raster configuration",
            ));
        }
    };
    if !gsd.is_finite() || gsd <= 0.0 || tile_size_pixels != 512 {
        return Err(worker_error(
            "invalidRasterConfig",
            "invalid GSD or tile size; raster streaming uses fixed 512-pixel tiles",
        ));
    }
    let (crs, grid, product) = match &prepared.configuration {
        ProductRunConfiguration::Dem {
            surface,
            interpolate_nodata,
            ..
        } => {
            let dense_ply = prepared.dense_ply.as_ref().ok_or_else(|| {
                worker_error("invalidRasterInput", "DEM has no dense point-cloud input")
            })?;
            let vector = prepare_dense_vector(
                dense_ply,
                &input_root,
                &tools.ogr2ogr,
                &prepared.horizontal_srs,
                &context.cancellation,
            )
            .map_err(map_dense_prep_error)?;
            let wkt = inspect_vector_wkt(&tools.ogrinfo, &vector, &context.cancellation)
                .map_err(map_dense_prep_error)?;
            let crs = RasterCrs {
                horizontal: prepared.horizontal_srs.clone(),
                vertical: prepared.vertical_label.clone(),
                gdal_srs: prepared.horizontal_srs.clone(),
                canonical_wkt_sha256: ObjectHash::of_bytes(wkt.as_bytes()),
            };
            let grid = aligned_raster_grid(vector.minimum, vector.maximum, gsd)
                .map_err(worker_failed("rasterGrid"))?;
            let surface = if surface.eq_ignore_ascii_case("dtm") {
                ElevationSurface::Dtm
            } else {
                ElevationSurface::Dsm
            };
            let interpolation = if surface == ElevationSurface::Dtm {
                ElevationInterpolation::Minimum {
                    radius: gsd * if *interpolate_nodata { 8.0 } else { 3.0 },
                    minimum_points: 1,
                }
            } else {
                ElevationInterpolation::Maximum {
                    radius: gsd * if *interpolate_nodata { 8.0 } else { 2.0 },
                    minimum_points: 1,
                }
            };
            let product = RasterProductRequest::Elevation(ElevationRasterRequest {
                surface,
                interpolation,
                view_range: ElevationViewRange {
                    minimum_elevation: vector.minimum[2],
                    maximum_elevation: vector.maximum[2].max(vector.minimum[2] + 0.001),
                },
                tiles: elevation_tiles(&grid, &crs, &vector),
            });
            (crs, grid, product)
        }
        ProductRunConfiguration::Ortho {
            blend_mode,
            color_correction,
            fill_holes,
            ..
        } => {
            let (dem_root, dem_record) = prepared.dem_dataset.as_ref().ok_or_else(|| {
                worker_error("invalidRasterInput", "orthomosaic has no DEM input")
            })?;
            let dem_summary = &dem_record.summary;
            let alignment = prepared.alignment_dataset.as_ref().ok_or_else(|| {
                worker_error("invalidRasterInput", "orthomosaic has no alignment input")
            })?;
            let colmap = prepared.colmap_executable.as_ref().ok_or_else(|| {
                worker_error("invalidRasterInput", "orthomosaic has no COLMAP runtime")
            })?;
            let scene_root = input_root.join("scene");
            let scene = prepare_mvs_scene(
                colmap,
                alignment,
                &scene_root,
                &prepared.coordinate_frame_id,
                8_000,
                prepared.project_transform,
                prepared.optimized_cameras.as_deref(),
                &context.cancellation,
            )
            .map_err(|error| {
                if matches!(
                    error,
                    himmelcad_sidecar::mvs_scene::MvsSceneError::Cancelled
                ) {
                    JobWorkerError::Cancelled
                } else {
                    worker_error("orthophotoScene", &error.to_string())
                }
            })?;
            let crs = dem_summary.crs.clone();
            let frozen_wkt = inspect_raster_wkt(
                &tools.gdalinfo,
                &dem_root.join("product.cog.tif"),
                &context.cancellation,
            )
            .map_err(map_dense_prep_error)?;
            if ObjectHash::of_bytes(frozen_wkt.as_bytes()) != crs.canonical_wkt_sha256 {
                return Err(worker_error(
                    "invalidRasterInput",
                    "DEM COG WKT differs from its frozen CRS contract",
                ));
            }
            let mut grid = aligned_raster_grid(
                [
                    dem_summary.grid.bounds.minimum_east,
                    dem_summary.grid.bounds.minimum_north,
                    0.0,
                ],
                [
                    dem_summary.grid.bounds.maximum_east,
                    dem_summary.grid.bounds.maximum_north,
                    0.0,
                ],
                gsd,
            )
            .map_err(worker_failed("rasterGrid"))?;
            grid.no_data = RasterNoDataValue::AlphaMask;
            let camera_blend = match blend_mode.as_str() {
                "average" => CameraBlendMode::WeightedAverage,
                "disabled" => CameraBlendMode::FirstCamera,
                _ => CameraBlendMode::BestCamera,
            };
            let progress_sink = context.progress.clone();
            let sources = prepare_camera_orthophotos(
                &OrthophotoPreparation {
                    scene_manifest_path: &scene.manifest_path,
                    dem_dataset_root: dem_root,
                    dem_summary,
                    output_root: &input_root.join("camera-ortho"),
                    gdal_translate: &tools.gdal_translate,
                    grid: &grid,
                    crs: &crs,
                    frozen_wkt: &frozen_wkt,
                    blend_mode: camera_blend,
                    color_correction: *color_correction,
                    fill_holes: *fill_holes,
                    cancellation: &context.cancellation,
                },
                |completed, total| {
                    let _ = progress_sink.report_blocking(JobProgress {
                        stage: PhotolabStage {
                            kind: PhotolabStageKind::Preparing,
                            index: 0,
                            stage_count: 8,
                            label: "Prepare cameras and DEM for orthorectification".into(),
                        },
                        metrics: ProgressMetrics {
                            completed_units: completed,
                            total_units: Some(total),
                            completed_bytes: 0,
                            total_bytes: None,
                        },
                    });
                },
            )
            .map_err(map_orthophoto_error)?;
            let product = RasterProductRequest::Orthomosaic(OrthomosaicRequest {
                sources,
                order: MosaicOrder::EarlierOnTop,
                resampling: RasterResampling::Bilinear,
                elevation_support: Box::new({
                    let source_surface = EntityVersionRef {
                        id: EntityId(format!(
                            "{}:raster:{}",
                            prepared.coordinate_frame_id, dem_record.job_id
                        )),
                        revision: 1,
                        version_hash: ObjectHash::of_bytes(
                            &serde_json::to_vec(dem_record)
                                .map_err(|error| worker_error("json", &error.to_string()))?,
                        ),
                    };
                    let derivation_bytes = serde_json::to_vec(&serde_json::json!({
                        "schemaId": "hcad.derivation.raster-surface-drape@1",
                        "sourceSurface": source_surface,
                        "orthomosaicJobId": prepared.operation_id,
                        "orthomosaicConfiguration": prepared.configuration,
                        "orthomosaicInputHash": prepared.input_hash,
                        "evaluator": {
                            "id": "hcad.bilinear-elevation-grid",
                            "version": 1,
                            "maximumSupportCellsPerAxis": 512,
                            "sharedBoundary": "repeatByteExact",
                        },
                    }))
                    .map_err(|error| worker_error("json", &error.to_string()))?;
                    OrthomosaicElevationSupport {
                        dataset_root: dem_root.to_string_lossy().into_owned(),
                        summary: dem_summary.clone(),
                        source_surface,
                        derivation: CanonicalResourceRef {
                            resource_id: format!(
                                "{}:raster-surface-drape:{}",
                                prepared.coordinate_frame_id, prepared.operation_id
                            ),
                            schema_id: "hcad.derivation.raster-surface-drape@1".into(),
                            content_hash: ObjectHash::of_bytes(&derivation_bytes),
                        },
                    }
                }),
            });
            (crs, grid, product)
        }
        _ => {
            return Err(worker_error(
                "invalidRasterConfig",
                "unexpected raster configuration",
            ));
        }
    };
    let config_hash = ObjectHash::of_bytes(
        &serde_json::to_vec(&prepared.configuration)
            .map_err(|error| worker_error("json", &error.to_string()))?,
    );
    let command = RasterBuildCommand {
        job_id: prepared.operation_id.clone(),
        config_hash,
        input_hash: prepared.input_hash,
        output_directory: prepared
            .project_root
            .join("datasets/raster")
            .join(&prepared.operation_id)
            .to_string_lossy()
            .into_owned(),
        crs,
        grid,
        product,
    };
    let runtime = open_raster_runtime(&prepared.project_root, &tools)
        .map_err(worker_failed("gdalToolchain"))?;
    let progress_sink = context.progress.clone();
    let orthomosaic = matches!(
        prepared.configuration,
        ProductRunConfiguration::Ortho { .. }
    );
    let stage_offset = u32::from(orthomosaic);
    let stage_count = 7 + stage_offset;
    let handle = tokio::runtime::Handle::current();
    let summary = handle
        .block_on(
            runtime.execute(&command, &context.cancellation, move |progress| {
                let sink = progress_sink.clone();
                tokio::spawn(async move {
                    let _ = sink
                        .report(raster_job_progress(progress, stage_offset, stage_count))
                        .await;
                });
            }),
        )
        .map_err(|error| {
            if matches!(
                error,
                himmelcad_sidecar::raster_runtime::RasterRuntimeError::Cancelled
            ) {
                JobWorkerError::Cancelled
            } else {
                worker_error("rasterRuntime", &error.to_string())
            }
        })?;
    context.check_cancelled()?;
    let kind = if matches!(prepared.configuration, ProductRunConfiguration::Dem { .. }) {
        PublishedRasterKind::Dem
    } else {
        PublishedRasterKind::Orthomosaic
    };
    publisher
        .publish_raster_summary(&prepared.operation_id, kind, summary, &prepared.lineage)
        .map_err(|error| worker_error("projectPublish", &error.to_string()))?;
    Ok(())
}

fn aligned_raster_grid(
    minimum: [f64; 3],
    maximum: [f64; 3],
    gsd: f64,
) -> anyhow::Result<RasterGrid> {
    let span = 512.0 * gsd;
    let minimum_east = (minimum[0] / span).floor() * span;
    let minimum_north = (minimum[1] / span).floor() * span;
    let columns = ((maximum[0] - minimum_east) / span).ceil().max(1.0);
    let rows = ((maximum[1] - minimum_north) / span).ceil().max(1.0);
    anyhow::ensure!(
        columns <= f64::from(u32::MAX / 512) && rows <= f64::from(u32::MAX / 512),
        "raster grid is too large"
    );
    let width_pixels = (columns as u32).saturating_mul(512);
    let height_pixels = (rows as u32).saturating_mul(512);
    Ok(RasterGrid {
        bounds: RasterBounds {
            minimum_east,
            minimum_north,
            maximum_east: minimum_east + f64::from(width_pixels) * gsd,
            maximum_north: minimum_north + f64::from(height_pixels) * gsd,
        },
        width_pixels,
        height_pixels,
        gsd,
        // DEM tiles are Float32; freeze the exactly representable sentinel.
        no_data: RasterNoDataValue::Numeric(f64::from(f32::MIN)),
    })
}

fn elevation_tiles(
    grid: &RasterGrid,
    crs: &RasterCrs,
    vector: &himmelcad_sidecar::dense_raster_prep::PreparedDenseVector,
) -> Vec<ElevationInputTile> {
    let columns = grid.width_pixels.div_ceil(512);
    let rows = grid.height_pixels.div_ceil(512);
    let span = grid.gsd * 512.0;
    let mut tiles = Vec::with_capacity((u64::from(columns) * u64::from(rows)) as usize);
    for row in 0..rows {
        for column in 0..columns {
            let minimum_east = grid.bounds.minimum_east + f64::from(column) * span;
            let maximum_north = grid.bounds.maximum_north - f64::from(row) * span;
            tiles.push(ElevationInputTile {
                tile_id: format!("{column}-{row}"),
                column,
                row,
                bounds: RasterBounds {
                    minimum_east,
                    minimum_north: maximum_north - span,
                    maximum_east: minimum_east + span,
                    maximum_north,
                },
                crs: crs.clone(),
                source: ElevationGeometrySource::Points {
                    path: vector.flatgeobuf_path.to_string_lossy().into_owned(),
                    layer: vector.layer.clone(),
                    elevation_field: "z".into(),
                    classification_field: None,
                    accepted_classifications: Vec::new(),
                },
            });
        }
    }
    tiles
}

#[derive(Debug)]
struct GdalExecutables {
    gdal_grid: PathBuf,
    gdal_rasterize: PathBuf,
    gdalwarp: PathBuf,
    gdalbuildvrt: PathBuf,
    gdal_translate: PathBuf,
    gdalinfo: PathBuf,
    ogrinfo: PathBuf,
    ogr2ogr: PathBuf,
    data: PathBuf,
    proj: PathBuf,
}

fn gdal_executables() -> anyhow::Result<GdalExecutables> {
    let root = std::env::var_os("HIMMELCAD_GDAL_ROOT").map(PathBuf::from);
    let tool = |name: &str| -> PathBuf {
        root.as_ref().map_or_else(
            || PathBuf::from(format!("/usr/bin/{name}")),
            |root| {
                root.join("bin").join(if cfg!(windows) {
                    format!("{name}.exe")
                } else {
                    name.into()
                })
            },
        )
    };
    let data = root.as_ref().map_or_else(
        || PathBuf::from("/usr/share/gdal"),
        |root| root.join("share/gdal"),
    );
    let proj = root.as_ref().map_or_else(
        || PathBuf::from("/usr/share/proj"),
        |root| root.join("share/proj"),
    );
    Ok(GdalExecutables {
        gdal_grid: tool("gdal_grid"),
        gdal_rasterize: tool("gdal_rasterize"),
        gdalwarp: tool("gdalwarp"),
        gdalbuildvrt: tool("gdalbuildvrt"),
        gdal_translate: tool("gdal_translate"),
        gdalinfo: tool("gdalinfo"),
        ogrinfo: tool("ogrinfo"),
        ogr2ogr: tool("ogr2ogr"),
        data,
        proj,
    })
}

fn open_raster_runtime(
    project_root: &Path,
    tools: &GdalExecutables,
) -> anyhow::Result<RasterRuntime> {
    let staging = project_root.join(".photolab/raster-staging");
    let output = project_root.join("datasets/raster");
    std::fs::create_dir_all(&staging)?;
    std::fs::create_dir_all(&output)?;
    let hardware = probe_hardware().ok();
    RasterRuntime::open(GdalToolchainConfig {
        gdal_grid_path: tools.gdal_grid.clone(),
        gdal_rasterize_path: tools.gdal_rasterize.clone(),
        gdalwarp_path: tools.gdalwarp.clone(),
        gdalbuildvrt_path: tools.gdalbuildvrt.clone(),
        gdal_translate_path: tools.gdal_translate.clone(),
        gdalinfo_path: tools.gdalinfo.clone(),
        ogrinfo_path: tools.ogrinfo.clone(),
        gdal_data_directory: tools.data.clone(),
        proj_data_directory: tools.proj.clone(),
        allowed_input_roots: vec![project_root.to_path_buf()],
        staging_root: staging,
        allowed_output_roots: vec![output],
        max_parallel_processes: hardware
            .as_ref()
            .map_or(1, |value| usize::from(value.cpu.physical_cores.clamp(1, 8))),
        threads_per_process: hardware.as_ref().map_or(1, |value| {
            usize::from(value.cpu.physical_cores.clamp(1, 16))
        }),
    })
    .map_err(anyhow::Error::from)
}

fn raster_job_progress(
    progress: RasterProgress,
    stage_offset: u32,
    stage_count: u32,
) -> JobProgress {
    let (index, kind) = match progress.phase {
        RasterPhase::Validating => (0, PhotolabStageKind::Preparing),
        RasterPhase::Rasterizing | RasterPhase::Orthorectifying => {
            (1, PhotolabStageKind::Rasterization)
        }
        RasterPhase::Mosaicking => (2, PhotolabStageKind::Rasterization),
        RasterPhase::BuildingPyramid => (3, PhotolabStageKind::Rasterization),
        RasterPhase::ExportingCog => (4, PhotolabStageKind::Rasterization),
        RasterPhase::ValidatingCog => (5, PhotolabStageKind::Finalizing),
        RasterPhase::Committing => (6, PhotolabStageKind::Finalizing),
    };
    JobProgress {
        stage: PhotolabStage {
            kind,
            index: index + stage_offset,
            stage_count,
            label: progress.current_step,
        },
        metrics: ProgressMetrics {
            completed_units: progress.completed_steps,
            total_units: Some(progress.total_steps.max(1)),
            completed_bytes: 0,
            total_bytes: None,
        },
    }
}

fn crs_definition_text(definition: &CrsDefinition) -> String {
    match definition {
        CrsDefinition::Epsg(code) => format!("EPSG:{code}"),
        CrsDefinition::Authority(value)
        | CrsDefinition::Wkt2(value)
        | CrsDefinition::ProjJson(value) => value.clone(),
    }
}

fn height_reference_text(reference: &HeightReference) -> Option<String> {
    match reference {
        HeightReference::Unknown => None,
        HeightReference::Ellipsoidal => Some("ellipsoidal".into()),
        HeightReference::Orthometric { vertical_crs } => {
            Some(format!("orthometric:{}", crs_definition_text(vertical_crs)))
        }
        HeightReference::NormalHeight { vertical_crs } => Some(format!(
            "normal-height:{}",
            crs_definition_text(vertical_crs)
        )),
        HeightReference::DeviceProfile { profile_id } => Some(format!("device:{profile_id}")),
    }
}

fn map_dense_prep_error(error: DenseRasterPrepError) -> JobWorkerError {
    if matches!(error, DenseRasterPrepError::Cancelled) {
        JobWorkerError::Cancelled
    } else {
        worker_error("denseRasterPreparation", &error.to_string())
    }
}

fn map_orthophoto_error(error: OrthophotoPreparationError) -> JobWorkerError {
    if matches!(error, OrthophotoPreparationError::Cancelled) {
        JobWorkerError::Cancelled
    } else {
        worker_error("cameraOrthophotoPreparation", &error.to_string())
    }
}

fn map_product_export_error(error: ProductExportError) -> JobWorkerError {
    if matches!(error, ProductExportError::Cancelled) {
        JobWorkerError::Cancelled
    } else {
        worker_error("productExport", &error.to_string())
    }
}

fn map_splat_tiler_error(error: SplatTilerError) -> JobWorkerError {
    if matches!(error, SplatTilerError::Cancelled) {
        JobWorkerError::Cancelled
    } else {
        worker_error("splatTiling", &error.to_string())
    }
}

fn map_mesh_tiler_error(error: MeshTilerError) -> JobWorkerError {
    if matches!(error, MeshTilerError::Cancelled) {
        JobWorkerError::Cancelled
    } else {
        worker_error("meshTiling", &error.to_string())
    }
}

fn worker_failed(code: &'static str) -> impl FnOnce(anyhow::Error) -> JobWorkerError {
    move |error| worker_error(code, &error.to_string())
}

fn worker_error(code: &str, message: &str) -> JobWorkerError {
    JobWorkerError::Failed {
        code: code.into(),
        message: message.into(),
    }
}

fn prepare_brush_product_job(
    params: StartProductJobParams,
    projects: &ProjectRuntime,
    required_camera_scope: Option<&[String]>,
) -> anyhow::Result<(
    NewPhotolabJob,
    BrushRunRequest,
    BrushRuntime,
    ProductLineage,
)> {
    let ProductRunConfiguration::Splat {
        initialization,
        iterations,
        spherical_harmonics_degree,
        maximum_splats,
        maximum_resolution,
        retain_training_checkpoints,
    } = params.configuration
    else {
        anyhow::bail!("Brush preparation requires a splat configuration");
    };
    anyhow::ensure!(
        initialization == "sparseTiePoints",
        "Gaussian Splat training currently requires calibrated sparse tie points"
    );
    let alignment = resolve_product_alignment(
        projects,
        params.processing_set_id.as_ref(),
        params.source_alignment_entity_id.as_ref(),
        required_camera_scope,
    )?;
    let project_root = projects.compute_context()?.working_path;
    let dataset_root = prepare_brush_scene(&alignment.root, &project_root, &params.operation_id)?;
    let mut lineage = ProductLineage {
        source_alignment_entity_id: alignment.source_alignment_entity_id,
        processing_set_id: alignment.processing_set_id,
        gcp_optimization_entity_id: None,
        gcp_optimization_snapshot_sha256: None,
        image_mask_scope_sha256: alignment.image_mask_scope_sha256,
    };
    pin_latest_product_gcp_optimization(projects, &mut lineage)?;
    let settings = BrushTrainingSettings {
        iterations,
        spherical_harmonics_degree,
        maximum_splats,
        maximum_resolution,
        seed: 42,
        checkpoint_every: iterations.min(5_000),
        retain_training_checkpoints,
    };
    let request = BrushRunRequest {
        job_id: params.operation_id.clone(),
        colmap_dataset_root: dataset_root.clone(),
        settings,
        resume: None,
    };
    let config_bytes = serde_json::to_vec(&request)?;
    let job = NewPhotolabJob {
        id: PhotolabJobId(params.operation_id),
        kind: PhotolabJobKind::BuildGaussianSplat,
        config_hash: ObjectHash::of_bytes(&config_bytes),
        input_hash: ObjectHash::of_bytes(&serde_json::to_vec(&(
            dataset_root.to_string_lossy(),
            &lineage.source_alignment_entity_id,
            &lineage.processing_set_id,
            &lineage.image_mask_scope_sha256,
        ))?),
        progress: request.progress_plan().initial_progress(),
    };
    let workspace = discover_workspace_root()?;
    let executable = std::env::var_os("HIMMELCAD_BRUSH_EXECUTABLE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            workspace
                .join("vendor")
                .join("brush")
                .join(platform_directory())
                .join(if cfg!(windows) {
                    "brush_app.exe"
                } else {
                    "brush_app"
                })
        });
    let runtime = BrushRuntime::development_preflight(&DevBrushRuntimeConfig {
        executable,
        scratch_root: project_root.join("tmp").join("brush"),
        allowed_dataset_roots: vec![project_root],
    })?;
    Ok((job, request, runtime, lineage))
}

fn prepare_brush_scene(
    alignment_root: &Path,
    project_root: &Path,
    operation_id: &str,
) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(
        !operation_id.is_empty()
            && operation_id.len() <= 96
            && operation_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
        "operation id must be a bounded portable path component"
    );
    let sparse = [
        alignment_root.join("sparse-aligned"),
        alignment_root.join("sparse-selected/0"),
        alignment_root.join("sparse-global/0"),
        alignment_root.join("sparse-incremental/0"),
    ]
    .into_iter()
    .find(|path| path.join("cameras.bin").is_file() && path.join("images.bin").is_file())
    .context("published alignment has no Brush-compatible sparse model")?;
    let images = alignment_root.join("images");
    anyhow::ensure!(
        images.is_dir(),
        "published alignment has no training images"
    );
    let scene = project_root
        .join(".photolab/brush-scenes")
        .join(operation_id);
    if scene.exists() {
        std::fs::remove_dir_all(&scene)?;
    }
    std::fs::create_dir_all(scene.join("sparse/0"))?;
    materialize_regular_tree(&sparse, &scene.join("sparse/0"))?;
    materialize_regular_tree(&images, &scene.join("images"))?;
    Ok(scene)
}

fn materialize_regular_tree(source: &Path, destination: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let metadata = std::fs::symlink_metadata(entry.path())?;
        anyhow::ensure!(
            !metadata.file_type().is_symlink(),
            "Brush source contains a symbolic link: {}",
            entry.path().display()
        );
        let target = destination.join(entry.file_name());
        if metadata.is_dir() {
            materialize_regular_tree(&entry.path(), &target)?;
        } else if metadata.is_file() && std::fs::hard_link(entry.path(), &target).is_err() {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn development_colmap_runtime(project_root: &Path) -> anyhow::Result<ColmapRuntime> {
    let workspace = discover_workspace_root()?;
    let executable = development_colmap_executable()?;
    let model_root = std::env::var_os("HIMMELCAD_COLMAP_MODEL_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            workspace
                .join("vendor")
                .join("photolab-models")
                .join("colmap-4.1.0")
        });
    let resources = BTreeMap::from([
        (
            ColmapResourceKind::AlikedN16RotModel,
            model_root.join("aliked-n16rot.onnx"),
        ),
        (
            ColmapResourceKind::AlikedN32Model,
            model_root.join("aliked-n32.onnx"),
        ),
        (
            ColmapResourceKind::AlikedLightGlueModel,
            model_root.join("aliked-lightglue.onnx"),
        ),
        (
            ColmapResourceKind::SiftLightGlueModel,
            model_root.join("sift-lightglue.onnx"),
        ),
    ]);
    ColmapRuntime::development_preflight(&DevColmapRuntimeConfig {
        executable,
        version: "4.1.0".into(),
        resources,
        scratch_root: project_root.join("tmp").join("colmap"),
        allowed_project_roots: vec![project_root.to_path_buf()],
    })
    .map_err(anyhow::Error::from)
}

fn development_colmap_executable() -> anyhow::Result<PathBuf> {
    let workspace = discover_workspace_root()?;
    Ok(std::env::var_os("HIMMELCAD_COLMAP_EXECUTABLE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            workspace
                .join("vendor")
                .join("colmap")
                .join(platform_directory())
                .join("bin")
                .join(if cfg!(windows) {
                    "colmap.exe"
                } else {
                    "colmap"
                })
        }))
}

fn discover_workspace_root() -> anyhow::Result<PathBuf> {
    if let Some(root) = std::env::var_os("HIMMELCAD_WORKSPACE_ROOT") {
        return Ok(PathBuf::from(root));
    }
    let executable = std::env::current_exe()?;
    for ancestor in executable
        .ancestors()
        .chain(std::env::current_dir()?.ancestors())
    {
        if ancestor.join("pnpm-workspace.yaml").is_file() && ancestor.join("Cargo.toml").is_file() {
            return Ok(ancestor.to_path_buf());
        }
    }
    anyhow::bail!("HimmelCAD workspace root could not be discovered")
}

const fn platform_directory() -> &'static str {
    if cfg!(windows) {
        "win32-x64"
    } else {
        "linux-x64"
    }
}

fn default_job_manager_config() -> JobManagerConfig {
    let logical_cpus = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
    let max_concurrency = probe_hardware().map_or(1, |hardware| {
        adaptive_job_concurrency(
            logical_cpus,
            usize::from(hardware.cpu.physical_cores),
            hardware.ram_bytes,
        )
    });
    JobManagerConfig {
        max_concurrency,
        max_queued: 64,
    }
}

fn adaptive_job_concurrency(logical_cpus: usize, physical_cpus: usize, ram_bytes: u64) -> usize {
    const GIB: u64 = 1024 * 1024 * 1024;
    const RESERVED_FOR_OS_AND_UI: u64 = 4 * GIB;
    const RESERVED_PER_COMPUTE_JOB: u64 = 12 * GIB;
    let cpu_slots = physical_cpus.max(1).min(logical_cpus.max(1)).div_ceil(2);
    let memory_slots = ram_bytes
        .saturating_sub(RESERVED_FOR_OS_AND_UI)
        .checked_div(RESERVED_PER_COMPUTE_JOB)
        .unwrap_or(0)
        .max(1);
    cpu_slots
        .min(usize::try_from(memory_slots).unwrap_or(usize::MAX))
        .clamp(1, 8)
}

fn colmap_feature_worker_threads(max_image_edge: u32) -> u16 {
    const GIB: u64 = 1024 * 1024 * 1024;
    const BYTES_PER_NEURAL_PIXEL: u64 = 160;
    let logical = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
    let ram_bytes = probe_hardware().map_or(8 * GIB, |hardware| hardware.ram_bytes);
    let pixels = u64::from(max_image_edge).saturating_mul(u64::from(max_image_edge));
    let bytes_per_worker = pixels.saturating_mul(BYTES_PER_NEURAL_PIXEL).max(GIB / 2);
    let memory_workers = (ram_bytes / 2)
        .checked_div(bytes_per_worker)
        .unwrap_or(0)
        .max(1);
    u16::try_from(logical.min(usize::try_from(memory_workers).unwrap_or(usize::MAX)))
        .unwrap_or(u16::MAX)
        .max(1)
}

fn colmap_matching_worker_threads() -> u16 {
    const GIB: u64 = 1024 * 1024 * 1024;
    // Native SIFT brute-force matching keeps compact descriptor blocks per worker.  Treating
    // every worker like a neural matcher previously reserved 8 GiB and forced this 31 GiB,
    // four-core workstation down to one thread.  The measured resident set for the real
    // Sulzberg workload is below 256 MiB for one worker; a conservative 2 GiB allowance keeps
    // enough headroom for COLMAP, the renderer and the OS while using all physical cores.
    const RESERVED_PER_SIFT_WORKER: u64 = 2 * GIB;
    probe_hardware()
        .map(|hardware| {
            let memory_workers = (hardware.ram_bytes / 2 / RESERVED_PER_SIFT_WORKER).max(1);
            u16::try_from(
                usize::from(hardware.cpu.physical_cores)
                    .min(usize::try_from(memory_workers).unwrap_or(usize::MAX)),
            )
            .unwrap_or(u16::MAX)
            .max(1)
        })
        .unwrap_or(1)
}

fn colmap_aliked_matching_worker_threads() -> u16 {
    const GIB: u64 = 1024 * 1024 * 1024;
    probe_hardware()
        .map(|hardware| {
            let memory_workers = (hardware.ram_bytes / 2 / (3 * GIB)).max(1);
            u16::try_from(
                usize::from(hardware.cpu.physical_cores)
                    .min(usize::try_from(memory_workers).unwrap_or(usize::MAX)),
            )
            .unwrap_or(u16::MAX)
            .max(1)
        })
        .unwrap_or(1)
}

fn default_crs_service() -> anyhow::Result<CrsService> {
    let configured_root = std::env::var_os("HIMMELCAD_PROJ_ROOT").map(PathBuf::from);
    let bundled_root = std::env::current_exe()?
        .parent()
        .map(|parent| parent.join("workers").join("proj"))
        .filter(|path| path.is_dir());
    let mut config = if let Some(root) = configured_root.or(bundled_root) {
        let executable_suffix = if cfg!(windows) { ".exe" } else { "" };
        ProjToolchainConfig::system(
            root.join("bin")
                .join(format!("projinfo{executable_suffix}")),
            root.join("bin").join(format!("cct{executable_suffix}")),
            root.join("share").join("proj"),
        )
    } else if cfg!(windows) {
        anyhow::bail!("offline PROJ worker is missing; set HIMMELCAD_PROJ_ROOT")
    } else {
        ProjToolchainConfig::system("/usr/bin/projinfo", "/usr/bin/cct", "/usr/share/proj")
    };
    if let Ok(workspace) = discover_workspace_root() {
        let grid_root = workspace.join("vendor").join("proj-data");
        if grid_root.is_dir() {
            config.allowed_grid_roots.push(grid_root);
        }
    }
    if let Some(user_grid_root) = std::env::var_os("HIMMELCAD_USER_PROJ_GRID_ROOT") {
        let user_grid_root = PathBuf::from(user_grid_root);
        if user_grid_root.is_dir() {
            config.allowed_grid_roots.push(user_grid_root);
        }
    }
    Ok(CrsService::new(ProjRuntime::open(config)?))
}

async fn rpc_blocking_with_params<P, T, F>(
    id: serde_json::Value,
    params: serde_json::Value,
    operation: F,
) -> RpcResponse
where
    P: for<'de> Deserialize<'de> + Send + 'static,
    T: Serialize + Send + 'static,
    F: FnOnce(P) -> anyhow::Result<T> + Send + 'static,
{
    match serde_json::from_value::<P>(params) {
        Ok(params) => {
            let result = tokio::task::spawn_blocking(move || operation(params))
                .await
                .map_err(anyhow::Error::from)
                .and_then(std::convert::identity);
            rpc_result(id, result)
        }
        Err(error) => rpc_err(id, -32602, &format!("invalid params: {error}")),
    }
}

async fn rpc_blocking<T, F>(id: serde_json::Value, operation: F) -> RpcResponse
where
    T: Serialize + Send + 'static,
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
{
    let result = tokio::task::spawn_blocking(operation)
        .await
        .map_err(anyhow::Error::from)
        .and_then(std::convert::identity);
    rpc_result(id, result)
}

fn rpc_result<T: Serialize>(id: serde_json::Value, result: anyhow::Result<T>) -> RpcResponse {
    match result {
        Ok(value) => match serde_json::to_value(value) {
            Ok(value) => RpcResponse {
                jsonrpc: "2.0",
                id,
                result: Some(value),
                error: None,
            },
            Err(error) => rpc_err(id, -32603, &format!("failed to encode result: {error}")),
        },
        Err(error) => rpc_err(id, -32000, &error.to_string()),
    }
}

fn handle_import_ifc(params: ImportIfcParams) -> anyhow::Result<(CanonicalStagedImport, String)> {
    let source = PathBuf::from(params.path);
    anyhow::ensure!(
        source.is_file(),
        "IFC source does not exist: {}",
        source.display()
    );
    anyhow::ensure!(
        !params.import_namespace.trim().is_empty(),
        "IFC import namespace is empty"
    );
    let mut prefix = vec![0_u8; 128 * 1024];
    let mut source_file = std::fs::File::open(&source)
        .with_context(|| format!("failed to read IFC source {}", source.display()))?;
    let prefix_length = source_file.read(&mut prefix)?;
    let prefix = String::from_utf8_lossy(&prefix[..prefix_length]).to_ascii_uppercase();
    let format_id = if prefix.contains("IFC4X3") {
        IFC4X3_FORMAT_ID
    } else if prefix.contains("IFC2X3") {
        IFC2X3_FORMAT_ID
    } else {
        IFC4_FORMAT_ID
    };
    let cache_dir = params.cache_dir.map_or_else(
        || {
            std::env::temp_dir()
                .join("himmelcad-cache")
                .join("canonical")
        },
        PathBuf::from,
    );
    std::fs::create_dir_all(&cache_dir)?;
    let mut hasher = Sha256::new();
    let mut hash_file = std::fs::File::open(&source)?;
    let mut hash_buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = hash_file.read(&mut hash_buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&hash_buffer[..count]);
    }
    let source_hash = hex::encode(hasher.finalize());
    let package_path = cache_dir
        .join("ifc-packages")
        .join(format!("{source_hash}.json"));
    let provider = IfcCanonicalProvider::new(cache_dir.clone());
    let command_id = format!("ifc-import-{source_hash}-{}", unix_timestamp_millis());
    if package_path.is_file() {
        let package = serde_json::from_slice::<himmelcad_io::CanonicalImportPackage>(
            &std::fs::read(&package_path)?,
        )?;
        let roots = provider.staged_artifact_roots(&package)?;
        return Ok((CanonicalStagedImport { package, roots }, command_id));
    }
    let options = serde_json::json!({
        "acceptedLossCodes": ["hcad.loss.ifc.unsupported-geometry@1"],
        "importNamespace": params.import_namespace,
    });
    let mut context = LoggingProviderContext;
    let package = provider
        .import(
            CanonicalImportRequest {
                source: &source,
                format_id,
                options: &options,
            },
            &mut context,
        )
        .map_err(anyhow::Error::from)?;
    if let Some(parent) = package_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = package_path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec(&package)?)?;
    std::fs::rename(temporary, package_path)?;
    let roots = provider.staged_artifact_roots(&package)?;
    Ok((CanonicalStagedImport { package, roots }, command_id))
}

async fn handle_import_las(
    params: ImportLasParams,
    operations: Arc<LasImportOperations>,
    canonical_app: Arc<Mutex<CanonicalAppRuntime>>,
) -> anyhow::Result<serde_json::Value> {
    if params.paths.is_empty() {
        anyhow::bail!("paths is empty");
    }
    let cache_dir = params.cache_dir.map_or_else(
        || std::env::temp_dir().join("himmelcad-cache"),
        PathBuf::from,
    );
    std::fs::create_dir_all(&cache_dir)?;

    // Spawn each import on a blocking thread so heavy file reads don't stall
    // the JSON-RPC dispatch loop.
    let mut summaries = Vec::with_capacity(params.paths.len());
    let mut combined_package: Option<himmelcad_io::CanonicalImportPackage> = None;
    let mut staged_roots = StagedArtifactRoots::default();
    let progress_key = params.progress_key.clone();
    let operation_id = params
        .operation_id
        .clone()
        .or_else(|| progress_key.clone())
        .unwrap_or_else(|| format!("las-import-{}", unix_timestamp_millis()));
    let active_operation = operations.begin(operation_id.clone())?;
    emit_progress(
        progress_key.as_deref(),
        0.01,
        &format!("Preparing {} LAS/LAZ file(s)", params.paths.len()),
    );

    let total = params.paths.len();
    for (index, raw) in params.paths.into_iter().enumerate() {
        let path = PathBuf::from(&raw);
        if !Path::new(&path).exists() {
            anyhow::bail!("file not found: {raw}");
        }
        let cache_dir_clone = cache_dir.clone();
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&raw)
            .to_string();
        let progress_key_for_file = progress_key.clone();
        let cancellation = Arc::clone(&active_operation.cancellation);
        let summary = tokio::task::spawn_blocking(move || {
            let progress_key_for_callback = progress_key_for_file.clone();
            let file_name_for_callback = file_name.clone();
            import_las_file_with_progress_and_cancel(
                &path,
                &cache_dir_clone,
                move |p| {
                    emit_import_progress(
                        progress_key_for_callback.as_deref(),
                        index,
                        total,
                        &file_name_for_callback,
                        &p,
                    );
                },
                move || cancellation.load(Ordering::Acquire),
            )
        })
        .await??;
        tracing::info!(
            path = %summary.source_path,
            loaded = summary.point_count_loaded,
            total = summary.point_count_total,
            "import.las completed"
        );
        let package = summary.canonical_import_package()?;
        staged_roots.dataset_roots.insert(
            summary.dataset_id.clone(),
            PathBuf::from(&summary.potree_dir),
        );
        if let Some(combined) = combined_package.as_mut() {
            combined.admissions.extend(package.admissions);
            for object in package.objects {
                if !combined
                    .objects
                    .iter()
                    .any(|existing| existing.object_hash == object.object_hash)
                {
                    combined.objects.push(object);
                }
            }
            combined.datasets.extend(package.datasets);
            combined.resource_sets.extend(package.resource_sets);
        } else {
            combined_package = Some(package);
        }
        summaries.push(summary);
    }
    let staged = CanonicalStagedImport {
        package: combined_package.context("LAS import produced no canonical package")?,
        roots: staged_roots,
    };
    if active_operation.cancellation.load(Ordering::Acquire) {
        anyhow::bail!("LAS import was cancelled before canonical publication");
    }
    let commit = canonical_app
        .lock()
        .expect("canonical app runtime mutex poisoned")
        .publish_staged_import(&staged, &operation_id)?;
    emit_progress(
        progress_key.as_deref(),
        0.85,
        &format!("Conversion finished for {total} LAS/LAZ file(s)"),
    );
    Ok(serde_json::json!({
        "operationId": operation_id,
        "imports": summaries,
        "journalEntry": commit.journal_entry,
    }))
}

fn unix_timestamp_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}

fn emit_import_progress(
    progress_key: Option<&str>,
    file_index: usize,
    file_total: usize,
    file_name: &str,
    progress: &ConverterProgress,
) {
    let local = f64::from(progress.fraction.unwrap_or(0.0).clamp(0.0, 1.0));
    let total = u32::try_from(file_total.max(1)).unwrap_or(u32::MAX);
    let index = u32::try_from(file_index).unwrap_or(u32::MAX);
    let conversion_fraction = (f64::from(index) + local) / f64::from(total);
    let overall = 0.02 + 0.83 * conversion_fraction;
    let message = format!(
        "Converting {} ({}/{}): {}",
        file_name,
        file_index + 1,
        file_total,
        progress.message
    );
    emit_progress(progress_key, overall, &message);
}

fn emit_progress(progress_key: Option<&str>, fraction: f64, message: &str) {
    let Some(progress_key) = progress_key else {
        return;
    };
    let payload = serde_json::json!({
        "progressKey": progress_key,
        "fraction": fraction.clamp(0.0, 1.0),
        "message": message,
    });
    eprintln!("{PROGRESS_PREFIX}{payload}");
}

#[allow(clippy::cast_precision_loss)]
fn emit_canonical_import_progress(progress_key: &str, progress: CanonicalImportProgress) {
    let local_fraction = if progress.total_bytes == 0 {
        1.0
    } else {
        progress.completed_bytes as f64 / progress.total_bytes as f64
    }
    .clamp(0.0, 1.0);
    let (overall_fraction, phase) = match progress.phase {
        CanonicalImportProgressPhase::Staging => (0.70 + local_fraction * 0.10, "Staging"),
        CanonicalImportProgressPhase::Publishing => (0.80 + local_fraction * 0.19, "Publishing"),
    };
    let completed_gib = progress.completed_bytes as f64 / 1_073_741_824.0;
    let total_gib = progress.total_bytes as f64 / 1_073_741_824.0;
    emit_progress(
        Some(progress_key),
        overall_fraction,
        &format!("{phase} project data · {completed_gib:.2}/{total_gib:.2} GiB"),
    );
}

fn rpc_err(id: serde_json::Value, code: i32, message: &str) -> RpcResponse {
    RpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(RpcError {
            code,
            message: message.to_string(),
            data: None,
        }),
    }
}

fn rpc_automation_err(id: serde_json::Value, message: &str) -> RpcResponse {
    let stable_code = message
        .split_once(':')
        .map_or("internal", |(code, _)| code.trim());
    let known = [
        "protocolMismatch",
        "missingCapability",
        "invalidRequest",
        "invalidCursor",
        "generationChanged",
        "pageLimitExceeded",
        "byteLimitExceeded",
        "conflict",
        "lossAcceptanceRequired",
        "confirmationRequired",
        "operationNotFound",
        "cancelled",
        "leaseExpired",
        "leaseRevoked",
        "leaseRangeInvalid",
        "leaseBudgetExhausted",
        "hashMismatch",
        "permissionDenied",
        "internal",
    ];
    let stable_code = if known.contains(&stable_code) {
        stable_code
    } else {
        "internal"
    };
    RpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(RpcError {
            code: -32040,
            message: message.to_owned(),
            data: Some(serde_json::json!({
                "code": stable_code,
                "message": message,
                "retryable": matches!(stable_code, "generationChanged" | "cancelled"),
                "details": {},
            })),
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn rpc_request(method: &str, params: serde_json::Value) -> RpcRequest {
        RpcRequest {
            jsonrpc: "2.0".to_owned(),
            id: serde_json::json!(1),
            method: method.to_owned(),
            params,
        }
    }

    #[test]
    fn app_negotiation_advertises_only_implemented_capabilities() {
        let response = handle_app_negotiation(rpc_request(
            "app.negotiate",
            serde_json::json!({
                "clientName": "builder-test",
                "supportedVersions": [1],
                "requiredCapabilities": ["document.read", "document.write"],
                "optionalCapabilities": ["view.read"]
            }),
        ));
        assert!(response.error.is_none());
        let result = response.result.expect("negotiation result");
        assert_eq!(result["selectedVersion"], 1);
        assert_eq!(
            result["capabilities"],
            serde_json::json!([
                "document.read",
                "document.write",
                "journal.read",
                "io.formats.read",
                "io.probe",
                "io.import.execute",
                "io.export",
                "io.operation",
                "registration.import",
                "residency.read",
                "automation.entities.page",
                "automation.cas.describe",
                "automation.commands.validate",
                "automation.commands.status",
                "automation.commands.cancel",
                "automation.bulk.read",
                "automation.bulk.release"
            ])
        );
    }

    #[test]
    fn io_provider_discovery_is_stable_and_paginated() {
        let first = handle_io_formats_page(rpc_request(
            "io.formats.page",
            serde_json::json!({ "limit": 2 }),
        ));
        assert!(first.error.is_none());
        let result = first.result.expect("format result");
        assert_eq!(result["items"].as_array().map(Vec::len), Some(2));
        assert!(result["nextCursor"].is_string());
    }

    #[tokio::test]
    async fn io_probe_is_bounded_and_returns_a_version_frozen_selection() {
        let source = std::env::temp_dir().join(format!(
            "himmelcad-io-probe-{}-{}.dxf",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::write(&source, b"0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n")
            .expect("probe source");
        let response = handle_io_rpc(
            rpc_request(
                "io.probe",
                serde_json::json!({ "sourcePath": source, "mediaType": "image/vnd.dxf" }),
            ),
            Arc::new(IoOperations::default()),
            Arc::new(Mutex::new(CanonicalAppRuntime::default())),
        )
        .await;
        std::fs::remove_file(&source).expect("cleanup");
        assert!(response.error.is_none(), "{:?}", response.error);
        let selection = response.result.expect("probe selection");
        assert_eq!(selection["providerId"], "hcad.io.dxf-rs@1");
        assert_eq!(selection["formatId"], "dxf@r12-r2018-ascii");
        assert!(selection["providerVersion"].is_string());
    }

    #[test]
    fn generic_io_operation_cancel_is_visible_to_every_provider() {
        let operations = Arc::new(IoOperations::default());
        let context = operations
            .begin("generic-import-1".to_owned())
            .expect("begin operation");
        assert!(!context.is_cancelled());
        assert!(operations.cancel("generic-import-1"));
        assert!(context.is_cancelled());
        let result = Err(anyhow::anyhow!("cancelled"));
        operations.finish("generic-import-1", &result);
        assert_eq!(
            operations.status("generic-import-1").expect("status").state,
            IoOperationState::Cancelled
        );
        assert!(operations.begin("generic-import-1".to_owned()).is_err());
    }

    #[test]
    fn exporter_capabilities_and_version_drift_fail_closed() {
        let registry =
            canonical_builtin_import_registry(io_probe_registry_root()).expect("built-in registry");
        for provider_id in ["hcad.io.las-potree@1", "hcad.io.e57-potree@1"] {
            let descriptor = registry
                .descriptors()
                .into_iter()
                .find(|descriptor| descriptor.provider_id == provider_id)
                .expect("import descriptor");
            assert!(descriptor
                .capabilities
                .contains(&himmelcad_io::FormatCapability::Import));
            assert!(!descriptor
                .capabilities
                .contains(&himmelcad_io::FormatCapability::Export));
            assert!(registry.exporter(provider_id).is_err());
        }
        assert!(
            require_provider_version(&registry, "hcad.io.dxf-rs@1", "changed-version").is_err()
        );
    }

    #[test]
    fn las_import_cancellation_is_generation_scoped_and_removed_on_finish() {
        let operations = Arc::new(LasImportOperations::default());
        let active = operations
            .begin("import-1".to_string())
            .expect("begin import");
        assert!(!active.cancellation.load(Ordering::Acquire));
        assert!(operations.cancel("import-1"));
        assert!(active.cancellation.load(Ordering::Acquire));
        assert!(operations.begin("import-1".to_string()).is_err());
        assert!(operations.cancel("import-1"));
        drop(active);
        assert!(!operations.cancel("import-1"));
        assert!(operations.begin("import-1".to_string()).is_ok());
    }

    #[test]
    fn fast_alignment_uses_an_explicit_bounded_feature_budget() {
        let fast = resolve_alignment_profile(&ResolveAlignmentProfileRequest {
            profile: AlignmentQualityProfile::Fast,
            image_count: 24,
            max_image_edge_override: None,
            keypoints_per_megapixel_override: None,
        })
        .expect("fast profile");
        // 2400 edge × 5500 kp/MPx still saturates Fast ceil (interactive cap).
        assert_eq!(
            alignment_feature_budget(AlignmentQualityProfile::Fast, &fast),
            8_192
        );
        let qh = resolve_alignment_profile(&ResolveAlignmentProfileRequest {
            profile: AlignmentQualityProfile::QualityHybrid,
            image_count: 24,
            max_image_edge_override: None,
            keypoints_per_megapixel_override: None,
        })
        .expect("qh profile");
        assert_eq!(
            alignment_feature_budget(AlignmentQualityProfile::QualityHybrid, &qh),
            24_000
        );
        let mr = resolve_alignment_profile(&ResolveAlignmentProfileRequest {
            profile: AlignmentQualityProfile::MaximumRobustness,
            image_count: 24,
            max_image_edge_override: None,
            keypoints_per_megapixel_override: None,
        })
        .expect("mr profile");
        assert_eq!(
            alignment_feature_budget(AlignmentQualityProfile::MaximumRobustness, &mr),
            48_000
        );
        // Density is live: tiny edge + low kp → floor.
        let tiny = resolve_alignment_profile(&ResolveAlignmentProfileRequest {
            profile: AlignmentQualityProfile::Fast,
            image_count: 24,
            max_image_edge_override: Some(1_024),
            keypoints_per_megapixel_override: None,
        })
        .expect("tiny edge");
        // Override only changes edge; kp still 5500 → still hits floor or mid.
        let budget_tiny = alignment_feature_budget(AlignmentQualityProfile::Fast, &tiny);
        assert!((2_048..=8_192).contains(&budget_tiny));
        assert_eq!(
            alignment_primary_store(AlignmentQualityProfile::Fast),
            MappingFeatureStore::Sift
        );
        assert_eq!(
            alignment_primary_store(AlignmentQualityProfile::QualityHybrid),
            MappingFeatureStore::Aliked
        );
        assert_eq!(
            alignment_pair_selection(AlignmentQualityProfile::Fast, None),
            ColmapPairSelection::Sequential { overlap: 20 }
        );
        assert_eq!(
            alignment_pair_selection(AlignmentQualityProfile::Fast, Some(16)),
            ColmapPairSelection::Sequential { overlap: 16 }
        );
        assert_eq!(
            alignment_pair_selection(AlignmentQualityProfile::QualityHybrid, None),
            ColmapPairSelection::Sequential { overlap: 24 }
        );
        assert_eq!(
            alignment_pair_selection(AlignmentQualityProfile::MaximumRobustness, Some(40)),
            ColmapPairSelection::Exhaustive
        );
    }

    #[test]
    fn alignment_profiles_apply_explicit_embedded_intrinsics_policy() {
        let full = himmelcad_core::photolab_images::DjiBrownConradyCalibration {
            focal_x_pixels: 3713.0,
            focal_y_pixels: 3713.0,
            principal_x_pixels: 2660.0,
            principal_y_pixels: 1961.0,
            radial_distortion: [-0.1, -0.001, -0.015],
            tangential_distortion: [0.0001, -0.00001],
            calibration_date: "2025-02-26".into(),
            provenance: himmelcad_core::photolab_images::DjiCalibrationProvenance::DewarpData,
        };
        let groups = vec![ColmapCalibrationGroup {
            group_id: "embedded".into(),
            camera_entity_ids: vec!["camera-a".into()],
            seed: Some(ColmapCalibrationSeed {
                width_pixels: 5280,
                height_pixels: 3956,
                focal_pixels: full.focal_x_pixels,
                principal_x_pixels: full.principal_x_pixels,
                principal_y_pixels: full.principal_y_pixels,
                full_brown_calibration: Some(full),
            }),
        }];

        assert_eq!(
            alignment_intrinsics_refinement(AlignmentQualityProfile::Fast, &groups),
            ColmapIntrinsicsRefinement::FreezeReliableEmbedded
        );
        assert_eq!(
            alignment_intrinsics_refinement(AlignmentQualityProfile::QualityHybrid, &groups),
            ColmapIntrinsicsRefinement::FreezeReliableEmbedded
        );
        assert_eq!(
            alignment_intrinsics_refinement(AlignmentQualityProfile::MaximumRobustness, &groups),
            ColmapIntrinsicsRefinement::FreezeReliableEmbedded
        );
        assert_eq!(
            alignment_intrinsics_refinement(AlignmentQualityProfile::QualityHybrid, &[]),
            ColmapIntrinsicsRefinement::Refine
        );
        assert_eq!(
            alignment_intrinsics_refinement(AlignmentQualityProfile::Fast, &[]),
            ColmapIntrinsicsRefinement::Refine
        );
    }

    fn sample_steps() -> Vec<BatchPipelineStep> {
        vec![
            BatchPipelineStep::Alignment {
                preset: Some(BatchAlignmentPreset {
                    id: "photolab.factory.qualityHybrid".into(),
                    name: "Quality Hybrid".into(),
                    profile: AlignmentQualityProfile::QualityHybrid,
                    overrides: AlignmentJobOverrides::default(),
                }),
                profile: None,
            },
            BatchPipelineStep::Product {
                configuration: ProductRunConfiguration::Dense {
                    image_downscale: 2,
                    filter: "moderate".into(),
                    maximum_neighbors: 6,
                    minimum_views: 3,
                    retain_confidence: true,
                    calculate_colors: true,
                },
            },
        ]
    }

    #[test]
    fn unattended_batch_rejects_unbound_orthomosaic_before_queueing() {
        let steps = vec![
            BatchPipelineStep::Alignment {
                preset: Some(BatchAlignmentPreset {
                    id: "photolab.factory.qualityHybrid".into(),
                    name: "Quality Hybrid".into(),
                    profile: AlignmentQualityProfile::QualityHybrid,
                    overrides: AlignmentJobOverrides::default(),
                }),
                profile: None,
            },
            BatchPipelineStep::Product {
                configuration: ProductRunConfiguration::Ortho {
                    resolution_meters_per_pixel: 0.03,
                    blend_mode: "mosaic".into(),
                    color_correction: true,
                    fill_holes: false,
                    tile_size_pixels: 512,
                    source_dem_entity_id: None,
                    source_dem_version_sha256: None,
                },
            },
        ];
        let error = validate_unattended_batch_recipe(&steps).expect_err("unbound DEM must fail");
        assert!(error
            .to_string()
            .contains("exact external DEM entity/version binding"));
    }

    #[test]
    fn unattended_standard_batch_has_no_runtime_input_gate() {
        let mut steps = sample_steps();
        steps.extend([
            BatchPipelineStep::Product {
                configuration: ProductRunConfiguration::Dem {
                    surface: "dsm".into(),
                    resolution_meters_per_pixel: 0.05,
                    interpolate_nodata: false,
                    tile_size_pixels: 512,
                },
            },
            BatchPipelineStep::Product {
                configuration: ProductRunConfiguration::Ortho {
                    resolution_meters_per_pixel: 0.03,
                    blend_mode: "mosaic".into(),
                    color_correction: true,
                    fill_holes: false,
                    tile_size_pixels: 512,
                    source_dem_entity_id: None,
                    source_dem_version_sha256: None,
                },
            },
        ]);
        validate_unattended_batch_recipe(&steps).expect("prior DEM resolves the port");
        assert!(!serde_json::to_string(&steps)
            .expect("serialize")
            .contains("NeedsUserInput"));
    }

    #[test]
    fn product_rpc_configuration_uses_renderer_camel_case_fields() {
        let configuration: ProductRunConfiguration = serde_json::from_value(serde_json::json!({
            "kind": "depth",
            "imageDownscale": 8,
            "filter": "moderate",
            "maximumNeighbors": 6,
            "reuseCompatibleMaps": true
        }))
        .expect("renderer product configuration");
        assert!(matches!(
            configuration,
            ProductRunConfiguration::Depth {
                image_downscale: 8,
                reuse_compatible_maps: true,
                ..
            }
        ));
    }

    #[test]
    fn batch_alignment_accepts_a_frozen_renderer_preset_snapshot() {
        let step: BatchPipelineStep = serde_json::from_value(serde_json::json!({
            "kind": "alignment",
            "preset": {
                "id": "site-quality",
                "name": "Site quality",
                "profile": "qualityHybrid",
                "overrides": {
                    "maxImageEdge": 9000,
                    "featureBudget": 20000
                }
            }
        }))
        .expect("renderer preset snapshot");
        let BatchPipelineStep::Alignment {
            preset: Some(preset),
            profile: None,
        } = step
        else {
            panic!("expected preset-backed alignment step");
        };
        assert_eq!(preset.id, "site-quality");
        assert_eq!(preset.name, "Site quality");
        assert_eq!(preset.profile, AlignmentQualityProfile::QualityHybrid);
        assert_eq!(preset.overrides.max_image_edge, Some(9_000));
        assert_eq!(preset.overrides.feature_budget, Some(20_000));
    }

    #[test]
    fn agisoft_high_depth_settings_preserve_scale_and_mild_filtering() {
        let mut settings = MvsSettings {
            maximum_image_dimension: 5_280_u32.div_ceil(2),
            matching_views: 16,
            ..MvsSettings::default()
        };
        apply_mvs_depth_filter(&mut settings, "mild").expect("mild filter");

        assert_eq!(settings.maximum_image_dimension, 2_640);
        assert_eq!(settings.matching_views, 16);
        assert_eq!(settings.minimum_consistent_views, 2);
        assert_eq!(settings.minimum_confidence, 0.2);
        assert_eq!(settings.geometric_relative_tolerance, 0.025);
    }

    #[test]
    fn batch_checkpoint_resumes_only_for_same_configuration_and_inputs() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "himmelcad-batch-checkpoint-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("temp root");
        let path = root.join("checkpoint.json");
        let plan = ObjectHash::of_bytes(b"concrete-plan-a");
        let steps = batch_steps_hash(&sample_steps(), &[]).expect("steps hash");
        let inputs = ObjectHash::of_bytes(b"inputs-a");
        write_batch_checkpoint(&path, &plan, &steps, &inputs, 2).expect("write");

        assert_eq!(
            read_batch_checkpoint(&path, &plan, &steps, &inputs).expect("matching checkpoint"),
            2
        );
        assert_eq!(
            read_batch_checkpoint(&path, &plan, &steps, &ObjectHash::of_bytes(b"inputs-b"))
                .expect("changed input starts clean"),
            0
        );
        assert_eq!(
            read_batch_checkpoint(
                &path,
                &ObjectHash::of_bytes(b"concrete-plan-b"),
                &steps,
                &inputs
            )
            .expect("changed concrete run starts clean"),
            0
        );
        let changed_steps = batch_steps_hash(
            &[BatchPipelineStep::Alignment {
                preset: Some(BatchAlignmentPreset {
                    id: "photolab.factory.fast".into(),
                    name: "Fast".into(),
                    profile: AlignmentQualityProfile::Fast,
                    overrides: AlignmentJobOverrides::default(),
                }),
                profile: None,
            }],
            &[],
        )
        .expect("changed steps");
        assert_eq!(
            read_batch_checkpoint(&path, &plan, &changed_steps, &inputs)
                .expect("changed configuration starts clean"),
            0
        );
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn colmap_tie_point_lookup_handles_empty_images_and_collects_track() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "himmelcad-tiepoints-{}-{unique}.txt",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "# images\n1 1 0 0 0 0 0 0 1 empty.jpg\n\n2 1 0 0 0 0 0 0 1 seed.jpg\n10 20 42 90 90 -1\n3 1 0 0 0 0 0 0 1 other.jpg\n11 21 42\n",
        )
        .expect("fixture");
        let track = nearest_track_in_image(
            &path,
            ImageId(2),
            ImageCoordinate {
                x_pixels: 10.5,
                y_pixels: 20.5,
            },
            3.0,
        )
        .expect("nearest track");
        assert_eq!(track, Some(42));
        let measurements = collect_track_measurements(&path, 42).expect("track measurements");
        assert_eq!(measurements.len(), 2);
        assert_eq!(measurements[1].image_id, ImageId(3));
        std::fs::remove_file(path).expect("cleanup");
    }

    #[test]
    fn camera_orthophoto_progress_precedes_the_seven_raster_stages() {
        let mut progress = JobProgress {
            stage: PhotolabStage {
                kind: PhotolabStageKind::Preparing,
                index: 0,
                stage_count: 8,
                label: "Prepare cameras and DEM for orthorectification".into(),
            },
            metrics: ProgressMetrics::empty(),
        };
        progress
            .advance_to(JobProgress {
                stage: progress.stage.clone(),
                metrics: ProgressMetrics {
                    completed_units: 4,
                    total_units: Some(4),
                    completed_bytes: 0,
                    total_bytes: None,
                },
            })
            .expect("camera preparation progress");
        progress
            .advance_to(raster_job_progress(
                RasterProgress {
                    phase: RasterPhase::Validating,
                    completed_steps: 0,
                    total_steps: 1,
                    current_step: "Validate GDAL inputs".into(),
                },
                1,
                8,
            ))
            .expect("raster stage follows camera preparation");
        let committed = raster_job_progress(
            RasterProgress {
                phase: RasterPhase::Committing,
                completed_steps: 1,
                total_steps: 1,
                current_step: "Publish orthomosaic".into(),
            },
            1,
            8,
        );
        assert_eq!(committed.stage.index, 7);
        assert_eq!(committed.stage.stage_count, 8);
    }

    #[test]
    fn job_concurrency_is_bounded_by_both_memory_and_physical_cores() {
        const GIB: u64 = 1024 * 1024 * 1024;
        assert_eq!(adaptive_job_concurrency(16, 8, 16 * GIB), 1);
        assert_eq!(adaptive_job_concurrency(16, 8, 32 * GIB), 2);
        assert_eq!(adaptive_job_concurrency(32, 16, 128 * GIB), 8);
        assert_eq!(adaptive_job_concurrency(64, 32, 8 * GIB), 1);
    }

    #[test]
    fn transformed_coordinates_are_normalized_to_easting_northing_height() {
        let pipeline = "+proj=pipeline +step +proj=tmerc +step +proj=axisswap +order=2,1";
        assert!(pipeline_ends_with_axis_swap(pipeline));
        assert_eq!(
            parse_transformed_coordinates("5281200.5 4527550.25 735.8\n", true)
                .expect("coordinates"),
            vec![[4527550.25, 5281200.5, 735.8]],
        );
        assert_eq!(
            parse_transformed_coordinates("4527550.25 5281200.5 735.8\n", false)
                .expect("coordinates"),
            vec![[4527550.25, 5281200.5, 735.8]],
        );
    }
}
