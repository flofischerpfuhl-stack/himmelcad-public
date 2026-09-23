//! Renderer-neutral prepared hierarchy, tile, and decoded-feature contracts.

#![deny(missing_docs, rust_2018_idioms, unsafe_op_in_unsafe_fn)]
#![forbid(unsafe_code)]

use glam::{DMat3, DMat4, DVec3, DVec4};
use serde::{Deserialize, Serialize};

#[allow(missing_docs)]
pub mod dense;
mod hierarchy;
#[allow(missing_docs)]
pub mod mesh_tiler;
#[allow(missing_docs)]
pub mod mvs_scene;
mod potree;
#[allow(missing_docs)]
pub mod prepared_triangle_mesh;
#[allow(missing_docs)]
pub mod prepared_triangle_mesh_ply;
#[allow(missing_docs)]
pub mod raster;
#[allow(missing_docs)]
pub mod splat_tiler;
#[allow(missing_docs)]
pub mod viewer_raster_manifest;
#[allow(missing_docs)]
pub mod viewer_raster_surface_manifest;

pub use hierarchy::{PreparedHierarchyError, PreparedHierarchyManifest, PreparedHierarchySource};
pub use potree::{
    DecodedPotreePoints, PackedCivilPointAttributes, PotreeAttributeLayout, PotreeAttributeType,
    PotreeDecodeError, PotreeHierarchyError, PotreeHierarchySource, PotreePointLayout,
    PotreePointMetadata,
};

/// Maximum points decoded from one independently streamed point leaf.
pub(crate) const MAX_POINT_COUNT: usize = 16_000_000;

/// Stable identity of one streamable dataset in a render world.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DatasetId(pub String);

/// Provider-local identity of one hierarchy node.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TileId(pub String);

/// Three-dimensional f64 vector in project-world coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldVec3 {
    /// X or easting component.
    pub x: f64,
    /// Y or northing component.
    pub y: f64,
    /// Z or height component.
    pub z: f64,
}

/// Axis-aligned f64 bounds in project-world coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldAabb {
    /// Inclusive minimum corner.
    pub min: WorldVec3,
    /// Inclusive maximum corner.
    pub max: WorldVec3,
}

/// Column-major affine transform from content coordinates into project world coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WorldTransform(pub [f64; 16]);

impl WorldTransform {
    /// Identity content-to-world transform.
    pub const IDENTITY: Self = Self([
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ]);

    /// Creates one finite project-world translation.
    #[must_use]
    pub fn from_translation(translation: WorldVec3) -> Option<Self> {
        if !finite_world(translation) {
            return None;
        }
        Some(Self([
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            translation.x,
            translation.y,
            translation.z,
            1.0,
        ]))
    }

    /// Whether this is a finite, invertible affine transform.
    #[must_use]
    pub fn is_invertible_affine(self) -> bool {
        let matrix = DMat4::from_cols_array(&self.0);
        matrix.is_finite()
            && self.0[3].abs() <= f64::EPSILON
            && self.0[7].abs() <= f64::EPSILON
            && self.0[11].abs() <= f64::EPSILON
            && (self.0[15] - 1.0).abs() <= f64::EPSILON
            && matrix.determinant().is_finite()
            && matrix.determinant().abs() > f64::EPSILON
    }

    /// Applies this affine transform to one position.
    #[must_use]
    pub fn transform_point(self, point: WorldVec3) -> Option<WorldVec3> {
        if !self.is_invertible_affine() {
            return None;
        }
        let value = DMat4::from_cols_array(&self.0) * DVec4::new(point.x, point.y, point.z, 1.0);
        (value.is_finite() && value.w.abs() > f64::EPSILON).then(|| WorldVec3 {
            x: value.x / value.w,
            y: value.y / value.w,
            z: value.z / value.w,
        })
    }

    /// Applies only the linear part to one direction or offset.
    #[must_use]
    pub fn transform_vector(self, vector: WorldVec3) -> Option<WorldVec3> {
        if !self.is_invertible_affine() {
            return None;
        }
        let value = DMat3::from_mat4(DMat4::from_cols_array(&self.0))
            * DVec3::new(vector.x, vector.y, vector.z);
        value.is_finite().then_some(WorldVec3 {
            x: value.x,
            y: value.y,
            z: value.z,
        })
    }

