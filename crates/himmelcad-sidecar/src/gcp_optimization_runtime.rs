//! Durable execution wrapper for internal GCP georeferencing optimization.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_gcp::GcpOptimizationSnapshot;
use himmelcad_core::photolab_gcp_optimization::{
    optimize_gcp_bundle_alignment, GcpBundleTiePoint, GcpCameraModel, GcpOptimizationError,
    GcpOptimizationProgress, GcpOptimizationResult, GcpSolveControl, GcpSolverOptions,
};
use himmelcad_core::photolab_jobs::CancellationToken;
use serde::{Deserialize, Serialize};
use thiserror::Error;

static TEMPORARY_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Content-addressed request. The snapshot must already be committed in the project store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunGcpOptimizationParams {
    pub operation_id: String,
    pub snapshot_sha256: ObjectHash,
    pub cameras: Vec<GcpCameraModel>,
    #[serde(default)]
    pub tie_points: Vec<GcpBundleTiePoint>,
    #[serde(default)]
    pub options: GcpSolverOptions,
}

/// Solver output object, independent from a later manifest publication command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpOptimizationArtifact {
    pub schema_version: u32,
    pub solver: String,
    pub input_sha256: ObjectHash,
    pub snapshot_sha256: ObjectHash,
    pub result: GcpOptimizationResult,
}

/// Result returned to a job worker after atomically publishing the artifact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunGcpOptimizationResult {
    pub operation_id: String,
    pub input_sha256: ObjectHash,
    pub artifact_sha256: ObjectHash,
    pub checkpoint_path: PathBuf,
    pub artifact: GcpOptimizationArtifact,
}

/// Durable state from which UI can recover scope and progress after a process restart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpOptimizationCheckpoint {
    pub schema_version: u32,
    pub operation_id: String,
    pub input_sha256: ObjectHash,
    pub snapshot_sha256: ObjectHash,
    pub status: GcpOptimizationCheckpointStatus,
    pub progress: GcpOptimizationProgress,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_sha256: Option<ObjectHash>,
}

/// Terminality of the last atomically committed checkpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GcpOptimizationCheckpointStatus {
    Running,
    Cancelled,
    Completed,
}

