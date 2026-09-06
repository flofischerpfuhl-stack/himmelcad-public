//! Offline GDAL process isolation for elevation rasters, orthomosaics and pyramids.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use fs2::FileExt;
use himmelcad_core::canonical_document::EntityVersionRef;
use himmelcad_core::canonical_resources::CanonicalResourceRef;
use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_jobs::{CancellationToken, PhotolabJobKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::process_group::{self, ProcessGroupDropGuard};
use tokio::task::JoinSet;

use crate::job_runtime::CheckpointSink;
use crate::viewer_raster_manifest::{
    publish_prepared_elevation_hierarchy, PreparedElevationHierarchyError,
    PreparedElevationHierarchyOptions,
};
use crate::viewer_raster_surface_manifest::{
    publish_prepared_raster_surface_hierarchy, PreparedRasterSurfaceHierarchyError,
};

const PYRAMID_TILE_SIZE: u32 = 512;
const PYRAMID_TILE_SIZE_U16: u16 = 512;
const CHECKPOINT_SCHEMA: u32 = 1;
const CAPTURE_LIMIT: usize = 32 * 1024 * 1024;
const MAX_SOURCES: usize = 1_000_000;

/// Explicit native tools and data roots shipped by a release or selected for development.
#[derive(Debug, Clone)]
pub struct GdalToolchainConfig {
    pub gdal_grid_path: PathBuf,
    pub gdal_rasterize_path: PathBuf,
    pub gdalwarp_path: PathBuf,
    pub gdalbuildvrt_path: PathBuf,
    pub gdal_translate_path: PathBuf,
    pub gdalinfo_path: PathBuf,
    pub ogrinfo_path: PathBuf,
    pub gdal_data_directory: PathBuf,
    pub proj_data_directory: PathBuf,
    pub allowed_input_roots: Vec<PathBuf>,
    pub staging_root: PathBuf,
    pub allowed_output_roots: Vec<PathBuf>,
    pub max_parallel_processes: usize,
    pub threads_per_process: usize,
}

/// Exact map reference attached to every input and output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterCrs {
    pub horizontal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vertical: Option<String>,
    pub gdal_srs: String,
    pub canonical_wkt_sha256: ObjectHash,
}

/// Axis-aligned projected bounds in target CRS units.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterBounds {
    pub minimum_east: f64,
    pub minimum_north: f64,
    pub maximum_east: f64,
    pub maximum_north: f64,
}

/// Exact level-zero grid. Width, height, bounds and GSD must agree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterGrid {
    pub bounds: RasterBounds,
    pub width_pixels: u32,
    pub height_pixels: u32,
    pub gsd: f64,
    pub no_data: RasterNoDataValue,
}

/// No-data representation retained through base raster, pyramid and COG.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum RasterNoDataValue {
    Numeric(f64),
    Nan,
    AlphaMask,
}

/// Elevation surface semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ElevationSurface {
    Dsm,
    Dtm,
}

/// Curated GDAL gridding algorithms with no free-form option string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ElevationInterpolation {
    Maximum { radius: f64, minimum_points: u16 },
    Minimum { radius: f64, minimum_points: u16 },
    Linear { radius: f64 },
    Nearest { radius: f64 },
}

/// Prepared geometry source. Only audited `FlatGeobuf` and `GeoPackage` drivers are accepted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ElevationGeometrySource {
    Points {
        path: String,
        layer: String,
        elevation_field: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        classification_field: Option<String>,
        #[serde(default)]
        accepted_classifications: Vec<u8>,
    },
    TriangleMesh {
        path: String,
        layer: String,
        terrain_only: bool,
    },
}

/// One prepared source tile aligned with one level-zero raster tile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationInputTile {
    pub tile_id: String,
    pub column: u32,
    pub row: u32,
    pub bounds: RasterBounds,
    pub crs: RasterCrs,
    pub source: ElevationGeometrySource,
}

/// Elevation raster request from prepared tiled point or triangle data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationRasterRequest {
    pub surface: ElevationSurface,
    pub interpolation: ElevationInterpolation,
    pub view_range: ElevationViewRange,
    pub tiles: Vec<ElevationInputTile>,
}

/// Stable range used only for the visual DEM preview; metric heights remain Float32.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationViewRange {
    pub minimum_elevation: f64,
    pub maximum_elevation: f64,
}

/// A camera-model VRT whose map coordinates were prepared by the photogrammetry core.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrthophotoSource {
    pub source_id: String,
    pub warp_vrt_path: String,
    pub bounds: RasterBounds,
    pub crs: RasterCrs,
}

/// GDAL's deterministic overlap order. Advanced seamline blending is an upstream product.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MosaicOrder {
    EarlierOnTop,
    LaterOnTop,
}

/// Orthorectification and deterministic mosaic request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrthomosaicRequest {
    pub sources: Vec<OrthophotoSource>,
    pub order: MosaicOrder,
    pub resampling: RasterResampling,
    pub elevation_support: Box<OrthomosaicElevationSupport>,
}

/// Exact DEM authority and prepared pyramid used to drape an orthomosaic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrthomosaicElevationSupport {
    pub dataset_root: String,
    pub summary: RasterBuildSummary,
    pub source_surface: EntityVersionRef,
    pub derivation: CanonicalResourceRef,
}

/// Resampling choices accepted by the curated worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RasterResampling {
    Nearest,
    Bilinear,
    Cubic,
    Average,
}

/// Product-specific work preceding pyramid and COG creation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RasterProductRequest {
    Elevation(ElevationRasterRequest),
    Orthomosaic(OrthomosaicRequest),
}

/// Immutable command identity plus all exact runtime inputs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterBuildCommand {
    pub job_id: String,
    pub config_hash: ObjectHash,
    pub input_hash: ObjectHash,
    pub output_directory: String,
    pub crs: RasterCrs,
    pub grid: RasterGrid,
    pub product: RasterProductRequest,
}

/// Runtime phase used by the shared job progress adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RasterPhase {
    Validating,
    Rasterizing,
    Orthorectifying,
    Mosaicking,
    BuildingPyramid,
    ExportingCog,
    ValidatingCog,
    Committing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RasterResumeCheckpointValidation {
    Compatible,
    Missing,
    ConfigHashMismatch,
    InputHashMismatch,
    Invalid,
}

/// Incremental progress; completed steps are durable checkpoint boundaries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterProgress {
    pub phase: RasterPhase,
    pub completed_steps: u64,
    pub total_steps: u64,
    pub current_step: String,
}

/// One internal 512-pixel pyramid level.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterLevelSummary {
    pub level: u16,
    pub columns: u32,
    pub rows: u32,
    pub tile_count: u64,
    pub bounds: RasterBounds,
    pub gsd: f64,
    pub relative_directory: String,
    pub metric_tile_url_template: String,
    pub view_layers: Vec<RasterViewLayer>,
}

/// Browser-consumable layer derived from, but never replacing, metric tiles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterViewLayer {
    pub name: String,
    pub format: RasterViewTileFormat,
    pub url_template: String,
}

/// Exact browser tile encoding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum RasterViewTileFormat {
    RgbaPng,
    GrayscalePng {
        #[serde(alias = "minimum_elevation")]
        minimum_elevation: f64,
        #[serde(alias = "maximum_elevation")]
        maximum_elevation: f64,
    },
    Float32Raw {
        #[serde(alias = "byte_order")]
        byte_order: RasterByteOrder,
        width: u16,
        height: u16,
    },
}

/// Byte order used by native GDAL's raw ENVI output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RasterByteOrder {
    LittleEndian,
    BigEndian,
}

/// Frozen GDAL evidence for a completed product.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GdalAudit {
    pub version: String,
    pub executable_sha256: BTreeMap<String, ObjectHash>,
    pub raster_drivers: Vec<String>,
    pub vector_drivers: Vec<String>,
    pub network_enabled: bool,
}

/// Published raster product paths and exact pyramid geometry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterBuildSummary {
    pub output_directory: String,
    pub cog_path: String,
    pub pyramid_manifest_path: String,
    pub levels: Vec<RasterLevelSummary>,
    pub crs: RasterCrs,
    pub grid: RasterGrid,
    pub audit: GdalAudit,
}

/// Immutable base-grid validity bitset published with a prepared elevation hierarchy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterValidityResource {
    /// Path relative to the raster dataset root.
    pub path: String,
    pub sha256: ObjectHash,
    pub byte_length: u64,
}

