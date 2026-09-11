//! Deterministic, bounded PC-D8/PC-D17 point-cloud sampling and height-grid baking.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use himmelcad_core::hash::ObjectHash;
use himmelcad_core::mesh_surface::SurfacePoint;
use himmelcad_core::photolab_jobs::CancellationToken;
use himmelcad_render::{
    BoundingVolume, ContentKind, ContentReference, PreparedHierarchyManifest, RefinementMode,
    TileDescriptor, TileId, WorldAabb, WorldTransform, WorldVec3,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::pointcloud_ground::{
    attribute_offset, check_cancelled, decode_point, encode_flat_hierarchy, hash_file,
    parse_hierarchy, read_node, scope_contains, set_classification_histogram, transform_point,
    validate_metadata, validate_scope, write_json, GroundScope, PointcloudGroundError,
    PotreeMetadata, PreparedGroundArtifact, PreparedGroundDataset, SourceNode,
    HIERARCHY_RECORD_BYTES, IO_CHUNK_BYTES, MAX_NODE_BYTES,
};

/// Immutable recipe kind for PC-D8 sampling.
pub const SAMPLE_ALGORITHM_ID: &str = "hcad.pointcloud.sample@1";
/// Immutable recipe kind for PC-D17 grid products.
pub const RASTERIZE_ALGORITHM_ID: &str = "hcad.pointcloud.rasterize-height@1";
/// Prepared dataset id consumed by the Mesh 0.5-05 grid-source reader.
pub const HEIGHT_GRID_FORMAT_ID: &str = "hcad.pointcloud.height-grid@1";
pub const HEIGHT_GRID_MEDIA_TYPE: &str = HEIGHT_GRID_FORMAT_ID;
pub const HEIGHT_GRID_MAGIC: &[u8; 8] = b"HCGRID01";
pub const HEIGHT_GRID_HEADER_BYTES: usize = 42;
pub const HEIGHT_GRID_RECORD_BYTES: usize = 25;
/// Fixed seed recorded by random recipes. Point ids, not traversal arrival, drive selection.
pub const RANDOM_SEED: u64 = 0x4843_4144_5038_0001;
/// X6 ceiling: output-grid memory is bounded independently from source point count.
pub const MAX_RASTER_CELLS: u64 = 50_000_000;
/// Distance/grid working sets fail safely instead of growing with an unbounded source.
pub const MAX_SAMPLE_INDEX_ENTRIES: usize = 10_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SamplingMethod {
    Distance,
    Grid,
    Random,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SamplingParameters {
    pub method: SamplingMethod,
    pub spacing_m: f64,
    pub percentage: f64,
    pub origin_x: Option<f64>,
    pub origin_y: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RasterAggregation {
    Mean,
    Min,
    Max,
    Count,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EmptyCellPolicy {
    NoData,
    Fill { value: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RasterizeParameters {
    pub cell_size_m: f64,
    pub origin_x: Option<f64>,
    pub origin_y: Option<f64>,
    pub aggregation: RasterAggregation,
    pub empty_cell_policy: EmptyCellPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SamplingPhase {
    Scan,
    Select,
    Bake,
}

impl SamplingPhase {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Scan => "Scanning visible points",
            Self::Select => "Selecting deterministic samples",
            Self::Bake => "Baking prepared dataset",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RasterizePhase {
    Scan,
    Aggregate,
    Bake,
}

impl RasterizePhase {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Scan => "Scanning grid bounds",
            Self::Aggregate => "Aggregating grid cells",
            Self::Bake => "Baking prepared height grid",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SamplingProgress {
    pub phase: SamplingPhase,
    pub completed: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RasterizeProgress {
    pub phase: RasterizePhase,
    pub completed: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SamplePrepareRequest {
    pub metadata_path: PathBuf,
    pub hierarchy_path: PathBuf,
    pub octree_path: PathBuf,
    pub output_root: PathBuf,
    pub output_name: String,
    pub parameters: SamplingParameters,
    pub scope: GroundScope,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RasterizePrepareRequest {
    pub metadata_path: PathBuf,
    pub hierarchy_path: PathBuf,
    pub octree_path: PathBuf,
    pub output_root: PathBuf,
    pub parameters: RasterizeParameters,
    pub scope: GroundScope,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SampleSummary {
    pub source_points: u64,
    pub scoped_points: u64,
    pub sampled_points: u64,
    pub method: SamplingMethod,
    pub spacing_m: Option<f64>,
    pub percentage: Option<f64>,
    pub stable_tie_rule: String,
    pub selection_sha256: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedSampleResult {
    pub sampled: PreparedGroundDataset,
    pub summary: SampleSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RasterSummary {
    pub source_points: u64,
    pub scoped_points: u64,
    pub width: u32,
    pub height: u32,
    pub cell_size_m: f64,
    pub origin: [f64; 2],
    pub aggregation: RasterAggregation,
    pub empty_cell_policy: EmptyCellPolicy,
    pub empty_cells: u64,
    pub empty_ratio: f64,
    pub cell_sha256: ObjectHash,
    pub mesh_eligible: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedHeightGrid {
    pub root: PathBuf,
    pub artifact: PreparedGroundArtifact,
    pub viewer_manifest: PreparedGroundArtifact,
    pub viewer_artifacts: Vec<PreparedGroundArtifact>,
    pub summary: RasterSummary,
}

/// Streams one Potree source into the MT-D17 bounded XY-grid working set.
/// The representative is the existing point nearest the cell mean Z, then the
/// cell centre, then stable logical point id. No coordinate or height is
/// synthesized by this adapter.
pub fn read_surface_points(
    metadata_path: &Path,
    hierarchy_path: &Path,
    octree_path: &Path,
    source_id: &str,
    spacing: f64,
    scope: &GroundScope,
    cancellation: &CancellationToken,
    mut progress: impl FnMut(SamplingProgress),
) -> Result<Vec<SurfacePoint>, PointcloudSamplingError> {
    validate_scope(scope)?;
    if !spacing.is_finite() || spacing <= 0.0 {
        return Err(PointcloudSamplingError::Invalid(
            "surface sampling spacing must be finite and positive",
        ));
    }
    let source = OpenPotree::open(metadata_path, hierarchy_path)?;
    let total = source.metadata.points.max(1);
    let origin = [0.0, 0.0];
    let mut cells = BTreeMap::<(i64, i64), GridAccumulator>::new();
    let mut reader = BufReader::with_capacity(IO_CHUNK_BYTES, File::open(octree_path)?);
    let mut visited = 0_u64;
    for node in &source.nodes {
        check_sampling_cancelled(cancellation)?;
        ensure_bounded_node(node)?;
        let bytes = read_node(&mut reader, node)?;
        for record in bytes.chunks_exact(source.stride) {
            let local = decode_point(record, source.position_offset, &source.metadata)?;
            let class = source
                .classification_offset
                .map_or(0, |offset| record[offset]);
            if scope.visible_classes.contains(&class) && scope_contains(scope, local) {
                let world = transform_point(&scope.placement, local);
                cells
                    .entry(cell2(world, origin, spacing)?)
                    .and_modify(|entry| entry.add(world[2]))
                    .or_insert_with(|| GridAccumulator::new(world[2]));
                if cells.len() > MAX_SAMPLE_INDEX_ENTRIES {
                    return Err(PointcloudSamplingError::Invalid(
                        "surface working set exceeds the bounded 10 M-cell ceiling; increase thin-cloud spacing",
                    ));
                }
            }
        }
        visited = visited.saturating_add(node.point_count);
        progress(SamplingProgress {
            phase: SamplingPhase::Scan,
            completed: visited.min(total),
            total,
        });
    }
    if cells.is_empty() {
        return Err(PointcloudSamplingError::Invalid(
            "the captured P4 visible set is empty",
        ));
    }
    let mut candidates = cells
        .into_iter()
        .map(|(cell, accumulator)| {
            (
                cell,
                GridCandidate {
                    mean_z: accumulator.mean(),
                    point_id: u64::MAX,
                    dz: f64::INFINITY,
                    center_distance_squared: f64::INFINITY,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    reader = BufReader::with_capacity(IO_CHUNK_BYTES, File::open(octree_path)?);
    visited = 0;
    let mut logical_id = 0_u64;
    for node in &source.nodes {
        check_sampling_cancelled(cancellation)?;
        let bytes = read_node(&mut reader, node)?;
        for record in bytes.chunks_exact(source.stride) {
            let local = decode_point(record, source.position_offset, &source.metadata)?;
            let class = source
                .classification_offset
                .map_or(0, |offset| record[offset]);
            if scope.visible_classes.contains(&class) && scope_contains(scope, local) {
                let world = transform_point(&scope.placement, local);
                let cell = cell2(world, origin, spacing)?;
                let candidate = candidates
                    .get_mut(&cell)
                    .ok_or(PointcloudSamplingError::Invalid("surface cell disappeared"))?;
                let dz = (world[2] - candidate.mean_z).abs();
                let center = cell_center(cell, origin, spacing);
                let center_distance_squared =
                    (world[0] - center[0]).powi(2) + (world[1] - center[1]).powi(2);
                if (dz, center_distance_squared, logical_id)
                    < (
                        candidate.dz,
                        candidate.center_distance_squared,
                        candidate.point_id,
                    )
                {
                    candidate.point_id = logical_id;
                    candidate.dz = dz;
                    candidate.center_distance_squared = center_distance_squared;
                }
            }
            logical_id = logical_id.saturating_add(1);
        }
        visited = visited.saturating_add(node.point_count);
        progress(SamplingProgress {
            phase: SamplingPhase::Select,
            completed: visited.min(total),
            total,
        });
    }
    let selected = candidates
        .into_values()
        .map(|candidate| candidate.point_id)
        .collect::<BTreeSet<_>>();
    let mut result = Vec::with_capacity(selected.len());
    reader = BufReader::with_capacity(IO_CHUNK_BYTES, File::open(octree_path)?);
    visited = 0;
    logical_id = 0;
    for node in &source.nodes {
        check_sampling_cancelled(cancellation)?;
        let bytes = read_node(&mut reader, node)?;
        for record in bytes.chunks_exact(source.stride) {
            if selected.contains(&logical_id) {
                let local = decode_point(record, source.position_offset, &source.metadata)?;
                let world = transform_point(&scope.placement, local);
                result.push(SurfacePoint {
                    point_id: format!("{source_id}:{logical_id}"),
                    source_id: source_id.to_owned(),
                    position: [world[0], world[1]],
                    z: Some(world[2]),
                });
            }
            logical_id = logical_id.saturating_add(1);
        }
        visited = visited.saturating_add(node.point_count);
        progress(SamplingProgress {
            phase: SamplingPhase::Bake,
            completed: visited.min(total),
            total,
        });
    }
    Ok(result)
}

#[derive(Debug, Error)]
pub enum PointcloudSamplingError {
    #[error("point-cloud sampling was cancelled")]
    Cancelled,
    #[error("point-cloud sampling I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("point-cloud sampling metadata: {0}")]
    Json(#[from] serde_json::Error),
    #[error("point-cloud sampling input is invalid: {0}")]
    Invalid(&'static str),
    #[error("prepared height-grid viewer manifest is invalid: {0}")]
    ViewerManifest(String),
    #[error(transparent)]
    Prepared(#[from] PointcloudGroundError),
}

#[derive(Debug, Clone, Copy)]
struct GridAccumulator {
    count: u64,
    mean: f64,
    m2: f64,
    minimum: f64,
    maximum: f64,
}

impl GridAccumulator {
    fn new(z: f64) -> Self {
        Self {
            count: 1,
            mean: z,
            m2: 0.0,
            minimum: z,
            maximum: z,
        }
    }

    fn add(&mut self, z: f64) {
        self.count = self.count.saturating_add(1);
        // Welford's update is stable in source order and avoids z*z overflow for
        // the gate's extreme-elevation oracle cells.
        let delta = z - self.mean;
        self.mean += delta / self.count as f64;
        let delta_after = z - self.mean;
        self.m2 += delta * delta_after;
        self.minimum = self.minimum.min(z);
        self.maximum = self.maximum.max(z);
    }

    fn mean(self) -> f64 {
        self.mean
    }

    fn variance(self) -> f64 {
        (self.m2 / self.count as f64).max(0.0)
    }
}

#[derive(Debug, Clone, Copy)]
struct GridCandidate {
    mean_z: f64,
    point_id: u64,
    dz: f64,
    center_distance_squared: f64,
}

#[derive(Debug, Clone, Copy)]
struct AcceptedPoint {
    world: [f64; 3],
}

struct OpenPotree {
    metadata: PotreeMetadata,
    nodes: Vec<SourceNode>,
    stride: usize,
    position_offset: usize,
    classification_offset: Option<usize>,
}

impl OpenPotree {
    fn open(metadata_path: &Path, hierarchy_path: &Path) -> Result<Self, PointcloudSamplingError> {
        let metadata: PotreeMetadata = serde_json::from_slice(&fs::read(metadata_path)?)?;
        validate_metadata(&metadata)?;
        let hierarchy_bytes = fs::read(hierarchy_path)?;
        let nodes = parse_hierarchy(&metadata, &hierarchy_bytes)?;
        let stride = metadata
            .attributes
            .iter()
            .try_fold(0_usize, |sum, attribute| sum.checked_add(attribute.size))
            .ok_or(PointcloudSamplingError::Invalid(
                "attribute stride overflow",
            ))?;
        let position_offset = attribute_offset(&metadata.attributes, "position")?.ok_or(
            PointcloudSamplingError::Invalid("position attribute is missing"),
        )?;
        let classification_offset = attribute_offset(&metadata.attributes, "classification")?;
        Ok(Self {
            metadata,
            nodes,
            stride,
            position_offset,
            classification_offset,
        })
    }
}

/// Creates an ordinary Potree dataset. Source files and the canonical source entity are read-only.
pub fn prepare_sampled_cloud(
    request: &SamplePrepareRequest,
    cancellation: &CancellationToken,
    mut progress: impl FnMut(SamplingProgress),
) -> Result<PreparedSampleResult, PointcloudSamplingError> {
    validate_scope(&request.scope)?;
    validate_sampling_parameters(request.parameters)?;
    check_sampling_cancelled(cancellation)?;
    let source = OpenPotree::open(&request.metadata_path, &request.hierarchy_path)?;
    let total = source.metadata.points.max(1);

    let mut scoped_points = 0_u64;
    let mut selected_ids = BTreeSet::new();
    let mut distance_index = BTreeMap::<(i64, i64, i64), Vec<AcceptedPoint>>::new();
    let mut grid_accumulators = BTreeMap::<(i64, i64), GridAccumulator>::new();
    let origin = sampling_origin(request.parameters);
    let spacing = request.parameters.spacing_m;
    let spacing_squared = spacing * spacing;
    let mut reader = BufReader::with_capacity(IO_CHUNK_BYTES, File::open(&request.octree_path)?);
    let mut visited = 0_u64;
    let mut point_id = 0_u64;
    for node in &source.nodes {
        check_sampling_cancelled(cancellation)?;
        ensure_bounded_node(node)?;
        let bytes = read_node(&mut reader, node)?;
        for record in bytes.chunks_exact(source.stride) {
            let point = decode_point(record, source.position_offset, &source.metadata)?;
            let class = source
                .classification_offset
                .map_or(0, |offset| record[offset]);
            if request.scope.visible_classes.contains(&class)
                && scope_contains(&request.scope, point)
            {
                scoped_points = scoped_points.saturating_add(1);
                let world = transform_point(&request.scope.placement, point);
                match request.parameters.method {
                    SamplingMethod::Distance => {
                        let cell = cell3(world, spacing)?;
                        let separated = neighbor_cells(cell).all(|neighbor| {
                            distance_index.get(&neighbor).is_none_or(|accepted| {
                                accepted.iter().all(|candidate| {
                                    squared_distance(world, candidate.world) >= spacing_squared
                                })
                            })
                        });
                        if separated {
                            selected_ids.insert(point_id);
                            if selected_ids.len() > MAX_SAMPLE_INDEX_ENTRIES {
                                return Err(PointcloudSamplingError::Invalid(
                                    "sampling index exceeds the bounded 10 M-entry ceiling",
                                ));
                            }
                            distance_index
                                .entry(cell)
                                .or_default()
                                .push(AcceptedPoint { world });
                        }
                    }
                    SamplingMethod::Grid => {
                        let cell = cell2(world, origin, spacing)?;
                        grid_accumulators
                            .entry(cell)
                            .and_modify(|entry| entry.add(world[2]))
                            .or_insert_with(|| GridAccumulator::new(world[2]));
                        if grid_accumulators.len() > MAX_SAMPLE_INDEX_ENTRIES {
                            return Err(PointcloudSamplingError::Invalid(
                                "sampling grid exceeds the bounded 10 M-cell ceiling",
                            ));
                        }
                    }
                    SamplingMethod::Random => {}
                }
            }
            point_id = point_id.saturating_add(1);
        }
        visited = visited.saturating_add(node.point_count);
        progress(SamplingProgress {
            phase: SamplingPhase::Scan,
            completed: visited.min(total),
            total,
        });
    }
    validate_visited(&source, visited, point_id)?;
    if scoped_points == 0 {
        return Err(PointcloudSamplingError::Invalid(
            "the captured P4 visible set is empty",
        ));
    }

    let mut grid_candidates = grid_accumulators
        .into_iter()
        .map(|(cell, accumulator)| {
            (
                cell,
                GridCandidate {
                    mean_z: accumulator.mean(),
                    point_id: u64::MAX,
                    dz: f64::INFINITY,
                    center_distance_squared: f64::INFINITY,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    if request.parameters.method == SamplingMethod::Grid {
        let mut reader =
            BufReader::with_capacity(IO_CHUNK_BYTES, File::open(&request.octree_path)?);
        visited = 0;
        point_id = 0;
        for node in &source.nodes {
            check_sampling_cancelled(cancellation)?;
            let bytes = read_node(&mut reader, node)?;
            for record in bytes.chunks_exact(source.stride) {
                let point = decode_point(record, source.position_offset, &source.metadata)?;
                let class = source
                    .classification_offset
                    .map_or(0, |offset| record[offset]);
                if request.scope.visible_classes.contains(&class)
                    && scope_contains(&request.scope, point)
                {
                    let world = transform_point(&request.scope.placement, point);
                    let cell = cell2(world, origin, spacing)?;
                    let candidate = grid_candidates
                        .get_mut(&cell)
                        .ok_or(PointcloudSamplingError::Invalid("grid cell disappeared"))?;
                    let dz = (world[2] - candidate.mean_z).abs();
                    let center = cell_center(cell, origin, spacing);
                    let center_distance_squared =
                        (world[0] - center[0]).powi(2) + (world[1] - center[1]).powi(2);
                    if (dz, center_distance_squared, point_id)
                        < (
                            candidate.dz,
                            candidate.center_distance_squared,
                            candidate.point_id,
                        )
                    {
                        candidate.point_id = point_id;
                        candidate.dz = dz;
                        candidate.center_distance_squared = center_distance_squared;
                    }
                }
                point_id = point_id.saturating_add(1);
            }
            visited = visited.saturating_add(node.point_count);
            progress(SamplingProgress {
                phase: SamplingPhase::Select,
                completed: visited.min(total),
                total,
            });
        }
    } else {
        progress(SamplingProgress {
            phase: SamplingPhase::Select,
            completed: total,
            total,
        });
    }

    let output = request.output_root.join("sampled");
    fs::create_dir_all(&output)?;
    let mut input = BufReader::with_capacity(IO_CHUNK_BYTES, File::open(&request.octree_path)?);
    let mut writer =
        BufWriter::with_capacity(IO_CHUNK_BYTES, File::create(output.join("octree.bin"))?);
    let mut node_counts = BTreeMap::<String, u64>::new();
    let mut class_histogram = [0_u64; 256];
    let mut membership = Sha256::new();
    let mut sampled_points = 0_u64;
    visited = 0;
    point_id = 0;
    for node in &source.nodes {
        check_sampling_cancelled(cancellation)?;
        let bytes = read_node(&mut input, node)?;
        let mut node_count = 0_u64;
        for record in bytes.chunks_exact(source.stride) {
            let point = decode_point(record, source.position_offset, &source.metadata)?;
            let class = source
                .classification_offset
                .map_or(0, |offset| record[offset]);
            let in_scope = request.scope.visible_classes.contains(&class)
                && scope_contains(&request.scope, point);
            let selected = in_scope
                && match request.parameters.method {
                    SamplingMethod::Distance => selected_ids.contains(&point_id),
                    SamplingMethod::Grid => {
                        let world = transform_point(&request.scope.placement, point);
                        grid_candidates
                            .get(&cell2(world, origin, spacing)?)
                            .is_some_and(|candidate| candidate.point_id == point_id)
                    }
                    SamplingMethod::Random => {
                        random_selected(point_id, request.parameters.percentage, RANDOM_SEED)
                    }
                };
            membership.update([u8::from(selected)]);
            if selected {
                writer.write_all(record)?;
                node_count = node_count.saturating_add(1);
                sampled_points = sampled_points.saturating_add(1);
                class_histogram[usize::from(class)] =
                    class_histogram[usize::from(class)].saturating_add(1);
            }
            point_id = point_id.saturating_add(1);
        }
        node_counts.insert(node.id.clone(), node_count);
        visited = visited.saturating_add(node.point_count);
        progress(SamplingProgress {
            phase: SamplingPhase::Bake,
            completed: visited.min(total),
            total,
        });
    }
    writer.flush()?;
    check_sampling_cancelled(cancellation)?;
    if sampled_points == 0 {
        return Err(PointcloudSamplingError::Invalid(
            "sampling parameters selected no points",
        ));
    }

    let mut output_metadata = source.metadata.clone();
    output_metadata.name = Some(request.output_name.clone());
    output_metadata.points = sampled_points;
    output_metadata.hierarchy.first_chunk_size = u64::try_from(source.nodes.len())
        .unwrap_or(u64::MAX)
        .saturating_mul(HIERARCHY_RECORD_BYTES as u64);
    output_metadata.hierarchy.step_size = output_metadata
        .hierarchy
        .depth
        .saturating_add(1)
        .max(output_metadata.hierarchy.step_size);
    if source.classification_offset.is_some() {
        set_classification_histogram(&mut output_metadata, &class_histogram)?;
    }
    write_json(&output.join("metadata.json"), &output_metadata)?;
    fs::write(
        output.join("hierarchy.bin"),
        encode_flat_hierarchy(&source.nodes, &node_counts, source.stride)?,
    )?;
    let sampled = describe_point_dataset(output, sampled_points)?;
    let selection_sha256 = ObjectHash(hex::encode(membership.finalize()));
    Ok(PreparedSampleResult {
        sampled,
        summary: SampleSummary {
            source_points: source.metadata.points,
            scoped_points,
            sampled_points,
            method: request.parameters.method,
            spacing_m: (request.parameters.method != SamplingMethod::Random)
                .then_some(request.parameters.spacing_m),
            percentage: (request.parameters.method == SamplingMethod::Random)
                .then_some(request.parameters.percentage),
            stable_tie_rule: tie_rule(request.parameters.method).to_owned(),
            selection_sha256,
        },
    })
}

/// Bakes one dense, content-addressed grid whose memory is bounded by the output cell ceiling.
pub fn prepare_height_grid(
    request: &RasterizePrepareRequest,
    cancellation: &CancellationToken,
    mut progress: impl FnMut(RasterizeProgress),
) -> Result<PreparedHeightGrid, PointcloudSamplingError> {
    validate_scope(&request.scope)?;
    validate_rasterize_parameters(request.parameters)?;
    check_sampling_cancelled(cancellation)?;
    let source = OpenPotree::open(&request.metadata_path, &request.hierarchy_path)?;
    let total = source.metadata.points.max(1);
    let mut reader = BufReader::with_capacity(IO_CHUNK_BYTES, File::open(&request.octree_path)?);
    let mut bounds = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    let mut scoped_points = 0_u64;
    let mut visited = 0_u64;
    for node in &source.nodes {
        check_sampling_cancelled(cancellation)?;
        ensure_bounded_node(node)?;
        let bytes = read_node(&mut reader, node)?;
        for record in bytes.chunks_exact(source.stride) {
            let point = decode_point(record, source.position_offset, &source.metadata)?;
            let class = source
                .classification_offset
                .map_or(0, |offset| record[offset]);
            if request.scope.visible_classes.contains(&class)
                && scope_contains(&request.scope, point)
            {
                let world = transform_point(&request.scope.placement, point);
                bounds[0] = bounds[0].min(world[0]);
                bounds[1] = bounds[1].min(world[1]);
                bounds[2] = bounds[2].max(world[0]);
                bounds[3] = bounds[3].max(world[1]);
                scoped_points = scoped_points.saturating_add(1);
            }
        }
        visited = visited.saturating_add(node.point_count);
        progress(RasterizeProgress {
            phase: RasterizePhase::Scan,
            completed: visited.min(total),
            total,
        });
    }
    if scoped_points == 0 {
        return Err(PointcloudSamplingError::Invalid(
            "the captured P4 visible set is empty",
        ));
    }
    let size = request.parameters.cell_size_m;
    let reference_origin = [
        request
            .parameters
            .origin_x
            .unwrap_or((bounds[0] / size).floor() * size),
        request
            .parameters
            .origin_y
            .unwrap_or((bounds[1] / size).floor() * size),
    ];
    let min_cell = cell2([bounds[0], bounds[1], 0.0], reference_origin, size)?;
    let max_cell = cell2([bounds[2], bounds[3], 0.0], reference_origin, size)?;
    let width = dimension(min_cell.0, max_cell.0)?;
    let height = dimension(min_cell.1, max_cell.1)?;
    let cell_count = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or(PointcloudSamplingError::Invalid("grid cell count overflow"))?;
    if cell_count > MAX_RASTER_CELLS {
        return Err(PointcloudSamplingError::Invalid(
            "grid exceeds the 50 million-cell output budget; increase cell size",
        ));
    }
    let cell_count_usize = usize::try_from(cell_count)
        .map_err(|_| PointcloudSamplingError::Invalid("grid does not fit memory"))?;
    let mut cells = vec![None::<GridAccumulator>; cell_count_usize];
    reader = BufReader::with_capacity(IO_CHUNK_BYTES, File::open(&request.octree_path)?);
    visited = 0;
    for node in &source.nodes {
        check_sampling_cancelled(cancellation)?;
        let bytes = read_node(&mut reader, node)?;
        for record in bytes.chunks_exact(source.stride) {
            let point = decode_point(record, source.position_offset, &source.metadata)?;
            let class = source
                .classification_offset
                .map_or(0, |offset| record[offset]);
            if request.scope.visible_classes.contains(&class)
                && scope_contains(&request.scope, point)
            {
                let world = transform_point(&request.scope.placement, point);
                let cell = cell2(world, reference_origin, size)?;
                let index = grid_offset(cell, min_cell, width, height)?;
                if let Some(value) = &mut cells[index] {
                    value.add(world[2]);
                } else {
                    cells[index] = Some(GridAccumulator::new(world[2]));
                }
            }
        }
        visited = visited.saturating_add(node.point_count);
        progress(RasterizeProgress {
            phase: RasterizePhase::Aggregate,
            completed: visited.min(total),
            total,
        });
    }

    let output_root = request.output_root.join("grid");
    fs::create_dir_all(&output_root)?;
    let path = output_root.join("height-grid.hgrid");
    let mut output = BufWriter::with_capacity(IO_CHUNK_BYTES, File::create(&path)?);
    let color_path = output_root.join("height-grid.rgba");
    let elevation_path = output_root.join("height-grid.f64");
    let mut color_output = BufWriter::with_capacity(IO_CHUNK_BYTES, File::create(&color_path)?);
    let mut elevation_output =
        BufWriter::with_capacity(IO_CHUNK_BYTES, File::create(&elevation_path)?);
    output.write_all(HEIGHT_GRID_MAGIC)?;
    output.write_all(&width.to_le_bytes())?;
    output.write_all(&height.to_le_bytes())?;
    let grid_origin = [
        reference_origin[0] + (min_cell.0 as f64 + 0.5) * size,
        reference_origin[1] + (min_cell.1 as f64 + 0.5) * size,
    ];
    output.write_all(&grid_origin[0].to_le_bytes())?;
    output.write_all(&grid_origin[1].to_le_bytes())?;
    output.write_all(&size.to_le_bytes())?;
    output.write_all(&[aggregation_code(request.parameters.aggregation)])?;
    output.write_all(&[empty_policy_code(request.parameters.empty_cell_policy)])?;
    let mut empty_cells = 0_u64;
    let mut minimum_value = f64::INFINITY;
    let mut maximum_value = f64::NEG_INFINITY;
    for (index, cell) in cells.into_iter().enumerate() {
        if index % 65_536 == 0 {
            check_sampling_cancelled(cancellation)?;
            progress(RasterizeProgress {
                phase: RasterizePhase::Bake,
                completed: u64::try_from(index).unwrap_or(u64::MAX),
                total: cell_count.max(1),
            });
        }
        let (valid, value, count, variance) = match cell {
            Some(accumulator) => (
                true,
                aggregation_value(accumulator, request.parameters.aggregation),
                accumulator.count,
                accumulator.variance(),
            ),
            None => {
                empty_cells = empty_cells.saturating_add(1);
                match request.parameters.empty_cell_policy {
                    EmptyCellPolicy::NoData => (false, f64::NAN, 0, f64::NAN),
                    EmptyCellPolicy::Fill { value } => (true, value, 0, f64::NAN),
                }
            }
        };
        output.write_all(&[u8::from(valid)])?;
        output.write_all(&value.to_le_bytes())?;
        output.write_all(&count.to_le_bytes())?;
        output.write_all(&variance.to_le_bytes())?;
        elevation_output.write_all(&value.to_le_bytes())?;
        if valid {
            minimum_value = minimum_value.min(value);
            maximum_value = maximum_value.max(value);
            color_output.write_all(&[105, 154, 96, 255])?;
        } else {
            color_output.write_all(&[0, 0, 0, 0])?;
        }
    }
    output.flush()?;
    elevation_output.flush()?;
    color_output.flush()?;
    check_sampling_cancelled(cancellation)?;
    progress(RasterizeProgress {
        phase: RasterizePhase::Bake,
        completed: cell_count,
        total: cell_count.max(1),
    });
    let (cell_sha256, byte_length) = hash_file(&path)?;
    let artifact = PreparedGroundArtifact {
        relative_path: "height-grid.hgrid".to_owned(),
        object_hash: cell_sha256.clone(),
        byte_length,
        media_type: HEIGHT_GRID_MEDIA_TYPE.to_owned(),
    };
    let (color_hash, color_byte_length) = hash_file(&color_path)?;
    let (elevation_hash, elevation_byte_length) = hash_file(&elevation_path)?;
    let color_artifact = PreparedGroundArtifact {
        relative_path: "height-grid.rgba".to_owned(),
        object_hash: color_hash.clone(),
        byte_length: color_byte_length,
        media_type: "application/octet-stream".to_owned(),
    };
    let elevation_artifact = PreparedGroundArtifact {
        relative_path: "height-grid.f64".to_owned(),
        object_hash: elevation_hash.clone(),
        byte_length: elevation_byte_length,
        media_type: "application/vnd.himmelcad.depth-f64le".to_owned(),
    };
    let root_id = TileId("height-grid-root".to_owned());
    let half_cell = size * 0.5;
    let manifest_bytes = PreparedHierarchyManifest {
        schema_version: 1,
        roots: vec![root_id.clone()],
        tiles: vec![TileDescriptor {
            id: root_id,
            parent: None,
            children: Vec::new(),
            bounds: BoundingVolume::AxisAlignedBox {
                bounds: WorldAabb {
                    min: WorldVec3 {
                        x: grid_origin[0] - half_cell,
                        y: grid_origin[1] - half_cell,
                        z: minimum_value,
                    },
                    max: WorldVec3 {
                        x: grid_origin[0] + (f64::from(width) - 0.5) * size,
                        y: grid_origin[1] + (f64::from(height) - 0.5) * size,
                        z: maximum_value,
                    },
                },
            },
            content_transform: WorldTransform::IDENTITY,
            geometric_error: size,
            refinement: RefinementMode::Replace,
            contents: vec![ContentReference {
                kind: ContentKind::Raster,
                uri: "height-grid.rgba".to_owned(),
                byte_offset: None,
                // A standalone URI is an un-ranged resource. The prepared
                // hierarchy contract requires byte offset and length to be
                // either both present or both absent.
                byte_length: None,
                primitive_count: Some(cell_count),
                content_hash: Some(color_hash.as_str().to_owned()),
                decoder_parameters: Some(serde_json::json!({
                    "schemaVersion": 1,
                    "width": width,
                    "height": height,
                    "mapping": {
                        "origin": grid_origin,
                        "columnStep": [size, 0.0],
                        "rowStep": [0.0, size],
                    },
                    "topology": { "kind": "pixelSteps" },
                    "interpolation": "nearest",
                    "colorEncoding": "rgba8",
                    "elevationEncoding": { "kind": "float64LittleEndian" },
                    "noData": { "kind": "nan" },
                    "elevationReference": {
                        "uri": "height-grid.f64",
                        "byteOffset": null,
                        "byteLength": elevation_byte_length,
                        "contentHash": elevation_hash.as_str(),
                    },
                    "validityReference": null,
                    "confidenceReference": null,
                    "triangleMaskReference": null,
                })),
            }],
            child_page: None,
            prepared_point_metadata: None,
            provider_metadata: Some(serde_json::json!({
                "schemaId": "hcad.provider.height-grid@1",
                "aggregation": request.parameters.aggregation,
            })),
        }],
    }
    .to_validated_json()
    .map_err(|error| PointcloudSamplingError::ViewerManifest(error.to_string()))?;
    let manifest_path = output_root.join("manifest.json");
    fs::write(&manifest_path, manifest_bytes)?;
    let (manifest_hash, manifest_byte_length) = hash_file(&manifest_path)?;
    let viewer_manifest = PreparedGroundArtifact {
        relative_path: "manifest.json".to_owned(),
        object_hash: manifest_hash,
        byte_length: manifest_byte_length,
        // The canonical provider contract binds dataset format, geometry
        // resource media type, and root-metadata resource exactly. The bytes
        // are a validated prepared hierarchy, while this names the concrete
        // height-grid dataset contract selected by the viewer bootstrap.
        media_type: HEIGHT_GRID_FORMAT_ID.to_owned(),
    };
    Ok(PreparedHeightGrid {
        root: output_root,
        artifact,
        viewer_manifest,
        viewer_artifacts: vec![color_artifact, elevation_artifact],
        summary: RasterSummary {
            source_points: source.metadata.points,
            scoped_points,
            width,
            height,
            cell_size_m: size,
            origin: grid_origin,
            aggregation: request.parameters.aggregation,
            empty_cell_policy: request.parameters.empty_cell_policy,
            empty_cells,
            empty_ratio: empty_cells as f64 / cell_count as f64,
            cell_sha256,
            mesh_eligible: request.parameters.aggregation != RasterAggregation::Count,
        },
    })
}

fn validate_sampling_parameters(value: SamplingParameters) -> Result<(), PointcloudSamplingError> {
    if !value.spacing_m.is_finite()
        || value.spacing_m <= 0.0
        || value.spacing_m > 10_000.0
        || !value.percentage.is_finite()
        || !(0.0 < value.percentage && value.percentage <= 100.0)
        || value.origin_x.is_some_and(|origin| !origin.is_finite())
        || value.origin_y.is_some_and(|origin| !origin.is_finite())
    {
        return Err(PointcloudSamplingError::Invalid(
            "invalid sampling parameters",
        ));
    }
    Ok(())
}

fn validate_rasterize_parameters(
    value: RasterizeParameters,
) -> Result<(), PointcloudSamplingError> {
    if !value.cell_size_m.is_finite()
        || value.cell_size_m <= 0.0
        || value.cell_size_m > 100_000.0
        || value.origin_x.is_some_and(|origin| !origin.is_finite())
        || value.origin_y.is_some_and(|origin| !origin.is_finite())
        || matches!(value.empty_cell_policy, EmptyCellPolicy::Fill { value } if !value.is_finite())
    {
        return Err(PointcloudSamplingError::Invalid(
            "invalid height-grid parameters",
        ));
    }
    Ok(())
}

fn sampling_origin(value: SamplingParameters) -> [f64; 2] {
    [value.origin_x.unwrap_or(0.0), value.origin_y.unwrap_or(0.0)]
}

fn tie_rule(method: SamplingMethod) -> &'static str {
    match method {
        SamplingMethod::Distance => {
            "stable source point id ascending; first point satisfying the project-space distance wins"
        }
        SamplingMethod::Grid => {
            "minimum abs(z-mean_z), then XY distance to cell center, then stable source point id"
        }
        SamplingMethod::Random => {
            "SHA-256 of the fixed recipe seed and stable source point id; threshold comparison"
        }
    }
}

fn ensure_bounded_node(node: &SourceNode) -> Result<(), PointcloudSamplingError> {
    if node.byte_length > MAX_NODE_BYTES {
        Err(PointcloudSamplingError::Invalid(
            "one source node exceeds the bounded read limit",
        ))
    } else {
        Ok(())
    }
}

fn validate_visited(
    source: &OpenPotree,
    visited: u64,
    point_id: u64,
) -> Result<(), PointcloudSamplingError> {
    if visited != source.metadata.points || point_id != source.metadata.points {
        Err(PointcloudSamplingError::Invalid(
            "hierarchy point count differs from metadata",
        ))
    } else {
        Ok(())
    }
}

fn cell_index(value: f64) -> Result<i64, PointcloudSamplingError> {
    if !value.is_finite() || value < i64::MIN as f64 || value > i64::MAX as f64 {
        Err(PointcloudSamplingError::Invalid("grid index overflows i64"))
    } else {
        Ok(value.floor() as i64)
    }
}

fn cell2(
    world: [f64; 3],
    origin: [f64; 2],
    spacing: f64,
) -> Result<(i64, i64), PointcloudSamplingError> {
    Ok((
        cell_index((world[0] - origin[0]) / spacing)?,
        cell_index((world[1] - origin[1]) / spacing)?,
    ))
}

fn cell3(world: [f64; 3], spacing: f64) -> Result<(i64, i64, i64), PointcloudSamplingError> {
    Ok((
        cell_index(world[0] / spacing)?,
        cell_index(world[1] / spacing)?,
        cell_index(world[2] / spacing)?,
    ))
}

fn neighbor_cells(cell: (i64, i64, i64)) -> impl Iterator<Item = (i64, i64, i64)> {
    (-1_i64..=1).flat_map(move |x| {
        (-1_i64..=1).flat_map(move |y| {
            (-1_i64..=1).map(move |z| {
                (
                    cell.0.saturating_add(x),
                    cell.1.saturating_add(y),
                    cell.2.saturating_add(z),
                )
            })
        })
    })
}

fn squared_distance(left: [f64; 3], right: [f64; 3]) -> f64 {
    (left[0] - right[0]).powi(2) + (left[1] - right[1]).powi(2) + (left[2] - right[2]).powi(2)
}

fn cell_center(cell: (i64, i64), origin: [f64; 2], spacing: f64) -> [f64; 2] {
    [
        origin[0] + (cell.0 as f64 + 0.5) * spacing,
        origin[1] + (cell.1 as f64 + 0.5) * spacing,
    ]
}

fn random_selected(point_id: u64, percentage: f64, seed: u64) -> bool {
    if percentage >= 100.0 {
        return true;
    }
    let mut digest = Sha256::new();
    digest.update(seed.to_le_bytes());
    digest.update(point_id.to_le_bytes());
    let bytes = digest.finalize();
    let draw = u64::from_le_bytes(bytes[..8].try_into().expect("SHA-256 prefix"));
    (draw as u128) * 10_000_u128 < (percentage * 100.0).round() as u128 * u64::MAX as u128
}

fn dimension(minimum: i64, maximum: i64) -> Result<u32, PointcloudSamplingError> {
    let value = maximum
        .checked_sub(minimum)
        .and_then(|span| span.checked_add(1))
        .ok_or(PointcloudSamplingError::Invalid("grid dimension overflow"))?;
    u32::try_from(value).map_err(|_| PointcloudSamplingError::Invalid("grid dimension exceeds u32"))
}

fn grid_offset(
    cell: (i64, i64),
    minimum: (i64, i64),
    width: u32,
    height: u32,
) -> Result<usize, PointcloudSamplingError> {
    let x = cell
        .0
        .checked_sub(minimum.0)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value < width)
        .ok_or(PointcloudSamplingError::Invalid(
            "point escaped raster X bounds",
        ))?;
    let y = cell
        .1
        .checked_sub(minimum.1)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value < height)
        .ok_or(PointcloudSamplingError::Invalid(
            "point escaped raster Y bounds",
        ))?;
    usize::try_from(u64::from(y) * u64::from(width) + u64::from(x))
        .map_err(|_| PointcloudSamplingError::Invalid("grid offset overflows usize"))
}

fn aggregation_value(cell: GridAccumulator, aggregation: RasterAggregation) -> f64 {
    match aggregation {
        RasterAggregation::Mean => cell.mean(),
        RasterAggregation::Min => cell.minimum,
        RasterAggregation::Max => cell.maximum,
        RasterAggregation::Count => cell.count as f64,
    }
}

const fn aggregation_code(value: RasterAggregation) -> u8 {
    match value {
        RasterAggregation::Mean => 0,
        RasterAggregation::Min => 1,
        RasterAggregation::Max => 2,
        RasterAggregation::Count => 3,
    }
}

const fn empty_policy_code(value: EmptyCellPolicy) -> u8 {
    match value {
        EmptyCellPolicy::NoData => 0,
        EmptyCellPolicy::Fill { .. } => 1,
    }
}

fn describe_point_dataset(
    root: PathBuf,
    point_count: u64,
) -> Result<PreparedGroundDataset, PointcloudSamplingError> {
    let mut artifacts = Vec::with_capacity(3);
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

fn check_sampling_cancelled(
    cancellation: &CancellationToken,
) -> Result<(), PointcloudSamplingError> {
    check_cancelled(cancellation).map_err(|error| match error {
        PointcloudGroundError::Cancelled => PointcloudSamplingError::Cancelled,
        other => PointcloudSamplingError::Prepared(other),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampling_is_deterministic_and_grid_uses_pc_d17_tie_rule() {
        let root = fixture_root("determinism");
        write_fixture(&root);
        let run = |name: &str, method| {
            prepare_sampled_cloud(
                &SamplePrepareRequest {
                    metadata_path: root.join("metadata.json"),
                    hierarchy_path: root.join("hierarchy.bin"),
                    octree_path: root.join("octree.bin"),
                    output_root: root.join(name),
                    output_name: "Sampled".to_owned(),
                    parameters: SamplingParameters {
                        method,
                        spacing_m: 2.0,
                        percentage: 50.0,
                        origin_x: Some(0.0),
                        origin_y: Some(0.0),
                    },
                    scope: GroundScope::default(),
                },
                &CancellationToken::new(),
                |_| {},
            )
            .expect("sample")
        };
        for method in [
            SamplingMethod::Distance,
            SamplingMethod::Grid,
            SamplingMethod::Random,
        ] {
            let first = run(&format!("{method:?}-a"), method);
            let second = run(&format!("{method:?}-b"), method);
            assert_eq!(
                first.summary.selection_sha256,
                second.summary.selection_sha256
            );
            assert_eq!(
                fs::read(first.sampled.root.join("octree.bin")).unwrap(),
                fs::read(second.sampled.root.join("octree.bin")).unwrap()
            );
            eprintln!(
                "sampling method={method:?} sha256={}",
                first.summary.selection_sha256.as_str()
            );
        }
        let grid = run("grid-oracle", SamplingMethod::Grid);
        let bytes = fs::read(grid.sampled.root.join("octree.bin")).unwrap();
        let ids = bytes
            .chunks_exact(13)
            .map(|record| i32::from_le_bytes(record[..4].try_into().unwrap()))
            .collect::<Vec<_>>();
        // In the first cell z values are 0 and 2, equally distant from mean 1 and
        // equally distant from the center. Stable source id chooses x=0.2 m.
        assert!(ids.contains(&20));
        assert!(!ids.contains(&180));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mean_grid_matches_independent_oracle_and_preserves_empty_cells() {
        let root = fixture_root("mean-grid");
        write_fixture(&root);
        let result = prepare_height_grid(
            &RasterizePrepareRequest {
                metadata_path: root.join("metadata.json"),
                hierarchy_path: root.join("hierarchy.bin"),
                octree_path: root.join("octree.bin"),
                output_root: root.join("out"),
                parameters: RasterizeParameters {
                    cell_size_m: 2.0,
                    origin_x: Some(0.0),
                    origin_y: Some(0.0),
                    aggregation: RasterAggregation::Mean,
                    empty_cell_policy: EmptyCellPolicy::NoData,
                },
                scope: GroundScope::default(),
            },
            &CancellationToken::new(),
            |_| {},
        )
        .expect("mean grid");
        let bytes = fs::read(result.root.join("height-grid.hgrid")).unwrap();
        assert_eq!(&bytes[..8], HEIGHT_GRID_MAGIC);
        let width = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        let height = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
        assert_eq!((width, height), (4, 2));
        let record = HEIGHT_GRID_HEADER_BYTES;
        assert_eq!(bytes[record], 1);
        let mean = f64::from_le_bytes(bytes[record + 1..record + 9].try_into().unwrap());
        assert_eq!(mean, 1.0);
        let extreme_singleton = record + 7 * HEIGHT_GRID_RECORD_BYTES;
        assert_eq!(bytes[extreme_singleton], 1);
        assert_eq!(
            f64::from_le_bytes(
                bytes[extreme_singleton + 1..extreme_singleton + 9]
                    .try_into()
                    .unwrap()
            ),
            20_000_000.0
        );
        assert_eq!(
            u64::from_le_bytes(
                bytes[extreme_singleton + 9..extreme_singleton + 17]
                    .try_into()
                    .unwrap()
            ),
            1
        );
        assert_eq!(result.summary.empty_cells, 4);
        assert!(result.summary.mesh_eligible);
        eprintln!("raster mean sha256={}", result.summary.cell_sha256.as_str());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sampling_raster_aggregations_and_fill_policy_are_exact() {
        let root = fixture_root("aggregations");
        write_fixture(&root);
        for (aggregation, expected) in [
            (RasterAggregation::Mean, 1.0),
            (RasterAggregation::Min, 0.0),
            (RasterAggregation::Max, 2.0),
            (RasterAggregation::Count, 2.0),
        ] {
            let result = prepare_height_grid(
                &RasterizePrepareRequest {
                    metadata_path: root.join("metadata.json"),
                    hierarchy_path: root.join("hierarchy.bin"),
                    octree_path: root.join("octree.bin"),
                    output_root: root.join(format!("out-{aggregation:?}")),
                    parameters: RasterizeParameters {
                        cell_size_m: 2.0,
                        origin_x: Some(0.0),
                        origin_y: Some(0.0),
                        aggregation,
                        empty_cell_policy: EmptyCellPolicy::Fill { value: -9999.0 },
                    },
                    scope: GroundScope::default(),
                },
                &CancellationToken::new(),
                |_| {},
            )
            .expect("aggregate grid");
            let bytes = fs::read(result.root.join("height-grid.hgrid")).unwrap();
            assert_eq!(
                f64::from_le_bytes(
                    bytes[HEIGHT_GRID_HEADER_BYTES + 1..HEIGHT_GRID_HEADER_BYTES + 9]
                        .try_into()
                        .unwrap()
                ),
                expected
            );
            // Cell x=3,y=0 is empty and receives the explicit, finite fill value.
            let empty = HEIGHT_GRID_HEADER_BYTES + 3 * HEIGHT_GRID_RECORD_BYTES;
            assert_eq!(bytes[empty], 1);
            assert_eq!(
                f64::from_le_bytes(bytes[empty + 1..empty + 9].try_into().unwrap()),
                -9999.0
            );
            assert_eq!(
                result.summary.mesh_eligible,
                aggregation != RasterAggregation::Count
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn every_sampling_and_raster_phase_observes_cancellation() {
        let root = fixture_root("cancel");
        write_fixture(&root);
        for phase in [
            SamplingPhase::Scan,
            SamplingPhase::Select,
            SamplingPhase::Bake,
        ] {
            let cancellation = CancellationToken::new();
            let result = prepare_sampled_cloud(
                &SamplePrepareRequest {
                    metadata_path: root.join("metadata.json"),
                    hierarchy_path: root.join("hierarchy.bin"),
                    octree_path: root.join("octree.bin"),
                    output_root: root.join(format!("sample-{phase:?}")),
                    output_name: "Sampled".to_owned(),
                    parameters: SamplingParameters {
                        method: SamplingMethod::Grid,
                        spacing_m: 2.0,
                        percentage: 50.0,
                        origin_x: Some(0.0),
                        origin_y: Some(0.0),
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
            assert!(matches!(result, Err(PointcloudSamplingError::Cancelled)));
        }
        for phase in [
            RasterizePhase::Scan,
            RasterizePhase::Aggregate,
            RasterizePhase::Bake,
        ] {
            let cancellation = CancellationToken::new();
            let result = prepare_height_grid(
                &RasterizePrepareRequest {
                    metadata_path: root.join("metadata.json"),
                    hierarchy_path: root.join("hierarchy.bin"),
                    octree_path: root.join("octree.bin"),
                    output_root: root.join(format!("raster-{phase:?}")),
                    parameters: RasterizeParameters {
                        cell_size_m: 2.0,
                        origin_x: None,
                        origin_y: None,
                        aggregation: RasterAggregation::Mean,
                        empty_cell_policy: EmptyCellPolicy::NoData,
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
            assert!(matches!(result, Err(PointcloudSamplingError::Cancelled)));
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "104 M-point operational gate; set HCAD_SAMPLING_REAL_DATASET"]
    fn real_104m_sample_and_rasterize() {
        use std::time::Instant;

        let dataset = PathBuf::from(
            std::env::var_os("HCAD_SAMPLING_REAL_DATASET").expect("HCAD_SAMPLING_REAL_DATASET"),
        );
        let root = std::env::var_os("HCAD_SAMPLING_OUTPUT_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| fixture_root("real"));
        let sample_started = Instant::now();
        let mut sample_phase = None;
        let mut sample_phase_started = sample_started;
        let mut sample_timings = Vec::new();
        let sample = prepare_sampled_cloud(
            &SamplePrepareRequest {
                metadata_path: dataset.join("metadata.json"),
                hierarchy_path: dataset.join("hierarchy.bin"),
                octree_path: dataset.join("octree.bin"),
                output_root: root.join("sample"),
                output_name: "Real sample".to_owned(),
                parameters: SamplingParameters {
                    method: SamplingMethod::Grid,
                    spacing_m: 0.25,
                    percentage: 10.0,
                    origin_x: None,
                    origin_y: None,
                },
                scope: GroundScope::default(),
            },
            &CancellationToken::new(),
            |progress| {
                if sample_phase != Some(progress.phase) {
                    if let Some(previous) = sample_phase {
                        sample_timings.push((previous, sample_phase_started.elapsed()));
                    }
                    sample_phase = Some(progress.phase);
                    sample_phase_started = Instant::now();
                }
            },
        )
        .expect("real sample");
        if let Some(previous) = sample_phase {
            sample_timings.push((previous, sample_phase_started.elapsed()));
        }
        let raster_started = Instant::now();
        let mut raster_phase = None;
        let mut raster_phase_started = raster_started;
        let mut raster_timings = Vec::new();
        let grid = prepare_height_grid(
            &RasterizePrepareRequest {
                metadata_path: dataset.join("metadata.json"),
                hierarchy_path: dataset.join("hierarchy.bin"),
                octree_path: dataset.join("octree.bin"),
                output_root: root.join("raster"),
                parameters: RasterizeParameters {
                    cell_size_m: 1.0,
                    origin_x: None,
                    origin_y: None,
                    aggregation: RasterAggregation::Mean,
                    empty_cell_policy: EmptyCellPolicy::NoData,
                },
                scope: GroundScope::default(),
            },
            &CancellationToken::new(),
            |progress| {
                if raster_phase != Some(progress.phase) {
                    if let Some(previous) = raster_phase {
                        raster_timings.push((previous, raster_phase_started.elapsed()));
                    }
                    raster_phase = Some(progress.phase);
                    raster_phase_started = Instant::now();
                }
            },
        )
        .expect("real raster");
        if let Some(previous) = raster_phase {
            raster_timings.push((previous, raster_phase_started.elapsed()));
        }
        assert!(sample.summary.source_points >= 100_000_000);
        assert!(sample.summary.sampled_points > 0);
        assert_eq!(grid.summary.source_points, sample.summary.source_points);
        let oracle_max_delta = assert_real_mean_grid_oracle(&dataset, &grid);
        eprintln!("real sample summary={:?}", sample.summary);
        eprintln!(
            "real sample phase_timings={sample_timings:?} total={:?}",
            sample_started.elapsed()
        );
        eprintln!("real grid summary={:?}", grid.summary);
        eprintln!("real grid independent_oracle_max_delta={oracle_max_delta:.12}");
        eprintln!(
            "real raster phase_timings={raster_timings:?} total={:?}",
            raster_started.elapsed()
        );
        if std::env::var_os("HCAD_SAMPLING_KEEP_TEST_OUTPUT").is_none() {
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    #[ignore = "104 M-point cancellation gate; set HCAD_SAMPLING_REAL_DATASET"]
    fn real_104m_sampling_and_rasterize_cancel_every_phase() {
        let dataset = PathBuf::from(
            std::env::var_os("HCAD_SAMPLING_REAL_DATASET").expect("HCAD_SAMPLING_REAL_DATASET"),
        );
        let root = fixture_root("real-cancel");
        for phase in [
            SamplingPhase::Scan,
            SamplingPhase::Select,
            SamplingPhase::Bake,
        ] {
            let cancellation = CancellationToken::new();
            let result = prepare_sampled_cloud(
                &SamplePrepareRequest {
                    metadata_path: dataset.join("metadata.json"),
                    hierarchy_path: dataset.join("hierarchy.bin"),
                    octree_path: dataset.join("octree.bin"),
                    output_root: root.join(format!("sample-{phase:?}")),
                    output_name: "Cancelled sample".to_owned(),
                    parameters: SamplingParameters {
                        method: SamplingMethod::Random,
                        spacing_m: 0.25,
                        percentage: 3.0,
                        origin_x: None,
                        origin_y: None,
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
            assert!(matches!(result, Err(PointcloudSamplingError::Cancelled)));
            eprintln!("real sample cancellation observed in {phase:?}");
        }
        for phase in [
            RasterizePhase::Scan,
            RasterizePhase::Aggregate,
            RasterizePhase::Bake,
        ] {
            let cancellation = CancellationToken::new();
            let result = prepare_height_grid(
                &RasterizePrepareRequest {
                    metadata_path: dataset.join("metadata.json"),
                    hierarchy_path: dataset.join("hierarchy.bin"),
                    octree_path: dataset.join("octree.bin"),
                    output_root: root.join(format!("raster-{phase:?}")),
                    parameters: RasterizeParameters {
                        cell_size_m: 1.0,
                        origin_x: None,
                        origin_y: None,
                        aggregation: RasterAggregation::Mean,
                        empty_cell_policy: EmptyCellPolicy::NoData,
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
            assert!(matches!(result, Err(PointcloudSamplingError::Cancelled)));
            eprintln!("real raster cancellation observed in {phase:?}");
        }
        let _ = fs::remove_dir_all(root);
    }

    fn assert_real_mean_grid_oracle(dataset: &Path, grid: &PreparedHeightGrid) -> f64 {
        let source = OpenPotree::open(
            &dataset.join("metadata.json"),
            &dataset.join("hierarchy.bin"),
        )
        .expect("open oracle source");
        let width = usize::try_from(grid.summary.width).unwrap();
        let height = usize::try_from(grid.summary.height).unwrap();
        let mut oracle = vec![(0_u64, 0_f64); width * height];
        let size = grid.summary.cell_size_m;
        let lower_left = [
            grid.summary.origin[0] - size * 0.5,
            grid.summary.origin[1] - size * 0.5,
        ];
        let mut reader = BufReader::with_capacity(
            IO_CHUNK_BYTES,
            File::open(dataset.join("octree.bin")).unwrap(),
        );
        for node in &source.nodes {
            let bytes = read_node(&mut reader, node).expect("read oracle node");
            for record in bytes.chunks_exact(source.stride) {
                let point = decode_point(record, source.position_offset, &source.metadata)
                    .expect("decode oracle point");
                let column = ((point.x - lower_left[0]) / size).floor() as isize;
                let row = ((point.y - lower_left[1]) / size).floor() as isize;
                if column >= 0 && row >= 0 && column < width as isize && row < height as isize {
                    let accumulator = &mut oracle[row as usize * width + column as usize];
                    accumulator.0 = accumulator.0.saturating_add(1);
                    accumulator.1 += point.z;
                }
            }
        }
        let bytes = fs::read(grid.root.join("height-grid.hgrid")).expect("read oracle grid");
        let mut maximum_delta = 0_f64;
        for (index, (count, sum)) in oracle.into_iter().enumerate() {
            let offset = HEIGHT_GRID_HEADER_BYTES + index * HEIGHT_GRID_RECORD_BYTES;
            let valid = bytes[offset] != 0;
            let observed = f64::from_le_bytes(bytes[offset + 1..offset + 9].try_into().unwrap());
            let observed_count =
                u64::from_le_bytes(bytes[offset + 9..offset + 17].try_into().unwrap());
            assert_eq!(
                observed_count, count,
                "oracle count differs at cell {index}"
            );
            if count == 0 {
                assert!(!valid, "empty oracle cell {index} is marked valid");
            } else {
                assert!(valid, "occupied oracle cell {index} is marked NoData");
                let expected = sum / count as f64;
                let delta = (observed - expected).abs();
                maximum_delta = maximum_delta.max(delta);
                let tolerance = 1e-9_f64.max(expected.abs() * 1e-12);
                assert!(
                    delta <= tolerance,
                    "oracle mean differs at cell {index}: expected {expected}, observed {observed}"
                );
            }
        }
        maximum_delta
    }

    fn fixture_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "hcad-sampling-{name}-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_fixture(root: &Path) {
        let points = [
            (20_i32, 20_i32, 0_i32),
            (180, 180, 200),
            (220, 20, 1_000),
            (380, 180, 1_200),
            (420, 220, -500),
            (580, 380, 500),
            (780, 380, 2_000_000_000),
        ];
        let metadata = serde_json::json!({
            "version": "2.0",
            "name": "sampling-fixture",
            "points": points.len(),
            "hierarchy": { "firstChunkSize": 22, "stepSize": 4, "depth": 0 },
            "offset": [0.0, 0.0, 0.0],
            "scale": [0.01, 0.01, 0.01],
            "spacing": 1.0,
            "boundingBox": { "min": [0.0, 0.0, -5.0], "max": [8.0, 4.0, 20_000_000.0] },
            "encoding": "UNCOMPRESSED",
            "attributes": [
                { "name": "position", "size": 12, "numElements": 3, "elementSize": 4, "type": "int32" },
                { "name": "classification", "size": 1, "numElements": 1, "elementSize": 1, "type": "uint8", "histogram": [0, points.len()] }
            ]
        });
        fs::write(
            root.join("metadata.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        let mut octree = Vec::new();
        for (x, y, z) in points {
            octree.extend_from_slice(&x.to_le_bytes());
            octree.extend_from_slice(&y.to_le_bytes());
            octree.extend_from_slice(&z.to_le_bytes());
            octree.push(1);
        }
        fs::write(root.join("octree.bin"), &octree).unwrap();
        let mut hierarchy = vec![0, 0];
        hierarchy.extend_from_slice(&(points.len() as u32).to_le_bytes());
        hierarchy.extend_from_slice(&0_u64.to_le_bytes());
        hierarchy.extend_from_slice(&(octree.len() as u64).to_le_bytes());
        fs::write(root.join("hierarchy.bin"), hierarchy).unwrap();
    }
}
