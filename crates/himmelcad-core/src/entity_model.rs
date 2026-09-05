//! Canonical entity contracts shared by Builder, `PhotoLab` and `WeltView`.
//!
//! The legacy [`crate::entity::EntityKind`] remains a migration boundary. New
//! entity semantics are expressed through stable type identifiers,
//! representations and typed geometry components.

use serde::{Deserialize, Serialize};

use crate::canonical_resources::{BlockInstanceOverrides, CanonicalResourceRef};
use crate::entity::EntityId;
use crate::hash::ObjectHash;

/// Versioned semantic entity type such as `hcad.area@1`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(transparent)]
pub struct EntityTypeId(pub String);

/// Built-in stable entity type identifiers.
pub mod built_in_type {
    /// Organizational group.
    pub const GROUP: &str = "hcad.group@1";
    /// Presentation and organization layer.
    pub const LAYER: &str = "hcad.layer@1";
    /// Point with optional semantic roles.
    pub const POINT: &str = "hcad.point@1";
    /// Analytic or piecewise curve.
    pub const CURVE: &str = "hcad.curve@1";
    /// Plan-topological area with optionally unresolved heights.
    pub const AREA: &str = "hcad.area@1";
    /// Construction or authored plane.
    pub const PLANE: &str = "hcad.plane@1";
    /// 2.5D height surface.
    pub const ELEVATION_SURFACE: &str = "hcad.elevation-surface@1";
    /// Arbitrary open spatial surface.
    pub const SURFACE_3D: &str = "hcad.surface-3d@1";
    /// Raster image with optional depth, elevation and pose components.
    pub const RASTER_IMAGE: &str = "hcad.raster-image@1";
    /// Streamed point cloud.
    pub const POINT_CLOUD: &str = "hcad.point-cloud@1";
    /// Standalone Gaussian splat cloud.
    pub const GAUSSIAN_SPLAT_CLOUD: &str = "hcad.gaussian-splat-cloud@1";
    /// Positioned panorama.
    pub const PANORAMA: &str = "hcad.panorama@1";
    /// Valid spatial solid.
    pub const OBJECT_3D: &str = "hcad.object-3d@1";
    /// Semantically classified BIM object.
    pub const BIM_OBJECT: &str = "hcad.bim-object@1";
    /// Horizontal/vertical alignment with station-dependent bands and rules.
    pub const ALIGNMENT: &str = "hcad.alignment@1";
    /// Placed instance of a reusable block definition.
    pub const BLOCK: &str = "hcad.block@2";
    /// World- or paper-space text.
    pub const TEXT: &str = "hcad.text@1";
    /// Associative label.
    pub const LABEL: &str = "hcad.label@1";
    /// Associative dimension.
    pub const DIMENSION: &str = "hcad.dimension@1";
    /// Persistent inspection measurement.
    pub const MEASUREMENT: &str = "hcad.measurement@1";
    /// Non-renderable journal-generation marker.
    pub const SNAPSHOT_MARKER: &str = "hcad.snapshot-marker@1";
}

/// Built-in semantic entity types understood by this core schema version.
///
/// Unknown namespaced [`EntityTypeId`] values deliberately remain valid
/// extension points; this enum is only the strict compatibility gate for the
/// built-ins whose geometry semantics are known here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
pub enum BuiltInEntityType {
    #[serde(rename = "hcad.group@1")]
    Group,
    #[serde(rename = "hcad.layer@1")]
    Layer,
    #[serde(rename = "hcad.point@1")]
    Point,
    #[serde(rename = "hcad.curve@1")]
    Curve,
    #[serde(rename = "hcad.area@1")]
    Area,
    #[serde(rename = "hcad.plane@1")]
    Plane,
    #[serde(rename = "hcad.elevation-surface@1")]
    ElevationSurface,
    #[serde(rename = "hcad.surface-3d@1")]
    Surface3d,
    #[serde(rename = "hcad.raster-image@1")]
    RasterImage,
    #[serde(rename = "hcad.point-cloud@1")]
    PointCloud,
    #[serde(rename = "hcad.gaussian-splat-cloud@1")]
    GaussianSplatCloud,
    #[serde(rename = "hcad.panorama@1")]
    Panorama,
    #[serde(rename = "hcad.object-3d@1")]
    Object3d,
    #[serde(rename = "hcad.bim-object@1")]
    BimObject,
    #[serde(rename = "hcad.alignment@1")]
    Alignment,
    #[serde(rename = "hcad.block@2")]
    Block,
    #[serde(rename = "hcad.text@1")]
    Text,
    #[serde(rename = "hcad.label@1")]
    Label,
    #[serde(rename = "hcad.dimension@1")]
    Dimension,
    #[serde(rename = "hcad.measurement@1")]
    Measurement,
    #[serde(rename = "hcad.snapshot-marker@1")]
    SnapshotMarker,
}