#[derive(Debug, Error)]
pub enum RasterRuntimeError {
    #[error("invalid raster request: {0}")]
    InvalidRequest(String),
    #[error("invalid GDAL toolchain path '{path}': {reason}")]
    InvalidToolchainPath { path: String, reason: String },
    #[error("path '{path}' is outside its configured roots")]
    PathOutsideRoots { path: String },
    #[error("unsupported GDAL driver '{driver}' for '{path}'")]
    UnsupportedDriver { driver: String, path: String },
    #[error("GDAL tools do not expose the required curated drivers")]
    MissingRequiredDrivers,
    #[error("GDAL executable versions differ or are unsupported: {0}")]
    UnsupportedVersion(String),
    #[error("GDAL process failed ({status}): {stderr}")]
    ProcessFailed { status: String, stderr: String },
    #[error("GDAL output exceeded the {CAPTURE_LIMIT}-byte capture limit")]
    OutputLimit,
    #[error("GDAL output is malformed: {0}")]
    MalformedOutput(String),
    #[error("raster operation was cancelled")]
    Cancelled,
    #[error("checkpoint belongs to a different raster command")]
    CheckpointMismatch,
    #[error("checkpoint output '{0}' was modified or removed")]
    CheckpointOutputChanged(String),
    #[error("job checkpoint sink rejected an update: {0}")]
    CheckpointSink(String),
    #[error("raster output already exists: {0}")]
    OutputExists(String),
    #[error("raster job is already active: {0}")]
    JobAlreadyActive(String),
    #[error("background task failed: {0}")]
    BackgroundTask(String),
    #[error(transparent)]
    ViewerHierarchy(#[from] PreparedElevationHierarchyError),
    #[error(transparent)]
    ViewerRasterSurface(#[from] PreparedRasterSurfaceHierarchyError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone)]
pub struct RasterRuntime {
    config: CanonicalToolchain,
}

#[derive(Debug, Clone)]
struct CanonicalToolchain {
    tools: ToolPaths,
    gdal_data_directory: PathBuf,
    proj_data_directory: PathBuf,
    input_roots: Vec<PathBuf>,
    staging_root: PathBuf,
    output_roots: Vec<PathBuf>,
    max_parallel_processes: usize,
    threads_per_process: usize,
}

#[derive(Debug, Clone)]
struct ToolPaths {
    grid: PathBuf,
    rasterize: PathBuf,
    warp: PathBuf,
    build_vrt: PathBuf,
    translate: PathBuf,
    info: PathBuf,
    vector_info: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RasterCheckpoint {
    schema_version: u32,
    command_hash: ObjectHash,
    config_hash: ObjectHash,
    input_hash: ObjectHash,
    #[serde(skip)]
    completed: BTreeMap<String, OutputEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompletedStep {
    step_id: String,
    evidence: OutputEvidence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvidence {
    relative_path: String,
    sha256: ObjectHash,
    bytes: u64,
}

#[derive(Debug)]
struct JobLock {
    file: File,
}

impl Drop for JobLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[derive(Debug, Clone)]
struct PreparedStep {
    id: String,
    phase: RasterPhase,
    tool: Tool,
    args: Vec<OsString>,
    output: PathBuf,
    relative_output: String,
}

#[derive(Debug, Clone, Copy)]
enum Tool {
    Grid,
    Rasterize,
    Warp,
    BuildVrt,
    Translate,
    Info,
    VectorInfo,
}

impl RasterRuntime {
    /// Canonicalizes every executable and allowed filesystem root.
    pub fn open(config: GdalToolchainConfig) -> Result<Self, RasterRuntimeError> {
        let tools = ToolPaths {
            grid: canonical_file(&config.gdal_grid_path)?,
            rasterize: canonical_file(&config.gdal_rasterize_path)?,
            warp: canonical_file(&config.gdalwarp_path)?,
            build_vrt: canonical_file(&config.gdalbuildvrt_path)?,
            translate: canonical_file(&config.gdal_translate_path)?,
            info: canonical_file(&config.gdalinfo_path)?,
            vector_info: canonical_file(&config.ogrinfo_path)?,
        };
        let gdal_data_directory = canonical_directory(&config.gdal_data_directory)?;
        let proj_data_directory = canonical_directory(&config.proj_data_directory)?;
        let input_roots = canonical_roots(config.allowed_input_roots)?;
        let staging_root = canonical_directory(&config.staging_root)?;
        let output_roots = canonical_roots(config.allowed_output_roots)?;
        if input_roots.is_empty() || output_roots.is_empty() {
            return Err(RasterRuntimeError::InvalidRequest(
                "input and output root allowlists cannot be empty".into(),
            ));
        }
        Ok(Self {
            config: CanonicalToolchain {
                tools,
                gdal_data_directory,
                proj_data_directory,
                input_roots,
                staging_root,
                output_roots,
                max_parallel_processes: config.max_parallel_processes.clamp(1, 32),
                threads_per_process: config.threads_per_process.clamp(1, 64),
            },
        })
    }

    /// Audits exact native binaries and hard-required built-in drivers offline.
    pub async fn audit(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<GdalAudit, RasterRuntimeError> {
        check_cancelled(cancellation)?;
        let mut version = None;
        let mut executable_sha256 = BTreeMap::new();
        for (name, tool) in [
            ("gdal_grid", Tool::Grid),
            ("gdal_rasterize", Tool::Rasterize),
            ("gdalwarp", Tool::Warp),
            ("gdalbuildvrt", Tool::BuildVrt),
            ("gdal_translate", Tool::Translate),
            ("gdalinfo", Tool::Info),
            ("ogrinfo", Tool::VectorInfo),
        ] {
            let captured = self
                .run_capture(tool, vec![OsString::from("--version")], cancellation)
                .await?;
            let reported = parse_version(&captured).ok_or_else(|| {
                RasterRuntimeError::UnsupportedVersion(format!("{name}: {captured}"))
            })?;
            if version
                .as_ref()
                .is_some_and(|expected| expected != &reported)
            {
                return Err(RasterRuntimeError::UnsupportedVersion(format!(
                    "{name} reported {reported}, expected {}",
                    version.as_deref().unwrap_or_default()
                )));
            }
            version.get_or_insert(reported);
            executable_sha256.insert(name.into(), hash_file_async(self.tool_path(tool)).await?);
        }
        let raster_text = self
            .run_capture(
                Tool::Translate,
                vec![OsString::from("--formats")],
                cancellation,
            )
            .await?;
        let vector_text = self
            .run_capture(
                Tool::VectorInfo,
                vec![OsString::from("--formats")],
                cancellation,
            )
            .await?;
        let raster_drivers =
            required_driver_evidence(&raster_text, &["GTiff", "COG", "VRT", "PNG", "ENVI"])?;
        let vector_drivers = required_driver_evidence(&vector_text, &["GPKG", "FlatGeobuf"])?;
        Ok(GdalAudit {
            version: version.unwrap_or_default(),
            executable_sha256,
            raster_drivers,
            vector_drivers,
            network_enabled: false,
        })
    }

    /// Validates the durable identity envelope before a history job is resubmitted.
    pub async fn validate_resume_checkpoint_identity(
        &self,
        kind: &str,
        config_hash: &ObjectHash,
        input_hash: &ObjectHash,
        legacy_job_id: &str,
    ) -> Result<RasterResumeCheckpointValidation, RasterRuntimeError> {
        let key = raster_checkpoint_content_key(kind, config_hash, input_hash)?;
        let current = self
            .config
            .staging_root
            .join("raster-checkpoints")
            .join(format!("{key}.json"));
        let legacy = self
            .config
            .staging_root
            .join("raster-checkpoints")
            .join(format!("{legacy_job_id}.json"));
        let path = if current.is_file() {
            current
        } else if legacy.is_file() {
            legacy
        } else {
            return Ok(RasterResumeCheckpointValidation::Missing);
        };
        let bytes = tokio::task::spawn_blocking({
            let path = path.clone();
            move || fs::read(path)
        })
        .await
        .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))??;
        let checkpoint: RasterCheckpoint = match serde_json::from_slice(&bytes) {
            Ok(checkpoint) => checkpoint,
            Err(_) => return Ok(RasterResumeCheckpointValidation::Invalid),
        };
        if checkpoint.config_hash != *config_hash {
            return Ok(RasterResumeCheckpointValidation::ConfigHashMismatch);
        }
        if checkpoint.input_hash != *input_hash {
            return Ok(RasterResumeCheckpointValidation::InputHashMismatch);
        }
        if checkpoint.schema_version != CHECKPOINT_SCHEMA
            || load_completed_steps(checkpoint_marker_directory(&path))
                .await?
                .is_empty()
        {
            return Ok(RasterResumeCheckpointValidation::Invalid);
        }
        Ok(RasterResumeCheckpointValidation::Compatible)
    }

    /// Executes a resumable raster product build and atomically publishes its directory.
    #[allow(clippy::too_many_lines)]
    pub async fn execute<P>(
        &self,
        command: &RasterBuildCommand,
        cancellation: &CancellationToken,
        checkpoint_sink: Option<&CheckpointSink>,
        mut progress: P,
    ) -> Result<RasterBuildSummary, RasterRuntimeError>
    where
        P: FnMut(RasterProgress),
    {
        check_cancelled(cancellation)?;
        validate_command(command)?;
        progress(RasterProgress {
            phase: RasterPhase::Validating,
            completed_steps: 0,
            total_steps: 1,
            current_step: "Validate GDAL and inputs".into(),
        });
        let output_directory = self.canonical_output_destination(&command.output_directory)?;
        if output_directory.exists() {
            return Err(RasterRuntimeError::OutputExists(path_string(
                &output_directory,
            )?));
        }
        let command_hash = command_hash(command)?;
        let checkpoint_key = raster_checkpoint_identity_key(command)?;
        let _job_lock = acquire_job_lock(
            self.config
                .staging_root
                .join("raster-locks")
                .join(format!("{checkpoint_key}.lock")),
            checkpoint_key.clone(),
        )
        .await?;
        let audit = self.audit(cancellation).await?;
        self.validate_inputs(command, cancellation).await?;
        let (job_directory, checkpoint_path) =
            raster_checkpoint_storage(&self.config.staging_root, command)?;
        create_job_directories(job_directory.clone(), checkpoint_path.clone()).await?;
        let mut checkpoint = load_checkpoint(
            checkpoint_path.clone(),
            command_hash,
            &command.config_hash,
            &command.input_hash,
            job_directory.clone(),
        )
        .await?;

        let source_steps = self.source_steps(command, &job_directory)?;
        self.execute_steps(
            source_steps,
            &job_directory,
            &checkpoint_path,
            &mut checkpoint,
            cancellation,
            checkpoint_sink,
            &mut progress,
        )
        .await?;

        let source_outputs = source_output_paths(command, &job_directory)?;
        let base_path = job_directory.join("base.tif");
        let mosaic_steps =
            Self::mosaic_steps(command, &job_directory, &source_outputs, &base_path)?;
        for step in mosaic_steps {
            self.execute_steps(
                vec![step],
                &job_directory,
                &checkpoint_path,
                &mut checkpoint,
                cancellation,
                checkpoint_sink,
                &mut progress,
            )
            .await?;
        }

        let (levels, pyramid_steps) = Self::pyramid_steps(command, &job_directory, &base_path)?;
        self.execute_steps(
            pyramid_steps,
            &job_directory,
            &checkpoint_path,
            &mut checkpoint,
            cancellation,
            checkpoint_sink,
            &mut progress,
        )
        .await?;
        let view_steps = Self::view_steps(command, &job_directory, &levels)?;
        self.execute_steps(
            view_steps,
            &job_directory,
            &checkpoint_path,
            &mut checkpoint,
            cancellation,
            checkpoint_sink,
            &mut progress,
        )
        .await?;
        let cog_path = job_directory.join("product.cog.tif");
        let cog_step = Self::cog_step(command, &base_path, &cog_path);
        self.execute_steps(
            vec![cog_step],
            &job_directory,
            &checkpoint_path,
            &mut checkpoint,
            cancellation,
            checkpoint_sink,
            &mut progress,
        )
        .await?;
        progress(RasterProgress {
            phase: RasterPhase::ValidatingCog,
            completed_steps: 0,
            total_steps: 1,
            current_step: "Validate COG structure and georeferencing".into(),
        });
        self.validate_cog(command, &cog_path, cancellation).await?;

        let pyramid_manifest_path = job_directory.join("pyramid/manifest.json");
        write_json_atomic_async(
            pyramid_manifest_path.clone(),
            &serde_json::json!({
                "schemaVersion": 1,
                "tileSizePixels": PYRAMID_TILE_SIZE,
                "crs": command.crs,
                "grid": command.grid,
                "levels": levels,
            }),
        )
        .await?;
        check_cancelled(cancellation)?;
        let summary = RasterBuildSummary {
            output_directory: path_string(&output_directory)?,
            cog_path: "product.cog.tif".into(),
            pyramid_manifest_path: "pyramid/manifest.json".into(),
            levels,
            crs: command.crs.clone(),
            grid: command.grid.clone(),
            audit,
        };
        if matches!(&command.product, RasterProductRequest::Elevation(_)) {
            let hierarchy_root = job_directory.clone();
            let hierarchy_summary = summary.clone();
            let hierarchy_cancellation = cancellation.clone();
            tokio::task::spawn_blocking(move || {
                publish_prepared_elevation_hierarchy(
                    &hierarchy_root,
                    &hierarchy_summary,
                    PreparedElevationHierarchyOptions {
                        maximum_height_jump: None,
                        diagonal:
                            himmelcad_core::entity_model::RasterCellDiagonal::TopLeftToBottomRight,
                    },
                    &hierarchy_cancellation,
                )
            })
            .await
            .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))??;
        } else if let RasterProductRequest::Orthomosaic(request) = &command.product {
            let hierarchy_root = job_directory.clone();
            let hierarchy_summary = summary.clone();
            let hierarchy_support = request.elevation_support.clone();
            let hierarchy_cancellation = cancellation.clone();
            tokio::task::spawn_blocking(move || {
                publish_prepared_raster_surface_hierarchy(
                    &hierarchy_root,
                    &hierarchy_summary,
                    &hierarchy_support,
                    &hierarchy_cancellation,
                )
            })
            .await
            .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))??;
        }
        progress(RasterProgress {
            phase: RasterPhase::Committing,
            completed_steps: 0,
            total_steps: 1,
            current_step: "Publish raster product atomically".into(),
        });
        cleanup_intermediates(job_directory.clone()).await?;
        publish_directory(job_directory.clone(), output_directory.clone()).await?;
        // Managed production jobs remove checkpoints only after the completed job record is
        // durable. This avoids a crash window where history claims a checkpoint already deleted.
        if checkpoint_sink.is_none() {
            remove_checkpoint(checkpoint_path).await?;
        }
        Ok(summary)
    }

    async fn validate_inputs(
        &self,
        command: &RasterBuildCommand,
        cancellation: &CancellationToken,
    ) -> Result<(), RasterRuntimeError> {
        match &command.product {
            RasterProductRequest::Elevation(request) => {
                for tile in &request.tiles {
                    let (path, layer) = match &tile.source {
                        ElevationGeometrySource::Points { path, layer, .. }
                        | ElevationGeometrySource::TriangleMesh { path, layer, .. } => {
                            (path, layer)
                        }
                    };
                    let canonical = self.canonical_input(path)?;
                    let output = self
                        .run_capture(
                            Tool::VectorInfo,
                            vec![
                                OsString::from("-json"),
                                OsString::from("-so"),
                                canonical.into_os_string(),
                                OsString::from(layer),
                            ],
                            cancellation,
                        )
                        .await?;
                    validate_vector_driver(&output, path, &command.crs.canonical_wkt_sha256)?;
                }
            }
            RasterProductRequest::Orthomosaic(request) => {
                self.canonical_input_directory(&request.elevation_support.dataset_root)?;
                for source in &request.sources {
                    let canonical = self.canonical_input(&source.warp_vrt_path)?;
                    let output = self
                        .run_capture(
                            Tool::Info,
                            vec![OsString::from("-json"), canonical.into_os_string()],
                            cancellation,
                        )
                        .await?;
                    validate_raster_driver(
                        &output,
                        &source.warp_vrt_path,
                        "VRT",
                        &command.crs.canonical_wkt_sha256,
                    )?;
                }
            }
        }
        Ok(())
    }

    fn source_steps(
        &self,
        command: &RasterBuildCommand,
        job_directory: &Path,
    ) -> Result<Vec<PreparedStep>, RasterRuntimeError> {
        match &command.product {
            RasterProductRequest::Elevation(request) => {
                let mut steps = Vec::with_capacity(request.tiles.len());
                for tile in &request.tiles {
                    let output = job_directory
                        .join("source-tiles")
                        .join(format!("{}.tif", tile.tile_id));
                    let (tool, args) = self.elevation_args(command, request, tile, &output)?;
                    steps.push(PreparedStep {
                        id: format!("elevation:{}", tile.tile_id),
                        phase: RasterPhase::Rasterizing,
                        tool,
                        args,
                        relative_output: relative_path(job_directory, &output)?,
                        output,
                    });
                }
                Ok(steps)
            }
            RasterProductRequest::Orthomosaic(request) => {
                let sources = ordered_sources(request);
                let mut steps = Vec::with_capacity(sources.len());
                for source in sources {
                    let output = job_directory
                        .join("ortho-sources")
                        .join(format!("{}.tif", source.source_id));
                    steps.push(PreparedStep {
                        id: format!("ortho:{}", source.source_id),
                        phase: RasterPhase::Orthorectifying,
                        tool: Tool::Warp,
                        args: self.orthophoto_args(command, source, &output)?,
                        relative_output: relative_path(job_directory, &output)?,
                        output,
                    });
                }
                Ok(steps)
            }
        }
    }

    fn elevation_args(
        &self,
        command: &RasterBuildCommand,
        request: &ElevationRasterRequest,
        tile: &ElevationInputTile,
        output: &Path,
    ) -> Result<(Tool, Vec<OsString>), RasterRuntimeError> {
        let source_path = match &tile.source {
            ElevationGeometrySource::Points { path, .. }
            | ElevationGeometrySource::TriangleMesh { path, .. } => self.canonical_input(path)?,
        };
        let mut args = Vec::new();
        match &tile.source {
            ElevationGeometrySource::Points {
                layer,
                elevation_field,
                classification_field,
                accepted_classifications,
                ..
            } => {
                args.extend([
                    "-of".into(),
                    "GTiff".into(),
                    "-ot".into(),
                    "Float32".into(),
                    "-txe".into(),
                    number(tile.bounds.minimum_east),
                    number(tile.bounds.maximum_east),
                    "-tye".into(),
                    number(tile.bounds.minimum_north),
                    number(tile.bounds.maximum_north),
                    "-outsize".into(),
                    PYRAMID_TILE_SIZE.to_string().into(),
                    PYRAMID_TILE_SIZE.to_string().into(),
                    "-a_srs".into(),
                    command.crs.gdal_srs.clone().into(),
                    "-a".into(),
                    // gdal_grid carries NoData in the algorithm definition;
                    // unlike gdal_rasterize/translate it has no -a_nodata
                    // command-line option.
                    interpolation_arg(&request.interpolation, command.grid.no_data).into(),
                    "-l".into(),
                    layer.into(),
                    "-zfield".into(),
                    elevation_field.into(),
                ]);
                if let Some(field) = classification_field {
                    if !accepted_classifications.is_empty() {
                        args.push("-where".into());
                        args.push(classification_filter(field, accepted_classifications).into());
                    }
                }
                args.push(source_path.into_os_string());
                args.push(output.as_os_str().to_owned());
                Ok((Tool::Grid, args))
            }
            ElevationGeometrySource::TriangleMesh { layer, .. } => {
                args.extend([
                    "-of".into(),
                    "GTiff".into(),
                    "-ot".into(),
                    "Float32".into(),
                    "-te".into(),
                    number(tile.bounds.minimum_east),
                    number(tile.bounds.minimum_north),
                    number(tile.bounds.maximum_east),
                    number(tile.bounds.maximum_north),
                    "-ts".into(),
                    PYRAMID_TILE_SIZE.to_string().into(),
                    PYRAMID_TILE_SIZE.to_string().into(),
                    "-a_srs".into(),
                    command.crs.gdal_srs.clone().into(),
                    "-a_nodata".into(),
                    no_data_arg(command.grid.no_data).into(),
                    "-3d".into(),
                    "-l".into(),
                    layer.into(),
                    source_path.into_os_string(),
                    output.as_os_str().to_owned(),
                ]);
                Ok((Tool::Rasterize, args))
            }
        }
    }

    fn orthophoto_args(
        &self,
        command: &RasterBuildCommand,
        source: &OrthophotoSource,
        output: &Path,
    ) -> Result<Vec<OsString>, RasterRuntimeError> {
        let input = self.canonical_input(&source.warp_vrt_path)?;
        Ok(vec![
            "-overwrite".into(),
            "-of".into(),
            "GTiff".into(),
            "-s_srs".into(),
            command.crs.gdal_srs.clone().into(),
            "-t_srs".into(),
            command.crs.gdal_srs.clone().into(),
            "-te".into(),
            number(source.bounds.minimum_east),
            number(source.bounds.minimum_north),
            number(source.bounds.maximum_east),
            number(source.bounds.maximum_north),
            "-tr".into(),
            number(command.grid.gsd),
            number(command.grid.gsd),
            "-tap".into(),
            "-r".into(),
            resampling_arg(match &command.product {
                RasterProductRequest::Orthomosaic(request) => request.resampling,
                RasterProductRequest::Elevation(_) => RasterResampling::Bilinear,
            })
            .into(),
            "-dstalpha".into(),
            "-co".into(),
            "TILED=YES".into(),
            "-co".into(),
            "BLOCKXSIZE=512".into(),
            "-co".into(),
            "BLOCKYSIZE=512".into(),
            input.into_os_string(),
            output.as_os_str().to_owned(),
        ])
    }

    fn mosaic_steps(
        command: &RasterBuildCommand,
        job_directory: &Path,
        sources: &[PathBuf],
        base_path: &Path,
    ) -> Result<Vec<PreparedStep>, RasterRuntimeError> {
        let list_path = job_directory.join("source-list.txt");
        write_path_list(&list_path, sources)?;
        let vrt_path = job_directory.join("mosaic.vrt");
        let mut build_args = vec![
            "-resolution".into(),
            "user".into(),
            "-tr".into(),
            number(command.grid.gsd),
            number(command.grid.gsd),
            "-te".into(),
            number(command.grid.bounds.minimum_east),
            number(command.grid.bounds.minimum_north),
            number(command.grid.bounds.maximum_east),
            number(command.grid.bounds.maximum_north),
        ];
        if matches!(command.grid.no_data, RasterNoDataValue::AlphaMask) {
            build_args.push("-addalpha".into());
        } else {
            build_args.extend([
                "-srcnodata".into(),
                no_data_arg(command.grid.no_data).into(),
                "-vrtnodata".into(),
                no_data_arg(command.grid.no_data).into(),
            ]);
        }
        build_args.extend([
            "-input_file_list".into(),
            list_path.as_os_str().to_owned(),
            vrt_path.as_os_str().to_owned(),
        ]);
        let build = PreparedStep {
            id: "mosaic:vrt".into(),
            phase: RasterPhase::Mosaicking,
            tool: Tool::BuildVrt,
            args: build_args,
            output: vrt_path.clone(),
            relative_output: relative_path(job_directory, &vrt_path)?,
        };
        let mut translate_args = vec![
            "-of".into(),
            "GTiff".into(),
            "-ot".into(),
            output_type(command).into(),
            "-a_srs".into(),
            command.crs.gdal_srs.clone().into(),
        ];
        if !matches!(command.grid.no_data, RasterNoDataValue::AlphaMask) {
            translate_args.extend(["-a_nodata".into(), no_data_arg(command.grid.no_data).into()]);
        }
        translate_args.extend([
            "-co".into(),
            "TILED=YES".into(),
            "-co".into(),
            "BLOCKXSIZE=512".into(),
            "-co".into(),
            "BLOCKYSIZE=512".into(),
            "-co".into(),
            "COMPRESS=ZSTD".into(),
            vrt_path.into_os_string(),
            base_path.as_os_str().to_owned(),
        ]);
        let translate = PreparedStep {
            id: "mosaic:base".into(),
            phase: RasterPhase::Mosaicking,
            tool: Tool::Translate,
            args: translate_args,
            output: base_path.to_path_buf(),
            relative_output: relative_path(job_directory, base_path)?,
        };
        Ok(vec![build, translate])
    }

    fn pyramid_steps(
        command: &RasterBuildCommand,
        job_directory: &Path,
        base_path: &Path,
    ) -> Result<(Vec<RasterLevelSummary>, Vec<PreparedStep>), RasterRuntimeError> {
        let mut levels = Vec::new();
        let mut steps = Vec::new();
        let mut level = 0_u16;
        loop {
            let scale = 1_u32.checked_shl(u32::from(level)).ok_or_else(|| {
                RasterRuntimeError::InvalidRequest("pyramid scale overflow".into())
            })?;
            let span = u64::from(PYRAMID_TILE_SIZE) * u64::from(scale);
            let columns = ceil_div(u64::from(command.grid.width_pixels), span);
            let rows = ceil_div(u64::from(command.grid.height_pixels), span);
            let columns = u32::try_from(columns).map_err(|_| {
                RasterRuntimeError::InvalidRequest("pyramid column count overflow".into())
            })?;
            let rows = u32::try_from(rows).map_err(|_| {
                RasterRuntimeError::InvalidRequest("pyramid row count overflow".into())
            })?;
            let resolution = command.grid.gsd * f64::from(scale);
            for row in 0..rows {
                for column in 0..columns {
                    let output = job_directory
                        .join("pyramid")
                        .join(format!("L{level:02}"))
                        .join(column.to_string())
                        .join(format!("{row}.tif"));
                    let bounds = pyramid_tile_bounds(command.grid.bounds, resolution, column, row);
                    steps.push(PreparedStep {
                        id: format!("pyramid:{level}:{column}:{row}"),
                        phase: RasterPhase::BuildingPyramid,
                        tool: Tool::Warp,
                        args: vec![
                            "-overwrite".into(),
                            "-of".into(),
                            "GTiff".into(),
                            "-te".into(),
                            number(bounds.minimum_east),
                            number(bounds.minimum_north),
                            number(bounds.maximum_east),
                            number(bounds.maximum_north),
                            "-ts".into(),
                            PYRAMID_TILE_SIZE.to_string().into(),
                            PYRAMID_TILE_SIZE.to_string().into(),
                            "-r".into(),
                            pyramid_resampling(command).into(),
                            "-dstnodata".into(),
                            no_data_arg(command.grid.no_data).into(),
                            "-co".into(),
                            "TILED=YES".into(),
                            "-co".into(),
                            "BLOCKXSIZE=512".into(),
                            "-co".into(),
                            "BLOCKYSIZE=512".into(),
                            "-co".into(),
                            "COMPRESS=ZSTD".into(),
                            base_path.as_os_str().to_owned(),
                            output.as_os_str().to_owned(),
                        ],
                        relative_output: relative_path(job_directory, &output)?,
                        output,
                    });
                }
            }
            levels.push(RasterLevelSummary {
                level,
                columns,
                rows,
                tile_count: u64::from(columns) * u64::from(rows),
                bounds: command.grid.bounds,
                gsd: resolution,
                relative_directory: format!("pyramid/L{level:02}"),
                metric_tile_url_template: format!("pyramid/L{level:02}/{{x}}/{{y}}.tif"),
                view_layers: view_layer_contract(command, level),
            });
            if columns == 1 && rows == 1 {
                break;
            }
            level = level.checked_add(1).ok_or_else(|| {
                RasterRuntimeError::InvalidRequest("pyramid has too many levels".into())
            })?;
        }
        Ok((levels, steps))
    }

    fn view_steps(
        command: &RasterBuildCommand,
        job_directory: &Path,
        levels: &[RasterLevelSummary],
    ) -> Result<Vec<PreparedStep>, RasterRuntimeError> {
        let mut steps = Vec::new();
        for level in levels {
            for row in 0..level.rows {
                for column in 0..level.columns {
                    let metric = job_directory
                        .join(&level.relative_directory)
                        .join(column.to_string())
                        .join(format!("{row}.tif"));
                    match &command.product {
                        RasterProductRequest::Orthomosaic(_) => {
                            let output = job_directory
                                .join("view/rgba")
                                .join(format!("L{:02}", level.level))
                                .join(column.to_string())
                                .join(format!("{row}.png"));
                            steps.push(PreparedStep {
                                id: format!("view:rgba:{}:{column}:{row}", level.level),
                                phase: RasterPhase::BuildingPyramid,
                                tool: Tool::Translate,
                                args: vec![
                                    "-of".into(),
                                    "PNG".into(),
                                    "-ot".into(),
                                    "Byte".into(),
                                    metric.as_os_str().to_owned(),
                                    output.as_os_str().to_owned(),
                                ],
                                relative_output: relative_path(job_directory, &output)?,
                                output,
                            });
                        }
                        RasterProductRequest::Elevation(request) => {
                            let raw = job_directory
                                .join("view/height")
                                .join(format!("L{:02}", level.level))
                                .join(column.to_string())
                                .join(format!("{row}.f32"));
                            steps.push(PreparedStep {
                                id: format!("view:height:{}:{column}:{row}", level.level),
                                phase: RasterPhase::BuildingPyramid,
                                tool: Tool::Translate,
                                args: vec![
                                    "-of".into(),
                                    "ENVI".into(),
                                    "-ot".into(),
                                    "Float32".into(),
                                    "-co".into(),
                                    "INTERLEAVE=BSQ".into(),
                                    metric.as_os_str().to_owned(),
                                    raw.as_os_str().to_owned(),
                                ],
                                relative_output: relative_path(job_directory, &raw)?,
                                output: raw,
                            });
                            let preview = job_directory
                                .join("view/preview")
                                .join(format!("L{:02}", level.level))
                                .join(column.to_string())
                                .join(format!("{row}.png"));
                            steps.push(PreparedStep {
                                id: format!("view:preview:{}:{column}:{row}", level.level),
                                phase: RasterPhase::BuildingPyramid,
                                tool: Tool::Translate,
                                args: vec![
                                    "-of".into(),
                                    "PNG".into(),
                                    "-ot".into(),
                                    "Byte".into(),
                                    "-scale".into(),
                                    number(request.view_range.minimum_elevation),
                                    number(request.view_range.maximum_elevation),
                                    "1".into(),
                                    "255".into(),
                                    "-a_nodata".into(),
                                    "0".into(),
                                    metric.as_os_str().to_owned(),
                                    preview.as_os_str().to_owned(),
                                ],
                                relative_output: relative_path(job_directory, &preview)?,
                                output: preview,
                            });
                        }
                    }
                }
            }
        }
        Ok(steps)
    }

    fn cog_step(command: &RasterBuildCommand, base_path: &Path, cog_path: &Path) -> PreparedStep {
        let mut args = vec![
            "-of".into(),
            "COG".into(),
            "-a_srs".into(),
            command.crs.gdal_srs.clone().into(),
        ];
        if !matches!(command.grid.no_data, RasterNoDataValue::AlphaMask) {
            args.extend(["-a_nodata".into(), no_data_arg(command.grid.no_data).into()]);
        }
        args.extend([
            "-co".into(),
            "BLOCKSIZE=512".into(),
            "-co".into(),
            "COMPRESS=ZSTD".into(),
            "-co".into(),
            "OVERVIEWS=AUTO".into(),
            "-co".into(),
            format!("OVERVIEW_RESAMPLING={}", pyramid_resampling(command)).into(),
            base_path.as_os_str().to_owned(),
            cog_path.as_os_str().to_owned(),
        ]);
        PreparedStep {
            id: "cog:export".into(),
            phase: RasterPhase::ExportingCog,
            tool: Tool::Translate,
            args,
            output: cog_path.to_path_buf(),
            relative_output: "product.cog.tif".into(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute_steps<P>(
        &self,
        steps: Vec<PreparedStep>,
        job_directory: &Path,
        checkpoint_path: &Path,
        checkpoint: &mut RasterCheckpoint,
        cancellation: &CancellationToken,
        checkpoint_sink: Option<&CheckpointSink>,
        progress: &mut P,
    ) -> Result<(), RasterRuntimeError>
    where
        P: FnMut(RasterProgress),
    {
        let mut pending = Vec::new();
        for step in steps {
            if checkpoint.completed.contains_key(&step.id) {
                continue;
            }
            pending.push(step);
        }
        let total = u64::try_from(pending.len()).unwrap_or(u64::MAX);
        let mut completed = 0_u64;
        let mut next = pending.into_iter();
        let mut running = JoinSet::new();
        loop {
            while running.len() < self.config.max_parallel_processes {
                let Some(step) = next.next() else {
                    break;
                };
                check_cancelled(cancellation)?;
                let runtime = self.clone();
                let token = cancellation.clone();
                let isolated_job_directory = job_directory.to_path_buf();
                running.spawn(async move {
                    runtime
                        .run_step(step, &token, &isolated_job_directory)
                        .await
                });
            }
            let Some(joined) = running.join_next().await else {
                break;
            };
            let (step, evidence) =
                joined.map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))??;
            completed = completed.saturating_add(1);
            let marker_hash = write_completed_step_async(
                checkpoint_path.to_path_buf(),
                step.id.clone(),
                evidence.clone(),
            )
            .await?;
            checkpoint.completed.insert(step.id.clone(), evidence);
            let checkpoint_progress = RasterProgress {
                phase: step.phase,
                completed_steps: completed,
                total_steps: total,
                current_step: step.id,
            };
            if let Some(sink) = checkpoint_sink.filter(|sink| {
                matches!(
                    sink.job_kind(),
                    PhotolabJobKind::BuildDem | PhotolabJobKind::BuildOrthomosaic
                )
            }) {
                let sequence = u64::try_from(checkpoint.completed.len()).unwrap_or(u64::MAX);
                sink.record_committed(
                    sequence,
                    raster_checkpoint_progress(&checkpoint_progress, sink.job_kind()),
                    format!("raster:{}:{sequence}", command_job_id(checkpoint_path)),
                    marker_hash,
                )
                .await
                .map_err(|error| RasterRuntimeError::CheckpointSink(error.to_string()))?;
            }
            progress(checkpoint_progress);
        }
        check_cancelled(cancellation)?;
        validate_checkpoint_outputs(checkpoint, job_directory.to_path_buf()).await
    }

    async fn run_step(
        &self,
        step: PreparedStep,
        cancellation: &CancellationToken,
        job_directory: &Path,
    ) -> Result<(PreparedStep, OutputEvidence), RasterRuntimeError> {
        if let Some(parent) = step.output.parent() {
            fs::create_dir_all(parent)?;
        }
        remove_partial_step_outputs(&step.output)?;
        let temporary = job_directory.join("tmp");
        fs::create_dir_all(&temporary)?;
        self.run_capture_in(step.tool, step.args.clone(), cancellation, &temporary)
            .await?;
        let evidence = output_evidence(step.output.clone(), step.relative_output.clone()).await?;
        Ok((step, evidence))
    }

    async fn validate_cog(
        &self,
        command: &RasterBuildCommand,
        cog_path: &Path,
        cancellation: &CancellationToken,
    ) -> Result<(), RasterRuntimeError> {
        let text = self
            .run_capture(
                Tool::Info,
                vec![OsString::from("-json"), cog_path.as_os_str().to_owned()],
                cancellation,
            )
            .await?;
        validate_cog_json(&text, command)
    }

    async fn run_capture(
        &self,
        tool: Tool,
        args: Vec<OsString>,
        cancellation: &CancellationToken,
    ) -> Result<String, RasterRuntimeError> {
        self.run_capture_in(tool, args, cancellation, &self.config.staging_root)
            .await
    }

    async fn run_capture_in(
        &self,
        tool: Tool,
        args: Vec<OsString>,
        cancellation: &CancellationToken,
        temporary_directory: &Path,
    ) -> Result<String, RasterRuntimeError> {
        check_cancelled(cancellation)?;
        let args = args
            .into_iter()
            .map(external_tool_argument)
            .collect::<Vec<_>>();
        let mut command = Command::new(self.tool_path(tool));
        command
            .args(args)
            .env_clear()
            .env(
                "GDAL_DATA",
                external_tool_path(&self.config.gdal_data_directory),
            )
            .env(
                "PROJ_DATA",
                external_tool_path(&self.config.proj_data_directory),
            )
            .env("PROJ_NETWORK", "OFF")
            .env("GDAL_DRIVER_PATH", "disable")
            .env("GDAL_PAM_ENABLED", "NO")
            .env(
                "GDAL_NUM_THREADS",
                self.config.threads_per_process.to_string(),
            )
            .env("CPL_TMPDIR", external_tool_path(temporary_directory))
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        process_group::configure(command.as_std_mut());
        let mut child = command.spawn()?;
        let _group_guard = ProcessGroupDropGuard::new(child.id());
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| RasterRuntimeError::MalformedOutput("stdout pipe missing".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| RasterRuntimeError::MalformedOutput("stderr pipe missing".into()))?;
        let stdout_task = tokio::spawn(read_limited(stdout));
        let stderr_task = tokio::spawn(read_limited(stderr));
        let status = loop {
            tokio::select! {
                status = child.wait() => break status?,
                () = tokio::time::sleep(Duration::from_millis(20)) => {
                    if cancellation.is_cancel_requested() {
                        if !process_group::kill_group(child.id()).unwrap_or(false) {
                            let _ = child.kill().await;
                        }
                        let _ = child.wait().await;
                        return Err(RasterRuntimeError::Cancelled);
                    }
                }
            }
        };
        let stdout = stdout_task
            .await
            .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))??;
        let stderr = stderr_task
            .await
            .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))??;
        if !status.success() {
            return Err(RasterRuntimeError::ProcessFailed {
                status: status.to_string(),
                stderr: String::from_utf8_lossy(&stderr).trim().into(),
            });
        }
        if stdout.len().saturating_add(stderr.len()) > CAPTURE_LIMIT {
            return Err(RasterRuntimeError::OutputLimit);
        }
        let selected = if stdout.is_empty() { stderr } else { stdout };
        String::from_utf8(selected)
            .map_err(|error| RasterRuntimeError::MalformedOutput(error.to_string()))
    }

    fn canonical_input(&self, path: &str) -> Result<PathBuf, RasterRuntimeError> {
        let canonical = canonical_file(Path::new(path))?;
        if self
            .config
            .input_roots
            .iter()
            .any(|root| canonical.starts_with(root))
        {
            Ok(canonical)
        } else {
            Err(RasterRuntimeError::PathOutsideRoots { path: path.into() })
        }
    }

    fn canonical_input_directory(&self, path: &str) -> Result<PathBuf, RasterRuntimeError> {
        let canonical = canonical_directory(Path::new(path))?;
        if self
            .config
            .input_roots
            .iter()
            .any(|root| canonical.starts_with(root))
        {
            Ok(canonical)
        } else {
            Err(RasterRuntimeError::PathOutsideRoots { path: path.into() })
        }
    }

    fn canonical_output_destination(&self, path: &str) -> Result<PathBuf, RasterRuntimeError> {
        let requested = Path::new(path);
        let parent = requested.parent().ok_or_else(|| {
            RasterRuntimeError::InvalidRequest("output directory has no parent".into())
        })?;
        let parent = canonical_directory(parent)?;
        if !self
            .config
            .output_roots
            .iter()
            .any(|root| parent.starts_with(root))
        {
            return Err(RasterRuntimeError::PathOutsideRoots { path: path.into() });
        }
        let name = requested.file_name().ok_or_else(|| {
            RasterRuntimeError::InvalidRequest("output directory has no name".into())
        })?;
        Ok(parent.join(name))
    }

    fn tool_path(&self, tool: Tool) -> PathBuf {
        match tool {
            Tool::Grid => self.config.tools.grid.clone(),
            Tool::Rasterize => self.config.tools.rasterize.clone(),
            Tool::Warp => self.config.tools.warp.clone(),
            Tool::BuildVrt => self.config.tools.build_vrt.clone(),
            Tool::Translate => self.config.tools.translate.clone(),
            Tool::Info => self.config.tools.info.clone(),
            Tool::VectorInfo => self.config.tools.vector_info.clone(),
        }
    }
}

