//! Bounded worker admission, queueing, cancellation, progress, checkpoint, and drain mechanics.

use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

use fs2::FileExt;
pub use himmelcad_hardware_profile::memory_os_ui_reserve_bytes;
use himmelcad_hardware_profile::usable_compute_memory_bytes;
use himmelcad_model::{entity::EntityId, hash::ObjectHash};
use himmelcad_process::jobs::{
    CancellationToken, CheckpointCommitState, CheckpointId, CHECKPOINT_SCHEMA_VERSION,
};
use serde::{Deserialize, Serialize};
use tokio::{
    runtime::Handle,
    sync::{watch, Mutex, OwnedSemaphorePermit, Semaphore},
    time::{sleep, timeout_at, Duration, Instant as TokioInstant},
};

use crate::photolab_jobs::{
    CheckpointDescriptor, JobError, JobProgress, NewPhotolabJob, PhotolabJob,
    PhotolabJobDiskEstimate, PhotolabJobId, PhotolabJobKind, PhotolabJobMemory, PhotolabJobState,
    PhotolabMatchingMemoryReplan, PhotolabMemoryDegradation, PhotolabMemoryObservation,
    PhotolabStageMemory, PhotolabWorkerTool,
};
use crate::photolab_products::ProductKind;

// WP-B6 calibration governed by the release-polish plan's tunables register: 500 ms
// bounds memory-only terminal history without hot-looping a persistently failing disk.
const HISTORY_RETRY_INTERVAL: Duration = Duration::from_millis(500);

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

// WP-G1a-3g X6 tunables, derived from the 2026-09-10 45.8 M-point DSM probe:
// 3.3 GB CSV ~= 72.1 B/point, 4.0 GB FlatGeobuf ~= 87.4 B/point, and 2.9 GB
// GDAL temporary storage ~= 63.4 B/point. Each byte rate is rounded up so
// admission remains conservative as coordinate widths vary.
const DENSE_RASTER_CSV_BYTES_PER_POINT: u64 = 73;
const DENSE_RASTER_FLATGEOBUF_BYTES_PER_POINT: u64 = 88;
// Measured 2026-09-10 on the 45.8 M-point Sulzberg cloud: the CSV → FlatGeobuf →
// gdal_grid pipeline drove free space from 14.0 GB to zero (ENOSPC) although the
// scratch directory itself peaked at 10.5 GB; the difference is GDAL/OGR temporary
// and page-cache-backed writes that only show up as consumed space. The temp term
// therefore carries the whole measured gap (14.0 GB / 45.8 M ≈ 306 B/point in total).
const DENSE_RASTER_GDAL_TEMP_BYTES_PER_POINT: u64 = 145;
const DENSE_RASTER_HEADROOM_NUMERATOR: u64 = 11;
const DENSE_RASTER_HEADROOM_DENOMINATOR: u64 = 10;

#[derive(Debug, Clone, Copy)]
struct DiskEstimateTuning {
    kind: PhotolabJobKind,
    formula: DiskEstimateFormula,
}

#[derive(Debug, Clone, Copy)]
enum DiskEstimateFormula {
    Images {
        fixed_bytes: u64,
        bytes_per_image: u64,
        multiplier_numerator: u64,
        multiplier_denominator: u64,
    },
    RasterPyramid {
        bytes_per_pixel: u64,
        overview_numerator: u64,
        overview_denominator: u64,
        scratch_output_multiplier: u64,
    },
}

// WP-B4 X6 tunables. These deliberately over-budget scratch plus output: alignment keeps a
// 2 GiB database/tool reserve plus 8 MiB per image; depth maps reserve 40 MiB per image;
// dense fusion reserves 1.5 times that depth footprint; mesh and splat cover their large
// intermediate representations with fixed 2 GiB and 6 GiB reserves. Raster work is computed
// as four times a four-byte-per-pixel pyramid; 4/3 accounts for every power-of-two overview.
const DISK_ESTIMATE_TUNING: &[DiskEstimateTuning] = &[
    DiskEstimateTuning {
        kind: PhotolabJobKind::AlignPhotos,
        formula: DiskEstimateFormula::Images {
            fixed_bytes: 2 * GIB,
            bytes_per_image: 8 * MIB,
            multiplier_numerator: 1,
            multiplier_denominator: 1,
        },
    },
    DiskEstimateTuning {
        kind: PhotolabJobKind::MergeAlignments,
        formula: DiskEstimateFormula::Images {
            fixed_bytes: 2 * GIB,
            bytes_per_image: 8 * MIB,
            multiplier_numerator: 1,
            multiplier_denominator: 1,
        },
    },
    DiskEstimateTuning {
        kind: PhotolabJobKind::BuildDepthMaps,
        formula: DiskEstimateFormula::Images {
            fixed_bytes: 0,
            bytes_per_image: 40 * MIB,
            multiplier_numerator: 1,
            multiplier_denominator: 1,
        },
    },
    DiskEstimateTuning {
        kind: PhotolabJobKind::BuildDensePointCloud,
        formula: DiskEstimateFormula::Images {
            fixed_bytes: 0,
            bytes_per_image: 40 * MIB,
            multiplier_numerator: 3,
            multiplier_denominator: 2,
        },
    },
    DiskEstimateTuning {
        kind: PhotolabJobKind::BuildDem,
        formula: DiskEstimateFormula::RasterPyramid {
            bytes_per_pixel: 4,
            overview_numerator: 4,
            overview_denominator: 3,
            scratch_output_multiplier: 4,
        },
    },
    DiskEstimateTuning {
        kind: PhotolabJobKind::BuildOrthomosaic,
        formula: DiskEstimateFormula::RasterPyramid {
            bytes_per_pixel: 4,
            overview_numerator: 4,
            overview_denominator: 3,
            scratch_output_multiplier: 4,
        },
    },
    DiskEstimateTuning {
        kind: PhotolabJobKind::BuildMesh,
        formula: DiskEstimateFormula::Images {
            fixed_bytes: 2 * GIB,
            bytes_per_image: 0,
            multiplier_numerator: 1,
            multiplier_denominator: 1,
        },
    },
    DiskEstimateTuning {
        kind: PhotolabJobKind::BuildGaussianSplat,
        formula: DiskEstimateFormula::Images {
            fixed_bytes: 6 * GIB,
            bytes_per_image: 0,
            multiplier_numerator: 1,
            multiplier_denominator: 1,
        },
    },
];

/// Immutable publication class used to serialize jobs that could overwrite the same lineage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PublicationTargetKind {
    Alignment,
    Optimization,
    DepthMaps,
    DensePointCloud,
    Dem,
    Orthomosaic,
    TexturedMesh,
    GaussianSplat,
}

/// Publication identity captured from a frozen request before scheduler admission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationTarget {
    pub kind: PublicationTargetKind,
    pub target_entity_id: EntityId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage_target: Option<EntityId>,
}

impl PublicationTarget {
    #[must_use]
    pub const fn alignment(target_entity_id: EntityId, lineage_target: Option<EntityId>) -> Self {
        Self {
            kind: PublicationTargetKind::Alignment,
            target_entity_id,
            lineage_target,
        }
    }

    #[must_use]
    pub const fn optimization(
        target_entity_id: EntityId,
        lineage_target: Option<EntityId>,
    ) -> Self {
        Self {
            kind: PublicationTargetKind::Optimization,
            target_entity_id,
            lineage_target,
        }
    }

    #[must_use]
    pub const fn product(
        kind: ProductKind,
        target_entity_id: EntityId,
        lineage_target: Option<EntityId>,
    ) -> Self {
        let kind = match kind {
            ProductKind::DepthMaps => PublicationTargetKind::DepthMaps,
            ProductKind::DensePointCloud => PublicationTargetKind::DensePointCloud,
            ProductKind::Dem => PublicationTargetKind::Dem,
            ProductKind::Orthomosaic => PublicationTargetKind::Orthomosaic,
            ProductKind::TexturedMesh => PublicationTargetKind::TexturedMesh,
            ProductKind::GaussianSplat => PublicationTargetKind::GaussianSplat,
        };
        Self {
            kind,
            target_entity_id,
            lineage_target,
        }
    }

    fn description(&self) -> (&'static str, &'static str) {
        match self.kind {
            PublicationTargetKind::Alignment => ("an alignment", "target"),
            PublicationTargetKind::Optimization => ("an optimization", "alignment"),
            PublicationTargetKind::DepthMaps => ("depth maps", "alignment"),
            PublicationTargetKind::DensePointCloud => ("a dense point cloud", "alignment"),
            PublicationTargetKind::Dem => ("a DEM", "alignment"),
            PublicationTargetKind::Orthomosaic => ("an orthomosaic", "alignment"),
            PublicationTargetKind::TexturedMesh => ("a mesh", "alignment"),
            PublicationTargetKind::GaussianSplat => ("a Gaussian splat", "alignment"),
        }
    }
}

/// Inputs whose size determines the conservative scratch-plus-output estimate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiskEstimateScale {
    Images(u64),
    RasterPixels(u64),
    DenseRaster {
        point_count: u64,
        raster_pixels: u64,
    },
    Fixed,
}

/// Measured scratch and predicted output components attached to raster admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskEstimateComponents {
    pub scratch_bytes: u64,
    pub output_bytes: u64,
    pub required_bytes: u64,
}

/// One free-space check attached to an immutable job admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskPreflight {
    pub required_bytes: u64,
    pub path: PathBuf,
}

/// Memory estimate and frozen per-machine choices checked before visibility.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemoryPreflight {
    pub predicted_bytes: u64,
    pub available_bytes: u64,
    /// Usable machine memory before subtracting running-job reservations.
    pub machine_usable_bytes: u64,
    pub memory: PhotolabJobMemory,
    pub refusal: Option<JobAdmissionRefusal>,
}

