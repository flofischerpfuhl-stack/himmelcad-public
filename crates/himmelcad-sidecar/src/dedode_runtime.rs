//! Signed, offline DeDoDe-v2-G feature worker orchestration.
//!
//! The worker emits a neutral match container. COLMAP or the Rust core remains
//! responsible for epipolar verification and track construction.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, File},
    io::{self, BufRead, BufReader, Read},
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
    photolab_jobs::{
        CancellationToken, JobProgress, PhotolabStage, PhotolabStageKind, ProgressMetrics,
    },
    photolab_masks::{ImageMaskComputeScope, ImageMaskRaster},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::image_mask_runtime::{materialize_colmap_masks, read_compute_mask_raster};
use crate::{
    colmap_runtime::{
        materialize_project_images, ColmapRuntimeError, ManifestSignatureVerifier,
        ToolLicenseRecord,
    },
    image_commit::ProjectCameraImageRecord,
    job_runtime::{JobWorkerContext, JobWorkerError},
};

const MANIFEST_SCHEMA_VERSION: u32 = 1;
const RESULT_SCHEMA_VERSION: u32 = 1;
const MATCH_SCHEMA_VERSION: u32 = 1;
const MATCH_MAGIC: &[u8; 8] = b"HCDEDG01";
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 64 * 1024;
const MAX_LOG_LINE_BYTES: usize = 16 * 1024;
const LOG_TAIL_LINES: usize = 200;
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(15);
const OFFICIAL_DETECTOR_BYTES: u64 = 58_483_585;
const OFFICIAL_DESCRIPTOR_BYTES: u64 = 75_485_969;
const OFFICIAL_DINOV2_BYTES: u64 = 1_217_586_395;
const OFFICIAL_DETECTOR_SHA256: &str =
    "4113809dd9e0367af013a45fc2255a6b243ff241cd06520d17a65d9e231bdc17";
const OFFICIAL_DESCRIPTOR_SHA256: &str =
    "ef6e3f2911bb3c179960db15545a2137d0746054bb5bad75559524ccab1fee41";
const OFFICIAL_DINOV2_SHA256: &str =
    "d5383ea8f4877b2472eb973e0fd72d557c7da5d3611bd527ceeb1d7162cbf428";
const DEDODE_CODE_COMMIT: &str = "6d156183f4dc84cd704ae779eebc8350995c5b06";
const DEDODE_ONNX_MANIFEST_SHA256: &str =
    "747d3a26c54d24b46acee82c05c51913987d2e8b0b5ea231767e7e7197ea366b";

static NEXT_SCRATCH_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Immutable logical resources required by descriptor-G.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DedodeResourceKind {
    DetectorV2Weights,
    DescriptorGWeights,
    Dinov2VitL14Weights,
}

#[cfg(test)]
mod portable_match_id_tests {
    use std::io::Cursor;

    use super::read_string;

    #[test]
    fn match_id_reader_accepts_opaque_project_image_ids_longer_than_128_bytes() {
        let image_id = format!("project:{}:image:{}", "a".repeat(64), "b".repeat(64));
        assert!(image_id.len() > 128);
        let mut encoded = (image_id.len() as u32).to_le_bytes().to_vec();
        encoded.extend_from_slice(image_id.as_bytes());

        assert_eq!(
            read_string(&mut Cursor::new(encoded)).expect("valid opaque image ID"),
            image_id
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DedodeRuntimeBackend {
    Pytorch,
    OnnxRuntime,
}

/// Every signed file carries its own size, digest, origin and license.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DedodeFileRecord {
    pub relative_path: PathBuf,
    pub sha256: ObjectHash,
    pub bytes: u64,
    pub source_url: String,
    pub spdx_expression: String,
}

/// Platform-specific, signed inventory of the complete Python worker tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DedodeToolManifest {
    pub schema_version: u32,
    pub tool_id: String,
    pub version: String,
    pub python_version: String,
    pub torch_version: String,
    pub torchvision_version: String,
    pub executable_path: PathBuf,
    pub worker_path: PathBuf,
    pub dedode_source_root: PathBuf,
    pub files: Vec<DedodeFileRecord>,
    pub resources: BTreeMap<DedodeResourceKind, PathBuf>,
    pub licenses: Vec<ToolLicenseRecord>,
}

/// Release runtime pins. The manifest itself must also have a trusted signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DedodeRuntimeConfig {
    pub tool_root: PathBuf,
    pub manifest_path: PathBuf,
    pub detached_signature_path: PathBuf,
    pub expected_manifest_sha256: ObjectHash,
    pub trusted_signer_key_id: String,
    pub scratch_root: PathBuf,
    pub allowed_project_roots: Vec<PathBuf>,
}

/// Explicitly untrusted developer worker. Release packaging rejects this path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevDedodeRuntimeConfig {
    pub python_executable: PathBuf,
    pub worker_path: PathBuf,
    pub dedode_source_root: PathBuf,
    pub detector_v2_weights: PathBuf,
    pub descriptor_g_weights: PathBuf,
    pub dinov2_vitl14_weights: PathBuf,
    pub expected_python_version: String,
    pub expected_torch_version: String,
    pub expected_torchvision_version: String,
    pub scratch_root: PathBuf,
    pub allowed_project_roots: Vec<PathBuf>,
}

/// Hash-audited ONNX development/runtime tree without PyTorch or OpenMP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevDedodeOnnxRuntimeConfig {
    pub python_executable: PathBuf,
    pub worker_path: PathBuf,
    pub model_root: PathBuf,
    pub expected_python_version: String,
    pub expected_onnxruntime_version: String,
    pub expected_numpy_version: String,
    pub expected_pillow_version: String,
    pub scratch_root: PathBuf,
    pub allowed_project_roots: Vec<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DedodeOnnxModelManifest {
    schema_version: u32,
    backend: String,
    format: String,
    opset: u32,
    numeric_mode: String,
    source_commit: String,
    profiles: Vec<DedodeOnnxProfile>,
    source_weights: BTreeMap<String, String>,
    files: Vec<DedodeOnnxModelFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DedodeOnnxProfile {
    width: u32,
    height: u32,
    max_keypoints: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DedodeOnnxModelFile {
    path: PathBuf,
    bytes: u64,
    sha256: ObjectHash,
}

/// Device changes throughput only; descriptor, detector and numeric mode stay fixed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DedodeComputeDevice {
    Cpu,
    Cuda { gpu_index: u32 },
}

/// One unordered candidate image pair.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DedodeImagePair {
    pub image_a: String,
    pub image_b: String,
}

/// Typed, bounded input for one `DeDoDe` run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DedodeRunRequest {
    pub job_id: String,
    pub project_root: PathBuf,
    pub camera_images: Vec<ProjectCameraImageRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_mask_scope: Option<ImageMaskComputeScope>,
    pub pairs: Vec<DedodeImagePair>,
    pub device: DedodeComputeDevice,
    pub max_keypoints: u32,
    pub inference_width: u32,
    pub inference_height: u32,
    pub match_threshold: f32,
    pub match_block_size: u32,
    pub checkpoint_interval_pairs: u32,
}

impl DedodeRunRequest {
    fn validate(&self) -> Result<(), DedodeRuntimeError> {
        validate_component("job_id", &self.job_id)?;
        if self.camera_images.len() < 2 {
            return Err(DedodeRuntimeError::InvalidRequest(
                "at least two images are required".into(),
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
                return Err(DedodeRuntimeError::InvalidRequest(
                    "image-mask camera scope differs from the DeDoDe request".into(),
                ));
            }
        }
        if self.pairs.is_empty() {
            return Err(DedodeRuntimeError::InvalidRequest(
                "at least one pair is required".into(),
            ));
        }
        if !(1_024..=100_000).contains(&self.max_keypoints) {
            return Err(DedodeRuntimeError::InvalidRequest(
                "maxKeypoints must be between 1024 and 100000".into(),
            ));
        }
        if !(196..=2_048).contains(&self.inference_width)
            || !(196..=2_048).contains(&self.inference_height)
            || self.inference_width % 14 != 0
            || self.inference_height % 14 != 0
        {
            return Err(DedodeRuntimeError::InvalidRequest(
                "inference dimensions must be multiples of 14 in [196, 2048]".into(),
            ));
        }
        if !self.match_threshold.is_finite() || !(0.0..=1.0).contains(&self.match_threshold) {
            return Err(DedodeRuntimeError::InvalidRequest(
                "matchThreshold must be finite and in [0, 1]".into(),
            ));
        }
        if !(128..=4_096).contains(&self.match_block_size) {
            return Err(DedodeRuntimeError::InvalidRequest(
                "matchBlockSize must be between 128 and 4096".into(),
            ));
        }
        if self.checkpoint_interval_pairs == 0 {
            return Err(DedodeRuntimeError::InvalidRequest(
                "checkpointIntervalPairs must be greater than zero".into(),
            ));
        }
        let image_ids = self
            .camera_images
            .iter()
            .map(|image| image.entity_id.0.as_str())
            .collect::<BTreeSet<_>>();
        if image_ids.len() != self.camera_images.len() {
            return Err(DedodeRuntimeError::InvalidRequest(
                "camera entity IDs must be unique".into(),
            ));
        }
        let mut pairs = BTreeSet::new();
        for pair in &self.pairs {
            validate_image_identifier("pair image A", &pair.image_a)?;
            validate_image_identifier("pair image B", &pair.image_b)?;
            if pair.image_a == pair.image_b
                || !image_ids.contains(pair.image_a.as_str())
                || !image_ids.contains(pair.image_b.as_str())
            {
                return Err(DedodeRuntimeError::InvalidRequest(
                    "every pair must reference two different request images".into(),
                ));
            }
            let canonical = if pair.image_a < pair.image_b {
                (&pair.image_a, &pair.image_b)
            } else {
                (&pair.image_b, &pair.image_a)
            };
            if !pairs.insert(canonical) {
                return Err(DedodeRuntimeError::InvalidRequest(
                    "duplicate image pair".into(),
                ));
            }
        }
        Ok(())
    }
}

/// One validated neutral match.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DedodeMatch {
    pub feature_a: u32,
    pub feature_b: u32,
    pub x_a: f32,
    pub y_a: f32,
    pub x_b: f32,
    pub y_b: f32,
    pub confidence: f32,
}