fn raster_product_kind(product: &RasterProductRequest) -> &'static str {
    match product {
        RasterProductRequest::Elevation(_) => "buildDem",
        RasterProductRequest::Orthomosaic(_) => "buildOrthomosaic",
    }
}

/// Stable checkpoint key shared by identical raster submissions.
pub fn raster_checkpoint_content_key(
    kind: &str,
    config_hash: &ObjectHash,
    input_hash: &ObjectHash,
) -> Result<String, RasterRuntimeError> {
    if !matches!(kind, "buildDem" | "buildOrthomosaic") {
        return Err(RasterRuntimeError::InvalidRequest(
            "unsupported raster checkpoint kind".into(),
        ));
    }
    Ok(ObjectHash::of_bytes(&serde_json::to_vec(&(kind, config_hash, input_hash))?).0)
}

fn raster_checkpoint_identity_key(
    command: &RasterBuildCommand,
) -> Result<String, RasterRuntimeError> {
    raster_checkpoint_content_key(
        raster_product_kind(&command.product),
        &command.config_hash,
        &command.input_hash,
    )
}

fn raster_checkpoint_storage(
    staging_root: &Path,
    command: &RasterBuildCommand,
) -> Result<(PathBuf, PathBuf), RasterRuntimeError> {
    let key = raster_checkpoint_identity_key(command)?;
    let current_checkpoint = staging_root
        .join("raster-checkpoints")
        .join(format!("{key}.json"));
    let legacy_checkpoint = staging_root
        .join("raster-checkpoints")
        .join(format!("{}.json", command.job_id));
    if !current_checkpoint.is_file() && legacy_checkpoint.is_file() {
        return Ok((
            staging_root.join("raster-jobs").join(&command.job_id),
            legacy_checkpoint,
        ));
    }
    Ok((
        staging_root.join("raster-jobs").join(key),
        current_checkpoint,
    ))
}