/// A fail-closed admission outcome that remains visible as a terminal job without starting work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobAdmissionRefusal {
    pub code: String,
    pub message: String,
}

/// Resolved worker evidence and an optional fail-closed toolchain refusal.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkerToolchainAdmission {
    pub tools: Vec<PhotolabWorkerTool>,
    pub refusal: Option<JobAdmissionRefusal>,
}

impl MemoryPreflight {
    /// Freezes an envelope while explicitly warning that this stage has no bound yet.
    #[must_use]
    pub fn unbounded(available_bytes: u64, stage: impl Into<String>) -> Self {
        let stage = stage.into();
        Self {
            predicted_bytes: 0,
            available_bytes,
            machine_usable_bytes: available_bytes,
            memory: PhotolabJobMemory {
                envelope_bytes: available_bytes,
                stages: Vec::new(),
                time_first_choices: Vec::new(),
                degradations: Vec::new(),
                observations: vec![PhotolabMemoryObservation::UnboundedStage {
                    stage,
                    budget_bytes: available_bytes,
                }],
                matching_replanned: None,
                raster_preparation: None,
            },
            refusal: None,
        }
    }
}

impl DiskPreflight {
    #[must_use]
    pub fn for_job(kind: PhotolabJobKind, scale: DiskEstimateScale, path: PathBuf) -> Self {
        Self {
            required_bytes: estimate_job_bytes(kind, scale),
            path,
        }
    }
}

/// Returns the components of a dense-raster estimate before its 10% admission headroom.
#[must_use]
pub fn disk_estimate_components(
    kind: PhotolabJobKind,
    scale: DiskEstimateScale,
) -> DiskEstimateComponents {
    let output_bytes = estimate_raster_output_bytes(kind, scale);
    let scratch_bytes = match scale {
        DiskEstimateScale::DenseRaster { point_count, .. } => point_count.saturating_mul(
            DENSE_RASTER_CSV_BYTES_PER_POINT
                + DENSE_RASTER_FLATGEOBUF_BYTES_PER_POINT
                + DENSE_RASTER_GDAL_TEMP_BYTES_PER_POINT,
        ),
        _ => 0,
    };
    let required_bytes = if matches!(scale, DiskEstimateScale::DenseRaster { .. }) {
        scratch_bytes
            .saturating_add(output_bytes)
            .saturating_mul(DENSE_RASTER_HEADROOM_NUMERATOR)
            .saturating_add(DENSE_RASTER_HEADROOM_DENOMINATOR - 1)
            .saturating_div(DENSE_RASTER_HEADROOM_DENOMINATOR)
    } else {
        output_bytes
    };
    DiskEstimateComponents {
        scratch_bytes,
        output_bytes,
        required_bytes,
    }
}

/// Scheduler metadata captured alongside the frozen compute request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobAdmission {
    pub publication_targets: Vec<PublicationTarget>,
    pub disk_preflight: Option<DiskPreflight>,
    pub memory_preflight: Option<MemoryPreflight>,
    pub toolchain_preflight: Option<WorkerToolchainAdmission>,
}

#[must_use]
pub fn estimate_job_bytes(kind: PhotolabJobKind, scale: DiskEstimateScale) -> u64 {
    let Some(tuning) = DISK_ESTIMATE_TUNING.iter().find(|entry| entry.kind == kind) else {
        return 0;
    };
    match (tuning.formula, scale) {
        (
            DiskEstimateFormula::Images {
                fixed_bytes,
                bytes_per_image,
                multiplier_numerator,
                multiplier_denominator,
            },
            DiskEstimateScale::Images(image_count),
        ) => fixed_bytes.saturating_add(
            bytes_per_image
                .saturating_mul(image_count)
                .saturating_mul(multiplier_numerator)
                .saturating_add(multiplier_denominator - 1)
                .saturating_div(multiplier_denominator),
        ),
        (DiskEstimateFormula::Images { fixed_bytes, .. }, DiskEstimateScale::Fixed) => fixed_bytes,
        (
            DiskEstimateFormula::RasterPyramid {
                bytes_per_pixel,
                overview_numerator,
                overview_denominator,
                scratch_output_multiplier,
            },
            DiskEstimateScale::RasterPixels(pixels)
            | DiskEstimateScale::DenseRaster {
                raster_pixels: pixels,
                ..
            },
        ) => {
            let output_bytes = pixels
                .saturating_mul(bytes_per_pixel)
                .saturating_mul(overview_numerator)
                .saturating_add(overview_denominator - 1)
                .saturating_div(overview_denominator)
                .saturating_mul(scratch_output_multiplier);
            if let DiskEstimateScale::DenseRaster { point_count, .. } = scale {
                let scratch_bytes = point_count.saturating_mul(
                    DENSE_RASTER_CSV_BYTES_PER_POINT
                        + DENSE_RASTER_FLATGEOBUF_BYTES_PER_POINT
                        + DENSE_RASTER_GDAL_TEMP_BYTES_PER_POINT,
                );
                scratch_bytes
                    .saturating_add(output_bytes)
                    .saturating_mul(DENSE_RASTER_HEADROOM_NUMERATOR)
                    .saturating_add(DENSE_RASTER_HEADROOM_DENOMINATOR - 1)
                    .saturating_div(DENSE_RASTER_HEADROOM_DENOMINATOR)
            } else {
                output_bytes
            }
        }
        _ => 0,
    }
}

fn estimate_raster_output_bytes(kind: PhotolabJobKind, scale: DiskEstimateScale) -> u64 {
    let raster_pixels = match scale {
        DiskEstimateScale::RasterPixels(raster_pixels)
        | DiskEstimateScale::DenseRaster { raster_pixels, .. } => raster_pixels,
        _ => return 0,
    };
    estimate_job_bytes(kind, DiskEstimateScale::RasterPixels(raster_pixels))
}

/// Returns the level-zero pixel count for a finite projected extent and GSD.
#[must_use]
pub fn raster_pixel_count(minimum: [f64; 3], maximum: [f64; 3], gsd: f64) -> Option<u64> {
    if !gsd.is_finite()
        || gsd <= 0.0
        || minimum[..2]
            .iter()
            .chain(&maximum[..2])
            .any(|value| !value.is_finite())
        || minimum[0] >= maximum[0]
        || minimum[1] >= maximum[1]
    {
        return None;
    }
    let width = ((maximum[0] - minimum[0]) / gsd).ceil();
    let height = ((maximum[1] - minimum[1]) / gsd).ceil();
    if width > u64::MAX as f64 || height > u64::MAX as f64 {
        return None;
    }
    (width as u64).checked_mul(height as u64)
}

#[doc(hidden)]
pub type DiskAvailability = dyn Fn(&Path) -> Result<u64, String> + Send + Sync;

/// Immutable project identity captured when a job is admitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobHistoryScope {
    pub project_id: String,
    pub project_root: PathBuf,
}

/// Opaque, integrity-bound request retained beside a durable job record.
///
/// The sidecar owns this value. Renderers only identify the history job they
/// want resumed and never reconstruct execution parameters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenJobRequest {
    pub schema_version: u32,
    pub method: String,
    pub params: serde_json::Value,
    pub job_kind: PhotolabJobKind,
    pub config_hash: ObjectHash,
    pub input_hash: ObjectHash,
    pub binding_sha256: ObjectHash,
}

impl FrozenJobRequest {
    pub fn new(
        method: impl Into<String>,
        params: serde_json::Value,
        job: &NewPhotolabJob,
    ) -> Result<Self, serde_json::Error> {
        let method = method.into();
        let binding_sha256 = frozen_request_binding_hash(
            &method,
            &params,
            job.kind,
            &job.config_hash,
            &job.input_hash,
        )?;
        Ok(Self {
            schema_version: 1,
            method,
            params,
            job_kind: job.kind,
            config_hash: job.config_hash.clone(),
            input_hash: job.input_hash.clone(),
            binding_sha256,
        })
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("unsupported frozen job request schema".into());
        }
        let expected = frozen_request_binding_hash(
            &self.method,
            &self.params,
            self.job_kind,
            &self.config_hash,
            &self.input_hash,
        )
        .map_err(|error| error.to_string())?;
        if self.binding_sha256 != expected {
            return Err("frozen job request binding hash does not match its payload".into());
        }
        Ok(())
    }
}

fn frozen_request_binding_hash(
    method: &str,
    params: &serde_json::Value,
    kind: PhotolabJobKind,
    config_hash: &ObjectHash,
    input_hash: &ObjectHash,
) -> Result<ObjectHash, serde_json::Error> {
    Ok(ObjectHash::of_bytes(&serde_json::to_vec(&(
        1_u32,
        method,
        params,
        kind,
        config_hash,
        input_hash,
    ))?))
}

/// Project storage adapter used by the process-local scheduler.
pub trait JobHistoryPersistence: Send + Sync {
    /// Returns the project that currently owns newly admitted jobs.
    fn current_scope(&self) -> Result<Option<JobHistoryScope>, String>;

    /// Returns all durable records for the currently open project.
    fn load_current(&self) -> Result<Vec<PhotolabJob>, String>;

    /// Atomically upserts one lifecycle snapshot in its captured project.
    fn persist(
        &self,
        scope: &JobHistoryScope,
        job: &PhotolabJob,
        frozen_request: Option<&FrozenJobRequest>,
    ) -> Result<(), String>;

    /// Active project-runtime operations exposed through the global jobs surface.
    fn list_side_operations(&self) -> Result<Vec<PhotolabJob>, String> {
        Ok(Vec::new())
    }

