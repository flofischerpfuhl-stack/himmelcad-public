//! Runtime-neutral Photolab job, cancellation and checkpoint contracts.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::hash::ObjectHash;

/// Checkpoint schema understood by this core.
pub const CHECKPOINT_SCHEMA_VERSION: u32 = 1;

/// Stable identifier of a Photolab job.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PhotolabJobId(pub String);

/// Stable identifier of a checkpoint.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CheckpointId(pub String);

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

/// Position of a stage in the immutable stage plan of a job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotolabStage {
    pub kind: PhotolabStageKind,
    pub index: u32,
    pub stage_count: u32,
    pub label: String,
}

impl PhotolabStage {
    fn validate(&self) -> Result<(), ProgressError> {
        if self.stage_count == 0 || self.index >= self.stage_count {
            return Err(ProgressError::InvalidStagePosition {
                index: self.index,
                stage_count: self.stage_count,
            });
        }
        if self.label.trim().is_empty() {
            return Err(ProgressError::EmptyStageLabel);
        }
        Ok(())
    }
}

/// Generic monotone counters reported by a bounded worker operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressMetrics {
    pub completed_units: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_units: Option<u64>,
    pub completed_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
}

impl ProgressMetrics {
    /// Empty progress for a stage whose totals are not known yet.
    #[must_use]
    pub const fn empty() -> Self {
        Self {
            completed_units: 0,
            total_units: None,
            completed_bytes: 0,
            total_bytes: None,
        }
    }

    fn validate(&self) -> Result<(), ProgressError> {
        validate_counter("units", self.completed_units, self.total_units)?;
        validate_counter("bytes", self.completed_bytes, self.total_bytes)
    }

    fn validate_successor(&self, next: &Self) -> Result<(), ProgressError> {
        next.validate()?;
        validate_monotone_counter(
            "units",
            self.completed_units,
            self.total_units,
            next.completed_units,
            next.total_units,
        )?;
        validate_monotone_counter(
            "bytes",
            self.completed_bytes,
            self.total_bytes,
            next.completed_bytes,
            next.total_bytes,
        )
    }

    /// Fraction completed within this stage when a non-zero unit total is known.
    /// Exact integer counters remain authoritative; this ratio is display-only.
    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub fn unit_fraction(&self) -> Option<f64> {
        self.total_units
            .filter(|total| *total > 0)
            .map(|total| self.completed_units as f64 / total as f64)
    }
}

fn validate_counter(
    metric: &'static str,
    completed: u64,
    total: Option<u64>,
) -> Result<(), ProgressError> {
    if let Some(total) = total {
        if completed > total {
            return Err(ProgressError::CompletedExceedsTotal {
                metric,
                completed,
                total,
            });
        }
    }
    Ok(())
}

fn validate_monotone_counter(
    metric: &'static str,
    previous_completed: u64,
    previous_total: Option<u64>,
    completed: u64,
    total: Option<u64>,
) -> Result<(), ProgressError> {
    if completed < previous_completed {
        return Err(ProgressError::CounterRegression {
            metric,
            previous: previous_completed,
            next: completed,
        });
    }
    if let Some(previous) = previous_total {
        if total != Some(previous) {
            return Err(ProgressError::TotalChanged {
                metric,
                previous,
                next: total,
            });
        }
    }
    Ok(())
}

/// Persistable progress point within a job stage plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub stage: PhotolabStage,
    pub metrics: ProgressMetrics,
}

impl JobProgress {
    /// Validates stage identity and metric bounds.
    pub fn validate(&self) -> Result<(), ProgressError> {
        self.stage.validate()?;
        self.metrics.validate()
    }

    /// Advances in place while preventing stage and counter regressions.
    pub fn advance_to(&mut self, next: Self) -> Result<(), ProgressError> {
        next.validate()?;
        if next.stage.stage_count != self.stage.stage_count {
            return Err(ProgressError::StageCountChanged {
                previous: self.stage.stage_count,
                next: next.stage.stage_count,
            });
        }
        if next.stage.index < self.stage.index {
            return Err(ProgressError::StageRegression {
                previous: self.stage.index,
                next: next.stage.index,
            });
        }
        if next.stage.index == self.stage.index {
            if next.stage.kind != self.stage.kind || next.stage.label != self.stage.label {
                return Err(ProgressError::StageIdentityChanged);
            }
            self.metrics.validate_successor(&next.metrics)?;
        }
        *self = next;
        Ok(())
    }

    /// Overall fraction when a non-zero stage unit total is known.
    #[must_use]
    pub fn overall_fraction(&self) -> Option<f64> {
        self.metrics.unit_fraction().map(|stage_fraction| {
            (f64::from(self.stage.index) + stage_fraction) / f64::from(self.stage.stage_count)
        })
    }
}

