//! Secure, offline orchestration for the curated Brush Gaussian-splat worker.

use std::{
    collections::{BTreeMap, VecDeque},
    ffi::{OsStr, OsString},
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

use himmelcad_core::{
    hash::ObjectHash,
    photolab_jobs::{
        CancellationToken, JobProgress, PhotolabStage, PhotolabStageKind, ProgressMetrics,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::job_runtime::{JobWorkerContext, JobWorkerError, JobWorkerResult};
use crate::splat_tiler::PreparedSplatProduct;

const BRUSH_VERSION: &str = "0.3.0";
const VENDOR_MANIFEST_MAX_BYTES: u64 = 128 * 1024;
const LICENSE_MAX_BYTES: u64 = 128 * 1024;
const PLY_HEADER_MAX_BYTES: usize = 1024 * 1024;
const LOG_TAIL_LINES: usize = 240;
const MAX_LOG_RECORD_BYTES: usize = 16 * 1024;
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(15);
const COOPERATIVE_CANCEL_GRACE: Duration = Duration::from_millis(200);
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const OUTPUT_SUMMARY_SCHEMA_VERSION: u32 = 1;

static NEXT_SCRATCH_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Hash and platform pins for the release artifact installed by `fetch-vendor.mjs`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrushRuntimeConfig {
    pub tool_root: PathBuf,
    pub expected_executable_sha256: ObjectHash,
    pub expected_license_sha256: ObjectHash,
    pub scratch_root: PathBuf,
    pub allowed_dataset_roots: Vec<PathBuf>,
}

/// Explicitly untrusted local worker configuration used only by tests/development.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevBrushRuntimeConfig {
    pub executable: PathBuf,
    pub scratch_root: PathBuf,
    pub allowed_dataset_roots: Vec<PathBuf>,
}

/// Settings corresponding to the product panel plus deterministic worker controls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrushTrainingSettings {
    pub iterations: u32,
    pub spherical_harmonics_degree: u8,
    pub maximum_splats: u64,
    pub maximum_resolution: u32,
    pub seed: u64,
    pub checkpoint_every: u32,
    pub retain_training_checkpoints: bool,
}

impl Default for BrushTrainingSettings {
    fn default() -> Self {
        Self {
            iterations: 30_000,
            spherical_harmonics_degree: 3,
            maximum_splats: 10_000_000,
            maximum_resolution: 1_920,
            seed: 42,
            checkpoint_every: 5_000,
            retain_training_checkpoints: true,
        }
    }
}

impl BrushTrainingSettings {
    fn validate(&self) -> Result<(), BrushRuntimeError> {
        if !(100..=200_000).contains(&self.iterations) {
            return Err(BrushRuntimeError::InvalidRequest(
                "iterations must be in 100..=200000".into(),
            ));
        }
        if self.spherical_harmonics_degree > 3 {
            return Err(BrushRuntimeError::InvalidRequest(
                "spherical-harmonics degree must be in 0..=3".into(),
            ));
        }
        if !(100_000..=100_000_000).contains(&self.maximum_splats) {
            return Err(BrushRuntimeError::InvalidRequest(
                "maximum splats must be in 100000..=100000000".into(),
            ));
        }
        if !(256..=32_768).contains(&self.maximum_resolution) {
            return Err(BrushRuntimeError::InvalidRequest(
                "maximum resolution must be in 256..=32768".into(),
            ));
        }
        if self.checkpoint_every == 0 || self.checkpoint_every > self.iterations {
            return Err(BrushRuntimeError::InvalidRequest(
                "checkpoint interval must be greater than zero and no larger than iterations"
                    .into(),
            ));
        }
        Ok(())
    }
}

/// A validated Brush PLY that can initialize a resumed training run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrushResumeCheckpoint {
    pub ply_path: PathBuf,
    pub ply_sha256: ObjectHash,
    pub completed_iterations: u32,
}

/// Immutable input to one Brush training run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrushRunRequest {
    pub job_id: String,
    /// Root containing COLMAP cameras/images/points plus referenced image files.
    pub colmap_dataset_root: PathBuf,
    pub settings: BrushTrainingSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<BrushResumeCheckpoint>,
}

impl BrushRunRequest {
    /// Stable progress plan suitable for `NewPhotolabJob`.
    #[must_use]
    pub fn progress_plan(&self) -> BrushProgressPlan {
        BrushProgressPlan::new(self.settings.iterations)
    }

    fn validate(&self) -> Result<(), BrushRuntimeError> {
        validate_component("jobId", &self.job_id)?;
        self.settings.validate()?;
        if let Some(resume) = &self.resume {
            validate_hash(&resume.ply_sha256, "resume checkpoint")?;
            if resume.completed_iterations == 0
                || resume.completed_iterations >= self.settings.iterations
            {
                return Err(BrushRuntimeError::InvalidRequest(
                    "resume iteration must be greater than zero and below total iterations".into(),
                ));
            }
        }
        Ok(())
    }
}

/// Immutable three-stage progress plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushProgressPlan {
    pub total_iterations: u32,
}

impl BrushProgressPlan {
    fn new(total_iterations: u32) -> Self {
        Self { total_iterations }
    }

    /// Initial progress for the Photolab job record.
    #[must_use]
    pub fn initial_progress(&self) -> JobProgress {
        self.progress(0, 0, None)
    }

    fn progress(&self, stage: u32, completed: u64, total: Option<u64>) -> JobProgress {
        debug_assert!(
            stage != 1 || total == Some(u64::from(self.total_iterations)),
            "optimization progress must use the immutable iteration total"
        );
        let (kind, label) = match stage {
            0 => (PhotolabStageKind::Preparing, "Brush preflight"),
            1 => (
                PhotolabStageKind::SplatOptimization,
                "Optimize Gaussian splats",
            ),
            _ => (PhotolabStageKind::Finalizing, "Validate splat output"),
        };
        JobProgress {
            stage: PhotolabStage {
                kind,
                index: stage,
                stage_count: 3,
                label: label.into(),
            },
            metrics: ProgressMetrics {
                completed_units: completed,
                total_units: total,
                completed_bytes: 0,
                total_bytes: None,
            },
        }
    }
}

/// One validated periodic/final PLY produced inside the isolated workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushCheckpointSummary {
    pub iteration: u32,
    pub relative_path: PathBuf,
    pub sha256: ObjectHash,
    pub bytes: u64,
    pub splat_count: u64,
}

/// Provenance and bounded diagnostics for the one Brush invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushCommandReport {
    pub argv: Vec<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub log_tail: Vec<String>,
}

/// Validated result. Publishing it into the project remains a separate core command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrushOutputSummary {
    pub schema_version: u32,
    pub job_id: String,
    pub brush_version: String,
    pub executable_sha256: ObjectHash,
    pub dataset_sha256: ObjectHash,
    pub resumed_from_sha256: Option<ObjectHash>,
    pub settings: BrushTrainingSettings,
    pub command: BrushCommandReport,
    pub final_output: BrushCheckpointSummary,
    pub retained_checkpoints: Vec<BrushCheckpointSummary>,
}

/// Durable paths returned to the product publisher.
#[derive(Debug, Clone, PartialEq)]
pub struct BrushRunOutcome {
    pub scratch_path: PathBuf,
    pub output_path: PathBuf,
    pub summary_path: PathBuf,
    pub summary_sha256: ObjectHash,
    pub summary: BrushOutputSummary,
    pub prepared_splats: Option<PreparedSplatProduct>,
}

/// Valid checkpoint left by a cancelled/interrupted worker and safe to resume.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrushRecoveryCheckpoint {
    pub scratch_path: PathBuf,
    pub checkpoint_path: PathBuf,
    pub checkpoint: BrushCheckpointSummary,
}

#[derive(Debug, Clone)]
struct VerifiedBrushTool {
    executable: PathBuf,
    executable_sha256: ObjectHash,
    version: String,
}

