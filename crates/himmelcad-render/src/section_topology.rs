//! Authoritative, residency-independent topology snapshots for exact sections.

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{Display, Formatter};

use serde::{Deserialize, Serialize};

use crate::section::{finish_authoritative_section_product, transform_section_positions_in_place};
use crate::{
    section_open_mesh, AuthoritativeSectionEvaluationError, AuthoritativeSectionProduct,
    SectionMeshInput, SectionPlane, SectionTopologyBounds, SectionTopologyPart, WorldTransform,
    WorldVec3,
};

/// Exact identity of one immutable source-topology revision.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SectionTopologySnapshotKey {
    /// Canonical entity owning the geometry.
    pub entity_id: String,
    /// Streamed dataset identity, absent for inline project geometry.
    pub dataset_id: Option<String>,
    /// Immutable canonical entity revision.
    pub version_hash: String,
}

/// Immutable manifest for a complete source topology snapshot.
///
/// The manifest deliberately stores no triangle buffers. A project/import provider
/// resolves its content-addressed parts only while an exact section is evaluated,
/// so renderer tile residency cannot make the result incomplete.
#[derive(Debug, Clone, PartialEq)]
pub struct SectionTopologySnapshot {
    key: SectionTopologySnapshotKey,
    topology_hash: String,
    parts: Vec<SectionTopologyPart>,
    material_keys: BTreeMap<u32, String>,
    closed_manifold: bool,
}

impl SectionTopologySnapshot {
    /// Builds and validates one complete, deterministic topology manifest.
    pub fn new(
        key: SectionTopologySnapshotKey,
        topology_hash: String,
        mut parts: Vec<SectionTopologyPart>,
        material_keys: BTreeMap<u32, String>,
        closed_manifold: bool,
    ) -> Result<Self, SectionTopologyStoreError> {
        parts.sort_unstable_by(|left, right| left.part_id.cmp(&right.part_id));
        if key.entity_id.is_empty()
            || key.version_hash.is_empty()
            || key.dataset_id.as_ref().is_some_and(String::is_empty)
            || topology_hash.is_empty()
            || parts.is_empty()
            || parts.iter().any(|part| {
                part.part_id.is_empty()
                    || part.topology_hash.is_empty()
                    || part.bounds.is_some_and(|bounds| {
                        bounds.minimum.iter().any(|value| !value.is_finite())
                            || bounds.maximum.iter().any(|value| !value.is_finite())
                            || (0..3).any(|axis| bounds.minimum[axis] > bounds.maximum[axis])
                    })
            })
            || parts
                .windows(2)
                .any(|pair| pair[0].part_id == pair[1].part_id)
            || (closed_manifold && material_keys.is_empty())
            || material_keys.values().any(String::is_empty)
        {
            return Err(SectionTopologyStoreError::InvalidSnapshot);
        }
        Ok(Self {
            key,
            topology_hash,
            parts,
            material_keys,
            closed_manifold,
        })
    }

    /// Exact lookup key of this revision.
    #[must_use]
    pub fn key(&self) -> &SectionTopologySnapshotKey {
        &self.key
    }

    /// Complete topology content hash supplied by the authoritative producer.
    #[must_use]
    pub fn topology_hash(&self) -> &str {
        &self.topology_hash
    }

    /// Deterministically ordered content-addressed partition descriptors.
    #[must_use]
    pub fn parts(&self) -> &[SectionTopologyPart] {
        &self.parts
    }

    /// Stable material identities indexed by source triangle material slot.
    #[must_use]
    pub fn material_keys(&self) -> &BTreeMap<u32, String> {
        &self.material_keys
    }

    /// Whether the complete partition union is an authoritative closed two-manifold.
    #[must_use]
    pub const fn closed_manifold(&self) -> bool {
        self.closed_manifold
    }
}

/// One provider-decoded topology partition held only for the current evaluation step.
#[derive(Debug, Clone, PartialEq)]
pub struct SectionTopologyPartitionData {
    /// Hash of the exact decoded source object; must match the manifest descriptor.
    pub topology_hash: String,
    /// Representation-local/source f64 positions placed by the section evaluator.
    pub positions: Vec<WorldVec3>,
    /// Triangle-list source indices.
    pub indices: Vec<u32>,
    /// Optional canonical material slot for every triangle.
    pub material_slots: Option<Vec<u32>>,
}

/// A content-addressed topology partition could not be supplied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SectionTopologyLoadError {
    /// Provider diagnostic suitable for logs.
    pub message: String,
}

impl Display for SectionTopologyLoadError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for SectionTopologyLoadError {}

