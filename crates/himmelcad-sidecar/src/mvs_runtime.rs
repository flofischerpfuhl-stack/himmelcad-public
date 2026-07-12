//! Isolated orchestration and output validation for the portable Photolab MVS worker.
//!
//! The worker protocol is intentionally independent of COLMAP and project state. A run
//! receives one immutable, content-pinned scene manifest and writes only into a unique
//! scratch directory. Depth output uses independently verifiable tiles, allowing bounded
//! memory, durable checkpoints, and cancellation between cost-volume chunks.

use std::{
    collections::{BTreeSet, VecDeque},
    ffi::{OsStr, OsString},
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{mpsc, Arc},
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

use crate::dense_raster_prep::PreparedPotreeCloud;
use crate::job_runtime::{JobWorkerContext, JobWorkerError};

const SCENE_SCHEMA_VERSION: u32 = 1;
const WORKER_MANIFEST_SCHEMA_VERSION: u32 = 1;
const OUTPUT_SCHEMA_VERSION: u32 = 1;
const CHECKPOINT_SCHEMA_VERSION: u32 = 1;
const DEPTH_TILE_MAGIC: &[u8; 8] = b"HCDEPTH1";
const DEPTH_TILE_HEADER_BYTES: u64 = 40;
const MAX_JSON_BYTES: u64 = 16 * 1024 * 1024;
const MAX_LOG_LINE_BYTES: usize = 16 * 1024;
const LOG_TAIL_LINES: usize = 240;
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(15);
const FORCE_KILL_AFTER: Duration = Duration::from_millis(300);
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Algorithm capabilities asserted by a release worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MvsCapability {
    CpuReference,
    VulkanCompute,
    CudaCompute,
    MultiScalePatchMatch,
    GeometricConsistency,
    DenseFusion,
    OfflineOnly,
}

/// One file covered by the signed worker manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsToolFile {
    pub relative_path: PathBuf,
    pub sha256: ObjectHash,
}

/// Auditable dependency entry shipped beside the worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsLicenseRecord {
    pub component: String,
    pub version: String,
    pub spdx_expression: String,
}

/// Signed release description. Runtime download is deliberately unsupported.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsToolManifest {
    pub schema_version: u32,
    pub tool_id: String,
    pub version: String,
    pub executable: MvsToolFile,
    pub capabilities: BTreeSet<MvsCapability>,
    pub licenses: Vec<MvsLicenseRecord>,
}

/// Product-owned verifier for the detached release signature.
pub trait MvsManifestSignatureVerifier: Send + Sync {
    fn verify_detached(
        &self,
        signer_key_id: &str,
        manifest: &[u8],
        signature: &[u8],
    ) -> Result<(), String>;
}

/// Trusted release configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MvsRuntimeConfig {
    pub tool_root: PathBuf,
    pub manifest_path: PathBuf,
    pub detached_signature_path: PathBuf,
    pub expected_manifest_sha256: ObjectHash,
    pub trusted_signer_key_id: String,
    pub scratch_root: PathBuf,
    pub allowed_scene_roots: Vec<PathBuf>,
}

/// Explicitly untrusted development configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevMvsRuntimeConfig {
    pub executable: PathBuf,
    pub version: String,
    pub capabilities: BTreeSet<MvsCapability>,
    pub scratch_root: PathBuf,
    pub allowed_scene_roots: Vec<PathBuf>,
}

/// Backend selection contains no arbitrary command-line escape hatch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum MvsComputeDevice {
    /// Cross-platform quality reference. Threads may be reduced under memory pressure.
    Cpu { threads: u16 },
    /// Same kernels through wgpu. Release manifests must explicitly assert support.
    Vulkan { adapter_index: u16 },
    /// Optional NVIDIA accelerator. The portable CPU path remains available.
    Cuda { gpu_indices: Vec<u16> },
}

impl MvsComputeDevice {
    fn required_capability(&self) -> MvsCapability {
        match self {
            Self::Cpu { .. } => MvsCapability::CpuReference,
            Self::Vulkan { .. } => MvsCapability::VulkanCompute,
            Self::Cuda { .. } => MvsCapability::CudaCompute,
        }
    }

    fn validate(&self) -> Result<(), MvsRuntimeError> {
        match self {
            Self::Cpu { threads } if !(1..=512).contains(threads) => Err(
                MvsRuntimeError::InvalidRequest("CPU threads must be in 1..=512".into()),
            ),
            Self::Cuda { gpu_indices } => {
                if gpu_indices.is_empty() || gpu_indices.len() > 32 {
                    return Err(MvsRuntimeError::InvalidRequest(
                        "CUDA selection must contain 1..=32 devices".into(),
                    ));
                }
                if gpu_indices.iter().copied().collect::<BTreeSet<_>>().len() != gpu_indices.len() {
                    return Err(MvsRuntimeError::InvalidRequest(
                        "CUDA device indices must be unique".into(),
                    ));
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

/// Intrinsics for an already-undistorted perspective image.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsPinholeCamera {
    pub fx: f64,
    pub fy: f64,
    pub cx: f64,
    pub cy: f64,
    /// Row-major 3x4 world-to-camera transform.
    pub world_to_camera: [f64; 12],
}

/// One source image and its view graph neighborhood.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsSceneImage {
    pub image_id: String,
    pub relative_path: PathBuf,
    pub sha256: ObjectHash,
    pub width: u32,
    pub height: u32,
    pub camera: MvsPinholeCamera,
    pub minimum_depth: f64,
    pub maximum_depth: f64,
    pub neighbor_image_ids: Vec<String>,
}

/// Neutral scene format produced from any successful SfM backend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsSceneManifest {
    pub schema_version: u32,
    pub coordinate_frame_id: String,
    pub images: Vec<MvsSceneImage>,
}

/// Bounded quality parameters shared by all compute devices.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsSettings {
    pub maximum_image_dimension: u32,
    pub tile_size: u32,
    pub tile_overlap: u32,
    pub pyramid_levels: u8,
    pub patch_radius: u8,
    pub patchmatch_iterations: u8,
    pub depth_hypotheses: u16,
    pub matching_views: u8,
    pub minimum_consistent_views: u8,
    pub geometric_relative_tolerance: f32,
    pub minimum_confidence: f32,
    #[serde(default = "default_true")]
    pub retain_confidence_attribute: bool,
    #[serde(default = "default_true")]
    pub calculate_colors: bool,
    pub checkpoint_every_tiles: u32,
}

const fn default_true() -> bool {
    true
}

impl Default for MvsSettings {
    fn default() -> Self {
        Self {
            maximum_image_dimension: 3_200,
            tile_size: 512,
            tile_overlap: 32,
            pyramid_levels: 4,
            patch_radius: 3,
            patchmatch_iterations: 5,
            depth_hypotheses: 128,
            matching_views: 6,
            minimum_consistent_views: 3,
            geometric_relative_tolerance: 0.01,
            minimum_confidence: 0.3,
            retain_confidence_attribute: true,
            calculate_colors: true,
            checkpoint_every_tiles: 8,
        }
    }
}

impl MvsSettings {
    fn validate(&self) -> Result<(), MvsRuntimeError> {
        if !(256..=65_535).contains(&self.maximum_image_dimension) {
            return Err(MvsRuntimeError::InvalidRequest(
                "maximum image dimension must be in 256..=65535".into(),
            ));
        }
        if !self.tile_size.is_power_of_two() || !(128..=2_048).contains(&self.tile_size) {
            return Err(MvsRuntimeError::InvalidRequest(
                "tile size must be a power of two in 128..=2048".into(),
            ));
        }
        if self.tile_overlap > self.tile_size / 4 {
            return Err(MvsRuntimeError::InvalidRequest(
                "tile overlap must not exceed one quarter of tile size".into(),
            ));
        }
        if !(1..=8).contains(&self.pyramid_levels)
            || !(1..=8).contains(&self.patch_radius)
            || !(1..=20).contains(&self.patchmatch_iterations)
            || !(16..=2_048).contains(&self.depth_hypotheses)
        {
            return Err(MvsRuntimeError::InvalidRequest(
                "invalid bounded PatchMatch settings".into(),
            ));
        }
        if !(2..=32).contains(&self.matching_views)
            || self.minimum_consistent_views < 2
            || self.minimum_consistent_views > self.matching_views
        {
            return Err(MvsRuntimeError::InvalidRequest(
                "view consistency settings are invalid".into(),
            ));
        }
        if !self.geometric_relative_tolerance.is_finite()
            || !(0.000_1..=0.25).contains(&self.geometric_relative_tolerance)
            || !self.minimum_confidence.is_finite()
            || !(0.0..=1.0).contains(&self.minimum_confidence)
        {
            return Err(MvsRuntimeError::InvalidRequest(
                "confidence or geometric tolerance is invalid".into(),
            ));
        }
        if self.checkpoint_every_tiles == 0 || self.checkpoint_every_tiles > 100_000 {
            return Err(MvsRuntimeError::InvalidRequest(
                "checkpoint interval must be in 1..=100000 tiles".into(),
            ));
        }
        Ok(())
    }
}

/// Validated checkpoint that can resume an interrupted run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsResumeCheckpoint {
    pub path: PathBuf,
    pub sha256: ObjectHash,
}