/// Validation failures for progress emitted by workers.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProgressError {
    #[error("stage index {index} is outside a plan containing {stage_count} stages")]
    InvalidStagePosition { index: u32, stage_count: u32 },
    #[error("stage label must not be empty")]
    EmptyStageLabel,
    #[error("{metric} progress {completed} exceeds total {total}")]
    CompletedExceedsTotal {
        metric: &'static str,
        completed: u64,
        total: u64,
    },
    #[error("{metric} progress regressed from {previous} to {next}")]
    CounterRegression {
        metric: &'static str,
        previous: u64,
        next: u64,
    },
    #[error("known {metric} total {previous} cannot change to {next:?}")]
    TotalChanged {
        metric: &'static str,
        previous: u64,
        next: Option<u64>,
    },
    #[error("stage count changed from {previous} to {next}")]
    StageCountChanged { previous: u32, next: u32 },
    #[error("stage index regressed from {previous} to {next}")]
    StageRegression { previous: u32, next: u32 },
    #[error("stage identity changed without advancing its index")]
    StageIdentityChanged,
}

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
}

impl Serialize for PhotolabJob {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        let mut record = serializer.serialize_struct("PhotolabJob", 14)?;
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
        })
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

/// Cloneable cooperative cancellation handle without an async runtime.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    requested: Arc<AtomicBool>,
}

impl CancellationToken {
    /// Creates a token with no pending cancellation request.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Requests cancellation and returns true only for the first request.
    pub fn request_cancel(&self) -> bool {
        !self.requested.swap(true, Ordering::AcqRel)
    }

    /// Returns whether any token owner requested cancellation.
    #[must_use]
    pub fn is_cancel_requested(&self) -> bool {
        self.requested.load(Ordering::Acquire)
    }

    /// Cheap worker-side cancellation point.
    pub fn check(&self) -> Result<(), CancelRequested> {
        if self.is_cancel_requested() {
            Err(CancelRequested)
        } else {
            Ok(())
        }
    }
}

/// Cooperative stop signal returned at a worker cancellation point.
#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
#[error("Photolab job cancellation was requested")]
pub struct CancelRequested;

/// Atomic visibility state of a checkpoint payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CheckpointCommitState {
    /// Temporary payloads must never be used for resume.
    Pending {
        temporary_object_key: String,
        expected_payload_hash: ObjectHash,
    },
    /// A manifest may reference this validated payload.
    Committed { payload_hash: ObjectHash },
}

/// Values captured after writing a temporary checkpoint payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPendingCheckpoint {
    pub checkpoint_id: CheckpointId,
    pub job_id: PhotolabJobId,
    pub job_kind: PhotolabJobKind,
    pub sequence: u64,
    pub progress: JobProgress,
    pub config_hash: ObjectHash,
    pub input_hash: ObjectHash,
    pub temporary_object_key: String,
    pub expected_payload_hash: ObjectHash,
}

/// Persistable checkpoint metadata. Only committed descriptors are resumable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDescriptor {
    pub schema_version: u32,
    pub checkpoint_id: CheckpointId,
    pub job_id: PhotolabJobId,
    pub job_kind: PhotolabJobKind,
    pub sequence: u64,
    pub progress: JobProgress,
    pub config_hash: ObjectHash,
    pub input_hash: ObjectHash,
    pub commit_state: CheckpointCommitState,
}

impl CheckpointDescriptor {
    /// Creates a non-resumable descriptor for a temporary payload.
    pub fn pending(request: NewPendingCheckpoint) -> Result<Self, CheckpointError> {
        request.progress.validate()?;
        validate_checkpoint_hash("config", &request.config_hash)?;
        validate_checkpoint_hash("input", &request.input_hash)?;
        validate_checkpoint_hash("payload", &request.expected_payload_hash)?;
        if request.temporary_object_key.trim().is_empty() {
            return Err(CheckpointError::EmptyTemporaryObjectKey);
        }
        Ok(Self {
            schema_version: CHECKPOINT_SCHEMA_VERSION,
            checkpoint_id: request.checkpoint_id,
            job_id: request.job_id,
            job_kind: request.job_kind,
            sequence: request.sequence,
            progress: request.progress,
            config_hash: request.config_hash,
            input_hash: request.input_hash,
            commit_state: CheckpointCommitState::Pending {
                temporary_object_key: request.temporary_object_key,
                expected_payload_hash: request.expected_payload_hash,
            },
        })
    }