    /// Returns an active side operation, if this history owner has one with the id.
    fn side_operation_status(
        &self,
        _job_id: &PhotolabJobId,
    ) -> Result<Option<PhotolabJob>, String> {
        Ok(None)
    }

    /// Requests cancellation from the original side-operation owner.
    fn cancel_side_operation(
        &self,
        _job_id: &PhotolabJobId,
    ) -> Result<Option<CancelJobResult>, String> {
        Ok(None)
    }
}

/// Bounded scheduling policy for one sidecar process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobManagerConfig {
    pub max_concurrency: usize,
    pub max_queued: usize,
}

impl JobManagerConfig {
    #[doc(hidden)]
    pub fn capacity(self) -> Result<usize, JobManagerError> {
        if self.max_concurrency == 0 {
            return Err(JobManagerError::InvalidConfig(
                "max_concurrency must be greater than zero",
            ));
        }
        self.max_concurrency
            .checked_add(self.max_queued)
            .ok_or(JobManagerError::InvalidConfig(
                "max_concurrency plus max_queued overflows usize",
            ))
    }
}

/// RPC input for `photolab.jobs.start`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJobParams {
    pub job: NewPhotolabJob,
}

/// Immediate response after a job was admitted to the bounded queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJobResult {
    pub job: PhotolabJob,
}

/// RPC input for `photolab.jobs.list`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListJobsParams {
    #[serde(default)]
    pub include_terminal: bool,
}

/// RPC input shared by status and cancel operations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobIdParams {
    pub job_id: PhotolabJobId,
}

/// Result of a cancellation request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelJobResult {
    pub first_request: bool,
    pub job: PhotolabJob,
}

/// Outcome of a bounded cancellation drain before project replacement or shutdown.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainReport {
    /// Jobs that reached a terminal state within the requested deadline.
    pub terminal: usize,
    /// Jobs force-classified as failed after the deadline elapsed.
    pub timed_out: Vec<PhotolabJobId>,
}

impl DrainReport {
    /// An empty report proves that no jobs needed draining.
    #[must_use]
    pub const fn empty() -> Self {
        Self {
            terminal: 0,
            timed_out: Vec::new(),
        }
    }

    /// Only a drain with no timed-out workers permits a clean project close.
    #[must_use]
    pub fn completed(&self) -> bool {
        self.timed_out.is_empty()
    }
}

/// Failure reported intentionally by a compute worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobWorkerError {
    Cancelled,
    Failed { code: String, message: String },
}

impl std::fmt::Display for JobWorkerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("job worker observed cancellation"),
            Self::Failed { code, message } => {
                write!(formatter, "job worker failed with {code}: {message}")
            }
        }
    }
}

impl std::error::Error for JobWorkerError {}

impl From<JobManagerError> for JobWorkerError {
    fn from(error: JobManagerError) -> Self {
        Self::Failed {
            code: "runtimeSink".into(),
            message: error.to_string(),
        }
    }
}

/// Result returned by a blocking compute worker.
pub type JobWorkerResult = Result<(), JobWorkerError>;

/// Cheap progress callback scoped to one job.
#[derive(Debug, Clone)]
pub struct ProgressSink {
    manager: JobManager,
    job_id: PhotolabJobId,
    stage_base: u32,
    stage_count: Option<u32>,
}

impl ProgressSink {
    /// Reports a monotone progress point to the authoritative core record.
    pub async fn report(&self, progress: JobProgress) -> Result<PhotolabJob, JobManagerError> {
        self.manager
            .update_progress(&self.job_id, self.map_progress(progress))
            .await
    }

    /// Blocking variant for code already executing inside `spawn_blocking`.
    pub fn report_blocking(&self, progress: JobProgress) -> Result<PhotolabJob, JobManagerError> {
        self.manager.runtime.block_on(
            self.manager
                .update_progress(&self.job_id, self.map_progress(progress)),
        )
    }

    fn map_progress(&self, mut progress: JobProgress) -> JobProgress {
        if let Some(stage_count) = self.stage_count {
            progress.stage.index = self.stage_base.saturating_add(progress.stage.index);
            progress.stage.stage_count = stage_count;
        }
        progress
    }
}

/// Cheap checkpoint callback scoped to one job.
#[derive(Debug, Clone)]
pub struct CheckpointSink {
    manager: JobManager,
    job_id: PhotolabJobId,
    job_kind: PhotolabJobKind,
    config_hash: ObjectHash,
    input_hash: ObjectHash,
    stage_base: u32,
    stage_count: Option<u32>,
}

impl CheckpointSink {
    /// Records a committed checkpoint descriptor.
    pub async fn record(
        &self,
        checkpoint: &CheckpointDescriptor,
    ) -> Result<PhotolabJob, JobManagerError> {
        self.manager
            .record_checkpoint(&self.job_id, checkpoint)
            .await
    }

    /// Blocking variant for code already executing inside `spawn_blocking`.
    pub fn record_blocking(
        &self,
        checkpoint: &CheckpointDescriptor,
    ) -> Result<PhotolabJob, JobManagerError> {
        self.manager
            .runtime
            .block_on(self.manager.record_checkpoint(&self.job_id, checkpoint))
    }

    /// Returns the parent job kind represented by this sink.
    #[must_use]
    pub const fn job_kind(&self) -> PhotolabJobKind {
        self.job_kind
    }

    /// Records metadata for a payload that has already been durably committed.
    pub async fn record_committed(
        &self,
        sequence: u64,
        progress: JobProgress,
        checkpoint_id: impl Into<String>,
        payload_hash: ObjectHash,
    ) -> Result<PhotolabJob, JobManagerError> {
        let checkpoint =
            self.committed_descriptor(sequence, progress, checkpoint_id.into(), payload_hash);
        self.record(&checkpoint).await
    }

    /// Blocking variant for supervised native workers.
    pub fn record_committed_blocking(
        &self,
        sequence: u64,
        progress: JobProgress,
        checkpoint_id: impl Into<String>,
        payload_hash: ObjectHash,
    ) -> Result<PhotolabJob, JobManagerError> {
        let checkpoint =
            self.committed_descriptor(sequence, progress, checkpoint_id.into(), payload_hash);
        self.record_blocking(&checkpoint)
    }

    fn committed_descriptor(
        &self,
        sequence: u64,
        progress: JobProgress,
        checkpoint_id: String,
        payload_hash: ObjectHash,
    ) -> CheckpointDescriptor {
        CheckpointDescriptor {
            schema_version: CHECKPOINT_SCHEMA_VERSION,
            checkpoint_id: CheckpointId(checkpoint_id),
            job_id: self.job_id.clone(),
            job_kind: self.job_kind,
            sequence,
            progress: self.map_progress(progress),
            config_hash: self.config_hash.clone(),
            input_hash: self.input_hash.clone(),
            commit_state: CheckpointCommitState::Committed { payload_hash },
        }
    }

    fn map_progress(&self, mut progress: JobProgress) -> JobProgress {
        if let Some(stage_count) = self.stage_count {
            progress.stage.index = self.stage_base.saturating_add(progress.stage.index);
            progress.stage.stage_count = stage_count;
        }
        progress
    }
}

impl himmelcad_process::raster_jobs::RasterCheckpointSink for CheckpointSink {
    fn accepts_raster_checkpoints(&self) -> bool {
        matches!(
            self.job_kind,
            PhotolabJobKind::BuildDem | PhotolabJobKind::BuildOrthomosaic
        )
    }

    fn record_raster_committed<'a>(
        &'a self,
        sequence: u64,
        progress: himmelcad_process::raster_jobs::RasterProgress,
        checkpoint_id: String,
        payload_hash: ObjectHash,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            self.record_committed(
                sequence,
                raster_checkpoint_progress(&progress, self.job_kind),
                checkpoint_id,
                payload_hash,
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
        })
    }
}

fn raster_checkpoint_progress(
    progress: &himmelcad_process::raster_jobs::RasterProgress,
    kind: PhotolabJobKind,
) -> JobProgress {
    let (index, stage_kind) = match progress.phase {
        himmelcad_process::raster_jobs::RasterPhase::Validating => {
            (0, crate::photolab_jobs::PhotolabStageKind::Preparing)
        }
        himmelcad_process::raster_jobs::RasterPhase::Rasterizing
        | himmelcad_process::raster_jobs::RasterPhase::Orthorectifying => {
            (1, crate::photolab_jobs::PhotolabStageKind::Rasterization)
        }
        himmelcad_process::raster_jobs::RasterPhase::Mosaicking => {
            (2, crate::photolab_jobs::PhotolabStageKind::Rasterization)
        }
        himmelcad_process::raster_jobs::RasterPhase::BuildingPyramid => {
            (3, crate::photolab_jobs::PhotolabStageKind::Rasterization)
        }
        himmelcad_process::raster_jobs::RasterPhase::ExportingCog => {
            (4, crate::photolab_jobs::PhotolabStageKind::Rasterization)
        }
        himmelcad_process::raster_jobs::RasterPhase::ValidatingCog => {
            (5, crate::photolab_jobs::PhotolabStageKind::Finalizing)
        }
        himmelcad_process::raster_jobs::RasterPhase::Committing => {
            (6, crate::photolab_jobs::PhotolabStageKind::Finalizing)
        }
    };
    let orthomosaic = kind == PhotolabJobKind::BuildOrthomosaic;

    JobProgress {
        stage: crate::photolab_jobs::PhotolabStage {
            kind: stage_kind,
            index: index + u32::from(orthomosaic),
            stage_count: 7 + u32::from(orthomosaic),
            label: progress.current_step.clone(),
        },
        metrics: himmelcad_process::jobs::ProgressMetrics {
            completed_units: progress.completed_steps,
            total_units: Some(progress.total_steps.max(1)),
            completed_bytes: 0,
            total_bytes: None,
        },
    }
}