/// Immutable request for depth maps and optional dense fusion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsRunRequest {
    pub job_id: String,
    pub scene_manifest_path: PathBuf,
    pub scene_manifest_sha256: ObjectHash,
    pub device: MvsComputeDevice,
    pub settings: MvsSettings,
    pub fuse_dense_point_cloud: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<MvsResumeCheckpoint>,
}

/// Tile address in one per-image depth pyramid.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsDepthTileKey {
    pub image_id: String,
    pub level: u8,
    pub x: u32,
    pub y: u32,
}

/// One depth+confidence tile record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsDepthTileRecord {
    pub key: MvsDepthTileKey,
    pub relative_path: PathBuf,
    pub sha256: ObjectHash,
    pub width: u32,
    pub height: u32,
    pub valid_pixels: u64,
}

/// Per-image metadata used by the depth viewer for pixel-to-world measurement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsDepthImageRecord {
    pub image_id: String,
    pub width: u32,
    pub height: u32,
    pub camera: MvsPinholeCamera,
    pub tiles: Vec<MvsDepthTileRecord>,
}

/// Optional fused point cloud artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsDenseCloudRecord {
    pub relative_path: PathBuf,
    pub sha256: ObjectHash,
    pub vertex_count: u64,
    pub bytes: u64,
}

/// Worker-written index validated before any project publication.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsOutputIndex {
    pub schema_version: u32,
    pub job_id: String,
    pub scene_manifest_sha256: ObjectHash,
    pub settings_sha256: ObjectHash,
    pub device: MvsComputeDevice,
    pub depth_images: Vec<MvsDepthImageRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dense_point_cloud: Option<MvsDenseCloudRecord>,
}

/// Durable worker checkpoint. Completed tile identities are monotone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MvsCheckpoint {
    pub schema_version: u32,
    pub job_id: String,
    pub scene_manifest_sha256: ObjectHash,
    pub settings_sha256: ObjectHash,
    pub sequence: u64,
    pub completed_tiles: BTreeSet<MvsDepthTileKey>,
}

/// Bounded process provenance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvsCommandReport {
    pub argv: Vec<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub log_tail: Vec<String>,
}

/// Validated isolated result, ready for an atomic project command.
#[derive(Debug, Clone)]
pub struct MvsRunOutcome {
    pub scratch_path: PathBuf,
    pub output_path: PathBuf,
    pub output_index_path: PathBuf,
    pub output_index_sha256: ObjectHash,
    pub output: MvsOutputIndex,
    pub command: MvsCommandReport,
    pub latest_checkpoint: Option<(PathBuf, ObjectHash, MvsCheckpoint)>,
    pub potree: Option<PreparedPotreeCloud>,
}

#[derive(Debug, Clone)]
struct VerifiedMvsTool {
    executable: PathBuf,
    executable_sha256: ObjectHash,
    version: String,
    capabilities: BTreeSet<MvsCapability>,
}

/// Preflighted, cloneable MVS runtime.
#[derive(Clone)]
pub struct MvsRuntime {
    tool: Arc<VerifiedMvsTool>,
    scratch_root: PathBuf,
    allowed_scene_roots: Arc<Vec<PathBuf>>,
}

impl std::fmt::Debug for MvsRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MvsRuntime")
            .field("version", &self.tool.version)
            .field("capabilities", &self.tool.capabilities)
            .field("scratch_root", &self.scratch_root)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Error)]
pub enum MvsRuntimeError {
    #[error("invalid MVS configuration: {0}")]
    InvalidConfig(String),
    #[error("invalid MVS request: {0}")]
    InvalidRequest(String),
    #[error("path {path} is invalid: {reason}")]
    InvalidPath { path: PathBuf, reason: String },
    #[error("path escapes a trusted root: {0}")]
    PathOutsideTrustedRoot(PathBuf),
    #[error("scene is outside configured roots: {0}")]
    SceneOutsideAllowedRoots(PathBuf),
    #[error("SHA-256 mismatch for {path}: expected {expected:?}, observed {observed:?}")]
    HashMismatch {
        path: PathBuf,
        expected: ObjectHash,
        observed: ObjectHash,
    },
    #[error("worker manifest signature is invalid: {0}")]
    InvalidSignature(String),
    #[error("worker manifest is invalid: {0}")]
    InvalidManifest(String),
    #[error("worker lacks required capability {0:?}")]
    MissingCapability(MvsCapability),
    #[error("worker command failed with exit code {exit_code:?}: {message}")]
    CommandFailed {
        exit_code: Option<i32>,
        message: String,
    },
    #[error("MVS cancellation requested")]
    Cancelled,
    #[error("progress sink rejected an update: {0}")]
    Progress(String),
    #[error("worker output is invalid: {0}")]
    InvalidOutput(String),
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl From<MvsRuntimeError> for JobWorkerError {
    fn from(error: MvsRuntimeError) -> Self {
        match error {
            MvsRuntimeError::Cancelled => Self::Cancelled,
            other => Self::Failed {
                code: match other {
                    MvsRuntimeError::HashMismatch { .. }
                    | MvsRuntimeError::InvalidSignature(_)
                    | MvsRuntimeError::InvalidManifest(_) => "mvsToolTrust",
                    MvsRuntimeError::CommandFailed { .. } => "mvsCommand",
                    MvsRuntimeError::InvalidOutput(_) => "invalidMvsOutput",
                    MvsRuntimeError::Progress(_) => "progressSink",
                    MvsRuntimeError::Io(_) => "io",
                    MvsRuntimeError::Json(_) => "json",
                    _ => "invalidInput",
                }
                .into(),
                message: other.to_string(),
            },
        }
    }
}

impl MvsRuntime {
    /// Verifies a signed release manifest, all trust pins and the offline capability.
    pub fn preflight(
        config: &MvsRuntimeConfig,
        verifier: &dyn MvsManifestSignatureVerifier,
    ) -> Result<Self, MvsRuntimeError> {
        validate_hash(&config.expected_manifest_sha256, "manifest")?;
        let tool_root = canonical_directory(&config.tool_root)?;
        let manifest_path = canonical_file_inside(&config.manifest_path, &tool_root)?;
        let signature_path = canonical_file_inside(&config.detached_signature_path, &tool_root)?;
        let manifest_bytes = read_bounded(&manifest_path, MAX_JSON_BYTES)?;
        let observed_manifest = ObjectHash::of_bytes(&manifest_bytes);
        verify_hash(
            &manifest_path,
            &config.expected_manifest_sha256,
            &observed_manifest,
        )?;
        let signature = read_bounded(&signature_path, 64 * 1024)?;
        verifier
            .verify_detached(&config.trusted_signer_key_id, &manifest_bytes, &signature)
            .map_err(MvsRuntimeError::InvalidSignature)?;
        let manifest: MvsToolManifest = serde_json::from_slice(&manifest_bytes)?;
        validate_tool_manifest(&manifest)?;
        let executable = canonical_file_inside(
            &tool_root.join(&manifest.executable.relative_path),
            &tool_root,
        )?;
        let executable_sha256 = hash_file(&executable, None)?;
        verify_hash(&executable, &manifest.executable.sha256, &executable_sha256)?;
        let observed_version = probe_version(&executable)?;
        if observed_version != manifest.version {
            return Err(MvsRuntimeError::InvalidManifest(format!(
                "manifest version {} does not match executable version {observed_version}",
                manifest.version
            )));
        }
        Self::finish_preflight(
            executable,
            executable_sha256,
            manifest.version,
            manifest.capabilities,
            &config.scratch_root,
            &config.allowed_scene_roots,
        )
    }

    /// Probes a local worker without claiming release trust.
    pub fn development_preflight(config: &DevMvsRuntimeConfig) -> Result<Self, MvsRuntimeError> {
        let executable = canonical_file(&config.executable)?;
        let observed_version = probe_version(&executable)?;
        if observed_version != config.version {
            return Err(MvsRuntimeError::InvalidConfig(format!(
                "configured version {} does not match executable version {observed_version}",
                config.version
            )));
        }
        validate_capabilities(&config.capabilities)?;
        let executable_sha256 = hash_file(&executable, None)?;
        Self::finish_preflight(
            executable,
            executable_sha256,
            observed_version,
            config.capabilities.clone(),
            &config.scratch_root,
            &config.allowed_scene_roots,
        )
    }

    fn finish_preflight(
        executable: PathBuf,
        executable_sha256: ObjectHash,
        version: String,
        capabilities: BTreeSet<MvsCapability>,
        scratch_root: &Path,
        allowed_scene_roots: &[PathBuf],
    ) -> Result<Self, MvsRuntimeError> {
        validate_capabilities(&capabilities)?;
        fs::create_dir_all(scratch_root)?;
        let scratch_root = canonical_directory(scratch_root)?;
        let allowed_scene_roots = allowed_scene_roots
            .iter()
            .map(|path| canonical_directory(path))
            .collect::<Result<Vec<_>, _>>()?;
        if allowed_scene_roots.is_empty() {
            return Err(MvsRuntimeError::InvalidConfig(
                "at least one scene root is required".into(),
            ));
        }
        Ok(Self {
            tool: Arc::new(VerifiedMvsTool {
                executable,
                executable_sha256,
                version,
                capabilities,
            }),
            scratch_root,
            allowed_scene_roots: Arc::new(allowed_scene_roots),
        })
    }

