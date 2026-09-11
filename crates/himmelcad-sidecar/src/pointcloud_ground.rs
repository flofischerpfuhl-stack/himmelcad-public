//! Bounded preparation of deterministic PC-D19 ground-classification datasets.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use himmelcad_core::hash::ObjectHash;
use himmelcad_core::photolab_jobs::CancellationToken;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::ground_classification::{
    classify_ground_detailed, GroundClassificationError, GroundResidualSummary, Point3, PointClass,
    SmrfParams,
};

pub(crate) const HIERARCHY_RECORD_BYTES: usize = 22;
const PROXY_NODE: u8 = 2;
pub(crate) const IO_CHUNK_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_NODE_BYTES: u64 = 512 * 1024 * 1024;

/// Immutable algorithm contract recorded by every manifest and derived recipe.
pub const GROUND_ALGORITHM_ID: &str = "hcad.pointcloud.ground-progressive@1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GroundPhase {
    Grid,
    Filter,
    Classify,
    Bake,
}

impl GroundPhase {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Grid => "Building terrain grid",
            Self::Filter => "Filtering terrain",
            Self::Classify => "Classifying points",
            Self::Bake => "Baking prepared datasets",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroundProgress {
    pub phase: GroundPhase,
    pub completed: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroundViewingBox {
    pub center: [f64; 3],
    pub half_extents: [f64; 3],
    /// Unit quaternion in x/y/z/w order.
    pub rotation: [f64; 4],
    pub keep_inside: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroundScope {
    /// Exact canonical source placement, column-major.
    pub placement: [f64; 16],
    pub viewing_box: Option<GroundViewingBox>,
    pub visible_classes: BTreeSet<u8>,
}

impl Default for GroundScope {
    fn default() -> Self {
        Self {
            placement: [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            viewing_box: None,
            visible_classes: (0_u8..=u8::MAX).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GroundPrepareRequest {
    pub metadata_path: PathBuf,
    pub hierarchy_path: PathBuf,
    pub octree_path: PathBuf,
    pub output_root: PathBuf,
    pub output_name: String,
    pub params: SmrfParams,
    pub scope: GroundScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedGroundArtifact {
    pub relative_path: String,
    pub object_hash: ObjectHash,
    pub byte_length: u64,
    pub media_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroundResultSummary {
    pub source_points: u64,
    pub scoped_points: u64,
    pub ground_points: u64,
    pub ratio: f64,
    pub residuals: GroundResidualSummaryWire,
    pub membership_sha256: ObjectHash,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroundResidualSummaryWire {
    pub count: u64,
    pub mean_m: f64,
    pub standard_deviation_m: f64,
    pub minimum_m: f64,
    pub maximum_m: f64,
}

impl From<GroundResidualSummary> for GroundResidualSummaryWire {
    fn from(value: GroundResidualSummary) -> Self {
        Self {
            count: value.count,
            mean_m: value.mean_m,
            standard_deviation_m: value.standard_deviation_m,
            minimum_m: value.minimum_m,
            maximum_m: value.maximum_m,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedGroundDataset {
    pub root: PathBuf,
    pub point_count: u64,
    pub artifacts: Vec<PreparedGroundArtifact>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedGroundResult {
    pub source: PreparedGroundDataset,
    pub extracted: PreparedGroundDataset,
    pub summary: GroundResultSummary,
}

/// One bounded, renderer-ready point in the live coarse ground preview.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroundPreviewPoint {
    pub position: [f64; 3],
    pub classification: PointClassPreview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointClassPreview {
    Ground,
    NonGround,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroundPreviewResult {
    pub sampled_points: u64,
    pub ground_points: u64,
    pub ratio: f64,
    pub residuals: GroundResidualSummaryWire,
    pub points: Vec<GroundPreviewPoint>,
}

#[derive(Debug, Error)]
pub enum PointcloudGroundError {
    #[error("ground extraction was cancelled")]
    Cancelled,
    #[error("ground extraction I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("ground extraction metadata: {0}")]
    Json(#[from] serde_json::Error),
    #[error("ground extraction metadata is invalid: {0}")]
    InvalidMetadata(&'static str),
    #[error("ground extraction hierarchy is invalid: {0}")]
    InvalidHierarchy(&'static str),
    #[error("ground extraction point payload is invalid: {0}")]
    InvalidPayload(&'static str),
    #[error(transparent)]
    Classification(#[from] GroundClassificationError),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PotreeMetadata {
    pub(crate) version: String,
    pub(crate) name: Option<String>,
    pub(crate) points: u64,
    pub(crate) hierarchy: PotreeHierarchy,
    pub(crate) offset: [f64; 3],
    pub(crate) scale: [f64; 3],
    pub(crate) spacing: f64,
    pub(crate) bounding_box: PotreeBounds,
    pub(crate) encoding: String,
    pub(crate) attributes: Vec<PotreeAttribute>,
    #[serde(flatten)]
    extensions: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PotreeHierarchy {
    pub(crate) first_chunk_size: u64,
    pub(crate) step_size: u32,
    pub(crate) depth: u32,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub(crate) struct PotreeBounds {
    pub(crate) min: [f64; 3],
    pub(crate) max: [f64; 3],
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PotreeAttribute {
    pub(crate) name: String,
    pub(crate) size: usize,
    #[serde(flatten)]
    extensions: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceNode {
    pub(crate) id: String,
    pub(crate) children: Vec<String>,
    pub(crate) point_count: u64,
    pub(crate) byte_offset: u64,
    pub(crate) byte_length: u64,
}

/// Runs classification and prepares two ordinary Potree datasets without publishing partial state.
///
/// Input is read a node at a time. The only point-count-sized allocations are the shared SMRF
/// coordinate array and its one-byte result, keeping the 104 M-point fixture within the P2/P5
/// memory budget while output bytes stream directly to disk.
pub fn prepare_ground_datasets(
    request: &GroundPrepareRequest,
    cancellation: &CancellationToken,
    mut progress: impl FnMut(GroundProgress),
) -> Result<PreparedGroundResult, PointcloudGroundError> {
    validate_scope(&request.scope)?;
    check_cancelled(cancellation)?;
    let metadata_bytes = fs::read(&request.metadata_path)?;
    let metadata: PotreeMetadata = serde_json::from_slice(&metadata_bytes)?;
    validate_metadata(&metadata)?;
    let hierarchy_bytes = fs::read(&request.hierarchy_path)?;
    let nodes = parse_hierarchy_cancellable(&metadata, &hierarchy_bytes, cancellation)?;
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

    let mut points = Vec::new();
    let mut source = BufReader::with_capacity(IO_CHUNK_BYTES, File::open(&request.octree_path)?);
    let mut visited = 0_u64;
    for node in &nodes {
        check_cancelled(cancellation)?;
        if node.byte_length > MAX_NODE_BYTES {
            return Err(PointcloudGroundError::InvalidPayload(
                "one node exceeds the bounded read limit",
            ));
        }
        let bytes = read_node_cancellable(&mut source, node, cancellation)?;
        for (record_index, record) in bytes.chunks_exact(stride).enumerate() {
            if record_index % 65_536 == 0 {
                check_cancelled(cancellation)?;
            }
            let point = decode_point(record, position_offset, &metadata)?;
            let class = classification_offset.map_or(0, |offset| record[offset]);
            if request.scope.visible_classes.contains(&class)
                && scope_contains(&request.scope, point)
            {
                points.push(point);
            }
        }
        visited = visited.saturating_add(node.point_count);
        progress(GroundProgress {
            phase: GroundPhase::Grid,
            completed: visited.min(metadata.points),
            total: metadata.points.max(1),
        });
    }
    if visited != metadata.points {
        return Err(PointcloudGroundError::InvalidPayload(
            "hierarchy point count differs from metadata",
        ));
    }
    if points.is_empty() {
        return Err(PointcloudGroundError::InvalidPayload(
            "the captured P4 visible set is empty",
        ));
    }

    let scoped_points = u64::try_from(points.len())
        .map_err(|_| PointcloudGroundError::InvalidPayload("too many scoped points"))?;
    let classification = classify_ground_detailed(
        &points,
        &request.params,
        cancellation,
        |completed, total| {
            progress(GroundProgress {
                phase: if completed < total / 2 {
                    GroundPhase::Filter
                } else {
                    GroundPhase::Classify
                },
                completed,
                total: total.max(1),
            });
        },
    )
    .map_err(classification_error)?;
    drop(points);

    let source_root = request.output_root.join("source-edited");
    let extracted_root = request.output_root.join("ground");
    fs::create_dir_all(&source_root)?;
    fs::create_dir_all(&extracted_root)?;
    let mut source_reader =
        BufReader::with_capacity(IO_CHUNK_BYTES, File::open(&request.octree_path)?);
    let mut source_writer = BufWriter::with_capacity(
        IO_CHUNK_BYTES,
        File::create(source_root.join("octree.bin"))?,
    );
    let mut ground_writer = BufWriter::with_capacity(
        IO_CHUNK_BYTES,
        File::create(extracted_root.join("octree.bin"))?,
    );
    let mut ground_counts = BTreeMap::<String, u64>::new();
    let mut membership = Sha256::new();
    let mut class_index = 0_usize;
    let mut baked_points = 0_u64;
    let mut ground_points = 0_u64;
    let mut source_histogram = [0_u64; 256];
    let mut edited = vec![0_u8; stride];
    for node in &nodes {
        check_cancelled(cancellation)?;
        let bytes = read_node_cancellable(&mut source_reader, node, cancellation)?;
        let mut node_ground = 0_u64;
        for (record_index, record) in bytes.chunks_exact(stride).enumerate() {
            if record_index % 65_536 == 0 {
                check_cancelled(cancellation)?;
            }
            let point = decode_point(record, position_offset, &metadata)?;
            let old_class = classification_offset.map_or(0, |offset| record[offset]);
            let included = request.scope.visible_classes.contains(&old_class)
                && scope_contains(&request.scope, point);
            let is_ground = if included {
                let class = classification.classes.get(class_index).ok_or(
                    PointcloudGroundError::InvalidPayload("classification index underrun"),
                )?;
                class_index += 1;
                *class == PointClass::Ground
            } else {
                false
            };
            membership.update([u8::from(is_ground)]);
            if is_ground {
                node_ground = node_ground.saturating_add(1);
                ground_points = ground_points.saturating_add(1);
            }
            if let Some(offset) = classification_offset {
                edited.copy_from_slice(record);
                if is_ground {
                    edited[offset] = u8::from(PointClass::Ground);
                    ground_writer.write_all(&edited)?;
                }
                source_writer.write_all(&edited)?;
                source_histogram[usize::from(edited[offset])] =
                    source_histogram[usize::from(edited[offset])].saturating_add(1);
            } else {
                // Imported LAS/E57 prepared datasets are required to carry classification.
                return Err(PointcloudGroundError::InvalidMetadata(
                    "classification attribute is missing",
                ));
            }
        }
        ground_counts.insert(node.id.clone(), node_ground);
        baked_points = baked_points.saturating_add(node.point_count);
        progress(GroundProgress {
            phase: GroundPhase::Bake,
            completed: baked_points.min(metadata.points),
            total: metadata.points.max(1),
        });
    }
    if class_index != classification.classes.len() {
        return Err(PointcloudGroundError::InvalidPayload(
            "classification index overrun",
        ));
    }
    source_writer.flush()?;
    ground_writer.flush()?;
    check_cancelled(cancellation)?;

    let mut source_metadata = metadata.clone();
    source_metadata.name = Some(format!(
        "{} — classified",
        metadata.name.as_deref().unwrap_or("Point cloud")
    ));
    set_classification_histogram(&mut source_metadata, &source_histogram)?;
    write_json(&source_root.join("metadata.json"), &source_metadata)?;
    fs::write(source_root.join("hierarchy.bin"), &hierarchy_bytes)?;

    let mut extracted_metadata = metadata.clone();
    extracted_metadata.name = Some(request.output_name.clone());
    extracted_metadata.points = ground_points;
    extracted_metadata.hierarchy.first_chunk_size = u64::try_from(nodes.len())
        .unwrap_or(u64::MAX)
        .saturating_mul(HIERARCHY_RECORD_BYTES as u64);
    extracted_metadata.hierarchy.step_size = extracted_metadata
        .hierarchy
        .depth
        .saturating_add(1)
        .max(extracted_metadata.hierarchy.step_size);
    let mut ground_histogram = [0_u64; 256];
    ground_histogram[usize::from(u8::from(PointClass::Ground))] = ground_points;
    set_classification_histogram(&mut extracted_metadata, &ground_histogram)?;
    write_json(&extracted_root.join("metadata.json"), &extracted_metadata)?;
    fs::write(
        extracted_root.join("hierarchy.bin"),
        encode_flat_hierarchy(&nodes, &ground_counts, stride)?,
    )?;

    let source_dataset = describe_dataset(source_root, metadata.points, cancellation)?;
    let extracted_dataset = describe_dataset(extracted_root, ground_points, cancellation)?;
    let membership_sha256 = ObjectHash(hex::encode(membership.finalize()));
    Ok(PreparedGroundResult {
        source: source_dataset,
        extracted: extracted_dataset,
        summary: GroundResultSummary {
            source_points: metadata.points,
            scoped_points,
            ground_points,
            ratio: ground_points as f64 / scoped_points as f64,
            residuals: classification.residuals.into(),
            membership_sha256,
        },
    })
}

/// Produces a deterministic coarse-LOD preview without creating or publishing datasets.
///
/// Potree hierarchy order is breadth-first, so the bounded prefix is the native coarse stream
/// rather than a second, unbounded sample of the source cloud.
pub fn preview_ground(
    request: &GroundPrepareRequest,
    sample_limit: usize,
    cancellation: &CancellationToken,
    mut progress: impl FnMut(GroundProgress),
) -> Result<GroundPreviewResult, PointcloudGroundError> {
    validate_scope(&request.scope)?;
    if sample_limit == 0 {
        return Err(PointcloudGroundError::InvalidPayload(
            "preview sample limit is zero",
        ));
    }
    check_cancelled(cancellation)?;
    let metadata: PotreeMetadata = serde_json::from_slice(&fs::read(&request.metadata_path)?)?;
    validate_metadata(&metadata)?;
    let hierarchy_bytes = fs::read(&request.hierarchy_path)?;
    let nodes = parse_hierarchy_cancellable(&metadata, &hierarchy_bytes, cancellation)?;
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
    let mut source = BufReader::with_capacity(IO_CHUNK_BYTES, File::open(&request.octree_path)?);
    let mut points = Vec::with_capacity(sample_limit.min(50_000));
    let mut visited = 0_u64;
    'nodes: for node in &nodes {
        check_cancelled(cancellation)?;
        let bytes = read_node_cancellable(&mut source, node, cancellation)?;
        for (record_index, record) in bytes.chunks_exact(stride).enumerate() {
            if record_index % 65_536 == 0 {
                check_cancelled(cancellation)?;
            }
            let point = decode_point(record, position_offset, &metadata)?;
            let class = classification_offset.map_or(0, |offset| record[offset]);
            if request.scope.visible_classes.contains(&class)
                && scope_contains(&request.scope, point)
            {
                points.push(point);
                if points.len() == sample_limit {
                    break 'nodes;
                }
            }
        }
        visited = visited.saturating_add(node.point_count);
        progress(GroundProgress {
            phase: GroundPhase::Grid,
            completed: visited.min(metadata.points),
            total: metadata.points.max(1),
        });
    }
    if points.is_empty() {
        return Err(PointcloudGroundError::InvalidPayload(
            "the captured P4 visible set is empty",
        ));
    }
    let classification = classify_ground_detailed(
        &points,
        &request.params,
        cancellation,
        |completed, total| {
            progress(GroundProgress {
                phase: if completed < total / 2 {
                    GroundPhase::Filter
                } else {
                    GroundPhase::Classify
                },
                completed,
                total: total.max(1),
            });
        },
    )
    .map_err(classification_error)?;
    let mut ground_points = 0_u64;
    let preview_points = points
        .into_iter()
        .zip(classification.classes)
        .map(|(point, class)| {
            let classification = if class == PointClass::Ground {
                ground_points = ground_points.saturating_add(1);
                PointClassPreview::Ground
            } else {
                PointClassPreview::NonGround
            };
            GroundPreviewPoint {
                position: transform_point(&request.scope.placement, point),
                classification,
            }
        })
        .collect::<Vec<_>>();
    let sampled_points = u64::try_from(preview_points.len())
        .map_err(|_| PointcloudGroundError::InvalidPayload("preview sample overflow"))?;
    Ok(GroundPreviewResult {
        sampled_points,
        ground_points,
        ratio: ground_points as f64 / sampled_points as f64,
        residuals: classification.residuals.into(),
        points: preview_points,
    })
}

pub(crate) fn validate_metadata(metadata: &PotreeMetadata) -> Result<(), PointcloudGroundError> {
    if !metadata.version.starts_with('2')
        || !matches!(
            metadata.encoding.to_ascii_uppercase().as_str(),
            "DEFAULT" | "UNCOMPRESSED"
        )
        || metadata.hierarchy.first_chunk_size == 0
        || metadata.attributes.is_empty()
        || metadata.scale.contains(&0.0)
        || metadata
            .scale
            .iter()
            .chain(metadata.offset.iter())
            .any(|value| !value.is_finite())
    {
        return Err(PointcloudGroundError::InvalidMetadata(
            "unsupported Potree 2 layout",
        ));
    }
    Ok(())
}

pub(crate) fn validate_scope(scope: &GroundScope) -> Result<(), PointcloudGroundError> {
    if scope.visible_classes.is_empty()
        || scope.placement.iter().any(|value| !value.is_finite())
        || scope.viewing_box.as_ref().is_some_and(|box_| {
            box_.center
                .iter()
                .chain(box_.half_extents.iter())
                .any(|value| !value.is_finite())
                || box_.half_extents.iter().any(|value| *value <= 0.0)
                || box_.rotation.iter().any(|value| !value.is_finite())
                || box_.rotation.iter().map(|value| value * value).sum::<f64>() <= 1e-24
        })
    {
        return Err(PointcloudGroundError::InvalidMetadata("invalid P4 scope"));
    }
    Ok(())
}

pub(crate) fn attribute_offset(
    attributes: &[PotreeAttribute],
    requested: &str,
) -> Result<Option<usize>, PointcloudGroundError> {
    let mut offset = 0_usize;
    for attribute in attributes {
        let normalized = attribute
            .name
            .chars()
            .filter(|character| !matches!(character, ' ' | '_' | '-'))
            .flat_map(char::to_lowercase)
            .collect::<String>();
        if normalized == requested {
            if (requested == "position" && attribute.size != 12)
                || (requested == "classification" && attribute.size != 1)
            {
                return Err(PointcloudGroundError::InvalidMetadata(
                    "unsupported attribute size",
                ));
            }
            return Ok(Some(offset));
        }
        offset =
            offset
                .checked_add(attribute.size)
                .ok_or(PointcloudGroundError::InvalidMetadata(
                    "attribute offset overflow",
                ))?;
    }
    Ok(None)
}

pub(crate) fn decode_point(
    record: &[u8],
    offset: usize,
    metadata: &PotreeMetadata,
) -> Result<Point3, PointcloudGroundError> {
    if record.len() < offset + 12 {
        return Err(PointcloudGroundError::InvalidPayload(
            "short position record",
        ));
    }
    let coordinate = |axis: usize| {
        let at = offset + axis * 4;
        let quantized = i32::from_le_bytes(record[at..at + 4].try_into().expect("position size"));
        f64::from(quantized) * metadata.scale[axis] + metadata.offset[axis]
    };
    let point = Point3 {
        x: coordinate(0),
        y: coordinate(1),
        z: coordinate(2),
    };
    if [point.x, point.y, point.z]
        .iter()
        .any(|value| !value.is_finite())
    {
        return Err(PointcloudGroundError::InvalidPayload("non-finite point"));
    }
    Ok(point)
}

pub(crate) fn scope_contains(scope: &GroundScope, point: Point3) -> bool {
    let world = transform_point(&scope.placement, point);
    let Some(box_) = &scope.viewing_box else {
        return true;
    };
    let [x, y, z, w] = normalized_quaternion(box_.rotation);
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
    let relative = [
        world[0] - box_.center[0],
        world[1] - box_.center[1],
        world[2] - box_.center[2],
    ];
    let inside = axes.iter().zip(box_.half_extents).all(|(axis, extent)| {
        (relative[0] * axis[0] + relative[1] * axis[1] + relative[2] * axis[2]).abs() <= extent
    });
    inside == box_.keep_inside
}

pub(crate) fn transform_point(matrix: &[f64; 16], point: Point3) -> [f64; 3] {
    [
        matrix[0] * point.x + matrix[4] * point.y + matrix[8] * point.z + matrix[12],
        matrix[1] * point.x + matrix[5] * point.y + matrix[9] * point.z + matrix[13],
        matrix[2] * point.x + matrix[6] * point.y + matrix[10] * point.z + matrix[14],
    ]
}

fn normalized_quaternion(rotation: [f64; 4]) -> [f64; 4] {
    let length = rotation
        .iter()
        .map(|value| value * value)
        .sum::<f64>()
        .sqrt();
    rotation.map(|value| value / length)
}

pub(crate) fn read_node(
    reader: &mut (impl Read + Seek),
    node: &SourceNode,
) -> Result<Vec<u8>, PointcloudGroundError> {
    reader.seek(SeekFrom::Start(node.byte_offset))?;
    let length = usize::try_from(node.byte_length)
        .map_err(|_| PointcloudGroundError::InvalidPayload("node byte length overflows"))?;
    let mut bytes = vec![0_u8; length];
    reader.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn read_node_cancellable(
    reader: &mut (impl Read + Seek),
    node: &SourceNode,
    cancellation: &CancellationToken,
) -> Result<Vec<u8>, PointcloudGroundError> {
    reader.seek(SeekFrom::Start(node.byte_offset))?;
    let length = usize::try_from(node.byte_length)
        .map_err(|_| PointcloudGroundError::InvalidPayload("node byte length overflows"))?;
    let mut bytes = vec![0_u8; length];
    for chunk in bytes.chunks_mut(IO_CHUNK_BYTES) {
        check_cancelled(cancellation)?;
        reader.read_exact(chunk)?;
    }
    Ok(bytes)
}

pub(crate) fn parse_hierarchy(
    metadata: &PotreeMetadata,
    bytes: &[u8],
) -> Result<Vec<SourceNode>, PointcloudGroundError> {
    parse_hierarchy_cancellable(metadata, bytes, &CancellationToken::new())
}

fn parse_hierarchy_cancellable(
    metadata: &PotreeMetadata,
    bytes: &[u8],
    cancellation: &CancellationToken,
) -> Result<Vec<SourceNode>, PointcloudGroundError> {
    let mut nodes = BTreeMap::new();
    let mut pages = VecDeque::from(parse_page(
        &mut nodes,
        "r",
        metadata.bounding_box,
        false,
        page_slice(bytes, 0, metadata.hierarchy.first_chunk_size)?,
        cancellation,
    )?);
    let mut loaded = BTreeSet::new();
    while let Some((root, (offset, length))) = pages.pop_front() {
        check_cancelled(cancellation)?;
        if !loaded.insert(root.clone()) {
            continue;
        }
        pages.extend(parse_page(
            &mut nodes,
            &root,
            metadata.bounding_box,
            true,
            page_slice(bytes, offset, length)?,
            cancellation,
        )?);
    }
    let mut ordered = Vec::with_capacity(nodes.len());
    let mut pending = VecDeque::from(["r".to_owned()]);
    let mut visited = BTreeSet::new();
    while let Some(id) = pending.pop_front() {
        if !visited.insert(id.clone()) {
            continue;
        }
        let node = nodes
            .get(&id)
            .ok_or(PointcloudGroundError::InvalidHierarchy(
                "missing child node",
            ))?;
        ordered.push(node.clone());
        pending.extend(node.children.iter().cloned());
    }
    Ok(ordered)
}

fn parse_page(
    target: &mut BTreeMap<String, SourceNode>,
    root_id: &str,
    root_bounds: PotreeBounds,
    root_was_proxy: bool,
    bytes: &[u8],
    cancellation: &CancellationToken,
) -> Result<Vec<(String, (u64, u64))>, PointcloudGroundError> {
    if bytes.is_empty() || !bytes.len().is_multiple_of(HIERARCHY_RECORD_BYTES) {
        return Err(PointcloudGroundError::InvalidHierarchy("page byte length"));
    }
    let mut pending = VecDeque::from([(root_id.to_owned(), root_bounds, root_was_proxy)]);
    let mut proxy_pages = Vec::new();
    for (record_index, record) in bytes.chunks_exact(HIERARCHY_RECORD_BYTES).enumerate() {
        if record_index % 2_048 == 0 {
            check_cancelled(cancellation)?;
        }
        let (id, bounds, was_proxy) =
            pending
                .pop_front()
                .ok_or(PointcloudGroundError::InvalidHierarchy(
                    "unreachable record",
                ))?;
        let node_type = record[0];
        let child_mask = record[1];
        let point_count = u64::from(u32::from_le_bytes(record[2..6].try_into().expect("count")));
        let byte_offset = u64::from_le_bytes(record[6..14].try_into().expect("offset"));
        let byte_length = u64::from_le_bytes(record[14..22].try_into().expect("length"));
        let is_proxy = node_type == PROXY_NODE && !was_proxy;
        if is_proxy {
            proxy_pages.push((id.clone(), (byte_offset, byte_length)));
        }
        let mut children = Vec::new();
        if !is_proxy {
            for child in 0_u8..8 {
                if child_mask & (1 << child) == 0 {
                    continue;
                }
                let child_id = format!("{id}{child}");
                children.push(child_id.clone());
                pending.push_back((child_id, child_bounds(bounds, child), false));
            }
        }
        target.insert(
            id.clone(),
            SourceNode {
                id,
                children,
                point_count,
                byte_offset,
                byte_length,
            },
        );
    }
    if !pending.is_empty() {
        return Err(PointcloudGroundError::InvalidHierarchy(
            "page ended before its children",
        ));
    }
    Ok(proxy_pages)
}

fn page_slice(bytes: &[u8], offset: u64, length: u64) -> Result<&[u8], PointcloudGroundError> {
    let start = usize::try_from(offset)
        .map_err(|_| PointcloudGroundError::InvalidHierarchy("page offset overflow"))?;
    let length = usize::try_from(length)
        .map_err(|_| PointcloudGroundError::InvalidHierarchy("page length overflow"))?;
    bytes
        .get(start..start.saturating_add(length))
        .ok_or(PointcloudGroundError::InvalidHierarchy("page range"))
}

fn child_bounds(parent: PotreeBounds, child: u8) -> PotreeBounds {
    let middle: [f64; 3] =
        std::array::from_fn(|axis| parent.min[axis] + (parent.max[axis] - parent.min[axis]) * 0.5);
    PotreeBounds {
        min: std::array::from_fn(|axis| {
            if child & (1 << (2 - axis)) == 0 {
                parent.min[axis]
            } else {
                middle[axis]
            }
        }),
        max: std::array::from_fn(|axis| {
            if child & (1 << (2 - axis)) == 0 {
                middle[axis]
            } else {
                parent.max[axis]
            }
        }),
    }
}

pub(crate) fn encode_flat_hierarchy(
    nodes: &[SourceNode],
    counts: &BTreeMap<String, u64>,
    stride: usize,
) -> Result<Vec<u8>, PointcloudGroundError> {
    let mut output = Vec::with_capacity(nodes.len() * HIERARCHY_RECORD_BYTES);
    let mut offset = 0_u64;
    for node in nodes {
        output.push(0);
        let mask = node.children.iter().fold(0_u8, |mask, child| {
            mask | 1 << child.as_bytes().last().map_or(0, |digit| digit - b'0')
        });
        output.push(mask);
        let count = *counts.get(&node.id).unwrap_or(&0);
        let count32 = u32::try_from(count)
            .map_err(|_| PointcloudGroundError::InvalidPayload("node point count exceeds u32"))?;
        let length =
            count
                .checked_mul(stride as u64)
                .ok_or(PointcloudGroundError::InvalidPayload(
                    "node byte length overflow",
                ))?;
        output.extend_from_slice(&count32.to_le_bytes());
        output.extend_from_slice(&offset.to_le_bytes());
        output.extend_from_slice(&length.to_le_bytes());
        offset = offset.saturating_add(length);
    }
    Ok(output)
}

pub(crate) fn set_classification_histogram(
    metadata: &mut PotreeMetadata,
    counts: &[u64; 256],
) -> Result<(), PointcloudGroundError> {
    let attribute = metadata
        .attributes
        .iter_mut()
        .find(|attribute| {
            attribute
                .name
                .chars()
                .filter(|character| !matches!(character, ' ' | '_' | '-'))
                .flat_map(char::to_lowercase)
                .eq("classification".chars())
        })
        .ok_or(PointcloudGroundError::InvalidMetadata(
            "classification attribute is missing",
        ))?;
    let histogram = counts
        .iter()
        .copied()
        .map(serde_json::Value::from)
        .collect::<Vec<_>>();
    attribute
        .extensions
        .insert("histogram".to_owned(), histogram.into());
    let minimum = counts.iter().position(|count| *count > 0).unwrap_or(0);
    let maximum = counts.iter().rposition(|count| *count > 0).unwrap_or(0);
    attribute
        .extensions
        .insert("min".to_owned(), serde_json::json!([minimum]));
    attribute
        .extensions
        .insert("max".to_owned(), serde_json::json!([maximum]));
    Ok(())
}

pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), PointcloudGroundError> {
    let mut writer = BufWriter::new(File::create(path)?);
    serde_json::to_writer(&mut writer, value)?;
    writer.flush()?;
    Ok(())
}

fn describe_dataset(
    root: PathBuf,
    point_count: u64,
    cancellation: &CancellationToken,
) -> Result<PreparedGroundDataset, PointcloudGroundError> {
    let specifications = [
        ("metadata.json", "application/json"),
        ("hierarchy.bin", "application/vnd.potree.hierarchy"),
        ("octree.bin", "application/vnd.potree.points"),
    ];
    let mut artifacts = Vec::with_capacity(specifications.len());
    for (relative_path, media_type) in specifications {
        let path = root.join(relative_path);
        let (object_hash, byte_length) = hash_file_cancellable(&path, cancellation)?;
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

pub(crate) fn hash_file(path: &Path) -> Result<(ObjectHash, u64), PointcloudGroundError> {
    hash_file_cancellable(path, &CancellationToken::new())
}

fn hash_file_cancellable(
    path: &Path,
    cancellation: &CancellationToken,
) -> Result<(ObjectHash, u64), PointcloudGroundError> {
    let mut reader = BufReader::with_capacity(IO_CHUNK_BYTES, File::open(path)?);
    let mut digest = Sha256::new();
    let mut length = 0_u64;
    let mut buffer = vec![0_u8; IO_CHUNK_BYTES];
    loop {
        check_cancelled(cancellation)?;
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        length = length.saturating_add(read as u64);
    }
    Ok((ObjectHash(hex::encode(digest.finalize())), length))
}

pub(crate) fn check_cancelled(
    cancellation: &CancellationToken,
) -> Result<(), PointcloudGroundError> {
    if cancellation.is_cancel_requested() {
        Err(PointcloudGroundError::Cancelled)
    } else {
        Ok(())
    }
}

fn classification_error(error: GroundClassificationError) -> PointcloudGroundError {
    if error == GroundClassificationError::Cancelled {
        PointcloudGroundError::Cancelled
    } else {
        PointcloudGroundError::Classification(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p4_scope_excludes_outside_points_and_results_hash_deterministically() {
        let root = std::env::temp_dir().join(format!(
            "hcad-ground-potree-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("fixture root");
        write_fixture(&root);
        let mut fixture_bytes = fs::read(root.join("octree.bin")).expect("fixture octree");
        fixture_bytes[12] = 5;
        fs::write(root.join("octree.bin"), fixture_bytes).expect("hide one inside class");
        let run = |name: &str| {
            prepare_ground_datasets(
                &GroundPrepareRequest {
                    metadata_path: root.join("metadata.json"),
                    hierarchy_path: root.join("hierarchy.bin"),
                    octree_path: root.join("octree.bin"),
                    output_root: root.join(name),
                    output_name: "Ground".to_owned(),
                    params: SmrfParams {
                        cell_size_m: 1.0,
                        slope: 0.15,
                        max_window_m: 3.0,
                        initial_distance_m: 0.5,
                    },
                    scope: GroundScope {
                        visible_classes: [1].into_iter().collect(),
                        viewing_box: Some(GroundViewingBox {
                            center: [2.0, 1.0, 0.0],
                            half_extents: [2.1, 2.0, 10.0],
                            rotation: [0.0, 0.0, 0.0, 1.0],
                            keep_inside: true,
                        }),
                        placement: GroundScope::default().placement,
                    },
                },
                &CancellationToken::new(),
                |_| {},
            )
            .expect("ground extraction")
        };
        let first = run("first");
        let second = run("second");
        assert_eq!(
            first.summary.membership_sha256,
            second.summary.membership_sha256
        );
        eprintln!(
            "prepared small fixture membership SHA-256 {}",
            first.summary.membership_sha256.0
        );
        assert_eq!(
            first.summary.membership_sha256.0,
            "23a940a6043100652d2440a59cc939d38ffc9531f29244cd1ba46c10e56f096a"
        );
        assert_eq!(first.summary.scoped_points, 14);
        assert!(first.summary.ground_points > 0);
        assert!(first.summary.ground_points <= first.summary.scoped_points);
        assert_eq!(
            first.extracted.artifacts[2].byte_length,
            first.summary.ground_points * 13
        );
        let edited = fs::read(first.source.root.join("octree.bin")).expect("edited source");
        // One in-box class-5 point is hidden by P9 and remains class 5.
        assert_eq!(edited[12], 5);
        // Five x=10 points are outside the active viewing box and remain class 1.
        assert!(edited
            .chunks_exact(13)
            .skip(15)
            .all(|record| record[12] == 1));
        if std::env::var_os("HCAD_GROUND_KEEP_TEST_OUTPUT").is_some() {
            eprintln!("retained prepared ground fixture at {}", root.display());
        } else {
            let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn cancellation_before_bake_leaves_no_published_dataset_contract() {
        let root = std::env::temp_dir().join(format!("hcad-ground-cancel-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("fixture root");
        write_fixture(&root);
        let cancellation = CancellationToken::new();
        cancellation.request_cancel();
        let error = prepare_ground_datasets(
            &GroundPrepareRequest {
                metadata_path: root.join("metadata.json"),
                hierarchy_path: root.join("hierarchy.bin"),
                octree_path: root.join("octree.bin"),
                output_root: root.join("cancelled"),
                output_name: "Ground".to_owned(),
                params: SmrfParams::default(),
                scope: GroundScope::default(),
            },
            &cancellation,
            |_| {},
        )
        .expect_err("cancelled");
        assert!(matches!(error, PointcloudGroundError::Cancelled));
        assert!(!root.join("cancelled/ground/metadata.json").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn every_ground_phase_observes_cancellation_without_a_ready_dataset() {
        let root = std::env::temp_dir().join(format!("hcad-ground-phases-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("fixture root");
        write_fixture(&root);
        for phase in [
            GroundPhase::Grid,
            GroundPhase::Filter,
            GroundPhase::Classify,
            GroundPhase::Bake,
        ] {
            let cancellation = CancellationToken::new();
            let output = root.join(format!("cancel-{phase:?}"));
            let result = prepare_ground_datasets(
                &GroundPrepareRequest {
                    metadata_path: root.join("metadata.json"),
                    hierarchy_path: root.join("hierarchy.bin"),
                    octree_path: root.join("octree.bin"),
                    output_root: output.clone(),
                    output_name: "Ground".to_owned(),
                    params: SmrfParams {
                        max_window_m: 3.0,
                        ..SmrfParams::default()
                    },
                    scope: GroundScope::default(),
                },
                &cancellation,
                |progress| {
                    if progress.phase == phase {
                        cancellation.request_cancel();
                    }
                },
            );
            assert!(
                matches!(result, Err(PointcloudGroundError::Cancelled)),
                "{phase:?}"
            );
            assert!(!output.join("ground/metadata.json").exists(), "{phase:?}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn preview_is_bounded_and_reports_renderer_ready_classes() {
        let root = std::env::temp_dir().join(format!("hcad-ground-preview-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("fixture root");
        write_fixture(&root);
        let result = preview_ground(
            &GroundPrepareRequest {
                metadata_path: root.join("metadata.json"),
                hierarchy_path: root.join("hierarchy.bin"),
                octree_path: root.join("octree.bin"),
                output_root: root.join("unused"),
                output_name: "Preview".to_owned(),
                params: SmrfParams {
                    max_window_m: 3.0,
                    ..SmrfParams::default()
                },
                scope: GroundScope::default(),
            },
            8,
            &CancellationToken::new(),
            |_| {},
        )
        .expect("preview");
        assert_eq!(result.sampled_points, 8);
        assert_eq!(result.points.len(), 8);
        assert!(result.points.iter().all(|point| matches!(
            point.classification,
            PointClassPreview::Ground | PointClassPreview::NonGround
        )));
        assert!(!root.join("unused").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore = "104 M-point real-data gate; run through scripts/verify-pointcloud-extraction.mjs"]
    fn outdoor_ground_real_dataset_floor() {
        let root = PathBuf::from(
            std::env::var("HCAD_GROUND_REAL_DATASET")
                .expect("HCAD_GROUND_REAL_DATASET must name the prepared Potree fixture"),
        );
        let output = std::env::temp_dir().join(format!("hcad-ground-real-{}", std::process::id()));
        let _ = fs::remove_dir_all(&output);
        let result = prepare_ground_datasets(
            &GroundPrepareRequest {
                metadata_path: root.join("metadata.json"),
                hierarchy_path: root.join("hierarchy.bin"),
                octree_path: root.join("octree.bin"),
                output_root: output.clone(),
                output_name: "Outdoor ground".to_owned(),
                params: SmrfParams::default(),
                scope: GroundScope::default(),
            },
            &CancellationToken::new(),
            |progress| {
                eprintln!(
                    "ground-real {:?} {}/{}",
                    progress.phase, progress.completed, progress.total
                )
            },
        )
        .expect("real outdoor extraction");
        assert!(result.summary.source_points >= 100_000_000);
        assert_eq!(result.summary.scoped_points, result.summary.source_points);
        assert!(result.summary.ground_points > 0);
        assert!(result.summary.ground_points < result.summary.scoped_points);
        assert_eq!(result.extracted.point_count, result.summary.ground_points);
        assert!(result.summary.residuals.standard_deviation_m.is_finite());
        assert_eq!(result.source.artifacts.len(), 3);
        assert_eq!(result.extracted.artifacts.len(), 3);
        eprintln!(
            "ground-real summary source={} scoped={} ground={} ratio={:.6} residual_sigma_m={:.6} membership_sha256={} source_bytes={} ground_bytes={}",
            result.summary.source_points,
            result.summary.scoped_points,
            result.summary.ground_points,
            result.summary.ratio,
            result.summary.residuals.standard_deviation_m,
            result.summary.membership_sha256.0,
            result
                .source
                .artifacts
                .iter()
                .map(|artifact| artifact.byte_length)
                .sum::<u64>(),
            result
                .extracted
                .artifacts
                .iter()
                .map(|artifact| artifact.byte_length)
                .sum::<u64>(),
        );
        let _ = fs::remove_dir_all(&output);
    }

    #[test]
    #[ignore = "104 M-point cancellation gate; run through scripts/verify-pointcloud-extraction.mjs"]
    fn outdoor_ground_real_dataset_cancels_at_every_phase_without_a_ready_dataset() {
        let root = PathBuf::from(
            std::env::var("HCAD_GROUND_REAL_DATASET")
                .expect("HCAD_GROUND_REAL_DATASET must name the prepared Potree fixture"),
        );
        for phase in [
            GroundPhase::Grid,
            GroundPhase::Filter,
            GroundPhase::Classify,
            GroundPhase::Bake,
        ] {
            let output = std::env::temp_dir().join(format!(
                "hcad-ground-real-cancel-{}-{phase:?}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&output);
            let cancellation = CancellationToken::new();
            let signal = cancellation.clone();
            let result = prepare_ground_datasets(
                &GroundPrepareRequest {
                    metadata_path: root.join("metadata.json"),
                    hierarchy_path: root.join("hierarchy.bin"),
                    octree_path: root.join("octree.bin"),
                    output_root: output.clone(),
                    output_name: "Outdoor ground".to_owned(),
                    params: SmrfParams::default(),
                    scope: GroundScope::default(),
                },
                &cancellation,
                |progress| {
                    if progress.phase == phase {
                        signal.request_cancel();
                    }
                },
            );
            assert!(
                matches!(result, Err(PointcloudGroundError::Cancelled)),
                "real fixture did not cancel during {phase:?}: {result:?}"
            );
            assert!(
                !output.join("source-edited/metadata.json").exists()
                    && !output.join("ground/metadata.json").exists(),
                "cancelled {phase:?} phase exposed a ready dataset"
            );
            eprintln!("ground-real cancellation phase={phase:?} ready_dataset=false");
            let _ = fs::remove_dir_all(&output);
        }
    }

    fn write_fixture(root: &Path) {
        let metadata = serde_json::json!({
            "version": "2.0",
            "name": "small-las-fixture",
            "points": 20,
            "hierarchy": { "firstChunkSize": 22, "stepSize": 4, "depth": 0 },
            "offset": [0.0, 0.0, 0.0],
            "scale": [0.01, 0.01, 0.01],
            "spacing": 1.0,
            "boundingBox": { "min": [0.0, 0.0, 0.0], "max": [10.0, 4.0, 5.0] },
            "encoding": "UNCOMPRESSED",
            "attributes": [
                { "name": "position", "size": 12, "numElements": 3, "elementSize": 4, "type": "int32" },
                { "name": "classification", "size": 1, "numElements": 1, "elementSize": 1, "type": "uint8", "histogram": [0, 20] }
            ]
        });
        fs::write(
            root.join("metadata.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        let mut points = Vec::new();
        for index in 0_i32..20 {
            let x = if index < 15 { index % 5 } else { 10 };
            let y = index / 5;
            let z = if index == 4 { 300 } else { x * 5 };
            points.extend_from_slice(&(x * 100).to_le_bytes());
            points.extend_from_slice(&(y * 100).to_le_bytes());
            points.extend_from_slice(&z.to_le_bytes());
            points.push(1);
        }
        fs::write(root.join("octree.bin"), &points).unwrap();
        let mut hierarchy = vec![0, 0];
        hierarchy.extend_from_slice(&20_u32.to_le_bytes());
        hierarchy.extend_from_slice(&0_u64.to_le_bytes());
        hierarchy.extend_from_slice(&(points.len() as u64).to_le_bytes());
        fs::write(root.join("hierarchy.bin"), hierarchy).unwrap();
    }
}