/// Cheap diagnostic callback scoped to one job.
#[derive(Debug, Clone)]
pub struct JobDiagnosticSink {
    manager: JobManager,
    job_id: PhotolabJobId,
}

/// Cheap memory-evidence callback scoped to one job.
#[derive(Debug, Clone)]
pub struct JobMemorySink {
    manager: JobManager,
    job_id: PhotolabJobId,
}

impl JobMemorySink {
    /// Persists a sampled subprocess-group peak from blocking worker code.
    pub fn record_stage_peak_blocking(
        &self,
        stage: impl Into<String>,
        peak_rss_bytes: u64,
        workers: u16,
        parameters: serde_json::Value,
    ) -> Result<(), JobManagerError> {
        self.manager
            .runtime
            .block_on(self.manager.record_stage_memory(
                &self.job_id,
                PhotolabStageMemory {
                    stage: stage.into(),
                    peak_rss_bytes,
                    workers,
                    parameters,
                },
            ))
    }

    /// Records an uncalibrated stage as warning-level typed evidence.
    pub fn record_unbounded_stage_blocking(
        &self,
        stage: impl Into<String>,
    ) -> Result<(), JobManagerError> {
        self.manager.runtime.block_on(
            self.manager
                .record_unbounded_memory_stage(&self.job_id, stage.into()),
        )
    }

    /// Persists the database-derived matcher plan before the matcher can start.
    pub fn record_matching_replan_blocking(
        &self,
        replan: PhotolabMatchingMemoryReplan,
        keypoint_cap: u32,
        degradation: Option<PhotolabMemoryDegradation>,
    ) -> Result<(), JobManagerError> {
        self.manager
            .runtime
            .block_on(self.manager.record_matching_replan(
                &self.job_id,
                replan,
                keypoint_cap,
                degradation,
            ))
    }

    /// Persists a child-process envelope breach before returning the typed worker error.
    pub fn record_worker_memory_limit_hit_blocking(
        &self,
        stage: impl Into<String>,
        limit_bytes: u64,
    ) -> Result<(), JobManagerError> {
        self.manager
            .runtime
            .block_on(self.manager.record_worker_memory_limit_hit(
                &self.job_id,
                stage.into(),
                limit_bytes,
            ))
    }

    /// Persists one matcher thread-count fallback before the next attempt starts.
    pub fn record_matching_threads_halved_blocking(
        &self,
        from: u16,
        to: u16,
        observed_peak_bytes: u64,
    ) -> Result<(), JobManagerError> {
        self.manager
            .runtime
            .block_on(self.manager.record_matching_threads_halved(
                &self.job_id,
                from,
                to,
                observed_peak_bytes,
            ))
    }

    /// Records the thread count used by the successful matcher attempt.
    pub fn record_matching_threads_blocking(
        &self,
        stage: impl Into<String>,
        threads: u16,
    ) -> Result<(), JobManagerError> {
        self.manager
            .runtime
            .block_on(
                self.manager
                    .record_matching_threads(&self.job_id, stage.into(), threads),
            )
    }
}

impl himmelcad_process::raster_jobs::RasterMemorySink for JobMemorySink {
    fn record_stage_peak(
        &self,
        stage: &'static str,
        peak_rss_bytes: u64,
        workers: u16,
        parameters: serde_json::Value,
    ) -> Result<(), String> {
        self.record_stage_peak_blocking(stage, peak_rss_bytes, workers, parameters)
            .map_err(|error| error.to_string())
    }

    fn record_worker_memory_limit_hit(
        &self,
        stage: &'static str,
        limit_bytes: u64,
    ) -> Result<(), String> {
        self.record_worker_memory_limit_hit_blocking(stage, limit_bytes)
            .map_err(|error| error.to_string())
    }
}

impl JobDiagnosticSink {
    /// Persists a non-fatal diagnostic from blocking worker code.
    pub fn record_blocking(&self, diagnostic: impl Into<String>) -> Result<(), JobManagerError> {
        self.manager.runtime.block_on(
            self.manager
                .record_terminal_diagnostic(&self.job_id, diagnostic.into()),
        )
    }
}

/// Capabilities handed to a blocking Photolab compute worker.
#[derive(Debug, Clone)]
pub struct JobWorkerContext {
    pub cancellation: CancellationToken,
    pub progress: ProgressSink,
    pub checkpoints: CheckpointSink,
    pub diagnostics: JobDiagnosticSink,
    pub memory: JobMemorySink,
}

impl JobWorkerContext {
    /// Converts the core cancellation signal into the worker result contract.
    pub fn check_cancelled(&self) -> JobWorkerResult {
        self.cancellation
            .check()
            .map_err(|_| JobWorkerError::Cancelled)
    }

    /// Maps a worker-local stage plan into one immutable parent job plan.
    #[must_use]
    pub fn with_progress_window(&self, stage_base: u32, stage_count: u32) -> Self {
        let mut mapped = self.clone();
        mapped.progress.stage_base = stage_base;
        mapped.progress.stage_count = Some(stage_count);
        mapped.checkpoints.stage_base = stage_base;
        mapped.checkpoints.stage_count = Some(stage_count);
        mapped
    }
}

struct ManagedJob {
    job: PhotolabJob,
    publication_targets: Vec<PublicationTarget>,
    cancellation: CancellationToken,
    updates: watch::Sender<PhotolabJob>,
    worker_updates: watch::Sender<bool>,
    worker_active: bool,
    history_scope: Option<JobHistoryScope>,
    frozen_request: Option<FrozenJobRequest>,
    history_dirty: bool,
    last_history_persisted_at: Instant,
    memory_reservation_bytes: u64,
}

#[doc(hidden)]
pub struct JobManagerInner {
    config: JobManagerConfig,
    capacity: usize,
    #[doc(hidden)]
    pub concurrency: Arc<Semaphore>,
    jobs: Mutex<BTreeMap<String, ManagedJob>>,
    history: Option<Arc<dyn JobHistoryPersistence>>,
    disk_availability: Arc<DiskAvailability>,
    draining: AtomicBool,
}

/// Thread-safe and Tokio-safe bounded job registry and supervisor.
#[derive(Clone)]
pub struct JobManager {
    #[doc(hidden)]
    pub inner: Arc<JobManagerInner>,
    runtime: Handle,
}

impl std::fmt::Debug for JobManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("JobManager")
            .field("config", &self.inner.config)
            .finish_non_exhaustive()
    }
}

impl JobManager {
    /// Creates a manager attached to the current Tokio runtime.
    pub fn new(config: JobManagerConfig) -> Result<Self, JobManagerError> {
        let runtime = Handle::try_current().map_err(|_| JobManagerError::NoTokioRuntime)?;
        Self::with_runtime_and_history(config, runtime, None)
    }

    /// Creates a manager whose lifecycle records are durable per project.
    pub fn new_with_history(
        config: JobManagerConfig,
        history: Arc<dyn JobHistoryPersistence>,
    ) -> Result<Self, JobManagerError> {
        let runtime = Handle::try_current().map_err(|_| JobManagerError::NoTokioRuntime)?;
        Self::with_runtime_and_history(config, runtime, Some(history))
    }

    /// Creates a manager for an explicitly supplied runtime handle.
    pub fn with_runtime(
        config: JobManagerConfig,
        runtime: Handle,
    ) -> Result<Self, JobManagerError> {
        Self::with_runtime_and_history(config, runtime, None)
    }

    fn with_runtime_and_history(
        config: JobManagerConfig,
        runtime: Handle,
        history: Option<Arc<dyn JobHistoryPersistence>>,
    ) -> Result<Self, JobManagerError> {
        Self::with_runtime_history_and_disk_availability(
            config,
            runtime,
            history,
            Arc::new(system_available_bytes),
        )
    }

    #[doc(hidden)]
    pub fn with_runtime_history_and_disk_availability(
        config: JobManagerConfig,
        runtime: Handle,
        history: Option<Arc<dyn JobHistoryPersistence>>,
        disk_availability: Arc<DiskAvailability>,
    ) -> Result<Self, JobManagerError> {
        let capacity = config.capacity()?;
        let inner = Arc::new(JobManagerInner {
            config,
            capacity,
            concurrency: Arc::new(Semaphore::new(config.max_concurrency)),
            jobs: Mutex::new(BTreeMap::new()),
            history,
            disk_availability,
            draining: AtomicBool::new(false),
        });
        if inner.history.is_some() {
            let weak_inner = Arc::downgrade(&inner);
            runtime.spawn(async move {
                loop {
                    sleep(HISTORY_RETRY_INTERVAL).await;
                    let Some(inner) = weak_inner.upgrade() else {
                        break;
                    };
                    let history = inner.history.clone();
                    let mut jobs = inner.jobs.lock().await;
                    for managed in jobs.values_mut() {
                        retry_history_persistence(history.as_ref(), managed);
                    }
                }
            });
        }
        Ok(Self { inner, runtime })
    }

    /// Admits a job without waiting for a worker slot or blocking the RPC loop.
    pub async fn start<F>(
        &self,
        request: NewPhotolabJob,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        self.start_inner(request, None, JobAdmission::default(), None, work)
            .await
    }

    /// Admits a job with publication serialization and an optional free-space preflight.
    pub async fn start_with_admission<F>(
        &self,
        request: NewPhotolabJob,
        admission: JobAdmission,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        self.start_inner(request, None, admission, None, work).await
    }

