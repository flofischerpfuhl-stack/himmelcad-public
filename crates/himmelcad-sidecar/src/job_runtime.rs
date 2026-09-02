//! Bounded Photolab worker orchestration for the sidecar.

use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

use fs2::FileExt;
use himmelcad_core::{
    hash::ObjectHash,
    photolab_jobs::{
        CancellationToken, CheckpointCommitState, CheckpointDescriptor, CheckpointId, JobError,
        JobProgress, NewPhotolabJob, PhotolabJob, PhotolabJobId, PhotolabJobKind, PhotolabJobState,
        CHECKPOINT_SCHEMA_VERSION,
    },
};
use serde::{Deserialize, Serialize};
use tokio::{
    runtime::Handle,
    sync::{watch, Mutex, OwnedSemaphorePermit, Semaphore},
    time::{sleep, timeout_at, Duration, Instant as TokioInstant},
};

// WP-B6 calibration governed by the release-polish plan's tunables register: 500 ms
// bounds memory-only terminal history without hot-looping a persistently failing disk.
const HISTORY_RETRY_INTERVAL: Duration = Duration::from_millis(500);

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
}

/// Bounded scheduling policy for one sidecar process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobManagerConfig {
    pub max_concurrency: usize,
    pub max_queued: usize,
}

impl JobManagerConfig {
    fn capacity(self) -> Result<usize, JobManagerError> {
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

/// Cheap diagnostic callback scoped to one job.
#[derive(Debug, Clone)]
pub struct JobDiagnosticSink {
    manager: JobManager,
    job_id: PhotolabJobId,
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
    cancellation: CancellationToken,
    updates: watch::Sender<PhotolabJob>,
    worker_updates: watch::Sender<bool>,
    worker_active: bool,
    history_scope: Option<JobHistoryScope>,
    frozen_request: Option<FrozenJobRequest>,
    history_dirty: bool,
    last_history_persisted_at: Instant,
}

struct JobManagerInner {
    config: JobManagerConfig,
    capacity: usize,
    concurrency: Arc<Semaphore>,
    jobs: Mutex<BTreeMap<String, ManagedJob>>,
    history: Option<Arc<dyn JobHistoryPersistence>>,
    draining: AtomicBool,
}

/// Thread-safe and Tokio-safe bounded job registry and supervisor.
#[derive(Clone)]
pub struct JobManager {
    inner: Arc<JobManagerInner>,
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
        let capacity = config.capacity()?;
        let inner = Arc::new(JobManagerInner {
            config,
            capacity,
            concurrency: Arc::new(Semaphore::new(config.max_concurrency)),
            jobs: Mutex::new(BTreeMap::new()),
            history,
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
        self.start_inner(request, None, work).await
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
        self.start_inner(request, Some(frozen_request), work).await
    }

    async fn start_inner<F>(
        &self,
        request: NewPhotolabJob,
        frozen_request: Option<FrozenJobRequest>,
        work: F,
    ) -> Result<StartJobResult, JobManagerError>
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        if self.inner.draining.load(Ordering::Acquire) {
            return Err(JobManagerError::SchedulerDraining);
        }
        let job = PhotolabJob::new(request)?;
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
            let (updates, _) = watch::channel(job.clone());
            let (worker_updates, _) = watch::channel(true);
            jobs.insert(
                key.clone(),
                ManagedJob {
                    job: job.clone(),
                    cancellation: cancellation.clone(),
                    updates,
                    worker_updates,
                    worker_active: true,
                    history_scope: history_scope.clone(),
                    frozen_request: frozen_request.clone(),
                    history_dirty: false,
                    last_history_persisted_at: Instant::now(),
                },
            );
            if let (Some(history), Some(scope)) = (&self.inner.history, &history_scope) {
                if let Err(message) = history.persist(scope, &job, frozen_request.as_ref()) {
                    jobs.remove(&key);
                    return Err(JobManagerError::HistoryPersistence(message));
                }
            }
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
        Ok(records
            .into_values()
            .filter(|job| params.include_terminal || !is_terminal(&job.state))
            .collect())
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
        self.inner
            .history
            .as_ref()
            .map_or_else(|| Ok(Vec::new()), |history| history.load_current())
            .map_err(JobManagerError::HistoryPersistence)?
            .into_iter()
            .find(|job| job.id == *job_id)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))
    }

