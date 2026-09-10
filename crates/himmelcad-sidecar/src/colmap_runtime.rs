//! Secure, offline orchestration for a curated COLMAP 4.x worker.
//!
//! Command names and option keys follow the COLMAP 4.0 CLI and feature docs:
//! <https://colmap.github.io/legacy/4.0/cli.html> and
//! <https://colmap.github.io/legacy/4.0/features.html>. Public requests select
//! enums and bounded numeric values; no free-form command arguments cross the
//! sidecar boundary.

use std::{
    cmp::Ordering as CmpOrdering,
    collections::{BTreeMap, BTreeSet, VecDeque},
    ffi::{OsStr, OsString},
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

use crate::process_group::{self, ProcessGroupChild as Child};

use himmelcad_core::{
    hash::ObjectHash,
    photolab_images::{DjiBrownConradyCalibration, ExifOrientation, ImageDimensions, PhotoFormat},
    photolab_jobs::{
        CancellationToken, JobProgress, PhotolabMemoryDegradation, PhotolabStage,
        PhotolabStageKind, ProgressMetrics,
    },
    photolab_masks::ImageMaskComputeScope,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::mesh_tiler::PreparedMeshProduct;

use crate::image_commit::{CameraImageMetadataRecord, ProjectCameraImageRecord};
use crate::image_mask_runtime::materialize_colmap_masks;
use crate::job_runtime::{
    matching_stage_memory_limit_bytes, replan_alignment_matching, AlignmentExtractionTiling,
    JobWorkerContext, JobWorkerError, JobWorkerResult, SIFT_MATCHING_BYTES_PER_WORKER,
};
use crate::{
    colmap_feature_db::{
        cap_database_features, maximum_keypoint_count, read_image_features, write_image_features,
        ColmapDescriptorMatrix, ColmapFeatureDbError, ColmapKeypointMatrix,
    },
    dedode_colmap_bridge::{
        merge_tiled_aliked_features, prepare_dedode_colmap_import, DedodeColmapBridgeError,
        TiledAlikedFeature, TiledAlikedFeatureSet,
    },
    dedode_runtime::{DedodeRunOutcome, DedodeToolIdentity},
    dense_raster_prep::PreparedPotreeCloud,
};

const TOOL_MANIFEST_SCHEMA_VERSION: u32 = 1;
const OUTPUT_SUMMARY_SCHEMA_VERSION: u32 = 2;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 64 * 1024;
const LOG_TAIL_LINES: usize = 200;
const MAX_LOG_LINE_BYTES: usize = 16 * 1024;
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(15);
const GIB: u64 = 1024 * 1024 * 1024;
// WP-A7d X6 tunable: 25% covers calibrated model error and child runtime overhead. Two GiB is the
// minimum viable resident envelope for the worker and models.
const WORKER_MEMORY_HEADROOM_NUMERATOR: u64 = 5;
const WORKER_MEMORY_HEADROOM_DENOMINATOR: u64 = 4;
const MINIMUM_WORKER_MEMORY_LIMIT_BYTES: u64 = 2 * GIB;
// WP-A7e X6 calibration: RLIMIT_AS measures virtual address space while the model predicts RSS.
// The A7d smoke reached 6.31 GB RSS at a 10.6 GB address-space limit, so the fallback doubles the
// resident limit to cover thread arenas and mapped weights without pretending the units match.
const WORKER_RLIMIT_AS_MULTIPLIER: u64 = 2;
// WP-A7g X6 diagnostic bound: enough context to identify a systemd property or bus failure while
// keeping the once-per-process line bounded when a launcher emits an unexpectedly large message.
const SYSTEMD_SCOPE_PROBE_DIAGNOSTIC_MAX_CHARS: usize = 512;
#[cfg(target_os = "linux")]
const PRLIMIT_PATH: &str = "/usr/bin/prlimit";
// X6 tunable: depth 11 retains facade-scale detail without the extreme memory growth of
// deeper Poisson octrees on typical workstation dense clouds.
const POISSON_MESHING_DEPTH: u32 = 11;
// X6 tunable: trim 7 removes low-support extrapolated surface while retaining observed edges.
const POISSON_MESHING_TRIM: u32 = 7;
/// Stage label of the mixed-policy pose-only re-adjustment.
const PINNED_INTRINSICS_STAGE: &str = "Refine poses with pinned intrinsics";
/// A pose-only re-adjustment must keep every registered image. Losing one means the pinned
/// calibration no longer explains the block, which is a failed job rather than a quiet product.
const MIN_PINNED_READJUSTMENT_IMAGE_RETENTION: f64 = 1.0;
/// Ceres filters a few degenerate tracks even when the geometry is sound, so a small triangulation
/// loss is tolerated. Anything larger is a collapsed reconstruction.
const MIN_PINNED_READJUSTMENT_POINT_RETENTION: f64 = 0.9;

static NEXT_SCRATCH_SEQUENCE: AtomicU64 = AtomicU64::new(1);
#[cfg(target_os = "linux")]
static SYSTEMD_USER_SCOPE: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

/// Exact capabilities asserted by an audited platform worker manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColmapCapability {
    AlikedN16Rot,
    AlikedN32,
    Sift,
    LightGlue,
    GeometricVerification,
    GlobalMapper,
    IncrementalMapper,
    PatchMatchStereo,
    StereoFusion,
    PoissonMesher,
    DelaunayMesher,
    MeshTexturer,
    FeatureImporter,
    MatchesImporter,
    ModelConverter,
    ModelAligner,
    /// Standalone bundle adjuster used by the mixed-policy pose-only re-adjustment.
    BundleAdjuster,
    OfflineOnlyBuild,
}

/// Named local model files used by the typed COLMAP command builders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColmapResourceKind {
    AlikedN16RotModel,
    AlikedN32Model,
    AlikedLightGlueModel,
    SiftLightGlueModel,
}

/// One content-addressed file in the signed tool manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolFileRecord {
    pub relative_path: PathBuf,
    pub sha256: ObjectHash,
}

/// Audited dependency and license inventory entry shipped with the worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolLicenseRecord {
    pub component: String,
    pub version: String,
    pub spdx_expression: String,
}

/// Signed platform-specific description of a curated COLMAP worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColmapToolManifest {
    pub schema_version: u32,
    pub tool_id: String,
    pub version: String,
    pub executable: ToolFileRecord,
    pub resources: BTreeMap<ColmapResourceKind, ToolFileRecord>,
    pub capabilities: BTreeSet<ColmapCapability>,
    pub licenses: Vec<ToolLicenseRecord>,
}

/// Paths and trust pins used before any worker process is started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColmapRuntimeConfig {
    pub tool_root: PathBuf,
    pub manifest_path: PathBuf,
    pub detached_signature_path: PathBuf,
    pub expected_manifest_sha256: ObjectHash,
    pub trusted_signer_key_id: String,
    pub scratch_root: PathBuf,
    pub allowed_project_roots: Vec<PathBuf>,
}

/// Explicitly untrusted local-development worker configuration.
///
/// This path is for developer machines with a locally built COLMAP 4.x. It
/// performs binary/resource hashing and CLI capability probes, but cannot be
/// used as a release trust substitute because it has no signed manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevColmapRuntimeConfig {
    pub executable: PathBuf,
    pub version: String,
    pub resources: BTreeMap<ColmapResourceKind, PathBuf>,
    pub scratch_root: PathBuf,
    pub allowed_project_roots: Vec<PathBuf>,
}

/// Product-provided detached-signature verifier.
///
/// The orchestrator deliberately does not invent a signature scheme. Release
/// tooling supplies an audited verifier and keyring; SHA-256 pinning and every
/// payload hash are still enforced locally by this module.
pub trait ManifestSignatureVerifier: Send + Sync {
    fn verify_detached(
        &self,
        signer_key_id: &str,
        manifest: &[u8],
        signature: &[u8],
    ) -> Result<(), String>;
}

/// Execution device without an arbitrary backend argument escape hatch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ColmapComputeDevice {
    Cpu,
    Cuda { gpu_indices: Vec<u32> },
}

impl ColmapComputeDevice {
    fn validate(&self) -> Result<(), ColmapRuntimeError> {
        if let Self::Cuda { gpu_indices } = self {
            if gpu_indices.is_empty() {
                return Err(ColmapRuntimeError::InvalidRequest(
                    "CUDA device selection must contain at least one GPU index".into(),
                ));
            }
            let unique = gpu_indices.iter().copied().collect::<BTreeSet<_>>();
            if unique.len() != gpu_indices.len() {
                return Err(ColmapRuntimeError::InvalidRequest(
                    "CUDA GPU indices must be unique".into(),
                ));
            }
        }
        Ok(())
    }

    fn use_gpu(&self) -> &'static str {
        match self {
            Self::Cpu => "0",
            Self::Cuda { .. } => "1",
        }
    }

    fn gpu_indices(&self) -> String {
        match self {
            Self::Cpu => "-1".into(),
            Self::Cuda { gpu_indices } => gpu_indices
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(","),
        }
    }
}

/// Bounded, documented image-pair selection modes from COLMAP 4.x.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ColmapPairSelection {
    Exhaustive,
    Sequential { overlap: u32 },
}

/// Which independently verified feature store seeds sparse reconstruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MappingFeatureStore {
    Aliked,
    Sift,
}

/// Audited ALIKED models available in COLMAP 4.x.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AlikedModelVariant {
    N16Rot,
    N32,
}

/// Policy expected from the separate DeDoDe-v2-G worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DedodeV2GPolicy {
    Gated,
    AllPairs,
}

/// Large matcher contract. COLMAP cannot execute `DeDoDe` itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LargeMatchingBackend {
    Disabled,
    DedodeV2G { policy: DedodeV2GPolicy },
}

/// Typed surface reconstruction choice exposed by COLMAP 4.x.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColmapMesher {
    Poisson,
    Delaunay,
}

/// One independently admitted mesh reconstruction from an immutable dense cloud.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColmapMeshRequest {
    pub executable: PathBuf,
    pub project_root: PathBuf,
    pub input_path: PathBuf,
    pub output_path: PathBuf,
    pub mesher: ColmapMesher,
}

/// Optional dense-product stages. Dependencies are validated before spawning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColmapProductRequest {
    pub depth_maps: bool,
    pub dense_point_cloud: bool,
    pub mesh: Option<ColmapMesher>,
    pub texture_mesh: bool,
    pub max_image_size: u32,
}

impl Default for ColmapProductRequest {
    fn default() -> Self {
        Self {
            depth_maps: false,
            dense_point_cloud: false,
            mesh: None,
            texture_mesh: false,
            max_image_size: 3_200,
        }
    }
}

/// Fully typed immutable input to one offline COLMAP run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColmapRunRequest {
    pub job_id: String,
    pub project_root: PathBuf,
    pub camera_images: Vec<ProjectCameraImageRecord>,
    /// Exact immutable mask selection for this camera/processing-set scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_mask_scope: Option<ImageMaskComputeScope>,
    /// Explicit persisted calibration partitions. When present, these groups are kept as
    /// separate COLMAP camera records even if their current seed values happen to match.
    #[serde(default)]
    pub calibration_groups: Vec<ColmapCalibrationGroup>,
    pub device: ColmapComputeDevice,
    pub pair_selection: ColmapPairSelection,
    pub mapping_store: MappingFeatureStore,
    pub aliked_variant: AlikedModelVariant,
    pub large_matching_backend: LargeMatchingBackend,
    pub aliked_max_features: u32,
    pub sift_max_features: u32,
    /// Runs only the selected primary store until both mappers fail, then extracts the other
    /// store as a rescue. Fast selects classical SIFT first and ALIKED as the neural rescue.
    pub sift_rescue_only: bool,
    pub max_image_size: u32,
    /// Deterministic time-first ALIKED grid. SIFT extraction ignores this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extraction_tiling: Option<AlignmentExtractionTiling>,
    /// Complete job envelope used for post-extraction matching replanning.
    pub memory_envelope_bytes: u64,
    /// Calibrated extraction unit from the immutable admission plan.
    pub extraction_memory_unit_bytes: u64,
    pub logical_cpus: u16,
    /// Hardware-adaptive worker count. This changes throughput and memory only.
    pub feature_worker_threads: u16,
    /// Hardware-adaptive ALIKED/LightGlue worker count.
    pub aliked_matching_worker_threads: u16,
    /// Hardware-adaptive LightGlue worker count. This changes throughput and memory only.
    pub matching_worker_threads: u16,
    /// Quality-last memory fallbacks frozen before COLMAP is invoked.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub degradations: Vec<PhotolabMemoryDegradation>,
    pub products: ColmapProductRequest,
    /// Profile-explicit mapper behavior for reliable embedded calibration.
    #[serde(default)]
    pub intrinsics_refinement: ColmapIntrinsicsRefinement,
    /// Calibration groups whose per-group policy pins their intrinsics while at least one other
    /// group must still be refined. COLMAP's mapper only knows run-wide refinement flags, so a
    /// non-empty list selects the mixed strategy: refine everything, then restore exactly these
    /// groups to their seeds and re-adjust poses only.
    ///
    /// Empty for every single-policy run, and skipped when serializing so those runs keep their
    /// historical configuration hash.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pinned_calibration_group_ids: Vec<String>,
}

/// Run-level outcome of the per-calibration-group intrinsics policy.
///
/// COLMAP cannot mask bundle-adjustment refinement per camera, so a run with disagreeing groups
/// needs an explicit extra pass instead of a silently wrong run-wide binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ColmapIntrinsicsStrategy {
    /// Every group is pinned. The mapper runs with refinement off, exactly as before.
    AllFixed,
    /// No group is pinned. The mapper runs with refinement on, exactly as before.
    #[default]
    AllRefine,
    /// Groups disagree. The mapper refines every seeded group, the pinned groups are restored to
    /// their seeds, and a pose-only re-adjustment re-optimizes poses and points.
    Mixed,
}

/// Re-adjustment path that actually ran for a `Mixed` strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PinnedIntrinsicsReadjustmentPath {
    /// The vendored COLMAP `bundle_adjuster` with all three refine flags disabled.
    ColmapBundleAdjuster,
}

/// Evidence that the pose-only re-adjustment kept the reconstruction intact.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedIntrinsicsReadjustment {
    pub path: PinnedIntrinsicsReadjustmentPath,
    pub registered_images_before: u64,
    pub registered_images_after: u64,
    pub points3d_before: u64,
    pub points3d_after: u64,
}

/// Per-group interior-orientation movement across one solve.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationGroupIntrinsicsDelta {
    pub group_id: String,
    /// True when the group's policy pinned its intrinsics for this run.
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_focal_pixels: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solved_focal_pixels: Option<f64>,
    /// `solved - seed`, in source-image pixels. Pinned groups must report zero.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focal_delta_pixels: Option<f64>,
}

/// Controls whether mapper bundle adjustment may change embedded intrinsics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ColmapIntrinsicsRefinement {
    /// Metadata-poor cameras use COLMAP's full focal and distortion refinement.
    #[default]
    Refine,
    /// Every profile preserves reliable embedded focal, principal point and distortion.
    /// Quality profiles add stronger matching/mapping backends, not calibration drift.
    FreezeReliableEmbedded,
}

/// One immutable camera-intrinsics partition supplied by the project domain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColmapCalibrationGroup {
    pub group_id: String,
    pub camera_entity_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<ColmapCalibrationSeed>,
}

/// Optional initial pinhole calibration for an explicit group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColmapCalibrationSeed {
    pub width_pixels: u32,
    pub height_pixels: u32,
    pub focal_pixels: f64,
    pub principal_x_pixels: f64,
    pub principal_y_pixels: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_brown_calibration: Option<DjiBrownConradyCalibration>,
}

impl ColmapRunRequest {
    /// Produces the immutable progress plan required by `JobWorkerContext`.
    pub fn progress_plan(&self) -> ColmapProgressPlan {
        ColmapProgressPlan::for_request(self)
    }

    /// Run-level outcome of the per-group intrinsics policy carried by this request.
    pub fn intrinsics_strategy(&self) -> ColmapIntrinsicsStrategy {
        if !self.pinned_calibration_group_ids.is_empty() {
            return ColmapIntrinsicsStrategy::Mixed;
        }
        match self.intrinsics_refinement {
            ColmapIntrinsicsRefinement::Refine => ColmapIntrinsicsStrategy::AllRefine,
            ColmapIntrinsicsRefinement::FreezeReliableEmbedded => {
                ColmapIntrinsicsStrategy::AllFixed
            }
        }
    }

    fn validate(&self) -> Result<(), ColmapRuntimeError> {
        validate_component("job_id", &self.job_id)?;
        if self.camera_images.is_empty() {
            return Err(ColmapRuntimeError::InvalidRequest(
                "at least one image is required".into(),
            ));
        }
        if let Some(scope) = self.image_mask_scope.as_ref() {
            let mut requested = self
                .camera_images
                .iter()
                .map(|camera| camera.entity_id.clone())
                .collect::<Vec<_>>();
            requested.sort_by(|left, right| left.0.cmp(&right.0));
            if scope.camera_entity_ids != requested {
                return Err(ColmapRuntimeError::InvalidRequest(
                    "image-mask camera scope differs from the COLMAP request".into(),
                ));
            }
        }
        validate_explicit_calibration_groups(self)?;
        validate_pinned_calibration_groups(self)?;
        if self.aliked_max_features == 0 || self.sift_max_features == 0 {
            return Err(ColmapRuntimeError::InvalidRequest(
                "feature limits must be greater than zero".into(),
            ));
        }
        if self.max_image_size == 0 || self.products.max_image_size == 0 {
            return Err(ColmapRuntimeError::InvalidRequest(
                "maximum image sizes must be greater than zero".into(),
            ));
        }
        if let Some(tiling) = self.extraction_tiling {
            if tiling.columns == 0
                || tiling.rows == 0
                || tiling.tiles != tiling.columns.saturating_mul(tiling.rows)
                || tiling.tiles < 2
                || tiling.overlap_px == 0
            {
                return Err(ColmapRuntimeError::InvalidRequest(
                    "ALIKED extraction tiling must be a non-empty multi-tile grid with overlap"
                        .into(),
                ));
            }
        }
        if self.feature_worker_threads == 0
            || self.aliked_matching_worker_threads == 0
            || self.matching_worker_threads == 0
        {
            return Err(ColmapRuntimeError::InvalidRequest(
                "feature and matching worker threads must be greater than zero".into(),
            ));
        }
        if self.memory_envelope_bytes == 0
            || self.extraction_memory_unit_bytes == 0
            || self.logical_cpus == 0
        {
            return Err(ColmapRuntimeError::InvalidRequest(
                "alignment memory envelope, extraction unit and logical CPUs must be greater than zero"
                    .into(),
            ));
        }
        if let ColmapPairSelection::Sequential { overlap } = self.pair_selection {
            if overlap == 0 {
                return Err(ColmapRuntimeError::InvalidRequest(
                    "sequential overlap must be greater than zero".into(),
                ));
            }
        }
        if self.products.texture_mesh && self.products.mesh.is_none() {
            return Err(ColmapRuntimeError::InvalidRequest(
                "texture generation requires a mesh".into(),
            ));
        }
        if self.products.mesh.is_some() && !self.products.dense_point_cloud {
            return Err(ColmapRuntimeError::InvalidRequest(
                "meshing requires dense point-cloud fusion".into(),
            ));
        }
        if self.products.dense_point_cloud && !self.products.depth_maps {
            return Err(ColmapRuntimeError::InvalidRequest(
                "dense point-cloud fusion requires depth maps".into(),
            ));
        }
        if self.products.depth_maps && matches!(self.device, ColmapComputeDevice::Cpu) {
            return Err(ColmapRuntimeError::InvalidRequest(
                "COLMAP PatchMatch requires a curated CUDA worker".into(),
            ));
        }
        self.device.validate()?;
        Ok(())
    }
}

/// One stable stage in the command plan shown through the job runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColmapPlannedStage {
    pub kind: PhotolabStageKind,
    pub label: String,
}

/// Immutable stage sequence for a typed request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColmapProgressPlan {
    pub stages: Vec<ColmapPlannedStage>,
}

impl ColmapProgressPlan {
    fn for_request(request: &ColmapRunRequest) -> Self {
        let primary_store = FeatureStoreKind::from_mapping(request.mapping_store);
        let mut stages = vec![planned(PhotolabStageKind::Preparing, "COLMAP preflight")];
        stages.extend(feature_store_stages(primary_store));
        if !request.sift_rescue_only {
            stages.extend(feature_store_stages(primary_store.rescue()));
        }
        if matches!(
            request.large_matching_backend,
            LargeMatchingBackend::DedodeV2G { .. }
        ) {
            stages.extend([
                planned(
                    PhotolabStageKind::FeatureExtraction,
                    "Import DeDoDe keypoints",
                ),
                planned(PhotolabStageKind::FeatureMatching, "Import DeDoDe matches"),
                planned(
                    PhotolabStageKind::GeometricVerification,
                    "Verify DeDoDe geometry",
                ),
                planned(
                    PhotolabStageKind::SparseReconstruction,
                    "Build hybrid reconstructions",
                ),
                planned(
                    PhotolabStageKind::SparseReconstruction,
                    "Evaluate hybrid reconstructions",
                ),
            ]);
        } else {
            stages.extend([
                planned(
                    PhotolabStageKind::SparseReconstruction,
                    "Calibrate view graph",
                ),
                planned(
                    PhotolabStageKind::SparseReconstruction,
                    "Build global reconstruction",
                ),
                planned(
                    PhotolabStageKind::SparseReconstruction,
                    "Build incremental fallback",
                ),
            ]);
        }
        if request.sift_rescue_only {
            stages.extend(feature_store_stages(primary_store.rescue()));
            stages.push(planned(
                PhotolabStageKind::SparseReconstruction,
                "Retry incremental reconstruction",
            ));
        }
        if request.intrinsics_strategy() == ColmapIntrinsicsStrategy::Mixed {
            stages.push(planned(
                PhotolabStageKind::BundleAdjustment,
                PINNED_INTRINSICS_STAGE,
            ));
        }
        if projected_reference_count(request) >= 3 {
            stages.push(planned(
                PhotolabStageKind::SparseReconstruction,
                "Georeference with GPS/RTK",
            ));
        }
        stages.push(planned(
            PhotolabStageKind::Finalizing,
            "Export sparse point cloud",
        ));
        if request.products.depth_maps {
            stages.push(planned(
                PhotolabStageKind::DepthEstimation,
                "Undistort images",
            ));
            stages.push(planned(
                PhotolabStageKind::DepthEstimation,
                "Build PatchMatch depth maps",
            ));
        }
        if request.products.dense_point_cloud {
            stages.push(planned(PhotolabStageKind::DenseFusion, "Fuse depth maps"));
        }
        if request.products.mesh.is_some() {
            stages.push(planned(PhotolabStageKind::Meshing, "Build mesh"));
        }
        if request.products.texture_mesh {
            stages.push(planned(PhotolabStageKind::Meshing, "Texture mesh"));
        }
        stages.push(planned(PhotolabStageKind::Finalizing, "Validate outputs"));
        Self { stages }
    }

    /// Initial progress value to put into `NewPhotolabJob` before scheduling.
    pub fn initial_progress(&self) -> JobProgress {
        self.progress(0, ProgressMetrics::empty())
    }

    fn progress(&self, index: usize, metrics: ProgressMetrics) -> JobProgress {
        let stage = &self.stages[index];
        JobProgress {
            stage: PhotolabStage {
                kind: stage.kind,
                index: u32::try_from(index).expect("COLMAP stage count fits u32"),
                stage_count: u32::try_from(self.stages.len()).expect("COLMAP stage count fits u32"),
                label: stage.label.clone(),
            },
            metrics,
        }
    }

    fn index_of(&self, label: &str) -> usize {
        self.stages
            .iter()
            .position(|stage| stage.label == label)
            .expect("all executed COLMAP stages belong to the immutable plan")
    }
}

fn planned(kind: PhotolabStageKind, label: &str) -> ColmapPlannedStage {
    ColmapPlannedStage {
        kind,
        label: label.into(),
    }
}

fn feature_store_stages(store: FeatureStoreKind) -> [ColmapPlannedStage; 3] {
    match store {
        FeatureStoreKind::Aliked => [
            planned(PhotolabStageKind::FeatureExtraction, "Extract ALIKED"),
            planned(
                PhotolabStageKind::FeatureMatching,
                "Match ALIKED with LightGlue",
            ),
            planned(
                PhotolabStageKind::GeometricVerification,
                "Verify ALIKED geometry",
            ),
        ],
        FeatureStoreKind::Sift => [
            planned(PhotolabStageKind::FeatureExtraction, "Extract SIFT"),
            planned(PhotolabStageKind::FeatureMatching, "Match SIFT features"),
            planned(
                PhotolabStageKind::GeometricVerification,
                "Verify SIFT geometry",
            ),
        ],
    }
}

/// Mapper that produced the sparse model used by later stages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SelectedMapper {
    Global,
    IncrementalFallback,
}

/// Independently verified feature graph that won deterministic model scoring.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SelectedFeatureStore {
    Aliked,
    Sift,
    DedodeV2G,
}

/// Comparable statistics extracted from COLMAP's public sparse text model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingCandidateSummary {
    pub feature_store: SelectedFeatureStore,
    pub mapper: SelectedMapper,
    pub registered_images: u64,
    pub points3d: u64,
    pub observations: u64,
    pub mean_reprojection_error: Option<f64>,
    pub selected: bool,
}

/// Fixed COLMAP command identities accepted by this orchestrator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColmapCommandKind {
    FeatureExtractor,
    FeatureImporter,
    MatchesImporter,
    ExhaustiveMatcher,
    SequentialMatcher,
    GeometricVerifier,
    ViewGraphCalibrator,
    GlobalMapper,
    Mapper,
    ModelConverter,
    ModelAligner,
    BundleAdjuster,
    ImageUndistorter,
    PatchMatchStereo,
    StereoFusion,
    PoissonMesher,
    DelaunayMesher,
    MeshTexturer,
}

impl ColmapCommandKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::FeatureExtractor => "feature_extractor",
            Self::FeatureImporter => "feature_importer",
            Self::MatchesImporter => "matches_importer",
            Self::ExhaustiveMatcher => "exhaustive_matcher",
            Self::SequentialMatcher => "sequential_matcher",
            Self::GeometricVerifier => "geometric_verifier",
            Self::ViewGraphCalibrator => "view_graph_calibrator",
            Self::GlobalMapper => "global_mapper",
            Self::Mapper => "mapper",
            Self::ModelConverter => "model_converter",
            Self::ModelAligner => "model_aligner",
            Self::BundleAdjuster => "bundle_adjuster",
            Self::ImageUndistorter => "image_undistorter",
            Self::PatchMatchStereo => "patch_match_stereo",
            Self::StereoFusion => "stereo_fusion",
            Self::PoissonMesher => "poisson_mesher",
            Self::DelaunayMesher => "delaunay_mesher",
            Self::MeshTexturer => "mesh_texturer",
        }
    }
}

/// Bounded log and timing provenance for one child invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColmapCommandReport {
    pub command: ColmapCommandKind,
    pub stage_index: u32,
    pub argv: Vec<String>,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub log_tail: Vec<String>,
}

/// Content-addressed artifact types that may leave the scratch workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColmapArtifactKind {
    AlikedVerifiedDatabase,
    SiftVerifiedDatabase,
    DedodeVerifiedDatabase,
    SparseModel,
    SparsePointCloud,
    DepthMaps,
    DensePointCloud,
    Mesh,
    TexturedMesh,
}

/// Immutable digest and size for one file or directory tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColmapArtifactSummary {
    pub kind: ColmapArtifactKind,
    pub relative_path: PathBuf,
    pub sha256: ObjectHash,
    pub bytes: u64,
}

/// Validated worker result. Project publication remains a separate core command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColmapOutputSummary {
    pub schema_version: u32,
    pub job_id: String,
    pub tool_manifest_sha256: ObjectHash,
    pub executable_sha256: ObjectHash,
    pub colmap_version: String,
    pub camera_entity_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_mask_scope_sha256: Option<ObjectHash>,
    /// Exact intrinsics partition used by this solve. This is output lineage, not a lookup into
    /// the project's potentially newer capture-group view.
    #[serde(default)]
    pub calibration_groups: Vec<ColmapCalibrationGroup>,
    #[serde(default)]
    pub intrinsics_refinement: ColmapIntrinsicsRefinement,
    /// Run-level outcome of the per-group intrinsics policy.
    #[serde(default)]
    pub intrinsics_strategy: ColmapIntrinsicsStrategy,
    /// Groups restored to their seeds after a mixed-policy solve.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pinned_calibration_group_ids: Vec<String>,
    /// Which re-adjustment path ran, and the triangulation-consistency evidence it produced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_readjustment: Option<PinnedIntrinsicsReadjustment>,
    /// Per-group seed/solved focal lengths for the processing report.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub calibration_group_intrinsics: Vec<CalibrationGroupIntrinsicsDelta>,
    pub selected_mapper: SelectedMapper,
    pub selected_feature_store: SelectedFeatureStore,
    /// Time-first ALIKED extraction choice frozen into alignment lineage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extraction_tiled: Option<ColmapExtractionTiled>,
    /// Identity of the DeDoDe toolchain when the selected feature store came from it (IF-D26).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dedode_tool: Option<DedodeToolIdentity>,
    pub mapping_candidates: Vec<MappingCandidateSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub degradations: Vec<PhotolabMemoryDegradation>,
    pub commands: Vec<ColmapCommandReport>,
    pub artifacts: Vec<ColmapArtifactSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColmapExtractionTiled {
    pub tiles: u32,
    pub overlap_px: u32,
}

/// Durable summary file and isolated scratch location returned to the publisher.
#[derive(Debug, Clone, PartialEq)]
pub struct ColmapRunOutcome {
    pub scratch_path: PathBuf,
    pub summary_path: PathBuf,
    pub summary_sha256: ObjectHash,
    pub summary: ColmapOutputSummary,
    pub sparse_potree: Option<PreparedPotreeCloud>,
    pub prepared_mesh: Option<PreparedMeshProduct>,
    pub prepared_textured_mesh: Option<PreparedMeshProduct>,
}

#[derive(Debug, Clone)]
struct VerifiedToolchain {
    manifest: ColmapToolManifest,
    manifest_sha256: ObjectHash,
    executable: PathBuf,
    executable_sha256: ObjectHash,
    resources: BTreeMap<ColmapResourceKind, PathBuf>,
}

type DevelopmentResources = (
    BTreeMap<ColmapResourceKind, ToolFileRecord>,
    BTreeMap<ColmapResourceKind, PathBuf>,
);

/// Preflighted process runner. Construction performs all trust and hash checks.
#[derive(Clone)]
pub struct ColmapRuntime {
    toolchain: Arc<VerifiedToolchain>,
    scratch_root: PathBuf,
    allowed_project_roots: Arc<Vec<PathBuf>>,
}

impl std::fmt::Debug for ColmapRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ColmapRuntime")
            .field("version", &self.toolchain.manifest.version)
            .field("scratch_root", &self.scratch_root)
            .finish_non_exhaustive()
    }
}

/// Runs only the requested COLMAP mesher under the same bounded child-process supervisor used by
/// complete reconstruction jobs. The caller owns publication and must keep `input_path` immutable.
pub fn run_colmap_mesher(
    request: &ColmapMeshRequest,
    context: &JobWorkerContext,
) -> Result<ColmapCommandReport, ColmapRuntimeError> {
    context.check_cancelled().map_err(map_worker_error)?;
    let project_root = canonical_directory(&request.project_root)?;
    let executable =
        request
            .executable
            .canonicalize()
            .map_err(|error| ColmapRuntimeError::InvalidPath {
                path: request.executable.clone(),
                reason: error.to_string(),
            })?;
    if !executable.is_file() {
        return Err(ColmapRuntimeError::InvalidPath {
            path: executable,
            reason: "COLMAP executable is not a regular file".into(),
        });
    }
    let input = canonical_file_inside(&request.input_path, &project_root)?;
    let output_parent =
        request
            .output_path
            .parent()
            .ok_or_else(|| ColmapRuntimeError::InvalidPath {
                path: request.output_path.clone(),
                reason: "mesh output has no parent directory".into(),
            })?;
    fs::create_dir_all(output_parent)?;
    let output_parent = canonical_directory(output_parent)?;
    if !output_parent.starts_with(&project_root) {
        return Err(ColmapRuntimeError::PathOutsideTrustedRoot(output_parent));
    }
    let output = output_parent.join(request.output_path.file_name().ok_or_else(|| {
        ColmapRuntimeError::InvalidPath {
            path: request.output_path.clone(),
            reason: "mesh output has no file name".into(),
        }
    })?);
    if output.exists() || input == output {
        return Err(ColmapRuntimeError::InvalidPath {
            path: output,
            reason: "mesh output must be a new file distinct from the immutable input".into(),
        });
    }
    let (kind, args) = match request.mesher {
        ColmapMesher::Poisson => (
            ColmapCommandKind::PoissonMesher,
            vec![
                os("--input_path"),
                input.as_os_str().to_owned(),
                os("--output_path"),
                output.as_os_str().to_owned(),
                os("--PoissonMeshing.depth"),
                os(POISSON_MESHING_DEPTH.to_string()),
                os("--PoissonMeshing.trim"),
                os(POISSON_MESHING_TRIM.to_string()),
            ],
        ),
        ColmapMesher::Delaunay => (
            ColmapCommandKind::DelaunayMesher,
            vec![
                os("--input_path"),
                input.as_os_str().to_owned(),
                os("--output_path"),
                output.as_os_str().to_owned(),
            ],
        ),
    };
    let spec = CommandSpec {
        kind,
        stage_label: "Build dense-cloud mesh",
        args,
    };
    let plan = ColmapProgressPlan {
        stages: vec![
            planned(PhotolabStageKind::Meshing, "Build dense-cloud mesh"),
            planned(PhotolabStageKind::Meshing, "Prepare mesh for viewing"),
        ],
    };
    let mut state = RunState::new(output_parent, plan);
    let report = {
        let started = Instant::now();
        state.report_stage(context, spec.stage_label, ProgressMetrics::empty())?;
        let (mut child, _) = spawn_colmap_child(&executable, &spec, &state.scratch, None)?;
        let mut progress_error = None;
        let supervised = supervise_child(&mut child, &context.cancellation, |completed, total| {
            if progress_error.is_none() {
                progress_error = state
                    .report_stage(
                        context,
                        spec.stage_label,
                        ProgressMetrics {
                            completed_units: completed,
                            total_units: Some(total),
                            completed_bytes: 0,
                            total_bytes: None,
                        },
                    )
                    .err();
            }
        });
        let peak_rss_bytes = child.peak_rss_bytes();
        context
            .memory
            .record_stage_peak_blocking(
                spec.stage_label,
                peak_rss_bytes,
                command_worker_count(&spec),
                command_memory_parameters(&spec),
            )
            .map_err(|error| ColmapRuntimeError::Progress(error.to_string()))?;
        context
            .memory
            .record_unbounded_stage_blocking(spec.stage_label)
            .map_err(|error| ColmapRuntimeError::Progress(error.to_string()))?;
        let outcome = supervised?;
        if let Some(error) = progress_error {
            return Err(error);
        }
        ColmapCommandReport {
            command: spec.kind,
            stage_index: 0,
            argv: spec
                .args
                .iter()
                .map(|value| value.to_string_lossy().into_owned())
                .collect(),
            success: outcome.status.success(),
            exit_code: outcome.status.code(),
            duration_ms: millis_u64(started.elapsed()),
            log_tail: outcome.log_tail,
        }
    };
    if !report.success {
        return Err(command_failure(&report));
    }
    state.report_complete(context, spec.stage_label)?;
    if !output.is_file() {
        return Err(ColmapRuntimeError::MissingOutput(output));
    }
    Ok(report)
}

fn command_worker_count(spec: &CommandSpec) -> u16 {
    command_option(spec, "--FeatureExtraction.num_threads")
        .or_else(|| command_option(spec, "--FeatureMatching.num_threads"))
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(1)
}