    /// Admits a resumable job and atomically retains its sidecar-owned request.
    pub async fn start_with_frozen_request<F>(
        &self,
        request: NewPhotolabJob,
        frozen_request: FrozenJobRequest,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        frozen_request
            .validate()
            .map_err(JobManagerError::InvalidFrozenRequest)?;
        if frozen_request.job_kind != request.kind
            || frozen_request.config_hash != request.config_hash
            || frozen_request.input_hash != request.input_hash
        {
            return Err(JobManagerError::InvalidFrozenRequest(
                "frozen request identity does not match the admitted job".into(),
            ));
        }
        self.start_inner(
            request,
            Some(frozen_request),
            JobAdmission::default(),
            None,
            work,
        )
        .await
    }

    /// Admits a resumable job with frozen publication and disk metadata.
    pub async fn start_with_frozen_request_and_admission<F>(
        &self,
        request: NewPhotolabJob,
        frozen_request: FrozenJobRequest,
        admission: JobAdmission,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        frozen_request
            .validate()
            .map_err(JobManagerError::InvalidFrozenRequest)?;
        if frozen_request.job_kind != request.kind
            || frozen_request.config_hash != request.config_hash
            || frozen_request.input_hash != request.input_hash
        {
            return Err(JobManagerError::InvalidFrozenRequest(
                "frozen request identity does not match the admitted job".into(),
            ));
        }
        self.start_inner(request, Some(frozen_request), admission, None, work)
            .await
    }

    /// Admits a resumable raster job and records its measured scratch estimate before visibility.
    pub async fn start_with_frozen_request_and_disk_admission<F>(
        &self,
        request: NewPhotolabJob,
        frozen_request: FrozenJobRequest,
        admission: JobAdmission,
        disk_estimate: DiskEstimateComponents,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        frozen_request
            .validate()
            .map_err(JobManagerError::InvalidFrozenRequest)?;
        if frozen_request.job_kind != request.kind
            || frozen_request.config_hash != request.config_hash
            || frozen_request.input_hash != request.input_hash
        {
            return Err(JobManagerError::InvalidFrozenRequest(
                "frozen request identity does not match the admitted job".into(),
            ));
        }
        self.start_inner(
            request,
            Some(frozen_request),
            admission,
            Some(disk_estimate),
            work,
        )
        .await
    }

    /// Test and non-resumable counterpart of raster disk admission.
    pub async fn start_with_disk_admission<F>(
        &self,
        request: NewPhotolabJob,
        admission: JobAdmission,
        disk_estimate: DiskEstimateComponents,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        self.start_inner(request, None, admission, Some(disk_estimate), work)
            .await
    }

    async fn start_inner<F>(
        &self,
        request: NewPhotolabJob,
        frozen_request: Option<FrozenJobRequest>,
        mut admission: JobAdmission,
        disk_estimate: Option<DiskEstimateComponents>,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        if self.inner.draining.load(Ordering::Acquire) {
            return Err(JobManagerError::SchedulerDraining);
        }
        let mut unique_targets = Vec::with_capacity(admission.publication_targets.len());
        for target in admission.publication_targets.drain(..) {
            if !unique_targets.contains(&target) {
                unique_targets.push(target);
            }
        }
        admission.publication_targets = unique_targets;
        let refusal = admission
            .toolchain_preflight
            .as_ref()
            .and_then(|preflight| preflight.refusal.clone())
            .or_else(|| {
                admission
                    .memory_preflight
                    .as_ref()
                    .and_then(|preflight| preflight.refusal.clone())
            });
        if disk_estimate.is_some() && admission.disk_preflight.is_none() {
            return Err(JobManagerError::DiskPreflight(
                "disk estimate has no matching free-space preflight".into(),
            ));
        }
        let mut admitted_disk_estimate = None;
        if refusal.is_none() {
            if let Some(preflight) = admission.disk_preflight.as_ref() {
                if let Some(components) = disk_estimate {
                    if components.required_bytes != preflight.required_bytes {
                        return Err(JobManagerError::DiskPreflight(format!(
                            "disk estimate requires {} bytes but preflight requires {} bytes",
                            components.required_bytes, preflight.required_bytes
                        )));
                    }
                }
                let path = preflight.path.clone();
                let required_bytes = preflight.required_bytes;
                let availability = Arc::clone(&self.inner.disk_availability);
                let available_bytes = tokio::task::spawn_blocking(move || availability(&path))
                    .await
                    .map_err(|error| JobManagerError::DiskPreflight(error.to_string()))?
                    .map_err(JobManagerError::DiskPreflight)?;
                if available_bytes < required_bytes {
                    return Err(JobManagerError::InsufficientDisk {
                        required_bytes,
                        available_bytes,
                        path: preflight.path.clone(),
                        job_kind: disk_estimate.map(|_| request.kind),
                        scratch_bytes: disk_estimate.map(|estimate| estimate.scratch_bytes),
                    });
                }
                if let Some(components) = disk_estimate {
                    admitted_disk_estimate = Some(PhotolabJobDiskEstimate {
                        scratch_bytes: components.scratch_bytes,
                        output_bytes: components.output_bytes,
                        available_bytes,
                        volume: preflight.path.to_string_lossy().into_owned(),
                    });
                }
            }
        }
        if refusal.is_none() {
            if let Some(preflight) = admission.memory_preflight.as_ref() {
                if preflight.predicted_bytes > preflight.available_bytes {
                    return Err(JobManagerError::InsufficientMemory {
                        predicted_bytes: preflight.predicted_bytes,
                        available_bytes: preflight.available_bytes,
                    });
                }
            }
        }
        let mut job = PhotolabJob::new(request)?;
        if let Some(preflight) = admission.toolchain_preflight.as_ref() {
            job.set_toolchain(preflight.tools.clone());
        }
        if let Some(preflight) = admission.memory_preflight.as_ref() {
            job.set_memory_plan(preflight.memory.clone());
        }
        if let Some(disk_estimate) = admitted_disk_estimate {
            job.set_disk_estimate(disk_estimate);
        }
        if let Some(refusal) = refusal.as_ref() {
            job.transition_to(PhotolabJobState::Failed {
                code: refusal.code.clone(),
                message: refusal.message.clone(),
            })?;
        }
        let key = job.id.0.clone();
        let cancellation = CancellationToken::new();
        let history_scope = self.current_history_scope()?;
        if self.inner.history.is_some() && history_scope.is_none() {
            return Err(JobManagerError::HistoryPersistence(
                "no PhotoLab project is open for this job".into(),
            ));
        }
        {
            let mut jobs = self.inner.jobs.lock().await;
            if self.inner.draining.load(Ordering::Acquire) {
                return Err(JobManagerError::SchedulerDraining);
            }
            if jobs.contains_key(&key) {
                return Err(JobManagerError::DuplicateJobId(job.id));
            }
            if refusal.is_none() {
                if let Some(preflight) = admission.memory_preflight.as_ref() {
                    let running_holds = jobs
                        .values()
                        .filter(|managed| managed.job.state == PhotolabJobState::Running)
                        .map(|managed| managed.memory_reservation_bytes)
                        .fold(0_u64, u64::saturating_add);
                    let available_bytes =
                        preflight.machine_usable_bytes.saturating_sub(running_holds);
                    if preflight.predicted_bytes > available_bytes {
                        return Err(JobManagerError::InsufficientMemory {
                            predicted_bytes: preflight.predicted_bytes,
                            available_bytes,
                        });
                    }
                    job.memory.envelope_bytes = available_bytes;
                }
            }
            if refusal.is_none() {
                for managed in jobs
                    .values()
                    .filter(|managed| !is_terminal(&managed.job.state))
                {
                    if let Some(target) = admission
                        .publication_targets
                        .iter()
                        .find(|target| managed.publication_targets.contains(target))
                    {
                        return Err(JobManagerError::ConflictingTarget {
                            running_job_id: managed.job.id.clone(),
                            target: target.clone(),
                            state: if matches!(managed.job.state, PhotolabJobState::Queued) {
                                ConflictingJobState::Queued
                            } else {
                                ConflictingJobState::Running
                            },
                        });
                    }
                }
                let active = jobs
                    .values()
                    .filter(|managed| !is_terminal(&managed.job.state))
                    .count();
                if active >= self.inner.capacity {
                    return Err(JobManagerError::QueueFull {
                        max_concurrency: self.inner.config.max_concurrency,
                        max_queued: self.inner.config.max_queued,
                    });
                }
            }
            let (updates, _) = watch::channel(job.clone());
            let worker_active = refusal.is_none();
            let (worker_updates, _) = watch::channel(worker_active);
            jobs.insert(
                key.clone(),
                ManagedJob {
                    job: job.clone(),
                    publication_targets: admission.publication_targets,
                    cancellation: cancellation.clone(),
                    updates,
                    worker_updates,
                    worker_active,
                    history_scope: history_scope.clone(),
                    frozen_request: frozen_request.clone(),
                    history_dirty: false,
                    last_history_persisted_at: Instant::now(),
                    memory_reservation_bytes: if worker_active {
                        admission
                            .memory_preflight
                            .as_ref()
                            .map_or(0, |preflight| preflight.predicted_bytes)
                    } else {
                        0
                    },
                },
            );
            if let (Some(history), Some(scope)) = (&self.inner.history, &history_scope) {
                if let Err(message) = history.persist(scope, &job, frozen_request.as_ref()) {
                    jobs.remove(&key);
                    return Err(JobManagerError::HistoryPersistence(message));
                }
            }
        }

        if refusal.is_some() {
            return Ok(StartJobResult { job });
        }

        let manager = self.clone();
        let job_id = job.id.clone();
        let worker_job_id = job_id.clone();
        let job_kind = job.kind;
        let config_hash = job.config_hash.clone();
        let input_hash = job.input_hash.clone();
        self.runtime.spawn(async move {
            manager
                .supervise_inner(
                    job_id,
                    job_kind,
                    config_hash,
                    input_hash,
                    cancellation,
                    work,
                )
                .await;
            manager.mark_worker_inactive(&worker_job_id).await;
        });
        Ok(StartJobResult { job })
    }