fn remove_partial_step_outputs(output: &Path) -> Result<(), RasterRuntimeError> {
    let appended_aux = PathBuf::from(format!("{}.aux.xml", output.display()));
    let appended_header = PathBuf::from(format!("{}.hdr", output.display()));
    let replaced_header = output.with_extension("hdr");
    for path in [
        output.to_path_buf(),
        appended_aux,
        appended_header,
        replaced_header,
    ] {
        if path.is_file() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn validate_command(command: &RasterBuildCommand) -> Result<(), RasterRuntimeError> {
    validate_identifier(&command.job_id, "job id")?;
    validate_hash(&command.config_hash, "config hash")?;
    validate_hash(&command.input_hash, "input hash")?;
    validate_crs(&command.crs)?;
    validate_grid(&command.grid)?;
    match &command.product {
        RasterProductRequest::Elevation(request) => {
            if matches!(command.grid.no_data, RasterNoDataValue::AlphaMask) {
                return invalid("elevation rasters require numeric or NaN no-data");
            }
            if request.tiles.is_empty() || request.tiles.len() > MAX_SOURCES {
                return invalid("elevation needs 1..=1,000,000 prepared tiles");
            }
            if !request.view_range.minimum_elevation.is_finite()
                || !request.view_range.maximum_elevation.is_finite()
                || request.view_range.minimum_elevation >= request.view_range.maximum_elevation
            {
                return invalid("elevation view range must be finite and increasing");
            }
            let mut ids = BTreeSet::new();
            for tile in &request.tiles {
                validate_identifier(&tile.tile_id, "tile id")?;
                if !ids.insert(&tile.tile_id) {
                    return invalid("elevation tile ids must be unique");
                }
                require_same_crs(&tile.crs, &command.crs)?;
                validate_bounds(tile.bounds)?;
                validate_tile_alignment(tile, &command.grid)?;
                match &tile.source {
                    ElevationGeometrySource::Points {
                        layer,
                        elevation_field,
                        classification_field,
                        accepted_classifications,
                        ..
                    } => {
                        validate_field(layer, "layer")?;
                        validate_field(elevation_field, "elevation field")?;
                        if let Some(field) = classification_field {
                            validate_field(field, "classification field")?;
                        } else if !accepted_classifications.is_empty() {
                            return invalid("class filters need a classification field");
                        }
                        if request.surface == ElevationSurface::Dtm
                            && accepted_classifications.is_empty()
                            && !matches!(
                                request.interpolation,
                                ElevationInterpolation::Minimum { .. }
                            )
                        {
                            return invalid(
                                "DTM point inputs need explicit accepted ground classifications",
                            );
                        }
                    }
                    ElevationGeometrySource::TriangleMesh {
                        layer,
                        terrain_only,
                        ..
                    } => {
                        validate_field(layer, "mesh layer")?;
                        if request.surface == ElevationSurface::Dtm && !terrain_only {
                            return invalid("DTM mesh inputs must be explicitly terrain-only");
                        }
                    }
                }
            }
            match request.interpolation {
                ElevationInterpolation::Maximum { radius, .. }
                | ElevationInterpolation::Minimum { radius, .. }
                | ElevationInterpolation::Linear { radius }
                | ElevationInterpolation::Nearest { radius }
                    if !radius.is_finite() || radius <= 0.0 =>
                {
                    return invalid("interpolation radius must be positive and finite");
                }
                _ => {}
            }
        }
        RasterProductRequest::Orthomosaic(request) => {
            if request.sources.is_empty() || request.sources.len() > MAX_SOURCES {
                return invalid("orthomosaic needs 1..=1,000,000 prepared sources");
            }
            let mut ids = BTreeSet::new();
            for source in &request.sources {
                validate_identifier(&source.source_id, "orthophoto source id")?;
                if !ids.insert(&source.source_id) {
                    return invalid("orthophoto source ids must be unique");
                }
                validate_bounds(source.bounds)?;
                require_same_crs(&source.crs, &command.crs)?;
            }
            if !matches!(command.grid.no_data, RasterNoDataValue::AlphaMask) {
                return invalid("orthomosaics require an alpha-mask no-data contract");
            }
        }
    }
    Ok(())
}

fn validate_crs(crs: &RasterCrs) -> Result<(), RasterRuntimeError> {
    for (label, value) in [
        ("horizontal CRS", crs.horizontal.as_str()),
        ("GDAL SRS", crs.gdal_srs.as_str()),
    ] {
        if value.trim().is_empty() || value.len() > 65_536 || value.contains('\0') {
            return invalid(&format!("{label} is invalid"));
        }
    }
    if crs
        .vertical
        .as_ref()
        .is_some_and(|value| value.trim().is_empty() || value.contains('\0'))
    {
        return invalid("vertical CRS is invalid");
    }
    validate_hash(&crs.canonical_wkt_sha256, "canonical WKT hash")
}

fn validate_grid(grid: &RasterGrid) -> Result<(), RasterRuntimeError> {
    validate_bounds(grid.bounds)?;
    if grid.width_pixels == 0 || grid.height_pixels == 0 {
        return invalid("raster dimensions must be positive");
    }
    if !grid.gsd.is_finite() || grid.gsd <= 0.0 {
        return invalid("GSD must be positive and finite");
    }
    if let RasterNoDataValue::Numeric(value) = grid.no_data {
        if !value.is_finite() {
            return invalid("numeric no-data must be finite");
        }
    }
    let expected_width = f64::from(grid.width_pixels) * grid.gsd;
    let expected_height = f64::from(grid.height_pixels) * grid.gsd;
    let width = grid.bounds.maximum_east - grid.bounds.minimum_east;
    let height = grid.bounds.maximum_north - grid.bounds.minimum_north;
    let tolerance = grid.gsd.abs().max(1.0) * 1.0e-9;
    if (width - expected_width).abs() > tolerance || (height - expected_height).abs() > tolerance {
        return invalid("bounds, dimensions and GSD do not describe the same exact grid");
    }
    Ok(())
}

fn validate_bounds(bounds: RasterBounds) -> Result<(), RasterRuntimeError> {
    let values = [
        bounds.minimum_east,
        bounds.minimum_north,
        bounds.maximum_east,
        bounds.maximum_north,
    ];
    if values.iter().any(|value| !value.is_finite())
        || bounds.minimum_east >= bounds.maximum_east
        || bounds.minimum_north >= bounds.maximum_north
    {
        return invalid("raster bounds are invalid");
    }
    Ok(())
}

fn validate_tile_alignment(
    tile: &ElevationInputTile,
    grid: &RasterGrid,
) -> Result<(), RasterRuntimeError> {
    let columns = grid.width_pixels.div_ceil(PYRAMID_TILE_SIZE);
    let rows = grid.height_pixels.div_ceil(PYRAMID_TILE_SIZE);
    if tile.column >= columns || tile.row >= rows {
        return invalid("elevation input tile address is outside the target grid");
    }
    let expected = pyramid_tile_bounds(grid.bounds, grid.gsd, tile.column, tile.row);
    let tolerance = grid.gsd.abs().max(1.0) * 1.0e-9;
    if (tile.bounds.minimum_east - expected.minimum_east).abs() > tolerance
        || (tile.bounds.minimum_north - expected.minimum_north).abs() > tolerance
        || (tile.bounds.maximum_east - expected.maximum_east).abs() > tolerance
        || (tile.bounds.maximum_north - expected.maximum_north).abs() > tolerance
    {
        return invalid("elevation input tile is not aligned to the 512-pixel target grid");
    }
    Ok(())
}

fn require_same_crs(input: &RasterCrs, target: &RasterCrs) -> Result<(), RasterRuntimeError> {
    if input != target {
        return invalid("implicit horizontal or vertical CRS transformation is forbidden");
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), RasterRuntimeError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return invalid(&format!("{label} contains unsupported characters"));
    }
    Ok(())
}

fn validate_field(value: &str, label: &str) -> Result<(), RasterRuntimeError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return invalid(&format!("{label} is not a safe identifier"));
    }
    Ok(())
}

