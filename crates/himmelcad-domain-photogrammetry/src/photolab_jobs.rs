//! Runtime-neutral Photolab job, cancellation and checkpoint contracts.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use himmelcad_model::hash::ObjectHash;

#[cfg(test)]
use himmelcad_process::jobs::{CancelRequested, CheckpointError, CheckpointId, ProgressMetrics};
use himmelcad_process::jobs::{CancellationToken, ProgressError};
use himmelcad_process::jobs::{
    CheckpointDescriptor as GenericCheckpointDescriptor, JobProgress as GenericJobProgress,
    JobStage, NewPendingCheckpoint as GenericNewPendingCheckpoint,
    ResumePoint as GenericResumePoint, ResumeValidationContext as GenericResumeValidationContext,
    ResumeValidationError as GenericResumeValidationError,
};

/// Stable identifier of a Photolab job.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PhotolabJobId(pub String);

/// Product-level operation represented by a job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PhotolabJobKind {
    AnalyzeImageQuality,
    AlignPhotos,
    OptimizeAlignment,
    MergeAlignments,
    BuildDepthMaps,
    BuildDensePointCloud,
    BuildDem,
    BuildOrthomosaic,
    BuildMesh,
    BuildGaussianSplat,
    ExportProduct,
    Batch,
    ArchiveSave,
    ImageInspection,
    ImageCommit,
    ImageMask,
    GcpOperation,
}

/// Machine-readable phase within a job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PhotolabStageKind {
    Preparing,
    ImageAnalysis,
    CandidatePairSelection,
    FeatureExtraction,
    FeatureMatching,
    GeometricVerification,
    SparseReconstruction,
    BundleAdjustment,
    DepthEstimation,
    DenseFusion,
    Rasterization,
    Meshing,
    SplatOptimization,
    Finalizing,
}

/// Position of a stage in the immutable PhotoLab stage plan.
pub type PhotolabStage = JobStage<PhotolabStageKind>;

/// Persistable progress point within a PhotoLab job stage plan.
pub type JobProgress = GenericJobProgress<PhotolabStageKind>;

/// Values captured after writing a temporary PhotoLab checkpoint payload.
pub type NewPendingCheckpoint =
    GenericNewPendingCheckpoint<PhotolabJobId, PhotolabJobKind, PhotolabStageKind>;

/// Persistable PhotoLab checkpoint metadata.
pub type CheckpointDescriptor =
    GenericCheckpointDescriptor<PhotolabJobId, PhotolabJobKind, PhotolabStageKind>;

/// Immutable identity of PhotoLab work that a checkpoint may resume.
pub type ResumeValidationContext = GenericResumeValidationContext<PhotolabJobKind>;

/// Validated reference handed to a resuming PhotoLab worker.
pub type ResumePoint = GenericResumePoint<PhotolabJobId, PhotolabStageKind>;

/// PhotoLab checkpoint resume rejection reasons.
pub type ResumeValidationError = GenericResumeValidationError<PhotolabJobKind>;

/// Persisted lifecycle state. A request is distinct from final cancellation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PhotolabJobState {
    Queued,
    Running,
    PauseRequested,
    Paused,
    CancelRequested,
    Cancelled,
    Completed,
    Failed { code: String, message: String },
}

impl PhotolabJobState {
    fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Cancelled | Self::Completed | Self::Failed { .. }
        )
    }

    fn permits_progress(&self) -> bool {
        matches!(
            self,
            Self::Running | Self::PauseRequested | Self::CancelRequested
        )
    }

    fn permits_transition_to(&self, next: &Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Queued | Self::Paused,
                Self::Running | Self::Failed { .. }
            ) | (
                Self::Running,
                Self::PauseRequested | Self::Completed | Self::Failed { .. }
            ) | (
                Self::PauseRequested,
                Self::Running | Self::Paused | Self::Failed { .. }
            ) | (Self::CancelRequested, Self::Cancelled | Self::Failed { .. })
        )
    }
}

