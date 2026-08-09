//! Derived, non-publishing cache for immediate fixed-camera GCP estimates.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_gcp::GcpPointId;
use himmelcad_core::photolab_gcp_local_estimate::{
    camera_state_sha256, estimate_gcp_locally, GcpLocalEstimate, GcpLocalEstimateError,
    GcpLocalEstimateRequest,
};
use himmelcad_core::photolab_gcp_optimization::{GcpCameraModel, GcpRobustLoss};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::gcp_runtime::GcpCollectionRecord;

static TEMPORARY_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeGcpLocalEstimateParams {
    pub expected_collection_sha256: ObjectHash,
    pub point_id: GcpPointId,
    pub cameras: Vec<GcpCameraModel>,
    #[serde(default = "default_sigma_pixels")]
    pub observation_sigma_pixels: f64,
    #[serde(default)]
    pub robust_loss: GcpRobustLoss,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadGcpLocalEstimateParams {
    pub point_id: GcpPointId,
    pub cameras: Vec<GcpCameraModel>,
}

const fn default_sigma_pixels() -> f64 {
    0.25
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpLocalEstimateArtifact {
    pub schema_version: u32,
    pub artifact_sha256: ObjectHash,
    pub estimate: GcpLocalEstimate,
}

/// Computes and atomically caches an estimate bound to the exact collection and cameras.
pub fn compute_gcp_local_estimate(
    project_root: &Path,
    current_collection_sha256: &ObjectHash,
    collection: &GcpCollectionRecord,
    params: ComputeGcpLocalEstimateParams,
) -> Result<GcpLocalEstimateArtifact, GcpLocalEstimateRuntimeError> {
    if params.expected_collection_sha256 != *current_collection_sha256 {
        return Err(GcpLocalEstimateRuntimeError::StaleCollection {
            expected: params.expected_collection_sha256,
            actual: current_collection_sha256.clone(),
        });
    }
    if !collection
        .points
        .iter()
        .any(|record| record.point.id == params.point_id)
    {
        return Err(GcpLocalEstimateRuntimeError::UnknownPoint(params.point_id));
    }
    let estimate = estimate_gcp_locally(GcpLocalEstimateRequest {
        collection_sha256: current_collection_sha256.clone(),
        point_id: params.point_id,
        cameras: params.cameras,
        observations: collection.observations.clone(),
        observation_sigma_pixels: params.observation_sigma_pixels,
        robust_loss: params.robust_loss,
    })?;
    debug_assert!(!estimate.publishes_alignment);
    let estimate_bytes = serde_json::to_vec(&estimate)?;
    let artifact_sha256 = ObjectHash::of_bytes(&estimate_bytes);
    let artifact = GcpLocalEstimateArtifact {
        schema_version: 1,
        artifact_sha256,
        estimate,
    };
    let path = cache_path(project_root, &artifact);
    atomic_write_json(&path, &artifact)?;
    Ok(artifact)
}

/// Returns the current cached estimate only when both revision and camera state still match.
pub fn read_gcp_local_estimate(
    project_root: &Path,
    collection_sha256: &ObjectHash,
    point_id: &GcpPointId,
    cameras: &[GcpCameraModel],
) -> Result<Option<GcpLocalEstimateArtifact>, GcpLocalEstimateRuntimeError> {
    let camera_sha256 = camera_state_sha256(cameras)?;
    let directory = cache_directory(project_root, collection_sha256, &camera_sha256, point_id);
    let index_path = directory.join("current.json");
    let bytes = match fs::read(&index_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io_error("read local estimate", &index_path, source)),
    };
    let artifact: GcpLocalEstimateArtifact = serde_json::from_slice(&bytes)?;
    if artifact.schema_version != 1
        || artifact.estimate.collection_sha256 != *collection_sha256
        || artifact.estimate.camera_state_sha256 != camera_sha256
        || artifact.estimate.point_id != *point_id
        || artifact.estimate.publishes_alignment
        || ObjectHash::of_bytes(&serde_json::to_vec(&artifact.estimate)?)
            != artifact.artifact_sha256
    {
        return Err(GcpLocalEstimateRuntimeError::InvalidCache);
    }
    Ok(Some(artifact))
}

fn cache_path(project_root: &Path, artifact: &GcpLocalEstimateArtifact) -> PathBuf {
    cache_directory(
        project_root,
        &artifact.estimate.collection_sha256,
        &artifact.estimate.camera_state_sha256,
        &artifact.estimate.point_id,
    )
    .join("current.json")
}

fn cache_directory(
    project_root: &Path,
    collection_sha256: &ObjectHash,
    camera_sha256: &ObjectHash,
    point_id: &GcpPointId,
) -> PathBuf {
    let point_key = ObjectHash::of_bytes(point_id.0.as_bytes());
    project_root
        .join(".photolab")
        .join("derived")
        .join("gcp-local-estimates")
        .join(collection_sha256.as_str())
        .join(camera_sha256.as_str())
        .join(point_key.as_str())
}

fn atomic_write_json(
    path: &Path,
    value: &impl Serialize,
) -> Result<(), GcpLocalEstimateRuntimeError> {
    let parent = path
        .parent()
        .ok_or(GcpLocalEstimateRuntimeError::InvalidProjectPath)?;
    fs::create_dir_all(parent)
        .map_err(|source| io_error("create local estimate cache", parent, source))?;
    let temporary = parent.join(format!(
        ".local-estimate.{}.tmp",
        TEMPORARY_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let bytes = serde_json::to_vec_pretty(value)?;
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()
    })();
    if let Err(source) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(io_error("write local estimate", &temporary, source));
    }
    fs::rename(&temporary, path)
        .map_err(|source| io_error("publish local estimate", path, source))?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| io_error("sync local estimate cache", parent, source))
}

fn io_error(
    action: &'static str,
    path: &Path,
    source: std::io::Error,
) -> GcpLocalEstimateRuntimeError {
    GcpLocalEstimateRuntimeError::Io {
        action,
        path: path.to_path_buf(),
        source,
    }
}

#[derive(Debug, Error)]
pub enum GcpLocalEstimateRuntimeError {
    #[error("GCP collection changed (expected {expected:?}, actual {actual:?})")]
    StaleCollection {
        expected: ObjectHash,
        actual: ObjectHash,
    },
    #[error("unknown GCP {0:?}")]
    UnknownPoint(GcpPointId),
    #[error("invalid cached local GCP estimate")]
    InvalidCache,
    #[error("invalid project path")]
    InvalidProjectPath,
    #[error("local estimate failed: {0}")]
    Estimate(#[from] GcpLocalEstimateError),
    #[error("local estimate serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("failed to {action} at {path}: {source}")]
    Io {
        action: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}