fn validate_hash(hash: &ObjectHash, label: &str) -> Result<(), RasterRuntimeError> {
    if hash.as_str().len() != 64 || !hash.as_str().bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return invalid(&format!("{label} is not a SHA-256 hash"));
    }
    Ok(())
}

fn invalid<T>(message: &str) -> Result<T, RasterRuntimeError> {
    Err(RasterRuntimeError::InvalidRequest(message.into()))
}

fn interpolation_arg(interpolation: &ElevationInterpolation, no_data: RasterNoDataValue) -> String {
    let no_data = no_data_arg(no_data);
    match interpolation {
        ElevationInterpolation::Maximum {
            radius,
            minimum_points,
        } => format!(
            "maximum:radius1={}:radius2={}:min_points={minimum_points}:nodata={no_data}",
            number_string(*radius),
            number_string(*radius)
        ),
        ElevationInterpolation::Minimum {
            radius,
            minimum_points,
        } => format!(
            "minimum:radius1={}:radius2={}:min_points={minimum_points}:nodata={no_data}",
            number_string(*radius),
            number_string(*radius)
        ),
        ElevationInterpolation::Linear { radius } => {
            format!("linear:radius={}:nodata={no_data}", number_string(*radius))
        }
        ElevationInterpolation::Nearest { radius } => format!(
            "nearest:radius1={}:radius2={}:nodata={no_data}",
            number_string(*radius),
            number_string(*radius)
        ),
    }
}

fn classification_filter(field: &str, classes: &[u8]) -> String {
    let values = classes
        .iter()
        .map(u8::to_string)
        .collect::<Vec<_>>()
        .join(",");
    format!("{field} IN ({values})")
}

fn ordered_sources(request: &OrthomosaicRequest) -> Vec<&OrthophotoSource> {
    let mut sources = request.sources.iter().collect::<Vec<_>>();
    sources.sort_by(|left, right| left.source_id.cmp(&right.source_id));
    if request.order == MosaicOrder::EarlierOnTop {
        sources.reverse();
    }
    sources
}

fn source_output_paths(
    command: &RasterBuildCommand,
    job_directory: &Path,
) -> Result<Vec<PathBuf>, RasterRuntimeError> {
    match &command.product {
        RasterProductRequest::Elevation(request) => request
            .tiles
            .iter()
            .map(|tile| {
                Ok(job_directory
                    .join("source-tiles")
                    .join(format!("{}.tif", tile.tile_id)))
            })
            .collect(),
        RasterProductRequest::Orthomosaic(request) => Ok(ordered_sources(request)
            .into_iter()
            .map(|source| {
                job_directory
                    .join("ortho-sources")
                    .join(format!("{}.tif", source.source_id))
            })
            .collect()),
    }
}

fn output_type(command: &RasterBuildCommand) -> &'static str {
    match command.product {
        RasterProductRequest::Elevation(_) => "Float32",
        RasterProductRequest::Orthomosaic(_) => "Byte",
    }
}

fn pyramid_resampling(command: &RasterBuildCommand) -> &'static str {
    match &command.product {
        RasterProductRequest::Elevation(_) => "average",
        RasterProductRequest::Orthomosaic(request) => resampling_arg(request.resampling),
    }
}