/// Publishing or resolving an authoritative topology snapshot failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SectionTopologyStoreError {
    /// Snapshot identity, partitions or material table are incomplete or ambiguous.
    InvalidSnapshot,
    /// The requested immutable entity revision is not registered.
    SnapshotNotFound,
    /// The authoritative union is not a closed two-manifold.
    OpenTopology,
    /// A declared partition could not be loaded.
    PartitionLoad {
        /// Stable manifest partition identity.
        part_id: String,
        /// Provider diagnostic.
        message: String,
    },
    /// Loaded content did not match its immutable manifest hash.
    PartitionHashMismatch {
        /// Stable manifest partition identity.
        part_id: String,
    },
    /// The representation-local/source to project-world transform is invalid.
    InvalidSourceToProject,
    /// A streaming evaluator received a partition other than the next manifest entry.
    UnexpectedPartition {
        /// Next deterministic manifest part.
        expected_part_id: String,
        /// Provider-supplied part identity.
        actual_part_id: String,
    },
    /// A streaming evaluator was finished before every manifest partition arrived.
    IncompleteSnapshot,
    /// Exact plane intersection or product validation failed.
    Evaluation(AuthoritativeSectionEvaluationError),
}

impl Display for SectionTopologyStoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSnapshot => formatter.write_str("section topology snapshot is invalid"),
            Self::SnapshotNotFound => {
                formatter.write_str("section topology snapshot was not found")
            }
            Self::OpenTopology => {
                formatter.write_str("section topology snapshot is not a closed manifold")
            }
            Self::PartitionLoad { part_id, message } => {
                write!(
                    formatter,
                    "section topology part {part_id} could not be loaded: {message}"
                )
            }
            Self::PartitionHashMismatch { part_id } => write!(
                formatter,
                "section topology part {part_id} does not match its manifest hash"
            ),
            Self::InvalidSourceToProject => formatter.write_str(
                "section topology source-to-project transform is not a finite invertible affine transform",
            ),
            Self::UnexpectedPartition {
                expected_part_id,
                actual_part_id,
            } => write!(
                formatter,
                "section topology expected part {expected_part_id}, received {actual_part_id}"
            ),
            Self::IncompleteSnapshot => {
                formatter.write_str("section topology snapshot is incomplete")
            }
            Self::Evaluation(error) => {
                write!(formatter, "section topology evaluation failed: {error}")
            }
        }
    }
}

impl Error for SectionTopologyStoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Evaluation(error) => Some(error),
            _ => None,
        }
    }
}

/// Bounded-memory exact section operation over one immutable topology snapshot.
///
/// The operation retains only plane-intersection segments. A provider can decode
/// one source partition, push it, and immediately release its triangle buffers.
#[derive(Debug)]
pub struct AuthoritativeSectionAccumulator {
    snapshot: SectionTopologySnapshot,
    plane: SectionPlane,
    tolerance: f64,
    source_to_project: WorldTransform,
    next_part: usize,
    segments: Vec<crate::SectionSegment>,
}

impl AuthoritativeSectionAccumulator {
    /// Starts an evaluation without loading any source triangle buffers.
    #[must_use]
    pub const fn new(
        snapshot: SectionTopologySnapshot,
        plane: SectionPlane,
        tolerance: f64,
    ) -> Self {
        Self {
            snapshot,
            plane,
            tolerance,
            source_to_project: WorldTransform::IDENTITY,
            next_part: 0,
            segments: Vec::new(),
        }
    }

    /// Starts an evaluation with an explicit representation-local to project-world transform.
    pub fn new_with_transform(
        snapshot: SectionTopologySnapshot,
        plane: SectionPlane,
        tolerance: f64,
        source_to_project: WorldTransform,
    ) -> Result<Self, SectionTopologyStoreError> {
        if !source_to_project.is_invertible_affine() {
            return Err(SectionTopologyStoreError::InvalidSourceToProject);
        }
        Ok(Self {
            snapshot,
            plane,
            tolerance,
            source_to_project,
            next_part: 0,
            segments: Vec::new(),
        })
    }

    /// Next deterministic content-addressed partition required by the operation.
    #[must_use]
    pub fn expected_part(&self) -> Option<&SectionTopologyPart> {
        self.snapshot.parts.get(self.next_part)
    }

    /// Advances only when the placed source AABB cannot meet the project-world plane.
    pub fn skip_if_disjoint(&mut self, part_id: &str) -> Result<bool, SectionTopologyStoreError> {
        let expected =
            self.expected_part()
                .ok_or(SectionTopologyStoreError::UnexpectedPartition {
                    expected_part_id: "<complete>".to_owned(),
                    actual_part_id: part_id.to_owned(),
                })?;
        if expected.part_id != part_id {
            return Err(SectionTopologyStoreError::UnexpectedPartition {
                expected_part_id: expected.part_id.clone(),
                actual_part_id: part_id.to_owned(),
            });
        }
        let Some(bounds) = expected.bounds else {
            return Ok(false);
        };
        let Some(project_bounds) = transform_section_bounds(bounds, self.source_to_project) else {
            return Ok(false);
        };
        if !section_plane_misses_bounds(self.plane, self.tolerance, project_bounds) {
            return Ok(false);
        }
        self.next_part += 1;
        Ok(true)
    }

