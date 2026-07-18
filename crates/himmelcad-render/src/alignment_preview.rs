//! Immutable, partitioned civil-alignment preview evaluation.

use std::sync::Arc;

use himmelcad_core::entity::EntityId;
use himmelcad_core::entity_model::{
    AlignmentGeometry, StationFunction, TriangleMeshGeometry, TriangleMeshStorage, Vector3,
    VerticalAlignmentSegment,
};
use himmelcad_core::entity_validation::{
    geometry_object_content_hash, validate_geometry_object, EntityValidationError,
};
use himmelcad_core::hash::ObjectHash;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    alignment_slope_geometry_version, tessellate_curve, CadCurveError, CurveTessellationOptions,
    ResolvedAlignmentSlopeGeometry, UnresolvedHeightDisplay,
};

/// Inclusive station interval affected by an authored edit.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentStationRange {
    /// First affected station.
    pub start: f64,
    /// Last affected station.
    pub end: f64,
}

impl AlignmentStationRange {
    fn contains(self, other: Self) -> bool {
        self.start <= other.start && self.end >= other.end
    }
}

/// Hard limits and spatial resolution for deterministic preview evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentPreviewConfig {
    /// Chord tolerance used once when preparing the horizontal alignment path.
    pub chord_tolerance: f64,
    /// Hard tessellation ceiling for the prepared horizontal path.
    pub maximum_curve_segments: u32,
    /// Station length of one independently replaceable preview partition.
    pub partition_length: f64,
    /// Maximum distance between adjacent cross-section samples.
    pub sample_step: f64,
    /// Hard number of partitions one incremental commit may replace.
    pub maximum_partitions_per_update: u32,
    /// Hard number of cross-section samples evaluated in one partition.
    pub maximum_samples_per_partition: u32,
    /// Hard number of road bands evaluated in one partition.
    pub maximum_road_bands_per_partition: u32,
    /// Hard number of slope rules evaluated in one partition.
    pub maximum_slope_rules_per_partition: u32,
}

/// One authoritative daylight result at a station.
///
/// The civil provider, rather than the renderer, selects the source edge and
/// intersects the cut/fill rule with the target surface. This preserves the
/// existing rule semantics, which intentionally do not guess an `outerOffset`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentDaylightSample {
    /// Alignment station.
    pub station: f64,
    /// Signed alignment-local offset of the provider-selected source edge.
    pub source_offset: f64,
    /// Exact source-edge elevation resolved from gradient and crossfall.
    pub source_elevation: f64,
    /// Signed alignment-local offset of the daylight point.
    pub target_offset: f64,
    /// Exact target-surface elevation at the daylight point.
    pub target_elevation: f64,
}

/// One exact road-band cross section prepared by the canonical edit engine.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentRoadBandSample {
    /// Alignment station.
    pub station: f64,
    /// Inner road-band edge after gradient and crossfall evaluation.
    pub inner: Vector3,
    /// Outer road-band edge after gradient and crossfall evaluation.
    pub outer: Vector3,
}

/// Bounded road-body input for one band in one changed partition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentRoadBandPartition {
    /// Stable authored width-band identifier.
    pub id: String,
    /// Exact station samples for this partition only.
    pub samples: Vec<AlignmentRoadBandSample>,
}

/// Complete alignment-side input for one incremental partition commit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentPreviewPartitionUpdate {
    /// Preview partition index.
    pub index: u32,
    /// Exact configured station interval.
    pub station_range: AlignmentStationRange,
    /// Gradient/width/crossfall-resolved road bands for this partition.
    pub road_body: Vec<AlignmentRoadBandPartition>,
}

/// Rule-bound daylight profile supplied by an authoritative civil provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentSlopeSnapshot {
    /// Exact authored rule identifier.
    pub rule_id: String,
    /// Exact authored source width-band identifier.
    pub source_band_id: String,
    /// Strictly station-ordered daylight samples covering the evaluated domain.
    pub samples: Vec<AlignmentDaylightSample>,
}

/// Provider output for exactly one preview station partition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentTargetSurfacePartition {
    /// Preview partition index requested by the evaluator.
    pub index: u32,
    /// Exact partition station interval.
    pub station_range: AlignmentStationRange,
    /// Rule-bound daylight profiles limited to this partition.
    pub slopes: Vec<AlignmentSlopeSnapshot>,
}

/// Immutable target-surface snapshot used for one alignment revision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentTargetSurfaceSnapshot {
    /// Canonical target-surface entity.
    pub target_surface: EntityId,
    /// Immutable canonical/evaluated target-surface revision.
    pub target_surface_version: ObjectHash,
    /// Alignment revision for which the daylight profiles were evaluated.
    pub source_alignment_version: ObjectHash,
    /// Independently loadable rule profiles, one record per preview partition.
    pub partitions: Vec<AlignmentTargetSurfacePartition>,
}

/// Bounded target overlay supplied for one incremental alignment edit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentTargetSurfaceUpdate {
    /// Canonical target-surface entity.
    pub target_surface: EntityId,
    /// Exact unchanged target revision; a different revision forces rebuild.
    pub target_surface_version: ObjectHash,
    /// New canonical alignment revision evaluated by these partitions.
    pub source_alignment_version: ObjectHash,
    /// Only provider partitions affected by the edit.
    pub changed_partitions: Vec<AlignmentTargetSurfacePartition>,
}

/// One named open mesh in a preview partition.
#[derive(Debug, Clone, PartialEq)]
pub struct AlignmentPreviewMesh {
    /// Stable width- or crossfall-band identifier.
    pub id: String,
    /// Inline f64 mesh local to the canonical alignment coordinates.
    pub mesh: TriangleMeshGeometry,
}

/// Independently replaceable civil-preview output.
#[derive(Debug, Clone, PartialEq)]
pub struct AlignmentPreviewPartition {
    /// Stable zero-based partition index.
    pub index: u32,
    /// Exact station interval represented by this partition.
    pub station_range: AlignmentStationRange,
    /// Width-band road-body strips, one mesh per authored band.
    pub road_body: Vec<AlignmentPreviewMesh>,
    /// One existing renderer-compatible, target-version-bound slope result per rule.
    pub slopes: Vec<ResolvedAlignmentSlopeGeometry>,
    /// Deterministic hash of this complete partition output.
    pub identity: ObjectHash,
}

/// Immutable initial snapshot or incremental revision.
///
/// Revisions contain only changed partitions and retain their parent by `Arc`.
/// A pointer event therefore performs work proportional to its affected station
/// partitions, not to the size of the complete corridor.
#[derive(Debug)]
pub struct AlignmentPreviewRevision {
    /// Monotonic compare-and-swap generation.
    pub generation: u64,
    /// Exact canonical alignment revision represented by the revision.
    pub alignment_version: ObjectHash,
    /// Number of partitions in the prepared alignment domain.
    pub partition_count: u32,
    /// Only partitions replaced by this revision, for direct renderer upload.
    pub changed_partitions: Vec<Arc<AlignmentPreviewPartition>>,
    /// Persistent path-copied partition tree; lookup depth is bounded by `log2(N)`.
    root: Arc<PartitionTreeNode>,
    /// Identity of the preceding revision without retaining its object graph.
    pub parent_identity: Option<ObjectHash>,
    /// Deterministic revision identity over parent, source revisions and changes.
    pub identity: ObjectHash,
}

impl AlignmentPreviewRevision {
    /// Resolves the newest immutable value for one partition.
    #[must_use]
    pub fn partition(&self, index: u32) -> Option<&AlignmentPreviewPartition> {
        (index < self.partition_count).then(|| self.root.partition(index, 0, self.partition_count))
    }