fn view_layer_contract(command: &RasterBuildCommand, level: u16) -> Vec<RasterViewLayer> {
    match &command.product {
        RasterProductRequest::Orthomosaic(_) => vec![RasterViewLayer {
            name: "rgba".into(),
            format: RasterViewTileFormat::RgbaPng,
            url_template: format!("view/rgba/L{level:02}/{{x}}/{{y}}.png"),
        }],
        RasterProductRequest::Elevation(request) => vec![
            RasterViewLayer {
                name: "height".into(),
                format: RasterViewTileFormat::Float32Raw {
                    byte_order: if cfg!(target_endian = "little") {
                        RasterByteOrder::LittleEndian
                    } else {
                        RasterByteOrder::BigEndian
                    },
                    width: PYRAMID_TILE_SIZE_U16,
                    height: PYRAMID_TILE_SIZE_U16,
                },
                url_template: format!("view/height/L{level:02}/{{x}}/{{y}}.f32"),
            },
            RasterViewLayer {
                name: "preview".into(),
                format: RasterViewTileFormat::GrayscalePng {
                    minimum_elevation: request.view_range.minimum_elevation,
                    maximum_elevation: request.view_range.maximum_elevation,
                },
                url_template: format!("view/preview/L{level:02}/{{x}}/{{y}}.png"),
            },
        ],
    }
}

const fn resampling_arg(resampling: RasterResampling) -> &'static str {
    match resampling {
        RasterResampling::Nearest => "near",
        RasterResampling::Bilinear => "bilinear",
        RasterResampling::Cubic => "cubic",
        RasterResampling::Average => "average",
    }
}

fn no_data_arg(no_data: RasterNoDataValue) -> String {
    match no_data {
        RasterNoDataValue::Numeric(value) => number_string(value),
        RasterNoDataValue::Nan => "nan".into(),
        RasterNoDataValue::AlphaMask => "0".into(),
    }
}

fn number(value: f64) -> OsString {
    number_string(value).into()
}

fn number_string(value: f64) -> String {
    format!("{value:.15}")
}

#[allow(clippy::cast_precision_loss)]
fn pyramid_tile_bounds(
    bounds: RasterBounds,
    resolution: f64,
    column: u32,
    row: u32,
) -> RasterBounds {
    let span = f64::from(PYRAMID_TILE_SIZE) * resolution;
    let minimum_east = bounds.minimum_east + f64::from(column) * span;
    let maximum_north = bounds.maximum_north - f64::from(row) * span;
    RasterBounds {
        minimum_east,
        minimum_north: maximum_north - span,
        maximum_east: minimum_east + span,
        maximum_north,
    }
}

const fn ceil_div(value: u64, divisor: u64) -> u64 {
    value.div_ceil(divisor)
}

fn validate_vector_driver(
    text: &str,
    path: &str,
    expected_wkt_hash: &ObjectHash,
) -> Result<(), RasterRuntimeError> {
    let value: Value = serde_json::from_str(text)?;
    let driver = value
        .get("driverShortName")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("driver")
                .and_then(|driver| driver.get("shortName"))
                .and_then(Value::as_str)
        })
        .ok_or_else(|| RasterRuntimeError::MalformedOutput("OGR driver missing".into()))?;
    if !matches!(driver, "GPKG" | "FlatGeobuf") {
        return Err(RasterRuntimeError::UnsupportedDriver {
            driver: driver.into(),
            path: path.into(),
        });
    }
    validate_input_wkt(
        &value,
        &[
            "/layers/0/geometryFields/0/coordinateSystem/wkt",
            "/layers/0/coordinateSystem/wkt",
            "/coordinateSystem/wkt",
        ],
        expected_wkt_hash,
    )?;
    Ok(())
}

fn validate_raster_driver(
    text: &str,
    path: &str,
    expected: &str,
    expected_wkt_hash: &ObjectHash,
) -> Result<(), RasterRuntimeError> {
    let value: Value = serde_json::from_str(text)?;
    let driver = value
        .get("driverShortName")
        .and_then(Value::as_str)
        .ok_or_else(|| RasterRuntimeError::MalformedOutput("raster driver missing".into()))?;
    if driver != expected {
        return Err(RasterRuntimeError::UnsupportedDriver {
            driver: driver.into(),
            path: path.into(),
        });
    }
    validate_input_wkt(&value, &["/coordinateSystem/wkt"], expected_wkt_hash)?;
    Ok(())
}

fn validate_input_wkt(
    value: &Value,
    pointers: &[&str],
    expected_wkt_hash: &ObjectHash,
) -> Result<(), RasterRuntimeError> {
    let wkt = pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .ok_or_else(|| RasterRuntimeError::MalformedOutput("input CRS WKT missing".into()))?;
    if ObjectHash::of_bytes(wkt.as_bytes()) != *expected_wkt_hash {
        return invalid("input CRS WKT differs from the frozen horizontal/vertical target");
    }
    Ok(())
}

fn validate_cog_json(text: &str, command: &RasterBuildCommand) -> Result<(), RasterRuntimeError> {
    let value: Value = serde_json::from_str(text)?;
    if value.get("driverShortName").and_then(Value::as_str) != Some("GTiff")
        || value
            .pointer("/metadata/IMAGE_STRUCTURE/LAYOUT")
            .and_then(Value::as_str)
            != Some("COG")
    {
        return Err(RasterRuntimeError::MalformedOutput(
            "output is not a validated COG GeoTIFF".into(),
        ));
    }
    let size = value
        .get("size")
        .and_then(Value::as_array)
        .ok_or_else(|| RasterRuntimeError::MalformedOutput("COG size missing".into()))?;
    if size.first().and_then(Value::as_u64) != Some(u64::from(command.grid.width_pixels))
        || size.get(1).and_then(Value::as_u64) != Some(u64::from(command.grid.height_pixels))
    {
        return Err(RasterRuntimeError::MalformedOutput(
            "COG dimensions differ from the exact grid".into(),
        ));
    }
    let transform = value
        .get("geoTransform")
        .and_then(Value::as_array)
        .ok_or_else(|| RasterRuntimeError::MalformedOutput("COG geotransform missing".into()))?;
    let expected = [
        command.grid.bounds.minimum_east,
        command.grid.gsd,
        0.0,
        command.grid.bounds.maximum_north,
        0.0,
        -command.grid.gsd,
    ];
    if transform.len() != expected.len()
        || transform.iter().zip(expected).any(|(actual, expected)| {
            actual
                .as_f64()
                .is_none_or(|actual| (actual - expected).abs() > command.grid.gsd * 1.0e-9)
        })
    {
        return Err(RasterRuntimeError::MalformedOutput(
            "COG geotransform differs from the exact grid".into(),
        ));
    }
    let wkt = value
        .pointer("/coordinateSystem/wkt")
        .and_then(Value::as_str)
        .ok_or_else(|| RasterRuntimeError::MalformedOutput("COG WKT missing".into()))?;
    if ObjectHash::of_bytes(wkt.as_bytes()) != command.crs.canonical_wkt_sha256 {
        return Err(RasterRuntimeError::MalformedOutput(
            "COG horizontal/vertical CRS WKT differs from the frozen target".into(),
        ));
    }
    let bands = value
        .get("bands")
        .and_then(Value::as_array)
        .ok_or_else(|| RasterRuntimeError::MalformedOutput("COG bands missing".into()))?;
    match command.grid.no_data {
        RasterNoDataValue::Numeric(expected) => {
            let actual = bands
                .first()
                .and_then(|band| band.get("noDataValue"))
                .and_then(Value::as_f64);
            if actual.is_none_or(|actual| {
                actual.to_bits() != expected.to_bits()
                    // GDAL's JSON formatter prints Float32 band NoData with
                    // limited decimal precision. Compare the representable
                    // Float32 value as well as exact Float64 sentinels.
                    && (actual as f32).to_bits() != (expected as f32).to_bits()
            }) {
                return Err(RasterRuntimeError::MalformedOutput(
                    "COG numeric no-data differs from request".into(),
                ));
            }
        }
        RasterNoDataValue::Nan => {
            let actual = bands.first().and_then(|band| band.get("noDataValue"));
            if !actual.is_some_and(|value| value.as_str() == Some("NaN") || value.is_null()) {
                return Err(RasterRuntimeError::MalformedOutput(
                    "COG NaN no-data differs from request".into(),
                ));
            }
        }
        RasterNoDataValue::AlphaMask => {
            if !bands.iter().any(|band| {
                band.get("colorInterpretation").and_then(Value::as_str) == Some("Alpha")
            }) {
                return Err(RasterRuntimeError::MalformedOutput(
                    "COG alpha no-data band is missing".into(),
                ));
            }
        }
    }
    Ok(())
}

fn parse_version(text: &str) -> Option<String> {
    let marker = text.find("GDAL ")? + 5;
    let version = text[marker..]
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .next()?;
    let mut parts = version.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    if major < 3 || (major == 3 && minor < 8) {
        return None;
    }
    Some(version.into())
}

fn required_driver_evidence(
    text: &str,
    required: &[&str],
) -> Result<Vec<String>, RasterRuntimeError> {
    if required.iter().any(|driver| !text.contains(driver)) {
        return Err(RasterRuntimeError::MissingRequiredDrivers);
    }
    Ok(required.iter().map(|driver| (*driver).into()).collect())
}

fn command_hash(command: &RasterBuildCommand) -> Result<ObjectHash, RasterRuntimeError> {
    Ok(ObjectHash::of_bytes(&serde_json::to_vec(&(
        raster_product_kind(&command.product),
        &command.config_hash,
        &command.input_hash,
    ))?))
}

async fn load_checkpoint(
    path: PathBuf,
    command_hash: ObjectHash,
    config_hash: &ObjectHash,
    input_hash: &ObjectHash,
    job_directory: PathBuf,
) -> Result<RasterCheckpoint, RasterRuntimeError> {
    let exists = path.is_file();
    let mut checkpoint = if exists {
        let read_path = path.clone();
        let bytes = tokio::task::spawn_blocking(move || fs::read(read_path))
            .await
            .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))??;
        serde_json::from_slice::<RasterCheckpoint>(&bytes)?
    } else {
        RasterCheckpoint {
            schema_version: CHECKPOINT_SCHEMA,
            command_hash: command_hash.clone(),
            config_hash: config_hash.clone(),
            input_hash: input_hash.clone(),
            completed: BTreeMap::new(),
        }
    };
    if checkpoint.schema_version != CHECKPOINT_SCHEMA
        || checkpoint.command_hash != command_hash
        || checkpoint.config_hash != *config_hash
        || checkpoint.input_hash != *input_hash
    {
        return Err(RasterRuntimeError::CheckpointMismatch);
    }
    if !exists {
        write_json_atomic_async(path.clone(), &checkpoint).await?;
    }
    checkpoint.completed = load_completed_steps(checkpoint_marker_directory(&path)).await?;
    validate_checkpoint_outputs(&checkpoint, job_directory).await?;
    Ok(checkpoint)
}

async fn load_completed_steps(
    directory: PathBuf,
) -> Result<BTreeMap<String, OutputEvidence>, RasterRuntimeError> {
    tokio::task::spawn_blocking(move || {
        let mut completed = BTreeMap::new();
        if !directory.is_dir() {
            return Ok(completed);
        }
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let marker: CompletedStep = serde_json::from_slice(&fs::read(path)?)?;
            if completed
                .insert(marker.step_id.clone(), marker.evidence)
                .is_some()
            {
                return Err(RasterRuntimeError::CheckpointMismatch);
            }
        }
        Ok(completed)
    })
    .await
    .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))?
}

async fn write_completed_step_async(
    checkpoint_path: PathBuf,
    step_id: String,
    evidence: OutputEvidence,
) -> Result<ObjectHash, RasterRuntimeError> {
    let directory = checkpoint_marker_directory(&checkpoint_path);
    let marker_hash = ObjectHash::of_bytes(step_id.as_bytes());
    let marker_path = directory.join(format!("{}.json", marker_hash.as_str()));
    let marker = CompletedStep { step_id, evidence };
    write_json_atomic_async(marker_path.clone(), &marker).await?;
    tokio::task::spawn_blocking(move || hash_file(&marker_path))
        .await
        .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))?
}

fn command_job_id(checkpoint_path: &Path) -> &str {
    checkpoint_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("raster")
}