/// Serializable values required to create a job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPhotolabJob {
    pub id: PhotolabJobId,
    pub kind: PhotolabJobKind,
    pub config_hash: ObjectHash,
    pub input_hash: ObjectHash,
    pub progress: JobProgress,
}

/// A quality-affecting memory fallback frozen at admission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PhotolabMemoryDegradation {
    ExtractionEdgeReduced {
        from: u32,
        to: u32,
        budget_bytes: u64,
    },
    MatchingKeypointsCapped {
        from: u32,
        to: u32,
    },
    MatchingThreadsHalved {
        from: u16,
        to: u16,
        observed_peak_bytes: u64,
    },
    WorkerMemoryLimitHit {
        stage: String,
        limit_bytes: u64,
    },
}

/// Throughput-only memory choices frozen at admission without changing requested quality.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PhotolabMemoryTimeFirstChoice {
    ExtractionTiled { tiles: u32, overlap_px: u32 },
}

/// Warning-level memory evidence for a stage whose model is not calibrated yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PhotolabMemoryObservation {
    UnboundedStage { stage: String, budget_bytes: u64 },
}

/// Measured or planned memory evidence for one stage.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotolabStageMemory {
    pub stage: String,
    pub peak_rss_bytes: u64,
    pub workers: u16,
    #[serde(default)]
    pub parameters: serde_json::Value,
}

/// Matching choices recomputed from the feature database immediately before launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotolabMatchingMemoryReplan {
    pub actual_max_keypoints: u32,
    pub matching_workers: u16,
    pub matching_unit_bytes: u64,
}

/// Admission-time model and hard resident bound for one raster preparation worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotolabRasterPreparationStageMemory {
    pub model_bytes: u64,
    pub resident_limit_bytes: u64,
}

/// Dense-point-derived memory contract for DEM preparation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotolabRasterPreparationMemory {
    pub point_count: u64,
    pub ogr2ogr: PhotolabRasterPreparationStageMemory,
    pub gdal_grid: PhotolabRasterPreparationStageMemory,
}

/// Per-machine envelope and the choices made to stay inside it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotolabJobMemory {
    pub envelope_bytes: u64,
    #[serde(default)]
    pub stages: Vec<PhotolabStageMemory>,
    #[serde(default)]
    pub time_first_choices: Vec<PhotolabMemoryTimeFirstChoice>,
    #[serde(default)]
    pub degradations: Vec<PhotolabMemoryDegradation>,
    #[serde(default)]
    pub observations: Vec<PhotolabMemoryObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matching_replanned: Option<PhotolabMatchingMemoryReplan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raster_preparation: Option<PhotolabRasterPreparationMemory>,
}

/// Admission-time disk evidence for jobs with measured scratch requirements.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotolabJobDiskEstimate {
    pub scratch_bytes: u64,
    pub output_bytes: u64,
    pub available_bytes: u64,
    pub volume: String,
}

/// One executable resolved and validated before a job becomes visible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotolabWorkerTool {
    pub tool: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Authoritative, persistable job record. Runtime cancellation handles are separate.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotolabJob {
    pub schema_version: u32,
    pub id: PhotolabJobId,
    pub kind: PhotolabJobKind,
    pub config_hash: ObjectHash,
    pub input_hash: ObjectHash,
    pub state: PhotolabJobState,
    pub progress: JobProgress,
    #[serde(default)]
    pub created_at_unix_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_checkpoint_sequence: Option<u64>,
    /// Non-fatal terminal-path detail that must survive in durable job history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_diagnostic: Option<String>,
    /// Per-machine memory contract frozen before work starts and enriched with measured peaks.
    #[serde(default)]
    pub memory: PhotolabJobMemory,
    /// Disk estimate frozen before the worker becomes visible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_estimate: Option<PhotolabJobDiskEstimate>,
    /// Worker executables resolved at admission for reproducible evidence.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub toolchain: Vec<PhotolabWorkerTool>,
}