impl BuiltInEntityType {
    /// Resolves an exact, versioned built-in identifier.
    #[must_use]
    pub fn from_type_id(type_id: &EntityTypeId) -> Option<Self> {
        Some(match type_id.0.as_str() {
            built_in_type::GROUP => Self::Group,
            built_in_type::LAYER => Self::Layer,
            built_in_type::POINT => Self::Point,
            built_in_type::CURVE => Self::Curve,
            built_in_type::AREA => Self::Area,
            built_in_type::PLANE => Self::Plane,
            built_in_type::ELEVATION_SURFACE => Self::ElevationSurface,
            built_in_type::SURFACE_3D => Self::Surface3d,
            built_in_type::RASTER_IMAGE => Self::RasterImage,
            built_in_type::POINT_CLOUD => Self::PointCloud,
            built_in_type::GAUSSIAN_SPLAT_CLOUD => Self::GaussianSplatCloud,
            built_in_type::PANORAMA => Self::Panorama,
            built_in_type::OBJECT_3D => Self::Object3d,
            built_in_type::BIM_OBJECT => Self::BimObject,
            built_in_type::ALIGNMENT => Self::Alignment,
            built_in_type::BLOCK => Self::Block,
            built_in_type::TEXT => Self::Text,
            built_in_type::LABEL => Self::Label,
            built_in_type::DIMENSION => Self::Dimension,
            built_in_type::MEASUREMENT => Self::Measurement,
            built_in_type::SNAPSHOT_MARKER => Self::SnapshotMarker,
            _ => return None,
        })
    }

    /// Returns the stable type identifier represented by this value.
    #[must_use]
    pub const fn type_id(self) -> &'static str {
        match self {
            Self::Group => built_in_type::GROUP,
            Self::Layer => built_in_type::LAYER,
            Self::Point => built_in_type::POINT,
            Self::Curve => built_in_type::CURVE,
            Self::Area => built_in_type::AREA,
            Self::Plane => built_in_type::PLANE,
            Self::ElevationSurface => built_in_type::ELEVATION_SURFACE,
            Self::Surface3d => built_in_type::SURFACE_3D,
            Self::RasterImage => built_in_type::RASTER_IMAGE,
            Self::PointCloud => built_in_type::POINT_CLOUD,
            Self::GaussianSplatCloud => built_in_type::GAUSSIAN_SPLAT_CLOUD,
            Self::Panorama => built_in_type::PANORAMA,
            Self::Object3d => built_in_type::OBJECT_3D,
            Self::BimObject => built_in_type::BIM_OBJECT,
            Self::Alignment => built_in_type::ALIGNMENT,
            Self::Block => built_in_type::BLOCK,
            Self::Text => built_in_type::TEXT,
            Self::Label => built_in_type::LABEL,
            Self::Dimension => built_in_type::DIMENSION,
            Self::Measurement => built_in_type::MEASUREMENT,
            Self::SnapshotMarker => built_in_type::SNAPSHOT_MARKER,
        }
    }

    /// Whether this built-in is organizational and therefore has no geometry.
    #[must_use]
    pub const fn is_organizational(self) -> bool {
        matches!(self, Self::Group | Self::Layer)
    }

    /// Whether this built-in has no geometry representation.
    #[must_use]
    pub const fn is_non_renderable(self) -> bool {
        matches!(self, Self::Group | Self::Layer | Self::SnapshotMarker)
    }
}

/// Coordinate whose height may be unknown without making XY invalid.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Position {
    /// X or easting.
    pub x: f64,
    /// Y or northing.
    pub y: f64,
    /// Known Z or height. `None` never implies zero.
    pub z: Option<f64>,
}

/// Fully spatial vector used for directions and resolved geometry.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Vector3 {
    /// X component.
    pub x: f64,
    /// Y component.
    pub y: f64,
    /// Z component.
    pub z: f64,
}

/// Explicit plane value embedded in geometry or view state.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PlaneDefinition {
    /// Point on the plane.
    pub origin: Vector3,
    /// Unit-length normal.
    pub normal: Vector3,
}

/// Right-handed entity-local frame used to embed coordinates on a plane.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PlaneFrame {
    /// Entity-local origin of plane coordinates `(0, 0)`.
    pub origin: Vector3,
    /// Unit axis receiving the first plane coordinate.
    pub u_axis: Vector3,
    /// Unit axis receiving the second plane coordinate.
    pub v_axis: Vector3,
}

