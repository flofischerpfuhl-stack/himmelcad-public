//! Sidecar route implementations and exact-method registration.
//!
//! The binary host owns stdio transport and shutdown sequencing; this module
//! owns the wire adapters and the narrow service contexts captured by each
//! route family.
//!
//! HimmelCAD sidecar: a long-running OS process that speaks JSON-RPC 2.0 over
//! stdio. Electron's main process spawns and supervises this binary.
//!
//! The sidecar holds the authoritative project state (entity store, command
//! journal, spatial indexes). The renderer mirrors snapshots and never mutates
//! state directly.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufReader as StdBufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use himmelcad_command::RpcModule;
use himmelcad_document::canonical_document::EntityVersionRef;
use himmelcad_model::canonical_resources::CanonicalResourceRef;
use himmelcad_model::entity::{EntityId, EntityKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use himmelcad_domain_photogrammetry::photolab::{
    resolve_alignment_profile, AlignmentQualityProfile, ResolveAlignmentProfileRequest,
    ResolvedAlignmentConfig,
};
use himmelcad_domain_photogrammetry::photolab_capture::{
    evaluate_local_scale, LocalScaleConstraint,
};
use himmelcad_domain_photogrammetry::photolab_gcp::{
    GcpCoordinate, GcpCsvImportMapping, GcpObservation, GcpObservationState, ImageCoordinate,
};
use himmelcad_domain_photogrammetry::photolab_gcp_optimization::{
    propagate_gcp_through_tie_points, GcpCameraModel, GcpIntrinsicsPolicy, GcpOptimizationPhase,
    GcpSimilarityTransform, GcpSolverOptions, GcpTiePointMeasurement, GcpTiePointTrack,
    OptimizedGcpCamera,
};
use himmelcad_domain_photogrammetry::photolab_images::ProjectedPhotoReference;
use himmelcad_domain_photogrammetry::photolab_jobs::{
    JobProgress, NewPhotolabJob, PhotolabJobId, PhotolabJobKind, PhotolabJobState, PhotolabStage,
    PhotolabStageKind,
};
use himmelcad_domain_photogrammetry::photolab_matching::ImageId;
use himmelcad_domain_photogrammetry::{
    hcap_import::import_hcap_path_with_progress, import_gcp_csv_file,
    import_photo_files_with_progress, preview_gcp_csv_file,
};
#[cfg(test)]
use himmelcad_hardware_profile::adaptive_job_concurrency;
use himmelcad_hardware_profile::{default_job_concurrency, native::probe_hardware};
use himmelcad_io::ProviderContractError;
use himmelcad_model::hash::ObjectHash;
use himmelcad_model::project_units::PhotolabSpatialReference;
use himmelcad_process::jobs::{CancellationToken, ProgressMetrics};
use himmelcad_transform::photolab_crs::{
    CrsDefinition, FrozenImportTransformation, HeightReference, VerticalOperationMode,
};

use crate::dense_raster_prep::{
    inspect_raster_wkt, inspect_vector_wkt, inspect_vector_wkt_bounded,
    persist_dense_classification, prepare_dense_potree, prepare_dense_vector_with_classification,
    prepare_dense_vector_with_classification_bounded, prepare_sparse_potree, read_dense_points,
    DenseRasterPrepError,
};
use crate::mesh_tiler::{build_tiled_dem_mesh, MeshTilerError};
use crate::prepared_triangle_mesh::PreparedTriangleMeshOptions;
use crate::product_export::{export_product, ProductExportError, ProductExportRequest};
use crate::raster_runtime::{
    ElevationGeometrySource, ElevationInputTile, ElevationInterpolation, ElevationRasterRequest,
    ElevationSurface, ElevationViewRange, GdalToolchainConfig, MosaicOrder,
    OrthomosaicElevationSupport, OrthomosaicRequest, RasterBounds, RasterBuildCommand, RasterCrs,
    RasterGrid, RasterNoDataValue, RasterPhase, RasterProductRequest, RasterProgress,
    RasterResampling, RasterResumeCheckpointValidation, RasterRuntime, RasterRuntimeMemory,
};
use crate::splat_tiler::{tile_brush_ply, SplatTilerError};
use himmelcad_domain_photogrammetry::alignment_merge_runtime::{
    build_shared_control_merge, resume_shared_control_merge, resume_solved_merge,
    write_merge_checkpoint, AlignmentMergeCheckpoint, AlignmentMergeCheckpointState,
    SharedControlInput,
};
use himmelcad_domain_photogrammetry::brush_runtime::{
    BrushRunRequest, BrushRuntime, BrushTrainingSettings, DevBrushRuntimeConfig,
};
use himmelcad_domain_photogrammetry::capture_runtime::{
    prepare_still_image, prepare_video_frames, probe_capture_capabilities, CaptureToolConfig,
    PrepareStillImageRequest, PrepareVideoFramesRequest,
};
#[cfg(test)]
use himmelcad_domain_photogrammetry::colmap_runtime::ColmapCalibrationSeed;
use himmelcad_domain_photogrammetry::colmap_runtime::{
    AlikedModelVariant, ColmapArtifactKind, ColmapCalibrationGroup, ColmapComputeDevice,
    ColmapIntrinsicsRefinement, ColmapPairSelection, ColmapProductRequest, ColmapResourceKind,
    ColmapRunOutcome, ColmapRunRequest, ColmapRuntime, DedodeV2GPolicy, DevColmapRuntimeConfig,
    LargeMatchingBackend, MappingFeatureStore,
};
use himmelcad_domain_photogrammetry::dedode_runtime::{
    DedodeComputeDevice, DedodeImagePair, DedodeRunRequest, DedodeRuntime,
    DevDedodeOnnxRuntimeConfig, DevDedodeRuntimeConfig,
};
use himmelcad_domain_photogrammetry::gcp_local_estimate_runtime::{
    ComputeGcpLocalEstimateParams, ReadGcpLocalEstimateParams,
};
use himmelcad_domain_photogrammetry::gcp_optimization_runtime::{
    run_gcp_optimization, GcpOptimizationRuntimeError, RunGcpOptimizationParams,
};
use himmelcad_domain_photogrammetry::gcp_runtime::{
    CancelGcpOperationParams, CommitGcpsParams, CreateGcpOptimizationSnapshotParams,
    EditGcpObservationParams, UpsertGcpObservationParams, UpsertGcpObservationsParams,
};
use himmelcad_domain_photogrammetry::image_commit::{CancelImageCommitParams, CommitImagesParams};
use himmelcad_domain_photogrammetry::image_quality_runtime::{
    analyze_project_images, ImageQualityConfiguration, ImageQualityRuntimeError, ImageQualityScope,
    IMAGE_QUALITY_ALGORITHM_VERSION,
};
use himmelcad_domain_photogrammetry::job_runtime::{
    memory_os_ui_reserve_bytes, plan_alignment_memory, plan_raster_preparation_memory,
    AlignmentExtractionTiling, AlignmentMemoryPlan, AlignmentMemoryRequest, DrainReport,
    FrozenJobRequest, JobAdmissionRefusal, JobIdParams, JobManager, JobManagerConfig,
    JobWorkerContext, JobWorkerError, ListJobsParams, MemoryPreflight, RasterPreparationMemoryPlan,
    StartJobResult, ALIGNMENT_NEEDS_UNTILED_EXTRACTION_CODE,
    ALIGNMENT_NEEDS_UNTILED_EXTRACTION_MESSAGE, SIFT_MATCHING_BYTES_PER_WORKER,
};
use himmelcad_domain_photogrammetry::mvs_runtime::{
    DevMvsRuntimeConfig, MvsCapability, MvsComputeDevice, MvsRunRequest, MvsRuntime, MvsSettings,
};
use himmelcad_domain_photogrammetry::mvs_scene::{
    load_gcp_bundle_tie_points, load_prepared_mvs_scene, prepare_gcp_cameras, prepare_mvs_scene,
    prepare_mvs_scene_with_masks_and_progress, PreparedMvsScene,
};
use himmelcad_domain_photogrammetry::project_runtime::{
    AlignmentMergePreflightParams, AppendJournalParams, CancelArchiveParams, CancelImageMaskParams,
    ConfirmCaptureGroupParams, CreateAlignmentMergeParams, CreateCaptureGroupParams,
    CreateProcessingSetParams, CreateProjectParams, DuplicateCaptureGroupDraftParams,
    EditImageMaskParams, FinishJournalParams, MergeCaptureGroupProposalsParams, MoveEntityParams,
    OpenProjectParams, ProductLineage, ProjectRuntime, PublishedRasterKind,
    RemoveCameraImagesParams, RenameEntityParams, SaveProjectAsParams, SetEntityVisibilityParams,
    UpdateCalibrationGroupInitialCalibrationParams, UpdateCalibrationGroupIntrinsicsParams,
};
use himmelcad_domain_photogrammetry::worker_toolchain::{
    worker_toolchain_preflight, WorkerProduct,
};
use himmelcad_domain_raster::orthophoto_prep::{
    prepare_camera_orthophotos, CameraBlendMode, OrthophotoPreparation, OrthophotoPreparationError,
};
use himmelcad_prepared_build::prepared_triangle_mesh_ply::{
    build_prepared_triangle_mesh_from_colmap_textured_directory,
    build_prepared_triangle_mesh_from_ply,
};
use himmelcad_sidecar::ground_classification::{
    classify_ground, GroundClassificationError, PointClass, SmrfParams,
};
use himmelcad_sidecar::pointcloud_export::PointCloudExportFormat;
use himmelcad_sidecar::{
    crs_runtime::{ProjRuntime, ProjToolchainConfig},
    crs_service::{
        CancelCrsOperationParams, CrsService, DiscoverCrsOperationsParams, FreezeCrsOperationParams,
    },
};

use himmelcad_domain_photogrammetry::project_runtime;

mod photolab_capture;
mod photolab_crs;
mod photolab_gcp;
mod photolab_himmelcap;
mod photolab_images;
mod photolab_jobs;
mod photolab_products;
mod photolab_project;
mod root;

use himmelcad_sidecar::host::emit_progress;
use himmelcad_sidecar::host::{DrainFuture, HostComposition, ProductLifecycle};
use himmelcad_sidecar::routes::{
    definitions, register_shared_routes, shared_route_definitions, RpcError, RpcRequest,
    RpcResponse, SharedRouteServices, SidecarCommandRegistry,
};

// Smartphone antenna/camera lever-arm and frame/GNSS synchronization errors
// make sub-5 cm priors overconfident until device-specific calibration exists.
const MIN_FIXED_CAMERA_REFERENCE_HORIZONTAL_SIGMA_METERS: f64 = 0.05;
const MIN_FIXED_CAMERA_REFERENCE_HEIGHT_SIGMA_METERS: f64 = 0.10;
const MIN_NON_FIXED_CAMERA_REFERENCE_HORIZONTAL_SIGMA_METERS: f64 = 0.30;
const MIN_NON_FIXED_CAMERA_REFERENCE_HEIGHT_SIGMA_METERS: f64 = 0.60;

#[derive(Clone)]
struct PhotolabRouteServices {
    projects: Arc<ProjectRuntime>,
    jobs: Arc<JobManager>,
    crs: Arc<CrsService>,
}

impl PhotolabRouteServices {
    fn new() -> Result<Self> {
        let projects = Arc::new(ProjectRuntime::default());
        let jobs = Arc::new(JobManager::new_with_history(
            default_job_manager_config(),
            projects.clone(),
        )?);
        Ok(Self {
            projects,
            jobs,
            crs: Arc::new(default_crs_service()?),
        })
    }

    fn register(&self, registry: &mut SidecarCommandRegistry) -> Result<()> {
        root::RootModule::new(Arc::clone(&self.projects), Arc::clone(&self.jobs))
            .register(registry)?;
        photolab_capture::PhotolabCaptureModule::new(Arc::clone(&self.projects))
            .register(registry)?;
        photolab_crs::PhotolabCrsModule::new(Arc::clone(&self.crs)).register(registry)?;
        photolab_gcp::PhotolabGcpModule::new(Arc::clone(&self.projects), Arc::clone(&self.crs))
            .register(registry)?;
        photolab_himmelcap::PhotolabHimmelcapModule::new(Arc::clone(&self.projects))
            .register(registry)?;
        photolab_images::PhotolabImagesModule::new(
            Arc::clone(&self.projects),
            Arc::clone(&self.crs),
        )
        .register(registry)?;
        photolab_jobs::PhotolabJobsModule::new(
            Arc::clone(&self.jobs),
            Arc::clone(&self.projects),
            Arc::clone(&self.crs),
        )
        .register(registry)?;
        photolab_products::PhotolabProductsModule::new(Arc::clone(&self.projects))
            .register(registry)?;
        photolab_project::PhotolabProjectModule::new(
            Arc::clone(&self.projects),
            Arc::clone(&self.jobs),
        )
        .register(registry)?;
        Ok(())
    }

    fn route_definitions() -> Vec<himmelcad_sidecar::routes::RouteDefinition> {
        let mut routes = Vec::new();
        routes.extend(definitions(root::METHODS, "root", "photolab"));
        routes.extend(definitions(
            photolab_capture::METHODS,
            "photolab-capture",
            "photolab",
        ));
        routes.extend(definitions(
            photolab_crs::METHODS,
            "photolab-crs",
            "photolab",
        ));
        routes.extend(definitions(
            photolab_gcp::METHODS,
            "photolab-gcp",
            "photolab",
        ));
        routes.extend(definitions(
            photolab_himmelcap::METHODS,
            "photolab-himmelcap",
            "photolab",
        ));
        routes.extend(definitions(
            photolab_images::METHODS,
            "photolab-images",
            "photolab",
        ));
        routes.extend(definitions(
            photolab_jobs::METHODS,
            "photolab-jobs",
            "photolab",
        ));
        routes.extend(definitions(
            photolab_products::METHODS,
            "photolab-products",
            "photolab",
        ));
        routes.extend(definitions(
            photolab_project::METHODS,
            "photolab-project",
            "photolab",
        ));
        routes
    }
}

struct PhotolabLifecycle {
    projects: Arc<ProjectRuntime>,
    jobs: Arc<JobManager>,
    reports: Mutex<Option<(DrainReport, project_runtime::SideOperationDrainReport)>>,
}

impl ProductLifecycle for PhotolabLifecycle {
    fn startup(&self) {
        if std::env::var("HIMMELCAD_PHOTOLAB_PROBE_WORKER_SCOPE").as_deref() == Ok("1") {
            let _ = himmelcad_process::worker::probe_worker_scope_for_diagnostics();
        }
    }

    fn drain(&self) -> DrainFuture<'_> {
        Box::pin(async move {
            let reports = drain_project_work(&self.jobs, &self.projects).await;
            let completed = reports.0.completed() && reports.1.completed();
            *self.reports.lock().expect("drain reports mutex poisoned") = Some(reports);
            completed
        })
    }

    fn close(&self) {
        let reports = self
            .reports
            .lock()
            .expect("drain reports mutex poisoned")
            .take();
        if let Some((jobs, side_operations)) = reports {
            if let Err(error) = self.projects.close_after_drain(&jobs, &side_operations) {
                tracing::error!(%error, "failed to close project cleanly during sidecar shutdown");
            }
        }
    }
}

pub async fn run() -> anyhow::Result<()> {
    let shared = SharedRouteServices::new()?;
    let photolab = PhotolabRouteServices::new()?;
    let mut registry = SidecarCommandRegistry::default();
    register_shared_routes(&mut registry, &shared)?;
    photolab.register(&mut registry)?;
    let mut routes = shared_route_definitions();
    routes.extend(PhotolabRouteServices::route_definitions());
    let lifecycle = PhotolabLifecycle {
        projects: Arc::clone(&photolab.projects),
        jobs: Arc::clone(&photolab.jobs),
        reports: Mutex::new(None),
    };
    himmelcad_sidecar::host::run(HostComposition {
        registry,
        routes,
        canonical_app: shared.canonical_app,
        lifecycle: Arc::new(lifecycle),
    })
    .await
}

