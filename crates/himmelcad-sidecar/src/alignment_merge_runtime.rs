//! Validation of an independently reconstructed, cross-flight sparse model.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use crate::colmap_runtime::{ColmapOutputSummary, ColmapRunOutcome};
use himmelcad_core::entity::EntityId;
use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_gcp_optimization::{GcpSimilarityTransform, OptimizedGcpCamera};
use himmelcad_core::photolab_jobs::CancellationToken;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// An input alignment and its immutable camera membership.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeInputScope {
    pub alignment_id: EntityId,
    pub camera_entity_ids: BTreeSet<String>,
}

/// Authoritative cross-run evidence measured from the solved COLMAP tracks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolvedOverlapEvidence {
    pub alignment_a: EntityId,
    pub alignment_b: EntityId,
    pub verified_cross_run_track_count: u64,
}

/// Validated camera registration and cross-run observations for publication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentMergeEvidenceReport {
    pub schema_version: u32,
    pub registered_camera_entity_ids: Vec<String>,
    pub overlap: Vec<SolvedOverlapEvidence>,
}

/// One independently optimized sparse block used by the shared-control assembly path.
pub struct SharedControlInput<'a> {
    pub alignment_id: &'a EntityId,
    pub dataset_root: &'a Path,
    pub camera_entity_ids: &'a BTreeSet<String>,
    pub transform: GcpSimilarityTransform,
    pub optimized_cameras: &'a [OptimizedGcpCamera],
}

/// Real sparse dataset assembled in the common survey frame established by shared controls.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedControlMergeOutcome {
    pub scratch_path: PathBuf,
    pub camera_entity_ids: Vec<String>,
    pub dataset_sha256: ObjectHash,
}

/// Durable boundary states. Partial COLMAP stages deliberately resume through its verified
/// feature cache; only a completely validated solver output can skip the solve on restart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AlignmentMergeCheckpointState {
    Running,
    Solved,
    Cancelled,
    Published,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentMergeCheckpoint {
    pub schema_version: u32,
    pub operation_id: String,
    pub merge_entity_id: EntityId,
    pub input_hash: ObjectHash,
    pub config_hash: ObjectHash,
    pub state: AlignmentMergeCheckpointState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scratch_relative_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_sha256: Option<ObjectHash>,
}

#[derive(Debug, Error)]
pub enum AlignmentMergeRuntimeError {
    #[error("alignment merge cancelled")]
    Cancelled,
    #[error("merge dataset is invalid: {0}")]
    InvalidDataset(String),
    #[error("merge dataset I/O failed at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("merge dataset JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
}

/// Atomically persists a merge checkpoint below the project job store.
pub fn write_merge_checkpoint(
    project_root: &Path,
    checkpoint: &AlignmentMergeCheckpoint,
) -> Result<(), AlignmentMergeRuntimeError> {
    validate_operation_id(&checkpoint.operation_id)?;
    let path = merge_checkpoint_path(project_root, &checkpoint.operation_id);
    let parent = path.parent().ok_or_else(|| {
        AlignmentMergeRuntimeError::InvalidDataset("checkpoint has no parent".into())
    })?;
    fs::create_dir_all(parent).map_err(|source| AlignmentMergeRuntimeError::Io {
        path: parent.to_path_buf(),
        source,
    })?;
    let bytes = serde_json::to_vec(checkpoint)?;
    let temporary = path.with_extension("json.pending");
    fs::write(&temporary, bytes).map_err(|source| AlignmentMergeRuntimeError::Io {
        path: temporary.clone(),
        source,
    })?;
    fs::rename(&temporary, &path).map_err(|source| AlignmentMergeRuntimeError::Io { path, source })
}