    /// Returns `self * inner`, preserving the documented local-to-world order.
    #[must_use]
    pub fn compose(self, inner: Self) -> Option<Self> {
        if !self.is_invertible_affine() || !inner.is_invertible_affine() {
            return None;
        }
        let result = Self(
            (DMat4::from_cols_array(&self.0) * DMat4::from_cols_array(&inner.0)).to_cols_array(),
        );
        result.is_invertible_affine().then_some(result)
    }

    /// Inverts one affine local-to-world transform.
    #[must_use]
    pub fn inverse(self) -> Option<Self> {
        if !self.is_invertible_affine() {
            return None;
        }
        let result = Self(DMat4::from_cols_array(&self.0).inverse().to_cols_array());
        result.is_invertible_affine().then_some(result)
    }

    /// Conservative maximum length scale, including rotation, shear and non-uniform scale.
    #[must_use]
    pub fn maximum_linear_scale(self) -> Option<f64> {
        if !self.is_invertible_affine() {
            return None;
        }
        let values = DMat3::from_mat4(DMat4::from_cols_array(&self.0)).to_cols_array();
        let maximum_column_sum = (0..3)
            .map(|column| (0..3).map(|row| values[column * 3 + row].abs()).sum())
            .fold(0.0_f64, f64::max);
        let maximum_row_sum = (0..3)
            .map(|row| (0..3).map(|column| values[column * 3 + row].abs()).sum())
            .fold(0.0_f64, f64::max);
        let scale = (maximum_column_sum * maximum_row_sum).sqrt();
        (scale.is_finite() && scale > 0.0).then_some(scale)
    }
}

impl Default for WorldTransform {
    fn default() -> Self {
        Self::IDENTITY
    }
}

/// Provider-supplied spatial bound used before content is resident.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BoundingVolume {
    /// Axis-aligned project-world bounds.
    AxisAlignedBox {
        /// Axis-aligned bounds.
        bounds: WorldAabb,
    },
    /// Oriented box with three half-axis vectors.
    OrientedBox {
        /// Box center in project-world coordinates.
        center: WorldVec3,
        /// Column-major X/Y/Z half-axis vectors.
        half_axes: [WorldVec3; 3],
    },
    /// Bounding sphere.
    Sphere {
        /// Sphere center in project-world coordinates.
        center: WorldVec3,
        /// Sphere radius in project units.
        radius: f64,
    },
    /// 3D Tiles geodetic region in radians and metres.
    GeodeticRegion {
        /// Western longitude in radians.
        west: f64,
        /// Southern latitude in radians.
        south: f64,
        /// Eastern longitude in radians.
        east: f64,
        /// Northern latitude in radians.
        north: f64,
        /// Minimum ellipsoidal height in metres.
        minimum_height: f64,
        /// Maximum ellipsoidal height in metres.
        maximum_height: f64,
    },
}