    /// Returns a stable snapshot sorted by job identifier.
    pub async fn list(&self, params: ListJobsParams) -> Result<Vec<PhotolabJob>, JobManagerError> {
        let current_scope = self.current_history_scope()?;
        let mut records = self
            .inner
            .history
            .as_ref()
            .map_or_else(|| Ok(Vec::new()), |history| history.load_current())
            .map_err(JobManagerError::HistoryPersistence)?
            .into_iter()
            .map(|job| (job.id.0.clone(), job))
            .collect::<BTreeMap<_, _>>();
        let mut jobs = self.inner.jobs.lock().await;
        for managed in jobs.values_mut() {
            retry_history_persistence(self.inner.history.as_ref(), managed);
            if self.inner.history.is_some() && managed.history_scope != current_scope {
                continue;
            }
            records.insert(managed.job.id.0.clone(), managed.job.clone());
        }
        let mut records = records
            .into_values()
            .filter(|job| params.include_terminal || !is_terminal(&job.state))
            .collect::<Vec<_>>();
        if let Some(history) = &self.inner.history {
            records.extend(
                history
                    .list_side_operations()
                    .map_err(JobManagerError::HistoryPersistence)?,
            );
        }
        records.sort_by(|left, right| left.id.0.cmp(&right.id.0));
        Ok(records)
    }

    /// Returns the current authoritative record for one job.
    pub async fn status(&self, job_id: &PhotolabJobId) -> Result<PhotolabJob, JobManagerError> {
        let current_scope = self.current_history_scope()?;
        let jobs = self.inner.jobs.lock().await;
        if let Some(job) = jobs
            .get(&job_id.0)
            .filter(|managed| {
                self.inner.history.is_none() || managed.history_scope == current_scope
            })
            .map(|managed| managed.job.clone())
        {
            return Ok(job);
        }
        drop(jobs);
        if let Some(job) = self
            .inner
            .history
            .as_ref()
            .map_or_else(|| Ok(Vec::new()), |history| history.load_current())
            .map_err(JobManagerError::HistoryPersistence)?
            .into_iter()
            .find(|job| job.id == *job_id)
        {
            return Ok(job);
        }
        if let Some(history) = &self.inner.history {
            if let Some(job) = history
                .side_operation_status(job_id)
                .map_err(JobManagerError::HistoryPersistence)?
            {
                return Ok(job);
            }
        }
        Err(JobManagerError::JobNotFound(job_id.clone()))
    }

    /// Returns the per-machine envelope after the OS/UI reserve and running-job holds.
    pub async fn usable_memory_bytes(&self, physical_memory_bytes: u64) -> u64 {
        let jobs = self.inner.jobs.lock().await;
        let running_holds = jobs
            .values()
            .filter(|managed| managed.job.state == PhotolabJobState::Running)
            .map(|managed| managed.memory_reservation_bytes)
            .fold(0_u64, u64::saturating_add);
        usable_compute_memory_bytes(physical_memory_bytes, running_holds)
    }

    /// Latest measured ALIKED extraction calibration available in current project history.
    pub async fn measured_extraction_bytes_per_pixel(&self) -> Option<u64> {
        self.list(ListJobsParams {
            include_terminal: true,
        })
        .await
        .ok()?
        .into_iter()
        .flat_map(|job| job.memory.stages)
        .filter(|stage| stage.stage == "Extract ALIKED" && stage.peak_rss_bytes > 0)
        .filter_map(|stage| {
            let pixels = stage.parameters.get("actualPixels")?.as_u64()?;
            (pixels > 0).then(|| stage.peak_rss_bytes / pixels)
        })
        .filter(|value| *value > 0)
        .last()
    }

    /// Makes cancellation visible before returning to the caller.
    pub async fn cancel(&self, job_id: &PhotolabJobId) -> Result<CancelJobResult, JobManagerError> {
        let current_scope = self.current_history_scope()?;
        let mut jobs = self.inner.jobs.lock().await;
        let Some(managed) = jobs.get_mut(&job_id.0).filter(|managed| {
            self.inner.history.is_none() || managed.history_scope == current_scope
        }) else {
            drop(jobs);
            if let Some(history) = &self.inner.history {
                if let Some(result) = history
                    .cancel_side_operation(job_id)
                    .map_err(JobManagerError::HistoryPersistence)?
                {
                    return Ok(result);
                }
            }
            return Err(JobManagerError::JobNotFound(job_id.clone()));
        };
        let was_queued = managed.job.state == PhotolabJobState::Queued;
        let first_request = managed.job.request_cancel(&managed.cancellation)?;
        if was_queued {
            managed.job.transition_to(PhotolabJobState::Cancelled)?;
        }
        self.publish_durable(managed);
        Ok(CancelJobResult {
            first_request,
            job: managed.job.clone(),
        })
    }

    /// Requests cancellation for every non-terminal job before a project session changes.
    pub async fn cancel_all(&self) -> Vec<PhotolabJob> {
        let mut jobs = self.inner.jobs.lock().await;
        let mut changed = Vec::new();
        for managed in jobs.values_mut() {
            if is_terminal(&managed.job.state) {
                continue;
            }
            let was_queued = managed.job.state == PhotolabJobState::Queued;
            if managed.job.request_cancel(&managed.cancellation).is_err() {
                continue;
            }
            if was_queued {
                if let Err(error) = managed.job.transition_to(PhotolabJobState::Cancelled) {
                    tracing::error!(job_id = %managed.job.id.0, %error, "failed to cancel queued job");
                }
            }
            self.publish_durable(managed);
            changed.push(managed.job.clone());
        }
        changed
    }

    /// Cancels every active job and waits up to one shared deadline for terminal states.
    ///
    /// Admission remains closed after this call so a project close or replacement can
    /// follow without a new worker racing into the old session. Call
    /// [`Self::resume_admission`] only after a non-shutdown project transition finishes.
    pub async fn drain(&self, deadline: Duration) -> DrainReport {
        self.inner.draining.store(true, Ordering::Release);
        self.cancel_all().await;
        let ids = self
            .inner
            .jobs
            .lock()
            .await
            .values()
            .filter(|managed| managed.worker_active)
            .map(|managed| managed.job.id.clone())
            .collect::<Vec<_>>();
        let cutoff = TokioInstant::now() + deadline;
        let mut terminal = 0;
        let mut timed_out = Vec::new();

        for job_id in ids {
            match timeout_at(cutoff, self.wait_for_worker_stopped(&job_id)).await {
                Ok(Ok(_)) => terminal += 1,
                Ok(Err(error)) => {
                    tracing::error!(job_id = %job_id.0, %error, "job drain waiter failed");
                    timed_out.push(job_id);
                }
                Err(_) => timed_out.push(job_id),
            }
        }

        if !timed_out.is_empty() {
            let diagnostic = format!(
                "The worker did not stop within the bounded drain deadline of {} ms. The project was not marked as cleanly closed.",
                deadline.as_millis()
            );
            let mut jobs = self.inner.jobs.lock().await;
            let mut forced = Vec::with_capacity(timed_out.len());
            for job_id in timed_out {
                let Some(managed) = jobs.get_mut(&job_id.0) else {
                    continue;
                };
                forced.push(job_id);
                if is_terminal(&managed.job.state) {
                    continue;
                }
                managed.job.record_terminal_diagnostic(diagnostic.clone());
                set_failed(managed, "drainTimeout", diagnostic.clone());
                self.publish_durable(managed);
            }
            timed_out = forced;
        }

        DrainReport {
            terminal,
            timed_out,
        }
    }

    /// Reopens admission after a completed project close/create/open transition.
    pub fn resume_admission(&self) {
        self.inner.draining.store(false, Ordering::Release);
    }

    /// Waits asynchronously for a terminal state; useful for shutdown and tests.
    pub async fn wait_for_terminal(
        &self,
        job_id: &PhotolabJobId,
    ) -> Result<PhotolabJob, JobManagerError> {
        let mut updates = {
            let jobs = self.inner.jobs.lock().await;
            jobs.get(&job_id.0)
                .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?
                .updates
                .subscribe()
        };
        loop {
            let job = updates.borrow().clone();
            if is_terminal(&job.state) {
                return Ok(job);
            }
            updates
                .changed()
                .await
                .map_err(|_| JobManagerError::UpdateChannelClosed(job_id.clone()))?;
        }
    }

    async fn wait_for_worker_stopped(&self, job_id: &PhotolabJobId) -> Result<(), JobManagerError> {
        let mut updates = {
            let jobs = self.inner.jobs.lock().await;
            jobs.get(&job_id.0)
                .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?
                .worker_updates
                .subscribe()
        };
        loop {
            if !*updates.borrow() {
                return Ok(());
            }
            updates
                .changed()
                .await
                .map_err(|_| JobManagerError::UpdateChannelClosed(job_id.clone()))?;
        }
    }