/// Returns a hash-compatible solved output. A checkpoint for the same operation with different
/// immutable inputs is rejected instead of silently reused.
pub fn resume_solved_merge(
    project_root: &Path,
    operation_id: &str,
    merge_entity_id: &EntityId,
    input_hash: &ObjectHash,
    config_hash: &ObjectHash,
) -> Result<Option<ColmapRunOutcome>, AlignmentMergeRuntimeError> {
    validate_operation_id(operation_id)?;
    let path = merge_checkpoint_path(project_root, operation_id);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(AlignmentMergeRuntimeError::Io { path, source }),
    };
    let checkpoint: AlignmentMergeCheckpoint = serde_json::from_slice(&bytes)?;
    if checkpoint.schema_version != 1
        || checkpoint.operation_id != operation_id
        || checkpoint.merge_entity_id != *merge_entity_id
        || checkpoint.input_hash != *input_hash
        || checkpoint.config_hash != *config_hash
    {
        return Err(AlignmentMergeRuntimeError::InvalidDataset(
            "alignment merge checkpoint is incompatible with the immutable job request".into(),
        ));
    }
    if checkpoint.state != AlignmentMergeCheckpointState::Solved {
        return Ok(None);
    }
    let relative = checkpoint.scratch_relative_path.ok_or_else(|| {
        AlignmentMergeRuntimeError::InvalidDataset("solved checkpoint has no scratch path".into())
    })?;
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(AlignmentMergeRuntimeError::InvalidDataset(
            "merge checkpoint scratch path escaped the project".into(),
        ));
    }
    let scratch_path = project_root
        .join(relative)
        .canonicalize()
        .map_err(|source| AlignmentMergeRuntimeError::Io {
            path: project_root.to_path_buf(),
            source,
        })?;
    let project = project_root
        .canonicalize()
        .map_err(|source| AlignmentMergeRuntimeError::Io {
            path: project_root.to_path_buf(),
            source,
        })?;
    if !scratch_path.starts_with(project) {
        return Err(AlignmentMergeRuntimeError::InvalidDataset(
            "merge checkpoint scratch path escaped the project".into(),
        ));
    }
    let summary_path = scratch_path.join("output-summary.json");
    let summary_bytes = read(&summary_path)?;
    let observed = ObjectHash::of_bytes(&summary_bytes);
    let expected = checkpoint.summary_sha256.ok_or_else(|| {
        AlignmentMergeRuntimeError::InvalidDataset("solved checkpoint has no summary hash".into())
    })?;
    if observed != expected {
        return Err(AlignmentMergeRuntimeError::InvalidDataset(
            "solved merge summary hash mismatch".into(),
        ));
    }
    let summary: ColmapOutputSummary = serde_json::from_slice(&summary_bytes)?;
    Ok(Some(ColmapRunOutcome {
        scratch_path,
        summary_path,
        summary_sha256: observed,
        summary,
        sparse_potree: None,
        prepared_mesh: None,
        prepared_textured_mesh: None,
    }))
}

/// Resumes a fully assembled shared-control dataset after a crash before manifest publication.
pub fn resume_shared_control_merge(
    project_root: &Path,
    operation_id: &str,
    merge_entity_id: &EntityId,
    input_hash: &ObjectHash,
    config_hash: &ObjectHash,
) -> Result<Option<SharedControlMergeOutcome>, AlignmentMergeRuntimeError> {
    validate_operation_id(operation_id)?;
    let path = merge_checkpoint_path(project_root, operation_id);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(AlignmentMergeRuntimeError::Io { path, source }),
    };
    let checkpoint: AlignmentMergeCheckpoint = serde_json::from_slice(&bytes)?;
    if checkpoint.schema_version != 1
        || checkpoint.operation_id != operation_id
        || checkpoint.merge_entity_id != *merge_entity_id
        || checkpoint.input_hash != *input_hash
        || checkpoint.config_hash != *config_hash
    {
        return Err(AlignmentMergeRuntimeError::InvalidDataset(
            "alignment merge checkpoint is incompatible with the immutable job request".into(),
        ));
    }
    if checkpoint.state != AlignmentMergeCheckpointState::Solved {
        return Ok(None);
    }
    let relative = checkpoint.scratch_relative_path.ok_or_else(|| {
        AlignmentMergeRuntimeError::InvalidDataset(
            "solved shared-control checkpoint has no dataset path".into(),
        )
    })?;
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(AlignmentMergeRuntimeError::InvalidDataset(
            "shared-control checkpoint escaped the project".into(),
        ));
    }
    let scratch_path = project_root
        .join(relative)
        .canonicalize()
        .map_err(|source| AlignmentMergeRuntimeError::Io {
            path: project_root.to_path_buf(),
            source,
        })?;
    let project = project_root
        .canonicalize()
        .map_err(|source| AlignmentMergeRuntimeError::Io {
            path: project_root.to_path_buf(),
            source,
        })?;
    if !scratch_path.starts_with(project) {
        return Err(AlignmentMergeRuntimeError::InvalidDataset(
            "shared-control checkpoint escaped the project".into(),
        ));
    }
    let dataset_sha256 = shared_dataset_hash(&scratch_path)?;
    if checkpoint.summary_sha256.as_ref() != Some(&dataset_sha256) {
        return Err(AlignmentMergeRuntimeError::InvalidDataset(
            "shared-control checkpoint dataset hash mismatch".into(),
        ));
    }
    let map: Vec<CameraMapEntry> =
        serde_json::from_slice(&read(&scratch_path.join("camera-map.json"))?)?;
    let camera_entity_ids = map
        .into_iter()
        .map(|entry| entry.entity_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Ok(Some(SharedControlMergeOutcome {
        scratch_path,
        camera_entity_ids,
        dataset_sha256,
    }))
}

fn merge_checkpoint_path(project_root: &Path, operation_id: &str) -> PathBuf {
    project_root
        .join(".photolab/jobs/alignment-merge")
        .join(operation_id)
        .join("checkpoint.json")
}