/// Preflighted Brush runner. Cloning shares only immutable trust metadata.
#[derive(Clone)]
pub struct BrushRuntime {
    tool: Arc<VerifiedBrushTool>,
    scratch_root: PathBuf,
    allowed_dataset_roots: Arc<Vec<PathBuf>>,
}

impl std::fmt::Debug for BrushRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BrushRuntime")
            .field("version", &self.tool.version)
            .field("scratch_root", &self.scratch_root)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Error)]
pub enum BrushRuntimeError {
    #[error("invalid Brush runtime configuration: {0}")]
    InvalidConfig(String),
    #[error("invalid Brush request: {0}")]
    InvalidRequest(String),
    #[error("invalid path {path}: {reason}")]
    InvalidPath { path: PathBuf, reason: String },
    #[error("dataset is outside configured roots: {0}")]
    DatasetOutsideAllowedRoots(PathBuf),
    #[error("path escapes its trusted root: {0}")]
    PathOutsideTrustedRoot(PathBuf),
    #[error("invalid {field} SHA-256 value: {value}")]
    InvalidHash { field: &'static str, value: String },
    #[error("SHA-256 mismatch for {path}: expected {expected:?}, observed {observed:?}")]
    HashMismatch {
        path: PathBuf,
        expected: ObjectHash,
        observed: ObjectHash,
    },
    #[error("unsupported Brush version: {0}")]
    UnsupportedVersion(String),
    #[error("vendor manifest is invalid: {0}")]
    InvalidVendorManifest(String),
    #[error("COLMAP dataset is incomplete: {0}")]
    InvalidColmapDataset(String),
    #[error("Brush scratch disk has {available_bytes} bytes free but this run needs up to {required_bytes} bytes")]
    InsufficientScratchSpace {
        available_bytes: u64,
        required_bytes: u64,
    },
    #[error("Brush command failed with exit code {exit_code:?}: {message}")]
    CommandFailed {
        exit_code: Option<i32>,
        message: String,
    },
    #[error("Brush job cancellation was requested")]
    Cancelled,
    #[error("job progress sink rejected an update: {0}")]
    Progress(String),
    #[error("required Brush output is missing: {0}")]
    MissingOutput(PathBuf),
    #[error("invalid Brush PLY {path}: {reason}")]
    InvalidPly { path: PathBuf, reason: String },
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl BrushRuntimeError {
    fn code(&self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::HashMismatch { .. } | Self::InvalidHash { .. } => "toolTrust",
            Self::UnsupportedVersion(_) | Self::InvalidVendorManifest(_) => "toolCapability",
            Self::CommandFailed { .. } => "brushCommand",
            Self::MissingOutput(_) | Self::InvalidPly { .. } => "invalidWorkerOutput",
            Self::Progress(_) => "progressSink",
            Self::Io(_) => "io",
            Self::Json(_) => "json",
            _ => "invalidInput",
        }
    }
}

impl From<BrushRuntimeError> for JobWorkerError {
    fn from(error: BrushRuntimeError) -> Self {
        match error {
            BrushRuntimeError::Cancelled => Self::Cancelled,
            other => Self::Failed {
                code: other.code().into(),
                message: other.to_string(),
            },
        }
    }
}

impl BrushRuntime {
    /// Verifies the generated vendor manifest, license, executable pin and CLI version.
    pub fn preflight(config: &BrushRuntimeConfig) -> Result<Self, BrushRuntimeError> {
        validate_hash(&config.expected_executable_sha256, "executable")?;
        validate_hash(&config.expected_license_sha256, "license")?;
        let tool_root = canonical_directory(&config.tool_root)?;
        let manifest_path = canonical_file_inside(&tool_root.join("VENDOR.json"), &tool_root)?;
        let license_path = canonical_file_inside(&tool_root.join("LICENSE"), &tool_root)?;
        let manifest_bytes = read_bounded(&manifest_path, VENDOR_MANIFEST_MAX_BYTES)?;
        let manifest: BrushVendorManifest = serde_json::from_slice(&manifest_bytes)?;
        validate_vendor_manifest(&manifest, &config.expected_executable_sha256)?;
        let observed_license = hash_file(&license_path)?;
        verify_hash(
            &license_path,
            &config.expected_license_sha256,
            &observed_license,
        )?;
        let license_bytes = read_bounded(&license_path, LICENSE_MAX_BYTES)?;
        let license = String::from_utf8_lossy(&license_bytes);
        if !license.contains("Apache License") || !license.contains("Version 2.0") {
            return Err(BrushRuntimeError::InvalidVendorManifest(
                "LICENSE is not the Apache License 2.0 text".into(),
            ));
        }
        let executable_name = if cfg!(windows) {
            "brush_app.exe"
        } else {
            "brush_app"
        };
        let executable = canonical_file_inside(&tool_root.join(executable_name), &tool_root)?;
        let observed_executable = hash_file(&executable)?;
        verify_hash(
            &executable,
            &config.expected_executable_sha256,
            &observed_executable,
        )?;
        let version = probe_version(&executable)?;
        if version != BRUSH_VERSION {
            return Err(BrushRuntimeError::UnsupportedVersion(version));
        }
        Self::finish_preflight(
            executable,
            observed_executable,
            version,
            &config.scratch_root,
            &config.allowed_dataset_roots,
        )
    }

    /// Probes a local executable without claiming release trust.
    pub fn development_preflight(
        config: &DevBrushRuntimeConfig,
    ) -> Result<Self, BrushRuntimeError> {
        let executable =
            config
                .executable
                .canonicalize()
                .map_err(|error| BrushRuntimeError::InvalidPath {
                    path: config.executable.clone(),
                    reason: error.to_string(),
                })?;
        if !executable.is_file() {
            return Err(BrushRuntimeError::InvalidPath {
                path: executable,
                reason: "Brush executable is not a regular file".into(),
            });
        }
        let version = probe_version(&executable)?;
        if version != BRUSH_VERSION {
            return Err(BrushRuntimeError::UnsupportedVersion(version));
        }
        let executable_sha256 = hash_file(&executable)?;
        Self::finish_preflight(
            executable,
            executable_sha256,
            version,
            &config.scratch_root,
            &config.allowed_dataset_roots,
        )
    }

    fn finish_preflight(
        executable: PathBuf,
        executable_sha256: ObjectHash,
        version: String,
        scratch_root: &Path,
        allowed_dataset_roots: &[PathBuf],
    ) -> Result<Self, BrushRuntimeError> {
        fs::create_dir_all(scratch_root)?;
        let scratch_root = canonical_directory(scratch_root)?;
        let allowed_dataset_roots = allowed_dataset_roots
            .iter()
            .map(|path| canonical_directory(path))
            .collect::<Result<Vec<_>, _>>()?;
        if allowed_dataset_roots.is_empty() {
            return Err(BrushRuntimeError::InvalidConfig(
                "at least one allowed dataset root is required".into(),
            ));
        }
        Ok(Self {
            tool: Arc::new(VerifiedBrushTool {
                executable,
                executable_sha256,
                version,
            }),
            scratch_root,
            allowed_dataset_roots: Arc::new(allowed_dataset_roots),
        })
    }