impl Serialize for PhotolabJob {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        let mut record = serializer.serialize_struct("PhotolabJob", 17)?;
        record.serialize_field("schemaVersion", &self.schema_version)?;
        record.serialize_field("id", &self.id)?;
        record.serialize_field("kind", &self.kind)?;
        let origin = if matches!(
            self.kind,
            PhotolabJobKind::ArchiveSave
                | PhotolabJobKind::ImageInspection
                | PhotolabJobKind::ImageCommit
                | PhotolabJobKind::ImageMask
                | PhotolabJobKind::GcpOperation
        ) {
            "sideOperation"
        } else {
            "job"
        };
        record.serialize_field("origin", origin)?;
        record.serialize_field("configHash", &self.config_hash)?;
        record.serialize_field("inputHash", &self.input_hash)?;
        record.serialize_field("state", &self.state)?;
        record.serialize_field("progress", &self.progress)?;
        record.serialize_field("createdAtUnixMs", &self.created_at_unix_ms)?;
        if let Some(value) = self.started_at_unix_ms {
            record.serialize_field("startedAtUnixMs", &value)?;
        }
        if let Some(value) = self.finished_at_unix_ms {
            record.serialize_field("finishedAtUnixMs", &value)?;
        }
        if let Some(value) = self.last_checkpoint_sequence {
            record.serialize_field("lastCheckpointSequence", &value)?;
        }
        if let Some(value) = &self.terminal_diagnostic {
            record.serialize_field("terminalDiagnostic", value)?;
        }
        record.serialize_field("memory", &self.memory)?;
        if let Some(value) = &self.disk_estimate {
            record.serialize_field("diskEstimate", value)?;
        }
        if !self.toolchain.is_empty() {
            record.serialize_field("toolchain", &self.toolchain)?;
        }
        record.end()
    }
}

impl PhotolabJob {
    /// Creates a queued job after validating hashes and initial progress.
    pub fn new(request: NewPhotolabJob) -> Result<Self, JobError> {
        validate_job_hash("config", &request.config_hash)?;
        validate_job_hash("input", &request.input_hash)?;
        request.progress.validate()?;
        Ok(Self {
            schema_version: 1,
            id: request.id,
            kind: request.kind,
            config_hash: request.config_hash,
            input_hash: request.input_hash,
            state: PhotolabJobState::Queued,
            progress: request.progress,
            created_at_unix_ms: unix_time_ms(),
            started_at_unix_ms: None,
            finished_at_unix_ms: None,
            last_checkpoint_sequence: None,
            terminal_diagnostic: None,
            memory: PhotolabJobMemory::default(),
            disk_estimate: None,
            toolchain: Vec::new(),
        })
    }

    /// Freezes the envelope and planned choices before the record becomes visible.
    pub fn set_memory_plan(&mut self, memory: PhotolabJobMemory) {
        self.memory = memory;
    }

    /// Freezes admission-time disk evidence before the record becomes visible.
    pub fn set_disk_estimate(&mut self, disk_estimate: PhotolabJobDiskEstimate) {
        self.disk_estimate = Some(disk_estimate);
    }

    /// Freezes the resolved worker executable inventory before visibility.
    pub fn set_toolchain(&mut self, toolchain: Vec<PhotolabWorkerTool>) {
        self.toolchain = toolchain;
    }

    /// Merges a sampled peak into the durable stage record.
    pub fn record_stage_memory(&mut self, mut stage: PhotolabStageMemory) {
        if let Some(existing) = self
            .memory
            .stages
            .iter_mut()
            .find(|existing| existing.stage == stage.stage)
        {
            existing.peak_rss_bytes = existing.peak_rss_bytes.max(stage.peak_rss_bytes);
            existing.workers = existing.workers.max(stage.workers);
            if let (Some(existing), Some(sampled)) = (
                existing.parameters.as_object_mut(),
                stage.parameters.as_object_mut(),
            ) {
                existing.extend(std::mem::take(sampled));
            } else if !stage.parameters.is_null() {
                existing.parameters = std::mem::take(&mut stage.parameters);
            }
        } else {
            self.memory.stages.push(stage);
        }
    }