/// Core curve representations. More domain curves extend this tagged schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CurveGeometry {
    /// Straight segment.
    LineSegment {
        /// First endpoint.
        start: Position,
        /// Second endpoint.
        end: Position,
    },
    /// Piecewise-linear curve.
    Polyline {
        /// Ordered vertices with independently optional heights.
        positions: Vec<Position>,
        /// Whether the last vertex connects to the first.
        closed: bool,
    },
    /// Circular arc defined by three ordered points.
    CircularArc {
        /// Arc start.
        start: Position,
        /// Point lying inside the selected arc span.
        point_on_arc: Position,
        /// Arc end.
        end: Position,
    },
    /// Circle embedded in an optional spatial plane.
    Circle {
        /// Center coordinate.
        center: Position,
        /// Radius in project units.
        radius: f64,
        /// Explicit plane for a spatial circle.
        plane: Option<PlaneDefinition>,
    },
    /// Full ellipse with an oriented semi-major axis.
    Ellipse {
        /// Ellipse center.
        center: Position,
        /// Semi-major axis vector; its length is the semi-major radius.
        major_axis: Vector3,
        /// Positive semi-minor radius in project units.
        minor_radius: f64,
        /// Explicit plane for a spatial ellipse. When absent, the XY plane is used.
        plane: Option<PlaneDefinition>,
    },
    /// Elliptic arc parameterized around an oriented major axis.
    EllipticArc {
        /// Ellipse center.
        center: Position,
        /// Semi-major axis vector; its length is the semi-major radius.
        major_axis: Vector3,
        /// Positive semi-minor radius in project units.
        minor_radius: f64,
        /// Start parameter in radians around the ellipse basis.
        start_parameter: f64,
        /// Signed sweep in radians; magnitudes may exceed one revolution.
        sweep_parameter: f64,
        /// Explicit plane for a spatial arc. When absent, the XY plane is used.
        plane: Option<PlaneDefinition>,
    },
    /// Exact rational quadratic conic arc.
    ///
    /// With unit endpoint weights, control weights below, equal to and above
    /// one represent elliptic, parabolic and hyperbolic arcs respectively.
    ConicArc {
        /// First point on the conic.
        start: Position,
        /// Middle control position; it does not generally lie on the conic.
        control: Position,
        /// Last point on the conic.
        end: Position,
        /// Positive homogeneous weight of `control`; both endpoint weights are one.
        control_weight: f64,
    },
    /// Euler spiral with linearly varying signed curvature.
    Clothoid {
        /// Start position.
        start: Position,
        /// Unit tangent at the start, lying in the clothoid plane.
        start_tangent: Vector3,
        /// Signed curvature at chainage zero.
        start_curvature: f64,
        /// Signed curvature at `length`.
        end_curvature: f64,
        /// Positive arc length.
        length: f64,
        /// Explicit plane for a spatial clothoid. When absent, the XY plane is used.
        plane: Option<PlaneDefinition>,
    },
    /// Non-uniform rational B-spline.
    Spline {
        /// Polynomial degree.
        degree: u16,
        /// Control positions.
        control_points: Vec<Position>,
        /// Knot vector.
        knots: Vec<f64>,
        /// Optional rational weights.
        weights: Option<Vec<f64>>,
        /// Whether the spline is closed.
        closed: bool,
    },
    /// Ordered compound curve whose segments retain analytic identity.
    Composite {
        /// Component curve segments.
        segments: Vec<CurveGeometry>,
    },
}

/// One directed use of a curve in an area boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CurveUse {
    /// Curve owned inline by the area geometry.
    Inline {
        /// Boundary curve.
        curve: CurveGeometry,
        /// Whether boundary traversal reverses the curve.
        reversed: bool,
    },
    /// Associative use of an existing curve entity.
    Associative {
        /// Referenced curve entity.
        entity_id: EntityId,
        /// Optional input version required by a derived cache.
        expected_version: Option<ObjectHash>,
        /// Whether boundary traversal reverses the source curve.
        reversed: bool,
    },
}

/// Closed topological boundary assembled from directed curves.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CurveLoop {
    /// Ordered boundary uses.
    pub uses: Vec<CurveUse>,
}

/// Area topology whose authored positions retain their exact XY/XYZ dimensionality.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AreaGeometry {
    /// Exterior boundary.
    pub outer: CurveLoop,
    /// Interior void boundaries.
    pub holes: Vec<CurveLoop>,
}

/// Column-major affine placement from representation-local into project space.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(transparent)]
pub struct Transform3d(pub [f64; 16]);

impl Transform3d {
    /// Identity placement.
    pub const IDENTITY: Self = Self([
        1.0, 0.0, 0.0, 0.0, // column 0
        0.0, 1.0, 0.0, 0.0, // column 1
        0.0, 0.0, 1.0, 0.0, // column 2
        0.0, 0.0, 0.0, 1.0, // column 3
    ]);
}

/// Content-addressed binary or image resource used by geometry objects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct GeometryResource {
    /// Immutable content hash.
    pub object_hash: ObjectHash,
    /// Registered media type or namespaced format identifier.
    pub media_type: String,
    /// Exact stored byte size when known.
    #[cfg_attr(feature = "ts-bindings", ts(type = "number | null"))]
    pub byte_length: Option<u64>,
}