fn command_memory_parameters(spec: &CommandSpec) -> serde_json::Value {
    let mut parameters = serde_json::Map::new();
    parameters.insert(
        "command".into(),
        serde_json::Value::String(spec.kind.as_str().into()),
    );
    for (argument, name) in [
        ("--FeatureExtraction.max_image_size", "maxImageSize"),
        ("--AlikedExtraction.max_num_features", "keypoints"),
        ("--SiftExtraction.max_num_features", "siftLocations"),
    ] {
        if let Some(value) = command_option(spec, argument) {
            parameters.insert(name.into(), serde_json::Value::String(value.into()));
        }
    }
    serde_json::Value::Object(parameters)
}

fn command_option<'a>(spec: &'a CommandSpec, name: &str) -> Option<&'a str> {
    spec.args.windows(2).find_map(|pair| {
        (pair[0] == std::ffi::OsStr::new(name))
            .then(|| pair[1].to_str())
            .flatten()
    })
}

fn set_command_option(args: &mut [OsString], name: &str, value: String) {
    let Some(index) = args
        .iter()
        .position(|argument| argument == OsStr::new(name))
    else {
        return;
    };
    if let Some(argument) = args.get_mut(index.saturating_add(1)) {
        *argument = OsString::from(value);
    }
}

/// Removes only the pairwise matches produced by an interrupted matcher attempt. Images,
/// keypoints, descriptors, and geometric-verification results are outside the retry's output
/// scope and remain untouched.
fn clear_partial_matching_output(database: &Path) -> Result<(), ColmapRuntimeError> {
    let mut connection = rusqlite::Connection::open_with_flags(
        database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(ColmapFeatureDbError::from)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(ColmapFeatureDbError::from)?;
    transaction
        .execute("DELETE FROM matches", [])
        .map_err(ColmapFeatureDbError::from)?;
    transaction.commit().map_err(ColmapFeatureDbError::from)?;
    Ok(())
}

impl ColmapRuntime {
    fn run_dedode_store(
        &self,
        request: &ColmapRunRequest,
        outcome: &DedodeRunOutcome,
        context: &JobWorkerContext,
        image_directory: &Path,
        materialized_images: &[PathBuf],
        state: &mut RunState,
    ) -> Result<(), ColmapRuntimeError> {
        state.report_stage(context, "Import DeDoDe keypoints", ProgressMetrics::empty())?;
        let import = prepare_dedode_colmap_import(
            outcome,
            &request.camera_images,
            materialized_images,
            &state.scratch,
            &context.cancellation,
        )
        .map_err(map_dedode_bridge_error)?;
        self.execute_required(
            &CommandSpec {
                kind: ColmapCommandKind::FeatureImporter,
                stage_label: "Import DeDoDe keypoints",
                args: vec![
                    os("--database_path"),
                    import.database_path.as_os_str().to_owned(),
                    os("--image_path"),
                    image_directory.as_os_str().to_owned(),
                    os("--import_path"),
                    import.feature_directory.as_os_str().to_owned(),
                ],
            },
            context,
            state,
        )?;
        state.report_complete(context, "Import DeDoDe matches")?;
        self.execute_required(
            &CommandSpec {
                kind: ColmapCommandKind::MatchesImporter,
                stage_label: "Verify DeDoDe geometry",
                args: vec![
                    os("--database_path"),
                    import.database_path.as_os_str().to_owned(),
                    os("--match_list_path"),
                    import.match_list_path.as_os_str().to_owned(),
                    os("--match_type"),
                    os("raw"),
                ],
            },
            context,
            state,
        )
    }

    /// Verifies detached signature, manifest pin, executable, resources and licenses.
    pub fn preflight(
        config: &ColmapRuntimeConfig,
        verifier: &dyn ManifestSignatureVerifier,
    ) -> Result<Self, ColmapRuntimeError> {
        validate_hash(&config.expected_manifest_sha256, "manifest")?;
        if config.trusted_signer_key_id.trim().is_empty() {
            return Err(ColmapRuntimeError::InvalidConfig(
                "trusted signer key id must not be empty".into(),
            ));
        }
        let tool_root = canonical_directory(&config.tool_root)?;
        let manifest_path = canonical_file_inside(&config.manifest_path, &tool_root)?;
        let signature_path = canonical_file_inside(&config.detached_signature_path, &tool_root)?;
        let manifest_bytes = read_bounded(&manifest_path, MAX_MANIFEST_BYTES)?;
        let signature = read_bounded(&signature_path, MAX_SIGNATURE_BYTES)?;
        let observed_manifest_hash = ObjectHash::of_bytes(&manifest_bytes);
        if observed_manifest_hash != config.expected_manifest_sha256 {
            return Err(ColmapRuntimeError::HashMismatch {
                path: manifest_path,
                expected: config.expected_manifest_sha256.clone(),
                observed: observed_manifest_hash,
            });
        }
        verifier
            .verify_detached(&config.trusted_signer_key_id, &manifest_bytes, &signature)
            .map_err(ColmapRuntimeError::SignatureRejected)?;
        let manifest: ColmapToolManifest = serde_json::from_slice(&manifest_bytes)?;
        validate_manifest(&manifest)?;

        let executable = resolve_manifest_file(&tool_root, &manifest.executable)?;
        let executable_hash = hash_file(&executable, None)?;
        verify_file_hash(&executable, &manifest.executable.sha256, &executable_hash)?;
        let mut resources = BTreeMap::new();
        for (kind, record) in &manifest.resources {
            let path = resolve_manifest_file(&tool_root, record)?;
            let observed = hash_file(&path, None)?;
            verify_file_hash(&path, &record.sha256, &observed)?;
            resources.insert(*kind, path);
        }
        for required in [
            ColmapResourceKind::AlikedN16RotModel,
            ColmapResourceKind::AlikedN32Model,
            ColmapResourceKind::AlikedLightGlueModel,
            ColmapResourceKind::SiftLightGlueModel,
        ] {
            if !resources.contains_key(&required) {
                return Err(ColmapRuntimeError::MissingResource(required));
            }
        }

        fs::create_dir_all(&config.scratch_root)?;
        let scratch_root = canonical_directory(&config.scratch_root)?;
        let allowed_project_roots = config
            .allowed_project_roots
            .iter()
            .map(|path| canonical_directory(path))
            .collect::<Result<Vec<_>, _>>()?;
        if allowed_project_roots.is_empty() {
            return Err(ColmapRuntimeError::InvalidConfig(
                "at least one allowed project root is required".into(),
            ));
        }

        Ok(Self {
            toolchain: Arc::new(VerifiedToolchain {
                manifest,
                manifest_sha256: config.expected_manifest_sha256.clone(),
                executable,
                executable_sha256: executable_hash,
                resources,
            }),
            scratch_root,
            allowed_project_roots: Arc::new(allowed_project_roots),
        })
    }

    /// Probes a locally installed COLMAP for development only.
    ///
    /// Unlike `preflight`, this path has no release signature. The synthetic
    /// manifest is marked untrusted and must never be accepted by packaging.
    pub fn development_preflight(
        config: &DevColmapRuntimeConfig,
    ) -> Result<Self, ColmapRuntimeError> {
        if config.version.split('.').next() != Some("4") {
            return Err(ColmapRuntimeError::UnsupportedColmapVersion(
                config.version.clone(),
            ));
        }
        let executable =
            config
                .executable
                .canonicalize()
                .map_err(|error| ColmapRuntimeError::InvalidPath {
                    path: config.executable.clone(),
                    reason: error.to_string(),
                })?;
        if !executable.is_file() {
            return Err(ColmapRuntimeError::InvalidPath {
                path: executable,
                reason: "developer COLMAP executable is not a regular file".into(),
            });
        }
        let capabilities = probe_development_cli(&executable)?;
        let (resource_records, resources) = development_resources(&config.resources)?;
        fs::create_dir_all(&config.scratch_root)?;
        let scratch_root = canonical_directory(&config.scratch_root)?;
        let allowed_project_roots = canonical_roots(&config.allowed_project_roots)?;
        let executable_sha256 = hash_file(&executable, None)?;
        let manifest = ColmapToolManifest {
            schema_version: TOOL_MANIFEST_SCHEMA_VERSION,
            tool_id: "colmap-dev-untrusted".into(),
            version: config.version.clone(),
            executable: ToolFileRecord {
                relative_path: executable.clone(),
                sha256: executable_sha256.clone(),
            },
            resources: resource_records,
            capabilities,
            licenses: vec![ToolLicenseRecord {
                component: "UNTRUSTED-DEV-COLMAP".into(),
                version: config.version.clone(),
                spdx_expression: "NOASSERTION".into(),
            }],
        };
        let manifest_sha256 = ObjectHash::of_bytes(&serde_json::to_vec(&manifest)?);
        Ok(Self {
            toolchain: Arc::new(VerifiedToolchain {
                manifest,
                manifest_sha256,
                executable,
                executable_sha256,
                resources,
            }),
            scratch_root,
            allowed_project_roots: Arc::new(allowed_project_roots),
        })
    }

    /// Runs a complete typed plan in an isolated directory and returns its digest.
    pub fn run(
        &self,
        request: &ColmapRunRequest,
        context: &JobWorkerContext,
    ) -> Result<ColmapRunOutcome, ColmapRuntimeError> {
        self.run_internal(request, None, context)
    }

    /// Runs the hybrid ensemble with a validated result from the separate
    /// signed DeDoDe-v2-G worker.
    pub fn run_with_dedode(
        &self,
        request: &ColmapRunRequest,
        dedode: &DedodeRunOutcome,
        context: &JobWorkerContext,
    ) -> Result<ColmapRunOutcome, ColmapRuntimeError> {
        self.run_internal(request, Some(dedode), context)
    }

    fn run_internal(
        &self,
        request: &ColmapRunRequest,
        dedode: Option<&DedodeRunOutcome>,
        context: &JobWorkerContext,
    ) -> Result<ColmapRunOutcome, ColmapRuntimeError> {
        request.validate()?;
        let wants_dedode = matches!(
            request.large_matching_backend,
            LargeMatchingBackend::DedodeV2G { .. }
        );
        if wants_dedode != dedode.is_some() {
            return Err(ColmapRuntimeError::DedicatedLargeMatcherRequired(
                match request.large_matching_backend {
                    LargeMatchingBackend::DedodeV2G { policy } => policy,
                    LargeMatchingBackend::Disabled => DedodeV2GPolicy::Gated,
                },
            ));
        }
        self.validate_capabilities_for(request, wants_dedode)?;
        context.check_cancelled().map_err(map_worker_error)?;
        let project_root = self.validate_project_root(request)?;
        let scratch = create_scratch(&self.scratch_root, &request.job_id)?;
        let plan = request.progress_plan();
        let mut state = RunState::new(scratch, plan);
        state.configure_alignment_memory(request);
        create_workspace_directories(&state.scratch)?;
        let materialized_images = materialize_project_images(
            &project_root,
            &request.camera_images,
            &state.scratch,
            &context.cancellation,
        )?;
        let layout =
            prepare_calibration_group_layout(request, &state.scratch, &materialized_images)?;
        let materialized_images = layout.image_names.clone();
        if let Some(mask_scope) = request.image_mask_scope.as_ref() {
            let image_paths = request
                .camera_images
                .iter()
                .zip(&materialized_images)
                .map(|(camera, path)| (camera.entity_id.0.as_str(), path.as_path()))
                .collect::<BTreeMap<_, _>>();
            materialize_colmap_masks(
                &project_root,
                &mask_scope.masks,
                &image_paths,
                &state.scratch.join("masks"),
                &context.cancellation,
            )
            .map_err(|error| ColmapRuntimeError::InvalidRequest(error.to_string()))?;
        }
        write_camera_map(&state.scratch, &request.camera_images, &materialized_images)?;
        let image_directory = state.scratch.join("images");
        write_image_list(&state.scratch, &materialized_images)?;
        state.report_complete(context, "COLMAP preflight")?;

        let primary_store = if request.sift_rescue_only {
            FeatureStoreKind::from_mapping(request.mapping_store)
        } else {
            FeatureStoreKind::Aliked
        };
        self.run_feature_store(
            request,
            context,
            &image_directory,
            &materialized_images,
            primary_store,
            &mut state,
        )?;
        if !request.sift_rescue_only {
            self.run_feature_store(
                request,
                context,
                &image_directory,
                &materialized_images,
                primary_store.rescue(),
                &mut state,
            )?;
        }
        if let Some(dedode) = dedode {
            self.run_dedode_store(
                request,
                dedode,
                context,
                &image_directory,
                &materialized_images,
                &mut state,
            )?;
        }
        let (selected_mapper, selected_feature_store, mut mapping_candidates) = if wants_dedode {
            self.run_hybrid_sparse_mapping(request, context, &image_directory, &mut state)?
        } else if request.sift_rescue_only {
            match self.run_sparse_mapping(request, context, &image_directory, &mut state, false)? {
                Some((mapper, store)) => (mapper, store, Vec::new()),
                None => {
                    let rescue_store = primary_store.rescue();
                    self.run_feature_store(
                        request,
                        context,
                        &image_directory,
                        &materialized_images,
                        rescue_store,
                        &mut state,
                    )?;
                    let (mapper, store) = self.run_incremental_rescue(
                        context,
                        &image_directory,
                        rescue_store,
                        request.intrinsics_refinement,
                        &mut state,
                    )?;
                    (mapper, store, Vec::new())
                }
            }
        } else {
            let (mapper, store) = self
                .run_sparse_mapping(request, context, &image_directory, &mut state, true)?
                .ok_or_else(|| {
                    ColmapRuntimeError::InvalidWorkerOutput(
                        "all sparse reconstruction paths failed".into(),
                    )
                })?;
            (mapper, store, Vec::new())
        };
        let pinned_readjustment =
            if request.intrinsics_strategy() == ColmapIntrinsicsStrategy::Mixed {
                Some(self.restore_pinned_intrinsics(
                    request,
                    context,
                    &layout,
                    selected_mapper,
                    &mut state,
                )?)
            } else {
                None
            };
        if projected_reference_count(request) >= 3 {
            self.align_sparse_to_project_references(
                request,
                context,
                &materialized_images,
                selected_mapper,
                &mut state,
            )?;
        }
        self.export_sparse_point_cloud(context, selected_mapper, &mut state)?;
        let calibration_group_intrinsics = calibration_group_intrinsics(
            request,
            &layout,
            &state.scratch.join("sparse-view-source"),
        );
        if mapping_candidates.is_empty() {
            let statistics =
                parse_sparse_model_statistics(&state.scratch.join("sparse-view-source"))?;
            mapping_candidates.push(MappingCandidateSummary {
                feature_store: selected_feature_store,
                mapper: selected_mapper,
                registered_images: statistics.registered_images,
                points3d: statistics.points3d,
                observations: statistics.observations,
                mean_reprojection_error: statistics.mean_reprojection_error,
                selected: true,
            });
        }
        self.run_products(
            request,
            context,
            &image_directory,
            selected_mapper,
            &mut state,
        )?;
        state.report_stage(context, "Validate outputs", ProgressMetrics::empty())?;
        let artifacts = summarize_artifacts(
            request,
            &state.scratch,
            selected_mapper,
            &context.cancellation,
        )?;
        state.report_complete(context, "Validate outputs")?;

        let summary = ColmapOutputSummary {
            schema_version: OUTPUT_SUMMARY_SCHEMA_VERSION,
            job_id: request.job_id.clone(),
            tool_manifest_sha256: self.toolchain.manifest_sha256.clone(),
            executable_sha256: self.toolchain.executable_sha256.clone(),
            colmap_version: self.toolchain.manifest.version.clone(),
            camera_entity_ids: request
                .camera_images
                .iter()
                .map(|camera| camera.entity_id.0.clone())
                .collect(),
            image_mask_scope_sha256: request
                .image_mask_scope
                .as_ref()
                .map(|scope| scope.scope_sha256.clone()),
            calibration_groups: request.calibration_groups.clone(),
            intrinsics_refinement: request.intrinsics_refinement,
            intrinsics_strategy: request.intrinsics_strategy(),
            pinned_calibration_group_ids: request.pinned_calibration_group_ids.clone(),
            pinned_readjustment,
            calibration_group_intrinsics,
            selected_mapper,
            selected_feature_store,
            extraction_tiled: (!request.sift_rescue_only
                || selected_feature_store == SelectedFeatureStore::Aliked)
                .then_some(request.extraction_tiling)
                .flatten()
                .map(|tiling| ColmapExtractionTiled {
                    tiles: tiling.tiles,
                    overlap_px: tiling.overlap_px,
                }),
            dedode_tool: dedode.map(|dedode| dedode.tool.clone()),
            mapping_candidates,
            degradations: request.degradations.clone(),
            commands: state.command_reports,
            artifacts,
        };
        let summary_bytes = serde_json::to_vec_pretty(&summary)?;
        let summary_sha256 = ObjectHash::of_bytes(&summary_bytes);
        let summary_path = state.scratch.join("output-summary.json");
        atomic_write(&summary_path, &summary_bytes)?;
        Ok(ColmapRunOutcome {
            scratch_path: state.scratch,
            summary_path,
            summary_sha256,
            summary,
            sparse_potree: None,
            prepared_mesh: None,
            prepared_textured_mesh: None,
        })
    }

    /// Adapter for `JobManager::start` workers. The durable summary remains in scratch.
    pub fn run_as_job(
        &self,
        request: &ColmapRunRequest,
        context: &JobWorkerContext,
    ) -> JobWorkerResult {
        self.run(request, context)
            .map(|_| ())
            .map_err(JobWorkerError::from)
    }

    #[cfg(test)]
    fn validate_capabilities(&self, request: &ColmapRunRequest) -> Result<(), ColmapRuntimeError> {
        self.validate_capabilities_for(request, false)
    }

    fn validate_capabilities_for(
        &self,
        request: &ColmapRunRequest,
        dedode_available: bool,
    ) -> Result<(), ColmapRuntimeError> {
        if let LargeMatchingBackend::DedodeV2G { policy } = request.large_matching_backend {
            if !dedode_available {
                return Err(ColmapRuntimeError::DedicatedLargeMatcherRequired(policy));
            }
        }
        let mut required = BTreeSet::from([
            ColmapCapability::Sift,
            ColmapCapability::LightGlue,
            ColmapCapability::GeometricVerification,
            ColmapCapability::GlobalMapper,
            ColmapCapability::IncrementalMapper,
            ColmapCapability::OfflineOnlyBuild,
        ]);
        if dedode_available {
            required.extend([
                ColmapCapability::FeatureImporter,
                ColmapCapability::MatchesImporter,
                ColmapCapability::ModelConverter,
            ]);
        }
        if projected_reference_count(request) >= 3 {
            required.insert(ColmapCapability::ModelAligner);
        }
        if request.intrinsics_strategy() == ColmapIntrinsicsStrategy::Mixed {
            // Restoring pinned seeds is only honest when the poses can be re-adjusted against
            // them. Both the text round trip and the adjuster itself are required.
            required.insert(ColmapCapability::ModelConverter);
            if !self
                .toolchain
                .manifest
                .capabilities
                .contains(&ColmapCapability::BundleAdjuster)
            {
                return Err(ColmapRuntimeError::InvalidRequest(
                    "this run mixes pinned and refined calibration groups, which needs the \
                     standalone COLMAP bundle adjuster to re-optimize poses against the pinned \
                     intrinsics; the installed worker does not provide it, so set every \
                     calibration group to the same intrinsics policy or install a worker that \
                     does"
                        .into(),
                ));
            }
        }
        required.insert(match request.aliked_variant {
            AlikedModelVariant::N16Rot => ColmapCapability::AlikedN16Rot,
            AlikedModelVariant::N32 => ColmapCapability::AlikedN32,
        });
        if request.products.depth_maps {
            required.insert(ColmapCapability::PatchMatchStereo);
        }
        if request.products.dense_point_cloud {
            required.insert(ColmapCapability::StereoFusion);
        }
        if let Some(mesher) = request.products.mesh {
            required.insert(match mesher {
                ColmapMesher::Poisson => ColmapCapability::PoissonMesher,
                ColmapMesher::Delaunay => ColmapCapability::DelaunayMesher,
            });
        }
        if request.products.texture_mesh {
            required.insert(ColmapCapability::MeshTexturer);
        }
        for capability in required {
            if !self.toolchain.manifest.capabilities.contains(&capability) {
                return Err(ColmapRuntimeError::MissingCapability(capability));
            }
        }
        Ok(())
    }

    fn validate_project_root(
        &self,
        request: &ColmapRunRequest,
    ) -> Result<PathBuf, ColmapRuntimeError> {
        let directory = canonical_directory(&request.project_root)?;
        if !self
            .allowed_project_roots
            .iter()
            .any(|root| directory.starts_with(root))
        {
            return Err(ColmapRuntimeError::ProjectPathOutsideAllowedRoots(
                directory,
            ));
        }
        Ok(directory)
    }

    fn resource(&self, kind: ColmapResourceKind) -> &Path {
        self.toolchain
            .resources
            .get(&kind)
            .expect("preflight requires every runtime model")
    }
}

impl From<ColmapRuntimeError> for JobWorkerError {
    fn from(error: ColmapRuntimeError) -> Self {
        match error {
            ColmapRuntimeError::Cancelled => Self::Cancelled,
            other => Self::Failed {
                code: other.code().into(),
                message: other.to_string(),
            },
        }
    }
}

fn map_worker_error(error: JobWorkerError) -> ColmapRuntimeError {
    match error {
        JobWorkerError::Cancelled => ColmapRuntimeError::Cancelled,
        JobWorkerError::Failed { message, .. } => ColmapRuntimeError::Progress(message),
    }
}

fn map_dedode_bridge_error(error: DedodeColmapBridgeError) -> ColmapRuntimeError {
    match error {
        DedodeColmapBridgeError::Cancelled => ColmapRuntimeError::Cancelled,
        other => ColmapRuntimeError::DedodeBridge(other),
    }
}

/// Preflight, child-process and output validation failures.
#[derive(Debug, Error)]
pub enum ColmapRuntimeError {
    #[error("invalid COLMAP runtime configuration: {0}")]
    InvalidConfig(String),
    #[error("invalid COLMAP request: {0}")]
    InvalidRequest(String),
    #[error("tool manifest signature was rejected: {0}")]
    SignatureRejected(String),
    #[error("unsupported tool manifest schema {0}")]
    UnsupportedManifestSchema(u32),
    #[error("expected a COLMAP 4.x manifest, found version {0}")]
    UnsupportedColmapVersion(String),
    #[error("tool manifest has no license inventory")]
    EmptyLicenseInventory,
    #[error("forbidden or unaudited license expression for {component}: {expression}")]
    ForbiddenLicense {
        component: String,
        expression: String,
    },
    #[error("invalid path {path}: {reason}")]
    InvalidPath { path: PathBuf, reason: String },
    #[error("path escapes its trusted root: {0}")]
    PathOutsideTrustedRoot(PathBuf),
    #[error("project directory is outside configured project roots: {0}")]
    ProjectPathOutsideAllowedRoots(PathBuf),
    #[error("invalid {field} SHA-256 value: {value}")]
    InvalidHash { field: &'static str, value: String },
    #[error("SHA-256 mismatch for {path}: expected {expected:?}, observed {observed:?}")]
    HashMismatch {
        path: PathBuf,
        expected: ObjectHash,
        observed: ObjectHash,
    },
    #[error("required local model is missing from manifest: {0:?}")]
    MissingResource(ColmapResourceKind),
    #[error("curated worker does not provide required capability: {0:?}")]
    MissingCapability(ColmapCapability),
    #[error(
        "DeDoDe-v2-G policy {0:?} requires a separately signed and audited matcher worker; COLMAP 4.x cannot execute it"
    )]
    DedicatedLargeMatcherRequired(DedodeV2GPolicy),
    #[error("DeDoDe bridge failed: {0}")]
    DedodeBridge(#[from] DedodeColmapBridgeError),
    #[error("COLMAP feature database failed: {0}")]
    FeatureDatabase(#[from] ColmapFeatureDbError),
    #[error("alignment needs more memory than this machine has for matching")]
    InsufficientMatchingMemory,
    #[error("{stage}: worker exceeded its memory envelope (limit {limit_gb} GB)")]
    WorkerMemoryLimitHit {
        stage: String,
        limit_bytes: u64,
        limit_gb: u64,
        observed_peak_bytes: u64,
    },
    #[error("COLMAP command {command:?} failed with exit code {exit_code:?}: {message}")]
    CommandFailed {
        command: ColmapCommandKind,
        exit_code: Option<i32>,
        message: String,
    },
    #[error("COLMAP job cancellation was requested")]
    Cancelled,
    #[error("job progress sink rejected an update: {0}")]
    Progress(String),
    #[error("required COLMAP output is missing: {0}")]
    MissingOutput(PathBuf),
    #[error("invalid COLMAP worker output: {0}")]
    InvalidWorkerOutput(String),
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl ColmapRuntimeError {
    fn code(&self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::SignatureRejected(_) | Self::HashMismatch { .. } | Self::InvalidHash { .. } => {
                "toolTrust"
            }
            Self::MissingCapability(_)
            | Self::MissingResource(_)
            | Self::DedicatedLargeMatcherRequired(_) => "toolCapability",
            Self::InsufficientMatchingMemory => "insufficientMemory",
            Self::WorkerMemoryLimitHit { .. } => "workerMemoryLimit",
            Self::CommandFailed { .. } => "colmapCommand",
            Self::MissingOutput(_) | Self::InvalidWorkerOutput(_) | Self::FeatureDatabase(_) => {
                "invalidWorkerOutput"
            }
            Self::Progress(_) => "progressSink",
            Self::Io(_) => "io",
            Self::Json(_) => "json",
            _ => "invalidInput",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FeatureStoreKind {
    Aliked,
    Sift,
}

impl FeatureStoreKind {
    fn from_mapping(store: MappingFeatureStore) -> Self {
        match store {
            MappingFeatureStore::Aliked => Self::Aliked,
            MappingFeatureStore::Sift => Self::Sift,
        }
    }

    fn rescue(self) -> Self {
        match self {
            Self::Aliked => Self::Sift,
            Self::Sift => Self::Aliked,
        }
    }

    fn selected(self) -> SelectedFeatureStore {
        match self {
            Self::Aliked => SelectedFeatureStore::Aliked,
            Self::Sift => SelectedFeatureStore::Sift,
        }
    }

    fn database_name(self) -> &'static str {
        match self {
            Self::Aliked => "aliked",
            Self::Sift => "sift",
        }
    }

    fn database_relative_path(self) -> &'static str {
        match self {
            Self::Aliked => "features/aliked/database.db",
            Self::Sift => "features/sift/database.db",
        }
    }

    fn extraction_label(self) -> &'static str {
        match self {
            Self::Aliked => "Extract ALIKED",
            Self::Sift => "Extract SIFT",
        }
    }

    fn matching_label(self) -> &'static str {
        match self {
            Self::Aliked => "Match ALIKED with LightGlue",
            Self::Sift => "Match SIFT features",
        }
    }

    fn verification_label(self) -> &'static str {
        match self {
            Self::Aliked => "Verify ALIKED geometry",
            Self::Sift => "Verify SIFT geometry",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct CameraExtractionGroup {
    /// Immutable project group id when the partition is explicit, `None` for the metadata-derived
    /// fallback partition.
    group_id: Option<String>,
    dimensions: Option<ImageDimensions>,
    calibration: Option<ColmapCalibrationSeed>,
    image_names: Vec<PathBuf>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FeatureCacheRecord {
    schema_version: u32,
    cache_key: ObjectHash,
    database_sha256: ObjectHash,
}

#[derive(Debug)]
struct RunState {
    scratch: PathBuf,
    plan: ColmapProgressPlan,
    command_reports: Vec<ColmapCommandReport>,
    reported_progress: BTreeMap<usize, ProgressMetrics>,
    extraction_memory_limit_bytes: Option<u64>,
    matching_memory_limit_bytes: Option<u64>,
    extraction_model_bytes: Option<u64>,
    matching_model_bytes_per_thread: Option<u64>,
    matching_attempts: BTreeMap<String, Vec<serde_json::Value>>,
}

impl RunState {
    fn new(scratch: PathBuf, plan: ColmapProgressPlan) -> Self {
        Self {
            scratch,
            plan,
            command_reports: Vec::new(),
            reported_progress: BTreeMap::new(),
            extraction_memory_limit_bytes: None,
            matching_memory_limit_bytes: None,
            extraction_model_bytes: None,
            matching_model_bytes_per_thread: None,
            matching_attempts: BTreeMap::new(),
        }
    }

    fn configure_alignment_memory(&mut self, request: &ColmapRunRequest) {
        self.extraction_model_bytes = Some(
            request
                .extraction_memory_unit_bytes
                .saturating_mul(u64::from(request.feature_worker_threads.max(1))),
        );
        self.extraction_memory_limit_bytes = Some(worker_memory_limit_bytes(
            request.extraction_memory_unit_bytes,
            request.feature_worker_threads,
        ));
    }

    fn memory_limit_for(&self, kind: ColmapCommandKind) -> Option<u64> {
        match kind {
            ColmapCommandKind::FeatureExtractor | ColmapCommandKind::FeatureImporter => {
                self.extraction_memory_limit_bytes
            }
            ColmapCommandKind::ExhaustiveMatcher
            | ColmapCommandKind::SequentialMatcher
            | ColmapCommandKind::GeometricVerifier => self.matching_memory_limit_bytes,
            _ => None,
        }
    }

    fn model_bytes_for(&self, spec: &CommandSpec) -> Option<u64> {
        match spec.kind {
            ColmapCommandKind::FeatureExtractor | ColmapCommandKind::FeatureImporter => {
                self.extraction_model_bytes
            }
            ColmapCommandKind::ExhaustiveMatcher
            | ColmapCommandKind::SequentialMatcher
            | ColmapCommandKind::GeometricVerifier => self
                .matching_model_bytes_per_thread
                .map(|unit| unit.saturating_mul(u64::from(command_worker_count(spec)))),
            _ => None,
        }
    }

    fn record_matching_attempt(
        &mut self,
        stage: &str,
        threads: u16,
        peak_rss_bytes: u64,
        outcome: &'static str,
    ) -> serde_json::Value {
        let attempts = self.matching_attempts.entry(stage.into()).or_default();
        attempts.push(serde_json::json!({
            "threads": threads,
            "peakRssBytes": peak_rss_bytes,
            "outcome": outcome,
        }));
        serde_json::Value::Array(attempts.clone())
    }

    fn report_stage(
        &mut self,
        context: &JobWorkerContext,
        label: &str,
        mut metrics: ProgressMetrics,
    ) -> Result<(), ColmapRuntimeError> {
        let index = self.plan.index_of(label);
        let previous = self
            .reported_progress
            .get(&index)
            .copied()
            .unwrap_or_else(ProgressMetrics::empty);
        metrics.completed_units = metrics.completed_units.max(previous.completed_units);
        metrics.completed_bytes = metrics.completed_bytes.max(previous.completed_bytes);
        metrics.total_units = metrics
            .total_units
            .map(|total| total.max(metrics.completed_units))
            .or(previous.total_units);
        metrics.total_bytes = metrics
            .total_bytes
            .map(|total| total.max(metrics.completed_bytes))
            .or(previous.total_bytes);
        context
            .progress
            .report_blocking(self.plan.progress(index, metrics))
            .map_err(|error| ColmapRuntimeError::Progress(error.to_string()))?;
        self.reported_progress.insert(index, metrics);
        Ok(())
    }

    fn report_complete(
        &mut self,
        context: &JobWorkerContext,
        label: &str,
    ) -> Result<(), ColmapRuntimeError> {
        let previous = self
            .reported_progress
            .get(&self.plan.index_of(label))
            .copied()
            .unwrap_or_else(ProgressMetrics::empty);
        let total_units = previous
            .total_units
            .unwrap_or_else(|| previous.completed_units.max(1));
        self.report_stage(
            context,
            label,
            ProgressMetrics {
                completed_units: total_units,
                total_units: Some(total_units),
                completed_bytes: previous.completed_bytes,
                total_bytes: previous.total_bytes,
            },
        )
    }
}

#[derive(Debug)]
struct CommandSpec {
    kind: ColmapCommandKind,
    stage_label: &'static str,
    args: Vec<OsString>,
}

#[derive(Debug)]
struct ScoredMappingCandidate {
    summary: MappingCandidateSummary,
    model_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct SparseModelStatistics {
    registered_images: u64,
    points3d: u64,
    observations: u64,
    mean_reprojection_error: Option<f64>,
}

impl ColmapRuntime {
    fn run_feature_store(
        &self,
        request: &ColmapRunRequest,
        context: &JobWorkerContext,
        image_directory: &Path,
        materialized_images: &[PathBuf],
        store: FeatureStoreKind,
        state: &mut RunState,
    ) -> Result<(), ColmapRuntimeError> {
        let database = state.scratch.join(store.database_relative_path());
        let cache_root = request
            .project_root
            .join(".photolab")
            .join("cache")
            .join("colmap-features");
        let extracted_key = self.feature_cache_key(request, store, false)?;
        let verified_key = self.feature_cache_key(request, store, true)?;
        if restore_feature_cache(&cache_root, &verified_key, &database, &context.cancellation)? {
            state.report_complete(context, store.extraction_label())?;
            state.report_complete(context, store.matching_label())?;
            return state.report_complete(context, store.verification_label());
        }

        let restored_extraction = restore_feature_cache(
            &cache_root,
            &extracted_key,
            &database,
            &context.cancellation,
        )?;
        let groups = camera_extraction_groups(request, materialized_images)?;
        if !restored_extraction {
            context.check_cancelled().map_err(map_worker_error)?;
            if store == FeatureStoreKind::Aliked && request.extraction_tiling.is_some() {
                self.run_tiled_aliked_extraction(
                    request,
                    context,
                    image_directory,
                    materialized_images,
                    &groups,
                    &database,
                    state,
                )?;
            } else {
                let common_extraction = vec![
                    os("--database_path"),
                    database.as_os_str().to_owned(),
                    os("--image_path"),
                    image_directory.as_os_str().to_owned(),
                    os("--FeatureExtraction.max_image_size"),
                    os(request.max_image_size.to_string()),
                    os("--FeatureExtraction.num_threads"),
                    os(request.feature_worker_threads.to_string()),
                    os("--FeatureExtraction.use_gpu"),
                    os(request.device.use_gpu()),
                    os("--FeatureExtraction.gpu_index"),
                    os(request.device.gpu_indices()),
                ];
                let mut common_extraction = common_extraction;
                if request
                    .image_mask_scope
                    .as_ref()
                    .is_some_and(|scope| !scope.masks.is_empty())
                {
                    common_extraction.extend([
                        os("--ImageReader.mask_path"),
                        state.scratch.join("masks").as_os_str().to_owned(),
                    ]);
                }
                let extractor_options = match store {
                    FeatureStoreKind::Aliked => {
                        let (extractor_type, model_option, resource) = match request.aliked_variant
                        {
                            AlikedModelVariant::N16Rot => (
                                "ALIKED_N16ROT",
                                "--AlikedExtraction.n16rot_model_path",
                                ColmapResourceKind::AlikedN16RotModel,
                            ),
                            AlikedModelVariant::N32 => (
                                "ALIKED_N32",
                                "--AlikedExtraction.n32_model_path",
                                ColmapResourceKind::AlikedN32Model,
                            ),
                        };
                        vec![
                            os("--FeatureExtraction.type"),
                            os(extractor_type),
                            os("--AlikedExtraction.max_num_features"),
                            os(request.aliked_max_features.to_string()),
                            os(model_option),
                            self.resource(resource).as_os_str().to_owned(),
                        ]
                    }
                    FeatureStoreKind::Sift => vec![
                        os("--FeatureExtraction.type"),
                        os("SIFT"),
                        os("--SiftExtraction.max_num_features"),
                        // COLMAP may emit two orientations per detected SIFT location.
                        // Interpret the PhotoLab budget as stored features, not raw locations.
                        os(request.sift_max_features.div_ceil(2).to_string()),
                    ],
                };
                let total_units = u64::try_from(materialized_images.len()).unwrap_or(u64::MAX);
                let mut completed_units = 0_u64;
                for (group_index, group) in groups.iter().enumerate() {
                    context.check_cancelled().map_err(map_worker_error)?;
                    let image_list = state.scratch.join(format!(
                        "image-list-{}-{group_index:06}.txt",
                        store.database_name()
                    ));
                    write_image_list_path(&image_list, &group.image_names)?;
                    let mut extraction = common_extraction.clone();
                    extraction.extend([
                        os("--image_list_path"),
                        image_list.as_os_str().to_owned(),
                        os("--ImageReader.single_camera"),
                        os("1"),
                    ]);
                    if let Some(calibration) = &group.calibration {
                        let (model, parameters) = colmap_camera_model_and_params(calibration);
                        extraction.extend([
                            os("--ImageReader.camera_model"),
                            os(model),
                            os("--ImageReader.camera_params"),
                            os(parameters),
                        ]);
                    }
                    extraction.extend(extractor_options.clone());
                    let group_units = u64::try_from(group.image_names.len()).unwrap_or(u64::MAX);
                    self.execute_required_with_unit_range(
                        &CommandSpec {
                            kind: ColmapCommandKind::FeatureExtractor,
                            stage_label: store.extraction_label(),
                            args: extraction,
                        },
                        context,
                        state,
                        completed_units,
                        group_units,
                        total_units,
                    )?;
                    completed_units = completed_units.saturating_add(group_units);
                }
            }
        }
        let matching_threads = match store {
            FeatureStoreKind::Aliked => {
                let actual_max_keypoints = maximum_keypoint_count(&database)?;
                let replan = replan_alignment_matching(
                    request.memory_envelope_bytes,
                    request.logical_cpus,
                    request.aliked_max_features,
                    actual_max_keypoints,
                )
                .map_err(|_| ColmapRuntimeError::InsufficientMatchingMemory)?;
                if replan.keypoint_cap < actual_max_keypoints {
                    let capped = cap_database_features(&database, replan.keypoint_cap)?;
                    if capped.maximum_before_cap != actual_max_keypoints
                        || capped.maximum_after_cap > replan.keypoint_cap
                    {
                        return Err(ColmapRuntimeError::InvalidWorkerOutput(
                            "feature database cap did not produce the planned matcher input".into(),
                        ));
                    }
                }
                context
                    .memory
                    .record_matching_replan_blocking(
                        replan.record.clone(),
                        replan.keypoint_cap,
                        replan.degradation.clone(),
                    )
                    .map_err(|error| ColmapRuntimeError::Progress(error.to_string()))?;
                state.matching_memory_limit_bytes = Some(matching_stage_memory_limit_bytes(
                    request.memory_envelope_bytes,
                ));
                state.matching_model_bytes_per_thread = Some(replan.record.matching_unit_bytes);
                replan.record.matching_workers
            }
            FeatureStoreKind::Sift => {
                state.matching_memory_limit_bytes = Some(matching_stage_memory_limit_bytes(
                    request.memory_envelope_bytes,
                ));
                state.matching_model_bytes_per_thread = Some(SIFT_MATCHING_BYTES_PER_WORKER);
                request.matching_worker_threads
            }
        };
        if restored_extraction {
            state.report_complete(context, store.extraction_label())?;
        } else {
            // Publish only the capped database; a cache entry must never widen a later matcher.
            publish_feature_cache(
                &cache_root,
                &extracted_key,
                &database,
                &context.cancellation,
            )?;
        }

        let (matcher_kind, mut matching) = matching_command(request.pair_selection, &database);
        matching.extend([
            os("--FeatureMatching.num_threads"),
            os(matching_threads.to_string()),
            os("--FeatureMatching.use_gpu"),
            os(request.device.use_gpu()),
            os("--FeatureMatching.gpu_index"),
            os(request.device.gpu_indices()),
            os("--FeatureMatching.skip_geometric_verification"),
            os("1"),
        ]);
        match store {
            FeatureStoreKind::Aliked => matching.extend([
                os("--FeatureMatching.type"),
                os("ALIKED_LIGHTGLUE"),
                os("--AlikedMatching.lightglue_model_path"),
                self.resource(ColmapResourceKind::AlikedLightGlueModel)
                    .as_os_str()
                    .to_owned(),
            ]),
            FeatureStoreKind::Sift => matching.extend([
                os("--FeatureMatching.type"),
                os("SIFT_BRUTEFORCE"),
                os("--SiftMatching.cpu_brute_force_matcher"),
                os("1"),
            ]),
        }
        let mut matching_threads = matching_threads.max(1);
        loop {
            set_command_option(
                &mut matching,
                "--FeatureMatching.num_threads",
                matching_threads.to_string(),
            );
            let result = self.execute_required(
                &CommandSpec {
                    kind: matcher_kind,
                    stage_label: store.matching_label(),
                    args: matching.clone(),
                },
                context,
                state,
            );
            match result {
                Ok(()) => {
                    context
                        .memory
                        .record_matching_threads_blocking(store.matching_label(), matching_threads)
                        .map_err(|error| ColmapRuntimeError::Progress(error.to_string()))?;
                    break;
                }
                Err(ColmapRuntimeError::WorkerMemoryLimitHit {
                    observed_peak_bytes,
                    ..
                }) if matching_threads > 1 => {
                    context.check_cancelled().map_err(map_worker_error)?;
                    let next_threads = matching_threads.div_ceil(2);
                    context
                        .memory
                        .record_matching_threads_halved_blocking(
                            matching_threads,
                            next_threads,
                            observed_peak_bytes,
                        )
                        .map_err(|error| ColmapRuntimeError::Progress(error.to_string()))?;
                    context.check_cancelled().map_err(map_worker_error)?;
                    clear_partial_matching_output(&database)?;
                    context.check_cancelled().map_err(map_worker_error)?;
                    matching_threads = next_threads;
                }
                Err(ColmapRuntimeError::WorkerMemoryLimitHit { .. }) => {
                    return Err(ColmapRuntimeError::InsufficientMatchingMemory);
                }
                Err(error) => return Err(error),
            }
        }
        self.execute_required(
            &CommandSpec {
                kind: ColmapCommandKind::GeometricVerifier,
                stage_label: store.verification_label(),
                args: vec![
                    os("--database_path"),
                    database.as_os_str().to_owned(),
                    os("--num_threads"),
                    os(matching_threads.to_string()),
                ],
            },
            context,
            state,
        )?;
        publish_feature_cache(&cache_root, &verified_key, &database, &context.cancellation)
    }

    fn run_tiled_aliked_extraction(
        &self,
        request: &ColmapRunRequest,
        context: &JobWorkerContext,
        image_directory: &Path,
        materialized_images: &[PathBuf],
        groups: &[CameraExtractionGroup],
        database: &Path,
        state: &mut RunState,
    ) -> Result<(), ColmapRuntimeError> {
        let tiling = request
            .extraction_tiling
            .expect("tiled extraction is called only with a frozen grid");
        let total_units = u64::try_from(materialized_images.len())
            .unwrap_or(u64::MAX)
            .saturating_mul(u64::from(tiling.tiles));
        self.bootstrap_tiled_aliked_database(
            context,
            image_directory,
            materialized_images,
            groups,
            database,
            total_units,
            state,
        )?;

        let (extractor_type, model_option, resource) = match request.aliked_variant {
            AlikedModelVariant::N16Rot => (
                "ALIKED_N16ROT",
                "--AlikedExtraction.n16rot_model_path",
                ColmapResourceKind::AlikedN16RotModel,
            ),
            AlikedModelVariant::N32 => (
                "ALIKED_N32",
                "--AlikedExtraction.n32_model_path",
                ColmapResourceKind::AlikedN32Model,
            ),
        };
        let has_masks = request
            .image_mask_scope
            .as_ref()
            .is_some_and(|scope| !scope.masks.is_empty());
        let mut completed_units = 0_u64;
        let mut merged_keypoints_before_cap = 0_u32;
        let mut merged_keypoints_after_cap = 0_u32;
        for (image_index, (camera, image_name)) in request
            .camera_images
            .iter()
            .zip(materialized_images)
            .enumerate()
        {
            context.check_cancelled().map_err(map_worker_error)?;
            let source = load_resized_tiled_source(
                &image_directory.join(image_name),
                request.max_image_size,
                camera.metadata.inspected_photo.metadata.exif.orientation,
            )?;
            let mask = if has_masks {
                Some(load_resized_tiled_mask(
                    &state.scratch.join("masks"),
                    image_name,
                    source.image.width(),
                    source.image.height(),
                )?)
            } else {
                None
            };
            let bounds = tiled_image_bounds(source.image.width(), source.image.height(), tiling)?;
            let mut tile_features = Vec::with_capacity(bounds.len());
            for (tile_index, bounds) in bounds.into_iter().enumerate() {
                // Cancellation is checked at the durable boundary between every tile; an active
                // extractor remains supervised and is force-killed by the process-group runtime.
                context.check_cancelled().map_err(map_worker_error)?;
                let tile_root = state
                    .scratch
                    .join("features/aliked/tiles")
                    .join(format!("image-{image_index:08}-tile-{tile_index:06}"));
                fs::create_dir_all(&tile_root)?;
                let tile_name = PathBuf::from("tile.png");
                source
                    .image
                    .crop_imm(bounds.x, bounds.y, bounds.width, bounds.height)
                    .save_with_format(tile_root.join(&tile_name), image::ImageFormat::Png)
                    .map_err(map_tiled_image_error)?;
                let mut extraction = vec![
                    os("--database_path"),
                    tile_root.join("database.db").as_os_str().to_owned(),
                    os("--image_path"),
                    tile_root.as_os_str().to_owned(),
                    os("--FeatureExtraction.max_image_size"),
                    os(bounds.width.max(bounds.height).to_string()),
                    os("--FeatureExtraction.num_threads"),
                    os("1"),
                    os("--FeatureExtraction.use_gpu"),
                    os(request.device.use_gpu()),
                    os("--FeatureExtraction.gpu_index"),
                    os(request.device.gpu_indices()),
                    os("--image_list_path"),
                    tile_root.join("image-list.txt").as_os_str().to_owned(),
                    os("--ImageReader.single_camera"),
                    os("1"),
                    os("--FeatureExtraction.type"),
                    os(extractor_type),
                    os("--AlikedExtraction.max_num_features"),
                    // Each tile receives the complete per-image cap; only the deterministic
                    // post-merge top-k applies the requested image budget.
                    os(request.aliked_max_features.to_string()),
                    os(model_option),
                    self.resource(resource).as_os_str().to_owned(),
                ];
                write_image_list_path(&tile_root.join("image-list.txt"), &[tile_name.clone()])?;
                if let Some(mask) = &mask {
                    let mask_root = tile_root.join("masks");
                    fs::create_dir_all(&mask_root)?;
                    let tile_mask_name = PathBuf::from("tile.png.png");
                    mask.crop_imm(bounds.x, bounds.y, bounds.width, bounds.height)
                        .save_with_format(mask_root.join(tile_mask_name), image::ImageFormat::Png)
                        .map_err(map_tiled_image_error)?;
                    extraction.extend([
                        os("--ImageReader.mask_path"),
                        mask_root.as_os_str().to_owned(),
                    ]);
                }
                self.execute_required_with_unit_range(
                    &CommandSpec {
                        kind: ColmapCommandKind::FeatureExtractor,
                        stage_label: FeatureStoreKind::Aliked.extraction_label(),
                        args: extraction,
                    },
                    context,
                    state,
                    completed_units,
                    1,
                    total_units,
                )?;
                let extracted = read_image_features(&tile_root.join("database.db"), "tile.png")?;
                let feature_set = tiled_feature_set_from_database(
                    u32::try_from(tile_index).map_err(|_| {
                        ColmapRuntimeError::InvalidRequest("tile index exceeds u32".into())
                    })?,
                    bounds,
                    request.aliked_variant,
                    extracted,
                )?;
                fs::remove_dir_all(&tile_root)?;
                tile_features.push(feature_set);
                completed_units = completed_units.saturating_add(1);
            }
            let mut merged = merge_tiled_aliked_features(&tile_features, u32::MAX)
                .map_err(map_dedode_bridge_error)?;
            merged_keypoints_before_cap =
                merged_keypoints_before_cap.max(u32::try_from(merged.len()).map_err(|_| {
                    ColmapRuntimeError::InvalidWorkerOutput(
                        "merged ALIKED feature count exceeds u32".into(),
                    )
                })?);
            merged.truncate(usize::try_from(request.aliked_max_features).unwrap_or(usize::MAX));
            merged_keypoints_after_cap = merged_keypoints_after_cap
                .max(u32::try_from(merged.len()).expect("post-cap ALIKED feature count fits u32"));
            for feature in &mut merged {
                feature.x = rescale_pixel_center(feature.x, source.scale_x);
                feature.y = rescale_pixel_center(feature.y, source.scale_y);
                feature.a11 *= source.scale_x;
                feature.a12 *= source.scale_x;
                feature.a21 *= source.scale_y;
                feature.a22 *= source.scale_y;
            }
            let keypoints = ColmapKeypointMatrix::Affine(
                merged
                    .iter()
                    .map(|feature| {
                        [
                            feature.x,
                            feature.y,
                            feature.a11,
                            feature.a12,
                            feature.a21,
                            feature.a22,
                        ]
                    })
                    .collect(),
            );
            let descriptor_rows = merged
                .into_iter()
                .map(|feature| feature.descriptor)
                .collect();
            let descriptors = match request.aliked_variant {
                AlikedModelVariant::N16Rot => {
                    ColmapDescriptorMatrix::AlikedN16RotF32(descriptor_rows)
                }
                AlikedModelVariant::N32 => ColmapDescriptorMatrix::AlikedN32F32(descriptor_rows),
            };
            let image_name = path_text_for_colmap(image_name)?;
            let target = read_image_features(database, image_name)?;
            write_image_features(database, target.image_id, &keypoints, &descriptors)?;
        }
        context
            .memory
            .record_stage_peak_blocking(
                FeatureStoreKind::Aliked.extraction_label(),
                0,
                request.feature_worker_threads,
                serde_json::json!({
                    "mergedKeypointsBeforeCap": merged_keypoints_before_cap,
                    "mergedKeypointsAfterCap": merged_keypoints_after_cap,
                    "keypointCap": request.aliked_max_features,
                }),
            )
            .map_err(|error| ColmapRuntimeError::Progress(error.to_string()))?;
        state.report_complete(context, FeatureStoreKind::Aliked.extraction_label())
    }

    fn bootstrap_tiled_aliked_database(
        &self,
        context: &JobWorkerContext,
        image_directory: &Path,
        materialized_images: &[PathBuf],
        groups: &[CameraExtractionGroup],
        database: &Path,
        total_units: u64,
        state: &mut RunState,
    ) -> Result<(), ColmapRuntimeError> {
        let import_root = state.scratch.join("features/aliked/bootstrap-import");
        for image_name in materialized_images {
            context.check_cancelled().map_err(map_worker_error)?;
            let path = append_feature_text_extension(&import_root, image_name)?;
            let mut bytes = Vec::with_capacity(600);
            writeln!(&mut bytes, "1 128")?;
            write!(&mut bytes, "0.500000 0.500000 1.000000 0.000000")?;
            for _ in 0..128 {
                write!(&mut bytes, " 0")?;
            }
            bytes.push(b'\n');
            atomic_write(&path, &bytes)?;
        }
        for (group_index, group) in groups.iter().enumerate() {
            context.check_cancelled().map_err(map_worker_error)?;
            let image_list = state
                .scratch
                .join(format!("image-list-aliked-import-{group_index:06}.txt"));
            write_image_list_path(&image_list, &group.image_names)?;
            let mut args = vec![
                os("--database_path"),
                database.as_os_str().to_owned(),
                os("--image_path"),
                image_directory.as_os_str().to_owned(),
                os("--import_path"),
                import_root.as_os_str().to_owned(),
                os("--image_list_path"),
                image_list.as_os_str().to_owned(),
                os("--ImageReader.single_camera"),
                os("1"),
            ];
            if let Some(calibration) = &group.calibration {
                let (model, parameters) = colmap_camera_model_and_params(calibration);
                args.extend([
                    os("--ImageReader.camera_model"),
                    os(model),
                    os("--ImageReader.camera_params"),
                    os(parameters),
                ]);
            }
            // Import establishes authoritative camera/image rows but contributes no tile work.
            // Keep this command on the extraction stage's immutable tile-unit scale.
            self.execute_required_with_unit_range(
                &CommandSpec {
                    kind: ColmapCommandKind::FeatureImporter,
                    stage_label: FeatureStoreKind::Aliked.extraction_label(),
                    args,
                },
                context,
                state,
                0,
                0,
                total_units,
            )?;
        }
        fs::remove_dir_all(import_root)?;
        Ok(())
    }

    fn feature_cache_key(
        &self,
        request: &ColmapRunRequest,
        store: FeatureStoreKind,
        verified: bool,
    ) -> Result<ObjectHash, ColmapRuntimeError> {
        let model_hashes = match store {
            FeatureStoreKind::Aliked => vec![
                self.toolchain
                    .manifest
                    .resources
                    .get(&match request.aliked_variant {
                        AlikedModelVariant::N16Rot => ColmapResourceKind::AlikedN16RotModel,
                        AlikedModelVariant::N32 => ColmapResourceKind::AlikedN32Model,
                    })
                    .expect("preflight requires the ALIKED model")
                    .sha256
                    .clone(),
                self.toolchain
                    .manifest
                    .resources
                    .get(&ColmapResourceKind::AlikedLightGlueModel)
                    .expect("preflight requires the ALIKED LightGlue model")
                    .sha256
                    .clone(),
            ],
            FeatureStoreKind::Sift => Vec::new(),
        };
        let camera_inputs = request
            .camera_images
            .iter()
            .map(|camera| {
                (
                    &camera.entity_id,
                    &camera.metadata_object_hash,
                    &camera.metadata.source_object_hash,
                )
            })
            .collect::<Vec<_>>();
        let bytes = serde_json::to_vec(&(
            // v6 adds the exact tiled-extraction geometry; v5 added the scoped mask
            // revision, explicit calibration groups and typed FULL_OPENCV seeds.
            6_u32,
            &self.toolchain.executable_sha256,
            store.database_name(),
            model_hashes,
            camera_inputs,
            &request.calibration_groups,
            request
                .image_mask_scope
                .as_ref()
                .map(|scope| &scope.scope_sha256),
            request.aliked_variant,
            request.aliked_max_features,
            request.sift_max_features,
            request.max_image_size,
            (store == FeatureStoreKind::Aliked).then_some(request.extraction_tiling),
            verified.then_some(request.pair_selection),
        ))?;
        Ok(ObjectHash::of_bytes(&bytes))
    }

    fn run_sparse_mapping(
        &self,
        request: &ColmapRunRequest,
        context: &JobWorkerContext,
        image_directory: &Path,
        state: &mut RunState,
        allow_rescue_store: bool,
    ) -> Result<Option<(SelectedMapper, SelectedFeatureStore)>, ColmapRuntimeError> {
        let (selected_store, selected_database) = match request.mapping_store {
            MappingFeatureStore::Aliked => (
                SelectedFeatureStore::Aliked,
                state.scratch.join("features/aliked/database.db"),
            ),
            MappingFeatureStore::Sift => (
                SelectedFeatureStore::Sift,
                state.scratch.join("features/sift/database.db"),
            ),
        };
        ensure_file(&selected_database)?;
        let global_database = state.scratch.join("mapping/global.db");
        fs::copy(&selected_database, &global_database)?;
        self.execute_required(
            &CommandSpec {
                kind: ColmapCommandKind::ViewGraphCalibrator,
                stage_label: "Calibrate view graph",
                args: vec![
                    os("--database_path"),
                    global_database.as_os_str().to_owned(),
                ],
            },
            context,
            state,
        )?;
        let global_output = state.scratch.join("sparse-global");
        let report = self.execute(
            &CommandSpec {
                kind: ColmapCommandKind::GlobalMapper,
                stage_label: "Build global reconstruction",
                args: mapper_args(
                    &global_database,
                    image_directory,
                    &global_output,
                    ColmapCommandKind::GlobalMapper,
                    request.intrinsics_refinement,
                ),
            },
            context,
            state,
            None,
        )?;
        let global_succeeded = report.success && find_sparse_model(&global_output).is_some();
        state.command_reports.push(report);
        if global_succeeded {
            return Ok(Some((SelectedMapper::Global, selected_store)));
        }

        let incremental_output = state.scratch.join("sparse-incremental");
        let incremental = self.execute(
            &CommandSpec {
                kind: ColmapCommandKind::Mapper,
                stage_label: "Build incremental fallback",
                args: mapper_args(
                    &selected_database,
                    image_directory,
                    &incremental_output,
                    ColmapCommandKind::Mapper,
                    request.intrinsics_refinement,
                ),
            },
            context,
            state,
            None,
        )?;
        let selected_succeeded =
            incremental.success && find_sparse_model(&incremental_output).is_some();
        state.command_reports.push(incremental);
        if selected_succeeded {
            return Ok(Some((SelectedMapper::IncrementalFallback, selected_store)));
        }
        if !allow_rescue_store {
            return Ok(None);
        }

        let (rescue_store, rescue_database) = match request.mapping_store {
            MappingFeatureStore::Aliked => (
                SelectedFeatureStore::Sift,
                state.scratch.join("features/sift/database.db"),
            ),
            MappingFeatureStore::Sift => (
                SelectedFeatureStore::Aliked,
                state.scratch.join("features/aliked/database.db"),
            ),
        };
        ensure_file(&rescue_database)?;
        let rescue_output = state.scratch.join("sparse-rescue");
        let rescue = self.execute(
            &CommandSpec {
                kind: ColmapCommandKind::Mapper,
                stage_label: "Build incremental fallback",
                args: mapper_args(
                    &rescue_database,
                    image_directory,
                    &rescue_output,
                    ColmapCommandKind::Mapper,
                    request.intrinsics_refinement,
                ),
            },
            context,
            state,
            None,
        )?;
        let rescue_succeeded = rescue.success && find_sparse_model(&rescue_output).is_some();
        state.command_reports.push(rescue);
        if rescue_succeeded {
            let selected_root = state.scratch.join("sparse-incremental/0");
            let rescue_model = find_sparse_model(&rescue_output)
                .ok_or_else(|| ColmapRuntimeError::MissingOutput(rescue_output.clone()))?;
            copy_directory_tree(&rescue_model, &selected_root, &context.cancellation)?;
            return Ok(Some((SelectedMapper::IncrementalFallback, rescue_store)));
        }
        Err(ColmapRuntimeError::MissingOutput(rescue_output))
    }

    fn run_incremental_rescue(
        &self,
        context: &JobWorkerContext,
        image_directory: &Path,
        store: FeatureStoreKind,
        intrinsics_refinement: ColmapIntrinsicsRefinement,
        state: &mut RunState,
    ) -> Result<(SelectedMapper, SelectedFeatureStore), ColmapRuntimeError> {
        let database = state.scratch.join(store.database_relative_path());
        ensure_file(&database)?;
        let output = state.scratch.join("sparse-rescue");
        let report = self.execute(
            &CommandSpec {
                kind: ColmapCommandKind::Mapper,
                stage_label: "Retry incremental reconstruction",
                args: mapper_args(
                    &database,
                    image_directory,
                    &output,
                    ColmapCommandKind::Mapper,
                    intrinsics_refinement,
                ),
            },
            context,
            state,
            None,
        )?;
        let model = find_sparse_model(&output);
        let succeeded = report.success && model.is_some();
        state.command_reports.push(report);
        if !succeeded {
            return Err(ColmapRuntimeError::MissingOutput(output));
        }
        let selected_root = state.scratch.join("sparse-incremental/0");
        copy_directory_tree(
            &model.expect("successful rescue has a model"),
            &selected_root,
            &context.cancellation,
        )?;
        Ok((SelectedMapper::IncrementalFallback, store.selected()))
    }

    fn run_hybrid_sparse_mapping(
        &self,
        request: &ColmapRunRequest,
        context: &JobWorkerContext,
        image_directory: &Path,
        state: &mut RunState,
    ) -> Result<
        (
            SelectedMapper,
            SelectedFeatureStore,
            Vec<MappingCandidateSummary>,
        ),
        ColmapRuntimeError,
    > {
        let stores = [
            (
                SelectedFeatureStore::Aliked,
                state.scratch.join("features/aliked/database.db"),
            ),
            (
                SelectedFeatureStore::Sift,
                state.scratch.join("features/sift/database.db"),
            ),
            (
                SelectedFeatureStore::DedodeV2G,
                state.scratch.join("features/dedode/database.db"),
            ),
        ];
        let mapping_root = state.scratch.join("mapping/hybrid");
        fs::create_dir_all(&mapping_root)?;
        let mut candidate_models = Vec::new();
        for (store, database) in stores {
            ensure_file(&database)?;
            context.check_cancelled().map_err(map_worker_error)?;
            let store_name = feature_store_name(store);
            let store_root = mapping_root.join(store_name);
            fs::create_dir_all(&store_root)?;

            let global_database = store_root.join("global.db");
            fs::copy(&database, &global_database)?;
            let calibration = self.execute(
                &CommandSpec {
                    kind: ColmapCommandKind::ViewGraphCalibrator,
                    stage_label: "Build hybrid reconstructions",
                    args: vec![
                        os("--database_path"),
                        global_database.as_os_str().to_owned(),
                    ],
                },
                context,
                state,
                None,
            )?;
            let calibrated = calibration.success;
            state.command_reports.push(calibration);
            if calibrated {
                let output = store_root.join("global");
                let report = self.execute(
                    &CommandSpec {
                        kind: ColmapCommandKind::GlobalMapper,
                        stage_label: "Build hybrid reconstructions",
                        args: mapper_args(
                            &global_database,
                            image_directory,
                            &output,
                            ColmapCommandKind::GlobalMapper,
                            request.intrinsics_refinement,
                        ),
                    },
                    context,
                    state,
                    None,
                )?;
                let succeeded = report.success;
                state.command_reports.push(report);
                if succeeded {
                    if let Some(model) = find_sparse_model(&output) {
                        candidate_models.push((store, SelectedMapper::Global, model));
                    }
                }
            }

            let output = store_root.join("incremental");
            let report = self.execute(
                &CommandSpec {
                    kind: ColmapCommandKind::Mapper,
                    stage_label: "Build hybrid reconstructions",
                    args: mapper_args(
                        &database,
                        image_directory,
                        &output,
                        ColmapCommandKind::Mapper,
                        request.intrinsics_refinement,
                    ),
                },
                context,
                state,
                None,
            )?;
            let succeeded = report.success;
            state.command_reports.push(report);
            if succeeded {
                if let Some(model) = find_sparse_model(&output) {
                    candidate_models.push((store, SelectedMapper::IncrementalFallback, model));
                }
            }
        }
        if candidate_models.is_empty() {
            return Err(ColmapRuntimeError::MissingOutput(mapping_root));
        }
        let mut candidates = Vec::with_capacity(candidate_models.len());
        for (store, mapper, model) in candidate_models {
            candidates.push(self.score_mapping_candidate(store, mapper, &model, context, state)?);
        }

        let preferred_store = match request.mapping_store {
            MappingFeatureStore::Aliked => SelectedFeatureStore::Aliked,
            MappingFeatureStore::Sift => SelectedFeatureStore::Sift,
        };
        let selected_index = candidates
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| {
                compare_mapping_candidates(left, right, preferred_store)
            })
            .map(|(index, _)| index)
            .expect("non-empty candidate list has a maximum");
        candidates[selected_index].summary.selected = true;
        let selected = &candidates[selected_index];
        let selected_root = state.scratch.join("sparse-selected/0");
        copy_directory_tree(&selected.model_path, &selected_root, &context.cancellation)?;
        let mapper = selected.summary.mapper;
        let store = selected.summary.feature_store;
        let summaries = candidates
            .into_iter()
            .map(|candidate| candidate.summary)
            .collect();
        Ok((mapper, store, summaries))
    }

    fn score_mapping_candidate(
        &self,
        feature_store: SelectedFeatureStore,
        mapper: SelectedMapper,
        model_path: &Path,
        context: &JobWorkerContext,
        state: &mut RunState,
    ) -> Result<ScoredMappingCandidate, ColmapRuntimeError> {
        let analysis_path = state.scratch.join("mapping/analysis").join(format!(
            "{}-{}",
            feature_store_name(feature_store),
            mapper_name(mapper)
        ));
        fs::create_dir_all(&analysis_path)?;
        self.execute_required(
            &CommandSpec {
                kind: ColmapCommandKind::ModelConverter,
                stage_label: "Evaluate hybrid reconstructions",
                args: vec![
                    os("--input_path"),
                    model_path.as_os_str().to_owned(),
                    os("--output_path"),
                    analysis_path.as_os_str().to_owned(),
                    os("--output_type"),
                    os("TXT"),
                ],
            },
            context,
            state,
        )?;
        let statistics = parse_sparse_model_statistics(&analysis_path)?;
        Ok(ScoredMappingCandidate {
            summary: MappingCandidateSummary {
                feature_store,
                mapper,
                registered_images: statistics.registered_images,
                points3d: statistics.points3d,
                observations: statistics.observations,
                mean_reprojection_error: statistics.mean_reprojection_error,
                selected: false,
            },
            model_path: model_path.to_owned(),
        })
    }

    fn align_sparse_to_project_references(
        &self,
        request: &ColmapRunRequest,
        context: &JobWorkerContext,
        materialized_images: &[PathBuf],
        selected_mapper: SelectedMapper,
        state: &mut RunState,
    ) -> Result<(), ColmapRuntimeError> {
        let references = state.scratch.join("projected-camera-references.txt");
        write_projected_camera_references(
            &references,
            &request.camera_images,
            materialized_images,
        )?;
        let input = selected_sparse_unaligned_path(&state.scratch, selected_mapper)?;
        let output = state.scratch.join("sparse-aligned");
        fs::create_dir_all(&output)?;
        self.execute_required(
            &CommandSpec {
                kind: ColmapCommandKind::ModelAligner,
                stage_label: "Georeference with GPS/RTK",
                args: vec![
                    os("--input_path"),
                    input.as_os_str().to_owned(),
                    os("--output_path"),
                    output.as_os_str().to_owned(),
                    os("--ref_images_path"),
                    references.as_os_str().to_owned(),
                    os("--ref_is_gps"),
                    os("0"),
                    os("--alignment_type"),
                    os("custom"),
                    os("--min_common_images"),
                    os("3"),
                    os("--alignment_max_error"),
                    os("10.0"),
                    os("--transform_path"),
                    state.scratch.join("project-sim3.txt").into_os_string(),
                ],
            },
            context,
            state,
        )?;
        if !sparse_model_is_viable(&output) {
            return Err(ColmapRuntimeError::MissingOutput(output));
        }
        Ok(())
    }

    /// Restores every pinned group's intrinsics to its exact seed and re-optimizes poses only.
    ///
    /// COLMAP's mapper exposes bundle-adjustment refinement as a run-wide flag, so a run whose
    /// calibration groups disagree solves with refinement enabled and is corrected here: the
    /// solved `cameras.txt` is rewritten so the pinned groups carry their seeds again, and the
    /// standalone bundle adjuster re-optimizes poses and points against those pinned intrinsics.
    fn restore_pinned_intrinsics(
        &self,
        request: &ColmapRunRequest,
        context: &JobWorkerContext,
        layout: &CalibrationGroupLayout,
        selected_mapper: SelectedMapper,
        state: &mut RunState,
    ) -> Result<PinnedIntrinsicsReadjustment, ColmapRuntimeError> {
        let model = selected_sparse_unaligned_path(&state.scratch, selected_mapper)?;
        let pin_root = state.scratch.join("intrinsics-pin");
        let pinned = pin_root.join("pinned");
        let readjusted = pin_root.join("readjusted");
        let readjusted_text = pin_root.join("readjusted-text");
        for directory in [&pinned, &readjusted, &readjusted_text] {
            fs::create_dir_all(directory)?;
        }
        self.execute_required(
            &CommandSpec {
                kind: ColmapCommandKind::ModelConverter,
                stage_label: PINNED_INTRINSICS_STAGE,
                args: vec![
                    os("--input_path"),
                    model.as_os_str().to_owned(),
                    os("--output_path"),
                    pinned.as_os_str().to_owned(),
                    os("--output_type"),
                    os("TXT"),
                ],
            },
            context,
            state,
        )?;
        let before = parse_sparse_model_statistics(&pinned)?;
        rewrite_pinned_calibration_cameras(request, layout, &pinned)?;
        self.execute_required(
            &CommandSpec {
                kind: ColmapCommandKind::BundleAdjuster,
                stage_label: PINNED_INTRINSICS_STAGE,
                args: vec![
                    os("--input_path"),
                    pinned.as_os_str().to_owned(),
                    os("--output_path"),
                    readjusted.as_os_str().to_owned(),
                    os("--BundleAdjustment.refine_focal_length"),
                    os("0"),
                    os("--BundleAdjustment.refine_principal_point"),
                    os("0"),
                    os("--BundleAdjustment.refine_extra_params"),
                    os("0"),
                ],
            },
            context,
            state,
        )?;
        if !sparse_model_is_viable(&readjusted) {
            return Err(ColmapRuntimeError::MissingOutput(readjusted));
        }
        self.execute_required(
            &CommandSpec {
                kind: ColmapCommandKind::ModelConverter,
                stage_label: PINNED_INTRINSICS_STAGE,
                args: vec![
                    os("--input_path"),
                    readjusted.as_os_str().to_owned(),
                    os("--output_path"),
                    readjusted_text.as_os_str().to_owned(),
                    os("--output_type"),
                    os("TXT"),
                ],
            },
            context,
            state,
        )?;
        let after = parse_sparse_model_statistics(&readjusted_text)?;
        check_pinned_readjustment_consistency(before, after)?;
        // Republish the adjusted model in the mapper's own binary format so every later stage
        // reads exactly one reconstruction.
        self.execute_required(
            &CommandSpec {
                kind: ColmapCommandKind::ModelConverter,
                stage_label: PINNED_INTRINSICS_STAGE,
                args: vec![
                    os("--input_path"),
                    readjusted.as_os_str().to_owned(),
                    os("--output_path"),
                    model.as_os_str().to_owned(),
                    os("--output_type"),
                    os("BIN"),
                ],
            },
            context,
            state,
        )?;
        state.report_complete(context, PINNED_INTRINSICS_STAGE)?;
        Ok(PinnedIntrinsicsReadjustment {
            path: PinnedIntrinsicsReadjustmentPath::ColmapBundleAdjuster,
            registered_images_before: before.registered_images,
            registered_images_after: after.registered_images,
            points3d_before: before.points3d,
            points3d_after: after.points3d,
        })
    }

    fn run_products(
        &self,
        request: &ColmapRunRequest,
        context: &JobWorkerContext,
        image_directory: &Path,
        selected_mapper: SelectedMapper,
        state: &mut RunState,
    ) -> Result<(), ColmapRuntimeError> {
        if !request.products.depth_maps {
            return Ok(());
        }
        let sparse = selected_sparse_path(&state.scratch, selected_mapper)?;
        let dense = state.scratch.join("dense");
        self.execute_required(
            &CommandSpec {
                kind: ColmapCommandKind::ImageUndistorter,
                stage_label: "Undistort images",
                args: vec![
                    os("--image_path"),
                    image_directory.as_os_str().to_owned(),
                    os("--input_path"),
                    sparse.as_os_str().to_owned(),
                    os("--output_path"),
                    dense.as_os_str().to_owned(),
                    os("--output_type"),
                    os("COLMAP"),
                    os("--max_image_size"),
                    os(request.products.max_image_size.to_string()),
                ],
            },
            context,
            state,
        )?;
        self.execute_required(
            &CommandSpec {
                kind: ColmapCommandKind::PatchMatchStereo,
                stage_label: "Build PatchMatch depth maps",
                args: vec![
                    os("--workspace_path"),
                    dense.as_os_str().to_owned(),
                    os("--workspace_format"),
                    os("COLMAP"),
                    os("--PatchMatchStereo.geom_consistency"),
                    os("1"),
                    os("--PatchMatchStereo.gpu_index"),
                    os(request.device.gpu_indices()),
                ],
            },
            context,
            state,
        )?;
        if !request.products.dense_point_cloud {
            return Ok(());
        }
        let fused = dense.join("fused.ply");
        self.execute_required(
            &CommandSpec {
                kind: ColmapCommandKind::StereoFusion,
                stage_label: "Fuse depth maps",
                args: vec![
                    os("--workspace_path"),
                    dense.as_os_str().to_owned(),
                    os("--workspace_format"),
                    os("COLMAP"),
                    os("--input_type"),
                    os("geometric"),
                    os("--output_path"),
                    fused.as_os_str().to_owned(),
                ],
            },
            context,
            state,
        )?;
        let Some(mesher) = request.products.mesh else {
            return Ok(());
        };
        self.run_mesh_products(request, context, state, mesher, &dense, &fused)
    }

    fn export_sparse_point_cloud(
        &self,
        context: &JobWorkerContext,
        selected_mapper: SelectedMapper,
        state: &mut RunState,
    ) -> Result<(), ColmapRuntimeError> {
        let sparse = selected_sparse_path(&state.scratch, selected_mapper)?;
        let output = state.scratch.join("sparse-view-source");
        // COLMAP's TXT model writer requires the destination directory to
        // exist and aborts the whole process instead of returning an error
        // when it does not. Keep that precondition inside the runtime.
        fs::create_dir_all(&output)?;
        self.execute_required(
            &CommandSpec {
                kind: ColmapCommandKind::ModelConverter,
                stage_label: "Export sparse point cloud",
                args: vec![
                    os("--input_path"),
                    sparse.into_os_string(),
                    os("--output_path"),
                    output.as_os_str().to_owned(),
                    os("--output_type"),
                    os("TXT"),
                ],
            },
            context,
            state,
        )?;
        let points = output.join("points3D.txt");
        if !points.is_file() {
            return Err(ColmapRuntimeError::MissingOutput(points));
        }
        Ok(())
    }

    fn run_mesh_products(
        &self,
        request: &ColmapRunRequest,
        context: &JobWorkerContext,
        state: &mut RunState,
        mesher: ColmapMesher,
        dense: &Path,
        fused: &Path,
    ) -> Result<(), ColmapRuntimeError> {
        let mesh = dense.join(match mesher {
            ColmapMesher::Poisson => "meshed-poisson.ply",
            ColmapMesher::Delaunay => "meshed-delaunay.ply",
        });
        let mesh_spec = match mesher {
            ColmapMesher::Poisson => CommandSpec {
                kind: ColmapCommandKind::PoissonMesher,
                stage_label: "Build mesh",
                args: vec![
                    os("--input_path"),
                    fused.as_os_str().to_owned(),
                    os("--output_path"),
                    mesh.as_os_str().to_owned(),
                    os("--PoissonMeshing.depth"),
                    os(POISSON_MESHING_DEPTH.to_string()),
                    os("--PoissonMeshing.trim"),
                    os(POISSON_MESHING_TRIM.to_string()),
                ],
            },
            ColmapMesher::Delaunay => CommandSpec {
                kind: ColmapCommandKind::DelaunayMesher,
                stage_label: "Build mesh",
                args: vec![
                    os("--input_path"),
                    dense.as_os_str().to_owned(),
                    os("--output_path"),
                    mesh.as_os_str().to_owned(),
                ],
            },
        };
        self.execute_required(&mesh_spec, context, state)?;
        if request.products.texture_mesh {
            self.execute_required(
                &CommandSpec {
                    kind: ColmapCommandKind::MeshTexturer,
                    stage_label: "Texture mesh",
                    args: vec![
                        os("--workspace_path"),
                        dense.as_os_str().to_owned(),
                        os("--input_path"),
                        mesh.as_os_str().to_owned(),
                        os("--output_path"),
                        dense.join("textured").as_os_str().to_owned(),
                    ],
                },
                context,
                state,
            )?;
        }
        Ok(())
    }

    fn execute_required(
        &self,
        spec: &CommandSpec,
        context: &JobWorkerContext,
        state: &mut RunState,
    ) -> Result<(), ColmapRuntimeError> {
        let report = self.execute(spec, context, state, None)?;
        if !report.success {
            return Err(command_failure(&report));
        }
        state.command_reports.push(report);
        Ok(())
    }

    fn execute_required_with_unit_range(
        &self,
        spec: &CommandSpec,
        context: &JobWorkerContext,
        state: &mut RunState,
        completed_before: u64,
        group_units: u64,
        total_units: u64,
    ) -> Result<(), ColmapRuntimeError> {
        let report = self.execute(
            spec,
            context,
            state,
            Some((completed_before, group_units, total_units)),
        )?;
        if !report.success {
            return Err(command_failure(&report));
        }
        state.command_reports.push(report);
        state.report_stage(
            context,
            spec.stage_label,
            ProgressMetrics {
                completed_units: completed_before.saturating_add(group_units),
                total_units: Some(total_units),
                completed_bytes: 0,
                total_bytes: None,
            },
        )?;
        Ok(())
    }

    fn execute(
        &self,
        spec: &CommandSpec,
        context: &JobWorkerContext,
        state: &mut RunState,
        expected_unit_range: Option<(u64, u64, u64)>,
    ) -> Result<ColmapCommandReport, ColmapRuntimeError> {
        context.check_cancelled().map_err(map_worker_error)?;
        let initial_metrics = expected_unit_range.map_or_else(
            ProgressMetrics::empty,
            |(completed_before, _, global_total)| ProgressMetrics {
                completed_units: completed_before,
                total_units: Some(global_total),
                completed_bytes: 0,
                total_bytes: None,
            },
        );
        state.report_stage(context, spec.stage_label, initial_metrics)?;
        let stage_index = u32::try_from(state.plan.index_of(spec.stage_label))
            .expect("COLMAP stage index fits u32");
        let argv = spec
            .args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let started = Instant::now();
        let memory_limit_bytes = state.memory_limit_for(spec.kind);
        let (mut child, worker_limit_plan) =
            self.spawn_child(spec, &state.scratch, memory_limit_bytes)?;
        let mut progress_error = None;
        let supervised = supervise_child(&mut child, &context.cancellation, |completed, total| {
            if progress_error.is_none() {
                let (completed_units, total_units) = expected_unit_range.map_or(
                    (completed, Some(total)),
                    |(completed_before, group_units, global_total)| {
                        let scaled = if total == group_units {
                            completed
                        } else {
                            completed.saturating_mul(group_units) / total.max(1)
                        };
                        (
                            completed_before.saturating_add(scaled.min(group_units)),
                            Some(global_total),
                        )
                    },
                );
                progress_error = state
                    .report_stage(
                        context,
                        spec.stage_label,
                        ProgressMetrics {
                            completed_units,
                            total_units,
                            completed_bytes: 0,
                            total_bytes: None,
                        },
                    )
                    .err();
            }
        });
        let peak_rss_bytes = child.peak_rss_bytes();
        let matching_attempt_outcome =
            is_feature_matching_command(spec.kind).then(|| match supervised.as_ref() {
                Ok(outcome)
                    if worker_limit_plan.is_some_and(|plan| {
                        worker_memory_limit_error(
                            spec.stage_label,
                            plan.enforced_limit_bytes,
                            peak_rss_bytes,
                            outcome,
                        )
                        .is_some()
                    }) =>
                {
                    "workerMemoryLimit"
                }
                Ok(outcome) if outcome.status.success() => "completed",
                Ok(_) => "failed",
                Err(ColmapRuntimeError::Cancelled) => "cancelled",
                Err(_) => "failed",
            });
        let mut memory_parameters = command_memory_parameters(spec);
        if let Some(parameters) = memory_parameters.as_object_mut() {
            if let Some(model_bytes) = state.model_bytes_for(spec) {
                parameters.insert("modelBytes".into(), model_bytes.into());
            }
            if let Some(plan) = worker_limit_plan {
                parameters.insert(
                    "workerMemoryLimitBytes".into(),
                    plan.enforced_limit_bytes.into(),
                );
                parameters.insert(
                    "workerMemoryLimitMode".into(),
                    serde_json::Value::String(plan.mode.as_str().into()),
                );
            }
            if let Some(outcome) = matching_attempt_outcome {
                let threads = command_worker_count(spec).max(1);
                parameters.insert(
                    "attempts".into(),
                    state.record_matching_attempt(
                        spec.stage_label,
                        threads,
                        peak_rss_bytes,
                        outcome,
                    ),
                );
                if outcome == "completed" {
                    parameters.insert(
                        "observedBytesPerThread".into(),
                        peak_rss_bytes
                            .checked_div(u64::from(threads))
                            .unwrap_or(0)
                            .into(),
                    );
                    if let Some(model_bytes_per_thread) = state.matching_model_bytes_per_thread {
                        parameters
                            .insert("modelBytesPerThread".into(), model_bytes_per_thread.into());
                    }
                }
            }
        }
        context
            .memory
            .record_stage_peak_blocking(
                spec.stage_label,
                peak_rss_bytes,
                command_worker_count(spec),
                memory_parameters,
            )
            .map_err(|error| ColmapRuntimeError::Progress(error.to_string()))?;
        let outcome = supervised?;
        if let Some(error) = progress_error {
            return Err(error);
        }
        if let Some(plan) = worker_limit_plan {
            if let Some(error) = worker_memory_limit_error(
                spec.stage_label,
                plan.enforced_limit_bytes,
                peak_rss_bytes,
                &outcome,
            ) {
                context
                    .memory
                    .record_worker_memory_limit_hit_blocking(
                        spec.stage_label,
                        plan.enforced_limit_bytes,
                    )
                    .map_err(|error| ColmapRuntimeError::Progress(error.to_string()))?;
                return Err(error);
            }
        }
        Ok(ColmapCommandReport {
            command: spec.kind,
            stage_index,
            argv,
            success: outcome.status.success(),
            exit_code: outcome.status.code(),
            duration_ms: millis_u64(started.elapsed()),
            log_tail: outcome.log_tail,
        })
    }

    fn spawn_child(
        &self,
        spec: &CommandSpec,
        scratch: &Path,
        memory_limit_bytes: Option<u64>,
    ) -> Result<(Child, Option<WorkerMemoryLimitPlan>), ColmapRuntimeError> {
        spawn_colmap_child(
            &self.toolchain.executable,
            spec,
            scratch,
            memory_limit_bytes,
        )
    }
}

fn spawn_colmap_child(
    executable: &Path,
    spec: &CommandSpec,
    scratch: &Path,
    memory_limit_bytes: Option<u64>,
) -> Result<(Child, Option<WorkerMemoryLimitPlan>), ColmapRuntimeError> {
    let (command, worker_limit_plan) = worker_command(executable, memory_limit_bytes);
    spawn_prepared_colmap_child(command, spec, scratch, worker_limit_plan)
}

fn spawn_prepared_colmap_child(
    mut command: Command,
    spec: &CommandSpec,
    scratch: &Path,
    worker_limit_plan: Option<WorkerMemoryLimitPlan>,
) -> Result<(Child, Option<WorkerMemoryLimitPlan>), ColmapRuntimeError> {
    let home = scratch.join("home");
    let temp = scratch.join("tmp");
    let cache = scratch.join("cache");
    fs::create_dir_all(&home)?;
    fs::create_dir_all(&temp)?;
    fs::create_dir_all(&cache)?;
    command
        .arg(spec.kind.as_str())
        .args(&spec.args)
        .current_dir(scratch)
        .env_clear()
        .env("HOME", &home)
        .env("TMPDIR", &temp)
        .env("TEMP", &temp)
        .env("TMP", &temp)
        .env("XDG_CACHE_HOME", &cache)
        .env("CUDA_CACHE_PATH", cache.join("cuda"))
        .env("COLMAP_NO_NETWORK", "1")
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if matches!(
        worker_limit_plan,
        Some(WorkerMemoryLimitPlan {
            mode: WorkerMemoryLimitMode::CgroupScope,
            ..
        })
    ) {
        configure_systemd_user_bus_environment(&mut command);
    }
    let child = process_group::spawn(&mut command).map_err(ColmapRuntimeError::Io)?;
    Ok((child, worker_limit_plan))
}

fn worker_memory_limit_bytes(unit_bytes: u64, workers: u16) -> u64 {
    unit_bytes
        .saturating_mul(u64::from(workers.max(1)))
        .saturating_mul(WORKER_MEMORY_HEADROOM_NUMERATOR)
        .checked_div(WORKER_MEMORY_HEADROOM_DENOMINATOR)
        .unwrap_or(u64::MAX)
        .max(MINIMUM_WORKER_MEMORY_LIMIT_BYTES)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerMemoryLimitMode {
    CgroupScope,
    RlimitAs,
}

impl WorkerMemoryLimitMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::CgroupScope => "cgroupScope",
            Self::RlimitAs => "rlimitAs",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkerMemoryLimitPlan {
    mode: WorkerMemoryLimitMode,
    enforced_limit_bytes: u64,
}

fn worker_command(
    executable: &Path,
    memory_limit_bytes: Option<u64>,
) -> (Command, Option<WorkerMemoryLimitPlan>) {
    #[cfg(target_os = "linux")]
    if let Some(memory_limit_bytes) = memory_limit_bytes
        .filter(|_| std::env::var("HIMMELCAD_PHOTOLAB_WORKER_RLIMIT_DISABLE").as_deref() != Ok("1"))
    {
        if let Some(systemd_run) = systemd_user_scope() {
            let plan = WorkerMemoryLimitPlan {
                mode: WorkerMemoryLimitMode::CgroupScope,
                enforced_limit_bytes: memory_limit_bytes,
            };
            return (
                worker_command_for_plan(systemd_run, executable, plan),
                Some(plan),
            );
        }
        let plan = WorkerMemoryLimitPlan {
            mode: WorkerMemoryLimitMode::RlimitAs,
            enforced_limit_bytes: memory_limit_bytes.saturating_mul(WORKER_RLIMIT_AS_MULTIPLIER),
        };
        return (
            worker_command_for_plan(Path::new(PRLIMIT_PATH), executable, plan),
            Some(plan),
        );
    }
    let _ = memory_limit_bytes;
    (Command::new(executable), None)
}

#[cfg(target_os = "linux")]
fn worker_command_for_plan(
    launcher: &Path,
    executable: &Path,
    plan: WorkerMemoryLimitPlan,
) -> Command {
    match plan.mode {
        WorkerMemoryLimitMode::CgroupScope => {
            let mut command = Command::new(launcher);
            command
                .arg("--user")
                .arg("--scope")
                .arg("--quiet")
                .arg("-p")
                .arg(format!("MemoryMax={}", plan.enforced_limit_bytes))
                .arg("-p")
                .arg("MemorySwapMax=0")
                .arg("--collect")
                .arg("--")
                // A scope can enforce cgroup properties, but it cannot apply execution-context
                // properties such as LimitCORE. Apply the child-only rlimit immediately before
                // exec while the resulting process remains inside the transient scope.
                .arg(PRLIMIT_PATH)
                .arg("--core=0")
                .arg("--")
                .arg(executable);
            command
        }
        WorkerMemoryLimitMode::RlimitAs => {
            // The crate forbids unsafe code, while std's pre-exec hook is unsafe. `prlimit`
            // applies the child-only fallback immediately before `exec`; descendants inherit it.
            let mut command = Command::new(launcher);
            command
                .arg(format!("--as={}", plan.enforced_limit_bytes))
                .arg("--")
                .arg(executable);
            command
        }
    }
}

#[cfg(target_os = "linux")]
fn systemd_user_scope() -> Option<&'static Path> {
    SYSTEMD_USER_SCOPE
        .get_or_init(|| {
            let Some(executable) = find_in_path("systemd-run") else {
                tracing::info!(
                    available = false,
                    reason = "systemd-run was not found in PATH or the standard system paths",
                    "PhotoLab systemd user-scope probe completed"
                );
                return None;
            };
            let outcome = run_systemd_user_scope_probe(&executable);
            let available = outcome.as_ref().is_ok_and(|output| output.status.success());
            match outcome {
                Ok(output) => tracing::info!(
                    available,
                    status = %output.status,
                    stdout = %systemd_probe_excerpt(&output.stdout),
                    stderr = %systemd_probe_excerpt(&output.stderr),
                    "PhotoLab systemd user-scope probe completed"
                ),
                Err(ref error) => tracing::info!(
                    available,
                    reason = %error,
                    "PhotoLab systemd user-scope probe completed"
                ),
            }
            available.then_some(executable)
        })
        .as_deref()
}

#[cfg(target_os = "linux")]
fn systemd_user_scope_probe_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .arg("--user")
        .arg("--scope")
        .arg("--quiet")
        .arg("-p")
        .arg("MemoryMax=64M")
        .arg("-p")
        .arg("MemorySwapMax=0")
        .arg("--collect")
        .arg("--")
        .arg(PRLIMIT_PATH)
        .arg("--core=0")
        .arg("--")
        .arg("/bin/true");
    configure_systemd_user_bus_environment(&mut command);
    command
}

#[cfg(target_os = "linux")]
fn run_systemd_user_scope_probe(executable: &Path) -> io::Result<std::process::Output> {
    systemd_user_scope_probe_command(executable)
        .stdin(Stdio::null())
        .output()
}

#[cfg(target_os = "linux")]
fn systemd_probe_excerpt(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim()
        .chars()
        .take(SYSTEMD_SCOPE_PROBE_DIAGNOSTIC_MAX_CHARS)
        .collect()
}

#[cfg(target_os = "linux")]
fn configure_systemd_user_bus_environment(command: &mut Command) {
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .or_else(systemd_user_runtime_dir);
    // The worker command starts from `env_clear()`, so the bus variables must be set
    // explicitly even when the sidecar itself inherited them (A7g follow-up: the
    // scope failed with "Failed to connect to bus: No medium found" inside units).
    if let Some(runtime_dir) = runtime_dir.as_ref() {
        command.env("XDG_RUNTIME_DIR", runtime_dir);
    }
    if let Some(bus) = std::env::var_os("DBUS_SESSION_BUS_ADDRESS") {
        command.env("DBUS_SESSION_BUS_ADDRESS", bus);
    } else if let Some(bus) = runtime_dir
        .as_ref()
        .map(|runtime_dir| runtime_dir.join("bus"))
        .filter(|bus| bus.exists())
    {
        command.env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}", bus.display()),
        );
    }
}

#[cfg(target_os = "linux")]
fn systemd_user_runtime_dir() -> Option<PathBuf> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let uid = effective_uid_from_proc_status(&status)?;
    let runtime_dir = Path::new("/run/user").join(uid.to_string());
    runtime_dir.is_dir().then_some(runtime_dir)
}