impl BoundingVolume {
    /// Returns a deterministic f64 world anchor owned by this spatial bound.
    #[must_use]
    pub fn stable_anchor(&self) -> Option<WorldVec3> {
        let anchor = match self {
            Self::AxisAlignedBox { bounds } => {
                if !finite_world(bounds.min)
                    || !finite_world(bounds.max)
                    || bounds.min.x > bounds.max.x
                    || bounds.min.y > bounds.max.y
                    || bounds.min.z > bounds.max.z
                {
                    return None;
                }
                WorldVec3 {
                    x: bounds.min.x + (bounds.max.x - bounds.min.x) * 0.5,
                    y: bounds.min.y + (bounds.max.y - bounds.min.y) * 0.5,
                    z: bounds.min.z + (bounds.max.z - bounds.min.z) * 0.5,
                }
            }
            Self::OrientedBox { center, half_axes } => {
                if !finite_world(*center) || half_axes.iter().any(|axis| !finite_world(*axis)) {
                    return None;
                }
                *center
            }
            Self::Sphere { center, radius } => {
                if !finite_world(*center) || !radius.is_finite() || *radius < 0.0 {
                    return None;
                }
                *center
            }
            Self::GeodeticRegion {
                west,
                south,
                east,
                north,
                minimum_height,
                maximum_height,
            } => {
                if [
                    *west,
                    *south,
                    *east,
                    *north,
                    *minimum_height,
                    *maximum_height,
                ]
                .iter()
                .any(|value| !value.is_finite())
                    || !(-std::f64::consts::PI..=std::f64::consts::PI).contains(west)
                    || !(-std::f64::consts::PI..=std::f64::consts::PI).contains(east)
                    || !(-std::f64::consts::FRAC_PI_2..=std::f64::consts::FRAC_PI_2).contains(south)
                    || !(-std::f64::consts::FRAC_PI_2..=std::f64::consts::FRAC_PI_2).contains(north)
                    || south > north
                    || minimum_height > maximum_height
                {
                    return None;
                }
                let mut sum = DVec3::ZERO;
                for longitude in [*west, *east] {
                    for latitude in [*south, *north] {
                        for height in [*minimum_height, *maximum_height] {
                            sum += geodetic_to_ecef(longitude, latitude, height);
                        }
                    }
                }
                let center = sum / 8.0;
                WorldVec3 {
                    x: center.x,
                    y: center.y,
                    z: center.z,
                }
            }
        };
        finite_world(anchor).then_some(anchor)
    }
}

fn geodetic_to_ecef(longitude: f64, latitude: f64, height: f64) -> DVec3 {
    const SEMI_MAJOR: f64 = 6_378_137.0;
    const ECCENTRICITY_SQUARED: f64 = 6.694_379_990_14e-3;
    let sin_latitude = latitude.sin();
    let cos_latitude = latitude.cos();
    let normal = SEMI_MAJOR / (1.0 - ECCENTRICITY_SQUARED * sin_latitude * sin_latitude).sqrt();
    DVec3::new(
        (normal + height) * cos_latitude * longitude.cos(),
        (normal + height) * cos_latitude * longitude.sin(),
        (normal * (1.0 - ECCENTRICITY_SQUARED) + height) * sin_latitude,
    )
}

fn finite_world(value: WorldVec3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

/// Hierarchy refinement semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefinementMode {
    /// Children add detail while the selected parent remains visible.
    Add,
    /// Fully resident selected children replace their parent.
    Replace,
}

/// Decoded content class. It selects a decoder, not a separate scheduler.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContentKind {
    /// Potree 2.0 point payload.
    PotreePoints,
    /// glTF or GLB mesh payload.
    Gltf,
    /// Legacy or composite 3D Tiles payload requiring container decoding.
    ThreeDTilesContainer,
    /// Raster color or scalar tile.
    Raster,
    /// Gaussian splat payload.
    GaussianSplats,
    /// Directly compiled authored CAD proxy.
    CadProxy,
}

/// Address and expected cost of one tile content payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentReference {
    /// Decoder class.
    pub kind: ContentKind,
    /// Provider-resolvable URI or content-addressed object key.
    pub uri: String,
    /// Byte offset for range-addressed aggregate files.
    pub byte_offset: Option<u64>,
    /// Compressed byte length when known.
    pub byte_length: Option<u64>,
    /// Point, triangle, pixel or splat count when known from hierarchy metadata.
    pub primitive_count: Option<u64>,
    /// Optional immutable content hash.
    pub content_hash: Option<String>,
    /// Versioned decoder-specific parameters retained without scheduler logic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decoder_parameters: Option<serde_json::Value>,
}

/// Camera-independent inputs used to compute one prepared node's projected error.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPointScreenSpaceError {
    /// Conservative world-space error represented by this node.
    pub geometric_error: f64,
    /// Representative sample spacing in source project units.
    pub point_spacing: f64,
}

/// Auditable sampling counts for one immutable prepared point node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPointSampleStatistics {
    /// Exact number of representative points stored in the node payload.
    pub sampled_points: u64,
    /// Exact number of source points considered for the sample when known.
    pub source_points: Option<u64>,
    /// Stable bake-method identifier when emitted by the preparer.
    pub method: Option<String>,
}