    /// Retains a non-empty diagnostic without changing lifecycle state semantics.
    pub fn record_terminal_diagnostic(&mut self, diagnostic: impl Into<String>) {
        let diagnostic = diagnostic.into();
        if !diagnostic.trim().is_empty() {
            self.terminal_diagnostic = Some(diagnostic);
        }
    }

    /// Performs a normal lifecycle transition. Cancellation uses `request_cancel`.
    pub fn transition_to(&mut self, next: PhotolabJobState) -> Result<(), JobError> {
        if matches!(next, PhotolabJobState::CancelRequested) {
            return Err(JobError::CancellationRequiresToken);
        }
        if !self.state.permits_transition_to(&next) {
            return Err(JobError::InvalidStateTransition {
                from: self.state.clone(),
                to: next,
            });
        }
        let now = unix_time_ms();
        if matches!(next, PhotolabJobState::Running) && self.started_at_unix_ms.is_none() {
            self.started_at_unix_ms = Some(now);
        }
        if next.is_terminal() {
            self.finished_at_unix_ms = Some(now);
        }
        self.state = next;
        Ok(())
    }

    /// Requests cancellation in persisted state and the shared runtime token.
    pub fn request_cancel(&mut self, token: &CancellationToken) -> Result<bool, JobError> {
        if self.state.is_terminal() {
            return Err(JobError::CannotCancelTerminalState(self.state.clone()));
        }
        let first_request = token.request_cancel();
        self.state = PhotolabJobState::CancelRequested;
        Ok(first_request)
    }

    /// Applies monotone progress while a bounded in-flight unit may still finish.
    pub fn update_progress(&mut self, next: JobProgress) -> Result<(), JobError> {
        if !self.state.permits_progress() {
            return Err(JobError::ProgressNotAllowed(self.state.clone()));
        }
        self.progress.advance_to(next)?;
        Ok(())
    }

