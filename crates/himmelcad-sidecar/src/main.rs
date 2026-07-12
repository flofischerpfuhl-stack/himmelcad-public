//! HimmelCAD sidecar: a long-running OS process that speaks JSON-RPC 2.0 over
//! stdio. Electron's main process spawns and supervises this binary.
//!
//! The sidecar holds the authoritative project state (entity store, command
//! journal, spatial indexes). The renderer mirrors snapshots and never mutates
//! state directly.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::io::BufReader as StdBufReader;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use himmelcad_core::entity::EntityId;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab::{
    resolve_alignment_profile, AlignmentQualityProfile, ResolveAlignmentProfileRequest,
};
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
use himmelcad_io::{
    import_gcp_csv_file, import_las_file_with_progress, import_photo_files, preview_gcp_csv_file,
    ConverterProgress,
};

use crate::project_runtime::{
    AppendJournalParams, CancelArchiveParams, CreateProcessingSetParams, CreateProjectParams,
    FinishJournalParams, MoveEntityParams, OpenProjectParams, ProductLineage, ProjectRuntime,
    PublishedRasterKind, RenameEntityParams, SaveProjectAsParams, SetEntityVisibilityParams,
};
use himmelcad_sidecar::brush_runtime::{
    BrushRunRequest, BrushRuntime, BrushTrainingSettings, DevBrushRuntimeConfig,
};
use himmelcad_sidecar::colmap_runtime::{
    AlikedModelVariant, ColmapArtifactKind, ColmapComputeDevice, ColmapMesher, ColmapPairSelection,
    ColmapProductRequest, ColmapResourceKind, ColmapRunOutcome, ColmapRunRequest, ColmapRuntime,
    DedodeV2GPolicy, DevColmapRuntimeConfig, LargeMatchingBackend, MappingFeatureStore,
};
use himmelcad_sidecar::dedode_runtime::{
    DedodeComputeDevice, DedodeImagePair, DedodeRunRequest, DedodeRuntime, DevDedodeRuntimeConfig,
};
use himmelcad_sidecar::dense_raster_prep::{
    inspect_raster_wkt, inspect_vector_wkt, prepare_dense_potree, prepare_dense_vector,
    prepare_sparse_potree, DenseRasterPrepError,
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
use himmelcad_sidecar::job_runtime::{
    JobIdParams, JobManager, JobManagerConfig, JobWorkerContext, JobWorkerError, ListJobsParams,
};
use himmelcad_sidecar::mesh_tiler::{build_tiled_dem_mesh, MeshTilerError};
use himmelcad_sidecar::mvs_runtime::{
    DevMvsRuntimeConfig, MvsCapability, MvsComputeDevice, MvsRunRequest, MvsRuntime, MvsSettings,
};
use himmelcad_sidecar::mvs_scene::{
    load_gcp_bundle_tie_points, prepare_gcp_cameras, prepare_mvs_scene,
};
use himmelcad_sidecar::orthophoto_prep::{
    prepare_camera_orthophotos, CameraBlendMode, OrthophotoPreparation, OrthophotoPreparationError,
};
use himmelcad_sidecar::product_export::{export_product, ProductExportError, ProductExportRequest};
use himmelcad_sidecar::raster_runtime::{
    ElevationGeometrySource, ElevationInputTile, ElevationInterpolation, ElevationRasterRequest,
    ElevationSurface, ElevationViewRange, GdalToolchainConfig, MosaicOrder, OrthomosaicRequest,
    RasterBounds, RasterBuildCommand, RasterCrs, RasterGrid, RasterNoDataValue, RasterPhase,
    RasterProductRequest, RasterProgress, RasterResampling, RasterRuntime,
};
use himmelcad_sidecar::splat_tiler::{tile_brush_ply, SplatTilerError};
use himmelcad_sidecar::{
    crs_runtime::{ProjRuntime, ProjToolchainConfig},
    crs_service::{
        CancelCrsOperationParams, CrsService, DiscoverCrsOperationsParams, FreezeCrsOperationParams,
    },
};

mod project_runtime;

const PROGRESS_PREFIX: &str = "__HC_PROGRESS__";
const MIN_CAMERA_REFERENCE_SIGMA_METERS: f64 = 0.001;

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
}