/// Triangle topology stored inline for compact authored geometry or by resource.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TriangleMeshStorage {
    /// Compact exact mesh held in the immutable geometry object.
    Inline {
        /// Spatial vertex positions.
        positions: Vec<Vector3>,
        /// Triangle-list vertex indices.
        indices: Vec<u32>,
        /// Optional per-vertex unit normals.
        normals: Option<Vec<Vector3>>,
        /// Optional ordered texture-coordinate sets; set indices are canonical.
        texture_coordinates: Option<Vec<Vec<[f64; 2]>>>,
    },
    /// Large prepared mesh resource such as glTF/GLB or 3D Tiles content.
    Resource {
        /// Immutable resource and its declared format.
        resource: GeometryResource,
    },
}

/// Arbitrary open or closed triangulated boundary representation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TriangleMeshGeometry {
    /// Vertex and topology storage.
    pub storage: TriangleMeshStorage,
    /// Whether validation proved a closed, oriented two-manifold boundary.
    pub closed_manifold: bool,
    /// Optional material-table slot for every inline triangle, in index order.
    /// Resource-backed meshes carry this association in their immutable format.
    #[serde(default)]
    pub triangle_material_slots: Option<Vec<u32>>,
    /// Optional exact immutable canonical material-table revision.
    pub materials: Option<CanonicalResourceRef>,
}

/// 2.5D surface with at most one height for an XY coordinate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ElevationSurfaceGeometry {
    /// Triangulated irregular network with optional authored breaklines.
    Tin {
        /// Surface triangle mesh; vertical/overhanging triangles are invalid here.
        mesh: TriangleMeshGeometry,
        /// Curves that must remain triangle edges.
        breaklines: Vec<CurveGeometry>,
    },
    /// Regular height grid with explicit entity-local mapping.
    Grid {
        /// Height/validity raster bands.
        raster: GeometryResource,
        /// Pixel-to-entity-local mapping.
        mapping: OrthoGridMapping,
        /// Height interpolation and discontinuity semantics.
        sampling: DepthSampling,
    },
}

/// Pixel-center mapping for an orthographic entity-local grid.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OrthoGridMapping {
    /// Entity-local coordinate of pixel center `(0, 0)`.
    pub origin: Vector3,
    /// Entity-local step when the pixel column increases.
    pub column_step: Vector3,
    /// Entity-local step when the pixel row increases.
    pub row_step: Vector3,
}

/// Raster image mapping model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RasterMapping {
    /// Orthographic/projected pixel grid.
    OrthoGrid(OrthoGridMapping),
    /// Image embedded on an arbitrary entity-local plane by a homography.
    Planar {
        /// Column-major 3x3 homography from integer pixel-center coordinates
        /// into the frame's `(u, v)` coordinates.
        homography: [f64; 9],
        /// Explicit oriented plane receiving the image.
        frame: PlaneFrame,
    },
    /// Oriented central camera/image model.
    Camera {
        /// Intrinsic imaging model.
        model: CameraModel,
        /// Rigid camera-to-entity-local pose. Camera axes are +X image-right,
        /// +Y image-down and +Z forward. Pixel centers have integer coordinates.
        pose: Transform3d,
    },
}

/// Camera intrinsics carried by an oriented raster or panorama.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CameraModel {
    /// Pinhole camera with optional immutable distortion parameters.
    Pinhole {
        /// Horizontal focal length in pixels.
        focal_x: f64,
        /// Vertical focal length in pixels.
        focal_y: f64,
        /// Principal point X in pixels.
        center_x: f64,
        /// Principal point Y in pixels.
        center_y: f64,
        /// Namespaced distortion model identifier.
        distortion_model: Option<String>,
        /// Ordered parameters defined by `distortion_model`.
        distortion_parameters: Vec<f64>,
    },
    /// Full 360-degree equirectangular projection.
    Equirectangular,
    /// Unknown/imported imaging model preserved by identifier and parameters.
    Extension {
        /// Namespaced model identifier.
        model_id: String,
        /// Immutable model parameter object.
        parameters: ObjectHash,
    },
}

/// Meaning of one raster depth/height sample.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum DepthSemantics {
    /// Entity-local Z elevation before the entity placement is applied.
    ElevationZ,
    /// Distance along the camera optical axis.
    OpticalAxisDepth,
    /// Euclidean distance along the pixel ray.
    RayDistance,
}

/// Interpolation applied between valid raster samples.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RasterInterpolation {
    /// Select one pixel without interpolation.
    Nearest,
    /// Bilinear interpolation within connected valid regions.
    Bilinear,
    /// Discontinuity-aware interpolation using the declared connectivity data.
    DiscontinuityAware,
}

/// Fixed diagonal used when a raster cell is represented by two triangles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RasterCellDiagonal {
    /// Diagonal from the top-left sample to the bottom-right sample.
    TopLeftToBottomRight,
    /// Diagonal from the top-right sample to the bottom-left sample.
    TopRightToBottomLeft,
}