#[cfg(target_os = "linux")]
fn effective_uid_from_proc_status(status: &str) -> Option<u32> {
    status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// Runs the process-cached worker-scope probe so an integration harness can capture its one log
/// line without starting COLMAP.
#[cfg(target_os = "linux")]
pub fn probe_worker_scope_for_diagnostics() -> bool {
    systemd_user_scope().is_some()
}

#[cfg(not(target_os = "linux"))]
pub const fn probe_worker_scope_for_diagnostics() -> bool {
    false
}

#[cfg(target_os = "linux")]
fn find_in_path(executable: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|directory| directory.join(executable))
        .find(|candidate| candidate.is_file())
        .or_else(|| {
            ["/usr/bin", "/bin"]
                .into_iter()
                .map(|directory| Path::new(directory).join(executable))
                .find(|candidate| candidate.is_file())
        })
}

fn outcome_indicates_memory_limit(outcome: &ProcessOutcome) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if matches!(outcome.status.signal(), Some(6 | 9 | 11)) {
            return true;
        }
    }
    outcome.log_tail.iter().any(|line| {
        let lower = line.to_ascii_lowercase();
        if lower.trim() == "killed" || lower.trim_end().ends_with(": killed") {
            return true;
        }
        [
            "cannot allocate memory",
            "failed to map segment",
            "memory allocation",
            "std::bad_alloc",
            "out of memory",
            "oom-kill",
            "code=killed",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
    })
}