#[derive(Debug, Deserialize)]
struct ImportLasParams {
    paths: Vec<String>,
    #[serde(default)]
    cache_dir: Option<String>,
    #[serde(default)]
    progress_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InspectPhotolabImagesParams {
    paths: Vec<String>,
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartAlignmentJobParams {
    operation_id: String,
    profile: AlignmentQualityProfile,
    #[serde(default)]
    camera_entity_ids: Vec<String>,
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
        reuse_compatible_maps: bool,
    },
    Dense {
        #[serde(default = "default_dense_image_downscale")]
        image_downscale: u32,
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
    },
    Mesh {
        target_face_count: u64,
        interpolate_holes: bool,
        build_texture: bool,
        texture_size: u32,
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartProductExportJobParams {
    operation_id: String,
    entity_id: EntityId,
    destination_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
enum BatchPipelineStep {
    Alignment {
        profile: AlignmentQualityProfile,
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
    alignment_dataset: PathBuf,
    scene_root: PathBuf,
    colmap_executable: PathBuf,
    coordinate_frame_id: String,
    settings: MvsSettings,
    fuse_dense_point_cloud: bool,
    reuse_compatible_maps: bool,
    project_transform: Option<GcpSimilarityTransform>,
    optimized_cameras: Option<Vec<OptimizedGcpCamera>>,
    camera_entity_ids: Vec<String>,
    lineage: ProductLineage,
}

struct PreparedRasterProductJob {
    job: NewPhotolabJob,
    operation_id: String,
    configuration: ProductRunConfiguration,
    project_root: PathBuf,
    dense_ply: Option<PathBuf>,
    dem_dataset: Option<(
        PathBuf,
        himmelcad_sidecar::raster_runtime::RasterBuildSummary,
    )>,
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
    lineage: ProductLineage,
}

const fn default_gcp_preview_rows() -> usize {
    100
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
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
    let jobs = Arc::new(JobManager::new(default_job_manager_config())?);
    let crs = Arc::new(default_crs_service()?);
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
        let response_tx = response_tx.clone();
        let parsed = serde_json::from_str::<RpcRequest>(&line);
        tokio::spawn(async move {
            let response = match parsed {
                Ok(req) => handle(req, projects, jobs, crs).await,
                Err(err) => RpcResponse {
                    jsonrpc: "2.0",
                    id: serde_json::Value::Null,
                    result: None,
                    error: Some(RpcError {
                        code: -32700,
                        message: format!("parse error: {err}"),
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

    Ok(())
}

async fn handle(
    req: RpcRequest,
    projects: Arc<ProjectRuntime>,
    jobs: Arc<JobManager>,
    crs: Arc<CrsService>,
) -> RpcResponse {
    if req.jsonrpc != "2.0" {
        return rpc_err(req.id, -32600, "invalid jsonrpc version");
    }
    if req.method.starts_with("photolab.project.") {
        return handle_project_rpc(req, projects, &jobs).await;
    }
    if req.method.starts_with("photolab.jobs.") {
        return handle_job_rpc(req, &jobs, projects).await;
    }
    if req.method.starts_with("photolab.crs.") {
        return handle_crs_rpc(req, &crs).await;
    }
    if req.method.starts_with("photolab.images.") {
        return handle_image_rpc(req, projects, &crs).await;
    }
    if req.method.starts_with("photolab.gcp.") {
        return handle_gcp_rpc(req, projects, &crs).await;
    }
    if req.method.starts_with("photolab.products.") {
        return handle_product_rpc(req, projects).await;
    }

    match req.method.as_str() {
        "ping" => RpcResponse {
            jsonrpc: "2.0",
            id: req.id,
            result: Some(serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") })),
            error: None,
        },
        "import.las" => match serde_json::from_value::<ImportLasParams>(req.params.clone()) {
            Ok(params) => match handle_import_las(params).await {
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
        "photolab.images.inspect" => {
            rpc_blocking_with_params::<InspectPhotolabImagesParams, _, _>(
                req.id,
                req.params,
                |params| {
                    if params.paths.is_empty() {
                        anyhow::bail!("at least one image or directory path is required");
                    }
                    let paths = params
                        .paths
                        .into_iter()
                        .map(PathBuf::from)
                        .collect::<Vec<_>>();
                    Ok(import_photo_files(&paths))
                },
            )
            .await
        }
        "photolab.images.commit" => {
            match serde_json::from_value::<CommitImagesParams>(req.params) {
                Ok(params) => match enrich_projected_references(params, crs).await {
                    Ok(params) => {
                        rpc_blocking(req.id, move || projects.commit_images(params)).await
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
        .transform_text(&operation_id, &params.transformation, &input)
        .await?;
    let coordinates = parse_transformed_coordinates(&output)?;
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
            transformation_decision_sha256: params.transformation.decision_sha256.clone(),
        });
    }
    Ok(params)
}

fn parse_transformed_coordinates(output: &str) -> anyhow::Result<Vec<[f64; 3]>> {
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
        coordinates.push([*easting, *northing, *height]);
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
        track.as_ref().map_or(&[], std::slice::from_ref),
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
    let output = context
        .working_path
        .join(".photolab/cache/gcp-camera-catalog");
    let cancellation = himmelcad_core::photolab_jobs::CancellationToken::new();
    let prepared = prepare_gcp_cameras(
        &development_colmap_executable()?,
        &alignment,
        &output,
        &cancellation,
    )?;
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
    let coordinates = parse_transformed_coordinates(&output)?;
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
) -> RpcResponse {
    match req.method.as_str() {
        "photolab.jobs.startProductExport" => {
            match serde_json::from_value::<StartProductExportJobParams>(req.params) {
                Ok(params) => match prepare_product_export_job(params, &projects) {
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
                    Ok(job) => {
                        let publisher = Arc::clone(&projects);
                        let result = jobs
                            .start(job, move |context| {
                                run_batch_pipeline(params, &context, &publisher)
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
        "photolab.jobs.startAlignment" => {
            match serde_json::from_value::<StartAlignmentJobParams>(req.params) {
                Ok(params) => match prepare_alignment_job(params, &projects) {
                    Ok((job, request, runtime, dedode)) => {
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
                                context.check_cancelled()?;
                                publisher.publish_colmap_outcome(outcome).map_err(|error| {
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
                                        .latest_gcp_optimization()
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
                                    let scene = prepare_mvs_scene(
                                        &prepared.colmap_executable,
                                        &prepared.alignment_dataset,
                                        &prepared.scene_root,
                                        &prepared.coordinate_frame_id,
                                        prepared.settings.maximum_image_dimension,
                                        prepared.project_transform,
                                        prepared.optimized_cameras.as_deref(),
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
                                                code: "mvsScenePreparation".into(),
                                                message: error.to_string(),
                                            }
                                        }
                                    })?;
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
                                    let mut outcome = prepared
                                        .runtime
                                        .run(&request, &context)
                                        .map_err(himmelcad_sidecar::job_runtime::JobWorkerError::from)?;
                                    if let Some(dense) = outcome.output.dense_point_cloud.as_ref() {
                                        let dense_path = outcome.output_path.join(&dense.relative_path);
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
                Ok(params) => match prepare_colmap_product_job(params, &projects) {
                    Ok((job, request, runtime)) => {
                        let publisher = Arc::clone(&projects);
                        let result = jobs
                            .start(job, move |context| {
                                let outcome = runtime.run(&request, &context).map_err(
                                    himmelcad_sidecar::job_runtime::JobWorkerError::from,
                                )?;
                                context.check_cancelled()?;
                                publisher.publish_colmap_outcome(outcome).map_err(|error| {
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
        "photolab.jobs.list" => match serde_json::from_value::<ListJobsParams>(req.params) {
            Ok(params) => rpc_result(req.id, Ok::<_, anyhow::Error>(jobs.list(params).await)),
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
    ProductLineage,
);

fn prepare_batch_job(
    params: &StartBatchJobParams,
    projects: &ProjectRuntime,
) -> anyhow::Result<NewPhotolabJob> {
    anyhow::ensure!(
        !params.steps.is_empty() && params.steps.len() <= 32,
        "batch needs 1..=32 steps"
    );
    let context = projects.compute_context()?;
    let bytes = serde_json::to_vec(&(&params.steps, &params.camera_entity_ids))?;
    let stage_count = 1_u32.saturating_add(u32::try_from(params.steps.len())?.saturating_mul(32));
    Ok(NewPhotolabJob {
        id: PhotolabJobId(params.operation_id.clone()),
        kind: PhotolabJobKind::Batch,
        config_hash: ObjectHash::of_bytes(&bytes),
        input_hash: ObjectHash::of_bytes(&serde_json::to_vec(&(
            &context.manifest.project_id,
            &context.camera_images,
        ))?),
        progress: JobProgress {
            stage: PhotolabStage {
                kind: PhotolabStageKind::Preparing,
                index: 0,
                stage_count,
                label: "Validate batch and recovery state".into(),
            },
            metrics: ProgressMetrics::empty(),
        },
    })
}

fn run_batch_pipeline(
    params: StartBatchJobParams,
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
    let steps_sha256 = batch_steps_hash(&params.steps, &params.camera_entity_ids)
        .map_err(|error| worker_error("batchCheckpoint", &error.to_string()))?;
    let input_sha256 = batch_input_hash(projects, &compute_context)
        .map_err(|error| worker_error("batchCheckpoint", &error.to_string()))?;
    let checkpoint_root = compute_context
        .working_path
        .join(".photolab/batch")
        .join(&steps_sha256.0);
    std::fs::create_dir_all(&checkpoint_root)
        .map_err(|error| worker_error("io", &error.to_string()))?;
    let checkpoint_path = checkpoint_root.join("checkpoint.json");
    let completed = read_batch_checkpoint(&checkpoint_path, &steps_sha256, &input_sha256)
        .map_err(|error| worker_error("batchCheckpoint", &error.to_string()))?
        .min(params.steps.len());
    for (index, step) in params.steps.iter().cloned().enumerate().skip(completed) {
        context.check_cancelled()?;
        let base = 1 + u32::try_from(index).unwrap_or(u32::MAX).saturating_mul(32);
        match step.clone() {
            BatchPipelineStep::Alignment { profile } => {
                let (_, request, runtime, dedode) = prepare_alignment_job(
                    StartAlignmentJobParams {
                        operation_id: format!("{}-{:02}-alignment", params.operation_id, index),
                        profile,
                        camera_entity_ids: params.camera_entity_ids.clone(),
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
                context.check_cancelled()?;
                projects
                    .publish_colmap_outcome(outcome)
                    .map_err(|error| worker_error("projectPublish", &error.to_string()))?;
            }
            BatchPipelineStep::Product { configuration } => execute_batch_product(
                &params.operation_id,
                index,
                configuration,
                &params.camera_entity_ids,
                context,
                projects,
                base,
                total,
            )?,
        }
        projects
            .autosave()
            .map_err(|error| worker_error("autosave", &error.to_string()))?;
        write_batch_checkpoint(&checkpoint_path, &steps_sha256, &input_sha256, index + 1)
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

fn execute_batch_product(
    batch_id: &str,
    index: usize,
    configuration: ProductRunConfiguration,
    camera_entity_ids: &[String],
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
                    processing_set_id: None,
                },
                projects,
                Some(camera_entity_ids),
            )
            .map_err(|error| worker_error("batchPrepare", &error.to_string()))?;
            let node = context.with_progress_window(base, total);
            let scene = prepare_mvs_scene(
                &prepared.colmap_executable,
                &prepared.alignment_dataset,
                &prepared.scene_root,
                &prepared.coordinate_frame_id,
                prepared.settings.maximum_image_dimension,
                prepared.project_transform,
                prepared.optimized_cameras.as_deref(),
                &node.cancellation,
            )
            .map_err(|error| worker_error("mvsScenePreparation", &error.to_string()))?;
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
                .publish_mvs_outcome(outcome, &prepared.camera_entity_ids, &prepared.lineage)
                .map_err(|error| worker_error("projectPublish", &error.to_string()))?;
        }
        config @ ProductRunConfiguration::Dem { .. }
        | config @ ProductRunConfiguration::Ortho { .. } => {
            let prepared = prepare_raster_product_job(
                StartProductJobParams {
                    operation_id,
                    configuration: config,
                    processing_set_id: None,
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
                    processing_set_id: None,
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
                    processing_set_id: None,
                },
                projects,
                Some(camera_entity_ids),
            )
            .map_err(|error| worker_error("batchPrepare", &error.to_string()))?;
            let node = context.with_progress_window(base, total);
            let mut outcome = runtime.run(&request, &node).map_err(JobWorkerError::from)?;
            let transform = projects
                .latest_gcp_optimization()
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
) -> anyhow::Result<ObjectHash> {
    let gcp_hash = projects.list_gcps()?.map(|(hash, _)| hash);
    Ok(ObjectHash::of_bytes(&serde_json::to_vec(&(
        &context.manifest.project_id,
        &context.camera_images,
        gcp_hash,
    ))?))
}

fn read_batch_checkpoint(
    path: &Path,
    steps_sha256: &ObjectHash,
    input_sha256: &ObjectHash,
) -> anyhow::Result<usize> {
    if !path.is_file() {
        return Ok(0);
    }
    let value: BatchCheckpoint = serde_json::from_slice(&std::fs::read(path)?)?;
    if value.schema_version != 2
        || value.steps_sha256 != *steps_sha256
        || value.input_sha256 != *input_sha256
    {
        return Ok(0);
    }
    Ok(value.completed_steps)
}
fn write_batch_checkpoint(
    path: &Path,
    steps_sha256: &ObjectHash,
    input_sha256: &ObjectHash,
    completed_steps: usize,
) -> anyhow::Result<()> {
    let value = BatchCheckpoint {
        schema_version: 2,
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
        lineage,
    ))
}

fn attach_camera_reference_priors(
    prepared: &mut [himmelcad_sidecar::mvs_scene::PreparedGcpCamera],
    camera_images: &[himmelcad_sidecar::image_commit::ProjectCameraImageRecord],
    alignment_dataset: &Path,
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
        entry.camera.reference_center_world_meters =
            Some([reference.easting, reference.northing, height]);
        entry.camera.reference_stddev_meters = Some([
            rtk.and_then(|value| value.standard_deviation_longitude_meters)
                .unwrap_or(horizontal_default)
                .max(MIN_CAMERA_REFERENCE_SIGMA_METERS),
            rtk.and_then(|value| value.standard_deviation_latitude_meters)
                .unwrap_or(horizontal_default)
                .max(MIN_CAMERA_REFERENCE_SIGMA_METERS),
            rtk.and_then(|value| value.standard_deviation_height_meters)
                .unwrap_or(height_default)
                .max(MIN_CAMERA_REFERENCE_SIGMA_METERS),
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

fn prepare_alignment_job(
    params: StartAlignmentJobParams,
    projects: &ProjectRuntime,
) -> anyhow::Result<(
    NewPhotolabJob,
    ColmapRunRequest,
    ColmapRuntime,
    Option<(DedodeRuntime, DedodeRunRequest)>,
)> {
    let context = projects.compute_context()?;
    let camera_images =
        select_alignment_cameras(&context.camera_images, &params.camera_entity_ids)?;
    let image_count = u32::try_from(camera_images.len())
        .context("project image count exceeds supported alignment range")?;
    let resolved = resolve_alignment_profile(&ResolveAlignmentProfileRequest {
        profile: params.profile,
        image_count,
        max_image_edge_override: None,
    })?;
    let feature_worker_threads = colmap_feature_worker_threads(resolved.max_image_edge);
    let request = ColmapRunRequest {
        job_id: params.operation_id.clone(),
        project_root: context.working_path.clone(),
        camera_images: camera_images.clone(),
        device: ColmapComputeDevice::Cpu,
        pair_selection: if params.profile == AlignmentQualityProfile::Fast {
            ColmapPairSelection::Sequential { overlap: 12 }
        } else {
            ColmapPairSelection::Exhaustive
        },
        mapping_store: MappingFeatureStore::Aliked,
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
        aliked_max_features: match params.profile {
            AlignmentQualityProfile::Fast => 8_000,
            AlignmentQualityProfile::QualityHybrid => 16_000,
            AlignmentQualityProfile::MaximumRobustness => 32_000,
        },
        sift_max_features: match params.profile {
            AlignmentQualityProfile::Fast => 8_000,
            AlignmentQualityProfile::QualityHybrid => 16_000,
            AlignmentQualityProfile::MaximumRobustness => 32_000,
        },
        sift_rescue_only: params.profile == AlignmentQualityProfile::Fast,
        max_image_size: resolved.max_image_edge,
        feature_worker_threads,
        aliked_matching_worker_threads: colmap_aliked_matching_worker_threads(),
        matching_worker_threads: colmap_matching_worker_threads(),
        products: ColmapProductRequest::default(),
    };
    let input_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
        &context.manifest.project_id,
        &camera_images,
    ))?);
    let mut job = NewPhotolabJob {
        id: PhotolabJobId(params.operation_id),
        kind: PhotolabJobKind::AlignPhotos,
        config_hash: resolved.config_hash,
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
    Ok((job, request, runtime, dedode))
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

fn prepare_colmap_product_job(
    params: StartProductJobParams,
    projects: &ProjectRuntime,
) -> anyhow::Result<(NewPhotolabJob, ColmapRunRequest, ColmapRuntime)> {
    let context = projects.compute_context()?;
    if context.camera_images.len() < 2 {
        anyhow::bail!("at least two imported images are required");
    }
    let config_bytes = serde_json::to_vec(&params.configuration)?;
    let (kind, products) = match &params.configuration {
        ProductRunConfiguration::Depth {
            image_downscale, ..
        } => {
            anyhow::ensure!(
                [1, 2, 4, 8].contains(image_downscale),
                "invalid image downscale"
            );
            (
                PhotolabJobKind::BuildDepthMaps,
                ColmapProductRequest {
                    depth_maps: true,
                    max_image_size: 12_800 / image_downscale,
                    ..ColmapProductRequest::default()
                },
            )
        }
        ProductRunConfiguration::Dense { minimum_views, .. } => {
            anyhow::ensure!(
                *minimum_views >= 2 && *minimum_views <= 16,
                "invalid minimum views"
            );
            (
                PhotolabJobKind::BuildDensePointCloud,
                ColmapProductRequest {
                    depth_maps: true,
                    dense_point_cloud: true,
                    ..ColmapProductRequest::default()
                },
            )
        }
        ProductRunConfiguration::Mesh {
            target_face_count,
            build_texture,
            ..
        } => {
            anyhow::ensure!(*target_face_count >= 10_000, "invalid target face count");
            (
                PhotolabJobKind::BuildMesh,
                ColmapProductRequest {
                    depth_maps: true,
                    dense_point_cloud: true,
                    mesh: Some(ColmapMesher::Poisson),
                    texture_mesh: *build_texture,
                    ..ColmapProductRequest::default()
                },
            )
        }
        ProductRunConfiguration::Dem { .. } => {
            anyhow::bail!("DEM requires a prepared dense/mesh dataset; raster job integration is still initializing")
        }
        ProductRunConfiguration::Ortho { .. } => {
            anyhow::bail!("orthomosaic requires prepared camera warp sources; raster job integration is still initializing")
        }
        ProductRunConfiguration::Splat { .. } => {
            anyhow::bail!("Gaussian Splat worker integration is still initializing")
        }
    };
    let device = colmap_dense_device()?;
    let request = ColmapRunRequest {
        job_id: params.operation_id.clone(),
        project_root: context.working_path.clone(),
        camera_images: context.camera_images.clone(),
        device,
        pair_selection: ColmapPairSelection::Exhaustive,
        mapping_store: MappingFeatureStore::Aliked,
        aliked_variant: AlikedModelVariant::N32,
        large_matching_backend: LargeMatchingBackend::Disabled,
        aliked_max_features: 16_000,
        sift_max_features: 16_000,
        sift_rescue_only: false,
        max_image_size: 8_000,
        feature_worker_threads: colmap_feature_worker_threads(8_000),
        aliked_matching_worker_threads: colmap_aliked_matching_worker_threads(),
        matching_worker_threads: colmap_matching_worker_threads(),
        products,
    };
    let mut input_material =
        serde_json::to_vec(&(&context.manifest.project_id, &context.camera_images))?;
    input_material.extend_from_slice(&config_bytes);
    let job = NewPhotolabJob {
        id: PhotolabJobId(params.operation_id),
        kind,
        config_hash: ObjectHash::of_bytes(&config_bytes),
        input_hash: ObjectHash::of_bytes(&input_material),
        progress: request.progress_plan().initial_progress(),
    };
    let runtime = development_colmap_runtime(&context.working_path)?;
    Ok((job, request, runtime))
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
            reuse_compatible_maps,
        } => {
            anyhow::ensure!(
                [1, 2, 4, 8].contains(&image_downscale),
                "invalid image downscale"
            );
            settings.maximum_image_dimension =
                source_maximum_dimension.div_ceil(image_downscale).max(256);
            match filter.as_str() {
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
            (
                PhotolabJobKind::BuildDepthMaps,
                false,
                reuse_compatible_maps,
            )
        }
        ProductRunConfiguration::Dense {
            image_downscale,
            minimum_views,
            retain_confidence,
            calculate_colors,
        } => {
            anyhow::ensure!(
                [1, 2, 4, 8].contains(&image_downscale),
                "invalid image downscale"
            );
            anyhow::ensure!((2..=16).contains(&minimum_views), "invalid minimum views");
            settings.maximum_image_dimension =
                source_maximum_dimension.div_ceil(image_downscale).max(256);
            settings.matching_views = u8::try_from(minimum_views.max(6))?;
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
        required_camera_scope,
    )?;
    anyhow::ensure!(
        alignment.camera_entity_ids.len() >= 3,
        "portable multi-view stereo needs at least three cameras in the selected alignment"
    );
    let alignment_dataset = alignment.root.clone();
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
    let runtime = MvsRuntime::development_preflight(&DevMvsRuntimeConfig {
        executable,
        version: "1.0.0".into(),
        capabilities,
        scratch_root: context.working_path.join(".photolab/scratch/mvs"),
        allowed_scene_roots: vec![scene_parent],
    })?;
    let lineage = ProductLineage {
        source_alignment_entity_id: alignment.source_alignment_entity_id.clone(),
        processing_set_id: alignment.processing_set_id.clone(),
    };
    let gcp_optimization = projects.latest_gcp_optimization_for_lineage(&lineage)?;
    let project_transform = gcp_optimization
        .as_ref()
        .map(|record| record.artifact.result.transform);
    let gcp_artifact_sha256 = gcp_optimization
        .as_ref()
        .map(|record| record.artifact_sha256.clone());
    let optimized_cameras = gcp_optimization.map(|record| record.artifact.result.cameras);
    let placeholder_request = MvsRunRequest {
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
    ))?);
    let job = NewPhotolabJob {
        id: PhotolabJobId(params.operation_id.clone()),
        kind,
        config_hash: ObjectHash::of_bytes(&config_bytes),
        input_hash: ObjectHash::of_bytes(&input),
        progress: MvsRuntime::initial_progress(&placeholder_request),
    };
    Ok(PreparedMvsProductJob {
        job,
        runtime,
        operation_id: params.operation_id,
        alignment_dataset,
        scene_root,
        colmap_executable: development_colmap_executable()?,
        coordinate_frame_id: context.manifest.project_id,
        settings,
        fuse_dense_point_cloud,
        reuse_compatible_maps,
        project_transform,
        optimized_cameras,
        camera_entity_ids: alignment.camera_entity_ids,
        lineage,
    })
}

fn resolve_product_alignment(
    projects: &ProjectRuntime,
    processing_set_id: Option<&EntityId>,
    required_camera_scope: Option<&[String]>,
) -> anyhow::Result<crate::project_runtime::PublishedAlignmentDataset> {
    anyhow::ensure!(
        processing_set_id.is_none() || required_camera_scope.is_none(),
        "a product cannot combine a processing set with a separate batch camera scope"
    );
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

fn prepare_product_export_job(
    params: StartProductExportJobParams,
    projects: &ProjectRuntime,
) -> anyhow::Result<(NewPhotolabJob, ProductExportRequest)> {
    let source = projects.product_export_source(&params.entity_id)?;
    let metadata = source.source_path.metadata()?;
    let config_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
        &params.entity_id,
        &params.destination_path,
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
        required_camera_scope,
    )?;
    let lineage = ProductLineage {
        source_alignment_entity_id: alignment.source_alignment_entity_id.clone(),
        processing_set_id: alignment.processing_set_id.clone(),
    };
    let gcp_optimization = projects.latest_gcp_optimization_for_lineage(&lineage)?;
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
            ProductRunConfiguration::Ortho { .. } => {
                let (dem_root, dem_record) = projects
                    .latest_raster_dataset_for_lineage(PublishedRasterKind::Dem, &lineage)?;
                (
                    PhotolabJobKind::BuildOrthomosaic,
                    None,
                    Some((dem_root, dem_record.summary)),
                    Some(alignment.root.clone()),
                    Some(development_colmap_executable()?),
                    ObjectHash::of_bytes(alignment.root.to_string_lossy().as_bytes()),
                )
            }
            _ => anyhow::bail!("raster preparation needs a DEM or orthomosaic configuration"),
        };
    let input_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
        input_evidence,
        &config_bytes,
        &lineage.source_alignment_entity_id,
        &lineage.processing_set_id,
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
        ..
    } = params.configuration
    else {
        anyhow::bail!("mesh configuration required")
    };
    anyhow::ensure!(target_face_count >= 10_000, "invalid target face count");
    let context = projects.compute_context()?;
    let alignment = resolve_product_alignment(
        projects,
        params.processing_set_id.as_ref(),
        required_camera_scope,
    )?;
    let lineage = ProductLineage {
        source_alignment_entity_id: alignment.source_alignment_entity_id,
        processing_set_id: alignment.processing_set_id,
    };
    let (dem_root, dem) =
        projects.latest_raster_dataset_for_lineage(PublishedRasterKind::Dem, &lineage)?;
    let (texture_dataset_root, texture_summary) = if build_texture {
        let (ortho_root, ortho) = projects
            .latest_raster_dataset_for_lineage(PublishedRasterKind::Orthomosaic, &lineage)?;
        (Some(ortho_root), Some(ortho.summary))
    } else {
        (None, None)
    };
    let config_hash =
        ObjectHash::of_bytes(&serde_json::to_vec(&(target_face_count, build_texture))?);
    let input_hash = ObjectHash::of_bytes(&serde_json::to_vec(&(
        &dem.job_id,
        &texture_dataset_root,
        &lineage.source_alignment_entity_id,
        &lineage.processing_set_id,
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
            ))
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
            let (dem_root, dem_summary) = prepared.dem_dataset.as_ref().ok_or_else(|| {
                worker_error("invalidRasterInput", "orthomosaic has no DEM input")
            })?;
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
            .map_err(|error| worker_error("orthophotoScene", &error.to_string()))?;
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
            });
            (crs, grid, product)
        }
        _ => {
            return Err(worker_error(
                "invalidRasterConfig",
                "unexpected raster configuration",
            ))
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
        required_camera_scope,
    )?;
    let project_root = projects.compute_context()?.working_path;
    let dataset_root = prepare_brush_scene(&alignment.root, &project_root, &params.operation_id)?;
    let lineage = ProductLineage {
        source_alignment_entity_id: alignment.source_alignment_entity_id,
        processing_set_id: alignment.processing_set_id,
    };
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

fn colmap_dense_device() -> anyhow::Result<ColmapComputeDevice> {
    if let Some(indices) = std::env::var_os("HIMMELCAD_COLMAP_CUDA_GPUS") {
        let parsed = indices
            .to_string_lossy()
            .split(',')
            .map(str::trim)
            .map(str::parse::<u32>)
            .collect::<Result<Vec<_>, _>>()?;
        anyhow::ensure!(!parsed.is_empty(), "HIMMELCAD_COLMAP_CUDA_GPUS is empty");
        return Ok(ColmapComputeDevice::Cuda {
            gpu_indices: parsed,
        });
    }
    anyhow::bail!(
        "the curated COLMAP worker needs CUDA for PatchMatch; configure HIMMELCAD_COLMAP_CUDA_GPUS or select the portable MVS worker"
    )
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
    probe_hardware()
        .map(|hardware| {
            let memory_workers = (hardware.ram_bytes / 2 / (8 * GIB)).max(1);
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

async fn handle_import_las(params: ImportLasParams) -> anyhow::Result<serde_json::Value> {
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
    let progress_key = params.progress_key.clone();
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
        let summary = tokio::task::spawn_blocking(move || {
            let progress_key_for_callback = progress_key_for_file.clone();
            let file_name_for_callback = file_name.clone();
            import_las_file_with_progress(&path, &cache_dir_clone, move |p| {
                emit_import_progress(
                    progress_key_for_callback.as_deref(),
                    index,
                    total,
                    &file_name_for_callback,
                    &p,
                );
            })
        })
        .await??;
        tracing::info!(
            path = %summary.source_path,
            loaded = summary.point_count_loaded,
            total = summary.point_count_total,
            "import.las completed"
        );
        summaries.push(summary);
    }
    emit_progress(
        progress_key.as_deref(),
        0.85,
        &format!("Conversion finished for {total} LAS/LAZ file(s)"),
    );
    Ok(serde_json::json!({ "imports": summaries }))
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

fn rpc_err(id: serde_json::Value, code: i32, message: &str) -> RpcResponse {
    RpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(RpcError {
            code,
            message: message.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn sample_steps() -> Vec<BatchPipelineStep> {
        vec![
            BatchPipelineStep::Alignment {
                profile: AlignmentQualityProfile::QualityHybrid,
            },
            BatchPipelineStep::Product {
                configuration: ProductRunConfiguration::Dense {
                    image_downscale: 2,
                    minimum_views: 3,
                    retain_confidence: true,
                    calculate_colors: true,
                },
            },
        ]
    }

    #[test]
    fn product_rpc_configuration_uses_renderer_camel_case_fields() {
        let configuration: ProductRunConfiguration = serde_json::from_value(serde_json::json!({
            "kind": "depth",
            "imageDownscale": 8,
            "filter": "moderate",
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
        let steps = batch_steps_hash(&sample_steps(), &[]).expect("steps hash");
        let inputs = ObjectHash::of_bytes(b"inputs-a");
        write_batch_checkpoint(&path, &steps, &inputs, 2).expect("write");

        assert_eq!(
            read_batch_checkpoint(&path, &steps, &inputs).expect("matching checkpoint"),
            2
        );
        assert_eq!(
            read_batch_checkpoint(&path, &steps, &ObjectHash::of_bytes(b"inputs-b"))
                .expect("changed input starts clean"),
            0
        );
        let changed_steps = batch_steps_hash(
            &[BatchPipelineStep::Alignment {
                profile: AlignmentQualityProfile::Fast,
            }],
            &[],
        )
        .expect("changed steps");
        assert_eq!(
            read_batch_checkpoint(&path, &changed_steps, &inputs)
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
}