/// Storage of an authoritative per-cell triangle-connectivity mask.
///
/// Cells and their two admission bits are row-major. For a
/// top-left-to-bottom-right diagonal, bit zero admits `(TL, TR, BR)` and bit
/// one `(TL, BR, BL)`. For the other diagonal, bit zero admits `(TL, TR, BL)`
/// and bit one `(TR, BR, BL)`.
///
/// Non-wrapping mappings have `(width - 1) * (height - 1)` cells. An
/// equirectangular camera mapping has `width * (height - 1)` cells: its final
/// cell column uses image column `width - 1` on the left and column zero on
/// the right. Rows never wrap across a pole.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RasterTriangleMaskEncoding {
    /// Two little-significance-first bits per row-major cell.
    TwoBitsPerCellLsb0,
}

/// Whether neighboring samples claim a continuous surface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RasterConnectivity {
    /// Neighbors connect unless invalid or separated by an optional height limit.
    Continuous {
        /// Maximum connected height jump; absent means no numeric jump limit.
        maximum_height_jump: Option<f64>,
        /// Stable triangulation used by display and exact picking.
        diagonal: RasterCellDiagonal,
    },
    /// Each valid pixel is an independent step with no invented bridge.
    PixelSteps,
    /// Explicit triangle-connectivity mask stored as a raster resource.
    Mask {
        /// Exactly two triangle-admission bits per row-major raster cell,
        /// including the horizontal seam cells of an equirectangular image.
        resource: GeometryResource,
        /// Binary layout of the connectivity resource.
        encoding: RasterTriangleMaskEncoding,
        /// Stable triangulation addressed by the two mask bits.
        diagonal: RasterCellDiagonal,
    },
}

/// Storage of an authoritative per-pixel validity mask.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RasterValidityEncoding {
    /// One little-significance-first bit per row-major pixel; one means valid.
    BitsetLsb0,
}

/// Boolean validity attached to a co-registered depth field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RasterValidityMask {
    /// Immutable mask payload.
    pub resource: GeometryResource,
    /// Exact binary layout of the payload.
    pub encoding: RasterValidityEncoding,
}

/// Storage of normalized per-pixel confidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RasterConfidenceEncoding {
    /// One unsigned normalized byte per row-major pixel.
    Unorm8,
    /// One little-endian IEEE-754 value in `[0, 1]` per row-major pixel.
    Float32LittleEndian,
}

/// Informational confidence attached to a co-registered depth field.
/// Confidence never changes validity or connectivity implicitly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RasterConfidenceBand {
    /// Immutable normalized confidence payload.
    pub resource: GeometryResource,
    /// Exact scalar layout of the payload.
    pub encoding: RasterConfidenceEncoding,
}

/// Display and measurement rules for a raster height/depth band.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DepthSampling {
    /// Sample meaning.
    pub semantics: DepthSemantics,
    /// Interpolation rule.
    pub interpolation: RasterInterpolation,
    /// Neighbor connectivity rule.
    pub connectivity: RasterConnectivity,
}

/// Optional depth/elevation payload attached to an image.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DepthField {
    /// Scalar sample resource.
    pub values: GeometryResource,
    /// Optional validity mask.
    pub validity: Option<RasterValidityMask>,
    /// Optional confidence band.
    pub confidence: Option<RasterConfidenceBand>,
    /// Display and measurement rules.
    pub sampling: DepthSampling,
}

/// Raster image and all information needed to place and measure it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RasterImageGeometry {
    /// Color or scalar pixel resource.
    pub pixels: GeometryResource,
    /// Pixel width.
    pub width: u32,
    /// Pixel height.
    pub height: u32,
    /// Pixel-to-entity-local mapping or imaging model. Entity placement is
    /// applied exactly once after this mapping.
    pub mapping: RasterMapping,
    /// Optional attached depth/elevation field.
    pub depth: Option<DepthField>,
}

/// Prepared streamed geometry dataset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StreamedGeometry {
    /// Namespaced format and version, for example `potree@2` or `3d-tiles@1.1`.
    pub format_id: String,
    /// Root metadata/hierarchy resource.
    pub metadata: GeometryResource,
    /// Optional known element count.
    #[cfg_attr(feature = "ts-bindings", ts(type = "number | null"))]
    pub element_count: Option<u64>,
}

/// Panorama image at a scan station, optionally linked to station measurements.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanoramaGeometry {
    /// Equirectangular or vendor-specific panorama raster.
    pub image: RasterImageGeometry,
    /// Optional point-cloud entity measured from the same station.
    pub station_point_cloud: Option<EntityId>,
}

/// Boolean operation in a constructive solid geometry tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum CsgOperation {
    /// Union of both child solids.
    Union,
    /// Left solid minus right solid.
    Difference,
    /// Intersection of both child solids.
    Intersection,
}