fn validate_operation_id(operation_id: &str) -> Result<(), AlignmentMergeRuntimeError> {
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_'))
    {
        return Err(AlignmentMergeRuntimeError::InvalidDataset(
            "invalid alignment merge operation id".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CameraMapEntry {
    entity_id: String,
    image_name: PathBuf,
}

/// Combines independently GCP-optimized blocks without inventing cross-block observations.
/// Camera extrinsics come from each published optimization; sparse points use the same published
/// similarity. Intrinsics and observations remain those of their source calibration block.
pub fn build_shared_control_merge(
    project_root: &Path,
    operation_id: &str,
    inputs: &[SharedControlInput<'_>],
    cancellation: &CancellationToken,
) -> Result<SharedControlMergeOutcome, AlignmentMergeRuntimeError> {
    validate_operation_id(operation_id)?;
    if inputs.len() < 2 {
        return Err(AlignmentMergeRuntimeError::InvalidDataset(
            "shared-control assembly needs at least two optimized blocks".into(),
        ));
    }
    let scratch = project_root
        .join(".photolab/scratch/alignment-merge")
        .join(operation_id);
    if scratch.exists() {
        fs::remove_dir_all(&scratch).map_err(|source| AlignmentMergeRuntimeError::Io {
            path: scratch.clone(),
            source,
        })?;
    }
    let view = scratch.join("sparse-view-source");
    let aligned = scratch.join("sparse-aligned");
    let images_root = scratch.join("images");
    fs::create_dir_all(&view).map_err(|source| AlignmentMergeRuntimeError::Io {
        path: view.clone(),
        source,
    })?;
    fs::create_dir_all(&aligned).map_err(|source| AlignmentMergeRuntimeError::Io {
        path: aligned.clone(),
        source,
    })?;
    fs::create_dir_all(&images_root).map_err(|source| AlignmentMergeRuntimeError::Io {
        path: images_root.clone(),
        source,
    })?;

    let mut cameras_out =
        String::from("# Shared-control sparse blocks; intrinsics remain independent\n");
    let mut images_out = String::from("# Camera poses are published GCP-optimized extrinsics\n");
    let mut points_out =
        String::from("# Sparse points transformed independently into the common survey frame\n");
    let mut map_out = Vec::<serde_json::Value>::new();
    let mut assigned = BTreeSet::new();
    let mut next_camera_id = 1_u64;
    let mut next_image_id = 1_u64;
    let mut next_point_id = 1_u64;

    for input in inputs {
        cancellation
            .check()
            .map_err(|_| AlignmentMergeRuntimeError::Cancelled)?;
        if !input.transform.scale.is_finite()
            || input.transform.scale <= 0.0
            || input
                .transform
                .rotation
                .iter()
                .chain(input.transform.translation_meters.iter())
                .any(|value| !value.is_finite())
        {
            return Err(AlignmentMergeRuntimeError::InvalidDataset(format!(
                "GCP transform for {} is invalid",
                input.alignment_id.0
            )));
        }
        let source_map: Vec<CameraMapEntry> =
            serde_json::from_slice(&read(&input.dataset_root.join("camera-map.json"))?)?;
        let entity_by_name = source_map
            .into_iter()
            .map(|entry| (normalized_name(&entry.image_name), entry.entity_id))
            .collect::<BTreeMap<_, _>>();
        let camera_lines = data_lines(&input.dataset_root.join("sparse-view-source/cameras.txt"))?;
        let image_lines = data_lines(&input.dataset_root.join("sparse-view-source/images.txt"))?;
        let point_lines = data_lines(&input.dataset_root.join("sparse-view-source/points3D.txt"))?;
        if image_lines.len() % 2 != 0 {
            return Err(AlignmentMergeRuntimeError::InvalidDataset(
                "source images.txt is truncated".into(),
            ));
        }
        let mut camera_ids = BTreeMap::new();
        for line in camera_lines {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 5 {
                return Err(AlignmentMergeRuntimeError::InvalidDataset(
                    "source camera row is truncated".into(),
                ));
            }
            let old = fields[0].parse::<u64>().map_err(|_| {
                AlignmentMergeRuntimeError::InvalidDataset("invalid source camera id".into())
            })?;
            let new = next_camera_id;
            next_camera_id += 1;
            camera_ids.insert(old, new);
            cameras_out.push_str(&format!("{} {}\n", new, fields[1..].join(" ")));
        }
        let mut image_ids = BTreeMap::new();
        let mut point_ids = BTreeMap::new();
        for line in &point_lines {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 8 {
                return Err(AlignmentMergeRuntimeError::InvalidDataset(
                    "source point row is truncated".into(),
                ));
            }
            point_ids.insert(
                fields[0].parse::<u64>().map_err(|_| {
                    AlignmentMergeRuntimeError::InvalidDataset("invalid source point id".into())
                })?,
                next_point_id,
            );
            next_point_id += 1;
        }
        for record in image_lines.chunks_exact(2) {
            let fields = record[0].split_whitespace().collect::<Vec<_>>();
            if fields.len() < 10 {
                return Err(AlignmentMergeRuntimeError::InvalidDataset(
                    "source image row is truncated".into(),
                ));
            }
            let old_image_id = fields[0].parse::<u64>().map_err(|_| {
                AlignmentMergeRuntimeError::InvalidDataset("invalid source image id".into())
            })?;
            let old_camera_id = fields[8].parse::<u64>().map_err(|_| {
                AlignmentMergeRuntimeError::InvalidDataset("invalid source image camera id".into())
            })?;
            let entity_id = entity_by_name
                .get(&normalized_name(Path::new(fields[9])))
                .ok_or_else(|| {
                    AlignmentMergeRuntimeError::InvalidDataset(format!(
                        "source image {} has no camera map",
                        fields[9]
                    ))
                })?;
            if !input.camera_entity_ids.contains(entity_id) || !assigned.insert(entity_id.clone()) {
                return Err(AlignmentMergeRuntimeError::InvalidDataset(
                    "shared-control input scopes overlap or differ from their camera maps".into(),
                ));
            }
            let optimized = input
                .optimized_cameras
                .iter()
                .find(|camera| u64::from(camera.image_id.0) == old_image_id)
                .ok_or_else(|| {
                    AlignmentMergeRuntimeError::InvalidDataset(format!(
                        "GCP optimization has no camera pose for {entity_id}"
                    ))
                })?;
            let (qvec, tvec) = colmap_pose(optimized)?;
            let new_image_id = next_image_id;
            next_image_id += 1;
            image_ids.insert(old_image_id, new_image_id);
            let relative = PathBuf::from(format!("{new_image_id:08}/image.jpg"));
            let target = images_root.join(&relative);
            fs::create_dir_all(target.parent().unwrap()).map_err(|source| {
                AlignmentMergeRuntimeError::Io {
                    path: target.clone(),
                    source,
                }
            })?;
            let source = input.dataset_root.join("images").join(fields[9]);
            fs::copy(&source, &target).map_err(|source_error| AlignmentMergeRuntimeError::Io {
                path: source,
                source: source_error,
            })?;
            let camera_id = camera_ids.get(&old_camera_id).ok_or_else(|| {
                AlignmentMergeRuntimeError::InvalidDataset(
                    "image references missing source camera".into(),
                )
            })?;
            images_out.push_str(&format!(
                "{} {:.17} {:.17} {:.17} {:.17} {:.17} {:.17} {:.17} {} {}\n",
                new_image_id,
                qvec[0],
                qvec[1],
                qvec[2],
                qvec[3],
                tvec[0],
                tvec[1],
                tvec[2],
                camera_id,
                normalized_name(&relative)
            ));
            let observations = record[1].split_whitespace().collect::<Vec<_>>();
            if observations.len() % 3 != 0 {
                return Err(AlignmentMergeRuntimeError::InvalidDataset(
                    "source observation row is truncated".into(),
                ));
            }
            let mut rewritten = Vec::with_capacity(observations.len());
            for observation in observations.chunks_exact(3) {
                rewritten.push(observation[0].to_owned());
                rewritten.push(observation[1].to_owned());
                let old_point = observation[2].parse::<i64>().map_err(|_| {
                    AlignmentMergeRuntimeError::InvalidDataset(
                        "invalid observation point id".into(),
                    )
                })?;
                rewritten.push(if old_point < 0 {
                    "-1".into()
                } else {
                    point_ids
                        .get(&(old_point as u64))
                        .ok_or_else(|| {
                            AlignmentMergeRuntimeError::InvalidDataset(
                                "observation references missing point".into(),
                            )
                        })?
                        .to_string()
                });
            }
            images_out.push_str(&rewritten.join(" "));
            images_out.push('\n');
            map_out.push(
                serde_json::json!({"entityId": entity_id, "imageName": normalized_name(&relative)}),
            );
        }
        for line in point_lines {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            let old_id = fields[0].parse::<u64>().map_err(|_| {
                AlignmentMergeRuntimeError::InvalidDataset("invalid point id".into())
            })?;
            let source_point = [
                parse_f64(fields[1])?,
                parse_f64(fields[2])?,
                parse_f64(fields[3])?,
            ];
            let world = input.transform.apply(source_point);
            let mut rewritten = vec![
                point_ids[&old_id].to_string(),
                world[0].to_string(),
                world[1].to_string(),
                world[2].to_string(),
            ];
            rewritten.extend(fields[4..8].iter().map(|value| (*value).to_owned()));
            if (fields.len() - 8) % 2 != 0 {
                return Err(AlignmentMergeRuntimeError::InvalidDataset(
                    "source point track is truncated".into(),
                ));
            }
            for pair in fields[8..].chunks_exact(2) {
                let old_image = pair[0].parse::<u64>().map_err(|_| {
                    AlignmentMergeRuntimeError::InvalidDataset(
                        "invalid point track image id".into(),
                    )
                })?;
                rewritten.push(
                    image_ids
                        .get(&old_image)
                        .ok_or_else(|| {
                            AlignmentMergeRuntimeError::InvalidDataset(
                                "point track references missing image".into(),
                            )
                        })?
                        .to_string(),
                );
                rewritten.push(pair[1].to_owned());
            }
            points_out.push_str(&rewritten.join(" "));
            points_out.push('\n');
        }
    }
    let expected = inputs
        .iter()
        .flat_map(|input| input.camera_entity_ids.iter().cloned())
        .collect::<BTreeSet<_>>();
    if assigned != expected {
        return Err(AlignmentMergeRuntimeError::InvalidDataset(
            "shared-control assembly did not publish the exact camera scope".into(),
        ));
    }
    for root in [&view, &aligned] {
        write_text(&root.join("cameras.txt"), &cameras_out)?;
        write_text(&root.join("images.txt"), &images_out)?;
        write_text(&root.join("points3D.txt"), &points_out)?;
    }
    let map_bytes = serde_json::to_vec_pretty(&map_out)?;
    fs::write(scratch.join("camera-map.json"), &map_bytes).map_err(|source| {
        AlignmentMergeRuntimeError::Io {
            path: scratch.join("camera-map.json"),
            source,
        }
    })?;
    write_text(
        &scratch.join("image-list.txt"),
        &map_out
            .iter()
            .map(|entry| entry["imageName"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n"),
    )?;
    let dataset_sha256 = shared_dataset_hash(&scratch)?;
    Ok(SharedControlMergeOutcome {
        scratch_path: scratch,
        camera_entity_ids: assigned.into_iter().collect(),
        dataset_sha256,
    })
}

fn shared_dataset_hash(root: &Path) -> Result<ObjectHash, AlignmentMergeRuntimeError> {
    Ok(ObjectHash::of_bytes(&serde_json::to_vec(&(
        ObjectHash::of_bytes(&read(&root.join("sparse-aligned/cameras.txt"))?),
        ObjectHash::of_bytes(&read(&root.join("sparse-aligned/images.txt"))?),
        ObjectHash::of_bytes(&read(&root.join("sparse-aligned/points3D.txt"))?),
        ObjectHash::of_bytes(&read(&root.join("camera-map.json"))?),
    ))?))
}

fn data_lines(path: &Path) -> Result<Vec<String>, AlignmentMergeRuntimeError> {
    Ok(lines(path)?
        .into_iter()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect())
}
fn parse_f64(value: &str) -> Result<f64, AlignmentMergeRuntimeError> {
    value
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
        .ok_or_else(|| {
            AlignmentMergeRuntimeError::InvalidDataset("invalid finite coordinate".into())
        })
}
fn write_text(path: &Path, value: &str) -> Result<(), AlignmentMergeRuntimeError> {
    fs::write(path, value.as_bytes()).map_err(|source| AlignmentMergeRuntimeError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn colmap_pose(
    camera: &OptimizedGcpCamera,
) -> Result<([f64; 4], [f64; 3]), AlignmentMergeRuntimeError> {
    if camera
        .center_world_meters
        .iter()
        .chain(camera.camera_to_world_rotation.iter())
        .any(|v| !v.is_finite())
    {
        return Err(AlignmentMergeRuntimeError::InvalidDataset(
            "optimized camera pose is not finite".into(),
        ));
    }
    let r = camera.camera_to_world_rotation;
    let world_to_camera = [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
    let c = camera.center_world_meters;
    let t = [
        -(world_to_camera[0] * c[0] + world_to_camera[1] * c[1] + world_to_camera[2] * c[2]),
        -(world_to_camera[3] * c[0] + world_to_camera[4] * c[1] + world_to_camera[5] * c[2]),
        -(world_to_camera[6] * c[0] + world_to_camera[7] * c[1] + world_to_camera[8] * c[2]),
    ];
    Ok((matrix_quaternion(world_to_camera), t))
}

fn matrix_quaternion(m: [f64; 9]) -> [f64; 4] {
    let trace = m[0] + m[4] + m[8];
    let (w, x, y, z) = if trace > 0.0 {
        let s = (trace + 1.0).sqrt() * 2.0;
        (
            0.25 * s,
            (m[7] - m[5]) / s,
            (m[2] - m[6]) / s,
            (m[3] - m[1]) / s,
        )
    } else if m[0] > m[4] && m[0] > m[8] {
        let s = (1.0 + m[0] - m[4] - m[8]).sqrt() * 2.0;
        (
            (m[7] - m[5]) / s,
            0.25 * s,
            (m[1] + m[3]) / s,
            (m[2] + m[6]) / s,
        )
    } else if m[4] > m[8] {
        let s = (1.0 + m[4] - m[0] - m[8]).sqrt() * 2.0;
        (
            (m[2] - m[6]) / s,
            (m[1] + m[3]) / s,
            0.25 * s,
            (m[5] + m[7]) / s,
        )
    } else {
        let s = (1.0 + m[8] - m[0] - m[4]).sqrt() * 2.0;
        (
            (m[3] - m[1]) / s,
            (m[2] + m[6]) / s,
            (m[5] + m[7]) / s,
            0.25 * s,
        )
    };
    let norm = (w * w + x * x + y * y + z * z).sqrt();
    [w / norm, x / norm, y / norm, z / norm]
}

/// Reads actual registered images and triangulated tracks from a solved model.
pub fn inspect_solved_merge(
    dataset_root: &Path,
    inputs: &[MergeInputScope],
    expected_camera_ids: &BTreeSet<String>,
) -> Result<AlignmentMergeEvidenceReport, AlignmentMergeRuntimeError> {
    if inputs.len() < 2 {
        return Err(AlignmentMergeRuntimeError::InvalidDataset(
            "at least two input scopes are required".into(),
        ));
    }
    let map_path = dataset_root.join("camera-map.json");
    let camera_map: Vec<CameraMapEntry> = serde_json::from_slice(&read(&map_path)?)?;
    let entity_by_image = camera_map
        .into_iter()
        .map(|entry| (normalized_name(&entry.image_name), entry.entity_id))
        .collect::<BTreeMap<_, _>>();
    let model_root = dataset_root.join("sparse-view-source");
    let image_names = parse_registered_images(&model_root.join("images.txt"))?;
    let registered = image_names
        .values()
        .map(|name| {
            entity_by_image
                .get(&normalized_name(name))
                .cloned()
                .ok_or_else(|| {
                    AlignmentMergeRuntimeError::InvalidDataset(format!(
                        "registered image {} has no immutable camera mapping",
                        name.display()
                    ))
                })
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    if &registered != expected_camera_ids {
        let missing = expected_camera_ids
            .difference(&registered)
            .cloned()
            .collect::<Vec<_>>();
        let unexpected = registered
            .difference(expected_camera_ids)
            .cloned()
            .collect::<Vec<_>>();
        return Err(AlignmentMergeRuntimeError::InvalidDataset(format!(
            "joint solve did not register the exact merge scope (missing: {}; unexpected: {})",
            missing.join(", "),
            unexpected.join(", ")
        )));
    }

    let input_index_by_camera = inputs
        .iter()
        .enumerate()
        .flat_map(|(index, input)| {
            input
                .camera_entity_ids
                .iter()
                .map(move |camera| (camera.as_str(), index))
        })
        .fold(
            HashMap::<&str, Vec<usize>>::new(),
            |mut map, (camera, index)| {
                map.entry(camera).or_default().push(index);
                map
            },
        );
    let points_path = model_root.join("points3D.txt");
    let mut pair_counts = BTreeMap::<(usize, usize), u64>::new();
    for line in lines(&points_path)? {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 10 || (fields.len() - 8) % 2 != 0 {
            return Err(AlignmentMergeRuntimeError::InvalidDataset(
                "points3D.txt contains a truncated track".into(),
            ));
        }
        let mut participating = BTreeSet::new();
        for pair in fields[8..].chunks_exact(2) {
            let image_id = pair[0].parse::<u64>().map_err(|_| {
                AlignmentMergeRuntimeError::InvalidDataset(
                    "points3D.txt contains an invalid image id".into(),
                )
            })?;
            let image_name = image_names.get(&image_id).ok_or_else(|| {
                AlignmentMergeRuntimeError::InvalidDataset(
                    "track references an unregistered image".into(),
                )
            })?;
            let camera_id = entity_by_image
                .get(&normalized_name(image_name))
                .ok_or_else(|| {
                    AlignmentMergeRuntimeError::InvalidDataset(
                        "track image has no immutable camera mapping".into(),
                    )
                })?;
            if let Some(indices) = input_index_by_camera.get(camera_id.as_str()) {
                participating.extend(indices.iter().copied());
            }
        }
        let indices = participating.into_iter().collect::<Vec<_>>();
        for left in 0..indices.len() {
            for right in (left + 1)..indices.len() {
                *pair_counts
                    .entry((indices[left], indices[right]))
                    .or_default() += 1;
            }
        }
    }
    let mut overlap = pair_counts
        .into_iter()
        .map(|((left, right), count)| SolvedOverlapEvidence {
            alignment_a: inputs[left].alignment_id.clone(),
            alignment_b: inputs[right].alignment_id.clone(),
            verified_cross_run_track_count: count,
        })
        .collect::<Vec<_>>();
    overlap.sort_by(|left, right| {
        (&left.alignment_a.0, &left.alignment_b.0)
            .cmp(&(&right.alignment_a.0, &right.alignment_b.0))
    });
    Ok(AlignmentMergeEvidenceReport {
        schema_version: 1,
        registered_camera_entity_ids: registered.into_iter().collect(),
        overlap,
    })
}

fn parse_registered_images(
    path: &Path,
) -> Result<BTreeMap<u64, PathBuf>, AlignmentMergeRuntimeError> {
    let meaningful = lines(path)?
        .into_iter()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect::<Vec<_>>();
    if meaningful.len() % 2 != 0 {
        return Err(AlignmentMergeRuntimeError::InvalidDataset(
            "images.txt ends before an observation row".into(),
        ));
    }
    let mut images = BTreeMap::new();
    for record in meaningful.chunks_exact(2) {
        let fields = record[0].split_whitespace().collect::<Vec<_>>();
        if fields.len() < 10 {
            return Err(AlignmentMergeRuntimeError::InvalidDataset(
                "images.txt contains a truncated image record".into(),
            ));
        }
        let image_id = fields[0].parse::<u64>().map_err(|_| {
            AlignmentMergeRuntimeError::InvalidDataset(
                "images.txt contains an invalid image id".into(),
            )
        })?;
        if images.insert(image_id, PathBuf::from(fields[9])).is_some() {
            return Err(AlignmentMergeRuntimeError::InvalidDataset(
                "images.txt contains a duplicate image id".into(),
            ));
        }
    }
    Ok(images)
}

fn normalized_name(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn lines(path: &Path) -> Result<Vec<String>, AlignmentMergeRuntimeError> {
    let text = String::from_utf8(read(path)?).map_err(|_| {
        AlignmentMergeRuntimeError::InvalidDataset(format!("{} is not UTF-8", path.display()))
    })?;
    Ok(text.lines().map(str::trim).map(str::to_owned).collect())
}

fn read(path: &Path) -> Result<Vec<u8>, AlignmentMergeRuntimeError> {
    fs::read(path).map_err(|source| AlignmentMergeRuntimeError::Io {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use himmelcad_core::photolab_matching::ImageId;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn counts_only_tracks_observed_across_input_runs() {
        let root = std::env::temp_dir().join(format!(
            "himmelcad-merge-evidence-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("sparse-view-source")).unwrap();
        fs::write(
            root.join("camera-map.json"),
            br#"[{"entityId":"a","imageName":"images/a.jpg"},{"entityId":"b","imageName":"images/b.jpg"}]"#,
        )
        .unwrap();
        fs::write(
            root.join("sparse-view-source/images.txt"),
            "1 1 0 0 0 0 0 0 1 images/a.jpg\n0 0 1\n2 1 0 0 0 0 0 0 2 images/b.jpg\n0 0 1\n",
        )
        .unwrap();
        fs::write(
            root.join("sparse-view-source/points3D.txt"),
            "1 0 0 0 255 255 255 0.1 1 0 2 0\n2 0 0 0 255 255 255 0.1 1 1\n",
        )
        .unwrap();
        let report = inspect_solved_merge(
            &root,
            &[
                MergeInputScope {
                    alignment_id: EntityId("left".into()),
                    camera_entity_ids: BTreeSet::from(["a".into()]),
                },
                MergeInputScope {
                    alignment_id: EntityId("right".into()),
                    camera_entity_ids: BTreeSet::from(["b".into()]),
                },
            ],
            &BTreeSet::from(["a".into(), "b".into()]),
        )
        .unwrap();
        assert_eq!(report.overlap[0].verified_cross_run_track_count, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn incompatible_checkpoint_is_rejected_instead_of_reused() {
        let root = std::env::temp_dir().join(format!(
            "himmelcad-merge-checkpoint-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let checkpoint = AlignmentMergeCheckpoint {
            schema_version: 1,
            operation_id: "merge-one".into(),
            merge_entity_id: EntityId("merge-entity".into()),
            input_hash: ObjectHash::of_bytes(b"input-a"),
            config_hash: ObjectHash::of_bytes(b"config"),
            state: AlignmentMergeCheckpointState::Running,
            scratch_relative_path: None,
            summary_sha256: None,
        };
        write_merge_checkpoint(&root, &checkpoint).unwrap();
        let error = resume_solved_merge(
            &root,
            "merge-one",
            &checkpoint.merge_entity_id,
            &ObjectHash::of_bytes(b"input-b"),
            &checkpoint.config_hash,
        )
        .expect_err("changed immutable input must reject checkpoint");
        assert!(error.to_string().contains("incompatible"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shared_controls_keep_intrinsics_separate_and_transform_sparse_blocks() {
        let root = std::env::temp_dir().join(format!(
            "himmelcad-shared-control-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let left = root.join("left");
        let right = root.join("right");
        write_source_block(&left, "left-camera", 1000.0);
        write_source_block(&right, "right-camera", 1200.0);
        let left_ids = BTreeSet::from(["left-camera".into()]);
        let right_ids = BTreeSet::from(["right-camera".into()]);
        let left_camera = optimized_camera([10.0, 20.0, 30.0]);
        let right_camera = optimized_camera([40.0, 50.0, 60.0]);
        let cancellation = CancellationToken::new();
        let outcome = build_shared_control_merge(
            &root,
            "shared-test",
            &[
                SharedControlInput {
                    alignment_id: &EntityId("left".into()),
                    dataset_root: &left,
                    camera_entity_ids: &left_ids,
                    transform: GcpSimilarityTransform {
                        scale: 2.0,
                        rotation: GcpSimilarityTransform::identity().rotation,
                        translation_meters: [100.0, 0.0, 0.0],
                    },
                    optimized_cameras: std::slice::from_ref(&left_camera),
                },
                SharedControlInput {
                    alignment_id: &EntityId("right".into()),
                    dataset_root: &right,
                    camera_entity_ids: &right_ids,
                    transform: GcpSimilarityTransform {
                        scale: 1.0,
                        rotation: GcpSimilarityTransform::identity().rotation,
                        translation_meters: [0.0, 200.0, 0.0],
                    },
                    optimized_cameras: std::slice::from_ref(&right_camera),
                },
            ],
            &cancellation,
        )
        .unwrap();
        let cameras =
            fs::read_to_string(outcome.scratch_path.join("sparse-aligned/cameras.txt")).unwrap();
        assert!(cameras.contains("1 PINHOLE 100 80 1000"));
        assert!(cameras.contains("2 PINHOLE 100 80 1200"));
        let points =
            fs::read_to_string(outcome.scratch_path.join("sparse-aligned/points3D.txt")).unwrap();
        assert!(points.lines().any(|line| line.starts_with("1 102 4 6 ")));
        assert!(points.lines().any(|line| line.starts_with("2 1 202 3 ")));
        let images =
            fs::read_to_string(outcome.scratch_path.join("sparse-aligned/images.txt")).unwrap();
        assert!(
            images.contains("-10.00000000000000000 -20.00000000000000000 -30.00000000000000000")
        );
        assert_eq!(outcome.camera_entity_ids, ["left-camera", "right-camera"]);
        let checkpoint = AlignmentMergeCheckpoint {
            schema_version: 1,
            operation_id: "shared-test".into(),
            merge_entity_id: EntityId("merge-shared".into()),
            input_hash: ObjectHash::of_bytes(b"shared-input"),
            config_hash: ObjectHash::of_bytes(b"shared-config"),
            state: AlignmentMergeCheckpointState::Solved,
            scratch_relative_path: Some(
                outcome
                    .scratch_path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_path_buf(),
            ),
            summary_sha256: Some(outcome.dataset_sha256.clone()),
        };
        write_merge_checkpoint(&root, &checkpoint).unwrap();
        let resumed = resume_shared_control_merge(
            &root,
            "shared-test",
            &checkpoint.merge_entity_id,
            &checkpoint.input_hash,
            &checkpoint.config_hash,
        )
        .unwrap()
        .expect("resume solved shared blocks");
        assert_eq!(resumed.dataset_sha256, outcome.dataset_sha256);
        fs::write(
            resumed.scratch_path.join("sparse-aligned/points3D.txt"),
            b"tampered",
        )
        .unwrap();
        assert!(resume_shared_control_merge(
            &root,
            "shared-test",
            &checkpoint.merge_entity_id,
            &checkpoint.input_hash,
            &checkpoint.config_hash,
        )
        .is_err());
        let _ = fs::remove_dir_all(root);
    }

    fn write_source_block(root: &Path, entity: &str, focal: f64) {
        fs::create_dir_all(root.join("sparse-view-source")).unwrap();
        fs::create_dir_all(root.join("images/00000000")).unwrap();
        fs::write(root.join("images/00000000/image.jpg"), b"jpeg").unwrap();
        fs::write(
            root.join("camera-map.json"),
            serde_json::to_vec(&vec![
                serde_json::json!({"entityId":entity,"imageName":"00000000/image.jpg"}),
            ])
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("sparse-view-source/cameras.txt"),
            format!("1 PINHOLE 100 80 {focal} {focal} 50 40\n"),
        )
        .unwrap();
        fs::write(
            root.join("sparse-view-source/images.txt"),
            "1 1 0 0 0 0 0 0 1 00000000/image.jpg\n10 20 1\n",
        )
        .unwrap();
        fs::write(
            root.join("sparse-view-source/points3D.txt"),
            "1 1 2 3 255 255 255 0.1 1 0\n",
        )
        .unwrap();
    }

    fn optimized_camera(center: [f64; 3]) -> OptimizedGcpCamera {
        OptimizedGcpCamera {
            image_id: ImageId(1),
            calibration_group_id: "merge-test-camera".into(),
            width_pixels: 100,
            height_pixels: 80,
            focal_x_pixels: 1.0,
            focal_y_pixels: 1.0,
            principal_x_pixels: 50.0,
            principal_y_pixels: 40.0,
            radial_distortion: [0.0; 3],
            tangential_distortion: [0.0; 2],
            camera_to_world_rotation: GcpSimilarityTransform::identity().rotation,
            center_world_meters: center,
        }
    }
}