    /// Intersects and releases one decoded authoritative topology partition.
    pub fn push(
        &mut self,
        part_id: &str,
        mut partition: SectionTopologyPartitionData,
    ) -> Result<(), SectionTopologyStoreError> {
        let expected =
            self.expected_part()
                .ok_or(SectionTopologyStoreError::UnexpectedPartition {
                    expected_part_id: "<complete>".to_owned(),
                    actual_part_id: part_id.to_owned(),
                })?;
        if expected.part_id != part_id {
            return Err(SectionTopologyStoreError::UnexpectedPartition {
                expected_part_id: expected.part_id.clone(),
                actual_part_id: part_id.to_owned(),
            });
        }
        if partition.topology_hash != expected.topology_hash {
            return Err(SectionTopologyStoreError::PartitionHashMismatch {
                part_id: part_id.to_owned(),
            });
        }
        if self.source_to_project != WorldTransform::IDENTITY {
            transform_section_positions_in_place(&mut partition.positions, self.source_to_project)
                .map_err(AuthoritativeSectionEvaluationError::Section)
                .map_err(SectionTopologyStoreError::Evaluation)?;
        }
        let product = section_open_mesh(
            SectionMeshInput {
                positions: &partition.positions,
                indices: &partition.indices,
                material_slots: partition.material_slots.as_deref(),
                closed_manifold: false,
            },
            self.plane,
            self.tolerance,
        )
        .map_err(AuthoritativeSectionEvaluationError::Section)
        .map_err(SectionTopologyStoreError::Evaluation)?;
        self.segments.extend(product.segments);
        self.next_part += 1;
        Ok(())
    }

    /// Completes the immutable trace or cap only after every partition arrived.
    pub fn finish(self) -> Result<AuthoritativeSectionProduct, SectionTopologyStoreError> {
        if self.next_part != self.snapshot.parts.len() {
            return Err(SectionTopologyStoreError::IncompleteSnapshot);
        }
        finish_authoritative_section_product(
            &self.snapshot.key.entity_id,
            self.snapshot.key.dataset_id.as_deref(),
            &self.snapshot.key.version_hash,
            &self.snapshot.topology_hash,
            self.snapshot.parts,
            &self.snapshot.material_keys,
            self.plane,
            self.tolerance,
            self.segments,
            self.snapshot.closed_manifold,
        )
        .map_err(SectionTopologyStoreError::Evaluation)
    }
}

fn transform_section_bounds(
    bounds: SectionTopologyBounds,
    source_to_project: WorldTransform,
) -> Option<SectionTopologyBounds> {
    let mut minimum = [f64::INFINITY; 3];
    let mut maximum = [f64::NEG_INFINITY; 3];
    for x in [bounds.minimum[0], bounds.maximum[0]] {
        for y in [bounds.minimum[1], bounds.maximum[1]] {
            for z in [bounds.minimum[2], bounds.maximum[2]] {
                let point = source_to_project.transform_point(WorldVec3 { x, y, z })?;
                for (axis, value) in [point.x, point.y, point.z].into_iter().enumerate() {
                    minimum[axis] = minimum[axis].min(value);
                    maximum[axis] = maximum[axis].max(value);
                }
            }
        }
    }
    minimum
        .iter()
        .chain(&maximum)
        .all(|value| value.is_finite())
        .then_some(SectionTopologyBounds { minimum, maximum })
}

fn section_plane_misses_bounds(
    plane: SectionPlane,
    tolerance: f64,
    bounds: crate::SectionTopologyBounds,
) -> bool {
    if !tolerance.is_finite() || tolerance <= 0.0 {
        return false;
    }
    let normal = [plane.normal.x, plane.normal.y, plane.normal.z];
    let length = normal.iter().map(|value| value * value).sum::<f64>().sqrt();
    if !length.is_finite() || length <= f64::EPSILON {
        return false;
    }
    let normal = normal.map(|value| value / length);
    let center: [f64; 3] =
        std::array::from_fn(|axis| bounds.minimum[axis] * 0.5 + bounds.maximum[axis] * 0.5);
    let extent: [f64; 3] =
        std::array::from_fn(|axis| bounds.maximum[axis] * 0.5 - bounds.minimum[axis] * 0.5);
    if center.iter().chain(&extent).any(|value| !value.is_finite()) {
        return false;
    }
    let origin = [plane.origin.x, plane.origin.y, plane.origin.z];
    let distance = (0..3)
        .map(|axis| normal[axis] * (center[axis] - origin[axis]))
        .sum::<f64>();
    let radius = (0..3)
        .map(|axis| normal[axis].abs() * extent[axis])
        .sum::<f64>();
    if !distance.is_finite() || !radius.is_finite() {
        return false;
    }
    distance.abs() > radius + tolerance
}