/// Parametric primitive used as a CSG leaf.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SolidPrimitive {
    /// Axis-aligned box centered on the local origin.
    Box { size: Vector3 },
    /// Sphere centered on the local origin.
    Sphere { radius: f64 },
    /// Cylinder along local Z with its bottom-cap center at the local origin.
    Cylinder { radius: f64, height: f64 },
    /// Cone/frustum along local Z with its bottom-cap center at the local origin.
    Cone {
        bottom_radius: f64,
        top_radius: f64,
        height: f64,
    },
}

/// Recursive constructive solid geometry node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CsgNode {
    /// Positioned parametric leaf.
    Primitive {
        primitive: SolidPrimitive,
        placement: Transform3d,
    },
    /// Boolean combination of two valid child solids.
    Boolean {
        operation: CsgOperation,
        left: Box<CsgNode>,
        right: Box<CsgNode>,
    },
}

/// Valid solid representation. Validation must establish a well-defined volume.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SolidGeometry {
    /// Closed, oriented manifold triangle boundary.
    ClosedMesh { mesh: TriangleMeshGeometry },
    /// Manifold boundary representation in a declared exchange format.
    Brep { resource: GeometryResource },
    /// Constructive solid geometry tree.
    Csg { root: CsgNode },
    /// Area profile extruded along a spatial vector.
    Extrusion {
        profile: AreaGeometry,
        direction: Vector3,
    },
    /// Area profile swept along an authored path.
    Sweep {
        profile: AreaGeometry,
        path: CurveGeometry,
    },
    /// Preserved namespaced parametric solid.
    Extension {
        type_id: String,
        parameters: ObjectHash,
    },
}

/// One scalar sample along station/chainage.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StationValue {
    /// Alignment station.
    pub station: f64,
    /// Scalar value at the station.
    pub value: f64,
}

/// Explicit piecewise-linear station function.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StationFunction {
    /// Strictly increasing station/value samples.
    pub samples: Vec<StationValue>,
}

/// Vertical alignment segment in station/elevation space.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum VerticalAlignmentSegment {
    /// Constant-grade line.
    Grade {
        start_station: f64,
        start_elevation: f64,
        grade: f64,
        length: f64,
    },
    /// Parabolic vertical curve joining two grades.
    Parabolic {
        start_station: f64,
        start_elevation: f64,
        start_grade: f64,
        end_grade: f64,
        length: f64,
    },
}

/// One named width band measured laterally from the horizontal alignment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct WidthBand {
    /// Stable band identifier within the alignment.
    pub id: String,
    /// Signed offset of the inner edge.
    pub inner_offset: StationFunction,
    /// Signed offset of the outer edge.
    pub outer_offset: StationFunction,
}

/// One crossfall/ramp band between two alignment offsets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CrossfallBand {
    /// Stable band identifier.
    pub id: String,
    /// Signed start offset.
    pub from_offset: StationFunction,
    /// Signed end offset.
    pub to_offset: StationFunction,
    /// Rise divided by run along station.
    pub crossfall: StationFunction,
}

/// Rule used to derive a slope from an alignment edge to a target surface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SlopeRule {
    /// Stable rule identifier.
    pub id: String,
    /// Source width-band edge.
    pub source_band_id: String,
    /// Referenced target elevation/spatial surface.
    pub target_surface: EntityId,
    /// Cut slope as vertical/horizontal ratio.
    pub cut_ratio: f64,
    /// Fill slope as vertical/horizontal ratio.
    pub fill_ratio: f64,
}

/// Civil alignment combining horizontal, vertical and corridor rules.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AlignmentGeometry {
    /// Horizontal analytic alignment.
    pub horizontal: CurveGeometry,
    /// Optional vertical alignment/gradient.
    pub vertical: Vec<VerticalAlignmentSegment>,
    /// User-facing station offset added to geometric chainage.
    pub station_origin: f64,
    /// Width bands.
    pub width_bands: Vec<WidthBand>,
    /// Ramp/crossfall bands.
    pub crossfall_bands: Vec<CrossfallBand>,
    /// Slope derivation rules.
    pub slope_rules: Vec<SlopeRule>,
}

/// Reusable block instance; its definition remains a project record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockInstanceGeometry {
    /// Stable reusable definition identity.
    pub definition_id: String,
    /// Definition version expected by this entity revision.
    pub definition_hash: ObjectHash,
    /// Instance placement.
    pub placement: Transform3d,
    /// Typed style and attribute inheritance committed with this revision.
    pub overrides: Option<BlockInstanceOverrides>,
}

/// Text orientation and size convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TextSpace {
    /// Text lies in project/world space.
    World,
    /// Text remains a fixed physical-pixel overlay at a world anchor.
    Screen,
}

/// Renderable text with an explicit anchor and font resource.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TextGeometry {
    /// UTF-8 text.
    pub text: String,
    /// Project-space anchor; optional Z remains unknown until explicitly resolved.
    pub anchor: Position,
    /// World- or screen-space sizing.
    pub space: TextSpace,
    /// Text height in project units or physical pixels according to `space`.
    pub height: f64,
    /// Immutable font/style resource.
    pub font: GeometryResource,
}