    /// Stable initial progress compatible with the Photolab job manager.
    #[must_use]
    pub fn initial_progress(request: &MvsRunRequest) -> JobProgress {
        // The image count is only authoritative after the scene manifest has
        // been validated. Leave it unknown here so the first worker update can
        // freeze the real total without violating the monotone progress model.
        progress(request.fuse_dense_point_cloud, 0, 0, None, 0, None)
    }

    /// Finds the newest hash-compatible checkpoint from an interrupted run.
    pub fn compatible_resume_checkpoint(
        &self,
        scene_manifest_sha256: &ObjectHash,
        settings: &MvsSettings,
    ) -> Result<Option<MvsResumeCheckpoint>, MvsRuntimeError> {
        let settings_sha256 = hash_json(settings)?;
        let mut candidates = fs::read_dir(&self.scratch_root)?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                entry
                    .file_type()
                    .ok()
                    .filter(|kind| kind.is_dir() && !kind.is_symlink())
                    .map(|_| entry.path())
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
        for scratch in candidates {
            let checkpoints = scratch.join("checkpoints");
            if !checkpoints.is_dir() {
                continue;
            }
            if let Some((path, sha256, _)) =
                latest_compatible_checkpoint(&checkpoints, scene_manifest_sha256, &settings_sha256)?
            {
                return Ok(Some(MvsResumeCheckpoint { path, sha256 }));
            }
        }
        Ok(None)
    }

    /// Runs the worker in a fresh scratch directory, supervises cancellation and validates all output.
    pub fn run(
        &self,
        request: &MvsRunRequest,
        context: &JobWorkerContext,
    ) -> Result<MvsRunOutcome, MvsRuntimeError> {
        request.validate()?;
        context.check_cancelled().map_err(map_worker_error)?;
        let required = request.device.required_capability();
        if !self.tool.capabilities.contains(&required) {
            return Err(MvsRuntimeError::MissingCapability(required));
        }

        let scene_path = canonical_file(&request.scene_manifest_path)?;
        let scene_root = scene_path
            .parent()
            .ok_or_else(|| MvsRuntimeError::InvalidPath {
                path: scene_path.clone(),
                reason: "scene manifest has no parent".into(),
            })?;
        if !self
            .allowed_scene_roots
            .iter()
            .any(|allowed| scene_path.starts_with(allowed))
        {
            return Err(MvsRuntimeError::SceneOutsideAllowedRoots(scene_path));
        }
        let scene_bytes = read_bounded(&request.scene_manifest_path, MAX_JSON_BYTES)?;
        let scene_hash = ObjectHash::of_bytes(&scene_bytes);
        verify_hash(
            &request.scene_manifest_path,
            &request.scene_manifest_sha256,
            &scene_hash,
        )?;
        let scene: MvsSceneManifest = serde_json::from_slice(&scene_bytes)?;
        validate_scene(&scene, scene_root, &context.cancellation)?;

        let settings_sha256 = hash_json(&request.settings)?;
        let resume = request
            .resume
            .as_ref()
            .map(|resume| validate_resume(resume, &scene_hash, &settings_sha256))
            .transpose()?;

        report(
            context,
            progress(
                request.fuse_dense_point_cloud,
                0,
                0,
                Some(scene.images.len() as u64),
                0,
                None,
            ),
        )?;
        for (index, image) in scene.images.iter().enumerate() {
            context.check_cancelled().map_err(map_worker_error)?;
            let image_path =
                canonical_file_inside(&scene_root.join(&image.relative_path), scene_root)?;
            let observed = hash_file(&image_path, Some(&context.cancellation))?;
            verify_hash(&image_path, &image.sha256, &observed)?;
            report(
                context,
                progress(
                    request.fuse_dense_point_cloud,
                    0,
                    (index + 1) as u64,
                    Some(scene.images.len() as u64),
                    0,
                    None,
                ),
            )?;
        }

        let scratch = create_scratch(&self.scratch_root, &request.job_id)?;
        let output_path = scratch.join("output");
        let checkpoint_path = scratch.join("checkpoints");
        fs::create_dir(&output_path)?;
        fs::create_dir(&checkpoint_path)?;
        if let Some((checkpoint, _)) = &resume {
            let source_output = resume_output_directory(checkpoint, &self.scratch_root)?;
            copy_resume_output(&source_output, &output_path, &context.cancellation)?;
        }
        let worker_request = MvsWorkerRequest {
            schema_version: 1,
            job_id: request.job_id.clone(),
            scene_manifest_path: request.scene_manifest_path.clone(),
            scene_manifest_sha256: scene_hash,
            settings: request.settings.clone(),
            settings_sha256: settings_sha256.clone(),
            device: request.device.clone(),
            fuse_dense_point_cloud: request.fuse_dense_point_cloud,
            output_path: output_path.clone(),
            checkpoint_path: checkpoint_path.clone(),
            resume_checkpoint_path: resume.as_ref().map(|(path, _)| path.clone()),
            network_policy: "offlineOnly".into(),
        };
        let request_path = scratch.join("request.json");
        atomic_write_json(&request_path, &worker_request)?;

        report(
            context,
            progress(request.fuse_dense_point_cloud, 1, 0, None, 0, None),
        )?;
        let argv = vec![
            OsString::from("run"),
            OsString::from("--request"),
            request_path.as_os_str().to_owned(),
        ];
        let audited_argv = argv
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let started = Instant::now();
        let mut child = spawn_worker(&self.tool.executable, &argv, &scratch)?;
        let process = supervise_worker(
            &mut child,
            &context.cancellation,
            request.fuse_dense_point_cloud,
            context,
        )?;
        let command = MvsCommandReport {
            argv: audited_argv,
            exit_code: process.status.code(),
            duration_ms: duration_ms(started.elapsed()),
            log_tail: process.log_tail,
        };
        if !process.status.success() {
            return Err(MvsRuntimeError::CommandFailed {
                exit_code: command.exit_code,
                message: command
                    .log_tail
                    .last()
                    .cloned()
                    .unwrap_or_else(|| "worker produced no diagnostics".into()),
            });
        }

        report(
            context,
            progress(
                request.fuse_dense_point_cloud,
                if request.fuse_dense_point_cloud { 4 } else { 3 },
                0,
                Some(1),
                0,
                None,
            ),
        )?;
        let output_index_path = output_path.join("index.json");
        let output = validate_output_directory(
            &output_path,
            request,
            &scene,
            &settings_sha256,
            &context.cancellation,
        )?;
        let output_index_sha256 = hash_file(&output_index_path, Some(&context.cancellation))?;
        let latest_checkpoint = latest_checkpoint(
            &checkpoint_path,
            &request.job_id,
            &request.scene_manifest_sha256,
            &settings_sha256,
        )?;
        report(
            context,
            progress(
                request.fuse_dense_point_cloud,
                if request.fuse_dense_point_cloud { 4 } else { 3 },
                1,
                Some(1),
                0,
                None,
            ),
        )?;

        Ok(MvsRunOutcome {
            scratch_path: scratch,
            output_path,
            output_index_path,
            output_index_sha256,
            output,
            command,
            latest_checkpoint,
            potree: None,
        })
    }