/// Validated matches for one requested pair.
#[derive(Debug, Clone, PartialEq)]
pub struct DedodePairMatches {
    pub pair: DedodeImagePair,
    pub matches: Vec<DedodeMatch>,
}

/// Worker-reported immutable provenance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DedodeWorkerResult {
    pub schema_version: u32,
    pub job_id: String,
    pub backend: String,
    pub numeric_mode: String,
    pub image_count: u32,
    pub pair_count: u32,
    pub matches_path: PathBuf,
    pub checkpoint_path: PathBuf,
}

/// Durable result returned to product publication and geometric verification.
#[derive(Debug, Clone, PartialEq)]
pub struct DedodeRunOutcome {
    pub scratch_path: PathBuf,
    pub result_path: PathBuf,
    pub result_sha256: ObjectHash,
    pub matches_path: PathBuf,
    pub matches_sha256: ObjectHash,
    pub matches_bytes: u64,
    pub pairs: Vec<DedodePairMatches>,
    pub worker_result: DedodeWorkerResult,
}

#[derive(Debug, Clone)]
struct VerifiedToolchain {
    manifest: DedodeToolManifest,
    manifest_sha256: ObjectHash,
    executable: PathBuf,
    worker: PathBuf,
    source_root: PathBuf,
    resources: BTreeMap<DedodeResourceKind, PathBuf>,
    backend: DedodeRuntimeBackend,
    trusted_release: bool,
}

/// Hash-pinned worker runtime with no arbitrary argument surface.
#[derive(Clone)]
pub struct DedodeRuntime {
    toolchain: Arc<VerifiedToolchain>,
    scratch_root: PathBuf,
    allowed_project_roots: Arc<Vec<PathBuf>>,
}

impl std::fmt::Debug for DedodeRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DedodeRuntime")
            .field("version", &self.toolchain.manifest.version)
            .field("trusted_release", &self.toolchain.trusted_release)
            .field("scratch_root", &self.scratch_root)
            .finish_non_exhaustive()
    }
}

impl DedodeRuntime {
    /// Verifies signature, manifest pin, full file inventory and official model pins.
    pub fn preflight(
        config: &DedodeRuntimeConfig,
        verifier: &dyn ManifestSignatureVerifier,
    ) -> Result<Self, DedodeRuntimeError> {
        validate_hash(&config.expected_manifest_sha256, "manifest")?;
        if config.trusted_signer_key_id.trim().is_empty() {
            return Err(DedodeRuntimeError::InvalidConfig(
                "trusted signer key ID is empty".into(),
            ));
        }
        let root = canonical_directory(&config.tool_root)?;
        let manifest_path = canonical_file_inside(&config.manifest_path, &root)?;
        let signature_path = canonical_file_inside(&config.detached_signature_path, &root)?;
        let manifest_bytes = read_bounded(&manifest_path, MAX_MANIFEST_BYTES)?;
        let observed = ObjectHash::of_bytes(&manifest_bytes);
        if observed != config.expected_manifest_sha256 {
            return Err(DedodeRuntimeError::HashMismatch {
                path: manifest_path,
                expected: config.expected_manifest_sha256.clone(),
                observed,
            });
        }
        let signature = read_bounded(&signature_path, MAX_SIGNATURE_BYTES)?;
        verifier
            .verify_detached(&config.trusted_signer_key_id, &manifest_bytes, &signature)
            .map_err(DedodeRuntimeError::SignatureRejected)?;
        let manifest: DedodeToolManifest = serde_json::from_slice(&manifest_bytes)?;
        validate_release_manifest(&manifest)?;
        let inventory = verify_inventory(&root, &manifest.files, None)?;
        verify_no_unlisted_files(
            &root,
            &inventory,
            &[manifest_path.as_path(), signature_path.as_path()],
        )?;
        let executable = inventory_path(&root, &inventory, &manifest.executable_path)?;
        let worker = inventory_path(&root, &inventory, &manifest.worker_path)?;
        let source_root =
            canonical_directory_inside(&root.join(&manifest.dedode_source_root), &root)?;
        let resources = resolve_resources(&root, &manifest.resources, &inventory)?;
        probe_worker(
            &executable,
            &worker,
            &source_root,
            &manifest.python_version,
            &manifest.torch_version,
            &manifest.torchvision_version,
        )?;
        Ok(Self {
            toolchain: Arc::new(VerifiedToolchain {
                manifest,
                manifest_sha256: config.expected_manifest_sha256.clone(),
                executable,
                worker,
                source_root,
                resources,
                backend: DedodeRuntimeBackend::Pytorch,
                trusted_release: true,
            }),
            scratch_root: prepare_scratch_root(&config.scratch_root)?,
            allowed_project_roots: Arc::new(canonical_roots(&config.allowed_project_roots)?),
        })
    }