/// Associative anchor on another entity or at a fixed position.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AnnotationAnchor {
    /// Fixed authored coordinate.
    Position { position: Position },
    /// Entity/primitive reference revalidated against an optional version.
    Entity {
        entity_id: EntityId,
        expected_version: Option<ObjectHash>,
        #[cfg_attr(feature = "ts-bindings", ts(type = "number | null"))]
        primitive_id: Option<u64>,
        parameter: Option<f64>,
    },
}

/// Associative label with leader and text placement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LabelGeometry {
    /// Labeled source location.
    pub target: AnnotationAnchor,
    /// Label text.
    pub text: TextGeometry,
    /// Optional leader vertices between target and text.
    pub leader: Vec<Position>,
}

/// Measurement expressed by an associative dimension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum DimensionKind {
    /// Linear distance.
    Linear,
    /// Aligned three-dimensional distance.
    Aligned,
    /// Angular measurement.
    Angular,
    /// Radius.
    Radius,
    /// Diameter.
    Diameter,
    /// Elevation/ordinate.
    Ordinate,
}

/// Associative dimension definition; displayed value is always derived.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DimensionGeometry {
    /// Measurement kind.
    pub dimension_kind: DimensionKind,
    /// Ordered associative measurement anchors.
    pub anchors: Vec<AnnotationAnchor>,
    /// Dimension-line/text placement anchor.
    pub placement: Position,
    /// Immutable formatting/style resource.
    pub style: GeometryResource,
}

/// Canonical immutable geometry object addressed by a representation hash.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GeometryObject {
    /// Point coordinate.
    Point { position: Position },
    /// Authored analytic curve.
    Curve { curve: Box<CurveGeometry> },
    /// Plan-topological area.
    Area { area: Box<AreaGeometry> },
    /// Explicit construction plane.
    Plane { plane: PlaneDefinition },
    /// 2.5D elevation surface.
    ElevationSurface {
        surface: Box<ElevationSurfaceGeometry>,
    },
    /// Arbitrary open spatial surface, including overhangs.
    Surface3d { mesh: Box<TriangleMeshGeometry> },
    /// Raster image with optional depth/elevation.
    RasterImage { raster: Box<RasterImageGeometry> },
    /// Prepared point-cloud dataset.
    PointCloud { dataset: StreamedGeometry },
    /// Prepared Gaussian-splat dataset.
    GaussianSplatCloud { dataset: StreamedGeometry },
    /// Measurable scan-station panorama.
    Panorama { panorama: Box<PanoramaGeometry> },
    /// Valid volume representation.
    Solid { solid: Box<SolidGeometry> },
    /// Civil alignment.
    Alignment { alignment: Box<AlignmentGeometry> },
    /// Placed reusable block.
    Block {
        instance: Box<BlockInstanceGeometry>,
    },
    /// Standalone text.
    Text { text: Box<TextGeometry> },
    /// Associative label.
    Label { label: Box<LabelGeometry> },
    /// Associative dimension.
    Dimension { dimension: Box<DimensionGeometry> },
    /// Persistent inspection measurement.
    Measurement {
        measurement: Box<crate::release_05_admissions::MeasurementV1>,
    },
    /// Preserved namespaced geometry not understood by this core version.
    Extension {
        type_id: String,
        payload: ObjectHash,
    },
}

/// Semantic BIM classification kept independently from geometry representations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BimClassification {
    /// Classification system, for example IFC 4.3.
    pub system: String,
    /// Product/class code such as `IfcPipeSegment`.
    pub code: String,
    /// Optional predefined type or external classification item.
    pub predefined_type: Option<String>,
}

/// Typed dependency or semantic relation between canonical entities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct EntityRelation {
    /// Namespaced relation kind such as `hcad.derived-from@1`.
    pub relation_type: String,
    /// Target entity.
    pub target: EntityId,
    /// Optional target version required by this relation.
    pub expected_version: Option<ObjectHash>,
    /// Optional immutable relation parameters.
    pub parameters: Option<ObjectHash>,
}

/// Semantic role of a geometry representation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RepresentationRole {
    /// Authoritative canonical representation.
    Canonical,
    /// Solid or surface body.
    Body,
    /// Axis or centerline representation.
    Axis,
    /// Plan footprint.
    Footprint,
    /// Boundary-only representation.
    Boundary,
    /// Additional import or display representation.
    Alternate,
}

/// Authority of one representation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RepresentationAuthority {
    /// Source of truth for the represented geometry.
    Authoritative,
    /// Rebuildable output derived from authoritative inputs.
    Derived,
    /// Preserved import representation used when no canonical conversion exists.
    ImportedFallback,
}