    /// Maximum partition lookup depth, independent of edit count.
    #[must_use]
    pub fn lookup_depth(&self) -> u32 {
        self.root.depth()
    }
}

#[derive(Debug)]
enum PartitionTreeNode {
    Leaf(Arc<AlignmentPreviewPartition>),
    Branch { left: Arc<Self>, right: Arc<Self> },
}

impl PartitionTreeNode {
    fn build(partitions: &[Arc<AlignmentPreviewPartition>]) -> Arc<Self> {
        if partitions.len() == 1 {
            return Arc::new(Self::Leaf(Arc::clone(&partitions[0])));
        }
        let middle = partitions.len() / 2;
        Arc::new(Self::Branch {
            left: Self::build(&partitions[..middle]),
            right: Self::build(&partitions[middle..]),
        })
    }

    fn partition(&self, index: u32, start: u32, end: u32) -> &AlignmentPreviewPartition {
        match self {
            Self::Leaf(partition) => partition,
            Self::Branch { left, right } => {
                let middle = start + (end - start) / 2;
                if index < middle {
                    left.partition(index, start, middle)
                } else {
                    right.partition(index, middle, end)
                }
            }
        }
    }

    fn replace(
        current: &Arc<Self>,
        start: u32,
        end: u32,
        replacements: &[Arc<AlignmentPreviewPartition>],
    ) -> Arc<Self> {
        if replacements.is_empty()
            || replacements.last().is_some_and(|item| item.index < start)
            || replacements.first().is_some_and(|item| item.index >= end)
        {
            return Arc::clone(current);
        }
        if end - start == 1 {
            return Arc::new(Self::Leaf(Arc::clone(
                replacements
                    .iter()
                    .find(|item| item.index == start)
                    .expect("replacement intersects leaf"),
            )));
        }
        let Self::Branch { left, right } = current.as_ref() else {
            unreachable!("non-leaf tree interval")
        };
        let middle = start + (end - start) / 2;
        Arc::new(Self::Branch {
            left: Self::replace(left, start, middle, replacements),
            right: Self::replace(right, middle, end, replacements),
        })
    }

    fn depth(&self) -> u32 {
        match self {
            Self::Leaf(_) => 1,
            Self::Branch { left, right } => 1 + left.depth().max(right.depth()),
        }
    }
}

/// Bounded work performed by the most recent successful evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlignmentPreviewWorkload {
    /// Number of regenerated partitions.
    pub partitions: u32,
    /// Number of evaluated station cross sections.
    pub station_samples: u32,
}

