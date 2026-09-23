//! Runtime-neutral cancellation, progress, and checkpoint contracts.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use himmelcad_model::hash::ObjectHash;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Checkpoint schema understood by this core.
pub const CHECKPOINT_SCHEMA_VERSION: u32 = 1;

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

/// Position of a stage in the immutable stage plan of a job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStage<StageKind> {
    pub kind: StageKind,
    pub index: u32,
    pub stage_count: u32,
    pub label: String,
}

impl<StageKind> JobStage<StageKind> {
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
pub struct JobProgress<StageKind> {
    pub stage: JobStage<StageKind>,
    pub metrics: ProgressMetrics,
}

impl<StageKind: PartialEq> JobProgress<StageKind> {
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

/// Stable identifier of a checkpoint.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CheckpointId(pub String);

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
pub struct NewPendingCheckpoint<JobId, JobKind, StageKind> {
    pub checkpoint_id: CheckpointId,
    pub job_id: JobId,
    pub job_kind: JobKind,
    pub sequence: u64,
    pub progress: JobProgress<StageKind>,
    pub config_hash: ObjectHash,
    pub input_hash: ObjectHash,
    pub temporary_object_key: String,
    pub expected_payload_hash: ObjectHash,
}

/// Persistable checkpoint metadata. Only committed descriptors are resumable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDescriptor<JobId, JobKind, StageKind> {
    pub schema_version: u32,
    pub checkpoint_id: CheckpointId,
    pub job_id: JobId,
    pub job_kind: JobKind,
    pub sequence: u64,
    pub progress: JobProgress<StageKind>,
    pub config_hash: ObjectHash,
    pub input_hash: ObjectHash,
    pub commit_state: CheckpointCommitState,
}

impl<JobId, JobKind, StageKind> CheckpointDescriptor<JobId, JobKind, StageKind>
where
    JobId: Clone,
    JobKind: Copy + PartialEq + std::fmt::Debug,
    StageKind: Clone + PartialEq,
{
    /// Creates a non-resumable descriptor for a temporary payload.
    pub fn pending(
        request: NewPendingCheckpoint<JobId, JobKind, StageKind>,
    ) -> Result<Self, CheckpointError> {
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
        context: &ResumeValidationContext<JobKind>,
    ) -> Result<ResumePoint<JobId, StageKind>, ResumeValidationError<JobKind>> {
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
pub struct ResumeValidationContext<JobKind> {
    pub job_kind: JobKind,
    pub config_hash: ObjectHash,
    pub input_hash: ObjectHash,
}

/// Validated reference handed to a resuming worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumePoint<JobId, StageKind> {
    pub checkpoint_id: CheckpointId,
    pub source_job_id: JobId,
    pub sequence: u64,
    pub progress: JobProgress<StageKind>,
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
pub enum ResumeValidationError<JobKind: std::fmt::Debug> {
    #[error("checkpoint schema {found} is unsupported; supported schema is {supported}")]
    UnsupportedSchema { found: u32, supported: u32 },
    #[error("checkpoint is pending and cannot be resumed")]
    CheckpointNotCommitted,
    #[error("checkpoint kind {checkpoint:?} does not match requested kind {requested:?}")]
    JobKindMismatch {
        checkpoint: JobKind,
        requested: JobKind,
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

fn validate_checkpoint_hash(field: &'static str, hash: &ObjectHash) -> Result<(), CheckpointError> {
    if hash.as_str().len() == 64 && hash.as_str().bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(CheckpointError::InvalidHash { field })
    }
}
