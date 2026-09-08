//! Projection-true, P4-scoped point-cloud segmentation and immutable Potree rebake.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Write};
use std::path::PathBuf;

use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_jobs::CancellationToken;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::pointcloud_ground::{
    attribute_offset, check_cancelled, decode_point, encode_flat_hierarchy, hash_file,
    parse_hierarchy, read_node, scope_contains, transform_point, validate_metadata, write_json,
    GroundScope, PointcloudGroundError, PotreeMetadata, PreparedGroundArtifact,
    PreparedGroundDataset, SourceNode, HIERARCHY_RECORD_BYTES, IO_CHUNK_BYTES, MAX_NODE_BYTES,
};

pub const SEGMENT_ALGORITHM_ID: &str = "hcad.pointcloud.segment@1";
const EPSILON: f64 = 1e-9;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SegmentSide {
    KeepInside,
    RemoveInside,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FenceVolume {
    Prism {
        polygon: Vec<[f64; 3]>,
        direction: [f64; 3],
    },
    Frustum {
        apex: [f64; 3],
        polygon: Vec<[f64; 3]>,
    },
    Box {
        center: [f64; 3],
        half_extents: [f64; 3],
        rotation: [f64; 4],
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct SegmentPrepareRequest {
    pub metadata_path: PathBuf,
    pub hierarchy_path: PathBuf,
    pub octree_path: PathBuf,
    pub output_root: PathBuf,
    pub output_name: String,
    pub volume: FenceVolume,
    pub side: SegmentSide,
    pub scope: GroundScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SegmentPhase {
    Scan,
    Bake,
}

impl SegmentPhase {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Scan => "Scanning visible points",
            Self::Bake => "Baking reduced dataset",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentProgress {
    pub phase: SegmentPhase,
    pub completed: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentSummary {
    pub source_points: u64,
    pub visible_points: u64,
    pub inside_points: u64,
    pub removed_points: u64,
    pub retained_points: u64,
    pub membership_sha256: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedSegmentResult {
    pub dataset: PreparedGroundDataset,
    pub summary: SegmentSummary,
}

#[derive(Debug, Error)]
pub enum PointcloudSegmentError {
    #[error("point-cloud segmentation was cancelled")]
    Cancelled,
    #[error(transparent)]
    Prepared(#[from] PointcloudGroundError),
    #[error("point-cloud segmentation I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("point-cloud segmentation metadata: {0}")]
    Json(#[from] serde_json::Error),
    #[error("point-cloud fence is invalid: {0}")]
    InvalidFence(&'static str),
    #[error("point-cloud segmentation has no visible points in the fence")]
    EmptyApply,
    #[error("point-cloud segmentation would produce an empty dataset")]
    EmptyResult,
}

/// Performs a bounded two-pass scan and writes no canonical state. Publication is a later CAS step.
pub fn prepare_segment_dataset(
    request: &SegmentPrepareRequest,
    cancellation: &CancellationToken,
    mut progress: impl FnMut(SegmentProgress),
) -> Result<PreparedSegmentResult, PointcloudSegmentError> {
    validate_fence(&request.volume)?;
    check_segment_cancelled(cancellation)?;
    let mut metadata: PotreeMetadata = serde_json::from_slice(&fs::read(&request.metadata_path)?)?;
    validate_metadata(&metadata)?;
    let hierarchy_bytes = fs::read(&request.hierarchy_path)?;
    let nodes = parse_hierarchy(&metadata, &hierarchy_bytes)?;
    let stride = metadata
        .attributes
        .iter()
        .try_fold(0_usize, |sum, attribute| {
            sum.checked_add(attribute.size)
                .ok_or(PointcloudGroundError::InvalidMetadata(
                    "attribute stride overflow",
                ))
        })?;
    let position_offset = attribute_offset(&metadata.attributes, "position")?.ok_or(
        PointcloudGroundError::InvalidMetadata("position attribute is missing"),
    )?;
    let classification_offset = attribute_offset(&metadata.attributes, "classification")?;

    let mut visible_points = 0_u64;
    let mut inside_points = 0_u64;
    let mut reader = BufReader::with_capacity(IO_CHUNK_BYTES, File::open(&request.octree_path)?);
    let mut scanned = 0_u64;
    for node in &nodes {
        check_segment_cancelled(cancellation)?;
        if node.byte_length > MAX_NODE_BYTES {
            return Err(PointcloudGroundError::InvalidPayload(
                "one node exceeds the bounded read limit",
            )
            .into());
        }
        let bytes = read_node(&mut reader, node)?;
        for record in bytes.chunks_exact(stride) {
            let local = decode_point(record, position_offset, &metadata)?;
            let class = classification_offset.map_or(0, |offset| record[offset]);
            if request.scope.visible_classes.contains(&class)
                && scope_contains(&request.scope, local)
            {
                visible_points = visible_points.saturating_add(1);
                if fence_contains(
                    &request.volume,
                    transform_point(&request.scope.placement, local),
                ) {
                    inside_points = inside_points.saturating_add(1);
                }
            }
        }
        scanned = scanned.saturating_add(node.point_count);
        progress(SegmentProgress {
            phase: SegmentPhase::Scan,
            completed: scanned.min(metadata.points),
            total: metadata.points.max(1),
        });
    }
    let removed_points = match request.side {
        SegmentSide::KeepInside => visible_points.saturating_sub(inside_points),
        SegmentSide::RemoveInside => inside_points,
    };
    if removed_points == 0 {
        return Err(PointcloudSegmentError::EmptyApply);
    }
    let retained_points = metadata.points.saturating_sub(removed_points);
    if retained_points == 0 {
        return Err(PointcloudSegmentError::EmptyResult);
    }

    let output_root = request.output_root.join("segmented");
    fs::create_dir_all(&output_root)?;
    let mut source = BufReader::with_capacity(IO_CHUNK_BYTES, File::open(&request.octree_path)?);
    let mut output = BufWriter::with_capacity(
        IO_CHUNK_BYTES,
        File::create(output_root.join("octree.bin"))?,
    );
    let mut counts = BTreeMap::<String, u64>::new();
    let mut histogram = [0_u64; 256];
    let mut membership = Sha256::new();
    let mut baked = 0_u64;
    for node in &nodes {
        check_segment_cancelled(cancellation)?;
        let bytes = read_node(&mut source, node)?;
        let mut retained_in_node = 0_u64;
        for record in bytes.chunks_exact(stride) {
            let local = decode_point(record, position_offset, &metadata)?;
            let class = classification_offset.map_or(0, |offset| record[offset]);
            let visible = request.scope.visible_classes.contains(&class)
                && scope_contains(&request.scope, local);
            let inside = visible
                && fence_contains(
                    &request.volume,
                    transform_point(&request.scope.placement, local),
                );
            let retain = if !visible {
                true
            } else {
                match request.side {
                    SegmentSide::KeepInside => inside,
                    SegmentSide::RemoveInside => !inside,
                }
            };
            membership.update([u8::from(retain)]);
            if retain {
                output.write_all(record)?;
                retained_in_node = retained_in_node.saturating_add(1);
                histogram[usize::from(class)] = histogram[usize::from(class)].saturating_add(1);
            }
        }
        counts.insert(node.id.clone(), retained_in_node);
        baked = baked.saturating_add(node.point_count);
        progress(SegmentProgress {
            phase: SegmentPhase::Bake,
            completed: baked.min(metadata.points),
            total: metadata.points.max(1),
        });
    }
    output.flush()?;
    check_segment_cancelled(cancellation)?;

    let live_nodes = pruned_segment_nodes(&nodes, &counts);
    metadata.name = Some(request.output_name.clone());
    metadata.points = retained_points;
    metadata.hierarchy.first_chunk_size = u64::try_from(live_nodes.len())
        .unwrap_or(u64::MAX)
        .saturating_mul(HIERARCHY_RECORD_BYTES as u64);
    metadata.hierarchy.step_size = metadata
        .hierarchy
        .depth
        .saturating_add(1)
        .max(metadata.hierarchy.step_size);
    if classification_offset.is_some() {
        crate::pointcloud_ground::set_classification_histogram(&mut metadata, &histogram)?;
    }
    write_json(&output_root.join("metadata.json"), &metadata)?;
    fs::write(
        output_root.join("hierarchy.bin"),
        encode_flat_hierarchy(&live_nodes, &counts, stride)?,
    )?;
    let dataset = describe_dataset(output_root, retained_points)?;
    Ok(PreparedSegmentResult {
        dataset,
        summary: SegmentSummary {
            source_points: metadata.points.saturating_add(removed_points),
            visible_points,
            inside_points,
            removed_points,
            retained_points,
            membership_sha256: ObjectHash(hex::encode(membership.finalize())),
        },
    })
}

/// Removes empty spatial branches so an edited cloud traverses in proportion to its retained data.
fn pruned_segment_nodes(nodes: &[SourceNode], counts: &BTreeMap<String, u64>) -> Vec<SourceNode> {
    let mut live = BTreeSet::<String>::new();
    for node in nodes {
        if counts.get(&node.id).copied().unwrap_or(0) == 0 {
            continue;
        }
        let mut ancestor = node.id.as_str();
        loop {
            live.insert(ancestor.to_owned());
            if ancestor.len() <= 1 {
                break;
            }
            ancestor = &ancestor[..ancestor.len() - 1];
        }
    }
    nodes
        .iter()
        .filter(|node| live.contains(&node.id))
        .cloned()
        .map(|mut node| {
            node.children.retain(|child| live.contains(child));
            node
        })
        .collect()
}

pub fn fence_contains(volume: &FenceVolume, point: [f64; 3]) -> bool {
    match volume {
        FenceVolume::Box {
            center,
            half_extents,
            rotation,
        } => box_contains(*center, *half_extents, *rotation, point),
        FenceVolume::Prism { polygon, direction } => {
            let Ok(basis) = polygon_basis(polygon) else {
                return false;
            };
            let Ok(direction) = normalize(*direction) else {
                return false;
            };
            let denominator = dot(direction, basis.normal);
            if denominator.abs() <= EPSILON {
                return false;
            }
            let distance = dot(subtract(polygon[0], point), basis.normal) / denominator;
            polygon_contains(add(point, scale(direction, distance)), polygon, basis)
        }
        FenceVolume::Frustum { apex, polygon } => {
            let Ok(basis) = polygon_basis(polygon) else {
                return false;
            };
            let ray = subtract(point, *apex);
            let plane_distance = dot(subtract(polygon[0], *apex), basis.normal);
            let denominator = dot(ray, basis.normal);
            if denominator.abs() <= EPSILON || plane_distance * denominator <= 0.0 {
                return false;
            }
            let factor = plane_distance / denominator;
            factor >= 0.0 && polygon_contains(add(*apex, scale(ray, factor)), polygon, basis)
        }
    }
}

fn describe_dataset(
    root: PathBuf,
    point_count: u64,
) -> Result<PreparedGroundDataset, PointcloudSegmentError> {
    let mut artifacts = Vec::new();
    for (relative_path, media_type) in [
        ("metadata.json", "application/json"),
        ("hierarchy.bin", "application/vnd.potree.hierarchy"),
        ("octree.bin", "application/vnd.potree.points"),
    ] {
        let (object_hash, byte_length) = hash_file(&root.join(relative_path))?;
        artifacts.push(PreparedGroundArtifact {
            relative_path: relative_path.to_owned(),
            object_hash,
            byte_length,
            media_type: media_type.to_owned(),
        });
    }
    Ok(PreparedGroundDataset {
        root,
        point_count,
        artifacts,
    })
}

#[derive(Clone, Copy)]
struct Basis {
    origin: [f64; 3],
    u: [f64; 3],
    v: [f64; 3],
    normal: [f64; 3],
}

fn validate_fence(volume: &FenceVolume) -> Result<(), PointcloudSegmentError> {
    match volume {
        FenceVolume::Prism { polygon, direction } => {
            let basis = polygon_basis(polygon)?;
            let direction = normalize(*direction)?;
            if dot(direction, basis.normal).abs() <= EPSILON {
                return Err(PointcloudSegmentError::InvalidFence(
                    "prism direction does not cross the polygon plane",
                ));
            }
        }
        FenceVolume::Frustum { apex, polygon } => {
            validate_point(*apex)?;
            let basis = polygon_basis(polygon)?;
            if dot(subtract(polygon[0], *apex), basis.normal).abs() <= EPSILON {
                return Err(PointcloudSegmentError::InvalidFence(
                    "apex lies on the fence plane",
                ));
            }
        }
        FenceVolume::Box {
            center,
            half_extents,
            rotation,
        } => {
            validate_point(*center)?;
            validate_point(*half_extents)?;
            let rotation_length = rotation
                .iter()
                .map(|value| value * value)
                .sum::<f64>()
                .sqrt();
            if half_extents.iter().any(|value| *value <= 0.0)
                || rotation.iter().any(|value| !value.is_finite())
                || (rotation_length - 1.0).abs() > 1e-6
            {
                return Err(PointcloudSegmentError::InvalidFence("invalid box"));
            }
        }
    }
    Ok(())
}

fn polygon_basis(polygon: &[[f64; 3]]) -> Result<Basis, PointcloudSegmentError> {
    if polygon.len() < 3 {
        return Err(PointcloudSegmentError::InvalidFence(
            "polygon needs three vertices",
        ));
    }
    for point in polygon {
        validate_point(*point)?;
    }
    let origin = polygon[0];
    for index in 1..polygon.len() - 1 {
        let edge = subtract(polygon[index], origin);
        for next in index + 1..polygon.len() {
            let candidate = cross(edge, subtract(polygon[next], origin));
            if length(candidate) > EPSILON {
                let normal = normalize(candidate)?;
                if polygon
                    .iter()
                    .any(|point| dot(subtract(*point, origin), normal).abs() > 1e-6)
                {
                    return Err(PointcloudSegmentError::InvalidFence(
                        "polygon is not coplanar",
                    ));
                }
                let u = normalize(edge)?;
                return Ok(Basis {
                    origin,
                    u,
                    v: cross(normal, u),
                    normal,
                });
            }
        }
    }
    Err(PointcloudSegmentError::InvalidFence("polygon is collinear"))
}

fn polygon_contains(point: [f64; 3], polygon: &[[f64; 3]], basis: Basis) -> bool {
    let projected = project(point, basis);
    let mut inside = false;
    let mut previous = polygon.len() - 1;
    for index in 0..polygon.len() {
        let a = project(polygon[index], basis);
        let b = project(polygon[previous], basis);
        if point_on_segment(projected, a, b) {
            return true;
        }
        if (a[1] > projected[1]) != (b[1] > projected[1])
            && projected[0] < (b[0] - a[0]) * (projected[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            inside = !inside;
        }
        previous = index;
    }
    inside
}

fn point_on_segment(point: [f64; 2], a: [f64; 2], b: [f64; 2]) -> bool {
    let cross = (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]);
    let dot = (point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1]);
    let length = (b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2);
    cross.abs() <= EPSILON && dot >= -EPSILON && dot <= length + EPSILON
}

fn project(point: [f64; 3], basis: Basis) -> [f64; 2] {
    let relative = subtract(point, basis.origin);
    [dot(relative, basis.u), dot(relative, basis.v)]
}

fn box_contains(
    center: [f64; 3],
    half_extents: [f64; 3],
    rotation: [f64; 4],
    point: [f64; 3],
) -> bool {
    let length = rotation
        .iter()
        .map(|value| value * value)
        .sum::<f64>()
        .sqrt();
    let [x, y, z, w] = rotation.map(|value| value / length);
    let relative = subtract(point, center);
    let axes = [
        [
            1.0 - 2.0 * (y * y + z * z),
            2.0 * (x * y + z * w),
            2.0 * (x * z - y * w),
        ],
        [
            2.0 * (x * y - z * w),
            1.0 - 2.0 * (x * x + z * z),
            2.0 * (y * z + x * w),
        ],
        [
            2.0 * (x * z + y * w),
            2.0 * (y * z - x * w),
            1.0 - 2.0 * (x * x + y * y),
        ],
    ];
    axes.iter()
        .zip(half_extents)
        .all(|(axis, extent)| dot(relative, *axis).abs() <= extent + EPSILON)
}

fn check_segment_cancelled(cancellation: &CancellationToken) -> Result<(), PointcloudSegmentError> {
    check_cancelled(cancellation).map_err(|error| match error {
        PointcloudGroundError::Cancelled => PointcloudSegmentError::Cancelled,
        other => PointcloudSegmentError::Prepared(other),
    })
}

fn validate_point(point: [f64; 3]) -> Result<(), PointcloudSegmentError> {
    if point.iter().all(|value| value.is_finite()) {
        Ok(())
    } else {
        Err(PointcloudSegmentError::InvalidFence(
            "coordinate is not finite",
        ))
    }
}

fn add(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    [left[0] + right[0], left[1] + right[1], left[2] + right[2]]
}
fn subtract(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}
fn scale(point: [f64; 3], factor: f64) -> [f64; 3] {
    [point[0] * factor, point[1] * factor, point[2] * factor]
}
fn dot(left: [f64; 3], right: [f64; 3]) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}
fn cross(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}
fn length(point: [f64; 3]) -> f64 {
    dot(point, point).sqrt()
}
fn normalize(point: [f64; 3]) -> Result<[f64; 3], PointcloudSegmentError> {
    let length = length(point);
    if !length.is_finite() || length <= EPSILON {
        Err(PointcloudSegmentError::InvalidFence("zero-length vector"))
    } else {
        Ok(scale(point, 1.0 / length))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn prism() -> FenceVolume {
        FenceVolume::Prism {
            polygon: vec![
                [-0.5, -1.0, 0.0],
                [2.5, -1.0, 0.0],
                [2.5, 1.0, 0.0],
                [-0.5, 1.0, 0.0],
            ],
            direction: [0.0, 0.0, -1.0],
        }
    }

    #[test]
    fn projection_true_frustum_membership_expands_with_depth() {
        let volume = FenceVolume::Frustum {
            apex: [0.0, 0.0, 10.0],
            polygon: vec![
                [-1.0, -1.0, 0.0],
                [1.0, -1.0, 0.0],
                [1.0, 1.0, 0.0],
                [-1.0, 1.0, 0.0],
            ],
        };
        assert!(fence_contains(&volume, [0.9, 0.0, 0.0]));
        assert!(fence_contains(&volume, [1.8, 0.0, -10.0]));
        assert!(!fence_contains(&volume, [2.1, 0.0, -10.0]));
        assert!(fence_contains(&volume, [0.4, 0.0, 5.0]));
        assert!(!fence_contains(&volume, [0.6, 0.0, 5.0]));
    }

    #[test]
    fn oblique_prism_and_camel_case_box_match_the_wire_contract() {
        let volume = FenceVolume::Prism {
            polygon: vec![
                [-1.0, -1.0, 0.0],
                [1.0, -1.0, 0.0],
                [1.0, 1.0, 0.0],
                [-1.0, 1.0, 0.0],
            ],
            direction: [1.0, 0.0, 1.0],
        };
        assert!(fence_contains(&volume, [5.5, 0.0, 5.0]));
        assert!(!fence_contains(&volume, [3.5, 0.0, 5.0]));

        let box_volume: FenceVolume = serde_json::from_value(serde_json::json!({
            "kind": "box",
            "center": [1.0, 2.0, 3.0],
            "halfExtents": [2.0, 1.0, 0.5],
            "rotation": [0.0, 0.0, 0.0, 1.0]
        }))
        .expect("camelCase box");
        validate_fence(&box_volume).expect("valid box");
        assert!(fence_contains(&box_volume, [3.0, 3.0, 3.5]));

        let half_turn = std::f64::consts::FRAC_1_SQRT_2;
        let rotated = FenceVolume::Box {
            center: [1.0, 2.0, 3.0],
            half_extents: [2.0, 1.0, 0.5],
            rotation: [0.0, 0.0, half_turn, half_turn],
        };
        assert!(fence_contains(&rotated, [1.0, 4.0, 3.0]));
        assert!(!fence_contains(&rotated, [3.0, 2.0, 3.0]));
    }

    #[test]
    fn keep_remove_are_symmetric_and_hidden_class_survives_both() {
        let root = fixture("symmetry");
        let run = |side, name: &str| {
            prepare_segment_dataset(
                &SegmentPrepareRequest {
                    metadata_path: root.join("metadata.json"),
                    hierarchy_path: root.join("hierarchy.bin"),
                    octree_path: root.join("octree.bin"),
                    output_root: root.join(name),
                    output_name: name.to_owned(),
                    volume: prism(),
                    side,
                    scope: GroundScope {
                        visible_classes: [1].into_iter().collect::<BTreeSet<_>>(),
                        ..GroundScope::default()
                    },
                },
                &CancellationToken::new(),
                |_| {},
            )
            .expect("segment")
        };
        let keep = run(SegmentSide::KeepInside, "keep");
        let remove = run(SegmentSide::RemoveInside, "remove");
        assert_eq!(keep.summary.visible_points, 5);
        assert_eq!(keep.summary.inside_points, 3);
        assert_eq!(
            keep.summary.removed_points + remove.summary.removed_points,
            5
        );
        assert_eq!(keep.summary.retained_points, 4);
        assert_eq!(remove.summary.retained_points, 3);
        for result in [keep, remove] {
            let bytes = fs::read(result.dataset.root.join("octree.bin")).expect("output");
            assert!(bytes.chunks_exact(13).any(|record| record[12] == 5));
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancellation_at_every_phase_leaves_no_ready_dataset() {
        let root = fixture("cancel");
        for phase in [SegmentPhase::Scan, SegmentPhase::Bake] {
            let cancellation = CancellationToken::new();
            let output = root.join(format!("cancel-{phase:?}"));
            let result = prepare_segment_dataset(
                &SegmentPrepareRequest {
                    metadata_path: root.join("metadata.json"),
                    hierarchy_path: root.join("hierarchy.bin"),
                    octree_path: root.join("octree.bin"),
                    output_root: output.clone(),
                    output_name: "cancelled".to_owned(),
                    volume: prism(),
                    side: SegmentSide::KeepInside,
                    scope: GroundScope::default(),
                },
                &cancellation,
                |progress| {
                    if progress.phase == phase {
                        cancellation.request_cancel();
                    }
                },
            );
            assert!(matches!(result, Err(PointcloudSegmentError::Cancelled)));
            assert!(!output.join("segmented/metadata.json").is_file());
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "104 M-point operational gate; set HCAD_SEGMENT_REAL_DATASET"]
    fn real_dataset_bakes_a_native_small_cloud_and_cancels_at_each_phase() {
        let dataset = PathBuf::from(
            std::env::var("HCAD_SEGMENT_REAL_DATASET")
                .expect("HCAD_SEGMENT_REAL_DATASET must name a prepared Potree dataset"),
        );
        let metadata: PotreeMetadata =
            serde_json::from_slice(&fs::read(dataset.join("metadata.json")).expect("metadata"))
                .expect("metadata json");
        assert!(
            metadata.points >= 100_000_000,
            "operational fixture must contain 100 M+ points"
        );
        let midpoint_x = (metadata.bounding_box.min[0] + metadata.bounding_box.max[0]) * 0.5;
        let margin = metadata.spacing.max(1.0);
        let fence = FenceVolume::Prism {
            polygon: vec![
                [
                    metadata.bounding_box.min[0] - margin,
                    metadata.bounding_box.min[1] - margin,
                    0.0,
                ],
                [midpoint_x, metadata.bounding_box.min[1] - margin, 0.0],
                [midpoint_x, metadata.bounding_box.max[1] + margin, 0.0],
                [
                    metadata.bounding_box.min[0] - margin,
                    metadata.bounding_box.max[1] + margin,
                    0.0,
                ],
            ],
            direction: [0.0, 0.0, 1.0],
        };
        let root = fixture("real-data");
        for phase in [SegmentPhase::Scan, SegmentPhase::Bake] {
            let cancellation = CancellationToken::new();
            let output = root.join(format!("cancel-{phase:?}"));
            let result = prepare_segment_dataset(
                &SegmentPrepareRequest {
                    metadata_path: dataset.join("metadata.json"),
                    hierarchy_path: dataset.join("hierarchy.bin"),
                    octree_path: dataset.join("octree.bin"),
                    output_root: output.clone(),
                    output_name: "Cancelled segment".to_owned(),
                    volume: fence.clone(),
                    side: SegmentSide::KeepInside,
                    scope: GroundScope::default(),
                },
                &cancellation,
                |progress| {
                    if progress.phase == phase {
                        cancellation.request_cancel();
                    }
                },
            );
            assert!(matches!(result, Err(PointcloudSegmentError::Cancelled)));
            assert!(!output.join("segmented/metadata.json").is_file());
        }
        let completed = prepare_segment_dataset(
            &SegmentPrepareRequest {
                metadata_path: dataset.join("metadata.json"),
                hierarchy_path: dataset.join("hierarchy.bin"),
                octree_path: dataset.join("octree.bin"),
                output_root: root.join("complete"),
                output_name: "Segmented real cloud".to_owned(),
                volume: fence,
                side: SegmentSide::KeepInside,
                scope: GroundScope::default(),
            },
            &CancellationToken::new(),
            |_| {},
        )
        .expect("real segmentation");
        assert!(completed.summary.retained_points > 0);
        assert!(completed.summary.retained_points < metadata.points);
        let reduced: PotreeMetadata = serde_json::from_slice(
            &fs::read(completed.dataset.root.join("metadata.json")).expect("reduced metadata"),
        )
        .expect("reduced metadata json");
        assert_eq!(reduced.points, completed.summary.retained_points);
        assert_eq!(completed.dataset.artifacts.len(), 3);
        let _ = fs::remove_dir_all(root);
    }

    fn fixture(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "hcad-segment-{label}-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("fixture root");
        let metadata = serde_json::json!({
            "version": "2.0",
            "name": "Segment fixture",
            "points": 6,
            "hierarchy": { "firstChunkSize": 22, "stepSize": 5, "depth": 1 },
            "offset": [0.0, 0.0, 0.0],
            "scale": [1.0, 1.0, 1.0],
            "spacing": 1.0,
            "boundingBox": { "min": [-1.0, -1.0, -1.0], "max": [11.0, 2.0, 2.0] },
            "encoding": "DEFAULT",
            "attributes": [
                { "name": "position", "size": 12 },
                { "name": "classification", "size": 1, "histogram": [0, 5, 0, 0, 0, 1] }
            ]
        });
        fs::write(
            root.join("metadata.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        let mut octree = Vec::new();
        for (x, y, z, class) in [
            (0_i32, 0_i32, 0_i32, 1_u8),
            (1, 0, 0, 1),
            (2, 0, 0, 1),
            (10, 0, 0, 1),
            (1, 0, 1, 5),
            (4, 0, 0, 1),
        ] {
            octree.extend_from_slice(&x.to_le_bytes());
            octree.extend_from_slice(&y.to_le_bytes());
            octree.extend_from_slice(&z.to_le_bytes());
            octree.push(class);
        }
        fs::write(root.join("octree.bin"), &octree).unwrap();
        let mut hierarchy = vec![0, 0];
        hierarchy.extend_from_slice(&6_u32.to_le_bytes());
        hierarchy.extend_from_slice(&0_u64.to_le_bytes());
        hierarchy.extend_from_slice(&(octree.len() as u64).to_le_bytes());
        fs::write(root.join("hierarchy.bin"), hierarchy).unwrap();
        root
    }
}