/// Runs the CPU solver with cooperative cancellation and bounded checkpoint writes.
pub fn run_gcp_optimization<F>(
    project_root: &Path,
    params: RunGcpOptimizationParams,
    cancellation: &CancellationToken,
    mut progress_observer: F,
) -> Result<RunGcpOptimizationResult, GcpOptimizationRuntimeError>
where
    F: FnMut(&GcpOptimizationProgress),
{
    validate_operation_id(&params.operation_id)?;
    validate_hash(&params.snapshot_sha256)?;
    let snapshot = load_snapshot(project_root, &params.snapshot_sha256)?;
    let input_bytes = serde_json::to_vec(&(
        &params.snapshot_sha256,
        &params.cameras,
        &params.tie_points,
        params.options,
    ))?;
    let input_sha256 = ObjectHash::of_bytes(&input_bytes);
    let checkpoint_path = checkpoint_path(project_root, &params.operation_id);
    let initial_progress = GcpOptimizationProgress {
        phase: himmelcad_core::photolab_gcp_optimization::GcpOptimizationPhase::Validate,
        completed_units: 0,
        total_units: 1,
        iteration: None,
        objective: None,
    };
    let mut checkpoint = GcpOptimizationCheckpoint {
        schema_version: 1,
        operation_id: params.operation_id.clone(),
        input_sha256: input_sha256.clone(),
        snapshot_sha256: params.snapshot_sha256.clone(),
        status: GcpOptimizationCheckpointStatus::Running,
        progress: initial_progress,
        artifact_sha256: None,
    };
    atomic_write_json(&checkpoint_path, &checkpoint)?;

    let mut last_checkpoint_phase = initial_progress.phase;
    let mut last_checkpoint_iteration = None;
    let mut checkpoint_error = None;
    let solve = optimize_gcp_bundle_alignment(
        &snapshot,
        &params.cameras,
        &params.tie_points,
        params.options,
        |value| {
            progress_observer(&value);
            if cancellation.is_cancel_requested() {
                return GcpSolveControl::Cancel;
            }
            let should_checkpoint = value.phase != last_checkpoint_phase
                || value.iteration.is_some_and(|iteration| {
                    iteration % 5 == 0 && Some(iteration) != last_checkpoint_iteration
                });
            if should_checkpoint {
                checkpoint.progress = value;
                if let Err(error) = atomic_write_json(&checkpoint_path, &checkpoint) {
                    checkpoint_error = Some(error);
                    return GcpSolveControl::Cancel;
                }
                last_checkpoint_phase = value.phase;
                last_checkpoint_iteration = value.iteration;
            }
            GcpSolveControl::Continue
        },
    );
    if let Some(error) = checkpoint_error {
        return Err(error);
    }
    let result = match solve {
        Ok(result) => result,
        Err(GcpOptimizationError::Cancelled) => {
            checkpoint.status = GcpOptimizationCheckpointStatus::Cancelled;
            atomic_write_json(&checkpoint_path, &checkpoint)?;
            return Err(GcpOptimizationRuntimeError::Cancelled);
        }
        Err(error) => return Err(error.into()),
    };
    if cancellation.is_cancel_requested() {
        checkpoint.status = GcpOptimizationCheckpointStatus::Cancelled;
        atomic_write_json(&checkpoint_path, &checkpoint)?;
        return Err(GcpOptimizationRuntimeError::Cancelled);
    }
    let artifact = GcpOptimizationArtifact {
        schema_version: 3,
        solver: "himmelcad-weighted-robust-bundle-adjustment-v3-shared-intrinsics".into(),
        input_sha256: input_sha256.clone(),
        snapshot_sha256: params.snapshot_sha256,
        result,
    };
    let artifact_bytes = serde_json::to_vec(&artifact)?;
    let artifact_sha256 = ObjectHash::of_bytes(&artifact_bytes);
    publish_object(project_root, &artifact_sha256, &artifact_bytes)?;
    if cancellation.is_cancel_requested() {
        checkpoint.status = GcpOptimizationCheckpointStatus::Cancelled;
        atomic_write_json(&checkpoint_path, &checkpoint)?;
        return Err(GcpOptimizationRuntimeError::Cancelled);
    }
    checkpoint.status = GcpOptimizationCheckpointStatus::Completed;
    checkpoint.progress = GcpOptimizationProgress {
        phase: himmelcad_core::photolab_gcp_optimization::GcpOptimizationPhase::Complete,
        completed_units: 1,
        total_units: 1,
        iteration: Some(artifact.result.iterations),
        objective: Some(artifact.result.final_objective),
    };
    checkpoint.artifact_sha256 = Some(artifact_sha256.clone());
    atomic_write_json(&checkpoint_path, &checkpoint)?;
    Ok(RunGcpOptimizationResult {
        operation_id: params.operation_id,
        input_sha256,
        artifact_sha256,
        checkpoint_path,
        artifact,
    })
}

/// Reads and validates the durable checkpoint for recovery UI.
pub fn read_gcp_optimization_checkpoint(
    project_root: &Path,
    operation_id: &str,
) -> Result<Option<GcpOptimizationCheckpoint>, GcpOptimizationRuntimeError> {
    validate_operation_id(operation_id)?;
    let path = checkpoint_path(project_root, operation_id);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io_error("read GCP optimization checkpoint", &path, source)),
    };
    let checkpoint: GcpOptimizationCheckpoint = serde_json::from_slice(&bytes)?;
    if checkpoint.schema_version != 1 || checkpoint.operation_id != operation_id {
        return Err(GcpOptimizationRuntimeError::InvalidCheckpoint);
    }
    validate_hash(&checkpoint.input_sha256)?;
    validate_hash(&checkpoint.snapshot_sha256)?;
    if let Some(hash) = &checkpoint.artifact_sha256 {
        validate_hash(hash)?;
    }
    Ok(Some(checkpoint))
}