fn raster_checkpoint_progress(
    progress: &RasterProgress,
    kind: PhotolabJobKind,
) -> himmelcad_core::photolab_jobs::JobProgress {
    use himmelcad_core::photolab_jobs::{
        JobProgress, PhotolabStage, PhotolabStageKind, ProgressMetrics,
    };

    let (index, stage_kind) = match progress.phase {
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
    let orthomosaic = kind == PhotolabJobKind::BuildOrthomosaic;

    JobProgress {
        stage: PhotolabStage {
            kind: stage_kind,
            index: index + u32::from(orthomosaic),
            stage_count: 7 + u32::from(orthomosaic),
            label: progress.current_step.clone(),
        },
        metrics: ProgressMetrics {
            completed_units: progress.completed_steps,
            total_units: Some(progress.total_steps.max(1)),
            completed_bytes: 0,
            total_bytes: None,
        },
    }
}

fn checkpoint_marker_directory(checkpoint_path: &Path) -> PathBuf {
    checkpoint_path.with_extension("steps")
}

async fn validate_checkpoint_outputs(
    checkpoint: &RasterCheckpoint,
    job_directory: PathBuf,
) -> Result<(), RasterRuntimeError> {
    for evidence in checkpoint.completed.values() {
        let path = job_directory.join(&evidence.relative_path);
        let observed = output_evidence(path, evidence.relative_path.clone()).await?;
        if observed.sha256 != evidence.sha256 || observed.bytes != evidence.bytes {
            return Err(RasterRuntimeError::CheckpointOutputChanged(
                evidence.relative_path.clone(),
            ));
        }
    }
    Ok(())
}

async fn output_evidence(
    path: PathBuf,
    relative_path: String,
) -> Result<OutputEvidence, RasterRuntimeError> {
    tokio::task::spawn_blocking(move || {
        let metadata = fs::metadata(&path)?;
        Ok(OutputEvidence {
            relative_path,
            sha256: hash_file(&path)?,
            bytes: metadata.len(),
        })
    })
    .await
    .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))?
}

async fn hash_file_async(path: PathBuf) -> Result<ObjectHash, RasterRuntimeError> {
    tokio::task::spawn_blocking(move || hash_file(&path))
        .await
        .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))?
}

fn hash_file(path: &Path) -> Result<ObjectHash, RasterRuntimeError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(ObjectHash(hex::encode(hasher.finalize())))
}

async fn write_json_atomic_async<T>(path: PathBuf, value: &T) -> Result<(), RasterRuntimeError>
where
    T: Serialize + Clone + Send + 'static,
{
    let value = value.clone();
    tokio::task::spawn_blocking(move || write_json_atomic(&path, &value))
        .await
        .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))?
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), RasterRuntimeError> {
    let parent = path.parent().ok_or_else(|| {
        RasterRuntimeError::InvalidRequest("checkpoint path has no parent".into())
    })?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("raster"),
        std::process::id()
    ));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)?;
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&temporary, path)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn write_path_list(path: &Path, sources: &[PathBuf]) -> Result<(), RasterRuntimeError> {
    let parent = path
        .parent()
        .ok_or_else(|| RasterRuntimeError::InvalidRequest("source list has no parent".into()))?;
    fs::create_dir_all(parent)?;
    let mut file = File::create(path)?;
    for source in sources {
        let text = source
            .to_str()
            .ok_or_else(|| RasterRuntimeError::InvalidToolchainPath {
                path: source.display().to_string(),
                reason: "GDAL source paths must be UTF-8".into(),
            })?;
        if text.contains(['\n', '\r']) {
            return invalid("source path contains a newline");
        }
        writeln!(file, "{text}")?;
    }
    file.sync_all()?;
    Ok(())
}

async fn acquire_job_lock(path: PathBuf, job_id: String) -> Result<JobLock, RasterRuntimeError> {
    tokio::task::spawn_blocking(move || {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(RasterRuntimeError::Io)?;
        file.try_lock_exclusive()
            .map_err(|_| RasterRuntimeError::JobAlreadyActive(job_id))?;
        file.set_len(0)?;
        writeln!(file, "pid={}", std::process::id())?;
        file.sync_all()?;
        Ok(JobLock { file })
    })
    .await
    .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))?
}

async fn create_job_directories(
    job_directory: PathBuf,
    checkpoint_path: PathBuf,
) -> Result<(), RasterRuntimeError> {
    tokio::task::spawn_blocking(move || {
        if !checkpoint_path.exists() && job_directory.exists() {
            fs::remove_dir_all(&job_directory)?;
            let markers = checkpoint_marker_directory(&checkpoint_path);
            if markers.exists() {
                fs::remove_dir_all(markers)?;
            }
        }
        fs::create_dir_all(&job_directory)?;
        if let Some(parent) = checkpoint_path.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(())
    })
    .await
    .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))?
}

async fn cleanup_intermediates(job_directory: PathBuf) -> Result<(), RasterRuntimeError> {
    tokio::task::spawn_blocking(move || {
        for name in [
            "source-tiles",
            "ortho-sources",
            "source-list.txt",
            "mosaic.vrt",
            "tmp",
        ] {
            let path = job_directory.join(name);
            if path.is_dir() {
                fs::remove_dir_all(path)?;
            } else if path.exists() {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))?
}

async fn publish_directory(
    source: PathBuf,
    destination: PathBuf,
) -> Result<(), RasterRuntimeError> {
    tokio::task::spawn_blocking(move || {
        if destination.exists() {
            return Err(RasterRuntimeError::OutputExists(path_string(&destination)?));
        }
        fs::rename(&source, &destination)?;
        #[cfg(unix)]
        if let Some(parent) = destination.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    })
    .await
    .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))?
}

async fn remove_checkpoint(path: PathBuf) -> Result<(), RasterRuntimeError> {
    tokio::task::spawn_blocking(move || {
        if path.exists() {
            fs::remove_file(&path)?;
        }
        let markers = checkpoint_marker_directory(&path);
        if markers.exists() {
            fs::remove_dir_all(markers)?;
        }
        Ok(())
    })
    .await
    .map_err(|error| RasterRuntimeError::BackgroundTask(error.to_string()))?
}