    /// Probes a local venv and fetched official weights without release trust.
    pub fn development_preflight(
        config: &DevDedodeRuntimeConfig,
    ) -> Result<Self, DedodeRuntimeError> {
        let executable = canonical_file(&config.python_executable)?;
        let worker = canonical_file(&config.worker_path)?;
        let source_root = canonical_directory(&config.dedode_source_root)?;
        let mut resources = BTreeMap::new();
        resources.insert(
            DedodeResourceKind::DetectorV2Weights,
            canonical_file(&config.detector_v2_weights)?,
        );
        resources.insert(
            DedodeResourceKind::DescriptorGWeights,
            canonical_file(&config.descriptor_g_weights)?,
        );
        resources.insert(
            DedodeResourceKind::Dinov2VitL14Weights,
            canonical_file(&config.dinov2_vitl14_weights)?,
        );
        for (kind, path) in &resources {
            verify_official_resource(*kind, path)?;
        }
        probe_worker(
            &executable,
            &worker,
            &source_root,
            &config.expected_python_version,
            &config.expected_torch_version,
            &config.expected_torchvision_version,
        )?;
        let files = resources
            .iter()
            .map(|(kind, path)| {
                let (source_url, spdx_expression) = official_resource_metadata(*kind);
                Ok(DedodeFileRecord {
                    relative_path: path.clone(),
                    sha256: hash_file(path, None)?,
                    bytes: fs::metadata(path)?.len(),
                    source_url: source_url.into(),
                    spdx_expression: spdx_expression.into(),
                })
            })
            .collect::<Result<Vec<_>, DedodeRuntimeError>>()?;
        let manifest = DedodeToolManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            tool_id: "dedode-v2-g-dev-untrusted".into(),
            version: format!("v2-g+{DEDODE_CODE_COMMIT}"),
            python_version: config.expected_python_version.clone(),
            torch_version: config.expected_torch_version.clone(),
            torchvision_version: config.expected_torchvision_version.clone(),
            executable_path: executable.clone(),
            worker_path: worker.clone(),
            dedode_source_root: source_root.clone(),
            files,
            resources: resources
                .iter()
                .map(|(kind, path)| (*kind, path.clone()))
                .collect(),
            licenses: vec![ToolLicenseRecord {
                component: "UNTRUSTED-DEV-DEDoDe".into(),
                version: DEDODE_CODE_COMMIT.into(),
                spdx_expression: "NOASSERTION".into(),
            }],
        };
        let manifest_sha256 = ObjectHash::of_bytes(&serde_json::to_vec(&manifest)?);
        Ok(Self {
            toolchain: Arc::new(VerifiedToolchain {
                manifest,
                manifest_sha256,
                executable,
                worker,
                source_root,
                resources,
                backend: DedodeRuntimeBackend::Pytorch,
                trusted_release: false,
            }),
            scratch_root: prepare_scratch_root(&config.scratch_root)?,
            allowed_project_roots: Arc::new(canonical_roots(&config.allowed_project_roots)?),
        })
    }

    /// Probes the full-quality ONNX graphs and a runtime with no PyTorch dependency.
    pub fn development_onnx_preflight(
        config: &DevDedodeOnnxRuntimeConfig,
    ) -> Result<Self, DedodeRuntimeError> {
        let executable = canonical_file(&config.python_executable)?;
        let worker = canonical_file(&config.worker_path)?;
        let model_root = canonical_directory(&config.model_root)?;
        verify_onnx_model_inventory(&model_root)?;
        for relative in [
            "dedode-detector-l-v2.onnx",
            "dedode-block-similarity.onnx",
            "784x784/dedode-descriptor-g.onnx",
            "1176x1176/dedode-descriptor-g.onnx",
        ] {
            canonical_file_inside(&model_root.join(relative), &model_root)?;
        }
        probe_onnx_worker(
            &executable,
            &worker,
            &model_root,
            &config.expected_python_version,
            &config.expected_onnxruntime_version,
            &config.expected_numpy_version,
            &config.expected_pillow_version,
        )?;
        let model_files = [
            "dedode-detector-l-v2.onnx",
            "dedode-block-similarity.onnx",
            "784x784/dedode-descriptor-g.onnx",
            "1176x1176/dedode-descriptor-g.onnx",
        ];
        let files = model_files
            .iter()
            .map(|relative| {
                let path = canonical_file_inside(&model_root.join(relative), &model_root)?;
                Ok(DedodeFileRecord {
                    relative_path: PathBuf::from(relative),
                    sha256: hash_file(&path, None)?,
                    bytes: fs::metadata(path)?.len(),
                    source_url: "generated-from-pinned-dedode-v2-g".into(),
                    spdx_expression: "MIT AND Apache-2.0".into(),
                })
            })
            .collect::<Result<Vec<_>, DedodeRuntimeError>>()?;
        let manifest = DedodeToolManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            tool_id: "dedode-v2-g-onnx-dev-untrusted".into(),
            version: format!("v2-g+{DEDODE_CODE_COMMIT}+onnxruntime"),
            python_version: config.expected_python_version.clone(),
            torch_version: config.expected_onnxruntime_version.clone(),
            torchvision_version: format!(
                "numpy-{}+pillow-{}",
                config.expected_numpy_version, config.expected_pillow_version
            ),
            executable_path: executable.clone(),
            worker_path: worker.clone(),
            dedode_source_root: model_root.clone(),
            files,
            resources: BTreeMap::new(),
            licenses: vec![ToolLicenseRecord {
                component: "UNTRUSTED-DEV-DEDoDe-ONNX".into(),
                version: DEDODE_CODE_COMMIT.into(),
                spdx_expression: "MIT AND Apache-2.0".into(),
            }],
        };
        let manifest_sha256 = ObjectHash::of_bytes(&serde_json::to_vec(&manifest)?);
        Ok(Self {
            toolchain: Arc::new(VerifiedToolchain {
                manifest,
                manifest_sha256,
                executable,
                worker,
                source_root: model_root,
                resources: BTreeMap::new(),
                backend: DedodeRuntimeBackend::OnnxRuntime,
                trusted_release: false,
            }),
            scratch_root: prepare_scratch_root(&config.scratch_root)?,
            allowed_project_roots: Arc::new(canonical_roots(&config.allowed_project_roots)?),
        })
    }

    /// True only for the signed release constructor.
    #[must_use]
    pub fn is_trusted_release(&self) -> bool {
        self.toolchain.trusted_release
    }

    /// Digest of the signed release manifest or synthetic untrusted dev manifest.
    #[must_use]
    pub fn manifest_sha256(&self) -> &ObjectHash {
        &self.toolchain.manifest_sha256
    }

    /// Executes feature extraction and blockwise matching in an isolated scratch tree.
    pub fn run(
        &self,
        request: &DedodeRunRequest,
        context: &JobWorkerContext,
    ) -> Result<DedodeRunOutcome, DedodeRuntimeError> {
        request.validate()?;
        context
            .check_cancelled()
            .map_err(|_| DedodeRuntimeError::Cancelled)?;
        let project_root = self.validate_project_root(&request.project_root)?;
        let scratch = create_scratch(&self.scratch_root, &request.job_id)?;
        for relative in ["images", "features", "pairs", "home", "tmp", "cache"] {
            fs::create_dir_all(scratch.join(relative))?;
        }
        let materialized = materialize_project_images(
            &project_root,
            &request.camera_images,
            &scratch,
            &context.cancellation,
        )
        .map_err(|error| {
            if matches!(error, ColmapRuntimeError::Cancelled) {
                DedodeRuntimeError::Cancelled
            } else {
                DedodeRuntimeError::ImageMaterialization(error.to_string())
            }
        })?;
        if let Some(mask_scope) = request.image_mask_scope.as_ref() {
            let image_paths = request
                .camera_images
                .iter()
                .zip(&materialized)
                .map(|(camera, path)| (camera.entity_id.0.as_str(), path.as_path()))
                .collect::<BTreeMap<_, _>>();
            materialize_colmap_masks(
                &project_root,
                &mask_scope.masks,
                &image_paths,
                &scratch.join("masks"),
                &context.cancellation,
            )
            .map_err(|error| DedodeRuntimeError::InvalidRequest(error.to_string()))?;
        }
        let worker_request = build_worker_request(
            request,
            &scratch,
            &materialized,
            &self.toolchain.resources,
            self.toolchain.backend,
        )?;
        let request_path = scratch.join("run-request.json");
        write_json_atomic(&request_path, &worker_request)?;
        report_progress(
            context,
            PhotolabStageKind::FeatureExtraction,
            0,
            request.camera_images.len() as u64,
            "DeDoDe-v2-G Features",
        )?;
        let started = Instant::now();
        let mut child = self.spawn_worker(&scratch, &request_path)?;
        let mut progress_error = None;
        let outcome = supervise_child(
            &mut child,
            &context.cancellation,
            |completed, total, phase| {
                if progress_error.is_some() {
                    return;
                }
                let kind = if phase == "features" {
                    PhotolabStageKind::FeatureExtraction
                } else {
                    PhotolabStageKind::FeatureMatching
                };
                progress_error = report_progress(
                    context,
                    kind,
                    completed,
                    total,
                    if phase == "features" {
                        "DeDoDe-v2-G Features"
                    } else {
                        "DeDoDe-v2-G Matching"
                    },
                )
                .err();
            },
        )?;
        if let Some(error) = progress_error {
            return Err(error);
        }
        if !outcome.status.success() {
            return Err(DedodeRuntimeError::WorkerFailed {
                exit_code: outcome.status.code(),
                message: outcome
                    .log_tail
                    .last()
                    .cloned()
                    .unwrap_or_else(|| "worker produced no diagnostics".into()),
            });
        }
        let result_path = scratch.join("result.json");
        let result_bytes = read_bounded(&result_path, 1024 * 1024)?;
        let worker_result: DedodeWorkerResult = serde_json::from_slice(&result_bytes)?;
        validate_worker_result(request, &worker_result)?;
        let matches_path = resolve_output(&scratch, &worker_result.matches_path)?;
        let checkpoint_path = resolve_output(&scratch, &worker_result.checkpoint_path)?;
        if !checkpoint_path.is_file() {
            return Err(DedodeRuntimeError::MissingOutput(checkpoint_path));
        }
        let pairs = parse_match_container(&matches_path, request)?;
        let matches_bytes = fs::metadata(&matches_path)?.len();
        let matches_sha256 = hash_file(&matches_path, Some(&context.cancellation))?;
        let result_sha256 = ObjectHash::of_bytes(&result_bytes);
        report_progress(
            context,
            PhotolabStageKind::GeometricVerification,
            request.pairs.len() as u64,
            request.pairs.len() as u64,
            "Validate DeDoDe matches; geometry pending",
        )?;
        let _duration = started.elapsed();
        Ok(DedodeRunOutcome {
            scratch_path: scratch,
            result_path,
            result_sha256,
            matches_path,
            matches_sha256,
            matches_bytes,
            pairs,
            worker_result,
        })
    }

    fn validate_project_root(&self, project_root: &Path) -> Result<PathBuf, DedodeRuntimeError> {
        let canonical = canonical_directory(project_root)?;
        if self
            .allowed_project_roots
            .iter()
            .any(|root| canonical.starts_with(root))
        {
            Ok(canonical)
        } else {
            Err(DedodeRuntimeError::ProjectPathOutsideAllowedRoots(
                canonical,
            ))
        }
    }

    fn spawn_worker(
        &self,
        scratch: &Path,
        request_path: &Path,
    ) -> Result<Child, DedodeRuntimeError> {
        let mut command = Command::new(&self.toolchain.executable);
        command
            .arg("-I")
            .arg("-B")
            .arg("-s")
            .arg(&self.toolchain.worker)
            .arg("--run")
            .arg(request_path)
            .arg("--dedode-source")
            .arg(&self.toolchain.source_root)
            .current_dir(scratch)
            .env_clear()
            .env("HOME", scratch.join("home"))
            .env("TMPDIR", scratch.join("tmp"))
            .env("TEMP", scratch.join("tmp"))
            .env("TMP", scratch.join("tmp"))
            .env("XDG_CACHE_HOME", scratch.join("cache"))
            .env("TORCH_HOME", scratch.join("cache/torch"))
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("DEDODE_NO_NETWORK", "1")
            .env("CUDA_CACHE_PATH", scratch.join("cache/cuda"))
            .env("PYTHONHASHSEED", "0")
            .env("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        if self.toolchain.backend == DedodeRuntimeBackend::OnnxRuntime {
            if let Some(python_root) = self.toolchain.executable.parent().and_then(Path::parent) {
                command.env("LD_LIBRARY_PATH", python_root.join("lib"));
            }
        }
        #[cfg(windows)]
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            command.env("SystemRoot", system_root);
        }
        process_group::spawn(&mut command).map_err(DedodeRuntimeError::Io)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRequest<'a> {
    schema_version: u32,
    job_id: &'a str,
    scratch_root: &'a Path,
    images: Vec<WorkerImage<'a>>,
    pairs: &'a [DedodeImagePair],
    device: DedodeComputeDevice,
    numeric_mode: &'static str,
    max_keypoints: u32,
    inference_width: u32,
    inference_height: u32,
    match_threshold: f32,
    match_block_size: u32,
    checkpoint_interval_pairs: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    detector_v2_weights: Option<&'a Path>,
    #[serde(skip_serializing_if = "Option::is_none")]
    descriptor_g_weights: Option<&'a Path>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dinov2_vitl14_weights: Option<&'a Path>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerImage<'a> {
    id: &'a str,
    path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    mask_path: Option<PathBuf>,
}

