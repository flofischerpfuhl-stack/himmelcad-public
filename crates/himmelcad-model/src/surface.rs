//! Neutral surface contracts shared by domain algorithms, commands, and consumers.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::hash::ObjectHash;
/// One stable source point admitted to a 2.5D surface draft.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfacePoint {
    /// Stable point identity within the source snapshot.
    pub point_id: String,
    /// Stable source entity identity.
    pub source_id: String,
    /// Project XY position.
    pub position: [f64; 2],
    /// Authoritative source height, when present.
    pub z: Option<f64>,
}

/// Stable evaluator identity recorded in every DGM recipe.
pub const SURFACE_ALGORITHM_ID: &str = "hcad.mesh.surface-cdt@1";
/// Stable regional cut/refill evaluator identity.
pub const SURFACE_SMOOTH_ALGORITHM_ID: &str = "hcad.mesh.smooth-region@1";
/// Stable certified terrain-decimation evaluator identity.
pub const SURFACE_DOWNSAMPLE_ALGORITHM_ID: &str = "hcad.mesh.simplify-terrain@1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceSourceRole {
    Points,
    Breakline,
    FormLine,
    OuterBoundary,
    Hole,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceLine {
    pub source_id: String,
    pub role: SurfaceSourceRole,
    pub vertices: Vec<SurfacePoint>,
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceRules {
    pub maximum_edge_length: f64,
    pub thin_cloud_spacing: f64,
    pub xy_tolerance: f64,
    pub z_tolerance: f64,
    pub exclude_outside_boundary: bool,
    pub breakline_exclusion_distance: Option<f64>,
    pub auto_boundary: bool,
    #[serde(default)]
    pub crop_polyline: Vec<[f64; 2]>,
}

impl Default for SurfaceRules {
    fn default() -> Self {
        Self {
            maximum_edge_length: 25.0,
            thin_cloud_spacing: 0.25,
            xy_tolerance: 0.001,
            z_tolerance: 0.001,
            exclude_outside_boundary: true,
            breakline_exclusion_distance: None,
            auto_boundary: true,
            crop_polyline: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceDraft {
    pub draft_id: String,
    pub name: String,
    pub points: Vec<SurfacePoint>,
    pub lines: Vec<SurfaceLine>,
    pub rules: SurfaceRules,
    #[serde(default)]
    pub excluded_source_ids: BTreeSet<String>,
    #[serde(default)]
    pub excluded_point_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceErrorCode {
    TooFewPoints,
    DuplicatePoints,
    ZeroLengthEdge,
    CrossingBreaklines,
    BreaklineVertexOffPointSet,
    VertexOutsideBoundary,
    BoundaryDefect,
    InventedZ,
    VerticalOrOverhanging,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceErrorSeverity {
    Error,
    Warning,
    Notice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceFixKind {
    Drop,
    Snap,
    Split,
    Exclude,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceCheckError {
    pub error_id: String,
    pub code: SurfaceErrorCode,
    pub severity: SurfaceErrorSeverity,
    pub message: String,
    pub source_ids: Vec<String>,
    pub location: Option<[f64; 3]>,
    pub fixes: Vec<SurfaceFixKind>,
    pub blocks_publish: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceCheckResult {
    pub errors: Vec<SurfaceCheckError>,
    pub fixable: usize,
    pub blocking: usize,
    pub source_points: usize,
    pub admitted_points: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceFixRequest {
    pub error_id: String,
    pub fix: SurfaceFixKind,
    /// Required authority source for conflicting-Z crossing splits.
    pub authority_source_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceFixResult {
    pub draft: SurfaceDraft,
    pub resolved_error_ids: Vec<String>,
    pub introduced_error_ids: Vec<String>,
    pub check: SurfaceCheckResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceMesh {
    pub positions: Vec<[f64; 3]>,
    pub indices: Vec<u32>,
    pub constrained_edges: Vec<[u32; 2]>,
    pub projected_area: f64,
    pub z_range: [f64; 2],
    pub source_residual: SurfaceResidual,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceResidual {
    pub count: usize,
    pub mean_absolute: f64,
    pub maximum_absolute: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceRegionSource {
    Fence,
    BoundaryPolyline,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceEditRegion {
    pub source: SurfaceRegionSource,
    /// Project-XY polygon. The closing vertex is implicit.
    pub polygon: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceSmoothFilter {
    Gaussian,
    Median,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceSmoothParameters {
    pub filter: SurfaceSmoothFilter,
    pub radius: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceDownsampleParameters {
    pub maximum_vertical_error: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceErrorCertificate {
    pub metric: String,
    pub sample_count: usize,
    pub maximum_vertical_error: f64,
    pub rms_vertical_error: f64,
    pub target_vertical_error: Option<f64>,
    pub certified: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceEditMetrics {
    pub vertices_before: usize,
    pub vertices_after: usize,
    pub triangles_before: usize,
    pub triangles_after: usize,
    pub affected_triangles: usize,
    pub region_area: f64,
    pub error: SurfaceErrorCertificate,
    pub outside_identity_hash: ObjectHash,
    pub result_hash: ObjectHash,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceEditResult {
    pub mesh: SurfaceMesh,
    pub metrics: SurfaceEditMetrics,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurfaceRegionSummary {
    pub vertices: usize,
    pub triangles: usize,
    pub protected_segments: usize,
    pub area: f64,
}

#[derive(Debug, Error, PartialEq)]
pub enum SurfaceEditError {
    #[error("surface edit region is invalid: {0}")]
    InvalidRegion(&'static str),
    #[error("surface edit parameters are invalid: {0}")]
    InvalidParameters(&'static str),
    #[error("surface edit source mesh is invalid: {0}")]
    InvalidMesh(&'static str),
    #[error("surface edit region contains no triangle")]
    EmptyRegion,
    #[error("surface edit triangulation failed: {0}")]
    Triangulation(String),
    #[error("surface edit was cancelled")]
    Cancelled,
}

#[derive(Debug, Error, PartialEq)]
pub enum SurfaceBuildError {
    #[error("surface rules are invalid: {0}")]
    InvalidRules(&'static str),
    #[error("surface check has {0} blocking error(s)")]
    CheckFailed(usize),
    #[error("surface triangulation failed: {0}")]
    Triangulation(String),
    #[error("surface creation was cancelled")]
    Cancelled,
    #[error("the requested draft fix is not applicable")]
    FixNotApplicable,
}