/// Civil-preview admission or incremental-update failure.
#[derive(Debug, Error)]
pub enum AlignmentPreviewError {
    /// Canonical alignment geometry failed validation.
    #[error("invalid canonical alignment: {0}")]
    Validation(#[from] EntityValidationError),
    /// Horizontal path preparation failed.
    #[error("invalid horizontal alignment: {0}")]
    Curve(#[from] CadCurveError),
    /// Caller-provided canonical revision does not match the alignment content.
    #[error("alignment content hash does not match the supplied revision")]
    AlignmentVersionMismatch,
    /// Configuration or requested range is invalid.
    #[error("invalid alignment preview configuration or station range")]
    InvalidConfiguration,
    /// Target surface or daylight snapshot violates the exact provider contract.
    #[error("invalid target snapshot: {0}")]
    InvalidTargetSnapshot(&'static str),
    /// Optimistic generation changed before this update could commit.
    #[error("stale preview generation: expected {expected}, current {current}")]
    StaleGeneration {
        /// Generation supplied by the editor.
        expected: u64,
        /// Current committed generation.
        current: u64,
    },
    /// A changed target revision requires a fresh authoritative snapshot build.
    #[error("target surface revision changed; the old preview is stale and cannot be reused")]
    TargetVersionChanged,
    /// Horizontal edits require rebuilding the prepared path index.
    #[error("horizontal alignment changed; rebuild the prepared preview evaluator")]
    HorizontalPathChanged,
    /// Requested invalidation does not cover the detected authored change.
    #[error("station invalidation does not cover the detected alignment change")]
    IncompleteInvalidation,
    /// Per-update partition or station-sample budget would be exceeded.
    #[error("incremental alignment preview workload exceeds its configured bound")]
    WorkloadExceeded,
    /// Generated preview topology or hash was invalid.
    #[error("generated alignment preview geometry is invalid")]
    InvalidGeneratedGeometry,
}

/// Stateful generation gate whose published values are immutable revisions.
#[derive(Debug, Clone)]
pub struct AlignmentPreviewEvaluator {
    config: AlignmentPreviewConfig,
    alignment_version: ObjectHash,
    horizontal_path_version: ObjectHash,
    target_versions: Vec<(EntityId, ObjectHash)>,
    path: Arc<PreparedPath>,
    domain: AlignmentStationRange,
    current: Arc<AlignmentPreviewRevision>,
    last_workload: AlignmentPreviewWorkload,
}

impl AlignmentPreviewEvaluator {
    /// Builds and publishes an initial immutable preview snapshot.
    pub fn build(
        alignment: &AlignmentGeometry,
        alignment_version: ObjectHash,
        targets: &[AlignmentTargetSurfaceSnapshot],
        config: AlignmentPreviewConfig,
    ) -> Result<Self, AlignmentPreviewError> {
        validate_alignment_input(alignment, &alignment_version, config)?;
        let path = Arc::new(PreparedPath::new(alignment, config)?);
        let horizontal_path_version = ObjectHash::of_bytes(
            &serde_json::to_vec(&alignment.horizontal)
                .map_err(|_| AlignmentPreviewError::InvalidGeneratedGeometry)?,
        );
        let domain = path.domain(alignment.station_origin);
        validate_targets(alignment, &alignment_version, targets, domain, config)?;
        let partition_count = partition_count(domain, config.partition_length)?;
        let mut changed_partitions = Vec::with_capacity(partition_count as usize);
        let mut workload = AlignmentPreviewWorkload {
            partitions: 0,
            station_samples: 0,
        };
        for index in 0..partition_count {
            let (partition, samples) = evaluate_partition(
                index,
                partition_range(domain, config.partition_length, index),
                alignment,
                &alignment_version,
                targets,
                &path,
                config,
            )?;
            workload.partitions += 1;
            workload.station_samples = workload.station_samples.saturating_add(samples);
            changed_partitions.push(Arc::new(partition));
        }
        let identity = revision_identity(0, &alignment_version, None, &changed_partitions, targets);
        let root = PartitionTreeNode::build(&changed_partitions);
        let current = Arc::new(AlignmentPreviewRevision {
            generation: 0,
            alignment_version: alignment_version.clone(),
            partition_count,
            changed_partitions,
            root,
            parent_identity: None,
            identity,
        });
        let target_versions = targets
            .iter()
            .map(|target| {
                (
                    target.target_surface.clone(),
                    target.target_surface_version.clone(),
                )
            })
            .collect();
        Ok(Self {
            config,
            alignment_version,
            horizontal_path_version,
            target_versions,
            path,
            domain,
            current,
            last_workload: workload,
        })
    }

    /// Current immutable revision.
    #[must_use]
    pub fn current(&self) -> Arc<AlignmentPreviewRevision> {
        Arc::clone(&self.current)
    }

    /// Exact work performed by the last successful build or update.
    #[must_use]
    pub const fn last_workload(&self) -> AlignmentPreviewWorkload {
        self.last_workload
    }

    /// Exact prepared horizontal-path content address required by incremental commits.
    #[must_use]
    pub const fn horizontal_path_version(&self) -> &ObjectHash {
        &self.horizontal_path_version
    }

    /// Returns whether the current output is valid for exact source revisions.
    #[must_use]
    pub fn is_current_for(
        &self,
        alignment_version: &ObjectHash,
        target_versions: &[(EntityId, ObjectHash)],
    ) -> bool {
        self.alignment_version == *alignment_version
            && self.target_versions.len() == target_versions.len()
            && self.target_versions.iter().all(|target| {
                target_versions
                    .iter()
                    .any(|(entity, version)| *entity == target.0 && *version == target.1)
            })
    }

    /// Atomically publishes an incremental revision for an affected station range.
    ///
    /// All validation and mesh construction completes before evaluator state is
    /// changed. An error therefore leaves the previous revision and generation
    /// untouched.
    #[allow(clippy::too_many_lines)]
    pub fn update(
        &mut self,
        expected_generation: u64,
        alignment_version: ObjectHash,
        horizontal_path_version: &ObjectHash,
        partitions: &[AlignmentPreviewPartitionUpdate],
        targets: &[AlignmentTargetSurfaceUpdate],
        affected: AlignmentStationRange,
    ) -> Result<Arc<AlignmentPreviewRevision>, AlignmentPreviewError> {
        if expected_generation != self.current.generation {
            return Err(AlignmentPreviewError::StaleGeneration {
                expected: expected_generation,
                current: self.current.generation,
            });
        }
        if !valid_hash(&alignment_version) {
            return Err(AlignmentPreviewError::AlignmentVersionMismatch);
        }
        if *horizontal_path_version != self.horizontal_path_version {
            return Err(AlignmentPreviewError::HorizontalPathChanged);
        }
        if !valid_range(affected) || !self.domain.contains(affected) {
            return Err(AlignmentPreviewError::InvalidConfiguration);
        }
        if targets
            .windows(2)
            .any(|pair| pair[0].target_surface.0 >= pair[1].target_surface.0)
        {
            return Err(AlignmentPreviewError::InvalidTargetSnapshot(
                "target overlays must be unique and sorted by entity identifier",
            ));
        }
        let first = partition_index(self.domain, self.config.partition_length, affected.start);
        let last = last_partition_index(
            self.domain,
            self.config.partition_length,
            affected.end,
            first,
        );
        let count = last - first + 1;
        if count > self.config.maximum_partitions_per_update {
            return Err(AlignmentPreviewError::WorkloadExceeded);
        }
        if partitions.len() != count as usize
            || partitions.iter().enumerate().any(|(offset, partition)| {
                let Ok(offset) = u32::try_from(offset) else {
                    return true;
                };
                let index = first + offset;
                partition.index != index
                    || partition.station_range
                        != partition_range(self.domain, self.config.partition_length, index)
            })
        {
            return Err(AlignmentPreviewError::IncompleteInvalidation);
        }

        let mut changed_partitions = Vec::with_capacity(count as usize);
        let mut station_samples = 0_u32;
        for input in partitions {
            let expected = self
                .current
                .partition(input.index)
                .ok_or(AlignmentPreviewError::IncompleteInvalidation)?;
            let (partition, samples) = evaluate_prepared_partition(
                input,
                &alignment_version,
                targets,
                &self.path,
                self.config,
                expected,
            )?;
            station_samples = station_samples
                .checked_add(samples)
                .ok_or(AlignmentPreviewError::WorkloadExceeded)?;
            changed_partitions.push(Arc::new(partition));
        }

        let generation = self
            .current
            .generation
            .checked_add(1)
            .ok_or(AlignmentPreviewError::WorkloadExceeded)?;
        let target_identity = targets
            .iter()
            .map(|target| AlignmentTargetSurfaceSnapshot {
                target_surface: target.target_surface.clone(),
                target_surface_version: target.target_surface_version.clone(),
                source_alignment_version: target.source_alignment_version.clone(),
                partitions: Vec::new(),
            })
            .collect::<Vec<_>>();
        let identity = revision_identity(
            generation,
            &alignment_version,
            Some(&self.current.identity),
            &changed_partitions,
            &target_identity,
        );
        let root = PartitionTreeNode::replace(
            &self.current.root,
            0,
            self.current.partition_count,
            &changed_partitions,
        );
        let revision = Arc::new(AlignmentPreviewRevision {
            generation,
            alignment_version: alignment_version.clone(),
            partition_count: self.current.partition_count,
            changed_partitions,
            root,
            parent_identity: Some(self.current.identity.clone()),
            identity,
        });

        self.alignment_version = alignment_version;
        self.current = Arc::clone(&revision);
        self.last_workload = AlignmentPreviewWorkload {
            partitions: count,
            station_samples,
        };
        Ok(revision)
    }
}

#[derive(Debug)]
struct PreparedPath {
    segments: Vec<PathSegment>,
    length: f64,
    station_origin: f64,
}

#[derive(Debug, Clone, Copy)]
struct PathSegment {
    start: Vector3,
    end: Vector3,
    chainage: f64,
    length: f64,
}

#[derive(Debug, Clone, Copy)]
struct PathFrame {
    center_x: f64,
    center_y: f64,
    left_x: f64,
    left_y: f64,
}

impl PreparedPath {
    fn new(
        alignment: &AlignmentGeometry,
        config: AlignmentPreviewConfig,
    ) -> Result<Self, AlignmentPreviewError> {
        let curve = tessellate_curve(
            &alignment.horizontal,
            CurveTessellationOptions {
                chord_tolerance: config.chord_tolerance,
                maximum_segments: config.maximum_curve_segments,
                unresolved_height: UnresolvedHeightDisplay::ViewPlane { elevation: 0.0 },
            },
        )?;
        let mut chainage = 0.0;
        let mut segments = Vec::with_capacity(curve.segments.len());
        for segment in curve.segments {
            let dx = segment.end.x - segment.start.x;
            let dy = segment.end.y - segment.start.y;
            let length = dx.hypot(dy);
            if length > f64::EPSILON {
                segments.push(PathSegment {
                    start: Vector3 {
                        x: segment.start.x,
                        y: segment.start.y,
                        z: segment.start.z,
                    },
                    end: Vector3 {
                        x: segment.end.x,
                        y: segment.end.y,
                        z: segment.end.z,
                    },
                    chainage,
                    length,
                });
                chainage += length;
            }
        }
        if segments.is_empty() || !chainage.is_finite() {
            return Err(AlignmentPreviewError::InvalidConfiguration);
        }
        Ok(Self {
            segments,
            length: chainage,
            station_origin: alignment.station_origin,
        })
    }

    fn domain(&self, station_origin: f64) -> AlignmentStationRange {
        AlignmentStationRange {
            start: station_origin,
            end: station_origin + self.length,
        }
    }

    fn frame(&self, station_origin: f64, station: f64) -> PathFrame {
        let chainage = (station - station_origin).clamp(0.0, self.length);
        let index = self
            .segments
            .partition_point(|segment| segment.chainage + segment.length < chainage)
            .min(self.segments.len() - 1);
        let segment = self.segments[index];
        let fraction = ((chainage - segment.chainage) / segment.length).clamp(0.0, 1.0);
        let dx = segment.end.x - segment.start.x;
        let dy = segment.end.y - segment.start.y;
        PathFrame {
            center_x: segment.start.x + dx * fraction,
            center_y: segment.start.y + dy * fraction,
            left_x: -dy / segment.length,
            left_y: dx / segment.length,
        }
    }
}

fn validate_alignment_input(
    alignment: &AlignmentGeometry,
    alignment_version: &ObjectHash,
    config: AlignmentPreviewConfig,
) -> Result<(), AlignmentPreviewError> {
    validate_geometry_object(&himmelcad_core::entity_model::GeometryObject::Alignment {
        alignment: Box::new(alignment.clone()),
    })?;
    if alignment_geometry_version(alignment)? != *alignment_version {
        return Err(AlignmentPreviewError::AlignmentVersionMismatch);
    }
    if !config.chord_tolerance.is_finite()
        || config.chord_tolerance <= 0.0
        || config.maximum_curve_segments == 0
        || !config.partition_length.is_finite()
        || config.partition_length <= 0.0
        || !config.sample_step.is_finite()
        || config.sample_step <= 0.0
        || config.maximum_partitions_per_update == 0
        || config.maximum_samples_per_partition < 2
        || config.maximum_road_bands_per_partition == 0
        || config.maximum_slope_rules_per_partition == 0
    {
        return Err(AlignmentPreviewError::InvalidConfiguration);
    }
    Ok(())
}

/// Computes the canonical content hash consumed by the preview generation gate.
pub fn alignment_geometry_version(
    alignment: &AlignmentGeometry,
) -> Result<ObjectHash, AlignmentPreviewError> {
    geometry_object_content_hash(&himmelcad_core::entity_model::GeometryObject::Alignment {
        alignment: Box::new(alignment.clone()),
    })
    .map_err(AlignmentPreviewError::Validation)
}

fn validate_targets(
    alignment: &AlignmentGeometry,
    alignment_version: &ObjectHash,
    targets: &[AlignmentTargetSurfaceSnapshot],
    domain: AlignmentStationRange,
    config: AlignmentPreviewConfig,
) -> Result<(), AlignmentPreviewError> {
    let expected_partition_count = partition_count(domain, config.partition_length)?;
    let mut target_ids = std::collections::BTreeSet::new();
    for target in targets {
        if !target_ids.insert(target.target_surface.0.as_str())
            || target.source_alignment_version != *alignment_version
            || !valid_hash(&target.target_surface_version)
            || target.partitions.len() != expected_partition_count as usize
            || target
                .partitions
                .iter()
                .enumerate()
                .any(|(index, partition)| {
                    let Ok(index) = u32::try_from(index) else {
                        return true;
                    };
                    partition.index != index
                        || partition.station_range
                            != partition_range(domain, config.partition_length, index)
                })
        {
            return Err(AlignmentPreviewError::InvalidTargetSnapshot(
                "duplicate, stale or incomplete target partition set",
            ));
        }
    }
    for rule in &alignment.slope_rules {
        let target = targets
            .iter()
            .find(|target| target.target_surface == rule.target_surface)
            .ok_or(AlignmentPreviewError::InvalidTargetSnapshot(
                "missing target surface",
            ))?;
        for partition in &target.partitions {
            validate_target_partition(partition, rule, partition.station_range)?;
        }
    }
    Ok(())
}

fn valid_daylight_sample(sample: AlignmentDaylightSample) -> bool {
    sample.station.is_finite()
        && sample.source_offset.is_finite()
        && sample.source_elevation.is_finite()
        && sample.target_offset.is_finite()
        && sample.target_elevation.is_finite()
}

fn validate_target_partition(
    partition: &AlignmentTargetSurfacePartition,
    rule: &himmelcad_core::entity_model::SlopeRule,
    expected_range: AlignmentStationRange,
) -> Result<(), AlignmentPreviewError> {
    if partition.station_range != expected_range {
        return Err(AlignmentPreviewError::InvalidTargetSnapshot(
            "target partition station range mismatch",
        ));
    }
    let slope = partition
        .slopes
        .iter()
        .find(|slope| slope.rule_id == rule.id)
        .ok_or(AlignmentPreviewError::InvalidTargetSnapshot(
            "missing rule daylight profile",
        ))?;
    if slope.source_band_id != rule.source_band_id {
        return Err(AlignmentPreviewError::InvalidTargetSnapshot(
            "source width-band mismatch",
        ));
    }
    if slope.samples.len() < 2
        || slope
            .samples
            .first()
            .is_none_or(|sample| sample.station > expected_range.start)
        || slope
            .samples
            .last()
            .is_none_or(|sample| sample.station < expected_range.end)
        || slope.samples.windows(2).any(|pair| {
            pair[0].station >= pair[1].station
                || !valid_daylight_sample(pair[0])
                || !valid_daylight_sample(pair[1])
        })
    {
        return Err(AlignmentPreviewError::InvalidTargetSnapshot(
            "daylight profile is invalid or does not cover its partition",
        ));
    }
    Ok(())
}

trait TargetPartitionSource {
    fn target_surface(&self) -> &EntityId;
    fn target_surface_version(&self) -> &ObjectHash;
    fn source_alignment_version(&self) -> &ObjectHash;
    fn partition(&self, index: u32) -> Option<&AlignmentTargetSurfacePartition>;
}

impl TargetPartitionSource for AlignmentTargetSurfaceSnapshot {
    fn target_surface(&self) -> &EntityId {
        &self.target_surface
    }

    fn target_surface_version(&self) -> &ObjectHash {
        &self.target_surface_version
    }

    fn source_alignment_version(&self) -> &ObjectHash {
        &self.source_alignment_version
    }

    fn partition(&self, index: u32) -> Option<&AlignmentTargetSurfacePartition> {
        self.partitions
            .get(index as usize)
            .filter(|item| item.index == index)
    }
}

impl TargetPartitionSource for AlignmentTargetSurfaceUpdate {
    fn target_surface(&self) -> &EntityId {
        &self.target_surface
    }

    fn target_surface_version(&self) -> &ObjectHash {
        &self.target_surface_version
    }

    fn source_alignment_version(&self) -> &ObjectHash {
        &self.source_alignment_version
    }

    fn partition(&self, index: u32) -> Option<&AlignmentTargetSurfacePartition> {
        self.changed_partitions
            .binary_search_by_key(&index, |partition| partition.index)
            .ok()
            .map(|offset| &self.changed_partitions[offset])
    }
}

fn valid_hash(hash: &ObjectHash) -> bool {
    hash.as_str().len() == 64
        && hash
            .as_str()
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_range(range: AlignmentStationRange) -> bool {
    range.start.is_finite() && range.end.is_finite() && range.start <= range.end
}

fn partition_count(
    domain: AlignmentStationRange,
    partition_length: f64,
) -> Result<u32, AlignmentPreviewError> {
    let count = ((domain.end - domain.start) / partition_length)
        .ceil()
        .max(1.0);
    if count > f64::from(u32::MAX) {
        return Err(AlignmentPreviewError::InvalidConfiguration);
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let count = count as u32;
    Ok(count)
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn partition_index(domain: AlignmentStationRange, partition_length: f64, station: f64) -> u32 {
    let count = ((domain.end - domain.start) / partition_length)
        .ceil()
        .max(1.0) as u32;
    (((station - domain.start) / partition_length)
        .floor()
        .max(0.0) as u32)
        .min(count - 1)
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn last_partition_index(
    domain: AlignmentStationRange,
    partition_length: f64,
    station: f64,
    first: u32,
) -> u32 {
    let count = ((domain.end - domain.start) / partition_length)
        .ceil()
        .max(1.0) as u32;
    let coordinate = ((station - domain.start) / partition_length).clamp(0.0, f64::from(count));
    let index = if coordinate.fract().abs() <= f64::EPSILON && station > domain.start {
        coordinate as u32 - 1
    } else {
        coordinate.floor() as u32
    };
    index.min(count - 1).max(first)
}

fn partition_range(
    domain: AlignmentStationRange,
    partition_length: f64,
    index: u32,
) -> AlignmentStationRange {
    let start = domain.start + f64::from(index) * partition_length;
    AlignmentStationRange {
        start,
        end: (start + partition_length).min(domain.end),
    }
}

fn partition_stations(
    range: AlignmentStationRange,
    config: AlignmentPreviewConfig,
) -> Result<Vec<f64>, AlignmentPreviewError> {
    let intervals = ((range.end - range.start) / config.sample_step)
        .ceil()
        .max(1.0);
    let count = intervals + 1.0;
    if count > f64::from(config.maximum_samples_per_partition) {
        return Err(AlignmentPreviewError::WorkloadExceeded);
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let intervals = intervals as u32;
    Ok((0..=intervals)
        .map(|index| {
            range.start + (range.end - range.start) * f64::from(index) / f64::from(intervals)
        })
        .collect())
}

fn evaluate_partition<T: TargetPartitionSource>(
    index: u32,
    range: AlignmentStationRange,
    alignment: &AlignmentGeometry,
    alignment_version: &ObjectHash,
    targets: &[T],
    path: &PreparedPath,
    config: AlignmentPreviewConfig,
) -> Result<(AlignmentPreviewPartition, u32), AlignmentPreviewError> {
    if alignment.width_bands.len() > config.maximum_road_bands_per_partition as usize
        || alignment.slope_rules.len() > config.maximum_slope_rules_per_partition as usize
    {
        return Err(AlignmentPreviewError::WorkloadExceeded);
    }
    let stations = partition_stations(range, config)?;
    let mut road_body = Vec::with_capacity(alignment.width_bands.len());
    for band in &alignment.width_bands {
        road_body.push(AlignmentPreviewMesh {
            id: band.id.clone(),
            mesh: strip_mesh(&stations, |&station| {
                let inner = station_value(&band.inner_offset, station);
                let outer = station_value(&band.outer_offset, station);
                (
                    alignment_point(alignment, path, station, inner),
                    alignment_point(alignment, path, station, outer),
                )
            })?,
        });
    }

    let mut slopes = Vec::with_capacity(alignment.slope_rules.len());
    for rule in &alignment.slope_rules {
        let target = targets
            .iter()
            .find(|target| target.target_surface() == &rule.target_surface)
            .ok_or(AlignmentPreviewError::InvalidTargetSnapshot(
                "missing target surface",
            ))?;
        if target.source_alignment_version() != alignment_version
            || !valid_hash(target.target_surface_version())
        {
            return Err(AlignmentPreviewError::InvalidTargetSnapshot(
                "target overlay is stale or has an invalid version",
            ));
        }
        let target_partition =
            target
                .partition(index)
                .ok_or(AlignmentPreviewError::InvalidTargetSnapshot(
                    "missing affected target partition",
                ))?;
        validate_target_partition(target_partition, rule, range)?;
        let snapshot = target_partition
            .slopes
            .iter()
            .find(|slope| slope.rule_id == rule.id)
            .ok_or(AlignmentPreviewError::InvalidTargetSnapshot(
                "missing rule daylight profile",
            ))?;
        let mesh = strip_mesh(&stations, |&station| {
            let daylight = daylight_value(&snapshot.samples, station);
            (
                alignment_point(alignment, path, station, daylight.source_offset),
                target_point(path, alignment.station_origin, station, daylight),
            )
        })?;
        let geometry_version = alignment_slope_geometry_version(&mesh)
            .map_err(|_| AlignmentPreviewError::InvalidGeneratedGeometry)?;
        slopes.push(ResolvedAlignmentSlopeGeometry {
            rule_id: rule.id.clone(),
            source_band_id: rule.source_band_id.clone(),
            target_surface: rule.target_surface.clone(),
            target_surface_version: target.target_surface_version().clone(),
            geometry_version,
            mesh,
        });
    }

    let identity = partition_identity(index, range, alignment_version, &road_body, &slopes);
    Ok((
        AlignmentPreviewPartition {
            index,
            station_range: range,
            road_body,
            slopes,
            identity,
        },
        u32::try_from(stations.len()).map_err(|_| AlignmentPreviewError::WorkloadExceeded)?,
    ))
}

#[allow(clippy::too_many_lines)]
fn evaluate_prepared_partition(
    input: &AlignmentPreviewPartitionUpdate,
    alignment_version: &ObjectHash,
    targets: &[AlignmentTargetSurfaceUpdate],
    path: &PreparedPath,
    config: AlignmentPreviewConfig,
    expected: &AlignmentPreviewPartition,
) -> Result<(AlignmentPreviewPartition, u32), AlignmentPreviewError> {
    if input.road_body.len() > config.maximum_road_bands_per_partition as usize
        || expected.slopes.len() > config.maximum_slope_rules_per_partition as usize
    {
        return Err(AlignmentPreviewError::WorkloadExceeded);
    }
    if input.road_body.len() != expected.road_body.len() {
        return Err(AlignmentPreviewError::IncompleteInvalidation);
    }
    let mut workload = 0_u32;
    let mut road_body = Vec::with_capacity(input.road_body.len());
    for (band, expected_band) in input.road_body.iter().zip(&expected.road_body) {
        if band.id != expected_band.id
            || band.samples.len() < 2
            || band.samples.len() > config.maximum_samples_per_partition as usize
            || band
                .samples
                .first()
                .is_none_or(|sample| sample.station > input.station_range.start)
            || band
                .samples
                .last()
                .is_none_or(|sample| sample.station < input.station_range.end)
            || band.samples.windows(2).any(|pair| {
                pair[0].station >= pair[1].station
                    || !valid_vector(pair[0].inner)
                    || !valid_vector(pair[0].outer)
                    || !valid_vector(pair[1].inner)
                    || !valid_vector(pair[1].outer)
            })
        {
            return Err(AlignmentPreviewError::InvalidGeneratedGeometry);
        }
        workload = workload
            .checked_add(
                u32::try_from(band.samples.len())
                    .map_err(|_| AlignmentPreviewError::WorkloadExceeded)?,
            )
            .ok_or(AlignmentPreviewError::WorkloadExceeded)?;
        road_body.push(AlignmentPreviewMesh {
            id: band.id.clone(),
            mesh: strip_mesh(&band.samples, |sample| (sample.inner, sample.outer))?,
        });
    }

    let mut slopes = Vec::with_capacity(expected.slopes.len());
    for expected_slope in &expected.slopes {
        let target = targets
            .binary_search_by(|target| {
                target
                    .target_surface
                    .0
                    .as_str()
                    .cmp(expected_slope.target_surface.0.as_str())
            })
            .ok()
            .map(|index| &targets[index])
            .ok_or(AlignmentPreviewError::InvalidTargetSnapshot(
                "missing affected target surface overlay",
            ))?;
        if target.source_alignment_version != *alignment_version
            || target.target_surface_version != expected_slope.target_surface_version
        {
            return Err(AlignmentPreviewError::TargetVersionChanged);
        }
        let partition =
            target
                .partition(input.index)
                .ok_or(AlignmentPreviewError::InvalidTargetSnapshot(
                    "missing affected target partition",
                ))?;
        if partition
            .slopes
            .windows(2)
            .any(|pair| pair[0].rule_id >= pair[1].rule_id)
        {
            return Err(AlignmentPreviewError::InvalidTargetSnapshot(
                "rule overlays must be unique and sorted",
            ));
        }
        let snapshot = partition
            .slopes
            .binary_search_by(|slope| slope.rule_id.as_str().cmp(expected_slope.rule_id.as_str()))
            .ok()
            .map(|index| &partition.slopes[index])
            .ok_or(AlignmentPreviewError::InvalidTargetSnapshot(
                "missing affected rule profile",
            ))?;
        if snapshot.source_band_id != expected_slope.source_band_id
            || snapshot.samples.len() < 2
            || snapshot.samples.len() > config.maximum_samples_per_partition as usize
        {
            return Err(AlignmentPreviewError::InvalidTargetSnapshot(
                "affected rule profile is incompatible",
            ));
        }
        workload = workload
            .checked_add(
                u32::try_from(snapshot.samples.len())
                    .map_err(|_| AlignmentPreviewError::WorkloadExceeded)?,
            )
            .ok_or(AlignmentPreviewError::WorkloadExceeded)?;
        let mesh = strip_mesh(&snapshot.samples, |sample| {
            (
                resolved_source_point(path, sample.station, *sample),
                target_point(path, path.station_origin, sample.station, *sample),
            )
        })?;
        let geometry_version = alignment_slope_geometry_version(&mesh)
            .map_err(|_| AlignmentPreviewError::InvalidGeneratedGeometry)?;
        slopes.push(ResolvedAlignmentSlopeGeometry {
            rule_id: snapshot.rule_id.clone(),
            source_band_id: snapshot.source_band_id.clone(),
            target_surface: target.target_surface.clone(),
            target_surface_version: target.target_surface_version.clone(),
            geometry_version,
            mesh,
        });
    }
    let identity = partition_identity(
        input.index,
        input.station_range,
        alignment_version,
        &road_body,
        &slopes,
    );
    Ok((
        AlignmentPreviewPartition {
            index: input.index,
            station_range: input.station_range,
            road_body,
            slopes,
            identity,
        },
        workload,
    ))
}

fn valid_vector(vector: Vector3) -> bool {
    vector.x.is_finite() && vector.y.is_finite() && vector.z.is_finite()
}

fn strip_mesh<S, F>(
    samples: &[S],
    mut edges: F,
) -> Result<TriangleMeshGeometry, AlignmentPreviewError>
where
    F: FnMut(&S) -> (Vector3, Vector3),
{
    let mut positions = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        let (left, right) = edges(sample);
        positions.extend([left, right]);
    }
    let mut indices = Vec::with_capacity((samples.len() - 1) * 6);
    for index in 0..samples.len() - 1 {
        let base = u32::try_from(index * 2).map_err(|_| AlignmentPreviewError::WorkloadExceeded)?;
        indices.extend([base, base + 2, base + 1, base + 1, base + 2, base + 3]);
    }
    let mesh = TriangleMeshGeometry {
        storage: TriangleMeshStorage::Inline {
            positions,
            indices,
            normals: None,
            texture_coordinates: None,
        },
        closed_manifold: false,
        triangle_material_slots: None,
        materials: None,
    };
    validate_geometry_object(&himmelcad_core::entity_model::GeometryObject::Surface3d {
        mesh: Box::new(mesh.clone()),
    })
    .map_err(|_| AlignmentPreviewError::InvalidGeneratedGeometry)?;
    Ok(mesh)
}

fn alignment_point(
    alignment: &AlignmentGeometry,
    path: &PreparedPath,
    station: f64,
    offset: f64,
) -> Vector3 {
    let frame = path.frame(alignment.station_origin, station);
    Vector3 {
        x: offset.mul_add(frame.left_x, frame.center_x),
        y: offset.mul_add(frame.left_y, frame.center_y),
        z: crossfall_height(alignment, station, offset)
            + alignment_elevation(alignment, station).unwrap_or(0.0),
    }
}

fn target_point(
    path: &PreparedPath,
    station_origin: f64,
    station: f64,
    daylight: AlignmentDaylightSample,
) -> Vector3 {
    let frame = path.frame(station_origin, station);
    Vector3 {
        x: daylight.target_offset.mul_add(frame.left_x, frame.center_x),
        y: daylight.target_offset.mul_add(frame.left_y, frame.center_y),
        z: daylight.target_elevation,
    }
}

fn resolved_source_point(
    path: &PreparedPath,
    station: f64,
    daylight: AlignmentDaylightSample,
) -> Vector3 {
    let frame = path.frame(path.station_origin, station);
    Vector3 {
        x: daylight.source_offset.mul_add(frame.left_x, frame.center_x),
        y: daylight.source_offset.mul_add(frame.left_y, frame.center_y),
        z: daylight.source_elevation,
    }
}

fn alignment_elevation(alignment: &AlignmentGeometry, station: f64) -> Option<f64> {
    alignment
        .vertical
        .iter()
        .find_map(|segment| match *segment {
            VerticalAlignmentSegment::Grade {
                start_station,
                start_elevation,
                grade,
                length,
            } if (start_station..=start_station + length).contains(&station) => {
                Some((station - start_station).mul_add(grade, start_elevation))
            }
            VerticalAlignmentSegment::Parabolic {
                start_station,
                start_elevation,
                start_grade,
                end_grade,
                length,
            } if (start_station..=start_station + length).contains(&station) => {
                let distance = station - start_station;
                let curvature = (end_grade - start_grade) / length;
                Some(
                    (0.5 * curvature * distance)
                        .mul_add(distance, start_grade.mul_add(distance, start_elevation)),
                )
            }
            _ => None,
        })
}

fn station_value(function: &StationFunction, station: f64) -> f64 {
    let first = function
        .samples
        .first()
        .expect("validated station function");
    if station <= first.station {
        return first.value;
    }
    let last = function.samples.last().expect("validated station function");
    if station >= last.station {
        return last.value;
    }
    let index = function
        .samples
        .partition_point(|sample| sample.station < station)
        .min(function.samples.len() - 1);
    let left = function.samples[index - 1];
    let right = function.samples[index];
    let fraction = (station - left.station) / (right.station - left.station);
    (right.value - left.value).mul_add(fraction, left.value)
}

fn daylight_value(samples: &[AlignmentDaylightSample], station: f64) -> AlignmentDaylightSample {
    if station <= samples[0].station {
        return samples[0];
    }
    if station >= samples[samples.len() - 1].station {
        return samples[samples.len() - 1];
    }
    let index = samples
        .partition_point(|sample| sample.station < station)
        .min(samples.len() - 1);
    let left = samples[index - 1];
    let right = samples[index];
    let fraction = (station - left.station) / (right.station - left.station);
    AlignmentDaylightSample {
        station,
        source_offset: (right.source_offset - left.source_offset)
            .mul_add(fraction, left.source_offset),
        source_elevation: (right.source_elevation - left.source_elevation)
            .mul_add(fraction, left.source_elevation),
        target_offset: (right.target_offset - left.target_offset)
            .mul_add(fraction, left.target_offset),
        target_elevation: (right.target_elevation - left.target_elevation)
            .mul_add(fraction, left.target_elevation),
    }
}

fn crossfall_height(alignment: &AlignmentGeometry, station: f64, offset: f64) -> f64 {
    alignment
        .crossfall_bands
        .iter()
        .find_map(|band| {
            let from = station_value(&band.from_offset, station);
            let to = station_value(&band.to_offset, station);
            ((from.min(to)..=from.max(to)).contains(&offset))
                .then(|| (offset - from) * station_value(&band.crossfall, station))
        })
        .unwrap_or(0.0)
}

fn partition_identity(
    index: u32,
    range: AlignmentStationRange,
    alignment_version: &ObjectHash,
    road_body: &[AlignmentPreviewMesh],
    slopes: &[ResolvedAlignmentSlopeGeometry],
) -> ObjectHash {
    let mut bytes = serde_json::to_vec(&(index, range, alignment_version))
        .expect("preview identity values serialize");
    for mesh in road_body {
        bytes.extend_from_slice(mesh.id.as_bytes());
        bytes.extend_from_slice(
            &serde_json::to_vec(&mesh.mesh).expect("canonical preview mesh serializes"),
        );
    }
    for slope in slopes {
        bytes.extend_from_slice(slope.rule_id.as_bytes());
        bytes.extend_from_slice(slope.geometry_version.as_str().as_bytes());
        bytes.extend_from_slice(slope.target_surface_version.as_str().as_bytes());
    }
    ObjectHash::of_bytes(&bytes)
}

fn revision_identity(
    generation: u64,
    alignment_version: &ObjectHash,
    parent: Option<&ObjectHash>,
    partitions: &[Arc<AlignmentPreviewPartition>],
    targets: &[AlignmentTargetSurfaceSnapshot],
) -> ObjectHash {
    let mut bytes = generation.to_le_bytes().to_vec();
    bytes.extend_from_slice(alignment_version.as_str().as_bytes());
    if let Some(parent) = parent {
        bytes.extend_from_slice(parent.as_str().as_bytes());
    }
    for target in targets {
        bytes.extend_from_slice(target.target_surface.0.as_bytes());
        bytes.extend_from_slice(target.target_surface_version.as_str().as_bytes());
    }
    for partition in partitions {
        bytes.extend_from_slice(&partition.index.to_le_bytes());
        bytes.extend_from_slice(partition.identity.as_str().as_bytes());
    }
    ObjectHash::of_bytes(&bytes)
}

#[cfg(test)]
mod tests {
    use himmelcad_core::entity_model::{
        CrossfallBand, CurveGeometry, Position, SlopeRule, StationValue, WidthBand,
    };

    use super::*;

    fn function(samples: &[(f64, f64)]) -> StationFunction {
        StationFunction {
            samples: samples
                .iter()
                .map(|&(station, value)| StationValue { station, value })
                .collect(),
        }
    }

    fn alignment() -> AlignmentGeometry {
        AlignmentGeometry {
            horizontal: CurveGeometry::LineSegment {
                start: Position {
                    x: 0.0,
                    y: 0.0,
                    z: Some(0.0),
                },
                end: Position {
                    x: 1000.0,
                    y: 0.0,
                    z: Some(0.0),
                },
            },
            vertical: vec![VerticalAlignmentSegment::Grade {
                start_station: 0.0,
                start_elevation: 100.0,
                grade: 0.01,
                length: 1000.0,
            }],
            station_origin: 0.0,
            width_bands: vec![WidthBand {
                id: "carriageway".into(),
                inner_offset: function(&[(0.0, 0.0), (1000.0, 0.0)]),
                outer_offset: function(&[
                    (0.0, 4.0),
                    (400.0, 4.0),
                    (500.0, 5.0),
                    (600.0, 4.0),
                    (1000.0, 4.0),
                ]),
            }],
            crossfall_bands: vec![CrossfallBand {
                id: "right-ramp".into(),
                from_offset: function(&[(0.0, 0.0), (1000.0, 0.0)]),
                to_offset: function(&[(0.0, 4.0), (1000.0, 4.0)]),
                crossfall: function(&[(0.0, -0.02), (1000.0, -0.02)]),
            }],
            slope_rules: vec![SlopeRule {
                id: "fill-right".into(),
                source_band_id: "carriageway".into(),
                target_surface: EntityId("ground".into()),
                cut_ratio: 0.5,
                fill_ratio: 0.5,
            }],
        }
    }

    fn targets(version: &ObjectHash) -> Vec<AlignmentTargetSurfaceSnapshot> {
        vec![AlignmentTargetSurfaceSnapshot {
            target_surface: EntityId("ground".into()),
            target_surface_version: ObjectHash::of_bytes(b"ground-v1"),
            source_alignment_version: version.clone(),
            partitions: (0..10).map(|index| target_partition(index, 4.0)).collect(),
        }]
    }

    fn target_partition(index: u32, source_offset: f64) -> AlignmentTargetSurfacePartition {
        let start = f64::from(index) * 100.0;
        let end = start + 100.0;
        AlignmentTargetSurfacePartition {
            index,
            station_range: AlignmentStationRange { start, end },
            slopes: vec![AlignmentSlopeSnapshot {
                rule_id: "fill-right".into(),
                source_band_id: "carriageway".into(),
                samples: vec![
                    AlignmentDaylightSample {
                        station: start,
                        source_offset,
                        source_elevation: 100.0 + start * 0.01 - source_offset * 0.02,
                        target_offset: 12.0,
                        target_elevation: 96.0 + start * 0.01,
                    },
                    AlignmentDaylightSample {
                        station: end,
                        source_offset,
                        source_elevation: 100.0 + end * 0.01 - source_offset * 0.02,
                        target_offset: 12.0,
                        target_elevation: 96.0 + end * 0.01,
                    },
                ],
            }],
        }
    }

    fn target_updates(
        version: &ObjectHash,
        indices: impl IntoIterator<Item = u32>,
    ) -> Vec<AlignmentTargetSurfaceUpdate> {
        vec![AlignmentTargetSurfaceUpdate {
            target_surface: EntityId("ground".into()),
            target_surface_version: ObjectHash::of_bytes(b"ground-v1"),
            source_alignment_version: version.clone(),
            changed_partitions: indices
                .into_iter()
                .map(|index| target_partition(index, 4.0))
                .collect(),
        }]
    }

    fn road_partition(
        index: u32,
        partition_length: f64,
        outer_offset: f64,
    ) -> AlignmentPreviewPartitionUpdate {
        let start = f64::from(index) * partition_length;
        let end = start + partition_length;
        let sample = |station: f64| AlignmentRoadBandSample {
            station,
            inner: Vector3 {
                x: station,
                y: 0.0,
                z: 100.0 + station * 0.01,
            },
            outer: Vector3 {
                x: station,
                y: outer_offset,
                z: 100.0 + station * 0.01 - outer_offset * 0.02,
            },
        };
        AlignmentPreviewPartitionUpdate {
            index,
            station_range: AlignmentStationRange { start, end },
            road_body: vec![AlignmentRoadBandPartition {
                id: "carriageway".into(),
                samples: vec![sample(start), sample(end)],
            }],
        }
    }

    fn config() -> AlignmentPreviewConfig {
        AlignmentPreviewConfig {
            chord_tolerance: 0.01,
            maximum_curve_segments: 128,
            partition_length: 100.0,
            sample_step: 10.0,
            maximum_partitions_per_update: 2,
            maximum_samples_per_partition: 16,
            maximum_road_bands_per_partition: 8,
            maximum_slope_rules_per_partition: 8,
        }
    }

    fn evaluator() -> AlignmentPreviewEvaluator {
        let alignment = alignment();
        let version = alignment_geometry_version(&alignment).unwrap();
        AlignmentPreviewEvaluator::build(&alignment, version.clone(), &targets(&version), config())
            .unwrap()
    }

    #[test]
    fn deterministic_identity_and_partitioned_slope_contract() {
        let first = evaluator();
        let second = evaluator();
        assert_eq!(first.current.identity, second.current.identity);
        assert_eq!(first.current.partition_count, 10);
        let partition = first.current.partition(0).unwrap();
        assert_eq!(partition.road_body.len(), 1);
        assert_eq!(partition.slopes.len(), 1);
        assert_eq!(
            partition.slopes[0].geometry_version,
            alignment_slope_geometry_version(&partition.slopes[0].mesh).unwrap()
        );
    }

    #[test]
    fn width_and_crossfall_generate_expected_ramp_geometry() {
        let evaluator = evaluator();
        let partition = evaluator.current.partition(0).unwrap();
        let TriangleMeshStorage::Inline { positions, .. } = &partition.road_body[0].mesh.storage
        else {
            panic!("preview mesh must be inline")
        };
        assert_eq!(positions[0].z, 100.0);
        assert_eq!(positions[1].y, 4.0);
        assert!((positions[1].z - 99.92).abs() < 1.0e-10);
        let TriangleMeshStorage::Inline {
            positions: slope_positions,
            ..
        } = &partition.slopes[0].mesh.storage
        else {
            panic!("slope mesh must be inline")
        };
        assert_eq!(slope_positions[1].y, 12.0);
        assert_eq!(slope_positions[1].z, 96.0);
    }

    #[test]
    fn localized_edit_replaces_only_affected_station_partitions() {
        let mut evaluator = evaluator();
        let old_partition = evaluator.current.partition(0).unwrap().identity.clone();
        let mut changed = alignment();
        changed.width_bands[0].outer_offset = function(&[
            (0.0, 4.0),
            (400.0, 4.0),
            (500.0, 6.0),
            (600.0, 4.0),
            (1000.0, 4.0),
        ]);
        let version = alignment_geometry_version(&changed).unwrap();
        let path_version = evaluator.horizontal_path_version().clone();
        let revision = evaluator
            .update(
                0,
                version.clone(),
                &path_version,
                &[road_partition(4, 100.0, 5.0), road_partition(5, 100.0, 5.0)],
                &target_updates(&version, [4, 5]),
                AlignmentStationRange {
                    start: 400.0,
                    end: 600.0,
                },
            )
            .unwrap();
        assert_eq!(revision.changed_partitions.len(), 2);
        assert_eq!(revision.partition(0).unwrap().identity, old_partition);
        assert_eq!(evaluator.last_workload().partitions, 2);
        let TriangleMeshStorage::Inline { positions, .. } =
            &revision.partition(4).unwrap().road_body[0].mesh.storage
        else {
            panic!("updated road preview must remain inline")
        };
        assert_eq!(positions[1].y, 5.0);
    }

    #[test]
    fn target_version_change_rejects_stale_incremental_reuse() {
        let mut evaluator = evaluator();
        let before = evaluator.current();
        let alignment = alignment();
        let version = alignment_geometry_version(&alignment).unwrap();
        let mut changed_targets = target_updates(&version, [0]);
        changed_targets[0].target_surface_version = ObjectHash::of_bytes(b"ground-v2");
        let path_version = evaluator.horizontal_path_version().clone();
        let error = evaluator
            .update(
                0,
                version,
                &path_version,
                &[road_partition(0, 100.0, 4.0)],
                &changed_targets,
                AlignmentStationRange {
                    start: 0.0,
                    end: 100.0,
                },
            )
            .unwrap_err();
        assert!(matches!(error, AlignmentPreviewError::TargetVersionChanged));
        assert!(Arc::ptr_eq(&before, &evaluator.current()));
    }

    #[test]
    fn horizontal_path_change_requires_a_fresh_evaluator() {
        let mut evaluator = evaluator();
        let before = evaluator.current();
        let alignment = alignment();
        let version = alignment_geometry_version(&alignment).unwrap();
        let error = evaluator
            .update(
                0,
                version.clone(),
                &ObjectHash::of_bytes(b"different horizontal path"),
                &[road_partition(0, 100.0, 4.0)],
                &target_updates(&version, [0]),
                AlignmentStationRange {
                    start: 0.0,
                    end: 100.0,
                },
            )
            .unwrap_err();
        assert!(matches!(
            error,
            AlignmentPreviewError::HorizontalPathChanged
        ));
        assert!(Arc::ptr_eq(&before, &evaluator.current()));
    }

    #[test]
    fn uppercase_target_hash_is_not_a_canonical_revision() {
        let alignment = alignment();
        let version = alignment_geometry_version(&alignment).unwrap();
        let mut snapshots = targets(&version);
        snapshots[0].target_surface_version = ObjectHash("A".repeat(64));
        let error = AlignmentPreviewEvaluator::build(&alignment, version, &snapshots, config())
            .unwrap_err();
        assert!(matches!(
            error,
            AlignmentPreviewError::InvalidTargetSnapshot(_)
        ));
    }

    #[test]
    fn failed_update_is_atomic_and_preserves_previous_revision() {
        let mut evaluator = evaluator();
        let before = evaluator.current();
        let mut changed = alignment();
        changed.width_bands[0].outer_offset.samples[2].value = 6.0;
        let version = alignment_geometry_version(&changed).unwrap();
        let path_version = evaluator.horizontal_path_version().clone();
        let error = evaluator
            .update(
                0,
                version.clone(),
                &path_version,
                &[road_partition(4, 100.0, 6.0)],
                &target_updates(&version, [4, 5]),
                AlignmentStationRange {
                    start: 400.0,
                    end: 600.0,
                },
            )
            .unwrap_err();
        assert!(matches!(
            error,
            AlignmentPreviewError::IncompleteInvalidation
        ));
        assert!(Arc::ptr_eq(&before, &evaluator.current()));
        assert_eq!(evaluator.current.generation, 0);
    }

    #[test]
    fn pointer_update_work_is_bounded_independently_of_total_partitions() {
        let mut evaluator = evaluator();
        let alignment = alignment();
        let version = alignment_geometry_version(&alignment).unwrap();
        let path_version = evaluator.horizontal_path_version().clone();
        evaluator
            .update(
                0,
                version.clone(),
                &path_version,
                &[road_partition(2, 100.0, 4.0)],
                &target_updates(&version, [2]),
                AlignmentStationRange {
                    start: 200.1,
                    end: 299.9,
                },
            )
            .unwrap();
        assert_eq!(evaluator.last_workload().partitions, 1);
        assert!(evaluator.last_workload().station_samples <= 16);
        assert_eq!(evaluator.current.partition_count, 10);
    }

    #[test]
    fn ten_thousand_edits_keep_lookup_depth_and_retained_root_bounded() {
        let mut alignment = alignment();
        alignment.slope_rules.clear();
        let version = alignment_geometry_version(&alignment).unwrap();
        let mut bounded_config = config();
        bounded_config.partition_length = 1.0;
        bounded_config.sample_step = 1.0;
        bounded_config.maximum_samples_per_partition = 2;
        bounded_config.maximum_partitions_per_update = 1;
        let mut evaluator =
            AlignmentPreviewEvaluator::build(&alignment, version.clone(), &[], bounded_config)
                .unwrap();
        let initial_depth = evaluator.current.lookup_depth();
        assert_eq!(evaluator.current.partition_count, 1000);
        assert!(initial_depth <= 11);
        let path_version = evaluator.horizontal_path_version().clone();

        for generation in 0..10_000_u64 {
            let index = (generation % 1000) as f64;
            evaluator
                .update(
                    generation,
                    version.clone(),
                    &path_version,
                    &[road_partition(generation as u32 % 1000, 1.0, 4.0)],
                    &[],
                    AlignmentStationRange {
                        start: index + 0.1,
                        end: index + 0.9,
                    },
                )
                .unwrap();
        }

        assert_eq!(evaluator.current.lookup_depth(), initial_depth);
        assert_eq!(Arc::strong_count(&evaluator.current.root), 1);
        assert_eq!(evaluator.last_workload().partitions, 1);
        assert_eq!(evaluator.last_workload().station_samples, 2);
        assert!(evaluator.current.partition(999).is_some());
    }
}