/// Project/provider-owned registry of complete immutable topology manifests.
///
/// Publishing is atomic because validation finishes before the keyed snapshot is
/// replaced. Evaluation resolves one part at a time and retains only intersection
/// segments, never the complete large mesh or the viewer's resident tile set.
#[derive(Debug, Default)]
pub struct AuthoritativeSectionTopologyStore {
    snapshots: BTreeMap<SectionTopologySnapshotKey, SectionTopologySnapshot>,
}

impl AuthoritativeSectionTopologyStore {
    /// Creates an empty project topology registry.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            snapshots: BTreeMap::new(),
        }
    }

    /// Atomically publishes a validated immutable revision.
    pub fn publish(
        &mut self,
        snapshot: SectionTopologySnapshot,
    ) -> Option<SectionTopologySnapshot> {
        self.snapshots.insert(snapshot.key.clone(), snapshot)
    }

    /// Removes one exact revision without affecting newer or older revisions.
    pub fn remove(&mut self, key: &SectionTopologySnapshotKey) -> Option<SectionTopologySnapshot> {
        self.snapshots.remove(key)
    }

    /// Returns one exact immutable revision manifest.
    #[must_use]
    pub fn get(&self, key: &SectionTopologySnapshotKey) -> Option<&SectionTopologySnapshot> {
        self.snapshots.get(key)
    }

    /// Evaluates a complete cross-partition section independently of render residency.
    ///
    /// `load` must resolve the descriptor from the project's immutable object store.
    /// Each returned partition is dropped before the next descriptor is requested.
    pub fn evaluate<F>(
        &self,
        key: &SectionTopologySnapshotKey,
        plane: SectionPlane,
        tolerance: f64,
        load: F,
    ) -> Result<AuthoritativeSectionProduct, SectionTopologyStoreError>
    where
        F: FnMut(
            &SectionTopologyPart,
        ) -> Result<SectionTopologyPartitionData, SectionTopologyLoadError>,
    {
        self.evaluate_with_transform(key, plane, tolerance, WorldTransform::IDENTITY, load)
    }

    /// Evaluates a complete section after placing source topology in project world.
    pub fn evaluate_with_transform<F>(
        &self,
        key: &SectionTopologySnapshotKey,
        plane: SectionPlane,
        tolerance: f64,
        source_to_project: WorldTransform,
        mut load: F,
    ) -> Result<AuthoritativeSectionProduct, SectionTopologyStoreError>
    where
        F: FnMut(
            &SectionTopologyPart,
        ) -> Result<SectionTopologyPartitionData, SectionTopologyLoadError>,
    {
        let snapshot = self
            .snapshots
            .get(key)
            .ok_or(SectionTopologyStoreError::SnapshotNotFound)?;
        let mut evaluation = AuthoritativeSectionAccumulator::new_with_transform(
            snapshot.clone(),
            plane,
            tolerance,
            source_to_project,
        )?;
        while let Some(descriptor) = evaluation.expected_part().cloned() {
            if evaluation.skip_if_disjoint(&descriptor.part_id)? {
                continue;
            }
            let partition =
                load(&descriptor).map_err(|error| SectionTopologyStoreError::PartitionLoad {
                    part_id: descriptor.part_id.clone(),
                    message: error.message,
                })?;
            evaluation.push(&descriptor.part_id, partition)?;
        }
        evaluation.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AuthoritativeSectionAccumulator, AuthoritativeSectionTopologyStore,
        SectionTopologyPartitionData, SectionTopologySnapshot, SectionTopologySnapshotKey,
        SectionTopologyStoreError,
    };
    use crate::{
        SectionPlane, SectionTopologyBounds, SectionTopologyPart, WorldTransform, WorldVec3,
    };
    use std::cell::Cell;
    use std::collections::BTreeMap;

    fn point(x: f64, y: f64, z: f64) -> WorldVec3 {
        WorldVec3 { x, y, z }
    }

    fn cube_parts() -> BTreeMap<String, SectionTopologyPartitionData> {
        let positions = vec![
            point(-1.0, -1.0, -1.0),
            point(1.0, -1.0, -1.0),
            point(1.0, 1.0, -1.0),
            point(-1.0, 1.0, -1.0),
            point(-1.0, -1.0, 1.0),
            point(1.0, -1.0, 1.0),
            point(1.0, 1.0, 1.0),
            point(-1.0, 1.0, 1.0),
        ];
        let triangles = [
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 1, 5],
            [0, 5, 4],
            [1, 2, 6],
            [1, 6, 5],
            [2, 3, 7],
            [2, 7, 6],
            [3, 0, 4],
            [3, 4, 7],
        ];
        let mut result = BTreeMap::new();
        for (part_id, range) in [("left", 0..6), ("right", 6..12)] {
            result.insert(
                part_id.to_owned(),
                SectionTopologyPartitionData {
                    topology_hash: format!("{part_id}-hash"),
                    positions: positions.clone(),
                    indices: triangles[range]
                        .iter()
                        .flat_map(|triangle| triangle.iter().copied())
                        .collect(),
                    material_slots: Some(vec![0; 6]),
                },
            );
        }
        result
    }

    fn snapshot() -> SectionTopologySnapshot {
        SectionTopologySnapshot::new(
            SectionTopologySnapshotKey {
                entity_id: "entity:building".to_owned(),
                dataset_id: Some("dataset:ifc".to_owned()),
                version_hash: "entity-v7".to_owned(),
            },
            "complete-topology-v7".to_owned(),
            vec![
                SectionTopologyPart {
                    part_id: "right".to_owned(),
                    topology_hash: "right-hash".to_owned(),
                    bounds: None,
                },
                SectionTopologyPart {
                    part_id: "left".to_owned(),
                    topology_hash: "left-hash".to_owned(),
                    bounds: None,
                },
            ],
            BTreeMap::from([(0, "material:concrete".to_owned())]),
            true,
        )
        .expect("valid snapshot")
    }

    fn open_tin_snapshot() -> SectionTopologySnapshot {
        SectionTopologySnapshot::new(
            SectionTopologySnapshotKey {
                entity_id: "entity:road-dgm".to_owned(),
                dataset_id: Some("dataset:road-dgm-v3".to_owned()),
                version_hash: "entity-v3".to_owned(),
            },
            "complete-open-tin-v3".to_owned(),
            vec![
                SectionTopologyPart {
                    part_id: "right".to_owned(),
                    topology_hash: "right-open-hash".to_owned(),
                    bounds: None,
                },
                SectionTopologyPart {
                    part_id: "left".to_owned(),
                    topology_hash: "left-open-hash".to_owned(),
                    bounds: None,
                },
            ],
            BTreeMap::new(),
            false,
        )
        .expect("valid open TIN snapshot")
    }

    fn open_tin_parts() -> BTreeMap<String, SectionTopologyPartitionData> {
        let quad = |x_min: f64, x_max: f64, hash: &str| SectionTopologyPartitionData {
            topology_hash: hash.to_owned(),
            positions: vec![
                point(x_min, -1.0, -1.0),
                point(x_max, -1.0, -1.0),
                point(x_max, 1.0, 1.0),
                point(x_min, 1.0, 1.0),
            ],
            indices: vec![0, 1, 2, 0, 2, 3],
            material_slots: None,
        };
        BTreeMap::from([
            ("left".to_owned(), quad(-1.0, 0.0, "left-open-hash")),
            ("right".to_owned(), quad(0.0, 1.0, "right-open-hash")),
        ])
    }

    fn single_open_part_snapshot(bounds: Option<SectionTopologyBounds>) -> SectionTopologySnapshot {
        SectionTopologySnapshot::new(
            SectionTopologySnapshotKey {
                entity_id: "entity:placed-dgm".to_owned(),
                dataset_id: Some("dataset:placed-dgm".to_owned()),
                version_hash: "entity-placed-v1".to_owned(),
            },
            "complete-placed-dgm".to_owned(),
            vec![SectionTopologyPart {
                part_id: "part".to_owned(),
                topology_hash: "part-hash".to_owned(),
                bounds,
            }],
            BTreeMap::new(),
            false,
        )
        .expect("valid placed snapshot")
    }

    fn sloped_quad() -> SectionTopologyPartitionData {
        SectionTopologyPartitionData {
            topology_hash: "part-hash".to_owned(),
            positions: vec![
                point(-1.0, -1.0, -1.0),
                point(1.0, -1.0, -1.0),
                point(1.0, 1.0, 1.0),
                point(-1.0, 1.0, 1.0),
            ],
            indices: vec![0, 1, 2, 0, 2, 3],
            material_slots: None,
        }
    }

    fn rotated_nonuniform_transform() -> WorldTransform {
        WorldTransform([
            0.0, 2.0, 0.0, 0.0, -3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 4.0, 0.0, 10.0, 20.0, 30.0, 1.0,
        ])
    }

    #[test]
    fn evaluates_complete_snapshot_one_partition_at_a_time() {
        let snapshot = snapshot();
        assert_eq!(snapshot.parts()[0].part_id, "left");
        let key = snapshot.key().clone();
        let mut store = AuthoritativeSectionTopologyStore::new();
        store.publish(snapshot);
        let parts = cube_parts();
        let active_loads = Cell::new(0_u32);
        let maximum_active = Cell::new(0_u32);
        let product = store
            .evaluate(
                &key,
                SectionPlane {
                    origin: point(0.0, 0.0, 0.0),
                    normal: point(0.0, 0.0, 1.0),
                },
                1.0e-9,
                |descriptor| {
                    active_loads.set(active_loads.get() + 1);
                    maximum_active.set(maximum_active.get().max(active_loads.get()));
                    let loaded = parts
                        .get(&descriptor.part_id)
                        .expect("declared part")
                        .clone();
                    active_loads.set(active_loads.get() - 1);
                    Ok(loaded)
                },
            )
            .expect("complete section");

        assert_eq!(maximum_active.get(), 1);
        assert_eq!(product.source.parts[0].part_id, "left");
        assert_eq!(product.source.parts[1].part_id, "right");
        assert_eq!(product.product.regions.len(), 1);
        assert_eq!(
            product.material_regions[0].material_key,
            "material:concrete"
        );
    }

    #[test]
    fn evaluates_exact_open_tin_trace_across_non_resident_partition_boundary() {
        let snapshot = open_tin_snapshot();
        assert_eq!(snapshot.parts()[0].part_id, "left");
        let key = snapshot.key().clone();
        let mut store = AuthoritativeSectionTopologyStore::new();
        store.publish(snapshot);
        let parts = open_tin_parts();
        let loaded = Cell::new(0_u32);
        let product = store
            .evaluate(
                &key,
                SectionPlane {
                    origin: point(0.0, 0.0, 0.0),
                    normal: point(0.0, 0.0, 1.0),
                },
                1.0e-9,
                |descriptor| {
                    loaded.set(loaded.get() + 1);
                    Ok(parts
                        .get(&descriptor.part_id)
                        .expect("declared part")
                        .clone())
                },
            )
            .expect("complete open TIN trace");

        assert_eq!(loaded.get(), 2);
        assert!(!product.source.closed_manifold);
        assert!(product.product.regions.is_empty());
        assert!(product.material_regions.is_empty());
        let length = product
            .product
            .segments
            .iter()
            .map(|segment| {
                let dx = segment.end.x - segment.start.x;
                let dy = segment.end.y - segment.start.y;
                let dz = segment.end.z - segment.start.z;
                dx.mul_add(dx, dy.mul_add(dy, dz * dz)).sqrt()
            })
            .sum::<f64>();
        assert!((length - 2.0).abs() < 1.0e-9);
        assert!(product
            .product
            .segments
            .iter()
            .any(|segment| { segment.start.x.abs() < 1.0e-9 || segment.end.x.abs() < 1.0e-9 }));
    }

    #[test]
    fn explicit_transform_translates_source_partition_into_project_section_plane() {
        let snapshot = single_open_part_snapshot(None);
        let plane = SectionPlane {
            origin: point(0.0, 0.0, 10.0),
            normal: point(0.0, 0.0, 1.0),
        };
        let source_to_project = WorldTransform([
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 10.0, 1.0,
        ]);
        let mut evaluation = AuthoritativeSectionAccumulator::new_with_transform(
            snapshot,
            plane,
            1.0e-9,
            source_to_project,
        )
        .expect("valid translation");
        evaluation
            .push("part", sloped_quad())
            .expect("translated partition");
        let product = evaluation.finish().expect("translated section");

        let length = product
            .product
            .segments
            .iter()
            .map(|segment| {
                let dx = segment.end.x - segment.start.x;
                let dy = segment.end.y - segment.start.y;
                let dz = segment.end.z - segment.start.z;
                dx.mul_add(dx, dy.mul_add(dy, dz * dz)).sqrt()
            })
            .sum::<f64>();
        assert!((length - 2.0).abs() < 1.0e-9);
        assert!(product.product.segments.iter().all(|segment| {
            [segment.start, segment.end]
                .iter()
                .all(|position| position.y.abs() < 1.0e-9 && (position.z - 10.0).abs() < 1.0e-9)
        }));
    }

    #[test]
    fn explicit_transform_rotates_and_nonuniformly_scales_project_section_result() {
        let snapshot = single_open_part_snapshot(None);
        let plane = SectionPlane {
            origin: point(0.0, 0.0, 30.0),
            normal: point(0.0, 0.0, 1.0),
        };
        let mut evaluation = AuthoritativeSectionAccumulator::new_with_transform(
            snapshot,
            plane,
            1.0e-9,
            rotated_nonuniform_transform(),
        )
        .expect("valid rotated non-uniform transform");
        evaluation
            .push("part", sloped_quad())
            .expect("placed partition");
        let product = evaluation.finish().expect("placed section");

        let length = product
            .product
            .segments
            .iter()
            .map(|segment| {
                let dx = segment.end.x - segment.start.x;
                let dy = segment.end.y - segment.start.y;
                let dz = segment.end.z - segment.start.z;
                dx.mul_add(dx, dy.mul_add(dy, dz * dz)).sqrt()
            })
            .sum::<f64>();
        assert!((length - 4.0).abs() < 1.0e-9);
        assert!(product.product.segments.iter().all(|segment| {
            [segment.start, segment.end].iter().all(|position| {
                (position.x - 10.0).abs() < 1.0e-9
                    && (position.z - 30.0).abs() < 1.0e-9
                    && (18.0 - 1.0e-9..=22.0 + 1.0e-9).contains(&position.y)
            })
        }));
    }

    #[test]
    fn transformed_source_bounds_cull_only_project_disjoint_partitions() {
        let bounded_part =
            |part_id: &str, topology_hash: &str, y_min: f64, y_max: f64| SectionTopologyPart {
                part_id: part_id.to_owned(),
                topology_hash: topology_hash.to_owned(),
                bounds: Some(SectionTopologyBounds {
                    minimum: [0.0, y_min, -1.0],
                    maximum: [1.0, y_max, 1.0],
                }),
            };
        let snapshot = SectionTopologySnapshot::new(
            SectionTopologySnapshotKey {
                entity_id: "entity:placed-large-dgm".to_owned(),
                dataset_id: Some("dataset:placed-large-dgm".to_owned()),
                version_hash: "entity-placed-v1".to_owned(),
            },
            "complete-placed-large-dgm".to_owned(),
            vec![
                bounded_part("a-distant", "a-hash", 2.0, 3.0),
                bounded_part("b-intersecting", "b-hash", -1.0, 1.0),
                bounded_part("c-distant", "c-hash", -3.0, -2.0),
            ],
            BTreeMap::new(),
            false,
        )
        .expect("valid transformed-bounds snapshot");
        let key = snapshot.key().clone();
        let mut store = AuthoritativeSectionTopologyStore::new();
        store.publish(snapshot);
        let loaded = Cell::new(0_u32);
        let product = store
            .evaluate_with_transform(
                &key,
                SectionPlane {
                    origin: point(10.0, 0.0, 0.0),
                    normal: point(1.0, 0.0, 0.0),
                },
                1.0e-9,
                rotated_nonuniform_transform(),
                |descriptor| {
                    loaded.set(loaded.get() + 1);
                    assert_eq!(descriptor.part_id, "b-intersecting");
                    Ok(SectionTopologyPartitionData {
                        topology_hash: "b-hash".to_owned(),
                        positions: vec![
                            point(0.0, -1.0, -1.0),
                            point(0.0, 1.0, 1.0),
                            point(1.0, 1.0, 1.0),
                        ],
                        indices: vec![0, 1, 2],
                        material_slots: None,
                    })
                },
            )
            .expect("project-space bounded section");

        assert_eq!(loaded.get(), 1);
        assert_eq!(product.source.parts.len(), 3);
        assert!(!product.product.segments.is_empty());
        assert!(product.product.segments.iter().all(|segment| {
            (segment.start.x - 10.0).abs() < 1.0e-9 && (segment.end.x - 10.0).abs() < 1.0e-9
        }));
    }

    #[test]
    fn canonical_bounds_skip_distant_partitions_without_loading_buffers() {
        let bounded_part =
            |part_id: &str, topology_hash: &str, z_min: f64, z_max: f64| SectionTopologyPart {
                part_id: part_id.to_owned(),
                topology_hash: topology_hash.to_owned(),
                bounds: Some(SectionTopologyBounds {
                    minimum: [-1.0, -1.0, z_min],
                    maximum: [1.0, 1.0, z_max],
                }),
            };
        let snapshot = SectionTopologySnapshot::new(
            SectionTopologySnapshotKey {
                entity_id: "entity:large-dgm".to_owned(),
                dataset_id: Some("dataset:large-dgm".to_owned()),
                version_hash: "entity-v1".to_owned(),
            },
            "complete-large-dgm".to_owned(),
            vec![
                bounded_part("a-distant", "a-hash", 100.0, 200.0),
                bounded_part("b-intersecting", "b-hash", -1.0, 1.0),
                bounded_part("c-distant", "c-hash", -200.0, -100.0),
            ],
            BTreeMap::new(),
            false,
        )
        .expect("valid bounded snapshot");
        let key = snapshot.key().clone();
        let mut store = AuthoritativeSectionTopologyStore::new();
        store.publish(snapshot);
        let loaded = Cell::new(0_u32);
        let product = store
            .evaluate(
                &key,
                SectionPlane {
                    origin: point(0.0, 0.0, 0.0),
                    normal: point(0.0, 0.0, 1.0),
                },
                1.0e-9,
                |descriptor| {
                    loaded.set(loaded.get() + 1);
                    assert_eq!(descriptor.part_id, "b-intersecting");
                    Ok(SectionTopologyPartitionData {
                        topology_hash: "b-hash".to_owned(),
                        positions: vec![
                            point(-1.0, 0.0, -1.0),
                            point(1.0, 0.0, 1.0),
                            point(0.0, 1.0, 1.0),
                        ],
                        indices: vec![0, 1, 2],
                        material_slots: None,
                    })
                },
            )
            .expect("bounded exact section");

        assert_eq!(loaded.get(), 1);
        assert_eq!(product.source.parts.len(), 3);
        assert!(!product.product.segments.is_empty());
    }

    #[test]
    fn rejects_non_finite_or_reversed_canonical_partition_bounds() {
        let invalid = |bounds: SectionTopologyBounds| {
            SectionTopologySnapshot::new(
                SectionTopologySnapshotKey {
                    entity_id: "entity:dgm".to_owned(),
                    dataset_id: None,
                    version_hash: "v1".to_owned(),
                },
                "topology".to_owned(),
                vec![SectionTopologyPart {
                    part_id: "part".to_owned(),
                    topology_hash: "hash".to_owned(),
                    bounds: Some(bounds),
                }],
                BTreeMap::new(),
                false,
            )
        };
        assert_eq!(
            invalid(SectionTopologyBounds {
                minimum: [0.0, f64::NAN, 0.0],
                maximum: [1.0, 1.0, 1.0],
            }),
            Err(SectionTopologyStoreError::InvalidSnapshot)
        );
        assert_eq!(
            invalid(SectionTopologyBounds {
                minimum: [2.0, 0.0, 0.0],
                maximum: [1.0, 1.0, 1.0],
            }),
            Err(SectionTopologyStoreError::InvalidSnapshot)
        );

        let extreme = SectionTopologySnapshot::new(
            SectionTopologySnapshotKey {
                entity_id: "entity:extreme".to_owned(),
                dataset_id: None,
                version_hash: "v1".to_owned(),
            },
            "topology".to_owned(),
            vec![SectionTopologyPart {
                part_id: "part".to_owned(),
                topology_hash: "hash".to_owned(),
                bounds: Some(SectionTopologyBounds {
                    minimum: [1.0e308, 0.0, 0.0],
                    maximum: [1.0e308, 1.0, 1.0],
                }),
            }],
            BTreeMap::new(),
            false,
        )
        .expect("finite extreme bounds remain valid");
        let mut evaluation = AuthoritativeSectionAccumulator::new(
            extreme,
            SectionPlane {
                origin: point(1.0e308, 0.0, 0.0),
                normal: point(1.0, 0.0, 0.0),
            },
            1.0e-9,
        );
        assert!(!evaluation
            .skip_if_disjoint("part")
            .expect("overflow-safe conservative classification"));
    }

    #[test]
    fn incremental_evaluator_rejects_out_of_order_and_incomplete_partitions() {
        let snapshot = open_tin_snapshot();
        let plane = SectionPlane {
            origin: point(0.0, 0.0, 0.0),
            normal: point(0.0, 0.0, 1.0),
        };
        let mut parts = open_tin_parts();
        let mut evaluation = AuthoritativeSectionAccumulator::new(snapshot.clone(), plane, 1.0e-9);
        let error = evaluation
            .push("right", parts.remove("right").expect("right part"))
            .expect_err("manifest order is authoritative");
        assert!(matches!(
            error,
            SectionTopologyStoreError::UnexpectedPartition {
                ref expected_part_id,
                ref actual_part_id,
            } if expected_part_id == "left" && actual_part_id == "right"
        ));

        let mut evaluation = AuthoritativeSectionAccumulator::new(snapshot, plane, 1.0e-9);
        evaluation
            .push("left", parts.remove("left").expect("left part"))
            .expect("first part");
        assert_eq!(
            evaluation.finish(),
            Err(SectionTopologyStoreError::IncompleteSnapshot)
        );
    }

    #[test]
    fn rejects_loaded_partition_that_does_not_match_manifest() {
        let snapshot = snapshot();
        let key = snapshot.key().clone();
        let mut store = AuthoritativeSectionTopologyStore::new();
        store.publish(snapshot);
        let error = store
            .evaluate(
                &key,
                SectionPlane {
                    origin: point(0.0, 0.0, 0.0),
                    normal: point(0.0, 0.0, 1.0),
                },
                1.0e-9,
                |_| {
                    Ok(SectionTopologyPartitionData {
                        topology_hash: "wrong".to_owned(),
                        positions: vec![point(0.0, 0.0, 0.0)],
                        indices: vec![0, 0, 0],
                        material_slots: None,
                    })
                },
            )
            .expect_err("hash mismatch");
        assert!(matches!(
            error,
            SectionTopologyStoreError::PartitionHashMismatch { ref part_id }
                if part_id == "left"
        ));
    }

    #[test]
    fn publish_replaces_only_the_exact_revision_key() {
        let snapshot = snapshot();
        let key = snapshot.key().clone();
        let mut store = AuthoritativeSectionTopologyStore::new();
        assert!(store.publish(snapshot.clone()).is_none());
        assert_eq!(store.publish(snapshot), store.get(&key).cloned());
        assert!(store.remove(&key).is_some());
        assert!(store.get(&key).is_none());
    }
}