    async fn supervise_inner<F>(
        &self,
        job_id: PhotolabJobId,
        job_kind: PhotolabJobKind,
        config_hash: ObjectHash,
        input_hash: ObjectHash,
        cancellation: CancellationToken,
        work: F,
    ) where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        let Ok(permit) = self.inner.concurrency.clone().acquire_owned().await else {
            self.fail_job(&job_id, "schedulerClosed", "job scheduler closed")
                .await;
            return;
        };
        let compute_lease = match acquire_compute_lease(&cancellation).await {
            Ok(Some(lease)) => lease,
            Ok(None) => return,
            Err(error) => {
                self.fail_job(
                    &job_id,
                    "computeLease",
                    &format!("failed to acquire the cross-process compute lease: {error}"),
                )
                .await;
                return;
            }
        };
        if !self.mark_running(&job_id).await {
            return;
        }

        let context = JobWorkerContext {
            cancellation,
            progress: ProgressSink {
                manager: self.clone(),
                job_id: job_id.clone(),
                stage_base: 0,
                stage_count: None,
            },
            checkpoints: CheckpointSink {
                manager: self.clone(),
                job_id: job_id.clone(),
                job_kind,
                config_hash,
                input_hash,
                stage_base: 0,
                stage_count: None,
            },
            diagnostics: JobDiagnosticSink {
                manager: self.clone(),
                job_id: job_id.clone(),
            },
            memory: JobMemorySink {
                manager: self.clone(),
                job_id: job_id.clone(),
            },
        };
        let outcome = tokio::task::spawn_blocking(move || work(context)).await;
        self.finish_worker(&job_id, outcome, permit).await;
        drop(compute_lease);
    }

    async fn mark_worker_inactive(&self, job_id: &PhotolabJobId) {
        let mut jobs = self.inner.jobs.lock().await;
        let Some(managed) = jobs.get_mut(&job_id.0) else {
            return;
        };
        managed.worker_active = false;
        managed.worker_updates.send_replace(false);
        if !is_terminal(&managed.job.state) && managed.cancellation.is_cancel_requested() {
            transition_or_fail(managed, PhotolabJobState::Cancelled);
            self.publish_durable(managed);
        }
    }

    async fn mark_running(&self, job_id: &PhotolabJobId) -> bool {
        let mut jobs = self.inner.jobs.lock().await;
        let Some(managed) = jobs.get_mut(&job_id.0) else {
            return false;
        };
        if is_terminal(&managed.job.state) {
            return false;
        }
        if let Err(error) = managed.job.transition_to(PhotolabJobState::Running) {
            set_failed(managed, "invalidState", error.to_string());
            self.publish_durable(managed);
            return false;
        }
        self.publish_durable(managed);
        true
    }

    async fn finish_worker(
        &self,
        job_id: &PhotolabJobId,
        outcome: Result<JobWorkerResult, tokio::task::JoinError>,
        _permit: OwnedSemaphorePermit,
    ) {
        let mut jobs = self.inner.jobs.lock().await;
        let Some(managed) = jobs.get_mut(&job_id.0) else {
            return;
        };
        if is_terminal(&managed.job.state) {
            return;
        }
        match outcome {
            Ok(Ok(())) if managed.job.state == PhotolabJobState::CancelRequested => {
                transition_or_fail(managed, PhotolabJobState::Cancelled);
            }
            Ok(Ok(())) => {
                complete_progress(managed);
                transition_or_fail(managed, PhotolabJobState::Completed);
            }
            Ok(Err(JobWorkerError::Cancelled)) if managed.cancellation.is_cancel_requested() => {
                if managed.job.state != PhotolabJobState::CancelRequested {
                    if let Err(error) = managed.job.request_cancel(&managed.cancellation) {
                        tracing::error!(job_id = %managed.job.id.0, %error, "failed to record worker cancellation request");
                    }
                }
                transition_or_fail(managed, PhotolabJobState::Cancelled);
            }
            Ok(Err(JobWorkerError::Cancelled)) => set_failed(
                managed,
                "unexpectedCancellation",
                "worker returned cancellation without a manager request".into(),
            ),
            Ok(Err(JobWorkerError::Failed { code, message })) => {
                set_failed(managed, &code, message);
            }
            Err(error) => set_failed(managed, "workerJoin", error.to_string()),
        }
        self.publish_durable(managed);
    }

    async fn fail_job(&self, job_id: &PhotolabJobId, code: &str, message: &str) {
        let mut jobs = self.inner.jobs.lock().await;
        if let Some(managed) = jobs.get_mut(&job_id.0) {
            set_failed(managed, code, message.into());
            self.publish_durable(managed);
        }
    }

    async fn update_progress(
        &self,
        job_id: &PhotolabJobId,
        progress: JobProgress,
    ) -> Result<PhotolabJob, JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        let stage_changed = managed.job.progress.stage.index != progress.stage.index;
        managed.job.update_progress(progress)?;
        if stage_changed || managed.last_history_persisted_at.elapsed() >= Duration::from_secs(1) {
            self.publish_durable(managed);
        } else {
            publish(managed);
        }
        Ok(managed.job.clone())
    }

    async fn record_checkpoint(
        &self,
        job_id: &PhotolabJobId,
        checkpoint: &CheckpointDescriptor,
    ) -> Result<PhotolabJob, JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        managed.job.record_checkpoint(checkpoint)?;
        self.publish_durable(managed);
        Ok(managed.job.clone())
    }

    async fn record_terminal_diagnostic(
        &self,
        job_id: &PhotolabJobId,
        diagnostic: String,
    ) -> Result<(), JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        managed.job.record_terminal_diagnostic(diagnostic);
        self.publish_durable(managed);
        Ok(())
    }

    async fn record_stage_memory(
        &self,
        job_id: &PhotolabJobId,
        stage: PhotolabStageMemory,
    ) -> Result<(), JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        managed.job.record_stage_memory(stage);
        self.publish_durable(managed);
        Ok(())
    }

    async fn record_matching_replan(
        &self,
        job_id: &PhotolabJobId,
        replan: PhotolabMatchingMemoryReplan,
        keypoint_cap: u32,
        degradation: Option<PhotolabMemoryDegradation>,
    ) -> Result<(), JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        if let Some(degradation) = degradation {
            if !managed.job.memory.degradations.contains(&degradation) {
                managed.job.memory.degradations.push(degradation);
            }
        }
        if let Some(stage) = managed
            .job
            .memory
            .stages
            .iter_mut()
            .find(|stage| stage.stage == "Match ALIKED with LightGlue")
        {
            stage.workers = replan.matching_workers;
            let parameters = stage
                .parameters
                .as_object_mut()
                .expect("alignment matcher parameters are an object");
            parameters.insert(
                "actualMaxKeypoints".into(),
                replan.actual_max_keypoints.into(),
            );
            parameters.insert("keypoints".into(), keypoint_cap.into());
            parameters.insert(
                "matchingUnitBytes".into(),
                replan.matching_unit_bytes.into(),
            );
            parameters.insert(
                "modelBytes".into(),
                replan
                    .matching_unit_bytes
                    .saturating_mul(u64::from(replan.matching_workers))
                    .into(),
            );
            parameters.insert(
                "sequentialPairBatches".into(),
                (replan.matching_workers == 1).into(),
            );
        }
        managed.job.memory.matching_replanned = Some(replan);
        self.publish_durable(managed);
        Ok(())
    }

    async fn record_worker_memory_limit_hit(
        &self,
        job_id: &PhotolabJobId,
        stage: String,
        limit_bytes: u64,
    ) -> Result<(), JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        let degradation = PhotolabMemoryDegradation::WorkerMemoryLimitHit { stage, limit_bytes };
        if !managed.job.memory.degradations.contains(&degradation) {
            managed.job.memory.degradations.push(degradation);
            self.publish_durable(managed);
        }
        Ok(())
    }

    async fn record_matching_threads_halved(
        &self,
        job_id: &PhotolabJobId,
        from: u16,
        to: u16,
        observed_peak_bytes: u64,
    ) -> Result<(), JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        let degradation = PhotolabMemoryDegradation::MatchingThreadsHalved {
            from,
            to,
            observed_peak_bytes,
        };
        if !managed.job.memory.degradations.contains(&degradation) {
            managed.job.memory.degradations.push(degradation);
        }
        if let Some(stage) = managed
            .job
            .memory
            .stages
            .iter_mut()
            .find(|stage| stage.stage == "Match ALIKED with LightGlue")
        {
            stage.workers = to;
            if let Some(parameters) = stage.parameters.as_object_mut() {
                parameters.insert("sequentialPairBatches".into(), (to == 1).into());
            }
        }
        self.publish_durable(managed);
        Ok(())
    }

    async fn record_matching_threads(
        &self,
        job_id: &PhotolabJobId,
        stage_name: String,
        threads: u16,
    ) -> Result<(), JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        if let Some(stage) = managed
            .job
            .memory
            .stages
            .iter_mut()
            .find(|stage| stage.stage == stage_name)
        {
            stage.workers = threads;
            if let Some(parameters) = stage.parameters.as_object_mut() {
                parameters.insert("sequentialPairBatches".into(), (threads == 1).into());
            }
            self.publish_durable(managed);
        }
        Ok(())
    }

    async fn record_unbounded_memory_stage(
        &self,
        job_id: &PhotolabJobId,
        stage: String,
    ) -> Result<(), JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        let observation = PhotolabMemoryObservation::UnboundedStage {
            stage,
            budget_bytes: managed.job.memory.envelope_bytes,
        };
        if !managed.job.memory.observations.contains(&observation) {
            managed.job.memory.observations.push(observation);
            self.publish_durable(managed);
        }
        Ok(())
    }

    fn current_history_scope(&self) -> Result<Option<JobHistoryScope>, JobManagerError> {
        self.inner
            .history
            .as_ref()
            .map_or_else(|| Ok(None), |history| history.current_scope())
            .map_err(JobManagerError::HistoryPersistence)
    }

    fn publish_durable(&self, managed: &mut ManagedJob) {
        let (Some(history), Some(scope)) = (&self.inner.history, &managed.history_scope) else {
            publish(managed);
            return;
        };
        match history.persist(scope, &managed.job, managed.frozen_request.as_ref()) {
            Ok(()) => {
                managed.history_dirty = false;
                managed.last_history_persisted_at = Instant::now();
            }
            Err(error) => {
                managed.history_dirty = true;
                tracing::error!(
                    job_id = managed.job.id.0,
                    project_id = scope.project_id,
                    %error,
                    "failed to persist PhotoLab job lifecycle snapshot"
                );
            }
        }
        publish(managed);
    }
}