/// Immutable geometry attached to an entity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Representation {
    /// Semantic representation role.
    pub role: RepresentationRole,
    /// Content-addressed geometry object.
    pub geometry_ref: ObjectHash,
    /// Whether the representation is authoritative or derived.
    pub authority: RepresentationAuthority,
    /// Hash of inputs and parameters used for a derived representation.
    pub dependency_hash: Option<ObjectHash>,
}

/// New canonical entity envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-bindings", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CanonicalEntity {
    /// Stable semantic identity.
    pub id: EntityId,
    /// Monotonic revision used for optimistic command validation.
    #[cfg_attr(feature = "ts-bindings", ts(type = "number"))]
    pub revision: u64,
    /// Versioned semantic type.
    pub type_id: EntityTypeId,
    /// User-facing name.
    pub name: String,
    /// Canonical hierarchy owner.
    pub owner: Option<EntityId>,
    /// Presentation/organization layers.
    pub layer_ids: Vec<EntityId>,
    /// Optional entity-level placement shared by its representations.
    pub placement: Option<Transform3d>,
    /// Immutable geometry representations.
    pub representations: Vec<Representation>,
    /// Content-addressed typed component map.
    pub components_ref: ObjectHash,
    /// Content-addressed general attribute table.
    pub attributes_ref: ObjectHash,
    /// Content-addressed relation set.
    pub relations_ref: ObjectHash,
    /// Optional style assignment.
    pub style_ref: Option<ObjectHash>,
    /// Envelope schema version.
    pub schema_version: u32,
    /// Hash of the complete canonical entity version.
    pub version_hash: ObjectHash,
}

#[cfg(test)]
mod tests {
    use super::{
        built_in_type, AreaGeometry, BuiltInEntityType, CurveGeometry, CurveLoop, CurveUse,
        EntityTypeId, Position,
    };

    #[test]
    fn all_built_in_type_identifiers_round_trip_exactly() {
        let identifiers = [
            built_in_type::GROUP,
            built_in_type::LAYER,
            built_in_type::POINT,
            built_in_type::CURVE,
            built_in_type::AREA,
            built_in_type::PLANE,
            built_in_type::ELEVATION_SURFACE,
            built_in_type::SURFACE_3D,
            built_in_type::RASTER_IMAGE,
            built_in_type::POINT_CLOUD,
            built_in_type::GAUSSIAN_SPLAT_CLOUD,
            built_in_type::PANORAMA,
            built_in_type::OBJECT_3D,
            built_in_type::BIM_OBJECT,
            built_in_type::ALIGNMENT,
            built_in_type::BLOCK,
            built_in_type::TEXT,
            built_in_type::LABEL,
            built_in_type::DIMENSION,
        ];

        for identifier in identifiers {
            let built_in = BuiltInEntityType::from_type_id(&EntityTypeId(identifier.to_owned()))
                .expect("listed built-in must resolve");
            assert_eq!(built_in.type_id(), identifier);
            assert_eq!(
                serde_json::to_string(&built_in).expect("built-in must serialize"),
                format!("\"{identifier}\"")
            );
            assert_eq!(
                serde_json::from_str::<BuiltInEntityType>(&format!("\"{identifier}\""))
                    .expect("built-in must deserialize"),
                built_in
            );
        }
        assert_eq!(
            BuiltInEntityType::from_type_id(&EntityTypeId("vendor.custom@1".to_owned())),
            None
        );
    }

    #[test]
    fn mixed_xy_xyz_area_preserves_unknown_height() {
        let area = AreaGeometry {
            outer: CurveLoop {
                uses: vec![CurveUse::Inline {
                    curve: CurveGeometry::Polyline {
                        positions: vec![
                            Position {
                                x: 10.0,
                                y: 20.0,
                                z: Some(501.25),
                            },
                            Position {
                                x: 30.0,
                                y: 40.0,
                                z: None,
                            },
                        ],
                        closed: true,
                    },
                    reversed: false,
                }],
            },
            holes: Vec::new(),
        };

        let json = serde_json::to_string(&area).expect("area serializes");
        let restored: AreaGeometry = serde_json::from_str(&json).expect("area deserializes");

        assert_eq!(restored, area);
        assert!(json.contains("\"z\":null"));
        assert!(!json.contains("\"z\":0"));
    }

    #[test]
    fn tagged_geometry_variant_fields_use_camel_case() {
        let curve = CurveGeometry::CircularArc {
            start: Position {
                x: 0.0,
                y: 0.0,
                z: None,
            },
            point_on_arc: Position {
                x: 1.0,
                y: 1.0,
                z: Some(2.0),
            },
            end: Position {
                x: 2.0,
                y: 0.0,
                z: None,
            },
        };
        let json = serde_json::to_string(&curve).expect("arc serializes");

        assert!(json.contains("\"pointOnArc\""));
        assert!(!json.contains("point_on_arc"));
        assert_eq!(
            serde_json::from_str::<CurveGeometry>(&json).expect("arc restores"),
            curve
        );
    }
}