fn load_snapshot(
    project_root: &Path,
    hash: &ObjectHash,
) -> Result<GcpOptimizationSnapshot, GcpOptimizationRuntimeError> {
    let path = object_path(project_root, hash);
    let bytes = fs::read(&path).map_err(|source| io_error("read GCP snapshot", &path, source))?;
    if ObjectHash::of_bytes(&bytes) != *hash {
        return Err(GcpOptimizationRuntimeError::ObjectHashMismatch);
    }
    let snapshot: GcpOptimizationSnapshot = serde_json::from_slice(&bytes)?;
    Ok(snapshot)
}

fn publish_object(
    project_root: &Path,
    hash: &ObjectHash,
    bytes: &[u8],
) -> Result<(), GcpOptimizationRuntimeError> {
    let path = object_path(project_root, hash);
    if path.is_file() {
        let existing = fs::read(&path)
            .map_err(|source| io_error("verify GCP optimization object", &path, source))?;
        if ObjectHash::of_bytes(&existing) != *hash {
            return Err(GcpOptimizationRuntimeError::ObjectHashMismatch);
        }
        return Ok(());
    }
    atomic_write_bytes(&path, bytes)
}

fn checkpoint_path(project_root: &Path, operation_id: &str) -> PathBuf {
    project_root
        .join(".photolab")
        .join("jobs")
        .join("gcp-optimization")
        .join(operation_id)
        .join("checkpoint.json")
}

fn object_path(project_root: &Path, hash: &ObjectHash) -> PathBuf {
    let (prefix, remainder) = hash.as_str().split_at(2);
    project_root.join("objects").join(prefix).join(remainder)
}

fn validate_operation_id(value: &str) -> Result<(), GcpOptimizationRuntimeError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        Err(GcpOptimizationRuntimeError::InvalidOperationId)
    } else {
        Ok(())
    }
}

fn validate_hash(hash: &ObjectHash) -> Result<(), GcpOptimizationRuntimeError> {
    if hash.as_str().len() == 64 && hash.as_str().bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(GcpOptimizationRuntimeError::InvalidHash)
    }
}

fn atomic_write_json(
    path: &Path,
    value: &impl Serialize,
) -> Result<(), GcpOptimizationRuntimeError> {
    atomic_write_bytes(path, &serde_json::to_vec_pretty(value)?)
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), GcpOptimizationRuntimeError> {
    let parent = path
        .parent()
        .ok_or(GcpOptimizationRuntimeError::InvalidProjectPath)?;
    fs::create_dir_all(parent)
        .map_err(|source| io_error("create GCP optimization directory", parent, source))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("gcp-optimization"),
        TEMPORARY_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let write_result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(source) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(io_error(
            "write GCP optimization temporary",
            &temporary,
            source,
        ));
    }
    fs::rename(&temporary, path)
        .map_err(|source| io_error("publish GCP optimization file", path, source))?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| io_error("sync GCP optimization directory", parent, source))
}

fn io_error(
    action: &'static str,
    path: &Path,
    source: std::io::Error,
) -> GcpOptimizationRuntimeError {
    GcpOptimizationRuntimeError::Io {
        action,
        path: path.to_path_buf(),
        source,
    }
}