    /// Publishes data-model visibility after storage code durably verifies the payload.
    pub fn commit(&mut self, observed_payload_hash: ObjectHash) -> Result<(), CheckpointError> {
        validate_checkpoint_hash("payload", &observed_payload_hash)?;
        let CheckpointCommitState::Pending {
            expected_payload_hash,
            ..
        } = &self.commit_state
        else {
            return Err(CheckpointError::AlreadyCommitted);
        };
        if observed_payload_hash != *expected_payload_hash {
            return Err(CheckpointError::PayloadHashMismatch {
                expected: expected_payload_hash.clone(),
                observed: observed_payload_hash,
            });
        }
        self.commit_state = CheckpointCommitState::Committed {
            payload_hash: expected_payload_hash.clone(),
        };
        Ok(())
    }

    /// Returns true only after the one-way commit transition.
    #[must_use]
    pub fn is_committed(&self) -> bool {
        matches!(self.commit_state, CheckpointCommitState::Committed { .. })
    }

    /// Validates schema, kind, configuration and immutable input identity for resume.
    pub fn validate_resume(
        &self,
        context: &ResumeValidationContext,
    ) -> Result<ResumePoint, ResumeValidationError> {
        if self.schema_version != CHECKPOINT_SCHEMA_VERSION {
            return Err(ResumeValidationError::UnsupportedSchema {
                found: self.schema_version,
                supported: CHECKPOINT_SCHEMA_VERSION,
            });
        }
        let CheckpointCommitState::Committed { payload_hash } = &self.commit_state else {
            return Err(ResumeValidationError::CheckpointNotCommitted);
        };
        if self.job_kind != context.job_kind {
            return Err(ResumeValidationError::JobKindMismatch {
                checkpoint: self.job_kind,
                requested: context.job_kind,
            });
        }
        if self.config_hash != context.config_hash {
            return Err(ResumeValidationError::ConfigHashMismatch {
                checkpoint: self.config_hash.clone(),
                requested: context.config_hash.clone(),
            });
        }
        if self.input_hash != context.input_hash {
            return Err(ResumeValidationError::InputHashMismatch {
                checkpoint: self.input_hash.clone(),
                requested: context.input_hash.clone(),
            });
        }
        Ok(ResumePoint {
            checkpoint_id: self.checkpoint_id.clone(),
            source_job_id: self.job_id.clone(),
            sequence: self.sequence,
            progress: self.progress.clone(),
            payload_hash: payload_hash.clone(),
        })
    }
}

/// Immutable identity of work that a checkpoint may resume.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeValidationContext {
    pub job_kind: PhotolabJobKind,
    pub config_hash: ObjectHash,
    pub input_hash: ObjectHash,
}

/// Validated reference handed to a resuming worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumePoint {
    pub checkpoint_id: CheckpointId,
    pub source_job_id: PhotolabJobId,
    pub sequence: u64,
    pub progress: JobProgress,
    pub payload_hash: ObjectHash,
}

/// Checkpoint construction and commit failures.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum CheckpointError {
    #[error(transparent)]
    Progress(#[from] ProgressError),
    #[error("{field} hash is not a SHA-256 hex digest")]
    InvalidHash { field: &'static str },
    #[error("temporary checkpoint object key must not be empty")]
    EmptyTemporaryObjectKey,
    #[error("payload hash mismatch: expected {expected:?}, observed {observed:?}")]
    PayloadHashMismatch {
        expected: ObjectHash,
        observed: ObjectHash,
    },
    #[error("checkpoint is already committed")]
    AlreadyCommitted,
}

/// Resume rejection reasons surfaced to orchestration and users.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ResumeValidationError {
    #[error("checkpoint schema {found} is unsupported; supported schema is {supported}")]
    UnsupportedSchema { found: u32, supported: u32 },
    #[error("checkpoint is pending and cannot be resumed")]
    CheckpointNotCommitted,
    #[error("checkpoint kind {checkpoint:?} does not match requested kind {requested:?}")]
    JobKindMismatch {
        checkpoint: PhotolabJobKind,
        requested: PhotolabJobKind,
    },
    #[error("checkpoint configuration hash differs from the requested configuration")]
    ConfigHashMismatch {
        checkpoint: ObjectHash,
        requested: ObjectHash,
    },
    #[error("checkpoint input hash differs from the requested immutable inputs")]
    InputHashMismatch {
        checkpoint: ObjectHash,
        requested: ObjectHash,
    },
}

fn validate_job_hash(field: &'static str, hash: &ObjectHash) -> Result<(), JobError> {
    if is_sha256_hex(hash.as_str()) {
        Ok(())
    } else {
        Err(JobError::InvalidHash { field })
    }
}

fn validate_checkpoint_hash(field: &'static str, hash: &ObjectHash) -> Result<(), CheckpointError> {
    if is_sha256_hex(hash.as_str()) {
        Ok(())
    } else {
        Err(CheckpointError::InvalidHash { field })
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