    /// Hash of the exact executable used for provenance.
    #[must_use]
    pub fn executable_sha256(&self) -> &ObjectHash {
        &self.tool.executable_sha256
    }
}

impl MvsRunRequest {
    fn validate(&self) -> Result<(), MvsRuntimeError> {
        validate_component("jobId", &self.job_id)?;
        validate_hash(&self.scene_manifest_sha256, "scene manifest")?;
        self.device.validate()?;
        self.settings.validate()?;
        if let Some(resume) = &self.resume {
            validate_hash(&resume.sha256, "resume checkpoint")?;
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvsWorkerRequest {
    pub schema_version: u32,
    pub job_id: String,
    pub scene_manifest_path: PathBuf,
    pub scene_manifest_sha256: ObjectHash,
    pub settings: MvsSettings,
    pub settings_sha256: ObjectHash,
    pub device: MvsComputeDevice,
    pub fuse_dense_point_cloud: bool,
    pub output_path: PathBuf,
    pub checkpoint_path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_checkpoint_path: Option<PathBuf>,
    pub network_policy: String,
}

fn validate_tool_manifest(manifest: &MvsToolManifest) -> Result<(), MvsRuntimeError> {
    if manifest.schema_version != WORKER_MANIFEST_SCHEMA_VERSION {
        return Err(MvsRuntimeError::InvalidManifest(format!(
            "unsupported schema {}",
            manifest.schema_version
        )));
    }
    if manifest.tool_id != "himmelcad-portable-mvs" {
        return Err(MvsRuntimeError::InvalidManifest(
            "unexpected tool id".into(),
        ));
    }
    validate_component("version", &manifest.version)?;
    validate_relative_path(&manifest.executable.relative_path)?;
    validate_hash(&manifest.executable.sha256, "executable")?;
    validate_capabilities(&manifest.capabilities)?;
    if manifest.licenses.is_empty() {
        return Err(MvsRuntimeError::InvalidManifest(
            "license inventory is empty".into(),
        ));
    }
    const FORBIDDEN: [&str; 6] = ["GPL", "LGPL", "AGPL", "SSPL", "Commons-Clause", "UNKNOWN"];
    for license in &manifest.licenses {
        if license.component.trim().is_empty()
            || license.version.trim().is_empty()
            || license.spdx_expression.trim().is_empty()
        {
            return Err(MvsRuntimeError::InvalidManifest(
                "license inventory contains an empty field".into(),
            ));
        }
        let expression = license.spdx_expression.to_ascii_uppercase();
        if FORBIDDEN.iter().any(|needle| expression.contains(needle)) {
            return Err(MvsRuntimeError::InvalidManifest(format!(
                "forbidden or unknown license for {}: {}",
                license.component, license.spdx_expression
            )));
        }
    }
    Ok(())
}

fn validate_capabilities(capabilities: &BTreeSet<MvsCapability>) -> Result<(), MvsRuntimeError> {
    for required in [
        MvsCapability::CpuReference,
        MvsCapability::MultiScalePatchMatch,
        MvsCapability::GeometricConsistency,
        MvsCapability::DenseFusion,
        MvsCapability::OfflineOnly,
    ] {
        if !capabilities.contains(&required) {
            return Err(MvsRuntimeError::MissingCapability(required));
        }
    }
    Ok(())
}

fn validate_scene(
    scene: &MvsSceneManifest,
    scene_root: &Path,
    cancellation: &CancellationToken,
) -> Result<(), MvsRuntimeError> {
    if scene.schema_version != SCENE_SCHEMA_VERSION {
        return Err(MvsRuntimeError::InvalidRequest(format!(
            "unsupported scene schema {}",
            scene.schema_version
        )));
    }
    validate_component("coordinateFrameId", &scene.coordinate_frame_id)?;
    if !(2..=1_000_000).contains(&scene.images.len()) {
        return Err(MvsRuntimeError::InvalidRequest(
            "scene must contain 2..=1000000 images".into(),
        ));
    }
    let ids = scene
        .images
        .iter()
        .map(|image| image.image_id.as_str())
        .collect::<BTreeSet<_>>();
    if ids.len() != scene.images.len() {
        return Err(MvsRuntimeError::InvalidRequest(
            "image ids must be unique".into(),
        ));
    }
    for image in &scene.images {
        cancellation
            .check()
            .map_err(|_| MvsRuntimeError::Cancelled)?;
        validate_component("imageId", &image.image_id)?;
        validate_relative_path(&image.relative_path)?;
        validate_hash(&image.sha256, "scene image")?;
        if image.width == 0 || image.height == 0 || image.width > 200_000 || image.height > 200_000
        {
            return Err(MvsRuntimeError::InvalidRequest(format!(
                "invalid dimensions for {}",
                image.image_id
            )));
        }
        let camera_values = [
            image.camera.fx,
            image.camera.fy,
            image.camera.cx,
            image.camera.cy,
        ]
        .into_iter()
        .chain(image.camera.world_to_camera);
        if camera_values.clone().any(|value| !value.is_finite())
            || image.camera.fx <= 0.0
            || image.camera.fy <= 0.0
        {
            return Err(MvsRuntimeError::InvalidRequest(format!(
                "invalid camera for {}",
                image.image_id
            )));
        }
        if !image.minimum_depth.is_finite()
            || !image.maximum_depth.is_finite()
            || image.minimum_depth <= 0.0
            || image.maximum_depth <= image.minimum_depth
        {
            return Err(MvsRuntimeError::InvalidRequest(format!(
                "invalid depth range for {}",
                image.image_id
            )));
        }
        let neighbors = image
            .neighbor_image_ids
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if neighbors.len() != image.neighbor_image_ids.len()
            || neighbors.contains(image.image_id.as_str())
            || neighbors.iter().any(|id| !ids.contains(id))
        {
            return Err(MvsRuntimeError::InvalidRequest(format!(
                "invalid view graph neighbors for {}",
                image.image_id
            )));
        }
        if neighbors.len() < 2 {
            return Err(MvsRuntimeError::InvalidRequest(format!(
                "{} needs at least two neighboring views",
                image.image_id
            )));
        }
        let path = scene_root.join(&image.relative_path);
        if path
            .symlink_metadata()
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(MvsRuntimeError::InvalidPath {
                path,
                reason: "symbolic links are not accepted as source images".into(),
            });
        }
    }
    Ok(())
}

/// Validates every file referenced by a worker output index.
pub fn validate_output_directory(
    output_root: &Path,
    request: &MvsRunRequest,
    scene: &MvsSceneManifest,
    settings_sha256: &ObjectHash,
    cancellation: &CancellationToken,
) -> Result<MvsOutputIndex, MvsRuntimeError> {
    let root = canonical_directory(output_root)?;
    let index_path = canonical_file_inside(&root.join("index.json"), &root)?;
    let index_bytes = read_bounded(&index_path, MAX_JSON_BYTES)?;
    let index: MvsOutputIndex = serde_json::from_slice(&index_bytes)?;
    if index.schema_version != OUTPUT_SCHEMA_VERSION
        || index.job_id != request.job_id
        || index.scene_manifest_sha256 != request.scene_manifest_sha256
        || &index.settings_sha256 != settings_sha256
        || index.device != request.device
    {
        return Err(MvsRuntimeError::InvalidOutput(
            "output provenance does not match its immutable request".into(),
        ));
    }
    let expected_images = scene
        .images
        .iter()
        .map(|image| image.image_id.as_str())
        .collect::<BTreeSet<_>>();
    let output_images = index
        .depth_images
        .iter()
        .map(|image| image.image_id.as_str())
        .collect::<BTreeSet<_>>();
    if output_images != expected_images || output_images.len() != index.depth_images.len() {
        return Err(MvsRuntimeError::InvalidOutput(
            "depth output must contain each source image exactly once".into(),
        ));
    }
    let mut all_keys = BTreeSet::new();
    let mut all_paths = BTreeSet::new();
    for image in &index.depth_images {
        cancellation
            .check()
            .map_err(|_| MvsRuntimeError::Cancelled)?;
        let source = scene
            .images
            .iter()
            .find(|candidate| candidate.image_id == image.image_id)
            .ok_or_else(|| MvsRuntimeError::InvalidOutput("unknown depth image".into()))?;
        if image.width != source.width
            || image.height != source.height
            || image.camera != source.camera
            || image.tiles.is_empty()
        {
            return Err(MvsRuntimeError::InvalidOutput(format!(
                "depth metadata differs from scene for {}",
                image.image_id
            )));
        }
        for tile in &image.tiles {
            if tile.key.image_id != image.image_id
                || tile.key.level >= request.settings.pyramid_levels
                || tile.width == 0
                || tile.height == 0
                || tile.width > request.settings.tile_size
                || tile.height > request.settings.tile_size
                || tile.valid_pixels > u64::from(tile.width) * u64::from(tile.height)
                || !all_keys.insert(tile.key.clone())
                || !all_paths.insert(tile.relative_path.clone())
            {
                return Err(MvsRuntimeError::InvalidOutput(format!(
                    "invalid or duplicate tile {:?}",
                    tile.key
                )));
            }
            validate_relative_path(&tile.relative_path)?;
            validate_hash(&tile.sha256, "depth tile")?;
            let tile_path = canonical_file_inside(&root.join(&tile.relative_path), &root)?;
            let summary = validate_depth_tile(&tile_path, &tile.key, tile.width, tile.height)?;
            verify_hash(&tile_path, &tile.sha256, &summary.sha256)?;
            if summary.valid_pixels != tile.valid_pixels {
                return Err(MvsRuntimeError::InvalidOutput(format!(
                    "valid pixel count differs for {:?}",
                    tile.key
                )));
            }
        }
    }
    match (&index.dense_point_cloud, request.fuse_dense_point_cloud) {
        (Some(cloud), true) => {
            validate_relative_path(&cloud.relative_path)?;
            validate_hash(&cloud.sha256, "dense cloud")?;
            let path = canonical_file_inside(&root.join(&cloud.relative_path), &root)?;
            let summary = validate_dense_ply(&path)?;
            verify_hash(&path, &cloud.sha256, &summary.sha256)?;
            if cloud.vertex_count != summary.vertex_count || cloud.bytes != summary.bytes {
                return Err(MvsRuntimeError::InvalidOutput(
                    "dense cloud metadata does not match PLY".into(),
                ));
            }
        }
        (None, false) => {}
        _ => {
            return Err(MvsRuntimeError::InvalidOutput(
                "dense cloud presence differs from request".into(),
            ));
        }
    }
    Ok(index)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DepthTileSummary {
    sha256: ObjectHash,
    valid_pixels: u64,
}

fn validate_depth_tile(
    path: &Path,
    expected_key: &MvsDepthTileKey,
    expected_width: u32,
    expected_height: u32,
) -> Result<DepthTileSummary, MvsRuntimeError> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let mut header = [0_u8; DEPTH_TILE_HEADER_BYTES as usize];
    file.read_exact(&mut header).map_err(|error| {
        MvsRuntimeError::InvalidOutput(format!(
            "{} has a truncated header: {error}",
            path.display()
        ))
    })?;
    if &header[0..8] != DEPTH_TILE_MAGIC {
        return Err(MvsRuntimeError::InvalidOutput(format!(
            "{} has invalid depth tile magic",
            path.display()
        )));
    }
    let schema = u32_at(&header, 8);
    let level = u32_at(&header, 12);
    let x = u32_at(&header, 16);
    let y = u32_at(&header, 20);
    let width = u32_at(&header, 24);
    let height = u32_at(&header, 28);
    let channels = u32_at(&header, 32);
    let scalar_bytes = u32_at(&header, 36);
    if schema != 1
        || level != u32::from(expected_key.level)
        || x != expected_key.x
        || y != expected_key.y
        || width != expected_width
        || height != expected_height
        || channels != 2
        || scalar_bytes != 4
    {
        return Err(MvsRuntimeError::InvalidOutput(format!(
            "{} depth header differs from its index",
            path.display()
        )));
    }
    let pixel_count = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| MvsRuntimeError::InvalidOutput("depth tile size overflow".into()))?;
    let expected_size = DEPTH_TILE_HEADER_BYTES
        .checked_add(pixel_count.saturating_mul(8))
        .ok_or_else(|| MvsRuntimeError::InvalidOutput("depth tile size overflow".into()))?;
    if size != expected_size {
        return Err(MvsRuntimeError::InvalidOutput(format!(
            "{} has {size} bytes, expected {expected_size}",
            path.display()
        )));
    }
    let mut valid_pixels = 0_u64;
    let mut values = [0_u8; 8];
    for _ in 0..pixel_count {
        file.read_exact(&mut values)?;
        let depth = f32::from_le_bytes(values[0..4].try_into().expect("fixed slice"));
        let confidence = f32::from_le_bytes(values[4..8].try_into().expect("fixed slice"));
        if !depth.is_finite()
            || depth < 0.0
            || !confidence.is_finite()
            || !(0.0..=1.0).contains(&confidence)
            || (depth == 0.0 && confidence != 0.0)
        {
            return Err(MvsRuntimeError::InvalidOutput(format!(
                "{} contains invalid depth/confidence values",
                path.display()
            )));
        }
        if depth > 0.0 {
            valid_pixels += 1;
        }
    }
    Ok(DepthTileSummary {
        sha256: hash_file(path, None)?,
        valid_pixels,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DensePlySummary {
    sha256: ObjectHash,
    vertex_count: u64,
    bytes: u64,
}

fn validate_dense_ply(path: &Path) -> Result<DensePlySummary, MvsRuntimeError> {
    let mut file = File::open(path)?;
    let bytes = file.metadata()?.len();
    if bytes == 0 || bytes > 16 * 1024 * 1024 * 1024_u64 {
        return Err(MvsRuntimeError::InvalidOutput(
            "dense PLY size is outside supported bounds".into(),
        ));
    }
    let mut reader = BufReader::new(&file);
    let mut header_bytes = 0_usize;
    let mut line = String::new();
    let mut format_ok = false;
    let mut vertex_count = None;
    let mut in_vertex = false;
    let mut vertex_stride = 0_u64;
    let mut required = BTreeSet::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line)?;
        if read == 0 || header_bytes.saturating_add(read) > 1024 * 1024 {
            return Err(MvsRuntimeError::InvalidOutput(
                "dense PLY header is missing or too large".into(),
            ));
        }
        header_bytes += read;
        let trimmed = line.trim();
        if header_bytes == read && trimmed != "ply" {
            return Err(MvsRuntimeError::InvalidOutput(
                "dense output is not a PLY".into(),
            ));
        }
        if trimmed == "format binary_little_endian 1.0" {
            format_ok = true;
        }
        if let Some(count) = trimmed.strip_prefix("element vertex ") {
            vertex_count = count.parse::<u64>().ok();
            in_vertex = true;
            continue;
        }
        if trimmed.starts_with("element ") && !trimmed.starts_with("element vertex ") {
            in_vertex = false;
        }
        if in_vertex {
            let fields = trimmed.split_whitespace().collect::<Vec<_>>();
            if fields.first() == Some(&"property") && fields.len() == 3 {
                let width = match fields[1] {
                    "float" | "float32" | "int" | "uint" => 4,
                    "double" | "float64" | "int64" | "uint64" => 8,
                    "uchar" | "uint8" | "char" | "int8" => 1,
                    "short" | "ushort" | "int16" | "uint16" => 2,
                    _ => {
                        return Err(MvsRuntimeError::InvalidOutput(format!(
                            "unsupported dense PLY property type {}",
                            fields[1]
                        )));
                    }
                };
                vertex_stride += width;
                required.insert(fields[2].to_owned());
            } else if fields.first() == Some(&"property") {
                return Err(MvsRuntimeError::InvalidOutput(
                    "list properties are not allowed on dense vertices".into(),
                ));
            }
        }
        if trimmed == "end_header" {
            break;
        }
    }
    let vertex_count = vertex_count
        .filter(|count| *count > 0)
        .ok_or_else(|| MvsRuntimeError::InvalidOutput("dense PLY has no vertices".into()))?;
    if vertex_count > 4_000_000_000 {
        return Err(MvsRuntimeError::InvalidOutput(
            "dense PLY vertex count exceeds product limit".into(),
        ));
    }
    if !format_ok || !["x", "y", "z"].iter().all(|name| required.contains(*name)) {
        return Err(MvsRuntimeError::InvalidOutput(
            "dense PLY must be binary little-endian with x/y/z".into(),
        ));
    }
    let expected_minimum = u64::try_from(header_bytes)
        .unwrap_or(u64::MAX)
        .saturating_add(vertex_count.saturating_mul(vertex_stride));
    if bytes < expected_minimum {
        return Err(MvsRuntimeError::InvalidOutput(
            "dense PLY payload is truncated".into(),
        ));
    }
    drop(reader);
    file.seek(SeekFrom::Start(
        u64::try_from(header_bytes).unwrap_or(u64::MAX),
    ))?;
    let mut xyz = [0_u8; 12];
    let sample_count = vertex_count.min(4_096);
    for _ in 0..sample_count {
        file.read_exact(&mut xyz)?;
        for chunk in xyz.chunks_exact(4) {
            if !f32::from_le_bytes(chunk.try_into().expect("fixed chunk")).is_finite() {
                return Err(MvsRuntimeError::InvalidOutput(
                    "dense PLY contains non-finite coordinates".into(),
                ));
            }
        }
        file.seek(SeekFrom::Current(
            i64::try_from(vertex_stride.saturating_sub(12)).unwrap_or(i64::MAX),
        ))?;
    }
    Ok(DensePlySummary {
        sha256: hash_file(path, None)?,
        vertex_count,
        bytes,
    })
}

fn validate_resume(
    resume: &MvsResumeCheckpoint,
    scene_sha256: &ObjectHash,
    settings_sha256: &ObjectHash,
) -> Result<(PathBuf, MvsCheckpoint), MvsRuntimeError> {
    let path = canonical_file(&resume.path)?;
    let observed = hash_file(&path, None)?;
    verify_hash(&path, &resume.sha256, &observed)?;
    let bytes = read_bounded(&path, MAX_JSON_BYTES)?;
    let checkpoint: MvsCheckpoint = serde_json::from_slice(&bytes)?;
    validate_compatible_checkpoint(&checkpoint, scene_sha256, settings_sha256)?;
    Ok((path, checkpoint))
}

fn validate_compatible_checkpoint(
    checkpoint: &MvsCheckpoint,
    scene_sha256: &ObjectHash,
    settings_sha256: &ObjectHash,
) -> Result<(), MvsRuntimeError> {
    if checkpoint.schema_version != CHECKPOINT_SCHEMA_VERSION
        || &checkpoint.scene_manifest_sha256 != scene_sha256
        || &checkpoint.settings_sha256 != settings_sha256
        || checkpoint.sequence == 0
        || checkpoint.job_id.is_empty()
    {
        return Err(MvsRuntimeError::InvalidOutput(
            "checkpoint provenance is invalid".into(),
        ));
    }
    Ok(())
}

fn validate_checkpoint(
    checkpoint: &MvsCheckpoint,
    job_id: &str,
    scene_sha256: &ObjectHash,
    settings_sha256: &ObjectHash,
) -> Result<(), MvsRuntimeError> {
    if checkpoint.schema_version != CHECKPOINT_SCHEMA_VERSION
        || checkpoint.job_id != job_id
        || &checkpoint.scene_manifest_sha256 != scene_sha256
        || &checkpoint.settings_sha256 != settings_sha256
        || checkpoint.sequence == 0
    {
        return Err(MvsRuntimeError::InvalidOutput(
            "checkpoint provenance is invalid".into(),
        ));
    }
    Ok(())
}

fn latest_checkpoint(
    root: &Path,
    job_id: &str,
    scene_sha256: &ObjectHash,
    settings_sha256: &ObjectHash,
) -> Result<Option<(PathBuf, ObjectHash, MvsCheckpoint)>, MvsRuntimeError> {
    let mut latest: Option<(PathBuf, ObjectHash, MvsCheckpoint)> = None;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
            continue;
        }
        if entry.path().extension() != Some(OsStr::new("json")) {
            continue;
        }
        let bytes = read_bounded(&entry.path(), MAX_JSON_BYTES)?;
        let checkpoint: MvsCheckpoint = serde_json::from_slice(&bytes)?;
        validate_checkpoint(&checkpoint, job_id, scene_sha256, settings_sha256)?;
        if latest
            .as_ref()
            .is_none_or(|(_, _, previous)| checkpoint.sequence > previous.sequence)
        {
            latest = Some((entry.path(), ObjectHash::of_bytes(&bytes), checkpoint));
        }
    }
    Ok(latest)
}

fn latest_compatible_checkpoint(
    root: &Path,
    scene_sha256: &ObjectHash,
    settings_sha256: &ObjectHash,
) -> Result<Option<(PathBuf, ObjectHash, MvsCheckpoint)>, MvsRuntimeError> {
    let mut latest: Option<(PathBuf, ObjectHash, MvsCheckpoint)> = None;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_symlink() || !entry.file_type()?.is_file() {
            continue;
        }
        if entry.path().extension() != Some(OsStr::new("json")) {
            continue;
        }
        let bytes = read_bounded(&entry.path(), MAX_JSON_BYTES)?;
        let checkpoint: MvsCheckpoint = serde_json::from_slice(&bytes)?;
        if validate_compatible_checkpoint(&checkpoint, scene_sha256, settings_sha256).is_err() {
            continue;
        }
        if latest
            .as_ref()
            .is_none_or(|(_, _, previous)| checkpoint.sequence > previous.sequence)
        {
            latest = Some((entry.path(), ObjectHash::of_bytes(&bytes), checkpoint));
        }
    }
    Ok(latest)
}

