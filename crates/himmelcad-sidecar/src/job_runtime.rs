//! Bounded Photolab worker orchestration for the sidecar.

use std::{collections::BTreeMap, sync::Arc};

use himmelcad_core::photolab_jobs::{
    CancellationToken, CheckpointDescriptor, JobError, JobProgress, NewPhotolabJob, PhotolabJob,
    PhotolabJobId, PhotolabJobState,
};
use serde::{Deserialize, Serialize};
use tokio::{
    runtime::Handle,
    sync::{watch, Mutex, OwnedSemaphorePermit, Semaphore},
};

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
}

/// Capabilities handed to a blocking Photolab compute worker.
#[derive(Debug, Clone)]
pub struct JobWorkerContext {
    pub cancellation: CancellationToken,
    pub progress: ProgressSink,
    pub checkpoints: CheckpointSink,
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
        mapped
    }
}

struct ManagedJob {
    job: PhotolabJob,
    cancellation: CancellationToken,
    updates: watch::Sender<PhotolabJob>,
}

struct JobManagerInner {
    config: JobManagerConfig,
    capacity: usize,
    concurrency: Arc<Semaphore>,
    jobs: Mutex<BTreeMap<String, ManagedJob>>,
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
        Self::with_runtime(config, runtime)
    }

    /// Creates a manager for an explicitly supplied runtime handle.
    pub fn with_runtime(
        config: JobManagerConfig,
        runtime: Handle,
    ) -> Result<Self, JobManagerError> {
        let capacity = config.capacity()?;
        Ok(Self {
            inner: Arc::new(JobManagerInner {
                config,
                capacity,
                concurrency: Arc::new(Semaphore::new(config.max_concurrency)),
                jobs: Mutex::new(BTreeMap::new()),
            }),
            runtime,
        })
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
        let job = PhotolabJob::new(request)?;
        let key = job.id.0.clone();
        let cancellation = CancellationToken::new();
        {
            let mut jobs = self.inner.jobs.lock().await;
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
            jobs.insert(
                key,
                ManagedJob {
                    job: job.clone(),
                    cancellation: cancellation.clone(),
                    updates,
                },
            );
        }

        let manager = self.clone();
        let job_id = job.id.clone();
        self.runtime.spawn(async move {
            manager.supervise(job_id, cancellation, work).await;
        });
        Ok(StartJobResult { job })
    }

    /// Returns a stable snapshot sorted by job identifier.
    pub async fn list(&self, params: ListJobsParams) -> Vec<PhotolabJob> {
        self.inner
            .jobs
            .lock()
            .await
            .values()
            .filter(|managed| params.include_terminal || !is_terminal(&managed.job.state))
            .map(|managed| managed.job.clone())
            .collect()
    }

    /// Returns the current authoritative record for one job.
    pub async fn status(&self, job_id: &PhotolabJobId) -> Result<PhotolabJob, JobManagerError> {
        let jobs = self.inner.jobs.lock().await;
        jobs.get(&job_id.0)
            .map(|managed| managed.job.clone())
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))
    }

    /// Makes cancellation visible before returning to the caller.
    pub async fn cancel(&self, job_id: &PhotolabJobId) -> Result<CancelJobResult, JobManagerError> {
        let mut jobs = self.inner.jobs.lock().await;
        let managed = jobs
            .get_mut(&job_id.0)
            .ok_or_else(|| JobManagerError::JobNotFound(job_id.clone()))?;
        let was_queued = managed.job.state == PhotolabJobState::Queued;
        let first_request = managed.job.request_cancel(&managed.cancellation)?;
        if was_queued {
            managed.job.transition_to(PhotolabJobState::Cancelled)?;
        }
        publish(managed);
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
                let _ = managed.job.transition_to(PhotolabJobState::Cancelled);
            }
            publish(managed);
            changed.push(managed.job.clone());
        }
        changed
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

    async fn supervise<F>(&self, job_id: PhotolabJobId, cancellation: CancellationToken, work: F)
    where
        F: FnOnce(JobWorkerContext) -> JobWorkerResult + Send + 'static,
    {
        let Ok(permit) = self.inner.concurrency.clone().acquire_owned().await else {
            self.fail_job(&job_id, "schedulerClosed", "job scheduler closed")
                .await;
            return;
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
            },
        };
        let outcome = tokio::task::spawn_blocking(move || work(context)).await;
        self.finish_worker(&job_id, outcome, permit).await;
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
            return false;
        }
        publish(managed);
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
            Ok(Ok(())) => transition_or_fail(managed, PhotolabJobState::Completed),
            Ok(Err(JobWorkerError::Cancelled)) if managed.cancellation.is_cancel_requested() => {
                if managed.job.state != PhotolabJobState::CancelRequested {
                    let _ = managed.job.request_cancel(&managed.cancellation);
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
        publish(managed);
    }

    async fn fail_job(&self, job_id: &PhotolabJobId, code: &str, message: &str) {
        let mut jobs = self.inner.jobs.lock().await;
        if let Some(managed) = jobs.get_mut(&job_id.0) {
            set_failed(managed, code, message.into());
            publish(managed);
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
        managed.job.update_progress(progress)?;
        publish(managed);
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
        publish(managed);
        Ok(managed.job.clone())
    }
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

fn set_failed(managed: &mut ManagedJob, code: &str, message: String) {
    let failed = PhotolabJobState::Failed {
        code: code.into(),
        message,
    };
    let _ = managed.job.transition_to(failed);
}

/// Scheduling and authoritative-state failures returned to RPC integration.
#[derive(Debug, PartialEq, Eq)]
pub enum JobManagerError {
    InvalidConfig(&'static str),
    NoTokioRuntime,
    DuplicateJobId(PhotolabJobId),
    QueueFull {
        max_concurrency: usize,
        max_queued: usize,
    },
    JobNotFound(PhotolabJobId),
    UpdateChannelClosed(PhotolabJobId),
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
            Self::NoTokioRuntime => formatter.write_str(
                "JobManager must be created inside a Tokio runtime or with an explicit handle",
            ),
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
    use std::sync::mpsc;

    use himmelcad_core::{
        hash::ObjectHash,
        photolab_jobs::{
            CheckpointDescriptor, CheckpointId, JobProgress, NewPendingCheckpoint, PhotolabJobKind,
            PhotolabStage, PhotolabStageKind, ProgressMetrics,
        },
    };

    use super::*;

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

    fn request(id: &str) -> NewPhotolabJob {
        NewPhotolabJob {
            id: PhotolabJobId(id.into()),
            kind: PhotolabJobKind::AlignPhotos,
            config_hash: hash("config"),
            input_hash: hash("inputs"),
            progress: progress(0),
        }
    }

    fn manager(concurrency: usize, queued: usize) -> JobManager {
        JobManager::new(JobManagerConfig {
            max_concurrency: concurrency,
            max_queued: queued,
        })
        .expect("manager")
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
        assert_eq!(manager.list(ListJobsParams::default()).await.len(), 2);
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
        assert_eq!(terminal.progress.metrics.completed_units, 5);
        assert_eq!(terminal.last_checkpoint_sequence, Some(1));
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
        assert_eq!(terminal.progress.stage.index, 9);
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