    /// Runs Brush in an isolated directory and atomically validates its final PLY.
    pub fn run(
        &self,
        request: &BrushRunRequest,
        context: &JobWorkerContext,
    ) -> Result<BrushRunOutcome, BrushRuntimeError> {
        request.validate()?;
        context.check_cancelled().map_err(map_worker_error)?;
        let dataset_root = self.validate_dataset_root(&request.colmap_dataset_root)?;
        validate_colmap_dataset(&dataset_root)?;
        let dataset_sha256 = summarize_colmap_dataset(&dataset_root, &context.cancellation)?;
        let scratch = create_scratch(&self.scratch_root, &request.job_id)?;
        create_workspace(&scratch)?;
        validate_scratch_capacity(&scratch, &request.settings)?;
        report(context, request.progress_plan().progress(0, 0, Some(1)))?;

        let source = if let Some(resume) = &request.resume {
            let checkpoint = self.validate_resume(resume, &context.cancellation)?;
            materialize_resume_dataset(
                &dataset_root,
                &checkpoint,
                &scratch.join("resume-dataset"),
                &context.cancellation,
            )?;
            scratch.join("resume-dataset")
        } else {
            dataset_root
        };
        report(context, request.progress_plan().progress(0, 1, Some(1)))?;
        report(
            context,
            request.progress_plan().progress(
                1,
                request
                    .resume
                    .as_ref()
                    .map_or(0, |resume| u64::from(resume.completed_iterations)),
                Some(u64::from(request.settings.iterations)),
            ),
        )?;

        let export_directory = scratch.join("checkpoints");
        let command_arguments = build_args(request, &source, &export_directory);
        let audited_argv = command_arguments
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let started = Instant::now();
        let mut child = self.spawn_child(&command_arguments, &scratch)?;
        let mut progress_error = None;
        let progress_floor = request
            .resume
            .as_ref()
            .map_or(0, |resume| u64::from(resume.completed_iterations));
        let process = supervise_child(&mut child, &context.cancellation, |completed, total| {
            if completed >= progress_floor && progress_error.is_none() {
                progress_error = report(
                    context,
                    request.progress_plan().progress(1, completed, Some(total)),
                )
                .err();
            }
        })?;
        if let Some(error) = progress_error {
            return Err(error);
        }
        let command = BrushCommandReport {
            argv: audited_argv,
            exit_code: process.status.code(),
            duration_ms: millis_u64(started.elapsed()),
            log_tail: process.log_tail,
        };
        if !process.status.success() {
            return Err(BrushRuntimeError::CommandFailed {
                exit_code: command.exit_code,
                message: command
                    .log_tail
                    .last()
                    .cloned()
                    .unwrap_or_else(|| "worker produced no diagnostic output".into()),
            });
        }
        self.finalize_run(request, context, scratch, dataset_sha256, command)
    }

    fn finalize_run(
        &self,
        request: &BrushRunRequest,
        context: &JobWorkerContext,
        scratch: PathBuf,
        dataset_sha256: ObjectHash,
        command: BrushCommandReport,
    ) -> Result<BrushRunOutcome, BrushRuntimeError> {
        context.check_cancelled().map_err(map_worker_error)?;
        report(context, request.progress_plan().progress(2, 0, Some(1)))?;
        let export_directory = scratch.join("checkpoints");
        let mut checkpoints =
            collect_checkpoints(&export_directory, &request.settings, &context.cancellation)?;
        let latest = checkpoints
            .last()
            .cloned()
            .ok_or_else(|| BrushRuntimeError::MissingOutput(export_directory.clone()))?;
        let latest_path = scratch.join(&latest.relative_path);
        let output_path = scratch.join("output/gaussian-splat.ply");
        atomic_copy(&latest_path, &output_path)?;
        let validated_final = validate_ply(
            &output_path,
            request.settings.spherical_harmonics_degree,
            request.settings.maximum_splats,
        )?;
        let final_output = BrushCheckpointSummary {
            iteration: latest.iteration,
            relative_path: PathBuf::from("output/gaussian-splat.ply"),
            sha256: validated_final.sha256,
            bytes: validated_final.bytes,
            splat_count: validated_final.splat_count,
        };
        if !request.settings.retain_training_checkpoints {
            for checkpoint in &checkpoints {
                let _ = fs::remove_file(scratch.join(&checkpoint.relative_path));
            }
            checkpoints.clear();
        }
        let summary = BrushOutputSummary {
            schema_version: OUTPUT_SUMMARY_SCHEMA_VERSION,
            job_id: request.job_id.clone(),
            brush_version: self.tool.version.clone(),
            executable_sha256: self.tool.executable_sha256.clone(),
            dataset_sha256,
            resumed_from_sha256: request
                .resume
                .as_ref()
                .map(|value| value.ply_sha256.clone()),
            settings: request.settings.clone(),
            command,
            final_output,
            retained_checkpoints: checkpoints,
        };
        let summary_bytes = serde_json::to_vec_pretty(&summary)?;
        let summary_sha256 = ObjectHash::of_bytes(&summary_bytes);
        let summary_path = scratch.join("output-summary.json");
        atomic_write(&summary_path, &summary_bytes)?;
        report(context, request.progress_plan().progress(2, 1, Some(1)))?;
        Ok(BrushRunOutcome {
            scratch_path: scratch,
            output_path,
            summary_path,
            summary_sha256,
            summary,
            prepared_splats: None,
        })
    }

    /// Adapter for `JobManager::start`.
    pub fn run_as_job(
        &self,
        request: &BrushRunRequest,
        context: &JobWorkerContext,
    ) -> JobWorkerResult {
        self.run(request, context)
            .map(|_| ())
            .map_err(JobWorkerError::from)
    }

    /// Finds only fully written, schema-valid PLY checkpoints for a prior job ID.
    pub fn recovery_checkpoints(
        &self,
        job_id: &str,
        settings: &BrushTrainingSettings,
    ) -> Result<Vec<BrushRecoveryCheckpoint>, BrushRuntimeError> {
        validate_component("jobId", job_id)?;
        settings.validate()?;
        let prefix = format!("brush-{job_id}-");
        let cancellation = CancellationToken::new();
        let mut recovered = Vec::new();
        for entry in fs::read_dir(&self.scratch_root)? {
            let entry = entry?;
            let scratch = entry.path();
            if !scratch
                .file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| name.starts_with(&prefix))
            {
                continue;
            }
            let canonical = scratch.canonicalize()?;
            if !canonical.starts_with(&self.scratch_root) || !canonical.is_dir() {
                continue;
            }
            let checkpoint_directory = canonical.join("checkpoints");
            if !checkpoint_directory.is_dir() {
                continue;
            }
            for checkpoint in
                collect_available_checkpoints(&checkpoint_directory, settings, &cancellation)?
            {
                let checkpoint_path = canonical.join(&checkpoint.relative_path);
                recovered.push(BrushRecoveryCheckpoint {
                    scratch_path: canonical.clone(),
                    checkpoint_path,
                    checkpoint,
                });
            }
        }
        recovered.sort_by(|left, right| {
            left.checkpoint
                .iteration
                .cmp(&right.checkpoint.iteration)
                .then_with(|| left.scratch_path.cmp(&right.scratch_path))
        });
        Ok(recovered)
    }

    fn validate_dataset_root(&self, path: &Path) -> Result<PathBuf, BrushRuntimeError> {
        let canonical = canonical_directory(path)?;
        if !self
            .allowed_dataset_roots
            .iter()
            .any(|root| canonical.starts_with(root))
        {
            return Err(BrushRuntimeError::DatasetOutsideAllowedRoots(canonical));
        }
        Ok(canonical)
    }

    fn validate_resume(
        &self,
        resume: &BrushResumeCheckpoint,
        cancellation: &CancellationToken,
    ) -> Result<PathBuf, BrushRuntimeError> {
        let path =
            resume
                .ply_path
                .canonicalize()
                .map_err(|error| BrushRuntimeError::InvalidPath {
                    path: resume.ply_path.clone(),
                    reason: error.to_string(),
                })?;
        let allowed = path.starts_with(&self.scratch_root)
            || self
                .allowed_dataset_roots
                .iter()
                .any(|root| path.starts_with(root));
        if !allowed || !path.is_file() {
            return Err(BrushRuntimeError::PathOutsideTrustedRoot(path));
        }
        cancellation
            .check()
            .map_err(|_| BrushRuntimeError::Cancelled)?;
        let observed = hash_file(&path)?;
        verify_hash(&path, &resume.ply_sha256, &observed)?;
        Ok(path)
    }