fn resume_output_directory(
    checkpoint_path: &Path,
    scratch_root: &Path,
) -> Result<PathBuf, MvsRuntimeError> {
    let checkpoints = checkpoint_path
        .parent()
        .ok_or_else(|| MvsRuntimeError::InvalidPath {
            path: checkpoint_path.to_owned(),
            reason: "checkpoint has no parent".into(),
        })?;
    if checkpoints.file_name() != Some(OsStr::new("checkpoints")) {
        return Err(MvsRuntimeError::InvalidPath {
            path: checkpoint_path.to_owned(),
            reason: "checkpoint is not inside a worker checkpoint directory".into(),
        });
    }
    let scratch =
        canonical_directory(
            checkpoints
                .parent()
                .ok_or_else(|| MvsRuntimeError::InvalidPath {
                    path: checkpoint_path.to_owned(),
                    reason: "checkpoint directory has no run parent".into(),
                })?,
        )?;
    if !scratch.starts_with(scratch_root) {
        return Err(MvsRuntimeError::InvalidPath {
            path: checkpoint_path.to_owned(),
            reason: "checkpoint run escaped the MVS scratch root".into(),
        });
    }
    canonical_directory(&scratch.join("output"))
}

fn copy_resume_output(
    source: &Path,
    destination: &Path,
    cancellation: &CancellationToken,
) -> Result<(), MvsRuntimeError> {
    for name in ["raw", "depth"] {
        let source_child = source.join(name);
        if source_child.is_dir() {
            copy_resume_tree(&source_child, &destination.join(name), cancellation)?;
        }
    }
    Ok(())
}