    /// Records a committed checkpoint, rejecting stale or foreign descriptors.
    pub fn record_checkpoint(&mut self, checkpoint: &CheckpointDescriptor) -> Result<(), JobError> {
        if checkpoint.job_id != self.id {
            return Err(JobError::ForeignCheckpoint);
        }
        if checkpoint.job_kind != self.kind
            || checkpoint.config_hash != self.config_hash
            || checkpoint.input_hash != self.input_hash
        {
            return Err(JobError::IncompatibleCheckpoint);
        }
        if !checkpoint.is_committed() {
            return Err(JobError::CheckpointNotCommitted);
        }
        if let Some(previous) = self.last_checkpoint_sequence {
            if checkpoint.sequence <= previous {
                return Err(JobError::CheckpointSequenceNotMonotone {
                    previous,
                    next: checkpoint.sequence,
                });
            }
        }
        self.last_checkpoint_sequence = Some(checkpoint.sequence);
        Ok(())
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Job validation and state errors.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum JobError {
    #[error(transparent)]
    Progress(#[from] ProgressError),
    #[error("{field} hash is not a SHA-256 hex digest")]
    InvalidHash { field: &'static str },
    #[error("invalid job state transition from {from:?} to {to:?}")]
    InvalidStateTransition {
        from: PhotolabJobState,
        to: PhotolabJobState,
    },
    #[error("use request_cancel so persisted state and runtime token change together")]
    CancellationRequiresToken,
    #[error("cannot cancel terminal state {0:?}")]
    CannotCancelTerminalState(PhotolabJobState),
    #[error("progress updates are not allowed in state {0:?}")]
    ProgressNotAllowed(PhotolabJobState),
    #[error("checkpoint belongs to a different job")]
    ForeignCheckpoint,
    #[error("checkpoint kind, configuration or input does not match the job")]
    IncompatibleCheckpoint,
    #[error("a pending checkpoint cannot be attached to a job")]
    CheckpointNotCommitted,
    #[error("checkpoint sequence must increase beyond {previous}, got {next}")]
    CheckpointSequenceNotMonotone { previous: u64, next: u64 },
}

fn validate_job_hash(field: &'static str, hash: &ObjectHash) -> Result<(), JobError> {
    if is_sha256_hex(hash.as_str()) {
        Ok(())
    } else {
        Err(JobError::InvalidHash { field })
    }
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use std::thread;

    use super::*;

    fn hash(value: &str) -> ObjectHash {
        ObjectHash::of_bytes(value.as_bytes())
    }

    fn progress(index: u32, metrics: ProgressMetrics) -> JobProgress {
        JobProgress {
            stage: PhotolabStage {
                kind: if index == 0 {
                    PhotolabStageKind::Preparing
                } else {
                    PhotolabStageKind::FeatureExtraction
                },
                index,
                stage_count: 3,
                label: format!("stage-{index}"),
            },
            metrics,
        }
    }

    fn initial_progress() -> JobProgress {
        progress(0, ProgressMetrics::empty())
    }

    fn job() -> PhotolabJob {
        PhotolabJob::new(NewPhotolabJob {
            id: PhotolabJobId("job-1".into()),
            kind: PhotolabJobKind::AlignPhotos,
            config_hash: hash("config"),
            input_hash: hash("inputs"),
            progress: initial_progress(),
        })
        .expect("valid job")
    }

    fn checkpoint(sequence: u64) -> CheckpointDescriptor {
        CheckpointDescriptor::pending(NewPendingCheckpoint {
            checkpoint_id: CheckpointId(format!("checkpoint-{sequence}")),
            job_id: PhotolabJobId("job-1".into()),
            job_kind: PhotolabJobKind::AlignPhotos,
            sequence,
            progress: initial_progress(),
            config_hash: hash("config"),
            input_hash: hash("inputs"),
            temporary_object_key: format!("tmp/checkpoint-{sequence}"),
            expected_payload_hash: hash(&format!("payload-{sequence}")),
        })
        .expect("valid checkpoint")
    }

    #[test]
    fn job_state_and_stage_are_serializable() {
        let mut job = job();
        let token = CancellationToken::new();
        job.request_cancel(&token).expect("cancel request");
        let encoded = serde_json::to_string(&job).expect("serialize");
        let decoded: PhotolabJob = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(decoded, job);
        assert!(encoded.contains("cancelRequested"));
    }

    #[test]
    fn old_job_records_default_the_additive_memory_contract() {
        let encoded = serde_json::to_value(job()).expect("serialize job");
        let mut object = encoded.as_object().expect("job object").clone();
        object.remove("memory");
        object.remove("toolchain");
        let decoded: PhotolabJob =
            serde_json::from_value(serde_json::Value::Object(object)).expect("old job record");
        assert_eq!(decoded.memory, PhotolabJobMemory::default());
        assert_eq!(decoded.disk_estimate, None);
        assert!(decoded.toolchain.is_empty());
    }

    #[test]
    fn memory_plan_and_degradations_round_trip() {
        let mut value = job();
        value.memory = PhotolabJobMemory {
            envelope_bytes: 8 * 1024 * 1024 * 1024,
            stages: vec![PhotolabStageMemory {
                stage: "Extract ALIKED".into(),
                peak_rss_bytes: 7_900_000_000,
                workers: 1,
                parameters: serde_json::json!({ "maxImageSize": 3840 }),
            }],
            time_first_choices: vec![PhotolabMemoryTimeFirstChoice::ExtractionTiled {
                tiles: 4,
                overlap_px: 256,
            }],
            degradations: vec![PhotolabMemoryDegradation::ExtractionEdgeReduced {
                from: 8_192,
                to: 3_840,
                budget_bytes: 8 * 1024 * 1024 * 1024,
            }],
            observations: Vec::new(),
            matching_replanned: Some(PhotolabMatchingMemoryReplan {
                actual_max_keypoints: 24_000,
                matching_workers: 1,
                matching_unit_bytes: 7_180_435_456,
            }),
            raster_preparation: Some(PhotolabRasterPreparationMemory {
                point_count: 45_800_000,
                ogr2ogr: PhotolabRasterPreparationStageMemory {
                    model_bytes: 2_970_635_456,
                    resident_limit_bytes: 9_758_894_320,
                },
                gdal_grid: PhotolabRasterPreparationStageMemory {
                    model_bytes: 3_474_435_456,
                    resident_limit_bytes: 14_304_544_416,
                },
            }),
        };
        value.toolchain = vec![PhotolabWorkerTool {
            tool: "PotreeConverter".into(),
            path: "/runtime/workers/potree/PotreeConverter".into(),
            version: Some("2.1.1".into()),
        }];
        value.disk_estimate = Some(PhotolabJobDiskEstimate {
            scratch_bytes: 10_305_000_000,
            output_bytes: 128 * 1024 * 1024,
            available_bytes: 24 * 1024 * 1024 * 1024,
            volume: "/project/.photolab/raster-inputs/job-1".into(),
        });
        let encoded = serde_json::to_vec(&value).expect("serialize memory plan");
        let decoded: PhotolabJob =
            serde_json::from_slice(&encoded).expect("deserialize memory plan");
        assert_eq!(decoded, value);
    }

    #[test]
    fn progress_is_monotone_and_stage_local_counters_may_reset() {
        let mut value = initial_progress();
        value
            .advance_to(progress(
                0,
                ProgressMetrics {
                    completed_units: 4,
                    total_units: Some(10),
                    completed_bytes: 128,
                    total_bytes: Some(1_024),
                },
            ))
            .expect("first report");
        let previous = value.overall_fraction().expect("known fraction");
        value
            .advance_to(progress(
                0,
                ProgressMetrics {
                    completed_units: 7,
                    total_units: Some(10),
                    completed_bytes: 512,
                    total_bytes: Some(1_024),
                },
            ))
            .expect("monotone report");
        assert!(value.overall_fraction().expect("known fraction") > previous);
        value
            .advance_to(progress(1, ProgressMetrics::empty()))
            .expect("advance stage");
        assert_eq!(value.stage.index, 1);
    }

    #[test]
    fn progress_rejects_regression_total_change_and_overflow() {
        let mut value = progress(
            0,
            ProgressMetrics {
                completed_units: 5,
                total_units: Some(10),
                completed_bytes: 20,
                total_bytes: Some(100),
            },
        );
        let regression = value.advance_to(progress(
            0,
            ProgressMetrics {
                completed_units: 4,
                total_units: Some(10),
                completed_bytes: 20,
                total_bytes: Some(100),
            },
        ));
        assert!(matches!(
            regression,
            Err(ProgressError::CounterRegression { .. })
        ));
        let changed = value.advance_to(progress(
            0,
            ProgressMetrics {
                completed_units: 6,
                total_units: Some(11),
                completed_bytes: 20,
                total_bytes: Some(100),
            },
        ));
        assert!(matches!(changed, Err(ProgressError::TotalChanged { .. })));
        let invalid = progress(
            0,
            ProgressMetrics {
                completed_units: 11,
                total_units: Some(10),
                completed_bytes: 0,
                total_bytes: None,
            },
        );
        assert!(matches!(
            invalid.validate(),
            Err(ProgressError::CompletedExceedsTotal { .. })
        ));
    }

    #[test]
    fn cancellation_token_is_shared_and_idempotent() {
        let token = CancellationToken::new();
        let worker_token = token.clone();
        let worker = thread::spawn(move || {
            while worker_token.check().is_ok() {
                thread::yield_now();
            }
            worker_token.check()
        });
        assert!(token.request_cancel());
        assert!(!token.request_cancel());
        assert_eq!(worker.join().expect("join"), Err(CancelRequested));
    }

    #[test]
    fn cancel_request_precedes_worker_acknowledgement() {
        let mut job = job();
        job.transition_to(PhotolabJobState::Running).expect("start");
        let token = CancellationToken::new();
        job.request_cancel(&token).expect("request cancel");
        assert_eq!(job.state, PhotolabJobState::CancelRequested);
        assert!(matches!(
            job.transition_to(PhotolabJobState::Completed),
            Err(JobError::InvalidStateTransition { .. })
        ));
        job.transition_to(PhotolabJobState::Cancelled)
            .expect("acknowledge");
        assert!(matches!(
            job.request_cancel(&token),
            Err(JobError::CannotCancelTerminalState(_))
        ));
    }

    #[test]
    fn checkpoint_commit_is_one_way_hash_guarded_and_required_for_resume() {
        let mut checkpoint = checkpoint(1);
        let context = ResumeValidationContext {
            job_kind: PhotolabJobKind::AlignPhotos,
            config_hash: hash("config"),
            input_hash: hash("inputs"),
        };
        assert_eq!(
            checkpoint.validate_resume(&context),
            Err(ResumeValidationError::CheckpointNotCommitted)
        );
        assert!(matches!(
            checkpoint.commit(hash("wrong")),
            Err(CheckpointError::PayloadHashMismatch { .. })
        ));
        assert!(!checkpoint.is_committed());
        checkpoint.commit(hash("payload-1")).expect("commit");
        assert!(checkpoint.validate_resume(&context).is_ok());
        assert_eq!(
            checkpoint.commit(hash("payload-1")),
            Err(CheckpointError::AlreadyCommitted)
        );
    }

    #[test]
    fn resume_rejects_changed_config_input_kind_and_schema() {
        let mut checkpoint = checkpoint(1);
        checkpoint.commit(hash("payload-1")).expect("commit");
        let mut context = ResumeValidationContext {
            job_kind: PhotolabJobKind::AlignPhotos,
            config_hash: hash("changed"),
            input_hash: hash("inputs"),
        };
        assert!(matches!(
            checkpoint.validate_resume(&context),
            Err(ResumeValidationError::ConfigHashMismatch { .. })
        ));
        context.config_hash = hash("config");
        context.input_hash = hash("changed");
        assert!(matches!(
            checkpoint.validate_resume(&context),
            Err(ResumeValidationError::InputHashMismatch { .. })
        ));
        context.input_hash = hash("inputs");
        context.job_kind = PhotolabJobKind::BuildDepthMaps;
        assert!(matches!(
            checkpoint.validate_resume(&context),
            Err(ResumeValidationError::JobKindMismatch { .. })
        ));
        checkpoint.schema_version += 1;
        assert!(matches!(
            checkpoint.validate_resume(&context),
            Err(ResumeValidationError::UnsupportedSchema { .. })
        ));
    }

    #[test]
    fn job_records_only_committed_increasing_checkpoints() {
        let mut job = job();
        let mut first = checkpoint(3);
        assert_eq!(
            job.record_checkpoint(&first),
            Err(JobError::CheckpointNotCommitted)
        );
        first.commit(hash("payload-3")).expect("commit");
        job.record_checkpoint(&first).expect("record");
        let mut stale = checkpoint(2);
        stale.commit(hash("payload-2")).expect("commit");
        assert!(matches!(
            job.record_checkpoint(&stale),
            Err(JobError::CheckpointSequenceNotMonotone { .. })
        ));
    }

    #[test]
    fn committed_checkpoint_serialization_drops_temporary_key() {
        let mut checkpoint = checkpoint(1);
        checkpoint.commit(hash("payload-1")).expect("commit");
        let encoded = serde_json::to_string(&checkpoint).expect("serialize");
        let decoded: CheckpointDescriptor = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(decoded, checkpoint);
        assert!(encoded.contains("committed"));
        assert!(!encoded.contains("temporaryObjectKey"));
    }
}