fn build_worker_request<'a>(
    request: &'a DedodeRunRequest,
    scratch: &'a Path,
    materialized: &[PathBuf],
    resources: &'a BTreeMap<DedodeResourceKind, PathBuf>,
    backend: DedodeRuntimeBackend,
) -> Result<WorkerRequest<'a>, DedodeRuntimeError> {
    if materialized.len() != request.camera_images.len() {
        return Err(DedodeRuntimeError::InvalidRequest(
            "materialized image count differs from request".into(),
        ));
    }
    let images = request
        .camera_images
        .iter()
        .zip(materialized)
        .map(|(camera, relative)| WorkerImage {
            id: camera.entity_id.0.as_str(),
            path: scratch.join("images").join(relative),
            mask_path: request.image_mask_scope.as_ref().and_then(|scope| {
                scope
                    .masks
                    .iter()
                    .any(|mask| mask.image_entity_id == camera.entity_id)
                    .then(|| dedode_mask_path(scratch, relative))
            }),
        })
        .collect();
    Ok(WorkerRequest {
        schema_version: 1,
        job_id: &request.job_id,
        scratch_root: scratch,
        images,
        pairs: &request.pairs,
        device: request.device,
        numeric_mode: "float32",
        max_keypoints: request.max_keypoints,
        inference_width: request.inference_width,
        inference_height: request.inference_height,
        match_threshold: request.match_threshold,
        match_block_size: request.match_block_size,
        checkpoint_interval_pairs: request.checkpoint_interval_pairs,
        detector_v2_weights: (backend == DedodeRuntimeBackend::Pytorch)
            .then(|| required_resource(resources, DedodeResourceKind::DetectorV2Weights))
            .transpose()?,
        descriptor_g_weights: (backend == DedodeRuntimeBackend::Pytorch)
            .then(|| required_resource(resources, DedodeResourceKind::DescriptorGWeights))
            .transpose()?,
        dinov2_vitl14_weights: (backend == DedodeRuntimeBackend::Pytorch)
            .then(|| required_resource(resources, DedodeResourceKind::Dinov2VitL14Weights))
            .transpose()?,
    })
}

fn dedode_mask_path(scratch: &Path, relative: &Path) -> PathBuf {
    scratch.join("masks").join(relative).with_extension(format!(
        "{}.png",
        relative
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("image")
    ))
}

fn required_resource(
    resources: &BTreeMap<DedodeResourceKind, PathBuf>,
    kind: DedodeResourceKind,
) -> Result<&Path, DedodeRuntimeError> {
    resources
        .get(&kind)
        .map(PathBuf::as_path)
        .ok_or(DedodeRuntimeError::MissingResource(kind))
}

fn report_progress(
    context: &JobWorkerContext,
    kind: PhotolabStageKind,
    completed: u64,
    total: u64,
    label: &str,
) -> Result<(), DedodeRuntimeError> {
    context
        .progress
        .report_blocking(JobProgress {
            stage: PhotolabStage {
                kind,
                index: if kind == PhotolabStageKind::FeatureExtraction {
                    0
                } else if kind == PhotolabStageKind::FeatureMatching {
                    1
                } else {
                    2
                },
                stage_count: 3,
                label: label.into(),
            },
            metrics: ProgressMetrics {
                completed_units: completed,
                total_units: Some(total),
                completed_bytes: 0,
                total_bytes: None,
            },
        })
        .map(|_| ())
        .map_err(|error| DedodeRuntimeError::Progress(error.to_string()))
}

fn validate_release_manifest(manifest: &DedodeToolManifest) -> Result<(), DedodeRuntimeError> {
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(DedodeRuntimeError::UnsupportedManifestSchema(
            manifest.schema_version,
        ));
    }
    if manifest.tool_id != "himmelcad-dedode-v2-g" || !manifest.version.contains(DEDODE_CODE_COMMIT)
    {
        return Err(DedodeRuntimeError::InvalidConfig(
            "manifest does not pin the approved DeDoDe source commit".into(),
        ));
    }
    if !exact_version(&manifest.python_version)
        || !exact_version(&manifest.torch_version)
        || !exact_version(&manifest.torchvision_version)
    {
        return Err(DedodeRuntimeError::InvalidConfig(
            "Python and PyTorch versions must be exact pins".into(),
        ));
    }
    if manifest.files.is_empty() || manifest.licenses.is_empty() {
        return Err(DedodeRuntimeError::InvalidConfig(
            "manifest inventory and licenses must not be empty".into(),
        ));
    }
    let mut paths = BTreeSet::new();
    for record in &manifest.files {
        validate_relative_path(&record.relative_path, "manifest file")?;
        validate_hash(&record.sha256, "manifest file")?;
        if record.bytes == 0
            || record.source_url.trim().is_empty()
            || record.spdx_expression.trim().is_empty()
        {
            return Err(DedodeRuntimeError::InvalidConfig(
                "manifest files require byte size, source URL and license".into(),
            ));
        }
        validate_license("manifest file", &record.spdx_expression)?;
        if !paths.insert(record.relative_path.clone()) {
            return Err(DedodeRuntimeError::InvalidConfig(
                "manifest contains duplicate file paths".into(),
            ));
        }
    }
    validate_relative_path(&manifest.executable_path, "Python executable")?;
    validate_relative_path(&manifest.worker_path, "worker entrypoint")?;
    validate_relative_path(&manifest.dedode_source_root, "DeDoDe source root")?;
    for license in &manifest.licenses {
        validate_license(&license.component, &license.spdx_expression)?;
    }
    let expected = [
        (
            DedodeResourceKind::DetectorV2Weights,
            OFFICIAL_DETECTOR_BYTES,
            OFFICIAL_DETECTOR_SHA256,
            "MIT",
            "https://github.com/Parskatt/DeDoDe/releases/download/v2/dedode_detector_L_v2.pth",
        ),
        (
            DedodeResourceKind::DescriptorGWeights,
            OFFICIAL_DESCRIPTOR_BYTES,
            OFFICIAL_DESCRIPTOR_SHA256,
            "MIT",
            "https://github.com/Parskatt/DeDoDe/releases/download/dedode_pretrained_models/dedode_descriptor_G.pth",
        ),
        (
            DedodeResourceKind::Dinov2VitL14Weights,
            OFFICIAL_DINOV2_BYTES,
            OFFICIAL_DINOV2_SHA256,
            "Apache-2.0",
            "https://dl.fbaipublicfiles.com/dinov2/dinov2_vitl14/dinov2_vitl14_pretrain.pth",
        ),
    ];
    if manifest.resources.len() != expected.len() {
        return Err(DedodeRuntimeError::InvalidConfig(
            "manifest must contain exactly the three approved weight resources".into(),
        ));
    }
    for (kind, bytes, sha, license, source_url) in expected {
        let path = manifest
            .resources
            .get(&kind)
            .ok_or(DedodeRuntimeError::MissingResource(kind))?;
        let record = manifest
            .files
            .iter()
            .find(|record| &record.relative_path == path)
            .ok_or_else(|| {
                DedodeRuntimeError::InvalidConfig(
                    "weight resource is absent from file inventory".into(),
                )
            })?;
        if record.bytes != bytes
            || record.sha256.as_str() != sha
            || record.spdx_expression != license
            || record.source_url != source_url
        {
            return Err(DedodeRuntimeError::OfficialWeightPinMismatch(kind));
        }
    }
    Ok(())
}

fn verify_onnx_model_inventory(model_root: &Path) -> Result<(), DedodeRuntimeError> {
    let parent = model_root.parent().ok_or_else(|| {
        DedodeRuntimeError::InvalidConfig("ONNX model root has no runtime parent".into())
    })?;
    let manifest_path = canonical_file_inside(&parent.join("ONNX_MODELS.json"), parent)?;
    let bytes = read_bounded(&manifest_path, MAX_MANIFEST_BYTES)?;
    let observed_manifest = ObjectHash::of_bytes(&bytes);
    if observed_manifest.as_str() != DEDODE_ONNX_MANIFEST_SHA256 {
        return Err(DedodeRuntimeError::HashMismatch {
            path: manifest_path,
            expected: ObjectHash(DEDODE_ONNX_MANIFEST_SHA256.into()),
            observed: observed_manifest,
        });
    }
    let manifest: DedodeOnnxModelManifest = serde_json::from_slice(&bytes)?;
    let expected_profiles = [(784, 784, 20_000), (1_176, 1_176, 40_000)];
    if manifest.schema_version != 1
        || manifest.backend != "dedode-v2-g"
        || manifest.format != "ONNX external data"
        || manifest.opset != 17
        || manifest.numeric_mode != "float32"
        || manifest.source_commit != DEDODE_CODE_COMMIT
        || manifest.profiles.len() != expected_profiles.len()
        || !manifest
            .profiles
            .iter()
            .zip(expected_profiles)
            .all(|(profile, expected)| {
                (profile.width, profile.height, profile.max_keypoints) == expected
            })
        || manifest.source_weights.get("detector").map(String::as_str)
            != Some(OFFICIAL_DETECTOR_SHA256)
        || manifest
            .source_weights
            .get("descriptor")
            .map(String::as_str)
            != Some(OFFICIAL_DESCRIPTOR_SHA256)
        || manifest.source_weights.get("dinov2").map(String::as_str) != Some(OFFICIAL_DINOV2_SHA256)
    {
        return Err(DedodeRuntimeError::InvalidConfig(
            "DeDoDe ONNX manifest differs from the approved full-quality export".into(),
        ));
    }
    let records = manifest
        .files
        .into_iter()
        .map(|record| DedodeFileRecord {
            relative_path: record.path,
            sha256: record.sha256,
            bytes: record.bytes,
            source_url: "generated-from-pinned-dedode-v2-g".into(),
            spdx_expression: "MIT AND Apache-2.0".into(),
        })
        .collect::<Vec<_>>();
    let inventory = verify_inventory(model_root, &records, None)?;
    verify_no_unlisted_files(model_root, &inventory, &[])?;
    Ok(())
}

fn exact_version(value: &str) -> bool {
    value
        .bytes()
        .next()
        .is_some_and(|first| first.is_ascii_digit())
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-' | b'_'))
        && !value.bytes().any(|byte| matches!(byte, b'x' | b'X' | b'*'))
}

fn validate_license(component: &str, expression: &str) -> Result<(), DedodeRuntimeError> {
    const ALLOWED: &[&str] = &[
        "MIT",
        "MIT-CMU",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "Apache-2.0",
        "ISC",
        "Zlib",
        "PSF-2.0",
        "Unlicense",
        "BUSL-1.1",
    ];
    let tokens = expression
        .split(" OR ")
        .flat_map(|term| term.split(" AND "))
        .map(str::trim);
    if tokens.clone().all(|token| ALLOWED.contains(&token)) {
        Ok(())
    } else {
        Err(DedodeRuntimeError::ForbiddenLicense {
            component: component.into(),
            expression: expression.into(),
        })
    }
}