fn copy_resume_tree(
    source: &Path,
    destination: &Path,
    cancellation: &CancellationToken,
) -> Result<(), MvsRuntimeError> {
    cancellation
        .check()
        .map_err(|_| MvsRuntimeError::Cancelled)?;
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        cancellation
            .check()
            .map_err(|_| MvsRuntimeError::Cancelled)?;
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(MvsRuntimeError::InvalidOutput(
                "resume output contains a symbolic link".into(),
            ));
        }
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_resume_tree(&entry.path(), &target, cancellation)?;
        } else if kind.is_file() {
            let mut input = File::open(entry.path())?;
            let mut output = File::create(&target)?;
            let mut buffer = vec![0_u8; 1024 * 1024].into_boxed_slice();
            loop {
                cancellation
                    .check()
                    .map_err(|_| MvsRuntimeError::Cancelled)?;
                let read = input.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                output.write_all(&buffer[..read])?;
            }
            output.sync_all()?;
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase", deny_unknown_fields)]
enum WorkerEvent {
    Progress {
        stage: WorkerStage,
        completed_units: u64,
        total_units: u64,
        completed_bytes: u64,
        #[serde(default)]
        total_bytes: Option<u64>,
    },
    Checkpoint {
        sequence: u64,
        completed_tiles: u64,
    },
    Log {
        level: WorkerLogLevel,
        message: String,
    },
    CancelAcknowledged,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum WorkerStage {
    DepthEstimation,
    GeometricConsistency,
    DenseFusion,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum WorkerLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug)]
struct ProcessOutcome {
    status: ExitStatus,
    log_tail: Vec<String>,
}

fn spawn_worker(
    executable: &Path,
    arguments: &[OsString],
    scratch: &Path,
) -> Result<Child, MvsRuntimeError> {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .current_dir(scratch)
        .env_clear()
        .env("HIMMELCAD_NETWORK_POLICY", "offline-only")
        .env("NO_PROXY", "*")
        .env("no_proxy", "*")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.env(
        "SYSTEMROOT",
        std::env::var_os("SYSTEMROOT").unwrap_or_default(),
    );
    command.spawn().map_err(MvsRuntimeError::Io)
}

fn supervise_worker(
    child: &mut Child,
    cancellation: &CancellationToken,
    fusion: bool,
    context: &JobWorkerContext,
) -> Result<ProcessOutcome, MvsRuntimeError> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| MvsRuntimeError::InvalidConfig("worker stdout was not piped".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| MvsRuntimeError::InvalidConfig("worker stderr was not piped".into()))?;
    let (sender, receiver) = mpsc::channel::<StreamRecord>();
    spawn_line_reader(stdout, false, sender.clone());
    spawn_line_reader(stderr, true, sender);
    let mut log_tail = VecDeque::with_capacity(LOG_TAIL_LINES);
    let mut cancel_sent_at = None;
    let mut last_stage = 1_u32;
    let mut last_completed = 0_u64;
    let mut last_total = None;

    loop {
        while let Ok(record) = receiver.try_recv() {
            if record.line.len() > MAX_LOG_LINE_BYTES {
                return Err(MvsRuntimeError::InvalidOutput(
                    "worker emitted an oversized log record".into(),
                ));
            }
            if record.stderr {
                push_log(&mut log_tail, format!("stderr: {}", record.line));
                continue;
            }
            match serde_json::from_str::<WorkerEvent>(&record.line) {
                Ok(WorkerEvent::Progress {
                    stage,
                    completed_units,
                    total_units,
                    completed_bytes,
                    total_bytes,
                }) => {
                    let stage_index = match stage {
                        WorkerStage::DepthEstimation => 1,
                        WorkerStage::GeometricConsistency => 2,
                        WorkerStage::DenseFusion if fusion => 3,
                        WorkerStage::DenseFusion => {
                            return Err(MvsRuntimeError::InvalidOutput(
                                "worker fused a cloud although fusion was disabled".into(),
                            ));
                        }
                    };
                    if total_units == 0
                        || completed_units > total_units
                        || stage_index < last_stage
                        || (stage_index == last_stage
                            && (completed_units < last_completed
                                || last_total.is_some_and(|total| total != total_units)))
                    {
                        return Err(MvsRuntimeError::InvalidOutput(
                            "worker progress is not monotone".into(),
                        ));
                    }
                    last_stage = stage_index;
                    last_completed = completed_units;
                    last_total = Some(total_units);
                    report(
                        context,
                        progress(
                            fusion,
                            stage_index,
                            completed_units,
                            Some(total_units),
                            completed_bytes,
                            total_bytes,
                        ),
                    )?;
                }
                Ok(WorkerEvent::Checkpoint {
                    sequence,
                    completed_tiles,
                }) => push_log(
                    &mut log_tail,
                    format!("checkpoint {sequence}: {completed_tiles} tiles"),
                ),
                Ok(WorkerEvent::Log { level, message }) => {
                    push_log(&mut log_tail, format!("{level:?}: {message}"));
                }
                Ok(WorkerEvent::CancelAcknowledged) => {
                    push_log(&mut log_tail, "cancellation acknowledged".into());
                }
                Err(_) => push_log(&mut log_tail, record.line),
            }
        }

        if cancellation.is_cancel_requested() && cancel_sent_at.is_none() {
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(b"{\"command\":\"cancel\"}\n");
                let _ = stdin.flush();
            }
            cancel_sent_at = Some(Instant::now());
        }
        if cancel_sent_at.is_some_and(|instant| instant.elapsed() >= FORCE_KILL_AFTER) {
            let _ = child.kill();
        }
        if let Some(status) = child.try_wait()? {
            while let Ok(record) = receiver.try_recv() {
                push_log(
                    &mut log_tail,
                    if record.stderr {
                        format!("stderr: {}", record.line)
                    } else {
                        record.line
                    },
                );
            }
            if cancellation.is_cancel_requested() {
                return Err(MvsRuntimeError::Cancelled);
            }
            return Ok(ProcessOutcome {
                status,
                log_tail: log_tail.into_iter().collect(),
            });
        }
        thread::sleep(CANCEL_POLL_INTERVAL);
    }
}

