//! Geometry-level transformation policies and pure helpers.
//!
//! Point transforms alone are not enough for CAD/BIM/survey products. This module
//! classifies geometry, declares what can/cannot be preserved exactly, and provides
//! densify / circle-fit / text-scale helpers. Execution of non-linear maps still goes
//! through [`crate::transform`] + the sidecar runtime (always **materialized**, never lazy).

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::transform::{
    apply_empirical, apply_similarity_2d, EmpiricalOp, Similarity2D, TransformSpec, TransformStage,
    WorldPoint,
};

/// What kind of geometric object is being transformed (format-agnostic).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GeometryKind {
    /// Independent points (GCP, cloud samples).
    PointSet,
    /// Polyline / polygon ring (ordered vertices).
    Polyline,
    /// Triangle/mesh vertices (+ optional normals).
    Mesh,
    /// Exact circle in a plane (centre + radius + optional normal).
    Circle,
    /// Circular arc (centre, radius, start/end angles or endpoints).
    Arc,
    /// Analytic curve that is not a circle/arc (NURBS, ellipse, clothoid, …).
    AnalyticCurve,
    /// Camera / local frame (origin + orthonormal basis).
    RigidFrame,
    /// Text anchor (position + height + optional rotation).
    Text,
    /// Regular 2D scalar/RGB field (DGM, orthophoto samples).
    RasterField,
    /// Solid/CSG/implicit body without a discrete tessellation.
    ImplicitSolid,
    /// Hierarchy (octree, tile pyramid) — must be fully rematerialized.
    Hierarchy,
    /// Unknown / mixed bundle (e.g. IFC product with several representations).
    MixedBundle,
}

/// How the engine should treat circular primitives under a non-similarity map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CirclePolicy {
    /// Densify to polyline with [`GeometryTransformPolicy::densify`], transform vertices.
    /// Guarantees no false “still a circle” claim under NTv2.
    #[default]
    DensifyToPolyline,
    /// Transform centre; set radius from mean distance of densified rim samples
    /// (or axis-aligned average scale). Emits a warning that eccentricity is discarded.
    PreserveAsCircleBestFit,
    /// Transform centre + three rim points, fit circle; warning with residual RMS.
    FitCircleFromSamples,
}

/// How text size / annotation scale is handled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TextScalePolicy {
    /// Keep height in **paper/drawing units** unchanged (only move anchor).
    #[default]
    KeepDrawingHeight,
    /// Multiply height by local isotropic scale estimate at the anchor.
    ScaleByLocalIsotropic,
    /// Use geometric mean of local axis scales (|sx·sy|)^0.5.
    ScaleByLocalAreaSqrt,
    /// Do not transform text; report as unsupported for size.
    LeaveUnscaledWithWarning,
}

/// Densification controls for arcs/circles/analytic curves.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DensifyPolicy {
    /// Maximum chord-to-arc error in metres (source CRS units).
    pub max_chord_error_meters: f64,
    /// Maximum segment length in metres.
    pub max_segment_meters: f64,
    /// Absolute minimum number of samples on a full circle.
    pub min_circle_samples: u32,
    /// Absolute maximum samples (safety cap).
    pub max_samples: u32,
}

impl Default for DensifyPolicy {
    fn default() -> Self {
        Self {
            max_chord_error_meters: 0.005,
            max_segment_meters: 1.0,
            min_circle_samples: 32,
            max_samples: 50_000,
        }
    }
}

/// Options that apply to **all** geometry classes for one transform job.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometryTransformPolicy {
    #[serde(default)]
    pub densify: DensifyPolicy,
    #[serde(default)]
    pub circle: CirclePolicy,
    #[serde(default)]
    pub text_scale: TextScalePolicy,
    /// When true, refuse geometry that cannot be represented exactly after the map.
    #[serde(default)]
    pub strict_exactness: bool,
    /// Numerical step (metres) for Jacobian estimation of non-analytic maps.
    #[serde(default = "default_jacobian_step")]
    pub jacobian_step_meters: f64,
    /// Warn when connected elements use mixed strategies (line wall vs arc wall).
    #[serde(default = "default_true")]
    pub warn_connectivity_risk: bool,
}

fn default_jacobian_step() -> f64 {
    0.05
}

fn default_true() -> bool {
    true
}