fn verify_inventory(
    root: &Path,
    records: &[DedodeFileRecord],
    cancellation: Option<&CancellationToken>,
) -> Result<BTreeMap<PathBuf, PathBuf>, DedodeRuntimeError> {
    let mut inventory = BTreeMap::new();
    for record in records {
        let path = canonical_file_inside(&root.join(&record.relative_path), root)?;
        let metadata = fs::metadata(&path)?;
        if metadata.len() != record.bytes {
            return Err(DedodeRuntimeError::SizeMismatch {
                path,
                expected: record.bytes,
                observed: metadata.len(),
            });
        }
        let observed = hash_file(&path, cancellation)?;
        if observed != record.sha256 {
            return Err(DedodeRuntimeError::HashMismatch {
                path,
                expected: record.sha256.clone(),
                observed,
            });
        }
        inventory.insert(record.relative_path.clone(), path);
    }
    Ok(inventory)
}

fn verify_no_unlisted_files(
    root: &Path,
    inventory: &BTreeMap<PathBuf, PathBuf>,
    trust_inputs: &[&Path],
) -> Result<(), DedodeRuntimeError> {
    let trusted = trust_inputs.iter().copied().collect::<BTreeSet<_>>();
    let inventoried = inventory
        .values()
        .map(PathBuf::as_path)
        .collect::<BTreeSet<_>>();
    let mut pending = vec![root.to_owned()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let path = entry.path();
            if file_type.is_symlink() {
                return Err(DedodeRuntimeError::InvalidPath {
                    path,
                    reason: "symlinks are forbidden in signed worker trees".into(),
                });
            }
            if file_type.is_dir() {
                pending.push(path);
            } else if file_type.is_file() {
                let canonical = canonical_file(&path)?;
                if !inventoried.contains(canonical.as_path())
                    && !trusted.contains(canonical.as_path())
                {
                    return Err(DedodeRuntimeError::InvalidPath {
                        path: canonical,
                        reason: "file is absent from signed worker inventory".into(),
                    });
                }
            } else {
                return Err(DedodeRuntimeError::InvalidPath {
                    path,
                    reason: "special files are forbidden in worker tree".into(),
                });
            }
        }
    }
    Ok(())
}

fn inventory_path(
    root: &Path,
    inventory: &BTreeMap<PathBuf, PathBuf>,
    relative: &Path,
) -> Result<PathBuf, DedodeRuntimeError> {
    inventory
        .get(relative)
        .cloned()
        .ok_or_else(|| DedodeRuntimeError::InvalidPath {
            path: root.join(relative),
            reason: "path is absent from signed inventory".into(),
        })
}