    fn spawn_child(&self, args: &[OsString], scratch: &Path) -> Result<Child, BrushRuntimeError> {
        let home = scratch.join("home");
        let temp = scratch.join("tmp");
        // Shader compilation is independent of a job's immutable inputs. A
        // project-local shared cache avoids paying several minutes again on
        // Mesa/Vulkan while checkpoints and outputs remain job-isolated.
        let cache = self.scratch_root.join("shared-cache");
        fs::create_dir_all(&cache)?;
        let cancel_file = scratch.join("cancel.requested");
        let mut command = Command::new(&self.tool.executable);
        command
            .args(args)
            .current_dir(scratch)
            .env_clear()
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("TMPDIR", &temp)
            .env("TEMP", &temp)
            .env("TMP", &temp)
            .env("XDG_CACHE_HOME", &cache)
            .env("WGPU_CACHE_PATH", cache.join("wgpu"))
            .env("HIMMELCAD_CANCEL_FILE", cancel_file)
            .env("HIMMELCAD_NETWORK", "off")
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("HTTP_PROXY", "http://127.0.0.1:9")
            .env("HTTPS_PROXY", "http://127.0.0.1:9")
            .env("ALL_PROXY", "http://127.0.0.1:9")
            .env("NO_PROXY", "")
            .env("LC_ALL", "C")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.spawn().map_err(BrushRuntimeError::Io)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrushVendorManifest {
    name: String,
    upstream: String,
    license: String,
    version: String,
    platform: String,
    sha256: String,
    artifacts: BTreeMap<String, VendorArtifact>,
    #[serde(rename = "fetchedAt")]
    fetched_at: String,
    note: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VendorArtifact {
    sha256: ObjectHash,
}

fn validate_vendor_manifest(
    manifest: &BrushVendorManifest,
    expected_executable: &ObjectHash,
) -> Result<(), BrushRuntimeError> {
    if manifest.name != "brush"
        || manifest.upstream != "https://github.com/ArthurBrussee/brush"
        || manifest.license != "Apache-2.0"
        || manifest.version != BRUSH_VERSION
    {
        return Err(BrushRuntimeError::InvalidVendorManifest(
            "identity, upstream, license or version differs from the curated Brush release".into(),
        ));
    }
    if manifest.platform.trim().is_empty()
        || manifest.sha256.len() != 64
        || manifest.fetched_at.trim().is_empty()
        || manifest.note.trim().is_empty()
    {
        return Err(BrushRuntimeError::InvalidVendorManifest(
            "platform/archive hash/audit metadata is incomplete".into(),
        ));
    }
    let executable_name = if cfg!(windows) {
        "brush_app.exe"
    } else {
        "brush_app"
    };
    let artifact = manifest.artifacts.get(executable_name).ok_or_else(|| {
        BrushRuntimeError::InvalidVendorManifest("executable artifact is absent".into())
    })?;
    if &artifact.sha256 != expected_executable {
        return Err(BrushRuntimeError::InvalidVendorManifest(
            "manifest executable hash differs from the release pin".into(),
        ));
    }
    Ok(())
}

fn build_args(request: &BrushRunRequest, source: &Path, exports: &Path) -> Vec<OsString> {
    let settings = &request.settings;
    let mut args = vec![
        source.as_os_str().to_owned(),
        os("--total-steps"),
        os(settings.iterations.to_string()),
        os("--sh-degree"),
        os(settings.spherical_harmonics_degree.to_string()),
        os("--max-splats"),
        os(settings.maximum_splats.to_string()),
        os("--max-resolution"),
        os(settings.maximum_resolution.to_string()),
        os("--seed"),
        os(settings.seed.to_string()),
        os("--export-every"),
        os(settings.checkpoint_every.to_string()),
        os("--export-path"),
        exports.as_os_str().to_owned(),
        os("--export-name"),
        os("checkpoint_{iter}.ply"),
    ];
    if let Some(resume) = &request.resume {
        args.push(os("--start-iter"));
        args.push(os(resume.completed_iterations.to_string()));
    }
    args
}

fn validate_colmap_dataset(root: &Path) -> Result<(), BrushRuntimeError> {
    let has_cameras = find_named_file(root, &["cameras.bin", "cameras.txt"])?;
    let has_images_model = find_named_file(root, &["images.bin", "images.txt"])?;
    if !has_cameras || !has_images_model {
        return Err(BrushRuntimeError::InvalidColmapDataset(
            "cameras.bin/txt and images.bin/txt are required".into(),
        ));
    }
    let has_image = find_extension(root, &["jpg", "jpeg", "png", "webp", "exr"])?;
    if !has_image {
        return Err(BrushRuntimeError::InvalidColmapDataset(
            "no supported training image was found".into(),
        ));
    }
    Ok(())
}

fn find_named_file(root: &Path, names: &[&str]) -> Result<bool, BrushRuntimeError> {
    walk_tree(root, &CancellationToken::new(), |path| {
        Ok(path
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| names.contains(&name)))
    })
}

fn find_extension(root: &Path, extensions: &[&str]) -> Result<bool, BrushRuntimeError> {
    walk_tree(root, &CancellationToken::new(), |path| {
        Ok(path
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|extension| extensions.contains(&extension.to_ascii_lowercase().as_str())))
    })
}

fn walk_tree<F>(
    root: &Path,
    cancellation: &CancellationToken,
    mut predicate: F,
) -> Result<bool, BrushRuntimeError>
where
    F: FnMut(&Path) -> Result<bool, BrushRuntimeError>,
{
    let mut stack = vec![root.to_owned()];
    while let Some(directory) = stack.pop() {
        cancellation
            .check()
            .map_err(|_| BrushRuntimeError::Cancelled)?;
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                return Err(BrushRuntimeError::PathOutsideTrustedRoot(path));
            }
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() && predicate(&path)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn summarize_colmap_dataset(
    root: &Path,
    cancellation: &CancellationToken,
) -> Result<ObjectHash, BrushRuntimeError> {
    let mut paths = Vec::new();
    collect_files(root, root, cancellation, &mut paths)?;
    paths.sort();
    let mut digest = Sha256::new();
    for relative in paths {
        cancellation
            .check()
            .map_err(|_| BrushRuntimeError::Cancelled)?;
        let absolute = root.join(&relative);
        digest.update(relative.to_string_lossy().as_bytes());
        let mut file = File::open(absolute)?;
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            cancellation
                .check()
                .map_err(|_| BrushRuntimeError::Cancelled)?;
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
    }
    Ok(ObjectHash(hex::encode(digest.finalize())))
}

fn collect_files(
    root: &Path,
    directory: &Path,
    cancellation: &CancellationToken,
    output: &mut Vec<PathBuf>,
) -> Result<(), BrushRuntimeError> {
    for entry in fs::read_dir(directory)? {
        cancellation
            .check()
            .map_err(|_| BrushRuntimeError::Cancelled)?;
        let entry = entry?;
        let path = entry.path();
        if fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(BrushRuntimeError::PathOutsideTrustedRoot(path));
        }
        let canonical = path.canonicalize()?;
        if !canonical.starts_with(root) {
            return Err(BrushRuntimeError::PathOutsideTrustedRoot(path));
        }
        if canonical.is_dir() {
            collect_files(root, &canonical, cancellation, output)?;
        } else if canonical.is_file() {
            output.push(
                path.strip_prefix(root)
                    .map_err(|_| BrushRuntimeError::PathOutsideTrustedRoot(path.clone()))?
                    .to_owned(),
            );
        }
    }
    Ok(())
}

fn materialize_resume_dataset(
    source: &Path,
    checkpoint: &Path,
    destination: &Path,
    cancellation: &CancellationToken,
) -> Result<(), BrushRuntimeError> {
    fs::create_dir_all(destination)?;
    materialize_tree(source, source, destination, cancellation)?;
    let init = destination.join("init.ply");
    if init.exists() {
        fs::remove_file(&init)?;
    }
    link_or_copy(checkpoint, &init)?;
    Ok(())
}

fn materialize_tree(
    root: &Path,
    directory: &Path,
    destination: &Path,
    cancellation: &CancellationToken,
) -> Result<(), BrushRuntimeError> {
    for entry in fs::read_dir(directory)? {
        cancellation
            .check()
            .map_err(|_| BrushRuntimeError::Cancelled)?;
        let entry = entry?;
        let path = entry.path();
        if fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(BrushRuntimeError::PathOutsideTrustedRoot(path));
        }
        let canonical = path.canonicalize()?;
        if !canonical.starts_with(root) {
            return Err(BrushRuntimeError::PathOutsideTrustedRoot(path));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| BrushRuntimeError::PathOutsideTrustedRoot(path.clone()))?;
        let target = destination.join(relative);
        if canonical.is_dir() {
            fs::create_dir_all(&target)?;
            materialize_tree(root, &canonical, destination, cancellation)?;
        } else if canonical.is_file() {
            if target.file_name().and_then(OsStr::to_str) == Some("init.ply") {
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            link_or_copy(&canonical, &target)?;
        }
    }
    Ok(())
}

fn link_or_copy(source: &Path, destination: &Path) -> Result<(), BrushRuntimeError> {
    if fs::hard_link(source, destination).is_err() {
        fs::copy(source, destination)?;
    }
    Ok(())
}

#[derive(Debug)]
struct ProcessOutcome {
    status: ExitStatus,
    log_tail: Vec<String>,
}

#[derive(Debug)]
struct LogEvent {
    stream: &'static str,
    record: String,
}

fn supervise_child<F>(
    child: &mut Child,
    cancellation: &CancellationToken,
    mut progress: F,
) -> Result<ProcessOutcome, BrushRuntimeError>
where
    F: FnMut(u64, u64),
{
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Brush stdout was not piped"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("Brush stderr was not piped"))?;
    let (sender, receiver) = mpsc::channel();
    let stdout_reader = spawn_log_reader(stdout, "stdout", sender.clone());
    let stderr_reader = spawn_log_reader(stderr, "stderr", sender);
    let mut tail = VecDeque::with_capacity(LOG_TAIL_LINES);
    let mut last_progress = None;
    let status = loop {
        drain_events(&receiver, &mut tail, &mut last_progress, &mut progress);
        if cancellation.is_cancel_requested() {
            request_cooperative_stop(child);
            let deadline = Instant::now() + COOPERATIVE_CANCEL_GRACE;
            while Instant::now() < deadline {
                if child.try_wait()?.is_some() {
                    break;
                }
                thread::sleep(CANCEL_POLL_INTERVAL);
            }
            if child.try_wait()?.is_none() {
                child.kill()?;
            }
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(BrushRuntimeError::Cancelled);
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        match receiver.recv_timeout(CANCEL_POLL_INTERVAL) {
            Ok(event) => push_event(&mut tail, &mut last_progress, &mut progress, &event),
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {}
        }
    };
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    drain_events(&receiver, &mut tail, &mut last_progress, &mut progress);
    Ok(ProcessOutcome {
        status,
        log_tail: tail.into_iter().collect(),
    })
}

fn request_cooperative_stop(child: &mut Child) {
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&[3]);
        let _ = stdin.flush();
    }
}