    /// Makes cancellation visible before returning to the caller.
    pub async fn cancel(&self, job_id: &PhotolabJobId) -> Result<CancelJobResult, JobManagerError> {
        let current_scope = self.current_history_scope()?;
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .filter(|managed| {
                self.inner.history.is_none() || managed.history_scope == current_scope
            })
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
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
    std::env::var_os("HIMMELCAD_COMPUTE_LEASE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("himmelcad-photolab-compute.lock"))
}

fn publish(managed: &ManagedJob) {
    managed.updates.send_replace(managed.job.clone());
}

fn is_terminal(state: &PhotolabJobState) -> bool {
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

impl std::error::Error for JobManagerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Core(error) => Some(error),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Mutex as StdMutex,
    };

    use himmelcad_core::{
        hash::ObjectHash,
        photolab_jobs::{
            CheckpointDescriptor, CheckpointId, JobProgress, NewPendingCheckpoint, PhotolabJobKind,
            PhotolabStage, PhotolabStageKind, ProgressMetrics,
        },
    };

    use super::*;

    #[derive(Default)]
    struct MemoryHistory {
        current: StdMutex<Option<JobHistoryScope>>,
        records: StdMutex<BTreeMap<String, BTreeMap<String, PhotolabJob>>>,
        frozen_requests: StdMutex<BTreeMap<String, FrozenJobRequest>>,
        persist_count: AtomicUsize,
    }

    impl MemoryHistory {
        fn select(&self, project_id: &str) {
            *self.current.lock().expect("history current") = Some(JobHistoryScope {
                project_id: project_id.into(),
                project_root: PathBuf::from(format!("/{project_id}")),
            });
        }
    }

    impl JobHistoryPersistence for MemoryHistory {
        fn current_scope(&self) -> Result<Option<JobHistoryScope>, String> {
            Ok(self
                .current
                .lock()
                .map_err(|error| error.to_string())?
                .clone())
        }

        fn load_current(&self) -> Result<Vec<PhotolabJob>, String> {
            let project_id = self
                .current
                .lock()
                .map_err(|error| error.to_string())?
                .as_ref()
                .map(|scope| scope.project_id.clone());
            let records = self.records.lock().map_err(|error| error.to_string())?;
            Ok(project_id
                .and_then(|project_id| records.get(&project_id))
                .map_or_else(Vec::new, |jobs| jobs.values().cloned().collect()))
        }

        fn persist(
            &self,
            scope: &JobHistoryScope,
            job: &PhotolabJob,
            frozen_request: Option<&FrozenJobRequest>,
        ) -> Result<(), String> {
            self.persist_count.fetch_add(1, Ordering::Relaxed);
            self.records
                .lock()
                .map_err(|error| error.to_string())?
                .entry(scope.project_id.clone())
                .or_default()
                .insert(job.id.0.clone(), job.clone());
            if let Some(frozen_request) = frozen_request {
                self.frozen_requests
                    .lock()
                    .map_err(|error| error.to_string())?
                    .insert(job.id.0.clone(), frozen_request.clone());
            }
            Ok(())
        }
    }

    struct FailingThenSucceedingHistory {
        inner: MemoryHistory,
        terminal_failures_remaining: AtomicUsize,
    }

    impl FailingThenSucceedingHistory {
        fn new() -> Self {
            Self {
                inner: MemoryHistory::default(),
                terminal_failures_remaining: AtomicUsize::new(1),
            }
        }

        fn select(&self, project_id: &str) {
            self.inner.select(project_id);
        }

        fn persisted_job(&self, project_id: &str, job_id: &str) -> Option<PhotolabJob> {
            self.inner
                .records
                .lock()
                .expect("history records")
                .get(project_id)
                .and_then(|jobs| jobs.get(job_id))
                .cloned()
        }
    }

    impl JobHistoryPersistence for FailingThenSucceedingHistory {
        fn current_scope(&self) -> Result<Option<JobHistoryScope>, String> {
            self.inner.current_scope()
        }

        fn load_current(&self) -> Result<Vec<PhotolabJob>, String> {
            self.inner.load_current()
        }

        fn persist(
            &self,
            scope: &JobHistoryScope,
            job: &PhotolabJob,
            frozen_request: Option<&FrozenJobRequest>,
        ) -> Result<(), String> {
            if is_terminal(&job.state)
                && self
                    .terminal_failures_remaining
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                        remaining.checked_sub(1)
                    })
                    .is_ok()
            {
                return Err("injected terminal history write failure".into());
            }
            self.inner.persist(scope, job, frozen_request)
        }
    }

    fn hash(value: &str) -> ObjectHash {
        ObjectHash::of_bytes(value.as_bytes())
    }

    fn progress(done: u64) -> JobProgress {
        JobProgress {
            stage: PhotolabStage {
                kind: PhotolabStageKind::FeatureExtraction,
                index: 0,
                stage_count: 1,
                label: "Extract features".into(),
            },
            metrics: ProgressMetrics {
                completed_units: done,
                total_units: Some(10),
                completed_bytes: done * 100,
                total_bytes: Some(1_000),
            },
        }
    }

    #[tokio::test]
    async fn resumable_start_persists_the_hash_bound_request_before_work_runs() {
        let history = Arc::new(MemoryHistory::default());
        history.select("project-a");
        let manager = JobManager::new_with_history(
            JobManagerConfig {
                max_concurrency: 1,
                max_queued: 0,
            },
            history.clone(),
        )
        .expect("manager");
        let request = request("resume-job");
        let frozen = FrozenJobRequest::new(
            "photolab.jobs.startProduct",
            serde_json::json!({ "operationId": "resume-job" }),
            &request,
        )
        .expect("frozen request");
        manager
            .start_with_frozen_request(request, frozen.clone(), |_| Ok(()))
            .await
            .expect("start resumable job");
        assert_eq!(
            history
                .frozen_requests
                .lock()
                .expect("frozen requests")
                .get("resume-job"),
            Some(&frozen)
        );
        let terminal = manager
            .wait_for_terminal(&PhotolabJobId("resume-job".into()))
            .await
            .expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
    }

    #[tokio::test]
    async fn background_tick_retries_a_failed_terminal_history_write_without_listing() {
        let history = Arc::new(FailingThenSucceedingHistory::new());
        history.select("retry-project");
        let manager = JobManager::new_with_history(
            JobManagerConfig {
                max_concurrency: 1,
                max_queued: 0,
            },
            history.clone(),
        )
        .expect("manager");
        let job_id = PhotolabJobId("retry-terminal-job".into());
        manager
            .start(request(&job_id.0), |_| Ok(()))
            .await
            .expect("start job");
        let terminal = manager
            .wait_for_terminal(&job_id)
            .await
            .expect("terminal memory state");
        assert_eq!(terminal.state, PhotolabJobState::Completed);

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if history
                    .persisted_job("retry-project", &job_id.0)
                    .is_some_and(|job| job.state == PhotolabJobState::Completed)
                {
                    break;
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("background history retry");
    }

    #[test]
    fn frozen_request_binding_rejects_payload_tampering() {
        let request = request("bound-job");
        let mut frozen = FrozenJobRequest::new(
            "photolab.jobs.startProduct",
            serde_json::json!({ "operationId": "bound-job" }),
            &request,
        )
        .expect("frozen request");
        frozen.validate().expect("valid binding");
        frozen.params["operationId"] = serde_json::json!("other-job");
        assert!(frozen.validate().is_err());
    }

    #[tokio::test]
    async fn recoverable_history_job_is_resubmitted_with_resume_work() {
        let history = Arc::new(MemoryHistory::default());
        history.select("project-a");
        let scope = history
            .current_scope()
            .expect("scope")
            .expect("selected scope");
        let request = request_for_kind("resume-history", PhotolabJobKind::BuildGaussianSplat);
        let frozen = FrozenJobRequest::new(
            "photolab.jobs.startProduct",
            serde_json::json!({ "operationId": "resume-history" }),
            &request,
        )
        .expect("frozen request");
        let mut interrupted = PhotolabJob::new(request.clone()).expect("history job");
        interrupted
            .transition_to(PhotolabJobState::Running)
            .expect("running");
        interrupted
            .transition_to(PhotolabJobState::Failed {
                code: "interruptedRecoverable".into(),
                message: "Resume is available.".into(),
            })
            .expect("interrupted");
        history
            .persist(&scope, &interrupted, Some(&frozen))
            .expect("persist history");

        let manager = JobManager::new_with_history(
            JobManagerConfig {
                max_concurrency: 1,
                max_queued: 0,
            },
            history,
        )
        .expect("manager");
        assert_eq!(
            manager
                .status(&request.id)
                .await
                .expect("history status")
                .state,
            interrupted.state
        );
        let resumed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let resumed_in_worker = resumed.clone();
        manager
            .start_with_frozen_request(request.clone(), frozen, move |_| {
                resumed_in_worker.store(true, Ordering::Release);
                Ok(())
            })
            .await
            .expect("resubmit");
        let terminal = manager
            .wait_for_terminal(&request.id)
            .await
            .expect("resumed terminal");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        assert!(resumed.load(Ordering::Acquire));
    }

    fn request(id: &str) -> NewPhotolabJob {
        request_for_kind(id, PhotolabJobKind::AlignPhotos)
    }

    fn request_for_kind(id: &str, kind: PhotolabJobKind) -> NewPhotolabJob {
        NewPhotolabJob {
            id: PhotolabJobId(id.into()),
            kind,
            config_hash: hash("config"),
            input_hash: hash("inputs"),
            progress: progress(0),
        }
    }

    async fn assert_durable_checkpoint_updates_job(kind: PhotolabJobKind, id: &str) {
        let manager = manager(1, 0);
        let job_id = PhotolabJobId(id.into());
        let directory = std::env::temp_dir().join(format!(
            "himmelcad-job-checkpoint-{}-{id}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("checkpoint test directory");
        let checkpoint_path = directory.join("checkpoint.bin");
        let worker_path = checkpoint_path.clone();
        let checkpoint_id = id.to_owned();
        manager
            .start(request_for_kind(id, kind), move |context| {
                let pending = worker_path.with_extension("pending");
                let payload = b"durable runtime checkpoint";
                let mut file = File::create(&pending).expect("create pending checkpoint");
                file.write_all(payload).expect("write checkpoint payload");
                file.sync_all().expect("sync checkpoint payload");
                drop(file);
                fs::rename(&pending, &worker_path).expect("commit checkpoint payload");
                #[cfg(unix)]
                File::open(worker_path.parent().expect("checkpoint parent"))
                    .expect("open checkpoint parent")
                    .sync_all()
                    .expect("sync checkpoint parent");
                context.checkpoints.record_committed_blocking(
                    7,
                    checkpoint_progress(kind),
                    format!("{checkpoint_id}:checkpoint:7"),
                    ObjectHash::of_bytes(payload),
                )?;
                Ok(())
            })
            .await
            .expect("admitted");
        let terminal = manager.wait_for_terminal(&job_id).await.expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        assert_eq!(terminal.last_checkpoint_sequence, Some(7));
        assert!(checkpoint_path.is_file());
        fs::remove_dir_all(directory).expect("checkpoint test cleanup");
    }

    fn checkpoint_progress(kind: PhotolabJobKind) -> JobProgress {
        let stage_kind = match kind {
            PhotolabJobKind::BuildDepthMaps => PhotolabStageKind::DepthEstimation,
            PhotolabJobKind::BuildDensePointCloud => PhotolabStageKind::DenseFusion,
            PhotolabJobKind::BuildDem | PhotolabJobKind::BuildOrthomosaic => {
                PhotolabStageKind::Rasterization
            }
            PhotolabJobKind::BuildGaussianSplat => PhotolabStageKind::SplatOptimization,
            PhotolabJobKind::Batch => PhotolabStageKind::Finalizing,
            _ => PhotolabStageKind::Preparing,
        };
        JobProgress {
            stage: PhotolabStage {
                kind: stage_kind,
                index: 0,
                stage_count: 1,
                label: "Commit durable checkpoint".into(),
            },
            metrics: ProgressMetrics {
                completed_units: 1,
                total_units: Some(1),
                completed_bytes: 0,
                total_bytes: None,
            },
        }
    }

    fn manager(concurrency: usize, queued: usize) -> JobManager {
        JobManager::new(JobManagerConfig {
            max_concurrency: concurrency,
            max_queued: queued,
        })
        .expect("manager")
    }

    #[tokio::test]
    async fn durable_history_is_filtered_by_current_project_and_receives_terminal_state() {
        let history = Arc::new(MemoryHistory::default());
        history.select("project-a");
        let manager = JobManager::new_with_history(
            JobManagerConfig {
                max_concurrency: 1,
                max_queued: 0,
            },
            history.clone(),
        )
        .expect("manager");
        manager
            .start(request("project-a-job"), |_| Ok(()))
            .await
            .expect("start");
        manager
            .wait_for_terminal(&PhotolabJobId("project-a-job".into()))
            .await
            .expect("terminal");
        assert!(matches!(
            history
                .load_current()
                .expect("durable history")
                .first()
                .map(|job| &job.state),
            Some(PhotolabJobState::Completed)
        ));

        history.select("project-b");
        assert!(manager
            .list(ListJobsParams {
                include_terminal: true,
            })
            .await
            .expect("project-b list")
            .is_empty());
        assert!(matches!(
            manager.status(&PhotolabJobId("project-a-job".into())).await,
            Err(JobManagerError::JobNotFound(_))
        ));
    }

    #[tokio::test]
    async fn frequent_progress_is_throttled_but_stage_and_terminal_are_durable() {
        let history = Arc::new(MemoryHistory::default());
        history.select("progress-project");
        let manager = JobManager::new_with_history(
            JobManagerConfig {
                max_concurrency: 1,
                max_queued: 0,
            },
            history.clone(),
        )
        .expect("manager");
        let mut job = request("progress-job");
        job.progress.stage.stage_count = 2;
        manager
            .start(job, move |context| {
                for completed in 0..100 {
                    context.progress.report_blocking(JobProgress {
                        stage: PhotolabStage {
                            kind: PhotolabStageKind::FeatureMatching,
                            index: 1,
                            stage_count: 2,
                            label: "Match features".into(),
                        },
                        metrics: ProgressMetrics {
                            completed_units: completed,
                            total_units: Some(100),
                            completed_bytes: completed * 10,
                            total_bytes: Some(1_000),
                        },
                    })?;
                }
                Ok(())
            })
            .await
            .expect("start");
        manager
            .wait_for_terminal(&PhotolabJobId("progress-job".into()))
            .await
            .expect("terminal");
        let writes = history.persist_count.load(Ordering::Relaxed);
        assert!(
            (4..20).contains(&writes),
            "queued, running, stage transition, and terminal should be durable without one write per progress event; got {writes} writes"
        );
    }

    fn committed_checkpoint(job_id: &str) -> CheckpointDescriptor {
        let mut checkpoint = CheckpointDescriptor::pending(NewPendingCheckpoint {
            checkpoint_id: CheckpointId("checkpoint-1".into()),
            job_id: PhotolabJobId(job_id.into()),
            job_kind: PhotolabJobKind::AlignPhotos,
            sequence: 1,
            progress: progress(5),
            config_hash: hash("config"),
            input_hash: hash("inputs"),
            temporary_object_key: "tmp/checkpoint-1".into(),
            expected_payload_hash: hash("payload"),
        })
        .expect("pending checkpoint");
        checkpoint.commit(hash("payload")).expect("commit");
        checkpoint
    }

    #[test]
    fn configuration_requires_non_zero_concurrency() {
        assert!(matches!(
            JobManagerConfig {
                max_concurrency: 0,
                max_queued: 1,
            }
            .capacity(),
            Err(JobManagerError::InvalidConfig(_))
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queue_and_concurrency_are_bounded_without_blocking_start() {
        let manager = manager(1, 1);
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        manager
            .start(request("first"), move |_| {
                started_tx.send(()).expect("signal start");
                release_rx.recv().expect("release");
                Ok(())
            })
            .await
            .expect("first admitted");
        started_rx.recv().expect("first running");
        manager
            .start(request("second"), |_| Ok(()))
            .await
            .expect("second queued");
        let full = manager.start(request("third"), |_| Ok(())).await;
        assert!(matches!(full, Err(JobManagerError::QueueFull { .. })));
        assert_eq!(
            manager
                .list(ListJobsParams::default())
                .await
                .expect("list")
                .len(),
            2
        );
        release_tx.send(()).expect("release first");
        manager
            .wait_for_terminal(&PhotolabJobId("first".into()))
            .await
            .expect("first finishes");
        manager
            .wait_for_terminal(&PhotolabJobId("second".into()))
            .await
            .expect("second finishes");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn compute_lease_serializes_workers_across_managers() {
        let first_manager = manager(1, 0);
        let second_manager = manager(1, 0);
        let (first_started_tx, first_started_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        first_manager
            .start(request("lease-first"), move |_| {
                first_started_tx.send(()).expect("signal first start");
                release_first_rx.recv().expect("release first");
                Ok(())
            })
            .await
            .expect("first admitted");
        first_started_rx.recv().expect("first running");

        let (second_started_tx, second_started_rx) = mpsc::channel();
        second_manager
            .start(request("lease-second"), move |_| {
                second_started_tx.send(()).expect("signal second start");
                Ok(())
            })
            .await
            .expect("second admitted");
        assert!(second_started_rx
            .recv_timeout(Duration::from_millis(250))
            .is_err());

        release_first_tx.send(()).expect("release first");
        first_manager
            .wait_for_terminal(&PhotolabJobId("lease-first".into()))
            .await
            .expect("first terminal");
        second_started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("second starts after first releases the lease");
        second_manager
            .wait_for_terminal(&PhotolabJobId("lease-second".into()))
            .await
            .expect("second terminal");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_is_immediately_visible_and_reaches_worker() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("cancel-me".into());
        let (started_tx, started_rx) = mpsc::channel();
        manager
            .start(request(&id.0), move |context| {
                started_tx.send(()).expect("signal worker start");
                loop {
                    context.check_cancelled()?;
                    std::thread::yield_now();
                }
            })
            .await
            .expect("admitted");
        started_rx.recv().expect("worker started");
        let result = manager.cancel(&id).await.expect("cancel");
        assert!(matches!(
            result.job.state,
            PhotolabJobState::CancelRequested | PhotolabJobState::Cancelled
        ));
        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Cancelled);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_all_protects_a_project_session_change() {
        let manager = manager(1, 2);
        let (started_tx, started_rx) = mpsc::channel();
        manager
            .start(request("running"), move |context| {
                started_tx.send(()).expect("signal worker start");
                loop {
                    context.check_cancelled()?;
                    std::thread::yield_now();
                }
            })
            .await
            .expect("running admitted");
        started_rx.recv().expect("worker started");
        manager
            .start(request("queued"), |_| Ok(()))
            .await
            .expect("queued admitted");

        let changed = manager.cancel_all().await;
        assert_eq!(changed.len(), 2);
        assert_eq!(
            manager
                .wait_for_terminal(&PhotolabJobId("running".into()))
                .await
                .expect("running terminal")
                .state,
            PhotolabJobState::Cancelled
        );
        assert_eq!(
            manager
                .wait_for_terminal(&PhotolabJobId("queued".into()))
                .await
                .expect("queued terminal")
                .state,
            PhotolabJobState::Cancelled
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn drain_cancels_a_slow_worker_and_reports_terminal_state() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("drain-slow-worker".into());
        let (started_tx, started_rx) = mpsc::channel();
        let cancellation_observed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let worker_observed = Arc::clone(&cancellation_observed);
        manager
            .start(request(&id.0), move |context| {
                started_tx.send(()).expect("signal worker start");
                loop {
                    if context.cancellation.is_cancel_requested() {
                        worker_observed.store(true, Ordering::Release);
                        return Err(JobWorkerError::Cancelled);
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
            })
            .await
            .expect("admitted");
        started_rx.recv().expect("worker started");

        let report = manager.drain(Duration::from_secs(1)).await;

        assert_eq!(report.terminal, 1);
        assert!(report.timed_out.is_empty());
        assert!(cancellation_observed.load(Ordering::Acquire));
        assert_eq!(
            manager.status(&id).await.expect("terminal status").state,
            PhotolabJobState::Cancelled
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn drain_timeout_force_marks_the_job_failed_with_a_diagnostic() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("drain-timeout-worker".into());
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        manager
            .start(request(&id.0), move |_| {
                started_tx.send(()).expect("signal worker start");
                release_rx.recv().expect("release timed-out worker");
                Ok(())
            })
            .await
            .expect("admitted");
        started_rx.recv().expect("worker started");

        let report = manager.drain(Duration::from_millis(20)).await;
        assert_eq!(report.terminal, 0);
        assert_eq!(report.timed_out, vec![id.clone()]);
        let terminal = manager.status(&id).await.expect("forced terminal status");
        assert!(matches!(
            terminal.state,
            PhotolabJobState::Failed { ref code, .. } if code == "drainTimeout"
        ));
        assert!(terminal
            .terminal_diagnostic
            .as_deref()
            .is_some_and(|diagnostic| diagnostic.contains("20 ms")));
        let repeated = manager.drain(Duration::from_millis(20)).await;
        assert_eq!(repeated.timed_out, vec![id.clone()]);
        release_tx.send(()).expect("release worker after assertion");
        let completed = manager.drain(Duration::from_secs(1)).await;
        assert_eq!(completed.terminal, 1);
        assert!(completed.timed_out.is_empty());
    }

    #[tokio::test]
    async fn worker_sinks_publish_progress_and_checkpoint() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("sinks".into());
        let worker_id = id.clone();
        manager
            .start(request(&id.0), move |context| {
                context.progress.report_blocking(progress(5))?;
                context
                    .checkpoints
                    .record_blocking(&committed_checkpoint(&worker_id.0))?;
                Ok(())
            })
            .await
            .expect("admitted");
        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        assert_eq!(terminal.progress.metrics.completed_units, 10);
        assert_eq!(terminal.progress.metrics.completed_bytes, 1_000);
        assert_eq!(terminal.last_checkpoint_sequence, Some(1));
    }

    #[tokio::test]
    async fn durable_depth_checkpoint_updates_job_record() {
        assert_durable_checkpoint_updates_job(
            PhotolabJobKind::BuildDepthMaps,
            "durable-depth-checkpoint",
        )
        .await;
    }

    #[tokio::test]
    async fn durable_dense_checkpoint_updates_job_record() {
        assert_durable_checkpoint_updates_job(
            PhotolabJobKind::BuildDensePointCloud,
            "durable-dense-checkpoint",
        )
        .await;
    }

    #[tokio::test]
    async fn durable_dem_checkpoint_updates_job_record() {
        assert_durable_checkpoint_updates_job(PhotolabJobKind::BuildDem, "durable-dem-checkpoint")
            .await;
    }

    #[tokio::test]
    async fn durable_orthomosaic_checkpoint_updates_job_record() {
        assert_durable_checkpoint_updates_job(
            PhotolabJobKind::BuildOrthomosaic,
            "durable-orthomosaic-checkpoint",
        )
        .await;
    }

    #[tokio::test]
    async fn durable_batch_checkpoint_updates_job_record() {
        assert_durable_checkpoint_updates_job(PhotolabJobKind::Batch, "durable-batch-checkpoint")
            .await;
    }

    #[tokio::test]
    async fn durable_splat_checkpoint_updates_job_record() {
        assert_durable_checkpoint_updates_job(
            PhotolabJobKind::BuildGaussianSplat,
            "durable-splat-checkpoint",
        )
        .await;
    }

    #[tokio::test]
    async fn cancellation_retains_non_fatal_terminal_diagnostic() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("cancel-diagnostic".into());
        let worker_id = id.clone();
        manager
            .start(request(&id.0), move |context| {
                context
                    .diagnostics
                    .record_blocking("checkpoint write failed after retry")?;
                context.cancellation.request_cancel();
                Err(JobWorkerError::Cancelled)
            })
            .await
            .expect("admitted");
        let terminal = manager
            .wait_for_terminal(&worker_id)
            .await
            .expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Cancelled);
        assert_eq!(
            terminal.terminal_diagnostic.as_deref(),
            Some("checkpoint write failed after retry")
        );
    }

    #[tokio::test]
    async fn progress_window_maps_child_stages_into_immutable_parent_plan() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("mapped-progress".into());
        let mut parent = request(&id.0);
        parent.progress.stage.stage_count = 65;
        manager
            .start(parent, move |context| {
                let mapped = context.with_progress_window(7, 65);
                let mut child = progress(4);
                child.stage.index = 2;
                child.stage.stage_count = 3;
                mapped.progress.report_blocking(child)?;
                Ok(())
            })
            .await
            .expect("admitted");
        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        assert_eq!(terminal.progress.stage.index, 64);
        assert_eq!(terminal.progress.stage.stage_count, 65);
    }

    #[tokio::test]
    async fn worker_panic_becomes_failed_join_status() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("panic".into());
        manager
            .start(request(&id.0), |_| panic!("worker exploded"))
            .await
            .expect("admitted");
        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert!(matches!(
            terminal.state,
            PhotolabJobState::Failed { ref code, .. } if code == "workerJoin"
        ));
    }

    #[tokio::test]
    async fn closed_scheduler_uses_fail_job_without_deadlocking() {
        let manager = manager(1, 0);
        let id = PhotolabJobId("closed-scheduler".into());
        manager.inner.concurrency.close();
        manager
            .start(request(&id.0), |_| panic!("worker must not start"))
            .await
            .expect("job is admitted before async scheduling");

        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert!(matches!(
            terminal.state,
            PhotolabJobState::Failed { ref code, .. } if code == "schedulerClosed"
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queued_job_cancels_without_consuming_worker_slot() {
        let manager = manager(1, 1);
        let (release_tx, release_rx) = mpsc::channel();
        manager
            .start(request("running"), move |_| {
                release_rx.recv().expect("release");
                Ok(())
            })
            .await
            .expect("running admitted");
        let queued = PhotolabJobId("queued".into());
        manager
            .start(request(&queued.0), |_| panic!("queued worker must not run"))
            .await
            .expect("queued admitted");
        let cancelled = manager.cancel(&queued).await.expect("cancel queued");
        assert_eq!(cancelled.job.state, PhotolabJobState::Cancelled);
        release_tx.send(()).expect("release");
    }
}