fn resolve_resources(
    root: &Path,
    resources: &BTreeMap<DedodeResourceKind, PathBuf>,
    inventory: &BTreeMap<PathBuf, PathBuf>,
) -> Result<BTreeMap<DedodeResourceKind, PathBuf>, DedodeRuntimeError> {
    resources
        .iter()
        .map(|(kind, path)| Ok((*kind, inventory_path(root, inventory, path)?)))
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerPreflight {
    schema_version: u32,
    python_version: String,
    torch_version: String,
    torchvision_version: String,
    dedode_imported: bool,
    network_disabled: bool,
}

fn probe_worker(
    executable: &Path,
    worker: &Path,
    source_root: &Path,
    expected_python: &str,
    expected_torch: &str,
    expected_torchvision: &str,
) -> Result<(), DedodeRuntimeError> {
    let mut command = Command::new(executable);
    command
        .arg("-I")
        .arg("-B")
        .arg("-s")
        .arg(worker)
        .arg("--preflight")
        .arg("--dedode-source")
        .arg(source_root)
        .env_clear()
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("DEDODE_NO_NETWORK", "1")
        .env("PYTHONHASHSEED", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    #[cfg(unix)]
    if let Some(python_root) = executable.parent().and_then(Path::parent) {
        command.env("LD_LIBRARY_PATH", python_root.join("lib"));
    }
    #[cfg(windows)]
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", system_root);
    }
    process_group::configure(&mut command);
    let output = command.output()?;
    if !output.status.success() {
        return Err(DedodeRuntimeError::WorkerProbeFailed(
            String::from_utf8_lossy(&output.stderr).trim().into(),
        ));
    }
    let probe: WorkerPreflight = serde_json::from_slice(&output.stdout)?;
    if probe.schema_version != 1
        || !probe.dedode_imported
        || !probe.network_disabled
        || probe.python_version != expected_python
        || probe.torch_version != expected_torch
        || probe.torchvision_version != expected_torchvision
    {
        return Err(DedodeRuntimeError::WorkerProbeMismatch(format!(
            "expected Python {expected_python}, torch {expected_torch}, torchvision {expected_torchvision}; observed Python {}, torch {}, torchvision {}",
            probe.python_version, probe.torch_version, probe.torchvision_version
        )));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OnnxWorkerPreflight {
    schema_version: u32,
    python_version: String,
    runtime_backend: String,
    runtime_version: String,
    numpy_version: String,
    pillow_version: String,
    dedode_imported: bool,
    network_disabled: bool,
}

fn probe_onnx_worker(
    executable: &Path,
    worker: &Path,
    model_root: &Path,
    expected_python: &str,
    expected_runtime: &str,
    expected_numpy: &str,
    expected_pillow: &str,
) -> Result<(), DedodeRuntimeError> {
    let mut command = Command::new(executable);
    command
        .arg("-I")
        .arg("-B")
        .arg("-s")
        .arg(worker)
        .arg("--preflight")
        .arg("--dedode-source")
        .arg(model_root)
        .env_clear()
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("DEDODE_NO_NETWORK", "1")
        .env("PYTHONHASHSEED", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    #[cfg(unix)]
    if let Some(python_root) = executable.parent().and_then(Path::parent) {
        command.env("LD_LIBRARY_PATH", python_root.join("lib"));
    }
    #[cfg(windows)]
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", system_root);
    }
    process_group::configure(&mut command);
    let output = command.output()?;
    if !output.status.success() {
        return Err(DedodeRuntimeError::WorkerProbeFailed(
            String::from_utf8_lossy(&output.stderr).trim().into(),
        ));
    }
    let probe: OnnxWorkerPreflight = serde_json::from_slice(&output.stdout)?;
    if probe.schema_version != 1
        || !probe.dedode_imported
        || !probe.network_disabled
        || probe.runtime_backend != "onnxruntime"
        || probe.python_version != expected_python
        || probe.runtime_version != expected_runtime
        || probe.numpy_version != expected_numpy
        || probe.pillow_version != expected_pillow
    {
        return Err(DedodeRuntimeError::WorkerProbeMismatch(format!(
            "expected Python {expected_python}, ONNX Runtime {expected_runtime}, NumPy {expected_numpy}, Pillow {expected_pillow}; observed Python {}, backend {} {}, NumPy {}, Pillow {}",
            probe.python_version,
            probe.runtime_backend,
            probe.runtime_version,
            probe.numpy_version,
            probe.pillow_version
        )));
    }
    Ok(())
}

fn official_resource_metadata(kind: DedodeResourceKind) -> (&'static str, &'static str) {
    match kind {
        DedodeResourceKind::DetectorV2Weights => ("https://github.com/Parskatt/DeDoDe/releases/download/v2/dedode_detector_L_v2.pth", "MIT"),
        DedodeResourceKind::DescriptorGWeights => ("https://github.com/Parskatt/DeDoDe/releases/download/dedode_pretrained_models/dedode_descriptor_G.pth", "MIT"),
        DedodeResourceKind::Dinov2VitL14Weights => ("https://dl.fbaipublicfiles.com/dinov2/dinov2_vitl14/dinov2_vitl14_pretrain.pth", "Apache-2.0"),
    }
}

fn verify_official_resource(
    kind: DedodeResourceKind,
    path: &Path,
) -> Result<(), DedodeRuntimeError> {
    let (expected_bytes, expected_sha256) = match kind {
        DedodeResourceKind::DetectorV2Weights => {
            (OFFICIAL_DETECTOR_BYTES, OFFICIAL_DETECTOR_SHA256)
        }
        DedodeResourceKind::DescriptorGWeights => {
            (OFFICIAL_DESCRIPTOR_BYTES, OFFICIAL_DESCRIPTOR_SHA256)
        }
        DedodeResourceKind::Dinov2VitL14Weights => (OFFICIAL_DINOV2_BYTES, OFFICIAL_DINOV2_SHA256),
    };
    let observed_bytes = fs::metadata(path)?.len();
    if observed_bytes != expected_bytes {
        return Err(DedodeRuntimeError::SizeMismatch {
            path: path.into(),
            expected: expected_bytes,
            observed: observed_bytes,
        });
    }
    let observed = hash_file(path, None)?;
    if observed.as_str() != expected_sha256 {
        return Err(DedodeRuntimeError::OfficialWeightPinMismatch(kind));
    }
    Ok(())
}

fn parse_match_container(
    path: &Path,
    request: &DedodeRunRequest,
) -> Result<Vec<DedodePairMatches>, DedodeRuntimeError> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut magic = [0_u8; 8];
    reader.read_exact(&mut magic)?;
    if &magic != MATCH_MAGIC {
        return Err(DedodeRuntimeError::InvalidMatchArtifact(
            "invalid magic".into(),
        ));
    }
    if read_u32(&mut reader)? != MATCH_SCHEMA_VERSION {
        return Err(DedodeRuntimeError::InvalidMatchArtifact(
            "unsupported schema version".into(),
        ));
    }
    let pair_count = read_u32(&mut reader)? as usize;
    if pair_count != request.pairs.len() {
        return Err(DedodeRuntimeError::InvalidMatchArtifact(
            "pair count differs from request".into(),
        ));
    }
    let requested = request
        .pairs
        .iter()
        .map(|pair| ((pair.image_a.clone(), pair.image_b.clone()), pair))
        .collect::<BTreeMap<_, _>>();
    let image_sizes = request
        .camera_images
        .iter()
        .map(|image| {
            let dimensions = image
                .metadata
                .inspected_photo
                .metadata
                .exif
                .dimensions
                .as_ref();
            (
                image.entity_id.0.as_str(),
                dimensions.map_or((u32::MAX, u32::MAX), |value| {
                    (value.width_pixels, value.height_pixels)
                }),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mask_rasters = request
        .image_mask_scope
        .as_ref()
        .map(|scope| {
            scope
                .masks
                .iter()
                .map(|mask| {
                    read_compute_mask_raster(&request.project_root, mask)
                        .map(|raster| (mask.image_entity_id.0.as_str(), raster))
                        .map_err(|error| DedodeRuntimeError::InvalidRequest(error.to_string()))
                })
                .collect::<Result<BTreeMap<_, _>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    let mut seen = BTreeSet::new();
    let mut output = Vec::with_capacity(pair_count);
    for _ in 0..pair_count {
        output.push(parse_pair_record(
            &mut reader,
            request,
            &requested,
            &image_sizes,
            &mask_rasters,
            &mut seen,
        )?);
    }
    if seen.len() != request.pairs.len() {
        return Err(DedodeRuntimeError::InvalidMatchArtifact(
            "artifact omits a requested pair".into(),
        ));
    }
    let mut trailing = [0_u8; 1];
    if reader.read(&mut trailing)? != 0 {
        return Err(DedodeRuntimeError::InvalidMatchArtifact(
            "artifact has trailing bytes".into(),
        ));
    }
    Ok(output)
}

fn parse_pair_record(
    reader: &mut impl Read,
    request: &DedodeRunRequest,
    requested: &BTreeMap<(String, String), &DedodeImagePair>,
    image_sizes: &BTreeMap<&str, (u32, u32)>,
    mask_rasters: &BTreeMap<&str, ImageMaskRaster>,
    seen: &mut BTreeSet<(String, String)>,
) -> Result<DedodePairMatches, DedodeRuntimeError> {
    let image_a = read_string(reader)?;
    let image_b = read_string(reader)?;
    let pair = requested
        .get(&(image_a.clone(), image_b.clone()))
        .ok_or_else(|| {
            DedodeRuntimeError::InvalidMatchArtifact(
                "artifact contains an unrequested or reordered pair".into(),
            )
        })?;
    if !seen.insert((image_a.clone(), image_b.clone())) {
        return Err(DedodeRuntimeError::InvalidMatchArtifact(
            "duplicate pair in artifact".into(),
        ));
    }
    let count = read_u32(reader)? as usize;
    if count > request.max_keypoints as usize {
        return Err(DedodeRuntimeError::InvalidMatchArtifact(
            "pair has more mutual matches than features".into(),
        ));
    }
    let (width_a, height_a) = image_sizes[image_a.as_str()];
    let (width_b, height_b) = image_sizes[image_b.as_str()];
    let mut matches = Vec::with_capacity(count);
    let mut feature_a = BTreeSet::new();
    let mut feature_b = BTreeSet::new();
    for _ in 0..count {
        let item = DedodeMatch {
            feature_a: read_u32(reader)?,
            feature_b: read_u32(reader)?,
            x_a: read_f32(reader)?,
            y_a: read_f32(reader)?,
            x_b: read_f32(reader)?,
            y_b: read_f32(reader)?,
            confidence: read_f32(reader)?,
        };
        if item.feature_a >= request.max_keypoints
            || item.feature_b >= request.max_keypoints
            || !feature_a.insert(item.feature_a)
            || !feature_b.insert(item.feature_b)
            || !coordinate_valid(item.x_a, width_a)
            || !coordinate_valid(item.y_a, height_a)
            || !coordinate_valid(item.x_b, width_b)
            || !coordinate_valid(item.y_b, height_b)
            || !item.confidence.is_finite()
            || !(0.0..=1.0).contains(&item.confidence)
        {
            return Err(DedodeRuntimeError::InvalidMatchArtifact(
                "invalid coordinate, confidence or non-mutual feature index".into(),
            ));
        }
        if coordinate_is_masked(mask_rasters.get(image_a.as_str()), item.x_a, item.y_a)
            || coordinate_is_masked(mask_rasters.get(image_b.as_str()), item.x_b, item.y_b)
        {
            continue;
        }
        matches.push(item);
    }
    Ok(DedodePairMatches {
        pair: (*pair).clone(),
        matches,
    })
}

fn coordinate_is_masked(mask: Option<&ImageMaskRaster>, x: f32, y: f32) -> bool {
    mask.is_some_and(|mask| {
        let x = x.floor().clamp(0.0, mask.width().saturating_sub(1) as f32) as u32;
        let y = y.floor().clamp(0.0, mask.height().saturating_sub(1) as f32) as u32;
        mask.is_masked(x, y)
    })
}

fn coordinate_valid(value: f32, extent: u32) -> bool {
    value.is_finite() && value >= -0.5 && f64::from(value) <= f64::from(extent) - 0.5
}

fn read_u32(reader: &mut impl Read) -> Result<u32, DedodeRuntimeError> {
    let mut bytes = [0_u8; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_f32(reader: &mut impl Read) -> Result<f32, DedodeRuntimeError> {
    Ok(f32::from_bits(read_u32(reader)?))
}

fn read_string(reader: &mut impl Read) -> Result<String, DedodeRuntimeError> {
    let length = read_u32(reader)? as usize;
    if length == 0 || length > 256 {
        return Err(DedodeRuntimeError::InvalidMatchArtifact(
            "invalid image ID length".into(),
        ));
    }
    let mut bytes = vec![0_u8; length];
    reader.read_exact(&mut bytes)?;
    let value = String::from_utf8(bytes)
        .map_err(|_| DedodeRuntimeError::InvalidMatchArtifact("image ID is not UTF-8".into()))?;
    validate_image_identifier("match image ID", &value)?;
    Ok(value)
}

fn validate_worker_result(
    request: &DedodeRunRequest,
    result: &DedodeWorkerResult,
) -> Result<(), DedodeRuntimeError> {
    if result.schema_version != RESULT_SCHEMA_VERSION
        || result.job_id != request.job_id
        || result.backend != "dedode-v2-g"
        || result.numeric_mode != "float32"
        || result.image_count as usize != request.camera_images.len()
        || result.pair_count as usize != request.pairs.len()
    {
        return Err(DedodeRuntimeError::InvalidWorkerResult(
            "identity, counts, backend or numeric mode differ from request".into(),
        ));
    }
    validate_relative_path(&result.matches_path, "matches output")?;
    validate_relative_path(&result.checkpoint_path, "checkpoint output")?;
    Ok(())
}

fn resolve_output(scratch: &Path, relative: &Path) -> Result<PathBuf, DedodeRuntimeError> {
    canonical_file_inside(&scratch.join(relative), scratch)
}

fn validate_component(field: &'static str, value: &str) -> Result<(), DedodeRuntimeError> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if valid && value != "." && value != ".." {
        Ok(())
    } else {
        Err(DedodeRuntimeError::InvalidRequest(format!(
            "{field} contains unsafe characters"
        )))
    }
}

fn validate_image_identifier(field: &'static str, value: &str) -> Result<(), DedodeRuntimeError> {
    let valid = !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'/' | b'\\'));
    if valid && value != "." && value != ".." {
        Ok(())
    } else {
        Err(DedodeRuntimeError::InvalidRequest(format!(
            "{field} contains unsafe characters"
        )))
    }
}

fn validate_relative_path(path: &Path, field: &'static str) -> Result<(), DedodeRuntimeError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        Err(DedodeRuntimeError::InvalidPath {
            path: path.into(),
            reason: format!("{field} must be a traversal-free relative path"),
        })
    } else {
        Ok(())
    }
}

fn validate_hash(hash: &ObjectHash, field: &'static str) -> Result<(), DedodeRuntimeError> {
    let value = hash.as_str();
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(DedodeRuntimeError::InvalidHash {
            field,
            value: value.into(),
        })
    }
}

fn canonical_file(path: &Path) -> Result<PathBuf, DedodeRuntimeError> {
    let canonical = path
        .canonicalize()
        .map_err(|error| DedodeRuntimeError::InvalidPath {
            path: path.into(),
            reason: error.to_string(),
        })?;
    if canonical.is_file() {
        Ok(canonical)
    } else {
        Err(DedodeRuntimeError::InvalidPath {
            path: canonical,
            reason: "expected a regular file".into(),
        })
    }
}

fn canonical_directory(path: &Path) -> Result<PathBuf, DedodeRuntimeError> {
    let canonical = path
        .canonicalize()
        .map_err(|error| DedodeRuntimeError::InvalidPath {
            path: path.into(),
            reason: error.to_string(),
        })?;
    if canonical.is_dir() {
        Ok(canonical)
    } else {
        Err(DedodeRuntimeError::InvalidPath {
            path: canonical,
            reason: "expected a directory".into(),
        })
    }
}

fn canonical_file_inside(path: &Path, root: &Path) -> Result<PathBuf, DedodeRuntimeError> {
    let canonical = canonical_file(path)?;
    if canonical.starts_with(root) {
        Ok(canonical)
    } else {
        Err(DedodeRuntimeError::PathOutsideTrustedRoot(canonical))
    }
}

fn canonical_directory_inside(path: &Path, root: &Path) -> Result<PathBuf, DedodeRuntimeError> {
    let canonical = canonical_directory(path)?;
    if canonical.starts_with(root) {
        Ok(canonical)
    } else {
        Err(DedodeRuntimeError::PathOutsideTrustedRoot(canonical))
    }
}

fn canonical_roots(paths: &[PathBuf]) -> Result<Vec<PathBuf>, DedodeRuntimeError> {
    let roots = paths
        .iter()
        .map(|path| canonical_directory(path))
        .collect::<Result<Vec<_>, _>>()?;
    if roots.is_empty() {
        Err(DedodeRuntimeError::InvalidConfig(
            "at least one allowed project root is required".into(),
        ))
    } else {
        Ok(roots)
    }
}

fn prepare_scratch_root(path: &Path) -> Result<PathBuf, DedodeRuntimeError> {
    fs::create_dir_all(path)?;
    canonical_directory(path)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, DedodeRuntimeError> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > limit {
        return Err(DedodeRuntimeError::InvalidConfig(format!(
            "{} exceeds trust-input limit",
            path.display()
        )));
    }
    let capacity = usize::try_from(metadata.len())
        .map_err(|_| DedodeRuntimeError::InvalidConfig("trust input is too large".into()))?;
    let mut bytes = Vec::with_capacity(capacity);
    File::open(path)?.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn hash_file(
    path: &Path,
    cancellation: Option<&CancellationToken>,
) -> Result<ObjectHash, DedodeRuntimeError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        if cancellation.is_some_and(CancellationToken::is_cancel_requested) {
            return Err(DedodeRuntimeError::Cancelled);
        }
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(ObjectHash(hex::encode(hasher.finalize())))
}

fn create_scratch(root: &Path, job_id: &str) -> Result<PathBuf, DedodeRuntimeError> {
    for _ in 0..100 {
        let sequence = NEXT_SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = root.join(format!("dedode-{job_id}-{}-{sequence}", std::process::id()));
        match fs::create_dir(&path) {
            Ok(()) => return canonical_directory(&path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(DedodeRuntimeError::Io(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate unique DeDoDe scratch directory",
    )))
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), DedodeRuntimeError> {
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value)?;
    fs::write(&temporary, bytes)?;
    fs::rename(temporary, path)?;
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
    line: String,
}

fn supervise_child<F>(
    child: &mut Child,
    cancellation: &CancellationToken,
    mut progress: F,
) -> Result<ProcessOutcome, DedodeRuntimeError>
where
    F: FnMut(u64, u64, &str),
{
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("worker stdout was not piped"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("worker stderr was not piped"))?;
    let (sender, receiver) = mpsc::channel();
    let out_reader = spawn_log_reader(stdout, "stdout", sender.clone());
    let err_reader = spawn_log_reader(stderr, "stderr", sender);
    let mut tail = VecDeque::with_capacity(LOG_TAIL_LINES);
    let status = loop {
        drain_events(&receiver, &mut tail, &mut progress);
        if cancellation.is_cancel_requested() {
            let _ = child.terminate_and_wait();
            let _ = out_reader.join();
            let _ = err_reader.join();
            return Err(DedodeRuntimeError::Cancelled);
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        match receiver.recv_timeout(CANCEL_POLL_INTERVAL) {
            Ok(event) => push_event(&mut tail, &mut progress, &event),
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {}
        }
    };
    let _ = out_reader.join();
    let _ = err_reader.join();
    drain_events(&receiver, &mut tail, &mut progress);
    Ok(ProcessOutcome {
        status,
        log_tail: tail.into_iter().collect(),
    })
}

fn spawn_log_reader<R: Read + Send + 'static>(
    reader: R,
    stream: &'static str,
    sender: mpsc::Sender<LogEvent>,
) -> thread::JoinHandle<io::Result<()>> {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            if reader.read_until(b'\n', &mut bytes)? == 0 {
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
            let _ = sender.send(LogEvent {
                stream,
                line: String::from_utf8_lossy(&bytes).into_owned(),
            });
        }
    })
}

fn drain_events<F: FnMut(u64, u64, &str)>(
    receiver: &mpsc::Receiver<LogEvent>,
    tail: &mut VecDeque<String>,
    progress: &mut F,
) {
    while let Ok(event) = receiver.try_recv() {
        push_event(tail, progress, &event);
    }
}

fn push_event<F: FnMut(u64, u64, &str)>(
    tail: &mut VecDeque<String>,
    progress: &mut F,
    event: &LogEvent,
) {
    if let Some(rest) = event.line.strip_prefix("HC_PROGRESS|") {
        let mut fields = rest.split('|');
        if let (Some(phase), Some(completed), Some(total), None) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        {
            if matches!(phase, "features" | "pairs") {
                if let (Ok(completed), Ok(total)) = (completed.parse(), total.parse()) {
                    progress(completed, total, phase);
                }
            }
        }
    }
    if tail.len() == LOG_TAIL_LINES {
        tail.pop_front();
    }
    tail.push_back(format!("{}: {}", event.stream, event.line));
}

/// `DeDoDe` trust, execution and artifact validation failures.
#[derive(Debug, Error)]
pub enum DedodeRuntimeError {
    #[error("invalid DeDoDe runtime configuration: {0}")]
    InvalidConfig(String),
    #[error("invalid DeDoDe request: {0}")]
    InvalidRequest(String),
    #[error("tool manifest signature was rejected: {0}")]
    SignatureRejected(String),
    #[error("unsupported DeDoDe manifest schema {0}")]
    UnsupportedManifestSchema(u32),
    #[error("invalid path {path}: {reason}")]
    InvalidPath { path: PathBuf, reason: String },
    #[error("path escapes its trusted root: {0}")]
    PathOutsideTrustedRoot(PathBuf),
    #[error("project directory is outside configured roots: {0}")]
    ProjectPathOutsideAllowedRoots(PathBuf),
    #[error("invalid {field} SHA-256 value: {value}")]
    InvalidHash { field: &'static str, value: String },
    #[error("SHA-256 mismatch for {path}: expected {expected:?}, observed {observed:?}")]
    HashMismatch {
        path: PathBuf,
        expected: ObjectHash,
        observed: ObjectHash,
    },
    #[error("byte-size mismatch for {path}: expected {expected}, observed {observed}")]
    SizeMismatch {
        path: PathBuf,
        expected: u64,
        observed: u64,
    },
    #[error("required model is missing: {0:?}")]
    MissingResource(DedodeResourceKind),
    #[error("official weight pin differs for {0:?}")]
    OfficialWeightPinMismatch(DedodeResourceKind),
    #[error("forbidden or unaudited license expression for {component}: {expression}")]
    ForbiddenLicense {
        component: String,
        expression: String,
    },
    #[error("worker preflight failed: {0}")]
    WorkerProbeFailed(String),
    #[error("worker preflight version/capability mismatch: {0}")]
    WorkerProbeMismatch(String),
    #[error("image materialization failed: {0}")]
    ImageMaterialization(String),
    #[error("worker failed with exit code {exit_code:?}: {message}")]
    WorkerFailed {
        exit_code: Option<i32>,
        message: String,
    },
    #[error("invalid worker result: {0}")]
    InvalidWorkerResult(String),
    #[error("invalid neutral match artifact: {0}")]
    InvalidMatchArtifact(String),
    #[error("required worker output is missing: {0}")]
    MissingOutput(PathBuf),
    #[error("DeDoDe worker cancellation was requested")]
    Cancelled,
    #[error("progress sink rejected update: {0}")]
    Progress(String),
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl From<DedodeRuntimeError> for JobWorkerError {
    fn from(error: DedodeRuntimeError) -> Self {
        match error {
            DedodeRuntimeError::Cancelled => Self::Cancelled,
            other => Self::Failed {
                code: match other {
                    DedodeRuntimeError::SignatureRejected(_)
                    | DedodeRuntimeError::HashMismatch { .. }
                    | DedodeRuntimeError::SizeMismatch { .. }
                    | DedodeRuntimeError::OfficialWeightPinMismatch(_)
                    | DedodeRuntimeError::ForbiddenLicense { .. } => "dedodeToolTrust",
                    DedodeRuntimeError::WorkerFailed { .. } => "dedodeWorker",
                    DedodeRuntimeError::InvalidWorkerResult(_)
                    | DedodeRuntimeError::InvalidMatchArtifact(_)
                    | DedodeRuntimeError::MissingOutput(_) => "invalidDedodeOutput",
                    DedodeRuntimeError::Progress(_) => "progressSink",
                    DedodeRuntimeError::Io(_) => "io",
                    DedodeRuntimeError::Json(_) => "json",
                    _ => "invalidInput",
                }
                .into(),
                message: other.to_string(),
            },
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{
        io::Write,
        time::{SystemTime, UNIX_EPOCH},
    };

    use himmelcad_core::{
        entity::EntityId,
        photolab_images::{DiscoveredPhoto, PhotoFormat, PhotoMetadata},
    };

    use super::*;
    use crate::image_commit::CameraImageMetadataRecord;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "himmelcad-dedode-{label}-{}-{nonce}",
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

    fn fake_camera(id: &str) -> ProjectCameraImageRecord {
        ProjectCameraImageRecord {
            entity_id: EntityId(id.into()),
            name: format!("{id}.jpg"),
            metadata_object_hash: ObjectHash::of_bytes(format!("metadata-{id}").as_bytes()),
            metadata: CameraImageMetadataRecord {
                schema_version: 1,
                source_object_hash: ObjectHash::of_bytes(format!("pixels-{id}").as_bytes()),
                transformation_object_hash: ObjectHash::of_bytes(b"transform"),
                inspected_photo: DiscoveredPhoto {
                    source_path: format!("/{id}.jpg"),
                    format: PhotoFormat::Jpeg,
                    byte_size: 1,
                    sha256: ObjectHash::of_bytes(format!("pixels-{id}").as_bytes()),
                    metadata: PhotoMetadata::default(),
                    capture_source: Default::default(),
                    decoder_capability: None,
                    position_prior: None,
                    derived_provenance: None,
                    duplicate_of: None,
                },
                projected_reference: None,
                status_tags: BTreeSet::new(),
            },
        }
    }

    fn request() -> DedodeRunRequest {
        DedodeRunRequest {
            job_id: "job-1".into(),
            project_root: "/project".into(),
            camera_images: vec![fake_camera("camera-a"), fake_camera("camera-b")],
            image_mask_scope: None,
            pairs: vec![DedodeImagePair {
                image_a: "camera-a".into(),
                image_b: "camera-b".into(),
            }],
            device: DedodeComputeDevice::Cpu,
            max_keypoints: 10_000,
            inference_width: 784,
            inference_height: 784,
            match_threshold: 0.01,
            match_block_size: 512,
            checkpoint_interval_pairs: 1,
        }
    }

    #[test]
    fn fake_worker_probe_passes_but_dev_runtime_rejects_fake_weights() {
        let directory = TestDirectory::new("fake-preflight");
        let source = directory.0.join("source");
        let scratch = directory.0.join("scratch");
        let projects = directory.0.join("projects");
        fs::create_dir_all(&source).expect("source");
        fs::create_dir_all(&scratch).expect("scratch");
        fs::create_dir_all(&projects).expect("projects");
        let worker = directory.0.join("fake_worker.py");
        fs::write(
            &worker,
            r#"import json, os, sys
print(json.dumps({"schemaVersion":1,"pythonVersion":".".join(map(str,sys.version_info[:3])),"torchVersion":"fake-torch","torchvisionVersion":"fake-vision","dedodeImported":True,"networkDisabled":os.environ.get("DEDODE_NO_NETWORK")=="1" and os.environ.get("HF_HUB_OFFLINE")=="1" and os.environ.get("TRANSFORMERS_OFFLINE")=="1"}))
"#,
        )
        .expect("fake worker");
        let python = String::from_utf8(
            Command::new("sh")
                .args(["-c", "command -v python3"])
                .output()
                .expect("find python")
                .stdout,
        )
        .expect("python path")
        .trim()
        .to_owned();
        let python_version = String::from_utf8(
            Command::new(&python)
                .args([
                    "-c",
                    "import sys;print('.'.join(map(str,sys.version_info[:3])))",
                ])
                .output()
                .expect("python version")
                .stdout,
        )
        .expect("version UTF-8")
        .trim()
        .to_owned();
        let weight = |name: &str| {
            let path = directory.0.join(name);
            fs::write(&path, name).expect("fake weight");
            path
        };
        probe_worker(
            Path::new(&python),
            &worker,
            &source,
            &python_version,
            "fake-torch",
            "fake-vision",
        )
        .expect("fake worker probe");
        let result = DedodeRuntime::development_preflight(&DevDedodeRuntimeConfig {
            python_executable: python.into(),
            worker_path: worker,
            dedode_source_root: source,
            detector_v2_weights: weight("detector.pth"),
            descriptor_g_weights: weight("descriptor.pth"),
            dinov2_vitl14_weights: weight("dinov2.pth"),
            expected_python_version: python_version,
            expected_torch_version: "fake-torch".into(),
            expected_torchvision_version: "fake-vision".into(),
            scratch_root: scratch,
            allowed_project_roots: vec![projects],
        });
        assert!(matches!(
            result,
            Err(DedodeRuntimeError::SizeMismatch { .. })
        ));
    }

    #[test]
    fn neutral_match_container_is_strictly_parsed() {
        let directory = TestDirectory::new("matches");
        let path = directory.0.join("matches.hcdm");
        let mut output = File::create(&path).expect("matches file");
        output.write_all(MATCH_MAGIC).expect("magic");
        output
            .write_all(&MATCH_SCHEMA_VERSION.to_le_bytes())
            .expect("schema");
        output.write_all(&1_u32.to_le_bytes()).expect("pair count");
        for id in ["camera-a", "camera-b"] {
            output
                .write_all(&(id.len() as u32).to_le_bytes())
                .expect("id length");
            output.write_all(id.as_bytes()).expect("id");
        }
        output.write_all(&1_u32.to_le_bytes()).expect("match count");
        output.write_all(&3_u32.to_le_bytes()).expect("feature a");
        output.write_all(&7_u32.to_le_bytes()).expect("feature b");
        for value in [10.0_f32, 20.0, 30.0, 40.0, 0.75] {
            output.write_all(&value.to_le_bytes()).expect("match value");
        }
        drop(output);
        let parsed = parse_match_container(&path, &request()).expect("valid matches");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].matches[0].feature_b, 7);
        assert_eq!(parsed[0].matches[0].confidence, 0.75);
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("reopen")
            .write_all(b"x")
            .expect("append");
        assert!(matches!(
            parse_match_container(&path, &request()),
            Err(DedodeRuntimeError::InvalidMatchArtifact(_))
        ));
    }

    #[test]
    fn neutral_match_container_accepts_portable_opaque_project_image_ids() {
        let image_a = format!("project:{}:image:{}", "a".repeat(64), "b".repeat(64));
        let image_b = format!("project:{}:image:{}", "c".repeat(64), "d".repeat(64));
        assert!(image_a.len() > 128);
        let mut request = request();
        request.camera_images = vec![fake_camera(&image_a), fake_camera(&image_b)];
        request.pairs = vec![DedodeImagePair {
            image_a: image_a.clone(),
            image_b: image_b.clone(),
        }];

        let directory = TestDirectory::new("opaque-image-ids");
        let path = directory.0.join("matches.hcdm");
        let mut output = File::create(&path).expect("matches file");
        output.write_all(MATCH_MAGIC).expect("magic");
        output
            .write_all(&MATCH_SCHEMA_VERSION.to_le_bytes())
            .expect("schema");
        output.write_all(&1_u32.to_le_bytes()).expect("pair count");
        for id in [&image_a, &image_b] {
            output
                .write_all(&(id.len() as u32).to_le_bytes())
                .expect("id length");
            output.write_all(id.as_bytes()).expect("id");
        }
        output.write_all(&0_u32.to_le_bytes()).expect("match count");
        drop(output);

        let parsed = parse_match_container(&path, &request).expect("valid opaque IDs");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].pair.image_a, image_a);
        assert_eq!(parsed[0].pair.image_b, image_b);
    }

    #[test]
    fn request_rejects_duplicate_or_unknown_pairs() {
        let mut duplicate = request();
        duplicate.pairs.push(DedodeImagePair {
            image_a: "camera-b".into(),
            image_b: "camera-a".into(),
        });
        assert!(duplicate.validate().is_err());
        let mut unknown = request();
        unknown.pairs[0].image_b = "camera-c".into();
        assert!(unknown.validate().is_err());
    }

    #[test]
    fn release_manifest_requires_exact_official_weight_origins() {
        let entries = [
            (
                DedodeResourceKind::DetectorV2Weights,
                "models/detector.pth",
                OFFICIAL_DETECTOR_BYTES,
                OFFICIAL_DETECTOR_SHA256,
            ),
            (
                DedodeResourceKind::DescriptorGWeights,
                "models/descriptor.pth",
                OFFICIAL_DESCRIPTOR_BYTES,
                OFFICIAL_DESCRIPTOR_SHA256,
            ),
            (
                DedodeResourceKind::Dinov2VitL14Weights,
                "models/dinov2.pth",
                OFFICIAL_DINOV2_BYTES,
                OFFICIAL_DINOV2_SHA256,
            ),
        ];
        let files = entries
            .iter()
            .map(|(kind, path, bytes, sha256)| {
                let (source_url, spdx_expression) = official_resource_metadata(*kind);
                DedodeFileRecord {
                    relative_path: PathBuf::from(path),
                    sha256: ObjectHash((*sha256).into()),
                    bytes: *bytes,
                    source_url: source_url.into(),
                    spdx_expression: spdx_expression.into(),
                }
            })
            .collect();
        let resources = entries
            .iter()
            .map(|(kind, path, _, _)| (*kind, PathBuf::from(path)))
            .collect();
        let mut manifest = DedodeToolManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            tool_id: "himmelcad-dedode-v2-g".into(),
            version: format!("v2-g+{DEDODE_CODE_COMMIT}"),
            python_version: "3.12.3".into(),
            torch_version: "2.5.1+cpu".into(),
            torchvision_version: "0.20.1+cpu".into(),
            executable_path: "python/bin/python".into(),
            worker_path: "worker/dedode_worker.py".into(),
            dedode_source_root: "source".into(),
            files,
            resources,
            licenses: vec![ToolLicenseRecord {
                component: "DeDoDe".into(),
                version: DEDODE_CODE_COMMIT.into(),
                spdx_expression: "MIT".into(),
            }],
        };
        validate_release_manifest(&manifest).expect("official weight manifest");
        manifest.files[0].source_url = "https://example.invalid/model.pth".into();
        assert!(matches!(
            validate_release_manifest(&manifest),
            Err(DedodeRuntimeError::OfficialWeightPinMismatch(_))
        ));
        manifest.files[0].source_url =
            official_resource_metadata(DedodeResourceKind::DetectorV2Weights)
                .0
                .into();
        manifest.torch_version = "2.5.x".into();
        assert!(validate_release_manifest(&manifest).is_err());
    }

    #[test]
    fn cancellation_force_kills_fake_worker_without_deadline_delay() {
        let _timing_guard = crate::CANCELLATION_TIMING_TEST_LOCK
            .lock()
            .expect("cancellation timing test lock");
        let mut command = Command::new("sh");
        command
            .args(["-c", "while :; do sleep 1; done"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = process_group::spawn(&mut command).expect("spawn slow fake worker");
        let cancellation = CancellationToken::new();
        cancellation.request_cancel();
        let started = Instant::now();
        let result = supervise_child(&mut child, &cancellation, |_, _, _| {});
        assert!(matches!(result, Err(DedodeRuntimeError::Cancelled)));
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}