fn spawn_log_reader<R>(
    mut reader: R,
    stream: &'static str,
    sender: mpsc::Sender<LogEvent>,
) -> thread::JoinHandle<io::Result<()>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut chunk = [0_u8; 4096];
        let mut record = Vec::new();
        loop {
            let read = reader.read(&mut chunk)?;
            if read == 0 {
                if !record.is_empty() {
                    send_record(&sender, stream, &record);
                }
                return Ok(());
            }
            for byte in &chunk[..read] {
                if matches!(*byte, b'\n' | b'\r') {
                    if !record.is_empty() {
                        send_record(&sender, stream, &record);
                        record.clear();
                    }
                } else if record.len() < MAX_LOG_RECORD_BYTES {
                    record.push(*byte);
                }
            }
        }
    })
}

fn send_record(sender: &mpsc::Sender<LogEvent>, stream: &'static str, bytes: &[u8]) {
    let _ = sender.send(LogEvent {
        stream,
        record: strip_ansi(&String::from_utf8_lossy(bytes)),
    });
}

fn drain_events<F>(
    receiver: &mpsc::Receiver<LogEvent>,
    tail: &mut VecDeque<String>,
    last_progress: &mut Option<(u64, u64)>,
    progress: &mut F,
) where
    F: FnMut(u64, u64),
{
    while let Ok(event) = receiver.try_recv() {
        push_event(tail, last_progress, progress, &event);
    }
}

fn push_event<F>(
    tail: &mut VecDeque<String>,
    last_progress: &mut Option<(u64, u64)>,
    progress: &mut F,
    event: &LogEvent,
) where
    F: FnMut(u64, u64),
{
    if tail.len() == LOG_TAIL_LINES {
        tail.pop_front();
    }
    if let Some(value) = parse_training_progress(&event.record) {
        let accept =
            last_progress.is_none_or(|previous| value.1 == previous.1 && value.0 > previous.0);
        if accept {
            *last_progress = Some(value);
            progress(value.0, value.1);
        }
    }
    tail.push_back(format!("{}: {}", event.stream, event.record));
}

fn parse_training_progress(line: &str) -> Option<(u64, u64)> {
    for token in line.split_whitespace() {
        let Some((left, right)) = token.split_once('/') else {
            continue;
        };
        let left = left.trim_matches(|character: char| !character.is_ascii_digit());
        let right = right.trim_matches(|character: char| !character.is_ascii_digit());
        let completed = left.parse::<u64>().ok()?;
        let total = right.parse::<u64>().ok()?;
        if total > 0 && completed <= total {
            return Some((completed, total));
        }
    }
    None
}

fn strip_ansi(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else if !character.is_control() || character == '\t' {
            output.push(character);
        }
    }
    output
}

#[derive(Debug)]
struct ValidatedPly {
    sha256: ObjectHash,
    bytes: u64,
    splat_count: u64,
}

fn collect_checkpoints(
    directory: &Path,
    settings: &BrushTrainingSettings,
    cancellation: &CancellationToken,
) -> Result<Vec<BrushCheckpointSummary>, BrushRuntimeError> {
    let values = collect_available_checkpoints(directory, settings, cancellation)?;
    // Brush names the final export after the completed step count (for
    // example checkpoint_100.ply for --total-steps 100).
    let expected_final = settings.iterations;
    if values.last().map(|value| value.iteration) != Some(expected_final) {
        return Err(BrushRuntimeError::MissingOutput(
            directory.join(format!("checkpoint_{expected_final}.ply")),
        ));
    }
    Ok(values)
}

fn collect_available_checkpoints(
    directory: &Path,
    settings: &BrushTrainingSettings,
    cancellation: &CancellationToken,
) -> Result<Vec<BrushCheckpointSummary>, BrushRuntimeError> {
    if !directory.is_dir() {
        return Err(BrushRuntimeError::MissingOutput(directory.to_owned()));
    }
    let mut values = Vec::new();
    for entry in fs::read_dir(directory)? {
        cancellation
            .check()
            .map_err(|_| BrushRuntimeError::Cancelled)?;
        let entry = entry?;
        let path = entry.path();
        let Some(iteration) = checkpoint_iteration(&path) else {
            continue;
        };
        if iteration > settings.iterations {
            return Err(BrushRuntimeError::InvalidPly {
                path,
                reason: "checkpoint iteration exceeds the configured run".into(),
            });
        }
        let validated = validate_ply(
            &path,
            settings.spherical_harmonics_degree,
            settings.maximum_splats,
        )?;
        values.push(BrushCheckpointSummary {
            iteration,
            relative_path: PathBuf::from("checkpoints").join(
                path.file_name()
                    .ok_or_else(|| BrushRuntimeError::MissingOutput(path.clone()))?,
            ),
            sha256: validated.sha256,
            bytes: validated.bytes,
            splat_count: validated.splat_count,
        });
    }
    values.sort_by_key(|checkpoint| checkpoint.iteration);
    Ok(values)
}