impl Default for GeometryTransformPolicy {
    fn default() -> Self {
        Self {
            densify: DensifyPolicy::default(),
            circle: CirclePolicy::default(),
            text_scale: TextScalePolicy::default(),
            strict_exactness: false,
            jacobian_step_meters: default_jacobian_step(),
            warn_connectivity_risk: true,
        }
    }
}

/// Capability / risk classification for a geometry kind under a given spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransformSupport {
    /// Exact discrete map of all defining samples.
    FullySupported,
    /// Supported with approximation (densify, best-fit circle, raster resample).
    SupportedWithApproximation,
    /// Not supported; caller must skip or fail.
    Unsupported,
}

/// Structured warning for geometry transforms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometryTransformWarning {
    pub code: GeometryWarningCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GeometryWarningCode {
    /// Non-similarity map will stretch circles into non-circles unless policy preserves circle.
    CircleNotPreserved,
    /// Circle preserved by best-fit; eccentricity discarded.
    CircleBestFitApproximation,
    /// Arc/circle densified; original analytic type lost.
    AnalyticDensified,
    /// Line-string vs densified arc junction may open gaps after non-linear maps.
    ConnectivityRisk,
    /// Normals/orientation use local linearization only.
    OrientationLinearized,
    /// Text height policy choice affects annotation size.
    TextScalePolicy,
    /// Raster requires full warp / resample; nodata at OOB.
    RasterWarpRequired,
    /// Hierarchy must be rebuilt (no lazy decode).
    HierarchyMustRematerialize,
    /// Implicit solid has no samples — cannot transform without tessellation.
    ImplicitRequiresTessellation,
    /// Mixed representations in one product.
    MixedRepresentation,
    /// Geoid/NTv2 coverage hole.
    OutOfBounds,
    /// Strict mode blocked an approximate path.
    StrictExactnessBlocked,
    /// Local scale varies strongly (annotation/hatch risk).
    StrongLocalScaleGradient,
    /// Self-intersection or winding flip possible after non-linear map.
    TopologyRisk,
    /// Texture/UV kept; only XYZ moved.
    AttributesNotWarped,
}

/// Result of classifying one geometry object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometryClassification {
    pub kind: GeometryKind,
    pub support: TransformSupport,
    pub strategy: GeometryStrategy,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<GeometryTransformWarning>,
}

/// Concrete strategy the runtime should execute (always materializing).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GeometryStrategy {
    MapVertices,
    DensifyThenMapVertices,
    MapCentreAndBestFitRadius,
    MapFrameWithJacobian,
    MapTextAnchorAndScale,
    WarpRasterInverseMap,
    TessellateThenMap,
    RematerializeHierarchy,
    Reject,
}

/// Circle in 3D (plane = centre + unit normal).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Circle3 {
    pub centre: WorldPoint,
    pub radius: f64,
    /// Unit normal; default +Z if planar map in XY.
    pub normal: WorldPoint,
}

/// Arc as centre/radius/start_angle/sweep (radians, right-hand about normal).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Arc3 {
    pub centre: WorldPoint,
    pub radius: f64,
    pub normal: WorldPoint,
    pub start_angle_rad: f64,
    pub sweep_angle_rad: f64,
}

/// Text anchor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextAnchor {
    pub position: WorldPoint,
    pub height_meters: f64,
    /// Rotation about local up (radians), optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation_rad: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// Transformed text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformedText {
    pub position: WorldPoint,
    pub height_meters: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation_rad: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// Regular raster descriptor (values owned by caller; warp returns new buffer).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterGrid2D {
    /// Lower-left centre of pixel (0,0) or corner — documented as **pixel centre** of (0,0).
    pub origin: WorldPoint,
    pub pixel_size_x: f64,
    pub pixel_size_y: f64,
    pub width: u32,
    pub height: u32,
    /// Row-major samples, length width*height.
    pub values: Vec<f64>,
    pub nodata: f64,
}