#[derive(Debug, thiserror::Error)]
#[error("COLMAP worker is unavailable at {resolved_path}")]
struct ColmapWorkerMissing {
    resolved_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavePhotolabProjectParams {
    #[serde(default)]
    archive_operation_id: Option<String>,
    #[serde(default)]
    progress_key: Option<String>,
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

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GcpCalibrationReportParams {
    #[serde(default)]
    optimization_entity_id: Option<EntityId>,
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
        #[serde(default = "default_smrf_cell_size_m")]
        cell_size_m: f64,
        #[serde(default = "default_smrf_slope")]
        slope: f64,
        #[serde(default = "default_smrf_max_window_m")]
        max_window_m: f64,
        #[serde(default = "default_smrf_initial_distance_m")]
        initial_distance_m: f64,
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
        #[serde(default)]
        mesh_source: himmelcad_domain_photogrammetry::photolab_products::MeshSource,
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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
enum ProductGcpSelection {
    #[default]
    Latest,
    None,
    Explicit(EntityId),
}

impl ProductGcpSelection {
    fn is_latest(&self) -> bool {
        matches!(self, Self::Latest)
    }
}

impl Serialize for ProductGcpSelection {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Latest | Self::None => serializer.serialize_none(),
            Self::Explicit(entity_id) => entity_id.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for ProductGcpSelection {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(match Option::<EntityId>::deserialize(deserializer)? {
            Some(entity_id) => Self::Explicit(entity_id),
            None => Self::None,
        })
    }
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

/// X6 default: about 2–5 times typical UAV GSD balances samples per cell and detail.
const fn default_smrf_cell_size_m() -> f64 {
    1.0
}

/// X6 default: 15% terrain tolerance retains common ramps and embankments.
const fn default_smrf_slope() -> f64 {
    0.15
}

/// X6 default: 18 m removes typical buildings without a city-scale kernel.
const fn default_smrf_max_window_m() -> f64 {
    18.0
}

/// X6 default: 0.5 m tolerates dense-cloud noise and low vegetation near terrain.
const fn default_smrf_initial_distance_m() -> f64 {
    0.5
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartProductJobParams {
    operation_id: String,
    configuration: ProductRunConfiguration,
    #[serde(default)]
    processing_set_id: Option<EntityId>,
    #[serde(default)]
    source_alignment_entity_id: Option<EntityId>,
    #[serde(default, skip_serializing_if = "ProductGcpSelection::is_latest")]
    gcp_optimization_entity_id: ProductGcpSelection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveProductInputsParams {
    kind: String,
    source_alignment_entity_id: EntityId,
    #[serde(default)]
    gcp_optimization_entity_id: ProductGcpSelection,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedProductInputs {
    kind: String,
    alignment: ResolvedProductInputArtifact,
    #[serde(skip_serializing_if = "Option::is_none")]
    processing_set: Option<ResolvedProductProcessingSet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    gcp_optimization: Option<ResolvedProductGcpOptimization>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mask_scope_sha256: Option<ObjectHash>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedProductInputArtifact {
    entity_id: EntityId,
    name: String,
    snapshot_sha256: ObjectHash,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedProductProcessingSet {
    entity_id: EntityId,
    name: String,
    membership_sha256: ObjectHash,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedProductGcpOptimization {
    entity_id: EntityId,
    operation_id: String,
    snapshot_sha256: ObjectHash,
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
        #[serde(default, skip_serializing_if = "ProductGcpSelection::is_latest")]
        gcp_optimization_entity_id: ProductGcpSelection,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartBatchJobParams {
    operation_id: String,
    steps: Vec<BatchPipelineStep>,
    #[serde(default)]
    camera_entity_ids: Vec<String>,
    #[serde(default)]
    processing_set_id: Option<EntityId>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResumeJobParams {
    history_job_id: PhotolabJobId,
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
    source_alignment_entity_id: Option<EntityId>,
    #[serde(default)]
    processing_set_id: Option<EntityId>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlignedGcpCamerasParams {
    #[serde(default)]
    source_alignment_entity_id: Option<EntityId>,
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
    image_mask_scope: himmelcad_domain_photogrammetry::photolab_masks::ImageMaskComputeScope,
    lineage: ProductLineage,
}

struct PreparedRasterProductJob {
    job: NewPhotolabJob,
    operation_id: String,
    configuration: ProductRunConfiguration,
    project_root: PathBuf,
    dense_ply: Option<PathBuf>,
    dem_dataset: Option<(PathBuf, project_runtime::RasterArtifactRecord)>,
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
    mesh_source: himmelcad_domain_photogrammetry::photolab_products::MeshSource,
    dem_root: Option<PathBuf>,
    dem_summary: Option<crate::raster_runtime::RasterBuildSummary>,
    dense_ply: Option<PathBuf>,
    colmap_executable: Option<PathBuf>,
    texture_dataset_root: Option<PathBuf>,
    texture_summary: Option<crate::raster_runtime::RasterBuildSummary>,
    textured: bool,
    target_face_count: u64,
    interpolate_holes: bool,
    texture_size: u32,
    lineage: ProductLineage,
    provenance: project_runtime::MeshProvenance,
}

const fn default_gcp_preview_rows() -> usize {
    100
}

const SHUTDOWN_DRAIN_DEADLINE: tokio::time::Duration = tokio::time::Duration::from_secs(20);

pub(crate) async fn drain_project_work(
    jobs: &JobManager,
    projects: &ProjectRuntime,
) -> (DrainReport, project_runtime::SideOperationDrainReport) {
    tokio::join!(
        jobs.drain(SHUTDOWN_DRAIN_DEADLINE),
        projects.drain_side_operations(SHUTDOWN_DRAIN_DEADLINE)
    )
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

fn resolve_gcp_source_alignment(
    projects: &ProjectRuntime,
    processing_set_id: Option<&EntityId>,
    source_alignment_entity_id: Option<&EntityId>,
    request_kind: &'static str,
) -> anyhow::Result<project_runtime::PublishedAlignmentDataset> {
    if let Some(alignment_entity_id) = source_alignment_entity_id {
        let inferred_processing_set_id = if processing_set_id.is_none() {
            projects.processing_set_id_for_alignment(alignment_entity_id)?
        } else {
            None
        };
        return projects.alignment_dataset_by_entity_id(
            alignment_entity_id,
            processing_set_id.or(inferred_processing_set_id.as_ref()),
        );
    }
    tracing::warn!(
        request_kind,
        processing_set_id = processing_set_id.map(|value| value.0.as_str()),
        "GCP request omitted sourceAlignmentEntityId; falling back to the latest AlignmentRun for the processing set"
    );
    projects.latest_alignment_dataset_for_processing_set(processing_set_id)
}

fn latest_gcp_optimization_for_scope(
    projects: &ProjectRuntime,
    processing_set_id: Option<&EntityId>,
    source_alignment_entity_id: Option<&EntityId>,
) -> anyhow::Result<Option<project_runtime::GcpOptimizationPublicationRecord>> {
    if processing_set_id.is_none() && source_alignment_entity_id.is_none() {
        return projects.latest_gcp_optimization();
    }
    let alignment = resolve_gcp_source_alignment(
        projects,
        processing_set_id,
        source_alignment_entity_id,
        "latest optimization query",
    )?;
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
) -> anyhow::Result<himmelcad_domain_photogrammetry::gcp_runtime::UpsertGcpObservationsResult> {
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
    let cancellation = CancellationToken::new();
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
    source_alignment_entity_id: Option<&EntityId>,
) -> anyhow::Result<Vec<AlignedGcpCameraRecord>> {
    let context = projects.compute_context()?;
    let resolved_alignment = resolve_gcp_source_alignment(
        projects,
        processing_set_id,
        source_alignment_entity_id,
        "aligned-cameras query",
    )?;
    let frozen_calibration_partition = projects
        .calibration_partition_for_alignment(&resolved_alignment.source_alignment_entity_id)?;
    let alignment = resolved_alignment.root;
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
    let cancellation = CancellationToken::new();
    let mut prepared = prepare_gcp_cameras(
        &development_colmap_executable()?,
        &alignment,
        &output,
        &cancellation,
    )?;
    let calibration_groups = projects.list_calibration_groups()?;
    let persisted_map = attach_camera_reference_priors(
        &mut prepared,
        &context.camera_images,
        &alignment,
        &calibration_groups,
        &frozen_calibration_partition,
    )?;
    let by_entity = context
        .camera_images
        .iter()
        .map(|record| (record.entity_id.0.as_str(), record))
        .collect::<BTreeMap<_, _>>();
    let mut result = Vec::with_capacity(prepared.len());
    for entry in prepared {
        let mapped_entity = persisted_map
            .iter()
            .find(|item| item.image_name == entry.image_name)
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
    let transformation_required = params.transformation.vertical_mode
        == VerticalOperationMode::Transform
        || params.transformation.original.horizontal != params.transformation.target.horizontal;
    if params.transformation.vertical_mode == VerticalOperationMode::Transform {
        anyhow::ensure!(
            params
                .transformation
                .pipeline
                .proj_pipeline
                .split_ascii_whitespace()
                .any(|token| token == "+proj=vgridshift"),
            "the frozen GCP height decision has no vertical grid operation"
        );
    }
    if params.coordinates_already_in_project_crs {
        anyhow::ensure!(
            !transformation_required,
            "the frozen GCP decision requires a coordinate or height transformation"
        );
        return Ok(CommitGcpsParams {
            operation_id: params.operation_id,
            transformed_points: source_import.points.clone(),
            source_import,
            transformation: params.transformation,
            coordinates_already_in_project_crs: true,
        });
    }
    anyhow::ensure!(
        transformation_required,
        "the frozen GCP decision preserves already-project coordinates; no transformation may be applied"
    );
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

fn drain_timeout_response(
    id: serde_json::Value,
    jobs: &DrainReport,
    side_operations: &project_runtime::SideOperationDrainReport,
) -> RpcResponse {
    rpc_err_with_data(
        id,
        -32030,
        "PhotoLab work did not stop before the project-transition deadline",
        serde_json::json!({
            "timedOutJobs": jobs.timed_out,
            "timedOutSideOperations": side_operations.timed_out,
        }),
    )
}

fn job_start_response(
    id: serde_json::Value,
    result: std::result::Result<
        StartJobResult,
        himmelcad_domain_photogrammetry::job_runtime::JobManagerError,
    >,
) -> RpcResponse {
    match result {
        Ok(value) => rpc_result(id, Ok::<_, anyhow::Error>(value)),
        Err(error @ himmelcad_domain_photogrammetry::job_runtime::JobManagerError::ConflictingTarget { .. }) => {
            let message = error.to_string();
            rpc_err_with_data(
                id,
                -32041,
                &message,
                serde_json::json!({
                    "code": "conflictingTarget",
                    "message": message,
                    "retryable": true,
                }),
            )
        }
        Err(error @ himmelcad_domain_photogrammetry::job_runtime::JobManagerError::InsufficientDisk { .. }) => {
            let (required_bytes, available_bytes) = match &error {
                himmelcad_domain_photogrammetry::job_runtime::JobManagerError::InsufficientDisk {
                    required_bytes,
                    available_bytes,
                    ..
                } => (*required_bytes, *available_bytes),
                _ => unreachable!("matched insufficient-disk error"),
            };
            let message = error.to_string();
            rpc_err_with_data(
                id,
                -32042,
                &message,
                serde_json::json!({
                    "code": "insufficientDisk",
                    "message": message,
                    "retryable": true,
                    "available_bytes": available_bytes,
                    "required_bytes": required_bytes,
                }),
            )
        }
        Err(error @ himmelcad_domain_photogrammetry::job_runtime::JobManagerError::InsufficientMemory { .. }) => {
            let message = error.to_string();
            rpc_err_with_data(
                id,
                -32043,
                &message,
                serde_json::json!({
                    "code": "insufficientMemory",
                    "message": message,
                    "retryable": true,
                }),
            )
        }
        Err(error) => rpc_err(id, -32000, &error.to_string()),
    }
}

fn freeze_job_request<T: Serialize>(
    method: &str,
    params: &T,
    job: &NewPhotolabJob,
) -> anyhow::Result<FrozenJobRequest> {
    Ok(FrozenJobRequest::new(
        method,
        serde_json::to_value(params)?,
        job,
    )?)
}

fn product_worker_requirement(configuration: &ProductRunConfiguration) -> WorkerProduct {
    match configuration {
        ProductRunConfiguration::Depth { .. } => WorkerProduct::DepthMaps,
        ProductRunConfiguration::Dense { .. } => WorkerProduct::DensePointCloud,
        ProductRunConfiguration::Dem { .. } => WorkerProduct::Dem,
        ProductRunConfiguration::Ortho { .. } => WorkerProduct::Orthomosaic,
        ProductRunConfiguration::Mesh { mesh_source, .. } => WorkerProduct::Mesh {
            requires_colmap: *mesh_source
                == himmelcad_domain_photogrammetry::photolab_products::MeshSource::Dense,
        },
        ProductRunConfiguration::Splat { .. } => WorkerProduct::GaussianSplat,
    }
}

fn batch_worker_requirements(steps: &[BatchPipelineStep]) -> Vec<WorkerProduct> {
    steps
        .iter()
        .map(|step| match step {
            BatchPipelineStep::Alignment { preset, profile } => {
                let profile = preset
                    .as_ref()
                    .map(|preset| preset.profile)
                    .or(*profile)
                    .unwrap_or(AlignmentQualityProfile::Fast);
                WorkerProduct::Alignment {
                    dedode: profile != AlignmentQualityProfile::Fast,
                }
            }
            BatchPipelineStep::Product { configuration, .. } => {
                product_worker_requirement(configuration)
            }
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ResumeIdentityField {
    Kind,
    ConfigHash,
    InputHash,
    CheckpointMissing,
}

#[derive(Debug)]
struct ResumeRpcFailure {
    code: &'static str,
    field: Option<ResumeIdentityField>,
    message: String,
}

impl ResumeRpcFailure {
    fn mismatch(field: ResumeIdentityField, message: impl Into<String>) -> Self {
        Self {
            code: "resumeIdentityMismatch",
            field: Some(field),
            message: message.into(),
        }
    }

    fn rejected(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            field: None,
            message: message.into(),
        }
    }
}

fn validate_resume_identity(
    history: &himmelcad_domain_photogrammetry::photolab_jobs::PhotolabJob,
    kind: PhotolabJobKind,
    config_hash: &ObjectHash,
    input_hash: &ObjectHash,
) -> Result<(), ResumeRpcFailure> {
    if history.kind != kind {
        return Err(ResumeRpcFailure::mismatch(
            ResumeIdentityField::Kind,
            "The stored job kind does not match the resumable request.",
        ));
    }
    if history.config_hash != *config_hash {
        return Err(ResumeRpcFailure::mismatch(
            ResumeIdentityField::ConfigHash,
            "The stored configuration has changed since the checkpoint was committed.",
        ));
    }
    if history.input_hash != *input_hash {
        return Err(ResumeRpcFailure::mismatch(
            ResumeIdentityField::InputHash,
            "The job inputs have changed since the checkpoint was committed.",
        ));
    }
    Ok(())
}

fn supports_history_resume(kind: PhotolabJobKind) -> bool {
    matches!(
        kind,
        PhotolabJobKind::BuildDepthMaps
            | PhotolabJobKind::BuildDensePointCloud
            | PhotolabJobKind::BuildDem
            | PhotolabJobKind::BuildOrthomosaic
            | PhotolabJobKind::BuildGaussianSplat
            | PhotolabJobKind::Batch
    )
}

fn validate_history_resume_candidate(
    history: &himmelcad_domain_photogrammetry::photolab_jobs::PhotolabJob,
) -> Result<(), ResumeRpcFailure> {
    if !matches!(
        &history.state,
        PhotolabJobState::Failed { code, .. } if code == "interruptedRecoverable"
    ) {
        return Err(ResumeRpcFailure::rejected(
            "resumeNotAvailable",
            "Only an interrupted job with a committed recoverable checkpoint can be resumed.",
        ));
    }
    if !supports_history_resume(history.kind) {
        return Err(ResumeRpcFailure::rejected(
            "resumeNotSupported",
            "This PhotoLab job kind does not support cross-restart resume.",
        ));
    }
    Ok(())
}

async fn resume_history_job(
    params: ResumeJobParams,
    jobs: &JobManager,
    projects: &Arc<ProjectRuntime>,
) -> Result<StartJobResult, ResumeRpcFailure> {
    let history = jobs
        .status(&params.history_job_id)
        .await
        .map_err(|error| ResumeRpcFailure::rejected("resumeJobNotFound", error.to_string()))?;
    validate_history_resume_candidate(&history)?;
    let frozen = projects
        .frozen_job_request(&params.history_job_id)
        .map_err(|error| ResumeRpcFailure::rejected("resumeHistoryInvalid", error.to_string()))?
        .ok_or_else(|| {
            ResumeRpcFailure::mismatch(
                ResumeIdentityField::CheckpointMissing,
                "This job predates sidecar-owned resume requests and cannot be resumed safely.",
            )
        })?;
    validate_resume_identity(
        &history,
        frozen.job_kind,
        &frozen.config_hash,
        &frozen.input_hash,
    )?;

    match frozen.method.as_str() {
        "photolab.jobs.startProduct" => {
            let product: StartProductJobParams = serde_json::from_value(frozen.params.clone())
                .map_err(|error| {
                    ResumeRpcFailure::rejected("resumeHistoryInvalid", error.to_string())
                })?;
            resume_product_job(product, history, frozen, jobs, projects).await
        }
        "photolab.jobs.startBatch" => {
            let batch: StartBatchJobParams = serde_json::from_value(frozen.params.clone())
                .map_err(|error| {
                    ResumeRpcFailure::rejected("resumeHistoryInvalid", error.to_string())
                })?;
            resume_batch_job(batch, history, frozen, jobs, projects).await
        }
        _ => Err(ResumeRpcFailure::rejected(
            "resumeNotSupported",
            "The stored job request is not a resumable PhotoLab operation.",
        )),
    }
}

async fn resume_batch_job(
    params: StartBatchJobParams,
    history: himmelcad_domain_photogrammetry::photolab_jobs::PhotolabJob,
    frozen: FrozenJobRequest,
    jobs: &JobManager,
    projects: &Arc<ProjectRuntime>,
) -> Result<StartJobResult, ResumeRpcFailure> {
    let (job, frozen_plan) = prepare_batch_job(&params, projects).map_err(|error| {
        ResumeRpcFailure::rejected("resumePreparationFailed", error.to_string())
    })?;
    validate_resume_identity(&history, job.kind, &job.config_hash, &job.input_hash)?;
    let project_root = projects
        .compute_context()
        .map_err(|error| ResumeRpcFailure::rejected("resumePreparationFailed", error.to_string()))?
        .working_path;
    let checkpoint_path = project_root
        .join(".photolab/batch")
        .join(&frozen_plan.plan_sha256.0)
        .join("checkpoint.json");
    let checkpoint = checkpoint_path
        .is_file()
        .then(|| std::fs::read(&checkpoint_path))
        .transpose()
        .map_err(|error| ResumeRpcFailure::rejected("resumeCheckpointInvalid", error.to_string()))?
        .map(|bytes| serde_json::from_slice::<BatchCheckpoint>(&bytes))
        .transpose()
        .map_err(|error| ResumeRpcFailure::rejected("resumeCheckpointInvalid", error.to_string()))?
        .ok_or_else(|| checkpoint_missing("No committed batch checkpoint was found."))?;
    if checkpoint.steps_sha256 != job.config_hash {
        return Err(ResumeRpcFailure::mismatch(
            ResumeIdentityField::ConfigHash,
            "The batch checkpoint configuration does not match the stored job.",
        ));
    }
    if checkpoint.plan_sha256 != job.input_hash
        || checkpoint.input_sha256 != frozen_plan.input_sha256
    {
        return Err(ResumeRpcFailure::mismatch(
            ResumeIdentityField::InputHash,
            "The batch checkpoint inputs do not match the stored job.",
        ));
    }
    if checkpoint.schema_version != 3 || checkpoint.completed_steps == 0 {
        return Err(checkpoint_missing(
            "The batch checkpoint has no committed step to resume.",
        ));
    }
    let publisher = Arc::clone(projects);
    let admission = himmelcad_domain_photogrammetry::job_runtime::JobAdmission {
        toolchain_preflight: Some(
            worker_toolchain_preflight(
                PhotolabJobKind::Batch,
                &batch_worker_requirements(&params.steps),
            )
            .into_admission(),
        ),
        ..Default::default()
    };
    jobs.start_with_frozen_request_and_admission(job, frozen, admission, move |context| {
        run_batch_pipeline(params, frozen_plan, &context, &publisher)
    })
    .await
    .map_err(|error| ResumeRpcFailure::rejected("resumeStartFailed", error.to_string()))
}

async fn resume_product_job(
    params: StartProductJobParams,
    history: himmelcad_domain_photogrammetry::photolab_jobs::PhotolabJob,
    frozen: FrozenJobRequest,
    jobs: &JobManager,
    projects: &Arc<ProjectRuntime>,
) -> Result<StartJobResult, ResumeRpcFailure> {
    match history.kind {
        PhotolabJobKind::BuildGaussianSplat => {
            let (prepared_job, _, _, _) =
                prepare_brush_product_job(params.clone(), projects, None, false).map_err(
                    |error| {
                        ResumeRpcFailure::rejected("resumePreparationFailed", error.to_string())
                    },
                )?;
            validate_resume_identity(
                &history,
                prepared_job.kind,
                &prepared_job.config_hash,
                &prepared_job.input_hash,
            )?;
            let (job, request, runtime, lineage) =
                prepare_brush_product_job(params, projects, None, true)
                    .map_err(|error| checkpoint_missing(error.to_string()))?;
            let publisher = Arc::clone(projects);
            let admission = himmelcad_domain_photogrammetry::job_runtime::JobAdmission {
                toolchain_preflight: Some(
                    worker_toolchain_preflight(
                        PhotolabJobKind::BuildGaussianSplat,
                        &[WorkerProduct::GaussianSplat],
                    )
                    .into_admission(),
                ),
                ..Default::default()
            };
            jobs.start_with_frozen_request_and_admission(job, frozen, admission, move |context| {
                let mut outcome = runtime
                    .run(&request, &context)
                    .map_err(JobWorkerError::from)?;
                let project_transform = pinned_product_gcp_optimization(&publisher, &lineage)
                    .map_err(|error| worker_error("projectRead", &error.to_string()))?
                    .map(|record| record.artifact.result.transform);
                outcome.prepared_splats = Some(
                    tile_brush_ply(
                        &outcome.output_path,
                        &outcome.scratch_path.join("prepared-splats"),
                        project_transform,
                        &context.cancellation,
                    )
                    .map_err(map_splat_tiler_error)?,
                );
                context.check_cancelled()?;
                publisher
                    .publish_brush_outcome(outcome, &lineage)
                    .map_err(|error| worker_error("projectPublish", &error.to_string()))?;
                Ok(())
            })
            .await
            .map_err(|error| ResumeRpcFailure::rejected("resumeStartFailed", error.to_string()))
        }
        PhotolabJobKind::BuildDepthMaps | PhotolabJobKind::BuildDensePointCloud => {
            let prepared = prepare_mvs_product_job(params, projects, None).map_err(|error| {
                ResumeRpcFailure::rejected("resumePreparationFailed", error.to_string())
            })?;
            validate_resume_identity(
                &history,
                prepared.job.kind,
                &prepared.job.config_hash,
                &prepared.job.input_hash,
            )?;
            let (scene_path, scene_sha256) =
                prepared.reusable_scene_manifest.clone().unwrap_or_else(|| {
                    let path = prepared.scene_root.join("scene.json");
                    let sha256 = std::fs::read(&path)
                        .map(|bytes| ObjectHash::of_bytes(&bytes))
                        .unwrap_or_else(|_| ObjectHash::of_bytes(b"missing-scene"));
                    (path, sha256)
                });
            if !scene_path.is_file()
                || prepared
                    .runtime
                    .compatible_resume_checkpoint(&scene_sha256, &prepared.settings)
                    .map_err(|error| {
                        ResumeRpcFailure::rejected("resumeCheckpointInvalid", error.to_string())
                    })?
                    .is_none()
            {
                return Err(checkpoint_missing(
                    "No compatible MVS checkpoint was found for the stored job identity.",
                ));
            }
            let publisher = Arc::clone(projects);
            let worker_product = if prepared.job.kind == PhotolabJobKind::BuildDepthMaps {
                WorkerProduct::DepthMaps
            } else {
                WorkerProduct::DensePointCloud
            };
            let admission = himmelcad_domain_photogrammetry::job_runtime::JobAdmission {
                toolchain_preflight: Some(
                    worker_toolchain_preflight(prepared.job.kind, &[worker_product])
                        .into_admission(),
                ),
                ..Default::default()
            };
            jobs.start_with_frozen_request_and_admission(
                prepared.job.clone(),
                frozen,
                admission,
                move |context| {
                    let scene = prepare_or_reuse_mvs_scene(&prepared, &context)?;
                    let resume = prepared
                        .runtime
                        .compatible_resume_checkpoint(&scene.manifest_sha256, &prepared.settings)?
                        .ok_or_else(|| {
                            worker_error(
                                "resumeCheckpointMissing",
                                "the validated MVS checkpoint is no longer available",
                            )
                        })?;
                    let request = MvsRunRequest {
                        job_id: prepared.operation_id,
                        scene_manifest_path: scene.manifest_path,
                        scene_manifest_sha256: scene.manifest_sha256,
                        device: MvsComputeDevice::Cpu {
                            threads: portable_mvs_threads(),
                        },
                        settings: prepared.settings,
                        fuse_dense_point_cloud: prepared.fuse_dense_point_cloud,
                        resume: Some(resume),
                    };
                    let mut outcome = prepared
                        .runtime
                        .run(&request, &context)
                        .map_err(JobWorkerError::from)?;
                    if let Some(dense) = outcome.output.dense_point_cloud.as_ref() {
                        outcome.potree = Some(
                            prepare_dense_potree(
                                &outcome.output_path.join(&dense.relative_path),
                                &outcome.scratch_path.join("potree"),
                                &potree_converter_executable()?,
                                &context.cancellation,
                            )
                            .map_err(map_dense_prep_error)?,
                        );
                    }
                    context.check_cancelled()?;
                    publisher
                        .publish_mvs_outcome(
                            outcome,
                            &prepared.camera_entity_ids,
                            &prepared.image_mask_scope.scope_sha256,
                            &prepared.lineage,
                            &context.cancellation,
                        )
                        .map_err(|error| map_project_publish_error(error, &context.cancellation))?;
                    Ok(())
                },
            )
            .await
            .map_err(|error| ResumeRpcFailure::rejected("resumeStartFailed", error.to_string()))
        }
        PhotolabJobKind::BuildDem | PhotolabJobKind::BuildOrthomosaic => {
            let prepared = prepare_raster_product_job(params, projects, None).map_err(|error| {
                ResumeRpcFailure::rejected("resumePreparationFailed", error.to_string())
            })?;
            validate_resume_identity(
                &history,
                prepared.job.kind,
                &prepared.job.config_hash,
                &prepared.job.input_hash,
            )?;
            let tools = gdal_executables().map_err(|error| {
                ResumeRpcFailure::rejected("resumePreparationFailed", error.to_string())
            })?;
            let runtime = open_raster_runtime(&prepared.project_root, &tools).map_err(|error| {
                ResumeRpcFailure::rejected("resumePreparationFailed", error.to_string())
            })?;
            let kind = match prepared.job.kind {
                PhotolabJobKind::BuildDem => "buildDem",
                PhotolabJobKind::BuildOrthomosaic => "buildOrthomosaic",
                _ => unreachable!("raster branch checked above"),
            };
            match runtime
                .validate_resume_checkpoint_identity(
                    kind,
                    &prepared.job.config_hash,
                    &prepared.job.input_hash,
                    &prepared.operation_id,
                )
                .await
                .map_err(|error| {
                    ResumeRpcFailure::rejected("resumeCheckpointInvalid", error.to_string())
                })? {
                RasterResumeCheckpointValidation::Compatible => {}
                RasterResumeCheckpointValidation::ConfigHashMismatch => {
                    return Err(ResumeRpcFailure::mismatch(
                        ResumeIdentityField::ConfigHash,
                        "The raster checkpoint configuration does not match the stored job.",
                    ));
                }
                RasterResumeCheckpointValidation::InputHashMismatch => {
                    return Err(ResumeRpcFailure::mismatch(
                        ResumeIdentityField::InputHash,
                        "The raster checkpoint inputs do not match the stored job.",
                    ));
                }
                RasterResumeCheckpointValidation::Missing
                | RasterResumeCheckpointValidation::Invalid => {
                    return Err(checkpoint_missing(
                        "No valid committed raster checkpoint was found.",
                    ));
                }
            }
            let publisher = Arc::clone(projects);
            let gsd = match &prepared.configuration {
                ProductRunConfiguration::Dem {
                    resolution_meters_per_pixel,
                    ..
                }
                | ProductRunConfiguration::Ortho {
                    resolution_meters_per_pixel,
                    ..
                } => *resolution_meters_per_pixel,
                _ => unreachable!("raster branch checked above"),
            };
            let (bounds, dense_point_count) = if prepared.job.kind == PhotolabJobKind::BuildDem {
                let (_, record) = projects
                    .latest_dense_mvs_dataset_for_lineage(&prepared.lineage)
                    .map_err(|error| {
                        ResumeRpcFailure::rejected("resumePreparationFailed", error.to_string())
                    })?;
                let potree = record.potree.ok_or_else(|| {
                    ResumeRpcFailure::rejected(
                        "resumePreparationFailed",
                        "dense point cloud has no frozen bounds for disk preflight",
                    )
                })?;
                ((potree.bounds_min, potree.bounds_max), potree.point_count)
            } else {
                let summary = &prepared
                    .dem_dataset
                    .as_ref()
                    .expect("orthomosaic preparation pins a DEM")
                    .1
                    .summary;
                (
                    (
                        [
                            summary.grid.bounds.minimum_east,
                            summary.grid.bounds.minimum_north,
                            0.0,
                        ],
                        [
                            summary.grid.bounds.maximum_east,
                            summary.grid.bounds.maximum_north,
                            0.0,
                        ],
                    ),
                    0,
                )
            };
            let raster_pixels = himmelcad_domain_photogrammetry::job_runtime::raster_pixel_count(
                bounds.0, bounds.1, gsd,
            )
            .ok_or_else(|| {
                ResumeRpcFailure::rejected(
                    "resumePreparationFailed",
                    "raster extent or GSD is invalid for disk preflight",
                )
            })?;
            let disk_scale =
                himmelcad_domain_photogrammetry::job_runtime::DiskEstimateScale::DenseRaster {
                    point_count: dense_point_count,
                    raster_pixels,
                };
            let disk_estimate =
                himmelcad_domain_photogrammetry::job_runtime::disk_estimate_components(
                    prepared.job.kind,
                    disk_scale,
                );
            let raster_memory_plan = if prepared.job.kind == PhotolabJobKind::BuildDem {
                const GIB: u64 = 1024 * 1024 * 1024;
                let physical_memory_bytes =
                    probe_hardware().map_or(8 * GIB, |hardware| hardware.ram_bytes);
                let machine_usable_bytes = physical_memory_bytes
                    .saturating_sub(memory_os_ui_reserve_bytes(physical_memory_bytes));
                let usable_memory_bytes = jobs.usable_memory_bytes(physical_memory_bytes).await;
                Some((
                    plan_raster_preparation_memory(
                        dense_point_count,
                        disk_estimate.output_bytes,
                        usable_memory_bytes,
                    ),
                    machine_usable_bytes,
                ))
            } else {
                None
            };
            let disk_path = prepared
                .project_root
                .join(".photolab/raster-inputs")
                .join(&prepared.operation_id);
            let admission = himmelcad_domain_photogrammetry::job_runtime::JobAdmission {
                disk_preflight: Some(
                    himmelcad_domain_photogrammetry::job_runtime::DiskPreflight::for_job(
                        prepared.job.kind,
                        disk_scale,
                        disk_path,
                    ),
                ),
                toolchain_preflight: Some(
                    worker_toolchain_preflight(
                        prepared.job.kind,
                        &[product_worker_requirement(&prepared.configuration)],
                    )
                    .into_admission(),
                ),
                memory_preflight: raster_memory_plan.as_ref().map(
                    |(plan, machine_usable_bytes)| MemoryPreflight {
                        predicted_bytes: plan.predicted_peak_bytes,
                        available_bytes: plan.memory.envelope_bytes,
                        machine_usable_bytes: *machine_usable_bytes,
                        memory: plan.memory.clone(),
                        refusal: plan.refusal.clone(),
                    },
                ),
                ..Default::default()
            };
            jobs.start_with_frozen_request_and_disk_admission(
                prepared.job.clone(),
                frozen,
                admission,
                disk_estimate,
                move |context| {
                    run_raster_product(
                        prepared,
                        raster_memory_plan.map(|(plan, _)| plan),
                        &context,
                        &publisher,
                    )
                },
            )
            .await
            .map_err(|error| ResumeRpcFailure::rejected("resumeStartFailed", error.to_string()))
        }
        _ => Err(ResumeRpcFailure::rejected(
            "resumeNotSupported",
            "This PhotoLab job kind does not support cross-restart resume.",
        )),
    }
}

fn checkpoint_missing(message: impl Into<String>) -> ResumeRpcFailure {
    ResumeRpcFailure::mismatch(ResumeIdentityField::CheckpointMissing, message)
}

type PreparedGcpOptimizationJob = (
    NewPhotolabJob,
    PathBuf,
    PathBuf,
    PathBuf,
    PathBuf,
    RunGcpOptimizationParams,
    Vec<himmelcad_domain_photogrammetry::image_commit::ProjectCameraImageRecord>,
    Vec<project_runtime::CameraCalibrationGroupRecord>,
    Vec<ColmapCalibrationGroup>,
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
    context: &project_runtime::ProjectComputeContext,
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
            ..
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
        let BatchPipelineStep::Product { configuration, .. } = step else {
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
            ProductRunConfiguration::Mesh { mesh_source, .. } => {
                match mesh_source {
                    himmelcad_domain_photogrammetry::photolab_products::MeshSource::Dem => {
                        anyhow::ensure!(dem_ready, "DEM mesh needs a prior DEM node");
                    }
                    himmelcad_domain_photogrammetry::photolab_products::MeshSource::Dense => {
                        anyhow::ensure!(dense_ready, "dense mesh needs a prior dense-cloud node");
                    }
                }
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
    context: &project_runtime::ProjectComputeContext,
    camera_entity_ids: &[String],
    processing_set: Option<&project_runtime::ProcessingSetRecord>,
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
    for step in &params.steps {
        let BatchPipelineStep::Product {
            gcp_optimization_entity_id: ProductGcpSelection::Explicit(entity_id),
            ..
        } = step
        else {
            continue;
        };
        let entity = context
            .manifest
            .entities
            .get(&entity_id.0)
            .context("selected batch GCP optimization revision does not exist")?;
        anyhow::ensure!(
            entity.kind == EntityKind::AlignmentRun && entity.id.0.contains(":alignment-gcp:"),
            "selected batch GCP optimization binding has the wrong entity kind"
        );
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
            ..
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
    context: &project_runtime::ProjectComputeContext,
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
                let (_, request, runtime, dedode, processing_set_id, _, refusal) =
                    prepare_alignment_job(
                        StartAlignmentJobParams {
                            operation_id: format!("{}-{:02}-alignment", params.operation_id, index),
                            profile,
                            camera_entity_ids: params.camera_entity_ids.clone(),
                            processing_set_id: params.processing_set_id.clone(),
                            overrides,
                        },
                        projects,
                        fallback_alignment_usable_memory_bytes(),
                        None,
                    )
                    .map_err(|error| worker_error("batchPrepare", &error.to_string()))?;
                if let Some(refusal) = refusal {
                    return Err(JobWorkerError::Failed {
                        code: refusal.code,
                        message: refusal.message,
                    });
                }
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
                    .publish_colmap_outcome_for_processing_set(
                        outcome,
                        processing_set_id,
                        &context.cancellation,
                    )
                    .map_err(|error| map_project_publish_error(error, &context.cancellation))?;
            }
            BatchPipelineStep::Product {
                mut configuration,
                gcp_optimization_entity_id,
            } => {
                let source_dem_entity_id = match &mut configuration {
                    ProductRunConfiguration::Ortho {
                        source_dem_entity_id,
                        ..
                    }
                    | ProductRunConfiguration::Mesh {
                        mesh_source:
                            himmelcad_domain_photogrammetry::photolab_products::MeshSource::Dem,
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
                                        configuration: ProductRunConfiguration::Dem { .. },
                                        ..
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
                    gcp_optimization_entity_id,
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
        let checkpoint_hash = write_batch_checkpoint(
            &checkpoint_path,
            &frozen_plan.plan_sha256,
            &steps_sha256,
            &input_sha256,
            index + 1,
        )
        .map_err(|error| worker_error("batchCheckpoint", &error.to_string()))?;
        let checkpoint_progress = JobProgress {
            stage: PhotolabStage {
                kind: PhotolabStageKind::Finalizing,
                index: base + 31,
                stage_count: total,
                label: format!("Batch step {} committed atomically", index + 1),
            },
            metrics: ProgressMetrics {
                completed_units: 1,
                total_units: Some(1),
                completed_bytes: 0,
                total_bytes: None,
            },
        };
        context
            .checkpoints
            .record_committed_blocking(
                u64::try_from(index + 1).unwrap_or(u64::MAX),
                checkpoint_progress.clone(),
                format!("batch:{}:{}", params.operation_id, index + 1),
                checkpoint_hash,
            )
            .map_err(JobWorkerError::from)?;
        context
            .progress
            .report_blocking(checkpoint_progress)
            .map_err(JobWorkerError::from)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)] // Batch-product execution mirrors the persisted run context.
fn execute_batch_product(
    batch_id: &str,
    index: usize,
    configuration: ProductRunConfiguration,
    gcp_optimization_entity_id: ProductGcpSelection,
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
                    gcp_optimization_entity_id: gcp_optimization_entity_id.clone(),
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
                    &node.cancellation,
                )
                .map_err(|error| map_project_publish_error(error, &node.cancellation))?;
        }
        config @ ProductRunConfiguration::Dem { .. }
        | config @ ProductRunConfiguration::Ortho { .. } => {
            let prepared = prepare_raster_product_job(
                StartProductJobParams {
                    operation_id,
                    configuration: config,
                    processing_set_id: processing_set_id.cloned(),
                    source_alignment_entity_id: None,
                    gcp_optimization_entity_id: gcp_optimization_entity_id.clone(),
                },
                projects,
                Some(camera_entity_ids),
            )
            .map_err(|error| worker_error("batchPrepare", &error.to_string()))?;
            let node = context.with_progress_window(base, total);
            run_raster_product(prepared, None, &node, projects)?;
        }
        config @ ProductRunConfiguration::Mesh { .. } => {
            let prepared = prepare_mesh_job(
                StartProductJobParams {
                    operation_id,
                    configuration: config,
                    processing_set_id: processing_set_id.cloned(),
                    source_alignment_entity_id: None,
                    gcp_optimization_entity_id: gcp_optimization_entity_id.clone(),
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
                    gcp_optimization_entity_id,
                },
                projects,
                Some(camera_entity_ids),
                false,
            )
            .map_err(|error| worker_error("batchPrepare", &error.to_string()))?;
            let node = context.with_progress_window(base, total);
            let mut outcome = runtime.run(&request, &node).map_err(JobWorkerError::from)?;
            let transform = pinned_product_gcp_optimization(projects, &lineage)
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
    context: &project_runtime::ProjectComputeContext,
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
) -> anyhow::Result<ObjectHash> {
    let value = BatchCheckpoint {
        schema_version: 3,
        plan_sha256: plan_sha256.clone(),
        steps_sha256: steps_sha256.clone(),
        input_sha256: input_sha256.clone(),
        completed_steps,
    };
    let temporary = path.with_extension("json.pending");
    let bytes = serde_json::to_vec(&value)?;
    let mut file = std::fs::File::create(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(temporary, path)?;
    if let Some(parent) = path.parent() {
        himmelcad_sidecar::durable_fs::sync_dir(parent)?;
    }
    Ok(ObjectHash::of_bytes(&bytes))
}

fn prepare_gcp_optimization_job(
    params: StartGcpOptimizationJobParams,
    projects: &ProjectRuntime,
) -> anyhow::Result<PreparedGcpOptimizationJob> {
    let context = projects.compute_context()?;
    let explicit_source = params.source_alignment_entity_id.is_some();
    let alignment = resolve_gcp_source_alignment(
        projects,
        params.processing_set_id.as_ref(),
        params.source_alignment_entity_id.as_ref(),
        "optimization start",
    )?;
    let snapshot = projects.gcp_optimization_snapshot(&params.snapshot_sha256)?;
    match snapshot.source_alignment_entity_id.as_ref() {
        Some(snapshot_source) => anyhow::ensure!(
            snapshot_source == &alignment.source_alignment_entity_id,
            "GCP optimization snapshot belongs to another source alignment"
        ),
        None => anyhow::ensure!(
            !explicit_source,
            "explicit GCP optimization source must be pinned in its snapshot"
        ),
    }
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
        source_alignment_entity_id: alignment.source_alignment_entity_id.clone(),
        cameras: Vec::new(),
        tie_points: Vec::new(),
        options: GcpSolverOptions::default(),
    };
    let input = serde_json::to_vec(&(
        &params.snapshot_sha256,
        &alignment.source_alignment_entity_id,
        alignment_dataset.to_string_lossy(),
    ))?;
    let job = NewPhotolabJob {
        id: PhotolabJobId(params.operation_id),
        kind: PhotolabJobKind::OptimizeAlignment,
        config_hash: ObjectHash::of_bytes(&serde_json::to_vec(&run_params.options)?),
        input_hash: ObjectHash::of_bytes(&input),
        progress: gcp_job_progress(
            himmelcad_domain_photogrammetry::photolab_gcp_optimization::GcpOptimizationProgress {
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
        projects.calibration_partition_for_alignment(&lineage.source_alignment_entity_id)?,
        lineage,
    ))
}

fn attach_camera_reference_priors(
    prepared: &mut [himmelcad_domain_photogrammetry::mvs_scene::PreparedGcpCamera],
    camera_images: &[himmelcad_domain_photogrammetry::image_commit::ProjectCameraImageRecord],
    alignment_dataset: &Path,
    calibration_groups: &[project_runtime::CameraCalibrationGroupRecord],
    frozen_calibration_partition: &[ColmapCalibrationGroup],
) -> anyhow::Result<Vec<MaterializedCameraMapEntry>> {
    let camera_map_path = alignment_dataset.join("camera-map.json");
    let camera_map = serde_json::from_slice::<Vec<MaterializedCameraMapEntry>>(
        &std::fs::read(&camera_map_path).with_context(|| {
            format!(
                "Failed to read the alignment camera map at {}. Re-run the alignment to rebuild it",
                camera_map_path.display()
            )
        })?,
    )
    .with_context(|| {
        format!(
            "The alignment camera map at {} is corrupt. Re-run the alignment to rebuild it",
            camera_map_path.display()
        )
    })?;
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
        if let Some(frozen_group) = frozen_calibration_partition
            .iter()
            .find(|group| group.camera_entity_ids.contains(&camera.entity_id.0))
        {
            entry.camera.calibration_group_id = frozen_group.group_id.clone();
            entry.camera.intrinsics_policy = calibration_groups
                .iter()
                .find(|group| group.entity_id.0 == frozen_group.group_id)
                .map_or(
                    himmelcad_domain_photogrammetry::photolab_gcp_optimization::GcpIntrinsicsPolicy::Fixed,
                    |group| group.intrinsics_policy,
                );
        } else if let Some(group) = calibration_groups
            .iter()
            .find(|group| group.camera_entity_ids.contains(&camera.entity_id))
        {
            entry.camera.calibration_group_id = group.entity_id.0.clone();
            entry.camera.intrinsics_policy = group.intrinsics_policy;
        } else {
            entry.camera.calibration_group_id = format!("ungrouped:{}", camera.entity_id.0);
            entry.camera.intrinsics_policy =
                himmelcad_domain_photogrammetry::photolab_gcp_optimization::GcpIntrinsicsPolicy::Fixed;
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
        let rtk_fixed = camera.metadata.status_tags.contains(
            &himmelcad_domain_photogrammetry::photolab_products::ImageProductTag::RtkFixed,
        );
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
    Ok(camera_map)
}

fn gcp_job_progress(
    progress: himmelcad_domain_photogrammetry::photolab_gcp_optimization::GcpOptimizationProgress,
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
) -> himmelcad_domain_photogrammetry::job_runtime::JobWorkerError {
    if matches!(error, GcpOptimizationRuntimeError::Cancelled) {
        himmelcad_domain_photogrammetry::job_runtime::JobWorkerError::Cancelled
    } else {
        himmelcad_domain_photogrammetry::job_runtime::JobWorkerError::Failed {
            code: "gcpOptimization".into(),
            message: error.to_string(),
        }
    }
}

#[allow(clippy::type_complexity)] // Private orchestration state is consumed immediately by the job runner.
fn prepare_alignment_job(
    params: StartAlignmentJobParams,
    projects: &ProjectRuntime,
    usable_memory_bytes: u64,
    measured_extraction_bytes_per_pixel: Option<u64>,
) -> anyhow::Result<(
    NewPhotolabJob,
    ColmapRunRequest,
    ColmapRuntime,
    Option<(DedodeRuntime, DedodeRunRequest)>,
    Option<EntityId>,
    AlignmentMemoryPlan,
    Option<JobAdmissionRefusal>,
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
    let feature_budget = params
        .overrides
        .feature_budget
        .map(|budget| budget.clamp(1_024, 64_000))
        .unwrap_or_else(|| alignment_feature_budget(params.profile, &resolved));
    let image_dimensions = camera_images
        .iter()
        .map(|camera| {
            camera
                .metadata
                .inspected_photo
                .metadata
                .exif
                .dimensions
                .map(|dimensions| (dimensions.width_pixels, dimensions.height_pixels))
                .with_context(|| {
                    format!(
                        "image {} has no measured pixel dimensions for memory admission",
                        camera.entity_id.0
                    )
                })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let logical_cpus =
        u16::try_from(std::thread::available_parallelism().map_or(1, std::num::NonZero::get))
            .unwrap_or(u16::MAX)
            .max(1);
    let mut memory_plan = plan_alignment_memory(&AlignmentMemoryRequest {
        usable_bytes: usable_memory_bytes,
        logical_cpus,
        image_dimensions,
        max_image_edge: resolved.max_image_edge,
        keypoints: feature_budget,
        neural_matching: true,
        measured_extraction_bytes_per_pixel,
    });
    // Test-only operational override used by the PhotoLab 24-image smoke to exercise the
    // tiled path on machines whose normal memory envelope admits full-image extraction.
    let force_extraction_tiling =
        std::env::var_os("HIMMELCAD_PHOTOLAB_FORCE_EXTRACTION_TILES").is_some();
    if force_extraction_tiling {
        anyhow::ensure!(
            std::env::var("HIMMELCAD_PHOTOLAB_FORCE_EXTRACTION_TILES").as_deref() == Ok("2x1"),
            "HIMMELCAD_PHOTOLAB_FORCE_EXTRACTION_TILES currently accepts only 2x1"
        );
        anyhow::ensure!(
            !memory_plan
                .memory
                .degradations
                .iter()
                .any(|degradation| matches!(
                    degradation,
                    himmelcad_domain_photogrammetry::photolab_jobs::PhotolabMemoryDegradation::ExtractionEdgeReduced { .. }
                )),
            "forced extraction tiling cannot override the minimum-tile memory safety fallback"
        );
        let tiling = himmelcad_domain_photogrammetry::job_runtime::AlignmentExtractionTiling {
            columns: 2,
            rows: 1,
            tiles: 2,
            overlap_px: himmelcad_domain_photogrammetry::job_runtime::EXTRACTION_TILE_OVERLAP_PX,
        };
        memory_plan.extraction_tiling = Some(tiling);
        memory_plan.memory.time_first_choices.retain(|choice| {
            !matches!(
                choice,
                himmelcad_domain_photogrammetry::photolab_jobs::PhotolabMemoryTimeFirstChoice::ExtractionTiled { .. }
            )
        });
        memory_plan.memory.time_first_choices.push(
            himmelcad_domain_photogrammetry::photolab_jobs::PhotolabMemoryTimeFirstChoice::ExtractionTiled {
                tiles: tiling.tiles,
                overlap_px: tiling.overlap_px,
            },
        );
    }
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
        // A forced Fast smoke makes ALIKED the primary mapping store so the resulting
        // reconstruction actually consumes the tiled feature database. SIFT remains its
        // ordinary rescue if tiled ALIKED cannot reconstruct the image set.
        mapping_store: if force_extraction_tiling {
            MappingFeatureStore::Aliked
        } else {
            alignment_primary_store(params.profile)
        },
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
        aliked_max_features: memory_plan.keypoints,
        sift_max_features: memory_plan.keypoints,
        sift_rescue_only: params.profile == AlignmentQualityProfile::Fast,
        max_image_size: memory_plan.extraction_edge,
        extraction_tiling: memory_plan.extraction_tiling,
        memory_envelope_bytes: memory_plan.memory.envelope_bytes,
        extraction_memory_unit_bytes: memory_plan.extraction_unit_bytes,
        logical_cpus,
        feature_worker_threads: colmap_feature_worker_threads(&memory_plan),
        aliked_matching_worker_threads: colmap_aliked_matching_worker_threads(&memory_plan),
        matching_worker_threads: colmap_matching_worker_threads(usable_memory_bytes, logical_cpus),
        degradations: memory_plan.memory.degradations.clone(),
        products: ColmapProductRequest::default(),
        intrinsics_refinement: ColmapIntrinsicsRefinement::Refine,
        pinned_calibration_group_ids: Vec::new(),
    };
    request.calibration_groups = projects.calibration_groups_for_camera_scope(
        &camera_images
            .iter()
            .map(|camera| camera.entity_id.0.clone())
            .collect::<Vec<_>>(),
    )?;
    let (refinement, pinned) = plan_intrinsics_refinement(
        &request.calibration_groups,
        &calibration_group_policies(projects)?,
    );
    request.intrinsics_refinement = refinement;
    request.pinned_calibration_group_ids = pinned;
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
    let refusal = alignment_admission_refusal(params.profile, memory_plan.extraction_tiling);
    Ok((
        job,
        request,
        runtime,
        dedode,
        processing_set_id,
        memory_plan,
        refusal,
    ))
}

fn alignment_admission_refusal(
    profile: AlignmentQualityProfile,
    extraction_tiling: Option<AlignmentExtractionTiling>,
) -> Option<JobAdmissionRefusal> {
    (profile != AlignmentQualityProfile::Fast && extraction_tiling.is_some()).then(|| {
        JobAdmissionRefusal {
            code: ALIGNMENT_NEEDS_UNTILED_EXTRACTION_CODE.into(),
            message: ALIGNMENT_NEEDS_UNTILED_EXTRACTION_MESSAGE.into(),
        }
    })
}

/// Per-group intrinsics policy, keyed by the immutable calibration-group id.
///
/// Implicit metadata-derived groups have no persisted record and fall back to the product default.
fn calibration_group_policies(
    projects: &ProjectRuntime,
) -> anyhow::Result<BTreeMap<String, GcpIntrinsicsPolicy>> {
    Ok(projects
        .list_calibration_groups()?
        .into_iter()
        .map(|group| (group.entity_id.0, group.intrinsics_policy))
        .collect())
}

/// Does this group's effective policy pin its interior orientation for the whole run?
///
/// A group is pinned when it carries a complete embedded calibration, or when its explicit policy
/// is `Fixed` and it actually has a laboratory seed to preserve. `Auto`, `Prior` and `Custom` all
/// refine: COLMAP cannot honour a partial parameter mask, and the in-house GCP adjustment refines
/// the exact mask afterwards.
fn calibration_group_is_pinned(
    group: &ColmapCalibrationGroup,
    policies: &BTreeMap<String, GcpIntrinsicsPolicy>,
) -> bool {
    let Some(seed) = group.seed.as_ref() else {
        return false;
    };
    seed.full_brown_calibration.is_some()
        || matches!(
            policies.get(&group.group_id),
            Some(GcpIntrinsicsPolicy::Fixed)
        )
}

/// Maps the per-group policy outcomes onto the three run strategies COLMAP can actually execute.
///
/// All pinned freezes the mapper, none pinned refines it, and a disagreeing run refines every
/// group and pins the fixed ones back afterwards. The previous run-wide binary froze a
/// metadata-poor mission whenever any other mission carried embedded calibration.
fn plan_intrinsics_refinement(
    groups: &[ColmapCalibrationGroup],
    policies: &BTreeMap<String, GcpIntrinsicsPolicy>,
) -> (ColmapIntrinsicsRefinement, Vec<String>) {
    let pinned = groups
        .iter()
        .filter(|group| calibration_group_is_pinned(group, policies))
        .map(|group| group.group_id.clone())
        .collect::<Vec<_>>();
    if pinned.is_empty() {
        return (ColmapIntrinsicsRefinement::Refine, Vec::new());
    }
    if pinned.len() == groups.len() {
        // Matching robustness stays profile-dependent; a fully calibrated run never drifts.
        return (
            ColmapIntrinsicsRefinement::FreezeReliableEmbedded,
            Vec::new(),
        );
    }
    (ColmapIntrinsicsRefinement::Refine, pinned)
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

/// Replaces the merge plan's frozen seeds with the intrinsics each input alignment solved.
///
/// The joint solve otherwise restarts a metadata-poor block from COLMAP defaults and discards the
/// per-mission refinement that block already earned. Pinned groups keep their exact frozen
/// calibration, which is the value the mixed-policy pass restores after the joint solve.
fn reseed_merge_calibration_groups(
    groups: &mut [ColmapCalibrationGroup],
    input_dataset_roots: &std::collections::HashMap<String, PathBuf>,
    policies: &BTreeMap<String, GcpIntrinsicsPolicy>,
) {
    let mut solved = BTreeMap::new();
    for root in input_dataset_roots.values() {
        let Ok(seeds) =
            himmelcad_domain_photogrammetry::colmap_runtime::solved_calibration_seeds(root)
        else {
            continue;
        };
        solved.extend(seeds);
    }
    for group in groups {
        if calibration_group_is_pinned(group, policies) {
            continue;
        }
        let mut members = group
            .camera_entity_ids
            .iter()
            .map(|camera_id| solved.get(camera_id));
        let Some(Some(first)) = members.next() else {
            continue;
        };
        // One calibration group is one COLMAP camera. Disagreeing members mean the group was split
        // across inputs, so the conservative choice is to keep the plan's own seed.
        if !members.all(|seed| seed == Some(first)) {
            continue;
        }
        group.seed = Some(first.clone());
    }
}

#[allow(clippy::type_complexity)] // Private orchestration state is consumed immediately by the job runner.
fn prepare_alignment_merge_job(
    params: StartAlignmentMergeJobParams,
    projects: &ProjectRuntime,
    usable_memory_bytes: u64,
    measured_extraction_bytes_per_pixel: Option<u64>,
) -> anyhow::Result<(
    NewPhotolabJob,
    ColmapRunRequest,
    ColmapRuntime,
    Option<(DedodeRuntime, DedodeRunRequest)>,
    EntityId,
    Option<ColmapRunOutcome>,
    Option<himmelcad_domain_photogrammetry::alignment_merge_runtime::SharedControlMergeOutcome>,
    bool,
    AlignmentMemoryPlan,
    Option<JobAdmissionRefusal>,
)> {
    let merge = projects.alignment_merge_compute_context(&params.merge_entity_id)?;
    let merge_profile = merge.record.merge_profile.clone().unwrap_or_else(|| {
        project_runtime::AlignmentMergeProfileSnapshot {
            id: "photolab.factory.qualityHybrid".into(),
            name: "Quality Hybrid".into(),
            profile: AlignmentQualityProfile::QualityHybrid,
            overrides: project_runtime::AlignmentMergeProfileOverrides {
                max_image_edge: Some(8_192),
                keypoints_per_megapixel: Some(8_000),
                sequential_overlap: Some(24),
                feature_budget: Some(16_000),
            },
        }
    });
    let shared_control_only = merge.record.connections.iter().all(|connection| {
        matches!(
            connection,
            project_runtime::AlignmentMergeConnection::SharedControls { .. }
        )
    });
    let camera_entity_ids = merge
        .record
        .camera_entity_ids
        .iter()
        .map(|id| id.0.clone())
        .collect::<Vec<_>>();
    let (mut job, mut request, runtime, dedode, _, memory_plan, refusal) = prepare_alignment_job(
        StartAlignmentJobParams {
            operation_id: params.operation_id,
            profile: if shared_control_only {
                AlignmentQualityProfile::Fast
            } else {
                merge_profile.profile
            },
            camera_entity_ids,
            processing_set_id: None,
            overrides: if shared_control_only {
                AlignmentJobOverrides::default()
            } else {
                AlignmentJobOverrides {
                    max_image_edge: merge_profile.overrides.max_image_edge,
                    keypoints_per_megapixel: merge_profile.overrides.keypoints_per_megapixel,
                    sequential_overlap: merge_profile.overrides.sequential_overlap,
                    feature_budget: merge_profile.overrides.feature_budget,
                }
            },
        },
        projects,
        usable_memory_bytes,
        measured_extraction_bytes_per_pixel,
    )?;
    // A sequential graph ordered by import time can entirely miss a flight boundary. Merge
    // evidence must therefore be discovered by an exhaustive cross-run candidate graph.
    request.pair_selection = ColmapPairSelection::Exhaustive;
    request.calibration_groups = merge.calibration_groups;
    let policies = calibration_group_policies(projects)?;
    reseed_merge_calibration_groups(
        &mut request.calibration_groups,
        &merge.input_dataset_roots,
        &policies,
    );
    let (refinement, pinned) = plan_intrinsics_refinement(&request.calibration_groups, &policies);
    request.intrinsics_refinement = refinement;
    request.pinned_calibration_group_ids = pinned;
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
        &merge_profile,
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
        memory_plan,
        refusal,
    ))
}

fn prepare_image_quality_job(
    params: StartImageQualityJobParams,
    projects: &ProjectRuntime,
) -> anyhow::Result<(
    NewPhotolabJob,
    PathBuf,
    Vec<himmelcad_domain_photogrammetry::image_commit::ProjectCameraImageRecord>,
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
    cameras: &[himmelcad_domain_photogrammetry::image_commit::ProjectCameraImageRecord],
    requested_ids: &[String],
) -> anyhow::Result<Vec<himmelcad_domain_photogrammetry::image_commit::ProjectCameraImageRecord>> {
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
    images: &[himmelcad_domain_photogrammetry::image_commit::ProjectCameraImageRecord],
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
                    himmelcad_domain_photogrammetry::mvs_scene::MvsSceneError::Progress(
                        error.to_string(),
                    )
                })
        },
    )
    .map_err(|error| {
        if matches!(
            error,
            himmelcad_domain_photogrammetry::mvs_scene::MvsSceneError::Cancelled
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
    let resolved_inputs = resolve_product_input_context(
        projects,
        params.processing_set_id.as_ref(),
        params.source_alignment_entity_id.as_ref(),
        required_camera_scope,
        &params.gcp_optimization_entity_id,
    )?;
    let alignment = resolved_inputs.alignment;
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
    let lineage = resolved_inputs.lineage;
    let gcp_optimization = resolved_inputs.gcp_optimization;
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
) -> anyhow::Result<project_runtime::PublishedAlignmentDataset> {
    anyhow::ensure!(
        processing_set_id.is_none() || required_camera_scope.is_none(),
        "a product cannot combine a processing set with a separate batch camera scope"
    );
    anyhow::ensure!(
        source_alignment_entity_id.is_none() || required_camera_scope.is_none(),
        "a batch camera scope cannot override an explicit source alignment"
    );
    if let Some(alignment_id) = source_alignment_entity_id {
        let inferred_processing_set_id = if processing_set_id.is_none() {
            projects.processing_set_id_for_alignment(alignment_id)?
        } else {
            None
        };
        return projects.alignment_dataset_by_entity_id(
            alignment_id,
            processing_set_id.or(inferred_processing_set_id.as_ref()),
        );
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

struct ResolvedProductInputContext {
    alignment: project_runtime::PublishedAlignmentDataset,
    lineage: ProductLineage,
    gcp_optimization: Option<project_runtime::GcpOptimizationPublicationRecord>,
}

const MERGED_FRAME_NOT_GEOREFERENCED: &str = "mergedFrameNotGeoreferenced";
const MERGED_FRAME_NOT_GEOREFERENCED_MESSAGE: &str = "Overlap merges solve in an arbitrary frame. Run GCP optimization on the merged result before building georeferenced products.";

#[derive(Debug)]
struct ProductInputFailure {
    code: &'static str,
    message: &'static str,
}

impl std::fmt::Display for ProductInputFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for ProductInputFailure {}

fn ensure_merged_frame_georeferenced(
    projects: &ProjectRuntime,
    lineage: &ProductLineage,
    has_converged_optimization: bool,
) -> anyhow::Result<()> {
    let context = projects.compute_context()?;
    let local_metric = matches!(
        context.manifest.spatial_reference,
        PhotolabSpatialReference::LocalMetric { .. }
    );
    let Some(entity) = context
        .manifest
        .entities
        .get(&lineage.source_alignment_entity_id.0)
    else {
        anyhow::bail!("source alignment entity does not exist");
    };
    if local_metric || has_converged_optimization || entity.kind != EntityKind::MergedAlignmentRun {
        return Ok(());
    }
    let merge = projects.alignment_merge_by_entity_id(&lineage.source_alignment_entity_id)?;
    if merged_frame_needs_optimization(local_metric, &merge.connections, has_converged_optimization)
    {
        return Err(anyhow::Error::new(ProductInputFailure {
            code: MERGED_FRAME_NOT_GEOREFERENCED,
            message: MERGED_FRAME_NOT_GEOREFERENCED_MESSAGE,
        }));
    }
    Ok(())
}

fn merged_frame_needs_optimization(
    local_metric: bool,
    connections: &[project_runtime::AlignmentMergeConnection],
    has_converged_optimization: bool,
) -> bool {
    !local_metric
        && !has_converged_optimization
        && connections.iter().any(|connection| {
            matches!(
                connection,
                project_runtime::AlignmentMergeConnection::Overlap { .. }
            )
        })
}

fn resolve_product_input_context(
    projects: &ProjectRuntime,
    processing_set_id: Option<&EntityId>,
    source_alignment_entity_id: Option<&EntityId>,
    required_camera_scope: Option<&[String]>,
    gcp_selection: &ProductGcpSelection,
) -> anyhow::Result<ResolvedProductInputContext> {
    let alignment = resolve_product_alignment(
        projects,
        processing_set_id,
        source_alignment_entity_id,
        required_camera_scope,
    )?;
    let mut lineage = ProductLineage {
        source_alignment_entity_id: alignment.source_alignment_entity_id.clone(),
        processing_set_id: alignment.processing_set_id.clone(),
        gcp_optimization_entity_id: None,
        gcp_optimization_snapshot_sha256: None,
        image_mask_scope_sha256: alignment.image_mask_scope_sha256.clone(),
    };
    let gcp_optimization = pin_product_gcp_optimization(projects, &mut lineage, gcp_selection)?;
    Ok(ResolvedProductInputContext {
        alignment,
        lineage,
        gcp_optimization,
    })
}

fn resolve_product_inputs_response(
    projects: &ProjectRuntime,
    params: ResolveProductInputsParams,
) -> anyhow::Result<ResolvedProductInputs> {
    anyhow::ensure!(
        matches!(
            params.kind.as_str(),
            "depth" | "dense" | "dem" | "ortho" | "mesh" | "splat"
        ),
        "unknown product kind '{}'",
        params.kind
    );
    let resolved = resolve_product_input_context(
        projects,
        None,
        Some(&params.source_alignment_entity_id),
        None,
        &params.gcp_optimization_entity_id,
    )?;
    if matches!(params.kind.as_str(), "dem" | "ortho") {
        ensure_merged_frame_georeferenced(
            projects,
            &resolved.lineage,
            resolved.gcp_optimization.is_some(),
        )?;
    }
    let context = projects.compute_context()?;
    let alignment_entity = context
        .manifest
        .entities
        .get(&resolved.lineage.source_alignment_entity_id.0)
        .context("resolved alignment entity disappeared")?;
    let processing_set = resolved
        .lineage
        .processing_set_id
        .as_ref()
        .map(|entity_id| {
            projects
                .list_processing_sets()?
                .into_iter()
                .find(|record| &record.entity_id == entity_id)
                .map(|record| ResolvedProductProcessingSet {
                    entity_id: record.entity_id,
                    name: record.name,
                    membership_sha256: record.membership_sha256,
                })
                .context("resolved processing set disappeared")
        })
        .transpose()?;
    let gcp_optimization = resolved
        .gcp_optimization
        .map(|record| ResolvedProductGcpOptimization {
            entity_id: resolved
                .lineage
                .gcp_optimization_entity_id
                .clone()
                .expect("resolved GCP optimization must pin its entity"),
            operation_id: record.operation_id,
            snapshot_sha256: record.snapshot_sha256,
        });
    let mask_scope = projects.image_mask_compute_scope(
        &resolved.alignment.camera_entity_ids,
        resolved.alignment.processing_set_id.as_ref(),
    )?;
    Ok(ResolvedProductInputs {
        kind: params.kind,
        alignment: ResolvedProductInputArtifact {
            entity_id: alignment_entity.id.clone(),
            name: alignment_entity.name.clone(),
            snapshot_sha256: alignment_entity.version_hash.clone(),
        },
        processing_set,
        gcp_optimization,
        mask_scope_sha256: (!mask_scope.masks.is_empty()).then_some(mask_scope.scope_sha256),
    })
}

fn validated_product_gcp_optimization(
    record: Option<project_runtime::GcpOptimizationPublicationRecord>,
) -> anyhow::Result<Option<project_runtime::GcpOptimizationPublicationRecord>> {
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
        himmelcad_domain_photogrammetry::photolab_gcp_optimization::GcpTransformMode::Similarity7
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

fn pin_product_gcp_optimization(
    projects: &ProjectRuntime,
    lineage: &mut ProductLineage,
    selection: &ProductGcpSelection,
) -> anyhow::Result<Option<project_runtime::GcpOptimizationPublicationRecord>> {
    let context = projects.compute_context()?;
    if matches!(selection, ProductGcpSelection::None) {
        anyhow::ensure!(
            matches!(
                context.manifest.spatial_reference,
                PhotolabSpatialReference::LocalMetric { .. }
            ),
            "a CRS-backed project cannot run a product without a converged GCP optimization"
        );
        return Ok(None);
    }
    let entry = match selection {
        ProductGcpSelection::Latest => {
            tracing::warn!(
                alignment_entity_id = %lineage.source_alignment_entity_id.0,
                "product request omitted gcpOptimizationEntityId; falling back to the latest converged lineage revision"
            );
            projects
                .list_gcp_optimizations()?
                .into_iter()
                .filter(|entry| {
                    entry.optimization.artifact.result.converged
                        && gcp_revision_matches_product_lineage(
                            entry.optimization.source_alignment_entity_id.as_ref(),
                            entry.optimization.processing_set_id.as_ref(),
                            lineage,
                        )
                })
                .last()
        }
        ProductGcpSelection::Explicit(entity_id) => {
            let entry = projects.gcp_optimization_entry_by_entity_id(entity_id)?;
            anyhow::ensure!(
                gcp_revision_matches_product_lineage(
                    entry.optimization.source_alignment_entity_id.as_ref(),
                    entry.optimization.processing_set_id.as_ref(),
                    lineage,
                ),
                "selected GCP optimization belongs to another alignment lineage"
            );
            Some(entry)
        }
        ProductGcpSelection::None => unreachable!("explicit none handled above"),
    };
    let Some(entry) = entry else { return Ok(None) };
    let entity_id = entry.entity_id;
    let record = validated_product_gcp_optimization(Some(entry.optimization))?
        .context("validated GCP optimization disappeared")?;
    pin_product_gcp_identity(lineage, entity_id, record.snapshot_sha256.clone());
    Ok(Some(record))
}

fn gcp_revision_matches_product_lineage(
    source_alignment_entity_id: Option<&EntityId>,
    processing_set_id: Option<&EntityId>,
    lineage: &ProductLineage,
) -> bool {
    source_alignment_entity_id == Some(&lineage.source_alignment_entity_id)
        && processing_set_id == lineage.processing_set_id.as_ref()
}

fn pin_product_gcp_identity(
    lineage: &mut ProductLineage,
    entity_id: EntityId,
    snapshot_sha256: ObjectHash,
) {
    lineage.gcp_optimization_entity_id = Some(entity_id);
    lineage.gcp_optimization_snapshot_sha256 = Some(snapshot_sha256);
}

fn pinned_product_gcp_optimization(
    projects: &ProjectRuntime,
    lineage: &ProductLineage,
) -> anyhow::Result<Option<project_runtime::GcpOptimizationPublicationRecord>> {
    let Some(entity_id) = lineage.gcp_optimization_entity_id.as_ref() else {
        anyhow::ensure!(
            lineage.gcp_optimization_snapshot_sha256.is_none(),
            "GCP snapshot is pinned without an optimization entity"
        );
        return Ok(None);
    };
    let entry = projects.gcp_optimization_entry_by_entity_id(entity_id)?;
    anyhow::ensure!(
        Some(&entry.optimization.snapshot_sha256)
            == lineage.gcp_optimization_snapshot_sha256.as_ref(),
        "GCP optimization changed after product inputs were resolved"
    );
    validated_product_gcp_optimization(Some(entry.optimization))
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
    mut prepared: crate::mesh_tiler::PreparedMeshProduct,
    relative_root: &Path,
) -> crate::mesh_tiler::PreparedMeshProduct {
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
    let resolved_inputs = resolve_product_input_context(
        projects,
        params.processing_set_id.as_ref(),
        params.source_alignment_entity_id.as_ref(),
        required_camera_scope,
        &params.gcp_optimization_entity_id,
    )?;
    ensure_merged_frame_georeferenced(
        projects,
        &resolved_inputs.lineage,
        resolved_inputs.gcp_optimization.is_some(),
    )?;
    let alignment = resolved_inputs.alignment;
    let lineage = resolved_inputs.lineage;
    let gcp_optimization = resolved_inputs.gcp_optimization;
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
    let has_pre_raster_stage =
        matches!(&params.configuration, ProductRunConfiguration::Ortho { .. })
            || matches!(
                &params.configuration,
                ProductRunConfiguration::Dem { surface, .. }
                    if surface.eq_ignore_ascii_case("dtm")
            );
    let job = NewPhotolabJob {
        id: PhotolabJobId(params.operation_id.clone()),
        kind,
        config_hash: ObjectHash::of_bytes(&config_bytes),
        input_hash: input_hash.clone(),
        progress: JobProgress {
            stage: PhotolabStage {
                kind: PhotolabStageKind::Preparing,
                index: 0,
                stage_count: if has_pre_raster_stage { 8 } else { 7 },
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
        mesh_source,
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
    let resolved_inputs = resolve_product_input_context(
        projects,
        params.processing_set_id.as_ref(),
        params.source_alignment_entity_id.as_ref(),
        required_camera_scope,
        &params.gcp_optimization_entity_id,
    )?;
    let lineage = resolved_inputs.lineage;
    let (
        dem_root,
        dem_summary,
        dense_ply,
        colmap_executable,
        texture_dataset_root,
        texture_summary,
        textured,
        config_hash,
        input_hash,
        provenance,
    ) = match mesh_source {
        himmelcad_domain_photogrammetry::photolab_products::MeshSource::Dem => {
            let (dem_root, dem) = if let Some(entity_id) = source_dem_entity_id.as_ref() {
                projects.raster_dataset_by_entity_id(entity_id, PublishedRasterKind::Dem, None)?
            } else {
                projects.latest_raster_dataset_for_lineage(PublishedRasterKind::Dem, &lineage)?
            };
            let dem_evidence = ObjectHash::of_bytes(&serde_json::to_vec(&dem)?);
            let (texture_dataset_root, texture_summary) = if build_texture {
                let (ortho_root, ortho) = projects.latest_raster_dataset_for_lineage(
                    PublishedRasterKind::Orthomosaic,
                    &lineage,
                )?;
                (Some(ortho_root), Some(ortho.summary))
            } else {
                (None, None)
            };
            // Preserve the historical DEM configuration and input hashes byte-for-byte.
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
            let provenance = project_runtime::MeshProvenance {
                mesh_source,
                dense_run_id: None,
                // The DEM resolved by lineage keeps its identity in the lineage;
                // an explicitly chosen DEM is frozen by entity id.
                source_dem_entity_id: source_dem_entity_id.clone(),
                source_artifact_sha256: None,
                degenerate_faces_dropped: None,
            };
            (
                Some(dem_root),
                Some(dem.summary),
                None,
                None,
                texture_dataset_root,
                texture_summary,
                build_texture,
                config_hash,
                input_hash,
                provenance,
            )
        }
        himmelcad_domain_photogrammetry::photolab_products::MeshSource::Dense => {
            let (dense_ply, dense_record) =
                projects.latest_dense_mvs_dataset_for_lineage(&lineage)?;
            let dense = dense_record
                .output
                .dense_point_cloud
                .as_ref()
                .context("published dense-cloud run has no fused cloud")?;
            let config_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
                mesh_source,
                target_face_count,
                interpolate_holes,
                build_texture,
                texture_size,
            ))?);
            let input_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
                &dense_record.job_id,
                &dense.sha256,
                &lineage.source_alignment_entity_id,
                &lineage.processing_set_id,
                &lineage.image_mask_scope_sha256,
                &lineage.gcp_optimization_entity_id,
                &lineage.gcp_optimization_snapshot_sha256,
            ))?);
            let provenance = project_runtime::MeshProvenance {
                mesh_source,
                dense_run_id: Some(dense_record.job_id.clone()),
                source_dem_entity_id: None,
                source_artifact_sha256: Some(dense.sha256.clone()),
                degenerate_faces_dropped: None,
            };
            (
                None,
                None,
                Some(dense_ply),
                Some(development_colmap_executable()?),
                None,
                None,
                false,
                config_hash,
                input_hash,
                provenance,
            )
        }
    };
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
                label: if mesh_source
                    == himmelcad_domain_photogrammetry::photolab_products::MeshSource::Dense
                {
                    "Build dense-cloud mesh".into()
                } else {
                    "Prepare DEM tiles for mesh".into()
                },
            },
            metrics: ProgressMetrics::empty(),
        },
    };
    Ok(PreparedMeshJob {
        job,
        operation_id: params.operation_id,
        project_root: context.working_path,
        mesh_source,
        dem_root,
        dem_summary,
        dense_ply,
        colmap_executable,
        texture_dataset_root,
        texture_summary,
        textured,
        provenance,
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
    let mut degenerate_faces_dropped: Option<u64> = None;
    let result = match prepared.mesh_source {
        himmelcad_domain_photogrammetry::photolab_products::MeshSource::Dem => {
            build_tiled_dem_mesh(
                prepared
                    .dem_root
                    .as_deref()
                    .expect("DEM mesh freezes a DEM root"),
                prepared
                    .dem_summary
                    .as_ref()
                    .expect("DEM mesh freezes a DEM summary"),
                &staging,
                prepared.texture_dataset_root.as_deref(),
                prepared.texture_summary.as_ref(),
                prepared.target_face_count,
                prepared.interpolate_holes,
                prepared.texture_size,
                &context.cancellation,
            )
            .map_err(map_mesh_tiler_error)?
        }
        himmelcad_domain_photogrammetry::photolab_products::MeshSource::Dense => {
            let candidate = prepared
                .project_root
                .join(".photolab/mesh-candidates")
                .join(&prepared.operation_id);
            if candidate.exists() {
                std::fs::remove_dir_all(&candidate)
                    .map_err(|error| worker_error("io", &error.to_string()))?;
            }
            std::fs::create_dir_all(&candidate)
                .map_err(|error| worker_error("io", &error.to_string()))?;
            let mesh_ply = candidate.join("mesh.ply");
            let local_ply = candidate.join("local.ply");
            let dense_result = (|| {
                // COLMAP meshes in float32: work in a local frame and restore
                // world coordinates when the mesh is tiled.
                let origin = crate::dense_raster_prep::write_dense_local_frame_ply(
                    prepared
                        .dense_ply
                        .as_deref()
                        .expect("dense mesh freezes a fused cloud"),
                    &local_ply,
                    &context.cancellation,
                )
                .map_err(map_dense_prep_error)?;
                himmelcad_domain_photogrammetry::colmap_runtime::run_colmap_mesher(
                    &himmelcad_domain_photogrammetry::colmap_runtime::ColmapMeshRequest {
                        executable: prepared
                            .colmap_executable
                            .clone()
                            .expect("dense mesh freezes a COLMAP executable"),
                        project_root: prepared.project_root.clone(),
                        input_path: local_ply.clone(),
                        output_path: mesh_ply.clone(),
                        mesher:
                            himmelcad_domain_photogrammetry::colmap_runtime::ColmapMesher::Poisson,
                    },
                    context,
                )
                .map_err(JobWorkerError::from)?;
                context
                    .progress
                    .report_blocking(JobProgress {
                        stage: PhotolabStage {
                            kind: PhotolabStageKind::Meshing,
                            index: 1,
                            stage_count: 2,
                            label: "Prepare mesh for viewing".into(),
                        },
                        metrics: ProgressMetrics::empty(),
                    })
                    .map_err(JobWorkerError::from)?;
                let report =
                    himmelcad_prepared_build::prepared_triangle_mesh_ply::build_prepared_triangle_mesh_from_generated_ply(
                        &mesh_ply,
                        &staging,
                        PreparedTriangleMeshOptions::default(),
                        origin,
                        &context.cancellation,
                    )
                    .map_err(|error| worker_error("meshPreparation", &error.to_string()))?;
                if report.degenerate_faces_dropped > 0 {
                    tracing::info!(
                        operation_id = %prepared.operation_id,
                        dropped = report.degenerate_faces_dropped,
                        "dropped zero-area faces from the Poisson mesh before tiling"
                    );
                }
                degenerate_faces_dropped = Some(report.degenerate_faces_dropped);
                Ok(report.prepared)
            })();
            let cleanup = std::fs::remove_dir_all(&candidate);
            match (dense_result, cleanup) {
                (Ok(result), Ok(())) => result,
                (Ok(_), Err(error)) => return Err(worker_error("io", &error.to_string())),
                (Err(error), _) => return Err(error),
            }
        }
    };
    context.check_cancelled()?;
    let mut provenance = prepared.provenance.clone();
    provenance.degenerate_faces_dropped = degenerate_faces_dropped;
    publisher
        .publish_mesh_product(
            &prepared.operation_id,
            &staging,
            result,
            prepared.textured,
            &prepared.lineage,
            provenance,
            &context.cancellation,
        )
        .map_err(|error| map_project_publish_error(error, &context.cancellation))?;
    Ok(())
}

fn run_raster_product(
    prepared: PreparedRasterProductJob,
    raster_memory_plan: Option<RasterPreparationMemoryPlan>,
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
    let mut classification_to_persist: Option<(PathBuf, Vec<PointClass>)> = None;
    let (crs, grid, product) = match &prepared.configuration {
        ProductRunConfiguration::Dem {
            surface,
            interpolate_nodata,
            cell_size_m,
            slope,
            max_window_m,
            initial_distance_m,
            ..
        } => {
            let dense_ply = prepared.dense_ply.as_ref().ok_or_else(|| {
                worker_error("invalidRasterInput", "DEM has no dense point-cloud input")
            })?;
            let surface = if surface.eq_ignore_ascii_case("dtm") {
                ElevationSurface::Dtm
            } else {
                ElevationSurface::Dsm
            };
            let classifications = if surface == ElevationSurface::Dtm {
                let points = read_dense_points(dense_ply, &context.cancellation)
                    .map_err(map_dense_prep_error)?;
                let params = SmrfParams {
                    cell_size_m: *cell_size_m,
                    slope: *slope,
                    max_window_m: *max_window_m,
                    initial_distance_m: *initial_distance_m,
                };
                let progress_sink = context.progress.clone();
                let classes = classify_ground(
                    &points,
                    &params,
                    &context.cancellation,
                    |completed, total| {
                        let _ = progress_sink.report_blocking(JobProgress {
                            stage: PhotolabStage {
                                kind: PhotolabStageKind::Preparing,
                                index: 0,
                                stage_count: 8,
                                label: "Classifying ground".into(),
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
                .map_err(map_ground_classification_error)?;
                Some(classes)
            } else {
                None
            };
            let vector = if let Some(plan) = raster_memory_plan.as_ref() {
                prepare_dense_vector_with_classification_bounded(
                    dense_ply,
                    &input_root,
                    &tools.ogr2ogr,
                    &prepared.horizontal_srs,
                    classifications.as_deref(),
                    &context.cancellation,
                    plan.ogr2ogr,
                    &context.memory,
                )
            } else {
                prepare_dense_vector_with_classification(
                    dense_ply,
                    &input_root,
                    &tools.ogr2ogr,
                    &prepared.horizontal_srs,
                    classifications.as_deref(),
                    &context.cancellation,
                )
            }
            .map_err(|error| map_dense_prep_error_with_diagnostic(error, &context.diagnostics))?;
            let wkt = if let Some(plan) = raster_memory_plan.as_ref() {
                inspect_vector_wkt_bounded(
                    &tools.ogrinfo,
                    &vector,
                    &context.cancellation,
                    plan.ogr2ogr,
                    &context.memory,
                )
            } else {
                inspect_vector_wkt(&tools.ogrinfo, &vector, &context.cancellation)
            }
            .map_err(|error| map_dense_prep_error_with_diagnostic(error, &context.diagnostics))?;
            let crs = RasterCrs {
                horizontal: prepared.horizontal_srs.clone(),
                vertical: prepared.vertical_label.clone(),
                gdal_srs: prepared.horizontal_srs.clone(),
                canonical_wkt_sha256: ObjectHash::of_bytes(wkt.as_bytes()),
            };
            let grid = aligned_raster_grid(vector.minimum, vector.maximum, gsd)
                .map_err(worker_failed("rasterGrid"))?;
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
                tiles: elevation_tiles(&grid, &crs, &vector, surface == ElevationSurface::Dtm),
            });
            if let Some(classifications) = classifications {
                classification_to_persist = Some((dense_ply.clone(), classifications));
            }
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
                    himmelcad_domain_photogrammetry::mvs_scene::MvsSceneError::Cancelled
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
            .map_err(|error| map_dense_prep_error_with_diagnostic(error, &context.diagnostics))?;
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
                    // Intermediate progress is best-effort; the worker result and checkpoints remain authoritative.
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
    let dtm = matches!(
        &prepared.configuration,
        ProductRunConfiguration::Dem { surface, .. } if surface.eq_ignore_ascii_case("dtm")
    );
    let stage_offset = u32::from(orthomosaic || dtm);
    let stage_count = 7 + stage_offset;
    let handle = tokio::runtime::Handle::current();
    let summary = handle
        .block_on(
            runtime.execute(
                &command,
                &context.cancellation,
                Some(&context.checkpoints),
                raster_memory_plan
                    .as_ref()
                    .map(|plan| RasterRuntimeMemory::new(plan.gdal_grid, context.memory.clone())),
                move |progress| {
                    let sink = progress_sink.clone();
                    tokio::spawn(async move {
                        // Intermediate progress is best-effort; terminal state persistence is handled by JobManager.
                        let _ = sink
                            .report(raster_job_progress(progress, stage_offset, stage_count))
                            .await;
                    });
                },
            ),
        )
        .map_err(|error| match error {
            crate::raster_runtime::RasterRuntimeError::Cancelled => JobWorkerError::Cancelled,
            memory_error @ crate::raster_runtime::RasterRuntimeError::WorkerMemoryLimit {
                ..
            } => worker_error("workerMemoryLimit", &memory_error.to_string()),
            other => worker_error("rasterRuntime", &other.to_string()),
        })?;
    context.check_cancelled()?;
    let mut ground_classification_sha256 = None;
    if let Some((dense_ply, classifications)) = classification_to_persist {
        ground_classification_sha256 = Some(
            persist_dense_classification(
                &dense_ply,
                &prepared.operation_id,
                &classifications,
                &context.cancellation,
            )
            .map_err(map_dense_prep_error)?,
        );
    }
    let kind = if matches!(prepared.configuration, ProductRunConfiguration::Dem { .. }) {
        PublishedRasterKind::Dem
    } else {
        PublishedRasterKind::Orthomosaic
    };
    publisher
        .publish_raster_summary(
            &prepared.operation_id,
            kind,
            summary,
            &prepared.lineage,
            ground_classification_sha256,
        )
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
    vector: &crate::dense_raster_prep::PreparedDenseVector,
    ground_only: bool,
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
                    classification_field: ground_only.then(|| "classification".into()),
                    accepted_classifications: if ground_only { vec![2] } else { Vec::new() },
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

fn map_dense_prep_error_with_diagnostic(
    error: DenseRasterPrepError,
    diagnostics: &himmelcad_domain_photogrammetry::job_runtime::JobDiagnosticSink,
) -> JobWorkerError {
    match error {
        DenseRasterPrepError::Cancelled => JobWorkerError::Cancelled,
        other @ DenseRasterPrepError::WorkerMemoryLimit { .. } => {
            worker_error("workerMemoryLimit", &other.to_string())
        }
        DenseRasterPrepError::GdalFailed {
            command,
            code,
            stderr_tail,
        } => {
            let first_stderr_line = stderr_tail.lines().next().unwrap_or("GDAL wrote no stderr");
            let message = format!(
                "GDAL preparation command {command} failed with exit code {code:?}: {first_stderr_line}"
            );
            if let Err(record_error) = diagnostics.record_blocking(stderr_tail) {
                return worker_error(
                    "denseRasterPreparationDiagnostic",
                    &format!("{message}; failed to store GDAL stderr: {record_error}"),
                );
            }
            worker_error("denseRasterPreparation", &message)
        }
        other => worker_error("denseRasterPreparation", &other.to_string()),
    }
}

fn map_ground_classification_error(error: GroundClassificationError) -> JobWorkerError {
    if matches!(error, GroundClassificationError::Cancelled) {
        JobWorkerError::Cancelled
    } else {
        worker_error("groundClassification", &error.to_string())
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

fn map_project_publish_error(
    error: anyhow::Error,
    cancellation: &CancellationToken,
) -> JobWorkerError {
    if cancellation.is_cancel_requested() {
        JobWorkerError::Cancelled
    } else {
        worker_error("projectPublish", &error.to_string())
    }
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
    resume: bool,
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
    let resolved_inputs = resolve_product_input_context(
        projects,
        params.processing_set_id.as_ref(),
        params.source_alignment_entity_id.as_ref(),
        required_camera_scope,
        &params.gcp_optimization_entity_id,
    )?;
    let alignment = resolved_inputs.alignment;
    let project_root = projects.compute_context()?.working_path;
    let dataset_root = prepare_brush_scene(&alignment.root, &project_root, &params.operation_id)?;
    let lineage = resolved_inputs.lineage;
    let settings = BrushTrainingSettings {
        iterations,
        spherical_harmonics_degree,
        maximum_splats,
        maximum_resolution,
        seed: 42,
        checkpoint_every: iterations.min(5_000),
        retain_training_checkpoints,
    };
    let mut request = BrushRunRequest {
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
    if resume {
        let recovery = runtime
            .recovery_checkpoints(&request.job_id, &request.settings)?
            .into_iter()
            .rev()
            .find(|checkpoint| checkpoint.checkpoint.iteration < request.settings.iterations)
            .context("no compatible Brush recovery checkpoint is available")?;
        request.resume = Some(runtime.validate_recovery_checkpoint(&recovery)?);
    }
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
    ensure_colmap_worker_executable(&executable)?;
    let resolved_path = executable.to_string_lossy().into_owned();
    ColmapRuntime::development_preflight(&DevColmapRuntimeConfig {
        executable,
        version: "4.1.0".into(),
        resources,
        scratch_root: project_root.join("tmp").join("colmap"),
        allowed_project_roots: vec![project_root.to_path_buf()],
    })
    .map_err(|error| map_colmap_worker_preflight_error(error, resolved_path))
}

fn map_colmap_worker_preflight_error(
    error: himmelcad_domain_photogrammetry::colmap_runtime::ColmapRuntimeError,
    resolved_path: String,
) -> anyhow::Error {
    use himmelcad_domain_photogrammetry::colmap_runtime::ColmapRuntimeError;

    match error {
        ColmapRuntimeError::InvalidConfig(_)
        | ColmapRuntimeError::InvalidPath { .. }
        | ColmapRuntimeError::Io(_) => anyhow::Error::new(ColmapWorkerMissing { resolved_path }),
        other => anyhow::Error::from(other),
    }
}

fn ensure_colmap_worker_executable(path: &Path) -> anyhow::Result<()> {
    if path.is_file() {
        Ok(())
    } else {
        Err(anyhow::Error::new(ColmapWorkerMissing {
            resolved_path: path.to_string_lossy().into_owned(),
        }))
    }
}

fn development_colmap_executable() -> anyhow::Result<PathBuf> {
    let workspace = discover_workspace_root()?;
    let path = std::env::var_os("HIMMELCAD_COLMAP_EXECUTABLE")
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
        });
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
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
        default_job_concurrency(logical_cpus, usize::from(hardware.cpu.physical_cores))
    });
    JobManagerConfig {
        max_concurrency,
        max_queued: 64,
    }
}

fn fallback_alignment_usable_memory_bytes() -> u64 {
    const GIB: u64 = 1024 * 1024 * 1024;
    let physical = probe_hardware().map_or(8 * GIB, |hardware| hardware.ram_bytes);
    physical.saturating_sub(memory_os_ui_reserve_bytes(physical))
}

const fn colmap_feature_worker_threads(plan: &AlignmentMemoryPlan) -> u16 {
    plan.extraction_workers
}

fn colmap_matching_worker_threads(usable_memory_bytes: u64, logical_cpus: u16) -> u16 {
    // WP-A7 assigns matching half the usable envelope; the 256 MiB per-worker
    // model is the measured SIFT peak recorded in the tunables register.
    let workers = (usable_memory_bytes / 2 / SIFT_MATCHING_BYTES_PER_WORKER).max(1);
    u16::try_from(workers)
        .unwrap_or(u16::MAX)
        .min(logical_cpus.max(1))
}

const fn colmap_aliked_matching_worker_threads(plan: &AlignmentMemoryPlan) -> u16 {
    plan.matching_workers
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

async fn rpc_blocking_product_with_params<P, T, F>(
    id: serde_json::Value,
    params: serde_json::Value,
    operation: F,
) -> RpcResponse
where
    P: serde::de::DeserializeOwned + Send + 'static,
    T: Serialize + Send + 'static,
    F: FnOnce(P) -> anyhow::Result<T> + Send + 'static,
{
    match serde_json::from_value::<P>(params) {
        Ok(params) => {
            let result = tokio::task::spawn_blocking(move || operation(params))
                .await
                .map_err(anyhow::Error::from)
                .and_then(std::convert::identity);
            match result {
                Ok(value) => rpc_result(id, Ok(value)),
                Err(error) => product_rpc_err(id, &error),
            }
        }
        Err(error) => rpc_err(id, -32602, &format!("invalid params: {error}")),
    }
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

#[cfg(test)]
fn public_import_commit<T: Serialize>(commit: T) -> anyhow::Result<serde_json::Value> {
    let mut value = serde_json::to_value(commit)?;
    if let Some(references) = value
        .pointer_mut("/inventory/externalObjects")
        .and_then(serde_json::Value::as_array_mut)
    {
        for reference in references {
            if let Some(reference) = reference.as_object_mut() {
                reference.remove("sourcePath");
            }
        }
    }
    Ok(value)
}

pub(crate) fn rpc_err(id: serde_json::Value, code: i32, message: &str) -> RpcResponse {
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

fn rpc_err_with_data(
    id: serde_json::Value,
    code: i32,
    message: &str,
    data: serde_json::Value,
) -> RpcResponse {
    RpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(RpcError {
            code,
            message: message.to_string(),
            data: Some(data),
        }),
    }
}

fn product_rpc_err(id: serde_json::Value, error: &anyhow::Error) -> RpcResponse {
    if let Some(ProviderContractError::ProductImportRefused {
        reason_code,
        message,
    }) = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ProviderContractError>())
    {
        return rpc_err_with_data(
            id,
            -32028,
            message,
            serde_json::json!({
                "code": reason_code,
                "reasonCode": reason_code,
                "message": message,
                "retryable": false,
            }),
        );
    }
    if let Some(failure) = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ProductInputFailure>())
    {
        return rpc_err_with_data(
            id,
            -32040,
            failure.message,
            serde_json::json!({
                "code": failure.code,
                "message": failure.message,
                "retryable": false,
            }),
        );
    }
    rpc_err(id, -32000, &error.to_string())
}

fn alignment_admission_rpc_err(id: serde_json::Value, error: &anyhow::Error) -> RpcResponse {
    if let Some(missing) = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<ColmapWorkerMissing>())
    {
        const MESSAGE: &str = "The COLMAP worker is missing or invalid.";
        return rpc_err_with_data(
            id,
            -32044,
            MESSAGE,
            serde_json::json!({
                "code": "colmapWorkerMissing",
                "reasonCode": "colmapWorkerMissing",
                "message": MESSAGE,
                "resolvedPath": missing.resolved_path,
                "retryable": false,
            }),
        );
    }
    rpc_err(id, -32000, &error.to_string())
}

fn rpc_resume_err(id: serde_json::Value, error: &ResumeRpcFailure) -> RpcResponse {
    RpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(RpcError {
            code: -32020,
            message: error.message.clone(),
            data: Some(serde_json::json!({
                "code": error.code,
                "field": error.field,
                "message": error.message,
                "retryable": false,
            })),
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc as TestArc, Mutex as TestMutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    struct TestLogWriter(TestArc<TestMutex<Vec<u8>>>);

    impl std::io::Write for TestLogWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            std::io::Write::write(&mut *self.0.lock().expect("log buffer"), bytes)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn resume_test_job(
        kind: PhotolabJobKind,
    ) -> himmelcad_domain_photogrammetry::photolab_jobs::PhotolabJob {
        himmelcad_domain_photogrammetry::photolab_jobs::PhotolabJob::new(NewPhotolabJob {
            id: PhotolabJobId(format!("resume-{kind:?}")),
            kind,
            config_hash: ObjectHash::of_bytes(b"resume-config"),
            input_hash: ObjectHash::of_bytes(b"resume-input"),
            progress: JobProgress {
                stage: PhotolabStage {
                    kind: PhotolabStageKind::Preparing,
                    index: 0,
                    stage_count: 1,
                    label: "Validate resume identity".into(),
                },
                metrics: ProgressMetrics::empty(),
            },
        })
        .expect("resume test job")
    }

    #[test]
    fn insufficient_disk_response_records_available_and_required_bytes() {
        const TEST_GIB: u64 = 1024 * 1024 * 1024;
        let response = job_start_response(
            serde_json::json!(17),
            Err(
                himmelcad_domain_photogrammetry::job_runtime::JobManagerError::InsufficientDisk {
                    required_bytes: 2 * TEST_GIB,
                    available_bytes: TEST_GIB,
                    path: PathBuf::from("working-copy"),
                    job_kind: None,
                    scratch_bytes: None,
                },
            ),
        );
        let error = response.error.expect("insufficient-disk RPC error");
        let data = error.data.expect("insufficient-disk error data");
        assert_eq!(error.code, -32042);
        assert_eq!(data["code"], "insufficientDisk");
        assert_eq!(data["available_bytes"], TEST_GIB);
        assert_eq!(data["required_bytes"], 2 * TEST_GIB);
    }

    #[test]
    fn publish_alignment_admission_types_a_missing_or_invalid_colmap_worker() {
        let resolved_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.build/codex-scratch/pl-i1/missing-colmap-worker")
            .canonicalize()
            .unwrap_or_else(|_| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../.build/codex-scratch/pl-i1/missing-colmap-worker")
            });
        let error = ensure_colmap_worker_executable(&resolved_path)
            .expect_err("missing worker must be refused before process launch");
        let response = alignment_admission_rpc_err(serde_json::json!(41), &error);
        assert!(response.result.is_none());
        let rpc_error = response.error.expect("typed alignment admission refusal");
        assert_eq!(rpc_error.code, -32044);
        assert_eq!(
            rpc_error.message,
            "The COLMAP worker is missing or invalid."
        );
        assert!(!rpc_error.message.contains("No such file"));
        let data = rpc_error.data.expect("domain error payload");
        assert_eq!(data["code"], "colmapWorkerMissing");
        assert_eq!(data["reasonCode"], "colmapWorkerMissing");
        assert_eq!(
            data["resolvedPath"],
            resolved_path.to_string_lossy().as_ref()
        );
        assert_eq!(data["retryable"], false);

        let invalid = map_colmap_worker_preflight_error(
            himmelcad_domain_photogrammetry::colmap_runtime::ColmapRuntimeError::InvalidConfig(
                "fixture is not a COLMAP worker".to_owned(),
            ),
            resolved_path.to_string_lossy().into_owned(),
        );
        let response = alignment_admission_rpc_err(serde_json::json!(42), &invalid);
        let rpc_error = response.error.expect("typed invalid-worker refusal");
        assert_eq!(rpc_error.code, -32044);
        assert_eq!(
            rpc_error.message,
            "The COLMAP worker is missing or invalid."
        );
        assert_eq!(
            rpc_error.data.expect("domain error payload")["reasonCode"],
            "colmapWorkerMissing"
        );
    }

    #[test]
    fn resume_identity_rejects_each_field_for_every_job_kind() {
        let kinds = [
            PhotolabJobKind::AnalyzeImageQuality,
            PhotolabJobKind::AlignPhotos,
            PhotolabJobKind::MergeAlignments,
            PhotolabJobKind::OptimizeAlignment,
            PhotolabJobKind::BuildDepthMaps,
            PhotolabJobKind::BuildDensePointCloud,
            PhotolabJobKind::BuildDem,
            PhotolabJobKind::BuildOrthomosaic,
            PhotolabJobKind::BuildMesh,
            PhotolabJobKind::BuildGaussianSplat,
            PhotolabJobKind::ExportProduct,
            PhotolabJobKind::Batch,
        ];
        for kind in kinds {
            let job = resume_test_job(kind);
            let other_kind = if kind == PhotolabJobKind::Batch {
                PhotolabJobKind::BuildDem
            } else {
                PhotolabJobKind::Batch
            };
            assert_eq!(
                validate_resume_identity(&job, other_kind, &job.config_hash, &job.input_hash)
                    .expect_err("kind mismatch")
                    .field,
                Some(ResumeIdentityField::Kind),
                "kind mismatch for {kind:?}"
            );
            assert_eq!(
                validate_resume_identity(
                    &job,
                    kind,
                    &ObjectHash::of_bytes(b"changed-config"),
                    &job.input_hash
                )
                .expect_err("config mismatch")
                .field,
                Some(ResumeIdentityField::ConfigHash),
                "config mismatch for {kind:?}"
            );
            assert_eq!(
                validate_resume_identity(
                    &job,
                    kind,
                    &job.config_hash,
                    &ObjectHash::of_bytes(b"changed-input")
                )
                .expect_err("input mismatch")
                .field,
                Some(ResumeIdentityField::InputHash),
                "input mismatch for {kind:?}"
            );
        }
    }

    #[test]
    fn only_checkpoint_capable_job_kinds_are_resumable() {
        for kind in [
            PhotolabJobKind::AnalyzeImageQuality,
            PhotolabJobKind::AlignPhotos,
            PhotolabJobKind::MergeAlignments,
            PhotolabJobKind::OptimizeAlignment,
            PhotolabJobKind::BuildMesh,
            PhotolabJobKind::ExportProduct,
        ] {
            assert!(!supports_history_resume(kind), "{kind:?}");
            let mut job = resume_test_job(kind);
            job.transition_to(PhotolabJobState::Running)
                .expect("running");
            job.transition_to(PhotolabJobState::Failed {
                code: "interruptedRecoverable".into(),
                message: "Synthetic recoverable state".into(),
            })
            .expect("synthetic interrupted state");
            assert_eq!(
                validate_history_resume_candidate(&job)
                    .expect_err("non-recoverable kind must be rejected")
                    .code,
                "resumeNotSupported"
            );
        }
        for kind in [
            PhotolabJobKind::BuildDepthMaps,
            PhotolabJobKind::BuildDensePointCloud,
            PhotolabJobKind::BuildDem,
            PhotolabJobKind::BuildOrthomosaic,
            PhotolabJobKind::BuildGaussianSplat,
            PhotolabJobKind::Batch,
        ] {
            assert!(supports_history_resume(kind), "{kind:?}");
        }
    }

    #[test]
    fn resume_identity_mismatch_is_a_typed_rpc_error() {
        let response = rpc_resume_err(
            serde_json::json!(7),
            &ResumeRpcFailure::mismatch(
                ResumeIdentityField::InputHash,
                "The checkpoint inputs changed.",
            ),
        );
        let error = response.error.expect("RPC error");
        assert_eq!(error.code, -32020);
        assert_eq!(
            error.data,
            Some(serde_json::json!({
                "code": "resumeIdentityMismatch",
                "field": "inputHash",
                "message": "The checkpoint inputs changed.",
                "retryable": false,
            }))
        );
    }

    #[test]
    fn product_import_refusal_is_a_typed_rpc_error() {
        let error = anyhow::Error::new(ProviderContractError::ProductImportRefused {
            reason_code: "invalid_package",
            message: "The import package is invalid.".to_owned(),
        });
        let response = product_rpc_err(serde_json::json!(7), &error);
        let error = response.error.expect("RPC error");
        assert_eq!(error.code, -32028);
        assert_eq!(
            error.data,
            Some(serde_json::json!({
                "code": "invalid_package",
                "reasonCode": "invalid_package",
                "message": "The import package is invalid.",
                "retryable": false,
            }))
        );
    }

    #[test]
    fn product_import_commit_keeps_authority_paths_sidecar_private() {
        let public = public_import_commit(serde_json::json!({
            "journalEntry": { "commandId": "import-product" },
            "inventory": {
                "externalObjects": [{
                    "objectHash": "abc",
                    "mediaType": "application/octet-stream",
                    "byteLength": 3,
                    "sourcePath": "/private/package/dataset.bin",
                    "authority": "hcad.product-import-package-manifest@1"
                }]
            }
        }))
        .expect("public import commit");
        let reference = &public["inventory"]["externalObjects"][0];
        assert!(reference.get("sourcePath").is_none());
        assert_eq!(reference["objectHash"], "abc");
        assert_eq!(
            reference["authority"],
            "hcad.product-import-package-manifest@1"
        );
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

    fn embedded_calibration_group(group_id: &str, camera_id: &str) -> ColmapCalibrationGroup {
        let full = himmelcad_domain_photogrammetry::photolab_images::DjiBrownConradyCalibration {
            focal_x_pixels: 3713.0,
            focal_y_pixels: 3713.0,
            principal_x_pixels: 2660.0,
            principal_y_pixels: 1961.0,
            radial_distortion: [-0.1, -0.001, -0.015],
            tangential_distortion: [0.0001, -0.00001],
            calibration_date: "2025-02-26".into(),
            provenance: himmelcad_domain_photogrammetry::photolab_images::DjiCalibrationProvenance::DewarpData,
        };
        ColmapCalibrationGroup {
            group_id: group_id.into(),
            camera_entity_ids: vec![camera_id.into()],
            seed: Some(ColmapCalibrationSeed {
                width_pixels: 5280,
                height_pixels: 3956,
                focal_pixels: full.focal_x_pixels,
                principal_x_pixels: full.principal_x_pixels,
                principal_y_pixels: full.principal_y_pixels,
                full_brown_calibration: Some(full),
            }),
        }
    }

    fn seeded_calibration_group(group_id: &str, camera_id: &str) -> ColmapCalibrationGroup {
        ColmapCalibrationGroup {
            group_id: group_id.into(),
            camera_entity_ids: vec![camera_id.into()],
            seed: Some(ColmapCalibrationSeed {
                width_pixels: 5280,
                height_pixels: 3956,
                focal_pixels: 3700.0,
                principal_x_pixels: 2640.0,
                principal_y_pixels: 1978.0,
                full_brown_calibration: None,
            }),
        }
    }

    fn unseeded_calibration_group(group_id: &str, camera_id: &str) -> ColmapCalibrationGroup {
        ColmapCalibrationGroup {
            group_id: group_id.into(),
            camera_entity_ids: vec![camera_id.into()],
            seed: None,
        }
    }

    #[test]
    fn every_group_policy_maps_onto_one_of_the_three_run_strategies() {
        let no_policies = BTreeMap::new();
        let embedded = vec![embedded_calibration_group("embedded", "camera-a")];
        let unseeded = vec![unseeded_calibration_group("poor", "camera-b")];
        let mixed = vec![
            embedded_calibration_group("embedded", "camera-a"),
            unseeded_calibration_group("poor", "camera-b"),
        ];

        // All fixed and all refine keep their historical run-wide mapper flags.
        assert_eq!(
            plan_intrinsics_refinement(&embedded, &no_policies),
            (
                ColmapIntrinsicsRefinement::FreezeReliableEmbedded,
                Vec::new()
            )
        );
        assert_eq!(
            plan_intrinsics_refinement(&unseeded, &no_policies),
            (ColmapIntrinsicsRefinement::Refine, Vec::new())
        );
        assert_eq!(
            plan_intrinsics_refinement(&[], &no_policies),
            (ColmapIntrinsicsRefinement::Refine, Vec::new())
        );
        // A disagreeing run refines everything and pins the calibrated group back afterwards
        // instead of freezing the metadata-poor mission with it.
        assert_eq!(
            plan_intrinsics_refinement(&mixed, &no_policies),
            (
                ColmapIntrinsicsRefinement::Refine,
                vec!["embedded".to_owned()]
            )
        );

        // A laboratory seed is pinned only when its explicit policy says Fixed.
        let lab = vec![
            seeded_calibration_group("lab", "camera-a"),
            unseeded_calibration_group("poor", "camera-b"),
        ];
        assert_eq!(
            plan_intrinsics_refinement(&lab, &no_policies),
            (ColmapIntrinsicsRefinement::Refine, Vec::new())
        );
        let fixed = BTreeMap::from([("lab".to_owned(), GcpIntrinsicsPolicy::Fixed)]);
        assert_eq!(
            plan_intrinsics_refinement(&lab, &fixed),
            (ColmapIntrinsicsRefinement::Refine, vec!["lab".to_owned()])
        );
        // Auto, Prior and Custom all refine: COLMAP cannot honour a partial parameter mask.
        for policy in [
            GcpIntrinsicsPolicy::Auto,
            GcpIntrinsicsPolicy::Prior {
                parameters:
                    himmelcad_domain_photogrammetry::photolab_gcp_optimization::GcpIntrinsicParameterMask::all(),
                stddev: himmelcad_domain_photogrammetry::photolab_gcp_optimization::GcpIntrinsicPriorStddev::default(
                ),
            },
            GcpIntrinsicsPolicy::Custom {
                parameters:
                    himmelcad_domain_photogrammetry::photolab_gcp_optimization::GcpIntrinsicParameterMask::all(),
            },
        ] {
            assert_eq!(
                plan_intrinsics_refinement(&lab, &BTreeMap::from([("lab".to_owned(), policy)])),
                (ColmapIntrinsicsRefinement::Refine, Vec::new())
            );
        }
        // A Fixed policy without any calibration has nothing to preserve.
        assert_eq!(
            plan_intrinsics_refinement(
                &mixed,
                &BTreeMap::from([("poor".to_owned(), GcpIntrinsicsPolicy::Fixed)])
            ),
            (
                ColmapIntrinsicsRefinement::Refine,
                vec!["embedded".to_owned()]
            )
        );
    }

    #[test]
    fn a_merge_starts_from_each_input_solve_rather_than_colmap_defaults() {
        let directory =
            std::env::temp_dir().join(format!("himmelcad-merge-seeds-{}", std::process::id()));
        let dataset = directory.join("datasets/colmap/first");
        std::fs::create_dir_all(dataset.join("sparse-view-source"))
            .expect("create fake published alignment");
        std::fs::write(
            dataset.join("camera-map.json"),
            br#"[{"entityId":"camera-a","imageName":"calibration-000000/image-00000000.jpg"},
                 {"entityId":"camera-b","imageName":"calibration-000001/image-00000001.jpg"}]"#,
        )
        .expect("write camera map");
        std::fs::write(
            dataset.join("sparse-view-source/cameras.txt"),
            "# cameras\n1 SIMPLE_RADIAL 5280 3956 3713 2660 1961 0.01\n2 SIMPLE_RADIAL 5280 3956 3801 2640 1978 0.02\n",
        )
        .expect("write solved cameras");
        std::fs::write(
            dataset.join("sparse-view-source/images.txt"),
            "# images\n1 1 0 0 0 0 0 0 1 calibration-000000/image-00000000.jpg\n0 0 1\n2 1 0 0 0 0 0 0 2 calibration-000001/image-00000001.jpg\n0 0 1\n",
        )
        .expect("write solved images");
        let roots =
            std::collections::HashMap::from([("alignment-first".to_owned(), dataset.clone())]);

        let mut groups = vec![
            embedded_calibration_group("embedded", "camera-a"),
            unseeded_calibration_group("poor", "camera-b"),
        ];
        let policies = BTreeMap::new();
        reseed_merge_calibration_groups(&mut groups, &roots, &policies);
        // The pinned group keeps the exact frozen calibration the joint solve must restore.
        assert_eq!(
            groups[0].seed.as_ref().expect("embedded seed").focal_pixels,
            3713.0
        );
        assert!(groups[0]
            .seed
            .as_ref()
            .expect("embedded seed")
            .full_brown_calibration
            .is_some());
        // The metadata-poor group starts from what its own mission already solved.
        let poor = groups[1]
            .seed
            .as_ref()
            .expect("reseeded metadata-poor group");
        assert_eq!(poor.focal_pixels, 3801.0);
        assert_eq!(poor.principal_x_pixels, 2640.0);
        assert_eq!(poor.width_pixels, 5280);
        std::fs::remove_dir_all(&directory).expect("clean up fake published alignment");
    }

    #[test]
    fn dedode_profiles_refuse_tiled_extraction_while_untiled_and_fast_proceed() {
        let tiling = AlignmentExtractionTiling {
            columns: 2,
            rows: 1,
            tiles: 2,
            overlap_px: 256,
        };
        let refusal =
            alignment_admission_refusal(AlignmentQualityProfile::QualityHybrid, Some(tiling))
                .expect("Quality Hybrid must fail closed when extraction is tiled");
        assert_eq!(refusal.code, ALIGNMENT_NEEDS_UNTILED_EXTRACTION_CODE);
        assert_eq!(refusal.message, ALIGNMENT_NEEDS_UNTILED_EXTRACTION_MESSAGE);
        assert!(
            alignment_admission_refusal(AlignmentQualityProfile::QualityHybrid, None).is_none()
        );
        assert!(alignment_admission_refusal(AlignmentQualityProfile::Fast, Some(tiling)).is_none());
        assert!(alignment_admission_refusal(
            AlignmentQualityProfile::MaximumRobustness,
            Some(tiling),
        )
        .is_some());
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
                gcp_optimization_entity_id: ProductGcpSelection::Latest,
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
                gcp_optimization_entity_id: ProductGcpSelection::Latest,
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
                    cell_size_m: default_smrf_cell_size_m(),
                    slope: default_smrf_slope(),
                    max_window_m: default_smrf_max_window_m(),
                    initial_distance_m: default_smrf_initial_distance_m(),
                },
                gcp_optimization_entity_id: ProductGcpSelection::Latest,
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
                gcp_optimization_entity_id: ProductGcpSelection::Latest,
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
    fn mesh_rpc_configuration_defaults_to_dem_and_accepts_dense() {
        let base = serde_json::json!({
            "kind": "mesh",
            "targetFaceCount": 100000,
            "interpolateHoles": false,
            "buildTexture": true,
            "textureSize": 2048
        });
        let dem: ProductRunConfiguration =
            serde_json::from_value(base.clone()).expect("legacy DEM mesh configuration");
        assert!(matches!(
            dem,
            ProductRunConfiguration::Mesh {
                mesh_source: himmelcad_domain_photogrammetry::photolab_products::MeshSource::Dem,
                ..
            }
        ));
        let mut dense_value = base;
        dense_value["meshSource"] = serde_json::json!("dense");
        let dense: ProductRunConfiguration =
            serde_json::from_value(dense_value).expect("dense mesh configuration");
        assert!(matches!(
            dense,
            ProductRunConfiguration::Mesh {
                mesh_source: himmelcad_domain_photogrammetry::photolab_products::MeshSource::Dense,
                ..
            }
        ));
    }

    fn test_product_lineage(alignment: &str, processing_set: Option<&str>) -> ProductLineage {
        ProductLineage {
            source_alignment_entity_id: EntityId(alignment.into()),
            processing_set_id: processing_set.map(|value| EntityId(value.into())),
            gcp_optimization_entity_id: None,
            gcp_optimization_snapshot_sha256: None,
            image_mask_scope_sha256: ObjectHash::of_bytes(b"mask-scope"),
        }
    }

    #[test]
    fn explicit_product_gcp_revision_is_honored() {
        let params: StartProductJobParams = serde_json::from_value(serde_json::json!({
            "operationId": "depth-explicit-gcp",
            "configuration": {
                "kind": "depth",
                "imageDownscale": 2,
                "filter": "moderate",
                "maximumNeighbors": 6,
                "reuseCompatibleMaps": true
            },
            "sourceAlignmentEntityId": "alignment-a",
            "gcpOptimizationEntityId": "gcp-revision-older"
        }))
        .expect("explicit product GCP request");
        let ProductGcpSelection::Explicit(entity_id) = params.gcp_optimization_entity_id else {
            panic!("explicit GCP revision was not preserved");
        };
        let mut lineage = test_product_lineage("alignment-a", None);
        let snapshot = ObjectHash::of_bytes(b"older-snapshot");
        pin_product_gcp_identity(&mut lineage, entity_id.clone(), snapshot.clone());
        assert_eq!(lineage.gcp_optimization_entity_id, Some(entity_id));
        assert_eq!(lineage.gcp_optimization_snapshot_sha256, Some(snapshot));
    }

    #[test]
    fn explicit_product_gcp_revision_rejects_wrong_lineage() {
        let lineage = test_product_lineage("alignment-a", Some("set-a"));
        assert!(!gcp_revision_matches_product_lineage(
            Some(&EntityId("alignment-b".into())),
            Some(&EntityId("set-a".into())),
            &lineage,
        ));
        assert!(!gcp_revision_matches_product_lineage(
            Some(&EntityId("alignment-a".into())),
            Some(&EntityId("set-b".into())),
            &lineage,
        ));
    }

    #[tokio::test]
    async fn corrupt_camera_map_fails_job_with_its_path_and_recovery_action() {
        let dataset = std::env::temp_dir().join(format!(
            "himmelcad-corrupt-camera-map-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dataset).expect("camera-map fixture directory");
        let camera_map_path = dataset.join("camera-map.json");
        std::fs::write(&camera_map_path, b"not JSON").expect("corrupt camera map");
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("job manager");
        let job_id = PhotolabJobId("corrupt-camera-map".into());
        let worker_dataset = dataset.clone();
        manager
            .start(
                NewPhotolabJob {
                    id: job_id.clone(),
                    kind: PhotolabJobKind::OptimizeAlignment,
                    config_hash: ObjectHash::of_bytes(b"camera-map-config"),
                    input_hash: ObjectHash::of_bytes(b"camera-map-input"),
                    progress: JobProgress {
                        stage: PhotolabStage {
                            kind: PhotolabStageKind::Preparing,
                            index: 0,
                            stage_count: 1,
                            label: "Prepare GCP cameras".into(),
                        },
                        metrics: ProgressMetrics::empty(),
                    },
                },
                move |_| {
                    attach_camera_reference_priors(&mut [], &[], &worker_dataset, &[], &[])
                        .map(|_| ())
                        .map_err(|error| JobWorkerError::Failed {
                            code: "gcpCameraPreparation".into(),
                            message: error.to_string(),
                        })
                },
            )
            .await
            .expect("start corrupt camera-map job");
        let terminal = manager
            .wait_for_terminal(&job_id)
            .await
            .expect("failed terminal state");
        let PhotolabJobState::Failed { code, message } = terminal.state else {
            panic!("corrupt camera map did not fail the job");
        };
        assert_eq!(code, "gcpCameraPreparation");
        assert!(message.contains(&camera_map_path.display().to_string()));
        assert!(message.contains("Re-run the alignment"));
        std::fs::remove_dir_all(dataset).expect("camera-map fixture cleanup");
    }

    #[test]
    fn merged_gcp_revision_matches_the_exact_merged_product_lineage() {
        let lineage = test_product_lineage("merged-alignment-a", None);
        assert!(gcp_revision_matches_product_lineage(
            Some(&EntityId("merged-alignment-a".into())),
            None,
            &lineage,
        ));
        assert!(!gcp_revision_matches_product_lineage(
            Some(&EntityId("alignment-input-a".into())),
            None,
            &lineage,
        ));
    }

    #[test]
    fn omitted_gcp_source_logs_the_alignment_run_fallback() {
        let output = TestArc::new(TestMutex::new(Vec::new()));
        let writer_output = TestArc::clone(&output);
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(move || TestLogWriter(TestArc::clone(&writer_output)))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            let error = resolve_gcp_source_alignment(
                &ProjectRuntime::default(),
                None,
                None,
                "fallback log test",
            )
            .expect_err("an unopened project has no fallback alignment");
            assert!(error.to_string().contains("no project is open"));
        });
        let output = String::from_utf8(output.lock().expect("log buffer").clone())
            .expect("UTF-8 tracing output");
        assert!(output.contains("omitted sourceAlignmentEntityId"));
        assert!(output.contains("latest AlignmentRun"));
    }

    #[test]
    fn georeferenced_overlap_merge_requires_a_converged_merged_optimization() {
        use himmelcad_domain_photogrammetry::project_runtime::AlignmentMergeConnection;

        let overlap = vec![AlignmentMergeConnection::Overlap {
            alignment_a: EntityId("alignment-a".into()),
            alignment_b: EntityId("alignment-b".into()),
            verified_cross_run_track_count: 12,
        }];
        let shared = vec![AlignmentMergeConnection::SharedControls {
            alignment_a: EntityId("alignment-a".into()),
            alignment_b: EntityId("alignment-b".into()),
            control_point_ids: vec!["A".into(), "B".into(), "C".into()],
        }];

        assert!(merged_frame_needs_optimization(false, &overlap, false));
        assert!(!merged_frame_needs_optimization(false, &overlap, true));
        assert!(!merged_frame_needs_optimization(false, &shared, false));
        assert!(!merged_frame_needs_optimization(true, &overlap, false));

        let response = product_rpc_err(
            serde_json::json!(7),
            &anyhow::Error::new(ProductInputFailure {
                code: MERGED_FRAME_NOT_GEOREFERENCED,
                message: MERGED_FRAME_NOT_GEOREFERENCED_MESSAGE,
            }),
        );
        let error = response.error.expect("typed product error");
        assert_eq!(error.code, -32040);
        assert_eq!(
            error.data.expect("typed error data")["code"],
            MERGED_FRAME_NOT_GEOREFERENCED
        );
    }

    #[test]
    fn resolve_inputs_and_started_product_share_the_pinned_lineage() {
        let resolve: ResolveProductInputsParams = serde_json::from_value(serde_json::json!({
            "kind": "dem",
            "sourceAlignmentEntityId": "alignment-a",
            "gcpOptimizationEntityId": "gcp-revision-a"
        }))
        .expect("resolve request");
        let start: StartProductJobParams = serde_json::from_value(serde_json::json!({
            "operationId": "dem-start",
            "configuration": {
                "kind": "dem",
                "surface": "dsm",
                "resolutionMetersPerPixel": 0.05,
                "interpolateNodata": false,
                "tileSizePixels": 512
            },
            "sourceAlignmentEntityId": "alignment-a",
            "gcpOptimizationEntityId": "gcp-revision-a"
        }))
        .expect("start request");
        assert_eq!(
            resolve.gcp_optimization_entity_id,
            start.gcp_optimization_entity_id
        );
        let snapshot = ObjectHash::of_bytes(b"snapshot-a");
        let mut resolved_lineage = test_product_lineage("alignment-a", None);
        let mut started_lineage = test_product_lineage("alignment-a", None);
        let ProductGcpSelection::Explicit(resolve_id) = resolve.gcp_optimization_entity_id else {
            panic!("resolve request lost explicit GCP revision");
        };
        let ProductGcpSelection::Explicit(start_id) = start.gcp_optimization_entity_id else {
            panic!("start request lost explicit GCP revision");
        };
        pin_product_gcp_identity(&mut resolved_lineage, resolve_id, snapshot.clone());
        pin_product_gcp_identity(&mut started_lineage, start_id, snapshot);
        assert_eq!(resolved_lineage, started_lineage);
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