fn checkpoint_iteration(path: &Path) -> Option<u32> {
    let stem = path.file_stem()?.to_str()?;
    let value = stem.strip_prefix("checkpoint_")?;
    if path.extension()?.to_str()? != "ply" {
        return None;
    }
    value.parse().ok()
}

fn validate_ply(
    path: &Path,
    sh_degree: u8,
    max_splats: u64,
) -> Result<ValidatedPly, BrushRuntimeError> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(invalid_ply(path, "file is empty or not regular"));
    }
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let header = parse_ply_header(&mut reader, path)?;
    let (splat_count, property_count) = validate_ply_schema(&header, sh_degree, max_splats, path)?;
    if header.format == "binary_little_endian" {
        let expected_bytes = u64::try_from(header.bytes)
            .unwrap_or(u64::MAX)
            .saturating_add(splat_count.saturating_mul(property_count).saturating_mul(4));
        if metadata.len() != expected_bytes {
            return Err(invalid_ply(
                path,
                "binary vertex payload length does not match its schema",
            ));
        }
    } else {
        validate_ascii_payload(
            &mut reader,
            splat_count.saturating_mul(property_count),
            path,
        )?;
    }
    Ok(ValidatedPly {
        sha256: hash_file(path)?,
        bytes: metadata.len(),
        splat_count,
    })
}

struct PlyHeader {
    format: String,
    vertex_count: u64,
    properties: BTreeMap<String, String>,
    bytes: usize,
}

fn parse_ply_header(
    reader: &mut impl BufRead,
    path: &Path,
) -> Result<PlyHeader, BrushRuntimeError> {
    let mut header_bytes = 0_usize;
    let mut first = String::new();
    reader.read_line(&mut first)?;
    header_bytes += first.len();
    if first.trim_end() != "ply" {
        return Err(invalid_ply(path, "missing PLY magic"));
    }
    let mut format: Option<String> = None;
    let mut vertex_count = None;
    let mut in_vertex = false;
    let mut properties = BTreeMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Err(invalid_ply(path, "header has no end_header"));
        }
        header_bytes += line.len();
        if header_bytes > PLY_HEADER_MAX_BYTES {
            return Err(invalid_ply(path, "header exceeds the bounded limit"));
        }
        let tokens = line.split_whitespace().collect::<Vec<_>>();
        match tokens.as_slice() {
            ["format", value, "1.0"] => format = Some((*value).to_owned()),
            ["element", "vertex", count] => {
                vertex_count = count.parse::<u64>().ok();
                in_vertex = true;
            }
            ["element", ..] => in_vertex = false,
            ["property", scalar_type, name] if in_vertex => {
                if !matches!(*scalar_type, "float" | "float32") {
                    return Err(invalid_ply(path, "all Gaussian properties must be float32"));
                }
                if properties
                    .insert((*name).to_owned(), (*scalar_type).to_owned())
                    .is_some()
                {
                    return Err(invalid_ply(path, "duplicate vertex property"));
                }
            }
            ["end_header"] => break,
            _ => {}
        }
    }
    let format = format.ok_or_else(|| invalid_ply(path, "format declaration is missing"))?;
    if !matches!(format.as_str(), "binary_little_endian" | "ascii") {
        return Err(invalid_ply(
            path,
            "only little-endian binary or ASCII PLY is accepted",
        ));
    }
    Ok(PlyHeader {
        format,
        vertex_count: vertex_count.ok_or_else(|| invalid_ply(path, "vertex count is missing"))?,
        properties,
        bytes: header_bytes,
    })
}

fn validate_ply_schema(
    header: &PlyHeader,
    sh_degree: u8,
    max_splats: u64,
    path: &Path,
) -> Result<(u64, u64), BrushRuntimeError> {
    let splat_count = header.vertex_count;
    if splat_count == 0 || splat_count > max_splats {
        return Err(invalid_ply(
            path,
            "vertex count is zero or exceeds maximumSplats",
        ));
    }
    for required in [
        "x", "y", "z", "scale_0", "scale_1", "scale_2", "opacity", "rot_0", "rot_1", "rot_2",
        "rot_3", "f_dc_0", "f_dc_1", "f_dc_2",
    ] {
        if !header.properties.contains_key(required) {
            return Err(invalid_ply(
                path,
                &format!("required property {required} is missing"),
            ));
        }
    }
    let expected_rest = 3 * (((u32::from(sh_degree) + 1).pow(2)) - 1);
    for index in 0..expected_rest {
        if !header.properties.contains_key(&format!("f_rest_{index}")) {
            return Err(invalid_ply(
                path,
                "SH property set does not match requested degree",
            ));
        }
    }
    if header
        .properties
        .keys()
        .filter_map(|name| name.strip_prefix("f_rest_"))
        .filter_map(|index| index.parse::<u32>().ok())
        .any(|index| index >= expected_rest)
    {
        return Err(invalid_ply(
            path,
            "PLY contains a higher SH degree than requested",
        ));
    }
    let property_count = 14_u64 + u64::from(expected_rest);
    if u64::try_from(header.properties.len()).unwrap_or(u64::MAX) != property_count {
        return Err(invalid_ply(
            path,
            "PLY contains properties outside the Brush Gaussian schema",
        ));
    }
    Ok((splat_count, property_count))
}

fn validate_ascii_payload(
    reader: &mut impl Read,
    expected_tokens: u64,
    path: &Path,
) -> Result<(), BrushRuntimeError> {
    let mut tokens = 0_u64;
    let mut inside_token = false;
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            if byte.is_ascii_whitespace() {
                if inside_token {
                    tokens = tokens.saturating_add(1);
                    inside_token = false;
                }
            } else {
                inside_token = true;
            }
        }
        if tokens > expected_tokens {
            return Err(invalid_ply(path, "ASCII vertex payload has excess values"));
        }
    }
    if inside_token {
        tokens = tokens.saturating_add(1);
    }
    if tokens != expected_tokens {
        return Err(invalid_ply(
            path,
            "ASCII vertex payload length does not match its schema",
        ));
    }
    Ok(())
}

fn invalid_ply(path: &Path, reason: &str) -> BrushRuntimeError {
    BrushRuntimeError::InvalidPly {
        path: path.to_owned(),
        reason: reason.into(),
    }
}

fn probe_version(executable: &Path) -> Result<String, BrushRuntimeError> {
    let mut child = Command::new(executable)
        .arg("--version")
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let deadline = Instant::now() + VERSION_PROBE_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                return Err(BrushRuntimeError::InvalidConfig(
                    "Brush --version probe failed".into(),
                ));
            }
            let mut output = String::new();
            if let Some(stdout) = child.stdout.take() {
                stdout.take(4096).read_to_string(&mut output)?;
            }
            if let Some(stderr) = child.stderr.take() {
                stderr.take(4096).read_to_string(&mut output)?;
            }
            let version = output
                .split_whitespace()
                .find(|token| token.chars().next().is_some_and(|c| c.is_ascii_digit()))
                .ok_or_else(|| {
                    BrushRuntimeError::InvalidConfig(
                        "Brush --version did not return a semantic version".into(),
                    )
                })?;
            return Ok(version.to_owned());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(BrushRuntimeError::InvalidConfig(
                "Brush --version probe timed out".into(),
            ));
        }
        thread::sleep(CANCEL_POLL_INTERVAL);
    }
}

fn create_workspace(scratch: &Path) -> Result<(), BrushRuntimeError> {
    for relative in ["home", "tmp", "cache", "checkpoints", "output"] {
        fs::create_dir_all(scratch.join(relative))?;
    }
    Ok(())
}