fn retry_history_persistence(
    history: Option<&Arc<dyn JobHistoryPersistence>>,
    managed: &mut ManagedJob,
) {
    if !managed.history_dirty {
        return;
    }
    let (Some(history), Some(scope)) = (history, &managed.history_scope) else {
        return;
    };
    if let Err(error) = history.persist(scope, &managed.job, managed.frozen_request.as_ref()) {
        tracing::error!(
            job_id = managed.job.id.0,
            project_id = scope.project_id,
            %error,
            "failed to retry PhotoLab job lifecycle persistence"
        );
    } else {
        managed.history_dirty = false;
        managed.last_history_persisted_at = Instant::now();
    }
}

async fn acquire_compute_lease(cancellation: &CancellationToken) -> io::Result<Option<File>> {
    let path = compute_lease_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    loop {
        if cancellation.is_cancel_requested() {
            return Ok(None);
        }
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(Some(file)),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                sleep(Duration::from_millis(100)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

fn compute_lease_path() -> PathBuf {
    if let Some(path) = std::env::var_os("HIMMELCAD_COMPUTE_LEASE_PATH") {
        return PathBuf::from(path);
    }
    // Test processes must never queue behind a real sidecar's machine-wide
    // lease: on 2026-09-02 a running golden e2e sidecar held the shared lock and
    // every bounded cancellation timing test timed out before its worker could
    // spawn. `cfg(test)` covers the library's own tests; the binary's test
    // harness links the non-test library, so also recognise the runtime
    // environment cargo sets for `cargo test`/`cargo run` processes (a packaged
    // sidecar launched by Electron never carries `CARGO_MANIFEST_DIR`).
    if cfg!(test) || std::env::var_os("CARGO_MANIFEST_DIR").is_some() {
        return std::env::temp_dir().join(format!(
            "himmelcad-photolab-compute-test-{}.lock",
            std::process::id()
        ));
    }
    std::env::temp_dir().join("himmelcad-photolab-compute.lock")
}

fn publish(managed: &ManagedJob) {
    managed.updates.send_replace(managed.job.clone());
}

#[doc(hidden)]
pub fn is_terminal(state: &PhotolabJobState) -> bool {
    matches!(
        state,
        PhotolabJobState::Cancelled | PhotolabJobState::Completed | PhotolabJobState::Failed { .. }
    )
}

fn transition_or_fail(managed: &mut ManagedJob, state: PhotolabJobState) {
    if let Err(error) = managed.job.transition_to(state) {
        set_failed(managed, "invalidState", error.to_string());
    }
}

fn complete_progress(managed: &mut ManagedJob) {
    managed.job.progress.stage.index = managed.job.progress.stage.stage_count.saturating_sub(1);
    if let Some(total) = managed.job.progress.metrics.total_units {
        managed.job.progress.metrics.completed_units = total;
    }
    if let Some(total) = managed.job.progress.metrics.total_bytes {
        managed.job.progress.metrics.completed_bytes = total;
    }
}

fn set_failed(managed: &mut ManagedJob, code: &str, message: String) {
    let failed = PhotolabJobState::Failed {
        code: code.into(),
        message,
    };
    if let Err(error) = managed.job.transition_to(failed) {
        tracing::error!(job_id = %managed.job.id.0, failure_code = code, %error, "failed to record terminal job failure");
    }
}

#[doc(hidden)]
pub fn system_available_bytes(path: &Path) -> Result<u64, String> {
    let mut probe = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("failed to resolve {}: {error}", path.display()))?
            .join(path)
    };
    loop {
        match probe.try_exists() {
            Ok(true) => break,
            Ok(false) => {
                if !probe.pop() {
                    return Err(format!(
                        "no existing ancestor found for free-space probe at {}",
                        path.display()
                    ));
                }
            }
            Err(error) => {
                return Err(format!(
                    "failed to resolve an existing ancestor for {}: {error}",
                    path.display()
                ));
            }
        }
    }
    fs2::available_space(&probe).map_err(|error| {
        format!(
            "failed to inspect free space for {} via {}: {error}",
            path.display(),
            probe.display()
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictingJobState {
    Queued,
    Running,
}

/// Scheduling and authoritative-state failures returned to RPC integration.
#[derive(Debug, PartialEq, Eq)]
pub enum JobManagerError {
    InvalidConfig(&'static str),
    InvalidFrozenRequest(String),
    NoTokioRuntime,
    SchedulerDraining,
    DuplicateJobId(PhotolabJobId),
    QueueFull {
        max_concurrency: usize,
        max_queued: usize,
    },
    ConflictingTarget {
        running_job_id: PhotolabJobId,
        target: PublicationTarget,
        state: ConflictingJobState,
    },
    InsufficientDisk {
        required_bytes: u64,
        available_bytes: u64,
        path: PathBuf,
        job_kind: Option<PhotolabJobKind>,
        scratch_bytes: Option<u64>,
    },
    InsufficientMemory {
        predicted_bytes: u64,
        available_bytes: u64,
    },
    DiskPreflight(String),
    JobNotFound(PhotolabJobId),
    UpdateChannelClosed(PhotolabJobId),
    HistoryPersistence(String),
    Core(JobError),
}

impl From<JobError> for JobManagerError {
    fn from(error: JobError) -> Self {
        Self::Core(error)
    }
}

impl std::fmt::Display for JobManagerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfig(message) => {
                write!(formatter, "invalid job manager configuration: {message}")
            }
            Self::InvalidFrozenRequest(message) => {
                write!(formatter, "invalid frozen job request: {message}")
            }
            Self::NoTokioRuntime => formatter.write_str(
                "JobManager must be created inside a Tokio runtime or with an explicit handle",
            ),
            Self::SchedulerDraining => {
                formatter.write_str("job scheduler is draining for a project transition")
            }
            Self::DuplicateJobId(id) => write!(formatter, "job {id:?} already exists"),
            Self::QueueFull {
                max_concurrency,
                max_queued,
            } => write!(
                formatter,
                "job queue is full ({max_concurrency} running, {max_queued} queued)"
            ),
            Self::ConflictingTarget {
                running_job_id,
                target,
                state,
            } => {
                let (publication, target_name) = target.description();
                let state = match state {
                    ConflictingJobState::Queued => "queued",
                    ConflictingJobState::Running => "running",
                };
                write!(
                    formatter,
                    "{} for this {target_name} is already {state} (job {}). Wait for it or cancel it.",
                    sentence_start(publication),
                    running_job_id.0
                )
            }
            Self::InsufficientDisk {
                required_bytes,
                available_bytes,
                path,
                job_kind,
                scratch_bytes,
            } => match (job_kind, scratch_bytes) {
                (Some(PhotolabJobKind::BuildDem), Some(scratch_bytes)) => write!(
                    formatter,
                    "Not enough disk for the DEM: needs about {} of scratch, {} free",
                    format_decimal_gigabytes(*scratch_bytes),
                    format_decimal_gigabytes(*available_bytes)
                ),
                (Some(PhotolabJobKind::BuildOrthomosaic), _) => write!(
                    formatter,
                    "Not enough disk for the orthomosaic: about {} needed, {} free.",
                    format_bytes(*required_bytes),
                    format_bytes(*available_bytes)
                ),
                _ => write!(
                    formatter,
                    "Not enough free space on {}: about {} needed, {} free.",
                    path.display(),
                    format_bytes(*required_bytes),
                    format_bytes(*available_bytes)
                ),
            },
            Self::InsufficientMemory {
                predicted_bytes,
                available_bytes,
            } => write!(
                formatter,
                "Not enough memory: about {} needed for the smallest safe unit, {} available.",
                format_bytes(*predicted_bytes),
                format_bytes(*available_bytes)
            ),
            Self::DiskPreflight(message) => write!(formatter, "disk preflight failed: {message}"),
            Self::JobNotFound(id) => write!(formatter, "job {id:?} was not found"),
            Self::UpdateChannelClosed(id) => {
                write!(formatter, "job {id:?} update channel closed unexpectedly")
            }
            Self::HistoryPersistence(message) => {
                write!(formatter, "job history persistence failed: {message}")
            }
            Self::Core(error) => error.fmt(formatter),
        }
    }
}

fn sentence_start(value: &'static str) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => String::new(),
    }
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: &[(&str, u64)] = &[("TB", GIB * 1024), ("GB", GIB), ("MB", MIB), ("KB", 1024)];
    for (label, unit) in UNITS {
        if bytes >= *unit {
            if bytes % *unit == 0 {
                return format!("{} {label}", bytes / *unit);
            }
            return format!("{:.1} {label}", bytes as f64 / *unit as f64);
        }
    }
    format!("{bytes} bytes")
}

fn format_decimal_gigabytes(bytes: u64) -> String {
    const DECIMAL_GB: u64 = 1_000_000_000;
    format!("{:.1} GB", bytes as f64 / DECIMAL_GB as f64)
}

impl std::error::Error for JobManagerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Core(error) => Some(error),
            _ => None,
        }
    }
}