/// Origin of prepared-node metadata used by compatibility diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreparedPointMetadataOrigin {
    /// Emitted and validated by the dataset preparation pipeline.
    Baked,
    /// Derived exactly from Potree 2 hierarchy records as pages arrive.
    Potree2Compatibility,
}

/// Generalized bake metadata shared by prepared point providers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPointNodeMetadata {
    /// Camera-independent error inputs.
    pub screen_space_error: PreparedPointScreenSpaceError,
    /// Exact sampling statistics.
    pub sample_statistics: PreparedPointSampleStatistics,
    /// Preserved station identities, when declared.
    pub station_ids: Option<Vec<String>>,
    /// SHA-256 of the exact node payload, when known.
    pub content_hash: Option<String>,
    /// Whether fields were baked or exactly derived.
    pub origin: PreparedPointMetadataOrigin,
}

/// Optional versioned metadata for a prepared point dataset.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPointDatasetMetadata {
    /// Contract version.
    pub schema_version: u16,
    /// SHA-256 of authoritative raw source bytes, when known.
    pub raw_source_content_hash: Option<String>,
    /// Exact per-node bake records.
    pub nodes: std::collections::BTreeMap<String, PreparedPointNodeMetadata>,
}

/// Lazily loaded hierarchy page referenced by a tile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyPageReference {
    /// Provider-resolvable page or external tileset URI.
    pub uri: String,
    /// Byte offset for pages stored in an aggregate file.
    pub byte_offset: Option<u64>,
    /// Byte length for range requests when known.
    pub byte_length: Option<u64>,
    /// Optional immutable hash of the exact page bytes or requested range.
    #[serde(default)]
    pub content_hash: Option<String>,
    /// Versioned provider metadata attached to the hierarchy content itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decoder_parameters: Option<serde_json::Value>,
}

/// Format-neutral hierarchy node consumed by the global selector.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileDescriptor {
    /// Provider-local tile identity.
    pub id: TileId,
    /// Optional parent identity.
    pub parent: Option<TileId>,
    /// Known children.
    pub children: Vec<TileId>,
    /// Conservative world-space bounds.
    pub bounds: BoundingVolume,
    /// Content-local to project-world transform.
    pub content_transform: WorldTransform,
    /// Source geometric error in project units.
    pub geometric_error: f64,
    /// ADD or REPLACE behavior.
    pub refinement: RefinementMode,
    /// Zero or more contents attached to this node.
    pub contents: Vec<ContentReference>,
    /// Optional child hierarchy page.
    pub child_page: Option<HierarchyPageReference>,
    /// Validated preparation metadata for point content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared_point_metadata: Option<PreparedPointNodeMetadata>,
    /// Provider-specific immutable metadata retained for inspection and styling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_metadata: Option<serde_json::Value>,
}

/// Read-only tile hierarchy. Implementations may page descriptors internally.
pub trait HierarchySource {
    /// Provider-specific error.
    type Error;
    /// Dataset identity.
    fn dataset_id(&self) -> &DatasetId;
    /// Root tile identities.
    fn roots(&self) -> &[TileId];
    /// Returns a descriptor, loading hierarchy pages when necessary.
    fn tile(&mut self, id: &TileId) -> Result<Option<TileDescriptor>, Self::Error>;
    /// Returns an immutable shared descriptor for allocation-bounded traversal.
    fn shared_tile(
        &mut self,
        id: &TileId,
    ) -> Result<Option<std::sync::Arc<TileDescriptor>>, Self::Error> {
        self.tile(id).map(|tile| tile.map(std::sync::Arc::new))
    }
}

/// Exact feature result for one source triangle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DecodedTriangleFeatureId {
    /// All triangle vertices identify the same non-null feature.
    Feature(u32),
    /// All triangle vertices carry the declared null feature ID.
    Null,
    /// Vertex IDs disagree, so an exact feature cannot be invented.
    Ambiguous,
    /// The feature set is texture-backed and must be sampled at the hit UV.
    Texture,
}