fn validate_scratch_capacity(
    scratch: &Path,
    settings: &BrushTrainingSettings,
) -> Result<(), BrushRuntimeError> {
    let coefficient_count = 14_u64.saturating_add(
        3_u64.saturating_mul(
            (u64::from(settings.spherical_harmonics_degree) + 1)
                .pow(2)
                .saturating_sub(1),
        ),
    );
    let checkpoint_bytes = settings
        .maximum_splats
        .saturating_mul(coefficient_count)
        .saturating_mul(4);
    let checkpoint_count =
        u64::from(settings.iterations / settings.checkpoint_every).saturating_add(2);
    let required_bytes = checkpoint_bytes
        .saturating_mul(checkpoint_count)
        .saturating_add(checkpoint_bytes / 5)
        .saturating_add(64 * 1024 * 1024);
    let available_bytes = fs2::available_space(scratch)?;
    if available_bytes < required_bytes {
        return Err(BrushRuntimeError::InsufficientScratchSpace {
            available_bytes,
            required_bytes,
        });
    }
    Ok(())
}

fn create_scratch(root: &Path, job_id: &str) -> Result<PathBuf, BrushRuntimeError> {
    for _ in 0..128 {
        let sequence = NEXT_SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = root.join(format!("brush-{job_id}-{sequence:016x}"));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(BrushRuntimeError::InvalidConfig(
        "could not allocate a unique Brush scratch directory".into(),
    ))
}

fn report(context: &JobWorkerContext, progress: JobProgress) -> Result<(), BrushRuntimeError> {
    context
        .progress
        .report_blocking(progress)
        .map(|_| ())
        .map_err(|error| BrushRuntimeError::Progress(error.to_string()))
}

fn map_worker_error(error: JobWorkerError) -> BrushRuntimeError {
    match error {
        JobWorkerError::Cancelled => BrushRuntimeError::Cancelled,
        JobWorkerError::Failed { message, .. } => BrushRuntimeError::Progress(message),
    }
}

fn validate_component(field: &'static str, value: &str) -> Result<(), BrushRuntimeError> {
    let valid = !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err(BrushRuntimeError::InvalidRequest(format!(
            "{field} must be a bounded portable path component"
        )))
    }
}

fn validate_hash(value: &ObjectHash, field: &'static str) -> Result<(), BrushRuntimeError> {
    let valid = value.as_str().len() == 64
        && value
            .as_str()
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
    if valid {
        Ok(())
    } else {
        Err(BrushRuntimeError::InvalidHash {
            field,
            value: value.as_str().into(),
        })
    }
}

fn canonical_directory(path: &Path) -> Result<PathBuf, BrushRuntimeError> {
    let canonical = path
        .canonicalize()
        .map_err(|error| BrushRuntimeError::InvalidPath {
            path: path.to_owned(),
            reason: error.to_string(),
        })?;
    if canonical.is_dir() {
        Ok(canonical)
    } else {
        Err(BrushRuntimeError::InvalidPath {
            path: canonical,
            reason: "expected a directory".into(),
        })
    }
}

fn canonical_file_inside(path: &Path, root: &Path) -> Result<PathBuf, BrushRuntimeError> {
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) && !path.is_absolute()
    {
        return Err(BrushRuntimeError::PathOutsideTrustedRoot(path.to_owned()));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| BrushRuntimeError::InvalidPath {
            path: path.to_owned(),
            reason: error.to_string(),
        })?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err(BrushRuntimeError::PathOutsideTrustedRoot(canonical));
    }
    Ok(canonical)
}

fn read_bounded(path: &Path, maximum: u64) -> Result<Vec<u8>, BrushRuntimeError> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > maximum {
        return Err(BrushRuntimeError::InvalidConfig(format!(
            "{} exceeds its size limit",
            path.display()
        )));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    File::open(path)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > maximum {
        return Err(BrushRuntimeError::InvalidConfig(format!(
            "{} exceeds its size limit",
            path.display()
        )));
    }
    Ok(bytes)
}

fn hash_file(path: &Path) -> Result<ObjectHash, BrushRuntimeError> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(ObjectHash(hex::encode(digest.finalize())))
}