#[derive(Debug, Error, PartialEq)]
pub enum GeometryTransformError {
    #[error("geometry cannot be transformed: {0}")]
    Unsupported(&'static str),
    #[error("invalid geometry parameters: {0}")]
    Invalid(&'static str),
    #[error("strict exactness blocked approximate strategy for {0:?}")]
    StrictBlocked(GeometryKind),
    #[error("densify produced no samples")]
    EmptyDensify,
    #[error("raster dimensions do not match value buffer")]
    RasterSizeMismatch,
}

/// True if every stage is identity / pure translation / global similarity / affine
/// (no NTv2, no geoid grid, no PROJ datum shift). Used to allow exact circle preserve.
#[must_use]
pub fn spec_is_global_similarity_or_affine(spec: &TransformSpec) -> bool {
    let stages = spec.stages.iter().chain(spec.vertical_stages.iter());
    for stage in stages {
        match stage {
            TransformStage::Identity | TransformStage::HeightOffset(_) => {}
            TransformStage::Empirical(EmpiricalOp::Similarity2D { .. })
            | TransformStage::Empirical(EmpiricalOp::Affine2D { .. })
            | TransformStage::Empirical(EmpiricalOp::Similarity3D { .. })
            | TransformStage::Empirical(EmpiricalOp::Translation3D { .. }) => {}
            TransformStage::HeightPlane(_) => {}
            TransformStage::Proj(_)
            | TransformStage::VerticalProj { .. }
            | TransformStage::GeoidUndulation { .. } => return false,
        }
    }
    !spec.stages.is_empty() || !spec.vertical_stages.is_empty()
}

/// Classify geometry and attach policy-driven warnings (no I/O).
#[must_use]
pub fn classify_geometry(
    kind: GeometryKind,
    spec: &TransformSpec,
    policy: &GeometryTransformPolicy,
    geometry_id: Option<&str>,
) -> GeometryClassification {
    let mut warnings = Vec::new();
    let global_sim = spec_is_global_similarity_or_affine(spec);
    let id = geometry_id.map(str::to_owned);

    let (support, strategy) = match kind {
        GeometryKind::PointSet | GeometryKind::Polyline | GeometryKind::Mesh => {
            (TransformSupport::FullySupported, GeometryStrategy::MapVertices)
        }
        GeometryKind::Circle | GeometryKind::Arc => {
            if global_sim {
                (
                    TransformSupport::FullySupported,
                    GeometryStrategy::MapCentreAndBestFitRadius,
                )
            } else {
                match policy.circle {
                    CirclePolicy::DensifyToPolyline => {
                        warnings.push(warn(
                            GeometryWarningCode::AnalyticDensified,
                            "non-similarity map: circle/arc densified to polyline (exact analytic type not preserved)",
                            id.clone(),
                        ));
                        if policy.warn_connectivity_risk {
                            warnings.push(warn(
                                GeometryWarningCode::ConnectivityRisk,
                                "densified arc/circle next to unsampled line edges can open gaps after NTv2; densify all connected boundaries consistently",
                                id.clone(),
                            ));
                        }
                        (
                            TransformSupport::SupportedWithApproximation,
                            GeometryStrategy::DensifyThenMapVertices,
                        )
                    }
                    CirclePolicy::PreserveAsCircleBestFit | CirclePolicy::FitCircleFromSamples => {
                        warnings.push(warn(
                            GeometryWarningCode::CircleBestFitApproximation,
                            "circle preserved by best-fit centre/radius; local stretch (ellipse) is discarded",
                            id.clone(),
                        ));
                        if policy.strict_exactness {
                            return blocked(kind, policy, id, warnings);
                        }
                        (
                            TransformSupport::SupportedWithApproximation,
                            GeometryStrategy::MapCentreAndBestFitRadius,
                        )
                    }
                }
            }
        }
        GeometryKind::AnalyticCurve => {
            warnings.push(warn(
                GeometryWarningCode::AnalyticDensified,
                "analytic curve densified then vertex-mapped; original equation is not preserved",
                id.clone(),
            ));
            if policy.strict_exactness {
                return blocked(kind, policy, id, warnings);
            }
            (
                TransformSupport::SupportedWithApproximation,
                GeometryStrategy::DensifyThenMapVertices,
            )
        }
        GeometryKind::RigidFrame => {
            warnings.push(warn(
                GeometryWarningCode::OrientationLinearized,
                "orientation uses local Jacobian linearization of the coordinate map",
                id.clone(),
            ));
            (
                TransformSupport::SupportedWithApproximation,
                GeometryStrategy::MapFrameWithJacobian,
            )
        }
        GeometryKind::Text => {
            warnings.push(warn(
                GeometryWarningCode::TextScalePolicy,
                format!("text height policy = {:?}", policy.text_scale),
                id.clone(),
            ));
            (
                TransformSupport::SupportedWithApproximation,
                GeometryStrategy::MapTextAnchorAndScale,
            )
        }
        GeometryKind::RasterField => {
            warnings.push(warn(
                GeometryWarningCode::RasterWarpRequired,
                "raster field is inverse-mapped and resampled (materialized); nodata where source OOB",
                id.clone(),
            ));
            (
                TransformSupport::SupportedWithApproximation,
                GeometryStrategy::WarpRasterInverseMap,
            )
        }
        GeometryKind::ImplicitSolid => {
            warnings.push(warn(
                GeometryWarningCode::ImplicitRequiresTessellation,
                "implicit/CSG solid has no vertices; tessellate before transform or reject",
                id.clone(),
            ));
            if policy.strict_exactness {
                return blocked(kind, policy, id, warnings);
            }
            (
                TransformSupport::SupportedWithApproximation,
                GeometryStrategy::TessellateThenMap,
            )
        }
        GeometryKind::Hierarchy => {
            warnings.push(warn(
                GeometryWarningCode::HierarchyMustRematerialize,
                "tile/octree hierarchy must be fully rematerialized (no lazy transform)",
                id.clone(),
            ));
            (
                TransformSupport::SupportedWithApproximation,
                GeometryStrategy::RematerializeHierarchy,
            )
        }
        GeometryKind::MixedBundle => {
            warnings.push(warn(
                GeometryWarningCode::MixedRepresentation,
                "mixed representations (e.g. line-bounded wall + arc-bounded wall) need consistent densify policies to keep joins closed",
                id.clone(),
            ));
            (
                TransformSupport::SupportedWithApproximation,
                GeometryStrategy::MapVertices,
            )
        }
    };

    GeometryClassification {
        kind,
        support,
        strategy,
        warnings,
    }
}

fn blocked(
    kind: GeometryKind,
    policy: &GeometryTransformPolicy,
    id: Option<String>,
    mut warnings: Vec<GeometryTransformWarning>,
) -> GeometryClassification {
    let _ = policy;
    warnings.push(warn(
        GeometryWarningCode::StrictExactnessBlocked,
        "strictExactness=true blocked approximate geometry strategy",
        id,
    ));
    GeometryClassification {
        kind,
        support: TransformSupport::Unsupported,
        strategy: GeometryStrategy::Reject,
        warnings,
    }
}

fn warn(code: GeometryWarningCode, message: impl Into<String>, geometry_id: Option<String>) -> GeometryTransformWarning {
    GeometryTransformWarning {
        code,
        message: message.into(),
        geometry_id,
    }
}

/// Number of samples for a full circle under the densify policy.
#[must_use]
pub fn circle_sample_count(radius: f64, policy: &DensifyPolicy) -> u32 {
    if !(radius.is_finite() && radius > 0.0) {
        return policy.min_circle_samples;
    }
    // chord error e ≈ r (1 - cos(π/n)) → n ≈ π / acos(1 - e/r)
    let e = policy.max_chord_error_meters.max(1e-9);
    let n_err = if e < radius {
        std::f64::consts::PI / (1.0 - e / radius).clamp(1e-9, 1.0 - 1e-15).acos()
    } else {
        f64::from(policy.min_circle_samples)
    };
    let n_seg = (2.0 * std::f64::consts::PI * radius / policy.max_segment_meters.max(1e-9)).ceil();
    let n = n_err.max(n_seg).ceil() as u32;
    n.clamp(policy.min_circle_samples, policy.max_samples)
}

/// Densify a circle into polyline vertices (closed if `close`).
pub fn densify_circle(circle: Circle3, policy: &DensifyPolicy, close: bool) -> Result<Vec<WorldPoint>, GeometryTransformError> {
    if !(circle.radius.is_finite() && circle.radius > 0.0) {
        return Err(GeometryTransformError::Invalid("circle radius"));
    }
    let n = circle_sample_count(circle.radius, policy);
    let (u, v) = orthonormal_basis(circle.normal);
    let mut pts = Vec::with_capacity(n as usize + 1);
    for i in 0..n {
        let a = 2.0 * std::f64::consts::PI * f64::from(i) / f64::from(n);
        let (s, c) = a.sin_cos();
        pts.push(WorldPoint::new(
            circle.centre.x + circle.radius * (c * u.x + s * v.x),
            circle.centre.y + circle.radius * (c * u.y + s * v.y),
            circle.centre.z + circle.radius * (c * u.z + s * v.z),
        ));
    }
    if close {
        if let Some(first) = pts.first().copied() {
            pts.push(first);
        }
    }
    if pts.is_empty() {
        return Err(GeometryTransformError::EmptyDensify);
    }
    Ok(pts)
}

/// Densify an arc into polyline vertices.
pub fn densify_arc(arc: Arc3, policy: &DensifyPolicy) -> Result<Vec<WorldPoint>, GeometryTransformError> {
    if !(arc.radius.is_finite() && arc.radius > 0.0) {
        return Err(GeometryTransformError::Invalid("arc radius"));
    }
    let sweep = arc.sweep_angle_rad.abs();
    let full = circle_sample_count(arc.radius, policy);
    let n = ((f64::from(full) * sweep / (2.0 * std::f64::consts::PI)).ceil() as u32)
        .clamp(2, policy.max_samples);
    let (u, v) = orthonormal_basis(arc.normal);
    let mut pts = Vec::with_capacity(n as usize + 1);
    for i in 0..=n {
        let t = f64::from(i) / f64::from(n);
        let a = arc.start_angle_rad + arc.sweep_angle_rad * t;
        let (s, c) = a.sin_cos();
        pts.push(WorldPoint::new(
            arc.centre.x + arc.radius * (c * u.x + s * v.x),
            arc.centre.y + arc.radius * (c * u.y + s * v.y),
            arc.centre.z + arc.radius * (c * u.z + s * v.z),
        ));
    }
    Ok(pts)
}

/// Best-fit circle in XY from ≥3 points (non-iterative algebraic fit). Z = mean Z.
pub fn fit_circle_xy(points: &[WorldPoint]) -> Result<Circle3, GeometryTransformError> {
    if points.len() < 3 {
        return Err(GeometryTransformError::Invalid("need ≥3 points to fit circle"));
    }
    // Kåsa fit: x^2 + y^2 + d x + e y + f = 0
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;
    let mut sum_x2 = 0.0;
    let mut sum_y2 = 0.0;
    let mut sum_xy = 0.0;
    let mut sum_x3 = 0.0;
    let mut sum_y3 = 0.0;
    let mut sum_x2y = 0.0;
    let mut sum_xy2 = 0.0;
    let mut sum_z = 0.0;
    let n = points.len() as f64;
    for p in points {
        if !p.is_finite() {
            return Err(GeometryTransformError::Invalid("non-finite fit point"));
        }
        let x = p.x;
        let y = p.y;
        let x2 = x * x;
        let y2 = y * y;
        sum_x += x;
        sum_y += y;
        sum_x2 += x2;
        sum_y2 += y2;
        sum_xy += x * y;
        sum_x3 += x2 * x;
        sum_y3 += y2 * y;
        sum_x2y += x2 * y;
        sum_xy2 += x * y2;
        sum_z += p.z;
    }
    // Solve 2x2 for d,e from partial derivatives
    let c1 = n * sum_x2 - sum_x * sum_x;
    let c2 = n * sum_xy - sum_x * sum_y;
    let c3 = n * sum_y2 - sum_y * sum_y;
    let c4 = 0.5 * (n * sum_x3 + n * sum_xy2 - sum_x * (sum_x2 + sum_y2));
    let c5 = 0.5 * (n * sum_y3 + n * sum_x2y - sum_y * (sum_x2 + sum_y2));
    let det = c1 * c3 - c2 * c2;
    if det.abs() < 1e-18 {
        return Err(GeometryTransformError::Invalid("circle fit degenerate"));
    }
    let cx = (c4 * c3 - c5 * c2) / det;
    let cy = (c1 * c5 - c2 * c4) / det;
    let mut r_acc = 0.0;
    for p in points {
        r_acc += (p.x - cx).hypot(p.y - cy);
    }
    let radius = r_acc / n;
    if !(radius.is_finite() && radius > 0.0) {
        return Err(GeometryTransformError::Invalid("circle fit radius"));
    }
    Ok(Circle3 {
        centre: WorldPoint::new(cx, cy, sum_z / n),
        radius,
        normal: WorldPoint::new(0.0, 0.0, 1.0),
    })
}

/// Mean distance from centre to points (for PreserveAsCircleBestFit after map).
#[must_use]
pub fn mean_radius_xy(centre: WorldPoint, points: &[WorldPoint]) -> f64 {
    if points.is_empty() {
        return 0.0;
    }
    let mut s = 0.0;
    for p in points {
        s += (p.x - centre.x).hypot(p.y - centre.y);
    }
    s / points.len() as f64
}

/// Build two unit axes orthonormal to `normal`.
#[must_use]
pub fn orthonormal_basis(normal: WorldPoint) -> (WorldPoint, WorldPoint) {
    let n = vec_normalize(normal).unwrap_or(WorldPoint::new(0.0, 0.0, 1.0));
    let helper = if n.z.abs() < 0.9 {
        WorldPoint::new(0.0, 0.0, 1.0)
    } else {
        WorldPoint::new(1.0, 0.0, 0.0)
    };
    let u = vec_normalize(vec_cross(helper, n)).unwrap_or(WorldPoint::new(1.0, 0.0, 0.0));
    let v = vec_normalize(vec_cross(n, u)).unwrap_or(WorldPoint::new(0.0, 1.0, 0.0));
    (u, v)
}

#[must_use]
pub fn vec_normalize(v: WorldPoint) -> Option<WorldPoint> {
    let len = (v.x * v.x + v.y * v.y + v.z * v.z).sqrt();
    if len < 1e-15 {
        None
    } else {
        Some(WorldPoint::new(v.x / len, v.y / len, v.z / len))
    }
}

#[must_use]
pub fn vec_cross(a: WorldPoint, b: WorldPoint) -> WorldPoint {
    WorldPoint::new(
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x,
    )
}

#[must_use]
pub fn vec_dot(a: WorldPoint, b: WorldPoint) -> f64 {
    a.x * b.x + a.y * b.y + a.z * b.z
}

/// Local scale estimate: average stretch of unit X/Y axes after a similarity-like map.
/// For pure [`Similarity2D`], returns `|scale|`.
#[must_use]
pub fn similarity_2d_text_height(model: Similarity2D, height: f64, policy: TextScalePolicy) -> f64 {
    match policy {
        TextScalePolicy::KeepDrawingHeight => height,
        TextScalePolicy::LeaveUnscaledWithWarning => height,
        TextScalePolicy::ScaleByLocalIsotropic | TextScalePolicy::ScaleByLocalAreaSqrt => {
            height * model.scale.abs()
        }
    }
}

/// Apply empirical op list as a simple chain for pure-Rust previews (no PROJ).
pub fn map_point_empirical_chain(stages: &[EmpiricalOp], mut p: WorldPoint) -> WorldPoint {
    for stage in stages {
        p = apply_empirical(stage, p);
    }
    p
}

/// Transform a circle under a global 2D similarity (exact).
#[must_use]
pub fn map_circle_similarity_2d(circle: Circle3, model: Similarity2D) -> Circle3 {
    let centre = apply_similarity_2d(model, circle.centre, 0.0);
    Circle3 {
        centre,
        radius: circle.radius * model.scale.abs(),
        normal: circle.normal,
    }
}

/// Catalog of edge cases callers must expect (documentation + tests).
#[must_use]
pub fn geometry_edge_case_catalog() -> &'static [(&'static str, GeometryWarningCode)] {
    &[
        ("Circle/arc under NTv2 becomes non-circular", GeometryWarningCode::CircleNotPreserved),
        ("Best-fit circle drops eccentricity", GeometryWarningCode::CircleBestFitApproximation),
        ("Line wall + arc wall junction opens after densify mismatch", GeometryWarningCode::ConnectivityRisk),
        ("Camera orientation needs Jacobian, not point formula", GeometryWarningCode::OrientationLinearized),
        ("Text height vs ground scale vs paper scale", GeometryWarningCode::TextScalePolicy),
        ("Raster needs inverse warp + nodata", GeometryWarningCode::RasterWarpRequired),
        ("Octree/tiles must be rebuilt", GeometryWarningCode::HierarchyMustRematerialize),
        ("CSG/implicit solid needs tessellation", GeometryWarningCode::ImplicitRequiresTessellation),
        ("Strong local scale gradient warps hatches/dimensions", GeometryWarningCode::StrongLocalScaleGradient),
        ("Polygon self-intersection after non-linear map", GeometryWarningCode::TopologyRisk),
        ("UV/textures not warped with vertices", GeometryWarningCode::AttributesNotWarped),
        ("Grid coverage holes", GeometryWarningCode::OutOfBounds),
        ("Mixed IFC representations in one product", GeometryWarningCode::MixedRepresentation),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transform::{
        identity_spec, HeightOffsetOp, TransformCompositionMode, TransformStage,
        TRANSFORM_SPEC_SCHEMA_VERSION,
    };

    #[test]
    fn densify_circle_respects_min_samples() {
        let c = Circle3 {
            centre: WorldPoint::new(0.0, 0.0, 0.0),
            radius: 10.0,
            normal: WorldPoint::new(0.0, 0.0, 1.0),
        };
        let pts = densify_circle(c, &DensifyPolicy::default(), true).unwrap();
        assert!(pts.len() > 32);
        let close = pts.last().unwrap();
        let first = pts.first().unwrap();
        assert!((close.x - first.x).abs() < 1e-9);
    }

    #[test]
    fn fit_circle_recovers_synthetic() {
        let c = Circle3 {
            centre: WorldPoint::new(100.0, 200.0, 5.0),
            radius: 25.0,
            normal: WorldPoint::new(0.0, 0.0, 1.0),
        };
        let pts = densify_circle(c, &DensifyPolicy {
            max_chord_error_meters: 0.01,
            max_segment_meters: 2.0,
            min_circle_samples: 64,
            max_samples: 10_000,
        }, false).unwrap();
        let fit = fit_circle_xy(&pts).unwrap();
        assert!((fit.centre.x - 100.0).abs() < 1e-6);
        assert!((fit.centre.y - 200.0).abs() < 1e-6);
        assert!((fit.radius - 25.0).abs() < 1e-6);
    }

    #[test]
    fn ntv2_like_spec_forces_circle_approximation_warning() {
        let mut spec = identity_spec();
        spec.stages = vec![TransformStage::Proj(
            crate::transform::ProjCoordinateOp {
                source: crate::photolab_crs::CrsWithEpoch {
                    crs: crate::photolab_crs::CrsDefinition::Epsg(31468),
                    coordinate_epoch: None,
                },
                target: crate::photolab_crs::CrsWithEpoch {
                    crs: crate::photolab_crs::CrsDefinition::Epsg(25832),
                    coordinate_epoch: None,
                },
                proj_pipeline: Some("+proj=noop".into()),
                grids: vec![],
                selection_policy: Default::default(),
                expected_accuracy_mm: None,
                ballpark: false,
            },
        )];
        let class = classify_geometry(
            GeometryKind::Circle,
            &spec,
            &GeometryTransformPolicy::default(),
            Some("wall-arc"),
        );
        assert_eq!(class.strategy, GeometryStrategy::DensifyThenMapVertices);
        assert!(class
            .warnings
            .iter()
            .any(|w| w.code == GeometryWarningCode::ConnectivityRisk));
    }

    #[test]
    fn similarity_spec_allows_exact_circle_strategy() {
        let spec = TransformSpec {
            schema_version: TRANSFORM_SPEC_SCHEMA_VERSION,
            composition: TransformCompositionMode::Joint3D,
            separate_order: Default::default(),
            stages: vec![TransformStage::Empirical(EmpiricalOp::Similarity2D {
                model: Similarity2D {
                    tx: 1.0,
                    ty: 2.0,
                    rotation_radians: 0.1,
                    scale: 1.0,
                },
                z_offset: None,
            })],
            vertical_stages: vec![],
            domain: None,
            out_of_bounds: Default::default(),
            area_of_interest: None,
            label: None,
            geometry_policy: None,
        };
        let class = classify_geometry(
            GeometryKind::Circle,
            &spec,
            &GeometryTransformPolicy::default(),
            None,
        );
        assert_eq!(class.strategy, GeometryStrategy::MapCentreAndBestFitRadius);
        assert_eq!(class.support, TransformSupport::FullySupported);
    }

    #[test]
    fn edge_case_catalog_is_non_empty() {
        assert!(geometry_edge_case_catalog().len() >= 10);
    }

    #[test]
    fn height_offset_only_is_global_similarity_family() {
        let mut spec = identity_spec();
        spec.stages = vec![TransformStage::HeightOffset(HeightOffsetOp {
            offset_meters: 1.0,
        })];
        assert!(spec_is_global_similarity_or_affine(&spec));
    }
}