fn worker_memory_limit_error(
    stage: &str,
    limit_bytes: u64,
    observed_peak_bytes: u64,
    outcome: &ProcessOutcome,
) -> Option<ColmapRuntimeError> {
    (!outcome.status.success() && outcome_indicates_memory_limit(outcome)).then(|| {
        ColmapRuntimeError::WorkerMemoryLimitHit {
            stage: stage.into(),
            limit_bytes,
            limit_gb: limit_bytes.div_ceil(GIB),
            observed_peak_bytes,
        }
    })
}

fn is_feature_matching_command(kind: ColmapCommandKind) -> bool {
    matches!(
        kind,
        ColmapCommandKind::ExhaustiveMatcher | ColmapCommandKind::SequentialMatcher
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TileBounds {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

struct ResizedTiledSource {
    image: image::DynamicImage,
    scale_x: f32,
    scale_y: f32,
}

fn tiled_image_bounds(
    width: u32,
    height: u32,
    tiling: AlignmentExtractionTiling,
) -> Result<Vec<TileBounds>, ColmapRuntimeError> {
    let x_bounds = tiled_axis_bounds(width, tiling.columns, tiling.overlap_px)?;
    let y_bounds = tiled_axis_bounds(height, tiling.rows, tiling.overlap_px)?;
    let mut bounds = Vec::with_capacity(
        usize::try_from(tiling.tiles)
            .map_err(|_| ColmapRuntimeError::InvalidRequest("tile count exceeds usize".into()))?,
    );
    for &(y, tile_height) in &y_bounds {
        for &(x, tile_width) in &x_bounds {
            bounds.push(TileBounds {
                x,
                y,
                width: tile_width,
                height: tile_height,
            });
        }
    }
    if bounds.len() != usize::try_from(tiling.tiles).unwrap_or(usize::MAX) {
        return Err(ColmapRuntimeError::InvalidRequest(
            "tile grid shape differs from its frozen tile count".into(),
        ));
    }
    Ok(bounds)
}

fn tiled_axis_bounds(
    length: u32,
    count: u32,
    overlap: u32,
) -> Result<Vec<(u32, u32)>, ColmapRuntimeError> {
    if length == 0 || count == 0 || (count > 1 && overlap >= length) {
        return Err(ColmapRuntimeError::InvalidRequest(
            "tile grid does not fit the resized image dimensions".into(),
        ));
    }
    if count == 1 {
        return Ok(vec![(0, length)]);
    }
    let covered =
        u64::from(length).saturating_add(u64::from(count - 1).saturating_mul(u64::from(overlap)));
    let extent = u32::try_from(covered.div_ceil(u64::from(count)))
        .map_err(|_| ColmapRuntimeError::InvalidRequest("tile extent exceeds u32".into()))?;
    if extent <= overlap || extent > length {
        return Err(ColmapRuntimeError::InvalidRequest(
            "tile overlap leaves no positive interior step".into(),
        ));
    }
    let step = extent - overlap;
    Ok((0..count)
        .map(|index| {
            let nominal = index.saturating_mul(step);
            let origin = nominal.min(length - extent);
            (origin, extent.min(length - origin))
        })
        .collect())
}

fn load_resized_tiled_source(
    path: &Path,
    max_image_size: u32,
    orientation: Option<ExifOrientation>,
) -> Result<ResizedTiledSource, ColmapRuntimeError> {
    let source = image::open(path).map_err(map_tiled_image_error)?;
    let source = match orientation.unwrap_or(ExifOrientation::Normal) {
        ExifOrientation::Normal => source,
        ExifOrientation::Rotate90Clockwise => source.rotate90(),
        ExifOrientation::Rotate180 => source.rotate180(),
        ExifOrientation::Rotate270Clockwise => source.rotate270(),
        ExifOrientation::MirrorHorizontal => source.fliph(),
        ExifOrientation::MirrorVertical => source.flipv(),
        ExifOrientation::MirrorHorizontalRotate270Clockwise => source.fliph().rotate270(),
        ExifOrientation::MirrorHorizontalRotate90Clockwise => source.fliph().rotate90(),
    };
    let source_width = source.width();
    let source_height = source.height();
    let image = resize_for_aliked(source, max_image_size)?;
    Ok(ResizedTiledSource {
        scale_x: source_width as f32 / image.width() as f32,
        scale_y: source_height as f32 / image.height() as f32,
        image,
    })
}

fn rescale_pixel_center(coordinate: f32, scale: f32) -> f32 {
    (coordinate - 0.5).mul_add(scale, 0.5)
}

fn resize_for_aliked(
    source: image::DynamicImage,
    max_image_size: u32,
) -> Result<image::DynamicImage, ColmapRuntimeError> {
    let width = source.width();
    let height = source.height();
    let longest = width.max(height);
    if width == 0 || height == 0 || max_image_size == 0 {
        return Err(ColmapRuntimeError::InvalidWorkerOutput(
            "tiled ALIKED source has zero dimensions".into(),
        ));
    }
    if longest <= max_image_size {
        return Ok(source);
    }
    let resized_width = u32::try_from(
        u64::from(width).saturating_mul(u64::from(max_image_size)) / u64::from(longest),
    )
    .unwrap_or(u32::MAX)
    .max(1);
    let resized_height = u32::try_from(
        u64::from(height).saturating_mul(u64::from(max_image_size)) / u64::from(longest),
    )
    .unwrap_or(u32::MAX)
    .max(1);
    Ok(source.resize_exact(
        resized_width,
        resized_height,
        image::imageops::FilterType::Lanczos3,
    ))
}

fn load_resized_tiled_mask(
    mask_root: &Path,
    image_name: &Path,
    width: u32,
    height: u32,
) -> Result<image::DynamicImage, ColmapRuntimeError> {
    let text = path_text_for_colmap(image_name)?;
    let path = mask_root.join(format!("{text}.png"));
    let mask = image::open(&path).map_err(|error| {
        ColmapRuntimeError::InvalidWorkerOutput(format!(
            "failed to read tiled ALIKED mask {}: {error}",
            path.display()
        ))
    })?;
    Ok(mask.resize_exact(width, height, image::imageops::FilterType::Nearest))
}

fn tiled_feature_set_from_database(
    tile_index: u32,
    bounds: TileBounds,
    variant: AlikedModelVariant,
    extracted: crate::colmap_feature_db::ColmapImageFeatures,
) -> Result<TiledAlikedFeatureSet, ColmapRuntimeError> {
    let affine = match extracted.keypoints {
        ColmapKeypointMatrix::Affine(rows) => rows,
        ColmapKeypointMatrix::Similarity(rows) => rows
            .into_iter()
            .map(|[x, y, scale, orientation]| {
                let cosine = orientation.cos() * scale;
                let sine = orientation.sin() * scale;
                [x, y, cosine, -sine, sine, cosine]
            })
            .collect(),
        ColmapKeypointMatrix::Coordinates(rows) => rows
            .into_iter()
            .map(|[x, y]| [x, y, 1.0, 0.0, 0.0, 1.0])
            .collect(),
    };
    let descriptors = match (variant, extracted.descriptors) {
        (AlikedModelVariant::N16Rot, ColmapDescriptorMatrix::AlikedN16RotF32(rows))
        | (AlikedModelVariant::N32, ColmapDescriptorMatrix::AlikedN32F32(rows)) => rows,
        (_, ColmapDescriptorMatrix::SiftU8(_)) => {
            return Err(ColmapRuntimeError::InvalidWorkerOutput(
                "tiled ALIKED extractor wrote uint8 descriptors".into(),
            ));
        }
        _ => {
            return Err(ColmapRuntimeError::InvalidWorkerOutput(
                "tiled ALIKED extractor wrote the wrong feature type".into(),
            ));
        }
    };
    let feature_count = affine.len();
    let features = affine
        .into_iter()
        .zip(descriptors)
        .enumerate()
        .map(|(index, (keypoint, descriptor))| TiledAlikedFeature {
            x: keypoint[0],
            y: keypoint[1],
            a11: keypoint[2],
            a12: keypoint[3],
            a21: keypoint[4],
            a22: keypoint[5],
            // COLMAP filters by the ALIKED score but persists no score column. For a frozen
            // model and input its CPU extractor deterministically writes rows in descending
            // detector-score order, so normalized reverse row rank is the only stable score
            // proxy that remains comparable across tiles of different feature counts.
            score: feature_count.saturating_sub(index) as f32 / feature_count.max(1) as f32,
            descriptor,
        })
        .collect();
    Ok(TiledAlikedFeatureSet {
        tile_index,
        origin_x: bounds.x,
        origin_y: bounds.y,
        features,
    })
}

fn append_feature_text_extension(
    root: &Path,
    image_name: &Path,
) -> Result<PathBuf, ColmapRuntimeError> {
    Ok(root.join(format!("{}.txt", path_text_for_colmap(image_name)?)))
}

fn path_text_for_colmap(path: &Path) -> Result<&str, ColmapRuntimeError> {
    path.to_str()
        .ok_or_else(|| ColmapRuntimeError::InvalidPath {
            path: path.to_path_buf(),
            reason: "COLMAP image name is not UTF-8".into(),
        })
}

fn map_tiled_image_error(error: image::ImageError) -> ColmapRuntimeError {
    ColmapRuntimeError::InvalidWorkerOutput(format!("tiled ALIKED image operation failed: {error}"))
}

fn camera_dji_calibration(
    camera: &ProjectCameraImageRecord,
) -> Option<(ImageDimensions, ColmapCalibrationSeed)> {
    let metadata = &camera.metadata.inspected_photo.metadata;
    let dimensions = metadata.exif.dimensions?;
    if metadata
        .exif
        .orientation
        .is_some_and(|orientation| orientation != ExifOrientation::Normal)
    {
        return None;
    }
    let xmp = &metadata.dji_xmp;
    let calibration = if let Some(full) = xmp
        .dewarp_calibration
        .as_ref()
        .filter(|calibration| calibration.is_valid_for_dimensions(dimensions))
    {
        ColmapCalibrationSeed {
            width_pixels: dimensions.width_pixels,
            height_pixels: dimensions.height_pixels,
            focal_pixels: full.focal_x_pixels,
            principal_x_pixels: full.principal_x_pixels,
            principal_y_pixels: full.principal_y_pixels,
            full_brown_calibration: Some(full.clone()),
        }
    } else {
        ColmapCalibrationSeed {
            width_pixels: dimensions.width_pixels,
            height_pixels: dimensions.height_pixels,
            focal_pixels: xmp.calibrated_focal_length_pixels?,
            principal_x_pixels: xmp.calibrated_optical_center_x_pixels?,
            principal_y_pixels: xmp.calibrated_optical_center_y_pixels?,
            full_brown_calibration: None,
        }
    };
    valid_calibration_seed(&calibration)?;
    Some((dimensions, calibration))
}

fn calibrations_match(left: &ColmapCalibrationSeed, right: &ColmapCalibrationSeed) -> bool {
    left.width_pixels == right.width_pixels
        && left.height_pixels == right.height_pixels
        && (left.focal_pixels - right.focal_pixels).abs() <= 0.01
        && (left.principal_x_pixels - right.principal_x_pixels).abs() <= 0.01
        && (left.principal_y_pixels - right.principal_y_pixels).abs() <= 0.01
        && left.full_brown_calibration == right.full_brown_calibration
}

#[cfg(test)]
fn shared_group_calibration(groups: &[CameraExtractionGroup]) -> Option<&ColmapCalibrationSeed> {
    let first = groups.first()?;
    let dimensions = first.dimensions?;
    let calibration = first.calibration.as_ref()?;
    groups
        .iter()
        .all(|group| {
            group.dimensions == Some(dimensions)
                && group
                    .calibration
                    .as_ref()
                    .is_some_and(|candidate| calibrations_match(candidate, calibration))
        })
        .then_some(calibration)
}

/// Materializes a validated project calibration seed into COLMAP's camera model and parameter
/// order. Kept public so project-domain tests can verify the complete seed hand-off.
pub fn colmap_camera_model_and_params(
    calibration: &ColmapCalibrationSeed,
) -> (&'static str, String) {
    if let Some(full) = &calibration.full_brown_calibration {
        // COLMAP FULL_OPENCV order:
        // fx, fy, cx, cy, k1, k2, p1, p2, k3, k4, k5, k6.
        return (
            "FULL_OPENCV",
            format!(
                "{:.12},{:.12},{:.12},{:.12},{:.12},{:.12},{:.12},{:.12},{:.12},0,0,0",
                full.focal_x_pixels,
                full.focal_y_pixels,
                full.principal_x_pixels,
                full.principal_y_pixels,
                full.radial_distortion[0],
                full.radial_distortion[1],
                full.tangential_distortion[0],
                full.tangential_distortion[1],
                full.radial_distortion[2],
            ),
        );
    }
    (
        "SIMPLE_RADIAL",
        format!(
            "{:.12},{:.12},{:.12},0",
            calibration.focal_pixels,
            calibration.principal_x_pixels,
            calibration.principal_y_pixels
        ),
    )
}

/// Materialized image names plus the calibration directory each COLMAP camera came from.
#[derive(Debug, Clone, PartialEq)]
struct CalibrationGroupLayout {
    /// One grouped image name per request camera, in request order.
    image_names: Vec<PathBuf>,
    /// `calibration-NNNNNN` directory name mapped to its explicit project group id.
    group_id_by_directory: BTreeMap<String, String>,
}

fn prepare_calibration_group_layout(
    request: &ColmapRunRequest,
    scratch: &Path,
    materialized_images: &[PathBuf],
) -> Result<CalibrationGroupLayout, ColmapRuntimeError> {
    let mut groups = camera_extraction_groups(request, materialized_images)?;
    let source_index = materialized_images
        .iter()
        .enumerate()
        .map(|(index, path)| (path, index))
        .collect::<BTreeMap<_, _>>();
    // COLMAP's sequential matcher follows database/image-name order. Keep calibration folders
    // ordered by their first source image so immutable group IDs cannot scramble a flight line.
    groups.sort_by_key(|group| {
        group
            .image_names
            .iter()
            .filter_map(|name| source_index.get(name).copied())
            .min()
            .unwrap_or(usize::MAX)
    });
    let mut grouped_by_source = BTreeMap::new();
    let mut group_id_by_directory = BTreeMap::new();
    for (group_index, group) in groups.iter().enumerate() {
        let group_directory = format!("calibration-{group_index:06}");
        if let Some(group_id) = group.group_id.as_ref() {
            group_id_by_directory.insert(group_directory.clone(), group_id.clone());
        }
        for source_name in &group.image_names {
            let image_index = source_index.get(source_name).copied().ok_or_else(|| {
                ColmapRuntimeError::InvalidRequest(
                    "calibration layout references an unknown materialized image".into(),
                )
            })?;
            let extension = source_name
                .extension()
                .and_then(|value| value.to_str())
                .ok_or_else(|| ColmapRuntimeError::InvalidPath {
                    path: source_name.clone(),
                    reason: "materialized image extension is not UTF-8".into(),
                })?;
            let grouped_name =
                PathBuf::from(&group_directory).join(format!("image-{image_index:08}.{extension}"));
            let source = scratch.join("images").join(source_name);
            let destination = scratch.join("images").join(&grouped_name);
            fs::create_dir_all(
                destination
                    .parent()
                    .expect("grouped image always has a parent"),
            )?;
            if fs::hard_link(&source, &destination).is_err() {
                fs::copy(&source, &destination)?;
            }
            grouped_by_source.insert(source_name.clone(), grouped_name);
        }
    }
    let image_names = materialized_images
        .iter()
        .map(|source| {
            grouped_by_source.get(source).cloned().ok_or_else(|| {
                ColmapRuntimeError::InvalidRequest(
                    "calibration groups do not cover every materialized image".into(),
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CalibrationGroupLayout {
        image_names,
        group_id_by_directory,
    })
}

fn camera_extraction_groups(
    request: &ColmapRunRequest,
    materialized_images: &[PathBuf],
) -> Result<Vec<CameraExtractionGroup>, ColmapRuntimeError> {
    if request.camera_images.len() != materialized_images.len() {
        return Err(ColmapRuntimeError::InvalidRequest(
            "camera and materialized image counts differ".into(),
        ));
    }
    if !request.calibration_groups.is_empty() {
        let materialized_by_id = request
            .camera_images
            .iter()
            .zip(materialized_images)
            .map(|(camera, image)| (camera.entity_id.0.as_str(), image))
            .collect::<BTreeMap<_, _>>();
        let mut groups = Vec::with_capacity(request.calibration_groups.len());
        for definition in &request.calibration_groups {
            let image_names = definition
                .camera_entity_ids
                .iter()
                .map(|id| {
                    materialized_by_id
                        .get(id.as_str())
                        .cloned()
                        .cloned()
                        .ok_or_else(|| {
                            ColmapRuntimeError::InvalidRequest(format!(
                                "calibration group {} references an image outside the run",
                                definition.group_id
                            ))
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let (dimensions, calibration) = definition.seed.as_ref().map_or((None, None), |seed| {
                (
                    Some(ImageDimensions {
                        width_pixels: seed.width_pixels,
                        height_pixels: seed.height_pixels,
                    }),
                    Some(seed.clone()),
                )
            });
            groups.push(CameraExtractionGroup {
                group_id: Some(definition.group_id.clone()),
                dimensions,
                calibration,
                image_names,
            });
        }
        return Ok(groups);
    }

    let mut calibrated_groups = Vec::<CameraExtractionGroup>::new();
    let mut fallback_images = Vec::new();
    for (camera, image_name) in request.camera_images.iter().zip(materialized_images) {
        let Some((dimensions, calibration)) = camera_dji_calibration(camera) else {
            fallback_images.push(image_name.clone());
            continue;
        };
        if let Some(group) = calibrated_groups.iter_mut().find(|group| {
            group.dimensions == Some(dimensions)
                && group
                    .calibration
                    .as_ref()
                    .is_some_and(|existing| calibrations_match(existing, &calibration))
        }) {
            group.image_names.push(image_name.clone());
        } else {
            calibrated_groups.push(CameraExtractionGroup {
                group_id: None,
                dimensions: Some(dimensions),
                calibration: Some(calibration),
                image_names: vec![image_name.clone()],
            });
        }
    }
    if !fallback_images.is_empty() {
        calibrated_groups.push(CameraExtractionGroup {
            group_id: None,
            dimensions: None,
            calibration: None,
            image_names: fallback_images,
        });
    }
    if calibrated_groups.is_empty() {
        return Err(ColmapRuntimeError::InvalidRequest(
            "feature extraction requires at least one image".into(),
        ));
    }
    Ok(calibrated_groups)
}

fn validate_explicit_calibration_groups(
    request: &ColmapRunRequest,
) -> Result<(), ColmapRuntimeError> {
    if request.calibration_groups.is_empty() {
        return Ok(());
    }
    let camera_ids = request
        .camera_images
        .iter()
        .map(|camera| camera.entity_id.0.as_str())
        .collect::<BTreeSet<_>>();
    let mut assigned = BTreeSet::new();
    let mut group_ids = BTreeSet::new();
    for group in &request.calibration_groups {
        if group.group_id.trim().is_empty() || !group_ids.insert(group.group_id.as_str()) {
            return Err(ColmapRuntimeError::InvalidRequest(
                "calibration group ids must be non-empty and unique".into(),
            ));
        }
        if group.camera_entity_ids.is_empty() {
            return Err(ColmapRuntimeError::InvalidRequest(format!(
                "calibration group {} is empty",
                group.group_id
            )));
        }
        for id in &group.camera_entity_ids {
            if !camera_ids.contains(id.as_str()) || !assigned.insert(id.as_str()) {
                return Err(ColmapRuntimeError::InvalidRequest(format!(
                    "calibration group {} is not an exact camera partition",
                    group.group_id
                )));
            }
        }
        if let Some(seed) = group.seed.as_ref() {
            if valid_calibration_seed(seed).is_none() {
                return Err(ColmapRuntimeError::InvalidRequest(format!(
                    "calibration group {} has an invalid seed",
                    group.group_id
                )));
            }
        }
    }
    if assigned != camera_ids {
        return Err(ColmapRuntimeError::InvalidRequest(
            "explicit calibration groups must partition every run camera exactly".into(),
        ));
    }
    Ok(())
}

/// One parsed `cameras.txt` record.
#[derive(Debug, Clone, PartialEq)]
struct ParsedColmapCamera {
    camera_id: String,
    model: String,
    width_pixels: u32,
    height_pixels: u32,
    parameters: Vec<f64>,
}

fn parse_colmap_cameras_text(path: &Path) -> Result<Vec<ParsedColmapCamera>, ColmapRuntimeError> {
    let contents = fs::read_to_string(path)?;
    let mut cameras = Vec::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns.len() < 5 {
            return Err(ColmapRuntimeError::InvalidWorkerOutput(
                "invalid cameras.txt camera record".into(),
            ));
        }
        let width_pixels = columns[2].parse::<u32>().map_err(|_| {
            ColmapRuntimeError::InvalidWorkerOutput("invalid cameras.txt image width".into())
        })?;
        let height_pixels = columns[3].parse::<u32>().map_err(|_| {
            ColmapRuntimeError::InvalidWorkerOutput("invalid cameras.txt image height".into())
        })?;
        let parameters = columns[4..]
            .iter()
            .map(|value| {
                value.parse::<f64>().map_err(|_| {
                    ColmapRuntimeError::InvalidWorkerOutput(
                        "invalid cameras.txt camera parameter".into(),
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        cameras.push(ParsedColmapCamera {
            camera_id: columns[0].to_owned(),
            model: columns[1].to_owned(),
            width_pixels,
            height_pixels,
            parameters,
        });
    }
    Ok(cameras)
}

/// Maps the `calibration-NNNNNN` directory of every registered image to its COLMAP camera id.
fn colmap_camera_ids_by_calibration_directory(
    images_path: &Path,
) -> Result<BTreeMap<String, String>, ColmapRuntimeError> {
    Ok(colmap_camera_ids_by_image_name(images_path)?
        .into_iter()
        .filter_map(|(image_name, camera_id)| {
            let directory = image_name.parent()?.to_str()?.to_owned();
            (!directory.is_empty()).then_some((directory, camera_id))
        })
        .collect())
}

/// Resolves each explicit calibration group to the COLMAP camera id that carries its intrinsics.
fn colmap_camera_ids_by_calibration_group(
    layout: &CalibrationGroupLayout,
    text_model: &Path,
) -> Result<BTreeMap<String, String>, ColmapRuntimeError> {
    let by_directory = colmap_camera_ids_by_calibration_directory(&text_model.join("images.txt"))?;
    Ok(layout
        .group_id_by_directory
        .iter()
        .filter_map(|(directory, group_id)| {
            by_directory
                .get(directory)
                .map(|camera_id| (group_id.clone(), camera_id.clone()))
        })
        .collect())
}

/// Rewrites the solved `cameras.txt` so every pinned group carries its exact seed again.
fn rewrite_pinned_calibration_cameras(
    request: &ColmapRunRequest,
    layout: &CalibrationGroupLayout,
    text_model: &Path,
) -> Result<(), ColmapRuntimeError> {
    let camera_ids = colmap_camera_ids_by_calibration_group(layout, text_model)?;
    let mut pinned_lines = BTreeMap::new();
    for group_id in &request.pinned_calibration_group_ids {
        let camera_id = camera_ids.get(group_id).ok_or_else(|| {
            ColmapRuntimeError::InvalidWorkerOutput(format!(
                "the solved model has no camera for pinned calibration group {group_id}"
            ))
        })?;
        let seed = request
            .calibration_groups
            .iter()
            .find(|group| &group.group_id == group_id)
            .and_then(|group| group.seed.as_ref())
            .ok_or_else(|| {
                ColmapRuntimeError::InvalidRequest(format!(
                    "pinned calibration group {group_id} has no calibration to restore"
                ))
            })?;
        let (model, parameters) = colmap_camera_model_and_params(seed);
        pinned_lines.insert(
            camera_id.clone(),
            format!(
                "{camera_id} {model} {} {} {}",
                seed.width_pixels,
                seed.height_pixels,
                parameters.replace(',', " ")
            ),
        );
    }
    let cameras_path = text_model.join("cameras.txt");
    let contents = fs::read_to_string(&cameras_path)?;
    let mut rewritten = String::with_capacity(contents.len());
    let mut restored = BTreeSet::new();
    for line in contents.lines() {
        let trimmed = line.trim();
        let camera_id = (!trimmed.is_empty() && !trimmed.starts_with('#'))
            .then(|| trimmed.split_whitespace().next())
            .flatten();
        match camera_id.and_then(|camera_id| pinned_lines.get(camera_id)) {
            Some(replacement) => {
                restored.insert(
                    camera_id
                        .expect("a matched replacement always has a camera id")
                        .to_owned(),
                );
                rewritten.push_str(replacement);
            }
            None => rewritten.push_str(line),
        }
        rewritten.push('\n');
    }
    if restored.len() != pinned_lines.len() {
        return Err(ColmapRuntimeError::InvalidWorkerOutput(
            "the solved cameras.txt does not contain every pinned calibration group".into(),
        ));
    }
    atomic_write(&cameras_path, rewritten.as_bytes())
}

/// Fails a mixed-policy run whose pose-only re-adjustment collapsed the reconstruction.
fn check_pinned_readjustment_consistency(
    before: SparseModelStatistics,
    after: SparseModelStatistics,
) -> Result<(), ColmapRuntimeError> {
    let image_floor =
        (before.registered_images as f64 * MIN_PINNED_READJUSTMENT_IMAGE_RETENTION).ceil();
    if (after.registered_images as f64) < image_floor {
        return Err(ColmapRuntimeError::InvalidWorkerOutput(format!(
            "restoring the pinned calibration dropped registered images from {} to {}; the pinned \
             calibration does not explain this block, so review the affected calibration group's \
             intrinsics policy before publishing",
            before.registered_images, after.registered_images
        )));
    }
    let point_floor = (before.points3d as f64 * MIN_PINNED_READJUSTMENT_POINT_RETENTION).ceil();
    if (after.points3d as f64) < point_floor {
        return Err(ColmapRuntimeError::InvalidWorkerOutput(format!(
            "restoring the pinned calibration dropped 3D points from {} to {}, below the {:.0}% \
             retention bound; the pinned calibration does not explain this block, so review the \
             affected calibration group's intrinsics policy before publishing",
            before.points3d,
            after.points3d,
            MIN_PINNED_READJUSTMENT_POINT_RETENTION * 100.0
        )));
    }
    Ok(())
}

/// Per-group seed and solved focal lengths, read back from the exported text model.
///
/// Report evidence only: a model this run cannot map back to its groups yields no rows rather
/// than failing an otherwise complete alignment.
fn calibration_group_intrinsics(
    request: &ColmapRunRequest,
    layout: &CalibrationGroupLayout,
    text_model: &Path,
) -> Vec<CalibrationGroupIntrinsicsDelta> {
    let Ok(camera_ids) = colmap_camera_ids_by_calibration_group(layout, text_model) else {
        return Vec::new();
    };
    let Ok(cameras) = parse_colmap_cameras_text(&text_model.join("cameras.txt")) else {
        return Vec::new();
    };
    let by_id = cameras
        .iter()
        .map(|camera| (camera.camera_id.as_str(), camera))
        .collect::<BTreeMap<_, _>>();
    let pinned = request
        .pinned_calibration_group_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    request
        .calibration_groups
        .iter()
        .map(|group| {
            let seed_focal_pixels = group.seed.as_ref().map(|seed| seed.focal_pixels);
            let solved_focal_pixels = camera_ids
                .get(&group.group_id)
                .and_then(|camera_id| by_id.get(camera_id.as_str()).copied())
                .and_then(|camera| camera.parameters.first().copied());
            CalibrationGroupIntrinsicsDelta {
                group_id: group.group_id.clone(),
                pinned: pinned.contains(group.group_id.as_str()),
                seed_focal_pixels,
                solved_focal_pixels,
                focal_delta_pixels: seed_focal_pixels
                    .zip(solved_focal_pixels)
                    .map(|(seed, solved)| solved - seed),
            }
        })
        .collect()
}

/// One persisted `camera-map.json` entry of an earlier alignment dataset.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishedCameraMapEntry {
    entity_id: String,
    image_name: PathBuf,
}

/// COLMAP models that carry independent `fx` and `fy` before the principal point.
fn colmap_model_has_two_focal_lengths(model: &str) -> bool {
    matches!(
        model,
        "PINHOLE"
            | "OPENCV"
            | "OPENCV_FISHEYE"
            | "FULL_OPENCV"
            | "FOV"
            | "THIN_PRISM_FISHEYE"
            | "RAD_TAN_THIN_PRISM_FISHEYE"
    )
}

fn parsed_camera_seed(camera: &ParsedColmapCamera) -> Option<ColmapCalibrationSeed> {
    let principal_index = usize::from(colmap_model_has_two_focal_lengths(&camera.model)) + 1;
    let seed = ColmapCalibrationSeed {
        width_pixels: camera.width_pixels,
        height_pixels: camera.height_pixels,
        focal_pixels: camera.parameters.first().copied()?,
        principal_x_pixels: camera.parameters.get(principal_index).copied()?,
        principal_y_pixels: camera.parameters.get(principal_index + 1).copied()?,
        full_brown_calibration: None,
    };
    valid_calibration_seed(&seed)?;
    Some(seed)
}

/// Reads back the intrinsics a published alignment actually solved, keyed by camera entity id.
///
/// A merge that re-seeds from these values keeps each mission's own refinement instead of
/// restarting the joint solve from COLMAP defaults.
pub fn solved_calibration_seeds(
    dataset_root: &Path,
) -> Result<BTreeMap<String, ColmapCalibrationSeed>, ColmapRuntimeError> {
    let camera_map: Vec<PublishedCameraMapEntry> =
        serde_json::from_slice(&fs::read(dataset_root.join("camera-map.json"))?)?;
    let text_model = dataset_root.join("sparse-view-source");
    let cameras = parse_colmap_cameras_text(&text_model.join("cameras.txt"))?;
    let seeds_by_camera_id = cameras
        .iter()
        .filter_map(|camera| {
            parsed_camera_seed(camera).map(|seed| (camera.camera_id.clone(), seed))
        })
        .collect::<BTreeMap<_, _>>();
    let camera_ids_by_image = colmap_camera_ids_by_image_name(&text_model.join("images.txt"))?;
    Ok(camera_map
        .into_iter()
        .filter_map(|entry| {
            let camera_id = camera_ids_by_image.get(&entry.image_name)?;
            let seed = seeds_by_camera_id.get(camera_id)?;
            Some((entry.entity_id, seed.clone()))
        })
        .collect())
}

fn colmap_camera_ids_by_image_name(
    images_path: &Path,
) -> Result<BTreeMap<PathBuf, String>, ColmapRuntimeError> {
    let contents = fs::read_to_string(images_path)?;
    let mut cameras = BTreeMap::new();
    let mut expecting_image = true;
    for line in contents.lines() {
        if line.starts_with('#') {
            continue;
        }
        if !expecting_image {
            expecting_image = true;
            continue;
        }
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns.is_empty() {
            continue;
        }
        if columns.len() < 10 {
            return Err(ColmapRuntimeError::InvalidWorkerOutput(
                "invalid images.txt image record".into(),
            ));
        }
        expecting_image = false;
        cameras.insert(PathBuf::from(columns[9]), columns[8].to_owned());
    }
    Ok(cameras)
}

fn validate_pinned_calibration_groups(
    request: &ColmapRunRequest,
) -> Result<(), ColmapRuntimeError> {
    if request.pinned_calibration_group_ids.is_empty() {
        return Ok(());
    }
    if request.intrinsics_refinement != ColmapIntrinsicsRefinement::Refine {
        return Err(ColmapRuntimeError::InvalidRequest(
            "a mixed intrinsics policy must run the mapper with refinement enabled".into(),
        ));
    }
    let mut pinned = BTreeSet::new();
    for group_id in &request.pinned_calibration_group_ids {
        if !pinned.insert(group_id.as_str()) {
            return Err(ColmapRuntimeError::InvalidRequest(
                "pinned calibration group ids must be unique".into(),
            ));
        }
        let group = request
            .calibration_groups
            .iter()
            .find(|group| &group.group_id == group_id)
            .ok_or_else(|| {
                ColmapRuntimeError::InvalidRequest(format!(
                    "pinned calibration group {group_id} is not part of this run"
                ))
            })?;
        if group.seed.is_none() {
            return Err(ColmapRuntimeError::InvalidRequest(format!(
                "pinned calibration group {group_id} has no calibration to restore"
            )));
        }
    }
    if pinned.len() == request.calibration_groups.len() {
        return Err(ColmapRuntimeError::InvalidRequest(
            "a run whose calibration groups are all pinned must freeze the mapper instead".into(),
        ));
    }
    Ok(())
}

fn valid_calibration_seed(seed: &ColmapCalibrationSeed) -> Option<()> {
    let width = seed.width_pixels;
    let height = seed.height_pixels;
    let values = [
        seed.focal_pixels,
        seed.principal_x_pixels,
        seed.principal_y_pixels,
    ];
    let base_valid = width > 0
        && height > 0
        && values.iter().all(|value| value.is_finite())
        && seed.focal_pixels > 0.0
        && seed.focal_pixels <= f64::from(width.max(height)) * 10.0
        && (0.0..=f64::from(width)).contains(&seed.principal_x_pixels)
        && (0.0..=f64::from(height)).contains(&seed.principal_y_pixels);
    (base_valid
        && seed
            .full_brown_calibration
            .as_ref()
            .is_none_or(|calibration| {
                calibration.is_valid_for_dimensions(ImageDimensions {
                    width_pixels: width,
                    height_pixels: height,
                }) && (calibration.focal_x_pixels - seed.focal_pixels).abs() <= 0.01
                    && (calibration.principal_x_pixels - seed.principal_x_pixels).abs() <= 0.01
                    && (calibration.principal_y_pixels - seed.principal_y_pixels).abs() <= 0.01
            }))
    .then_some(())
}

fn matching_command(
    selection: ColmapPairSelection,
    database: &Path,
) -> (ColmapCommandKind, Vec<OsString>) {
    let mut args = vec![os("--database_path"), database.as_os_str().to_owned()];
    match selection {
        ColmapPairSelection::Exhaustive => (ColmapCommandKind::ExhaustiveMatcher, args),
        ColmapPairSelection::Sequential { overlap } => {
            args.extend([os("--SequentialMatching.overlap"), os(overlap.to_string())]);
            (ColmapCommandKind::SequentialMatcher, args)
        }
    }
}

fn mapper_args(
    database: &Path,
    images: &Path,
    output: &Path,
    command: ColmapCommandKind,
    intrinsics_refinement: ColmapIntrinsicsRefinement,
) -> Vec<OsString> {
    let mut args = vec![
        os("--database_path"),
        database.as_os_str().to_owned(),
        os("--image_path"),
        images.as_os_str().to_owned(),
        os("--output_path"),
        output.as_os_str().to_owned(),
    ];
    let prefix = match command {
        ColmapCommandKind::GlobalMapper => "GlobalMapper",
        ColmapCommandKind::Mapper => "Mapper",
        _ => return args,
    };
    let (refine_focal, refine_principal, refine_extra) = match intrinsics_refinement {
        ColmapIntrinsicsRefinement::Refine => ("1", "0", "1"),
        ColmapIntrinsicsRefinement::FreezeReliableEmbedded => ("0", "0", "0"),
    };
    args.extend([
        os(format!("--{prefix}.ba_refine_focal_length")),
        os(refine_focal),
        os(format!("--{prefix}.ba_refine_principal_point")),
        os(refine_principal),
        os(format!("--{prefix}.ba_refine_extra_params")),
        os(refine_extra),
    ]);
    args
}

fn command_failure(report: &ColmapCommandReport) -> ColmapRuntimeError {
    ColmapRuntimeError::CommandFailed {
        command: report.command,
        exit_code: report.exit_code,
        message: report
            .log_tail
            .last()
            .cloned()
            .unwrap_or_else(|| "worker produced no diagnostic output".into()),
    }
}

#[derive(Debug)]
struct ProcessOutcome {
    status: ExitStatus,
    log_tail: Vec<String>,
}

#[derive(Debug)]
struct LogEvent {
    stream: &'static str,
    line: String,
}

fn supervise_child<F>(
    child: &mut Child,
    cancellation: &CancellationToken,
    mut progress: F,
) -> Result<ProcessOutcome, ColmapRuntimeError>
where
    F: FnMut(u64, u64),
{
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ColmapRuntimeError::Io(io::Error::other("COLMAP stdout was not piped")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ColmapRuntimeError::Io(io::Error::other("COLMAP stderr was not piped")))?;
    let (sender, receiver) = mpsc::channel();
    let stdout_reader = spawn_log_reader(stdout, "stdout", sender.clone());
    let stderr_reader = spawn_log_reader(stderr, "stderr", sender);
    let mut tail = VecDeque::with_capacity(LOG_TAIL_LINES);
    let mut last_progress: Option<(u64, u64)> = None;
    let status = loop {
        drain_log_events(&receiver, &mut tail, &mut last_progress, &mut progress);
        if cancellation.is_cancel_requested() {
            let _ = child.terminate_and_wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(ColmapRuntimeError::Cancelled);
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        match receiver.recv_timeout(CANCEL_POLL_INTERVAL) {
            Ok(event) => push_log_event(&mut tail, &mut last_progress, &mut progress, &event),
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {}
        }
    };
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    drain_log_events(&receiver, &mut tail, &mut last_progress, &mut progress);
    Ok(ProcessOutcome {
        status,
        log_tail: tail.into_iter().collect(),
    })
}

fn spawn_log_reader<R>(
    reader: R,
    stream: &'static str,
    sender: mpsc::Sender<LogEvent>,
) -> thread::JoinHandle<io::Result<()>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            let read = reader.read_until(b'\n', &mut bytes)?;
            if read == 0 {
                return Ok(());
            }
            if bytes.len() > MAX_LOG_LINE_BYTES {
                bytes.truncate(MAX_LOG_LINE_BYTES);
            }
            while bytes
                .last()
                .is_some_and(|byte| matches!(byte, b'\n' | b'\r'))
            {
                bytes.pop();
            }
            let line = String::from_utf8_lossy(&bytes).into_owned();
            if sender.send(LogEvent { stream, line }).is_err() {
                return Ok(());
            }
        }
    })
}

fn drain_log_events<F>(
    receiver: &mpsc::Receiver<LogEvent>,
    tail: &mut VecDeque<String>,
    last_progress: &mut Option<(u64, u64)>,
    progress: &mut F,
) where
    F: FnMut(u64, u64),
{
    while let Ok(event) = receiver.try_recv() {
        push_log_event(tail, last_progress, progress, &event);
    }
}

fn push_log_event<F>(
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
    if let Some((completed, total)) = parse_progress_fraction(&event.line) {
        let accept = match *last_progress {
            None => true,
            Some((previous, previous_total)) => total == previous_total && completed > previous,
        };
        if accept {
            *last_progress = Some((completed, total));
            progress(completed, total);
        }
    }
    tail.push_back(format!("{}: {}", event.stream, event.line));
}

fn parse_progress_fraction(line: &str) -> Option<(u64, u64)> {
    let cleaned = line.replace(['[', ']', '(', ')', ','], " ");
    let tokens = cleaned.split_whitespace().collect::<Vec<_>>();
    for token in &tokens {
        if let Some((left, right)) = token.split_once('/') {
            if let Some(fraction) = valid_fraction(left, right) {
                return Some(fraction);
            }
        }
    }
    for window in tokens.windows(3) {
        if window[1] == "/" {
            if let Some(fraction) = valid_fraction(window[0], window[2]) {
                return Some(fraction);
            }
        }
    }
    None
}

fn valid_fraction(left: &str, right: &str) -> Option<(u64, u64)> {
    let completed = left.trim_matches(|character: char| !character.is_ascii_digit());
    let total = right.trim_matches(|character: char| !character.is_ascii_digit());
    let completed = completed.parse::<u64>().ok()?;
    let total = total.parse::<u64>().ok()?;
    (total > 0 && completed <= total).then_some((completed, total))
}

fn validate_manifest(manifest: &ColmapToolManifest) -> Result<(), ColmapRuntimeError> {
    if manifest.schema_version != TOOL_MANIFEST_SCHEMA_VERSION {
        return Err(ColmapRuntimeError::UnsupportedManifestSchema(
            manifest.schema_version,
        ));
    }
    if manifest.tool_id != "colmap" {
        return Err(ColmapRuntimeError::InvalidConfig(format!(
            "unexpected tool id {}",
            manifest.tool_id
        )));
    }
    let major = manifest.version.split('.').next();
    if major != Some("4") {
        return Err(ColmapRuntimeError::UnsupportedColmapVersion(
            manifest.version.clone(),
        ));
    }
    if manifest.licenses.is_empty() {
        return Err(ColmapRuntimeError::EmptyLicenseInventory);
    }
    validate_hash(&manifest.executable.sha256, "executable")?;
    validate_relative_path(&manifest.executable.relative_path, "executable")?;
    for record in manifest.resources.values() {
        validate_hash(&record.sha256, "resource")?;
        validate_relative_path(&record.relative_path, "resource")?;
    }
    for license in &manifest.licenses {
        if license.component.trim().is_empty()
            || license.version.trim().is_empty()
            || license.spdx_expression.trim().is_empty()
        {
            return Err(ColmapRuntimeError::InvalidConfig(
                "license records must include component, version and SPDX expression".into(),
            ));
        }
        let expression = license.spdx_expression.to_ascii_uppercase();
        if ["GPL", "LGPL", "AGPL", "SSPL", "COMMONS CLAUSE"]
            .iter()
            .any(|forbidden| expression.contains(forbidden))
        {
            return Err(ColmapRuntimeError::ForbiddenLicense {
                component: license.component.clone(),
                expression: license.spdx_expression.clone(),
            });
        }
    }
    Ok(())
}

/// Verifies the locally installed COLMAP and reports the capabilities it actually exposes.
fn probe_development_cli(
    executable: &Path,
) -> Result<BTreeSet<ColmapCapability>, ColmapRuntimeError> {
    let help = development_command_output(executable, ["help"])?;
    for command in [
        "feature_extractor",
        "feature_importer",
        "matches_importer",
        "geometric_verifier",
        "global_mapper",
        "mapper",
        "model_converter",
        "model_aligner",
        "patch_match_stereo",
        "stereo_fusion",
        "mesh_texturer",
    ] {
        if !help.contains(command) {
            return Err(ColmapRuntimeError::InvalidConfig(format!(
                "developer COLMAP is missing command {command}"
            )));
        }
    }
    let extraction = development_command_output(executable, ["feature_extractor", "-h"])?;
    if !extraction.contains("FeatureExtraction.type") || !extraction.contains("AlikedExtraction") {
        return Err(ColmapRuntimeError::InvalidConfig(
            "developer COLMAP lacks ALIKED extraction options".into(),
        ));
    }
    let matching = development_command_output(executable, ["exhaustive_matcher", "-h"])?;
    if !matching.contains("FeatureMatching.type") || !matching.contains("lightglue") {
        return Err(ColmapRuntimeError::InvalidConfig(
            "developer COLMAP lacks LightGlue matching options".into(),
        ));
    }
    let mut capabilities = all_runtime_capabilities();
    if !help.contains("bundle_adjuster") {
        // Only the mixed intrinsics strategy needs the standalone adjuster. Every other run stays
        // available rather than failing preflight over an optional command.
        capabilities.remove(&ColmapCapability::BundleAdjuster);
    }
    Ok(capabilities)
}

fn development_command_output<I, S>(
    executable: &Path,
    args: I,
) -> Result<String, ColmapRuntimeError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new(executable);
    command
        .args(args)
        .env_clear()
        .env("COLMAP_NO_NETWORK", "1")
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    process_group::configure(&mut command);
    let output = command.output()?;
    if !output.status.success() {
        return Err(ColmapRuntimeError::InvalidConfig(format!(
            "developer COLMAP capability probe failed with {}",
            output.status
        )));
    }
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(text)
}

fn development_resources(
    configured: &BTreeMap<ColmapResourceKind, PathBuf>,
) -> Result<DevelopmentResources, ColmapRuntimeError> {
    let mut records = BTreeMap::new();
    let mut resources = BTreeMap::new();
    for required in [
        ColmapResourceKind::AlikedN16RotModel,
        ColmapResourceKind::AlikedN32Model,
        ColmapResourceKind::AlikedLightGlueModel,
        ColmapResourceKind::SiftLightGlueModel,
    ] {
        let path = configured
            .get(&required)
            .ok_or(ColmapRuntimeError::MissingResource(required))?;
        let canonical = path
            .canonicalize()
            .map_err(|error| ColmapRuntimeError::InvalidPath {
                path: path.clone(),
                reason: error.to_string(),
            })?;
        if !canonical.is_file() {
            return Err(ColmapRuntimeError::InvalidPath {
                path: canonical,
                reason: "developer model is not a regular file".into(),
            });
        }
        let sha256 = hash_file(&canonical, None)?;
        records.insert(
            required,
            ToolFileRecord {
                relative_path: canonical.clone(),
                sha256,
            },
        );
        resources.insert(required, canonical);
    }
    Ok((records, resources))
}

fn canonical_roots(paths: &[PathBuf]) -> Result<Vec<PathBuf>, ColmapRuntimeError> {
    let roots = paths
        .iter()
        .map(|path| canonical_directory(path))
        .collect::<Result<Vec<_>, _>>()?;
    if roots.is_empty() {
        Err(ColmapRuntimeError::InvalidConfig(
            "at least one allowed project root is required".into(),
        ))
    } else {
        Ok(roots)
    }
}

fn all_runtime_capabilities() -> BTreeSet<ColmapCapability> {
    BTreeSet::from([
        ColmapCapability::AlikedN16Rot,
        ColmapCapability::AlikedN32,
        ColmapCapability::Sift,
        ColmapCapability::LightGlue,
        ColmapCapability::GeometricVerification,
        ColmapCapability::GlobalMapper,
        ColmapCapability::IncrementalMapper,
        ColmapCapability::PatchMatchStereo,
        ColmapCapability::StereoFusion,
        ColmapCapability::PoissonMesher,
        ColmapCapability::DelaunayMesher,
        ColmapCapability::MeshTexturer,
        ColmapCapability::FeatureImporter,
        ColmapCapability::MatchesImporter,
        ColmapCapability::ModelConverter,
        ColmapCapability::ModelAligner,
        ColmapCapability::BundleAdjuster,
        ColmapCapability::OfflineOnlyBuild,
    ])
}

fn validate_hash(hash: &ObjectHash, field: &'static str) -> Result<(), ColmapRuntimeError> {
    let value = hash.as_str();
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ColmapRuntimeError::InvalidHash {
            field,
            value: value.into(),
        });
    }
    Ok(())
}

fn validate_component(field: &'static str, value: &str) -> Result<(), ColmapRuntimeError> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if valid && value != "." && value != ".." {
        Ok(())
    } else {
        Err(ColmapRuntimeError::InvalidRequest(format!(
            "{field} contains unsafe characters"
        )))
    }
}

fn validate_relative_path(path: &Path, field: &'static str) -> Result<(), ColmapRuntimeError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(ColmapRuntimeError::InvalidPath {
            path: path.into(),
            reason: format!("{field} must be a non-empty relative path"),
        });
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ColmapRuntimeError::InvalidPath {
            path: path.into(),
            reason: format!("{field} contains traversal or a path prefix"),
        });
    }
    let text = path
        .to_str()
        .ok_or_else(|| ColmapRuntimeError::InvalidPath {
            path: path.into(),
            reason: format!("{field} must be valid UTF-8 for the COLMAP image list"),
        })?;
    if text.contains(['\n', '\r']) {
        return Err(ColmapRuntimeError::InvalidPath {
            path: path.into(),
            reason: format!("{field} contains a line break"),
        });
    }
    Ok(())
}

fn canonical_directory(path: &Path) -> Result<PathBuf, ColmapRuntimeError> {
    let canonical = path
        .canonicalize()
        .map_err(|error| ColmapRuntimeError::InvalidPath {
            path: path.into(),
            reason: error.to_string(),
        })?;
    if !canonical.is_dir() {
        return Err(ColmapRuntimeError::InvalidPath {
            path: canonical,
            reason: "expected a directory".into(),
        });
    }
    Ok(canonical)
}

fn canonical_file_inside(path: &Path, root: &Path) -> Result<PathBuf, ColmapRuntimeError> {
    let canonical = path
        .canonicalize()
        .map_err(|error| ColmapRuntimeError::InvalidPath {
            path: path.into(),
            reason: error.to_string(),
        })?;
    if !canonical.starts_with(root) {
        return Err(ColmapRuntimeError::PathOutsideTrustedRoot(canonical));
    }
    if !canonical.is_file() {
        return Err(ColmapRuntimeError::InvalidPath {
            path: canonical,
            reason: "expected a regular file".into(),
        });
    }
    Ok(canonical)
}

fn resolve_manifest_file(
    root: &Path,
    record: &ToolFileRecord,
) -> Result<PathBuf, ColmapRuntimeError> {
    validate_relative_path(&record.relative_path, "manifest file")?;
    canonical_file_inside(&root.join(&record.relative_path), root)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, ColmapRuntimeError> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > limit {
        return Err(ColmapRuntimeError::InvalidConfig(format!(
            "{} exceeds the {} byte trust-input limit",
            path.display(),
            limit
        )));
    }
    let mut file = File::open(path)?;
    let capacity = usize::try_from(metadata.len())
        .map_err(|_| ColmapRuntimeError::InvalidConfig("trust input is too large".into()))?;
    let mut bytes = Vec::with_capacity(capacity);
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn verify_file_hash(
    path: &Path,
    expected: &ObjectHash,
    observed: &ObjectHash,
) -> Result<(), ColmapRuntimeError> {
    validate_hash(expected, "tool file")?;
    if expected == observed {
        Ok(())
    } else {
        Err(ColmapRuntimeError::HashMismatch {
            path: path.into(),
            expected: expected.clone(),
            observed: observed.clone(),
        })
    }
}

fn hash_file(
    path: &Path,
    cancellation: Option<&CancellationToken>,
) -> Result<ObjectHash, ColmapRuntimeError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024].into_boxed_slice();
    loop {
        if cancellation.is_some_and(CancellationToken::is_cancel_requested) {
            return Err(ColmapRuntimeError::Cancelled);
        }
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(ObjectHash(hex::encode(hasher.finalize())))
}

fn feature_cache_paths(root: &Path, key: &ObjectHash) -> (PathBuf, PathBuf) {
    (
        root.join(format!("{}.db", key.0)),
        root.join(format!("{}.json", key.0)),
    )
}

fn restore_feature_cache(
    root: &Path,
    key: &ObjectHash,
    destination: &Path,
    cancellation: &CancellationToken,
) -> Result<bool, ColmapRuntimeError> {
    let (database, record_path) = feature_cache_paths(root, key);
    if !database.is_file() || !record_path.is_file() {
        return Ok(false);
    }
    let record: FeatureCacheRecord =
        serde_json::from_slice(&read_bounded(&record_path, 64 * 1024)?)?;
    if record.schema_version != 1 || record.cache_key != *key {
        return Ok(false);
    }
    let observed = hash_file(&database, Some(cancellation))?;
    if observed != record.database_sha256 {
        return Ok(false);
    }
    copy_verified(
        &database,
        destination,
        &record.database_sha256,
        cancellation,
    )?;
    Ok(true)
}

fn publish_feature_cache(
    root: &Path,
    key: &ObjectHash,
    source: &Path,
    cancellation: &CancellationToken,
) -> Result<(), ColmapRuntimeError> {
    fs::create_dir_all(root)?;
    let (database, record_path) = feature_cache_paths(root, key);
    let database_sha256 = hash_file(source, Some(cancellation))?;
    let temporary = database.with_extension(format!("db.tmp-{}", std::process::id()));
    copy_verified(source, &temporary, &database_sha256, cancellation)?;
    if database.exists() {
        fs::remove_file(&database)?;
    }
    fs::rename(&temporary, &database)?;
    #[cfg(unix)]
    File::open(root)?.sync_all()?;
    atomic_write(
        &record_path,
        &serde_json::to_vec_pretty(&FeatureCacheRecord {
            schema_version: 1,
            cache_key: key.clone(),
            database_sha256,
        })?,
    )
}

fn create_scratch(root: &Path, job_id: &str) -> Result<PathBuf, ColmapRuntimeError> {
    for _ in 0..100 {
        let sequence = NEXT_SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = format!("colmap-{job_id}-{}-{sequence}", std::process::id());
        let path = root.join(name);
        match fs::create_dir(&path) {
            Ok(()) => return canonical_directory(&path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(ColmapRuntimeError::Io(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique COLMAP scratch directory",
    )))
}

fn create_workspace_directories(scratch: &Path) -> Result<(), ColmapRuntimeError> {
    for relative in [
        "images",
        "features/aliked",
        "features/sift",
        "features/dedode",
        "mapping",
        "sparse-global",
        "sparse-incremental",
    ] {
        fs::create_dir_all(scratch.join(relative))?;
    }
    Ok(())
}

pub(crate) fn materialize_project_images(
    project_root: &Path,
    camera_images: &[ProjectCameraImageRecord],
    scratch: &Path,
    cancellation: &CancellationToken,
) -> Result<Vec<PathBuf>, ColmapRuntimeError> {
    let mut materialized = Vec::with_capacity(camera_images.len());
    let mut entity_ids = BTreeSet::new();
    for (index, camera) in camera_images.iter().enumerate() {
        if !entity_ids.insert(camera.entity_id.0.clone()) {
            return Err(ColmapRuntimeError::InvalidRequest(format!(
                "duplicate camera entity {}",
                camera.entity_id.0
            )));
        }
        verify_camera_metadata(project_root, camera, cancellation)?;
        let source_hash = &camera.metadata.source_object_hash;
        validate_hash(source_hash, "camera source object")?;
        let source = project_object_path(project_root, source_hash)?;
        let source_observed = hash_file(&source, Some(cancellation))?;
        verify_file_hash(&source, source_hash, &source_observed)?;
        let expected_size = camera.metadata.inspected_photo.byte_size;
        if fs::metadata(&source)?.len() != expected_size {
            return Err(ColmapRuntimeError::InvalidRequest(format!(
                "camera source size differs from imported metadata for {}",
                camera.entity_id.0
            )));
        }
        let relative = PathBuf::from(format!("{index:08}")).join(format!(
            "image.{}",
            canonical_image_extension(camera.metadata.inspected_photo.format)
        ));
        let destination = scratch.join("images").join(&relative);
        fs::create_dir_all(
            destination
                .parent()
                .expect("materialized image always has a parent"),
        )?;
        if fs::hard_link(&source, &destination).is_err() {
            copy_verified(&source, &destination, source_hash, cancellation)?;
        }
        let materialized_hash = hash_file(&destination, Some(cancellation))?;
        if materialized_hash != *source_hash {
            let _ = fs::remove_file(&destination);
            return Err(ColmapRuntimeError::HashMismatch {
                path: destination,
                expected: source_hash.clone(),
                observed: materialized_hash,
            });
        }
        materialized.push(relative);
    }
    Ok(materialized)
}

fn verify_camera_metadata(
    project_root: &Path,
    camera: &ProjectCameraImageRecord,
    cancellation: &CancellationToken,
) -> Result<(), ColmapRuntimeError> {
    validate_hash(&camera.metadata_object_hash, "camera metadata object")?;
    let path = project_object_path(project_root, &camera.metadata_object_hash)?;
    let bytes = read_file_with_cancel(&path, cancellation)?;
    let observed = ObjectHash::of_bytes(&bytes);
    verify_file_hash(&path, &camera.metadata_object_hash, &observed)?;
    let stored: CameraImageMetadataRecord = serde_json::from_slice(&bytes)?;
    if stored != camera.metadata {
        return Err(ColmapRuntimeError::InvalidRequest(format!(
            "camera metadata record does not match project object for {}",
            camera.entity_id.0
        )));
    }
    Ok(())
}

fn project_object_path(
    project_root: &Path,
    hash: &ObjectHash,
) -> Result<PathBuf, ColmapRuntimeError> {
    validate_hash(hash, "project object")?;
    let (prefix, remainder) = hash.as_str().split_at(2);
    canonical_file_inside(
        &project_root.join("objects").join(prefix).join(remainder),
        project_root,
    )
}

fn canonical_image_extension(format: PhotoFormat) -> &'static str {
    match format {
        PhotoFormat::Jpeg => "jpg",
        PhotoFormat::Tiff => "tif",
        PhotoFormat::Dng => "dng",
        PhotoFormat::Png => "png",
        PhotoFormat::Heic => "heic",
        PhotoFormat::Heif => "heif",
        PhotoFormat::Avif => "avif",
        PhotoFormat::CanonCr3 => "cr3",
        PhotoFormat::FujifilmRaf => "raf",
        PhotoFormat::PhaseOneIiq => "iiq",
    }
}

fn copy_verified(
    source: &Path,
    destination: &Path,
    expected_hash: &ObjectHash,
    cancellation: &CancellationToken,
) -> Result<(), ColmapRuntimeError> {
    let mut input = File::open(source)?;
    let mut output = File::create(destination)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024].into_boxed_slice();
    loop {
        if cancellation.is_cancel_requested() {
            let _ = fs::remove_file(destination);
            return Err(ColmapRuntimeError::Cancelled);
        }
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
    }
    output.sync_all()?;
    let observed = ObjectHash(hex::encode(hasher.finalize()));
    if observed != *expected_hash {
        let _ = fs::remove_file(destination);
        return Err(ColmapRuntimeError::HashMismatch {
            path: source.into(),
            expected: expected_hash.clone(),
            observed,
        });
    }
    Ok(())
}

fn read_file_with_cancel(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, ColmapRuntimeError> {
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    loop {
        if cancellation.is_cancel_requested() {
            return Err(ColmapRuntimeError::Cancelled);
        }
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
}

fn write_image_list(scratch: &Path, names: &[PathBuf]) -> Result<(), ColmapRuntimeError> {
    write_image_list_path(&scratch.join("image-list.txt"), names)
}

fn write_image_list_path(path: &Path, names: &[PathBuf]) -> Result<(), ColmapRuntimeError> {
    let mut bytes = Vec::new();
    for name in names {
        let text = name
            .to_str()
            .ok_or_else(|| ColmapRuntimeError::InvalidPath {
                path: name.clone(),
                reason: "image name is not UTF-8".into(),
            })?;
        bytes.extend_from_slice(text.as_bytes());
        bytes.push(b'\n');
    }
    atomic_write(path, &bytes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MaterializedCameraMapEntry<'a> {
    entity_id: &'a str,
    image_name: &'a Path,
}

fn write_camera_map(
    scratch: &Path,
    cameras: &[ProjectCameraImageRecord],
    materialized: &[PathBuf],
) -> Result<(), ColmapRuntimeError> {
    if cameras.len() != materialized.len() {
        return Err(ColmapRuntimeError::InvalidRequest(
            "camera map length differs from materialized images".into(),
        ));
    }
    let entries = cameras
        .iter()
        .zip(materialized)
        .map(|(camera, image_name)| MaterializedCameraMapEntry {
            entity_id: &camera.entity_id.0,
            image_name,
        })
        .collect::<Vec<_>>();
    atomic_write(
        &scratch.join("camera-map.json"),
        &serde_json::to_vec(&entries)?,
    )
}

fn projected_reference_count(request: &ColmapRunRequest) -> usize {
    request
        .camera_images
        .iter()
        .filter(|camera| {
            camera
                .metadata
                .projected_reference
                .as_ref()
                .is_some_and(|reference| {
                    reference.easting.is_finite()
                        && reference.northing.is_finite()
                        && reference
                            .transformed_height_meters
                            .is_some_and(f64::is_finite)
                })
        })
        .count()
}

fn write_projected_camera_references(
    path: &Path,
    cameras: &[ProjectCameraImageRecord],
    materialized: &[PathBuf],
) -> Result<(), ColmapRuntimeError> {
    if cameras.len() != materialized.len() {
        return Err(ColmapRuntimeError::InvalidRequest(
            "projected camera reference map length mismatch".into(),
        ));
    }
    let mut bytes = Vec::new();
    for (camera, image_name) in cameras.iter().zip(materialized) {
        let Some(reference) = camera.metadata.projected_reference.as_ref() else {
            continue;
        };
        let Some(height) = reference.transformed_height_meters else {
            continue;
        };
        if !reference.easting.is_finite() || !reference.northing.is_finite() || !height.is_finite()
        {
            continue;
        }
        let image_name = image_name
            .to_str()
            .ok_or_else(|| ColmapRuntimeError::InvalidPath {
                path: image_name.clone(),
                reason: "materialized image name is not UTF-8".into(),
            })?;
        writeln!(
            bytes,
            "{image_name} {:.17} {:.17} {:.17}",
            reference.easting, reference.northing, height
        )?;
    }
    atomic_write(path, &bytes)
}

fn ensure_file(path: &Path) -> Result<(), ColmapRuntimeError> {
    if path.is_file() {
        Ok(())
    } else {
        Err(ColmapRuntimeError::MissingOutput(path.into()))
    }
}

fn find_sparse_model(root: &Path) -> Option<PathBuf> {
    let mut candidates = fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    candidates.sort();
    candidates
        .into_iter()
        .find(|path| sparse_model_is_viable(path))
}

fn sparse_model_is_viable(path: &Path) -> bool {
    sparse_table_has_records(path, "cameras")
        && sparse_table_has_records(path, "images")
        && sparse_table_has_records(path, "points3D")
}

fn sparse_table_has_records(path: &Path, stem: &str) -> bool {
    let binary = path.join(format!("{stem}.bin"));
    if binary
        .metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 8)
    {
        return true;
    }
    let text = path.join(format!("{stem}.txt"));
    fs::read_to_string(text).is_ok_and(|contents| {
        contents
            .lines()
            .map(str::trim)
            .any(|line| !line.is_empty() && !line.starts_with('#'))
    })
}

fn feature_store_name(store: SelectedFeatureStore) -> &'static str {
    match store {
        SelectedFeatureStore::Aliked => "aliked",
        SelectedFeatureStore::Sift => "sift",
        SelectedFeatureStore::DedodeV2G => "dedode-v2-g",
    }
}

fn mapper_name(mapper: SelectedMapper) -> &'static str {
    match mapper {
        SelectedMapper::Global => "global",
        SelectedMapper::IncrementalFallback => "incremental",
    }
}

fn compare_mapping_candidates(
    left: &ScoredMappingCandidate,
    right: &ScoredMappingCandidate,
    preferred_store: SelectedFeatureStore,
) -> CmpOrdering {
    left.summary
        .registered_images
        .cmp(&right.summary.registered_images)
        .then_with(|| left.summary.observations.cmp(&right.summary.observations))
        .then_with(|| left.summary.points3d.cmp(&right.summary.points3d))
        .then_with(|| {
            compare_optional_error(
                left.summary.mean_reprojection_error,
                right.summary.mean_reprojection_error,
            )
        })
        .then_with(|| {
            (left.summary.feature_store == preferred_store)
                .cmp(&(right.summary.feature_store == preferred_store))
        })
        .then_with(|| {
            (left.summary.mapper == SelectedMapper::Global)
                .cmp(&(right.summary.mapper == SelectedMapper::Global))
        })
        .then_with(|| right.summary.feature_store.cmp(&left.summary.feature_store))
}

fn compare_optional_error(left: Option<f64>, right: Option<f64>) -> CmpOrdering {
    match (left, right) {
        (Some(left), Some(right)) => right.partial_cmp(&left).unwrap_or(CmpOrdering::Equal),
        (Some(_), None) => CmpOrdering::Greater,
        (None, Some(_)) => CmpOrdering::Less,
        (None, None) => CmpOrdering::Equal,
    }
}

fn parse_sparse_model_statistics(
    text_model: &Path,
) -> Result<SparseModelStatistics, ColmapRuntimeError> {
    let images_path = text_model.join("images.txt");
    let points_path = text_model.join("points3D.txt");
    ensure_file(&images_path)?;
    ensure_file(&points_path)?;

    let images = BufReader::new(File::open(images_path)?);
    let mut registered_images = 0_u64;
    let mut observations = 0_u64;
    let mut expecting_image = true;
    for line in images.lines() {
        let line = line?;
        if line.starts_with('#') {
            continue;
        }
        if expecting_image {
            if line.trim().is_empty() {
                continue;
            }
            let columns = line.split_whitespace().collect::<Vec<_>>();
            if columns.len() < 10 || columns[0].parse::<u64>().is_err() {
                return Err(ColmapRuntimeError::InvalidWorkerOutput(
                    "invalid images.txt image record".into(),
                ));
            }
            registered_images = registered_images.checked_add(1).ok_or_else(|| {
                ColmapRuntimeError::InvalidWorkerOutput("registered image count overflow".into())
            })?;
            expecting_image = false;
        } else {
            let columns = line.split_whitespace().collect::<Vec<_>>();
            if columns.len() % 3 != 0 {
                return Err(ColmapRuntimeError::InvalidWorkerOutput(
                    "invalid images.txt point observation record".into(),
                ));
            }
            for observation in columns.chunks_exact(3) {
                if observation[2] != "-1" {
                    observations = observations.checked_add(1).ok_or_else(|| {
                        ColmapRuntimeError::InvalidWorkerOutput("observation count overflow".into())
                    })?;
                }
            }
            expecting_image = true;
        }
    }
    if !expecting_image {
        return Err(ColmapRuntimeError::InvalidWorkerOutput(
            "images.txt ends before an observation record".into(),
        ));
    }

    let points = BufReader::new(File::open(points_path)?);
    let mut points3d = 0_u64;
    let mut error_sum = 0_f64;
    for line in points.lines() {
        let line = line?;
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns.len() < 8 || (columns.len() - 8) % 2 != 0 {
            return Err(ColmapRuntimeError::InvalidWorkerOutput(
                "invalid points3D.txt record".into(),
            ));
        }
        let error = columns[7].parse::<f64>().map_err(|_| {
            ColmapRuntimeError::InvalidWorkerOutput(
                "invalid points3D.txt reprojection error".into(),
            )
        })?;
        if !error.is_finite() || error < 0.0 {
            return Err(ColmapRuntimeError::InvalidWorkerOutput(
                "non-finite or negative reprojection error".into(),
            ));
        }
        points3d = points3d.checked_add(1).ok_or_else(|| {
            ColmapRuntimeError::InvalidWorkerOutput("3D point count overflow".into())
        })?;
        error_sum += error;
    }
    Ok(SparseModelStatistics {
        registered_images,
        points3d,
        observations,
        mean_reprojection_error: (points3d > 0).then_some(error_sum / points3d as f64),
    })
}

fn copy_directory_tree(
    source: &Path,
    destination: &Path,
    cancellation: &CancellationToken,
) -> Result<(), ColmapRuntimeError> {
    if destination.exists() {
        return Err(ColmapRuntimeError::InvalidWorkerOutput(format!(
            "selected sparse destination already exists: {}",
            destination.display()
        )));
    }
    fs::create_dir_all(destination)?;
    let mut entries = fs::read_dir(source)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        if cancellation.is_cancel_requested() {
            return Err(ColmapRuntimeError::Cancelled);
        }
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_symlink() {
            return Err(ColmapRuntimeError::InvalidWorkerOutput(format!(
                "sparse model contains a symbolic link: {}",
                entry.path().display()
            )));
        }
        if file_type.is_dir() {
            copy_directory_tree(&entry.path(), &target, cancellation)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)?;
        } else {
            return Err(ColmapRuntimeError::InvalidWorkerOutput(format!(
                "sparse model contains an unsupported file: {}",
                entry.path().display()
            )));
        }
    }
    Ok(())
}

fn selected_sparse_path(
    scratch: &Path,
    selected_mapper: SelectedMapper,
) -> Result<PathBuf, ColmapRuntimeError> {
    let aligned = scratch.join("sparse-aligned");
    if aligned.is_dir() && sparse_model_is_viable(&aligned) {
        return Ok(aligned);
    }
    selected_sparse_unaligned_path(scratch, selected_mapper)
}

fn selected_sparse_unaligned_path(
    scratch: &Path,
    selected_mapper: SelectedMapper,
) -> Result<PathBuf, ColmapRuntimeError> {
    let hybrid = scratch.join("sparse-selected/0");
    if hybrid.is_dir() && sparse_model_is_viable(&hybrid) {
        return Ok(hybrid);
    }
    let root = scratch.join(match selected_mapper {
        SelectedMapper::Global => "sparse-global",
        SelectedMapper::IncrementalFallback => "sparse-incremental",
    });
    find_sparse_model(&root).ok_or(ColmapRuntimeError::MissingOutput(root))
}

fn summarize_artifacts(
    request: &ColmapRunRequest,
    scratch: &Path,
    selected_mapper: SelectedMapper,
    cancellation: &CancellationToken,
) -> Result<Vec<ColmapArtifactSummary>, ColmapRuntimeError> {
    let mut artifacts = Vec::new();
    let aliked_database = scratch.join("features/aliked/database.db");
    if aliked_database.is_file() {
        artifacts.push(summarize_artifact(
            ColmapArtifactKind::AlikedVerifiedDatabase,
            scratch,
            &aliked_database,
            cancellation,
        )?);
    }
    let sift_database = scratch.join("features/sift/database.db");
    if sift_database.is_file() {
        artifacts.push(summarize_artifact(
            ColmapArtifactKind::SiftVerifiedDatabase,
            scratch,
            &sift_database,
            cancellation,
        )?);
    }
    if matches!(
        request.large_matching_backend,
        LargeMatchingBackend::DedodeV2G { .. }
    ) {
        artifacts.push(summarize_artifact(
            ColmapArtifactKind::DedodeVerifiedDatabase,
            scratch,
            &scratch.join("features/dedode/database.db"),
            cancellation,
        )?);
    }
    artifacts.push(summarize_artifact(
        ColmapArtifactKind::SparseModel,
        scratch,
        &selected_sparse_path(scratch, selected_mapper)?,
        cancellation,
    )?);
    artifacts.push(summarize_artifact(
        ColmapArtifactKind::SparsePointCloud,
        scratch,
        &scratch.join("sparse-view-source/points3D.txt"),
        cancellation,
    )?);
    let dense = scratch.join("dense");
    if request.products.depth_maps {
        artifacts.push(summarize_artifact(
            ColmapArtifactKind::DepthMaps,
            scratch,
            &dense.join("stereo/depth_maps"),
            cancellation,
        )?);
    }
    if request.products.dense_point_cloud {
        artifacts.push(summarize_artifact(
            ColmapArtifactKind::DensePointCloud,
            scratch,
            &dense.join("fused.ply"),
            cancellation,
        )?);
    }
    if let Some(mesher) = request.products.mesh {
        artifacts.push(summarize_artifact(
            ColmapArtifactKind::Mesh,
            scratch,
            &dense.join(match mesher {
                ColmapMesher::Poisson => "meshed-poisson.ply",
                ColmapMesher::Delaunay => "meshed-delaunay.ply",
            }),
            cancellation,
        )?);
    }
    if request.products.texture_mesh {
        artifacts.push(summarize_artifact(
            ColmapArtifactKind::TexturedMesh,
            scratch,
            &dense.join("textured"),
            cancellation,
        )?);
    }
    Ok(artifacts)
}

fn summarize_artifact(
    kind: ColmapArtifactKind,
    scratch: &Path,
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<ColmapArtifactSummary, ColmapRuntimeError> {
    if !path.exists() {
        return Err(ColmapRuntimeError::MissingOutput(path.into()));
    }
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(scratch) {
        return Err(ColmapRuntimeError::PathOutsideTrustedRoot(canonical));
    }
    let relative_path = canonical
        .strip_prefix(scratch)
        .map_err(|error| ColmapRuntimeError::InvalidPath {
            path: canonical.clone(),
            reason: error.to_string(),
        })?
        .to_owned();
    let (sha256, bytes) = if canonical.is_file() {
        (
            hash_file(&canonical, Some(cancellation))?,
            fs::metadata(&canonical)?.len(),
        )
    } else if canonical.is_dir() {
        hash_directory(&canonical, cancellation)?
    } else {
        return Err(ColmapRuntimeError::InvalidPath {
            path: canonical,
            reason: "artifact must be a regular file or directory".into(),
        });
    };
    Ok(ColmapArtifactSummary {
        kind,
        relative_path,
        sha256,
        bytes,
    })
}

fn hash_directory(
    root: &Path,
    cancellation: &CancellationToken,
) -> Result<(ObjectHash, u64), ColmapRuntimeError> {
    let mut files = Vec::new();
    collect_regular_files(root, root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = Sha256::new();
    let mut total_bytes = 0_u64;
    for (relative, path) in files {
        if cancellation.is_cancel_requested() {
            return Err(ColmapRuntimeError::Cancelled);
        }
        let file_hash = hash_file(&path, Some(cancellation))?;
        let size = fs::metadata(&path)?.len();
        total_bytes = total_bytes.checked_add(size).ok_or_else(|| {
            ColmapRuntimeError::InvalidRequest("artifact byte count overflow".into())
        })?;
        let name = relative.as_os_str().as_encoded_bytes();
        hasher.update(u64::try_from(name.len()).unwrap_or(u64::MAX).to_le_bytes());
        hasher.update(name);
        hasher.update(size.to_le_bytes());
        hasher.update(file_hash.as_str().as_bytes());
    }
    Ok((ObjectHash(hex::encode(hasher.finalize())), total_bytes))
}

fn collect_regular_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(PathBuf, PathBuf)>,
) -> Result<(), ColmapRuntimeError> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_symlink() {
            return Err(ColmapRuntimeError::InvalidPath {
                path,
                reason: "symlinks are forbidden in worker artifacts".into(),
            });
        }
        if file_type.is_dir() {
            collect_regular_files(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .expect("walked path remains below artifact root")
                .to_owned();
            files.push((relative, path));
        } else {
            return Err(ColmapRuntimeError::InvalidPath {
                path,
                reason: "special files are forbidden in worker artifacts".into(),
            });
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), ColmapRuntimeError> {
    let parent = path
        .parent()
        .ok_or_else(|| ColmapRuntimeError::InvalidPath {
            path: path.into(),
            reason: "output has no parent directory".into(),
        })?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("tmp");
    let mut file = File::create(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn millis_u64(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn os(value: impl AsRef<OsStr>) -> OsString {
    value.as_ref().to_owned()
}

#[cfg(all(test, unix))]
mod tests {
    use std::{
        os::unix::fs::PermissionsExt,
        sync::mpsc as std_mpsc,
        time::{SystemTime, UNIX_EPOCH},
    };

    use himmelcad_core::{
        entity::EntityId,
        hash::ObjectHash,
        photolab_images::{
            DiscoveredPhoto, ImageDimensions, PhotoFormat, PhotoMetadata, ProjectedPhotoReference,
        },
        photolab_jobs::{
            NewPhotolabJob, PhotolabJob, PhotolabJobId, PhotolabJobKind, PhotolabJobState,
        },
    };

    use super::*;
    use crate::{
        dedode_runtime::{DedodeImagePair, DedodeMatch, DedodePairMatches, DedodeWorkerResult},
        job_runtime::{JobManager, JobManagerConfig},
    };

    #[derive(Debug)]
    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "himmelcad-colmap-{label}-{}-{nonce}",
                std::process::id()
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

    #[test]
    fn command_success_with_empty_sparse_tables_is_not_a_reconstruction() {
        let directory = TestDirectory::new("empty-sparse-model");
        let model = directory.0.join("0");
        fs::create_dir_all(&model).expect("model directory");
        for name in ["cameras.bin", "images.bin", "points3D.bin"] {
            fs::write(model.join(name), 0_u64.to_le_bytes()).expect("empty COLMAP table");
        }
        assert!(find_sparse_model(&directory.0).is_none());
        fs::write(model.join("cameras.bin"), [0_u8; 16]).expect("camera record");
        fs::write(model.join("images.bin"), [0_u8; 16]).expect("image record");
        fs::write(model.join("points3D.bin"), [0_u8; 16]).expect("point record");
        assert_eq!(find_sparse_model(&directory.0), Some(model));
    }

    fn write_project_object(project: &Path, bytes: &[u8]) -> ObjectHash {
        let hash = ObjectHash::of_bytes(bytes);
        let (prefix, remainder) = hash.as_str().split_at(2);
        let directory = project.join("objects").join(prefix);
        fs::create_dir_all(&directory).expect("create object prefix");
        fs::write(directory.join(remainder), bytes).expect("write project object");
        hash
    }

    struct TestSignatureVerifier;

    impl ManifestSignatureVerifier for TestSignatureVerifier {
        fn verify_detached(
            &self,
            signer_key_id: &str,
            _manifest: &[u8],
            signature: &[u8],
        ) -> Result<(), String> {
            if signer_key_id == "test-key" && signature == b"signed-by-test-key" {
                Ok(())
            } else {
                Err("test signature mismatch".into())
            }
        }
    }

    struct TestRig {
        _directory: TestDirectory,
        config: ColmapRuntimeConfig,
        project: PathBuf,
        camera_images: Vec<ProjectCameraImageRecord>,
        tool_root: PathBuf,
    }

    fn write_fake_feature_database_schema(connection: &rusqlite::Connection) {
        connection
            .execute_batch(
                "CREATE TABLE images (image_id INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE, camera_id INTEGER NOT NULL);\
                 CREATE TABLE keypoints (image_id INTEGER PRIMARY KEY NOT NULL, rows INTEGER NOT NULL, cols INTEGER NOT NULL, data BLOB);\
                 CREATE TABLE descriptors (image_id INTEGER PRIMARY KEY NOT NULL, type INTEGER NOT NULL, rows INTEGER NOT NULL, cols INTEGER NOT NULL, data BLOB);\
                 CREATE TABLE matches (pair_id INTEGER PRIMARY KEY NOT NULL, rows INTEGER NOT NULL, cols INTEGER NOT NULL, data BLOB);\
                 CREATE TABLE two_view_geometries (pair_id INTEGER PRIMARY KEY NOT NULL, rows INTEGER NOT NULL, cols INTEGER NOT NULL, data BLOB);",
            )
            .expect("create fake feature database schema");
    }

    fn write_fake_feature_databases(tool_root: &Path) {
        let tile = tool_root.join("fake-tile.db");
        let connection = rusqlite::Connection::open(&tile).expect("create fake tile database");
        write_fake_feature_database_schema(&connection);
        connection
            .execute(
                "INSERT INTO images(image_id, name, camera_id) VALUES (1, 'tile.png', 1)",
                [],
            )
            .expect("insert fake tile image");
        drop(connection);
        write_image_features(
            &tile,
            1,
            &ColmapKeypointMatrix::Affine(vec![
                [104.0, 50.0, 1.0, 0.0, 0.0, 1.0],
                [1_000.0, 50.0, 1.0, 0.0, 0.0, 1.0],
            ]),
            &ColmapDescriptorMatrix::AlikedN16RotF32(vec![[0.1; 128], [0.2; 128]]),
        )
        .expect("write fake tile features");

        let bootstrap = tool_root.join("fake-bootstrap.db");
        let connection =
            rusqlite::Connection::open(&bootstrap).expect("create fake bootstrap database");
        write_fake_feature_database_schema(&connection);
        for (image_id, name) in [
            (1_i64, "calibration-000000/image-00000000.jpg"),
            (2_i64, "calibration-000000/image-00000001.jpg"),
        ] {
            connection
                .execute(
                    "INSERT INTO images(image_id, name, camera_id) VALUES (?1, ?2, ?1)",
                    rusqlite::params![image_id, name],
                )
                .expect("insert fake bootstrap image");
        }
        drop(connection);
        for image_id in [1_i64, 2_i64] {
            write_image_features(
                &bootstrap,
                image_id,
                &ColmapKeypointMatrix::Similarity(vec![[0.5, 0.5, 1.0, 0.0]]),
                &ColmapDescriptorMatrix::SiftU8(vec![[0; 128]]),
            )
            .expect("write fake bootstrap features");
        }
    }

    impl TestRig {
        fn new(label: &str, fail_global: bool, slow_patch_match: bool) -> Self {
            let directory = TestDirectory::new(label);
            let tool_root = directory.0.join("tool");
            let project = directory.0.join("inputs/project");
            let scratch = directory.0.join("scratch");
            fs::create_dir_all(tool_root.join("models")).expect("create model directory");
            write_fake_feature_databases(&tool_root);
            fs::create_dir_all(project.join("objects")).expect("create project objects");
            fs::create_dir_all(&scratch).expect("create scratch directory");
            let camera_images = [
                ("camera-a", "/original/flight/a.jpg", b"a".as_slice()),
                ("camera-b", "/original/flight/b.jpg", b"b".as_slice()),
            ]
            .into_iter()
            .map(|(entity_id, source_path, bytes)| {
                let source_object_hash = write_project_object(&project, bytes);
                let metadata = CameraImageMetadataRecord {
                    schema_version: 1,
                    source_object_hash: source_object_hash.clone(),
                    transformation_object_hash: ObjectHash::of_bytes(b"transformation"),
                    inspected_photo: DiscoveredPhoto {
                        source_path: source_path.into(),
                        format: PhotoFormat::Jpeg,
                        byte_size: u64::try_from(bytes.len()).expect("test image length fits u64"),
                        sha256: source_object_hash,
                        metadata: PhotoMetadata::default(),
                        capture_source: Default::default(),
                        decoder_capability: None,
                        position_prior: None,
                        derived_provenance: None,
                        duplicate_of: None,
                    },
                    projected_reference: None,
                    status_tags: BTreeSet::new(),
                };
                let metadata_bytes =
                    serde_json::to_vec(&metadata).expect("serialize camera metadata");
                let metadata_object_hash = write_project_object(&project, &metadata_bytes);
                ProjectCameraImageRecord {
                    entity_id: EntityId(entity_id.into()),
                    name: source_path.into(),
                    metadata_object_hash,
                    metadata,
                }
            })
            .collect::<Vec<_>>();

            let executable = tool_root.join("colmap");
            fs::write(
                &executable,
                fake_colmap_script(fail_global, slow_patch_match),
            )
            .expect("write fake COLMAP");
            let mut permissions = fs::metadata(&executable)
                .expect("fake executable metadata")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&executable, permissions).expect("make fake executable runnable");

            let resources = [
                (
                    ColmapResourceKind::AlikedN16RotModel,
                    "models/aliked-n16rot.onnx",
                ),
                (ColmapResourceKind::AlikedN32Model, "models/aliked-n32.onnx"),
                (
                    ColmapResourceKind::AlikedLightGlueModel,
                    "models/aliked-lightglue.onnx",
                ),
                (
                    ColmapResourceKind::SiftLightGlueModel,
                    "models/sift-lightglue.onnx",
                ),
            ]
            .into_iter()
            .map(|(kind, relative)| {
                let path = tool_root.join(relative);
                fs::write(&path, format!("model:{relative}")).expect("write fake model");
                (
                    kind,
                    ToolFileRecord {
                        relative_path: relative.into(),
                        sha256: hash_file(&path, None).expect("hash fake model"),
                    },
                )
            })
            .collect();
            let capabilities = BTreeSet::from([
                ColmapCapability::AlikedN16Rot,
                ColmapCapability::AlikedN32,
                ColmapCapability::Sift,
                ColmapCapability::LightGlue,
                ColmapCapability::GeometricVerification,
                ColmapCapability::GlobalMapper,
                ColmapCapability::IncrementalMapper,
                ColmapCapability::PatchMatchStereo,
                ColmapCapability::StereoFusion,
                ColmapCapability::PoissonMesher,
                ColmapCapability::DelaunayMesher,
                ColmapCapability::MeshTexturer,
                ColmapCapability::FeatureImporter,
                ColmapCapability::MatchesImporter,
                ColmapCapability::ModelConverter,
                ColmapCapability::ModelAligner,
                ColmapCapability::BundleAdjuster,
                ColmapCapability::OfflineOnlyBuild,
            ]);
            let manifest = ColmapToolManifest {
                schema_version: TOOL_MANIFEST_SCHEMA_VERSION,
                tool_id: "colmap".into(),
                version: "4.0.2".into(),
                executable: ToolFileRecord {
                    relative_path: "colmap".into(),
                    sha256: hash_file(&executable, None).expect("hash fake executable"),
                },
                resources,
                capabilities,
                licenses: vec![ToolLicenseRecord {
                    component: "COLMAP".into(),
                    version: "4.0.2".into(),
                    spdx_expression: "BSD-3-Clause".into(),
                }],
            };
            let manifest_bytes = serde_json::to_vec_pretty(&manifest).expect("serialize manifest");
            let manifest_path = tool_root.join("manifest.json");
            fs::write(&manifest_path, &manifest_bytes).expect("write manifest");
            let signature_path = tool_root.join("manifest.sig");
            fs::write(&signature_path, b"signed-by-test-key").expect("write signature");
            let config = ColmapRuntimeConfig {
                tool_root: tool_root.clone(),
                manifest_path,
                detached_signature_path: signature_path,
                expected_manifest_sha256: ObjectHash::of_bytes(&manifest_bytes),
                trusted_signer_key_id: "test-key".into(),
                scratch_root: scratch,
                allowed_project_roots: vec![directory.0.join("inputs")],
            };
            Self {
                _directory: directory,
                config,
                project,
                camera_images,
                tool_root,
            }
        }

        fn runtime(&self) -> ColmapRuntime {
            ColmapRuntime::preflight(&self.config, &TestSignatureVerifier)
                .expect("preflight fake COLMAP")
        }

        fn request(&self, job_id: &str) -> ColmapRunRequest {
            ColmapRunRequest {
                job_id: job_id.into(),
                project_root: self.project.clone(),
                camera_images: self.camera_images.clone(),
                image_mask_scope: None,
                calibration_groups: Vec::new(),
                device: ColmapComputeDevice::Cpu,
                pair_selection: ColmapPairSelection::Exhaustive,
                mapping_store: MappingFeatureStore::Aliked,
                aliked_variant: AlikedModelVariant::N16Rot,
                large_matching_backend: LargeMatchingBackend::Disabled,
                aliked_max_features: 4_096,
                sift_max_features: 8_192,
                sift_rescue_only: false,
                max_image_size: 3_200,
                extraction_tiling: None,
                memory_envelope_bytes: 16 * GIB,
                extraction_memory_unit_bytes: 4 * GIB,
                logical_cpus: 8,
                feature_worker_threads: 1,
                aliked_matching_worker_threads: 1,
                matching_worker_threads: 1,
                degradations: Vec::new(),
                products: ColmapProductRequest::default(),
                intrinsics_refinement: ColmapIntrinsicsRefinement::Refine,
                pinned_calibration_group_ids: Vec::new(),
            }
        }

        fn replace_sources_with_tiling_images(&mut self) {
            for (index, camera) in self.camera_images.iter_mut().enumerate() {
                let pixels = image::RgbImage::from_fn(2_048, 1_024, |x, y| {
                    image::Rgb([
                        u8::try_from((x + index as u32) % 251).expect("red channel"),
                        u8::try_from(y % 241).expect("green channel"),
                        u8::try_from((x + y) % 239).expect("blue channel"),
                    ])
                });
                let mut bytes = Vec::new();
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 90)
                    .encode_image(&image::DynamicImage::ImageRgb8(pixels))
                    .expect("encode tiling test JPEG");
                let source_object_hash = write_project_object(&self.project, &bytes);
                let inspected = &mut camera.metadata.inspected_photo;
                inspected.byte_size = u64::try_from(bytes.len()).expect("JPEG size fits u64");
                inspected.sha256 = source_object_hash.clone();
                inspected.metadata.exif.dimensions = Some(ImageDimensions {
                    width_pixels: 2_048,
                    height_pixels: 1_024,
                });
                camera.metadata.source_object_hash = source_object_hash;
                let metadata_bytes =
                    serde_json::to_vec(&camera.metadata).expect("serialize tiling camera metadata");
                camera.metadata_object_hash = write_project_object(&self.project, &metadata_bytes);
            }
        }
    }

    #[test]
    fn dji_calibration_is_seeded_per_consistent_camera_group() {
        let mut rig = TestRig::new("dji-calibration", false, false);
        for camera in &mut rig.camera_images {
            let metadata = &mut camera.metadata.inspected_photo.metadata;
            metadata.exif.dimensions = Some(ImageDimensions {
                width_pixels: 5_280,
                height_pixels: 3_956,
            });
            metadata.dji_xmp.calibrated_focal_length_pixels = Some(3_710.25);
            metadata.dji_xmp.calibrated_optical_center_x_pixels = Some(2_641.5);
            metadata.dji_xmp.calibrated_optical_center_y_pixels = Some(1_977.75);
        }
        let request = rig.request("dji-calibration");
        let one_group =
            camera_extraction_groups(&request, &[PathBuf::from("a.jpg"), PathBuf::from("b.jpg")])
                .expect("one calibrated camera group");
        assert_eq!(one_group.len(), 1);
        assert_eq!(
            one_group[0].calibration,
            Some(ColmapCalibrationSeed {
                width_pixels: 5_280,
                height_pixels: 3_956,
                focal_pixels: 3_710.25,
                principal_x_pixels: 2_641.5,
                principal_y_pixels: 1_977.75,
                full_brown_calibration: None,
            })
        );
        rig.camera_images[1]
            .metadata
            .inspected_photo
            .metadata
            .dji_xmp
            .calibrated_focal_length_pixels = Some(3_720.0);
        let mixed = rig.request("mixed-calibration");
        let groups =
            camera_extraction_groups(&mixed, &[PathBuf::from("a.jpg"), PathBuf::from("b.jpg")])
                .expect("split calibrated camera groups");
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].image_names, [PathBuf::from("a.jpg")]);
        assert_eq!(groups[1].image_names, [PathBuf::from("b.jpg")]);
        assert!(groups.iter().all(|group| group.calibration.is_some()));

        rig.camera_images[1]
            .metadata
            .inspected_photo
            .metadata
            .exif
            .orientation = Some(ExifOrientation::Rotate90Clockwise);
        let fallback = camera_extraction_groups(
            &rig.request("mixed-calibrated-and-fallback"),
            &[PathBuf::from("a.jpg"), PathBuf::from("b.jpg")],
        )
        .expect("keep uncalibrated fallback group");
        assert_eq!(fallback.len(), 2);
        assert!(fallback[1].calibration.is_none());
    }

    #[test]
    fn dji_dewarp_seed_emits_exact_full_opencv_parameter_order() {
        let full = DjiBrownConradyCalibration {
            focal_x_pixels: 3713.771893164336,
            focal_y_pixels: 3713.771893164336,
            principal_x_pixels: 2660.720882112011,
            principal_y_pixels: 1961.266654297148,
            radial_distortion: [-0.107756512758, -0.000878853880, -0.015723478938],
            tangential_distortion: [0.000130474491, -0.000011293710],
            calibration_date: "2025-02-26".into(),
            provenance: himmelcad_core::photolab_images::DjiCalibrationProvenance::DewarpData,
        };
        let seed = ColmapCalibrationSeed {
            width_pixels: 5_280,
            height_pixels: 3_956,
            focal_pixels: full.focal_x_pixels,
            principal_x_pixels: full.principal_x_pixels,
            principal_y_pixels: full.principal_y_pixels,
            full_brown_calibration: Some(full),
        };

        let (model, params) = colmap_camera_model_and_params(&seed);
        assert_eq!(model, "FULL_OPENCV");
        assert_eq!(
            params,
            "3713.771893164336,3713.771893164336,2660.720882112011,1961.266654297148,-0.107756512758,-0.000878853880,0.000130474491,-0.000011293710,-0.015723478938,0,0,0"
        );
    }

    #[test]
    fn mapper_intrinsics_flags_are_explicit_for_every_profile_policy() {
        let args_for = |command, policy| {
            mapper_args(
                Path::new("database.db"),
                Path::new("images"),
                Path::new("sparse"),
                command,
                policy,
            )
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
        };
        let assert_flags = |args: &[String], prefix: &str, expected: [&str; 3]| {
            for (name, value) in [
                ("ba_refine_focal_length", expected[0]),
                ("ba_refine_principal_point", expected[1]),
                ("ba_refine_extra_params", expected[2]),
            ] {
                let key = format!("--{prefix}.{name}");
                let index = args
                    .iter()
                    .position(|arg| arg == &key)
                    .expect("mapper flag");
                assert_eq!(args[index + 1], value);
            }
        };

        assert_flags(
            &args_for(
                ColmapCommandKind::Mapper,
                ColmapIntrinsicsRefinement::FreezeReliableEmbedded,
            ),
            "Mapper",
            ["0", "0", "0"],
        );
        assert_flags(
            &args_for(
                ColmapCommandKind::GlobalMapper,
                ColmapIntrinsicsRefinement::FreezeReliableEmbedded,
            ),
            "GlobalMapper",
            ["0", "0", "0"],
        );
        assert_flags(
            &args_for(
                ColmapCommandKind::Mapper,
                ColmapIntrinsicsRefinement::Refine,
            ),
            "Mapper",
            ["1", "0", "1"],
        );
    }

    #[test]
    fn explicit_autofocus_groups_never_collapse_when_seeds_match() {
        let rig = TestRig::new("explicit-calibration-groups", false, false);
        let mut request = rig.request("explicit-calibration-groups-job");
        let seed = ColmapCalibrationSeed {
            width_pixels: 5_280,
            height_pixels: 3_956,
            focal_pixels: 4_100.0,
            principal_x_pixels: 2_640.0,
            principal_y_pixels: 1_978.0,
            full_brown_calibration: None,
        };
        request.calibration_groups = vec![
            ColmapCalibrationGroup {
                group_id: "flight-one".into(),
                camera_entity_ids: vec!["camera-a".into()],
                seed: Some(seed.clone()),
            },
            ColmapCalibrationGroup {
                group_id: "flight-two".into(),
                camera_entity_ids: vec!["camera-b".into()],
                seed: Some(seed),
            },
        ];
        request.validate().expect("valid explicit partition");
        let groups =
            camera_extraction_groups(&request, &[PathBuf::from("a.jpg"), PathBuf::from("b.jpg")])
                .expect("explicit extraction groups");
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].calibration, groups[1].calibration);
        assert_eq!(
            shared_group_calibration(&groups),
            groups[0].calibration.as_ref()
        );

        let mut distinct = groups;
        distinct[1].calibration = Some(ColmapCalibrationSeed {
            width_pixels: 5_280,
            height_pixels: 3_956,
            focal_pixels: 4_200.0,
            principal_x_pixels: 2_640.0,
            principal_y_pixels: 1_978.0,
            full_brown_calibration: None,
        });
        assert_eq!(shared_group_calibration(&distinct), None);
    }

    fn fake_colmap_script(fail_global: bool, slow_patch_match: bool) -> String {
        let fail_global = u8::from(fail_global);
        let slow_patch_match = u8::from(slow_patch_match);
        format!(
            r#"#!/bin/sh
cmd="$1"
shift
{{
  printf 'CMD|%s' "$cmd"
  for arg in "$@"; do printf '|%s' "$arg"; done
  printf '\nENV|LEAK_ME=%s|COLMAP_NO_NETWORK=%s|HOME=%s\n' "${{LEAK_ME-unset}}" "${{COLMAP_NO_NETWORK-unset}}" "${{HOME-unset}}"
}} >> "$PWD/invocations.log"
value_for() {{
  key="$1"
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "$key" ]; then shift; printf '%s' "$1"; return; fi
    shift
  done
}}
printf 'HIMMELCAD_PROGRESS 1/2\n'
case "$cmd" in
  feature_extractor)
    db="$(value_for --database_path "$@")"
    case "$db" in
      *cancel-between-tiles-job*tile-000001*) while :; do :; done ;;
      *features/aliked/tiles/*) /bin/cp "$(dirname "$0")/fake-tile.db" "$db" ;;
      *features/aliked/database.db*) /bin/cp "$(dirname "$0")/fake-bootstrap.db" "$db" ;;
      *) : > "$db" ;;
    esac
    ;;
  feature_importer)
    db="$(value_for --database_path "$@")"
    if [ ! -s "$db" ]; then /bin/cp "$(dirname "$0")/fake-bootstrap.db" "$db"; fi
    ;;
  exhaustive_matcher|sequential_matcher)
    threads="$(value_for --FeatureMatching.num_threads "$@")"
    case "$PWD" in
      *matcher-retry-ladder-job*)
        if [ "$threads" = "8" ] || [ "$threads" = "4" ]; then
          printf 'Killed\n' >&2
          exit 137
        fi
        ;;
      *matcher-refusal-job*)
        printf 'Killed\n' >&2
        exit 137
        ;;
      *matcher-cancel-retry-job*)
        if [ "$threads" = "8" ]; then
          printf 'Killed\n' >&2
          exit 137
        fi
        while :; do :; done
        ;;
    esac
    ;;
  matches_importer)
    ;;
  global_mapper)
    if [ "{fail_global}" = "1" ]; then printf 'forced global failure\n' >&2; exit 9; fi
    out="$(value_for --output_path "$@")"
    /bin/mkdir -p "$out/0"
    printf '0123456789abcdef' > "$out/0/cameras.bin"
    printf '0123456789abcdef' > "$out/0/images.bin"
    printf '0123456789abcdef' > "$out/0/points3D.bin"
    ;;
  mapper)
    db="$(value_for --database_path "$@")"
    case "$PWD:$db" in
      *sift-rescue-job*features/aliked*) printf 'forced ALIKED incremental failure\n' >&2; exit 10 ;;
    esac
    out="$(value_for --output_path "$@")"
    /bin/mkdir -p "$out/0"
    printf '0123456789abcdef' > "$out/0/cameras.bin"
    printf '0123456789abcdef' > "$out/0/images.bin"
    printf '0123456789abcdef' > "$out/0/points3D.bin"
    ;;
  model_converter)
    input="$(value_for --input_path "$@")"
    out="$(value_for --output_path "$@")"
    /bin/mkdir -p "$out"
    if [ -f "$input/cameras.txt" ]; then
      # A real converter round-trips the model it is given. Preserving it keeps the pinned
      # intrinsics observable after the mixed-policy re-adjustment.
      /bin/cp "$input/cameras.txt" "$input/images.txt" "$input/points3D.txt" "$out/"
      printf 'HIMMELCAD_PROGRESS 2/2\n'
      exit 0
    fi
    printf '# cameras\n' > "$out/cameras.txt"
    printf '# images\n' > "$out/images.txt"
    camera_id=0
    image_id=0
    group=""
    while read -r name; do
      directory="${{name%%/*}}"
      if [ "$directory" != "$group" ]; then
        group="$directory"
        camera_id=$((camera_id + 1))
        printf '%s SIMPLE_RADIAL 100 100 %s 50 50 0.01\n' \
          "$camera_id" "$((110 + camera_id))" >> "$out/cameras.txt"
      fi
      image_id=$((image_id + 1))
      printf '%s 1 0 0 0 0 0 0 %s %s\n0 0 1 1 1 2\n' \
        "$image_id" "$camera_id" "$name" >> "$out/images.txt"
    done < "$PWD/image-list.txt"
    printf '# points\n' > "$out/points3D.txt"
    case "$input" in
      *dedode-v2-g/global*)
        printf '1 0 0 0 255 255 255 0.5 1 0 2 0\n2 1 1 1 255 255 255 0.5 1 1 2 1\n' >> "$out/points3D.txt"
        ;;
      *)
        printf '1 0 0 0 255 255 255 1.0 1 0 2 0\n' >> "$out/points3D.txt"
        ;;
    esac
    ;;
  bundle_adjuster)
    input="$(value_for --input_path "$@")"
    out="$(value_for --output_path "$@")"
    /bin/mkdir -p "$out"
    # Refinement is disabled for every intrinsic, so the adjuster returns the model unchanged.
    /bin/cp "$input/cameras.txt" "$input/images.txt" "$input/points3D.txt" "$out/"
    ;;
  image_undistorter)
    out="$(value_for --output_path "$@")"
    /bin/mkdir -p "$out/stereo/depth_maps"
    ;;
  patch_match_stereo)
    workspace="$(value_for --workspace_path "$@")"
    if [ "{slow_patch_match}" = "1" ]; then while :; do :; done; fi
    /bin/mkdir -p "$workspace/stereo/depth_maps"
    printf 'depth' > "$workspace/stereo/depth_maps/a.jpg.geometric.bin"
    ;;
  stereo_fusion|delaunay_mesher)
    out="$(value_for --output_path "$@")"
    printf '%s' "$cmd" > "$out"
    ;;
  poisson_mesher)
    case "$PWD" in *poisson-cancel*) while :; do :; done ;; esac
    out="$(value_for --output_path "$@")"
    printf 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n' > "$out"
    ;;
  mesh_texturer)
    out="$(value_for --output_path "$@")"
    /bin/mkdir -p "$out"
    printf 'texture' > "$out/texture.png"
    ;;
esac
printf 'HIMMELCAD_PROGRESS 2/2\n'
"#
        )
    }

    async fn run_successfully(
        runtime: ColmapRuntime,
        request: ColmapRunRequest,
    ) -> ColmapRunOutcome {
        run_successfully_with_dedode(runtime, request, None).await
    }

    async fn run_successfully_with_dedode(
        runtime: ColmapRuntime,
        request: ColmapRunRequest,
        dedode: Option<DedodeRunOutcome>,
    ) -> ColmapRunOutcome {
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("create job manager");
        let job_id = PhotolabJobId(request.job_id.clone());
        let new_job = NewPhotolabJob {
            id: job_id.clone(),
            kind: PhotolabJobKind::AlignPhotos,
            config_hash: ObjectHash::of_bytes(b"config"),
            input_hash: ObjectHash::of_bytes(b"input"),
            progress: request.progress_plan().initial_progress(),
        };
        let (sender, receiver) = std_mpsc::sync_channel(1);
        manager
            .start(new_job, move |context| {
                let result = match &dedode {
                    Some(dedode) => runtime.run_with_dedode(&request, dedode, &context),
                    None => runtime.run(&request, &context),
                };
                match result {
                    Ok(outcome) => {
                        sender.send(outcome).expect("send successful outcome");
                        Ok(())
                    }
                    Err(error) => Err(error.into()),
                }
            })
            .await
            .expect("start fake COLMAP job");
        let terminal = manager
            .wait_for_terminal(&job_id)
            .await
            .expect("wait for fake COLMAP job");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        receiver.recv().expect("receive successful outcome")
    }

    async fn run_to_terminal(runtime: ColmapRuntime, request: ColmapRunRequest) -> PhotolabJob {
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("create job manager");
        let job_id = PhotolabJobId(request.job_id.clone());
        manager
            .start(
                NewPhotolabJob {
                    id: job_id.clone(),
                    kind: PhotolabJobKind::AlignPhotos,
                    config_hash: ObjectHash::of_bytes(b"config"),
                    input_hash: ObjectHash::of_bytes(b"input"),
                    progress: request.progress_plan().initial_progress(),
                },
                move |context| runtime.run_as_job(&request, &context),
            )
            .await
            .expect("start fake COLMAP job");
        manager
            .wait_for_terminal(&job_id)
            .await
            .expect("wait for fake COLMAP job")
    }

    #[test]
    fn preflight_rejects_a_hash_invalid_local_model() {
        let rig = TestRig::new("bad-model", false, false);
        fs::write(rig.tool_root.join("models/aliked-n16rot.onnx"), b"tampered")
            .expect("tamper model");
        let error = ColmapRuntime::preflight(&rig.config, &TestSignatureVerifier)
            .expect_err("tampered model must fail preflight");
        assert!(matches!(error, ColmapRuntimeError::HashMismatch { .. }));
    }

    #[test]
    fn preflight_rejects_an_invalid_detached_signature() {
        let rig = TestRig::new("bad-signature", false, false);
        fs::write(&rig.config.detached_signature_path, b"invalid").expect("tamper signature");
        let error = ColmapRuntime::preflight(&rig.config, &TestSignatureVerifier)
            .expect_err("invalid signature must fail preflight");
        assert!(matches!(error, ColmapRuntimeError::SignatureRejected(_)));
    }

    #[test]
    fn writes_only_complete_finite_projected_camera_references() {
        let rig = TestRig::new("projected-references", false, false);
        let mut cameras = rig.camera_images.clone();
        let mut third = cameras[0].clone();
        third.entity_id = EntityId("camera-c".into());
        cameras.push(third);
        for (index, camera) in cameras.iter_mut().enumerate() {
            camera.metadata.projected_reference = Some(ProjectedPhotoReference {
                source_latitude_degrees: 48.0,
                source_longitude_degrees: 11.0,
                source_height_meters: Some(500.0),
                easting: 500_000.0 + index as f64,
                northing: 5_300_000.0 + index as f64,
                transformed_height_meters: Some(450.0 + index as f64),
                transformation_decision_sha256: ObjectHash::of_bytes(b"transform"),
            });
        }
        let names = [
            "00000000/image.jpg",
            "00000001/image.jpg",
            "00000002/image.jpg",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
        let path = rig.project.join("references.txt");
        write_projected_camera_references(&path, &cameras, &names).expect("write references");
        let contents = fs::read_to_string(path).expect("read references");
        assert_eq!(contents.lines().count(), 3);
        assert!(contents.contains("00000000/image.jpg 500000.00000000000000000"));
        assert!(contents.contains("5300000.00000000000000000 450.00000000000000000"));
    }

    #[tokio::test]
    async fn runs_independent_verified_stores_with_an_offline_environment() {
        let rig = TestRig::new("stores", false, false);
        let outcome = run_successfully(rig.runtime(), rig.request("stores-job")).await;
        assert_eq!(outcome.summary.selected_mapper, SelectedMapper::Global);
        assert_eq!(outcome.summary.artifacts.len(), 4);
        let sparse_cloud = outcome
            .summary
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == ColmapArtifactKind::SparsePointCloud)
            .expect("sparse point-cloud source");
        assert_eq!(
            sparse_cloud.relative_path,
            PathBuf::from("sparse-view-source/points3D.txt")
        );
        assert_eq!(
            hash_file(&outcome.summary_path, None).expect("hash summary"),
            outcome.summary_sha256
        );
        let invocations = fs::read_to_string(outcome.scratch_path.join("invocations.log"))
            .expect("read invocation log");
        assert!(invocations.contains("--FeatureExtraction.type|ALIKED_N16ROT"));
        assert!(invocations.contains("--FeatureMatching.type|ALIKED_LIGHTGLUE"));
        assert!(invocations.contains("--FeatureMatching.type|SIFT_BRUTEFORCE"));
        assert_eq!(invocations.matches("CMD|geometric_verifier").count(), 2);
        assert!(invocations.contains("features/aliked/database.db"));
        assert!(invocations.contains("features/sift/database.db"));
        assert!(invocations.contains("ENV|LEAK_ME=unset|COLMAP_NO_NETWORK=1"));
        assert!(!invocations.contains("https://"));
        assert!(outcome
            .scratch_path
            .join("images/00000000/image.jpg")
            .is_file());
        assert!(outcome
            .scratch_path
            .join("images/00000001/image.jpg")
            .is_file());
    }

    #[tokio::test]
    async fn fast_profile_skips_sift_when_aliked_mapping_succeeds() {
        let rig = TestRig::new("fast-aliked", false, false);
        let mut request = rig.request("fast-aliked-job");
        request.sift_rescue_only = true;
        let outcome = run_successfully(rig.runtime(), request).await;
        assert_eq!(
            outcome.summary.selected_feature_store,
            SelectedFeatureStore::Aliked
        );
        assert!(!outcome
            .scratch_path
            .join("features/sift/database.db")
            .is_file());
        let invocations = fs::read_to_string(outcome.scratch_path.join("invocations.log"))
            .expect("read invocation log");
        assert!(!invocations.contains("--FeatureMatching.type|SIFT_BRUTEFORCE"));
    }

    #[tokio::test]
    async fn fast_profile_can_use_classical_sift_before_neural_rescue() {
        let rig = TestRig::new("fast-sift", false, false);
        let mut request = rig.request("fast-sift-job");
        request.mapping_store = MappingFeatureStore::Sift;
        request.sift_rescue_only = true;

        let outcome = run_successfully(rig.runtime(), request).await;
        assert_eq!(
            outcome.summary.selected_feature_store,
            SelectedFeatureStore::Sift
        );
        let invocations = fs::read_to_string(outcome.scratch_path.join("invocations.log"))
            .expect("read invocation log");
        assert!(invocations.contains("--FeatureExtraction.type|SIFT"));
        assert!(invocations.contains("--FeatureMatching.type|SIFT_BRUTEFORCE"));
        assert!(!invocations.contains("ALIKED_N16ROT"));
        assert!(!invocations.contains("ALIKED_LIGHTGLUE"));
    }

    #[tokio::test]
    async fn feature_extraction_batches_distinct_calibration_groups() {
        let rig = TestRig::new("batched-calibration-groups", false, false);
        let mut request = rig.request("batched-calibration-groups-job");
        request.sift_rescue_only = true;
        let seed = ColmapCalibrationSeed {
            width_pixels: 100,
            height_pixels: 100,
            focal_pixels: 80.0,
            principal_x_pixels: 50.0,
            principal_y_pixels: 50.0,
            full_brown_calibration: None,
        };
        request.calibration_groups = vec![
            ColmapCalibrationGroup {
                group_id: "focus-two".into(),
                camera_entity_ids: vec!["camera-b".into()],
                seed: Some(seed.clone()),
            },
            ColmapCalibrationGroup {
                group_id: "focus-one".into(),
                camera_entity_ids: vec!["camera-a".into()],
                seed: Some(seed),
            },
        ];

        let outcome = run_successfully(rig.runtime(), request).await;
        let invocations = fs::read_to_string(outcome.scratch_path.join("invocations.log"))
            .expect("read invocation log");
        assert_eq!(invocations.matches("CMD|feature_extractor").count(), 2);
        assert!(invocations.contains("--ImageReader.single_camera|1"));
        assert!(invocations.contains(
            "--ImageReader.camera_params|80.000000000000,50.000000000000,50.000000000000,0"
        ));
        assert!(outcome
            .scratch_path
            .join("images/calibration-000000/image-00000000.jpg")
            .is_file());
        assert!(outcome
            .scratch_path
            .join("images/calibration-000001/image-00000001.jpg")
            .is_file());
    }

    #[tokio::test]
    async fn feature_and_mapper_commands_preserve_embedded_full_opencv_calibration() {
        let rig = TestRig::new("full-opencv-command", false, false);
        let mut request = rig.request("full-opencv-command-job");
        request.sift_rescue_only = true;
        request.intrinsics_refinement = ColmapIntrinsicsRefinement::FreezeReliableEmbedded;
        let full = DjiBrownConradyCalibration {
            focal_x_pixels: 80.0,
            focal_y_pixels: 81.0,
            principal_x_pixels: 50.25,
            principal_y_pixels: 49.75,
            radial_distortion: [-0.1, -0.002, -0.015],
            tangential_distortion: [0.0003, -0.0004],
            calibration_date: "2025-02-26".into(),
            provenance: himmelcad_core::photolab_images::DjiCalibrationProvenance::DewarpData,
        };
        request.calibration_groups = vec![ColmapCalibrationGroup {
            group_id: "dewarp".into(),
            camera_entity_ids: vec!["camera-a".into(), "camera-b".into()],
            seed: Some(ColmapCalibrationSeed {
                width_pixels: 100,
                height_pixels: 100,
                focal_pixels: full.focal_x_pixels,
                principal_x_pixels: full.principal_x_pixels,
                principal_y_pixels: full.principal_y_pixels,
                full_brown_calibration: Some(full),
            }),
        }];

        let outcome = run_successfully(rig.runtime(), request).await;
        let invocations = fs::read_to_string(outcome.scratch_path.join("invocations.log"))
            .expect("read invocation log");
        assert!(invocations.contains("--ImageReader.camera_model|FULL_OPENCV"));
        assert!(invocations.contains(
            "--ImageReader.camera_params|80.000000000000,81.000000000000,50.250000000000,49.750000000000,-0.100000000000,-0.002000000000,0.000300000000,-0.000400000000,-0.015000000000,0,0,0"
        ));
        assert!(invocations.contains("--GlobalMapper.ba_refine_focal_length|0"));
        assert!(invocations.contains("--GlobalMapper.ba_refine_principal_point|0"));
        assert!(invocations.contains("--GlobalMapper.ba_refine_extra_params|0"));
    }

    #[tokio::test]
    async fn characterization_one_embedded_group_materializes_full_opencv_and_freezes_mapper() {
        let rig = TestRig::new("characterize-one-embedded", false, false);
        let mut request = rig.request("characterize-one-embedded-job");
        request.sift_rescue_only = true;
        request.intrinsics_refinement = ColmapIntrinsicsRefinement::FreezeReliableEmbedded;
        let full = DjiBrownConradyCalibration {
            focal_x_pixels: 80.0,
            focal_y_pixels: 81.0,
            principal_x_pixels: 50.25,
            principal_y_pixels: 49.75,
            radial_distortion: [-0.1, -0.002, -0.015],
            tangential_distortion: [0.0003, -0.0004],
            calibration_date: "2025-02-26".into(),
            provenance: himmelcad_core::photolab_images::DjiCalibrationProvenance::DewarpData,
        };
        request.calibration_groups = vec![ColmapCalibrationGroup {
            group_id: "dewarp".into(),
            camera_entity_ids: vec!["camera-a".into(), "camera-b".into()],
            seed: Some(ColmapCalibrationSeed {
                width_pixels: 100,
                height_pixels: 100,
                focal_pixels: full.focal_x_pixels,
                principal_x_pixels: full.principal_x_pixels,
                principal_y_pixels: full.principal_y_pixels,
                full_brown_calibration: Some(full),
            }),
        }];

        let outcome = run_successfully(rig.runtime(), request).await;
        let invocations = fs::read_to_string(outcome.scratch_path.join("invocations.log"))
            .expect("read invocation log");
        assert!(invocations.contains(
            "--ImageReader.camera_model|FULL_OPENCV|--ImageReader.camera_params|80.000000000000,81.000000000000,50.250000000000,49.750000000000,-0.100000000000,-0.002000000000,0.000300000000,-0.000400000000,-0.015000000000,0,0,0"
        ));
        assert!(invocations.contains(
            "--GlobalMapper.ba_refine_focal_length|0|--GlobalMapper.ba_refine_principal_point|0|--GlobalMapper.ba_refine_extra_params|0"
        ));
    }

    #[tokio::test]
    async fn characterization_one_unseeded_group_uses_default_simple_radial_and_refines_mapper() {
        let rig = TestRig::new("characterize-one-unseeded", false, false);
        let mut request = rig.request("characterize-one-unseeded-job");
        request.sift_rescue_only = true;
        request.intrinsics_refinement = ColmapIntrinsicsRefinement::Refine;
        request.calibration_groups = vec![ColmapCalibrationGroup {
            group_id: "unseeded".into(),
            camera_entity_ids: vec!["camera-a".into(), "camera-b".into()],
            seed: None,
        }];

        let outcome = run_successfully(rig.runtime(), request).await;
        let invocations = fs::read_to_string(outcome.scratch_path.join("invocations.log"))
            .expect("read invocation log");
        let extractor = invocations
            .lines()
            .find(|line| line.starts_with("CMD|feature_extractor"))
            .expect("feature extractor invocation");
        assert!(!extractor.contains("--ImageReader.camera_model"));
        assert!(!extractor.contains("--ImageReader.camera_params"));
        assert!(invocations.contains(
            "--GlobalMapper.ba_refine_focal_length|1|--GlobalMapper.ba_refine_principal_point|0|--GlobalMapper.ba_refine_extra_params|1"
        ));
    }

    #[tokio::test]
    async fn characterization_two_embedded_groups_materialize_each_seed_and_freeze_mapper() {
        let rig = TestRig::new("characterize-two-embedded", false, false);
        let mut request = rig.request("characterize-two-embedded-job");
        request.sift_rescue_only = true;
        request.intrinsics_refinement = ColmapIntrinsicsRefinement::FreezeReliableEmbedded;
        let seed = |focal_x_pixels: f64, focal_y_pixels: f64| ColmapCalibrationSeed {
            width_pixels: 100,
            height_pixels: 100,
            focal_pixels: focal_x_pixels,
            principal_x_pixels: 50.0,
            principal_y_pixels: 50.0,
            full_brown_calibration: Some(DjiBrownConradyCalibration {
                focal_x_pixels,
                focal_y_pixels,
                principal_x_pixels: 50.0,
                principal_y_pixels: 50.0,
                radial_distortion: [-0.1, -0.002, -0.015],
                tangential_distortion: [0.0003, -0.0004],
                calibration_date: "2025-02-26".into(),
                provenance: himmelcad_core::photolab_images::DjiCalibrationProvenance::DewarpData,
            }),
        };
        request.calibration_groups = vec![
            ColmapCalibrationGroup {
                group_id: "dewarp-a".into(),
                camera_entity_ids: vec!["camera-a".into()],
                seed: Some(seed(80.0, 81.0)),
            },
            ColmapCalibrationGroup {
                group_id: "dewarp-b".into(),
                camera_entity_ids: vec!["camera-b".into()],
                seed: Some(seed(90.0, 91.0)),
            },
        ];

        let outcome = run_successfully(rig.runtime(), request).await;
        let invocations = fs::read_to_string(outcome.scratch_path.join("invocations.log"))
            .expect("read invocation log");
        assert_eq!(invocations.matches("CMD|feature_extractor").count(), 2);
        assert!(invocations.contains(
            "--ImageReader.camera_model|FULL_OPENCV|--ImageReader.camera_params|80.000000000000,81.000000000000,50.000000000000,50.000000000000,-0.100000000000,-0.002000000000,0.000300000000,-0.000400000000,-0.015000000000,0,0,0"
        ));
        assert!(invocations.contains(
            "--ImageReader.camera_model|FULL_OPENCV|--ImageReader.camera_params|90.000000000000,91.000000000000,50.000000000000,50.000000000000,-0.100000000000,-0.002000000000,0.000300000000,-0.000400000000,-0.015000000000,0,0,0"
        ));
        assert!(invocations.contains(
            "--GlobalMapper.ba_refine_focal_length|0|--GlobalMapper.ba_refine_principal_point|0|--GlobalMapper.ba_refine_extra_params|0"
        ));
    }

    fn mixed_policy_request(rig: &TestRig, job_id: &str) -> ColmapRunRequest {
        let mut request = rig.request(job_id);
        request.sift_rescue_only = true;
        request.intrinsics_refinement = ColmapIntrinsicsRefinement::Refine;
        let full = DjiBrownConradyCalibration {
            focal_x_pixels: 80.0,
            focal_y_pixels: 81.0,
            principal_x_pixels: 50.25,
            principal_y_pixels: 49.75,
            radial_distortion: [-0.1, -0.002, -0.015],
            tangential_distortion: [0.0003, -0.0004],
            calibration_date: "2025-02-26".into(),
            provenance: himmelcad_core::photolab_images::DjiCalibrationProvenance::DewarpData,
        };
        request.calibration_groups = vec![
            ColmapCalibrationGroup {
                group_id: "embedded-mission".into(),
                camera_entity_ids: vec!["camera-a".into()],
                seed: Some(ColmapCalibrationSeed {
                    width_pixels: 100,
                    height_pixels: 100,
                    focal_pixels: full.focal_x_pixels,
                    principal_x_pixels: full.principal_x_pixels,
                    principal_y_pixels: full.principal_y_pixels,
                    full_brown_calibration: Some(full),
                }),
            },
            ColmapCalibrationGroup {
                group_id: "metadata-poor-mission".into(),
                camera_entity_ids: vec!["camera-b".into()],
                seed: Some(ColmapCalibrationSeed {
                    width_pixels: 100,
                    height_pixels: 100,
                    focal_pixels: 70.0,
                    principal_x_pixels: 50.0,
                    principal_y_pixels: 50.0,
                    full_brown_calibration: None,
                }),
            },
        ];
        request.pinned_calibration_group_ids = vec!["embedded-mission".into()];
        request
    }

    #[tokio::test]
    async fn mixed_policy_refines_every_group_then_restores_only_the_pinned_seed() {
        let rig = TestRig::new("mixed-intrinsics-policy", false, false);
        let request = mixed_policy_request(&rig, "mixed-intrinsics-policy-job");
        assert_eq!(
            request.intrinsics_strategy(),
            ColmapIntrinsicsStrategy::Mixed
        );
        assert!(request
            .progress_plan()
            .stages
            .iter()
            .any(|stage| stage.label == PINNED_INTRINSICS_STAGE));

        let outcome = run_successfully(rig.runtime(), request).await;
        let invocations = fs::read_to_string(outcome.scratch_path.join("invocations.log"))
            .expect("read invocation log");
        // The joint solve refines every seeded group instead of freezing the metadata-poor one.
        assert!(invocations.contains(
            "--GlobalMapper.ba_refine_focal_length|1|--GlobalMapper.ba_refine_principal_point|0|--GlobalMapper.ba_refine_extra_params|1"
        ));
        assert!(invocations.contains("CMD|bundle_adjuster|--input_path"));
        assert!(invocations.contains(
            "--BundleAdjustment.refine_focal_length|0|--BundleAdjustment.refine_principal_point|0|--BundleAdjustment.refine_extra_params|0"
        ));

        let cameras =
            fs::read_to_string(outcome.scratch_path.join("sparse-view-source/cameras.txt"))
                .expect("read exported cameras");
        // The pinned group carries its exact frozen calibration again.
        assert!(cameras.contains(
            "1 FULL_OPENCV 100 100 80.000000000000 81.000000000000 50.250000000000 49.750000000000 -0.100000000000 -0.002000000000 0.000300000000 -0.000400000000 -0.015000000000 0 0 0"
        ));
        // The refined group keeps what the solve found.
        assert!(cameras.contains("2 SIMPLE_RADIAL 100 100 112 50 50 0.01"));

        assert_eq!(
            outcome.summary.intrinsics_strategy,
            ColmapIntrinsicsStrategy::Mixed
        );
        assert_eq!(
            outcome.summary.pinned_calibration_group_ids,
            ["embedded-mission"]
        );
        let readjustment = outcome
            .summary
            .pinned_readjustment
            .expect("mixed runs record their re-adjustment");
        assert_eq!(
            readjustment.path,
            PinnedIntrinsicsReadjustmentPath::ColmapBundleAdjuster
        );
        assert_eq!(readjustment.registered_images_before, 2);
        assert_eq!(readjustment.registered_images_after, 2);
        assert_eq!(readjustment.points3d_before, readjustment.points3d_after);
        assert_eq!(
            outcome.summary.calibration_group_intrinsics,
            vec![
                CalibrationGroupIntrinsicsDelta {
                    group_id: "embedded-mission".into(),
                    pinned: true,
                    seed_focal_pixels: Some(80.0),
                    solved_focal_pixels: Some(80.0),
                    focal_delta_pixels: Some(0.0),
                },
                CalibrationGroupIntrinsicsDelta {
                    group_id: "metadata-poor-mission".into(),
                    pinned: false,
                    seed_focal_pixels: Some(70.0),
                    solved_focal_pixels: Some(112.0),
                    focal_delta_pixels: Some(42.0),
                },
            ]
        );
    }

    #[tokio::test]
    async fn a_published_alignment_hands_its_solved_intrinsics_to_the_next_solve() {
        let rig = TestRig::new("solved-seed-handoff", false, false);
        let request = mixed_policy_request(&rig, "solved-seed-handoff-job");
        let outcome = run_successfully(rig.runtime(), request).await;
        let seeds =
            solved_calibration_seeds(&outcome.scratch_path).expect("read solved intrinsics");
        assert_eq!(seeds["camera-a"].focal_pixels, 80.0);
        assert_eq!(seeds["camera-a"].principal_x_pixels, 50.25);
        // A merge seeded from this value keeps the metadata-poor block's own refinement.
        assert_eq!(seeds["camera-b"].focal_pixels, 112.0);
        assert_eq!(seeds["camera-b"].principal_x_pixels, 50.0);
    }

    #[test]
    fn a_run_needs_a_refinable_group_and_a_restorable_seed_to_be_mixed() {
        let rig = TestRig::new("mixed-intrinsics-validation", false, false);
        let request = mixed_policy_request(&rig, "mixed-intrinsics-validation-job");
        request
            .validate()
            .expect("a disagreeing partition is valid");

        let mut unknown = request.clone();
        unknown.pinned_calibration_group_ids = vec!["absent".into()];
        assert!(matches!(
            unknown.validate(),
            Err(ColmapRuntimeError::InvalidRequest(_))
        ));

        let mut every_group = request.clone();
        every_group.pinned_calibration_group_ids =
            vec!["embedded-mission".into(), "metadata-poor-mission".into()];
        assert!(matches!(
            every_group.validate(),
            Err(ColmapRuntimeError::InvalidRequest(_))
        ));

        let mut unseeded = request.clone();
        unseeded.calibration_groups[0].seed = None;
        assert!(matches!(
            unseeded.validate(),
            Err(ColmapRuntimeError::InvalidRequest(_))
        ));

        let mut frozen_mapper = request;
        frozen_mapper.intrinsics_refinement = ColmapIntrinsicsRefinement::FreezeReliableEmbedded;
        assert!(matches!(
            frozen_mapper.validate(),
            Err(ColmapRuntimeError::InvalidRequest(_))
        ));
    }

    #[test]
    fn a_collapsed_readjustment_fails_the_job_instead_of_publishing() {
        let before = SparseModelStatistics {
            registered_images: 100,
            points3d: 1_000,
            observations: 5_000,
            mean_reprojection_error: Some(0.9),
        };
        check_pinned_readjustment_consistency(before, before).expect("an unchanged model is sound");
        check_pinned_readjustment_consistency(
            before,
            SparseModelStatistics {
                points3d: 900,
                ..before
            },
        )
        .expect("the tolerated triangulation loss stays inside the bound");

        let lost_image = check_pinned_readjustment_consistency(
            before,
            SparseModelStatistics {
                registered_images: 99,
                ..before
            },
        )
        .expect_err("losing a registered image fails the job");
        assert!(lost_image.to_string().contains("intrinsics policy"));
        let lost_points = check_pinned_readjustment_consistency(
            before,
            SparseModelStatistics {
                points3d: 899,
                ..before
            },
        )
        .expect_err("collapsing the triangulation fails the job");
        assert!(lost_points.to_string().contains("retention bound"));
    }

    #[tokio::test]
    async fn one_automatic_calibration_group_keeps_source_sequence() {
        let rig = TestRig::new("automatic-calibration-order", false, false);
        let mut request = rig.request("automatic-calibration-order-job");
        request.sift_rescue_only = true;
        request.calibration_groups = vec![ColmapCalibrationGroup {
            group_id: "automatic-mission".into(),
            // Domain records are immutable sets and need not arrive in capture order.
            camera_entity_ids: vec!["camera-b".into(), "camera-a".into()],
            seed: None,
        }];

        let outcome = run_successfully(rig.runtime(), request).await;
        let image_list = fs::read_to_string(outcome.scratch_path.join("image-list.txt"))
            .expect("read source-ordered image list");
        assert_eq!(
            image_list.lines().collect::<Vec<_>>(),
            [
                "calibration-000000/image-00000000.jpg",
                "calibration-000000/image-00000001.jpg"
            ]
        );
        assert!(outcome
            .scratch_path
            .join("images/calibration-000000/image-00000000.jpg")
            .is_file());
        assert!(outcome
            .scratch_path
            .join("images/calibration-000000/image-00000001.jpg")
            .is_file());
    }

    #[tokio::test]
    async fn fast_profile_runs_sift_after_aliked_mapping_failure() {
        let rig = TestRig::new("sift-rescue", true, false);
        let mut request = rig.request("sift-rescue-job");
        request.sift_rescue_only = true;
        let outcome = run_successfully(rig.runtime(), request).await;
        assert_eq!(
            outcome.summary.selected_feature_store,
            SelectedFeatureStore::Sift
        );
        let invocations = fs::read_to_string(outcome.scratch_path.join("invocations.log"))
            .expect("read invocation log");
        assert!(invocations.contains("--FeatureMatching.type|SIFT_BRUTEFORCE"));
        assert!(invocations.contains("features/sift/database.db"));
    }

    #[tokio::test]
    async fn tiled_aliked_extraction_merges_into_original_images_deterministically() {
        let mut rig = TestRig::new("tiled-aliked", false, false);
        rig.replace_sources_with_tiling_images();
        let runtime = rig.runtime();
        let mut request = rig.request("tiled-aliked-first");
        request.sift_rescue_only = true;
        request.max_image_size = 2_048;
        let cap = 2;
        request.aliked_max_features = cap;
        request.extraction_tiling = Some(AlignmentExtractionTiling {
            columns: 2,
            rows: 1,
            tiles: 2,
            overlap_px: 256,
        });
        let first = run_successfully(runtime.clone(), request.clone()).await;
        assert_eq!(
            first.summary.extraction_tiled,
            Some(ColmapExtractionTiled {
                tiles: 2,
                overlap_px: 256,
            })
        );
        let database = first.scratch_path.join("features/aliked/database.db");
        for image_name in [
            "calibration-000000/image-00000000.jpg",
            "calibration-000000/image-00000001.jpg",
        ] {
            let features = read_image_features(&database, image_name).expect("merged features");
            let ColmapKeypointMatrix::Affine(keypoints) = features.keypoints else {
                panic!("tiled ALIKED must write affine keypoints");
            };
            assert_eq!(
                keypoints.len(),
                usize::try_from(cap).expect("cap fits usize")
            );
            assert_eq!(
                keypoints
                    .iter()
                    .map(|keypoint| (keypoint[0], keypoint[1]))
                    .collect::<Vec<_>>(),
                [(104.0, 50.0), (1_000.0, 50.0)]
            );
            assert!(matches!(
                features.descriptors,
                ColmapDescriptorMatrix::AlikedN16RotF32(ref rows) if rows.len() == usize::try_from(cap).expect("cap fits usize")
            ));
        }
        let first_database_sha256 = hash_file(&database, None).expect("hash first database");
        let invocations = fs::read_to_string(first.scratch_path.join("invocations.log"))
            .expect("read tiled invocations");
        assert_eq!(invocations.matches("CMD|feature_extractor").count(), 4);
        assert_eq!(invocations.matches("CMD|feature_importer").count(), 1);

        fs::remove_dir_all(rig.project.join(".photolab/cache"))
            .expect("clear test-only feature cache");
        request.job_id = "tiled-aliked-second".into();
        let second = run_successfully(runtime, request).await;
        assert_eq!(
            hash_file(
                &second.scratch_path.join("features/aliked/database.db"),
                None
            )
            .expect("hash second database"),
            first_database_sha256
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn cgroup_worker_command_uses_the_resident_limit_and_disables_swap() {
        let plan = WorkerMemoryLimitPlan {
            mode: WorkerMemoryLimitMode::CgroupScope,
            enforced_limit_bytes: 4_294_967_296,
        };
        let command = worker_command_for_plan(
            Path::new("/usr/bin/systemd-run"),
            Path::new("/opt/himmelcad/colmap"),
            plan,
        );
        assert_eq!(command.get_program(), OsStr::new("/usr/bin/systemd-run"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "--user",
                "--scope",
                "--quiet",
                "-p",
                "MemoryMax=4294967296",
                "-p",
                "MemorySwapMax=0",
                "--collect",
                "--",
                "/usr/bin/prlimit",
                "--core=0",
                "--",
                "/opt/himmelcad/colmap",
            ]
            .map(OsStr::new)
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn systemd_user_scope_probe_uses_a_viable_limit_and_disables_swap() {
        let command = systemd_user_scope_probe_command(Path::new("/usr/bin/systemd-run"));
        assert_eq!(command.get_program(), OsStr::new("/usr/bin/systemd-run"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                "--user",
                "--scope",
                "--quiet",
                "-p",
                "MemoryMax=64M",
                "-p",
                "MemorySwapMax=0",
                "--collect",
                "--",
                "/usr/bin/prlimit",
                "--core=0",
                "--",
                "/bin/true",
            ]
            .map(OsStr::new)
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn systemd_user_runtime_fallback_uses_the_effective_uid() {
        assert_eq!(
            effective_uid_from_proc_status("Name:\ttest\nUid:\t1000\t2000\t3000\t4000\n"),
            Some(2000)
        );
    }

    fn print_probe_outcome(label: &str, outcome: &io::Result<std::process::Output>) {
        match outcome {
            Ok(output) => {
                println!("{label}_status={}", output.status);
                println!(
                    "{label}_stdout_begin\n{}{label}_stdout_end",
                    String::from_utf8_lossy(&output.stdout)
                );
                println!(
                    "{label}_stderr_begin\n{}{label}_stderr_end",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            Err(error) => println!("{label}_spawn_error={error}"),
        }
    }

    #[test]
    #[ignore = "operational diagnostic; requires a systemd user manager"]
    #[cfg(target_os = "linux")]
    fn systemd_user_scope_probe_diagnostic() {
        let Some(executable) = find_in_path("systemd-run") else {
            println!("probe_skipped=systemd-run was not found in PATH or standard system paths");
            return;
        };
        let outcome = run_systemd_user_scope_probe(&executable);
        print_probe_outcome("probe", &outcome);
    }

    #[test]
    #[ignore = "operational regression; requires a systemd user manager"]
    #[cfg(target_os = "linux")]
    fn worker_scope_inside_unit() {
        const CHILD_MARKER: &str = "HIMMELCAD_PHOTOLAB_WORKER_SCOPE_TEST_CHILD";

        if std::env::var(CHILD_MARKER).as_deref() == Ok("1") {
            let executable = find_in_path("systemd-run")
                .expect("systemd-run disappeared after the parent started the transient unit");
            let probe = run_systemd_user_scope_probe(&executable);
            print_probe_outcome("inside_unit_probe", &probe);
            assert!(
                probe.as_ref().is_ok_and(|output| output.status.success()),
                "the exact worker-scope probe failed inside the transient user unit"
            );

            let scratch = TestDirectory(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../.build/codex-scratch/a7g")
                    .join(format!("worker-scope-inside-unit-{}", std::process::id())),
            );
            let spec = CommandSpec {
                kind: ColmapCommandKind::MatchesImporter,
                stage_label: "Import matches",
                args: Vec::new(),
            };
            let limit_bytes = 2 * GIB;
            let (mut child, plan) =
                spawn_colmap_child(Path::new("/bin/true"), &spec, &scratch.0, Some(limit_bytes))
                    .expect("spawn cgroup-scoped fake COLMAP inside user unit");
            assert_eq!(
                plan,
                Some(WorkerMemoryLimitPlan {
                    mode: WorkerMemoryLimitMode::CgroupScope,
                    enforced_limit_bytes: limit_bytes,
                })
            );
            let outcome = supervise_child(&mut child, &CancellationToken::new(), |_, _| {})
                .expect("supervise cgroup-scoped fake COLMAP inside user unit");
            assert!(outcome.status.success(), "{:?}", outcome.log_tail);
            println!("inside_unit_worker_memory_limit_mode=cgroupScope");
            return;
        }

        let Some(systemd_run) = find_in_path("systemd-run") else {
            println!("skipped: systemd-run was not found in PATH or standard system paths");
            return;
        };
        let current_exe = std::env::current_exe().expect("resolve current test executable");
        let mut command = Command::new(systemd_run);
        command
            .arg("--user")
            .arg("--wait")
            .arg("--pipe")
            .arg("--collect")
            .arg("--quiet")
            .arg("-p")
            .arg("MemoryMax=2G")
            .arg("-p")
            .arg("MemorySwapMax=0")
            .arg(format!("--setenv={CHILD_MARKER}=1"))
            .arg("--")
            .arg(current_exe)
            .arg("--exact")
            .arg("colmap_runtime::tests::worker_scope_inside_unit")
            .arg("--ignored")
            .arg("--nocapture");
        configure_systemd_user_bus_environment(&mut command);
        let outcome = command.output();
        print_probe_outcome("outer_unit", &outcome);
        assert!(
            outcome.as_ref().is_ok_and(|output| output.status.success()),
            "systemd-run exists but failed to execute the in-unit worker-scope regression"
        );
    }

    #[test]
    fn matching_retry_cleanup_removes_only_pairwise_matches() {
        let directory = TestDirectory::new("matching-retry-cleanup");
        write_fake_feature_databases(&directory.0);
        let database = directory.0.join("fake-bootstrap.db");
        let before = read_image_features(&database, "calibration-000000/image-00000000.jpg")
            .expect("read features before cleanup");
        let connection = rusqlite::Connection::open(&database).expect("open fake database");
        connection
            .execute(
                "INSERT INTO matches(pair_id, rows, cols, data) VALUES (1, 1, 2, X'00000000')",
                [],
            )
            .expect("insert partial match");
        connection
            .execute(
                "INSERT INTO two_view_geometries(pair_id, rows, cols, data) VALUES (1, 1, 2, X'00000000')",
                [],
            )
            .expect("insert verified geometry sentinel");
        drop(connection);

        clear_partial_matching_output(&database).expect("clear partial matcher output");

        let connection = rusqlite::Connection::open(&database).expect("reopen fake database");
        let match_count = connection
            .query_row("SELECT COUNT(*) FROM matches", [], |row| {
                row.get::<_, u64>(0)
            })
            .expect("count matches");
        let geometry_count = connection
            .query_row("SELECT COUNT(*) FROM two_view_geometries", [], |row| {
                row.get::<_, u64>(0)
            })
            .expect("count geometries");
        assert_eq!(match_count, 0);
        assert_eq!(geometry_count, 1);
        assert_eq!(
            read_image_features(&database, "calibration-000000/image-00000000.jpg")
                .expect("read features after cleanup"),
            before
        );
    }

    #[tokio::test]
    async fn matching_memory_kills_halve_threads_until_the_attempt_succeeds() {
        let rig = TestRig::new("matcher-retry-ladder", false, false);
        let terminal =
            run_to_terminal(rig.runtime(), rig.request("matcher-retry-ladder-job")).await;
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        let halvings = terminal
            .memory
            .degradations
            .iter()
            .filter_map(|degradation| match degradation {
                PhotolabMemoryDegradation::MatchingThreadsHalved { from, to, .. } => {
                    Some((*from, *to))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(halvings, [(8, 4), (4, 2)]);
        let stage = terminal
            .memory
            .stages
            .iter()
            .find(|stage| stage.stage == "Match ALIKED with LightGlue")
            .expect("matching stage memory");
        assert_eq!(stage.workers, 2);
        let attempts = stage.parameters["attempts"]
            .as_array()
            .expect("matching attempts");
        assert_eq!(attempts.len(), 3);
        assert_eq!(attempts[0]["threads"], 8);
        assert_eq!(attempts[0]["outcome"], "workerMemoryLimit");
        assert_eq!(attempts[1]["threads"], 4);
        assert_eq!(attempts[1]["outcome"], "workerMemoryLimit");
        assert_eq!(attempts[2]["threads"], 2);
        assert_eq!(attempts[2]["outcome"], "completed");
        assert!(stage.parameters.get("observedBytesPerThread").is_some());
        assert!(stage.parameters.get("modelBytesPerThread").is_some());
    }

    #[tokio::test]
    async fn matching_memory_kill_at_one_thread_returns_the_typed_refusal() {
        let rig = TestRig::new("matcher-refusal", false, false);
        let terminal = run_to_terminal(rig.runtime(), rig.request("matcher-refusal-job")).await;
        assert!(matches!(
            terminal.state,
            PhotolabJobState::Failed { ref code, ref message }
                if code == "insufficientMemory"
                    && message == "alignment needs more memory than this machine has for matching"
        ));
        let stage = terminal
            .memory
            .stages
            .iter()
            .find(|stage| stage.stage == "Match ALIKED with LightGlue")
            .expect("matching stage memory");
        assert_eq!(
            stage.parameters["attempts"]
                .as_array()
                .expect("matching attempts")
                .len(),
            4
        );
    }

    #[tokio::test]
    async fn cancellation_interrupts_an_active_matching_retry_within_one_poll_interval() {
        let _timing_guard = crate::CANCELLATION_TIMING_TEST_LOCK
            .lock()
            .expect("cancellation timing test lock");
        let rig = TestRig::new("matcher-cancel-retry", false, false);
        let runtime = rig.runtime();
        let request = rig.request("matcher-cancel-retry-job");
        let scratch_root = rig.config.scratch_root.clone();
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("create job manager");
        let job_id = PhotolabJobId(request.job_id.clone());
        manager
            .start(
                NewPhotolabJob {
                    id: job_id.clone(),
                    kind: PhotolabJobKind::AlignPhotos,
                    config_hash: ObjectHash::of_bytes(b"config"),
                    input_hash: ObjectHash::of_bytes(b"input"),
                    progress: request.progress_plan().initial_progress(),
                },
                move |context| runtime.run_as_job(&request, &context),
            )
            .await
            .expect("start cancellable matcher job");
        wait_for_invocation(&scratch_root, "--FeatureMatching.num_threads|4").await;
        let started = Instant::now();
        manager.cancel(&job_id).await.expect("request cancellation");
        let terminal = manager
            .wait_for_terminal(&job_id)
            .await
            .expect("wait for cancellation");
        assert_eq!(terminal.state, PhotolabJobState::Cancelled);
        assert!(started.elapsed() <= CANCEL_POLL_INTERVAL.saturating_mul(4));
    }

    #[test]
    #[cfg(unix)]
    fn cgroup_killed_diagnostic_maps_to_the_typed_memory_error() {
        use std::os::unix::process::ExitStatusExt;

        let outcome = ProcessOutcome {
            status: ExitStatus::from_raw(1 << 8),
            log_tail: vec!["Killed".into()],
        };
        assert!(matches!(
            worker_memory_limit_error("Match ALIKED with LightGlue", 4 * GIB, 123, &outcome),
            Some(ColmapRuntimeError::WorkerMemoryLimitHit {
                ref stage,
                limit_bytes,
                limit_gb: 4,
                observed_peak_bytes: 123,
            }) if stage == "Match ALIKED with LightGlue" && limit_bytes == 4 * GIB
        ));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn fake_colmap_runs_in_a_cgroup_scope_when_the_probe_passes() {
        let Some(_) = systemd_user_scope() else {
            eprintln!(
                "skipped: systemd-run --user scope is unavailable; cgroup worker mode cannot be exercised"
            );
            return;
        };
        let rig = TestRig::new("worker-cgroup", false, false);
        let scratch = rig.config.scratch_root.join("worker-cgroup-direct");
        let spec = CommandSpec {
            kind: ColmapCommandKind::MatchesImporter,
            stage_label: "Import matches",
            args: Vec::new(),
        };
        let limit_bytes = worker_memory_limit_bytes(512 * 1024 * 1024, 1);
        let (mut child, plan) = spawn_colmap_child(
            &rig.tool_root.join("colmap"),
            &spec,
            &scratch,
            Some(limit_bytes),
        )
        .expect("spawn cgroup-scoped fake COLMAP");
        assert_eq!(
            plan,
            Some(WorkerMemoryLimitPlan {
                mode: WorkerMemoryLimitMode::CgroupScope,
                enforced_limit_bytes: limit_bytes,
            })
        );
        let outcome = supervise_child(&mut child, &CancellationToken::new(), |_, _| {})
            .expect("supervise cgroup-scoped fake COLMAP");
        assert!(outcome.status.success(), "{:?}", outcome.log_tail);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn worker_address_space_fallback_returns_the_typed_stage_error() {
        let rig = TestRig::new("worker-rlimit", false, false);
        let scratch = rig.config.scratch_root.join("worker-rlimit-direct");
        let spec = CommandSpec {
            kind: ColmapCommandKind::FeatureExtractor,
            stage_label: "Extract ALIKED",
            args: Vec::new(),
        };
        let resident_limit_bytes = 1024 * 1024;
        let plan = WorkerMemoryLimitPlan {
            mode: WorkerMemoryLimitMode::RlimitAs,
            enforced_limit_bytes: resident_limit_bytes * WORKER_RLIMIT_AS_MULTIPLIER,
        };
        let command = worker_command_for_plan(
            Path::new("/usr/bin/prlimit"),
            &rig.tool_root.join("colmap"),
            plan,
        );
        let (mut child, actual_plan) =
            spawn_prepared_colmap_child(command, &spec, &scratch, Some(plan))
                .expect("spawn memory-limited fake COLMAP");
        assert_eq!(actual_plan, Some(plan));
        let outcome = supervise_child(&mut child, &CancellationToken::new(), |_, _| {})
            .expect("supervise memory-limited fake COLMAP");
        let error =
            worker_memory_limit_error(spec.stage_label, plan.enforced_limit_bytes, 321, &outcome)
                .expect("typed worker memory error");
        assert!(matches!(
            error,
            ColmapRuntimeError::WorkerMemoryLimitHit {
                ref stage,
                limit_bytes: 2_097_152,
                limit_gb: 1,
                observed_peak_bytes: 321,
            } if stage == "Extract ALIKED"
        ));
        assert_eq!(
            worker_memory_limit_bytes(512 * 1024 * 1024, 1),
            MINIMUM_WORKER_MEMORY_LIMIT_BYTES
        );
    }

    #[tokio::test]
    async fn sift_only_success_does_not_claim_unused_extraction_tiling() {
        let rig = TestRig::new("sift-does-not-tile", false, false);
        let mut request = rig.request("sift-does-not-tile-job");
        request.mapping_store = MappingFeatureStore::Sift;
        request.sift_rescue_only = true;
        request.extraction_tiling = Some(AlignmentExtractionTiling {
            columns: 2,
            rows: 1,
            tiles: 2,
            overlap_px: 256,
        });
        let outcome = run_successfully(rig.runtime(), request).await;
        assert_eq!(
            outcome.summary.selected_feature_store,
            SelectedFeatureStore::Sift
        );
        assert_eq!(outcome.summary.extraction_tiled, None);
        let invocations = fs::read_to_string(outcome.scratch_path.join("invocations.log"))
            .expect("read invocation log");
        assert_eq!(invocations.matches("CMD|feature_extractor").count(), 1);
        assert!(!invocations.contains("features/aliked/tiles"));
    }

    #[test]
    fn feature_cache_identity_includes_extraction_tiling() {
        let rig = TestRig::new("tiled-cache-key", false, false);
        let runtime = rig.runtime();
        let untiled = rig.request("cache-key");
        let mut tiled = untiled.clone();
        tiled.extraction_tiling = Some(AlignmentExtractionTiling {
            columns: 2,
            rows: 1,
            tiles: 2,
            overlap_px: 256,
        });
        assert_ne!(
            runtime
                .feature_cache_key(&untiled, FeatureStoreKind::Aliked, false)
                .expect("untiled key"),
            runtime
                .feature_cache_key(&tiled, FeatureStoreKind::Aliked, false)
                .expect("tiled key")
        );
        assert_eq!(
            runtime
                .feature_cache_key(&untiled, FeatureStoreKind::Sift, false)
                .expect("untiled SIFT key"),
            runtime
                .feature_cache_key(&tiled, FeatureStoreKind::Sift, false)
                .expect("SIFT ignores ALIKED tiling")
        );
    }

    #[tokio::test]
    async fn tiled_aliked_cancellation_stops_before_later_tiles() {
        let _timing_guard = crate::CANCELLATION_TIMING_TEST_LOCK
            .lock()
            .expect("cancellation timing test lock");
        let mut rig = TestRig::new("cancel-between-tiles", false, false);
        rig.replace_sources_with_tiling_images();
        let runtime = rig.runtime();
        let mut request = rig.request("cancel-between-tiles-job");
        request.sift_rescue_only = true;
        request.max_image_size = 2_048;
        request.extraction_tiling = Some(AlignmentExtractionTiling {
            columns: 2,
            rows: 1,
            tiles: 2,
            overlap_px: 256,
        });
        let scratch_root = rig.config.scratch_root.clone();
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("create tiled cancellation manager");
        let job_id = PhotolabJobId(request.job_id.clone());
        manager
            .start(
                NewPhotolabJob {
                    id: job_id.clone(),
                    kind: PhotolabJobKind::AlignPhotos,
                    config_hash: ObjectHash::of_bytes(b"tiled-config"),
                    input_hash: ObjectHash::of_bytes(b"tiled-input"),
                    progress: request.progress_plan().initial_progress(),
                },
                move |context| runtime.run_as_job(&request, &context),
            )
            .await
            .expect("start tiled cancellation job");
        let scratch = wait_for_invocation(&scratch_root, "tile-000001").await;
        manager
            .cancel(&job_id)
            .await
            .expect("cancel tiled extraction");
        let terminal = manager
            .wait_for_terminal(&job_id)
            .await
            .expect("wait for tiled cancellation");
        assert_eq!(terminal.state, PhotolabJobState::Cancelled);
        let invocations = fs::read_to_string(scratch.join("invocations.log"))
            .expect("read cancelled tiled invocations");
        assert_eq!(invocations.matches("CMD|feature_extractor").count(), 2);
        assert!(!scratch.join("output-summary.json").exists());
    }

    #[tokio::test]
    async fn verified_feature_cache_skips_repeated_extraction_and_matching() {
        let rig = TestRig::new("feature-cache", false, false);
        let runtime = rig.runtime();
        run_successfully(runtime.clone(), rig.request("cache-first")).await;
        let outcome = run_successfully(runtime, rig.request("cache-second")).await;
        let invocations = fs::read_to_string(outcome.scratch_path.join("invocations.log"))
            .expect("read invocation log");
        assert!(!invocations.contains("CMD|feature_extractor"));
        assert!(!invocations.contains("CMD|exhaustive_matcher"));
        assert!(!invocations.contains("CMD|geometric_verifier"));
    }

    #[tokio::test]
    async fn supports_the_typed_aliked_n32_maximum_variant() {
        let rig = TestRig::new("n32", false, false);
        let mut request = rig.request("n32-job");
        request.aliked_variant = AlikedModelVariant::N32;
        let outcome = run_successfully(rig.runtime(), request).await;
        let invocations = fs::read_to_string(outcome.scratch_path.join("invocations.log"))
            .expect("read invocation log");
        assert!(invocations.contains("--FeatureExtraction.type|ALIKED_N32"));
        assert!(invocations.contains("--AlikedExtraction.n32_model_path"));
    }

    #[tokio::test]
    async fn imports_verifies_and_selects_the_stronger_dedode_model() {
        let rig = TestRig::new("dedode-hybrid", false, false);
        let mut request = rig.request("dedode-hybrid-job");
        request.large_matching_backend = LargeMatchingBackend::DedodeV2G {
            policy: DedodeV2GPolicy::AllPairs,
        };
        let pairs = vec![DedodePairMatches {
            pair: DedodeImagePair {
                image_a: "camera-a".into(),
                image_b: "camera-b".into(),
            },
            matches: vec![DedodeMatch {
                feature_a: 7,
                feature_b: 9,
                x_a: 10.0,
                y_a: 20.0,
                x_b: 30.0,
                y_b: 40.0,
                confidence: 0.95,
            }],
        }];
        let dedode = DedodeRunOutcome {
            tool: DedodeToolIdentity {
                tool_id: "dedode".into(),
                version: "test".into(),
                manifest_sha256: ObjectHash::of_bytes(b"dedode-manifest"),
            },
            scratch_path: "/dedode".into(),
            result_path: "/dedode/result.json".into(),
            result_sha256: ObjectHash::of_bytes(b"result"),
            matches_path: "/dedode/matches.bin".into(),
            matches_sha256: ObjectHash::of_bytes(b"matches"),
            matches_bytes: 64,
            worker_result: DedodeWorkerResult {
                schema_version: 1,
                job_id: request.job_id.clone(),
                backend: "dedode-v2-g".into(),
                numeric_mode: "fp32".into(),
                image_count: 2,
                pair_count: 1,
                matches_path: "matches.bin".into(),
                checkpoint_path: "checkpoint.json".into(),
            },
            pairs,
        };
        let outcome = run_successfully_with_dedode(rig.runtime(), request, Some(dedode)).await;
        assert_eq!(
            outcome.summary.selected_feature_store,
            SelectedFeatureStore::DedodeV2G
        );
        assert_eq!(outcome.summary.selected_mapper, SelectedMapper::Global);
        assert_eq!(
            outcome
                .summary
                .mapping_candidates
                .iter()
                .filter(|candidate| candidate.selected)
                .count(),
            1
        );
        assert_eq!(outcome.summary.artifacts.len(), 5);
        let invocations = fs::read_to_string(outcome.scratch_path.join("invocations.log"))
            .expect("read invocations");
        assert!(invocations.contains("CMD|feature_importer"));
        assert!(invocations.contains("CMD|matches_importer"));
        assert!(invocations.contains("--match_type|raw"));
        assert_eq!(invocations.matches("CMD|geometric_verifier").count(), 2);
        assert!(outcome
            .scratch_path
            .join("sparse-selected/0/cameras.bin")
            .is_file());
        let sparse_artifact = outcome
            .summary
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == ColmapArtifactKind::SparseModel)
            .expect("sparse artifact");
        assert_eq!(
            sparse_artifact.relative_path,
            PathBuf::from("sparse-selected/0")
        );
    }

    #[test]
    fn dedode_never_silently_degrades_to_the_colmap_ensemble() {
        let rig = TestRig::new("dedode-gate", false, false);
        let runtime = rig.runtime();
        let mut request = rig.request("dedode-job");
        request.large_matching_backend = LargeMatchingBackend::DedodeV2G {
            policy: DedodeV2GPolicy::AllPairs,
        };
        let error = runtime
            .validate_capabilities(&request)
            .expect_err("COLMAP must reject the external DeDoDe contract");
        assert!(matches!(
            error,
            ColmapRuntimeError::DedicatedLargeMatcherRequired(DedodeV2GPolicy::AllPairs)
        ));
    }

    #[tokio::test]
    async fn falls_back_to_incremental_mapping_after_global_failure() {
        let rig = TestRig::new("fallback", true, false);
        let outcome = run_successfully(rig.runtime(), rig.request("fallback-job")).await;
        assert_eq!(
            outcome.summary.selected_mapper,
            SelectedMapper::IncrementalFallback
        );
        let global = outcome
            .summary
            .commands
            .iter()
            .find(|report| report.command == ColmapCommandKind::GlobalMapper)
            .expect("global mapper report");
        assert!(!global.success);
        assert_eq!(global.exit_code, Some(9));
        assert!(outcome
            .summary
            .commands
            .iter()
            .any(|report| report.command == ColmapCommandKind::Mapper && report.success));
    }

    #[tokio::test]
    async fn sift_rescues_a_failed_aliked_incremental_reconstruction() {
        let rig = TestRig::new("sift-rescue", true, false);
        let outcome = run_successfully(rig.runtime(), rig.request("sift-rescue-job")).await;
        assert_eq!(
            outcome.summary.selected_feature_store,
            SelectedFeatureStore::Sift
        );
        assert!(outcome
            .summary
            .commands
            .iter()
            .any(|report| report.command == ColmapCommandKind::Mapper
                && report.exit_code == Some(10)));
        assert!(outcome
            .summary
            .commands
            .iter()
            .any(|report| report.command == ColmapCommandKind::Mapper && report.success));
    }

    #[tokio::test]
    async fn cancellation_force_kills_the_active_child_without_publishing_summary() {
        let _timing_guard = crate::CANCELLATION_TIMING_TEST_LOCK
            .lock()
            .expect("cancellation timing test lock");
        let rig = TestRig::new("cancel", false, true);
        let runtime = rig.runtime();
        let mut request = rig.request("cancel-job");
        request.device = ColmapComputeDevice::Cuda {
            gpu_indices: vec![0],
        };
        request.products.depth_maps = true;
        let scratch_root = rig.config.scratch_root.clone();
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("create job manager");
        let job_id = PhotolabJobId(request.job_id.clone());
        manager
            .start(
                NewPhotolabJob {
                    id: job_id.clone(),
                    kind: PhotolabJobKind::BuildDepthMaps,
                    config_hash: ObjectHash::of_bytes(b"config"),
                    input_hash: ObjectHash::of_bytes(b"input"),
                    progress: request.progress_plan().initial_progress(),
                },
                move |context| runtime.run_as_job(&request, &context),
            )
            .await
            .expect("start cancellable job");

        let scratch = wait_for_invocation(&scratch_root, "CMD|patch_match_stereo").await;
        let started = Instant::now();
        manager.cancel(&job_id).await.expect("request cancellation");
        let terminal = manager
            .wait_for_terminal(&job_id)
            .await
            .expect("wait for cancellation");
        assert_eq!(terminal.state, PhotolabJobState::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!scratch.join("output-summary.json").exists());
    }

    #[tokio::test]
    async fn standalone_poisson_mesher_uses_frozen_args_and_feeds_the_ply_tiler() {
        let rig = TestRig::new("poisson-product", false, false);
        let input = rig.project.join("fused.ply");
        fs::write(&input, b"immutable dense cloud").expect("write dense input");
        let candidate = rig.project.join("poisson-product-candidate");
        let output = candidate.join("mesh.ply");
        let request = ColmapMeshRequest {
            executable: rig.tool_root.join("colmap"),
            project_root: rig.project.clone(),
            input_path: input.clone(),
            output_path: output.clone(),
            mesher: ColmapMesher::Poisson,
        };
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("create job manager");
        let job_id = PhotolabJobId("poisson-product-job".into());
        manager
            .start(
                NewPhotolabJob {
                    id: job_id.clone(),
                    kind: PhotolabJobKind::BuildMesh,
                    config_hash: ObjectHash::of_bytes(b"poisson-config"),
                    input_hash: ObjectHash::of_bytes(b"fused-input"),
                    progress: JobProgress {
                        stage: PhotolabStage {
                            kind: PhotolabStageKind::Meshing,
                            index: 0,
                            stage_count: 2,
                            label: "Build dense-cloud mesh".into(),
                        },
                        metrics: ProgressMetrics::empty(),
                    },
                },
                move |context| {
                    let report = run_colmap_mesher(&request, &context)?;
                    assert_eq!(
                        report.argv,
                        vec![
                            "--input_path".to_owned(),
                            input.to_string_lossy().into_owned(),
                            "--output_path".to_owned(),
                            output.to_string_lossy().into_owned(),
                            "--PoissonMeshing.depth".to_owned(),
                            "11".to_owned(),
                            "--PoissonMeshing.trim".to_owned(),
                            "7".to_owned(),
                        ]
                    );
                    Ok(())
                },
            )
            .await
            .expect("start poisson mesh job");
        let terminal = manager
            .wait_for_terminal(&job_id)
            .await
            .expect("wait for poisson mesh job");
        assert_eq!(terminal.state, PhotolabJobState::Completed);
        let product = crate::prepared_triangle_mesh_ply::build_prepared_triangle_mesh_from_ply(
            &candidate.join("mesh.ply"),
            &rig.project.join("prepared-poisson-product"),
            crate::prepared_triangle_mesh::PreparedTriangleMeshOptions::default(),
            &CancellationToken::new(),
        )
        .expect("poisson output reaches the PLY tiler");
        assert_eq!(product.triangle_count, 1);
    }

    #[tokio::test]
    async fn standalone_poisson_cancellation_kills_the_child_within_the_bound() {
        let _timing_guard = crate::CANCELLATION_TIMING_TEST_LOCK
            .lock()
            .expect("cancellation timing test lock");
        let rig = TestRig::new("poisson-cancel", false, false);
        let input = rig.project.join("fused.ply");
        fs::write(&input, b"immutable dense cloud").expect("write dense input");
        let frozen_input = input.clone();
        let candidate = rig.project.join("poisson-cancel-candidate");
        let output = candidate.join("mesh.ply");
        let request = ColmapMeshRequest {
            executable: rig.tool_root.join("colmap"),
            project_root: rig.project.clone(),
            input_path: input,
            output_path: output.clone(),
            mesher: ColmapMesher::Poisson,
        };
        let manager = JobManager::new(JobManagerConfig {
            max_concurrency: 1,
            max_queued: 0,
        })
        .expect("create job manager");
        let job_id = PhotolabJobId("poisson-cancel-job".into());
        manager
            .start(
                NewPhotolabJob {
                    id: job_id.clone(),
                    kind: PhotolabJobKind::BuildMesh,
                    config_hash: ObjectHash::of_bytes(b"poisson-config"),
                    input_hash: ObjectHash::of_bytes(b"fused-input"),
                    progress: JobProgress {
                        stage: PhotolabStage {
                            kind: PhotolabStageKind::Meshing,
                            index: 0,
                            stage_count: 2,
                            label: "Build dense-cloud mesh".into(),
                        },
                        metrics: ProgressMetrics::empty(),
                    },
                },
                move |context| {
                    run_colmap_mesher(&request, &context)
                        .map(|_| ())
                        .map_err(JobWorkerError::from)
                },
            )
            .await
            .expect("start cancellable poisson mesh job");
        for _ in 0..300 {
            if fs::read_to_string(candidate.join("invocations.log"))
                .unwrap_or_default()
                .contains("CMD|poisson_mesher")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(candidate.join("invocations.log").is_file());
        let started = Instant::now();
        manager.cancel(&job_id).await.expect("request cancellation");
        let terminal = manager
            .wait_for_terminal(&job_id)
            .await
            .expect("wait for cancellation");
        assert_eq!(terminal.state, PhotolabJobState::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!output.exists());
        assert_eq!(
            fs::read(&frozen_input).expect("dense input survives"),
            b"immutable dense cloud"
        );
    }

    async fn wait_for_invocation(root: &Path, needle: &str) -> PathBuf {
        for _ in 0..300 {
            if let Ok(entries) = fs::read_dir(root) {
                for entry in entries.filter_map(Result::ok) {
                    let scratch = entry.path();
                    let log =
                        fs::read_to_string(scratch.join("invocations.log")).unwrap_or_default();
                    if log.contains(needle) {
                        return scratch;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for fake invocation {needle}");
    }
}