/// Durable optimization execution failure.
#[derive(Debug, Error)]
pub enum GcpOptimizationRuntimeError {
    #[error("invalid GCP optimization operation id")]
    InvalidOperationId,
    #[error("invalid SHA-256 object hash")]
    InvalidHash,
    #[error("invalid GCP optimization project path")]
    InvalidProjectPath,
    #[error("GCP object content does not match its hash")]
    ObjectHashMismatch,
    #[error("stored GCP optimization checkpoint is invalid")]
    InvalidCheckpoint,
    #[error("GCP optimization was cancelled")]
    Cancelled,
    #[error("GCP optimization failed: {0}")]
    Optimization(#[from] GcpOptimizationError),
    #[error("GCP optimization serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("{action} failed for {path}: {source}")]
    Io {
        action: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use himmelcad_core::photolab_gcp::{
        GcpCoordinate, GcpObservation, GcpObservationState, GcpOptimizationScope, GcpPoint,
        GcpPointId, GcpRole, GcpUncertainty, ImageCoordinate, OptimizationPointParticipation,
        OptimizationPointSnapshot,
    };
    use himmelcad_core::photolab_gcp_optimization::GcpOptimizationPhase;
    use himmelcad_core::photolab_matching::ImageId;

    struct Fixture {
        root: PathBuf,
        snapshot_sha256: ObjectHash,
        cameras: Vec<GcpCameraModel>,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "himmelcad-gcp-optimization-{}-{}",
                std::process::id(),
                TEMPORARY_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(root.join("objects")).expect("root");
            let cameras = vec![camera(1, -4.0), camera(2, 4.0), camera(3, 0.0)];
            let coordinates = [
                ("A", [-1.0, -1.0, 0.0], GcpRole::ControlXyz),
                ("B", [1.0, -1.0, 0.2], GcpRole::ControlXyz),
                ("C", [0.0, 1.0, -0.1], GcpRole::ControlXyz),
                ("D", [0.2, 0.1, 0.4], GcpRole::CheckpointXyz),
            ];
            let mut points = Vec::new();
            let mut observations = Vec::new();
            for (id, coordinate, role) in coordinates {
                let point = GcpPoint {
                    id: GcpPointId(id.into()),
                    name: id.into(),
                    coordinate: GcpCoordinate {
                        east_meters: 2.0 * coordinate[0] + 500.0,
                        north_meters: 2.0 * coordinate[1] + 600.0,
                        height_meters: 2.0 * coordinate[2] + 50.0,
                    },
                    uncertainty: GcpUncertainty {
                        horizontal_stddev_meters: 0.01,
                        height_stddev_meters: 0.02,
                    },
                    role,
                };
                for camera in &cameras {
                    observations.push(GcpObservation {
                        point_id: point.id.clone(),
                        image_id: camera.image_id,
                        state: GcpObservationState::Manual {
                            coordinate: project_for_fixture(camera, coordinate),
                        },
                    });
                }
                points.push(OptimizationPointSnapshot {
                    participation: if role.is_control() {
                        OptimizationPointParticipation::Control
                    } else {
                        OptimizationPointParticipation::Checkpoint
                    },
                    point,
                });
            }
            let snapshot = GcpOptimizationSnapshot {
                schema_version: 1,
                scope: GcpOptimizationScope {
                    label: "Fixture".into(),
                    point_ids: points.iter().map(|value| value.point.id.clone()).collect(),
                    camera_reference_image_ids: Vec::new(),
                },
                points,
                observations,
            };
            let bytes = serde_json::to_vec(&snapshot).expect("snapshot");
            let snapshot_sha256 = ObjectHash::of_bytes(&bytes);
            publish_object(&root, &snapshot_sha256, &bytes).expect("publish snapshot");
            Self {
                root,
                snapshot_sha256,
                cameras,
            }
        }

        fn params(&self, operation_id: &str) -> RunGcpOptimizationParams {
            RunGcpOptimizationParams {
                operation_id: operation_id.into(),
                snapshot_sha256: self.snapshot_sha256.clone(),
                cameras: self.cameras.clone(),
                tie_points: Vec::new(),
                options: GcpSolverOptions::default(),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn camera(id: u32, x: f64) -> GcpCameraModel {
        GcpCameraModel {
            image_id: ImageId(id),
            calibration_group_id: "runtime-test-camera".into(),
            intrinsics_policy: himmelcad_core::photolab_gcp_optimization::GcpIntrinsicsPolicy::Auto,
            width_pixels: 2000,
            height_pixels: 1500,
            focal_x_pixels: 1000.0,
            focal_y_pixels: 1000.0,
            principal_x_pixels: 1000.0,
            principal_y_pixels: 750.0,
            radial_distortion: [0.0; 3],
            tangential_distortion: [0.0; 2],
            camera_to_reconstruction_rotation: [1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, -1.0],
            center_reconstruction: [x, 0.0, 10.0],
            reference_center_world_meters: None,
            reference_stddev_meters: None,
        }
    }

    fn project_for_fixture(camera: &GcpCameraModel, point: [f64; 3]) -> ImageCoordinate {
        let offset = [
            point[0] - camera.center_reconstruction[0],
            point[1] - camera.center_reconstruction[1],
            point[2] - camera.center_reconstruction[2],
        ];
        let camera_point = [offset[0], -offset[1], -offset[2]];
        ImageCoordinate {
            x_pixels: camera.focal_x_pixels * camera_point[0] / camera_point[2]
                + camera.principal_x_pixels,
            y_pixels: camera.focal_y_pixels * camera_point[1] / camera_point[2]
                + camera.principal_y_pixels,
        }
    }

    #[test]
    fn publishes_content_addressed_result_and_completed_checkpoint() {
        let fixture = Fixture::new();
        let mut phases = Vec::new();
        let result = run_gcp_optimization(
            &fixture.root,
            fixture.params("job-1"),
            &CancellationToken::new(),
            |progress| phases.push(progress.phase),
        )
        .expect("run");
        assert!(object_path(&fixture.root, &result.artifact_sha256).is_file());
        let checkpoint = read_gcp_optimization_checkpoint(&fixture.root, "job-1")
            .expect("read")
            .expect("checkpoint");
        assert_eq!(
            checkpoint.status,
            GcpOptimizationCheckpointStatus::Completed
        );
        assert_eq!(checkpoint.artifact_sha256, Some(result.artifact_sha256));
        assert!(phases.contains(&GcpOptimizationPhase::Triangulate));
        assert!(result.artifact.result.statistics.checkpoint.is_some());
    }

    #[test]
    fn cancellation_never_publishes_a_partial_result() {
        let fixture = Fixture::new();
        let cancellation = CancellationToken::new();
        let error = run_gcp_optimization(
            &fixture.root,
            fixture.params("job-cancel"),
            &cancellation,
            |progress| {
                if progress.phase == GcpOptimizationPhase::Triangulate {
                    cancellation.request_cancel();
                }
            },
        )
        .expect_err("cancelled");
        assert!(matches!(error, GcpOptimizationRuntimeError::Cancelled));
        let checkpoint = read_gcp_optimization_checkpoint(&fixture.root, "job-cancel")
            .expect("read")
            .expect("checkpoint");
        assert_eq!(
            checkpoint.status,
            GcpOptimizationCheckpointStatus::Cancelled
        );
        assert!(checkpoint.artifact_sha256.is_none());
    }

    #[test]
    fn rejects_path_traversal_operation_id() {
        let fixture = Fixture::new();
        let error = run_gcp_optimization(
            &fixture.root,
            fixture.params("../escape"),
            &CancellationToken::new(),
            |_| {},
        )
        .expect_err("invalid id");
        assert!(matches!(
            error,
            GcpOptimizationRuntimeError::InvalidOperationId
        ));
    }

    #[test]
    fn refuses_tampered_snapshot_object() {
        let fixture = Fixture::new();
        let path = object_path(&fixture.root, &fixture.snapshot_sha256);
        fs::write(&path, b"tampered").expect("tamper");
        let error = run_gcp_optimization(
            &fixture.root,
            fixture.params("tampered"),
            &CancellationToken::new(),
            |_| {},
        )
        .expect_err("hash mismatch");
        assert!(matches!(
            error,
            GcpOptimizationRuntimeError::ObjectHashMismatch
        ));
    }
}