async fn read_limited<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
) -> Result<Vec<u8>, RasterRuntimeError> {
    let mut output = Vec::new();
    reader
        .take(u64::try_from(CAPTURE_LIMIT + 1).unwrap_or(u64::MAX))
        .read_to_end(&mut output)
        .await?;
    if output.len() > CAPTURE_LIMIT {
        return Err(RasterRuntimeError::OutputLimit);
    }
    Ok(output)
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), RasterRuntimeError> {
    if cancellation.is_cancel_requested() {
        Err(RasterRuntimeError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn external_tool_argument(value: OsString) -> OsString {
    let text = value.to_string_lossy();
    if let Some(suffix) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{suffix}").into()
    } else if let Some(suffix) = text.strip_prefix(r"\\?\") {
        suffix.into()
    } else {
        value
    }
}

#[cfg(not(windows))]
fn external_tool_argument(value: OsString) -> OsString {
    value
}

fn external_tool_path(path: &Path) -> OsString {
    external_tool_argument(path.as_os_str().to_owned())
}

fn canonical_file(path: &Path) -> Result<PathBuf, RasterRuntimeError> {
    let canonical =
        fs::canonicalize(path).map_err(|error| RasterRuntimeError::InvalidToolchainPath {
            path: path.display().to_string(),
            reason: error.to_string(),
        })?;
    if !canonical.is_file() {
        return Err(RasterRuntimeError::InvalidToolchainPath {
            path: canonical.display().to_string(),
            reason: "expected a regular file".into(),
        });
    }
    Ok(canonical)
}

fn canonical_directory(path: &Path) -> Result<PathBuf, RasterRuntimeError> {
    let canonical =
        fs::canonicalize(path).map_err(|error| RasterRuntimeError::InvalidToolchainPath {
            path: path.display().to_string(),
            reason: error.to_string(),
        })?;
    if !canonical.is_dir() {
        return Err(RasterRuntimeError::InvalidToolchainPath {
            path: canonical.display().to_string(),
            reason: "expected a directory".into(),
        });
    }
    Ok(canonical)
}

fn canonical_roots(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>, RasterRuntimeError> {
    let mut roots = Vec::new();
    for path in paths {
        let canonical = canonical_directory(&path)?;
        if !roots.contains(&canonical) {
            roots.push(canonical);
        }
    }
    Ok(roots)
}

fn relative_path(root: &Path, path: &Path) -> Result<String, RasterRuntimeError> {
    let relative = path.strip_prefix(root).map_err(|_| {
        RasterRuntimeError::InvalidRequest("step output escapes job directory".into())
    })?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return invalid("step output path is not normalized");
        };
        parts.push(component.to_str().ok_or_else(|| {
            RasterRuntimeError::InvalidRequest("step output path must be UTF-8".into())
        })?);
    }
    Ok(parts.join("/"))
}

fn path_string(path: &Path) -> Result<String, RasterRuntimeError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| RasterRuntimeError::InvalidRequest("path must be UTF-8".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn gdal_process_arguments_strip_windows_verbatim_prefixes() {
        assert_eq!(
            external_tool_argument(OsString::from(r"\\?\C:\project\dense.fgb")),
            OsString::from(r"C:\project\dense.fgb")
        );
        assert_eq!(
            external_tool_argument(OsString::from(r"\\?\UNC\server\share\dense.fgb")),
            OsString::from(r"\\server\share\dense.fgb")
        );
        assert_eq!(
            external_tool_argument(OsString::from("EPSG:31468")),
            OsString::from("EPSG:31468")
        );
    }

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;
    #[cfg(unix)]
    use std::sync::atomic::{AtomicU64, Ordering};

    #[cfg(unix)]
    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn hash(value: &str) -> ObjectHash {
        ObjectHash::of_bytes(value.as_bytes())
    }

    fn crs() -> RasterCrs {
        RasterCrs {
            horizontal: "EPSG:25832".into(),
            vertical: Some("EPSG:7837".into()),
            gdal_srs: "EPSG:25832+7837".into(),
            canonical_wkt_sha256: hash("target-wkt"),
        }
    }

    fn grid() -> RasterGrid {
        RasterGrid {
            bounds: RasterBounds {
                minimum_east: 500_000.0,
                minimum_north: 5_399_488.0,
                maximum_east: 500_512.0,
                maximum_north: 5_400_000.0,
            },
            width_pixels: 512,
            height_pixels: 512,
            gsd: 1.0,
            no_data: RasterNoDataValue::Numeric(-9999.0),
        }
    }

    fn elevation_command(path: &Path, output: &Path) -> RasterBuildCommand {
        RasterBuildCommand {
            job_id: "raster-test".into(),
            config_hash: hash("config"),
            input_hash: hash("input"),
            output_directory: output.to_string_lossy().into_owned(),
            crs: crs(),
            grid: grid(),
            product: RasterProductRequest::Elevation(ElevationRasterRequest {
                surface: ElevationSurface::Dsm,
                interpolation: ElevationInterpolation::Maximum {
                    radius: 1.5,
                    minimum_points: 1,
                },
                view_range: ElevationViewRange {
                    minimum_elevation: 400.0,
                    maximum_elevation: 600.0,
                },
                tiles: vec![ElevationInputTile {
                    tile_id: "tile-0-0".into(),
                    column: 0,
                    row: 0,
                    bounds: grid().bounds,
                    crs: crs(),
                    source: ElevationGeometrySource::Points {
                        path: path.to_string_lossy().into_owned(),
                        layer: "points".into(),
                        elevation_field: "elevation".into(),
                        classification_field: Some("classification".into()),
                        accepted_classifications: vec![2],
                    },
                }],
            }),
        }
    }

    #[test]
    fn reads_legacy_snake_case_view_tile_fields() {
        let raw: RasterViewTileFormat = serde_json::from_str(
            r#"{"kind":"float32Raw","byte_order":"littleEndian","width":512,"height":512}"#,
        )
        .expect("legacy raw view format");
        assert_eq!(
            raw,
            RasterViewTileFormat::Float32Raw {
                byte_order: RasterByteOrder::LittleEndian,
                width: 512,
                height: 512,
            }
        );

        let preview: RasterViewTileFormat = serde_json::from_str(
            r#"{"kind":"grayscalePng","minimum_elevation":687.0,"maximum_elevation":723.0}"#,
        )
        .expect("legacy preview view format");
        assert_eq!(
            preview,
            RasterViewTileFormat::GrayscalePng {
                minimum_elevation: 687.0,
                maximum_elevation: 723.0,
            }
        );
    }

    #[test]
    fn rejects_free_form_identifiers_before_they_reach_gdal() {
        let mut command = elevation_command(Path::new("/tmp/input.fgb"), Path::new("/tmp/out"));
        let RasterProductRequest::Elevation(request) = &mut command.product else {
            unreachable!();
        };
        let ElevationGeometrySource::Points {
            elevation_field, ..
        } = &mut request.tiles[0].source
        else {
            unreachable!();
        };
        *elevation_field = "z; touch /tmp/owned".into();
        assert!(matches!(
            validate_command(&command),
            Err(RasterRuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn rejects_any_implicit_vertical_or_horizontal_crs_change() {
        let mut command = elevation_command(Path::new("/tmp/input.fgb"), Path::new("/tmp/out"));
        let RasterProductRequest::Elevation(request) = &mut command.product else {
            unreachable!();
        };
        request.tiles[0].crs.vertical = None;
        assert!(matches!(
            validate_command(&command),
            Err(RasterRuntimeError::InvalidRequest(message)) if message.contains("implicit")
        ));
    }

    #[test]
    fn exact_grid_rejects_rounding_drift() {
        let mut command = elevation_command(Path::new("/tmp/input.fgb"), Path::new("/tmp/out"));
        command.grid.bounds.maximum_east += 0.01;
        assert!(matches!(
            validate_command(&command),
            Err(RasterRuntimeError::InvalidRequest(message)) if message.contains("exact grid")
        ));
    }

    #[test]
    fn cog_validation_checks_layout_grid_wkt_and_nodata() {
        let command = elevation_command(Path::new("/tmp/input.fgb"), Path::new("/tmp/out"));
        let text = serde_json::json!({
            "driverShortName": "GTiff",
            "size": [512, 512],
            "coordinateSystem": { "wkt": "target-wkt" },
            "geoTransform": [500000.0, 1.0, 0.0, 5400000.0, 0.0, -1.0],
            "metadata": { "IMAGE_STRUCTURE": { "LAYOUT": "COG" } },
            "bands": [{ "noDataValue": -9999.0 }]
        })
        .to_string();
        validate_cog_json(&text, &command).expect("exact COG evidence must pass");
        let bad = text.replace("\"COG\"", "\"IFD_BEFORE_DATA\"");
        assert!(validate_cog_json(&bad, &command).is_err());
    }

    #[test]
    fn pyramid_is_fixed_to_512_pixel_quadtree_tiles() {
        let bounds = grid().bounds;
        let first = pyramid_tile_bounds(bounds, 1.0, 0, 0);
        assert_eq!(first, bounds);
        let coarse = pyramid_tile_bounds(bounds, 2.0, 0, 0);
        assert_eq!(coarse.maximum_east - coarse.minimum_east, 1024.0);
        assert_eq!(ceil_div(1025, 512), 3);
    }

    #[test]
    fn cancelled_operation_stops_before_toolchain_access() {
        let token = CancellationToken::new();
        token.request_cancel();
        assert!(matches!(
            check_cancelled(&token),
            Err(RasterRuntimeError::Cancelled)
        ));
    }

    #[test]
    fn raster_checkpoint_lookup_uses_content_identity_across_operation_ids() {
        let root = std::env::temp_dir().join(format!(
            "himmelcad-raster-content-key-{}",
            std::process::id()
        ));
        let checkpoints = root.join("raster-checkpoints");
        fs::create_dir_all(&checkpoints).expect("checkpoint directory");
        let first = elevation_command(Path::new("/tmp/input.fgb"), Path::new("/tmp/output-a"));
        let key = raster_checkpoint_identity_key(&first).expect("content key");
        fs::write(checkpoints.join(format!("{key}.json")), b"{}").expect("checkpoint marker");
        let mut resubmitted = first.clone();
        resubmitted.job_id = "fresh-operation-id".into();
        resubmitted.output_directory = "/tmp/output-b".into();
        let (first_jobs, first_checkpoint) =
            raster_checkpoint_storage(&root, &first).expect("first lookup");
        let (resumed_jobs, resumed_checkpoint) =
            raster_checkpoint_storage(&root, &resubmitted).expect("resubmitted lookup");
        assert_eq!(first_checkpoint, resumed_checkpoint);
        assert_eq!(first_jobs, resumed_jobs);
        assert!(first_checkpoint.ends_with(format!("{key}.json")));
        fs::remove_dir_all(root).expect("test cleanup");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_gdal_executes_offline_pipeline_and_publishes_quadtree() {
        let root = test_root("fake-gdal");
        let tools = root.join("tools");
        let input = root.join("input");
        let staging = root.join("staging");
        let output_root = root.join("output");
        let data = root.join("gdal-data");
        let proj = root.join("proj-data");
        for directory in [&tools, &input, &staging, &output_root, &data, &proj] {
            fs::create_dir_all(directory).expect("test directory");
        }
        let log = root.join("gdal.log");
        let tool_paths = install_fake_tools(&tools, &log, false);
        let points = input.join("points.fgb");
        fs::write(&points, b"fake FlatGeobuf").expect("fake input");
        let runtime = RasterRuntime::open(GdalToolchainConfig {
            gdal_grid_path: tool_paths[0].clone(),
            gdal_rasterize_path: tool_paths[1].clone(),
            gdalwarp_path: tool_paths[2].clone(),
            gdalbuildvrt_path: tool_paths[3].clone(),
            gdal_translate_path: tool_paths[4].clone(),
            gdalinfo_path: tool_paths[5].clone(),
            ogrinfo_path: tool_paths[6].clone(),
            gdal_data_directory: data,
            proj_data_directory: proj,
            allowed_input_roots: vec![input],
            staging_root: staging.clone(),
            allowed_output_roots: vec![output_root.clone()],
            max_parallel_processes: 4,
            threads_per_process: 2,
        })
        .expect("fake runtime");
        let destination = output_root.join("published");
        let command = elevation_command(&points, &destination);
        let mut updates = Vec::new();
        let result = runtime
            .execute(&command, &CancellationToken::new(), None, |update| {
                updates.push(update);
            })
            .await
            .expect("offline raster pipeline");

        assert_eq!(result.output_directory, path_string(&destination).unwrap());
        assert!(destination.join("product.cog.tif").is_file());
        assert!(destination.join("pyramid/L00/0/0.tif").is_file());
        assert!(destination.join("view/height/L00/0/0.f32").is_file());
        assert!(destination.join("view/preview/L00/0/0.png").is_file());
        assert!(destination.join("pyramid/manifest.json").is_file());
        assert!(destination.join("viewer/manifest.json").is_file());
        assert!(!staging.join("raster-checkpoints/raster-test.json").exists());
        assert!(updates
            .iter()
            .any(|update| update.phase == RasterPhase::BuildingPyramid));
        let log = fs::read_to_string(log).expect("fake GDAL log");
        assert!(log.contains("gdal_grid|OFF|disable|"));
        assert!(log.contains("gdalbuildvrt|OFF|disable|"));
        assert!(log.contains("gdal_translate|OFF|disable|"));
        assert!(log.contains("gdalwarp|OFF|disable|"));
        fs::remove_dir_all(root).expect("test cleanup");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn per_tile_marker_resumes_linearly_and_detects_tampering() {
        let root = test_root("checkpoint-marker");
        let job = root.join("job");
        let checkpoint_path = root.join("checkpoint.json");
        fs::create_dir_all(&job).expect("job directory");
        let tile = job.join("pyramid/L00/0/0.tif");
        fs::create_dir_all(tile.parent().unwrap()).expect("tile parent");
        fs::write(&tile, b"committed tile").expect("tile payload");
        let command_hash = hash("command");
        let config_hash = hash("config");
        let input_hash = hash("input");
        let initial = load_checkpoint(
            checkpoint_path.clone(),
            command_hash.clone(),
            &config_hash,
            &input_hash,
            job.clone(),
        )
        .await
        .expect("checkpoint header");
        assert!(initial.completed.is_empty());
        let evidence = output_evidence(tile.clone(), "pyramid/L00/0/0.tif".into())
            .await
            .expect("tile evidence");
        write_completed_step_async(checkpoint_path.clone(), "pyramid:0:0:0".into(), evidence)
            .await
            .expect("atomic tile marker");
        let resumed = load_checkpoint(
            checkpoint_path.clone(),
            command_hash.clone(),
            &config_hash,
            &input_hash,
            job.clone(),
        )
        .await
        .expect("checkpoint resume");
        assert!(resumed.completed.contains_key("pyramid:0:0:0"));
        fs::write(tile, b"tampered tile").expect("tamper tile");
        assert!(matches!(
            load_checkpoint(
                checkpoint_path,
                command_hash,
                &config_hash,
                &input_hash,
                job,
            )
            .await,
            Err(RasterRuntimeError::CheckpointOutputChanged(_))
        ));
        fs::remove_dir_all(root).expect("test cleanup");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn running_gdal_process_is_killed_at_the_next_fast_cancel_poll() {
        let root = test_root("cancel-process");
        let tools = root.join("tools");
        let input = root.join("input");
        let staging = root.join("staging");
        let output = root.join("output");
        let data = root.join("gdal-data");
        let proj = root.join("proj-data");
        for directory in [&tools, &input, &staging, &output, &data, &proj] {
            fs::create_dir_all(directory).expect("test directory");
        }
        let paths = install_fake_tools(&tools, &root.join("gdal.log"), true);
        let runtime = RasterRuntime::open(GdalToolchainConfig {
            gdal_grid_path: paths[0].clone(),
            gdal_rasterize_path: paths[1].clone(),
            gdalwarp_path: paths[2].clone(),
            gdalbuildvrt_path: paths[3].clone(),
            gdal_translate_path: paths[4].clone(),
            gdalinfo_path: paths[5].clone(),
            ogrinfo_path: paths[6].clone(),
            gdal_data_directory: data,
            proj_data_directory: proj,
            allowed_input_roots: vec![input],
            staging_root: staging,
            allowed_output_roots: vec![output.clone()],
            max_parallel_processes: 1,
            threads_per_process: 1,
        })
        .expect("fake runtime");
        let token = CancellationToken::new();
        let worker_token = token.clone();
        let target = output.join("partial.tif");
        let task = tokio::spawn(async move {
            runtime
                .run_capture(
                    Tool::Grid,
                    vec!["ignored-input".into(), target.into_os_string()],
                    &worker_token,
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(80)).await;
        token.request_cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("cancellation must not wait for GDAL")
            .expect("worker join");
        assert!(matches!(result, Err(RasterRuntimeError::Cancelled)));
        fs::remove_dir_all(root).expect("test cleanup");
    }

    #[cfg(unix)]
    fn test_root(label: &str) -> PathBuf {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "himmelcad-raster-{label}-{}-{sequence}",
            std::process::id()
        ))
    }

    #[cfg(unix)]
    fn install_fake_tools(directory: &Path, log: &Path, slow: bool) -> Vec<PathBuf> {
        let delay = if slow { "exec /bin/sleep 5" } else { ":" };
        let script = format!(
            r#"#!/bin/sh
name=${{0##*/}}
if [ "$1" = "--version" ]; then
  printf '%s\n' 'GDAL 3.8.4, released 2024/02/08'
  exit 0
fi
if [ "$1" = "--formats" ]; then
  printf '%s\n' 'GTiff COG VRT PNG ENVI GPKG FlatGeobuf'
  exit 0
fi
if [ "$name" = "ogrinfo" ]; then
  printf '%s\n' '{{"driverShortName":"FlatGeobuf","layers":[{{"geometryFields":[{{"coordinateSystem":{{"wkt":"target-wkt"}}}}]}}]}}'
  exit 0
fi
last=
for argument in "$@"; do last=$argument; done
if [ "$name" = "gdalinfo" ]; then
  case "$last" in
    *product.cog.tif)
      printf '%s\n' '{{"driverShortName":"GTiff","size":[512,512],"coordinateSystem":{{"wkt":"target-wkt"}},"geoTransform":[500000.0,1.0,0.0,5400000.0,0.0,-1.0],"metadata":{{"IMAGE_STRUCTURE":{{"LAYOUT":"COG"}}}},"bands":[{{"noDataValue":-9999.0}}]}}'
      ;;
    *) printf '%s\n' '{{"driverShortName":"VRT","coordinateSystem":{{"wkt":"target-wkt"}}}}' ;;
  esac
  exit 0
fi
printf '%s|%s|%s|' "$name" "$PROJ_NETWORK" "$GDAL_DRIVER_PATH" >> '{log}'
for argument in "$@"; do printf '%s ' "$argument" >> '{log}'; done
printf '\n' >> '{log}'
{delay}
case "$last" in
  *.f32) dd if=/dev/zero of="$last" bs=1048576 count=1 status=none ;;
  *) printf '%s\n' 'fake GDAL output' > "$last" ;;
esac
"#,
            log = log.display(),
            delay = delay,
        );
        [
            "gdal_grid",
            "gdal_rasterize",
            "gdalwarp",
            "gdalbuildvrt",
            "gdal_translate",
            "gdalinfo",
            "ogrinfo",
        ]
        .into_iter()
        .map(|name| {
            let path = directory.join(name);
            fs::write(&path, &script).expect("fake tool script");
            let mut permissions = fs::metadata(&path).expect("fake metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&path, permissions).expect("fake executable permissions");
            path
        })
        .collect()
    }
}