fn verify_hash(
    path: &Path,
    expected: &ObjectHash,
    observed: &ObjectHash,
) -> Result<(), BrushRuntimeError> {
    if expected == observed {
        Ok(())
    } else {
        Err(BrushRuntimeError::HashMismatch {
            path: path.to_owned(),
            expected: expected.clone(),
            observed: observed.clone(),
        })
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), BrushRuntimeError> {
    let parent = path
        .parent()
        .ok_or_else(|| BrushRuntimeError::InvalidPath {
            path: path.to_owned(),
            reason: "output has no parent directory".into(),
        })?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.partial",
        path.file_name().and_then(OsStr::to_str).unwrap_or("output")
    ));
    let mut file = File::create(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn atomic_copy(source: &Path, destination: &Path) -> Result<(), BrushRuntimeError> {
    let parent = destination
        .parent()
        .ok_or_else(|| BrushRuntimeError::InvalidPath {
            path: destination.to_owned(),
            reason: "output has no parent directory".into(),
        })?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(".gaussian-splat.ply.partial");
    let mut input = File::open(source)?;
    let mut output = File::create(&temporary)?;
    io::copy(&mut input, &mut output)?;
    output.sync_all()?;
    fs::rename(temporary, destination)?;
    Ok(())
}

fn millis_u64(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn os(value: impl AsRef<OsStr>) -> OsString {
    value.as_ref().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job_runtime::{JobManager, JobManagerConfig};
    use himmelcad_core::photolab_jobs::{
        NewPhotolabJob, PhotolabJobId, PhotolabJobKind, PhotolabJobState,
    };

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    struct TestRig {
        root: PathBuf,
        runtime: BrushRuntime,
    }

    impl TestRig {
        #[cfg(unix)]
        fn new(name: &str, slow: bool, invalid_ply: bool) -> Self {
            let root = std::env::temp_dir().join(format!(
                "himmelcad-brush-test-{name}-{}",
                NEXT_SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            let dataset = root.join("dataset");
            let scratch = root.join("scratch");
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(dataset.join("sparse/0")).expect("create sparse");
            fs::create_dir_all(dataset.join("images")).expect("create images");
            fs::create_dir_all(&scratch).expect("create scratch");
            fs::write(dataset.join("sparse/0/cameras.txt"), "camera").expect("camera");
            fs::write(dataset.join("sparse/0/images.txt"), "image").expect("model image");
            fs::write(dataset.join("images/photo.jpg"), "jpg").expect("image");
            let executable = root.join("brush_app");
            let ply = if invalid_ply {
                "printf 'not a ply' > \"$export_path/checkpoint_3000.ply\""
            } else {
                r#"printf 'ply\nformat ascii 1.0\ncomment Exported from Brush\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float opacity\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nend_header\n0 0 0 0 0 0 1 1 0 0 0 0 0 0\n' > "$export_path/checkpoint_3000.ply""#
            };
            let sleep = if slow {
                "while :; do sleep 1; done"
            } else {
                ""
            };
            let script = format!(
                r#"#!/bin/sh
if [ "$1" = "--version" ]; then printf 'brush-cli 0.3.0\n'; exit 0; fi
export_path=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--export-path" ]; then shift; export_path="$1"; fi
  shift
done
printf '\033[2K[00:00] 1000/3000 Steps\r' >&2
printf '[00:01] 3000/3000 Steps\n' >&2
{ply}
{sleep}
"#
            );
            fs::write(&executable, script).expect("write fake executable");
            let mut permissions = fs::metadata(&executable).expect("metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&executable, permissions).expect("permissions");
            let runtime = BrushRuntime::development_preflight(&DevBrushRuntimeConfig {
                executable,
                scratch_root: scratch,
                allowed_dataset_roots: vec![dataset],
            })
            .expect("preflight fake Brush");
            Self { root, runtime }
        }

        fn request(&self, job_id: &str) -> BrushRunRequest {
            BrushRunRequest {
                job_id: job_id.into(),
                colmap_dataset_root: self.root.join("dataset"),
                settings: BrushTrainingSettings {
                    iterations: 3_000,
                    spherical_harmonics_degree: 0,
                    maximum_splats: 100_000,
                    maximum_resolution: 1_920,
                    seed: 42,
                    checkpoint_every: 1_000,
                    retain_training_checkpoints: true,
                },
                resume: None,
            }
        }
    }

    impl Drop for TestRig {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn settings_and_path_components_are_bounded() {
        let settings = BrushTrainingSettings {
            spherical_harmonics_degree: 4,
            ..BrushTrainingSettings::default()
        };
        assert!(settings.validate().is_err());
        assert!(validate_component("jobId", "../escape").is_err());
        assert_eq!(
            parse_training_progress("[00:03]  123/30000 Steps"),
            Some((123, 30_000))
        );
        assert_eq!(strip_ansi("\u{1b}[2Khello"), "hello");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn installed_curated_linux_worker_passes_release_preflight_when_present() {
        let tool_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/brush/linux-x64");
        if !tool_root.join("brush_app").is_file() {
            return;
        }
        let allowed = std::env::temp_dir().join(format!(
            "himmelcad-brush-preflight-{}",
            NEXT_SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let scratch = allowed.join("scratch");
        fs::create_dir_all(&scratch).expect("preflight directories");
        let runtime = BrushRuntime::preflight(&BrushRuntimeConfig {
            tool_root,
            expected_executable_sha256: ObjectHash(
                "13d28ee06a388bc4e987774e890b594d60a75bba26064e82b4ee338a78f158a4".into(),
            ),
            expected_license_sha256: ObjectHash(
                "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30".into(),
            ),
            scratch_root: scratch,
            allowed_dataset_roots: vec![allowed.clone()],
        })
        .expect("curated Brush release preflight");
        assert_eq!(runtime.tool.version, BRUSH_VERSION);
        let _ = fs::remove_dir_all(allowed);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_fake_worker_and_atomically_validates_output() {
        let rig = TestRig::new("success", false, false);
        let request = rig.request("splat-success");
        let runtime = rig.runtime.clone();
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("manager");
        let id = PhotolabJobId(request.job_id.clone());
        let outcome_slot = Arc::new(std::sync::Mutex::new(None));
        let written = outcome_slot.clone();
        manager
            .start(
                NewPhotolabJob {
                    id: id.clone(),
                    kind: PhotolabJobKind::BuildGaussianSplat,
                    config_hash: ObjectHash::of_bytes(b"config"),
                    input_hash: ObjectHash::of_bytes(b"input"),
                    progress: request.progress_plan().initial_progress(),
                },
                move |context| {
                    let outcome = runtime
                        .run(&request, &context)
                        .map_err(JobWorkerError::from)?;
                    *written.lock().expect("slot") = Some(outcome);
                    Ok(())
                },
            )
            .await
            .expect("start");
        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        let outcome = outcome_slot.lock().expect("slot").take().expect("outcome");
        assert!(outcome.output_path.is_file());
        assert!(outcome.summary_path.is_file());
        assert_eq!(outcome.summary.final_output.splat_count, 1);
        assert!(outcome
            .summary
            .command
            .argv
            .contains(&"--max-resolution".into()));
        assert!(outcome
            .summary
            .command
            .log_tail
            .iter()
            .all(|line| !line.contains('\u{1b}')));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_malformed_worker_output_without_summary() {
        let rig = TestRig::new("invalid", false, true);
        let request = rig.request("splat-invalid");
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("manager");
        let id = PhotolabJobId(request.job_id.clone());
        let runtime = rig.runtime.clone();
        manager
            .start(
                NewPhotolabJob {
                    id: id.clone(),
                    kind: PhotolabJobKind::BuildGaussianSplat,
                    config_hash: ObjectHash::of_bytes(b"config"),
                    input_hash: ObjectHash::of_bytes(b"input"),
                    progress: request.progress_plan().initial_progress(),
                },
                move |context| runtime.run_as_job(&request, &context),
            )
            .await
            .expect("start");
        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert!(matches!(terminal.state, PhotolabJobState::Failed { .. }));
        assert!(!find_summary(&rig.root.join("scratch")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_is_forced_within_the_interactive_deadline() {
        let rig = TestRig::new("cancel", true, false);
        let request = rig.request("splat-cancel");
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("manager");
        let id = PhotolabJobId(request.job_id.clone());
        let runtime = rig.runtime.clone();
        let recovery_runtime = runtime.clone();
        let settings = request.settings.clone();
        manager
            .start(
                NewPhotolabJob {
                    id: id.clone(),
                    kind: PhotolabJobKind::BuildGaussianSplat,
                    config_hash: ObjectHash::of_bytes(b"config"),
                    input_hash: ObjectHash::of_bytes(b"input"),
                    progress: request.progress_plan().initial_progress(),
                },
                move |context| runtime.run_as_job(&request, &context),
            )
            .await
            .expect("start");
        let checkpoint_deadline = Instant::now() + Duration::from_secs(2);
        while recovery_runtime
            .recovery_checkpoints("splat-cancel", &settings)
            .expect("probe recovery checkpoint")
            .is_empty()
        {
            assert!(
                Instant::now() < checkpoint_deadline,
                "fake worker did not publish its recovery checkpoint"
            );
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        let started = Instant::now();
        manager.cancel(&id).await.expect("cancel");
        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!find_summary(&rig.root.join("scratch")));
        let recovery = recovery_runtime
            .recovery_checkpoints("splat-cancel", &settings)
            .expect("discover recovery checkpoint");
        assert_eq!(recovery.len(), 1);
        assert_eq!(recovery[0].checkpoint.iteration, 3_000);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resume_materializes_a_verified_init_ply_without_mutating_the_dataset() {
        let rig = TestRig::new("resume", false, false);
        let checkpoint_directory = rig.root.join("scratch/prior-job");
        fs::create_dir_all(&checkpoint_directory).expect("checkpoint directory");
        let checkpoint_path = checkpoint_directory.join("checkpoint_1999.ply");
        write_valid_degree_zero_ply(&checkpoint_path);
        let checkpoint_hash = hash_file(&checkpoint_path).expect("checkpoint hash");
        let mut request = rig.request("splat-resume");
        request.resume = Some(BrushResumeCheckpoint {
            ply_path: checkpoint_path,
            ply_sha256: checkpoint_hash.clone(),
            completed_iterations: 2_000,
        });
        let runtime = rig.runtime.clone();
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("manager");
        let id = PhotolabJobId(request.job_id.clone());
        let outcome_slot = Arc::new(std::sync::Mutex::new(None));
        let written = outcome_slot.clone();
        manager
            .start(
                NewPhotolabJob {
                    id: id.clone(),
                    kind: PhotolabJobKind::BuildGaussianSplat,
                    config_hash: ObjectHash::of_bytes(b"config"),
                    input_hash: ObjectHash::of_bytes(b"input"),
                    progress: request.progress_plan().initial_progress(),
                },
                move |context| {
                    let outcome = runtime
                        .run(&request, &context)
                        .map_err(JobWorkerError::from)?;
                    *written.lock().expect("slot") = Some(outcome);
                    Ok(())
                },
            )
            .await
            .expect("start");
        let terminal = manager.wait_for_terminal(&id).await.expect("terminal");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        let outcome = outcome_slot.lock().expect("slot").take().expect("outcome");
        assert_eq!(outcome.summary.resumed_from_sha256, Some(checkpoint_hash));
        assert!(outcome
            .scratch_path
            .join("resume-dataset/init.ply")
            .is_file());
        assert!(!rig.root.join("dataset/init.ply").exists());
        assert!(outcome
            .summary
            .command
            .argv
            .windows(2)
            .any(|values| values == ["--start-iter", "2000"]));
    }

    fn write_valid_degree_zero_ply(path: &Path) {
        fs::write(
            path,
            "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float opacity\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nend_header\n0 0 0 0 0 0 1 1 0 0 0 0 0 0\n",
        )
        .expect("write valid PLY");
    }

    fn find_summary(root: &Path) -> bool {
        fs::read_dir(root).is_ok_and(|entries| {
            entries
                .filter_map(Result::ok)
                .any(|entry| entry.path().join("output-summary.json").exists())
        })
    }
}