#[derive(Debug)]
struct StreamRecord {
    stderr: bool,
    line: String,
}

fn spawn_line_reader(
    stream: impl Read + Send + 'static,
    stderr: bool,
    sender: mpsc::Sender<StreamRecord>,
) {
    thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            let Ok(line) = line else { break };
            if sender.send(StreamRecord { stderr, line }).is_err() {
                break;
            }
        }
    });
}

fn progress(
    fusion: bool,
    stage_index: u32,
    completed_units: u64,
    total_units: Option<u64>,
    completed_bytes: u64,
    total_bytes: Option<u64>,
) -> JobProgress {
    let stage_count = if fusion { 5 } else { 4 };
    let (kind, label) = match stage_index {
        0 => (PhotolabStageKind::Preparing, "Validate MVS inputs"),
        1 => (PhotolabStageKind::DepthEstimation, "Build depth tiles"),
        2 => (
            PhotolabStageKind::DepthEstimation,
            "Validate geometric consistency",
        ),
        3 if fusion => (PhotolabStageKind::DenseFusion, "Fuse point cloud"),
        _ => (PhotolabStageKind::Finalizing, "Validate MVS output"),
    };
    JobProgress {
        stage: PhotolabStage {
            kind,
            index: stage_index,
            stage_count,
            label: label.into(),
        },
        metrics: ProgressMetrics {
            completed_units,
            total_units,
            completed_bytes,
            total_bytes,
        },
    }
}

fn report(context: &JobWorkerContext, value: JobProgress) -> Result<(), MvsRuntimeError> {
    context
        .progress
        .report_blocking(value)
        .map(|_| ())
        .map_err(|error| MvsRuntimeError::Progress(error.to_string()))
}

fn map_worker_error(error: JobWorkerError) -> MvsRuntimeError {
    match error {
        JobWorkerError::Cancelled => MvsRuntimeError::Cancelled,
        JobWorkerError::Failed { message, .. } => MvsRuntimeError::InvalidConfig(message),
    }
}

fn probe_version(executable: &Path) -> Result<String, MvsRuntimeError> {
    let mut child = Command::new(executable)
        .arg("--version")
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                return Err(MvsRuntimeError::InvalidConfig(
                    "worker version probe failed".into(),
                ));
            }
            let mut output = String::new();
            child
                .stdout
                .take()
                .ok_or_else(|| MvsRuntimeError::InvalidConfig("version stdout missing".into()))?
                .read_to_string(&mut output)?;
            let version = output
                .trim()
                .strip_prefix("himmelcad-portable-mvs ")
                .ok_or_else(|| {
                    MvsRuntimeError::InvalidConfig("unexpected worker version output".into())
                })?;
            validate_component("worker version", version)?;
            return Ok(version.into());
        }
        if started.elapsed() >= VERSION_PROBE_TIMEOUT {
            let _ = child.kill();
            return Err(MvsRuntimeError::InvalidConfig(
                "worker version probe timed out".into(),
            ));
        }
        thread::sleep(CANCEL_POLL_INTERVAL);
    }
}

fn create_scratch(root: &Path, job_id: &str) -> Result<PathBuf, MvsRuntimeError> {
    for sequence in 1..=10_000_u32 {
        let candidate = root.join(format!("mvs-{job_id}-{sequence:04}"));
        match fs::create_dir(&candidate) {
            Ok(()) => return canonical_directory(&candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(MvsRuntimeError::InvalidConfig(
        "unable to allocate unique MVS scratch directory".into(),
    ))
}

fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<(), MvsRuntimeError> {
    let bytes = serde_json::to_vec_pretty(value)?;
    let temporary = path.with_extension("json.pending");
    {
        let mut file = File::create(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

fn hash_json(value: &impl Serialize) -> Result<ObjectHash, MvsRuntimeError> {
    Ok(ObjectHash::of_bytes(&serde_json::to_vec(value)?))
}

fn hash_file(
    path: &Path,
    cancellation: Option<&CancellationToken>,
) -> Result<ObjectHash, MvsRuntimeError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        if cancellation.is_some_and(CancellationToken::is_cancel_requested) {
            return Err(MvsRuntimeError::Cancelled);
        }
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(ObjectHash(hex::encode(hasher.finalize())))
}

fn verify_hash(
    path: &Path,
    expected: &ObjectHash,
    observed: &ObjectHash,
) -> Result<(), MvsRuntimeError> {
    if expected == observed {
        Ok(())
    } else {
        Err(MvsRuntimeError::HashMismatch {
            path: path.to_owned(),
            expected: expected.clone(),
            observed: observed.clone(),
        })
    }
}

fn validate_hash(hash: &ObjectHash, field: &'static str) -> Result<(), MvsRuntimeError> {
    if hash.0.len() == 64 && hash.0.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(MvsRuntimeError::InvalidRequest(format!(
            "{field} SHA-256 is malformed"
        )))
    }
}

fn validate_component(field: &str, value: &str) -> Result<(), MvsRuntimeError> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(MvsRuntimeError::InvalidRequest(format!(
            "{field} contains unsafe characters"
        )));
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> Result<(), MvsRuntimeError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(MvsRuntimeError::PathOutsideTrustedRoot(path.to_owned()));
    }
    Ok(())
}

fn canonical_file(path: &Path) -> Result<PathBuf, MvsRuntimeError> {
    let canonical = path
        .canonicalize()
        .map_err(|error| MvsRuntimeError::InvalidPath {
            path: path.to_owned(),
            reason: error.to_string(),
        })?;
    if !canonical.is_file() {
        return Err(MvsRuntimeError::InvalidPath {
            path: canonical,
            reason: "not a regular file".into(),
        });
    }
    Ok(canonical)
}

fn canonical_directory(path: &Path) -> Result<PathBuf, MvsRuntimeError> {
    let canonical = path
        .canonicalize()
        .map_err(|error| MvsRuntimeError::InvalidPath {
            path: path.to_owned(),
            reason: error.to_string(),
        })?;
    if !canonical.is_dir() {
        return Err(MvsRuntimeError::InvalidPath {
            path: canonical,
            reason: "not a directory".into(),
        });
    }
    Ok(canonical)
}

fn canonical_file_inside(path: &Path, root: &Path) -> Result<PathBuf, MvsRuntimeError> {
    let canonical = canonical_file(path)?;
    if !canonical.starts_with(root) {
        return Err(MvsRuntimeError::PathOutsideTrustedRoot(canonical));
    }
    Ok(canonical)
}

fn read_bounded(path: &Path, maximum: u64) -> Result<Vec<u8>, MvsRuntimeError> {
    let file = File::open(path)?;
    let size = file.metadata()?.len();
    if size > maximum {
        return Err(MvsRuntimeError::InvalidPath {
            path: path.to_owned(),
            reason: format!("file exceeds {maximum} bytes"),
        });
    }
    let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
    file.take(maximum.saturating_add(1))
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("validated fixed header"),
    )
}

fn push_log(logs: &mut VecDeque<String>, line: String) {
    if logs.len() == LOG_TAIL_LINES {
        logs.pop_front();
    }
    logs.push_back(line);
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "himmelcad-mvs-{label}-{}-{}",
                std::process::id(),
                NEXT_TEST.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn hash(bytes: &[u8]) -> ObjectHash {
        ObjectHash::of_bytes(bytes)
    }

    fn camera() -> MvsPinholeCamera {
        MvsPinholeCamera {
            fx: 800.0,
            fy: 800.0,
            cx: 500.0,
            cy: 400.0,
            world_to_camera: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        }
    }

    fn request(scene_path: PathBuf, scene_hash: ObjectHash) -> MvsRunRequest {
        MvsRunRequest {
            job_id: "mvs-test".into(),
            scene_manifest_path: scene_path,
            scene_manifest_sha256: scene_hash,
            device: MvsComputeDevice::Cpu { threads: 4 },
            settings: MvsSettings::default(),
            fuse_dense_point_cloud: false,
            resume: None,
        }
    }

    #[test]
    fn settings_reject_tiles_with_unbounded_overlap() {
        let settings = MvsSettings {
            tile_size: 512,
            tile_overlap: 129,
            ..MvsSettings::default()
        };
        assert!(matches!(
            settings.validate(),
            Err(MvsRuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn device_rejects_duplicate_cuda_indices() {
        assert!(matches!(
            MvsComputeDevice::Cuda {
                gpu_indices: vec![0, 0]
            }
            .validate(),
            Err(MvsRuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn manifest_rejects_forbidden_license() {
        let manifest = MvsToolManifest {
            schema_version: 1,
            tool_id: "himmelcad-portable-mvs".into(),
            version: "1.0.0".into(),
            executable: MvsToolFile {
                relative_path: "mvs-worker".into(),
                sha256: hash(b"worker"),
            },
            capabilities: required_capabilities(),
            licenses: vec![MvsLicenseRecord {
                component: "bad".into(),
                version: "1".into(),
                spdx_expression: "LGPL-3.0".into(),
            }],
        };
        assert!(matches!(
            validate_tool_manifest(&manifest),
            Err(MvsRuntimeError::InvalidManifest(_))
        ));
    }

    #[test]
    fn scene_rejects_unknown_neighbor() {
        let directory = TestDirectory::new("scene-neighbor");
        let scene = MvsSceneManifest {
            schema_version: 1,
            coordinate_frame_id: "frame".into(),
            images: vec![
                scene_image("a", &["b", "missing"]),
                scene_image("b", &["a", "c"]),
            ],
        };
        let result = validate_scene(&scene, &directory.0, &CancellationToken::new());
        assert!(matches!(result, Err(MvsRuntimeError::InvalidRequest(_))));
    }

    #[test]
    fn depth_tile_validation_accepts_finite_depth_and_confidence() {
        let directory = TestDirectory::new("valid-tile");
        let path = directory.0.join("tile.hcdt");
        let key = MvsDepthTileKey {
            image_id: "a".into(),
            level: 0,
            x: 2,
            y: 3,
        };
        write_depth_tile(&path, &key, 2, 1, &[(2.5, 0.9), (0.0, 0.0)]);
        let summary = validate_depth_tile(&path, &key, 2, 1).expect("valid tile");
        assert_eq!(summary.valid_pixels, 1);
    }

    #[test]
    fn depth_tile_validation_rejects_nan() {
        let directory = TestDirectory::new("nan-tile");
        let path = directory.0.join("tile.hcdt");
        let key = MvsDepthTileKey {
            image_id: "a".into(),
            level: 0,
            x: 0,
            y: 0,
        };
        write_depth_tile(&path, &key, 1, 1, &[(f32::NAN, 0.5)]);
        assert!(matches!(
            validate_depth_tile(&path, &key, 1, 1),
            Err(MvsRuntimeError::InvalidOutput(_))
        ));
    }

    #[test]
    fn dense_ply_validation_accepts_binary_xyz() {
        let directory = TestDirectory::new("valid-ply");
        let path = directory.0.join("dense.ply");
        let header = b"ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n";
        let mut file = File::create(&path).expect("create ply");
        file.write_all(header).expect("header");
        for value in [1.0_f32, 2.0, 3.0] {
            file.write_all(&value.to_le_bytes()).expect("coordinate");
        }
        drop(file);
        let summary = validate_dense_ply(&path).expect("valid ply");
        assert_eq!(summary.vertex_count, 1);
    }

    #[test]
    fn checkpoint_rejects_changed_settings() {
        let checkpoint = MvsCheckpoint {
            schema_version: 1,
            job_id: "job".into(),
            scene_manifest_sha256: hash(b"scene"),
            settings_sha256: hash(b"old"),
            sequence: 1,
            completed_tiles: BTreeSet::new(),
        };
        assert!(matches!(
            validate_checkpoint(&checkpoint, "job", &hash(b"scene"), &hash(b"new")),
            Err(MvsRuntimeError::InvalidOutput(_))
        ));
    }

    #[test]
    fn compatible_checkpoint_can_resume_a_new_job_without_mutating_old_output() {
        let directory = TestDirectory::new("resume-compatible");
        let scratch = directory.0.join("mvs-old-job-0001");
        let checkpoints = scratch.join("checkpoints");
        let output = scratch.join("output");
        fs::create_dir_all(output.join("raw")).expect("raw output");
        fs::create_dir_all(output.join("depth/a/0")).expect("depth output");
        fs::create_dir_all(&checkpoints).expect("checkpoint output");
        fs::write(output.join("raw/a.raw"), b"immutable raw").expect("raw fixture");
        fs::write(output.join("depth/a/0/0_0.hcdt"), b"immutable tile").expect("tile fixture");
        let scene = hash(b"scene");
        let settings = hash(b"settings");
        let checkpoint = MvsCheckpoint {
            schema_version: 1,
            job_id: "old-job".into(),
            scene_manifest_sha256: scene.clone(),
            settings_sha256: settings.clone(),
            sequence: 8,
            completed_tiles: BTreeSet::new(),
        };
        let checkpoint_path = checkpoints.join("checkpoint-000000000008.json");
        atomic_write_json(&checkpoint_path, &checkpoint).expect("checkpoint fixture");
        let found = latest_compatible_checkpoint(&checkpoints, &scene, &settings)
            .expect("checkpoint discovery")
            .expect("compatible checkpoint");
        validate_resume(
            &MvsResumeCheckpoint {
                path: found.0.clone(),
                sha256: found.1,
            },
            &scene,
            &settings,
        )
        .expect("different job id is compatible");
        let source = resume_output_directory(&found.0, &directory.0).expect("resume output");
        let destination = directory.0.join("new-output");
        fs::create_dir(&destination).expect("new output");
        copy_resume_output(&source, &destination, &CancellationToken::new())
            .expect("copy resume output");
        assert_eq!(
            fs::read(destination.join("raw/a.raw")).expect("copied raw"),
            b"immutable raw"
        );
        fs::write(destination.join("raw/a.raw"), b"new run").expect("overwrite copied raw");
        assert_eq!(
            fs::read(output.join("raw/a.raw")).expect("old raw remains"),
            b"immutable raw"
        );
    }

    #[test]
    fn output_validation_rejects_path_traversal() {
        let directory = TestDirectory::new("output-traversal");
        let output = directory.0.join("output");
        fs::create_dir(&output).expect("output");
        let scene_path = directory.0.join("scene.json");
        let scene = three_image_scene();
        let scene_bytes = serde_json::to_vec(&scene).expect("scene json");
        fs::write(&scene_path, &scene_bytes).expect("scene");
        let request = request(scene_path, ObjectHash::of_bytes(&scene_bytes));
        let settings_sha256 = hash_json(&request.settings).expect("settings hash");
        let index = MvsOutputIndex {
            schema_version: 1,
            job_id: request.job_id.clone(),
            scene_manifest_sha256: request.scene_manifest_sha256.clone(),
            settings_sha256: settings_sha256.clone(),
            device: request.device.clone(),
            depth_images: scene
                .images
                .iter()
                .map(|image| MvsDepthImageRecord {
                    image_id: image.image_id.clone(),
                    width: image.width,
                    height: image.height,
                    camera: image.camera.clone(),
                    tiles: vec![MvsDepthTileRecord {
                        key: MvsDepthTileKey {
                            image_id: image.image_id.clone(),
                            level: 0,
                            x: 0,
                            y: 0,
                        },
                        relative_path: "../escape.hcdt".into(),
                        sha256: hash(b"x"),
                        width: 1,
                        height: 1,
                        valid_pixels: 1,
                    }],
                })
                .collect(),
            dense_point_cloud: None,
        };
        fs::write(
            output.join("index.json"),
            serde_json::to_vec(&index).expect("index json"),
        )
        .expect("index");
        let result = validate_output_directory(
            &output,
            &request,
            &scene,
            &settings_sha256,
            &CancellationToken::new(),
        );
        assert!(matches!(
            result,
            Err(MvsRuntimeError::PathOutsideTrustedRoot(_))
        ));
    }

    fn required_capabilities() -> BTreeSet<MvsCapability> {
        [
            MvsCapability::CpuReference,
            MvsCapability::MultiScalePatchMatch,
            MvsCapability::GeometricConsistency,
            MvsCapability::DenseFusion,
            MvsCapability::OfflineOnly,
        ]
        .into_iter()
        .collect()
    }

    fn scene_image(id: &str, neighbors: &[&str]) -> MvsSceneImage {
        MvsSceneImage {
            image_id: id.into(),
            relative_path: format!("{id}.jpg").into(),
            sha256: hash(id.as_bytes()),
            width: 1_000,
            height: 800,
            camera: camera(),
            minimum_depth: 1.0,
            maximum_depth: 100.0,
            neighbor_image_ids: neighbors.iter().map(ToString::to_string).collect(),
        }
    }

    fn three_image_scene() -> MvsSceneManifest {
        MvsSceneManifest {
            schema_version: 1,
            coordinate_frame_id: "frame".into(),
            images: vec![
                scene_image("a", &["b", "c"]),
                scene_image("b", &["a", "c"]),
                scene_image("c", &["a", "b"]),
            ],
        }
    }

    fn write_depth_tile(
        path: &Path,
        key: &MvsDepthTileKey,
        width: u32,
        height: u32,
        values: &[(f32, f32)],
    ) {
        let mut file = File::create(path).expect("create tile");
        file.write_all(DEPTH_TILE_MAGIC).expect("magic");
        for value in [1, u32::from(key.level), key.x, key.y, width, height, 2, 4] {
            file.write_all(&value.to_le_bytes()).expect("header");
        }
        for (depth, confidence) in values {
            file.write_all(&depth.to_le_bytes()).expect("depth");
            file.write_all(&confidence.to_le_bytes())
                .expect("confidence");
        }
    }
}
